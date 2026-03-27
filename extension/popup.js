const modeSel = document.getElementById("mode");
const statusEl = document.getElementById("status");
const firstEl = document.getElementById("first");
const thirdEl = document.getElementById("third");
const cookieCountEl = document.getElementById("cookieCount");
const captureStateLabel = document.getElementById("captureStateLabel");
const captureEnabledChk = document.getElementById("captureEnabled");
const promptOnNewSitesChk = document.getElementById("promptOnNewSites");
const trustedSitesEnabledChk = document.getElementById("trustedSitesEnabled");
const cookieSnapshotBtn = document.getElementById("cookieSnapshotBtn");
const clearCookiesBtn = document.getElementById("clearCookiesBtn");
const currentSiteTrustBtn = document.getElementById("currentSiteTrustBtn");
const currentSiteTrustSite = document.getElementById("currentSiteTrustSite");
const currentSiteTrustStatus = document.getElementById("currentSiteTrustStatus");
const currentSiteTrustHeadline = document.getElementById("currentSiteTrustHeadline");
const currentSiteTrustCopy = document.getElementById("currentSiteTrustCopy");
const openTrustedSitesBtn = document.getElementById("openTrustedSitesBtn");
const openApiControlsBtn = document.getElementById("openApiControlsBtn");
const openSiteInsightsBtn = document.getElementById("openSiteInsightsBtn");
const apiPolicyGrid = document.getElementById("apiPolicyGrid");

const CONTROL_CENTRE_URL = "http://127.0.0.1:4141/";
const TRUSTED_SITES_MANAGER_URL = `${CONTROL_CENTRE_URL}?view=trusted-sites`;
const API_CONTROLS_URL = `${CONTROL_CENTRE_URL}?view=api-signals`;

const API_POLICY_ACTION_LABELS = {
  observe: "Observe",
  warn: "Warn",
  block: "Block",
  allow_trusted: "Allow on trusted sites",
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
};
let captureEnabled = true;

function setStatus(message, tone = "") {
  if (!statusEl) return;
  statusEl.textContent = message;
  statusEl.dataset.tone = tone;
}

function getPolicyActionLabel(value) {
  return API_POLICY_ACTION_LABELS[String(value || "").trim()] || "Observe";
}

function renderApiPolicySummary(policy = {}) {
  if (!apiPolicyGrid) return;
  apiPolicyGrid.innerHTML = API_POLICY_SURFACES.map(([key, label]) => `
    <div class="api-policy-item">
      <span class="api-policy-label">${label}</span>
      <span class="api-policy-value">${getPolicyActionLabel(policy[key])}</span>
    </div>
  `).join("");
}

function syncCaptureUi() {
  if (captureEnabledChk) {
    captureEnabledChk.checked = captureEnabled;
  }
  if (captureStateLabel) {
    captureStateLabel.textContent = captureEnabled ? "On" : "Paused";
  }
  if (cookieSnapshotBtn) {
    cookieSnapshotBtn.disabled = !captureEnabled || !currentSiteTrustState.supported;
    cookieSnapshotBtn.textContent = captureEnabled
      ? "Send cookie snapshot"
      : "Capture paused";
  }
}

function setCurrentSiteTrustUi(state = {}) {
  if (!currentSiteTrustBtn || !currentSiteTrustSite || !currentSiteTrustStatus) return;

  const site = String(state.site || "");
  const supported = state.supported !== false;
  const loading = !!state.loading;
  const busy = !!state.busy;
  const isTrusted = !!state.isTrusted;
  const enabled = state.enabled !== false;

  if (loading) {
    currentSiteTrustSite.textContent = "Checking current site...";
    currentSiteTrustStatus.textContent = "Reading current-site trust state.";
    currentSiteTrustHeadline.textContent = "Checking trust state";
    currentSiteTrustCopy.textContent = "Trust affects the navigation shortcut and any Browser API surfaces set to Allow on trusted sites.";
    currentSiteTrustBtn.textContent = "Checking...";
    currentSiteTrustBtn.disabled = true;
    if (openSiteInsightsBtn) openSiteInsightsBtn.disabled = true;
    return;
  }

  if (!supported || !site) {
    currentSiteTrustSite.textContent = "No supported website";
    currentSiteTrustStatus.textContent = "Current-site actions are available only on normal http or https pages.";
    currentSiteTrustHeadline.textContent = "Trust unavailable here";
    currentSiteTrustCopy.textContent = "Open a normal website tab to trust it or jump into Site Insights.";
    currentSiteTrustBtn.textContent = "Trust current site";
    currentSiteTrustBtn.disabled = true;
    if (openSiteInsightsBtn) openSiteInsightsBtn.disabled = true;
    syncCaptureUi();
    return;
  }

  currentSiteTrustSite.textContent = site;
  currentSiteTrustStatus.textContent = enabled
    ? "Trusted-site allow rules are active."
    : "Trusted-site allow rules are currently paused.";
  currentSiteTrustHeadline.textContent = isTrusted
    ? `${site} is trusted`
    : `${site} is not trusted`;
  currentSiteTrustCopy.textContent = isTrusted
    ? "Trusted sites skip the navigation trust prompt and allow Browser API surfaces that are set to Allow on trusted sites."
    : "Trust this site if you want it to skip the navigation trust prompt and use Allow on trusted sites Browser API actions.";
  currentSiteTrustBtn.textContent = isTrusted ? "Remove trust for this site" : "Trust this site";
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
    captureEnabled: storedCaptureEnabled,
  } = await chrome.storage.local.get([
    "privacyMode",
    "stats",
    "promptOnNewSites",
    "trustedSitesEnabled",
    "captureEnabled",
  ]);

  captureEnabled = storedCaptureEnabled !== false;
  modeSel.value = privacyMode || "moderate";
  firstEl.textContent = String(stats?.firstParty || 0);
  thirdEl.textContent = String(stats?.thirdParty || 0);
  promptOnNewSitesChk.checked = promptOnNewSites !== false;
  trustedSitesEnabledChk.checked = trustedSitesEnabled !== false;
  syncCaptureUi();
  renderApiPolicySummary({});

  await Promise.all([
    updateCookieCount(),
    refreshCurrentSiteTrust(),
    refreshApiPolicySummary(),
  ]);

  setStatus(captureEnabled
    ? "Ready. Capture and protection are active."
    : "Capture is paused. Protection and trust rules still run.", captureEnabled ? "" : "warn");
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

if (clearCookiesBtn) {
  clearCookiesBtn.addEventListener("click", async () => {
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
      clearCookiesBtn.textContent = "Clear site cookies";
    }
  });
}

if (currentSiteTrustBtn) {
  currentSiteTrustBtn.addEventListener("click", async () => {
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
      };
      trustedSitesEnabledChk.checked = res.enabled !== false;
      setCurrentSiteTrustUi(currentSiteTrustState);
      setStatus(
        nextTrusted
          ? `${currentSiteTrustState.site} is now trusted.`
          : `${currentSiteTrustState.site} is no longer trusted.`,
        "success"
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
}

if (openSiteInsightsBtn) {
  openSiteInsightsBtn.addEventListener("click", async () => {
    if (!currentSiteTrustState.supported || !currentSiteTrustState.site) return;
    await openControlCentreUrl(`${CONTROL_CENTRE_URL}site.html?site=${encodeURIComponent(currentSiteTrustState.site)}`);
  });
}

if (openTrustedSitesBtn) {
  openTrustedSitesBtn.addEventListener("click", async () => {
    await openControlCentreUrl(TRUSTED_SITES_MANAGER_URL);
  });
}

if (openApiControlsBtn) {
  openApiControlsBtn.addEventListener("click", async () => {
    await openControlCentreUrl(API_CONTROLS_URL);
  });
}

if (cookieSnapshotBtn) {
  cookieSnapshotBtn.addEventListener("click", async () => {
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
}

chrome.runtime.onMessage.addListener((msg) => {
  if (msg?.type === "stats") {
    firstEl.textContent = String(msg.firstParty || 0);
    thirdEl.textContent = String(msg.thirdParty || 0);
  }
});

load();
