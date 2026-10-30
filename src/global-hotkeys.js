const definitions = {
  playing: ['Playing', 'CommandOrControl+Alt+Shift+P'], waiting: ['Waiting', 'CommandOrControl+Alt+Shift+W'],
  break: ['Taking a break', 'CommandOrControl+Alt+Shift+B'], gomode: ['Go mode', 'CommandOrControl+Alt+Shift+G'],
  stats: ['Toggle stats', 'CommandOrControl+Alt+Shift+S'], compact: ['Toggle Timer Only', 'CommandOrControl+Alt+Shift+T'], mute: ['Mute / unmute sounds', 'CommandOrControl+Alt+Shift+M'],
};
function hotkeyPreferences(input = {}) {
  const bindings = {};
  for(const [action,[,fallback]] of Object.entries(definitions)) {
    const value = input.bindings?.[action] ?? fallback;
    if(typeof value !== 'string' || value.length > 100 || value && (!/^(?:(?:CommandOrControl|Control|Ctrl|Alt|Shift|Super|Meta|Command|Cmd)\+)+(?:[A-Z0-9]|F(?:[1-9]|1[0-9]|2[0-4])|Space|Home|End|PageUp|PageDown|Up|Down|Left|Right)$/i.test(value) || !/(?:Control|Ctrl|Alt|Super|Meta|Command|Cmd)\+/i.test(value))) throw new Error('Use a modified shortcut such as Control+Alt+Shift+G, or leave it blank.');
    bindings[action] = value;
  }
  const keys = Object.values(bindings).filter(Boolean).map(s => s.toLowerCase().replace(/commandorcontrol|control/g,'ctrl').replace(/command/g,'cmd').split('+').sort().join('+'));
  if(new Set(keys).size !== keys.length) throw new Error('Each action needs a different shortcut.');
  return {enabled:input.enabled === true, bindings};
}
class GlobalHotkeys {
  constructor(registry, invoke) { this.registry=registry; this.invoke=invoke; this.preferences=hotkeyPreferences(); this.registered=[]; }
  release() { for(const key of this.registered) this.registry.unregister(key); this.registered=[]; }
  register(prefs) {
    if(!prefs.enabled) return;
    for(const [action,key] of Object.entries(prefs.bindings)) if(key) {
      if(!this.registry.register(key,()=>this.invoke(action))) throw new Error(`Shortcut unavailable: ${key}. Choose another binding.`);
      this.registered.push(key);
    }
  }
  apply(input) {
    const next=hotkeyPreferences(input), previous=this.preferences; this.release();
    try { this.register(next); this.preferences=next; }
    catch(error) {
      this.release();
      try { this.register(previous); } catch { this.release(); this.preferences={...previous,enabled:false}; }
      throw error;
    }
    return this.preferences;
  }
}
module.exports={GlobalHotkeys,hotkeyPreferences,definitions};
