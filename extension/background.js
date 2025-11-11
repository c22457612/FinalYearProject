const FILTERS = [
  "google-analytics.com",
  "doubleclick.net",
  "googletagmanager.com",
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

  // if a preview is requested, temporarily switch to strict; when it ends, you can switch back (A2)
  if ("__preview" in ch && ch.__preview?.newValue) {
    // we’ll add strict-preview behavior in the next step.
  }

  if ("__enterOnce" in ch && ch.__enterOnce?.newValue) {
  enterOnce = ch.__enterOnce.newValue;
}

});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  try {
    if (details.frameId !== 0) return;

    const url = details.url || "";
    if (!/^https?:/i.test(url)) return;
    if (url.startsWith(chrome.runtime.getURL("interstitial.html"))) return;

    const now = Date.now();
    const siteBase = base(hostFromUrl(url));
    if (!siteBase) return;

    // one-time Enter bypass
    if (enterOnce && enterOnce.siteBase === siteBase && (now - enterOnce.ts) < 15000) {
      enterOnce = null; // consume bypass
      return;           // allow navigation once
    }

    if (!promptOnNewSites) return;
    if (trustedDomains.includes(siteBase)) return;

    const interstitial = `${chrome.runtime.getURL("interstitial.html")}?dest=${encodeURIComponent(url)}`;
    chrome.tabs.update(details.tabId, { url: interstitial });
  } catch {}
});

chrome.declarativeNetRequest.onRuleMatchedDebug.addListener((info) => {
  if (currentMode === "low") return; // low installs no rules, so skip

  const third = isThirdParty(info.request.initiator, info.request.url);
  if (third) blockedThird++; else blockedFirst++;

  setBadge();
  persistStats();

  const host = hostFromUrl(info.request.url);
  maybeNotify(host); // optional toast if enabled notifications
});

