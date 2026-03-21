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

test("api event presentation maps canonical labels and metadata-only summaries", () => {
  const { getApiEventPresentation, isApiSignalEvent } = loadRuntimeModuleExport(
    "public/app/api-event-presentation.js",
    ["getApiEventPresentation", "isApiSignalEvent"]
  );

  const event = {
    id: "api-1",
    ts: 1_000,
    kind: "api.canvas",
    site: "alpha.local",
    data: {
      operation: "toDataURL",
      contextType: "2d",
      width: 300,
      height: 150,
      gateOutcome: "warned",
    },
    enrichment: {
      surface: "api",
      surfaceDetail: "canvas",
      signalType: "fingerprinting_signal",
      patternId: "api.canvas.readback",
      confidence: 0.93,
    },
  };

  const presentation = getApiEventPresentation(event);
  assert.equal(isApiSignalEvent(event), true);
  assert.equal(presentation.label, "Canvas readback");
  assert.equal(presentation.surfaceLabel, "Canvas");
  assert.equal(presentation.signalTypeLabel, "Fingerprinting signal");
  assert.equal(presentation.gateOutcomeLabel, "Warned");
  assert.equal(presentation.confidenceBand, "high");
  assert.match(presentation.summary, /toDataURL/i);
  assert.match(presentation.summary, /300x150/);
});

test("site filter logic keeps API events compatible with surface and mitigation filters", () => {
  const {
    matchesFilters,
    getKindBucket,
    getVisualCategoryBucket,
    getSurfaceBucket,
    getMitigationStatusBucket,
    getPrivacyStatusBucket,
  } = loadRuntimeModuleExport(
    "public/app/site/filter-state.js",
    ["matchesFilters", "getKindBucket", "getVisualCategoryBucket", "getSurfaceBucket", "getMitigationStatusBucket", "getPrivacyStatusBucket"]
  );

  const apiEvent = {
    id: "api-blocked-1",
    ts: 1_000,
    kind: "api.geolocation",
    site: "alpha.local",
    enrichment: {
      surface: "api",
      surfaceDetail: "geolocation",
      privacyStatus: "policy_blocked",
      mitigationStatus: "blocked",
      signalType: "tracking_signal",
    },
  };

  assert.equal(getKindBucket(apiEvent), "blocked");
  assert.equal(getVisualCategoryBucket(apiEvent), "blocked_api");
  assert.equal(getSurfaceBucket(apiEvent), "api");
  assert.equal(getMitigationStatusBucket(apiEvent), "blocked");
  assert.equal(getPrivacyStatusBucket(apiEvent), "policy_blocked");

  assert.equal(getVisualCategoryBucket({
    id: "api-allowed-visual",
    ts: 1_100,
    kind: "api.canvas",
    enrichment: {
      surface: "api",
      mitigationStatus: "allowed",
    },
  }), "observed_api");

  assert.equal(matchesFilters(apiEvent, {
    kind: { blocked: true, observed: false, other: false },
    party: "all",
    resource: "all",
    surface: "api",
    privacyStatus: "policy_blocked",
    mitigationStatus: "blocked",
    domainText: "",
  }), true);

  assert.equal(matchesFilters(apiEvent, {
    kind: { blocked: false, observed: false, other: true },
    party: "all",
    resource: "all",
    surface: "network",
    privacyStatus: "all",
    mitigationStatus: "all",
    domainText: "",
  }), false);
});

test("insight evidence summary counts API events by mitigation semantics", () => {
  const sandbox = createSandbox();
  loadBrowserModule("public/app/insight-rules.js", sandbox);
  const api = sandbox.window.VPT.insightRules;

  const summary = api.makeEvidenceSummary([
    {
      id: "api-blocked",
      ts: 1_000,
      kind: "api.clipboard",
      enrichment: { mitigationStatus: "blocked" },
    },
    {
      id: "api-observed",
      ts: 2_000,
      kind: "api.clipboard",
      enrichment: { mitigationStatus: "observed_only" },
    },
    {
      id: "api-allowed",
      ts: 3_000,
      kind: "api.clipboard",
      enrichment: { mitigationStatus: "allowed" },
    },
  ]);

  assert.equal(summary.total, 3);
  assert.equal(summary.blocked, 0);
  assert.equal(summary.observed, 0);
  assert.equal(summary.blockedApi, 1);
  assert.equal(summary.observedApi, 2);
  assert.equal(summary.api, 3);
  assert.equal(summary.other, 0);
});

test("insight summary text calls out browser API activity for API-only selections", () => {
  const sandbox = createSandbox();
  loadBrowserModule("public/app/insight-rules.js", sandbox);
  const api = sandbox.window.VPT.insightRules;

  const insight = api.buildInsightResult({
    events: [
      {
        id: "api-allowed-1",
        ts: 1_000,
        site: "github.io",
        kind: "api.clipboard.activity",
        enrichment: {
          surface: "api",
          mitigationStatus: "allowed",
        },
      },
      {
        id: "api-allowed-2",
        ts: 1_100,
        site: "github.io",
        kind: "api.clipboard.activity",
        enrichment: {
          surface: "api",
          mitigationStatus: "allowed",
        },
      },
    ],
    viewId: "vendorOverview",
    viewMode: "power",
    siteName: "github.io",
    selectedVendor: {
      vendorId: "github.io",
      vendorName: "github.io",
      category: "unmapped",
      domains: ["github.io"],
      riskHints: [],
    },
  });

  assert.match(insight.summary, /0 blocked, 0 observed, 2 observed API/i);
  assert.match(insight.summary, /Browser API activity/i);
});

test("timeline chart counts API blocked and observed buckets from semantic status", () => {
  const { createChartBuilders } = loadRuntimeModuleExport(
    "public/app/site/chart-builders.js",
    ["createChartBuilders"]
  );

  const builders = createChartBuilders({
    vizOptions: {
      metric: "seen",
      seriesType: "bar",
      topN: 20,
      sort: "value_desc",
      binSize: "5m",
      normalize: false,
      stackBars: true,
    },
    binSizeMs: { "5m": 5 * 60 * 1000 },
    hoverPointStyle: { borderColor: "#38BDF8", borderWidth: 1 },
    selectedPointStyle: { borderColor: "#A78BFA", borderWidth: 2 },
    getRangeWindow: () => ({ from: 1_000, to: 10_000 }),
    buildVendorRollup: () => [],
    getKindBucket: (ev) => {
      const mitigation = String(ev?.enrichment?.mitigationStatus || "");
      if (mitigation === "blocked") return "blocked";
      if (mitigation === "observed_only") return "observed";
      return "other";
    },
    getVisualCategoryBucket: (ev) => {
      const mitigation = String(ev?.enrichment?.mitigationStatus || "");
      if (String(ev?.enrichment?.surface || "") === "api") {
        if (mitigation === "blocked") return "blocked_api";
        return "observed_api";
      }
      if (mitigation === "blocked") return "blocked";
      if (mitigation === "observed_only") return "observed";
      return "other";
    },
    getVendorMetricValue: () => 0,
    getResourceBucket: () => "other",
    getPartyBucket: () => "first_or_unknown",
    getPrivacyStatusBucket: () => "unknown",
    getMitigationStatusBucket: (ev) => String(ev?.enrichment?.mitigationStatus || "unknown"),
    resourceLabels: {},
    partyLabels: {},
  });

  const built = builders.buildTimelineOption([
    { id: "api-blocked", ts: 1_500, kind: "api.clipboard", enrichment: { surface: "api", mitigationStatus: "blocked" } },
    { id: "api-observed", ts: 2_000, kind: "api.clipboard", enrichment: { surface: "api", mitigationStatus: "observed_only" } },
    { id: "api-other", ts: 2_500, kind: "api.clipboard", enrichment: { surface: "api", mitigationStatus: "allowed" } },
  ], { viewMode: "power", densityAware: false });

  const seriesByName = new Map((built.option.series || []).map((series) => [series.name, series.data]));
  assert.equal(seriesByName.get("Blocked")?.[0], 0);
  assert.equal(seriesByName.get("Observed")?.[0], 0);
  assert.equal(seriesByName.get("Blocked API")?.[0], 1);
  assert.equal(seriesByName.get("Observed API")?.[0], 2);
  assert.equal(seriesByName.get("Other")?.[0], 0);
});

test("timeline keeps API as a first-class series in easy low-signal scopes", () => {
  const { createChartBuilders } = loadRuntimeModuleExport(
    "public/app/site/chart-builders.js",
    ["createChartBuilders"]
  );

  const builders = createChartBuilders({
    vizOptions: {
      metric: "seen",
      seriesType: "bar",
      topN: 20,
      sort: "value_desc",
      binSize: "5m",
      normalize: false,
      stackBars: true,
    },
    binSizeMs: { "5m": 5 * 60 * 1000 },
    hoverPointStyle: { borderColor: "#38BDF8", borderWidth: 1 },
    selectedPointStyle: { borderColor: "#A78BFA", borderWidth: 2 },
    getRangeWindow: () => ({ from: 1_000, to: 10_000 }),
    buildVendorRollup: () => [],
    getKindBucket: () => "other",
    getVisualCategoryBucket: (ev) => String(ev?.enrichment?.surface || "") === "api" ? "observed_api" : "other",
    getVendorMetricValue: () => 0,
    getResourceBucket: () => "other",
    getPartyBucket: () => "first_or_unknown",
    getPrivacyStatusBucket: () => "unknown",
    getMitigationStatusBucket: (ev) => String(ev?.enrichment?.mitigationStatus || "unknown"),
    resourceLabels: {},
    partyLabels: {},
  });

  const built = builders.buildTimelineOption([
    { id: "api-only-1", ts: 1_500, kind: "api.canvas", enrichment: { surface: "api", mitigationStatus: "allowed" } },
    { id: "api-only-2", ts: 2_000, kind: "api.webrtc", enrichment: { surface: "api", mitigationStatus: "allowed" } },
  ], { viewMode: "easy", densityAware: true });

  const seriesNames = (built.option.series || []).map((series) => series.name);
  assert.equal(seriesNames.includes("Events"), false);
  assert.equal(seriesNames.includes("Observed API"), true);
});
