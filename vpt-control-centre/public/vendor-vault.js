function qs(id) {
  return document.getElementById(id);
}

function buildSiteInsightsHref(site) {
  return `/site.html?site=${encodeURIComponent(site)}`;
}

function createLink(text, href) {
  const link = document.createElement("a");
  link.className = "viz-nav";
  link.style.textDecoration = "none";
  link.href = href;
  link.textContent = text;
  return link;
}

function showMissingState(site) {
  const missing = qs("vaultMissingState");
  const content = qs("vaultContent");
  const sections = qs("vaultSections");
  const links = qs("vaultMissingLinks");
  if (!missing || !content || !sections || !links) return;

  missing.classList.remove("hidden");
  content.classList.add("hidden");
  sections.classList.add("hidden");
  links.innerHTML = "";

  links.appendChild(createLink("Back to Control Centre", "/"));
  if (site) {
    links.appendChild(createLink("Back to Site Insights", buildSiteInsightsHref(site)));
  }
}

function showVaultContent(site, vendor) {
  const missing = qs("vaultMissingState");
  const content = qs("vaultContent");
  const sections = qs("vaultSections");
  const siteChip = qs("vaultSiteChip");
  const vendorChip = qs("vaultVendorChip");
  const backLink = qs("backToSiteInsightsLink");
  if (!missing || !content || !sections || !siteChip || !vendorChip || !backLink) return;

  missing.classList.add("hidden");
  content.classList.remove("hidden");
  sections.classList.remove("hidden");

  siteChip.textContent = `Site: ${site}`;
  vendorChip.textContent = `Vendor: ${vendor}`;
  backLink.href = buildSiteInsightsHref(site);
}

function bootVendorVault() {
  const params = new URLSearchParams(window.location.search);
  const site = String(params.get("site") || "").trim();
  const vendor = String(params.get("vendor") || "").trim();

  if (!site || !vendor) {
    showMissingState(site);
    return;
  }

  showVaultContent(site, vendor);
}

window.addEventListener("load", bootVendorVault);
