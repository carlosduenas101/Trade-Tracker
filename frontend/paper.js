/* ============================================================
   Liq Ladder — live paper trading panel
   ------------------------------------------------------------
   Starts paper bots on the backend (/paper/bots) with the ladder
   currently set in the calculator, and shows their open cycle,
   history and P&L. The backend follows real Bitunix 1m candles
   and simulates every fill; no orders are sent to any exchange.
   Depends on apiFetch() from app.js.
   ============================================================ */
(function initPaperTrading() {
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  if (!$('lcPaper') || typeof apiFetch !== 'function') return;

  const REFRESH_MS = 15000;
  const PARAM_IDS = { e1Pct: 'lcE1Pct', e2DistPct: 'lcE2Dist', liqBufPct: 'lcLiqBuf', tpPct: 'lcTp', slPct: 'lcSl', feePct: 'lcFee' };
  const DEFAULTS  = { e1Pct: 3, e2DistPct: 1.619, liqBufPct: 1, tpPct: 1, slPct: 2.618, feePct: 0.06 };
  const MODE_LABEL = { zone: 'Equilibrium / Discount', price: 'Fixed E1 price', market: 'Market' };
  const STATUS_LABEL = { tp: 'TP', sl: 'SL', liq: 'Liquidated', open: 'Open' };

  let lastRefresh = 0, busy = false, data = null;
  const openHistory = new Set();
  const pendingDelete = new Set();

  const esc  = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtM = (n, d = 2) => n == null ? '—' : (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtS = (n, d = 2) => n == null ? '—' : (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const cls  = n => n > 0 ? 'fib-green' : n < 0 ? 'fib-red' : '';
  function fmtP(n, ref) {
    if (n == null) return '—';
    const r = Math.abs(ref || n);
    const d = r >= 1000 ? 2 : r >= 10 ? 3 : r >= 1 ? 4 : 6;
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }
  function ago(sec) {
    if (sec < 90) return 'just now';
    if (sec < 3600) return Math.round(sec / 60) + ' min ago';
    if (sec < 86400) return (sec / 3600).toFixed(1) + ' h ago';
    return (sec / 86400).toFixed(1) + ' d ago';
  }
  const fDate = sec => sec ? new Date(sec * 1000).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }) : '—';

  function setStatus(msg, isError = false) {
    const el = $('lcPaperStatus');
    el.textContent = msg || '';
    el.hidden = !msg;
    el.classList.toggle('error', isError);
  }

  /* apiFetch with clear messages for validation errors and an old backend */
  async function api(path, options) {
    try {
      return await apiFetch(path, options);
    } catch (err) {
      const m = String(err && err.message || err);
      if (err instanceof SyntaxError || /JSON|HTTP 404|HTTP 405/.test(m)) {
        throw new Error('The backend has no paper trading route yet. Restart the backend (start.bat) after updating, or deploy the new backend to Render.');
      }
      if (m === '[object Object]' || m.startsWith('[object')) throw new Error('Some values are not valid. Check capital, leverage and the advanced parameters.');
      throw err;
    }
  }

  function readParams() {
    const p = {};
    for (const [k, id] of Object.entries(PARAM_IDS)) {
      const v = parseFloat(($(id) || {}).value);
      p[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULTS[k];
    }
    return p;
  }

  async function startBot() {
    const capital = parseFloat($('lcCapital').value);
    const leverage = parseFloat($('lcLeverage').value);
    const pair = $('lcPair').value || 'BTC/USDT';
    const side = $('lcShort').classList.contains('active') ? 'short' : 'long';
    const mode = $('lcPaperEntry').value;
    const compound = parseFloat($('lcPaperCompound').value) || 0;
    const e1 = parseFloat($('lcE1').value);

    if (!(capital > 0)) { setStatus('Enter the ladder capital first.', true); $('lcCapital').focus(); return; }
    if (mode === 'price' && !(e1 > 0)) { setStatus('Enter the E1 price, or choose another entry mode.', true); $('lcE1').focus(); return; }

    const coin = pair.split('/')[0];
    const body = {
      name: `${coin} ${leverage}× ${side === 'long' ? 'Long' : 'Short'} · ${mode === 'price' ? 'E1 ' + e1 : MODE_LABEL[mode]}`.slice(0, 80),
      symbol: pair.replace('/', ''), side, capital, leverage, entry_mode: mode,
      entry_price: mode === 'price' ? e1 : null, compound_pct: compound, params: readParams(),
    };
    const btn = $('lcPaperStartBtn');
    btn.disabled = true;
    setStatus('Starting paper bot…');
    try {
      await api('/paper/bots', { method: 'POST', body: JSON.stringify(body) });
      setStatus(`Paper bot started on ${coin}. It checks new 1m candles every ~20 s.`);
      await refresh(true);
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      btn.disabled = false;
    }
  }

  function cycleRows(cycles, bot) {
    if (!cycles) return '<div class="lc-sim-note">Loading history…</div>';
    const closed = cycles.filter(c => c.status !== 'open');
    if (!closed.length) return '<div class="lc-sim-note">No closed cycles yet.</div>';
    return `<div class="lc-paper-hist">
      <div class="lc-paper-hist-row lc-paper-hist-head"><span>Closed</span><span>Result</span><span>Entries</span><span>P&amp;L</span></div>
      ${closed.map(c => `<div class="lc-paper-hist-row">
        <span>${fDate(c.exit_ts)}</span>
        <span class="${c.status === 'tp' ? 'fib-green' : 'fib-red'}">${STATUS_LABEL[c.status] || esc(c.status)}</span>
        <span>E${c.depth}</span>
        <span class="${cls(c.pnl)}">${fmtS(c.pnl)}</span>
      </div>`).join('')}
    </div>`;
  }

  function botCard(b, serverTime) {
    const oc = b.open_cycle;
    const lag = b.last_candle_ts ? serverTime - b.last_candle_ts - 60 : null;
    const ref = b.last_price || (oc && oc.e1_price);
    const running = b.status === 'running';
    const waiting = !oc && running
      ? `<div class="lc-sim-note">Waiting for E1: ${b.entry_mode === 'price' ? 'limit at ' + fmtP(b.entry_price, ref) : b.entry_mode === 'zone' ? 'limit at the Equilibrium / Discount of the 5m swing range' : 'next candle at market'}.</div>`
      : '';
    const open = oc ? `
      <div class="lc-paper-open">
        <div class="fib-row"><span class="fib-key">Open cycle</span><span class="fib-val">E${oc.depth} of ${oc.entries_total} · margin ${fmtM(oc.margin_used)}</span></div>
        <div class="fib-row"><span class="fib-key">E1 · Average</span><span class="fib-val">${fmtP(oc.e1_price, ref)} · ${fmtP(oc.avg, ref)}</span></div>
        <div class="fib-row"><span class="fib-key">Take profit</span><span class="fib-val fib-green">${fmtP(oc.tp, ref)}</span></div>
        ${oc.next_entry ? `<div class="fib-row"><span class="fib-key">Next entry</span><span class="fib-val">${fmtP(oc.next_entry, ref)}</span></div>` : ''}
        <div class="fib-row"><span class="fib-key">Liquidation</span><span class="fib-val fib-red">${fmtP(oc.liq, ref)}</span></div>
        <div class="fib-row"><span class="fib-key">Floating P&amp;L</span><span class="fib-val ${cls(oc.floating_pnl)}">${fmtS(oc.floating_pnl)}</span></div>
      </div>` : '';
    const delPending = pendingDelete.has(b.id);
    return `
      <div class="lc-paper-bot" data-id="${b.id}">
        <div class="lc-paper-head">
          <div class="lc-paper-name">${esc(b.name || b.symbol)}</div>
          <span class="lc-paper-badge ${running ? 'on' : ''}">${running ? 'Running' : 'Stopped'}</span>
        </div>
        <div class="lc-paper-net ${cls(b.net_pnl)}">${fmtS(b.net_pnl)}</div>
        <div class="lc-sim-note">Net P&amp;L incl. open cycle · ${b.compound_pct}% of profits compounded</div>
        ${b.last_error ? `<div class="lc-sim-status error">Data error: ${esc(b.last_error)}</div>` : ''}
        <div class="fib-row"><span class="fib-key">Cycles (W / L)</span><span class="fib-val">${b.cycles} (${b.wins} / ${b.losses})</span></div>
        <div class="fib-row"><span class="fib-key">Realized P&amp;L</span><span class="fib-val ${cls(b.realized_pnl)}">${fmtS(b.realized_pnl)}</span></div>
        <div class="fib-row"><span class="fib-key">Balance · Withdrawn</span><span class="fib-val">${fmtM(b.balance)} · ${fmtM(b.withdrawn)}</span></div>
        ${b.contributed > b.initial_capital ? `<div class="fib-row"><span class="fib-key">Refills after wipe-outs</span><span class="fib-val fib-red">${fmtM(b.contributed - b.initial_capital)}</span></div>` : ''}
        <div class="fib-row"><span class="fib-key">Last price</span><span class="fib-val">${fmtP(b.last_price, ref)}${lag != null ? ` <span class="lc-paper-lag">${running ? ago(Math.max(0, lag)) : 'paused'}</span>` : ''}</span></div>
        ${open}${waiting}
        <div class="lc-paper-actions">
          <button class="btn-inline" data-act="${running ? 'stop' : 'start'}" type="button">${running ? 'Stop' : 'Resume'}</button>
          <button class="btn-inline" data-act="history" type="button">${openHistory.has(b.id) ? 'Hide history' : 'History'}</button>
          <button class="btn-inline lc-paper-del${delPending ? ' confirm' : ''}" data-act="delete" type="button">${delPending ? 'Confirm delete' : 'Delete'}</button>
        </div>
        ${openHistory.has(b.id) ? `<div class="lc-paper-hist-wrap">${cycleRows(historyCache.get(b.id), b)}</div>` : ''}
      </div>`;
  }

  const historyCache = new Map();

  function render() {
    const list = $('lcPaperBots');
    if (!data) { list.innerHTML = ''; return; }
    if (!data.bots.length) {
      list.innerHTML = '<div class="lc-sim-note">No paper bots yet. Set up the ladder above and press Start Paper Bot.</div>';
      return;
    }
    list.innerHTML = data.bots.map(b => botCard(b, data.server_time)).join('');
  }

  async function loadHistory(id) {
    try {
      historyCache.set(id, await api(`/paper/bots/${id}/cycles?limit=100`));
    } catch (err) {
      setStatus(err.message, true);
    }
  }

  async function refresh(force = false) {
    if (busy && !force) return;
    busy = true;
    try {
      data = await api('/paper/bots');
      lastRefresh = Date.now();
      await Promise.all([...openHistory].filter(id => data.bots.some(b => b.id === id)).map(loadHistory));
      if ($('lcPaperStatus').classList.contains('error') && /backend|route/.test($('lcPaperStatus').textContent)) setStatus('');
      render();
    } catch (err) {
      setStatus(err.message, true);
    } finally {
      busy = false;
    }
  }

  $('lcPaperBots').addEventListener('click', async e => {
    const btn = e.target.closest('button[data-act]');
    if (!btn) return;
    const id = Number(btn.closest('.lc-paper-bot').dataset.id);
    const act = btn.dataset.act;
    if (act !== 'delete') pendingDelete.delete(id);
    try {
      if (act === 'history') {
        if (openHistory.has(id)) openHistory.delete(id);
        else { openHistory.add(id); render(); await loadHistory(id); }
        render();
        return;
      }
      if (act === 'delete' && !pendingDelete.has(id)) {
        pendingDelete.add(id);
        render();
        setTimeout(() => { if (pendingDelete.delete(id)) render(); }, 4000);
        return;
      }
      btn.disabled = true;
      if (act === 'delete') {
        pendingDelete.delete(id);
        openHistory.delete(id);
        historyCache.delete(id);
        await api(`/paper/bots/${id}`, { method: 'DELETE' });
      } else {
        await api(`/paper/bots/${id}/${act}`, { method: 'POST' });
      }
      await refresh(true);
    } catch (err) {
      setStatus(err.message, true);
      btn.disabled = false;
    }
  });

  $('lcPaperStartBtn').addEventListener('click', startBot);

  const visible = () => $('lcPaper').offsetParent !== null && document.visibilityState === 'visible'
    && (typeof getToken !== 'function' || !!getToken());
  setInterval(() => { if (visible() && Date.now() - lastRefresh >= REFRESH_MS) refresh(); }, 2000);
  document.addEventListener('visibilitychange', () => { if (visible()) refresh(); });
  const modeBtn = $('fcModeLadderBtn');
  if (modeBtn) modeBtn.addEventListener('click', () => setTimeout(() => { if (visible()) refresh(); }, 0));
})();
