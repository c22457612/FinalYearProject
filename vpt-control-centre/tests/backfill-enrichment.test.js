const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { initDb } = require("../db");
const { buildEnrichmentRecord } = require("../enrichment");
const { upsertEnrichmentRow } = require("../scripts/backfill-enrichment");

test("backfill upgrades legacy event_enrichment schema before inserting API rows", async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpt-backfill-legacy-"));
  const dbPath = path.join(tempDir, "privacy.db");

  try {
    const dbCtx = await initDb({ filename: dbPath });
    try {
      await dbCtx.exec("DROP TABLE event_enrichment");
      await dbCtx.exec(`
        CREATE TABLE event_enrichment (
          pk INTEGER PRIMARY KEY AUTOINCREMENT,
          event_pk INTEGER NOT NULL UNIQUE,
          event_id TEXT NOT NULL UNIQUE,
          enriched_ts INTEGER NOT NULL,
          enrichment_version TEXT NOT NULL DEFAULT 'v1',
          surface TEXT NOT NULL CHECK (surface IN ('network', 'cookies', 'storage', 'browser_api', 'script', 'unknown')),
          surface_detail TEXT NOT NULL CHECK (
            surface_detail IN (
              'network_request',
              'cookie_snapshot',
              'cookie_operation',
              'local_storage',
              'session_storage',
              'indexeddb',
              'cache_api',
              'canvas',
              'webgl',
              'webrtc',
              'audiocontext',
              'script_execution',
              'unknown'
            )
          ),
          privacy_status TEXT NOT NULL CHECK (
            privacy_status IN (
              'baseline',
              'signal_detected',
              'high_risk',
              'policy_blocked',
              'policy_allowed',
              'unknown'
            )
          ),
          mitigation_status TEXT NOT NULL CHECK (
            mitigation_status IN (
              'allowed',
              'blocked',
              'observed_only',
              'modified',
              'unknown'
            )
          ),
          signal_type TEXT NOT NULL CHECK (
            signal_type IN (
              'fingerprinting_signal',
              'tracking_signal',
              'device_probe',
              'capability_probe',
              'state_change',
              'unknown'
            )
          ),
          pattern_id TEXT,
          confidence REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
          vendor_id TEXT,
          vendor_name TEXT,
          vendor_family TEXT,
          request_domain TEXT,
          request_url TEXT,
          first_party_site TEXT,
          is_third_party INTEGER CHECK (is_third_party IS NULL OR is_third_party IN (0, 1)),
          rule_id TEXT,
          raw_context TEXT,
          FOREIGN KEY(event_pk) REFERENCES events(pk) ON DELETE CASCADE
        )
      `);

      const event = {
        id: "legacy-backfill-api-1",
        ts: Date.UTC(2026, 2, 14, 16, 45, 0),
        source: "test-extension",
        site: "legacy.example",
        kind: "api.webrtc.activity",
        mode: "moderate",
        data: {
          action: "ice_candidate_activity",
          state: "candidate",
          candidateType: "srflx",
          stunTurnHostnames: ["stun.l.google.com"],
          count: 1,
          burstMs: 0,
          sampleWindowMs: 1200,
        },
      };

      await dbCtx.run(
        `
          INSERT INTO events (
            event_id,
            ts,
            site,
            kind,
            mode,
            source,
            raw_event
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
        [event.id, event.ts, event.site, event.kind, event.mode, event.source, JSON.stringify(event)]
      );
    } finally {
      await dbCtx.close();
    }

    const verifyDb = await initDb({ filename: dbPath });
    try {
      const rawRow = await verifyDb.get(
        `
          SELECT pk, event_id, site, raw_event
          FROM events
          WHERE event_id = ?
        `,
        ["legacy-backfill-api-1"]
      );
      assert.ok(rawRow, "Expected legacy API event to exist before backfill upsert");

      const event = JSON.parse(rawRow.raw_event);
      const enrich = buildEnrichmentRecord(event, rawRow.site);
      assert.ok(enrich, "Expected API event to produce enrichment");

      await upsertEnrichmentRow(verifyDb, rawRow, enrich);

      const row = await verifyDb.get(
        `
          SELECT surface, surface_detail AS surfaceDetail, signal_type AS signalType, pattern_id AS patternId, confidence
          FROM event_enrichment
          WHERE event_id = ?
        `,
        ["legacy-backfill-api-1"]
      );

      assert.ok(row, "Expected legacy backfill to create an event_enrichment row");
      assert.equal(row.surface, "api");
      assert.equal(row.surfaceDetail, "webrtc");
      assert.equal(row.signalType, "device_probe");
      assert.equal(row.patternId, "api.webrtc.stun_turn_assisted_probe");
      assert.equal(row.confidence, 0.96);
    } finally {
      await verifyDb.close();
    }
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
