#!/usr/bin/env node

const { initDb } = require("../db");
const { buildEnrichmentRecord } = require("../enrichment");

function parseArgs(argv) {
  const args = {
    force: false,
    dryRun: false,
    limit: null,
  };

  for (const token of argv) {
    if (token === "--force") args.force = true;
    else if (token === "--dry-run") args.dryRun = true;
    else if (token.startsWith("--limit=")) {
      const raw = Number(token.slice("--limit=".length));
      if (Number.isFinite(raw) && raw > 0) args.limit = Math.floor(raw);
    }
  }

  return args;
}

function toEventShape(row) {
  let ev;
  try {
    ev = JSON.parse(row.raw_event);
  } catch {
    return null;
  }

  if (!ev || typeof ev !== "object") return null;

  if (!ev.id) ev.id = row.event_id;
  if (!ev.ts) ev.ts = Number(row.ts) || Date.now();
  if (!ev.site) ev.site = row.site || ev.data?.siteBase || "unknown";

  return ev;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const dbCtx = await initDb();

  try {
    const params = [];
    const where = args.force ? "" : "WHERE ee.event_pk IS NULL";
    const limitClause = args.limit ? "LIMIT ?" : "";
    if (args.limit) params.push(args.limit);

    const rows = await dbCtx.all(
      `
        SELECT
          e.pk,
          e.event_id,
          e.ts,
          e.site,
          e.raw_event
        FROM events e
        LEFT JOIN event_enrichment ee ON ee.event_pk = e.pk
        ${where}
        ORDER BY e.pk ASC
        ${limitClause}
      `,
      params
    );

    let scanned = 0;
    let upserted = 0;
    let parseErrors = 0;
    let skipped = 0;

    for (const row of rows) {
      scanned += 1;

      const ev = toEventShape(row);
      if (!ev) {
        parseErrors += 1;
        continue;
      }

      const site = ev.site || row.site || ev.data?.siteBase || "unknown";
      const enrich = buildEnrichmentRecord(ev, site);
      if (!enrich) {
        skipped += 1;
        continue;
      }

      if (!args.dryRun) {
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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(event_pk) DO UPDATE SET
              event_id = excluded.event_id,
              enriched_ts = excluded.enriched_ts,
              enrichment_version = excluded.enrichment_version,
              surface = excluded.surface,
              surface_detail = excluded.surface_detail,
              privacy_status = excluded.privacy_status,
              mitigation_status = excluded.mitigation_status,
              signal_type = excluded.signal_type,
              pattern_id = excluded.pattern_id,
              confidence = excluded.confidence,
              vendor_id = excluded.vendor_id,
              vendor_name = excluded.vendor_name,
              vendor_family = excluded.vendor_family,
              request_domain = excluded.request_domain,
              request_url = excluded.request_url,
              first_party_site = excluded.first_party_site,
              is_third_party = excluded.is_third_party,
              rule_id = excluded.rule_id,
              raw_context = excluded.raw_context
          `,
          [
            row.pk,
            row.event_id,
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
          ]
        );
      }

      upserted += 1;
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          force: args.force,
          dryRun: args.dryRun,
          scanned,
          upserted,
          skipped,
          parseErrors,
        },
        null,
        2
      )
    );
  } finally {
    await dbCtx.close();
  }
}

run().catch((err) => {
  console.error("Backfill failed:", err);
  process.exit(1);
});
