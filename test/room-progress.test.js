const { test } = require('node:test');
const assert = require('node:assert/strict');
const { RoomProgress, trackerSource, statusCounts } = require('../src/room-progress');
const id = 'abcdefghijklmnopqrstuv';
const players = [{slot:1,name:'Link',originalName:'Link',game:'Zelda'}, {slot:2,name:'Samus',originalName:'Samus',game:'Metroid'}];
const fixed = {player_locations_total:[{team:0,player:1,total_locations:4},{team:0,player:2,total_locations:6}],player_game:[{team:0,player:1,game:'Zelda'},{team:0,player:2,game:'Metroid'}]};
const live = {player_checks_done:[{team:0,player:1,locations:[101]},{team:0,player:2,locations:[201,202,203]}]};
const status = 'Player Status on team 0:\nLink has 1 connection. (1/4)\nSamus has 0 connections. (3/6)';
function fixture(fetch) {
  const packets = [], urls = [];
  const timer = {time:100000,clock(){return this.time;},now(){return this.time;},players,slot:1,team:0,key:'room-one',socket:{readyState:1},ownLocations:{total:4},
    connection:'connected',hydrated:true,options:{trackerUrl:`https://archipelago.gg/tracker/${id}`},changed(){},send(packet){packets.push(packet);} };
  const progress = new RoomProgress(timer,{fetch:async (url,options) => {urls.push({url,options}); return fetch ? fetch(url,options) : new Response(JSON.stringify(url.includes('static_tracker') ? fixed : live)); }});
  return {timer,progress,packets,urls};
}
test('tracker URLs are normalized and reject credentials, commands, and unrelated paths', () => {
  assert.equal(trackerSource(`https://archipelago.gg/tracker/${id}/0/1`).url,`https://archipelago.gg/tracker/${id}`);
  assert.equal(trackerSource(`https://archipelago.gg/tracker/${id}/A%20Link%20to%20the%20Past`).url,`https://archipelago.gg/tracker/${id}`);
  assert.equal(trackerSource(''),null);
  for(const url of ['file:///private','https://user:password@example.test/room/'+id,'https://example.test/room/'+id+'?password=x','https://example.test/unrelated/'+id]) assert.throws(()=>trackerSource(url));
});
test('tracker provides every runner without other app instances and respects endpoint cache intervals', async () => {
  const f=fixture(); await f.progress.refresh();
  assert.deepEqual(f.progress.progress(players[1],null,{}),{checked:3,total:6,syncedAt:100000,source:'Tracker API'});
  assert.equal(f.packets.length,0,'successful API sync sends no chat command');
  f.timer.time+=30000; await f.progress.refresh(); assert.equal(f.urls.length,2);
  f.timer.time+=30000; await f.progress.refresh(); assert.equal(f.urls.length,3,'only dynamic data refreshes after 60 seconds');
  assert.ok(f.urls.every(r=>r.options.redirect==='error' && !r.options.headers.Authorization));
  assert.equal(f.progress.progress(players[1],null,{204:123}).checked,4,'known live checks merge without creating timestamps');
});
test('room URLs discover tracker id and reject rosters that do not match the connection', async () => {
  const f=fixture(url=>new Response(JSON.stringify(url.includes('room_status')?{tracker:id,players:[['Link','Zelda'],['Samus','Metroid']]}:url.includes('static_tracker')?fixed:live)));
  f.timer.options.trackerUrl=`https://archipelago.gg/room/${id}`; await f.progress.refresh();
  assert.equal(f.urls.length,3); assert.equal(f.progress.counts.size,2);
  const wrong=fixture(()=>new Response(JSON.stringify({tracker:id,players:[['Someone else','Zelda']]})));
  wrong.timer.options.trackerUrl=`https://archipelago.gg/room/${id}`; await wrong.progress.refresh();
  assert.equal(wrong.progress.counts.size,0); assert.equal(wrong.packets[0].text,'!status');
});
test('API failure falls back to a rate-limited status query and only accepts the server command response', async () => {
  const f=fixture(()=>{throw new Error('offline');}); await f.progress.refresh(); await f.progress.refresh();
  assert.equal(f.packets.length,1); assert.equal(f.packets[0].text,'!status');
  assert.equal(f.progress.receive({cmd:'PrintJSON',type:'Chat',data:[{text:status}]}),false);
  assert.equal(f.progress.receive({cmd:'PrintJSON',type:'CommandResult',data:[{text:status}]}),true);
  assert.equal(f.progress.counts.get(2).checked,3); assert.equal(f.progress.source,'!status');
  f.progress.checked(2,204); assert.equal(f.progress.progress(players[1],null,{}).checked,4);
  assert.equal(statusCounts(status,players,1),null,'wrong team cannot change counters');
  assert.equal(statusCounts(status,[...players,{...players[1],slot:3}],0).has(2),false,'ambiguous names are skipped');
});
test('late API responses cannot apply after changing rooms', async () => {
  let resolve; const pending=new Promise(r=>resolve=r);
  const f=fixture(async url=>{await pending;return new Response(JSON.stringify(url.includes('static_tracker')?fixed:live));});
  const refresh=f.progress.refresh(); f.progress.reset(); f.timer.key='different-room'; resolve(); await refresh;
  assert.equal(f.progress.counts.size,0); assert.equal(f.progress.pending,false);
});

test('count recovery explains only unseen additions, coalesces racers and never invents check times', async () => {
  const f=fixture(); await f.progress.refresh();
  assert.equal(f.progress.recoveries.length,0,'initial baseline stays quiet');
  f.progress.checked(2,204);
  f.progress.applyCounts(new Map([[1,{checked:2,total:4}],[2,{checked:6,total:6}]]),'!status');
  assert.equal(f.progress.recoveries.length,1);
  assert.match(f.progress.recoveries[0].message,/Link \+1; Samus \+2/);
  assert.match(f.progress.recoveries[0].message,/Original check times are unknown/);
  assert.equal(f.timer.checks,undefined);
  f.progress.applyCounts(new Map([[1,{checked:2,total:4}],[2,{checked:6,total:6}]]),'!status');
  assert.equal(f.progress.recoveries.length,1,'unchanged polls do not repeat explanations');
  f.progress.cancel();assert.equal(f.progress.recoveries.length,1,'disconnect retains the explanation');
});
