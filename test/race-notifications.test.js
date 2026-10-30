const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RaceNotifications } = require('../src/race-notifications');
const { featurePreferences } = require('../src/race-features');
function fixture() {
  const timer = { time: 1000000, now() { return this.time; }, changed() {}, hydrated: true, slot: 1, team: 0,
    run: { startedAt: 900000 }, players: [{ slot: 1, name: 'Link', game: 'Zelda' }, { slot: 2, name: 'Samus', game: 'Metroid' }],
    contexts: { 1: { state: 'waiting', runAt: 900000 } }, ownLocations: { total: 100 }, notificationPreferences: () => ({ sounds: { watchItems: ['Hookshot'] } }) };
  const events = new RaceNotifications(timer);
  events.receive({ cmd: 'DataPackage', data: { games: { Zelda: { item_name_to_id: { Hookshot: 123, Hammer: 124 } } } } });
  const item = (id = 123, location = id) => ({ cmd: 'PrintJSON', type: 'ItemSend', receiving: 1, item: { player: 2, location, item: id, flags: 1 } });
  return { timer, events, item, flush() { timer.time += 1400; return events.snapshot(); } };
}
test('watched items are private by default, duplicates are silent and progression does not change waiting or BK', () => {
  const f = fixture();
  f.events.receive(f.item()); f.events.receive(f.item());
  let result = f.flush(); assert.equal(result.filter(e => e.type === 'watch').length, 1);
  assert.equal(result[0].at, 1000000, 'item alerts retain receipt time through the batching delay');
  assert.equal(result[0].message, 'Samus found an item on your watchlist.');
  f.events.receive(f.item(124)); result = f.flush();
  assert.equal(result.filter(e => e.type === 'progression').length, 1);
  assert.equal(f.timer.contexts[1].state, 'waiting');
  assert.equal(f.timer.run.startedAt, 900000);
});
test('item bursts use one digest with watched counts, rather than individual alert sounds', () => {
  const f = fixture();
  for (let i = 0; i < 4; i++) f.events.receive(f.item(i ? 124 : 123, i));
  const result = f.flush(); assert.equal(result.length, 1); assert.equal(result[0].type, 'digest');
  assert.match(result[0].message, /4 items.*1 watched item/);
});
test('new hints and watched hint collection are deduplicated across hint storage and item events', () => {
  const f = fixture(), hint = { finding_player: 2, receiving_player: 1, location: 20, item: 123, found: false };
  f.events.observeHints([], false); f.events.observeHints([hint], true);
  f.events.receive(f.item(123, 20)); f.events.observeHints([{ ...hint, found: true }], true);
  assert.equal(f.events.snapshot().filter(e => e.type === 'hint').length, 1);
  assert.equal(f.events.snapshot().filter(e => e.type === 'hintfound').length, 1);
  const baseline = fixture(); baseline.events.observeHints([hint], false);
  assert.deepEqual(baseline.events.snapshot(), [], 'hydration never announces old hints');
});
test('hint affordability only alerts on confirmed threshold crossings and never for initial or free hints', () => {
  const f = fixture(); f.events.balance(20, 10); assert.equal(f.events.snapshot().length, 0);
  f.events.balance(0); f.events.balance(10);
  assert.equal(f.events.snapshot().filter(e => e.type === 'hintpoints').length, 1);
  f.events.balance(11); assert.equal(f.events.snapshot().length, 1);
  const free = fixture(); free.events.balance(0, 0); free.events.balance(100); assert.equal(free.events.snapshot().length, 0);
  const small = fixture(); small.timer.ownLocations.total = 3; small.events.balance(0, 5); small.events.balance(1);
  assert.equal(small.events.snapshot()[0].type, 'hintpoints', 'nonzero hint cost has the server minimum of one point');
});
test('retro defaults preserve existing selected sounds and notification item names are normalized', () => {
  const fresh = featurePreferences(); assert.equal(fresh.sounds.countdownId, 'retro-pulse'); assert.equal(fresh.sounds.goId, 'retro-fanfare');
  assert.equal(fresh.sounds.enabled, false);
  const existing = featurePreferences({ sounds: { countdownId: 'classic', goId: 'bell', watchItems: [' Hookshot ', '', 'Hookshot'] } });
  assert.equal(existing.sounds.goId, 'bell'); assert.deepEqual(existing.sounds.watchItems, ['Hookshot']);
});
