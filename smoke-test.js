"use strict";

const { spawn } = require("child_process");
const path = require("path");

const WebSocket = require("ws");

const PORT = Number(process.env.SMOKE_PORT || 4521);
const BASE_URL = `http://127.0.0.1:${PORT}`;
const AGENT_KEY = String(process.env.AGENT_API_KEY || "").trim();
const CWD = __dirname;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} at ${url}`);
  }
  return response.json();
}

async function waitForHealth(timeoutMs = 20000) {
  const startedAt = Date.now();
  let lastError = null;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const health = await fetchJson(`${BASE_URL}/api/health`);
      if (health.ok) {
        return health;
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(350);
  }

  throw new Error(`Health check timed out: ${lastError?.message || "unknown"}`);
}

async function waitForWebSocketSample(timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    let helloSeen = false;
    let sampleSeen = false;

    const timeout = setTimeout(() => {
      socket.close();
      reject(new Error("WebSocket timeout waiting for hello/sample"));
    }, timeoutMs);

    socket.on("message", (rawData) => {
      let message;
      try {
        message = JSON.parse(rawData.toString());
      } catch {
        return;
      }

      if (message.type === "hello") {
        helloSeen = true;
      }
      if (message.type === "sample") {
        sampleSeen = true;
      }

      if (helloSeen && sampleSeen) {
        clearTimeout(timeout);
        socket.close();
        resolve({ helloSeen, sampleSeen });
      }
    });

    socket.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
  });
}

function startServerProcess() {
  const child = spawn(process.execPath, ["server.js"], {
    cwd: CWD,
    env: {
      ...process.env,
      PORT: String(PORT)
    },
    stdio: ["ignore", "pipe", "pipe"]
  });

  child.stdout.on("data", (chunk) => {
    process.stdout.write(`[server] ${chunk}`);
  });

  child.stderr.on("data", (chunk) => {
    process.stderr.write(`[server-err] ${chunk}`);
  });

  return child;
}

async function stopServerProcess(child) {
  if (!child || child.killed) {
    return;
  }

  child.kill("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("exit", resolve)),
    sleep(3000).then(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    })
  ]);
}

async function runSmokeTest() {
  const serverProcess = startServerProcess();
  const processExitPromise = new Promise((resolve) => {
    serverProcess.once("exit", (code, signal) => resolve({ code, signal }));
  });

  try {
    const health = await waitForHealth();
    assert(health.ok, "Health endpoint did not return ok=true");

    const hostsInitial = await fetchJson(`${BASE_URL}/api/hosts`);
    assert(Array.isArray(hostsInitial.hosts), "Missing hosts list");
    assert(typeof hostsInitial.localHostId === "string" && hostsInitial.localHostId.length > 0, "Missing localHostId");

    const meta = await fetchJson(`${BASE_URL}/api/meta?hostId=${encodeURIComponent(hostsInitial.localHostId)}`);
    assert(meta?.meta?.hostName, "Missing meta.hostName");

    const latest = await fetchJson(`${BASE_URL}/api/latest?hostId=${encodeURIComponent(hostsInitial.localHostId)}`);
    assert(latest?.sample, "Missing latest sample");
    assert(Array.isArray(latest.sample.diskVolumes), "latest sample missing diskVolumes array");
    assert(Array.isArray(latest.sample.networkInterfaces), "latest sample missing networkInterfaces array");

    const notifier = await fetchJson(`${BASE_URL}/api/notifier`);
    assert(typeof notifier.enabled === "boolean", "Notifier status missing enabled flag");

    const remoteHostId = `smoke-agent-${Date.now()}`;
    const ingestHeaders = {
      "Content-Type": "application/json"
    };
    if (AGENT_KEY) {
      ingestHeaders["X-Agent-Key"] = AGENT_KEY;
    }

    const ingestResult = await fetchJson(`${BASE_URL}/api/agent/ingest`, {
      method: "POST",
      headers: ingestHeaders,
      body: JSON.stringify({
        host: {
          id: remoteHostId,
          name: "Smoke Agent",
          source: "agent",
          meta: {
            hostId: remoteHostId,
            hostName: "Smoke Agent",
            os: "SmokeOS",
            cpuModel: "SmokeCPU",
            logicalCores: 8,
            physicalCores: 4,
            memoryTotalGb: 16,
            gpuModel: "N/A",
            platform: process.platform,
            arch: process.arch,
            capabilities: {
              gpuTelemetry: false,
              temperatureTelemetry: false,
              processTelemetry: true,
              diskTelemetry: true,
              networkRateTelemetry: true
            }
          }
        },
        sample: {
          ts: Date.now(),
          isoTime: new Date().toISOString(),
          sampleRateMs: 1000,
          cpu: 37,
          cpuFreq: 3.2,
          cpuCores: [30, 44, 41, 32],
          mem: 56,
          memUsedGb: 9,
          memTotalGb: 16,
          swap: 6,
          swapUsedGb: 0.4,
          swapTotalGb: 8,
          gpu: 0,
          gpuName: "N/A",
          gpuTemp: null,
          vram: 0,
          vramUsedGb: 0,
          vramTotalGb: 0,
          diskRead: 5.3,
          diskWrite: 1.4,
          diskLatency: 4.1,
          diskTelemetryAvailable: true,
          diskTelemetrySource: "smoke",
          diskVolumes: [{ name: "TOTAL", read: 5.3, write: 1.4, total: 6.7, latencyMs: 4.1, source: "smoke" }],
          diskLatencyEstimated: false,
          netUp: 1.2,
          netDown: 8.9,
          networkRateAvailable: true,
          networkIfaces: ["SmokeNet"],
          networkInterfaces: [{ name: "SmokeNet", up: 1.2, down: 8.9, total: 10.1, rateAvailable: true, source: "smoke" }],
          packetLoss: 0.1,
          netConnections: 42,
          temp: 51,
          tempEstimated: false,
          processTop: [{ name: "smoke.exe", cpu: 2.1, memoryMb: 120 }]
        }
      })
    });
    assert(ingestResult.ok, "Agent ingest failed");

    const remoteLatest = await fetchJson(`${BASE_URL}/api/latest?hostId=${encodeURIComponent(remoteHostId)}`);
    assert(remoteLatest?.sample, "Remote latest sample missing");

    const remoteHistory = await fetchJson(`${BASE_URL}/api/history?hostId=${encodeURIComponent(remoteHostId)}&minutes=5&source=auto&limit=20`);
    assert(Array.isArray(remoteHistory.points), "Remote history points is not an array");
    assert(remoteHistory.points.length >= 1, "Remote history did not return ingested sample");

    const remoteReplay = await fetchJson(`${BASE_URL}/api/history/replay?hostId=${encodeURIComponent(remoteHostId)}&minutes=5&replayStepMs=2000&source=auto`);
    assert(Array.isArray(remoteReplay.points), "Remote replay points is not an array");
    assert(Number(remoteReplay.replayStepMs) >= 100, "Replay stepMs missing");

    const hostsAfterIngest = await fetchJson(`${BASE_URL}/api/hosts`);
    assert(hostsAfterIngest.hosts.some((host) => host.hostId === remoteHostId), "Remote host missing from host list");

    const wsResult = await waitForWebSocketSample();
    assert(wsResult.helloSeen && wsResult.sampleSeen, "WebSocket did not stream expected messages");

    const configUpdate = await fetchJson(`${BASE_URL}/api/config`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ sampleRateMs: 500 })
    });
    assert(configUpdate.sampleRateMs === 500, "Sample rate update failed");

    const diagnostics = await fetchJson(`${BASE_URL}/api/diagnostics`);
    assert(diagnostics?.stats?.ticksTotal >= 1, "Diagnostics missing collector stats");
    assert(Array.isArray(diagnostics?.remoteHosts), "Diagnostics missing remoteHosts");

    const csvResponse = await fetch(`${BASE_URL}/api/export.csv?minutes=5&hostId=${encodeURIComponent(hostsInitial.localHostId)}`);
    assert(csvResponse.ok, "CSV export request failed");
    const contentType = csvResponse.headers.get("content-type") || "";
    assert(contentType.includes("text/csv"), "CSV export content-type mismatch");
    const csvText = await csvResponse.text();
    assert(csvText.includes("cpuFreq"), "CSV export body missing expected headers");

    const history = await fetchJson(`${BASE_URL}/api/history?minutes=5&limit=10&hostId=${encodeURIComponent(hostsInitial.localHostId)}`);
    assert(Array.isArray(history.points), "History points is not an array");

    console.log("[smoke] PASS");
    console.log(JSON.stringify({
      port: PORT,
      host: meta.meta.hostName,
      hostCount: hostsAfterIngest.count,
      points: history.count,
      sampleRateMs: configUpdate.sampleRateMs,
      ws: wsResult,
      csvBytes: csvText.length
    }, null, 2));
  } finally {
    await stopServerProcess(serverProcess);
    const exit = await processExitPromise;
    if (exit && exit.code !== 0 && exit.code !== null) {
      console.warn(`[smoke] server exit code: ${exit.code}`);
    }
  }
}

runSmokeTest().catch((error) => {
  console.error("[smoke] FAIL", error.message);
  process.exit(1);
});
