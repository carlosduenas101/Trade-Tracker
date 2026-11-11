// Unit tests for calcLadder (frontend/ladder.js). Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const { calcLadder } = require('../frontend/ladder.js');
const golden = require('./fixtures/ladder_golden.json'); // captured from the engine before customPrices existed

const base = { capital: 5000, e1Price: 100000 };
const modelPrices = (side, lev) => calcLadder({ ...base, leverage: lev, side }).rows.map(r => r.price);

for (const side of ['long', 'short']) {
  for (const lev of [3, 5, 7]) {
    const key = `${side}_${lev}x`;
    test(`(a) ${key}: no customPrices matches the pre-change output exactly`, () => {
      assert.deepStrictEqual(calcLadder({ ...base, leverage: lev, side }), golden[key]);
      assert.deepStrictEqual(calcLadder({ ...base, leverage: lev, side, customPrices: [] }), golden[key]);
      assert.deepStrictEqual(calcLadder({ ...base, leverage: lev, side, customPrices: [null, '', undefined, NaN] }), golden[key]);
    });
    test(`(b) ${key}: custom prices equal to the model prices give the same result`, () => {
      const r = calcLadder({ ...base, leverage: lev, side, customPrices: modelPrices(side, lev) });
      const { customEntries, ...rest } = r;
      assert.deepStrictEqual(rest, golden[key]);
      assert.deepStrictEqual(customEntries, [1, 2, 3, 4, 5, 6]);
    });
  }
}

test('blank slots fall back to the model price; custom E3 changes average and liquidation', () => {
  const m = calcLadder({ ...base, leverage: 3 });
  const r = calcLadder({ ...base, leverage: 3, customPrices: [null, null, 80000] });
  assert.equal(r.error, undefined);
  assert.equal(r.rows[0].price, m.rows[0].price);
  assert.equal(r.rows[1].price, m.rows[1].price);
  assert.equal(r.rows[2].price, 80000);
  assert.deepStrictEqual(r.customEntries, [3]);
  assert.notEqual(r.finalAvg, m.finalAvg);
  assert.notEqual(r.finalLiq, m.finalLiq);
  // E4 is still the model rule (1% above the liquidation after the custom E3)
  assert.ok(Math.abs(r.rows[3].price - r.rows[2].liq * 1.01) < 1e-9);
});

test('(c) price above the previous entry returns a structured error (long)', () => {
  const r = calcLadder({ ...base, leverage: 3, customPrices: [null, null, 99000] });
  assert.equal(r.error.entry, 3);
  assert.equal(r.error.code, 'not_beyond_previous');
  assert.equal(r.error.limit, golden.long_3x.rows[1].price);
  assert.equal(r.rows.length, 2);
});

test('(c) price equal to the previous entry is invalid', () => {
  const r = calcLadder({ ...base, leverage: 3, customPrices: [null, 98000, 98000] });
  assert.equal(r.error.entry, 3);
  assert.equal(r.error.code, 'not_beyond_previous');
});

test('(c) price at or below the liquidation returns a structured error (long)', () => {
  const liq2 = golden.long_3x.rows[1].liq;
  const r = calcLadder({ ...base, leverage: 3, customPrices: [null, null, liq2 - 1] });
  assert.equal(r.error.entry, 3);
  assert.equal(r.error.code, 'beyond_liquidation');
  assert.equal(r.error.limit, liq2);
  const edge = calcLadder({ ...base, leverage: 3, customPrices: [null, null, liq2] });
  assert.equal(edge.error.code, 'beyond_liquidation');
});

test('(c) a custom E2 above E1 is rejected, and non-positive prices never throw', () => {
  assert.equal(calcLadder({ ...base, leverage: 3, customPrices: [null, 100500] }).error.code, 'not_beyond_previous');
  assert.equal(calcLadder({ ...base, leverage: 3, customPrices: [null, -5] }).error.code, 'invalid_price');
});

test('(d) shorts: custom prices must rise and stay below liquidation', () => {
  const m = calcLadder({ ...base, leverage: 3, side: 'short' });
  const ok = calcLadder({ ...base, leverage: 3, side: 'short', customPrices: [null, null, 120000] });
  assert.equal(ok.error, undefined);
  assert.equal(ok.rows[2].price, 120000);
  assert.notEqual(ok.finalLiq, m.finalLiq);
  const below = calcLadder({ ...base, leverage: 3, side: 'short', customPrices: [null, null, 100500] });
  assert.equal(below.error.code, 'not_beyond_previous');
  assert.equal(below.error.limit, m.rows[1].price);
  const pastLiq = calcLadder({ ...base, leverage: 3, side: 'short', customPrices: [null, null, m.rows[1].liq + 1] });
  assert.equal(pastLiq.error.code, 'beyond_liquidation');
  assert.equal(pastLiq.error.limit, m.rows[1].liq);
});

test('custom E1 overrides e1Price and rescales nothing else', () => {
  const r = calcLadder({ ...base, leverage: 3, customPrices: [90000] });
  assert.equal(r.e1Price, 90000);
  assert.equal(r.rows[0].price, 90000);
  assert.ok(Math.abs(r.rows[1].price - 90000 * (1 - 0.01619)) < 1e-9);
});
