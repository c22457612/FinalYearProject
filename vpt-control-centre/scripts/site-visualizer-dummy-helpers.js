const { buildEnrichmentRecord } = require("../enrichment");
const { upsertEnrichmentRow } = require("./backfill-enrichment");
const {
  DUMMY_SOURCE,
  SEEDED_EVENT_ID_PREFIX,
  SEEDED_SITES,
} = require("./site-visualizer-dummy-fixtures");

const DEFAULT_BASE_URL = "http://127.0.0.1:4141";

function parseBaseUrlArgs(argv) {
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

function getSeededIdLikeValue() {
  return `${SEEDED_EVENT_ID_PREFIX}%`;
}

function getSeededSitePlaceholders() {
  return SEEDED_SITES.map(() => "?").join(", ");
}

function buildScenarioSummary(events) {
  const list = Array.isArray(events) ? events : [];
  const perSite = {};
  const kinds = {};
  const surfaces = new Set();
  let earliestTs = null;
  let latestTs = null;

  for (const event of list) {
    const site = String(event?.site || "unknown");
    const kind = String(event?.kind || "unknown");
    perSite[site] = (perSite[site] || 0) + 1;
    kinds[kind] = (kinds[kind] || 0) + 1;

    if (kind.startsWith("network.")) surfaces.add("network");
    else if (kind.startsWith("cookies.")) surfaces.add("cookies");
    else if (kind.startsWith("api.") || kind.startsWith("browser_api.")) surfaces.add("api");
    else surfaces.add("other");

    const ts = Number(event?.ts);
    if (Number.isFinite(ts) && ts > 0) {
      earliestTs = earliestTs === null ? ts : Math.min(earliestTs, ts);
      latestTs = latestTs === null ? ts : Math.max(latestTs, ts);
    }
  }

  return {
    totalEvents: list.length,
    perSite,
    kinds,
    surfaces: Array.from(surfaces).sort(),
    earliestTs,
    latestTs,
  };
}

async function clearSeededData(dbCtx) {
  const likeValue = getSeededIdLikeValue();
  const sitePlaceholders = getSeededSitePlaceholders();
  const scopeParams = [DUMMY_SOURCE, likeValue, ...SEEDED_SITES];

  const siteRows = await dbCtx.all(
    `
      SELECT
        site,
        COUNT(*) AS count
      FROM events
      WHERE source = ?
        AND event_id LIKE ?
        AND site IN (${sitePlaceholders})
      GROUP BY site
      ORDER BY site ASC
    `,
    scopeParams
  );

  const totalRow = await dbCtx.get(
    `
      SELECT COUNT(*) AS count
      FROM events
      WHERE source = ?
        AND event_id LIKE ?
        AND site IN (${sitePlaceholders})
    `,
    scopeParams
  );

  const result = await dbCtx.run(
    `
      DELETE FROM events
      WHERE source = ?
        AND event_id LIKE ?
        AND site IN (${sitePlaceholders})
    `,
    scopeParams
  );

  return {
    source: DUMMY_SOURCE,
    deleted: Number(totalRow?.count) || 0,
    deleteChanges: Number(result?.changes) || 0,
    perSiteDeleted: (siteRows || []).map((row) => ({
      site: String(row?.site || ""),
      count: Number(row?.count) || 0,
    })),
  };
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

async function insertEventsDirect(dbCtx, events) {
  let inserted = 0;

  for (const ev of events) {
    const site = ev.site || ev.data?.siteBase || "unknown";
    const insertResult = await dbCtx.run(
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
    inserted += Number(insertResult?.changes) || 0;
  }

  return {
    ok: true,
    count: Array.isArray(events) ? events.length : 0,
    inserted,
    mode: "db-direct",
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  buildScenarioSummary,
  clearSeededData,
  insertEventsDirect,
  parseBaseUrlArgs,
  postEvents,
};
