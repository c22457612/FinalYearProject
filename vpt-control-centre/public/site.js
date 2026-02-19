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

// ---------- ECharts visualisation ----------

let chart = null;
let windowEvents = [];
let vizIndex = 0;
let vizSelection = null; // { type: "domain"|"bin"|"kind", value, fromTs, toTs }
let drawerMode = "normal"; // "normal" | "advanced"

const VIEWS = [
  { id: "timeline", title: "Activity timeline (last 24h)" },
  { id: "topSeen", title: "Top third-party domains (seen)" },
  { id: "kinds", title: "Event breakdown (kind)" },
  { id: "apiGating", title: "3P API-like calls (heuristic)" },
];

const RANGE_MS = {
  "1h": 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
  "7d": 7 * 24 * 60 * 60 * 1000,
  "all": null,
};

function getRangeKey() {
  return qs("rangeSelect")?.value || "24h";
}

function getRangeWindow() {
  const key = getRangeKey();
  const span = RANGE_MS[key];
  const to = Date.now();
  const from = span ? (to - span) : null;
  return { key, from, to };
}

function ensureChart() {
  const el = qs("vizChart");
  if (!el) return null;

  if (!chart) {
    chart = echarts.init(el);

    window.addEventListener("resize", () => chart && chart.resize());

    chart.on("click", (params) => {
      const viewId = VIEWS[vizIndex].id;
      handleChartClick(viewId, params);
    });

    // ✅ bind once
    chart.on("brushSelected", (params) => {
      const viewId = VIEWS[vizIndex].id;
      if (viewId !== "timeline") return;

      const meta = chart?.__vptMeta?.built?.meta;
      if (!meta) return;

      const area = params?.batch?.[0]?.areas?.[0];
      if (!area) {
        if (latestSiteData) renderRecentEvents(latestSiteData);
        return;
      }

      const toIndex = (x) => {
        if (typeof x === "number") return Math.round(x);
        const idx = meta.labels.indexOf(x);
        return idx >= 0 ? idx : 0;
      };

      let [a, b] = area.coordRange || [];
      let startIdx = toIndex(a);
      let endIdx = toIndex(b);

      startIdx = Math.max(0, Math.min(meta.binEvents.length - 1, startIdx));
      endIdx = Math.max(0, Math.min(meta.binEvents.length - 1, endIdx));
      if (startIdx > endIdx) [startIdx, endIdx] = [endIdx, startIdx];

      const selected = [];
      for (let i = startIdx; i <= endIdx; i++) selected.push(...(meta.binEvents[i] || []));

      renderRecentEventsFromEvents(selected);

      const startTs = meta.start + startIdx * meta.binMs;
      const endTs = meta.start + (endIdx + 1) * meta.binMs;

      const blocked = selected.filter(e => e.kind === "network.blocked").length;
      const observed = selected.filter(e => e.kind === "network.observed").length;

      openDrawer(
        `Selected window ${new Date(startTs).toLocaleTimeString()}–${new Date(endTs).toLocaleTimeString()}`,
        `<div class="muted">${selected.length} events • blocked ${blocked} • observed ${observed}</div>`,
        selected
      );
    });
  }

  return chart;
}

function isThirdPartyNetwork(ev) {
  return (ev?.kind === "network.blocked" || ev?.kind === "network.observed")
    && ev?.data?.domain
    && ev?.data?.isThirdParty === true;
}

function isApiLike(ev) {
  const rt = (ev?.data?.resourceType || "").toLowerCase();
  const url = (ev?.data?.url || "").toLowerCase();

  const looksApiPath =
    url.includes("/api/") || url.includes("/graphql") || url.includes("/v1/") || url.includes("/v2/") || url.includes("/rest/");

  const looksFetch = rt.includes("xhr") || rt.includes("fetch") || rt.includes("xmlhttprequest");

  return looksFetch || looksApiPath;
}

function explainEventNormal(ev) {
  if (!ev) return "No event selected.";
  const d = ev.data || {};
  if (ev.kind === "network.blocked") {
    return `A request to ${d.domain || "a domain"} was blocked (mode: ${ev.mode || "—"}). This can prevent trackers/ads/scripts from loading.`;
  }
  if (ev.kind === "network.observed") {
    return `A request to ${d.domain || "a domain"} was observed (allowed). This can indicate third-party activity on the page.`;
  }
  if (String(ev.kind || "").startsWith("cookies.")) {
    return `A cookies event occurred (${ev.kind}). Cookie-related activity was recorded for analysis.`;
  }
  return `Event recorded: ${ev.kind || "unknown"}.`;
}

function explainEventAdvanced(ev) {
  if (!ev) return "";
  const d = ev.data || {};
  return [
    `id: ${ev.id || "—"}`,
    `ts: ${ev.ts ? new Date(ev.ts).toLocaleString() : "—"}`,
    `site: ${ev.site || "—"}`,
    `kind: ${ev.kind || "—"}`,
    `mode: ${ev.mode || "—"}`,
    `domain: ${d.domain || "—"}`,
    `url: ${d.url || "—"}`,
    `resourceType: ${d.resourceType || "—"}`,
    `isThirdParty: ${typeof d.isThirdParty === "boolean" ? d.isThirdParty : "—"}`,
    `ruleId: ${d.ruleId || "—"}`,
  ].join("\n");
}

function openDrawer(title, summaryHtml, evidenceEvents) {
  const drawer = qs("vizDrawer");
  const backdrop = qs("vizDrawerBackdrop");
  if (!drawer || !backdrop) return;

  qs("drawerTitle").textContent = title || "Selection";
  qs("drawerSummary").innerHTML = summaryHtml || "";

  // Evidence list
  const box = qs("drawerEvents");
  box.innerHTML = "";
  const list = (evidenceEvents || []).slice(-20).reverse();

  if (!list.length) {
    box.innerHTML = `<div class="muted">No matching events.</div>`;
  } else {
    for (const ev of list) {
      const btn = document.createElement("button");
      btn.className = "event-row";
      btn.type = "button";
      btn.style.display = "block";
      btn.style.width = "100%";
      btn.style.textAlign = "left";
      btn.style.padding = "8px 10px";
      btn.style.border = "1px solid rgba(148,163,184,0.18)";
      btn.style.background = "rgba(15,23,42,0.3)";
      btn.style.color = "#e5e7eb";
      btn.style.marginBottom = "8px";
      btn.innerHTML = `<div style="font-size:12px;opacity:.8">${friendlyTime(ev.ts)} · ${ev.kind || "—"} · ${ev.mode || "—"}</div>
                       <div style="font-size:13px">${ev.data?.domain || "—"}</div>`;
      btn.addEventListener("click", () => {
        const normal = explainEventNormal(ev);
        const adv = explainEventAdvanced(ev).replaceAll("\n", "<br/>");
        const content = drawerMode === "advanced"
          ? `<pre style="white-space:pre-wrap">${adv}</pre>`
          : `<div>${normal}</div>`;
        qs("drawerSummary").innerHTML = content;
      });
      box.appendChild(btn);
    }
  }

  drawer.classList.remove("hidden");
  backdrop.classList.remove("hidden");
}

function closeDrawer() {
  qs("vizDrawer")?.classList.add("hidden");
  qs("vizDrawerBackdrop")?.classList.add("hidden");
}

function setDrawerMode(mode) {
  drawerMode = mode;
  qs("drawerNormalBtn")?.classList.toggle("active", mode === "normal");
  qs("drawerAdvancedBtn")?.classList.toggle("active", mode === "advanced");
}

function buildTimelineOption(events) {
  // 5-minute bins across the active range
  const { from, to } = getRangeWindow();
  const start = from ?? (events[0]?.ts ?? Date.now());
  const end = to ?? (events[events.length - 1]?.ts ?? Date.now());
  const binMs = 5 * 60 * 1000;
  const bins = Math.max(1, Math.ceil((end - start) / binMs));

  const labels = [];
  const blocked = new Array(bins).fill(0);
  const observed = new Array(bins).fill(0);
  const other = new Array(bins).fill(0);

  // map bin -> evidence events
  const binEvents = new Array(bins).fill(0).map(() => []);

  for (const ev of events) {
    if (!ev?.ts) continue;
    const idx = Math.min(bins - 1, Math.max(0, Math.floor((ev.ts - start) / binMs)));
    binEvents[idx].push(ev);

    if (ev.kind === "network.blocked") blocked[idx]++;
    else if (ev.kind === "network.observed") observed[idx]++;
    else other[idx]++;
  }

  for (let i = 0; i < bins; i++) {
    const t = new Date(start + i * binMs);
    labels.push(t.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  }

  return {
    option: {
    tooltip: { trigger: "axis" },
    legend: { top: 0 },
    toolbox: {
      right: 10,
      feature: {
        brush: { type: ["lineX", "clear"] },  // drag-select X range
        restore: {},                          // reset chart zoom/brush
      },
    },
    brush: {
      xAxisIndex: 0,
      brushMode: "single",
    },
    grid: { left: 40, right: 18, top: 36, bottom: 60 },
    xAxis: { type: "category", data: labels },
    yAxis: { type: "value" },
    dataZoom: [
      { type: "inside" },
      { type: "slider", height: 18, bottom: 18 },
    ],
    series: [
      { name: "Blocked", type: "bar", stack: "total", data: blocked },
      { name: "Observed", type: "bar", stack: "total", data: observed },
      { name: "Other", type: "bar", stack: "total", data: other },
    ],
  },
  meta: { start, binMs, binEvents, labels },

  };
}

function buildTopDomainsOption(events, metric = "seen") {
  const map = new Map(); // domain -> { seen, blocked, observed, events[] }

  for (const ev of events) {
    if (!isThirdPartyNetwork(ev)) continue;
    const d = ev.data.domain;
    if (!map.has(d)) map.set(d, { domain: d, seen: 0, blocked: 0, observed: 0, evs: [] });
    const obj = map.get(d);
    obj.seen++;
    if (ev.kind === "network.blocked") obj.blocked++;
    if (ev.kind === "network.observed") obj.observed++;
    obj.evs.push(ev);
  }

  const list = Array.from(map.values()).sort((a, b) => (b[metric] || 0) - (a[metric] || 0)).slice(0, 20);
  const labels = list.map(x => x.domain);
  const values = list.map(x => x[metric] || 0);

  // store evidence map for click
  const evidenceByDomain = new Map(list.map(x => [x.domain, x.evs]));

  return {
    option: {
      tooltip: { trigger: "axis" },
      grid: { left: 40, right: 18, top: 18, bottom: 120 },
      xAxis: { type: "category", data: labels, axisLabel: { rotate: 45 } },
      yAxis: { type: "value" },
      series: [{ name: metric, type: "bar", data: values }],
    },
    meta: { evidenceByDomain, metric },
  };
}

function buildKindsOption(events) {
  const map = new Map();
  for (const ev of events) {
    const k = ev?.kind || "unknown";
    map.set(k, (map.get(k) || 0) + 1);
  }
  const list = Array.from(map.entries()).sort((a, b) => b[1] - a[1]).slice(0, 18);
  return {
    option: {
      tooltip: { trigger: "axis" },
      grid: { left: 40, right: 18, top: 18, bottom: 120 },
      xAxis: { type: "category", data: list.map(x => x[0]), axisLabel: { rotate: 45 } },
      yAxis: { type: "value" },
      series: [{ type: "bar", data: list.map(x => x[1]) }],
    },
    meta: { list },
  };
}

function buildApiGatingOption(events) {
  const map = new Map(); // domain -> evs
  for (const ev of events) {
    if (!isThirdPartyNetwork(ev)) continue;
    if (!isApiLike(ev)) continue;
    const d = ev.data.domain;
    if (!map.has(d)) map.set(d, []);
    map.get(d).push(ev);
  }
  const list = Array.from(map.entries())
    .map(([domain, evs]) => ({ domain, count: evs.length, evs }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);

  const evidenceByDomain = new Map(list.map(x => [x.domain, x.evs]));

  return {
    option: {
      tooltip: { trigger: "axis" },
      grid: { left: 40, right: 18, top: 18, bottom: 120 },
      xAxis: { type: "category", data: list.map(x => x.domain), axisLabel: { rotate: 45 } },
      yAxis: { type: "value" },
      series: [{ name: "API-like calls", type: "bar", data: list.map(x => x.count) }],
    },
    meta: { evidenceByDomain },
  };
}

function renderECharts() {
  const c = ensureChart();
  if (!c) return;

  const viewId = VIEWS[vizIndex].id;
  const titleEl = qs("vizTitle");
  if (titleEl) titleEl.textContent = `Visualisation — ${VIEWS[vizIndex].title}`;

  const events = windowEvents || [];

  let built;
  if (viewId === "timeline") built = buildTimelineOption(events);
  else if (viewId === "kinds") built = buildKindsOption(events);
  else if (viewId === "apiGating") built = buildApiGatingOption(events);
  else built = buildTopDomainsOption(events, "seen"); // topSeen

  c.__vptMeta = { viewId, built };
  try {
    // Clear any timeline brush selection when switching views
    chart?.dispatchAction?.({ type: "brush", areas: [] });
  } catch {}

  c.setOption(built.option, true);
}

function handleChartClick(viewId, params) {
  const meta = chart?.__vptMeta?.built?.meta;
  if (!meta) return;

  // Timeline: click bin
  if (viewId === "timeline") {
    const idx = params?.dataIndex;
    const binEvents = meta.binEvents?.[idx] || [];
    const start = meta.start + idx * meta.binMs;
    const end = start + meta.binMs;

    // charts drive list (filter recent table to this bin)
    renderRecentEventsFromEvents(binEvents);

    openDrawer(
      `Time bin ${new Date(start).toLocaleTimeString()}–${new Date(end).toLocaleTimeString()}`,
      `<div class="muted">${binEvents.length} events in this interval.</div>`,
      binEvents
    );
    return;
  }

  // Bars: click domain or kind label
  if (viewId === "topSeen" || viewId === "apiGating") {
    const domain = params?.name;
    const evs = meta.evidenceByDomain?.get(domain) || [];

    renderRecentEventsFromEvents(evs);

    openDrawer(
      domain,
      `<div class="muted">${evs.length} matching events (current range).</div>`,
      evs
    );
    return;
  }

  if (viewId === "kinds") {
    const kind = params?.name;
    const evs = (windowEvents || []).filter(e => e?.kind === kind);

    renderRecentEventsFromEvents(evs);

    openDrawer(
      `Kind: ${kind}`,
      `<div class="muted">${evs.length} events of this kind (current range).</div>`,
      evs
    );
  }
}

function renderRecentEventsFromEvents(events) {
  // reuse the existing table renderer but feed it a "data-like" object
  renderRecentEvents({ recentEvents: events });
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
    await fetchWindowEvents();
    renderECharts();
  } catch (err) {
    console.error(err);
    setStatus(false, "Backend unavailable");
  }
}

let lastWindowFetchKey = null;
let lastWindowFetchAt = 0;

async function fetchWindowEvents(force = false) {
  const { key, from, to } = getRangeWindow();
  const fetchKey = `${key}:${from ?? "null"}:${to ?? "null"}`;

  const now = Date.now();
  const stale = (now - lastWindowFetchAt) > 5000; // refetch every 5s while polling

  if (!force && fetchKey === lastWindowFetchKey && windowEvents?.length && !stale) return;

  lastWindowFetchKey = fetchKey;
  lastWindowFetchAt = now;

  const q = new URLSearchParams();
  q.set("site", siteName);
  if (from) q.set("from", String(from));
  if (to) q.set("to", String(to));
  q.set("limit", "20000");

  const res = await fetch(`/api/events?${q.toString()}`);
  if (!res.ok) throw new Error(`events window HTTP ${res.status}`);
  windowEvents = await res.json();
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

  qs("drawerCloseBtn")?.addEventListener("click", closeDrawer);
  qs("vizDrawerBackdrop")?.addEventListener("click", closeDrawer);

  qs("drawerNormalBtn")?.addEventListener("click", () => setDrawerMode("normal"));
  qs("drawerAdvancedBtn")?.addEventListener("click", () => setDrawerMode("advanced"));
  setDrawerMode("normal");

  qs("vizPrevBtn")?.addEventListener("click", () => {
    vizIndex = (vizIndex - 1 + VIEWS.length) % VIEWS.length;
    qs("vizSelect").value = VIEWS[vizIndex].id;
    renderECharts();
  });

  qs("vizNextBtn")?.addEventListener("click", () => {
    vizIndex = (vizIndex + 1) % VIEWS.length;
    qs("vizSelect").value = VIEWS[vizIndex].id;
    renderECharts();
  });

  qs("vizSelect")?.addEventListener("change", () => {
    const id = qs("vizSelect").value;
    const idx = VIEWS.findIndex(v => v.id === id);
    vizIndex = idx >= 0 ? idx : 0;
    renderECharts();
  });

  qs("rangeSelect")?.addEventListener("change", async () => {
    await fetchWindowEvents(true);
    renderECharts();
  });


  // initial fetch + poll
  fetchSite();
  setInterval(fetchSite, POLL_MS);
});
