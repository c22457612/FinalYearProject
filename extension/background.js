const FILTERS = [
  "google-analytics.com",
  "doubleclick.net",
  "googletagmanager.com",
  "googleapis.com",
  "facebook.com/tr",
  "matomo.org"
];

//State
let currentMode = "moderate";
let blockedFirst = 0;
let blockedThird = 0;
let notifyEnabled = false;
const lastNotifyByDomain = new Map(); // throttle toasts
let promptOnNewSites = true;   // default ON (toggle later in popup if you want)
let trustedDomains = [];       // base domains user trusts
let enterOnce = null; // { siteBase, ts }

let previewReq = null;             // { siteBase, dest, ts }
let previewActive = null;          // { siteBase, tabId, timerId }
const previewObserved = new Map(); // reqBase -> { blocked: boolean, allowed: boolean }
const locationCache = {};          // tabId -> last main-frame URL

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
        site = base(host); // your existing helper
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
    const baseId = mode === "strict" ? 1000 : 2000;
    FILTERS.forEach((f, i) => {
      addRules.push({
        id: baseId + i,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: f,
          resourceTypes: ["script", "xmlhttprequest", "image", "sub_frame"],
          ...(mode === "moderate" ? { domainType: "thirdParty" } : {}),
          // if the site is trusted, skip blocking there
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
  await loadTrustAndPromptFlag();  // <-- ADD
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

  if ("__preview" in ch && ch.__preview?.newValue) {
    previewReq = ch.__preview.newValue; // { siteBase, dest, ts }
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

    // --- PREVIEW: if interstitial set __preview for this site/dest, start preview now
    if (previewReq && previewReq.siteBase === siteBase && previewReq.dest === url) {
      startPreview(siteBase, details.tabId);   // <-- no rule changes; use current mode
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
  if (third) blockedThird++; else blockedFirst++;

  setBadge();
  persistStats();

  const host = hostFromUrl(info.request.url);
  maybeNotify(host);

  // NEW: log a network.blocked event (fire-and-forget)
  logEvent("network.blocked", {
    url: info.request.url,
    domain: base(host),
    resourceType: info.request.resourceType,
    ruleId: info.rule.id,
    isThirdParty: third
  }, info.tabId).catch(() => {});
});


chrome.webRequest.onBeforeRequest.addListener((details) => {
  if (!previewActive || details.tabId !== previewActive.tabId) return;

  const siteBase = previewActive.siteBase;
  const reqBase = base(hostFromUrl(details.url));
  if (!reqBase || reqBase === siteBase) return; // only care about 3rd-party

  const rec = previewObserved.get(reqBase) || { blocked: false, allowed: false };
  rec.allowed = true;
  previewObserved.set(reqBase, rec);

  // NEW: log a network.observed event (attempted request during preview)
  logEvent("network.observed", {
    url: details.url,
    domain: reqBase,
    resourceType: details.type, // may be undefined in some cases, that's okay
    isThirdParty: true,
    siteBase
  }, details.tabId).catch(() => {});
}, { urls: ["<all_urls>"] });

