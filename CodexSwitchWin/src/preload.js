const { contextBridge, ipcRenderer } = require("electron");

contextBridge.exposeInMainWorld("codexSwitch", {
  state: () => ipcRenderer.invoke("state"),
  addProvider: () => ipcRenderer.invoke("add-provider"),
  saveProvider: (provider) => ipcRenderer.invoke("save-provider", provider),
  duplicateProvider: (id) => ipcRenderer.invoke("duplicate-provider", id),
  deleteProvider: (id) => ipcRenderer.invoke("delete-provider", id),
  selectProvider: (id) => ipcRenderer.invoke("select-provider", id),
  settings: (settings) => ipcRenderer.invoke("settings", settings),
  toggleProxy: () => ipcRenderer.invoke("toggle-proxy"),
  clearLogs: () => ipcRenderer.invoke("clear-logs"),
  copy: (value) => ipcRenderer.invoke("copy", value),
  onState: (callback) => ipcRenderer.on("state", (_event, state) => callback(state)),
  onLog: (callback) => ipcRenderer.on("log", (_event, line) => callback(line))
});
