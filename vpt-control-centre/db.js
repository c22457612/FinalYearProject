/**
 * db.js
 * SQLite persistence layer for VPT Control Centre.
 *
 * Design:
 * - Event sourcing: store every privacy event as an immutable row.
 * - Hybrid: store policies separately for quick current-state reads.
 *
 * We keep the full original event JSON in `raw_event` so the extension/dashboard
 * can evolve without constant schema migrations.
 */

const fs = require("fs");
const path = require("path");
const sqlite3 = require("sqlite3").verbose();

const DEFAULT_DIR = path.join(__dirname, "data");
const DEFAULT_DB_PATH = process.env.VPT_DB_PATH || path.join(DEFAULT_DIR, "privacy.db");

// --- Promise helpers ---
function exec(db, sql) {
  return new Promise((resolve, reject) => {
    db.exec(sql, (err) => (err ? reject(err) : resolve()));
  });
}

function run(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function onRun(err) {
      if (err) return reject(err);
      resolve({ lastID: this.lastID, changes: this.changes });
    });
  });
}

function get(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)));
  });
}

function all(db, sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)));
  });
}

function close(db) {
  return new Promise((resolve, reject) => {
    db.close((err) => (err ? reject(err) : resolve()));
  });
}

function ensureDirForFile(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

const SCHEMA_SQL = `
  -- Basic metadata table (handy for future migrations)
  CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '1');

  -- Event-sourcing: immutable privacy events
  CREATE TABLE IF NOT EXISTS events (
    pk            INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id      TEXT UNIQUE NOT NULL,
    ts            INTEGER NOT NULL,
    site          TEXT,
    kind          TEXT NOT NULL,
    mode          TEXT,
    tab_id        INTEGER,
    source        TEXT,
    top_level_url TEXT,
    raw_event     TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_ts ON events(ts);
  CREATE INDEX IF NOT EXISTS idx_events_site_ts ON events(site, ts);
  CREATE INDEX IF NOT EXISTS idx_events_kind_ts ON events(kind, ts);

  -- Hybrid: store policies separately for quick retrieval / persistence
  CREATE TABLE IF NOT EXISTS policies (
    pk        INTEGER PRIMARY KEY AUTOINCREMENT,
    policy_id TEXT UNIQUE NOT NULL,
    ts        INTEGER NOT NULL,
    op        TEXT NOT NULL,
    payload   TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_policies_ts ON policies(ts);
  CREATE INDEX IF NOT EXISTS idx_policies_op_ts ON policies(op, ts);
`;

/**
 * Initialise SQLite and ensure schema exists.
 */
async function initDb(opts = {}) {
  const filename = opts.filename || DEFAULT_DB_PATH;
  ensureDirForFile(filename);

  const db = new sqlite3.Database(filename);

  // Pragmas for better local performance + safer concurrency
  await exec(
    db,
    `
      PRAGMA journal_mode = WAL;
      PRAGMA synchronous = NORMAL;
      PRAGMA foreign_keys = ON;
      PRAGMA temp_store = MEMORY;
      PRAGMA busy_timeout = 5000;
    `
  );

  await exec(db, SCHEMA_SQL);

  return {
    db,
    filename,
    exec: (sql) => exec(db, sql),
    run: (sql, params) => run(db, sql, params),
    get: (sql, params) => get(db, sql, params),
    all: (sql, params) => all(db, sql, params),
    close: () => close(db),
  };
}

module.exports = {
  initDb,
};
