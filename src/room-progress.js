const ID = /^[A-Za-z0-9_-]{22}$/;
function trackerSource(value) {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 2048) throw new Error('Enter a room or tracker URL.');
  const url = new URL(value.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Use an HTTP(S) room or tracker URL without credentials or query parameters.');
  const parts = url.pathname.split('/').filter(Boolean);
  const playerView = parts.length === 4 && parts.slice(2).every(p => /^\d+$/.test(p));
  const trackerView = parts[0] === 'tracker' && (parts.length === 2 || parts.length === 3 || playerView);
  if (!ID.test(parts[1] || '') || !((parts[0] === 'room' && parts.length === 2) || trackerView)) throw new Error('Use the room page or tracker page URL.');
  return { url: `${url.origin}/${parts[0]}/${parts[1]}`, origin: url.origin, kind: parts[0], id: parts[1] };
}

function statusCounts(text, players, team) {
  if (typeof text !== 'string' || text.length > 1024 * 1024) return null;
  const lines = text.trim().split(/\r?\n/);
  if (lines.shift() !== `Player Status on team ${team}:`) return null;
  const result = new Map();
  for (const line of lines) {
    const match = /^(.+) has \d+ connections?.* \((\d+)\/(\d+)\)$/.exec(line);
    if (!match) continue;
    const candidates = players.filter(p => p.name === match[1] || p.originalName === match[1]);
    const checked = Number(match[2]), total = Number(match[3]);
    if (candidates.length !== 1 || !Number.isSafeInteger(checked) || !Number.isSafeInteger(total) || checked > total) continue;
    const slot = candidates[0].slot;
    if (result.has(slot)) return null;
    result.set(slot, { checked, total, source: '!status' });
  }
  return result.size ? result : null;
}

class RoomProgress {
  constructor(timer, { fetch = globalThis.fetch } = {}) {
    this.timer = timer; this.fetch = fetch; this.cache = new Map(); this.reset();
  }
  reset() {
    this.cancel();
    this.counts = new Map(); this.source = ''; this.error = '';
    this.recoveries = []; this.recoverySequence = 0;
    this.syncedAt = null; this.lastStatusAt = -Infinity;
  }
  cancel() {
    this.controller?.abort(); clearTimeout(this.timeout);
    this.generation = (this.generation || 0) + 1;
    this.pending = false; this.statusUntil = 0;
  }
  async json(url, ttl, signal) {
    const now = this.timer.clock(), cached = this.cache.get(url);
    if (cached && now - cached.at < ttl) return cached.value;
    const response = await this.fetch(url, { signal, redirect: 'error', headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error(`Tracker returned HTTP ${response.status}.`);
    const chunks = []; let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.byteLength;
      if (bytes > 16 * 1024 * 1024) throw new Error('Tracker response is too large.');
      chunks.push(Buffer.from(chunk));
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    this.cache.set(url, { at: this.timer.clock(), value });
    while (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
  async refresh() {
    if (this.pending || this.timer.connection !== 'connected' || !this.timer.hydrated) return;
    const t = this.timer, generation = this.generation, key = t.key, socket = t.socket;
    const current = () => generation === this.generation && t.key === key && t.socket === socket && t.connection === 'connected' && t.hydrated;
    const source = trackerSource(t.options.trackerUrl || '');
    if (!source) { this.requestStatus(); return; }
    this.pending = true; this.controller = new AbortController();
    this.timeout = setTimeout(() => this.controller?.abort(), 20000); this.timeout.unref?.();
    try {
      let id = source.id;
      if (source.kind === 'room') {
        const room = await this.json(`${source.origin}/api/room_status/${id}`, 300000, this.controller.signal);
        if (!ID.test(room.tracker || '') || !Array.isArray(room.players) || !t.players.every(p => room.players.some(entry => entry[0] === p.originalName && entry[1] === p.game))) throw new Error('Room URL does not match the connected roster.');
        id = room.tracker;
      }
      const [fixed, live] = await Promise.all([
        this.json(`${source.origin}/api/static_tracker/${id}`, 300000, this.controller.signal),
        this.json(`${source.origin}/api/tracker/${id}`, 60000, this.controller.signal),
      ]);
      if (!current()) return;
      if (!Array.isArray(fixed.player_locations_total) || !Array.isArray(fixed.player_game) || !Array.isArray(live.player_checks_done)) throw new Error('Unsupported tracker response.');
      const counts = new Map();
      for (const player of t.players) {
        const matches = rows => rows.filter(r => r.team === t.team && r.player === player.slot);
        const totals = matches(fixed.player_locations_total), games = matches(fixed.player_game), checked = matches(live.player_checks_done);
        if (totals.length !== 1 || games.length !== 1 || checked.length !== 1 || games[0].game !== player.game) throw new Error('Tracker slots or games do not match this room.');
        const total = totals[0].total_locations, ids = checked[0].locations;
        if (!Number.isSafeInteger(total) || total < 0 || !Array.isArray(ids) || !ids.every(Number.isSafeInteger)) throw new Error('Invalid tracker counts.');
        const locations = new Set(ids);
        if (locations.size > total || (player.slot === t.slot && t.ownLocations && total !== t.ownLocations.total)) throw new Error('Tracker totals do not match the connected world.');
        counts.set(player.slot, { checked: locations.size, total, locations, source: 'Tracker API' });
      }
      this.applyCounts(counts, 'Tracker API'); this.error = '';
    } catch (error) {
      if (current()) { this.error = error.name === 'AbortError' ? 'Tracker request timed out.' : 'Tracker unavailable or mismatched. Check the room/tracker URL.'; this.requestStatus(); }
    } finally {
      if (generation === this.generation) { clearTimeout(this.timeout); this.pending = false; if (current()) t.changed(); }
    }
  }
  requestStatus() {
    const t = this.timer;
    if (t.connection !== 'connected' || !t.hydrated || t.socket?.readyState !== 1 || t.clock() - this.lastStatusAt < 60000) return;
    this.lastStatusAt = t.clock(); this.statusUntil = t.clock() + 15000;
    t.send({ cmd: 'Say', text: '!status' });
  }
  receive(packet) {
    if (packet.cmd !== 'PrintJSON' || packet.type !== 'CommandResult' || this.timer.clock() > this.statusUntil || !this.statusUntil ||
      !Array.isArray(packet.data) || !packet.data.every(p => typeof p.text === 'string' && [undefined, 'text'].includes(p.type))) return false;
    const counts = statusCounts(packet.data.map(p => p.text).join(''), this.timer.players, this.timer.team);
    if (!counts) return false;
    // Require every playable slot: a partial/ambiguous text response must not
    // replace a complete earlier snapshot or attach a count to the wrong player.
    if (counts.size !== this.timer.players.length) return false;
    this.applyCounts(counts, '!status'); this.statusUntil = 0;
    return true;
  }
  applyCounts(counts, source) {
    const recovered = [];
    for (const [slot,value] of counts) {
      const old = this.counts.get(slot), info = this.timer.locations?.[slot];
      if (!old || old.total !== value.total) continue; // First snapshot establishes a baseline.
      const known = this.progress({slot}, info, this.timer.checks?.[slot])?.checked ?? old.checked;
      if (value.checked > known) recovered.push({slot, count:value.checked-known});
      if (value.locations && old.locations) {
        for (const id of old.locations) value.locations.add(id);
        value.checked = Math.min(value.total,value.locations.size);
      } else value.checked = Math.min(value.total,Math.max(known,value.checked));
    }
    this.counts=counts; this.source=source; this.syncedAt=this.timer.now();
    this.explain(recovered,source);
  }
  explain(recovered,source) {
    if (recovered.length) {
      const at=this.timer.now();
      const description=recovered.map(r=>`${this.timer.players.find(p=>p.slot===r.slot)?.name || 'Runner'} +${r.count}`).join('; ');
      this.recoveries.push({id:`sync:${++this.recoverySequence}:${at}`,type:'sync',at,
        message:`Counts recovered (${source}): ${description} check${recovered.reduce((n,r)=>n+r.count,0) === 1 ? '' : 's'}. Original check times are unknown.`});
      this.recoveries=this.recoveries.slice(-50);
    }
  }
  progress(player, info, timedChecks) {
    const external = this.counts.get(player.slot);
    if (!external) return null;
    const ids = new Set([...(external.locations || []), ...(info?.checked || []), ...Object.keys(timedChecks || {}).map(Number)]);
    const checked = Math.min(external.total, Math.max(external.checked, ids.size));
    return { checked, total: external.total, syncedAt: this.syncedAt, source: external.source };
  }
  checked(slot, location) {
    const value = this.counts.get(slot);
    if (!value) return;
    if (value.locations) { value.locations.add(location); value.checked = value.locations.size; }
    else value.checked = Math.min(value.total, value.checked + 1);
  }
  health() { return { source: this.source || 'Waiting for room counts', at: this.syncedAt, pending: this.pending, error: this.error, recovery:this.recoveries.at(-1) || null }; }
}
module.exports = { RoomProgress, trackerSource, statusCounts };
