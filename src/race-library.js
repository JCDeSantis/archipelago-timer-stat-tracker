const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const { createHash, randomUUID } = require('crypto');
const { featurePreferences, raceAwards } = require('./race-features');
const { serverAddress } = require('./run-timer');

const normalized = value => String(value).normalize('NFKC').trim().toLocaleLowerCase('en-US');
const finiteTime = value => Number.isFinite(value) && value >= 0 ? value : null;
function text(value, max, label) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || /[\p{C}]/u.test(value)) throw new Error(`Invalid ${label}.`);
  return value.trim();
}
function recordId(state) {
  if (!state?.run || !Number.isFinite(state.run.startedAt)) return null;
  return createHash('sha256').update(JSON.stringify([state.seed, state.team, state.session, state.run.startedAt])).digest('hex');
}
function reviewChecks(state, players) {
  if(!Array.isArray(state.reviewChecks)) return undefined;
  const slots=new Map(players.map(p=>[p.slot,p])), checks=new Map();
  for(const c of state.reviewChecks.slice(0,100000)) {
    const p=slots.get(c?.slot);
    if(!p || !Number.isSafeInteger(c.location) || c.location<0 || !Number.isFinite(c.at) || c.at<state.run.startedAt || p.finishedAt!==null && c.at>p.finishedAt) continue;
    const key=`${c.slot}:${c.location}`;
    if(!checks.has(key) || checks.get(key).at>c.at) checks.set(key,{slot:c.slot,location:c.location,at:c.at});
  }
  return [...checks.values()];
}
function cleanSnapshot(state) {
  if (!state?.run || !Number.isFinite(state.run.startedAt) || state.run.startedAt <= 0 || typeof state.seed !== 'string' || !Number.isInteger(state.team) ||
    !Array.isArray(state.players) || !state.players.length || state.players.length > 1000 || new Set(state.players.map(p => p.slot)).size !== state.players.length) throw new Error('Invalid race record.');
  const players = state.players.map(p => {
    if (!Number.isInteger(p.slot) || p.slot < 1) throw new Error('Invalid runner slot.');
    const stats = p.stats || {};
    return { slot: p.slot, name: text(p.name, 256, 'runner name'), originalName: text(p.originalName || p.name, 256, 'original slot name'),
      checkProgress: p.checkProgress && Number.isSafeInteger(p.checkProgress.checked) && Number.isSafeInteger(p.checkProgress.total) && p.checkProgress.checked >= 0 && p.checkProgress.checked <= p.checkProgress.total ? {checked:p.checkProgress.checked,total:p.checkProgress.total} : null,
      hintsUsed: Number.isSafeInteger(p.hintsUsed) && p.hintsUsed >= 0 ? p.hintsUsed : null,
      game: text(p.game || 'Unknown game', 256, 'game'), completed: p.completed === true, released: p.released === true,
      stopped: p.completed === true || p.released === true, finishedAt: finiteTime(p.finishedAt), releasedAt: finiteTime(p.releasedAt),
      stats: { checksCompleted: Number.isSafeInteger(stats.checksCompleted) && stats.checksCompleted >= 0 ? stats.checksCompleted : null,
        elapsedMs: finiteTime(stats.elapsedMs), longestBKMs: finiteTime(stats.longestBKMs), recordedLongestBKMs: finiteTime(stats.recordedLongestBKMs), lastCheckAt: finiteTime(stats.lastCheckAt) } };
  });
  const allFinished = state.allFinished === true && players.every(p => p.stopped);
  return { schema: 1, seed: state.seed.slice(0, 512), team: state.team, session: text(state.session || 'main', 48, 'session'),
    run: { startedAt: state.run.startedAt, scheduledAt: finiteTime(state.run.scheduledAt), source: state.run.source || 'app', countdownSeconds: finiteTime(state.run.countdownSeconds) },
    observedThrough: finiteTime(state.serverNow ?? state.observedThrough),
    reviewChecks: reviewChecks(state,players),
    players, allFinished, groupFinishedAt: allFinished ? finiteTime(state.groupFinishedAt) : null,
    stats: { checksCompleted: Number.isSafeInteger(state.stats?.checksCompleted) && state.stats.checksCompleted >= 0 ? state.stats.checksCompleted : null,
      elapsedMs: allFinished ? finiteTime(state.stats?.elapsedMs) : null, longestBKMs: allFinished ? finiteTime(state.stats?.longestBKMs) : null },
    events: Array.isArray(state.events) ? state.events.slice(-5000).filter(e => e && typeof e.id === 'string' && typeof e.message === 'string').map(e => ({ id: e.id.slice(0, 160), type: String(e.type).slice(0, 32), at: finiteTime(e.at), slot: Number.isInteger(e.slot) ? e.slot : null, state: ['playing','waiting','break','gomode'].includes(e.state) ? e.state : undefined, message: e.message.slice(0, 2048) })) : [] };
}

class RaceLibrary {
  constructor(directory, { clock = () => Date.now() } = {}) {
    fs.mkdirSync(directory, { recursive: true });
    this.clock = clock; this.revision = 0; this.seen = new Set(); this.currentId = null;
    this.db = new DatabaseSync(path.join(directory, 'race-history.sqlite'));
    const version = this.db.prepare('PRAGMA user_version').get().user_version;
    if (version > 1) { this.db.close(); throw new Error('This race library needs a newer app version.'); }
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=3000;');
    if (!version) this.db.exec(`BEGIN;
      CREATE TABLE runs(id TEXT PRIMARY KEY, started REAL NOT NULL, updated REAL NOT NULL, excluded INTEGER NOT NULL DEFAULT 0, data TEXT NOT NULL);
      CREATE TABLE racers(id TEXT PRIMARY KEY, name TEXT NOT NULL, name_key TEXT NOT NULL UNIQUE);
      CREATE TABLE aliases(name_key TEXT NOT NULL, game TEXT NOT NULL, name TEXT NOT NULL, racer_id TEXT NOT NULL REFERENCES racers(id), PRIMARY KEY(name_key,game));
      CREATE TABLE assignments(run_id TEXT NOT NULL REFERENCES runs(id), slot INTEGER NOT NULL, racer_id TEXT NOT NULL REFERENCES racers(id), PRIMARY KEY(run_id,slot));
      CREATE TABLE profiles(id TEXT PRIMARY KEY, name TEXT NOT NULL, data TEXT NOT NULL);
      PRAGMA user_version=1; COMMIT;`);
  }
  row(id) { return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id); }
  get(id) {
    const row = this.row(id); if (!row) throw new Error('Race not found.');
    const data = JSON.parse(row.data);
    const quality = { uncertain: !!data.lateJoin || !!data.importedLegacy || data.gaps.length > 0,
      lateJoin: !!data.lateJoin, gaps: data.gaps, lastSeenAt: data.lastSeenAt };
    const record = { ...data, id, excluded: row.excluded === 1, quality };
    record.players = record.players.map(p => ({ ...p, identity: this.identityFor(p.originalName, p.game, id, p.slot) || this.identityFor(p.name, p.game) }));
    record.awards = raceAwards(record);
    return record;
  }
  put(id, data, excluded = false) {
    this.db.prepare('INSERT INTO runs(id,started,updated,excluded,data) VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET updated=excluded.updated,data=excluded.data')
      .run(id, data.run.startedAt, this.clock(), excluded ? 1 : 0, JSON.stringify(data));
    this.revision++;
  }
  observe(state) {
    const id = recordId(state), now = this.clock();
    if (!id) {
      if (this.currentId && state.connection !== 'connected') this.openGap(this.currentId, now);
      return;
    }
    if (!state.hydrated || state.connection !== 'connected') {
      if (this.row(id)) { this.currentId = id; this.openGap(id, now); }
      else if (this.currentId) this.openGap(this.currentId, now);
      return; // Do not overwrite good observations with partially hydrated data.
    }
    this.currentId = id;
    const oldRow = this.row(id), old = oldRow && JSON.parse(oldRow.data);
    if (oldRow?.excluded) return;
    const data = cleanSnapshot(state);
    Object.assign(data, { title: old?.title || state.session, gaps: old?.gaps || [], lateJoin: old?.lateJoin ?? state.serverNow > state.run.startedAt,
      importedLegacy: old?.importedLegacy || false, lastSeenAt: now });
    if(old) {
      data.events = [...new Map([...(old.events || []), ...data.events].map(e=>[e.id,e])).values()].slice(-5000);
      if(Array.isArray(data.reviewChecks) || Array.isArray(old.reviewChecks)) data.reviewChecks = [...new Map([...(old.reviewChecks || []), ...(data.reviewChecks || [])].map(c=>[`${c.slot}:${c.location}`,c])).values()].slice(0,100000);
    }
    data.resumeConnection = state.resumeConnection || old?.resumeConnection || null;
    for (const p of data.players) p.originalName = old?.players.find(q => q.slot === p.slot)?.originalName || p.originalName;
    if (old && !this.seen.has(id) && !old.allFinished && !data.gaps.some(g => g.to === null) && now > old.lastSeenAt + 2000) data.gaps.push({ from: old.lastSeenAt, to: now, kind: 'app-closed' });
    this.seen.add(id);
    const open = data.gaps.findLast(g => g.to === null);
    if (state.connection === 'connected' && state.hydrated && open) open.to = now;
    else if ((!state.hydrated || state.connection !== 'connected') && !data.allFinished && !open) data.gaps.push({ from: now, to: null, kind: 'connection' });
    this.put(id, data);
  }
  openGap(id, now) {
    const row = this.row(id); if (!row || row.excluded) return;
    const data = JSON.parse(row.data); if (data.allFinished || data.gaps.some(g => g.to === null)) return;
    data.gaps.push({ from: now, to: null, kind: 'connection' }); data.lastSeenAt = now; this.put(id, data);
  }
  setTracked(id, tracked) {
    if (typeof tracked !== 'boolean') throw new Error('Invalid tracking choice.');
    this.get(id);
    this.db.prepare('UPDATE runs SET excluded=? WHERE id=?').run(tracked ? 0 : 1, id); this.revision++;
    return this.get(id);
  }
  rename(id, title) { this.get(id); const r = JSON.parse(this.row(id).data); r.title = text(title, 100, 'race name'); this.put(id, r); return this.get(id); }
  list({ query = '', filter = 'tracked' } = {}) {
    if (typeof query !== 'string' || query.length > 512 || !['tracked', 'excluded', 'all', 'finished', 'unfinished'].includes(filter)) throw new Error('Invalid history search.');
    const q = normalized(query);
    return this.db.prepare('SELECT id FROM runs ORDER BY started DESC').all().map(row => this.get(row.id)).filter(r => {
      if (filter === 'excluded' ? !r.excluded : filter !== 'all' && r.excluded) return false;
      if (filter === 'finished' && !r.allFinished || filter === 'unfinished' && r.allFinished) return false;
      return !q || [r.title, r.seed, r.session, ...r.players.flatMap(p => [p.name, p.originalName, p.game, p.identity?.name || '', ...(p.identity?.aliases || []).map(a => a.name)])].some(s => normalized(s).includes(q));
    }).map(r => ({ id: r.id, title: r.title, startedAt: r.run.startedAt, allFinished: r.allFinished, excluded: r.excluded,
      groupTime: r.stats.elapsedMs, checks: r.stats.checksCompleted, uncertain: r.quality.uncertain,
      runners: r.players.map(p => ({ name: p.originalName, identity: p.identity?.name || null, game: p.game, completed: p.completed, released: p.released })) }));
  }
  racers() { return this.db.prepare('SELECT id,name FROM racers ORDER BY name_key').all().map(r => ({ ...r, aliases: this.db.prepare('SELECT name,game FROM aliases WHERE racer_id=? ORDER BY name_key').all(r.id) })); }
  createRacer(name) {
    name = text(name, 100, 'racer name'); const id = randomUUID();
    if (this.db.prepare('SELECT id FROM racers WHERE name_key=?').get(normalized(name))) throw new Error('A racer with that display name already exists.');
    this.db.prepare('INSERT INTO racers VALUES(?,?,?)').run(id, name, normalized(name)); this.revision++; return this.racers().find(r => r.id === id);
  }
  addAlias({ racerId, name, game = '*' }) {
    if (!this.racers().some(r => r.id === racerId)) throw new Error('Choose a racer.');
    name = text(name, 256, 'username'); game = text(game, 256, 'game scope');
    const old = this.db.prepare('SELECT racer_id FROM aliases WHERE name_key=? AND game=?').get(normalized(name), game);
    if (old && old.racer_id !== racerId) throw new Error('This username is linked to another racer in that game scope.');
    this.db.prepare('INSERT INTO aliases VALUES(?,?,?,?) ON CONFLICT(name_key,game) DO UPDATE SET racer_id=excluded.racer_id').run(normalized(name), game, name, racerId); this.revision++;
  }
  removeAlias({ racerId, name, game = '*' }) { this.db.prepare('DELETE FROM aliases WHERE racer_id=? AND name_key=? AND game=?').run(racerId, normalized(name), game); this.revision++; }
  identityFor(name, game, runId = null, slot = null) {
    const assigned = runId && this.db.prepare('SELECT racer_id FROM assignments WHERE run_id=? AND slot=?').get(runId, slot);
    const alias = assigned || this.db.prepare("SELECT racer_id FROM aliases WHERE name_key=? AND game IN (?, '*') ORDER BY CASE WHEN game=? THEN 0 ELSE 1 END LIMIT 1").get(normalized(name), game, game);
    if (!alias) return null;
    const racer = this.db.prepare('SELECT id,name FROM racers WHERE id=?').get(alias.racer_id);
    return racer ? { ...racer, aliases: this.db.prepare('SELECT name,game FROM aliases WHERE racer_id=?').all(racer.id) } : null;
  }
  assign({ runId, slot, racerId }) {
    if (!this.get(runId).players.some(p => p.slot === slot)) throw new Error('Runner not found in that race.');
    if (racerId === null) this.db.prepare('DELETE FROM assignments WHERE run_id=? AND slot=?').run(runId, slot);
    else {
      if (!this.racers().some(r => r.id === racerId)) throw new Error('Racer not found.');
      this.db.prepare('INSERT INTO assignments VALUES(?,?,?) ON CONFLICT(run_id,slot) DO UPDATE SET racer_id=excluded.racer_id').run(runId, slot, racerId);
    }
    this.revision++;
  }
  profiles() { return this.db.prepare('SELECT id,name,data FROM profiles ORDER BY name').all().map(p => ({ id: p.id, name: p.name, ...JSON.parse(p.data) })); }
  saveProfile(input) {
    const name = text(input?.name, 100, 'profile name');
    if (input.roster !== undefined && (!Array.isArray(input.roster) || input.roster.length > 1000)) throw new Error('Invalid profile roster.');
    const id = input.id || randomUUID();
    if (input.id && !this.profiles().some(p => p.id === input.id)) throw new Error('Profile not found.');
    const data = { address: serverAddress(text(input.address, 2048, 'room address')), slotName: text(input.slotName, 128, 'slot name'),
      countdown: [5, 10, 30, 60].includes(input.countdown) ? input.countdown : 10, requireReady: input.requireReady !== false,
      followRoomCountdown: input.followRoomCountdown !== false, alwaysOnTop: input.alwaysOnTop === true, timerOnly: input.timerOnly === true,
      roster: Array.isArray(input.roster) ? input.roster.slice(0, 1000).map(n => text(n, 256, 'roster username')) : [], features: featurePreferences(input.features) };
    this.db.prepare('INSERT INTO profiles VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,data=excluded.data').run(id, name, JSON.stringify(data)); this.revision++;
    return this.profiles().find(p => p.id === id);
  }
  deleteProfile(id) { this.db.prepare('DELETE FROM profiles WHERE id=?').run(id); this.revision++; }
  profileDraft(id) {
    const profile = this.profiles().find(p => p.id === id); if (!profile) throw new Error('Profile not found.');
    return { ...profile, session: `race-${this.clock().toString(36)}-${randomUUID().slice(0, 6)}` };
  }
  resolveRoster(names, players) {
    const slots = [], issues = [];
    for (const name of names) {
      const namedRacer = this.db.prepare('SELECT id FROM racers WHERE name_key=?').get(normalized(name));
      const matches = players.filter(p => normalized(p.originalName || p.name) === normalized(name) || normalized(p.name) === normalized(name) ||
        (namedRacer?.id && namedRacer.id === this.identityFor(p.originalName || p.name, p.game)?.id) ||
        (this.identityFor(name, p.game)?.id && this.identityFor(name, p.game)?.id === this.identityFor(p.originalName || p.name, p.game)?.id));
      if (matches.length === 1) slots.push(matches[0].slot); else issues.push(`${name}: ${matches.length ? 'ambiguous' : 'not found'}`);
    }
    return { slots: issues.length ? [] : [...new Set(slots)], issues };
  }
  exportRecord(id) { const r = this.get(id); delete r.resumeConnection; r.players = r.players.map(({ identity, ...p }) => p); return { type: 'archipelago-race-history', schema: 1, record: r }; }
  importRecord(input) {
    const own = input?.type === 'archipelago-race-history' && input.schema === 1;
    const raw = own ? input.record : input;
    if (!own && raw?.application !== 'Archipelago Timer and Stat Tracker') throw new Error('Choose a timer history file or statistics export.');
    const source = { ...raw, run: raw?.run || { startedAt: raw?.startedAt }, stats: raw?.stats || { elapsedMs: raw?.groupElapsedMs } };
    const data = cleanSnapshot(source), id = recordId(data), old = this.row(id);
    if (old) throw new Error('This run is already in history; import does not overwrite local tracking choices.');
    data.title = typeof raw.title === 'string' ? text(raw.title, 100, 'race name') : data.session;
    data.gaps = own && Array.isArray(raw.quality?.gaps) ? raw.quality.gaps.slice(0, 10000).filter(g => Number.isFinite(g.from) && (g.to === null || Number.isFinite(g.to) && g.to >= g.from)).map(g => ({ from: g.from, to: g.to, kind: 'imported' })) : [];
    data.lateJoin = own && raw.quality?.lateJoin === true; data.importedLegacy = !own || raw.importedLegacy === true || (raw.quality?.uncertain === true && !data.lateJoin && !data.gaps.length); data.lastSeenAt = this.clock();
    this.put(id, data, own && raw.excluded === true); return this.get(id);
  }
  close() { if (this.db) { this.db.close(); this.db = null; } }
}
module.exports = { RaceLibrary, recordId, cleanSnapshot, normalized };
