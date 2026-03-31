#!/usr/bin/env node

const { initDb } = require("../db");

const DUMMY_SOURCE = "dummy-seed";

async function run() {
  const dbCtx = await initDb();

  try {
    const before = await dbCtx.get(
      "SELECT COUNT(*) AS count FROM events WHERE source = ?",
      [DUMMY_SOURCE]
    );

    await dbCtx.run("DELETE FROM events WHERE source = ?", [DUMMY_SOURCE]);

    console.log(JSON.stringify({
      ok: true,
      source: DUMMY_SOURCE,
      deleted: Number(before?.count) || 0,
      note: "Reload the dashboard after cleanup to refresh the Cookies selector.",
    }, null, 2));
  } finally {
    await dbCtx.close();
  }
}

if (require.main === module) {
  run().catch((error) => {
    console.error("Failed to clean dummy-seed events:", error);
    process.exit(1);
  });
}
