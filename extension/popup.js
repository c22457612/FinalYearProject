const modeSel = document.getElementById("mode");
const statusEl = document.getElementById("status");
const firstEl = document.getElementById("first");
const thirdEl = document.getElementById("third");
const notifyChk = document.getElementById("notify");

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

chrome.runtime.onMessage.addListener(msg => {
  if (msg?.type === "stats") {
    firstEl.textContent = msg.firstParty;
    thirdEl.textContent = msg.thirdParty;
  }
});

load();
