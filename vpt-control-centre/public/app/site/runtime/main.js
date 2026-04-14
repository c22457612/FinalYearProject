import { createChartBuilders } from "../chart-builders.js";
import { createInsightVisibility } from "./insight-visibility.js";
import { createInsightSheet } from "./insight-sheet.js";
import { createVendorScope } from "./vendor-scope.js";
import { createViewNavigationController } from "./view-navigation-controller.js";
import { createPollingController } from "./polling-controller.js";
import { createSelectionController } from "./selection-controller.js";
import { createChartOrchestrationController } from "./chart-orchestration-controller.js";
import { buildStateGuidanceModel } from "./state-guidance.js";
import {
  defaultFilterState,
  defaultVizOptions,
  getKindBucket,
  getDispositionBucket,
  getVisualCategoryBucket,
  getPartyBucket,
  getResourceBucket,
  getPrivacyStatusBucket,
  getMitigationStatusBucket,
  summarizeVisualCategoryCounts,
  matchesFilters,
  getActiveFilterLabels as computeActiveFilterLabels,
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
  getEventListContextText,
  getEventListKindText,
  pickPrimarySelectedEvent,
  formatSelectedLead,
  triggerDownload,
  buildExportUrl,
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
const INTERACTION_OVERLAY_SERIES_ID = "__vpt-interaction-overlay";
const chartThemeState = {
  selectedAccent: "#a9bfe8",
  hoverAccent: "#86a8d8",
  selectedBandFill: "rgba(126, 163, 212, 0.16)",
  hoverBandFill: "rgba(126, 163, 212, 0.10)",
};
const SELECTED_POINT_STYLE = {
  borderColor: chartThemeState.selectedAccent,
  borderWidth: 3,
};
const HOVER_POINT_STYLE = {
  borderColor: chartThemeState.hoverAccent,
  borderWidth: 1,
};

function getChartThemeTokens() {
  return window.VPT?.theme?.getChartTokens?.() || {
    selectedAccent: "#a9bfe8",
    hoverAccent: "#86a8d8",
    selectedBandFill: "rgba(126, 163, 212, 0.16)",
    hoverBandFill: "rgba(126, 163, 212, 0.10)",
  };
}

function syncChartThemeState() {
  const tokens = getChartThemeTokens();
  chartThemeState.selectedAccent = tokens.selectedAccent;
  chartThemeState.hoverAccent = tokens.hoverAccent;
  chartThemeState.selectedBandFill = tokens.selectedBandFill;
  chartThemeState.hoverBandFill = tokens.hoverBandFill;
  SELECTED_POINT_STYLE.borderColor = tokens.selectedAccent;
  HOVER_POINT_STYLE.borderColor = tokens.hoverAccent;
}

syncChartThemeState();

let filterState = defaultFilterState();
let vizOptions = defaultVizOptions();

const VIEWS = [
  { id: "vendorOverview", title: "Vendor activity overview" },
  { id: "vendorBlockRateComparison", title: "Block-rate by vendor comparison (%)" },
  { id: "vendorShareOverTime", title: "Vendor share over time (stacked area)" },
  { id: "vendorAllowedBlockedTimeline", title: "Blocked vs observed network timeline" },
  { id: "vendorTopDomainsEndpoints", title: "Where this vendor connects (top domains/endpoints)" },
  { id: "riskTrend", title: "Risk trend timeline" },
  { id: "timeline", title: "Activity timeline" },
  { id: "topSeen", title: "Top third-party domains" },
  { id: "kinds", title: "Event type breakdown" },
  { id: "apiGating", title: "API-like third-party requests by domain" },
  { id: "vendorKindMatrix", title: "Vendor-kind matrix" },
  { id: "ruleIdFrequency", title: "Rule ID frequency" },
  { id: "resourceTypes", title: "Resource type breakdown" },
  { id: "modeBreakdown", title: "Protection mode breakdown" },
  { id: "partySplit", title: "Party split (first vs third)" },
  { id: "hourHeatmap", title: "Activity heatmap (hour x day)" },
];
const VIEW_TITLE_BY_ID = new Map(VIEWS.map((view) => [view.id, view.title]));

function getSelectedRangeLabel() {
  const select = qs("rangeSelect");
  if (!select) return "";
  const option = select.selectedOptions?.[0] || select.options?.[select.selectedIndex] || null;
  return String(option?.textContent || "").trim();
}

function getViewTitle(viewId, context = {}) {
  void context;
  const normalizedViewId = String(viewId || "");
  if (normalizedViewId === "timeline") {
    const rangeLabel = getSelectedRangeLabel();
    return rangeLabel
      ? `Activity timeline (${rangeLabel})`
      : "Activity timeline";
  }
  return VIEW_TITLE_BY_ID.get(normalizedViewId) || "Current view";
}
const POWER_DOCK_ALWAYS_VISIBLE_CONTROLS = new Set([
  "blocked",
  "observed",
  "other",
  "clearSelection",
  "resetFilters",
]);
const POWER_DOCK_CONTROLS_BY_VIEW_ID = Object.freeze({
  vendorOverview: ["metric", "topN", "sort", "normalize", "party", "resource", "surface", "mitigation", "domain"],
  vendorShareOverTime: ["binSize", "party", "resource", "surface", "mitigation", "domain"],
  vendorAllowedBlockedTimeline: ["binSize", "resource", "domain"],
  vendorTopDomainsEndpoints: ["metric", "topN", "normalize", "stackBars", "resource", "mitigation", "domain"],
  timeline: ["binSize", "series", "stackBars", "party", "resource", "surface", "mitigation", "domain"],
  topSeen: ["metric", "topN", "sort", "normalize", "resource", "domain"],
  kinds: ["topN", "sort", "normalize", "party", "resource", "surface", "mitigation", "domain"],
  apiGating: ["topN", "sort", "normalize", "resource", "mitigation", "domain"],
  ruleIdFrequency: ["topN", "sort", "normalize", "surface", "mitigation", "domain"],
  resourceTypes: ["normalize", "party", "mitigation", "domain"],
  hourHeatmap: ["party", "resource", "surface", "mitigation", "domain"],
});

const EASY_SITE_WIDE_VIEW_IDS = new Set([
  "vendorOverview",
]);
const EASY_VENDOR_FOCUS_VIEW_IDS = new Set([
  "vendorOverview",
]);
const LOW_INFORMATION_EVENT_THRESHOLD = 8;
const PRIVACY_FILTER_ALL_ONLY_VIEW_IDS = new Set();

const RANGE_MS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  all: null,
};
const RANGE_ORDER = ["1h", "24h", "7d", "all"];

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
  syncVizSelectByMode,
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
  getChartThemeTokens,
  getRangeWindow,
  buildVendorRollup,
  getKindBucket,
  getVisualCategoryBucket,
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
  buildVendorBlockRateComparisonOption: chartBuilders.buildVendorBlockRateComparisonOption,
  buildVendorShareOverTimeOption: chartBuilders.buildVendorShareOverTimeOption,
  buildRiskTrendOption: chartBuilders.buildRiskTrendOption,
  buildVendorKindMatrixOption: chartBuilders.buildVendorKindMatrixOption,
  buildRuleIdFrequencyOption: chartBuilders.buildRuleIdFrequencyOption,
  setVizSelection,
  syncVizSelectByMode,
  renderVendorChips,
  renderECharts,
  focusVendorDetailsUx,
  hideVendorSelectionCue,
});

const insightVisibility = createInsightVisibility({
  qs,
});

const insightSheet = createInsightSheet({
  qs,
  pickPrimarySelectedEvent,
  formatSelectedLead,
  triggerDownload,
  escapeCsvCell,
  getInsightRules,
  ensureInsightVisible,
  getViewMode: () => viewMode,
  getSiteName: () => siteName,
  getSelectedVendor: () => selectedVendor,
  getChartEvents,
  buildVendorEndpointReadoutData: chartBuilders.buildVendorEndpointReadoutData,
  getViews: () => VIEWS,
  getVizIndex: () => vizIndex,
});

function setStatus(ok, text) {
  const el = qs("siteConnectionStatus");
  if (!el) return;
  el.textContent = text;
  el.dataset.status = ok ? "online" : "offline";
  el.title = text;
  el.setAttribute("aria-label", text);
}

function getRangeKey() {
  return qs("rangeSelect")?.value || "all";
}

function getNextBroaderRangeKey(currentRangeKey = getRangeKey()) {
  const current = String(currentRangeKey || "").trim();
  const index = RANGE_ORDER.indexOf(current);
  if (index < 0 || index >= RANGE_ORDER.length - 1) return "";
  return RANGE_ORDER[index + 1] || "";
}

function getRangeWindow() {
  const key = getRangeKey();
  const span = RANGE_MS[key];
  const to = Date.now();
  const from = span ? (to - span) : null;
  return { key, from, to };
}

function getCurrentBinMs() {
  return BIN_SIZE_MS[vizOptions.binSize] || BIN_SIZE_MS["5m"];
}

function getEffectiveTimeBounds(events) {
  const list = Array.isArray(events) ? events.filter((ev) => Number.isFinite(Number(ev?.ts))) : [];
  const { from, to } = getRangeWindow();
  const start = from ?? (list[0]?.ts ?? Date.now());
  const end = to ?? (list[list.length - 1]?.ts ?? Date.now());
  return { start, end };
}

function countNonEmptyTimelineBins(events, binMs) {
  const list = Array.isArray(events) ? events.filter((ev) => Number.isFinite(Number(ev?.ts))) : [];
  if (!list.length) return 0;

  const { start, end } = getEffectiveTimeBounds(list);
  const safeBinMs = Math.max(60 * 1000, Number(binMs || 0) || getCurrentBinMs());
  const span = Math.max(1, end - start);
  const bins = Math.max(1, Math.ceil(span / safeBinMs));
  const active = new Set();

  for (const ev of list) {
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((Number(ev.ts) - start) / safeBinMs)));
    active.add(idx);
  }

  return active.size;
}

function getHeatmapDensityStats(events) {
  const dayRows = new Set();
  const nonZeroCells = new Set();

  for (const ev of Array.isArray(events) ? events : []) {
    if (!Number.isFinite(Number(ev?.ts))) continue;
    const date = new Date(Number(ev.ts));
    const day = date.getDay();
    const hour = date.getHours();
    dayRows.add(day);
    nonZeroCells.add(`${day}:${hour}`);
  }

  return {
    distinctDayRows: dayRows.size,
    nonZeroCells: nonZeroCells.size,
  };
}

function isViewRuntimeAvailable(viewId) {
  const id = String(viewId || "");
  const events = getChartEvents();
  const rangeKey = getRangeKey();

  if (id === "vendorShareOverTime") {
    if (selectedVendor?.vendorId) return false;
    if (rangeKey === "1h") return false;
    if (!Array.isArray(events) || events.length < 24) return false;
    if (buildVendorRollup(events).length < 2) return false;
    return countNonEmptyTimelineBins(events, getCurrentBinMs()) >= 6;
  }

  if (id === "hourHeatmap") {
    if (rangeKey !== "7d" && rangeKey !== "all") return false;
    if (!Array.isArray(events) || events.length < 24) return false;
    const stats = getHeatmapDensityStats(events);
    return stats.distinctDayRows >= 2 && stats.nonZeroCells >= 12;
  }

  return true;
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
  getViewTitle,
  easySiteWideViewIds: EASY_SITE_WIDE_VIEW_IDS,
  easyVendorFocusViewIds: EASY_VENDOR_FOCUS_VIEW_IDS,
  privacyFilterAllOnlyViewIds: PRIVACY_FILTER_ALL_ONLY_VIEW_IDS,
  isViewRuntimeAvailable,
  getViewMode: () => viewMode,
  getSelectedVendor: () => selectedVendor,
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
  syncChartConsoleState();
}

function updateViewAvailabilityHint() {
  viewNavigationController.updateViewAvailabilityHint();
}

function updateDrawerButtonState() {
  viewNavigationController.updateDrawerButtonState();
}

function syncVizSelectByMode(options = {}) {
  viewNavigationController.syncVizSelectByMode(options);
}

function setViewMode(mode, opts = {}) {
  viewNavigationController.setViewMode(mode, opts);
}

function switchViz(newIndex) {
  viewNavigationController.switchViz(newIndex);
}

function switchVizById(viewId, opts = {}) {
  viewNavigationController.switchVizById(viewId, opts);
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
    tdKind.textContent = getEventListKindText(ev);
    tr.appendChild(tdKind);

    const tdDomain = document.createElement("td");
    tdDomain.textContent = getEventListContextText(ev);
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

function updateFilterSummary() {
  const el = qs("filterSummary");
  if (!el) return;

  const baseCount = Array.isArray(windowEvents) ? windowEvents.length : 0;
  const filteredCount = Array.isArray(filteredEvents) ? filteredEvents.length : 0;
  const scopedCount = getChartEvents().length;

  const parts = [`${scopedCount} in scope`];
  if (filteredCount !== scopedCount || baseCount !== filteredCount) {
    parts.push(`${filteredCount}/${baseCount} filtered`);
  } else {
    parts.push(`${baseCount} captured`);
  }
  const activeLabels = getActiveFilterLabels();
  if (activeLabels.length) parts.push(`${activeLabels.length} filter${activeLabels.length === 1 ? "" : "s"}`);
  if (selectedVendor?.vendorName) parts.push(`${selectedVendor.vendorName} scope`);
  if (vizSelection?.events?.length) parts.push(`${vizSelection.events.length} selected`);
  parts.push(viewMode === "power" ? "Power mode" : "Easy mode");

  el.textContent = parts.join(" • ");
  syncVendorFocusControls();
  syncChartConsoleState();
}

function syncVendorFocusControls() {
  const clearVendorBtn = qs("clearVendorBtn");
  const vendorVaultLink = qs("vendorVaultLink");
  const hasVendorFocus = !!selectedVendor?.vendorId;
  const vendorLabel = String(selectedVendor?.vendorName || selectedVendor?.vendorId || "").trim();

  clearVendorBtn?.classList.toggle("hidden", !hasVendorFocus);

  if (!vendorVaultLink) return;
  if (!hasVendorFocus || !vendorLabel) {
    vendorVaultLink.classList.add("hidden");
    vendorVaultLink.removeAttribute("href");
    return;
  }

  vendorVaultLink.href = `/vendor-vault.html?site=${encodeURIComponent(siteName || "")}&vendor=${encodeURIComponent(vendorLabel)}`;
  vendorVaultLink.classList.remove("hidden");
}

function ensureDensityBadge() {
  return qs("vizDensityBadge");
}

function renderDensityBadge(meta = null) {
  void meta;
  const badge = ensureDensityBadge();
  if (!badge) return;
  badge.classList.add("hidden");
  badge.textContent = "";
}

function renderStateGuidance({ events = [], lensPivotActive = false, emptyMessage = "", viewId = "" } = {}) {
  const box = qs("vizStateGuidance");
  if (!box) return;

  const list = Array.isArray(events) ? events : [];
  const activeFilters = getActiveFilterLabels();
  const model = buildStateGuidanceModel({
    eventCount: list.length,
    hasVendorFocus: !!selectedVendor?.vendorId,
    vendorName: selectedVendor?.vendorName || "",
    activeFilterCount: activeFilters.length,
    lensPivotActive,
    emptyMessage,
    viewId,
    lowInformationThreshold: LOW_INFORMATION_EVENT_THRESHOLD,
    canBroadenRange: !!getNextBroaderRangeKey(),
  });

  if (!model.message) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  box.classList.remove("hidden");
  box.innerHTML = "";

  const heading = document.createElement("div");
  heading.className = "viz-state-guidance-title";
  heading.textContent = model.message;
  box.appendChild(heading);

  const visibleActions = model.actions.filter((action) => {
    if (action.id === "reset_filters") return false;
    if (action.id === "clear_vendor" && selectedVendor?.vendorId) return false;
    return true;
  });

  if (visibleActions.length) {
    const actionBox = document.createElement("div");
    actionBox.className = "viz-state-guidance-actions";

    for (const action of visibleActions) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "viz-nav viz-state-guidance-action";
      btn.textContent = action.label;
      btn.addEventListener("click", () => {
        if (action.id === "broaden_range") {
          const nextRangeKey = getNextBroaderRangeKey();
          const rangeSelect = qs("rangeSelect");
          if (!rangeSelect || !nextRangeKey) return;
          rangeSelect.value = nextRangeKey;
          void applyRangeChanges();
          return;
        }
        if (action.id === "clear_vendor") {
          clearVendorFocus();
          return;
        }
        if (action.id === "switch_chart") {
          const target = qs("vizPathSelector")?.querySelector("[data-viz-view-id]");
          if (target && typeof target.focus === "function") target.focus();
        }
      });
      actionBox.appendChild(btn);
    }

    box.appendChild(actionBox);
  }
}

function renderTopBucketSummary(viewId, meta = null) {
  void viewId;
  void meta;
}

function renderPowerScopeReadouts() {
  // Supporting evidence now owns these factual readouts.
}

function getSelectionStatusText() {
  if (!vizSelection?.events?.length) return "No selection";

  switch (String(vizSelection?.type || "")) {
    case "bin":
      return "Time bin selected";
    case "heatCell":
      return "Heat cell selected";
    case "vendorEndpointBucket":
      return "Endpoint bucket selected";
    case "vendorKindCell":
      return "Matrix cell selected";
    default:
      return "Selection active";
  }
}

function syncChartConsoleState() {
  const hasSelection = !!(vizSelection?.events?.length || selectedChartPoint);
  const panel = document.querySelector(".site-viz-panel");
  const sheet = qs("insightSheet");
  const statusEl = qs("vizStatusText");

  if (panel) panel.dataset.selectionActive = hasSelection ? "true" : "false";
  if (sheet) sheet.dataset.selectionActive = hasSelection ? "true" : "false";

  if (!statusEl) return;
  statusEl.dataset.status = hasSelection ? "active" : "idle";
  statusEl.textContent = getSelectionStatusText();
}

function renderVizTitle(viewId = "") {
  const titleEl = qs("vizTitle");
  if (!titleEl) return;

  const resolvedViewId = String(viewId || chart?.__vptMeta?.effectiveViewId || VIEWS[vizIndex]?.id || "");
  titleEl.textContent = resolvedViewId
    ? `Visualisation - ${getViewTitle(resolvedViewId)}`
    : "Visualisation";
}

function getEffectivePowerDockViewId(fallbackViewId = "") {
  if (viewMode !== "power") return "";
  return String(chart?.__vptMeta?.effectiveViewId || fallbackViewId || VIEWS[vizIndex]?.id || "");
}

function syncAdvancedControlsForView(viewId = "") {
  const panel = qs("advancedControlsPanel");
  if (!panel) return;

  const resolvedViewId = getEffectivePowerDockViewId(viewId);
  panel.dataset.activeViewId = resolvedViewId;

  const allowedControls = new Set(POWER_DOCK_ALWAYS_VISIBLE_CONTROLS);
  for (const control of POWER_DOCK_CONTROLS_BY_VIEW_ID[resolvedViewId] || []) {
    allowedControls.add(control);
  }

  for (const controlEl of panel.querySelectorAll("[data-dock-control]")) {
    const controlId = String(controlEl.getAttribute("data-dock-control") || "");
    controlEl.classList.toggle("hidden", !allowedControls.has(controlId));
  }

  for (const sectionEl of panel.querySelectorAll("[data-dock-group]")) {
    const hasVisibleControl = Array.from(sectionEl.querySelectorAll("[data-dock-control]"))
      .some((controlEl) => !controlEl.classList.contains("hidden"));
    sectionEl.classList.toggle("hidden", !hasVisibleControl);
  }
}

function renderCurrentInsightLead() {
  // The case sheet is now the only explanatory surface.
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
        color: chartThemeState.selectedAccent,
        width: 2,
        type: "solid",
      },
      data: marker ? [{ xAxis: marker.center }] : [],
    },
    markArea: {
      silent: true,
      itemStyle: { color: chartThemeState.selectedBandFill },
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
  syncChartConsoleState();
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
  syncChartConsoleState();
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
  api = 0,
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
    api,
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

function applyPersistedDataZoom(option, key, meta = null) {
  if (!option || !Array.isArray(option.dataZoom) || !option.dataZoom.length || !key) return;
  const state = dataZoomStateByView.get(key);
  if (!state) return;

  const densityFocusedWindow = !!meta?.densityDefaults?.focusedWindow;
  const isFullRangeState = Math.abs(Number(state.start || 0)) <= 0.5 && Math.abs(Number(state.end || 0) - 100) <= 0.5;
  if (densityFocusedWindow && isFullRangeState) {
    return;
  }

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
        color: chartThemeState.hoverBandFill,
      },
      lineStyle: {
        color: chartThemeState.hoverAccent,
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

function applyHoverPointerToYAxis(axis) {
  const base = axis || {};
  return {
    ...base,
    axisPointer: {
      ...(base.axisPointer || {}),
      show: true,
      snap: true,
      type: "shadow",
      shadowStyle: {
        color: chartThemeState.hoverBandFill,
      },
      lineStyle: {
        color: chartThemeState.hoverAccent,
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

function applyHoverPointerConfigToOption(option, { disablePointer = false, pointerAxis = "x" } = {}) {
  if (!option) return;
  if (disablePointer) {
    disableAxisPointer(option);
    return;
  }

  const tooltip = option.tooltip || {};
  if (tooltip.trigger !== "item" || pointerAxis === "y") {
    option.tooltip = {
      ...tooltip,
      trigger: "axis",
      axisPointer: {
        ...(tooltip.axisPointer || {}),
        type: pointerAxis === "y" ? "shadow" : "line",
        snap: pointerAxis !== "y",
        lineStyle: {
          color: chartThemeState.hoverAccent,
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

  if (pointerAxis === "y") {
    if (Array.isArray(option.yAxis)) {
      option.yAxis = option.yAxis.map((axis) => applyHoverPointerToYAxis(axis));
    } else if (option.yAxis) {
      option.yAxis = applyHoverPointerToYAxis(option.yAxis);
    }
    return;
  }

  if (Array.isArray(option.xAxis)) {
    option.xAxis = option.xAxis.map((axis) => applyHoverPointerToXAxis(axis));
  } else if (option.xAxis) {
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
        focus: "self",
        itemStyle: {
          ...((series.emphasis && series.emphasis.itemStyle) || {}),
          borderColor: chartThemeState.hoverAccent,
          borderWidth: 1.5,
        },
        lineStyle: {
          ...((series.emphasis && series.emphasis.lineStyle) || {}),
          width: 2.4,
        },
      },
      blur: {
        ...(series.blur || {}),
        itemStyle: {
          ...((series.blur && series.blur.itemStyle) || {}),
          opacity: 0.84,
        },
        lineStyle: {
          ...((series.blur && series.blur.lineStyle) || {}),
          opacity: 0.58,
        },
        areaStyle: {
          ...((series.blur && series.blur.areaStyle) || {}),
          opacity: 0.12,
        },
      },
      select: {
        ...(series.select || {}),
        itemStyle: {
          ...((series.select && series.select.itemStyle) || {}),
          borderColor: chartThemeState.selectedAccent,
          borderWidth: 3,
          opacity: 1,
        },
        lineStyle: {
          ...((series.select && series.select.lineStyle) || {}),
          width: 2.8,
          opacity: 1,
        },
        areaStyle: {
          ...((series.select && series.select.areaStyle) || {}),
          opacity: 0.24,
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
    let resizeRaf = 0;

    window.addEventListener("resize", () => {
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        if (chart) chart.resize();
        syncVizSelectByMode();
      });
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
        && viewId !== "vendorShareOverTime"
      ) return;

      const meta = chart?.__vptMeta?.built?.meta;
      if (!meta) return;

      const area = params?.batch?.[0]?.areas?.[0];
      if (!area) {
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
      const counts = summarizeVisualCategoryCounts(selected);

      setVizSelection({
        type: "bin",
        value: `${startIdx}:${endIdx}`,
        fromTs: startTs,
        toTs: endTs,
        title: `Selected window ${new Date(startTs).toLocaleTimeString()}-${new Date(endTs).toLocaleTimeString()}`,
        summaryHtml: `<div class="muted">${selected.length} events - ${formatCounts(counts)}</div>`,
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
  c.resize();
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
    renderDensityBadge(null);
    renderStateGuidance({ events, emptyMessage: "No events match current filters", viewId: requestedViewId });
    renderVizTitle(requestedViewId);
    c.__vptMeta = {
      viewId: requestedViewId,
      effectiveViewId,
      lensPivotActive,
      built: { option: empty, meta: null },
    };
    syncAdvancedControlsForView(effectiveViewId);
    if (clearBeforeSetOption) c.clear();
    c.setOption(empty, { notMerge: true, lazyUpdate: true });
    rememberRenderPerfState();
    clearChartSelectionHighlight();
    syncChartConsoleState();
    return;
  }

  const viewBuild = chartOrchestrationController.buildViewOption(requestedViewId, events, { viewMode });
  const built = viewBuild.built;
  effectiveViewId = viewBuild.effectiveViewId;
  lensPivotActive = viewBuild.lensPivotActive;
  focusedLensPivotActive = lensPivotActive;
  applyPersistedDataZoom(built?.option, effectiveViewId, built?.meta);
  const disablePointer = isVendorEndpointBucketView(requestedViewId);
  const pointerAxis = new Set(["topSeen", "ruleIdFrequency", "apiGating"]).has(requestedViewId) ? "y" : "x";
  if (disablePointer) {
    sanitizeVendorEndpointBucketOption(built?.option);
  }
  applyHoverPointerConfigToOption(built?.option, { disablePointer, pointerAxis });
  decorateSeriesInteractionStyles(built?.option);

  renderDensityBadge(built?.meta);
  const builderGuidanceMessage = String(built?.meta?.stateGuidanceMessage || "").trim();
  renderStateGuidance({ events, lensPivotActive, emptyMessage: builderGuidanceMessage, viewId: requestedViewId });
  renderVizTitle(effectiveViewId || requestedViewId);

  if (!hasSeriesData(built?.option)) {
    const emptyMessage = builderGuidanceMessage || getModeEmptyMessage(lensPivotActive ? "timeline" : requestedViewId);
    const empty = buildEmptyChartOption(emptyMessage);
    focusedLensPivotActive = false;
    renderStateGuidance({ events, lensPivotActive, emptyMessage, viewId: requestedViewId });
    c.__vptMeta = {
      viewId: requestedViewId,
      effectiveViewId,
      lensPivotActive,
      built: { option: empty, meta: null },
    };
    syncAdvancedControlsForView(effectiveViewId);
    if (clearBeforeSetOption) c.clear();
    c.setOption(empty, { notMerge: true, lazyUpdate: true });
    rememberRenderPerfState();
    clearChartSelectionHighlight();
    syncChartConsoleState();
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
  syncAdvancedControlsForView(effectiveViewId);
  if (clearBeforeSetOption) c.clear();
  c.setOption(built.option, { notMerge: true, lazyUpdate: true });
  rememberRenderPerfState();
  reapplyChartSelectionHighlight();
  syncInteractionOverlayOnCurrentChart();
  syncChartConsoleState();
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

function clearVendorFocus() {
  selectedVendor = null;
  selectedInsightTarget = null;
  hideVendorSelectionCue();
  clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
  syncVizSelectByMode();
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

function resetFilters() {
  filterState = defaultFilterState();
  writeFilterStateToControls();
  applyFilterChanges();
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
  syncVizSelectByMode({ preserveFocus: true });
}

async function fetchSite() {
  await pollingController.fetchSite();
}

async function fetchWindowEvents(force = false) {
  await pollingController.fetchWindowEvents(force);
}

export function bootSiteInsights() {
  siteName = getQueryParam("site");

  try {
    if ("scrollRestoration" in window.history) {
      window.history.scrollRestoration = "manual";
    }
  } catch {
    // ignore history API availability issues
  }
  window.scrollTo({ top: 0, left: 0, behavior: "auto" });

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

  const vizPathSelector = qs("vizPathSelector");
  vizPathSelector?.addEventListener("click", (event) => {
    const target = event.target;
    if (!target || typeof target.closest !== "function") return;
    const button = target.closest("[data-viz-view-id]");
    if (!button) return;
    switchVizById(button.getAttribute("data-viz-view-id"), { focusViewId: button.getAttribute("data-viz-view-id") || "" });
  });

  vizPathSelector?.addEventListener("keydown", (event) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    if (typeof vizPathSelector.querySelectorAll !== "function") return;

    const buttons = Array.from(vizPathSelector.querySelectorAll("[data-viz-view-id]"));
    if (!buttons.length) return;

    const activeElement = document.activeElement;
    const currentIndex = Math.max(0, buttons.findIndex((button) => button === activeElement));
    let nextIndex = currentIndex;

    if (event.key === "ArrowLeft" || event.key === "ArrowUp") {
      event.preventDefault();
      nextIndex = Math.max(0, currentIndex - 1);
    } else if (event.key === "ArrowRight" || event.key === "ArrowDown") {
      event.preventDefault();
      nextIndex = Math.min(buttons.length - 1, currentIndex + 1);
    } else if (event.key === "Home") {
      event.preventDefault();
      nextIndex = 0;
    } else if (event.key === "End") {
      event.preventDefault();
      nextIndex = buttons.length - 1;
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      const currentButton = buttons[currentIndex];
      if (!currentButton) return;
      switchVizById(currentButton.getAttribute("data-viz-view-id"), { focusViewId: currentButton.getAttribute("data-viz-view-id") || "" });
      return;
    } else {
      return;
    }

    const nextButton = buttons[nextIndex];
    if (!nextButton) return;
    nextButton.focus({ preventScroll: true });
    switchVizById(nextButton.getAttribute("data-viz-view-id"), { focusViewId: nextButton.getAttribute("data-viz-view-id") || "" });
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

  qs("filterResetEasyBtn")?.addEventListener("click", resetFilters);
  qs("filterResetBtn")?.addEventListener("click", resetFilters);

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
