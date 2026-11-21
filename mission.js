/**
 * Mission Control: a screen that slides down from the top notch and shows every
 * open trade on every account (GET /mission/summary), with totals and risk.
 *
 * Owner only: the notch stays hidden unless /mission/summary answers for this
 * login. While the screen is open it refreshes every 10 s; while closed it
 * refreshes every 60 s so the notch badge (open trades, at-risk count) stays current.
 */
(function () {
  'use strict';
  const $ = id => document.getElementById(id);
  const OPEN_MS = 10000;
  const CLOSED_MS = 60000;
  const EXCHANGES = [['kcex', 'KCEX'], ['bitunix', 'Bitunix'], ['lbank', 'LBank']];
  const EX_LABEL = Object.fromEntries(EXCHANGES);

  let data = null;
  let timer = null;
  let isOpen = false;
  let allowed = false;
  let draft = null;     // accounts being edited
  let manualEdit = null; // trade being entered by hand: {id?, account, exchange, ...}
  const closeArmed = new Set();   // manual trades whose Close was clicked once

  // ── Formatting ─────────────────────────────────────────────
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fin = v => typeof v === 'number' && Number.isFinite(v);
  const money = v => Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const usd = v => (fin(v) ? (v < 0 ? '-$' : '$') + money(v) : '—');
  const pnl = v => (fin(v) ? (v > 0 ? '+$' : v < 0 ? '-$' : '$') + money(v) : '—');
  const pct = (v, d = 1) => (fin(v) ? v.toFixed(d) + '%' : '—');
  const spct = (v, d = 1) => (fin(v) ? (v > 0 ? '+' : '') + v.toFixed(d) + '%' : '—');
  const tone = v => (fin(v) ? (v > 0 ? 'mc-up' : v < 0 ? 'mc-down' : '') : '');
  function price(v) {
    if (!fin(v)) return '—';
    const a = Math.abs(v);
    const d = a >= 1000 ? 1 : a >= 100 ? 2 : a >= 1 ? 4 : 6;
    return v.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function ago(s) {
    if (!fin(s)) return 'never';
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    return Math.floor(s / 86400) + 'd ago';
  }

  // ── Data ───────────────────────────────────────────────────
  async function load() {
    try {
      data = await apiFetch('/mission/summary');
      allowed = true;
      $('mcNotch').hidden = false;
      note('');
    } catch (e) {
      if (e.status === 403 || e.status === 404) {   // not the owner account: no Mission Control
        allowed = false;
        data = null;
        close();
        $('mcNotch').hidden = true;
        stop();
        return;
      }
      note('Could not refresh: ' + e.message, true);
    }
    renderBadge();
    if (isOpen) render();
  }

  function schedule() {
    stop();
    timer = setInterval(load, isOpen ? OPEN_MS : CLOSED_MS);
  }
  function stop() { clearInterval(timer); timer = null; }

  function note(t, bad) {
    const el = $('mcMsg');
    el.textContent = t || '';
    el.className = 'mc-msg' + (bad ? ' mc-down' : '');
  }

  // ── Open / close ───────────────────────────────────────────
  function open() {
    if (!allowed) return;
    isOpen = true;
    $('mcScreen').classList.add('mc-open');
    $('mcScreen').setAttribute('aria-hidden', 'false');
    $('mcBackdrop').classList.add('active');
    $('mcNotch').classList.add('mc-notch-away');
    document.body.style.overflow = 'hidden';
    render();
    load();
    schedule();
  }
  function close() {
    if (!isOpen) return;
    isOpen = false;
    $('mcScreen').classList.remove('mc-open');
    $('mcScreen').setAttribute('aria-hidden', 'true');
    $('mcBackdrop').classList.remove('active');
    $('mcNotch').classList.remove('mc-notch-away');
    document.body.style.overflow = '';
    if (allowed) schedule();
  }

  // ── Render ─────────────────────────────────────────────────
  function renderBadge() {
    const b = $('mcBadge');
    if (!data) { b.hidden = true; return; }
    const t = data.totals;
    b.hidden = false;
    b.textContent = t.open;
    b.className = 'mc-notch-badge' + (t.at_risk ? ' mc-badge-risk' : '');
    b.title = `${t.open} open trade(s)` + (t.at_risk ? `, ${t.at_risk} near liquidation` : '');
  }

  function render() {
    if (!data) { $('mcBody').innerHTML = '<div class="mc-empty">Loading…</div>'; return; }
    const d = new Date(data.server_time * 1000);
    $('mcUpdated').textContent = 'Updated ' + d.toLocaleTimeString();
    $('mcBody').innerHTML = kpis(data.totals) + accounts(data.accounts) + trades(data.positions) + assets(data.assets);
  }

  function kpis(t) {
    const c = t.closest;
    const closest = c
      ? `<div class="mc-kpi-val mc-risk-${c.risk}">${pct(c.liq_distance_pct)}</div>
         <div class="mc-kpi-sub">${esc(c.symbol)} ${esc(c.side)} · ${esc(c.account)}</div>`
      : '<div class="mc-kpi-val">—</div><div class="mc-kpi-sub">no liq price yet</div>';
    return `<div class="mc-kpis">
      <div class="mc-kpi"><div class="mc-kpi-label">Open trades</div>
        <div class="mc-kpi-val">${t.open}</div>
        <div class="mc-kpi-sub">${t.longs} long · ${t.shorts} short${t.at_risk ? ` · <span class="mc-down">${t.at_risk} at risk</span>` : ''}</div></div>
      <div class="mc-kpi"><div class="mc-kpi-label">Margin committed</div>
        <div class="mc-kpi-val">${usd(t.margin)}</div><div class="mc-kpi-sub">across all accounts</div></div>
      <div class="mc-kpi"><div class="mc-kpi-label">Unrealized P&amp;L</div>
        <div class="mc-kpi-val ${tone(t.upnl)}">${pnl(t.upnl)}</div>
        <div class="mc-kpi-sub">ROE on margin ${spct(t.roe_pct)}</div></div>
      <div class="mc-kpi"><div class="mc-kpi-label">Notional exposure</div>
        <div class="mc-kpi-val">${usd(t.notional)}</div><div class="mc-kpi-sub">margin × leverage, at est. mark</div></div>
      <div class="mc-kpi"><div class="mc-kpi-label">Closest to liquidation</div>${closest}</div>
    </div>`;
  }

  const FEED_TEXT = { live: 'Live', stale: 'Stale', error: 'Error', no_feed: 'No feed', manual: 'Manual' };
  function accounts(list) {
    const cards = list.map(a => {
      const f = a.feed;
      const when = (f.status === 'no_feed' || f.status === 'manual') ? '' : ' · ' + ago(f.age_seconds);
      let foot = `${a.open} open · ${usd(a.margin)} margin · <span class="${tone(a.upnl)}">${pnl(a.upnl)}</span>`;
      if (f.status === 'no_feed' && !a.open) foot = `Not connected yet (${f.via === 'api' ? 'needs an API key' : 'needs the page reader'}), or add trades by hand`;
      if (f.status === 'error' && f.error) foot = esc(f.error);
      return `<div class="mc-acc mc-acc-${f.status}">
        <div class="mc-acc-head">
          <span class="mc-acc-name">${esc(a.name)}</span>
          <span class="mc-chip">${esc(EX_LABEL[a.exchange] || a.exchange)}</span>
          ${a.unlisted ? '<span class="mc-chip mc-chip-warn" title="Seen in the data but not in your account list">unlisted</span>' : ''}
          <span class="mc-pill mc-pill-${f.status}">${FEED_TEXT[f.status]}${f.paused ? ' (paused)' : ''}${when}</span>
        </div>
        <div class="mc-acc-foot">${foot}</div>
        ${(f.status === 'no_feed' || f.status === 'manual') ? `<button class="btn btn-ghost btn-sm mc-acc-add" data-add-acc="${esc(a.name)}" data-add-ex="${esc(a.exchange)}">+ Add trade by hand</button>` : ''}
      </div>`;
    }).join('');
    return `<h3 class="mc-h">Accounts</h3><div class="mc-accounts">${cards}</div>`;
  }

  function ladderCell(p) {
    if (p.ladder) return `<span class="mc-ladder">E${p.ladder.filled}/${p.ladder.total}</span><div class="mc-sub">${esc(p.ladder.preset)}</div>`;
    const n = p.pending_entries.length;
    return n ? `${n} pending` : '<span class="mc-mut">—</span>';
  }

  function liqCell(p) {
    if (!fin(p.liq_distance_pct)) return '<span class="mc-mut">—</span>';
    const w = Math.max(3, Math.min(100, p.liq_distance_pct / 50 * 100));   // full bar = 50% away
    return `<div class="mc-bar"><span class="mc-bar-fill mc-risk-bg-${p.risk}" style="width:${w.toFixed(0)}%"></span></div>
            <div class="mc-sub mc-risk-${p.risk}">${pct(p.liq_distance_pct)} away${p.liq_estimated ? ' · est.' : ''}</div>`;
  }

  function trades(list) {
    if (!list.length) {
      return `<h3 class="mc-h">Open trades</h3><div class="mc-empty">No open trades on any connected account.
        Accounts marked "No feed" are not reporting yet, so they may still hold trades.</div>`;
    }
    const order = { danger: 0, warn: 1, ok: 2, unknown: 3 };
    const rows = [...list].sort((a, b) => (order[a.risk] - order[b.risk])
      || ((a.liq_distance_pct ?? 1e9) - (b.liq_distance_pct ?? 1e9))).map(p => {
      const nx = p.next_entry;
      return `<tr class="mc-row-${p.risk}">
        <td><b>${esc(p.account)}</b><div class="mc-sub">${esc(EX_LABEL[p.exchange] || p.exchange)}</div></td>
        <td><b>${esc(p.symbol)}</b></td>
        <td><span class="mc-side mc-side-${p.side}">${esc(p.side)}</span><div class="mc-sub">${fin(p.leverage) ? p.leverage + 'x' : ''} ${esc(p.margin_mode || '')}</div></td>
        <td class="num">${usd(p.margin)}</td>
        <td class="num">${p.price_missing ? '<span class="mc-mut" title="No live price for this symbol right now">no price</span>' : `<span class="${tone(p.unrealized_pnl)}">${pnl(p.unrealized_pnl)}</span><div class="mc-sub ${tone(p.roe_pct)}">${spct(p.roe_pct)}</div>`}</td>
        <td class="num">${price(p.avg_entry)}<div class="mc-sub">mark ≈ ${price(p.mark_est)}</div></td>
        <td class="num">${price(p.liq_price)}${p.liq_estimated ? '<div class="mc-sub">est.</div>' : ''}</td>
        <td class="mc-liq">${liqCell(p)}</td>
        <td>${ladderCell(p)}</td>
        <td class="num">${nx ? price(nx.price) + `<div class="mc-sub">${pct(nx.distance_pct, 2)} away</div>` : '<span class="mc-mut">—</span>'}</td>
        <td class="num">${price(p.tp_price)}<div class="mc-sub">SL ${price(p.sl_price)}</div></td>
        <td>${p.manual ? `<span class="mc-pill mc-pill-manual">manual</span><div class="mc-row-acts"><button class="btn btn-ghost btn-sm" data-medit="${p.id}">Edit</button><button class="btn btn-ghost btn-sm mc-danger" data-mclose="${p.id}">${closeArmed.has(p.id) ? 'Confirm close' : 'Close'}</button></div>` : (p.stale ? '<span class="mc-pill mc-pill-stale">stale</span>' : '<span class="mc-mut">' + ago(p.age_seconds) + '</span>')}</td>
      </tr>`;
    }).join('');
    return `<h3 class="mc-h">Open trades <span class="mc-mut">· sorted by risk</span></h3>
      <div class="mc-wrap"><table class="mc-table"><thead><tr>
        <th>Account</th><th>Symbol</th><th>Side</th><th class="num">Margin</th><th class="num">uPnL / ROE</th>
        <th class="num">Avg / mark</th><th class="num">Liq</th><th>To liq</th><th>Ladder</th>
        <th class="num">Next entry</th><th class="num">TP / SL</th><th>Data</th>
      </tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function assets(list) {
    if (!list.length) return '';
    const rows = list.map(a => `<tr>
      <td><b>${esc(a.asset)}</b></td><td class="num">${a.open}</td>
      <td>${a.longs}L / ${a.shorts}S</td><td>${a.accounts.map(esc).join(', ')}</td>
      <td class="num">${usd(a.margin)}</td>
      <td class="num"><span class="${tone(a.upnl)}">${pnl(a.upnl)}</span></td>
      <td class="num">${usd(a.notional)}</td>
      <td class="num">${a.closest ? `<span class="mc-risk-${a.closest.risk}">${pct(a.closest.liq_distance_pct)}</span>` : '—'}</td>
    </tr>`).join('');
    return `<h3 class="mc-h">By asset</h3><div class="mc-wrap"><table class="mc-table"><thead><tr>
      <th>Asset</th><th class="num">Trades</th><th>Long / short</th><th>Accounts</th>
      <th class="num">Margin</th><th class="num">uPnL</th><th class="num">Notional</th><th class="num">Closest liq</th>
    </tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ── Accounts editor ────────────────────────────────────────
  async function openEditor() {
    const ed = $('mcEditor');
    if (!ed.hidden) { ed.hidden = true; return; }
    try {
      const r = await apiFetch('/mission/accounts');
      draft = r.accounts.map(a => ({ ...a }));
    } catch (e) { note('Could not load accounts: ' + e.message, true); return; }
    ed.hidden = false;
    renderEditor();
  }

  function renderEditor() {
    const opts = sel => EXCHANGES.map(([v, l]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${l}</option>`).join('');
    $('mcEditor').innerHTML = `
      <div class="mc-sub">Each name must match the device name set in that account's page reader or API key.</div>
      ${draft.map((a, i) => `<div class="mc-ed-row">
        <input class="fib-input" data-i="${i}" data-f="name" value="${esc(a.name)}" maxlength="40" placeholder="Account name">
        <select class="fib-input" data-i="${i}" data-f="exchange">${opts(a.exchange)}</select>
        <button class="btn btn-ghost btn-sm" data-del="${i}" aria-label="Remove">✕</button>
      </div>`).join('')}
      <div class="mc-ed-actions">
        <button class="btn btn-ghost btn-sm" id="mcEdAdd" ${draft.length >= 12 ? 'disabled' : ''}>+ Add account</button>
        <span style="flex:1"></span>
        <button class="btn btn-ghost btn-sm" id="mcEdCancel">Cancel</button>
        <button class="btn btn-primary btn-sm" id="mcEdSave">Save accounts</button>
      </div>`;
  }

  function onEditorInput(e) {
    const t = e.target;
    if (t.dataset.i === undefined) return;
    draft[+t.dataset.i][t.dataset.f] = t.value;
  }
  async function onEditorClick(e) {
    const t = e.target;
    if (t.dataset.del !== undefined) { draft.splice(+t.dataset.del, 1); renderEditor(); return; }
    if (t.id === 'mcEdAdd') { draft.push({ name: '', exchange: 'kcex' }); renderEditor(); return; }
    if (t.id === 'mcEdCancel') { $('mcEditor').hidden = true; return; }
    if (t.id === 'mcEdSave') {
      const clean = draft.map(a => ({ name: a.name.trim(), exchange: a.exchange })).filter(a => a.name);
      try {
        await apiFetch('/mission/accounts', { method: 'PUT', body: JSON.stringify({ accounts: clean }) });
        $('mcEditor').hidden = true;
        note('Accounts saved.');
        load();
      } catch (err) { note('Could not save: ' + err.message, true); }
    }
  }

  async function syncNow() {
    const b = $('mcSync');
    b.disabled = true;
    try { await apiFetch('/hub/sync', { method: 'POST' }); await load(); }
    catch (e) { note('Sync failed: ' + e.message, true); }
    finally { b.disabled = false; }
  }

  // ── Trades entered by hand ─────────────────────────────────
  function openManual(seed) {
    const accs = (data && data.accounts) || [];
    const first = accs.find(a => a.feed.status === 'no_feed' || a.feed.status === 'manual') || accs[0] || { name: '', exchange: 'kcex' };
    manualEdit = Object.assign({ account: first.name, exchange: first.exchange, symbol: '', side: 'long',
      leverage: '', avg_entry: '', margin: '', liq_price: '', tp_price: '', sl_price: '' }, seed || {});
    $('mcEditor').hidden = true;
    $('mcManual').hidden = false;
    renderManual();
  }

  function renderManual() {
    const m = manualEdit;
    const accs = (data && data.accounts) || [];
    const accOpts = accs.map(a => `<option value="${esc(a.name)}" data-ex="${esc(a.exchange)}"${a.name === m.account ? ' selected' : ''}>${esc(a.name)} (${esc(EX_LABEL[a.exchange] || a.exchange)})</option>`).join('');
    const f = (k, label, ph, req) => `<label class="mc-mf"><span>${label}${req ? '' : ' <i>(optional)</i>'}</span>
      <input class="fib-input" data-mf="${k}" type="${k === 'symbol' ? 'text' : 'number'}" step="any" min="0" placeholder="${ph}" value="${esc(m[k] ?? '')}"></label>`;
    $('mcManual').innerHTML = `
      <div class="mc-mf-title">${m.id ? 'Edit trade' : 'Add trade by hand'} <span class="mc-sub">Live price keeps its P&amp;L and distance to liquidation current. Update it here when you add an entry.</span></div>
      <div class="mc-mf-grid">
        <label class="mc-mf"><span>Account</span><select class="fib-input" data-mf="account">${accOpts}</select></label>
        ${f('symbol', 'Symbol', 'BTCUSDT', true)}
        <label class="mc-mf"><span>Side</span><select class="fib-input" data-mf="side">
          <option value="long"${m.side === 'long' ? ' selected' : ''}>Long</option><option value="short"${m.side === 'short' ? ' selected' : ''}>Short</option></select></label>
        ${f('leverage', 'Leverage (x)', '5', true)}
        ${f('avg_entry', 'Avg entry price', '57,500', true)}
        ${f('margin', 'Margin ($)', '30', true)}
        ${f('liq_price', 'Liq price', 'blank = estimate', false)}
        ${f('tp_price', 'TP price', '', false)}
        ${f('sl_price', 'SL price', '', false)}
      </div>
      <div class="mc-ed-actions">
        <span class="mc-sub" id="mcMfErr"></span><span style="flex:1"></span>
        <button class="btn btn-ghost btn-sm" id="mcMfCancel">Cancel</button>
        <button class="btn btn-primary btn-sm" id="mcMfSave">${m.id ? 'Save changes' : 'Add trade'}</button>
      </div>`;
  }

  function onManualInput(e) {
    const t = e.target;
    if (!t.dataset.mf) return;
    manualEdit[t.dataset.mf] = t.value;
    if (t.dataset.mf === 'account') manualEdit.exchange = t.selectedOptions[0].dataset.ex;
  }

  async function onManualClick(e) {
    const t = e.target;
    if (t.id === 'mcMfCancel') { $('mcManual').hidden = true; manualEdit = null; return; }
    if (t.id !== 'mcMfSave') return;
    const m = manualEdit;
    const num = k => (m[k] === '' || m[k] == null ? null : Number(m[k]));
    const body = { account: m.account, exchange: m.exchange, symbol: String(m.symbol || '').trim().toUpperCase(), side: m.side,
      leverage: num('leverage'), avg_entry: num('avg_entry'), margin: num('margin'),
      liq_price: num('liq_price'), tp_price: num('tp_price'), sl_price: num('sl_price') };
    const bad = [!body.account && 'account', !body.symbol && 'symbol', !(body.leverage > 0) && 'leverage',
      !(body.avg_entry > 0) && 'entry price', !(body.margin > 0) && 'margin'].filter(Boolean);
    if (bad.length) { $('mcMfErr').textContent = 'Fill in: ' + bad.join(', '); $('mcMfErr').className = 'mc-sub mc-down'; return; }
    try {
      await apiFetch(m.id ? `/mission/manual/${m.id}` : '/mission/manual', { method: m.id ? 'PUT' : 'POST', body: JSON.stringify(body) });
      $('mcManual').hidden = true;
      manualEdit = null;
      note(m.id ? 'Trade updated.' : 'Trade added.');
      load();
    } catch (err) { $('mcMfErr').textContent = 'Could not save: ' + err.message; $('mcMfErr').className = 'mc-sub mc-down'; }
  }

  async function onBodyClick(e) {
    const t = e.target.closest('button');
    if (!t) return;
    if (t.dataset.addAcc !== undefined) { openManual({ account: t.dataset.addAcc, exchange: t.dataset.addEx }); return; }
    if (t.dataset.medit) {
      const p = data.positions.find(x => String(x.id) === t.dataset.medit);
      if (p) openManual({ id: p.id, account: p.account, exchange: p.exchange, symbol: p.symbol, side: p.side,
        leverage: p.leverage, avg_entry: p.avg_entry, margin: p.margin,
        liq_price: p.liq_estimated ? '' : p.liq_price, tp_price: p.tp_price ?? '', sl_price: p.sl_price ?? '' });
      return;
    }
    if (t.dataset.mclose) {
      const id = Number(t.dataset.mclose);
      if (!closeArmed.has(id)) {           // first click arms, second click closes
        closeArmed.add(id);
        render();
        setTimeout(() => { closeArmed.delete(id); if (isOpen) render(); }, 4000);
        return;
      }
      closeArmed.delete(id);
      try { await apiFetch(`/mission/manual/${id}`, { method: 'DELETE' }); note('Trade closed.'); load(); }
      catch (err) { note('Could not close: ' + err.message, true); }
    }
  }

  // ── Wiring ─────────────────────────────────────────────────
  function init() {
    if (!$('mcScreen')) return;
    $('mcNotch').addEventListener('click', open);
    $('mcClose').addEventListener('click', close);
    $('mcHandle').addEventListener('click', close);
    $('mcBackdrop').addEventListener('click', close);
    $('mcSync').addEventListener('click', syncNow);
    $('mcEditAcc').addEventListener('click', openEditor);
    $('mcAddTrade').addEventListener('click', () => openManual());
    $('mcManual').addEventListener('input', onManualInput);
    $('mcManual').addEventListener('change', onManualInput);
    $('mcManual').addEventListener('click', onManualClick);
    $('mcBody').addEventListener('click', onBodyClick);
    $('mcEditor').addEventListener('input', onEditorInput);
    $('mcEditor').addEventListener('change', onEditorInput);
    $('mcEditor').addEventListener('click', onEditorClick);
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && isOpen) { e.stopPropagation(); close(); }
    });
    document.addEventListener('illustrade:login', () => { load().then(() => allowed && schedule()); });
    document.addEventListener('illustrade:logout', () => {
      close(); stop(); allowed = false; data = null;
      $('mcNotch').hidden = true;
    });
    if (typeof getToken === 'function' && getToken()) load().then(() => allowed && schedule());
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
