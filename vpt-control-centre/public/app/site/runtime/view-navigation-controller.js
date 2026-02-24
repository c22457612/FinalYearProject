export function createViewNavigationController(deps) {
  const {
    qs,
    getDocumentBody,
    views,
    easyViewIds,
    powerOnlyViewLabelSuffix,
    privacyFilterAllOnlyViewIds,
    getViewMode,
    setViewModeState,
    getVizIndex,
    setVizIndex,
    getVizSelection,
    getFilterState,
    closeDrawer,
    writeFilterStateToControls,
    deriveFilteredEvents,
    renderVendorChips,
    clearVizSelection,
    renderECharts,
    renderRecentEventsFromEvents,
    getChartEvents,
    updateFilterSummary,
  } = deps;

  function isViewAllowed(viewId, mode = getViewMode()) {
    if (mode === "easy") return easyViewIds.has(viewId);
    return true;
  }

  function getAllowedViews(mode = getViewMode()) {
    return views.filter((view) => isViewAllowed(view.id, mode));
  }

  function getCurrentViewId() {
    return views[getVizIndex()]?.id || views[0]?.id || "";
  }

  function applyViewFilterPolicy() {
    const viewId = getCurrentViewId();
    const privacyAllOnly = privacyFilterAllOnlyViewIds.has(viewId);
    const filterState = getFilterState();
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

    const allowed = getAllowedViews(getViewMode());
    if (!allowed.length) {
      el.textContent = "- / 0";
      return;
    }

    const currentId = views[getVizIndex()]?.id;
    let idx = allowed.findIndex((view) => view.id === currentId);
    if (idx < 0) idx = 0;
    el.textContent = `${idx + 1} / ${allowed.length}`;
  }

  function updateViewAvailabilityHint() {
    const el = qs("vizModeHelp");
    if (!el) return;

    if (getViewMode() !== "easy") {
      el.textContent = "Power mode: all chart views are available.";
      return;
    }

    const powerOnlyCount = views.filter((view) => !easyViewIds.has(view.id)).length;
    if (!powerOnlyCount) {
      el.textContent = "";
      return;
    }

    el.textContent = `Easy mode is guided. ${powerOnlyCount} additional views are listed as "${powerOnlyViewLabelSuffix.trim()}" and unlock in Power mode.`;
  }

  function updateDrawerButtonState() {
    const btn = qs("vizOpenDrawerBtn");
    if (!btn) return;

    const hasSelection = !!getVizSelection()?.events?.length;
    const viewMode = getViewMode();
    const canOpen = hasSelection && viewMode === "power";
    btn.disabled = !canOpen;
    btn.textContent = viewMode === "power" ? "Technical details" : "Technical details (Power only)";
    btn.title = canOpen
      ? "Open the technical evidence drawer for the current selection."
      : viewMode === "easy"
        ? "Switch to Power mode and select evidence to open technical details."
        : "Select a chart datapoint to open technical details.";
  }

  function syncVizSelectByMode() {
    const select = qs("vizSelect");
    if (!select) {
      updateVizPositionLabel();
      updateViewAvailabilityHint();
      return;
    }

    for (const opt of select.options) {
      const baseLabel = String(opt.dataset.baseLabel || opt.textContent || "")
        .replace(powerOnlyViewLabelSuffix, "");
      if (!opt.dataset.baseLabel) opt.dataset.baseLabel = baseLabel;
      const allowed = isViewAllowed(opt.value, getViewMode());
      opt.hidden = false;
      opt.disabled = !allowed;
      opt.textContent = allowed ? baseLabel : `${baseLabel}${powerOnlyViewLabelSuffix}`;
      opt.title = allowed ? "" : "Switch View controls to Power to use this chart mode.";
    }

    const currentId = views[getVizIndex()]?.id;
    if (!isViewAllowed(currentId, getViewMode())) {
      const allowed = getAllowedViews(getViewMode());
      const fallback = allowed[0]?.id || views[0].id;
      const idx = views.findIndex((view) => view.id === fallback);
      setVizIndex(idx >= 0 ? idx : 0);
      select.value = views[getVizIndex()].id;
    } else {
      select.value = currentId;
    }

    updateVizPositionLabel();
    updateViewAvailabilityHint();
  }

  function syncAdvancedControlsByMode() {
    const panel = qs("advancedControlsPanel");
    if (!panel) return;
    if (getViewMode() === "easy") {
      panel.open = false;
    }
  }

  function setViewMode(mode, { rerender = true } = {}) {
    setViewModeState(mode === "power" ? "power" : "easy");
    const viewMode = getViewMode();
    const body = typeof getDocumentBody === "function" ? getDocumentBody() : null;

    body?.classList?.toggle("mode-easy", viewMode === "easy");
    body?.classList?.toggle("mode-power", viewMode === "power");
    if (qs("viewModeSelect")) qs("viewModeSelect").value = viewMode;

    if (viewMode === "easy") {
      closeDrawer();
    }

    syncAdvancedControlsByMode();
    syncVizSelectByMode();
    updateDrawerButtonState();
    const policyChanged = applyViewFilterPolicy();
    if (policyChanged) {
      deriveFilteredEvents();
    }
    renderVendorChips();

    if (rerender) {
      clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
      renderECharts();
      renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
      updateFilterSummary();
    }
  }

  function switchViz(newIndex) {
    const allowed = getAllowedViews(getViewMode());
    if (!allowed.length) return;
    const currentId = views[getVizIndex()]?.id;
    const currentAllowedIdx = Math.max(0, allowed.findIndex((view) => view.id === currentId));
    const nextAllowedIdx = (newIndex + allowed.length) % allowed.length;
    const chosen = allowed[(nextAllowedIdx + allowed.length) % allowed.length] || allowed[currentAllowedIdx];
    const absoluteIdx = views.findIndex((view) => view.id === chosen.id);
    setVizIndex(absoluteIdx >= 0 ? absoluteIdx : 0);
    if (qs("vizSelect")) qs("vizSelect").value = views[getVizIndex()].id;
    updateVizPositionLabel();
    const policyChanged = applyViewFilterPolicy();
    if (policyChanged) {
      deriveFilteredEvents();
      renderVendorChips();
    }

    clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
    renderECharts();
    renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
    updateFilterSummary();
  }

  return {
    isViewAllowed,
    getAllowedViews,
    getCurrentViewId,
    applyViewFilterPolicy,
    updateVizPositionLabel,
    updateViewAvailabilityHint,
    updateDrawerButtonState,
    syncVizSelectByMode,
    setViewMode,
    switchViz,
  };
}
