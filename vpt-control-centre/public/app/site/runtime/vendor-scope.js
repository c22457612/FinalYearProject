export function createVendorScope(deps) {
  const {
    qs,
    getVendorTaxonomy,
    getFilteredEvents,
    getSelectedVendor,
    setSelectedVendor,
    getViewMode,
    getVizMetric,
    setSelectedInsightTarget,
    hideVendorSelectionCue,
    clearVizSelection,
    renderECharts,
    renderRecentEventsFromEvents,
    updateFilterSummary,
    focusVendorDetailsUx,
  } = deps;
  const classifiedEventCache = new WeakMap();
  let chartEventsCacheBase = null;
  let chartEventsCacheVendorId = "";
  let chartEventsCacheResult = [];
  let vendorRollupCacheEvents = null;
  let vendorRollupCacheTaxonomy = null;
  let vendorRollupCacheRows = null;
  let sortedVendorRowsCacheBaseRows = null;
  let sortedVendorRowsCacheMetric = "";
  let sortedVendorRowsCacheRows = [];

  function classifyVendorForEvent(ev) {
    if (ev && typeof ev === "object" && classifiedEventCache.has(ev)) {
      return classifiedEventCache.get(ev);
    }

    const taxonomy = getVendorTaxonomy();
    if (taxonomy?.classifyEvent) {
      const classified = taxonomy.classifyEvent(ev);
      if (ev && typeof ev === "object") classifiedEventCache.set(ev, classified);
      return classified;
    }

    const fallback = String(ev?.data?.domain || ev?.site || "unknown");
    const classified = {
      vendorId: fallback,
      vendorName: fallback,
      category: "unmapped",
      domains: fallback ? [fallback] : [],
      riskHints: ["vendor mapping unavailable"],
      domain: fallback,
      known: false,
    };
    if (ev && typeof ev === "object") classifiedEventCache.set(ev, classified);
    return classified;
  }

  function eventMatchesSelectedVendor(ev) {
    const selectedVendor = getSelectedVendor();
    if (!selectedVendor?.vendorId) return true;
    const classified = classifyVendorForEvent(ev);
    return classified.vendorId === selectedVendor.vendorId;
  }

  function getChartEvents() {
    const base = Array.isArray(getFilteredEvents()) ? getFilteredEvents() : [];
    const selectedVendor = getSelectedVendor();
    const selectedVendorId = String(selectedVendor?.vendorId || "");
    if (base === chartEventsCacheBase && selectedVendorId === chartEventsCacheVendorId) {
      return chartEventsCacheResult;
    }

    const next = base.filter((ev) => eventMatchesSelectedVendor(ev));
    chartEventsCacheBase = base;
    chartEventsCacheVendorId = selectedVendorId;
    chartEventsCacheResult = next;
    return next;
  }

  function getVendorMetricValue(row) {
    if (!row) return 0;
    const metric = getVizMetric();
    if (metric === "blocked") return row.blocked || 0;
    if (metric === "observed") return row.observed || 0;
    return row.seen || 0;
  }

  function buildVendorRollup(events) {
    const list = Array.isArray(events) ? events : [];
    const taxonomy = getVendorTaxonomy();
    if (list === vendorRollupCacheEvents && taxonomy === vendorRollupCacheTaxonomy && vendorRollupCacheRows) {
      return vendorRollupCacheRows;
    }
    if (taxonomy?.rollupVendors) return taxonomy.rollupVendors(events);

    const map = new Map();
    for (const ev of list) {
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
    const rows = Array.from(map.values());
    vendorRollupCacheEvents = list;
    vendorRollupCacheTaxonomy = taxonomy;
    vendorRollupCacheRows = rows;
    return rows;
  }

  function renderVendorChips() {
    const box = qs("vendorChips");
    if (!box) return;
    box.innerHTML = "";

    const baseRows = buildVendorRollup(getFilteredEvents());
    const metric = String(getVizMetric() || "");
    let allRows = [];
    if (baseRows === sortedVendorRowsCacheBaseRows && metric === sortedVendorRowsCacheMetric) {
      allRows = sortedVendorRowsCacheRows;
    } else {
      allRows = baseRows
        .slice()
        .sort((a, b) => getVendorMetricValue(b) - getVendorMetricValue(a));
      sortedVendorRowsCacheBaseRows = baseRows;
      sortedVendorRowsCacheMetric = metric;
      sortedVendorRowsCacheRows = allRows;
    }

    const selectedVendor = getSelectedVendor();
    if (selectedVendor?.vendorId && !allRows.some((r) => r.vendorId === selectedVendor.vendorId)) {
      setSelectedVendor(null);
      hideVendorSelectionCue();
    }

    const rows = allRows
      .slice(0, getViewMode() === "easy" ? 8 : 14);

    const allBtn = document.createElement("button");
    allBtn.type = "button";
    allBtn.className = `vendor-chip ${!getSelectedVendor() ? "active" : ""}`.trim();
    allBtn.textContent = "All vendors";
    allBtn.addEventListener("click", () => {
      setSelectedVendor(null);
      setSelectedInsightTarget(null);
      hideVendorSelectionCue();
      clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
      renderVendorChips();
      renderECharts();
      renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
      updateFilterSummary();
    });
    box.appendChild(allBtn);

    for (const row of rows) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `vendor-chip ${getSelectedVendor()?.vendorId === row.vendorId ? "active" : ""}`.trim();
      const metricValue = getVendorMetricValue(row);
      btn.textContent = `${row.vendorName} (${metricValue})`;
      btn.addEventListener("click", () => {
        setSelectedVendor({
          vendorId: row.vendorId,
          vendorName: row.vendorName,
          category: row.category,
          domains: row.domains || [],
          riskHints: row.riskHints || [],
        });
        setSelectedInsightTarget({ type: "vendor", value: row.vendorName });
        clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
        renderVendorChips();
        renderECharts();
        focusVendorDetailsUx(row.vendorName, row.seen || 0);
        renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
        updateFilterSummary();
      });
      box.appendChild(btn);
    }
  }

  return {
    classifyVendorForEvent,
    eventMatchesSelectedVendor,
    getChartEvents,
    getVendorMetricValue,
    buildVendorRollup,
    renderVendorChips,
  };
}
