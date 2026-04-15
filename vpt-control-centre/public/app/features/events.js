let selectedEventId = null;
let onSelectEventCb = null;
let getTrustedSitesCb = null;
let lastRenderedEvents = [];
let lastRenderMeta = {};
let rawJsonOpenEventId = null;

function ensureCoreUtils() {
  const utils = window.VPT?.utils;
  if (!utils) {
    console.error("[events] VPT.utils missing (did app/core.js load first?)");
    return null;
  }
  return utils;
}

function formatMinuteBucket(ts) {
  if (!ts) return "--:--";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function formatReceiptTime(ts) {
  if (!ts) return "--:--:--";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "--:--:--";
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatExactTimestamp(ts) {
  if (!ts) return "-";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function minuteBucketKey(ts) {
  const numericTs = Number(ts) || 0;
  return String(Math.floor(numericTs / 60000) * 60000);
}

function receiptKindTone(kind = "") {
  if (kind === "network.blocked") return "blocked";
  if (kind === "network.observed") return "observed";
  if (String(kind).startsWith("cookies.")) return "cookie";
  if (String(kind).startsWith("api.")) return "api";
  if (kind === "preview.summary") return "preview";
  return "other";
}

function truncateText(value, max = 120) {
  const text = String(value || "").trim();
  if (!text) return "(no details)";
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function humanizeToken(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactFactValue(value, max = 48) {
  if (value == null) return "";
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return truncateText(humanizeToken(value), max);
}

function firstNonEmptyValue(...values) {
  return values.find((value) => value !== undefined && value !== null && String(value).trim() !== "");
}

function pushFact(facts, label, value, max = 48) {
  const formatted = compactFactValue(value, max);
  if (!formatted) return;
  facts.push({ label, value: formatted });
}

function buildGroupedEvents(events) {
  const groups = [];
  const groupByKey = new Map();

  events.forEach((event) => {
    const key = minuteBucketKey(event?.ts);
    let group = groupByKey.get(key);
    if (!group) {
      group = {
        key,
        bucketTs: Number(key),
        items: [],
      };
      groupByKey.set(key, group);
      groups.push(group);
    }
    group.items.push(event);
  });

  return groups;
}

function updateEventTools(ev, trustedSites = new Set()) {
  const actions = document.getElementById("details-actions");
  const trustBtn = document.getElementById("trust-site-btn");
  if (!actions || !trustBtn) return;

  const canTrustSite = !!ev?.site;
  actions.style.display = canTrustSite ? "flex" : "none";
  trustBtn.disabled = !canTrustSite;

  if (!canTrustSite) {
    trustBtn.textContent = "Trust this site (send to extension)";
    return;
  }

  if (trustedSites.has(ev.site)) {
    trustBtn.textContent = `Stop trusting ${ev.site}`;
    return;
  }

  trustBtn.textContent = `Trust ${ev.site} (send to extension)`;
}

function rerenderCurrentFeed() {
  if (!lastRenderedEvents.length) return;
  renderEvents(lastRenderedEvents, lastRenderMeta);
}

function buildDrawerFacts(ev, trustedSites) {
  const data = ev.data || {};
  const facts = [];
  const status = ev.site && trustedSites.has(ev.site) ? "trusted" : "protected";

  pushFact(facts, "Mode", ev.mode, 22);
  pushFact(facts, "Status", status, 22);
  pushFact(facts, "Surface", firstNonEmptyValue(data.surfaceDetail, data.surface), 28);
  pushFact(facts, "Action", firstNonEmptyValue(data.action, data.operation, data.patternId), 34);
  pushFact(facts, "State", firstNonEmptyValue(data.state, data.gateOutcome, data.privacyStatus, data.mitigationStatus), 28);
  pushFact(facts, "Domain", data.domain, 34);
  pushFact(facts, "Resource", data.resourceType, 24);

  if (typeof data.isThirdParty === "boolean") {
    pushFact(facts, "Party", data.isThirdParty ? "Third-party" : "First-party", 18);
  }
  if (typeof data.count === "number") {
    pushFact(facts, "Count", data.count, 12);
  }

  return facts;
}

function renderDrawerHtml(ev, trustedSites, utils) {
  const { escapeHtml } = utils;
  const summary = summarizeEvent(ev);
  const facts = buildDrawerFacts(ev, trustedSites);
  const tone = receiptKindTone(ev?.kind);

  return `
    <div class="receipt-event-drawer-head">
      <div class="receipt-event-drawer-primary">
        <span class="receipt-event-drawer-site">${escapeHtml(ev.site || "unknown")}</span>
        <span class="receipt-event-drawer-dot">·</span>
        <span class="receipt-event-drawer-time">${escapeHtml(formatExactTimestamp(ev.ts))}</span>
      </div>
      <span class="pill pill-kind receipt-kind-pill ${tone}">${escapeHtml(ev.kind || "event")}</span>
    </div>
    ${facts.length ? `<div class="receipt-event-drawer-meta">${escapeHtml(facts.join(" | "))}</div>` : ""}
    <div class="receipt-event-drawer-summary">${escapeHtml(summary)}</div>
    <details class="receipt-event-drawer-raw">
      <summary>Raw event JSON</summary>
      <pre>${escapeHtml(JSON.stringify(ev, null, 2))}</pre>
    </details>
  `;
}

function renderCompactDrawerHtml(ev, trustedSites, utils) {
  const { escapeHtml } = utils;
  const summary = summarizeEvent(ev);
  const facts = buildDrawerFacts(ev, trustedSites);
  const tone = receiptKindTone(ev?.kind);
  const rawJsonOpen = ev?.id && rawJsonOpenEventId === ev.id;
  const factsHtml = facts.length
    ? `
      <section class="receipt-event-drawer-section receipt-event-drawer-section-facts" aria-label="Event readouts">
        <div class="receipt-event-drawer-section-label">Event readouts</div>
        <div class="receipt-event-drawer-facts">
          ${facts.map((fact) => `
            <span class="receipt-event-drawer-fact">
              <span class="receipt-event-drawer-fact-label">${escapeHtml(fact.label)}</span>
              <span class="receipt-event-drawer-fact-value">${escapeHtml(fact.value)}</span>
            </span>
          `).join("")}
        </div>
      </section>
    `
    : "";

  return `
    <div class="receipt-event-drawer-head">
      <div class="receipt-event-drawer-primary">
        <span class="receipt-event-drawer-kicker">Selected event</span>
        <div class="receipt-event-drawer-title-line">
          <span class="receipt-event-drawer-site">${escapeHtml(ev.site || "unknown")}</span>
          <span class="receipt-event-drawer-dot">&middot;</span>
          <span class="receipt-event-drawer-time">${escapeHtml(formatExactTimestamp(ev.ts))}</span>
        </div>
      </div>
      <span class="pill pill-kind receipt-kind-pill ${tone}">${escapeHtml(ev.kind || "event")}</span>
    </div>
    <section class="receipt-event-drawer-section receipt-event-drawer-summary-panel" aria-label="Event summary">
      <div class="receipt-event-drawer-section-label">Event summary</div>
      <div class="receipt-event-drawer-summary">${escapeHtml(summary)}</div>
    </section>
    ${factsHtml}
    <details class="receipt-event-drawer-raw"${rawJsonOpen ? " open" : ""}>
      <summary>
        <span class="receipt-event-drawer-raw-label">Raw event JSON</span>
        <span class="receipt-event-drawer-raw-state">${rawJsonOpen ? "Hide raw payload" : "Show raw payload"}</span>
      </summary>
      <pre>${escapeHtml(JSON.stringify(ev, null, 2))}</pre>
    </details>
  `;
}

function handleRowSelection(ev) {
  const trusted = getTrustedSitesCb ? (getTrustedSitesCb() || new Set()) : new Set();
  const nextEvent = selectedEventId === ev?.id ? null : ev;
  renderEventDetails(nextEvent, { trustedSites: trusted });
  onSelectEventCb?.(nextEvent);
}

export function initEventsFeature({ onSelectEvent, getTrustedSites } = {}) {
  onSelectEventCb = typeof onSelectEvent === "function" ? onSelectEvent : null;
  getTrustedSitesCb = typeof getTrustedSites === "function" ? getTrustedSites : null;
}

export function summarizeEvent(ev) {
  const kind = ev.kind || "event";
  const d = ev.data || {};

  if (kind === "network.blocked") {
    const domain = d.domain || "tracker";
    const party = d.isThirdParty ? "third-party" : "first-party";
    return `${party} request to ${domain} blocked`;
  }
  if (kind === "network.observed") {
    const domain = d.domain || "third-party";
    return `preview saw request to ${domain}`;
  }
  if (kind === "preview.summary") {
    const total = d.total || 0;
    const domains = Array.isArray(d.domains) ? d.domains.slice(0, 3).join(", ") : "";
    return `preview found ${total} third-party domain(s)${domains ? ` (${domains})` : ""}`;
  }
  if (kind === "cookies.snapshot") {
    const site = ev.site || d.siteBase || "this site";
    const count = d.count != null ? d.count : (Array.isArray(d.cookies) ? d.cookies.length : 0);
    const third = d.thirdPartyCount != null ? d.thirdPartyCount : 0;
    const first = count - third;

    if (!count) return `Cookie snapshot: no cookies found for ${site}`;

    const parts = [`${count} cookie${count === 1 ? "" : "s"}`];
    if (first >= 0 && third >= 0) parts.push(`${first} first-party`, `${third} third-party`);
    return `Cookie snapshot for ${site}: ${parts.join(" | ")}`;
  }

  if (kind === "cookies.cleared") {
    const site = ev.site || d.siteBase || "this site";
    const cleared = d.cleared != null ? d.cleared : 0;
    const total = d.total != null ? d.total : (cleared || 0);
    if (!cleared && !total) return `No cookies were cleared for ${site}`;
    if (total && cleared !== total) return `Cleared ${cleared} of ${total} cookies for ${site}`;
    const count = cleared || total;
    return `Cleared ${count} cookie${count === 1 ? "" : "s"} for ${site}`;
  }

  if (String(kind).startsWith("api.")) {
    const highlights = [
      compactFactValue(firstNonEmptyValue(d.surfaceDetail, d.surface), 26),
      compactFactValue(firstNonEmptyValue(d.action, d.operation, d.patternId, d.signalType), 40),
      compactFactValue(firstNonEmptyValue(d.state, d.gateOutcome, d.privacyStatus, d.mitigationStatus), 24),
    ].filter(Boolean);

    if (typeof d.count === "number") {
      highlights.push(`${d.count} sample${d.count === 1 ? "" : "s"}`);
    }

    if (!highlights.length) return "Technical API activity recorded";
    return truncateText(highlights.join(" | "), 140);
  }

  const genericHighlights = [
    compactFactValue(firstNonEmptyValue(d.domain, d.surfaceDetail, d.surface), 26),
    compactFactValue(firstNonEmptyValue(d.action, d.operation, d.state), 34),
    compactFactValue(firstNonEmptyValue(d.resourceType, d.patternId), 24),
  ].filter(Boolean);

  if (genericHighlights.length) {
    return truncateText(genericHighlights.join(" | "), 120);
  }

  return "Technical event recorded";
}

export function renderEventDetails(ev, { trustedSites = new Set() } = {}) {
  const previousId = selectedEventId;
  const trustedSetChanged = lastRenderMeta.trustedSites !== trustedSites;
  selectedEventId = ev?.id || null;
  if (previousId !== selectedEventId) {
    rawJsonOpenEventId = null;
  }
  lastRenderMeta = { ...lastRenderMeta, trustedSites };
  updateEventTools(ev, trustedSites);

  if (previousId !== selectedEventId || (selectedEventId && trustedSetChanged)) {
    rerenderCurrentFeed();
  }
}

export function renderEvents(events, meta = {}) {
  const utils = ensureCoreUtils();
  if (!utils) return;

  const { modeClass, escapeHtml } = utils;

  const feed = document.getElementById("receiptFeed");
  const subtitle = document.getElementById("receiptSubtitle");
  if (!feed || !subtitle) return;

  lastRenderedEvents = Array.isArray(events) ? events.slice() : [];
  lastRenderMeta = { ...meta };

  feed.innerHTML = "";

  const sorted = (Array.isArray(events) ? events : [])
    .slice()
    .sort((a, b) => (Number(b?.ts) || 0) - (Number(a?.ts) || 0));

  if (!sorted.length) {
    subtitle.textContent = "No events received yet. Browse a site with trackers to see activity.";
    feed.innerHTML = '<div class="receipt-empty">No receipt entries yet.</div>';
    return;
  }

  subtitle.textContent = meta.historyMode === "older"
    ? "Grouped by minute from a frozen older receipt window."
    : "Grouped by minute from the current live receipt window.";

  const trustedSites = meta.trustedSites instanceof Set ? meta.trustedSites : (getTrustedSitesCb ? (getTrustedSitesCb() || new Set()) : new Set());
  const groups = buildGroupedEvents(sorted);

  groups.forEach((group) => {
    const section = document.createElement("section");
    section.className = "receipt-minute-group";

    const header = document.createElement("div");
    header.className = "receipt-minute-header";
    header.innerHTML = `
      <span class="receipt-minute-label">${escapeHtml(formatMinuteBucket(group.bucketTs))}</span>
      <span class="receipt-minute-count">${group.items.length} event${group.items.length === 1 ? "" : "s"}</span>
    `;
    section.appendChild(header);

    const list = document.createElement("div");
    list.className = "receipt-minute-list";

    group.items.forEach((ev) => {
      const isSelected = selectedEventId && ev?.id === selectedEventId;

      const row = document.createElement("div");
      row.className = `receipt-event-row${isSelected ? " receipt-event-row-selected" : ""}`;
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-expanded", isSelected ? "true" : "false");
      row.setAttribute("aria-label", `Inspect event on ${ev.site || "unknown"} at ${formatReceiptTime(ev.ts)}`);

      const detailText = summarizeEvent(ev);
      const kindTone = receiptKindTone(ev?.kind);

      row.innerHTML = `
        <div class="receipt-event-time">${escapeHtml(formatReceiptTime(ev.ts))}</div>
        <div class="receipt-event-main">
          <div class="receipt-event-site" title="${escapeHtml(ev.site || "unknown")}">${escapeHtml(ev.site || "unknown")}</div>
          <div class="receipt-event-details" title="${escapeHtml(detailText)}">${escapeHtml(truncateText(detailText))}</div>
        </div>
        <div class="receipt-event-kind">
          <span class="pill pill-kind receipt-kind-pill ${kindTone}">${escapeHtml(ev.kind || "event")}</span>
        </div>
        <div class="receipt-event-mode">
          <span class="pill pill-mode receipt-mode-pill ${modeClass(ev.mode)}">${escapeHtml(ev.mode || "-")}</span>
        </div>
      `;

      row.addEventListener("click", () => handleRowSelection(ev));
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        handleRowSelection(ev);
      });

      list.appendChild(row);

      if (isSelected) {
        const drawer = document.createElement("div");
        drawer.className = "receipt-event-drawer";
        drawer.setAttribute("role", "region");
        drawer.setAttribute("aria-label", `Selected event details for ${ev.site || "unknown"}`);
        drawer.innerHTML = renderCompactDrawerHtml(ev, trustedSites, utils);
        const rawJsonDetails = drawer.querySelector(".receipt-event-drawer-raw");
        rawJsonDetails?.addEventListener("toggle", () => {
          rawJsonOpenEventId = rawJsonDetails.open ? ev.id : null;
        });
        list.appendChild(drawer);
      }
    });

    section.appendChild(list);
    feed.appendChild(section);
  });
}

window.VPT = window.VPT || {};
window.VPT.features = window.VPT.features || {};
window.VPT.features.events = { initEventsFeature, renderEvents, renderEventDetails };
