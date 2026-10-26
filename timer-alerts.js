// Presentation-only alerts: never changes the shared race or its timestamps.
(function (root) {
  const priorities = { finish: 100, goal: 80, release: 80, half: 60, bk: 50, start: 40, checks: 20 };

  class TimerAlerts {
    constructor() { this.reset(null); }

    reset(context) {
      this.context = context;
      this.seen = new Set();
      this.initialized = false;
      this.queue = [];
      this.active = null;
      this.nextAt = 0;
      this.bkReminders = new Map();
    }

    enqueue(event, now) {
      this.queue.push({ ...event, queuedAt: now });
      this.queue.sort((a, b) => priorities[b.type] - priorities[a.type] || a.queuedAt - b.queuedAt);
      this.queue = this.queue.slice(0, 8);
    }

    update({ context, ready, enabled, events, runnerBKs = [], ownSlot, serverNow, now }) {
      if (context !== this.context) this.reset(context);
      if (!ready) {
        this.initialized = false;
        this.queue = [];
        this.active = null;
        return null;
      }
      const visible = events.filter(event => event.at === null || event.at <= serverNow);
      if (!this.initialized) {
        // Hydration and reconnects contain history, not new notifications.
        for (const event of visible) this.seen.add(event.id);
        this.initialized = true;
      } else for (const event of visible) {
        if (this.seen.has(event.id)) continue;
        this.seen.add(event.id);
        if (enabled && event.type !== 'bk' && Object.hasOwn(priorities, event.type) && event.at !== null && serverNow - event.at <= 30000) this.enqueue(event, now);
      }

      const others = new Map(runnerBKs.filter(runner => runner.slot !== ownSlot && Number.isFinite(runner.since)).map(runner => [runner.slot, runner]));
      const currentBK = event => event.type !== 'bk' || (others.get(event.slot)?.since === event.since && serverNow - event.since >= 600000);
      this.queue = this.queue.filter(currentBK);
      if (this.active && !currentBK(this.active)) this.active = null;
      for (const slot of this.bkReminders.keys()) if (!others.has(slot)) this.bkReminders.delete(slot);
      for (const runner of others.values()) {
        if (this.bkReminders.get(runner.slot)?.since !== runner.since) this.bkReminders.set(runner.slot, { since: runner.since, nextAt: 0 });
      }
      if (!enabled) {
        this.active = null;
        this.queue = [];
        this.nextAt = 0;
        return null;
      }
      if (this.active && now >= this.active.until) {
        this.nextAt = this.active.until + 600;
        this.active = null;
      }
      for (const runner of others.values()) {
        const reminder = this.bkReminders.get(runner.slot);
        if (serverNow - runner.since < 600000 || now < reminder.nextAt) continue;
        if (!this.queue.some(event => event.type === 'bk' && event.slot === runner.slot) &&
          !(this.active?.type === 'bk' && this.active.slot === runner.slot)) {
          this.enqueue({ id: `bk:${runner.slot}:${runner.since}`, type: 'bk', slot: runner.slot, name: runner.name, since: runner.since }, now);
          reminder.nextAt = now + 600000;
        }
      }
      this.queue = this.queue.filter(event => now - event.queuedAt <= 30000);
      if (!this.active && now >= this.nextAt && this.queue.length) {
        this.active = { ...this.queue.shift(), until: now + 8000 };
      }
      return this.active;
    }
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = { TimerAlerts };
  else root.TimerAlerts = TimerAlerts;
})(typeof globalThis !== 'undefined' ? globalThis : this);
