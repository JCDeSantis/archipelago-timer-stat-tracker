const { createHash } = require('crypto');
const { featurePreferences } = require('./race-features');
const contextLabels = { playing: 'Playing', waiting: 'Waiting on an item', break: 'Taking a break', gomode: 'Go mode' };
const clean = value => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, ' ').trim().slice(0, 100) : '';
const digestId = value => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
const clock = ms => [Math.floor(ms / 3600000), Math.floor(ms / 60000) % 60, Math.floor(ms / 1000) % 60].map(n => String(n).padStart(2, '0')).join(':');

class RaceNotifications {
  constructor(timer) { this.timer = timer; this.reset(); }
  reset() { clearTimeout(this.flushTimer); this.flushTimer = null; this.events = []; this.seen = new Set(); this.hints = new Map(); this.batches = new Map(); this.packages = {}; this.points = null; this.cost = null; this.affordable = null; this.loadedHints = false; this.runAt = null; }
  prefs() { return featurePreferences(this.timer.notificationPreferences?.() || {}); }
  active() { const t = this.timer; return t.hydrated && t.run && t.now() >= t.run.startedAt; }
  add(id, type, slot, message, at = this.timer.now(), details = {}) {
    if (!this.active()) return;
    if (this.runAt !== this.timer.run.startedAt) { this.events = []; this.runAt = this.timer.run.startedAt; }
    id = `${this.runAt}:${id}`;
    if (this.seen.has(id)) return;
    this.seen.add(id); this.events.push({ id, type, slot, at, message, ...details });
    if (this.events.length > 200) this.events.shift();
    if (this.seen.size > 10000) this.seen.delete(this.seen.values().next().value);
  }
  player(slot) { return this.timer.players.find(p => p.slot === slot); }
  name(slot) { return this.player(slot)?.name || `Player ${slot}`; }
  itemName(item, receiving, data) {
    const map = this.packages[this.player(receiving)?.game]?.item_name_to_id;
    if (map) { const found = Object.entries(map).find(([, id]) => id === item.item); if (found) return found[0]; }
    const part = data?.find(p => (p.type === 'item_id' || p.type === 'item_name') && Number(p.player) === receiving);
    return part?.type === 'item_name' ? clean(part.text) : null;
  }
  watched(name) { return !!name && this.prefs().sounds.watchItems.some(n => n.toLocaleLowerCase() === name.toLocaleLowerCase()); }
  hintKey(h) { return `${h.finding_player ?? h.player}:${h.location}:${h.receiving_player ?? h.receiving}`; }
  observeHints(list, live) {
    if (!Array.isArray(list)) return;
    for (const h of list.slice(0, 10000)) {
      if (!Number.isSafeInteger(h.location) || !Number.isInteger(h.finding_player) || !Number.isInteger(h.receiving_player)) continue;
      const key = this.hintKey(h), old = this.hints.get(key);
      this.hints.set(key, { ...h, found: h.found === true });
      if (!live || !this.loadedHints) continue;
      if (!old && !h.found) this.hintEvent(h);
      if (h.found && !old?.found) this.hintFound(h);
    }
    this.loadedHints = true;
  }
  hintEvent(h) {
    const t = this.timer;
    if (h.receiving_player !== t.slot && h.finding_player !== t.slot) return;
    this.add(`hint:${this.hintKey(h)}`, 'hint', t.slot, 'A new hint involves your world.');
  }
  hintFound(h) {
    if (h.receiving_player !== this.timer.slot || !this.watched(this.itemName({ item: h.item }, h.receiving_player))) return;
    this.add(`hintfound:${this.hintKey(h)}`, 'hintfound', this.timer.slot, 'Your watched hint has been found.');
  }
  balance(points, percentage) {
    if (Number.isFinite(points) && points >= 0) this.points = points;
    if (Number.isFinite(percentage) && percentage >= 0 && percentage <= 100) this.cost = percentage;
    const total = this.timer.ownLocations?.total;
    if (!total || this.cost === null || this.points === null) return;
    const cost = this.cost ? Math.max(1, Math.floor(this.cost * 0.01 * total)) : 0, affordable = cost > 0 && this.points >= cost;
    if (this.affordable === false && affordable) this.add(`points:${this.timer.now()}`, 'hintpoints', this.timer.slot, 'You have enough points for a hint.');
    this.affordable = affordable;
  }
  receive(packet) {
    const t = this.timer;
    if (packet.cmd === 'DataPackage') { this.packages = packet.data?.games || {}; return; }
    if (['RoomInfo', 'Connected', 'RoomUpdate'].includes(packet.cmd)) this.balance(packet.hint_points, packet.hint_cost);
    if (packet.cmd !== 'PrintJSON' || (packet.team !== undefined && packet.team !== t.team)) return;
    if (packet.type === 'Hint' && packet.item) {
      const h = { finding_player: packet.item.player, receiving_player: packet.receiving, location: packet.item.location, item: packet.item.item, found: packet.found === true };
      const key = this.hintKey(h), old = this.hints.get(key); this.hints.set(key, h);
      if (!old && !h.found) this.hintEvent(h);
      if (h.found && !old?.found) this.hintFound(h);
      return;
    }
    if (!this.active()) return;
    if (['Release', 'Collect'].includes(packet.type)) {
      // These messages do not prove the origin of every item in a nearby burst.
      this.lastBulkAt = t.now();
      return;
    }
    if (packet.type !== 'ItemSend') return;
    const item = packet.item, receiving = packet.receiving;
    if (!Number.isSafeInteger(item?.location) || !Number.isSafeInteger(item?.item) || !this.player(item.player) || !this.player(receiving)) return;
    const key = `item:${item.player}:${item.location}:${receiving}:${item.item}`;
    if (this.seen.has(`${t.run.startedAt}:${key}`)) return;
    this.seen.add(`${t.run.startedAt}:${key}`);
    let collectedHint = false;
    for (const h of this.hints.values()) if (h.finding_player === item.player && h.location === item.location && h.receiving_player === receiving) { collectedHint = true; if (!h.found) { h.found = true; this.hintFound(h); } }
    if (receiving !== t.slot) return;
    const name = this.itemName(item, receiving, packet.data), watched = this.watched(name);
    const batch = this.batches.get(receiving) || { at: t.now(), count: 0, watched: 0, items: [] };
    batch.count++; batch.watched += Number(watched); batch.items.push({ key, item, name, watched, collectedHint, at: t.now() }); this.batches.set(receiving, batch);
    if (!this.flushTimer) { this.flushTimer = setTimeout(() => { this.flushTimer = null; this.timer.changed(); }, 1300); this.flushTimer.unref?.(); }
  }
  flush() {
    for (const [slot, batch] of this.batches) {
      if (this.timer.now() - batch.at < 1200) continue;
      this.batches.delete(slot);
      if (batch.count >= 3) {
        this.add(`digest:${digestId(batch.items.map(i => i.key))}`, 'digest', slot, `Item burst: ${batch.count} items for you${batch.watched ? `, including ${batch.watched} watched ${batch.watched === 1 ? 'item' : 'items'}` : ''}.`, batch.at);
      } else for (const entry of batch.items) {
        if (entry.watched && entry.collectedHint) continue;
        if (entry.watched) this.add(`watch:${entry.key}`, 'watch', slot, this.prefs().sounds.revealItems ? `${this.name(entry.item.player)} found your ${entry.name}.` : `${this.name(entry.item.player)} found an item on your watchlist.`, entry.at);
        else if ((entry.item.flags & 1) && this.timer.contexts[slot]?.state === 'waiting' && (this.timer.contexts[slot].runAt === null || this.timer.contexts[slot].runAt === this.timer.run.startedAt)) this.add(`progression:${entry.key}`, 'progression', slot, 'A progression item was found for you while you were waiting.', entry.at);
      }
    }
  }
  snapshot() { this.flush(); return this.runAt === this.timer.run?.startedAt ? this.events : []; }
}
module.exports = { RaceNotifications, contextLabels, clean, clock };
