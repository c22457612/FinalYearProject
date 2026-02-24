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
