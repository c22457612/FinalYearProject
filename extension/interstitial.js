(function initInterstitial() {
  const params = new URLSearchParams(location.search);
  const dest = params.get("dest") || "";
  const siteEl = document.getElementById("site");
  const modeEl = document.getElementById("mode");
  const captureStateEl = document.getElementById("captureState");
  const receiptEl = document.getElementById("receipt");
  const receiptEmptyEl = document.getElementById("receiptEmpty");
  const trustHeadlineEl = document.getElementById("trustHeadline");
  const trustCopyEl = document.getElementById("trustCopy");
  const captureNoticeEl = document.getElementById("captureNotice");
  const enterBtn = document.getElementById("enter");
  const previewBtn = document.getElementById("preview");
  const trustBtn = document.getElementById("trust");

  function toBaseDomain(host) {
    if (!host) return "";
    const parts = String(host).split(".").filter(Boolean);
    if (parts.length <= 2) return parts.join(".");
    return parts.slice(-2).join(".");
  }

  function setTrustUi({ siteBase, isTrusted, enabled }) {
    if (!siteBase) {
      trustHeadlineEl.textContent = "Trust unavailable";
      trustCopyEl.textContent = "Open a normal http or https page to use the site trust shortcut.";
      trustBtn.disabled = true;
      return;
    }

    const allowRulesText = enabled === false
      ? "Trusted-site allow rules are currently paused in the popup."
      : "Trusted sites also allow any Browser API surfaces currently set to Allow on trusted sites.";

    if (isTrusted) {
      trustHeadlineEl.textContent = `${siteBase} is already trusted`;
      trustCopyEl.textContent = `Opening it now will keep using the saved trust state. ${allowRulesText}`;
      trustBtn.textContent = "Keep this site trusted";
    } else {
      trustHeadlineEl.textContent = `${siteBase} is not trusted yet`;
      trustCopyEl.textContent = `Trusting this site skips this prompt on later visits. ${allowRulesText}`;
      trustBtn.textContent = "Trust this site";
    }
    trustBtn.disabled = false;
  }

  let siteBase = "";
  try {
    siteBase = toBaseDomain(new URL(dest).hostname);
  } catch {
    siteBase = "";
  }
  siteEl.textContent = siteBase || "(unknown)";

  chrome.storage.local.get(["privacyMode", "captureEnabled"]).then(({ privacyMode, captureEnabled }) => {
    modeEl.textContent = privacyMode || "moderate";
    const isCaptureEnabled = captureEnabled !== false;
    captureStateEl.textContent = isCaptureEnabled ? "On" : "Paused";
    if (captureNoticeEl) {
      captureNoticeEl.hidden = isCaptureEnabled;
    }
    if (previewBtn) {
      previewBtn.disabled = !dest || !isCaptureEnabled;
      previewBtn.textContent = isCaptureEnabled ? "Preview first" : "Preview unavailable";
    }
  });

  chrome.runtime.sendMessage({
    type: "trustedSites:getCurrentSiteState",
    url: dest,
  }).then((response) => {
    if (!response?.ok) {
      throw new Error(response?.error || "Could not load trust state.");
    }
    setTrustUi({
      siteBase: response.site || siteBase,
      isTrusted: !!response.isTrusted,
      enabled: response.enabled !== false,
    });
  }).catch((error) => {
    console.error("Could not load interstitial trust state", error);
    trustHeadlineEl.textContent = "Could not load trust state";
    trustCopyEl.textContent = "You can still open the site once, then use the popup or Control Centre to manage trust.";
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
    trustBtn.textContent = "Saving trust...";

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
      trustHeadlineEl.textContent = "Could not save trust";
      trustCopyEl.textContent = error?.message || "Try again from the popup or Trusted Sites manager.";
      trustBtn.textContent = "Trust this site";
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
    if (!items.length) {
      receiptEmptyEl.hidden = false;
      return;
    }

    receiptEmptyEl.hidden = true;
    receiptEl.innerHTML = "";
    items.slice(0, 6).forEach((entry) => {
      const item = document.createElement("li");
      item.textContent = entry;
      receiptEl.appendChild(item);
    });
  }).catch((error) => {
    console.error("Could not load preview receipt", error);
  });
})();
