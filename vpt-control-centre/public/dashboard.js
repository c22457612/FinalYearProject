// ---- Core modules (bridge from app/core.js) ----
const api = window.VPT?.api;
const utils = window.VPT?.utils;

if (!api || !utils) {
  console.error("VPT core not loaded. Check index.html includes app/core.js before dashboard.js");
}

const { friendlyTime, modeClass, escapeHtml } = utils || {};

const POLL_MS = 3000; // poll every 3s

let latestEvents = [];
let selectedEvent = null;
let selectedEventRow = null;
let trustedSites = new Set(); // derived from /api/policies
let selectedCookieSite = null; // for Cookies view selection
let cookiesViewMode = "grid";  // "grid" (wall) or "detail"
let latestSitesCache = [];







function recomputePolicyState(policiesResponse) {
  const items = (policiesResponse && policiesResponse.items) || [];
  const trusted = new Set();

  for (const p of items) {
    if (!p || typeof p !== "object") continue;
    const op = p.op;
    const payload = p.payload || {};

    if (op === "trust_site" && payload.site) {
      trusted.add(payload.site);
    } else if (op === "untrust_site" && payload.site) {
      trusted.delete(payload.site);
    }
  }

  trustedSites = trusted;
}

function renderEventDetails(ev) {
  const body = document.getElementById("details-body");
  const actions = document.getElementById("details-actions");
  const subtitle = document.getElementById("details-subtitle");

  if (!ev) {
    updateExportButtons();
    selectedEvent = null;
    body.innerHTML = '<p class="muted">No event selected.</p>';
    actions.style.display = "none";

    const trustBtn = document.getElementById("trust-site-btn");
    if (trustBtn) trustBtn.disabled = true;

    subtitle.textContent = "Click an event in the table to see more information.";
    return;
  }


  selectedEvent = ev;

  const d = ev.data || {};
  const domain = d.domain || "(none)";
  const third = d.isThirdParty ? "third-party" : "first-party / unknown";

  subtitle.textContent =
    `Event at ${friendlyTime(ev.ts)} on ${ev.site || "unknown"}`;

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
    <div class="value">${domain}</div>

    <div class="label">Party</div>
    <div class="value">${third}</div>

    <div class="label">Resource type</div>
    <div class="value">${d.resourceType || "-"}</div>

    <div class="label">Summary</div>
    <div class="value">${escapeHtml(summarizeEvent(ev))}</div>

    <details class="raw">
      <summary>Show raw event JSON</summary>
      <pre>${escapeHtml(JSON.stringify(ev, null, 2))}</pre>
    </details>
  `;

  // decide whether the trust button should be shown/enabled
  const canTrustSite = !!ev.site;
  actions.style.display = canTrustSite ? "flex" : "none";

  const trustBtn = document.getElementById("trust-site-btn");
  if (trustBtn) {
    trustBtn.disabled = !canTrustSite;
    if (!canTrustSite) {
      trustBtn.textContent = "Trust this site (send to extension)";
    } else if (trustedSites.has(ev.site)) {
      trustBtn.textContent = `Stop trusting ${ev.site}`;
    } else {
      trustBtn.textContent = `Trust ${ev.site} (send to extension)`;
    }
  }

  updateExportButtons();

}

function buildCookieSnapshots(events) {
  const bySite = new Map();

  for (const ev of events) {
    if (ev.kind !== "cookies.snapshot") continue;
    const d = ev.data || {};
    const site = ev.site || d.siteBase || "unknown";

    const existing = bySite.get(site);
    if (existing && existing.ts >= (ev.ts || 0)) {
      continue; // keep the newer snapshot
    }

    const cookies = Array.isArray(d.cookies) ? d.cookies : [];
    const count = d.count != null ? d.count : cookies.length;
    const third =
      d.thirdPartyCount != null
        ? d.thirdPartyCount
        : cookies.filter(c => c.isThirdParty).length;

    bySite.set(site, {
      site,
      ts: ev.ts || 0,
      event: ev,
      count,
      third,
      cookies
    });
  }

  return Array.from(bySite.values());
}

function renderCookieDetails(snapshot) {
  const body = document.getElementById("cookies-details-body");
  const subtitle = document.getElementById("cookies-details-subtitle");
  if (!body || !subtitle) return;

  if (!snapshot) {
    subtitle.textContent = "Click a site card to see its cookies.";
    body.innerHTML = '<div class="details-placeholder">No site selected.</div>';
    return;
  }

  const { site, ts, count, third, cookies } = snapshot;
  const first = count - third;
  subtitle.textContent =
    `Latest snapshot for ${site} at ${friendlyTime(ts)} (local time)`;

  if (!cookies.length) {
    body.innerHTML = `
      <div class="cookies-details-summary">
        <div>${count} cookie${count === 1 ? "" : "s"} in this snapshot.</div>
        <div>${first} first-party · ${third} third-party</div>
      </div>
      <p class="muted">No individual cookie details were recorded.</p>
    `;
    return;
  }

  const rowsHtml = cookies.slice(0, 100).map(c => {
    const flags = [];
    if (c.secure) flags.push("Secure");
    if (c.httpOnly) flags.push("HttpOnly");
    if (c.sameSite) flags.push(`SameSite=${c.sameSite}`);
    if (c.session) flags.push("Session");
    const flagsText = flags.length ? flags.join(" · ") : "–";
    const expiry = c.expiry
      ? new Date(c.expiry * 1000).toLocaleString()
      : (c.session ? "Session" : "–");
    const party = c.isThirdParty ? "third-party" : "first-party";

    return `
      <tr>
        <td class="cookie-name">${escapeHtml(c.name)}</td>
        <td class="cookie-domain">${escapeHtml(c.domain || "")}</td>
        <td>${party}</td>
        <td>${escapeHtml(flagsText)}</td>
        <td>${escapeHtml(expiry)}</td>
      </tr>
    `;
  }).join("");

  body.innerHTML = `
    <div class="cookies-details-summary">
      <div>${count} cookie${count === 1 ? "" : "s"} in this snapshot.</div>
      <div>${first} first-party · ${third} third-party</div>
    </div>
    <div class="table-wrapper">
      <table class="cookies-table">
        <thead>
          <tr>
            <th>Name</th>
            <th>Domain</th>
            <th>Party</th>
            <th>Flags</th>
            <th>Expires</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    </div>
  `;
}

function renderCookiesView(events) {
  const snapshots = buildCookieSnapshots(events);

  const statSites = document.getElementById("cookieStatSites");
  const statTotal = document.getElementById("cookieStatTotal");
  const statThird = document.getElementById("cookieStatThird");
  const grid = document.getElementById("cookiesGrid");
  const wallSection = document.getElementById("cookiesWall");
  const detailSection = document.getElementById("cookiesDetailView");

  if (!statSites || !statTotal || !statThird || !grid || !wallSection || !detailSection) {
    return;
  }

  const totalSites = snapshots.length;
  const totalCookies = snapshots.reduce((sum, s) => sum + s.count, 0);
  const totalThird = snapshots.reduce((sum, s) => sum + s.third, 0);

  statSites.textContent = totalSites;
  statTotal.textContent = totalCookies;
  statThird.textContent = totalThird;

  // always refresh the grid (even if it's hidden)
  grid.innerHTML = "";

  if (!snapshots.length) {
    // no snapshots: force wall mode with an explanatory message
    cookiesViewMode = "grid";
    wallSection.classList.remove("hidden");
    detailSection.classList.add("hidden");

    grid.innerHTML = `
      <div class="panel">
        <div class="panel-body">
          <p class="muted">
            No cookie snapshots yet. Use the browser extension popup and click
            <strong>“Send cookie snapshot to Control Centre”</strong> on a site
            that sets cookies.
          </p>
        </div>
      </div>
    `;
    renderCookieDetails(null);
    return;
  }

  // keep current selection if still present; otherwise default to first site
  if (!selectedCookieSite || !snapshots.some(s => s.site === selectedCookieSite)) {
    selectedCookieSite = snapshots[0].site;
  }

  // sort sites by cookie count (descending)
  snapshots.sort((a, b) => b.count - a.count);

  snapshots.forEach(snapshot => {
    const first = snapshot.count - snapshot.third;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "cookie-card";
    if (snapshot.site === selectedCookieSite) {
      card.classList.add("selected");
    }

    card.innerHTML = `
      <div class="cookie-card-site">${escapeHtml(snapshot.site)}</div>
      <div class="cookie-card-count">${snapshot.count}</div>
      <div class="cookie-card-meta">
        ${first} first-party · ${snapshot.third} third-party
      </div>
      <div class="cookie-badges">
        <span class="cookie-chip">Latest: ${friendlyTime(snapshot.ts)}</span>
      </div>
    `;

    card.addEventListener("click", () => {
      // when a tile is clicked, go to detail sub-view for that site
      selectedCookieSite = snapshot.site;
      cookiesViewMode = "detail";
      renderCookiesView(latestEvents);
    });

    grid.appendChild(card);
  });

  // toggle between wall-only and detail view
  if (cookiesViewMode === "detail") {
    wallSection.classList.add("hidden");
    detailSection.classList.remove("hidden");

    const selected =
      snapshots.find(s => s.site === selectedCookieSite) || snapshots[0];

    renderCookieDetails(selected);
  } else {
    // wall mode: hide detail view and clear its content
    cookiesViewMode = "grid";
    wallSection.classList.remove("hidden");
    detailSection.classList.add("hidden");
    renderCookieDetails(null);
  }
}

function renderSitesWall(sites) {
  const statCount = document.getElementById("sitesStatCount");
  const statEvents = document.getElementById("sitesStatEvents");
  const statBlocked = document.getElementById("sitesStatBlocked");
  const statThird = document.getElementById("sitesStatThird");
  const grid = document.getElementById("sitesGrid");

  if (!statCount || !statEvents || !statBlocked || !statThird || !grid) {
    return;
  }

  const totalSites = sites.length;
  const totalEvents = sites.reduce((sum, s) => sum + (s.totalEvents || 0), 0);
  const totalBlocked = sites.reduce((sum, s) => sum + (s.blockedCount || 0), 0);
  const totalThird = sites.reduce((sum, s) => sum + (s.uniqueThirdParties || 0), 0);

  statCount.textContent = totalSites;
  statEvents.textContent = totalEvents;
  statBlocked.textContent = totalBlocked;
  statThird.textContent = totalThird;

  const search = (document.getElementById("sitesSearch")?.value || "").trim().toLowerCase();
  const sort = document.getElementById("sitesSort")?.value || "events";

  let rows = sites.slice();

  if (search) {
    rows = rows.filter(s => String(s.site || "").toLowerCase().includes(search));
  }

  rows.sort((a, b) => {
    if (sort === "blocked") return (b.blockedCount || 0) - (a.blockedCount || 0);
    if (sort === "third") return (b.uniqueThirdParties || 0) - (a.uniqueThirdParties || 0);
    if (sort === "recent") return (b.lastSeen || 0) - (a.lastSeen || 0);
    return (b.totalEvents || 0) - (a.totalEvents || 0);
  });

  grid.innerHTML = "";

  if (!rows.length) {
    grid.innerHTML = `<div class="site-empty">No matching sites yet.</div>`;
    return;
  }

  for (const s of rows) {
    const a = document.createElement("a");
    a.className = "site-card";
    a.href = `/site.html?site=${encodeURIComponent(s.site)}`;

    const title = document.createElement("div");
    title.className = "site-card-site";
    title.textContent = s.site || "(unknown site)";

    const row1 = document.createElement("div");
    row1.className = "site-card-row";
    row1.innerHTML = `<span>Events: <b>${s.totalEvents || 0}</b></span>
                      <span>Blocked: <b>${s.blockedCount || 0}</b></span>`;

    const row2 = document.createElement("div");
    row2.className = "site-card-mini";
    const lastSeenText = s.lastSeen ? new Date(s.lastSeen).toLocaleString() : "-";
    row2.textContent = `3rd-party domains: ${s.uniqueThirdParties || 0} • Last seen: ${lastSeenText}`;

    a.appendChild(title);
    a.appendChild(row1);
    a.appendChild(row2);

    grid.appendChild(a);
  }
}


function renderSummary(events, sites) {
  const total = events.length;
  const siteCount = sites.length;

  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;
  const recent = events.filter(e => e.ts && e.ts >= fiveMinAgo).length;

  document.getElementById("statTotalEvents").textContent = total;
  document.getElementById("statSites").textContent = siteCount;
  document.getElementById("statRecent").textContent = recent;
  document.getElementById("statRecentHint").textContent =
    recent ? "in the last 5 minutes" : "none in the last 5 minutes";
}


function summarizeEvent(ev) {
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
    const count =
      d.count != null
        ? d.count
        : (Array.isArray(d.cookies) ? d.cookies.length : 0);
    const third = d.thirdPartyCount != null ? d.thirdPartyCount : 0;
    const first = count - third;

    if (!count) {
      return `Cookie snapshot: no cookies found for ${site}`;
    }

    const parts = [`${count} cookie${count === 1 ? "" : "s"}`];
    if (first >= 0 && third >= 0) {
      parts.push(`${first} first-party`, `${third} third-party`);
    }
    return `Cookie snapshot for ${site}: ${parts.join(" · ")}`;
  }

  if (kind === "cookies.cleared") {
    const site = ev.site || d.siteBase || "this site";
    const cleared = d.cleared != null ? d.cleared : 0;
    const total =
      d.total != null
        ? d.total
        : (cleared || 0);

    if (!cleared && !total) {
      return `No cookies were cleared for ${site}`;
    }

    if (total && cleared !== total) {
      return `Cleared ${cleared} of ${total} cookies for ${site}`;
    }

    const n = cleared || total;
    return `Cleared ${n} cookie${n === 1 ? "" : "s"} for ${site}`;
  }
  return JSON.stringify(d) || "(no details)";
}


function renderEvents(events) {
  const tbody = document.getElementById("eventsTableBody");
  tbody.innerHTML = "";

  latestEvents = events.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const latest = latestEvents.slice(0, 50);

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
    let text = summarizeEvent(ev);
    tdDetails.textContent = text;
    tr.appendChild(tdDetails);


    const tdMode = document.createElement("td");
    const pillMode = document.createElement("span");
    pillMode.className = "pill pill-mode " + modeClass(ev.mode);
    pillMode.textContent = ev.mode || "-";
    tdMode.appendChild(pillMode);
    tr.appendChild(tdMode);

    // click to see details
    tr.addEventListener("click", () => {
      if (selectedEventRow) {
        selectedEventRow.classList.remove("event-row-selected");
      }
      selectedEventRow = tr;
      tr.classList.add("event-row-selected");
      renderEventDetails(ev);
    });


    tbody.appendChild(tr);
  });

  const subtitle = document.getElementById("receiptSubtitle");
  if (!latest.length) {
    subtitle.textContent = "No events received yet. Browse a site with trackers to see activity.";
  } else {
    subtitle.textContent = `Showing ${latest.length} of ${events.length} event(s)`;
  }
}

function renderSites(sites) {
  const tbody = document.getElementById("site-summary-body");
  tbody.innerHTML = "";

  const rows = sites.slice().sort((a, b) => b.totalEvents - a.totalEvents);

  rows.forEach(s => {
    const tr = document.createElement("tr");

    const tdSite = document.createElement("td");
    const a = document.createElement("a");
    a.href = `/site.html?site=${encodeURIComponent(s.site)}`;
    a.textContent = s.site;
    a.className = "site-link";
    tdSite.appendChild(a);
    tr.appendChild(tdSite);


    const tdTotal = document.createElement("td");
    tdTotal.textContent = s.totalEvents;
    tr.appendChild(tdTotal);

    const tdBlocked = document.createElement("td");
    tdBlocked.textContent = s.blockedCount;
    tr.appendChild(tdBlocked);

    const tdObserved = document.createElement("td");
    tdObserved.textContent = s.observedCount;
    tr.appendChild(tdObserved);

    const tdThird = document.createElement("td");
    tdThird.textContent = s.uniqueThirdParties;
    tr.appendChild(tdThird);

    tbody.appendChild(tr);
  });
}

// ---- Poll loop ----

async function fetchAndRender() {
  const statusEl = document.getElementById("connectionStatus");
  try {
    const { events, sites, policies } = await api.fetchDashboardData();

    latestSitesCache = Array.isArray(sites) ? sites : [];

    // update trustedSites set from policies
    recomputePolicyState(policies);

    statusEl.textContent = "Connected to local backend";
    statusEl.style.color = "#10b981";

    renderSummary(events, sites);
    renderEvents(events);
    renderSites(sites);
    renderSitesWall(sites);

    // refresh details panel so status + button reflect current trust state
    renderEventDetails(selectedEvent);
    renderCookiesView(events);
  } catch (err) {
    console.error("fetch error", err);
    statusEl.textContent = "Backend unavailable – is server.js running?";
    statusEl.style.color = "#f97316";
  }
}



function updateExportButtons() {
  const siteLabel = document.getElementById("exportSiteLabel");
  const siteCsvBtn = document.getElementById("exportSiteCsvBtn");
  const siteJsonBtn = document.getElementById("exportSiteJsonBtn");

  const site = selectedEvent?.site || null;

  if (siteLabel) {
    siteLabel.textContent = site ? `Selected site: ${site}` : "Selected site: none";
  }

  const enabled = !!site;
  if (siteCsvBtn) siteCsvBtn.disabled = !enabled;
  if (siteJsonBtn) siteJsonBtn.disabled = !enabled;
}


window.addEventListener("load", () => {
  // --- Sites view search/sort live re-render ---
  const sitesSearch = document.getElementById("sitesSearch");
  const sitesSort = document.getElementById("sitesSort");

  if (typeof window.initExportFeature === "function") {
    window.initExportFeature();
  }

  if (sitesSearch) {
    sitesSearch.addEventListener("input", () => {
      renderSitesWall(latestSitesCache);
    });
  }

  if (sitesSort) {
    sitesSort.addEventListener("change", () => {
      renderSitesWall(latestSitesCache);
    });
  }

  // set correct disabled state on page load
  updateExportButtons();

  fetchAndRender();
  setInterval(fetchAndRender, POLL_MS);

  // --- View switching (Home / Cookies) ---
  const homeView = document.getElementById("view-home");
  const sitesView = document.getElementById("view-sites");
  const cookiesView = document.getElementById("view-cookies");
  const navItems = document.querySelectorAll(".nav-item[data-view]");

  function switchView(view) {
    if (!homeView || !cookiesView || !sitesView) return;

    // hide all
    homeView.classList.add("hidden");
    cookiesView.classList.add("hidden");
    sitesView.classList.add("hidden");

    // show chosen view
    if (view === "cookies") {
      cookiesView.classList.remove("hidden");
    } else if (view === "sites") {
      sitesView.classList.remove("hidden");
    } else {
      homeView.classList.remove("hidden");
      view = "home";
    }

    navItems.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === view);
    });
  }


  navItems.forEach(btn => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view || "home";
      switchView(view);
    });
  });

  // Default to Home on load
  switchView("home");

  // Cookies detail view "back" button
  const cookiesBackBtn = document.getElementById("cookiesBackBtn");
  if (cookiesBackBtn) {
    cookiesBackBtn.addEventListener("click", () => {
      cookiesViewMode = "grid";   // go back to wall mode
      renderCookiesView(latestEvents);
    });
  }


  const trustBtn = document.getElementById("trust-site-btn");
  if (trustBtn) {
    trustBtn.addEventListener("click", async () => {
      if (!selectedEvent || !selectedEvent.site) return;

      const site = selectedEvent.site;
      const isTrusted = trustedSites.has(site);
      const op = isTrusted ? "untrust_site" : "trust_site";

      const originalText = trustBtn.textContent;
      trustBtn.disabled = true;
      trustBtn.textContent = isTrusted
        ? `Stopping trust for ${site}…`
        : `Trusting ${site}…`;

      try {
        await api.postPolicy(op, { site }); // will throw automatically if HTTP not OK (if using fetchJson)

        const next = new Set(trustedSites);
        if (op === "trust_site") {
          next.add(site);
        } else {
          next.delete(site);
        }
        trustedSites = next;
        renderEventDetails(selectedEvent);

        trustBtn.textContent = op === "trust_site"
          ? `Sent: trust ${site}`
          : `Sent: stop trusting ${site}`;
      } catch (err) {
        console.error("Failed to send policy", err);
        trustBtn.textContent = "Error sending policy – try again";
      } finally {
        setTimeout(() => {
          trustBtn.disabled = false;
          renderEventDetails(selectedEvent);
        }, 1500);
      }
    });
  }
});



