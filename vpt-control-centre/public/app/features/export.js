// public/app/features/export.js
export function initExportFeature() {
  const utils = window.VPT?.utils;
  if (!utils) return;

  const { buildExportUrl, triggerDownload } = utils;

  const allCsv = document.getElementById("exportAllCsvBtn");
  const allJson = document.getElementById("exportAllJsonBtn");
  const siteCsv = document.getElementById("exportSiteCsvBtn");
  const siteJson = document.getElementById("exportSiteJsonBtn");

  if (allCsv) allCsv.addEventListener("click", () => triggerDownload(buildExportUrl("csv", {})));
  if (allJson) allJson.addEventListener("click", () => triggerDownload(buildExportUrl("json", {})));

  if (siteCsv) siteCsv.addEventListener("click", () => {
    const site = window.VPT?.state?.selectedSite || null;
    triggerDownload(buildExportUrl("csv", site ? { site } : {}));
  });

  if (siteJson) siteJson.addEventListener("click", () => {
    const site = window.VPT?.state?.selectedSite || null;
    triggerDownload(buildExportUrl("json", site ? { site } : {}));
  });
}

window.initExportFeature = initExportFeature;
