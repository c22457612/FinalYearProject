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

    const selectedVendor = getSelectedVendor();
    if (!selectedVendor?.vendorId) {
      box.classList.add("hidden");
      box.innerHTML = "";
      return;
    }

    const scopedCount = getChartEvents().length;
    box.classList.remove("hidden");
    box.innerHTML = "";

    const text = document.createElement("div");
    text.className = "vendor-scope-banner-text";
    text.textContent = getFocusedLensPivotActive()
      ? `Selected Vendor: ${selectedVendor.vendorName || selectedVendor.vendorId} (${scopedCount} events). Showing timeline because compare has low data.`
      : `Selected Vendor: ${selectedVendor.vendorName || selectedVendor.vendorId} (${scopedCount} events in current scope).`;
    box.appendChild(text);

    const actions = document.createElement("div");
    actions.className = "vendor-scope-banner-actions";

    const vaultLink = document.createElement("a");
    const vendorParam = selectedVendor.vendorName || selectedVendor.vendorId;
    vaultLink.href = `/vendor-vault.html?site=${encodeURIComponent(getSiteName() || "")}&vendor=${encodeURIComponent(vendorParam)}`;
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
