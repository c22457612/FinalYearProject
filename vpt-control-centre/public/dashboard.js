const POLL_MS = 3000; // poll every 3s

function friendlyTime(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return "-";
  return d.toLocaleTimeString();
}

function modeClass(mode) {
  const m = String(mode || "").toLowerCase();
  if (m === "low" || m === "moderate" || m === "strict") return m;
  return "";
}

// ---- Rendering ----

function renderSummary(events, sites) {
  const total = events.length;
  const siteCount = sites.length;

  const now = Date.now();
  const fiveMinAgo = now - 5 * 60 * 1000;
  const recent = events.filter(e => e.ts && e.ts >= fiveMinAgo).length;

  document.getElementById("statTotalEvents").textContent = total;
  document.getElementById("statSites").textContent = siteCount;
  document.getElementById("statRecent").textContent = recent;
  document.getElementById("statRecentHint").textContent =
    recent ? "in the last 5 minutes" : "none in the last 5 minutes";
}

function summarizeEvent(ev) {
  const kind = ev.kind || "event";
  const d = ev.data || {};

  if (kind === "network.blocked") {
    const domain = d.domain || "tracker";
    const t = d.isThirdParty ? "third-party" : "first-party";
    return `${t} request to ${domain} blocked`;
  }
  if (kind === "network.observed") {
    const domain = d.domain || "third-party";
    return `preview saw request to ${domain}`;
  }
  if (kind === "preview.summary") {
    const total = d.total || 0;
    const domains = Array.isArray(d.domains) ? d.domains.slice(0, 3).join(", ") : "";
    return `preview found ${total} third-party domain(s)${domains ? ` (${domains})` : ""}`;
  }
  return JSON.stringify(d) || "(no details)";
}

function renderEvents(events) {
  const tbody = document.getElementById("eventsTableBody");
  tbody.innerHTML = "";

  const sorted = [...events].sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const latest = sorted.slice(0, 50);

  latest.forEach(ev => {
    const tr = document.createElement("tr");

    const tdTime = document.createElement("td");
    tdTime.textContent = friendlyTime(ev.ts);
    tr.appendChild(tdTime);

    const tdSite = document.createElement("td");
    tdSite.textContent = ev.site || "unknown";
    tr.appendChild(tdSite);

    const tdKind = document.createElement("td");
    const pillKind = document.createElement("span");
    pillKind.className = "pill pill-kind";
    pillKind.textContent = ev.kind || "event";
    tdKind.appendChild(pillKind);
    tr.appendChild(tdKind);

    const tdDetails = document.createElement("td");
    tdDetails.textContent = summarizeEvent(ev);
    tr.appendChild(tdDetails);

    const tdMode = document.createElement("td");
    const pillMode = document.createElement("span");
    pillMode.className = "pill pill-mode " + modeClass(ev.mode);
    pillMode.textContent = ev.mode || "-";
    tdMode.appendChild(pillMode);
    tr.appendChild(tdMode);

    tbody.appendChild(tr);
  });

  const subtitle = document.getElementById("receiptSubtitle");
  if (!latest.length) {
    subtitle.textContent = "No events received yet. Browse a site with trackers to see activity.";
  } else {
    subtitle.textContent = `Showing ${latest.length} of ${events.length} event(s)`;
  }
}

function renderSites(sites) {
  const tbody = document.getElementById("sitesTableBody");
  tbody.innerHTML = "";

  const rows = [...sites].sort((a, b) => b.totalEvents - a.totalEvents);

  rows.forEach(s => {
    const tr = document.createElement("tr");

    const tdSite = document.createElement("td");
    tdSite.textContent = s.site;
    tr.appendChild(tdSite);

    const tdTotal = document.createElement("td");
    tdTotal.textContent = s.totalEvents;
    tr.appendChild(tdTotal);

    const tdBlocked = document.createElement("td");
    tdBlocked.textContent = s.blockedCount;
    tr.appendChild(tdBlocked);

    const tdObserved = document.createElement("td");
    tdObserved.textContent = s.observedCount;
    tr.appendChild(tdObserved);

    const tdThird = document.createElement("td");
    tdThird.textContent = s.uniqueThirdParties;
    tr.appendChild(tdThird);

    tbody.appendChild(tr);
  });
}

// ---- Poll loop ----

async function fetchAndRender() {
  const statusEl = document.getElementById("connectionStatus");
  try {
    const [eventsRes, sitesRes] = await Promise.all([
      fetch("/api/events"),
      fetch("/api/sites")
    ]);
    if (!eventsRes.ok || !sitesRes.ok) throw new Error("HTTP error");

    const events = await eventsRes.json(); // server returns an ARRAY
    const sites = await sitesRes.json();

    statusEl.textContent = "Connected to local backend";
    statusEl.style.color = "#10b981";

    renderSummary(events, sites);
    renderEvents(events);
    renderSites(sites);
  } catch (err) {
    console.error("fetch error", err);
    statusEl.textContent = "Backend unavailable – is server.js running?";
    statusEl.style.color = "#f97316";
  }
}

window.addEventListener("load", () => {
  fetchAndRender();
  setInterval(fetchAndRender, POLL_MS);
});
