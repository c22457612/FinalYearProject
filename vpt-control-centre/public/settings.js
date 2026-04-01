const SETTINGS_STATUS_POLL_MS = 5000;

function setConnectionStatus(state, text) {
  const statusEl = document.getElementById("connectionStatusShell");
  if (!statusEl) return;

  statusEl.textContent = text;
  statusEl.dataset.status = state;
  statusEl.title = text;
  statusEl.setAttribute("aria-label", text);
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
  });

  window.addEventListener("vpt:themechange", (event) => {
    const nextThemeId = event?.detail?.themeId || themeApi.getTheme();
    syncThemeSelectorState(nextThemeId);
  });
}

window.addEventListener("load", () => {
  window.VPT?.shell?.initShell?.({
    currentSection: "settings",
    persistKey: "vpt.control-centre.shell.collapsed",
  });

  renderThemeSelector();
  bindThemeSelector();
  refreshConnectionStatus();
  window.setInterval(refreshConnectionStatus, SETTINGS_STATUS_POLL_MS);
});
