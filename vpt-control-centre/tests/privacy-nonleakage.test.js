const fs = require("fs");
const os = require("os");
const path = require("path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const test = require("node:test");
const assert = require("node:assert/strict");

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
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "vpt-privacy-nonleak-"));
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

function payloadContainsAnyKey(payload, keys) {
  const scan = (value) => {
    if (value == null) return false;

    if (typeof value === "string") {
      return keys.has(value.toLowerCase());
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        if (scan(item)) return true;
      }
      return false;
    }

    if (typeof value === "object") {
      for (const [objKey, objValue] of Object.entries(value)) {
        if (keys.has(String(objKey).toLowerCase())) return true;
        if (scan(objValue)) return true;
      }
      return false;
    }

    return false;
  };

  return scan(payload);
}

test("derived exposure endpoints include key names and never leak raw query values", async () => {
  await withTempApiServer(async ({ baseUrl }) => {
    const site = "privacy-test.local";
    const vendor = "google";
    const sensitiveEvent = {
      id: "privacy-nonleak-event-1",
      ts: Date.UTC(2026, 2, 5, 15, 30, 0),
      source: "test-extension",
      site,
      kind: "network.observed",
      mode: "strict",
      data: {
        url: "https://www.google-analytics.com/g/collect?email=test@example.com&session=abc123&gclid=XYZ",
        domain: "www.google-analytics.com",
        isThirdParty: true,
        resourceType: "xmlhttprequest",
      },
    };

    const postResponse = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(sensitiveEvent),
    });
    const postBodyText = await postResponse.text();
    assert.equal(postResponse.status, 202, `Expected HTTP 202 from POST /api/events: ${postBodyText}`);
    const postBody = JSON.parse(postBodyText);
    assert.equal(postBody.ok, true);

    const payloads = [
      await getJson(`${baseUrl}/api/exposure-inventory?site=${encodeURIComponent(site)}&vendor=${vendor}`),
      await getJson(`${baseUrl}/api/exposure-inventory?vendor=${vendor}`),
      await getJson(`${baseUrl}/api/vendor-vault-summary?site=${encodeURIComponent(site)}&vendor=${vendor}`),
      await getJson(`${baseUrl}/api/vendor-vault-summary?vendor=${vendor}`),
    ];

    const allowedKeys = new Set(["email", "session", "gclid"]);
    const hasExposureExampleKey = payloads.some((payload) =>
      Array.isArray(payload?.rows)
      && payload.rows.some((row) => allowedKeys.has(String(row?.example_key || "").toLowerCase()))
    );
    const hasVaultObservedKey = payloads.some((payload) =>
      payload?.observed_parameter_keys
      && payloadContainsAnyKey(payload.observed_parameter_keys, allowedKeys)
    );
    assert.equal(
      hasExposureExampleKey || hasVaultObservedKey,
      true,
      "Expected derived payloads to surface at least one key name (email/session/gclid)"
    );

    for (const payload of payloads) {
      const serialized = JSON.stringify(payload);
      assert.equal(
        serialized.includes("test@example.com"),
        false,
        "Derived payload must not include raw email value"
      );
      assert.equal(serialized.includes("abc123"), false, "Derived payload must not include raw session value");
    }
  });
});
