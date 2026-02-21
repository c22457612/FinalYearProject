import { createChartBuilders } from "./chart-builders.js";
import {
  defaultFilterState,
  defaultVizOptions,
  getKindBucket,
  getPartyBucket,
  getResourceBucket,
  matchesFilters,
  getActiveFilterLabels as computeActiveFilterLabels,
  getActiveVizOptionLabels as computeActiveVizOptionLabels,
  readFilterStateFromControls as readFilterStateFromDom,
  writeFilterStateToControls as writeFilterStateToDom,
  readVizOptionsFromControls as readVizOptionsFromDom,
  writeVizOptionsToControls as writeVizOptionsToDom,
} from "./filter-state.js";
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
} from "./utils.js";

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
let activeEvidence = [];
let pendingConfirmAction = null;
let forceVendorCompareOnce = false;
const dataZoomStateByView = new Map(); // key: effective view id, value: { start, end }
let selectedChartPoint = null; // { viewId, effectiveViewId, seriesIndex, dataIndex, semanticKey }
let selectedRecentEventKey = "";
let insightScrollRaf = null;
let vendorSelectionCueTimer = null;
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

const EASY_VIEW_IDS = new Set(["vendorOverview", "kinds", "riskTrend", "partySplit"]);
const POWER_ONLY_VIEW_IDS = new Set(["apiGating", "vendorKindMatrix", "ruleIdFrequency", "resourceTypes", "modeBreakdown", "hourHeatmap"]);
const SIDEBAR_SELECTED_KEY = "vpt.siteInsights.sidebarModule.selected.v2";
const SIDEBAR_MODULE_ORDER = ["filters", "recentEvents", "selectedEvidence", "vendorProfile", "topThirdParties"];
const SIDEBAR_DEFAULT_MODULE = "filters";
const SIDEBAR_BUTTON_IDS = Object.freeze({
  recentEvents: "sidebarModuleBtnRecentEvents",
  selectedEvidence: "sidebarModuleBtnSelectedEvidence",
  filters: "sidebarModuleBtnFilters",
  vendorProfile: "sidebarModuleBtnVendorProfile",
  topThirdParties: "sidebarModuleBtnTopThirdParties",
});
const SIDEBAR_MODULE_CONTAINER_IDS = Object.freeze({
  recentEvents: "sidebarModuleRecentEvents",
  selectedEvidence: "sidebarModuleSelectedEvidence",
  filters: "sidebarModuleFilters",
  vendorProfile: "sidebarModuleVendorProfile",
  topThirdParties: "sidebarModuleTopThirdParties",
});
let selectedSidebarModule = SIDEBAR_DEFAULT_MODULE;

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
  resourceLabels: RESOURCE_LABELS,
  partyLabels: PARTY_LABELS,
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
  renderVendorChips();

  if (rerender) {
    clearVizSelection({ close: true, clearBrush: true, renderTable: false });
    renderECharts();
    renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
    updateFilterSummary();
  }
}

function classifyVendorForEvent(ev) {
  const taxonomy = getVendorTaxonomy();
  if (taxonomy?.classifyEvent) return taxonomy.classifyEvent(ev);

  const fallback = String(ev?.data?.domain || ev?.site || "unknown");
  return {
    vendorId: fallback,
    vendorName: fallback,
    category: "unmapped",
    domains: fallback ? [fallback] : [],
    riskHints: ["vendor mapping unavailable"],
    domain: fallback,
    known: false,
  };
}

function eventMatchesSelectedVendor(ev) {
  if (!selectedVendor?.vendorId) return true;
  const classified = classifyVendorForEvent(ev);
  return classified.vendorId === selectedVendor.vendorId;
}

function getChartEvents() {
  const base = Array.isArray(filteredEvents) ? filteredEvents : [];
  return base.filter((ev) => eventMatchesSelectedVendor(ev));
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

function sanitizeSidebarModuleId(raw) {
  const value = String(raw || "");
  return SIDEBAR_MODULE_ORDER.includes(value) ? value : SIDEBAR_DEFAULT_MODULE;
}

function loadSelectedSidebarModule() {
  try {
    const raw = localStorage.getItem(SIDEBAR_SELECTED_KEY);
    return sanitizeSidebarModuleId(raw);
  } catch {
    return SIDEBAR_DEFAULT_MODULE;
  }
}

function persistSelectedSidebarModule() {
  try {
    localStorage.setItem(SIDEBAR_SELECTED_KEY, selectedSidebarModule);
  } catch {
    // ignore localStorage write failures
  }
}

function applySelectedSidebarModuleToDom() {
  for (const moduleId of SIDEBAR_MODULE_ORDER) {
    const btn = qs(SIDEBAR_BUTTON_IDS[moduleId]);
    if (btn) {
      const active = moduleId === selectedSidebarModule;
      btn.classList.toggle("active", active);
      btn.setAttribute("aria-selected", active ? "true" : "false");
    }
    const panel = qs(SIDEBAR_MODULE_CONTAINER_IDS[moduleId]);
    if (panel) panel.classList.toggle("hidden", moduleId !== selectedSidebarModule);
  }
}

function selectSidebarModule(moduleId) {
  selectedSidebarModule = sanitizeSidebarModuleId(moduleId);
  persistSelectedSidebarModule();
  applySelectedSidebarModuleToDom();
}

function addSidebarMutedText(container, text) {
  if (!container) return;
  const p = document.createElement("div");
  p.className = "muted";
  p.textContent = text;
  container.appendChild(p);
}

function buildEvidenceStats(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  let blocked = 0;
  let observed = 0;
  let other = 0;
  let firstTs = null;
  let lastTs = null;

  for (const ev of list) {
    if (ev?.kind === "network.blocked") blocked += 1;
    else if (ev?.kind === "network.observed") observed += 1;
    else other += 1;

    const ts = Number(ev?.ts);
    if (!Number.isFinite(ts)) continue;
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
  }

  return { total: list.length, blocked, observed, other, firstTs, lastTs };
}

function renderSidebarSelectedEvidence() {
  const metaEl = qs("sidebarSelectedEvidenceMeta");
  const body = qs("sidebarSelectedEvidenceBody");
  if (!metaEl || !body) return;
  body.innerHTML = "";

  const selection = vizSelection?.events?.length ? vizSelection : null;
  const evidence = selection ? selection.events : getChartEvents();
  const stats = buildEvidenceStats(evidence);
  const label = selection?.title || "Current scope";
  metaEl.textContent = selection
    ? `${stats.total} events in locked selection`
    : `No locked datapoint. Scope has ${stats.total} events.`;

  if (!evidence.length) {
    addSidebarMutedText(body, "No evidence in current scope.");
    return;
  }

  const primary = pickPrimarySelectedEvent(evidence);
  const kv = document.createElement("div");
  kv.className = "sidebar-kv-list";
  const rows = [
    ["Scope", label],
    ["Blocked", String(stats.blocked)],
    ["Observed", String(stats.observed)],
    ["Other", String(stats.other)],
    ["First", stats.firstTs ? friendlyTime(stats.firstTs) : "-"],
    ["Last", stats.lastTs ? friendlyTime(stats.lastTs) : "-"],
  ];
  for (const [k, v] of rows) {
    const row = document.createElement("div");
    row.className = "sidebar-kv";
    const labelEl = document.createElement("div");
    labelEl.className = "sidebar-kv-label";
    labelEl.textContent = k;
    const valueEl = document.createElement("div");
    valueEl.className = "sidebar-kv-value";
    valueEl.textContent = v;
    row.appendChild(labelEl);
    row.appendChild(valueEl);
    kv.appendChild(row);
  }
  body.appendChild(kv);

  if (primary) {
    const lead = document.createElement("div");
    lead.className = "panel-subtitle";
    lead.textContent = formatSelectedLead(selection || { title: "current scope" }, primary);
    body.appendChild(lead);
  }

  const list = document.createElement("div");
  list.className = "sidebar-event-list";
  for (const ev of evidence.slice(-4).reverse()) {
    const item = document.createElement("div");
    item.className = "sidebar-event-item";
    const meta = document.createElement("div");
    meta.className = "sidebar-event-meta";
    meta.textContent = `${friendlyTime(ev?.ts)} | ${ev?.kind || "-"} | ${ev?.mode || "-"}`;
    const main = document.createElement("div");
    main.className = "sidebar-event-main";
    main.textContent = ev?.data?.domain || ev?.site || "-";
    item.appendChild(meta);
    item.appendChild(main);
    list.appendChild(item);
  }
  body.appendChild(list);
}

function renderSidebarFiltersModule() {
  const metaEl = qs("sidebarFiltersMeta");
  const summaryEl = qs("sidebarFiltersSummary");
  const listEl = qs("sidebarFiltersList");
  if (!metaEl || !summaryEl || !listEl) return;

  const rangeLabel = qs("rangeSelect")?.selectedOptions?.[0]?.textContent || getRangeKey();
  metaEl.textContent = `Mode ${viewMode.toUpperCase()} | Range ${rangeLabel}`;

  const summaryText = qs("filterSummary")?.textContent || "";
  summaryEl.textContent = summaryText || "No filters applied.";

  listEl.innerHTML = "";
  const labels = [];
  labels.push(filterState.kind.blocked ? null : "Blocked kind hidden");
  labels.push(filterState.kind.observed ? null : "Observed kind hidden");
  labels.push(filterState.kind.other ? null : "Other kinds hidden");
  if (filterState.party !== "all") labels.push(`Party: ${PARTY_LABELS[filterState.party] || filterState.party}`);
  if (filterState.resource !== "all") labels.push(`Resource: ${RESOURCE_LABELS[filterState.resource] || filterState.resource}`);

  const text = String(filterState.domainText || "").trim();
  if (text) labels.push(`Text filter: ${text}`);

  const vizLabels = getActiveVizOptionLabels();
  for (const item of vizLabels) {
    labels.push(`Viz: ${item}`);
  }

  const clean = labels.filter(Boolean);
  if (!clean.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = "Default filter and chart options are active.";
    listEl.appendChild(li);
    return;
  }

  for (const item of clean) {
    const li = document.createElement("li");
    li.textContent = item;
    listEl.appendChild(li);
  }
}

function renderSidebarVendorProfile() {
  const metaEl = qs("sidebarVendorProfileMeta");
  const body = qs("sidebarVendorProfileBody");
  if (!metaEl || !body) return;
  body.innerHTML = "";

  const rows = buildVendorRollup(filteredEvents)
    .sort((a, b) => getVendorMetricValue(b) - getVendorMetricValue(a));
  let row = null;
  if (selectedVendor?.vendorId) {
    row = rows.find((entry) => entry.vendorId === selectedVendor.vendorId) || null;
  }
  if (!row) row = rows[0] || null;

  if (!row) {
    metaEl.textContent = "Quick stats for current vendor scope";
    addSidebarMutedText(body, "No vendor data available for this range/filters.");
    return;
  }

  const selected = selectedVendor?.vendorId === row.vendorId;
  metaEl.textContent = selected
    ? `${row.vendorName} (selected vendor)`
    : `${row.vendorName} (top vendor in current scope)`;

  const kv = document.createElement("div");
  kv.className = "sidebar-kv-list";
  const metrics = [
    ["Category", String(row.category || "unmapped")],
    ["Events", String(row.seen || 0)],
    ["Blocked", String(row.blocked || 0)],
    ["Observed", String(row.observed || 0)],
    ["Other", String(row.other || 0)],
    ["Unique domains", String(Array.isArray(row.domains) ? row.domains.length : 0)],
  ];
  for (const [k, v] of metrics) {
    const item = document.createElement("div");
    item.className = "sidebar-kv";
    const kEl = document.createElement("div");
    kEl.className = "sidebar-kv-label";
    kEl.textContent = k;
    const vEl = document.createElement("div");
    vEl.className = "sidebar-kv-value";
    vEl.textContent = v;
    item.appendChild(kEl);
    item.appendChild(vEl);
    kv.appendChild(item);
  }
  body.appendChild(kv);

  const domains = Array.isArray(row.domains) ? row.domains.slice(0, 4) : [];
  if (domains.length) {
    const domainNote = document.createElement("div");
    domainNote.className = "panel-subtitle";
    domainNote.textContent = `Domains: ${domains.join(", ")}`;
    body.appendChild(domainNote);
  }

  const hints = Array.isArray(row.riskHints) ? row.riskHints.filter(Boolean).slice(0, 3) : [];
  if (hints.length) {
    const list = document.createElement("ul");
    list.className = "sidebar-mini-list";
    for (const hint of hints) {
      const li = document.createElement("li");
      li.textContent = hint;
      list.appendChild(li);
    }
    body.appendChild(list);
  }
}

function renderSidebarModules() {
  renderSidebarFiltersModule();
  renderSidebarSelectedEvidence();
  renderSidebarVendorProfile();
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
  renderSidebarModules();
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

function renderLensNotice({ active = false, vendorName = "" } = {}) {
  const box = qs("vizLensNotice");
  if (!box) return;

  if (!active) {
    box.classList.add("hidden");
    box.innerHTML = "";
    return;
  }

  box.classList.remove("hidden");
  box.innerHTML = "";

  const msg = document.createElement("div");
  msg.className = "viz-lens-message";
  msg.textContent = `Focused lens active${vendorName ? ` for ${vendorName}` : ""}: compare view had too few bars to be informative.`;

  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "viz-lens-action";
  btn.textContent = "Show compare anyway";
  btn.addEventListener("click", () => {
    forceVendorCompareOnce = true;
    renderECharts();
  });

  box.appendChild(msg);
  box.appendChild(btn);
}

function buildFallbackScopeKpis(events) {
  const list = Array.isArray(events) ? events : [];
  let blocked = 0;
  let observed = 0;
  let thirdParty = 0;
  for (const ev of list) {
    if (ev?.kind === "network.blocked") blocked += 1;
    if (ev?.kind === "network.observed") observed += 1;
    if (ev?.data?.isThirdParty === true) thirdParty += 1;
  }

  return {
    total: list.length,
    blocked,
    observed,
    thirdParty,
    blockRate: blocked / Math.max(1, blocked + observed),
    thirdPartyRatio: thirdParty / Math.max(1, list.length),
    peakBurst: 0,
    maxBin: 0,
    medianNonZeroBin: 0,
  };
}

function renderScopeInsights(events) {
  const lensApi = getSiteLens();
  const kpiBox = qs("vizKpiStrip");
  const calloutBox = qs("vizCallouts");
  const list = Array.isArray(events) ? events : [];
  const kpis = lensApi?.buildScopeKpis
    ? lensApi.buildScopeKpis(list, getTimelineBinMs())
    : buildFallbackScopeKpis(list);

  if (kpiBox) {
    kpiBox.innerHTML = "";
    const cards = [
      { label: "Events", value: String(Number(kpis.total || 0)) },
      { label: "Block rate", value: formatPercent(kpis.blockRate) },
      { label: "3P ratio", value: formatPercent(kpis.thirdPartyRatio) },
      { label: "Peak burst", value: `${Number(kpis.peakBurst || 0).toFixed(2)}x` },
    ];

    for (const card of cards) {
      const item = document.createElement("div");
      item.className = "viz-kpi-card";
      const label = document.createElement("div");
      label.className = "viz-kpi-label";
      label.textContent = card.label;
      const value = document.createElement("div");
      value.className = "viz-kpi-value";
      value.textContent = card.value;
      item.appendChild(label);
      item.appendChild(value);
      kpiBox.appendChild(item);
    }
  }

  if (calloutBox) {
    calloutBox.innerHTML = "";
    const callouts = lensApi?.buildScopeCallouts
      ? lensApi.buildScopeCallouts(list, kpis)
      : ["Scope insights unavailable."];
    for (const text of callouts) {
      const li = document.createElement("li");
      li.textContent = String(text || "");
      calloutBox.appendChild(li);
    }
  }
}

function closeDrawer() {
  qs("vizDrawer")?.classList.add("hidden");
  qs("vizDrawerBackdrop")?.classList.add("hidden");
}

function setDrawerMode(mode) {
  drawerMode = mode;
  qs("drawerNormalBtn")?.classList.toggle("active", mode === "normal");
  qs("drawerAdvancedBtn")?.classList.toggle("active", mode === "advanced");
}

function explainEventNormal(ev) {
  if (!ev) return "No event selected.";

  const d = ev.data || {};
  if (ev.kind === "network.blocked") {
    return `A request to ${d.domain || "a domain"} was blocked (mode: ${ev.mode || "-"}). This can prevent trackers/ads/scripts from loading.`;
  }

  if (ev.kind === "network.observed") {
    return `A request to ${d.domain || "a domain"} was observed (allowed). This can indicate third-party activity on the page.`;
  }

  if (String(ev.kind || "").startsWith("cookies.")) {
    return `A cookies event occurred (${ev.kind}). Cookie-related activity was recorded for analysis.`;
  }

  return `Event recorded: ${ev.kind || "unknown"}.`;
}

function explainEventAdvanced(ev) {
  if (!ev) return "";

  const d = ev.data || {};
  return [
    `id: ${ev.id || "-"}`,
    `ts: ${ev.ts ? new Date(ev.ts).toLocaleString() : "-"}`,
    `site: ${ev.site || "-"}`,
    `kind: ${ev.kind || "-"}`,
    `mode: ${ev.mode || "-"}`,
    `domain: ${d.domain || "-"}`,
    `url: ${d.url || "-"}`,
    `resourceType: ${d.resourceType || "-"}`,
    `isThirdParty: ${typeof d.isThirdParty === "boolean" ? d.isThirdParty : "-"}`,
    `ruleId: ${d.ruleId || "-"}`,
  ].join("\n");
}

function renderListItems(el, items, emptyText) {
  if (!el) return;
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  el.innerHTML = "";
  if (!list.length) {
    const li = document.createElement("li");
    li.className = "muted";
    li.textContent = emptyText;
    el.appendChild(li);
    return;
  }
  for (const item of list) {
    const li = document.createElement("li");
    li.textContent = item;
    el.appendChild(li);
  }
}

function isOffScreen(el) {
  if (!el) return false;
  const rect = el.getBoundingClientRect();
  const viewportH = window.innerHeight || document.documentElement.clientHeight || 0;
  const topSafe = 72;
  const bottomSafe = viewportH - 48;
  return rect.top < topSafe || rect.bottom > bottomSafe;
}

function getScrollTop() {
  return window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
}

function smoothScrollViewportTo(targetY, { durationMs = 520 } = {}) {
  const target = Math.max(0, Number(targetY || 0));
  const start = getScrollTop();
  const delta = target - start;
  if (Math.abs(delta) < 2) return;

  if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) {
    window.scrollTo({ top: target, left: 0, behavior: "auto" });
    return;
  }

  if (insightScrollRaf) {
    cancelAnimationFrame(insightScrollRaf);
    insightScrollRaf = null;
  }

  const startTime = performance.now();
  const easeInOutCubic = (t) => (t < 0.5
    ? 4 * t * t * t
    : 1 - (Math.pow(-2 * t + 2, 3) / 2));

  const tick = (now) => {
    const elapsed = now - startTime;
    const progress = Math.min(1, elapsed / Math.max(120, durationMs));
    const eased = easeInOutCubic(progress);
    window.scrollTo(0, start + delta * eased);
    if (progress < 1) {
      insightScrollRaf = requestAnimationFrame(tick);
    } else {
      insightScrollRaf = null;
    }
  };

  insightScrollRaf = requestAnimationFrame(tick);
}

function pulseElement(el, className = "attention-pulse") {
  if (!el) return;
  el.classList.remove(className);
  void el.offsetWidth;
  el.classList.add(className);
}

function ensureInsightVisible({ force = false, source = "selection" } = {}) {
  const section = qs("insightSheet");
  if (!section) return;
  if (!(force || isOffScreen(section))) return;

  const rect = section.getBoundingClientRect();
  const targetY = getScrollTop() + rect.top - 72;
  const durationMs = source === "vendor" ? 640 : 460;
  smoothScrollViewportTo(targetY, { durationMs });
  pulseElement(section);
}

function hideVendorSelectionCue() {
  if (vendorSelectionCueTimer) {
    clearTimeout(vendorSelectionCueTimer);
    vendorSelectionCueTimer = null;
  }
  qs("vendorSelectionCue")?.classList.add("hidden");
}

function showVendorSelectionCue(vendorName, count = 0) {
  const box = qs("vendorSelectionCue");
  const text = qs("vendorSelectionCueText");
  if (!box || !text) return;

  const countText = Number.isFinite(Number(count)) && Number(count) > 0
    ? ` (${Number(count)} events in current scope)`
    : "";
  text.textContent = `Selected vendor: ${vendorName}${countText}. Info and Vendor profile were updated.`;
  box.classList.remove("hidden");
  pulseElement(box);

  if (vendorSelectionCueTimer) clearTimeout(vendorSelectionCueTimer);
  vendorSelectionCueTimer = setTimeout(() => {
    box.classList.add("hidden");
  }, 4200);
}

function focusVendorDetailsUx(vendorName, count = 0) {
  if (!vendorName) return;
  showVendorSelectionCue(vendorName, count);
  selectSidebarModule("vendorProfile");
  pulseElement(qs("sidebarModuleVendorProfile"));
}

function resetInsightSection() {
  if (qs("insightTitle")) qs("insightTitle").textContent = "Info";
  if (qs("insightMeta")) qs("insightMeta").textContent = "Select a chart point to explain current evidence.";
  if (qs("insightSelectedLead")) qs("insightSelectedLead").textContent = "You selected: no datapoint yet.";
  if (qs("insightSummary")) qs("insightSummary").textContent = "No selection yet. Choose a datapoint or press Explain / Info to summarize the current scope.";
  if (qs("insightHow")) qs("insightHow").textContent = "This section describes deterministic evidence from current range, filters, and selected scope.";
  renderListItems(qs("insightWhy"), [], "No immediate risk narrative until evidence is selected.");
  renderListItems(qs("insightLimits"), [], "Derived from captured events only; not a complete audit of all page behavior.");
  renderInsightActions([]);
}

function closeInsightSheet() {
  resetInsightSection();
}

function setInsightSeverity(severity, confidence) {
  const badge = qs("insightSeverity");
  if (!badge) return;
  badge.classList.remove("severity-info", "severity-caution", "severity-high");
  if (severity === "high") {
    badge.classList.add("severity-high");
    badge.textContent = `High (${Math.round((confidence || 0) * 100)}% confidence)`;
    return;
  }
  if (severity === "caution") {
    badge.classList.add("severity-caution");
    badge.textContent = `Caution (${Math.round((confidence || 0) * 100)}% confidence)`;
    return;
  }
  badge.classList.add("severity-info");
  badge.textContent = `Info (${Math.round((confidence || 0) * 100)}% confidence)`;
}

function showToast(message, isError = false) {
  const el = qs("actionToast");
  if (!el) return;
  el.textContent = message || "";
  el.style.borderColor = isError ? "rgba(251,113,133,0.55)" : "rgba(148,163,184,0.3)";
  el.classList.remove("hidden");
  setTimeout(() => {
    el.classList.add("hidden");
  }, 2400);
}

function closeConfirmModal() {
  qs("confirmModalBackdrop")?.classList.add("hidden");
  qs("confirmModal")?.classList.add("hidden");
  pendingConfirmAction = null;
}

function openConfirmModal({ title, body, onConfirm }) {
  pendingConfirmAction = typeof onConfirm === "function" ? onConfirm : null;
  if (qs("confirmTitle")) qs("confirmTitle").textContent = title || "Confirm action";
  if (qs("confirmBody")) qs("confirmBody").textContent = body || "";
  qs("confirmModalBackdrop")?.classList.remove("hidden");
  qs("confirmModal")?.classList.remove("hidden");
}

async function postPolicyAction(payload) {
  const res = await fetch("/api/policies", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`Policy action failed HTTP ${res.status}`);
  return res.json();
}

function exportEvidence(events) {
  const list = Array.isArray(events) ? events : [];
  if (!list.length) {
    showToast("No evidence selected to export.", true);
    return;
  }

  const csvLines = ["id,ts,site,kind,mode,domain,url,resourceType,isThirdParty,ruleId"];
  for (const ev of list) {
    const d = ev?.data || {};
    csvLines.push([
      ev?.id || "",
      ev?.ts || "",
      ev?.site || "",
      ev?.kind || "",
      ev?.mode || "",
      d?.domain || "",
      d?.url || "",
      d?.resourceType || "",
      typeof d?.isThirdParty === "boolean" ? d.isThirdParty : "",
      d?.ruleId || "",
    ].map(escapeCsvCell).join(","));
  }

  const blob = new Blob([csvLines.join("\n")], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  triggerDownload(url);
  setTimeout(() => URL.revokeObjectURL(url), 3000);
}

async function executeInsightAction(action) {
  if (!action) return;
  if (action.type === "export_evidence") {
    exportEvidence(activeEvidence);
    showToast("Exported selected evidence.");
    return;
  }

  if (action.type === "trust_site" || action.type === "block_domain") {
    await postPolicyAction(action.payload);
    showToast(`${action.label} applied.`);
  }
}

function renderInsightActions(actions) {
  const box = qs("insightActions");
  if (!box) return;
  box.innerHTML = "";

  const list = Array.isArray(actions) ? actions : [];
  for (const action of list) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "insight-action-btn";
    btn.textContent = action.label || action.type;
    btn.addEventListener("click", async () => {
      const run = async () => {
        try {
          await executeInsightAction(action);
        } catch (err) {
          console.error(err);
          showToast("Action failed. Check backend/extension connection.", true);
        }
      };

      const needsConfirm = !!action.requiresConfirm && viewMode === "easy";
      if (needsConfirm) {
        openConfirmModal({
          title: action.confirmTitle || "Confirm action",
          body: action.confirmBody || "Are you sure you want to continue?",
          onConfirm: run,
        });
        return;
      }

      await run();
    });
    box.appendChild(btn);
  }
}

function buildFallbackInsight(selection, evidence) {
  const total = evidence.length;
  const blocked = evidence.filter((e) => e?.kind === "network.blocked").length;
  const observed = evidence.filter((e) => e?.kind === "network.observed").length;
  return {
    title: selection?.title || "Insight",
    summary: `${total} events selected (${blocked} blocked, ${observed} observed).`,
    severity: total >= 40 ? "caution" : "info",
    confidence: total >= 10 ? 0.72 : 0.45,
    warnings: ["Selection evidence is based on current filters and range."],
    dangers: ["Third-party requests can expose browsing behavior to external services."],
    precautions: ["Review vendor necessity before allowing persistent activity."],
    actions: [
      {
        type: "trust_site",
        label: "Trust this site",
        payload: { op: "trust_site", payload: { site: siteName } },
        requiresConfirm: true,
        confirmTitle: "Trust this site?",
        confirmBody: "Trusting can reduce protection for this site.",
      },
      {
        type: "export_evidence",
        label: "Export selected evidence",
      },
    ],
    evidenceSummary: {
      total,
      blocked,
      observed,
      other: Math.max(0, total - blocked - observed),
      firstTs: evidence[0]?.ts || null,
      lastTs: evidence[evidence.length - 1]?.ts || null,
      dominantKinds: [],
    },
  };
}

function openInsightSheet(selection, evidence, {
  forceScroll = false,
  allowAutoScroll = true,
  scrollSource = "selection",
} = {}) {
  const insightApi = getInsightRules();
  const evs = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
  activeEvidence = evs;
  const primaryEvent = pickPrimarySelectedEvent(evs);

  const context = {
    events: evs,
    viewId: VIEWS[vizIndex]?.id || "unknown",
    viewMode,
    siteName,
    selectedVendor,
    selectedDomain: selection?.type === "domain" ? selection.value : "",
  };

  const insight = insightApi?.buildInsightResult
    ? insightApi.buildInsightResult(context)
    : buildFallbackInsight(selection, evs);

  if (qs("insightTitle")) qs("insightTitle").textContent = insight.title || "Info";
  if (qs("insightMeta")) qs("insightMeta").textContent = `${evs.length} events selected`;
  if (qs("insightSelectedLead")) qs("insightSelectedLead").textContent = formatSelectedLead(selection, primaryEvent);
  if (qs("insightSummary")) qs("insightSummary").textContent = insight.summary || "No summary generated.";

  setInsightSeverity(insight.severity, insight.confidence);

  const summary = insight.evidenceSummary || {};
  const firstText = summary.firstTs ? new Date(summary.firstTs).toLocaleTimeString() : "-";
  const lastText = summary.lastTs ? new Date(summary.lastTs).toLocaleTimeString() : "-";
  const dominant = Array.isArray(summary.dominantKinds) && summary.dominantKinds.length
    ? summary.dominantKinds.map((d) => `${d.kind}:${d.count}`).join(", ")
    : "-";

  if (qs("insightHow")) {
    const label = selection?.title || "current scope";
    qs("insightHow").textContent = `From ${label}: total ${summary.total || 0}, blocked ${summary.blocked || 0}, observed ${summary.observed || 0}, first ${firstText}, last ${lastText}, dominant ${dominant}.`;
  }

  const whyItems = [
    ...(Array.isArray(insight.warnings) ? insight.warnings : []),
    ...(Array.isArray(insight.dangers) ? insight.dangers : []),
  ];
  const baseLimits = Array.isArray(insight.precautions) ? insight.precautions : [];
  const limits = [
    ...baseLimits,
    "Evidence is constrained by current range/filters and captured events only.",
  ];
  if (evs.length < 8) {
    limits.push("Low confidence due to small sample size; gather more events before acting.");
  }

  renderListItems(qs("insightWhy"), whyItems, "No immediate risk narrative for this scope.");
  renderListItems(qs("insightLimits"), limits, "No additional caveats.");

  renderInsightActions(insight.actions || []);
  if (forceScroll || allowAutoScroll) {
    ensureInsightVisible({ force: !!forceScroll, source: scrollSource });
  }
}

function openDrawer(title, summaryHtml, evidenceEvents) {
  const drawer = qs("vizDrawer");
  const backdrop = qs("vizDrawerBackdrop");
  if (!drawer || !backdrop) return;

  qs("drawerTitle").textContent = title || "Selection";
  qs("drawerSummary").innerHTML = summaryHtml || "";

  const box = qs("drawerEvents");
  box.innerHTML = "";

  const list = (evidenceEvents || []).slice(-20).reverse();
  if (!list.length) {
    box.innerHTML = '<div class="muted">No matching events.</div>';
  } else {
    for (const ev of list) {
      const btn = document.createElement("button");
      btn.className = "event-row";
      btn.type = "button";
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.textAlign = "left";
      btn.style.padding = "8px 10px";
      btn.style.border = "1px solid rgba(148,163,184,0.18)";
      btn.style.background = "rgba(15,23,42,0.3)";
      btn.style.color = "#e5e7eb";
      btn.style.marginBottom = "8px";
      btn.innerHTML = `<div style="font-size:12px;opacity:.8">${friendlyTime(ev.ts)} | ${ev.kind || "-"} | ${ev.mode || "-"}</div>
                       <div style="font-size:13px">${ev.data?.domain || "-"}</div>`;

      btn.addEventListener("click", () => {
        const normal = explainEventNormal(ev);
        const adv = explainEventAdvanced(ev).replaceAll("\n", "<br/>");
        const content = drawerMode === "advanced"
          ? `<pre style="white-space:pre-wrap">${adv}</pre>`
          : `<div>${normal}</div>`;
        qs("drawerSummary").innerHTML = content;
      });

      box.appendChild(btn);
    }
  }

  drawer.classList.remove("hidden");
  backdrop.classList.remove("hidden");
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

  if (viewId === "timeline" || viewId === "riskTrend") {
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
  activeEvidence = [];
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
  buildVendorKindMatrixOption,
  buildRuleIdFrequencyOption,
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
      if (viewId !== "timeline" && viewId !== "riskTrend") return;

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
    renderLensNotice({ active: false });
    renderScopeInsights(events);
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

  renderLensNotice({
    active: lensPivotActive,
    vendorName: selectedVendor?.vendorName || "",
  });
  renderScopeInsights(events);

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

  if (viewId === "timeline" || viewId === "riskTrend") {
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
  if (!row) return 0;
  if (vizOptions.metric === "blocked") return row.blocked || 0;
  if (vizOptions.metric === "observed") return row.observed || 0;
  return row.seen || 0;
}

function buildVendorRollup(events) {
  const taxonomy = getVendorTaxonomy();
  if (taxonomy?.rollupVendors) return taxonomy.rollupVendors(events);

  const map = new Map();
  for (const ev of events || []) {
    const vendor = classifyVendorForEvent(ev);
    if (!map.has(vendor.vendorId)) {
      map.set(vendor.vendorId, {
        vendorId: vendor.vendorId,
        vendorName: vendor.vendorName,
        category: vendor.category || "unmapped",
        domains: [],
        riskHints: vendor.riskHints || [],
        seen: 0,
        blocked: 0,
        observed: 0,
        other: 0,
        evs: [],
      });
    }
    const row = map.get(vendor.vendorId);
    row.seen += 1;
    if (ev?.kind === "network.blocked") row.blocked += 1;
    else if (ev?.kind === "network.observed") row.observed += 1;
    else row.other += 1;
    if (vendor.domain && !row.domains.includes(vendor.domain)) row.domains.push(vendor.domain);
    row.evs.push(ev);
  }
  return Array.from(map.values());
}

function renderVendorChips() {
  const box = qs("vendorChips");
  if (!box) return;
  box.innerHTML = "";

  const allRows = buildVendorRollup(filteredEvents)
    .sort((a, b) => getVendorMetricValue(b) - getVendorMetricValue(a));

  if (selectedVendor?.vendorId && !allRows.some((r) => r.vendorId === selectedVendor.vendorId)) {
    selectedVendor = null;
    hideVendorSelectionCue();
  }

  const rows = allRows
    .slice(0, viewMode === "easy" ? 8 : 14);

  const allBtn = document.createElement("button");
  allBtn.type = "button";
  allBtn.className = `vendor-chip ${!selectedVendor ? "active" : ""}`.trim();
  allBtn.textContent = "All vendors";
  allBtn.addEventListener("click", () => {
    selectedVendor = null;
    selectedInsightTarget = null;
    hideVendorSelectionCue();
    clearVizSelection({ close: true, clearBrush: true, renderTable: false });
    renderVendorChips();
    renderECharts();
    renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
    updateFilterSummary();
  });
  box.appendChild(allBtn);

  for (const row of rows) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = `vendor-chip ${selectedVendor?.vendorId === row.vendorId ? "active" : ""}`.trim();
    const metricValue = getVendorMetricValue(row);
    btn.textContent = `${row.vendorName} (${metricValue})`;
    btn.addEventListener("click", () => {
      selectedVendor = {
        vendorId: row.vendorId,
        vendorName: row.vendorName,
        category: row.category,
        domains: row.domains || [],
        riskHints: row.riskHints || [],
      };
      selectedInsightTarget = { type: "vendor", value: row.vendorName };
      clearVizSelection({ close: true, clearBrush: true, renderTable: false });
      renderVendorChips();
      renderECharts();
      focusVendorDetailsUx(row.vendorName, row.seen || 0);
      renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
      updateFilterSummary();
    });
    box.appendChild(btn);
  }
}

function applyFilterChanges() {
  readFilterStateFromControls();
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

function initSidebarModuleControls() {
  selectedSidebarModule = loadSelectedSidebarModule();
  applySelectedSidebarModuleToDom();

  for (const moduleId of SIDEBAR_MODULE_ORDER) {
    const btn = qs(SIDEBAR_BUTTON_IDS[moduleId]);
    if (!btn) continue;
    btn.addEventListener("click", () => {
      selectSidebarModule(moduleId);
    });
  }

  qs("sidebarResetFiltersBtn")?.addEventListener("click", () => {
    filterState = defaultFilterState();
    writeFilterStateToControls();
    applyFilterChanges();
  });
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
  initSidebarModuleControls();

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
    const action = pendingConfirmAction;
    closeConfirmModal();
    if (action) {
      try {
        await action();
      } catch (err) {
        console.error(err);
        showToast("Action failed. Check backend/extension connection.", true);
      }
    }
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
  updateFilterSummary();
  resetInsightSection();

  fetchSite();
  setInterval(fetchSite, POLL_MS);
}

