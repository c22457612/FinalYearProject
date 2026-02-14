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
    latestEvents = events; // keep for cookies back button etc.
    window.VPT?.features?.events?.renderEvents?.(events);
    renderSites(sites);
    window.VPT?.features?.sites?.renderSitesWall?.(sites); //modularisation call

    // refresh details panel so status + button reflect current trust state
    window.VPT?.features?.events?.renderEventDetails?.(selectedEvent, { trustedSites });
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
  if (typeof window.initExportFeature === "function") {
    window.initExportFeature();
  }
  // Init sites feature module
  window.VPT?.features?.sites?.initSitesFeature?.({
    getSitesCache: () => latestSitesCache
  });

  // set correct disabled state on page load
  updateExportButtons();

  // Init events feature module
  window.VPT?.features?.events?.initEventsFeature?.({
    onSelectEvent: (ev) => {
      selectedEvent = ev;
      updateExportButtons();
    },
    getTrustedSites: () => trustedSites
  });
  
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
        window.VPT?.features?.events?.renderEventDetails?.(selectedEvent, { trustedSites });

        trustBtn.textContent = op === "trust_site"
          ? `Sent: trust ${site}`
          : `Sent: stop trusting ${site}`;
      } catch (err) {
        console.error("Failed to send policy", err);
        trustBtn.textContent = "Error sending policy – try again";
      } finally {
        setTimeout(() => {
          trustBtn.disabled = false;
          window.VPT?.features?.events?.renderEventDetails?.(selectedEvent, { trustedSites });
        }, 1500);
      }
    });
  }
});
