// Playwright: the fund pool is invisible to every account except the owner.
// Starts its own backend on a TEMPORARY sqlite DB (never the real one), seeds a pool
// as the owner through the API, then logs in through the UI as owner and as a second user.
// Run: node tests/pool_access.pw.js   (from the repo root, uses venv/Scripts/python)
const { chromium } = require('@playwright/test');
const { spawn } = require('node:child_process');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8013;
const BASE = `http://127.0.0.1:${PORT}`;
const ADMIN = 'pw-pool-admin';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'pool-pw-'));
const dbUrl = 'sqlite:///' + path.join(tmp, 'pw.db').replace(/\\/g, '/');
assert.ok(dbUrl.startsWith('sqlite:///'), 'refusing to run against a non-sqlite database');

async function api(method, p, body, token, extra = {}) {
  const res = await fetch(BASE + p, {
    method, body: body ? JSON.stringify(body) : undefined,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}), ...extra },
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

(async () => {
  const server = spawn(path.join(ROOT, 'venv/Scripts/python.exe'),
    ['-m', 'uvicorn', 'main:app', '--host', '127.0.0.1', '--port', String(PORT)],
    { cwd: path.join(ROOT, 'backend'), env: { ...process.env, DATABASE_URL: dbUrl, ADMIN_SECRET: ADMIN, POOL_OWNER_USER_ID: '1' }, stdio: 'ignore' });
  let browser;
  try {
    for (let i = 0; i < 80; i++) { try { await fetch(BASE + '/auth/me'); break; } catch { await new Promise(r => setTimeout(r, 250)); } }

    for (const u of ['owner', 'second']) {
      const r = await api('POST', '/auth/users', { username: u, email: u + '@example.test', password: 'secret1' }, null, { 'X-Admin-Secret': ADMIN });
      assert.equal(r.status, 201);
    }
    const tok = (await api('POST', '/auth/login', { username: 'owner', password: 'secret1' })).json.access_token;
    const inv = (await api('POST', '/fund-pool/investors', { name: 'Zelda Secretinvestor' }, tok)).json;
    const start = new Date(Date.now() - 100 * 864e5).toISOString().slice(0, 10);
    assert.equal((await api('POST', '/fund-pool/contributions', { investor_id: inv.id, amount: 7777, date_contributed: start, payout_type: 'monthly' }, tok)).status, 201);

    browser = await chromium.launch();
    async function session(user) {
      const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
      const poolResponses = [];
      const errors = [];
      page.on('pageerror', e => errors.push(e.message));
      page.on('response', async r => {
        if (r.url().includes('/fund-pool/')) poolResponses.push({ status: r.status(), body: await r.text().catch(() => '') });
      });
      await page.goto(BASE + '/', { waitUntil: 'networkidle' });
      await page.fill('#loginUsername', user);
      await page.fill('#loginPassword', 'secret1');
      await page.click('#loginBtn');
      await page.waitForSelector('#loginScreen', { state: 'hidden', timeout: 20000 });
      await page.waitForTimeout(2000);
      return { page, poolResponses, errors };
    }

    // Positive control: the owner sees the pool
    const o = await session('owner');
    assert.equal(await o.page.locator('.pool-section').isVisible(), true, 'owner sees the pool section');
    assert.ok((await o.page.locator('body').innerText()).includes('Zelda Secretinvestor'), 'owner sees pool data');
    assert.ok(o.poolResponses.length > 0 && o.poolResponses.every(r => r.status === 200), 'owner pool calls are 200');
    await o.page.close();

    // Second user: nothing at all
    const s = await session('second');
    assert.equal(await s.page.locator('.pool-section').isVisible(), false, 'pool section hidden');
    const text = (await s.page.locator('body').innerText());
    for (const needle of ['Zelda', 'Secretinvestor', '7,777', '7777', 'Investor Balance', 'Fund pool']) {
      assert.ok(!text.includes(needle), 'page must not contain ' + needle);
    }
    const html = await s.page.content();
    assert.ok(!html.includes('Zelda') && !html.includes('7777'), 'DOM holds no pool data');
    assert.ok(s.poolResponses.length > 0 && s.poolResponses.every(r => r.status === 403), 'every pool call is 403');
    assert.ok(s.poolResponses.every(r => !/Zelda|7777|7777\.0/.test(r.body)), 'no pool data in any pool response body');
    assert.equal(await s.page.locator('#poolError').isVisible(), false, 'no pool error shown');
    assert.deepEqual(s.errors, [], 'no page errors');
    await s.page.screenshot({ path: path.join(ROOT, 'tests/pool_second_user.png'), fullPage: false });
    console.log('PLAYWRIGHT POOL ACCESS OK (second user: ' + s.poolResponses.length + ' pool calls, all 403)');
  } catch (e) {
    console.error('PLAYWRIGHT FAIL:', e.message);
    process.exitCode = 1;
  } finally {
    if (browser) await browser.close();
    server.kill();
  }
})();
