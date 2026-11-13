// ==UserScript==
// @name         Illustrade Position Hub: LBank reader
// @match        https://www.lbank.com/futures/*
// @grant        GM_getValue
// @grant        GM_setValue
// @run-at       document-idle
// ==/UserScript==
/*
 * Reads open positions from the LBank futures page and sends them to the
 * Position Hub (POST /hub/kcex/snapshot with exchange "lbank"). LBank publishes
 * no private futures API, so the page is the data source.
 *
 * The positions table lists every pair at once (verified with 3 pairs open).
 * Nothing is sent unless the parsed count matches the page's own "Positions (n)"
 * counter, so a half-loaded page never closes trades.
 *
 * TP/SL: LBank puts the price in either the "TP/SL" or the "Position TP/SL"
 * column depending on how it was set, so both are read and each price is
 * classified against the entry (above entry = TP for a long, below = SL).
 *
 * Pending orders: every order seen so far is a TP/SL trigger, which the position
 * row already covers. A plain limit entry has not been seen yet, so such rows are
 * reported in `warnings` instead of being parsed from an unverified layout.
 *
 * Config (kept out of the page's localStorage):
 *   userscript : GM_setValue('url', ...), GM_setValue('token', ...), GM_setValue('device', ...)
 *   injected   : window.__hubLbank.start({ url, token, device })
 *   dry run    : window.__hubLbank.snapshot()   (returns the payload, sends nothing)
 */
(function () {
  'use strict';
  if (window.__hubLbank && window.__hubLbank.stop) window.__hubLbank.stop();

  const INTERVAL_MS = 10000;
  const QUOTE = '(USDT|USDC|USD)';
  const num = s => {
    if (s == null) return null;
    const m = String(s).replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
    return m ? parseFloat(m[0]) : null;
  };

  function tableByHeader(text) {
    return [...document.querySelectorAll('table')].find(t =>
      [...t.querySelectorAll('thead th')].some(th => th.innerText.trim() === text));
  }

  const bodyRows = table => [...table.querySelectorAll('tbody tr')]
    .filter(r => !/measure|placeholder/.test(r.className));

  function rowsOf(table) {
    const heads = [...table.querySelectorAll('thead th')].map(th => th.innerText.replace(/\s+/g, ' ').trim());
    return bodyRows(table).map(r => {
      const cells = [...r.querySelectorAll('td')].map(c => c.innerText.replace(/\s+/g, ' ').trim());
      const o = {};
      heads.forEach((h, i) => { o[h] = cells[i]; });
      return o;
    }).filter(o => Object.values(o).some(v => v));
  }

  // "XRPUSDT Perp Long Cross 3x"
  function parsePosition(r) {
    const m = (r['Pairs'] || '').match(new RegExp('^([A-Z0-9]+?)' + QUOTE + '\\s*Perp\\s*(Long|Short)\\s*(Cross|Isolated)\\s*(\\d+(?:\\.\\d+)?)\\s*[Xx]', 'i'));
    const qty = num(r['Positions']);                    // "24.7 XRP" is already base-coin qty
    const avg = num(r['Entry Price']);
    if (!m || !qty || !avg) return null;
    const side = m[3].toLowerCase();
    let tp = null, sl = null;
    [r['TP/SL'], r['Position TP/SL']].forEach(c => {
      (String(c || '').match(/[\d,]+(?:\.\d+)?/g) || []).forEach(x => {
        const v = parseFloat(x.replace(/,/g, ''));
        if ((side === 'long') === (v > avg)) { if (tp == null) tp = v; } else if (sl == null) sl = v;
      });
    });
    return {
      symbol: m[1] + m[2], side, qty, avg_entry: avg, leverage: parseFloat(m[5]),
      margin: num(r['Margin']),                         // $ of margin ("8.9701 USDT")
      unrealized_pnl: num(r['Unrealized PnL L'] ?? r['Unrealized PnL']),   // first number = $, then (%)
      liq_price: num(r['Est. Liq. Price']),             // "--" (cross) becomes null
      margin_mode: m[4].toLowerCase(), _tp: tp, _sl: sl,
    };
  }

  function exitOrders(p) {
    const side = p.side === 'long' ? 'sell' : 'buy';
    const out = [];
    if (p._tp) out.push({ symbol: p.symbol, side, kind: 'exit', price: p._tp, qty: p.qty, tp_price: p._tp, order_id: `${p.symbol}:${p.side}:tp` });
    if (p._sl) out.push({ symbol: p.symbol, side, kind: 'exit', price: p._sl, qty: p.qty, sl_price: p._sl, order_id: `${p.symbol}:${p.side}:sl` });
    return out;
  }

  function snapshot() {
    const pt = tableByHeader('Entry Price');
    if (!pt) return { error: 'positions table not found (open an LBank futures page)' };
    const positions = rowsOf(pt).map(parsePosition).filter(Boolean);
    const label = [...document.querySelectorAll('[class*=tab],[role=tab]')]
      .map(e => (e.innerText || '').trim()).find(t => /^Positions\s*\(\d+\)/.test(t));
    const expected = label ? parseInt(label.match(/\((\d+)\)/)[1], 10) : 0;
    if (expected !== positions.length) {
      return { error: `page says ${expected} open positions but ${positions.length} parsed; nothing sent` };
    }
    const warnings = [];
    const ot = tableByHeader('Trigger Price');
    if (ot) {
      bodyRows(ot).forEach(r => {
        const text = [...r.querySelectorAll('td')].map(c => c.innerText.replace(/\s+/g, ' ').trim()).join(' | ');
        if (/\bOpen (Long|Short)\b/i.test(text)) warnings.push('open-order row not parsed (layout unverified): ' + text);
      });
    }
    const orders = positions.flatMap(exitOrders);
    positions.forEach(p => { delete p._tp; delete p._sl; });
    return { positions, orders, warnings };
  }

  let timer = null, cfg = null;
  const stored = k => (typeof GM_getValue === 'function' ? GM_getValue(k) : undefined);
  const config = () => cfg || { url: stored('url'), token: stored('token'), device: stored('device') };

  async function push() {
    const s = snapshot();
    if (s.error) return (api.last = { ok: false, at: Date.now(), error: s.error });
    const c = config();
    if (!c.url || !c.token || !c.device) return (api.last = { ok: false, at: Date.now(), error: 'url, token and device are not set' });
    try {
      const r = await fetch(c.url.replace(/\/$/, '') + '/hub/kcex/snapshot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Token': c.token },
        body: JSON.stringify({ exchange: 'lbank', device: c.device, positions: s.positions, orders: s.orders }),
      });
      return (api.last = { ok: r.ok, at: Date.now(), status: r.status, positions: s.positions.length, orders: s.orders.length, warnings: s.warnings });
    } catch (e) {
      return (api.last = { ok: false, at: Date.now(), error: String(e) });
    }
  }

  const api = {
    last: null,
    snapshot,
    push,
    start(c) { if (c) cfg = c; this.stop(); push(); timer = setInterval(push, INTERVAL_MS); return 'running every ' + INTERVAL_MS / 1000 + ' s'; },
    stop() { if (timer) clearInterval(timer); timer = null; },
  };
  window.__hubLbank = api;

  const c0 = config();
  if (typeof GM_getValue === 'function' && c0.url && c0.token && c0.device) api.start();
})();
