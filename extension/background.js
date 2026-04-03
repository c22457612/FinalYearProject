importScripts("floating-status-shared.js");

const FILTERS = [
  "google-analytics.com",
  "doubleclick.net",
  "googletagmanager.com",
  "googleapis.com",
  "facebook.com/tr",
  "matomo.org"
];

const BACKEND_URL = "http://127.0.0.1:4141";
const MAX_STORED_EVENTS = 500;
const API_EVENT_DEDUPE_WINDOW_MS = 1500;
const API_EVENT_DEDUPE_LIMIT = 250;
const API_NOTIFICATION_THROTTLE_MS = 45_000;
const floatingStatusShared = globalThis.__VPTFloatingStatusShared || null;

let lastPolicyTs = 0;
let customFilters = []; // extra domains to block via policies

let currentMode = "moderate";
let blockedFirst = 0;
let blockedThird = 0;
let promptOnNewSites = true;   // default ON 
let trustedDomains = [];       // base domains user trusts
let trustedSitesEnabled = true;
let captureEnabled = true;
let apiNotificationsEnabled = true;
let backendTrustedDomains = new Set();
let pendingTrustOps = {};
let enterOnce = null; // { siteBase, ts }

let previewReq = null;             // { siteBase, dest, ts }
let previewActive = null;          // { siteBase, tabId, timerId }
const previewObserved = new Map(); // reqBase -> { blocked: boolean, allowed: boolean }
const locationCache = {};          // tabId -> last main-frame URL
const recentApiEventKeys = new Map();
const lastApiNotificationByKey = new Map();

let lastCommandId = 0;


// ---- Privacy event logger ----
async function logEvent(kind, data = {}, tabId = null) {
  try {
    if (!captureEnabled) {
      return;
    }

    const ts = Date.now();

    let topLevelUrl = null;
    let site = null;

    // Use locationCache if we know this tab's top-level URL
    if (
      tabId !== null &&
      typeof tabId !== "undefined" &&
      typeof locationCache === "object" &&
      Object.prototype.hasOwnProperty.call(locationCache, tabId)
    ) {
      topLevelUrl = locationCache[tabId];
      try {
        const host = new URL(topLevelUrl).hostname;
        site = base(host); 
      } catch (e) {
        // ignore parse errors
      }
    }

    // Fallback: if caller passed a siteBase in data, use that
    if (!site && data.siteBase) {
      site = data.siteBase;
    }

    const event = {
      id: `evt-${ts}-${Math.random().toString(16).slice(2, 8)}`,
      ts,
      site: site || null,
      topLevelUrl: topLevelUrl || null,
      tabId,
      mode: currentMode || "moderate",
      source: "extension",
      kind,
      data
    };

    if (shouldSkipRecentApiEvent(event, ts)) {
      return;
    }

    const result = await chrome.storage.local.get("events");
    const events = Array.isArray(result.events) ? result.events : [];
    events.push(event);

    if (events.length > MAX_STORED_EVENTS) {
      events.splice(0, events.length - MAX_STORED_EVENTS);
    }

    await chrome.storage.local.set({ events });
    maybeNotifyApiDetection(event);
    // Fire-and-forget: send to local backend if it's running
    try {
      fetch(`${BACKEND_URL}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event)
      }).catch(() => {});
    } catch (e2) {
      // backend might not be running; ignore
    }
  } catch (e) {
    console.error("logEvent failed", kind, data, tabId, e);
  }
}


//Utils
function setBadge() {
  const total = blockedFirst + blockedThird;
  chrome.action.setBadgeText({ text: total ? String(Math.min(total, 999)) : "" });
}

function base(host) {
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}
function hostFromUrl(u) { try { return new URL(u).hostname; } catch { return ""; } }
function hostFromOrigin(o) { try { return new URL(o).hostname; } catch { return ""; } }
function siteBaseFromUrl(url) {
  if (!url || !/^https?:/i.test(url)) return "";
  return base(hostFromUrl(url));
}

function isLoopbackHost(host) {
  const normalizedHost = String(host || "").trim().toLowerCase();
  return normalizedHost === "127.0.0.1" || normalizedHost === "localhost";
}

function isFloatingStatusStripSupportedUrl(url) {
  if (!url || !/^https?:/i.test(url)) return false;
  try {
    const parsed = new URL(url);
    if (isLoopbackHost(parsed.hostname)) return false;
    if (String(parsed.pathname || "").toLowerCase().endsWith(".pdf")) return false;
    return true;
  } catch (_error) {
    return false;
  }
}

async function buildFloatingStatusStripState(url) {
  const { events, floatingStatusStripEnabled } = await chrome.storage.local.get([
    "events",
    "floatingStatusStripEnabled",
  ]);
  const enabled = floatingStatusStripEnabled === true;
  const supported = isFloatingStatusStripSupportedUrl(url);
  const site = siteBaseFromUrl(url);

  if (!supported || !site) {
    return {
      ok: true,
      enabled,
      supported: false,
      site: "",
      observedCount: 0,
      blockedCount: 0,
      apiSurfaces: [],
      apiDisplay: "None",
    };
  }

  const summary = floatingStatusShared?.buildFloatingStatusSummary
    ? floatingStatusShared.buildFloatingStatusSummary({
      events: Array.isArray(events) ? events : [],
      siteBase: site,
    })
    : {
      observedCount: 0,
      blockedCount: 0,
      apiSurfaces: [],
      apiDisplay: "None",
    };

  return {
    ok: true,
    enabled,
    supported: true,
    site,
    observedCount: Number(summary.observedCount) || 0,
    blockedCount: Number(summary.blockedCount) || 0,
    apiSurfaces: Array.isArray(summary.apiSurfaces) ? summary.apiSurfaces : [],
    apiDisplay: summary.apiDisplay || "None",
  };
}

function buildTrustedSiteState(site) {
  const normalizedSite = String(site || "");
  const pendingOp = normalizedSite ? pendingTrustOps[normalizedSite] : "";
  return {
    ok: true,
    supported: !!normalizedSite,
    site: normalizedSite,
    isTrusted: !!normalizedSite && trustedDomains.includes(normalizedSite),
    enabled: trustedSitesEnabled,
    trustedCount: trustedDomains.length,
    syncPending: pendingOp === "trust_site" || pendingOp === "untrust_site",
  };
}

function normalizeTrustPolicyOp(value) {
  return value === "untrust_site" ? "untrust_site" : "trust_site";
}

function getPendingTrustPolicyOp(site) {
  const normalizedSite = String(site || "");
  if (!normalizedSite) return "";
  const value = pendingTrustOps[normalizedSite];
  if (value !== "trust_site" && value !== "untrust_site") return "";
  return value;
}

async function persistPendingTrustOps() {
  await chrome.storage.local.set({ pendingTrustOps });
}

async function queuePendingTrustPolicyOp(site, op) {
  const normalizedSite = String(site || "");
  if (!normalizedSite) return;
  pendingTrustOps = {
    ...pendingTrustOps,
    [normalizedSite]: normalizeTrustPolicyOp(op),
  };
  await persistPendingTrustOps();
}

async function clearPendingTrustPolicyOp(site) {
  const normalizedSite = String(site || "");
  if (!normalizedSite || !Object.prototype.hasOwnProperty.call(pendingTrustOps, normalizedSite)) return;
  const next = { ...pendingTrustOps };
  delete next[normalizedSite];
  pendingTrustOps = next;
  await persistPendingTrustOps();
}

function shouldIgnoreBackendTrustPolicy(policy) {
  if (!policy || typeof policy !== "object") return false;
  const op = normalizeTrustPolicyOp(policy.op);
  const site = String(policy.payload?.site || "");
  if (!site) return false;
  const pendingOp = getPendingTrustPolicyOp(site);
  return !!pendingOp && pendingOp !== op;
}

function setTrustedDomainsInMemory(nextTrusted) {
  trustedDomains = Array.isArray(nextTrusted)
    ? nextTrusted.map((site) => String(site || "")).filter(Boolean)
    : [];
}

async function setLocalTrustState(site, shouldTrust) {
  const normalizedSite = String(site || "");
  if (!normalizedSite) return [];

  const set = new Set(trustedDomains);
  if (shouldTrust) {
    set.add(normalizedSite);
  } else {
    set.delete(normalizedSite);
  }

  const nextTrusted = [...set];
  setTrustedDomainsInMemory(nextTrusted);
  await chrome.storage.local.set({ trusted: nextTrusted });
  return nextTrusted;
}

function cleanupRecentApiEventKeys(now) {
  for (const [key, ts] of recentApiEventKeys.entries()) {
    if ((now - ts) > API_EVENT_DEDUPE_WINDOW_MS) {
      recentApiEventKeys.delete(key);
    }
  }

  if (recentApiEventKeys.size <= API_EVENT_DEDUPE_LIMIT) {
    return;
  }

  const overflow = recentApiEventKeys.size - API_EVENT_DEDUPE_LIMIT;
  let removed = 0;
  for (const key of recentApiEventKeys.keys()) {
    recentApiEventKeys.delete(key);
    removed += 1;
    if (removed >= overflow) break;
  }
}

function shouldSkipRecentApiEvent(event, now) {
  if (!event || typeof event !== "object") return false;
  if (!String(event.kind || "").startsWith("api.")) return false;

  cleanupRecentApiEventKeys(now);

  let fingerprint = "";
  try {
    fingerprint = JSON.stringify([
      event.kind,
      event.site || "",
      event.tabId ?? null,
      event.data || {},
    ]);
  } catch {
    return false;
  }

  const lastSeen = recentApiEventKeys.get(fingerprint) || 0;
  recentApiEventKeys.set(fingerprint, now);
  return (now - lastSeen) < API_EVENT_DEDUPE_WINDOW_MS;
}

function cleanupApiNotificationKeys(now) {
  for (const [key, ts] of lastApiNotificationByKey.entries()) {
    if ((now - ts) > API_NOTIFICATION_THROTTLE_MS) {
      lastApiNotificationByKey.delete(key);
    }
  }
}

function getApiSurfaceNotificationLabel(surfaceDetail) {
  const detail = String(surfaceDetail || "").toLowerCase();
  if (detail === "canvas") return "Canvas";
  if (detail === "clipboard") return "Clipboard";
  if (detail === "geolocation") return "Geolocation";
  if (detail === "webrtc") return "WebRTC";
  return "Browser API";
}

function getApiDetectionNotificationMessage(event) {
  const site = event.site || "this site";
  const surfaceLabel = getApiSurfaceNotificationLabel(event.data?.surfaceDetail);
  const gateOutcome = String(event.data?.gateOutcome || "observed");

  if (gateOutcome === "blocked") {
    return `${surfaceLabel} activity was blocked on ${site}.`;
  }
  if (gateOutcome === "warned") {
    return `${surfaceLabel} activity was allowed with a warning on ${site}.`;
  }
  if (gateOutcome === "trusted_allowed") {
    return `${surfaceLabel} activity was allowed on trusted site ${site}.`;
  }
  return `${surfaceLabel} activity was detected on ${site}.`;
}

function maybeNotifyApiDetection(event) {
  if (!apiNotificationsEnabled) return;
  if (!event || typeof event !== "object") return;
  if (!String(event.kind || "").startsWith("api.")) return;

  const now = Date.now();
  cleanupApiNotificationKeys(now);

  const key = [
    event.site || "",
    event.data?.surfaceDetail || "",
    event.data?.gateOutcome || "",
  ].join("|");
  const last = lastApiNotificationByKey.get(key) || 0;
  if ((now - last) < API_NOTIFICATION_THROTTLE_MS) return;

  lastApiNotificationByKey.set(key, now);
  const id = `api-detect-${now}-${Math.random().toString(16).slice(2, 8)}`;
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Visual Privacy Toolkit",
    message: getApiDetectionNotificationMessage(event),
  }, () => {
    setTimeout(() => chrome.notifications.clear(id), 5000);
  });
}

async function postPolicies(commands) {
  const items = Array.isArray(commands) ? commands.filter(Boolean) : [commands].filter(Boolean);
  if (!items.length) return [];

  const res = await fetch(`${BACKEND_URL}/api/policies`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(items),
  });

  if (!res.ok) {
    throw new Error(`Policy request failed (${res.status})`);
  }

  const created = await res.json();
  return Array.isArray(created) ? created : [created];
}

async function applyCreatedPolicies(created) {
  const items = Array.isArray(created) ? created : [created];
  for (const item of items) {
    replayBackendPolicyState(item);
    await applyPolicy(item);
    if (typeof item?.ts === "number" && item.ts > lastPolicyTs) {
      lastPolicyTs = item.ts;
    }
  }

  await loadTrustAndPromptFlag();
  await applyRules(currentMode);
}

async function getCookieSummaryForUrl(url) {
  if (!url || !/^https?:/i.test(url)) {
    return { count: 0, site: null };
  }
  const cookies = await chrome.cookies.getAll({ url });
  const host = hostFromUrl(url);
  const site = base(host);
  return { count: cookies.length, site };
}

async function buildCookieSnapshotForUrl(url) {
  if (!url || !/^https?:/i.test(url)) {
    return null;
  }

  const cookies = await chrome.cookies.getAll({ url });
  const host = hostFromUrl(url);
  const siteBase = base(host);

  const items = cookies.map(c => {
    const cookieHost = (c.domain || "").replace(/^\./, "");
    const cookieBase = base(cookieHost);
    const isThird = cookieBase && siteBase && cookieBase !== siteBase;

    return {
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite || null,
      session: c.session,
      expiry: c.expirationDate || null,
      hostOnly: c.hostOnly,
      isThirdParty: !!isThird
    };
  });

  const thirdPartyCount = items.filter(i => i.isThirdParty).length;

  return {
    url,
    siteBase,
    count: cookies.length,
    thirdPartyCount,
    cookies: items
  };
}

async function clearCookiesForUrl(url) {
  if (!url || !/^https?:/i.test(url)) {
    return { cleared: 0, total: 0 };
  }

  const cookies = await chrome.cookies.getAll({ url });
  const total = cookies.length;
  if (!total) {
    return { cleared: 0, total: 0 };
  }

  const { protocol } = new URL(url);
  let cleared = 0;

  for (const c of cookies) {
    try {
      const domain =
        c.domain && c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      const path = c.path || "/";
      const cookieUrl = `${protocol}//${domain}${path}`;
      await chrome.cookies.remove({ url: cookieUrl, name: c.name });
      cleared++;
    } catch (e) {
      console.warn("Failed to remove cookie", c, e);
    }
  }

  return { cleared, total };
}

function isThirdParty(initiator, requestUrl) {
  const a = base(hostFromOrigin(initiator));
  const b = base(hostFromUrl(requestUrl));
  if (!a || !b) return true; // default to third-party if unknown
  return a !== b;
}

const API_CANVAS_OPERATIONS = new Set(["getImageData", "toDataURL", "toBlob", "readPixels"]);
const API_CLIPBOARD_METHODS = new Set(["read", "readText", "write", "writeText"]);
const API_CLIPBOARD_ACCESS_TYPES = new Set(["read", "write"]);
const API_GEOLOCATION_METHODS = new Set(["getCurrentPosition", "watchPosition"]);
const API_GATE_ACTIONS = new Set(["observe", "warn", "block", "allow_trusted"]);
const API_GATE_OUTCOMES = new Set(["observed", "warned", "blocked", "trusted_allowed"]);
const API_WEBRTC_ACTIONS = new Set([
  "peer_connection_created",
  "create_offer_called",
  "offer_created",
  "set_local_description_offer",
  "ice_gathering_state",
  "ice_candidate_activity",
  "set_configuration",
]);
const API_CONTEXT_TYPES = new Set(["2d", "webgl", "webgl2", "bitmaprenderer", "webgpu", "unknown"]);
const API_MAX_HOSTNAMES = 8;
const API_MAX_COUNT = 5000;
const API_MAX_BURST_MS = 60_000;
const API_MAX_DIMENSION = 16_384;
const API_MAX_GEOLOCATION_OPTION_MS = 86_400_000;
const API_MAX_CLIPBOARD_ITEM_COUNT = 32;
const API_MAX_CLIPBOARD_MIME_TYPES = 16;

function asSafeInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  const next = Math.floor(n);
  if (next < min || next > max) return null;
  return next;
}

function asSafeString(value, maxLen = 80) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.slice(0, maxLen);
}

function normalizeApiGateAction(value) {
  const next = asSafeString(value, 32);
  return next && API_GATE_ACTIONS.has(next) ? next : "observe";
}

function sanitizeApiGatePolicy(policy) {
  const source = policy && typeof policy === "object" ? policy : {};
  return {
    canvas: normalizeApiGateAction(source.canvas),
    clipboard: normalizeApiGateAction(source.clipboard),
    webrtc: normalizeApiGateAction(source.webrtc),
    geolocation: normalizeApiGateAction(source.geolocation),
  };
}

function isIpv4(host) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
}

function isIpv6(host) {
  return host.includes(":") && /^[0-9a-f:.]+$/i.test(host);
}

function sanitizeHostname(raw) {
  const host = asSafeString(raw, 255);
  if (!host) return null;
  const normalized = host.toLowerCase();
  if (isIpv4(normalized) || isIpv6(normalized)) return null;
  if (!/^[a-z0-9.-]+$/.test(normalized)) return null;
  return normalized;
}

function sanitizeHostnames(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const host = sanitizeHostname(raw);
    if (!host || seen.has(host)) continue;
    seen.add(host);
    out.push(host);
    if (out.length >= API_MAX_HOSTNAMES) break;
  }
  return out;
}

function sanitizeMimeType(raw) {
  const value = asSafeString(raw, 96);
  if (!value) return null;
  const normalized = value.toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(normalized) ? normalized : null;
}

function sanitizeMimeTypes(values) {
  if (!Array.isArray(values)) return [];
  const out = [];
  const seen = new Set();
  for (const raw of values) {
    const value = sanitizeMimeType(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
    if (out.length >= API_MAX_CLIPBOARD_MIME_TYPES) break;
  }
  return out;
}

function getCanvasDefaults(operation, gateOutcome = "observed") {
  const op = String(operation || "");
  let confidence = 0.9;
  if (op === "readPixels") confidence = 0.97;
  else if (op === "getImageData") confidence = 0.95;
  else if (op === "toDataURL" || op === "toBlob") confidence = 0.94;

  let privacyStatus = "signal_detected";
  let mitigationStatus = "observed_only";
  if (gateOutcome === "blocked") {
    privacyStatus = "policy_blocked";
    mitigationStatus = "blocked";
  } else if (gateOutcome === "trusted_allowed") {
    privacyStatus = "policy_allowed";
    mitigationStatus = "allowed";
  }

  return {
    signalType: "fingerprinting_signal",
    privacyStatus,
    mitigationStatus,
    patternId: `api.canvas.${op || "operation"}`,
    confidence,
  };
}

function getClipboardDefaults(method, accessType, gateOutcome = "observed") {
  const nextMethod = String(method || "");
  const nextAccessType = String(accessType || "").toLowerCase() === "write" ? "write" : "read";
  let privacyStatus = nextAccessType === "read" ? "high_risk" : "signal_detected";
  let mitigationStatus = "observed_only";
  if (gateOutcome === "blocked") {
    privacyStatus = "policy_blocked";
    mitigationStatus = "blocked";
  } else if (gateOutcome === "trusted_allowed") {
    privacyStatus = "policy_allowed";
    mitigationStatus = "allowed";
  }

  if (nextMethod === "readText") {
    return {
      signalType: "tracking_signal",
      privacyStatus,
      mitigationStatus,
      patternId: "api.clipboard.async_read_text",
      confidence: 0.99,
    };
  }
  if (nextMethod === "read") {
    return {
      signalType: "tracking_signal",
      privacyStatus,
      mitigationStatus,
      patternId: "api.clipboard.async_read",
      confidence: 0.98,
    };
  }
  if (nextMethod === "writeText") {
    return {
      signalType: "state_change",
      privacyStatus,
      mitigationStatus,
      patternId: "api.clipboard.async_write_text",
      confidence: 0.94,
    };
  }
  return {
    signalType: "state_change",
    privacyStatus,
    mitigationStatus,
    patternId: "api.clipboard.async_write",
    confidence: 0.93,
  };
}

function getWebrtcDefaults(action, gateOutcome = "observed") {
  const nextAction = String(action || "");
  const deviceProbeActions = new Set([
    "create_offer_called",
    "offer_created",
    "set_local_description_offer",
    "ice_gathering_state",
    "ice_candidate_activity",
  ]);
  const signalType = deviceProbeActions.has(nextAction) ? "device_probe" : "capability_probe";
  const confidenceMap = {
    peer_connection_created: 0.84,
    create_offer_called: 0.9,
    offer_created: 0.93,
    set_local_description_offer: 0.95,
    ice_gathering_state: 0.9,
    ice_candidate_activity: 0.93,
    set_configuration: 0.86,
  };

  let privacyStatus = "signal_detected";
  let mitigationStatus = "observed_only";
  if (gateOutcome === "blocked") {
    privacyStatus = "policy_blocked";
    mitigationStatus = "blocked";
  } else if (gateOutcome === "trusted_allowed") {
    privacyStatus = "policy_allowed";
    mitigationStatus = "allowed";
  }

  return {
    signalType,
    privacyStatus,
    mitigationStatus,
    patternId: `api.webrtc.${nextAction || "action"}`,
    confidence: confidenceMap[nextAction] || 0.88,
  };
}

function getGeolocationDefaults(method, gateOutcome = "observed") {
  const nextMethod = String(method || "");
  let privacyStatus = "signal_detected";
  let mitigationStatus = "observed_only";
  if (gateOutcome === "blocked") {
    privacyStatus = "policy_blocked";
    mitigationStatus = "blocked";
  } else if (gateOutcome === "trusted_allowed") {
    privacyStatus = "policy_allowed";
    mitigationStatus = "allowed";
  }

  return {
    signalType: "tracking_signal",
    privacyStatus,
    mitigationStatus,
    patternId: nextMethod === "watchPosition"
      ? "api.geolocation.watch_request"
      : "api.geolocation.current_position_request",
    confidence: nextMethod === "watchPosition" ? 0.98 : 0.97,
  };
}

function sanitizeClipboardSignal(data) {
  if (!data || typeof data !== "object") return null;
  const method = asSafeString(data.method, 32);
  if (!method || !API_CLIPBOARD_METHODS.has(method)) return null;
  const gateOutcomeRaw = asSafeString(data.gateOutcome, 32);
  const gateOutcome = gateOutcomeRaw && API_GATE_OUTCOMES.has(gateOutcomeRaw)
    ? gateOutcomeRaw
    : "observed";
  const accessTypeRaw = asSafeString(data.accessType, 16);
  const accessType = accessTypeRaw && API_CLIPBOARD_ACCESS_TYPES.has(accessTypeRaw)
    ? accessTypeRaw
    : (method.startsWith("write") ? "write" : "read");

  return {
    surface: "api",
    surfaceDetail: "clipboard",
    method,
    accessType,
    itemCount: asSafeInt(data.itemCount, 0, API_MAX_CLIPBOARD_ITEM_COUNT),
    mimeTypes: sanitizeMimeTypes(data.mimeTypes),
    policyReady: data.policyReady !== false,
    count: asSafeInt(data.count, 1, API_MAX_COUNT) || 1,
    burstMs: asSafeInt(data.burstMs, 0, API_MAX_BURST_MS) || 0,
    sampleWindowMs: asSafeInt(data.sampleWindowMs, 100, API_MAX_BURST_MS) || 1200,
    gateOutcome,
    gateAction: normalizeApiGateAction(data.gateAction),
    trustedSite: typeof data.trustedSite === "boolean" ? data.trustedSite : undefined,
    frameScope: asSafeString(data.frameScope, 32) === "top_frame" ? "top_frame" : "top_frame",
    siteBase: asSafeString(data.siteBase, 128) || undefined,
    ...getClipboardDefaults(method, accessType, gateOutcome),
  };
}

function sanitizeCanvasSignal(data) {
  if (!data || typeof data !== "object") return null;
  const operation = asSafeString(data.operation, 32);
  if (!operation || !API_CANVAS_OPERATIONS.has(operation)) return null;
  const gateOutcomeRaw = asSafeString(data.gateOutcome, 32);
  const gateOutcome = gateOutcomeRaw && API_GATE_OUTCOMES.has(gateOutcomeRaw)
    ? gateOutcomeRaw
    : "observed";

  const contextTypeRaw = asSafeString(data.contextType, 32) || "unknown";
  const contextType = API_CONTEXT_TYPES.has(contextTypeRaw) ? contextTypeRaw : "unknown";

  return {
    surface: "api",
    surfaceDetail: "canvas",
    operation,
    contextType,
    width: asSafeInt(data.width, 1, API_MAX_DIMENSION),
    height: asSafeInt(data.height, 1, API_MAX_DIMENSION),
    count: asSafeInt(data.count, 1, API_MAX_COUNT) || 1,
    burstMs: asSafeInt(data.burstMs, 0, API_MAX_BURST_MS) || 0,
    sampleWindowMs: asSafeInt(data.sampleWindowMs, 100, API_MAX_BURST_MS) || 1200,
    gateOutcome,
    gateAction: normalizeApiGateAction(data.gateAction),
    trustedSite: typeof data.trustedSite === "boolean" ? data.trustedSite : undefined,
    frameScope: asSafeString(data.frameScope, 32) === "top_frame" ? "top_frame" : "top_frame",
    siteBase: asSafeString(data.siteBase, 128) || undefined,
    ...getCanvasDefaults(operation, gateOutcome),
  };
}

function sanitizeWebrtcSignal(data) {
  if (!data || typeof data !== "object") return null;
  const action = asSafeString(data.action, 48);
  if (!action || !API_WEBRTC_ACTIONS.has(action)) return null;
  const gateOutcomeRaw = asSafeString(data.gateOutcome, 32);
  const gateOutcome = gateOutcomeRaw && API_GATE_OUTCOMES.has(gateOutcomeRaw)
    ? gateOutcomeRaw
    : "observed";

  return {
    surface: "api",
    surfaceDetail: "webrtc",
    action,
    state: asSafeString(data.state, 48) || undefined,
    offerType: asSafeString(data.offerType, 24) || undefined,
    candidateType: asSafeString(data.candidateType, 24) || undefined,
    stunTurnHostnames: sanitizeHostnames(data.stunTurnHostnames),
    count: asSafeInt(data.count, 1, API_MAX_COUNT) || 1,
    burstMs: asSafeInt(data.burstMs, 0, API_MAX_BURST_MS) || 0,
    sampleWindowMs: asSafeInt(data.sampleWindowMs, 100, API_MAX_BURST_MS) || 1200,
    gateOutcome,
    gateAction: normalizeApiGateAction(data.gateAction),
    trustedSite: typeof data.trustedSite === "boolean" ? data.trustedSite : undefined,
    frameScope: asSafeString(data.frameScope, 32) === "top_frame" ? "top_frame" : "top_frame",
    siteBase: asSafeString(data.siteBase, 128) || undefined,
    ...getWebrtcDefaults(action, gateOutcome),
  };
}

function sanitizeGeolocationSignal(data) {
  if (!data || typeof data !== "object") return null;
  const method = asSafeString(data.method, 32);
  if (!method || !API_GEOLOCATION_METHODS.has(method)) return null;
  const gateOutcomeRaw = asSafeString(data.gateOutcome, 32);
  const gateOutcome = gateOutcomeRaw && API_GATE_OUTCOMES.has(gateOutcomeRaw)
    ? gateOutcomeRaw
    : "observed";

  return {
    surface: "api",
    surfaceDetail: "geolocation",
    method,
    requestedHighAccuracy: data.requestedHighAccuracy === true,
    timeoutMs: asSafeInt(data.timeoutMs, 0, API_MAX_GEOLOCATION_OPTION_MS),
    maximumAgeMs: asSafeInt(data.maximumAgeMs, 0, API_MAX_GEOLOCATION_OPTION_MS),
    hasSuccessCallback: data.hasSuccessCallback !== false,
    hasErrorCallback: data.hasErrorCallback === true,
    policyReady: data.policyReady !== false,
    count: asSafeInt(data.count, 1, API_MAX_COUNT) || 1,
    burstMs: asSafeInt(data.burstMs, 0, API_MAX_BURST_MS) || 0,
    sampleWindowMs: asSafeInt(data.sampleWindowMs, 100, API_MAX_BURST_MS) || 1200,
    gateOutcome,
    gateAction: normalizeApiGateAction(data.gateAction),
    trustedSite: typeof data.trustedSite === "boolean" ? data.trustedSite : undefined,
    frameScope: asSafeString(data.frameScope, 32) === "top_frame" ? "top_frame" : "top_frame",
    siteBase: asSafeString(data.siteBase, 128) || undefined,
    ...getGeolocationDefaults(method, gateOutcome),
  };
}

function sanitizeApiSignalPayload(payload) {
  if (!payload || typeof payload !== "object") return null;
  const kind = asSafeString(payload.kind, 64);
  const data = payload.data && typeof payload.data === "object" ? payload.data : null;
  if (!kind || !data) return null;

  if (kind.startsWith("api.canvas.")) {
    const cleanData = sanitizeCanvasSignal(data);
    if (!cleanData) return null;
    return { kind, data: cleanData };
  }

  if (kind.startsWith("api.clipboard.")) {
    const cleanData = sanitizeClipboardSignal(data);
    if (!cleanData) return null;
    return { kind, data: cleanData };
  }

  if (kind.startsWith("api.geolocation.")) {
    const cleanData = sanitizeGeolocationSignal(data);
    if (!cleanData) return null;
    return { kind, data: cleanData };
  }

  if (kind.startsWith("api.webrtc.")) {
    const cleanData = sanitizeWebrtcSignal(data);
    if (!cleanData) return null;
    return { kind, data: cleanData };
  }

  return null;
}


async function persistStats() {
  await chrome.storage.local.set({
    stats: { firstParty: blockedFirst, thirdParty: blockedThird }
  });
  chrome.runtime.sendMessage({
    type: "stats",
    firstParty: blockedFirst,
    thirdParty: blockedThird
  }).catch(() => {});
}

async function applyRules(mode = "moderate") {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map(r => r.id);

  const addRules = [];
  if (mode !== "low") {
    const allFilters = [...new Set([...FILTERS, ...customFilters])];
    const baseId = mode === "strict" ? 1000 : 2000;

    allFilters.forEach((f, i) => {
      addRules.push({
        id: baseId + i,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: f,
          resourceTypes: ["script", "xmlhttprequest", "image", "sub_frame"],
          ...(mode === "moderate" ? { domainType: "thirdParty" } : {}),
          excludedInitiatorDomains: trustedSitesEnabled ? trustedDomains : []
        }
      });
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  currentMode = mode;
  blockedFirst = 0;
  blockedThird = 0;
  await persistStats();
  setBadge();
}


async function loadTrustAndPromptFlag() {
  const { trusted = [], promptOnNewSites: flag, trustedSitesEnabled: trustedFlag } = await chrome.storage.local.get([
    "trusted",
    "promptOnNewSites",
    "trustedSitesEnabled"
  ]);
  setTrustedDomainsInMemory(trusted);
  // default to true unless explicitly false
  promptOnNewSites = flag !== false;
  trustedSitesEnabled = trustedFlag !== false;
}

async function loadExtensionFlags() {
  const {
    captureEnabled: storedCaptureEnabled,
    apiNotificationsEnabled: storedApiNotificationsEnabled,
    pendingTrustOps: storedPendingTrustOps,
  } = await chrome.storage.local.get([
    "captureEnabled",
    "apiNotificationsEnabled",
    "pendingTrustOps",
  ]);

  captureEnabled = storedCaptureEnabled !== false;
  apiNotificationsEnabled = storedApiNotificationsEnabled !== false;
  pendingTrustOps = storedPendingTrustOps && typeof storedPendingTrustOps === "object"
    ? storedPendingTrustOps
    : {};
}
// sibling helper to loadTrustAndPromptFlag()
async function loadCustomFilters() {
  const { customFilters: stored } = await chrome.storage.local.get("customFilters");
  customFilters = Array.isArray(stored) ? stored : [];
}

async function loadApiGatePolicy() {
  const { apiGatePolicy } = await chrome.storage.local.get("apiGatePolicy");
  await chrome.storage.local.set({ apiGatePolicy: sanitizeApiGatePolicy(apiGatePolicy) });
}

async function updateApiSurfacePolicy(surface, action) {
  const surfaceKey = asSafeString(surface, 32);
  if (surfaceKey !== "canvas" && surfaceKey !== "clipboard" && surfaceKey !== "webrtc" && surfaceKey !== "geolocation") {
    throw new Error("invalid_api_surface");
  }
  const nextAction = normalizeApiGateAction(action);
  const { apiGatePolicy } = await chrome.storage.local.get("apiGatePolicy");
  const nextPolicy = sanitizeApiGatePolicy(apiGatePolicy);
  nextPolicy[surfaceKey] = nextAction;
  await chrome.storage.local.set({ apiGatePolicy: nextPolicy });
  return nextPolicy;
}

async function getApiGateSnapshot({ refresh = false } = {}) {
  if (refresh) {
    await pollPolicies();
  }
  return chrome.storage.local.get(["trusted", "apiGatePolicy", "trustedSitesEnabled"]);
}

async function applyPolicy(policy) {
  if (!policy || typeof policy !== "object") return;
  const { op, payload = {} } = policy;

  switch (op) {
    case "trust_site": {
      const site = payload.site;
      if (!site) break;
      if (shouldIgnoreBackendTrustPolicy(policy)) {
        break;
      }
      await setLocalTrustState(site, true);
      break;
    }

    case "untrust_site": {
      const site = payload.site;
      if (!site) break;
      if (shouldIgnoreBackendTrustPolicy(policy)) {
        break;
      }
      await setLocalTrustState(site, false);
      break;
    }

    case "block_domain": {
      const domain = payload.domain;
      if (!domain) break;
      const { customFilters: stored = [] } = await chrome.storage.local.get("customFilters");
      const set = new Set(stored);
      set.add(domain);
      await chrome.storage.local.set({ customFilters: [...set] });
      break;
    }

    case "set_api_policy":
    case "set_api_surface_policy": {
      await updateApiSurfacePolicy(payload.surface, payload.action);
      break;
    }

    default:
      // unknown op, ignore for now
      break;
  }
}

function replayBackendPolicyState(policy) {
  if (!policy || typeof policy !== "object") return;
  const op = policy.op;
  const payload = policy.payload && typeof policy.payload === "object" ? policy.payload : {};
  const site = typeof payload.site === "string" ? payload.site : "";
  if (!site) return;

  if (op === "trust_site") {
    backendTrustedDomains.add(site);
  } else if (op === "untrust_site") {
    backendTrustedDomains.delete(site);
  }
}

async function syncLocalTrustedSitesToBackend() {
  if (!trustedDomains.length) return;

  const missing = trustedDomains.filter((site) => site && !backendTrustedDomains.has(site) && !getPendingTrustPolicyOp(site));
  if (!missing.length) return;

  try {
    const items = await postPolicies(missing.map((site) => ({
      op: "trust_site",
      payload: { site },
    })));
    for (const item of items) {
      replayBackendPolicyState(item);
      if (typeof item?.ts === "number" && item.ts > lastPolicyTs) {
        lastPolicyTs = item.ts;
      }
    }
  } catch {
    // backend may not be running yet; ignore and let later polls retry
  }
}

async function flushPendingTrustPolicyOps() {
  const queued = Object.entries(pendingTrustOps).filter(([site, op]) => site && (op === "trust_site" || op === "untrust_site"));
  if (!queued.length) return;

  try {
    const created = await postPolicies(queued.map(([site, op]) => ({
      op,
      payload: { site },
    })));
    for (const item of created) {
      replayBackendPolicyState(item);
      if (typeof item?.ts === "number" && item.ts > lastPolicyTs) {
        lastPolicyTs = item.ts;
      }
    }

    pendingTrustOps = {};
    await persistPendingTrustOps();
  } catch {
    // backend may not be running yet; keep the queue for the next poll
  }
}

async function pollPolicies() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/policies?since=${lastPolicyTs}`);
    if (!res.ok) return;
    const { latestTs, items } = await res.json();

    if (Array.isArray(items)) {
      for (const p of items) {
        replayBackendPolicyState(p);
        await applyPolicy(p);
      }
    }

    if (typeof latestTs === "number" && latestTs > lastPolicyTs) {
      lastPolicyTs = latestTs;
    }

    await flushPendingTrustPolicyOps();
    await syncLocalTrustedSitesToBackend();
  } catch (e) {
    // backend may not be running; ignore
  }
}

function startPreview(siteBase, tabId) {
  if (!captureEnabled) {
    previewReq = null;
    return;
  }

  // reset any prior preview
  if (previewActive?.timerId) clearTimeout(previewActive.timerId);
  previewObserved.clear();
  const timerId = setTimeout(() => endPreview(), 5000); // ~5s window
  previewActive = { siteBase, tabId, timerId };
}

async function endPreview() {
  if (!previewActive) return;
  const { siteBase, tabId, timerId } = previewActive;
  clearTimeout(timerId);
  previewActive = null;
  previewReq = null;

  // persist mini receipt
  const { receipts = {} } = await chrome.storage.local.get(["receipts"]);
  const prev = receipts[siteBase]?.domains || [];
  const merged = new Set(prev);
  for (const [d, flags] of previewObserved.entries()) {
    // Store with a simple marker e.g., "doubleclick.net (blocked)" if blocked at least once
    merged.add(flags.blocked ? `${d} (blocked)` : d);
  }
  receipts[siteBase] = { lastSeen: Date.now(), domains: [...merged] };
  await chrome.storage.local.set({ receipts, __preview: null });

  // Build a summary array from previewObserved
  const domainsSummary = [];
  for (const [d, flags] of previewObserved.entries()) {
    domainsSummary.push({
      domain: d,
      blocked: !!flags.blocked,
      seen: !!flags.allowed
    });
  }

  // Log a preview.summary event
  logEvent("preview.summary", {
    siteBase,
    domains: domainsSummary
  }, tabId).catch(() => {});


  // return to interstitial for this dest
  const dest = locationCache[tabId] || "";
  if (dest) {
    const url = `${chrome.runtime.getURL("interstitial.html")}?dest=${encodeURIComponent(dest)}`;
    try { chrome.tabs.update(tabId, { url }); } catch {}
  }
}



//Boot & reactions
async function init() {
  await loadExtensionFlags();
  await loadTrustAndPromptFlag();
  await loadCustomFilters(); 
  await loadApiGatePolicy();
  await pollPolicies();
  setInterval(pollPolicies, 10000); // poll every 10s
  const { privacyMode } = await chrome.storage.local.get([
    "privacyMode",
  ]);
  await applyRules(privacyMode || "moderate");
}


chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.storage.onChanged.addListener(async ch => {
  if ("privacyMode" in ch) await applyRules(ch.privacyMode.newValue);
  if ("captureEnabled" in ch) {
    captureEnabled = ch.captureEnabled.newValue !== false;
    if (!captureEnabled) {
      recentApiEventKeys.clear();
    }
  }
  if ("apiNotificationsEnabled" in ch) {
    apiNotificationsEnabled = ch.apiNotificationsEnabled.newValue !== false;
    if (!apiNotificationsEnabled) {
      lastApiNotificationByKey.clear();
    }
  }
  if ("pendingTrustOps" in ch) {
    pendingTrustOps = ch.pendingTrustOps.newValue && typeof ch.pendingTrustOps.newValue === "object"
      ? ch.pendingTrustOps.newValue
      : {};
  }

  // trust list or interstitial flag changed
  if ("trusted" in ch || "promptOnNewSites" in ch || "trustedSitesEnabled" in ch) {
    await loadTrustAndPromptFlag();
    await applyRules(currentMode);
    if ("trusted" in ch) {
      await syncLocalTrustedSitesToBackend();
    }
  }

  if ("__enterOnce" in ch && ch.__enterOnce?.newValue) {
    enterOnce = ch.__enterOnce.newValue;
  }

  if ("customFilters" in ch) {
    await loadCustomFilters();
    await applyRules(currentMode);
  }

  if ("__preview" in ch && ch.__preview?.newValue) {
    previewReq = ch.__preview.newValue; // { siteBase, dest, ts }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "floatingStatusStrip:getCurrentSiteSummary") {
    (async () => {
      try {
        const state = await buildFloatingStatusStripState(msg.url);
        sendResponse(state);
      } catch (e) {
        console.error("floatingStatusStrip:getCurrentSiteSummary failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === "api:gateStateSnapshot") {
    (async () => {
      try {
        const snapshot = await getApiGateSnapshot({ refresh: msg.refresh === true });
        sendResponse({ ok: true, snapshot });
      } catch (e) {
        console.error("api:gateStateSnapshot failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === "api:signal") {
    (async () => {
      try {
        const normalized = sanitizeApiSignalPayload(msg.payload);
        if (!normalized) {
          sendResponse({ ok: false, error: "invalid_api_signal" });
          return;
        }

        const tabId =
          sender.tab && typeof sender.tab.id === "number"
            ? sender.tab.id
            : null;

        await logEvent(normalized.kind, normalized.data, tabId);
        sendResponse({ ok: true });
      } catch (e) {
        console.error("api:signal failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === "api:gatePolicyUpdate") {
    (async () => {
      try {
        const payload = msg.payload && typeof msg.payload === "object" ? msg.payload : {};
        const apiGatePolicy = await updateApiSurfacePolicy(payload.surface, payload.action);
        sendResponse({ ok: true, apiGatePolicy });
      } catch (e) {
        console.error("api:gatePolicyUpdate failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true;
  }

  if (msg?.type === "cookies:getSummary") {
    (async () => {
      try {
        const { count, site } = await getCookieSummaryForUrl(msg.url);
        sendResponse({ ok: true, count, site });
      } catch (e) {
        console.error("cookies:getSummary failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // keep the message channel open for async sendResponse
  }
  if (msg?.type === "cookies:clearForSite") {
    (async () => {
      try {
        const result = await clearCookiesForUrl(msg.url);

        const host = hostFromUrl(msg.url || "");
        const siteBase = base(host);
        const tabId =
          sender.tab && typeof sender.tab.id === "number"
            ? sender.tab.id
            : null;

        await logEvent(
          "cookies.cleared",
          {
            url: msg.url,
            siteBase,
            cleared: result.cleared,
            total: result.total
          },
          tabId
        );

        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error("cookies:clearForSite failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();

    return true; // async sendResponse
  }

  if (msg?.type === "cookies:sendSnapshot") {
    (async () => {
      try {
        const snapshot = await buildCookieSnapshotForUrl(msg.url);
        if (!snapshot) {
          sendResponse({ ok: false, error: "Invalid URL" });
          return;
        }

        const tabId =
          sender.tab && typeof sender.tab.id === "number"
            ? sender.tab.id
            : null;

        await logEvent(
          "cookies.snapshot",
          {
            url: snapshot.url,
            siteBase: snapshot.siteBase,
            count: snapshot.count,
            thirdPartyCount: snapshot.thirdPartyCount,
            cookies: snapshot.cookies
          },
          tabId
        );

        sendResponse({ ok: true, count: snapshot.count });
      } catch (e) {
        console.error("cookies:sendSnapshot failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();

    return true; // keep the message channel open for async sendResponse
  }

  if (msg?.type === "trustedSites:getCurrentSiteState") {
    (async () => {
      try {
        const site = siteBaseFromUrl(msg.url);
        sendResponse(buildTrustedSiteState(site));
      } catch (e) {
        console.error("trustedSites:getCurrentSiteState failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();

    return true;
  }

  if (msg?.type === "trustedSites:setCurrentSiteTrust") {
    (async () => {
      try {
        const site = siteBaseFromUrl(msg.url);
        if (!site) {
          sendResponse({ ok: false, error: "Current-site trust is available only on normal websites." });
          return;
        }

        const shouldTrust = !!msg.trusted;
        const alreadyTrusted = trustedDomains.includes(site);
        if (shouldTrust === alreadyTrusted) {
          sendResponse(buildTrustedSiteState(site));
          return;
        }

        const nextOp = shouldTrust ? "trust_site" : "untrust_site";
        await setLocalTrustState(site, shouldTrust);
        await queuePendingTrustPolicyOp(site, nextOp);
        await applyRules(currentMode);

        try {
          const created = await postPolicies({
            op: nextOp,
            payload: { site },
          });
          for (const item of created) {
            replayBackendPolicyState(item);
            if (typeof item?.ts === "number" && item.ts > lastPolicyTs) {
              lastPolicyTs = item.ts;
            }
          }
          await clearPendingTrustPolicyOp(site);
          sendResponse({
            ...buildTrustedSiteState(site),
            synced: true,
          });
        } catch (syncError) {
          console.warn("trustedSites:setCurrentSiteTrust backend sync deferred", syncError);
          sendResponse({
            ...buildTrustedSiteState(site),
            synced: false,
            warning: "Saved locally. Will sync to the Control Centre when the backend is reachable.",
          });
        }
      } catch (e) {
        console.error("trustedSites:setCurrentSiteTrust failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();

    return true;
  }
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  try {
    if (details.frameId !== 0) return;

    const url = details.url || "";
    if (!/^https?:/i.test(url)) return;
    if (url.startsWith(chrome.runtime.getURL("interstitial.html"))) return;

    const siteBase = base(hostFromUrl(url));
    if (!siteBase) return;

    // cache last URL for this tab
    locationCache[details.tabId] = url;

    // one-time Enter bypass
    const now = Date.now();

    // one-time Enter bypass: allow this site to load once without interstitial
    if (enterOnce && enterOnce.siteBase === siteBase && (now - enterOnce.ts) < 15000) {
      enterOnce = null; // consume the bypass
      return;           // let this navigation proceed
    }

    // if interstitial set __preview for this site/dest, start preview now
    if (previewReq && previewReq.siteBase === siteBase && previewReq.dest === url) {
      startPreview(siteBase, details.tabId);   // use current mode
      return; // allow navigation to proceed
    }

    // interstitial redirect (unchanged)
    if (!promptOnNewSites) return;
    if (trustedSitesEnabled && trustedDomains.includes(siteBase)) return;

    const interstitial = `${chrome.runtime.getURL("interstitial.html")}?dest=${encodeURIComponent(url)}`;
    chrome.tabs.update(details.tabId, { url: interstitial });
  } catch {}
});

chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
  if (currentMode === "low") return; // low has no rules

  const third = isThirdParty(info.request.initiator, info.request.url);
  if (third) {
    blockedThird++;
  } else {
    blockedFirst++;
  }

  setBadge();
  persistStats();

  const host = hostFromUrl(info.request.url);

  // Work out the top-level site base from the initiator, if we can
  const topHost = hostFromOrigin(info.request.initiator || "");
  const siteBase = base(topHost);

  if (previewActive && info.tabId === previewActive.tabId) {
    const blockedBase = base(host);
    if (blockedBase && blockedBase !== previewActive.siteBase) {
      const rec = previewObserved.get(blockedBase) || { blocked: false, allowed: false };
      rec.blocked = true;
      previewObserved.set(blockedBase, rec);
    }
  }

  // Log a network.blocked event; logEvent will use siteBase as a fallback
  logEvent(
    "network.blocked",
    {
      url: info.request.url,
      domain: base(host),
      resourceType: info.request.resourceType,
      ruleId: info.rule.id,
      isThirdParty: third,
      siteBase // ✅ now defined
    },
    info.tabId
  ).catch(() => {});
});



chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!previewActive || details.tabId !== previewActive.tabId) return;

  const siteBase = previewActive.siteBase;
  const reqBase = base(hostFromUrl(details.url));
  if (!reqBase || reqBase === siteBase) return; // only care about 3rd-party

  const rec = previewObserved.get(reqBase) || { blocked: false, allowed: false };
  const firstObservedForDomain = !rec.allowed;
  rec.allowed = true;
  previewObserved.set(reqBase, rec);

  if (!firstObservedForDomain) {
    return;
  }

  // log a network.observed event (attempted request during preview)
  logEvent("network.observed", {
    url: details.url,
    domain: reqBase,
    resourceType: details.type, // may be undefined in some cases, that's okay
    isThirdParty: true,
    siteBase
  }, details.tabId).catch(() => {});
}, { urls: ["<all_urls>"] });

