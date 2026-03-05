// public/app/features/cookies.js

let getLatestEventsCb = null;
let activeSiteFilter = null;
let selectedCookieSite = null;
let cookiesWallMode = "grid"; // "grid" or "detail"
let modalEventsBound = false;
let modalOpen = false;
let modalSearchTerm = "";
let modalSortMode = "activity";
let modalReturnFocusEl = null;
let allSiteCardsCache = [];

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

function isBlockedCookieEvent(ev) {
  const kind = String(ev?.kind || "").toLowerCase();
  const data = ev?.data && typeof ev.data === "object" ? ev.data : {};
  const outcome = String(data.outcome || data.mitigation_status || "").toLowerCase();
  return (
    kind.includes("blocked")
    || data.blocked === true
    || data.wasBlocked === true
    || outcome === "blocked"
  );
}

function deriveCookieDashboardData(events, siteFilter = null) {
  const filter = siteFilter ? normalizeSite(siteFilter) : null;
  const actorCounts = new Map();
  const sites = new Map();

  let totalSignals = 0;
  let firstParty = 0;
  let thirdParty = 0;
  let unknownParty = 0;
  let blockedAttempts = 0;
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
      blockedAttempts: 0,
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

    if (isBlockedCookieEvent(ev)) {
      siteRow.blockedAttempts += 1;
      blockedAttempts += 1;
    }

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
    blockedAttempts,
    topActors,
    siteRows,
  };
}

function buildSiteCards(allData, snapshots) {
  const snapshotBySite = new Map((snapshots || []).map((row) => [row.site, row]));
  const cards = (allData?.siteRows || []).map((row) => {
    const snapshot = snapshotBySite.get(row.site) || null;
    const partyTotal = row.firstParty + row.thirdParty + row.unknownParty;
    const cookieCount = snapshot
      ? snapshot.count
      : Math.max(row.firstParty + row.thirdParty + row.unknownParty, 0);
    const thirdCount = snapshot ? snapshot.third : row.thirdParty;
    const firstCount = snapshot ? Math.max(snapshot.count - snapshot.third, 0) : row.firstParty;

    return {
      site: row.site,
      totalSignals: row.totalSignals,
      cookieCount,
      firstCount,
      thirdCount,
      unknownCount: row.unknownParty,
      blockedAttempts: row.blockedAttempts || 0,
      lastSeenTs: row.lastSeenTs || 0,
      thirdShare: partyTotal > 0 ? (row.thirdParty / partyTotal) : 0,
      unknownShare: partyTotal > 0 ? (row.unknownParty / partyTotal) : 0,
    };
  });

  cards.sort((a, b) =>
    (b.totalSignals - a.totalSignals)
    || (b.thirdCount - a.thirdCount)
    || (b.lastSeenTs - a.lastSeenTs)
    || a.site.localeCompare(b.site)
  );
  return cards;
}

function comparePriority(a, b) {
  return (
    (b.totalSignals - a.totalSignals)
    || (b.thirdCount - a.thirdCount)
    || (b.lastSeenTs - a.lastSeenTs)
    || a.site.localeCompare(b.site)
  );
}

function selectHighlights(siteCards) {
  if (!siteCards.length) return [];

  const maxHighlights = Math.min(8, siteCards.length);
  const selected = [];
  const seen = new Set();

  function pickBest(reason, scoreFn, predicate = () => true) {
    let bestCard = null;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const card of siteCards) {
      if (seen.has(card.site) || !predicate(card)) continue;
      const score = Number(scoreFn(card));
      if (!Number.isFinite(score)) continue;

      if (score > bestScore) {
        bestCard = card;
        bestScore = score;
        continue;
      }

      if (Math.abs(score - bestScore) < 1e-9 && bestCard && comparePriority(card, bestCard) < 0) {
        bestCard = card;
        bestScore = score;
      }
    }

    if (!bestCard) return;
    seen.add(bestCard.site);
    selected.push({ ...bestCard, reason });
  }

  pickBest("Most third-party", (card) => card.thirdShare, (card) => card.thirdShare > 0);
  pickBest("Most activity", (card) => card.totalSignals, (card) => card.totalSignals > 0);
  pickBest("Most recent", (card) => card.lastSeenTs, (card) => card.lastSeenTs > 0);
  pickBest("Most unknown", (card) => card.unknownShare, (card) => card.unknownShare > 0);
  pickBest("Most blocked", (card) => card.blockedAttempts, (card) => card.blockedAttempts > 0);

  for (const card of siteCards) {
    if (selected.length >= maxHighlights) break;
    if (seen.has(card.site)) continue;
    seen.add(card.site);
    selected.push({ ...card, reason: "High activity" });
  }

  return selected;
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

function renderWhyMatters(scopeData, allData, snapshotBySite) {
  const container = document.getElementById("cookieWhyMattersPanel");
  if (!container) return;

  const utils = getUtils();
  if (!utils) return;

  if (!activeSiteFilter || !scopeData.totalSignals) {
    const totalParty = allData.firstParty + allData.thirdParty + allData.unknownParty;
    const thirdPct = percent(allData.thirdParty, totalParty);
    const unknownPct = percent(allData.unknownParty, totalParty);

    container.innerHTML = `
      <section class="cookies-narrative-section">
        <h4>Global snapshot</h4>
        <p>
          Third-party cookies can increase cross-site tracking exposure, while unknown-party signals reduce clarity about who is involved.
        </p>
      </section>
      <section class="cookies-narrative-section">
        <h4>What this means</h4>
        <ul>
          <li>${formatCount(allData.thirdParty)} third-party signals (${thirdPct}%) suggest external cookie activity.</li>
          <li>${formatCount(allData.unknownParty)} unknown-party signals (${unknownPct}%) indicate limited attribution confidence.</li>
          <li>Use Highlights or "View all sites" to focus on sites with stronger third-party or unknown patterns.</li>
        </ul>
      </section>
      <section class="cookies-narrative-section">
        <h4>What we capture</h4>
        <p>
          We store event-level signals, counts, domains, timing, and party classification. Raw personal values are not stored here.
        </p>
      </section>
    `;
    return;
  }

  const focusedSnapshot = snapshotBySite.get(activeSiteFilter) || null;
  const lastSeen = scopeData.lastSeenTs ? utils.friendlyTime(scopeData.lastSeenTs) : "-";
  const firstCount = focusedSnapshot ? Math.max(focusedSnapshot.count - focusedSnapshot.third, 0) : scopeData.firstParty;
  const thirdCount = focusedSnapshot ? focusedSnapshot.third : scopeData.thirdParty;
  const totalSignals = scopeData.totalSignals;
  const siteUrl = `/site.html?site=${encodeURIComponent(activeSiteFilter)}`;

  container.innerHTML = `
    <section class="cookies-narrative-section">
      <h4>What we saw</h4>
      <ul>
        <li>Total signals: ${formatCount(totalSignals)}</li>
        <li>First-party: ${formatCount(firstCount)} | Third-party: ${formatCount(thirdCount)}</li>
        <li>Last seen: ${utils.escapeHtml(lastSeen)}</li>
      </ul>
    </section>
    <section class="cookies-narrative-section">
      <h4>Why it matters</h4>
      <ul>
        <li>Third-party cookie activity can support tracking that follows users across sites.</li>
        <li>Higher third-party share can increase data-sharing exposure beyond the visited site.</li>
        <li>Signals show observed activity patterns, not confirmed storage or downstream use by vendors.</li>
      </ul>
    </section>
    <section class="cookies-narrative-section">
      <h4>Suggested actions</h4>
      <p class="cookies-guidance-text">Review this site in Site Insights for broader context, then adjust browser/site controls where needed.</p>
      <a class="btn-secondary cookies-guidance-action" href="${siteUrl}">Open Site Insights</a>
    </section>
    <section class="cookies-narrative-section">
      <h4>Limits</h4>
      <p>
        Raw cookie values are not stored in this view, and observed signals are not proof that a vendor stored or merged personal data.
      </p>
    </section>
  `;
}

function renderSignalsDisclaimer() {
  const el = document.getElementById("cookieSignalsDisclaimer");
  if (!el) return;
  el.textContent = "About these signals: they show observed cookie-related activity and timing, not proof of vendor-side storage.";
}

function renderSubtitle(scopeData, allData) {
  const subtitle = document.getElementById("cookiesSummarySubtitle");
  if (!subtitle) return;

  const utils = getUtils();
  if (!utils) return;

  if (!allData.totalSignals) {
    subtitle.textContent = "No cookie data observed yet. Use the extension while browsing, then revisit this page.";
    return;
  }

  if (activeSiteFilter && scopeData.totalSignals) {
    const lastSeenFocused = scopeData.lastSeenTs ? utils.friendlyTime(scopeData.lastSeenTs) : "n/a";
    subtitle.textContent = `Focused on ${activeSiteFilter}: ${formatCount(scopeData.totalSignals)} signals. Last seen ${lastSeenFocused}.`;
    return;
  }

  const lastSeen = allData.lastSeenTs ? utils.friendlyTime(allData.lastSeenTs) : "n/a";
  subtitle.textContent = `${formatCount(allData.totalSignals)} cookie signals across ${formatCount(allData.distinctSites)} sites. Highlights show notable sites first.`;
  if (lastSeen !== "n/a") subtitle.textContent += ` Last seen ${lastSeen}.`;
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

function renderSiteCardHtml(card, reason = "") {
  const utils = getUtils();
  if (!utils) return "";
  const lastSeen = card.lastSeenTs ? utils.friendlyTime(card.lastSeenTs) : "-";

  return `
    <div class="cookie-card-site">${utils.escapeHtml(card.site)}</div>
    <div class="cookie-card-count">${formatCount(card.cookieCount)} cookies</div>
    <div class="cookie-card-signal">${formatCount(card.totalSignals)} signals</div>
    <div class="cookie-card-meta">1P ${formatCount(card.firstCount)} | 3P ${formatCount(card.thirdCount)}</div>
    <div class="cookie-badges">
      <span class="cookie-chip">Last seen ${utils.escapeHtml(lastSeen)}</span>
      ${reason ? `<span class="cookie-chip cookie-reason-chip">${utils.escapeHtml(reason)}</span>` : ""}
    </div>
  `;
}

function closeAllSitesModal({ restoreFocus = true } = {}) {
  const modal = document.getElementById("cookiesAllSitesModal");
  if (!modal || !modalOpen) return;
  modalOpen = false;
  modal.classList.add("hidden");
  document.body.classList.remove("cookies-modal-open");
  if (restoreFocus && modalReturnFocusEl && typeof modalReturnFocusEl.focus === "function") {
    modalReturnFocusEl.focus();
  }
}

function applyFocusToSite(site, { openDetails = true, closeModal = false } = {}) {
  activeSiteFilter = normalizeSite(site);
  selectedCookieSite = activeSiteFilter;
  if (openDetails) cookiesWallMode = "detail";
  if (closeModal) closeAllSitesModal({ restoreFocus: false });
  const latest = getLatestEventsCb ? getLatestEventsCb() : [];
  renderCookiesView(latest);
}

function renderHighlights(highlights, allSiteCount) {
  const track = document.getElementById("cookiesHighlightsTrack");
  const emptyState = document.getElementById("cookiesHighlightsEmpty");
  const openBtn = document.getElementById("cookiesOpenAllSitesBtn");
  if (!track || !emptyState || !openBtn) return;

  openBtn.textContent = `View all sites (${formatCount(allSiteCount)})`;
  openBtn.disabled = allSiteCount === 0;

  track.innerHTML = "";
  if (!highlights.length) {
    emptyState.classList.remove("hidden");
    return;
  }

  emptyState.classList.add("hidden");
  for (const card of highlights) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cookie-card cookie-highlight-card";
    if (activeSiteFilter === card.site) button.classList.add("focused");
    button.innerHTML = renderSiteCardHtml(card, card.reason || "");
    button.addEventListener("click", () => {
      applyFocusToSite(card.site, { openDetails: true, closeModal: false });
    });
    track.appendChild(button);
  }
}

function renderDetailsPanel(snapshots) {
  const detailSection = document.getElementById("cookiesDetailView");
  if (!detailSection) return;

  const snapshotRows = Array.isArray(snapshots) ? snapshots : [];
  if (!snapshotRows.length) {
    detailSection.classList.add("hidden");
    renderCookieDetails(null);
    selectedCookieSite = null;
    cookiesWallMode = "grid";
    return;
  }

  if (activeSiteFilter && snapshotRows.some((row) => row.site === activeSiteFilter)) {
    selectedCookieSite = activeSiteFilter;
  }
  if (!selectedCookieSite || !snapshotRows.some((row) => row.site === selectedCookieSite)) {
    selectedCookieSite = snapshotRows[0].site;
  }

  if (cookiesWallMode !== "detail") {
    detailSection.classList.add("hidden");
    renderCookieDetails(null);
    return;
  }

  const selected = snapshotRows.find((row) => row.site === selectedCookieSite) || snapshotRows[0];
  detailSection.classList.remove("hidden");
  renderCookieDetails(selected);
}

function getFocusableElements(root) {
  if (!root) return [];
  const selector = [
    "a[href]",
    "button:not([disabled])",
    "input:not([disabled])",
    "select:not([disabled])",
    "textarea:not([disabled])",
    "[tabindex]:not([tabindex='-1'])",
  ].join(",");
  return Array.from(root.querySelectorAll(selector))
    .filter((el) => !el.hasAttribute("hidden") && el.getAttribute("aria-hidden") !== "true");
}

function sortModalCards(cards) {
  const list = cards.slice();
  if (modalSortMode === "third-party") {
    list.sort((a, b) =>
      (b.thirdShare - a.thirdShare)
      || (b.thirdCount - a.thirdCount)
      || comparePriority(a, b)
    );
    return list;
  }
  if (modalSortMode === "recent") {
    list.sort((a, b) =>
      (b.lastSeenTs - a.lastSeenTs)
      || comparePriority(a, b)
    );
    return list;
  }
  list.sort(comparePriority);
  return list;
}

function renderAllSitesModalGrid() {
  const grid = document.getElementById("cookiesAllSitesGrid");
  if (!grid) return;

  const term = modalSearchTerm.trim().toLowerCase();
  const filtered = allSiteCardsCache.filter((card) => (
    !term || card.site.toLowerCase().includes(term)
  ));
  const rows = sortModalCards(filtered);

  grid.innerHTML = "";
  if (!rows.length) {
    grid.innerHTML = '<div class="cookies-empty-hint">No sites match this filter.</div>';
    return;
  }

  for (const card of rows) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "cookie-card cookie-modal-card";
    if (activeSiteFilter === card.site) button.classList.add("focused");
    button.innerHTML = renderSiteCardHtml(card, "");
    button.addEventListener("click", () => {
      applyFocusToSite(card.site, { openDetails: true, closeModal: true });
    });
    grid.appendChild(button);
  }
}

function openAllSitesModal() {
  const modal = document.getElementById("cookiesAllSitesModal");
  const search = document.getElementById("cookiesAllSitesSearch");
  if (!modal) return;
  modalReturnFocusEl = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  modalOpen = true;
  modal.classList.remove("hidden");
  document.body.classList.add("cookies-modal-open");
  renderAllSitesModalGrid();
  if (search) search.focus();
}

function handleModalKeydown(event) {
  if (!modalOpen) return;
  const panel = document.getElementById("cookiesAllSitesPanel");
  if (!panel) return;

  if (event.key === "Escape") {
    event.preventDefault();
    closeAllSitesModal({ restoreFocus: true });
    return;
  }

  if (event.key !== "Tab") return;
  const focusable = getFocusableElements(panel);
  if (!focusable.length) {
    event.preventDefault();
    return;
  }

  const first = focusable[0];
  const last = focusable[focusable.length - 1];
  const active = document.activeElement;

  if (event.shiftKey) {
    if (active === first || !panel.contains(active)) {
      event.preventDefault();
      last.focus();
    }
    return;
  }

  if (active === last) {
    event.preventDefault();
    first.focus();
  }
}

function bindModalEvents() {
  if (modalEventsBound) return;
  const modal = document.getElementById("cookiesAllSitesModal");
  if (!modal) return;

  const openBtn = document.getElementById("cookiesOpenAllSitesBtn");
  const closeBtn = document.getElementById("cookiesAllSitesCloseBtn");
  const backdrop = document.getElementById("cookiesAllSitesBackdrop");
  const search = document.getElementById("cookiesAllSitesSearch");
  const sort = document.getElementById("cookiesAllSitesSort");

  if (openBtn) {
    openBtn.addEventListener("click", () => openAllSitesModal());
  }
  if (closeBtn) {
    closeBtn.addEventListener("click", () => closeAllSitesModal({ restoreFocus: true }));
  }
  if (backdrop) {
    backdrop.addEventListener("click", () => closeAllSitesModal({ restoreFocus: true }));
  }
  if (search) {
    search.addEventListener("input", (event) => {
      modalSearchTerm = String(event.target?.value || "");
      renderAllSitesModalGrid();
    });
  }
  if (sort) {
    sort.addEventListener("change", (event) => {
      modalSortMode = String(event.target?.value || "activity");
      renderAllSitesModalGrid();
    });
  }

  document.addEventListener("keydown", handleModalKeydown);
  modalEventsBound = true;
}

function renderFocusMode(scopeData, allData, snapshotBySite) {
  const root = document.getElementById("view-cookies");
  const focusBanner = document.getElementById("cookiesFocusBanner");
  const focusedSiteLabel = document.getElementById("cookiesFocusedSiteLabel");
  const focusedRow = document.getElementById("cookiesFocusedInsightsRow");
  const globalKpiRow = document.getElementById("cookiesGlobalKpiRow");
  const globalBreakdownRow = document.getElementById("cookiesGlobalBreakdownRow");
  const emptyState = document.getElementById("cookiesEmptyState");
  const highlightsSection = document.getElementById("cookiesHighlightsSection");

  if (!root || !focusBanner || !focusedSiteLabel || !focusedRow) return;

  const hasFocus = Boolean(activeSiteFilter && scopeData.totalSignals > 0);
  root.classList.toggle("cookies-focus-active", hasFocus);
  focusBanner.classList.toggle("hidden", !hasFocus);
  focusedRow.classList.toggle("hidden", !hasFocus);

  if (globalKpiRow) globalKpiRow.classList.toggle("hidden", hasFocus);
  if (globalBreakdownRow) globalBreakdownRow.classList.toggle("hidden", hasFocus);
  if (highlightsSection) highlightsSection.classList.toggle("cookies-highlights-dimmed", hasFocus);
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
  const siteCards = buildSiteCards(allData, snapshots);
  const highlights = selectHighlights(siteCards);
  allSiteCardsCache = siteCards;

  renderKpis(scopeData);
  renderPartySplit(scopeData);
  renderSignalsDisclaimer();
  renderWhyMatters(scopeData, allData, snapshotBySite);
  renderSubtitle(scopeData, allData);
  renderEmptyState(allData);
  renderHighlights(highlights, siteCards.length);
  renderDetailsPanel(snapshots);
  renderFocusMode(scopeData, allData, snapshotBySite);
  if (modalOpen) renderAllSitesModalGrid();
}

function clearFocusState() {
  activeSiteFilter = null;
  cookiesWallMode = "grid";
}

export function initCookiesFeature({ getLatestEvents } = {}) {
  getLatestEventsCb = typeof getLatestEvents === "function" ? getLatestEvents : null;
  bindModalEvents();

  const clearFocusBtn = document.getElementById("cookiesClearFocusBtn");
  if (clearFocusBtn) {
    clearFocusBtn.addEventListener("click", () => {
      clearFocusState();
      const latest = getLatestEventsCb ? getLatestEventsCb() : [];
      renderCookiesView(latest);
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
