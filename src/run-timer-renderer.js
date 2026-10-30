const $ = id => document.getElementById(id);
let state = null;
let clockAnchor = null;
let selected = new Set();
let rosterKey = '';
let busy = false;
let statsVisible = false;
let timerOnly = false;
let focusedStatsVisible = false;
let sharingResults = false;
let requestedStatsRows = null;
const compactRoster = () => CompactStats.compactPlayers(state?.players || [], state?.compactSettings, state?.slot);
const compactRows = () => Math.max(1,Math.min(6,compactRoster().length));
let copiedUntil = 0;
let renderedEvents = '';
const timerAlerts = new TimerAlerts();
const runnerStatusLabels = {playing: 'Playing', waiting: 'Waiting', break: 'Break', gomode: 'Go mode'};
let statusSharing = false;
function closeQuickStatus(focus = false) {
  $('quick-status-options').hidden = true;
  $('quick-status-toggle').setAttribute('aria-expanded', 'false');
  if (focus) $('quick-status-toggle').focus({ preventScroll: true });
}
function updateQuickStatus() {
  const own = state?.players.find(p => p.slot === state.slot);
  const enabled = state?.connection === 'connected' && state.hydrated && own && !own.stopped && !state.trackingExcluded;
  $('quick-status').hidden = !!own?.stopped;
  $('quick-status-toggle').disabled = !enabled || statusSharing;
  $('quick-status-toggle').title = 'Your status: ' + (runnerStatusLabels[own?.runnerContext?.state] || 'Not declared');
  for (const button of document.querySelectorAll('[data-quick-status]')) {
    button.disabled = !enabled || statusSharing;
    button.setAttribute('aria-pressed', String(button.dataset.quickStatus === own?.runnerContext?.state));
  }
  if (!enabled || !timerOnly) closeQuickStatus();
}

function renderTimerPopup(serverNow) {
  const alert = timerAlerts.update({
    context: JSON.stringify([state.address, state.seed, state.team, state.session, state.run?.startedAt]),
    ready: state.hydrated && state.connection === 'connected' && (!!state.run || state.featureSettings?.alerts.categories.ready.popup || state.featureSettings?.alerts.categories.ready.sound) && !state.trackingExcluded,
    enabled: timerOnly || window.RaceFeatures?.notificationsEnabled(), events: state.events || [], runnerBKs: state.runnerBKs || [], ownSlot: state.slot,
    serverNow, now: performance.now(),
    allowed: event => { const rule = window.RaceFeatures?.rule(event); return !rule || rule.popup || rule.sound; },
  });
  window.RaceFeatures?.observeAlert(alert);
  const visible = !!alert && (window.RaceFeatures?.rule(alert).popup ?? true) && (timerOnly || state.featureSettings?.alerts.fullView);
  const popup = $('timer-popup');
  if (alert) {
    popup.dataset.tone = ['goal', 'release', 'finish', 'recovery'].includes(alert.type) ? 'success' : '';
    const declared = { playing: 'Playing', waiting: 'Waiting on an item', break: 'Taking a break', gomode: 'Go mode' }[alert.context?.state];
    const text = alert.type === 'bk' ? `${alert.name} has been BK for ${duration(alert.at - alert.since)} (no recorded checks).${declared ? ` Declared: ${declared}.` : ''}` : alert.message;
    const timestamp = alertTimestamp(alert.at, state.run?.startedAt);
    const message = `[${timestamp}] ${text}`;
    popup.dataset.timestamp = timestamp;
    if (popup.textContent !== message) popup.textContent = message;
  }
  popup.classList.toggle('visible', visible);
  popup.setAttribute('aria-hidden', String(!visible));
  popup.dataset.event = visible ? alert.id : '';
  popup.dataset.type = visible ? alert.type : '';
  popup.title = alert ? popup.textContent : '';
}

function isReady(slot, now) {
  const ready = state?.readies?.[slot];
  return ready?.ready === true && ready.expiresAt > now &&
    JSON.stringify(ready.roster) === JSON.stringify([...selected].sort((a, b) => a - b));
}

function updateReadiness(now) {
  if (!state) return;
  const eligible = !state.run && state.connection === 'connected' && state.hydrated && !state.startPending;
  const readyCount = [...selected].filter(slot => isReady(slot, now)).length;
  $('start').disabled = busy || !eligible || !selected.size || ($('require-ready').checked && readyCount !== selected.size);
  const own = state.players.find(p => p.slot === state.slot);
  $('ready').disabled = !eligible || !selected.has(state.slot) || !own || own.stopped;
  $('ready').textContent = isReady(state.slot, now) ? 'Not ready' : "I'm ready";
  $('ready').setAttribute('aria-pressed', String(isReady(state.slot, now)));
  $('require-ready').disabled = !!state.run || !!state.startPending;
  $('ready-summary').textContent = state.run ? 'Roster locked · Shared start scheduled' : `${readyCount} / ${selected.size} ready for this roster`;
}

function renderEvents(now) {
  const events = (state.events || []).filter(event => event.at === null || event.at <= now)
    .sort((a, b) => (b.at ?? -Infinity) - (a.at ?? -Infinity) || b.id.localeCompare(a.id)).slice(0, 50);
  const signature = JSON.stringify([!!state.run, events]);
  if (signature !== renderedEvents) {
    renderedEvents = signature;
    $('event-list').replaceChildren();
    for (const event of events) {
      const row = document.createElement('li'); row.dataset.event = event.type;
      const time = document.createElement('time');
      time.textContent = event.at === null ? 'Unknown' : state.run ? duration(event.at - state.run.startedAt) : 'Ready';
      const date = event.at === null ? null : new Date(event.at);
      if (date && Number.isFinite(date.valueOf())) time.dateTime = date.toISOString();
      const text = document.createElement('span'); text.textContent = event.message;
      row.append(time, text); $('event-list').append(row);
    }
    if (!events.length) {
      const empty = document.createElement('li'); empty.className = 'muted';
      empty.textContent = state.run ? 'Waiting for race events…' : 'Ready checks and run milestones will appear here.';
      $('event-list').append(empty);
    }
  }
  $('events-status').textContent = state.connection !== 'connected' ? state.run ? 'Offline · Events may be missing' : 'Not connected · Ready checks paused' :
    state.allFinished ? 'Race finished' : state.run ? now < state.run.startedAt ? 'Shared countdown' : 'Race in progress' : 'Ready room';
  const bk = state.trackingExcluded ? null : state.bk;
  const elapsed = bk ? Math.max(0, now - bk.since) : 0;
  const bkActive = !!bk && elapsed >= bk.thresholdMs;
  $('bk-alert').hidden = !bkActive;
  $('compact-bk').hidden = !bkActive;
  document.body.classList.toggle('has-bk', bkActive);
  if (bk) {
    const context = state.players.find(p => p.slot === state.slot)?.runnerContext;
    const label = {playing:'Playing',waiting:'Waiting on an item',break:'Taking a break',gomode:'Go mode'}[context?.state];
    const compactLabel = $('compact-bk').querySelector('span');
    compactLabel.textContent = label ? `BK Timer · ${label}` : 'BK Timer';
    compactLabel.title = context?.detail || '';
    $('bk-clock').textContent = duration(elapsed);
    $('compact-bk-clock').textContent = duration(elapsed);
    $('compact-bk').title = state.connection === 'connected' ? 'Time since your last recorded check, or the race start before your first check.' :
      'Offline: based on your last recorded check; new checks may be missing.';
    $('bk-detail').textContent = state.connection === 'connected' ? 'Since your last recorded check (or the race start if you have no checks).' + (state.players.find(p => p.slot === state.slot)?.runnerContext ? ' Declared: ' + state.players.find(p => p.slot === state.slot).runnerContext.state + '.' : '') :
      'Offline · Based on your last recorded check; new checks may be missing.';
  }
}

function updateView() {
  updateQuickStatus();
  document.body.classList.toggle('timer-only', timerOnly);
  const focusedStats = timerOnly && focusedStatsVisible && !!state?.run;
  document.body.classList.toggle('focused-stats', focusedStats);
  $('focused-stats').hidden = !focusedStats;
  const rows = compactRows();
  if(focusedStats && requestedStatsRows !== rows) { requestedStatsRows=rows; queueMicrotask(async()=>{ if(!timerOnly || !focusedStatsVisible || requestedStatsRows!==rows) return; try { const result=await window.runTimer.invoke('view',{timerOnly:true,statsRows:rows}); if(result.error) $('error').textContent=result.error; } catch(error) { $('error').textContent=error.message; } }); }
  if(!focusedStats) requestedStatsRows=null;
  const columns=CompactStats.compactPreferences(state?.compactSettings).columns;
  const visible=columns.filter(c=>['checks','hints','bk'].includes(c)).length;
  document.querySelectorAll('#focused-stats th').forEach((th,i)=>{ const c=[null,'checks','hints','bk'][i]; th.hidden=!!c&&!columns.includes(c); th.style.width=i===0 ? (visible?'40%':'100%') : `${60/Math.max(1,visible)}%`; });
  $('focused-stats').style.height = `${52 + rows * 32}px`;
  $('results').hidden = !statsVisible || !state?.run;
  $('show-stats').disabled = !state?.run;
  const showingStats = timerOnly ? focusedStats : statsVisible;
  $('show-stats').textContent = showingStats ? 'Hide Stats' : 'Show Stats';
  $('show-stats').setAttribute('aria-expanded', String(showingStats));
  $('show-stats').setAttribute('aria-controls', timerOnly ? 'focused-stats' : 'results');
  $('timer-only').textContent = timerOnly ? 'Full view' : 'Timer only';
  $('timer-only').setAttribute('aria-pressed', String(timerOnly));
  $('copy-results').hidden = $('post-results').hidden = $('completed-tools').hidden = !state?.allFinished || !!state?.trackingExcluded;
  $('copy-results').disabled = sharingResults;
  $('copy-results').textContent = performance.now() < copiedUntil ? 'Copied!' : 'Copy results';
  $('post-results').disabled = sharingResults || state?.connection !== 'connected' || !state?.hydrated || state?.resultsPosted;
  $('post-results').textContent = state?.resultsPosted ? 'Posted to chat' : 'Post to chat';
  $('post-results').title = state?.resultsPosted ? 'Results already sent from this app for this run.' : 'Send group time and each runner’s results to the connected Archipelago room.';
}

async function setTimerOnly(value) {
  if (value) window.RaceFeatures?.closeHistory();
  const result = await invoke('view', { timerOnly: value });
  if (!result) return false;
  timerOnly = value;
  focusedStatsVisible = false;
  if (value) statsVisible = false;
  updateView();
  window.scrollTo(0, 0);
  return true;
}

function duration(ms) {
  const seconds = Math.floor(Math.max(0, ms) / 1000);
  return [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, seconds % 60].map(n => String(n).padStart(2, '0')).join(':');
}

async function invoke(action, input) {
  $('error').textContent = '';
  try {
    const result = await window.runTimer.invoke(action, input);
    if (result.error) { $('error').textContent = result.error; return null; }
    if (result.state) accept(result.state);
    return result;
  } catch (err) { $('error').textContent = err.message; return null; }
}

function accept(next) {
  const wasConnected = state?.connection === 'connected';
  const hadRun = !!state?.run;
  state = next;
  if (!hadRun && state.run) $('race-setup').open = false;
  if (hadRun && !state.run) {
    $('share-status').hidden = true;
    $('race-setup').open = true; statsVisible = false;
    if (timerOnly && focusedStatsVisible) {
      focusedStatsVisible = false;
      invoke('view', { timerOnly: true, statsRows: 0 });
    }
  }
  clockAnchor = { server: state.serverNow, local: performance.now() };
  const key = JSON.stringify([state.seed, state.team, state.session, state.players.map(p => p.slot)]);
  if (key !== rosterKey) {
    selected = new Set(state.selectedSlots ?? state.players.filter(p => !p.stopped).map(p => p.slot));
    rosterKey = key;
  }
  if (!state.run) for (const p of state.players) if (p.stopped) selected.delete(p.slot);
  const active = ['connecting', 'connected', 'reconnecting'].includes(state.connection);
  if (state.connection === 'connected') $('address').value = state.address;
  if (!wasConnected && state.connection === 'connected') $('connection-details').open = false;
  if (!active) $('connection-details').open = true;
  $('connection').textContent = state.connection[0].toUpperCase() + state.connection.slice(1);
  $('connection').className = `badge ${state.connection}`;
  for (const id of ['address', 'trackerUrl', 'name', 'password', 'session', 'connect']) $(id).disabled = active;
  $('disconnect').disabled = !active;
  $('always-on-top').checked = state.alwaysOnTop === true;
  $('follow-room-countdown').checked = state.followRoomCountdown !== false;
  $('message').textContent = state.message;
  $('room').textContent = state.seed ? `Seed ${state.seed} · Team ${state.team + 1} · Session ${state.session}` : '';
  $('start').disabled = busy || state.connection !== 'connected' || !state.hydrated || !!state.run || !selected.size;
  $('countdown').disabled = !!state.run;
  $('solo-start').disabled = !!state.solo;
  $('solo-finish').disabled = !state.solo || state.solo.finishedAt !== null;
  $('solo-reset').disabled = !state.solo;
  $('players').replaceChildren();
  if (!state.players.length) {
    const cell = document.createElement('td');
    cell.colSpan = 4; cell.className = 'empty'; cell.textContent = 'Connect to load the room’s players.';
    const row = document.createElement('tr'); row.append(cell); $('players').append(row);
  }
  for (const player of state.players) {
    const row = document.createElement('tr');
    const checkCell = document.createElement('td');
    const check = document.createElement('input'); check.type = 'checkbox';
    check.setAttribute('aria-label', `Include ${player.name}`);
    check.checked = state.run ? true : selected.has(player.slot);
    check.disabled = !!state.run || state.connection !== 'connected' || player.stopped || player.status === null;
    check.addEventListener('change', () => {
      if (check.checked) selected.add(player.slot); else selected.delete(player.slot);
      invoke('selection', [...selected]);
      updateReadiness(clockAnchor.server + performance.now() - clockAnchor.local);
    });
    checkCell.append(check);
    const name = document.createElement('td'); name.textContent = player.name;
    const game = document.createElement('span'); game.className = 'game'; game.textContent = player.game; name.append(game);
    const status = document.createElement('td'); status.id = `status-${player.slot}`;
    const elapsed = document.createElement('td'); elapsed.className = 'elapsed'; elapsed.id = `elapsed-${player.slot}`;
    row.append(checkCell, name, status, elapsed); $('players').append(row);
  }
  updateView();
  if (state.run) {
    const formatTime = ms => ms === null ? 'Time unavailable' : duration(ms);
    $('results-state').textContent = state.allFinished ? 'Final results' : 'Run in progress';
    $('stats-checks').textContent = String(state.stats.checksCompleted);
    $('stats-time').textContent = state.allFinished ? formatTime(state.stats.elapsedMs) : 'In progress';
    $('stats-bk').textContent = state.allFinished ? formatTime(state.stats.longestBKMs) : 'In progress';
    $('runner-stats').replaceChildren();
    const scrollTop = $('focused-stats-scroll').scrollTop;
    $('focused-runner-stats').replaceChildren();
    for (const p of state.players) {
      const row = document.createElement('tr');
      row.id = `stats-${p.slot}`;
      for (const value of [p.name, String(p.stats.checksCompleted),
        p.stopped ? formatTime(p.stats.elapsedMs) : 'In progress',
        p.stopped ? formatTime(p.stats.longestBKMs) : 'In progress']) {
        const cell = document.createElement('td'); cell.textContent = value; row.append(cell);
      }
      $('runner-stats').append(row);
    }
    const compactColumns=CompactStats.compactPreferences(state.compactSettings).columns;
    for(const p of compactRoster()) {
      const focusedRow = document.createElement('tr');
      focusedRow.dataset.slot = p.slot;
      const name = document.createElement('td'); name.title = `${p.name} — ${p.game}`;
      const nameLine = document.createElement('span'); nameLine.className = 'runner-name-line';
      const nameText = document.createElement('span'); nameText.className = 'runner-name'; nameText.textContent = p.name;
      nameLine.append(nameText);
      const label = p.completed ? 'Completed' : p.released ? 'Released' : runnerStatusLabels[p.runnerContext?.state];
      if (label && compactColumns.includes('status')) {
        const badge = document.createElement('span'); badge.className = 'runner-status';
        badge.dataset.state = p.stopped ? 'finished' : p.runnerContext.state;
        badge.textContent = label;
        badge.title = `${p.name}: ${label}${!p.stopped && p.runnerContext?.state === 'waiting' && p.runnerContext.detail ? ' — ' + p.runnerContext.detail : ''}`;
        nameLine.append(badge);
      }
      name.append(nameLine);
      const game = document.createElement('small'); game.className = 'runner-game'; game.textContent = p.game; game.title = p.game; game.hidden=!compactColumns.includes('game'); name.append(game);
      name.className = p.stopped ? 'complete' : '';
      const checks = document.createElement('td'); checks.textContent = p.checkProgress ? `${p.checkProgress.checked} / ${p.checkProgress.total}` : `${p.stats.checksCompleted} / ?`;
      checks.title = checks.textContent + ' · ' + (p.checkProgress ? 'Server world progress (includes checks before this race and release/collect).' : 'World total unavailable. Showing recorded race checks only.');
      const hints = document.createElement('td'); hints.textContent = Number.isSafeInteger(p.hintsUsed) ? String(p.hintsUsed) : '—'; hints.dataset.hintsSlot = p.slot;
      hints.title = Number.isSafeInteger(p.hintsUsed) ? 'Purchased hints calculated from server-confirmed points and checks.' : 'Hint purchases unavailable: free hints or insufficient server data.';
      const bk = document.createElement('td'); bk.dataset.bkSlot = p.slot;
      checks.hidden=!compactColumns.includes('checks'); hints.hidden=!compactColumns.includes('hints'); bk.hidden=!compactColumns.includes('bk');
      focusedRow.append(name, checks, hints, bk);
      $('focused-runner-stats').append(focusedRow);
    }
    if(!compactRoster().length) { const tr=document.createElement('tr'),td=document.createElement('td');td.colSpan=4;td.textContent='No matching runners.';tr.append(td);$('focused-runner-stats').append(tr); }
    $('focused-stats-scroll').scrollTop = scrollTop;
  }
  tick();
  window.RaceFeatures?.accept(state);
}

function tick() {
  if (!state) return;
  const now = clockAnchor.server + performance.now() - clockAnchor.local;
  const run = state.run;
  const before = run && !state.allFinished && now < run.startedAt;
  updateReadiness(now);
  renderEvents(now);
  renderTimerPopup(now);
  window.RaceFeatures?.tick(now);
  $('clock-label').textContent = before ? 'STARTING IN' : 'GROUP ELAPSED';
  $('group-clock').textContent = before ? String(Math.ceil((run.startedAt - now) / 1000)) :
    run ? state.allFinished && state.groupFinishedAt === null ? '—:—:—' : duration((state.groupFinishedAt ?? now) - run.startedAt) : '00:00:00';
  // Let longer hour counts fit the same width as the normal eight-character clock.
  $('group-clock').style.setProperty('--clock-width', `${90 / (0.6 * Math.max(8, $('group-clock').textContent.length))}vw`);
  const count = state.players.filter(p => p.stopped).length;
  const released = state.players.filter(p => p.released && !p.completed).length;
  const everyone = released ? 'Everyone finished · Includes released players' : 'Everyone completed';
  $('group-detail').textContent = run ? state.allFinished ? state.groupFinishedAt === null ? `${everyone} · Some finish times unavailable` : everyone :
    before ? run.source === 'archipelago-countdown' ? 'Following Archipelago room countdown' : 'Get ready · Shared start is scheduled' : `${count} / ${state.players.length} finished${state.connection !== 'connected' ? ' · Offline — clock continues' : ''}` : 'Select players, then start a shared countdown';
  if (state.trackingExcluded) $('group-detail').textContent += ' · Excluded from local history tracking';
  for (const p of state.players) {
    const bkCell = document.querySelector(`[data-bk-slot="${p.slot}"]`);
    if (bkCell && p.stats) {
      const longest = p.stopped ? p.stats.longestBKMs : Math.max(p.stats.recordedLongestBKMs, now - p.stats.lastCheckAt, 0);
      bkCell.textContent = longest === null ? 'Unavailable' : duration(longest);
    }
    const complete = p.stopped;
    const status = $(`status-${p.slot}`);
    status.textContent = p.completed ? 'Completed' : p.released ? 'Released' : before ? 'Ready' : run ? 'Running' : p.status === null ? 'Status unavailable' : isReady(p.slot, now) ? 'Ready' : 'Waiting';
    status.className = complete ? 'complete' : '';
    $(`elapsed-${p.slot}`).textContent = !run ? '—' : p.finishedAt !== null ? duration(p.finishedAt - run.startedAt) : complete ? 'Time unavailable' : duration(now - run.startedAt);
  }
  $('solo-clock').textContent = state.solo ? duration((state.solo.finishedAt ?? Date.now()) - state.solo.startedAt) : '00:00:00';
}

$('connect-form').addEventListener('submit', async event => {
  event.preventDefault();
  await invoke('connect', { address: $('address').value, name: $('name').value, password: $('password').value, session: $('session').value, trackerUrl: $('trackerUrl').value });
  $('password').value = '';
});
$('disconnect').addEventListener('click', () => invoke('disconnect'));
$('start').addEventListener('click', async () => {
  busy = true; $('start').disabled = true;
  await invoke('start', { slots: [...selected], countdown: Number($('countdown').value), requireReady: $('require-ready').checked });
  busy = false;
  if (state) accept(state);
});
$('export').addEventListener('click', () => invoke('export'));
for (const action of ['copy-results', 'post-results']) $(action).addEventListener('click', () => window.RaceFeatures?.openPreview());
for (const command of ['minimize', 'maximize', 'close']) $('window-' + command).addEventListener('click', () => invoke('window-command', command));
$('ready').addEventListener('click', () => invoke('ready', { slots: [...selected], ready: !isReady(state.slot, clockAnchor.server + performance.now() - clockAnchor.local) }));
$('require-ready').addEventListener('change', () => updateReadiness(clockAnchor.server + performance.now() - clockAnchor.local));
$('follow-room-countdown').addEventListener('change', async () => {
  const result = await invoke('follow-countdown', $('follow-room-countdown').checked);
  if (!result) $('follow-room-countdown').checked = state?.followRoomCountdown !== false;
});
$('always-on-top').addEventListener('change', async () => {
  const result = await invoke('always-on-top', $('always-on-top').checked);
  if (!result) $('always-on-top').checked = state?.alwaysOnTop === true;
});
$('quick-status-toggle').addEventListener('click', () => {
  const open = $('quick-status-options').hidden;
  $('quick-status-options').hidden = !open;
  $('quick-status-toggle').setAttribute('aria-expanded', String(open));
  $('quick-status-feedback').hidden = true;
  if (open) $('quick-status-options').querySelector('button:not(:disabled)')?.focus({ preventScroll: true });
});
for (const button of document.querySelectorAll('[data-quick-status]')) button.addEventListener('click', async () => {
  const own = state?.players.find(p => p.slot === state.slot);
  statusSharing = true; updateQuickStatus();
  const result = await invoke('runner-context', { state: button.dataset.quickStatus, detail: button.dataset.quickStatus === 'waiting' ? own?.runnerContext?.detail || '' : '' });
  statusSharing = false; updateQuickStatus();
  if (result) closeQuickStatus(true);
  else { $('quick-status-feedback').hidden = false; $('quick-status-feedback').textContent = $('error').textContent || 'Unable to share status.'; }
});
document.addEventListener('click', event => { if (!$('quick-status').contains(event.target)) closeQuickStatus(); });
document.addEventListener('focusin', event => { if (!$('quick-status').contains(event.target)) closeQuickStatus(); });
$('timer-only').addEventListener('click', () => setTimerOnly(!timerOnly));
$('show-stats').addEventListener('click', async () => {
  if (timerOnly) {
    const visible = !focusedStatsVisible;
    if (!await invoke('view', { timerOnly: true, statsRows: visible ? compactRows() : 0 })) return;
    focusedStatsVisible = visible;
    updateView();
    return;
  }
  statsVisible = !statsVisible;
  updateView();
  if (statsVisible) $('results').scrollIntoView({ block: 'nearest' });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && document.querySelector('dialog[open]')) return;
  if (event.key === 'Escape' && !$('quick-status-options').hidden) { event.preventDefault(); closeQuickStatus(true); return; }
  if (event.key === 'Escape' && timerOnly) { event.preventDefault(); setTimerOnly(false); }
});
for (const action of ['start', 'finish', 'reset']) $(`solo-${action}`).addEventListener('click', () => invoke('solo', action));
let hotkeyFeedbackTimer;
window.runTimer.onHotkey(message => {
  if(!message.error && ['stats','compact'].includes(message.action)) {
    if(document.querySelector('dialog[open]')) message={...message,error:'Close the open dialog before changing the timer view.'};
    else if(message.action==='stats') $('show-stats').click();
    else setTimerOnly(!timerOnly);
  }
  $('hotkey-feedback').textContent=message.error || (message.action==='mute' ? (state?.soundsMuted?'Sounds muted':'Sounds unmuted') : `Shortcut: ${runnerStatusLabels[message.action] || message.action}`);
  $('hotkey-feedback').hidden=false;clearTimeout(hotkeyFeedbackTimer);hotkeyFeedbackTimer=setTimeout(()=>$('hotkey-feedback').hidden=true,4000);
});
window.runTimer.onState(accept);
invoke('state').then(result => {
  if (!result) return;
  for (const id of ['address', 'name', 'session', 'trackerUrl']) if (result.preferences[id]) $(id).value = result.preferences[id];
});
setInterval(tick, 100);
window.AppTimer = {
  getState: () => state, invoke, setTimerOnly,
  applyDraft(draft) {
    for (const [id, value] of [['address', draft.address], ['name', draft.slotName], ['session', draft.session]]) if (typeof value === 'string') $(id).value = value;
    if (draft.countdown !== undefined) $('countdown').value = String(draft.countdown);
    if (draft.requireReady !== undefined) $('require-ready').checked = draft.requireReady;
    $('password').value = '';
    $('trackerUrl').value = draft.trackerUrl || '';
  },
  notifyShared(kind) {
    if (kind === 'copy') { copiedUntil = performance.now() + 2000; updateView(); setTimeout(updateView, 2000); }
    $('share-status').textContent = kind === 'copy' ? 'Results copied to clipboard.' : 'Results sent to Archipelago chat.';
    $('share-status').hidden = false;
  },
};

