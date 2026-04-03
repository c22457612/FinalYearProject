(() => {
  if (window.__vptFloatingStatusStripInstalled) return;
  window.__vptFloatingStatusStripInstalled = true;

  const DEFAULT_THEME_ID = "midnight";
  const THEME_IDS = new Set(["midnight", "amber", "oxblood", "daybreak"]);
  const STORAGE_KEY_THEME = "vptActiveThemeId";
  const STORAGE_KEY_ENABLED = "floatingStatusStripEnabled";
  const STORAGE_KEY_POSITION = "floatingStatusStripPosition";
  const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);
  const DEFAULT_MARGIN = 22;
  const DEFAULT_WIDTH = 204;
  const DEFAULT_HEIGHT = 84;
  const REFRESH_DEBOUNCE_MS = 500;
  const FONT_STACK = '"IBM Plex Sans", "Segoe UI", system-ui, -apple-system, BlinkMacSystemFont, sans-serif';
  const FONT_REGULAR_URL = chrome.runtime.getURL("fonts/ibm-plex-sans/IBMPlexSans-Regular.woff2");
  const FONT_MEDIUM_URL = chrome.runtime.getURL("fonts/ibm-plex-sans/IBMPlexSans-Medium.woff2");
  const FONT_SEMIBOLD_URL = chrome.runtime.getURL("fonts/ibm-plex-sans/IBMPlexSans-SemiBold.woff2");
  const THEME_TOKENS = Object.freeze({
    midnight: Object.freeze({
      surface: "rgba(8, 11, 15, 0.985)",
      surfaceHover: "rgba(12, 16, 21, 0.992)",
      surfaceActive: "rgba(18, 24, 31, 0.995)",
      border: "rgba(75, 88, 107, 0.72)",
      borderHover: "rgba(164, 201, 255, 0.30)",
      divider: "rgba(120, 130, 144, 0.24)",
      textPrimary: "#edf3f8",
      textSecondary: "#d6dee9",
      textMuted: "#8c98a7",
      accentRail: "rgba(164, 201, 255, 0.96)",
      accentBorder: "rgba(164, 201, 255, 0.42)",
      shadow: "rgba(0, 0, 0, 0.20)",
    }),
    amber: Object.freeze({
      surface: "rgba(8, 9, 10, 0.985)",
      surfaceHover: "rgba(14, 15, 17, 0.992)",
      surfaceActive: "rgba(22, 24, 27, 0.995)",
      border: "rgba(89, 97, 107, 0.72)",
      borderHover: "rgba(255, 158, 52, 0.34)",
      divider: "rgba(123, 130, 139, 0.25)",
      textPrimary: "#f6f0e8",
      textSecondary: "#e3d9ca",
      textMuted: "#a99581",
      accentRail: "rgba(255, 158, 52, 0.98)",
      accentBorder: "rgba(255, 158, 52, 0.48)",
      shadow: "rgba(0, 0, 0, 0.20)",
    }),
    oxblood: Object.freeze({
      surface: "rgba(8, 9, 11, 0.985)",
      surfaceHover: "rgba(13, 14, 17, 0.992)",
      surfaceActive: "rgba(20, 22, 27, 0.995)",
      border: "rgba(89, 97, 106, 0.72)",
      borderHover: "rgba(255, 103, 84, 0.34)",
      divider: "rgba(123, 130, 139, 0.25)",
      textPrimary: "#f5eef0",
      textSecondary: "#e4d7dc",
      textMuted: "#aa949b",
      accentRail: "rgba(255, 103, 84, 0.98)",
      accentBorder: "rgba(255, 103, 84, 0.50)",
      shadow: "rgba(0, 0, 0, 0.20)",
    }),
    daybreak: Object.freeze({
      surface: "rgba(255, 255, 255, 0.985)",
      surfaceHover: "rgba(243, 247, 251, 0.995)",
      surfaceActive: "rgba(238, 244, 251, 0.998)",
      border: "rgba(96, 119, 145, 0.62)",
      borderHover: "rgba(31, 95, 169, 0.36)",
      divider: "rgba(66, 85, 110, 0.22)",
      textPrimary: "#09111b",
      textSecondary: "#1d3045",
      textMuted: "#4a617a",
      accentRail: "rgba(13, 67, 123, 0.98)",
      accentBorder: "rgba(31, 95, 169, 0.62)",
      shadow: "rgba(26, 44, 66, 0.12)",
    }),
  });

  let hostEl = null;
  let stripEl = null;
  let observedValueEl = null;
  let blockedValueEl = null;
  let apiValueEl = null;
  let refreshTimerId = 0;
  let currentPosition = null;
  let lastRenderedSignature = "";
  let dragState = null;
  let currentEnabled = false;
  let currentThemeId = DEFAULT_THEME_ID;

  function isContextInvalidatedError(error) {
    const message = String(error?.message || error || "");
    return message.toLowerCase().includes("extension context invalidated");
  }

  function handleInvalidatedContext() {
    currentEnabled = false;
    dragState = null;
    lastRenderedSignature = "";
    if (refreshTimerId) {
      window.clearTimeout(refreshTimerId);
      refreshTimerId = 0;
    }
    unmount();
  }

  async function safeStorageGet(keys) {
    try {
      return await chrome.storage.local.get(keys);
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        handleInvalidatedContext();
        return null;
      }
      throw error;
    }
  }

  async function safeStorageSet(payload) {
    try {
      await chrome.storage.local.set(payload);
      return true;
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        handleInvalidatedContext();
        return false;
      }
      throw error;
    }
  }

  async function safeSendMessage(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch (error) {
      if (isContextInvalidatedError(error)) {
        handleInvalidatedContext();
        return null;
      }
      throw error;
    }
  }

  function normalizeThemeId(themeId) {
    const candidate = String(themeId || "").trim().toLowerCase();
    return THEME_IDS.has(candidate) ? candidate : DEFAULT_THEME_ID;
  }

  function getThemeTokens() {
    return THEME_TOKENS[currentThemeId] || THEME_TOKENS[DEFAULT_THEME_ID];
  }

  function isSupportedPageContext() {
    if (window.top !== window) return false;

    const protocol = String(window.location.protocol || "").toLowerCase();
    if (protocol !== "http:" && protocol !== "https:") return false;

    const host = String(window.location.hostname || "").toLowerCase();
    if (LOOPBACK_HOSTS.has(host)) return false;

    const pathname = String(window.location.pathname || "").toLowerCase();
    if (pathname.endsWith(".pdf")) return false;

    const contentType = String(document.contentType || "").toLowerCase();
    if (contentType.includes("pdf")) return false;

    return true;
  }

  function normalizePosition(value) {
    if (!value || typeof value !== "object") return null;
    const left = Number(value.left);
    const top = Number(value.top);
    if (!Number.isFinite(left) || !Number.isFinite(top)) return null;
    return { left, top };
  }

  function getHostSize() {
    if (!hostEl) {
      return { width: DEFAULT_WIDTH, height: DEFAULT_HEIGHT };
    }
    const rect = hostEl.getBoundingClientRect();
    return {
      width: Math.max(DEFAULT_WIDTH, Math.ceil(rect.width) || DEFAULT_WIDTH),
      height: Math.max(DEFAULT_HEIGHT, Math.ceil(rect.height) || DEFAULT_HEIGHT),
    };
  }

  function getDefaultPosition() {
    const { width, height } = getHostSize();
    return {
      left: Math.max(DEFAULT_MARGIN, window.innerWidth - width - DEFAULT_MARGIN),
      top: Math.max(DEFAULT_MARGIN, Math.min(DEFAULT_MARGIN, window.innerHeight - height - DEFAULT_MARGIN)),
    };
  }

  function clampPosition(value) {
    const next = normalizePosition(value) || getDefaultPosition();
    const { width, height } = getHostSize();
    const maxLeft = Math.max(DEFAULT_MARGIN, window.innerWidth - width - DEFAULT_MARGIN);
    const maxTop = Math.max(DEFAULT_MARGIN, window.innerHeight - height - DEFAULT_MARGIN);
    return {
      left: Math.min(Math.max(DEFAULT_MARGIN, Math.round(next.left)), Math.round(maxLeft)),
      top: Math.min(Math.max(DEFAULT_MARGIN, Math.round(next.top)), Math.round(maxTop)),
    };
  }

  function applyPosition(value) {
    if (!hostEl) return;
    currentPosition = clampPosition(value);
    hostEl.style.left = `${currentPosition.left}px`;
    hostEl.style.top = `${currentPosition.top}px`;
  }

  function buildShadowMarkup() {
    const theme = getThemeTokens();
    return `
      <style>
        :host {
          all: initial;
        }

        @font-face {
          font-family: "IBM Plex Sans";
          src: url("${FONT_REGULAR_URL}") format("woff2");
          font-style: normal;
          font-weight: 400;
          font-display: swap;
        }

        @font-face {
          font-family: "IBM Plex Sans";
          src: url("${FONT_MEDIUM_URL}") format("woff2");
          font-style: normal;
          font-weight: 500;
          font-display: swap;
        }

        @font-face {
          font-family: "IBM Plex Sans";
          src: url("${FONT_SEMIBOLD_URL}") format("woff2");
          font-style: normal;
          font-weight: 600;
          font-display: swap;
        }

        .strip {
          position: relative;
          width: ${DEFAULT_WIDTH}px;
          box-sizing: border-box;
          border: 1px solid ${theme.border};
          border-radius: 9px;
          background: ${theme.surface};
          color: ${theme.textPrimary};
          box-shadow: 0 8px 18px ${theme.shadow};
          font: 12px/1.28 ${FONT_STACK};
          letter-spacing: 0.01em;
          user-select: none;
          cursor: grab;
          overflow: hidden;
          transition: background-color 120ms ease, border-color 120ms ease, box-shadow 120ms ease;
        }

        .strip:active {
          cursor: grabbing;
        }

        .strip::before {
          content: "";
          position: absolute;
          top: 0;
          left: 0;
          bottom: 0;
          width: 2px;
          background: ${theme.accentRail};
        }

        .strip:hover {
          border-color: ${theme.borderHover};
          background: ${theme.surfaceHover};
        }

        .strip[data-dragging="true"] {
          border-color: ${theme.accentBorder};
          background: ${theme.surfaceActive};
          box-shadow: 0 10px 22px ${theme.shadow};
        }

        .row {
          display: grid;
          grid-template-columns: 60px minmax(0, 1fr);
          gap: 8px;
          align-items: center;
          padding: 7px 11px 7px 12px;
          border-top: 1px solid ${theme.divider};
        }

        .row:first-of-type {
          border-top: 0;
        }

        .label {
          color: ${theme.textMuted};
          font-size: 10px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.10em;
        }

        .value {
          min-width: 0;
          color: ${theme.textPrimary};
          font-weight: 600;
          text-align: right;
          white-space: nowrap;
          overflow: hidden;
          text-overflow: ellipsis;
        }

        .row[data-row="api"] .value {
          color: ${theme.textSecondary};
          font-weight: 500;
          font-size: 12px;
        }
      </style>
      <div class="strip" part="strip">
        <div class="row" data-row="observed">
          <span class="label">Observed</span>
          <span class="value" data-field="observed">0</span>
        </div>
        <div class="row" data-row="blocked">
          <span class="label">Blocked</span>
          <span class="value" data-field="blocked">0</span>
        </div>
        <div class="row" data-row="api">
          <span class="label">API</span>
          <span class="value" data-field="api">None</span>
        </div>
      </div>
    `;
  }

  function onPointerDown(event) {
    if (!stripEl) return;
    if (event.button !== 0 && event.pointerType !== "touch") return;

    const rect = hostEl.getBoundingClientRect();
    dragState = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    };
    stripEl.setPointerCapture(event.pointerId);
    stripEl.dataset.dragging = "true";
    event.preventDefault();
  }

  function onPointerMove(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    applyPosition({
      left: event.clientX - dragState.offsetX,
      top: event.clientY - dragState.offsetY,
    });
    event.preventDefault();
  }

  async function finishDrag(event) {
    if (!dragState || event.pointerId !== dragState.pointerId) return;
    try {
      stripEl?.releasePointerCapture?.(event.pointerId);
    } catch (_error) {
      // Ignore pointer-capture release failures.
    }
    if (stripEl) {
      delete stripEl.dataset.dragging;
    }
    dragState = null;
    if (currentPosition) {
      await safeStorageSet({ [STORAGE_KEY_POSITION]: currentPosition });
    }
  }

  function applyTheme(themeId) {
    currentThemeId = normalizeThemeId(themeId);
    if (!hostEl) return;

    const shadowRoot = hostEl.shadowRoot;
    if (!shadowRoot) return;

    shadowRoot.innerHTML = buildShadowMarkup();
    stripEl = shadowRoot.querySelector(".strip");
    observedValueEl = shadowRoot.querySelector('[data-field="observed"]');
    blockedValueEl = shadowRoot.querySelector('[data-field="blocked"]');
    apiValueEl = shadowRoot.querySelector('[data-field="api"]');

    stripEl?.addEventListener("pointerdown", onPointerDown);
    stripEl?.addEventListener("pointermove", onPointerMove);
    stripEl?.addEventListener("pointerup", finishDrag);
    stripEl?.addEventListener("pointercancel", finishDrag);

    if (lastRenderedSignature) {
      try {
        const parsed = JSON.parse(lastRenderedSignature);
        if (observedValueEl) observedValueEl.textContent = String(parsed.observedCount || 0);
        if (blockedValueEl) blockedValueEl.textContent = String(parsed.blockedCount || 0);
        if (apiValueEl) apiValueEl.textContent = String(parsed.apiDisplay || "None");
      } catch (_error) {
        // Ignore signature parse failures and keep the default text.
      }
    }
    applyPosition(currentPosition || getDefaultPosition());
  }

  async function refreshTheme() {
    try {
      const stored = await safeStorageGet(STORAGE_KEY_THEME);
      if (!stored) return;
      applyTheme(stored?.[STORAGE_KEY_THEME] || DEFAULT_THEME_ID);
    } catch (_error) {
      applyTheme(DEFAULT_THEME_ID);
    }
  }

  function ensureMounted() {
    if (hostEl) return;

    hostEl = document.createElement("div");
    hostEl.id = "vpt-floating-status-strip-host";
    hostEl.style.position = "fixed";
    hostEl.style.zIndex = "2147483646";
    hostEl.style.pointerEvents = "auto";
    hostEl.style.boxSizing = "border-box";
    hostEl.style.contain = "layout style";

    const shadowRoot = hostEl.attachShadow({ mode: "open" });
    shadowRoot.innerHTML = buildShadowMarkup();

    stripEl = shadowRoot.querySelector(".strip");
    observedValueEl = shadowRoot.querySelector('[data-field="observed"]');
    blockedValueEl = shadowRoot.querySelector('[data-field="blocked"]');
    apiValueEl = shadowRoot.querySelector('[data-field="api"]');

    stripEl?.addEventListener("pointerdown", onPointerDown);
    stripEl?.addEventListener("pointermove", onPointerMove);
    stripEl?.addEventListener("pointerup", finishDrag);
    stripEl?.addEventListener("pointercancel", finishDrag);

    (document.documentElement || document.body || document).appendChild(hostEl);
    applyPosition(currentPosition || getDefaultPosition());
  }

  function unmount() {
    if (!hostEl) return;
    hostEl.remove();
    hostEl = null;
    stripEl = null;
    observedValueEl = null;
    blockedValueEl = null;
    apiValueEl = null;
    dragState = null;
  }

  function renderSummary(summary) {
    if (!summary || !summary.supported || !summary.enabled) {
      currentEnabled = !!summary?.enabled;
      lastRenderedSignature = "";
      unmount();
      return;
    }

    currentEnabled = true;
    const signature = JSON.stringify({
      site: summary.site || "",
      observedCount: Number(summary.observedCount) || 0,
      blockedCount: Number(summary.blockedCount) || 0,
      apiDisplay: String(summary.apiDisplay || "None"),
    });

    ensureMounted();
    if (signature === lastRenderedSignature) {
      applyPosition(currentPosition || getDefaultPosition());
      return;
    }

    lastRenderedSignature = signature;
    if (observedValueEl) observedValueEl.textContent = String(summary.observedCount || 0);
    if (blockedValueEl) blockedValueEl.textContent = String(summary.blockedCount || 0);
    if (apiValueEl) apiValueEl.textContent = String(summary.apiDisplay || "None");
    applyPosition(currentPosition || getDefaultPosition());
  }

  async function fetchAndRenderSummary() {
    if (!isSupportedPageContext()) {
      currentEnabled = false;
      lastRenderedSignature = "";
      unmount();
      return;
    }

    try {
      const response = await safeSendMessage({
        type: "floatingStatusStrip:getCurrentSiteSummary",
        url: window.location.href,
      });
      if (!response) return;
      if (!response || response.ok === false) {
        throw new Error(response?.error || "floating_status_strip_unavailable");
      }
      renderSummary(response);
    } catch (_error) {
      lastRenderedSignature = "";
      unmount();
    }
  }

  function scheduleRefresh(delay = REFRESH_DEBOUNCE_MS) {
    window.clearTimeout(refreshTimerId);
    refreshTimerId = window.setTimeout(() => {
      refreshTimerId = 0;
      fetchAndRenderSummary().catch(() => {});
    }, Math.max(0, delay));
  }

  function onResize() {
    if (!hostEl) return;
    applyPosition(currentPosition || getDefaultPosition());
  }

  function applyStoredPosition(value) {
    currentPosition = normalizePosition(value);
    if (hostEl) {
      applyPosition(currentPosition || getDefaultPosition());
    }
  }

  async function loadStoredPosition() {
    try {
      const stored = await safeStorageGet(STORAGE_KEY_POSITION);
      if (!stored) return;
      applyStoredPosition(stored?.[STORAGE_KEY_POSITION]);
    } catch (_error) {
      applyStoredPosition(null);
    }
  }

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;

    if (STORAGE_KEY_POSITION in changes) {
      applyStoredPosition(changes[STORAGE_KEY_POSITION].newValue);
    }

    if (STORAGE_KEY_THEME in changes) {
      applyTheme(changes[STORAGE_KEY_THEME].newValue || DEFAULT_THEME_ID);
    }

    if (STORAGE_KEY_ENABLED in changes) {
      scheduleRefresh(0);
      return;
    }

    if ("events" in changes && currentEnabled) {
      scheduleRefresh();
    }
  });

  window.addEventListener("resize", onResize);
  window.addEventListener("pageshow", () => scheduleRefresh(0));

  loadStoredPosition().catch(() => {});
  refreshTheme().catch(() => {});
  scheduleRefresh(0);
})();
