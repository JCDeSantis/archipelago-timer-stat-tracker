// Server-confirmed world totals are separate from timed observations. In
// particular, recovering a count must never invent a check or finish timestamp.
function purchasedHints({ checked, total, pointsPerCheck, hintPercent, hintPoints }) {
  if (![checked, total, pointsPerCheck, hintPoints].every(Number.isSafeInteger) ||
    checked < 0 || total < checked || pointsPerCheck < 0 || !Number.isFinite(hintPercent) || hintPercent <= 0 || hintPercent > 100) return null;
  // Match MultiServer.get_hint_cost's floating-point operation order exactly.
  const cost = Math.max(1, Math.floor(hintPercent * 0.01 * total));
  const spent = checked * pointsPerCheck - hintPoints;
  if (!Number.isSafeInteger(spent) || spent < 0 || spent % cost !== 0) return null;
  return spent / cost;
}

function worldSnapshot(checked, missing) {
  if (!Array.isArray(checked) || !Array.isArray(missing) || ![...checked, ...missing].every(Number.isSafeInteger)) return null;
  const checkedSet = new Set(checked);
  return { total: new Set([...checkedSet, ...missing]).size, checked: checkedSet };
}

module.exports = { purchasedHints, worldSnapshot };
