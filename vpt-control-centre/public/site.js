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

function defaultFilterState() {
  return {
    kind: {
      blocked: true,
      observed: true,
      other: true,
    },
    party: "all",
    resource: "all",
    domainText: "",
  };
}

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

function defaultVizOptions() {
  return {
    metric: "seen",
    seriesType: "auto",
    topN: 20,
    sort: "value_desc",
    binSize: "5m",
    normalize: false,
    stackBars: true,
  };
}

function qs(id) {
  return document.getElementById(id);
}

function getQueryParam(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function friendlyTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setStatus(ok, text) {
  const el = qs("siteConnectionStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? "#10b981" : "#f97316";
}

function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function buildExportUrl(format, params = {}) {
  const base = format === "csv" ? "/api/export/events.csv" : "/api/export/events.json";
  const q = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    q.set(k, v);
  }

  return `${base}?${q.toString()}`;
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

function syncVizSelectByMode() {
  const select = qs("vizSelect");
  if (!select) return;

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

function renderRecentEventsFromEvents(events, emptyMessage = "No events match current filters.") {
  const tbody = qs("recentEventsBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const list = Array.isArray(events) ? events : [];

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

function getKindBucket(ev) {
  if (ev?.kind === "network.blocked") return "blocked";
  if (ev?.kind === "network.observed") return "observed";
  return "other";
}

function getPartyBucket(ev) {
  if (ev?.data?.isThirdParty === true) return "third";
  return "first_or_unknown";
}

function getResourceBucket(ev) {
  const rt = String(ev?.data?.resourceType || "").toLowerCase();

  if (rt.includes("script")) return "script";
  if (rt.includes("xhr") || rt.includes("fetch") || rt.includes("xmlhttprequest")) return "xhr_fetch";
  if (rt.includes("image")) return "image";
  if (rt.includes("sub_frame") || rt.includes("subframe")) return "sub_frame";
  return "other";
}

function matchesFilters(ev, state) {
  const kindBucket = getKindBucket(ev);
  if (!state.kind[kindBucket]) return false;

  if (state.party !== "all" && getPartyBucket(ev) !== state.party) return false;

  if (state.resource !== "all" && getResourceBucket(ev) !== state.resource) return false;

  const term = String(state.domainText || "").trim().toLowerCase();
  if (term) {
    const domain = String(ev?.data?.domain || "").toLowerCase();
    const url = String(ev?.data?.url || "").toLowerCase();
    const site = String(ev?.site || "").toLowerCase();

    if (!domain.includes(term) && !url.includes(term) && !site.includes(term)) {
      return false;
    }
  }

  return true;
}

function deriveFilteredEvents() {
  const base = Array.isArray(windowEvents) ? windowEvents : [];
  filteredEvents = base.filter((ev) => matchesFilters(ev, filterState));
  updateFilterSummary();
  return filteredEvents;
}

function getActiveFilterLabels() {
  const labels = [];

  const kinds = [];
  if (filterState.kind.blocked) kinds.push("blocked");
  if (filterState.kind.observed) kinds.push("observed");
  if (filterState.kind.other) kinds.push("other");
  if (kinds.length !== 3) labels.push(`kind=${kinds.join("+") || "none"}`);

  if (filterState.party !== "all") labels.push(`party=${filterState.party}`);
  if (filterState.resource !== "all") labels.push(`resource=${filterState.resource}`);

  const term = String(filterState.domainText || "").trim();
  if (term) labels.push(`text=${term}`);

  return labels;
}

function getActiveVizOptionLabels() {
  const labels = [];
  const defaults = defaultVizOptions();

  if (vizOptions.metric !== defaults.metric) labels.push(`metric=${vizOptions.metric}`);
  if (vizOptions.seriesType !== defaults.seriesType) labels.push(`series=${vizOptions.seriesType}`);
  if (vizOptions.topN !== defaults.topN) labels.push(`top=${vizOptions.topN}`);
  if (vizOptions.sort !== defaults.sort) labels.push(`sort=${vizOptions.sort}`);
  if (vizOptions.binSize !== defaults.binSize) labels.push(`bin=${vizOptions.binSize}`);
  if (vizOptions.normalize !== defaults.normalize) labels.push("normalize=%");
  if (vizOptions.stackBars !== defaults.stackBars) labels.push(`stack=${vizOptions.stackBars ? "on" : "off"}`);

  return labels;
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
}

function readFilterStateFromControls() {
  filterState.kind.blocked = !!qs("kindBlockedToggle")?.checked;
  filterState.kind.observed = !!qs("kindObservedToggle")?.checked;
  filterState.kind.other = !!qs("kindOtherToggle")?.checked;

  filterState.party = qs("partyFilter")?.value || "all";
  filterState.resource = qs("resourceFilter")?.value || "all";
  filterState.domainText = qs("domainFilter")?.value || "";
}

function writeFilterStateToControls() {
  if (qs("kindBlockedToggle")) qs("kindBlockedToggle").checked = !!filterState.kind.blocked;
  if (qs("kindObservedToggle")) qs("kindObservedToggle").checked = !!filterState.kind.observed;
  if (qs("kindOtherToggle")) qs("kindOtherToggle").checked = !!filterState.kind.other;

  if (qs("partyFilter")) qs("partyFilter").value = filterState.party;
  if (qs("resourceFilter")) qs("resourceFilter").value = filterState.resource;
  if (qs("domainFilter")) qs("domainFilter").value = filterState.domainText;
}

function readVizOptionsFromControls() {
  vizOptions.metric = qs("vizMetricSelect")?.value || "seen";
  vizOptions.seriesType = qs("vizSeriesTypeSelect")?.value || "auto";
  vizOptions.topN = Number(qs("vizTopNSelect")?.value || 20);
  vizOptions.sort = qs("vizSortSelect")?.value || "value_desc";
  vizOptions.binSize = qs("vizBinSizeSelect")?.value || "5m";
  vizOptions.normalize = !!qs("vizNormalizeToggle")?.checked;
  vizOptions.stackBars = !!qs("vizStackToggle")?.checked;
}

function writeVizOptionsToControls() {
  if (qs("vizMetricSelect")) qs("vizMetricSelect").value = vizOptions.metric;
  if (qs("vizSeriesTypeSelect")) qs("vizSeriesTypeSelect").value = vizOptions.seriesType;
  if (qs("vizTopNSelect")) qs("vizTopNSelect").value = String(vizOptions.topN);
  if (qs("vizSortSelect")) qs("vizSortSelect").value = vizOptions.sort;
  if (qs("vizBinSizeSelect")) qs("vizBinSizeSelect").value = vizOptions.binSize;
  if (qs("vizNormalizeToggle")) qs("vizNormalizeToggle").checked = !!vizOptions.normalize;
  if (qs("vizStackToggle")) qs("vizStackToggle").checked = !!vizOptions.stackBars;
}

function formatPercent(value) {
  const n = Number(value || 0);
  return `${(n * 100).toFixed(1)}%`;
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

function ensureInsightVisible({ force = false } = {}) {
  const section = qs("insightSheet");
  if (!section) return;
  if (force || isOffScreen(section)) {
    section.scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

function resetInsightSection() {
  if (qs("insightTitle")) qs("insightTitle").textContent = "Info";
  if (qs("insightMeta")) qs("insightMeta").textContent = "Select a chart point to explain current evidence.";
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

function escapeCsvCell(value) {
  const text = String(value ?? "");
  const escaped = text.replaceAll("\"", "\"\"");
  return `"${escaped}"`;
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

function openInsightSheet(selection, evidence, { forceScroll = false } = {}) {
  const insightApi = getInsightRules();
  const evs = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
  activeEvidence = evs;

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
  ensureInsightVisible({ force: !!forceScroll });
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

function clearVizSelection({ close = true, clearBrush = true, renderTable = true } = {}) {
  vizSelection = null;
  selectedInsightTarget = null;
  activeEvidence = [];

  if (clearBrush) clearBrushSelection();
  if (close) {
    closeDrawer();
    closeInsightSheet();
  }

  if (renderTable) {
    renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
  }

  updateFilterSummary();
}

function setVizSelection({ type, value, fromTs = null, toTs = null, title, summaryHtml, events }) {
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

  renderRecentEventsFromEvents(evidence, "No events match selection.");
  selectedInsightTarget = { type, value };
  openInsightSheet(vizSelection, evidence, { forceScroll: false });
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
    ensureInsightVisible({ force: forceScroll });
    return;
  }

  openInsightSheet(scopeSelection, evidence, { forceScroll });
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
  return true;
}

function buildEmptyChartOption(message) {
  return {
    title: {
      text: message,
      left: "center",
      top: "middle",
      textStyle: {
        color: "#94a3b8",
        fontSize: 14,
        fontWeight: 500,
      },
    },
    xAxis: { show: false, type: "category", data: [] },
    yAxis: { show: false, type: "value" },
    series: [],
  };
}

function getTimelineBinMs() {
  return BIN_SIZE_MS[vizOptions.binSize] || BIN_SIZE_MS["5m"];
}

function getSeriesType(defaultType = "bar") {
  if (vizOptions.seriesType === "area") return "line";
  if (vizOptions.seriesType === "bar" || vizOptions.seriesType === "line") return vizOptions.seriesType;
  return defaultType;
}

function buildSeries(name, data, { defaultType = "bar", stackKey = null } = {}) {
  const type = getSeriesType(defaultType);
  const series = { name, type, data };

  if (type === "line") {
    series.smooth = 0.2;
    series.symbol = "none";
    if (vizOptions.seriesType === "area") {
      series.areaStyle = { opacity: 0.22 };
    }
  }

  if (type === "bar" && stackKey && vizOptions.stackBars) {
    series.stack = stackKey;
  }

  return series;
}

function sortRankedRows(list) {
  const rows = Array.isArray(list) ? list.slice() : [];
  if (vizOptions.sort === "label_asc") {
    rows.sort((a, b) => String(a.label || "").localeCompare(String(b.label || ""), undefined, { sensitivity: "base" }));
    return rows;
  }

  if (vizOptions.sort === "value_asc") {
    rows.sort((a, b) => (a.value || 0) - (b.value || 0));
    return rows;
  }

  rows.sort((a, b) => (b.value || 0) - (a.value || 0));
  return rows;
}

function normalizeRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!vizOptions.normalize) return list;

  const total = list.reduce((acc, row) => acc + (row.value || 0), 0);
  if (!total) return list;

  return list.map((row) => ({
    ...row,
    rawValue: row.value || 0,
    value: Number((((row.value || 0) * 100) / total).toFixed(2)),
  }));
}

function buildBarLikeOption(rows, { seriesName = "count", defaultType = "bar", maxLabels = 20, axisLabelRotate = 45 } = {}) {
  const ranked = sortRankedRows(rows).slice(0, maxLabels);
  const normalized = normalizeRows(ranked);
  const labels = normalized.map((row) => row.label);
  const values = normalized.map((row) => row.value || 0);
  const evidenceByLabel = new Map(normalized.map((row) => [row.label, row.evs || []]));

  return {
    option: {
      tooltip: { trigger: "axis" },
      grid: { left: 40, right: 18, top: 18, bottom: 120 },
      xAxis: { type: "category", data: labels, axisLabel: { rotate: axisLabelRotate } },
      yAxis: {
        type: "value",
        max: vizOptions.normalize ? 100 : null,
        axisLabel: vizOptions.normalize ? { formatter: "{value}%" } : undefined,
      },
      series: [buildSeries(seriesName, values, { defaultType })],
    },
    meta: { evidenceByLabel, normalized: vizOptions.normalize },
  };
}

function buildTimelineOption(events) {
  const { from, to } = getRangeWindow();
  const start = from ?? (events[0]?.ts ?? Date.now());
  const end = to ?? (events[events.length - 1]?.ts ?? Date.now());

  const binMs = getTimelineBinMs();
  const span = Math.max(1, end - start);
  const bins = Math.max(1, Math.ceil(span / binMs));

  const labels = [];
  const blocked = new Array(bins).fill(0);
  const observed = new Array(bins).fill(0);
  const other = new Array(bins).fill(0);
  const binEvents = new Array(bins).fill(0).map(() => []);

  for (const ev of events) {
    if (!ev?.ts) continue;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((ev.ts - start) / binMs)));
    binEvents[idx].push(ev);

    if (ev.kind === "network.blocked") blocked[idx]++;
    else if (ev.kind === "network.observed") observed[idx]++;
    else other[idx]++;
  }

  for (let i = 0; i < bins; i++) {
    const t = new Date(start + i * binMs);
    labels.push(t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }

  return {
    option: {
      tooltip: { trigger: "axis" },
      legend: { top: 0 },
      toolbox: {
        right: 10,
        feature: {
          brush: { type: ["lineX", "clear"] },
          restore: {},
        },
      },
      brush: {
        xAxisIndex: 0,
        brushMode: "single",
      },
      grid: { left: 40, right: 18, top: 36, bottom: 60 },
      xAxis: { type: "category", data: labels },
      yAxis: { type: "value" },
      dataZoom: [
        { type: "inside" },
        { type: "slider", height: 18, bottom: 18 },
      ],
      series: [
        buildSeries("Blocked", blocked, { defaultType: "bar", stackKey: "total" }),
        buildSeries("Observed", observed, { defaultType: "bar", stackKey: "total" }),
        buildSeries("Other", other, { defaultType: "bar", stackKey: "total" }),
      ],
    },
    meta: { start, binMs, binEvents, labels },
  };
}

function isThirdPartyNetwork(ev) {
  return (ev?.kind === "network.blocked" || ev?.kind === "network.observed")
    && ev?.data?.domain
    && ev?.data?.isThirdParty === true;
}

function isApiLike(ev) {
  const rt = String(ev?.data?.resourceType || "").toLowerCase();
  const url = String(ev?.data?.url || "").toLowerCase();

  const looksApiPath =
    url.includes("/api/") || url.includes("/graphql") || url.includes("/v1/") || url.includes("/v2/") || url.includes("/rest/");

  const looksFetch = rt.includes("xhr") || rt.includes("fetch") || rt.includes("xmlhttprequest");

  return looksFetch || looksApiPath;
}

function buildTopDomainsOption(events, metric = "seen") {
  const map = new Map();

  for (const ev of events) {
    if (!isThirdPartyNetwork(ev)) continue;

    const d = ev.data.domain;
    if (!map.has(d)) map.set(d, { domain: d, seen: 0, blocked: 0, observed: 0, evs: [] });

    const obj = map.get(d);
    obj.seen++;
    if (ev.kind === "network.blocked") obj.blocked++;
    if (ev.kind === "network.observed") obj.observed++;
    obj.evs.push(ev);
  }

  const rows = Array.from(map.values()).map((item) => ({
    label: item.domain,
    value: item[metric] || 0,
    evs: item.evs,
  }));

  const built = buildBarLikeOption(rows, {
    seriesName: metric,
    defaultType: "bar",
    maxLabels: Math.max(5, vizOptions.topN),
    axisLabelRotate: 45,
  });

  return {
    option: built.option,
    meta: { evidenceByDomain: built.meta.evidenceByLabel, metric },
  };
}

function buildKindsOption(events) {
  const map = new Map();

  for (const ev of events) {
    const k = ev?.kind || "unknown";
    map.set(k, (map.get(k) || 0) + 1);
  }

  const eventMap = new Map();
  for (const ev of events) {
    const key = ev?.kind || "unknown";
    if (!eventMap.has(key)) eventMap.set(key, []);
    eventMap.get(key).push(ev);
  }

  const rows = Array.from(map.entries()).map(([label, value]) => ({
    label,
    value,
    evs: eventMap.get(label) || [],
  }));

  const built = buildBarLikeOption(rows, {
    seriesName: "kind count",
    defaultType: "bar",
    maxLabels: Math.max(6, vizOptions.topN),
    axisLabelRotate: 45,
  });

  return {
    option: built.option,
    meta: { evidenceByLabel: built.meta.evidenceByLabel, list: rows },
  };
}

function buildApiGatingOption(events) {
  const map = new Map();

  for (const ev of events) {
    if (!isThirdPartyNetwork(ev)) continue;
    if (!isApiLike(ev)) continue;

    const d = ev.data.domain;
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(ev);
  }

  const rows = Array.from(map.entries()).map(([domain, evs]) => ({
    label: domain,
    value: evs.length,
    evs,
  }));

  const built = buildBarLikeOption(rows, {
    seriesName: "API-like calls",
    defaultType: "bar",
    maxLabels: Math.max(5, vizOptions.topN),
    axisLabelRotate: 45,
  });

  return {
    option: built.option,
    meta: { evidenceByDomain: built.meta.evidenceByLabel },
  };
}

function buildResourceTypesOption(events) {
  const counts = new Map();
  const evsByType = new Map();

  for (const ev of events) {
    const bucket = getResourceBucket(ev);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
    if (!evsByType.has(bucket)) evsByType.set(bucket, []);
    evsByType.get(bucket).push(ev);
  }

  const rows = Array.from(counts.entries()).map(([key, value]) => ({
    label: RESOURCE_LABELS[key] || key,
    value,
    evs: evsByType.get(key) || [],
  }));

  const built = buildBarLikeOption(rows, {
    seriesName: "resource count",
    defaultType: "bar",
    maxLabels: 12,
    axisLabelRotate: 30,
  });

  return {
    option: built.option,
    meta: { evidenceByLabel: built.meta.evidenceByLabel },
  };
}

function buildModeBreakdownOption(events) {
  const counts = new Map();
  const evsByMode = new Map();

  for (const ev of events) {
    const mode = String(ev?.mode || "unknown");
    counts.set(mode, (counts.get(mode) || 0) + 1);
    if (!evsByMode.has(mode)) evsByMode.set(mode, []);
    evsByMode.get(mode).push(ev);
  }

  const rows = Array.from(counts.entries()).map(([label, value]) => ({
    label,
    value,
    evs: evsByMode.get(label) || [],
  }));

  const built = buildBarLikeOption(rows, {
    seriesName: "mode count",
    defaultType: "bar",
    maxLabels: 10,
    axisLabelRotate: 20,
  });

  return {
    option: built.option,
    meta: { evidenceByLabel: built.meta.evidenceByLabel },
  };
}

function buildPartySplitOption(events) {
  const counts = new Map();
  const evsByParty = new Map();

  for (const ev of events) {
    const bucket = getPartyBucket(ev);
    counts.set(bucket, (counts.get(bucket) || 0) + 1);
    if (!evsByParty.has(bucket)) evsByParty.set(bucket, []);
    evsByParty.get(bucket).push(ev);
  }

  const rows = Array.from(counts.entries()).map(([bucket, value]) => ({
    label: PARTY_LABELS[bucket] || bucket,
    value,
    evs: evsByParty.get(bucket) || [],
  }));

  const built = buildBarLikeOption(rows, {
    seriesName: "party split",
    defaultType: "bar",
    maxLabels: 4,
    axisLabelRotate: 0,
  });

  return {
    option: built.option,
    meta: { evidenceByLabel: built.meta.evidenceByLabel },
  };
}

function buildHourHeatmapOption(events) {
  const dayNames = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const hourLabels = Array.from({ length: 24 }, (_, h) => `${String(h).padStart(2, "0")}:00`);
  const cellCounts = new Map();
  const evidenceByCell = new Map();

  for (const ev of events) {
    if (!ev?.ts) continue;
    const d = new Date(ev.ts);
    const day = d.getDay();
    const hour = d.getHours();
    const key = `${day}:${hour}`;

    cellCounts.set(key, (cellCounts.get(key) || 0) + 1);
    if (!evidenceByCell.has(key)) evidenceByCell.set(key, []);
    evidenceByCell.get(key).push(ev);
  }

  const data = [];
  let max = 0;
  for (let day = 0; day < 7; day++) {
    for (let hour = 0; hour < 24; hour++) {
      const key = `${day}:${hour}`;
      const count = cellCounts.get(key) || 0;
      max = Math.max(max, count);
      data.push([hour, day, count]);
    }
  }

  return {
    option: {
      tooltip: {
        position: "top",
        formatter: (params) => {
          const value = Array.isArray(params?.value) ? params.value : [];
          const hour = Number(value[0] || 0);
          const day = Number(value[1] || 0);
          const count = Number(value[2] || 0);
          return `${dayNames[day]} ${hourLabels[hour]}<br/>Events: ${count}`;
        },
      },
      grid: { left: 45, right: 18, top: 22, bottom: 42 },
      xAxis: { type: "category", data: hourLabels, splitArea: { show: true } },
      yAxis: { type: "category", data: dayNames, splitArea: { show: true } },
      visualMap: {
        min: 0,
        max: max || 1,
        calculable: true,
        orient: "horizontal",
        left: "center",
        bottom: 0,
      },
      series: [
        {
          name: "Hourly activity",
          type: "heatmap",
          data,
          label: { show: false },
          emphasis: { itemStyle: { shadowBlur: 10, shadowColor: "rgba(0, 0, 0, 0.45)" } },
        },
      ],
    },
    meta: { evidenceByCell, dayNames, hourLabels },
  };
}

function buildVendorOverviewOption(events) {
  const rows = buildVendorRollup(events).map((row) => ({
    label: row.vendorName,
    value: getVendorMetricValue(row),
    evs: row.evs || [],
    vendor: {
      vendorId: row.vendorId,
      vendorName: row.vendorName,
      category: row.category,
      domains: row.domains || [],
      riskHints: row.riskHints || [],
    },
  }));

  const built = buildBarLikeOption(rows, {
    seriesName: `vendor ${vizOptions.metric}`,
    defaultType: "bar",
    maxLabels: Math.max(6, vizOptions.topN),
    axisLabelRotate: 35,
  });

  const vendorByLabel = new Map(rows.map((r) => [r.label, r.vendor]));
  return {
    option: built.option,
    meta: { evidenceByLabel: built.meta.evidenceByLabel, vendorByLabel },
  };
}

function riskBucketForEvent(ev) {
  const third = ev?.data?.isThirdParty === true;
  const rt = String(ev?.data?.resourceType || "").toLowerCase();
  const isScript = rt.includes("script");
  const isXhr = rt.includes("xhr") || rt.includes("fetch") || rt.includes("xmlhttprequest");
  const blocked = ev?.kind === "network.blocked";

  if (third && (isScript || isXhr) && !blocked) return "high";
  if (third && blocked) return "caution";
  return "info";
}

function buildRiskTrendOption(events) {
  const { from, to } = getRangeWindow();
  const start = from ?? (events[0]?.ts ?? Date.now());
  const end = to ?? (events[events.length - 1]?.ts ?? Date.now());
  const binMs = getTimelineBinMs();
  const bins = Math.max(1, Math.ceil(Math.max(1, end - start) / binMs));

  const labels = [];
  const high = new Array(bins).fill(0);
  const caution = new Array(bins).fill(0);
  const info = new Array(bins).fill(0);
  const binEvents = new Array(bins).fill(0).map(() => []);

  for (const ev of events) {
    if (!ev?.ts) continue;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((ev.ts - start) / binMs)));
    binEvents[idx].push(ev);
    const bucket = riskBucketForEvent(ev);
    if (bucket === "high") high[idx] += 1;
    else if (bucket === "caution") caution[idx] += 1;
    else info[idx] += 1;
  }

  for (let i = 0; i < bins; i++) {
    labels.push(new Date(start + i * binMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }

  return {
    option: {
      tooltip: { trigger: "axis" },
      grid: { left: 40, right: 18, top: 18, bottom: 75 },
      xAxis: { type: "category", data: labels },
      yAxis: { type: "value" },
      dataZoom: [{ type: "inside" }, { type: "slider", height: 18, bottom: 18 }],
      series: [
        buildSeries("High", high, { defaultType: "bar", stackKey: "risk" }),
        buildSeries("Caution", caution, { defaultType: "bar", stackKey: "risk" }),
        buildSeries("Info", info, { defaultType: "bar", stackKey: "risk" }),
      ],
    },
    meta: { start, binMs, binEvents, labels },
  };
}

function buildVendorKindMatrixOption(events) {
  const vendorRows = buildVendorRollup(events)
    .sort((a, b) => getVendorMetricValue(b) - getVendorMetricValue(a))
    .slice(0, Math.max(4, Math.min(vizOptions.topN, 16)));

  const vendors = vendorRows.map((v) => v.vendorName);
  const kinds = ["network.blocked", "network.observed", "cookies.snapshot", "cookies.cleared", "other"];
  const data = [];
  const evidenceByCell = new Map();
  let max = 0;

  for (let y = 0; y < vendors.length; y++) {
    const vendorRow = vendorRows[y];
    for (let x = 0; x < kinds.length; x++) {
      const kind = kinds[x];
      const evs = (vendorRow.evs || []).filter((ev) => {
        if (kind === "other") {
          return !["network.blocked", "network.observed", "cookies.snapshot", "cookies.cleared"].includes(ev?.kind || "");
        }
        return ev?.kind === kind;
      });
      const count = evs.length;
      max = Math.max(max, count);
      data.push([x, y, count]);
      evidenceByCell.set(`${x}:${y}`, evs);
    }
  }

  return {
    option: {
      tooltip: {
        formatter: (params) => {
          const v = Array.isArray(params?.value) ? params.value : [];
          const kind = kinds[Number(v[0] || 0)] || "kind";
          const vendor = vendors[Number(v[1] || 0)] || "vendor";
          return `${vendor}<br/>${kind}: ${Number(v[2] || 0)}`;
        },
      },
      grid: { left: 50, right: 18, top: 20, bottom: 52 },
      xAxis: { type: "category", data: kinds, axisLabel: { rotate: 25 } },
      yAxis: { type: "category", data: vendors },
      visualMap: { min: 0, max: max || 1, calculable: true, orient: "horizontal", left: "center", bottom: 0 },
      series: [{ type: "heatmap", data }],
    },
    meta: { kinds, vendors, evidenceByCell },
  };
}

function buildRuleIdFrequencyOption(events) {
  const counts = new Map();
  const evsByRule = new Map();

  for (const ev of events) {
    const ruleId = ev?.data?.ruleId;
    if (ruleId === null || ruleId === undefined || ruleId === "") continue;
    const label = String(ruleId);
    counts.set(label, (counts.get(label) || 0) + 1);
    if (!evsByRule.has(label)) evsByRule.set(label, []);
    evsByRule.get(label).push(ev);
  }

  const rows = Array.from(counts.entries()).map(([label, value]) => ({
    label,
    value,
    evs: evsByRule.get(label) || [],
  }));

  const built = buildBarLikeOption(rows, {
    seriesName: "rule hits",
    defaultType: "bar",
    maxLabels: Math.max(5, vizOptions.topN),
    axisLabelRotate: 0,
  });
  return {
    option: built.option,
    meta: { evidenceByLabel: built.meta.evidenceByLabel },
  };
}

function hasSeriesData(option) {
  const series = Array.isArray(option?.series) ? option.series : [];
  return series.some((s) => Array.isArray(s?.data) && s.data.length > 0);
}

function getModeEmptyMessage(viewId) {
  if (viewId === "vendorOverview") return "No vendor activity matches current filters";
  if (viewId === "riskTrend") return "No risk trend data matches current filters";
  if (viewId === "topSeen") return "No third-party network events match current filters";
  if (viewId === "apiGating") return "No third-party API-like calls match current filters";
  if (viewId === "vendorKindMatrix") return "No vendor-kind matrix data matches current filters";
  if (viewId === "ruleIdFrequency") return "No rule-id data matches current filters";
  if (viewId === "resourceTypes") return "No resource-type data matches current filters";
  if (viewId === "modeBreakdown") return "No protection-mode data matches current filters";
  if (viewId === "partySplit") return "No party-split data matches current filters";
  if (viewId === "hourHeatmap") return "No heatmap data matches current filters";
  return "No events match current filters";
}

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
    return;
  }

  c.__vptMeta = { viewId: requestedViewId, effectiveViewId, lensPivotActive, built };
  c.setOption(built.option, true);
}

function handleChartClick(viewId, params) {
  const meta = chart?.__vptMeta?.built?.meta;
  if (!meta) return;

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
    });
    return;
  }

  if (viewId === "vendorOverview") {
    const label = params?.name;
    const evs = meta.evidenceByLabel?.get(label) || [];
    const vendor = meta.vendorByLabel?.get(label) || null;
    if (vendor) {
      selectedVendor = vendor;
      renderVendorChips();
      renderECharts();
    } else {
      renderVendorChips();
    }

    setVizSelection({
      type: "vendor",
      value: label || "",
      title: label || "Vendor",
      summaryHtml: `<div class="muted">${evs.length} vendor-scoped events (current filters/range).</div>`,
      events: evs,
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

function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
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
      renderRecentEventsFromEvents(vizSelection.events, "No events match selection.");
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

window.addEventListener("load", () => {
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

  qs("viewModeSelect")?.addEventListener("change", () => {
    setViewMode(qs("viewModeSelect")?.value || "easy", { rerender: true });
  });

  qs("clearVendorBtn")?.addEventListener("click", () => {
    selectedVendor = null;
    selectedInsightTarget = null;
    clearVizSelection({ close: true, clearBrush: true, renderTable: false });
    renderVendorChips();
    renderECharts();
    renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
    updateFilterSummary();
  });

  qs("vizInfoBtn")?.addEventListener("click", () => {
    explainCurrentScope({ forceScroll: true });
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
});
