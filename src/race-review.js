const known = n => Number.isFinite(n) && n >= 0;
function reviewTimeline(record, {untilMs, slot = null} = {}) {
  const start=record.run.startedAt;
  const latest=(record.events || []).reduce((last,e)=>known(e.at)?Math.max(last,e.at):last,start);
  const end=Math.max(0,(record.groupFinishedAt ?? record.observedThrough ?? (record.importedLegacy?latest:record.lastSeenAt) ?? latest)-start);
  const until=Number.isFinite(untilMs) ? Math.min(end,Math.max(0,untilMs)) : end;
  const players=record.players.filter(p=>slot === null || p.slot === slot), slots=new Set(players.map(p=>p.slot));
  const checks=(record.reviewChecks || []).filter(c=>slots.has(c.slot) && c.at >= start && c.at <= start+end);
  const events=(record.events || []).filter(e=>known(e.at) && e.at>=start && (slot === null || e.slot === slot || e.type === 'start' || e.type === 'finish'))
    .map(e=>({...e,elapsedMs:e.at-start}));
  for(const c of checks) events.push({id:`check:${c.slot}:${c.location}`,slot:c.slot,type:'check',at:c.at,elapsedMs:c.at-start,message:`${players.find(p=>p.slot===c.slot)?.name || 'Runner'} recorded a check.`});
  const gaps=(record.quality?.gaps || []).filter(g=>g.from<=start+end && (g.to===null || g.to>=start)).map((g,i)=>({id:`gap:${i}`,type:'gap',at:g.from,elapsedMs:Math.max(0,g.from-start),message:`Recording gap: ${g.kind}; check times may be missing.`,endMs:Math.min(end,Math.max(0,(g.to ?? start+end)-start))}));
  events.push(...gaps);
  const intervals=[];
  for(const p of Array.isArray(record.reviewChecks)?players:[]) {
    const times=[start,...checks.filter(c=>c.slot===p.slot).map(c=>c.at)].sort((a,b)=>a-b);
    times.push(Math.min(start+end,p.finishedAt ?? start+end));
    for(let i=1;i<times.length;i++) if(times[i]-times[i-1]>=300000) intervals.push({slot:p.slot,name:p.name,fromMs:times[i-1]-start,toMs:times[i]-start,uncertain:!!record.quality?.uncertain});
  }
  return {endMs:end,untilMs:until,checkTimesAvailable:Array.isArray(record.reviewChecks),
    checks:checks.filter(c=>c.at<=start+until).length,
    events:events.filter(e=>e.elapsedMs<=until).sort((a,b)=>a.at-b.at || a.id.localeCompare(b.id)), gaps, intervals};
}
function compareRaces(current, baseline) {
  if(!current.seed || current.seed !== baseline.seed || current.team !== baseline.team) throw new Error('Choose runs from the same seed and team.');
  if(current.id === baseline.id) throw new Error('Choose a different attempt.');
  if(current.excluded || baseline.excluded) throw new Error('Excluded runs are not eligible for comparisons.');
  const identity = p=>JSON.stringify([p.slot,p.originalName || p.name,p.game]);
  const runners=current.players.map(p=>{
    const matches=baseline.players.filter(q=>identity(p)===identity(q));
    const q=matches.length===1?matches[0]:null;
    const first=(r,runner)=>(r.reviewChecks || []).filter(c=>c.slot===runner.slot).reduce((min,c)=>Math.min(min,c.at-r.run.startedAt),Infinity);
    const go=(r,runner)=>(r.events || []).filter(e=>e.slot===runner.slot && e.type==='context' && e.state==='gomode').reduce((min,e)=>Math.min(min,e.at-r.run.startedAt),Infinity);
    const metric=(a,b,available=true)=>({current:known(a)?a:null,baseline:known(b)?b:null,delta:available&&known(a)&&known(b)?a-b:null});
    return {slot:p.slot,name:p.name,game:p.game,matched:!!q,
      firstCheck:q?metric(first(current,p),first(baseline,q)):metric(null,null),
      goMode:q?metric(go(current,p),go(baseline,q)):metric(null,null),
      finish:q?metric(p.completed?p.stats.elapsedMs:null,q.completed?q.stats.elapsedMs:null):metric(null,null),
      checks:q?metric(p.stats.checksCompleted,q.stats.checksCompleted,!current.quality?.uncertain&&!baseline.quality?.uncertain):metric(null,null),
      bk:q?metric(p.stopped?p.stats.longestBKMs:null,q.stopped?q.stats.longestBKMs:null,!current.quality?.uncertain&&!baseline.quality?.uncertain):metric(null,null)};
  });
  const sameRoster=current.players.length===baseline.players.length&&runners.every(p=>p.matched);
  const a=current.allFinished?current.stats.elapsedMs:null,b=baseline.allFinished?baseline.stats.elapsedMs:null;
  return {sameRoster,uncertain:!!current.quality?.uncertain||!!baseline.quality?.uncertain,
    group:{current:known(a)?a:null,baseline:known(b)?b:null,delta:sameRoster&&current.players.every(p=>p.completed)&&baseline.players.every(p=>p.completed)&&known(a)&&known(b)?a-b:null},runners};
}
module.exports={reviewTimeline,compareRaces};
