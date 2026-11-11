const assert = require('assert');
const { calcLadder } = require('../frontend/ladder.js');
const near = (a, b, tol, msg) => assert.ok(Math.abs(a - b) <= tol, `${msg}: got ${a}, expected ${b}`);

// 1) $100, 3x, BTC long at 76,180 — must match the hand-checked Python numbers
let c = calcLadder({ capital: 100, leverage: 3, e1Price: 76180, side: 'long' });
assert.deepStrictEqual(c.rows.map(r => +r.margin.toFixed(2)), [3, 6, 12, 24, 48, 7]);
const expPrice = [76180.0, 74946.6, 50737.9, 39725.0, 31559.2, 25239.3];
const expProfit = [0.08, 0.26, 0.55, 1.19, 2.45, 2.64];
c.rows.forEach((r, i) => { near(r.price, expPrice[i], 0.1, `price E${i+1}`); near(r.profit, expProfit[i], 0.006, `profit E${i+1}`); });
near(c.finalLiq, 24168.6, 0.1, 'final liq');
near(c.finalLiqDistFromE1, -68.27, 0.02, 'final liq %');
near(c.rows[1].tp, 76180, 1e-9, 'E2 exits at E1');
near(c.sl, 25239.3 * (1 - 0.02618), 0.1, 'SL price');
assert.strictEqual(c.slEffective, true, 'SL effective at 3x');
near(c.slLoss, -96.9, 0.3, 'loss at SL ~ -96.9');
near(c.liqLoss, -100.18, 0.01, 'liq loss = margin + entry fees');

// 2) $1,000 ladder in % — must match the simulation ladder table
for (const [L, e3, liqF] of [[3, -33.40, -68.3], [5, -20.08, -45.8], [7, -14.37, -34.1]]) {
  const d = calcLadder({ capital: 1000, leverage: L, e1Price: 100, side: 'long' });
  assert.deepStrictEqual(d.rows.map(r => r.margin), [30, 60, 120, 240, 480, 70]);
  near(d.rows[2].distFromE1, e3, 0.01, `${L}x E3 %`);
  near(d.finalLiqDistFromE1, liqF, 0.05, `${L}x final liq %`);
}
// SL effectiveness matches the simulation: 3x yes, 5x right at liq (not effective), 7x not
assert.strictEqual(calcLadder({ capital: 1000, leverage: 5, e1Price: 100 }).slEffective, false);
assert.strictEqual(calcLadder({ capital: 1000, leverage: 7, e1Price: 100 }).slEffective, false);

// 3) Short is the exact mirror: entries above E1, liquidation above, TP below
const s = calcLadder({ capital: 100, leverage: 3, e1Price: 100, side: 'short' });
near(s.rows[1].price, 101.619, 1e-9, 'short E2 above E1');
assert.ok(s.rows.every((r, i) => i === 0 || r.price > s.rows[i - 1].price), 'short entries rise');
assert.ok(s.finalLiq > s.rows[s.rows.length - 1].price, 'short liq above last entry');
assert.ok(s.rows[0].tp < 100 && s.rows[0].profit > 0, 'short TP below E1 and positive');
assert.ok(s.rows.every(r => r.profit > 0), 'all short TPs profitable');

// 4) Leverage too high: E2 would sit beyond E1 liquidation -> ladder is capped and flagged
const h = calcLadder({ capital: 1000, leverage: 75, e1Price: 100 });
assert.ok(h.blocked && h.blocked.entry === 2 && h.rows.length === 1, 'blocked at E2 for 75x');

// 5) Every TP row is profitable (fees included) for the default ladder
for (const L of [2, 3, 5, 7, 10]) assert.ok(calcLadder({ capital: 1000, leverage: L, e1Price: 50 }).rows.every(r => r.profit > 0), `TPs profitable at ${L}x`);
console.log('all ladder tests passed');
