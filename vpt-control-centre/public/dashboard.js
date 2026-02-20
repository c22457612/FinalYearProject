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
let latestSitesCache = [];

function setSelectedSite(site) {
  const normalized = typeof site === "string" && site.trim() ? site.trim() : null;
  window.VPT = window.VPT || {};
  window.VPT.state = window.VPT.state || { selectedSite: null };
  window.VPT.state.selectedSite = normalized;
}

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

    // Clear selection if the selected event no longer exists in the latest poll window.
    if (selectedEvent?.id && !events.some(e => e?.id === selectedEvent.id)) {
      selectedEvent = null;
      setSelectedSite(null);
    }

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
    window.VPT?.features?.cookies?.renderCookiesView?.(events); //modularised cookie render
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

  const selectedSite = window.VPT?.state?.selectedSite;
  const site = typeof selectedSite === "string" && selectedSite.trim() ? selectedSite : null;

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

  // Init sites feature module (only on pages that include the Sites container)
  const sitesGrid = document.getElementById("sitesGrid");
  if (sitesGrid && window.VPT?.features?.sites?.initSitesFeature) {
    window.VPT.features.sites.initSitesFeature({
      getSitesCache: () => latestSitesCache
    });
  }

  window.VPT?.features?.cookies?.initCookiesFeature?.({
    getLatestEvents: () => latestEvents
  });


  // set correct disabled state on page load
  setSelectedSite(null);
  updateExportButtons();

  // Init events feature module
  window.VPT?.features?.events?.initEventsFeature?.({
    onSelectEvent: (ev) => {
      selectedEvent = ev;
      setSelectedSite(ev?.site || null);
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



