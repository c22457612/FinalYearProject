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

function loadRuntimeModuleExportWithoutImports(relPath, exportNames, extraSandbox = {}) {
  const full = path.join(__dirname, "..", relPath);
  const src = fs.readFileSync(full, "utf8");
  const transformed = `${src
    .replace(/^import .*$/gm, "")
    .replace(/export function /g, "function ")}\n;globalThis.__exports = { ${exportNames.join(", ")} };`;
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

test("insight lead presentation promotes the first sentence into the headline", () => {
  const { buildInsightLeadPresentation } = loadRuntimeModuleExportWithoutImports(
    "public/app/site/runtime/insight-sheet.js",
    ["buildInsightLeadPresentation"],
    {
      isApiSignalEvent: () => false,
    }
  );

  const presentation = buildInsightLeadPresentation({
    insight: {
      summary: "Selected activity includes 24 events (10 blocked, 14 observed). Third-party requests are present (18/24).",
      evidenceSummary: {
        total: 24,
        blocked: 10,
        observed: 14,
        blockedApi: 0,
        observedApi: 0,
      },
    },
    evidence: [],
  });

  assert.equal(presentation.headline, "Selected activity includes 24 events (10 blocked, 14 observed).");
  assert.equal(presentation.detail, "Third-party requests are present (18/24).");
});

test("insight lead presentation omits detail when only one sentence exists", () => {
  const { buildInsightLeadPresentation } = loadRuntimeModuleExportWithoutImports(
    "public/app/site/runtime/insight-sheet.js",
    ["buildInsightLeadPresentation"],
    {
      isApiSignalEvent: () => false,
    }
  );

  const presentation = buildInsightLeadPresentation({
    insight: {
      summary: "Selected activity includes 3 events (1 blocked, 2 observed).",
      evidenceSummary: {
        total: 3,
        blocked: 1,
        observed: 2,
        blockedApi: 0,
        observedApi: 0,
      },
    },
    evidence: [],
  });

  assert.equal(presentation.headline, "Selected activity includes 3 events (1 blocked, 2 observed).");
  assert.equal(presentation.detail, "");
});

test("insight lead presentation keeps facts compact and folds API counts into outcome totals", () => {
  const { buildInsightLeadPresentation } = loadRuntimeModuleExportWithoutImports(
    "public/app/site/runtime/insight-sheet.js",
    ["buildInsightLeadPresentation"],
    {
      isApiSignalEvent: (ev) => String(ev?.kind || "").startsWith("api."),
    }
  );

  const evidence = [
    { kind: "network.blocked", data: { isThirdParty: true, resourceType: "script" } },
    { kind: "network.observed", data: { isThirdParty: true, resourceType: "script" } },
    { kind: "network.observed", data: { isThirdParty: true, resourceType: "xmlhttprequest" } },
    { kind: "api.clipboard", data: { isThirdParty: true } },
    { kind: "api.canvas", data: { isThirdParty: true } },
    { kind: "network.observed", data: { isThirdParty: true, resourceType: "image" } },
    { kind: "network.observed", data: { isThirdParty: false, resourceType: "image" } },
  ];

  const presentation = buildInsightLeadPresentation({
    insight: {
      summary: "Selected activity includes 7 events (1 blocked, 2 observed, 3 blocked API, 1 observed API).",
      evidenceSummary: {
        total: 7,
        blocked: 1,
        observed: 2,
        blockedApi: 3,
        observedApi: 1,
      },
    },
    evidence,
  });

  assert.deepEqual(
    Array.from(presentation.facts, (fact) => `${fact.label} ${fact.value}`),
    [
      "Activity 7 events",
      "Outcome 4 blocked / 3 observed",
      "Exposure 6 third-party",
      "Signals 2 script requests",
    ]
  );
  assert.equal(presentation.facts.length, 4);
});

test("insight case sheet presentation promotes the first summary sentence into the takeaway", () => {
  const { buildInsightCaseSheetPresentation } = loadRuntimeModuleExportWithoutImports(
    "public/app/site/runtime/insight-sheet.js",
    ["buildInsightCaseSheetPresentation"],
    {
      isApiSignalEvent: () => false,
    }
  );

  const presentation = buildInsightCaseSheetPresentation({
    insight: {
      summary: "example.com activity includes 49 events (13 blocked, 28 observed, 8 other). Script traffic is meaningful (6 script-type requests).",
      severity: "high",
      confidence: 0.88,
      evidenceSummary: {
        total: 49,
        blocked: 13,
        observed: 28,
        blockedApi: 0,
        observedApi: 0,
        other: 8,
      },
      actions: [{ type: "trust_site", label: "Trust this site" }],
    },
    evidence: [],
  });

  assert.equal(presentation.takeaway, "example.com activity includes 49 events (13 blocked, 28 observed, 8 other).");
  assert.equal(presentation.severity.level, "high");
  assert.equal(presentation.severity.label, "High");
  assert.equal(presentation.confidence.label, "88% confidence");
  assert.equal(presentation.confidence.band, "high");
});

test("insight case sheet presentation keeps metrics compact and folds API into blocked and observed totals", () => {
  const { buildInsightCaseSheetPresentation } = loadRuntimeModuleExportWithoutImports(
    "public/app/site/runtime/insight-sheet.js",
    ["buildInsightCaseSheetPresentation"],
    {
      isApiSignalEvent: (ev) => String(ev?.kind || "").startsWith("api."),
    }
  );

  const presentation = buildInsightCaseSheetPresentation({
    insight: {
      summary: "Selected activity includes 9 events (2 blocked, 3 observed, 1 other, 2 blocked API, 1 observed API).",
      severity: "caution",
      confidence: 0.76,
      evidenceSummary: {
        total: 9,
        blocked: 2,
        observed: 3,
        blockedApi: 2,
        observedApi: 1,
        other: 1,
      },
      actions: [],
    },
    evidence: [
      { kind: "network.blocked", data: { isThirdParty: true, resourceType: "script" } },
      { kind: "network.observed", data: { isThirdParty: true, resourceType: "script" } },
      { kind: "network.observed", data: { isThirdParty: true, resourceType: "xmlhttprequest" } },
      { kind: "api.clipboard", data: { isThirdParty: true } },
      { kind: "api.canvas", data: { isThirdParty: true } },
      { kind: "network.observed", data: { isThirdParty: true, resourceType: "image" } },
      { kind: "network.observed", data: { isThirdParty: false, resourceType: "image" } },
      { kind: "network.observed", data: { isThirdParty: false, resourceType: "image" } },
      { kind: "network.observed", data: { isThirdParty: false, resourceType: "image" } },
    ],
  });

  assert.deepEqual(
    Array.from(presentation.metrics, (metric) => `${metric.label} ${metric.value} ${metric.note || ""}`.trim()),
    [
      "Events 9 captured in scope",
      "Blocked 4 including API",
      "Observed 4 including API",
      "Third-party 6 requests",
      "Signals 2 script requests",
    ]
  );
  assert.equal(presentation.metrics.length, 5);
});

test("insight case sheet presentation assigns restrained semantic tones to metrics", () => {
  const { buildInsightCaseSheetPresentation } = loadRuntimeModuleExportWithoutImports(
    "public/app/site/runtime/insight-sheet.js",
    ["buildInsightCaseSheetPresentation"],
    {
      isApiSignalEvent: () => false,
    }
  );

  const presentation = buildInsightCaseSheetPresentation({
    insight: {
      summary: "Selected activity includes 6 events.",
      severity: "info",
      confidence: 0.62,
      evidenceSummary: {
        total: 6,
        blocked: 2,
        observed: 4,
        blockedApi: 0,
        observedApi: 0,
        other: 0,
      },
      actions: [],
    },
    evidence: [
      { kind: "network.blocked", data: { isThirdParty: true, resourceType: "script" } },
      { kind: "network.observed", data: { isThirdParty: true, resourceType: "script" } },
      { kind: "network.observed", data: { isThirdParty: true, resourceType: "image" } },
      { kind: "network.observed", data: { isThirdParty: false, resourceType: "image" } },
      { kind: "network.observed", data: { isThirdParty: false, resourceType: "image" } },
      { kind: "network.observed", data: { isThirdParty: false, resourceType: "image" } },
    ],
  });

  assert.deepEqual(
    Array.from(presentation.metrics, (metric) => `${metric.label}:${metric.tone}`),
    [
      "Events:neutral",
      "Blocked:blocked",
      "Observed:observed",
      "Third-party:neutral",
      "Signals:signals",
    ]
  );
});

test("insight case sheet presentation reports footer visibility when actions are present", () => {
  const { buildInsightCaseSheetPresentation } = loadRuntimeModuleExportWithoutImports(
    "public/app/site/runtime/insight-sheet.js",
    ["buildInsightCaseSheetPresentation"],
    {
      isApiSignalEvent: () => false,
    }
  );

  const withActions = buildInsightCaseSheetPresentation({
    insight: {
      summary: "Selected activity includes 2 events.",
      severity: "info",
      confidence: 0.45,
      evidenceSummary: {
        total: 2,
        blocked: 0,
        observed: 2,
        blockedApi: 0,
        observedApi: 0,
        other: 0,
      },
      actions: [{ type: "export_evidence", label: "Export selected evidence" }],
    },
    evidence: [{ kind: "network.observed", data: {} }],
  });

  const withoutActions = buildInsightCaseSheetPresentation({
    insight: {
      summary: "Selected activity includes 0 events.",
      severity: "info",
      confidence: 0.45,
      evidenceSummary: {
        total: 0,
        blocked: 0,
        observed: 0,
        blockedApi: 0,
        observedApi: 0,
        other: 0,
      },
      actions: [],
    },
    evidence: [],
  });

  assert.equal(withActions.footer.hasActions, true);
  assert.equal(withActions.footer.hasTechnical, true);
  assert.equal(withActions.footer.primaryActionIndex, 0);
  assert.equal(withoutActions.footer.hasActions, false);
  assert.equal(withoutActions.footer.hasTechnical, false);
  assert.equal(withoutActions.footer.primaryActionIndex, -1);
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

test("selection lifecycle explainCurrentScope synthesizes current-scope selection when none is locked", () => {
  const { createSelectionController } = loadRuntimeModuleExport(
    "public/app/site/runtime/selection-controller.js",
    ["createSelectionController"]
  );

  const sourceEvents = [
    { id: "scope-1", ts: 10, kind: "network.observed", site: "alpha.local" },
    { id: "scope-2", ts: 20, kind: "network.blocked", site: "alpha.local" },
  ];

  let opened = null;
  const controller = createSelectionController({
    pickPrimarySelectedEvent: (events) => events[0] || null,
    getEventKey: (eventItem) => String(eventItem?.id || ""),
    getVizSelection: () => null,
    setVizSelectionState: () => {},
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
    getChartEvents: () => sourceEvents,
    syncInteractionOverlayOnCurrentChart: () => {},
    updateDrawerButtonState: () => {},
    updateFilterSummary: () => {},
    openInsightSheet: (selection, evidence, opts) => {
      opened = { selection, evidence, opts };
    },
    getViews: () => [{ id: "riskTrend", title: "Risk trend" }],
    getVizIndex: () => 0,
    resetInsightSection: () => {},
    ensureInsightVisible: () => {},
  });

  controller.explainCurrentScope({ forceScroll: false });

  assert.equal(opened.selection.type, "scope");
  assert.equal(opened.selection.value, "riskTrend");
  assert.equal(opened.selection.title, "Risk trend scope");
  assert.deepEqual(opened.evidence.map((eventItem) => eventItem.id), ["scope-1", "scope-2"]);
  assert.equal(opened.opts.scrollSource, "scope");
});

test("selection lifecycle explainCurrentScope reuses locked selection when present", () => {
  const { createSelectionController } = loadRuntimeModuleExport(
    "public/app/site/runtime/selection-controller.js",
    ["createSelectionController"]
  );

  const lockedSelection = {
    type: "vendor",
    value: "Google",
    title: "Google",
    summaryHtml: "",
    events: [{ id: "sel-1", ts: 10, kind: "network.observed", site: "alpha.local" }],
  };

  let opened = null;
  const controller = createSelectionController({
    pickPrimarySelectedEvent: (events) => events[0] || null,
    getEventKey: (eventItem) => String(eventItem?.id || ""),
    getVizSelection: () => lockedSelection,
    setVizSelectionState: () => {},
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
    getChartEvents: () => lockedSelection.events,
    syncInteractionOverlayOnCurrentChart: () => {},
    updateDrawerButtonState: () => {},
    updateFilterSummary: () => {},
    openInsightSheet: (selection, evidence) => {
      opened = { selection, evidence };
    },
    getViews: () => [{ id: "timeline", title: "Timeline" }],
    getVizIndex: () => 0,
    resetInsightSection: () => {},
    ensureInsightVisible: () => {},
  });

  controller.explainCurrentScope({ forceScroll: true });

  assert.equal(opened.selection.type, "vendor");
  assert.equal(opened.selection.title, "Google");
  assert.deepEqual(opened.evidence.map((eventItem) => eventItem.id), ["sel-1"]);
});

test("scope summary model stays compact for sparse and non-sparse scopes", () => {
  const { buildScopeSummaryModel } = loadRuntimeModuleExport(
    "public/app/site/runtime/scope-insights.js",
    ["buildScopeSummaryModel"]
  );

  const sparse = buildScopeSummaryModel({
    events: [{ id: "a" }, { id: "b" }, { id: "c" }],
    kpis: {
      total: 3,
      blocked: 1,
      observed: 2,
      blockRate: 1 / 3,
      thirdPartyRatio: 2 / 3,
      peakBurst: 0,
    },
    callouts: ["Strongest concentration is domain \"tracker.example\" (66.7% of scoped events)."],
  });
  const richer = buildScopeSummaryModel({
    events: new Array(18).fill(0).map((_, index) => ({ id: `e-${index}` })),
    kpis: {
      total: 18,
      blocked: 9,
      observed: 9,
      blockRate: 0.5,
      thirdPartyRatio: 0.72,
      peakBurst: 2.3,
    },
    callouts: ["Strongest concentration is domain \"tracker.example\" (44.4% of scoped events)."],
  });

  assert.match(sparse.text, /3 events in scope/i);
  assert.match(sparse.text, /sample still thin/i);
  assert.match(richer.text, /18 events in scope/i);
  assert.match(richer.text, /50% blocked/i);
  assert.match(richer.text, /2\.3x peak burst/i);
  assert.doesNotMatch(richer.text, /tracker\.example/i);
});

test("state guidance model keeps sparse actions capped at two and prioritized", () => {
  const { buildStateGuidanceModel } = loadRuntimeModuleExport(
    "public/app/site/runtime/state-guidance.js",
    ["buildStateGuidanceModel"]
  );

  const vendorScoped = buildStateGuidanceModel({
    eventCount: 3,
    hasVendorFocus: true,
    vendorName: "Google",
    activeFilterCount: 4,
    lensPivotActive: false,
    emptyMessage: "",
    viewId: "vendorTopDomainsEndpoints",
    lowInformationThreshold: 8,
  });
  const filtered = buildStateGuidanceModel({
    eventCount: 0,
    hasVendorFocus: false,
    vendorName: "",
    activeFilterCount: 2,
    lensPivotActive: false,
    emptyMessage: "",
    viewId: "timeline",
    lowInformationThreshold: 8,
  });

  assert.equal(vendorScoped.actions.length, 2);
  assert.equal(Array.from(vendorScoped.actions, (action) => action.id).join(","), "broaden_range,clear_vendor");
  assert.equal(filtered.actions.length, 2);
  assert.equal(Array.from(filtered.actions, (action) => action.id).join(","), "broaden_range,reset_filters");
});

test("vendor scope banner model produces integrated scope copy and vault link", () => {
  const { buildVendorScopeBannerModel } = loadRuntimeModuleExport(
    "public/app/site/runtime/vendor-scope-banner.js",
    ["buildVendorScopeBannerModel"]
  );

  const model = buildVendorScopeBannerModel({
    selectedVendor: {
      vendorId: "google",
      vendorName: "Google",
    },
    scopedCount: 7,
    focusedLensPivotActive: true,
    siteName: "alpha.local",
  });

  assert.match(model.text, /Google scoped to 7 events/i);
  assert.match(model.text, /Focused timeline active/i);
  assert.match(model.href, /vendor-vault\.html\?site=alpha\.local&vendor=Google/i);
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

test("view navigation keeps advanced controls closed when entering power mode", () => {
  const { createViewNavigationController } = loadRuntimeModuleExport(
    "public/app/site/runtime/view-navigation-controller.js",
    ["createViewNavigationController"]
  );

  const controls = {
    viewModeSelect: { value: "easy" },
    vizSelect: {
      value: "timeline",
      options: [{ value: "timeline", textContent: "Timeline", dataset: {} }],
    },
    vizPositionLabel: { textContent: "" },
    vizModeHelp: { textContent: "" },
    advancedControlsPanel: { open: true },
    vizOpenDrawerBtn: { disabled: false, textContent: "", title: "" },
    privacyStatusFilter: { disabled: false, title: "" },
  };

  let viewMode = "easy";
  let vizIndex = 0;
  const controller = createViewNavigationController({
    qs: (id) => controls[id] || null,
    getDocumentBody: () => ({ classList: { toggle: () => {} } }),
    views: [{ id: "timeline", title: "Timeline" }],
    easyViewIds: new Set(["timeline"]),
    powerOnlyViewLabelSuffix: " (Power only)",
    privacyFilterAllOnlyViewIds: new Set(),
    getViewMode: () => viewMode,
    setViewModeState: (next) => { viewMode = next; },
    getVizIndex: () => vizIndex,
    setVizIndex: (next) => { vizIndex = next; },
    getVizSelection: () => null,
    getFilterState: () => ({ privacyStatus: "all" }),
    closeDrawer: () => {},
    writeFilterStateToControls: () => {},
    deriveFilteredEvents: () => {},
    renderVendorChips: () => {},
    clearVizSelection: () => {},
    renderECharts: () => {},
    renderRecentEventsFromEvents: () => {},
    getChartEvents: () => [],
    updateFilterSummary: () => {},
  });

  controller.setViewMode("power", { rerender: false });

  assert.equal(viewMode, "power");
  assert.equal(controls.advancedControlsPanel.open, false);
});

test("view navigation renders chart selector rail for allowed views only", () => {
  const { createViewNavigationController } = loadRuntimeModuleExport(
    "public/app/site/runtime/view-navigation-controller.js",
    ["createViewNavigationController"]
  );

  const controls = {
    viewModeSelect: { value: "easy" },
    vizSelect: {
      value: "timeline",
      options: [
        { value: "timeline", textContent: "Timeline", dataset: {} },
        { value: "riskTrend", textContent: "Risk trend", dataset: {} },
      ],
    },
    vizPositionLabel: { textContent: "" },
    vizModeHelp: { textContent: "" },
    vizPathSelector: { innerHTML: "" },
    advancedControlsPanel: { open: false },
    vizOpenDrawerBtn: { disabled: false, textContent: "", title: "" },
    privacyStatusFilter: { disabled: false, title: "" },
  };

  let viewMode = "easy";
  let vizIndex = 0;
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
    getVizSelection: () => null,
    getFilterState: () => ({ privacyStatus: "all" }),
    closeDrawer: () => {},
    writeFilterStateToControls: () => {},
    deriveFilteredEvents: () => {},
    renderVendorChips: () => {},
    clearVizSelection: () => {},
    renderECharts: () => {},
    renderRecentEventsFromEvents: () => {},
    getChartEvents: () => [],
    updateFilterSummary: () => {},
  });

  controller.syncVizSelectByMode();

  assert.match(controls.vizPathSelector.innerHTML, /data-viz-view-id="timeline"/);
  assert.doesNotMatch(controls.vizPathSelector.innerHTML, /data-viz-view-id="riskTrend"/);
});

test("view navigation rail follows easy-mode fallback for disallowed current view", () => {
  const { createViewNavigationController } = loadRuntimeModuleExport(
    "public/app/site/runtime/view-navigation-controller.js",
    ["createViewNavigationController"]
  );

  const controls = {
    viewModeSelect: { value: "easy" },
    vizSelect: {
      value: "riskTrend",
      options: [
        { value: "timeline", textContent: "Timeline", dataset: {} },
        { value: "riskTrend", textContent: "Risk trend", dataset: {} },
      ],
    },
    vizPositionLabel: { textContent: "" },
    vizModeHelp: { textContent: "" },
    vizPathSelector: { innerHTML: "" },
    advancedControlsPanel: { open: false },
    vizOpenDrawerBtn: { disabled: false, textContent: "", title: "" },
    privacyStatusFilter: { disabled: false, title: "" },
  };

  let viewMode = "easy";
  let vizIndex = 1;
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
    getVizSelection: () => null,
    getFilterState: () => ({ privacyStatus: "all" }),
    closeDrawer: () => {},
    writeFilterStateToControls: () => {},
    deriveFilteredEvents: () => {},
    renderVendorChips: () => {},
    clearVizSelection: () => {},
    renderECharts: () => {},
    renderRecentEventsFromEvents: () => {},
    getChartEvents: () => [],
    updateFilterSummary: () => {},
  });

  controller.syncVizSelectByMode();

  assert.equal(vizIndex, 0);
  assert.equal(controls.vizSelect.value, "timeline");
  assert.match(controls.vizPathSelector.innerHTML, /data-viz-view-id="timeline"/);
  assert.doesNotMatch(controls.vizPathSelector.innerHTML, /data-viz-view-id="riskTrend"/);
});

test("view navigation can switch charts by view id through the selector rail path", () => {
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
    vizPathSelector: { innerHTML: "" },
    advancedControlsPanel: { open: false },
    vizOpenDrawerBtn: { disabled: false, textContent: "", title: "" },
    privacyStatusFilter: { disabled: false, title: "" },
  };

  let viewMode = "power";
  let vizIndex = 0;
  const clearCalls = [];
  let chartRenders = 0;
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
    getVizSelection: () => null,
    getFilterState: () => ({ privacyStatus: "all" }),
    closeDrawer: () => {},
    writeFilterStateToControls: () => {},
    deriveFilteredEvents: () => {},
    renderVendorChips: () => {},
    clearVizSelection: (opts) => { clearCalls.push(opts); },
    renderECharts: () => { chartRenders += 1; },
    renderRecentEventsFromEvents: () => {},
    getChartEvents: () => [],
    updateFilterSummary: () => {},
  });

  controller.switchVizById("riskTrend", { focusViewId: "riskTrend" });

  assert.equal(vizIndex, 1);
  assert.equal(controls.vizSelect.value, "riskTrend");
  assert.match(controls.vizPathSelector.innerHTML, /data-viz-view-id="riskTrend"/);
  assert.equal(clearCalls.length, 1);
  assert.equal(chartRenders, 1);
});

test("chart orchestration applies readable defaults in power mode for time-based views", () => {
  const calls = [];
  const { createChartOrchestrationController } = loadRuntimeModuleExportWithoutImports(
    "public/app/site/runtime/chart-orchestration-controller.js",
    ["createChartOrchestrationController"],
    {
      summarizeVisualCategoryCounts: () => ({ total: 0, blocked: 0, observed: 0, blockedApi: 0, observedApi: 0, api: 0, other: 0 }),
    }
  );

  const controller = createChartOrchestrationController({
    getSiteLens: () => null,
    getSelectedVendor: () => null,
    setSelectedVendor: () => {},
    getVizMetric: () => "seen",
    buildVendorRollup: () => [],
    buildTimelineOption: () => ({ option: {}, meta: {} }),
    buildVendorAllowedBlockedTimelineOption: () => ({ option: {}, meta: {} }),
    buildVendorTopDomainsEndpointsOption: () => ({ option: {}, meta: {} }),
    buildTopDomainsOption: () => ({ option: {}, meta: {} }),
    buildKindsOption: () => ({ option: {}, meta: {} }),
    buildApiGatingOption: () => ({ option: {}, meta: {} }),
    buildResourceTypesOption: () => ({ option: {}, meta: {} }),
    buildModeBreakdownOption: () => ({ option: {}, meta: {} }),
    buildPartySplitOption: () => ({ option: {}, meta: {} }),
    buildHourHeatmapOption: () => ({ option: {}, meta: {} }),
    buildVendorOverviewOption: () => ({ option: {}, meta: {} }),
    buildVendorBlockRateComparisonOption: () => ({ option: {}, meta: {} }),
    buildVendorShareOverTimeOption: (events, options) => {
      calls.push({ view: "vendorShareOverTime", options });
      return { option: {}, meta: {} };
    },
    buildRiskTrendOption: (events, options) => {
      calls.push({ view: "riskTrend", options });
      return { option: {}, meta: {} };
    },
    buildBaselineDetectedBlockedTrendOption: (events, options) => {
      calls.push({ view: "baselineDetectedBlockedTrend", options });
      return { option: {}, meta: {} };
    },
    buildVendorKindMatrixOption: () => ({ option: {}, meta: {} }),
    buildRuleIdFrequencyOption: () => ({ option: {}, meta: {} }),
    setVizSelection: () => {},
    renderVendorChips: () => {},
    renderECharts: () => {},
    focusVendorDetailsUx: () => {},
    hideVendorSelectionCue: () => {},
  });

  const events = [{ id: "e1", ts: 1_000, kind: "network.observed" }];
  controller.buildViewOption("vendorShareOverTime", events, { viewMode: "power" });
  controller.buildViewOption("riskTrend", events, { viewMode: "power" });
  controller.buildViewOption("baselineDetectedBlockedTrend", events, { viewMode: "power" });

  assert.equal(calls.length, 3);
  for (const call of calls) {
    assert.equal(call.options.viewMode, "power");
    assert.equal(call.options.densityAware, true);
  }
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

test("insight visibility routes vendor-detail focus to the lower insight sheet", () => {
  let scrollTarget = null;
  const sandboxWindow = {
    scrollY: 0,
    matchMedia: () => ({ matches: true }),
    scrollTo: ({ top }) => {
      scrollTarget = top;
    },
  };
  const { createInsightVisibility } = loadRuntimeModuleExport(
    "public/app/site/runtime/insight-visibility.js",
    ["createInsightVisibility"],
    {
      window: sandboxWindow,
      document: {
        documentElement: { clientHeight: 900, scrollTop: 0 },
        body: { scrollTop: 0 },
      },
      performance: { now: () => 0 },
      requestAnimationFrame: (cb) => {
        cb(1000);
        return 1;
      },
      cancelAnimationFrame: () => {},
    }
  );

  let removedClass = "";
  let addedClass = "";
  const insightSheet = {
    getBoundingClientRect: () => ({ top: 200, bottom: 420 }),
    classList: {
      remove: (name) => {
        removedClass = name;
      },
      add: (name) => {
        addedClass = name;
      },
    },
    get offsetWidth() {
      return 320;
    },
  };

  const api = createInsightVisibility({
    qs: (id) => (id === "insightSheet" ? insightSheet : null),
  });

  api.focusVendorDetailsUx("Google", 12);

  assert.equal(removedClass, "attention-pulse");
  assert.equal(addedClass, "attention-pulse");
  assert.equal(scrollTarget, 128);
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

test("vendor share over time uses readable default zoom in low-signal power mode", () => {
  const { createChartBuilders } = loadRuntimeModuleExport(
    "public/app/site/chart-builders.js",
    ["createChartBuilders"]
  );

  const eventA = {
    id: "share-a",
    ts: 60 * 60 * 1000,
    kind: "network.observed",
    data: { domain: "tracker-a.example", isThirdParty: true },
  };
  const eventB = {
    id: "share-b",
    ts: 2 * 60 * 60 * 1000,
    kind: "network.observed",
    data: { domain: "tracker-b.example", isThirdParty: true },
  };

  const builders = createChartBuilders({
    vizOptions: {
      metric: "seen",
      seriesType: "auto",
      topN: 20,
      sort: "value_desc",
      binSize: "5m",
      normalize: false,
      stackBars: true,
    },
    binSizeMs: { "5m": 5 * 60 * 1000 },
    hoverPointStyle: { borderColor: "#38BDF8", borderWidth: 1 },
    selectedPointStyle: { borderColor: "#A78BFA", borderWidth: 2 },
    getRangeWindow: () => ({ from: 0, to: 24 * 60 * 60 * 1000 }),
    buildVendorRollup: () => [
      { vendorName: "Tracker A", seen: 1, evs: [eventA] },
      { vendorName: "Tracker B", seen: 1, evs: [eventB] },
    ],
    getKindBucket: () => "observed",
    getVisualCategoryBucket: () => "observed",
    getVendorMetricValue: () => 0,
    getResourceBucket: () => "other",
    getPartyBucket: () => "third",
    getPrivacyStatusBucket: () => "signal_detected",
    getMitigationStatusBucket: () => "observed_only",
    resourceLabels: {},
    partyLabels: {},
  });

  const built = builders.buildVendorShareOverTimeOption([eventA, eventB], { viewMode: "power", densityAware: true });

  assert.equal(built.meta.densityDefaults.applied, true);
  assert.equal(built.meta.densityDefaults.simplifiedSeries, true);
  assert.ok(
    built.meta.densityDefaults.focusedWindow === true
    || Number(built.meta.densityDefaults.appliedBinMs || 0) > Number(built.meta.densityDefaults.originalBinMs || 0)
  );
  assert.equal(built.option.series?.[0]?.type, "bar");
});

test("baseline trend uses readable default zoom in low-signal power mode", () => {
  const { createChartBuilders } = loadRuntimeModuleExport(
    "public/app/site/chart-builders.js",
    ["createChartBuilders"]
  );

  const builders = createChartBuilders({
    vizOptions: {
      metric: "seen",
      seriesType: "auto",
      topN: 20,
      sort: "value_desc",
      binSize: "5m",
      normalize: false,
      stackBars: true,
    },
    binSizeMs: { "5m": 5 * 60 * 1000 },
    hoverPointStyle: { borderColor: "#38BDF8", borderWidth: 1 },
    selectedPointStyle: { borderColor: "#A78BFA", borderWidth: 2 },
    getRangeWindow: () => ({ from: 0, to: 24 * 60 * 60 * 1000 }),
    buildVendorRollup: () => [],
    getKindBucket: () => "other",
    getVisualCategoryBucket: () => "other",
    getVendorMetricValue: () => 0,
    getResourceBucket: () => "other",
    getPartyBucket: () => "third",
    getPrivacyStatusBucket: (ev) => ev.enrichment?.privacyStatus || "unknown",
    getMitigationStatusBucket: (ev) => ev.enrichment?.mitigationStatus || "unknown",
    resourceLabels: {},
    partyLabels: {},
  });

  const built = builders.buildBaselineDetectedBlockedTrendOption([
    {
      id: "baseline-1",
      ts: 60 * 60 * 1000,
      kind: "network.observed",
      enrichment: { privacyStatus: "baseline", mitigationStatus: "observed_only" },
    },
    {
      id: "detected-1",
      ts: 2 * 60 * 60 * 1000,
      kind: "network.observed",
      enrichment: { privacyStatus: "signal_detected", mitigationStatus: "observed_only" },
    },
  ], { viewMode: "power", densityAware: true });

  assert.equal(built.meta.densityDefaults.applied, true);
  assert.ok(
    built.meta.densityDefaults.focusedWindow === true
    || Number(built.meta.densityDefaults.appliedBinMs || 0) > Number(built.meta.densityDefaults.originalBinMs || 0)
  );
});

test("browser api site narrative combines fingerprinting and sensitive-access meanings deterministically", () => {
  const { buildSiteBrowserApiNarrative } = loadRuntimeModuleExport(
    "public/app/browser-api-narratives.js",
    ["buildSiteBrowserApiNarrative"]
  );

  const narrative = buildSiteBrowserApiNarrative([
    {
      key: "api.canvas.repeated_readback",
      surfaceDetail: "canvas",
      totalCount: 2,
      observedCount: 2,
      blockedCount: 0,
      trustedAllowedCount: 0,
    },
    {
      key: "api.clipboard.async_read_text",
      surfaceDetail: "clipboard",
      totalCount: 1,
      observedCount: 0,
      blockedCount: 1,
      trustedAllowedCount: 0,
    },
  ], { subject: "this site" });

  assert.match(narrative.headline, /fingerprinting-related/i);
  assert.match(narrative.headline, /sensitive-access/i);
  assert.equal(narrative.concern.label, "Notable concern");
  assert.ok(narrative.whyItMatters.some((line) => /distinguish your browser or device/i.test(line)));
  assert.ok(narrative.whyItMatters.some((line) => /clipboard access/i.test(line)));
  assert.ok(narrative.actions.some((action) => action.href === "/?view=api-signals"));
});

test("browser api vendor narrative preserves non-assertive vendor attribution wording", () => {
  const { buildVendorBrowserApiNarrative } = loadRuntimeModuleExport(
    "public/app/browser-api-narratives.js",
    ["buildVendorBrowserApiNarrative"]
  );

  const vendorNarrative = buildVendorBrowserApiNarrative([
    {
      key: "api.webrtc.stun_turn_assisted_probe",
      surfaceDetail: "webrtc",
      totalCount: 3,
      observedCount: 2,
      blockedCount: 1,
      trustedAllowedCount: 0,
    },
  ], { section: "vendor" });

  const contextualNarrative = buildVendorBrowserApiNarrative([
    {
      key: "api.canvas.readback",
      surfaceDetail: "canvas",
      totalCount: 1,
      observedCount: 1,
      blockedCount: 0,
      trustedAllowedCount: 0,
    },
    {
      key: "geolocation",
      surfaceDetail: "geolocation",
      totalCount: 1,
      observedCount: 1,
      blockedCount: 0,
      trustedAllowedCount: 0,
    },
  ], { section: "contextual" });

  assert.match(vendorNarrative.headline, /may be using WebRTC activity/i);
  assert.equal(/proof/i.test(vendorNarrative.headline), false);
  assert.match(contextualNarrative.headline, /not directly attributable to this vendor/i);
  assert.ok(contextualNarrative.actions.some((action) => action.href === "/?view=api-signals"));
});
