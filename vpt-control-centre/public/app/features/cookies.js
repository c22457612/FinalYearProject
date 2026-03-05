// public/app/features/cookies.js

let getLatestEventsCb = null;
let activeSiteFilter = null;
let selectedCookieSite = null;
let cookiesWallMode = "grid"; // "grid" or "detail"
let siteTableExpanded = false;
let carouselBound = false;

function getUtils() {
  const utils = window.VPT?.utils;
  if (!utils) {
    console.error("[cookies] VPT.utils missing (did app/core.js load first?)");
    return null;
  }
  return utils;
}

function normalizeSite(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
}

function safeInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function formatCount(value) {
  return new Intl.NumberFormat().format(Number(value) || 0);
}

function percent(value, total) {
  if (!total) return 0;
  return Math.round((value / total) * 100);
}

function normalizeHost(raw) {
  const input = String(raw || "").trim().toLowerCase();
  if (!input) return "";
  try {
    if (input.includes("://")) {
      const host = new URL(input).hostname || "";
      return host.replace(/^www\./, "");
    }
  } catch {
    // fall through to best-effort parsing
  }

  const host = input.split("/")[0].replace(/^www\./, "");
  return host;
}

function buildCookieSnapshots(events, siteFilter = null) {
  const bySite = new Map();
  const scopedSite = siteFilter ? normalizeSite(siteFilter) : null;

  for (const ev of events || []) {
    if (ev?.kind !== "cookies.snapshot") continue;

    const data = ev?.data && typeof ev.data === "object" ? ev.data : {};
    const site = normalizeSite(ev?.site || data.siteBase || "unknown");
    if (scopedSite && scopedSite !== site) continue;

    const existing = bySite.get(site);
    const ts = Number(ev?.ts) || 0;
    if (existing && existing.ts >= ts) continue;

    const cookies = Array.isArray(data.cookies) ? data.cookies : [];
    const count = data.count != null ? safeInt(data.count, cookies.length) : cookies.length;
    const third = data.thirdPartyCount != null
      ? safeInt(data.thirdPartyCount, cookies.filter((c) => c?.isThirdParty === true).length)
      : cookies.filter((c) => c?.isThirdParty === true).length;

    bySite.set(site, {
      site,
      ts,
      count,
      third,
      cookies,
    });
  }

  return Array.from(bySite.values()).sort((a, b) => b.count - a.count || b.ts - a.ts);
}

function deriveEventActorSignals(ev) {
  const data = ev?.data && typeof ev.data === "object" ? ev.data : {};
  const signals = [];

  const cookies = Array.isArray(data.cookies) ? data.cookies : [];
  for (const c of cookies) {
    const host = normalizeHost(c?.domain || "");
    if (host) signals.push(host);
  }

  const domain = normalizeHost(data.domain || "");
  if (domain) signals.push(domain);

  const urlDomain = normalizeHost(data.url || "");
  if (urlDomain) signals.push(urlDomain);

  if (!signals.length) {
    const vendorLabel = String(data.vendorName || data.vendorId || "").trim();
    if (vendorLabel) signals.push(vendorLabel);
  }

  return signals;
}

function derivePartyCountsForEvent(ev) {
  const data = ev?.data && typeof ev.data === "object" ? ev.data : {};
  const cookies = Array.isArray(data.cookies) ? data.cookies : [];
  const kind = String(ev?.kind || "");

  let firstParty = 0;
  let thirdParty = 0;
  let unknown = 0;

  if (kind === "cookies.snapshot") {
    const total = safeInt(data.count, cookies.length);
    const thirdFromCookies = cookies.filter((c) => c?.isThirdParty === true).length;
    const third = Math.min(total, safeInt(data.thirdPartyCount, thirdFromCookies));
    const first = Math.max(total - third, 0);
    firstParty += first;
    thirdParty += third;
  } else if (typeof data.total === "number" || typeof data.thirdPartyCount === "number") {
    const total = Math.max(1, safeInt(data.total, 0));
    const third = Math.min(total, safeInt(data.thirdPartyCount, 0));
    const first = Math.max(total - third, 0);
    firstParty += first;
    thirdParty += third;
  } else if (typeof data.isThirdParty === "boolean") {
    if (data.isThirdParty) thirdParty += 1;
    else firstParty += 1;
  }

  if (firstParty + thirdParty + unknown === 0) {
    unknown = 1;
  }

  return { firstParty, thirdParty, unknown };
}

function deriveCookieDashboardData(events, siteFilter = null) {
  const filter = siteFilter ? normalizeSite(siteFilter) : null;
  const actorCounts = new Map();
  const sites = new Map();

  let totalSignals = 0;
  let firstParty = 0;
  let thirdParty = 0;
  let unknownParty = 0;
  let lastSeenTs = 0;

  for (const ev of events || []) {
    const kind = String(ev?.kind || "");
    if (!kind.startsWith("cookies.")) continue;

    const site = normalizeSite(ev?.site || ev?.data?.siteBase || "unknown");
    if (filter && site !== filter) continue;

    totalSignals += 1;
    lastSeenTs = Math.max(lastSeenTs, Number(ev?.ts) || 0);

    const siteRow = sites.get(site) || {
      site,
      totalSignals: 0,
      firstParty: 0,
      thirdParty: 0,
      unknownParty: 0,
      lastSeenTs: 0,
    };

    siteRow.totalSignals += 1;
    siteRow.lastSeenTs = Math.max(siteRow.lastSeenTs, Number(ev?.ts) || 0);

    const party = derivePartyCountsForEvent(ev);
    siteRow.firstParty += party.firstParty;
    siteRow.thirdParty += party.thirdParty;
    siteRow.unknownParty += party.unknown;
    firstParty += party.firstParty;
    thirdParty += party.thirdParty;
    unknownParty += party.unknown;

    const actorSignals = deriveEventActorSignals(ev);
    for (const actor of actorSignals) {
      actorCounts.set(actor, (actorCounts.get(actor) || 0) + 1);
    }

    sites.set(site, siteRow);
  }

  const siteRows = Array.from(sites.values())
    .sort((a, b) =>
      (b.totalSignals - a.totalSignals)
      || (b.thirdParty - a.thirdParty)
      || (b.lastSeenTs - a.lastSeenTs)
      || a.site.localeCompare(b.site)
    );

  const topActors = Array.from(actorCounts.entries())
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => (b.count - a.count) || a.label.localeCompare(b.label))
    .slice(0, 10);

  return {
    totalSignals,
    distinctSites: siteRows.length,
    distinctActors: actorCounts.size,
    lastSeenTs,
    firstParty,
    thirdParty,
    unknownParty,
    topActors,
    siteRows,
  };
}

function buildDonutGradient(segments, total) {
  if (!total) return "conic-gradient(rgba(148, 163, 184, 0.45) 0 100%)";
  let cursor = 0;
  const stops = [];
  for (const segment of segments) {
    const value = Math.max(0, Number(segment.value) || 0);
    if (!value) continue;
    const share = (value / total) * 100;
    const start = cursor;
    const end = Math.min(100, cursor + share);
    stops.push(`${segment.color} ${start.toFixed(2)}% ${end.toFixed(2)}%`);
    cursor = end;
  }
  if (!stops.length) return "conic-gradient(rgba(148, 163, 184, 0.45) 0 100%)";
  if (cursor < 100) {
    stops.push(`rgba(148, 163, 184, 0.25) ${cursor.toFixed(2)}% 100%`);
  }
  return `conic-gradient(${stops.join(", ")})`;
}

function renderDonutBlock({
  title,
  centerLabel,
  total,
  segments,
}) {
  const totalValue = Math.max(0, Number(total) || 0);
  const gradient = buildDonutGradient(segments, totalValue);

  const legendHtml = segments.map((segment) => {
    const value = Math.max(0, Number(segment.value) || 0);
    const pct = percent(value, totalValue);
    return `
      <div class="cookies-donut-legend-row">
        <span class="cookies-donut-dot" style="background:${segment.color};"></span>
        <span class="cookies-donut-name">${segment.label}</span>
        <strong>${formatCount(value)} (${pct}%)</strong>
      </div>
    `;
  }).join("");

  return `
    <div class="cookies-donut-block">
      ${title ? `<div class="cookies-donut-title">${title}</div>` : ""}
      <div class="cookies-donut-wrap">
        <div class="cookies-donut-ring" style="background:${gradient};">
          <div class="cookies-donut-center">
            <strong>${formatCount(totalValue)}</strong>
            <span>${centerLabel}</span>
          </div>
        </div>
        <div class="cookies-donut-legend">${legendHtml}</div>
      </div>
    </div>
  `;
}

function renderKpis(data) {
  const totalEl = document.getElementById("cookieKpiTotalSignals");
  const sitesEl = document.getElementById("cookieKpiDistinctSites");
  const actorsEl = document.getElementById("cookieKpiDistinctActors");
  const lastSeenEl = document.getElementById("cookieKpiLastSeen");
  if (!totalEl || !sitesEl || !actorsEl || !lastSeenEl) return;

  const utils = getUtils();
  if (!utils) return;

  totalEl.textContent = formatCount(data.totalSignals);
  sitesEl.textContent = formatCount(data.distinctSites);
  actorsEl.textContent = formatCount(data.distinctActors);
  lastSeenEl.textContent = data.lastSeenTs ? utils.friendlyTime(data.lastSeenTs) : "-";
}

function renderPartySplit(data) {
  const container = document.getElementById("cookiePartySplitVisual");
  if (!container) return;

  const total = data.firstParty + data.thirdParty + data.unknownParty;
  if (!total) {
    container.innerHTML = '<div class="cookies-empty-hint">No split available yet.</div>';
    return;
  }

  container.innerHTML = renderDonutBlock({
    title: "",
    centerLabel: "signals",
    total,
    segments: [
      { label: "First-party", value: data.firstParty, color: "rgba(34, 197, 94, 0.95)" },
      { label: "Third-party", value: data.thirdParty, color: "rgba(59, 130, 246, 0.98)" },
      { label: "Unknown", value: data.unknownParty, color: "rgba(148, 163, 184, 0.95)" },
    ],
  });
}

function renderFocusedInsights(scopeData, allData, snapshotBySite) {
  const container = document.getElementById("cookieFocusedInsightsVisual");
  if (!container) return;

  const utils = getUtils();
  if (!utils) return;

  if (!activeSiteFilter || !scopeData.totalSignals) {
    container.innerHTML = "";
    return;
  }

  const focusedSnapshot = snapshotBySite.get(activeSiteFilter) || null;
  const focusedCookies = focusedSnapshot ? focusedSnapshot.count : 0;
  const siteShare = scopeData.totalSignals;
  const otherSignals = Math.max((allData.totalSignals || 0) - siteShare, 0);
  const lastSeen = scopeData.lastSeenTs ? utils.friendlyTime(scopeData.lastSeenTs) : "-";

  const primaryDonut = renderDonutBlock({
    title: "Focused party split",
    centerLabel: "events",
    total: scopeData.firstParty + scopeData.thirdParty + scopeData.unknownParty,
    segments: [
      { label: "First-party", value: scopeData.firstParty, color: "rgba(34, 197, 94, 0.95)" },
      { label: "Third-party", value: scopeData.thirdParty, color: "rgba(59, 130, 246, 0.98)" },
      { label: "Unknown", value: scopeData.unknownParty, color: "rgba(148, 163, 184, 0.95)" },
    ],
  });

  const shareDonut = renderDonutBlock({
    title: "Focused signal share",
    centerLabel: "signals",
    total: siteShare + otherSignals,
    segments: [
      { label: "Focused site", value: siteShare, color: "rgba(244, 114, 182, 0.98)" },
      { label: "Other sites", value: otherSignals, color: "rgba(148, 163, 184, 0.9)" },
    ],
  });

  container.innerHTML = `
    <div class="cookies-focused-grid">
      ${primaryDonut}
      ${shareDonut}
      <div class="cookies-focus-stats">
        <div class="cookies-focus-stat">
          <span>Cookie signals</span>
          <strong>${formatCount(scopeData.totalSignals)}</strong>
        </div>
        <div class="cookies-focus-stat">
          <span>Distinct domains/vendors</span>
          <strong>${formatCount(scopeData.distinctActors)}</strong>
        </div>
        <div class="cookies-focus-stat">
          <span>Cookies in latest snapshot</span>
          <strong>${formatCount(focusedCookies)}</strong>
        </div>
        <div class="cookies-focus-stat">
          <span>Last seen</span>
          <strong>${utils.escapeHtml(lastSeen)}</strong>
        </div>
      </div>
    </div>
  `;
}

function renderTopActors(data) {
  const container = document.getElementById("cookieTopActorsRank");
  if (!container) return;

  if (!data.topActors.length) {
    container.innerHTML = '<div class="cookies-empty-hint">No domain/vendor activity observed yet.</div>';
    return;
  }

  const max = Math.max(...data.topActors.map((row) => row.count), 1);
  const utils = getUtils();
  if (!utils) return;

  container.innerHTML = data.topActors.map((row) => {
    const width = Math.max(6, Math.round((row.count / max) * 100));
    return `
      <div class="cookies-actor-row">
        <div class="cookies-actor-head">
          <span class="cookies-actor-label">${utils.escapeHtml(row.label)}</span>
          <strong>${formatCount(row.count)}</strong>
        </div>
        <div class="cookies-actor-bar-track">
          <span class="cookies-actor-bar-fill" style="width:${width}%"></span>
        </div>
      </div>
    `;
  }).join("");
}

function syncSiteTableExpansion() {
  const body = document.getElementById("cookiesSiteTableCollapsible");
  const toggleBtn = document.getElementById("cookiesToggleSiteTableBtn");
  if (!body || !toggleBtn) return;
  body.classList.toggle("hidden", !siteTableExpanded);
  toggleBtn.setAttribute("aria-expanded", siteTableExpanded ? "true" : "false");
  toggleBtn.textContent = siteTableExpanded ? "Hide full site table" : "Show full site table";
}

function renderSiteTable(allData) {
  const tbody = document.getElementById("cookieSiteActivityBody");
  const activeLabel = document.getElementById("cookiesActiveSiteLabel");
  const clearBtn = document.getElementById("cookiesClearSiteFilterBtn");
  if (!tbody || !activeLabel || !clearBtn) return;

  const utils = getUtils();
  if (!utils) return;

  if (activeSiteFilter && !allData.siteRows.some((row) => row.site === activeSiteFilter)) {
    activeSiteFilter = null;
  }

  if (!allData.siteRows.length) {
    tbody.innerHTML = `
      <tr>
        <td class="cookies-table-empty" colspan="5">No site activity available.</td>
      </tr>
    `;
    activeLabel.textContent = "Showing all sites";
    clearBtn.classList.add("hidden");
    return;
  }

  tbody.innerHTML = "";
  for (const row of allData.siteRows) {
    const tr = document.createElement("tr");
    tr.className = "cookies-site-row";
    if (activeSiteFilter === row.site) tr.classList.add("active");

    tr.innerHTML = `
      <td>${utils.escapeHtml(row.site)}</td>
      <td>${formatCount(row.totalSignals)}</td>
      <td>${formatCount(row.firstParty)}</td>
      <td>${formatCount(row.thirdParty)}</td>
      <td>${row.lastSeenTs ? utils.escapeHtml(utils.friendlyTime(row.lastSeenTs)) : "-"}</td>
    `;

    tr.addEventListener("click", () => {
      if (activeSiteFilter === row.site) {
        activeSiteFilter = null;
        cookiesWallMode = "grid";
      } else {
        activeSiteFilter = row.site;
        selectedCookieSite = row.site;
      }
      const latest = getLatestEventsCb ? getLatestEventsCb() : [];
      renderCookiesView(latest);
    });

    tbody.appendChild(tr);
  }

  if (activeSiteFilter) {
    activeLabel.textContent = `Focused site: ${activeSiteFilter}`;
    clearBtn.classList.remove("hidden");
  } else {
    activeLabel.textContent = "Showing all sites";
    clearBtn.classList.add("hidden");
  }
}

function renderSubtitle(scopeData, allData) {
  const subtitle = document.getElementById("cookiesSummarySubtitle");
  if (!subtitle) return;

  const utils = getUtils();
  if (!utils) return;

  if (!allData.totalSignals) {
    subtitle.textContent = "No cookie data observed yet. Use the extension while browsing, then revisit this carousel.";
    return;
  }

  if (activeSiteFilter && scopeData.totalSignals) {
    const lastSeenFocused = scopeData.lastSeenTs ? utils.friendlyTime(scopeData.lastSeenTs) : "n/a";
    subtitle.textContent = `Focused on ${activeSiteFilter}: ${formatCount(scopeData.totalSignals)} signals. Last seen ${lastSeenFocused}.`;
    return;
  }

  const lastSeen = allData.lastSeenTs ? utils.friendlyTime(allData.lastSeenTs) : "n/a";
  subtitle.textContent = `${formatCount(allData.totalSignals)} cookie signals across ${formatCount(allData.distinctSites)} sites. Last seen ${lastSeen}.`;
}

function renderEmptyState(allData) {
  const empty = document.getElementById("cookiesEmptyState");
  if (!empty) return;
  empty.classList.toggle("hidden", allData.totalSignals > 0);
}

function renderCookieDetails(snapshot) {
  const utils = getUtils();
  if (!utils) return;

  const body = document.getElementById("cookies-details-body");
  const subtitle = document.getElementById("cookies-details-subtitle");
  if (!body || !subtitle) return;

  if (!snapshot) {
    subtitle.textContent = "Click a site card to see its cookies.";
    body.innerHTML = '<div class="details-placeholder">No site selected.</div>';
    return;
  }

  const { friendlyTime, escapeHtml } = utils;
  const site = snapshot.site;
  const ts = snapshot.ts;
  const count = snapshot.count;
  const third = snapshot.third;
  const first = Math.max(count - third, 0);
  const cookies = Array.isArray(snapshot.cookies) ? snapshot.cookies : [];

  subtitle.textContent = `Latest snapshot for ${site} at ${friendlyTime(ts)} (local time)`;

  if (!cookies.length) {
    body.innerHTML = `
      <div class="cookies-details-summary">
        <div>${count} cookie${count === 1 ? "" : "s"} in this snapshot.</div>
        <div>${first} first-party | ${third} third-party</div>
      </div>
      <p class="muted">No individual cookie details were recorded.</p>
    `;
    return;
  }

  const rowsHtml = cookies.slice(0, 100).map((c) => {
    const flags = [];
    if (c?.secure) flags.push("Secure");
    if (c?.httpOnly) flags.push("HttpOnly");
    if (c?.sameSite) flags.push(`SameSite=${c.sameSite}`);
    if (c?.session) flags.push("Session");
    const flagsText = flags.length ? flags.join(" | ") : "-";
    const expiry = c?.expiry
      ? new Date(c.expiry * 1000).toLocaleString()
      : (c?.session ? "Session" : "-");
    const party = c?.isThirdParty ? "third-party" : "first-party";

    return `
      <tr>
        <td class="cookie-name">${escapeHtml(c?.name || "")}</td>
        <td class="cookie-domain">${escapeHtml(c?.domain || "")}</td>
        <td>${party}</td>
        <td>${escapeHtml(flagsText)}</td>
        <td>${escapeHtml(expiry)}</td>
      </tr>
    `;
  }).join("");

  body.innerHTML = `
    <div class="cookies-details-summary">
      <div>${count} cookie${count === 1 ? "" : "s"} in this snapshot.</div>
      <div>${first} first-party | ${third} third-party</div>
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
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

function updateCarouselControls(itemCount = null) {
  const track = document.getElementById("cookiesCarouselTrack");
  const prevBtn = document.getElementById("cookiesCarouselPrevBtn");
  const nextBtn = document.getElementById("cookiesCarouselNextBtn");
  if (!track || !prevBtn || !nextBtn) return;

  const totalItems = itemCount != null ? itemCount : track.children.length;
  if (totalItems <= 1) {
    prevBtn.disabled = true;
    nextBtn.disabled = true;
    return;
  }

  const maxScroll = Math.max(0, track.scrollWidth - track.clientWidth);
  const atStart = track.scrollLeft <= 4;
  const atEnd = track.scrollLeft >= (maxScroll - 4);
  prevBtn.disabled = atStart;
  nextBtn.disabled = atEnd;
}

function bindCarouselControls() {
  if (carouselBound) return;
  const track = document.getElementById("cookiesCarouselTrack");
  const prevBtn = document.getElementById("cookiesCarouselPrevBtn");
  const nextBtn = document.getElementById("cookiesCarouselNextBtn");
  if (!track || !prevBtn || !nextBtn) return;

  const move = (direction) => {
    const distance = Math.max(240, Math.floor(track.clientWidth * 0.84));
    track.scrollBy({ left: direction * distance, behavior: "smooth" });
    window.setTimeout(() => updateCarouselControls(), 220);
  };

  prevBtn.addEventListener("click", () => move(-1));
  nextBtn.addEventListener("click", () => move(1));
  track.addEventListener("scroll", () => updateCarouselControls());
  window.addEventListener("resize", () => updateCarouselControls());
  carouselBound = true;
}

function renderCookieWall(events, allData, snapshots) {
  const track = document.getElementById("cookiesCarouselTrack");
  const emptyHero = document.getElementById("cookiesCarouselEmpty");
  const detailSection = document.getElementById("cookiesDetailView");
  if (!track || !detailSection || !emptyHero) return;

  const utils = getUtils();
  if (!utils) return;
  const { friendlyTime, escapeHtml } = utils;

  const snapshotRows = Array.isArray(snapshots) ? snapshots : [];
  const siteStats = new Map((allData?.siteRows || []).map((row) => [row.site, row]));

  track.innerHTML = "";

  if (!snapshotRows.length) {
    emptyHero.classList.remove("hidden");
    detailSection.classList.add("hidden");
    renderCookieDetails(null);
    selectedCookieSite = null;
    cookiesWallMode = "grid";
    updateCarouselControls(0);
    return;
  }

  emptyHero.classList.add("hidden");

  if (activeSiteFilter && snapshotRows.some((row) => row.site === activeSiteFilter)) {
    selectedCookieSite = activeSiteFilter;
  }
  if (!selectedCookieSite || !snapshotRows.some((row) => row.site === selectedCookieSite)) {
    selectedCookieSite = snapshotRows[0].site;
  }

  for (const snapshot of snapshotRows) {
    const row = siteStats.get(snapshot.site);
    const first = Math.max(snapshot.count - snapshot.third, 0);
    const totalSignals = row ? row.totalSignals : 0;

    const card = document.createElement("button");
    card.type = "button";
    card.className = "cookie-card";
    if (snapshot.site === selectedCookieSite) card.classList.add("selected");
    if (snapshot.site === activeSiteFilter) card.classList.add("focused");

    card.innerHTML = `
      <div class="cookie-card-site">${escapeHtml(snapshot.site)}</div>
      <div class="cookie-card-count">${formatCount(snapshot.count)} cookies</div>
      <div class="cookie-card-signal">${formatCount(totalSignals)} signals</div>
      <div class="cookie-card-meta">1P ${formatCount(first)} | 3P ${formatCount(snapshot.third)}</div>
      <div class="cookie-badges">
        <span class="cookie-chip">Last seen ${escapeHtml(friendlyTime(snapshot.ts))}</span>
      </div>
    `;

    card.addEventListener("click", () => {
      selectedCookieSite = snapshot.site;
      activeSiteFilter = snapshot.site;
      cookiesWallMode = "detail";
      const latest = getLatestEventsCb ? getLatestEventsCb() : (events || []);
      renderCookiesView(latest);
    });

    track.appendChild(card);
  }

  if (cookiesWallMode === "detail") {
    detailSection.classList.remove("hidden");
    const selected = snapshotRows.find((s) => s.site === selectedCookieSite) || snapshotRows[0];
    renderCookieDetails(selected);
  } else {
    detailSection.classList.add("hidden");
    renderCookieDetails(null);
  }

  updateCarouselControls(snapshotRows.length);
}

function renderFocusMode(scopeData, allData, snapshotBySite) {
  const root = document.getElementById("view-cookies");
  const focusBanner = document.getElementById("cookiesFocusBanner");
  const focusedSiteLabel = document.getElementById("cookiesFocusedSiteLabel");
  const focusedRow = document.getElementById("cookiesFocusedInsightsRow");
  const globalKpiRow = document.getElementById("cookiesGlobalKpiRow");
  const globalBreakdownRow = document.getElementById("cookiesGlobalBreakdownRow");
  const emptyState = document.getElementById("cookiesEmptyState");
  const siteTableSection = document.getElementById("cookiesSiteTableSection");

  if (!root || !focusBanner || !focusedSiteLabel || !focusedRow) return;

  const hasFocus = Boolean(activeSiteFilter && scopeData.totalSignals > 0);
  root.classList.toggle("cookies-focus-active", hasFocus);
  focusBanner.classList.toggle("hidden", !hasFocus);
  focusedRow.classList.toggle("hidden", !hasFocus);

  if (globalKpiRow) globalKpiRow.classList.toggle("hidden", hasFocus);
  if (globalBreakdownRow) globalBreakdownRow.classList.toggle("hidden", hasFocus);
  if (siteTableSection) siteTableSection.classList.toggle("cookies-muted-section", hasFocus);
  if (emptyState && hasFocus) emptyState.classList.add("hidden");

  if (!hasFocus) {
    focusedSiteLabel.textContent = "-";
    return;
  }

  focusedSiteLabel.textContent = activeSiteFilter;
  renderFocusedInsights(scopeData, allData, snapshotBySite);
}

export function renderCookiesView(events) {
  const sourceEvents = events || [];
  const allData = deriveCookieDashboardData(sourceEvents);
  if (activeSiteFilter && !allData.siteRows.some((row) => row.site === activeSiteFilter)) {
    activeSiteFilter = null;
  }
  const scopeData = activeSiteFilter
    ? deriveCookieDashboardData(sourceEvents, activeSiteFilter)
    : allData;
  const snapshots = buildCookieSnapshots(sourceEvents);
  const snapshotBySite = new Map(snapshots.map((row) => [row.site, row]));

  renderKpis(scopeData);
  renderPartySplit(scopeData);
  renderTopActors(scopeData);
  renderSiteTable(allData);
  syncSiteTableExpansion();
  renderSubtitle(scopeData, allData);
  renderEmptyState(allData);
  renderCookieWall(sourceEvents, allData, snapshots);
  renderFocusMode(scopeData, allData, snapshotBySite);
}

function clearFocusState() {
  activeSiteFilter = null;
  cookiesWallMode = "grid";
}

export function initCookiesFeature({ getLatestEvents } = {}) {
  getLatestEventsCb = typeof getLatestEvents === "function" ? getLatestEvents : null;
  bindCarouselControls();
  syncSiteTableExpansion();

  const clearBtn = document.getElementById("cookiesClearSiteFilterBtn");
  if (clearBtn) {
    clearBtn.addEventListener("click", () => {
      clearFocusState();
      const latest = getLatestEventsCb ? getLatestEventsCb() : [];
      renderCookiesView(latest);
    });
  }

  const clearFocusBtn = document.getElementById("cookiesClearFocusBtn");
  if (clearFocusBtn) {
    clearFocusBtn.addEventListener("click", () => {
      clearFocusState();
      const latest = getLatestEventsCb ? getLatestEventsCb() : [];
      renderCookiesView(latest);
    });
  }

  const toggleTableBtn = document.getElementById("cookiesToggleSiteTableBtn");
  if (toggleTableBtn) {
    toggleTableBtn.addEventListener("click", () => {
      siteTableExpanded = !siteTableExpanded;
      syncSiteTableExpansion();
    });
  }

  const backBtn = document.getElementById("cookiesBackBtn");
  if (backBtn) {
    backBtn.addEventListener("click", () => {
      cookiesWallMode = "grid";
      const latest = getLatestEventsCb ? getLatestEventsCb() : [];
      renderCookiesView(latest);
    });
  }
}

// Bridge for non-module dashboard.js
window.VPT = window.VPT || {};
window.VPT.features = window.VPT.features || {};
window.VPT.features.cookies = { initCookiesFeature, renderCookiesView };
