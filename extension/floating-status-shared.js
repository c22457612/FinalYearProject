(function initVptFloatingStatusShared(globalScope) {
  const API = {};

  const SURFACE_ORDER = Object.freeze(["canvas", "clipboard", "geolocation", "webrtc"]);
  const SURFACE_LABELS = Object.freeze({
    canvas: "Canvas",
    clipboard: "Clipboard",
    geolocation: "Geolocation",
    webrtc: "WebRTC",
  });
  const OBSERVED_API_OUTCOMES = new Set(["observed", "warned", "trusted_allowed"]);
  const OBSERVED_API_MITIGATIONS = new Set(["observed_only", "allowed"]);
  const API_SEPARATOR = " \u00b7 ";

  function asSafeString(value) {
    return typeof value === "string" ? value.trim().toLowerCase() : "";
  }

  function toBaseDomain(host) {
    const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
    if (!parts.length) return "";
    if (parts.length <= 2) return parts.join(".");
    return parts.slice(-2).join(".");
  }

  function normalizeSiteBase(input) {
    if (!input) return "";
    const value = String(input).trim();
    if (!value) return "";

    try {
      const url = new URL(value);
      return toBaseDomain(url.hostname);
    } catch (_error) {
      const rawHost = value
        .replace(/^[a-z]+:\/\//i, "")
        .split("/")[0]
        .split("?")[0]
        .split("#")[0]
        .replace(/:\d+$/, "")
        .replace(/^\.+/, "");
      return toBaseDomain(rawHost);
    }
  }

  function getEventSiteBase(event) {
    if (!event || typeof event !== "object") return "";
    const data = event.data && typeof event.data === "object" ? event.data : {};
    return (
      normalizeSiteBase(event.site)
      || normalizeSiteBase(data.siteBase)
      || normalizeSiteBase(event.topLevelUrl)
    );
  }

  function isApiSurfaceEvent(event) {
    const kind = asSafeString(event?.kind);
    if (kind.startsWith("api.") || kind.startsWith("browser_api.")) return true;
    return !!getApiSurfaceKey(event);
  }

  function getApiSurfaceKey(event) {
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    const explicit = asSafeString(data.surfaceDetail);
    if (SURFACE_ORDER.includes(explicit)) return explicit;

    const kind = asSafeString(event?.kind);
    if (kind.startsWith("api.canvas.") || kind === "api.canvas") return "canvas";
    if (kind.startsWith("api.clipboard.") || kind === "api.clipboard") return "clipboard";
    if (kind.startsWith("api.geolocation.") || kind === "api.geolocation") return "geolocation";
    if (kind.startsWith("api.webrtc.") || kind === "api.webrtc") return "webrtc";
    return "";
  }

  function getApiDisposition(event) {
    if (!isApiSurfaceEvent(event)) return "";
    const data = event?.data && typeof event.data === "object" ? event.data : {};
    const gateOutcome = asSafeString(data.gateOutcome);
    const mitigationStatus = asSafeString(
      data.mitigationStatus
      || event?.enrichment?.mitigationStatus
    );

    if (gateOutcome === "blocked" || mitigationStatus === "blocked") return "blocked";
    if (OBSERVED_API_OUTCOMES.has(gateOutcome) || OBSERVED_API_MITIGATIONS.has(mitigationStatus)) {
      return "observed";
    }
    return "";
  }

  function formatApiSurfaceDisplay(surfaceKeys) {
    const ordered = SURFACE_ORDER.filter((key) => Array.isArray(surfaceKeys) && surfaceKeys.includes(key));
    if (!ordered.length) return "None";
    if (ordered.length <= 3) {
      return ordered.map((key) => SURFACE_LABELS[key] || key).join(API_SEPARATOR);
    }
    const overflow = ordered.length - 2;
    return [
      SURFACE_LABELS[ordered[0]] || ordered[0],
      SURFACE_LABELS[ordered[1]] || ordered[1],
      `+${overflow}`,
    ].join(API_SEPARATOR);
  }

  function buildFloatingStatusSummary({ events = [], siteBase = "" } = {}) {
    const normalizedSiteBase = normalizeSiteBase(siteBase);
    const surfaceSet = new Set();
    let observedCount = 0;
    let blockedCount = 0;

    const list = Array.isArray(events) ? events : [];
    for (const event of list) {
      if (getEventSiteBase(event) !== normalizedSiteBase) continue;

      const kind = asSafeString(event?.kind);
      if (kind === "network.observed") {
        observedCount += 1;
        continue;
      }
      if (kind === "network.blocked") {
        blockedCount += 1;
        continue;
      }
      if (!isApiSurfaceEvent(event)) {
        continue;
      }

      const surfaceKey = getApiSurfaceKey(event);
      if (surfaceKey) {
        surfaceSet.add(surfaceKey);
      }

      const disposition = getApiDisposition(event);
      if (disposition === "blocked") blockedCount += 1;
      else if (disposition === "observed") observedCount += 1;
    }

    const apiSurfaces = SURFACE_ORDER.filter((key) => surfaceSet.has(key));
    return {
      siteBase: normalizedSiteBase,
      observedCount,
      blockedCount,
      apiSurfaces,
      apiDisplay: formatApiSurfaceDisplay(apiSurfaces),
    };
  }

  API.SURFACE_ORDER = SURFACE_ORDER;
  API.SURFACE_LABELS = SURFACE_LABELS;
  API.normalizeSiteBase = normalizeSiteBase;
  API.getEventSiteBase = getEventSiteBase;
  API.isApiSurfaceEvent = isApiSurfaceEvent;
  API.getApiSurfaceKey = getApiSurfaceKey;
  API.getApiDisposition = getApiDisposition;
  API.formatApiSurfaceDisplay = formatApiSurfaceDisplay;
  API.buildFloatingStatusSummary = buildFloatingStatusSummary;

  globalScope.__VPTFloatingStatusShared = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
