const SETTINGS_STATUS_POLL_MS = 5000;
const SETTINGS_BUILD_LABEL = "vpt-control-centre 1.0.0";
const SHELL_PERSIST_KEY = "vpt.control-centre.shell.collapsed";
let settingsIntroBackendStatus = "checking";
let settingsIntroTrackedSites = null;

function setConnectionStatus(state, text) {
  const statusEl = document.getElementById("connectionStatusShell");
  if (!statusEl) return;

  statusEl.textContent = text;
  statusEl.dataset.status = state;
  statusEl.title = text;
  statusEl.setAttribute("aria-label", text);
}

function setDiagnosticsBackendStatus(state, text) {
  const statusEl = document.getElementById("diagnosticsBackendValue");
  if (!statusEl) return;

  statusEl.textContent = text;
  statusEl.dataset.status = state;
  statusEl.title = text;
}

function setText(id, text) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.title = text;
}

function formatIntroBackendStatus(status) {
  if (status === "online") return "BACKEND ONLINE";
  if (status === "offline") return "BACKEND OFFLINE";
  return "BACKEND CHECKING";
}

function updateIntroStatus() {
  const parts = ["SQLITE LOCAL STORE", formatIntroBackendStatus(settingsIntroBackendStatus)];
  if (settingsIntroBackendStatus === "online" && settingsIntroTrackedSites !== null) {
    parts.push(`${formatCount(settingsIntroTrackedSites)} SITES`);
  }
  setText("settingsIntroStatus", parts.join(" · "));
}

function formatCount(value) {
  return new Intl.NumberFormat().format(Math.max(0, Number(value) || 0));
}

function padNumber(value) {
  return String(value).padStart(2, "0");
}

function formatDateTime(ts) {
  const numericTs = Number(ts);
  if (!Number.isFinite(numericTs) || numericTs <= 0) return "-";

  const date = new Date(numericTs);
  if (Number.isNaN(date.getTime())) return "-";

  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}`;
}

function isLocalStorageAvailable() {
  try {
    const probeKey = "__vpt_settings_probe__";
    window.localStorage.setItem(probeKey, "1");
    window.localStorage.removeItem(probeKey);
    return true;
  } catch (_error) {
    return false;
  }
}

function setExportEnabled(enabled) {
  const buttons = [
    document.getElementById("settingsExportCsvBtn"),
    document.getElementById("settingsExportJsonBtn"),
  ];

  buttons.forEach((button) => {
    if (!button) return;
    button.disabled = !enabled;
    button.setAttribute("aria-disabled", enabled ? "false" : "true");
  });
}

function createThemeCard(theme, activeThemeId) {
  const card = document.createElement("label");
  card.className = "settings-theme-card";
  card.dataset.themeId = theme.id;
  const preview = theme.preview || {};
  card.style.setProperty("--theme-preview-page", preview.page || "#08111f");
  card.style.setProperty("--theme-preview-panel", preview.panel || "#101b2e");
  card.style.setProperty("--theme-preview-raised", preview.raised || "#17243a");
  card.style.setProperty("--theme-preview-accent", preview.accent || "#7ea3d4");
  card.style.setProperty("--theme-preview-warning", preview.warning || "#f1c87f");
  card.innerHTML = `
    <input type="radio" name="control-centre-theme" value="${theme.id}" ${theme.id === activeThemeId ? "checked" : ""} />
    <div class="settings-theme-card-head">
      <div class="settings-theme-card-title">
        <div class="settings-theme-card-name">${theme.label}</div>
        <div class="settings-theme-card-copy">${theme.description}</div>
      </div>
      <span class="settings-theme-card-chip">${theme.id === activeThemeId ? "Active" : "Theme"}</span>
    </div>
    <div class="settings-theme-preview" aria-hidden="true">
      <div class="settings-theme-preview-strip">
        <div class="settings-theme-preview-block page"></div>
        <div class="settings-theme-preview-block panel"></div>
        <div class="settings-theme-preview-block raised"></div>
      </div>
      <div class="settings-theme-preview-rule"></div>
      <div class="settings-theme-preview-meta">
        <div class="settings-theme-preview-pill neutral"></div>
        <div class="settings-theme-preview-pill accent"></div>
        <div class="settings-theme-preview-pill warning"></div>
      </div>
    </div>
  `;
  card.classList.toggle("is-selected", theme.id === activeThemeId);
  return card;
}

function renderThemeSelector() {
  const selector = document.getElementById("themeSelector");
  const themeApi = window.VPT?.theme;
  if (!selector || !themeApi) return;

  const activeThemeId = themeApi.getTheme();
  const themes = themeApi.getThemes();
  selector.innerHTML = "";

  for (const theme of themes) {
    selector.appendChild(createThemeCard(theme, activeThemeId));
  }
}

function syncThemeSelectorState(activeThemeId) {
  const cards = Array.from(document.querySelectorAll(".settings-theme-card"));
  cards.forEach((card) => {
    const isSelected = card.dataset.themeId === activeThemeId;
    card.classList.toggle("is-selected", isSelected);
    const input = card.querySelector('input[type="radio"]');
    if (input) input.checked = isSelected;
    const chip = card.querySelector(".settings-theme-card-chip");
    if (chip) chip.textContent = isSelected ? "Active" : "Theme";
  });
}

function syncDiagnosticsThemeValue(themeId) {
  setText("diagnosticsThemeValue", String(themeId || "Unavailable"));
}

function bindThemeSelector() {
  const selector = document.getElementById("themeSelector");
  const themeApi = window.VPT?.theme;
  if (!selector || !themeApi) return;

  selector.addEventListener("change", (event) => {
    const input = event.target;
    if (!(input instanceof HTMLInputElement) || input.name !== "control-centre-theme") {
      return;
    }
    const nextThemeId = themeApi.setTheme(input.value);
    syncThemeSelectorState(nextThemeId);
    syncDiagnosticsThemeValue(nextThemeId);
  });

  window.addEventListener("vpt:themechange", (event) => {
    const nextThemeId = event?.detail?.themeId || themeApi.getTheme();
    syncThemeSelectorState(nextThemeId);
    syncDiagnosticsThemeValue(nextThemeId);
  });
}

function bindExportActions() {
  const utils = window.VPT?.utils;
  if (!utils) return;

  const csvButton = document.getElementById("settingsExportCsvBtn");
  const jsonButton = document.getElementById("settingsExportJsonBtn");

  csvButton?.addEventListener("click", () => {
    if (csvButton.disabled) return;
    utils.triggerDownload(utils.buildExportUrl("csv", {}));
  });

  jsonButton?.addEventListener("click", () => {
    if (jsonButton.disabled) return;
    utils.triggerDownload(utils.buildExportUrl("json", {}));
  });
}

function renderStaticDiagnostics() {
  const themeApi = window.VPT?.theme;
  const storageAvailable = isLocalStorageAvailable();
  const currentOrigin = window.location?.origin || "Unavailable";
  const apiSurface = (() => {
    try {
      return new URL("/api/", window.location.href).href.replace(/\/$/, "/*");
    } catch (_error) {
      return "Unavailable";
    }
  })();

  setText("storageCaptureValue", "SQLite on this device");
  setText("storageLocalityValue", "Local-only");
  setText("storagePreferenceValue", storageAvailable ? "Browser localStorage" : "Unavailable");

  setText("diagnosticsRuntimeValue", "Local-first");
  setText("diagnosticsStorageValue", "SQLite-backed local persistence");
  setText("diagnosticsThemeValue", themeApi?.getTheme?.() || "Unavailable");
  setText("diagnosticsPersistenceValue", storageAvailable ? "Available" : "Unavailable");
  setText("diagnosticsOriginValue", currentOrigin);
  setText("diagnosticsApiValue", apiSurface);
  setText("diagnosticsBuildValue", SETTINGS_BUILD_LABEL);
}

function summarizeSites(sites) {
  if (!Array.isArray(sites) || !sites.length) {
    return {
      trackedSites: 0,
      totalEvents: 0,
      blockedEvents: 0,
      observedEvents: 0,
      firstActivity: null,
      lastActivity: null,
    };
  }

  let totalEvents = 0;
  let blockedEvents = 0;
  let observedEvents = 0;
  let firstActivity = null;
  let lastActivity = null;

  for (const site of sites) {
    totalEvents += Number(site?.totalEvents) || 0;
    blockedEvents += Number(site?.blockedCount) || 0;
    observedEvents += Number(site?.observedCount) || 0;

    const firstSeen = Number(site?.firstSeen) || 0;
    const lastSeen = Number(site?.lastSeen) || 0;

    if (firstSeen > 0 && (firstActivity === null || firstSeen < firstActivity)) {
      firstActivity = firstSeen;
    }

    if (lastSeen > 0 && (lastActivity === null || lastSeen > lastActivity)) {
      lastActivity = lastSeen;
    }
  }

  return {
    trackedSites: sites.length,
    totalEvents,
    blockedEvents,
    observedEvents,
    firstActivity,
    lastActivity,
  };
}

function renderSiteSummary(summary, isOnline) {
  if (!isOnline) {
    setText("storageTrackedSitesValue", "Unavailable");
    setText("storageCapturedEventsValue", "Unavailable");
    setText("storageFirstActivityValue", "Unavailable");
    setText("storageLastActivityValue", "Unavailable");
    setText("storageBlockedEventsValue", "Unavailable");
    setText("storageObservedEventsValue", "Unavailable");
    return;
  }

  setText("storageTrackedSitesValue", formatCount(summary.trackedSites));
  setText("storageCapturedEventsValue", formatCount(summary.totalEvents));
  setText("storageBlockedEventsValue", formatCount(summary.blockedEvents));
  setText("storageObservedEventsValue", formatCount(summary.observedEvents));
  setText("storageFirstActivityValue", summary.firstActivity ? formatDateTime(summary.firstActivity) : "No captured events");
  setText("storageLastActivityValue", summary.lastActivity ? formatDateTime(summary.lastActivity) : "No captured events");
}

function renderPolicySummary(policyResponse, isAvailable) {
  if (!isAvailable || !policyResponse || typeof policyResponse !== "object") {
    setText("storagePolicyEntriesValue", "Unavailable");
    setText("storagePolicyChangeValue", "Unavailable");
    return;
  }

  const items = Array.isArray(policyResponse.items) ? policyResponse.items : [];
  const latestTs = Number(policyResponse.latestTs) || 0;

  setText("storagePolicyEntriesValue", formatCount(items.length));
  setText("storagePolicyChangeValue", latestTs > 0 ? formatDateTime(latestTs) : "No policy changes");
}

async function refreshSettingsReadouts() {
  const api = window.VPT?.api;
  if (!api) return;

  const [sitesResult, policiesResult] = await Promise.allSettled([
    api.getSites(),
    api.getPolicies(),
  ]);

  const sitesOnline = sitesResult.status === "fulfilled";
  const policiesOnline = policiesResult.status === "fulfilled";
  settingsIntroBackendStatus = sitesOnline ? "online" : "offline";
  const siteSummary = sitesOnline ? summarizeSites(sitesResult.value) : null;
  settingsIntroTrackedSites = siteSummary ? siteSummary.trackedSites : null;

  setConnectionStatus(
    sitesOnline ? "online" : "offline",
    sitesOnline ? "Connected to local backend" : "Backend unavailable - is server.js running?"
  );

  setDiagnosticsBackendStatus(
    sitesOnline ? "online" : "offline",
    sitesOnline ? "Online" : "Backend offline"
  );

  renderSiteSummary(
    siteSummary,
    sitesOnline
  );
  renderPolicySummary(policiesOnline ? policiesResult.value : null, policiesOnline);
  setText("diagnosticsLastCheckValue", formatDateTime(Date.now()));
  updateIntroStatus();
  setExportEnabled(sitesOnline);
}

window.addEventListener("load", () => {
  window.VPT?.shell?.initShell?.({
    currentSection: "settings",
    persistKey: SHELL_PERSIST_KEY,
  });

  renderThemeSelector();
  bindThemeSelector();
  bindExportActions();
  renderStaticDiagnostics();
  updateIntroStatus();
  setExportEnabled(false);
  setDiagnosticsBackendStatus("pending", "Checking...");
  refreshSettingsReadouts();
  window.setInterval(refreshSettingsReadouts, SETTINGS_STATUS_POLL_MS);
});
