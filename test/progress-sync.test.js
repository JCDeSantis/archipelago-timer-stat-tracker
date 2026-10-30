const { test } = require('node:test');
const assert = require('node:assert/strict');
const { purchasedHints, worldSnapshot } = require('../src/progress-sync');

test('hint usage derives purchases from matching server checks and points, not the visible hint list', () => {
  assert.equal(purchasedHints({ checked: 40, total: 100, pointsPerCheck: 1, hintPercent: 10, hintPoints: 10 }), 3);
  assert.equal(purchasedHints({ checked: 3, total: 3, pointsPerCheck: 1, hintPercent: 5, hintPoints: 1 }), 2);
  assert.equal(purchasedHints({ checked: 2, total: 10, pointsPerCheck: 1, hintPercent: 100, hintPoints: -18 }), 2);
  assert.equal(purchasedHints({ checked: 40, total: 100, pointsPerCheck: 1, hintPercent: 10, hintPoints: 11 }), null, 'inconsistent data must not be rounded to a hint count');
  assert.equal(purchasedHints({ checked: 40, total: 100, pointsPerCheck: 1, hintPercent: 0, hintPoints: 40 }), null, 'free hints cannot be inferred');
  assert.equal(purchasedHints({ checked: 40, total: 100, pointsPerCheck: null, hintPercent: 10, hintPoints: 10 }), null);
  assert.equal(purchasedHints({ checked: 100, total: 100, pointsPerCheck: 10, hintPercent: 29, hintPoints: 188 }), 29, 'use the exact server pricing calculation at floating-point boundaries');
});
test('authoritative world snapshots deduplicate actual slot locations rather than using the game data package total', () => {
  const result = worldSnapshot([1, 1, 2], [3, 3]);
  assert.equal(result.total, 3); assert.equal(result.checked.size, 2);
  assert.equal(worldSnapshot([1, 'bad'], [2]), null);
  assert.equal(worldSnapshot([1], undefined), null);
});
