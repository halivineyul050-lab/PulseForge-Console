"use strict";

const os = require("os");
const si = require("systeminformation");

const MASTER_URL = String(process.env.PF_MASTER_URL || process.env.MASTER_URL || "http://127.0.0.1:4510").trim();
const RAW_HOST_ID = process.env.PF_AGENT_HOST_ID || process.env.AGENT_HOST_ID || `agent:${os.hostname()}`;
const HOST_NAME = String(process.env.PF_AGENT_HOST_NAME || process.env.AGENT_HOST_NAME || os.hostname()).trim();
const API_KEY = String(process.env.PF_AGENT_API_KEY || process.env.AGENT_API_KEY || "").trim();

const SAMPLE_RATE_MS = Math.max(500, Math.min(10000, Number(process.env.PF_AGENT_SAMPLE_RATE_MS || process.env.AGENT_SAMPLE_RATE_MS || 1000)));
const REQUEST_TIMEOUT_MS = Math.max(1000, Math.min(30000, Number(process.env.PF_AGENT_TIMEOUT_MS || process.env.AGENT_TIMEOUT_MS || 5000)));
const META_REFRESH_INTERVAL_MS = Math.max(30_000, Math.min(10 * 60_000, Number(process.env.PF_AGENT_META_REFRESH_MS || 120_000)));

let hostMeta = null;
let processTopCache = [];
let processRefreshPending = false;
let networkByteSnapshot = null;
let networkIfaceSnapshots = {};
let packetSnapshot = null;
let packetLoss = 0;
let timer = null;
let tickCount = 0;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 1) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Number(parsed.toFixed(digits));
}

function firstFinite(values, fallback = null) {
  for (const value of values) {
    if (value === null || value === undefined || value === "") {
      continue;
    }
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }
  return fallback;
}

function bytesToGb(bytes) {
  return Number(bytes || 0) / (1024 ** 3);
}

function bytesPerSecToMb(bytesPerSec) {
  return Number(bytesPerSec || 0) / (1024 ** 2);
}

function sanitizeHostId(input) {
  const raw = String(input || "").trim();
  if (!raw) {
    return "agent-unknown";
  }
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80) || "agent-unknown";
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

async function safeCall(operationName, promise, fallbackValue, timeoutMs = 2500) {
  let timeoutId;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error("timeout")), timeoutMs);
  });

  try {
    const result = await Promise.race([promise, timeoutPromise]);
    clearTimeout(timeoutId);
    return result;
  } catch (error) {
    clearTimeout(timeoutId);
    console.warn(`[agent] ${operationName} failed: ${error.message}`);
    return fallbackValue;
  }
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

  const now = Date.now();
  const nextIfaceSnapshots = {};

  const summary = {
    rxSec: 0,
    txSec: 0,
    rxBytes: 0,
    txBytes: 0,
    rxPackets: 0,
    txPackets: 0,
    rxDropped: 0,
    txDropped: 0,
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
    const hasCounters = Number.isFinite(rxBytes) || Number.isFinite(txBytes);
    let rateFromDelta = false;

    if (!hasDirectRate && hasCounters) {
      const previous = networkIfaceSnapshots[ifaceName];
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

    nextIfaceSnapshots[ifaceName] = {
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
      rateAvailable: hasDirectRate || (hasCounters && rateFromDelta)
    });
  }

  networkIfaceSnapshots = nextIfaceSnapshots;
  summary.interfaces.sort((left, right) => right.totalSec - left.totalSec);
  return summary;
}

function resolveNetworkRates(aggregate) {
  let rxSec = aggregate.rxSec;
  let txSec = aggregate.txSec;

  const now = Date.now();
  const hasDirectRate = aggregate.interfaces.some((entry) => entry.rateAvailable);
  const hasCounters = aggregate.rxBytes > 0 || aggregate.txBytes > 0;

  if (!hasDirectRate && hasCounters) {
    const previous = networkByteSnapshot;
    if (previous && now > previous.ts) {
      const seconds = (now - previous.ts) / 1000;
      if (seconds > 0) {
        rxSec = Math.max(0, (aggregate.rxBytes - previous.rxBytes) / seconds);
        txSec = Math.max(0, (aggregate.txBytes - previous.txBytes) / seconds);
      }
    }
  }

  if (hasCounters) {
    networkByteSnapshot = {
      ts: now,
      rxBytes: aggregate.rxBytes,
      txBytes: aggregate.txBytes
    };
  }

  return {
    rxSec: Number.isFinite(rxSec) ? rxSec : 0,
    txSec: Number.isFinite(txSec) ? txSec : 0,
    available: hasDirectRate || hasCounters
  };
}

function updatePacketLoss(aggregate) {
  const current = {
    dropped: aggregate.rxDropped + aggregate.txDropped,
    packets: aggregate.rxPackets + aggregate.txPackets
  };

  const previous = packetSnapshot;
  packetSnapshot = current;

  if (!previous) {
    return packetLoss;
  }

  const droppedDelta = current.dropped - previous.dropped;
  const packetsDelta = current.packets - previous.packets;

  if (packetsDelta > 0 && droppedDelta >= 0) {
    packetLoss = clamp((droppedDelta / packetsDelta) * 100, 0, 100);
  } else {
    packetLoss = Math.max(0, packetLoss * 0.94);
  }

  return packetLoss;
}

async function refreshProcessTop(totalMemoryBytes) {
  if (processRefreshPending) {
    return;
  }

  processRefreshPending = true;
  try {
    const processData = await safeCall("processes", si.processes(), null, 5000);
    if (!processData || !Array.isArray(processData.list)) {
      return;
    }

    processTopCache = processData.list
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
    processRefreshPending = false;
  }
}

async function collectHostMeta() {
  const [osInfo, cpuInfo, memInfo, graphicsInfo] = await Promise.all([
    safeCall("osInfo", si.osInfo(), null),
    safeCall("cpu", si.cpu(), null),
    safeCall("mem", si.mem(), null),
    safeCall("graphics", si.graphics(), null)
  ]);

  const gpu = pickGpuController(graphicsInfo);

  hostMeta = {
    hostId: sanitizeHostId(RAW_HOST_ID),
    hostName: HOST_NAME || os.hostname(),
    os: `${osInfo?.distro || os.type()} ${osInfo?.release || ""}`.trim(),
    platform: osInfo?.platform || process.platform,
    arch: osInfo?.arch || process.arch,
    cpuModel: cpuInfo?.brand || cpuInfo?.manufacturer || "Unknown CPU",
    logicalCores: Number(cpuInfo?.cores || os.cpus().length || 0),
    physicalCores: Number(cpuInfo?.physicalCores || 0),
    memoryTotalGb: round(bytesToGb(memInfo?.total || os.totalmem()), 1),
    gpuModel: gpu?.model || "N/A",
    capabilities: {
      gpuTelemetry: Boolean(gpu),
      temperatureTelemetry: false,
      processTelemetry: true,
      diskTelemetry: false,
      networkRateTelemetry: false
    }
  };
}

function normalizeProcessTop() {
  return processTopCache.map((entry) => ({
    name: entry.name,
    cpu: round(entry.cpu, 1),
    memoryMb: Math.max(0, round(entry.memoryMb, 0))
  }));
}

async function collectSample() {
  tickCount += 1;
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

  if (tickCount % Math.max(1, Math.round(2000 / SAMPLE_RATE_MS)) === 0 || processTopCache.length === 0) {
    refreshProcessTop(memoryTotalBytes).catch(() => {
      console.warn("[agent] process refresh failed");
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
  const hasDiskTelemetry = Number.isFinite(diskReadRawBytesSec)
    || Number.isFinite(diskWriteRawBytesSec)
    || ioPerSecond > 0
    || (Number.isFinite(rawDiskLatency) && rawDiskLatency > 0);

  const diskRead = round(bytesPerSecToMb(Number.isFinite(diskReadRawBytesSec) ? diskReadRawBytesSec : 0), 3);
  const diskWrite = round(bytesPerSecToMb(Number.isFinite(diskWriteRawBytesSec) ? diskWriteRawBytesSec : 0), 3);
  const estimatedDiskLatency = clamp(2.2 + (ioPerSecond > 0 ? 1000 / ioPerSecond : 0) + ((diskRead + diskWrite) / 180), 1.1, 80);
  const hasNativeDiskLatency = Number.isFinite(rawDiskLatency) && rawDiskLatency > 0;
  const diskLatency = hasDiskTelemetry
    ? (hasNativeDiskLatency ? round(rawDiskLatency, 1) : round(estimatedDiskLatency, 1))
    : 0;

  const diskVolumes = hasDiskTelemetry
    ? [{
      name: "TOTAL",
      read: round(diskRead, 3),
      write: round(diskWrite, 3),
      total: round(diskRead + diskWrite, 3),
      latencyMs: round(diskLatency, 3),
      source: "agent-systeminformation"
    }]
    : [];

  const aggregateNet = aggregateNetworkStats(networkStats);
  const netRates = resolveNetworkRates(aggregateNet);
  const netUp = round(bytesPerSecToMb(netRates.txSec), 3);
  const netDown = round(bytesPerSecToMb(netRates.rxSec), 3);
  const networkRateAvailable = netRates.available;

  const networkInterfaces = aggregateNet.interfaces
    .map((entry) => {
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
    .sort((left, right) => right.total - left.total)
    .slice(0, 12);

  const packetLossValue = round(updatePacketLoss(aggregateNet), 2);

  const cpuTemp = firstFinite([cpuTemperature?.main, cpuTemperature?.max, gpu?.temperature], NaN);
  const hasTemperatureSensor = Number.isFinite(cpuTemp) && cpuTemp > 0;
  const temp = hasTemperatureSensor
    ? round(cpuTemp, 1)
    : round(34 + (cpu * 0.26) + (gpuLoad * 0.18), 1);

  if (hostMeta?.capabilities) {
    hostMeta.capabilities.temperatureTelemetry = hostMeta.capabilities.temperatureTelemetry || hasTemperatureSensor;
    hostMeta.capabilities.diskTelemetry = hostMeta.capabilities.diskTelemetry || hasDiskTelemetry;
    hostMeta.capabilities.networkRateTelemetry = hostMeta.capabilities.networkRateTelemetry || networkRateAvailable;
    hostMeta.capabilities.gpuTelemetry = hostMeta.capabilities.gpuTelemetry || Boolean(gpu);
  }

  const ts = Date.now();
  return {
    ts,
    isoTime: new Date(ts).toISOString(),
    sampleRateMs: SAMPLE_RATE_MS,
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
    gpuName: gpu?.model || hostMeta?.gpuModel || "N/A",
    gpuTemp: Number.isFinite(gpu?.temperature) ? round(gpu.temperature, 1) : null,
    vram,
    vramUsedGb,
    vramTotalGb,
    diskRead,
    diskWrite,
    diskLatency,
    diskTelemetryAvailable: hasDiskTelemetry,
    diskTelemetrySource: hasDiskTelemetry ? "systeminformation" : "none",
    diskVolumes,
    diskLatencyEstimated: hasDiskTelemetry && !hasNativeDiskLatency,
    netUp,
    netDown,
    networkRateAvailable,
    networkIfaces: networkInterfaces.map((entry) => entry.name),
    networkInterfaces,
    packetLoss: packetLossValue,
    netConnections: 0,
    temp,
    tempEstimated: !hasTemperatureSensor,
    processTop: normalizeProcessTop(),
    activeAlerts: [],
    events: []
  };
}

async function postIngest(payload) {
  const controller = new AbortController();
  const timerId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const headers = {
      "Content-Type": "application/json"
    };
    if (API_KEY) {
      headers["X-Agent-Key"] = API_KEY;
    }

    const response = await fetch(`${MASTER_URL.replace(/\/$/, "")}/api/agent/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify(payload),
      signal: controller.signal
    });

    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${text}`.trim());
    }

    return await response.json().catch(() => ({}));
  } finally {
    clearTimeout(timerId);
  }
}

async function runTick() {
  if (!hostMeta) {
    await collectHostMeta();
  }

  const sample = await collectSample();
  const payload = {
    host: {
      id: sanitizeHostId(RAW_HOST_ID),
      name: HOST_NAME || os.hostname(),
      source: "agent",
      meta: hostMeta
    },
    sample
  };

  const result = await postIngest(payload);
  const events = Number(result?.events || 0);
  console.log(`[agent] sent sample ts=${sample.ts} cpu=${sample.cpu}% mem=${sample.mem}% events=${events}`);
}

async function bootstrap() {
  const hostId = sanitizeHostId(RAW_HOST_ID);
  console.log(`[agent] starting for host=${hostId} name=${HOST_NAME || os.hostname()}`);
  console.log(`[agent] master=${MASTER_URL}`);
  console.log(`[agent] sampleRateMs=${SAMPLE_RATE_MS}`);

  await collectHostMeta();
  await postIngest({
    host: {
      id: hostId,
      name: HOST_NAME || os.hostname(),
      source: "agent",
      meta: hostMeta
    },
    samples: []
  }).catch((error) => {
    console.warn(`[agent] metadata register failed: ${error.message}`);
  });

  await runTick().catch((error) => {
    console.warn(`[agent] first tick failed: ${error.message}`);
  });

  timer = setInterval(() => {
    runTick().catch((error) => {
      console.warn(`[agent] tick failed: ${error.message}`);
    });
  }, SAMPLE_RATE_MS);

  setInterval(() => {
    collectHostMeta().catch((error) => {
      console.warn(`[agent] meta refresh failed: ${error.message}`);
    });
  }, META_REFRESH_INTERVAL_MS).unref();
}

function shutdown(signal) {
  console.log(`[agent] shutdown (${signal})`);
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  setTimeout(() => process.exit(0), 300).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

bootstrap().catch((error) => {
  console.error(`[agent] bootstrap failed: ${error.message}`);
  process.exit(1);
});
