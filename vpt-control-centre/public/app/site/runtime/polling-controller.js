export function createPollingController(deps) {
  const {
    getSiteName,
    getRangeWindow,
    getWindowEvents,
    setWindowEvents,
    getLastWindowFetchKey,
    setLastWindowFetchKey,
    getLastWindowFetchAt,
    setLastWindowFetchAt,
    getIsFetchSiteInFlight,
    setIsFetchSiteInFlight,
    getLatestSiteData,
    setLatestSiteData,
    setStatus,
    renderHeader,
    renderStats,
    renderTopThirdParties,
    deriveFilteredEvents,
    renderVendorChips,
    getVizSelection,
    selectionStillValid,
    clearVizSelection,
    renderECharts,
    renderRecentEventsFromEvents,
    getSelectedRecentEventKey,
    getChartEvents,
    updateFilterSummary,
    renderRecentEvents,
  } = deps;

  async function fetchWindowEvents(force = false) {
    const { key, from, to } = getRangeWindow();
    const fetchKey = `${key}:${from ?? "null"}:${to ?? "null"}`;

    const now = Date.now();
    const stale = (now - getLastWindowFetchAt()) > 5000;

    if (!force && fetchKey === getLastWindowFetchKey() && getWindowEvents().length && !stale) return;

    setLastWindowFetchKey(fetchKey);
    setLastWindowFetchAt(now);

    const q = new URLSearchParams();
    q.set("site", getSiteName());
    if (from) q.set("from", String(from));
    if (to) q.set("to", String(to));
    q.set("limit", "20000");

    const res = await fetch(`/api/events?${q.toString()}`);
    if (!res.ok) throw new Error(`events window HTTP ${res.status}`);

    setWindowEvents(await res.json());
  }

  async function applyRangeChanges() {
    clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
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
    if (getIsFetchSiteInFlight()) return;
    setIsFetchSiteInFlight(true);

    try {
      const url = `/api/sites/${encodeURIComponent(getSiteName())}?top=20&recent=100`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();
      setLatestSiteData(data);

      setStatus(true, "Connected");
      renderHeader(data);
      renderStats(data);
      renderTopThirdParties(data);

      await fetchWindowEvents();
      deriveFilteredEvents();
      renderVendorChips();

      if (getVizSelection() && !selectionStillValid()) {
        clearVizSelection({ close: true, clearBrush: true, renderTable: false, updateSummary: false });
      }

      renderECharts();

      if (getVizSelection()?.events?.length && selectionStillValid()) {
        renderRecentEventsFromEvents(getVizSelection().events, "No events match selection.", { selectedEventKey: getSelectedRecentEventKey() });
      } else {
        renderRecentEventsFromEvents(getChartEvents(), "No events match current filters.");
      }

      updateFilterSummary();
    } catch (err) {
      console.error(err);
      setStatus(false, "Backend unavailable");

      if (!getLatestSiteData()) {
        renderRecentEvents({ recentEvents: [] });
      }
    } finally {
      setIsFetchSiteInFlight(false);
    }
  }

  return {
    fetchWindowEvents,
    applyRangeChanges,
    fetchSite,
  };
}
