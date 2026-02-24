export function createSelectionController(deps) {
  const {
    pickPrimarySelectedEvent,
    getEventKey,
    getVizSelection,
    setVizSelectionState,
    setSelectedInsightTarget,
    setSelectedRecentEventKey,
    clearActiveEvidence,
    clearChartSelectionHighlight,
    setSelectedChartPoint,
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
    getViews,
    getVizIndex,
    resetInsightSection,
    ensureInsightVisible,
  } = deps;

  function clearVizSelection({
    close = true,
    clearBrush = true,
    renderTable = true,
    updateSummary = true,
  } = {}) {
    setVizSelectionState(null);
    setSelectedInsightTarget(null);
    clearActiveEvidence();
    setSelectedRecentEventKey("");
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
    updateDrawerButtonState();
    if (updateSummary) updateFilterSummary();
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

    const nextSelection = {
      type,
      value,
      fromTs,
      toTs,
      title,
      summaryHtml,
      events: evidence,
    };
    setVizSelectionState(nextSelection);

    const primaryEvent = pickPrimarySelectedEvent(evidence);
    const selectedRecentEventKey = getEventKey(primaryEvent);
    setSelectedRecentEventKey(selectedRecentEventKey);
    renderRecentEventsFromEvents(evidence, "No events match selection.", { selectedEventKey: selectedRecentEventKey });

    if (chartPoint) {
      setSelectedChartPoint(chartPoint);
      applyChartSelectionHighlight();
    } else {
      clearChartSelectionHighlight();
    }
    syncInteractionOverlayOnCurrentChart();

    setSelectedInsightTarget({ type, value });
    const scrollSource = type === "vendor" ? "vendor" : "selection";
    openInsightSheet(nextSelection, evidence, {
      forceScroll: scrollMode === "force",
      allowAutoScroll: scrollMode !== "never",
      scrollSource,
    });
    updateDrawerButtonState();
    updateFilterSummary();
  }

  function explainCurrentScope({ forceScroll = true } = {}) {
    const existing = getVizSelection()?.events?.length ? getVizSelection() : null;
    const evidence = existing ? existing.events : getChartEvents();
    const scopeTitle = existing?.title || `${getViews()[getVizIndex()]?.title || "Current view"} scope`;
    const scopeSelection = existing || {
      type: "scope",
      value: getViews()[getVizIndex()]?.id || "scope",
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
    const selection = getVizSelection();
    if (!selection?.events?.length) return false;

    const ids = selection.events.map((eventItem) => eventItem?.id).filter(Boolean);
    if (!ids.length) return false;

    const scoped = getChartEvents();
    const byId = new Map(scoped.filter((eventItem) => eventItem?.id).map((eventItem) => [eventItem.id, eventItem]));
    const refreshed = [];

    for (const id of ids) {
      const eventItem = byId.get(id);
      if (!eventItem) return false;
      refreshed.push(eventItem);
    }

    selection.events = refreshed;
    setSelectedRecentEventKey(getEventKey(pickPrimarySelectedEvent(refreshed)));
    return true;
  }

  return {
    clearVizSelection,
    setVizSelection,
    explainCurrentScope,
    selectionStillValid,
  };
}
