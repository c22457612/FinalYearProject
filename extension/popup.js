const modeSel = document.getElementById("mode");
const statusEl = document.getElementById("status");

async function load() {
  const { privacyMode } = await chrome.storage.local.get(["privacyMode"]);
  modeSel.value = privacyMode || "moderate";
  statusEl.textContent = `Current: ${modeSel.value}`;
}

modeSel.addEventListener("change", async () => {
  await chrome.storage.local.set({ privacyMode: modeSel.value });
  statusEl.textContent = `Saved: ${modeSel.value}`;
});

load();
