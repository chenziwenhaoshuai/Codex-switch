const { app, BrowserWindow, ipcMain, clipboard } = require("electron");
const path = require("node:path");
const fs = require("node:fs");
const { createProxyServer } = require("./proxy");
const { appDir, defaultProvider, loadConfig, normalizeProvider, saveConfig } = require("./providerStore");

let mainWindow;
let config;
let proxyServer = null;
let settings = {
  host: "127.0.0.1",
  port: "8787",
  logEnabled: false
};
const logLines = [];

function addLog(line) {
  const entry = `[${new Date().toLocaleTimeString()}] ${line}`;
  logLines.push(entry);
  if (logLines.length > 500) logLines.shift();
  mainWindow?.webContents.send("log", entry);
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 920,
    height: 646,
    minWidth: 780,
    minHeight: 560,
    title: "Codex Switch",
    backgroundColor: "#f6f7f9",
    webPreferences: {
      preload: path.join(__dirname, "preload.js")
    }
  });
  mainWindow.removeMenu();
  mainWindow.loadFile(path.join(__dirname, "renderer", "index.html"));
}

function state() {
  return {
    config,
    settings,
    running: Boolean(proxyServer),
    logs: logLines,
    appDir
  };
}

async function startProxy() {
  if (proxyServer) return;
  const port = Number(settings.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid port");
  proxyServer = await createProxyServer({
    host: settings.host || "127.0.0.1",
    port,
    getConfig: () => config,
    log: addLog
  });
  addLog(`Codex Switch started on http://${settings.host}:${settings.port}`);
}

function stopProxy() {
  if (!proxyServer) return;
  proxyServer.close();
  proxyServer = null;
  addLog("Codex Switch stopped");
}

function persistConfig(nextConfig) {
  config = nextConfig;
  saveConfig(config);
  mainWindow?.webContents.send("state", state());
}

app.whenReady().then(() => {
  config = loadConfig();
  createWindow();

  ipcMain.handle("state", () => state());
  ipcMain.handle("save-provider", (_event, provider) => {
    const normalized = normalizeProvider(provider);
    const providers = [...config.providers];
    const index = providers.findIndex((item) => item.id === normalized.id);
    if (index >= 0) providers[index] = normalized;
    else providers.push(normalized);
    persistConfig({ ...config, activeProviderId: normalized.id, providers });
    return state();
  });
  ipcMain.handle("add-provider", () => {
    const provider = { ...defaultProvider(), id: crypto.randomUUID(), name: "New Provider" };
    persistConfig({ ...config, activeProviderId: provider.id, providers: [...config.providers, provider] });
    return state();
  });
  ipcMain.handle("duplicate-provider", (_event, id) => {
    const provider = config.providers.find((item) => item.id === id);
    if (!provider) return state();
    const copy = { ...provider, id: crypto.randomUUID(), name: `${provider.name} Copy` };
    persistConfig({ ...config, activeProviderId: copy.id, providers: [...config.providers, copy] });
    return state();
  });
  ipcMain.handle("delete-provider", (_event, id) => {
    if (config.providers.length <= 1) throw new Error("Keep at least one provider");
    const providers = config.providers.filter((item) => item.id !== id);
    const activeProviderId = config.activeProviderId === id ? providers[0].id : config.activeProviderId;
    persistConfig({ activeProviderId, providers });
    return state();
  });
  ipcMain.handle("select-provider", (_event, id) => {
    if (config.providers.some((item) => item.id === id)) persistConfig({ ...config, activeProviderId: id });
    return state();
  });
  ipcMain.handle("settings", (_event, next) => {
    settings = { ...settings, ...next };
    mainWindow?.webContents.send("state", state());
    return state();
  });
  ipcMain.handle("toggle-proxy", async () => {
    if (proxyServer) stopProxy();
    else await startProxy();
    mainWindow?.webContents.send("state", state());
    return state();
  });
  ipcMain.handle("copy", (_event, value) => {
    clipboard.writeText(String(value || ""));
  });
  ipcMain.handle("clear-logs", () => {
    const logDir = path.join(appDir, "logs");
    fs.rmSync(logDir, { recursive: true, force: true });
    fs.mkdirSync(logDir, { recursive: true });
    logLines.length = 0;
    addLog("Log cache cleared");
    mainWindow?.webContents.send("state", state());
    return state();
  });
});

app.on("window-all-closed", () => {
  stopProxy();
  app.quit();
});
