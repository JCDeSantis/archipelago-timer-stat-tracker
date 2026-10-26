// Runs the standalone app and its real preload/IPC against a loopback AP fixture.
const { app, BrowserWindow } = require('electron');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { once } = require('events');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-timer-ui-'));
app.setAppPath(path.resolve(__dirname, '..'));
process.env.AP_TIMER_USER_DATA = profile;

require('../main');

const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(predicate, label) {
  const deadline = Date.now() + 15000;
  while (!await predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`);
    await pause(30);
  }
}

app.whenReady().then(async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0, perMessageDeflate: true });
  try {
    await once(server, 'listening');
    const store = new Map();
    const statuses = { 1: 0, 2: 0 };
    const send = (ws, packet) => { if (ws.readyState === 1) ws.send(JSON.stringify([packet])); };
    server.on('connection', ws => {
      ws.keys = new Set();
      send(ws, { cmd: 'RoomInfo', seed_name: 'UI-test-multiworld', time: Date.now() / 1000 });
      ws.on('message', data => {
        for (const packet of JSON.parse(data)) {
          if (packet.cmd === 'Connect') send(ws, { cmd: 'Connected', team: 0, slot: 1,
            checked_locations: [], missing_locations: [101, 102, 103, 104],
            players: [{ team: 0, slot: 1, name: 'Link', alias: 'Link' }, { team: 0, slot: 2, name: 'Samus', alias: 'Samus' }],
            slot_info: { 1: { type: 1, game: 'A Link to the Past' }, 2: { type: 1, game: 'Super Metroid' } } });
          else if (packet.cmd === 'SetNotify') packet.keys.forEach(key => ws.keys.add(key));
          else if (packet.cmd === 'Get') send(ws, { ...packet, cmd: 'Retrieved', keys: Object.fromEntries(packet.keys.map(key => [key,
            key.startsWith('_read_client_status_0_') ? statuses[Number(key.split('_').at(-1))] : store.get(key) ?? null])) });
          else if (packet.cmd === 'Set') {
            let value = store.has(packet.key) ? store.get(packet.key) : packet.default;
            for (const op of packet.operations) if (op.operation === 'min') value = Math.min(value, op.value);
            else if (op.operation === 'update') value = { ...value, ...op.value };
            else if (op.operation === 'replace') value = op.value;
            store.set(packet.key, value);
            for (const client of server.clients) if (client.keys.has(packet.key)) send(client, { cmd: 'SetReply', key: packet.key, value });
          }
        }
      });
    });
    const timer = BrowserWindow.getAllWindows()[0];
    await until(() => !timer.webContents.isLoading(), 'standalone window load');
    assert.equal(await timer.webContents.executeJavaScript('document.title'), 'Archipelago Timer and Stat Tracker');
    const run = code => timer.webContents.executeJavaScript(code);
    const movePointer = async inside => {
      timer.focus(); timer.webContents.focus();
      if (inside) timer.webContents.sendInputEvent({ type: 'mouseEnter', x: 20, y: 30 });
      timer.webContents.sendInputEvent({ type: inside ? 'mouseMove' : 'mouseLeave', x: inside ? 20 : -1, y: inside ? 30 : -1 });
      try { await until(() => run(`getComputedStyle(document.querySelector('.timer-toolbar')).opacity === '${inside ? 1 : 0}'`), inside ? 'hover controls appear' : 'hover controls disappear'); }
      catch (error) { throw new Error(`${error.message}: ${await run(`JSON.stringify({hover: document.getElementById('timer-stage').matches(':hover'), opacity: getComputedStyle(document.querySelector('.timer-toolbar')).opacity})`)}; focused=${timer.isFocused()}`); }
    };
    const timerGeometry = () => run(`['group-clock', 'timer-popup', 'compact-bk'].map(id => {
      const {x, y, width, height} = document.getElementById(id).getBoundingClientRect(); return {x, y, width, height};
    })`);
    assert.equal(await run(`document.getElementById('show-stats').disabled`), true);
    await run(`document.getElementById('window-maximize').click()`);
    await until(() => timer.isMaximized(), 'custom maximize control');
    await run(`document.getElementById('window-maximize').click()`);
    await until(() => !timer.isMaximized(), 'custom restore control');
    await run(`document.getElementById('window-minimize').click()`);
    await until(() => timer.isMinimized(), 'custom minimize control');
    timer.restore();
    await until(() => !timer.isMinimized());
    await run(`document.getElementById('app-settings').open = true`);
    assert.equal(await run(`!!document.getElementById('always-on-top').closest('#app-settings')`), true);
    await run(`document.getElementById('always-on-top').click()`);
    try { await until(() => timer.isAlwaysOnTop(), 'always on top enabled'); }
    catch (error) { throw new Error(`${error.message}: ${await run(`document.getElementById('error').textContent + '; checked=' + document.getElementById('always-on-top').checked`)}`); }
    assert.equal(await run(`document.getElementById('timer-stage').getBoundingClientRect().top < document.getElementById('race-setup').getBoundingClientRect().top`), true);
    await run(`document.getElementById('address').value = 'ws://127.0.0.1:${server.address().port}';
      document.getElementById('name').value = 'Link';
      document.getElementById('connect-form').requestSubmit();`);
    await until(() => run(`document.getElementById('connection').textContent === 'Connected'`), 'connect through real UI');
    assert.equal(await run(`document.querySelectorAll('#players input:checked').length`), 2);
    assert.equal(await run(`document.getElementById('start').disabled`), true, 'start waits for ready confirmations');
    await run(`document.getElementById('ready').click()`);
    await until(() => run(`document.getElementById('ready').textContent === 'Not ready'`), 'local runner ready');
    assert.equal(await run(`document.getElementById('start').disabled`), true, 'another selected runner is not ready');
    // A second timer app on the same roster publishes its ready confirmation.
    const readyOne = [...store.entries()].find(([key]) => key.endsWith(':ready:1'));
    const readyTwoKey = readyOne[0].replace(/:1$/, ':2');
    const readyTwo = { ...readyOne[1], client: 'second-timer-fixture' };
    store.set(readyTwoKey, readyTwo);
    for (const ws of server.clients) send(ws, { cmd: 'SetReply', key: readyTwoKey, value: readyTwo });
    await until(() => run(`!document.getElementById('start').disabled`), 'all selected runners ready');
    const unreadyTwo = { ...readyTwo, ready: false };
    store.set(readyTwoKey, unreadyTwo);
    for (const ws of server.clients) send(ws, { cmd: 'SetReply', key: readyTwoKey, value: unreadyTwo });
    await until(() => run(`document.getElementById('start').disabled`), 'manual start blocks an unready runner');
    const roomCountdown = seconds => {
      for (const ws of server.clients) send(ws, { cmd: 'PrintJSON', type: 'Countdown', countdown: seconds,
        data: [{ text: `[Server]: Starting countdown of ${seconds}s` }] });
    };
    await run(`document.getElementById('follow-room-countdown').click()`);
    await until(() => run(`state.followRoomCountdown === false`), 'disable room countdown following');
    roomCountdown(5);
    await pause(100);
    assert.equal(await run(`state.run === null`), true, 'opted-out room countdown cannot start a run');
    await run(`document.getElementById('follow-room-countdown').click()`);
    await until(() => run(`state.followRoomCountdown === true`), 'enable room countdown following');
    roomCountdown(5);
    roomCountdown(5);
    await until(() => run(`document.getElementById('clock-label').textContent === 'STARTING IN'`), 'shared countdown');
    assert.equal(await run(`state.run.source`), 'archipelago-countdown');
    assert.equal(await run(`state.run.countdownSeconds`), 5);
    assert.equal(await run(`document.getElementById('countdown').value`), '10', 'room duration overrides the manual selector');
    assert.equal(await run(`state.run.requireReady`), false, 'room countdown bypasses app-only readiness');
    assert.equal(await run(`document.getElementById('group-detail').textContent`), 'Following Archipelago room countdown');
    const roomStartedAt = await run(`state.run.startedAt`);
    assert.equal(await run(`document.getElementById('race-setup').open`), false);
    assert.equal(await run(`document.getElementById('results').hidden`), true);
    const fullBounds = timer.getBounds();
    await run(`document.getElementById('timer-only').click()`);
    await until(() => run(`document.body.classList.contains('timer-only')`), 'timer-only mode');
    await until(() => run(`innerWidth < 600 && innerHeight < 350`), 'compact viewport resize settles');
    assert.deepEqual(timer.getMinimumSize(), [360, 200]);
    assert.equal(await run(`getComputedStyle(document.querySelector('header')).display`), 'none');
    assert.equal(await run(`getComputedStyle(document.getElementById('race-setup')).display`), 'none');
    assert.equal(await run(`document.getElementById('always-on-top').offsetParent === null`), true, 'settings are absent from Timer Only');
    assert.ok(timer.getBounds().height - timer.getContentBounds().height <= 4, 'frameless window has no native title bar');
    assert.equal(await run(`getComputedStyle(document.querySelector('.compact-drag')).getPropertyValue('app-region')`), 'drag');
    assert.equal(timer.isAlwaysOnTop(), true, 'compact mode preserves always on top');
    assert.equal(await run(`document.documentElement.scrollHeight <= innerHeight`), true);
    await run(`document.activeElement?.blur()`);
    await movePointer(false);
    const hiddenControlsGeometry = await timerGeometry();
    await movePointer(true);
    assert.deepEqual(await timerGeometry(), hiddenControlsGeometry, 'hover overlay does not move clocks or notifications');
    await movePointer(false);
    timer.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
    timer.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
    await until(() => run(`getComputedStyle(document.querySelector('.timer-toolbar')).opacity === '1'`), 'keyboard focus reveals controls');
    await run(`document.activeElement?.blur()`);
    timer.setSize(360, 200);
    await pause(100);
    assert.equal(await run(`document.getElementById('group-clock').getBoundingClientRect().right <= innerWidth`), true);
    await run(`document.getElementById('show-stats').click()`);
    await until(() => run(`!document.body.classList.contains('timer-only') && !document.getElementById('results').hidden`), 'show stats from compact timer');
    for (const [key, value] of Object.entries(fullBounds)) {
      assert.ok(Math.abs(timer.getBounds()[key] - value) <= 2, `restored ${key} allows Windows DPI rounding`);
    }
    await run(`document.getElementById('show-stats').click()`);
    assert.equal(await run(`document.getElementById('results').hidden`), true);
    await run(`document.getElementById('timer-only').click()`);
    await until(() => run(`document.body.classList.contains('timer-only')`));
    await run(`document.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}))`);
    await until(() => run(`!document.body.classList.contains('timer-only')`), 'escape restores full view');
    await run(`document.getElementById('always-on-top').click()`);
    await until(() => !timer.isAlwaysOnTop(), 'always on top disabled');
    await run(`document.getElementById('app-settings').open = false`);
    await pause(6200);
    roomCountdown(60);
    await pause(100);
    assert.equal(await run(`state.run.startedAt`), roomStartedAt, 'another room countdown cannot reset a running session');
    // Replay an older shared run to exercise the five-minute boundary without
    // changing the renderer clock or waiting five minutes in the test.
    const [runKey, originalRun] = [...store.entries()].find(([, value]) => value?.schema === 1 && value?.startedAt);
    const ageRun = async age => {
      const now = await run(`window.runTimer.invoke('state').then(result => result.state.serverNow)`);
      const value = { ...originalRun, startedAt: now - age, scheduledAt: now - age - 5000 };
      store.set(runKey, value);
      for (const ws of server.clients) send(ws, { cmd: 'SetReply', key: runKey, value });
      await until(() => run(`state.run.startedAt === ${value.startedAt}`), 'older shared run hydrated');
    };
    await ageRun(299000);
    assert.equal(await run(`document.getElementById('bk-alert').hidden`), true);
    assert.equal(await run(`document.getElementById('compact-bk').hidden`), true);
    await ageRun(300000);
    assert.equal(await run(`document.getElementById('bk-alert').hidden`), false);
    assert.equal(await run(`document.getElementById('bk-clock').textContent`), '00:05:00');
    const bkScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-bk.png');
    fs.mkdirSync(path.dirname(bkScreenshot), { recursive: true });
    await run(`document.getElementById('race-events').scrollIntoView({ block: 'center' })`);
    await run(`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    fs.writeFileSync(bkScreenshot, (await timer.webContents.capturePage()).toPNG());
    await run(`document.getElementById('timer-only').click()`);
    await until(() => run(`document.body.classList.contains('timer-only')`), 'compact BK timer');
    assert.equal(await run(`document.getElementById('timer-popup').dataset.type === 'bk'`), false, 'personal BK has no popup');
    assert.equal(await run(`getComputedStyle(document.getElementById('compact-bk')).display`), 'flex');
    timer.setSize(360, 200);
    await pause(150);
    assert.equal(await run(`document.getElementById('timer-popup').getBoundingClientRect().bottom <= document.getElementById('compact-bk').getBoundingClientRect().top`), true, 'BK timer sits below notifications at minimum size');
    assert.equal(await run(`document.getElementById('compact-bk').getBoundingClientRect().bottom <= innerHeight`), true, 'BK timer fits minimum window size');
    assert.equal(await run(`document.querySelector('#compact-bk span').getBoundingClientRect().bottom <= document.getElementById('compact-bk-clock').getBoundingClientRect().top + 1`), true, 'BK label sits above its clock within subpixel rounding');
    const smallClockFont = await run(`parseFloat(getComputedStyle(document.getElementById('group-clock')).fontSize)`);
    for (const [width, height] of [[1100, 240], [480, 700], [1000, 560]]) {
      timer.setSize(width, height);
      await pause(100);
      assert.equal(await run(`['group-clock', 'timer-popup', 'compact-bk'].every(id => {
        const r = document.getElementById(id).getBoundingClientRect();
        return r.left >= -1 && r.top >= -1 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1;
      })`), true, `clock and events fill ${width} × ${height} without clipping`);
    }
    assert.ok(await run(`parseFloat(getComputedStyle(document.getElementById('group-clock')).fontSize)`) > smallClockFont, 'clock grows with the window');
    await run(`document.activeElement?.blur()`);
    await movePointer(false);
    const bkGeometry = await timerGeometry();
    await movePointer(true);
    assert.deepEqual(await timerGeometry(), bkGeometry, 'hover overlay also preserves BK placement');
    await movePointer(false);
    timer.setSize(560, 280);
    await ageRun(600000);
    await until(() => run(`document.getElementById('timer-popup').dataset.type === 'bk' && document.getElementById('timer-popup').textContent.includes('Samus')`), 'another runner BK alert at ten minutes');
    const firstBK = await run(`document.getElementById('compact-bk-clock').textContent`);
    for (const ws of server.clients) send(ws, { cmd: 'PrintJSON', type: 'ItemSend', receiving: 1,
      item: { class: 'NetworkItem', player: 2, location: 201, item: 123, flags: 0 } });
    await until(() => run(`document.getElementById('stats-checks').textContent === '1'`), 'another runner check');
    assert.equal(await run(`document.getElementById('compact-bk').hidden`), false, 'another runner cannot clear your BK timer');
    await until(() => run(`document.getElementById('timer-popup').dataset.type === 'checks'`), 'notification alongside persistent BK timer');
    await until(() => run(`document.getElementById('compact-bk-clock').textContent !== '${firstBK}'`), 'BK timer updates live');
    await pause(350);
    const compactBKScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-compact-bk.png');
    fs.writeFileSync(compactBKScreenshot, (await timer.webContents.capturePage()).toPNG());
    await movePointer(true);
    const hoverScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-hover-controls.png');
    fs.writeFileSync(hoverScreenshot, (await timer.webContents.capturePage()).toPNG());
    await movePointer(false);
    await until(() => run(`document.getElementById('timer-popup').dataset.event === ''`), 'notification fades');
    assert.equal(await run(`document.getElementById('compact-bk').hidden`), false, 'BK timer remains after notification fades');
    for (const [slot, location] of [[1, 101], [1, 102], [1, 103], [2, 201], [1, 101]]) {
      for (const ws of server.clients) send(ws, { cmd: 'PrintJSON', type: 'ItemSend', receiving: 2,
        item: { class: 'NetworkItem', player: slot, location, item: 123, flags: 0 } });
    }
    await until(() => run(`document.getElementById('stats-checks').textContent === '4'`), 'deduplicated checks');
    assert.equal(await run(`document.getElementById('bk-alert').hidden`), true, 'local check clears the BK alert');
    assert.equal(await run(`document.getElementById('compact-bk').hidden`), true, 'local check clears the compact BK timer');
    await until(() => run(`!!document.querySelector('#event-list [data-event="half"]')`), 'over-half event');
    await until(() => run(`document.getElementById('timer-popup').dataset.type === 'half'`), 'compact halfway popup');
    assert.match(await run(`document.getElementById('timer-popup').textContent`), /Link.*over half/);
    await pause(350);
    const popupScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-popup.png');
    fs.writeFileSync(popupScreenshot, (await timer.webContents.capturePage()).toPNG());
    for (const slot of [1, 2]) {
      if (slot === 1) statuses[slot] = 30;
      for (const ws of server.clients) {
        send(ws, { cmd: 'PrintJSON', type: slot === 1 ? 'Goal' : 'Release', team: 0, slot });
        if (slot === 1) send(ws, { cmd: 'PrintJSON', type: 'Release', team: 0, slot });
      }
      await pause(slot === 1 ? 1150 : 150);
      if (slot === 1) {
        await until(() => run(`document.getElementById('timer-popup').dataset.type === 'goal'`), 'compact completion popup');
        assert.equal(await run(`getComputedStyle(document.getElementById('timer-popup')).color`), 'rgb(123, 206, 159)', 'completion popup is green');
      }
    }
    await until(() => run(`document.getElementById('group-detail').textContent === 'Everyone finished · Includes released players'`), 'group completion');
    assert.equal(await run(`document.getElementById('status-1').textContent`), 'Completed');
    assert.equal(await run(`document.getElementById('status-2').textContent`), 'Released');
    assert.equal(await run(`document.getElementById('results-state').textContent`), 'Final results');
    assert.equal(await run(`document.querySelector('#stats-1 td:nth-child(2)').textContent`), '3');
    assert.equal(await run(`document.querySelector('#stats-2 td:nth-child(2)').textContent`), '1');
    assert.match(await run(`document.getElementById('stats-bk').textContent`), /^\d\d:\d\d:\d\d$/);
    assert.equal(await run(`!!document.querySelector('#event-list [data-event="goal"]') && !!document.querySelector('#event-list [data-event="release"]') && !!document.querySelector('#event-list [data-event="finish"]')`), true);
    assert.equal(await run(`document.getElementById('bk-alert').hidden`), true, 'finished runner has no BK alert');
    assert.equal(await run(`document.getElementById('compact-bk').hidden`), true, 'finished runner has no compact BK timer');
    await until(() => run(`document.getElementById('timer-popup').dataset.type === 'finish'`), 'compact group-finish popup');
    assert.equal(await run(`getComputedStyle(document.getElementById('timer-popup')).color`), 'rgb(123, 206, 159)', 'group finish is green');
    assert.equal(await run(`getComputedStyle(document.querySelector('#event-list [data-event="goal"] span')).color`), 'rgb(123, 206, 159)', 'completion log entry is green');
    assert.equal(await run(`getComputedStyle(document.querySelector('#event-list [data-event="release"] span')).color`), 'rgb(123, 206, 159)', 'release log entry is green');
    await pause(350);
    const greenAlertScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-green-alert.png');
    fs.writeFileSync(greenAlertScreenshot, (await timer.webContents.capturePage()).toPNG());
    await until(() => run(`document.getElementById('timer-popup').dataset.type === 'release'`), 'compact release popup');
    assert.equal(await run(`getComputedStyle(document.getElementById('timer-popup')).color`), 'rgb(123, 206, 159)', 'release popup is green');
    const stopped = await run(`[1, 2].map(slot => document.getElementById('elapsed-' + slot).textContent).concat(document.getElementById('group-clock').textContent)`);
    await pause(1200);
    assert.deepEqual(await run(`[1, 2].map(slot => document.getElementById('elapsed-' + slot).textContent).concat(document.getElementById('group-clock').textContent)`), stopped);
    await run(`document.getElementById('disconnect').click()`);
    await until(() => run(`!document.getElementById('connect').disabled`), 'disconnect');
    await run(`document.getElementById('connect-form').requestSubmit()`);
    await until(() => run(`document.getElementById('connection').textContent === 'Connected' && document.getElementById('status-2').textContent === 'Released'`), 'restore released status');
    assert.equal(await run(`document.getElementById('stats-checks').textContent`), '4');
    assert.equal(await run(`document.getElementById('timer-popup').dataset.event`), '', 'reconnect does not replay previous popups');
    assert.equal(await run(`typeof require`), 'undefined');
    await run(`document.getElementById('timer-only').click()`);
    await until(() => run(`!document.body.classList.contains('timer-only')`));
    await run(`document.getElementById('solo-details').open = true`);
    await run(`document.getElementById('solo-start').click()`);
    await until(() => run(`!document.getElementById('solo-finish').disabled`), 'solo start');
    await run(`document.getElementById('solo-finish').click()`);
    await until(() => run(`document.getElementById('solo-finish').disabled`), 'solo finish');
    await run(`document.getElementById('solo-details').open = false`);
    await run(`document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))`);
    fs.mkdirSync(path.join(__dirname, '..', 'dist'), { recursive: true });
    const screenshot = path.join(__dirname, '..', 'dist', 'run-timer-connected.png');
    await run('window.scrollTo(0, 0)');
    fs.writeFileSync(screenshot, (await timer.webContents.capturePage()).toPNG());
    await run(`document.getElementById('show-stats').click()`);
    await run(`document.getElementById('results').scrollIntoView()`);
    await pause(150);
    const statsScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-statistics.png');
    fs.writeFileSync(statsScreenshot, (await timer.webContents.capturePage()).toPNG());
    await run(`document.getElementById('timer-only').click()`);
    await until(() => run(`document.body.classList.contains('timer-only')`));
    assert.equal(await run(`document.getElementById('timer-popup').dataset.event`), '', 'switching back to compact does not replay events');
    const timerScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-only.png');
    await pause(150);
    fs.writeFileSync(timerScreenshot, (await timer.webContents.capturePage()).toPNG());
    const report = { ok: true, checks: ['standalone identity', 'real preload and IPC', 'connect through form', 'select players', 'shared countdown', 'ready gate waits for all selected runners', 'ready confirmations share the selected roster', 'native always-on-top toggle', 'topmost persists in compact mode', 'personal BK hidden before five minutes', 'personal BK appears at five minutes', 'BK resets on local check and stops on finish', 'completion and release events', 'over-half milestone event', 'no personal BK popup', 'other runner BK alert at ten minutes', 'green finish and release popups and log entries', 'popup fits at minimum window size', 'compact halfway and completion popups', 'compact group-finish popup', 'no popup replay on reconnect or view switch', 'timer appears before setup', 'setup collapses on start', 'compact timer mode and minimum size', 'Show Stats restores full view', 'Hide Stats', 'Escape restores full view', 'goal and release labels', 'automatic release preserves completion', 'individual and group clocks stop', 'release survives reconnect', 'deduplicated finder check counts', 'individual and group run statistics', 'statistics survive reconnect', 'solo controls'], screenshot, statsScreenshot, timerScreenshot, bkScreenshot, popupScreenshot, greenAlertScreenshot };
    report.checks.push('persistent BK timer below compact notifications', 'compact BK fits minimum window size', 'compact BK updates live and survives popup expiry', 'another runner cannot clear compact BK', 'own check clears compact BK');
    report.checks.push('frameless Timer Only without native header', 'full-view minimize/maximize/restore controls', 'hover-only overlay controls without layout shifts', 'keyboard-accessible overlay', 'Always on top moved into Settings', 'wide/tall/large responsive timer layouts');
    report.checks.push('room countdown auto-starts without Start button', 'room countdown uses server duration and bypasses app-only ready gate', 'automatic countdown setting', 'duplicate countdowns preserve the shared start');
    report.compactBKScreenshot = compactBKScreenshot;
    report.hoverScreenshot = hoverScreenshot;
    fs.writeFileSync(path.join(__dirname, '..', 'dist', 'timer-ui-smoke.json'), JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report));
    app.exit(0);
  } catch (err) {
    console.error(err.stack);
    app.exit(1);
  } finally {
    for (const ws of server.clients) ws.terminate();
    server.close();
  }
});

