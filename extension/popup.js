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

async function getCurrentTabUrl() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab?.url || null;
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

  updateCookieCount();
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

