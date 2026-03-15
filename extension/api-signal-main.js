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

  const burstMap = new Map(); // key -> { kind, payload, count, firstTs, lastTs, timerId }
  const canvasContextByElement = new WeakMap(); // canvas -> context type
  const webrtcMeta = new WeakMap(); // pc -> { stunTurnHostnames:Set<string> }
  const canvasWarnMap = new Map(); // key -> lastWarnTs
  const canvasGateState = {
    canvasAction: "observe",
    trustedSite: false,
    siteBase: "",
    frameScope: "top_frame",
    ready: false,
  };

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

  function applyCanvasGateState(payload) {
    if (!payload || typeof payload !== "object") return;
    canvasGateState.canvasAction = normalizeCanvasGateAction(payload.canvasAction);
    canvasGateState.trustedSite = payload.trustedSite === true;
    canvasGateState.siteBase = String(payload.siteBase || "").trim().toLowerCase();
    canvasGateState.frameScope = payload.frameScope === "top_frame" ? "top_frame" : "top_frame";
    canvasGateState.ready = true;
  }

  function requestCanvasGateState() {
    window.postMessage(
      {
        source: GATE_SOURCE_TAG,
        type: "canvas_gate_state_request",
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

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const data = event.data;
    if (!data || typeof data !== "object") return;
    if (data.source !== GATE_SOURCE_TAG || data.type !== "canvas_gate_state") return;
    applyCanvasGateState(data.payload);
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

  function recordWebrtcSignal(action, details = {}) {
    const cleanAction = String(action || "").trim();
    if (!cleanAction) return;

    const keyParts = [
      cleanAction,
      String(details.state || ""),
      String(details.offerType || ""),
      String(details.candidateType || ""),
      Array.isArray(details.stunTurnHostnames) ? details.stunTurnHostnames.join(",") : "",
    ];
    const key = buildBurstKey("api.webrtc.activity", keyParts);
    recordBurst("api.webrtc.activity", { action: cleanAction, ...details }, key);
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
        recordCanvasSignal(
          "toDataURL",
          contextType,
          width,
          height
        );
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
        recordCanvasSignal(
          "toBlob",
          contextType,
          width,
          height
        );
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

    const WrappedPeerConnection = function VptWrappedPeerConnection(...args) {
      const pc = new NativePeerConnection(...args);

      try {
        const hostnames = extractIceHostnames(args[0]);
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
    requestCanvasGateState();
    patchCanvasApis();
    patchWebrtcApis();
  } catch {
    // Never block page execution on instrumentation issues.
  }
})();
