#!/usr/bin/env node

const { initDb } = require("../db");
const {
  DUMMY_SOURCE,
  SEEDED_SITES,
  buildScenarioEvents,
} = require("./site-visualizer-dummy-fixtures");
const {
  buildScenarioSummary,
  clearSeededData,
  insertEventsDirect,
  parseBaseUrlArgs,
  postEvents,
} = require("./site-visualizer-dummy-helpers");

async function run() {
  const args = parseBaseUrlArgs(process.argv.slice(2));
  const dbCtx = await initDb();

  try {
    const cleared = await clearSeededData(dbCtx);
    const events = buildScenarioEvents();
    const scenarioSummary = buildScenarioSummary(events);
    let result;
    let mode = "api";

    try {
      result = await postEvents(args.baseUrl, events);
    } catch (error) {
      result = await insertEventsDirect(dbCtx, events);
      mode = "db-direct";
      console.warn(`API seed failed; wrote directly to SQLite instead: ${error.message || error}`);
    }

    console.log(JSON.stringify({
      ok: true,
      baseUrl: args.baseUrl,
      mode,
      source: DUMMY_SOURCE,
      seededSites: SEEDED_SITES,
      cleared,
      scenarioSummary,
      result,
    }, null, 2));
  } finally {
    await dbCtx.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error("Failed to seed Site Visualizer dummy data:", error);
    process.exit(1);
  });
}

module.exports = {
  run,
};
