const { classifyExposureKey, normalizeKeyName } = require("./exposure-taxonomy");

const DEFAULT_EVIDENCE_IDS_LIMIT = 8;
const DEFAULT_BASE_CONFIDENCE = 0.5;

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  if (n <= 0) return 0;
  if (n >= 1) return 1;
  return n;
}

function normalizeVendorId(vendorId) {
  const value = String(vendorId || "").trim();
  return value || "unknown";
}

function toBaseConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_BASE_CONFIDENCE;
  return clamp01(n);
}

function mapMitigationToEvidenceLevel(mitigationStatus) {
  if (mitigationStatus === "blocked") return "attempted";
  if (mitigationStatus === "allowed" || mitigationStatus === "observed_only") return "observed";
  return "unknown";
}

function extractQueryParamNames(requestUrl) {
  const raw = String(requestUrl || "").trim();
  if (!raw || !raw.includes("?")) return [];

  const uniqueNames = new Set();
  const addFromParams = (params) => {
    for (const [name] of params.entries()) {
      const cleaned = String(name || "").trim();
      if (cleaned) uniqueNames.add(cleaned);
    }
  };

  try {
    addFromParams(new URL(raw).searchParams);
    return Array.from(uniqueNames);
  } catch {
    // Continue with best-effort parsing.
  }

  try {
    addFromParams(new URL(raw, "http://local.invalid").searchParams);
    return Array.from(uniqueNames);
  } catch {
    // Continue with manual query extraction.
  }

  const query = raw.split("?")[1] || "";
  const cleanQuery = query.split("#")[0];
  addFromParams(new URLSearchParams(cleanQuery));
  return Array.from(uniqueNames);
}

function selectExampleKey(keyCounts) {
  let bestKey = "";
  let bestCount = -1;
  for (const [normalized, value] of keyCounts.entries()) {
    if (value.count > bestCount) {
      bestKey = value.example_key || normalized;
      bestCount = value.count;
      continue;
    }
    if (value.count === bestCount && (value.example_key || normalized) < bestKey) {
      bestKey = value.example_key || normalized;
    }
  }
  return bestKey;
}

async function deriveExposureInventory(dbCtx, opts = {}) {
  const site = String(opts.site || "").trim();
  if (!site) {
    const err = new Error("site_required");
    err.code = "site_required";
    throw err;
  }

  const vendor = String(opts.vendor || "").trim() || null;
  const evidenceIdsLimit = Math.max(
    1,
    Math.min(50, Math.floor(Number(opts.evidenceIdsLimit) || DEFAULT_EVIDENCE_IDS_LIMIT))
  );

  const sourceRows = await dbCtx.all(
    `
      SELECT
        event_id,
        enriched_ts,
        confidence,
        surface,
        surface_detail,
        mitigation_status,
        COALESCE(NULLIF(vendor_id, ''), 'unknown') AS vendor_id,
        request_url
      FROM event_enrichment
      WHERE first_party_site = ?
        AND (? IS NULL OR COALESCE(NULLIF(vendor_id, ''), 'unknown') = ?)
        AND surface_detail = 'network_request'
        AND request_url IS NOT NULL
        AND request_url != ''
      ORDER BY enriched_ts ASC
    `,
    [site, vendor, vendor]
  );

  const aggregates = new Map();

  for (const row of sourceRows) {
    const eventId = String(row.event_id || "").trim();
    const surface = String(row.surface || "unknown").trim() || "unknown";
    const vendorId = normalizeVendorId(row.vendor_id);
    const ts = Number(row.enriched_ts);
    const safeTs = Number.isFinite(ts) ? ts : 0;
    const evidenceLevel = mapMitigationToEvidenceLevel(row.mitigation_status);
    const baseConfidence = toBaseConfidence(row.confidence);

    const keyNames = extractQueryParamNames(row.request_url);
    if (!keyNames.length) continue;

    // Prevent an event with many keys in one category from over-counting.
    const perEventContributions = new Map();

    for (const keyName of keyNames) {
      const match = classifyExposureKey(surface, keyName);
      if (!match) continue;

      const normalizedKey = normalizeKeyName(keyName).toLowerCase();
      if (!normalizedKey) continue;

      const aggregateKey = [
        site,
        vendorId,
        match.data_category,
        surface,
      ].join("::");

      const existing = perEventContributions.get(aggregateKey);
      if (!existing || match.key_confidence > existing.key_confidence) {
        perEventContributions.set(aggregateKey, {
          site,
          vendor_id: vendorId,
          data_category: match.data_category,
          surface,
          key_confidence: match.key_confidence,
          example_key: keyName,
          normalized_key: normalizedKey,
        });
      }
    }

    for (const [aggregateKey, contribution] of perEventContributions.entries()) {
      let agg = aggregates.get(aggregateKey);
      if (!agg) {
        agg = {
          site: contribution.site,
          vendor_id: contribution.vendor_id,
          data_category: contribution.data_category,
          surface: contribution.surface,
          first_seen: null,
          last_seen: null,
          count: 0,
          confidence_sum: 0,
          key_counts: new Map(),
          evidence_event_ids: [],
          evidence_event_id_set: new Set(),
          evidence_levels: {
            observed: 0,
            attempted: 0,
            unknown: 0,
          },
        };
        aggregates.set(aggregateKey, agg);
      }

      if (agg.first_seen == null || safeTs < agg.first_seen) agg.first_seen = safeTs;
      if (agg.last_seen == null || safeTs > agg.last_seen) agg.last_seen = safeTs;
      agg.count += 1;
      agg.confidence_sum += clamp01(baseConfidence * contribution.key_confidence);

      const existingKey = agg.key_counts.get(contribution.normalized_key) || {
        example_key: contribution.example_key,
        count: 0,
      };
      if (!existingKey.example_key) existingKey.example_key = contribution.example_key;
      existingKey.count += 1;
      agg.key_counts.set(contribution.normalized_key, existingKey);

      if (
        eventId &&
        agg.evidence_event_ids.length < evidenceIdsLimit &&
        !agg.evidence_event_id_set.has(eventId)
      ) {
        agg.evidence_event_ids.push(eventId);
        agg.evidence_event_id_set.add(eventId);
      }

      if (evidenceLevel === "observed") agg.evidence_levels.observed += 1;
      else if (evidenceLevel === "attempted") agg.evidence_levels.attempted += 1;
      else agg.evidence_levels.unknown += 1;
    }
  }

  const rows = Array.from(aggregates.values())
    .map((agg) => ({
      site: agg.site,
      vendor_id: agg.vendor_id,
      data_category: agg.data_category,
      surface: agg.surface,
      first_seen: agg.first_seen || 0,
      last_seen: agg.last_seen || 0,
      count: agg.count,
      confidence: Number(clamp01(agg.confidence_sum / Math.max(1, agg.count)).toFixed(4)),
      example_key: selectExampleKey(agg.key_counts),
      evidence_event_ids: agg.evidence_event_ids,
      evidence_levels: agg.evidence_levels,
    }))
    .sort((a, b) =>
      (b.count - a.count) ||
      (b.last_seen - a.last_seen) ||
      a.vendor_id.localeCompare(b.vendor_id) ||
      a.data_category.localeCompare(b.data_category) ||
      a.surface.localeCompare(b.surface)
    );

  return {
    site,
    vendor: vendor || undefined,
    rows,
  };
}

module.exports = {
  DEFAULT_EVIDENCE_IDS_LIMIT,
  mapMitigationToEvidenceLevel,
  extractQueryParamNames,
  deriveExposureInventory,
};
