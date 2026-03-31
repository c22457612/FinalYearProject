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

function makeExpiry(daysFromNow) {
  return Math.floor((Date.now() + (daysFromNow * 86400000)) / 1000);
}

function buildScenarioEvents() {
  const ts = Date.now();

  return [
    {
      id: "dummy-seed-cookies-demo-shop",
      ts,
      source: DUMMY_SOURCE,
      site: "shop.demo.local",
      kind: "cookies.snapshot",
      mode: "moderate",
      data: {
        url: "https://shop.demo.local/",
        siteBase: "shop.demo.local",
        count: 5,
        thirdPartyCount: 2,
        cookies: [
          {
            name: "__Host-session",
            domain: "shop.demo.local",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            session: true,
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "currency_pref",
            domain: "shop.demo.local",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            session: false,
            expiry: makeExpiry(120),
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "_ga",
            domain: "shop.demo.local",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            session: false,
            expiry: makeExpiry(365),
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "_fbp",
            domain: ".facebook.com",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "no_restriction",
            session: false,
            expiry: makeExpiry(90),
            hostOnly: false,
            isThirdParty: true,
          },
          {
            name: "stripe_mid",
            domain: ".stripe.com",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "no_restriction",
            session: false,
            expiry: makeExpiry(365),
            hostOnly: false,
            isThirdParty: true,
          },
        ],
      },
    },
    {
      id: "dummy-seed-cookies-demo-news",
      ts: ts + 1000,
      source: DUMMY_SOURCE,
      site: "news.demo.local",
      kind: "cookies.snapshot",
      mode: "moderate",
      data: {
        url: "https://news.demo.local/",
        siteBase: "news.demo.local",
        count: 4,
        thirdPartyCount: 1,
        cookies: [
          {
            name: "consent_status",
            domain: "news.demo.local",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            session: false,
            expiry: makeExpiry(180),
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "csrftoken",
            domain: "news.demo.local",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "strict",
            session: false,
            expiry: makeExpiry(30),
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "_chartbeat2",
            domain: "news.demo.local",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            session: false,
            expiry: makeExpiry(180),
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "outbrain_click_id",
            domain: ".outbrain.com",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "no_restriction",
            session: false,
            expiry: makeExpiry(30),
            hostOnly: false,
            isThirdParty: true,
          },
        ],
      },
    },
    {
      id: "dummy-seed-cookies-demo-video",
      ts: ts + 2000,
      source: DUMMY_SOURCE,
      site: "video.demo.local",
      kind: "cookies.snapshot",
      mode: "moderate",
      data: {
        url: "https://video.demo.local/",
        siteBase: "video.demo.local",
        count: 4,
        thirdPartyCount: 2,
        cookies: [
          {
            name: "remember_me",
            domain: "video.demo.local",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            session: false,
            expiry: makeExpiry(14),
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "theme_pref",
            domain: "video.demo.local",
            path: "/",
            secure: false,
            httpOnly: false,
            sameSite: "lax",
            session: false,
            expiry: makeExpiry(365),
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "youtube_embed_state",
            domain: ".youtube.com",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "no_restriction",
            session: false,
            expiry: makeExpiry(180),
            hostOnly: false,
            isThirdParty: true,
          },
          {
            name: "intercom-session-demo",
            domain: ".intercom.io",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "no_restriction",
            session: false,
            expiry: makeExpiry(7),
            hostOnly: false,
            isThirdParty: true,
          },
        ],
      },
    },
    {
      id: "dummy-seed-cookies-demo-forum",
      ts: ts + 3000,
      source: DUMMY_SOURCE,
      site: "forum.demo.local",
      kind: "cookies.snapshot",
      mode: "moderate",
      data: {
        url: "https://forum.demo.local/",
        siteBase: "forum.demo.local",
        count: 3,
        thirdPartyCount: 0,
        cookies: [
          {
            name: "php_sessionid",
            domain: "forum.demo.local",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            session: true,
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "locale",
            domain: "forum.demo.local",
            path: "/",
            secure: false,
            httpOnly: false,
            sameSite: "lax",
            session: false,
            expiry: makeExpiry(180),
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "visitor_token",
            domain: "forum.demo.local",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            session: false,
            expiry: makeExpiry(30),
            hostOnly: true,
            isThirdParty: false,
          },
        ],
      },
    },
    {
      id: "dummy-seed-cookies-demo-social",
      ts: ts + 4000,
      source: DUMMY_SOURCE,
      site: "social.demo.local",
      kind: "cookies.snapshot",
      mode: "moderate",
      data: {
        url: "https://social.demo.local/",
        siteBase: "social.demo.local",
        count: 6,
        thirdPartyCount: 3,
        cookies: [
          {
            name: "auth_token",
            domain: "social.demo.local",
            path: "/",
            secure: true,
            httpOnly: true,
            sameSite: "lax",
            session: true,
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "site_preferences",
            domain: "social.demo.local",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            session: false,
            expiry: makeExpiry(365),
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "_pk_id.7.abcd",
            domain: "social.demo.local",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "lax",
            session: false,
            expiry: makeExpiry(730),
            hostOnly: true,
            isThirdParty: false,
          },
          {
            name: "doubleclick_id",
            domain: ".doubleclick.net",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "no_restriction",
            session: false,
            expiry: makeExpiry(60),
            hostOnly: false,
            isThirdParty: true,
          },
          {
            name: "hubspotutk",
            domain: ".hubspot.com",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "no_restriction",
            session: false,
            expiry: makeExpiry(180),
            hostOnly: false,
            isThirdParty: true,
          },
          {
            name: "video_embed_id",
            domain: ".vimeo.com",
            path: "/",
            secure: true,
            httpOnly: false,
            sameSite: "no_restriction",
            session: false,
            expiry: makeExpiry(90),
            hostOnly: false,
            isThirdParty: true,
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
    console.error("Failed to seed demo cookie test data:", error);
    process.exit(1);
  });
}

module.exports = {
  DUMMY_SOURCE,
  buildScenarioEvents,
  parseArgs,
};
