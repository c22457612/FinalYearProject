#!/usr/bin/env node

const { initDb } = require("../db");
const { buildEnrichmentRecord } = require("../enrichment");
const { upsertEnrichmentRow } = require("./backfill-enrichment");

const DEFAULT_BASE_URL = "http://127.0.0.1:4141";
const DUMMY_SOURCE = "dummy-seed";

function parseArgs(argv) {
  const args = {
    baseUrl: DEFAULT_BASE_URL,
  };

  for (const token of argv) {
    if (token.startsWith("--base-url=")) {
      const value = token.slice("--base-url=".length).trim();
      if (value) args.baseUrl = value.replace(/\/+$/, "");
    }
  }

  return args;
}

function buildScenarioEvents() {
  const ts = Date.now();

  return [
    {
      id: "dummy-seed-cookies-polish-2-social-snapshot",
      ts,
      source: DUMMY_SOURCE,
      site: "social.example.com",
      kind: "cookies.snapshot",
      mode: "moderate",
      data: {
        url: "https://social.example.com/",
        siteBase: "social.example.com",
        count: 34,
        thirdPartyCount: 0,
        cookies: [],
      },
    },
    {
      id: "dummy-seed-cookies-polish-2-matomo-snapshot",
      ts: ts + 1000,
      source: DUMMY_SOURCE,
      site: "matomo.org",
      kind: "cookies.snapshot",
      mode: "moderate",
      data: {
        url: "https://matomo.org/",
        siteBase: "matomo.org",
        count: 1,
        thirdPartyCount: 0,
        cookies: [
          {
            name: "_pk_id.12.f8e6",
            domain: "matomo.org",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "no_restriction",
            session: false,
            expiry: 1803597840,
            hostOnly: true,
            isThirdParty: false,
          },
        ],
      },
    },
  ];
}

async function postEvents(baseUrl, events) {
  const response = await fetch(`${baseUrl}/api/events`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify(events),
  });

  const text = await response.text();
  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${typeof data === "string" ? data : JSON.stringify(data)}`);
  }

  return data;
}

async function insertEventsDirect(events) {
  const dbCtx = await initDb();

  try {
    let inserted = 0;

    for (const ev of events) {
      const site = ev.site || ev.data?.siteBase || "unknown";

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
          ev.source || DUMMY_SOURCE,
          ev.topLevelUrl || null,
          JSON.stringify({ ...ev, site }),
        ]
      );

      const row = await dbCtx.get(
        `
          SELECT pk, event_id, ts, site, raw_event
          FROM events
          WHERE event_id = ?
        `,
        [ev.id]
      );

      if (!row) {
        throw new Error(`seed_insert_missing_row:${ev.id}`);
      }

      const enrich = buildEnrichmentRecord({ ...ev, site }, site);
      await upsertEnrichmentRow(dbCtx, row, enrich);
      inserted += 1;
    }

    return {
      ok: true,
      count: events.length,
      inserted,
      mode: "db-direct",
    };
  } finally {
    await dbCtx.close();
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const events = buildScenarioEvents();
  let result;
  let mode = "api";

  try {
    result = await postEvents(args.baseUrl, events);
  } catch (error) {
    result = await insertEventsDirect(events);
    mode = "db-direct";
    console.warn(`API seed failed; wrote directly to SQLite instead: ${error.message || error}`);
  }

  console.log(JSON.stringify({
    ok: true,
    baseUrl: args.baseUrl,
    mode,
    source: DUMMY_SOURCE,
    seededSites: events.map((event) => event.site),
    result,
  }, null, 2));
}

if (require.main === module) {
  run().catch((error) => {
    console.error("Failed to seed COOKIES-POLISH-2 test data:", error);
    process.exit(1);
  });
}

module.exports = {
  DUMMY_SOURCE,
  buildScenarioEvents,
  parseArgs,
};
