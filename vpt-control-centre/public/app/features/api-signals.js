// public/app/features/api-signals.js

const filterState = { surfaceDetail: "all", signalType: "all", confidence: "all" };
const viewState = {
  subview: "insights",
  latestEvents: [],
  latestPolicies: { latestTs: 0, items: [] },
  saves: {
    canvas: { pending: false, tone: "", message: "" },
    webrtc: { pending: false, tone: "", message: "" },
  },
};

const PATTERN_PRESENTATION = Object.freeze({
  "api.canvas.readback": {
    label: "Canvas readback",
    explanation: "The page read image or pixel data back from a canvas. Readback can support fingerprinting or verification.",
  },
  "api.canvas.repeated_readback": {
    label: "Repeated canvas readback",
    explanation: "The page read canvas output repeatedly in a short burst. Repetition makes the signal more notable.",
  },
  "api.webrtc.peer_connection_setup": {
    label: "WebRTC peer connection setup",
    explanation: "The page initialized a WebRTC peer connection. This is the starting point for later network-capability probing.",
  },
  "api.webrtc.offer_probe": {
    label: "WebRTC offer probe",
    explanation: "The page started WebRTC offer flow. Creating an offer can be part of browser and device capability probing.",
  },
  "api.webrtc.ice_probe": {
    label: "WebRTC ICE probing",
    explanation: "The page triggered ICE gathering or candidate activity. That can reveal network-path and device characteristics.",
  },
  "api.webrtc.stun_turn_assisted_probe": {
    label: "WebRTC STUN/TURN-assisted probing",
    explanation: "The page combined WebRTC probing with STUN or TURN metadata, which strengthens the capability-probing signal.",
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

const OUTCOME_LABELS = Object.freeze({
  observed: "Observed",
  warned: "Warned",
  blocked: "Blocked",
  trusted_allowed: "Trusted-site allowed",
});

const POLICY_ACTIONS = Object.freeze([
  ["observe", "Observe", "Allow the implemented API calls and record them in Browser API insights."],
  ["warn", "Warn", "Allow the call, but mark it as a warned outcome so it stands out in insights."],
  ["block", "Block", "Prevent the current implemented enforcement point and log a blocked outcome."],
  ["allow_trusted", "Allow on trusted sites", "Allow this surface only on sites you have already trusted. Untrusted sites are blocked."],
]);

const POLICY_SURFACES = Object.freeze([
  {
    key: "canvas",
    title: "Canvas",
    kicker: "Readback gating",
    summary: "Control the implemented Canvas readback points without affecting general drawing.",
    note: "Current Canvas enforcement covers getImageData, toDataURL, toBlob, and readPixels only.",
  },
  {
    key: "webrtc",
    title: "WebRTC",
    kicker: "Peer connection gating",
    summary: "Control the current WebRTC peer connection enforcement point while keeping metadata-only evidence.",
    note: "Current WebRTC enforcement is tied to top-frame RTCPeerConnection creation/setup only.",
  },
]);

let filtersBound = false;
let subviewBound = false;
let controlsBound = false;
let getLatestEventsCb = null;

function utils() {
  return window.VPT?.utils || {};
}

function normalizeOptional(value) {
  return String(value || "").trim();
}

function normalizeValue(value, fallback = "unknown") {
  return normalizeOptional(value) || fallback;
}

function normalizePolicyAction(value) {
  const next = normalizeOptional(value);
  return next === "warn" || next === "block" || next === "allow_trusted" ? next : "observe";
}

function confidenceBand(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "unknown";
  if (value >= 0.9) return "high";
  if (value >= 0.8) return "medium";
  return "lower";
}

function isApiSignalEvent(event) {
  const kind = String(event?.kind || "").toLowerCase();
  const surface = String(event?.enrichment?.surface || "").toLowerCase();
  return surface === "api" || surface === "browser_api" || kind.startsWith("api.") || kind.startsWith("browser_api.");
}

function patternPresentation(event) {
  const patternId = normalizeOptional(event?.enrichment?.patternId);
  const surfaceDetail = normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail);
  if (patternId && PATTERN_PRESENTATION[patternId]) {
    return { ...PATTERN_PRESENTATION[patternId], canonicalId: patternId, classified: true };
  }
  if (patternId) {
    return {
      label: patternId.split(".").filter(Boolean).pop().replaceAll("_", " "),
      explanation: "This row has a canonical backend pattern id, but this UI does not yet have custom explanatory copy for it.",
      canonicalId: patternId,
      classified: true,
    };
  }
  if (surfaceDetail === "canvas") {
    return { label: "Unclassified canvas activity", explanation: "Canvas metadata was observed without a canonical backend pattern yet.", canonicalId: "", classified: false };
  }
  if (surfaceDetail === "webrtc") {
    return { label: "Unclassified WebRTC activity", explanation: "WebRTC metadata was observed without a canonical backend pattern yet.", canonicalId: "", classified: false };
  }
  return { label: "Unclassified API activity", explanation: "API activity was observed without a canonical backend pattern yet.", canonicalId: "", classified: false };
}

function summarizeEvent(event) {
  const data = event?.data || {};
  const surface = normalizeValue(event?.enrichment?.surfaceDetail || data.surfaceDetail);
  if (surface === "canvas") {
    const size = data.width && data.height ? ` | ${data.width}x${data.height}` : "";
    const burst = Number(data.count || 0) > 1 ? ` | ${data.count} calls in one burst` : "";
    return `Observed ${normalizeValue(data.operation, "activity")}${data.contextType ? ` | ${data.contextType} canvas` : ""}${size}${burst}`;
  }
  if (surface === "webrtc") {
    const hostCount = Array.isArray(data.stunTurnHostnames) ? data.stunTurnHostnames.filter(Boolean).length : 0;
    const hostText = hostCount ? ` | ${hostCount} safe STUN/TURN hostname${hostCount === 1 ? "" : "s"}` : "";
    return `Observed ${normalizeValue(data.action, "activity")}${data.state ? ` | ${data.state}` : ""}${hostText}`;
  }
  return `Observed ${normalizeValue(event?.kind, "api.event")}`;
}

function escape(value) {
  return utils().escapeHtml ? utils().escapeHtml(String(value ?? "")) : String(value ?? "");
}

function labelFor(map, value, fallback = "Unknown") {
  const key = normalizeValue(value);
  return map[key] || fallback;
}

function describeActiveFilters() {
  const parts = [];
  if (filterState.surfaceDetail !== "all") parts.push(`Surface: ${labelFor(SURFACE_LABELS, filterState.surfaceDetail)}`);
  if (filterState.signalType !== "all") parts.push(`Signal type: ${labelFor(SIGNAL_TYPE_LABELS, filterState.signalType, filterState.signalType)}`);
  if (filterState.confidence !== "all") parts.push(`Confidence: ${filterState.confidence}`);
  return parts.length ? `Active filters: ${parts.join(" | ")}.` : "";
}

function syncSubview() {
  const insights = document.getElementById("apiSignalsInsightsSubviewPanel");
  const controls = document.getElementById("apiSignalsControlsSubviewPanel");
  const buttons = document.querySelectorAll("[data-api-subview]");
  insights?.classList.toggle("hidden", viewState.subview !== "insights");
  controls?.classList.toggle("hidden", viewState.subview !== "controls");
  buttons.forEach((button) => {
    const active = button.dataset.apiSubview === viewState.subview;
    button.classList.toggle("active", active);
    button.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function syncSelect(selectId, values, labeler, allLabel) {
  const select = document.getElementById(selectId);
  if (!select) return "all";
  const current = String(select.value || "all");
  const options = [`<option value="all">${allLabel}</option>`].concat(
    values.map(([value, count]) => `<option value="${escape(value)}">${escape(labeler(value))} (${count})</option>`)
  );
  select.innerHTML = options.join("");
  select.value = values.some(([value]) => value === current) ? current : "all";
  return select.value;
}

function renderInsights(events) {
  const allEvents = (Array.isArray(events) ? events : []).filter(isApiSignalEvent);
  const surfaceCounts = [...allEvents.reduce((map, event) => map.set(normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail), (map.get(normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail)) || 0) + 1), new Map())].sort();
  const typeCounts = [...allEvents.reduce((map, event) => map.set(normalizeValue(event?.enrichment?.signalType), (map.get(normalizeValue(event?.enrichment?.signalType)) || 0) + 1), new Map())].sort();
  filterState.surfaceDetail = syncSelect("apiSignalsSurfaceFilter", surfaceCounts, (value) => labelFor(SURFACE_LABELS, value, value), "All surfaces");
  filterState.signalType = syncSelect("apiSignalsTypeFilter", typeCounts, (value) => labelFor(SIGNAL_TYPE_LABELS, value, value), "All signal types");

  const filtered = allEvents.filter((event) => {
    const surface = normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail);
    const signalType = normalizeValue(event?.enrichment?.signalType);
    const band = confidenceBand(event?.enrichment?.confidence);
    return (filterState.surfaceDetail === "all" || surface === filterState.surfaceDetail)
      && (filterState.signalType === "all" || signalType === filterState.signalType)
      && (filterState.confidence === "all" || band === filterState.confidence);
  });

  const sites = new Set(filtered.map((event) => normalizeValue(event.site)));
  const patterns = new Set(filtered.map((event) => normalizeOptional(event?.enrichment?.patternId)).filter(Boolean));
  const highConfidence = filtered.filter((event) => confidenceBand(event?.enrichment?.confidence) === "high").length;
  const filterNote = !allEvents.length
    ? "Waiting for Canvas or WebRTC signals from the existing /api/events feed."
    : `Showing ${filtered.length} of ${allEvents.length} API signal${allEvents.length === 1 ? "" : "s"} from the current in-memory dashboard window.${describeActiveFilters() ? ` ${describeActiveFilters()}` : ""}`;

  const resultsMeta = !allEvents.length
    ? "No API signal detections are available in the current poll window yet."
    : !filtered.length
      ? `No current rows match the filters. ${allEvents.length} API signal${allEvents.length === 1 ? "" : "s"} exist in the wider dashboard window.`
      : "Latest first. Each card shows the human-readable signal label first and keeps the canonical backend fields visible as secondary detail.";

  document.getElementById("apiSignalsStatTotal").textContent = String(filtered.length);
  document.getElementById("apiSignalsStatHighConfidence").textContent = String(highConfidence);
  document.getElementById("apiSignalsStatSites").textContent = String(sites.size);
  document.getElementById("apiSignalsStatPatterns").textContent = String(patterns.size);
  document.getElementById("apiSignalsFilterNote").textContent = filterNote;
  document.getElementById("apiSignalsResultsMeta").textContent = resultsMeta;
  document.getElementById("apiSignalsClearFiltersBtn").disabled = filterState.surfaceDetail === "all" && filterState.signalType === "all" && filterState.confidence === "all";

  const topPatterns = document.getElementById("apiSignalsTopPatterns");
  const topSites = document.getElementById("apiSignalsTopSites");
  const topTypes = document.getElementById("apiSignalsTopTypes");
  const emptyText = allEvents.length ? "No matching signals in this filtered view." : "No API signals yet.";
  topPatterns.innerHTML = glanceHtml(topEntries(filtered, (event) => {
    const presentation = patternPresentation(event);
    return { label: presentation.label, detail: presentation.canonicalId || "No canonical pattern id" };
  }), emptyText, true);
  topSites.innerHTML = glanceHtml(topEntries(filtered, (event) => ({ label: normalizeValue(event.site), detail: "" })), emptyText, false);
  topTypes.innerHTML = glanceHtml(topEntries(filtered, (event) => {
    const key = normalizeValue(event?.enrichment?.signalType);
    return { label: labelFor(SIGNAL_TYPE_LABELS, key, key), detail: key };
  }), emptyText, true);

  const empty = document.getElementById("apiSignalsEmptyState");
  const list = document.getElementById("apiSignalsEventsList");
  if (!allEvents.length) {
    empty.classList.remove("hidden");
    empty.innerHTML = emptyStateHtml("No API signals captured in this window", "Browse a site with Canvas or WebRTC activity while capture is enabled, then revisit this page.", "This view reflects the current /api/events dashboard window only.");
    list.innerHTML = "";
    return;
  }
  if (!filtered.length) {
    empty.classList.remove("hidden");
    empty.innerHTML = emptyStateHtml("No signals match the current filters", `The current filters exclude all ${allEvents.length} captured API signal${allEvents.length === 1 ? "" : "s"} in this dashboard window.`, describeActiveFilters() ? `${describeActiveFilters()} Use Clear filters above to inspect the full set again.` : "");
    list.innerHTML = "";
    return;
  }

  empty.classList.add("hidden");
  list.innerHTML = filtered
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0))
    .map((event) => eventCardHtml(event))
    .join("");
}

function topEntries(events, mapper) {
  const counts = new Map();
  events.forEach((event) => {
    const item = mapper(event);
    const key = `${item.label}__${item.detail}`;
    const existing = counts.get(key) || { ...item, count: 0 };
    existing.count += 1;
    counts.set(key, existing);
  });
  return [...counts.values()].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label)).slice(0, 3);
}

function glanceHtml(entries, emptyText, useCode) {
  if (!entries.length) return `<div class="api-signals-glance-empty">${escape(emptyText)}</div>`;
  return entries.map((entry) => `
    <div class="api-signals-glance-item">
      <div class="api-signals-glance-row">
        <div class="api-signals-glance-label">${escape(entry.label)}</div>
        <div class="api-signals-glance-count">${entry.count}</div>
      </div>
      ${entry.detail ? `<div class="api-signals-glance-detail${useCode ? " api-signals-code" : ""}">${escape(entry.detail)}</div>` : ""}
    </div>
  `).join("");
}

function emptyStateHtml(title, body, detail) {
  return `
    <div class="api-signals-empty-title">${escape(title)}</div>
    <p class="api-signals-empty-copy">${escape(body)}</p>
    ${detail ? `<p class="api-signals-empty-detail">${escape(detail)}</p>` : ""}
  `;
}

function eventCardHtml(event) {
  const { friendlyTime } = utils();
  const presentation = patternPresentation(event);
  const surface = normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail);
  const signalType = normalizeValue(event?.enrichment?.signalType);
  const gateOutcome = normalizeValue(event?.data?.gateOutcome, "observed");
  const confidence = event?.enrichment?.confidence;
  const confidenceText = typeof confidence === "number" && !Number.isNaN(confidence) ? `${confidenceBand(confidence)} ${confidence.toFixed(2)}` : "unknown";
  const timeText = typeof friendlyTime === "function" ? friendlyTime(event.ts) : new Date(event.ts || 0).toLocaleString();
  return `
    <article class="api-signals-event-card">
      <div class="api-signals-event-head">
        <div class="api-signals-event-title-wrap">
          <div class="api-signals-event-kicker">${escape(labelFor(SURFACE_LABELS, surface, surface))} signal</div>
          <div class="api-signals-event-title">${escape(presentation.label)}</div>
        </div>
        <div class="api-signals-event-badges">
          <span class="api-signals-confidence ${escape(confidenceBand(confidence))}">${escape(confidenceText)}</span>
          <span class="api-signals-surface-pill ${escape(surface)}">${escape(labelFor(SURFACE_LABELS, surface, surface))}</span>
        </div>
      </div>
      <div class="api-signals-event-meta">
        <span class="api-signals-event-site">${escape(normalizeValue(event.site))}</span>
        <span class="api-signals-type-badge">${escape(labelFor(SIGNAL_TYPE_LABELS, signalType, signalType))}</span>
        <span class="api-signals-outcome-badge ${escape(gateOutcome)}">${escape(labelFor(OUTCOME_LABELS, gateOutcome, gateOutcome))}</span>
        <span class="api-signals-event-time">${escape(timeText || "-")}</span>
      </div>
      <div class="api-signals-event-summary-grid">
        <div class="api-signals-event-block">
          <div class="api-signals-event-block-label">Why it was flagged</div>
          <p class="api-signals-event-block-value">${escape(presentation.explanation)}</p>
        </div>
        <div class="api-signals-event-block">
          <div class="api-signals-event-block-label">Observed details</div>
          <p class="api-signals-event-block-value">${escape(summarizeEvent(event))}</p>
        </div>
      </div>
      <div class="api-signals-secondary-grid">
        <div class="api-signals-secondary-field">
          <div class="api-signals-secondary-label">Canonical pattern</div>
          <div class="api-signals-secondary-value api-signals-code">${escape(presentation.canonicalId || "Not classified")}</div>
        </div>
        <div class="api-signals-secondary-field">
          <div class="api-signals-secondary-label">Backend signal type</div>
          <div class="api-signals-secondary-value api-signals-code">${escape(signalType)}</div>
        </div>
        <div class="api-signals-secondary-field">
          <div class="api-signals-secondary-label">Gate outcome</div>
          <div class="api-signals-secondary-value api-signals-code">${escape(gateOutcome)}</div>
        </div>
        ${presentation.classified ? "" : `
        <div class="api-signals-secondary-field">
          <div class="api-signals-secondary-label">Classification status</div>
          <div class="api-signals-secondary-value">Legacy or unclassified row</div>
        </div>`}
      </div>
    </article>
  `;
}

function derivePolicySnapshot(policiesResponse) {
  const snapshot = { trustedSites: new Set(), surfaces: { canvas: "observe", webrtc: "observe" } };
  const items = Array.isArray(policiesResponse?.items) ? policiesResponse.items : [];
  items.forEach((item) => {
    const op = normalizeOptional(item?.op);
    const payload = item?.payload && typeof item.payload === "object" ? item.payload : {};
    if (op === "trust_site" && payload.site) snapshot.trustedSites.add(String(payload.site));
    if (op === "untrust_site" && payload.site) snapshot.trustedSites.delete(String(payload.site));
    if ((op === "set_api_policy" || op === "set_api_surface_policy") && (payload.surface === "canvas" || payload.surface === "webrtc")) {
      snapshot.surfaces[payload.surface] = normalizePolicyAction(payload.action);
    }
  });
  return snapshot;
}

function renderControls() {
  const root = document.getElementById("apiPolicyCards");
  if (!root) return;
  const snapshot = derivePolicySnapshot(viewState.latestPolicies);
  const trustedNote = document.getElementById("apiPolicyTrustedSitesNote");
  if (trustedNote) {
    trustedNote.textContent = snapshot.trustedSites.size
      ? `Trusted sites currently configured: ${snapshot.trustedSites.size}. "Allow on trusted sites" allows these surfaces there and blocks them elsewhere.`
      : 'Trusted sites currently configured: 0. "Allow on trusted sites" currently behaves like block until you trust at least one site.';
  }
  root.innerHTML = POLICY_SURFACES.map((surface) => controlCardHtml(surface, snapshot.surfaces[surface.key], viewState.saves[surface.key])).join("");
}

function controlCardHtml(surface, currentAction, saveState) {
  const status = saveState.message || (saveState.pending
    ? "Saving policy change through the live backend policy feed..."
    : "Shared actions: Observe, Warn, Block, and Allow on trusted sites.");
  const tone = saveState.tone || (saveState.pending ? "pending" : "");
  return `
    <article class="panel api-policy-card">
      <div class="api-policy-card-header">
        <div class="api-policy-card-title-wrap">
          <div class="api-policy-kicker">${escape(surface.kicker)}</div>
          <div class="api-policy-card-title">${escape(surface.title)}</div>
        </div>
        <span class="api-policy-mode-pill ${escape(currentAction)}">Current mode: ${escape(POLICY_ACTIONS.find(([value]) => value === currentAction)?.[1] || "Observe")}</span>
      </div>
      <p class="api-policy-card-copy">${escape(surface.summary)}</p>
      <fieldset class="api-policy-options" ${saveState.pending ? "disabled" : ""}>
        <div class="api-policy-options-grid">
          ${POLICY_ACTIONS.map(([value, label, description]) => `
            <label class="api-policy-option${currentAction === value ? " selected" : ""}">
              <input type="radio" name="api-policy-${escape(surface.key)}" value="${escape(value)}" data-surface="${escape(surface.key)}" ${currentAction === value ? "checked" : ""} ${saveState.pending ? "disabled" : ""} />
              <div class="api-policy-option-copy">
                <div class="api-policy-option-title">${escape(label)}</div>
                <div class="api-policy-option-text">${escape(description)}</div>
              </div>
            </label>
          `).join("")}
        </div>
      </fieldset>
      <p class="api-policy-surface-note">${escape(surface.note)}</p>
      <div class="api-policy-status${tone ? ` ${escape(tone)}` : ""}">${escape(status)}</div>
    </article>
  `;
}

async function submitSurfacePolicy(surface, action) {
  const api = window.VPT?.api;
  const surfaceKey = surface === "webrtc" ? "webrtc" : "canvas";
  const nextAction = normalizePolicyAction(action);
  viewState.saves[surfaceKey] = { pending: true, tone: "pending", message: `Saving ${nextAction.replace("_", " ")} for ${surfaceKey}...` };
  renderControls();
  try {
    if (!api?.postPolicy) throw new Error("Policy API not available in dashboard context");
    const created = await api.postPolicy("set_api_surface_policy", { surface: surfaceKey, action: nextAction });
    const createdItems = Array.isArray(created) ? created : [created];
    viewState.latestPolicies = {
      latestTs: Math.max(Number(viewState.latestPolicies.latestTs) || 0, ...createdItems.map((item) => Number(item?.ts) || 0)),
      items: (Array.isArray(viewState.latestPolicies.items) ? viewState.latestPolicies.items : []).concat(createdItems.filter(Boolean)),
    };
    viewState.saves[surfaceKey] = { pending: false, tone: "success", message: `Saved. ${labelFor(SURFACE_LABELS, surfaceKey, surfaceKey)} is now set to ${POLICY_ACTIONS.find(([value]) => value === nextAction)?.[1] || "Observe"}.` };
  } catch (error) {
    viewState.saves[surfaceKey] = { pending: false, tone: "error", message: `Could not save ${labelFor(SURFACE_LABELS, surfaceKey, surfaceKey)} policy. ${error?.message || "Try again."}` };
  }
  renderControls();
}

function bindFilters() {
  if (filtersBound) return;
  ["apiSignalsSurfaceFilter", "apiSignalsTypeFilter", "apiSignalsConfidenceFilter"].forEach((id) => {
    document.getElementById(id)?.addEventListener("change", () => {
      filterState.surfaceDetail = String(document.getElementById("apiSignalsSurfaceFilter")?.value || "all");
      filterState.signalType = String(document.getElementById("apiSignalsTypeFilter")?.value || "all");
      filterState.confidence = String(document.getElementById("apiSignalsConfidenceFilter")?.value || "all");
      renderInsights(typeof getLatestEventsCb === "function" ? getLatestEventsCb() || [] : viewState.latestEvents);
    });
  });
  document.getElementById("apiSignalsClearFiltersBtn")?.addEventListener("click", () => {
    filterState.surfaceDetail = "all";
    filterState.signalType = "all";
    filterState.confidence = "all";
    ["apiSignalsSurfaceFilter", "apiSignalsTypeFilter", "apiSignalsConfidenceFilter"].forEach((id) => {
      const element = document.getElementById(id);
      if (element) element.value = "all";
    });
    renderInsights(typeof getLatestEventsCb === "function" ? getLatestEventsCb() || [] : viewState.latestEvents);
  });
  filtersBound = true;
}

function bindSubviewControls() {
  if (subviewBound) return;
  document.querySelectorAll("[data-api-subview]").forEach((button) => {
    button.addEventListener("click", () => {
      viewState.subview = button.dataset.apiSubview === "controls" ? "controls" : "insights";
      syncSubview();
    });
  });
  subviewBound = true;
}

function bindControlEvents() {
  if (controlsBound) return;
  document.getElementById("apiPolicyCards")?.addEventListener("change", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLInputElement) || target.type !== "radio" || !target.checked) return;
    const surface = normalizeOptional(target.dataset.surface).toLowerCase();
    if (surface !== "canvas" && surface !== "webrtc") return;
    submitSurfacePolicy(surface, target.value);
  });
  controlsBound = true;
}

export function renderApiSignalsView(events, options = {}) {
  viewState.latestEvents = Array.isArray(events) ? events : [];
  if (Object.prototype.hasOwnProperty.call(options, "policies")) {
    viewState.latestPolicies = options.policies && typeof options.policies === "object"
      ? { latestTs: Number(options.policies.latestTs) || 0, items: Array.isArray(options.policies.items) ? options.policies.items.slice() : [] }
      : { latestTs: 0, items: [] };
  }
  syncSubview();
  renderInsights(viewState.latestEvents);
  renderControls();
}

export function initApiSignalsFeature({ getLatestEvents } = {}) {
  getLatestEventsCb = typeof getLatestEvents === "function" ? getLatestEvents : null;
  bindFilters();
  bindSubviewControls();
  bindControlEvents();
}

if (typeof window !== "undefined") {
  window.VPT = window.VPT || {};
  window.VPT.features = window.VPT.features || {};
  window.VPT.features.apiSignals = { initApiSignalsFeature, renderApiSignalsView };
}
