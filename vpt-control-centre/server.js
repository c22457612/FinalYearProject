// server.js
const express = require("express");
const cors = require("cors");
const path = require("path");

// SQLite initialisation
const { initDb } = require("./db");

const app = express();
const PORT = process.env.PORT || 4141;

// Simple in-memory command queue for live controls
let nextCommandId = 1;
let pendingCommands = []; // { id, type, site, createdAt }

// --- In-memory stores (prototype only for now) ---
/** @type {Array<any>} */
const events = [];
/** @type {Array<any>} */
const policies = [];
/** @type {Map<string, any>} */
const siteStats = new Map();

app.use(cors());
app.use(express.json());

// serve dashboard static files from ./public
app.use(express.static(path.join(__dirname, "public")));

// ---- Helpers ----
function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`;
}

function updateSiteStatsFromEvent(ev) {
  const site = ev.site || "unknown";
  let s = siteStats.get(site);

  if (!s) {
    s = {
      site,
      firstSeen: ev.ts,
      lastSeen: ev.ts,
      totalEvents: 0,
      blockedCount: 0,
      observedCount: 0,
      thirdParties: {}, // domain -> { seen, blocked }
    };
    siteStats.set(site, s);
  }

  s.totalEvents++;
  s.lastSeen = ev.ts;

  if (ev.kind === "network.blocked") {
    s.blockedCount++;
    const d = ev.data?.domain;
    if (d) {
      if (!s.thirdParties[d]) s.thirdParties[d] = { seen: 0, blocked: 0 };
      s.thirdParties[d].seen++;
      s.thirdParties[d].blocked++;
    }
  } else if (ev.kind === "network.observed") {
    s.observedCount++;
    const d = ev.data?.domain;
    if (d) {
      if (!s.thirdParties[d]) s.thirdParties[d] = { seen: 0, blocked: 0 };
      s.thirdParties[d].seen++;
    }
  }
}

// ---- Events API ----
app.post("/api/events", (req, res) => {
  const body = req.body;
  const list = Array.isArray(body) ? body : [body];

  console.log("POST /api/events", "count =", list.length);

  for (const ev of list) {
    if (!ev || typeof ev !== "object") continue;
    if (!ev.id) ev.id = makeId("evt");
    if (!ev.ts) ev.ts = Date.now();
    events.push(ev);
    updateSiteStatsFromEvent(ev);
  }

  // keep last N events
  const MAX = 2000;
  if (events.length > MAX) {
    events.splice(0, events.length - MAX);
  }

  res.status(202).json({ ok: true, count: list.length });
});

app.get("/api/events", (req, res) => {
  const site = req.query.site || null;
  const kind = req.query.kind || null;

  let out = events;
  if (site) out = out.filter((e) => e.site === site);
  if (kind) out = out.filter((e) => e.kind === kind);

  // limit to last 200 to avoid giant payloads
  const slice = out.slice(-200);
  res.json(slice);
});

// --- Live control commands ---
app.post("/api/commands/trust-site", (req, res) => {
  const { site } = req.body || {};
  if (!site || typeof site !== "string") {
    return res.status(400).json({ error: "site is required" });
  }

  const cmd = {
    id: nextCommandId++,
    type: "trust-site",
    site,
    createdAt: Date.now(),
  };

  pendingCommands.push(cmd);

  if (pendingCommands.length > 200) {
    pendingCommands = pendingCommands.slice(-200);
  }

  console.log("Enqueued command:", cmd);
  res.json({ ok: true, commandId: cmd.id });
});

app.get("/api/commands/poll", (req, res) => {
  const since = Number(req.query.since || 0);
  const commands = pendingCommands.filter((c) => c.id > since);
  res.json({
    commands,
    latestId: nextCommandId - 1,
  });
});

app.get("/api/sites", (req, res) => {
  const list = Array.from(siteStats.values()).map((s) => {
    const uniqueThirdParties = Object.keys(s.thirdParties).length;
    return {
      site: s.site,
      firstSeen: s.firstSeen,
      lastSeen: s.lastSeen,
      totalEvents: s.totalEvents,
      blockedCount: s.blockedCount,
      observedCount: s.observedCount,
      uniqueThirdParties,
    };
  });
  res.json(list);
});

app.get("/api/sites/:site", (req, res) => {
  const site = req.params.site;
  const s = siteStats.get(site);
  if (!s) return res.status(404).json({ error: "unknown_site" });
  res.json(s);
});

// ---- Policies API ----
app.post("/api/policies", (req, res) => {
  const body = req.body;
  const input = Array.isArray(body) ? body : [body];
  const created = [];

  console.log("POST /api/policies", "count =", input.length);
  for (const p of input) {
    if (!p || typeof p !== "object") continue;
    const { op, payload } = p;
    if (!op) continue;

    const pol = {
      id: makeId("pol"),
      ts: Date.now(),
      op,
      payload: payload || {},
    };
    policies.push(pol);
    created.push(pol);
  }

  res.status(201).json(created.length === 1 ? created[0] : created);
});

app.get("/api/policies", (req, res) => {
  const since = Number(req.query.since || 0);
  const items = policies.filter((p) => p.ts > since);
  const latestTs = items.length
    ? items.reduce((max, p) => (p.ts > max ? p.ts : max), since)
    : since;

  res.json({ latestTs, items });
});

//Initialise persistence, then start server ONCE
(async () => {
  try {
    const dbCtx = await initDb();
    app.locals.db = dbCtx;
    console.log(`SQLite ready: ${dbCtx.filename}`);

    app.listen(PORT, () => {
      console.log(`VPT control centre backend listening on http://127.0.0.1:${PORT}`);
    });
  } catch (err) {
    console.error("Failed to initialise SQLite database:", err);
    process.exit(1);
  }
})();
