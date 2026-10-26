const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('runTimer', {
  invoke: (action, input) => ipcRenderer.invoke('run-timer-action', action, input),
  onState: callback => ipcRenderer.on('run-timer-state', (_event, state) => callback(state)),
});
