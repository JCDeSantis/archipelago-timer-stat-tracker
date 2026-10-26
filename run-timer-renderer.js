const $ = id => document.getElementById(id);
let state = null;
let clockAnchor = null;
let selected = new Set();
let rosterKey = '';
let busy = false;
let statsVisible = false;
let timerOnly = false;
let renderedEvents = '';
const timerAlerts = new TimerAlerts();

function renderTimerPopup(serverNow) {
  const alert = timerAlerts.update({
    context: JSON.stringify([state.address, state.seed, state.team, state.session, state.run?.startedAt]),
    ready: state.hydrated && state.connection === 'connected' && !!state.run,
    enabled: timerOnly, events: state.events || [], runnerBKs: state.runnerBKs || [], ownSlot: state.slot,
    serverNow, now: performance.now(),
  });
  const popup = $('timer-popup');
  if (alert) {
    popup.dataset.tone = ['goal', 'release', 'finish'].includes(alert.type) ? 'success' : '';
    const message = alert.type === 'bk' ? `${alert.name} has been BK for ${duration(serverNow - alert.since)} (no recorded checks).` : alert.message;
    if (popup.textContent !== message) popup.textContent = message;
  }
  popup.classList.toggle('visible', !!alert);
  popup.setAttribute('aria-hidden', String(!alert));
  popup.dataset.event = alert?.id || '';
  popup.dataset.type = alert?.type || '';
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
  const bk = state.bk;
  const elapsed = bk ? Math.max(0, now - bk.since) : 0;
  const bkActive = !!bk && elapsed >= bk.thresholdMs;
  $('bk-alert').hidden = !bkActive;
  $('compact-bk').hidden = !bkActive;
  document.body.classList.toggle('has-bk', bkActive);
  if (bk) {
    $('bk-clock').textContent = duration(elapsed);
    $('compact-bk-clock').textContent = duration(elapsed);
    $('compact-bk').title = state.connection === 'connected' ? 'Time since your last recorded check, or the race start before your first check.' :
      'Offline: based on your last recorded check; new checks may be missing.';
    $('bk-detail').textContent = state.connection === 'connected' ? 'Since your last recorded check (or the race start if you have no checks).' :
      'Offline · Based on your last recorded check; new checks may be missing.';
  }
}

function updateView() {
  document.body.classList.toggle('timer-only', timerOnly);
  $('results').hidden = !statsVisible || !state?.run;
  $('show-stats').disabled = !state?.run;
  $('show-stats').textContent = statsVisible ? 'Hide Stats' : 'Show Stats';
  $('show-stats').setAttribute('aria-expanded', String(statsVisible));
  $('timer-only').textContent = timerOnly ? 'Full view' : 'Timer only';
  $('timer-only').setAttribute('aria-pressed', String(timerOnly));
}

async function setTimerOnly(value) {
  const result = await invoke('view', { timerOnly: value });
  if (!result) return false;
  timerOnly = value;
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
  if (hadRun && !state.run) { $('race-setup').open = true; statsVisible = false; }
  clockAnchor = { server: state.serverNow, local: performance.now() };
  const key = JSON.stringify([state.seed, state.team, state.session, state.players.map(p => p.slot)]);
  if (key !== rosterKey) {
    selected = new Set(state.players.filter(p => !p.stopped).map(p => p.slot));
    rosterKey = key;
  }
  if (!state.run) for (const p of state.players) if (p.stopped) selected.delete(p.slot);
  const active = ['connecting', 'connected', 'reconnecting'].includes(state.connection);
  if (state.connection === 'connected') $('address').value = state.address;
  if (!wasConnected && state.connection === 'connected') $('connection-details').open = false;
  if (!active) $('connection-details').open = true;
  $('connection').textContent = state.connection[0].toUpperCase() + state.connection.slice(1);
  $('connection').className = `badge ${state.connection}`;
  for (const id of ['address', 'name', 'password', 'session', 'connect']) $(id).disabled = active;
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
  }
  tick();
}

function tick() {
  if (!state) return;
  const now = clockAnchor.server + performance.now() - clockAnchor.local;
  const run = state.run;
  const before = run && !state.allFinished && now < run.startedAt;
  updateReadiness(now);
  renderEvents(now);
  renderTimerPopup(now);
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
  for (const p of state.players) {
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
  await invoke('connect', { address: $('address').value, name: $('name').value, password: $('password').value, session: $('session').value });
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
$('timer-only').addEventListener('click', () => setTimerOnly(!timerOnly));
$('show-stats').addEventListener('click', async () => {
  if (timerOnly && !await setTimerOnly(false)) return;
  statsVisible = !statsVisible;
  updateView();
  if (statsVisible) $('results').scrollIntoView({ block: 'nearest' });
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && timerOnly) { event.preventDefault(); setTimerOnly(false); }
});
for (const action of ['start', 'finish', 'reset']) $(`solo-${action}`).addEventListener('click', () => invoke('solo', action));
window.runTimer.onState(accept);
invoke('state').then(result => {
  if (!result) return;
  for (const id of ['address', 'name', 'session']) if (result.preferences[id]) $(id).value = result.preferences[id];
});
setInterval(tick, 100);

