(function(root) {
  const columns = ['game', 'status', 'checks', 'hints', 'bk'];
  function compactPreferences(input = {}) {
    return { columns: columns.filter(c => input.columns === undefined || Array.isArray(input.columns) && input.columns.includes(c)),
      filter: ['all', 'active', 'self'].includes(input.filter) ? input.filter : 'all',
      sort: ['roster', 'name', 'progress'].includes(input.sort) ? input.sort : 'roster',
      pins: Array.isArray(input.pins) ? [...new Set(input.pins.filter(n => typeof n === 'string').map(n => n.trim().slice(0,256)).filter(Boolean))].slice(0,100) : [] };
  }
  function compactPlayers(players, input, ownSlot) {
    const p = compactPreferences(input), key = n => String(n).normalize('NFKC').toLocaleLowerCase('en-US');
    const pins = p.pins.map(key), rank = r => { const indexes = [r.originalName, r.name].filter(Boolean).map(n => pins.indexOf(key(n))).filter(n => n >= 0); return indexes.length ? Math.min(...indexes) : Infinity; };
    return players.filter(r => p.filter === 'active' ? !r.stopped : p.filter === 'self' ? r.slot === ownSlot : true).map((r,i)=>({r,i})).sort((a,b) => {
      const pin = rank(a.r) - rank(b.r);
      if (!Number.isNaN(pin) && pin) return pin;
      if(p.sort === 'name') return a.r.name.localeCompare(b.r.name) || a.i-b.i;
      if(p.sort === 'progress') {
        const progress = r => r.checkProgress?.total > 0 ? r.checkProgress.checked/r.checkProgress.total : -1;
        return progress(b.r)-progress(a.r) || a.i-b.i;
      }
      return a.i-b.i;
    }).map(x=>x.r);
  }
  const api = {compactPreferences,compactPlayers};
  if(typeof module !== 'undefined' && module.exports) module.exports=api; else root.CompactStats=api;
})(globalThis);
