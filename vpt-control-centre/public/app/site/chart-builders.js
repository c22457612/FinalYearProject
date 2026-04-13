export function createChartBuilders(deps) {
  const {
    vizOptions,
    binSizeMs,
    hoverPointStyle,
    selectedPointStyle,
    getChartThemeTokens,
    getRangeWindow,
    buildVendorRollup,
    getKindBucket,
    getVisualCategoryBucket: getVisualCategoryBucketFromDeps,
    getVendorMetricValue,
    getResourceBucket,
    getPartyBucket,
    getPrivacyStatusBucket,
    getMitigationStatusBucket,
    resourceLabels,
    partyLabels,
  } = deps;

function readChartTheme() {
  return typeof getChartThemeTokens === "function"
    ? getChartThemeTokens()
    : {
        emptyText: "#94a3b8",
        axisLine: "#7388a2",
        axisLabel: "#cbd5e1",
        axisName: "#e2e8f0",
        legendText: "#e2e8f0",
        toolboxBorder: "#cbd5e1",
        toolboxFill: "rgba(148,163,184,0.18)",
        toolboxFillHover: "rgba(126,163,212,0.24)",
        seriesBlocked: "#7fa3d4",
        seriesObserved: "#6fb390",
        seriesBlockedApi: "#8e7bc0",
        seriesObservedApi: "#bd829d",
        seriesOther: "#caab68",
      };
}

function buildEmptyChartOption(message) {
  const chartTheme = readChartTheme();
  return {
    title: {
      text: message,
      left: "center",
      top: "middle",
      textStyle: {
        color: chartTheme.emptyText,
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
  const categoryColor = getCategorySeriesColors()[name];
  if (categoryColor) {
    series.itemStyle = { ...(series.itemStyle || {}), color: categoryColor };
    series.lineStyle = { ...(series.lineStyle || {}), color: categoryColor };
    if (type === "line") {
      series.lineStyle = { ...(series.lineStyle || {}), width: 2 };
    }
  }

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

function getBarLikeGridBottom(axisLabelRotate = 45, maxLabelLines = 1) {
  const rotate = Math.abs(Number(axisLabelRotate || 0));
  const lineCount = Math.max(1, Number(maxLabelLines) || 1);
  const extraLineRoom = Math.max(0, lineCount - 1) * 16;
  if (rotate >= 40) return 82 + extraLineRoom;
  if (rotate >= 28) return 68 + extraLineRoom;
  if (rotate >= 12) return 56 + extraLineRoom;
  return 44 + extraLineRoom;
}

function wrapLabelOnDelimiter(value, delimiter = ".", maxLineLength = 16, maxLines = 3) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  if (!delimiter || !raw.includes(delimiter) || raw.length <= maxLineLength) return raw;

  const parts = raw.split(delimiter).map((part) => String(part || "").trim()).filter(Boolean);
  if (!parts.length) return raw;

  const lines = [];
  let current = parts.shift() || "";

  while (parts.length) {
    const nextPart = parts.shift();
    const candidate = current ? `${current}${delimiter}${nextPart}` : nextPart;
    if (candidate.length <= maxLineLength || !current) {
      current = candidate;
      continue;
    }

    lines.push(current);
    if (lines.length >= Math.max(1, maxLines) - 1) {
      current = [nextPart, ...parts].filter(Boolean).join(delimiter);
      parts.length = 0;
      break;
    }
    current = nextPart;
  }

  if (current) lines.push(current);
  return lines.join("\n");
}

function buildBarLikeOption(
  rows,
  {
    seriesName = "count",
    defaultType = "bar",
    maxLabels = 20,
    axisLabelRotate = 45,
    axisLabelFormatter = null,
    axisLabelHideOverlap = true,
    axisLabelFontSize = 13,
    axisLabelMargin = 10,
  } = {},
) {
  const ranked = sortRankedRows(rows).slice(0, maxLabels);
  const normalized = normalizeRows(ranked);
  const labels = normalized.map((row) => row.label);
  const values = normalized.map((row) => row.value || 0);
  const evidenceByLabel = new Map(normalized.map((row) => [row.label, row.evs || []]));
  const formatAxisLabel = typeof axisLabelFormatter === "function"
    ? axisLabelFormatter
    : (value) => String(value || "");
  const maxLabelLines = Math.max(
    1,
    ...labels.map((label) => String(formatAxisLabel(label)).split("\n").filter(Boolean).length || 1),
  );

  return {
    option: {
      tooltip: { trigger: "axis" },
      grid: { left: 40, right: 18, top: 18, bottom: getBarLikeGridBottom(axisLabelRotate, maxLabelLines) },
      xAxis: {
        type: "category",
        data: labels,
        axisLabel: {
          rotate: axisLabelRotate,
          margin: axisLabelMargin,
          fontSize: axisLabelFontSize,
          hideOverlap: axisLabelHideOverlap,
          lineHeight: maxLabelLines > 1 ? Math.max(16, axisLabelFontSize + 2) : undefined,
          formatter: axisLabelFormatter || undefined,
        },
      },
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

function buildHorizontalRankedBarOption(
  rows,
  {
    seriesName = "count",
    defaultType = "bar",
    maxLabels = 20,
    axisLabelFormatter = null,
    axisLabelWidth = 220,
    tooltipFormatter = null,
  } = {},
) {
  const ranked = sortRankedRows(rows).slice(0, maxLabels);
  const normalized = normalizeRows(ranked);
  const labels = normalized.map((row) => row.label);
  const values = normalized.map((row) => row.value || 0);
  const evidenceByLabel = new Map(normalized.map((row) => [row.label, row.evs || []]));
  const formatAxisLabel = typeof axisLabelFormatter === "function"
    ? axisLabelFormatter
    : (value) => String(value || "");
  const rowByLabel = new Map(normalized.map((row) => [row.label, row]));

  return {
    option: {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: typeof tooltipFormatter === "function"
          ? tooltipFormatter
          : (params) => {
            const first = Array.isArray(params) ? params[0] : params;
            const label = String(first?.axisValue || first?.name || "");
            const row = rowByLabel.get(label);
            if (!row) return "";

            const value = Number(first?.value || 0);
            const rawValue = Number(row?.rawValue ?? row?.value ?? 0);
            const lines = [`<strong>${label}</strong>`];
            if (vizOptions.normalize) {
              lines.push(`${seriesName}: ${value.toFixed(2)}% (${rawValue})`);
            } else {
              lines.push(`${seriesName}: ${value}`);
            }
            return lines.join("<br/>");
          },
      },
      grid: { left: 24, right: 24, top: 18, bottom: 32, containLabel: true },
      xAxis: {
        type: "value",
        max: vizOptions.normalize ? 100 : null,
        axisLabel: vizOptions.normalize ? { formatter: "{value}%" } : undefined,
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: labels,
        axisLabel: {
          width: axisLabelWidth,
          overflow: "truncate",
          formatter: formatAxisLabel,
          interval: 0,
        },
      },
      series: [
        {
          ...buildSeries(seriesName, values, { defaultType }),
          barMaxWidth: 28,
        },
      ],
    },
    meta: { evidenceByLabel, normalized: vizOptions.normalize },
  };
}

function buildTrendTooltipFormatter(params) {
  const rows = Array.isArray(params) ? params : [];
  if (!rows.length) return "";

  const label = String(rows[0]?.axisValueLabel || rows[0]?.axisValue || "Time bucket");
  const lines = [`<strong>${label}</strong>`];
  for (const row of rows) {
    const value = Number(row?.value);
    const count = Number.isFinite(value) ? value : 0;
    lines.push(`${row?.marker || ""}${row?.seriesName || "Series"}: ${count} events`);
  }
  return lines.join("<br/>");
}

function buildTrendAxes(labels) {
  const chartTheme = readChartTheme();
  return {
    xAxis: {
      type: "category",
      data: labels,
      name: "Time",
      nameLocation: "middle",
      nameGap: 34,
      axisLine: {
        lineStyle: { color: chartTheme.axisLine },
      },
      axisLabel: {
        color: chartTheme.axisLabel,
      },
      nameTextStyle: {
        color: chartTheme.axisName,
        fontWeight: 700,
      },
    },
    yAxis: {
      type: "value",
      name: "Events",
      nameLocation: "middle",
      nameGap: 52,
      minInterval: 1,
      axisLine: {
        lineStyle: { color: chartTheme.axisLine },
      },
      axisLabel: {
        color: chartTheme.axisLabel,
      },
      splitLine: {
        lineStyle: {
          color: chartTheme.toolboxFill,
        },
      },
      nameTextStyle: {
        color: chartTheme.axisName,
        fontWeight: 700,
      },
    },
  };
}

function getTrendLegendTextStyle() {
  const chartTheme = readChartTheme();
  return {
    color: chartTheme.legendText,
    fontSize: 14,
    fontWeight: 700,
  };
}

function getCategorySeriesColors() {
  const chartTheme = readChartTheme();
  return {
    Blocked: chartTheme.seriesBlocked,
    Observed: chartTheme.seriesObserved,
    "Blocked API": chartTheme.seriesBlockedApi,
    "Observed API": chartTheme.seriesObservedApi,
    Other: chartTheme.seriesOther,
  };
}

function buildTrendToolbox() {
  const chartTheme = readChartTheme();
  return {
    right: 12,
    top: -2,
    itemSize: 21,
    itemGap: 12,
    showTitle: true,
    iconStyle: {
      borderColor: chartTheme.toolboxBorder,
      borderWidth: 2.2,
      color: chartTheme.toolboxFill,
    },
    textStyle: {
      color: chartTheme.legendText,
      fontSize: 14,
      fontWeight: 700,
      padding: [9, 0, 0, 0],
    },
    emphasis: {
      iconStyle: {
        borderColor: chartTheme.toolboxBorder,
        color: chartTheme.toolboxFillHover,
        borderWidth: 2.4,
      },
      textStyle: {
        color: chartTheme.legendText,
        fontSize: 14,
        fontWeight: 700,
        padding: [10, 0, 0, 0],
      },
    },
    feature: {
      brush: {
        type: ["lineX", "clear"],
        title: {
          lineX: "Select time window",
          clear: "Clear window selection",
        },
      },
      restore: {
        title: "Reset chart view",
      },
    },
  };
}

const TIMELINE_DENSITY_BIN_STEPS = Object.freeze([
  60 * 1000,
  5 * 60 * 1000,
  15 * 60 * 1000,
  60 * 60 * 1000,
]);
const TIMELINE_DENSITY_BIN_LABELS = Object.freeze({
  [60 * 1000]: "1m",
  [5 * 60 * 1000]: "5m",
  [15 * 60 * 1000]: "15m",
  [60 * 60 * 1000]: "60m",
});
const LOW_SIGNAL_EVENT_THRESHOLD = 8;
const LOW_SIGNAL_NON_ZERO_BIN_THRESHOLD = 2;
const LOW_SIGNAL_ACTIVE_BIN_RATIO_THRESHOLD = 0.12;
const LOW_SIGNAL_FLAT_PEAK_THRESHOLD = 2;
const LOW_SIGNAL_SIMPLE_SERIES_EVENT_THRESHOLD = 6;
const LOW_SIGNAL_BUCKET_EVENT_THRESHOLD = 10;
const LOW_SIGNAL_BUCKET_COUNT_THRESHOLD = 3;
const LOW_SIGNAL_ZOOM_MIN_TOTAL_BINS = 36;
const LOW_SIGNAL_ZOOM_MIN_WINDOW_BINS = 12;
const COMPARISON_TOP_VENDOR_CAP = 10;
const LOW_CONFIDENCE_SAMPLE_THRESHOLD = 10;

function buildComparisonVendorFocusGuidance(selectedVendor) {
  const name = String(selectedVendor?.vendorName || selectedVendor?.vendorId || "selected vendor");
  return `Comparison view is hidden while vendor focus is active (${name}). Clear vendor focus to compare multiple vendors.`;
}

function buildGuidanceOnlyChart(message) {
  return {
    option: buildEmptyChartOption(message),
    meta: { stateGuidanceMessage: message },
  };
}

function formatBinLabel(binMs) {
  const value = Number(binMs || 0);
  if (TIMELINE_DENSITY_BIN_LABELS[value]) return TIMELINE_DENSITY_BIN_LABELS[value];
  const mins = Math.max(1, Math.round(value / (60 * 1000)));
  return `${mins}m`;
}

function assessTimelineSignal({ totalBins = 0, binEvents = [], totalEvents = 0 } = {}) {
  const safeBins = Math.max(1, Number(totalBins || 0));
  const activeBins = (Array.isArray(binEvents) ? binEvents : []).filter((list) => Array.isArray(list) && list.length > 0);
  const nonZeroBins = activeBins.length;
  const activeRatio = nonZeroBins / safeBins;
  const peakBinEvents = activeBins.length ? Math.max(...activeBins.map((list) => list.length)) : 0;
  const reasons = [];

  if (totalEvents <= LOW_SIGNAL_EVENT_THRESHOLD) reasons.push("few-events");
  if (nonZeroBins <= LOW_SIGNAL_NON_ZERO_BIN_THRESHOLD) reasons.push("few-active-bins");
  if (activeRatio <= LOW_SIGNAL_ACTIVE_BIN_RATIO_THRESHOLD && safeBins >= 12) reasons.push("mostly-empty-timespan");
  if (nonZeroBins <= 1 && peakBinEvents <= LOW_SIGNAL_FLAT_PEAK_THRESHOLD) reasons.push("single-thin-peak");

  return {
    totalEvents: Number(totalEvents || 0),
    nonZeroBins,
    totalBins: safeBins,
    activeRatio,
    peakBinEvents,
    reasons,
    isLowSignal: reasons.length > 0,
  };
}

function chooseDensityAwareBinMs({ spanMs = 0, currentBinMs = 0, totalEvents = 0 } = {}) {
  const span = Math.max(1, Number(spanMs || 0));
  const current = Math.max(1, Number(currentBinMs || TIMELINE_DENSITY_BIN_STEPS[1]));
  const targetBins = totalEvents <= 4 ? 8 : totalEvents <= 8 ? 12 : 18;

  for (const candidate of TIMELINE_DENSITY_BIN_STEPS) {
    if (candidate < current) continue;
    const bins = Math.max(1, Math.ceil(span / candidate));
    if (bins <= targetBins) return candidate;
  }

  const maxCandidate = TIMELINE_DENSITY_BIN_STEPS[TIMELINE_DENSITY_BIN_STEPS.length - 1];
  return Math.max(current, maxCandidate);
}

function buildTimelineGuidanceMessage({
  signal,
  densityApplied = false,
  originalBinMs = 0,
  appliedBinMs = 0,
  simplifiedSeries = false,
  focusedWindow = false,
  viewMode = "power",
} = {}) {
  if (!signal?.isLowSignal) return "";

  const base = `Low-signal scope: ${signal.totalEvents} events across ${signal.nonZeroBins}/${signal.totalBins} active time buckets.`;
  if (!densityApplied && !simplifiedSeries) return base;

  const modePrefix = viewMode === "easy" ? "Easy mode density defaults applied: " : "";
  const parts = [];
  if (densityApplied && Number(appliedBinMs) > Number(originalBinMs)) {
    parts.push(`using ${formatBinLabel(appliedBinMs)} bins`);
  }
  if (simplifiedSeries) {
    parts.push("using a simpler Events series");
  }
  if (focusedWindow) {
    parts.push("focusing the visible window on active time");
  }

  if (!parts.length) return base;
  return `${modePrefix}${base} ${parts.join(" and ")}.`;
}

function buildLowSignalDataZoomWindow({ totalBins = 0, binEvents = [] } = {}) {
  const bins = Math.max(1, Number(totalBins || 0));
  if (bins < LOW_SIGNAL_ZOOM_MIN_TOTAL_BINS) return null;

  const activeIndices = [];
  const list = Array.isArray(binEvents) ? binEvents : [];
  for (let i = 0; i < list.length; i++) {
    if (Array.isArray(list[i]) && list[i].length > 0) activeIndices.push(i);
  }
  if (!activeIndices.length) return null;

  const first = activeIndices[0];
  const last = activeIndices[activeIndices.length - 1];
  const activeSpan = Math.max(1, (last - first) + 1);
  const padding = Math.max(1, Math.round(activeSpan * 0.2));
  const minWindow = Math.min(bins, Math.max(LOW_SIGNAL_ZOOM_MIN_WINDOW_BINS, activeSpan + (padding * 2)));

  let startIdx = Math.max(0, first - padding);
  let endIdx = Math.min(bins - 1, last + padding);
  let windowSpan = (endIdx - startIdx) + 1;

  if (windowSpan < minWindow) {
    const extra = minWindow - windowSpan;
    const left = Math.floor(extra / 2);
    const right = extra - left;
    startIdx = Math.max(0, startIdx - left);
    endIdx = Math.min(bins - 1, endIdx + right);
    windowSpan = (endIdx - startIdx) + 1;

    if (windowSpan < minWindow) {
      if (startIdx === 0) endIdx = Math.min(bins - 1, startIdx + minWindow - 1);
      else if (endIdx === bins - 1) startIdx = Math.max(0, endIdx - minWindow + 1);
    }
  }

  const start = Number(((startIdx * 100) / Math.max(1, bins - 1)).toFixed(2));
  const end = Number((((endIdx + 1) * 100) / Math.max(1, bins)).toFixed(2));
  if (!(Number.isFinite(start) && Number.isFinite(end)) || end <= start) return null;
  return { start, end };
}

function buildTimelineOption(events, options = {}) {
  const viewMode = String(options?.viewMode || "easy");
  const densityAware = options?.densityAware === true;
  const list = Array.isArray(events) ? events : [];
  const { from, to } = getRangeWindow();
  const start = from ?? (list[0]?.ts ?? Date.now());
  const end = to ?? (list[list.length - 1]?.ts ?? Date.now());
  const span = Math.max(1, end - start);
  const baseBinMs = getTimelineBinMs();

  const buildBuckets = (targetBinMs) => {
    const bins = Math.max(1, Math.ceil(span / targetBinMs));
    const labels = [];
    const blocked = new Array(bins).fill(0);
    const observed = new Array(bins).fill(0);
    const blockedApi = new Array(bins).fill(0);
    const observedApi = new Array(bins).fill(0);
    const other = new Array(bins).fill(0);
    const total = new Array(bins).fill(0);
    const binEvents = new Array(bins).fill(0).map(() => []);

    for (const ev of list) {
      if (!ev?.ts) continue;
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((ev.ts - start) / targetBinMs)));
      binEvents[idx].push(ev);
      total[idx] += 1;

      const bucket = getBlockedObservedOtherBucket(ev);
      if (bucket === "blocked") blocked[idx] += 1;
      else if (bucket === "observed") observed[idx] += 1;
      else if (bucket === "blocked_api") blockedApi[idx] += 1;
      else if (bucket === "observed_api") observedApi[idx] += 1;
      else other[idx] += 1;
    }

    for (let i = 0; i < bins; i++) {
      labels.push(new Date(start + i * targetBinMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }

    return { bins, labels, blocked, observed, blockedApi, observedApi, other, total, binEvents };
  };

  let effectiveBinMs = baseBinMs;
  let timeline = buildBuckets(effectiveBinMs);
  const initialSignal = assessTimelineSignal({
    totalBins: timeline.bins,
    binEvents: timeline.binEvents,
    totalEvents: list.length,
  });
  let densityBinApplied = false;

  if (densityAware && initialSignal.isLowSignal) {
    const suggestedBinMs = chooseDensityAwareBinMs({
      spanMs: span,
      currentBinMs: baseBinMs,
      totalEvents: list.length,
    });
    if (suggestedBinMs > effectiveBinMs) {
      effectiveBinMs = suggestedBinMs;
      timeline = buildBuckets(effectiveBinMs);
      densityBinApplied = true;
    }
  }

  const finalSignal = assessTimelineSignal({
    totalBins: timeline.bins,
    binEvents: timeline.binEvents,
    totalEvents: list.length,
  });
  const hasApiCategory = list.some((ev) => {
    const bucket = getBlockedObservedOtherBucket(ev);
    return bucket === "blocked_api" || bucket === "observed_api";
  });
  const simplifiedSeries = densityAware
    && finalSignal.isLowSignal
    && finalSignal.totalEvents <= LOW_SIGNAL_SIMPLE_SERIES_EVENT_THRESHOLD
    && !hasApiCategory;
  const focusedWindow = densityAware
    && finalSignal.isLowSignal
    && !!finalSignal.reasons?.includes("mostly-empty-timespan");
  const defaultZoomWindow = focusedWindow
    ? buildLowSignalDataZoomWindow({ totalBins: timeline.bins, binEvents: timeline.binEvents })
    : null;
  const stateGuidanceMessage = buildTimelineGuidanceMessage({
    signal: finalSignal,
    densityApplied: densityBinApplied,
    originalBinMs: baseBinMs,
    appliedBinMs: effectiveBinMs,
    simplifiedSeries,
    focusedWindow: !!defaultZoomWindow,
    viewMode,
  });

  return {
    option: {
      tooltip: { trigger: "axis", formatter: buildTrendTooltipFormatter },
      legend: { top: 0, textStyle: getTrendLegendTextStyle(), itemWidth: 22, itemHeight: 12, itemGap: 14 },
      toolbox: buildTrendToolbox(),
      brush: {
        xAxisIndex: 0,
        brushMode: "single",
      },
      grid: { left: 40, right: 18, top: 64, bottom: 60 },
      ...buildTrendAxes(timeline.labels),
      dataZoom: [
        {
          type: "inside",
          ...(defaultZoomWindow ? { start: defaultZoomWindow.start, end: defaultZoomWindow.end } : {}),
        },
        {
          type: "slider",
          height: 18,
          bottom: 18,
          ...(defaultZoomWindow ? { start: defaultZoomWindow.start, end: defaultZoomWindow.end } : {}),
        },
      ],
      series: simplifiedSeries
        ? [buildSeries("Events", timeline.total, { defaultType: "bar" })]
        : [
          buildSeries("Blocked", timeline.blocked, { defaultType: "bar", stackKey: "total" }),
          buildSeries("Observed", timeline.observed, { defaultType: "bar", stackKey: "total" }),
          buildSeries("Blocked API", timeline.blockedApi, { defaultType: "bar", stackKey: "total" }),
          buildSeries("Observed API", timeline.observedApi, { defaultType: "bar", stackKey: "total" }),
          buildSeries("Other", timeline.other, { defaultType: "bar", stackKey: "total" }),
        ],
    },
    meta: {
      start,
      binMs: effectiveBinMs,
      binEvents: timeline.binEvents,
      labels: timeline.labels,
      lowSignal: finalSignal,
      densityDefaults: {
        applied: densityBinApplied || simplifiedSeries || !!defaultZoomWindow,
        originalBinMs: baseBinMs,
        appliedBinMs: effectiveBinMs,
        simplifiedSeries,
        focusedWindow: !!defaultZoomWindow,
      },
      stateGuidanceMessage,
    },
  };
}

function buildVendorAllowedBlockedTimelineOption(events, options = {}) {
  const viewMode = String(options?.viewMode || "easy");
  const densityAware = options?.densityAware === true;
  const networkEvents = (Array.isArray(events) ? events : []).filter((ev) => ev?.kind === "network.blocked" || ev?.kind === "network.observed");
  if (!networkEvents.length) {
    return {
      option: { xAxis: { type: "category", data: [] }, yAxis: { type: "value" }, series: [] },
      meta: {
        start: Date.now(),
        binMs: getTimelineBinMs(),
        binEvents: [],
        labels: [],
        lowSignal: null,
        densityDefaults: { applied: false, originalBinMs: getTimelineBinMs(), appliedBinMs: getTimelineBinMs(), simplifiedSeries: false },
      },
    };
  }

  const { from, to } = getRangeWindow();
  const start = from ?? (networkEvents[0]?.ts ?? Date.now());
  const end = to ?? (networkEvents[networkEvents.length - 1]?.ts ?? Date.now());
  const span = Math.max(1, end - start);
  const baseBinMs = getTimelineBinMs();

  const buildBuckets = (targetBinMs) => {
    const bins = Math.max(1, Math.ceil(span / targetBinMs));
    const labels = [];
    const blocked = new Array(bins).fill(0);
    const allowed = new Array(bins).fill(0);
    const total = new Array(bins).fill(0);
    const binEvents = new Array(bins).fill(0).map(() => []);
    const binStats = new Array(bins).fill(null).map(() => ({
      blocked: 0,
      allowed: 0,
      total: 0,
      presence: "empty",
    }));

    for (const ev of networkEvents) {
      if (!ev?.ts) continue;
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((ev.ts - start) / targetBinMs)));
      binEvents[idx].push(ev);
      total[idx] += 1;
      if (ev.kind === "network.blocked") blocked[idx] += 1;
      else allowed[idx] += 1;
    }

    for (let i = 0; i < bins; i++) {
      const blockedCount = Number(blocked[i] || 0);
      const allowedCount = Number(allowed[i] || 0);
      const totalCount = Number(total[i] || 0);
      binStats[i] = {
        blocked: blockedCount,
        allowed: allowedCount,
        total: totalCount,
        presence: blockedCount > 0 && allowedCount > 0
          ? "mixed"
          : blockedCount > 0
            ? "blocked-only"
            : allowedCount > 0
              ? "allowed-only"
              : "empty",
      };
      labels.push(new Date(start + i * targetBinMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }

    return {
      bins,
      labels,
      blocked,
      allowed,
      total,
      blockedSeries: binStats.map((bin) => (bin.blocked > 0 ? bin.blocked : null)),
      allowedSeries: binStats.map((bin) => (bin.allowed > 0 ? bin.allowed : null)),
      binEvents,
      binStats,
    };
  };

  let effectiveBinMs = baseBinMs;
  let timeline = buildBuckets(effectiveBinMs);
  const initialSignal = assessTimelineSignal({
    totalBins: timeline.bins,
    binEvents: timeline.binEvents,
    totalEvents: networkEvents.length,
  });
  let densityBinApplied = false;

  if (densityAware && initialSignal.isLowSignal) {
    const suggestedBinMs = chooseDensityAwareBinMs({
      spanMs: span,
      currentBinMs: baseBinMs,
      totalEvents: networkEvents.length,
    });
    if (suggestedBinMs > effectiveBinMs) {
      effectiveBinMs = suggestedBinMs;
      timeline = buildBuckets(effectiveBinMs);
      densityBinApplied = true;
    }
  }

  const finalSignal = assessTimelineSignal({
    totalBins: timeline.bins,
    binEvents: timeline.binEvents,
    totalEvents: networkEvents.length,
  });
  const simplifiedSeries = false;
  const focusedWindow = densityAware
    && finalSignal.isLowSignal
    && !!finalSignal.reasons?.includes("mostly-empty-timespan");
  const defaultZoomWindow = focusedWindow
    ? buildLowSignalDataZoomWindow({ totalBins: timeline.bins, binEvents: timeline.binEvents })
    : null;
  const stateGuidanceMessage = buildTimelineGuidanceMessage({
    signal: finalSignal,
    densityApplied: densityBinApplied,
    originalBinMs: baseBinMs,
    appliedBinMs: effectiveBinMs,
    simplifiedSeries,
    focusedWindow: !!defaultZoomWindow,
    viewMode,
  });

  const buildVendorTimelineTooltip = (params) => {
    const rows = Array.isArray(params) ? params : [params];
    const first = rows.find(Boolean);
    if (!first) return "";

    const label = String(first?.axisValueLabel || first?.axisValue || "Time bucket");
    const dataIndex = Number.isInteger(first?.dataIndex) ? first.dataIndex : timeline.labels.indexOf(label);
    const bin = timeline.binStats?.[dataIndex] || { blocked: 0, allowed: 0, total: 0, presence: "empty" };
    const lines = [`<strong>${label}</strong>`];

    if (bin.blocked > 0) {
      const blockedMarker = rows.find((row) => row?.seriesName === "Blocked")?.marker || "";
      lines.push(`${blockedMarker}Blocked: ${bin.blocked} events`);
    }
    if (bin.allowed > 0) {
      const observedMarker = rows.find((row) => row?.seriesName === "Observed")?.marker || "";
      lines.push(`${observedMarker}Observed: ${bin.allowed} events`);
    }
    if (bin.total > 0) {
      lines.push(`Total: ${bin.total} events`);
    } else {
      lines.push("No captured network events in this interval");
    }

    return lines.join("<br/>");
  };

  const blockedSeries = buildForcedStackedBarSeries("Blocked", timeline.blockedSeries, "vendor-allowed-blocked");
  const allowedSeries = buildForcedStackedBarSeries("Observed", timeline.allowedSeries, "vendor-allowed-blocked");
  for (const series of [blockedSeries, allowedSeries]) {
    series.barWidth = "72%";
    series.barMaxWidth = 40;
    series.barMinHeight = 4;
    series.barCategoryGap = "20%";
    series.barGap = "-100%";
  }

  return {
    option: {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: buildVendorTimelineTooltip,
      },
      legend: { top: 0, textStyle: getTrendLegendTextStyle(), itemWidth: 22, itemHeight: 12, itemGap: 14 },
      toolbox: buildTrendToolbox(),
      brush: {
        xAxisIndex: 0,
        brushMode: "single",
      },
      grid: { left: 40, right: 18, top: 64, bottom: 60 },
      ...buildTrendAxes(timeline.labels),
      dataZoom: [
        {
          type: "inside",
          ...(defaultZoomWindow ? { start: defaultZoomWindow.start, end: defaultZoomWindow.end } : {}),
        },
        {
          type: "slider",
          height: 18,
          bottom: 18,
          ...(defaultZoomWindow ? { start: defaultZoomWindow.start, end: defaultZoomWindow.end } : {}),
        },
      ],
      series: [blockedSeries, allowedSeries],
    },
    meta: {
      start,
      binMs: effectiveBinMs,
      binEvents: timeline.binEvents,
      labels: timeline.labels,
      binStats: timeline.binStats,
      lowSignal: finalSignal,
      densityDefaults: {
        applied: densityBinApplied || simplifiedSeries || !!defaultZoomWindow,
        originalBinMs: baseBinMs,
        appliedBinMs: effectiveBinMs,
        simplifiedSeries,
        focusedWindow: !!defaultZoomWindow,
      },
      stateGuidanceMessage,
    },
  };
}

const GENERIC_ENDPOINT_PREFIXES = new Set(["api", "v1", "v2", "v3"]);
const DEFAULT_VENDOR_ENDPOINT_READOUT_LIMIT = 5;

function parseUrlObject(value) {
  const raw = String(value || "").trim();
  if (!raw) return null;
  try {
    return new URL(raw);
  } catch {
    return null;
  }
}

function truncateBucketSegment(value, maxLength = 16) {
  const text = String(value || "");
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 1))}~`;
}

function deriveBucketDomain(ev) {
  const direct = String(ev?.data?.domain || "").trim().toLowerCase();
  if (direct) return direct;
  const parsed = parseUrlObject(ev?.data?.url);
  return String(parsed?.hostname || "").trim().toLowerCase();
}

function buildEndpointBucket(ev) {
  const parsed = parseUrlObject(ev?.data?.url);
  const pathname = String(parsed?.pathname || "");
  const segments = pathname
    .split("/")
    .map((segment) => String(segment || "").trim().toLowerCase())
    .filter(Boolean);

  if (!segments.length) {
    return { raw: "/", short: "/" };
  }

  const first = segments[0];
  const second = segments[1] || "";
  const includeSecond = !!second && (first.length <= 2 || GENERIC_ENDPOINT_PREFIXES.has(first));
  const rawParts = includeSecond ? [first, second] : [first];
  const shortParts = rawParts.map((segment) => truncateBucketSegment(segment));

  return {
    raw: `/${rawParts.join("/")}`,
    short: `/${shortParts.join("/")}`,
  };
}

function buildForcedStackedBarSeries(name, data, stackKey) {
  const series = buildSeries(name, data, { defaultType: "bar" });
  series.type = "bar";
  delete series.smooth;
  delete series.symbol;
  delete series.areaStyle;
  series.stack = stackKey;
  return series;
}

function getBlockedObservedOtherBucket(ev) {
  if (typeof getVisualCategoryBucketFromDeps === "function") {
    return getVisualCategoryBucketFromDeps(ev);
  }
  return typeof getKindBucket === "function" ? getKindBucket(ev) : "other";
}

function assessVendorBucketSignal(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const bucketCount = list.length;
  const nonZeroBuckets = list.filter((row) => Number(row?.value || 0) > 0).length;
  const totalEvents = list.reduce((acc, row) => acc + Number(row?.seenCount || 0), 0);
  const topSeen = list.length ? Math.max(...list.map((row) => Number(row?.seenCount || 0))) : 0;
  const topShare = topSeen / Math.max(1, totalEvents);
  const reasons = [];

  if (totalEvents <= LOW_SIGNAL_BUCKET_EVENT_THRESHOLD) reasons.push("few-events");
  if (bucketCount < LOW_SIGNAL_BUCKET_COUNT_THRESHOLD) reasons.push("few-buckets");
  if (nonZeroBuckets < LOW_SIGNAL_BUCKET_COUNT_THRESHOLD) reasons.push("few-non-zero-buckets");
  if (bucketCount <= 2 && topShare >= 0.75) reasons.push("single-dominant-bucket");

  return {
    totalEvents,
    bucketCount,
    nonZeroBuckets,
    topShare,
    reasons,
    isLowSignal: reasons.length > 0,
  };
}

function buildVendorEndpointRanking(events, selectedVendor, metric = "seen", { limit = null } = {}) {
  const vendorId = String(selectedVendor?.vendorId || "");
  const vendorName = selectedVendor?.vendorName || "the selected vendor";
  if (!vendorId) {
    return { vendorName, rows: [], lowSignal: null, stateGuidanceMessage: "Select a vendor to see where it connects (top domains/endpoints)." };
  }

  const map = new Map();
  for (const ev of Array.isArray(events) ? events : []) {
    const domain = deriveBucketDomain(ev);
    if (!domain) continue;

    const bucket = buildEndpointBucket(ev);
    const bucketKey = `${domain}${bucket.raw}`;
    if (!map.has(bucketKey)) {
      map.set(bucketKey, {
        bucketKey,
        domain,
        bucketRaw: bucket.raw,
        bucketShort: bucket.short,
        seenCount: 0,
        blockedCount: 0,
        observedCount: 0,
        blockedApiCount: 0,
        observedApiCount: 0,
        otherCount: 0,
        events: [],
      });
    }

    const row = map.get(bucketKey);
    row.seenCount += 1;
    const category = getBlockedObservedOtherBucket(ev);
    if (category === "blocked") row.blockedCount += 1;
    else if (category === "observed") row.observedCount += 1;
    else if (category === "blocked_api") row.blockedApiCount += 1;
    else if (category === "observed_api") row.observedApiCount += 1;
    else row.otherCount += 1;
    row.events.push(ev);
  }

  const rows = Array.from(map.values()).map((row) => {
    const metricValue = metric === "blocked"
      ? Number(row.blockedCount || 0) + Number(row.blockedApiCount || 0)
      : metric === "observed"
        ? Number(row.observedCount || 0) + Number(row.observedApiCount || 0)
        : row.seenCount;

    return {
      ...row,
      value: metricValue,
      displayLabel: `${row.domain} - ${row.bucketShort}`,
      fullLabel: `${row.domain} - ${row.bucketRaw}`,
    };
  }).sort((a, b) => {
    const diff = Number(b.value || 0) - Number(a.value || 0);
    if (diff !== 0) return diff;
    return String(a.bucketKey || "").localeCompare(String(b.bucketKey || ""), undefined, { sensitivity: "base" });
  });

  if (!rows.length) {
    return {
      vendorName,
      rows: [],
      lowSignal: null,
      stateGuidanceMessage: "",
    };
  }

  const limited = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? rows.slice(0, Number(limit))
    : rows;
  const lowSignal = assessVendorBucketSignal(limited);
  const stateGuidanceMessage = lowSignal.isLowSignal
    ? `Low-signal inspection: only ${lowSignal.totalEvents} events span ${lowSignal.bucketCount} endpoint bucket${lowSignal.bucketCount === 1 ? "" : "s"} for ${vendorName} in this scope.`
    : "";

  return {
    vendorName,
    rows: limited,
    lowSignal,
    stateGuidanceMessage,
  };
}

function buildVendorEndpointReadoutData(events, selectedVendor, options = {}) {
  const limit = Math.min(
    DEFAULT_VENDOR_ENDPOINT_READOUT_LIMIT,
    Math.max(1, Number(options?.limit) || DEFAULT_VENDOR_ENDPOINT_READOUT_LIMIT),
  );
  const ranking = buildVendorEndpointRanking(events, selectedVendor, options?.metric || "seen", { limit });
  return {
    vendorName: ranking.vendorName,
    stateGuidanceMessage: ranking.stateGuidanceMessage,
    items: ranking.rows.map((row) => ({
      bucketKey: row.bucketKey,
      displayLabel: row.displayLabel,
      fullLabel: row.fullLabel,
      total: Number(row.seenCount || 0),
      blocked: Number(row.blockedCount || 0) + Number(row.blockedApiCount || 0),
      observed: Number(row.observedCount || 0) + Number(row.observedApiCount || 0),
      api: Number(row.blockedApiCount || 0) + Number(row.observedApiCount || 0),
      other: Number(row.otherCount || 0),
    })),
  };
}

function buildVendorTopDomainsEndpointsOption(events, selectedVendor, metric = "seen", options = {}) {
  void options;
  const topLimit = Math.max(1, Number(vizOptions.topN) || 20);
  const ranking = buildVendorEndpointRanking(events, selectedVendor, metric, { limit: topLimit });
  if (!ranking.rows.length) {
    return {
      option: { xAxis: { type: "category", data: [] }, yAxis: { type: "value" }, series: [] },
      meta: {
        evidenceByBucket: new Map(),
        bucketKeyByLabel: new Map(),
        displayLabelByBucketKey: new Map(),
        fullLabelByBucketKey: new Map(),
        topBucketSummary: null,
        lowSignal: ranking.lowSignal,
        stateGuidanceMessage: ranking.stateGuidanceMessage || `No domain/endpoint activity is available for ${ranking.vendorName} in this scope.`,
      },
    };
  }

  const ranked = ranking.rows;
  const evidenceByBucket = new Map();
  const bucketKeyByLabel = new Map();
  const displayLabelByBucketKey = new Map();
  const fullLabelByBucketKey = new Map();
  const statsByBucketKey = new Map();
  const categoryKeys = ranked.map((row) => row.bucketKey);
  const blocked = new Array(categoryKeys.length).fill(0);
  const observed = new Array(categoryKeys.length).fill(0);
  const other = new Array(categoryKeys.length).fill(0);

  for (let i = 0; i < ranked.length; i++) {
    const row = ranked[i];
    const total = Math.max(1, Number(row.seenCount || 0));
    const blockedTotal = Number(row.blockedCount || 0) + Number(row.blockedApiCount || 0);
    const observedTotal = Number(row.observedCount || 0) + Number(row.observedApiCount || 0);

    if (vizOptions.normalize) {
      blocked[i] = Number(((blockedTotal * 100) / total).toFixed(2));
      observed[i] = Number(((observedTotal * 100) / total).toFixed(2));
      other[i] = Number((((row.otherCount || 0) * 100) / total).toFixed(2));
    } else {
      blocked[i] = blockedTotal;
      observed[i] = observedTotal;
      other[i] = row.otherCount || 0;
    }

    evidenceByBucket.set(row.bucketKey, row.events || []);
    bucketKeyByLabel.set(row.bucketKey, row.bucketKey);
    displayLabelByBucketKey.set(row.bucketKey, row.displayLabel);
    fullLabelByBucketKey.set(row.bucketKey, row.fullLabel);
    statsByBucketKey.set(row.bucketKey, {
      seen: Number(row.seenCount || 0),
      blocked: blockedTotal,
      observed: observedTotal,
      blockedApi: Number(row.blockedApiCount || 0),
      observedApi: Number(row.observedApiCount || 0),
      api: Number((row.blockedApiCount || 0) + (row.observedApiCount || 0)),
      other: Number(row.otherCount || 0),
    });
  }

  const topBucket = ranked[0] || null;
  const chartTheme = readChartTheme();
  const blockedSeries = buildForcedStackedBarSeries("Blocked", blocked, "vendor-endpoint-inspection");
  const observedSeries = buildForcedStackedBarSeries("Observed", observed, "vendor-endpoint-inspection");
  const otherSeries = buildForcedStackedBarSeries("Other", other, "vendor-endpoint-inspection");
  blockedSeries.itemStyle = { ...(blockedSeries.itemStyle || {}), borderRadius: [6, 0, 0, 6] };
  observedSeries.itemStyle = { ...(observedSeries.itemStyle || {}) };
  otherSeries.itemStyle = { ...(otherSeries.itemStyle || {}), borderRadius: [0, 6, 6, 0] };

  return {
    option: {
      tooltip: {
        trigger: "item",
        axisPointer: { type: "none" },
        formatter: (params) => {
          const label = String(params?.name ?? params?.axisValue ?? "");
          if (!label) return "";
          const fullLabel = fullLabelByBucketKey.get(label) || label;
          const stats = statsByBucketKey.get(label) || { seen: 0, blocked: 0, observed: 0, blockedApi: 0, observedApi: 0, other: 0, api: 0 };
          const lines = [`<strong>${fullLabel}</strong>`];

          if (vizOptions.normalize) {
            const total = Math.max(1, Number(stats.seen || 0));
            lines.push(`Blocked: ${(((stats.blocked || 0) * 100) / total).toFixed(2)}% (${stats.blocked})`);
            lines.push(`Observed: ${(((stats.observed || 0) * 100) / total).toFixed(2)}% (${stats.observed})`);
            lines.push(`Other: ${(((stats.other || 0) * 100) / total).toFixed(2)}% (${stats.other})`);
          } else {
            lines.push(`Blocked: ${stats.blocked}`);
            lines.push(`Observed: ${stats.observed}`);
            lines.push(`Other: ${stats.other}`);
          }

          if (stats.api > 0) {
            lines.push(`API activity: ${stats.api} (${stats.blockedApi} blocked / ${stats.observedApi} observed)`);
          }
          lines.push(`Total: ${stats.seen}`);
          return lines.join("<br/>");
        },
      },
      legend: {
        top: 0,
        textStyle: { color: chartTheme.legendText },
        itemWidth: 18,
        itemHeight: 10,
        itemGap: 14,
      },
      grid: { left: 164, right: 22, top: 40, bottom: 28, containLabel: true },
      xAxis: {
        type: "value",
        name: "Events",
        nameLocation: "middle",
        nameGap: 30,
        nameTextStyle: {
          color: chartTheme.axisName,
          fontWeight: 700,
          fontSize: 12,
        },
        max: vizOptions.normalize ? 100 : null,
        axisLine: {
          show: true,
          lineStyle: { color: chartTheme.axisLine },
        },
        axisTick: { show: true },
        axisLabel: {
          color: chartTheme.axisLabel,
          ...(vizOptions.normalize ? { formatter: "{value}%" } : {}),
        },
      },
      yAxis: {
        type: "category",
        name: "Domains / endpoints",
        nameLocation: "end",
        nameRotate: 0,
        nameGap: 80,
        inverse: true,
        nameTextStyle: {
          color: chartTheme.axisName,
          fontWeight: 700,
          fontSize: 12,
          align: "right",
          verticalAlign: "top",
          padding: [42, 0, 0, 0],
        },
        data: categoryKeys,
        axisLine: {
          show: true,
          lineStyle: { color: chartTheme.axisLine },
        },
        axisTick: { show: true },
        axisLabel: {
          color: chartTheme.axisLabel,
          width: 220,
          overflow: "truncate",
          formatter: (value) => displayLabelByBucketKey.get(String(value || "")) || String(value || ""),
        },
      },
      series: [blockedSeries, observedSeries, otherSeries],
    },
    meta: {
      evidenceByBucket,
      bucketKeyByLabel,
      displayLabelByBucketKey,
      fullLabelByBucketKey,
      topBucketSummary: topBucket
        ? {
          bucketKey: topBucket.bucketKey,
          displayLabel: topBucket.displayLabel,
          fullLabel: topBucket.fullLabel,
          seen: Number(topBucket.seenCount || 0),
          blocked: Number(topBucket.blockedCount || 0) + Number(topBucket.blockedApiCount || 0),
          observed: Number(topBucket.observedCount || 0) + Number(topBucket.observedApiCount || 0),
          blockedApi: Number(topBucket.blockedApiCount || 0),
          observedApi: Number(topBucket.observedApiCount || 0),
          api: Number((topBucket.blockedApiCount || 0) + (topBucket.observedApiCount || 0)),
          other: Number(topBucket.otherCount || 0),
        }
        : null,
      lowSignal: ranking.lowSignal,
      densityDefaults: {
        applied: false,
        compactSummary: false,
      },
      stateGuidanceMessage: ranking.stateGuidanceMessage,
    },
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

  const built = buildHorizontalRankedBarOption(rows, {
    seriesName: metric,
    defaultType: "bar",
    maxLabels: Math.max(5, vizOptions.topN),
    axisLabelWidth: 248,
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
    axisLabelRotate: 0,
    axisLabelFormatter: (value) => wrapLabelOnDelimiter(value, ".", 14, 2),
    axisLabelHideOverlap: false,
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
    if (!map.has(d)) {
      map.set(d, {
        label: d,
        value: 0,
        blocked: 0,
        observed: 0,
        evs: [],
      });
    }
    const row = map.get(d);
    row.value += 1;
    if (ev.kind === "network.blocked") row.blocked += 1;
    if (ev.kind === "network.observed") row.observed += 1;
    row.evs.push(ev);
  }

  const rows = Array.from(map.values());
  const domainCount = rows.length;
  const blockedTotal = rows.reduce((sum, row) => sum + Number(row.blocked || 0), 0);
  const observedTotal = rows.reduce((sum, row) => sum + Number(row.observed || 0), 0);
  const shouldUseOutcomeComparison = domainCount >= 2 && blockedTotal >= 3 && observedTotal >= 3;

  if (!shouldUseOutcomeComparison) {
    const built = buildHorizontalRankedBarOption(rows, {
      seriesName: "API-like requests",
      defaultType: "bar",
      maxLabels: Math.max(5, vizOptions.topN),
      axisLabelWidth: 248,
    });

    return {
      option: built.option,
      meta: {
        evidenceByDomain: built.meta.evidenceByLabel,
        comparisonMode: "ranked",
      },
    };
  }

  const ranked = sortRankedRows(rows).slice(0, Math.max(5, vizOptions.topN));
  const labels = ranked.map((row) => row.label);
  const evidenceByDomain = new Map(ranked.map((row) => [row.label, row.evs || []]));
  const statsByDomain = new Map();
  const blockedValues = [];
  const observedValues = [];

  for (const row of ranked) {
    const total = Math.max(1, Number(row.value || 0));
    const blocked = Number(row.blocked || 0);
    const observed = Number(row.observed || 0);
    statsByDomain.set(row.label, { total, blocked, observed });

    if (vizOptions.normalize) {
      blockedValues.push(Number(((blocked * 100) / total).toFixed(2)));
      observedValues.push(Number(((observed * 100) / total).toFixed(2)));
    } else {
      blockedValues.push(blocked);
      observedValues.push(observed);
    }
  }

  const chartTheme = readChartTheme();
  const blockedSeries = buildForcedStackedBarSeries("Blocked", blockedValues, "api-gating");
  const observedSeries = buildForcedStackedBarSeries("Observed", observedValues, "api-gating");
  blockedSeries.barMaxWidth = 28;
  observedSeries.barMaxWidth = 28;

  return {
    option: {
      tooltip: {
        trigger: "axis",
        axisPointer: { type: "shadow" },
        formatter: (params) => {
          const first = Array.isArray(params) ? params[0] : params;
          const label = String(first?.axisValue || first?.name || "");
          const stats = statsByDomain.get(label);
          if (!stats) return "";

          const lines = [`<strong>${label}</strong>`];
          if (vizOptions.normalize) {
            lines.push(`Blocked: ${((stats.blocked * 100) / Math.max(1, stats.total)).toFixed(2)}% (${stats.blocked})`);
            lines.push(`Observed: ${((stats.observed * 100) / Math.max(1, stats.total)).toFixed(2)}% (${stats.observed})`);
          } else {
            lines.push(`Blocked: ${stats.blocked}`);
            lines.push(`Observed: ${stats.observed}`);
          }
          lines.push(`Total API-like requests: ${stats.total}`);
          return lines.join("<br/>");
        },
      },
      legend: {
        top: 0,
        textStyle: { color: chartTheme.legendText },
        itemWidth: 18,
        itemHeight: 10,
        itemGap: 14,
      },
      grid: { left: 24, right: 24, top: 40, bottom: 32, containLabel: true },
      xAxis: {
        type: "value",
        max: vizOptions.normalize ? 100 : null,
        axisLabel: vizOptions.normalize ? { formatter: "{value}%" } : undefined,
      },
      yAxis: {
        type: "category",
        inverse: true,
        data: labels,
        axisLabel: {
          width: 248,
          overflow: "truncate",
          interval: 0,
        },
      },
      series: [blockedSeries, observedSeries],
    },
    meta: {
      evidenceByDomain,
      comparisonMode: "stacked",
    },
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

function buildVendorBlockRateComparisonOption(events, options = {}) {
  const selectedVendor = options?.selectedVendor || null;
  if (selectedVendor?.vendorId) {
    return buildGuidanceOnlyChart(buildComparisonVendorFocusGuidance(selectedVendor));
  }

  const viewMode = String(options?.viewMode || "easy");
  const rows = buildVendorRollup(events)
    .map((row) => {
      const seen = Number(row?.seen || 0);
      const blocked = Number(row?.blocked || 0);
      const rate = seen > 0 ? Number(((blocked * 100) / seen).toFixed(1)) : 0;
      return {
        label: String(row?.vendorName || row?.vendorId || "Unknown vendor"),
        value: rate,
        seen,
        blocked,
        observed: Number(row?.observed || 0),
        evs: Array.isArray(row?.evs) ? row.evs : [],
        vendor: {
          vendorId: row?.vendorId,
          vendorName: row?.vendorName,
          category: row?.category,
          domains: Array.isArray(row?.domains) ? row.domains : [],
          riskHints: Array.isArray(row?.riskHints) ? row.riskHints : [],
        },
      };
    })
    .filter((row) => row.seen > 0);

  rows.sort((a, b) => {
    if (b.value !== a.value) return b.value - a.value;
    if (b.blocked !== a.blocked) return b.blocked - a.blocked;
    return b.seen - a.seen;
  });

  const topRows = rows.slice(0, COMPARISON_TOP_VENDOR_CAP);
  const overflowRows = rows.slice(COMPARISON_TOP_VENDOR_CAP);
  let overflowLabel = "";
  if (overflowRows.length) {
    const otherSeen = overflowRows.reduce((sum, row) => sum + Number(row.seen || 0), 0);
    const otherBlocked = overflowRows.reduce((sum, row) => sum + Number(row.blocked || 0), 0);
    const otherObserved = overflowRows.reduce((sum, row) => sum + Number(row.observed || 0), 0);
    const otherRate = otherSeen > 0 ? Number(((otherBlocked * 100) / otherSeen).toFixed(1)) : 0;
    overflowLabel = `Other (+${overflowRows.length} vendors)`;
    topRows.push({
      label: overflowLabel,
      value: otherRate,
      seen: otherSeen,
      blocked: otherBlocked,
      observed: otherObserved,
      evs: overflowRows.flatMap((row) => row.evs || []),
      vendor: null,
    });
  }

  const labels = topRows.map((row) => row.label);
  const values = topRows.map((row) => row.value);
  const evidenceByLabel = new Map(topRows.map((row) => [row.label, row.evs]));
  const vendorByLabel = new Map(topRows.map((row) => [row.label, row.vendor]));
  const countsByLabel = new Map(topRows.map((row) => [row.label, { seen: row.seen, blocked: row.blocked, observed: row.observed }]));

  let stateGuidanceMessage = "";
  if (topRows.length <= 1) {
    stateGuidanceMessage = "Low-information comparison: only one vendor appears in this scope. Broaden range or clear vendor focus to compare multiple vendors.";
  } else if (topRows.length <= 3 || topRows.reduce((sum, row) => sum + row.seen, 0) <= LOW_SIGNAL_EVENT_THRESHOLD) {
    const modePrefix = viewMode === "easy" ? "Easy mode note: " : "";
    stateGuidanceMessage = `${modePrefix}Low-signal comparison: ${topRows.length} vendors available in this scope. Compare cautiously and broaden range for stronger contrast.`;
  }
  if (overflowLabel) {
    const overflowNote = `Top ${COMPARISON_TOP_VENDOR_CAP} vendors shown; remaining vendors are grouped into "${overflowLabel}".`;
    stateGuidanceMessage = stateGuidanceMessage ? `${stateGuidanceMessage} ${overflowNote}` : overflowNote;
  }

  return {
    option: {
      tooltip: {
        trigger: "item",
        formatter: (params) => {
          const rows = Array.isArray(params) ? params : [params];
          const first = rows[0] || {};
          const byIndexLabel = Number.isFinite(first?.dataIndex) ? labels[first.dataIndex] : "";
          const label = String(first?.name || first?.axisValueLabel || first?.axisValue || byIndexLabel || "");
          const counts = countsByLabel.get(label) || countsByLabel.get(byIndexLabel) || { seen: 0, blocked: 0, observed: 0 };
          const value = Number(first?.value || 0);

          const lines = [
            `<strong>${label}</strong>`,
            `Block rate: ${value.toFixed(1)}%`,
            `Blocked: ${counts.blocked}`,
            `Observed: ${counts.observed}`,
            `Total n: ${counts.seen}`,
          ];
          if (counts.seen < LOW_CONFIDENCE_SAMPLE_THRESHOLD) {
            lines.push("Low confidence: small sample (n < 10).");
          }

          return [
            ...lines,
          ].join("<br/>");
        },
      },
      grid: { left: 170, right: 24, top: 18, bottom: 34 },
      xAxis: {
        type: "value",
        min: 0,
        max: 100,
        axisLabel: { formatter: "{value}%" },
      },
      yAxis: {
        type: "category",
        data: labels,
        inverse: true,
        axisLabel: { width: 160, overflow: "truncate" },
      },
      series: [buildSeries("Block rate (%)", values, { defaultType: "bar" })],
    },
    meta: {
      evidenceByLabel,
      vendorByLabel,
      countsByLabel,
      stateGuidanceMessage,
    },
  };
}

function buildVendorShareOverTimeOption(events, options = {}) {
  const selectedVendor = options?.selectedVendor || null;
  if (selectedVendor?.vendorId) {
    return buildGuidanceOnlyChart(buildComparisonVendorFocusGuidance(selectedVendor));
  }

  const viewMode = String(options?.viewMode || "easy");
  const densityAware = options?.densityAware === true;
  const rows = buildVendorRollup(events)
    .map((row) => ({
      label: String(row?.vendorName || row?.vendorId || "Unknown vendor"),
      seen: Number(row?.seen || 0),
      evs: Array.isArray(row?.evs) ? row.evs : [],
    }))
    .filter((row) => row.seen > 0)
    .sort((a, b) => b.seen - a.seen);

  const topRows = rows.slice(0, COMPARISON_TOP_VENDOR_CAP);
  const overflowRows = rows.slice(COMPARISON_TOP_VENDOR_CAP);
  if (overflowRows.length) {
    topRows.push({
      label: `Other (+${overflowRows.length} vendors)`,
      seen: overflowRows.reduce((sum, row) => sum + Number(row.seen || 0), 0),
      evs: overflowRows.flatMap((row) => row.evs || []),
    });
  }

  const { from, to } = getRangeWindow();
  const list = Array.isArray(events) ? events : [];
  const start = from ?? (list[0]?.ts ?? Date.now());
  const end = to ?? (list[list.length - 1]?.ts ?? Date.now());
  const span = Math.max(1, end - start);
  const baseBinMs = getTimelineBinMs();
  const allowDensityBinOverride = densityAware && String(vizOptions.binSize || "5m") === "5m";
  const allowSeriesSimplification = densityAware && String(vizOptions.seriesType || "auto") === "auto";

  const buildBuckets = (targetBinMs) => {
    const bins = Math.max(1, Math.ceil(Math.max(1, span) / targetBinMs));
    const labels = [];
    const binEvents = new Array(bins).fill(0).map(() => []);

    for (let i = 0; i < bins; i++) {
      labels.push(new Date(start + i * targetBinMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }

    const pointsByLabel = new Map();
    for (const row of topRows) {
      pointsByLabel.set(row.label, new Array(bins).fill(0));
    }

    for (const row of topRows) {
      const points = pointsByLabel.get(row.label);
      for (const ev of row.evs) {
        const ts = Number(ev?.ts);
        if (!Number.isFinite(ts)) continue;
        const idx = Math.min(bins - 1, Math.max(0, Math.floor((ts - start) / targetBinMs)));
        points[idx] += 1;
        binEvents[idx].push(ev);
      }
    }

    return { bins, labels, binEvents, pointsByLabel };
  };

  let effectiveBinMs = baseBinMs;
  let timeline = buildBuckets(effectiveBinMs);
  const initialSignal = assessTimelineSignal({
    totalBins: timeline.bins,
    binEvents: timeline.binEvents,
    totalEvents: list.length,
  });
  let densityBinApplied = false;

  if (allowDensityBinOverride && initialSignal.isLowSignal) {
    const suggestedBinMs = chooseDensityAwareBinMs({
      spanMs: span,
      currentBinMs: baseBinMs,
      totalEvents: list.length,
    });
    if (suggestedBinMs > effectiveBinMs) {
      effectiveBinMs = suggestedBinMs;
      timeline = buildBuckets(effectiveBinMs);
      densityBinApplied = true;
    }
  }

  const finalSignal = assessTimelineSignal({
    totalBins: timeline.bins,
    binEvents: timeline.binEvents,
    totalEvents: list.length,
  });
  const simplifiedSeries = allowSeriesSimplification
    && finalSignal.isLowSignal
    && finalSignal.totalEvents <= LOW_SIGNAL_SIMPLE_SERIES_EVENT_THRESHOLD;
  const focusedWindow = densityAware
    && finalSignal.isLowSignal
    && !!finalSignal.reasons?.includes("mostly-empty-timespan");
  const defaultZoomWindow = focusedWindow
    ? buildLowSignalDataZoomWindow({ totalBins: timeline.bins, binEvents: timeline.binEvents })
    : null;

  const series = [];
  for (const row of topRows) {
    const points = timeline.pointsByLabel.get(row.label) || [];
    const baseSeries = {
      name: row.label,
      stack: "vendor-share",
      data: points,
      emphasis: {
        focus: "none",
        itemStyle: {
          borderColor: hoverPointStyle.borderColor,
          borderWidth: hoverPointStyle.borderWidth,
        },
        lineStyle: { width: 2 },
      },
      select: {
        itemStyle: {
          borderColor: selectedPointStyle.borderColor,
          borderWidth: selectedPointStyle.borderWidth,
        },
      },
    };

    if (simplifiedSeries) {
      series.push({
        ...baseSeries,
        type: "bar",
      });
      continue;
    }

    series.push({
      ...baseSeries,
      type: "line",
      smooth: 0.2,
      symbol: "none",
      areaStyle: { opacity: 0.22 },
    });
  }

  let stateGuidanceMessage = "";
  if (topRows.length <= 1) {
    stateGuidanceMessage = "Low-information comparison: only one vendor appears in this scope. Broaden range to compare share across vendors.";
  } else if (topRows.length <= 3 || list.length <= LOW_SIGNAL_EVENT_THRESHOLD) {
    const modePrefix = viewMode === "easy" ? "Easy mode note: " : "";
    stateGuidanceMessage = `${modePrefix}Low-signal comparison: vendor-share trends may shift with small samples.`;
  }

  return {
    option: {
      tooltip: {
        trigger: "axis",
        formatter: (params) => {
          const rowsForBin = Array.isArray(params) ? params : [];
          if (!rowsForBin.length) return "";
          const label = String(rowsForBin[0]?.axisValueLabel || rowsForBin[0]?.axisValue || "Time bucket");
          const total = rowsForBin.reduce((sum, row) => sum + Number(row?.value || 0), 0);
          const lines = [`<strong>${label}</strong>`, `Total n: ${total}`];
          for (const row of rowsForBin) {
            const value = Number(row?.value || 0);
            const pct = total > 0 ? Number(((value * 100) / total).toFixed(1)) : 0;
            lines.push(`${row?.marker || ""}${row?.seriesName || "Vendor"}: ${value} (${pct}%)`);
          }
          return lines.join("<br/>");
        },
      },
      legend: { top: 0, textStyle: getTrendLegendTextStyle(), itemWidth: 22, itemHeight: 12, itemGap: 14 },
      grid: { left: 40, right: 18, top: 36, bottom: 75 },
      ...buildTrendAxes(timeline.labels),
      toolbox: buildTrendToolbox(),
      dataZoom: [
        {
          type: "inside",
          ...(defaultZoomWindow ? { start: defaultZoomWindow.start, end: defaultZoomWindow.end } : {}),
        },
        {
          type: "slider",
          height: 18,
          bottom: 18,
          ...(defaultZoomWindow ? { start: defaultZoomWindow.start, end: defaultZoomWindow.end } : {}),
        },
      ],
      series,
    },
    meta: {
      start,
      binMs: effectiveBinMs,
      binEvents: timeline.binEvents,
      labels: timeline.labels,
      densityDefaults: {
        applied: densityBinApplied || simplifiedSeries || !!defaultZoomWindow,
        originalBinMs: baseBinMs,
        appliedBinMs: effectiveBinMs,
        simplifiedSeries,
        focusedWindow: !!defaultZoomWindow,
      },
      stateGuidanceMessage,
    },
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

function buildRiskTrendOption(events, options = {}) {
  const viewMode = String(options?.viewMode || "easy");
  const densityAware = options?.densityAware === true;
  const { from, to } = getRangeWindow();
  const start = from ?? (events[0]?.ts ?? Date.now());
  const end = to ?? (events[events.length - 1]?.ts ?? Date.now());
  const span = Math.max(1, end - start);
  const baseBinMs = getTimelineBinMs();
  const allowDensityBinOverride = densityAware && String(vizOptions.binSize || "5m") === "5m";

  const buildBuckets = (targetBinMs) => {
    const bins = Math.max(1, Math.ceil(Math.max(1, span) / targetBinMs));
    const labels = [];
    const high = new Array(bins).fill(0);
    const caution = new Array(bins).fill(0);
    const info = new Array(bins).fill(0);
    const binEvents = new Array(bins).fill(0).map(() => []);

    for (const ev of events) {
      if (!ev?.ts) continue;
      const idx = Math.min(bins - 1, Math.max(0, Math.floor((ev.ts - start) / targetBinMs)));
      binEvents[idx].push(ev);
      const bucket = riskBucketForEvent(ev);
      if (bucket === "high") high[idx] += 1;
      else if (bucket === "caution") caution[idx] += 1;
      else info[idx] += 1;
    }

    for (let i = 0; i < bins; i++) {
      labels.push(new Date(start + i * targetBinMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
    }

    return { bins, labels, high, caution, info, binEvents };
  };

  let effectiveBinMs = baseBinMs;
  let timeline = buildBuckets(effectiveBinMs);
  const initialSignal = assessTimelineSignal({
    totalBins: timeline.bins,
    binEvents: timeline.binEvents,
    totalEvents: Array.isArray(events) ? events.length : 0,
  });
  let densityBinApplied = false;

  if (allowDensityBinOverride && initialSignal.isLowSignal) {
    const suggestedBinMs = chooseDensityAwareBinMs({
      spanMs: span,
      currentBinMs: baseBinMs,
      totalEvents: Array.isArray(events) ? events.length : 0,
    });
    if (suggestedBinMs > effectiveBinMs) {
      effectiveBinMs = suggestedBinMs;
      timeline = buildBuckets(effectiveBinMs);
      densityBinApplied = true;
    }
  }

  const finalSignal = assessTimelineSignal({
    totalBins: timeline.bins,
    binEvents: timeline.binEvents,
    totalEvents: Array.isArray(events) ? events.length : 0,
  });
  const focusedWindow = densityAware
    && finalSignal.isLowSignal
    && !!finalSignal.reasons?.includes("mostly-empty-timespan");
  const defaultZoomWindow = focusedWindow
    ? buildLowSignalDataZoomWindow({ totalBins: timeline.bins, binEvents: timeline.binEvents })
    : null;
  const stateGuidanceMessage = buildTimelineGuidanceMessage({
    signal: finalSignal,
    densityApplied: densityBinApplied,
    originalBinMs: baseBinMs,
    appliedBinMs: effectiveBinMs,
    focusedWindow: !!defaultZoomWindow,
    viewMode,
  });
  const chartTheme = readChartTheme();

  return {
    option: {
      tooltip: { trigger: "axis", formatter: buildTrendTooltipFormatter },
      legend: { top: 0, textStyle: getTrendLegendTextStyle(), itemWidth: 22, itemHeight: 12, itemGap: 14 },
      grid: { left: 40, right: 18, top: 18, bottom: 75 },
      ...buildTrendAxes(timeline.labels),
      dataZoom: [
        {
          type: "inside",
          ...(defaultZoomWindow ? { start: defaultZoomWindow.start, end: defaultZoomWindow.end } : {}),
        },
        {
          type: "slider",
          height: 18,
          bottom: 18,
          ...(defaultZoomWindow ? { start: defaultZoomWindow.start, end: defaultZoomWindow.end } : {}),
        },
      ],
      series: [
        buildSeries("High", timeline.high, { defaultType: "bar", stackKey: "risk" }),
        buildSeries("Caution", timeline.caution, { defaultType: "bar", stackKey: "risk" }),
        buildSeries("Info", timeline.info, { defaultType: "bar", stackKey: "risk" }),
      ],
    },
    meta: {
      start,
      binMs: effectiveBinMs,
      binEvents: timeline.binEvents,
      labels: timeline.labels,
      densityDefaults: {
        applied: densityBinApplied || !!defaultZoomWindow,
        originalBinMs: baseBinMs,
        appliedBinMs: effectiveBinMs,
        simplifiedSeries: false,
        focusedWindow: !!defaultZoomWindow,
      },
      stateGuidanceMessage,
    },
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

  const built = buildHorizontalRankedBarOption(rows, {
    seriesName: "rule hits",
    defaultType: "bar",
    maxLabels: Math.max(5, vizOptions.topN),
    axisLabelWidth: 216,
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
  if (viewId === "vendorShareOverTime") return "No multi-vendor timeline data is available for share-over-time comparison";
  if (viewId === "vendorAllowedBlockedTimeline") return "No blocked/observed network events match current filters";
  if (viewId === "vendorTopDomainsEndpoints") return "No domain/endpoint buckets match current vendor scope";
  if (viewId === "topSeen") return "No third-party network events match current filters";
  if (viewId === "apiGating") return "No third-party API-like requests match current filters";
  if (viewId === "ruleIdFrequency") return "No rule-id data matches current filters";
  if (viewId === "resourceTypes") return "No resource-type data matches current filters";
  if (viewId === "hourHeatmap") return "No heatmap data matches current filters";
  return "No events match current filters";
}

  return {
    buildEmptyChartOption,
    getTimelineBinMs,
    buildTimelineOption,
    buildVendorAllowedBlockedTimelineOption,
    buildVendorTopDomainsEndpointsOption,
    buildVendorEndpointReadoutData,
    buildTopDomainsOption,
    buildKindsOption,
    buildApiGatingOption,
    buildResourceTypesOption,
    buildModeBreakdownOption,
    buildPartySplitOption,
    buildHourHeatmapOption,
    buildVendorOverviewOption,
    buildVendorBlockRateComparisonOption,
    buildVendorShareOverTimeOption,
    buildRiskTrendOption,
    buildVendorKindMatrixOption,
    buildRuleIdFrequencyOption,
    hasSeriesData,
    getModeEmptyMessage,
  };
}
