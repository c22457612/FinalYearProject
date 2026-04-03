const test = require("node:test");
const assert = require("node:assert/strict");

const floatingStatusShared = require("../floating-status-shared.js");

test("buildFloatingStatusSummary counts only current-site network and API events", () => {
  const summary = floatingStatusShared.buildFloatingStatusSummary({
    siteBase: "example.com",
    events: [
      { kind: "network.observed", site: "example.com" },
      { kind: "network.blocked", site: "example.com" },
      { kind: "cookies.snapshot", site: "example.com" },
      {
        kind: "api.canvas.activity",
        site: "example.com",
        data: { surfaceDetail: "canvas", gateOutcome: "observed" },
      },
      {
        kind: "api.clipboard.activity",
        site: "example.com",
        data: { surfaceDetail: "clipboard", gateOutcome: "blocked" },
      },
      {
        kind: "api.geolocation.activity",
        site: "example.com",
        data: { surfaceDetail: "geolocation", mitigationStatus: "allowed" },
      },
      {
        kind: "api.webrtc.activity",
        site: "other.com",
        data: { surfaceDetail: "webrtc", gateOutcome: "observed" },
      },
    ],
  });

  assert.equal(summary.observedCount, 3);
  assert.equal(summary.blockedCount, 2);
  assert.deepEqual(summary.apiSurfaces, ["canvas", "clipboard", "geolocation"]);
  assert.equal(summary.apiDisplay, "Canvas \u00b7 Clipboard \u00b7 Geolocation");
});

test("formatApiSurfaceDisplay bounds overflow and falls back to None", () => {
  assert.equal(floatingStatusShared.formatApiSurfaceDisplay([]), "None");
  assert.equal(
    floatingStatusShared.formatApiSurfaceDisplay(["canvas", "clipboard", "geolocation", "webrtc"]),
    "Canvas \u00b7 Clipboard \u00b7 +2"
  );
});

test("buildFloatingStatusSummary treats warned and trusted-allowed API events as observed", () => {
  const summary = floatingStatusShared.buildFloatingStatusSummary({
    siteBase: "example.com",
    events: [
      {
        kind: "api.clipboard.activity",
        site: "example.com",
        data: { surfaceDetail: "clipboard", gateOutcome: "warned" },
      },
      {
        kind: "api.webrtc.activity",
        topLevelUrl: "https://www.example.com/page",
        data: { surfaceDetail: "webrtc", gateOutcome: "trusted_allowed" },
      },
      {
        kind: "api.canvas.activity",
        data: { siteBase: "example.com", surfaceDetail: "canvas", mitigationStatus: "blocked" },
      },
    ],
  });

  assert.equal(summary.observedCount, 2);
  assert.equal(summary.blockedCount, 1);
  assert.deepEqual(summary.apiSurfaces, ["canvas", "clipboard", "webrtc"]);
});
