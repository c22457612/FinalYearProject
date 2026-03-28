import { summarizeVisualCategoryCounts } from "../filter-state.js";
import { getEventListContextText, getEventListKindText, getEventListMetaText } from "../utils.js";

function buildEvidenceMix(counts) {
  const parts = [];
  if (Number(counts.blocked || 0) > 0) parts.push(`${counts.blocked} blocked`);
  if (Number(counts.observed || 0) > 0) parts.push(`${counts.observed} observed`);
  if (Number(counts.api || 0) > 0) parts.push(`${counts.api} API`);
  if (Number(counts.other || 0) > 0) parts.push(`${counts.other} other`);
  return parts.length ? parts.join(", ") : "No classified evidence yet.";
}

function buildFallbackInsight(selection, evidence, siteName = "", selectedVendor = null) {
  const counts = summarizeVisualCategoryCounts(evidence);
  const total = Number(counts.total || 0);
  return {
    summary: `${total} events in ${selection?.title || "current scope"} (${buildEvidenceMix(counts)}).`,
    severity: total >= 40 ? "caution" : "info",
    confidence: total >= 10 ? 0.72 : 0.45,
    evidenceSummary: {
      ...counts,
      total,
    },
    _fallbackSiteName: siteName,
    _fallbackVendorName: String(selectedVendor?.vendorName || "").trim(),
  };
}

function formatDigestSupportLine({ selection, currentView, selectedVendor }) {
  const selectionTitle = String(selection?.title || "").trim();
  if (selection?.events?.length && selectionTitle) {
    return `Locked selection: ${selectionTitle}.`;
  }
  const vendorName = String(selectedVendor?.vendorName || "").trim();
  if (vendorName) return `Current vendor scope: ${vendorName}.`;
  const viewTitle = String(currentView?.title || "Current scope").trim();
  return `${viewTitle} digest.`;
}

function getSeverityDisplay(severity) {
  if (severity === "high") return { label: "High", className: "severity-high" };
  if (severity === "caution") return { label: "Caution", className: "severity-caution" };
  return { label: "Info", className: "severity-info" };
}

function buildEvidenceStats(evidence) {
  const list = Array.isArray(evidence) ? evidence : [];
  const counts = summarizeVisualCategoryCounts(list);
  let firstTs = null;
  let lastTs = null;

  for (const ev of list) {
    const ts = Number(ev?.ts);
    if (!Number.isFinite(ts)) continue;
    if (firstTs === null || ts < firstTs) firstTs = ts;
    if (lastTs === null || ts > lastTs) lastTs = ts;
  }

  return { ...counts, firstTs, lastTs };
}

export function buildSidebarEvidenceDigestModel({
  selection = null,
  evidence = [],
  currentView = null,
  viewMode = "easy",
  siteName = "",
  selectedVendor = null,
  pickPrimarySelectedEvent = () => null,
  getInsightRules = () => null,
} = {}) {
  const evs = Array.isArray(evidence) ? evidence.filter(Boolean) : [];
  const primaryEvent = pickPrimarySelectedEvent(evs);
  const insightApi = typeof getInsightRules === "function" ? getInsightRules() : null;
  const context = {
    events: evs,
    viewId: String(currentView?.id || "unknown"),
    viewMode: String(viewMode || "easy"),
    siteName: String(siteName || ""),
    selectedVendor,
    selectedDomain: selection?.type === "domain" ? selection.value : "",
  };
  const insight = insightApi?.buildInsightResult
    ? insightApi.buildInsightResult(context)
    : buildFallbackInsight(selection, evs, siteName, selectedVendor);
  const stats = buildEvidenceStats(evs);

  return {
    insight,
    stats,
    primaryEvent,
    supportLine: formatDigestSupportLine({ selection, currentView, selectedVendor }),
    mixText: buildEvidenceMix(stats),
    hasLockedSelection: !!selection?.events?.length,
  };
}

export function createSidebarModules(deps) {
  const {
    qs,
    friendlyTime,
    pickPrimarySelectedEvent,
    getRangeKey,
    getViewMode,
    getCurrentView,
    getSiteName,
    getInsightRules,
    getFilterState,
    getSelectedVendor,
    getVizSelection,
    getChartEvents,
    getActiveVizOptionLabels,
    partyLabels,
    resourceLabels,
    surfaceLabels,
    privacyStatusLabels,
    mitigationStatusLabels,
    onResetFilters,
  } = deps;

  function addSidebarMutedText(container, text) {
    if (!container) return;
    const p = document.createElement("div");
    p.className = "muted";
    p.textContent = text;
    container.appendChild(p);
  }

  function pulsePanel(panelId) {
    const panel = qs(panelId);
    if (!panel) return;
    panel.classList.remove("attention-pulse");
    void panel.offsetWidth;
    panel.classList.add("attention-pulse");
  }

  function appendCompactStatRow(container, items) {
    if (!container) return;
    const clean = Array.isArray(items) ? items.filter((item) => item && item.label && item.value) : [];
    if (!clean.length) return;

    const row = document.createElement("div");
    row.className = "sidebar-stat-row";
    for (const item of clean) {
      const chip = document.createElement("div");
      chip.className = "sidebar-stat-chip";

      const label = document.createElement("div");
      label.className = "sidebar-stat-label";
      label.textContent = item.label;

      const value = document.createElement("div");
      value.className = "sidebar-stat-value";
      value.textContent = item.value;

      chip.appendChild(label);
      chip.appendChild(value);
      row.appendChild(chip);
    }
    container.appendChild(row);
  }

  function renderRecentEvidenceDetails(container, evidence) {
    const previewEvents = Array.isArray(evidence) ? evidence.slice(-2).reverse() : [];
    if (!container || !previewEvents.length) return;

    const details = document.createElement("details");
    details.className = "sidebar-evidence-preview";

    const summary = document.createElement("summary");
    summary.textContent = `Recent evidence (${previewEvents.length})`;
    details.appendChild(summary);

    const list = document.createElement("div");
    list.className = "sidebar-event-list";

    for (const ev of previewEvents) {
      const item = document.createElement("div");
      item.className = "sidebar-event-item";

      const meta = document.createElement("div");
      meta.className = "sidebar-event-meta";
      meta.textContent = getEventListMetaText(ev);

      const main = document.createElement("div");
      main.className = "sidebar-event-main";
      main.textContent = `${getEventListKindText(ev)}: ${getEventListContextText(ev)}`;

      item.appendChild(meta);
      item.appendChild(main);
      list.appendChild(item);
    }

    details.appendChild(list);
    container.appendChild(details);
  }

  function renderSidebarSelectedEvidence() {
    const metaEl = qs("sidebarSelectedEvidenceMeta");
    const body = qs("sidebarSelectedEvidenceBody");
    if (!metaEl || !body) return;
    body.innerHTML = "";

    const selection = getVizSelection()?.events?.length ? getVizSelection() : null;
    const evidence = selection ? selection.events : getChartEvents();
    const digest = buildSidebarEvidenceDigestModel({
      selection,
      evidence,
      currentView: typeof getCurrentView === "function" ? getCurrentView() : null,
      viewMode: getViewMode(),
      siteName: typeof getSiteName === "function" ? getSiteName() : "",
      selectedVendor: typeof getSelectedVendor === "function" ? getSelectedVendor() : null,
      pickPrimarySelectedEvent,
      getInsightRules,
    });

    metaEl.textContent = digest.hasLockedSelection ? "Selected digest" : "Current scope digest";

    if (!evidence.length) {
      addSidebarMutedText(body, "No evidence in the current scope.");
      return;
    }

    const severity = getSeverityDisplay(digest.insight?.severity);
    const severityBadge = document.createElement("div");
    severityBadge.className = `insight-severity sidebar-evidence-severity ${severity.className}`;
    severityBadge.textContent = severity.label;
    body.appendChild(severityBadge);

    const summary = document.createElement("div");
    summary.className = "sidebar-evidence-summary";
    summary.textContent = digest.insight?.summary || "No deterministic summary available for this scope.";
    body.appendChild(summary);

    const support = document.createElement("div");
    support.className = "sidebar-evidence-support";
    support.textContent = digest.supportLine;
    body.appendChild(support);

    appendCompactStatRow(body, [
      { label: "Mix", value: digest.mixText },
      { label: "Latest", value: digest.stats.lastTs ? friendlyTime(digest.stats.lastTs) : "-" },
    ]);

    renderRecentEvidenceDetails(body, evidence);
  }

  function renderSidebarFiltersModule() {
    const metaEl = qs("sidebarFiltersMeta");
    const summaryEl = qs("sidebarFiltersSummary");
    const listEl = qs("sidebarFiltersList");
    if (!metaEl || !summaryEl || !listEl) return;

    const filterState = getFilterState();
    const viewMode = getViewMode();
    const rangeLabel = qs("rangeSelect")?.selectedOptions?.[0]?.textContent || getRangeKey();
    metaEl.textContent = `${viewMode === "power" ? "Power" : "Easy"} view - ${rangeLabel}`;

    const summaryText = qs("filterSummary")?.textContent || "";
    summaryEl.textContent = summaryText || "Default view state.";

    listEl.innerHTML = "";
    const labels = [];
    labels.push(filterState.kind.blocked ? null : "Blocked hidden");
    labels.push(filterState.kind.observed ? null : "Observed hidden");
    labels.push(filterState.kind.other ? null : "Other hidden");
    if (filterState.party !== "all") labels.push(`Party: ${partyLabels[filterState.party] || filterState.party}`);
    if (filterState.resource !== "all") labels.push(`Resource: ${resourceLabels[filterState.resource] || filterState.resource}`);
    if (filterState.surface !== "all") labels.push(`Surface: ${surfaceLabels[filterState.surface] || filterState.surface}`);
    if (filterState.privacyStatus !== "all") {
      labels.push(`Privacy: ${privacyStatusLabels[filterState.privacyStatus] || filterState.privacyStatus}`);
    }
    if (filterState.mitigationStatus !== "all") {
      labels.push(`Mitigation: ${mitigationStatusLabels[filterState.mitigationStatus] || filterState.mitigationStatus}`);
    }

    const text = String(filterState.domainText || "").trim();
    if (text) labels.push(`Text: ${text}`);

    for (const item of getActiveVizOptionLabels()) {
      labels.push(`Chart: ${item}`);
    }

    const clean = labels.filter(Boolean).slice(0, 5);
    if (!clean.length) {
      const li = document.createElement("li");
      li.className = "muted";
      li.textContent = "Default chart and filter settings.";
      listEl.appendChild(li);
      return;
    }

    for (const item of clean) {
      const li = document.createElement("li");
      li.textContent = item;
      listEl.appendChild(li);
    }
  }

  function renderSidebarModules() {
    renderSidebarFiltersModule();
    renderSidebarSelectedEvidence();
  }

  function initControls() {
    qs("sidebarResetFiltersBtn")?.addEventListener("click", () => {
      if (typeof onResetFilters === "function") onResetFilters();
    });
  }

  function selectModule(moduleId) {
    if (moduleId === "filters") {
      pulsePanel("sidebarModuleFilters");
      return;
    }
    pulsePanel("sidebarModuleSelectedEvidence");
  }

  return {
    initControls,
    renderSidebarModules,
    selectModule,
  };
}
