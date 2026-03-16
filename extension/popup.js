const modeSel = document.getElementById("mode");
const statusEl = document.getElementById("status");
const firstEl = document.getElementById("first");
const thirdEl = document.getElementById("third");
const notifyChk = document.getElementById("notify");
const cookieCountEl = document.getElementById("cookieCount");
const cookieSnapshotBtn = document.getElementById("cookieSnapshotBtn"); 
const clearCookiesBtn = document.getElementById("clearCookiesBtn");

const toggleTrustedBtn = document.getElementById("toggleTrustedBtn");
const toggleTrustedStatus = document.getElementById("toggleTrustedStatus");
const currentSiteTrustBtn = document.getElementById("currentSiteTrustBtn");
const currentSiteTrustSite = document.getElementById("currentSiteTrustSite");
const currentSiteTrustStatus = document.getElementById("currentSiteTrustStatus");
const openTrustedSitesBtn = document.getElementById("openTrustedSitesBtn");

const TRUSTED_SITES_MANAGER_URL = "http://127.0.0.1:4141/?view=trusted-sites";

let currentSiteTrustState = {
  supported: false,
  site: "",
  isTrusted: false,
  enabled: true,
};

function setToggleTrustedUi({ enabled, trustedCount }) {
  if (!toggleTrustedBtn) return;
  const count = Number(trustedCount) || 0;
  toggleTrustedBtn.textContent = enabled ? "Disable trusted sites" : "Enable trusted sites";
  if (toggleTrustedStatus) {
    toggleTrustedStatus.textContent = enabled
      ? `Trusted sites are active. Stored sites: ${count}.`
      : `Trusted sites are paused. Stored sites kept: ${count}.`;
  }
}

function setCurrentSiteTrustUi(state = {}) {
  if (!currentSiteTrustBtn || !currentSiteTrustSite || !currentSiteTrustStatus) return;

  const site = String(state.site || "");
  const supported = state.supported !== false;
  const loading = !!state.loading;
  const isTrusted = !!state.isTrusted;
  const enabled = state.enabled !== false;

  if (loading) {
    currentSiteTrustSite.textContent = "Checking current site...";
    currentSiteTrustStatus.textContent = "Reading trust state for the active tab.";
    currentSiteTrustBtn.textContent = "Checking...";
    currentSiteTrustBtn.disabled = true;
    return;
  }

  if (!supported || !site) {
    currentSiteTrustSite.textContent = "No trust action on this page";
    currentSiteTrustStatus.textContent = "Current-site trust is available only on normal http or https pages.";
    currentSiteTrustBtn.textContent = "Trust current site";
    currentSiteTrustBtn.disabled = true;
    return;
  }

  currentSiteTrustSite.textContent = site;
  currentSiteTrustBtn.textContent = isTrusted ? "Untrust current site" : "Trust current site";
  currentSiteTrustBtn.disabled = !!state.busy;

  const statusParts = [
    isTrusted
      ? `${site} is currently trusted.`
      : `${site} is not currently trusted.`,
    enabled
      ? "Trusted-site behavior is active."
      : "Trusted-site behavior is currently paused by the global toggle.",
    "Use the Control Centre to review the full trusted-sites list.",
  ];
  currentSiteTrustStatus.textContent = statusParts.join(" ");
}

async function getCurrentTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || null;
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
  } catch (e) {
    console.error("Failed to load current-site trust state", e);
    currentSiteTrustState = {
      supported: false,
      site: "",
      isTrusted: false,
      enabled: true,
    };
    currentSiteTrustSite.textContent = "Current site unavailable";
    currentSiteTrustStatus.textContent = "Could not read trust state for the active tab.";
    currentSiteTrustBtn.textContent = "Trust current site";
    currentSiteTrustBtn.disabled = true;
  }
}

async function updateCookieCount() {
  if (!cookieCountEl) return;

  try {
    const url = await getCurrentTabUrl();
    // Ignore chrome://, about: etc.
    if (!url || !/^https?:/i.test(url)) {
      cookieCountEl.textContent = "n/a";
      return;
    }

    cookieCountEl.textContent = "…";

    const res = await chrome.runtime.sendMessage({
      type: "cookies:getSummary",
      url
    });

    if (!res || !res.ok) {
      cookieCountEl.textContent = "error";
      return;
    }

    cookieCountEl.textContent = String(res.count);
  } catch (e) {
    console.error("Failed to get cookie summary", e);
    cookieCountEl.textContent = "error";
  }
} 

async function load() {
  const { privacyMode, stats, notifyEnabled, trusted = [], trustedSitesEnabled } = await chrome.storage.local.get([
    "privacyMode",
    "stats",
    "notifyEnabled",
    "trusted",
    "trustedSitesEnabled",
  ]);
  modeSel.value = privacyMode || "moderate";
  firstEl.textContent = stats?.firstParty || 0;
  thirdEl.textContent = stats?.thirdParty || 0;
  notifyChk.checked = !!notifyEnabled;
  statusEl.textContent = `Current: ${modeSel.value}`;
  setToggleTrustedUi({
    enabled: trustedSitesEnabled !== false,
    trustedCount: Array.isArray(trusted) ? trusted.length : 0,
  });

  await Promise.all([
    updateCookieCount(),
    refreshCurrentSiteTrust(),
  ]);
}

modeSel.addEventListener("change", async () => {
  await chrome.storage.local.set({ privacyMode: modeSel.value });
  statusEl.textContent = `Saved: ${modeSel.value}`;
});

// clear cookies for the current site
if (clearCookiesBtn) {
  clearCookiesBtn.addEventListener("click", async () => {
    try {
      const url = await getCurrentTabUrl();
      if (!url || !/^https?:/i.test(url)) {
        statusEl.textContent = "Can only clear cookies on websites.";
        return;
      }

      const originalLabel = clearCookiesBtn.textContent;
      clearCookiesBtn.disabled = true;
      clearCookiesBtn.textContent = "Clearing…";

      const res = await chrome.runtime.sendMessage({
        type: "cookies:clearForSite",
        url
      });

      if (!res || !res.ok) {
        statusEl.textContent = "Failed to clear cookies.";
      } else {
        const n = res.cleared ?? 0;
        if (n === 0) {
          statusEl.textContent = "No cookies to clear.";
        } else {
          statusEl.textContent = `Cleared ${n} cookie${n === 1 ? "" : "s"}.`;
        }
        // refresh the count in the popup
        await updateCookieCount();
      }

      setTimeout(() => {
        clearCookiesBtn.disabled = false;
        clearCookiesBtn.textContent = originalLabel;
      }, 1500);
    } catch (e) {
      console.error("Failed to clear cookies", e);
      statusEl.textContent = "Error clearing cookies.";
      clearCookiesBtn.disabled = false;
      clearCookiesBtn.textContent = "Clear cookies for this site";
    }
  });
}

notifyChk.addEventListener("change", async () => {
  await chrome.storage.local.set({ notifyEnabled: notifyChk.checked });
});

if (toggleTrustedBtn) {
  toggleTrustedBtn.addEventListener("click", async () => {
    try {
      const { trusted = [], trustedSitesEnabled } = await chrome.storage.local.get([
        "trusted",
        "trustedSitesEnabled",
      ]);
      const nextEnabled = trustedSitesEnabled === false;
      toggleTrustedBtn.disabled = true;
      toggleTrustedBtn.textContent = nextEnabled ? "Enabling..." : "Disabling...";
      await chrome.storage.local.set({ trustedSitesEnabled: nextEnabled });
      setToggleTrustedUi({
        enabled: nextEnabled,
        trustedCount: Array.isArray(trusted) ? trusted.length : 0,
      });
      currentSiteTrustState.enabled = nextEnabled;
      setCurrentSiteTrustUi(currentSiteTrustState);
    } catch (e) {
      console.error("Failed to toggle trusted sites", e);
      if (toggleTrustedStatus) {
        toggleTrustedStatus.textContent = "Error updating trusted sites toggle.";
      }
    } finally {
      toggleTrustedBtn.disabled = false;
    }
  });
}

if (currentSiteTrustBtn) {
  currentSiteTrustBtn.addEventListener("click", async () => {
    if (!currentSiteTrustState.supported || !currentSiteTrustState.site) return;

    const nextTrusted = !currentSiteTrustState.isTrusted;
    currentSiteTrustBtn.disabled = true;
    currentSiteTrustBtn.textContent = nextTrusted ? "Trusting..." : "Removing...";

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
      setToggleTrustedUi({
        enabled: res.enabled !== false,
        trustedCount: Number(res.trustedCount) || 0,
      });
      setCurrentSiteTrustUi(currentSiteTrustState);
      statusEl.textContent = nextTrusted
        ? `${currentSiteTrustState.site} is now trusted.`
        : `${currentSiteTrustState.site} is no longer trusted.`;
    } catch (e) {
      console.error("Failed to update current-site trust", e);
      statusEl.textContent = e?.message || "Error updating current-site trust.";
      setCurrentSiteTrustUi({
        ...currentSiteTrustState,
        busy: false,
      });
    } finally {
      await refreshCurrentSiteTrust();
    }
  });
}

if (openTrustedSitesBtn) {
  openTrustedSitesBtn.addEventListener("click", async () => {
    await chrome.tabs.create({ url: TRUSTED_SITES_MANAGER_URL });
  });
}

// send a cookie snapshot to the Control Centre
if (cookieSnapshotBtn) {
  cookieSnapshotBtn.addEventListener("click", async () => {
    try {
      const url = await getCurrentTabUrl();
      // only for http/https pages
      if (!url || !/^https?:/i.test(url)) {
        const original = cookieSnapshotBtn.textContent;
        cookieSnapshotBtn.textContent = "Not available on this page";
        cookieSnapshotBtn.disabled = true;
        setTimeout(() => {
          cookieSnapshotBtn.disabled = false;
          cookieSnapshotBtn.textContent = original;
        }, 2000);
        return;
      }

      const originalText = cookieSnapshotBtn.textContent;
      cookieSnapshotBtn.disabled = true;
      cookieSnapshotBtn.textContent = "Sending cookie snapshot…";

      const res = await chrome.runtime.sendMessage({
        type: "cookies:sendSnapshot",
        url
      });

      if (!res || !res.ok) {
        console.error("Cookie snapshot failed:", res && res.error);
        cookieSnapshotBtn.textContent = "Snapshot failed";
      } else {
        cookieSnapshotBtn.textContent = `Snapshot sent (${res.count || 0} cookies)`;
      }

      setTimeout(() => {
        cookieSnapshotBtn.disabled = false;
        cookieSnapshotBtn.textContent = originalText;
      }, 2000);
    } catch (e) {
      console.error("Failed to send cookie snapshot", e);
      const originalText = cookieSnapshotBtn.textContent;
      cookieSnapshotBtn.textContent = "Snapshot error";
      setTimeout(() => {
        cookieSnapshotBtn.disabled = false;
        cookieSnapshotBtn.textContent = originalText;
      }, 2000);
    }
  });
}

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "stats") {
    firstEl.textContent = msg.firstParty;
    thirdEl.textContent = msg.thirdParty;
  }
});

load();

