export function qs(id) {
  return document.getElementById(id);
}

export function getQueryParam(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

export function friendlyTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

export function getEventKey(ev) {
  if (!ev) return "";

  if (ev.id !== null && ev.id !== undefined && ev.id !== "") {
    return `id:${String(ev.id)}`;
  }

  const d = ev.data || {};
  const ruleId = d.ruleId !== null && d.ruleId !== undefined && d.ruleId !== ""
    ? String(d.ruleId)
    : "-";

  return [
    "sig",
    String(ev.ts ?? "-"),
    String(ev.kind || "-"),
    String(d.domain || "-"),
    String(ev.mode || "-"),
    ruleId,
  ].join("|");
}

export function pickPrimarySelectedEvent(events) {
  const list = Array.isArray(events) ? events.filter(Boolean) : [];
  let best = null;
  let bestTs = Number.NEGATIVE_INFINITY;
  let bestKey = "";

  for (const ev of list) {
    const rawTs = Number(ev?.ts);
    const ts = Number.isFinite(rawTs) ? rawTs : Number.NEGATIVE_INFINITY;
    const key = getEventKey(ev);
    if (!best || ts > bestTs || (ts === bestTs && key > bestKey)) {
      best = ev;
      bestTs = ts;
      bestKey = key;
    }
  }

  return best;
}

export function formatSelectedLead(selection, primaryEvent) {
  if (!selection) return "You selected: no datapoint yet.";

  const label = selection?.title || selection?.value || "current scope";
  if (!primaryEvent) return `You selected: ${label}. No representative event available.`;

  const kind = primaryEvent.kind || "event";
  const domain = primaryEvent?.data?.domain ? ` on ${primaryEvent.data.domain}` : "";
  const when = primaryEvent?.ts ? friendlyTime(primaryEvent.ts) : "unknown time";
  return `You selected: ${label}. Representative event: ${kind}${domain} at ${when}.`;
}

export function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function buildExportUrl(format, params = {}) {
  const base = format === "csv" ? "/api/export/events.csv" : "/api/export/events.json";
  const q = new URLSearchParams();

  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    q.set(k, v);
  }

  return `${base}?${q.toString()}`;
}

export function formatPercent(value) {
  const n = Number(value || 0);
  return `${(n * 100).toFixed(1)}%`;
}

export function escapeCsvCell(value) {
  const text = String(value ?? "");
  const escaped = text.replaceAll("\"", "\"\"");
  return `"${escaped}"`;
}

export function debounce(fn, waitMs) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), waitMs);
  };
}
