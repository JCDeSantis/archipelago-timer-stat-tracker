const {test}=require('node:test');
const assert=require('node:assert/strict');
const {reviewTimeline,compareRaces}=require('../src/race-review');
const {compactPreferences,compactPlayers}=require('../src/compact-stats');
const {GlobalHotkeys,hotkeyPreferences}=require('../src/global-hotkeys');
function record(id='a',offset=0) {
  const start=1800000000000+offset;
  return {id,seed:'same-world',team:0,run:{startedAt:start},allFinished:true,groupFinishedAt:start+700000,
    stats:{elapsedMs:700000},quality:{uncertain:false,gaps:[]},
    players:[{slot:1,name:'Link',originalName:'Link',game:'Zelda',completed:true,stopped:true,finishedAt:start+700000,stats:{elapsedMs:700000,checksCompleted:2,longestBKMs:450000}}],
    reviewChecks:[{slot:1,location:10,at:start+100000},{slot:1,location:11,at:start+550000}],
    events:[{id:'go',type:'context',slot:1,state:'gomode',at:start+600000,message:'Link marked Go mode.'}]};
}
test('timeline scrubs recorded checks and BK gaps without generating timestamps for recovered totals',()=>{
  const r=record();r.players[0].checkProgress={checked:8,total:10};
  r.events.push({id:'repair',type:'sync',at:r.run.startedAt+650000,message:'6 counts recovered'});
  const t=reviewTimeline(r,{untilMs:300000});
  assert.equal(t.checks,1);assert.equal(t.events.filter(e=>e.type==='check').length,1);
  assert.equal(t.endMs,700000);assert.equal(t.intervals.length,1);
  assert.equal(reviewTimeline(r).checks,2);assert.equal(reviewTimeline(r,{slot:2}).checks,0);
  assert.equal(reviewTimeline(r,{untilMs:-5}).untilMs,0);
  delete r.reviewChecks;assert.equal(reviewTimeline(r).checkTimesAvailable,false);assert.deepEqual(reviewTimeline(r).intervals,[]);
});
test('same-seed comparisons match worlds and keep unknown, excluded and released outcomes distinct',()=>{
  const a=record(),b=record('b',10000000);b.players[0].stats.elapsedMs=710000;b.stats.elapsedMs=710000;
  const c=compareRaces(a,b);assert.equal(c.runners[0].finish.delta,-10000);assert.equal(c.group.delta,-10000);assert.equal(c.runners[0].goMode.delta,0);
  b.quality.uncertain=true;assert.equal(compareRaces(a,b).runners[0].bk.delta,null);
  b.players[0].completed=false;b.players[0].released=true;assert.equal(compareRaces(a,b).runners[0].finish.baseline,null);assert.equal(compareRaces(a,b).group.delta,null);
  b.players[0].game='Metroid';assert.equal(compareRaces(a,b).runners[0].matched,false);
  b.excluded=true;assert.throws(()=>compareRaces(a,b),/Excluded/);b.excluded=false;b.seed='other';assert.throws(()=>compareRaces(a,b),/same seed/);
});
test('compact preferences retain names, filter before pins and sort unknown progress last without mutating roster',()=>{
  const p=[{slot:1,name:'Z',stopped:true,checkProgress:{checked:4,total:10}},{slot:2,name:'B',stopped:false},{slot:3,name:'A',stopped:false,checkProgress:{checked:2,total:10}}];
  assert.deepEqual(compactPlayers(p,{sort:'name',pins:['B']},1).map(p=>p.slot),[2,3,1]);
  assert.deepEqual(compactPlayers(p,{filter:'active',pins:['Z']},1).map(p=>p.slot),[2,3]);
  assert.deepEqual(compactPlayers(p,{filter:'self'},1).map(p=>p.slot),[1]);
  assert.deepEqual(compactPlayers(p,{sort:'progress'},1).map(p=>p.slot),[1,3,2]);
  assert.equal(p[0].slot,1);assert.deepEqual(compactPreferences({columns:[]}).columns,[]);
});
test('global hotkeys are opt-in, reject duplicates and roll back when another app owns a shortcut',()=>{
  const registered=new Map(),calls=[];
  const h=new GlobalHotkeys({register:(key,fn)=>{if(key==='Control+X')return false;registered.set(key,fn);return true;},unregister:key=>registered.delete(key)},action=>calls.push(action));
  h.apply({});assert.equal(registered.size,0);
  h.apply({enabled:true});assert.equal(registered.size,7);
  registered.get(h.preferences.bindings.gomode)();assert.deepEqual(calls,['gomode']);
  assert.throws(()=>h.apply({enabled:true,bindings:{gomode:'Control+X'}}),/unavailable/);assert.equal(registered.size,7);assert.equal(h.preferences.enabled,true);
  assert.throws(()=>hotkeyPreferences({bindings:{gomode:'G'}}),/modified/);
  assert.throws(()=>hotkeyPreferences({bindings:{gomode:'Control+G',playing:'Ctrl+G'}}),/different/);
  h.apply({enabled:false});assert.equal(registered.size,0);
});
