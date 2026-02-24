const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { initDb } = require("../db");
const { buildEnrichmentRecord } = require("../enrichment");
const { getAnalyticsSnapshot } = require("../analytics");

async function withTempDb(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpt-analytics-"));
  const dbPath = path.join(tempDir, "privacy.db");
  const dbCtx = await initDb({ filename: dbPath });
  try {
    return await run(dbCtx);
  } finally {
    await dbCtx.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function insertEvent(dbCtx, ev) {
  const site = ev.site || ev.data?.siteBase || "unknown";

  await dbCtx.run(
    `
      INSERT INTO events
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
      ev.source || "test",
      ev.topLevelUrl || null,
      JSON.stringify({ ...ev, site }),
    ]
  );

  const enrich = buildEnrichmentRecord(ev, site);
  await dbCtx.run(
    `
      INSERT INTO event_enrichment (
        event_pk,
        event_id,
        enriched_ts,
        enrichment_version,
        surface,
        surface_detail,
        privacy_status,
        mitigation_status,
        signal_type,
        pattern_id,
        confidence,
        vendor_id,
        vendor_name,
        vendor_family,
        request_domain,
        request_url,
        first_party_site,
        is_third_party,
        rule_id,
        raw_context
      )
      SELECT
        pk,
        event_id,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      FROM events
      WHERE event_id = ?
    `,
    [
      enrich.enrichedTs,
      enrich.enrichmentVersion,
      enrich.surface,
      enrich.surfaceDetail,
      enrich.privacyStatus,
      enrich.mitigationStatus,
      enrich.signalType,
      enrich.patternId,
      enrich.confidence,
      enrich.vendorId,
      enrich.vendorName,
      enrich.vendorFamily,
      enrich.requestDomain,
      enrich.requestUrl,
      enrich.firstPartySite,
      enrich.isThirdParty,
      enrich.ruleId,
      enrich.rawContext,
      ev.id,
    ]
  );
}

test("analytics snapshot includes per-day, per-vendor, per-site and party split aggregates", async () => {
  await withTempDb(async (dbCtx) => {
    const t0 = Date.UTC(2026, 1, 20, 10, 0, 0);
    const dayMs = 24 * 60 * 60 * 1000;

    const seed = [
      {
        id: "a1",
        ts: t0,
        site: "alpha.example.com",
        kind: "network.observed",
        tabId: 1,
        source: "test",
        data: {
          sessionId: "sess-a",
          domain: "alpha.example.com",
          url: "https://alpha.example.com/app.js",
          isThirdParty: false,
          resourceType: "script",
        },
      },
      {
        id: "a2",
        ts: t0 + 60_000,
        site: "alpha.example.com",
        kind: "network.blocked",
        tabId: 1,
        source: "test",
        data: {
          sessionId: "sess-a",
          domain: "doubleclick.net",
          url: "https://doubleclick.net/pixel",
          isThirdParty: true,
          resourceType: "image",
          ruleId: 1010,
        },
      },
      {
        id: "a3",
        ts: t0 + 120_000,
        site: "alpha.example.com",
        kind: "network.observed",
        tabId: 2,
        source: "test",
        data: {
          domain: "doubleclick.net",
          url: "https://doubleclick.net/collect",
          isThirdParty: true,
          resourceType: "xmlhttprequest",
        },
      },
      {
        id: "a4",
        ts: t0 + dayMs + 30_000,
        site: "alpha.example.com",
        kind: "cookies.snapshot",
        source: "test",
        data: {
          count: 7,
          thirdPartyCount: 2,
          cookies: [
            { name: "n", domain: ".alpha.example.com", isThirdParty: false },
            { name: "d", domain: ".doubleclick.net", isThirdParty: true },
          ],
        },
      },
      {
        id: "b1",
        ts: t0 + 180_000,
        site: "beta.example.com",
        kind: "network.observed",
        tabId: 3,
        source: "test",
        data: {
          domain: "beta.example.com",
          url: "https://beta.example.com/app.js",
          isThirdParty: false,
          resourceType: "script",
        },
      },
    ];

    for (const ev of seed) {
      await insertEvent(dbCtx, ev);
    }

    const snapshot = await getAnalyticsSnapshot(dbCtx, {
      from: t0 - 1000,
      to: t0 + dayMs + 120_000,
      topVendors: 10,
      topSites: 10,
      sessionLimit: 10,
    });

    assert.equal(snapshot.site, null);
    assert.equal(snapshot.dailyPrivacyMitigation.length > 0, true);
    assert.equal(snapshot.partySplitByDay.length, 2);

    const firstDay = snapshot.partySplitByDay[0];
    assert.equal(firstDay.firstParty, 2);
    assert.equal(firstDay.thirdParty, 2);

    const google = snapshot.vendorTotals.find((v) => v.vendorId === "google");
    assert.ok(google);
    assert.equal(google.totalEvents, 3);
    assert.equal(google.detectedSignals, 3);
    assert.equal(google.detectedSignalRate, 1);

    const alphaSite = snapshot.siteTotals.find((s) => s.site === "alpha.example.com");
    const betaSite = snapshot.siteTotals.find((s) => s.site === "beta.example.com");
    assert.ok(alphaSite);
    assert.ok(betaSite);
    assert.equal(alphaSite.totalEvents, 4);
    assert.equal(betaSite.totalEvents, 1);
  });
});

test("analytics session metrics include time-to-first-detected-signal when session fields exist", async () => {
  await withTempDb(async (dbCtx) => {
    const t0 = Date.UTC(2026, 1, 21, 9, 0, 0);

    const seed = [
      {
        id: "s1-e1",
        ts: t0,
        site: "alpha.example.com",
        kind: "network.observed",
        tabId: 10,
        source: "test",
        data: {
          sessionId: "session-alpha",
          domain: "alpha.example.com",
          url: "https://alpha.example.com/home",
          isThirdParty: false,
        },
      },
      {
        id: "s1-e2",
        ts: t0 + 45_000,
        site: "alpha.example.com",
        kind: "network.blocked",
        tabId: 10,
        source: "test",
        data: {
          sessionId: "session-alpha",
          domain: "doubleclick.net",
          url: "https://doubleclick.net/pixel",
          isThirdParty: true,
          ruleId: 9001,
        },
      },
      {
        id: "s2-e1",
        ts: t0 + 90_000,
        site: "alpha.example.com",
        kind: "network.observed",
        tabId: 22,
        source: "test",
        data: {
          domain: "doubleclick.net",
          url: "https://doubleclick.net/collect",
          isThirdParty: true,
        },
      },
    ];

    for (const ev of seed) {
      await insertEvent(dbCtx, ev);
    }

    const snapshot = await getAnalyticsSnapshot(dbCtx, {
      site: "alpha.example.com",
      from: t0 - 1000,
      to: t0 + 120_000,
      sessionLimit: 10,
    });

    const byKey = new Map(snapshot.sessions.map((s) => [s.sessionKey, s]));
    const explicit = byKey.get("session-alpha");
    const tabSession = byKey.get("tab:22");

    assert.ok(explicit);
    assert.ok(tabSession);
    assert.equal(explicit.eventCount, 2);
    assert.equal(explicit.timeToFirstDetectedSignalMs, 45_000);
    assert.equal(tabSession.timeToFirstDetectedSignalMs, 0);
  });
});
