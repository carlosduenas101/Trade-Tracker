// Playwright check for the "Use my own entry prices" feature in the Liq Ladder panel.
// Usage: BASE=http://127.0.0.1:8002 node tests/ladder_custom.pw.js
// Needs a running backend with a user tester / secret1 (use a throwaway DB).
const { chromium } = require('@playwright/test');
const assert = require('node:assert/strict');
const BASE = process.env.BASE || 'http://127.0.0.1:8002';

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 2300 } });
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));

  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.fill('#loginUsername', 'tester');
  await page.fill('#loginPassword', 'secret1');
  await page.click('#loginBtn');
  await page.waitForSelector('#loginScreen', { state: 'hidden', timeout: 20000 });
  await page.click('#fcModeLadderBtn');

  const num = s => parseFloat(s.replace(/[^0-9.]/g, ''));
  const read = async () => ({
    prices: await page.$$eval('.lc-entry-price', els => els.map(e => e.textContent)),
    badges: await page.$$eval('.lc-badge', els => els.map(e => e.textContent)),
    cards: await page.locator('.lc-entry').count(),
    summary: await page.locator('#lcSummary').innerText(),
  });
  const avgLiq = t => ({ avg: num(t.match(/Avg \(all filled\)\s*([\d,.]+)/)[1]), liq: num(t.match(/Liquidation\s*([\d,.]+)/)[1]) });

  // Default (checkbox OFF)
  await page.fill('#lcCapital', '5000');
  await page.fill('#lcE1', '100000');
  await page.click('#lcCalcBtn');
  const off = await read();
  assert.equal(off.cards, 6);
  assert.equal(off.badges.length, 0, 'no Custom/Model labels while OFF');
  assert.equal(await page.locator('#lcCustomBox').isHidden(), true);
  const offAL = avgLiq(off.summary);

  // Toggle ON: six inputs prefilled with the model prices, labels show
  await page.check('#lcCustom');
  assert.equal(await page.locator('#lcCustomGrid input').count(), 6);
  const pre = await page.$$eval('#lcCustomGrid input', els => els.map(e => e.value));
  assert.ok(pre.every(v => v !== ''), 'inputs prefilled: ' + pre);
  assert.equal(num(pre[1]), 98381);
  const on0 = await read();
  assert.deepEqual(on0.prices, off.prices, 'model prices unchanged when toggled ON');
  assert.equal(on0.badges.filter(b => b === 'Model').length, 5);

  // Edit E3
  await page.fill('#lcCP3', '80000');
  const on1 = await read();
  assert.ok(num(on1.prices[2]) === 80000, 'E3 card shows 80,000: ' + on1.prices[2]);
  assert.equal(on1.badges[2], 'Custom');
  const al1 = avgLiq(on1.summary);
  assert.notEqual(al1.avg, offAL.avg);
  assert.notEqual(al1.liq, offAL.liq);

  // Changing E1 keeps the edited E3 but moves unedited entries
  await page.fill('#lcCP1', '90000');
  const on2 = await read();
  assert.equal(await page.inputValue('#lcE1'), '90000');
  assert.equal(await page.inputValue('#lcCP3'), '80000');
  assert.ok(num(on2.prices[1]) < 90000 && num(on2.prices[1]) > 88000, 'E2 followed E1: ' + on2.prices[1]);
  await page.fill('#lcCP1', '100000');

  // Invalid price: above the previous entry
  await page.fill('#lcCP3', '99000');
  const msg = await page.locator('#lcCPErr3').innerText();
  assert.match(msg, /E3 must be below E2/);
  assert.equal(await page.evaluate(() => document.getElementById('lcResults').hidden), true);
  assert.equal(await page.locator('#lcResults').isHidden(), true, 'lcResults display: ' + await page.evaluate(() => getComputedStyle(document.getElementById('lcResults')).display));
  // Invalid price: at/below liquidation
  await page.fill('#lcCP3', '1000');
  assert.match(await page.locator('#lcCPErr3').innerText(), /above the liquidation price \(65943\.207\) after E2\./);
  await page.screenshot({ path: 'tests/ladder_custom_invalid.png', clip: { x: 950, y: 70, width: 330, height: 1000 } });

  // Valid again, then persistence across reload
  await page.fill('#lcCP3', '80000');
  assert.equal(await page.locator('#lcCPErr3').innerText(), '');
  assert.equal(await page.locator('#lcCP3').evaluate(e => e.classList.contains('invalid')), false, 'invalid class cleared');
  await page.screenshot({ path: 'tests/ladder_custom_on.png', clip: { x: 950, y: 70, width: 330, height: 2200 } });
  const before = await read();
  await page.reload({ waitUntil: 'networkidle' });
  await page.waitForSelector('#loginScreen', { state: 'hidden', timeout: 20000 }).catch(() => {});
  assert.equal(await page.isChecked('#lcCustom'), true, 'checkbox persisted');
  assert.equal(await page.inputValue('#lcCP3'), '80000', 'E3 persisted');
  await page.click('#lcCalcBtn');
  const after = await read();
  assert.deepEqual(after.prices, before.prices);
  assert.deepEqual(after.badges, before.badges);

  // Reset to model
  await page.click('#lcCustomReset');
  const reset = await read();
  assert.deepEqual(reset.prices, off.prices);
  assert.ok(reset.badges.slice(1).every(b => b === 'Model'));

  // Untick: back to the plain model, nothing labelled
  await page.uncheck('#lcCustom');
  await page.click('#lcCalcBtn');
  const back = await read();
  assert.deepEqual(back.prices, off.prices);
  assert.equal(back.badges.length, 0);

  assert.deepEqual(errors, [], 'no page errors');
  console.log('PLAYWRIGHT OK');
  await browser.close();
})().catch(e => { console.error("PLAYWRIGHT FAIL:", e.stack.split(String.fromCharCode(10)).filter(l => /ladder_custom|Error/.test(l)).slice(0, 4).join(String.fromCharCode(10))); process.exit(1); });
