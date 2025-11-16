const modeSel = document.getElementById("mode");
const statusEl = document.getElementById("status");
const firstEl = document.getElementById("first");
const thirdEl = document.getElementById("third");
const notifyChk = document.getElementById("notify");

// debug clear-trusted controls
const clearTrustedBtn = document.getElementById("clearTrustedBtn");
const clearTrustedStatus = document.getElementById("clearTrustedStatus");

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

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "stats") {
    firstEl.textContent = msg.firstParty;
    thirdEl.textContent = msg.thirdParty;
  }
});

load();
