export function createChartOrchestrationController(deps) {
  const {
    getSiteLens,
    getSelectedVendor,
    setSelectedVendor,
    getVizMetric,
    buildVendorRollup,
    buildTimelineOption,
    buildVendorAllowedBlockedTimelineOption,
    buildVendorTopDomainsEndpointsOption,
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
    setVizSelection,
    renderVendorChips,
    renderECharts,
    focusVendorDetailsUx,
    hideVendorSelectionCue,
  } = deps;

  function buildChartPointState(viewId, params, effectiveViewId) {
    if (!params) return null;

    const seriesIndex = typeof params.seriesIndex === "number" ? params.seriesIndex : 0;
    const dataIndex = typeof params.dataIndex === "number" ? params.dataIndex : null;
    let semanticKey = "";

    if (
      viewId === "timeline"
      || viewId === "vendorAllowedBlockedTimeline"
      || viewId === "riskTrend"
      || viewId === "baselineDetectedBlockedTrend"
    ) {
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

  function summarizeBucketEvidence(events) {
    const list = Array.isArray(events) ? events.filter(Boolean) : [];
    const seen = list.length;
    const blocked = list.filter((ev) => ev?.kind === "network.blocked").length;
    const observed = list.filter((ev) => ev?.kind === "network.observed").length;
    const other = Math.max(0, seen - blocked - observed);
    return { seen, blocked, observed, other };
  }

  function getRepresentativeBucketExample(events) {
    const list = Array.isArray(events) ? events : [];
    for (const ev of list) {
      const rawUrl = String(ev?.data?.url || "").trim();
      if (!rawUrl) continue;
      try {
        const parsed = new URL(rawUrl);
        return `${parsed.hostname}${parsed.pathname || "/"}`;
      } catch {
        return rawUrl;
      }
    }
    return "";
  }

  function buildViewOption(requestedViewId, events) {
    let effectiveViewId = requestedViewId;
    let lensPivotActive = false;
    let built;

    if (requestedViewId === "vendorOverview") {
      const selectedVendor = getSelectedVendor();
      const lensApi = getSiteLens();
      const vendorCardinality = buildVendorRollup(events).length;
      const shouldPivot = !!(lensApi?.shouldAutoPivotVendorOverview
        && lensApi.shouldAutoPivotVendorOverview({
          viewId: requestedViewId,
          selectedVendor,
          events,
          vendorCardinality,
        }));

      if (shouldPivot) {
        built = buildTimelineOption(events);
        effectiveViewId = "timeline";
        lensPivotActive = true;
      } else {
        built = buildVendorOverviewOption(events);
      }
    } else if (requestedViewId === "vendorAllowedBlockedTimeline") built = buildVendorAllowedBlockedTimelineOption(events);
    else if (requestedViewId === "vendorTopDomainsEndpoints") built = buildVendorTopDomainsEndpointsOption(events, getSelectedVendor(), getVizMetric());
    else if (requestedViewId === "riskTrend") built = buildRiskTrendOption(events);
    else if (requestedViewId === "baselineDetectedBlockedTrend") built = buildBaselineDetectedBlockedTrendOption(events);
    else if (requestedViewId === "timeline") built = buildTimelineOption(events);
    else if (requestedViewId === "topSeen") built = buildTopDomainsOption(events, getVizMetric());
    else if (requestedViewId === "kinds") built = buildKindsOption(events);
    else if (requestedViewId === "apiGating") built = buildApiGatingOption(events);
    else if (requestedViewId === "vendorKindMatrix") built = buildVendorKindMatrixOption(events);
    else if (requestedViewId === "ruleIdFrequency") built = buildRuleIdFrequencyOption(events);
    else if (requestedViewId === "resourceTypes") built = buildResourceTypesOption(events);
    else if (requestedViewId === "modeBreakdown") built = buildModeBreakdownOption(events);
    else if (requestedViewId === "partySplit") built = buildPartySplitOption(events);
    else if (requestedViewId === "hourHeatmap") built = buildHourHeatmapOption(events);
    else built = buildTopDomainsOption(events, getVizMetric());

    return { built, effectiveViewId, lensPivotActive };
  }

  function handleChartClick({ viewId, params, meta, effectiveViewId }) {
    if (!meta) return;
    const chartPoint = buildChartPointState(viewId, params, effectiveViewId);

    if (
      viewId === "timeline"
      || viewId === "vendorAllowedBlockedTimeline"
      || viewId === "riskTrend"
      || viewId === "baselineDetectedBlockedTrend"
    ) {
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
      const selectedVendor = getSelectedVendor();
      const wasAllVendors = !selectedVendor?.vendorId;
      const label = params?.name;
      const evs = meta.evidenceByLabel?.get(label) || [];
      const vendor = meta.vendorByLabel?.get(label) || null;
      if (vendor) {
        setSelectedVendor(vendor);
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

    if (viewId === "vendorTopDomainsEndpoints") {
      const label = String(params?.name ?? params?.axisValue ?? "");
      const evs = meta.evidenceByBucket?.get(label) || [];
      const bucketKey = meta.bucketKeyByLabel?.get(label) || label || "";
      const title = meta.displayLabelByBucketKey?.get(label) || label || "Selection";
      const counts = summarizeBucketEvidence(evs);
      const bucketExample = getRepresentativeBucketExample(evs);
      const chartPoint = {
        viewId,
        effectiveViewId,
        seriesIndex: 0,
        dataIndex: typeof params?.dataIndex === "number" ? params.dataIndex : -1,
        semanticKey: `label:${label}`,
        highlightMode: "stacked-row",
      };

      setVizSelection({
        type: "vendorEndpointBucket",
        value: bucketKey,
        bucketKey,
        bucketLabel: title,
        seen: counts.seen,
        blocked: counts.blocked,
        observed: counts.observed,
        other: counts.other,
        bucketExample,
        title,
        summaryHtml: `<div class="muted">Selected bucket: ${title} (${counts.seen} total; ${counts.blocked} blocked; ${counts.observed} observed; ${counts.other} other).</div>`,
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

  return {
    buildChartPointState,
    buildViewOption,
    handleChartClick,
  };
}
