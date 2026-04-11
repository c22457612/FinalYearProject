const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { initDb } = require("../db");
const {
  DUMMY_SOURCE,
  SEEDED_EVENT_ID_PREFIX,
  SEEDED_SITES,
  buildScenarioEvents,
} = require("../scripts/site-visualizer-dummy-fixtures");
const {
  buildScenarioSummary,
  clearSeededData,
  insertEventsDirect,
} = require("../scripts/site-visualizer-dummy-helpers");

async function withTempDb(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpt-site-viz-seed-"));
  const dbPath = path.join(tempDir, "privacy.db");
  const dbCtx = await initDb({ filename: dbPath });
  try {
    return await run(dbCtx);
  } finally {
    await dbCtx.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

test("fixture builder returns the reserved sites and required signal mix", () => {
  const now = Date.UTC(2026, 3, 11, 12, 0, 0);
  const events = buildScenarioEvents(now);
  const sites = Array.from(new Set(events.map((event) => event.site))).sort();
  const apiSurfaceDetails = new Set(
    events
      .filter((event) => String(event.kind || "").startsWith("api."))
      .map((event) => String(event.data?.surfaceDetail || "").toLowerCase())
  );
  const networkKinds = new Set(
    events
      .filter((event) => String(event.kind || "").startsWith("network."))
      .map((event) => event.kind)
  );
  const summary = buildScenarioSummary(events);

  assert.deepEqual(sites, Array.from(SEEDED_SITES).sort());
  assert.equal(events.length >= 90 && events.length <= 110, true);
  assert.equal(networkKinds.has("network.observed"), true);
  assert.equal(networkKinds.has("network.blocked"), true);
  assert.equal(apiSurfaceDetails.has("canvas"), true);
  assert.equal(apiSurfaceDetails.has("webrtc"), true);
  assert.equal(apiSurfaceDetails.has("clipboard"), true);
  assert.equal(apiSurfaceDetails.has("geolocation"), true);
  assert.deepEqual(summary.surfaces, ["api", "cookies", "network"]);
});

test("fixture timestamps are relative to now with useful 24h and 7d spread", () => {
  const now = Date.UTC(2026, 3, 11, 12, 0, 0);
  const events = buildScenarioEvents(now);
  const within24h = events.filter((event) => now - event.ts <= 24 * 60 * 60 * 1000);
  const olderThan24h = events.filter((event) => now - event.ts > 24 * 60 * 60 * 1000);
  const within7d = events.filter((event) => now - event.ts <= 7 * 24 * 60 * 60 * 1000);

  assert.equal(events.every((event) => event.ts <= now), true);
  assert.equal(within24h.length >= Math.floor(events.length * 0.75), true);
  assert.equal(olderThan24h.length >= 8, true);
  assert.equal(within7d.length, events.length);
});

test("direct seed path writes events and enrichment rows with vendor-ready data", async () => {
  await withTempDb(async (dbCtx) => {
    const events = buildScenarioEvents(Date.UTC(2026, 3, 11, 12, 0, 0));
    const result = await insertEventsDirect(dbCtx, events);

    assert.equal(result.count, events.length);
    assert.equal(result.inserted, events.length);

    const eventCount = await dbCtx.get("SELECT COUNT(*) AS count FROM events WHERE source = ?", [DUMMY_SOURCE]);
    const enrichmentCount = await dbCtx.get(
      `
        SELECT COUNT(*) AS count
        FROM event_enrichment ee
        JOIN events e ON e.pk = ee.event_pk
        WHERE e.source = ?
      `,
      [DUMMY_SOURCE]
    );
    const apiRows = await dbCtx.get(
      `
        SELECT COUNT(*) AS count
        FROM event_enrichment ee
        JOIN events e ON e.pk = ee.event_pk
        WHERE e.source = ?
          AND ee.surface = 'api'
      `,
      [DUMMY_SOURCE]
    );
    const blockedRows = await dbCtx.get(
      `
        SELECT COUNT(*) AS count
        FROM event_enrichment ee
        JOIN events e ON e.pk = ee.event_pk
        WHERE e.source = ?
          AND ee.mitigation_status = 'blocked'
      `,
      [DUMMY_SOURCE]
    );
    const vendorRows = await dbCtx.get(
      `
        SELECT COUNT(*) AS count
        FROM event_enrichment ee
        JOIN events e ON e.pk = ee.event_pk
        WHERE e.source = ?
          AND ee.vendor_id IN ('google', 'meta', 'microsoft', 'outbrain', 'taboola', 'segment', 'mixpanel', 'amazon')
      `,
      [DUMMY_SOURCE]
    );

    assert.equal(Number(eventCount?.count) || 0, events.length);
    assert.equal(Number(enrichmentCount?.count) || 0, events.length);
    assert.equal(Number(apiRows?.count) > 0, true);
    assert.equal(Number(blockedRows?.count) > 0, true);
    assert.equal(Number(vendorRows?.count) > 0, true);
  });
});

test("clear helper removes only seeded rows and supports rerun-stable seeding", async () => {
  await withTempDb(async (dbCtx) => {
    const now = Date.UTC(2026, 3, 11, 12, 0, 0);
    const events = buildScenarioEvents(now);

    await dbCtx.run(
      `
        INSERT INTO events
          (event_id, ts, site, kind, mode, tab_id, source, top_level_url, raw_event)
        VALUES
          (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `,
      [
        "real-local-row-1",
        now,
        "real-user.example",
        "network.observed",
        "moderate",
        null,
        "extension",
        "https://real-user.example/",
        JSON.stringify({
          id: "real-local-row-1",
          ts: now,
          site: "real-user.example",
          kind: "network.observed",
          source: "extension",
          data: {
            url: "https://real-user.example/api",
            domain: "real-user.example",
            isThirdParty: false,
            resourceType: "fetch",
          },
        }),
      ]
    );

    const firstSeed = await insertEventsDirect(dbCtx, events);
    const firstCount = await dbCtx.get("SELECT COUNT(*) AS count FROM events WHERE source = ?", [DUMMY_SOURCE]);
    assert.equal(firstSeed.inserted, events.length);
    assert.equal(Number(firstCount?.count) || 0, events.length);

    const cleared = await clearSeededData(dbCtx);
    assert.equal(cleared.deleted, events.length);
    assert.equal(cleared.deleteChanges, events.length);
    assert.deepEqual(
      cleared.perSiteDeleted.map((row) => row.site).sort(),
      Array.from(SEEDED_SITES).sort()
    );

    const remainingSeeded = await dbCtx.get("SELECT COUNT(*) AS count FROM events WHERE source = ?", [DUMMY_SOURCE]);
    const remainingEnrichment = await dbCtx.get(
      `
        SELECT COUNT(*) AS count
        FROM event_enrichment ee
        JOIN events e ON e.pk = ee.event_pk
        WHERE e.source = ?
      `,
      [DUMMY_SOURCE]
    );
    const controlRow = await dbCtx.get("SELECT COUNT(*) AS count FROM events WHERE event_id = ?", ["real-local-row-1"]);
    assert.equal(Number(remainingSeeded?.count) || 0, 0);
    assert.equal(Number(remainingEnrichment?.count) || 0, 0);
    assert.equal(Number(controlRow?.count) || 0, 1);

    const secondSeed = await insertEventsDirect(dbCtx, events);
    const secondCount = await dbCtx.get("SELECT COUNT(*) AS count FROM events WHERE source = ?", [DUMMY_SOURCE]);
    assert.equal(secondSeed.inserted, events.length);
    assert.equal(Number(secondCount?.count) || 0, events.length);
  });
});

test("seed identifiers stay within the dedicated bounded cleanup namespace", () => {
  const events = buildScenarioEvents(Date.UTC(2026, 3, 11, 12, 0, 0));

  for (const event of events) {
    assert.equal(String(event.source), DUMMY_SOURCE);
    assert.equal(String(event.id).startsWith(SEEDED_EVENT_ID_PREFIX), true);
    assert.equal(SEEDED_SITES.includes(event.site), true);
  }
});
