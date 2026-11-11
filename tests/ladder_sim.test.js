// Run: node tests/ladder_sim.test.js
// Checks the probability simulation against an independent, slower reference
// implementation that rebuilds the ladder in absolute prices for every start.
const assert = require('assert');
const { calcLadder, ladderSimInit, ladderSimStep, ladderSimSummary, wilson } = require('../frontend/ladder.js');

// Deterministic synthetic 5m market with trends and two crashes
function makeSeries(n, seed) {
  let x = seed; const rnd = () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; };
  const t = [], o = [], h = [], l = [], c = [];
  let p = 100;
  for (let i = 0; i < n; i++) {
    const shock = (i % 9000 > 8800) ? -0.004 : 0;            // crash windows
    const r = (rnd() - 0.5) * 0.006 + shock + 0.00001;
    const op = p, cl = p * (1 + r);
    const hi = Math.max(op, cl) * (1 + rnd() * 0.002), lo = Math.min(op, cl) * (1 - rnd() * 0.002);
    t.push(1735689600 + i * 300); o.push(op); h.push(hi); l.push(lo); c.push(cl); p = cl;
  }
  return { t, o, h, l, c };
}

function reference(series, cfg) {
  const out = { tp: 0, sl: 0, liq: 0, open: 0, pnl: 0 };
  const n = series.t.length;
  for (let i = 0; i < n; i++) {
    const plan = calcLadder({ ...cfg, e1Price: series.o[i] });
    const long = plan.side === 'long';
    let k = 1, res = null;
    for (let j = i; j < n && !res; j++) {
      const hi = series.h[j], lo = series.l[j];
      const hitE = p => long ? lo <= p : hi >= p;
      const hitTp = p => long ? hi >= p : lo <= p;
      while (k < plan.rows.length && hitE(plan.rows[k].price)) k++;
      if (plan.slEffective && k === plan.rows.length && hitE(plan.sl)) res = ['sl', plan.slLoss];
      else if (hitE(plan.rows[k - 1].liq)) res = ['liq', plan.liqLoss];
      else if (j > i && hitTp(plan.rows[k - 1].tp)) res = ['tp', plan.rows[k - 1].profit];
    }
    if (!res) { out.open++; continue; }
    out[res[0]]++; out.pnl += res[1];
  }
  return out;
}

function run(series, cfg, opts = {}) {
  const plan = calcLadder({ ...cfg, e1Price: series.o[series.o.length - 1] });
  const st = ladderSimInit(series, plan, opts);
  while (!st.done) ladderSimStep(st, 1e9);
  return { st, sum: ladderSimSummary(st) };
}

const series = makeSeries(30000, 7);
for (const cfg of [
  { capital: 1000, leverage: 3, side: 'long' },
  { capital: 1000, leverage: 7, side: 'long' },
  { capital: 100, leverage: 5, side: 'short' },
  { capital: 1000, leverage: 10, side: 'long', liqBufPct: 3 },
]) {
  const ref = reference(series, cfg);
  const { st, sum } = run(series, cfg);
  const tag = JSON.stringify(cfg);
  assert.deepStrictEqual({ tp: sum.tp, sl: sum.sl, liq: sum.liq, open: sum.open }, { tp: ref.tp, sl: ref.sl, liq: ref.liq, open: ref.open }, 'counts ' + tag);
  // P&L in $ is identical up to float error (all levels scale with E1)
  assert.ok(Math.abs(st.sumPnl - ref.pnl) < 1e-6 * Math.max(1, Math.abs(ref.pnl)), `pnl ${st.sumPnl} vs ${ref.pnl} ${tag}`);
  assert.ok(Math.abs(sum.reach[0].pct - 100) < 1e-9, 'everyone reaches E1');
  assert.ok(sum.reach.every((r, i, a) => i === 0 || r.pct <= a[i - 1].pct), 'reach is non-increasing');
  console.log(tag, 'P(+) =', sum.pPositive.toFixed(3) + '%', 'losses', sum.sl + sum.liq, 'open', sum.open);
}

// Context filter keeps only similar starts and never adds any
const all = run(series, { capital: 1000, leverage: 3 }).sum;
const sim = run(series, { capital: 1000, leverage: 3 }, { onlySimilar: true, contextDays: 10, contextBand: 0.1 }).sum;
assert.ok(sim.started > 0 && sim.started + sim.skipped === all.started + all.skipped && sim.started < all.started, 'filter subset');

// fromSec window
const half = run(series, { capital: 1000, leverage: 3 }, { fromSec: series.t[15000] }).sum;
assert.strictEqual(half.started, 15000, 'starts from the window only');

// Wilson CI sanity
const [lo, hi] = wilson(95, 100); assert.ok(lo > 0.88 && lo < 0.9 && hi > 0.97 && hi < 0.99, 'wilson 95/100');
console.log('all simulation tests passed');
