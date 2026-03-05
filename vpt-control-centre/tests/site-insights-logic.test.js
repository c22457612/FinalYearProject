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

function loadRuntimeModuleExport(relPath, exportNames, extraSandbox = {}) {
  const full = path.join(__dirname, "..", relPath);
  const src = fs.readFileSync(full, "utf8");
  const transformed = `${src.replace(/export function /g, "function ")}\n;globalThis.__exports = { ${exportNames.join(", ")} };`;
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    Date,
    URL,
    URLSearchParams,
    ...extraSandbox,
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(transformed, sandbox, { filename: full });
  return sandbox.__exports;
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

test("selection lifecycle clears selection when range changes", async () => {
  const fetchCalls = [];
  const callOrder = [];
  let windowEvents = [];
  let lastWindowFetchKey = null;
  let lastWindowFetchAt = 0;
  let isFetchSiteInFlight = false;

  const { createPollingController } = loadRuntimeModuleExport(
    "public/app/site/runtime/polling-controller.js",
    ["createPollingController"],
    {
      fetch: async (url) => {
        fetchCalls.push(String(url));
        callOrder.push("fetch");
        return {
          ok: true,
          status: 200,
          async json() {
            return [
              { id: "range-1", ts: 1000, kind: "network.observed", site: "alpha.local" },
            ];
          },
        };
      },
    }
  );

  const clearCalls = [];
  const controller = createPollingController({
    getSiteName: () => "alpha.local",
    getRangeWindow: () => ({ key: "24h", from: null, to: 2_000 }),
    getWindowEvents: () => windowEvents,
    setWindowEvents: (next) => { windowEvents = next; },
    getLastWindowFetchKey: () => lastWindowFetchKey,
    setLastWindowFetchKey: (next) => { lastWindowFetchKey = next; },
    getLastWindowFetchAt: () => lastWindowFetchAt,
    setLastWindowFetchAt: (next) => { lastWindowFetchAt = next; },
    getIsFetchSiteInFlight: () => isFetchSiteInFlight,
    setIsFetchSiteInFlight: (next) => { isFetchSiteInFlight = next; },
    getLatestSiteData: () => null,
    setLatestSiteData: () => {},
    setStatus: () => {},
    renderHeader: () => {},
    renderStats: () => {},
    renderTopThirdParties: () => {},
    deriveFilteredEvents: () => { callOrder.push("derive"); },
    renderVendorChips: () => { callOrder.push("chips"); },
    getVizSelection: () => ({ events: [{ id: "range-1" }] }),
    selectionStillValid: () => true,
    clearVizSelection: (opts) => {
      clearCalls.push(opts);
      callOrder.push("clear");
    },
    renderECharts: () => { callOrder.push("chart"); },
    renderRecentEventsFromEvents: () => { callOrder.push("table"); },
    getSelectedRecentEventKey: () => "",
    getChartEvents: () => windowEvents,
    updateFilterSummary: () => { callOrder.push("summary"); },
    renderRecentEvents: () => {},
  });

  await controller.applyRangeChanges();

  assert.equal(fetchCalls.length, 1);
  assert.ok(fetchCalls[0].startsWith("/api/events?site=alpha.local"));
  assert.equal(clearCalls.length, 1);
  assert.equal(clearCalls[0].close, true);
  assert.equal(clearCalls[0].clearBrush, true);
  assert.equal(clearCalls[0].renderTable, false);
  assert.equal(clearCalls[0].updateSummary, false);
  assert.equal(callOrder[0], "clear");
});

test("selection lifecycle clears selection when mode changes", () => {
  const { createViewNavigationController } = loadRuntimeModuleExport(
    "public/app/site/runtime/view-navigation-controller.js",
    ["createViewNavigationController"]
  );

  const controls = {
    viewModeSelect: { value: "power" },
    vizSelect: {
      value: "timeline",
      options: [
        { value: "timeline", textContent: "Timeline", dataset: {} },
        { value: "riskTrend", textContent: "Risk trend", dataset: {} },
      ],
    },
    vizPositionLabel: { textContent: "" },
    vizModeHelp: { textContent: "" },
    advancedControlsPanel: { open: true },
    vizOpenDrawerBtn: { disabled: false, textContent: "", title: "" },
    privacyStatusFilter: { disabled: false, title: "" },
  };

  let viewMode = "power";
  let vizIndex = 0;
  const clearCalls = [];

  const controller = createViewNavigationController({
    qs: (id) => controls[id] || null,
    getDocumentBody: () => ({ classList: { toggle: () => {} } }),
    views: [
      { id: "timeline", title: "Timeline" },
      { id: "riskTrend", title: "Risk trend" },
    ],
    easyViewIds: new Set(["timeline"]),
    powerOnlyViewLabelSuffix: " (Power only)",
    privacyFilterAllOnlyViewIds: new Set(),
    getViewMode: () => viewMode,
    setViewModeState: (next) => { viewMode = next; },
    getVizIndex: () => vizIndex,
    setVizIndex: (next) => { vizIndex = next; },
    getVizSelection: () => ({ events: [{ id: "m1" }] }),
    getFilterState: () => ({ privacyStatus: "all" }),
    closeDrawer: () => {},
    writeFilterStateToControls: () => {},
    deriveFilteredEvents: () => {},
    renderVendorChips: () => {},
    clearVizSelection: (opts) => { clearCalls.push(opts); },
    renderECharts: () => {},
    renderRecentEventsFromEvents: () => {},
    getChartEvents: () => [],
    updateFilterSummary: () => {},
  });

  controller.setViewMode("easy", { rerender: true });

  assert.equal(viewMode, "easy");
  assert.equal(clearCalls.length, 1);
  assert.equal(clearCalls[0].close, true);
  assert.equal(clearCalls[0].clearBrush, true);
  assert.equal(clearCalls[0].renderTable, false);
  assert.equal(clearCalls[0].updateSummary, false);
});

test("selection lifecycle invalidates stale selection when filter/vendor scope changes", () => {
  const { createSelectionController } = loadRuntimeModuleExport(
    "public/app/site/runtime/selection-controller.js",
    ["createSelectionController"]
  );

  const evA = { id: "ev-a", ts: 1_000, kind: "network.observed" };
  const evB = { id: "ev-b", ts: 2_000, kind: "network.blocked" };

  let vizSelection = null;
  let chartEvents = [evA, evB];

  const controller = createSelectionController({
    pickPrimarySelectedEvent: (events) => events[0] || null,
    getEventKey: (eventItem) => String(eventItem?.id || ""),
    getVizSelection: () => vizSelection,
    setVizSelectionState: (next) => { vizSelection = next; },
    setSelectedInsightTarget: () => {},
    setSelectedRecentEventKey: () => {},
    clearActiveEvidence: () => {},
    clearChartSelectionHighlight: () => {},
    setSelectedChartPoint: () => {},
    applyChartSelectionHighlight: () => {},
    clearBrushSelection: () => {},
    closeDrawer: () => {},
    closeInsightSheet: () => {},
    renderRecentEventsFromEvents: () => {},
    getChartEvents: () => chartEvents,
    syncInteractionOverlayOnCurrentChart: () => {},
    updateDrawerButtonState: () => {},
    updateFilterSummary: () => {},
    openInsightSheet: () => {},
    getViews: () => [{ id: "timeline", title: "Timeline" }],
    getVizIndex: () => 0,
    resetInsightSection: () => {},
    ensureInsightVisible: () => {},
  });

  controller.setVizSelection({
    type: "bin",
    value: "selected-window",
    title: "Selected window",
    summaryHtml: "",
    events: [evA, evB],
  });

  chartEvents = [evB];
  assert.equal(controller.selectionStillValid(), false);

  controller.clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
  assert.equal(vizSelection, null);
});

test("selection lifecycle sync is deterministic for same inputs and control state", () => {
  const { createSelectionController } = loadRuntimeModuleExport(
    "public/app/site/runtime/selection-controller.js",
    ["createSelectionController"]
  );

  const sourceEvents = [
    { id: "det-1", ts: 10, kind: "network.observed", site: "alpha.local" },
    { id: "det-2", ts: 20, kind: "network.blocked", site: "alpha.local" },
  ];

  function runOnce() {
    let vizSelection = null;
    let selectedRecentEventKey = "";
    const renderedSelections = [];

    const controller = createSelectionController({
      pickPrimarySelectedEvent: (events) => events[0] || null,
      getEventKey: (eventItem) => String(eventItem?.id || ""),
      getVizSelection: () => vizSelection,
      setVizSelectionState: (next) => { vizSelection = next; },
      setSelectedInsightTarget: () => {},
      setSelectedRecentEventKey: (next) => { selectedRecentEventKey = next; },
      clearActiveEvidence: () => {},
      clearChartSelectionHighlight: () => {},
      setSelectedChartPoint: () => {},
      applyChartSelectionHighlight: () => {},
      clearBrushSelection: () => {},
      closeDrawer: () => {},
      closeInsightSheet: () => {},
      renderRecentEventsFromEvents: (events, _msg, opts) => {
        renderedSelections.push({
          ids: events.map((eventItem) => eventItem.id),
          selectedEventKey: String(opts?.selectedEventKey || ""),
        });
      },
      getChartEvents: () => sourceEvents,
      syncInteractionOverlayOnCurrentChart: () => {},
      updateDrawerButtonState: () => {},
      updateFilterSummary: () => {},
      openInsightSheet: () => {},
      getViews: () => [{ id: "timeline", title: "Timeline" }],
      getVizIndex: () => 0,
      resetInsightSection: () => {},
      ensureInsightVisible: () => {},
    });

    controller.setVizSelection({
      type: "bin",
      value: "0:1",
      title: "Selected window",
      summaryHtml: "2 events",
      events: sourceEvents,
      fromTs: 10,
      toTs: 21,
    });

    const stillValid = controller.selectionStillValid();
    assert.equal(stillValid, true);

    return {
      selection: JSON.parse(JSON.stringify(vizSelection)),
      selectedRecentEventKey,
      renderedSelections,
    };
  }

  const first = runOnce();
  const second = runOnce();

  assert.deepEqual(first, second);
});
