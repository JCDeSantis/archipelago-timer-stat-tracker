const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('runTimer', {
  invoke: (action, input) => ipcRenderer.invoke('run-timer-action', action, input),
  onHotkey: callback => ipcRenderer.on('run-timer-hotkey', (_event, message) => callback(message)),
  onState: callback => ipcRenderer.on('run-timer-state', (_event, state) => callback(state)),
});
