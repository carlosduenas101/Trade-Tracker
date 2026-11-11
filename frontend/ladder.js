/* ════════════════════════════════════════════════════════════
   LIQ LADDER CALCULATOR
   Second mode of the calculator panel (next to Fib Cascade).

   Strategy (backtested on Bitunix 5m, Jan 2025 – Nov 2026):
     • E1 = limit order at Equilibrium or Discount (whichever is touched first)
     • Margins double each entry: E1 = 3% of capital, then 2×, 4×, …
       The last entry uses whatever capital is left.
     • E2 sits 1.619% beyond E1.
     • E3 onwards sit 1% before the liquidation price of the position so far.
     • Exits: only E1 → TP 1% from E1 · E1+E2 → exit at E1 price ·
       E3 or deeper → TP 1% from the average price.
     • SL sits 2.618% beyond the last entry (often not effective — the
       calculator reports whether liquidation comes first).
   ════════════════════════════════════════════════════════════ */

/*
 * LiqLadder-v1 — pure calculation engine (no DOM).
 *
 * Inputs:
 *   capital    — total margin committed to the ladder (USDT)
 *   leverage   — leverage multiplier (isolated margin)
 *   e1Price    — first entry price
 *   side       — "long" | "short"
 *   e1Pct      — E1 margin as % of capital (default 3)
 *   e2DistPct  — E2 distance from E1 in % (default 1.619)
 *   liqBufPct  — E3+ distance before current liquidation in % (default 1)
 *   tpPct      — take profit in % (default 1)
 *   slPct      — stop loss beyond the last entry in % (default 2.618)
 *   feePct     — taker fee per side in % (default 0.06)
 *   maxEntries — safety cap on number of entries (default 10)
 *
 * Liquidation is approximated as avg × (1 ∓ 1/leverage) — isolated margin,
 * without maintenance margin. Real exchange liquidation is slightly closer.
 */
function calcLadder({
  capital, leverage, e1Price, side = 'long',
  e1Pct = 3, e2DistPct = 1.619, liqBufPct = 1, tpPct = 1, slPct = 2.618, feePct = 0.06,
  maxEntries = 10,
}) {
  const isLong = side !== 'short';
  const dir    = isLong ? 1 : -1;          // +1 long (entries below), −1 short (entries above)
  const fee    = feePct / 100;
  const L      = leverage;

  // Step 1 — margin per entry: doubling from E1, last entry takes the remainder
  const margins = [];
  let remaining = capital;
  const base = capital * (e1Pct / 100);
  for (let k = 0; remaining > capital * 1e-6 && margins.length < maxEntries; k++) {
    const take = Math.min(base * Math.pow(2, k), remaining);
    if (take < capital * 0.001) break;
    margins.push(take);
    remaining -= take;
  }

  const liqOf = avg => isLong ? avg * (1 - 1 / L) : avg * (1 + 1 / L);

  // Step 2 — walk the ladder
  const rows = [];
  let N = 0, Q = 0, entryFees = 0, liq = 0, prevPrice = e1Price;
  let blocked = null;
  for (let i = 0; i < margins.length; i++) {
    let price;
    if (i === 0)      price = e1Price;
    else if (i === 1) price = e1Price * (1 - dir * e2DistPct / 100);
    else              price = liq * (1 + dir * liqBufPct / 100);

    // An entry must sit beyond the previous one and before the current liquidation
    if (i > 0) {
      const beyondPrev   = isLong ? price < prevPrice : price > prevPrice;
      const beforeLiq    = isLong ? price > liq       : price < liq;
      if (!beyondPrev || !beforeLiq) { blocked = { entry: i + 1, price, liq }; break; }
    }

    const margin   = margins[i];
    const notional = margin * L;
    N += notional;
    Q += notional / price;
    entryFees += notional * fee;
    const avg = N / Q;
    liq = liqOf(avg);

    // Exit rule for a cycle that stops at this depth
    let tp;
    if (i === 0)      tp = e1Price * (1 + dir * tpPct / 100);
    else if (i === 1) tp = e1Price;
    else              tp = avg * (1 + dir * tpPct / 100);

    const gross  = isLong ? Q * tp - N : N - Q * tp;
    const profit = gross - entryFees - Q * tp * fee;
    const used   = rows.reduce((s, r) => s + r.margin, 0) + margin;

    rows.push({
      n: i + 1, margin, notional, price,
      distFromE1: (price / e1Price - 1) * 100,
      marginUsed: used, notionalTotal: N, qty: Q,
      avg, liq, liqDistFromE1: (liq / e1Price - 1) * 100,
      tp, tpDistFromE1: (tp / e1Price - 1) * 100,
      profit, roe: profit / used * 100,
    });
    prevPrice = price;
  }

  // Step 3 — stop loss beyond the last entry, and whether it acts before liquidation
  const last      = rows[rows.length - 1];
  const sl        = last.price * (1 - dir * slPct / 100);
  const slEffective = isLong ? sl > last.liq : sl < last.liq;
  const slGross   = isLong ? last.qty * sl - last.notionalTotal : last.notionalTotal - last.qty * sl;
  const slLoss    = slGross - entryFees - last.qty * sl * fee;
  const liqLoss   = -(last.marginUsed + entryFees);
  const slAboveLiqPct = isLong ? (sl / last.liq - 1) * 100 : (last.liq / sl - 1) * 100;

  return {
    side: isLong ? 'long' : 'short', leverage: L, capital, e1Price,
    params: { e1Pct, e2DistPct, liqBufPct, tpPct, slPct, feePct },
    rows, blocked,
    marginUsed: last.marginUsed, unusedCapital: capital - last.marginUsed,
    totalNotional: last.notionalTotal, finalAvg: last.avg,
    finalLiq: last.liq, finalLiqDistFromE1: last.liqDistFromE1,
    sl, slDistFromE1: (sl / e1Price - 1) * 100, slEffective, slAboveLiqPct,
    slLoss, liqLoss, entryFees,
  };
}

/* Backtest reference — Bitunix 5m, 1 Jan 2025 – 5 Nov 2026, $1,000 account,
   default parameters, one account running continuously (net, USDT). */
const LADDER_BACKTEST = {
  3: { BTC: { net: 115, note: '0 losses' }, ETH: { net: 303, note: '0 losses' }, XRP: { net: 598, note: '0 losses' } },
  5: { BTC: { net: 384, note: '0 losses' }, ETH: { net: 98, note: '1 liquidation' }, XRP: { net: 75, note: '1 liquidation' } },
  7: { BTC: { net: -212, note: '1 liquidation' }, ETH: { net: -1341, note: '3 liquidations' }, XRP: { net: -588, note: '3 liquidations' } },
};

/*
 * LiqLadder-Sim-v1 — historical probability simulation (no DOM).
 *
 * Replays the ladder plan (from calcLadder) starting at every candle of the
 * history: E1 fills at that candle's open, the rest of the ladder is scaled to it
 * (all levels are % of E1), and the cycle runs until TP, SL or liquidation.
 *
 * series : { t:[sec], o:[], h:[], l:[], c:[] }  (columnar, ascending time)
 * plan   : result of calcLadder()
 * opts   : { fromSec, e1Price, contextDays = 30, contextBand = 0.10,
 *            onlySimilar = false, stride = 1 }
 *
 * Within a candle the order is: fills → SL → liquidation → TP (TP not checked on
 * the entry candle). Starts whose cycle is still open at the end of the data are
 * reported separately and excluded from the probability.
 *
 * Returns a "state" object; call step(state, budgetMs) until state.done.
 */
function ladderSimInit(series, plan, opts = {}) {
  const n = series.t.length;
  const isLong = plan.side === 'long';
  const e1 = plan.e1Price;
  const rows = plan.rows;
  const st = {
    series, plan, n, isLong,
    rel:    rows.map(r => r.price / e1),
    relLiq: rows.map(r => r.liq / e1),
    relTp:  rows.map(r => r.tp / e1),
    profit: rows.map(r => r.profit),
    relSl:  plan.slEffective ? plan.sl / e1 : null,
    slLoss: plan.slLoss, liqLoss: plan.liqLoss,
    stride: Math.max(1, opts.stride || 1),
    i: 0, done: false,
    counts: { tp: 0, sl: 0, liq: 0, open: 0, skipped: 0 },
    depth: new Array(rows.length + 1).fill(0),
    tpDays: [], sumPnl: 0, worstAdverse: 0, lossDays: new Set(), lossStarts: [],
  };

  // Start of the simulated window
  const fromSec = opts.fromSec || 0;
  let first = 0;
  while (first < n && series.t[first] < fromSec) first++;
  st.i = first;
  st.first = first;

  // Context filter: position of the price inside the trailing N-day range
  st.onlySimilar = !!opts.onlySimilar;
  if (st.onlySimilar) {
    const step = n > 1 ? series.t[1] - series.t[0] : 300;
    const W = Math.max(2, Math.round((opts.contextDays || 30) * 86400 / step));
    const band = opts.contextBand ?? 0.10;
    const pos = new Float64Array(n).fill(NaN);
    const dqH = [], dqL = [];
    // pos[i] uses candles [i-W, i-1]
    for (let i = 0; i < n; i++) {
      if (i > 0) {
        const j = i - 1;
        while (dqH.length && series.h[dqH[dqH.length - 1]] <= series.h[j]) dqH.pop(); dqH.push(j);
        while (dqL.length && series.l[dqL[dqL.length - 1]] >= series.l[j]) dqL.pop(); dqL.push(j);
        while (dqH[0] < i - W) dqH.shift();
        while (dqL[0] < i - W) dqL.shift();
      }
      if (i >= W) {
        const hi = series.h[dqH[0]], lo = series.l[dqL[0]];
        if (hi > lo) pos[i] = (series.o[i] - lo) / (hi - lo);
      }
    }
    // Position of the user's E1 inside the latest N-day range
    let hi = -Infinity, lo = Infinity;
    for (let j = Math.max(0, n - W); j < n; j++) { if (series.h[j] > hi) hi = series.h[j]; if (series.l[j] < lo) lo = series.l[j]; }
    const posNow = hi > lo ? ((opts.e1Price ?? e1) - lo) / (hi - lo) : NaN;
    st.pos = pos; st.posNow = posNow; st.band = band; st.contextDays = opts.contextDays || 30;
    st.rangeNow = { hi, lo };
  }
  return st;
}

function ladderSimCycle(st, i) {
  const { series: s, isLong, rel, relLiq, relTp, relSl } = st;
  const e1 = s.o[i];
  const last = rel.length;
  let k = 1, worst = 0;
  for (let j = i; j < st.n; j++) {
    const hi = s.h[j], lo = s.l[j];
    if (isLong) {
      while (k < last && lo <= e1 * rel[k]) k++;
      const adv = lo / e1 - 1; if (adv < worst) worst = adv;
      if (relSl !== null && k === last && lo <= e1 * relSl) return { r: 2, k, j, worst };
      if (lo <= e1 * relLiq[k - 1]) return { r: 3, k, j, worst };
      if (j > i && hi >= e1 * relTp[k - 1]) return { r: 1, k, j, worst };
    } else {
      while (k < last && hi >= e1 * rel[k]) k++;
      const adv = e1 / hi - 1; if (adv < worst) worst = adv;
      if (relSl !== null && k === last && hi >= e1 * relSl) return { r: 2, k, j, worst };
      if (hi >= e1 * relLiq[k - 1]) return { r: 3, k, j, worst };
      if (j > i && lo <= e1 * relTp[k - 1]) return { r: 1, k, j, worst };
    }
  }
  return { r: 0, k, j: st.n - 1, worst };
}

function ladderSimStep(st, budgetMs = 30) {
  const t0 = Date.now();
  const s = st.series;
  while (st.i < st.n) {
    const i = st.i;
    st.i += st.stride;
    if (st.onlySimilar) {
      const p = st.pos[i];
      if (!(Math.abs(p - st.posNow) <= st.band)) { st.counts.skipped++; continue; }
    }
    const c = ladderSimCycle(st, i);
    if (c.r === 0) { st.counts.open++; continue; }
    st.depth[c.k]++;
    if (c.worst < st.worstAdverse) st.worstAdverse = c.worst;
    if (c.r === 1) {
      st.counts.tp++;
      st.sumPnl += st.profit[c.k - 1];
      st.tpDays.push((s.t[c.j] - s.t[i]) / 86400);
    } else {
      if (c.r === 2) st.counts.sl++; else st.counts.liq++;
      st.sumPnl += c.r === 2 ? st.slLoss : st.liqLoss;
      st.lossDays.add(Math.floor(s.t[c.j] / 86400));
      if (st.lossStarts.length < 2000) st.lossStarts.push(s.t[i]);
    }
    if (Date.now() - t0 > budgetMs) break;
  }
  st.done = st.i >= st.n;
  st.progress = (Math.min(st.i, st.n) - st.first) / Math.max(1, st.n - st.first);
  return st;
}

/* Wilson score interval for a proportion (z = 1.96 → 95%). */
function wilson(k, n, z = 1.96) {
  if (!n) return [0, 0];
  const p = k / n, z2 = z * z, d = 1 + z2 / n;
  const c = (p + z2 / (2 * n)) / d, m = (z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n))) / d;
  return [Math.max(0, c - m), Math.min(1, c + m)];
}

function ladderSimSummary(st) {
  const { counts, depth } = st;
  const resolved = counts.tp + counts.sl + counts.liq;
  const started = resolved + counts.open;
  const q = (arr, p) => { if (!arr.length) return null; const a = arr.slice().sort((x, y) => x - y); return a[Math.min(a.length - 1, Math.floor(p * a.length))]; };
  // probability of reaching each entry (among resolved cycles)
  const reach = [];
  let atLeast = resolved;
  for (let k = 1; k < depth.length; k++) { reach.push({ entry: k, pct: resolved ? atLeast / resolved * 100 : 0 }); atLeast -= depth[k]; }
  const losses = counts.sl + counts.liq;
  return {
    started, resolved, open: counts.open, skipped: counts.skipped,
    tp: counts.tp, sl: counts.sl, liq: counts.liq,
    pPositive: resolved ? counts.tp / resolved * 100 : null,
    ci: wilson(counts.tp, resolved).map(x => x * 100),
    pLoss: resolved ? losses / resolved * 100 : null,
    lossEvents: st.lossDays.size,
    evPerCycle: resolved ? st.sumPnl / resolved : null,
    reach,
    tpDaysMedian: q(st.tpDays, 0.5), tpDaysP90: q(st.tpDays, 0.9), tpDaysMax: q(st.tpDays, 1),
    worstAdversePct: st.worstAdverse * 100,
    posNow: st.posNow, band: st.band, contextDays: st.contextDays, rangeNow: st.rangeNow,
    onlySimilar: st.onlySimilar,
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { calcLadder, LADDER_BACKTEST, ladderSimInit, ladderSimStep, ladderSimSummary, ladderSimCycle, wilson };
}

/* ════════════════════════════════════════════════════════════
   UI — only runs in the browser
   ════════════════════════════════════════════════════════════ */
(function initLadderCalc() {
  if (typeof document === 'undefined') return;
  const $ = id => document.getElementById(id);
  if (!$('fcModeLadder')) return;

  const STORE_KEY = 'illustrade:ladder';
  const DEFAULTS  = { e1Pct: 3, e2DistPct: 1.619, liqBufPct: 1, tpPct: 1, slPct: 2.618, feePct: 0.06 };
  let side = 'long';

  const esc  = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtM = (n, d = 2) => (n < 0 ? '−$' : '$') + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtS = (n, d = 2) => (n >= 0 ? '+' : '−') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  const fmtPct = (n, d = 2) => (n > 0 ? '+' : n < 0 ? '−' : '') + Math.abs(n).toFixed(d) + '%';
  function fmtP(n, ref) {
    // price precision follows the size of the E1 price
    const d = ref >= 1000 ? 1 : ref >= 10 ? 3 : ref >= 1 ? 4 : 6;
    return n.toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });
  }

  // ── Mode switch (Fib Cascade ↔ Liq Ladder) ─────────────────
  function setMode(mode) {
    const ladder = mode === 'ladder';
    $('fcModeFib').hidden    = ladder;
    $('fcModeLadder').hidden = !ladder;
    $('fcModeFibBtn').classList.toggle('active', !ladder);
    $('fcModeLadderBtn').classList.toggle('active', ladder);
    const title = document.querySelector('.fib-calc-title');
    if (title) title.textContent = ladder ? 'Liq Ladder Calc' : 'Fib Multi-Entry Calc';
    try { localStorage.setItem('illustrade:calcMode', mode); } catch { /* storage unavailable */ }
  }
  $('fcModeFibBtn').addEventListener('click', () => setMode('fib'));
  $('fcModeLadderBtn').addEventListener('click', () => setMode('ladder'));

  // ── Side toggle ────────────────────────────────────────────
  function setSide(s) {
    side = s;
    $('lcLong').classList.toggle('active', s === 'long');
    $('lcShort').classList.toggle('active', s === 'short');
  }
  $('lcLong').addEventListener('click', () => { setSide('long'); recalcIfShown(); });
  $('lcShort').addEventListener('click', () => { setSide('short'); recalcIfShown(); });

  // ── Leverage slider (1–20, default 3) ──────────────────────
  const lev = $('lcLeverage');
  function updateLev() {
    $('lcLeverageDisplay').textContent = lev.value + '×';
    const pct = ((lev.value - 1) / (20 - 1)) * 100;
    lev.style.background = `linear-gradient(to right, var(--accent-primary) ${pct}%, var(--border-default) ${pct}%)`;
    document.querySelectorAll('.lc-preset').forEach(b => b.classList.toggle('active', b.dataset.lev === lev.value));
  }
  lev.addEventListener('input', () => { updateLev(); recalcIfShown(); });
  $('lcLevMinus').addEventListener('click', () => { lev.value = Math.max(1, +lev.value - 1); updateLev(); recalcIfShown(); });
  $('lcLevPlus').addEventListener('click', () => { lev.value = Math.min(20, +lev.value + 1); updateLev(); recalcIfShown(); });
  document.querySelectorAll('.lc-preset').forEach(b => b.addEventListener('click', () => { lev.value = b.dataset.lev; updateLev(); recalcIfShown(); }));

  // ── Advanced parameters ────────────────────────────────────
  const advIds = { e1Pct: 'lcE1Pct', e2DistPct: 'lcE2Dist', liqBufPct: 'lcLiqBuf', tpPct: 'lcTp', slPct: 'lcSl', feePct: 'lcFee' };
  function readParams() {
    const p = {};
    for (const [k, id] of Object.entries(advIds)) {
      const v = parseFloat($(id).value);
      p[k] = Number.isFinite(v) && v >= 0 ? v : DEFAULTS[k];
    }
    return p;
  }
  const isDefault = p => Object.keys(DEFAULTS).every(k => Math.abs(p[k] - DEFAULTS[k]) < 1e-9);
  $('lcResetAdv').addEventListener('click', () => {
    for (const [k, id] of Object.entries(advIds)) $(id).value = DEFAULTS[k];
    recalcIfShown();
  });

  // ── Persistence ────────────────────────────────────────────
  function save() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        capital: $('lcCapital').value, pair: $('lcPair').value, side, e1: $('lcE1').value,
        lev: lev.value, minOrder: $('lcMinOrder').value, adv: readParams(),
      }));
    } catch { /* storage unavailable */ }
  }
  function load() {
    let s = null;
    try { s = JSON.parse(localStorage.getItem(STORE_KEY) || 'null'); } catch { s = null; }
    if (s) {
      if (s.capital) $('lcCapital').value = s.capital;
      if (s.pair)    $('lcPair').value = s.pair;
      if (s.e1)      $('lcE1').value = s.e1;
      if (s.lev)     lev.value = s.lev;
      if (s.minOrder) $('lcMinOrder').value = s.minOrder;
      if (s.side)    setSide(s.side);
      if (s.adv) for (const [k, id] of Object.entries(advIds)) if (s.adv[k] != null) $(id).value = s.adv[k];
    }
    updateLev();
    let mode = 'fib';
    try { mode = localStorage.getItem('illustrade:calcMode') || 'fib'; } catch { /* storage unavailable */ }
    setMode(mode);
  }

  // ── Render ─────────────────────────────────────────────────
  function warn(msg) { $('lcWarning').innerHTML = msg; $('lcWarning').hidden = !msg; }

  function render() {
    const capital  = parseFloat($('lcCapital').value);
    const e1Price  = parseFloat($('lcE1').value);
    const leverage = parseInt(lev.value, 10);
    if (!capital || capital <= 0) { warn('⚠ Enter the capital for this ladder.'); $('lcResults').hidden = true; return; }
    if (!e1Price || e1Price <= 0) { warn('⚠ Enter the E1 price (Equilibrium or Discount level).'); $('lcResults').hidden = true; return; }

    const params = readParams();
    const c = calcLadder({ capital, leverage, e1Price, side, ...params });
    const ref = e1Price;
    const isLong = c.side === 'long';

    // Warnings
    const msgs = [];
    if (c.blocked) msgs.push(`⚠ E${c.blocked.entry} would sit beyond the liquidation price (${fmtP(c.blocked.liq, ref)}). At ${leverage}× the ladder stops at E${c.blocked.entry - 1}; lower the leverage.`);
    if (leverage >= 7) msgs.push(`⚠ At ${leverage}× the full ladder liquidates ${Math.abs(c.finalLiqDistFromE1).toFixed(1)}% from E1. In the backtest 7× lost money on BTC, ETH and XRP.`);
    else if (leverage > 3) msgs.push(`⚠ Above 3× the full ladder liquidates ${Math.abs(c.finalLiqDistFromE1).toFixed(1)}% from E1. In the backtest only BTC stayed loss-free at 5×.`);
    const minOrder = parseFloat($('lcMinOrder').value);
    if (minOrder > 0) {
      const small = c.rows.filter(r => r.notional < minOrder).map(r => 'E' + r.n);
      if (small.length) msgs.push(`⚠ ${small.join(', ')} below the exchange minimum order of ${fmtM(minOrder)} notional. Increase capital.`);
    }
    warn(msgs.join('<br>'));

    // Entry cards
    const sign = isLong ? '−' : '+';
    $('lcLadder').innerHTML = c.rows.map(r => `
      <div class="lc-entry">
        <div class="lc-entry-top">
          <span class="lc-entry-tag">E${r.n}</span>
          <span class="lc-entry-cap">${fmtM(r.margin)} · ${fmtM(r.notional)}</span>
          <span class="lc-entry-price">${fmtP(r.price, ref)}</span>
          <span class="lc-entry-dist">${r.n === 1 ? 'E1' : fmtPct(r.distFromE1)}</span>
        </div>
        <div class="lc-entry-sub">
          <span>Avg <b>${fmtP(r.avg, ref)}</b></span>
          <span>Liq <b class="fib-red">${fmtP(r.liq, ref)}</b></span>
        </div>
        <div class="lc-entry-sub">
          <span>${r.n === 2 ? 'Exit at E1' : 'TP'} <b class="fib-green">${fmtP(r.tp, ref)}</b></span>
          <span class="fib-green">${fmtS(r.profit)} <span class="lc-roe">${r.roe.toFixed(2)}% ROE</span></span>
        </div>
      </div>`).join('');

    // Risk summary
    const slTxt = c.slEffective
      ? `<span class="fib-check-ok">Effective</span> · ${c.slAboveLiqPct.toFixed(2)}% before liq`
      : `<span class="fib-check-fail">Not effective</span> · liquidation comes first`;
    $('lcSummary').innerHTML = `
      <div class="fib-row"><span class="fib-key">Entries</span><span class="fib-val">${c.rows.length}${c.blocked ? ' (capped)' : ''}</span></div>
      <div class="fib-row"><span class="fib-key">Margin used</span><span class="fib-val">${fmtM(c.marginUsed)}${c.unusedCapital > 0.005 ? ` <span class="fib-pct">(${fmtM(c.unusedCapital)} unused)</span>` : ''}</span></div>
      <div class="fib-row"><span class="fib-key">Total notional</span><span class="fib-val">${fmtM(c.totalNotional)}</span></div>
      <div class="fib-row fib-divider"><span class="fib-key">Avg (all filled)</span><span class="fib-val fib-accent">${fmtP(c.finalAvg, ref)}</span></div>
      <div class="fib-row"><span class="fib-key">Liquidation</span><span class="fib-val fib-red">${fmtP(c.finalLiq, ref)} <span class="fib-pct">${fmtPct(c.finalLiqDistFromE1, 1)}</span></span></div>
      <div class="fib-row"><span class="fib-key">Stop loss <span class="fib-pct">${sign}${params.slPct}% from E${c.rows.length}</span></span><span class="fib-val fib-red">${fmtP(c.sl, ref)}</span></div>
      <div class="fib-row"><span class="fib-key">SL status</span><span class="fib-val">${slTxt}</span></div>
      <div class="fib-row fib-divider"><span class="fib-key">Loss at SL</span><span class="fib-val fib-red">${c.slEffective ? fmtM(c.slLoss) : '—'}</span></div>
      <div class="fib-row"><span class="fib-key">Loss at liquidation</span><span class="fib-val fib-red">${fmtM(c.liqLoss)}</span></div>
      <div class="fib-row"><span class="fib-key">Best cycle (deepest TP)</span><span class="fib-val fib-green">${fmtS(c.rows[c.rows.length - 1].profit)}</span></div>`;

    // Backtest reference
    const bt = LADDER_BACKTEST[leverage];
    const scale = capital / 1000;
    if (bt) {
      const coin = ($('lcPair').value || '').split('/')[0];
      $('lcBacktest').innerHTML = `
        <table class="fib-table">
          <thead><tr><th>Coin</th><th>Per $1,000</th><th>Your capital</th></tr></thead>
          <tbody>${Object.entries(bt).map(([k, v]) => `
            <tr class="${k === coin ? 'lc-bt-current' : ''}">
              <td>${k} ${leverage}×</td>
              <td class="${v.net >= 0 ? 'fib-green' : 'fib-red'}">${fmtS(v.net, 0)}</td>
              <td class="${v.net >= 0 ? 'fib-green' : 'fib-red'}">${fmtS(v.net * scale)}</td>
            </tr>
            <tr class="lc-bt-note"><td colspan="3">${v.note}</td></tr>`).join('')}
          </tbody>
        </table>
        <div class="lc-bt-foot">Bitunix 5m · 1 Jan 2025 – 5 Nov 2026 · one account trading continuously.${isDefault(params) ? '' : ' <b>Reference uses default parameters, not your custom ones.</b>'} Past results do not guarantee future results.</div>`;
      $('lcBacktestWrap').hidden = false;
    } else {
      $('lcBacktestWrap').hidden = true;
    }

    $('lcResults').hidden = false;
    lastPlan = c;
    if (!$('lcSimOut').hidden && !simRunning) {
      $('lcSimOut').hidden = true;
      setSimStatus('Inputs changed. Run the simulation again.');
    }
    save();
  }

  function recalcIfShown() { if (!$('lcResults').hidden) render(); }

  // ── Probability simulation ─────────────────────────────────
  let lastPlan = null, simRunning = false;
  const seriesCache = new Map();

  function setSimStatus(msg, isError = false) {
    const el = $('lcSimStatus');
    el.textContent = msg || '';
    el.hidden = !msg;
    el.classList.toggle('error', isError);
  }

  async function fetchSeries(symbol, tf) {
    const key = symbol + '_' + tf;
    if (seriesCache.has(key)) return seriesCache.get(key);
    if (typeof apiFetch !== 'function') throw new Error('Not connected to the Illustrade backend.');
    const url = `/market/klines?symbol=${encodeURIComponent(symbol)}&interval=${tf}&start=2025-01-01`;
    for (let attempt = 0; attempt < 400; attempt++) {
      let res;
      try {
        res = await apiFetch(url);
      } catch (err) {
        // A web page instead of JSON means the running backend has no /market route yet
        if (err instanceof SyntaxError || /JSON|HTTP 404/.test(String(err && err.message))) {
          throw new Error('The backend has no market data route yet. Restart the backend (start.bat) after updating, or deploy the new backend to Render.');
        }
        throw err;
      }
      if (res && res.status === 'ready') {
        const series = { t: res.t, o: res.o, h: res.h, l: res.l, c: res.c };
        seriesCache.set(key, series);
        return series;
      }
      const pct = Math.round(((res && res.progress) || 0) * 100);
      setSimStatus(`Downloading ${symbol} ${tf} history from Bitunix… ${pct}% (first time only)`);
      await new Promise(r => setTimeout(r, 2500));
    }
    throw new Error('History download is taking too long. Try again in a minute.');
  }

  async function runSimulation() {
    if (simRunning) return;
    render();
    if ($('lcResults').hidden || !lastPlan) return;
    const plan = lastPlan;
    const symbol = ($('lcPair').value || 'BTC/USDT').replace('/', '');
    const tf = $('lcSimTf').value;
    const period = $('lcSimPeriod').value;
    const onlySimilar = $('lcSimSimilar').checked;

    simRunning = true;
    $('lcSimBtn').disabled = true;
    $('lcSimOut').hidden = true;
    try {
      setSimStatus(`Loading ${symbol} ${tf} history…`);
      const series = await fetchSeries(symbol, tf);
      if (!series.t.length) throw new Error('No history returned for ' + symbol + '.');
      const lastT = series.t[series.t.length - 1];
      const fromSec = period === 'all' ? 0 : lastT - parseInt(period, 10) * 86400;

      const st = ladderSimInit(series, plan, { fromSec, e1Price: plan.e1Price, onlySimilar, contextDays: 30, contextBand: 0.10 });
      await new Promise(resolve => {
        const tick = () => {
          ladderSimStep(st, 40);
          setSimStatus(`Simulating ${symbol} ${tf}… ${Math.round(st.progress * 100)}%`);
          if (st.done) resolve(); else setTimeout(tick, 0);
        };
        tick();
      });
      renderSim(ladderSimSummary(st), { symbol, tf, period, series, fromSec, plan });
      setSimStatus('');
    } catch (err) {
      setSimStatus('⚠ ' + (err && err.message ? err.message : 'Simulation failed.'), true);
    } finally {
      simRunning = false;
      $('lcSimBtn').disabled = false;
    }
  }

  function renderSim(sum, ctx) {
    const ref = ctx.plan.e1Price;
    const fDate = sec => new Date(sec * 1000).toISOString().slice(0, 10);
    const firstIdx = ctx.series.t.findIndex(t => t >= ctx.fromSec);
    const from = fDate(ctx.series.t[Math.max(0, firstIdx)]);
    const to = fDate(ctx.series.t[ctx.series.t.length - 1]);
    const fDays = d => d == null ? '—' : d < 1 ? (d * 24).toFixed(1) + ' h' : d.toFixed(1) + ' d';

    const ctxLine = sum.onlySimilar && Number.isFinite(sum.posNow)
      ? `<div class="lc-sim-note">Your E1 sits at <b>${(sum.posNow * 100).toFixed(0)}%</b> of the last ${sum.contextDays}-day range (${fmtP(sum.rangeNow.lo, ref)} – ${fmtP(sum.rangeNow.hi, ref)})${sum.posNow < 0 ? ', below the range low' : sum.posNow > 1 ? ', above the range high' : ''}. Only historical starts between ${((sum.posNow - sum.band) * 100).toFixed(0)}% and ${((sum.posNow + sum.band) * 100).toFixed(0)}% are counted.</div>`
      : '';

    if (!sum.resolved) {
      $('lcSimOut').innerHTML = `${ctxLine}<div class="lc-sim-note">No completed cycles in this window${sum.onlySimilar ? ' with a similar E1 position' : ''}. Try a longer history or turn off the similar-setups filter.</div>`;
      $('lcSimOut').hidden = false;
      return;
    }

    const good = sum.pPositive >= 99;

    $('lcSimOut').innerHTML = `
      <div class="lc-sim-hero${good ? '' : ' bad'}">
        <div class="lc-sim-hero-val">${sum.pPositive.toFixed(2)}%</div>
        <div class="lc-sim-hero-lbl">chance the cycle closes positive · 95% range ${sum.ci[0].toFixed(2)}–${sum.ci[1].toFixed(2)}%</div>
      </div>
      ${ctxLine}
      <div class="fib-row"><span class="fib-key">Data</span><span class="fib-val">${ctx.symbol} ${ctx.tf} · ${from} → ${to}</span></div>
      <div class="fib-row"><span class="fib-key">Cycles simulated</span><span class="fib-val">${sum.resolved.toLocaleString('en-US')}</span></div>
      <div class="fib-row"><span class="fib-key">Closed in TP</span><span class="fib-val fib-green">${sum.tp.toLocaleString('en-US')}</span></div>
      <div class="fib-row"><span class="fib-key">Stopped (SL)</span><span class="fib-val fib-red">${sum.sl.toLocaleString('en-US')}</span></div>
      <div class="fib-row"><span class="fib-key">Liquidated</span><span class="fib-val fib-red">${sum.liq.toLocaleString('en-US')}</span></div>
      <div class="fib-row"><span class="fib-key">Distinct loss days</span><span class="fib-val">${sum.lossEvents}</span></div>
      <div class="fib-row"><span class="fib-key">Still open at end (excluded)</span><span class="fib-val">${sum.open.toLocaleString('en-US')}</span></div>
      <div class="fib-row fib-divider"><span class="fib-key">Expected value / cycle</span><span class="fib-val ${sum.evPerCycle >= 0 ? 'fib-green' : 'fib-red'}">${fmtS(sum.evPerCycle)}</span></div>
      <div class="fib-row"><span class="fib-key">Time to TP (median · 90%)</span><span class="fib-val">${fDays(sum.tpDaysMedian)} · ${fDays(sum.tpDaysP90)}</span></div>
      <div class="fib-row"><span class="fib-key">Longest wait to TP</span><span class="fib-val">${fDays(sum.tpDaysMax)}</span></div>
      <div class="fib-row"><span class="fib-key">Worst move against E1</span><span class="fib-val fib-red">${sum.worstAdversePct.toFixed(1)}%</span></div>
      <div class="fib-section-title" style="margin-top:6px">Chance of reaching each entry</div>
      <div class="lc-sim-reach">${sum.reach.map(r => `<span>E${r.entry} ${r.pct < 0.1 && r.pct > 0 ? '&lt;0.1' : r.pct.toFixed(1)}%</span>`).join('')}</div>
      <div class="lc-sim-note">Every ${ctx.tf} candle in the window is used as a possible E1, and your ladder (same % levels) is replayed until TP, SL or liquidation. Starts overlap and share the same market moves, so the real uncertainty is wider than the 95% range shown, and losses come from the few crash days counted above. No funding or slippage. Past behaviour does not guarantee future results.</div>`;
    $('lcSimOut').hidden = false;
  }

  $('lcSimBtn').addEventListener('click', runSimulation);
  ['lcSimTf', 'lcSimPeriod', 'lcSimSimilar'].forEach(id => $(id).addEventListener('change', () => {
    if (!$('lcSimOut').hidden) { $('lcSimOut').hidden = true; setSimStatus('Settings changed. Run the simulation again.'); }
  }));

  $('lcCalcBtn').addEventListener('click', render);
  ['lcCapital', 'lcE1', 'lcMinOrder'].forEach(id => $(id).addEventListener('keydown', e => { if (e.key === 'Enter') render(); }));
  Object.values(advIds).forEach(id => $(id).addEventListener('change', recalcIfShown));
  $('lcPair').addEventListener('change', recalcIfShown);

  load();
})();
