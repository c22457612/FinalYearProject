// public/app/features/sites.js
// Handles the Sites view as a compact launcher surface.

function formatCount(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function formatLastSeen(ts) {
  if (!ts) return "No recent activity";
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return "No recent activity";
  return date.toLocaleString();
}

function buildMetaText({ totalSites, matchingSites, search }) {
  if (!totalSites) return "0 sites tracked";
  if (search) return `${formatCount(matchingSites)} matching / ${formatCount(totalSites)} sites tracked`;
  return `${formatCount(totalSites)} sites tracked`;
}

function compareSites(sort, a, b) {
  if (sort === "alpha") {
    return String(a?.site || "").localeCompare(String(b?.site || ""), undefined, { sensitivity: "base" });
  }
  if (sort === "events") return (Number(b?.totalEvents) || 0) - (Number(a?.totalEvents) || 0);
  if (sort === "blocked") return (Number(b?.blockedCount) || 0) - (Number(a?.blockedCount) || 0);
  if (sort === "third") return (Number(b?.uniqueThirdParties) || 0) - (Number(a?.uniqueThirdParties) || 0);
  return (Number(b?.lastSeen) || 0) - (Number(a?.lastSeen) || 0);
}

function createMetric(label, value, className = "") {
  const item = document.createElement("div");
  item.className = `site-card-metric${className ? ` ${className}` : ""}`;

  const metricLabel = document.createElement("span");
  metricLabel.className = "site-card-metric-label";
  metricLabel.textContent = label;

  const metricValue = document.createElement("strong");
  metricValue.className = "site-card-metric-value";
  metricValue.textContent = value;

  item.append(metricLabel, metricValue);
  return item;
}

function createBlockedMetric(site) {
  const blockedCount = Number(site?.blockedCount) || 0;
  const totalEvents = Number(site?.totalEvents) || 0;
  const emphasisClass = blockedCount > 0 ? "site-card-metric-warn" : "site-card-metric-primary";
  const wrapper = createMetric("Blocked", formatCount(blockedCount), emphasisClass);

  if (totalEvents > 0) {
    const blockedRate = document.createElement("span");
    blockedRate.className = "site-card-metric-note";
    blockedRate.textContent = `${Math.round((blockedCount / totalEvents) * 100)}% of events`;
    wrapper.appendChild(blockedRate);
  }

  return wrapper;
}

function createSiteCard(site) {
  const card = document.createElement("a");
  const siteName = String(site?.site || "").trim() || "(unknown site)";
  const thirdPartyCount = Number(site?.uniqueThirdParties) || 0;
  card.className = "site-card";
  card.href = `/site.html?site=${encodeURIComponent(siteName)}`;
  card.setAttribute("aria-label", `Open insights for ${siteName}`);

  const head = document.createElement("div");
  head.className = "site-card-head";

  const title = document.createElement("div");
  title.className = "site-card-site";
  title.textContent = siteName;

  const cta = document.createElement("span");
  cta.className = "site-card-cta";
  cta.textContent = "Open insights";

  head.append(title, cta);

  const metrics = document.createElement("div");
  metrics.className = "site-card-metrics";
  metrics.append(
    createMetric("Events", formatCount(site?.totalEvents)),
    createBlockedMetric(site),
    createMetric(
      "3rd-party domains",
      formatCount(thirdPartyCount),
      thirdPartyCount > 0 ? "site-card-metric-secondary" : ""
    )
  );

  const footer = document.createElement("div");
  footer.className = "site-card-footer";

  const lastSeen = document.createElement("div");
  lastSeen.className = "site-card-last-seen";

  const lastSeenLabel = document.createElement("span");
  lastSeenLabel.className = "site-card-last-seen-label";
  lastSeenLabel.textContent = "Last seen";

  const lastSeenValue = document.createElement("span");
  lastSeenValue.className = "site-card-last-seen-value";
  lastSeenValue.textContent = formatLastSeen(site?.lastSeen);

  lastSeen.append(lastSeenLabel, lastSeenValue);
  footer.appendChild(lastSeen);

  card.append(head, metrics, footer);
  return card;
}

function createEmptyState(titleText, bodyText) {
  const empty = document.createElement("div");
  empty.className = "site-empty";

  const title = document.createElement("div");
  title.className = "site-empty-title";
  title.textContent = titleText;

  const copy = document.createElement("div");
  copy.className = "site-empty-copy";
  copy.textContent = bodyText;

  empty.append(title, copy);
  return empty;
}

export function initSitesFeature(ctx) {
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
  const meta = document.getElementById("sitesMeta");
  const grid = document.getElementById("sitesGrid");
  if (!meta || !grid) return;

  const list = Array.isArray(sites) ? sites.slice() : [];
  const searchValue = (document.getElementById("sitesSearch")?.value || "").trim();
  const search = searchValue.toLowerCase();
  const sort = document.getElementById("sitesSort")?.value || "recent";

  let rows = list;
  if (search) {
    rows = rows.filter((site) => String(site?.site || "").toLowerCase().includes(search));
  }

  rows.sort((a, b) => compareSites(sort, a, b));
  meta.textContent = buildMetaText({ totalSites: list.length, matchingSites: rows.length, search });

  grid.innerHTML = "";

  if (!list.length) {
    grid.appendChild(createEmptyState("No sites yet", "Sites will appear here once privacy events are observed."));
    return;
  }

  if (!rows.length) {
    grid.appendChild(createEmptyState(`No matches for "${searchValue}"`, "Try a different search or clear it to view tracked sites."));
    return;
  }

  for (const site of rows) {
    grid.appendChild(createSiteCard(site));
  }
}

// Bridge for non-module dashboard.js
window.VPT = window.VPT || {};
window.VPT.features = window.VPT.features || {};
window.VPT.features.sites = { initSitesFeature, renderSitesWall };
