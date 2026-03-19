(() => {
  if (window.__vptApiSignalMainInstalled) return;
  window.__vptApiSignalMainInstalled = true;

  const gateShared = globalThis.__VPTApiGateShared || null;
  const SOURCE_TAG = "vpt_api_signal";
  const GATE_SOURCE_TAG = gateShared?.CONFIG_SOURCE_TAG || "vpt_api_gate";
  const BURST_WINDOW_MS = 1200;
  const BURST_FLUSH_COUNT = 10;
  const PATCHED_FLAG = "__vpt_api_patched";
  const MAX_HOSTNAMES = 8;
  const WARN_THROTTLE_MS = 5000;
  const MAX_CLIPBOARD_ITEMS = 32;
  const MAX_CLIPBOARD_MIME_TYPES = 16;

  const burstMap = new Map(); // key -> { kind, payload, count, firstTs, lastTs, timerId }
  const canvasContextByElement = new WeakMap(); // canvas -> context type
  const webrtcMeta = new WeakMap(); // pc -> { stunTurnHostnames:Set<string> }
  const canvasWarnMap = new Map(); // key -> lastWarnTs
  const clipboardWarnMap = new Map(); // key -> lastWarnTs
  const geolocationWarnMap = new Map(); // key -> lastWarnTs
  const webrtcWarnMap = new Map(); // key -> lastWarnTs
  const blockedWatchIds = new Set();
  let nextBlockedWatchId = -1;
  const canvasGateState = {
    canvasAction: "observe",
    trustedSite: false,
    siteBase: "",
    frameScope: "top_frame",
    ready: false,
  };
  const clipboardGateState = {
    clipboardAction: "observe",
    trustedSite: false,
    siteBase: "",
    frameScope: "top_frame",
    ready: false,
  };
  const webrtcGateState = {
    webrtcAction: "observe",
    trustedSite: false,
    siteBase: "",
    frameScope: "top_frame",
    ready: false,
  };
  const geolocationGateState = {
    geolocationAction: "observe",
    trustedSite: false,
    siteBase: "",
    frameScope: "top_frame",
    ready: false,
  };

  function snapshotApiGateState() {
    return {
      canvasAction: canvasGateState.canvasAction,
      canvasReady: canvasGateState.ready,
      clipboardAction: clipboardGateState.clipboardAction,
      clipboardReady: clipboardGateState.ready,
      geolocationAction: geolocationGateState.geolocationAction,
      geolocationReady: geolocationGateState.ready,
      webrtcAction: webrtcGateState.webrtcAction,
      webrtcReady: webrtcGateState.ready,
      trustedSite: clipboardGateState.trustedSite,
      siteBase: clipboardGateState.siteBase,
      frameScope: clipboardGateState.frameScope,
      sharedLoaded: Boolean(gateShared),
    };
  }

  function publishApiGateDebugState() {
    try {
      window.__VPTApiGateStateDebug = snapshotApiGateState();
      window.__VPTGetApiGateState = () => ({ ...window.__VPTApiGateStateDebug });
    } catch {
      // Ignore debug-state publication failures.
    }
  }

  function postSignal(kind, payload) {
    window.postMessage(
      {
        source: SOURCE_TAG,
        kind,
        payload,
      },
      "*"
    );
  }

  function toPositiveInt(value, fallback = null) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const next = Math.floor(n);
    if (next <= 0) return fallback;
    return next;
  }

  function toNonNegativeInt(value, fallback = null) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    const next = Math.floor(n);
    if (next < 0) return fallback;
    return next;
  }

  function normalizeContextType(raw) {
    const value = String(raw || "").toLowerCase();
    if (value === "2d") return "2d";
    if (value === "webgl") return "webgl";
    if (value === "webgl2") return "webgl2";
    if (value === "bitmaprenderer") return "bitmaprenderer";
    if (value === "webgpu") return "webgpu";
    return "unknown";
  }

  function normalizeCanvasGateAction(value) {
    if (gateShared?.normalizeCanvasGateAction) {
      return gateShared.normalizeCanvasGateAction(value);
    }
    const next = String(value || "").trim().toLowerCase();
    return next === "warn" || next === "block" || next === "allow_trusted" ? next : "observe";
  }

  function normalizeClipboardGateAction(value) {
    if (gateShared?.normalizeClipboardGateAction) {
      return gateShared.normalizeClipboardGateAction(value);
    }
    const next = String(value || "").trim().toLowerCase();
    return next === "warn" || next === "block" || next === "allow_trusted" ? next : "observe";
  }

  function normalizeWebrtcGateAction(value) {
    if (gateShared?.normalizeWebrtcGateAction) {
      return gateShared.normalizeWebrtcGateAction(value);
    }
    const next = String(value || "").trim().toLowerCase();
    return next === "warn" || next === "block" || next === "allow_trusted" ? next : "observe";
  }

  function normalizeGeolocationGateAction(value) {
    if (gateShared?.normalizeGeolocationGateAction) {
      return gateShared.normalizeGeolocationGateAction(value);
    }
    const next = String(value || "").trim().toLowerCase();
    return next === "warn" || next === "block" || next === "allow_trusted" ? next : "observe";
  }

  function getCanvasGateDecision() {
    if (gateShared?.deriveCanvasGateDecision) {
      return gateShared.deriveCanvasGateDecision(
        canvasGateState.canvasAction,
        canvasGateState.trustedSite
      );
    }
    const policyAction = normalizeCanvasGateAction(canvasGateState.canvasAction);
    if (policyAction === "warn") {
      return { policyAction, gateOutcome: "warned", shouldBlock: false };
    }
    if (policyAction === "block") {
      return { policyAction, gateOutcome: "blocked", shouldBlock: true };
    }
    if (policyAction === "allow_trusted") {
      return canvasGateState.trustedSite
        ? { policyAction, gateOutcome: "trusted_allowed", shouldBlock: false }
        : { policyAction, gateOutcome: "blocked", shouldBlock: true };
    }
    return { policyAction, gateOutcome: "observed", shouldBlock: false };
  }

  function getClipboardGateDecision(accessType) {
    const normalizedAccessType = gateShared?.normalizeClipboardAccessType
      ? gateShared.normalizeClipboardAccessType(accessType)
      : (String(accessType || "").trim().toLowerCase() === "write" ? "write" : "read");

    if (!clipboardGateState.ready) {
      return normalizedAccessType === "write"
        ? {
          policyAction: "observe",
          gateOutcome: "observed",
          shouldBlock: false,
          accessType: normalizedAccessType,
          policyReady: false,
        }
        : {
          policyAction: "block",
          gateOutcome: "blocked",
          shouldBlock: true,
          accessType: normalizedAccessType,
          policyReady: false,
        };
    }
    if (gateShared?.deriveClipboardGateDecision) {
      return {
        ...gateShared.deriveClipboardGateDecision(
          clipboardGateState.clipboardAction,
          clipboardGateState.trustedSite,
          normalizedAccessType
        ),
        policyReady: true,
      };
    }
    const policyAction = normalizeClipboardGateAction(clipboardGateState.clipboardAction);
    if (policyAction === "warn") {
      return {
        policyAction,
        gateOutcome: "warned",
        shouldBlock: false,
        accessType: normalizedAccessType,
        policyReady: true,
      };
    }
    if (policyAction === "block") {
      return normalizedAccessType === "write"
        ? {
          policyAction,
          gateOutcome: "warned",
          shouldBlock: false,
          accessType: normalizedAccessType,
          policyReady: true,
        }
        : {
          policyAction,
          gateOutcome: "blocked",
          shouldBlock: true,
          accessType: normalizedAccessType,
          policyReady: true,
        };
    }
    if (policyAction === "allow_trusted") {
      if (clipboardGateState.trustedSite) {
        return {
          policyAction,
          gateOutcome: "trusted_allowed",
          shouldBlock: false,
          accessType: normalizedAccessType,
          policyReady: true,
        };
      }
      return normalizedAccessType === "write"
        ? {
          policyAction,
          gateOutcome: "warned",
          shouldBlock: false,
          accessType: normalizedAccessType,
          policyReady: true,
        }
        : {
          policyAction,
          gateOutcome: "blocked",
          shouldBlock: true,
          accessType: normalizedAccessType,
          policyReady: true,
        };
    }
    return {
      policyAction,
      gateOutcome: "observed",
      shouldBlock: false,
      accessType: normalizedAccessType,
      policyReady: true,
    };
  }

  function getWebrtcGateDecision() {
    if (gateShared?.deriveWebrtcGateDecision) {
      return gateShared.deriveWebrtcGateDecision(
        webrtcGateState.webrtcAction,
        webrtcGateState.trustedSite
      );
    }
    if (gateShared?.deriveGateDecision) {
      return gateShared.deriveGateDecision(
        webrtcGateState.webrtcAction,
        webrtcGateState.trustedSite
      );
    }
    const policyAction = normalizeWebrtcGateAction(webrtcGateState.webrtcAction);
    if (policyAction === "warn") {
      return { policyAction, gateOutcome: "warned", shouldBlock: false };
    }
    if (policyAction === "block") {
      return { policyAction, gateOutcome: "blocked", shouldBlock: true };
    }
    if (policyAction === "allow_trusted") {
      return webrtcGateState.trustedSite
        ? { policyAction, gateOutcome: "trusted_allowed", shouldBlock: false }
        : { policyAction, gateOutcome: "blocked", shouldBlock: true };
    }
    return { policyAction, gateOutcome: "observed", shouldBlock: false };
  }

  function getGeolocationGateDecision() {
    if (!geolocationGateState.ready) {
      return {
        policyAction: "block",
        gateOutcome: "blocked",
        shouldBlock: true,
        policyReady: false,
      };
    }
    if (gateShared?.deriveGeolocationGateDecision) {
      return gateShared.deriveGeolocationGateDecision(
        geolocationGateState.geolocationAction,
        geolocationGateState.trustedSite
      );
    }
    if (gateShared?.deriveGateDecision) {
      return gateShared.deriveGateDecision(
        geolocationGateState.geolocationAction,
        geolocationGateState.trustedSite
      );
    }
    const policyAction = normalizeGeolocationGateAction(geolocationGateState.geolocationAction);
    if (policyAction === "warn") {
      return { policyAction, gateOutcome: "warned", shouldBlock: false };
    }
    if (policyAction === "block") {
      return { policyAction, gateOutcome: "blocked", shouldBlock: true };
    }
    if (policyAction === "allow_trusted") {
      return geolocationGateState.trustedSite
        ? { policyAction, gateOutcome: "trusted_allowed", shouldBlock: false }
        : { policyAction, gateOutcome: "blocked", shouldBlock: true };
    }
    return { policyAction, gateOutcome: "observed", shouldBlock: false };
  }

  function applyApiGateState(payload) {
    if (!payload || typeof payload !== "object") return;
    const trustedSite = payload.trustedSite === true;
    const siteBase = String(payload.siteBase || "").trim().toLowerCase();
    const frameScope = payload.frameScope === "top_frame" ? "top_frame" : "top_frame";

    canvasGateState.canvasAction = normalizeCanvasGateAction(payload.canvasAction);
    canvasGateState.trustedSite = trustedSite;
    canvasGateState.siteBase = siteBase;
    canvasGateState.frameScope = frameScope;
    canvasGateState.ready = true;

    clipboardGateState.clipboardAction = normalizeClipboardGateAction(payload.clipboardAction);
    clipboardGateState.trustedSite = trustedSite;
    clipboardGateState.siteBase = siteBase;
    clipboardGateState.frameScope = frameScope;
    clipboardGateState.ready = true;

    webrtcGateState.webrtcAction = normalizeWebrtcGateAction(payload.webrtcAction);
    webrtcGateState.trustedSite = trustedSite;
    webrtcGateState.siteBase = siteBase;
    webrtcGateState.frameScope = frameScope;
    webrtcGateState.ready = true;

    geolocationGateState.geolocationAction = normalizeGeolocationGateAction(payload.geolocationAction);
    geolocationGateState.trustedSite = trustedSite;
    geolocationGateState.siteBase = siteBase;
    geolocationGateState.frameScope = frameScope;
    geolocationGateState.ready = true;

    publishApiGateDebugState();
  }

  function requestApiGateState() {
    window.postMessage(
      {
        source: GATE_SOURCE_TAG,
        type: "api_gate_state_request",
      },
      "*"
    );
  }

  function isIpv4(host) {
    return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host);
  }

  function isIpv6(host) {
    return host.includes(":") && /^[0-9a-f:.]+$/i.test(host);
  }

  function sanitizeHostname(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (!value) return null;
    if (isIpv4(value) || isIpv6(value)) return null;
    if (!/^[a-z0-9.-]+$/.test(value)) return null;
    return value;
  }

  function parseIceHostname(rawUrl) {
    const value = String(rawUrl || "").trim();
    if (!value) return null;
    if (!/^(stun|stuns|turn|turns):/i.test(value)) return null;

    let remainder = value.replace(/^(stun|stuns|turn|turns):/i, "");
    if (remainder.startsWith("//")) remainder = remainder.slice(2);
    if (remainder.includes("@")) {
      remainder = remainder.slice(remainder.lastIndexOf("@") + 1);
    }
    remainder = remainder.split(/[/?#]/, 1)[0];
    if (!remainder) return null;

    let host = remainder;
    if (host.startsWith("[")) {
      host = host.slice(1).split("]", 1)[0];
    } else {
      host = host.split(":", 1)[0];
    }

    return sanitizeHostname(host);
  }

  function toIceUrlList(iceServer) {
    if (!iceServer || typeof iceServer !== "object") return [];
    const urls = [];

    if (Array.isArray(iceServer.urls)) {
      urls.push(...iceServer.urls);
    } else if (iceServer.urls) {
      urls.push(iceServer.urls);
    }

    if (iceServer.url) {
      urls.push(iceServer.url);
    }

    return urls;
  }

  function extractIceHostnames(config) {
    const out = new Set();
    const servers = Array.isArray(config?.iceServers) ? config.iceServers : [];
    for (const server of servers) {
      const urls = toIceUrlList(server);
      for (const rawUrl of urls) {
        const host = parseIceHostname(rawUrl);
        if (host) out.add(host);
        if (out.size >= MAX_HOSTNAMES) break;
      }
      if (out.size >= MAX_HOSTNAMES) break;
    }
    return Array.from(out);
  }

  function buildBurstKey(kind, parts) {
    return `${kind}|${parts.join("|")}`;
  }

  function flushBurst(key) {
    const state = burstMap.get(key);
    if (!state) return;
    burstMap.delete(key);
    if (state.timerId) clearTimeout(state.timerId);

    const burstMs = Math.max(0, Number(state.lastTs) - Number(state.firstTs));
    postSignal(state.kind, {
      ...state.payload,
      count: state.count,
      burstMs,
      sampleWindowMs: BURST_WINDOW_MS,
    });
  }

  function recordBurst(kind, payload, key) {
    const now = Date.now();
    const existing = burstMap.get(key);
    if (existing) {
      existing.count += 1;
      existing.lastTs = now;
      if (existing.count >= BURST_FLUSH_COUNT) {
        flushBurst(key);
      }
      return;
    }

    const timerId = setTimeout(() => flushBurst(key), BURST_WINDOW_MS);
    burstMap.set(key, {
      kind,
      payload,
      count: 1,
      firstTs: now,
      lastTs: now,
      timerId,
    });
  }

  function recordCanvasSignal(operation, contextType, width, height) {
    const decision = getCanvasGateDecision();
    const payload = {
      operation,
      contextType,
      width: toPositiveInt(width),
      height: toPositiveInt(height),
      gateOutcome: decision.gateOutcome,
      gateAction: decision.policyAction,
      trustedSite: canvasGateState.trustedSite,
      frameScope: canvasGateState.frameScope,
      siteBase: canvasGateState.siteBase || undefined,
    };
    const key = buildBurstKey("api.canvas.activity", [
      operation,
      contextType,
      String(payload.width || 0),
      String(payload.height || 0),
      decision.policyAction,
      decision.gateOutcome,
    ]);
    recordBurst("api.canvas.activity", payload, key);
  }

  function maybeWarnCanvasReadback(operation, contextType, width, height) {
    const decision = getCanvasGateDecision();
    if (decision.gateOutcome !== "warned") return;

    const key = buildBurstKey("api.canvas.warn", [
      operation,
      contextType,
      String(width || 0),
      String(height || 0),
    ]);
    const now = Date.now();
    const lastWarnTs = canvasWarnMap.get(key) || 0;
    if ((now - lastWarnTs) < WARN_THROTTLE_MS) return;

    canvasWarnMap.set(key, now);
    console.warn("[VPT] Canvas readback allowed with warning", {
      operation,
      contextType,
      width: toPositiveInt(width),
      height: toPositiveInt(height),
      site: canvasGateState.siteBase || window.location.hostname || "",
    });
  }

  function createBlankImageData(ctx, width, height) {
    const safeWidth = Math.max(1, toPositiveInt(width, toPositiveInt(ctx?.canvas?.width, 1)) || 1);
    const safeHeight = Math.max(1, toPositiveInt(height, toPositiveInt(ctx?.canvas?.height, 1)) || 1);

    if (typeof window.ImageData === "function") {
      return new window.ImageData(safeWidth, safeHeight);
    }
    if (ctx && typeof ctx.createImageData === "function") {
      return ctx.createImageData(safeWidth, safeHeight);
    }
    return {
      data: new Uint8ClampedArray(safeWidth * safeHeight * 4),
      width: safeWidth,
      height: safeHeight,
    };
  }

  function clearReadPixelsTarget(args) {
    for (let index = args.length - 1; index >= 0; index -= 1) {
      const candidate = args[index];
      if (!ArrayBuffer.isView(candidate)) continue;
      if (typeof candidate.fill === "function") {
        candidate.fill(0);
        return;
      }
      try {
        new Uint8Array(candidate.buffer, candidate.byteOffset, candidate.byteLength).fill(0);
      } catch {
        // Best effort only.
      }
      return;
    }
  }

  function buildGeolocationDetails(method, options, success, error) {
    const config = options && typeof options === "object" ? options : {};
    return {
      method,
      requestedHighAccuracy: config.enableHighAccuracy === true,
      timeoutMs: toNonNegativeInt(config.timeout),
      maximumAgeMs: toNonNegativeInt(config.maximumAge),
      hasSuccessCallback: typeof success === "function",
      hasErrorCallback: typeof error === "function",
    };
  }

  function sanitizeMimeType(raw) {
    const value = String(raw || "").trim().toLowerCase();
    if (!value) return null;
    return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(value) ? value : null;
  }

  function collectClipboardMimeTypes(items) {
    if (!Array.isArray(items)) return [];
    const out = [];
    const seen = new Set();
    for (const item of items) {
      const itemTypes = Array.isArray(item?.types) ? item.types : [];
      for (const rawType of itemTypes) {
        const type = sanitizeMimeType(rawType);
        if (!type || seen.has(type)) continue;
        seen.add(type);
        out.push(type);
        if (out.length >= MAX_CLIPBOARD_MIME_TYPES) return out;
      }
    }
    return out;
  }

  function maybeWarnClipboardAccess(method, accessType, details) {
    const decision = getClipboardGateDecision(accessType);
    if (decision.gateOutcome !== "warned") return;

    const key = buildBurstKey("api.clipboard.warn", [
      method,
      accessType,
      String(details.itemCount ?? ""),
      Array.isArray(details.mimeTypes) ? details.mimeTypes.join(",") : "",
      String(decision.policyAction),
    ]);
    const now = Date.now();
    const lastWarnTs = clipboardWarnMap.get(key) || 0;
    if ((now - lastWarnTs) < WARN_THROTTLE_MS) return;

    clipboardWarnMap.set(key, now);
    console.warn("[VPT] Clipboard access allowed with warning", {
      method,
      accessType,
      itemCount: typeof details.itemCount === "number" ? details.itemCount : undefined,
      mimeTypes: Array.isArray(details.mimeTypes) ? details.mimeTypes : [],
      site: clipboardGateState.siteBase || window.location.hostname || "",
    });
  }

  function recordClipboardSignal(method, details = {}) {
    const cleanMethod = String(method || "").trim();
    if (!cleanMethod) return;
    const accessType = cleanMethod.startsWith("write") ? "write" : "read";
    const decision = getClipboardGateDecision(accessType);
    const payload = {
      method: cleanMethod,
      accessType,
      itemCount: toNonNegativeInt(details.itemCount),
      mimeTypes: Array.isArray(details.mimeTypes) ? details.mimeTypes.slice(0, MAX_CLIPBOARD_MIME_TYPES) : [],
      gateOutcome: decision.gateOutcome,
      gateAction: decision.policyAction,
      policyReady: decision.policyReady !== false,
      trustedSite: clipboardGateState.trustedSite,
      frameScope: clipboardGateState.frameScope,
      siteBase: clipboardGateState.siteBase || undefined,
    };

    maybeWarnClipboardAccess(cleanMethod, accessType, payload);

    const key = buildBurstKey("api.clipboard.activity", [
      cleanMethod,
      accessType,
      String(payload.itemCount ?? ""),
      payload.mimeTypes.join(","),
      decision.policyAction,
      decision.gateOutcome,
    ]);
    recordBurst("api.clipboard.activity", payload, key);
    return decision;
  }

  function createBlockedClipboardError() {
    if (typeof window.DOMException === "function") {
      return new window.DOMException(
        "Blocked by Visual Privacy Toolkit Clipboard policy",
        "NotAllowedError"
      );
    }
    const error = new Error("Blocked by Visual Privacy Toolkit Clipboard policy");
    error.name = "NotAllowedError";
    return error;
  }

  function recordGeolocationSignal(method, options, success, error) {
    const cleanMethod = String(method || "").trim();
    if (!cleanMethod) return;
    const decision = getGeolocationGateDecision();
    const payload = {
      ...buildGeolocationDetails(cleanMethod, options, success, error),
      gateOutcome: decision.gateOutcome,
      gateAction: decision.policyAction,
      policyReady: decision.policyReady !== false,
      trustedSite: geolocationGateState.trustedSite,
      frameScope: geolocationGateState.frameScope,
      siteBase: geolocationGateState.siteBase || undefined,
    };

    if (decision.gateOutcome === "warned") {
      const key = buildBurstKey("api.geolocation.warn", [
        cleanMethod,
        String(payload.requestedHighAccuracy),
        String(payload.timeoutMs ?? ""),
        String(payload.maximumAgeMs ?? ""),
      ]);
      const now = Date.now();
      const lastWarnTs = geolocationWarnMap.get(key) || 0;
      if ((now - lastWarnTs) >= WARN_THROTTLE_MS) {
        geolocationWarnMap.set(key, now);
        console.warn("[VPT] Geolocation request allowed with warning", {
          method: cleanMethod,
          requestedHighAccuracy: payload.requestedHighAccuracy,
          timeoutMs: payload.timeoutMs,
          maximumAgeMs: payload.maximumAgeMs,
          site: geolocationGateState.siteBase || window.location.hostname || "",
        });
      }
    }

    const key = buildBurstKey("api.geolocation.activity", [
      cleanMethod,
      String(payload.requestedHighAccuracy),
      String(payload.timeoutMs ?? ""),
      String(payload.maximumAgeMs ?? ""),
      decision.policyAction,
      decision.gateOutcome,
    ]);
    recordBurst("api.geolocation.activity", payload, key);
  }

  function createBlockedGeolocationError() {
    return {
      code: 1,
      message: "Blocked by Visual Privacy Toolkit Geolocation policy",
      PERMISSION_DENIED: 1,
      POSITION_UNAVAILABLE: 2,
      TIMEOUT: 3,
    };
  }

  function notifyBlockedGeolocation(errorCallback) {
    if (typeof errorCallback !== "function") return;
    const error = createBlockedGeolocationError();
    setTimeout(() => {
      try {
        errorCallback(error);
      } catch {
        // Ignore callback failures.
      }
    }, 0);
  }

  function normalizeMessageData(data) {
    return data && typeof data === "object" ? data : null;
  }

  window.addEventListener("message", (event) => {
    const data = normalizeMessageData(event.data);
    if (!data) return;
    if (
      data.source !== GATE_SOURCE_TAG
      || (data.type !== "api_gate_state" && data.type !== "canvas_gate_state")
    ) {
      return;
    }
    applyApiGateState(data.payload);
  });

  function getPcMeta(pc) {
    if (!pc || typeof pc !== "object") return { stunTurnHostnames: [] };
    const meta = webrtcMeta.get(pc);
    if (!meta) return { stunTurnHostnames: [] };
    return {
      stunTurnHostnames: Array.from(meta.stunTurnHostnames).slice(0, MAX_HOSTNAMES),
    };
  }

  function addPcHostnames(pc, hostnames) {
    if (!pc || typeof pc !== "object") return;
    if (!Array.isArray(hostnames) || !hostnames.length) return;

    let meta = webrtcMeta.get(pc);
    if (!meta) {
      meta = { stunTurnHostnames: new Set() };
      webrtcMeta.set(pc, meta);
    }

    for (const host of hostnames) {
      const sanitized = sanitizeHostname(host);
      if (!sanitized) continue;
      meta.stunTurnHostnames.add(sanitized);
      if (meta.stunTurnHostnames.size >= MAX_HOSTNAMES) break;
    }
  }

  function maybeWarnWebrtc(action, payload) {
    const decision = getWebrtcGateDecision();
    if (decision.gateOutcome !== "warned") return;

    const key = buildBurstKey("api.webrtc.warn", [
      action,
      String(payload.state || ""),
      String(payload.offerType || ""),
      String(payload.candidateType || ""),
    ]);
    const now = Date.now();
    const lastWarnTs = webrtcWarnMap.get(key) || 0;
    if ((now - lastWarnTs) < WARN_THROTTLE_MS) return;

    webrtcWarnMap.set(key, now);
    console.warn("[VPT] WebRTC activity allowed with warning", {
      action,
      state: payload.state || undefined,
      offerType: payload.offerType || undefined,
      candidateType: payload.candidateType || undefined,
      stunTurnHostnames: Array.isArray(payload.stunTurnHostnames) ? payload.stunTurnHostnames : [],
      site: webrtcGateState.siteBase || window.location.hostname || "",
    });
  }

  function recordWebrtcSignal(action, details = {}) {
    const cleanAction = String(action || "").trim();
    if (!cleanAction) return;
    const decision = getWebrtcGateDecision();
    const payload = {
      action: cleanAction,
      gateOutcome: decision.gateOutcome,
      gateAction: decision.policyAction,
      trustedSite: webrtcGateState.trustedSite,
      frameScope: webrtcGateState.frameScope,
      siteBase: webrtcGateState.siteBase || undefined,
      ...details,
    };
    maybeWarnWebrtc(cleanAction, payload);

    const keyParts = [
      cleanAction,
      String(payload.state || ""),
      String(payload.offerType || ""),
      String(payload.candidateType || ""),
      Array.isArray(payload.stunTurnHostnames) ? payload.stunTurnHostnames.join(",") : "",
      decision.policyAction,
      decision.gateOutcome,
    ];
    const key = buildBurstKey("api.webrtc.activity", keyParts);
    recordBurst("api.webrtc.activity", payload, key);
  }

  function patchMethod(proto, methodName, wrapFn) {
    if (!proto) return;
    const original = proto[methodName];
    if (typeof original !== "function") return;
    if (original[PATCHED_FLAG]) return;

    const wrapped = function vptPatchedMethod(...args) {
      return wrapFn.call(this, original, args);
    };
    wrapped[PATCHED_FLAG] = true;
    proto[methodName] = wrapped;
  }

  function patchCanvasApis() {
    patchMethod(window.HTMLCanvasElement && window.HTMLCanvasElement.prototype, "getContext", function wrapGetContext(original, args) {
      const result = original.apply(this, args);
      try {
        const type = normalizeContextType(args[0]);
        if (type !== "unknown") {
          canvasContextByElement.set(this, type);
        }
      } catch {
        // Ignore instrumentation failures.
      }
      return result;
    });

    patchMethod(window.CanvasRenderingContext2D && window.CanvasRenderingContext2D.prototype, "getImageData", function wrapGetImageData(original, args) {
      const width = toPositiveInt(args[2], toPositiveInt(this?.canvas?.width));
      const height = toPositiveInt(args[3], toPositiveInt(this?.canvas?.height));
      const decision = getCanvasGateDecision();
      if (decision.shouldBlock) {
        try {
          recordCanvasSignal("getImageData", "2d", width, height);
        } catch {
          // Ignore instrumentation failures.
        }
        return createBlankImageData(this, width, height);
      }

      const result = original.apply(this, args);
      try {
        maybeWarnCanvasReadback("getImageData", "2d", width, height);
        recordCanvasSignal("getImageData", "2d", width, height);
      } catch {
        // Ignore instrumentation failures.
      }
      return result;
    });

    patchMethod(window.HTMLCanvasElement && window.HTMLCanvasElement.prototype, "toDataURL", function wrapToDataUrl(original, args) {
      const contextType = normalizeContextType(canvasContextByElement.get(this));
      const width = toPositiveInt(this?.width);
      const height = toPositiveInt(this?.height);
      const decision = getCanvasGateDecision();
      if (decision.shouldBlock) {
        try {
          recordCanvasSignal("toDataURL", contextType, width, height);
        } catch {
          // Ignore instrumentation failures.
        }
        return "data:,";
      }

      const result = original.apply(this, args);
      try {
        maybeWarnCanvasReadback("toDataURL", contextType, width, height);
        recordCanvasSignal("toDataURL", contextType, width, height);
      } catch {
        // Ignore instrumentation failures.
      }
      return result;
    });

    patchMethod(window.HTMLCanvasElement && window.HTMLCanvasElement.prototype, "toBlob", function wrapToBlob(original, args) {
      const contextType = normalizeContextType(canvasContextByElement.get(this));
      const width = toPositiveInt(this?.width);
      const height = toPositiveInt(this?.height);
      const decision = getCanvasGateDecision();
      if (decision.shouldBlock) {
        try {
          recordCanvasSignal("toBlob", contextType, width, height);
        } catch {
          // Ignore instrumentation failures.
        }
        const callback = typeof args[0] === "function" ? args[0] : null;
        if (callback) {
          setTimeout(() => {
            try {
              callback(null);
            } catch {
              // Ignore callback failures.
            }
          }, 0);
        }
        return undefined;
      }

      const result = original.apply(this, args);
      try {
        maybeWarnCanvasReadback("toBlob", contextType, width, height);
        recordCanvasSignal("toBlob", contextType, width, height);
      } catch {
        // Ignore instrumentation failures.
      }
      return result;
    });

    const wrapReadPixels = function wrapReadPixels(original, args, contextType) {
      const width = toPositiveInt(args[2], toPositiveInt(this?.drawingBufferWidth));
      const height = toPositiveInt(args[3], toPositiveInt(this?.drawingBufferHeight));
      const decision = getCanvasGateDecision();
      if (decision.shouldBlock) {
        try {
          clearReadPixelsTarget(args);
          recordCanvasSignal("readPixels", contextType, width, height);
        } catch {
          // Ignore instrumentation failures.
        }
        return undefined;
      }

      const result = original.apply(this, args);
      try {
        maybeWarnCanvasReadback("readPixels", contextType, width, height);
        recordCanvasSignal("readPixels", contextType, width, height);
      } catch {
        // Ignore instrumentation failures.
      }
      return result;
    };

    patchMethod(window.WebGLRenderingContext && window.WebGLRenderingContext.prototype, "readPixels", function wrapWebGlReadPixels(original, args) {
      return wrapReadPixels.call(this, original, args, "webgl");
    });

    patchMethod(window.WebGL2RenderingContext && window.WebGL2RenderingContext.prototype, "readPixels", function wrapWebGl2ReadPixels(original, args) {
      return wrapReadPixels.call(this, original, args, "webgl2");
    });
  }

  function patchGeolocationApis() {
    const geolocation = window.navigator && window.navigator.geolocation;
    if (!geolocation || typeof geolocation !== "object") return;

    patchMethod(geolocation, "getCurrentPosition", function wrapGetCurrentPosition(original, args) {
      const success = args[0];
      const error = args[1];
      const options = args[2];
      const decision = getGeolocationGateDecision();

      try {
        recordGeolocationSignal("getCurrentPosition", options, success, error);
      } catch {
        // Ignore instrumentation failures.
      }

      if (decision.shouldBlock) {
        notifyBlockedGeolocation(error);
        return undefined;
      }

      return original.apply(this, args);
    });

    patchMethod(geolocation, "watchPosition", function wrapWatchPosition(original, args) {
      const success = args[0];
      const error = args[1];
      const options = args[2];
      const decision = getGeolocationGateDecision();

      try {
        recordGeolocationSignal("watchPosition", options, success, error);
      } catch {
        // Ignore instrumentation failures.
      }

      if (decision.shouldBlock) {
        const blockedId = nextBlockedWatchId;
        nextBlockedWatchId -= 1;
        blockedWatchIds.add(blockedId);
        notifyBlockedGeolocation(error);
        return blockedId;
      }

      return original.apply(this, args);
    });

    patchMethod(geolocation, "clearWatch", function wrapClearWatch(original, args) {
      const watchId = Number(args[0]);
      if (Number.isFinite(watchId) && blockedWatchIds.has(watchId)) {
        blockedWatchIds.delete(watchId);
        return undefined;
      }
      return original.apply(this, args);
    });
  }

  function patchClipboardApis() {
    const clipboardTarget = (window.Clipboard && window.Clipboard.prototype)
      || (window.navigator && window.navigator.clipboard);
    if (!clipboardTarget) return;

    patchMethod(clipboardTarget, "readText", function wrapReadText(original, args) {
      const decision = recordClipboardSignal("readText");
      if (decision?.shouldBlock) {
        return Promise.reject(createBlockedClipboardError());
      }
      return original.apply(this, args);
    });

    patchMethod(clipboardTarget, "read", function wrapRead(original, args) {
      const decision = recordClipboardSignal("read");
      if (decision?.shouldBlock) {
        return Promise.reject(createBlockedClipboardError());
      }
      return original.apply(this, args);
    });

    patchMethod(clipboardTarget, "writeText", function wrapWriteText(original, args) {
      recordClipboardSignal("writeText");
      return original.apply(this, args);
    });

    patchMethod(clipboardTarget, "write", function wrapWrite(original, args) {
      const items = Array.isArray(args[0]) ? args[0].slice(0, MAX_CLIPBOARD_ITEMS) : [];
      recordClipboardSignal("write", {
        itemCount: items.length,
        mimeTypes: collectClipboardMimeTypes(items),
      });
      return original.apply(this, args);
    });
  }

  function attachPeerConnectionListeners(pc) {
    if (!pc || typeof pc.addEventListener !== "function") return;

    try {
      pc.addEventListener("icegatheringstatechange", () => {
        const meta = getPcMeta(pc);
        recordWebrtcSignal("ice_gathering_state", {
          state: String(pc.iceGatheringState || "unknown"),
          stunTurnHostnames: meta.stunTurnHostnames,
        });
      });
    } catch {
      // Ignore listener registration failures.
    }

    try {
      pc.addEventListener("icecandidate", (ev) => {
        const candidate = ev && ev.candidate ? ev.candidate : null;
        const candidateHost = parseIceHostname(candidate?.url);
        if (candidateHost) {
          addPcHostnames(pc, [candidateHost]);
        }
        const meta = getPcMeta(pc);
        recordWebrtcSignal("ice_candidate_activity", {
          state: candidate ? "candidate" : "complete",
          candidateType: candidate?.type || undefined,
          stunTurnHostnames: meta.stunTurnHostnames,
        });
      });
    } catch {
      // Ignore listener registration failures.
    }
  }

  function patchWebrtcApis() {
    const NativePeerConnection = window.RTCPeerConnection;
    if (typeof NativePeerConnection !== "function") return;

    function createBlockedPeerConnectionError() {
      if (typeof window.DOMException === "function") {
        return new window.DOMException(
          "Blocked by Visual Privacy Toolkit WebRTC policy",
          "NotAllowedError"
        );
      }
      const error = new Error("Blocked by Visual Privacy Toolkit WebRTC policy");
      error.name = "NotAllowedError";
      return error;
    }

    const WrappedPeerConnection = function VptWrappedPeerConnection(...args) {
      const hostnames = extractIceHostnames(args[0]);
      const decision = getWebrtcGateDecision();
      if (decision.shouldBlock) {
        try {
          recordWebrtcSignal("peer_connection_created", {
            state: "blocked",
            stunTurnHostnames: hostnames,
          });
        } catch {
          // Ignore instrumentation failures.
        }
        throw createBlockedPeerConnectionError();
      }

      const pc = new NativePeerConnection(...args);

      try {
        addPcHostnames(pc, hostnames);
        recordWebrtcSignal("peer_connection_created", {
          state: String(pc.iceGatheringState || "new"),
          stunTurnHostnames: hostnames,
        });
      } catch {
        // Ignore instrumentation failures.
      }

      attachPeerConnectionListeners(pc);
      return pc;
    };

    WrappedPeerConnection.prototype = NativePeerConnection.prototype;
    Object.setPrototypeOf(WrappedPeerConnection, NativePeerConnection);
    window.RTCPeerConnection = WrappedPeerConnection;

    patchMethod(NativePeerConnection.prototype, "createOffer", function wrapCreateOffer(original, args) {
      recordWebrtcSignal("create_offer_called", getPcMeta(this));

      const result = original.apply(this, args);
      if (!result || typeof result.then !== "function") {
        return result;
      }

      return result.then((description) => {
        if (description && description.type === "offer") {
          recordWebrtcSignal("offer_created", {
            ...getPcMeta(this),
            offerType: "offer",
          });
        }
        return description;
      });
    });

    patchMethod(NativePeerConnection.prototype, "setLocalDescription", function wrapSetLocalDescription(original, args) {
      const description = args[0] || this.localDescription || null;
      const offerType = description && typeof description.type === "string" ? description.type : "";
      if (offerType === "offer") {
        recordWebrtcSignal("set_local_description_offer", {
          ...getPcMeta(this),
          offerType: "offer",
        });
      }
      return original.apply(this, args);
    });

    patchMethod(NativePeerConnection.prototype, "setConfiguration", function wrapSetConfiguration(original, args) {
      const config = args[0] || {};
      const hostnames = extractIceHostnames(config);
      addPcHostnames(this, hostnames);
      if (hostnames.length) {
        recordWebrtcSignal("set_configuration", {
          ...getPcMeta(this),
          stunTurnHostnames: getPcMeta(this).stunTurnHostnames,
        });
      }
      return original.apply(this, args);
    });
  }

  try {
    publishApiGateDebugState();
    requestApiGateState();
    patchCanvasApis();
    patchClipboardApis();
    patchGeolocationApis();
    patchWebrtcApis();
  } catch {
    // Never block page execution on instrumentation issues.
  }
})();
