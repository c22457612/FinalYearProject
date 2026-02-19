const FILTERS = [
  "google-analytics.com",
  "doubleclick.net",
  "googletagmanager.com",
  "googleapis.com",
  "facebook.com/tr",
  "matomo.org"
];

//State
const BACKEND_URL = "http://127.0.0.1:4141";

let lastPolicyTs = 0;
let customFilters = []; // extra domains to block via policies

let currentMode = "moderate";
let blockedFirst = 0;
let blockedThird = 0;
let notifyEnabled = false;
const lastNotifyByDomain = new Map(); // throttle toasts
let promptOnNewSites = true;   // default ON 
let trustedDomains = [];       // base domains user trusts
let enterOnce = null; // { siteBase, ts }

let previewReq = null;             // { siteBase, dest, ts }
let previewActive = null;          // { siteBase, tabId, timerId }
const previewObserved = new Map(); // reqBase -> { blocked: boolean, allowed: boolean }
const locationCache = {};          // tabId -> last main-frame URL

let lastCommandId = 0;


// ---- Privacy event logger ----
async function logEvent(kind, data = {}, tabId = null) {
  try {
    const ts = Date.now();

    let topLevelUrl = null;
    let site = null;

    // Use locationCache if we know this tab's top-level URL
    if (
      tabId !== null &&
      typeof tabId !== "undefined" &&
      typeof locationCache === "object" &&
      Object.prototype.hasOwnProperty.call(locationCache, tabId)
    ) {
      topLevelUrl = locationCache[tabId];
      try {
        const host = new URL(topLevelUrl).hostname;
        site = base(host); 
      } catch (e) {
        // ignore parse errors
      }
    }

    // Fallback: if caller passed a siteBase in data, use that
    if (!site && data.siteBase) {
      site = data.siteBase;
    }

    const event = {
      id: `evt-${ts}-${Math.random().toString(16).slice(2, 8)}`,
      ts,
      site: site || null,
      topLevelUrl: topLevelUrl || null,
      tabId,
      mode: currentMode || "moderate",
      source: "extension",
      kind,
      data
    };

    const result = await chrome.storage.local.get("events");
    const events = Array.isArray(result.events) ? result.events : [];
    events.push(event);

    const MAX = 500;
    if (events.length > MAX) {
      events.splice(0, events.length - MAX);
    }

    await chrome.storage.local.set({ events });
    // Fire-and-forget: send to local backend if it's running
    try {
      fetch(`${BACKEND_URL}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event)
      }).catch(() => {});
    } catch (e2) {
      // backend might not be running; ignore
    }
  } catch (e) {
    console.error("logEvent failed", kind, data, tabId, e);
  }
}


//Utils
function setBadge() {
  const total = blockedFirst + blockedThird;
  chrome.action.setBadgeText({ text: total ? String(Math.min(total, 999)) : "" });
}

function base(host) {
  if (!host) return "";
  const parts = host.split(".").filter(Boolean);
  return parts.length <= 2 ? parts.join(".") : parts.slice(-2).join(".");
}
function hostFromUrl(u) { try { return new URL(u).hostname; } catch { return ""; } }
function hostFromOrigin(o) { try { return new URL(o).hostname; } catch { return ""; } }

async function getCookieSummaryForUrl(url) {
  if (!url || !/^https?:/i.test(url)) {
    return { count: 0, site: null };
  }
  const cookies = await chrome.cookies.getAll({ url });
  const host = hostFromUrl(url);
  const site = base(host);
  return { count: cookies.length, site };
}

async function buildCookieSnapshotForUrl(url) {
  if (!url || !/^https?:/i.test(url)) {
    return null;
  }

  const cookies = await chrome.cookies.getAll({ url });
  const host = hostFromUrl(url);
  const siteBase = base(host);

  const items = cookies.map(c => {
    const cookieHost = (c.domain || "").replace(/^\./, "");
    const cookieBase = base(cookieHost);
    const isThird = cookieBase && siteBase && cookieBase !== siteBase;

    return {
      name: c.name,
      domain: c.domain,
      path: c.path,
      secure: c.secure,
      httpOnly: c.httpOnly,
      sameSite: c.sameSite || null,
      session: c.session,
      expiry: c.expirationDate || null,
      hostOnly: c.hostOnly,
      isThirdParty: !!isThird
    };
  });

  const thirdPartyCount = items.filter(i => i.isThirdParty).length;

  return {
    url,
    siteBase,
    count: cookies.length,
    thirdPartyCount,
    cookies: items
  };
}

async function clearCookiesForUrl(url) {
  if (!url || !/^https?:/i.test(url)) {
    return { cleared: 0, total: 0 };
  }

  const cookies = await chrome.cookies.getAll({ url });
  const total = cookies.length;
  if (!total) {
    return { cleared: 0, total: 0 };
  }

  const { protocol } = new URL(url);
  let cleared = 0;

  for (const c of cookies) {
    try {
      const domain =
        c.domain && c.domain.startsWith(".") ? c.domain.slice(1) : c.domain;
      const path = c.path || "/";
      const cookieUrl = `${protocol}//${domain}${path}`;
      await chrome.cookies.remove({ url: cookieUrl, name: c.name });
      cleared++;
    } catch (e) {
      console.warn("Failed to remove cookie", c, e);
    }
  }

  return { cleared, total };
}

function isThirdParty(initiator, requestUrl) {
  const a = base(hostFromOrigin(initiator));
  const b = base(hostFromUrl(requestUrl));
  if (!a || !b) return true; // default to third-party if unknown
  return a !== b;
}


async function persistStats() {
  await chrome.storage.local.set({
    stats: { firstParty: blockedFirst, thirdParty: blockedThird }
  });
  chrome.runtime.sendMessage({
    type: "stats",
    firstParty: blockedFirst,
    thirdParty: blockedThird
  }).catch(() => {});
}

async function applyRules(mode = "moderate") {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map(r => r.id);

  const addRules = [];
  if (mode !== "low") {
    const allFilters = [...new Set([...FILTERS, ...customFilters])];
    const baseId = mode === "strict" ? 1000 : 2000;

    allFilters.forEach((f, i) => {
      addRules.push({
        id: baseId + i,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: f,
          resourceTypes: ["script", "xmlhttprequest", "image", "sub_frame"],
          ...(mode === "moderate" ? { domainType: "thirdParty" } : {}),
          excludedInitiatorDomains: trustedDomains
        }
      });
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  currentMode = mode;
  blockedFirst = 0;
  blockedThird = 0;
  await persistStats();
  setBadge();
}


function maybeNotify(host) {
  if (!notifyEnabled) return;
  const now = Date.now();
  const last = lastNotifyByDomain.get(host) || 0;
  if (now - last < 60_000) return; // 1 min per-domain
  const id = `block-${host}-${now}`;
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Tracker blocked",
    message: `${host} (${currentMode})`
  }, () => setTimeout(() => chrome.notifications.clear(id), 3000));
  lastNotifyByDomain.set(host, now);
}

async function loadTrustAndPromptFlag() {
  const { trusted = [], promptOnNewSites: flag } = await chrome.storage.local.get([
    "trusted",
    "promptOnNewSites"
  ]);
  trustedDomains = Array.isArray(trusted) ? trusted : [];
  // default to true unless explicitly false
  promptOnNewSites = flag !== false;
}
// sibling helper to loadTrustAndPromptFlag()
async function loadCustomFilters() {
  const { customFilters: stored } = await chrome.storage.local.get("customFilters");
  customFilters = Array.isArray(stored) ? stored : [];
}

async function applyPolicy(policy) {
  if (!policy || typeof policy !== "object") return;
  const { op, payload = {} } = policy;

  switch (op) {
    case "trust_site": {
      const site = payload.site;
      if (!site) break;
      const { trusted = [] } = await chrome.storage.local.get("trusted");
      const set = new Set(trusted);
      set.add(site);
      await chrome.storage.local.set({ trusted: [...set] });
      break;
    }

    case "untrust_site": {
      const site = payload.site;
      if (!site) break;
      const { trusted = [] } = await chrome.storage.local.get("trusted");
      const set = new Set(trusted);
      set.delete(site);
      await chrome.storage.local.set({ trusted: [...set] });
      break;
    }

    case "block_domain": {
      const domain = payload.domain;
      if (!domain) break;
      const { customFilters: stored = [] } = await chrome.storage.local.get("customFilters");
      const set = new Set(stored);
      set.add(domain);
      await chrome.storage.local.set({ customFilters: [...set] });
      break;
    }

    default:
      // unknown op, ignore for now
      break;
  }
}

async function pollPolicies() {
  try {
    const res = await fetch(`${BACKEND_URL}/api/policies?since=${lastPolicyTs}`);
    if (!res.ok) return;
    const { latestTs, items } = await res.json();

    if (Array.isArray(items)) {
      for (const p of items) {
        await applyPolicy(p);
      }
    }

    if (typeof latestTs === "number" && latestTs > lastPolicyTs) {
      lastPolicyTs = latestTs;
    }
  } catch (e) {
    // backend may not be running; ignore
  }
}

function startPreview(siteBase, tabId) {
  // reset any prior preview
  if (previewActive?.timerId) clearTimeout(previewActive.timerId);
  previewObserved.clear();
  const timerId = setTimeout(() => endPreview(), 5000); // ~5s window
  previewActive = { siteBase, tabId, timerId };
}

async function endPreview() {
  if (!previewActive) return;
  const { siteBase, tabId, timerId } = previewActive;
  clearTimeout(timerId);
  previewActive = null;
  previewReq = null;

  // persist mini receipt
  const { receipts = {} } = await chrome.storage.local.get(["receipts"]);
  const prev = receipts[siteBase]?.domains || [];
  const merged = new Set(prev);
  for (const [d, flags] of previewObserved.entries()) {
    // Store with a simple marker e.g., "doubleclick.net (blocked)" if blocked at least once
    merged.add(flags.blocked ? `${d} (blocked)` : d);
  }
  receipts[siteBase] = { lastSeen: Date.now(), domains: [...merged] };
  await chrome.storage.local.set({ receipts, __preview: null });

  // Build a summary array from previewObserved
  const domainsSummary = [];
  for (const [d, flags] of previewObserved.entries()) {
    domainsSummary.push({
      domain: d,
      blocked: !!flags.blocked,
      seen: !!flags.allowed
    });
  }

  // Log a preview.summary event
  logEvent("preview.summary", {
    siteBase,
    domains: domainsSummary
  }, tabId).catch(() => {});


  // return to interstitial for this dest
  const dest = locationCache[tabId] || "";
  if (dest) {
    const url = `${chrome.runtime.getURL("interstitial.html")}?dest=${encodeURIComponent(dest)}`;
    try { chrome.tabs.update(tabId, { url }); } catch {}
  }
}



//Boot & reactions
async function init() {
  await loadTrustAndPromptFlag();
  await loadCustomFilters(); 
  setInterval(pollPolicies, 10000); // poll every 10s
  const { privacyMode, notifyEnabled: storedNotify } = await chrome.storage.local.get([
    "privacyMode",
    "notifyEnabled"
  ]);
  notifyEnabled = !!storedNotify;
  await applyRules(privacyMode || "moderate");
}


chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);

chrome.storage.onChanged.addListener(async ch => {
  if ("privacyMode" in ch) await applyRules(ch.privacyMode.newValue);
  if ("notifyEnabled" in ch) notifyEnabled = !!ch.notifyEnabled.newValue;

  // trust list or interstitial flag changed
  if ("trusted" in ch || "promptOnNewSites" in ch) {
    await loadTrustAndPromptFlag();
    await applyRules(currentMode);
  }

  if ("__enterOnce" in ch && ch.__enterOnce?.newValue) {
    enterOnce = ch.__enterOnce.newValue;
  }

  if ("customFilters" in ch) {
    await loadCustomFilters();
    await applyRules(currentMode);
  }

  if ("__preview" in ch && ch.__preview?.newValue) {
    previewReq = ch.__preview.newValue; // { siteBase, dest, ts }
  }
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "cookies:getSummary") {
    (async () => {
      try {
        const { count, site } = await getCookieSummaryForUrl(msg.url);
        sendResponse({ ok: true, count, site });
      } catch (e) {
        console.error("cookies:getSummary failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();
    return true; // keep the message channel open for async sendResponse
  }
  if (msg?.type === "cookies:clearForSite") {
    (async () => {
      try {
        const result = await clearCookiesForUrl(msg.url);

        const host = hostFromUrl(msg.url || "");
        const siteBase = base(host);
        const tabId =
          sender.tab && typeof sender.tab.id === "number"
            ? sender.tab.id
            : null;

        await logEvent(
          "cookies.cleared",
          {
            url: msg.url,
            siteBase,
            cleared: result.cleared,
            total: result.total
          },
          tabId
        );

        sendResponse({ ok: true, ...result });
      } catch (e) {
        console.error("cookies:clearForSite failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();

    return true; // async sendResponse
  }

  if (msg?.type === "cookies:sendSnapshot") {
    (async () => {
      try {
        const snapshot = await buildCookieSnapshotForUrl(msg.url);
        if (!snapshot) {
          sendResponse({ ok: false, error: "Invalid URL" });
          return;
        }

        const tabId =
          sender.tab && typeof sender.tab.id === "number"
            ? sender.tab.id
            : null;

        await logEvent(
          "cookies.snapshot",
          {
            url: snapshot.url,
            siteBase: snapshot.siteBase,
            count: snapshot.count,
            thirdPartyCount: snapshot.thirdPartyCount,
            cookies: snapshot.cookies
          },
          tabId
        );

        sendResponse({ ok: true, count: snapshot.count });
      } catch (e) {
        console.error("cookies:sendSnapshot failed", e);
        sendResponse({ ok: false, error: e.message || String(e) });
      }
    })();

    return true; // keep the message channel open for async sendResponse
  }
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  try {
    if (details.frameId !== 0) return;

    const url = details.url || "";
    if (!/^https?:/i.test(url)) return;
    if (url.startsWith(chrome.runtime.getURL("interstitial.html"))) return;

    const siteBase = base(hostFromUrl(url));
    if (!siteBase) return;

    // cache last URL for this tab
    locationCache[details.tabId] = url;

    // one-time Enter bypass
    const now = Date.now();

    // one-time Enter bypass: allow this site to load once without interstitial
    if (enterOnce && enterOnce.siteBase === siteBase && (now - enterOnce.ts) < 15000) {
      enterOnce = null; // consume the bypass
      return;           // let this navigation proceed
    }

    // if interstitial set __preview for this site/dest, start preview now
    if (previewReq && previewReq.siteBase === siteBase && previewReq.dest === url) {
      startPreview(siteBase, details.tabId);   // use current mode
      return; // allow navigation to proceed
    }

    // interstitial redirect (unchanged)
    if (!promptOnNewSites) return;
    if (trustedDomains.includes(siteBase)) return;

    const interstitial = `${chrome.runtime.getURL("interstitial.html")}?dest=${encodeURIComponent(url)}`;
    chrome.tabs.update(details.tabId, { url: interstitial });
  } catch {}
});

chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
  if (currentMode === "low") return; // low has no rules

  const third = isThirdParty(info.request.initiator, info.request.url);
  if (third) {
    blockedThird++;
  } else {
    blockedFirst++;
  }

  setBadge();
  persistStats();

  const host = hostFromUrl(info.request.url);
  maybeNotify(host);

  // Work out the top-level site base from the initiator, if we can
  const topHost = hostFromOrigin(info.request.initiator || "");
  const siteBase = base(topHost);

  // Log a network.blocked event; logEvent will use siteBase as a fallback
  logEvent(
    "network.blocked",
    {
      url: info.request.url,
      domain: base(host),
      resourceType: info.request.resourceType,
      ruleId: info.rule.id,
      isThirdParty: third,
      siteBase // ✅ now defined
    },
    info.tabId
  ).catch(() => {});
});



chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!previewActive || details.tabId !== previewActive.tabId) return;

  const siteBase = previewActive.siteBase;
  const reqBase = base(hostFromUrl(details.url));
  if (!reqBase || reqBase === siteBase) return; // only care about 3rd-party

  const rec = previewObserved.get(reqBase) || { blocked: false, allowed: false };
  rec.allowed = true;
  previewObserved.set(reqBase, rec);

  // log a network.observed event (attempted request during preview)
  logEvent("network.observed", {
    url: details.url,
    domain: reqBase,
    resourceType: details.type, // may be undefined in some cases, that's okay
    isThirdParty: true,
    siteBase
  }, details.tabId).catch(() => {});
}, { urls: ["<all_urls>"] });

