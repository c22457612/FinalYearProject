const PATTERN_PRESENTATION = Object.freeze({
  "api.canvas.readback": {
    label: "Canvas readback",
    explanation: "The page read image or pixel data back from a canvas. Readback can support fingerprinting or verification.",
  },
  "api.canvas.repeated_readback": {
    label: "Repeated canvas readback",
    explanation: "The page read canvas output repeatedly in a short burst. Repetition makes the signal more notable.",
  },
  "api.clipboard.async_read_text": {
    label: "Clipboard text read",
    explanation: "The page asked to read plain text from the async Clipboard API. Clipboard reads can expose copied user data, so this is treated as a high-sensitivity signal.",
  },
  "api.clipboard.async_read": {
    label: "Clipboard item read",
    explanation: "The page asked to read Clipboard items through the async Clipboard API. VPT records only method-level metadata, not clipboard contents.",
  },
  "api.clipboard.async_write_text": {
    label: "Clipboard text write",
    explanation: "The page asked to write plain text to the async Clipboard API. This first wave records the write attempt without storing the text.",
  },
  "api.clipboard.async_write": {
    label: "Clipboard item write",
    explanation: "The page asked to write Clipboard items through the async Clipboard API. Only item-count and MIME-type metadata are recorded where available.",
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
  "api.geolocation.current_position_request": {
    label: "Geolocation current-position request",
    explanation: "The page requested one current position reading through the browser geolocation API.",
  },
  "api.geolocation.watch_request": {
    label: "Geolocation watch request",
    explanation: "The page requested ongoing geolocation updates through the browser geolocation API.",
  },
});

const SIGNAL_TYPE_LABELS = Object.freeze({
  fingerprinting_signal: "Fingerprinting signal",
  tracking_signal: "Tracking signal",
  device_probe: "Device probe",
  capability_probe: "Capability probe",
  state_change: "State change",
  unknown: "Unknown signal type",
});

const SURFACE_LABELS = Object.freeze({
  canvas: "Canvas",
  clipboard: "Clipboard",
  geolocation: "Geolocation",
  webrtc: "WebRTC",
  unknown: "Unknown surface",
});

const OUTCOME_LABELS = Object.freeze({
  observed: "Observed",
  warned: "Warned",
  blocked: "Blocked",
  trusted_allowed: "Trusted-site allowed",
  unknown: "Unknown outcome",
});

function normalizeOptional(value) {
  return String(value || "").trim();
}

function normalizeValue(value, fallback = "unknown") {
  return normalizeOptional(value) || fallback;
}

export function isApiSignalEvent(event) {
  const kind = String(event?.kind || "").toLowerCase();
  const surface = String(event?.enrichment?.surface || "").toLowerCase();
  return surface === "api" || surface === "browser_api" || kind.startsWith("api.") || kind.startsWith("browser_api.");
}

export function getApiConfidenceBand(value) {
  if (typeof value !== "number" || Number.isNaN(value)) return "unknown";
  if (value >= 0.9) return "high";
  if (value >= 0.8) return "medium";
  return "lower";
}

export function getApiSurfaceLabel(value) {
  const key = normalizeValue(value);
  return SURFACE_LABELS[key] || key;
}

export function getApiSignalTypeLabel(value) {
  const key = normalizeValue(value);
  return SIGNAL_TYPE_LABELS[key] || key;
}

export function getApiOutcomeLabel(value) {
  const key = normalizeValue(value);
  return OUTCOME_LABELS[key] || key;
}

export function summarizeApiEvent(event) {
  const data = event?.data || {};
  const surface = normalizeValue(event?.enrichment?.surfaceDetail || data.surfaceDetail);
  if (surface === "canvas") {
    const size = data.width && data.height ? ` | ${data.width}x${data.height}` : "";
    const burst = Number(data.count || 0) > 1 ? ` | ${data.count} calls in one burst` : "";
    return `Observed ${normalizeValue(data.operation, "activity")}${data.contextType ? ` | ${data.contextType} canvas` : ""}${size}${burst}`;
  }
  if (surface === "clipboard") {
    const access = data.accessType ? ` | ${data.accessType}` : "";
    const items = typeof data.itemCount === "number" ? ` | ${data.itemCount} item${data.itemCount === 1 ? "" : "s"}` : "";
    const mimeTypes = Array.isArray(data.mimeTypes) && data.mimeTypes.length ? ` | ${data.mimeTypes.join(", ")}` : "";
    return `Observed ${normalizeValue(data.method, "clipboard access")}${access}${items}${mimeTypes}`;
  }
  if (surface === "geolocation") {
    const accuracy = data.requestedHighAccuracy === true ? " | high accuracy requested" : "";
    const timeout = typeof data.timeoutMs === "number" ? ` | timeout ${data.timeoutMs}ms` : "";
    const maximumAge = typeof data.maximumAgeMs === "number" ? ` | maximum age ${data.maximumAgeMs}ms` : "";
    return `Observed ${normalizeValue(data.method, "request")}${accuracy}${timeout}${maximumAge}`;
  }
  if (surface === "webrtc") {
    const hostCount = Array.isArray(data.stunTurnHostnames) ? data.stunTurnHostnames.filter(Boolean).length : 0;
    const hostText = hostCount ? ` | ${hostCount} safe STUN/TURN hostname${hostCount === 1 ? "" : "s"}` : "";
    return `Observed ${normalizeValue(data.action, "activity")}${data.state ? ` | ${data.state}` : ""}${hostText}`;
  }
  return `Observed ${normalizeValue(event?.kind, "api.event")}`;
}

export function getApiEventPresentation(event) {
  const patternId = normalizeOptional(event?.enrichment?.patternId);
  const surfaceDetail = normalizeValue(event?.enrichment?.surfaceDetail || event?.data?.surfaceDetail);
  let label = "Unclassified API activity";
  let explanation = "API activity was observed without a canonical backend pattern yet.";
  let canonicalId = "";
  let classified = false;

  if (patternId && PATTERN_PRESENTATION[patternId]) {
    label = PATTERN_PRESENTATION[patternId].label;
    explanation = PATTERN_PRESENTATION[patternId].explanation;
    canonicalId = patternId;
    classified = true;
  } else if (patternId) {
    label = patternId.split(".").filter(Boolean).pop().replaceAll("_", " ");
    explanation = "This row has a canonical backend pattern id, but this UI does not yet have custom explanatory copy for it.";
    canonicalId = patternId;
    classified = true;
  } else if (surfaceDetail === "canvas") {
    label = "Unclassified canvas activity";
    explanation = "Canvas metadata was observed without a canonical backend pattern yet.";
  } else if (surfaceDetail === "clipboard") {
    label = "Unclassified clipboard activity";
    explanation = "Clipboard metadata was observed without a canonical backend pattern yet.";
  } else if (surfaceDetail === "geolocation") {
    label = "Unclassified geolocation activity";
    explanation = "Geolocation metadata was observed without a canonical backend pattern yet.";
  } else if (surfaceDetail === "webrtc") {
    label = "Unclassified WebRTC activity";
    explanation = "WebRTC metadata was observed without a canonical backend pattern yet.";
  }

  const signalType = normalizeValue(event?.enrichment?.signalType);
  const confidence = event?.enrichment?.confidence;
  const confidenceBand = getApiConfidenceBand(confidence);
  const gateOutcome = normalizeValue(event?.data?.gateOutcome, "observed");

  return {
    label,
    explanation,
    canonicalId,
    classified,
    surfaceDetail,
    surfaceLabel: getApiSurfaceLabel(surfaceDetail),
    signalType,
    signalTypeLabel: getApiSignalTypeLabel(signalType),
    confidence,
    confidenceBand,
    confidenceText: typeof confidence === "number" && !Number.isNaN(confidence)
      ? `${confidenceBand} ${confidence.toFixed(2)}`
      : "unknown",
    gateOutcome,
    gateOutcomeLabel: getApiOutcomeLabel(gateOutcome),
    summary: summarizeApiEvent(event),
  };
}
