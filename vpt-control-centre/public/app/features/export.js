// public/app/features/export.js

export function initExportFeature() {
  const utils = window.VPT?.utils;
  if (!utils) {
    console.error("[export] VPT.utils missing (did app/core.js load first?)");
    return;
  }

  const { buildExportUrl, triggerDownload } = utils;

  // Dashboard export buttons 
  const btnJson = document.getElementById("btnExportJson");
  const btnCsv = document.getElementById("btnExportCsv");

  if (btnJson) {
    btnJson.addEventListener("click", () => {
      const url = buildExportUrl("json", {});
      triggerDownload(url);
    });
  }

  if (btnCsv) {
    btnCsv.addEventListener("click", () => {
      const url = buildExportUrl("csv", {});
      triggerDownload(url);
    });
  }
}

// make available to non-module dashboard.js
window.initExportFeature = initExportFeature;
