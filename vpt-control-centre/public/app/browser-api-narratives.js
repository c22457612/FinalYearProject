function normalizeToken(value) {
  return String(value || "").trim().toLowerCase();
}

function capitalizeFirst(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return `${text[0].toUpperCase()}${text.slice(1)}`;
}

function formatList(items) {
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  if (!list.length) return "";
  if (list.length === 1) return list[0];
  if (list.length === 2) return `${list[0]} and ${list[1]}`;
  return `${list.slice(0, -1).join(", ")}, and ${list[list.length - 1]}`;
}

function getMeaningMeta(key) {
  if (key === "fingerprinting") {
    return {
      order: 1,
      topLevel: "fingerprinting",
      why: "Fingerprinting-related API activity can help distinguish your browser or device over time.",
      action: "Review Canvas in Browser API Controls and warn or block it on sites that do not need it.",
    };
  }
  if (key === "probing") {
    return {
      order: 2,
      topLevel: "probing",
      why: "WebRTC probing can reveal network or device characteristics that help profile the browsing environment.",
      action: "Review WebRTC in Browser API Controls if the site does not clearly need calling or peer-connection features.",
    };
  }
  if (key === "location_access") {
    return {
      order: 3,
      topLevel: "sensitive_access",
      why: "Location requests can expose where you are if permission is granted.",
      action: "Only allow Geolocation when the page clearly needs it, and review Browser API Controls for that surface.",
    };
  }
  if (key === "clipboard_access") {
    return {
      order: 4,
      topLevel: "sensitive_access",
      why: "Clipboard access can expose copied content or page interaction state if permission is granted.",
      action: "Only allow Clipboard access when you expect copy/paste features on the page, and review Browser API Controls if needed.",
    };
  }
  return null;
}

function getTopLevelPhrase(key) {
  if (key === "fingerprinting") return "fingerprinting-related";
  if (key === "probing") return "network/device probing";
  if (key === "sensitive_access") return "sensitive-access";
  return "";
}

function getEntryKey(entry) {
  return normalizeToken(
    (entry && entry.key)
    || (entry && entry.enrichment && entry.enrichment.patternId)
    || ""
  );
}

function getEntrySurfaceDetail(entry) {
  return normalizeToken(
    (entry && entry.surfaceDetail)
    || (entry && entry.enrichment && entry.enrichment.surfaceDetail)
    || (entry && entry.data && entry.data.surfaceDetail)
    || ""
  );
}

function getSignalLabel(entry) {
  const key = getEntryKey(entry);
  if (key === "api.canvas.readback") return "Canvas readback";
  if (key === "api.canvas.repeated_readback") return "Repeated canvas readback";
  if (key === "api.webrtc.peer_connection_setup") return "WebRTC connection setup";
  if (key === "api.webrtc.offer_probe") return "WebRTC offer probing";
  if (key === "api.webrtc.ice_probe") return "WebRTC network probing";
  if (key === "api.webrtc.stun_turn_assisted_probe") return "WebRTC STUN/TURN probing";
  if (key === "api.geolocation.current_position_request" || key === "api.geolocation.watch_request" || key === "geolocation") {
    return "Location access";
  }
  if (
    key === "api.clipboard.async_read"
    || key === "api.clipboard.async_read_text"
    || key === "api.clipboard.async_write"
    || key === "api.clipboard.async_write_text"
    || key === "clipboard.read"
    || key === "clipboard.write"
  ) {
    return "Clipboard access";
  }
  const surfaceDetail = getEntrySurfaceDetail(entry);
  if (surfaceDetail === "canvas") return "Canvas activity";
  if (surfaceDetail === "webrtc") return "WebRTC activity";
  if (surfaceDetail === "geolocation") return "Location access";
  if (surfaceDetail === "clipboard") return "Clipboard access";
  return "Browser API activity";
}

function getMeaningKey(entry) {
  const key = getEntryKey(entry);
  const surfaceDetail = getEntrySurfaceDetail(entry);

  if (key === "api.canvas.readback" || key === "api.canvas.repeated_readback" || surfaceDetail === "canvas") {
    return "fingerprinting";
  }
  if (
    key === "api.webrtc.peer_connection_setup"
    || key === "api.webrtc.offer_probe"
    || key === "api.webrtc.ice_probe"
    || key === "api.webrtc.stun_turn_assisted_probe"
    || surfaceDetail === "webrtc"
  ) {
    return "probing";
  }
  if (key === "api.geolocation.current_position_request" || key === "api.geolocation.watch_request" || key === "geolocation" || surfaceDetail === "geolocation") {
    return "location_access";
  }
  if (
    key === "api.clipboard.async_read"
    || key === "api.clipboard.async_read_text"
    || key === "api.clipboard.async_write"
    || key === "api.clipboard.async_write_text"
    || key === "clipboard.read"
    || key === "clipboard.write"
    || surfaceDetail === "clipboard"
  ) {
    return "clipboard_access";
  }
  return "";
}

function getOutcomeCounts(entry) {
  const groupCounts = entry && typeof entry.counts === "object" ? entry.counts : {};
  const mitigationStatus = normalizeToken(entry && entry.enrichment && entry.enrichment.mitigationStatus);
  const gateOutcome = normalizeToken(entry && entry.data && entry.data.gateOutcome);
  const rawObserved = gateOutcome === "observed" || gateOutcome === "warned" || mitigationStatus === "observed_only" || mitigationStatus === "allowed";
  const rawBlocked = gateOutcome === "blocked" || mitigationStatus === "blocked";
  const rawTrustedAllowed = gateOutcome === "trusted_allowed";
  const observed = Number(entry && entry.observedCount) || Number(groupCounts.observed_warned) || 0;
  const blocked = Number(entry && entry.blockedCount) || Number(groupCounts.blocked) || 0;
  const trustedAllowed = Number(entry && entry.trustedAllowedCount) || Number(groupCounts.trusted_allowed) || 0;
  if (observed || blocked || trustedAllowed) {
    return {
      observed,
      blocked,
      trustedAllowed,
      total: Number(entry && entry.totalCount) || Number(entry && entry.count) || observed + blocked + trustedAllowed,
    };
  }
  return {
    observed: rawObserved ? 1 : 0,
    blocked: rawBlocked ? 1 : 0,
    trustedAllowed: rawTrustedAllowed ? 1 : 0,
    total: 1,
  };
}

function buildNarrativeModel(entries) {
  const safeEntries = Array.isArray(entries) ? entries : [];
  const meanings = new Map();
  const signalLabels = [];
  const counts = {
    total: 0,
    observed: 0,
    blocked: 0,
    trustedAllowed: 0,
  };

  for (const entry of safeEntries) {
    const meaningKey = getMeaningKey(entry);
    const meta = getMeaningMeta(meaningKey);
    if (!meaningKey || !meta) continue;

    const label = getSignalLabel(entry);
    const outcomeCounts = getOutcomeCounts(entry);

    counts.total += outcomeCounts.total;
    counts.observed += outcomeCounts.observed;
    counts.blocked += outcomeCounts.blocked;
    counts.trustedAllowed += outcomeCounts.trustedAllowed;

    if (!meanings.has(meaningKey)) {
      meanings.set(meaningKey, {
        key: meaningKey,
        ...meta,
      });
    }

    if (!signalLabels.includes(label)) {
      signalLabels.push(label);
    }
  }

  const orderedMeanings = Array.from(meanings.values()).sort((a, b) => a.order - b.order);
  const topLevels = [];
  for (const meaning of orderedMeanings) {
    if (!topLevels.includes(meaning.topLevel)) topLevels.push(meaning.topLevel);
  }

  return {
    meanings: orderedMeanings,
    topLevels,
    signalLabels: signalLabels.slice(0, 4),
    counts,
  };
}

function buildConcern(meta) {
  const meaningKeys = meta.meanings.map((meaning) => meaning.key);

  let score = 0;
  if (meaningKeys.includes("fingerprinting")) score += 2;
  if (meaningKeys.includes("probing")) score += 2;
  if (meaningKeys.includes("location_access")) score += 3;
  if (meaningKeys.includes("clipboard_access")) score += 2;
  if (meta.topLevels.length >= 2) score += 1;
  if (meaningKeys.length >= 3) score += 1;
  if (meta.counts.blocked > 0 && meta.counts.observed === 0 && meta.counts.trustedAllowed === 0) score -= 1;

  if (score >= 7) return { level: "high", label: "High concern" };
  if (score >= 5) return { level: "notable", label: "Notable concern" };
  if (score >= 3) return { level: "moderate", label: "Moderate concern" };
  return { level: "low", label: "Low concern" };
}

function buildDetailLine(meta, subject) {
  const detailBits = [];
  if (meta.signalLabels.length) {
    detailBits.push(`${capitalizeFirst(subject)} includes ${formatList(meta.signalLabels)}.`);
  }
  if (meta.counts.blocked > 0) {
    detailBits.push(`${meta.counts.blocked} blocked.`);
  }
  if (meta.counts.trustedAllowed > 0) {
    detailBits.push(`${meta.counts.trustedAllowed} allowed on a trusted site.`);
  }
  return detailBits.join(" ");
}

function buildActions(meta) {
  const actions = [
    {
      text: "Review Browser API Controls",
      href: "/?view=api-signals",
    },
  ];

  for (const meaning of meta.meanings) {
    actions.push({ text: meaning.action });
  }

  if (meta.counts.trustedAllowed > 0) {
    actions.push({
      text: "Review Trusted Sites if this activity was allowed because the site is trusted.",
      href: "/?view=trusted-sites",
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const action of actions) {
    const key = `${action.href || ""}|${action.text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(action);
  }
  return deduped.slice(0, 4);
}

function buildWhyItems(meta) {
  return meta.meanings.map((meaning) => meaning.why);
}

function buildCombinedHeadline(subject, topLevels) {
  const phrases = topLevels.map((key) => getTopLevelPhrase(key)).filter(Boolean);
  if (!phrases.length) return "";
  if (phrases.length === 1) {
    return `${capitalizeFirst(subject)} shows ${phrases[0]} Browser API activity.`;
  }
  return `${capitalizeFirst(subject)} combines ${formatList(phrases)} Browser API activity.`;
}

export function buildSiteBrowserApiNarrative(entries, opts = {}) {
  const meta = buildNarrativeModel(entries);
  if (!meta.meanings.length) return null;

  const subject = String(opts.subject || "").trim() || "this site";
  const meaningKeys = meta.meanings.map((meaning) => meaning.key);
  let headline = "";

  if (meaningKeys.length === 1 && meaningKeys[0] === "location_access") {
    headline = `${capitalizeFirst(subject)} attempted to access location-related browser capabilities.`;
  } else if (meaningKeys.length === 1 && meaningKeys[0] === "clipboard_access") {
    headline = `${capitalizeFirst(subject)} attempted to access clipboard-related browser capabilities.`;
  } else if (meaningKeys.length === 2 && meaningKeys.includes("location_access") && meaningKeys.includes("clipboard_access")) {
    headline = `${capitalizeFirst(subject)} attempted to access sensitive browser capabilities.`;
  } else {
    headline = buildCombinedHeadline(subject, meta.topLevels);
  }

  return {
    headline,
    detail: buildDetailLine(meta, subject),
    concern: buildConcern(meta),
    whyItMatters: buildWhyItems(meta),
    actions: buildActions(meta),
    topLevels: meta.topLevels,
    meanings: meaningKeys,
    counts: meta.counts,
  };
}

export function buildVendorBrowserApiNarrative(entries, opts = {}) {
  const meta = buildNarrativeModel(entries);
  if (!meta.meanings.length) return null;

  const section = normalizeToken(opts && opts.section) === "contextual" ? "contextual" : "vendor";
  let headline = "";
  const phrases = meta.topLevels.map((key) => getTopLevelPhrase(key)).filter(Boolean);

  if (section === "vendor") {
    if (meta.meanings.length === 1 && meta.meanings[0].key === "probing") {
      headline = "This vendor may be using WebRTC activity to infer network or device characteristics.";
    } else if (meta.meanings.length === 1 && meta.meanings[0].key === "fingerprinting") {
      headline = "This vendor may be using Browser API activity to help infer browser or device characteristics.";
    } else if (meta.meanings.length === 1 && meta.meanings[0].key === "location_access") {
      headline = "This vendor may be associated with location-related browser capability access.";
    } else if (meta.meanings.length === 1 && meta.meanings[0].key === "clipboard_access") {
      headline = "This vendor may be associated with clipboard-related browser capability access.";
    } else {
      headline = `This vendor may be associated with ${formatList(phrases)} Browser API activity.`;
    }
  } else if (meta.topLevels.length === 1 && meta.topLevels[0] === "sensitive_access") {
    headline = "This site also showed sensitive-access Browser API activity not directly attributable to this vendor.";
  } else {
    headline = `This site also showed ${formatList(phrases)} Browser API activity not directly attributable to this vendor.`;
  }

  return {
    headline,
    detail: section === "vendor"
      ? buildDetailLine(meta, "this vendor activity")
      : buildDetailLine(meta, "this site activity"),
    concern: buildConcern(meta),
    whyItMatters: buildWhyItems(meta),
    actions: buildActions(meta),
    topLevels: meta.topLevels,
    meanings: meta.meanings.map((meaning) => meaning.key),
    counts: meta.counts,
  };
}
