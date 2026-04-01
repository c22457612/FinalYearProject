(() => {
  const THEME_STORAGE_KEY = "vpt.popup.theme";
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
    return nextTheme;
  }

  try {
    applyTheme(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch (_error) {
    applyTheme(DEFAULT_THEME_ID);
  }
})();
