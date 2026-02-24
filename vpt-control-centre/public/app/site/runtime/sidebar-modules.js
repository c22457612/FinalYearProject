export function createSidebarModules(deps) {
  const {
    qs,
    friendlyTime,
    pickPrimarySelectedEvent,
    formatSelectedLead,
    getRangeKey,
    getViewMode,
    getFilterState,
    getSelectedVendor,
    getFilteredEvents,
    getVizSelection,
    getChartEvents,
    getActiveVizOptionLabels,
    getVendorMetricValue,
    buildVendorRollup,
    partyLabels,
    resourceLabels,
    surfaceLabels,
    privacyStatusLabels,
    mitigationStatusLabels,
    onResetFilters,
  } = deps;

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

    const selection = getVizSelection()?.events?.length ? getVizSelection() : null;
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

    const filterState = getFilterState();
    const viewMode = getViewMode();
    const rangeLabel = qs("rangeSelect")?.selectedOptions?.[0]?.textContent || getRangeKey();
    metaEl.textContent = `Mode ${viewMode.toUpperCase()} | Range ${rangeLabel}`;

    const summaryText = qs("filterSummary")?.textContent || "";
    summaryEl.textContent = summaryText || "No filters applied.";

    listEl.innerHTML = "";
    const labels = [];
    labels.push(filterState.kind.blocked ? null : "Blocked kind hidden");
    labels.push(filterState.kind.observed ? null : "Observed kind hidden");
    labels.push(filterState.kind.other ? null : "Other kinds hidden");
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

    const selectedVendor = getSelectedVendor();
    const rows = buildVendorRollup(getFilteredEvents())
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

  function initControls() {
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
      if (typeof onResetFilters === "function") onResetFilters();
    });
  }

  return {
    initControls,
    renderSidebarModules,
    selectModule: selectSidebarModule,
  };
}
