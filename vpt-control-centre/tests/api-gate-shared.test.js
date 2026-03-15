const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildCanvasGateState,
  deriveCanvasGateDecision,
  normalizeApiGatePolicy,
} = require("../../extension/api-gate-shared.js");

test("api gate shared defaults canvas policy to observe", () => {
  assert.deepEqual(normalizeApiGatePolicy(null), { canvas: "observe" });
  assert.deepEqual(normalizeApiGatePolicy({ canvas: "warn" }), { canvas: "warn" });
  assert.deepEqual(normalizeApiGatePolicy({ canvas: "invalid" }), { canvas: "observe" });
});

test("api gate shared derives trusted top-frame canvas state from storage snapshot", () => {
  const state = buildCanvasGateState({
    apiGatePolicy: { canvas: "allow_trusted" },
    trusted: ["shop.example.com", "alpha.test"],
    hostname: "www.shop.example.com",
  });

  assert.deepEqual(state, {
    canvasAction: "allow_trusted",
    trustedSite: true,
    siteBase: "example.com",
    frameScope: "top_frame",
  });
});

test("api gate shared maps allow_trusted to trusted_allowed on trusted sites", () => {
  assert.deepEqual(deriveCanvasGateDecision("allow_trusted", true), {
    policyAction: "allow_trusted",
    gateOutcome: "trusted_allowed",
    shouldBlock: false,
  });
});

test("api gate shared maps allow_trusted to blocked on untrusted sites", () => {
  assert.deepEqual(deriveCanvasGateDecision("allow_trusted", false), {
    policyAction: "allow_trusted",
    gateOutcome: "blocked",
    shouldBlock: true,
  });
});
