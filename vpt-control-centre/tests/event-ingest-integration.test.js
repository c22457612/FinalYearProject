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

test("network/cookies paths remain intact when api canvas+webrtc events are ingested", async () => {
  await withTempApiServer(async ({ baseUrl }) => {
    const site = "api-mixed.example.com";
    const ts = Date.UTC(2026, 2, 7, 12, 0, 0);
    const events = [
      {
        id: "integ-mixed-network-1",
        ts,
        source: "test-extension",
        site,
        kind: "network.observed",
        mode: "moderate",
        data: {
          url: "https://www.google-analytics.com/g/collect?cid=123",
          domain: "www.google-analytics.com",
          isThirdParty: true,
          resourceType: "xmlhttprequest",
        },
      },
      {
        id: "integ-mixed-cookies-1",
        ts: ts + 1000,
        source: "test-extension",
        site,
        kind: "cookies.snapshot",
        mode: "moderate",
        data: {
          url: "https://api-mixed.example.com/",
          count: 2,
          thirdPartyCount: 1,
          cookies: [
            { name: "sid", domain: ".api-mixed.example.com", isThirdParty: false },
            { name: "id", domain: ".doubleclick.net", isThirdParty: true },
          ],
        },
      },
      {
        id: "integ-mixed-canvas-1",
        ts: ts + 2000,
        source: "test-extension",
        site,
        kind: "api.canvas.activity",
        mode: "moderate",
        data: {
          surface: "api",
          surfaceDetail: "canvas",
          operation: "toDataURL",
          contextType: "2d",
          width: 300,
          height: 150,
          count: 2,
          burstMs: 300,
          sampleWindowMs: 1200,
          signalType: "fingerprinting_signal",
          patternId: "api.canvas.toDataURL",
          confidence: 0.94,
        },
      },
      {
        id: "integ-mixed-webrtc-1",
        ts: ts + 3000,
        source: "test-extension",
        site,
        kind: "api.webrtc.activity",
        mode: "moderate",
        data: {
          surface: "api",
          surfaceDetail: "webrtc",
          action: "ice_candidate_activity",
          state: "candidate",
          candidateType: "srflx",
          stunTurnHostnames: ["stun.l.google.com"],
          count: 1,
          burstMs: 0,
          sampleWindowMs: 1200,
          signalType: "device_probe",
          patternId: "api.webrtc.ice_candidate_activity",
          confidence: 0.93,
        },
      },
    ];

    const postResponse = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(events),
    });
    const postBodyText = await postResponse.text();
    assert.equal(postResponse.status, 202, `Expected HTTP 202 from POST /api/events: ${postBodyText}`);
    const postBody = JSON.parse(postBodyText);
    assert.equal(postBody.ok, true);
    assert.equal(postBody.count, 4);
    assert.equal(postBody.inserted, 4);

    const saved = await getJson(`${baseUrl}/api/events?site=${encodeURIComponent(site)}&limit=50`);
    assert.equal(saved.length, 4);

    const networkEv = saved.find((row) => row.id === "integ-mixed-network-1");
    const cookiesEv = saved.find((row) => row.id === "integ-mixed-cookies-1");
    const canvasEv = saved.find((row) => row.id === "integ-mixed-canvas-1");
    const webrtcEv = saved.find((row) => row.id === "integ-mixed-webrtc-1");

    assert.ok(networkEv);
    assert.ok(cookiesEv);
    assert.ok(canvasEv);
    assert.ok(webrtcEv);

    assert.equal(networkEv.enrichment.surface, "network");
    assert.equal(networkEv.enrichment.surfaceDetail, "network_request");
    assert.equal(cookiesEv.enrichment.surface, "cookies");
    assert.equal(cookiesEv.enrichment.surfaceDetail, "cookie_snapshot");

    assert.equal(canvasEv.enrichment.surface, "api");
    assert.equal(canvasEv.enrichment.surfaceDetail, "canvas");
    assert.equal(canvasEv.enrichment.privacyStatus, "signal_detected");
    assert.equal(canvasEv.enrichment.mitigationStatus, "observed_only");
    assert.equal(canvasEv.enrichment.signalType, "fingerprinting_signal");
    assert.equal(canvasEv.enrichment.patternId, "api.canvas.repeated_readback");
    assert.equal(canvasEv.enrichment.confidence, 0.96);
    assert.equal(canvasEv.data?.signalType, "fingerprinting_signal");
    assert.equal(canvasEv.data?.patternId, "api.canvas.toDataURL");
    assert.equal(canvasEv.data?.confidence, 0.94);
    assert.equal(webrtcEv.enrichment.surface, "api");
    assert.equal(webrtcEv.enrichment.surfaceDetail, "webrtc");
    assert.equal(webrtcEv.enrichment.privacyStatus, "signal_detected");
    assert.equal(webrtcEv.enrichment.mitigationStatus, "observed_only");
    assert.equal(webrtcEv.enrichment.signalType, "device_probe");
    assert.equal(webrtcEv.enrichment.patternId, "api.webrtc.stun_turn_assisted_probe");
    assert.equal(webrtcEv.enrichment.confidence, 0.96);
    assert.equal(webrtcEv.data?.signalType, "device_probe");
    assert.equal(webrtcEv.data?.patternId, "api.webrtc.ice_candidate_activity");
    assert.equal(webrtcEv.data?.confidence, 0.93);
  });
});

test("canvas gate outcomes round-trip through events API with stable enrichment mapping", async () => {
  await withTempApiServer(async ({ baseUrl }) => {
    const site = "canvas-gate.example.com";
    const ts = Date.UTC(2026, 2, 15, 10, 0, 0);
    const events = [
      {
        id: "canvas-gate-observed-1",
        ts,
        source: "test-extension",
        site,
        kind: "api.canvas.activity",
        mode: "moderate",
        data: {
          surface: "api",
          surfaceDetail: "canvas",
          operation: "getImageData",
          contextType: "2d",
          width: 300,
          height: 150,
          count: 1,
          burstMs: 0,
          sampleWindowMs: 1200,
          gateOutcome: "observed",
          gateAction: "observe",
          trustedSite: false,
          frameScope: "top_frame",
        },
      },
      {
        id: "canvas-gate-warned-1",
        ts: ts + 1000,
        source: "test-extension",
        site,
        kind: "api.canvas.activity",
        mode: "moderate",
        data: {
          surface: "api",
          surfaceDetail: "canvas",
          operation: "toDataURL",
          contextType: "2d",
          width: 300,
          height: 150,
          count: 1,
          burstMs: 0,
          sampleWindowMs: 1200,
          gateOutcome: "warned",
          gateAction: "warn",
          trustedSite: false,
          frameScope: "top_frame",
        },
      },
      {
        id: "canvas-gate-blocked-1",
        ts: ts + 2000,
        source: "test-extension",
        site,
        kind: "api.canvas.activity",
        mode: "moderate",
        data: {
          surface: "api",
          surfaceDetail: "canvas",
          operation: "readPixels",
          contextType: "webgl",
          width: 256,
          height: 256,
          count: 1,
          burstMs: 0,
          sampleWindowMs: 1200,
          gateOutcome: "blocked",
          gateAction: "block",
          trustedSite: false,
          frameScope: "top_frame",
        },
      },
      {
        id: "canvas-gate-trusted-1",
        ts: ts + 3000,
        source: "test-extension",
        site,
        kind: "api.canvas.activity",
        mode: "moderate",
        data: {
          surface: "api",
          surfaceDetail: "canvas",
          operation: "toBlob",
          contextType: "2d",
          width: 300,
          height: 150,
          count: 1,
          burstMs: 0,
          sampleWindowMs: 1200,
          gateOutcome: "trusted_allowed",
          gateAction: "allow_trusted",
          trustedSite: true,
          frameScope: "top_frame",
        },
      },
    ];

    const postResponse = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(events),
    });
    const postBodyText = await postResponse.text();
    assert.equal(postResponse.status, 202, `Expected HTTP 202 from POST /api/events: ${postBodyText}`);

    const saved = await getJson(`${baseUrl}/api/events?site=${encodeURIComponent(site)}&limit=50`);
    assert.equal(saved.length, 4);

    const byId = new Map(saved.map((event) => [event.id, event]));

    assert.equal(byId.get("canvas-gate-observed-1")?.data?.gateOutcome, "observed");
    assert.equal(byId.get("canvas-gate-observed-1")?.enrichment?.mitigationStatus, "observed_only");
    assert.equal(byId.get("canvas-gate-observed-1")?.enrichment?.privacyStatus, "signal_detected");

    assert.equal(byId.get("canvas-gate-warned-1")?.data?.gateOutcome, "warned");
    assert.equal(byId.get("canvas-gate-warned-1")?.enrichment?.mitigationStatus, "observed_only");
    assert.equal(byId.get("canvas-gate-warned-1")?.enrichment?.privacyStatus, "signal_detected");

    assert.equal(byId.get("canvas-gate-blocked-1")?.data?.gateOutcome, "blocked");
    assert.equal(byId.get("canvas-gate-blocked-1")?.enrichment?.mitigationStatus, "blocked");
    assert.equal(byId.get("canvas-gate-blocked-1")?.enrichment?.privacyStatus, "policy_blocked");

    assert.equal(byId.get("canvas-gate-trusted-1")?.data?.gateOutcome, "trusted_allowed");
    assert.equal(byId.get("canvas-gate-trusted-1")?.enrichment?.mitigationStatus, "allowed");
    assert.equal(byId.get("canvas-gate-trusted-1")?.enrichment?.privacyStatus, "policy_allowed");
    assert.equal(byId.get("canvas-gate-trusted-1")?.data?.frameScope, "top_frame");
  });
});

test("webrtc gate outcomes round-trip through events API with stable enrichment mapping", async () => {
  await withTempApiServer(async ({ baseUrl }) => {
    const site = "webrtc-gate.example.com";
    const ts = Date.UTC(2026, 2, 15, 11, 0, 0);
    const events = [
      {
        id: "webrtc-gate-observed-1",
        ts,
        source: "test-extension",
        site,
        kind: "api.webrtc.activity",
        mode: "moderate",
        data: {
          surface: "api",
          surfaceDetail: "webrtc",
          action: "peer_connection_created",
          count: 1,
          burstMs: 0,
          sampleWindowMs: 1200,
          gateOutcome: "observed",
          gateAction: "observe",
          trustedSite: false,
          frameScope: "top_frame",
        },
      },
      {
        id: "webrtc-gate-warned-1",
        ts: ts + 1000,
        source: "test-extension",
        site,
        kind: "api.webrtc.activity",
        mode: "moderate",
        data: {
          surface: "api",
          surfaceDetail: "webrtc",
          action: "create_offer_called",
          count: 1,
          burstMs: 0,
          sampleWindowMs: 1200,
          gateOutcome: "warned",
          gateAction: "warn",
          trustedSite: false,
          frameScope: "top_frame",
        },
      },
      {
        id: "webrtc-gate-blocked-1",
        ts: ts + 2000,
        source: "test-extension",
        site,
        kind: "api.webrtc.activity",
        mode: "moderate",
        data: {
          surface: "api",
          surfaceDetail: "webrtc",
          action: "peer_connection_created",
          state: "blocked",
          stunTurnHostnames: ["stun.l.google.com"],
          count: 1,
          burstMs: 0,
          sampleWindowMs: 1200,
          gateOutcome: "blocked",
          gateAction: "block",
          trustedSite: false,
          frameScope: "top_frame",
        },
      },
      {
        id: "webrtc-gate-trusted-1",
        ts: ts + 3000,
        source: "test-extension",
        site,
        kind: "api.webrtc.activity",
        mode: "moderate",
        data: {
          surface: "api",
          surfaceDetail: "webrtc",
          action: "ice_candidate_activity",
          state: "candidate",
          candidateType: "srflx",
          stunTurnHostnames: ["stun.l.google.com"],
          count: 1,
          burstMs: 0,
          sampleWindowMs: 1200,
          gateOutcome: "trusted_allowed",
          gateAction: "allow_trusted",
          trustedSite: true,
          frameScope: "top_frame",
        },
      },
    ];

    const postResponse = await fetch(`${baseUrl}/api/events`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(events),
    });
    const postBodyText = await postResponse.text();
    assert.equal(postResponse.status, 202, `Expected HTTP 202 from POST /api/events: ${postBodyText}`);

    const saved = await getJson(`${baseUrl}/api/events?site=${encodeURIComponent(site)}&limit=50`);
    assert.equal(saved.length, 4);

    const byId = new Map(saved.map((event) => [event.id, event]));

    assert.equal(byId.get("webrtc-gate-observed-1")?.data?.gateOutcome, "observed");
    assert.equal(byId.get("webrtc-gate-observed-1")?.enrichment?.mitigationStatus, "observed_only");
    assert.equal(byId.get("webrtc-gate-observed-1")?.enrichment?.privacyStatus, "signal_detected");

    assert.equal(byId.get("webrtc-gate-warned-1")?.data?.gateOutcome, "warned");
    assert.equal(byId.get("webrtc-gate-warned-1")?.enrichment?.mitigationStatus, "observed_only");
    assert.equal(byId.get("webrtc-gate-warned-1")?.enrichment?.privacyStatus, "signal_detected");

    assert.equal(byId.get("webrtc-gate-blocked-1")?.data?.gateOutcome, "blocked");
    assert.equal(byId.get("webrtc-gate-blocked-1")?.enrichment?.mitigationStatus, "blocked");
    assert.equal(byId.get("webrtc-gate-blocked-1")?.enrichment?.privacyStatus, "policy_blocked");

    assert.equal(byId.get("webrtc-gate-trusted-1")?.data?.gateOutcome, "trusted_allowed");
    assert.equal(byId.get("webrtc-gate-trusted-1")?.enrichment?.mitigationStatus, "allowed");
    assert.equal(byId.get("webrtc-gate-trusted-1")?.enrichment?.privacyStatus, "policy_allowed");
    assert.equal(byId.get("webrtc-gate-trusted-1")?.data?.frameScope, "top_frame");
  });
});
