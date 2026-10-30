const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { RaceLibrary, recordId } = require('../src/race-library');
const { raceAwards, CountdownCues, featurePreferences, eventRule } = require('../src/race-features');
const { raceResultLines } = require('../src/race-results');
const { FeatureService } = require('../src/feature-service');
const { Settings } = require('../src/settings');

function sample(finished = false, start = 1800000000000) {
  return { seed: 'seed', team: 0, session: 'race', serverNow: start + 1000, connection: 'connected', hydrated: true,
    run: { startedAt: start, scheduledAt: start - 5000, source: 'app' },
    allFinished: finished, groupFinishedAt: finished ? start + 650000 : null,
    resumeConnection: { address: 'wss://example.test:38281/', name: 'Samus' },
    stats: { checksCompleted: 33, elapsedMs: finished ? 650000 : null, longestBKMs: finished ? 200000 : null }, events: [],
    players: [{ slot: 1, name: 'Samus', game: 'Super Metroid', completed: finished, released: false,
      finishedAt: finished ? start + 600000 : null, stats: { checksCompleted: 20, elapsedMs: finished ? 600000 : null, longestBKMs: finished ? 200000 : null } },
    { slot: 2, name: 'Link', game: 'A Link to the Past', completed: finished, released: false,
      finishedAt: finished ? start + 650000 : null, stats: { checksCompleted: 13, elapsedMs: finished ? 650000 : null, longestBKMs: finished ? 350000 : null } }] };
}
function library(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-library-'));
  let now = 1800000001000;
  const lib = new RaceLibrary(dir, { clock: () => now });
  t.after(() => { lib.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { lib, dir, advance: ms => { now += ms; } };
}

test('review history retains check timestamps and declared state metadata across updates and export', t => {
  const {lib}=library(t),s=sample();
  s.reviewChecks=[{slot:1,location:10,at:s.run.startedAt+500}];
  s.events=[{id:'go',slot:1,type:'context',state:'gomode',at:s.run.startedAt+900,message:'Go mode'}];
  lib.observe(s);
  lib.observe({...s,events:[],reviewChecks:[]});
  const r=lib.get(recordId(s));
  assert.equal(r.reviewChecks.length,1);assert.equal(r.events[0].state,'gomode');assert.equal(r.events[0].slot,1);
  assert.equal(lib.exportRecord(r.id).record.reviewChecks[0].at,s.run.startedAt+500);
  assert.equal(r.observedThrough,s.serverNow);
});
test('history persists updates without duplicate runs or connection secrets', t => {
  const { lib, dir } = library(t), s = sample();
  lib.observe({ ...s, password: 'DO-NOT-SAVE' });
  lib.observe(sample(true));
  assert.equal(lib.list().length, 1);
  const id = recordId(s);
  assert.equal(lib.get(id).allFinished, true);
  lib.close();
  lib.db = new (require('node:sqlite').DatabaseSync)(path.join(dir, 'race-history.sqlite'));
  assert.equal(lib.get(id).players[0].stats.elapsedMs, 600000);
  const exported = JSON.stringify(lib.exportRecord(id));
  assert.ok(!exported.includes('DO-NOT-SAVE'));
  assert.ok(!exported.includes('example.test'));
});
test('calling off an unfinished run freezes observations and excludes it until restored', t => {
  const { lib } = library(t), s = sample(), id = recordId(s);
  lib.observe(s); lib.setTracked(id, false); lib.observe(sample(true));
  assert.equal(lib.list().length, 0);
  assert.equal(lib.list({ filter: 'excluded' }).length, 1);
  assert.equal(lib.get(id).allFinished, false, 'called-off observation is not turned into a fabricated finish');
  assert.deepEqual(lib.get(id).awards, []);
  lib.setTracked(id, true); lib.observe(sample(true));
  assert.equal(lib.list().length, 1);
  assert.equal(lib.get(id).allFinished, true);
  lib.setTracked(id, false);
  assert.throws(() => raceResultLines(lib.get(id)), /Called-off/);
});
test('aliases unify search, retain original names, reject conflicts, and allow scoped/per-run assignments', t => {
  const { lib } = library(t), a = sample(true), b = sample(true, a.run.startedAt + 1000000);
  b.players[0].name = 'SpaceRiley';
  lib.observe(a); lib.observe(b);
  const riley = lib.createRacer('Riley'), alex = lib.createRacer('Alex');
  lib.addAlias({ racerId: riley.id, name: 'Samus', game: '*' });
  lib.addAlias({ racerId: riley.id, name: 'SpaceRiley', game: '*' });
  assert.equal(lib.list({ query: 'RILEY' }).length, 2);
  assert.equal(lib.list({ query: 'Samus' }).length, 2);
  assert.equal(lib.get(recordId(a)).players[0].originalName, 'Samus');
  assert.throws(() => lib.addAlias({ racerId: alex.id, name: 'Samus' }), /another racer/);
  lib.addAlias({ racerId: alex.id, name: 'Samus', game: 'A Link to the Past' });
  assert.equal(lib.identityFor('Samus', 'A Link to the Past').id, alex.id);
  lib.assign({ runId: recordId(a), slot: 1, racerId: alex.id });
  assert.equal(lib.get(recordId(a)).players[0].identity.id, alex.id);
  lib.assign({ runId: recordId(a), slot: 1, racerId: null });
  lib.removeAlias({ racerId: riley.id, name: 'Samus' });
  assert.equal(lib.get(recordId(a)).players[0].identity, null);
  assert.equal(lib.list({ filter: 'all' }).length, 2, 'unlinking never deletes races');
});
test('connection gaps and app restarts remain marked after recovery; unknown finishes stay unknown', t => {
  const { lib, dir, advance } = library(t), s = sample(), id = recordId(s);
  lib.observe(s); advance(1000); lib.observe({ ...s, connection: 'reconnecting', hydrated: false });
  advance(5000); lib.observe(s);
  assert.equal(lib.get(id).quality.gaps.length, 1);
  assert.equal(lib.get(id).quality.gaps[0].to - lib.get(id).quality.gaps[0].from, 5000);
  lib.close(); advance(8000);
  const restored = new RaceLibrary(dir, { clock: () => 1800000020000 });
  restored.observe(s);
  assert.ok(restored.get(id).quality.uncertain);
  assert.equal(restored.get(id).quality.gaps.length, 2);
  const unknown = sample(true); unknown.stats.elapsedMs = null; unknown.groupFinishedAt = null;
  unknown.players[0].stats.elapsedMs = null; unknown.players[0].stats.longestBKMs = null; unknown.players[0].finishedAt = null;
  restored.observe(unknown);
  assert.equal(restored.get(id).players[0].stats.elapsedMs, null);
  assert.equal(restored.get(id).stats.elapsedMs, null); restored.close();
});
test('profiles are whitelisted, have fresh sessions and block missing/ambiguous roster matches', t => {
  const { lib } = library(t);
  const p = lib.saveProfile({ name: 'Weekend', address: 'example.test:38281', slotName: 'Samus', password: 'PRIVATE', roster: ['Samus'], features: { password: 'PRIVATE' } });
  assert.ok(!JSON.stringify(p).includes('PRIVATE'));
  assert.notEqual(lib.profileDraft(p.id).session, lib.profileDraft(p.id).session);
  assert.deepEqual(lib.resolveRoster(['Samus'], sample().players).slots, [1]);
  const riley = lib.createRacer('Riley'); lib.addAlias({ racerId: riley.id, name: 'Samus' });
  assert.deepEqual(lib.resolveRoster(['Riley'], sample().players).slots, [1], 'profile display names resolve through explicitly linked usernames');
  assert.deepEqual(lib.resolveRoster(['missing'], sample().players).slots, []);
  assert.equal(lib.resolveRoster(['Samus'], [...sample().players, { slot: 3, name: 'Samus', game: 'Another' }]).issues.length, 1);
  assert.throws(() => lib.saveProfile({ ...p, address: 'ws://user:pass@example.test' }), /embedded credentials/);
  lib.deleteProfile(p.id); assert.equal(lib.profiles().length, 0);
});
test('history import preserves exclusions and missing-data warnings; duplicate import cannot overwrite local choices', t => {
  const { lib } = library(t), s = sample(true); lib.observe(s); lib.setTracked(recordId(s), false);
  const exported = lib.exportRecord(recordId(s));
  const secondDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-import-')); const other = new RaceLibrary(secondDir);
  try {
    const imported = other.importRecord(exported); assert.equal(imported.excluded, true); assert.equal(other.list().length, 0);
    assert.throws(() => other.importRecord(exported), /already in history/);
    const legacy = sample(true, s.run.startedAt + 1000000);
    legacy.application = 'Archipelago Timer and Stat Tracker'; legacy.startedAt = legacy.run.startedAt; delete legacy.run;
    const old = other.importRecord(legacy); assert.equal(old.quality.uncertain, true);
    assert.equal(other.exportRecord(old.id).record.importedLegacy, true);
  } finally { other.close(); fs.rmSync(secondDir, { recursive: true, force: true }); }
});
test('awards use displayed precision for ties, exclude releases, and withhold uncertain check/BK awards', () => {
  const r = sample(true); r.players[1].stats.elapsedMs = 600500;
  assert.equal(raceAwards(r)[0].winners.length, 2);
  r.quality = { uncertain: true };
  assert.equal(raceAwards(r)[0].winners.length, 2); assert.equal(raceAwards(r)[1].winners.length, 0);
  r.players[1].completed = false; r.players[1].released = true;
  assert.ok(raceAwards(r).every(a => !a.winners.length));
  r.excluded = true; assert.deepEqual(raceAwards(r), []);
});
test('alert preferences separate sounds from popups and never enable personal BK reminders', () => {
  const prefs = featurePreferences({ alerts: { scope: 'self', categories: { goal: { popup: false, sound: true } } } });
  assert.equal(eventRule({ id: 'goal:1', type: 'goal' }, prefs, 1).sound, true);
  assert.equal(eventRule({ id: 'goal:2', type: 'goal' }, prefs, 1).sound, false);
  assert.equal(eventRule({ id: 'bk:1:0', type: 'bk', slot: 1 }, prefs, 1).popup, false);
  assert.equal(featurePreferences().sounds.enabled, false);
});
test('countdown cues follow shared boundaries once, skip missed cues, and never replay after reconnect or mute', () => {
  const c = new CountdownCues(), input = { context: 'run', ready: true, startedAt: 10000, enabled: true };
  assert.deepEqual(c.update({ ...input, now: 6000 }), []);
  assert.deepEqual(c.update({ ...input, now: 7000 }), [3]);
  assert.deepEqual(c.update({ ...input, now: 7100 }), []);
  assert.deepEqual(c.update({ ...input, now: 8000, enabled: false }), []);
  assert.deepEqual(c.update({ ...input, now: 9000 }), [1]);
  assert.deepEqual(c.update({ ...input, now: 10000 }), [0]);
  assert.deepEqual(c.update({ ...input, now: 10050 }), []);
  assert.deepEqual(c.update({ ...input, ready: false, now: 11000 }), []);
  assert.deepEqual(c.update({ ...input, now: 12000 }), []);
  const late = new CountdownCues(); late.update({ ...input, now: 6000 });
  assert.deepEqual(late.update({ ...input, now: 8500 }), [], 'sleep/clock jumps do not replay stale tones');
});
test('preview tokens copy exact reviewed text offline, reject stale/mismatched posts and protect called-off runs', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-service-')); const settings = new Settings(dir);
  let state = sample(true); const copies = [], posts = [];
  const timer = { snapshot: () => structuredClone(state), postResults: options => posts.push(raceResultLines(state, options)), options: { address: 'ws://example.test:38281/', name: 'Samus' } };
  const service = new FeatureService({ directory: dir, settings, timer, getWindow: () => null, desktop: { clipboard: { writeText: text => copies.push(text) } } });
  t.after(() => { settings.flush(); service.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  service.observe(state);
  const { preview } = await service.handle('preview-results', { options: { checks: false, bk: true, awards: true } });
  assert.ok(!preview.text.includes(' | Checks:'));
  state.connection = 'disconnected';
  await service.handle('copy-preview', { token: preview.token }); assert.equal(copies[0], preview.text);
  state.connection = 'connected'; state.players[0].stats.checksCompleted++;
  // Hidden check columns do not affect this preview's reviewed text.
  await service.handle('post-preview', { token: preview.token }); assert.equal(posts.length, 1);
  const next = await service.handle('preview-results', {});
  state.players[0].stats.checksCompleted++;
  await assert.rejects(service.handle('post-preview', { token: next.preview.token }), /Results changed/);
  state.session = 'another'; await assert.rejects(service.handle('post-preview', { token: next.preview.token }), /original room/);
  state.session = 'race'; service.library.setTracked(preview.id, false);
  await assert.rejects(service.handle('copy-preview', { token: preview.token }), /called off/);
  const restored = await service.handle('history-track', { id: preview.id, tracked: true });
  assert.equal(restored.record.players[0].stats.checksCompleted, state.players[0].stats.checksCompleted, 'restoring the current run immediately reconciles its latest observations');
});
