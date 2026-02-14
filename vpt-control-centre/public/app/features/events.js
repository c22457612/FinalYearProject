// public/app/features/events.js

let selectedRow = null;
let onSelectEventCb = null;
let getTrustedSitesCb = null;

function ensureCoreUtils() {
  const utils = window.VPT?.utils;
  if (!utils) {
    console.error("[events] VPT.utils missing (did app/core.js load first?)");
    return null;
  }
  return utils;
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
    const t = d.isThirdParty ? "third-party" : "first-party";
    return `${t} request to ${domain} blocked`;
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
    return `Cookie snapshot for ${site}: ${parts.join(" · ")}`;
  }

  if (kind === "cookies.cleared") {
    const site = ev.site || d.siteBase || "this site";
    const cleared = d.cleared != null ? d.cleared : 0;
    const total = d.total != null ? d.total : (cleared || 0);
    if (!cleared && !total) return `No cookies were cleared for ${site}`;
    if (total && cleared !== total) return `Cleared ${cleared} of ${total} cookies for ${site}`;
    const n = cleared || total;
    return `Cleared ${n} cookie${n === 1 ? "" : "s"} for ${site}`;
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
    body.innerHTML = '<p class="muted">No event selected.</p>';
    actions.style.display = "none";
    if (trustBtn) trustBtn.disabled = true;
    subtitle.textContent = "Click an event in the table to see more information.";
    return;
  }

  const d = ev.data || {};
  const domain = d.domain || "(none)";
  const third = d.isThirdParty ? "third-party" : "first-party / unknown";

  subtitle.textContent = `Event at ${friendlyTime(ev.ts)} on ${ev.site || "unknown"}`;

  const isTrusted = ev.site && trustedSites.has(ev.site);
  const protectionStatus = isTrusted
    ? "trusted (tracking protection bypassed)"
    : "protected (tracking protection active)";

  body.innerHTML = `
    <div class="label">Event ID</div>
    <div class="value">${ev.id || "(none)"}</div>

    <div class="label">Site</div>
    <div class="value">${ev.site || "unknown"}</div>

    <div class="label">Protection status</div>
    <div class="value">${protectionStatus}</div>

    <div class="label">Kind</div>
    <div class="value">${ev.kind || "-"}</div>

    <div class="label">Mode</div>
    <div class="value">${ev.mode || "-"}</div>

    <div class="label">Domain</div>
    <div class="value">${escapeHtml(domain)}</div>

    <div class="label">Party</div>
    <div class="value">${third}</div>

    <div class="label">Resource type</div>
    <div class="value">${escapeHtml(d.resourceType || "-")}</div>

    <div class="label">Summary</div>
    <div class="value">${escapeHtml(summarizeEvent(ev))}</div>

    <details class="raw">
      <summary>Show raw event JSON</summary>
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

  const { friendlyTime, modeClass } = utils;

  const tbody = document.getElementById("eventsTableBody");
  const subtitle = document.getElementById("receiptSubtitle");
  if (!tbody || !subtitle) return;

  tbody.innerHTML = "";

  const sorted = (Array.isArray(events) ? events : [])
    .slice()
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));

  const latest = sorted.slice(0, 50);

  latest.forEach(ev => {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = friendlyTime(ev.ts);
    tr.appendChild(tdTime);

    const tdSite = document.createElement("td");
    tdSite.textContent = ev.site || "unknown";
    tr.appendChild(tdSite);

    const tdKind = document.createElement("td");
    const pillKind = document.createElement("span");
    pillKind.className = "pill pill-kind";
    pillKind.textContent = ev.kind || "event";
    tdKind.appendChild(pillKind);
    tr.appendChild(tdKind);

    const tdDetails = document.createElement("td");
    tdDetails.textContent = summarizeEvent(ev);
    tr.appendChild(tdDetails);

    const tdMode = document.createElement("td");
    const pillMode = document.createElement("span");
    pillMode.className = "pill pill-mode " + modeClass(ev.mode);
    pillMode.textContent = ev.mode || "-";
    tdMode.appendChild(pillMode);
    tr.appendChild(tdMode);

    tr.addEventListener("click", () => {
      if (selectedRow) selectedRow.classList.remove("event-row-selected");
      selectedRow = tr;
      tr.classList.add("event-row-selected");

      // update details immediately using current trusted set (if provided)
      const trusted = getTrustedSitesCb ? (getTrustedSitesCb() || new Set()) : new Set();
      renderEventDetails(ev, { trustedSites: trusted });

      // tell dashboard about selection (for export buttons etc.)
      onSelectEventCb?.(ev);
    });

    tbody.appendChild(tr);
  });

  if (!latest.length) {
    subtitle.textContent = "No events received yet. Browse a site with trackers to see activity.";
  } else {
    subtitle.textContent = `Showing ${latest.length} of ${events.length} event(s)`;
  }
}

// Bridge for non-module dashboard.js
window.VPT = window.VPT || {};
window.VPT.features = window.VPT.features || {};
window.VPT.features.events = { initEventsFeature, renderEvents, renderEventDetails };
