export function buildVendorScopeBannerModel({
  selectedVendor = null,
  scopedCount = 0,
  focusedLensPivotActive = false,
  siteName = "",
} = {}) {
  if (!selectedVendor?.vendorId) return null;

  const vendorLabel = selectedVendor.vendorName || selectedVendor.vendorId;
  const text = focusedLensPivotActive
    ? `${vendorLabel} scoped to ${Number(scopedCount || 0)} events. Focused timeline is active because comparison is thin here.`
    : `${vendorLabel} scoped to ${Number(scopedCount || 0)} events in the current chart scope.`;

  return {
    text,
    href: `/vendor-vault.html?site=${encodeURIComponent(siteName || "")}&vendor=${encodeURIComponent(vendorLabel)}`,
  };
}

export function createVendorScopeBanner(deps) {
  const {
    qs,
    getSelectedVendor,
    getChartEvents,
    getFocusedLensPivotActive,
    getSiteName,
  } = deps;

  function renderVendorScopeBanner() {
    const box = qs("vendorScopeBanner");
    if (!box) return;

    const model = buildVendorScopeBannerModel({
      selectedVendor: getSelectedVendor(),
      scopedCount: getChartEvents().length,
      focusedLensPivotActive: getFocusedLensPivotActive(),
      siteName: getSiteName(),
    });

    if (!model) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }

    box.classList.remove("hidden");
    box.innerHTML = "";

    const text = document.createElement("div");
    text.className = "vendor-scope-banner-text";
    text.textContent = model.text;
    box.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "vendor-scope-banner-actions";

    const vaultLink = document.createElement("a");
    vaultLink.href = model.href;
    vaultLink.className = "viz-nav";
    vaultLink.style.textDecoration = "none";
    vaultLink.target = "_blank";
    vaultLink.rel = "noopener noreferrer";
    vaultLink.textContent = "Open Vendor Vault";

    actions.appendChild(vaultLink);
    box.appendChild(actions);
  }

  return {
    renderVendorScopeBanner,
  };
}
