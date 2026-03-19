(function initVptApiGateShared(globalScope) {
  const API = {};

  API.CONFIG_SOURCE_TAG = "vpt_api_gate";
  API.GATE_ACTIONS = Object.freeze(["observe", "warn", "block", "allow_trusted"]);
  API.GATE_OUTCOMES = Object.freeze(["observed", "warned", "blocked", "trusted_allowed"]);
  API.CANVAS_GATE_ACTIONS = API.GATE_ACTIONS;
  API.CANVAS_GATE_OUTCOMES = API.GATE_OUTCOMES;
  API.CLIPBOARD_GATE_ACTIONS = API.GATE_ACTIONS;
  API.CLIPBOARD_GATE_OUTCOMES = API.GATE_OUTCOMES;
  API.WEBRTC_GATE_ACTIONS = API.GATE_ACTIONS;
  API.WEBRTC_GATE_OUTCOMES = API.GATE_OUTCOMES;
  API.GEOLOCATION_GATE_ACTIONS = API.GATE_ACTIONS;
  API.GEOLOCATION_GATE_OUTCOMES = API.GATE_OUTCOMES;
  API.CLIPBOARD_ACCESS_TYPES = Object.freeze(["read", "write"]);

  function toBaseDomain(host) {
    const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
    if (!parts.length) return "";
    if (parts.length <= 2) return parts.join(".");
    return parts.slice(-2).join(".");
  }

  function normalizeApiGateAction(value) {
    const next = String(value || "").trim().toLowerCase();
    return API.GATE_ACTIONS.includes(next) ? next : "observe";
  }

  function normalizeApiGateOutcome(value) {
    const next = String(value || "").trim().toLowerCase();
    return API.GATE_OUTCOMES.includes(next) ? next : "observed";
  }

  function normalizeCanvasGateAction(value) {
    return normalizeApiGateAction(value);
  }

  function normalizeCanvasGateOutcome(value) {
    return normalizeApiGateOutcome(value);
  }

  function normalizeClipboardGateAction(value) {
    return normalizeApiGateAction(value);
  }

  function normalizeClipboardGateOutcome(value) {
    return normalizeApiGateOutcome(value);
  }

  function normalizeWebrtcGateAction(value) {
    return normalizeApiGateAction(value);
  }

  function normalizeWebrtcGateOutcome(value) {
    return normalizeApiGateOutcome(value);
  }

  function normalizeGeolocationGateAction(value) {
    return normalizeApiGateAction(value);
  }

  function normalizeGeolocationGateOutcome(value) {
    return normalizeApiGateOutcome(value);
  }

  function normalizeClipboardAccessType(value) {
    const next = String(value || "").trim().toLowerCase();
    return next === "write" ? "write" : "read";
  }

  function normalizeApiGatePolicy(rawPolicy) {
    const policy = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {};
    return {
      canvas: normalizeApiGateAction(policy.canvas),
      clipboard: normalizeApiGateAction(policy.clipboard),
      webrtc: normalizeApiGateAction(policy.webrtc),
      geolocation: normalizeApiGateAction(policy.geolocation),
    };
  }

  function buildApiGateState({ apiGatePolicy, trusted, trustedSitesEnabled, hostname } = {}) {
    const normalizedPolicy = normalizeApiGatePolicy(apiGatePolicy);
    const siteBase = toBaseDomain(hostname);
    const trustEnabled = trustedSitesEnabled !== false;
    const trustedList = trustEnabled && Array.isArray(trusted) ? trusted : [];
    const trustedSet = new Set(
      trustedList
        .map((entry) => toBaseDomain(entry))
        .filter(Boolean)
    );

    return {
      canvasAction: normalizedPolicy.canvas,
      clipboardAction: normalizedPolicy.clipboard,
      webrtcAction: normalizedPolicy.webrtc,
      geolocationAction: normalizedPolicy.geolocation,
      trustedSite: Boolean(siteBase && trustedSet.has(siteBase)),
      siteBase,
      frameScope: "top_frame",
    };
  }

  function buildCanvasGateState(options = {}) {
    const state = buildApiGateState(options);
    return {
      canvasAction: state.canvasAction,
      trustedSite: state.trustedSite,
      siteBase: state.siteBase,
      frameScope: state.frameScope,
    };
  }

  function buildWebrtcGateState(options = {}) {
    const state = buildApiGateState(options);
    return {
      webrtcAction: state.webrtcAction,
      trustedSite: state.trustedSite,
      siteBase: state.siteBase,
      frameScope: state.frameScope,
    };
  }

  function buildGeolocationGateState(options = {}) {
    const state = buildApiGateState(options);
    return {
      geolocationAction: state.geolocationAction,
      trustedSite: state.trustedSite,
      siteBase: state.siteBase,
      frameScope: state.frameScope,
    };
  }

  function buildClipboardGateState(options = {}) {
    const state = buildApiGateState(options);
    return {
      clipboardAction: state.clipboardAction,
      trustedSite: state.trustedSite,
      siteBase: state.siteBase,
      frameScope: state.frameScope,
    };
  }

  function deriveGateDecision(surfaceAction, trustedSite) {
    const policyAction = normalizeApiGateAction(surfaceAction);
    if (policyAction === "warn") {
      return { policyAction, gateOutcome: "warned", shouldBlock: false };
    }
    if (policyAction === "block") {
      return { policyAction, gateOutcome: "blocked", shouldBlock: true };
    }
    if (policyAction === "allow_trusted") {
      if (trustedSite) {
        return { policyAction, gateOutcome: "trusted_allowed", shouldBlock: false };
      }
      return { policyAction, gateOutcome: "blocked", shouldBlock: true };
    }
    return { policyAction, gateOutcome: "observed", shouldBlock: false };
  }

  function deriveCanvasGateDecision(canvasAction, trustedSite) {
    return deriveGateDecision(canvasAction, trustedSite);
  }

  function deriveWebrtcGateDecision(webrtcAction, trustedSite) {
    return deriveGateDecision(webrtcAction, trustedSite);
  }

  function deriveGeolocationGateDecision(geolocationAction, trustedSite) {
    return deriveGateDecision(geolocationAction, trustedSite);
  }

  function deriveClipboardGateDecision(clipboardAction, trustedSite, accessType) {
    const policyAction = normalizeClipboardGateAction(clipboardAction);
    const normalizedAccessType = normalizeClipboardAccessType(accessType);

    if (policyAction === "warn") {
      return {
        policyAction,
        gateOutcome: "warned",
        shouldBlock: false,
        accessType: normalizedAccessType,
      };
    }
    if (policyAction === "block") {
      return normalizedAccessType === "write"
        ? {
          policyAction,
          gateOutcome: "warned",
          shouldBlock: false,
          accessType: normalizedAccessType,
        }
        : {
          policyAction,
          gateOutcome: "blocked",
          shouldBlock: true,
          accessType: normalizedAccessType,
        };
    }
    if (policyAction === "allow_trusted") {
      if (trustedSite) {
        return {
          policyAction,
          gateOutcome: "trusted_allowed",
          shouldBlock: false,
          accessType: normalizedAccessType,
        };
      }
      return normalizedAccessType === "write"
        ? {
          policyAction,
          gateOutcome: "warned",
          shouldBlock: false,
          accessType: normalizedAccessType,
        }
        : {
          policyAction,
          gateOutcome: "blocked",
          shouldBlock: true,
          accessType: normalizedAccessType,
        };
    }
    return {
      policyAction,
      gateOutcome: "observed",
      shouldBlock: false,
      accessType: normalizedAccessType,
    };
  }

  API.toBaseDomain = toBaseDomain;
  API.normalizeApiGateAction = normalizeApiGateAction;
  API.normalizeApiGateOutcome = normalizeApiGateOutcome;
  API.normalizeCanvasGateAction = normalizeCanvasGateAction;
  API.normalizeCanvasGateOutcome = normalizeCanvasGateOutcome;
  API.normalizeClipboardGateAction = normalizeClipboardGateAction;
  API.normalizeClipboardGateOutcome = normalizeClipboardGateOutcome;
  API.normalizeClipboardAccessType = normalizeClipboardAccessType;
  API.normalizeWebrtcGateAction = normalizeWebrtcGateAction;
  API.normalizeWebrtcGateOutcome = normalizeWebrtcGateOutcome;
  API.normalizeGeolocationGateAction = normalizeGeolocationGateAction;
  API.normalizeGeolocationGateOutcome = normalizeGeolocationGateOutcome;
  API.normalizeApiGatePolicy = normalizeApiGatePolicy;
  API.buildApiGateState = buildApiGateState;
  API.buildCanvasGateState = buildCanvasGateState;
  API.buildClipboardGateState = buildClipboardGateState;
  API.buildWebrtcGateState = buildWebrtcGateState;
  API.buildGeolocationGateState = buildGeolocationGateState;
  API.deriveGateDecision = deriveGateDecision;
  API.deriveCanvasGateDecision = deriveCanvasGateDecision;
  API.deriveClipboardGateDecision = deriveClipboardGateDecision;
  API.deriveWebrtcGateDecision = deriveWebrtcGateDecision;
  API.deriveGeolocationGateDecision = deriveGeolocationGateDecision;

  globalScope.__VPTApiGateShared = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
