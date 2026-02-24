const DETECTED_SIGNAL_STATUSES = [
  "signal_detected",
  "high_risk",
  "policy_blocked",
  "policy_allowed",
];

function toBoundedInt(value, fallback, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function toNullableTs(value) {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function buildRange(from, to) {
  const end = toNullableTs(to) ?? Date.now();
  const start = toNullableTs(from) ?? Math.max(0, end - (30 * 24 * 60 * 60 * 1000));
  if (start <= end) return { from: start, to: end };
  return { from: end, to: start };
}

function buildFilter(site, from, to) {
  return {
    sql: `
      WHERE (? IS NULL OR COALESCE(e.site, 'unknown') = ?)
        AND e.ts >= ?
        AND e.ts <= ?
    `,
    params: [site, site, from, to],
  };
}

async function fetchDailyPrivacyMitigation(dbCtx, site, from, to) {
  const filter = buildFilter(site, from, to);

  const rows = await dbCtx.all(
    `
      SELECT
        date(e.ts / 1000, 'unixepoch') AS day,
        ee.privacy_status AS privacyStatus,
        ee.mitigation_status AS mitigationStatus,
        COUNT(*) AS count
      FROM events e
      JOIN event_enrichment ee ON ee.event_pk = e.pk
      ${filter.sql}
      GROUP BY day, privacyStatus, mitigationStatus
      ORDER BY day ASC, privacyStatus ASC, mitigationStatus ASC
    `,
    filter.params
  );

  return rows.map((r) => ({
    day: r.day,
    privacyStatus: r.privacyStatus,
    mitigationStatus: r.mitigationStatus,
    count: Number(r.count) || 0,
  }));
}

async function fetchPartySplitByDay(dbCtx, site, from, to) {
  const filter = buildFilter(site, from, to);

  const rows = await dbCtx.all(
    `
      SELECT
        date(e.ts / 1000, 'unixepoch') AS day,
        SUM(CASE WHEN ee.is_third_party = 1 THEN 1 ELSE 0 END) AS thirdParty,
        SUM(CASE WHEN ee.is_third_party = 0 THEN 1 ELSE 0 END) AS firstParty,
        SUM(CASE WHEN ee.is_third_party IS NULL THEN 1 ELSE 0 END) AS unknownParty
      FROM events e
      JOIN event_enrichment ee ON ee.event_pk = e.pk
      ${filter.sql}
      GROUP BY day
      ORDER BY day ASC
    `,
    filter.params
  );

  return rows.map((r) => ({
    day: r.day,
    firstParty: Number(r.firstParty) || 0,
    thirdParty: Number(r.thirdParty) || 0,
    unknownParty: Number(r.unknownParty) || 0,
  }));
}

async function fetchVendorTotals(dbCtx, site, from, to, topVendors) {
  const filter = buildFilter(site, from, to);
  const detectedClause = DETECTED_SIGNAL_STATUSES.map(() => "?").join(", ");

  const rows = await dbCtx.all(
    `
      SELECT
        COALESCE(NULLIF(ee.vendor_id, ''), 'unknown') AS vendorId,
        COALESCE(NULLIF(ee.vendor_name, ''), COALESCE(NULLIF(ee.vendor_id, ''), 'unknown')) AS vendorName,
        COALESCE(NULLIF(ee.vendor_family, ''), 'unknown') AS vendorFamily,
        COUNT(*) AS totalEvents,
        SUM(CASE WHEN ee.privacy_status IN (${detectedClause}) THEN 1 ELSE 0 END) AS detectedSignals,
        SUM(CASE WHEN ee.privacy_status = 'baseline' THEN 1 ELSE 0 END) AS baselineEvents,
        SUM(CASE WHEN ee.mitigation_status = 'blocked' THEN 1 ELSE 0 END) AS blockedEvents,
        SUM(CASE WHEN ee.mitigation_status = 'observed_only' THEN 1 ELSE 0 END) AS observedOnlyEvents
      FROM events e
      JOIN event_enrichment ee ON ee.event_pk = e.pk
      ${filter.sql}
      GROUP BY vendorId, vendorName, vendorFamily
      ORDER BY totalEvents DESC, vendorName ASC
      LIMIT ?
    `,
    [...DETECTED_SIGNAL_STATUSES, ...filter.params, topVendors]
  );

  return rows.map((r) => {
    const total = Number(r.totalEvents) || 0;
    const detected = Number(r.detectedSignals) || 0;
    const detectedSignalRate = total > 0 ? Number((detected / total).toFixed(4)) : 0;
    return {
      vendorId: r.vendorId,
      vendorName: r.vendorName,
      vendorFamily: r.vendorFamily,
      totalEvents: total,
      detectedSignals: detected,
      baselineEvents: Number(r.baselineEvents) || 0,
      blockedEvents: Number(r.blockedEvents) || 0,
      observedOnlyEvents: Number(r.observedOnlyEvents) || 0,
      detectedSignalRate,
    };
  });
}

async function fetchSiteTotals(dbCtx, site, from, to, topSites) {
  const filter = buildFilter(site, from, to);
  const detectedClause = DETECTED_SIGNAL_STATUSES.map(() => "?").join(", ");

  const rows = await dbCtx.all(
    `
      SELECT
        COALESCE(e.site, 'unknown') AS site,
        COUNT(*) AS totalEvents,
        SUM(CASE WHEN ee.privacy_status IN (${detectedClause}) THEN 1 ELSE 0 END) AS detectedSignals,
        SUM(CASE WHEN ee.privacy_status = 'baseline' THEN 1 ELSE 0 END) AS baselineEvents,
        SUM(CASE WHEN ee.mitigation_status = 'blocked' THEN 1 ELSE 0 END) AS blockedEvents,
        MIN(e.ts) AS firstSeen,
        MAX(e.ts) AS lastSeen
      FROM events e
      JOIN event_enrichment ee ON ee.event_pk = e.pk
      ${filter.sql}
      GROUP BY COALESCE(e.site, 'unknown')
      ORDER BY totalEvents DESC, site ASC
      LIMIT ?
    `,
    [...DETECTED_SIGNAL_STATUSES, ...filter.params, topSites]
  );

  return rows.map((r) => {
    const total = Number(r.totalEvents) || 0;
    const detected = Number(r.detectedSignals) || 0;
    return {
      site: r.site,
      totalEvents: total,
      detectedSignals: detected,
      baselineEvents: Number(r.baselineEvents) || 0,
      blockedEvents: Number(r.blockedEvents) || 0,
      detectedSignalRate: total > 0 ? Number((detected / total).toFixed(4)) : 0,
      firstSeen: Number(r.firstSeen) || 0,
      lastSeen: Number(r.lastSeen) || 0,
    };
  });
}

async function fetchSessionMetrics(dbCtx, site, from, to, sessionLimit) {
  const filter = buildFilter(site, from, to);
  const detectedClause = DETECTED_SIGNAL_STATUSES.map(() => "?").join(", ");
  const sessionExprWithJson = "COALESCE(NULLIF(json_extract(e.raw_event, '$.data.sessionId'), ''), CASE WHEN e.tab_id IS NOT NULL THEN ('tab:' || e.tab_id) ELSE NULL END)";
  const sessionExprTabOnly = "CASE WHEN e.tab_id IS NOT NULL THEN ('tab:' || e.tab_id) ELSE NULL END";

  const queryForExpr = (sessionExpr) => `
    SELECT
      ${sessionExpr} AS sessionKey,
      COUNT(*) AS eventCount,
      SUM(CASE WHEN ee.privacy_status IN (${detectedClause}) THEN 1 ELSE 0 END) AS detectedSignals,
      SUM(CASE WHEN ee.privacy_status = 'baseline' THEN 1 ELSE 0 END) AS baselineEvents,
      MIN(e.ts) AS firstTs,
      MAX(e.ts) AS lastTs,
      MIN(CASE WHEN ee.privacy_status IN (${detectedClause}) THEN e.ts ELSE NULL END) AS firstDetectedTs
    FROM events e
    JOIN event_enrichment ee ON ee.event_pk = e.pk
    ${filter.sql}
      AND ${sessionExpr} IS NOT NULL
    GROUP BY sessionKey
    ORDER BY firstTs DESC
    LIMIT ?
  `;

  let rows;
  try {
    rows = await dbCtx.all(
      queryForExpr(sessionExprWithJson),
      [...DETECTED_SIGNAL_STATUSES, ...DETECTED_SIGNAL_STATUSES, ...filter.params, sessionLimit]
    );
  } catch {
    rows = await dbCtx.all(
      queryForExpr(sessionExprTabOnly),
      [...DETECTED_SIGNAL_STATUSES, ...DETECTED_SIGNAL_STATUSES, ...filter.params, sessionLimit]
    );
  }

  return rows.map((r) => {
    const firstTs = Number(r.firstTs) || 0;
    const firstDetectedTs = r.firstDetectedTs == null ? null : Number(r.firstDetectedTs);
    const timeToFirstDetectedSignalMs = firstDetectedTs == null ? null : Math.max(0, firstDetectedTs - firstTs);
    return {
      sessionKey: r.sessionKey,
      eventCount: Number(r.eventCount) || 0,
      detectedSignals: Number(r.detectedSignals) || 0,
      baselineEvents: Number(r.baselineEvents) || 0,
      firstTs,
      lastTs: Number(r.lastTs) || 0,
      firstDetectedTs,
      timeToFirstDetectedSignalMs,
    };
  });
}

async function getAnalyticsSnapshot(dbCtx, opts = {}) {
  const site = opts.site || null;
  const range = buildRange(opts.from, opts.to);
  const topVendors = toBoundedInt(opts.topVendors, 20, 1, 200);
  const topSites = toBoundedInt(opts.topSites, 100, 1, 500);
  const sessionLimit = toBoundedInt(opts.sessionLimit, 200, 1, 1000);

  const [
    dailyPrivacyMitigation,
    partySplitByDay,
    vendorTotals,
    siteTotals,
    sessions,
  ] = await Promise.all([
    fetchDailyPrivacyMitigation(dbCtx, site, range.from, range.to),
    fetchPartySplitByDay(dbCtx, site, range.from, range.to),
    fetchVendorTotals(dbCtx, site, range.from, range.to, topVendors),
    fetchSiteTotals(dbCtx, site, range.from, range.to, topSites),
    fetchSessionMetrics(dbCtx, site, range.from, range.to, sessionLimit),
  ]);

  return {
    site,
    range,
    dailyPrivacyMitigation,
    partySplitByDay,
    vendorTotals,
    siteTotals,
    sessions,
    generatedAt: Date.now(),
  };
}

module.exports = {
  DETECTED_SIGNAL_STATUSES,
  getAnalyticsSnapshot,
};
