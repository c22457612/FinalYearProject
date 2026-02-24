import { createChartBuilders } from "../chart-builders.js";
import { createSidebarModules } from "./sidebar-modules.js";
import { createScopeInsights } from "./scope-insights.js";
import { createInsightVisibility } from "./insight-visibility.js";
import { createInsightSheet } from "./insight-sheet.js";
import { createVendorScope } from "./vendor-scope.js";
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
let vizIndex = 0;
let vizSelection = null; // { type, value, events, fromTs, toTs, title, summaryHtml }
let drawerMode = "normal";

let lastWindowFetchKey = null;
let lastWindowFetchAt = 0;
let isFetchSiteInFlight = false;
let viewMode = "easy"; // easy | power
let selectedVendor = null; // { vendorId, vendorName, ... } | null
let selectedInsightTarget = null;
let forceVendorCompareOnce = false;
const dataZoomStateByView = new Map(); // key: effective view id, value: { start, end }
let selectedChartPoint = null; // { viewId, effectiveViewId, seriesIndex, dataIndex, semanticKey }
let selectedRecentEventKey = "";
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

const EASY_VIEW_IDS = new Set(["vendorOverview", "kinds", "riskTrend", "baselineDetectedBlockedTrend", "partySplit"]);
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
  getDrawerMode: () => drawerMode,
  setDrawerModeState: (mode) => {
    drawerMode = mode;
  },
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

function isViewAllowed(viewId, mode = viewMode) {
  if (mode === "easy") return EASY_VIEW_IDS.has(viewId);
  return true;
}

function getAllowedViews(mode = viewMode) {
  return VIEWS.filter((v) => isViewAllowed(v.id, mode));
}

function getCurrentViewId() {
  return VIEWS[vizIndex]?.id || VIEWS[0]?.id || "";
}

function applyViewFilterPolicy() {
  const viewId = getCurrentViewId();
  const privacyAllOnly = PRIVACY_FILTER_ALL_ONLY_VIEW_IDS.has(viewId);
  let changed = false;

  if (privacyAllOnly && filterState.privacyStatus !== "all") {
    filterState.privacyStatus = "all";
    changed = true;
  }

  writeFilterStateToControls();

  const privacyEl = qs("privacyStatusFilter");
  if (privacyEl) {
    privacyEl.disabled = privacyAllOnly;
    privacyEl.title = privacyAllOnly
      ? "Privacy filter is fixed to All for this view to avoid collapsed single-group charts."
      : "";
  }

  return changed;
}

function updateVizPositionLabel() {
  const el = qs("vizPositionLabel");
  if (!el) return;

  const allowed = getAllowedViews(viewMode);
  if (!allowed.length) {
    el.textContent = "- / 0";
    return;
  }

  const currentId = VIEWS[vizIndex]?.id;
  let idx = allowed.findIndex((v) => v.id === currentId);
  if (idx < 0) idx = 0;
  el.textContent = `${idx + 1} / ${allowed.length}`;
}

function syncVizSelectByMode() {
  const select = qs("vizSelect");
  if (!select) {
    updateVizPositionLabel();
    return;
  }

  for (const opt of select.options) {
    const allowed = isViewAllowed(opt.value, viewMode);
    opt.hidden = !allowed;
    opt.disabled = !allowed;
  }

  const currentId = VIEWS[vizIndex]?.id;
  if (!isViewAllowed(currentId, viewMode)) {
    const allowed = getAllowedViews(viewMode);
    const fallback = allowed[0]?.id || VIEWS[0].id;
    const idx = VIEWS.findIndex((v) => v.id === fallback);
    vizIndex = idx >= 0 ? idx : 0;
    select.value = VIEWS[vizIndex].id;
  } else {
    select.value = currentId;
  }

  updateVizPositionLabel();
}

function setViewMode(mode, { rerender = true } = {}) {
  viewMode = mode === "power" ? "power" : "easy";
  document.body.classList.toggle("mode-easy", viewMode === "easy");
  document.body.classList.toggle("mode-power", viewMode === "power");
  if (qs("viewModeSelect")) qs("viewModeSelect").value = viewMode;

  if (viewMode === "easy") {
    closeDrawer();
  }

  syncVizSelectByMode();
  const policyChanged = applyViewFilterPolicy();
  if (policyChanged) {
    deriveFilteredEvents();
  }
  renderVendorChips();

  if (rerender) {
    clearVizSelection({ close: true, clearBrush: true, renderTable: false });
    renderECharts();
    renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
    updateFilterSummary();
  }
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

    tbody.appendChild(tr);
  }
}

function deriveFilteredEvents() {
  const base = Array.isArray(windowEvents) ? windowEvents : [];
  filteredEvents = base.filter((ev) => matchesFilters(ev, filterState));
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
  sidebarModules.renderSidebarModules();
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

function setDrawerMode(mode) {
  insightSheet.setDrawerMode(mode);
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

function openDrawer(title, summaryHtml, evidenceEvents) {
  insightSheet.openDrawer(title, summaryHtml, evidenceEvents);
}

function clearBrushSelection() {
  try {
    chart?.dispatchAction?.({ type: "brush", areas: [] });
  } catch {
    // ignore ECharts brush clear errors
  }
}

function buildChartPointState(viewId, params) {
  if (!params) return null;

  const seriesIndex = typeof params.seriesIndex === "number" ? params.seriesIndex : 0;
  const dataIndex = typeof params.dataIndex === "number" ? params.dataIndex : null;
  const effectiveViewId = chart?.__vptMeta?.effectiveViewId || viewId;
  let semanticKey = "";

  if (viewId === "timeline" || viewId === "riskTrend" || viewId === "baselineDetectedBlockedTrend") {
    semanticKey = `bin:${typeof dataIndex === "number" ? dataIndex : ""}`;
  } else if (viewId === "hourHeatmap" || viewId === "vendorKindMatrix") {
    const value = Array.isArray(params?.value) ? params.value : [];
    semanticKey = `cell:${Number(value[0] || 0)}:${Number(value[1] || 0)}`;
  } else {
    semanticKey = `label:${String(params?.name ?? params?.axisValue ?? "")}`;
  }

  return {
    viewId,
    effectiveViewId,
    seriesIndex,
    dataIndex,
    semanticKey,
  };
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
    const xAxisData = Array.isArray(option.xAxis?.[0]?.data)
      ? option.xAxis[0].data
      : Array.isArray(option.xAxis?.data)
        ? option.xAxis.data
        : [];
    const idx = xAxisData.findIndex((v) => String(v) === label);
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
  const option = chart.getOption?.();
  const effectiveViewId = chart?.__vptMeta?.effectiveViewId || VIEWS[vizIndex]?.id;
  const marker = buildSelectionMarkerForOption(option, effectiveViewId);
  const overlay = buildInteractionOverlaySeries(marker);

  try {
    chart.setOption({ series: [overlay] }, false);
  } catch {
    // ignore overlay merge failures during rapid chart updates
  }
}

function clearChartSelectionHighlight() {
  if (selectedChartPoint && chart) {
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

function clearVizSelection({ close = true, clearBrush = true, renderTable = true } = {}) {
  vizSelection = null;
  selectedInsightTarget = null;
  insightSheet.clearActiveEvidence();
  selectedRecentEventKey = "";
  clearChartSelectionHighlight();

  if (clearBrush) clearBrushSelection();
  if (close) {
    closeDrawer();
    closeInsightSheet();
  }

  if (renderTable) {
    renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
  }

  syncInteractionOverlayOnCurrentChart();
  updateFilterSummary();
}

function setVizSelection({
  type,
  value,
  fromTs = null,
  toTs = null,
  title,
  summaryHtml,
  events,
  chartPoint = null,
  scrollMode = "auto", // auto | force | never
} = {}) {
  const evidence = Array.isArray(events) ? events.filter(Boolean) : [];

  vizSelection = {
    type,
    value,
    fromTs,
    toTs,
    title,
    summaryHtml,
    events: evidence,
  };

  const primaryEvent = pickPrimarySelectedEvent(evidence);
  selectedRecentEventKey = getEventKey(primaryEvent);
  renderRecentEventsFromEvents(evidence, "No events match selection.", { selectedEventKey: selectedRecentEventKey });

  if (chartPoint) {
    selectedChartPoint = chartPoint;
    applyChartSelectionHighlight();
  } else {
    clearChartSelectionHighlight();
  }
  syncInteractionOverlayOnCurrentChart();

  selectedInsightTarget = { type, value };
  const scrollSource = type === "vendor" ? "vendor" : "selection";
  openInsightSheet(vizSelection, evidence, {
    forceScroll: scrollMode === "force",
    allowAutoScroll: scrollMode !== "never",
    scrollSource,
  });
  if (viewMode === "power") {
    openDrawer(title, summaryHtml, evidence);
  }
  updateFilterSummary();
}

function explainCurrentScope({ forceScroll = true } = {}) {
  const existing = vizSelection?.events?.length ? vizSelection : null;
  const evidence = existing ? existing.events : getChartEvents();
  const scopeTitle = existing?.title || `${VIEWS[vizIndex]?.title || "Current view"} scope`;
  const scopeSelection = existing || {
    type: "scope",
    value: VIEWS[vizIndex]?.id || "scope",
    title: scopeTitle,
    summaryHtml: "",
    events: evidence,
  };

  if (!evidence.length) {
    resetInsightSection();
    ensureInsightVisible({ force: forceScroll, source: "scope" });
    return;
  }

  openInsightSheet(scopeSelection, evidence, { forceScroll, scrollSource: "scope" });
}

function selectionStillValid() {
  if (!vizSelection?.events?.length) return false;

  const ids = vizSelection.events.map((e) => e?.id).filter(Boolean);
  if (!ids.length) return false;

  const scoped = getChartEvents();
  const byId = new Map(scoped.filter((e) => e?.id).map((e) => [e.id, e]));
  const refreshed = [];

  for (const id of ids) {
    const ev = byId.get(id);
    if (!ev) return false;
    refreshed.push(ev);
  }

  vizSelection.events = refreshed;
  selectedRecentEventKey = getEventKey(pickPrimarySelectedEvent(refreshed));
  return true;
}

const {
  buildEmptyChartOption,
  getTimelineBinMs,
  buildTimelineOption,
  buildTopDomainsOption,
  buildKindsOption,
  buildApiGatingOption,
  buildResourceTypesOption,
  buildModeBreakdownOption,
  buildPartySplitOption,
  buildHourHeatmapOption,
  buildVendorOverviewOption,
  buildRiskTrendOption,
  buildBaselineDetectedBlockedTrendOption,
  buildVendorKindMatrixOption,
  buildRuleIdFrequencyOption,
  hasSeriesData,
  getModeEmptyMessage,
} = chartBuilders;

const scopeInsights = createScopeInsights({
  qs,
  getSiteLens,
  getTimelineBinMs,
  formatPercent,
  onForceCompare: () => {
    forceVendorCompareOnce = true;
    renderECharts();
  },
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

function applyHoverPointerConfigToOption(option) {
  if (!option || !option.xAxis) return;

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
      if (viewId !== "timeline" && viewId !== "riskTrend" && viewId !== "baselineDetectedBlockedTrend") return;

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
  let effectiveViewId = requestedViewId;
  let lensPivotActive = false;
  const titleEl = qs("vizTitle");
  const events = getChartEvents();
  const lensApi = getSiteLens();

  if (!events.length) {
    const empty = buildEmptyChartOption("No events match current filters");
    forceVendorCompareOnce = false;
    scopeInsights.renderLensNotice({ active: false });
    scopeInsights.renderScopeInsights(events);
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
    c.setOption(empty, true);
    clearChartSelectionHighlight();
    return;
  }

  let built;
  if (requestedViewId === "vendorOverview") {
    const vendorCardinality = buildVendorRollup(events).length;
    const shouldPivot = !!(lensApi?.shouldAutoPivotVendorOverview
      && lensApi.shouldAutoPivotVendorOverview({
        viewId: requestedViewId,
        selectedVendor,
        events,
        vendorCardinality,
      }));

    if (shouldPivot && !forceVendorCompareOnce) {
      built = buildTimelineOption(events);
      effectiveViewId = "timeline";
      lensPivotActive = true;
    } else {
      built = buildVendorOverviewOption(events);
    }
    forceVendorCompareOnce = false;
  } else if (requestedViewId === "riskTrend") built = buildRiskTrendOption(events);
  else if (requestedViewId === "baselineDetectedBlockedTrend") built = buildBaselineDetectedBlockedTrendOption(events);
  else if (requestedViewId === "timeline") built = buildTimelineOption(events);
  else if (requestedViewId === "topSeen") built = buildTopDomainsOption(events, vizOptions.metric);
  else if (requestedViewId === "kinds") built = buildKindsOption(events);
  else if (requestedViewId === "apiGating") built = buildApiGatingOption(events);
  else if (requestedViewId === "vendorKindMatrix") built = buildVendorKindMatrixOption(events);
  else if (requestedViewId === "ruleIdFrequency") built = buildRuleIdFrequencyOption(events);
  else if (requestedViewId === "resourceTypes") built = buildResourceTypesOption(events);
  else if (requestedViewId === "modeBreakdown") built = buildModeBreakdownOption(events);
  else if (requestedViewId === "partySplit") built = buildPartySplitOption(events);
  else if (requestedViewId === "hourHeatmap") built = buildHourHeatmapOption(events);
  else built = buildTopDomainsOption(events, vizOptions.metric);
  if (requestedViewId !== "vendorOverview") forceVendorCompareOnce = false;
  applyPersistedDataZoom(built?.option, effectiveViewId);
  applyHoverPointerConfigToOption(built?.option);
  decorateSeriesInteractionStyles(built?.option);

  scopeInsights.renderLensNotice({
    active: lensPivotActive,
    vendorName: selectedVendor?.vendorName || "",
  });
  scopeInsights.renderScopeInsights(events);

  if (titleEl) {
    const vendorPart = selectedVendor?.vendorName ? ` | ${selectedVendor.vendorName}` : "";
    const lensPart = lensPivotActive ? " (focused lens)" : "";
    titleEl.textContent = `Visualisation - ${VIEWS[vizIndex].title}${vendorPart}${lensPart}`;
  }

  if (!hasSeriesData(built?.option)) {
    const empty = buildEmptyChartOption(getModeEmptyMessage(lensPivotActive ? "timeline" : requestedViewId));
    c.__vptMeta = {
      viewId: requestedViewId,
      effectiveViewId,
      lensPivotActive,
      built: { option: empty, meta: null },
    };
    c.setOption(empty, true);
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
  c.setOption(built.option, true);
  reapplyChartSelectionHighlight();
  syncInteractionOverlayOnCurrentChart();
}

function handleChartClick(viewId, params) {
  const meta = chart?.__vptMeta?.built?.meta;
  if (!meta) return;
  const chartPoint = buildChartPointState(viewId, params);

  if (viewId === "timeline" || viewId === "riskTrend" || viewId === "baselineDetectedBlockedTrend") {
    const idx = params?.dataIndex;
    if (typeof idx !== "number") return;

    const binEvents = meta.binEvents?.[idx] || [];
    const start = meta.start + idx * meta.binMs;
    const end = start + meta.binMs;

    setVizSelection({
      type: "bin",
      value: String(idx),
      fromTs: start,
      toTs: end,
      title: `Time bin ${new Date(start).toLocaleTimeString()}-${new Date(end).toLocaleTimeString()}`,
      summaryHtml: `<div class="muted">${binEvents.length} events in this interval.</div>`,
      events: binEvents,
      chartPoint,
      scrollMode: "force",
    });
    return;
  }

  if (viewId === "vendorOverview") {
    const wasAllVendors = !selectedVendor?.vendorId;
    const label = params?.name;
    const evs = meta.evidenceByLabel?.get(label) || [];
    const vendor = meta.vendorByLabel?.get(label) || null;
    if (vendor) {
      selectedVendor = vendor;
      renderVendorChips();
      renderECharts();
      focusVendorDetailsUx(vendor.vendorName || label || "Vendor", evs.length);
    } else {
      renderVendorChips();
      hideVendorSelectionCue();
    }

    setVizSelection({
      type: "vendor",
      value: label || "",
      title: label || "Vendor",
      summaryHtml: `<div class="muted">${evs.length} vendor-scoped events (current filters/range).</div>`,
      events: evs,
      chartPoint,
      scrollMode: wasAllVendors ? "never" : "force",
    });
    return;
  }

  if (viewId === "topSeen" || viewId === "apiGating") {
    const domain = params?.name;
    const evs = meta.evidenceByDomain?.get(domain) || [];

    setVizSelection({
      type: "domain",
      value: domain || "",
      title: domain || "Selection",
      summaryHtml: `<div class="muted">${evs.length} matching events (current filters/range).</div>`,
      events: evs,
      chartPoint,
      scrollMode: "force",
    });
    return;
  }

  if (viewId === "kinds" || viewId === "ruleIdFrequency") {
    const kind = params?.name;
    const evs = meta.evidenceByLabel?.get(kind) || [];

    setVizSelection({
      type: viewId === "kinds" ? "kind" : "rule",
      value: kind || "",
      title: viewId === "kinds" ? `Kind: ${kind}` : `Rule ID: ${kind}`,
      summaryHtml: `<div class="muted">${evs.length} events in this group (current filters/range).</div>`,
      events: evs,
      chartPoint,
      scrollMode: "force",
    });
    return;
  }

  if (viewId === "resourceTypes" || viewId === "modeBreakdown" || viewId === "partySplit") {
    const label = params?.name;
    const evs = meta.evidenceByLabel?.get(label) || [];

    setVizSelection({
      type: viewId,
      value: label || "",
      title: label || "Selection",
      summaryHtml: `<div class="muted">${evs.length} events in this group (current filters/range).</div>`,
      events: evs,
      chartPoint,
      scrollMode: "force",
    });
    return;
  }

  if (viewId === "hourHeatmap") {
    const value = Array.isArray(params?.value) ? params.value : null;
    if (!value) return;

    const hour = Number(value[0] || 0);
    const day = Number(value[1] || 0);
    const key = `${day}:${hour}`;
    const evs = meta.evidenceByCell?.get(key) || [];
    const dayName = meta.dayNames?.[day] || `day ${day}`;
    const hourLabel = meta.hourLabels?.[hour] || `${hour}:00`;

    setVizSelection({
      type: "heatCell",
      value: key,
      title: `Heat cell: ${dayName} ${hourLabel}`,
      summaryHtml: `<div class="muted">${evs.length} events in this hour/day bucket.</div>`,
      events: evs,
      chartPoint,
      scrollMode: "force",
    });
    return;
  }

  if (viewId === "vendorKindMatrix") {
    const value = Array.isArray(params?.value) ? params.value : null;
    if (!value) return;
    const x = Number(value[0] || 0);
    const y = Number(value[1] || 0);
    const key = `${x}:${y}`;
    const evs = meta.evidenceByCell?.get(key) || [];
    const vendor = meta.vendors?.[y] || "Vendor";
    const kind = meta.kinds?.[x] || "Kind";
    setVizSelection({
      type: "vendorKindCell",
      value: key,
      title: `${vendor} / ${kind}`,
      summaryHtml: `<div class="muted">${evs.length} events in this vendor-kind cell.</div>`,
      events: evs,
      chartPoint,
      scrollMode: "force",
    });
  }
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

function applyFilterChanges() {
  readFilterStateFromControls();
  const policyChanged = applyViewFilterPolicy();
  if (policyChanged) {
    readFilterStateFromControls();
  }
  deriveFilteredEvents();
  renderVendorChips();
  clearVizSelection({ close: true, clearBrush: true, renderTable: false });
  renderECharts();
  renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
  updateFilterSummary();
}

function applyVizOptionChanges() {
  readVizOptionsFromControls();
  clearVizSelection({ close: true, clearBrush: true, renderTable: false });
  renderECharts();
  renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
  updateFilterSummary();
}

async function applyRangeChanges() {
  clearVizSelection({ close: true, clearBrush: true, renderTable: false });
  try {
    await fetchWindowEvents(true);
  } catch (err) {
    console.error(err);
  }

  deriveFilteredEvents();
  renderVendorChips();
  renderECharts();
  renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
  updateFilterSummary();
}

async function fetchSite() {
  if (isFetchSiteInFlight) return;
  isFetchSiteInFlight = true;

  try {
    const url = `/api/sites/${encodeURIComponent(siteName)}?top=20&recent=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    latestSiteData = data;

    setStatus(true, "Connected");
    renderHeader(data);
    renderStats(data);
    renderTopThirdParties(data);

    await fetchWindowEvents();
    deriveFilteredEvents();
    renderVendorChips();

    if (vizSelection && !selectionStillValid()) {
      clearVizSelection({ close: true, clearBrush: true, renderTable: false });
    }

    renderECharts();

    if (vizSelection?.events?.length && selectionStillValid()) {
      renderRecentEventsFromEvents(vizSelection.events, "No events match selection.", { selectedEventKey: selectedRecentEventKey });
    } else {
      renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
    }

    updateFilterSummary();
  } catch (err) {
    console.error(err);
    setStatus(false, "Backend unavailable");

    if (!latestSiteData) {
      renderRecentEvents({ recentEvents: [] });
    }
  } finally {
    isFetchSiteInFlight = false;
  }
}

async function fetchWindowEvents(force = false) {
  const { key, from, to } = getRangeWindow();
  const fetchKey = `${key}:${from ?? "null"}:${to ?? "null"}`;

  const now = Date.now();
  const stale = (now - lastWindowFetchAt) > 5000;

  if (!force && fetchKey === lastWindowFetchKey && windowEvents.length && !stale) return;

  lastWindowFetchKey = fetchKey;
  lastWindowFetchAt = now;

  const q = new URLSearchParams();
  q.set("site", siteName);
  if (from) q.set("from", String(from));
  if (to) q.set("to", String(to));
  q.set("limit", "20000");

  const res = await fetch(`/api/events?${q.toString()}`);
  if (!res.ok) throw new Error(`events window HTTP ${res.status}`);

  windowEvents = await res.json();
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

  qs("drawerCloseBtn")?.addEventListener("click", () => closeDrawer());
  qs("vizDrawerBackdrop")?.addEventListener("click", () => closeDrawer());

  qs("drawerNormalBtn")?.addEventListener("click", () => setDrawerMode("normal"));
  qs("drawerAdvancedBtn")?.addEventListener("click", () => setDrawerMode("advanced"));
  setDrawerMode("normal");
  setViewMode(qs("viewModeSelect")?.value || "easy", { rerender: false });
  sidebarModules.initControls();

  qs("viewModeSelect")?.addEventListener("change", () => {
    setViewMode(qs("viewModeSelect")?.value || "easy", { rerender: true });
  });

  qs("clearVendorBtn")?.addEventListener("click", () => {
    selectedVendor = null;
    selectedInsightTarget = null;
    hideVendorSelectionCue();
    clearVizSelection({ close: true, clearBrush: true, renderTable: false });
    renderVendorChips();
    renderECharts();
    renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
    updateFilterSummary();
  });

  qs("vizInfoBtn")?.addEventListener("click", () => {
    explainCurrentScope({ forceScroll: true });
  });
  qs("vendorSelectionCueBtn")?.addEventListener("click", () => {
    ensureInsightVisible({ force: true, source: "vendor" });
  });
  qs("confirmModalBackdrop")?.addEventListener("click", () => closeConfirmModal());
  qs("confirmCancelBtn")?.addEventListener("click", () => closeConfirmModal());
  qs("confirmOkBtn")?.addEventListener("click", async () => {
    await insightSheet.confirmPendingAction();
  });

  const switchViz = (newIndex) => {
    const allowed = getAllowedViews(viewMode);
    if (!allowed.length) return;
    const currentId = VIEWS[vizIndex]?.id;
    const currentAllowedIdx = Math.max(0, allowed.findIndex((v) => v.id === currentId));
    const nextAllowedIdx = (newIndex + allowed.length) % allowed.length;
    const chosen = allowed[(nextAllowedIdx + allowed.length) % allowed.length] || allowed[currentAllowedIdx];
    const absoluteIdx = VIEWS.findIndex((v) => v.id === chosen.id);
    vizIndex = absoluteIdx >= 0 ? absoluteIdx : 0;
    if (qs("vizSelect")) qs("vizSelect").value = VIEWS[vizIndex].id;
    updateVizPositionLabel();
    const policyChanged = applyViewFilterPolicy();
    if (policyChanged) {
      deriveFilteredEvents();
      renderVendorChips();
    }

    clearVizSelection({ close: true, clearBrush: true, renderTable: false });
    renderECharts();
    renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
    updateFilterSummary();
  };

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
