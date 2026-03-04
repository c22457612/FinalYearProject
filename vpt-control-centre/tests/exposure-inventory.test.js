const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { initDb } = require("../db");
const { deriveExposureInventory } = require("../exposure-inventory");

async function withTempDb(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpt-exposure-"));
  const dbPath = path.join(tempDir, "privacy.db");
  const dbCtx = await initDb({ filename: dbPath });
  try {
    return await run(dbCtx);
  } finally {
    await dbCtx.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function insertExposureEvent(dbCtx, { id, ts, site, vendor, requestUrl, mitigationStatus = "observed_only" }) {
  await dbCtx.run(
    `
      INSERT INTO events
        (event_id, ts, site, kind, mode, tab_id, source, top_level_url, raw_event)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      ts,
      site,
      "network.observed",
      "strict",
      null,
      "test",
      null,
      JSON.stringify({ id, ts, site, kind: "network.observed", data: { url: requestUrl, vendorId: vendor } }),
    ]
  );

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
      ts,
      "v2",
      "network",
      "network_request",
      "signal_detected",
      mitigationStatus,
      "tracking_signal",
      "test.exposure_inventory",
      1,
      vendor,
      vendor,
      null,
      "collect.example",
      requestUrl,
      site,
      1,
      null,
      "{}",
      id,
    ]
  );
}

test("site+vendor mode keeps row shape unchanged", async () => {
  await withTempDb(async (dbCtx) => {
    const now = Date.UTC(2026, 2, 4, 10, 0, 0);
    await insertExposureEvent(dbCtx, {
      id: "exp-site-1",
      ts: now,
      site: "alpha.local",
      vendor: "google",
      requestUrl: "https://collect.example/hit?gclid=abc123",
    });

    const inventory = await deriveExposureInventory(dbCtx, {
      site: "alpha.local",
      vendor: "google",
    });

    assert.equal(inventory.site, "alpha.local");
    assert.equal(inventory.vendor, "google");
    assert.equal(inventory.rows.length, 1);
    assert.deepEqual(
      Object.keys(inventory.rows[0]),
      [
        "site",
        "vendor_id",
        "data_category",
        "surface",
        "first_seen",
        "last_seen",
        "count",
        "confidence",
        "example_key",
        "evidence_event_ids",
        "evidence_levels",
      ]
    );
    assert.equal("top_sites" in inventory.rows[0], false);
  });
});

test("vendor-only mode aggregates rows across sites and exposes top_sites", async () => {
  await withTempDb(async (dbCtx) => {
    const now = Date.UTC(2026, 2, 4, 11, 0, 0);
    await insertExposureEvent(dbCtx, {
      id: "exp-all-1",
      ts: now,
      site: "alpha.local",
      vendor: "google",
      requestUrl: "https://collect.example/hit?gclid=one",
      mitigationStatus: "observed_only",
    });
    await insertExposureEvent(dbCtx, {
      id: "exp-all-2",
      ts: now + 30_000,
      site: "beta.local",
      vendor: "google",
      requestUrl: "https://collect.example/hit?gclid=two",
      mitigationStatus: "blocked",
    });

    const inventory = await deriveExposureInventory(dbCtx, { vendor: "google" });

    assert.equal(inventory.site, null);
    assert.equal(inventory.vendor, "google");
    assert.equal(inventory.rows.length, 1);
    assert.equal("top_sites" in inventory.rows[0], true);
    assert.equal(inventory.rows[0].site, null);
    assert.equal(inventory.rows[0].count, 2);
    assert.deepEqual(inventory.rows[0].top_sites, [
      { site: "alpha.local", count: 1 },
      { site: "beta.local", count: 1 },
    ]);
  });
});
