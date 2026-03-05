const { extractQueryParamNames } = require("./exposure-inventory");

function toSafeCount(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.floor(n);
}

function toSafeTimestamp(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n;
}

const CANON_VENDOR_SQL = "COALESCE(NULLIF(LOWER(TRIM(vendor_id)), ''), 'unknown')";

function normalizeVendor(vendor) {
  const value = String(vendor || "").trim().toLowerCase();
  return value || "unknown";
}

function normalizeSite(site) {
  const value = String(site || "").trim();
  return value || null;
}

function buildScopeFilter({ vendor, site }) {
  const where = [`${CANON_VENDOR_SQL} = ?`];
  const params = [vendor];
  if (site) {
    where.push("first_party_site = ?");
    params.push(site);
  }
  return { whereSql: where.join(" AND "), params };
}

function rowsToCountObject(rows, valueField) {
  const out = {};
  for (const row of rows || []) {
    const key = String(row && row[valueField] ? row[valueField] : "").trim();
    if (!key) continue;
    out[key] = toSafeCount(row.count);
  }
  return out;
}

function collectTopKeys(rows, limit = 15) {
  const keyCounts = new Map();

  for (const row of rows || []) {
    const url = String(row && row.request_url ? row.request_url : "").trim();
    if (!url) continue;

    const extracted = extractQueryParamNames(url);
    for (const rawName of extracted) {
      const cleaned = String(rawName || "").trim();
      if (!cleaned) continue;

      const normalized = cleaned.toLowerCase();
      const prev = keyCounts.get(normalized);
      if (prev) {
        prev.count += 1;
      } else {
        keyCounts.set(normalized, { key: cleaned, count: 1 });
      }
    }
  }

  const topKeys = Array.from(keyCounts.values())
    .sort((a, b) => (b.count - a.count) || a.key.localeCompare(b.key))
    .slice(0, Math.max(1, Math.min(50, Math.floor(Number(limit) || 15))));

  return {
    top_keys: topKeys,
    key_count_total: keyCounts.size,
  };
}

async function getVendorVaultSummary(dbCtx, opts = {}) {
  const vendor = normalizeVendor(opts.vendor);
  const site = normalizeSite(opts.site);

  if (!vendor) {
    const err = new Error("vendor_required");
    err.code = "vendor_required";
    throw err;
  }

  const scope = buildScopeFilter({ vendor, site });

  const activity = await dbCtx.get(
    `
      SELECT
        COUNT(*) AS total_events,
        SUM(CASE WHEN mitigation_status IN ('allowed', 'observed_only') THEN 1 ELSE 0 END) AS observed_count,
        SUM(CASE WHEN mitigation_status = 'blocked' THEN 1 ELSE 0 END) AS blocked_count,
        MIN(enriched_ts) AS first_seen,
        MAX(enriched_ts) AS last_seen
      FROM event_enrichment
      WHERE ${scope.whereSql}
    `,
    scope.params
  );

  const topDomainsRows = await dbCtx.all(
    `
      SELECT
        request_domain AS domain,
        COUNT(*) AS count
      FROM event_enrichment
      WHERE ${scope.whereSql}
        AND request_domain IS NOT NULL
        AND request_domain != ''
      GROUP BY request_domain
      ORDER BY count DESC, request_domain ASC
      LIMIT 10
    `,
    scope.params
  );

  const domainTotal = await dbCtx.get(
    `
      SELECT
        COUNT(DISTINCT request_domain) AS domain_count_total
      FROM event_enrichment
      WHERE ${scope.whereSql}
        AND request_domain IS NOT NULL
        AND request_domain != ''
    `,
    scope.params
  );

  const keyRows = await dbCtx.all(
    `
      SELECT request_url
      FROM event_enrichment
      WHERE ${scope.whereSql}
        AND surface_detail = 'network_request'
        AND request_url IS NOT NULL
        AND request_url != ''
    `,
    scope.params
  );

  const mitigationRows = await dbCtx.all(
    `
      SELECT
        mitigation_status,
        COUNT(*) AS count
      FROM event_enrichment
      WHERE ${scope.whereSql}
        AND mitigation_status IS NOT NULL
        AND mitigation_status != ''
      GROUP BY mitigation_status
      ORDER BY count DESC, mitigation_status ASC
    `,
    scope.params
  );

  const signalRows = await dbCtx.all(
    `
      SELECT
        signal_type,
        COUNT(*) AS count
      FROM event_enrichment
      WHERE ${scope.whereSql}
        AND signal_type IS NOT NULL
        AND signal_type != ''
      GROUP BY signal_type
      ORDER BY count DESC, signal_type ASC
    `,
    scope.params
  );

  const privacyRows = await dbCtx.all(
    `
      SELECT
        privacy_status,
        COUNT(*) AS count
      FROM event_enrichment
      WHERE ${scope.whereSql}
        AND privacy_status IS NOT NULL
        AND privacy_status != ''
      GROUP BY privacy_status
      ORDER BY count DESC, privacy_status ASC
    `,
    scope.params
  );

  const riskSummary = {};
  const mitigationCounts = rowsToCountObject(mitigationRows, "mitigation_status");
  const signalCounts = rowsToCountObject(signalRows, "signal_type");
  const privacyCounts = rowsToCountObject(privacyRows, "privacy_status");

  if (Object.keys(mitigationCounts).length) {
    riskSummary.mitigation_status_counts = mitigationCounts;
  }
  if (Object.keys(signalCounts).length) {
    riskSummary.signal_type_counts = signalCounts;
  }
  if (Object.keys(privacyCounts).length) {
    riskSummary.privacy_status_counts = privacyCounts;
  }

  return {
    site,
    vendor,
    activity_summary: {
      total_events: toSafeCount(activity && activity.total_events),
      observed_count: toSafeCount(activity && activity.observed_count),
      blocked_count: toSafeCount(activity && activity.blocked_count),
      first_seen: toSafeTimestamp(activity && activity.first_seen),
      last_seen: toSafeTimestamp(activity && activity.last_seen),
    },
    domains_used: {
      top_domains: (topDomainsRows || []).map((row) => ({
        domain: String(row && row.domain ? row.domain : "").trim(),
        count: toSafeCount(row && row.count),
      })).filter((row) => row.domain),
      domain_count_total: toSafeCount(domainTotal && domainTotal.domain_count_total),
    },
    observed_parameter_keys: collectTopKeys(keyRows, 15),
    risk_summary: riskSummary,
  };
}

module.exports = {
  getVendorVaultSummary,
};
