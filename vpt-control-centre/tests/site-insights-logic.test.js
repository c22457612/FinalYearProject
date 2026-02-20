const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

function loadBrowserModule(relPath, sandbox) {
  const full = path.join(__dirname, "..", relPath);
  const src = fs.readFileSync(full, "utf8");
  vm.runInNewContext(src, sandbox, { filename: full });
}

function createSandbox() {
  const sandbox = {
    window: {},
    console,
    setTimeout,
    clearTimeout,
    Date,
    URL,
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  return sandbox;
}

test("vendor taxonomy maps Google domains", () => {
  const sandbox = createSandbox();
  loadBrowserModule("public/app/vendor-taxonomy.js", sandbox);
  const api = sandbox.window.VPT.vendorTaxonomy;

  const profile = api.classifyDomain("https://www.googletagmanager.com/gtm.js?id=123");
  assert.equal(profile.vendorId, "google");
  assert.equal(profile.vendorName, "Google");
  assert.equal(profile.known, true);
});

test("vendor taxonomy falls back to base domain for unknown vendors", () => {
  const sandbox = createSandbox();
  loadBrowserModule("public/app/vendor-taxonomy.js", sandbox);
  const api = sandbox.window.VPT.vendorTaxonomy;

  const profile = api.classifyDomain("cdn.unknown-vendor-example.net");
  assert.equal(profile.vendorId, "unknown-vendor-example.net");
  assert.equal(profile.known, false);
});

test("insight rules produce caution/high severity for heavy third-party script mix", () => {
  const sandbox = createSandbox();
  loadBrowserModule("public/app/vendor-taxonomy.js", sandbox);
  loadBrowserModule("public/app/insight-rules.js", sandbox);
  const api = sandbox.window.VPT.insightRules;

  const events = [];
  for (let i = 0; i < 24; i++) {
    events.push({
      id: `e-${i}`,
      ts: 1000 + i,
      site: "example.com",
      kind: i % 2 === 0 ? "network.observed" : "network.blocked",
      mode: i % 3 === 0 ? "strict" : "moderate",
      data: {
        domain: "googletagmanager.com",
        resourceType: i % 4 === 0 ? "script" : "xmlhttprequest",
        isThirdParty: true,
      },
    });
  }

  const insight = api.buildInsightResult({
    events,
    viewId: "vendorOverview",
    viewMode: "power",
    siteName: "example.com",
    selectedVendor: {
      vendorId: "google",
      vendorName: "Google",
      category: "adtech-analytics",
      domains: ["googletagmanager.com"],
      riskHints: [],
    },
  });

  assert.ok(["caution", "high"].includes(insight.severity));
  assert.ok(insight.warnings.length > 0);
  assert.ok(insight.precautions.length > 0);
  assert.ok(insight.evidenceSummary.total >= 24);
});

test("evidence summary tracks dominant kinds and time bounds", () => {
  const sandbox = createSandbox();
  loadBrowserModule("public/app/insight-rules.js", sandbox);
  const api = sandbox.window.VPT.insightRules;

  const events = [
    { id: "a", ts: 100, kind: "network.blocked", mode: "strict", data: { isThirdParty: true } },
    { id: "b", ts: 300, kind: "network.blocked", mode: "strict", data: { isThirdParty: true } },
    { id: "c", ts: 200, kind: "cookies.snapshot", mode: "strict", data: { thirdPartyCount: 2 } },
  ];

  const summary = api.makeEvidenceSummary(events);
  assert.equal(summary.firstTs, 100);
  assert.equal(summary.lastTs, 300);
  assert.equal(summary.total, 3);
  assert.equal(summary.blocked, 2);
  assert.ok(summary.dominantKinds.length >= 1);
});

test("site lens pivots vendor overview for selected vendor when comparison cardinality is low", () => {
  const sandbox = createSandbox();
  loadBrowserModule("public/app/site-lens.js", sandbox);
  const api = sandbox.window.VPT.siteLens;

  const shouldPivot = api.shouldAutoPivotVendorOverview({
    viewId: "vendorOverview",
    selectedVendor: { vendorId: "google", vendorName: "Google" },
    vendorCardinality: 1,
  });
  const shouldNotPivot = api.shouldAutoPivotVendorOverview({
    viewId: "vendorOverview",
    selectedVendor: { vendorId: "google", vendorName: "Google" },
    vendorCardinality: 2,
  });

  assert.equal(shouldPivot, true);
  assert.equal(shouldNotPivot, false);
});

test("site lens KPI computation is stable and returns expected ratios", () => {
  const sandbox = createSandbox();
  loadBrowserModule("public/app/site-lens.js", sandbox);
  const api = sandbox.window.VPT.siteLens;

  const events = [
    { ts: 1000, kind: "network.blocked", data: { isThirdParty: true, resourceType: "script", domain: "a.com" }, mode: "strict" },
    { ts: 1300, kind: "network.observed", data: { isThirdParty: true, resourceType: "xmlhttprequest", domain: "a.com" }, mode: "strict" },
    { ts: 1600, kind: "network.observed", data: { isThirdParty: false, resourceType: "image", domain: "b.com" }, mode: "moderate" },
  ];

  const kpis = api.buildScopeKpis(events, 300);
  const empty = api.buildScopeKpis([], 300);

  assert.equal(kpis.total, 3);
  assert.equal(kpis.blocked, 1);
  assert.equal(kpis.observed, 2);
  assert.equal(Number(kpis.blockRate.toFixed(4)), Number((1 / 3).toFixed(4)));
  assert.equal(Number(kpis.thirdPartyRatio.toFixed(4)), Number((2 / 3).toFixed(4)));
  assert.ok(kpis.peakBurst >= 1);

  assert.equal(empty.total, 0);
  assert.equal(empty.blockRate, 0);
  assert.equal(empty.thirdPartyRatio, 0);
  assert.equal(empty.peakBurst, 0);
});

test("site lens callouts include low-confidence guidance for small samples", () => {
  const sandbox = createSandbox();
  loadBrowserModule("public/app/site-lens.js", sandbox);
  const api = sandbox.window.VPT.siteLens;

  const events = [
    { ts: 1000, kind: "network.observed", data: { isThirdParty: true, resourceType: "script", domain: "tracker.example" }, mode: "low" },
    { ts: 1100, kind: "network.observed", data: { isThirdParty: true, resourceType: "script", domain: "tracker.example" }, mode: "low" },
    { ts: 1200, kind: "network.blocked", data: { isThirdParty: true, resourceType: "script", domain: "tracker.example" }, mode: "low" },
  ];
  const kpis = api.buildScopeKpis(events, 300);
  const callouts = api.buildScopeCallouts(events, kpis);

  assert.equal(callouts.length, 3);
  assert.ok(callouts.some((line) => line.toLowerCase().includes("low confidence")));
  assert.ok(callouts.some((line) => line.toLowerCase().includes("collect more evidence")));
});
