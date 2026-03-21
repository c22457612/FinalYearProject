(function initVptCanvasBootstrap() {
  if (window.__vptCanvasBootstrapInstalled) return;
  window.__vptCanvasBootstrapInstalled = true;

  const SOURCE_TAG = "vpt_api_signal";
  const PATCHED_FLAG = "__vpt_api_patched";
  const BURST_WINDOW_MS = 1200;
  const BURST_FLUSH_COUNT = 10;
  const WARN_THROTTLE_MS = 5000;
  const PATCH_RETRY_DELAYS_MS = [0, 25, 75, 150, 400, 1000, 2000];
  const nativeDefineProperty = Object.defineProperty;

  const burstMap = new Map();
  const canvasContextByElement = new WeakMap();
  const canvasWarnMap = new Map();
  const prototypeStates = new WeakMap();

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
    const next = String(value || "").trim().toLowerCase();
    return next === "warn" || next === "block" || next === "allow_trusted" ? next : "observe";
  }

  function getCanvasGateSnapshot() {
    try {
      const snapshot = typeof window.__VPTGetApiGateState === "function"
        ? window.__VPTGetApiGateState()
        : (window.__VPTApiGateStateDebug || {});
      const trustedSite = snapshot?.trustedSite === true;
      const policyAction = normalizeCanvasGateAction(snapshot?.canvasAction);
      const siteBase = String(snapshot?.siteBase || window.location.hostname || "").trim().toLowerCase();
      const frameScope = snapshot?.frameScope === "top_frame" ? "top_frame" : "top_frame";

      if (policyAction === "warn") {
        return { policyAction, gateOutcome: "warned", shouldBlock: false, trustedSite, siteBase, frameScope };
      }
      if (policyAction === "block") {
        return { policyAction, gateOutcome: "blocked", shouldBlock: true, trustedSite, siteBase, frameScope };
      }
      if (policyAction === "allow_trusted") {
        return trustedSite
          ? { policyAction, gateOutcome: "trusted_allowed", shouldBlock: false, trustedSite, siteBase, frameScope }
          : { policyAction, gateOutcome: "blocked", shouldBlock: true, trustedSite, siteBase, frameScope };
      }
      return { policyAction, gateOutcome: "observed", shouldBlock: false, trustedSite, siteBase, frameScope };
    } catch {
      return {
        policyAction: "observe",
        gateOutcome: "observed",
        shouldBlock: false,
        trustedSite: false,
        siteBase: String(window.location.hostname || "").trim().toLowerCase(),
        frameScope: "top_frame",
      };
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
    const decision = getCanvasGateSnapshot();
    const payload = {
      operation,
      contextType,
      width: toPositiveInt(width),
      height: toPositiveInt(height),
      gateOutcome: decision.gateOutcome,
      gateAction: decision.policyAction,
      trustedSite: decision.trustedSite,
      frameScope: decision.frameScope,
      siteBase: decision.siteBase || undefined,
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
    return decision;
  }

  function maybeWarnCanvasReadback(operation, contextType, width, height) {
    const decision = getCanvasGateSnapshot();
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
      site: decision.siteBase || window.location.hostname || "",
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

  function getPrototypeState(proto) {
    let state = prototypeStates.get(proto);
    if (!state) {
      state = new Map();
      prototypeStates.set(proto, state);
    }
    return state;
  }

  function isPatchedFunction(value) {
    return typeof value === "function" && value[PATCHED_FLAG] === true;
  }

  function markPatchedFunction(fn) {
    if (typeof fn !== "function") return fn;
    try {
      nativeDefineProperty(fn, PATCHED_FLAG, {
        value: true,
        configurable: true,
        enumerable: false,
        writable: false,
      });
    } catch {
      try {
        fn[PATCHED_FLAG] = true;
      } catch {
        // Ignore marker failures.
      }
    }
    return fn;
  }

  function readDescriptorValue(proto, methodName, descriptor) {
    if (!descriptor) return proto?.[methodName];
    if (Object.prototype.hasOwnProperty.call(descriptor, "value")) return descriptor.value;
    try {
      return proto?.[methodName];
    } catch {
      return null;
    }
  }

  function buildWrappedFunction(original, wrapFn) {
    if (typeof original !== "function") return original;
    if (isPatchedFunction(original)) return original;
    const wrapped = function vptPatchedMethod(...args) {
      return wrapFn.call(this, original, args);
    };
    return markPatchedFunction(wrapped);
  }

  function patchMethod(proto, methodName, wrapFn) {
    if (!proto || typeof methodName !== "string" || typeof wrapFn !== "function") return false;

    const descriptor = Object.getOwnPropertyDescriptor(proto, methodName);
    const currentValue = readDescriptorValue(proto, methodName, descriptor);
    if (typeof currentValue !== "function") return false;
    if (isPatchedFunction(currentValue)) return true;

    const enumerable = descriptor?.enumerable === true;
    let currentWrapped = buildWrappedFunction(currentValue, wrapFn);

    try {
      nativeDefineProperty(proto, methodName, {
        configurable: true,
        enumerable,
        get() {
          return currentWrapped;
        },
        set(nextValue) {
          currentWrapped = buildWrappedFunction(nextValue, wrapFn);
        },
      });
    } catch {
      try {
        proto[methodName] = currentWrapped;
        return isPatchedFunction(proto[methodName]);
      } catch {
        return false;
      }
    }

    getPrototypeState(proto).set(methodName, { wrapFn });
    return true;
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
      const decision = recordCanvasSignal("getImageData", "2d", width, height);
      if (decision.shouldBlock) {
        return createBlankImageData(this, width, height);
      }

      const result = original.apply(this, args);
      try {
        maybeWarnCanvasReadback("getImageData", "2d", width, height);
      } catch {
        // Ignore instrumentation failures.
      }
      return result;
    });

    patchMethod(window.HTMLCanvasElement && window.HTMLCanvasElement.prototype, "toDataURL", function wrapToDataUrl(original, args) {
      const contextType = normalizeContextType(canvasContextByElement.get(this));
      const width = toPositiveInt(this?.width);
      const height = toPositiveInt(this?.height);
      const decision = recordCanvasSignal("toDataURL", contextType, width, height);
      if (decision.shouldBlock) {
        return "data:,";
      }

      const result = original.apply(this, args);
      try {
        maybeWarnCanvasReadback("toDataURL", contextType, width, height);
      } catch {
        // Ignore instrumentation failures.
      }
      return result;
    });

    patchMethod(window.HTMLCanvasElement && window.HTMLCanvasElement.prototype, "toBlob", function wrapToBlob(original, args) {
      const contextType = normalizeContextType(canvasContextByElement.get(this));
      const width = toPositiveInt(this?.width);
      const height = toPositiveInt(this?.height);
      const decision = recordCanvasSignal("toBlob", contextType, width, height);
      if (decision.shouldBlock) {
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
      } catch {
        // Ignore instrumentation failures.
      }
      return result;
    });
  }

  function schedulePatchRetries() {
    for (const delay of PATCH_RETRY_DELAYS_MS) {
      setTimeout(() => {
        try {
          patchCanvasApis();
        } catch {
          // Never block page execution on retries.
        }
      }, delay);
    }

    document.addEventListener("readystatechange", () => {
      try {
        patchCanvasApis();
      } catch {
        // Ignore retry failures.
      }
    }, { passive: true });
  }

  try {
    patchCanvasApis();
    schedulePatchRetries();
  } catch {
    // Never block page execution on bootstrap failures.
  }
})();
