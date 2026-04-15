const viewState = {
  subview: "trusted",
  latestSites: [],
  latestPolicies: { latestTs: 0, items: [] },
  pendingSite: "",
  formPending: false,
  formTone: "",
  formMessage: "",
};

let formBound = false;
let listBound = false;
let subviewBound = false;
let getLatestSitesCb = null;
let getLatestPoliciesCb = null;
let onPoliciesMutatedCb = null;

function utils() {
  return window.VPT?.utils || {};
}

function escape(value) {
  const text = String(value ?? "");
  return utils().escapeHtml ? utils().escapeHtml(text) : text;
}

function normalizeOptional(value) {
  return String(value || "").trim();
}

function normalizePolicyState(policiesResponse) {
  const trusted = new Map();
  const items = Array.isArray(policiesResponse?.items) ? policiesResponse.items : [];

  items.forEach((item) => {
    const op = normalizeOptional(item?.op);
    const payload = item?.payload && typeof item.payload === "object" ? item.payload : {};
    const site = normalizeOptional(payload.site).toLowerCase();
    if (!site) return;

    if (op === "trust_site") {
      trusted.set(site, {
        site,
        trusted: true,
        lastChangedTs: Number(item?.ts) || 0,
      });
    } else if (op === "untrust_site") {
      trusted.delete(site);
    }
  });

  return Array.from(trusted.values());
}

function buildSiteSummaryIndex(sites) {
  const index = new Map();
  (Array.isArray(sites) ? sites : []).forEach((site) => {
    const key = normalizeOptional(site?.site).toLowerCase();
    if (!key) return;
    index.set(key, site);
  });
  return index;
}

function formatFriendlyTime(ts) {
  const { friendlyTime } = utils();
  if (!ts) return "-";
  if (typeof friendlyTime === "function") return friendlyTime(ts);
  return new Date(ts).toLocaleString();
}

function isIpAddress(hostname) {
  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) return false;
  return hostname.split(".").every((part) => {
    const value = Number(part);
    return Number.isInteger(value) && value >= 0 && value <= 255;
  });
}

function isValidDomainLabel(label) {
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(label);
}

function normalizeTrustedSiteInput(rawValue) {
  const raw = normalizeOptional(rawValue).toLowerCase();
  if (!raw) {
    return { ok: false, message: "Enter a domain such as example.com." };
  }
  if (/\s/.test(raw)) {
    return { ok: false, message: "Use a single domain or URL with no spaces." };
  }

  let hostname = raw;
  try {
    const candidate = raw.includes("://") ? new URL(raw) : new URL(`https://${raw}`);
    hostname = String(candidate.hostname || "").toLowerCase();
  } catch {
    return { ok: false, message: "Enter a valid domain such as example.com." };
  }

  if (!hostname) {
    return { ok: false, message: "Enter a valid domain such as example.com." };
  }

  if (hostname === "localhost" || isIpAddress(hostname)) {
    return { ok: true, site: hostname };
  }

  const parts = hostname.split(".");
  if (parts.length < 2 || !parts.every(isValidDomainLabel)) {
    return { ok: false, message: "Enter a valid domain such as example.com." };
  }

  return { ok: true, site: hostname };
}

function sortedTrustedSites(entries, siteIndex) {
  return entries
    .slice()
    .sort((a, b) => {
      const aSummary = siteIndex.get(a.site);
      const bSummary = siteIndex.get(b.site);
      const aLastSeen = Number(aSummary?.lastSeen) || 0;
      const bLastSeen = Number(bSummary?.lastSeen) || 0;
      if (bLastSeen !== aLastSeen) return bLastSeen - aLastSeen;
      if (b.lastChangedTs !== a.lastChangedTs) return b.lastChangedTs - a.lastChangedTs;
      return a.site.localeCompare(b.site);
    });
}

function sortedObservedSites(siteIndex) {
  return Array.from(siteIndex.values())
    .slice()
    .sort((a, b) => {
      const diff = (Number(b?.lastSeen) || 0) - (Number(a?.lastSeen) || 0);
      if (diff !== 0) return diff;
      return normalizeOptional(a?.site).localeCompare(normalizeOptional(b?.site));
    });
}

function mergePoliciesIntoViewState(created) {
  const createdItems = Array.isArray(created) ? created.filter(Boolean) : [created].filter(Boolean);
  if (!createdItems.length) return;

  const currentItems = Array.isArray(viewState.latestPolicies.items) ? viewState.latestPolicies.items.slice() : [];
  viewState.latestPolicies = {
    latestTs: Math.max(
      Number(viewState.latestPolicies.latestTs) || 0,
      ...createdItems.map((item) => Number(item?.ts) || 0)
    ),
    items: currentItems.concat(createdItems),
  };
}

function statusToneClass(tone) {
  return tone ? ` ${escape(tone)}` : "";
}

function latestTrustPolicyTs(policiesResponse) {
  const items = Array.isArray(policiesResponse?.items) ? policiesResponse.items : [];
  return items.reduce((max, item) => {
    const op = normalizeOptional(item?.op);
    if (op !== "trust_site" && op !== "untrust_site") return max;
    return Math.max(max, Number(item?.ts) || 0);
  }, 0);
}

function syncSubview() {
  const trustedPanel = document.getElementById("trustedSitesTrustedPanel");
  const observedPanel = document.getElementById("trustedSitesObservedPanel");
  const buttons = document.querySelectorAll("[data-trusted-sites-subview]");

  trustedPanel?.classList.toggle("hidden", viewState.subview !== "trusted");
  observedPanel?.classList.toggle("hidden", viewState.subview !== "observed");

  buttons.forEach((button) => {
    const active = button.dataset.trustedSitesSubview === viewState.subview;
    button.classList.toggle("active", active);
    button.dataset.active = active ? "true" : "false";
    button.setAttribute("aria-selected", active ? "true" : "false");
    button.tabIndex = active ? 0 : -1;
  });
}

function renderStatusStrip(snapshot, siteIndex) {
  const trustedCountEl = document.getElementById("trustedSitesStatCount");
  const observedCountEl = document.getElementById("trustedSitesStatObserved");
  const lastChangedEl = document.getElementById("trustedSitesStatLastChanged");
  const trustedTabCountEl = document.getElementById("trustedSitesSubviewTrustedCount");
  const observedTabCountEl = document.getElementById("trustedSitesSubviewObservedCount");
  const lastChangedTs = latestTrustPolicyTs(viewState.latestPolicies);
  const trustedCount = snapshot.length;
  const observedCount = siteIndex.size;

  if (trustedCountEl) trustedCountEl.textContent = String(trustedCount);
  if (observedCountEl) observedCountEl.textContent = String(observedCount);
  if (lastChangedEl) lastChangedEl.textContent = lastChangedTs ? formatFriendlyTime(lastChangedTs) : "-";
  if (trustedTabCountEl) trustedTabCountEl.textContent = String(trustedCount);
  if (observedTabCountEl) observedTabCountEl.textContent = String(observedCount);
}

function renderForm(snapshot) {
  const input = document.getElementById("trustedSitesInput");
  const button = document.getElementById("trustedSitesSubmitBtn");
  const status = document.getElementById("trustedSitesFormStatus");
  const currentValue = normalizeOptional(input?.value);

  if (input) input.disabled = viewState.formPending;
  if (button) button.disabled = viewState.formPending;

  if (button) {
    button.textContent = viewState.formPending ? "Trusting..." : "Trust site";
  }

  if (status) {
    status.className = `trusted-sites-form-status${statusToneClass(viewState.formTone)}`;
    status.textContent = viewState.formMessage;
  }

  if (input && !viewState.formPending && !currentValue && !snapshot.length && !viewState.formMessage && status) {
    status.textContent = "";
  }
}

function buildContextHtml(summary) {
  if (!summary) {
    return `
      <div class="trusted-sites-context-empty">
        VPT has not recently observed privacy-related activity for this domain, but trust remains active in the current policy history.
      </div>
    `;
  }

  return `
    <div class="trusted-sites-context-grid">
      <div class="trusted-sites-context-item">
        <span class="trusted-sites-context-label">Last seen</span>
        <span class="trusted-sites-context-value">${escape(formatFriendlyTime(Number(summary.lastSeen) || 0))}</span>
      </div>
      <div class="trusted-sites-context-item">
        <span class="trusted-sites-context-label">Events</span>
        <span class="trusted-sites-context-value">${escape(String(Number(summary.totalEvents) || 0))}</span>
      </div>
      <div class="trusted-sites-context-item">
        <span class="trusted-sites-context-label">Blocked</span>
        <span class="trusted-sites-context-value">${escape(String(Number(summary.blockedCount) || 0))}</span>
      </div>
    </div>
  `;
}

function trustedSiteRowHtml(entry, summary) {
  const isPending = viewState.pendingSite === entry.site;
  const badgeHtml = summary
    ? '<div class="trusted-sites-badge-group"><span class="trusted-sites-badge trusted-sites-badge-observed">Also observed</span></div>'
    : "";

  return `
    <article class="trusted-sites-row trusted-sites-row-trusted">
      <div class="trusted-sites-row-main">
        <div class="trusted-sites-row-head">
          <div class="trusted-sites-domain">${escape(entry.site)}</div>
          ${badgeHtml}
        </div>
        ${buildContextHtml(summary)}
      </div>
      <div class="trusted-sites-row-actions">
        <button
          class="btn-secondary trusted-sites-untrust-btn trusted-sites-row-action-primary"
          type="button"
          data-trusted-site-action="untrust"
          data-site="${escape(entry.site)}"
          ${isPending ? "disabled" : ""}
        >
          ${isPending ? "Removing..." : "Untrust site"}
        </button>
        <a class="btn-secondary trusted-sites-view-link" href="/site.html?site=${encodeURIComponent(entry.site)}">View site</a>
      </div>
    </article>
  `;
}

function recentSiteRowHtml(site, isTrusted) {
  const lastSeen = Number(site?.lastSeen) || 0;
  const totalEvents = Number(site?.totalEvents) || 0;
  const blockedCount = Number(site?.blockedCount) || 0;
  const normalizedSite = normalizeOptional(site?.site).toLowerCase();
  const pendingUntrust = viewState.pendingSite === normalizedSite;
  const badgeHtml = isTrusted
    ? '<div class="trusted-sites-badge-group"><span class="trusted-sites-badge trusted-sites-badge-trusted">Also trusted</span></div>'
    : "";

  return `
    <article class="trusted-sites-row trusted-sites-row-observed">
      <div class="trusted-sites-row-main">
        <div class="trusted-sites-row-head">
          <div class="trusted-sites-domain">${escape(site?.site || "unknown")}</div>
          ${badgeHtml}
        </div>
        <div class="trusted-sites-context-grid">
          <div class="trusted-sites-context-item">
            <span class="trusted-sites-context-label">Last seen</span>
            <span class="trusted-sites-context-value">${escape(formatFriendlyTime(lastSeen))}</span>
          </div>
          <div class="trusted-sites-context-item">
            <span class="trusted-sites-context-label">Events</span>
            <span class="trusted-sites-context-value">${escape(String(totalEvents))}</span>
          </div>
          <div class="trusted-sites-context-item">
            <span class="trusted-sites-context-label">Blocked</span>
            <span class="trusted-sites-context-value">${escape(String(blockedCount))}</span>
          </div>
        </div>
      </div>
      <div class="trusted-sites-row-actions">
        ${isTrusted
          ? `<button
              class="btn-secondary trusted-sites-untrust-btn trusted-sites-row-action-primary"
              type="button"
              data-trusted-site-action="untrust"
              data-site="${escape(normalizedSite)}"
              ${pendingUntrust ? "disabled" : ""}
            >
              ${pendingUntrust ? "Removing..." : "Untrust site"}
            </button>`
          : `<button
              class="btn-secondary trusted-sites-trust-btn trusted-sites-row-action-primary"
              type="button"
              data-trusted-site-action="trust"
              data-site="${escape(normalizedSite)}"
              ${viewState.formPending ? "disabled" : ""}
            >
              ${viewState.formPending ? "Trusting..." : "Trust site"}
            </button>`
        }
        <a class="btn-secondary trusted-sites-view-link" href="/site.html?site=${encodeURIComponent(site?.site || "")}">View site</a>
      </div>
    </article>
  `;
}

function renderTrustedSitesList(snapshot, siteIndex) {
  const meta = document.getElementById("trustedSitesListMeta");
  const empty = document.getElementById("trustedSitesEmptyState");
  const list = document.getElementById("trustedSitesList");
  if (!meta || !empty || !list) return;

  if (!snapshot.length) {
    meta.textContent = "No trusted domains are configured yet.";
    empty.classList.remove("hidden");
    empty.innerHTML = `
      <div class="trusted-sites-empty-title">No trusted sites yet</div>
      <p class="trusted-sites-empty-copy">
        Trust a domain manually to add it here. You do not need to wait for VPT to observe a privacy event first.
      </p>
    `;
    list.innerHTML = "";
    return;
  }

  const withContext = snapshot.filter((entry) => siteIndex.has(entry.site)).length;
  meta.textContent = `${snapshot.length} trusted site${snapshot.length === 1 ? "" : "s"} configured. ${withContext} ${withContext === 1 ? "also has" : "also have"} recent observed context available.`;
  empty.classList.add("hidden");
  list.innerHTML = sortedTrustedSites(snapshot, siteIndex)
    .map((entry) => trustedSiteRowHtml(entry, siteIndex.get(entry.site)))
    .join("");
}

function renderRecentSites(snapshot, siteIndex) {
  const meta = document.getElementById("trustedSitesRecentMeta");
  const empty = document.getElementById("trustedSitesRecentEmptyState");
  const list = document.getElementById("trustedSitesRecentList");
  if (!meta || !empty || !list) return;

  const rows = sortedObservedSites(siteIndex);

  if (!rows.length) {
    meta.textContent = "No recently observed privacy-event sites are available yet.";
    empty.classList.remove("hidden");
    empty.innerHTML = `
      <div class="trusted-sites-empty-title">No observed privacy-event sites yet</div>
      <p class="trusted-sites-empty-copy">
        This list is populated only from captured VPT privacy events, not raw browser history. You can still trust any domain manually above.
      </p>
    `;
    list.innerHTML = "";
    return;
  }

  const trustedSet = new Set(snapshot.map((entry) => entry.site));
  const trustedOverlap = rows.filter((site) => trustedSet.has(normalizeOptional(site?.site).toLowerCase())).length;
  meta.textContent = `Showing ${rows.length} recently observed site${rows.length === 1 ? "" : "s"} from captured VPT privacy events only. ${trustedOverlap} ${trustedOverlap === 1 ? "is" : "are"} already trusted.`;
  empty.classList.add("hidden");
  list.innerHTML = rows
    .map((site) => recentSiteRowHtml(site, trustedSet.has(normalizeOptional(site?.site).toLowerCase())))
    .join("");
}

function renderTrustedSitesView(sites, options = {}) {
  viewState.latestSites = Array.isArray(sites) ? sites.slice() : [];
  if (Object.prototype.hasOwnProperty.call(options, "policies")) {
    viewState.latestPolicies = options.policies && typeof options.policies === "object"
      ? {
        latestTs: Number(options.policies.latestTs) || 0,
        items: Array.isArray(options.policies.items) ? options.policies.items.slice() : [],
      }
      : { latestTs: 0, items: [] };
  }

  const snapshot = normalizePolicyState(viewState.latestPolicies);
  const siteIndex = buildSiteSummaryIndex(viewState.latestSites);
  renderStatusStrip(snapshot, siteIndex);
  renderForm(snapshot);
  renderTrustedSitesList(snapshot, siteIndex);
  renderRecentSites(snapshot, siteIndex);
  syncSubview();
}

async function submitTrustSite(site) {
  const api = window.VPT?.api;
  if (!api?.postPolicy) {
    throw new Error("Policy API not available in dashboard context");
  }
  return api.postPolicy("trust_site", { site });
}

async function submitUntrustSite(site) {
  const api = window.VPT?.api;
  if (!api?.postPolicy) {
    throw new Error("Policy API not available in dashboard context");
  }
  return api.postPolicy("untrust_site", { site });
}

function rerenderFromCallbacks() {
  const sites = typeof getLatestSitesCb === "function" ? getLatestSitesCb() || [] : viewState.latestSites;
  const policies = typeof getLatestPoliciesCb === "function" ? getLatestPoliciesCb() || viewState.latestPolicies : viewState.latestPolicies;
  renderTrustedSitesView(sites, { policies });
}

async function handleAddSubmit(event) {
  event.preventDefault();
  const input = document.getElementById("trustedSitesInput");
  const snapshot = normalizePolicyState(viewState.latestPolicies);
  const parsed = normalizeTrustedSiteInput(input?.value);

  if (!parsed.ok) {
    viewState.formTone = "error";
    viewState.formMessage = parsed.message;
    rerenderFromCallbacks();
    return;
  }

  if (snapshot.some((entry) => entry.site === parsed.site)) {
    viewState.formTone = "success";
    viewState.formMessage = `${parsed.site} is already trusted.`;
    rerenderFromCallbacks();
    return;
  }

  viewState.formPending = true;
  viewState.formTone = "pending";
  viewState.formMessage = `Trusting ${parsed.site} through the existing policy flow...`;
  rerenderFromCallbacks();

  try {
    const created = await submitTrustSite(parsed.site);
    mergePoliciesIntoViewState(created);
    onPoliciesMutatedCb?.(created);
    if (input) input.value = "";
    viewState.formTone = "success";
    viewState.formMessage = `${parsed.site} is now trusted.`;
  } catch (error) {
    viewState.formTone = "error";
    viewState.formMessage = `Could not trust ${parsed.site}. ${error?.message || "Try again."}`;
  } finally {
    viewState.formPending = false;
    rerenderFromCallbacks();
  }
}

async function handleUntrust(site) {
  const normalizedSite = normalizeOptional(site).toLowerCase();
  if (!normalizedSite) return;

  viewState.pendingSite = normalizedSite;
  viewState.formTone = "pending";
  viewState.formMessage = `Removing trust for ${normalizedSite}...`;
  rerenderFromCallbacks();

  try {
    const created = await submitUntrustSite(normalizedSite);
    mergePoliciesIntoViewState(created);
    onPoliciesMutatedCb?.(created);
    viewState.formTone = "success";
    viewState.formMessage = `${normalizedSite} is no longer trusted.`;
  } catch (error) {
    viewState.formTone = "error";
    viewState.formMessage = `Could not remove trust for ${normalizedSite}. ${error?.message || "Try again."}`;
  } finally {
    viewState.pendingSite = "";
    rerenderFromCallbacks();
  }
}

async function handleTrust(site) {
  const normalizedSite = normalizeOptional(site).toLowerCase();
  if (!normalizedSite || viewState.formPending) return;

  viewState.formPending = true;
  viewState.formTone = "pending";
  viewState.formMessage = `Trusting ${normalizedSite} through the existing policy flow...`;
  rerenderFromCallbacks();

  try {
    const created = await submitTrustSite(normalizedSite);
    mergePoliciesIntoViewState(created);
    onPoliciesMutatedCb?.(created);
    viewState.formTone = "success";
    viewState.formMessage = `${normalizedSite} is now trusted.`;
  } catch (error) {
    viewState.formTone = "error";
    viewState.formMessage = `Could not trust ${normalizedSite}. ${error?.message || "Try again."}`;
  } finally {
    viewState.formPending = false;
    rerenderFromCallbacks();
  }
}

function bindForm() {
  if (formBound) return;
  document.getElementById("trustedSitesAddForm")?.addEventListener("submit", (event) => {
    void handleAddSubmit(event);
  });
  formBound = true;
}

function bindList() {
  if (listBound) return;
  document.getElementById("trustedSitesList")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const button = target.closest("[data-trusted-site-action='untrust']");
    if (!button) return;
    const site = normalizeOptional(button.getAttribute("data-site")).toLowerCase();
    if (!site || viewState.pendingSite) return;
    void handleUntrust(site);
  });

  document.getElementById("trustedSitesRecentList")?.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const trustButton = target.closest("[data-trusted-site-action='trust']");
    if (trustButton) {
      const site = normalizeOptional(trustButton.getAttribute("data-site")).toLowerCase();
      if (!site) return;
      void handleTrust(site);
      return;
    }

    const untrustButton = target.closest("[data-trusted-site-action='untrust']");
    if (untrustButton) {
      const site = normalizeOptional(untrustButton.getAttribute("data-site")).toLowerCase();
      if (!site || viewState.pendingSite) return;
      void handleUntrust(site);
    }
  });

  listBound = true;
}

function bindSubviewControls() {
  if (subviewBound) return;
  document.querySelectorAll("[data-trusted-sites-subview]").forEach((button) => {
    button.addEventListener("click", () => {
      viewState.subview = button.dataset.trustedSitesSubview === "observed" ? "observed" : "trusted";
      syncSubview();
    });
  });
  subviewBound = true;
}

function initTrustedSitesFeature({ getLatestSites, getLatestPolicies, onPoliciesMutated } = {}) {
  getLatestSitesCb = typeof getLatestSites === "function" ? getLatestSites : null;
  getLatestPoliciesCb = typeof getLatestPolicies === "function" ? getLatestPolicies : null;
  onPoliciesMutatedCb = typeof onPoliciesMutated === "function" ? onPoliciesMutated : null;
  bindForm();
  bindList();
  bindSubviewControls();
}

export { initTrustedSitesFeature, renderTrustedSitesView };

if (typeof window !== "undefined") {
  window.VPT = window.VPT || {};
  window.VPT.features = window.VPT.features || {};
  window.VPT.features.trustedSites = { initTrustedSitesFeature, renderTrustedSitesView };
}
