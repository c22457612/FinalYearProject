let selectedRow = null;
let selectedEventId = null;
let onSelectEventCb = null;
let getTrustedSitesCb = null;

const HOME_RECEIPT_LIMIT = 50;

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

function selectReceiptRow(row, ev) {
  if (selectedRow) selectedRow.classList.remove("receipt-event-row-selected");
  selectedRow = row;
  selectedEventId = ev?.id || null;
  if (selectedRow) selectedRow.classList.add("receipt-event-row-selected");

  const trusted = getTrustedSitesCb ? (getTrustedSitesCb() || new Set()) : new Set();
  renderEventDetails(ev, { trustedSites: trusted });
  onSelectEventCb?.(ev);
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

  return JSON.stringify(d) || "(no details)";
}

export function renderEventDetails(ev, { trustedSites = new Set() } = {}) {
  const utils = ensureCoreUtils();
  if (!utils) return;

  const { friendlyTime, escapeHtml } = utils;

  const body = document.getElementById("details-body");
  const actions = document.getElementById("details-actions");
  const subtitle = document.getElementById("details-subtitle");
  const trustBtn = document.getElementById("trust-site-btn");

  if (!body || !actions || !subtitle) return;

  if (!ev) {
    body.innerHTML = '<div class="details-placeholder">No event selected.</div>';
    actions.style.display = "none";
    if (trustBtn) trustBtn.disabled = true;
    subtitle.textContent = "Click a receipt row to inspect a single event.";
    selectedEventId = null;
    if (selectedRow) {
      selectedRow.classList.remove("receipt-event-row-selected");
      selectedRow = null;
    }
    return;
  }

  const data = ev.data || {};
  const domain = data.domain || "";
  const resourceType = data.resourceType || "";
  const isTrusted = ev.site && trustedSites.has(ev.site);
  const protectionStatus = isTrusted ? "trusted" : "protected";
  const summary = summarizeEvent(ev);

  subtitle.textContent = `Event at ${friendlyTime(ev.ts)} on ${ev.site || "unknown"}`;

  const fields = [
    ["Site", ev.site || "unknown"],
    ["Time", friendlyTime(ev.ts)],
    ["Event", ev.kind || "-"],
    ["Mode", ev.mode || "-"],
    ["Status", protectionStatus],
    ["Domain", domain || "-"],
    ["Resource", resourceType || "-"],
    ["Summary", summary],
  ];

  body.innerHTML = `
    <div class="receipt-detail-grid">
      ${fields.map(([label, value]) => `
        <div class="receipt-detail-item">
          <div class="label">${escapeHtml(label)}</div>
          <div class="value">${escapeHtml(value)}</div>
        </div>
      `).join("")}
    </div>
    <details class="receipt-raw-event">
      <summary>Raw event JSON</summary>
      <pre>${escapeHtml(JSON.stringify(ev, null, 2))}</pre>
    </details>
  `;

  const canTrustSite = !!ev.site;
  actions.style.display = canTrustSite ? "flex" : "none";

  if (trustBtn) {
    trustBtn.disabled = !canTrustSite;
    if (!canTrustSite) trustBtn.textContent = "Trust this site (send to extension)";
    else if (trustedSites.has(ev.site)) trustBtn.textContent = `Stop trusting ${ev.site}`;
    else trustBtn.textContent = `Trust ${ev.site} (send to extension)`;
  }
}

export function renderEvents(events) {
  const utils = ensureCoreUtils();
  if (!utils) return;

  const { modeClass, escapeHtml } = utils;

  const feed = document.getElementById("receiptFeed");
  const subtitle = document.getElementById("receiptSubtitle");
  if (!feed || !subtitle) return;

  feed.innerHTML = "";
  selectedRow = null;

  const sorted = (Array.isArray(events) ? events : [])
    .slice()
    .sort((a, b) => (Number(b?.ts) || 0) - (Number(a?.ts) || 0));
  const latest = sorted.slice(0, HOME_RECEIPT_LIMIT);

  if (!latest.length) {
    subtitle.textContent = "No events received yet. Browse a site with trackers to see activity.";
    feed.innerHTML = '<div class="receipt-empty">No receipt entries yet.</div>';
    return;
  }

  subtitle.textContent = `Showing ${latest.length} of ${events.length} event(s)`;

  const groups = buildGroupedEvents(latest);

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
      const row = document.createElement("div");
      row.className = "receipt-event-row";
      row.tabIndex = 0;
      row.setAttribute("role", "button");
      row.setAttribute("aria-label", `Inspect event on ${ev.site || "unknown"} at ${formatReceiptTime(ev.ts)}`);

      if (selectedEventId && ev?.id === selectedEventId) {
        selectedRow = row;
        row.classList.add("receipt-event-row-selected");
      }

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

      row.addEventListener("click", () => selectReceiptRow(row, ev));
      row.addEventListener("keydown", (event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        selectReceiptRow(row, ev);
      });

      list.appendChild(row);
    });

    section.appendChild(list);
    feed.appendChild(section);
  });
}

window.VPT = window.VPT || {};
window.VPT.features = window.VPT.features || {};
window.VPT.features.events = { initEventsFeature, renderEvents, renderEventDetails };

