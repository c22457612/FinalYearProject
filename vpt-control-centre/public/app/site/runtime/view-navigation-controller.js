export function createViewNavigationController(deps) {
  const {
    qs,
    getDocumentBody,
    views,
    easySiteWideViewIds,
    easyVendorFocusViewIds,
    privacyFilterAllOnlyViewIds,
    getViewMode,
    getSelectedVendor,
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

  const REMOVED_FROM_USER_PATH_VIEW_IDS = new Set([
    "vendorBlockRateComparison",
    "riskTrend",
    "vendorKindMatrix",
    "modeBreakdown",
    "partySplit",
  ]);
  const POWER_SITE_WIDE_VIEW_IDS = new Set([
    "vendorOverview",
    "vendorShareOverTime",
    "vendorAllowedBlockedTimeline",
    "baselineDetectedBlockedTrend",
    "timeline",
    "topSeen",
    "kinds",
    "apiGating",
    "ruleIdFrequency",
    "resourceTypes",
    "hourHeatmap",
  ]);
  const POWER_VENDOR_FOCUS_VIEW_IDS = new Set([
    "vendorOverview",
    "vendorAllowedBlockedTimeline",
    "vendorTopDomainsEndpoints",
    "baselineDetectedBlockedTrend",
    "timeline",
    "kinds",
    "apiGating",
    "ruleIdFrequency",
    "resourceTypes",
    "hourHeatmap",
  ]);
  const GUIDED_FILL_COUNTS = new Set([3, 4]);
  const GUIDED_FILL_MIN_TAB_WIDTH = 184;

  function hasVendorFocus() {
    return !!getSelectedVendor?.()?.vendorId;
  }

  function getEasyViewIds() {
    return hasVendorFocus() ? easyVendorFocusViewIds : easySiteWideViewIds;
  }

  function getPowerViewIds() {
    return hasVendorFocus() ? POWER_VENDOR_FOCUS_VIEW_IDS : POWER_SITE_WIDE_VIEW_IDS;
  }

  function isViewAllowed(viewId, mode = getViewMode()) {
    if (REMOVED_FROM_USER_PATH_VIEW_IDS.has(viewId)) return false;
    if (mode === "easy") return getEasyViewIds().has(viewId);
    return getPowerViewIds().has(viewId);
  }

  function getAllowedViews(mode = getViewMode()) {
    return views.filter((view) => isViewAllowed(view.id, mode));
  }

  function getCurrentViewId() {
    return views[getVizIndex()]?.id || views[0]?.id || "";
  }

  function applyVizPathLayoutState(root, allowed) {
    const block = root?.closest?.(".viz-path-selector-block");
    if (!block) return;

    const count = Array.isArray(allowed) ? allowed.length : 0;
    const guidedFillCandidate = getViewMode() === "easy" && GUIDED_FILL_COUNTS.has(count);
    const availableWidth = Math.max(0, Number(root?.clientWidth || block?.clientWidth || 0));
    const estimatedTabWidth = guidedFillCandidate
      ? Math.max(0, (availableWidth - Math.max(0, count - 1)) / Math.max(1, count))
      : 0;
    const guidedFillActive = guidedFillCandidate && estimatedTabWidth >= GUIDED_FILL_MIN_TAB_WIDTH;

    block.dataset.pathLayout = guidedFillActive ? "guided-fill" : "compact";
    block.dataset.guidedCount = guidedFillActive ? String(count) : "";
  }

  function renderVizPathSelector(options = {}) {
    const root = qs("vizPathSelector");
    if (!root) return;

    const allowed = getAllowedViews(getViewMode());
    const currentId = getCurrentViewId();
    const requestedFocusId = String(options.focusViewId || "");
    let preservedFocusId = "";

    if (options.preserveFocus === true && typeof root.contains === "function") {
      const activeElement = root.ownerDocument?.activeElement;
      if (activeElement && typeof activeElement.getAttribute === "function" && root.contains(activeElement)) {
        preservedFocusId = String(activeElement.getAttribute("data-viz-view-id") || "");
      }
    }

    root.innerHTML = allowed.map((view) => {
      const active = view.id === currentId;
      return `
        <button
          class="console-selector-option viz-path-selector-option${active ? " active" : ""}"
          type="button"
          data-viz-view-id="${view.id}"
          data-active="${active ? "true" : "false"}"
          aria-pressed="${active ? "true" : "false"}"
          title="${view.title}"
        >
          <span class="console-selector-marker" aria-hidden="true">&gt;</span>
          <span class="console-selector-label">${view.title}</span>
        </button>
      `;
    }).join("");
    applyVizPathLayoutState(root, allowed);

    if (typeof root.querySelectorAll !== "function") return;

    const buttons = Array.from(root.querySelectorAll("[data-viz-view-id]"));
    buttons.forEach((button) => {
      const active = button.getAttribute("data-viz-view-id") === currentId;
      button.tabIndex = active ? 0 : -1;
    });

    const focusId = requestedFocusId || preservedFocusId;
    if (!focusId) return;

    const target = buttons.find((button) => button.getAttribute("data-viz-view-id") === focusId)
      || buttons.find((button) => button.getAttribute("data-viz-view-id") === currentId);
    if (target && typeof target.focus === "function") {
      target.focus({ preventScroll: true });
    }
  }

  function applyViewFilterPolicy() {
    const filterState = getFilterState();
    let changed = false;

    if (filterState.privacyStatus !== "all") {
      filterState.privacyStatus = "all";
      changed = true;
    }

    writeFilterStateToControls();

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
      el.textContent = hasVendorFocus()
        ? "Power mode keeps the focused technical path for the current vendor scope."
        : "Power mode keeps the richer technical path for site-wide inspection.";
      return;
    }

    el.textContent = hasVendorFocus()
      ? "Easy mode is guided for vendor investigation. Comparison-only charts are removed from the path."
      : "Easy mode is guided. Power mode keeps the broader comparison and technical views.";
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

  function syncVizSelectByMode(options = {}) {
    const select = qs("vizSelect");
    if (!select) {
      updateVizPositionLabel();
      updateViewAvailabilityHint();
      renderVizPathSelector(options);
      return;
    }

    for (const opt of select.options) {
      const baseLabel = String(opt.dataset.baseLabel || opt.textContent || "");
      if (!opt.dataset.baseLabel) opt.dataset.baseLabel = baseLabel;
      const allowed = isViewAllowed(opt.value, getViewMode());
      opt.hidden = !allowed;
      opt.disabled = !allowed;
      opt.textContent = baseLabel;
      opt.title = "";
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
    renderVizPathSelector(options);
  }

  function syncAdvancedControlsByMode() {
    const panel = qs("advancedControlsPanel");
    if (!panel) return;
    panel.open = false;
  }

  function setViewMode(mode, { rerender = true, focusViewId = "" } = {}) {
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
    syncVizSelectByMode({ focusViewId, preserveFocus: !!focusViewId });
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

  function switchViz(newIndex, options = {}) {
    const allowed = getAllowedViews(getViewMode());
    if (!allowed.length) return;
    const currentId = views[getVizIndex()]?.id;
    const currentAllowedIdx = Math.max(0, allowed.findIndex((view) => view.id === currentId));
    const nextAllowedIdx = (newIndex + allowed.length) % allowed.length;
    const chosen = allowed[(nextAllowedIdx + allowed.length) % allowed.length] || allowed[currentAllowedIdx];
    const absoluteIdx = views.findIndex((view) => view.id === chosen.id);
    setVizIndex(absoluteIdx >= 0 ? absoluteIdx : 0);
    if (qs("vizSelect")) qs("vizSelect").value = views[getVizIndex()].id;
    syncVizSelectByMode({ focusViewId: options.focusViewId || "", preserveFocus: options.preserveFocus === true });
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

  function switchVizById(viewId, options = {}) {
    const nextViewId = String(viewId || "");
    if (!nextViewId) return;
    const allowed = getAllowedViews(getViewMode());
    const nextAllowedIdx = allowed.findIndex((view) => view.id === nextViewId);
    if (nextAllowedIdx < 0) return;
    switchViz(nextAllowedIdx, options);
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
    switchVizById,
  };
}
