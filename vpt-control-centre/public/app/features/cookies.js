// public/app/features/cookies.js

let selectedCookieSite = null;
let cookiesViewMode = "grid"; // "grid" or "detail"
let getLatestEventsCb = null;

function getUtils() {
  const utils = window.VPT?.utils;
  if (!utils) {
    console.error("[cookies] VPT.utils missing (did app/core.js load first?)");
    return null;
  }
  return utils;
}

function buildCookieSnapshots(events) {
  const bySite = new Map();

  for (const ev of events || []) {
    if (ev.kind !== "cookies.snapshot") continue;
    const d = ev.data || {};
    const site = ev.site || d.siteBase || "unknown";

    const existing = bySite.get(site);
    if (existing && existing.ts >= (ev.ts || 0)) continue; // keep newest

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
  const utils = getUtils();
  if (!utils) return;
  const { friendlyTime, escapeHtml } = utils;

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
  subtitle.textContent = `Latest snapshot for ${site} at ${friendlyTime(ts)} (local time)`;

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
        <tbody>${rowsHtml}</tbody>
      </table>
    </div>
  `;
}

export function renderCookiesView(events) {
  const utils = getUtils();
  if (!utils) return;
  const { friendlyTime, escapeHtml } = utils;

  const snapshots = buildCookieSnapshots(events);

  const statSites = document.getElementById("cookieStatSites");
  const statTotal = document.getElementById("cookieStatTotal");
  const statThird = document.getElementById("cookieStatThird");
  const grid = document.getElementById("cookiesGrid");
  const wallSection = document.getElementById("cookiesWall");
  const detailSection = document.getElementById("cookiesDetailView");

  if (!statSites || !statTotal || !statThird || !grid || !wallSection || !detailSection) return;

  const totalSites = snapshots.length;
  const totalCookies = snapshots.reduce((sum, s) => sum + s.count, 0);
  const totalThird = snapshots.reduce((sum, s) => sum + s.third, 0);

  statSites.textContent = totalSites;
  statTotal.textContent = totalCookies;
  statThird.textContent = totalThird;

  grid.innerHTML = "";

  if (!snapshots.length) {
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

  if (!selectedCookieSite || !snapshots.some(s => s.site === selectedCookieSite)) {
    selectedCookieSite = snapshots[0].site;
  }

  snapshots.sort((a, b) => b.count - a.count);

  for (const snapshot of snapshots) {
    const first = snapshot.count - snapshot.third;

    const card = document.createElement("button");
    card.type = "button";
    card.className = "cookie-card";
    if (snapshot.site === selectedCookieSite) card.classList.add("selected");

    card.innerHTML = `
      <div class="cookie-card-site">${escapeHtml(snapshot.site)}</div>
      <div class="cookie-card-count">${snapshot.count}</div>
      <div class="cookie-card-meta">${first} first-party · ${snapshot.third} third-party</div>
      <div class="cookie-badges">
        <span class="cookie-chip">Latest: ${friendlyTime(snapshot.ts)}</span>
      </div>
    `;

    card.addEventListener("click", () => {
      selectedCookieSite = snapshot.site;
      cookiesViewMode = "detail";
      const latest = getLatestEventsCb ? getLatestEventsCb() : events;
      renderCookiesView(latest);
    });

    grid.appendChild(card);
  }

  if (cookiesViewMode === "detail") {
    wallSection.classList.add("hidden");
    detailSection.classList.remove("hidden");

    const selected = snapshots.find(s => s.site === selectedCookieSite) || snapshots[0];
    renderCookieDetails(selected);
  } else {
    cookiesViewMode = "grid";
    wallSection.classList.remove("hidden");
    detailSection.classList.add("hidden");
    renderCookieDetails(null);
  }
}

export function initCookiesFeature({ getLatestEvents } = {}) {
  getLatestEventsCb = typeof getLatestEvents === "function" ? getLatestEvents : null;

  const cookiesBackBtn = document.getElementById("cookiesBackBtn");
  if (cookiesBackBtn) {
    cookiesBackBtn.addEventListener("click", () => {
      cookiesViewMode = "grid";
      const latest = getLatestEventsCb ? getLatestEventsCb() : [];
      renderCookiesView(latest);
    });
  }
}

// Bridge for non-module dashboard.js
window.VPT = window.VPT || {};
window.VPT.features = window.VPT.features || {};
window.VPT.features.cookies = { initCookiesFeature, renderCookiesView };
