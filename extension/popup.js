const modeSel = document.getElementById("mode");
const statusEl = document.getElementById("status");
const firstEl = document.getElementById("first");
const thirdEl = document.getElementById("third");
const cookieCountEl = document.getElementById("cookieCount");
const captureStateLabel = document.getElementById("captureStateLabel");
const captureEnabledChk = document.getElementById("captureEnabled");
const promptOnNewSitesChk = document.getElementById("promptOnNewSites");
const trustedSitesEnabledChk = document.getElementById("trustedSitesEnabled");
const apiNotificationsEnabledChk = document.getElementById("apiNotificationsEnabled");
const cookieSnapshotBtn = document.getElementById("cookieSnapshotBtn");
const clearCookiesBtn = document.getElementById("clearCookiesBtn");
const currentSiteTrustBtn = document.getElementById("currentSiteTrustBtn");
const currentSiteTrustSite = document.getElementById("currentSiteTrustSite");
const currentSiteTrustStatus = document.getElementById("currentSiteTrustStatus");
const currentSiteTrustChip = document.getElementById("currentSiteTrustChip");
const currentSiteTrustSummary = document.getElementById("currentSiteTrustSummary");
const currentSiteTrustHeadline = document.getElementById("currentSiteTrustHeadline");
const currentSiteTrustCopy = document.getElementById("currentSiteTrustCopy");
const openTrustedSitesBtn = document.getElementById("openTrustedSitesBtn");
const openApiControlsBtn = document.getElementById("openApiControlsBtn");
const openSiteInsightsBtn = document.getElementById("openSiteInsightsBtn");
const apiPolicyGrid = document.getElementById("apiPolicyGrid");

const CONTROL_CENTRE_URL = "http://127.0.0.1:4141/";
const TRUSTED_SITES_MANAGER_URL = `${CONTROL_CENTRE_URL}?view=trusted-sites`;
const API_CONTROLS_URL = `${CONTROL_CENTRE_URL}?view=api-signals`;
const THEME_API_URL = `${CONTROL_CENTRE_URL}api/ui/theme`;

const POPUP_THEME_STORAGE_KEY = "vpt.popup.theme";
const DEFAULT_THEME_ID = "midnight";
const THEME_IDS = new Set(["midnight", "amber", "oxblood", "daybreak"]);

const API_POLICY_ACTION_LABELS = {
  observe: "Observe",
  warn: "Warn",
  block: "Block",
  allow_trusted: "Allow trusted",
};

const API_POLICY_SURFACES = [
  ["canvas", "Canvas"],
  ["clipboard", "Clipboard"],
  ["geolocation", "Geolocation"],
  ["webrtc", "WebRTC"],
];

let currentSiteTrustState = {
  supported: false,
  site: "",
  isTrusted: false,
  enabled: true,
  syncPending: false,
};
let captureEnabled = true;

function normalizeThemeId(themeId) {
  const candidate = String(themeId || "").trim().toLowerCase();
  return THEME_IDS.has(candidate) ? candidate : DEFAULT_THEME_ID;
}

function persistPopupTheme(themeId) {
  try {
    window.localStorage.setItem(POPUP_THEME_STORAGE_KEY, normalizeThemeId(themeId));
  } catch (_error) {
    // Ignore storage failures and keep the current session theme.
  }
}

function applyPopupTheme(themeId) {
  const nextTheme = normalizeThemeId(themeId);
  document.documentElement.dataset.theme = nextTheme;
  document.documentElement.style.colorScheme = nextTheme === "daybreak" ? "light" : "dark";
  persistPopupTheme(nextTheme);
  return nextTheme;
}

async function refreshPopupTheme() {
  try {
    const response = await fetch(THEME_API_URL, {
      method: "GET",
      headers: { Accept: "application/json" },
      cache: "no-store",
    });
    if (!response.ok) {
      throw new Error(`theme_http_${response.status}`);
    }
    const payload = await response.json();
    applyPopupTheme(payload?.themeId);
  } catch (_error) {
    applyPopupTheme(document.documentElement.dataset.theme || DEFAULT_THEME_ID);
  }
}

function setStatus(message, tone = "") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function getPolicyActionLabel(value) {
  return API_POLICY_ACTION_LABELS[String(value || "").trim()] || "Observe";
}

function getPolicyTone(value) {
  const action = String(value || "").trim();
  if (action === "block") return "danger";
  if (action === "warn") return "warn";
  if (action === "allow_trusted") return "success";
  return "";
}

function renderApiPolicySummary(policy = {}) {
  if (!apiPolicyGrid) return;
  apiPolicyGrid.innerHTML = API_POLICY_SURFACES.map(([key, label]) => {
    const action = String(policy[key] || "").trim() || "observe";
    return `
      <div class="api-policy-row">
        <div class="api-policy-main">
          <span class="api-policy-name">${label}</span>
          <span class="api-policy-copy">Live Browser API action</span>
        </div>
        <span class="api-policy-chip" data-tone="${getPolicyTone(action)}">${getPolicyActionLabel(action)}</span>
      </div>
    `;
  }).join("");
}

function syncCaptureUi() {
  if (captureEnabledChk) {
    captureEnabledChk.checked = captureEnabled;
  }
  if (captureStateLabel) {
    captureStateLabel.textContent = captureEnabled ? "Enabled" : "Paused";
  }
  if (cookieSnapshotBtn) {
    cookieSnapshotBtn.disabled = !captureEnabled || !currentSiteTrustState.supported;
    cookieSnapshotBtn.textContent = captureEnabled ? "Send snapshot" : "Capture paused";
  }
}

function setTrustPresentation(chipText, chipTone, headline, copy, buttonText, summaryTone = chipTone) {
  currentSiteTrustChip.textContent = chipText;
  currentSiteTrustChip.dataset.tone = chipTone;
  currentSiteTrustHeadline.textContent = headline;
  currentSiteTrustCopy.textContent = copy;
  currentSiteTrustSummary.dataset.tone = summaryTone;
  currentSiteTrustBtn.textContent = buttonText;
}

function setCurrentSiteTrustUi(state = {}) {
  if (!currentSiteTrustBtn || !currentSiteTrustSite || !currentSiteTrustStatus) return;

  const site = String(state.site || "");
  const supported = state.supported !== false;
  const loading = !!state.loading;
  const busy = !!state.busy;
  const isTrusted = !!state.isTrusted;
  const enabled = state.enabled !== false;
  const syncPending = !!state.syncPending;

  if (loading) {
    currentSiteTrustSite.textContent = "Checking current site...";
    currentSiteTrustStatus.textContent = "Reading current-site trust state.";
    setTrustPresentation(
      "Checking",
      "unsupported",
      "Checking trust state",
      "Trust affects navigation prompts and Browser API surfaces set to allow on trusted sites.",
      "Checking..."
    );
    currentSiteTrustBtn.disabled = true;
    if (openSiteInsightsBtn) openSiteInsightsBtn.disabled = true;
    return;
  }

  if (!supported || !site) {
    currentSiteTrustSite.textContent = "No supported website";
    currentSiteTrustStatus.textContent = "Current-site actions are available only on normal http or https pages.";
    setTrustPresentation(
      "Unsupported",
      "unsupported",
      "Trust unavailable here",
      "Open a normal website tab to trust it or jump into Site Insights.",
      "Trust site"
    );
    currentSiteTrustBtn.disabled = true;
    if (openSiteInsightsBtn) openSiteInsightsBtn.disabled = true;
    syncCaptureUi();
    return;
  }

  currentSiteTrustSite.textContent = site;
  currentSiteTrustStatus.textContent = syncPending
    ? "Saved locally. Control Centre sync is pending."
    : enabled
      ? "Trusted-site allow rules are active."
      : "Trusted-site allow rules are paused.";

  if (syncPending) {
    setTrustPresentation(
      "Sync pending",
      "pending",
      isTrusted ? `${site} is trusted` : `${site} is not trusted`,
      isTrusted
        ? "Trusted-site state is saved locally and waiting to sync to the Control Centre."
        : "Untrusted state is saved locally and waiting to sync to the Control Centre.",
      isTrusted ? "Remove trust" : "Trust site"
    );
  } else if (isTrusted) {
    setTrustPresentation(
      "Trusted",
      "trusted",
      `${site} is trusted`,
      "Skips the first-visit prompt and allows Browser API surfaces set to trusted-site allowance.",
      "Remove trust"
    );
  } else {
    setTrustPresentation(
      "Not trusted",
      "untrusted",
      `${site} is not trusted`,
      "Trust this site to skip the first-visit prompt and use trusted-site Browser API allowances.",
      "Trust site"
    );
  }

  currentSiteTrustBtn.disabled = busy;
  if (openSiteInsightsBtn) openSiteInsightsBtn.disabled = false;
  syncCaptureUi();
}

async function getCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab || null;
}

async function getCurrentTabUrl() {
  const tab = await getCurrentTab();
  return tab?.url || null;
}

async function openControlCentreUrl(url) {
  await chrome.tabs.create({ url });
}

async function refreshCurrentSiteTrust() {
  if (!currentSiteTrustBtn) return;

  setCurrentSiteTrustUi({ loading: true });
  try {
    const url = await getCurrentTabUrl();
    const res = await chrome.runtime.sendMessage({
      type: "trustedSites:getCurrentSiteState",
      url,
    });

    if (!res || !res.ok) {
      throw new Error(res?.error || "Could not load current-site trust state.");
    }

    currentSiteTrustState = {
      supported: !!res.supported,
      site: res.site || "",
      isTrusted: !!res.isTrusted,
      enabled: res.enabled !== false,
      syncPending: !!res.syncPending,
    };
    setCurrentSiteTrustUi(currentSiteTrustState);
  } catch (error) {
    console.error("Failed to load current-site trust state", error);
    currentSiteTrustState = {
      supported: false,
      site: "",
      isTrusted: false,
      enabled: true,
    };
    setCurrentSiteTrustUi(currentSiteTrustState);
    setStatus("Could not read current-site trust state.", "warn");
  }
}

async function updateCookieCount() {
  if (!cookieCountEl) return;

  try {
    const url = await getCurrentTabUrl();
    if (!url || !/^https?:/i.test(url)) {
      cookieCountEl.textContent = "n/a";
      return;
    }

    cookieCountEl.textContent = "...";

    const res = await chrome.runtime.sendMessage({
      type: "cookies:getSummary",
      url,
    });

    cookieCountEl.textContent = res?.ok ? String(res.count) : "error";
  } catch (error) {
    console.error("Failed to get cookie summary", error);
    cookieCountEl.textContent = "error";
  }
}

async function refreshApiPolicySummary() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: "api:gateStateSnapshot",
      refresh: true,
    });
    const policy = response?.ok && response.snapshot?.apiGatePolicy
      ? response.snapshot.apiGatePolicy
      : (await chrome.storage.local.get("apiGatePolicy")).apiGatePolicy;
    renderApiPolicySummary(policy || {});
  } catch (error) {
    console.error("Failed to refresh API policy summary", error);
    renderApiPolicySummary({});
  }
}

async function load() {
  const {
    privacyMode,
    stats,
    promptOnNewSites,
    trustedSitesEnabled,
    apiNotificationsEnabled,
    captureEnabled: storedCaptureEnabled,
  } = await chrome.storage.local.get([
    "privacyMode",
    "stats",
    "promptOnNewSites",
    "trustedSitesEnabled",
    "apiNotificationsEnabled",
    "captureEnabled",
  ]);

  captureEnabled = storedCaptureEnabled !== false;
  modeSel.value = privacyMode || "moderate";
  firstEl.textContent = String(stats?.firstParty || 0);
  thirdEl.textContent = String(stats?.thirdParty || 0);
  promptOnNewSitesChk.checked = promptOnNewSites !== false;
  trustedSitesEnabledChk.checked = trustedSitesEnabled !== false;
  if (apiNotificationsEnabledChk) {
    apiNotificationsEnabledChk.checked = apiNotificationsEnabled !== false;
  }
  syncCaptureUi();
  renderApiPolicySummary({});

  await Promise.all([
    refreshPopupTheme(),
    updateCookieCount(),
    refreshCurrentSiteTrust(),
    refreshApiPolicySummary(),
  ]);

  setStatus(
    captureEnabled
      ? "Ready. Capture and protection are active."
      : "Capture is paused. Protection and trust rules still run.",
    captureEnabled ? "" : "warn"
  );
}

modeSel.addEventListener("change", async () => {
  await chrome.storage.local.set({ privacyMode: modeSel.value });
  setStatus(`Saved protection mode: ${modeSel.value}.`, "success");
});

captureEnabledChk?.addEventListener("change", async () => {
  captureEnabled = captureEnabledChk.checked;
  await chrome.storage.local.set({ captureEnabled });
  syncCaptureUi();
  setStatus(
    captureEnabled
      ? "Capture resumed. New extension events will flow to the Control Centre."
      : "Capture paused. Protection and trust rules remain active.",
    captureEnabled ? "success" : "warn"
  );
});

promptOnNewSitesChk?.addEventListener("change", async () => {
  await chrome.storage.local.set({ promptOnNewSites: promptOnNewSitesChk.checked });
  setStatus(
    promptOnNewSitesChk.checked
      ? "First-visit trust prompt enabled."
      : "First-visit trust prompt paused.",
    "success"
  );
});

trustedSitesEnabledChk?.addEventListener("change", async () => {
  currentSiteTrustState.enabled = trustedSitesEnabledChk.checked;
  await chrome.storage.local.set({ trustedSitesEnabled: trustedSitesEnabledChk.checked });
  setCurrentSiteTrustUi(currentSiteTrustState);
  setStatus(
    trustedSitesEnabledChk.checked
      ? "Trusted-site allow rules enabled."
      : "Trusted-site allow rules paused. Saved trusted sites were kept.",
    trustedSitesEnabledChk.checked ? "success" : "warn"
  );
});

apiNotificationsEnabledChk?.addEventListener("change", async () => {
  await chrome.storage.local.set({ apiNotificationsEnabled: apiNotificationsEnabledChk.checked });
  setStatus(
    apiNotificationsEnabledChk.checked
      ? "Browser API detection notifications enabled."
      : "Browser API detection notifications paused.",
    apiNotificationsEnabledChk.checked ? "success" : "warn"
  );
});

clearCookiesBtn?.addEventListener("click", async () => {
  try {
    const url = await getCurrentTabUrl();
    if (!url || !/^https?:/i.test(url)) {
      setStatus("Can only clear cookies on normal websites.", "warn");
      return;
    }

    clearCookiesBtn.disabled = true;
    clearCookiesBtn.textContent = "Clearing...";

    const res = await chrome.runtime.sendMessage({
      type: "cookies:clearForSite",
      url,
    });

    if (!res || !res.ok) {
      setStatus("Failed to clear cookies for this site.", "warn");
    } else if ((res.cleared || 0) === 0) {
      setStatus("No site cookies needed clearing.", "warn");
    } else {
      setStatus(`Cleared ${res.cleared} cookie${res.cleared === 1 ? "" : "s"}.`, "success");
    }

    await updateCookieCount();
  } catch (error) {
    console.error("Failed to clear cookies", error);
    setStatus("Error clearing site cookies.", "warn");
  } finally {
    clearCookiesBtn.disabled = false;
    clearCookiesBtn.textContent = "Clear cookies";
  }
});

currentSiteTrustBtn?.addEventListener("click", async () => {
  if (!currentSiteTrustState.supported || !currentSiteTrustState.site) return;

  const nextTrusted = !currentSiteTrustState.isTrusted;
  currentSiteTrustBtn.disabled = true;
  currentSiteTrustBtn.textContent = nextTrusted ? "Saving trust..." : "Removing trust...";

  try {
    const url = await getCurrentTabUrl();
    const res = await chrome.runtime.sendMessage({
      type: "trustedSites:setCurrentSiteTrust",
      url,
      trusted: nextTrusted,
    });

    if (!res || !res.ok) {
      throw new Error(res?.error || "Could not update current-site trust.");
    }

    currentSiteTrustState = {
      supported: !!res.supported,
      site: res.site || "",
      isTrusted: !!res.isTrusted,
      enabled: res.enabled !== false,
      syncPending: !!res.syncPending,
    };
    trustedSitesEnabledChk.checked = res.enabled !== false;
    setCurrentSiteTrustUi(currentSiteTrustState);
    const synced = res.synced !== false;
    setStatus(
      synced
        ? (nextTrusted
          ? `${currentSiteTrustState.site} is now trusted.`
          : `${currentSiteTrustState.site} is no longer trusted.`)
        : (nextTrusted
          ? `${currentSiteTrustState.site} is trusted locally. Backend sync is pending.`
          : `${currentSiteTrustState.site} was removed from local trust. Backend sync is pending.`),
      synced ? "success" : "warn"
    );
  } catch (error) {
    console.error("Failed to update current-site trust", error);
    setStatus(error?.message || "Error updating current-site trust.", "warn");
    setCurrentSiteTrustUi({
      ...currentSiteTrustState,
      busy: false,
    });
  } finally {
    await refreshCurrentSiteTrust();
  }
});

openSiteInsightsBtn?.addEventListener("click", async () => {
  if (!currentSiteTrustState.supported || !currentSiteTrustState.site) return;
  await openControlCentreUrl(`${CONTROL_CENTRE_URL}site.html?site=${encodeURIComponent(currentSiteTrustState.site)}`);
});

openTrustedSitesBtn?.addEventListener("click", async () => {
  await openControlCentreUrl(TRUSTED_SITES_MANAGER_URL);
});

openApiControlsBtn?.addEventListener("click", async () => {
  await openControlCentreUrl(API_CONTROLS_URL);
});

cookieSnapshotBtn?.addEventListener("click", async () => {
  if (!captureEnabled) {
    setStatus("Capture is paused. Resume capture before sending a cookie snapshot.", "warn");
    return;
  }

  try {
    const url = await getCurrentTabUrl();
    if (!url || !/^https?:/i.test(url)) {
      setStatus("Cookie snapshots are available only on normal websites.", "warn");
      return;
    }

    cookieSnapshotBtn.disabled = true;
    cookieSnapshotBtn.textContent = "Sending...";

    const res = await chrome.runtime.sendMessage({
      type: "cookies:sendSnapshot",
      url,
    });

    if (!res || !res.ok) {
      setStatus("Cookie snapshot failed.", "warn");
    } else {
      setStatus(`Cookie snapshot sent (${res.count || 0} cookies).`, "success");
    }
  } catch (error) {
    console.error("Failed to send cookie snapshot", error);
    setStatus("Cookie snapshot error.", "warn");
  } finally {
    syncCaptureUi();
  }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "stats") {
    firstEl.textContent = String(msg.firstParty || 0);
    thirdEl.textContent = String(msg.thirdParty || 0);
  }
});

load();
