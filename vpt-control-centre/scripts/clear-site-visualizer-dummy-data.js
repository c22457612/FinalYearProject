#!/usr/bin/env node

const { initDb } = require("../db");
const { clearSeededData } = require("./site-visualizer-dummy-helpers");

async function run() {
  const dbCtx = await initDb();

  try {
    const cleared = await clearSeededData(dbCtx);
    console.log(JSON.stringify({
      ok: true,
      ...cleared,
      note: "Matching event_enrichment rows are removed via ON DELETE CASCADE.",
    }, null, 2));
  } finally {
    await dbCtx.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error("Failed to clear Site Visualizer dummy data:", error);
    process.exit(1);
  });
}

module.exports = {
  run,
};
