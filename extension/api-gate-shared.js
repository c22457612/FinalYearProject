(function initVptApiGateShared(globalScope) {
  const API = {};

  API.CONFIG_SOURCE_TAG = "vpt_api_gate";
  API.CANVAS_GATE_ACTIONS = Object.freeze(["observe", "warn", "block", "allow_trusted"]);
  API.CANVAS_GATE_OUTCOMES = Object.freeze(["observed", "warned", "blocked", "trusted_allowed"]);

  function toBaseDomain(host) {
    const parts = String(host || "").toLowerCase().split(".").filter(Boolean);
    if (!parts.length) return "";
    if (parts.length <= 2) return parts.join(".");
    return parts.slice(-2).join(".");
  }

  function normalizeCanvasGateAction(value) {
    const next = String(value || "").trim().toLowerCase();
    return API.CANVAS_GATE_ACTIONS.includes(next) ? next : "observe";
  }

  function normalizeCanvasGateOutcome(value) {
    const next = String(value || "").trim().toLowerCase();
    return API.CANVAS_GATE_OUTCOMES.includes(next) ? next : "observed";
  }

  function normalizeApiGatePolicy(rawPolicy) {
    const policy = rawPolicy && typeof rawPolicy === "object" ? rawPolicy : {};
    return {
      canvas: normalizeCanvasGateAction(policy.canvas),
    };
  }

  function buildCanvasGateState({ apiGatePolicy, trusted, hostname } = {}) {
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
      trustedSite: Boolean(siteBase && trustedSet.has(siteBase)),
      siteBase,
      frameScope: "top_frame",
    };
  }

  function deriveCanvasGateDecision(canvasAction, trustedSite) {
    const policyAction = normalizeCanvasGateAction(canvasAction);
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

  API.toBaseDomain = toBaseDomain;
  API.normalizeCanvasGateAction = normalizeCanvasGateAction;
  API.normalizeCanvasGateOutcome = normalizeCanvasGateOutcome;
  API.normalizeApiGatePolicy = normalizeApiGatePolicy;
  API.buildCanvasGateState = buildCanvasGateState;
  API.deriveCanvasGateDecision = deriveCanvasGateDecision;

  globalScope.__VPTApiGateShared = API;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = API;
  }
})(typeof globalThis !== "undefined" ? globalThis : this);
