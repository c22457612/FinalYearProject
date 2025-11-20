const modeSel = document.getElementById("mode");
const statusEl = document.getElementById("status");
const firstEl = document.getElementById("first");
const thirdEl = document.getElementById("third");
const notifyChk = document.getElementById("notify");
const cookieCountEl = document.getElementById("cookieCount");
const cookieSnapshotBtn = document.getElementById("cookieSnapshotBtn"); 

// debug clear-trusted controls
const clearTrustedBtn = document.getElementById("clearTrustedBtn");
const clearTrustedStatus = document.getElementById("clearTrustedStatus");

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
  const { privacyMode, stats, notifyEnabled } = await chrome.storage.local.get([
    "privacyMode",
    "stats",
    "notifyEnabled"
  ]);
  modeSel.value = privacyMode || "moderate";
  firstEl.textContent = stats?.firstParty || 0;
  thirdEl.textContent = stats?.thirdParty || 0;
  notifyChk.checked = !!notifyEnabled;
  statusEl.textContent = `Current: ${modeSel.value}`;

  updateCookieCount();
}

modeSel.addEventListener("change", async () => {
  await chrome.storage.local.set({ privacyMode: modeSel.value });
  statusEl.textContent = `Saved: ${modeSel.value}`;
});

notifyChk.addEventListener("change", async () => {
  await chrome.storage.local.set({ notifyEnabled: notifyChk.checked });
});

// clear all trusted sites (debug button)
if (clearTrustedBtn) {
  clearTrustedBtn.addEventListener("click", async () => {
    try {
      await chrome.storage.local.set({ trusted: [] });
      if (clearTrustedStatus) {
        clearTrustedStatus.textContent = "All trusted sites cleared.";
        setTimeout(() => {
          clearTrustedStatus.textContent = "";
        }, 2000);
      }
    } catch (e) {
      console.error("Failed to clear trusted sites", e);
      if (clearTrustedStatus) {
        clearTrustedStatus.textContent = "Error clearing trusted sites.";
      }
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

