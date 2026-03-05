const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

const { initDb } = require("../db");

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

async function withTempApiServer(run) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpt-integ-events-"));
  const dbPath = path.join(tempDir, "privacy.db");
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
    return await run({ baseUrl, dbPath });
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

test("extension-like event POST persists to DB and is retrievable via events API", async () => {
  await withTempApiServer(async ({ baseUrl, dbPath }) => {
    const event = {
      id: "integ-event-1",
      ts: Date.UTC(2026, 2, 5, 14, 0, 0),
      source: "test-extension",
      site: "alpha.example.com",
      kind: "network.blocked",
      mode: "strict",
      data: {
        url: "https://www.google-analytics.com/g/collect?cid=123",
        domain: "www.google-analytics.com",
        isThirdParty: true,
        resourceType: "xmlhttprequest",
        ruleId: 1001,
      },
    };

    const postResponse = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(event),
    });
    const postBodyText = await postResponse.text();
    assert.equal(postResponse.status, 202, `Expected HTTP 202 from POST /api/events: ${postBodyText}`);
    const postBody = JSON.parse(postBodyText);
    assert.equal(postBody.ok, true);
    assert.equal(postBody.count, 1);
    assert.equal(postBody.inserted, 1);

    const events = await getJson(`${baseUrl}/api/events?site=${encodeURIComponent(event.site)}&limit=50`);
    assert.ok(Array.isArray(events));
    const savedEvent = events.find((row) => row && row.id === event.id);
    assert.ok(savedEvent, "Expected posted event to be returned by GET /api/events");
    assert.equal(savedEvent.id, event.id);
    assert.equal(savedEvent.site, event.site);
    assert.equal(savedEvent.kind, event.kind);
    assert.equal(savedEvent.ts, event.ts);
    assert.equal(savedEvent.source, event.source);
    assert.equal(savedEvent.mode, event.mode);
    assert.equal(savedEvent.data?.domain, event.data.domain);
    assert.equal(savedEvent.data?.url, event.data.url);
    assert.equal(savedEvent.data?.resourceType, event.data.resourceType);

    assert.ok(savedEvent.enrichment);
    assert.equal(savedEvent.enrichment.surface, "network");
    assert.equal(savedEvent.enrichment.surfaceDetail, "network_request");
    assert.equal(savedEvent.enrichment.privacyStatus, "policy_blocked");
    assert.equal(savedEvent.enrichment.mitigationStatus, "blocked");
    assert.equal(savedEvent.enrichment.signalType, "tracking_signal");

    const dbCtx = await initDb({ filename: dbPath });
    try {
      const enrichmentRow = await dbCtx.get(
        `
          SELECT vendor_id, vendor_name, request_domain
          FROM event_enrichment
          WHERE event_id = ?
        `,
        [event.id]
      );
      assert.ok(enrichmentRow, "Expected matching row in event_enrichment");
      assert.equal(enrichmentRow.vendor_id, "google");
      assert.equal(enrichmentRow.vendor_name, "Google");
      assert.equal(enrichmentRow.request_domain, "google-analytics.com");
    } finally {
      await dbCtx.close();
    }
  });
});
