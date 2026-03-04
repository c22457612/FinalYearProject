const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");

const { initDb } = require("../db");
const { getVendorVaultSummary } = require("../vendor-vault-summary");

async function withTempDb(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpt-vault-summary-"));
  const dbPath = path.join(tempDir, "privacy.db");
  const dbCtx = await initDb({ filename: dbPath });
  try {
    return await run(dbCtx);
  } finally {
    await dbCtx.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function insertEnrichedEvent(dbCtx, {
  id,
  ts,
  site,
  vendor,
  domain,
  requestUrl,
  mitigationStatus = "observed_only",
  signalType = "tracking_signal",
  privacyStatus = "signal_detected",
}) {
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
      JSON.stringify({ id, ts, site, kind: "network.observed", data: { url: requestUrl, domain, vendorId: vendor } }),
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
      privacyStatus,
      mitigationStatus,
      signalType,
      "test.vendor_vault_summary",
      1,
      vendor,
      vendor,
      null,
      domain,
      requestUrl,
      site,
      1,
      null,
      "{}",
      id,
    ]
  );
}

test("site scope summary includes activity, domains, keys and risk breakdowns", async () => {
  await withTempDb(async (dbCtx) => {
    const t0 = Date.UTC(2026, 2, 4, 8, 0, 0);
    await insertEnrichedEvent(dbCtx, {
      id: "vault-site-1",
      ts: t0,
      site: "alpha.example.com",
      vendor: "google",
      domain: "a.example.net",
      requestUrl: "https://a.example.net/collect?gclid=one&cid=one",
      mitigationStatus: "observed_only",
      signalType: "tracking_signal",
      privacyStatus: "signal_detected",
    });
    await insertEnrichedEvent(dbCtx, {
      id: "vault-site-2",
      ts: t0 + 30_000,
      site: "alpha.example.com",
      vendor: "google",
      domain: "b.example.net",
      requestUrl: "https://b.example.net/pixel?cid=two&id=xyz",
      mitigationStatus: "blocked",
      signalType: "tracking_signal",
      privacyStatus: "policy_blocked",
    });
    await insertEnrichedEvent(dbCtx, {
      id: "vault-site-3",
      ts: t0 + 60_000,
      site: "alpha.example.com",
      vendor: "google",
      domain: "a.example.net",
      requestUrl: "https://a.example.net/collect?gclid=three",
      mitigationStatus: "allowed",
      signalType: "device_probe",
      privacyStatus: "policy_allowed",
    });
    await insertEnrichedEvent(dbCtx, {
      id: "vault-other-vendor",
      ts: t0 + 90_000,
      site: "alpha.example.com",
      vendor: "meta",
      domain: "c.example.net",
      requestUrl: "https://c.example.net/pixel?fbp=abc",
      mitigationStatus: "observed_only",
      signalType: "tracking_signal",
      privacyStatus: "signal_detected",
    });

    const summary = await getVendorVaultSummary(dbCtx, {
      site: "alpha.example.com",
      vendor: "google",
    });

    assert.equal(summary.site, "alpha.example.com");
    assert.equal(summary.vendor, "google");

    assert.equal(summary.activity_summary.total_events, 3);
    assert.equal(summary.activity_summary.observed_count, 2);
    assert.equal(summary.activity_summary.blocked_count, 1);
    assert.equal(summary.activity_summary.first_seen, t0);
    assert.equal(summary.activity_summary.last_seen, t0 + 60_000);

    assert.equal(summary.domains_used.domain_count_total, 2);
    assert.deepEqual(summary.domains_used.top_domains, [
      { domain: "a.example.net", count: 2 },
      { domain: "b.example.net", count: 1 },
    ]);

    assert.equal(summary.observed_parameter_keys.key_count_total, 3);
    assert.deepEqual(summary.observed_parameter_keys.top_keys, [
      { key: "cid", count: 2 },
      { key: "gclid", count: 2 },
      { key: "id", count: 1 },
    ]);

    assert.deepEqual(summary.risk_summary.mitigation_status_counts, {
      allowed: 1,
      blocked: 1,
      observed_only: 1,
    });
    assert.deepEqual(summary.risk_summary.signal_type_counts, {
      tracking_signal: 2,
      device_probe: 1,
    });
    assert.deepEqual(summary.risk_summary.privacy_status_counts, {
      policy_allowed: 1,
      policy_blocked: 1,
      signal_detected: 1,
    });
  });
});

test("vendor-only scope aggregates across sites and returns empty-safe summary", async () => {
  await withTempDb(async (dbCtx) => {
    const t0 = Date.UTC(2026, 2, 4, 9, 0, 0);
    await insertEnrichedEvent(dbCtx, {
      id: "vault-all-1",
      ts: t0,
      site: "alpha.example.com",
      vendor: "google",
      domain: "a.example.net",
      requestUrl: "https://a.example.net/collect?gclid=one",
      mitigationStatus: "observed_only",
    });
    await insertEnrichedEvent(dbCtx, {
      id: "vault-all-2",
      ts: t0 + 20_000,
      site: "beta.example.com",
      vendor: "google",
      domain: "z.example.net",
      requestUrl: "https://z.example.net/collect?uid=abc",
      mitigationStatus: "modified",
      signalType: "capability_probe",
      privacyStatus: "high_risk",
    });

    const summary = await getVendorVaultSummary(dbCtx, {
      vendor: "google",
    });

    assert.equal(summary.site, null);
    assert.equal(summary.vendor, "google");
    assert.equal(summary.activity_summary.total_events, 2);
    assert.equal(summary.domains_used.domain_count_total, 2);
    assert.equal(summary.observed_parameter_keys.key_count_total, 2);
    assert.equal(summary.risk_summary.mitigation_status_counts.modified, 1);

    const empty = await getVendorVaultSummary(dbCtx, {
      site: "gamma.example.com",
      vendor: "google",
    });
    assert.equal(empty.activity_summary.total_events, 0);
    assert.equal(empty.activity_summary.first_seen, null);
    assert.equal(empty.activity_summary.last_seen, null);
    assert.equal(empty.domains_used.domain_count_total, 0);
    assert.deepEqual(empty.domains_used.top_domains, []);
    assert.equal(empty.observed_parameter_keys.key_count_total, 0);
    assert.deepEqual(empty.observed_parameter_keys.top_keys, []);
    assert.deepEqual(empty.risk_summary, {});
  });
});
