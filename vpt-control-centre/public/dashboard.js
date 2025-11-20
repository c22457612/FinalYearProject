const POLL_MS = 3000; // poll every 3s

let latestEvents = [];
let selectedEvent = null;
let selectedEventRow = null;
let trustedSites = new Set(); // derived from /api/policies

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

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function recomputePolicyState(policiesResponse) {
  const items = (policiesResponse && policiesResponse.items) || [];
  const trusted = new Set();

  for (const p of items) {
    if (!p || typeof p !== "object") continue;
    const op = p.op;
    const payload = p.payload || {};

    if (op === "trust_site" && payload.site) {
      trusted.add(payload.site);
    } else if (op === "untrust_site" && payload.site) {
      trusted.delete(payload.site);
    }
  }

  trustedSites = trusted;
}

function renderEventDetails(ev) {
  const body = document.getElementById("details-body");
  const actions = document.getElementById("details-actions");
  const subtitle = document.getElementById("details-subtitle");

  if (!ev) {
    selectedEvent = null;
    body.innerHTML = '<p class="muted">No event selected.</p>';
    actions.style.display = "none";

    const trustBtn = document.getElementById("trust-site-btn");
    if (trustBtn) trustBtn.disabled = true;

    subtitle.textContent = "Click an event in the table to see more information.";
    return;
  }


  selectedEvent = ev;

  const d = ev.data || {};
  const domain = d.domain || "(none)";
  const third = d.isThirdParty ? "third-party" : "first-party / unknown";

  subtitle.textContent =
    `Event at ${friendlyTime(ev.ts)} on ${ev.site || "unknown"}`;

  const isTrusted = ev.site && trustedSites.has(ev.site);
  const protectionStatus = isTrusted
    ? "trusted (tracking protection bypassed)"
    : "protected (tracking protection active)";

  body.innerHTML = `
    <div class="label">Event ID</div>
    <div class="value">${ev.id || "(none)"}</div>

    <div class="label">Site</div>
    <div class="value">${ev.site || "unknown"}</div>

    <div class="label">Protection status</div>
    <div class="value">${protectionStatus}</div>

    <div class="label">Kind</div>
    <div class="value">${ev.kind || "-"}</div>

    <div class="label">Mode</div>
    <div class="value">${ev.mode || "-"}</div>

    <div class="label">Domain</div>
    <div class="value">${domain}</div>

    <div class="label">Party</div>
    <div class="value">${third}</div>

    <div class="label">Resource type</div>
    <div class="value">${d.resourceType || "-"}</div>

    <div class="label">Summary</div>
    <div class="value">${escapeHtml(summarizeEvent(ev))}</div>

    <details class="raw">
      <summary>Show raw event JSON</summary>
      <pre>${escapeHtml(JSON.stringify(ev, null, 2))}</pre>
    </details>
  `;

  // decide whether the trust button should be shown/enabled
  const canTrustSite = !!ev.site;
  actions.style.display = canTrustSite ? "flex" : "none";

  const trustBtn = document.getElementById("trust-site-btn");
  if (trustBtn) {
    trustBtn.disabled = !canTrustSite;
    if (!canTrustSite) {
      trustBtn.textContent = "Trust this site (send to extension)";
    } else if (trustedSites.has(ev.site)) {
      trustBtn.textContent = `Stop trusting ${ev.site}`;
    } else {
      trustBtn.textContent = `Trust ${ev.site} (send to extension)`;
    }
  }
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

  latestEvents = events.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0));
  const latest = latestEvents.slice(0, 50);

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
    let text = summarizeEvent(ev);
    tdDetails.textContent = text;
    tr.appendChild(tdDetails);


    const tdMode = document.createElement("td");
    const pillMode = document.createElement("span");
    pillMode.className = "pill pill-mode " + modeClass(ev.mode);
    pillMode.textContent = ev.mode || "-";
    tdMode.appendChild(pillMode);
    tr.appendChild(tdMode);

    // click to see details
    tr.addEventListener("click", () => {
      if (selectedEventRow) {
        selectedEventRow.classList.remove("event-row-selected");
      }
      selectedEventRow = tr;
      tr.classList.add("event-row-selected");
      renderEventDetails(ev);
    });


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
  const tbody = document.getElementById("site-summary-body");
  tbody.innerHTML = "";

  const rows = sites.slice().sort((a, b) => b.totalEvents - a.totalEvents);

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
    const [eventsRes, sitesRes, policiesRes] = await Promise.all([
      fetch("/api/events"),
      fetch("/api/sites"),
      fetch("/api/policies")
    ]);
    if (!eventsRes.ok || !sitesRes.ok || !policiesRes.ok) {
      throw new Error("HTTP error");
    }

    const events = await eventsRes.json();   // server returns an ARRAY
    const sites = await sitesRes.json();
    const policies = await policiesRes.json();

    // update trustedSites set from policies
    recomputePolicyState(policies);

    statusEl.textContent = "Connected to local backend";
    statusEl.style.color = "#10b981";

    renderSummary(events, sites);
    renderEvents(events);
    renderSites(sites);

    // refresh details panel so status + button reflect current trust state
    renderEventDetails(selectedEvent);
  } catch (err) {
    console.error("fetch error", err);
    statusEl.textContent = "Backend unavailable – is server.js running?";
    statusEl.style.color = "#f97316";
  }
}


window.addEventListener("load", () => {
  fetchAndRender();
  setInterval(fetchAndRender, POLL_MS);

  // --- View switching (Home / Cookies) ---
  const homeView = document.getElementById("view-home");
  const cookiesView = document.getElementById("view-cookies");
  const navItems = document.querySelectorAll(".nav-item[data-view]");

  function switchView(view) {
    if (!homeView || !cookiesView) return;

    if (view === "cookies") {
      homeView.classList.add("hidden");
      cookiesView.classList.remove("hidden");
    } else {
      homeView.classList.remove("hidden");
      cookiesView.classList.add("hidden");
      view = "home";
    }

    navItems.forEach(btn => {
      if (btn.dataset.view === view) {
        btn.classList.add("active");
      } else {
        btn.classList.remove("active");
      }
    });
  }

  navItems.forEach(btn => {
    btn.addEventListener("click", () => {
      const view = btn.dataset.view || "home";
      switchView(view);
    });
  });

  // Default to Home on load
  switchView("home");

  const trustBtn = document.getElementById("trust-site-btn");
  if (trustBtn) {
    trustBtn.addEventListener("click", async () => {
      if (!selectedEvent || !selectedEvent.site) return;

      const site = selectedEvent.site;
      const isTrusted = trustedSites.has(site);
      const op = isTrusted ? "untrust_site" : "trust_site";

      const originalText = trustBtn.textContent;
      trustBtn.disabled = true;
      trustBtn.textContent = isTrusted
        ? `Stopping trust for ${site}…`
        : `Trusting ${site}…`;

      try {
        const res = await fetch("/api/policies", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ op, payload: { site } })
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const next = new Set(trustedSites);
        if (op === "trust_site") {
          next.add(site);
        } else {
          next.delete(site);
        }
        trustedSites = next;
        renderEventDetails(selectedEvent);

        trustBtn.textContent = op === "trust_site"
          ? `Sent: trust ${site}`
          : `Sent: stop trusting ${site}`;
      } catch (err) {
        console.error("Failed to send policy", err);
        trustBtn.textContent = "Error sending policy – try again";
      } finally {
        setTimeout(() => {
          trustBtn.disabled = false;
          renderEventDetails(selectedEvent);
        }, 1500);
      }
    });
  }
});



