// public/app/utils.js
export function friendlyTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString();
}

export function modeClass(mode) {
  const m = String(mode || "").toLowerCase();
  if (m === "low" || m === "moderate" || m === "strict") return m;
  return "";
}

export function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function buildExportUrl(format, params = {}) {
  const base =
    format === "csv" ? "/api/export/events.csv" : "/api/export/events.json";

  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    q.set(k, v);
  }

  return `${base}?${q.toString()}`;
}

export function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}
