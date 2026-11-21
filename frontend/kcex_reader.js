// ==UserScript==
// @name         Illustrade Position Hub: KCEX reader
// @match        https://www.kcex.com/futures/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==
/*
 * Reads the open positions and pending orders from the KCEX futures page and
 * sends them to the Position Hub (POST /hub/kcex/snapshot).
 *
 * Columns are found by header text, not by position, so a re-ordered table still
 * parses. Nothing is sent unless the parsed position count matches the page's
 * own "Open Position(n)" counter, so a half-loaded page never closes trades.
 *
 * Config (never stored in the page's own localStorage, so kcex.com scripts
 * cannot read the token):
 *   userscript : GM_setValue('url', ...), GM_setValue('token', ...), GM_setValue('device', ...)
 *   injected   : window.__hubKcex.start({ url, token, device })
 *   dry run    : window.__hubKcex.snapshot()   (returns the payload, sends nothing)
 */
(function () {
  'use strict';

  // ── One-time setup (Tampermonkey) ─────────────────────────────────────────
  // Fill these three, save, reload the exchange page once. They are copied into
  // Tampermonkey's private storage (the exchange's own scripts cannot read it).
  // device = the account name exactly as it appears in Mission Control, e.g. "KCEX Main".
  const SETUP = { url: '', token: '', device: '' };
  if (window.__hubKcex && window.__hubKcex.stop) window.__hubKcex.stop();

  const INTERVAL_MS = 10000;
  const num = s => {
    if (s == null) return null;
    const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };

  function tableByHeader(text) {
    return [...document.querySelectorAll('table')].find(t =>
      [...t.querySelectorAll('thead th')].some(th => th.innerText.trim() === text));
  }

  function rowsOf(table) {
    const heads = [...table.querySelectorAll('thead th')].map(th => th.innerText.trim());
    return [...table.querySelectorAll('tbody tr')]
      .filter(r => !r.classList.contains('ant-table-measure-row') && !r.classList.contains('ant-table-placeholder'))
      .map(r => {
        const cells = [...r.querySelectorAll('td')].map(c => c.innerText.replace(/\s+/g, ' ').trim());
        const o = {};
        heads.forEach((h, i) => { o[h] = cells[i]; });
        return o;
      })
      .filter(o => Object.values(o).some(v => v));
  }

  // "BTC/USDT LongIsolated10X" or "BTC/USDTLongIsolated10X" (the space comes and goes)
  const QUOTE = '(USDT|USDC|USD)';
  // "BTC" or a display name with the ticker in brackets: "GOLD(XAUT)" -> XAUT
  const NAME = '(?:[A-Z0-9]+\\s*\\(\\s*)?([A-Z0-9]+)\\s*\\)?';
  function parsePosition(r) {
    const m = (r['Perp.'] || '').match(new RegExp('^' + NAME + '\\s*\\/\\s*' + QUOTE + '\\s*(Long|Short)\\s*(Isolated|Cross)?\\s*(\\d+(?:\\.\\d+)?)\\s*[Xx]', 'i'));
    const avg = num(r['Avg Entry Price']);
    const notional = num(r['Open Interest']);          // shown in USDT (notional)
    if (!m || !avg || !notional) return null;
    const tpsl = (r['TP/SL'] || '').match(/Position\s*([\d,.]+|--)\s*\/\s*([\d,.]+|--)/i);
    return {
      symbol: m[1] + m[2], side: m[3].toLowerCase(),
      qty: +(notional / avg).toFixed(8),               // base-coin qty = notional / avg entry
      avg_entry: avg, leverage: parseFloat(m[5]),
      margin: num(r['Margin']),                        // $ of margin
      unrealized_pnl: num(r['Unrealized PNL']),        // first number = $, second = %
      liq_price: num(r['Est. Liq Price']),
      margin_mode: m[4] ? m[4].toLowerCase() : null,
      _tp: tpsl ? num(tpsl[1]) : null, _sl: tpsl ? num(tpsl[2]) : null,
    };
  }

  // TP/SL of a position become "exit" orders so the Hub shows them next to it.
  function exitOrders(p) {
    const side = p.side === 'long' ? 'sell' : 'buy';
    const out = [];
    if (p._tp) out.push({ symbol: p.symbol, side, kind: 'exit', price: p._tp, qty: p.qty, tp_price: p._tp, order_id: `${p.symbol}:${p.side}:tp` });
    if (p._sl) out.push({ symbol: p.symbol, side, kind: 'exit', price: p._sl, qty: p.qty, sl_price: p._sl, order_id: `${p.symbol}:${p.side}:sl` });
    return out;
  }

  // Pending orders. Only the TP/SL trigger layout has been verified on the live page
  // (those are already covered by exitOrders, so they are skipped here). Plain limit
  // entries are read from a "Price" column when present, otherwise reported in `warnings`.
  function parseOrder(r, warnings) {
    const m = (r['Perp.'] || '').match(new RegExp('^' + NAME + '\\s*\\/\\s*' + QUOTE, 'i'));
    if (!m) return null;
    const dir = (r['Direction'] || '').toLowerCase();
    const trig = r['Trigger Conditions'] || '';
    if (/^close/.test(dir) && /^(TP|SL)/i.test(trig)) return null;
    if (!/^open/.test(dir)) return null;
    const price = num(r['Price']) ?? num(r['Order Price']);
    const qty = num(r['Qty']);
    if (!price || !qty) { warnings.push('unrecognised open-order row: ' + JSON.stringify(r)); return null; }
    return { symbol: m[1] + m[2], side: dir.includes('long') ? 'buy' : 'sell', kind: 'entry', price, qty };
  }

  function snapshot() {
    const pt = tableByHeader('Avg Entry Price');
    if (!pt) return { error: 'positions table not found (open a KCEX futures page)' };
    const warnings = [];
    const positions = rowsOf(pt).map(parsePosition).filter(Boolean);
    const label = [...document.querySelectorAll('[class*=tab],[role=tab]')]
      .map(e => (e.innerText || '').trim()).find(t => /^Open Position\s*\(\d+\)/.test(t));
    const expected = label ? parseInt(label.match(/\((\d+)\)/)[1], 10) : 0;
    if (expected !== positions.length) {
      return { error: `page says ${expected} open positions but ${positions.length} parsed; nothing sent` };
    }
    let orders = positions.flatMap(exitOrders);
    const ot = tableByHeader('Trigger Conditions') || tableByHeader('Direction');
    if (ot) orders = orders.concat(rowsOf(ot).map(r => parseOrder(r, warnings)).filter(Boolean));
    positions.forEach(p => { delete p._tp; delete p._sl; });
    return { positions, orders, warnings };
  }

  let timer = null, cfg = null;
  const stored = k => (typeof GM_getValue === 'function' ? GM_getValue(k) : undefined);
  const config = () => cfg || { url: stored('url'), token: stored('token'), device: stored('device') };

  async function pushOnce() {
    const s = snapshot();
    if (s.error) return (api.last = { ok: false, at: Date.now(), error: s.error });
    const c = config();
    if (!c.url || !c.token || !c.device) return (api.last = { ok: false, at: Date.now(), error: 'url, token and device are not set' });
    try {
      const r = await fetch(c.url.replace(/\/$/, '') + '/hub/kcex/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Token': c.token },
        body: JSON.stringify({ device: c.device, positions: s.positions, orders: s.orders }),
      });
      return (api.last = { ok: r.ok, at: Date.now(), status: r.status, positions: s.positions.length, orders: s.orders.length, warnings: s.warnings });
    } catch (e) {
      return (api.last = { ok: false, at: Date.now(), error: String(e) });
    }
  }

  // Status pill (bottom left of the exchange page) so a silent failure is visible:
  // green = sent, red = the exact reason nothing was sent. Never shows the token.
  function badge(last) {
    try {
      let el = document.getElementById('illustrade-hub-badge');
      if (!el) {
        el = document.createElement('div');
        el.id = 'illustrade-hub-badge';
        el.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:2147483647;font:11px/1.4 system-ui,sans-serif;' +
          'padding:3px 9px;border-radius:10px;color:#000;pointer-events:none;opacity:.92;max-width:60vw';
        document.documentElement.appendChild(el);
      }
      let msg;
      if (last.error) msg = last.error;
      else if (last.status === 403) msg = 'server rejected the token (HTTP 403): check token, and HUB_INGEST_TOKEN / HUB_INGEST_USER_ID on the server';
      else if (!last.ok) msg = 'server answered HTTP ' + last.status;
      else msg = 'sent ' + last.positions + ' position(s)';
      const ok = !last.error && last.ok;
      el.style.background = ok ? '#39ff14' : '#ff5252';
      el.textContent = 'Illustrade KCEX reader (' + ((config().device) || 'no account name') + '): ' + msg +
        ' · ' + new Date(last.at || Date.now()).toLocaleTimeString();
    } catch (e) { /* the page changed under us; next push retries */ }
  }

  async function push() {
    const r = await pushOnce();
    badge(r);
    console.info('[Illustrade KCEX reader]', r);
    return r;
  }

  const api = {
    last: null,
    snapshot,
    push,
    start(c) { if (c) cfg = c; this.stop(); push(); timer = setInterval(push, INTERVAL_MS); return 'running every ' + INTERVAL_MS / 1000 + ' s'; },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
  window.__hubKcex = api;

  if (typeof GM_setValue === 'function') {
    for (const k of ['url', 'token', 'device']) if (SETUP[k]) GM_setValue(k, SETUP[k]);
  }
  const c0 = config();
  if (typeof GM_getValue === 'function' && c0.url && c0.token && c0.device) api.start();
  else if (typeof GM_getValue === 'function') {
    const missing = ['url', 'token', 'device'].filter(k => !c0[k]).join(', ');
    setTimeout(() => badge({ ok: false, at: Date.now(), error: 'not configured: fill ' + missing + ' in SETUP, save, reload' }), 3000);
  }
})();
