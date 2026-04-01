(function initInterstitial() {
  const CONTROL_CENTRE_URL = "http://127.0.0.1:4141/";
  const THEME_API_URL = `${CONTROL_CENTRE_URL}api/ui/theme`;
  const THEME_STORAGE_KEY = "vpt.popup.theme";
  const DEFAULT_THEME_ID = "midnight";
  const THEME_IDS = new Set(["midnight", "amber", "oxblood", "daybreak"]);
  const BLOCKED_SUFFIX = " (blocked)";

  const params = new URLSearchParams(location.search);
  const dest = params.get("dest") || "";
  const decisionSectionEl = document.getElementById("decisionSection");
  const siteHeadlineEl = document.getElementById("siteHeadline");
  const siteEl = document.getElementById("site");
  const modeEl = document.getElementById("mode");
  const captureStateEl = document.getElementById("captureState");
  const trustStateChipEl = document.getElementById("trustStateChip");
  const trustStatusLineEl = document.getElementById("trustStatusLine");
  const trustSummaryEl = document.getElementById("trustSummary");
  const trustHeadlineEl = document.getElementById("trustHeadline");
  const trustCopyEl = document.getElementById("trustCopy");
  const trustEffectEl = document.getElementById("trustEffect");
  const openOnceEffectEl = document.getElementById("openOnceEffect");
  const captureNoticeEl = document.getElementById("captureNotice");
  const receiptEl = document.getElementById("receipt");
  const receiptEmptyEl = document.getElementById("receiptEmpty");
  const receiptStatusChipEl = document.getElementById("receiptStatusChip");
  const enterBtn = document.getElementById("enter");
  const enterLabelEl = document.getElementById("enterLabel");
  const previewBtn = document.getElementById("preview");
  const previewLabelEl = document.getElementById("previewLabel");
  const trustBtn = document.getElementById("trust");
  const trustLabelEl = document.getElementById("trustLabel");

  function normalizeThemeId(themeId) {
    const candidate = String(themeId || "").trim().toLowerCase();
    return THEME_IDS.has(candidate) ? candidate : DEFAULT_THEME_ID;
  }

  function persistTheme(themeId) {
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, normalizeThemeId(themeId));
    } catch (_error) {
      // Ignore storage failures and keep the current session theme.
    }
  }

  function applyTheme(themeId) {
    const nextTheme = normalizeThemeId(themeId);
    document.documentElement.dataset.theme = nextTheme;
    document.documentElement.style.colorScheme = nextTheme === "daybreak" ? "light" : "dark";
    persistTheme(nextTheme);
    return nextTheme;
  }

  async function refreshTheme() {
    try {
      const response = await fetch(THEME_API_URL, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      if (!response.ok) {
        throw new Error(`theme_http_${response.status}`);
      }
      const payload = await response.json();
      applyTheme(payload?.themeId);
    } catch (_error) {
      applyTheme(document.documentElement.dataset.theme || DEFAULT_THEME_ID);
    }
  }

  function toBaseDomain(host) {
    if (!host) return "";
    const parts = String(host).split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    return parts.slice(-2).join(".");
  }

  function titleCase(value) {
    const text = String(value || "").trim();
    if (!text) return "-";
    return text.charAt(0).toUpperCase() + text.slice(1);
  }

  function setSiteLabels(site) {
    const value = site || "(unknown)";
    if (siteHeadlineEl) siteHeadlineEl.textContent = value;
    if (siteEl) siteEl.textContent = value;
  }

  function setTrustVisuals({
    chipTone,
    chipText,
    statusLine,
    summaryTone,
    headline,
    copy,
    trustEffect,
    openOnceEffect,
    buttonText,
    sectionState,
  }) {
    if (decisionSectionEl) {
      decisionSectionEl.dataset.state = sectionState || "supported";
    }
    if (trustStateChipEl) {
      trustStateChipEl.dataset.tone = chipTone;
      trustStateChipEl.textContent = chipText;
    }
    if (trustStatusLineEl) {
      trustStatusLineEl.textContent = statusLine;
    }
    if (trustSummaryEl) {
      trustSummaryEl.dataset.tone = summaryTone;
    }
    if (trustHeadlineEl) {
      trustHeadlineEl.textContent = headline;
    }
    if (trustCopyEl) {
      trustCopyEl.textContent = copy;
    }
    if (trustEffectEl) {
      trustEffectEl.textContent = trustEffect;
    }
    if (openOnceEffectEl) {
      openOnceEffectEl.textContent = openOnceEffect;
    }
    if (trustLabelEl && buttonText) {
      trustLabelEl.textContent = buttonText;
    }
  }

  function setTrustUi({ siteBase, isTrusted, enabled, syncPending }) {
    if (!siteBase) {
      setTrustVisuals({
        chipTone: "unsupported",
        chipText: "Unavailable",
        statusLine: "Open a normal http or https page to use the site trust shortcut.",
        summaryTone: "unsupported",
        headline: "Trust unavailable",
        copy: "Open a normal http or https page to use the site trust shortcut.",
        trustEffect: "Trust changes are unavailable until the destination resolves to a normal site context.",
        openOnceEffect: "Open once can only continue when a valid destination URL is available.",
        buttonText: "Trust this site",
        sectionState: "unsupported",
      });
      trustBtn.disabled = true;
      return;
    }

    const allowRulesText = enabled === false
      ? "Trusted-site allow rules are paused."
      : "Trusted-site allow rules are active.";
    const syncText = syncPending ? " Control Centre sync is pending." : "";

    if (isTrusted) {
      setTrustVisuals({
        chipTone: "trusted",
        chipText: "Trusted",
        statusLine: `${allowRulesText}${syncText}`,
        summaryTone: syncPending ? "pending" : "trusted",
        headline: `${siteBase} is already trusted`,
        copy: `Opening it now will keep using the saved trust state. ${enabled === false ? "Trusted sites stay saved while the allow rules are paused." : "Trusted sites also allow any Browser API surfaces currently set to Allow on trusted sites."}${syncText}`,
        trustEffect: "Later visits skip this prompt and keep using the saved trust state for this site.",
        openOnceEffect: "Open once continues immediately with the current protection mode and keeps the existing trust state in place.",
        buttonText: "Keep this site trusted",
        sectionState: "supported",
      });
    } else {
      setTrustVisuals({
        chipTone: "untrusted",
        chipText: "Not trusted",
        statusLine: `${allowRulesText}${syncText}`,
        summaryTone: syncPending ? "pending" : "untrusted",
        headline: `${siteBase} is not trusted yet`,
        copy: `Trusting this site skips this prompt on later visits. ${enabled === false ? "Trusted-site allow rules are paused in the popup." : "Trusted sites also allow any Browser API surfaces currently set to Allow on trusted sites."}${syncText}`,
        trustEffect: "Trusting this site saves it for later visits and bypasses this prompt while first-visit prompting stays enabled.",
        openOnceEffect: "Open once continues now with the current protection mode and leaves this site untrusted for later visits.",
        buttonText: "Trust this site",
        sectionState: "supported",
      });
    }

    trustBtn.disabled = false;
  }

  function parseReceiptEntry(entry) {
    const raw = String(entry || "").trim();
    if (!raw) return null;
    if (raw.endsWith(BLOCKED_SUFFIX)) {
      return {
        domain: raw.slice(0, -BLOCKED_SUFFIX.length),
        blocked: true,
      };
    }
    return {
      domain: raw,
      blocked: false,
    };
  }

  function renderReceipt(items) {
    if (!receiptEl || !receiptEmptyEl || !receiptStatusChipEl) return;

    if (!items.length) {
      receiptEl.hidden = true;
      receiptEl.replaceChildren();
      receiptEmptyEl.hidden = false;
      receiptStatusChipEl.dataset.tone = "empty";
      receiptStatusChipEl.textContent = "No receipt";
      return;
    }

    const rows = items
      .map(parseReceiptEntry)
      .filter(Boolean)
      .slice(0, 6)
      .map((entry) => {
        const item = document.createElement("li");
        item.className = "receipt-row";

        const domain = document.createElement("span");
        domain.className = "receipt-domain";
        domain.textContent = entry.domain || "(unknown)";
        item.appendChild(domain);

        if (entry.blocked) {
          const flag = document.createElement("span");
          flag.className = "receipt-flag";
          flag.dataset.tone = "blocked";
          flag.textContent = "Blocked";
          item.appendChild(flag);
        }

        return item;
      });

    receiptEl.replaceChildren(...rows);
    receiptEl.hidden = false;
    receiptEmptyEl.hidden = true;
    receiptStatusChipEl.dataset.tone = "stored";
    receiptStatusChipEl.textContent = "Receipt stored";
  }

  let siteBase = "";
  try {
    siteBase = toBaseDomain(new URL(dest).hostname);
  } catch {
    siteBase = "";
  }

  setSiteLabels(siteBase);
  refreshTheme();

  chrome.storage.local.get(["privacyMode", "captureEnabled"]).then(({ privacyMode, captureEnabled }) => {
    const isCaptureEnabled = captureEnabled !== false;

    modeEl.textContent = titleCase(privacyMode || "moderate");
    captureStateEl.textContent = isCaptureEnabled ? "On" : "Paused";

    if (captureNoticeEl) {
      captureNoticeEl.hidden = isCaptureEnabled;
    }

    if (previewBtn) {
      previewBtn.disabled = !dest || !isCaptureEnabled;
    }

    if (previewLabelEl) {
      previewLabelEl.textContent = isCaptureEnabled ? "Preview first" : "Preview unavailable";
    }
  });

  chrome.runtime.sendMessage({
    type: "trustedSites:getCurrentSiteState",
    url: dest,
  }).then((response) => {
    if (!response?.ok) {
      throw new Error(response?.error || "Could not load trust state.");
    }

    siteBase = response.site || siteBase;
    setSiteLabels(siteBase);
    setTrustUi({
      siteBase,
      isTrusted: !!response.isTrusted,
      enabled: response.enabled !== false,
      syncPending: !!response.syncPending,
    });
  }).catch((error) => {
    console.error("Could not load interstitial trust state", error);
    setTrustVisuals({
      chipTone: "danger",
      chipText: "Unavailable",
      statusLine: "Trust state could not be loaded.",
      summaryTone: "danger",
      headline: "Could not load trust state",
      copy: "You can still open the site once, then use the popup or Control Centre to manage trust.",
      trustEffect: "Trust changes are temporarily unavailable from this screen.",
      openOnceEffect: "Open once still uses the current protection mode and leaves trust unchanged.",
      buttonText: "Trust this site",
      sectionState: "supported",
    });
    trustBtn.disabled = true;
  });

  enterBtn?.addEventListener("click", async () => {
    if (!dest) return;
    await chrome.storage.local.set({ __enterOnce: { siteBase, ts: Date.now() } });
    chrome.tabs.update({ url: dest });
  });

  trustBtn?.addEventListener("click", async () => {
    if (!siteBase || !dest) return;
    trustBtn.disabled = true;
    if (trustLabelEl) {
      trustLabelEl.textContent = "Saving trust...";
    }

    try {
      const response = await chrome.runtime.sendMessage({
        type: "trustedSites:setCurrentSiteTrust",
        url: dest,
        trusted: true,
      });

      if (!response?.ok) {
        throw new Error(response?.error || "Could not trust this site.");
      }

      chrome.tabs.update({ url: dest });
    } catch (error) {
      console.error("Failed to trust current site from interstitial", error);
      setTrustVisuals({
        chipTone: "danger",
        chipText: "Unavailable",
        statusLine: "Trust could not be saved from this screen.",
        summaryTone: "danger",
        headline: "Could not save trust",
        copy: error?.message || "Try again from the popup or Trusted Sites manager.",
        trustEffect: "Trust state was not changed.",
        openOnceEffect: "Open once still uses the current protection mode without saving trust.",
        buttonText: "Trust this site",
        sectionState: "supported",
      });
      trustBtn.disabled = false;
    }
  });

  document.getElementById("back")?.addEventListener("click", () => {
    if (history.length > 1) {
      history.back();
      return;
    }
    window.close();
  });

  previewBtn?.addEventListener("click", async () => {
    if (!dest || previewBtn.disabled) return;
    const ts = Date.now();
    await chrome.storage.local.set({ __preview: { ts, siteBase, dest } });
    chrome.tabs.update({ url: dest });
  });

  chrome.storage.local.get(["receipts"]).then(({ receipts = {} }) => {
    const items = Array.isArray(receipts?.[siteBase]?.domains) ? receipts[siteBase].domains : [];
    renderReceipt(items);
  }).catch((error) => {
    console.error("Could not load preview receipt", error);
    renderReceipt([]);
  });

  if (enterLabelEl) {
    enterLabelEl.textContent = "Open once with current mode";
  }
})();
