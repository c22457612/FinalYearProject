const FILTERS = [
  "google-analytics.com",
  "doubleclick.net",
  "googletagmanager.com",
  "googleapis.com",
  "facebook.com/tr",
  "matomo.org"
];

//State
const BACKEND_URL = "http://127.0.0.1:4141";

let lastPolicyTs = 0;
let customFilters = []; // extra domains to block via policies

let currentMode = "moderate";
let blockedFirst = 0;
let blockedThird = 0;
let notifyEnabled = false;
const lastNotifyByDomain = new Map(); // throttle toasts
let promptOnNewSites = true;   // default ON 
let trustedDomains = [];       // base domains user trusts
let trustedSitesEnabled = true;
let backendTrustedDomains = new Set();
let enterOnce = null; // { siteBase, ts }

let previewReq = null;             // { siteBase, dest, ts }
let previewActive = null;          // { siteBase, tabId, timerId }
const previewObserved = new Map(); // reqBase -> { blocked: boolean, allowed: boolean }
const locationCache = {};          // tabId -> last main-frame URL

let lastCommandId = 0;


// ---- Privacy event logger ----
async function logEvent(kind, data = {}, tabId = null) {
  try {
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

    const result = await chrome.storage.local.get("events");
    const events = Array.isArray(result.events) ? result.events : [];
    events.push(event);

    const MAX = 500;
    if (events.length > MAX) {
      events.splice(0, events.length - MAX);
    }

    await chrome.storage.local.set({ events });
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

function buildTrustedSiteState(site) {
  const normalizedSite = String(site || "");
  return {
    ok: true,
    supported: !!normalizedSite,
    site: normalizedSite,
    isTrusted: !!normalizedSite && trustedDomains.includes(normalizedSite),
    enabled: trustedSitesEnabled,
    trustedCount: trustedDomains.length,
  };
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


function maybeNotify(host) {
  if (!notifyEnabled) return;
  const now = Date.now();
  const last = lastNotifyByDomain.get(host) || 0;
  if (now - last < 60_000) return; // 1 min per-domain
  const id = `block-${host}-${now}`;
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Tracker blocked",
    message: `${host} (${currentMode})`
  }, () => setTimeout(() => chrome.notifications.clear(id), 3000));
  lastNotifyByDomain.set(host, now);
}

async function loadTrustAndPromptFlag() {
  const { trusted = [], promptOnNewSites: flag, trustedSitesEnabled: trustedFlag } = await chrome.storage.local.get([
    "trusted",
    "promptOnNewSites",
    "trustedSitesEnabled"
  ]);
  trustedDomains = Array.isArray(trusted) ? trusted : [];
  // default to true unless explicitly false
  promptOnNewSites = flag !== false;
  trustedSitesEnabled = trustedFlag !== false;
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
  if (surfaceKey !== "canvas" && surfaceKey !== "webrtc" && surfaceKey !== "geolocation") {
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
      const { trusted = [] } = await chrome.storage.local.get("trusted");
      const set = new Set(trusted);
      set.add(site);
      await chrome.storage.local.set({ trusted: [...set] });
      break;
    }

    case "untrust_site": {
      const site = payload.site;
      if (!site) break;
      const { trusted = [] } = await chrome.storage.local.get("trusted");
      const set = new Set(trusted);
      set.delete(site);
      await chrome.storage.local.set({ trusted: [...set] });
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

  const missing = trustedDomains.filter((site) => site && !backendTrustedDomains.has(site));
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

    await syncLocalTrustedSitesToBackend();
  } catch (e) {
    // backend may not be running; ignore
  }
}

function startPreview(siteBase, tabId) {
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
  await loadTrustAndPromptFlag();
  await loadCustomFilters(); 
  await loadApiGatePolicy();
  await pollPolicies();
  setInterval(pollPolicies, 10000); // poll every 10s
  const { privacyMode, notifyEnabled: storedNotify } = await chrome.storage.local.get([
    "privacyMode",
    "notifyEnabled"
  ]);
  notifyEnabled = !!storedNotify;
  await applyRules(privacyMode || "moderate");
}


chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.storage.onChanged.addListener(async ch => {
  if ("privacyMode" in ch) await applyRules(ch.privacyMode.newValue);
  if ("notifyEnabled" in ch) notifyEnabled = !!ch.notifyEnabled.newValue;

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

        const created = await postPolicies({
          op: shouldTrust ? "trust_site" : "untrust_site",
          payload: { site },
        });
        await applyCreatedPolicies(created);
        sendResponse(buildTrustedSiteState(site));
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
  maybeNotify(host);

  // Work out the top-level site base from the initiator, if we can
  const topHost = hostFromOrigin(info.request.initiator || "");
  const siteBase = base(topHost);

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
  rec.allowed = true;
  previewObserved.set(reqBase, rec);

  // log a network.observed event (attempted request during preview)
  logEvent("network.observed", {
    url: details.url,
    domain: reqBase,
    resourceType: details.type, // may be undefined in some cases, that's okay
    isThirdParty: true,
    siteBase
  }, details.tabId).catch(() => {});
}, { urls: ["<all_urls>"] });

