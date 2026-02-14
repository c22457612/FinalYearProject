const POLL_MS = 3000;

let siteName = null;
let latestSiteData = null;

function qs(id) {
  return document.getElementById(id);
}

function getQueryParam(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function friendlyTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setStatus(ok, text) {
  const el = qs("siteConnectionStatus");
  if (!el) return;
  el.textContent = text;
  el.style.color = ok ? "#10b981" : "#f97316";
}

function triggerDownload(url) {
  const a = document.createElement("a");
  a.href = url;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

function buildExportUrl(format, params = {}) {
  const base = format === "csv"
    ? "/api/export/events.csv"
    : "/api/export/events.json";

  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === "") continue;
    q.set(k, v);
  }
  return `${base}?${q.toString()}`;
}

// ---------- Rendering ----------

function renderHeader(data) {
  qs("siteTitle").textContent = `Site insights: ${siteName}`;
  qs("siteSubtitle").textContent =
    `Last updated: ${data?.lastSeen ? new Date(data.lastSeen).toLocaleString() : "—"}`;

  // enable export buttons
  const csvBtn = qs("exportSiteCsvBtn");
  const jsonBtn = qs("exportSiteJsonBtn");
  if (csvBtn) csvBtn.disabled = false;
  if (jsonBtn) jsonBtn.disabled = false;
}

function renderStats(data) {
  qs("siteStatTotal").textContent = data.totalEvents ?? 0;
  qs("siteStatBlocked").textContent = data.blockedCount ?? 0;
  qs("siteStatObserved").textContent = data.observedCount ?? 0;
  qs("siteStatUniqueThird").textContent = data.uniqueThirdParties ?? 0;
}

function renderTopThirdParties(data) {
  const tbody = qs("topThirdBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const list = Array.isArray(data.topThirdParties) ? data.topThirdParties : [];

  if (list.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted";
    td.textContent = "No third-party domains recorded yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const item of list) {
    const tr = document.createElement("tr");

    const tdDomain = document.createElement("td");
    tdDomain.textContent = item.domain || "-";
    tr.appendChild(tdDomain);

    const tdSeen = document.createElement("td");
    tdSeen.textContent = item.seen ?? 0;
    tr.appendChild(tdSeen);

    const tdBlocked = document.createElement("td");
    tdBlocked.textContent = item.blocked ?? 0;
    tr.appendChild(tdBlocked);

    const tdObs = document.createElement("td");
    tdObs.textContent = item.observed ?? 0;
    tr.appendChild(tdObs);

    tbody.appendChild(tr);
  }
}

function renderRecentEvents(data) {
  const tbody = qs("recentEventsBody");
  if (!tbody) return;
  tbody.innerHTML = "";

  const events = Array.isArray(data.recentEvents) ? data.recentEvents : [];
  if (events.length === 0) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = 4;
    td.className = "muted";
    td.textContent = "No events for this site yet.";
    tr.appendChild(td);
    tbody.appendChild(tr);
    return;
  }

  for (const ev of events.slice(-100)) {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = friendlyTime(ev.ts);
    tr.appendChild(tdTime);

    const tdKind = document.createElement("td");
    tdKind.textContent = ev.kind || "-";
    tr.appendChild(tdKind);

    const tdDomain = document.createElement("td");
    tdDomain.textContent = ev.data?.domain || "-";
    tr.appendChild(tdDomain);

    const tdMode = document.createElement("td");
    tdMode.textContent = ev.mode || "-";
    tr.appendChild(tdMode);

    tbody.appendChild(tr);
  }
}

// ---------- Canvas visualisation ----------

function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const rect = canvas.getBoundingClientRect();
  canvas.width = Math.max(1, Math.floor(rect.width * dpr));
  canvas.height = Math.max(1, Math.floor(rect.height * dpr));
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return ctx;
}

function clearCanvas(ctx, canvas) {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
}

function drawBarChart(canvas, labels, values, title) {
  const ctx = setupCanvas(canvas);
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;

  clearCanvas(ctx, canvas);

  ctx.font = "14px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText(title || "Bar chart", 12, 22);

  const padL = 12;
  const padR = 12;
  const padT = 40;
  const padB = 28;

  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  const maxVal = Math.max(1, ...values);
  const n = Math.max(1, values.length);
  const gap = 8;
  const barW = Math.max(6, (chartW - gap * (n - 1)) / n);

  // axis baseline
  ctx.strokeStyle = "rgba(148,163,184,0.35)";
  ctx.beginPath();
  ctx.moveTo(padL, padT + chartH);
  ctx.lineTo(padL + chartW, padT + chartH);
  ctx.stroke();

  // bars
  for (let i = 0; i < n; i++) {
    const v = values[i] || 0;
    const bh = (v / maxVal) * chartH;
    const x = padL + i * (barW + gap);
    const y = padT + chartH - bh;

    ctx.fillStyle = "rgba(59,130,246,0.55)";
    ctx.fillRect(x, y, barW, bh);

    // value label
    ctx.fillStyle = "#cbd5e1";
    ctx.font = "11px ui-monospace, SFMono-Regular, Menlo, monospace";
    ctx.fillText(String(v), x, y - 6);

    // truncated label
    const rawLabel = labels[i] || "";
    const short = rawLabel.length > 12 ? rawLabel.slice(0, 11) + "…" : rawLabel;
    ctx.fillStyle = "#9ca3af";
    ctx.fillText(short, x, padT + chartH + 18);
  }
}

function drawTimeline(canvas, events) {
  const ctx = setupCanvas(canvas);
  const w = canvas.getBoundingClientRect().width;
  const h = canvas.getBoundingClientRect().height;

  clearCanvas(ctx, canvas);

  ctx.font = "14px system-ui, -apple-system, Segoe UI, sans-serif";
  ctx.fillStyle = "#e5e7eb";
  ctx.fillText("Activity timeline (recent)", 12, 22);

  if (!events || events.length === 0) {
    ctx.fillStyle = "#9ca3af";
    ctx.fillText("No recent events available.", 12, 50);
    return;
  }

  // bucket into 12 bins across the range
  const times = events.map(e => e.ts).filter(Boolean);
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const bins = 12;

  const counts = new Array(bins).fill(0);
  const span = Math.max(1, maxT - minT);

  for (const ev of events) {
    const t = ev.ts || minT;
    const idx = Math.min(bins - 1, Math.floor(((t - minT) / span) * bins));
    counts[idx]++;
  }

  const padL = 12;
  const padR = 12;
  const padT = 40;
  const padB = 28;

  const chartW = w - padL - padR;
  const chartH = h - padT - padB;

  const maxVal = Math.max(1, ...counts);

  // baseline
  ctx.strokeStyle = "rgba(148,163,184,0.35)";
  ctx.beginPath();
  ctx.moveTo(padL, padT + chartH);
  ctx.lineTo(padL + chartW, padT + chartH);
  ctx.stroke();

  // line
  ctx.strokeStyle = "rgba(16,185,129,0.9)";
  ctx.lineWidth = 2;
  ctx.beginPath();

  for (let i = 0; i < bins; i++) {
    const x = padL + (i / (bins - 1)) * chartW;
    const y = padT + chartH - (counts[i] / maxVal) * chartH;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.stroke();

  // points
  ctx.fillStyle = "rgba(16,185,129,0.9)";
  for (let i = 0; i < bins; i++) {
    const x = padL + (i / (bins - 1)) * chartW;
    const y = padT + chartH - (counts[i] / maxVal) * chartH;
    ctx.beginPath();
    ctx.arc(x, y, 3, 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderViz(data) {
  const canvas = qs("vizCanvas");
  if (!canvas) return;

  const mode = qs("vizSelect")?.value || "topSeen";
  const top = Array.isArray(data.topThirdParties) ? data.topThirdParties : [];
  const kinds = data.kindBreakdown || {};
  const recent = Array.isArray(data.recentEvents) ? data.recentEvents : [];

  if (mode === "topBlocked") {
    const labels = top.map(x => x.domain);
    const values = top.map(x => x.blocked ?? 0);
    drawBarChart(canvas, labels, values, "Top third-party domains (blocked)");
    return;
  }

  if (mode === "kinds") {
    const entries = Object.entries(kinds).sort((a, b) => b[1] - a[1]).slice(0, 12);
    const labels = entries.map(e => e[0]);
    const values = entries.map(e => e[1]);
    drawBarChart(canvas, labels, values, "Event breakdown (kind)");
    return;
  }

  if (mode === "timeline") {
    drawTimeline(canvas, recent.slice(-100));
    return;
  }

  // default: topSeen
  const labels = top.map(x => x.domain);
  const values = top.map(x => x.seen ?? 0);
  drawBarChart(canvas, labels, values, "Top third-party domains (seen)");
}

// ---------- Polling ----------

async function fetchSite() {
  const status = qs("siteConnectionStatus");

  try {
    const url = `/api/sites/${encodeURIComponent(siteName)}?top=20&recent=100`;
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = await res.json();
    latestSiteData = data;

    setStatus(true, "Connected");
    renderHeader(data);
    renderStats(data);
    renderTopThirdParties(data);
    renderRecentEvents(data);
    renderViz(data);
  } catch (err) {
    console.error(err);
    setStatus(false, "Backend unavailable");
  }
}

window.addEventListener("load", () => {
  siteName = getQueryParam("site");

  if (!siteName) {
    qs("siteTitle").textContent = "Site insights";
    qs("siteSubtitle").textContent = "No site specified in URL. Use /site.html?site=example.com";
    setStatus(false, "No site selected");
    return;
  }

  // wire export buttons
  const csvBtn = qs("exportSiteCsvBtn");
  const jsonBtn = qs("exportSiteJsonBtn");

  if (csvBtn) {
    csvBtn.addEventListener("click", () => {
      const url = buildExportUrl("csv", { download: "1", site: siteName });
      triggerDownload(url);
    });
  }

  if (jsonBtn) {
    jsonBtn.addEventListener("click", () => {
      const url = buildExportUrl("json", { download: "1", site: siteName });
      triggerDownload(url);
    });
  }

  // re-render chart when mode changes
  const sel = qs("vizSelect");
  if (sel) {
    sel.addEventListener("change", () => {
      if (latestSiteData) renderViz(latestSiteData);
    });
  }

  // initial fetch + poll
  fetchSite();
  setInterval(fetchSite, POLL_MS);
});
