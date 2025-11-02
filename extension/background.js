const FILTERS = [
  "google-analytics.com",
  "doubleclick.net",
  "googletagmanager.com",
  "facebook.com/tr"
];

function badge(mode) {
  const map = { strict: "S", moderate: "M", low: "L" };
  chrome.action.setBadgeText({ text: map[mode] || "" });
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
  badge(mode);
}

async function init() {
  const { privacyMode } = await chrome.storage.local.get(["privacyMode"]);
  await applyRules(privacyMode || "moderate");
}

chrome.runtime.onInstalled.addListener(init);
chrome.runtime.onStartup.addListener(init);
chrome.storage.onChanged.addListener(ch => {
  if ("privacyMode" in ch) applyRules(ch.privacyMode.newValue);
});
