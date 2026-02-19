// public/app/features/sites.js
// Handles the Sites view: wall/grid + search/sort + summary stats

export function initSitesFeature(ctx) {
  // ctx.getSitesCache() must return latest sites array
  const sitesSearch = document.getElementById("sitesSearch");
  const sitesSort = document.getElementById("sitesSort");

  if (sitesSearch) {
    sitesSearch.addEventListener("input", () => {
      renderSitesWall(ctx.getSitesCache());
    });
  }

  if (sitesSort) {
    sitesSort.addEventListener("change", () => {
      renderSitesWall(ctx.getSitesCache());
    });
  }
}

export function renderSitesWall(sites) {
  const statCount = document.getElementById("sitesStatCount");
  const statEvents = document.getElementById("sitesStatEvents");
  const statBlocked = document.getElementById("sitesStatBlocked");
  const statThird = document.getElementById("sitesStatThird");
  const grid = document.getElementById("sitesGrid");

  if (!statCount || !statEvents || !statBlocked || !statThird || !grid) return;

  const list = Array.isArray(sites) ? sites : [];

  const totalSites = list.length;
  const totalEvents = list.reduce((sum, s) => sum + (s.totalEvents || 0), 0);
  const totalBlocked = list.reduce((sum, s) => sum + (s.blockedCount || 0), 0);
  const totalThird = list.reduce((sum, s) => sum + (s.uniqueThirdParties || 0), 0);

  statCount.textContent = totalSites;
  statEvents.textContent = totalEvents;
  statBlocked.textContent = totalBlocked;
  statThird.textContent = totalThird;

  const search = (document.getElementById("sitesSearch")?.value || "").trim().toLowerCase();
  const sort = document.getElementById("sitesSort")?.value || "events";

  let rows = list.slice();

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

// Bridge for non-module dashboard.js
window.VPT = window.VPT || {};
window.VPT.features = window.VPT.features || {};
window.VPT.features.sites = { initSitesFeature, renderSitesWall };
