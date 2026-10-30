// Archipelago observer: never sends gameplay StatusUpdate or LocationChecks packets.
const { EventEmitter } = require('events');
const { createHash, randomUUID } = require('crypto');
const WebSocket = require('ws');
const { raceResultLines } = require('./race-results');
const { purchasedHints, worldSnapshot } = require('./progress-sync');
const { RoomProgress, trackerSource } = require('./room-progress');
const { RaceNotifications, contextLabels, clean, clock: eventClock } = require('./race-notifications');

function serverAddress(value) {
  if (typeof value !== 'string' || !value.trim() || value.length > 2048) throw new Error('Enter an Archipelago server address.');
  const explicit = /^wss?:\/\//i.test(value.trim());
  if (!explicit && /^[a-z][a-z\d+.-]*:\/\//i.test(value.trim())) throw new Error('Use a ws:// or wss:// server address.');
  const url = new URL(explicit ? value.trim() : `ws://${value.trim()}`);
  if (!['ws:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Use a ws:// or wss:// server address without embedded credentials.');
  if (!explicit && (url.hostname.toLowerCase() === 'archipelago.gg' || url.hostname.toLowerCase().endsWith('.archipelago.gg'))) url.protocol = 'wss:';
  if (!explicit && !url.port) url.port = '38281';
  return url.href;
}

function sessionName(value) {
  if (typeof value !== 'string' || !/^[\w -]{1,48}$/.test(value.trim())) throw new Error('Use 1–48 letters, numbers, spaces, dashes or underscores for the session.');
  return value.trim().toLowerCase();
}

function roomCountdownSeconds(packet, team) {
  if (packet?.cmd !== 'PrintJSON' || ![undefined, null, 'Countdown', 'ServerChat'].includes(packet.type) ||
    (packet.team !== undefined && packet.team !== team)) return null;
  if (packet.type === 'Countdown' && Object.hasOwn(packet, 'countdown')) {
    return Number.isInteger(packet.countdown) && packet.countdown >= 0 && packet.countdown <= 3600 ? packet.countdown : null;
  }
  let text = typeof packet.message === 'string' ? packet.message : '';
  if (Array.isArray(packet.data)) {
    if (!packet.data.every(part => typeof part?.text === 'string' && (part.type === undefined || part.type === 'text'))) return null;
    text = packet.data.map(part => part.text).join('');
  }
  if (text.length > 256) return null;
  text = text.trim();
  if (packet.type == null && !/^\[Server\]:/i.test(text)) return null;
  const match = /^(?:\[Server\]:\s*)?Starting countdown of ([1-9]\d{0,3})s[.!]?$/i.exec(text);
  const seconds = match ? Number(match[1]) : null;
  return seconds !== null && seconds <= 3600 ? seconds : null;
}

function checkStats(checks, startedAt, finishedAt) {
  const times = Object.values(checks).filter(time => Number.isFinite(time) && time >= startedAt &&
    (finishedAt === null || time <= finishedAt)).sort((a, b) => a - b);
  let previous = startedAt;
  let longest = 0;
  for (const time of times) { longest = Math.max(longest, time - previous); previous = time; }
  if (finishedAt !== null) longest = Math.max(longest, finishedAt - previous);
  return { checksCompleted: times.length, elapsedMs: finishedAt === null ? null : Math.max(0, finishedAt - startedAt),
    longestBKMs: finishedAt === null ? null : longest,
    recordedLongestBKMs: longest, lastCheckAt: previous };
}

class RunTimer extends EventEmitter {
  constructor({ Socket = WebSocket, clock = () => performance.now(), saveSolo = () => {}, solo = null, followRoomCountdown = true, resolveRoster = null, notificationPreferences = null, progressFetch = globalThis.fetch } = {}) {
    super();
    this.notificationPreferences = notificationPreferences;
    this.contexts = {};
    this.notifications = new RaceNotifications(this);
    this.roomProgress = new RoomProgress(this, { fetch: progressFetch });
    this.Socket = Socket;
    this.clock = clock;
    this.anchor = { server: Date.now(), local: clock() };
    this.saveSolo = saveSolo;
    this.solo = solo && Number.isFinite(solo.startedAt) && (solo.finishedAt === null || Number.isFinite(solo.finishedAt)) ? solo : null;
    this.uuid = randomUUID();
    this.connection = 'disconnected';
    this.message = 'Connect to an Archipelago room to share a timer.';
    this.players = [];
    this.statuses = {};
    this.finishes = {};
    this.releases = {};
    this.checks = {};
    this.readies = {};
    this.locations = {};
    this.halfChecks = {};
    this.goalTimes = {};
    this.ownReady = null;
    this.pendingStart = null;
    this.followRoomCountdown = followRoomCountdown !== false;
    this.selectedSlots = null;
    this.pendingCountdown = null;
    this.countdownScheduled = false;
    this.run = null;
    this.hydrated = false;
    this.pendingGoals = new Map();
    this.resolveRoster = resolveRoster;
    this.lastPacketAt = null;
    this.lastPongAt = null;
    this.hintsUsed = null; this.pointsPerCheck = null; this.hintPercent = null;
    this.progressSyncAt = null; this.progressRequestAt = null; this.progressPending = false;
  }

  connectPacket() {
    return { cmd: 'Connect', name: this.options.name, password: this.options.password,
      game: '', uuid: this.uuid, version: { major: 0, minor: 5, build: 0, class: 'Version' },
      tags: ['Tracker', 'AP-TimerStatTracker'], items_handling: 0, slot_data: false };
  }
  progressKeys() {
    return [this.key, this.hintKey(), ...this.players.flatMap(p => [this.statusKey(p.slot), this.keyFor(p.slot), this.releaseKey(p.slot), this.goalKey(p.slot), this.checksKey(p.slot), this.locationsKey(p.slot)])];
  }
  syncProgress() {
    if (this.connection !== 'connected' || !this.hydrated) throw new Error('Connect before syncing progress.');
    if (this.progressPending) return;
    // Re-authenticating the same observer on the same socket obtains a complete
    // Connected snapshot; AP Sync only replays received items, not world checks.
    this.progressPending = true; this.progressRequestAt = this.now();
    this.send(this.connectPacket(), { cmd: 'Get', keys: this.progressKeys(), timerProgressSync: true });
    void this.roomProgress.refresh();
    this.changed();
  }
  setTrackerSource(value) {
    if (!this.options) throw new Error('Connect before changing the tracker source here.');
    this.options.trackerUrl = trackerSource(value)?.url || '';
    this.roomProgress.reset();
    if (this.connection === 'connected' && this.hydrated) void this.roomProgress.refresh();
    this.changed();
  }
  pollRoom() {
    if (!this.alive) return this.socket?.terminate();
    this.alive = false; this.socket.ping();
    if (!this.run && this.ownReady?.ready) this.publishReady();
    this.send({ cmd: 'Get', keys: this.players.map(p => this.statusKey(p.slot)) });
    if (this.progressPending && this.now() - this.progressRequestAt >= 30000) this.progressPending = false;
    if (!this.progressPending && this.now() - this.progressRequestAt >= 60000) this.syncProgress();
  }
  updateHintUsage(packet) {
    if (Number.isSafeInteger(packet.location_check_points) && packet.location_check_points >= 0) this.pointsPerCheck = packet.location_check_points;
    if (Number.isFinite(packet.hint_cost) && packet.hint_cost >= 0 && packet.hint_cost <= 100) this.hintPercent = packet.hint_cost;
    if (Number.isSafeInteger(packet.hint_points) && this.ownLocations) this.hintsUsed = purchasedHints({ checked: this.ownLocations.checked.size,
      total: this.ownLocations.total, pointsPerCheck: this.pointsPerCheck, hintPercent: this.hintPercent, hintPoints: packet.hint_points });
  }
  refreshOwnProgress(packet) {
    const snapshot = worldSnapshot(packet.checked_locations, packet.missing_locations);
    if (!snapshot) return false;
    if (this.ownLocations) {
      const missed=[...snapshot.checked].filter(id=>!this.ownLocations.checked.has(id) && !Object.hasOwn(this.checks[this.slot] || {},id));
      if(missed.length) this.roomProgress.explain([{slot:this.slot,count:missed.length}],'Server snapshot');
    }
    this.ownLocations = snapshot; this.hintsUsed = null; this.updateHintUsage(packet);
    this.progressSyncAt = this.now();
    return true;
  }
  now() { return this.anchor.server + this.clock() - this.anchor.local; }
  keyFor(slot) { return `${this.key}:finish:${slot}`; }
  statusKey(slot) { return `_read_client_status_${this.team}_${slot}`; }
  releaseKey(slot) { return `${this.roomKey}:release:${slot}`; }
  checksKey(slot) { return `${this.key}:checks:${slot}`; }
  contextKey(slot) { return `${this.key}:context:${slot}`; }
  hintKey() { return `_read_hints_${this.team}_${this.slot}`; }
  setContext(input) {
    if (!this.hydrated || this.connection !== 'connected' || !Object.hasOwn(contextLabels, input?.state || '')) throw new Error('Connect before setting your runner status.');
    if (this.statuses[this.slot] === 30 || this.releases[this.slot] != null) throw new Error('This runner has already finished or released.');
    const value = { state: input.state, detail: input.state === 'waiting' ? clean(input.detail) : '', at: this.now(), runAt: this.run?.startedAt ?? null, id: randomUUID() };
    this.send({ cmd: 'Set', key: this.contextKey(this.slot), default: null, want_reply: true, operations: [{ operation: 'replace', value }] });
  }
  readyKey(slot) { return `${this.key}:ready:${slot}`; }
  locationsKey(slot) { return `${this.roomKey}:locations:${slot}`; }
  halfKey(slot) { return `${this.key}:half:${slot}`; }
  goalKey(slot) { return `${this.roomKey}:goal:${slot}`; }

  select(slots) {
    if (this.run || this.countdownScheduled) throw new Error('The race roster is already locked.');
    if (!Array.isArray(slots) || new Set(slots).size !== slots.length || !slots.every(slot => this.players.some(p => p.slot === slot))) throw new Error('Invalid player selection.');
    this.selectedSlots = [...slots];
  }

  followCountdown(value) {
    if (typeof value !== 'boolean') throw new Error('Invalid room countdown setting.');
    this.followRoomCountdown = value;
    if (!value) this.pendingCountdown = null;
    this.changed();
  }

  observeCountdown(seconds) {
    if (seconds <= 0 || !this.followRoomCountdown || this.run || this.countdownScheduled || this.team == null || !this.players.length) return;
    // Keep the original receipt time through hydration and the repeated first tick.
    this.pendingCountdown ||= { seconds, receivedAt: this.now(), slots: this.selectedSlots === null ? null : [...this.selectedSlots] };
    this.applyCountdown();
  }

  applyCountdown() {
    if (this.run) { this.pendingCountdown = null; return; }
    if (!this.followRoomCountdown || !this.hydrated || !this.pendingCountdown || this.countdownScheduled) return;
    const { seconds, receivedAt, slots } = this.pendingCountdown;
    const players = this.players.filter(p => (slots === null || slots.includes(p.slot)) && this.statuses[p.slot] != null &&
      this.statuses[p.slot] !== 30 && this.releases[p.slot] == null);
    if (!players.length) {
      this.pendingCountdown = null;
      this.message = 'Room countdown detected, but no eligible runners are selected.';
      this.changed();
      return;
    }
    this.pendingStart = null;
    this.countdownScheduled = true;
    const run = { schema: 1, seed: this.seed, team: this.team, scheduledAt: receivedAt,
      startedAt: receivedAt + seconds * 1000, requireReady: false, source: 'archipelago-countdown', countdownSeconds: seconds,
      players, createdBy: this.slot };
    this.writeRun(run);
    this.message = `Following Archipelago's ${seconds}-second room countdown for the selected runners.`;
    this.changed();
  }

  isReady(slot, slots, now = this.now()) {
    const ready = this.readies[slot];
    return ready?.ready === true && ready.expiresAt > now &&
      JSON.stringify(ready.roster) === JSON.stringify([...slots].sort((a, b) => a - b));
  }

  ready(slots, value) {
    if (this.connection !== 'connected' || !this.hydrated || this.run) throw new Error('Ready checks are available before the race starts.');
    this.validateSlots(slots);
    if (!slots.includes(this.slot) || typeof value !== 'boolean') throw new Error('Select your own player to mark yourself ready.');
    this.ownReady = { ready: value, roster: [...slots].sort((a, b) => a - b), client: this.uuid, confirmedAt: this.now() };
    this.publishReady();
  }

  publishReady() {
    if (!this.ownReady) return;
    const value = { ...this.ownReady, at: this.now(), expiresAt: this.now() + 45000 };
    this.send({ cmd: 'Set', key: this.readyKey(this.slot), default: null, want_reply: true,
      operations: [{ operation: 'replace', value }] });
  }

  publishLocations() {
    if (!this.ownLocations) return;
    const value = { total: this.ownLocations.total, checked: [...this.ownLocations.checked], hintsUsed: this.hintsUsed, syncedAt: this.progressSyncAt ?? this.now() };
    this.send({ cmd: 'Set', key: this.locationsKey(this.slot), default: null, want_reply: true,
      operations: [{ operation: 'replace', value }] });
  }

  observeHalf(slot) {
    if (!this.hydrated || !this.run || this.now() < this.run.startedAt || this.halfChecks[slot] != null ||
      this.statuses[slot] === 30 || this.releases[slot] != null || !this.run.players.some(p => p.slot === slot)) return;
    const info = this.locations[slot];
    if (!info || info.total <= 0) return;
    const checked = new Set([...info.checked, ...Object.keys(this.checks[slot] || {}).map(Number)]);
    if (checked.size <= info.total / 2) return;
    const time = this.halfChecks[slot] = this.now();
    this.send({ cmd: 'Set', key: this.halfKey(slot), default: time, want_reply: true,
      operations: [{ operation: 'min', value: time }] });
  }
  send(...packets) {
    if (!this.socket || this.socket.readyState !== 1) throw new Error('The timer is not connected.');
    this.socket.send(JSON.stringify(packets));
  }
  changed() { this.emit('change', this.snapshot()); }

  postResults(options = {}) {
    const lines = raceResultLines(this.snapshot(), options);
    if (this.connection !== 'connected' || !this.hydrated) throw new Error('Connect to the Archipelago room before posting results.');
    const key = `${this.key}:${this.run.startedAt}`;
    if (this.postedResultsFor === key) throw new Error('These results have already been posted from this app.');
    this.send(...lines.map(text => ({ cmd: 'Say', text })));
    this.postedResultsFor = key;
    this.changed();
  }

  snapshot() {
    const roster = this.run ? this.run.players : this.players;
    const players = roster.map(p => {
      const releasedAt = this.releases[p.slot] ?? null;
      const finishedAt = this.finishes[p.slot] ??
        (this.run && releasedAt >= this.run.startedAt ? releasedAt : null);
      const completed = this.statuses[p.slot] === 30 || (finishedAt !== null && releasedAt === null);
      const stats = this.run ? checkStats(this.checks[p.slot] || {}, this.run.startedAt, finishedAt) : null;
      const info = this.locations[p.slot];
      const external = this.roomProgress.progress(p, info, this.checks[p.slot]);
      const checkedCount = info ? Math.min(info.total, new Set([...info.checked, ...Object.keys(this.checks[p.slot] || {}).map(Number)]).size) : null;
      return { ...p, runnerContext: this.contexts[p.slot] && (this.contexts[p.slot].runAt === null || this.contexts[p.slot].runAt === this.run?.startedAt) ? this.contexts[p.slot] : null, originalName: p.originalName || this.players.find(q => q.slot === p.slot)?.originalName || p.name, status: this.statuses[p.slot] ?? null, finishedAt, releasedAt, stats,
        checkProgress: external || (info ? { checked: checkedCount, total: info.total, syncedAt: info.syncedAt ?? null } : null), hintsUsed: Number.isSafeInteger(info?.hintsUsed) ? info.hintsUsed : null,
        completed, released: releasedAt !== null, stopped: completed || releasedAt !== null };
    });
    const allFinished = !!this.run && players.length > 0 && players.every(p => p.stopped);
    const known = allFinished && players.every(p => p.finishedAt !== null);
    const groupFinishedAt = known ? Math.max(...players.map(p => p.finishedAt)) : null;
    const groupChecks = Object.fromEntries(players.flatMap(p => Object.entries(this.checks[p.slot] || {})
      .filter(([, time]) => p.finishedAt === null || time <= p.finishedAt).map(([location, time]) => [`${p.slot}:${location}`, time])));
    const events = [...this.notifications.snapshot(), ...this.roomProgress.recoveries];
    const add = (id, type, at, message) => events.push({ id, type, at, message, slot: /^\w+:(\d+)/.test(id) ? Number(id.split(':')[1]) : null, ...(type === 'first' ? { notBefore: at + 1500 } : {}) });
    if (!this.run) for (const p of players) {
      const ready = this.readies[p.slot];
      if (ready?.ready && ready.expiresAt > this.now()) add(`ready:${p.slot}:${ready.confirmedAt ?? ready.at}`, 'ready', ready.confirmedAt ?? ready.at, `${p.name} is ready for their selected roster.`);
    }
    if (this.run) {
      add('start', 'start', this.run.startedAt, this.run.source === 'archipelago-countdown' ? 'The race has started from the Archipelago room countdown.' : 'The race has started.');
      for (const p of players) {
        if (p.completed) {
          const at = this.goalTimes[p.slot] ?? (p.released ? null : p.finishedAt);
          const stopped = players.filter(q => q.stopped && (at === null || (q.finishedAt ?? this.goalTimes[q.slot] ?? -Infinity) <= at));
          const completed = stopped.filter(q => q.completed).length;
          const released = stopped.filter(q => q.released && !q.completed).length;
          add(`goal:${p.slot}`, 'goal', at, `${p.name} completed their run. ${completed} completed, ${released} released; ${players.length - stopped.length} remain active.`);
        }
        if (p.released) add(`release:${p.slot}`, 'release', p.releasedAt, p.completed ? `${p.name} released their remaining items.` : `${p.name} released their run.`);
        if (this.halfChecks[p.slot] != null) add(`half:${p.slot}`, 'half', this.halfChecks[p.slot], `${p.name} has completed over half of their checks.`);
        const times = Object.values(this.checks[p.slot] || {}).filter(time => time >= this.run.startedAt && (p.finishedAt === null || time <= p.finishedAt)).sort((a, b) => a - b);
        for (const count of [1, 10, 25, 50, 100, 250, 500]) if (times.length >= count) {
          add(`checks:${p.slot}:${count}`, count === 1 ? 'first' : 'checks', times[count - 1], count === 1 ? `${p.name} completed their first recorded race check.` : `${p.name} reached ${count} recorded race checks.`);
        }
      }
      const bulkTimes = players.filter(p => p.releasedAt !== null).map(p => p.releasedAt);
      for (const p of players) {
        const times = Object.values(this.checks[p.slot] || {}).filter(at => at >= this.run.startedAt && (p.finishedAt === null || at <= p.finishedAt)).sort((a, b) => a - b);
        let previous = this.run.startedAt;
        for (const at of times) {
          if (at - previous >= 300000 && !bulkTimes.some(t => Math.abs(t - at) < 5000)) events.push({ id: `recovery:${p.slot}:${at}`, type: 'recovery', slot: p.slot, at, notBefore: at + 1500, message: `${p.name} checked again after ${eventClock(at - previous)} without a check.` });
          previous = at;
        }
      }
      let previousGroupCheck = this.run.startedAt;
      for (const at of [...new Set(Object.values(groupChecks))].filter(at => at >= this.run.startedAt).sort((a, b) => a - b)) {
        if (at - previousGroupCheck >= 600000 && !bulkTimes.some(t => Math.abs(t - at) < 5000)) events.push({ id: `activity:${at}`, type: 'activity', at, notBefore: at + 1500, message: 'Group checks resumed after a quiet period.' });
        previousGroupCheck = at;
      }
      if (allFinished) add('finished', 'finish', groupFinishedAt, 'Everyone has finished the race.');
    }
    const runnerBKs = this.run ? players.filter(p => !p.stopped).map(p => ({
      slot: p.slot, name: p.name, context: p.runnerContext,
      since: Object.values(this.checks[p.slot] || {}).reduce((latest, time) => time <= this.now() ? Math.max(latest, time) : latest, this.run.startedAt),
    })) : [];
    const ownBK = runnerBKs.find(p => p.slot === this.slot);
    const bk = ownBK ? { since: ownBK.since, thresholdMs: 300000 } : null;
    return {
      connection: this.connection, message: this.message, hydrated: this.hydrated,
      serverNow: this.now(), seed: this.seed || '', team: this.team ?? null,
      address: this.options?.address || '', trackerUrl: this.options?.trackerUrl || '', session: this.options?.session || 'main',
      slot: this.slot ?? null, players, run: this.run,
      selectedSlots: this.selectedSlots, health: { lastPacketAt: this.lastPacketAt, lastPongAt: this.lastPongAt, reconnectAttempt: this.reconnectAttempt || 0, progressSyncAt: this.progressSyncAt, progressPending: this.progressPending, roomCounts: this.roomProgress.health() },
      readies: this.readies, startPending: !!this.pendingStart || this.countdownScheduled, followRoomCountdown: this.followRoomCountdown, events, bk, runnerBKs,
      allFinished, groupFinishedAt, resultsPosted: !!this.run && this.postedResultsFor === `${this.key}:${this.run.startedAt}`,
      stats: this.run ? checkStats(groupChecks, this.run.startedAt, groupFinishedAt) : null,
      reviewChecks: this.run ? Object.entries(this.checks).flatMap(([slot, checks]) => Object.entries(checks).map(([location, at]) => ({slot:Number(slot),location:Number(location),at}))) : [],
      solo: this.solo,
    };
  }

  connect(input) {
    if (!input || typeof input !== 'object') throw new Error('Enter connection details.');
    const address = serverAddress(input.address);
    const session = sessionName(input.session || 'main');
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name || name.length > 128) throw new Error('Enter your original Archipelago slot name.');
    if (input.password != null && (typeof input.password !== 'string' || input.password.length > 1024)) throw new Error('Invalid room password.');
    const trackerUrl = trackerSource(input.trackerUrl || '')?.url || '';
    this.disconnect();
    this.roomProgress.reset();
    this.options = { address, session, name, password: input.password || null, trackerUrl };
    this.run = null;
    this.contexts = {}; this.notifications.reset();
    this.selectedSlots = null;
    this.players = [];
    this.finishes = {};
    this.releases = {};
    this.checks = {};
    this.readies = {};
    this.locations = {};
    this.halfChecks = {};
    this.goalTimes = {};
    this.ownLocations = null; this.hintsUsed = null; this.pointsPerCheck = null; this.hintPercent = null; this.progressSyncAt = null; this.progressRequestAt = null; this.progressPending = false;
    this.statuses = {};
    this.seed = '';
    this.team = null;
    this.slot = null;
    this.reconnectAttempt = 0;
    this.stopped = false;
    this.open();
  }

  open(message = 'Connecting to Archipelago…') {
    this.pendingCountdown = null;
    this.countdownScheduled = false;
    this.ownReady = null;
    this.pendingStart = null;
    this.connection = 'connecting';
    this.message = message;
    this.hydrated = false;
    this.pendingGoals.clear();
    this.changed();
    const socket = this.socket = new this.Socket(this.options.address, { perMessageDeflate: true, maxPayload: 2 * 1024 * 1024, handshakeTimeout: 15000 });
    let receivedRoomInfo = false;
    let networkError = '';
    this.timeout = setTimeout(() => socket.terminate(), 20000);
    socket.on('message', raw => {
      if (this.socket !== socket) return;
      try {
        const packets = JSON.parse(raw.toString());
        if (!Array.isArray(packets)) throw new Error('Invalid Archipelago packet.');
        for (const packet of packets) {
          if (packet?.cmd === 'RoomInfo') receivedRoomInfo = true;
          this.receive(packet);
        }
      } catch (err) {
        this.disconnect();
        this.connection = 'error';
        this.message = `Timer protocol error: ${err.message}`;
        this.changed();
      }
    });
    socket.on('error', error => {
      // Use only known error codes; error messages can include credential-bearing URLs.
      networkError = ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ETIMEDOUT', 'EPROTO', 'HPE_INVALID_CONSTANT', 'CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'ERR_TLS_CERT_ALTNAME_INVALID'].includes(error.code) ? error.code : '';
    });
    socket.on('pong', () => { this.alive = true; this.lastPongAt = Date.now(); });
    socket.on('close', () => {
      if (this.socket !== socket) return;
      clearTimeout(this.timeout);
      clearInterval(this.poll);
      this.socket = null;
      this.hydrated = false;
      if (this.stopped) return;
      // AP hosts can reject an unencrypted handshake before returning RoomInfo.
      // Upgrade old saved ws:// addresses once; never downgrade an encrypted connection.
      if (!receivedRoomInfo && this.options.address.startsWith('ws://') && ['ECONNRESET', 'EPROTO', 'HPE_INVALID_CONSTANT'].includes(networkError)) {
        this.options.address = this.options.address.replace(/^ws:/, 'wss:');
        this.open('Retrying with an encrypted Archipelago connection…');
        return;
      }
      this.connection = 'reconnecting';
      this.message = networkError ? `Connection failed (${networkError}). Retrying. Check the address, port and ws:// or wss:// protocol.` :
        'Connection lost. Reconnecting; completions during the gap may have no recorded time.';
      this.changed();
      this.retry = setTimeout(() => this.open(), Math.min(30000, 1000 * 2 ** Math.min(this.reconnectAttempt++, 5)));
    });
  }

  disconnect() {
    this.pendingCountdown = null;
    this.countdownScheduled = false;
    let flushReady = false;
    if (this.ownReady && this.socket?.readyState === 1 && !this.run) {
      this.ownReady.ready = false;
      this.publishReady();
      flushReady = true;
    }
    this.ownReady = null;
    this.progressPending = false;
    this.roomProgress.cancel();
    this.pendingStart = null;
    this.stopped = true;
    clearTimeout(this.retry);
    clearTimeout(this.timeout);
    clearInterval(this.poll);
    const socket = this.socket;
    this.socket = null;
    if (socket) {
      // A close handshake flushes the final Not ready packet before disconnecting.
      if (flushReady && typeof socket.close === 'function') socket.close();
      else socket.terminate();
    }
    this.hydrated = false;
    this.pendingGoals.clear();
    this.connection = 'disconnected';
    this.message = 'Disconnected. Shared results are kept in the room; reconnect to resume.';
    this.changed();
  }

  receive(packet) {
    if (!packet || typeof packet.cmd !== 'string') return;
    this.lastPacketAt = Date.now();
    this.notifications.receive(packet);
    if (packet.cmd === 'DataPackage' || (packet.cmd === 'PrintJSON' && packet.type === 'Hint')) { this.changed(); return; }
    if (this.roomProgress.receive(packet)) { this.changed(); return; }
    const countdown = roomCountdownSeconds(packet, this.team);
    if (packet.cmd === 'RoomInfo') {
      if (!Number.isFinite(packet.time) || typeof packet.seed_name !== 'string') throw new Error('The room did not provide a server clock and seed.');
      this.anchor = { server: packet.time * 1000, local: this.clock() };
      if (this.seed !== packet.seed_name) this.roomProgress.reset();
      this.seed = packet.seed_name;
      this.updateHintUsage(packet);
      this.send(this.connectPacket());
    } else if (packet.cmd === 'ConnectionRefused') {
      this.disconnect();
      this.connection = 'error';
      const errors = Array.isArray(packet.errors) ? packet.errors.filter(e => typeof e === 'string').join(', ') : 'Unknown reason';
      this.message = `Archipelago refused the connection: ${errors}. Check the original slot name and password.`;
      this.changed();
    } else if (packet.cmd === 'Connected') {
      if (this.hydrated && this.connection === 'connected') {
        if (packet.team !== this.team || packet.slot !== this.slot) throw new Error('Progress sync returned a different player.');
        this.progressPending = false;
        if (this.refreshOwnProgress(packet)) { this.notifications.balance(packet.hint_points); this.publishLocations(); }
        this.changed(); return;
      }
      if (!Number.isInteger(packet.team) || !Number.isInteger(packet.slot) || !packet.slot_info || !Array.isArray(packet.players)) throw new Error('Unsupported room player list.');
      this.team = packet.team;
      this.contexts = {};
      const hintCost = this.notifications.cost; this.notifications.reset(); this.notifications.cost = hintCost;
      this.slot = packet.slot;
      if (this.expectedRun && (this.expectedRun.seed !== this.seed || this.expectedRun.team !== this.team)) throw new Error('This is not the original room/team for the historical run.');
      this.players = packet.players.filter(p => p.team === this.team && packet.slot_info[p.slot]?.type === 1)
        .map(p => ({ slot: p.slot, name: String(p.alias || p.name), originalName: String(p.name), game: String(packet.slot_info[p.slot].game) }));
      if (!this.players.length) throw new Error('No playable slots in this team.');
      const preferred = this.resolveRoster?.(this.players);
      if (Array.isArray(preferred)) this.selectedSlots = preferred;
      this.key = 'ap_timer_stats_v1_' + createHash('sha256').update(JSON.stringify([this.seed, this.team, this.options.session])).digest('hex').slice(0, 32);
      this.roomKey = 'ap_timer_stats_v1_' + createHash('sha256').update(JSON.stringify([this.seed, this.team])).digest('hex').slice(0, 32);
      this.run = null;
      this.finishes = {};
      this.releases = {};
      this.checks = {};
      this.readies = {};
      this.locations = {};
      this.halfChecks = {};
      this.goalTimes = {};
      this.progressPending = false; this.progressRequestAt = this.now();
      this.ownLocations = null; this.refreshOwnProgress(packet);
      this.statuses = {};
      this.notifications.balance(packet.hint_points);
      const games = [...new Set(this.players.map(p => p.game))];
      this.send({ cmd: 'GetDataPackage', games });
      const keys = [this.key, this.hintKey(), ...this.players.flatMap(p => [this.keyFor(p.slot), this.releaseKey(p.slot), this.statusKey(p.slot), this.checksKey(p.slot),
        this.readyKey(p.slot), this.contextKey(p.slot), this.locationsKey(p.slot), this.halfKey(p.slot), this.goalKey(p.slot)])];
      this.send({ cmd: 'SetNotify', keys }, { cmd: 'Get', keys, timerInitial: true });
      this.alive = true;
      this.poll = setInterval(() => this.pollRoom(), 15000);
    } else if (packet.cmd === 'Retrieved') {
      for (const [key, value] of Object.entries(packet.keys || {})) this.stored(key, value, false);
      if (packet.timerInitial) {
        if (this.expectedRun && this.run?.startedAt !== this.expectedRun.startedAt) throw new Error('The historical shared start is missing or different. This run cannot be resumed from that session.');
        this.hydrated = true;
        this.connection = 'connected';
        this.reconnectAttempt = 0;
        clearTimeout(this.timeout);
        this.message = 'Connected. Everyone using this room, team and session shares the same start.';
        for (const [slot, time] of this.pendingGoals) this.recordGoal(slot, time);
        this.pendingGoals.clear();
        this.publishLocations();
        for (const p of this.players) this.observeHalf(p.slot);
        this.applyCountdown();
        void this.roomProgress.refresh();
      }
      if (this.pendingStart && packet.timerReadyStart === this.pendingStart.id) {
        const request = this.pendingStart;
        this.pendingStart = null;
        try { this.commitStart(request.slots, request.countdown, true); }
        catch (error) { this.message = `Start canceled: ${error.message}`; }
      }
      this.changed();
    } else if (packet.cmd === 'SetReply') {
      this.stored(packet.key, packet.value, true);
      for (const p of this.players) this.observeHalf(p.slot);
      this.changed();
    } else if (countdown !== null) {
      this.observeCountdown(countdown);
    } else if (packet.cmd === 'PrintJSON' && packet.type === 'ItemSend') {
      // ItemSend is broadcast only to this team. item.player is the finder,
      // whereas receiving is the recipient and may be a different runner.
      const item = packet.item;
      const slot = item?.player;
      const time = this.now();
      if (this.hydrated && this.run && time >= this.run.startedAt && Number.isInteger(item?.location) && item.location >= 0 &&
        (packet.team === undefined || packet.team === this.team) && this.run.players.some(p => p.slot === slot) &&
        this.statuses[slot] !== 30 && this.releases[slot] == null && this.finishes[slot] == null &&
        !Object.hasOwn(this.checks[slot] || {}, item.location)) {
        this.roomProgress.checked(slot, item.location);
        (this.checks[slot] ||= {})[item.location] = time;
        this.send({ cmd: 'Set', key: this.checksKey(slot), default: {}, want_reply: true,
          operations: [{ operation: 'update', value: { [`${item.location}:${this.uuid}`]: time } }] });
        this.observeHalf(slot);
        this.changed();
      }
    } else if (packet.cmd === 'PrintJSON' && ['Goal', 'Release'].includes(packet.type) && packet.team === this.team &&
      this.players.some(p => p.slot === packet.slot)) {
      if (packet.type === 'Goal') this.statuses[packet.slot] = 30;
      else {
        const time = this.now();
        this.releases[packet.slot] = Math.min(this.releases[packet.slot] ?? time, time);
        // Release has no persistent AP client status; retain the observed event across sessions.
        this.send({ cmd: 'Set', key: this.releaseKey(packet.slot), default: time, want_reply: true,
          operations: [{ operation: 'min', value: time }] });
      }
      this.liveGoal(packet.slot);
      this.changed();
    } else if (packet.cmd === 'RoomUpdate') {
      if (Array.isArray(packet.checked_locations) && this.ownLocations) {
        if (!Number.isSafeInteger(packet.hint_points) && packet.checked_locations.some(id => !this.ownLocations.checked.has(id))) this.hintsUsed = null;
        for (const location of packet.checked_locations.filter(Number.isSafeInteger)) this.ownLocations.checked.add(location);
        this.progressSyncAt = this.now();
      }
      this.updateHintUsage(packet);
      if (this.hydrated && this.ownLocations && (Array.isArray(packet.checked_locations) || Number.isSafeInteger(packet.hint_points))) this.publishLocations();
      for (const player of this.players) {
        const update = packet.players?.find(p => p.team === this.team && p.slot === player.slot);
        if (update) player.name = String(update.alias || update.name);
      }
      if (this.run) for (const player of this.run.players) {
        const update = this.players.find(p => p.slot === player.slot);
        if (update) player.name = update.name;
      }
      this.changed();
    } else if (packet.cmd === 'InvalidPacket') {
      throw new Error('The server rejected a timer protocol request.');
    }
  }

  stored(key, value, live) {
    if (key === this.hintKey()) { this.notifications.observeHints(value || [], live && this.hydrated); return; }
    if (key === this.key) {
      if (value === null) return;
      if (!value || value.schema !== 1 || value.seed !== this.seed || value.team !== this.team ||
        !Number.isFinite(value.startedAt) || value.startedAt <= 0 || !Array.isArray(value.players) || !value.players.length ||
        new Set(value.players.map(p => p.slot)).size !== value.players.length ||
        !value.players.every(p => this.players.some(q => q.slot === p.slot) && typeof p.name === 'string' && typeof p.game === 'string')) {
        throw new Error('Stored timer session is invalid. Choose a new session name.');
      }
      this.run = value;
      this.pendingCountdown = null;
      this.countdownScheduled = false;
      return;
    }
    for (const p of this.players) {
      if (key === this.contextKey(p.slot)) {
        if (value && Object.hasOwn(contextLabels, value.state || '') && typeof value.id === 'string' && value.id.length <= 64 && Number.isFinite(value.at) && value.at > 0 && value.at <= this.now() + 5000 && (value.runAt === null || Number.isFinite(value.runAt))) {
          const old = this.contexts[p.slot];
          if (!old || old.at <= value.at) {
            this.contexts[p.slot] = { state: value.state, detail: clean(value.detail), at: value.at, runAt: value.runAt, id: value.id };
            if (live && this.hydrated && old?.id !== value.id && (value.runAt === null || value.runAt === this.run?.startedAt)) this.notifications.add(`context:${p.slot}:${value.id}`, 'context', p.slot, `${p.name} marked ${contextLabels[value.state]}${value.state === 'waiting' && clean(value.detail) ? `: ${clean(value.detail)}` : ''}.`, value.at, { state:value.state });
          }
        }
      }
      if (key === this.readyKey(p.slot)) {
        const valid = value && typeof value.ready === 'boolean' && Number.isFinite(value.at) && Number.isFinite(value.expiresAt) &&
          value.expiresAt > value.at && value.expiresAt - value.at <= 60000 && Array.isArray(value.roster) &&
          value.roster.includes(p.slot) && new Set(value.roster).size === value.roster.length &&
          value.roster.every(slot => this.players.some(q => q.slot === slot));
        if (valid) this.readies[p.slot] = value;
        else delete this.readies[p.slot];
      }
      if (key === this.locationsKey(p.slot) && value && Number.isSafeInteger(value.total) && value.total >= 0 && Array.isArray(value.checked)) {
        const checked = [...new Set([...(this.locations[p.slot]?.checked || []), ...value.checked.filter(Number.isSafeInteger)])];
        if (checked.length <= value.total) {
          const hintsUsed = Number.isSafeInteger(value.hintsUsed) && value.hintsUsed >= 0 ? value.hintsUsed : null;
          const syncedAt = Number.isFinite(value.syncedAt) && value.syncedAt <= this.now() + 5000 ? value.syncedAt : null;
          this.locations[p.slot] = { total: value.total, checked, hintsUsed, syncedAt };
        }
      }
      if (key === this.halfKey(p.slot) && Number.isFinite(value) && value > 0) this.halfChecks[p.slot] = Math.min(this.halfChecks[p.slot] ?? value, value);
      if (key === this.goalKey(p.slot) && Number.isFinite(value) && value > 0) this.goalTimes[p.slot] = Math.min(this.goalTimes[p.slot] ?? value, value);
      if (key === this.checksKey(p.slot) && value && typeof value === 'object' && !Array.isArray(value)) {
        const checks = this.checks[p.slot] ||= {};
        for (const [entry, time] of Object.entries(value)) {
          const location = entry.split(':')[0];
          if (/^\d+(?::[\da-f-]{36})?$/.test(entry) && Number.isSafeInteger(Number(location)) && Number.isFinite(time) && time > 0) {
            checks[location] = Math.min(checks[location] ?? time, time);
          }
        }
        this.checks[p.slot] = checks;
      }
      if (key === this.keyFor(p.slot) && Number.isFinite(value) && value > 0) this.finishes[p.slot] = value;
      if (key === this.releaseKey(p.slot) && Number.isFinite(value) && value > 0) {
        this.releases[p.slot] = Math.min(this.releases[p.slot] ?? value, value);
      }
      if (key === this.statusKey(p.slot)) {
        const old = this.statuses[p.slot];
        this.statuses[p.slot] = old === 30 ? 30 : Number.isInteger(value) ? value : null;
        // Poll responses can recover a missed notification while connected. Initial
        // hydration cannot supply a historical goal time, so leave that unknown.
        if ((live || this.hydrated) && value === 30 && old !== 30) this.liveGoal(p.slot);
      }
    }
  }

  liveGoal(slot) {
    const time = this.now();
    if (this.statuses[slot] === 30 && this.goalTimes[slot] == null) {
      this.goalTimes[slot] = time;
      this.send({ cmd: 'Set', key: this.goalKey(slot), default: time, want_reply: true,
        operations: [{ operation: 'min', value: time }] });
    }
    if (!this.hydrated) this.pendingGoals.set(slot, Math.min(this.pendingGoals.get(slot) ?? time, time));
    else this.recordGoal(slot, time);
  }

  recordGoal(slot, time) {
    if (!this.run || !this.run.players.some(p => p.slot === slot) || time < this.run.startedAt) return;
    // Atomic min makes duplicate observer reports converge on the earliest receipt.
    this.send({ cmd: 'Set', key: this.keyFor(slot), default: time, want_reply: true,
      operations: [{ operation: 'min', value: time }] });
  }

  validateSlots(slots) {
    if (!Array.isArray(slots) || !slots.length || new Set(slots).size !== slots.length || !slots.every(slot => this.players.some(p => p.slot === slot))) throw new Error('Select at least one player.');
  }

  validateStart(slots, countdown, requireReady) {
    if (this.connection !== 'connected' || !this.hydrated) throw new Error('Connect and wait for the player list first.');
    if (this.run) throw new Error('This session has already started. Choose a new session name for another run.');
    this.validateSlots(slots);
    if (typeof requireReady !== 'boolean') throw new Error('Invalid ready-check setting.');
    if (!Number.isInteger(countdown) || countdown < 5 || countdown > 60) throw new Error('Choose a countdown from 5 to 60 seconds.');
    if (slots.some(slot => this.statuses[slot] == null || this.statuses[slot] === 30 || this.releases[slot] != null)) throw new Error('Selected players must have a known status and must not have completed their goal or released already.');
    if (requireReady && !slots.every(slot => this.isReady(slot, slots))) throw new Error('Every selected runner must be ready for this roster. Ready confirmations expire after 45 seconds without a heartbeat.');
  }

  start(slots, countdown = 10, requireReady = false) {
    if (this.pendingStart || this.countdownScheduled) throw new Error('A start request is already being checked.');
    this.validateStart(slots, countdown, requireReady);
    if (!requireReady) return this.commitStart(slots, countdown, false);
    this.pendingStart = { id: randomUUID(), slots: [...slots], countdown };
    this.send({ cmd: 'Get', keys: slots.map(slot => this.readyKey(slot)), timerReadyStart: this.pendingStart.id });
    this.changed();
  }

  commitStart(slots, countdown, requireReady) {
    this.validateStart(slots, countdown, requireReady);
    const scheduledAt = this.now();
    const run = { schema: 1, seed: this.seed, team: this.team, scheduledAt, requireReady, startedAt: scheduledAt + countdown * 1000,
      source: 'app', countdownSeconds: countdown,
      players: this.players.filter(p => slots.includes(p.slot)), createdBy: this.slot };
    this.writeRun(run);
  }

  writeRun(run) {
    // First writer wins: two people pressing Start cannot replace the shared start.
    this.send({ cmd: 'Set', key: this.key, default: run, want_reply: true,
      operations: [{ operation: 'default', value: null }] });
  }

  soloAction(action) {
    if (action === 'start') {
      if (this.solo) throw new Error('Reset the solo timer before starting a new run.');
      this.solo = { startedAt: Date.now(), finishedAt: null };
    } else if (action === 'finish') {
      if (!this.solo || this.solo.finishedAt !== null) throw new Error('Start the solo timer first.');
      this.solo.finishedAt = Math.max(this.solo.startedAt, Date.now());
    } else if (action === 'reset') this.solo = null;
    else throw new Error('Unknown solo timer action.');
    this.saveSolo(this.solo);
    this.changed();
  }
}

module.exports = { RunTimer, serverAddress, sessionName, roomCountdownSeconds };
