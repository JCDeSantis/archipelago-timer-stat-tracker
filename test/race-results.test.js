const { test } = require('node:test');
const assert = require('node:assert/strict');
const { raceResultLines } = require('../src/race-results');

function result(bk = 300000) {
  return { run: { startedAt: 1 }, allFinished: true, stats: { elapsedMs: 3600000, checksCompleted: 42 },
    players: [{ slot: 1, name: 'Runner', completed: true, released: false,
      stats: { elapsedMs: 3599000, checksCompleted: 42, longestBKMs: bk } }] };
}

test('shared results include group time, runner time, checks and the five-minute BK boundary', () => {
  assert.deepEqual(raceResultLines(result()), [
    '[Race results] Total Group Time: 01:00:00 | Group checks: 42',
    '[Race results] Runner (Completed) | Time: 00:59:59 | Checks: 42 | Longest BK: 00:05:00',
  ]);
  for (const bk of [0, 299999]) assert.match(raceResultLines(result(bk))[1], /Longest BK: N\/A$/);
  assert.match(raceResultLines(result(300001))[1], /Longest BK: 00:05:00$/);
});

test('unknown timing stays unavailable and release is distinguished from completion', () => {
  const state = result(null);
  state.stats.elapsedMs = null;
  Object.assign(state.players[0], { released: true, completed: false });
  state.players[0].stats.elapsedMs = null;
  assert.match(raceResultLines(state)[0], /Total Group Time: Unavailable/);
  assert.match(raceResultLines(state)[1], /\(Released\).*Time: Unavailable.*Longest BK: Unavailable$/);
  state.players[0].completed = true;
  assert.match(raceResultLines(state)[1], /\(Completed\)/);
});

test('results require a finished race and names cannot inject commands or unprintable lines', () => {
  const state = result();
  assert.throws(() => raceResultLines({ ...state, allFinished: false }), /once every/);
  assert.throws(() => raceResultLines({ ...state, run: null }), /once every/);
  state.players[0].name = '!release\n\u2028\u0000' + '🙂'.repeat(140);
  const lines = raceResultLines(state);
  for (const line of lines) {
    assert.ok(line.startsWith('[Race results]'));
    assert.ok(!/[\p{C}\p{Zl}\p{Zp}]/u.test(line));
    assert.ok(line.length < 500);
  }
});
