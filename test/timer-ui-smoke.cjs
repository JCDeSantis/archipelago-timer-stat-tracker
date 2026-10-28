// Runs the standalone app and its real preload/IPC against a loopback AP fixture.
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');
const { once } = require('events');

const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'ap-timer-ui-'));
app.setAppPath(path.resolve(__dirname, '..'));
process.env.AP_TIMER_USER_DATA = profile;
process.env.AP_TIMER_BACKGROUND_TEST = '1';
// Exercise clipboard IPC without replacing the user's actual clipboard.
const clipboardCopies = [];
clipboard.writeText = text => clipboardCopies.push(text);
let nextOpenFile = null;
dialog.showOpenDialog = async () => ({ canceled: !nextOpenFile, filePaths: nextOpenFile ? [nextOpenFile] : [] });

require('../src/main');
const watchdog = setTimeout(() => { console.error('Background UI test exceeded three minutes.'); app.exit(1); }, 180000);
watchdog.unref();

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
    const chatMessages = [];
    const send = (ws, packet) => { if (ws.readyState === 1) ws.send(JSON.stringify([packet])); };
    server.on('connection', ws => {
      ws.keys = new Set();
      send(ws, { cmd: 'RoomInfo', seed_name: 'UI-test-multiworld', time: Date.now() / 1000 });
      ws.on('message', data => {
        for (const packet of JSON.parse(data)) {
          if (packet.cmd === 'Say') chatMessages.push(packet.text);
          else if (packet.cmd === 'Connect') send(ws, { cmd: 'Connected', team: 0, slot: 1,
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
    const capture = async file => {
      // Screenshots are supplementary: hidden GPU rendering must not block checks.
      try {
        const frame = await Promise.race([timer.webContents.capturePage(), pause(2000).then(() => null)]);
        if (frame) fs.writeFileSync(file, frame.toPNG());
      } catch (error) { console.warn(`Optional background screenshot unavailable: ${error.message}`); }
    };
    // All UI tests stay hidden and non-focusable, including on a developer's PC.
    assert.equal(timer.isVisible(), false);
    assert.equal(timer.isFocusable(), false);
    timer.webContents.debugger.attach('1.3');
    await timer.webContents.debugger.sendCommand('DOM.enable');
    await timer.webContents.debugger.sendCommand('CSS.enable');
    await timer.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
    const movePointer = async inside => {
      const { root } = await timer.webContents.debugger.sendCommand('DOM.getDocument');
      const { nodeId } = await timer.webContents.debugger.sendCommand('DOM.querySelector', { nodeId: root.nodeId, selector: '#timer-stage' });
      await timer.webContents.debugger.sendCommand('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: inside ? ['hover'] : [] });
      try { await until(() => run(`getComputedStyle(document.querySelector('.timer-toolbar')).opacity === '${inside ? 1 : 0}'`), inside ? 'hover controls appear' : 'hover controls disappear'); }
      catch (error) { throw new Error(`${error.message}: ${await run(`JSON.stringify({hover: document.getElementById('timer-stage').matches(':hover'), opacity: getComputedStyle(document.querySelector('.timer-toolbar')).opacity})`)}; focused=${timer.isFocused()}`); }
    };
    const timerGeometry = () => run(`['group-clock', 'timer-popup', 'compact-bk'].map(id => {
      const {x, y, width, height} = document.getElementById(id).getBoundingClientRect(); return {x, y, width, height};
    })`);
    assert.equal(await run(`document.getElementById('show-stats').disabled`), true);
    assert.equal(await run(`state.historyError`), '', 'SQLite history is available in Electron');
    assert.equal(await run(`document.getElementById('copy-results').hidden && document.getElementById('post-results').hidden`), true);
    assert.match(await run(`window.runTimer.invoke('copy-results').then(result => result.error)`), /once every/);
    assert.match(await run(`window.runTimer.invoke('post-results').then(result => result.error)`), /once every/);
    // Native minimize/maximize can show a hidden window; inspect their accessible
    // controls without activating them while the user is working or gaming.
    assert.equal(await run(`document.querySelectorAll('.window-controls button[aria-label]').length`), 3);
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
    await timer.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await timer.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 });
    await until(() => run(`getComputedStyle(document.querySelector('.timer-toolbar')).opacity === '1'`), 'keyboard focus reveals controls');
    await run(`document.activeElement?.blur()`);
    timer.setSize(360, 200);
    await pause(100);
    assert.equal(await run(`document.getElementById('group-clock').getBoundingClientRect().right <= innerWidth`), true);
    const compactStatsHeight = await run(`innerHeight`);
    await run(`document.getElementById('show-stats').click()`);
    await until(() => run(`document.body.classList.contains('timer-only') && !document.getElementById('focused-stats').hidden && innerHeight >= 316`), 'show focused stats below timer');
    assert.equal(await run(`document.getElementById('results').hidden`), true, 'detailed full-view results stay hidden');
    assert.equal(await run(`document.querySelectorAll('#focused-runner-stats tr').length`), 2);
    assert.equal(await run(`document.querySelector('#focused-runner-stats td:nth-child(2)').textContent`), '0');
    assert.equal(await run(`document.getElementById('focused-stats').getBoundingClientRect().top >= document.querySelector('.clock-card').getBoundingClientRect().bottom - 1`), true);
    await run(`document.getElementById('show-stats').click()`);
    await until(() => run(`Math.abs(innerHeight - ${compactStatsHeight}) <= 10`), 'hide stats restores compact height');
    // Extra display rows exercise six-runner capacity and independent scrolling.
    await run(`window.savedStatsState = structuredClone(state)`);
    for (const count of [6, 8]) {
      await run(`document.getElementById('show-stats').click()`);
      await until(() => run(`focusedStatsVisible`), 'focused stats toggled on');
      await run(`accept({...savedStatsState, players: Array.from({length: ${count}}, (_, index) => ({...savedStatsState.players[index % 2], slot: index + 1, name: 'Runner ' + (index + 1)}))})`);
      await run(`window.runTimer.invoke('view', {timerOnly: true, statsRows: 6})`);
      await until(() => run(`innerHeight >= 442 && !document.getElementById('focused-stats').hidden`), 'six-row focused stats space');
      assert.equal(await run(`document.getElementById('focused-stats-scroll').scrollHeight > document.getElementById('focused-stats-scroll').clientHeight`), count > 6, 'only more than six runners need scrolling');
      const fixedTimer = await timerGeometry();
      await run(`document.getElementById('focused-stats-scroll').scrollTop = 1000`);
      assert.equal(await run(`document.getElementById('focused-stats-scroll').scrollTop > 0`), count > 6);
      assert.deepEqual(await timerGeometry(), fixedTimer, 'scrolling runner stats does not move the timer or events');
      assert.equal(await run(`window.scrollY === 0 && document.documentElement.scrollHeight <= innerHeight`), true, 'the focused window itself does not scroll');
      if (count > 6) {
        await run(`accept(structuredClone(state))`);
        assert.ok(await run(`document.getElementById('focused-stats-scroll').scrollTop`) > 0, 'live updates preserve runner list scroll');
      }
      await run(`document.getElementById('show-stats').click()`);
      try { await until(() => run(`Math.abs(innerHeight - ${compactStatsHeight}) <= 10`), 'hide expanded focused stats'); }
      catch (error) { throw new Error(`${error.message}: baseline=${compactStatsHeight}, actual=${await run('innerHeight')}, bounds=${JSON.stringify(timer.getBounds())}`); }
    }
    await run(`accept(savedStatsState); delete window.savedStatsState`);
    await run(`document.getElementById('timer-only').click()`);
    await until(() => run(`!document.body.classList.contains('timer-only')`), 'Full view returns to full window');
    for (const [key, value] of Object.entries(fullBounds)) {
      assert.ok(Math.abs(timer.getBounds()[key] - value) <= 2, `restored ${key} allows Windows DPI rounding`);
    }
    await run(`document.getElementById('show-stats').click()`);
    assert.equal(await run(`document.getElementById('results').hidden`), false);
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
    await capture(bkScreenshot);
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
    assert.ok(await run(`parseFloat(getComputedStyle(document.getElementById('group-clock')).fontSize)`) > smallClockFont, `clock grows with the window: small=${smallClockFont}, current=${await run("JSON.stringify({width:innerWidth,height:innerHeight,font:getComputedStyle(document.getElementById('group-clock')).fontSize, card:document.querySelector('.clock-card').getBoundingClientRect().height})")}`);
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
    await capture(compactBKScreenshot);
    await movePointer(true);
    const hoverScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-hover-controls.png');
    await capture(hoverScreenshot);
    await movePointer(false);
    await until(() => run(`document.getElementById('timer-popup').dataset.event === ''`), 'notification fades');
    assert.equal(await run(`document.getElementById('compact-bk').hidden`), false, 'BK timer remains after notification fades');
    for (const [slot, location] of [[1, 101], [1, 102], [1, 103], [2, 201], [1, 101]]) {
      for (const ws of server.clients) send(ws, { cmd: 'PrintJSON', type: 'ItemSend', receiving: 2,
        item: { class: 'NetworkItem', player: slot, location, item: 123, flags: 0 } });
    }
    await until(() => run(`document.getElementById('stats-checks').textContent === '4'`), 'deduplicated checks');
    await run(`document.getElementById('show-stats').click()`);
    await until(() => run(`!document.getElementById('focused-stats').hidden`));
    assert.equal(await run(`document.querySelector('#focused-runner-stats td:nth-child(2)').textContent`), '3');
    assert.match(await run(`document.querySelector('#focused-runner-stats td:last-child').textContent`), /^00:1\d:\d\d$/, 'live longest BK includes the long gap before the latest check');
    await capture(path.join(__dirname, '..', 'dist', 'run-timer-focused-stats.png'));
    await run(`document.getElementById('show-stats').click()`);
    assert.equal(await run(`document.getElementById('bk-alert').hidden`), true, 'local check clears the BK alert');
    assert.equal(await run(`document.getElementById('compact-bk').hidden`), true, 'local check clears the compact BK timer');
    await until(() => run(`!!document.querySelector('#event-list [data-event="half"]')`), 'over-half event');
    await until(() => run(`document.getElementById('timer-popup').dataset.type === 'half'`), 'compact halfway popup');
    assert.match(await run(`document.getElementById('timer-popup').textContent`), /Link.*over half/);
    await pause(350);
    const popupScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-popup.png');
    await capture(popupScreenshot);
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
    await capture(greenAlertScreenshot);
    await until(() => run(`document.getElementById('timer-popup').dataset.type === 'release'`), 'compact release popup');
    assert.equal(await run(`getComputedStyle(document.getElementById('timer-popup')).color`), 'rgb(123, 206, 159)', 'release popup is green');
    const stopped = await run(`[1, 2].map(slot => document.getElementById('elapsed-' + slot).textContent).concat(document.getElementById('group-clock').textContent)`);
    await pause(1200);
    assert.deepEqual(await run(`[1, 2].map(slot => document.getElementById('elapsed-' + slot).textContent).concat(document.getElementById('group-clock').textContent)`), stopped);
    assert.equal(chatMessages.length, 0, 'race completion does not automatically post');
    assert.equal(clipboardCopies.length, 0, 'race completion does not automatically copy');
    await run(`document.getElementById('copy-results').click()`);
    await until(() => run(`document.getElementById('share-results-dialog').open && !document.getElementById('preview-copy').disabled`), 'review results before copying');
    assert.equal(clipboardCopies.length, 0, 'opening preview does not modify clipboard');
    await timer.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'rawKeyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await timer.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await until(() => run(`!document.getElementById('share-results-dialog').open`), 'Escape closes the preview');
    assert.equal(await run(`document.body.classList.contains('timer-only')`), true, 'Escape from a dialog keeps the compact timer view');
    await run(`document.getElementById('copy-results').click()`);
    await until(() => run(`document.getElementById('share-results-dialog').open && !document.getElementById('preview-copy').disabled`));
    await run(`document.getElementById('preview-copy').click()`);
    await until(() => clipboardCopies.length === 1, 'copy completed race results');
    assert.match(clipboardCopies[0], /Total Group Time: \d\d:\d\d:\d\d/);
    assert.match(clipboardCopies[0], /Link \(Completed\).*Checks: 3.*Longest BK: 00:1\d:\d\d/);
    assert.match(clipboardCopies[0], /Samus \(Released\).*Checks: 1/);
    await run(`document.getElementById('share-results-dialog').close(); document.getElementById('post-results').click()`);
    await until(() => run(`!document.getElementById('preview-post').disabled`), 'review target before posting');
    await run(`document.getElementById('preview-post').click()`);
    await until(() => chatMessages.length === clipboardCopies[0].split('\n').length, 'post each printable result line to simulated room');
    assert.equal(chatMessages.join('\n'), clipboardCopies[0], 'copy and chat use the same summary');
    assert.equal(await run(`document.getElementById('post-results').disabled`), true, 'posting again is disabled');
    await run(`document.getElementById('share-results-dialog').close()`);
    await movePointer(true);
    assert.equal(await run(`document.querySelector('.timer-toolbar').getBoundingClientRect().left >= 0 && document.querySelector('.timer-toolbar').getBoundingClientRect().right <= innerWidth`), true, 'result actions fit focused window');
    await movePointer(false);
    await run(`document.getElementById('disconnect').click()`);
    await until(() => run(`!document.getElementById('connect').disabled`), 'disconnect');
    await run(`document.getElementById('copy-results').click()`);
    await until(() => run(`!document.getElementById('preview-copy').disabled`), 'offline result preview');
    await run(`document.getElementById('preview-copy').click()`);
    await until(() => clipboardCopies.length === 2, 'copy final results offline');
    assert.equal(clipboardCopies[1], clipboardCopies[0]);
    assert.equal(await run(`document.getElementById('post-results').disabled`), true);
    await run(`document.getElementById('share-results-dialog').close()`);
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
    fs.mkdirSync(path.join(__dirname, '..', 'dist'), { recursive: true });
    const screenshot = path.join(__dirname, '..', 'dist', 'run-timer-connected.png');
    await run('window.scrollTo(0, 0)');
    await capture(screenshot);
    await run(`document.getElementById('show-stats').click()`);
    await run(`document.getElementById('results').scrollIntoView()`);
    await pause(150);
    const statsScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-statistics.png');
    await capture(statsScreenshot);
    await run(`document.getElementById('timer-only').click()`);
    await until(() => run(`document.body.classList.contains('timer-only')`));
    assert.equal(await run(`document.getElementById('timer-popup').dataset.event`), '', 'switching back to compact does not replay events');
    const timerScreenshot = path.join(__dirname, '..', 'dist', 'run-timer-only.png');
    await pause(150);
    await capture(timerScreenshot);
    // The tools remain secondary to the same live timer, and all fixtures stay local.
    await run(`AppTimer.setTimerOnly(false)`);
    await run(`document.querySelector('[data-workspace="history"]').click()`);
    await until(() => run(`!!document.getElementById('history-list') && document.querySelectorAll('.history-row').length > 0`), 'automatic local race history');
    assert.equal(await run(`document.getElementById('timer-stage').getBoundingClientRect().top < document.getElementById('workspace-nav').getBoundingClientRect().top`), true, 'timer remains above the new tools');
    const history = await run(`window.runTimer.invoke('history-list', {filter:'all'}).then(result => result.records)`);
    const unfinished = history.find(r => !r.allFinished);
    assert.ok(unfinished, 'interrupted observations are retained without an invented finish');
    await run(`document.querySelector('[data-history-id="${unfinished.id}"]').click()`);
    await until(() => run(`!!document.getElementById('history-track')`), 'historical tracking option');
    const sharedStartBeforeExclude = await run(`state.run.startedAt`);
    await run(`document.getElementById('history-track').click()`);
    await until(() => run(`document.getElementById('history-track').textContent === 'Restore tracking'`), 'call off unfinished historical run');
    assert.equal(await run(`state.run.startedAt`), sharedStartBeforeExclude, 'calling off a past run does not reset the shared timer');
    assert.equal(await run(`window.runTimer.invoke('history-list',{filter:'tracked'}).then(result => result.records.some(r => r.id === '${unfinished.id}'))`), false);
    await run(`document.getElementById('history-track').click()`);
    await until(() => run(`document.getElementById('history-track').textContent.includes('Call off')`), 'restore historical tracking');
    await run(`document.getElementById('history-dialog').close()`);
    await run(`document.getElementById('racer-name').value='Linked Runner';document.getElementById('racer-create').click()`);
    await until(() => run(`document.getElementById('alias-racer').value !== ''`), 'create local racer identity');
    await run(`document.getElementById('alias-name').value='Link';document.getElementById('alias-add').click()`);
    await until(() => run(`document.getElementById('alias-list').textContent.includes('Link')`), 'link a username');
    await run(`document.getElementById('history-query').value='Linked Runner';document.getElementById('history-query').dispatchEvent(new Event('input'))`);
    await until(() => run(`document.querySelectorAll('.history-row').length > 0 && document.getElementById('history-list').textContent.includes('Linked Runner')`), 'search history by linked identity');
    await capture(path.join(__dirname, '..', 'dist', 'run-timer-history.png'));
    await run(`RaceFeatures.openCard(state.activeHistoryId)`);
    await until(() => run(`document.getElementById('finish-card-dialog').open`), 'finish card preview');
    assert.equal(await run(`document.getElementById('finish-card-canvas').width`), 1200);
    assert.match(await run(`document.getElementById('finish-card-canvas').toDataURL('image/png').slice(0,30)`), /^data:image\/png;base64,/);
    await run(`document.getElementById('card-mode').value='1';document.getElementById('card-mode').dispatchEvent(new Event('change'))`);
    assert.equal(await run(`document.getElementById('finish-card-canvas').height`), 680, 'individual card');
    await capture(path.join(__dirname, '..', 'dist', 'run-timer-finish-card.png'));
    await run(`document.getElementById('finish-card-dialog').close();RaceFeatures.openAwards(state.activeHistoryId)`);
    await until(() => run(`document.getElementById('awards-dialog').open`), 'quality-aware race highlights');
    assert.match(await run(`document.getElementById('awards-content').textContent`), /At least two completed/);
    await run(`document.getElementById('awards-dialog').close();document.querySelector('[data-workspace="alerts"]').click()`);
    await until(() => run(`!!document.getElementById('preferences-save')`));
    await run(`document.querySelector('[data-popup="goal"]').checked=false;document.getElementById('sound-countdown').checked=true;document.getElementById('sound-volume').value='12';document.getElementById('preferences-save').click()`);
    await until(() => run(`state.featureSettings.sounds.enabled && !state.featureSettings.alerts.categories.goal.popup`), 'persist alert and sound preferences');
    await run(`document.getElementById('sound-test').click()`);
    assert.match(await run(`document.getElementById('alert-example').textContent`), /Audio suppressed/, 'background check never plays audio');
    assert.equal(await run(`document.getElementById('countdown-sound').options.length`), 4, 'four built-in sound choices');
    const audioFile = path.join(profile, 'My countdown.wav');
    const audioBytes = Buffer.alloc(1644);
    audioBytes.write('RIFF'); audioBytes.writeUInt32LE(1636, 4); audioBytes.write('WAVEfmt ', 8);
    audioBytes.writeUInt32LE(16, 16); audioBytes.writeUInt16LE(1, 20); audioBytes.writeUInt16LE(1, 22);
    audioBytes.writeUInt32LE(8000, 24); audioBytes.writeUInt32LE(16000, 28); audioBytes.writeUInt16LE(2, 32); audioBytes.writeUInt16LE(16, 34);
    audioBytes.write('data', 36); audioBytes.writeUInt32LE(1600, 40);
    fs.writeFileSync(audioFile, audioBytes); nextOpenFile = audioFile;
    await run(`document.getElementById('sound-import').click()`);
    await until(() => run(`document.getElementById('custom-sound-library')?.options.length === 2`), 'custom audio import');
    const customSoundId = await run(`document.getElementById('custom-sound-library').value`);
    assert.match(customSoundId, /^custom:[a-f0-9]{64}$/);
    nextOpenFile = null; fs.unlinkSync(audioFile);
    const savedAudio = await run(`window.runTimer.invoke('sound-read', {id:${JSON.stringify(customSoundId)}})`);
    assert.deepEqual(Buffer.from(savedAudio.data, 'base64'), audioBytes, 'saved copy survives removal of original');
    assert.equal(await run(`(async () => { const context = new OfflineAudioContext(1, 1, 8000); const bytes = Uint8Array.from(atob(${JSON.stringify(savedAudio.data)}), c => c.charCodeAt(0)); return (await context.decodeAudioData(bytes.buffer)).duration; })()`), .1, 'real Chromium decoder accepts imported WAV without audio output');
    await run(`document.getElementById('countdown-sound').value='arcade';document.getElementById('go-sound').value=${JSON.stringify(customSoundId)};document.querySelector('[data-sound-choice="goal"]').value='soft';document.getElementById('preferences-save').click()`);
    await until(() => run(`state.featureSettings.sounds.goId === ${JSON.stringify(customSoundId)} && state.featureSettings.sounds.countdownId === 'arcade' && state.featureSettings.alerts.categories.goal.soundId === 'soft'`), 'separate sound choices saved');
    await run(`document.getElementById('countdown-preview').click();document.getElementById('custom-sound-preview').click()`);
    await run(`document.querySelector('[data-workspace="health"]').click()`);
    assert.match(await run(`document.getElementById('health-details').textContent`), /Recording coverage/);
    await run(`window.runTimer.invoke('disconnect').then(result => AppTimer.invoke('state'))`);
    await run(`document.querySelector('[data-workspace="profiles"]').click()`);
    await until(() => run(`!!document.getElementById('profile-save')`));
    await run(`document.getElementById('profile-name').value='Weekend profile';document.getElementById('profile-address').value='ws://127.0.0.1:${server.address().port}';document.getElementById('profile-slot').value='Link';document.getElementById('profile-roster').value='Linked Runner';document.getElementById('profile-countdown').value='30';document.getElementById('profile-ready').checked=false;document.getElementById('profile-save').click()`);
    await until(() => run(`document.getElementById('profile-feedback').textContent.includes('saved locally')`), 'save race profile');
    const savedProfile = await run(`window.runTimer.invoke('library-meta').then(result => result.profiles[0])`);
    assert.equal(savedProfile.features.sounds.volume, 12);
    assert.equal(savedProfile.features.sounds.goId, customSoundId, 'profiles retain custom sound references');
    assert.equal(savedProfile.password, undefined);
    await run(`document.getElementById('profile-duplicate').click()`);
    await until(() => run(`window.runTimer.invoke('library-meta').then(result => result.profiles.length === 2)`), 'duplicate profile');
    await run(`document.getElementById('profile-delete').click()`);
    await until(() => run(`window.runTimer.invoke('library-meta').then(result => result.profiles.length === 1)`), 'delete profile without deleting history');
    await run(`document.getElementById('profile-select').value='${savedProfile.id}';document.getElementById('profile-select').dispatchEvent(new Event('change'))`);
    await until(() => run(`document.getElementById('profile-name').value === 'Weekend profile'`));
    const chatCountBeforeProfile = chatMessages.length;
    await run(`document.getElementById('profile-apply').click()`);
    await until(() => run(`document.body.dataset.workspace === 'live' && document.getElementById('session').value.startsWith('race-')`), 'apply fresh profile setup');
    assert.equal(await run(`state.connection`), 'disconnected', 'profile application never connects automatically');
    assert.equal(await run(`document.getElementById('countdown').value`), '30');
    assert.equal(await run(`document.getElementById('require-ready').checked`), false);
    assert.equal(chatMessages.length, chatCountBeforeProfile, 'profile application sends no chat or start command');
    await run(`document.querySelector('[data-workspace="profiles"]').click()`);
    await until(() => run(`!!document.getElementById('profile-import')`));
    nextOpenFile = path.join(profile, 'import-profile.json');
    fs.writeFileSync(nextOpenFile, JSON.stringify({ type: 'archipelago-race-profile', schema: 1, profile: { ...savedProfile, name: 'Imported profile', features: { ...savedProfile.features, sounds: { enabled: false, volume: 73, background: false } } } }));
    await run(`document.getElementById('profile-import').click()`);
    await until(() => run(`document.getElementById('profile-name').value === 'Imported profile'`), 'review imported profile');
    assert.equal(await run(`document.getElementById('profile-current-preferences').checked`), false, 'imported preferences are kept unless deliberately replaced');
    await run(`document.getElementById('profile-save').click()`);
    await until(() => run(`window.runTimer.invoke('library-meta').then(result => result.profiles.some(p => p.name === 'Imported profile' && p.features.sounds.volume === 73 && p.features.sounds.enabled === false))`), 'profile import preserves its own sound settings');
    await run(`document.querySelector('[data-workspace="alerts"]').click()`);
    await until(() => run(`!!document.getElementById('custom-sound-remove')`), 'saved sounds reopened');
    assert.equal(await run(`document.getElementById('go-sound').value`), customSoundId);
    await run(`document.getElementById('custom-sound-library').value=${JSON.stringify(customSoundId)};document.getElementById('custom-sound-remove').click()`);
    await until(() => run(`document.getElementById('custom-sound-library')?.options.length === 1 && state.featureSettings.sounds.goId === 'bell'`), 'custom removal restores built-in fallback');
    await run(`document.querySelector('[data-workspace="live"]').click()`);
    await capture(path.join(__dirname, '..', 'dist', 'run-timer-timer-first.png'));
    const report = { ok: true, checks: ['standalone identity', 'real preload and IPC', 'connect through form', 'select players', 'shared countdown', 'ready gate waits for all selected runners', 'ready confirmations share the selected roster', 'native always-on-top toggle', 'topmost persists in compact mode', 'personal BK hidden before five minutes', 'personal BK appears at five minutes', 'BK resets on local check and stops on finish', 'completion and release events', 'over-half milestone event', 'no personal BK popup', 'other runner BK alert at ten minutes', 'green finish and release popups and log entries', 'popup fits at minimum window size', 'compact halfway and completion popups', 'compact group-finish popup', 'no popup replay on reconnect or view switch', 'timer appears before setup', 'setup collapses on start', 'compact timer mode and minimum size', 'Show Stats opens focused runner panel', 'Hide Stats', 'Escape restores full view', 'goal and release labels', 'automatic release preserves completion', 'individual and group clocks stop', 'release survives reconnect', 'deduplicated finder check counts', 'individual and group run statistics', 'statistics survive reconnect', 'solo controls'], screenshot, statsScreenshot, timerScreenshot, bkScreenshot, popupScreenshot, greenAlertScreenshot };
    report.checks.push('persistent BK timer below compact notifications', 'compact BK fits minimum window size', 'compact BK updates live and survives popup expiry', 'another runner cannot clear compact BK', 'own check clears compact BK');
    report.checks.push('frameless Timer Only without native header', 'accessible full-view window controls', 'hover-only overlay controls without layout shifts', 'keyboard-accessible overlay', 'Always on top moved into Settings', 'wide/tall/large responsive timer layouts');
    report.checks.push('room countdown auto-starts without Start button', 'room countdown uses server duration and bypasses app-only ready gate', 'automatic countdown setting', 'duplicate countdowns preserve the shared start');
    report.checks.push('focused stats expand below the clock', 'six visible runners before independent scrolling', 'live runner checks and Longest BK', 'scroll position survives live updates', 'Hide Stats restores compact height');
    report.compactBKScreenshot = compactBKScreenshot;
    report.hoverScreenshot = hoverScreenshot;
    assert.equal(timer.isVisible(), false, 'UI test never shows its window');
    assert.equal(timer.isFocused(), false, 'UI test never takes native focus');
    report.checks.push('UI test remains hidden without stealing focus');
    report.checks.push('finished-only explicit chat posting', 'clipboard and chat summaries match', 'offline copy without modifying actual clipboard');
    report.checks.push('automatic SQLite history', 'called-off unfinished runs can be excluded and restored', 'username-linked history search', 'group and individual PNG finish cards', 'quality-aware awards', 'persisted alert and countdown preferences', 'background audio suppressed', 'connection health details', 'profile save duplicate delete and apply', 'fresh profile session without auto-connect', 'timer stays above all feature tools');
    report.checks.push('imported profiles retain their own notification settings', 'Escape closes compact dialogs without switching views');
    report.checks.push('four built-in sounds', 'custom audio copied independently of original', 'real silent Chromium audio decode', 'separate countdown GO and alert choices', 'profile custom sound references', 'custom removal restores built-in fallback');
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

