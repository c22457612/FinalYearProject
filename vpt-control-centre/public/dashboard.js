// ---- Core modules (bridge from app/core.js) ----
const api = window.VPT?.api;
const utils = window.VPT?.utils;

if (!api || !utils) {
  console.error("VPT core not loaded. Check index.html includes app/core.js before dashboard.js");
}

const { friendlyTime, modeClass, escapeHtml } = utils || {};

const POLL_MS = 3000; // poll every 3s
const HOME_RECEIPT_LIMIT = 50;

let latestEvents = [];
let selectedEvent = null;
let trustedSites = new Set(); // derived from /api/policies
let latestSitesCache = [];
let latestPoliciesCache = { latestTs: 0, items: [] };

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

function appendPoliciesToCache(created) {
  const createdItems = Array.isArray(created) ? created.filter(Boolean) : [created].filter(Boolean);
  if (!createdItems.length) return;

  latestPoliciesCache = {
    latestTs: Math.max(
      Number(latestPoliciesCache.latestTs) || 0,
      ...createdItems.map((item) => Number(item?.ts) || 0)
    ),
    items: (Array.isArray(latestPoliciesCache.items) ? latestPoliciesCache.items : []).concat(createdItems),
  };

  recomputePolicyState(latestPoliciesCache);
}

function setConnectionStatus(state, text) {
  const statusElements = [
    document.getElementById("connectionStatus"),
    document.getElementById("connectionStatusShell"),
  ].filter(Boolean);

  statusElements.forEach((statusEl) => {
    statusEl.textContent = text;
    statusEl.dataset.status = state;
    statusEl.title = text;
    statusEl.setAttribute("aria-label", text);
    statusEl.style.color = state === "online" ? "#10b981" : state === "offline" ? "#f97316" : "";
  });
}

function setShellHeaderTitle(view) {
  const titleEl = document.getElementById("shellHeaderTitle");
  if (!titleEl) return;

  const labels = {
    home: "Home",
    sites: "Sites",
    cookies: "Cookies",
    "trusted-sites": "Trusted Sites",
    "api-signals": "Browser API",
  };

  titleEl.textContent = labels[view] || "Home";
}

function buildInspectReason(metrics, siteSummary) {
  const blocked = Number(metrics.blocked || 0);
  const observed = Number(metrics.observed || 0);
  const receiptCount = Number(metrics.receiptCount || 0);
  const thirdParties = Number(siteSummary?.uniqueThirdParties || 0);

  if (blocked >= 3) return `${blocked} blocked requests in the current receipt`;
  if (blocked >= 1 && observed >= 1) return "Mixed blocked and observed activity";
  if (receiptCount >= 4) return `${receiptCount} events in the current receipt`;
  if (thirdParties >= 4) return `${thirdParties} third-party domains observed`;
  if (blocked >= 1) return "Blocked activity worth checking";
  return "Recent privacy activity in the current receipt";
}

function renderInspectNext(sites, events) {
  const container = document.getElementById("inspectNextList");
  if (!container) return;

  const latest = (Array.isArray(events) ? events : [])
    .slice()
    .sort((a, b) => (Number(b?.ts) || 0) - (Number(a?.ts) || 0))
    .slice(0, HOME_RECEIPT_LIMIT);

  const siteSummaryBySite = new Map(
    (Array.isArray(sites) ? sites : []).map((site) => [site?.site || "unknown", site])
  );
  const metricsBySite = new Map();

  latest.forEach((event) => {
    const site = event?.site || "unknown";
    if (!metricsBySite.has(site)) {
      metricsBySite.set(site, {
        site,
        receiptCount: 0,
        blocked: 0,
        observed: 0,
        lastTs: 0,
      });
    }

    const metric = metricsBySite.get(site);
    metric.receiptCount += 1;
    metric.lastTs = Math.max(metric.lastTs, Number(event?.ts) || 0);
    if (event?.kind === "network.blocked") metric.blocked += 1;
    if (event?.kind === "network.observed") metric.observed += 1;
  });

  const rows = Array.from(metricsBySite.values())
    .map((metric) => {
      const siteSummary = siteSummaryBySite.get(metric.site) || null;
      const reason = buildInspectReason(metric, siteSummary);
      const score = (metric.blocked * 5)
        + ((metric.blocked > 0 && metric.observed > 0) ? 4 : 0)
        + (metric.receiptCount * 2)
        + Math.min(Number(siteSummary?.uniqueThirdParties || 0), 4);

      return {
        site: metric.site,
        reason,
        score,
        lastTs: metric.lastTs,
      };
    })
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      return (b.lastTs || 0) - (a.lastTs || 0);
    })
    .slice(0, 5);

  if (!rows.length) {
    container.innerHTML = '<div class="inspect-next-empty">No active sites in the current receipt.</div>';
    return;
  }

  container.innerHTML = rows.map((row) => `
    <div class="inspect-next-item">
      <div class="inspect-next-main">
        <div class="inspect-next-site">${escapeHtml(row.site)}</div>
        <div class="inspect-next-reason">${escapeHtml(row.reason)}</div>
      </div>
      <a class="inspect-next-link" href="/site.html?site=${encodeURIComponent(row.site)}">Inspect</a>
    </div>
  `).join("");
}

// ---- Poll loop ----

async function fetchAndRender() {
  const statusEl = document.getElementById("connectionStatusShell") || document.getElementById("connectionStatus");
  try {
    const { events, sites, policies } = await api.fetchDashboardData();

    latestSitesCache = Array.isArray(sites) ? sites : [];
    latestPoliciesCache = policies && typeof policies === "object"
      ? { latestTs: Number(policies.latestTs) || 0, items: Array.isArray(policies.items) ? policies.items : [] }
      : { latestTs: 0, items: [] };

    // Clear selection if the selected event no longer exists in the latest poll window.
    if (selectedEvent?.id && !events.some(e => e?.id === selectedEvent.id)) {
      selectedEvent = null;
      setSelectedSite(null);
      updateExportButtons();
    }

    // update trustedSites set from policies
    recomputePolicyState(policies);

    setConnectionStatus("online", "Connected to local backend");

    latestEvents = events; // keep for cookies back button etc.
    window.VPT?.features?.events?.renderEvents?.(events);
    renderInspectNext(sites, events);
    window.VPT?.features?.sites?.renderSitesWall?.(sites); //modularisation call

    // refresh details panel so status + button reflect current trust state
    window.VPT?.features?.events?.renderEventDetails?.(selectedEvent, { trustedSites });
    window.VPT?.features?.cookies?.renderCookiesView?.(events); //modularised cookie render
    window.VPT?.features?.trustedSites?.renderTrustedSitesView?.(sites, { policies: latestPoliciesCache });
    window.VPT?.features?.apiSignals?.renderApiSignalsView?.(events, { policies: latestPoliciesCache });
  } catch (err) {
    console.error("fetch error", err);
    if (statusEl) statusEl.dataset.status = "offline";
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
  window.VPT?.features?.trustedSites?.initTrustedSitesFeature?.({
    getLatestSites: () => latestSitesCache,
    getLatestPolicies: () => latestPoliciesCache,
    onPoliciesMutated: (created) => {
      appendPoliciesToCache(created);
      window.VPT?.features?.events?.renderEventDetails?.(selectedEvent, { trustedSites });
      window.VPT?.features?.apiSignals?.renderApiSignalsView?.(latestEvents, { policies: latestPoliciesCache });
    }
  });
  window.VPT?.features?.apiSignals?.initApiSignalsFeature?.({
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
  const trustedSitesView = document.getElementById("view-trusted-sites");
  const apiSignalsView = document.getElementById("view-api-signals");
  const navItems = document.querySelectorAll(".nav-item[data-view]");

  function resolveInitialView() {
    const params = new URLSearchParams(window.location.search);
    const requested = String(params.get("view") || "").trim().toLowerCase();
    if (requested === "sites" || requested === "cookies" || requested === "trusted-sites" || requested === "api-signals" || requested === "home") {
      return requested;
    }
    return "home";
  }

  const shellController = window.VPT?.shell?.initShell?.({
    currentSection: resolveInitialView(),
    persistKey: "vpt.control-centre.shell.collapsed",
  });

  function switchView(view) {
    if (!homeView || !cookiesView || !sitesView || !trustedSitesView || !apiSignalsView) return;

    // hide all
    homeView.classList.add("hidden");
    cookiesView.classList.add("hidden");
    sitesView.classList.add("hidden");
    trustedSitesView.classList.add("hidden");
    apiSignalsView.classList.add("hidden");

    // show chosen view
    if (view === "cookies") {
      cookiesView.classList.remove("hidden");
      window.VPT?.features?.cookies?.renderCookiesView?.(latestEvents);
    } else if (view === "sites") {
      sitesView.classList.remove("hidden");
    } else if (view === "trusted-sites") {
      trustedSitesView.classList.remove("hidden");
      window.VPT?.features?.trustedSites?.renderTrustedSitesView?.(latestSitesCache, { policies: latestPoliciesCache });
    } else if (view === "api-signals") {
      apiSignalsView.classList.remove("hidden");
      window.VPT?.features?.apiSignals?.renderApiSignalsView?.(latestEvents, { policies: latestPoliciesCache });
    } else {
      homeView.classList.remove("hidden");
      view = "home";
    }

    navItems.forEach(btn => {
      btn.classList.toggle("active", btn.dataset.view === view);
    });
    setShellHeaderTitle(view);
    shellController?.setActiveSection?.(view);
  }


  navItems.forEach(btn => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view || "home";
      switchView(view);
    });
  });

  switchView(resolveInitialView());

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
        const created = await api.postPolicy(op, { site }); // will throw automatically if HTTP not OK (if using fetchJson)
        appendPoliciesToCache(created);
        window.VPT?.features?.events?.renderEventDetails?.(selectedEvent, { trustedSites });
        window.VPT?.features?.trustedSites?.renderTrustedSitesView?.(latestSitesCache, { policies: latestPoliciesCache });
        window.VPT?.features?.apiSignals?.renderApiSignalsView?.(latestEvents, { policies: latestPoliciesCache });

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



