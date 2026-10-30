(function () {
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const { featurePreferences, eventRule, CountdownCues, builtInSounds } = RaceFeatureRules;
  const cues = new CountdownCues();
  let customSounds = [];
  const soundBuffers = new Map(), pendingSounds = new Map(), activeSounds = new Set();
  let warmedSoundChoices = '';
  let playbackGeneration = 0;
  function soundOptions(value) {
    const options = [...builtInSounds, ...customSounds];
    if (!options.some(s => s.id === value)) options.push({ id: value, name: 'Missing custom sound (Classic fallback)' });
    return options.map(s => `<option value="${esc(s.id)}"${s.id === value ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  }
  let snapshot = null, workspace = 'live', preferences = featurePreferences(), meta = { racers: [], profiles: [] };
  let historyFilter = 'tracked', historyQuery = '', historyId = null, lastRevision = -1, historyRefresh = null;
  let preview = null, previewId = null, cardRecord = null, awardRecord = null, profileEditing = null;
  let audio = null, lastSoundAlert = '', preferredViewApplied = false;
  const names = { sync: 'Recovered check counts', goal: 'Runner completed', release: 'Runner released', finish: 'Group finished', checks: 'Check milestones', half: 'Over-half progress', bk: 'Other-runner BK', ready: 'Ready confirmations', start: 'Race started', first: 'First check', recovery: 'BK recovery', activity: 'Group activity resumed', watch: 'Watched item found', progression: 'Progression while waiting', hint: 'New relevant hint', hintfound: 'Watched hint found', hintpoints: 'Hint affordable', context: 'Runner declared status', digest: 'Item burst summary' };
  const ms = value => Number.isFinite(value) && value >= 0 ? [Math.floor(value / 3600000), Math.floor(value / 60000) % 60, Math.floor(value / 1000) % 60].map(n => String(n).padStart(2, '0')).join(':') : 'Unavailable';
  const date = value => Number.isFinite(new Date(value).valueOf()) ? new Date(value).toLocaleString() : 'Unknown date';
  const bk = value => Number.isFinite(value) && value < 300000 ? 'N/A' : ms(value);
  const displayName = (p, identities = false) => identities && p.identity ? p.identity.name : p.originalName || p.name;
  function notice(message) { el('feature-notice').textContent = message; el('feature-notice').hidden = !message; }
  async function request(action, input = {}) {
    const result = await AppTimer.invoke(action, input);
    if (!result) {
      const message = el('error').textContent || 'The action could not be completed.';
      notice(message);
      if (el('share-results-dialog').open) el('preview-feedback').textContent = message;
      if (el('finish-card-dialog').open) el('card-feedback').textContent = message;
    }
    return result;
  }
  async function loadMeta() { const result = await request('library-meta'); if (result) meta = result; return !!result; }
  async function chooseWorkspace(value) {
    closeHistory();
    stopSounds();
    if (document.body.classList.contains('timer-only') && !await AppTimer.setTimerOnly(false)) return;
    workspace = value;
    document.body.dataset.workspace = value;
    el('workspace-panel').hidden = value === 'live';
    document.querySelectorAll('[data-workspace]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.workspace === value)));
    notice('');
    if (value === 'history') await showHistory();
    if (value === 'profiles') await showProfiles();
    if (value === 'alerts') await showAlerts();
    if (value === 'health') showHealth();
    if (value === 'display') showDisplay();
  }
  async function showHistory() {
    if (!await loadMeta() || workspace !== 'history') return;
    el('workspace-panel').innerHTML = `<div class="heading"><h2>History &amp; racers</h2><button type="button" id="history-import">Import JSON</button></div><div class="fields"><label>Search racer, linked username, race, seed or game<input id="history-query" type="search" value="${esc(historyQuery)}" placeholder="Search past runs"></label><label>Show<select id="history-filter"><option value="tracked">Tracked runs</option><option value="finished">Finished</option><option value="unfinished">Unfinished recordings</option><option value="excluded">Called off / excluded</option><option value="all">All runs</option></select></label></div><p class="note">Called-off runs are retained for recovery and omitted from tracked results and awards. Excluding a run never releases players or changes the shared room timer.</p><p id="history-count" class="note" role="status"></p><div id="history-list"></div><section id="history-detail" hidden></section><details id="racer-identities"><summary>Racer identities &amp; linked usernames</summary><div class="fields"><label>New racer display name<input id="racer-name" maxlength="100"></label><div class="actions"><button type="button" id="racer-create">Create racer</button></div><label>Racer<select id="alias-racer"><option value="">Choose a racer</option>${meta.racers.map(r => `<option value="${r.id}">${esc(r.name)}</option>`).join('')}</select></label><label>Username<input id="alias-name" maxlength="256"></label><label>Game scope<input id="alias-game" value="*" list="known-games" maxlength="256"></label><div class="actions"><button type="button" id="alias-add">Link username</button></div></div><p class="note">Use * for all games, or an exact game name to distinguish reused usernames. Links are local, explicit and reversible; original race names stay intact.</p><div id="alias-list"></div></details>`;
    el('history-filter').value = historyFilter;
    const historyDialog = document.createElement('dialog'); historyDialog.id = 'history-dialog'; historyDialog.setAttribute('aria-label', 'Historical run details');
    const historyDetail = el('history-detail'); historyDetail.before(historyDialog); historyDialog.append(historyDetail);
    const games = document.createElement('datalist'); games.id = 'known-games';
    games.replaceChildren(...[...new Set(['*', ...(snapshot?.players || []).map(p => p.game)])].map(game => new Option(game, game)));
    el('workspace-panel').append(games);
    el('history-query').oninput = () => { historyQuery = el('history-query').value; closeHistory(); el('history-detail').hidden = true; clearTimeout(historyRefresh); historyRefresh = setTimeout(refreshHistory, 150); };
    el('history-filter').onchange = () => { historyFilter = el('history-filter').value; refreshHistory(); };
    el('history-import').onclick = async () => { const result = await request('history-import'); if (result?.record) { historyId = result.record.id; await refreshHistory(); await openHistory(historyId); notice('Imported locally. No room data was changed.'); } };
    el('racer-create').onclick = async () => { const result = await request('racer-create', { name: el('racer-name').value }); if (result) { await loadMeta(); const select = el('alias-racer'); select.replaceChildren(new Option('Choose a racer', ''), ...meta.racers.map(r => new Option(r.name, r.id))); select.value = result.racer.id; el('racer-name').value = ''; renderAliases(); } };
    el('alias-racer').onchange = renderAliases;
    el('alias-add').onclick = async () => { if (await request('alias-add', { racerId: el('alias-racer').value, name: el('alias-name').value, game: el('alias-game').value })) { const selected = el('alias-racer').value; await loadMeta(); el('alias-racer').value = selected; renderAliases(); await refreshHistory(); if (historyId && el('history-dialog')?.open) openHistory(historyId); } };
    renderAliases(); await refreshHistory();
  }
  function renderAliases() {
    const racer = meta.racers.find(r => r.id === el('alias-racer').value);
    el('alias-list').innerHTML = racer ? racer.aliases.map(a => `<div class="alias-row"><span>${esc(a.name)} <span class="muted">(${esc(a.game)})</span></span><button type="button" data-remove-alias="${esc(a.name)}" data-game="${esc(a.game)}">Unlink</button></div>`).join('') || '<p class="note">No usernames linked yet.</p>' : '';
    el('alias-list').querySelectorAll('[data-remove-alias]').forEach(b => b.onclick = async () => { if (await request('alias-remove', { racerId: racer.id, name: b.dataset.removeAlias, game: b.dataset.game })) { await loadMeta(); renderAliases(); refreshHistory(); if (historyId && el('history-dialog')?.open) openHistory(historyId); } });
  }
  async function refreshHistory() {
    if (workspace !== 'history') return;
    const result = await request('history-list', { query: historyQuery, filter: historyFilter });
    if (!result || workspace !== 'history' || !el('history-list')) return;
    el('history-count').textContent = `${result.records.length} run${result.records.length === 1 ? '' : 's'} · called-off runs do not contribute to tracked results`;
    el('history-list').innerHTML = result.records.map(r => `<article class="history-row"><div class="heading"><button type="button" data-history-id="${r.id}">${esc(r.title)}</button><span class="elapsed">${r.allFinished ? ms(r.groupTime) : r.excluded ? 'Called off' : r.id === snapshot?.activeHistoryId && snapshot.connection === 'connected' ? 'In progress' : 'Unfinished'}</span></div><p class="note">${esc(date(r.startedAt))} · ${r.runners.map(p => esc(p.name) + (p.identity ? ' → ' + esc(p.identity) : '')).join(' · ')}</p><p class="note">${r.excluded ? 'Excluded locally' : r.uncertain ? 'Recording coverage uncertain' : 'No known observation gaps'}</p></article>`).join('') || '<p class="note">No matching runs. Races are saved here automatically when a shared start is observed.</p>';
    el('history-list').querySelectorAll('[data-history-id]').forEach(b => b.onclick = () => openHistory(b.dataset.historyId));
  }
  async function openHistory(id) {
    const result = await request('history-get', { id }); if (!result || workspace !== 'history') return;
    historyId = id; const r = result.record, detail = el('history-detail'); detail.hidden = false;
    detail.innerHTML = `<div class="heading"><h2>Run detail</h2><button id="history-track" type="button">${r.excluded ? 'Restore tracking' : 'Call off / exclude this run'}</button></div><div class="fields"><label>Race name<input id="history-title" maxlength="100" value="${esc(r.title)}"></label><div class="actions"><button id="history-rename" type="button">Save name</button><button id="history-export" type="button">Export JSON</button>${!r.allFinished && !r.excluded && r.resumeConnection ? '<button id="history-resume" type="button">Prepare resume</button>' : ''}</div></div><p class="note">${r.excluded ? 'Called off locally. Observations were retained, and tracking can be restored.' : r.allFinished ? 'Total Group Time: ' + ms(r.stats.elapsedMs) : 'Unfinished recording — no completion or group finish has been invented.'}</p><p class="note">Seed ${esc(r.seed)} · team ${r.team + 1} · session ${esc(r.session)}</p>${qualityHTML(r)}<div class="table-wrap"><table><thead><tr><th>Original runner / game</th><th>Status</th><th>Time</th><th>Checks</th><th>Longest BK</th><th>Local identity</th></tr></thead><tbody>${r.players.map(p => `<tr><td>${esc(p.originalName)}<span class="game">${esc(p.game)}</span></td><td>${p.completed ? 'Completed' : p.released ? 'Released' : 'Unfinished'}</td><td class="elapsed">${ms(p.stats.elapsedMs)}</td><td>${p.stats.checksCompleted ?? 'Unavailable'}</td><td class="elapsed">${p.stopped ? bk(p.stats.longestBKMs) : 'In progress'}</td><td><select data-assign-slot="${p.slot}" aria-label="Identity for ${esc(p.originalName)}"><option value="">Use username links</option>${meta.racers.map(racer => `<option value="${racer.id}"${p.identity?.id === racer.id ? ' selected' : ''}>${esc(racer.name)}</option>`).join('')}</select></td></tr>`).join('')}</tbody></table></div><div class="actions" style="margin-top:14px">${r.allFinished && !r.excluded ? '<button id="history-preview" type="button">Result preview</button><button id="history-card" type="button">Finish card</button><button id="history-awards" type="button">Race highlights</button>' : ''}</div>`;
    const review=document.createElement('section');review.className='review-tools';detail.append(review);window.RaceReviewUI.mount(review,id);
    el('history-track').onclick = async () => { if (await request('history-track', { id, tracked: r.excluded })) { await refreshHistory(); await openHistory(id); notice(r.excluded ? 'Tracking restored locally.' : 'Run called off locally. Shared room timers and players are unchanged.'); } };
    el('history-rename').onclick = async () => { if (await request('history-rename', { id, title: el('history-title').value })) refreshHistory(); };
    el('history-export').onclick = () => request('history-export', { id });
    if (el('history-resume')) el('history-resume').onclick = async () => { const result = await request('history-resume', { id }); if (result) { AppTimer.applyDraft(result.draft); await chooseWorkspace('live'); notice('Original session prepared. Enter its room password if required, then connect. The seed, team and saved start will be verified.'); } };
    detail.querySelectorAll('[data-assign-slot]').forEach(select => select.onchange = async () => { if (await request('runner-assign', { runId: id, slot: Number(select.dataset.assignSlot), racerId: select.value || null })) { refreshHistory(); openHistory(id); } });
    if (el('history-preview')) el('history-preview').onclick = () => openPreview(id);
    if (el('history-card')) el('history-card').onclick = () => openCard(id);
    if (el('history-awards')) el('history-awards').onclick = () => openAwards(id);
    const close = document.createElement('button'); close.type = 'button'; close.textContent = 'Close details'; close.onclick = closeHistory;
    detail.querySelector('.heading').append(close);
    if (!el('history-dialog').open) el('history-dialog').showModal();
  }
  function closeHistory() { const dialog = el('history-dialog'); if (dialog?.open) dialog.close(); }
  function qualityHTML(record) {
    const quality = record.quality || {}, gaps = quality.gaps || [];
    return (quality.uncertain ? '<p class="quality-warning">Recording coverage uncertain: checks or finish observations may be missing. Check/BK highlights are withheld.</p>' : '<p class="note">No known recording gaps. Statistics are based on observed events.</p>') +
      (gaps.length || quality.lateJoin ? `<details><summary>Recording details (${gaps.length} gaps)</summary><ul class="note">${gaps.slice(-50).map(g => `<li>${esc(date(g.from))} → ${g.to === null ? 'not observing this run' : esc(date(g.to))} · ${esc(g.kind)}</li>`).join('')}${quality.lateJoin ? '<li>First local observation was after the shared start; full coverage is unverified.</li>' : ''}</ul></details>` : '');
  }
  function showDisplay() {
    const compact=CompactStats.compactPreferences(snapshot?.compactSettings), hotkeys=snapshot?.hotkeys || {enabled:false,bindings:{}};
    const actions={playing:'Playing',waiting:'Waiting',break:'Taking a break',gomode:'Go mode',stats:'Toggle stats',compact:'Toggle Timer Only',mute:'Mute / unmute sounds'};
    el('workspace-panel').innerHTML=`<h2>Display &amp; global hotkeys</h2><h3>Compact statistics</h3><p class="note">Runner names always stay visible. Choose the other fields; only this runner list scrolls after six rows.</p><div class="profile-options">${['game','status','checks','hints','bk'].map(c=>`<label class="inline-check"><input type="checkbox" data-compact-column="${c}"${compact.columns.includes(c)?' checked':''}>${{game:'Game',status:'Declared status',checks:'World checks',hints:'Hints Used',bk:'Longest BK'}[c]}</label>`).join('')}</div><div class="fields"><label>Show runners<select id="compact-filter"><option value="all">All racers</option><option value="active">Unfinished racers</option><option value="self">Only me</option></select></label><label>Sort by<select id="compact-sort"><option value="roster">Race roster order</option><option value="name">Runner name</option><option value="progress">World completion percentage</option></select></label><label>Pinned runners — usernames, one per line<textarea id="compact-pins" rows="3">${esc(compact.pins.join('\n'))}</textarea></label></div><p class="note">Pinned racers appear first, in the order above, within your selected filter. Percentage sorting is for navigation across games, not a skill ranking.</p><button id="compact-save" type="button">Save compact layout</button><h3>Global hotkeys</h3><label class="inline-check"><input id="hotkeys-enabled" type="checkbox"${hotkeys.enabled?' checked':''}>Enable shortcuts while other applications have focus</label><p class="note">Shortcuts do not focus this app or pause the race. Use modified combinations such as Control+Alt+Shift+G. Leave a field blank to disable that action. Shortcuts reserved by another app will be rejected.</p><div class="fields">${Object.entries(actions).map(([action,label])=>`<label>${label}<input data-hotkey="${action}" maxlength="100" value="${esc(hotkeys.bindings[action] || '')}" spellcheck="false"></label>`).join('')}</div><div class="actions"><button id="hotkeys-save" type="button">Save hotkeys</button><button id="sounds-toggle-mute" type="button">${snapshot?.soundsMuted?'Unmute sounds':'Mute sounds temporarily'}</button></div><p id="display-feedback" class="note" role="status">${esc(snapshot?.hotkeyError || '')}</p>`;
    el('compact-filter').value=compact.filter;el('compact-sort').value=compact.sort;
    el('compact-save').onclick=async()=>{
      if(await request('compact-settings',{columns:[...document.querySelectorAll('[data-compact-column]:checked')].map(c=>c.dataset.compactColumn),filter:el('compact-filter').value,sort:el('compact-sort').value,pins:el('compact-pins').value.split('\n')})) el('display-feedback').textContent='Compact layout saved locally.';
    };
    el('hotkeys-save').onclick=async()=>{
      const result=await request('hotkey-settings',{enabled:el('hotkeys-enabled').checked,bindings:Object.fromEntries([...document.querySelectorAll('[data-hotkey]')].map(c=>[c.dataset.hotkey,c.value.trim()]))});
      el('display-feedback').textContent=result ? 'Hotkeys saved. '+(snapshot?.backgroundTest?'Background tests simulate shortcuts without registering system keys.':el('hotkeys-enabled').checked?'Shortcuts are active.':'Shortcuts are disabled.') : el('error').textContent;
    };
    el('sounds-toggle-mute').onclick=()=>request('sound-toggle-mute');
  }
  async function showProfiles() {
    if (!await loadMeta() || workspace !== 'profiles') return;
    el('workspace-panel').innerHTML = `<div class="heading"><h2>Saved race profiles</h2><button id="profile-import" type="button">Import profile</button></div><div class="fields"><label>Saved profile<select id="profile-select"><option value="">New profile</option>${meta.profiles.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></label><label>Profile name<input id="profile-name" maxlength="100"></label><label>Room address<input id="profile-address" maxlength="2048"></label><label>Your slot name<input id="profile-slot" maxlength="128"></label><label>Manual countdown<select id="profile-countdown"><option value="5">5 seconds</option><option value="10">10 seconds</option><option value="30">30 seconds</option><option value="60">60 seconds</option></select></label><label>Preferred runners — one username or display name per line<textarea id="profile-roster" rows="3"></textarea></label></div><div class="profile-options"><label class="inline-check"><input id="profile-ready" type="checkbox" checked>Require ready checks for manual starts</label><label class="inline-check"><input id="profile-follow" type="checkbox" checked>Follow room countdowns</label><label class="inline-check"><input id="profile-top" type="checkbox">Always on top</label><label class="inline-check"><input id="profile-timer-only" type="checkbox">Prefer Timer Only after connecting</label><label class="inline-check"><input id="profile-current-preferences" type="checkbox" checked>Save current alert and sound preferences</label><label class="inline-check"><input id="profile-export-connection" type="checkbox">Include address and slot name in profile export</label></div><div class="actions"><button id="profile-save" type="button">Save profile</button><button id="profile-duplicate" type="button">Save as copy</button><button id="profile-apply" class="primary" type="button">Apply to next setup</button><button id="profile-export" type="button">Export profile</button><button id="profile-delete" type="button">Delete profile</button></div><p class="note">Passwords are never saved. Applying fills setup, suggests a fresh shared session, and does not connect, ready or start the games. Give the new session name to the other runners. Saved rosters are resolved after connecting; missing or ambiguous names block automatic participation until reviewed.</p><p id="profile-feedback" class="note" role="status"></p>`;
    fillProfile(profileEditing || { name: '', address: el('address').value, slotName: el('name').value, countdown: Number(el('countdown').value), requireReady: el('require-ready').checked,
      followRoomCountdown: snapshot?.followRoomCountdown, alwaysOnTop: snapshot?.alwaysOnTop, roster: (snapshot?.players || []).filter(p => !snapshot?.selectedSlots || snapshot.selectedSlots.includes(p.slot)).map(p => p.originalName || p.name) });
    el('profile-select').onchange = () => { profileEditing = meta.profiles.find(p => p.id === el('profile-select').value) || null; showProfiles(); };
    el('profile-save').onclick = () => saveProfile(false);
    el('profile-duplicate').onclick = () => saveProfile(true);
    el('profile-delete').onclick = async () => { if (profileEditing?.id && await request('profile-delete', { id: profileEditing.id })) { profileEditing = null; await showProfiles(); notice('Profile deleted. Race records are unchanged.'); } };
    el('profile-apply').onclick = async () => {
      if (!profileEditing?.id) { notice('Save or select a profile first.'); return; }
      const result = await request('profile-apply', { id: profileEditing.id });
      if (result) { preferredViewApplied = false; AppTimer.applyDraft(result.draft); await chooseWorkspace('live'); el('race-setup').open = true; el('connection-details').open = true; notice(`Next setup prepared. Shared session: ${result.draft.session}. No connection or countdown was started.`); }
    };
    el('profile-export').onclick = () => profileEditing?.id ? request('profile-export', { id: profileEditing.id, includeConnection: el('profile-export-connection').checked }) : notice('Save or select a profile first.');
    el('profile-import').onclick = async () => { const result = await request('profile-import'); if (result?.profileDraft) { profileEditing = { ...result.profileDraft, id: undefined }; fillProfile(profileEditing); notice('Imported into the editor. Review the room and slot fields, then save.'); } };
  }
  function fillProfile(p) {
    for (const [id, value] of [['profile-name', p.name || ''], ['profile-address', p.address || ''], ['profile-slot', p.slotName || ''], ['profile-countdown', p.countdown || 10], ['profile-roster', Array.isArray(p.roster) ? p.roster.join('\n') : '']]) el(id).value = value;
    for (const [id, value] of [['profile-ready', p.requireReady !== false], ['profile-follow', p.followRoomCountdown !== false], ['profile-top', p.alwaysOnTop === true], ['profile-timer-only', p.timerOnly === true]]) el(id).checked = value;
    el('profile-select').value = p.id || '';
    el('profile-current-preferences').checked = !p.id && !p.features;
  }
  async function saveProfile(duplicate) {
    const input = { id: duplicate ? undefined : profileEditing?.id, name: el('profile-name').value + (duplicate ? ' copy' : ''), address: el('profile-address').value, slotName: el('profile-slot').value,
      countdown: Number(el('profile-countdown').value), roster: el('profile-roster').value.split('\n').map(n => n.trim()).filter(Boolean),
      requireReady: el('profile-ready').checked, followRoomCountdown: el('profile-follow').checked, alwaysOnTop: el('profile-top').checked, timerOnly: el('profile-timer-only').checked,
      features: el('profile-current-preferences').checked ? preferences : profileEditing?.features || preferences };
    const result = await request('profile-save', input);
    if (result) { profileEditing = result.profile; await showProfiles(); el('profile-feedback').textContent = 'Profile saved locally, without a room password.'; }
  }
  async function showAlerts() {
    const library = await request('sound-list');
    if (workspace !== 'alerts') return;
    customSounds = library?.sounds || [];
    if (library?.soundError) notice(library.soundError);
    preferences = featurePreferences(snapshot?.featureSettings);
    el('workspace-panel').innerHTML = `<h2>Alerts &amp; countdown sounds</h2><div class="fields"><label>Watched item names — one per line<textarea id="watch-items" rows="3" placeholder="Hookshot&#10;Hammer">${esc(preferences.sounds.watchItems.join('\n'))}</textarea></label><label class="inline-check"><input id="reveal-items" type="checkbox"${preferences.sounds.revealItems ? ' checked' : ''}>Reveal watched item names in alerts</label></div><p class="note">Watch names match your game’s exact item names. These settings only control notifications; hints and locations remain hidden. Retro presets are original synthesized game-style sounds. Audio stays off until enabled.</p><div class="fields"><label>Runner alert scope<select id="alert-scope"><option value="everyone">Everyone</option><option value="others">Other runners</option><option value="self">My runner</option></select></label><label>Sound volume <input id="sound-volume" type="range" min="0" max="100" value="${preferences.sounds.volume}"><span id="sound-volume-value">${preferences.sounds.volume}%</span></label></div><div class="profile-options"><label class="inline-check"><input id="alert-full-view" type="checkbox"${preferences.alerts.fullView ? ' checked' : ''}>Show brief popups in Full View too</label><label class="inline-check"><input id="sound-countdown" type="checkbox"${preferences.sounds.enabled ? ' checked' : ''}>Enable countdown sounds</label><label class="inline-check"><input id="sound-background" type="checkbox"${preferences.sounds.background ? ' checked' : ''}>Allow sounds while another app has focus</label></div><div class="fields"><label>3–2–1 sound<select id="countdown-sound">${soundOptions(preferences.sounds.countdownId)}</select></label><button id="countdown-preview" type="button">Preview 3–2–1 + GO</button><label>GO sound<select id="go-sound">${soundOptions(preferences.sounds.goId)}</select></label><button id="go-preview" type="button">Preview GO</button></div><div class="actions"><button id="sound-import" type="button">Import custom sound</button><label>Saved custom sounds<select id="custom-sound-library"><option value="">Select a sound</option>${customSounds.map(s => `<option value="${esc(s.id)}">${esc(s.name)}</option>`).join('')}</select></label><button id="custom-sound-preview" type="button">Preview saved sound</button><button id="custom-sound-remove" type="button">Remove saved sound</button></div><p class="note">Imported audio is copied into the app and saved across restarts; the original file can be moved. WAV, MP3, OGG, FLAC, M4A and WebM up to 10 MB. Playback is limited to 5 seconds (countdown ticks to 0.8 seconds). Profiles keep sound selections; import the same audio on another computer to use custom choices there.</p><div class="table-wrap"><table><thead><tr><th>Event</th><th>Popup</th><th>Sound</th><th>Sound choice</th><th>Preview</th></tr></thead><tbody>${Object.entries(names).map(([type, name]) => `<tr><td>${name}</td><td><input type="checkbox" data-popup="${type}" aria-label="${name} popup"${preferences.alerts.categories[type].popup ? ' checked' : ''}></td><td><input type="checkbox" data-event-sound="${type}" aria-label="${name} sound"${preferences.alerts.categories[type].sound ? ' checked' : ''}></td><td><select data-sound-choice="${type}" aria-label="${name} sound choice">${soundOptions(preferences.alerts.categories[type].soundId)}</select></td><td><button type="button" data-preview-event="${type}">Preview</button></td></tr>`).join('')}</tbody></table></div><p class="note">Popups last eight seconds. Personal BK has no repeated popups; its live clock is independent. Other-runner BK reminders occur at most every ten minutes. Muted notifications remain in the event log. Countdown sounds follow the confirmed shared start and do not replay missed cues.</p><div class="actions"><button id="preferences-save" class="primary" type="button">Save preferences</button><button id="sound-test" type="button">Play test tone</button><button id="sound-mute-all" type="button">Mute all sounds</button></div><p id="alert-example" class="note" role="status"></p>`;
    el('alert-scope').value = preferences.alerts.scope;
    el('countdown-preview').onclick = previewCountdown;
    el('go-preview').onclick = () => playSound(el('go-sound').value, Number(el('sound-volume').value), true, true);
    el('sound-import').onclick = async () => {
      if (!await savePreferences()) return;
      const result = await request('sound-import');
      if (result?.sound) { await showAlerts(); el('custom-sound-library').value = result.sound.id; el('alert-example').textContent = 'Sound saved. Choose it for countdowns, GO, or any alert and save preferences.'; }
    };
    el('custom-sound-preview').onclick = () => { if (el('custom-sound-library').value) playSound(el('custom-sound-library').value, Number(el('sound-volume').value), true); };
    el('custom-sound-remove').onclick = async () => {
      const id = el('custom-sound-library').value;
      if (!id) return;
      stopSounds();
      if (!await savePreferences()) return;
      if (await request('sound-remove', { id })) { soundBuffers.delete(id); await showAlerts(); el('alert-example').textContent = 'Sound removed. Current selections use built-in fallbacks; saved profiles with this sound also fall back until reimported.'; }
    };
    el('sound-volume').oninput = () => { el('sound-volume-value').textContent = el('sound-volume').value + '%'; };
    el('preferences-save').onclick = savePreferences;
    el('sound-countdown').onchange = () => { if (el('sound-countdown').checked) primeAudio(); };
    document.querySelectorAll('[data-event-sound]').forEach(c => c.onchange = () => { if (c.checked) primeAudio(); });
    el('sound-test').onclick = () => { playSound(el('countdown-sound').value, Number(el('sound-volume').value), true); el('alert-example').textContent = snapshot?.backgroundTest ? 'Audio suppressed during background automated checks.' : 'Test tone requested on the current Windows output.'; };
    el('sound-mute-all').onclick = async () => { stopSounds(); el('sound-countdown').checked = false; document.querySelectorAll('[data-event-sound]').forEach(c => { c.checked = false; }); await savePreferences(); };
    document.querySelectorAll('[data-preview-event]').forEach(b => b.onclick = () => {
      const type = b.dataset.previewEvent;
      el('alert-example').textContent = ({ goal: 'Runner completed their run.', release: 'Runner released their run.', finish: 'Everyone has finished the race.', checks: 'Runner reached 25 recorded checks.', half: 'Runner completed over half of their checks.', bk: 'Another runner has been BK for 00:10:00.', ready: 'Runner is ready.', start: 'The race has started.' })[type] || ({first:'Runner made their first check.',recovery:'Runner checked again after 00:07:42 without a check.',activity:'Group checks resumed after a quiet period.',watch:'An item on your watchlist was found.',progression:'A progression item was found for you while you were waiting.',hint:'A new hint involves your world.',hintfound:'Your watched hint has been found.',hintpoints:'You have enough points for a hint.',context:'Runner marked Go mode.',digest:'Item burst: four items for you, including one watched item.'})[type];
      el('alert-example').classList.toggle('complete', ['goal', 'release', 'finish'].includes(type));
      playSound(document.querySelector(`[data-sound-choice="${type}"]`).value, Number(el('sound-volume').value), true);
    });
  }
  async function savePreferences() {
    const input = { alerts: { scope: el('alert-scope').value, fullView: el('alert-full-view').checked, categories: Object.fromEntries(Object.keys(names).map(type => [type, { popup: document.querySelector(`[data-popup="${type}"]`).checked, sound: document.querySelector(`[data-event-sound="${type}"]`).checked, soundId: document.querySelector(`[data-sound-choice="${type}"]`).value }])) },
      sounds: { enabled: el('sound-countdown').checked, volume: Number(el('sound-volume').value), background: el('sound-background').checked, countdownId: el('countdown-sound').value, goId: el('go-sound').value, watchItems: el('watch-items').value.split('\n'), revealItems: el('reveal-items').checked } };
    if (await request('feature-settings', input)) { preferences = featurePreferences(input); el('alert-example').textContent = 'Preferences saved. Existing events are not replayed.'; return true; }
    return false;
  }
  function stopSounds() {
    playbackGeneration++;
    for (const source of activeSounds) { try { source.stop(); } catch {} }
    activeSounds.clear();
  }
  function soundFeedback(message) { if (workspace === 'alerts' && el('alert-example')) el('alert-example').textContent = message; }
  function previewCountdown() {
    stopSounds();
    const generation = playbackGeneration, id = el('countdown-sound').value, go = el('go-sound').value, volume = Number(el('sound-volume').value);
    for (let i = 0; i < 4; i++) setTimeout(() => { if (generation === playbackGeneration && workspace === 'alerts') playSound(i === 3 ? go : id, volume, true, i === 3, i !== 3); }, i * 1000);
  }
  async function customBuffer(id) {
    if (soundBuffers.has(id)) return soundBuffers.get(id);
    if (pendingSounds.has(id)) return pendingSounds.get(id);
    const pending = (async () => {
      const result = await AppTimer.invoke('sound-read', { id });
      if (!result) throw new Error('Saved sound unavailable');
      const bytes = Uint8Array.from(atob(result.data), c => c.charCodeAt(0));
      audio ||= new AudioContext();
      const buffer = await audio.decodeAudioData(bytes.buffer);
      if (buffer.length * buffer.numberOfChannels * 4 > 32 * 1024 * 1024) throw new Error('Choose a shorter audio clip.');
      soundBuffers.set(id, buffer);
      let bytesUsed = () => [...soundBuffers.values()].reduce((n, b) => n + b.length * b.numberOfChannels * 4, 0);
      while (soundBuffers.size > 8 || bytesUsed() > 32 * 1024 * 1024) soundBuffers.delete(soundBuffers.keys().next().value);
      return buffer;
    })();
    pendingSounds.set(id, pending);
    try { return await pending; } finally { pendingSounds.delete(id); }
  }
  function warmSounds() {
    if (snapshot?.backgroundTest) return;
    const ids = [...new Set([preferences.sounds.countdownId, preferences.sounds.goId, ...Object.values(preferences.alerts.categories).map(rule => rule.soundId)])].filter(id => customSounds.some(s => s.id === id));
    const key = ids.join(',');
    if (key === warmedSoundChoices) return;
    warmedSoundChoices = key;
    for (const id of ids) customBuffer(id).catch(() => soundFeedback('A saved sound could not be decoded. Try a shorter WAV or MP3 file.'));
  }
  async function playSound(id, volume, deliberate = false, go = false, tick = false) {
    if (snapshot?.soundsMuted || snapshot?.backgroundTest || !volume || (!deliberate && !preferences.sounds.background && !document.hasFocus())) return;
    const generation = playbackGeneration, requestedAt = performance.now();
    try {
      audio ||= new AudioContext(); await audio.resume();
      if (generation !== playbackGeneration) return;
      if (id.startsWith('custom:') && customSounds.some(s => s.id === id)) {
        const buffer = await customBuffer(id);
        if (!deliberate && tick && performance.now() - requestedAt > 400) return;
        if (generation !== playbackGeneration || (!deliberate && !preferences.sounds.background && !document.hasFocus())) return;
        const source = audio.createBufferSource(), gain = audio.createGain();
        source.buffer = buffer;
        const duration = Math.min(buffer.duration, tick ? .8 : 5);
        gain.gain.setValueAtTime(volume / 100, audio.currentTime);
        gain.gain.setValueAtTime(volume / 100, audio.currentTime + Math.max(0, duration - .03));
        gain.gain.linearRampToValueAtTime(0, audio.currentTime + duration);
        source.connect(gain); gain.connect(audio.destination); activeSounds.add(source);
        source.onended = () => { activeSounds.delete(source); source.disconnect(); gain.disconnect(); };
        source.start(0, 0, duration);
        return;
      }
      if (id.startsWith('custom:')) soundFeedback('Custom sound missing on this computer. Playing Classic beep; reimport the audio to restore it.');
      const patterns = { classic: [go ? 1047 : 660], soft: [523, 659], arcade: [523, 784, 1047], bell: [880, 1320], 'retro-pulse': [go ? 1175 : 587], 'retro-item': [523, 698, 880, 1175], 'retro-secret': [740, 554, 831, 1109], 'retro-heart': [784, 988], 'retro-fanfare': [587, 740, 880, 1175, 1480] };
      const notes = patterns[id] || patterns.classic;
      notes.forEach((frequency, i) => {
        const oscillator = audio.createOscillator(), gain = audio.createGain(), at = audio.currentTime + i * .075;
        oscillator.type = id.startsWith('retro-') ? 'square' : id === 'arcade' ? 'triangle' : 'sine'; oscillator.frequency.value = frequency;
        gain.gain.setValueAtTime(volume / 100 * (id.startsWith('retro-') ? .055 : .15), at);
        gain.gain.exponentialRampToValueAtTime(.0001, at + (id === 'bell' ? .45 : .22));
        oscillator.connect(gain); gain.connect(audio.destination); activeSounds.add(oscillator);
        oscillator.start(at); oscillator.stop(at + .5);
        oscillator.onended = () => { activeSounds.delete(oscillator); oscillator.disconnect(); gain.disconnect(); };
      });
    } catch { soundFeedback('This audio could not be played. Try a different file or convert it to WAV or MP3.'); }
  }
  function primeAudio() {
    if (snapshot?.backgroundTest) return;
    try { audio ||= new AudioContext(); audio.resume().catch(() => {}); } catch { /* Audio is optional. */ }
  }
  function showHealth() {
    el('workspace-panel').innerHTML = `<h2>Connection &amp; recording health</h2><div id="health-details"></div><div class="fields"><label>Room or tracker URL (optional)<input id="tracker-source-url" type="url" maxlength="2048" value="${esc(snapshot?.trackerUrl || '')}" placeholder="https://archipelago.gg/room/…"></label><button id="tracker-source-save" type="button">Use this source</button></div><p class="note">Use the URL for the room you are connected to. Tracker data is cached for 60 seconds. With no URL, or if the API fails, the app requests !status from your existing connection for everyone’s counts. Hints remain best-effort.</p><button id="progress-sync" type="button">Sync progress now</button><button id="health-open-history" type="button">Open race history</button><p class="note">The room clock continues through disconnects. Reconnecting does not erase earlier observation gaps; other observers may recover some shared results. A quiet room is not treated as a disconnect merely because nobody sends a check.</p>`;
    el('tracker-source-save').onclick = async () => { if (await request('tracker-source', { url: el('tracker-source-url').value })) { el('trackerUrl').value = snapshot.trackerUrl; notice('Room count source saved.'); } };
    el('progress-sync').onclick = () => request('sync-progress');
    el('health-open-history').onclick = () => chooseWorkspace('history'); updateHealth();
  }
  function updateHealth() {
    if (!snapshot) return;
    const connected = snapshot.connection === 'connected' && snapshot.hydrated;
    const stale = connected && snapshot.health?.lastPacketAt && Date.now() - snapshot.health.lastPacketAt > 45000;
    const uncertain = snapshot.recordQuality?.uncertain;
    const status = snapshot.trackingExcluded ? 'Excluded locally' : stale ? 'Waiting for room data' : connected ? snapshot.historyError ? 'Connected · history unavailable' : uncertain ? 'Connected · earlier recording gap' : 'Connected · recording live' : snapshot.connection === 'reconnecting' || snapshot.connection === 'connecting' ? 'Reconnecting · clock continues' : 'Not connected';
    el('health-indicator').textContent = document.body.classList.contains('timer-only') ? snapshot.trackingExcluded ? 'Excluded' : connected ? uncertain ? 'Live · gaps' : 'Live' : snapshot.connection === 'connecting' || snapshot.connection === 'reconnecting' ? 'Reconnecting' : 'Offline' : status;
    el('health-indicator').title = status;
    el('health-indicator').setAttribute('aria-label', status + '. Open connection health.');
    el('health-indicator').className = connected && !uncertain && !stale && !snapshot.trackingExcluded ? 'healthy' : 'health-warning';
    if (workspace !== 'health' || !el('health-details')) return;
    el('tracker-source-save').disabled = snapshot.connection !== 'connected' || !snapshot.hydrated;
    el('progress-sync').disabled = snapshot.connection !== 'connected' || !snapshot.hydrated || snapshot.health?.progressPending;
    const last = snapshot.health?.lastPacketAt;
    el('health-details').innerHTML = `<p class="health-summary">${esc(status)}</p><dl class="health-grid"><dt>Last room response</dt><dd>${last ? Math.max(0, Math.floor((Date.now() - last) / 1000)) + ' seconds ago' : 'Not received'}</dd><dt>All-player counts</dt><dd>${esc(snapshot.health?.roomCounts?.source || 'Waiting')}${snapshot.health?.roomCounts?.at ? ' · ' + esc(date(snapshot.health.roomCounts.at)) : ''}${snapshot.health?.roomCounts?.pending ? ' · Fetching tracker…' : ''}${snapshot.health?.roomCounts?.error ? ' · ' + esc(snapshot.health.roomCounts.error) : ''}</dd><dt>Last recovered counts</dt><dd>${esc(snapshot.health?.roomCounts?.recovery?.message || 'None since connecting')}</dd><dt>World progress sync</dt><dd>${snapshot.health?.progressPending ? 'Refreshing server snapshot…' : snapshot.health?.progressSyncAt ? esc(date(snapshot.health.progressSyncAt)) : 'Not available'} · automatic refresh every minute</dd><dt>Reconnect attempt</dt><dd>${snapshot.health?.reconnectAttempt || 0}</dd><dt>History recording</dt><dd>${snapshot.trackingExcluded ? 'Called off / excluded' : snapshot.historyError ? 'Unavailable: ' + esc(snapshot.historyError) : snapshot.run ? 'Saved locally' : 'Waiting for a shared race'}</dd><dt>Recording coverage</dt><dd>${uncertain ? 'Uncertain — observations may be missing' : 'No known gaps'}</dd></dl><ul class="note">${(snapshot.recordQuality?.gaps || []).map(g => `<li>${esc(date(g.from))} → ${g.to === null ? 'still offline' : esc(date(g.to))} · ${esc(g.kind)}</li>`).join('')}${snapshot.recordQuality?.lateJoin ? '<li>First local observation was after the shared start. Full check coverage cannot be verified.</li>' : ''}</ul>`;
  }
  function previewOptions() { return { checks: el('preview-checks').checked, bk: el('preview-bk').checked, awards: el('preview-awards').checked, names: el('preview-names').value }; }
  async function openPreview(id, includeAwards = false) {
    closeHistory();
    previewId = id || snapshot?.activeHistoryId;
    if (includeAwards) el('preview-awards').checked = true;
    el('preview-feedback').textContent = '';
    for (const dialog of [el('awards-dialog'), el('finish-card-dialog')]) if (dialog.open) dialog.close();
    if (!el('share-results-dialog').open) el('share-results-dialog').showModal();
    await refreshPreview();
  }
  async function refreshPreview() {
    preview = null; el('preview-copy').disabled = el('preview-post').disabled = true;
    const result = await request('preview-results', { id: previewId, options: previewOptions() });
    if (!result) return;
    preview = result.preview;
    el('result-preview-text').textContent = preview.text;
    el('preview-target').textContent = `${preview.title} · Target: ${preview.target}`;
    el('preview-lines').textContent = `${preview.lines} printable chat lines. Copying works offline. Recording warnings and completion/release labels are mandatory.`;
    el('preview-copy').disabled = false; el('preview-post').disabled = !preview.canPost;
    el('preview-feedback').textContent = preview.canPost ? 'Review the message, then explicitly copy or post.' : 'Copy available. Posting requires this run’s original room/team/session and an unsent result.';
  }
  async function openAwards(id) {
    closeHistory();
    const result = await request('history-get', { id: id || snapshot?.activeHistoryId }); if (!result) return;
    awardRecord = result.record;
    if (!awardRecord.allFinished || awardRecord.excluded) { notice('Highlights require a tracked, finished race.'); return; }
    el('awards-content').innerHTML = qualityHTML(awardRecord) + awardRecord.awards.map(a => `<article class="award-row"><h3>${esc(a.title)}${a.winners.length > 1 ? ' · shared' : ''}</h3><p>${a.winners.length ? a.winners.map(p => esc(p.name)).join(', ') : esc(a.reason)}</p>${a.winners.length ? `<p class="elapsed">${a.type === 'checks' ? a.value + ' recorded checks' : a.type === 'steady' && a.value < 300000 ? 'No BK over five minutes' : ms(a.value)}</p>` : ''}</article>`).join('');
    if (!el('awards-dialog').open) el('awards-dialog').showModal();
  }
  async function openCard(id) {
    closeHistory();
    const result = await request('history-get', { id: id || snapshot?.activeHistoryId }); if (!result) return;
    cardRecord = result.record;
    if (!cardRecord.allFinished || cardRecord.excluded) { notice('Finish cards require a tracked, finished race.'); return; }
    if (el('share-results-dialog').open) el('share-results-dialog').close();
    el('card-mode').replaceChildren(new Option('Full group', 'group'), ...cardRecord.players.map(p => new Option(p.originalName, String(p.slot))));
    el('card-feedback').textContent = '';
    drawCard(); if (!el('finish-card-dialog').open) el('finish-card-dialog').showModal();
  }
  function drawCard() {
    if (!cardRecord) return;
    const mode = el('card-mode').value, identities = el('card-names').value === 'identities';
    el('card-layout').disabled = mode !== 'group';
    el('card-layout').title = mode === 'group' ? 'Group card layout' : 'Individual cards use the runner layout.';
    const all = mode === 'group' ? cardRecord.players : cardRecord.players.filter(p => p.slot === Number(mode));
    const pages = Math.max(1, Math.ceil(all.length / 6)), page = Math.min(Number(el('card-page').value) || 0, pages - 1);
    el('card-page').replaceChildren(...Array.from({ length: pages }, (_, i) => new Option(`${i + 1} / ${pages}`, String(i)))); el('card-page').value = String(page);
    const players = all.slice(page * 6, page * 6 + 6), canvas = el('finish-card-canvas');
    const highlights = el('card-layout').value === 'highlights' && mode === 'group';
    canvas.width = 1200; canvas.height = highlights ? 880 : mode === 'group' ? 410 + players.length * 88 : 680;
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#141517'; ctx.fillRect(0, 0, canvas.width, canvas.height);
    const write = (value, x, y, size = 22, color = '#e7e6e2', width = 1100, mono = false) => {
      ctx.font = `${size}px ${mono ? 'Consolas, monospace' : 'system-ui, sans-serif'}`; ctx.fillStyle = color;
      let text = String(value).replace(/[\p{C}]/gu, ' ');
      if (ctx.measureText(text).width > width) { const chars = Array.from(text); while (chars.length && ctx.measureText(chars.join('') + '…').width > width) chars.pop(); text = chars.join('') + '…'; }
      ctx.fillText(text, x, y);
    };
    write('ARCHIPELAGO · RACE RESULTS', 48, 52, 20, '#e8a33d'); write(cardRecord.title, 48, 94, 30);
    write(`${date(cardRecord.run.startedAt)}${pages > 1 ? ' · page ' + (page + 1) + ' / ' + pages : ''}`, 48, 128, 18, '#a4a7ae');
    write(mode === 'group' ? 'Total Group Time' : displayName(players[0], identities), 48, 180, 22);
    write(ms(mode === 'group' ? cardRecord.stats.elapsedMs : players[0].stats.elapsedMs), 48, 258, 68, '#e7e6e2', 1100, true);
    if (highlights) {
      let y = 326;
      for (const award of cardRecord.awards) {
        if (award.type === 'checks' && !el('card-checks').checked || award.type === 'steady' && !el('card-bk').checked) continue;
        write(award.title + (award.winners.length > 1 ? ' · shared' : ''), 48, y, 20, '#e8a33d');
        write(award.winners.length ? award.winners.map(w => displayName(cardRecord.players.find(p => p.slot === w.slot), identities)).join(', ') : award.reason, 48, y + 32, 24);
        if (award.winners.length) write(award.type === 'checks' ? award.value + ' recorded checks' : award.type === 'steady' && award.value < 300000 ? 'No BK over five minutes' : ms(award.value), 48, y + 62, 22);
        y += 116;
      }
      write('Roster: ' + players.map(p => displayName(p, identities) + ' (' + (p.completed ? 'Completed' : 'Released') + ')').join(', '), 48, 720, 18, '#a4a7ae');
    } else if (mode === 'group') {
      write('Runner / status', 48, 316, 18, '#a4a7ae', 390); write('Time', 490, 316, 18, '#a4a7ae', 190);
      if (el('card-checks').checked) write('Checks', 758, 316, 18, '#a4a7ae', 140);
      if (el('card-bk').checked) write('Longest BK', 960, 316, 18, '#a4a7ae', 190);
      players.forEach((p, i) => { const y = 365 + i * 88; write(displayName(p, identities), 48, y, 24, '#e7e6e2', 400); write(`${p.completed ? 'Completed' : 'Released'} · ${p.game}`, 48, y + 28, 17, p.completed ? '#7bce9f' : '#a4a7ae', 400); write(ms(p.stats.elapsedMs), 490, y, 25, '#e7e6e2', 210, true); if (el('card-checks').checked) write(p.stats.checksCompleted ?? 'Unavailable', 758, y, 24, '#e7e6e2', 160); if (el('card-bk').checked) write(bk(p.stats.longestBKMs), 960, y, 24, '#e7e6e2', 200, true); });
    } else {
      const p = players[0]; write(`${p.completed ? 'Completed' : 'Released'} · ${p.game}`, 48, 318, 26, p.completed ? '#7bce9f' : '#a4a7ae');
      if (el('card-checks').checked) write(`Checks: ${p.stats.checksCompleted ?? 'Unavailable'}`, 48, 382, 30);
      if (el('card-bk').checked) write(`Longest BK: ${bk(p.stats.longestBKMs)}`, 560, 382, 30, '#e7e6e2', 590);
      write('Group time: ' + ms(cardRecord.stats.elapsedMs), 48, 450, 24);
    }
    write(cardRecord.quality.uncertain ? 'Recording coverage uncertain · checks or finish observations may be missing' : `${cardRecord.players.filter(p => p.completed).length} completed · ${cardRecord.players.filter(p => p.released && !p.completed).length} released · recorded observations`, 48, canvas.height - 70, 18, cardRecord.quality.uncertain ? '#e8a33d' : '#a4a7ae');
    write('Archipelago Timer and Stat Tracker · Work in progress', 48, canvas.height - 32, 17, '#a4a7ae');
  }
  function accept(next) {
    if(next.soundsMuted && !snapshot?.soundsMuted) stopSounds();
    snapshot = next; if(el('sounds-toggle-mute')) el('sounds-toggle-mute').textContent=next.soundsMuted?'Unmute sounds':'Mute sounds temporarily'; preferences = featurePreferences(next.featureSettings); warmSounds(); updateHealth(); updateRunnerContext();
    document.body.classList.toggle('full-alerts', preferences.alerts.fullView);
    if (next.historyError) notice('History storage unavailable: ' + next.historyError);
    else if (next.profileRosterIssues?.length) notice('Review the saved roster: ' + next.profileRosterIssues.join('; ') + '. Select the correct runners before starting.');
    if (lastRevision !== next.libraryRevision) { lastRevision = next.libraryRevision; if (workspace === 'history') { clearTimeout(historyRefresh); historyRefresh = setTimeout(refreshHistory, 200); } }
    if (next.preferredTimerOnly && next.connection === 'connected' && next.hydrated && !preferredViewApplied) { preferredViewApplied = true; setTimeout(() => AppTimer.setTimerOnly(true), 0); }
  }
  function tick(now) {
    if (!snapshot) return;
    updateHealth();
    for (const cue of cues.update({ context: snapshot.activeHistoryId, ready: !!snapshot.run && snapshot.hydrated && snapshot.connection === 'connected' && !snapshot.trackingExcluded && !snapshot.allFinished,
      startedAt: snapshot.run?.startedAt, now, enabled: preferences.sounds.enabled })) playSound(cue === 0 ? preferences.sounds.goId : preferences.sounds.countdownId, preferences.sounds.volume, false, cue === 0, cue !== 0);
  }
  const rule = event => eventRule(event, preferences, snapshot?.slot);
  function observeAlert(alert) {
    if (!alert) { lastSoundAlert = ''; return; }
    const soundId = snapshot?.activeHistoryId + ':' + alert.id;
    if (lastSoundAlert === soundId) return;
    lastSoundAlert = soundId;
    if (rule(alert).sound && !(alert.type === 'start' && preferences.sounds.enabled)) playSound(rule(alert).soundId, preferences.sounds.volume);
  }
  window.RaceFeatures = { accept, tick, rule, observeAlert, openPreview, openCard, openAwards, chooseWorkspace, closeHistory,
    notificationsEnabled: () => preferences.alerts.fullView || Object.values(preferences.alerts.categories).some(c => c.sound) };
  const contextLabels = {playing:'Playing',waiting:'Waiting on an item',break:'Taking a break',gomode:'Go mode'};
  function updateRunnerContext() {
    const own = snapshot?.players.find(p => p.slot === snapshot.slot);
    const enabled = snapshot?.connection === 'connected' && snapshot.hydrated && own && !own.stopped;
    el('context-save').disabled = !enabled;
    const status = own?.runnerContext, signature = JSON.stringify(status);
    if (el('runner-context').dataset.shared !== signature) {
      el('runner-context').dataset.shared = signature;
      el('runner-context').value = status?.state || 'playing'; el('context-detail').value = status?.detail || '';
    }
    el('context-detail').disabled = el('runner-context').value !== 'waiting';
    el('shared-contexts').textContent = (snapshot?.players || []).map(p => `${p.name}: ${p.stopped ? p.completed ? 'Completed' : 'Released' : contextLabels[p.runnerContext?.state] || 'Not declared'}${!p.stopped && p.runnerContext?.detail ? ' — ' + p.runnerContext.detail : ''}`).join(' · ');
  }
  el('runner-context').onchange = () => { el('context-detail').disabled = el('runner-context').value !== 'waiting'; };
  el('context-save').onclick = async () => { if (await request('runner-context', { state: el('runner-context').value, detail: el('context-detail').value })) el('context-feedback').textContent = 'Status shared with timer apps in this room, team and session. The race clock continues.'; };
  document.querySelectorAll('[data-workspace]').forEach(b => b.onclick = () => chooseWorkspace(b.dataset.workspace));
  document.querySelectorAll('[data-close]').forEach(b => b.onclick = () => el(b.dataset.close).close());
  el('health-indicator').onclick = () => chooseWorkspace('health');
  for (const id of ['preview-checks', 'preview-bk', 'preview-awards', 'preview-names']) el(id).onchange = refreshPreview;
  el('preview-refresh').onclick = refreshPreview;
  el('preview-copy').onclick = async () => { if (preview && await request('copy-preview', { token: preview.token })) { el('preview-feedback').textContent = 'Preview copied to clipboard.'; AppTimer.notifyShared('copy'); } };
  el('preview-post').onclick = async () => { if (!preview) return; el('preview-post').disabled = true; if (await request('post-preview', { token: preview.token })) { el('preview-feedback').textContent = 'Results sent to the room. The chat protocol does not acknowledge delivery.'; AppTimer.notifyShared('post'); } };
  el('preview-card').onclick = () => openCard(previewId);
  for (const id of ['card-mode', 'card-layout', 'card-names', 'card-page', 'card-checks', 'card-bk']) el(id).onchange = drawCard;
  el('card-save').onclick = async () => { if (cardRecord) { const result = await request('save-card', { id: cardRecord.id, png: el('finish-card-canvas').toDataURL('image/png') }); if (result) el('card-feedback').textContent = result.saved ? 'PNG saved.' : 'Save canceled.'; } };
  el('awards-share').onclick = () => openPreview(awardRecord?.id, true);
  el('preview-current-results').onclick = () => openPreview(); el('card-current-results').onclick = () => openCard(); el('awards-current-results').onclick = () => openAwards();
  request('sound-list').then(result => { if (result) { customSounds = result.sounds; warmSounds(); } });
  document.body.dataset.workspace = 'live';
  if (AppTimer.getState()) accept(AppTimer.getState());
})();
