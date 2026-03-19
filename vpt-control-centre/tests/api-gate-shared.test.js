const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildApiGateState,
  buildCanvasGateState,
  deriveCanvasGateDecision,
  deriveClipboardGateDecision,
  deriveGeolocationGateDecision,
  deriveWebrtcGateDecision,
  normalizeApiGatePolicy,
} = require("../../extension/api-gate-shared.js");

test("api gate shared defaults canvas policy to observe", () => {
  assert.deepEqual(normalizeApiGatePolicy(null), {
    canvas: "observe",
    clipboard: "observe",
    geolocation: "observe",
    webrtc: "observe",
  });
  assert.deepEqual(normalizeApiGatePolicy({ canvas: "warn", clipboard: "block", geolocation: "allow_trusted", webrtc: "block" }), {
    canvas: "warn",
    clipboard: "block",
    geolocation: "allow_trusted",
    webrtc: "block",
  });
  assert.deepEqual(normalizeApiGatePolicy({ canvas: "invalid", clipboard: "invalid", geolocation: "invalid", webrtc: "invalid" }), {
    canvas: "observe",
    clipboard: "observe",
    geolocation: "observe",
    webrtc: "observe",
  });
});

test("api gate shared derives trusted top-frame api state from storage snapshot", () => {
  const state = buildApiGateState({
    apiGatePolicy: { canvas: "allow_trusted", clipboard: "block", geolocation: "block", webrtc: "warn" },
    trusted: ["shop.example.com", "alpha.test"],
    hostname: "www.shop.example.com",
  });

  assert.deepEqual(state, {
    canvasAction: "allow_trusted",
    clipboardAction: "block",
    geolocationAction: "block",
    webrtcAction: "warn",
    trustedSite: true,
    siteBase: "example.com",
    frameScope: "top_frame",
  });
});

test("api gate shared ignores stored trusted sites when trusted sites are toggled off", () => {
  const state = buildApiGateState({
    apiGatePolicy: { canvas: "allow_trusted", clipboard: "block", geolocation: "block", webrtc: "warn" },
    trusted: ["shop.example.com", "alpha.test"],
    trustedSitesEnabled: false,
    hostname: "www.shop.example.com",
  });

  assert.deepEqual(state, {
    canvasAction: "allow_trusted",
    clipboardAction: "block",
    geolocationAction: "block",
    webrtcAction: "warn",
    trustedSite: false,
    siteBase: "example.com",
    frameScope: "top_frame",
  });
});

test("api gate shared derives trusted top-frame canvas state from storage snapshot", () => {
  const state = buildCanvasGateState({
    apiGatePolicy: { canvas: "allow_trusted", webrtc: "block" },
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

test("api gate shared hard-blocks clipboard reads under block", () => {
  assert.deepEqual(deriveClipboardGateDecision("block", false, "read"), {
    policyAction: "block",
    gateOutcome: "blocked",
    shouldBlock: true,
    accessType: "read",
  });
});

test("api gate shared softens clipboard writes under block into warned allow", () => {
  assert.deepEqual(deriveClipboardGateDecision("block", false, "write"), {
    policyAction: "block",
    gateOutcome: "warned",
    shouldBlock: false,
    accessType: "write",
  });
});

test("api gate shared allows clipboard access on trusted sites under allow_trusted", () => {
  assert.deepEqual(deriveClipboardGateDecision("allow_trusted", true, "read"), {
    policyAction: "allow_trusted",
    gateOutcome: "trusted_allowed",
    shouldBlock: false,
    accessType: "read",
  });
});

test("api gate shared maps webrtc warn policy to warned outcome", () => {
  assert.deepEqual(deriveWebrtcGateDecision("warn", false), {
    policyAction: "warn",
    gateOutcome: "warned",
    shouldBlock: false,
  });
});

test("api gate shared maps geolocation allow_trusted to blocked on untrusted sites", () => {
  assert.deepEqual(deriveGeolocationGateDecision("allow_trusted", false), {
    policyAction: "allow_trusted",
    gateOutcome: "blocked",
    shouldBlock: true,
  });
});
