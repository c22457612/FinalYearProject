(() => {
  if (window.__vptApiSignalBridgeInstalled) return;
  window.__vptApiSignalBridgeInstalled = true;

  const gateShared = globalThis.__VPTApiGateShared || null;
  const SOURCE_TAG = "vpt_api_signal";
  const GATE_SOURCE_TAG = gateShared?.CONFIG_SOURCE_TAG || "vpt_api_gate";
  const CANVAS_OPS = new Set(["getImageData", "toDataURL", "toBlob", "readPixels"]);
  const WEBRTC_ACTIONS = new Set([
    "peer_connection_created",
    "create_offer_called",
    "offer_created",
    "set_local_description_offer",
    "ice_gathering_state",
    "ice_candidate_activity",
    "set_configuration",
  ]);
  const CONTEXT_TYPES = new Set(["2d", "webgl", "webgl2", "bitmaprenderer", "webgpu", "unknown"]);
  const MAX_COUNT = 5000;
  const MAX_BURST_MS = 60_000;
  const MAX_DIMENSION = 16_384;
  const MAX_HOSTNAMES = 8;
  const CANVAS_GATE_OUTCOMES = new Set(gateShared?.CANVAS_GATE_OUTCOMES || ["observed", "warned", "blocked", "trusted_allowed"]);
  const FRAME_SCOPES = new Set(["top_frame"]);

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

  function isIpv4(host) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  }

  function isIpv6(host) {
    return host.includes(":") && /^[0-9a-f:.]+$/i.test(host);
  }

  function sanitizeHostname(raw) {
    const input = asSafeString(raw, 255);
    if (!input) return null;
    const host = input.toLowerCase();
    if (isIpv4(host) || isIpv6(host)) return null;
    if (!/^[a-z0-9.-]+$/.test(host)) return null;
    return host;
  }

  function toBaseDomain(host) {
    if (gateShared?.toBaseDomain) {
      return gateShared.toBaseDomain(host) || null;
    }
    const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
    if (!parts.length) return null;
    if (parts.length <= 2) return parts.join(".");
    return parts.slice(-2).join(".");
  }

  function normalizeCanvasGateAction(value) {
    if (gateShared?.normalizeCanvasGateAction) {
      return gateShared.normalizeCanvasGateAction(value);
    }
    const next = asSafeString(value, 32);
    return next === "warn" || next === "block" || next === "allow_trusted" ? next : "observe";
  }

  function postCanvasGateState(snapshot) {
    if (!gateShared?.buildCanvasGateState) return;
    const payload = gateShared.buildCanvasGateState({
      apiGatePolicy: snapshot?.apiGatePolicy,
      trusted: snapshot?.trusted,
      hostname: window.location.hostname,
    });
    window.postMessage(
      {
        source: GATE_SOURCE_TAG,
        type: "canvas_gate_state",
        payload,
      },
      "*"
    );
  }

  async function syncCanvasGateState() {
    try {
      const snapshot = await chrome.storage.local.get(["trusted", "apiGatePolicy"]);
      postCanvasGateState(snapshot);
    } catch {
      // Ignore bridge sync failures; Canvas defaults remain observe-only.
    }
  }

  function sanitizeCanvasSignal(payload) {
    const operation = asSafeString(payload.operation, 32);
    if (!operation || !CANVAS_OPS.has(operation)) return null;

    const contextTypeRaw = asSafeString(payload.contextType, 32) || "unknown";
    const contextType = CONTEXT_TYPES.has(contextTypeRaw) ? contextTypeRaw : "unknown";

    const width = asSafeInt(payload.width, 1, MAX_DIMENSION);
    const height = asSafeInt(payload.height, 1, MAX_DIMENSION);
    const count = asSafeInt(payload.count, 1, MAX_COUNT) || 1;
    const burstMs = asSafeInt(payload.burstMs, 0, MAX_BURST_MS) || 0;
    const sampleWindowMs = asSafeInt(payload.sampleWindowMs, 100, MAX_BURST_MS) || 1200;

    return {
      surface: "api",
      surfaceDetail: "canvas",
      operation,
      contextType,
      width,
      height,
      count,
      burstMs,
      sampleWindowMs,
      gateOutcome: CANVAS_GATE_OUTCOMES.has(asSafeString(payload.gateOutcome, 32) || "")
        ? asSafeString(payload.gateOutcome, 32)
        : "observed",
      gateAction: normalizeCanvasGateAction(payload.gateAction),
      trustedSite: typeof payload.trustedSite === "boolean" ? payload.trustedSite : undefined,
      frameScope: FRAME_SCOPES.has(asSafeString(payload.frameScope, 32) || "")
        ? asSafeString(payload.frameScope, 32)
        : "top_frame",
      siteBase: toBaseDomain(window.location.hostname) || undefined,
    };
  }

  function sanitizeWebrtcSignal(payload) {
    const action = asSafeString(payload.action, 48);
    if (!action || !WEBRTC_ACTIONS.has(action)) return null;

    const state = asSafeString(payload.state, 48) || undefined;
    const offerType = asSafeString(payload.offerType, 24) || undefined;
    const candidateType = asSafeString(payload.candidateType, 24) || undefined;
    const count = asSafeInt(payload.count, 1, MAX_COUNT) || 1;
    const burstMs = asSafeInt(payload.burstMs, 0, MAX_BURST_MS) || 0;
    const sampleWindowMs = asSafeInt(payload.sampleWindowMs, 100, MAX_BURST_MS) || 1200;

    const hostnames = Array.isArray(payload.stunTurnHostnames)
      ? payload.stunTurnHostnames.map(sanitizeHostname).filter(Boolean).slice(0, MAX_HOSTNAMES)
      : [];

    return {
      surface: "api",
      surfaceDetail: "webrtc",
      action,
      state,
      offerType,
      candidateType,
      stunTurnHostnames: hostnames,
      count,
      burstMs,
      sampleWindowMs,
      siteBase: toBaseDomain(window.location.hostname) || undefined,
    };
  }

  function normalizeSignal(kind, payload) {
    if (!kind || typeof payload !== "object" || !payload) return null;

    if (kind.startsWith("api.canvas.")) return sanitizeCanvasSignal(payload);
    if (kind.startsWith("api.webrtc.")) return sanitizeWebrtcSignal(payload);
    return null;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.source === GATE_SOURCE_TAG && data.type === "canvas_gate_state_request") {
      syncCanvasGateState().catch(() => {});
      return;
    }
    if (data.source !== SOURCE_TAG) return;

    const kind = asSafeString(data.kind, 64);
    const payload = normalizeSignal(kind, data.payload);
    if (!kind || !payload) return;

    chrome.runtime.sendMessage({
      type: "api:signal",
      payload: { kind, data: payload },
    }).catch(() => {});
  });

  if (chrome?.storage?.onChanged) {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName && areaName !== "local") return;
      if (!changes || (!("trusted" in changes) && !("apiGatePolicy" in changes))) return;
      syncCanvasGateState().catch(() => {});
    });
  }

  syncCanvasGateState().catch(() => {});
})();
