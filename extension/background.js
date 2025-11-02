//sample domains to test with for now
const FILTERS = [
  "google-analytics.com",
  "doubleclick.net",
  "googletagmanager.com",
  "facebook.com/tr"
];

// Flip to true for system toasts 
const NOTIFY_ENABLED = true;
const NOTIFY_COOLDOWN_MS = 60_000; // per-domain throttle (1 min)

// ----- State -----
let currentMode = "moderate";
let blockedCount = 0;
const lastNotifyByDomain = new Map();

// ----- Helpers -----
function setBadge(mode) {
  const label = blockedCount > 0 ? String(Math.min(999, blockedCount)) : ({ strict: "S", moderate: "M", low: "L" }[mode] || "");
  chrome.action.setBadgeText({ text: label });
  chrome.action.setBadgeBackgroundColor({
    color: mode === "strict" ? "#d93025" : mode === "moderate" ? "#f29900" : "#6b7280"
  });
}

async function applyRules(mode = "moderate") {
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  const removeRuleIds = existing.map(r => r.id);

  const addRules = [];
  if (mode !== "low") {
    const base = mode === "strict" ? 1000 : 2000;
    FILTERS.forEach((f, i) => {
      addRules.push({
        id: base + i,
        priority: 1,
        action: { type: "block" },
        condition: {
          urlFilter: f,
          resourceTypes: ["script", "xmlhttprequest", "image", "sub_frame"],
          ...(mode === "moderate" ? { domainType: "thirdParty" } : {})
        }
      });
    });
  }

  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds, addRules });
  currentMode = mode;
  blockedCount = 0; // reset per mode switch
  setBadge(mode);
}

function domainFrom(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function maybeNotify(host) {
  if (!NOTIFY_ENABLED) return;
  const now = Date.now();
  const last = lastNotifyByDomain.get(host) || 0;
  if (now - last < NOTIFY_COOLDOWN_MS) return;

  const id = `block-${host}-${now}`;
  chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: "Tracker blocked",
    message: `${host} (${currentMode})`
  }, () => setTimeout(() => chrome.notifications.clear(id), 3000));

  lastNotifyByDomain.set(host, now);
}

// ----- Boot & reactions -----
async function init() {
  const { privacyMode } = await chrome.storage.local.get(["privacyMode"]);
  await applyRules(privacyMode || "moderate");
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.storage.onChanged.addListener(ch => {
  if ("privacyMode" in ch) applyRules(ch.privacyMode.newValue);
});

// When a rule blocks, this fires (needs declarativeNetRequestFeedback perm)
chrome.declarativeNetRequest.onRuleMatchedDebug.addListener(info => {
  if (currentMode === "low") return;
  blockedCount++;
  setBadge(currentMode);
  const host = domainFrom(info.request.url);
  maybeNotify(host);
});
