(function initVptApiGateShared(globalScope) {
  const API = {};

  API.CONFIG_SOURCE_TAG = "vpt_api_gate";
  API.GATE_ACTIONS = Object.freeze(["observe", "warn", "block", "allow_trusted"]);
  API.GATE_OUTCOMES = Object.freeze(["observed", "warned", "blocked", "trusted_allowed"]);
  API.CANVAS_GATE_ACTIONS = API.GATE_ACTIONS;
  API.CANVAS_GATE_OUTCOMES = API.GATE_OUTCOMES;
  API.WEBRTC_GATE_ACTIONS = API.GATE_ACTIONS;
  API.WEBRTC_GATE_OUTCOMES = API.GATE_OUTCOMES;

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

  function normalizeWebrtcGateAction(value) {
    return normalizeApiGateAction(value);
  }

  function normalizeWebrtcGateOutcome(value) {
    return normalizeApiGateOutcome(value);
  }

  function normalizeApiGatePolicy(rawPolicy) {
    const policy = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {};
    return {
      canvas: normalizeApiGateAction(policy.canvas),
      webrtc: normalizeApiGateAction(policy.webrtc),
    };
  }

  function buildApiGateState({ apiGatePolicy, trusted, hostname } = {}) {
    const normalizedPolicy = normalizeApiGatePolicy(apiGatePolicy);
    const siteBase = toBaseDomain(hostname);
    const trustedList = Array.isArray(trusted) ? trusted : [];
    const trustedSet = new Set(
      trustedList
        .map((entry) => toBaseDomain(entry))
        .filter(Boolean)
    );

    return {
      canvasAction: normalizedPolicy.canvas,
      webrtcAction: normalizedPolicy.webrtc,
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

  API.toBaseDomain = toBaseDomain;
  API.normalizeApiGateAction = normalizeApiGateAction;
  API.normalizeApiGateOutcome = normalizeApiGateOutcome;
  API.normalizeCanvasGateAction = normalizeCanvasGateAction;
  API.normalizeCanvasGateOutcome = normalizeCanvasGateOutcome;
  API.normalizeWebrtcGateAction = normalizeWebrtcGateAction;
  API.normalizeWebrtcGateOutcome = normalizeWebrtcGateOutcome;
  API.normalizeApiGatePolicy = normalizeApiGatePolicy;
  API.buildApiGateState = buildApiGateState;
  API.buildCanvasGateState = buildCanvasGateState;
  API.buildWebrtcGateState = buildWebrtcGateState;
  API.deriveGateDecision = deriveGateDecision;
  API.deriveCanvasGateDecision = deriveCanvasGateDecision;
  API.deriveWebrtcGateDecision = deriveWebrtcGateDecision;

  globalScope.__VPTApiGateShared = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
