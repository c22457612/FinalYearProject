const test = require("node:test");
const assert = require("node:assert/strict");

const { buildEnrichmentRecord } = require("../enrichment");

test("network.blocked maps to policy_blocked with vendor classification", () => {
  const ev = {
    id: "evt-1",
    ts: 1700000000000,
    site: "shop.example.com",
    kind: "network.blocked",
    mode: "strict",
    source: "extension",
    data: {
      domain: "www.google-analytics.com",
      url: "https://www.google-analytics.com/g/collect",
      isThirdParty: true,
      resourceType: "xmlhttprequest",
      ruleId: 1001,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.enrichmentVersion, "v2");
  assert.equal(row.surface, "network");
  assert.equal(row.surfaceDetail, "network_request");
  assert.equal(row.privacyStatus, "policy_blocked");
  assert.equal(row.mitigationStatus, "blocked");
  assert.equal(row.signalType, "tracking_signal");
  assert.equal(row.vendorId, "google");
  assert.equal(row.vendorName, "Google");
  assert.equal(row.vendorFamily, "adtech-analytics");
  assert.equal(row.requestDomain, "google-analytics.com");
  assert.equal(row.isThirdParty, 1);
  assert.equal(row.patternId, "network.rule_blocked");
});

test("network.observed first-party maps to baseline classification", () => {
  const ev = {
    id: "evt-2",
    ts: 1700000001000,
    site: "stream.example.com",
    kind: "network.observed",
    mode: "moderate",
    source: "extension",
    data: {
      domain: "cdn.stream.example.com",
      url: "https://cdn.stream.example.com/app.js",
      isThirdParty: false,
      resourceType: "script",
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "network");
  assert.equal(row.privacyStatus, "baseline");
  assert.equal(row.mitigationStatus, "observed_only");
  assert.equal(row.signalType, "state_change");
  assert.equal(row.isThirdParty, 0);
  assert.equal(row.patternId, "network.first_party_observed");
});

test("cookies.snapshot treats aggregate third-party presence distinctly", () => {
  const ev = {
    id: "evt-3",
    ts: 1700000002000,
    site: "news.example.com",
    kind: "cookies.snapshot",
    mode: "power",
    source: "extension",
    data: {
      url: "https://news.example.com/",
      count: 8,
      thirdPartyCount: 3,
      cookies: [
        { name: "a", domain: ".news.example.com", isThirdParty: false },
        { name: "b", domain: ".doubleclick.net", isThirdParty: true },
        { name: "c", domain: ".doubleclick.net", isThirdParty: true },
      ],
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "cookies");
  assert.equal(row.surfaceDetail, "cookie_snapshot");
  assert.equal(row.privacyStatus, "signal_detected");
  assert.equal(row.mitigationStatus, "observed_only");
  assert.equal(row.signalType, "tracking_signal");
  assert.equal(row.patternId, "cookies.snapshot.third_party_present");
  assert.equal(row.requestDomain, "doubleclick.net");
  assert.equal(row.vendorId, "google");
  assert.equal(row.isThirdParty, 1);
});

test("cookies.snapshot first-party only maps to baseline aggregate", () => {
  const ev = {
    id: "evt-4",
    ts: 1700000003000,
    site: "shop.example.com",
    kind: "cookies.snapshot",
    mode: "power",
    source: "extension",
    data: {
      count: 5,
      thirdPartyCount: 0,
      cookies: [
        { name: "s", domain: ".shop.example.com", isThirdParty: false },
      ],
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "baseline");
  assert.equal(row.signalType, "state_change");
  assert.equal(row.patternId, "cookies.snapshot.first_party_only");
  assert.equal(row.isThirdParty, 0);
});

test("api.canvas metadata maps to api/canvas fingerprinting semantics", () => {
  const ev = {
    id: "evt-api-canvas-1",
    ts: 1700000004000,
    site: "fp.example.com",
    kind: "api.canvas.activity",
    mode: "moderate",
    source: "extension",
    data: {
      operation: "toDataURL",
      contextType: "2d",
      width: 300,
      height: 150,
      count: 4,
      burstMs: 900,
      sampleWindowMs: 1200,
      surface: "api",
      surfaceDetail: "canvas",
      signalType: "fingerprinting_signal",
      mitigationStatus: "observed_only",
      privacyStatus: "signal_detected",
      patternId: "api.canvas.toDataURL",
      confidence: 0.94,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "canvas");
  assert.equal(row.privacyStatus, "signal_detected");
  assert.equal(row.mitigationStatus, "observed_only");
  assert.equal(row.signalType, "fingerprinting_signal");
  assert.equal(row.patternId, "api.canvas.toDataURL");
  assert.equal(row.confidence, 0.94);

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.operation, "toDataURL");
  assert.equal(rawContext.burstCount, 4);
  assert.equal(rawContext.burstMs, 900);
});

test("api.canvas infers contract classification when raw event omits pattern and confidence fields", () => {
  const ev = {
    id: "evt-api-canvas-derived-1",
    ts: 1700000004500,
    site: "fp.example.com",
    kind: "api.canvas.activity",
    mode: "moderate",
    source: "extension",
    data: {
      operation: "getImageData",
      contextType: "2d",
      width: 300,
      height: 150,
      count: 2,
      burstMs: 250,
      sampleWindowMs: 1200,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "canvas");
  assert.equal(row.signalType, "fingerprinting_signal");
  assert.equal(row.patternId, "api.canvas.getImageData");
  assert.equal(row.confidence, 0.95);
});

test("api.webrtc metadata maps to api/webrtc probe semantics without candidate strings", () => {
  const ev = {
    id: "evt-api-webrtc-1",
    ts: 1700000005000,
    site: "rtc.example.com",
    kind: "api.webrtc.activity",
    mode: "moderate",
    source: "extension",
    data: {
      action: "ice_candidate_activity",
      state: "candidate",
      candidateType: "srflx",
      stunTurnHostnames: ["stun.l.google.com"],
      count: 3,
      burstMs: 600,
      sampleWindowMs: 1200,
      surface: "api",
      surfaceDetail: "webrtc",
      signalType: "device_probe",
      mitigationStatus: "observed_only",
      privacyStatus: "signal_detected",
      patternId: "api.webrtc.ice_candidate_activity",
      confidence: 0.93,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "webrtc");
  assert.equal(row.privacyStatus, "signal_detected");
  assert.equal(row.mitigationStatus, "observed_only");
  assert.equal(row.signalType, "device_probe");
  assert.equal(row.patternId, "api.webrtc.ice_candidate_activity");
  assert.equal(row.confidence, 0.93);
  assert.equal(row.requestDomain, "stun.l.google.com");
  assert.equal(row.vendorId, "google");

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.candidateType, "srflx");
  assert.equal(rawContext.burstCount, 3);
  assert.equal(rawContext.stunTurnHostnames.includes("stun.l.google.com"), true);
  assert.equal("candidate" in rawContext, false);
});

test("api.webrtc infers contract classification when raw event omits pattern and confidence fields", () => {
  const ev = {
    id: "evt-api-webrtc-derived-1",
    ts: 1700000005500,
    site: "rtc.example.com",
    kind: "api.webrtc.activity",
    mode: "moderate",
    source: "extension",
    data: {
      action: "ice_candidate_activity",
      state: "candidate",
      candidateType: "srflx",
      stunTurnHostnames: ["stun.l.google.com"],
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "webrtc");
  assert.equal(row.signalType, "device_probe");
  assert.equal(row.patternId, "api.webrtc.ice_candidate_activity");
  assert.equal(row.confidence, 0.93);
  assert.equal(row.requestDomain, "stun.l.google.com");
});
