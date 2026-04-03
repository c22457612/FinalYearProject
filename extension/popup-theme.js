(() => {
  const THEME_STORAGE_KEY = "vpt.popup.theme";
  const SHARED_THEME_STORAGE_KEY = "vptActiveThemeId";
  const DEFAULT_THEME_ID = "midnight";
  const THEME_IDS = new Set(["midnight", "amber", "oxblood", "daybreak"]);

  function normalizeThemeId(themeId) {
    const candidate = String(themeId || "").trim().toLowerCase();
    return THEME_IDS.has(candidate) ? candidate : DEFAULT_THEME_ID;
  }

  function applyTheme(themeId) {
    const nextTheme = normalizeThemeId(themeId);
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme === "daybreak" ? "light" : "dark";
    try {
      chrome.storage.local.set({ [SHARED_THEME_STORAGE_KEY]: nextTheme }).catch(() => {});
    } catch (_error) {
      // Ignore storage failures and keep the current session theme.
    }
    return nextTheme;
  }

  try {
    applyTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch (_error) {
    applyTheme(DEFAULT_THEME_ID);
  }
})();
