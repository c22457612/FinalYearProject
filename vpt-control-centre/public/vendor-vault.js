function qs(id) {
  return document.getElementById(id);
}

const CATEGORY_MEANINGS = {
  session_tokens: {
    label: "Session/auth token",
    description: "A key name suggesting session or authentication state.",
    concern: "Session-linked metadata can increase account linkage risk when observed leaving the browser.",
    plainEnglishWhat: "A key name that usually relates to login or session state.",
    plainEnglishWhy: "If this type leaves the browser, activity can be linked to a signed-in session.",
  },
  analytics_ids: {
    label: "Analytics identifier",
    description: "A key name commonly used for analytics attribution.",
    concern: "Persistent analytics identifiers can connect visits over time.",
    plainEnglishWhat: "A key name used to measure visits and repeat behavior.",
    plainEnglishWhy: "Persistent analytics IDs can connect actions across pages or sessions.",
  },
  advertising_ids: {
    label: "Advertising identifier",
    description: "A key name associated with ad attribution or campaign tracking.",
    concern: "Advertising identifiers can support profiling and audience segmentation.",
    plainEnglishWhat: "A key name tied to ad click, campaign, or conversion tracking.",
    plainEnglishWhy: "Ad identifiers can be used to build interest profiles and target ads.",
  },
  contact_like: {
    label: "Contact-like field",
    description: "A key name that looks like contact information (for example email/phone).",
    concern: "Contact-like fields can increase re-identification risk in outbound requests.",
    plainEnglishWhat: "A key name that appears to represent contact details such as email or phone.",
    plainEnglishWhy: "Contact-like fields can raise re-identification risk when shared with third parties.",
  },
  location_like: {
    label: "Location-like field",
    description: "A key name that suggests location coordinates or geo metadata.",
    concern: "Location-like fields can reveal sensitive area or movement context.",
    plainEnglishWhat: "A key name that suggests location coordinates or geographic context.",
    plainEnglishWhy: "Location-like fields may reveal sensitive area or movement context.",
  },
  identifiers: {
    label: "Online identifier (generic)",
    description: "A broad identifier-style key that may be config-linked or user-linked depending on endpoint context.",
    concern: "Generic identifiers can still enable cross-request linking.",
    plainEnglishWhat: "A generic identifier-style key that can tag a browser, app instance, or account context.",
    plainEnglishWhy: "Even generic identifiers can help link activity across requests over time.",
    uncertaintyNote: "Generic keys (for example 'id') can be ambiguous without endpoint context.",
  },
};

// EXPOSURE-UX-2 per-item weights (deterministic, UI-only scoring).
const ITEM_CATEGORY_WEIGHTS = {
  contact_like: 35,
  session_tokens: 30,
  location_like: 25,
  advertising_ids: 20,
  analytics_ids: 15,
  identifiers: 12,
};

const DEFAULT_ITEM_CATEGORY_WEIGHT = 12;

// EXPOSURE-UX-2 deterministic evidence factors.
const EVIDENCE_FACTORS = {
  observed: 1.0,
  attempted: 0.3,
  unknown: 0.6,
};

// Keep overall vendor score display behavior consistent with prior EXPOSURE-2 implementation.
const OVERALL_CATEGORY_WEIGHTS = {
  session_tokens: 24,
  analytics_ids: 16,
  advertising_ids: 20,
  contact_like: 18,
  location_like: 17,
  identifiers: 14,
};

const DEFAULT_OVERALL_CATEGORY_WEIGHT = 10;

const KEY_HINT_RULES = [
  {
    test: (key) => key === "gclid",
    meaning: "Google Ads click identifier used for attribution context.",
    confidence: "high",
  },
  {
    test: (key) => key === "cid" || key === "client_id" || key === "clientid",
    meaning: "Client/analytics identifier that can link repeat visits or events.",
    confidence: "high",
  },
  {
    test: (key) => key === "uid" || key === "user_id" || key === "userid",
    meaning: "User-linked identifier key pattern.",
    confidence: "med",
  },
  {
    test: (key) => key === "session" || key.includes("session"),
    meaning: "Session context key that may link activity within or across sessions.",
    confidence: "med",
  },
  {
    test: (key) => key === "token" || key.includes("token"),
    meaning: "Token-style key often used for auth/session/API context.",
    confidence: "med",
  },
  {
    test: (key) => key === "email" || key.includes("email"),
    meaning: "Email-like key name inferred from captured metadata.",
    confidence: "high",
  },
  {
    test: (key) => key === "phone" || key.includes("phone"),
    meaning: "Phone-like key name inferred from captured metadata.",
    confidence: "high",
  },
  {
    test: (key) => key === "lat" || key === "latitude",
    meaning: "Latitude-like key name suggesting location context.",
    confidence: "high",
  },
  {
    test: (key) => key === "lon" || key === "lng" || key === "longitude",
    meaning: "Longitude-like key name suggesting location context.",
    confidence: "high",
  },
  {
    test: (key) => key === "id",
    meaning: "This key can be a tag/config ID or a user-linked identifier depending on endpoint context.",
    confidence: "low",
  },
];

let latestExposureRequestId = 0;
let latestSummaryRequestId = 0;
let latestApiEvidenceRequestId = 0;
const SCOPE_SITE = "site";
const SCOPE_ALL = "all";
const vaultScopeState = {
  site: "",
  vendor: "",
  scope: SCOPE_SITE,
};
const LANDING_SORT_ACTIVITY = "activity";
const LANDING_SORT_RECENT = "recent";
const LANDING_SORT_BLOCKED = "blocked";
let landingDirectoryControlsBound = false;
let latestLandingVendorsRequestId = 0;
const landingDirectoryState = {
  scope: SCOPE_ALL,
  selectedSite: "",
  search: "",
  sort: LANDING_SORT_ACTIVITY,
  sites: [],
  vendors: [],
};
const EXPORT_APP_NAME = "Visual Privacy Toolkit - Vendor Vault";
const EXPORT_DATA_SOURCE_NOTE = "Derived from captured browser signals (request metadata). Keys/categories only; not proof of vendor storage; no raw values exported.";
const API_EVIDENCE_ALLOWED_WEBRTC_PATTERNS = new Set([
  "api.webrtc.peer_connection_setup",
  "api.webrtc.offer_probe",
  "api.webrtc.ice_probe",
  "api.webrtc.stun_turn_assisted_probe",
]);
const API_EVIDENCE_ALLOWED_CANVAS_PATTERNS = new Set([
  "api.canvas.readback",
  "api.canvas.repeated_readback",
]);
const API_EVIDENCE_SECTION_VENDOR = "vendor";
const API_EVIDENCE_SECTION_CONTEXTUAL = "contextual";
const API_EVIDENCE_GROUP_META = Object.freeze({
  "api.canvas.readback": {
    label: "Canvas readback",
    whatThisMeans: "This can be used to help identify your device or browser.",
    actionSurfaceLabel: "Canvas",
  },
  "api.canvas.repeated_readback": {
    label: "Repeated canvas readback",
    whatThisMeans: "This can be used to help identify your device or browser. Repetition makes the signal more notable.",
    actionSurfaceLabel: "Canvas",
  },
  "api.webrtc.peer_connection_setup": {
    label: "WebRTC connection setup",
    whatThisMeans: "This can be used to prepare network or device probing from the browser.",
    actionSurfaceLabel: "WebRTC",
  },
  "api.webrtc.offer_probe": {
    label: "WebRTC offer probing",
    whatThisMeans: "This can be used to infer network or device characteristics.",
    actionSurfaceLabel: "WebRTC",
  },
  "api.webrtc.ice_probe": {
    label: "WebRTC network probing",
    whatThisMeans: "This can be used to infer network or device characteristics.",
    actionSurfaceLabel: "WebRTC",
  },
  "api.webrtc.stun_turn_assisted_probe": {
    label: "WebRTC STUN/TURN probing",
    whatThisMeans: "This can be used to infer network or device characteristics. STUN or TURN assistance makes the probe more notable.",
    actionSurfaceLabel: "WebRTC",
  },
  geolocation: {
    label: "Location access request",
    whatThisMeans: "This may allow a site to access your location if permission is granted.",
    actionSurfaceLabel: "Geolocation",
  },
  "clipboard.read": {
    label: "Clipboard read attempt",
    whatThisMeans: "This may allow access to copied content if permission is granted.",
    actionSurfaceLabel: "Clipboard",
  },
});

function buildSiteInsightsHref(site) {
  if (!String(site || "").trim()) return "/";
  return `/site.html?site=${encodeURIComponent(site)}`;
}

function showMissingState(site, scopeParam) {
  const missing = qs("vaultMissingState");
  const content = qs("vaultContent");
  const sections = qs("vaultSections");
  const openSiteInsightsLink = qs("vaultOpenSiteInsightsLink");
  const howItWorksButton = qs("vaultHowItWorksButton");
  const howItWorksBody = qs("vaultHowItWorksBody");
  if (!missing || !content || !sections || !openSiteInsightsLink || !howItWorksButton || !howItWorksBody) return;

  missing.classList.remove("hidden");
  content.classList.add("hidden");
  sections.classList.add("hidden");

  const hasSite = Boolean(String(site || "").trim());
  openSiteInsightsLink.href = hasSite ? buildSiteInsightsHref(site) : "/?view=sites";

  howItWorksBody.classList.add("hidden");
  howItWorksButton.setAttribute("aria-expanded", "false");
  howItWorksButton.textContent = "How it works";
  howItWorksButton.onclick = () => {
    const isHidden = howItWorksBody.classList.contains("hidden");
    howItWorksBody.classList.toggle("hidden", !isHidden);
    howItWorksButton.setAttribute("aria-expanded", String(isHidden));
    howItWorksButton.textContent = isHidden ? "Hide details" : "How it works";
  };

  bootLandingDirectory(site, scopeParam);
}

function normalizeLandingSort(sort) {
  const value = String(sort || "").trim().toLowerCase();
  if (value === LANDING_SORT_RECENT) return LANDING_SORT_RECENT;
  if (value === LANDING_SORT_BLOCKED) return LANDING_SORT_BLOCKED;
  return LANDING_SORT_ACTIVITY;
}

function getLandingSiteSelect() {
  return qs("vendorDirectorySite");
}

function setLandingDirectoryStatus(message, opts = {}) {
  const status = qs("vendorDirectoryStatus");
  if (!status) return;
  const text = String(message || "").trim();
  status.textContent = text;
  status.classList.toggle("hidden", !text);
  status.classList.toggle("vendor-directory-status-error", Boolean(opts.isError) && Boolean(text));
}

function updateLandingScopeInUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("vendor");
  url.searchParams.set("scope", landingDirectoryState.scope === SCOPE_SITE ? SCOPE_SITE : SCOPE_ALL);
  if (landingDirectoryState.scope === SCOPE_SITE && landingDirectoryState.selectedSite) {
    url.searchParams.set("site", landingDirectoryState.selectedSite);
  } else {
    url.searchParams.delete("site");
  }
  const next = `${url.pathname}?${url.searchParams.toString()}`;
  window.history.replaceState({}, "", next);
}

function toDirectoryVendorRow(row) {
  const vendorIdRaw = String(row && row.vendor_id ? row.vendor_id : "").trim().toLowerCase();
  const vendorId = vendorIdRaw && vendorIdRaw !== "unknown" ? vendorIdRaw : "unknown";
  const vendorName = String(row && row.vendor_name ? row.vendor_name : vendorId).trim() || vendorId;
  const totalEvents = toSafeCount(row && row.total_events);
  const observedCount = toSafeCount(row && row.observed_count);
  const blockedCount = toSafeCount(row && row.blocked_count);
  const lastSeen = Number(row && row.last_seen) > 0 ? Number(row.last_seen) : 0;
  return {
    vendor_id: vendorId,
    vendor_name: vendorName,
    total_events: totalEvents,
    observed_count: observedCount,
    blocked_count: blockedCount,
    last_seen: lastSeen,
  };
}

function isGenericVendorName(name, vendorId) {
  const normalized = String(name || "").trim().toLowerCase();
  if (!normalized) return true;
  if (normalized === String(vendorId || "").trim().toLowerCase()) return true;
  return normalized === "unknown"
    || normalized === "other"
    || normalized === "n/a"
    || normalized === "na"
    || normalized === "vendor";
}

function pickPreferredDirectoryVendorName(nameCounts, vendorId) {
  const entries = Array.from(nameCounts.entries());
  if (!entries.length) return vendorId;

  entries.sort((a, b) => {
    const aName = a[0];
    const bName = b[0];
    const aCount = Number(a[1]) || 0;
    const bCount = Number(b[1]) || 0;
    if (bCount !== aCount) return bCount - aCount;

    const aGeneric = isGenericVendorName(aName, vendorId);
    const bGeneric = isGenericVendorName(bName, vendorId);
    if (aGeneric !== bGeneric) return aGeneric ? 1 : -1;

    if (bName.length !== aName.length) return bName.length - aName.length;
    return aName.localeCompare(bName);
  });

  return entries[0][0] || vendorId;
}

function dedupeLandingVendorRows(rows) {
  const merged = new Map();

  for (const row of rows || []) {
    const safeRow = toDirectoryVendorRow(row);
    const vendorId = safeRow.vendor_id || "unknown";
    const existing = merged.get(vendorId) || {
      vendor_id: vendorId,
      vendor_name: vendorId,
      total_events: 0,
      observed_count: 0,
      blocked_count: 0,
      last_seen: 0,
      name_counts: new Map(),
    };

    existing.total_events += safeRow.total_events;
    existing.observed_count += safeRow.observed_count;
    existing.blocked_count += safeRow.blocked_count;
    existing.last_seen = Math.max(existing.last_seen, safeRow.last_seen);
    if (safeRow.vendor_name) {
      existing.name_counts.set(
        safeRow.vendor_name,
        (existing.name_counts.get(safeRow.vendor_name) || 0) + Math.max(1, safeRow.total_events)
      );
    }

    merged.set(vendorId, existing);
  }

  return Array.from(merged.values()).map((row) => ({
    vendor_id: row.vendor_id || "unknown",
    vendor_name: pickPreferredDirectoryVendorName(row.name_counts, row.vendor_id || "unknown"),
    total_events: toSafeCount(row.total_events),
    observed_count: toSafeCount(row.observed_count),
    blocked_count: toSafeCount(row.blocked_count),
    last_seen: Number(row.last_seen) || 0,
  }));
}

function computeDirectoryActivityScore(row) {
  return toSafeCount(row && row.observed_count) + toSafeCount(row && row.blocked_count);
}

function getFilteredAndSortedLandingVendors() {
  const search = String(landingDirectoryState.search || "").trim().toLowerCase();
  const filtered = landingDirectoryState.vendors.filter((row) => {
    if (!search) return true;
    return String(row.vendor_name || "").toLowerCase().includes(search);
  });

  filtered.sort((a, b) => {
    if (landingDirectoryState.sort === LANDING_SORT_RECENT) {
      return (b.last_seen - a.last_seen)
        || (computeDirectoryActivityScore(b) - computeDirectoryActivityScore(a))
        || a.vendor_name.localeCompare(b.vendor_name);
    }
    if (landingDirectoryState.sort === LANDING_SORT_BLOCKED) {
      return (b.blocked_count - a.blocked_count)
        || (b.last_seen - a.last_seen)
        || a.vendor_name.localeCompare(b.vendor_name);
    }
    return (computeDirectoryActivityScore(b) - computeDirectoryActivityScore(a))
      || (b.last_seen - a.last_seen)
      || a.vendor_name.localeCompare(b.vendor_name);
  });

  return filtered;
}

function buildLandingVendorHref(vendorId) {
  const params = new URLSearchParams();
  params.set("vendor", String(vendorId || "").trim() || "unknown");
  if (landingDirectoryState.scope === SCOPE_SITE && landingDirectoryState.selectedSite) {
    params.set("site", landingDirectoryState.selectedSite);
    params.set("scope", SCOPE_SITE);
  } else {
    params.set("scope", SCOPE_ALL);
  }
  return `/vendor-vault.html?${params.toString()}`;
}

function clearLandingVendorGrid() {
  const grid = qs("vendorDirectoryGrid");
  if (!grid) return;
  grid.innerHTML = "";
}

function renderLandingVendorGrid() {
  const grid = qs("vendorDirectoryGrid");
  if (!grid) return;
  grid.innerHTML = "";

  const rows = getFilteredAndSortedLandingVendors();
  if (!rows.length) {
    if (!landingDirectoryState.vendors.length) {
      setLandingDirectoryStatus("No vendors observed in this scope yet.");
    } else {
      setLandingDirectoryStatus("No vendors match your search.");
    }
    return;
  }

  setLandingDirectoryStatus("");

  for (const row of rows) {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "vendor-directory-card";

    const title = document.createElement("div");
    title.className = "vendor-directory-card-title";
    title.textContent = row.vendor_name;
    card.appendChild(title);

    const counts = document.createElement("div");
    counts.className = "vendor-directory-card-meta";
    counts.textContent = `Observed: ${row.observed_count} | Blocked: ${row.blocked_count}`;
    card.appendChild(counts);

    const lastSeen = document.createElement("div");
    lastSeen.className = "vendor-directory-card-meta";
    lastSeen.textContent = `Last seen: ${formatDateTime(row.last_seen)}`;
    card.appendChild(lastSeen);

    card.addEventListener("click", () => {
      window.location.assign(buildLandingVendorHref(row.vendor_id));
    });

    grid.appendChild(card);
  }
}

function setLandingSiteSelectVisible(visible) {
  const siteSelect = getLandingSiteSelect();
  if (!siteSelect) return;
  siteSelect.classList.toggle("hidden", !visible);
}

function renderLandingSiteOptions() {
  const siteSelect = getLandingSiteSelect();
  if (!siteSelect) return;

  siteSelect.innerHTML = "";
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = "Choose site...";
  siteSelect.appendChild(placeholder);

  for (const site of landingDirectoryState.sites) {
    const option = document.createElement("option");
    option.value = site;
    option.textContent = site;
    siteSelect.appendChild(option);
  }

  if (landingDirectoryState.selectedSite && landingDirectoryState.sites.includes(landingDirectoryState.selectedSite)) {
    siteSelect.value = landingDirectoryState.selectedSite;
  } else {
    siteSelect.value = "";
  }
}

async function loadLandingSites() {
  try {
    const response = await fetch("/api/sites");
    if (!response.ok) throw new Error(`sites_request_failed_${response.status}`);
    const rows = await response.json();
    landingDirectoryState.sites = Array.from(new Set(
      (Array.isArray(rows) ? rows : [])
        .map((row) => String(row && row.site ? row.site : "").trim())
        .filter(Boolean)
    ));
    renderLandingSiteOptions();
  } catch (err) {
    console.error("Vendor directory sites fetch failed:", err);
    landingDirectoryState.sites = [];
    renderLandingSiteOptions();
    setLandingDirectoryStatus("Could not load sites list.", { isError: true });
  }
}

function buildLandingVendorsUrl() {
  if (landingDirectoryState.scope === SCOPE_SITE && landingDirectoryState.selectedSite) {
    return `/api/vendors?site=${encodeURIComponent(landingDirectoryState.selectedSite)}`;
  }
  return "/api/vendors";
}

async function loadLandingVendors() {
  const requestId = ++latestLandingVendorsRequestId;
  clearLandingVendorGrid();
  setLandingDirectoryStatus("Loading vendors...");

  if (landingDirectoryState.scope === SCOPE_SITE && !landingDirectoryState.selectedSite) {
    landingDirectoryState.vendors = [];
    setLandingDirectoryStatus("Choose a site to view vendors.");
    return;
  }

  try {
    const response = await fetch(buildLandingVendorsUrl());
    if (!response.ok) throw new Error(`vendors_request_failed_${response.status}`);
    const payload = await response.json();
    if (requestId !== latestLandingVendorsRequestId) return;
    const rows = Array.isArray(payload) ? payload : [];
    landingDirectoryState.vendors = dedupeLandingVendorRows(rows);
    renderLandingVendorGrid();
  } catch (err) {
    if (requestId !== latestLandingVendorsRequestId) return;
    console.error("Vendor directory fetch failed:", err);
    landingDirectoryState.vendors = [];
    clearLandingVendorGrid();
    setLandingDirectoryStatus("Could not load vendors for this scope.", { isError: true });
  }
}

async function handleLandingScopeChange(nextScope) {
  landingDirectoryState.scope = nextScope === SCOPE_SITE ? SCOPE_SITE : SCOPE_ALL;
  setLandingSiteSelectVisible(landingDirectoryState.scope === SCOPE_SITE);

  if (landingDirectoryState.scope === SCOPE_SITE) {
    await loadLandingSites();
    if (!landingDirectoryState.selectedSite && landingDirectoryState.sites.length) {
      landingDirectoryState.selectedSite = landingDirectoryState.sites[0];
    }
    renderLandingSiteOptions();
  } else {
    landingDirectoryState.selectedSite = "";
  }

  updateLandingScopeInUrl();
  await loadLandingVendors();
}

function bindLandingDirectoryControls() {
  if (landingDirectoryControlsBound) return;

  const searchInput = qs("vendorDirectorySearch");
  const sortSelect = qs("vendorDirectorySort");
  const scopeSelect = qs("vendorDirectoryScope");
  const siteSelect = getLandingSiteSelect();
  if (!searchInput || !sortSelect || !scopeSelect || !siteSelect) return;

  searchInput.addEventListener("input", () => {
    landingDirectoryState.search = searchInput.value || "";
    renderLandingVendorGrid();
  });

  sortSelect.addEventListener("change", () => {
    landingDirectoryState.sort = normalizeLandingSort(sortSelect.value);
    renderLandingVendorGrid();
  });

  scopeSelect.addEventListener("change", () => {
    void handleLandingScopeChange(scopeSelect.value);
  });

  siteSelect.addEventListener("change", () => {
    landingDirectoryState.selectedSite = String(siteSelect.value || "").trim();
    updateLandingScopeInUrl();
    void loadLandingVendors();
  });

  landingDirectoryControlsBound = true;
}

function bootLandingDirectory(initialSite, scopeParam) {
  const searchInput = qs("vendorDirectorySearch");
  const sortSelect = qs("vendorDirectorySort");
  const scopeSelect = qs("vendorDirectoryScope");
  const siteSelect = getLandingSiteSelect();
  if (!searchInput || !sortSelect || !scopeSelect || !siteSelect) return;

  landingDirectoryState.search = "";
  landingDirectoryState.sort = LANDING_SORT_ACTIVITY;
  landingDirectoryState.scope = normalizeScope(scopeParam) === SCOPE_SITE ? SCOPE_SITE : SCOPE_ALL;
  landingDirectoryState.selectedSite = landingDirectoryState.scope === SCOPE_SITE ? String(initialSite || "").trim() : "";

  searchInput.value = "";
  sortSelect.value = LANDING_SORT_ACTIVITY;
  scopeSelect.value = landingDirectoryState.scope;

  bindLandingDirectoryControls();
  setLandingSiteSelectVisible(landingDirectoryState.scope === SCOPE_SITE);

  if (landingDirectoryState.scope === SCOPE_SITE) {
    void loadLandingSites().then(() => {
      if (!landingDirectoryState.selectedSite && landingDirectoryState.sites.length) {
        landingDirectoryState.selectedSite = landingDirectoryState.sites[0];
      }
      renderLandingSiteOptions();
      updateLandingScopeInUrl();
      return loadLandingVendors();
    });
    return;
  }

  updateLandingScopeInUrl();
  void loadLandingVendors();
}

function normalizeScope(scope) {
  const value = String(scope || "").trim().toLowerCase();
  if (value === SCOPE_ALL) return SCOPE_ALL;
  if (value === SCOPE_SITE) return SCOPE_SITE;
  return "";
}

function resolveInitialScope(site, scopeParam) {
  const normalized = normalizeScope(scopeParam);
  if (normalized === SCOPE_SITE && site) return SCOPE_SITE;
  if (normalized === SCOPE_ALL) return SCOPE_ALL;
  return site ? SCOPE_SITE : SCOPE_ALL;
}

function updateScopeInUrl(scope) {
  const url = new URL(window.location.href);
  url.searchParams.set("scope", scope === SCOPE_ALL ? SCOPE_ALL : SCOPE_SITE);
  const next = `${url.pathname}?${url.searchParams.toString()}`;
  window.history.replaceState({}, "", next);
}

function showVaultContent(site, vendor) {
  const missing = qs("vaultMissingState");
  const content = qs("vaultContent");
  const sections = qs("vaultSections");
  const vendorChip = qs("vaultVendorChip");
  const backLink = qs("backToSiteInsightsLink");
  if (!missing || !content || !sections || !vendorChip || !backLink) return;

  missing.classList.add("hidden");
  content.classList.remove("hidden");
  sections.classList.remove("hidden");

  vendorChip.textContent = `Vendor: ${vendor}`;
  backLink.href = site ? buildSiteInsightsHref(site) : "/";
}

function renderScopeChipsAndControls() {
  const siteChip = qs("vaultSiteChip");
  const vendorChip = qs("vaultVendorChip");
  const allSitesChip = qs("vaultAllSitesChip");
  const siteButton = qs("vaultScopeSiteButton");
  const allButton = qs("vaultScopeAllButton");
  const backLink = qs("backToSiteInsightsLink");
  if (!siteChip || !vendorChip || !allSitesChip || !siteButton || !allButton || !backLink) return;

  const hasSite = Boolean(vaultScopeState.site);
  const isAll = vaultScopeState.scope === SCOPE_ALL;

  vendorChip.textContent = `Vendor: ${vaultScopeState.vendor}`;
  siteChip.textContent = `Site: ${vaultScopeState.site || "-"}`;
  siteChip.classList.toggle("hidden", isAll);
  allSitesChip.classList.toggle("hidden", !isAll);

  siteButton.disabled = !hasSite;
  siteButton.classList.toggle("is-active", !isAll);
  siteButton.setAttribute("aria-pressed", String(!isAll));

  allButton.classList.toggle("is-active", isAll);
  allButton.setAttribute("aria-pressed", String(isAll));

  backLink.href = hasSite ? buildSiteInsightsHref(vaultScopeState.site) : "/";
}

function renderScopeCopy() {
  const empty = qs("exposureEmptyState");
  if (!empty) return;
  if (vaultScopeState.scope === SCOPE_ALL) {
    empty.textContent = "No exposure signals observed for this vendor across captured sites in request metadata.";
    return;
  }
  empty.textContent = "No exposure signals observed for this scope in captured request metadata.";
}

function setScope(nextScope, opts = {}) {
  const requested = normalizeScope(nextScope) || SCOPE_SITE;
  if (requested === SCOPE_SITE && !vaultScopeState.site) return;
  if (vaultScopeState.scope === requested) return;

  vaultScopeState.scope = requested;
  renderScopeChipsAndControls();
  renderScopeCopy();
  setExportStatus("");
  if (opts.updateUrl !== false) updateScopeInUrl(vaultScopeState.scope);
  if (opts.reload !== false) {
    loadExposureInventory();
    loadVendorVaultSummary();
    loadVendorApiEvidence();
  }
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function toSafeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function normalizeVendorId(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeApiEvidenceToken(value) {
  return String(value || "").trim().toLowerCase();
}

function formatDateTime(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return "-";
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleString();
}

function formatIsoDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "1970-01-01";
  return date.toISOString().slice(0, 10);
}

function sanitizeFilenamePart(value, fallback) {
  const cleaned = String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
  return cleaned || fallback;
}

function getScopedSiteValue() {
  if (vaultScopeState.scope === SCOPE_ALL) return null;
  const site = String(vaultScopeState.site || "").trim();
  return site || null;
}

function setExportStatus(message, isError = false) {
  const status = qs("vaultExportStatus");
  if (!status) return;
  status.textContent = message || "";
  status.classList.toggle("is-error", Boolean(isError));
}

function setExportBusy(mode) {
  const jsonButton = qs("vaultExportButton");
  const csvButton = qs("vaultExportCsvButton");
  const isBusy = Boolean(mode);
  const isJson = mode === "json";
  const isCsv = mode === "csv";

  if (jsonButton) {
    jsonButton.disabled = isBusy;
    jsonButton.textContent = isJson ? "Exporting..." : "Export JSON";
  }
  if (csvButton) {
    csvButton.disabled = isBusy;
    csvButton.textContent = isCsv ? "Exporting..." : "Export CSV";
  }
}

function downloadTextFile(filename, text, mimeType) {
  const blob = new Blob([text], { type: mimeType || "text/plain;charset=utf-8" });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}

function downloadJsonFile(filename, payload) {
  downloadTextFile(filename, JSON.stringify(payload, null, 2), "application/json");
}

function escapeCsvCell(value) {
  const raw = value == null ? "" : String(value);
  const escaped = raw.replace(/"/g, "\"\"");
  return `"${escaped}"`;
}

function rowToCsv(cells) {
  return cells.map((value) => escapeCsvCell(value)).join(",");
}

function formatExportTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return "";
  const date = new Date(n);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString();
}

function clearElement(node) {
  if (!node) return;
  node.innerHTML = "";
}

function renderPanelMessage(panelId, text, className) {
  const panel = qs(panelId);
  if (!panel) return;
  clearElement(panel);

  const line = document.createElement("div");
  line.className = className;
  line.textContent = text;
  panel.appendChild(line);
}

function appendPanelRow(panel, key, value) {
  if (!panel) return;
  const row = document.createElement("div");
  row.className = "vendor-vault-panel-row";

  const keyEl = document.createElement("span");
  keyEl.className = "vendor-vault-panel-key";
  keyEl.textContent = key;
  row.appendChild(keyEl);

  const valueEl = document.createElement("span");
  valueEl.className = "vendor-vault-panel-value";
  valueEl.textContent = value;
  row.appendChild(valueEl);

  panel.appendChild(row);
}

function appendPanelMeta(panel, text) {
  if (!panel) return;
  const line = document.createElement("div");
  line.className = "vendor-vault-panel-meta";
  line.textContent = text;
  panel.appendChild(line);
}

function appendPanelList(panel, items) {
  if (!panel || !Array.isArray(items) || !items.length) return;
  const list = document.createElement("ul");
  list.className = "vendor-vault-panel-list";
  for (const item of items) {
    const li = document.createElement("li");
    li.textContent = item;
    list.appendChild(li);
  }
  panel.appendChild(list);
}

function formatRiskLabel(label) {
  return titleCaseFromSnake(String(label || "").trim()).replace(/Only$/i, " only");
}

function toCountObject(value) {
  if (!value || typeof value !== "object") return {};
  const out = {};
  for (const [key, count] of Object.entries(value)) {
    const safeKey = String(key || "").trim();
    if (!safeKey) continue;
    out[safeKey] = toSafeCount(count);
  }
  return out;
}

function orderCountEntries(countsObj, preferredOrder = []) {
  const rows = [];
  const seen = new Set();
  for (const key of preferredOrder) {
    if (!Object.prototype.hasOwnProperty.call(countsObj, key)) continue;
    rows.push([key, countsObj[key]]);
    seen.add(key);
  }
  for (const [key, count] of Object.entries(countsObj)) {
    if (seen.has(key)) continue;
    rows.push([key, count]);
  }
  rows.sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]));
  return rows;
}

function renderActivitySummaryPanel(summary, hasData) {
  const panel = qs("vaultActivityPanel");
  if (!panel) return;
  clearElement(panel);
  if (!hasData) {
    renderPanelMessage("vaultActivityPanel", "No data observed for this scope.", "vendor-vault-panel-empty");
    return;
  }

  appendPanelRow(panel, "Total events", String(toSafeCount(summary && summary.total_events)));
  appendPanelRow(panel, "Observed", String(toSafeCount(summary && summary.observed_count)));
  appendPanelRow(panel, "Blocked", String(toSafeCount(summary && summary.blocked_count)));
  appendPanelRow(panel, "First seen", formatDateTime(summary && summary.first_seen));
  appendPanelRow(panel, "Last seen", formatDateTime(summary && summary.last_seen));
}

function renderDomainsPanel(domainsUsed, hasData) {
  const panel = qs("vaultDomainsPanel");
  if (!panel) return;
  clearElement(panel);

  const totalDistinct = toSafeCount(domainsUsed && domainsUsed.domain_count_total);
  const topDomains = Array.isArray(domainsUsed && domainsUsed.top_domains) ? domainsUsed.top_domains : [];
  if (!hasData || totalDistinct <= 0) {
    renderPanelMessage("vaultDomainsPanel", "No data observed for this scope.", "vendor-vault-panel-empty");
    return;
  }

  appendPanelRow(panel, "Distinct domains", String(totalDistinct));
  const topFive = topDomains
    .slice(0, 5)
    .map((row) => `${String(row && row.domain ? row.domain : "-")} (${toSafeCount(row && row.count)})`);
  if (topFive.length) {
    appendPanelMeta(panel, "Top domains");
    appendPanelList(panel, topFive);
  }
}

function renderKeysPanel(keysSummary, hasData) {
  const panel = qs("vaultKeysPanel");
  if (!panel) return;
  clearElement(panel);

  const totalDistinct = toSafeCount(keysSummary && keysSummary.key_count_total);
  const topKeys = Array.isArray(keysSummary && keysSummary.top_keys) ? keysSummary.top_keys : [];
  if (!hasData || totalDistinct <= 0) {
    renderPanelMessage("vaultKeysPanel", "No data observed for this scope.", "vendor-vault-panel-empty");
    return;
  }

  appendPanelRow(panel, "Distinct keys", String(totalDistinct));
  const topFive = topKeys
    .slice(0, 5)
    .map((row) => `${String(row && row.key ? row.key : "-")} (${toSafeCount(row && row.count)})`);
  if (topFive.length) {
    appendPanelMeta(panel, "Top keys");
    appendPanelList(panel, topFive);
  }
}

function renderRiskDimension(panel, title, countsObj, preferredOrder, limit) {
  appendPanelMeta(panel, title);
  const entries = orderCountEntries(countsObj, preferredOrder).slice(0, Math.max(1, limit || 4));
  if (!entries.length) {
    const unavailable = document.createElement("div");
    unavailable.className = "vendor-vault-panel-empty";
    unavailable.textContent = "Not available";
    panel.appendChild(unavailable);
    return;
  }
  appendPanelList(panel, entries.map(([key, count]) => `${formatRiskLabel(key)}: ${count}`));
}

function renderRiskSummaryPanel(riskSummary, hasData) {
  const panel = qs("vaultRiskPanel");
  if (!panel) return;
  clearElement(panel);

  if (!hasData) {
    renderPanelMessage("vaultRiskPanel", "No data observed for this scope.", "vendor-vault-panel-empty");
    return;
  }

  const mitigation = toCountObject(riskSummary && riskSummary.mitigation_status_counts);
  const signalType = toCountObject(riskSummary && riskSummary.signal_type_counts);
  const privacyStatus = toCountObject(riskSummary && riskSummary.privacy_status_counts);

  renderRiskDimension(panel, "Mitigation", mitigation, ["allowed", "observed_only", "blocked", "modified"], 4);
  renderRiskDimension(panel, "Signal type", signalType, [], 4);
  renderRiskDimension(panel, "Privacy status", privacyStatus, [], 4);
}

function setSummaryPanelsLoading() {
  renderPanelMessage("vaultActivityPanel", "Loading...", "hint");
  renderPanelMessage("vaultDomainsPanel", "Loading...", "hint");
  renderPanelMessage("vaultKeysPanel", "Loading...", "hint");
  renderPanelMessage("vaultRiskPanel", "Loading...", "hint");
}

function setSummaryPanelsError() {
  renderPanelMessage("vaultActivityPanel", "Could not load data for this scope.", "vendor-vault-panel-error");
  renderPanelMessage("vaultDomainsPanel", "Could not load data for this scope.", "vendor-vault-panel-error");
  renderPanelMessage("vaultKeysPanel", "Could not load data for this scope.", "vendor-vault-panel-error");
  renderPanelMessage("vaultRiskPanel", "Could not load data for this scope.", "vendor-vault-panel-error");
}

function renderVendorVaultSummaryPanels(payload) {
  const safePayload = payload && typeof payload === "object" ? payload : {};
  const activity = safePayload.activity_summary || {};
  const hasData = toSafeCount(activity.total_events) > 0;

  renderActivitySummaryPanel(activity, hasData);
  renderDomainsPanel(safePayload.domains_used, hasData);
  renderKeysPanel(safePayload.observed_parameter_keys, hasData);
  renderRiskSummaryPanel(safePayload.risk_summary, hasData);
}

function formatConfidence(confidence) {
  return `${Math.round(clamp01(confidence) * 100)}%`;
}

function titleCaseFromSnake(value) {
  return String(value || "unknown")
    .split("_")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function getCategoryMeaning(categoryId) {
  const key = String(categoryId || "").trim();
  const fromMap = CATEGORY_MEANINGS[key];
  if (fromMap) return fromMap;
  return {
    label: titleCaseFromSnake(key || "unknown"),
    description: "Meaning is uncertain from captured key names alone.",
    concern: "Potential impact is uncertain for this key pattern.",
    plainEnglishWhat: "The category name suggests a potentially shareable identifier or metadata field.",
    plainEnglishWhy: "Fields in this category can still contribute to tracking or linkage depending on context.",
  };
}

function normalizeKeyName(key) {
  return String(key || "")
    .trim()
    .toLowerCase()
    .replace(/\[\]$/g, "")
    .replace(/\s+/g, "_");
}

function getKeyHint(exampleKey) {
  const normalized = normalizeKeyName(exampleKey);
  for (const rule of KEY_HINT_RULES) {
    if (rule.test(normalized)) {
      return {
        meaning: rule.meaning,
        confidence: rule.confidence,
      };
    }
  }
  return {
    meaning: "Meaning is uncertain from key name alone; endpoint context matters.",
    confidence: "low",
  };
}

function getOverallScoreBand(score) {
  if (score >= 67) return "High";
  if (score >= 34) return "Medium";
  return "Low";
}

function getItemScoreBand(score) {
  if (score >= 60) return "High";
  if (score >= 25) return "Medium";
  return "Low";
}

function getEvidenceCounts(row) {
  const levels = row && typeof row.evidence_levels === "object" ? row.evidence_levels : {};
  const observed = toSafeCount(levels.observed);
  const attempted = toSafeCount(levels.attempted);
  const unknown = toSafeCount(levels.unknown);
  const total = observed + attempted + unknown;
  if (total > 0) return { observed, attempted, unknown, total };
  const fallbackCount = toSafeCount(row && row.count);
  return { observed: 0, attempted: 0, unknown: fallbackCount, total: fallbackCount };
}

function computeOverallRowContribution(row) {
  const categoryId = String(row && row.data_category ? row.data_category : "");
  const categoryWeight = OVERALL_CATEGORY_WEIGHTS[categoryId] || DEFAULT_OVERALL_CATEGORY_WEIGHT;
  const confidence = clamp01(row && row.confidence);
  const counts = getEvidenceCounts(row);
  const denominator = Math.max(1, counts.total || toSafeCount(row && row.count));
  const evidenceFactor = (
    (counts.observed * EVIDENCE_FACTORS.observed) +
    (counts.attempted * EVIDENCE_FACTORS.attempted) +
    (counts.unknown * EVIDENCE_FACTORS.unknown)
  ) / denominator;
  const contribution = categoryWeight * confidence * evidenceFactor;
  return Number.isFinite(contribution) ? contribution : 0;
}

function computeExposureScore(rows) {
  const safeRows = Array.isArray(rows) ? rows : [];
  let total = 0;
  for (const row of safeRows) total += computeOverallRowContribution(row);
  const score = Math.max(0, Math.min(100, Math.round(total)));
  return { score, band: getOverallScoreBand(score) };
}

function computeItemScore(row) {
  const categoryId = String(row && row.data_category ? row.data_category : "");
  const weight = ITEM_CATEGORY_WEIGHTS[categoryId] || DEFAULT_ITEM_CATEGORY_WEIGHT;
  const confidence = clamp01(row && row.confidence);
  const counts = getEvidenceCounts(row);
  const countTotal = Math.max(1, counts.total);
  const evidenceFactor = (
    (counts.observed * EVIDENCE_FACTORS.observed) +
    (counts.attempted * EVIDENCE_FACTORS.attempted) +
    (counts.unknown * EVIDENCE_FACTORS.unknown)
  ) / countTotal;
  const raw = confidence * weight * evidenceFactor;
  const itemScore = Math.max(0, Math.min(100, Math.round(raw)));
  return {
    itemScore,
    itemBand: getItemScoreBand(itemScore),
    weight,
    confidencePct: Math.round(confidence * 100),
    evidenceFactor,
  };
}

function getItemStatus(counts) {
  return counts.observed > 0 ? "Observed" : "Attempted";
}

function getItemScenario(counts) {
  if (counts.observed > 0) return "observed";
  if (counts.attempted > 0) return "attempted_only";
  return "unknown";
}

function makeOpenInSiteInsightsAction(site, vendor) {
  const guidanceVendor = String(vendor || "").trim();
  const hasSite = Boolean(String(site || "").trim());
  return {
    key: "open_site_insights",
    text: "Open in Site Insights",
    href: hasSite ? buildSiteInsightsHref(site) : null,
    guidance: hasSite
      ? (guidanceVendor ? `Then select ${guidanceVendor} in vendor focus.` : "Then select this vendor in vendor focus.")
      : "Open Site Insights from a specific site to focus this vendor there.",
  };
}

function getCategorySpecificAction(categoryId, scenario) {
  if (categoryId === "identifiers" && scenario === "observed") {
    return { key: "identifiers_observed", text: "Identifiers can enable cross-site linking; keep Strict mode enabled." };
  }
  if (categoryId === "identifiers" && scenario === "attempted_only") {
    return { key: "identifiers_attempted", text: "Blocked identifier attempts suggest tracking intent; keep protections enabled." };
  }
  if (categoryId === "analytics_ids" && scenario === "observed") {
    return { key: "analytics_observed", text: "Analytics identifiers can persist across visits; consider privacy mode for this site." };
  }
  if (categoryId === "advertising_ids" && scenario === "observed") {
    return { key: "advertising_observed", text: "Advertising identifiers can be used for profiling; consider limiting ad scripts on this site." };
  }
  if (categoryId === "contact_like" && scenario === "observed") {
    return { key: "contact_observed", text: "Avoid entering email/phone into embedded widgets; consider using an alias." };
  }
  if (categoryId === "location_like" && scenario === "observed") {
    return { key: "location_observed", text: "Disable location permission for this site (if enabled) and avoid sharing precise location." };
  }
  if (categoryId === "session_tokens" && scenario === "observed") {
    return { key: "session_observed", text: "Tokens relate to login/session state; log out when finished and avoid reusing sessions." };
  }
  return null;
}

function mapSuggestedActions({ categoryId, scenario, observed, attempted, site, vendor }) {
  const actions = [makeOpenInSiteInsightsAction(site, vendor)];

  let primaryScenarioAction = null;
  let secondaryScenarioAction = null;
  if (scenario === "attempted_only" || (observed === 0 && attempted > 0)) {
    primaryScenarioAction = {
      key: "attempted_strict_mode",
      text: "Keep Strict mode enabled to continue blocking attempts.",
    };
    secondaryScenarioAction = {
      key: "attempted_monitor_again",
      text: "Monitor again after browsing (attempts can vary by page).",
    };
  } else if (scenario === "observed" || observed > 0) {
    primaryScenarioAction = {
      key: "observed_clear_site_data",
      text: "Consider clearing site data (cookies/storage) after using this site.",
    };
    secondaryScenarioAction = {
      key: "observed_limit_third_party",
      text: "Consider limiting third-party scripts/trackers on this site.",
    };
  }
  if (primaryScenarioAction) actions.push(primaryScenarioAction);

  const categoryAction = getCategorySpecificAction(categoryId, scenario);
  if (categoryAction) actions.push(categoryAction);
  else if (secondaryScenarioAction) actions.push(secondaryScenarioAction);

  const deduped = [];
  const seen = new Set();
  for (const action of actions) {
    const key = String(action && action.key ? action.key : action && action.text ? action.text : "");
    if (!key || seen.has(key)) continue;
    deduped.push(action);
    seen.add(key);
  }
  return deduped.slice(0, 3);
}

function getInThisCaseLine(counts) {
  const observed = toSafeCount(counts && counts.observed);
  const attempted = toSafeCount(counts && counts.attempted);
  if (observed > 0) return "Observed leaving the browser; may have been received.";
  if (observed === 0 && attempted > 0) return "Attempts were blocked; not proof of receipt.";
  return "Signal level is uncertain in this scope.";
}

function buildItemModel(row, index, site, vendor) {
  const categoryId = String(row && row.data_category ? row.data_category : "");
  const meaning = getCategoryMeaning(categoryId);
  const counts = getEvidenceCounts(row);
  const exampleKey = String((row && row.example_key) || "-");
  const keyHint = getKeyHint(exampleKey);
  const scenario = getItemScenario(counts);
  const itemScoreMeta = computeItemScore(row);
  const actions = mapSuggestedActions({
    categoryId,
    scenario,
    observed: counts.observed,
    attempted: counts.attempted,
    site,
    vendor,
  });

  const privacyBullets = [
    meaning.concern,
  ];
  if (meaning.uncertaintyNote) privacyBullets.push(meaning.uncertaintyNote);

  let uncertaintyNote = String(meaning.uncertaintyNote || "").trim();
  if (keyHint.confidence === "low" && keyHint.meaning) {
    uncertaintyNote = uncertaintyNote
      ? `${uncertaintyNote} ${keyHint.meaning}`
      : keyHint.meaning;
  }

  return {
    index,
    categoryLabel: meaning.label,
    categoryDescription: meaning.description,
    plainEnglishWhat: meaning.plainEnglishWhat,
    plainEnglishWhy: meaning.plainEnglishWhy,
    inThisCase: getInThisCaseLine(counts),
    uncertaintyNote,
    keyHint,
    counts,
    scenario,
    statusLabel: getItemStatus(counts),
    itemScoreMeta,
    exampleKey,
    count: toSafeCount(row && row.count),
    firstSeen: formatDateTime(row && row.first_seen),
    lastSeen: formatDateTime(row && row.last_seen),
    confidenceText: formatConfidence(row && row.confidence),
    actions,
    privacyBullets,
  };
}

function formatCategorySet(set, emptyText) {
  const labels = Array.from(set.values()).sort((a, b) => a.localeCompare(b));
  if (!labels.length) return emptyText;
  return labels.join(", ");
}

function toBandShortLabel(band) {
  if (band === "Medium") return "Med";
  if (band === "High") return "High";
  if (band === "Low") return "Low";
  return "-";
}

function renderSummaryRing(score) {
  const ring = qs("exposureSummaryScoreRing");
  const visual = document.querySelector(".vendor-vault-score-visual");
  if (!ring) return;

  const radius = Number(ring.getAttribute("r")) || 44;
  const circumference = 2 * Math.PI * radius;
  const clamped = Math.max(0, Math.min(100, Number(score) || 0));
  const normalized = clamped / 100;

  ring.style.strokeDasharray = `${circumference} ${circumference}`;
  ring.style.strokeDashoffset = `${circumference * (1 - normalized)}`;

  if (visual) {
    visual.classList.remove("is-low", "is-medium", "is-high");
    if (clamped >= 67) visual.classList.add("is-high");
    else if (clamped >= 34) visual.classList.add("is-medium");
    else visual.classList.add("is-low");
  }
}

function renderActionList(listEl, actions) {
  if (!listEl) return;
  listEl.innerHTML = "";

  const safeActions = Array.isArray(actions) ? actions : [];
  for (const action of safeActions) {
    const li = document.createElement("li");
    if (action.href) {
      const link = document.createElement("a");
      link.href = action.href;
      link.textContent = action.text;
      link.className = "vendor-vault-action-link";
      li.appendChild(link);
      if (action.guidance) {
        const guidance = document.createElement("span");
        guidance.className = "vendor-vault-action-guidance";
        guidance.textContent = ` ${action.guidance}`;
        li.appendChild(guidance);
      }
    } else {
      li.textContent = action.text;
    }
    listEl.appendChild(li);
  }
}

function deriveVendorActions(itemModels) {
  const topTwo = itemModels
    .slice()
    .sort((a, b) => (
      (b.itemScoreMeta.itemScore - a.itemScoreMeta.itemScore) ||
      a.categoryLabel.localeCompare(b.categoryLabel)
    ))
    .slice(0, 2);

  const actions = [];
  const seen = new Set();
  for (const item of topTwo) {
    for (const action of item.actions) {
      const key = String(action && action.key ? action.key : action && action.text ? action.text : "");
      if (!key || seen.has(key)) continue;
      actions.push(action);
      seen.add(key);
      if (actions.length >= 3) return actions;
    }
  }
  return actions.slice(0, 3);
}

function renderSummary(scoreMeta, itemModels) {
  const scoreTextEl = qs("exposureSummaryScoreText");
  const scoreValueEl = qs("exposureSummaryScoreValue");
  const scoreBandEl = qs("exposureSummaryScoreBand");
  const mayList = qs("exposureMayHaveReceivedList");
  const attemptedList = qs("exposureAttemptedToReceiveList");
  const vendorActionsList = qs("exposureVendorActionsList");
  if (!scoreTextEl || !scoreValueEl || !scoreBandEl || !mayList || !attemptedList || !vendorActionsList) return;

  if (!scoreMeta) {
    scoreTextEl.textContent = "Exposure score: -";
    scoreValueEl.textContent = "-";
    scoreBandEl.textContent = "-";
    renderSummaryRing(0);
  } else {
    scoreTextEl.textContent = `Exposure score: ${scoreMeta.score} (${scoreMeta.band})`;
    scoreValueEl.textContent = String(scoreMeta.score);
    scoreBandEl.textContent = toBandShortLabel(scoreMeta.band);
    renderSummaryRing(scoreMeta.score);
  }

  const observedCategories = new Set();
  const attemptedCategories = new Set();
  for (const item of itemModels) {
    if (item.counts.observed > 0) observedCategories.add(item.categoryLabel);
    if (item.counts.attempted > 0) attemptedCategories.add(item.categoryLabel);
  }

  mayList.textContent = formatCategorySet(observedCategories, "None observed");
  attemptedList.textContent = formatCategorySet(attemptedCategories, "None detected");
  renderActionList(vendorActionsList, deriveVendorActions(itemModels));
}

function appendBulletList(section, bullets, listClassName) {
  const list = document.createElement("ul");
  list.className = listClassName;
  for (const bullet of bullets) {
    const li = document.createElement("li");
    li.textContent = bullet;
    list.appendChild(li);
  }
  section.appendChild(list);
}

function formatRequestCount(count) {
  const safe = toSafeCount(count);
  return `${safe} request${safe === 1 ? "" : "s"}`;
}

function getExpandedSummarySentence(item) {
  const keyText = item.exampleKey && item.exampleKey !== "-" ? ` key '${item.exampleKey}'` : " key pattern";
  const volumeText = formatRequestCount(item.count);

  if (item.counts.observed > 0 && item.counts.attempted > 0) {
    return `Observed potential sharing of ${item.categoryLabel}${keyText} (${volumeText}); some attempts were blocked.`;
  }
  if (item.counts.observed > 0) {
    return `Observed potential sharing of ${item.categoryLabel}${keyText} (${volumeText}); vendor may have received this type.`;
  }
  if (item.counts.attempted > 0) {
    return `Blocked attempt to share ${item.categoryLabel}${keyText} (${volumeText}); blocked attempts are not proof of receipt.`;
  }
  return `Potential ${item.categoryLabel} signal detected from ${keyText.trim()} (${volumeText}).`;
}

function renderGuidedActions(container, actions) {
  const safeActions = Array.isArray(actions) ? actions : [];
  const primaryAction = safeActions.find((action) => action && action.key === "open_site_insights")
    || safeActions.find((action) => action && action.href)
    || safeActions[0];
  const secondaryActions = safeActions.filter((action) => action !== primaryAction).slice(0, 2);

  if (primaryAction && primaryAction.href) {
    const primary = document.createElement("a");
    primary.href = primaryAction.href;
    primary.className = "vendor-vault-guided-primary";
    primary.textContent = primaryAction.text;
    container.appendChild(primary);

    if (primaryAction.guidance) {
      const guidance = document.createElement("p");
      guidance.className = "vendor-vault-guided-primary-note";
      guidance.textContent = primaryAction.guidance;
      container.appendChild(guidance);
    }
  }

  const secondary = document.createElement("ul");
  secondary.className = "vendor-vault-guided-guidance-list";
  for (const action of secondaryActions) {
    const bullet = document.createElement("li");
    bullet.className = "vendor-vault-guided-guidance-item";
    bullet.textContent = action && action.text ? action.text : "Action";
    secondary.appendChild(bullet);
  }
  if (secondary.childElementCount > 0) container.appendChild(secondary);
}

function appendEvidenceField(list, label, value) {
  const row = document.createElement("div");
  row.className = "vendor-vault-evidence-row";

  const term = document.createElement("dt");
  term.className = "vendor-vault-evidence-key";
  term.textContent = label;
  row.appendChild(term);

  const detail = document.createElement("dd");
  detail.className = "vendor-vault-evidence-value";
  detail.textContent = value;
  row.appendChild(detail);

  list.appendChild(row);
}

function appendTechnicalDetailRow(container, label, value) {
  const row = document.createElement("div");
  row.className = "vendor-vault-technical-row";

  const key = document.createElement("span");
  key.className = "vendor-vault-technical-key";
  key.textContent = label;
  row.appendChild(key);

  const text = document.createElement("span");
  text.className = "vendor-vault-technical-value";
  text.textContent = value;
  row.appendChild(text);

  container.appendChild(row);
}

function renderInventoryEntries(itemModels) {
  const list = qs("exposureInventoryList");
  if (!list) return;
  list.innerHTML = "";

  const sortedItems = itemModels
    .slice()
    .sort((a, b) => (
      (b.itemScoreMeta.itemScore - a.itemScoreMeta.itemScore) ||
      (b.count - a.count) ||
      a.categoryLabel.localeCompare(b.categoryLabel)
    ));

  for (const item of sortedItems) {
    const card = document.createElement("details");
    card.className = "vendor-vault-entry";
    card.setAttribute("role", "listitem");

    const summary = document.createElement("summary");
    summary.className = "vendor-vault-row-summary";

    const rowMain = document.createElement("div");
    rowMain.className = "vendor-vault-row-main";

    const head = document.createElement("div");
    head.className = "vendor-vault-entry-title-row";

    const title = document.createElement("span");
    title.className = "vendor-vault-entry-title";
    title.textContent = item.categoryLabel;
    head.appendChild(title);

    const statusPill = document.createElement("span");
    statusPill.className = `vendor-vault-status-pill vendor-vault-status-${item.statusLabel.toLowerCase()}`;
    statusPill.textContent = item.statusLabel;
    head.appendChild(statusPill);

    const scorePill = document.createElement("span");
    scorePill.className = `vendor-vault-score-pill vendor-vault-band-${String(item.itemScoreMeta.itemBand).toLowerCase()}`;
    scorePill.textContent = `Score ${item.itemScoreMeta.itemScore} (${item.itemScoreMeta.itemBand})`;
    head.appendChild(scorePill);

    rowMain.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "vendor-vault-entry-meta";
    meta.textContent = `Count: ${item.count} | Last seen: ${item.lastSeen}`;
    rowMain.appendChild(meta);

    summary.appendChild(rowMain);

    const chevron = document.createElement("span");
    chevron.className = "vendor-vault-row-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = ">";
    summary.appendChild(chevron);

    const panel = document.createElement("div");
    panel.className = "vendor-vault-entry-panel";
    panel.id = `vault-entry-panel-${item.index}`;
    summary.setAttribute("aria-controls", panel.id);

    const summaryLine = document.createElement("p");
    summaryLine.className = "vendor-vault-expanded-summary";
    summaryLine.textContent = getExpandedSummarySentence(item);
    panel.appendChild(summaryLine);

    const plainHeading = document.createElement("h4");
    plainHeading.className = "vendor-vault-expanded-heading";
    plainHeading.textContent = "In plain English";
    panel.appendChild(plainHeading);

    const plainBlock = document.createElement("div");
    plainBlock.className = "vendor-vault-plain-block";

    const whatLine = document.createElement("p");
    whatLine.className = "vendor-vault-plain-line";
    whatLine.innerHTML = `<span class="vendor-vault-plain-label">What it is:</span> ${item.plainEnglishWhat}`;
    plainBlock.appendChild(whatLine);

    const whyLine = document.createElement("p");
    whyLine.className = "vendor-vault-plain-line";
    whyLine.innerHTML = `<span class="vendor-vault-plain-label">Why it matters:</span> ${item.plainEnglishWhy}`;
    plainBlock.appendChild(whyLine);

    const caseLine = document.createElement("p");
    caseLine.className = "vendor-vault-plain-line";
    caseLine.innerHTML = `<span class="vendor-vault-plain-label">In this case:</span> ${item.inThisCase}`;
    plainBlock.appendChild(caseLine);

    if (item.uncertaintyNote) {
      const noteLine = document.createElement("p");
      noteLine.className = "vendor-vault-plain-line vendor-vault-plain-note";
      noteLine.innerHTML = `<span class="vendor-vault-plain-label">Note:</span> ${item.uncertaintyNote}`;
      plainBlock.appendChild(noteLine);
    }
    panel.appendChild(plainBlock);

    const layout = document.createElement("div");
    layout.className = "vendor-vault-expanded-layout";

    const left = document.createElement("div");
    left.className = "vendor-vault-expanded-main";

    const whyHeading = document.createElement("h4");
    whyHeading.className = "vendor-vault-expanded-heading";
    whyHeading.textContent = "Why it matters";
    left.appendChild(whyHeading);
    appendBulletList(left, item.privacyBullets.slice(0, 2), "vendor-vault-why-list");

    const actionsHeading = document.createElement("h4");
    actionsHeading.className = "vendor-vault-expanded-heading";
    actionsHeading.textContent = "What you can do";
    left.appendChild(actionsHeading);

    const actionWrap = document.createElement("div");
    actionWrap.className = "vendor-vault-guided-actions";
    renderGuidedActions(actionWrap, item.actions);
    left.appendChild(actionWrap);

    layout.appendChild(left);

    const right = document.createElement("aside");
    right.className = "vendor-vault-evidence-compact";

    const evidenceHeading = document.createElement("h4");
    evidenceHeading.className = "vendor-vault-evidence-heading";
    evidenceHeading.textContent = "Evidence";
    right.appendChild(evidenceHeading);

    const evidenceList = document.createElement("dl");
    evidenceList.className = "vendor-vault-evidence-kv";
    appendEvidenceField(evidenceList, "Observed", String(item.counts.observed));
    appendEvidenceField(evidenceList, "Attempted", String(item.counts.attempted));
    appendEvidenceField(evidenceList, "Confidence", item.confidenceText);
    appendEvidenceField(evidenceList, "First seen", item.firstSeen);
    appendEvidenceField(evidenceList, "Last seen", item.lastSeen);
    right.appendChild(evidenceList);

    layout.appendChild(right);
    panel.appendChild(layout);

    const technical = document.createElement("details");
    technical.className = "vendor-vault-technical-details";
    const technicalSummary = document.createElement("summary");
    technicalSummary.textContent = "Show technical details";
    technical.appendChild(technicalSummary);

    const technicalGrid = document.createElement("div");
    technicalGrid.className = "vendor-vault-technical-grid";
    appendTechnicalDetailRow(technicalGrid, "Item score", `${item.itemScoreMeta.itemScore} (${item.itemScoreMeta.itemBand})`);
    appendTechnicalDetailRow(technicalGrid, "Category weight", String(item.itemScoreMeta.weight));
    appendTechnicalDetailRow(technicalGrid, "Confidence factor", `${item.itemScoreMeta.confidencePct}%`);
    appendTechnicalDetailRow(
      technicalGrid,
      "Evidence factor",
      `${item.itemScoreMeta.evidenceFactor.toFixed(2)} (observed=1.0, attempted=0.3, unknown=0.6)`
    );
    technical.appendChild(technicalGrid);
    panel.appendChild(technical);

    card.appendChild(summary);
    card.appendChild(panel);
    list.appendChild(card);
  }
}

function hasValidVendorScopeForApiEvidence() {
  const vendorId = normalizeVendorId(vaultScopeState.vendor);
  return Boolean(vendorId && vendorId !== "unknown");
}

function getApiEvidenceSectionKey(groupKey) {
  const key = String(groupKey || "").trim();
  if (API_EVIDENCE_ALLOWED_WEBRTC_PATTERNS.has(key)) return API_EVIDENCE_SECTION_VENDOR;
  if (API_EVIDENCE_ALLOWED_CANVAS_PATTERNS.has(key) || key === "geolocation" || key === "clipboard.read") {
    return API_EVIDENCE_SECTION_CONTEXTUAL;
  }
  return "";
}

function filterApiEvidenceGroupsBySection(groups, sectionKey) {
  const safeGroups = Array.isArray(groups) ? groups : [];
  return safeGroups.filter((group) => getApiEvidenceSectionKey(group && group.key) === sectionKey);
}

function rewriteApiMeaningForVendor(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (/^This can be used/i.test(value)) {
    return value.replace(/^This can be used/i, "This activity may be used");
  }
  if (/^This can/i.test(value)) {
    return value.replace(/^This can/i, "This activity may");
  }
  if (/^This may/i.test(value)) {
    return value.replace(/^This may/i, "This activity may");
  }
  return value;
}

function rewriteApiMeaningForContextual(text) {
  const value = String(text || "").trim();
  if (!value) return "";
  if (/^This can be used/i.test(value)) {
    return value.replace(/^This can be used/i, "Observed on this page, this can be used");
  }
  if (/^This can/i.test(value)) {
    return value.replace(/^This can/i, "Observed on this page, this can");
  }
  if (/^This may/i.test(value)) {
    return value.replace(/^This may/i, "Observed on this page, this may");
  }
  return value;
}

function buildApiEvidenceNarrative(group) {
  const sectionKey = getApiEvidenceSectionKey(group && group.key);
  if (sectionKey === API_EVIDENCE_SECTION_VENDOR) {
    return {
      summaryLine: `This vendor used ${group.label}.`,
      meaningLine: `This vendor used ${group.label}. ${rewriteApiMeaningForVendor(group.whatThisMeans)}`,
    };
  }

  return {
    summaryLine: `This site used ${group.label}. Observed on this page, this is not directly linked to this vendor.`,
    meaningLine: `This site used ${group.label}. ${rewriteApiMeaningForContextual(group.whatThisMeans)} Not directly linked to this vendor.`,
  };
}

function getApiEvidenceGroupKey(event) {
  const enrichment = event && typeof event.enrichment === "object" ? event.enrichment : {};
  const data = event && typeof event.data === "object" ? event.data : {};
  const surfaceDetail = normalizeApiEvidenceToken(enrichment.surfaceDetail || data.surfaceDetail);
  const patternId = String(enrichment.patternId || "").trim();

  if (surfaceDetail === "canvas") {
    return API_EVIDENCE_ALLOWED_CANVAS_PATTERNS.has(patternId) ? patternId : "";
  }

  if (surfaceDetail === "webrtc") {
    return API_EVIDENCE_ALLOWED_WEBRTC_PATTERNS.has(patternId) ? patternId : "";
  }

  if (surfaceDetail === "geolocation") {
    return "geolocation";
  }

  if (surfaceDetail === "clipboard") {
    if (patternId === "api.clipboard.async_read" || patternId === "api.clipboard.async_read_text") {
      return "clipboard.read";
    }

    const method = normalizeApiEvidenceToken(data.method);
    const accessType = normalizeApiEvidenceToken(data.accessType);
    if (method === "read" || method === "readtext" || accessType === "read") {
      return "clipboard.read";
    }
  }

  return "";
}

function getApiEvidenceOutcomeKey(event) {
  const data = event && typeof event.data === "object" ? event.data : {};
  const enrichment = event && typeof event.enrichment === "object" ? event.enrichment : {};
  const gateOutcome = normalizeApiEvidenceToken(data.gateOutcome);
  if (gateOutcome === "blocked") return "blocked";
  if (gateOutcome === "trusted_allowed") return "trusted_allowed";
  if (gateOutcome === "observed" || gateOutcome === "warned") return "observed_warned";

  const mitigationStatus = normalizeApiEvidenceToken(enrichment.mitigationStatus);
  if (mitigationStatus === "blocked") return "blocked";
  if (mitigationStatus === "allowed") return "trusted_allowed";
  return "observed_warned";
}

function buildApiEvidenceActions(group, site, vendor) {
  const actions = [];
  const inspectAction = makeOpenInSiteInsightsAction(site, vendor);
  inspectAction.text = "Inspect in Site Insights";

  if (inspectAction.href) {
    actions.push(inspectAction);
  }

  actions.push({
    key: `review_api_controls_${group.key}`,
    text: "Review Browser API Controls",
    href: "/?view=api-signals",
    guidance: `Review the ${group.actionSurfaceLabel} control for this activity.`,
  });

  actions.push({
    key: `block_api_surface_${group.key}`,
    text: `Block ${group.actionSurfaceLabel} in Browser API Controls if this vendor does not need it.`,
  });

  if (group.counts.trusted_allowed > 0) {
    actions.push({
      key: `trusted_sites_${group.key}`,
      text: "Remove from trusted sites",
      href: "/?view=trusted-sites",
      guidance: "Trusted-site allowance can let this API run there.",
    });
  }

  if (!inspectAction.href) {
    actions.push({
      key: `inspect_site_insights_guidance_${group.key}`,
      text: inspectAction.guidance || "Open Site Insights from a specific site to inspect this vendor there.",
    });
  }

  const deduped = [];
  const seen = new Set();
  for (const action of actions) {
    const key = String(action && action.key ? action.key : action && action.text ? action.text : "");
    if (!key || seen.has(key)) continue;
    deduped.push(action);
    seen.add(key);
  }
  return deduped.slice(0, 4);
}

function buildVendorApiEvidenceGroups(events, site, vendor) {
  if (!hasValidVendorScopeForApiEvidence()) return [];

  const groups = new Map();
  const safeEvents = Array.isArray(events) ? events : [];
  for (const event of safeEvents) {
    const groupKey = getApiEvidenceGroupKey(event);
    const meta = API_EVIDENCE_GROUP_META[groupKey];
    if (!groupKey || !meta) continue;

    const ts = Number(event && event.ts) || 0;
    const outcomeKey = getApiEvidenceOutcomeKey(event);
    if (!groups.has(groupKey)) {
      groups.set(groupKey, {
        key: groupKey,
        label: meta.label,
        whatThisMeans: meta.whatThisMeans,
        actionSurfaceLabel: meta.actionSurfaceLabel,
        count: 0,
        lastSeenTs: 0,
        counts: {
          observed_warned: 0,
          blocked: 0,
          trusted_allowed: 0,
        },
      });
    }

    const group = groups.get(groupKey);
    group.count += 1;
    if (ts > group.lastSeenTs) group.lastSeenTs = ts;
    if (outcomeKey === "blocked" || outcomeKey === "trusted_allowed") {
      group.counts[outcomeKey] += 1;
    } else {
      group.counts.observed_warned += 1;
    }
  }

  return Array.from(groups.values())
    .map((group) => ({
      ...group,
      lastSeen: formatDateTime(group.lastSeenTs),
      limitation: "This signal does not prove data was received. It indicates capability or attempt based on observed activity.",
      actions: buildApiEvidenceActions(group, site, vendor),
    }))
    .sort((a, b) => (
      (b.lastSeenTs - a.lastSeenTs) ||
      (b.count - a.count) ||
      a.label.localeCompare(b.label)
    ));
}

function renderVendorApiEvidenceGroups(list, groups) {
  if (!list) return;
  list.innerHTML = "";

  const safeGroups = Array.isArray(groups) ? groups : [];
  for (const group of safeGroups) {
    const narrative = buildApiEvidenceNarrative(group);
    const card = document.createElement("details");
    card.className = "vendor-vault-entry vendor-vault-api-entry";
    card.setAttribute("role", "listitem");

    const summary = document.createElement("summary");
    summary.className = "vendor-vault-row-summary";

    const rowMain = document.createElement("div");
    rowMain.className = "vendor-vault-row-main";

    const head = document.createElement("div");
    head.className = "vendor-vault-entry-title-row";

    const title = document.createElement("span");
    title.className = "vendor-vault-entry-title";
    title.textContent = group.label;
    head.appendChild(title);

    const countPill = document.createElement("span");
    countPill.className = "vendor-vault-api-count-pill";
    countPill.textContent = `${group.count} event${group.count === 1 ? "" : "s"}`;
    head.appendChild(countPill);

    rowMain.appendChild(head);

    const meta = document.createElement("div");
    meta.className = "vendor-vault-entry-meta";
    meta.textContent = `Last seen: ${group.lastSeen} | Observed/warned: ${group.counts.observed_warned} | Blocked: ${group.counts.blocked} | Allowed on trusted site: ${group.counts.trusted_allowed}`;
    rowMain.appendChild(meta);

    summary.appendChild(rowMain);

    const chevron = document.createElement("span");
    chevron.className = "vendor-vault-row-chevron";
    chevron.setAttribute("aria-hidden", "true");
    chevron.textContent = ">";
    summary.appendChild(chevron);

    const panel = document.createElement("div");
    panel.className = "vendor-vault-entry-panel";

    const summaryLine = document.createElement("p");
    summaryLine.className = "vendor-vault-expanded-summary";
    summaryLine.textContent = narrative.summaryLine;
    panel.appendChild(summaryLine);

    const layout = document.createElement("div");
    layout.className = "vendor-vault-expanded-layout";

    const left = document.createElement("div");
    left.className = "vendor-vault-expanded-main";

    const meaningHeading = document.createElement("h4");
    meaningHeading.className = "vendor-vault-expanded-heading";
    meaningHeading.textContent = "What this means";
    left.appendChild(meaningHeading);

    const meaningBlock = document.createElement("div");
    meaningBlock.className = "vendor-vault-plain-block";

    const meaningLine = document.createElement("p");
    meaningLine.className = "vendor-vault-plain-line";
    meaningLine.textContent = narrative.meaningLine;
    meaningBlock.appendChild(meaningLine);
    left.appendChild(meaningBlock);

    const limitationHeading = document.createElement("h4");
    limitationHeading.className = "vendor-vault-expanded-heading";
    limitationHeading.textContent = "Important limitation";
    left.appendChild(limitationHeading);

    const limitationText = document.createElement("p");
    limitationText.className = "vendor-vault-plain-line vendor-vault-plain-note";
    limitationText.textContent = group.limitation;
    left.appendChild(limitationText);

    const actionsHeading = document.createElement("h4");
    actionsHeading.className = "vendor-vault-expanded-heading";
    actionsHeading.textContent = "What you can do";
    left.appendChild(actionsHeading);

    const actionWrap = document.createElement("div");
    actionWrap.className = "vendor-vault-guided-actions";
    renderGuidedActions(actionWrap, group.actions);
    left.appendChild(actionWrap);

    layout.appendChild(left);

    const right = document.createElement("aside");
    right.className = "vendor-vault-evidence-compact";

    const evidenceHeading = document.createElement("h4");
    evidenceHeading.className = "vendor-vault-evidence-heading";
    evidenceHeading.textContent = "What we observed";
    right.appendChild(evidenceHeading);

    const evidenceList = document.createElement("dl");
    evidenceList.className = "vendor-vault-evidence-kv";
    appendEvidenceField(evidenceList, "Observed", String(group.counts.observed_warned));
    appendEvidenceField(evidenceList, "Blocked", String(group.counts.blocked));
    appendEvidenceField(evidenceList, "Allowed on trusted site", String(group.counts.trusted_allowed));
    appendEvidenceField(evidenceList, "Count", String(group.count));
    appendEvidenceField(evidenceList, "Last seen", group.lastSeen);
    right.appendChild(evidenceList);

    layout.appendChild(right);
    panel.appendChild(layout);

    card.appendChild(summary);
    card.appendChild(panel);
    list.appendChild(card);
  }
}

function clearVendorApiEvidenceSubsection(sectionKey) {
  const section = sectionKey === API_EVIDENCE_SECTION_VENDOR
    ? qs("vendorApiEvidenceVendorSection")
    : qs("vendorApiEvidenceContextualSection");
  const list = sectionKey === API_EVIDENCE_SECTION_VENDOR
    ? qs("vendorApiEvidenceVendorList")
    : qs("vendorApiEvidenceContextualList");
  const empty = sectionKey === API_EVIDENCE_SECTION_VENDOR
    ? qs("vendorApiEvidenceVendorEmpty")
    : qs("vendorApiEvidenceContextualEmpty");

  if (list) {
    list.innerHTML = "";
    list.classList.add("hidden");
  }
  if (empty) {
    empty.textContent = "";
    empty.classList.add("hidden");
  }
  if (section) section.classList.add("hidden");
}

function renderVendorApiEvidenceSubsection(sectionKey, groups, opts = {}) {
  const section = sectionKey === API_EVIDENCE_SECTION_VENDOR
    ? qs("vendorApiEvidenceVendorSection")
    : qs("vendorApiEvidenceContextualSection");
  const list = sectionKey === API_EVIDENCE_SECTION_VENDOR
    ? qs("vendorApiEvidenceVendorList")
    : qs("vendorApiEvidenceContextualList");
  const empty = sectionKey === API_EVIDENCE_SECTION_VENDOR
    ? qs("vendorApiEvidenceVendorEmpty")
    : qs("vendorApiEvidenceContextualEmpty");
  if (!section || !list || !empty) return;

  const safeGroups = Array.isArray(groups) ? groups : [];
  section.classList.remove("hidden");
  renderVendorApiEvidenceGroups(list, safeGroups);
  list.classList.toggle("hidden", safeGroups.length === 0);
  empty.classList.toggle("hidden", safeGroups.length !== 0);
  empty.textContent = safeGroups.length === 0 ? String(opts.emptyText || "") : "";
}

function syncContextualApiEvidenceCopy() {
  const intro = qs("vendorApiEvidenceContextualIntro");
  const note = qs("vendorApiEvidenceContextualNote");
  const hasSiteScope = Boolean(getScopedSiteValue());
  if (!intro || !note) return hasSiteScope;

  if (hasSiteScope) {
    intro.textContent = "Other Browser API activity observed on this site (not directly attributable to this vendor)";
    note.textContent = "These signals are not directly attributable to this vendor, but may still contribute to tracking or profiling on this page.";
  } else {
    intro.textContent = "Other Browser API activity is shown only in This site view because it is not directly attributable to this vendor.";
    note.textContent = "These signals are page-level context rather than vendor responsibility.";
  }

  return hasSiteScope;
}

function renderVendorApiEvidenceSections(vendorGroups, contextualGroups) {
  const hasSiteScope = syncContextualApiEvidenceCopy();
  renderVendorApiEvidenceSubsection(API_EVIDENCE_SECTION_VENDOR, vendorGroups, {
    emptyText: "No vendor-attributed Browser API activity observed for this vendor.",
  });
  renderVendorApiEvidenceSubsection(API_EVIDENCE_SECTION_CONTEXTUAL, contextualGroups, {
    emptyText: hasSiteScope
      ? "No other Browser API activity observed on this site."
      : "Switch to This site to review page-level Browser API activity that is not directly attributable to this vendor.",
  });
}

function setVendorApiEvidenceState(state) {
  const loading = qs("vendorApiEvidenceLoadingState");
  const error = qs("vendorApiEvidenceErrorState");
  const empty = qs("vendorApiEvidenceEmptyState");
  const success = qs("vendorApiEvidenceSuccessState");
  if (!loading || !error || !empty || !success) return;

  loading.classList.toggle("hidden", state !== "loading");
  error.classList.toggle("hidden", state !== "error");
  empty.classList.toggle("hidden", state !== "empty");
  success.classList.toggle("hidden", state !== "success");
}

function clearVendorApiEvidenceContent() {
  clearVendorApiEvidenceSubsection(API_EVIDENCE_SECTION_VENDOR);
  clearVendorApiEvidenceSubsection(API_EVIDENCE_SECTION_CONTEXTUAL);
}

function setVendorApiEvidenceLoadingView() {
  setVendorApiEvidenceState("loading");
  clearVendorApiEvidenceContent();
}

async function loadVendorApiEvidence() {
  const requestId = ++latestApiEvidenceRequestId;
  setVendorApiEvidenceLoadingView();

  if (!hasValidVendorScopeForApiEvidence()) {
    setVendorApiEvidenceState("empty");
    return;
  }

  try {
    const contextualUrl = buildContextualApiEvidenceUrl();
    const [vendorPayload, contextualPayload] = await Promise.all([
      fetchJsonOrThrow(buildVendorApiEvidenceUrl(), "api_evidence"),
      contextualUrl ? fetchJsonOrThrow(contextualUrl, "api_evidence_contextual") : Promise.resolve([]),
    ]);
    if (requestId !== latestApiEvidenceRequestId) return;

    const scopedSite = getScopedSiteValue();
    const vendorGroups = filterApiEvidenceGroupsBySection(
      buildVendorApiEvidenceGroups(vendorPayload, scopedSite, vaultScopeState.vendor),
      API_EVIDENCE_SECTION_VENDOR
    );
    const contextualGroups = filterApiEvidenceGroupsBySection(
      buildVendorApiEvidenceGroups(contextualPayload, scopedSite, vaultScopeState.vendor),
      API_EVIDENCE_SECTION_CONTEXTUAL
    );

    if (!vendorGroups.length && !contextualGroups.length) {
      setVendorApiEvidenceState("empty");
      return;
    }

    renderVendorApiEvidenceSections(vendorGroups, contextualGroups);
    setVendorApiEvidenceState("success");
  } catch (err) {
    if (requestId !== latestApiEvidenceRequestId) return;
    console.error("Vendor Vault API evidence fetch failed:", err);
    setVendorApiEvidenceState("error");
  }
}

function setInventoryState(state) {
  const loading = qs("exposureLoadingState");
  const error = qs("exposureErrorState");
  const empty = qs("exposureEmptyState");
  const success = qs("exposureSuccessState");
  if (!loading || !error || !empty || !success) return;

  loading.classList.toggle("hidden", state !== "loading");
  error.classList.toggle("hidden", state !== "error");
  empty.classList.toggle("hidden", state !== "empty");
  success.classList.toggle("hidden", state !== "success");
}

function clearSuccessContent() {
  renderSummary(null, []);
  renderInventoryEntries([]);
}

function setLoadingView() {
  setInventoryState("loading");
  clearSuccessContent();
}

function buildVendorVaultSummaryUrl() {
  const vendor = String(vaultScopeState.vendor || "").trim();
  const site = String(vaultScopeState.site || "").trim();
  if (vaultScopeState.scope === SCOPE_ALL) {
    return `/api/vendor-vault-summary?vendor=${encodeURIComponent(vendor)}`;
  }
  return `/api/vendor-vault-summary?site=${encodeURIComponent(site)}&vendor=${encodeURIComponent(vendor)}`;
}

function buildExposureInventoryUrl() {
  const vendor = String(vaultScopeState.vendor || "").trim();
  const site = String(vaultScopeState.site || "").trim();
  if (vaultScopeState.scope === SCOPE_ALL) {
    return `/api/exposure-inventory?vendor=${encodeURIComponent(vendor)}`;
  }
  return `/api/exposure-inventory?site=${encodeURIComponent(site)}&vendor=${encodeURIComponent(vendor)}`;
}

function buildVendorApiEvidenceUrl() {
  const vendor = String(vaultScopeState.vendor || "").trim();
  const site = String(vaultScopeState.site || "").trim();
  const params = new URLSearchParams();
  params.set("vendor", vendor);
  params.set("limit", "20000");
  if (vaultScopeState.scope !== SCOPE_ALL && site) {
    params.set("site", site);
  }
  return `/api/events?${params.toString()}`;
}

function buildContextualApiEvidenceUrl() {
  const site = getScopedSiteValue();
  if (!site) return "";
  const params = new URLSearchParams();
  params.set("site", site);
  params.set("limit", "20000");
  return `/api/events?${params.toString()}`;
}

async function fetchJsonOrThrow(url, label) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${label}_request_failed_${response.status}`);
  return response.json();
}

function buildExportBaseFilename() {
  const safeVendor = sanitizeFilenamePart(vaultScopeState.vendor, "vendor");
  const sitePart = vaultScopeState.scope === SCOPE_ALL
    ? "all"
    : sanitizeFilenamePart(vaultScopeState.site, "site");
  const datePart = formatIsoDate(new Date());
  return `vendor-vault_${safeVendor}_${sitePart}_${datePart}`;
}

function buildExportFilename(ext) {
  return `${buildExportBaseFilename()}.${ext}`;
}

function buildExportBundle(exposureInventory, vaultSummary) {
  return {
    meta: {
      generated_at: new Date().toISOString(),
      scope: vaultScopeState.scope === SCOPE_ALL ? SCOPE_ALL : SCOPE_SITE,
      vendor: String(vaultScopeState.vendor || "").trim(),
      site: getScopedSiteValue(),
      app: EXPORT_APP_NAME,
    },
    data_source_note: EXPORT_DATA_SOURCE_NOTE,
    exposure_inventory: exposureInventory,
    vault_summary: vaultSummary,
  };
}

async function fetchExportPayloads() {
  return Promise.all([
    fetchJsonOrThrow(buildExposureInventoryUrl(), "inventory"),
    fetchJsonOrThrow(buildVendorVaultSummaryUrl(), "summary"),
  ]);
}

function bundleToCsv(bundle) {
  const rows = [
    ["section", "subsection", "index", "key", "label", "value", "count", "site", "vendor", "first_seen", "last_seen", "details"],
  ];

  const meta = bundle && bundle.meta ? bundle.meta : {};
  rows.push(["meta", "", "", "generated_at", "", meta.generated_at || "", "", "", "", "", "", ""]);
  rows.push(["meta", "", "", "scope", "", meta.scope || "", "", "", "", "", "", ""]);
  rows.push(["meta", "", "", "vendor", "", meta.vendor || "", "", "", "", "", "", ""]);
  rows.push(["meta", "", "", "site", "", meta.site == null ? "" : meta.site, "", "", "", "", "", ""]);
  rows.push(["meta", "", "", "app", "", meta.app || "", "", "", "", "", "", ""]);
  rows.push(["meta", "", "", "data_source_note", "", bundle.data_source_note || "", "", "", "", "", "", ""]);

  const exposureInventory = bundle && bundle.exposure_inventory ? bundle.exposure_inventory : {};
  const inventoryRows = Array.isArray(exposureInventory.rows) ? exposureInventory.rows : [];
  for (let i = 0; i < inventoryRows.length; i++) {
    const row = inventoryRows[i] || {};
    const details = {
      confidence: row.confidence,
      evidence_levels: row.evidence_levels,
      evidence_event_ids: row.evidence_event_ids,
      top_sites: row.top_sites,
    };
    rows.push([
      "exposure_inventory",
      "rows",
      i + 1,
      row.data_category || "",
      row.surface || "",
      row.example_key || "",
      row.count || 0,
      row.site || "",
      row.vendor_id || meta.vendor || "",
      formatExportTimestamp(row.first_seen),
      formatExportTimestamp(row.last_seen),
      JSON.stringify(details),
    ]);
  }

  const summary = bundle && bundle.vault_summary ? bundle.vault_summary : {};
  const activity = summary.activity_summary || {};
  rows.push(["vault_summary", "activity_summary", "", "total_events", "", activity.total_events || 0, "", "", "", "", "", ""]);
  rows.push(["vault_summary", "activity_summary", "", "observed_count", "", activity.observed_count || 0, "", "", "", "", "", ""]);
  rows.push(["vault_summary", "activity_summary", "", "blocked_count", "", activity.blocked_count || 0, "", "", "", "", "", ""]);
  rows.push(["vault_summary", "activity_summary", "", "first_seen", "", formatExportTimestamp(activity.first_seen), "", "", "", "", "", ""]);
  rows.push(["vault_summary", "activity_summary", "", "last_seen", "", formatExportTimestamp(activity.last_seen), "", "", "", "", "", ""]);

  const topDomains = Array.isArray(summary.domains_used && summary.domains_used.top_domains)
    ? summary.domains_used.top_domains
    : [];
  rows.push([
    "vault_summary",
    "domains_used",
    "",
    "domain_count_total",
    "",
    summary.domains_used && summary.domains_used.domain_count_total ? summary.domains_used.domain_count_total : 0,
    "",
    "",
    "",
    "",
    "",
    "",
  ]);
  for (let i = 0; i < topDomains.length; i++) {
    const row = topDomains[i] || {};
    rows.push([
      "vault_summary",
      "domains_used.top_domains",
      i + 1,
      row.domain || "",
      "",
      "",
      row.count || 0,
      "",
      "",
      "",
      "",
      "",
    ]);
  }

  const topKeys = Array.isArray(summary.observed_parameter_keys && summary.observed_parameter_keys.top_keys)
    ? summary.observed_parameter_keys.top_keys
    : [];
  rows.push([
    "vault_summary",
    "observed_parameter_keys",
    "",
    "key_count_total",
    "",
    summary.observed_parameter_keys && summary.observed_parameter_keys.key_count_total
      ? summary.observed_parameter_keys.key_count_total
      : 0,
    "",
    "",
    "",
    "",
    "",
    "",
  ]);
  for (let i = 0; i < topKeys.length; i++) {
    const row = topKeys[i] || {};
    rows.push([
      "vault_summary",
      "observed_parameter_keys.top_keys",
      i + 1,
      row.key || "",
      "",
      "",
      row.count || 0,
      "",
      "",
      "",
      "",
      "",
    ]);
  }

  const risk = summary.risk_summary || {};
  const dimensions = [
    ["mitigation_status_counts", risk.mitigation_status_counts],
    ["signal_type_counts", risk.signal_type_counts],
    ["privacy_status_counts", risk.privacy_status_counts],
  ];
  for (const [name, counts] of dimensions) {
    const safeCounts = counts && typeof counts === "object" ? counts : {};
    for (const [key, count] of Object.entries(safeCounts)) {
      rows.push([
        "vault_summary",
        `risk_summary.${name}`,
        "",
        key,
        "",
        "",
        count || 0,
        "",
        "",
        "",
        "",
        "",
      ]);
    }
  }

  return rows.map((row) => rowToCsv(row)).join("\r\n");
}

async function handleExportJsonClick() {
  try {
    setExportStatus("");
    setExportBusy("json");

    const [exposureInventory, vaultSummary] = await fetchExportPayloads();

    const bundle = buildExportBundle(exposureInventory, vaultSummary);
    downloadJsonFile(buildExportFilename("json"), bundle);
    setExportStatus("JSON export downloaded.");
  } catch (err) {
    console.error("Vendor Vault JSON export failed:", err);
    setExportStatus("JSON export failed. Try again.", true);
  } finally {
    setExportBusy("");
  }
}

async function handleExportCsvClick() {
  try {
    setExportStatus("");
    setExportBusy("csv");

    const [exposureInventory, vaultSummary] = await fetchExportPayloads();
    const bundle = buildExportBundle(exposureInventory, vaultSummary);
    const csv = bundleToCsv(bundle);
    downloadTextFile(buildExportFilename("csv"), csv, "text/csv;charset=utf-8");
    setExportStatus("CSV export downloaded.");
  } catch (err) {
    console.error("Vendor Vault CSV export failed:", err);
    setExportStatus("CSV export failed. Try again.", true);
  } finally {
    setExportBusy("");
  }
}

async function loadVendorVaultSummary() {
  const requestId = ++latestSummaryRequestId;
  setSummaryPanelsLoading();

  try {
    const response = await fetch(buildVendorVaultSummaryUrl());
    if (!response.ok) throw new Error(`summary_request_failed_${response.status}`);

    const payload = await response.json();
    if (requestId !== latestSummaryRequestId) return;
    renderVendorVaultSummaryPanels(payload);
  } catch (err) {
    if (requestId !== latestSummaryRequestId) return;
    console.error("Vendor Vault summary fetch failed:", err);
    setSummaryPanelsError();
  }
}

async function loadExposureInventory() {
  const requestId = ++latestExposureRequestId;
  setLoadingView();

  try {
    const response = await fetch(buildExposureInventoryUrl());
    if (!response.ok) throw new Error(`inventory_request_failed_${response.status}`);

    const payload = await response.json();
    if (requestId !== latestExposureRequestId) return;

    const rows = Array.isArray(payload && payload.rows) ? payload.rows : [];
    const scoreMeta = computeExposureScore(rows);
    const itemModels = rows.map((row, index) =>
      buildItemModel(row, index, vaultScopeState.site, vaultScopeState.vendor)
    );

    renderSummary(scoreMeta, itemModels);

    if (!rows.length) {
      setInventoryState("empty");
      return;
    }

    renderInventoryEntries(itemModels);
    setInventoryState("success");
  } catch (err) {
    if (requestId !== latestExposureRequestId) return;
    console.error("Vendor Vault inventory fetch failed:", err);
    setInventoryState("error");
  }
}

function bootVendorVault() {
  const params = new URLSearchParams(window.location.search);
  const site = String(params.get("site") || "").trim();
  const vendor = String(params.get("vendor") || "").trim();
  const initialScope = resolveInitialScope(site, params.get("scope"));

  if (!vendor) {
    showMissingState(site, params.get("scope"));
    return;
  }

  vaultScopeState.site = site;
  vaultScopeState.vendor = vendor;
  vaultScopeState.scope = initialScope;

  showVaultContent(site, vendor);
  renderScopeChipsAndControls();
  renderScopeCopy();

  const retryButton = qs("exposureRetryButton");
  if (retryButton) {
    retryButton.addEventListener("click", () => {
      loadExposureInventory();
      loadVendorVaultSummary();
      loadVendorApiEvidence();
    });
  }

  const apiEvidenceRetryButton = qs("vendorApiEvidenceRetryButton");
  if (apiEvidenceRetryButton) {
    apiEvidenceRetryButton.addEventListener("click", () => {
      loadVendorApiEvidence();
    });
  }

  const exportButton = qs("vaultExportButton");
  if (exportButton) {
    exportButton.addEventListener("click", () => {
      handleExportJsonClick();
    });
  }
  const exportCsvButton = qs("vaultExportCsvButton");
  if (exportCsvButton) {
    exportCsvButton.addEventListener("click", () => {
      handleExportCsvClick();
    });
  }

  const scopeSiteButton = qs("vaultScopeSiteButton");
  if (scopeSiteButton) {
    scopeSiteButton.addEventListener("click", () => {
      setScope(SCOPE_SITE, { updateUrl: true, reload: true });
    });
  }

  const scopeAllButton = qs("vaultScopeAllButton");
  if (scopeAllButton) {
    scopeAllButton.addEventListener("click", () => {
      setScope(SCOPE_ALL, { updateUrl: true, reload: true });
    });
  }

  loadExposureInventory();
  loadVendorVaultSummary();
  loadVendorApiEvidence();
}

window.addEventListener("load", bootVendorVault);
