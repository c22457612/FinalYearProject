export function createChartBuilders(deps) {
  const {
    vizOptions,
    binSizeMs,
    hoverPointStyle,
    selectedPointStyle,
    getRangeWindow,
    buildVendorRollup,
    getVendorMetricValue,
    getResourceBucket,
    getPartyBucket,
    resourceLabels,
    partyLabels,
  } = deps;

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
  return binSizeMs[vizOptions.binSize] || binSizeMs["5m"];
}

function getSeriesType(defaultType = "bar") {
  if (vizOptions.seriesType === "area") return "line";
  if (vizOptions.seriesType === "bar" || vizOptions.seriesType === "line") return vizOptions.seriesType;
  return defaultType;
}

function buildSeries(name, data, { defaultType = "bar", stackKey = null } = {}) {
  const type = getSeriesType(defaultType);
  const series = { name, type, data };
  series.selectedMode = "single";

  series.emphasis = {
    focus: "none",
    itemStyle: {
      borderColor: hoverPointStyle.borderColor,
      borderWidth: hoverPointStyle.borderWidth,
    },
    lineStyle: {
      width: 2,
    },
  };
  series.select = {
    itemStyle: {
      borderColor: selectedPointStyle.borderColor,
      borderWidth: selectedPointStyle.borderWidth,
    },
  };

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
    label: resourceLabels[key] || key,
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
    label: partyLabels[bucket] || bucket,
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
          emphasis: { focus: "none" },
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

  return {
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
  };
}
