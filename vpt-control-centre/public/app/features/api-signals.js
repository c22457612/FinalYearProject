// public/app/features/api-signals.js

const filterState = {
  surfaceDetail: "all",
  signalType: "all",
  confidence: "all",
};

const PATTERN_PRESENTATION = Object.freeze({
  "api.canvas.readback": {
    label: "Canvas readback",
    explanation:
      "The page read image or pixel data back from a canvas. That matters because readback can be used to inspect rendered output for fingerprinting or verification.",
  },
  "api.canvas.repeated_readback": {
    label: "Repeated canvas readback",
    explanation:
      "The page read canvas output repeatedly in a short burst. Repetition makes this signal more notable than a one-off read.",
  },
  "api.webrtc.peer_connection_setup": {
    label: "WebRTC peer connection setup",
    explanation:
      "The page initialized a WebRTC peer connection. Setup alone is not proof of fingerprinting, but it is the starting point for later network-capability probing.",
  },
  "api.webrtc.offer_probe": {
    label: "WebRTC offer probe",
    explanation:
      "The page started WebRTC offer flow. Creating an offer can be part of probing browser and device communication capabilities.",
  },
  "api.webrtc.ice_probe": {
    label: "WebRTC ICE probing",
    explanation:
      "The page triggered ICE gathering or candidate activity. ICE probing can reveal network-path and device characteristics even when no visible call starts.",
  },
  "api.webrtc.stun_turn_assisted_probe": {
    label: "WebRTC STUN/TURN-assisted probing",
    explanation:
      "The page combined WebRTC probing with STUN or TURN infrastructure metadata. That strengthens the indication that it was actively probing network capabilities.",
  },
});

const SIGNAL_TYPE_LABELS = Object.freeze({
  fingerprinting_signal: "Fingerprinting signal",
  device_probe: "Device probe",
  capability_probe: "Capability probe",
  unknown: "Unknown signal type",
});

const SURFACE_LABELS = Object.freeze({
  canvas: "Canvas",
  webrtc: "WebRTC",
  unknown: "Unknown surface",
});

let filtersBound = false;
let getLatestEventsCb = null;

function getUtils() {
  return window.VPT?.utils || {};
}

function getLatestEvents() {
  return typeof getLatestEventsCb === "function" ? getLatestEventsCb() || [] : [];
}

function isApiSignalEvent(event) {
  if (!event || typeof event !== "object") return false;

  const kind = String(event.kind || "").toLowerCase();
  const surface = String(event.enrichment?.surface || "").toLowerCase();
  return (
    surface === "api" ||
    surface === "browser_api" ||
    kind.startsWith("api.") ||
    kind.startsWith("browser_api.")
  );
}

function normalizeOptional(value) {
  return String(value || "").trim();
}

function normalizeValue(value, fallback = "unknown") {
  const text = normalizeOptional(value);
  return text || fallback;
}

function confidenceBand(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "unknown";
  if (value >= 0.9) return "high";
  if (value >= 0.8) return "medium";
  return "lower";
}

function confidenceLabel(band) {
  if (band === "high") return "High confidence";
  if (band === "medium") return "Medium confidence";
  if (band === "lower") return "Lower confidence";
  return "Unknown confidence";
}

function titleCaseToken(value) {
  return String(value || "")
    .split(/[_\s.-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function labelForSurface(value) {
  const key = normalizeValue(value, "unknown");
  return SURFACE_LABELS[key] || titleCaseToken(key);
}

function labelForSignalType(value) {
  const key = normalizeValue(value, "unknown");
  return SIGNAL_TYPE_LABELS[key] || titleCaseToken(key);
}

function friendlyPatternFallback(patternId) {
  const lastToken = normalizeOptional(patternId).split(".").filter(Boolean).pop();
  return lastToken ? titleCaseToken(lastToken) : "Unclassified API activity";
}

function getPatternPresentation(event) {
  const patternId = normalizeOptional(event?.enrichment?.patternId);
  const surfaceDetail = normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail, "unknown");

  if (patternId && PATTERN_PRESENTATION[patternId]) {
    return {
      label: PATTERN_PRESENTATION[patternId].label,
      explanation: PATTERN_PRESENTATION[patternId].explanation,
      canonicalId: patternId,
      classified: true,
    };
  }

  if (patternId) {
    return {
      label: friendlyPatternFallback(patternId),
      explanation:
        "This row has a canonical backend pattern id, but this UI does not yet have custom explanatory copy for it.",
      canonicalId: patternId,
      classified: true,
    };
  }

  if (surfaceDetail === "canvas") {
    return {
      label: "Unclassified canvas activity",
      explanation:
        "Canvas API metadata was observed, but this row does not currently have a canonical backend pattern classification.",
      canonicalId: "",
      classified: false,
    };
  }

  if (surfaceDetail === "webrtc") {
    return {
      label: "Unclassified WebRTC activity",
      explanation:
        "WebRTC metadata was observed, but this row does not currently have a canonical backend pattern classification.",
      canonicalId: "",
      classified: false,
    };
  }

  return {
    label: "Unclassified API activity",
    explanation:
      "API activity was observed, but this row does not currently have a canonical backend pattern classification.",
    canonicalId: "",
    classified: false,
  };
}

function summarizeCanvasEvent(event) {
  const data = event?.data || {};
  const operation = normalizeValue(data.operation, "activity");
  const context = normalizeOptional(data.contextType || data.context || data.renderingContext);
  const width = Number(data.width);
  const height = Number(data.height);
  const callCount = Number(data.callCount || data.burstCount || data.count || 0);

  const parts = [`Observed ${operation}`];
  if (context) parts.push(`${context} canvas`);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    parts.push(`${width}x${height}`);
  }
  if (callCount > 1) {
    parts.push(`${callCount} calls in one burst`);
  }

  return parts.join(" | ");
}

function summarizeWebrtcEvent(event) {
  const data = event?.data || {};
  const action = normalizeValue(data.action, "activity");
  const gatheringState = normalizeOptional(data.iceGatheringState || data.iceState);
  const peerState = normalizeOptional(data.peerConnectionState || data.connectionState);
  const hostnames = Array.isArray(data.stunTurnHostnames)
    ? data.stunTurnHostnames.filter(Boolean)
    : [];

  const parts = [`Observed ${action}`];
  if (gatheringState) parts.push(`ICE ${gatheringState}`);
  if (peerState) parts.push(`peer ${peerState}`);
  if (hostnames.length) {
    parts.push(`${hostnames.length} safe STUN/TURN hostname${hostnames.length === 1 ? "" : "s"}`);
  }

  return parts.join(" | ");
}

function summarizeEvent(event) {
  const surfaceDetail = normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail, "api");

  if (surfaceDetail === "canvas") return summarizeCanvasEvent(event);
  if (surfaceDetail === "webrtc") return summarizeWebrtcEvent(event);

  return `Observed ${normalizeValue(event?.kind, "api.event")}`;
}

function buildOptionMap(events, selector) {
  const counts = new Map();
  for (const event of events) {
    const key = selector(event);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  return counts;
}

function syncSelectOptions(selectId, counts, labelForValue) {
  const select = document.getElementById(selectId);
  if (!select) return "all";

  const currentValue = String(select.value || "all");
  const nextValues = Array.from(counts.keys()).sort((a, b) => a.localeCompare(b));
  const hasCurrent = currentValue === "all" || nextValues.includes(currentValue);

  const options = [];
  if (selectId === "apiSignalsSurfaceFilter") {
    options.push({ value: "all", label: "All surfaces" });
  } else if (selectId === "apiSignalsTypeFilter") {
    options.push({ value: "all", label: "All signal types" });
  }

  for (const value of nextValues) {
    const count = counts.get(value) || 0;
    options.push({ value, label: `${labelForValue(value)} (${count})` });
  }

  select.innerHTML = "";
  for (const option of options) {
    const node = document.createElement("option");
    node.value = option.value;
    node.textContent = option.label;
    select.appendChild(node);
  }

  const nextValue = hasCurrent ? currentValue : "all";
  select.value = nextValue;
  return nextValue;
}

function passesFilters(event) {
  const surfaceDetail = normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail, "unknown");
  const signalType = normalizeValue(event?.enrichment?.signalType, "unknown");
  const band = confidenceBand(event?.enrichment?.confidence);

  if (filterState.surfaceDetail !== "all" && surfaceDetail !== filterState.surfaceDetail) return false;
  if (filterState.signalType !== "all" && signalType !== filterState.signalType) return false;
  if (filterState.confidence !== "all" && band !== filterState.confidence) return false;
  return true;
}

function setSummaryValue(id, value) {
  const element = document.getElementById(id);
  if (element) element.textContent = String(value);
}

function setText(id, text) {
  const element = document.getElementById(id);
  if (element) element.textContent = text;
}

function filtersAreActive() {
  return (
    filterState.surfaceDetail !== "all" ||
    filterState.signalType !== "all" ||
    filterState.confidence !== "all"
  );
}

function syncClearFiltersState() {
  const button = document.getElementById("apiSignalsClearFiltersBtn");
  if (button) button.disabled = !filtersAreActive();
}

function resetFilters() {
  filterState.surfaceDetail = "all";
  filterState.signalType = "all";
  filterState.confidence = "all";

  const surfaceSelect = document.getElementById("apiSignalsSurfaceFilter");
  const typeSelect = document.getElementById("apiSignalsTypeFilter");
  const confidenceSelect = document.getElementById("apiSignalsConfidenceFilter");

  if (surfaceSelect) surfaceSelect.value = "all";
  if (typeSelect) typeSelect.value = "all";
  if (confidenceSelect) confidenceSelect.value = "all";

  syncClearFiltersState();
  rerenderFromState();
}

function renderSummary(filteredEvents) {
  const sites = new Set(filteredEvents.map((event) => normalizeValue(event.site, "unknown")));
  const patterns = new Set(
    filteredEvents
      .map((event) => normalizeOptional(event?.enrichment?.patternId))
      .filter(Boolean)
  );
  const highConfidence = filteredEvents.filter(
    (event) => confidenceBand(event?.enrichment?.confidence) === "high"
  ).length;

  setSummaryValue("apiSignalsStatTotal", filteredEvents.length);
  setSummaryValue("apiSignalsStatHighConfidence", highConfidence);
  setSummaryValue("apiSignalsStatSites", sites.size);
  setSummaryValue("apiSignalsStatPatterns", patterns.size);
}

function createEmptyState(title, body, detail) {
  const wrapper = document.createElement("div");

  const titleNode = document.createElement("div");
  titleNode.className = "api-signals-empty-title";
  titleNode.textContent = title;
  wrapper.appendChild(titleNode);

  const bodyNode = document.createElement("p");
  bodyNode.className = "api-signals-empty-copy";
  bodyNode.textContent = body;
  wrapper.appendChild(bodyNode);

  if (detail) {
    const detailNode = document.createElement("p");
    detailNode.className = "api-signals-empty-detail";
    detailNode.textContent = detail;
    wrapper.appendChild(detailNode);
  }

  return wrapper;
}

function renderEmptyState(allApiEvents, filteredEvents) {
  const empty = document.getElementById("apiSignalsEmptyState");
  const eventsList = document.getElementById("apiSignalsEventsList");
  if (!empty || !eventsList) return false;

  empty.innerHTML = "";
  eventsList.innerHTML = "";

  if (!allApiEvents.length) {
    empty.appendChild(
      createEmptyState(
        "No API signals captured in this window",
        "Browse a site with Canvas or WebRTC activity while capture is enabled, then revisit this page.",
        "This view reflects the current /api/events dashboard window only."
      )
    );
    empty.classList.remove("hidden");
    return true;
  }

  if (!filteredEvents.length) {
    const filterSummary = describeActiveFilters();
    empty.appendChild(
      createEmptyState(
        "No signals match the current filters",
        `The current filters exclude all ${allApiEvents.length} captured API signal${allApiEvents.length === 1 ? "" : "s"} in this dashboard window.`,
        filterSummary ? `${filterSummary} Use Clear filters above to inspect the full set again.` : ""
      )
    );
    empty.classList.remove("hidden");
    return true;
  }

  empty.classList.add("hidden");
  return false;
}

function createCodeCell(text) {
  const span = document.createElement("span");
  span.className = "api-signals-code";
  span.textContent = text || "Not classified";
  return span;
}

function createConfidenceBadge(value) {
  const band = confidenceBand(value);
  const span = document.createElement("span");
  span.className = `api-signals-confidence ${band}`;
  if (typeof value === "number" && !Number.isNaN(value)) {
    span.textContent = `${confidenceLabel(band)} ${value.toFixed(2)}`;
  } else {
    span.textContent = "Unknown confidence";
  }
  return span;
}

function createSurfacePill(value) {
  const key = normalizeValue(value, "unknown");
  const span = document.createElement("span");
  span.className = `api-signals-surface-pill ${key}`;
  span.textContent = labelForSurface(key);
  return span;
}

function createTypeBadge(value) {
  const span = document.createElement("span");
  span.className = "api-signals-type-badge";
  span.textContent = labelForSignalType(value);
  return span;
}

function createDetailBlock(label, value) {
  const block = document.createElement("div");
  block.className = "api-signals-event-block";

  const labelNode = document.createElement("div");
  labelNode.className = "api-signals-event-block-label";
  labelNode.textContent = label;
  block.appendChild(labelNode);

  const valueNode = document.createElement("p");
  valueNode.className = "api-signals-event-block-value";
  valueNode.textContent = value;
  block.appendChild(valueNode);

  return block;
}

function createSecondaryField(label, valueNode) {
  const field = document.createElement("div");
  field.className = "api-signals-secondary-field";

  const labelNode = document.createElement("div");
  labelNode.className = "api-signals-secondary-label";
  labelNode.textContent = label;
  field.appendChild(labelNode);

  if (typeof valueNode === "string") {
    const valueText = document.createElement("div");
    valueText.className = "api-signals-secondary-value";
    valueText.textContent = valueNode;
    field.appendChild(valueText);
  } else if (valueNode) {
    valueNode.classList.add("api-signals-secondary-value");
    field.appendChild(valueNode);
  }

  return field;
}

function formatEventTime(ts, friendlyTime) {
  if (typeof friendlyTime === "function") {
    const friendly = friendlyTime(ts);
    if (friendly && friendly !== "-") return friendly;
  }
  if (!ts) return "-";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function renderEvents(filteredEvents) {
  const eventsList = document.getElementById("apiSignalsEventsList");
  const { friendlyTime } = getUtils();
  if (!eventsList) return;

  eventsList.innerHTML = "";

  const sorted = filteredEvents.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));

  for (const event of sorted) {
    const presentation = getPatternPresentation(event);
    const surfaceDetail = normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail, "unknown");
    const signalType = normalizeValue(event?.enrichment?.signalType, "unknown");
    const site = normalizeValue(event.site, "unknown");

    const card = document.createElement("article");
    card.className = "api-signals-event-card";

    const head = document.createElement("div");
    head.className = "api-signals-event-head";

    const titleWrap = document.createElement("div");
    titleWrap.className = "api-signals-event-title-wrap";

    const kicker = document.createElement("div");
    kicker.className = "api-signals-event-kicker";
    kicker.textContent = `${labelForSurface(surfaceDetail)} signal`;
    titleWrap.appendChild(kicker);

    const title = document.createElement("div");
    title.className = "api-signals-event-title";
    title.textContent = presentation.label;
    titleWrap.appendChild(title);

    head.appendChild(titleWrap);

    const badges = document.createElement("div");
    badges.className = "api-signals-event-badges";
    badges.appendChild(createConfidenceBadge(event?.enrichment?.confidence));
    badges.appendChild(createSurfacePill(surfaceDetail));
    head.appendChild(badges);

    card.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "api-signals-event-meta";

    const siteNode = document.createElement("span");
    siteNode.className = "api-signals-event-site";
    siteNode.textContent = site;
    meta.appendChild(siteNode);

    meta.appendChild(createTypeBadge(signalType));

    const timeNode = document.createElement("span");
    timeNode.className = "api-signals-event-time";
    timeNode.textContent = formatEventTime(event.ts, friendlyTime);
    meta.appendChild(timeNode);

    card.appendChild(meta);

    const summaryGrid = document.createElement("div");
    summaryGrid.className = "api-signals-event-summary-grid";
    summaryGrid.appendChild(createDetailBlock("Why it was flagged", presentation.explanation));
    summaryGrid.appendChild(createDetailBlock("Observed details", summarizeEvent(event)));
    card.appendChild(summaryGrid);

    const secondaryGrid = document.createElement("div");
    secondaryGrid.className = "api-signals-secondary-grid";
    secondaryGrid.appendChild(createSecondaryField("Canonical pattern", createCodeCell(presentation.canonicalId)));
    secondaryGrid.appendChild(
      createSecondaryField("Backend signal type", createCodeCell(normalizeOptional(event?.enrichment?.signalType) || "unknown"))
    );

    if (!presentation.classified) {
      secondaryGrid.appendChild(createSecondaryField("Classification status", "Legacy or unclassified row"));
    }

    card.appendChild(secondaryGrid);
    eventsList.appendChild(card);
  }
}

function describeActiveFilters() {
  const labels = [];

  if (filterState.surfaceDetail !== "all") {
    labels.push(`Surface: ${labelForSurface(filterState.surfaceDetail)}`);
  }
  if (filterState.signalType !== "all") {
    labels.push(`Signal type: ${labelForSignalType(filterState.signalType)}`);
  }
  if (filterState.confidence !== "all") {
    labels.push(`Confidence: ${confidenceLabel(filterState.confidence)}`);
  }

  return labels.length ? `Active filters: ${labels.join(" | ")}.` : "";
}

function updateFilterNote(allApiEvents, filteredEvents) {
  if (!allApiEvents.length) {
    setText("apiSignalsFilterNote", "Waiting for Canvas or WebRTC signals from the existing /api/events feed.");
    return;
  }

  const base = `Showing ${filteredEvents.length} of ${allApiEvents.length} API signal${allApiEvents.length === 1 ? "" : "s"} from the current in-memory dashboard window.`;
  const filterSummary = describeActiveFilters();
  setText("apiSignalsFilterNote", filterSummary ? `${base} ${filterSummary}` : base);
}

function updateResultsMeta(allApiEvents, filteredEvents) {
  if (!allApiEvents.length) {
    setText("apiSignalsResultsMeta", "No API signal detections are available in the current poll window yet.");
    return;
  }

  if (!filteredEvents.length) {
    setText(
      "apiSignalsResultsMeta",
      `No current rows match the filters. ${allApiEvents.length} API signal${allApiEvents.length === 1 ? "" : "s"} exist in the wider dashboard window.`
    );
    return;
  }

  setText(
    "apiSignalsResultsMeta",
    "Latest first. Each card shows the human-readable signal label first and keeps the canonical backend fields visible as secondary detail."
  );
}

function sortEntries(entries) {
  return entries.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
}

function buildTopPatternEntries(events) {
  const counts = new Map();

  for (const event of events) {
    const presentation = getPatternPresentation(event);
    const key = presentation.canonicalId || `unclassified:${presentation.label}`;
    if (!counts.has(key)) {
      counts.set(key, {
        label: presentation.label,
        detail: presentation.canonicalId || "No canonical pattern id",
        count: 0,
      });
    }
    counts.get(key).count += 1;
  }

  return sortEntries(Array.from(counts.values())).slice(0, 3);
}

function buildTopSiteEntries(events) {
  const counts = new Map();

  for (const event of events) {
    const key = normalizeValue(event.site, "unknown");
    if (!counts.has(key)) {
      counts.set(key, { label: key, detail: "", count: 0 });
    }
    counts.get(key).count += 1;
  }

  return sortEntries(Array.from(counts.values())).slice(0, 3);
}

function buildTopSignalTypeEntries(events) {
  const counts = new Map();

  for (const event of events) {
    const key = normalizeValue(event?.enrichment?.signalType, "unknown");
    if (!counts.has(key)) {
      counts.set(key, {
        label: labelForSignalType(key),
        detail: key,
        count: 0,
      });
    }
    counts.get(key).count += 1;
  }

  return sortEntries(Array.from(counts.values())).slice(0, 3);
}

function renderGlanceList(id, entries, emptyText, useCodeDetail = false) {
  const root = document.getElementById(id);
  if (!root) return;

  root.innerHTML = "";

  if (!entries.length) {
    const empty = document.createElement("div");
    empty.className = "api-signals-glance-empty";
    empty.textContent = emptyText;
    root.appendChild(empty);
    return;
  }

  for (const entry of entries) {
    const item = document.createElement("div");
    item.className = "api-signals-glance-item";

    const topRow = document.createElement("div");
    topRow.className = "api-signals-glance-row";

    const label = document.createElement("div");
    label.className = "api-signals-glance-label";
    label.textContent = entry.label;
    topRow.appendChild(label);

    const count = document.createElement("div");
    count.className = "api-signals-glance-count";
    count.textContent = String(entry.count);
    topRow.appendChild(count);

    item.appendChild(topRow);

    if (entry.detail) {
      const detail = useCodeDetail ? createCodeCell(entry.detail) : document.createElement("div");
      if (useCodeDetail) {
        detail.classList.add("api-signals-glance-detail");
      } else {
        detail.className = "api-signals-glance-detail";
        detail.textContent = entry.detail;
      }
      item.appendChild(detail);
    }

    root.appendChild(item);
  }
}

function renderAtAGlance(filteredEvents, allApiEvents) {
  const emptyText = allApiEvents.length
    ? "No matching signals in this filtered view."
    : "No API signals yet.";

  renderGlanceList("apiSignalsTopPatterns", buildTopPatternEntries(filteredEvents), emptyText, true);
  renderGlanceList("apiSignalsTopSites", buildTopSiteEntries(filteredEvents), emptyText, false);
  renderGlanceList("apiSignalsTopTypes", buildTopSignalTypeEntries(filteredEvents), emptyText, true);
}

function syncFilters(allApiEvents) {
  const surfaceCounts = buildOptionMap(
    allApiEvents,
    (event) => normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail, "unknown")
  );
  const signalTypeCounts = buildOptionMap(
    allApiEvents,
    (event) => normalizeValue(event?.enrichment?.signalType, "unknown")
  );

  const nextSurfaceValue = syncSelectOptions("apiSignalsSurfaceFilter", surfaceCounts, labelForSurface);
  const nextSignalTypeValue = syncSelectOptions("apiSignalsTypeFilter", signalTypeCounts, labelForSignalType);

  filterState.surfaceDetail = nextSurfaceValue || "all";
  filterState.signalType = nextSignalTypeValue || "all";
}

export function renderApiSignalsView(events) {
  const allApiEvents = (Array.isArray(events) ? events : []).filter(isApiSignalEvent);
  syncFilters(allApiEvents);

  const filteredEvents = allApiEvents.filter(passesFilters);

  renderSummary(filteredEvents);
  renderAtAGlance(filteredEvents, allApiEvents);
  updateFilterNote(allApiEvents, filteredEvents);
  updateResultsMeta(allApiEvents, filteredEvents);
  syncClearFiltersState();

  if (renderEmptyState(allApiEvents, filteredEvents)) return;
  renderEvents(filteredEvents);
}

function rerenderFromState() {
  renderApiSignalsView(getLatestEvents());
}

function bindFilter(selectId, key) {
  const select = document.getElementById(selectId);
  if (!select) return;

  select.addEventListener("change", () => {
    filterState[key] = String(select.value || "all");
    syncClearFiltersState();
    rerenderFromState();
  });
}

export function initApiSignalsFeature({ getLatestEvents: nextGetLatestEvents } = {}) {
  getLatestEventsCb = typeof nextGetLatestEvents === "function" ? nextGetLatestEvents : null;
  if (filtersBound) return;

  bindFilter("apiSignalsSurfaceFilter", "surfaceDetail");
  bindFilter("apiSignalsTypeFilter", "signalType");
  bindFilter("apiSignalsConfidenceFilter", "confidence");

  const clearButton = document.getElementById("apiSignalsClearFiltersBtn");
  if (clearButton) {
    clearButton.addEventListener("click", resetFilters);
  }

  filtersBound = true;
}

window.VPT = window.VPT || {};
window.VPT.features = window.VPT.features || {};
window.VPT.features.apiSignals = { initApiSignalsFeature, renderApiSignalsView };
