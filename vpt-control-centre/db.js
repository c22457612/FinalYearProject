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

  INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', '2');
  UPDATE meta SET value = '2' WHERE key = 'schema_version';

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

  -- Semantic enrichment layer (separate from immutable raw events).
  -- This is future-proofed for browser API/event surfaces.
  CREATE TABLE IF NOT EXISTS event_enrichment (
    pk                 INTEGER PRIMARY KEY AUTOINCREMENT,
    event_pk           INTEGER NOT NULL UNIQUE,
    event_id           TEXT NOT NULL UNIQUE,
    enriched_ts        INTEGER NOT NULL,
    enrichment_version TEXT NOT NULL DEFAULT 'v1',
    surface            TEXT NOT NULL CHECK (surface IN ('network', 'cookies', 'storage', 'browser_api', 'script', 'unknown')),
    surface_detail     TEXT NOT NULL CHECK (
      surface_detail IN (
        'network_request',
        'cookie_snapshot',
        'cookie_operation',
        'local_storage',
        'session_storage',
        'indexeddb',
        'cache_api',
        'canvas',
        'webgl',
        'webrtc',
        'audiocontext',
        'script_execution',
        'unknown'
      )
    ),
    privacy_status     TEXT NOT NULL CHECK (
      privacy_status IN (
        'baseline',
        'signal_detected',
        'high_risk',
        'policy_blocked',
        'policy_allowed',
        'unknown'
      )
    ),
    mitigation_status  TEXT NOT NULL CHECK (
      mitigation_status IN (
        'allowed',
        'blocked',
        'observed_only',
        'modified',
        'unknown'
      )
    ),
    signal_type        TEXT NOT NULL CHECK (
      signal_type IN (
        'fingerprinting_signal',
        'tracking_signal',
        'device_probe',
        'capability_probe',
        'state_change',
        'unknown'
      )
    ),
    pattern_id         TEXT,
    confidence         REAL CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
    vendor_id          TEXT,
    vendor_name        TEXT,
    vendor_family      TEXT,
    request_domain     TEXT,
    request_url        TEXT,
    first_party_site   TEXT,
    is_third_party     INTEGER CHECK (is_third_party IS NULL OR is_third_party IN (0, 1)),
    rule_id            TEXT,
    raw_context        TEXT,
    FOREIGN KEY(event_pk) REFERENCES events(pk) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_event_enrichment_site_ts ON event_enrichment(first_party_site, enriched_ts);
  CREATE INDEX IF NOT EXISTS idx_event_enrichment_surface_ts ON event_enrichment(surface, enriched_ts);
  CREATE INDEX IF NOT EXISTS idx_event_enrichment_privacy_ts ON event_enrichment(privacy_status, enriched_ts);
  CREATE INDEX IF NOT EXISTS idx_event_enrichment_signal_ts ON event_enrichment(signal_type, enriched_ts);
  CREATE INDEX IF NOT EXISTS idx_event_enrichment_vendor_ts ON event_enrichment(vendor_id, enriched_ts);

  -- Canonical taxonomy dictionary for semantic dimensions.
  CREATE TABLE IF NOT EXISTS enrichment_taxonomy (
    dimension   TEXT NOT NULL,
    value       TEXT NOT NULL,
    description TEXT NOT NULL,
    PRIMARY KEY (dimension, value)
  );

  INSERT OR IGNORE INTO enrichment_taxonomy(dimension, value, description) VALUES
    ('surface', 'network', 'Network request/response surface'),
    ('surface', 'cookies', 'Cookie collection and mutation surface'),
    ('surface', 'storage', 'Storage APIs (local/session/indexedDB/cache)'),
    ('surface', 'browser_api', 'High-signal browser API surfaces'),
    ('surface', 'script', 'Script execution and capability checks'),
    ('surface', 'unknown', 'Not yet mapped to a semantic surface');

  INSERT OR IGNORE INTO enrichment_taxonomy(dimension, value, description) VALUES
    ('surface_detail', 'network_request', 'Observed network request event'),
    ('surface_detail', 'cookie_snapshot', 'Cookie inventory snapshot event'),
    ('surface_detail', 'cookie_operation', 'Cookie mutation/cleanup operation'),
    ('surface_detail', 'local_storage', 'localStorage surface'),
    ('surface_detail', 'session_storage', 'sessionStorage surface'),
    ('surface_detail', 'indexeddb', 'IndexedDB surface'),
    ('surface_detail', 'cache_api', 'Cache API surface'),
    ('surface_detail', 'canvas', 'Canvas API signal'),
    ('surface_detail', 'webgl', 'WebGL API signal'),
    ('surface_detail', 'webrtc', 'WebRTC API signal'),
    ('surface_detail', 'audiocontext', 'AudioContext API signal'),
    ('surface_detail', 'script_execution', 'Script-level execution signal'),
    ('surface_detail', 'unknown', 'Not yet mapped to a semantic detail');

  INSERT OR IGNORE INTO enrichment_taxonomy(dimension, value, description) VALUES
    ('privacy_status', 'baseline', 'No suspicious signal classified in this event'),
    ('privacy_status', 'signal_detected', 'Potential tracking/fingerprinting signal detected'),
    ('privacy_status', 'high_risk', 'High-risk signal by rule/pattern classification'),
    ('privacy_status', 'policy_blocked', 'Signal mitigated by blocking policy'),
    ('privacy_status', 'policy_allowed', 'Signal explicitly allowed by policy'),
    ('privacy_status', 'unknown', 'Classification pending or unavailable');

  INSERT OR IGNORE INTO enrichment_taxonomy(dimension, value, description) VALUES
    ('mitigation_status', 'allowed', 'Allowed to proceed'),
    ('mitigation_status', 'blocked', 'Blocked by policy/rule'),
    ('mitigation_status', 'observed_only', 'Observed only, no active mitigation'),
    ('mitigation_status', 'modified', 'Mutated/sanitized by mitigation'),
    ('mitigation_status', 'unknown', 'Mitigation outcome not known');

  INSERT OR IGNORE INTO enrichment_taxonomy(dimension, value, description) VALUES
    ('signal_type', 'fingerprinting_signal', 'Likely fingerprinting behavior'),
    ('signal_type', 'tracking_signal', 'Likely tracking/cross-site measurement signal'),
    ('signal_type', 'device_probe', 'Device/environment probing signal'),
    ('signal_type', 'capability_probe', 'Feature/capability probing signal'),
    ('signal_type', 'state_change', 'State mutation without direct tracking conclusion'),
    ('signal_type', 'unknown', 'Signal type not yet classified');
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
