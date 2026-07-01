let currentState = null;
let editingProvider = null;

const $ = (id) => document.getElementById(id);

function initials(name) {
  const words = String(name || "").trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return `${words[0][0]}${words[1][0]}`.toUpperCase();
  return String(name || "PR").slice(0, 2).toUpperCase();
}

function baseUrl() {
  const { host, port } = currentState.settings;
  return `http://${host}:${port}/v1`;
}

function render(state) {
  currentState = state;
  const providers = $("providers");
  providers.innerHTML = "";
  for (const provider of state.config.providers) {
    const active = provider.id === state.config.activeProviderId;
    const row = document.createElement("article");
    row.className = `provider${active ? " active" : ""}`;
    row.innerHTML = `
      <div class="drag">☰</div>
      <div class="avatar">${initials(provider.name)}</div>
      <div class="meta">
        <div class="name-row">
          <div class="name">${escapeHtml(provider.name)}</div>
          <span class="tag ${provider.apiKey ? "" : "empty"}">${provider.apiKey ? "API Key" : "No Key"}</span>
        </div>
        <div class="url">${escapeHtml(provider.baseURL)}</div>
      </div>
      <div class="actions">
        <button class="use">${active ? "✓ Selected" : "▶ Use"}</button>
        <button class="tool edit" title="Edit">✎</button>
        <button class="tool copy-provider" title="Duplicate">⧉</button>
        <button class="tool delete" title="Delete">⌫</button>
      </div>
    `;
    row.querySelector(".use").addEventListener("click", () => selectProvider(provider.id));
    row.querySelector(".edit").addEventListener("click", () => openProviderDialog(provider));
    row.querySelector(".copy-provider").addEventListener("click", () => duplicateProvider(provider.id));
    row.querySelector(".delete").addEventListener("click", () => deleteProvider(provider.id));
    providers.append(row);
  }

  $("runToggle").checked = state.running;
  $("statusDot").classList.toggle("running", state.running);
  $("statusText").textContent = state.running ? "Running" : "Stopped";
  const active = state.config.providers.find((provider) => provider.id === state.config.activeProviderId);
  $("activeName").textContent = active ? active.name : "";
  $("baseUrl").textContent = baseUrl();
  $("hostInput").value = state.settings.host;
  $("portInput").value = state.settings.port;
  $("logEnabled").checked = state.settings.logEnabled;
  $("logs").textContent = state.logs.join("\n");
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function refresh() {
  render(await window.codexSwitch.state());
}

async function selectProvider(id) {
  render(await window.codexSwitch.selectProvider(id));
}

async function duplicateProvider(id) {
  render(await window.codexSwitch.duplicateProvider(id));
}

async function deleteProvider(id) {
  if (!confirm("Delete this provider?")) return;
  try {
    render(await window.codexSwitch.deleteProvider(id));
  } catch (error) {
    showMessage(error.message);
  }
}

function openProviderDialog(provider) {
  editingProvider = provider;
  $("providerName").value = provider.name || "";
  $("providerBase").value = provider.baseURL || "";
  $("providerKey").value = provider.apiKey || "";
  $("providerModel").value = provider.defaultModel || "";
  $("providerMapping").checked = Boolean(provider.modelMapping?.enabled);
  $("providerBridge").checked = Boolean(provider.chatCompletionsBridgeEnabled);
  $("providerWebSearch").checked = Boolean(provider.openRouterWebSearchEnabled);
  $("providerDialog").showModal();
}

async function saveProvider() {
  const provider = {
    ...editingProvider,
    name: $("providerName").value.trim(),
    baseURL: $("providerBase").value.trim(),
    apiKey: $("providerKey").value.trim(),
    defaultModel: $("providerModel").value.trim(),
    modelMapping: {
      enabled: $("providerMapping").checked,
      targetModel: $("providerMapping").checked ? $("providerModel").value.trim() : ""
    },
    chatCompletionsBridgeEnabled: $("providerBridge").checked,
    openRouterWebSearchEnabled: $("providerWebSearch").checked
  };
  if (!provider.name || !provider.baseURL) {
    showMessage("Name and Base URL are required");
    return;
  }
  render(await window.codexSwitch.saveProvider(provider));
}

function showMessage(text) {
  $("message").textContent = text;
  setTimeout(() => {
    if ($("message").textContent === text) $("message").textContent = "";
  }, 3000);
}

function wire() {
  $("addBtn").addEventListener("click", async () => {
    const state = await window.codexSwitch.addProvider();
    render(state);
    const provider = state.config.providers.find((item) => item.id === state.config.activeProviderId);
    openProviderDialog(provider);
  });
  $("settingsBtn").addEventListener("click", () => $("settingsDialog").showModal());
  $("logsBtn").addEventListener("click", () => $("logsPanel").classList.toggle("hidden"));
  $("closeLogs").addEventListener("click", () => $("logsPanel").classList.add("hidden"));
  $("copyBtn").addEventListener("click", () => {
    window.codexSwitch.copy(baseUrl());
    showMessage("Copied");
  });
  $("runToggle").addEventListener("change", async () => {
    try {
      render(await window.codexSwitch.toggleProxy());
    } catch (error) {
      showMessage(error.message);
      $("runToggle").checked = false;
    }
  });
  $("saveProviderBtn").addEventListener("click", (event) => {
    event.preventDefault();
    saveProvider().then(() => $("providerDialog").close());
  });
  $("saveSettingsBtn").addEventListener("click", async (event) => {
    event.preventDefault();
    const next = {
      host: $("hostInput").value.trim() || "127.0.0.1",
      port: $("portInput").value.trim() || "8787",
      logEnabled: $("logEnabled").checked
    };
    render(await window.codexSwitch.settings(next));
    $("settingsDialog").close();
  });
  $("setBaseBtn").addEventListener("click", () => {
    window.codexSwitch.copy(`base_url = "${baseUrl()}"`);
    showMessage("base_url copied");
  });
  $("clearLogsBtn").addEventListener("click", async () => render(await window.codexSwitch.clearLogs()));
  window.codexSwitch.onState(render);
  window.codexSwitch.onLog((line) => {
    if (!currentState) return;
    currentState.logs.push(line);
    render(currentState);
  });
  window.codexSwitch.onAskClose(() => {
    $("closeDialog").showModal();
  });
  $("minimizeBtn").addEventListener("click", () => {
    $("closeDialog").close();
    window.codexSwitch.minimizeToTray();
  });
  $("quitBtn").addEventListener("click", () => {
    window.codexSwitch.quitApp();
  });
}

wire();
refresh();
