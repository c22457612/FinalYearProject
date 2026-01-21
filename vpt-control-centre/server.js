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
app.post("/api/events", async (req, res) => {
  try {
    const body = req.body;
    const list = Array.isArray(body) ? body : [body];

    const dbCtx = app.locals.db;
    if (!dbCtx) {
      return res.status(500).json({ ok: false, error: "db_not_ready" });
    }

    console.log("POST /api/events", "count =", list.length);

    let inserted = 0;

    for (const ev of list) {
      if (!ev || typeof ev !== "object") continue;

      // Ensure minimum fields exist (same as before)
      if (!ev.id) ev.id = makeId("evt");
      if (!ev.ts) ev.ts = Date.now();

      // Fallback site detection: prefer ev.site, else ev.data.siteBase
      const site = ev.site || ev.data?.siteBase || "unknown";

      // Persist to SQLite (event sourcing)
      await dbCtx.run(
        `
          INSERT OR IGNORE INTO events
            (event_id, ts, site, kind, mode, tab_id, source, top_level_url, raw_event)
          VALUES
            (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          ev.id,
          ev.ts,
          site,
          ev.kind || "unknown",
          ev.mode || null,
          ev.tabId ?? null,
          ev.source || "extension",
          ev.topLevelUrl || null,
          JSON.stringify({ ...ev, site }), // store full event JSON
        ]
      );

      inserted++;

      // Keep in-memory stats updated (dashboard still works instantly)
      ev.site = site;
      events.push(ev);
      updateSiteStatsFromEvent(ev);
    }

    // keep last N events in memory (optional cache)
    const MAX = 2000;
    if (events.length > MAX) {
      events.splice(0, events.length - MAX);
    }

    res.status(202).json({ ok: true, count: list.length, inserted });
  } catch (err) {
    console.error("Failed to persist events:", err);
    res.status(500).json({ ok: false, error: "persist_failed" });
  }
});

app.get("/api/events", async (req, res) => {
  try {
    const dbCtx = app.locals.db;
    if (!dbCtx) {
      return res.status(500).json({ ok: false, error: "db_not_ready" });
    }

    const site = req.query.site || null;
    const kind = req.query.kind || null;
    const limit = Math.min(Number(req.query.limit || 200), 1000);

    const rows = await dbCtx.all(
      `
        SELECT raw_event
        FROM events
        WHERE (? IS NULL OR site = ?)
          AND (? IS NULL OR kind = ?)
        ORDER BY ts DESC
        LIMIT ?
      `,
      [site, site, kind, kind, limit]
    );

    // Parse and return in chronological order (oldest -> newest)
    const parsed = rows
      .map((r) => {
        try {
          return JSON.parse(r.raw_event);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();

    res.json(parsed);
  } catch (err) {
    console.error("Failed to read events from DB:", err);
    res.status(500).json({ ok: false, error: "read_failed" });
  }
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

app.get("/api/sites", async (req, res) => {
  try {
    const dbCtx = app.locals.db;
    if (!dbCtx) {
      return res.status(500).json({ ok: false, error: "db_not_ready" });
    }

    const limit = Math.min(Number(req.query.limit || 200), 1000);

    // Main per-site counts/timestamps (fast SQL aggregation)
    const baseRows = await dbCtx.all(
      `
        SELECT
          COALESCE(site, 'unknown') AS site,
          MIN(ts) AS firstSeen,
          MAX(ts) AS lastSeen,
          COUNT(*) AS totalEvents,
          SUM(CASE WHEN kind = 'network.blocked' THEN 1 ELSE 0 END) AS blockedCount,
          SUM(CASE WHEN kind = 'network.observed' THEN 1 ELSE 0 END) AS observedCount
        FROM events
        GROUP BY COALESCE(site, 'unknown')
        ORDER BY lastSeen DESC
        LIMIT ?
      `,
      [limit]
    );

    // count unique third-party domains seen per site
    // (tries SQLite json_extract; falls back to JS parsing if unavailable)
    const uniqueMap = new Map();

    try {
      const uniqRows = await dbCtx.all(`
        SELECT
          COALESCE(site, 'unknown') AS site,
          COUNT(DISTINCT json_extract(raw_event, '$.data.domain')) AS uniqueThirdParties
        FROM events
        WHERE kind IN ('network.blocked', 'network.observed')
        GROUP BY COALESCE(site, 'unknown')
      `);

      for (const r of uniqRows) {
        uniqueMap.set(r.site, Number(r.uniqueThirdParties) || 0);
      }
    } catch (e) {
      // Fallback: scan recent network events and build sets in JS
      const scanRows = await dbCtx.all(`
        SELECT COALESCE(site, 'unknown') AS site, raw_event
        FROM events
        WHERE kind IN ('network.blocked', 'network.observed')
        ORDER BY ts DESC
        LIMIT 5000
      `);

      const sets = new Map();

      for (const r of scanRows) {
        let ev;
        try {
          ev = JSON.parse(r.raw_event);
        } catch {
          continue;
        }

        const domain = ev?.data?.domain;
        if (!domain) continue;

        if (!sets.has(r.site)) sets.set(r.site, new Set());
        sets.get(r.site).add(domain);
      }

      for (const [site, set] of sets.entries()) {
        uniqueMap.set(site, set.size);
      }
    }

    // Match my existing dashboard expected output shape I already created
    const list = baseRows.map((r) => ({
      site: r.site,
      firstSeen: Number(r.firstSeen) || 0,
      lastSeen: Number(r.lastSeen) || 0,
      totalEvents: Number(r.totalEvents) || 0,
      blockedCount: Number(r.blockedCount) || 0,
      observedCount: Number(r.observedCount) || 0,
      uniqueThirdParties: uniqueMap.get(r.site) ?? 0,
    }));

    res.json(list);
  } catch (err) {
    console.error("Failed to build /api/sites summary from DB:", err);
    res.status(500).json({ ok: false, error: "sites_query_failed" });
  }
});

app.get("/api/sites/:site", async (req, res) => {
  try {
    const dbCtx = app.locals.db;
    if (!dbCtx) {
      return res.status(500).json({ ok: false, error: "db_not_ready" });
    }

    const site = req.params.site;
    const topLimit = Math.min(Number(req.query.top || 10), 50);
    const recentLimit = Math.min(Number(req.query.recent || 50), 200);

    // --- 1) Overall stats for this site ---
    const base = await dbCtx.get(
      `
        SELECT
          COALESCE(site, 'unknown') AS site,
          MIN(ts) AS firstSeen,
          MAX(ts) AS lastSeen,
          COUNT(*) AS totalEvents,
          SUM(CASE WHEN kind = 'network.blocked' THEN 1 ELSE 0 END) AS blockedCount,
          SUM(CASE WHEN kind = 'network.observed' THEN 1 ELSE 0 END) AS observedCount
        FROM events
        WHERE COALESCE(site, 'unknown') = ?
      `,
      [site]
    );

    if (!base || !base.totalEvents) {
      return res.status(404).json({ ok: false, error: "unknown_site" });
    }

    // --- 2) Breakdown by event kind ---
    const kindRows = await dbCtx.all(
      `
        SELECT kind, COUNT(*) AS count
        FROM events
        WHERE COALESCE(site, 'unknown') = ?
        GROUP BY kind
        ORDER BY count DESC
      `,
      [site]
    );

    const kindBreakdown = {};
    for (const r of kindRows) {
      kindBreakdown[r.kind] = Number(r.count) || 0;
    }

    // --- 3) Top third-party domains (trackers) ---
    let topThirdParties = [];
    let uniqueThirdParties = 0;

    try {
      // Uses SQLite JSON1 extension (usually available)
      const tpRows = await dbCtx.all(
        `
          SELECT
            json_extract(raw_event, '$.data.domain') AS domain,
            COUNT(*) AS seen,
            SUM(CASE WHEN kind = 'network.blocked' THEN 1 ELSE 0 END) AS blocked,
            SUM(CASE WHEN kind = 'network.observed' THEN 1 ELSE 0 END) AS observed
          FROM events
          WHERE COALESCE(site, 'unknown') = ?
            AND kind IN ('network.blocked', 'network.observed')
          GROUP BY domain
          HAVING domain IS NOT NULL
          ORDER BY seen DESC
          LIMIT ?
        `,
        [site, topLimit]
      );

      topThirdParties = tpRows.map((r) => ({
        domain: r.domain,
        seen: Number(r.seen) || 0,
        blocked: Number(r.blocked) || 0,
        observed: Number(r.observed) || 0,
      }));

      // Also count total unique domains (not just top list)
      const uniqueRow = await dbCtx.get(
        `
          SELECT COUNT(DISTINCT json_extract(raw_event, '$.data.domain')) AS uniqueCount
          FROM events
          WHERE COALESCE(site, 'unknown') = ?
            AND kind IN ('network.blocked', 'network.observed')
        `,
        [site]
      );

      uniqueThirdParties = Number(uniqueRow?.uniqueCount) || 0;
    } catch (e) {
      // Fallback if JSON1 functions are unavailable: compute in JS from recent rows
      const scanRows = await dbCtx.all(
        `
          SELECT raw_event
          FROM events
          WHERE COALESCE(site, 'unknown') = ?
            AND kind IN ('network.blocked', 'network.observed')
          ORDER BY ts DESC
          LIMIT 5000
        `,
        [site]
      );

      const map = new Map();
      for (const r of scanRows) {
        let ev;
        try {
          ev = JSON.parse(r.raw_event);
        } catch {
          continue;
        }

        const domain = ev?.data?.domain;
        if (!domain) continue;

        if (!map.has(domain)) map.set(domain, { domain, seen: 0, blocked: 0, observed: 0 });

        const obj = map.get(domain);
        obj.seen++;
        if (ev.kind === "network.blocked") obj.blocked++;
        if (ev.kind === "network.observed") obj.observed++;
      }

      const all = Array.from(map.values()).sort((a, b) => b.seen - a.seen);
      uniqueThirdParties = map.size;
      topThirdParties = all.slice(0, topLimit);
    }

    // --- 4) Recent events for this site ---
    const recentRows = await dbCtx.all(
      `
        SELECT raw_event
        FROM events
        WHERE COALESCE(site, 'unknown') = ?
        ORDER BY ts DESC
        LIMIT ?
      `,
      [site, recentLimit]
    );

    const recentEvents = recentRows
      .map((r) => {
        try {
          return JSON.parse(r.raw_event);
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .reverse();

    // --- Response object (stable + dashboard friendly) ---
    res.json({
      site: base.site,
      firstSeen: Number(base.firstSeen) || 0,
      lastSeen: Number(base.lastSeen) || 0,
      totalEvents: Number(base.totalEvents) || 0,
      blockedCount: Number(base.blockedCount) || 0,
      observedCount: Number(base.observedCount) || 0,
      uniqueThirdParties,
      kindBreakdown,
      topThirdParties,
      recentEvents,
    });
  } catch (err) {
    console.error("Failed to build /api/sites/:site from DB:", err);
    res.status(500).json({ ok: false, error: "site_query_failed" });
  }
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
