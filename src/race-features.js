// Shared presentation rules used by the main process, renderer and tests.
(function (root) {
  const categories = ['goal', 'release', 'finish', 'checks', 'half', 'bk', 'ready', 'start', 'first', 'recovery', 'activity', 'watch', 'progression', 'hint', 'hintfound', 'hintpoints', 'context', 'digest', 'sync'];
  const builtInSounds = [{ id: 'classic', name: 'Classic beep' }, { id: 'soft', name: 'Soft chime' }, { id: 'arcade', name: 'Arcade' }, { id: 'bell', name: 'Bell' }, { id: 'retro-pulse', name: 'Retro • Countdown pulse' }, { id: 'retro-item', name: 'Retro • Item discovery' }, { id: 'retro-secret', name: 'Retro • Secret chime' }, { id: 'retro-heart', name: 'Retro • Heart pickup' }, { id: 'retro-fanfare', name: 'Retro • Victory fanfare' }];
  const soundChoice = (value, fallback) => builtInSounds.some(s => s.id === value) || /^custom:[a-f0-9]{64}$/.test(value) ? value : fallback;
  function featurePreferences(input = {}) {
    const a = input.alerts || {}, s = input.sounds || {};
    return {
      alerts: { scope: ['everyone', 'others', 'self'].includes(a.scope) ? a.scope : 'everyone', fullView: a.fullView === true,
        categories: Object.fromEntries(categories.map(type => [type, {
          popup: typeof a.categories?.[type]?.popup === 'boolean' ? a.categories[type].popup : !['ready','sync'].includes(type),
          sound: a.categories?.[type]?.sound === true,
          soundId: soundChoice(a.categories?.[type]?.soundId, ['goal', 'release', 'finish'].includes(type) ? 'retro-fanfare' : 'retro-item'),
        }])) },
      sounds: { enabled: s.enabled === true, volume: Number.isFinite(s.volume) ? Math.min(100, Math.max(0, s.volume)) : 25, background: s.background === true,
        countdownId: soundChoice(s.countdownId ?? 'retro-pulse', 'classic'), goId: soundChoice(s.goId ?? 'retro-fanfare', 'bell'),
        watchItems: Array.isArray(s.watchItems) ? [...new Set(s.watchItems.filter(n => typeof n === 'string').map(n => n.trim().slice(0, 100)).filter(Boolean))].slice(0, 50) : [], revealItems: s.revealItems === true },
    };
  }
  function eventRule(event, preferences, ownSlot) {
    const prefs = featurePreferences(preferences), rule = prefs.alerts.categories[event.type];
    if (!rule) return { popup: false, sound: false };
    const slot = event.slot ?? Number(event.id?.split(':')[1]);
    if (event.type === 'bk' && slot === ownSlot) return { popup: false, sound: false };
    if (Number.isInteger(slot) && ((prefs.alerts.scope === 'self' && slot !== ownSlot) || (prefs.alerts.scope === 'others' && slot === ownSlot))) return { popup: false, sound: false };
    return rule;
  }
  function raceAwards(record) {
    if (!record?.allFinished || record.excluded) return [];
    const completed = record.players.filter(p => p.completed);
    const uncertain = record.quality?.uncertain === true;
    const definitions = [
      { type: 'fastest', title: 'Fastest completion', field: 'elapsedMs', min: true },
      { type: 'checks', title: 'Most recorded checks', field: 'checksCompleted', min: false },
      { type: 'steady', title: 'Steady progress', field: 'longestBKMs', min: true },
    ];
    return definitions.map(def => {
      const eligible = completed.filter(p => Number.isFinite(p.stats?.[def.field]) && p.stats[def.field] >= 0);
      if (eligible.length < 2) return { ...def, winners: [], reason: 'At least two completed runners with known values are required.' };
      if (uncertain && def.type !== 'fastest') return { ...def, winners: [], reason: 'Withheld: recording coverage is uncertain.' };
      const value = p => def.type === 'checks' ? p.stats[def.field] : Math.floor(p.stats[def.field] / 1000);
      const best = (def.min ? Math.min : Math.max)(...eligible.map(value));
      return { ...def, winners: eligible.filter(p => value(p) === best).map(p => ({ slot: p.slot, name: p.originalName || p.name })), value: def.type === 'checks' ? best : best * 1000, reason: '' };
    });
  }
  class CountdownCues {
    constructor() { this.context = null; this.previous = null; this.armed = false; }
    update({ context, ready, startedAt, now, enabled }) {
      if (!ready || !Number.isFinite(startedAt) || !Number.isFinite(now)) { this.context = null; this.previous = null; return []; }
      if (context !== this.context) { this.context = context; this.previous = now; this.armed = now < startedAt; return []; }
      const cues = [];
      if (this.armed) for (const remaining of [3, 2, 1, 0]) {
        const at = startedAt - remaining * 1000;
        if (this.previous < at && now >= at && now - at <= 400 && enabled) cues.push(remaining);
      }
      this.previous = now;
      if (now >= startedAt) this.armed = false;
      return cues;
    }
  }
  const api = { categories, featurePreferences, eventRule, raceAwards, CountdownCues, builtInSounds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.RaceFeatureRules = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
