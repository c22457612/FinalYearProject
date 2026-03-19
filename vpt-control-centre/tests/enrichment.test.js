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

test("api.canvas repeated readback uses canonical backend pattern even with provisional raw labels", () => {
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
      signalType: "capability_probe",
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
  assert.equal(row.patternId, "api.canvas.repeated_readback");
  assert.equal(row.confidence, 0.96);

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.operation, "toDataURL");
  assert.equal(rawContext.burstCount, 4);
  assert.equal(rawContext.burstMs, 900);
});

test("api.canvas infers repeated readback from burst metadata when raw event omits classification fields", () => {
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
  assert.equal(row.patternId, "api.canvas.repeated_readback");
  assert.equal(row.confidence, 0.96);
});

test("api.canvas infers single readback from metadata when no burst is present", () => {
  const ev = {
    id: "evt-api-canvas-derived-2",
    ts: 1700000004750,
    site: "fp.example.com",
    kind: "api.canvas.activity",
    mode: "moderate",
    source: "extension",
    data: {
      operation: "getImageData",
      contextType: "2d",
      width: 300,
      height: 150,
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "canvas");
  assert.equal(row.signalType, "fingerprinting_signal");
  assert.equal(row.patternId, "api.canvas.readback");
  assert.equal(row.confidence, 0.95);
});

test("api.canvas warned outcome stays observed_only but preserves raw gate metadata", () => {
  const ev = {
    id: "evt-api-canvas-warn-1",
    ts: 1700000004800,
    site: "fp.example.com",
    kind: "api.canvas.activity",
    mode: "moderate",
    source: "extension",
    data: {
      operation: "toDataURL",
      contextType: "2d",
      width: 300,
      height: 150,
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
      gateOutcome: "warned",
      gateAction: "warn",
      trustedSite: false,
      frameScope: "top_frame",
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "signal_detected");
  assert.equal(row.mitigationStatus, "observed_only");
  assert.equal(row.patternId, "api.canvas.readback");

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.gateOutcome, "warned");
  assert.equal(rawContext.gateAction, "warn");
  assert.equal(rawContext.trustedSite, false);
  assert.equal(rawContext.frameScope, "top_frame");
});

test("api.canvas blocked outcome maps to policy_blocked", () => {
  const ev = {
    id: "evt-api-canvas-block-1",
    ts: 1700000004850,
    site: "fp.example.com",
    kind: "api.canvas.activity",
    mode: "moderate",
    source: "extension",
    data: {
      operation: "getImageData",
      contextType: "2d",
      width: 300,
      height: 150,
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
      gateOutcome: "blocked",
      gateAction: "block",
      trustedSite: false,
      frameScope: "top_frame",
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "policy_blocked");
  assert.equal(row.mitigationStatus, "blocked");
});

test("api.canvas trusted-site allowed outcome maps to policy_allowed", () => {
  const ev = {
    id: "evt-api-canvas-trusted-1",
    ts: 1700000004875,
    site: "fp.example.com",
    kind: "api.canvas.activity",
    mode: "moderate",
    source: "extension",
    data: {
      operation: "toBlob",
      contextType: "2d",
      width: 300,
      height: 150,
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
      gateOutcome: "trusted_allowed",
      gateAction: "allow_trusted",
      trustedSite: true,
      frameScope: "top_frame",
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "policy_allowed");
  assert.equal(row.mitigationStatus, "allowed");
});

test("api.geolocation current-position requests map to canonical backend semantics without coordinates", () => {
  const ev = {
    id: "evt-api-geo-current-1",
    ts: 1700000004885,
    site: "maps.example.com",
    kind: "api.geolocation.activity",
    mode: "moderate",
    source: "extension",
    data: {
      method: "getCurrentPosition",
      requestedHighAccuracy: true,
      timeoutMs: 5000,
      maximumAgeMs: 0,
      hasSuccessCallback: true,
      hasErrorCallback: true,
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "geolocation");
  assert.equal(row.signalType, "tracking_signal");
  assert.equal(row.patternId, "api.geolocation.current_position_request");
  assert.equal(row.confidence, 0.97);
  assert.equal(row.requestDomain, null);

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.method, "getCurrentPosition");
  assert.equal(rawContext.requestedHighAccuracy, true);
  assert.equal(rawContext.timeoutMs, 5000);
  assert.equal(rawContext.maximumAgeMs, 0);
  assert.equal("coords" in rawContext, false);
  assert.equal("latitude" in rawContext, false);
  assert.equal("longitude" in rawContext, false);
});

test("api.geolocation watch requests map to watch-request classification", () => {
  const ev = {
    id: "evt-api-geo-watch-1",
    ts: 1700000004890,
    site: "maps.example.com",
    kind: "api.geolocation.activity",
    mode: "moderate",
    source: "extension",
    data: {
      method: "watchPosition",
      requestedHighAccuracy: false,
      maximumAgeMs: 60000,
      hasSuccessCallback: true,
      hasErrorCallback: false,
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "geolocation");
  assert.equal(row.signalType, "tracking_signal");
  assert.equal(row.patternId, "api.geolocation.watch_request");
  assert.equal(row.confidence, 0.98);
});

test("api.geolocation blocked outcome maps to policy_blocked", () => {
  const ev = {
    id: "evt-api-geo-block-1",
    ts: 1700000004895,
    site: "maps.example.com",
    kind: "api.geolocation.activity",
    mode: "moderate",
    source: "extension",
    data: {
      method: "getCurrentPosition",
      requestedHighAccuracy: true,
      gateOutcome: "blocked",
      gateAction: "block",
      trustedSite: false,
      frameScope: "top_frame",
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "policy_blocked");
  assert.equal(row.mitigationStatus, "blocked");
});

test("api.geolocation trusted-site allowed outcome maps to policy_allowed", () => {
  const ev = {
    id: "evt-api-geo-trusted-1",
    ts: 1700000004898,
    site: "maps.example.com",
    kind: "api.geolocation.activity",
    mode: "moderate",
    source: "extension",
    data: {
      method: "watchPosition",
      requestedHighAccuracy: false,
      gateOutcome: "trusted_allowed",
      gateAction: "allow_trusted",
      trustedSite: true,
      frameScope: "top_frame",
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "policy_allowed");
  assert.equal(row.mitigationStatus, "allowed");

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.trustedSite, true);
  assert.equal(rawContext.frameScope, "top_frame");
});

test("api.clipboard readText requests map to canonical backend semantics without clipboard contents", () => {
  const ev = {
    id: "evt-api-clipboard-readtext-1",
    ts: 1700000004899,
    site: "docs.example.com",
    kind: "api.clipboard.activity",
    mode: "moderate",
    source: "extension",
    data: {
      method: "readText",
      accessType: "read",
      policyReady: true,
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "clipboard");
  assert.equal(row.privacyStatus, "high_risk");
  assert.equal(row.signalType, "tracking_signal");
  assert.equal(row.patternId, "api.clipboard.async_read_text");
  assert.equal(row.confidence, 0.99);
  assert.equal(row.requestDomain, null);

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.method, "readText");
  assert.equal(rawContext.accessType, "read");
  assert.equal("text" in rawContext, false);
  assert.equal("contents" in rawContext, false);
});

test("api.clipboard write requests keep MIME metadata only and never payloads", () => {
  const ev = {
    id: "evt-api-clipboard-write-1",
    ts: 1700000004900,
    site: "docs.example.com",
    kind: "api.clipboard.activity",
    mode: "moderate",
    source: "extension",
    data: {
      method: "write",
      accessType: "write",
      itemCount: 2,
      mimeTypes: ["text/plain", "image/png"],
      policyReady: true,
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "clipboard");
  assert.equal(row.privacyStatus, "signal_detected");
  assert.equal(row.signalType, "state_change");
  assert.equal(row.patternId, "api.clipboard.async_write");
  assert.equal(row.confidence, 0.93);

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.method, "write");
  assert.equal(rawContext.accessType, "write");
  assert.equal(rawContext.itemCount, 2);
  assert.deepEqual(rawContext.mimeTypes, ["text/plain", "image/png"]);
  assert.equal("text" in rawContext, false);
  assert.equal("items" in rawContext, false);
});

test("api.clipboard blocked read outcome maps to policy_blocked", () => {
  const ev = {
    id: "evt-api-clipboard-block-1",
    ts: 1700000004901,
    site: "docs.example.com",
    kind: "api.clipboard.activity",
    mode: "moderate",
    source: "extension",
    data: {
      method: "read",
      accessType: "read",
      gateOutcome: "blocked",
      gateAction: "block",
      trustedSite: false,
      frameScope: "top_frame",
      policyReady: true,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "policy_blocked");
  assert.equal(row.mitigationStatus, "blocked");
  assert.equal(row.patternId, "api.clipboard.async_read");
});

test("api.clipboard soft write warning under block keeps observed-only semantics", () => {
  const ev = {
    id: "evt-api-clipboard-write-warn-1",
    ts: 1700000004902,
    site: "docs.example.com",
    kind: "api.clipboard.activity",
    mode: "moderate",
    source: "extension",
    data: {
      method: "writeText",
      accessType: "write",
      gateOutcome: "warned",
      gateAction: "block",
      trustedSite: false,
      frameScope: "top_frame",
      policyReady: true,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "signal_detected");
  assert.equal(row.mitigationStatus, "observed_only");

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.gateOutcome, "warned");
  assert.equal(rawContext.gateAction, "block");
});

test("api.clipboard trusted-site allowed read outcome maps to policy_allowed", () => {
  const ev = {
    id: "evt-api-clipboard-trusted-1",
    ts: 1700000004903,
    site: "docs.example.com",
    kind: "api.clipboard.activity",
    mode: "moderate",
    source: "extension",
    data: {
      method: "readText",
      accessType: "read",
      gateOutcome: "trusted_allowed",
      gateAction: "allow_trusted",
      trustedSite: true,
      frameScope: "top_frame",
      policyReady: true,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "policy_allowed");
  assert.equal(row.mitigationStatus, "allowed");

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.trustedSite, true);
  assert.equal(rawContext.frameScope, "top_frame");
});

test("api.webrtc peer connection setup stays a capability probe", () => {
  const ev = {
    id: "evt-api-webrtc-setup-1",
    ts: 1700000004900,
    site: "rtc.example.com",
    kind: "api.webrtc.activity",
    mode: "moderate",
    source: "extension",
    data: {
      action: "peer_connection_created",
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "webrtc");
  assert.equal(row.signalType, "capability_probe");
  assert.equal(row.patternId, "api.webrtc.peer_connection_setup");
  assert.equal(row.confidence, 0.84);
});

test("api.webrtc offer flow maps to offer probe without ICE metadata", () => {
  const ev = {
    id: "evt-api-webrtc-offer-1",
    ts: 1700000004950,
    site: "rtc.example.com",
    kind: "api.webrtc.activity",
    mode: "moderate",
    source: "extension",
    data: {
      action: "set_local_description_offer",
      offerType: "offer",
      count: 1,
      burstMs: 50,
      sampleWindowMs: 1200,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "webrtc");
  assert.equal(row.signalType, "device_probe");
  assert.equal(row.patternId, "api.webrtc.offer_probe");
  assert.equal(row.confidence, 0.95);
});

test("api.webrtc metadata maps to canonical STUN/TURN-assisted probe semantics without candidate strings", () => {
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
      signalType: "capability_probe",
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
  assert.equal(row.patternId, "api.webrtc.stun_turn_assisted_probe");
  assert.equal(row.confidence, 0.96);
  assert.equal(row.requestDomain, "stun.l.google.com");
  assert.equal(row.vendorId, "google");

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.candidateType, "srflx");
  assert.equal(rawContext.burstCount, 3);
  assert.equal(rawContext.stunTurnHostnames.includes("stun.l.google.com"), true);
  assert.equal("candidate" in rawContext, false);
});

test("api.webrtc infers ICE probe classification from metadata when safe hostnames are absent", () => {
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
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.surface, "api");
  assert.equal(row.surfaceDetail, "webrtc");
  assert.equal(row.signalType, "device_probe");
  assert.equal(row.patternId, "api.webrtc.ice_probe");
  assert.equal(row.confidence, 0.93);
  assert.equal(row.requestDomain, null);
});

test("api.webrtc warned outcome stays observed_only but preserves raw gate metadata", () => {
  const ev = {
    id: "evt-api-webrtc-warn-1",
    ts: 1700000005600,
    site: "rtc.example.com",
    kind: "api.webrtc.activity",
    mode: "moderate",
    source: "extension",
    data: {
      action: "peer_connection_created",
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
      gateOutcome: "warned",
      gateAction: "warn",
      trustedSite: false,
      frameScope: "top_frame",
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "signal_detected");
  assert.equal(row.mitigationStatus, "observed_only");
  assert.equal(row.patternId, "api.webrtc.peer_connection_setup");

  const rawContext = JSON.parse(row.rawContext);
  assert.equal(rawContext.gateOutcome, "warned");
  assert.equal(rawContext.gateAction, "warn");
  assert.equal(rawContext.trustedSite, false);
  assert.equal(rawContext.frameScope, "top_frame");
});

test("api.webrtc blocked outcome maps to policy_blocked", () => {
  const ev = {
    id: "evt-api-webrtc-block-1",
    ts: 1700000005650,
    site: "rtc.example.com",
    kind: "api.webrtc.activity",
    mode: "moderate",
    source: "extension",
    data: {
      action: "peer_connection_created",
      state: "blocked",
      stunTurnHostnames: ["stun.example.net"],
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
      gateOutcome: "blocked",
      gateAction: "block",
      trustedSite: false,
      frameScope: "top_frame",
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "policy_blocked");
  assert.equal(row.mitigationStatus, "blocked");
  assert.equal(row.patternId, "api.webrtc.peer_connection_setup");
});

test("api.webrtc trusted-site allowed outcome maps to policy_allowed", () => {
  const ev = {
    id: "evt-api-webrtc-trusted-1",
    ts: 1700000005700,
    site: "rtc.example.com",
    kind: "api.webrtc.activity",
    mode: "moderate",
    source: "extension",
    data: {
      action: "create_offer_called",
      count: 1,
      burstMs: 0,
      sampleWindowMs: 1200,
      gateOutcome: "trusted_allowed",
      gateAction: "allow_trusted",
      trustedSite: true,
      frameScope: "top_frame",
    },
  };

  const row = buildEnrichmentRecord(ev, ev.site);
  assert.equal(row.privacyStatus, "policy_allowed");
  assert.equal(row.mitigationStatus, "allowed");
  assert.equal(row.patternId, "api.webrtc.offer_probe");
});
