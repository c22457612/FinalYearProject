let getLatestEventsCb = null;

const COOKIE_BRIDGE_SOURCE = "vpt_cookie_control";
const COOKIE_BRIDGE_REQUEST = "cookie_bridge_request";
const COOKIE_BRIDGE_RESPONSE = "cookie_bridge_response";
const COOKIE_BRIDGE_TIMEOUT_MS = 4500;

const state = {
  latestEvents: [],
  mode: "selector",
  selectedSite: null,
  selectorSearch: "",
  selectorSort: "review-priority",
  cookieSearch: "",
  cookiePartyFilter: "all",
  cookieSort: "review-priority",
  expandedCookieIndex: null,
  clearPending: false,
  clearStatus: { tone: "", message: "" },
  bridgeBound: false,
  bridgeSeq: 0,
  bridgePending: new Map(),
  lastDerived: null,
  lastSelectorSites: [],
  lastInspectorCookies: [],
};

const SESSION_RE = /(^|[_-])(session|sess|sid|phpsessid|jsessionid|auth|login|jwt|token|refresh|access)([_-]|$)/i;
const SECURITY_RE = /(^(__host-|__secure-))|csrf|xsrf|clearance|bot|shield|ak_bmsc|bm_sv|incap/i;
const PREF_RE = /consent|pref|prefs|preference|lang|locale|theme|currency|timezone|region|settings|remember/i;
const ANALYTICS_RE = /^(_ga|_gid|_gat|_pk_|_hj)|analytics|amplitude|mixpanel|segment|matomo|plausible|umami|clientid|client_id|cid/i;
const AD_RE = /^(_fbp|_fbc|_gcl)|doubleclick|adservice|campaign|promo|target|criteo|adroll|ttclid|clickid|gclid|fbclid|advert/i;
const SERVICE_RE = /youtube|vimeo|intercom|zendesk|stripe|paypal|shopify|cloudflare|hotjar|hubspot|chat|support|video|embed/i;
const COOKIE_ROLE_META = [
  { key: "Session or sign-in state", className: "role-session", short: "Session or sign-in state", description: "Often keeps a visit active or ties the browser to an account session." },
  { key: "Security or CSRF protection", className: "role-security", short: "Security or CSRF protection", description: "Often protects requests or forms and may trigger checks if cleared." },
  { key: "Preferences or remembered settings", className: "role-preferences", short: "Preferences or remembered settings", description: "Usually remembers settings such as language, region, theme, or consent choices." },
  { key: "Analytics or measurement", className: "role-analytics", short: "Analytics or measurement", description: "Usually measures visits or repeat activity and resets measurement IDs when cleared." },
  { key: "Advertising or attribution", className: "role-advertising", short: "Advertising or attribution", description: "Usually supports attribution or personalisation and is often lower-risk to clear." },
  { key: "Cross-site service / embedded content", className: "role-service", short: "Cross-site service / embedded content", description: "Often supports embedded tools such as chat, video, payments, or support widgets." },
  { key: "Unclear", className: "role-unclear", short: "Unclear", description: "The metadata is too weak to name a role confidently." },
];
const COOKIE_REVIEW_META = [
  { key: "Essential", className: "review-essential", short: "Essential", description: "Highest caution. Clearing may break sign-in, protection, or core state." },
  { key: "Helpful", className: "review-helpful", short: "Helpful", description: "Likely supports convenience or an embedded service, but may not be strictly required." },
  { key: "Optional", className: "review-optional", short: "Optional", description: "Usually site-related but lower functional risk if cleared." },
  { key: "Non-essential", className: "review-nonessential", short: "Non-essential", description: "Usually the safest group to clear without affecting core use." },
  { key: "Unclear", className: "review-unclear", short: "Unclear", description: "The likely impact of clearing cannot be predicted confidently." },
];
const COOKIE_ROLE_META_BY_KEY = new Map(COOKIE_ROLE_META.map((item) => [item.key, item]));
const COOKIE_REVIEW_META_BY_KEY = new Map(COOKIE_REVIEW_META.map((item) => [item.key, item]));

function getUtils() {
  const utils = window.VPT?.utils;
  if (!utils) {
    console.error("[cookies] VPT.utils missing (did app/core.js load first?)");
    return null;
  }
  return utils;
}

function getApi() {
  return window.VPT?.api || null;
}

function normalizeSite(value) {
  return typeof value === "string" && value.trim() ? value.trim() : "unknown";
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
  return input.split("/")[0].replace(/^www\./, "");
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

function escapeHtml(value) {
  const utils = getUtils();
  return utils?.escapeHtml ? utils.escapeHtml(String(value ?? "")) : String(value ?? "");
}

function friendlyTime(value) {
  const utils = getUtils();
  return utils?.friendlyTime ? utils.friendlyTime(value) : "-";
}

function partyLabel(party) {
  if (party === "third-party") return "Third-party";
  if (party === "first-party") return "First-party";
  return "Unclear";
}

function getRoleMeta(role) {
  return COOKIE_ROLE_META_BY_KEY.get(role) || COOKIE_ROLE_META_BY_KEY.get("Unclear");
}

function getReviewMeta(review) {
  return COOKIE_REVIEW_META_BY_KEY.get(review) || COOKIE_REVIEW_META_BY_KEY.get("Unclear");
}

function renderLegendChip(label, className) {
  return `<span class="cookies-label-chip ${escapeHtml(className)}">${escapeHtml(label)}</span>`;
}

function renderLegendSectionHtml(title, items, type) {
  const rows = items.map((item) => `
    <div class="cookies-legend-chart-row">
      <div class="cookies-legend-chart-label">
        ${renderLegendChip(item.short, `cookies-label-chip-${type} ${item.className}`)}
      </div>
      <div class="cookies-legend-chart-copy">${escapeHtml(item.description || "")}</div>
    </div>
  `).join("");

  return `
    <section class="cookies-legend-section">
      <div class="cookies-legend-section-title">${escapeHtml(title)}</div>
      <div class="cookies-legend-chart">
        <div class="cookies-legend-chart-head">
          <span>Label</span>
          <span>How to read it</span>
        </div>
        ${rows}
      </div>
    </section>
  `;
}

function renderLegendHtml() {
  return `
    <div class="cookies-legend-layout">
      ${renderLegendSectionHtml("Likely role", COOKIE_ROLE_META, "role")}
      ${renderLegendSectionHtml("Review label", COOKIE_REVIEW_META, "review")}
    </div>
  `;
}

function renderRoleChip(role) {
  const meta = getRoleMeta(role);
  return `<span class="cookies-label-chip cookies-label-chip-role ${escapeHtml(meta.className)}">${escapeHtml(meta.short)}</span>`;
}

function renderReviewChip(review) {
  const meta = getReviewMeta(review);
  return `<span class="cookies-label-chip cookies-label-chip-review ${escapeHtml(meta.className)}">${escapeHtml(meta.short)}</span>`;
}

function buildDonutGradient(segments, total) {
  if (!total) return "conic-gradient(var(--divider) 0 100%)";
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
  if (cursor < 100) {
    stops.push(`var(--divider) ${cursor.toFixed(2)}% 100%`);
  }
  return `conic-gradient(${stops.join(", ")})`;
}

function renderDonutBlock({ total, centerLabel, segments }) {
  const totalValue = Math.max(0, Number(total) || 0);
  const gradient = buildDonutGradient(segments, totalValue);
  const legendHead = `
    <div class="cookies-donut-legend-head">
      <span>Group</span>
      <span>Count</span>
      <span>Share</span>
    </div>
  `;
  const legend = segments.map((segment) => `
    <div class="cookies-donut-legend-row">
      <span class="cookies-donut-label">
        <span class="cookies-donut-dot" style="background:${segment.color};"></span>
        <span class="cookies-donut-name">${escapeHtml(segment.label)}</span>
      </span>
      <strong class="cookies-donut-count">${formatCount(segment.value)}</strong>
      <span class="cookies-donut-pct">${percent(segment.value, totalValue)}%</span>
    </div>
  `).join("");

  return `
    <div class="cookies-donut-block">
      <div class="cookies-donut-summary">
        <div class="cookies-donut-summary-label">Latest snapshot evidence</div>
        <div class="cookies-donut-summary-copy">Party split from the latest observed cookie inventory for this site.</div>
      </div>
      <div class="cookies-donut-layout">
        <div class="cookies-donut-wrap">
          <div class="cookies-donut-ring" style="background:${gradient};">
            <div class="cookies-donut-center">
              <strong>${formatCount(totalValue)}</strong>
              <span>${escapeHtml(centerLabel)}</span>
            </div>
          </div>
        </div>
        <div class="cookies-donut-legend">
          ${legendHead}
          ${legend}
        </div>
      </div>
    </div>
  `;
}

function guessSiteUrl(site, preferredUrl = "") {
  const raw = String(preferredUrl || "").trim();
  if (raw && /^https?:/i.test(raw)) return raw;
  return `https://${normalizeSite(site)}`;
}

function formatExpiry(cookie) {
  if (cookie.session) return "Session";
  if (!cookie.expiryTs) return "Unknown";
  return new Date(cookie.expiryTs).toLocaleString();
}

function normalizeCookieEntry(rawCookie, site) {
  const cookie = rawCookie && typeof rawCookie === "object" ? rawCookie : {};
  const host = normalizeHost(cookie.domain || "");
  let party = "unclear";

  if (cookie.isThirdParty === true) {
    party = "third-party";
  } else if (cookie.isThirdParty === false) {
    party = "first-party";
  } else if (host) {
    party = host === site || host.endsWith(`.${site}`) ? "first-party" : "third-party";
  }

  const expirySeconds = Number(cookie.expiry);
  const expiryTs = Number.isFinite(expirySeconds) && expirySeconds > 0
    ? expirySeconds * 1000
    : null;
  const persistentDays = expiryTs
    ? Math.max(0, Math.round((expiryTs - Date.now()) / 86400000))
    : 0;

  return {
    key: [
      String(cookie.name || ""),
      String(cookie.domain || ""),
      String(cookie.path || "/"),
    ].join("::"),
    name: String(cookie.name || "(unnamed)"),
    domain: String(cookie.domain || ""),
    host,
    path: String(cookie.path || "/"),
    secure: cookie.secure === true,
    httpOnly: cookie.httpOnly === true,
    sameSite: String(cookie.sameSite || "").trim(),
    session: cookie.session === true,
    hostOnly: cookie.hostOnly === true,
    expiryTs,
    persistentDays,
    party,
  };
}

function classifyCookie(cookie) {
  const name = cookie.name.toLowerCase();
  const domain = normalizeHost(cookie.domain || "");
  const combined = `${name} ${domain}`;

  let role = "Unclear";
  let usefulness = "Unclear";
  let confidence = "Low";
  let effect = "Clearing it may reset something on the site, but the effect is uncertain from the available metadata.";
  let reasoning = "The name and domain do not match a stronger role pattern, so this remains a low-confidence guess.";

  if (SECURITY_RE.test(combined) || name.startsWith("__host-") || name.startsWith("__secure-")) {
    role = "Security or CSRF protection";
    usefulness = "Essential";
    confidence = "High";
    effect = "Clearing it may trigger extra security checks, log you out, or force the site to issue a fresh protection cookie.";
    reasoning = "Its name or prefix matches common protection cookies, and these cookies are often required to keep requests valid.";
  } else if ((SESSION_RE.test(combined) && cookie.party !== "third-party") || (cookie.httpOnly && cookie.session && cookie.party === "first-party")) {
    role = "Session or sign-in state";
    usefulness = "Essential";
    confidence = cookie.httpOnly ? "High" : "Medium";
    effect = "Clearing it can sign you out, end the current session, or force the site to create a new session.";
    reasoning = "Its name or flags look like session handling, which usually keeps a user signed in or tracks the current visit.";
  } else if (PREF_RE.test(combined)) {
    role = "Preferences or remembered settings";
    usefulness = cookie.party === "third-party" ? "Optional" : "Helpful";
    confidence = "Medium";
    effect = "Clearing it can reset language, consent, theme, region, or other remembered site settings.";
    reasoning = "Its name matches common preference or consent patterns rather than login or advertising patterns.";
  } else if (AD_RE.test(combined)) {
    role = "Advertising or attribution";
    usefulness = "Non-essential";
    confidence = cookie.party === "third-party" ? "High" : "Medium";
    effect = "Clearing it usually resets ad attribution or personalisation rather than core site functionality.";
    reasoning = "Its name or domain matches ad-tech or click-attribution patterns commonly used for campaign tracking.";
  } else if (ANALYTICS_RE.test(combined)) {
    role = "Analytics or measurement";
    usefulness = cookie.party === "third-party" ? "Non-essential" : "Optional";
    confidence = "High";
    effect = "Clearing it usually resets analytics or measurement identifiers and may reduce cross-visit tracking continuity.";
    reasoning = "Its name matches analytics identifier patterns used to recognise repeat visits or events.";
  } else if (cookie.party === "third-party" && SERVICE_RE.test(combined)) {
    role = "Cross-site service / embedded content";
    usefulness = "Helpful";
    confidence = "Medium";
    effect = "Clearing it can reset chat, video, payment, support, or embedded service state on this site.";
    reasoning = "The domain or cookie name looks tied to a third-party service that provides embedded functionality rather than core site login.";
  } else if (cookie.party === "first-party" && cookie.session) {
    role = "Session or sign-in state";
    usefulness = "Helpful";
    confidence = "Low";
    effect = "Clearing it can interrupt the current visit or reset short-lived state on the site.";
    reasoning = "It is a first-party session cookie, which often supports temporary state, but the exact role is still unclear.";
  } else if (cookie.party === "third-party" && cookie.persistentDays > 30) {
    effect = "Clearing it may remove long-lived cross-site state, but the exact purpose is uncertain.";
    reasoning = "It is third-party and persistent, which can matter for tracking or embedded services, but the metadata is not specific enough to name the purpose.";
  }

  let reviewScore = 0;
  if (cookie.party === "third-party") reviewScore += 30;
  if (cookie.party === "unclear") reviewScore += 18;
  if (usefulness === "Non-essential") reviewScore += 24;
  if (usefulness === "Optional") reviewScore += 12;
  if (usefulness === "Unclear") reviewScore += 15;
  if (role === "Advertising or attribution") reviewScore += 18;
  if (role === "Analytics or measurement") reviewScore += 14;
  if (cookie.persistentDays >= 365) reviewScore += 14;
  else if (cookie.persistentDays >= 30) reviewScore += 9;
  else if (cookie.persistentDays > 0) reviewScore += 4;
  reviewScore += confidence === "Low" ? 6 : confidence === "Medium" ? 3 : 0;

  return {
    ...cookie,
    role,
    usefulness,
    confidence,
    effect,
    reasoning,
    reviewScore,
    expiryText: formatExpiry(cookie),
  };
}

function buildSiteReviewTag(snapshot, cookies) {
  if (!snapshot || snapshot.cookieCount <= 0) return "No cookies now";
  if (snapshot.thirdCount >= Math.max(3, Math.ceil(snapshot.cookieCount * 0.4))) return "Third-party heavy";
  if (snapshot.unknownCount > 0) return "Needs clearer review";
  if (cookies.some((cookie) => cookie.usefulness === "Non-essential")) return "Analytics or ads present";
  if (snapshot.cookieCount >= 12) return "Large cookie set";
  return "Mostly first-party";
}

function buildSiteReviewScore(snapshot, cookies, stats) {
  if (!snapshot) return 0;
  let score = snapshot.thirdCount * 10;
  score += snapshot.unknownCount * 9;
  score += snapshot.cookieCount * 2;
  score += cookies.filter((cookie) => cookie.usefulness === "Non-essential").length * 7;
  score += cookies.filter((cookie) => cookie.usefulness === "Unclear").length * 5;
  score += Math.min(stats.snapshotCount || 0, 5);
  score += snapshot.ts ? 1 : 0;
  return score;
}

function deriveCookieSites(events) {
  const snapshots = new Map();
  const statsBySite = new Map();

  for (const ev of events || []) {
    const kind = String(ev?.kind || "");
    if (!kind.startsWith("cookies.")) continue;

    const data = ev?.data && typeof ev.data === "object" ? ev.data : {};
    const site = normalizeSite(ev?.site || data.siteBase || "unknown");
    const ts = Number(ev?.ts) || 0;
    const stats = statsBySite.get(site) || {
      site,
      lastSeenTs: 0,
      lastClearTs: 0,
      snapshotCount: 0,
    };

    stats.lastSeenTs = Math.max(stats.lastSeenTs, ts);
    if (kind === "cookies.cleared") stats.lastClearTs = Math.max(stats.lastClearTs, ts);
    if (kind === "cookies.snapshot") stats.snapshotCount += 1;
    statsBySite.set(site, stats);

    if (kind !== "cookies.snapshot") continue;

    const existing = snapshots.get(site);
    if (existing && existing.ts >= ts) continue;

    const rawCookies = Array.isArray(data.cookies) ? data.cookies : [];
    const cookies = rawCookies.map((cookie) => normalizeCookieEntry(cookie, site)).map(classifyCookie);
    const total = data.count != null ? safeInt(data.count, cookies.length) : cookies.length;
    const third = cookies.filter((cookie) => cookie.party === "third-party").length;
    const first = cookies.filter((cookie) => cookie.party === "first-party").length;
    const unknown = Math.max(total - first - third, 0);

    snapshots.set(site, {
      site,
      ts,
      url: guessSiteUrl(site, data.url),
      cookieCount: total,
      firstCount: first,
      thirdCount: third,
      unknownCount: unknown,
      cookies,
    });
  }

  const allSites = Array.from(new Set([
    ...statsBySite.keys(),
    ...snapshots.keys(),
  ])).map((site) => {
    const stats = statsBySite.get(site) || { lastSeenTs: 0, lastClearTs: 0, snapshotCount: 0 };
    const snapshot = snapshots.get(site) || null;
    const cookies = snapshot?.cookies || [];
    return {
      site,
      url: snapshot?.url || guessSiteUrl(site),
      lastSeenTs: snapshot?.ts || stats.lastSeenTs || 0,
      lastClearTs: stats.lastClearTs || 0,
      hasSnapshot: Boolean(snapshot),
      cookieCount: snapshot?.cookieCount || 0,
      firstCount: snapshot?.firstCount || 0,
      thirdCount: snapshot?.thirdCount || 0,
      unknownCount: snapshot?.unknownCount || 0,
      cookies,
      reviewTag: buildSiteReviewTag(snapshot, cookies),
      reviewScore: buildSiteReviewScore(snapshot, cookies, stats),
    };
  });

  return {
    allSites,
    selectorSites: allSites.filter((site) => site.hasSnapshot && site.cookieCount > 0),
    recordBySite: new Map(allSites.map((site) => [site.site, site])),
  };
}

function sortSelectorSites(sites, sortMode) {
  const list = sites.slice();
  if (sortMode === "most-recent") {
    list.sort((a, b) => (b.lastSeenTs - a.lastSeenTs) || a.site.localeCompare(b.site));
    return list;
  }
  if (sortMode === "a-z") {
    list.sort((a, b) => a.site.localeCompare(b.site));
    return list;
  }
  if (sortMode === "most-cookies") {
    list.sort((a, b) => (b.cookieCount - a.cookieCount) || (b.thirdCount - a.thirdCount) || a.site.localeCompare(b.site));
    return list;
  }
  list.sort((a, b) =>
    (b.reviewScore - a.reviewScore)
    || (b.thirdCount - a.thirdCount)
    || (b.lastSeenTs - a.lastSeenTs)
    || a.site.localeCompare(b.site)
  );
  return list;
}

function sortInspectorCookies(cookies, sortMode) {
  const list = cookies.slice();
  if (sortMode === "third-party first") {
    list.sort((a, b) =>
      (Number(b.party === "third-party") - Number(a.party === "third-party"))
      || (b.reviewScore - a.reviewScore)
      || a.name.localeCompare(b.name)
    );
    return list;
  }
  if (sortMode === "longest-lived") {
    list.sort((a, b) =>
      ((b.expiryTs || 0) - (a.expiryTs || 0))
      || (Number(a.session) - Number(b.session))
      || a.name.localeCompare(b.name)
    );
    return list;
  }
  if (sortMode === "a-z") {
    list.sort((a, b) => a.name.localeCompare(b.name) || a.domain.localeCompare(b.domain));
    return list;
  }
  list.sort((a, b) => (b.reviewScore - a.reviewScore) || a.name.localeCompare(b.name));
  return list;
}

function buildInspectorSummary(record) {
  if (!record || record.cookieCount <= 0) {
    return {
      lead: "No cookies were found in the latest snapshot for this site.",
      evidence: "Capture a fresh snapshot if the site's cookie state may have changed since the last review.",
    };
  }

  const total = record.cookieCount;
  const third = record.thirdCount;
  const first = record.firstCount;
  const unknown = record.unknownCount;
  const analyticsCount = record.cookies.filter((cookie) => cookie.role === "Analytics or measurement").length;
  const advertisingCount = record.cookies.filter((cookie) => cookie.role === "Advertising or attribution").length;
  const serviceCount = record.cookies.filter((cookie) => cookie.role === "Cross-site service / embedded content").length;
  const sessionCount = record.cookies.filter((cookie) => cookie.role === "Session or sign-in state").length;
  const securityCount = record.cookies.filter((cookie) => cookie.role === "Security or CSRF protection").length;

  let lead = `${record.site} currently shows ${total} cookie${total === 1 ? "" : "s"} in the latest snapshot.`;
  if (third > 0) {
    lead = `${formatCount(third)} of ${formatCount(total)} cookies look third-party. Review external services and embedded vendors first.`;
  } else if (unknown > 0) {
    lead = `${formatCount(unknown)} of ${formatCount(total)} cookies still have unclear ownership or role signals. Review names, domains, and flags before clearing.`;
  } else if (first > 0) {
    lead = `Most of this site's current cookies look first-party. Start with lower-risk labels before clearing core site state.`;
  }

  let evidenceNote = "Rows are ordered to surface the cookies most worth checking first.";
  if (advertisingCount > 0) {
    evidenceNote = `${formatCount(advertisingCount)} look closest to advertising or attribution, which is usually lower-risk to clear than sign-in or protection state.`;
  } else if (analyticsCount > 0) {
    evidenceNote = `${formatCount(analyticsCount)} look closest to analytics or measurement identifiers, so clearing them may reset cross-visit continuity.`;
  } else if (serviceCount > 0) {
    evidenceNote = `${formatCount(serviceCount)} appear tied to cross-site services such as chat, video, payments, or support tools.`;
  } else if (securityCount > 0) {
    evidenceNote = `${formatCount(securityCount)} look closest to security or CSRF protection, so treat clearing with higher caution.`;
  } else if (sessionCount > 0) {
    evidenceNote = `${formatCount(sessionCount)} appear tied to session or sign-in state, which can end the current visit if cleared.`;
  } else if (unknown > 0) {
    evidenceNote = `${formatCount(unknown)} remain unclear, so the row explanations below should be treated as heuristics rather than proof.`;
  }

  return {
    lead,
    evidence: `Snapshot mix: 1P ${formatCount(first)} | 3P ${formatCount(third)} | U ${formatCount(unknown)}. ${evidenceNote}`,
  };
}

function renderInspectorSummaryHtml(summary) {
  return `
    <div class="cookies-summary-line">${escapeHtml(summary?.lead || "")}</div>
    <div class="cookies-summary-evidence">
      <span class="cookies-summary-evidence-label">Current evidence</span>
      <span class="cookies-summary-evidence-copy">${escapeHtml(summary?.evidence || "")}</span>
    </div>
  `;
}

function buildSelectorMeta(filteredCount, totalCount) {
  if (!totalCount) return "No sites with detected cookies yet";
  if (filteredCount === totalCount) return `${formatCount(totalCount)} site${totalCount === 1 ? "" : "s"} with detected cookies`;
  return `Showing ${formatCount(filteredCount)} of ${formatCount(totalCount)} sites with detected cookies`;
}

function buildReviewMeta(filteredCount, totalCount) {
  if (!totalCount) return "No cookies recorded in the latest snapshot for this site.";
  if (filteredCount === totalCount) return `${formatCount(totalCount)} cookie${totalCount === 1 ? "" : "s"} in the latest snapshot`;
  return `Showing ${formatCount(filteredCount)} of ${formatCount(totalCount)} cookies in the latest snapshot`;
}

function getSelectedRecord() {
  return state.lastDerived?.recordBySite?.get(state.selectedSite) || null;
}

function renderSelectorCardHtml(record) {
  return `
    <button type="button" class="cookies-site-card">
      <div class="cookies-site-card-head">
        <div class="cookies-site-card-site">${escapeHtml(record.site)}</div>
        <span class="cookies-site-card-tag">${escapeHtml(record.reviewTag)}</span>
      </div>
      <div class="cookies-site-card-count">${formatCount(record.cookieCount)} cookies</div>
      <div class="cookies-site-card-split">
        <span>1P ${formatCount(record.firstCount)}</span>
        <span>3P ${formatCount(record.thirdCount)}</span>
        <span>U ${formatCount(record.unknownCount)}</span>
      </div>
      <div class="cookies-site-card-last">Last seen ${escapeHtml(friendlyTime(record.lastSeenTs))}</div>
    </button>
  `;
}

function renderCookieRowHtml(cookie, expanded) {
  const flags = [];
  if (cookie.secure) flags.push("Secure");
  if (cookie.httpOnly) flags.push("HttpOnly");
  if (cookie.sameSite) flags.push(`SameSite=${cookie.sameSite}`);
  if (cookie.session) flags.push("Session");
  if (cookie.hostOnly) flags.push("Host only");
  const flagsText = flags.length ? flags.join(" | ") : "No standout flags recorded";

  return `
    <article class="cookies-cookie-item${expanded ? " expanded" : ""}">
      <button
        type="button"
        class="cookies-cookie-toggle"
        aria-expanded="${expanded ? "true" : "false"}"
      >
        <span class="cookies-cookie-strip">
          <span class="cookies-cookie-header">
            <span class="cookies-cookie-main">
              <span class="cookies-cookie-name">${escapeHtml(cookie.name)}</span>
              <span class="cookies-cookie-domain">${escapeHtml(cookie.domain || "No domain recorded")}</span>
            </span>
            <span class="cookies-cookie-classifications">
              <span class="cookies-cookie-role">${renderRoleChip(cookie.role)}</span>
              <span class="cookies-cookie-party cookies-cookie-party-${escapeHtml(cookie.party)}">${escapeHtml(partyLabel(cookie.party))}</span>
              <span class="cookies-cookie-review">${renderReviewChip(cookie.usefulness)}</span>
              <span class="cookies-cookie-confidence cookies-cookie-confidence-${escapeHtml(cookie.confidence.toLowerCase())}">${escapeHtml(cookie.confidence)}</span>
            </span>
          </span>
          <span class="cookies-cookie-effect-block">
            <span class="cookies-cookie-effect-label">Likely effect of clearing</span>
            <span class="cookies-cookie-effect">${escapeHtml(cookie.effect)}</span>
          </span>
        </span>
      </button>
      ${expanded ? `
        <div class="cookies-cookie-detail">
          <div class="cookies-cookie-detail-section">
            <div class="cookies-cookie-detail-section-title">Inspection detail</div>
            <div class="cookies-cookie-detail-grid">
              <div class="cookies-cookie-detail-block">
                <div class="cookies-cookie-detail-label">Likely role</div>
                <div class="cookies-cookie-detail-value">${renderRoleChip(cookie.role)}</div>
              </div>
              <div class="cookies-cookie-detail-block">
                <div class="cookies-cookie-detail-label">Review label</div>
                <div class="cookies-cookie-detail-value">${renderReviewChip(cookie.usefulness)}</div>
              </div>
              <div class="cookies-cookie-detail-block">
                <div class="cookies-cookie-detail-label">Expires</div>
                <div class="cookies-cookie-detail-value">${escapeHtml(cookie.expiryText)}</div>
              </div>
              <div class="cookies-cookie-detail-block">
                <div class="cookies-cookie-detail-label">Path</div>
                <div class="cookies-cookie-detail-value">${escapeHtml(cookie.path)}</div>
              </div>
            </div>
          </div>
          <div class="cookies-cookie-detail-section">
            <div class="cookies-cookie-detail-section-title">Heuristic notes</div>
            <div class="cookies-cookie-detail-stack">
              <div class="cookies-cookie-detail-copy">
                <strong>Why this is the current guess:</strong> ${escapeHtml(cookie.reasoning)}
              </div>
              <div class="cookies-cookie-detail-copy">
                <strong>Flags:</strong> ${escapeHtml(flagsText)}
              </div>
              <div class="cookies-cookie-detail-copy">
                <strong>Likely effect of clearing:</strong> ${escapeHtml(cookie.effect)}
              </div>
              <div class="cookies-cookie-detail-note">
                This is still a heuristic. VPT is inferring role from cookie names, domains, and settings rather than confirming how the site or vendor actually uses the cookie.
              </div>
            </div>
          </div>
        </div>
      ` : ""}
    </article>
  `;
}

function syncControls() {
  const selectorSearch = document.getElementById("cookiesSelectorSearch");
  const selectorSort = document.getElementById("cookiesSelectorSort");
  const cookieSearch = document.getElementById("cookiesCookieSearch");
  const cookieParty = document.getElementById("cookiesCookiePartyFilter");
  const cookieSort = document.getElementById("cookiesCookieSort");

  if (selectorSearch) selectorSearch.value = state.selectorSearch;
  if (selectorSort) selectorSort.value = state.selectorSort;
  if (cookieSearch) cookieSearch.value = state.cookieSearch;
  if (cookieParty) cookieParty.value = state.cookiePartyFilter;
  if (cookieSort) cookieSort.value = state.cookieSort;
}

function renderSelectorView() {
  const root = document.getElementById("cookiesSelectorView");
  const grid = document.getElementById("cookiesSelectorGrid");
  const empty = document.getElementById("cookiesSelectorEmpty");
  const meta = document.getElementById("cookiesSelectorMeta");
  const subtitle = document.getElementById("cookiesSelectorSubtitle");
  const legend = document.getElementById("cookiesSelectorLegend");
  if (!root || !grid || !empty || !meta || !subtitle || !legend) return;

  const allSites = state.lastDerived?.selectorSites || [];
  const term = state.selectorSearch.trim().toLowerCase();
  const filtered = allSites.filter((site) => !term || site.site.toLowerCase().includes(term));
  const ordered = sortSelectorSites(filtered, state.selectorSort);
  state.lastSelectorSites = ordered;

  meta.textContent = buildSelectorMeta(ordered.length, allSites.length);
  subtitle.textContent = allSites.length
    ? "Choose one site to inspect its current cookie list, likely role, and clear action."
    : "Browse with cookie capture enabled, then return here to review one site at a time.";

  root.classList.toggle("hidden", state.mode !== "selector");
  legend.innerHTML = renderLegendHtml();
  empty.classList.toggle("hidden", ordered.length > 0);
  grid.innerHTML = ordered.map((record, index) => `
    <div class="cookies-site-card-wrap" data-site-index="${index}">
      ${renderSelectorCardHtml(record)}
    </div>
  `).join("");
}

function renderInspectorView() {
  const root = document.getElementById("cookiesInspectorView");
  const title = document.getElementById("cookiesInspectorSiteTitle");
  const meta = document.getElementById("cookiesInspectorSiteMeta");
  const summary = document.getElementById("cookiesInspectorSummary");
  const honesty = document.getElementById("cookiesInspectorHonesty");
  const visual = document.getElementById("cookiesInspectorVisual");
  const legend = document.getElementById("cookiesInspectorLegend");
  const reviewMeta = document.getElementById("cookiesReviewMeta");
  const listNote = document.getElementById("cookiesInspectorListNote");
  const list = document.getElementById("cookiesCookieList");
  const empty = document.getElementById("cookiesCookieListEmpty");
  const visualizerLink = document.getElementById("cookiesVisualizerLink");
  const clearBtn = document.getElementById("cookiesClearSiteBtn");
  const status = document.getElementById("cookiesClearStatus");
  if (!root || !title || !meta || !summary || !honesty || !visual || !legend || !reviewMeta || !listNote || !list || !empty || !visualizerLink || !clearBtn || !status) {
    return;
  }

  const record = getSelectedRecord();
  const shouldShow = state.mode === "inspector" && Boolean(record);
  root.classList.toggle("hidden", !shouldShow);
  if (!shouldShow || !record) {
    state.lastInspectorCookies = [];
    return;
  }

  title.textContent = record.site;
  meta.textContent = `${formatCount(record.cookieCount)} cookies in the latest snapshot | ${formatCount(record.thirdCount)} third-party | last seen ${friendlyTime(record.lastSeenTs)}`;
  summary.innerHTML = renderInspectorSummaryHtml(buildInspectorSummary(record));
  honesty.textContent = "Roles and confidence are inferred from names, domains, and cookie settings. They are useful hints, not proof of exact purpose.";
  visualizerLink.href = `/site.html?site=${encodeURIComponent(record.site)}`;
  legend.innerHTML = renderLegendHtml();

  const total = record.firstCount + record.thirdCount + record.unknownCount;
  if (!total) {
    visual.innerHTML = '<div class="cookies-empty-hint">No cookie mix to show in the latest snapshot.</div>';
  } else {
    visual.innerHTML = renderDonutBlock({
      total,
      centerLabel: "cookies",
      segments: [
        { label: "First-party", value: record.firstCount, color: "var(--success-text)" },
        { label: "Third-party", value: record.thirdCount, color: "var(--accent)" },
        { label: "Unclear", value: record.unknownCount, color: "var(--text-faint)" },
      ],
    });
  }

  const term = state.cookieSearch.trim().toLowerCase();
  const filtered = record.cookies.filter((cookie) => {
    if (state.cookiePartyFilter !== "all" && cookie.party !== state.cookiePartyFilter) return false;
    if (!term) return true;
    return cookie.name.toLowerCase().includes(term) || cookie.domain.toLowerCase().includes(term);
  });
  const ordered = sortInspectorCookies(filtered, state.cookieSort);
  state.lastInspectorCookies = ordered;

  if (state.expandedCookieIndex != null && !ordered[state.expandedCookieIndex]) {
    state.expandedCookieIndex = null;
  }

  reviewMeta.textContent = buildReviewMeta(ordered.length, record.cookies.length);
  listNote.textContent = "Rows are ordered for inspection first. Expand one for the heuristic basis, technical flags, and clear-effect notes.";
  empty.classList.toggle("hidden", ordered.length > 0);
  empty.textContent = record.cookies.length
    ? "No cookies match the current filter."
    : "No individual cookies were recorded in the latest snapshot for this site.";

  list.innerHTML = ordered.map((cookie, index) => `
    <div class="cookies-cookie-item-wrap" data-cookie-index="${index}">
      ${renderCookieRowHtml(cookie, state.expandedCookieIndex === index)}
    </div>
  `).join("");

  clearBtn.disabled = state.clearPending;
  clearBtn.textContent = state.clearPending ? "Clearing..." : "Clear site cookies";
  status.className = `cookies-clear-status${state.clearStatus.tone ? ` ${state.clearStatus.tone}` : ""}`;
  status.textContent = state.clearStatus.message || "";
}

function renderCookiesViewInternal() {
  syncControls();
  renderSelectorView();
  renderInspectorView();
}

function bindBridgeResponses() {
  if (state.bridgeBound || typeof window === "undefined") return;
  window.addEventListener("message", (event) => {
    const data = event?.data;
    if (!data || data.source !== COOKIE_BRIDGE_SOURCE || data.type !== COOKIE_BRIDGE_RESPONSE) return;
    const requestId = String(data.requestId || "");
    const pending = state.bridgePending.get(requestId);
    if (!pending) return;
    clearTimeout(pending.timeoutId);
    state.bridgePending.delete(requestId);
    if (data.status === "ok") {
      pending.resolve(data.result || {});
      return;
    }
    pending.reject(new Error(String(data.error || "cookie_bridge_failed")));
  });
  state.bridgeBound = true;
}

function requestCookieBridge(action, payload) {
  bindBridgeResponses();
  if (typeof window === "undefined" || typeof window.postMessage !== "function") {
    return Promise.reject(new Error("bridge_unavailable"));
  }

  return new Promise((resolve, reject) => {
    const requestId = `cookies-${Date.now()}-${state.bridgeSeq += 1}`;
    const timeoutId = setTimeout(() => {
      state.bridgePending.delete(requestId);
      reject(new Error("bridge_unavailable"));
    }, COOKIE_BRIDGE_TIMEOUT_MS);

    state.bridgePending.set(requestId, { resolve, reject, timeoutId });
    window.postMessage(
      {
        source: COOKIE_BRIDGE_SOURCE,
        type: COOKIE_BRIDGE_REQUEST,
        action,
        requestId,
        payload,
      },
      "*"
    );
  });
}

function setClearStatus(tone, message) {
  state.clearStatus = { tone, message };
}

function resetInspectorFilters() {
  state.cookieSearch = "";
  state.cookiePartyFilter = "all";
  state.cookieSort = "review-priority";
  state.expandedCookieIndex = null;
}

function enterInspector(site) {
  state.selectedSite = normalizeSite(site);
  state.mode = "inspector";
  resetInspectorFilters();
  renderCookiesViewInternal();
}

function exitInspector() {
  state.mode = "selector";
  state.selectedSite = null;
  state.expandedCookieIndex = null;
  renderCookiesViewInternal();
}

async function refreshFromApi() {
  const api = getApi();
  if (!api?.getEvents) {
    renderCookiesView(state.latestEvents);
    return false;
  }
  const events = await api.getEvents();
  renderCookiesView(events);
  return true;
}

async function clearSelectedSiteCookies() {
  if (state.clearPending) return;
  const record = getSelectedRecord();
  if (!record) return;

  state.clearPending = true;
  setClearStatus("pending", `Clearing cookies for ${record.site}...`);
  renderCookiesViewInternal();

  try {
    const clearResult = await requestCookieBridge("clearForSite", {
      url: record.url,
    });

    if (!clearResult || clearResult.ok !== true) {
      throw new Error(clearResult?.error || "clear_failed");
    }

    const cleared = safeInt(clearResult.cleared, 0);
    const total = safeInt(clearResult.total, 0);
    const clearSummary = cleared === 0
      ? "Clear confirmed: no site cookies needed clearing."
      : total > 0 && cleared < total
        ? `Clear confirmed: removed ${cleared} of ${total} cookies.`
        : `Clear confirmed: removed ${cleared} cookie${cleared === 1 ? "" : "s"}.`;

    setClearStatus("pending", `${clearSummary} Refreshing snapshot...`);
    renderCookiesViewInternal();

    try {
      const snapshotResult = await requestCookieBridge("sendSnapshot", {
        url: record.url,
      });

      if (!snapshotResult || snapshotResult.ok !== true) {
        throw new Error(snapshotResult?.error || "snapshot_failed");
      }

      const refreshed = await refreshFromApi();
      if (refreshed) {
        const nextCount = safeInt(snapshotResult.count, 0);
        setClearStatus("success", `${clearSummary} Snapshot refreshed (${nextCount} cookies now seen).`);
      } else {
        setClearStatus("warn", `${clearSummary} Refresh was requested, but this page could not confirm the updated inventory. The list may be stale.`);
      }
    } catch {
      setClearStatus("warn", `${clearSummary} Refresh was not confirmed, so the cookie list shown here may be stale.`);
    }
  } catch (error) {
    const message = String(error?.message || "");
    if (message === "bridge_unavailable") {
      setClearStatus("error", "Clear unavailable: the Control Centre could not reach the extension bridge on this page.");
    } else {
      setClearStatus("error", "Clear failed: the extension did not confirm that site cookies were removed.");
    }
  } finally {
    state.clearPending = false;
    renderCookiesViewInternal();
  }
}

function bindCookiesEvents() {
  const selectorSearch = document.getElementById("cookiesSelectorSearch");
  const selectorSort = document.getElementById("cookiesSelectorSort");
  const selectorGrid = document.getElementById("cookiesSelectorGrid");
  const backBtn = document.getElementById("cookiesInspectorBackBtn");
  const clearBtn = document.getElementById("cookiesClearSiteBtn");
  const cookieSearch = document.getElementById("cookiesCookieSearch");
  const cookieParty = document.getElementById("cookiesCookiePartyFilter");
  const cookieSort = document.getElementById("cookiesCookieSort");
  const cookieList = document.getElementById("cookiesCookieList");

  selectorSearch?.addEventListener("input", (event) => {
    state.selectorSearch = String(event.target?.value || "");
    renderCookiesViewInternal();
  });

  selectorSort?.addEventListener("change", (event) => {
    state.selectorSort = String(event.target?.value || "review-priority");
    renderCookiesViewInternal();
  });

  selectorGrid?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const wrap = target.closest("[data-site-index]");
    if (!(wrap instanceof HTMLElement)) return;
    const index = Number(wrap.dataset.siteIndex);
    const record = state.lastSelectorSites[index];
    if (!record) return;
    enterInspector(record.site);
  });

  backBtn?.addEventListener("click", () => {
    exitInspector();
  });

  clearBtn?.addEventListener("click", () => {
    clearSelectedSiteCookies().catch(() => {});
  });

  cookieSearch?.addEventListener("input", (event) => {
    state.cookieSearch = String(event.target?.value || "");
    state.expandedCookieIndex = null;
    renderCookiesViewInternal();
  });

  cookieParty?.addEventListener("change", (event) => {
    state.cookiePartyFilter = String(event.target?.value || "all");
    state.expandedCookieIndex = null;
    renderCookiesViewInternal();
  });

  cookieSort?.addEventListener("change", (event) => {
    state.cookieSort = String(event.target?.value || "review-priority");
    state.expandedCookieIndex = null;
    renderCookiesViewInternal();
  });

  cookieList?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const wrap = target.closest("[data-cookie-index]");
    if (!(wrap instanceof HTMLElement)) return;
    const index = Number(wrap.dataset.cookieIndex);
    state.expandedCookieIndex = state.expandedCookieIndex === index ? null : index;
    renderCookiesViewInternal();
  });
}

export function renderCookiesView(events) {
  state.latestEvents = Array.isArray(events) ? events.slice() : [];
  state.lastDerived = deriveCookieSites(state.latestEvents);

  const selected = state.selectedSite ? state.lastDerived.recordBySite.get(state.selectedSite) : null;
  if (state.mode === "inspector" && !selected) {
    state.mode = "selector";
    state.selectedSite = null;
    state.expandedCookieIndex = null;
  }

  renderCookiesViewInternal();
}

export function initCookiesFeature({ getLatestEvents } = {}) {
  getLatestEventsCb = typeof getLatestEvents === "function" ? getLatestEvents : null;
  bindCookiesEvents();
  bindBridgeResponses();

  const latest = getLatestEventsCb ? getLatestEventsCb() : [];
  renderCookiesView(latest);
}

window.VPT = window.VPT || {};
window.VPT.features = window.VPT.features || {};
window.VPT.features.cookies = { initCookiesFeature, renderCookiesView };
