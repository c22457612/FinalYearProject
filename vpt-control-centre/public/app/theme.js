const THEME_STORAGE_KEY = "vpt.control-centre.theme";
const DEFAULT_THEME_ID = "midnight";
const THEME_SYNC_ENDPOINT = "/api/ui/theme";
const THEMES = Object.freeze([
  {
    id: "midnight",
    label: "Midnight",
    description: "Black console base with restrained steel-blue structure.",
    preview: {
      page: "#020304",
      panel: "#0f1216",
      raised: "#15191f",
      accent: "#83afe8",
      warning: "#f1c87f",
    },
  },
  {
    id: "amber",
    label: "Amber",
    description: "Black graphite surfaces with bright orange structure.",
    preview: {
      page: "#010101",
      panel: "#111315",
      raised: "#171a1d",
      accent: "#ff8a1c",
      warning: "#ffb24f",
    },
  },
  {
    id: "oxblood",
    label: "Oxblood",
    description: "Black graphite surfaces with bright red accents.",
    preview: {
      page: "#010101",
      panel: "#101214",
      raised: "#17191d",
      accent: "#ff4735",
      warning: "#ff7c68",
    },
  },
  {
    id: "daybreak",
    label: "Daybreak",
    description: "White-card technical light theme with crisp blue-gray structure.",
    preview: {
      page: "#f6f9fc",
      panel: "#ffffff",
      raised: "#f9fbfd",
      accent: "#1f5fa9",
      warning: "#6b420b",
    },
  },
]);

const THEME_IDS = new Set(THEMES.map((theme) => theme.id));
let lastSyncedThemeId = "";
let pendingThemeSyncId = "";

function normalizeThemeId(themeId) {
  const candidate = String(themeId || "").trim().toLowerCase();
  return THEME_IDS.has(candidate) ? candidate : DEFAULT_THEME_ID;
}

function readStoredTheme() {
  try {
    return normalizeThemeId(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch (_err) {
    return DEFAULT_THEME_ID;
  }
}

function persistTheme(themeId) {
  try {
    window.localStorage.setItem(THEME_STORAGE_KEY, normalizeThemeId(themeId));
  } catch (_err) {
    // Ignore storage failures and keep the active theme for the current page load.
  }
}

function syncThemeToBackend(themeId) {
  const nextTheme = normalizeThemeId(themeId);
  if (lastSyncedThemeId === nextTheme || pendingThemeSyncId === nextTheme) {
    return;
  }

  pendingThemeSyncId = nextTheme;
  fetch(THEME_SYNC_ENDPOINT, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ themeId: nextTheme }),
    keepalive: true,
  })
    .then((response) => {
      if (!response.ok) {
        throw new Error(`theme_sync_http_${response.status}`);
      }
      lastSyncedThemeId = nextTheme;
    })
    .catch(() => {
      // Ignore backend sync failures and keep local theme state.
    })
    .finally(() => {
      if (pendingThemeSyncId === nextTheme) {
        pendingThemeSyncId = "";
      }
    });
}

function applyTheme(themeId) {
  const nextTheme = normalizeThemeId(themeId);
  document.documentElement.dataset.theme = nextTheme;
  if (!document.documentElement.style.colorScheme) {
    document.documentElement.style.colorScheme = nextTheme === "daybreak" ? "light" : "dark";
  }
  document.documentElement.style.colorScheme = nextTheme === "daybreak" ? "light" : "dark";
  syncThemeToBackend(nextTheme);
  return nextTheme;
}

function setTheme(themeId, options = {}) {
  const nextTheme = applyTheme(themeId);
  if (options.persist !== false) {
    persistTheme(nextTheme);
  }
  window.dispatchEvent(new CustomEvent("vpt:themechange", { detail: { themeId: nextTheme } }));
  return nextTheme;
}

function getTheme() {
  return normalizeThemeId(document.documentElement.dataset.theme || readStoredTheme());
}

function getThemes() {
  return THEMES.slice();
}

function readCssVar(name, fallback = "") {
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function getChartTokens() {
  return {
    emptyText: readCssVar("--chart-empty-text", readCssVar("--text-faint", "#94a3b8")),
    axisLine: readCssVar("--chart-axis-line", readCssVar("--border-strong", "#94a3b8")),
    axisLabel: readCssVar("--chart-axis-label", readCssVar("--text-secondary", "#cbd5e1")),
    axisName: readCssVar("--chart-axis-name", readCssVar("--text-primary", "#e2e8f0")),
    legendText: readCssVar("--chart-legend-text", readCssVar("--text-primary", "#e2e8f0")),
    toolboxBorder: readCssVar("--chart-toolbox-border", readCssVar("--text-secondary", "#cbd5e1")),
    toolboxFill: readCssVar("--chart-toolbox-fill", "rgba(148, 163, 184, 0.16)"),
    toolboxFillHover: readCssVar("--chart-toolbox-fill-hover", readCssVar("--accent-soft-fill", "rgba(56, 189, 248, 0.18)")),
    selectedAccent: readCssVar("--chart-selected-accent", readCssVar("--accent-strong", "#a78bfa")),
    hoverAccent: readCssVar("--chart-hover-accent", readCssVar("--accent", "#38bdf8")),
    selectedBandFill: readCssVar("--chart-selected-band-fill", "rgba(167, 139, 250, 0.14)"),
    hoverBandFill: readCssVar("--chart-hover-band-fill", "rgba(56, 189, 248, 0.10)"),
    seriesBlocked: readCssVar("--chart-series-blocked", "#5470c6"),
    seriesObserved: readCssVar("--chart-series-observed", "#91cc75"),
    seriesBlockedApi: readCssVar("--chart-series-blocked-api", "#9a60b4"),
    seriesObservedApi: readCssVar("--chart-series-observed-api", "#ea7ccc"),
    seriesOther: readCssVar("--chart-series-other", "#fac858"),
  };
}

const themeApi = {
  storageKey: THEME_STORAGE_KEY,
  defaultThemeId: DEFAULT_THEME_ID,
  getTheme,
  getThemes,
  setTheme,
  applyTheme,
  readStoredTheme,
  normalizeThemeId,
  getChartTokens,
};

window.VPT = window.VPT || {};
window.VPT.theme = themeApi;

applyTheme(readStoredTheme());

export {
  THEME_STORAGE_KEY,
  DEFAULT_THEME_ID,
  getTheme,
  getThemes,
  setTheme,
  applyTheme,
  readStoredTheme,
  normalizeThemeId,
  getChartTokens,
};
