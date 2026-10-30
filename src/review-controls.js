(function() {
  const esc = value=>String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const time = n=>Number.isFinite(n) ? [Math.floor(n/3600000),Math.floor(n/60000)%60,Math.floor(n/1000)%60].map(n=>String(n).padStart(2,'0')).join(':') : 'Unavailable';
  async function mount(panel,id) {
    panel.textContent='Loading race review…';
    const [result,candidates]=await Promise.all([AppTimer.invoke('race-review',{id}),AppTimer.invoke('comparison-list',{id})]);
    if(!panel.isConnected) return;
    if(!result) {panel.textContent='Race review is unavailable.';return;}
    const {record,timeline}=result;
    panel.innerHTML=`<div class="heading"><h3>Race review timeline</h3><button id="review-refresh" type="button">Refresh recording</button></div><p class="note">Recorded events only. Recovered counts do not reveal original check times. Older history may not contain individual checks or Go-mode declarations.</p><div class="fields"><label>Runner<select id="review-runner"><option value="">Entire group</option>${record.players.map(p=>`<option value="${p.slot}">${esc(p.name)}</option>`).join('')}</select></label><label>Events<select id="review-kind"><option value="all">All events</option><option value="check">Checks</option><option value="context">Declared statuses</option><option value="finish">Completion / release</option><option value="gap">Recording gaps</option><option value="sync">Recovered counts</option></select></label></div><label>Race position <output id="review-position"></output><input id="review-slider" type="range" min="0" max="${timeline.endMs}" step="1" value="${timeline.endMs}"></label><div id="review-track" class="review-track" aria-label="Recorded checks and recording gaps"></div><p id="review-summary" class="note" role="status"></p><div class="actions"><button id="review-prev" type="button">Previous event</button><button id="review-next" type="button">Next event</button></div><ol id="review-events" class="review-events"></ol><h3>Same-seed comparisons</h3><p class="note">Only attempts from the same seed and team are offered. Runners must match original slot, username and game. Excluded attempts are omitted. Negative time differences mean this attempt took less time.</p><div class="fields"><label>Compare with<select id="comparison-baseline"><option value="">Choose another attempt</option>${(candidates?.records || []).map(r=>`<option value="${r.id}">${esc(r.title)} · ${esc(new Date(r.startedAt).toLocaleString())}${r.allFinished?'':' · unfinished'}</option>`).join('')}</select></label><label>Runner metric<select id="comparison-metric"><option value="finish">Completion time</option><option value="firstCheck">First recorded check</option><option value="goMode">First recorded Go-mode declaration</option><option value="checks">Recorded checks</option><option value="bk">Longest BK</option></select></label></div><div id="comparison-results" role="status"></div>`;
    const el=id=>panel.querySelector('#'+id);
    el('review-refresh').onclick=()=>mount(panel,id);
    function selectedEvents() {
      const slot=Number(el('review-runner').value)||null,kind=el('review-kind').value;
      return timeline.events.filter(e=>(slot===null||e.slot===slot||['start','finish','gap','sync'].includes(e.type)) && (kind==='all'||kind==='finish'&&['goal','release','finish'].includes(e.type)||e.type===kind));
    }
    function draw() {
      const until=Number(el('review-slider').value),slot=Number(el('review-runner').value)||null;
      el('review-position').textContent=time(until)+' / '+time(timeline.endMs);
      const checks=timeline.events.filter(e=>e.type==='check'&&e.elapsedMs<=until&&(slot===null||e.slot===slot)).length;
      const bk=timeline.intervals.filter(i=>(slot===null||i.slot===slot)&&Math.min(until,i.toMs)-i.fromMs>=300000);
      el('review-summary').textContent=`${timeline.checkTimesAvailable?checks+' recorded checks at this position':'Individual check times unavailable in this recording'}. ${bk.length} observed check gap(s) of at least five minutes${record.quality.uncertain?' · Recording coverage uncertain':''}.`;
      const events=selectedEvents().filter(e=>e.elapsedMs<=until);
      el('review-events').innerHTML=events.slice(-100).map(e=>`<li data-kind="${esc(e.type)}"><time>${time(e.elapsedMs)}</time>${esc(e.message)}</li>`).join('') || '<li>No matching events at this position.</li>';
      if(events.length>100) el('review-summary').textContent+=' Showing the latest 100 events; move the slider to review earlier events.';
      const dots=timeline.events.filter(e=>e.type==='check'&&(slot===null||e.slot===slot));
      const stride=Math.max(1,Math.ceil(dots.length/500));
      el('review-track').replaceChildren();
      for(const e of dots.filter((_,i)=>i%stride===0)) { const mark=document.createElement('span');mark.className='review-mark';mark.style.left=`${100*e.elapsedMs/Math.max(1,timeline.endMs)}%`;mark.title=time(e.elapsedMs)+': recorded check';el('review-track').append(mark); }
      for(const g of timeline.gaps) { const mark=document.createElement('span');mark.className='review-mark gap';mark.style.left=`${100*g.elapsedMs/Math.max(1,timeline.endMs)}%`;mark.style.width=`${100*Math.max(0,g.endMs-g.elapsedMs)/Math.max(1,timeline.endMs)}%`;mark.title=g.message;el('review-track').append(mark); }

      el('review-prev').disabled=!selectedEvents().some(e=>e.elapsedMs<until);
      el('review-next').disabled=!selectedEvents().some(e=>e.elapsedMs>until);
    }
    for(const name of ['review-slider','review-runner','review-kind']) el(name).addEventListener(name==='review-slider'?'input':'change',draw);
    for(const direction of ['prev','next']) el('review-'+direction).onclick=()=>{const now=Number(el('review-slider').value),events=selectedEvents().filter(e=>direction==='prev'?e.elapsedMs<now:e.elapsedMs>now);const event=direction==='prev'?events.at(-1):events[0];if(event){el('review-slider').value=event.elapsedMs;draw();}};
    let comparison=null,requestId=0;
    const format=(n,checks)=>Number.isFinite(n)?checks?String(n):time(n):'Unavailable';
    const delta=(n,checks)=>Number.isFinite(n)?(n<0?'−':n>0?'+':'')+format(Math.abs(n),checks):'Unavailable';
    function drawComparison() {
      if(!comparison) return;
      const key=el('comparison-metric').value,checks=key==='checks',c=comparison;
      el('comparison-results').innerHTML=`<p class="note">Group time: ${time(c.group.current)} vs ${time(c.group.baseline)} · Difference: ${delta(c.group.delta,false)}${!c.sameRoster?' · Selected rosters differ':''}${c.uncertain?' · Recording coverage uncertain: check/BK differences withheld':''}</p><div class="table-wrap"><table class="comparison-table"><thead><tr><th>Runner / game</th><th>This attempt</th><th>Other attempt</th><th>Difference</th></tr></thead><tbody>${c.runners.map(p=>`<tr><td>${esc(p.name)}<small class="game">${esc(p.game)}${p.matched?'':' · no matching world'}</small></td><td>${format(p[key].current,checks)}</td><td>${format(p[key].baseline,checks)}</td><td>${delta(p[key].delta,checks)}</td></tr>`).join('')}</tbody></table></div>`;
    }
    el('comparison-baseline').onchange=async()=>{
      const seq=++requestId;comparison=null;el('comparison-results').textContent='';
      if(!el('comparison-baseline').value) return;
      const result=await AppTimer.invoke('race-compare',{id,baselineId:el('comparison-baseline').value});
      if(!panel.isConnected||seq!==requestId) return;
      if(result){comparison=result.comparison;drawComparison();}else el('comparison-results').textContent='These attempts could not be compared. Excluded runs are ineligible.';
    };
    el('comparison-metric').onchange=drawComparison;
    draw();
  }
  window.RaceReviewUI={mount};
})();
