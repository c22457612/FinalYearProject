import { createChartBuilders } from "../chart-builders.js";
import { createSidebarModules } from "./sidebar-modules.js";
import { createScopeInsights } from "./scope-insights.js";
import { createInsightVisibility } from "./insight-visibility.js";
import { createInsightSheet } from "./insight-sheet.js";
import { createVendorScope } from "./vendor-scope.js";
import { createViewNavigationController } from "./view-navigation-controller.js";
import { createPollingController } from "./polling-controller.js";
import { createSelectionController } from "./selection-controller.js";
import { createChartOrchestrationController } from "./chart-orchestration-controller.js";
import {
  defaultFilterState,
  defaultVizOptions,
  getKindBucket,
  getPartyBucket,
  getResourceBucket,
  getPrivacyStatusBucket,
  getMitigationStatusBucket,
  matchesFilters,
  getActiveFilterLabels as computeActiveFilterLabels,
  getActiveVizOptionLabels as computeActiveVizOptionLabels,
  readFilterStateFromControls as readFilterStateFromDom,
  writeFilterStateToControls as writeFilterStateToDom,
  readVizOptionsFromControls as readVizOptionsFromDom,
  writeVizOptionsToControls as writeVizOptionsToDom,
} from "../filter-state.js";
import {
  qs,
  getQueryParam,
  friendlyTime,
  getEventKey,
  pickPrimarySelectedEvent,
  formatSelectedLead,
  triggerDownload,
  buildExportUrl,
  formatPercent,
  escapeCsvCell,
  debounce,
} from "../utils.js";

const POLL_MS = 3000;

let siteName = null;
let latestSiteData = null;

let chart = null;
let windowEvents = [];
let filteredEvents = [];
let filteredEventsSourceRef = null;
let filteredEventsFilterSignature = "";
let vizIndex = 0;
let vizSelection = null; // { type, value, bucketKey?, events, fromTs, toTs, title, summaryHtml }

let lastWindowFetchKey = null;
let lastWindowFetchAt = 0;
let isFetchSiteInFlight = false;
let viewMode = "easy"; // easy | power
let selectedVendor = null; // { vendorId, vendorName, ... } | null
let selectedInsightTarget = null;
let focusedLensPivotActive = false;
const dataZoomStateByView = new Map(); // key: effective view id, value: { start, end }
let selectedChartPoint = null; // { viewId, effectiveViewId, seriesIndex, dataIndex, semanticKey }
let selectedRecentEventKey = "";
const chartRenderPerfState = {
  chartRef: null,
  eventsRef: null,
  requestedViewId: "",
  selectedVendorId: "",
  viewMode: "",
  vizSignature: "",
};
const CHART_SELECTED_ACCENT = "#A78BFA";
const CHART_HOVER_ACCENT = "#38BDF8";
const CHART_SELECTED_BAND_FILL = "rgba(167,139,250,0.14)";
const CHART_HOVER_BAND_FILL = "rgba(56,189,248,0.10)";
const INTERACTION_OVERLAY_SERIES_ID = "__vpt-interaction-overlay";
const SELECTED_POINT_STYLE = Object.freeze({
  borderColor: CHART_SELECTED_ACCENT,
  borderWidth: 2,
});
const HOVER_POINT_STYLE = Object.freeze({
  borderColor: CHART_HOVER_ACCENT,
  borderWidth: 1,
});

let filterState = defaultFilterState();
let vizOptions = defaultVizOptions();

const VIEWS = [
  { id: "vendorOverview", title: "Vendor activity overview" },
  { id: "vendorAllowedBlockedTimeline", title: "Vendor allowed vs blocked timeline" },
  { id: "vendorTopDomainsEndpoints", title: "Where this vendor connects (top domains/endpoints)" },
  { id: "riskTrend", title: "Risk trend timeline" },
  { id: "baselineDetectedBlockedTrend", title: "Baseline vs detected vs blocked trend" },
  { id: "timeline", title: "Activity timeline (last 24h)" },
  { id: "topSeen", title: "Top third-party domains (seen)" },
  { id: "kinds", title: "Event breakdown (kind)" },
  { id: "apiGating", title: "3P API-like calls (heuristic)" },
  { id: "vendorKindMatrix", title: "Vendor-kind matrix" },
  { id: "ruleIdFrequency", title: "Rule ID frequency" },
  { id: "resourceTypes", title: "Resource type breakdown" },
  { id: "modeBreakdown", title: "Protection mode breakdown" },
  { id: "partySplit", title: "Party split (first vs third)" },
  { id: "hourHeatmap", title: "Activity heatmap (hour x day)" },
];

const EASY_VIEW_IDS = new Set([
  "vendorOverview",
  "vendorAllowedBlockedTimeline",
  "vendorTopDomainsEndpoints",
  "kinds",
  "riskTrend",
  "baselineDetectedBlockedTrend",
  "partySplit",
]);
const POWER_ONLY_VIEW_LABEL_SUFFIX = " (Power only)";
const LOW_INFORMATION_EVENT_THRESHOLD = 8;
const PRIVACY_FILTER_ALL_ONLY_VIEW_IDS = new Set();

const RANGE_MS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  all: null,
};

const BIN_SIZE_MS = {
  "1m": 60 * 1000,
  "5m": 5 * 60 * 1000,
  "15m": 15 * 60 * 1000,
  "60m": 60 * 60 * 1000,
};

const RESOURCE_LABELS = {
  script: "Script",
  xhr_fetch: "XHR/Fetch",
  image: "Image",
  sub_frame: "Sub-frame",
  other: "Other",
};

const PARTY_LABELS = {
  third: "Third-party",
  first_or_unknown: "First/unknown",
};

const SURFACE_LABELS = {
  network: "Network",
  cookies: "Cookies",
  storage: "Storage",
  browser_api: "Browser API",
  script: "Script",
  unknown: "Unknown",
};

const PRIVACY_STATUS_LABELS = {
  baseline: "Baseline",
  signal_detected: "Signal detected",
  high_risk: "High risk",
  policy_blocked: "Policy blocked",
  policy_allowed: "Policy allowed",
  unknown: "Unknown",
};

const MITIGATION_STATUS_LABELS = {
  allowed: "Allowed",
  blocked: "Blocked",
  observed_only: "Observed only",
  modified: "Modified",
  unknown: "Unknown",
};

const vendorScope = createVendorScope({
  qs,
  getVendorTaxonomy,
  getFilteredEvents: () => filteredEvents,
  getSelectedVendor: () => selectedVendor,
  setSelectedVendor: (next) => {
    selectedVendor = next;
  },
  getViewMode: () => viewMode,
  getVizMetric: () => vizOptions.metric,
  setSelectedInsightTarget: (next) => {
    selectedInsightTarget = next;
  },
  hideVendorSelectionCue,
  clearVizSelection,
  renderECharts,
  renderRecentEventsFromEvents,
  updateFilterSummary,
  focusVendorDetailsUx,
});

const chartBuilders = createChartBuilders({
  vizOptions,
  binSizeMs: BIN_SIZE_MS,
  hoverPointStyle: HOVER_POINT_STYLE,
  selectedPointStyle: SELECTED_POINT_STYLE,
  getRangeWindow,
  buildVendorRollup,
  getVendorMetricValue,
  getResourceBucket,
  getPartyBucket,
  getPrivacyStatusBucket,
  getMitigationStatusBucket,
  resourceLabels: RESOURCE_LABELS,
  partyLabels: PARTY_LABELS,
});

const chartOrchestrationController = createChartOrchestrationController({
  getSiteLens,
  getSelectedVendor: () => selectedVendor,
  setSelectedVendor: (next) => {
    selectedVendor = next;
  },
  getVizMetric: () => vizOptions.metric,
  buildVendorRollup,
  buildTimelineOption: chartBuilders.buildTimelineOption,
  buildVendorAllowedBlockedTimelineOption: chartBuilders.buildVendorAllowedBlockedTimelineOption,
  buildVendorTopDomainsEndpointsOption: chartBuilders.buildVendorTopDomainsEndpointsOption,
  buildTopDomainsOption: chartBuilders.buildTopDomainsOption,
  buildKindsOption: chartBuilders.buildKindsOption,
  buildApiGatingOption: chartBuilders.buildApiGatingOption,
  buildResourceTypesOption: chartBuilders.buildResourceTypesOption,
  buildModeBreakdownOption: chartBuilders.buildModeBreakdownOption,
  buildPartySplitOption: chartBuilders.buildPartySplitOption,
  buildHourHeatmapOption: chartBuilders.buildHourHeatmapOption,
  buildVendorOverviewOption: chartBuilders.buildVendorOverviewOption,
  buildRiskTrendOption: chartBuilders.buildRiskTrendOption,
  buildBaselineDetectedBlockedTrendOption: chartBuilders.buildBaselineDetectedBlockedTrendOption,
  buildVendorKindMatrixOption: chartBuilders.buildVendorKindMatrixOption,
  buildRuleIdFrequencyOption: chartBuilders.buildRuleIdFrequencyOption,
  setVizSelection,
  renderVendorChips,
  renderECharts,
  focusVendorDetailsUx,
  hideVendorSelectionCue,
});

const sidebarModules = createSidebarModules({
  qs,
  friendlyTime,
  pickPrimarySelectedEvent,
  formatSelectedLead,
  getRangeKey,
  getViewMode: () => viewMode,
  getFilterState: () => filterState,
  getSelectedVendor: () => selectedVendor,
  getFilteredEvents: () => filteredEvents,
  getVizSelection: () => vizSelection,
  getChartEvents,
  getActiveVizOptionLabels,
  getVendorMetricValue,
  buildVendorRollup,
  partyLabels: PARTY_LABELS,
  resourceLabels: RESOURCE_LABELS,
  surfaceLabels: SURFACE_LABELS,
  privacyStatusLabels: PRIVACY_STATUS_LABELS,
  mitigationStatusLabels: MITIGATION_STATUS_LABELS,
  onResetFilters: () => {
    filterState = defaultFilterState();
    writeFilterStateToControls();
    applyFilterChanges();
  },
});

const insightVisibility = createInsightVisibility({
  qs,
  onSelectVendorProfileModule: () => {
    sidebarModules.selectModule("vendorProfile");
  },
});

const insightSheet = createInsightSheet({
  qs,
  friendlyTime,
  pickPrimarySelectedEvent,
  formatSelectedLead,
  triggerDownload,
  escapeCsvCell,
  getInsightRules,
  ensureInsightVisible,
  getViewMode: () => viewMode,
  getSiteName: () => siteName,
  getSelectedVendor: () => selectedVendor,
  getViews: () => VIEWS,
  getVizIndex: () => vizIndex,
});

function setStatus(ok, text) {
  const el = qs("siteConnectionStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? "#10b981" : "#f97316";
}

function getRangeKey() {
  return qs("rangeSelect")?.value || "24h";
}

function getRangeWindow() {
  const key = getRangeKey();
  const span = RANGE_MS[key];
  const to = Date.now();
  const from = span ? (to - span) : null;
  return { key, from, to };
}

function getVendorTaxonomy() {
  return window.VPT?.vendorTaxonomy || null;
}

function getInsightRules() {
  return window.VPT?.insightRules || null;
}

function getSiteLens() {
  return window.VPT?.siteLens || null;
}

const viewNavigationController = createViewNavigationController({
  qs,
  getDocumentBody: () => document.body,
  views: VIEWS,
  easyViewIds: EASY_VIEW_IDS,
  powerOnlyViewLabelSuffix: POWER_ONLY_VIEW_LABEL_SUFFIX,
  privacyFilterAllOnlyViewIds: PRIVACY_FILTER_ALL_ONLY_VIEW_IDS,
  getViewMode: () => viewMode,
  setViewModeState: (next) => {
    viewMode = next;
  },
  getVizIndex: () => vizIndex,
  setVizIndex: (next) => {
    vizIndex = next;
  },
  getVizSelection: () => vizSelection,
  getFilterState: () => filterState,
  closeDrawer,
  writeFilterStateToControls,
  deriveFilteredEvents,
  renderVendorChips,
  clearVizSelection,
  renderECharts,
  renderRecentEventsFromEvents,
  getChartEvents,
  updateFilterSummary,
});

const selectionController = createSelectionController({
  pickPrimarySelectedEvent,
  getEventKey,
  getVizSelection: () => vizSelection,
  setVizSelectionState: (next) => {
    vizSelection = next;
  },
  setSelectedInsightTarget: (next) => {
    selectedInsightTarget = next;
  },
  setSelectedRecentEventKey: (next) => {
    selectedRecentEventKey = next;
  },
  clearActiveEvidence: () => {
    insightSheet.clearActiveEvidence();
  },
  clearChartSelectionHighlight,
  setSelectedChartPoint: (next) => {
    selectedChartPoint = next;
  },
  applyChartSelectionHighlight,
  clearBrushSelection,
  closeDrawer,
  closeInsightSheet,
  renderRecentEventsFromEvents,
  getChartEvents,
  syncInteractionOverlayOnCurrentChart,
  updateDrawerButtonState,
  updateFilterSummary,
  openInsightSheet,
  getViews: () => VIEWS,
  getVizIndex: () => vizIndex,
  resetInsightSection,
  ensureInsightVisible,
});

const pollingController = createPollingController({
  getSiteName: () => siteName,
  getRangeWindow,
  getWindowEvents: () => windowEvents,
  setWindowEvents: (next) => {
    windowEvents = next;
  },
  getLastWindowFetchKey: () => lastWindowFetchKey,
  setLastWindowFetchKey: (next) => {
    lastWindowFetchKey = next;
  },
  getLastWindowFetchAt: () => lastWindowFetchAt,
  setLastWindowFetchAt: (next) => {
    lastWindowFetchAt = next;
  },
  getIsFetchSiteInFlight: () => isFetchSiteInFlight,
  setIsFetchSiteInFlight: (next) => {
    isFetchSiteInFlight = next;
  },
  getLatestSiteData: () => latestSiteData,
  setLatestSiteData: (next) => {
    latestSiteData = next;
  },
  setStatus,
  renderHeader,
  renderStats,
  renderTopThirdParties,
  deriveFilteredEvents,
  renderVendorChips,
  getVizSelection: () => vizSelection,
  selectionStillValid,
  clearVizSelection,
  renderECharts,
  renderRecentEventsFromEvents,
  getSelectedRecentEventKey: () => selectedRecentEventKey,
  getChartEvents,
  updateFilterSummary,
  renderRecentEvents,
});

function isViewAllowed(viewId, mode = viewMode) {
  return viewNavigationController.isViewAllowed(viewId, mode);
}

function getAllowedViews(mode = viewMode) {
  return viewNavigationController.getAllowedViews(mode);
}

function getCurrentViewId() {
  return viewNavigationController.getCurrentViewId();
}

function applyViewFilterPolicy() {
  return viewNavigationController.applyViewFilterPolicy();
}

function updateVizPositionLabel() {
  viewNavigationController.updateVizPositionLabel();
}

function updateViewAvailabilityHint() {
  viewNavigationController.updateViewAvailabilityHint();
}

function updateDrawerButtonState() {
  viewNavigationController.updateDrawerButtonState();
}

function syncVizSelectByMode() {
  viewNavigationController.syncVizSelectByMode();
}

function setViewMode(mode, opts = {}) {
  viewNavigationController.setViewMode(mode, opts);
}

function switchViz(newIndex) {
  viewNavigationController.switchViz(newIndex);
}

function classifyVendorForEvent(ev) {
  return vendorScope.classifyVendorForEvent(ev);
}

function eventMatchesSelectedVendor(ev) {
  return vendorScope.eventMatchesSelectedVendor(ev);
}

function getChartEvents() {
  return vendorScope.getChartEvents();
}

function renderHeader(data) {
  qs("siteTitle").textContent = `Site insights: ${siteName}`;
  qs("siteSubtitle").textContent =
    `Last updated: ${data?.lastSeen ? new Date(data.lastSeen).toLocaleString() : "-"}`;

  const csvBtn = qs("exportSiteCsvBtn");
  const jsonBtn = qs("exportSiteJsonBtn");
  if (csvBtn) csvBtn.disabled = false;
  if (jsonBtn) jsonBtn.disabled = false;
}

function renderStats(data) {
  qs("siteStatTotal").textContent = data.totalEvents ?? 0;
  qs("siteStatBlocked").textContent = data.blockedCount ?? 0;
  qs("siteStatObserved").textContent = data.observedCount ?? 0;
  qs("siteStatUniqueThird").textContent = data.uniqueThirdParties ?? 0;
}

function renderTopThirdParties(data) {
  const tbody = qs("topThirdBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const list = Array.isArray(data.topThirdParties) ? data.topThirdParties : [];

  if (!list.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted";
    td.textContent = "No third-party domains recorded yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const item of list) {
    const tr = document.createElement("tr");

    const tdDomain = document.createElement("td");
    tdDomain.textContent = item.domain || "-";
    tr.appendChild(tdDomain);

    const tdSeen = document.createElement("td");
    tdSeen.textContent = item.seen ?? 0;
    tr.appendChild(tdSeen);

    const tdBlocked = document.createElement("td");
    tdBlocked.textContent = item.blocked ?? 0;
    tr.appendChild(tdBlocked);

    const tdObs = document.createElement("td");
    tdObs.textContent = item.observed ?? 0;
    tr.appendChild(tdObs);

    tbody.appendChild(tr);
  }
}

function renderRecentEvents(data) {
  const events = Array.isArray(data?.recentEvents) ? data.recentEvents : [];
  renderRecentEventsFromEvents(events, "No events for this site yet.");
}

function renderRecentEventsFromEvents(events, emptyMessage = "No events match current filters.", opts = {}) {
  const tbody = qs("recentEventsBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const list = Array.isArray(events) ? events : [];
  const selectedEventKey = String(opts?.selectedEventKey || "");

  if (!list.length) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted";
    td.textContent = emptyMessage;
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const ev of list.slice(-100)) {
    const tr = document.createElement("tr");
    tr.classList.add("recent-event-row");
    const rowKey = getEventKey(ev);
    if (selectedEventKey && rowKey === selectedEventKey) {
      tr.classList.add("event-row-selected");
    }

    const tdTime = document.createElement("td");
    tdTime.textContent = friendlyTime(ev.ts);
    tr.appendChild(tdTime);

    const tdKind = document.createElement("td");
    tdKind.textContent = ev.kind || "-";
    tr.appendChild(tdKind);

    const tdDomain = document.createElement("td");
    tdDomain.textContent = ev.data?.domain || "-";
    tr.appendChild(tdDomain);

    const tdMode = document.createElement("td");
    tdMode.textContent = ev.mode || "-";
    tr.appendChild(tdMode);

    frag.appendChild(tr);
  }

  tbody.appendChild(frag);
}

function deriveFilteredEvents() {
  const base = Array.isArray(windowEvents) ? windowEvents : [];
  const nextFilterSignature = [
    filterState.kind?.blocked ? "1" : "0",
    filterState.kind?.observed ? "1" : "0",
    filterState.kind?.other ? "1" : "0",
    String(filterState.party || "all"),
    String(filterState.resource || "all"),
    String(filterState.surface || "all"),
    String(filterState.privacyStatus || "all"),
    String(filterState.mitigationStatus || "all"),
    String(filterState.domainText || "").trim().toLowerCase(),
  ].join("|");

  if (filteredEventsSourceRef === base && filteredEventsFilterSignature === nextFilterSignature) {
    updateFilterSummary();
    return filteredEvents;
  }

  filteredEvents = base.filter((ev) => matchesFilters(ev, filterState));
  filteredEventsSourceRef = base;
  filteredEventsFilterSignature = nextFilterSignature;
  updateFilterSummary();
  return filteredEvents;
}

function getActiveFilterLabels() {
  return computeActiveFilterLabels(filterState);
}

function getActiveVizOptionLabels() {
  return computeActiveVizOptionLabels(vizOptions);
}

function updateFilterSummary() {
  const el = qs("filterSummary");
  if (!el) return;

  const baseCount = Array.isArray(windowEvents) ? windowEvents.length : 0;
  const filteredCount = Array.isArray(filteredEvents) ? filteredEvents.length : 0;
  const scopedCount = getChartEvents().length;

  const parts = selectedVendor?.vendorId
    ? [`Showing ${scopedCount} vendor-scoped of ${filteredCount} filtered (${baseCount} total)`]
    : [`Showing ${filteredCount} of ${baseCount} events`];
  const activeLabels = getActiveFilterLabels();
  if (activeLabels.length) parts.push(`filters: ${activeLabels.join(", ")}`);

  const vizLabels = getActiveVizOptionLabels();
  if (vizLabels.length) parts.push(`viz: ${vizLabels.join(", ")}`);
  parts.push(`mode: ${viewMode}`);
  if (selectedVendor?.vendorName) parts.push(`vendor: ${selectedVendor.vendorName}`);

  if (vizSelection?.events?.length) {
    parts.push(`selection: ${vizSelection.events.length}`);
  }

  el.textContent = parts.join(" | ");
  renderVendorScopeBanner();
  sidebarModules.renderSidebarModules();
}

function renderStateGuidance({ events = [], lensPivotActive = false, emptyMessage = "" } = {}) {
  const box = qs("vizStateGuidance");
  if (!box) return;

  const list = Array.isArray(events) ? events : [];
  const activeFilters = getActiveFilterLabels();
  const hasVendorFocus = !!selectedVendor?.vendorId;
  const rangeLabel = qs("rangeSelect")?.selectedOptions?.[0]?.textContent || getRangeKey();
  const steps = [];
  let title = String(emptyMessage || "").trim();

  const addStep = (text) => {
    const value = String(text || "").trim();
    if (!value || steps.includes(value)) return;
    steps.push(value);
  };

  if (!list.length) {
    if (!title) {
      title = hasVendorFocus
        ? `No events are available for ${selectedVendor.vendorName || "the selected vendor"} in this scope.`
        : "No events match the current scope.";
    }

    addStep(`Broaden range in View controls (current: ${rangeLabel}).`);
    if (hasVendorFocus) addStep("Clear vendor focus to compare all vendors.");
    if (activeFilters.length) addStep("Use Reset filters to remove strict filters.");
    if (!hasVendorFocus && !activeFilters.length) addStep("Wait for more captured events, then refresh this view.");
  } else if (!title && list.length < LOW_INFORMATION_EVENT_THRESHOLD) {
    title = `Low-information view: only ${list.length} events in the current scope.`;
    addStep(`Broaden range in View controls (current: ${rangeLabel}).`);
    if (hasVendorFocus) addStep("Clear vendor focus to compare all vendors.");
    if (activeFilters.length) addStep("Use Reset filters to remove strict filters.");
    addStep("Try a broader chart mode if this one stays sparse.");
  } else if (title) {
    addStep("Try a broader chart mode if this one has no usable groups.");
    addStep(`Broaden range in View controls (current: ${rangeLabel}).`);
    if (hasVendorFocus) addStep("Clear vendor focus to compare all vendors.");
    if (activeFilters.length) addStep("Use Reset filters to remove strict filters.");
  }

  if (lensPivotActive) {
    addStep("Clear vendor focus to compare all vendors side-by-side.");
  }

  if (!title) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  box.classList.remove("hidden");
  box.innerHTML = "";

  const heading = document.createElement("div");
  heading.className = "viz-state-guidance-title";
  heading.textContent = title;
  box.appendChild(heading);

  if (steps.length) {
    const listEl = document.createElement("ul");
    listEl.className = "viz-state-guidance-list";
    for (const step of steps) {
      const li = document.createElement("li");
      li.textContent = step;
      listEl.appendChild(li);
    }
    box.appendChild(listEl);
  }
}

function renderTopBucketSummary(viewId, meta = null) {
  const box = qs("vizTopBucketSummary");
  if (!box) return;

  if (viewId !== "vendorTopDomainsEndpoints") {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }

  const summary = meta?.topBucketSummary || null;
  if (!summary) {
    box.classList.add("hidden");
    box.textContent = "";
    return;
  }

  box.classList.remove("hidden");
  box.textContent = `Top bucket: ${summary.displayLabel} (${summary.seen} total; ${summary.blocked} blocked, ${summary.observed} observed, ${summary.other} other)`;
}

function readFilterStateFromControls() {
  readFilterStateFromDom(qs, filterState);
}

function writeFilterStateToControls() {
  writeFilterStateToDom(qs, filterState);
}

function readVizOptionsFromControls() {
  readVizOptionsFromDom(qs, vizOptions);
}

function writeVizOptionsToControls() {
  writeVizOptionsToDom(qs, vizOptions);
}

function closeDrawer() {
  insightSheet.closeDrawer();
}

function ensureInsightVisible({ force = false, source = "selection" } = {}) {
  insightVisibility.ensureInsightVisible({ force, source });
}

function hideVendorSelectionCue() {
  insightVisibility.hideVendorSelectionCue();
}

function focusVendorDetailsUx(vendorName, count = 0) {
  insightVisibility.focusVendorDetailsUx(vendorName, count);
}

function resetInsightSection() {
  insightSheet.resetInsightSection();
}

function closeInsightSheet() {
  insightSheet.closeInsightSheet();
}

function closeConfirmModal() {
  insightSheet.closeConfirmModal();
}

function openInsightSheet(selection, evidence, opts) {
  insightSheet.openInsightSheet(selection, evidence, opts);
}

function clearBrushSelection() {
  try {
    chart?.dispatchAction?.({ type: "brush", areas: [] });
  } catch {
    // ignore ECharts brush clear errors
  }
}

function isVendorEndpointBucketView(viewId) {
  return String(viewId || "") === "vendorTopDomainsEndpoints";
}

function findCategoryDataIndex(option, label) {
  const target = String(label || "");
  if (!target) return -1;

  const axisCollections = [];
  if (Array.isArray(option?.xAxis)) axisCollections.push(...option.xAxis);
  else if (option?.xAxis) axisCollections.push(option.xAxis);
  if (Array.isArray(option?.yAxis)) axisCollections.push(...option.yAxis);
  else if (option?.yAxis) axisCollections.push(option.yAxis);

  for (const axis of axisCollections) {
    if (String(axis?.type || "") !== "category" || !Array.isArray(axis?.data)) continue;
    const idx = axis.data.findIndex((value) => String(value) === target);
    if (idx >= 0) return idx;
  }
  return -1;
}

function resolveChartPointForOption(point, option, effectiveViewId) {
  if (!point || !option) return null;
  if (point.effectiveViewId && effectiveViewId && point.effectiveViewId !== effectiveViewId) return null;

  const seriesList = Array.isArray(option?.series) ? option.series : [];
  if (!seriesList.length) return null;

  let seriesIndex = typeof point.seriesIndex === "number" ? point.seriesIndex : 0;
  if (seriesIndex < 0 || seriesIndex >= seriesList.length) seriesIndex = 0;

  const seriesData = Array.isArray(seriesList[seriesIndex]?.data) ? seriesList[seriesIndex].data : [];
  let dataIndex = typeof point.dataIndex === "number" ? point.dataIndex : -1;
  if (dataIndex >= 0 && dataIndex < seriesData.length) {
    return { seriesIndex, dataIndex };
  }

  const semanticKey = String(point.semanticKey || "");
  if (semanticKey.startsWith("bin:")) {
    const idx = Number(semanticKey.slice(4));
    if (Number.isInteger(idx) && idx >= 0 && idx < seriesData.length) {
      return { seriesIndex, dataIndex: idx };
    }
  }

  if (semanticKey.startsWith("label:")) {
    const label = semanticKey.slice(6);
    const idx = findCategoryDataIndex(option, label);
    if (idx >= 0 && idx < seriesData.length) {
      return { seriesIndex, dataIndex: idx };
    }
  }

  if (semanticKey.startsWith("cell:")) {
    const [rawX, rawY] = semanticKey.slice(5).split(":");
    const x = Number(rawX);
    const y = Number(rawY);
    const idx = seriesData.findIndex((item) => {
      const value = Array.isArray(item)
        ? item
        : Array.isArray(item?.value)
          ? item.value
          : null;
      return Array.isArray(value) && Number(value[0]) === x && Number(value[1]) === y;
    });
    if (idx >= 0) {
      return { seriesIndex, dataIndex: idx };
    }
  }

  return null;
}

function resolveChartPointForCurrentChart(point) {
  if (!point || !chart) return null;
  const option = chart.getOption?.();
  const currentEffectiveView = chart?.__vptMeta?.effectiveViewId || VIEWS[vizIndex]?.id;
  return resolveChartPointForOption(point, option, currentEffectiveView);
}

function readPointXValue(item, fallbackIndex) {
  if (Array.isArray(item) && item.length) return item[0];
  if (item && typeof item === "object") {
    if (Array.isArray(item.value) && item.value.length) return item.value[0];
    if (item.value !== null && item.value !== undefined) return item.value;
  }
  return fallbackIndex;
}

function buildSelectionMarkerForOption(option, effectiveViewId) {
  if (!option || !selectedChartPoint) return null;
  const resolved = resolveChartPointForOption(selectedChartPoint, option, effectiveViewId);
  if (!resolved) return null;

  const xAxis = Array.isArray(option.xAxis) ? option.xAxis[0] : option.xAxis;
  const axisType = String(xAxis?.type || "category");
  const series = Array.isArray(option.series) ? option.series[resolved.seriesIndex] : null;
  const seriesData = Array.isArray(series?.data) ? series.data : [];
  const item = seriesData[resolved.dataIndex];
  const rawX = readPointXValue(item, resolved.dataIndex);

  if (axisType === "category") {
    let center = Number(rawX);
    if (!Number.isFinite(center)) center = resolved.dataIndex;
    if (!Number.isFinite(center)) return null;
    return {
      center,
      start: center - 0.18,
      end: center + 0.18,
      resolved,
    };
  }

  const center = Number(rawX);
  if (!Number.isFinite(center)) return null;
  const span = axisType === "time"
    ? Math.max(1000, Math.round(getTimelineBinMs() / 10))
    : Math.max(0.001, Math.abs(center) * 0.01 || 1);

  return {
    center,
    start: center - span,
    end: center + span,
    resolved,
  };
}

function createSelectedDataPoint(value) {
  if (Array.isArray(value)) {
    return {
      value: value.slice(),
      itemStyle: { ...SELECTED_POINT_STYLE },
    };
  }

  if (value && typeof value === "object") {
    const next = { ...value };
    if (Array.isArray(next.value)) next.value = next.value.slice();
    next.itemStyle = {
      ...(next.itemStyle || {}),
      ...SELECTED_POINT_STYLE,
    };
    return next;
  }

  return {
    value,
    itemStyle: { ...SELECTED_POINT_STYLE },
  };
}

function applyPersistentSelectionStyleToOption(option, effectiveViewId) {
  if (!option || !selectedChartPoint) return null;
  if (selectedChartPoint.highlightMode === "stacked-row") return null;
  const resolved = resolveChartPointForOption(selectedChartPoint, option, effectiveViewId);
  if (!resolved) return null;

  const seriesList = Array.isArray(option.series) ? option.series : [];
  const targetSeries = seriesList[resolved.seriesIndex];
  if (!targetSeries || !Array.isArray(targetSeries.data) || !targetSeries.data.length) return null;
  if (resolved.dataIndex < 0 || resolved.dataIndex >= targetSeries.data.length) return null;

  targetSeries.data[resolved.dataIndex] = createSelectedDataPoint(targetSeries.data[resolved.dataIndex]);
  return resolved;
}

function buildInteractionOverlaySeries(marker) {
  return {
    id: INTERACTION_OVERLAY_SERIES_ID,
    type: "line",
    data: [],
    symbol: "none",
    silent: true,
    animation: false,
    tooltip: { show: false },
    lineStyle: { opacity: 0 },
    markLine: {
      symbol: ["none", "none"],
      silent: true,
      label: { show: false },
      lineStyle: {
        color: CHART_SELECTED_ACCENT,
        width: 2,
        type: "solid",
      },
      data: marker ? [{ xAxis: marker.center }] : [],
    },
    markArea: {
      silent: true,
      itemStyle: { color: CHART_SELECTED_BAND_FILL },
      data: marker ? [[{ xAxis: marker.start }, { xAxis: marker.end }]] : [],
    },
  };
}

function syncInteractionOverlayOnCurrentChart() {
  if (!chart) return;
  const effectiveViewId = chart?.__vptMeta?.effectiveViewId || VIEWS[vizIndex]?.id;
  if (isVendorEndpointBucketView(effectiveViewId)) return;

  const option = chart.getOption?.();
  const marker = buildSelectionMarkerForOption(option, effectiveViewId);
  const overlay = buildInteractionOverlaySeries(marker);

  try {
    chart.setOption({ series: [overlay] }, false);
  } catch {
    // ignore overlay merge failures during rapid chart updates
  }
}

function highlightStackedRowSelection(point) {
  if (!chart || !point) return;
  const resolved = resolveChartPointForCurrentChart(point);
  const dataIndex = typeof resolved?.dataIndex === "number"
    ? resolved.dataIndex
    : (typeof point.dataIndex === "number" ? point.dataIndex : -1);
  if (dataIndex < 0) return;

  const option = chart.getOption?.();
  const seriesList = Array.isArray(option?.series) ? option.series : [];

  try {
    chart.dispatchAction({ type: "downplay" });
    for (let i = 0; i < seriesList.length; i++) {
      const series = seriesList[i];
      if (!series || series.id === INTERACTION_OVERLAY_SERIES_ID) continue;
      const data = Array.isArray(series.data) ? series.data : [];
      if (dataIndex < 0 || dataIndex >= data.length) continue;
      chart.dispatchAction({ type: "highlight", seriesIndex: i, dataIndex });
    }
  } catch {
    // ignore highlight errors when chart updates between renders
  }

  selectedChartPoint = {
    ...point,
    seriesIndex: 0,
    dataIndex,
  };
}

function clearChartSelectionHighlight() {
  if (selectedChartPoint && chart) {
    if (selectedChartPoint.highlightMode === "stacked-row") {
      try {
        chart.dispatchAction({ type: "downplay" });
      } catch {
        // ignore downplay errors on chart reset
      }
      selectedChartPoint = null;
      return;
    }

    const resolved = resolveChartPointForCurrentChart(selectedChartPoint) || selectedChartPoint;
    try {
      if (typeof resolved?.seriesIndex === "number" && typeof resolved?.dataIndex === "number") {
        chart.dispatchAction({ type: "downplay", seriesIndex: resolved.seriesIndex, dataIndex: resolved.dataIndex });
      } else if (typeof resolved?.seriesIndex === "number") {
        chart.dispatchAction({ type: "downplay", seriesIndex: resolved.seriesIndex });
      }
    } catch {
      // ignore downplay errors on chart reset
    }
  }
  selectedChartPoint = null;
}

function applyChartSelectionHighlight() {
  if (!selectedChartPoint || !chart) return;
  if (selectedChartPoint.highlightMode === "stacked-row") {
    highlightStackedRowSelection(selectedChartPoint);
    return;
  }

  const resolved = resolveChartPointForCurrentChart(selectedChartPoint);
  if (!resolved) return;

  try {
    chart.dispatchAction({ type: "downplay", seriesIndex: resolved.seriesIndex });
    chart.dispatchAction({ type: "highlight", seriesIndex: resolved.seriesIndex, dataIndex: resolved.dataIndex });
  } catch {
    // ignore highlight errors when chart updates between renders
  }

  selectedChartPoint = {
    ...selectedChartPoint,
    seriesIndex: resolved.seriesIndex,
    dataIndex: resolved.dataIndex,
  };
}

function reapplyChartSelectionHighlight() {
  if (!vizSelection?.events?.length || !selectedChartPoint) return;
  applyChartSelectionHighlight();
}

function clearVizSelection({
  close = true,
  clearBrush = true,
  renderTable = true,
  updateSummary = true,
} = {}) {
  selectionController.clearVizSelection({ close, clearBrush, renderTable, updateSummary });
}

function setVizSelection({
  type,
  value,
  fromTs = null,
  toTs = null,
  bucketKey = "",
  bucketLabel = "",
  seen = 0,
  blocked = 0,
  observed = 0,
  other = 0,
  bucketExample = "",
  title,
  summaryHtml,
  events,
  chartPoint = null,
  scrollMode = "auto", // auto | force | never
} = {}) {
  selectionController.setVizSelection({
    type,
    value,
    fromTs,
    toTs,
    bucketKey,
    bucketLabel,
    seen,
    blocked,
    observed,
    other,
    bucketExample,
    title,
    summaryHtml,
    events,
    chartPoint,
    scrollMode,
  });
}

function explainCurrentScope({ forceScroll = true } = {}) {
  selectionController.explainCurrentScope({ forceScroll });
}

function selectionStillValid() {
  return selectionController.selectionStillValid();
}

const {
  buildEmptyChartOption,
  getTimelineBinMs,
  hasSeriesData,
  getModeEmptyMessage,
} = chartBuilders;

const scopeInsights = createScopeInsights({
  qs,
  getSiteLens,
  getTimelineBinMs,
  formatPercent,
});

function readPrimaryDataZoomState() {
  const option = chart?.getOption?.();
  const list = Array.isArray(option?.dataZoom) ? option.dataZoom : [];
  const first = list[0];
  if (!first) return null;

  const start = Number(first.start);
  const end = Number(first.end);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
}

function rememberCurrentDataZoomState() {
  const key = chart?.__vptMeta?.effectiveViewId;
  if (!key) return;
  const state = readPrimaryDataZoomState();
  if (!state) return;
  dataZoomStateByView.set(key, state);
}

function applyPersistedDataZoom(option, key) {
  if (!option || !Array.isArray(option.dataZoom) || !option.dataZoom.length || !key) return;
  const state = dataZoomStateByView.get(key);
  if (!state) return;

  option.dataZoom = option.dataZoom.map((dz) => ({
    ...dz,
    start: state.start,
    end: state.end,
  }));
}

function applyHoverPointerToXAxis(axis) {
  const base = axis || {};
  return {
    ...base,
    axisPointer: {
      ...(base.axisPointer || {}),
      show: true,
      snap: true,
      type: "shadow",
      shadowStyle: {
        color: CHART_HOVER_BAND_FILL,
      },
      lineStyle: {
        color: CHART_HOVER_ACCENT,
        width: 1,
        type: "dashed",
      },
      label: {
        ...((base.axisPointer && base.axisPointer.label) || {}),
        show: false,
      },
    },
  };
}

function disableAxisPointer(option) {
  if (!option) return;

  option.axisPointer = {
    ...(option.axisPointer || {}),
    show: false,
    type: "none",
    label: {
      ...((option.axisPointer && option.axisPointer.label) || {}),
      show: false,
    },
  };

  const tooltip = option.tooltip || {};
  option.tooltip = {
    ...tooltip,
    trigger: "item",
    axisPointer: {
      ...(tooltip.axisPointer || {}),
      type: "none",
      show: false,
    },
  };

  const suppressAxisPointer = (axis) => ({
    ...(axis || {}),
    axisPointer: {
      ...((axis && axis.axisPointer) || {}),
      show: false,
      type: "none",
      label: {
        ...(((axis && axis.axisPointer && axis.axisPointer.label) || {})),
        show: false,
      },
    },
  });

  if (Array.isArray(option.xAxis)) option.xAxis = option.xAxis.map((axis) => suppressAxisPointer(axis));
  else if (option.xAxis) option.xAxis = suppressAxisPointer(option.xAxis);

  if (Array.isArray(option.yAxis)) option.yAxis = option.yAxis.map((axis) => suppressAxisPointer(axis));
  else if (option.yAxis) option.yAxis = suppressAxisPointer(option.yAxis);
}

function sanitizeVendorEndpointBucketOption(option) {
  if (!option) return;
  delete option.brush;

  if (Array.isArray(option.series)) {
    option.series = option.series
      .filter((series) => series && series.id !== INTERACTION_OVERLAY_SERIES_ID)
      .map((series) => {
        const next = { ...series };
        delete next.markLine;
        delete next.markArea;
        return next;
      });
  }
}

function applyHoverPointerConfigToOption(option, { disablePointer = false } = {}) {
  if (!option || !option.xAxis) return;
  if (disablePointer) {
    disableAxisPointer(option);
    return;
  }

  const tooltip = option.tooltip || {};
  if (tooltip.trigger !== "item") {
    option.tooltip = {
      ...tooltip,
      trigger: tooltip.trigger || "axis",
      axisPointer: {
        ...(tooltip.axisPointer || {}),
        type: "line",
        snap: true,
        lineStyle: {
          color: CHART_HOVER_ACCENT,
          width: 1,
          type: "dashed",
        },
        label: {
          ...((tooltip.axisPointer && tooltip.axisPointer.label) || {}),
          show: false,
        },
      },
    };
  }

  if (Array.isArray(option.xAxis)) {
    option.xAxis = option.xAxis.map((axis) => applyHoverPointerToXAxis(axis));
  } else {
    option.xAxis = applyHoverPointerToXAxis(option.xAxis);
  }
}

function decorateSeriesInteractionStyles(option) {
  if (!option || !Array.isArray(option.series)) return;

  option.series = option.series.map((series) => {
    if (!series || series.id === INTERACTION_OVERLAY_SERIES_ID) return series;

    return {
      ...series,
      selectedMode: "single",
      emphasis: {
        ...(series.emphasis || {}),
        focus: "none",
        itemStyle: {
          ...((series.emphasis && series.emphasis.itemStyle) || {}),
          borderColor: CHART_HOVER_ACCENT,
          borderWidth: 1,
        },
      },
      select: {
        ...(series.select || {}),
        itemStyle: {
          ...((series.select && series.select.itemStyle) || {}),
          borderColor: CHART_SELECTED_ACCENT,
          borderWidth: 2,
        },
      },
    };
  });
}

function ensureChart() {
  const el = qs("vizChart");
  if (!el) return null;

  if (!chart) {
    chart = echarts.init(el);

    window.addEventListener("resize", () => {
      if (chart) chart.resize();
    });

    chart.on("click", (params) => {
      const viewId = chart?.__vptMeta?.effectiveViewId || VIEWS[vizIndex].id;
      handleChartClick(viewId, params);
    });

    chart.on("brushSelected", (params) => {
      const viewId = chart?.__vptMeta?.effectiveViewId || VIEWS[vizIndex].id;
      if (
        viewId !== "timeline"
        && viewId !== "vendorAllowedBlockedTimeline"
        && viewId !== "riskTrend"
        && viewId !== "baselineDetectedBlockedTrend"
      ) return;

      const meta = chart?.__vptMeta?.built?.meta;
      if (!meta) return;

      const area = params?.batch?.[0]?.areas?.[0];
      if (!area) {
        clearVizSelection({ close: true, clearBrush: false, renderTable: true });
        return;
      }

      const toIndex = (x) => {
        if (typeof x === "number") return Math.round(x);
        const idx = meta.labels.indexOf(x);
        return idx >= 0 ? idx : 0;
      };

      let [a, b] = area.coordRange || [];
      let startIdx = toIndex(a);
      let endIdx = toIndex(b);

      startIdx = Math.max(0, Math.min(meta.binEvents.length - 1, startIdx));
      endIdx = Math.max(0, Math.min(meta.binEvents.length - 1, endIdx));
      if (startIdx > endIdx) [startIdx, endIdx] = [endIdx, startIdx];

      const selected = [];
      for (let i = startIdx; i <= endIdx; i++) {
        selected.push(...(meta.binEvents[i] || []));
      }

      const startTs = meta.start + startIdx * meta.binMs;
      const endTs = meta.start + (endIdx + 1) * meta.binMs;
      const blocked = selected.filter((e) => e.kind === "network.blocked").length;
      const observed = selected.filter((e) => e.kind === "network.observed").length;

      setVizSelection({
        type: "bin",
        value: `${startIdx}:${endIdx}`,
        fromTs: startTs,
        toTs: endTs,
        title: `Selected window ${new Date(startTs).toLocaleTimeString()}-${new Date(endTs).toLocaleTimeString()}`,
        summaryHtml: `<div class="muted">${selected.length} events - blocked ${blocked} - observed ${observed}</div>`,
        events: selected,
        scrollMode: "never",
      });
    });

    chart.on("datazoom", () => {
      rememberCurrentDataZoomState();
    });
  }

  return chart;
}

function renderECharts() {
  const c = ensureChart();
  if (!c) return;
  rememberCurrentDataZoomState();

  const requestedViewId = VIEWS[vizIndex].id;
  const selectedVendorId = String(selectedVendor?.vendorId || "");
  const vizSignature = [
    String(vizOptions.metric || ""),
    String(vizOptions.seriesType || ""),
    String(vizOptions.topN || ""),
    String(vizOptions.sort || ""),
    String(vizOptions.binSize || ""),
    vizOptions.normalize ? "1" : "0",
    vizOptions.stack ? "1" : "0",
  ].join("|");
  let effectiveViewId = requestedViewId;
  let lensPivotActive = false;
  const titleEl = qs("vizTitle");
  const events = getChartEvents();
  const clearBeforeSetOption = requestedViewId === "vendorTopDomainsEndpoints";

  if (
    chartRenderPerfState.chartRef === c
    && chartRenderPerfState.eventsRef === events
    && chartRenderPerfState.requestedViewId === requestedViewId
    && chartRenderPerfState.selectedVendorId === selectedVendorId
    && chartRenderPerfState.viewMode === viewMode
    && chartRenderPerfState.vizSignature === vizSignature
  ) {
    return;
  }

  const rememberRenderPerfState = () => {
    chartRenderPerfState.chartRef = c;
    chartRenderPerfState.eventsRef = events;
    chartRenderPerfState.requestedViewId = requestedViewId;
    chartRenderPerfState.selectedVendorId = selectedVendorId;
    chartRenderPerfState.viewMode = viewMode;
    chartRenderPerfState.vizSignature = vizSignature;
  };

  if (!events.length) {
    const empty = buildEmptyChartOption("No events match current filters");
    focusedLensPivotActive = false;
    scopeInsights.renderLensNotice({ active: false });
    scopeInsights.renderScopeInsights(events);
    renderTopBucketSummary(requestedViewId, null);
    renderStateGuidance({ events, emptyMessage: "No events match current filters" });
    if (titleEl) {
      const vendorPart = selectedVendor?.vendorName ? ` | ${selectedVendor.vendorName}` : "";
      titleEl.textContent = `Visualisation - ${VIEWS[vizIndex].title}${vendorPart}`;
    }
    c.__vptMeta = {
      viewId: requestedViewId,
      effectiveViewId,
      lensPivotActive,
      built: { option: empty, meta: null },
    };
    if (clearBeforeSetOption) c.clear();
    c.setOption(empty, { notMerge: true, lazyUpdate: true });
    rememberRenderPerfState();
    clearChartSelectionHighlight();
    return;
  }

  const viewBuild = chartOrchestrationController.buildViewOption(requestedViewId, events);
  const built = viewBuild.built;
  effectiveViewId = viewBuild.effectiveViewId;
  lensPivotActive = viewBuild.lensPivotActive;
  focusedLensPivotActive = lensPivotActive;
  applyPersistedDataZoom(built?.option, effectiveViewId);
  const disablePointer = isVendorEndpointBucketView(requestedViewId);
  if (disablePointer) {
    sanitizeVendorEndpointBucketOption(built?.option);
  }
  applyHoverPointerConfigToOption(built?.option, { disablePointer });
  decorateSeriesInteractionStyles(built?.option);

  scopeInsights.renderLensNotice({ active: false });
  scopeInsights.renderScopeInsights(events);
  renderTopBucketSummary(requestedViewId, built?.meta);
  const builderGuidanceMessage = String(built?.meta?.stateGuidanceMessage || "").trim();
  renderStateGuidance({ events, lensPivotActive, emptyMessage: builderGuidanceMessage });

  if (titleEl) {
    const vendorPart = selectedVendor?.vendorName ? ` | ${selectedVendor.vendorName}` : "";
    titleEl.textContent = `Visualisation - ${VIEWS[vizIndex].title}${vendorPart}`;
  }

  if (!hasSeriesData(built?.option)) {
    const emptyMessage = builderGuidanceMessage || getModeEmptyMessage(lensPivotActive ? "timeline" : requestedViewId);
    const empty = buildEmptyChartOption(emptyMessage);
    focusedLensPivotActive = false;
    renderTopBucketSummary(requestedViewId, null);
    renderStateGuidance({ events, lensPivotActive, emptyMessage });
    c.__vptMeta = {
      viewId: requestedViewId,
      effectiveViewId,
      lensPivotActive,
      built: { option: empty, meta: null },
    };
    if (clearBeforeSetOption) c.clear();
    c.setOption(empty, { notMerge: true, lazyUpdate: true });
    rememberRenderPerfState();
    clearChartSelectionHighlight();
    return;
  }

  const persistentSelection = applyPersistentSelectionStyleToOption(built.option, effectiveViewId);
  if (persistentSelection && selectedChartPoint) {
    selectedChartPoint = {
      ...selectedChartPoint,
      effectiveViewId,
      seriesIndex: persistentSelection.seriesIndex,
      dataIndex: persistentSelection.dataIndex,
    };
  }

  c.__vptMeta = { viewId: requestedViewId, effectiveViewId, lensPivotActive, built };
  if (clearBeforeSetOption) c.clear();
  c.setOption(built.option, { notMerge: true, lazyUpdate: true });
  rememberRenderPerfState();
  reapplyChartSelectionHighlight();
  syncInteractionOverlayOnCurrentChart();
}

function handleChartClick(viewId, params) {
  chartOrchestrationController.handleChartClick({
    viewId,
    params,
    meta: chart?.__vptMeta?.built?.meta,
    effectiveViewId: chart?.__vptMeta?.effectiveViewId || viewId,
  });
}

function getVendorMetricValue(row) {
  return vendorScope.getVendorMetricValue(row);
}

function buildVendorRollup(events) {
  return vendorScope.buildVendorRollup(events);
}

function renderVendorChips() {
  vendorScope.renderVendorChips();
}

function renderVendorScopeBanner() {
  const box = qs("vendorScopeBanner");
  if (!box) return;

  if (!selectedVendor?.vendorId) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  const scopedCount = getChartEvents().length;
  box.classList.remove("hidden");
  box.innerHTML = "";

  const text = document.createElement("div");
  text.className = "vendor-scope-banner-text";
  text.textContent = focusedLensPivotActive
    ? `Selected Vendor: ${selectedVendor.vendorName || selectedVendor.vendorId} (${scopedCount} events). Showing timeline because compare has low data.`
    : `Selected Vendor: ${selectedVendor.vendorName || selectedVendor.vendorId} (${scopedCount} events in current scope).`;
  box.appendChild(text);
}

function clearVendorFocus() {
  selectedVendor = null;
  selectedInsightTarget = null;
  hideVendorSelectionCue();
  clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
  renderVendorChips();
  renderECharts();
  renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
  updateFilterSummary();
}

function applyFilterChanges() {
  readFilterStateFromControls();
  const policyChanged = applyViewFilterPolicy();
  if (policyChanged) {
    readFilterStateFromControls();
  }
  deriveFilteredEvents();
  renderVendorChips();
  clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
  renderECharts();
  renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
  updateFilterSummary();
}

function applyVizOptionChanges() {
  readVizOptionsFromControls();
  clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
  renderECharts();
  renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
  updateFilterSummary();
}

async function applyRangeChanges() {
  await pollingController.applyRangeChanges();
}

async function fetchSite() {
  await pollingController.fetchSite();
}

async function fetchWindowEvents(force = false) {
  await pollingController.fetchWindowEvents(force);
}

export function bootSiteInsights() {
  siteName = getQueryParam("site");

  if (!siteName) {
    qs("siteTitle").textContent = "Site insights";
    qs("siteSubtitle").textContent = "No site specified in URL. Use /site.html?site=example.com";
    setStatus(false, "No site selected");
    return;
  }

  const csvBtn = qs("exportSiteCsvBtn");
  const jsonBtn = qs("exportSiteJsonBtn");

  if (csvBtn) {
    csvBtn.addEventListener("click", () => {
      const url = buildExportUrl("csv", { download: "1", site: siteName });
      triggerDownload(url);
    });
  }

  if (jsonBtn) {
    jsonBtn.addEventListener("click", () => {
      const url = buildExportUrl("json", { download: "1", site: siteName });
      triggerDownload(url);
    });
  }

  setViewMode(qs("viewModeSelect")?.value || "easy", { rerender: false });
  sidebarModules.initControls();

  qs("viewModeSelect")?.addEventListener("change", () => {
    setViewMode(qs("viewModeSelect")?.value || "easy", { rerender: true });
  });

  qs("clearVendorBtn")?.addEventListener("click", () => {
    clearVendorFocus();
  });

  qs("vizInfoBtn")?.addEventListener("click", () => {
    explainCurrentScope({ forceScroll: true });
  });
  qs("confirmModalBackdrop")?.addEventListener("click", () => closeConfirmModal());
  qs("confirmCancelBtn")?.addEventListener("click", () => closeConfirmModal());
  qs("confirmOkBtn")?.addEventListener("click", async () => {
    await insightSheet.confirmPendingAction();
  });

  qs("vizPrevBtn")?.addEventListener("click", () => {
    const allowed = getAllowedViews(viewMode);
    const currentId = VIEWS[vizIndex]?.id;
    const idx = allowed.findIndex((v) => v.id === currentId);
    switchViz((idx >= 0 ? idx : 0) - 1);
  });

  qs("vizNextBtn")?.addEventListener("click", () => {
    const allowed = getAllowedViews(viewMode);
    const currentId = VIEWS[vizIndex]?.id;
    const idx = allowed.findIndex((v) => v.id === currentId);
    switchViz((idx >= 0 ? idx : 0) + 1);
  });

  qs("vizSelect")?.addEventListener("change", () => {
    const id = qs("vizSelect")?.value;
    const allowed = getAllowedViews(viewMode);
    const idx = allowed.findIndex((v) => v.id === id);
    switchViz(idx >= 0 ? idx : 0);
  });

  qs("rangeSelect")?.addEventListener("change", () => {
    void applyRangeChanges();
  });

  qs("kindBlockedToggle")?.addEventListener("change", applyFilterChanges);
  qs("kindObservedToggle")?.addEventListener("change", applyFilterChanges);
  qs("kindOtherToggle")?.addEventListener("change", applyFilterChanges);
  qs("partyFilter")?.addEventListener("change", applyFilterChanges);
  qs("resourceFilter")?.addEventListener("change", applyFilterChanges);
  qs("surfaceFilter")?.addEventListener("change", applyFilterChanges);
  qs("privacyStatusFilter")?.addEventListener("change", applyFilterChanges);
  qs("mitigationStatusFilter")?.addEventListener("change", applyFilterChanges);
  qs("vizMetricSelect")?.addEventListener("change", applyVizOptionChanges);
  qs("vizSeriesTypeSelect")?.addEventListener("change", applyVizOptionChanges);
  qs("vizTopNSelect")?.addEventListener("change", applyVizOptionChanges);
  qs("vizSortSelect")?.addEventListener("change", applyVizOptionChanges);
  qs("vizBinSizeSelect")?.addEventListener("change", applyVizOptionChanges);
  qs("vizNormalizeToggle")?.addEventListener("change", applyVizOptionChanges);
  qs("vizStackToggle")?.addEventListener("change", applyVizOptionChanges);

  const onDomainInput = debounce(() => {
    applyFilterChanges();
  }, 150);
  qs("domainFilter")?.addEventListener("input", onDomainInput);

  qs("filterResetBtn")?.addEventListener("click", () => {
    filterState = defaultFilterState();
    writeFilterStateToControls();
    applyFilterChanges();
  });

  qs("vizClearSelectionBtn")?.addEventListener("click", () => {
    clearVizSelection({ close: true, clearBrush: true, renderTable: true });
  });

  writeFilterStateToControls();
  writeVizOptionsToControls();
  readFilterStateFromControls();
  readVizOptionsFromControls();
  deriveFilteredEvents();
  renderVendorChips();
  syncVizSelectByMode();
  updateDrawerButtonState();
  const policyChanged = applyViewFilterPolicy();
  if (policyChanged) {
    deriveFilteredEvents();
    renderVendorChips();
  }
  updateFilterSummary();
  resetInsightSection();

  fetchSite();
  setInterval(fetchSite, POLL_MS);
}
