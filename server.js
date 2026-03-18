"use strict";

const http = require("http");
const os = require("os");
const path = require("path");
const { execFile } = require("child_process");
const { promisify } = require("util");

const compression = require("compression");
const express = require("express");
const si = require("systeminformation");
const WebSocket = require("ws");
const { SqliteStore } = require("./sqlite-store");
const { AlertNotifier } = require("./notifier");
const { IncidentAiAnalyzer } = require("./ai-analyzer");

const PORT = Number(process.env.PORT || 4510);
const MAX_HISTORY_POINTS = Number(process.env.HISTORY_POINT_LIMIT || 20000);
const MAX_EVENT_POINTS = Number(process.env.EVENT_POINT_LIMIT || 600);
const ALLOWED_SAMPLE_RATES = [500, 1000, 2000];
const HISTORY_TRIM_HEADROOM = 512;
const EVENT_TRIM_HEADROOM = 80;
const WINDOWS_DISK_REFRESH_INTERVAL_MS = Number(process.env.WINDOWS_DISK_REFRESH_INTERVAL_MS || 2000);
const SQLITE_DB_PATH = process.env.SQLITE_DB_PATH || path.join(__dirname, "data", "pulseforge.db");
const SQLITE_RETENTION_DAYS = Number(process.env.SQLITE_RETENTION_DAYS || 7);
const SQLITE_ENABLED = process.env.SQLITE_ENABLED !== "0";
const SQLITE_STRICT_STARTUP = process.env.SQLITE_STRICT_STARTUP !== "0";
const HELLO_BOOTSTRAP_HISTORY_MINUTES = Math.max(5, Number(process.env.HELLO_BOOTSTRAP_HISTORY_MINUTES || 15));
const AGENT_API_KEY = String(process.env.AGENT_API_KEY || "").trim();
const AGENT_BODY_LIMIT = process.env.AGENT_BODY_LIMIT || "2mb";
const HOST_ONLINE_TIMEOUT_MS = Number(process.env.HOST_ONLINE_TIMEOUT_MS || 15000);
const HISTORY_QUERY_LIMIT_MAX = Number(process.env.HISTORY_QUERY_LIMIT_MAX || 500000);
const AGENT_BATCH_LIMIT = Number(process.env.AGENT_BATCH_LIMIT || 120);

const AI_ANALYZER_ENABLED = process.env.AI_ANALYZER_ENABLED !== "0";
const AI_ANALYZER_API_KEY = String(process.env.AI_ANALYZER_API_KEY || process.env.OPENAI_API_KEY || "").trim();
const AI_ANALYZER_BASE_URL = String(process.env.AI_ANALYZER_BASE_URL || "https://api.openai.com/v1").trim();
const AI_ANALYZER_MODEL = String(process.env.AI_ANALYZER_MODEL || "gpt-4o-mini").trim();
const AI_ANALYZER_TIMEOUT_MS = Math.max(1000, Number(process.env.AI_ANALYZER_TIMEOUT_MS || 8000));
const AI_ANALYZER_MAX_INPUT_CHARS = Math.max(3000, Number(process.env.AI_ANALYZER_MAX_INPUT_CHARS || 12000));
const AI_ANALYZER_CACHE_MAX = Math.max(200, Number(process.env.AI_ANALYZER_CACHE_MAX || 5000));
const AI_ANALYZER_MAX_CONCURRENCY = Math.max(1, Number(process.env.AI_ANALYZER_MAX_CONCURRENCY || 2));
const AI_ANALYZER_QUEUE_LIMIT = Math.max(100, Number(process.env.AI_ANALYZER_QUEUE_LIMIT || 1200));

const NOTIFIER_TIMEOUT_MS = Number(process.env.NOTIFIER_TIMEOUT_MS || 5000);
const ALERT_WEBHOOK_URL = process.env.ALERT_WEBHOOK_URL;
const WECHAT_WEBHOOK_URL = process.env.WECHAT_WEBHOOK_URL;
const DINGTALK_WEBHOOK_URL = process.env.DINGTALK_WEBHOOK_URL;
const DINGTALK_SECRET = process.env.DINGTALK_SECRET;

const LOCAL_HOST_ID = sanitizeHostId(`local:${os.hostname()}`);

const execFileAsync = promisify(execFile);

const app = express();
app.use(compression());
app.use(express.json({ limit: AGENT_BODY_LIMIT }));
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type,X-Agent-Key");
  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }
  next();
});

const server = http.createServer(app);
const wss = new WebSocket.Server({ server, path: "/ws" });

const defaultSampleRate = resolveSampleRate(process.env.SAMPLE_RATE_MS);

const state = {
  sampleRateMs: defaultSampleRate,
  collectorTimer: null,
  collectorBusy: false,
  tickCount: 0,
  history: [],
  events: [],
  activeAlerts: new Map(),
  latestSample: null,
  stats: {
    ticksTotal: 0,
    ticksSucceeded: 0,
    ticksFailed: 0,
    ticksSkippedBusy: 0,
    lastTickDurationMs: 0,
    avgTickDurationMs: 0,
    peakTickDurationMs: 0,
    lastSuccessTs: 0,
    lastErrorTs: 0,
    lastErrorMessage: ""
  },
  meta: {
    hostId: LOCAL_HOST_ID,
    hostName: os.hostname(),
    os: os.type(),
    platform: process.platform,
    cpuModel: "Unknown CPU",
    logicalCores: os.cpus().length,
    memoryTotalGb: round(bytesToGb(os.totalmem()), 1),
    gpuModel: "Unknown GPU",
    startedAt: new Date().toISOString(),
    capabilities: {
      gpuTelemetry: false,
      temperatureTelemetry: false,
      processTelemetry: true,
      diskTelemetry: false,
      networkRateTelemetry: false
    }
  },
  caches: {
    processTop: [],
    networkConnections: 0,
    packetLoss: 0,
    packetSnapshot: null,
    networkByteSnapshot: null,
    networkIfaceSnapshots: {},
    windowsDisk: {
      readBytesSec: 0,
      writeBytesSec: 0,
      latencyMs: null,
      available: false,
      source: "none",
      logicalVolumes: [],
      lastTs: 0,
      errorCount: 0
    },
    processRefreshPending: false,
    connectionRefreshPending: false,
    windowsDiskRefreshPending: false
  }
};

const remoteHosts = new Map();
const socketSubscriptions = new Map();
const eventAiAnalysisCache = new Map();
const pendingEventAnalyses = new Set();
const aiAnalysisQueue = [];
let aiAnalysisInFlight = 0;
const analysisNotifyState = new Map();

const storageStatus = {
  configured: SQLITE_ENABLED,
  strictStartup: SQLITE_STRICT_STARTUP,
  ready: false,
  degraded: false,
  error: "",
  dbPath: SQLITE_DB_PATH,
  retentionDays: SQLITE_RETENTION_DAYS,
  initializedAt: 0
};

const aiAnalyzer = new IncidentAiAnalyzer({
  enabled: AI_ANALYZER_ENABLED,
  apiKey: AI_ANALYZER_API_KEY,
  baseUrl: AI_ANALYZER_BASE_URL,
  model: AI_ANALYZER_MODEL,
  timeoutMs: AI_ANALYZER_TIMEOUT_MS,
  maxInputChars: AI_ANALYZER_MAX_INPUT_CHARS
});

let storage = null;
const notifier = new AlertNotifier({
  webhookUrl: ALERT_WEBHOOK_URL,
  wechatWebhookUrl: WECHAT_WEBHOOK_URL,
  dingtalkWebhookUrl: DINGTALK_WEBHOOK_URL,
  dingtalkSecret: DINGTALK_SECRET,
  timeoutMs: NOTIFIER_TIMEOUT_MS
});

const ALERT_RULES = [
  {
    key: "cpuHigh",
    level: "danger",
    trigger: (sample) => sample.cpu >= 90,
    up: (sample) => `CPU 高负载 ${sample.cpu.toFixed(0)}%`,
    down: "CPU 负载恢复正常"
  },
  {
    key: "memHigh",
    level: "danger",
    trigger: (sample) => sample.mem >= 88,
    up: (sample) => `内存压力过高 ${sample.mem.toFixed(0)}%`,
    down: "内存占用恢复正常"
  },
  {
    key: "tempHigh",
    level: "danger",
    trigger: (sample) => sample.temp >= 82,
    up: (sample) => `核心温度过高 ${sample.temp.toFixed(0)}°C`,
    down: "核心温度恢复正常"
  },
  {
    key: "diskSlow",
    level: "warn",
    trigger: (sample) => sample.diskLatency >= 22,
    up: (sample) => `磁盘延迟偏高 ${sample.diskLatency.toFixed(1)}ms`,
    down: "磁盘延迟恢复正常"
  },
  {
    key: "netLoss",
    level: "warn",
    trigger: (sample) => sample.packetLoss >= 1.2,
    up: (sample) => `网络丢包偏高 ${sample.packetLoss.toFixed(2)}%`,
    down: "网络丢包恢复正常"
  }
];

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 1) {
  const numberValue = Number(value);
  if (!Number.isFinite(numberValue)) {
    return 0;
  }
  return Number(numberValue.toFixed(digits));
}

function bytesToGb(bytes) {
  return Number(bytes || 0) / (1024 ** 3);
}

function bytesPerSecToMb(bytesPerSec) {
  return Number(bytesPerSec || 0) / (1024 ** 2);
}

function firstFinite(values, fallback = null) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const numberValue = Number(value);
    if (Number.isFinite(numberValue)) {
      return numberValue;
    }
  }
  return fallback;
}

function normalizeToMb(rawValue) {
  const value = Number(rawValue);
  if (!Number.isFinite(value) || value <= 0) {
    return 0;
  }
  if (value > 1024 * 1024) {
    return value / (1024 ** 2);
  }
  return value;
}

function resolveSampleRate(sampleRateInput) {
  const sampleRate = Number(sampleRateInput);
  if (!Number.isFinite(sampleRate)) {
    return 1000;
  }
  if (ALLOWED_SAMPLE_RATES.includes(sampleRate)) {
    return sampleRate;
  }
  return ALLOWED_SAMPLE_RATES.reduce((nearest, current) => {
    const currentDelta = Math.abs(current - sampleRate);
    const nearestDelta = Math.abs(nearest - sampleRate);
    return currentDelta < nearestDelta ? current : nearest;
  }, ALLOWED_SAMPLE_RATES[0]);
}

function sanitizeHostId(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return "host-unknown";
  }

  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "host-unknown";
}

function safeHostName(input, fallbackValue = "Unknown Host") {
  const value = String(input || "").trim();
  return value.length > 0 ? value.slice(0, 120) : fallbackValue;
}

function createRemoteHostRuntime({ hostId, hostName, source = "agent", meta = {} }) {
  const now = Date.now();
  return {
    hostId,
    hostName,
    source,
    firstSeenTs: now,
    lastSeenTs: now,
    meta: {
      hostId,
      hostName,
      source,
      os: String(meta.os || "Unknown OS"),
      cpuModel: String(meta.cpuModel || "Unknown CPU"),
      logicalCores: Number(meta.logicalCores || 0),
      physicalCores: Number(meta.physicalCores || 0),
      memoryTotalGb: Number(meta.memoryTotalGb || 0),
      gpuModel: String(meta.gpuModel || "N/A"),
      platform: String(meta.platform || "unknown"),
      arch: String(meta.arch || "unknown"),
      capabilities: {
        gpuTelemetry: Boolean(meta?.capabilities?.gpuTelemetry),
        temperatureTelemetry: Boolean(meta?.capabilities?.temperatureTelemetry),
        processTelemetry: Boolean(meta?.capabilities?.processTelemetry),
        diskTelemetry: Boolean(meta?.capabilities?.diskTelemetry),
        networkRateTelemetry: Boolean(meta?.capabilities?.networkRateTelemetry)
      }
    },
    latestSample: null,
    history: [],
    events: [],
    activeAlerts: new Map(),
    stats: {
      receivedSamples: 0,
      receivedEvents: 0,
      lastIngestTs: 0
    }
  };
}

function mergeHostMeta(targetMeta, patchMeta) {
  if (!patchMeta || typeof patchMeta !== "object") {
    return targetMeta;
  }

  const merged = {
    ...targetMeta,
    ...patchMeta,
    hostId: targetMeta.hostId,
    hostName: safeHostName(patchMeta.hostName || targetMeta.hostName, targetMeta.hostName),
    source: String(patchMeta.source || targetMeta.source || "agent"),
    capabilities: {
      ...(targetMeta.capabilities || {}),
      ...(patchMeta.capabilities || {})
    }
  };

  return merged;
}

function getOrCreateRemoteHost(hostId, hostName, meta = {}, source = "agent") {
  const normalizedHostId = sanitizeHostId(hostId);
  const normalizedHostName = safeHostName(hostName, normalizedHostId);

  if (!remoteHosts.has(normalizedHostId)) {
    remoteHosts.set(normalizedHostId, createRemoteHostRuntime({
      hostId: normalizedHostId,
      hostName: normalizedHostName,
      source,
      meta
    }));
  }

  const runtime = remoteHosts.get(normalizedHostId);
  runtime.hostName = normalizedHostName;
  runtime.source = String(source || runtime.source || "agent");
  runtime.lastSeenTs = Date.now();
  runtime.meta = mergeHostMeta(runtime.meta, {
    ...meta,
    hostName: normalizedHostName,
    source: runtime.source
  });

  return runtime;
}

function isHostOnline(lastSeenTs) {
  return (Date.now() - Number(lastSeenTs || 0)) <= HOST_ONLINE_TIMEOUT_MS;
}

function localHostSnapshot() {
  return {
    hostId: LOCAL_HOST_ID,
    hostName: safeHostName(state.meta.hostName || os.hostname(), os.hostname()),
    source: "local",
    firstSeenTs: Date.parse(state.meta.startedAt || new Date().toISOString()),
    lastSeenTs: state.latestSample?.ts || Date.now(),
    meta: state.meta,
    latestSample: state.latestSample,
    activeAlerts: Array.from(state.activeAlerts.values()),
    events: state.events,
    history: state.history,
    stats: state.stats
  };
}

function getHostSnapshot(hostIdInput) {
  const hostId = sanitizeHostId(hostIdInput || LOCAL_HOST_ID);
  if (!hostId || hostId === LOCAL_HOST_ID) {
    return localHostSnapshot();
  }

  return remoteHosts.get(hostId) || null;
}

function readHostHistoryFromMemory(hostSnapshot, fromTs, toTs, limit) {
  const source = Array.isArray(hostSnapshot?.history) ? hostSnapshot.history : [];
  const filtered = source.filter((sample) => sample.ts >= fromTs && sample.ts <= toTs);
  if (filtered.length <= limit) {
    return filtered;
  }
  return filtered.slice(filtered.length - limit);
}

function readHostEventsFromMemory(hostSnapshot, fromTs, toTs, limit) {
  const source = Array.isArray(hostSnapshot?.events) ? hostSnapshot.events : [];
  const filtered = source.filter((event) => event.ts >= fromTs && event.ts <= toTs);
  if (filtered.length <= limit) {
    return filtered;
  }
  return filtered.slice(0, limit);
}

function hostListFromMemory() {
  const local = localHostSnapshot();
  const hosts = [local];
  for (const runtime of remoteHosts.values()) {
    hosts.push(runtime);
  }

  return hosts.map((host) => {
    const latestSample = host.latestSample || null;
    return {
      hostId: host.hostId,
      hostName: host.hostName,
      source: host.source,
      online: isHostOnline(host.lastSeenTs),
      firstSeenTs: host.firstSeenTs,
      lastSeenTs: host.lastSeenTs,
      cpu: latestSample?.cpu ?? null,
      mem: latestSample?.mem ?? null,
      temp: latestSample?.temp ?? null,
      activeAlertCount: Array.isArray(latestSample?.activeAlerts)
        ? latestSample.activeAlerts.length
        : (Array.isArray(host.activeAlerts) ? host.activeAlerts.length : host.activeAlerts?.size || 0)
    };
  });
}

function mergeHostsWithStorage(memoryHosts, storageHosts) {
  const merged = new Map();

  for (const host of storageHosts) {
    merged.set(host.hostId, {
      hostId: host.hostId,
      hostName: safeHostName(host.hostName, host.hostId),
      source: host.source || "unknown",
      online: false,
      firstSeenTs: host.firstSeenTs,
      lastSeenTs: host.lastSeenTs,
      cpu: null,
      mem: null,
      temp: null,
      activeAlertCount: 0
    });
  }

  for (const host of memoryHosts) {
    merged.set(host.hostId, {
      ...(merged.get(host.hostId) || {}),
      ...host,
      hostName: safeHostName(host.hostName, host.hostId),
      online: host.online
    });
  }

  return Array.from(merged.values()).sort((left, right) => {
    if (left.hostId === LOCAL_HOST_ID && right.hostId !== LOCAL_HOST_ID) {
      return -1;
    }
    if (right.hostId === LOCAL_HOST_ID && left.hostId !== LOCAL_HOST_ID) {
      return 1;
    }
    return (right.lastSeenTs || 0) - (left.lastSeenTs || 0);
  });
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalized)) {
    return false;
  }
  return fallback;
}

function normalizeStorageSourceMode(input) {
  const value = String(input || "auto").trim().toLowerCase();
  if (value === "memory" || value === "sqlite" || value === "auto") {
    return value;
  }
  return "auto";
}

function safeTimestamp(rawValue, fallbackValue = Date.now()) {
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed)) {
    return Math.max(0, Math.round(fallbackValue));
  }
  return Math.max(0, Math.round(parsed));
}

function resolveHostIdFromInput(hostIdInput, fallbackValue = LOCAL_HOST_ID) {
  return sanitizeHostId(hostIdInput || fallbackValue);
}

function isLocalHostId(hostIdInput) {
  return resolveHostIdFromInput(hostIdInput) === LOCAL_HOST_ID;
}

function historyLimit(value, fallback = 600) {
  const maxLimit = Math.max(20000, HISTORY_QUERY_LIMIT_MAX);
  return sanitizeLimit(value, fallback, maxLimit);
}

function resolveQueryWindow(query) {
  const now = Date.now();
  const toTs = safeTimestamp(query?.toTs, now);
  const hasFromTs = Number.isFinite(Number(query?.fromTs));
  const minutes = parseWindowMinutes(query?.minutes);
  const defaultFromTs = Math.max(0, toTs - minutes * 60 * 1000);
  const fromTs = hasFromTs
    ? safeTimestamp(query.fromTs, defaultFromTs)
    : defaultFromTs;

  const normalizedFromTs = Math.min(fromTs, toTs);
  const derivedMinutes = Math.max(1, Math.round((toTs - normalizedFromTs) / 60000));

  return {
    fromTs: normalizedFromTs,
    toTs,
    minutes: hasFromTs ? derivedMinutes : minutes
  };
}

function latestHostList() {
  const memoryHosts = hostListFromMemory();
  if (!storage) {
    return mergeHostsWithStorage(memoryHosts, []);
  }

  try {
    const storageHosts = storage.getHosts();
    return mergeHostsWithStorage(memoryHosts, storageHosts);
  } catch (error) {
    console.warn(`[storage] getHosts failed: ${error.message}`);
    return mergeHostsWithStorage(memoryHosts, []);
  }
}

function getStoredHostById(hostIdInput) {
  const hostId = resolveHostIdFromInput(hostIdInput);
  if (!storage) {
    return null;
  }

  try {
    const hosts = storage.getHosts();
    return hosts.find((host) => host.hostId === hostId) || null;
  } catch (error) {
    console.warn(`[storage] lookup host failed: ${error.message}`);
    return null;
  }
}

function applyReplayStep(points, fromTs, stepMs) {
  const safeStep = Math.max(100, Number(stepMs) || 1000);
  const source = Array.isArray(points) ? points : [];
  if (source.length <= 2) {
    return source;
  }

  const replay = [];
  let nextTs = Number(fromTs) || source[0].ts;
  for (const sample of source) {
    if (sample.ts >= nextTs || replay.length === 0) {
      replay.push(sample);
      nextTs = sample.ts + safeStep;
    }
  }

  const last = source[source.length - 1];
  if (replay[replay.length - 1]?.ts !== last?.ts) {
    replay.push(last);
  }

  return replay;
}

function readHostHistoryFromStorage(hostIdInput, { fromTs, toTs, limit, replayStepMs = 0 } = {}) {
  const hostId = resolveHostIdFromInput(hostIdInput);
  if (!storage) {
    return [];
  }

  try {
    if (replayStepMs > 0) {
      return storage.getSamplesReplay(hostId, {
        fromTs,
        toTs,
        limit,
        stepMs: replayStepMs
      });
    }

    return storage.getSamples(hostId, {
      fromTs,
      toTs,
      limit
    });
  } catch (error) {
    console.warn(`[storage] read history failed: ${error.message}`);
    return [];
  }
}

function readHostEventsFromStorage(hostIdInput, { fromTs, toTs, limit } = {}) {
  const hostId = resolveHostIdFromInput(hostIdInput);
  if (!storage) {
    return [];
  }

  try {
    return storage.getEvents(hostId, {
      fromTs,
      toTs,
      limit
    });
  } catch (error) {
    console.warn(`[storage] read events failed: ${error.message}`);
    return [];
  }
}

function readHostHistoryBySource(hostIdInput, {
  fromTs,
  toTs,
  limit,
  sourceMode = "auto",
  replayStepMs = 0
} = {}) {
  const hostId = resolveHostIdFromInput(hostIdInput);
  const normalizedSource = normalizeStorageSourceMode(sourceMode);
  const safeLimit = historyLimit(limit, 600);
  const hostSnapshot = getHostSnapshot(hostId);

  if (normalizedSource === "memory") {
    const memoryPoints = readHostHistoryFromMemory(hostSnapshot, fromTs, toTs, safeLimit);
    return {
      points: replayStepMs > 0 ? applyReplayStep(memoryPoints, fromTs, replayStepMs) : memoryPoints,
      source: "memory"
    };
  }

  if (normalizedSource === "sqlite") {
    if (!storage) {
      const memoryPoints = readHostHistoryFromMemory(hostSnapshot, fromTs, toTs, safeLimit);
      return {
        points: replayStepMs > 0 ? applyReplayStep(memoryPoints, fromTs, replayStepMs) : memoryPoints,
        source: "memory-fallback"
      };
    }

    const points = readHostHistoryFromStorage(hostId, {
      fromTs,
      toTs,
      limit: safeLimit,
      replayStepMs
    });
    return {
      points,
      source: storage ? "sqlite" : "memory-fallback"
    };
  }

  const sqlitePoints = readHostHistoryFromStorage(hostId, {
    fromTs,
    toTs,
    limit: safeLimit,
    replayStepMs
  });
  if (sqlitePoints.length > 0) {
    return {
      points: sqlitePoints,
      source: "sqlite"
    };
  }

  const memoryPoints = readHostHistoryFromMemory(hostSnapshot, fromTs, toTs, safeLimit);
  return {
    points: replayStepMs > 0 ? applyReplayStep(memoryPoints, fromTs, replayStepMs) : memoryPoints,
    source: "memory"
  };
}

function readHostEventsBySource(hostIdInput, {
  fromTs,
  toTs,
  limit,
  sourceMode = "auto"
} = {}) {
  const hostId = resolveHostIdFromInput(hostIdInput);
  const normalizedSource = normalizeStorageSourceMode(sourceMode);
  const safeLimit = sanitizeLimit(limit, 120, Math.max(MAX_EVENT_POINTS, 5000));
  const hostSnapshot = getHostSnapshot(hostId);

  if (normalizedSource === "memory") {
    return {
      events: readHostEventsFromMemory(hostSnapshot, fromTs, toTs, safeLimit),
      source: "memory"
    };
  }

  if (normalizedSource === "sqlite") {
    if (!storage) {
      return {
        events: readHostEventsFromMemory(hostSnapshot, fromTs, toTs, safeLimit),
        source: "memory-fallback"
      };
    }

    return {
      events: readHostEventsFromStorage(hostId, {
        fromTs,
        toTs,
        limit: safeLimit
      }),
      source: storage ? "sqlite" : "memory-fallback"
    };
  }

  const sqliteEvents = readHostEventsFromStorage(hostId, {
    fromTs,
    toTs,
    limit: safeLimit
  });
  if (sqliteEvents.length > 0) {
    return {
      events: sqliteEvents,
      source: "sqlite"
    };
  }

  return {
    events: readHostEventsFromMemory(hostSnapshot, fromTs, toTs, safeLimit),
    source: "memory"
  };
}

function activeAlertsFromHostSnapshot(hostSnapshot) {
  if (!hostSnapshot) {
    return [];
  }

  if (Array.isArray(hostSnapshot.activeAlerts)) {
    return hostSnapshot.activeAlerts;
  }

  if (hostSnapshot.activeAlerts instanceof Map) {
    return Array.from(hostSnapshot.activeAlerts.values());
  }

  return [];
}

function resolveHostMeta(hostIdInput) {
  const hostId = resolveHostIdFromInput(hostIdInput);
  const hostSnapshot = getHostSnapshot(hostId);
  if (hostSnapshot?.meta) {
    return hostSnapshot.meta;
  }

  const storedHost = getStoredHostById(hostId);
  if (storedHost?.meta) {
    return {
      ...storedHost.meta,
      hostId: storedHost.hostId,
      hostName: safeHostName(storedHost.hostName, storedHost.hostId),
      source: String(storedHost.source || "unknown")
    };
  }

  if (hostId === LOCAL_HOST_ID) {
    return state.meta;
  }

  return null;
}

function formatClock(timestamp) {
  return new Date(timestamp).toLocaleTimeString("zh-CN", { hour12: false });
}

function parseWindowMinutes(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) {
    return 5;
  }
  return clamp(Math.round(minutes), 1, 180);
}

function sanitizeLimit(value, fallback, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return clamp(Math.round(parsed), 1, max);
}

function pickGpuController(graphicsInfo) {
  const controllers = Array.isArray(graphicsInfo?.controllers) ? graphicsInfo.controllers : [];
  if (!controllers.length) {
    return null;
  }

  return controllers
    .map((controller) => {
      const utilization = firstFinite([
        controller.utilizationGpu,
        controller.utilization,
        controller.memoryUtilization
      ], 0);
      const memoryTotalMb = normalizeToMb(firstFinite([controller.memoryTotal, controller.vram], 0));
      const memoryUsedMb = normalizeToMb(firstFinite([controller.memoryUsed], 0));
      const temperature = firstFinite([controller.temperatureGpu, controller.temperature], null);
      return {
        model: controller.model || controller.name || "Unknown GPU",
        utilization,
        memoryTotalMb,
        memoryUsedMb,
        temperature
      };
    })
    .sort((left, right) => right.utilization - left.utilization)[0];
}

function aggregateNetworkStats(rawStats) {
  const stats = Array.isArray(rawStats) ? rawStats : [rawStats].filter(Boolean);

  const activeByState = stats.filter((item) => String(item?.operstate || "").toLowerCase() === "up");
  const sourceStats = activeByState.length > 0 ? activeByState : stats;
  const nonLoopback = sourceStats.filter((item) => {
    const ifaceName = String(item?.iface || "");
    return !/loopback|^lo$/i.test(ifaceName);
  });
  const effectiveStats = nonLoopback.length > 0 ? nonLoopback : sourceStats;
  const ifaces = effectiveStats
    .map((item) => String(item?.iface || ""))
    .filter((name) => name.length > 0);

  const previousSnapshots = state.caches.networkIfaceSnapshots || {};
  const nextSnapshots = {};
  const now = Date.now();

  const summary = {
    rxSec: 0,
    txSec: 0,
    rxBytes: 0,
    txBytes: 0,
    rxPackets: 0,
    txPackets: 0,
    rxDropped: 0,
    txDropped: 0,
    ifaces,
    interfaces: []
  };

  for (const item of effectiveStats) {
    const ifaceName = String(item?.iface || "").trim();
    if (!ifaceName) {
      continue;
    }

    const rxBytes = firstFinite([item.rx_bytes], NaN);
    const txBytes = firstFinite([item.tx_bytes], NaN);
    const rxPackets = firstFinite([item.rx_packets], 0);
    const txPackets = firstFinite([item.tx_packets], 0);
    const rxDropped = firstFinite([item.rx_dropped], 0);
    const txDropped = firstFinite([item.tx_dropped], 0);

    let rxSec = firstFinite([item.rx_sec], NaN);
    let txSec = firstFinite([item.tx_sec], NaN);

    const hasDirectRate = Number.isFinite(rxSec) || Number.isFinite(txSec);
    const hasByteCounters = Number.isFinite(rxBytes) || Number.isFinite(txBytes);

    let rateFromDelta = false;
    if (!hasDirectRate && hasByteCounters) {
      const previous = previousSnapshots[ifaceName];
      if (previous && now > previous.ts) {
        const seconds = (now - previous.ts) / 1000;
        if (seconds > 0) {
          if (Number.isFinite(rxBytes) && Number.isFinite(previous.rxBytes)) {
            rxSec = Math.max(0, (rxBytes - previous.rxBytes) / seconds);
          }
          if (Number.isFinite(txBytes) && Number.isFinite(previous.txBytes)) {
            txSec = Math.max(0, (txBytes - previous.txBytes) / seconds);
          }
          rateFromDelta = true;
        }
      }
    }

    const safeRxSec = Number.isFinite(rxSec) ? Math.max(0, rxSec) : 0;
    const safeTxSec = Number.isFinite(txSec) ? Math.max(0, txSec) : 0;
    const safeRxBytes = Number.isFinite(rxBytes) ? Math.max(0, rxBytes) : 0;
    const safeTxBytes = Number.isFinite(txBytes) ? Math.max(0, txBytes) : 0;

    nextSnapshots[ifaceName] = {
      ts: now,
      rxBytes: safeRxBytes,
      txBytes: safeTxBytes
    };

    summary.rxSec += safeRxSec;
    summary.txSec += safeTxSec;
    summary.rxBytes += safeRxBytes;
    summary.txBytes += safeTxBytes;
    summary.rxPackets += rxPackets;
    summary.txPackets += txPackets;
    summary.rxDropped += rxDropped;
    summary.txDropped += txDropped;

    summary.interfaces.push({
      name: ifaceName,
      rxSec: safeRxSec,
      txSec: safeTxSec,
      totalSec: safeRxSec + safeTxSec,
      rateAvailable: hasDirectRate || (hasByteCounters && rateFromDelta),
      rxBytes: safeRxBytes,
      txBytes: safeTxBytes,
      operstate: String(item?.operstate || "")
    });
  }

  state.caches.networkIfaceSnapshots = nextSnapshots;

  summary.interfaces.sort((left, right) => {
    if (right.totalSec !== left.totalSec) {
      return right.totalSec - left.totalSec;
    }
    return left.name.localeCompare(right.name);
  });

  return summary;
}

function updatePacketLoss(aggregateNet) {
  const currentSnapshot = {
    dropped: aggregateNet.rxDropped + aggregateNet.txDropped,
    packets: aggregateNet.rxPackets + aggregateNet.txPackets
  };

  const previousSnapshot = state.caches.packetSnapshot;
  state.caches.packetSnapshot = currentSnapshot;

  if (!previousSnapshot) {
    return state.caches.packetLoss;
  }

  const droppedDelta = currentSnapshot.dropped - previousSnapshot.dropped;
  const packetsDelta = currentSnapshot.packets - previousSnapshot.packets;

  if (packetsDelta > 0 && droppedDelta >= 0) {
    state.caches.packetLoss = clamp((droppedDelta / packetsDelta) * 100, 0, 100);
  } else {
    state.caches.packetLoss = Math.max(0, state.caches.packetLoss * 0.94);
  }

  return state.caches.packetLoss;
}

function resolveNetworkRates(aggregateNet) {
  let rxSec = aggregateNet.rxSec;
  let txSec = aggregateNet.txSec;

  const now = Date.now();
  const hasDirectRate = Array.isArray(aggregateNet.interfaces)
    ? aggregateNet.interfaces.some((item) => item.rateAvailable)
    : (rxSec > 0 || txSec > 0);
  const hasByteCounters = aggregateNet.rxBytes > 0 || aggregateNet.txBytes > 0;

  if (!hasDirectRate && hasByteCounters) {
    const previous = state.caches.networkByteSnapshot;
    if (previous && now > previous.ts) {
      const seconds = (now - previous.ts) / 1000;
      if (seconds > 0) {
        rxSec = Math.max(0, (aggregateNet.rxBytes - previous.rxBytes) / seconds);
        txSec = Math.max(0, (aggregateNet.txBytes - previous.txBytes) / seconds);
      }
    }
  }

  if (hasByteCounters) {
    state.caches.networkByteSnapshot = {
      ts: now,
      rxBytes: aggregateNet.rxBytes,
      txBytes: aggregateNet.txBytes
    };
  }

  return {
    rxSec: Number.isFinite(rxSec) ? rxSec : 0,
    txSec: Number.isFinite(txSec) ? txSec : 0,
    available: hasDirectRate || hasByteCounters
  };
}

function counterMetricFromPath(pathText) {
  const lower = String(pathText || "").toLowerCase();
  if (lower.includes("disk read bytes/sec")) {
    return "read";
  }
  if (lower.includes("disk write bytes/sec")) {
    return "write";
  }
  if (lower.includes("avg. disk sec/transfer")) {
    return "latency";
  }
  return null;
}

function normalizeVolumeName(instanceName) {
  const raw = String(instanceName || "").trim();
  if (!raw) {
    return "";
  }
  if (raw === "_total") {
    return "_total";
  }
  return raw.toUpperCase();
}

async function refreshWindowsDiskTelemetry(force = false) {
  if (process.platform !== "win32") {
    return;
  }
  if (state.caches.windowsDiskRefreshPending) {
    return;
  }

  const now = Date.now();
  if (
    !force
    && state.caches.windowsDisk.lastTs > 0
    && (now - state.caches.windowsDisk.lastTs) < WINDOWS_DISK_REFRESH_INTERVAL_MS
  ) {
    return;
  }

  state.caches.windowsDiskRefreshPending = true;
  try {
    const script = [
      "$samples=(Get-Counter -Counter",
      "'\\PhysicalDisk(_Total)\\Disk Read Bytes/sec',",
      "'\\PhysicalDisk(_Total)\\Disk Write Bytes/sec',",
      "'\\PhysicalDisk(_Total)\\Avg. Disk sec/Transfer',",
      "'\\LogicalDisk(*)\\Disk Read Bytes/sec',",
      "'\\LogicalDisk(*)\\Disk Write Bytes/sec',",
      "'\\LogicalDisk(*)\\Avg. Disk sec/Transfer').CounterSamples;",
      "$samples | Select-Object Path,InstanceName,CookedValue | ConvertTo-Json -Compress"
    ].join(" ");

    const { stdout } = await execFileAsync("powershell", ["-NoProfile", "-Command", script], {
      windowsHide: true,
      timeout: 5000,
      maxBuffer: 1024 * 1024
    });

    const text = String(stdout || "").trim();
    if (!text) {
      throw new Error("empty counter output");
    }

    const parsed = JSON.parse(text);
    const samples = Array.isArray(parsed) ? parsed : [parsed];

    let readBytesSec = NaN;
    let writeBytesSec = NaN;
    let latencyMs = NaN;
    let totalReadSeen = false;
    let totalWriteSeen = false;
    let totalLatencySeen = false;

    let logicalTotalReadBytesSec = NaN;
    let logicalTotalWriteBytesSec = NaN;
    let logicalTotalLatencyMs = NaN;
    let logicalTotalReadSeen = false;
    let logicalTotalWriteSeen = false;
    let logicalTotalLatencySeen = false;

    const logicalMap = new Map();

    for (const sample of samples) {
      const pathText = String(sample?.Path || "").toLowerCase();
      const cookedValue = Number(sample?.CookedValue);
      if (!Number.isFinite(cookedValue)) {
        continue;
      }

      const metric = counterMetricFromPath(pathText);
      if (!metric) {
        continue;
      }

      const instance = normalizeVolumeName(sample?.InstanceName);

      const isPhysicalTotal = pathText.includes("\\physicaldisk(") && instance === "_total";
      if (isPhysicalTotal) {
        if (metric === "read") {
          readBytesSec = Math.max(0, cookedValue);
          totalReadSeen = true;
          continue;
        }
        if (metric === "write") {
          writeBytesSec = Math.max(0, cookedValue);
          totalWriteSeen = true;
          continue;
        }
        if (metric === "latency") {
          latencyMs = Math.max(0, cookedValue * 1000);
          totalLatencySeen = true;
          continue;
        }
      }

      const isLogicalDisk = pathText.includes("\\logicaldisk(");
      if (!isLogicalDisk) {
        continue;
      }

      if (instance === "_total") {
        if (metric === "read") {
          logicalTotalReadBytesSec = Math.max(0, cookedValue);
          logicalTotalReadSeen = true;
          continue;
        }
        if (metric === "write") {
          logicalTotalWriteBytesSec = Math.max(0, cookedValue);
          logicalTotalWriteSeen = true;
          continue;
        }
        if (metric === "latency") {
          logicalTotalLatencyMs = Math.max(0, cookedValue * 1000);
          logicalTotalLatencySeen = true;
          continue;
        }
      }

      if (!instance || instance.startsWith("HARDDISKVOLUME")) {
        continue;
      }

      if (!logicalMap.has(instance)) {
        logicalMap.set(instance, {
          name: instance,
          readBytesSec: NaN,
          writeBytesSec: NaN,
          latencyMs: NaN,
          readSeen: false,
          writeSeen: false,
          latencySeen: false
        });
      }
      const entry = logicalMap.get(instance);

      if (metric === "read") {
        entry.readBytesSec = Math.max(0, cookedValue);
        entry.readSeen = true;
        continue;
      }
      if (metric === "write") {
        entry.writeBytesSec = Math.max(0, cookedValue);
        entry.writeSeen = true;
        continue;
      }
      if (metric === "latency") {
        entry.latencyMs = Math.max(0, cookedValue * 1000);
        entry.latencySeen = true;
      }
    }

    if (!totalReadSeen && logicalTotalReadSeen) {
      readBytesSec = logicalTotalReadBytesSec;
      totalReadSeen = true;
    }
    if (!totalWriteSeen && logicalTotalWriteSeen) {
      writeBytesSec = logicalTotalWriteBytesSec;
      totalWriteSeen = true;
    }
    if (!totalLatencySeen && logicalTotalLatencySeen) {
      latencyMs = logicalTotalLatencyMs;
      totalLatencySeen = true;
    }

    const logicalVolumes = Array.from(logicalMap.values())
      .filter((entry) => entry.readSeen || entry.writeSeen || entry.latencySeen)
      .map((entry) => {
        const safeRead = entry.readSeen ? entry.readBytesSec : 0;
        const safeWrite = entry.writeSeen ? entry.writeBytesSec : 0;
        const safeLatency = entry.latencySeen ? entry.latencyMs : null;
        return {
          name: entry.name,
          readBytesSec: safeRead,
          writeBytesSec: safeWrite,
          latencyMs: Number.isFinite(safeLatency) ? safeLatency : null,
          totalBytesSec: safeRead + safeWrite
        };
      })
      .sort((left, right) => left.name.localeCompare(right.name));

    const available = totalReadSeen || totalWriteSeen || totalLatencySeen || logicalVolumes.length > 0;
    state.caches.windowsDisk = {
      readBytesSec: totalReadSeen ? Math.max(0, readBytesSec) : 0,
      writeBytesSec: totalWriteSeen ? Math.max(0, writeBytesSec) : 0,
      latencyMs: totalLatencySeen && Number.isFinite(latencyMs) ? latencyMs : null,
      available,
      source: available ? "windows-counter" : "none",
      logicalVolumes,
      lastTs: now,
      errorCount: 0
    };

    state.meta.capabilities.diskTelemetry = state.meta.capabilities.diskTelemetry || available;
  } catch (error) {
    const nextErrorCount = state.caches.windowsDisk.errorCount + 1;
    state.caches.windowsDisk = {
      ...state.caches.windowsDisk,
      source: state.caches.windowsDisk.available ? state.caches.windowsDisk.source : "none",
      lastTs: now,
      errorCount: nextErrorCount
    };

    if (nextErrorCount <= 3 || nextErrorCount % 10 === 0) {
      console.warn(`[collector] windows disk counter failed: ${error.message}`);
    }
  } finally {
    state.caches.windowsDiskRefreshPending = false;
  }
}

function createEvent({ key, level, type, content, ts }) {
  const timestamp = safeTimestamp(ts, Date.now());
  return {
    id: `${timestamp}-${key}-${Math.round(Math.random() * 100000)}`,
    key,
    level,
    type,
    content,
    ts: timestamp,
    time: formatClock(timestamp)
  };
}

function appendEventsBuffer(targetEvents, newEvents) {
  if (!Array.isArray(targetEvents) || !Array.isArray(newEvents) || newEvents.length === 0) {
    return;
  }

  targetEvents.unshift(...newEvents);
  if (targetEvents.length > MAX_EVENT_POINTS + EVENT_TRIM_HEADROOM) {
    targetEvents.splice(MAX_EVENT_POINTS);
  }
}

function activeAlertsFromMap(alertMap) {
  return Array.from(alertMap.values()).map((alert) => ({
    key: alert.key,
    level: alert.level,
    message: alert.message,
    sinceTs: alert.sinceTs,
    sinceTime: formatClock(alert.sinceTs)
  }));
}

function evaluateAlertsForTarget(sample, alertMap, eventBuffer) {
  const newEvents = [];
  const sampleTs = safeTimestamp(sample?.ts, Date.now());

  for (const rule of ALERT_RULES) {
    const active = rule.trigger(sample);
    const existing = alertMap.get(rule.key);

    if (active && !existing) {
      const activeAlert = {
        key: rule.key,
        level: rule.level,
        message: rule.up(sample),
        sinceTs: sampleTs
      };
      alertMap.set(rule.key, activeAlert);
      newEvents.push(createEvent({
        key: rule.key,
        level: rule.level,
        type: "trigger",
        content: activeAlert.message,
        ts: sampleTs
      }));
      continue;
    }

    if (active && existing) {
      existing.message = rule.up(sample);
      continue;
    }

    if (!active && existing) {
      alertMap.delete(rule.key);
      newEvents.push(createEvent({
        key: rule.key,
        level: "info",
        type: "resolve",
        content: rule.down,
        ts: sampleTs
      }));
    }
  }

  appendEventsBuffer(eventBuffer, newEvents);
  sample.activeAlerts = activeAlertsFromMap(alertMap);
  sample.events = newEvents;
  return newEvents;
}

function evaluateAlerts(sample) {
  evaluateAlertsForTarget(sample, state.activeAlerts, state.events);
}

function appendHistory(sample) {
  state.history.push(sample);
  if (state.history.length > MAX_HISTORY_POINTS + HISTORY_TRIM_HEADROOM) {
    state.history.splice(0, state.history.length - MAX_HISTORY_POINTS);
  }
}

function appendHostHistory(hostRuntime, sample) {
  if (!hostRuntime || !Array.isArray(hostRuntime.history)) {
    return;
  }

  hostRuntime.history.push(sample);
  if (hostRuntime.history.length > MAX_HISTORY_POINTS + HISTORY_TRIM_HEADROOM) {
    hostRuntime.history.splice(0, hostRuntime.history.length - MAX_HISTORY_POINTS);
  }
}

function lowerBoundByTimestamp(samples, targetTs) {
  let left = 0;
  let right = samples.length;

  while (left < right) {
    const middle = Math.floor((left + right) / 2);
    if (samples[middle].ts < targetTs) {
      left = middle + 1;
    } else {
      right = middle;
    }
  }

  return left;
}

function readHistoryWindow(minutes, limit) {
  const cutoff = Date.now() - minutes * 60 * 1000;
  const startIndex = lowerBoundByTimestamp(state.history, cutoff);
  const filtered = state.history.slice(startIndex);
  if (!Number.isFinite(limit)) {
    return filtered;
  }
  const safeLimit = sanitizeLimit(limit, 600, 20000);
  if (filtered.length <= safeLimit) {
    return filtered;
  }
  return filtered.slice(filtered.length - safeLimit);
}

async function safeCall(operationName, promise, fallbackValue, timeoutMs = 2500) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => {
      reject(new Error("timeout"));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    console.warn(`[collector] ${operationName} failed: ${error.message}`);
    return fallbackValue;
  }
}

async function refreshMeta() {
  const [osInfo, cpuInfo, memInfo, graphicsInfo] = await Promise.all([
    safeCall("osInfo", si.osInfo(), null),
    safeCall("cpu", si.cpu(), null),
    safeCall("mem", si.mem(), null),
    safeCall("graphics", si.graphics(), null)
  ]);

  const gpu = pickGpuController(graphicsInfo);

  state.meta = {
    ...state.meta,
    hostName: os.hostname(),
    os: `${osInfo?.distro || os.type()} ${osInfo?.release || ""}`.trim(),
    platform: osInfo?.platform || process.platform,
    arch: osInfo?.arch || process.arch,
    cpuModel: cpuInfo?.brand || cpuInfo?.manufacturer || "Unknown CPU",
    logicalCores: Number(cpuInfo?.cores || os.cpus().length || 0),
    physicalCores: Number(cpuInfo?.physicalCores || 0),
    memoryTotalGb: round(bytesToGb(memInfo?.total || os.totalmem()), 1),
    gpuModel: gpu?.model || "N/A",
    startedAt: state.meta.startedAt,
    capabilities: {
      gpuTelemetry: Boolean(gpu),
      temperatureTelemetry: state.meta.capabilities.temperatureTelemetry,
      processTelemetry: true,
      diskTelemetry: state.meta.capabilities.diskTelemetry,
      networkRateTelemetry: state.meta.capabilities.networkRateTelemetry
    }
  };
}

async function refreshProcessTop(totalMemoryBytes) {
  if (state.caches.processRefreshPending) {
    return;
  }

  state.caches.processRefreshPending = true;
  try {
    const processData = await safeCall("processes", si.processes(), null, 5000);
    if (!processData || !Array.isArray(processData.list)) {
      return;
    }

    state.caches.processTop = processData.list
      .map((item) => {
        const rss = firstFinite([item.memRss, item.memRssBytes], 0);
        const memPercent = firstFinite([item.mem], 0);
        const memoryMb = rss > 0
          ? rss / (1024 ** 2)
          : (memPercent > 0 ? (totalMemoryBytes * (memPercent / 100)) / (1024 ** 2) : 0);
        const cpu = firstFinite([item.cpu, item.pcpu], 0);
        const rawName = String(item.name || item.command || item.path || "unknown");
        const shortName = rawName.split(/[\\/]/).pop().slice(0, 42);

        return {
          name: shortName || "unknown",
          cpu: round(cpu, 1),
          memoryMb: Math.max(0, round(memoryMb, 0))
        };
      })
      .filter((entry) => entry.cpu > 0 || entry.memoryMb > 0)
      .sort((left, right) => {
        if (right.memoryMb !== left.memoryMb) {
          return right.memoryMb - left.memoryMb;
        }
        return right.cpu - left.cpu;
      })
      .slice(0, 5);
  } finally {
    state.caches.processRefreshPending = false;
  }
}

async function refreshNetworkConnections() {
  if (state.caches.connectionRefreshPending) {
    return;
  }

  state.caches.connectionRefreshPending = true;
  try {
    const connectionList = await safeCall("networkConnections", si.networkConnections(), null, 4500);
    if (!Array.isArray(connectionList)) {
      return;
    }
    state.caches.networkConnections = connectionList.length;
  } finally {
    state.caches.connectionRefreshPending = false;
  }
}

async function collectSample() {
  state.tickCount += 1;

  const [load, cpuSpeed, memory, fsStats, disksIo, networkStats, cpuTemperature, graphicsInfo] = await Promise.all([
    safeCall("currentLoad", si.currentLoad(), null),
    safeCall("cpuCurrentSpeed", si.cpuCurrentSpeed(), null),
    safeCall("mem", si.mem(), null),
    safeCall("fsStats", si.fsStats(), null),
    safeCall("disksIO", si.disksIO(), null),
    safeCall("networkStats", si.networkStats(), null),
    safeCall("cpuTemperature", si.cpuTemperature(), null),
    safeCall("graphics", si.graphics(), null)
  ]);

  const memoryTotalBytes = firstFinite([memory?.total], os.totalmem());
  const processRefreshTick = Math.max(1, Math.round(2000 / state.sampleRateMs));
  const connectionsRefreshTick = Math.max(1, Math.round(5000 / state.sampleRateMs));

  if (state.tickCount % processRefreshTick === 0 || state.caches.processTop.length === 0) {
    refreshProcessTop(memoryTotalBytes).catch(() => {
      console.warn("[collector] process refresh task failed");
    });
  }
  if (state.tickCount % connectionsRefreshTick === 0 || state.caches.networkConnections === 0) {
    refreshNetworkConnections().catch(() => {
      console.warn("[collector] connection refresh task failed");
    });
  }

  const cpu = round(firstFinite([load?.currentLoad], 0), 1);
  const cpuFreq = round(firstFinite([cpuSpeed?.avg, cpuSpeed?.current], 0), 2);
  const cpuCores = Array.isArray(load?.cpus)
    ? load.cpus.map((entry) => round(firstFinite([entry.load], 0), 1))
    : [];

  const memoryUsedBytes = firstFinite([memory?.used], 0);
  const swapTotalBytes = firstFinite([memory?.swaptotal], 0);
  const swapUsedBytes = firstFinite([memory?.swapused], 0);
  const mem = memoryTotalBytes > 0 ? round((memoryUsedBytes / memoryTotalBytes) * 100, 1) : 0;
  const swap = swapTotalBytes > 0 ? round((swapUsedBytes / swapTotalBytes) * 100, 1) : 0;

  const gpu = pickGpuController(graphicsInfo);
  const gpuLoad = round(gpu?.utilization || 0, 1);
  const vramTotalGb = round((gpu?.memoryTotalMb || 0) / 1024, 2);
  const vramUsedGb = round((gpu?.memoryUsedMb || 0) / 1024, 2);
  const vram = vramTotalGb > 0 ? round((vramUsedGb / vramTotalGb) * 100, 1) : 0;

  const diskReadRawBytesSec = firstFinite([fsStats?.rx_sec], NaN);
  const diskWriteRawBytesSec = firstFinite([fsStats?.wx_sec], NaN);
  const ioPerSecond = firstFinite([disksIo?.tIO_sec, firstFinite([disksIo?.rIO_sec], 0) + firstFinite([disksIo?.wIO_sec], 0)], 0);
  const rawDiskLatency = firstFinite([disksIo?.ms], NaN);
  const hasSiDiskThroughput = Number.isFinite(diskReadRawBytesSec) || Number.isFinite(diskWriteRawBytesSec) || ioPerSecond > 0;
  const hasSiNativeDiskLatency = Number.isFinite(rawDiskLatency) && rawDiskLatency > 0;
  const hasSiDiskTelemetry = hasSiDiskThroughput || hasSiNativeDiskLatency;

  const shouldUseWindowsDiskFallback = process.platform === "win32" && !hasSiDiskTelemetry;
  if (shouldUseWindowsDiskFallback && !state.caches.windowsDisk.available) {
    await refreshWindowsDiskTelemetry(true);
  } else if (process.platform === "win32") {
    refreshWindowsDiskTelemetry(false).catch(() => {
      console.warn("[collector] windows disk refresh task failed");
    });
  }

  const windowsDisk = state.caches.windowsDisk;
  const useWindowsDisk = shouldUseWindowsDiskFallback && windowsDisk.available;
  const finalDiskReadBytesSec = useWindowsDisk
    ? windowsDisk.readBytesSec
    : (Number.isFinite(diskReadRawBytesSec) ? diskReadRawBytesSec : 0);
  const finalDiskWriteBytesSec = useWindowsDisk
    ? windowsDisk.writeBytesSec
    : (Number.isFinite(diskWriteRawBytesSec) ? diskWriteRawBytesSec : 0);
  const diskRead = round(bytesPerSecToMb(finalDiskReadBytesSec), 1);
  const diskWrite = round(bytesPerSecToMb(finalDiskWriteBytesSec), 1);

  const fallbackLatencyMs = Number.isFinite(windowsDisk.latencyMs) ? windowsDisk.latencyMs : NaN;
  const effectiveRawDiskLatency = hasSiNativeDiskLatency
    ? rawDiskLatency
    : (useWindowsDisk ? fallbackLatencyMs : NaN);
  const hasNativeDiskLatency = Number.isFinite(effectiveRawDiskLatency) && effectiveRawDiskLatency > 0;

  const hasDiskThroughput = useWindowsDisk
    ? (finalDiskReadBytesSec > 0 || finalDiskWriteBytesSec > 0)
    : hasSiDiskThroughput;
  const diskTelemetryAvailable = useWindowsDisk || hasSiDiskTelemetry;
  const diskTelemetrySource = useWindowsDisk
    ? "windows-counter"
    : (hasSiDiskTelemetry ? "systeminformation" : "none");

  let diskVolumes = [];
  if (process.platform === "win32" && Array.isArray(windowsDisk.logicalVolumes) && windowsDisk.logicalVolumes.length > 0) {
    diskVolumes = windowsDisk.logicalVolumes.map((volume) => {
      const readBytesSec = Number(volume.readBytesSec) || 0;
      const writeBytesSec = Number(volume.writeBytesSec) || 0;
      const latencyMs = Number(volume.latencyMs);
      return {
        name: String(volume.name || "Unknown"),
        read: round(bytesPerSecToMb(readBytesSec), 3),
        write: round(bytesPerSecToMb(writeBytesSec), 3),
        total: round(bytesPerSecToMb(readBytesSec + writeBytesSec), 3),
        latencyMs: Number.isFinite(latencyMs) ? round(latencyMs, 3) : null,
        source: "windows-counter"
      };
    });
  }

  if (diskVolumes.length === 0 && diskTelemetryAvailable) {
    diskVolumes = [{
      name: "TOTAL",
      read: round(diskRead, 3),
      write: round(diskWrite, 3),
      total: round(diskRead + diskWrite, 3),
      latencyMs: null,
      source: diskTelemetrySource
    }];
  }

  diskVolumes = diskVolumes
    .sort((left, right) => right.total - left.total)
    .slice(0, 12);

  const estimatedDiskLatency = clamp(2.2 + (ioPerSecond > 0 ? 1000 / ioPerSecond : 0) + ((diskRead + diskWrite) / 180), 1.1, 80);
  const diskLatency = diskTelemetryAvailable
    ? (hasNativeDiskLatency ? round(effectiveRawDiskLatency, 1) : round(estimatedDiskLatency, 1))
    : 0;

  if (diskVolumes.length === 1 && diskVolumes[0].name === "TOTAL" && diskVolumes[0].latencyMs === null) {
    diskVolumes[0].latencyMs = Number.isFinite(diskLatency) ? round(diskLatency, 3) : null;
  }

  const aggregateNet = aggregateNetworkStats(networkStats);
  const netRates = resolveNetworkRates(aggregateNet);
  const netUp = round(bytesPerSecToMb(netRates.txSec), 3);
  const netDown = round(bytesPerSecToMb(netRates.rxSec), 3);
  const networkRateAvailable = netRates.available;
  const networkInterfaces = Array.isArray(aggregateNet.interfaces)
    ? aggregateNet.interfaces.map((entry) => {
      const up = round(bytesPerSecToMb(entry.txSec), 3);
      const down = round(bytesPerSecToMb(entry.rxSec), 3);
      return {
        name: entry.name,
        up,
        down,
        total: round(up + down, 3),
        rateAvailable: Boolean(entry.rateAvailable),
        source: entry.rateAvailable ? "direct-or-delta" : "counter"
      };
    })
      .sort((left, right) => {
        if (right.total !== left.total) {
          return right.total - left.total;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, 12)
    : [];
  const packetLoss = round(updatePacketLoss(aggregateNet), 2);

  const cpuTemp = firstFinite([cpuTemperature?.main, cpuTemperature?.max, gpu?.temperature], NaN);
  const hasTemperatureSensor = Number.isFinite(cpuTemp) && cpuTemp > 0;
  const temp = hasTemperatureSensor
    ? round(cpuTemp, 1)
    : round(34 + (cpu * 0.26) + (gpuLoad * 0.18), 1);

  state.meta.capabilities.temperatureTelemetry = state.meta.capabilities.temperatureTelemetry || hasTemperatureSensor;
  state.meta.capabilities.diskTelemetry = state.meta.capabilities.diskTelemetry || diskTelemetryAvailable;
  state.meta.capabilities.networkRateTelemetry = state.meta.capabilities.networkRateTelemetry || networkRateAvailable;

  const timestamp = Date.now();
  const sample = {
    ts: timestamp,
    isoTime: new Date(timestamp).toISOString(),
    sampleRateMs: state.sampleRateMs,
    cpu,
    cpuFreq,
    cpuCores,
    mem,
    memUsedGb: round(bytesToGb(memoryUsedBytes), 2),
    memTotalGb: round(bytesToGb(memoryTotalBytes), 2),
    swap,
    swapUsedGb: round(bytesToGb(swapUsedBytes), 2),
    swapTotalGb: round(bytesToGb(swapTotalBytes), 2),
    gpu: gpuLoad,
    gpuName: gpu?.model || state.meta.gpuModel || "N/A",
    gpuTemp: Number.isFinite(gpu?.temperature) ? round(gpu.temperature, 1) : null,
    vram,
    vramUsedGb,
    vramTotalGb,
    diskRead,
    diskWrite,
    diskLatency,
    diskTelemetryAvailable,
    diskTelemetrySource,
    diskVolumes,
    diskLatencyEstimated: diskTelemetryAvailable && !hasNativeDiskLatency,
    netUp,
    netDown,
    networkRateAvailable,
    networkIfaces: networkInterfaces.map((entry) => entry.name),
    networkInterfaces,
    packetLoss,
    netConnections: state.caches.networkConnections,
    temp,
    tempEstimated: !hasTemperatureSensor,
    processTop: state.caches.processTop
  };

  evaluateAlerts(sample);
  return sample;
}

function sendMessage(socket, message) {
  if (socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(message));
}

function subscribedHostIdForSocket(socket) {
  return socketSubscriptions.get(socket) || LOCAL_HOST_ID;
}

function subscribeSocketToHost(socket, hostIdInput) {
  const requestedHostId = resolveHostIdFromInput(hostIdInput, LOCAL_HOST_ID);
  const hasLiveHost = requestedHostId === LOCAL_HOST_ID || remoteHosts.has(requestedHostId);
  const hasStoredHost = Boolean(getStoredHostById(requestedHostId));
  const finalHostId = hasLiveHost || hasStoredHost ? requestedHostId : LOCAL_HOST_ID;
  socketSubscriptions.set(socket, finalHostId);
  return finalHostId;
}

function broadcastMessage(message) {
  const payload = JSON.stringify(message);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  }
}

function broadcastMessageToHost(hostIdInput, message) {
  const targetHostId = resolveHostIdFromInput(hostIdInput, LOCAL_HOST_ID);
  const payload = JSON.stringify(message);

  for (const client of wss.clients) {
    if (client.readyState !== WebSocket.OPEN) {
      continue;
    }

    const subscribedHostId = subscribedHostIdForSocket(client);
    if (subscribedHostId === targetHostId) {
      client.send(payload);
    }
  }
}

function hostIdentity(hostIdInput) {
  const hostId = resolveHostIdFromInput(hostIdInput, LOCAL_HOST_ID);
  const hostSnapshot = getHostSnapshot(hostId);
  if (hostSnapshot) {
    return {
      hostId,
      hostName: safeHostName(hostSnapshot.hostName, hostId),
      source: String(hostSnapshot.source || "unknown"),
      online: isHostOnline(hostSnapshot.lastSeenTs)
    };
  }

  const storedHost = getStoredHostById(hostId);
  if (storedHost) {
    return {
      hostId,
      hostName: safeHostName(storedHost.hostName, hostId),
      source: String(storedHost.source || "unknown"),
      online: false
    };
  }

  return {
    hostId,
    hostName: safeHostName(hostId, "Unknown Host"),
    source: "unknown",
    online: false
  };
}

function resolveLatestSampleForHost(hostIdInput) {
  const hostId = resolveHostIdFromInput(hostIdInput, LOCAL_HOST_ID);
  const hostSnapshot = getHostSnapshot(hostId);
  if (hostSnapshot?.latestSample) {
    return hostSnapshot.latestSample;
  }

  if (!storage) {
    return null;
  }

  try {
    return storage.getLatestSample(hostId);
  } catch (error) {
    console.warn(`[storage] latest sample failed: ${error.message}`);
    return null;
  }
}

function buildHelloPayload(hostIdInput) {
  const hostId = resolveHostIdFromInput(hostIdInput, LOCAL_HOST_ID);
  const hostSnapshot = getHostSnapshot(hostId);
  const host = hostIdentity(hostId);
  const latest = resolveLatestSampleForHost(hostId);
  const eventsResult = readHostEventsBySource(hostId, {
    fromTs: Date.now() - 24 * 60 * 60 * 1000,
    toTs: Date.now(),
    limit: 120,
    sourceMode: "auto"
  });
  const historyResult = readHostHistoryBySource(hostId, {
    fromTs: Date.now() - HELLO_BOOTSTRAP_HISTORY_MINUTES * 60 * 1000,
    toTs: Date.now(),
    limit: Math.max(400, HELLO_BOOTSTRAP_HISTORY_MINUTES * 120),
    sourceMode: "auto"
  });

  return {
    host,
    meta: resolveHostMeta(hostId),
    config: collectorConfigPayload(),
    latest,
    activeAlerts: hostSnapshot ? activeAlertsFromHostSnapshot(hostSnapshot) : [],
    events: eventsWithAiAnalysis(eventsResult.events),
    history: historyResult.points,
    historySource: historyResult.source,
    eventsSource: eventsResult.source,
    hosts: latestHostList(),
    server: {
      localHostId: LOCAL_HOST_ID,
      sqliteEnabled: storageStatus.ready && Boolean(storage),
      bootstrapHistoryMinutes: HELLO_BOOTSTRAP_HISTORY_MINUTES,
      storage: storageStatusPayload(),
      aiAnalyzer: {
        enabled: aiAnalyzer.enabled,
        model: aiAnalyzer.model,
        providerConfigured: aiAnalyzer.providerConfigured
      }
    }
  };
}

function sendHelloForHost(socket, hostIdInput) {
  const hostId = subscribeSocketToHost(socket, hostIdInput);
  sendMessage(socket, {
    type: "hello",
    payload: buildHelloPayload(hostId)
  });
}

function broadcastHostsSnapshot() {
  broadcastMessage({
    type: "hosts",
    payload: {
      localHostId: LOCAL_HOST_ID,
      hosts: latestHostList()
    }
  });
}

function collectorConfigPayload() {
  return {
    sampleRateMs: state.sampleRateMs,
    allowedSampleRates: ALLOWED_SAMPLE_RATES
  };
}

function collectorStatsPayload() {
  const now = Date.now();
  return {
    ...state.stats,
    sampleAgeMs: state.latestSample ? now - state.latestSample.ts : null,
    clients: wss.clients.size,
    activeAlerts: state.activeAlerts.size,
    historyPoints: state.history.length,
    eventPoints: state.events.length
  };
}

function persistHostSnapshotToStorage(hostSnapshot) {
  if (!storage || !hostSnapshot) {
    return;
  }

  try {
    storage.persistHostSnapshot({
      hostId: hostSnapshot.hostId,
      hostName: hostSnapshot.hostName,
      source: hostSnapshot.source,
      meta: hostSnapshot.meta,
      firstSeenTs: hostSnapshot.firstSeenTs,
      lastSeenTs: hostSnapshot.lastSeenTs
    });
  } catch (error) {
    console.warn(`[storage] persist host snapshot failed: ${error.message}`);
  }
}

function persistSampleBundleToStorage({ hostId, hostName, source, hostMeta, firstSeenTs, sample, events = [] }) {
  if (!storage || !sample) {
    return;
  }

  try {
    storage.persistSampleBundle({
      hostId,
      hostName,
      source,
      hostMeta,
      firstSeenTs,
      sample,
      events
    });
  } catch (error) {
    console.warn(`[storage] persist sample failed: ${error.message}`);
  }
}

function notifyEventsAsync(hostSnapshot, events, sample) {
  if (!notifier.enabled || !Array.isArray(events) || events.length === 0) {
    return;
  }

  notifier.notifyEvents({
    hostSnapshot,
    events,
    sample
  }).catch((error) => {
    console.warn(`[notifier] notify failed: ${error.message}`);
  });
}

function shouldNotifyAnalysisUpdate(record) {
  if (!record || !record.eventId) {
    return false;
  }

  const key = String(record.eventId);
  const nextStatus = String(record.status || "unknown");
  const previousStatus = analysisNotifyState.get(key);
  if (previousStatus === nextStatus) {
    return false;
  }

  analysisNotifyState.set(key, nextStatus);
  if (analysisNotifyState.size > AI_ANALYZER_CACHE_MAX) {
    const overflow = analysisNotifyState.size - AI_ANALYZER_CACHE_MAX;
    const keys = Array.from(analysisNotifyState.keys()).slice(0, overflow);
    for (const staleKey of keys) {
      analysisNotifyState.delete(staleKey);
    }
  }
  return true;
}

function notifyAnalysisResultAsync({ hostId, event, record, sample = null }) {
  if (!notifier.enabled || !event || !record || String(record.status || "") === "pending") {
    return;
  }

  if (!shouldNotifyAnalysisUpdate(record)) {
    return;
  }

  const hostSnapshot = hostSnapshotForAnalysis(hostId);
  notifier.notifyAnalysisUpdate({
    hostSnapshot,
    event,
    analysisRecord: record,
    sample
  }).catch((error) => {
    console.warn(`[notifier] analysis update failed: ${error.message}`);
  });
}

function storageStatusPayload() {
  return {
    configured: storageStatus.configured,
    strictStartup: storageStatus.strictStartup,
    ready: storageStatus.ready,
    degraded: storageStatus.degraded,
    enabled: storageStatus.ready && Boolean(storage),
    dbPath: storageStatus.dbPath,
    retentionDays: storageStatus.retentionDays,
    initializedAt: storageStatus.initializedAt || 0,
    error: storageStatus.error || ""
  };
}

function trimEventAiCache() {
  if (eventAiAnalysisCache.size <= AI_ANALYZER_CACHE_MAX) {
    return;
  }

  const overflow = eventAiAnalysisCache.size - AI_ANALYZER_CACHE_MAX;
  const keys = Array.from(eventAiAnalysisCache.keys()).slice(0, overflow);
  for (const key of keys) {
    eventAiAnalysisCache.delete(key);
  }
}

function saveEventAiAnalysisToCache(eventId, record) {
  const normalizedEventId = String(eventId || "").trim();
  if (!normalizedEventId || !record) {
    return;
  }

  if (eventAiAnalysisCache.has(normalizedEventId)) {
    eventAiAnalysisCache.delete(normalizedEventId);
  }
  eventAiAnalysisCache.set(normalizedEventId, record);
  trimEventAiCache();
}

function readEventAiAnalysisFromStorage(eventId) {
  if (!storage || typeof storage.getEventAnalysis !== "function") {
    return null;
  }

  try {
    return storage.getEventAnalysis(eventId);
  } catch (error) {
    console.warn(`[storage] read event AI analysis failed: ${error.message}`);
    return null;
  }
}

function persistEventAiAnalysisToStorage(record) {
  if (!storage || typeof storage.upsertEventAnalysis !== "function" || !record) {
    return;
  }

  try {
    storage.upsertEventAnalysis(record);
  } catch (error) {
    console.warn(`[storage] persist event AI analysis failed: ${error.message}`);
  }
}

function getEventAiAnalysis(eventId) {
  const normalizedEventId = String(eventId || "").trim();
  if (!normalizedEventId) {
    return null;
  }

  if (eventAiAnalysisCache.has(normalizedEventId)) {
    const cached = eventAiAnalysisCache.get(normalizedEventId);
    saveEventAiAnalysisToCache(normalizedEventId, cached);
    return cached;
  }

  const stored = readEventAiAnalysisFromStorage(normalizedEventId);
  if (stored) {
    saveEventAiAnalysisToCache(normalizedEventId, stored);
  }
  return stored;
}

function eventWithAiAnalysis(event) {
  if (!event || typeof event !== "object") {
    return event;
  }

  const analysis = getEventAiAnalysis(event.id);
  if (!analysis) {
    return {
      ...event,
      aiAnalysis: null
    };
  }

  return {
    ...event,
    aiAnalysis: analysis
  };
}

function eventsWithAiAnalysis(events) {
  if (!Array.isArray(events) || events.length === 0) {
    return [];
  }
  return events.map((event) => eventWithAiAnalysis(event));
}

function findEventById(hostIdInput, eventIdInput) {
  const hostId = resolveHostIdFromInput(hostIdInput);
  const eventId = String(eventIdInput || "").trim();
  if (!eventId) {
    return null;
  }

  const hostSnapshot = getHostSnapshot(hostId);
  if (hostSnapshot?.events) {
    const inMemory = hostSnapshot.events.find((event) => String(event?.id) === eventId);
    if (inMemory) {
      return inMemory;
    }
  }

  if (typeof storage?.getEventById === "function") {
    try {
      const stored = storage.getEventById(hostId, eventId);
      if (stored) {
        return stored;
      }
    } catch (error) {
      console.warn(`[storage] getEventById failed: ${error.message}`);
    }
  }

  const rangeEvents = readHostEventsBySource(hostId, {
    fromTs: Date.now() - 7 * 24 * 60 * 60 * 1000,
    toTs: Date.now(),
    limit: 2000,
    sourceMode: "auto"
  }).events;

  return rangeEvents.find((event) => String(event?.id) === eventId) || null;
}

function hostSnapshotForAnalysis(hostIdInput) {
  const hostId = resolveHostIdFromInput(hostIdInput);
  const host = hostIdentity(hostId);
  return {
    hostId: host.hostId,
    hostName: host.hostName,
    source: host.source
  };
}

async function analyzeEventIncident({ hostId, eventId, force = false, eventOverride = null, sampleOverride = null }) {
  const normalizedHostId = resolveHostIdFromInput(hostId);
  const normalizedEventId = String(eventId || "").trim();
  if (!normalizedEventId) {
    return null;
  }

  if (!force) {
    const existing = getEventAiAnalysis(normalizedEventId);
    if (existing && existing.status !== "pending") {
      return existing;
    }
  }

  const event = eventOverride || findEventById(normalizedHostId, normalizedEventId);
  if (!event) {
    return null;
  }

  const eventTs = safeTimestamp(event.ts, Date.now());
  const historyResult = readHostHistoryBySource(normalizedHostId, {
    fromTs: Math.max(0, eventTs - 10 * 60 * 1000),
    toTs: eventTs + 2 * 60 * 1000,
    limit: 600,
    sourceMode: "auto"
  });

  const hostSnapshot = hostSnapshotForAnalysis(normalizedHostId);
  const ai = await aiAnalyzer.analyzeIncident({
    hostSnapshot,
    event,
    sample: sampleOverride || resolveLatestSampleForHost(normalizedHostId),
    history: historyResult.points
  });

  const record = {
    eventId: normalizedEventId,
    hostId: normalizedHostId,
    eventTs,
    status: String(ai?.status || "fallback"),
    model: String(ai?.model || aiAnalyzer.model || "none"),
    analysis: ai,
    updatedAt: Date.now()
  };

  persistEventAiAnalysisToStorage(record);
  saveEventAiAnalysisToCache(normalizedEventId, record);
  return record;
}

function markEventAnalysisPending({ hostId, eventId, eventTs }) {
  const normalizedEventId = String(eventId || "").trim();
  if (!normalizedEventId) {
    return;
  }

  const pendingRecord = {
    eventId: normalizedEventId,
    hostId: resolveHostIdFromInput(hostId),
    eventTs: safeTimestamp(eventTs, Date.now()),
    status: "pending",
    model: aiAnalyzer.model,
    analysis: {
      status: "pending",
      cause: {
        summary: "分析任务已进入队列，请稍候。",
        category: "pending",
        affectedComponent: "event",
        confidence: 0
      },
      evidence: [],
      remediation: {
        immediate: [],
        next24h: [],
        prevention: []
      },
      meta: {
        fallbackReason: null
      }
    },
    updatedAt: Date.now()
  };

  saveEventAiAnalysisToCache(normalizedEventId, pendingRecord);
}

function pumpAiAnalysisQueue() {
  while (aiAnalysisInFlight < AI_ANALYZER_MAX_CONCURRENCY && aiAnalysisQueue.length > 0) {
    const task = aiAnalysisQueue.shift();
    if (!task) {
      continue;
    }

    aiAnalysisInFlight += 1;
    analyzeEventIncident(task)
      .then((record) => {
        if (record) {
          notifyAnalysisResultAsync({
            hostId: task.hostId,
            event: task.eventOverride || findEventById(task.hostId, task.eventId),
            record,
            sample: task.sampleOverride || resolveLatestSampleForHost(task.hostId)
          });
        }
      })
      .catch((error) => {
        console.warn(`[ai] analyze event failed: ${error.message}`);
      })
      .finally(() => {
        aiAnalysisInFlight = Math.max(0, aiAnalysisInFlight - 1);
        pendingEventAnalyses.delete(task.eventId);
        setImmediate(pumpAiAnalysisQueue);
      });
  }
}

function enqueueEventAnalysis(task) {
  const eventId = String(task?.eventId || "").trim();
  if (!eventId) {
    return;
  }

  if (pendingEventAnalyses.has(eventId) || getEventAiAnalysis(eventId)) {
    return;
  }

  if (aiAnalysisQueue.length >= AI_ANALYZER_QUEUE_LIMIT) {
    return;
  }

  pendingEventAnalyses.add(eventId);
  markEventAnalysisPending(task);
  aiAnalysisQueue.push(task);
  pumpAiAnalysisQueue();
}

function analyzeEventsAsync(hostId, events, sample = null) {
  if (!Array.isArray(events) || events.length === 0) {
    return;
  }

  for (const event of events) {
    if (!event || typeof event !== "object") {
      continue;
    }

    const eventType = String(event.type || "event");
    const shouldAnalyze = eventType === "trigger" || eventType === "resolve" || eventType === "event";
    if (!shouldAnalyze) {
      continue;
    }

    enqueueEventAnalysis({
      hostId,
      eventId: event.id,
      force: false,
      eventOverride: event,
      sampleOverride: sample,
      eventTs: event.ts
    });
  }
}

async function collectorTick() {
  if (state.collectorBusy) {
    state.stats.ticksSkippedBusy += 1;
    return;
  }

  const startedAt = Date.now();
  state.stats.ticksTotal += 1;
  state.collectorBusy = true;
  try {
    const sample = await collectSample();
    state.latestSample = sample;
    appendHistory(sample);

    const localSnapshot = localHostSnapshot();
    persistSampleBundleToStorage({
      hostId: LOCAL_HOST_ID,
      hostName: localSnapshot.hostName,
      source: "local",
      hostMeta: state.meta,
      firstSeenTs: localSnapshot.firstSeenTs,
      sample,
      events: sample.events
    });

    state.stats.ticksSucceeded += 1;
    state.stats.lastSuccessTs = sample.ts;
    broadcastMessageToHost(LOCAL_HOST_ID, { type: "sample", payload: sample });

    if (sample.events.length > 0) {
      analyzeEventsAsync(LOCAL_HOST_ID, sample.events, sample);
      const enrichedEvents = eventsWithAiAnalysis(sample.events);
      broadcastMessageToHost(LOCAL_HOST_ID, { type: "events", payload: enrichedEvents });
      notifyEventsAsync(localSnapshot, enrichedEvents, sample);
    }

    const hostsBroadcastTick = Math.max(1, Math.round(5000 / state.sampleRateMs));
    if (state.tickCount % hostsBroadcastTick === 0) {
      broadcastHostsSnapshot();
    }
  } catch (error) {
    state.stats.ticksFailed += 1;
    state.stats.lastErrorTs = Date.now();
    state.stats.lastErrorMessage = String(error.message || "collector failed");
    console.error(`[collector] tick failed: ${error.message}`);
  } finally {
    const elapsed = Date.now() - startedAt;
    state.stats.lastTickDurationMs = elapsed;
    state.stats.peakTickDurationMs = Math.max(state.stats.peakTickDurationMs, elapsed);
    if (state.stats.avgTickDurationMs === 0) {
      state.stats.avgTickDurationMs = elapsed;
    } else {
      state.stats.avgTickDurationMs = round(state.stats.avgTickDurationMs * 0.9 + elapsed * 0.1, 2);
    }
    state.collectorBusy = false;
  }
}

function restartCollector() {
  if (state.collectorTimer) {
    clearInterval(state.collectorTimer);
  }
  state.collectorTimer = setInterval(() => {
    collectorTick().catch(() => {
      console.error("[collector] unexpected async rejection");
    });
  }, state.sampleRateMs);
}

function setCollectorSampleRate(sampleRateInput) {
  const nextRate = resolveSampleRate(sampleRateInput);
  if (nextRate === state.sampleRateMs) {
    return nextRate;
  }

  state.sampleRateMs = nextRate;
  restartCollector();
  collectorTick().catch(() => {
    console.error("[collector] manual tick failed after sample rate change");
  });

  const configPayload = collectorConfigPayload();
  broadcastMessage({ type: "config", payload: configPayload });
  return nextRate;
}

function csvEscape(value) {
  const text = String(value ?? "");
  if (/[,"\n]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function samplesToCsv(samples) {
  const headers = [
    "time",
    "cpu",
    "cpuFreq",
    "mem",
    "swap",
    "gpu",
    "vram",
    "diskRead",
    "diskWrite",
    "diskLatency",
    "diskTelemetryAvailable",
    "diskTelemetrySource",
    "diskLatencyEstimated",
    "netUp",
    "netDown",
    "networkRateAvailable",
    "packetLoss",
    "temp",
    "tempEstimated",
    "netConnections"
  ];

  const rows = samples.map((sample) => [
    sample.isoTime,
    sample.cpu,
    sample.cpuFreq,
    sample.mem,
    sample.swap,
    sample.gpu,
    sample.vram,
    sample.diskRead,
    sample.diskWrite,
    sample.diskLatency,
    sample.diskTelemetryAvailable,
    sample.diskTelemetrySource,
    sample.diskLatencyEstimated,
    sample.netUp,
    sample.netDown,
    sample.networkRateAvailable,
    sample.packetLoss,
    sample.temp,
    sample.tempEstimated,
    sample.netConnections
  ]);

  const body = [headers, ...rows]
    .map((row) => row.map(csvEscape).join(","))
    .join("\n");
  return `\uFEFF${body}`;
}

function hostIdFromRequest(req, fallbackValue = LOCAL_HOST_ID) {
  return resolveHostIdFromInput(req.query?.hostId || req.query?.host || fallbackValue, fallbackValue);
}

function normalizeEventLevel(level) {
  const normalized = String(level || "info").toLowerCase();
  if (normalized === "danger" || normalized === "error") {
    return "danger";
  }
  if (normalized === "warn" || normalized === "warning") {
    return "warn";
  }
  return "info";
}

function normalizeIncomingSample(rawSample, previousTs = 0) {
  const source = rawSample && typeof rawSample === "object" ? { ...rawSample } : {};
  const candidateTs = safeTimestamp(source.ts, Date.now());
  const ts = Math.max(candidateTs, Number(previousTs || 0) + 1);

  source.ts = ts;
  source.isoTime = String(source.isoTime || new Date(ts).toISOString());
  source.cpu = round(clamp(firstFinite([source.cpu], 0), 0, 100), 1);
  source.mem = round(clamp(firstFinite([source.mem], 0), 0, 100), 1);
  source.temp = round(clamp(firstFinite([source.temp], 0), 0, 120), 1);
  source.diskLatency = round(clamp(firstFinite([source.diskLatency], 0), 0, 300), 1);
  source.packetLoss = round(clamp(firstFinite([source.packetLoss], 0), 0, 100), 2);

  source.diskRead = round(Math.max(0, firstFinite([source.diskRead], 0)), 3);
  source.diskWrite = round(Math.max(0, firstFinite([source.diskWrite], 0)), 3);
  source.netUp = round(Math.max(0, firstFinite([source.netUp], 0)), 3);
  source.netDown = round(Math.max(0, firstFinite([source.netDown], 0)), 3);

  source.cpuFreq = round(Math.max(0, firstFinite([source.cpuFreq], 0)), 2);
  source.gpu = round(clamp(firstFinite([source.gpu], 0), 0, 100), 1);
  source.vram = round(clamp(firstFinite([source.vram], 0), 0, 100), 1);
  source.swap = round(clamp(firstFinite([source.swap], 0), 0, 100), 1);
  source.netConnections = Math.max(0, Math.round(firstFinite([source.netConnections], 0)));

  source.diskTelemetryAvailable = source.diskTelemetryAvailable !== false;
  source.networkRateAvailable = source.networkRateAvailable !== false;
  source.tempEstimated = Boolean(source.tempEstimated);
  source.diskLatencyEstimated = Boolean(source.diskLatencyEstimated);

  source.cpuCores = Array.isArray(source.cpuCores)
    ? source.cpuCores.slice(0, 128).map((value) => round(clamp(firstFinite([value], 0), 0, 100), 1))
    : [];
  source.processTop = Array.isArray(source.processTop) ? source.processTop.slice(0, 8) : [];
  source.diskVolumes = Array.isArray(source.diskVolumes) ? source.diskVolumes.slice(0, 24) : [];
  source.networkInterfaces = Array.isArray(source.networkInterfaces) ? source.networkInterfaces.slice(0, 24) : [];
  source.networkIfaces = Array.isArray(source.networkIfaces) ? source.networkIfaces.slice(0, 24) : [];

  return source;
}

function normalizeIncomingEvents(rawEvents, sampleTs) {
  if (!Array.isArray(rawEvents)) {
    return [];
  }

  return rawEvents.slice(0, 64)
    .map((event, index) => {
      const ts = safeTimestamp(event?.ts, sampleTs);
      const key = String(event?.key || `agentEvent${index}`);
      const content = String(event?.content || event?.message || "Agent 事件").slice(0, 500);
      if (!content) {
        return null;
      }
      return {
        id: String(event?.id || `${ts}-${key}-${index}`),
        key,
        level: normalizeEventLevel(event?.level),
        type: String(event?.type || "event"),
        content,
        ts,
        time: String(event?.time || formatClock(ts))
      };
    })
    .filter(Boolean);
}

function authenticateAgentRequest(req) {
  if (!AGENT_API_KEY) {
    return true;
  }

  const headerKey = String(req.get("x-agent-key") || "").trim();
  const bodyKey = String(req.body?.apiKey || "").trim();
  const provided = headerKey || bodyKey;
  return provided.length > 0 && provided === AGENT_API_KEY;
}

function ingestRemoteSampleBundle({
  hostId,
  hostName,
  source = "agent",
  hostMeta = {},
  sample,
  events = []
}) {
  const runtime = getOrCreateRemoteHost(hostId, hostName, hostMeta, source);
  const previousTs = runtime.latestSample?.ts || 0;
  const normalizedSample = normalizeIncomingSample(sample, previousTs);

  evaluateAlertsForTarget(normalizedSample, runtime.activeAlerts, runtime.events);
  const externalEvents = normalizeIncomingEvents(events, normalizedSample.ts);
  if (externalEvents.length > 0) {
    appendEventsBuffer(runtime.events, externalEvents);
    normalizedSample.events = [...normalizedSample.events, ...externalEvents];
  }

  runtime.latestSample = normalizedSample;
  runtime.lastSeenTs = normalizedSample.ts;
  runtime.stats.receivedSamples += 1;
  runtime.stats.receivedEvents += normalizedSample.events.length;
  runtime.stats.lastIngestTs = Date.now();

  appendHostHistory(runtime, normalizedSample);

  persistSampleBundleToStorage({
    hostId: runtime.hostId,
    hostName: runtime.hostName,
    source: runtime.source,
    hostMeta: runtime.meta,
    firstSeenTs: runtime.firstSeenTs,
    sample: normalizedSample,
    events: normalizedSample.events
  });

  broadcastMessageToHost(runtime.hostId, {
    type: "sample",
    payload: normalizedSample
  });

  if (normalizedSample.events.length > 0) {
    analyzeEventsAsync(runtime.hostId, normalizedSample.events, normalizedSample);
    const enrichedEvents = eventsWithAiAnalysis(normalizedSample.events);
    broadcastMessageToHost(runtime.hostId, {
      type: "events",
      payload: enrichedEvents
    });
    notifyEventsAsync(runtime, enrichedEvents, normalizedSample);
  }

  return {
    runtime,
    sample: normalizedSample
  };
}

app.get("/api/health", (req, res) => {
  const stats = collectorStatsPayload();
  const hosts = latestHostList();
  const onlineHosts = hosts.filter((host) => host.online).length;

  res.json({
    ok: true,
    uptimeSec: Math.round(process.uptime()),
    collectorBusy: state.collectorBusy,
    sampleRateMs: state.sampleRateMs,
    points: state.history.length,
    events: state.events.length,
    latestTs: state.latestSample?.ts || null,
    latestIsoTime: state.latestSample?.isoTime || null,
    stats,
    hosts: {
      count: hosts.length,
      online: onlineHosts,
      localHostId: LOCAL_HOST_ID
    },
    storage: storageStatusPayload(),
    aiAnalyzer: {
      enabled: aiAnalyzer.enabled,
      model: aiAnalyzer.model,
      providerConfigured: aiAnalyzer.providerConfigured
    },
    notifier: {
      enabled: notifier.enabled
    }
  });
});

app.get("/api/storage/status", (req, res) => {
  res.json(storageStatusPayload());
});

app.get("/api/notifier", (req, res) => {
  res.json({
    enabled: notifier.enabled,
    timeoutMs: NOTIFIER_TIMEOUT_MS,
    channels: {
      webhook: Boolean(ALERT_WEBHOOK_URL),
      wechat: Boolean(WECHAT_WEBHOOK_URL),
      dingtalk: Boolean(DINGTALK_WEBHOOK_URL),
      dingtalkSigned: Boolean(DINGTALK_WEBHOOK_URL && DINGTALK_SECRET)
    }
  });
});

app.post("/api/notifier/test", async (req, res) => {
  const hostId = hostIdFromRequest(req, LOCAL_HOST_ID);
  const host = hostIdentity(hostId);
  const now = Date.now();
  const content = String(req.body?.content || "PulseForge 通道测试").slice(0, 500);
  const level = normalizeEventLevel(req.body?.level || "info");
  const event = {
    id: `${now}-notifier-test-${Math.round(Math.random() * 10000)}`,
    key: "notifierTest",
    level,
    type: "test",
    content,
    ts: now,
    time: formatClock(now)
  };

  const latestSample = resolveLatestSampleForHost(hostId) || {
    ts: now,
    cpu: 0,
    mem: 0,
    temp: 0,
    packetLoss: 0
  };

  if (notifier.enabled) {
    await notifier.notifyEvents({
      hostSnapshot: host,
      events: [event],
      sample: latestSample
    });
  }

  res.json({
    ok: true,
    sent: notifier.enabled,
    hostId,
    event
  });
});

app.get("/api/hosts", (req, res) => {
  const hosts = latestHostList();
  res.json({
    count: hosts.length,
    localHostId: LOCAL_HOST_ID,
    hosts
  });
});

app.post("/api/agent/ingest", (req, res) => {
  if (!authenticateAgentRequest(req)) {
    res.status(401).json({
      ok: false,
      message: "Unauthorized agent request"
    });
    return;
  }

  const hostPayload = req.body?.host || {};
  const hostId = resolveHostIdFromInput(
    req.body?.hostId
      || hostPayload.id
      || hostPayload.hostId
      || req.body?.meta?.hostId
      || `agent:${hostPayload.name || req.body?.hostName || "unknown"}`
  );
  const hostName = safeHostName(
    req.body?.hostName
      || hostPayload.name
      || hostPayload.hostName
      || hostId,
    hostId
  );
  const source = String(req.body?.source || hostPayload.source || "agent");
  const hostMeta = req.body?.meta || hostPayload.meta || {};

  if (hostId === LOCAL_HOST_ID) {
    res.status(400).json({
      ok: false,
      message: "Agent hostId conflicts with local hostId"
    });
    return;
  }

  const sampleArray = Array.isArray(req.body?.samples)
    ? req.body.samples
    : (req.body?.sample ? [req.body.sample] : []);

  const boundedSamples = sampleArray.slice(-Math.max(1, AGENT_BATCH_LIMIT));

  if (boundedSamples.length === 0) {
    const runtime = getOrCreateRemoteHost(hostId, hostName, hostMeta, source);
    persistHostSnapshotToStorage(runtime);
    broadcastHostsSnapshot();

    res.json({
      ok: true,
      hostId: runtime.hostId,
      accepted: 0,
      message: "host metadata updated"
    });
    return;
  }

  let accepted = 0;
  let totalEvents = 0;
  let lastSampleTs = 0;
  for (let index = 0; index < boundedSamples.length; index += 1) {
    const sample = boundedSamples[index];
    if (!sample || typeof sample !== "object") {
      continue;
    }

    const events = Array.isArray(sample?.events)
      ? sample.events
      : (index === boundedSamples.length - 1 && Array.isArray(req.body?.events) ? req.body.events : []);

    const ingested = ingestRemoteSampleBundle({
      hostId,
      hostName,
      source,
      hostMeta,
      sample,
      events
    });
    accepted += 1;
    totalEvents += ingested.sample.events.length;
    lastSampleTs = ingested.sample.ts;
  }

  if (accepted === 0) {
    res.status(400).json({
      ok: false,
      message: "No valid samples provided"
    });
    return;
  }

  const runtime = remoteHosts.get(hostId);
  if (runtime) {
    persistHostSnapshotToStorage(runtime);
  }
  broadcastHostsSnapshot();

  res.json({
    ok: true,
    hostId,
    accepted,
    events: totalEvents,
    lastSampleTs,
    online: true
  });
});

app.get("/api/diagnostics", (req, res) => {
  const remoteHostStats = Array.from(remoteHosts.values()).map((host) => ({
    hostId: host.hostId,
    hostName: host.hostName,
    source: host.source,
    online: isHostOnline(host.lastSeenTs),
    lastSeenTs: host.lastSeenTs,
    historyPoints: host.history.length,
    eventPoints: host.events.length,
    receivedSamples: host.stats.receivedSamples,
    receivedEvents: host.stats.receivedEvents,
    lastIngestTs: host.stats.lastIngestTs
  }));

  res.json({
    meta: state.meta,
    config: collectorConfigPayload(),
    stats: collectorStatsPayload(),
    storage: storageStatusPayload(),
    aiAnalyzer: {
      enabled: aiAnalyzer.enabled,
      model: aiAnalyzer.model,
      providerConfigured: aiAnalyzer.providerConfigured
    },
    notifier: {
      enabled: notifier.enabled,
      channels: {
        webhook: Boolean(ALERT_WEBHOOK_URL),
        wechat: Boolean(WECHAT_WEBHOOK_URL),
        dingtalk: Boolean(DINGTALK_WEBHOOK_URL)
      }
    },
    remoteHosts: remoteHostStats,
    cache: {
      processTopCount: state.caches.processTop.length,
      networkConnections: state.caches.networkConnections,
      packetLoss: round(state.caches.packetLoss, 2),
      processRefreshPending: state.caches.processRefreshPending,
      connectionRefreshPending: state.caches.connectionRefreshPending,
      windowsDisk: {
        ...state.caches.windowsDisk,
        latencyMs: Number.isFinite(state.caches.windowsDisk.latencyMs)
          ? round(state.caches.windowsDisk.latencyMs, 3)
          : null,
        readMbSec: round(bytesPerSecToMb(state.caches.windowsDisk.readBytesSec), 3),
        writeMbSec: round(bytesPerSecToMb(state.caches.windowsDisk.writeBytesSec), 3),
        logicalVolumes: Array.isArray(state.caches.windowsDisk.logicalVolumes)
          ? state.caches.windowsDisk.logicalVolumes.map((volume) => ({
            name: volume.name,
            readMbSec: round(bytesPerSecToMb(volume.readBytesSec), 3),
            writeMbSec: round(bytesPerSecToMb(volume.writeBytesSec), 3),
            totalMbSec: round(bytesPerSecToMb(volume.totalBytesSec), 3),
            latencyMs: Number.isFinite(volume.latencyMs) ? round(volume.latencyMs, 3) : null
          }))
          : []
      }
    }
  });
});

app.get("/api/meta", (req, res) => {
  const hostId = hostIdFromRequest(req);
  const meta = resolveHostMeta(hostId);

  if (!meta) {
    res.status(404).json({
      message: "Host not found",
      hostId
    });
    return;
  }

  res.json({
    host: hostIdentity(hostId),
    meta,
    config: collectorConfigPayload(),
    server: {
      localHostId: LOCAL_HOST_ID,
      sqliteEnabled: storageStatus.ready && Boolean(storage),
      storage: storageStatusPayload(),
      aiAnalyzer: {
        enabled: aiAnalyzer.enabled,
        model: aiAnalyzer.model,
        providerConfigured: aiAnalyzer.providerConfigured
      }
    }
  });
});

app.get("/api/config", (req, res) => {
  res.json({
    ...collectorConfigPayload(),
    localHostId: LOCAL_HOST_ID
  });
});

app.post("/api/config", (req, res) => {
  const targetHostId = hostIdFromRequest(req, LOCAL_HOST_ID);
  if (!isLocalHostId(targetHostId)) {
    res.status(403).json({
      message: "Only local host supports config mutation",
      hostId: targetHostId,
      localHostId: LOCAL_HOST_ID
    });
    return;
  }

  const nextRate = setCollectorSampleRate(req.body?.sampleRateMs);
  res.json({
    sampleRateMs: nextRate,
    allowedSampleRates: ALLOWED_SAMPLE_RATES,
    localHostId: LOCAL_HOST_ID
  });
});

app.get("/api/latest", (req, res) => {
  const hostId = hostIdFromRequest(req);
  const hostSnapshot = getHostSnapshot(hostId);
  const sample = resolveLatestSampleForHost(hostId);

  if (!sample && !hostSnapshot && !getStoredHostById(hostId)) {
    res.status(404).json({
      message: "Host not found",
      hostId
    });
    return;
  }

  res.json({
    host: hostIdentity(hostId),
    sample,
    activeAlerts: hostSnapshot ? activeAlertsFromHostSnapshot(hostSnapshot) : []
  });
});

app.get("/api/history/replay", (req, res) => {
  const hostId = hostIdFromRequest(req);
  const sourceMode = normalizeStorageSourceMode(req.query.source);
  const queryWindow = resolveQueryWindow(req.query);
  const limit = historyLimit(req.query.limit, 1200);
  const replayStepMs = Math.max(100, Number(req.query.replayStepMs || req.query.stepMs || state.sampleRateMs));

  const result = readHostHistoryBySource(hostId, {
    fromTs: queryWindow.fromTs,
    toTs: queryWindow.toTs,
    limit,
    sourceMode,
    replayStepMs
  });

  res.json({
    hostId,
    minutes: queryWindow.minutes,
    fromTs: queryWindow.fromTs,
    toTs: queryWindow.toTs,
    source: result.source,
    requestedSource: sourceMode,
    replayStepMs,
    count: result.points.length,
    points: result.points
  });
});

app.get("/api/history", (req, res) => {
  const hostId = hostIdFromRequest(req);
  const sourceMode = normalizeStorageSourceMode(req.query.source);
  const queryWindow = resolveQueryWindow(req.query);
  const limit = historyLimit(req.query.limit, 600);
  const replayRequested = parseBoolean(req.query.replay, false)
    || Number.isFinite(Number(req.query.replayStepMs))
    || Number.isFinite(Number(req.query.stepMs));
  const replayStepMs = replayRequested
    ? Math.max(100, Number(req.query.replayStepMs || req.query.stepMs || state.sampleRateMs))
    : 0;

  const result = readHostHistoryBySource(hostId, {
    fromTs: queryWindow.fromTs,
    toTs: queryWindow.toTs,
    limit,
    sourceMode,
    replayStepMs
  });

  res.json({
    hostId,
    minutes: queryWindow.minutes,
    fromTs: queryWindow.fromTs,
    toTs: queryWindow.toTs,
    source: result.source,
    requestedSource: sourceMode,
    replayStepMs: replayStepMs || null,
    count: result.points.length,
    points: result.points
  });
});

app.get("/api/events", (req, res) => {
  const hostId = hostIdFromRequest(req);
  const sourceMode = normalizeStorageSourceMode(req.query.source);
  const queryWindow = resolveQueryWindow(req.query);
  const limit = sanitizeLimit(req.query.limit, 120, Math.max(MAX_EVENT_POINTS, 5000));
  const result = readHostEventsBySource(hostId, {
    fromTs: queryWindow.fromTs,
    toTs: queryWindow.toTs,
    limit,
    sourceMode
  });

  res.json({
    hostId,
    minutes: queryWindow.minutes,
    fromTs: queryWindow.fromTs,
    toTs: queryWindow.toTs,
    source: result.source,
    requestedSource: sourceMode,
    count: result.events.length,
    events: eventsWithAiAnalysis(result.events)
  });
});

app.get("/api/events/analysis", async (req, res) => {
  const hostId = hostIdFromRequest(req);
  const eventId = String(req.query.eventId || "").trim();
  const force = parseBoolean(req.query.force, false);

  if (!eventId) {
    res.status(400).json({
      ok: false,
      message: "eventId is required"
    });
    return;
  }

  let record = null;
  try {
    record = await analyzeEventIncident({
      hostId,
      eventId,
      force
    });
  } catch (error) {
    res.status(200).json({
      ok: false,
      hostId,
      eventId,
      analysis: {
        eventId,
        hostId,
        eventTs: Date.now(),
        status: "error",
        model: aiAnalyzer.model,
        analysis: {
          status: "error",
          cause: {
            summary: `AI 分析失败: ${String(error.message || error)}`,
            category: "unknown",
            affectedComponent: "event",
            confidence: 0
          },
          evidence: [],
          remediation: {
            immediate: ["稍后重试，或检查 AI 分析服务配置"],
            next24h: [],
            prevention: []
          },
          meta: {
            fallbackReason: "analysis_exception"
          }
        },
        updatedAt: Date.now()
      }
    });
    return;
  }

  if (!record) {
    res.status(404).json({
      ok: false,
      message: "Event not found",
      hostId,
      eventId
    });
    return;
  }

  res.json({
    ok: true,
    hostId,
    eventId,
    analysis: record
  });
});

app.post("/api/events/analysis", async (req, res) => {
  const hostId = resolveHostIdFromInput(req.body?.hostId || req.body?.host || LOCAL_HOST_ID);
  const eventId = String(req.body?.eventId || "").trim();
  const force = parseBoolean(req.body?.force, false);

  if (!eventId) {
    res.status(400).json({
      ok: false,
      message: "eventId is required"
    });
    return;
  }

  let record = null;
  try {
    record = await analyzeEventIncident({
      hostId,
      eventId,
      force
    });
  } catch (error) {
    res.status(200).json({
      ok: false,
      hostId,
      eventId,
      analysis: {
        eventId,
        hostId,
        eventTs: Date.now(),
        status: "error",
        model: aiAnalyzer.model,
        analysis: {
          status: "error",
          cause: {
            summary: `AI 分析失败: ${String(error.message || error)}`,
            category: "unknown",
            affectedComponent: "event",
            confidence: 0
          },
          evidence: [],
          remediation: {
            immediate: ["稍后重试，或检查 AI 分析服务配置"],
            next24h: [],
            prevention: []
          },
          meta: {
            fallbackReason: "analysis_exception"
          }
        },
        updatedAt: Date.now()
      }
    });
    return;
  }

  if (!record) {
    res.status(404).json({
      ok: false,
      message: "Event not found",
      hostId,
      eventId
    });
    return;
  }

  res.json({
    ok: true,
    hostId,
    eventId,
    analysis: record
  });
});

app.get("/api/export.csv", (req, res) => {
  const hostId = hostIdFromRequest(req);
  const sourceMode = normalizeStorageSourceMode(req.query.source);
  const queryWindow = resolveQueryWindow(req.query);
  const result = readHostHistoryBySource(hostId, {
    fromTs: queryWindow.fromTs,
    toTs: queryWindow.toTs,
    limit: historyLimit(req.query.limit, 20000),
    sourceMode,
    replayStepMs: 0
  });
  const csvText = samplesToCsv(result.points);

  const filename = `pulseforge-${hostId}-${queryWindow.minutes}m-${Date.now()}.csv`;
  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
  res.send(csvText);
});

app.use(express.static(path.join(__dirname)));

app.get("*", (req, res) => {
  if (req.path.startsWith("/api/")) {
    res.status(404).json({ message: "Not Found" });
    return;
  }
  res.sendFile(path.join(__dirname, "index.html"));
});

wss.on("connection", (socket, request) => {
  let initialHostId = LOCAL_HOST_ID;
  try {
    const wsUrl = new URL(request.url, `http://${request.headers.host || "localhost"}`);
    initialHostId = resolveHostIdFromInput(wsUrl.searchParams.get("hostId") || LOCAL_HOST_ID);
  } catch {
    initialHostId = LOCAL_HOST_ID;
  }

  sendHelloForHost(socket, initialHostId);

  socket.on("message", (rawMessage) => {
    let parsedMessage;
    try {
      parsedMessage = JSON.parse(rawMessage.toString());
    } catch {
      sendMessage(socket, {
        type: "error",
        payload: { message: "Invalid JSON message" }
      });
      return;
    }

    if (parsedMessage.type === "setHost") {
      const nextHostId = resolveHostIdFromInput(parsedMessage.payload?.hostId || LOCAL_HOST_ID);
      sendHelloForHost(socket, nextHostId);
      return;
    }

    if (parsedMessage.type === "getHosts") {
      sendMessage(socket, {
        type: "hosts",
        payload: {
          localHostId: LOCAL_HOST_ID,
          hosts: latestHostList()
        }
      });
      return;
    }

    if (parsedMessage.type === "setSampleRate") {
      const applied = setCollectorSampleRate(parsedMessage.payload?.sampleRateMs);
      sendMessage(socket, {
        type: "config",
        payload: {
          ...collectorConfigPayload(),
          sampleRateMs: applied,
          localHostId: LOCAL_HOST_ID
        }
      });
      return;
    }

    if (parsedMessage.type === "ping") {
      const clientTs = Number(parsedMessage.payload?.clientTs);
      sendMessage(socket, {
        type: "pong",
        payload: {
          ts: Date.now(),
          clientTs: Number.isFinite(clientTs) ? clientTs : null,
          hostId: subscribedHostIdForSocket(socket)
        }
      });
    }
  });

  socket.on("close", () => {
    socketSubscriptions.delete(socket);
  });
});

async function bootstrap() {
  storageStatus.initializedAt = Date.now();

  if (SQLITE_ENABLED) {
    try {
      storage = new SqliteStore({
        dbPath: SQLITE_DB_PATH,
        retentionDays: SQLITE_RETENTION_DAYS
      });
      storageStatus.ready = true;
      storageStatus.degraded = false;
      storageStatus.error = "";
      console.log(`[PulseForge] sqlite enabled: ${SQLITE_DB_PATH}`);
    } catch (error) {
      storage = null;
      storageStatus.ready = false;
      storageStatus.degraded = true;
      storageStatus.error = String(error.message || error);
      console.warn(`[PulseForge] sqlite disabled: ${error.message}`);

      if (SQLITE_STRICT_STARTUP) {
        throw new Error(`SQLITE_STRICT_STARTUP=1 and sqlite init failed: ${error.message}`);
      }
    }
  } else {
    storageStatus.ready = false;
    storageStatus.degraded = false;
    storageStatus.error = "SQLITE_ENABLED=0";
    console.log("[PulseForge] sqlite disabled by SQLITE_ENABLED=0");
  }

  await refreshMeta();
  persistHostSnapshotToStorage(localHostSnapshot());
  await collectorTick();
  restartCollector();

  server.listen(PORT, () => {
    console.log(`[PulseForge] server ready: http://localhost:${PORT}`);
    console.log(`[PulseForge] sample rate: ${state.sampleRateMs}ms`);
    console.log(`[PulseForge] local host id: ${LOCAL_HOST_ID}`);
  });
}

function shutdown(signal) {
  console.log(`[PulseForge] shutting down (${signal})`);
  if (state.collectorTimer) {
    clearInterval(state.collectorTimer);
  }
  for (const client of wss.clients) {
    client.close();
  }
  socketSubscriptions.clear();

  if (storage) {
    try {
      storage.close();
    } catch (error) {
      console.warn(`[storage] close failed: ${error.message}`);
    } finally {
      storage = null;
      storageStatus.ready = false;
    }
  }

  server.close(() => {
    process.exit(0);
  });
  setTimeout(() => process.exit(0), 2000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("unhandledRejection", (reason) => {
  console.error("[PulseForge] unhandledRejection:", reason);
});

bootstrap().catch((error) => {
  console.error(`[PulseForge] bootstrap failed: ${error.message}`);
  process.exit(1);
});
