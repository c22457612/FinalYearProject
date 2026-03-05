const fs = require("fs");
const os = require("os");
const path = require("path");
const test = require("node:test");
const assert = require("node:assert/strict");
const net = require("node:net");
const { spawn } = require("node:child_process");

const { initDb } = require("../db");
const { deriveExposureInventory } = require("../exposure-inventory");

async function withTempDb(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpt-exposure-"));
  const dbPath = path.join(tempDir, "privacy.db");
  const dbCtx = await initDb({ filename: dbPath });
  try {
    return await run(dbCtx);
  } finally {
    await dbCtx.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function insertExposureEvent(dbCtx, { id, ts, site, vendor, requestUrl, mitigationStatus = "observed_only" }) {
  await dbCtx.run(
    `
      INSERT INTO events
        (event_id, ts, site, kind, mode, tab_id, source, top_level_url, raw_event)
      VALUES
        (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    [
      id,
      ts,
      site,
      "network.observed",
      "strict",
      null,
      "test",
      null,
      JSON.stringify({ id, ts, site, kind: "network.observed", data: { url: requestUrl, vendorId: vendor } }),
    ]
  );

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
      )
      SELECT
        pk,
        event_id,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?,
        ?
      FROM events
      WHERE event_id = ?
    `,
    [
      ts,
      "v2",
      "network",
      "network_request",
      "signal_detected",
      mitigationStatus,
      "tracking_signal",
      "test.exposure_inventory",
      1,
      vendor,
      vendor,
      null,
      "collect.example",
      requestUrl,
      site,
      1,
      null,
      "{}",
      id,
    ]
  );
}

const SITE_MODE_ROW_KEYS = [
  "site",
  "vendor_id",
  "data_category",
  "surface",
  "first_seen",
  "last_seen",
  "count",
  "confidence",
  "example_key",
  "evidence_event_ids",
  "evidence_levels",
].sort();

function hasOwn(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

async function getEphemeralPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = addr && typeof addr === "object" ? addr.port : null;
      server.close((err) => {
        if (err) return reject(err);
        if (!port) return reject(new Error("failed_to_allocate_port"));
        resolve(port);
      });
    });
  });
}

async function waitForServerReady(baseUrl, child, stdoutRef, stderrRef) {
  const timeoutMs = 8_000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    if (child.exitCode != null) {
      throw new Error(
        `server_exited_before_ready (code=${child.exitCode})\nstdout:\n${stdoutRef()}\nstderr:\n${stderrRef()}`
      );
    }

    try {
      const response = await fetch(`${baseUrl}/api/sites?limit=1`);
      if (response.ok) return;
    } catch {
      // Retry until timeout.
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`server_start_timeout\nstdout:\n${stdoutRef()}\nstderr:\n${stderrRef()}`);
}

async function stopServer(child) {
  if (child.exitCode != null) return;

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    new Promise((resolve) =>
      setTimeout(() => {
        if (child.exitCode == null) child.kill("SIGKILL");
        resolve();
      }, 2_000)
    ),
  ]);
}

async function withTempApiServer(seed, run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpt-exposure-api-"));
  const dbPath = path.join(tempDir, "privacy.db");
  const dbCtx = await initDb({ filename: dbPath });

  try {
    await seed(dbCtx);
  } finally {
    await dbCtx.close();
  }

  const port = await getEphemeralPort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const serverCwd = path.join(__dirname, "..");
  const server = spawn(process.execPath, ["server.js"], {
    cwd: serverCwd,
    env: {
      ...process.env,
      PORT: String(port),
      VPT_DB_PATH: dbPath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  server.stdout.on("data", (chunk) => {
    stdout += String(chunk);
  });
  server.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  try {
    await waitForServerReady(baseUrl, server, () => stdout, () => stderr);
    return await run(baseUrl);
  } finally {
    await stopServer(server);
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

async function getJson(url) {
  const response = await fetch(url);
  const text = await response.text();
  assert.equal(response.status, 200, `Expected HTTP 200 from ${url}, got ${response.status}: ${text}`);
  return JSON.parse(text);
}

async function seedGoogleExposureRows(dbCtx) {
  const t0 = Date.UTC(2026, 2, 5, 9, 0, 0);
  await insertExposureEvent(dbCtx, {
    id: "exp-api-1",
    ts: t0,
    site: "alpha.local",
    vendor: "google",
    requestUrl: "https://collect.example/hit?gclid=one",
    mitigationStatus: "observed_only",
  });
  await insertExposureEvent(dbCtx, {
    id: "exp-api-2",
    ts: t0 + 20_000,
    site: "beta.local",
    vendor: "google",
    requestUrl: "https://collect.example/hit?gclid=two",
    mitigationStatus: "blocked",
  });
}

test("site+vendor mode keeps row shape unchanged", async () => {
  await withTempDb(async (dbCtx) => {
    const now = Date.UTC(2026, 2, 4, 10, 0, 0);
    await insertExposureEvent(dbCtx, {
      id: "exp-site-1",
      ts: now,
      site: "alpha.local",
      vendor: "google",
      requestUrl: "https://collect.example/hit?gclid=abc123",
    });

    const inventory = await deriveExposureInventory(dbCtx, {
      site: "alpha.local",
      vendor: "google",
    });

    assert.equal(inventory.site, "alpha.local");
    assert.equal(inventory.vendor, "google");
    assert.equal(inventory.rows.length, 1);
    assert.deepEqual(
      Object.keys(inventory.rows[0]),
      [
        "site",
        "vendor_id",
        "data_category",
        "surface",
        "first_seen",
        "last_seen",
        "count",
        "confidence",
        "example_key",
        "evidence_event_ids",
        "evidence_levels",
      ]
    );
    assert.equal("top_sites" in inventory.rows[0], false);
  });
});

test("vendor-only mode aggregates rows across sites and exposes top_sites", async () => {
  await withTempDb(async (dbCtx) => {
    const now = Date.UTC(2026, 2, 4, 11, 0, 0);
    await insertExposureEvent(dbCtx, {
      id: "exp-all-1",
      ts: now,
      site: "alpha.local",
      vendor: "google",
      requestUrl: "https://collect.example/hit?gclid=one",
      mitigationStatus: "observed_only",
    });
    await insertExposureEvent(dbCtx, {
      id: "exp-all-2",
      ts: now + 30_000,
      site: "beta.local",
      vendor: "google",
      requestUrl: "https://collect.example/hit?gclid=two",
      mitigationStatus: "blocked",
    });

    const inventory = await deriveExposureInventory(dbCtx, { vendor: "google" });

    assert.equal(inventory.site, null);
    assert.equal(inventory.vendor, "google");
    assert.equal(inventory.rows.length, 1);
    assert.equal("top_sites" in inventory.rows[0], true);
    assert.equal(inventory.rows[0].site, null);
    assert.equal(inventory.rows[0].count, 2);
    assert.deepEqual(inventory.rows[0].top_sites, [
      { site: "alpha.local", count: 1 },
      { site: "beta.local", count: 1 },
    ]);
  });
});

test("api site-scoped contract keeps stable payload and row key sets", async () => {
  await withTempApiServer(seedGoogleExposureRows, async (baseUrl) => {
    const payload = await getJson(`${baseUrl}/api/exposure-inventory?site=alpha.local&vendor=google`);

    assert.deepEqual(Object.keys(payload).sort(), ["rows", "site", "vendor"]);
    assert.equal(payload.site, "alpha.local");
    assert.equal(payload.vendor, "google");
    assert.ok(Array.isArray(payload.rows));
    assert.equal(payload.rows.length > 0, true);

    for (const row of payload.rows) {
      assert.deepEqual(Object.keys(row).sort(), SITE_MODE_ROW_KEYS);
      assert.equal(hasOwn(row, "top_sites"), false);
    }
  });
});

test("api vendor-global mode allows top_sites and top_sites is excluded from site mode", async () => {
  await withTempApiServer(seedGoogleExposureRows, async (baseUrl) => {
    const sitePayload = await getJson(`${baseUrl}/api/exposure-inventory?site=alpha.local&vendor=google`);
    const vendorPayload = await getJson(`${baseUrl}/api/exposure-inventory?vendor=google`);

    assert.deepEqual(Object.keys(vendorPayload).sort(), ["rows", "site", "vendor"]);
    assert.equal(vendorPayload.site, null);
    assert.equal(vendorPayload.vendor, "google");
    assert.ok(Array.isArray(vendorPayload.rows));
    assert.equal(vendorPayload.rows.length > 0, true);

    assert.equal(sitePayload.rows.some((row) => hasOwn(row, "top_sites")), false);
    assert.equal(vendorPayload.rows.some((row) => hasOwn(row, "top_sites")), true);

    for (const row of vendorPayload.rows) {
      assert.ok(Array.isArray(row.top_sites));
    }
  });
});
