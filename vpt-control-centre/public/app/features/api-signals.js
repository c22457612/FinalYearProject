// public/app/features/api-signals.js

const filterState = {
  surfaceDetail: "all",
  signalType: "all",
  confidence: "all",
};

let filtersBound = false;
let getLatestEventsCb = null;

function getUtils() {
  return window.VPT?.utils || {};
}

function getLatestEvents() {
  return typeof getLatestEventsCb === "function" ? (getLatestEventsCb() || []) : [];
}

function isApiSignalEvent(event) {
  if (!event || typeof event !== "object") return false;

  const kind = String(event.kind || "").toLowerCase();
  const surface = String(event.enrichment?.surface || "").toLowerCase();
  return surface === "api" || kind.startsWith("api.") || kind.startsWith("browser_api.");
}

function normalizeValue(value, fallback = "unknown") {
  const text = String(value || "").trim();
  return text || fallback;
}

function confidenceBand(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "unknown";
  if (value >= 0.9) return "high";
  if (value >= 0.8) return "medium";
  return "lower";
}

function confidenceLabel(band) {
  if (band === "high") return "High";
  if (band === "medium") return "Medium";
  if (band === "lower") return "Lower";
  return "Unknown";
}

function titleCaseToken(value) {
  return String(value || "")
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function summarizeCanvasEvent(event) {
  const data = event?.data || {};
  const operation = normalizeValue(data.operation, "activity");
  const context = normalizeValue(data.contextType || data.context || data.renderingContext, "");
  const width = Number(data.width);
  const height = Number(data.height);
  const callCount = Number(data.callCount || data.burstCount || data.count || 0);

  const parts = [`Canvas ${operation}`];
  if (context) parts.push(`${context} context`);
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) {
    parts.push(`${width}x${height}`);
  }
  if (callCount > 1) {
    parts.push(`${callCount} calls in burst`);
  }

  return parts.join(" | ");
}

function summarizeWebrtcEvent(event) {
  const data = event?.data || {};
  const action = normalizeValue(data.action, "activity");
  const gatheringState = normalizeValue(data.iceGatheringState || data.iceState, "");
  const peerState = normalizeValue(data.peerConnectionState || data.connectionState, "");
  const hostnames = Array.isArray(data.stunTurnHostnames) ? data.stunTurnHostnames.filter(Boolean) : [];

  const parts = [`WebRTC ${action}`];
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

  const kind = normalizeValue(event?.kind, "api.event");
  return `API event ${kind}`;
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
  if (!select) return;

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

function renderSummary(allApiEvents, filteredEvents) {
  const sites = new Set(filteredEvents.map((event) => normalizeValue(event.site, "unknown")));
  const patterns = new Set(
    filteredEvents
      .map((event) => normalizeValue(event?.enrichment?.patternId, ""))
      .filter(Boolean)
  );

  setSummaryValue("apiSignalsStatTotal", allApiEvents.length);
  setSummaryValue("apiSignalsStatMatching", filteredEvents.length);
  setSummaryValue("apiSignalsStatSites", sites.size);
  setSummaryValue("apiSignalsStatPatterns", patterns.size);
}

function renderEmptyState(allApiEvents, filteredEvents) {
  const empty = document.getElementById("apiSignalsEmptyState");
  const tableBody = document.getElementById("apiSignalsTableBody");
  if (!empty || !tableBody) return;

  tableBody.innerHTML = "";

  if (!allApiEvents.length) {
    empty.textContent = "No API signal events have been captured in the current Control Centre window yet.";
    empty.classList.remove("hidden");
    return true;
  }

  if (!filteredEvents.length) {
    empty.textContent = "No API signal events match the current filters.";
    empty.classList.remove("hidden");
    return true;
  }

  empty.classList.add("hidden");
  return false;
}

function createCodeCell(text) {
  const span = document.createElement("span");
  span.className = "api-signals-code";
  span.textContent = text || "-";
  return span;
}

function createConfidenceCell(value) {
  const band = confidenceBand(value);
  const span = document.createElement("span");
  span.className = `api-signals-confidence ${band}`;
  if (typeof value === "number" && !Number.isNaN(value)) {
    span.textContent = `${value.toFixed(2)} ${confidenceLabel(band)}`;
  } else {
    span.textContent = "Unknown";
  }
  return span;
}

function createSurfacePill(value) {
  const span = document.createElement("span");
  span.className = `api-signals-surface-pill ${value}`;
  span.textContent = value;
  return span;
}

function renderTable(filteredEvents) {
  const tableBody = document.getElementById("apiSignalsTableBody");
  const { friendlyTime } = getUtils();
  if (!tableBody) return;

  tableBody.innerHTML = "";

  const sorted = filteredEvents
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));

  for (const event of sorted) {
    const row = document.createElement("tr");

    const timeCell = document.createElement("td");
    timeCell.textContent = typeof friendlyTime === "function" ? friendlyTime(event.ts) : "-";
    row.appendChild(timeCell);

    const siteCell = document.createElement("td");
    siteCell.textContent = normalizeValue(event.site, "unknown");
    row.appendChild(siteCell);

    const surfaceDetail = normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail, "unknown");
    const surfaceCell = document.createElement("td");
    surfaceCell.appendChild(createSurfacePill(surfaceDetail));
    row.appendChild(surfaceCell);

    const patternCell = document.createElement("td");
    patternCell.appendChild(createCodeCell(normalizeValue(event?.enrichment?.patternId, "")));
    row.appendChild(patternCell);

    const signalTypeCell = document.createElement("td");
    signalTypeCell.appendChild(createCodeCell(normalizeValue(event?.enrichment?.signalType, "")));
    row.appendChild(signalTypeCell);

    const confidenceCell = document.createElement("td");
    confidenceCell.appendChild(createConfidenceCell(event?.enrichment?.confidence));
    row.appendChild(confidenceCell);

    const detailCell = document.createElement("td");
    detailCell.className = "api-signals-detail";
    detailCell.textContent = summarizeEvent(event);
    row.appendChild(detailCell);

    tableBody.appendChild(row);
  }
}

function updateFilterNote(allApiEvents, filteredEvents) {
  if (!allApiEvents.length) {
    setText("apiSignalsFilterNote", "Waiting for Canvas or WebRTC API events from the existing /api/events feed.");
    return;
  }

  const noteParts = [`Showing ${filteredEvents.length} of ${allApiEvents.length} API signal events`];
  if (filterState.surfaceDetail !== "all" || filterState.signalType !== "all" || filterState.confidence !== "all") {
    noteParts.push("after filters");
  }
  noteParts.push("from the current in-memory dashboard window.");
  setText("apiSignalsFilterNote", noteParts.join(" "));
}

function updateResultsMeta(allApiEvents, filteredEvents) {
  if (!allApiEvents.length) {
    setText("apiSignalsResultsMeta", "No API signal detections are available in the current poll window yet.");
    return;
  }

  const surfaces = Array.from(new Set(
    allApiEvents.map((event) => normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail, "unknown"))
  )).sort((a, b) => a.localeCompare(b));

  const surfaceSummary = surfaces.map((surface) => titleCaseToken(surface)).join(", ");
  if (!filteredEvents.length) {
    setText("apiSignalsResultsMeta", `Captured API surfaces: ${surfaceSummary}. No rows match the current filters.`);
    return;
  }

  setText(
    "apiSignalsResultsMeta",
    `Captured API surfaces: ${surfaceSummary}. Backend enrichment fields shown here come directly from /api/events.`
  );
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

  const nextSurfaceValue = syncSelectOptions("apiSignalsSurfaceFilter", surfaceCounts, titleCaseToken);
  const nextSignalTypeValue = syncSelectOptions("apiSignalsTypeFilter", signalTypeCounts, titleCaseToken);

  filterState.surfaceDetail = nextSurfaceValue || "all";
  filterState.signalType = nextSignalTypeValue || "all";
}

export function renderApiSignalsView(events) {
  const allApiEvents = (Array.isArray(events) ? events : []).filter(isApiSignalEvent);
  syncFilters(allApiEvents);

  const filteredEvents = allApiEvents.filter(passesFilters);

  renderSummary(allApiEvents, filteredEvents);
  updateFilterNote(allApiEvents, filteredEvents);
  updateResultsMeta(allApiEvents, filteredEvents);

  if (renderEmptyState(allApiEvents, filteredEvents)) return;
  renderTable(filteredEvents);
}

function rerenderFromState() {
  renderApiSignalsView(getLatestEvents());
}

function bindFilter(selectId, key) {
  const select = document.getElementById(selectId);
  if (!select) return;

  select.addEventListener("change", () => {
    filterState[key] = String(select.value || "all");
    rerenderFromState();
  });
}

export function initApiSignalsFeature({ getLatestEvents: nextGetLatestEvents } = {}) {
  getLatestEventsCb = typeof nextGetLatestEvents === "function" ? nextGetLatestEvents : null;
  if (filtersBound) return;

  bindFilter("apiSignalsSurfaceFilter", "surfaceDetail");
  bindFilter("apiSignalsTypeFilter", "signalType");
  bindFilter("apiSignalsConfidenceFilter", "confidence");

  filtersBound = true;
}

window.VPT = window.VPT || {};
window.VPT.features = window.VPT.features || {};
window.VPT.features.apiSignals = { initApiSignalsFeature, renderApiSignalsView };
