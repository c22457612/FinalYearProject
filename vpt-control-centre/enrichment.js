/**
 * Enrichment helpers for semantic classification of raw events.
 * Focused first on current event kinds: network.* and cookies.*.
 */

/** @typedef {{vendorId:string,vendorName:string,vendorFamily:string,domains:string[]}} VendorProfile */

/** @type {VendorProfile[]} */
const VENDOR_PROFILES = [
  {
    vendorId: "google",
    vendorName: "Google",
    vendorFamily: "adtech-analytics",
    domains: [
      "google-analytics.com",
      "googletagmanager.com",
      "doubleclick.net",
      "gstatic.com",
      "googleadservices.com",
      "googlesyndication.com",
      "google.com",
    ],
  },
  {
    vendorId: "meta",
    vendorName: "Meta/Facebook",
    vendorFamily: "social-adtech",
    domains: ["facebook.com", "facebook.net", "fbsbx.com"],
  },
  {
    vendorId: "microsoft",
    vendorName: "Microsoft/Bing",
    vendorFamily: "adtech-analytics",
    domains: ["bing.com", "bat.bing.com", "clarity.ms", "microsoft.com"],
  },
  {
    vendorId: "amazon",
    vendorName: "Amazon/CloudFront",
    vendorFamily: "cdn-commerce",
    domains: ["amazon-adsystem.com", "cloudfront.net", "amazonaws.com", "amzn.to"],
  },
  {
    vendorId: "outbrain",
    vendorName: "Outbrain",
    vendorFamily: "adtech",
    domains: ["outbrain.com"],
  },
  {
    vendorId: "taboola",
    vendorName: "Taboola",
    vendorFamily: "adtech",
    domains: ["taboola.com"],
  },
  {
    vendorId: "segment",
    vendorName: "Segment",
    vendorFamily: "analytics",
    domains: ["segment.com", "segment.io"],
  },
  {
    vendorId: "mixpanel",
    vendorName: "Mixpanel",
    vendorFamily: "analytics",
    domains: ["mixpanel.com"],
  },
];

function normalizeHost(raw) {
  const input = String(raw || "").trim().toLowerCase();
  if (!input) return "";

  let host = input;
  try {
    if (host.includes("://")) {
      host = new URL(host).hostname || host;
    } else if (host.includes("/")) {
      host = host.split("/")[0];
    }
  } catch {
    // Keep best-effort host
  }

  return host.replace(/^\.+/, "").replace(/^www\./, "");
}

function toBaseDomain(raw) {
  const host = normalizeHost(raw);
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

function toSafeNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function toConfidence(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return null;
  if (value < 0 || value > 1) return null;
  return value;
}

function pickAllowedString(value, allowed, fallback) {
  const next = String(value || "").trim();
  if (!next) return fallback;
  return allowed.has(next) ? next : fallback;
}

function classifyDomain(rawDomain) {
  const normalized = normalizeHost(rawDomain);
  if (!normalized) {
    return {
      vendorId: null,
      vendorName: null,
      vendorFamily: null,
      domain: "",
      known: false,
    };
  }

  for (const profile of VENDOR_PROFILES) {
    for (const d of profile.domains) {
      if (normalized === d || normalized.endsWith(`.${d}`)) {
        return {
          vendorId: profile.vendorId,
          vendorName: profile.vendorName,
          vendorFamily: profile.vendorFamily,
          domain: normalized,
          known: true,
        };
      }
    }
  }

  const fallback = toBaseDomain(normalized) || normalized;
  return {
    vendorId: fallback,
    vendorName: fallback,
    vendorFamily: "unmapped",
    domain: normalized,
    known: false,
  };
}

function deriveSurface(kind = "") {
  if (kind.startsWith("network.")) return "network";
  if (kind.startsWith("cookies.")) return "cookies";
  if (kind.startsWith("storage.")) return "storage";
  if (kind.startsWith("browser_api.") || kind.startsWith("api.")) return "api";
  if (kind.startsWith("script.")) return "script";
  return "unknown";
}

function deriveSurfaceDetail(kind = "") {
  if (kind.startsWith("network.")) return "network_request";
  if (kind === "cookies.snapshot") return "cookie_snapshot";
  if (kind.startsWith("cookies.")) return "cookie_operation";
  if (kind.startsWith("storage.local")) return "local_storage";
  if (kind.startsWith("storage.session")) return "session_storage";
  if (kind.startsWith("storage.indexeddb")) return "indexeddb";
  if (kind.startsWith("storage.cache")) return "cache_api";
  if (kind.includes("canvas")) return "canvas";
  if (kind.includes("webgl")) return "webgl";
  if (kind.includes("webrtc")) return "webrtc";
  if (kind.includes("audiocontext") || kind.includes("audio_context")) return "audiocontext";
  if (kind.startsWith("script.")) return "script_execution";
  return "unknown";
}

function pickRepresentativeCookieDomain(data = {}) {
  const cookies = Array.isArray(data.cookies) ? data.cookies : [];
  if (!cookies.length) return "";

  const thirdPartyCounts = new Map();
  const allCounts = new Map();

  for (const c of cookies) {
    const domain = normalizeHost(c?.domain || "");
    if (!domain) continue;
    allCounts.set(domain, (allCounts.get(domain) || 0) + 1);
    if (c?.isThirdParty === true) {
      thirdPartyCounts.set(domain, (thirdPartyCounts.get(domain) || 0) + 1);
    }
  }

  const pickTop = (map) => {
    let topDomain = "";
    let topCount = -1;
    for (const [domain, count] of map.entries()) {
      if (count > topCount) {
        topDomain = domain;
        topCount = count;
      }
    }
    return topDomain;
  };

  return pickTop(thirdPartyCounts) || pickTop(allCounts) || "";
}

function buildNetworkEnrichment(ev, site, data, kind) {
  const requestDomain = normalizeHost(data.domain || data.url || "");
  const vendor = classifyDomain(requestDomain);
  const isThirdParty = typeof data.isThirdParty === "boolean" ? (data.isThirdParty ? 1 : 0) : null;

  let mitigationStatus = "observed_only";
  if (kind === "network.blocked") mitigationStatus = "blocked";
  else if (kind === "network.allowed") mitigationStatus = "allowed";

  let privacyStatus = "unknown";
  if (mitigationStatus === "blocked") privacyStatus = "policy_blocked";
  else if (mitigationStatus === "allowed") privacyStatus = "policy_allowed";
  else if (kind === "network.observed" && isThirdParty === 0) privacyStatus = "baseline";
  else if (kind === "network.observed") privacyStatus = "signal_detected";

  let signalType = "unknown";
  if (kind === "network.blocked" || isThirdParty === 1) signalType = "tracking_signal";
  else if (kind === "network.observed" && isThirdParty === 0) signalType = "state_change";

  let patternId = data.patternId || null;
  if (!patternId) {
    if (kind === "network.blocked" && data.ruleId != null) patternId = "network.rule_blocked";
    else if (kind === "network.observed" && isThirdParty === 1) patternId = "network.third_party_observed";
    else if (kind === "network.observed" && isThirdParty === 0) patternId = "network.first_party_observed";
  }

  const inferredConfidence =
    kind === "network.blocked" && data.ruleId != null ? 0.98 :
    requestDomain && isThirdParty !== null ? 0.92 :
    requestDomain ? 0.8 :
    0.65;

  return {
    enrichedTs: Number(ev?.ts) || Date.now(),
    enrichmentVersion: "v2",
    surface: "network",
    surfaceDetail: "network_request",
    privacyStatus,
    mitigationStatus,
    signalType,
    patternId,
    confidence: toConfidence(data.confidence) ?? inferredConfidence,
    vendorId: data.vendorId || vendor.vendorId,
    vendorName: data.vendorName || vendor.vendorName,
    vendorFamily: data.vendorFamily || vendor.vendorFamily,
    requestDomain: requestDomain || null,
    requestUrl: data.url || null,
    firstPartySite: site || null,
    isThirdParty,
    ruleId: data.ruleId != null ? String(data.ruleId) : null,
    rawContext: JSON.stringify({
      kind,
      mode: ev?.mode || null,
      source: ev?.source || null,
      resourceType: data.resourceType || null,
    }),
  };
}

function buildCookieSnapshotEnrichment(ev, site, data, kind) {
  const cookies = Array.isArray(data.cookies) ? data.cookies : [];
  const cookieCount = Math.max(0, Math.floor(toSafeNumber(data.count, cookies.length)));
  const computedThirdPartyCount = cookies.filter((c) => c?.isThirdParty === true).length;
  const thirdPartyCount = Math.max(0, Math.floor(toSafeNumber(data.thirdPartyCount, computedThirdPartyCount)));
  const representativeDomain = normalizeHost(pickRepresentativeCookieDomain(data) || data.domain || "");
  const vendor = classifyDomain(representativeDomain);

  const thirdPartyPresent = thirdPartyCount > 0;
  const hasCookies = cookieCount > 0;

  const privacyStatus = !hasCookies
    ? "baseline"
    : thirdPartyPresent
      ? "signal_detected"
      : "baseline";

  const inferredConfidence =
    typeof data.count === "number" && typeof data.thirdPartyCount === "number" ? 0.9 :
    cookies.length > 0 ? 0.85 :
    data.url ? 0.7 :
    0.6;

  return {
    enrichedTs: Number(ev?.ts) || Date.now(),
    enrichmentVersion: "v2",
    surface: "cookies",
    surfaceDetail: "cookie_snapshot",
    privacyStatus,
    mitigationStatus: "observed_only",
    signalType: thirdPartyPresent ? "tracking_signal" : "state_change",
    patternId: data.patternId || (
      !hasCookies
        ? "cookies.snapshot.empty"
        : thirdPartyPresent
          ? "cookies.snapshot.third_party_present"
          : "cookies.snapshot.first_party_only"
    ),
    confidence: toConfidence(data.confidence) ?? inferredConfidence,
    vendorId: data.vendorId || vendor.vendorId,
    vendorName: data.vendorName || vendor.vendorName,
    vendorFamily: data.vendorFamily || vendor.vendorFamily,
    requestDomain: representativeDomain || null,
    requestUrl: data.url || null,
    firstPartySite: site || null,
    // For snapshots, this indicates whether third-party cookies are present in aggregate.
    isThirdParty: hasCookies ? (thirdPartyPresent ? 1 : 0) : null,
    ruleId: data.ruleId != null ? String(data.ruleId) : null,
    rawContext: JSON.stringify({
      kind,
      mode: ev?.mode || null,
      source: ev?.source || null,
      cookieCount,
      thirdPartyCount,
      cookieSampleSize: cookies.length,
    }),
  };
}

function buildCookieOperationEnrichment(ev, site, data, kind) {
  const requestDomain = normalizeHost(data.domain || data.url || "");
  const vendor = classifyDomain(requestDomain);

  const total = Math.max(0, Math.floor(toSafeNumber(data.total, 0)));
  const cleared = Math.max(0, Math.floor(toSafeNumber(data.cleared, 0)));
  const thirdPartyCount = Math.max(0, Math.floor(toSafeNumber(data.thirdPartyCount, 0)));
  const thirdPartySignal = typeof data.isThirdParty === "boolean"
    ? (data.isThirdParty ? 1 : 0)
    : thirdPartyCount > 0
      ? 1
      : null;

  let mitigationStatus = "observed_only";
  if (kind === "cookies.cleared" || kind === "cookies.removed") mitigationStatus = "modified";

  let privacyStatus = "unknown";
  if (total === 0 && cleared === 0 && thirdPartySignal !== 1) privacyStatus = "baseline";
  else if (mitigationStatus === "modified" && cleared > 0) privacyStatus = "policy_blocked";
  else if (thirdPartySignal === 1) privacyStatus = "signal_detected";
  else privacyStatus = "baseline";

  const inferredConfidence =
    typeof data.total === "number" || typeof data.cleared === "number" ? 0.85 :
    data.url ? 0.72 :
    0.65;

  return {
    enrichedTs: Number(ev?.ts) || Date.now(),
    enrichmentVersion: "v2",
    surface: "cookies",
    surfaceDetail: kind === "cookies.snapshot" ? "cookie_snapshot" : "cookie_operation",
    privacyStatus,
    mitigationStatus,
    signalType: thirdPartySignal === 1 ? "tracking_signal" : "state_change",
    patternId: data.patternId || (
      kind === "cookies.cleared" || kind === "cookies.removed"
        ? "cookies.operation.clear"
        : "cookies.operation.observe"
    ),
    confidence: toConfidence(data.confidence) ?? inferredConfidence,
    vendorId: data.vendorId || vendor.vendorId,
    vendorName: data.vendorName || vendor.vendorName,
    vendorFamily: data.vendorFamily || vendor.vendorFamily,
    requestDomain: requestDomain || null,
    requestUrl: data.url || null,
    firstPartySite: site || null,
    isThirdParty: thirdPartySignal,
    ruleId: data.ruleId != null ? String(data.ruleId) : null,
    rawContext: JSON.stringify({
      kind,
      mode: ev?.mode || null,
      source: ev?.source || null,
      total,
      cleared,
      thirdPartyCount,
    }),
  };
}

const PRIVACY_STATUS_VALUES = new Set([
  "baseline",
  "signal_detected",
  "high_risk",
  "policy_blocked",
  "policy_allowed",
  "unknown",
]);
const MITIGATION_STATUS_VALUES = new Set([
  "allowed",
  "blocked",
  "observed_only",
  "modified",
  "unknown",
]);
const SIGNAL_TYPE_VALUES = new Set([
  "fingerprinting_signal",
  "tracking_signal",
  "device_probe",
  "capability_probe",
  "state_change",
  "unknown",
]);
const API_GATE_OUTCOME_VALUES = new Set([
  "observed",
  "warned",
  "blocked",
  "trusted_allowed",
]);
const API_GATE_ACTION_VALUES = new Set([
  "observe",
  "warn",
  "block",
  "allow_trusted",
]);

function deriveApiSurfaceDetail(kind, data = {}) {
  const explicit = String(data.surfaceDetail || "").trim().toLowerCase();
  if (explicit === "canvas" || explicit === "webrtc" || explicit === "geolocation") return explicit;
  if (kind.includes("canvas")) return "canvas";
  if (kind.includes("geolocation")) return "geolocation";
  if (kind.includes("webrtc")) return "webrtc";
  return "unknown";
}

const WEBRTC_SETUP_ACTIONS = new Set([
  "peer_connection_created",
  "set_configuration",
]);

const WEBRTC_OFFER_ACTIONS = new Set([
  "create_offer_called",
  "offer_created",
  "set_local_description_offer",
]);

const WEBRTC_ICE_ACTIONS = new Set([
  "ice_gathering_state",
  "ice_candidate_activity",
]);

const GEOLOCATION_WATCH_METHODS = new Set([
  "watchposition",
]);

function normalizeApiToken(value) {
  return String(value || "").trim().toLowerCase();
}

function deriveApiClassification(kind, surfaceDetail, data = {}, stunTurnHostnames = []) {
  if (surfaceDetail === "canvas") {
    const operation = normalizeApiToken(data.operation);
    const burstCount = Math.max(1, Math.floor(toSafeNumber(data.count, 1)));
    const repeatedReadback = burstCount >= 2;

    let confidence = 0.91;
    if (operation === "readpixels") confidence = 0.97;
    else if (operation === "getimagedata") confidence = 0.95;
    else if (operation === "todataurl" || operation === "toblob") confidence = 0.94;

    if (repeatedReadback) {
      confidence = Math.max(confidence, 0.96);
    }

    return {
      signalType: "fingerprinting_signal",
      patternId: repeatedReadback
        ? "api.canvas.repeated_readback"
        : "api.canvas.readback",
      confidence,
    };
  }

  if (surfaceDetail === "webrtc") {
    const action = normalizeApiToken(data.action);
    const offerType = normalizeApiToken(data.offerType);
    const state = normalizeApiToken(data.state);
    const candidateType = normalizeApiToken(data.candidateType);
    const hasStunTurnAssist = stunTurnHostnames.length > 0;
    const looksLikeOfferProbe = WEBRTC_OFFER_ACTIONS.has(action) || offerType === "offer";
    const looksLikeIceProbe = WEBRTC_ICE_ACTIONS.has(action)
      || state === "gathering"
      || state === "complete"
      || state === "candidate"
      || Boolean(candidateType);

    if (hasStunTurnAssist && (looksLikeOfferProbe || looksLikeIceProbe)) {
      return {
        signalType: "device_probe",
        patternId: "api.webrtc.stun_turn_assisted_probe",
        confidence: looksLikeIceProbe ? 0.96 : 0.95,
      };
    }

    if (looksLikeIceProbe) {
      return {
        signalType: "device_probe",
        patternId: "api.webrtc.ice_probe",
        confidence: action === "ice_candidate_activity" ? 0.93 : 0.9,
      };
    }

    if (looksLikeOfferProbe) {
      let confidence = 0.9;
      if (action === "set_local_description_offer") confidence = 0.95;
      else if (action === "offer_created") confidence = 0.93;

      return {
        signalType: "device_probe",
        patternId: "api.webrtc.offer_probe",
        confidence,
      };
    }

    if (WEBRTC_SETUP_ACTIONS.has(action)) {
      return {
        signalType: "capability_probe",
        patternId: "api.webrtc.peer_connection_setup",
        confidence: action === "set_configuration" ? 0.86 : 0.84,
      };
    }

    return {
      signalType: "capability_probe",
      patternId: "api.webrtc.peer_connection_setup",
      confidence: 0.82,
    };
  }

  if (surfaceDetail === "geolocation") {
    const method = normalizeApiToken(data.method);
    const isWatch = GEOLOCATION_WATCH_METHODS.has(method);

    return {
      signalType: "tracking_signal",
      patternId: isWatch
        ? "api.geolocation.watch_request"
        : "api.geolocation.current_position_request",
      confidence: isWatch ? 0.98 : 0.97,
    };
  }

  return {
    signalType: "capability_probe",
    patternId: kind.startsWith("api.") || kind.startsWith("browser_api.") ? kind : null,
    confidence: 0.75,
  };
}

function buildApiEnrichment(ev, site, data, kind) {
  const surfaceDetail = deriveApiSurfaceDetail(kind, data);
  const gateOutcome = pickAllowedString(
    data.gateOutcome,
    API_GATE_OUTCOME_VALUES,
    ""
  );
  const gateAction = pickAllowedString(
    data.gateAction,
    API_GATE_ACTION_VALUES,
    ""
  );

  let mitigationStatus = "observed_only";
  if (gateOutcome === "blocked") mitigationStatus = "blocked";
  else if (gateOutcome === "trusted_allowed") mitigationStatus = "allowed";
  else {
    mitigationStatus = pickAllowedString(
      data.mitigationStatus,
      MITIGATION_STATUS_VALUES,
      "observed_only"
    );
  }

  const defaultPrivacyStatus = gateOutcome === "blocked"
    ? "policy_blocked"
    : gateOutcome === "trusted_allowed"
      ? "policy_allowed"
      : mitigationStatus === "blocked"
        ? "policy_blocked"
        : mitigationStatus === "allowed"
          ? "policy_allowed"
          : "signal_detected";

  const privacyStatus = pickAllowedString(
    data.privacyStatus,
    PRIVACY_STATUS_VALUES,
    defaultPrivacyStatus
  );
  const stunHost = Array.isArray(data.stunTurnHostnames) ? data.stunTurnHostnames[0] : "";
  const requestDomain = normalizeHost(data.domain || data.url || stunHost || "");
  const vendor = requestDomain ? classifyDomain(requestDomain) : {
    vendorId: null,
    vendorName: null,
    vendorFamily: null,
  };
  const burstCount = Math.max(1, Math.floor(toSafeNumber(data.count, 1)));
  const burstMs = Math.max(0, Math.floor(toSafeNumber(data.burstMs, 0)));
  const width = toSafeNumber(data.width, null);
  const height = toSafeNumber(data.height, null);
  const contextType = String(data.contextType || "").trim() || null;
  const action = String(data.action || "").trim() || null;
  const operation = String(data.operation || "").trim() || null;
  const state = String(data.state || "").trim() || null;
  const offerType = String(data.offerType || "").trim() || null;
  const candidateType = String(data.candidateType || "").trim() || null;
  const method = String(data.method || "").trim() || null;
  const requestedHighAccuracy = data.requestedHighAccuracy === true;
  const timeoutMs = toSafeNumber(data.timeoutMs, null);
  const maximumAgeMs = toSafeNumber(data.maximumAgeMs, null);
  const hasSuccessCallback = data.hasSuccessCallback !== false;
  const hasErrorCallback = data.hasErrorCallback === true;
  const policyReady = data.policyReady !== false;
  const stunTurnHostnames = Array.isArray(data.stunTurnHostnames)
    ? data.stunTurnHostnames.map((h) => normalizeHost(h)).filter(Boolean).slice(0, 8)
    : [];
  const trustedSite = typeof data.trustedSite === "boolean" ? data.trustedSite : null;
  const frameScope = String(data.frameScope || "").trim() === "top_frame" ? "top_frame" : null;
  const { signalType, patternId, confidence } = deriveApiClassification(
    kind,
    surfaceDetail,
    data,
    stunTurnHostnames
  );

  return {
    enrichedTs: Number(ev?.ts) || Date.now(),
    enrichmentVersion: "v2",
    surface: "api",
    surfaceDetail,
    privacyStatus,
    mitigationStatus,
    signalType,
    patternId,
    confidence,
    vendorId: data.vendorId || vendor.vendorId,
    vendorName: data.vendorName || vendor.vendorName,
    vendorFamily: data.vendorFamily || vendor.vendorFamily,
    requestDomain: requestDomain || null,
    requestUrl: data.url || null,
    firstPartySite: site || null,
    isThirdParty: typeof data.isThirdParty === "boolean" ? (data.isThirdParty ? 1 : 0) : null,
    ruleId: data.ruleId != null ? String(data.ruleId) : null,
    rawContext: JSON.stringify({
      kind,
      mode: ev?.mode || null,
      source: ev?.source || null,
      operation,
      method,
      action,
      contextType,
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
      state,
      offerType,
      candidateType,
      requestedHighAccuracy,
      timeoutMs: Number.isFinite(timeoutMs) ? timeoutMs : null,
      maximumAgeMs: Number.isFinite(maximumAgeMs) ? maximumAgeMs : null,
      hasSuccessCallback,
      hasErrorCallback,
      policyReady,
      burstCount,
      burstMs,
      gateOutcome: gateOutcome || null,
      gateAction: gateAction || null,
      trustedSite,
      frameScope,
      stunTurnHostnames,
    }),
  };
}

function buildGenericEnrichment(ev, site, data, kind) {
  const surface = deriveSurface(kind);
  const surfaceDetail = deriveSurfaceDetail(kind);

  let mitigationStatus = "unknown";
  if (kind === "network.blocked") mitigationStatus = "blocked";
  else if (kind === "network.allowed") mitigationStatus = "allowed";
  else if (kind.startsWith("cookies.")) mitigationStatus = "observed_only";
  else if (kind.startsWith("storage.") || kind.startsWith("browser_api.") || kind.startsWith("api.") || kind.startsWith("script.")) {
    mitigationStatus = "observed_only";
  }

  let privacyStatus = "unknown";
  if (mitigationStatus === "blocked") privacyStatus = "policy_blocked";
  else if (mitigationStatus === "allowed") privacyStatus = "policy_allowed";
  else if (kind.startsWith("storage.")) privacyStatus = "baseline";
  else if (kind.startsWith("browser_api.") || kind.startsWith("api.") || kind.startsWith("script.")) privacyStatus = "signal_detected";

  let signalType = "unknown";
  if (surface === "storage") signalType = "state_change";
  else if (surface === "script") signalType = "capability_probe";
  else if (surface === "api") signalType = "capability_probe";

  const requestDomain = normalizeHost(data.domain || data.url || "");
  const vendor = classifyDomain(requestDomain);

  return {
    enrichedTs: Number(ev?.ts) || Date.now(),
    enrichmentVersion: "v2",
    surface,
    surfaceDetail,
    privacyStatus,
    mitigationStatus,
    signalType,
    patternId: data.patternId || null,
    confidence: toConfidence(data.confidence),
    vendorId: data.vendorId || vendor.vendorId,
    vendorName: data.vendorName || vendor.vendorName,
    vendorFamily: data.vendorFamily || vendor.vendorFamily,
    requestDomain: requestDomain || null,
    requestUrl: data.url || null,
    firstPartySite: site || null,
    isThirdParty: typeof data.isThirdParty === "boolean" ? (data.isThirdParty ? 1 : 0) : null,
    ruleId: data.ruleId != null ? String(data.ruleId) : null,
    rawContext: JSON.stringify({
      kind,
      mode: ev?.mode || null,
      source: ev?.source || null,
    }),
  };
}

function buildEnrichmentRecord(ev, site) {
  const kind = typeof ev?.kind === "string" ? ev.kind : "unknown";
  const data = ev?.data && typeof ev.data === "object" ? ev.data : {};

  if (kind.startsWith("network.")) {
    return buildNetworkEnrichment(ev, site, data, kind);
  }
  if (kind === "cookies.snapshot") {
    return buildCookieSnapshotEnrichment(ev, site, data, kind);
  }
  if (kind.startsWith("cookies.")) {
    return buildCookieOperationEnrichment(ev, site, data, kind);
  }
  if (kind.startsWith("api.") || kind.startsWith("browser_api.")) {
    return buildApiEnrichment(ev, site, data, kind);
  }

  return buildGenericEnrichment(ev, site, data, kind);
}

module.exports = {
  VENDOR_PROFILES,
  normalizeHost,
  toBaseDomain,
  classifyDomain,
  buildEnrichmentRecord,
};
