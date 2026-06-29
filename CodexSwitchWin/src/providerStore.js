const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const { app } = require("electron");

const appDir = app.getPath("userData");
const configPath = path.join(appDir, "providers.json");

function defaultProvider() {
  return {
    id: "openai",
    name: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    apiKey: "",
    headers: {},
    defaultModel: "",
    modelMapping: { enabled: false, targetModel: "" },
    chatCompletionsBridgeEnabled: false
  };
}

function normalizeProvider(provider) {
  const item = provider && typeof provider === "object" ? provider : {};
  const defaultModel = String(item.defaultModel || "");
  const mapping = item.modelMapping && typeof item.modelMapping === "object" ? item.modelMapping : {};
  const mappingEnabled = Boolean(mapping.enabled);
  return {
    id: String(item.id || randomUUID()),
    name: String(item.name || "Provider"),
    baseURL: String(item.baseURL || ""),
    apiKey: String(item.apiKey || ""),
    headers: item.headers && typeof item.headers === "object" ? item.headers : {},
    defaultModel,
    modelMapping: {
      enabled: mappingEnabled,
      targetModel: mappingEnabled ? defaultModel : String(mapping.targetModel || "")
    },
    chatCompletionsBridgeEnabled: Boolean(item.chatCompletionsBridgeEnabled)
  };
}

function ensureConfig() {
  fs.mkdirSync(appDir, { recursive: true });
  if (!fs.existsSync(configPath)) {
    saveConfig({ activeProviderId: "openai", providers: [defaultProvider()] });
  }
}

function loadConfig() {
  ensureConfig();
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    config = { activeProviderId: "openai", providers: [defaultProvider()] };
  }
  const providers = Array.isArray(config.providers)
    ? config.providers.map(normalizeProvider)
    : [defaultProvider()];
  const activeProviderId = providers.some((provider) => provider.id === config.activeProviderId)
    ? config.activeProviderId
    : providers[0].id;
  const normalized = { activeProviderId, providers };
  saveConfig(normalized);
  return normalized;
}

function saveConfig(config) {
  fs.mkdirSync(appDir, { recursive: true });
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

module.exports = {
  appDir,
  configPath,
  defaultProvider,
  loadConfig,
  normalizeProvider,
  saveConfig
};
