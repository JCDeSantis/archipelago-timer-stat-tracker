const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { RunTimer } = require('./run-timer');
const { Settings } = require('./settings');
const { FeatureService } = require('./feature-service');

const TITLE = 'Archipelago Timer and Stat Tracker';
// The floating level can lose its topmost flag when Electron reorders behind
// the Windows taskbar. This documented level keeps the native flag intact.
const TOP_LEVEL = process.platform === 'win32' ? 'pop-up-menu' : 'floating';
const SELFTEST = process.env.AP_TIMER_SELFTEST;
const BACKGROUND_TEST = !!SELFTEST || process.env.AP_TIMER_BACKGROUND_TEST === '1';
if (BACKGROUND_TEST) app.disableHardwareAcceleration();
app.setName(TITLE);
app.setAppUserModelId('com.jcdesantis.archipelago-timer-stat-tracker');
// This app has its own profile and never reads or writes PO Launcher settings.
app.setPath('userData', process.env.AP_TIMER_USER_DATA || (SELFTEST
  ? fs.mkdtempSync(path.join(os.tmpdir(), 'ap-timer-selftest-'))
  : path.join(app.getPath('appData'), 'archipelago-timer-stat-tracker')));

let window = null;
let fullViewBounds = null;
let focusedStatsHeight = 0;
const settings = new Settings(app.getPath('userData'));
let features;
const timer = new RunTimer({ solo: settings.value.solo, saveSolo: solo => settings.save({ solo }), followRoomCountdown: settings.value.followRoomCountdown !== false,
  resolveRoster: players => features?.resolveRoster(players) });
features = new FeatureService({ directory: app.getPath('userData'), settings, timer, getWindow: () => window, backgroundTest: BACKGROUND_TEST });
const appState = () => ({ ...features.decorate(timer.snapshot()), alwaysOnTop: window?.isAlwaysOnTop() ?? settings.value.alwaysOnTop === true });
timer.on('change', state => {
  features.observe(state);
  if (state.connection === 'connected' && settings.value.connection?.address !== state.address) {
    settings.save({ connection: { address: state.address, name: timer.options.name, session: state.session } });
  }
  if (window && !window.isDestroyed()) window.webContents.send('run-timer-state', appState());
});

function createWindow() {
  window = new BrowserWindow({
    width: 900, height: 900, minWidth: 640, minHeight: 600,
    frame: false,
    show: !BACKGROUND_TEST, focusable: !BACKGROUND_TEST, skipTaskbar: BACKGROUND_TEST,
    title: TITLE, backgroundColor: '#141517', icon: path.join(__dirname, '..', 'assets', 'icon.png'),
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true, offscreen: BACKGROUND_TEST, backgroundThrottling: !BACKGROUND_TEST, preload: path.join(__dirname, 'run-timer-preload.js') },
  });
  window.setMenuBarVisibility(false);
  window.setAlwaysOnTop(settings.value.alwaysOnTop === true, TOP_LEVEL);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.loadFile(path.join(__dirname, 'run-timer.html'));
  window.on('closed', () => { window = null; });
  return window;
}

ipcMain.handle('run-timer-action', async (event, action, input) => {
  if (!window || event.sender !== window.webContents) throw new Error('Timer access denied.');
  try {
    if (action === 'state') return { state: appState(), preferences: settings.value.connection || {} };
    if (features.handles(action)) return { ...await features.handle(action, input), state: appState() };
    if (action === 'connect') {
      features.beforeConnect(input);
      timer.connect(input);
      settings.save({ connection: { address: timer.options.address, name: timer.options.name, session: timer.options.session } });
    } else if (action === 'disconnect') timer.disconnect();
    else if (action === 'start') timer.start(input?.slots, input?.countdown, input?.requireReady ?? false);
    else if (action === 'ready') timer.ready(input?.slots, input?.ready);
    else if (action === 'selection') { timer.select(input); features.rosterIssues = []; features.activeRoster = null; }
    else if (action === 'follow-countdown') {
      timer.followCountdown(input);
      settings.save({ followRoomCountdown: input });
    }
    else if (action === 'always-on-top') {
      if (typeof input !== 'boolean') throw new Error('Invalid always-on-top setting.');
      window.setAlwaysOnTop(input, TOP_LEVEL);
      settings.save({ alwaysOnTop: input });
    }
    else if (action === 'solo') timer.soloAction(input);
    else if (action === 'window-command') {
      if (input === 'minimize') window.minimize();
      else if (input === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      else if (input === 'close') { window.close(); return {}; }
      else throw new Error('Invalid window command.');
    }
    else if (action === 'view') {
      if (typeof input?.timerOnly !== 'boolean') throw new Error('Invalid timer view.');
      const rows = input.statsRows ?? 0;
      if (!Number.isInteger(rows) || rows < 0 || rows > 6) throw new Error('Invalid focused stats size.');
      if (input.timerOnly && !fullViewBounds) {
        fullViewBounds = { bounds: window.getBounds(), maximized: window.isMaximized() };
        if (fullViewBounds.maximized) window.unmaximize();
        window.setMinimumSize(360, 200);
        window.setSize(560, 280);
        focusedStatsHeight = 0;
      } else if (!input.timerOnly && fullViewBounds) {
        window.setMinimumSize(640, 600);
        window.setBounds(fullViewBounds.bounds);
        if (fullViewBounds.maximized) window.maximize();
        fullViewBounds = null;
        focusedStatsHeight = 0;
      }
      if (input.timerOnly && fullViewBounds) {
        const nextHeight = rows ? 52 + rows * 32 : 0;
        if (nextHeight !== focusedStatsHeight) {
          const [width, height] = window.getContentSize();
          window.setMinimumSize(360, 200 + nextHeight);
          window.setContentSize(width, height + nextHeight - focusedStatsHeight);
          focusedStatsHeight = nextHeight;
        }
      }
    }
    else if (action === 'export') {
      const result = await dialog.showSaveDialog(window, { title: 'Export run statistics', defaultPath: 'archipelago-run-statistics.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
      if (!result.canceled && result.filePath) {
        const state = timer.snapshot();
        const report = {
          application: TITLE, version: app.getVersion(), exportedAt: new Date().toISOString(),
          seed: state.seed, team: state.team, session: state.session,
          startedAt: state.run?.startedAt ?? null,
          startSource: state.run ? state.run.source ?? 'app' : null, countdownSeconds: state.run?.countdownSeconds ?? null,
          allFinished: state.allFinished, groupFinishedAt: state.groupFinishedAt,
          groupElapsedMs: state.groupFinishedAt === null ? null : Math.max(0, state.groupFinishedAt - state.run.startedAt),
          completedPlayers: state.players.filter(p => p.completed).length,
          releasedPlayers: state.players.filter(p => p.released && !p.completed).length,
          finishedPlayers: state.players.filter(p => p.stopped).length,
          stats: state.stats,
          events: state.events,
          players: state.players.map(p => ({ ...p, elapsedMs: p.finishedAt === null || !state.run ? null : Math.max(0, p.finishedAt - state.run.startedAt) })),
          solo: state.solo,
          timing: 'Real elapsed time. Archipelago finishes use live notification receipt. Null times are unknown, not zero.',
          checkTracking: 'Recorded ItemSend locations during the timed run, attributed to the finder. Duplicates and post-finish checks excluded. History may be incomplete after gaps or late joins. Automatic collect checks may be indistinguishable from play.',
          longestBK: 'Longest observed gap without a check, including start and finish boundaries. Group uses checks from all selected runners. Milliseconds; null until a known finish.',
        };
        fs.writeFileSync(result.filePath, JSON.stringify(report, null, 2));
      }
    } else throw new Error('Unknown timer action.');
    return { state: appState() };
  } catch (error) { return { error: error.message }; }
});

async function selfTest() {
  const report = { application: TITLE, packaged: app.isPackaged, checks: {} };
  try {
    if (window.webContents.isLoading()) await new Promise(resolve => window.webContents.once('did-finish-load', resolve));
    const result = await window.webContents.executeJavaScript(`(async () => {
      const initial = await window.runTimer.invoke('state');
      const library = await window.runTimer.invoke('library-meta');
      const topOn = await window.runTimer.invoke('always-on-top', true);
      const topOff = await window.runTimer.invoke('always-on-top', false);
      const started = await window.runTimer.invoke('solo', 'start');
      const finished = await window.runTimer.invoke('solo', 'finish');
      await window.runTimer.invoke('solo', 'reset');
      return { title: document.title, node: typeof require, state: !!initial.state, initialTop: initial.state?.alwaysOnTop,
        library: !initial.state?.historyError && Array.isArray(library.racers) && Array.isArray(library.profiles),
        features: typeof window.RaceFeatures === 'object' && !!document.getElementById('share-results-dialog') && document.getElementById('timer-stage').getBoundingClientRect().top < document.getElementById('workspace-nav').getBoundingClientRect().top,
        top: topOn.state?.alwaysOnTop === true && topOff.state?.alwaysOnTop === false,
        solo: !!started.state?.solo && Number.isFinite(finished.state?.solo?.finishedAt) };
    })()`);
    report.checks = {
      'standalone identity': result.title === TITLE,
      'isolated renderer': result.node === 'undefined',
      'preload and IPC': result.state,
      'solo controls': result.solo,
      'native always-on-top': result.top,
      'frameless window canvas': Math.abs(window.getBounds().height - window.getContentBounds().height) <= 4,
      'own settings profile': path.basename(app.getPath('userData')).startsWith('ap-timer-selftest-'),
      'local SQLite library': result.library,
      'timer-first feature controls': result.features,
    };
    report.initialAlwaysOnTop = result.initialTop;
    if (process.env.AP_TIMER_SCREENSHOT) {
      await window.webContents.executeJavaScript('document.fonts.ready.then(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))');
      fs.writeFileSync(process.env.AP_TIMER_SCREENSHOT, (await window.webContents.capturePage()).toPNG());
    }
  } catch (error) { report.error = error.stack; }
  report.ok = !report.error && Object.values(report.checks).every(Boolean);
  fs.writeFileSync(SELFTEST, JSON.stringify(report, null, 2));
  timer.disconnect();
  settings.flush();
  features.close();
  app.exit(report.ok ? 0 : 1);
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => {
    if (window && !BACKGROUND_TEST) { if (window.isMinimized()) window.restore(); window.show(); window.focus(); }
  });
  app.whenReady().then(() => { createWindow(); if (SELFTEST) selfTest(); });
}
app.on('window-all-closed', () => app.quit());
app.on('before-quit', () => { timer.disconnect(); settings.flush(); features.close(); });

module.exports = { createWindow };
