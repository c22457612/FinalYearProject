const SETTINGS_STATUS_POLL_MS = 5000;

function setConnectionStatus(state, text) {
  const statusEl = document.getElementById("connectionStatusShell");
  if (!statusEl) return;

  statusEl.textContent = text;
  statusEl.dataset.status = state;
  statusEl.title = text;
  statusEl.setAttribute("aria-label", text);
  statusEl.style.color = state === "online" ? "#10b981" : state === "offline" ? "#f97316" : "";
}

async function refreshConnectionStatus() {
  try {
    const response = await fetch("/api/sites", { headers: { Accept: "application/json" } });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    setConnectionStatus("online", "Connected to local backend");
  } catch (_error) {
    setConnectionStatus("offline", "Backend unavailable - is server.js running?");
  }
}

window.addEventListener("load", () => {
  window.VPT?.shell?.initShell?.({
    currentSection: "settings",
    persistKey: "vpt.control-centre.shell.collapsed",
  });

  refreshConnectionStatus();
  window.setInterval(refreshConnectionStatus, SETTINGS_STATUS_POLL_MS);
});
