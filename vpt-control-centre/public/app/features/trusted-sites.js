const viewState = {
  latestSites: [],
  latestPolicies: { latestTs: 0, items: [] },
  pendingSite: "",
  formPending: false,
  formTone: "",
  formMessage: "",
};

let formBound = false;
let listBound = false;
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

function summaryCardText(entries, siteIndex) {
  const now = Date.now();
  const recentWindowMs = 24 * 60 * 60 * 1000;
  const activeCount = entries.filter((entry) => {
    const summary = siteIndex.get(entry.site);
    return summary?.lastSeen && (now - Number(summary.lastSeen)) <= recentWindowMs;
  }).length;
  const lastChangedTs = latestTrustPolicyTs(viewState.latestPolicies);

  const countEl = document.getElementById("trustedSitesStatCount");
  const recentEl = document.getElementById("trustedSitesStatRecent");
  const lastChangedEl = document.getElementById("trustedSitesStatLastChanged");
  if (countEl) countEl.textContent = String(entries.length);
  if (recentEl) recentEl.textContent = String(activeCount);
  if (lastChangedEl) lastChangedEl.textContent = lastChangedTs ? formatFriendlyTime(lastChangedTs) : "-";
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

  if (input && !viewState.formPending && !currentValue && !snapshot.length && !viewState.formMessage) {
    status.textContent = "";
  }
}

function trustedSiteRowHtml(entry, summary) {
  const isPending = viewState.pendingSite === entry.site;
  const contextHtml = summary
    ? `
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
    `
    : `
      <div class="trusted-sites-context-empty">
        No recent site summary is available yet for this domain, but trust is still active in the current policy history.
      </div>
    `;

  return `
    <article class="trusted-sites-row">
      <div class="trusted-sites-row-main">
        <div class="trusted-sites-row-head">
          <div class="trusted-sites-domain">${escape(entry.site)}</div>
          <span class="trusted-sites-badge">Trusted</span>
        </div>
        ${contextHtml}
      </div>
      <div class="trusted-sites-row-actions">
        <a class="btn-secondary trusted-sites-view-link" href="/site.html?site=${encodeURIComponent(entry.site)}">View site</a>
        <button
          class="btn-secondary trusted-sites-untrust-btn"
          type="button"
          data-trusted-site-action="untrust"
          data-site="${escape(entry.site)}"
          ${isPending ? "disabled" : ""}
        >
          ${isPending ? "Removing..." : "Untrust site"}
        </button>
      </div>
    </article>
  `;
}

function recentSiteRowHtml(site, isTrusted) {
  const lastSeen = Number(site?.lastSeen) || 0;
  const totalEvents = Number(site?.totalEvents) || 0;
  const blockedCount = Number(site?.blockedCount) || 0;
  const normalizedSite = normalizeOptional(site?.site).toLowerCase();

  return `
    <article class="trusted-sites-row">
      <div class="trusted-sites-row-main">
        <div class="trusted-sites-row-head">
          <div class="trusted-sites-domain">${escape(site?.site || "unknown")}</div>
          ${isTrusted ? '<span class="trusted-sites-badge">Trusted</span>' : '<span class="trusted-sites-badge trusted-sites-badge-muted">Observed</span>'}
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
        <a class="btn-secondary trusted-sites-view-link" href="/site.html?site=${encodeURIComponent(site?.site || "")}">View site</a>
        ${isTrusted
          ? `<button
              class="btn-secondary trusted-sites-untrust-btn"
              type="button"
              data-trusted-site-action="untrust"
              data-site="${escape(normalizedSite)}"
              ${viewState.pendingSite === normalizedSite ? "disabled" : ""}
            >
              ${viewState.pendingSite === normalizedSite ? "Removing..." : "Untrust site"}
            </button>`
          : `<button
              class="btn-secondary trusted-sites-trust-btn"
              type="button"
              data-trusted-site-action="trust"
              data-site="${escape(normalizedSite)}"
              ${viewState.formPending ? "disabled" : ""}
            >
              ${viewState.formPending ? "Trusting..." : "Trust site"}
            </button>`
        }
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
    meta.textContent = "No trusted sites are currently configured.";
    empty.classList.remove("hidden");
    empty.innerHTML = `
      <div class="trusted-sites-empty-title">No trusted sites yet</div>
      <p class="trusted-sites-empty-copy">
        Trust a site here, or from an existing contextual action, to make it appear in this primary management page.
      </p>
    `;
    list.innerHTML = "";
    return;
  }

  const withContext = snapshot.filter((entry) => siteIndex.has(entry.site)).length;
  meta.textContent = `${snapshot.length} trusted site${snapshot.length === 1 ? "" : "s"} configured. ${withContext} currently have site summary context available.`;
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

  const rows = Array.from(siteIndex.values())
    .slice()
    .sort((a, b) => (Number(b?.lastSeen) || 0) - (Number(a?.lastSeen) || 0))
    .slice(0, 6);

  if (!rows.length) {
    meta.textContent = "No recent VPT-observed site activity is available yet.";
    empty.classList.remove("hidden");
    empty.innerHTML = `
      <div class="trusted-sites-empty-title">No recent site activity yet</div>
      <p class="trusted-sites-empty-copy">
        This area is populated from captured VPT events, not raw browser history. A site appears here only after VPT records activity for it.
      </p>
    `;
    list.innerHTML = "";
    return;
  }

  meta.textContent = `Showing ${rows.length} recently observed site${rows.length === 1 ? "" : "s"} from captured VPT activity.`;
  empty.classList.add("hidden");
  const trustedSet = new Set(snapshot.map((entry) => entry.site));
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
  summaryCardText(snapshot, siteIndex);
  renderForm(snapshot);
  renderTrustedSitesList(snapshot, siteIndex);
  renderRecentSites(snapshot, siteIndex);
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

function initTrustedSitesFeature({ getLatestSites, getLatestPolicies, onPoliciesMutated } = {}) {
  getLatestSitesCb = typeof getLatestSites === "function" ? getLatestSites : null;
  getLatestPoliciesCb = typeof getLatestPolicies === "function" ? getLatestPolicies : null;
  onPoliciesMutatedCb = typeof onPoliciesMutated === "function" ? onPoliciesMutated : null;
  bindForm();
  bindList();
}

export { initTrustedSitesFeature, renderTrustedSitesView };

if (typeof window !== "undefined") {
  window.VPT = window.VPT || {};
  window.VPT.features = window.VPT.features || {};
  window.VPT.features.trustedSites = { initTrustedSitesFeature, renderTrustedSitesView };
}
