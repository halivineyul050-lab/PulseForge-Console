const dom = {
  hostSelect: document.getElementById("hostSelect"),
  sampleRate: document.getElementById("sampleRate"),
  timeRange: document.getElementById("timeRange"),
  themeToggle: document.getElementById("themeToggle"),
  freezeToggle: document.getElementById("freezeToggle"),
  exportCsvBtn: document.getElementById("exportCsvBtn"),
  reconnectBtn: document.getElementById("reconnectBtn"),
  hostName: document.getElementById("hostName"),
  systemInfo: document.getElementById("systemInfo"),
  sourceInfo: document.getElementById("sourceInfo"),
  clock: document.getElementById("clock"),
  alertBadge: document.getElementById("alertBadge"),
  connectionBadge: document.getElementById("connectionBadge"),
  cpuValue: document.getElementById("cpuValue"),
  cpuSub: document.getElementById("cpuSub"),
  memValue: document.getElementById("memValue"),
  memSub: document.getElementById("memSub"),
  gpuValue: document.getElementById("gpuValue"),
  gpuSub: document.getElementById("gpuSub"),
  diskValue: document.getElementById("diskValue"),
  diskSub: document.getElementById("diskSub"),
  netValue: document.getElementById("netValue"),
  netSub: document.getElementById("netSub"),
  networkIfaceSelect: document.getElementById("networkIfaceSelect"),
  tempValue: document.getElementById("tempValue"),
  tempSub: document.getElementById("tempSub"),
  coreHeatmap: document.getElementById("coreHeatmap"),
  diskVolumeRows: document.getElementById("diskVolumeRows"),
  networkIfaceRows: document.getElementById("networkIfaceRows"),
  processRows: document.getElementById("processRows"),
  alertList: document.getElementById("alertList"),
  systemFacts: document.getElementById("systemFacts")
};

if (typeof echarts === "undefined") {
  throw new Error("ECharts 未加载，无法初始化图表");
}

const charts = {
  cpu: echarts.init(document.getElementById("cpuChart")),
  memory: echarts.init(document.getElementById("memoryChart")),
  gpu: echarts.init(document.getElementById("gpuChart")),
  disk: echarts.init(document.getElementById("diskChart")),
  diskVolume: echarts.init(document.getElementById("diskVolumeChart")),
  network: echarts.init(document.getElementById("networkChart"))
};

const DEFAULT_SERVER_URL = "http://127.0.0.1:4510";
const FALLBACK_CORE_COUNT = 12;
const MAX_ALERTS = 120;
const MAX_SEEN_EVENT_IDS = 2000;
const HISTORY_TRIM_HEADROOM = 64;
const WS_PING_INTERVAL_MS = 10000;
const LIVE_STALE_CHECK_INTERVAL_MS = 2000;
const LIVE_STALE_FACTOR = 6;
const STORAGE_KEYS = {
  theme: "pulseforge-theme",
  sampleRate: "pulseforge-sample-rate",
  rangeMinutes: "pulseforge-range-minutes",
  selectedHostId: "pulseforge-selected-host-id"
};

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

const mockProcessSeeds = [
  { name: "chrome.exe", cpu: 7.2, memoryMb: 1450 },
  { name: "Code.exe", cpu: 4.5, memoryMb: 980 },
  { name: "WeChat.exe", cpu: 2.2, memoryMb: 650 },
  { name: "obs64.exe", cpu: 6.3, memoryMb: 1180 },
  { name: "steamwebhelper.exe", cpu: 1.1, memoryMb: 420 },
  { name: "explorer.exe", cpu: 0.9, memoryMb: 260 },
  { name: "node.exe", cpu: 3.4, memoryMb: 540 }
];

function readStoredNumber(key) {
  try {
    const rawValue = localStorage.getItem(key);
    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readStoredString(key) {
  try {
    const value = localStorage.getItem(key);
    return value === null ? null : String(value);
  } catch {
    return null;
  }
}

function saveStoredNumber(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore storage failures
  }
}

function saveStoredString(key, value) {
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // ignore storage failures
  }
}

function resolveInitialSelectValue(selectElement, storageKey, fallbackValue) {
  const allowed = Array.from(selectElement.options)
    .map((option) => Number(option.value))
    .filter((value) => Number.isFinite(value));
  const stored = readStoredNumber(storageKey);
  if (Number.isFinite(stored) && allowed.includes(stored)) {
    return stored;
  }
  return fallbackValue;
}

const initialSampleRate = resolveInitialSelectValue(
  dom.sampleRate,
  STORAGE_KEYS.sampleRate,
  Number(dom.sampleRate.value)
);
const initialRangeMinutes = resolveInitialSelectValue(
  dom.timeRange,
  STORAGE_KEYS.rangeMinutes,
  Number(dom.timeRange.value)
);

const state = {
  sampleRateMs: initialSampleRate,
  rangeMinutes: initialRangeMinutes,
  frozen: false,
  theme: readStoredString(STORAGE_KEYS.theme) || document.documentElement.dataset.theme || "light",
  connected: false,
  usingMock: false,
  connecting: false,
  connectionMode: "connecting",
  connectionDetail: "",
  ws: null,
  serverLocalHostId: null,
  selectedHostId: readStoredString(STORAGE_KEYS.selectedHostId) || "",
  hostOptionsSignature: "",
  hosts: [],
  selectedNetworkIface: "__ALL__",
  networkIfaceOptionsSignature: "",
  reconnectAttempt: 0,
  lastSampleTs: 0,
  lastSampleArrivalTs: 0,
  wsLatencyMs: null,
  lastPongTs: 0,
  historyLoadedMinutes: initialRangeMinutes,
  memTotalGb: 32,
  vramTotalGb: 0,
  metrics: createEmptyMetrics(),
  coreLoads: Array.from({ length: FALLBACK_CORE_COUNT }, () => 20),
  diskVolumeHistory: {},
  networkIfaceHistory: {},
  processes: [],
  history: createHistoryStore(),
  alerts: [],
  alertFlags: {},
  seenEventIds: new Set(),
  seenEventOrder: [],
  meta: {
    hostName: "HOST-LOCAL",
    os: "Unknown OS",
    cpuModel: "Unknown CPU",
    logicalCores: FALLBACK_CORE_COUNT,
    physicalCores: 0,
    memoryTotalGb: 32,
    gpuModel: "N/A",
    capabilities: {}
  }
};

const mockState = {
  netConnections: 312,
  packetLoss: 0.12,
  processes: mockProcessSeeds.map((item) => ({ ...item })),
  alertRegistry: new Map()
};

let clockTimer = null;
let mockTimer = null;
let reconnectTimer = null;
let pingTimer = null;
let staleTimer = null;
let hostPollTimer = null;
let renderQueued = false;

function createEmptyMetrics() {
  return {
    ts: Date.now(),
    cpu: 0,
    cpuFreq: 0,
    mem: 0,
    memUsedGb: 0,
    memTotalGb: 32,
    swap: 0,
    swapUsedGb: 0,
    swapTotalGb: 0,
    gpu: 0,
    gpuName: "N/A",
    gpuTemp: null,
    vram: 0,
    vramUsedGb: 0,
    vramTotalGb: 0,
    diskRead: 0,
    diskWrite: 0,
    diskLatency: 0,
    diskTelemetryAvailable: true,
    diskTelemetrySource: "none",
    diskVolumes: [],
    diskLatencyEstimated: false,
    netUp: 0,
    netDown: 0,
    networkRateAvailable: true,
    networkIfaces: [],
    networkInterfaces: [],
    packetLoss: 0,
    netConnections: 0,
    temp: 0,
    tempEstimated: false,
    processTop: [],
    activeAlerts: [],
    events: []
  };
}

function createHistoryStore() {
  return {
    ts: [],
    labels: [],
    cpu: [],
    cpuFreq: [],
    mem: [],
    swap: [],
    gpu: [],
    vram: [],
    diskRead: [],
    diskWrite: [],
    diskLatency: [],
    netUp: [],
    netDown: [],
    packetLoss: [],
    temp: []
  };
}

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

function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function randomBetween(min, max) {
  return Math.random() * (max - min) + min;
}

function formatClock(dateValue) {
  return dateValue.toLocaleTimeString("zh-CN", { hour12: false });
}

function formatDurationMs(durationMs) {
  const safeDuration = Math.max(0, Math.round(durationMs));
  if (safeDuration < 1000) {
    return `${safeDuration}ms`;
  }
  const seconds = safeDuration / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  const remainSeconds = Math.floor(seconds % 60);
  return `${minutes}m ${remainSeconds}s`;
}

function formatRateMb(value) {
  const safeValue = Math.max(0, numberOr(value, 0));
  if (safeValue > 0 && safeValue < 0.1) {
    return "<0.1";
  }
  return safeValue.toFixed(1);
}

function formatNetworkRate(valueMbPerSec) {
  const safeValue = Math.max(0, numberOr(valueMbPerSec, 0));
  if (safeValue >= 1) {
    return `${safeValue.toFixed(1)}MB/s`;
  }
  const kbPerSec = safeValue * 1024;
  if (kbPerSec >= 0.1) {
    return `${kbPerSec.toFixed(1)}KB/s`;
  }
  return "0KB/s";
}

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function normalizeHostId(hostId) {
  return String(hostId || "").trim();
}

function isViewingLocalHost() {
  const selectedHostId = normalizeHostId(state.selectedHostId);
  const localHostId = normalizeHostId(state.serverLocalHostId);
  if (!localHostId) {
    return true;
  }
  if (!selectedHostId) {
    return true;
  }
  return selectedHostId === localHostId;
}

function updateSampleRateInteractivity() {
  const canEdit = isViewingLocalHost();
  dom.sampleRate.disabled = !canEdit;
  dom.sampleRate.title = canEdit ? "" : "远端主机暂不支持在主控台直接改采样率";
}

function normalizeHostList(rawHosts) {
  if (!Array.isArray(rawHosts)) {
    return [];
  }

  return rawHosts
    .map((host) => ({
      hostId: normalizeHostId(host?.hostId),
      hostName: String(host?.hostName || host?.hostId || "Unknown Host"),
      source: String(host?.source || "unknown"),
      online: host?.online !== false,
      lastSeenTs: numberOr(host?.lastSeenTs, 0),
      cpu: host?.cpu,
      mem: host?.mem,
      temp: host?.temp,
      activeAlertCount: Math.max(0, Math.round(numberOr(host?.activeAlertCount, 0)))
    }))
    .filter((host) => host.hostId.length > 0)
    .sort((left, right) => {
      if (left.hostId === state.serverLocalHostId && right.hostId !== state.serverLocalHostId) {
        return -1;
      }
      if (right.hostId === state.serverLocalHostId && left.hostId !== state.serverLocalHostId) {
        return 1;
      }
      return right.lastSeenTs - left.lastSeenTs;
    });
}

function hostSourceLabel(source) {
  if (source === "local") {
    return "本机";
  }
  if (source === "agent") {
    return "Agent";
  }
  return source || "unknown";
}

function hostOptionLabel(host) {
  const status = host.online ? "在线" : "离线";
  return `${host.hostName} · ${hostSourceLabel(host.source)} · ${status}`;
}

function syncHostOptions() {
  const hosts = normalizeHostList(state.hosts);
  state.hosts = hosts;

  if (hosts.length === 0) {
    if (dom.hostSelect) {
      dom.hostSelect.innerHTML = `<option value="">当前主机</option>`;
      dom.hostSelect.value = "";
    }
    updateSampleRateInteractivity();
    return;
  }

  const signature = hosts.map((host) => `${host.hostId}:${host.online ? 1 : 0}:${host.lastSeenTs}`).join("|");
  if (signature !== state.hostOptionsSignature && dom.hostSelect) {
    dom.hostSelect.innerHTML = hosts
      .map((host) => `<option value="${escapeHtml(host.hostId)}">${escapeHtml(hostOptionLabel(host))}</option>`)
      .join("");
    state.hostOptionsSignature = signature;
  }

  const storedHostId = normalizeHostId(readStoredString(STORAGE_KEYS.selectedHostId));
  const preferredHostId = normalizeHostId(state.selectedHostId)
    || storedHostId
    || normalizeHostId(state.serverLocalHostId)
    || hosts[0].hostId;

  const exists = hosts.some((host) => host.hostId === preferredHostId);
  const nextHostId = exists
    ? preferredHostId
    : (normalizeHostId(state.serverLocalHostId) || hosts[0].hostId);

  state.selectedHostId = nextHostId;
  if (dom.hostSelect) {
    dom.hostSelect.value = nextHostId;
  }
  saveStoredString(STORAGE_KEYS.selectedHostId, nextHostId);
  updateSampleRateInteractivity();
}

function applyHostsPayload(payload) {
  if (!payload || typeof payload !== "object") {
    return;
  }

  if (payload.localHostId) {
    state.serverLocalHostId = normalizeHostId(payload.localHostId);
  }

  if (Array.isArray(payload.hosts)) {
    state.hosts = normalizeHostList(payload.hosts);
    syncHostOptions();
  }
}

function syncNetworkIfaceOptions() {
  const namesByRate = state.metrics.networkInterfaces
    .map((entry) => ({
      name: String(entry.name || "").trim(),
      total: numberOr(entry.total, 0)
    }))
    .filter((entry) => entry.name.length > 0)
    .sort((left, right) => {
      if (right.total !== left.total) {
        return right.total - left.total;
      }
      return left.name.localeCompare(right.name);
    });

  const seen = new Set();
  const names = [];
  for (const entry of namesByRate) {
    if (!seen.has(entry.name)) {
      seen.add(entry.name);
      names.push(entry.name);
    }
  }

  for (const name of Object.keys(state.networkIfaceHistory)) {
    if (!seen.has(name)) {
      seen.add(name);
      names.push(name);
    }
  }

  const signature = names.join("|");
  const previousSelect = state.selectedNetworkIface || dom.networkIfaceSelect.value || "__ALL__";

  if (signature !== state.networkIfaceOptionsSignature) {
    const options = [
      `<option value="__ALL__">全部网卡</option>`,
      ...names.map((name) => `<option value="${escapeHtml(name)}">${escapeHtml(name)}</option>`)
    ];
    dom.networkIfaceSelect.innerHTML = options.join("");
    state.networkIfaceOptionsSignature = signature;
  }

  const nextSelect = names.includes(previousSelect) ? previousSelect : "__ALL__";
  state.selectedNetworkIface = nextSelect;
  dom.networkIfaceSelect.value = nextSelect;
}

function formatSampleRateLabel(sampleRateMs) {
  if (sampleRateMs % 1000 === 0) {
    return `${sampleRateMs / 1000}s`;
  }
  return `${sampleRateMs}ms`;
}

function maxHistoryPoints() {
  const estimate = Math.floor((state.rangeMinutes * 60 * 1000) / Math.max(state.sampleRateMs, 250));
  return Math.max(32, estimate);
}

function trimHistoryStore() {
  const maxPoints = maxHistoryPoints();
  const trimTrigger = maxPoints + HISTORY_TRIM_HEADROOM;
  for (const key of Object.keys(state.history)) {
    const values = state.history[key];
    if (values.length > trimTrigger) {
      values.splice(0, values.length - maxPoints);
    }
  }

  for (const [name, values] of Object.entries(state.diskVolumeHistory)) {
    if (values.length > trimTrigger) {
      values.splice(0, values.length - maxPoints);
    }

    const hasAnyValue = values.some((value) => value !== null && Number.isFinite(value));
    if (!hasAnyValue && state.metrics.diskVolumes.every((volume) => volume.name !== name)) {
      delete state.diskVolumeHistory[name];
    }
  }

  for (const [name, series] of Object.entries(state.networkIfaceHistory)) {
    if (series.up.length > trimTrigger) {
      series.up.splice(0, series.up.length - maxPoints);
    }
    if (series.down.length > trimTrigger) {
      series.down.splice(0, series.down.length - maxPoints);
    }

    const hasAnyValue = series.up.some((value) => value !== null && Number.isFinite(value))
      || series.down.some((value) => value !== null && Number.isFinite(value));
    if (!hasAnyValue && state.metrics.networkInterfaces.every((entry) => entry.name !== name)) {
      delete state.networkIfaceHistory[name];
    }
  }
}

function pushHistoryPoint(sample) {
  state.history.ts.push(sample.ts);
  state.history.labels.push(formatClock(new Date(sample.ts)));
  state.history.cpu.push(sample.cpu);
  state.history.cpuFreq.push(sample.cpuFreq);
  state.history.mem.push(sample.mem);
  state.history.swap.push(sample.swap);
  state.history.gpu.push(sample.gpu);
  state.history.vram.push(sample.vram);
  state.history.diskRead.push(sample.diskRead);
  state.history.diskWrite.push(sample.diskWrite);
  state.history.diskLatency.push(sample.diskLatency);
  state.history.netUp.push(sample.netUp);
  state.history.netDown.push(sample.netDown);
  state.history.packetLoss.push(sample.packetLoss);
  state.history.temp.push(sample.temp);
  pushDiskVolumeHistory(sample.diskVolumes);
  pushNetworkInterfaceHistory(sample.networkInterfaces);
  trimHistoryStore();
}

function pushDiskVolumeHistory(diskVolumes) {
  const seriesLength = state.history.ts.length;
  const volumeMap = new Map();

  if (Array.isArray(diskVolumes)) {
    for (const volume of diskVolumes) {
      const name = String(volume?.name || "").trim().toUpperCase();
      if (!name) {
        continue;
      }
      volumeMap.set(name, numberOr(volume.total, 0));
    }
  }

  for (const [name, values] of Object.entries(state.diskVolumeHistory)) {
    const nextValue = volumeMap.has(name) ? volumeMap.get(name) : null;
    values.push(nextValue);
  }

  for (const [name, value] of volumeMap.entries()) {
    if (!state.diskVolumeHistory[name]) {
      const seed = Array(Math.max(0, seriesLength - 1)).fill(null);
      seed.push(value);
      state.diskVolumeHistory[name] = seed;
    }
  }
}

function pushNetworkInterfaceHistory(networkInterfaces) {
  const seriesLength = state.history.ts.length;
  const ifaceMap = new Map();

  if (Array.isArray(networkInterfaces)) {
    for (const iface of networkInterfaces) {
      const name = String(iface?.name || "").trim();
      if (!name) {
        continue;
      }
      ifaceMap.set(name, {
        up: numberOr(iface?.up, 0),
        down: numberOr(iface?.down, 0)
      });
    }
  }

  for (const [name, series] of Object.entries(state.networkIfaceHistory)) {
    const next = ifaceMap.get(name);
    series.up.push(next ? next.up : null);
    series.down.push(next ? next.down : null);
  }

  for (const [name, value] of ifaceMap.entries()) {
    if (!state.networkIfaceHistory[name]) {
      const seedUp = Array(Math.max(0, seriesLength - 1)).fill(null);
      const seedDown = Array(Math.max(0, seriesLength - 1)).fill(null);
      seedUp.push(value.up);
      seedDown.push(value.down);
      state.networkIfaceHistory[name] = {
        up: seedUp,
        down: seedDown
      };
    }
  }
}

function normalizeProcessList(rawList) {
  if (!Array.isArray(rawList)) {
    return [];
  }

  return rawList.slice(0, 5).map((item) => {
    return {
      name: String(item.name || "unknown").slice(0, 48),
      cpu: round(numberOr(item.cpu, 0), 1),
      memoryMb: round(numberOr(item.memoryMb, item.memory || 0), 0)
    };
  });
}

function normalizeDiskVolumes(rawVolumes) {
  if (!Array.isArray(rawVolumes)) {
    return [];
  }

  return rawVolumes
    .map((item) => {
      const rawName = String(item?.name || "").trim();
      const name = rawName ? rawName.toUpperCase() : "";
      const read = clamp(round(numberOr(item?.read, 0), 3), 0, 5000);
      const write = clamp(round(numberOr(item?.write, 0), 3), 0, 5000);
      const totalRaw = numberOr(item?.total, read + write);
      const total = clamp(round(totalRaw, 3), 0, 10000);
      const latencyMs = Number(item?.latencyMs);

      return {
        name,
        read,
        write,
        total,
        latencyMs: Number.isFinite(latencyMs) ? round(latencyMs, 3) : null,
        source: String(item?.source || "unknown")
      };
    })
    .filter((item) => item.name.length > 0)
    .sort((left, right) => {
      if (right.total !== left.total) {
        return right.total - left.total;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, 12);
}

function normalizeNetworkInterfaces(rawInterfaces) {
  if (!Array.isArray(rawInterfaces)) {
    return [];
  }

  return rawInterfaces
    .map((item) => {
      const rawName = String(item?.name || "").trim();
      const name = rawName.length > 0 ? rawName : "";
      const up = clamp(round(numberOr(item?.up, 0), 3), 0, 2000);
      const down = clamp(round(numberOr(item?.down, 0), 3), 0, 2000);
      const totalRaw = numberOr(item?.total, up + down);
      const total = clamp(round(totalRaw, 3), 0, 4000);

      return {
        name,
        up,
        down,
        total,
        rateAvailable: item?.rateAvailable !== false,
        source: String(item?.source || "unknown")
      };
    })
    .filter((item) => item.name.length > 0)
    .sort((left, right) => {
      if (right.total !== left.total) {
        return right.total - left.total;
      }
      return left.name.localeCompare(right.name);
    })
    .slice(0, 12);
}

function normalizeSample(rawSample) {
  const ts = numberOr(rawSample?.ts, Date.now());
  const memTotalGb = round(numberOr(rawSample?.memTotalGb, state.memTotalGb || 32), 2);
  const vramTotalGb = round(numberOr(rawSample?.vramTotalGb, state.vramTotalGb || 0), 2);

  const normalized = {
    ts,
    cpu: clamp(round(numberOr(rawSample?.cpu, state.metrics.cpu), 1), 0, 100),
    cpuFreq: clamp(round(numberOr(rawSample?.cpuFreq, state.metrics.cpuFreq), 2), 0, 10),
    cpuCores: Array.isArray(rawSample?.cpuCores) && rawSample.cpuCores.length > 0
      ? rawSample.cpuCores.map((value) => clamp(round(numberOr(value, 0), 1), 0, 100))
      : state.coreLoads,
    mem: clamp(round(numberOr(rawSample?.mem, state.metrics.mem), 1), 0, 100),
    memUsedGb: round(numberOr(rawSample?.memUsedGb, (memTotalGb * numberOr(rawSample?.mem, state.metrics.mem)) / 100), 2),
    memTotalGb,
    swap: clamp(round(numberOr(rawSample?.swap, state.metrics.swap), 1), 0, 100),
    swapUsedGb: round(numberOr(rawSample?.swapUsedGb, 0), 2),
    swapTotalGb: round(numberOr(rawSample?.swapTotalGb, 0), 2),
    gpu: clamp(round(numberOr(rawSample?.gpu, state.metrics.gpu), 1), 0, 100),
    gpuName: String(rawSample?.gpuName || state.metrics.gpuName || state.meta.gpuModel || "N/A"),
    gpuTemp: rawSample?.gpuTemp === null ? null : round(numberOr(rawSample?.gpuTemp, 0), 1),
    vram: clamp(round(numberOr(rawSample?.vram, state.metrics.vram), 1), 0, 100),
    vramUsedGb: round(numberOr(rawSample?.vramUsedGb, vramTotalGb * numberOr(rawSample?.vram, state.metrics.vram) / 100), 2),
    vramTotalGb,
    diskRead: clamp(round(numberOr(rawSample?.diskRead, state.metrics.diskRead), 1), 0, 5000),
    diskWrite: clamp(round(numberOr(rawSample?.diskWrite, state.metrics.diskWrite), 1), 0, 5000),
    diskLatency: clamp(round(numberOr(rawSample?.diskLatency, state.metrics.diskLatency), 1), 0, 300),
    diskTelemetryAvailable: rawSample?.diskTelemetryAvailable !== false,
    diskTelemetrySource: String(rawSample?.diskTelemetrySource || state.metrics.diskTelemetrySource || "none"),
    diskVolumes: normalizeDiskVolumes(rawSample?.diskVolumes),
    diskLatencyEstimated: Boolean(rawSample?.diskLatencyEstimated),
    netUp: clamp(round(numberOr(rawSample?.netUp, state.metrics.netUp), 3), 0, 2000),
    netDown: clamp(round(numberOr(rawSample?.netDown, state.metrics.netDown), 3), 0, 2000),
    networkRateAvailable: rawSample?.networkRateAvailable !== false,
    networkIfaces: Array.isArray(rawSample?.networkIfaces)
      ? rawSample.networkIfaces.map((name) => String(name)).filter((name) => name.length > 0).slice(0, 8)
      : (Array.isArray(state.metrics.networkIfaces) ? state.metrics.networkIfaces : []),
    networkInterfaces: normalizeNetworkInterfaces(rawSample?.networkInterfaces),
    packetLoss: clamp(round(numberOr(rawSample?.packetLoss, state.metrics.packetLoss), 2), 0, 100),
    netConnections: Math.max(0, Math.round(numberOr(rawSample?.netConnections, state.metrics.netConnections))),
    temp: clamp(round(numberOr(rawSample?.temp, state.metrics.temp), 1), 0, 120),
    tempEstimated: Boolean(rawSample?.tempEstimated),
    processTop: normalizeProcessList(rawSample?.processTop),
    activeAlerts: Array.isArray(rawSample?.activeAlerts) ? rawSample.activeAlerts : [],
    events: Array.isArray(rawSample?.events) ? rawSample.events : []
  };

  if (!normalized.cpuCores || normalized.cpuCores.length === 0) {
    normalized.cpuCores = state.coreLoads.length > 0
      ? state.coreLoads
      : Array.from({ length: FALLBACK_CORE_COUNT }, () => normalized.cpu);
  }

  if (normalized.diskVolumes.length === 0 && normalized.diskTelemetryAvailable) {
    normalized.diskVolumes = [{
      name: "TOTAL",
      read: round(normalized.diskRead, 3),
      write: round(normalized.diskWrite, 3),
      total: round(normalized.diskRead + normalized.diskWrite, 3),
      latencyMs: Number.isFinite(normalized.diskLatency) ? round(normalized.diskLatency, 3) : null,
      source: normalized.diskTelemetrySource
    }];
  }

  if (normalized.networkInterfaces.length === 0 && normalized.networkRateAvailable) {
    const fallbackIfaces = normalized.networkIfaces.length > 0
      ? normalized.networkIfaces
      : ["TOTAL"];
    normalized.networkInterfaces = fallbackIfaces.slice(0, 8).map((name, index) => {
      if (index === 0) {
        return {
          name,
          up: round(normalized.netUp, 3),
          down: round(normalized.netDown, 3),
          total: round(normalized.netUp + normalized.netDown, 3),
          rateAvailable: true,
          source: "aggregate"
        };
      }

      return {
        name,
        up: 0,
        down: 0,
        total: 0,
        rateAvailable: false,
        source: "aggregate"
      };
    });
  }

  if (normalized.networkIfaces.length === 0 && normalized.networkInterfaces.length > 0) {
    normalized.networkIfaces = normalized.networkInterfaces.map((entry) => entry.name).slice(0, 8);
  }

  return normalized;
}

function eventIdFor(rawEvent) {
  if (rawEvent?.id) {
    return String(rawEvent.id);
  }
  const ts = numberOr(rawEvent?.ts, Date.now());
  const key = String(rawEvent?.key || rawEvent?.content || "event");
  return `${ts}-${key}`;
}

function addSeenEventId(eventId) {
  if (state.seenEventIds.has(eventId)) {
    return false;
  }

  state.seenEventIds.add(eventId);
  state.seenEventOrder.push(eventId);

  if (state.seenEventOrder.length > MAX_SEEN_EVENT_IDS) {
    const staleId = state.seenEventOrder.shift();
    state.seenEventIds.delete(staleId);
  }

  return true;
}

function pushEvents(rawEvents) {
  if (!Array.isArray(rawEvents) || rawEvents.length === 0) {
    return;
  }

  for (const rawEvent of rawEvents.slice().reverse()) {
    const eventId = eventIdFor(rawEvent);
    if (!addSeenEventId(eventId)) {
      continue;
    }

    const ts = numberOr(rawEvent?.ts, Date.now());
    const level = String(rawEvent?.level || "info");
    const content = String(rawEvent?.content || rawEvent?.message || "系统事件");

    state.alerts.unshift({
      id: eventId,
      ts,
      time: String(rawEvent?.time || formatClock(new Date(ts))),
      level,
      content
    });
  }

  if (state.alerts.length > MAX_ALERTS) {
    state.alerts.splice(MAX_ALERTS);
  }
}

function flagsFromActiveAlerts(activeAlerts) {
  const nextFlags = {};
  for (const entry of activeAlerts) {
    const key = String(entry.key || entry.message || `alert-${Object.keys(nextFlags).length}`);
    nextFlags[key] = true;
  }
  return nextFlags;
}

function flagsFromThresholds(sample) {
  const nextFlags = {};
  for (const rule of ALERT_RULES) {
    if (rule.trigger(sample)) {
      nextFlags[rule.key] = true;
    }
  }
  return nextFlags;
}

function evaluateAlertTransitions(sample, registry) {
  const newEvents = [];

  for (const rule of ALERT_RULES) {
    const active = rule.trigger(sample);
    const existing = registry.get(rule.key);

    if (active && !existing) {
      const activated = {
        key: rule.key,
        level: rule.level,
        message: rule.up(sample),
        sinceTs: sample.ts
      };
      registry.set(rule.key, activated);
      newEvents.push({
        id: `${sample.ts}-${rule.key}-up`,
        key: rule.key,
        level: rule.level,
        type: "trigger",
        content: activated.message,
        ts: sample.ts,
        time: formatClock(new Date(sample.ts))
      });
      continue;
    }

    if (active && existing) {
      existing.message = rule.up(sample);
      continue;
    }

    if (!active && existing) {
      registry.delete(rule.key);
      newEvents.push({
        id: `${sample.ts}-${rule.key}-down`,
        key: rule.key,
        level: "info",
        type: "resolve",
        content: rule.down,
        ts: sample.ts,
        time: formatClock(new Date(sample.ts))
      });
    }
  }

  const activeAlerts = Array.from(registry.values()).map((entry) => ({
    key: entry.key,
    level: entry.level,
    message: entry.message,
    sinceTs: entry.sinceTs,
    sinceTime: formatClock(new Date(entry.sinceTs))
  }));

  return {
    activeAlerts,
    events: newEvents
  };
}

function applyMeta(meta) {
  if (!meta || typeof meta !== "object") {
    return;
  }

  state.meta = {
    ...state.meta,
    ...meta,
    capabilities: {
      ...state.meta.capabilities,
      ...meta.capabilities
    }
  };

  dom.hostName.textContent = String(state.meta.hostName || "HOST-LOCAL").toUpperCase();

  const osText = String(state.meta.os || "Unknown OS");
  const coreText = Number(state.meta.logicalCores || state.coreLoads.length || FALLBACK_CORE_COUNT);
  const memText = round(numberOr(state.meta.memoryTotalGb, state.memTotalGb || 32), 1);

  dom.systemInfo.textContent = `${osText} · ${coreText} Core · ${memText}GB RAM`;

  if (memText > 0) {
    state.memTotalGb = memText;
  }
}

function applyConfig(config) {
  if (!config || typeof config !== "object") {
    return;
  }

  if (Array.isArray(config.allowedSampleRates) && config.allowedSampleRates.length > 0) {
    const normalizedRates = [...new Set(
      config.allowedSampleRates
        .map((value) => Number(value))
        .filter((value) => Number.isFinite(value) && value > 0)
    )].sort((left, right) => left - right);

    if (normalizedRates.length > 0) {
      const previousValue = Number(dom.sampleRate.value);
      dom.sampleRate.innerHTML = normalizedRates
        .map((value) => `<option value="${value}">${formatSampleRateLabel(value)}</option>`)
        .join("");

      if (normalizedRates.includes(previousValue)) {
        dom.sampleRate.value = String(previousValue);
      }
    }
  }

  const nextSampleRate = numberOr(config.sampleRateMs, state.sampleRateMs);
  state.sampleRateMs = Math.max(250, Math.round(nextSampleRate));
  dom.sampleRate.value = String(state.sampleRateMs);
  saveStoredNumber(STORAGE_KEYS.sampleRate, state.sampleRateMs);

  if (state.usingMock) {
    restartMockLoop();
  }
}

function applySample(rawSample, options = {}) {
  const normalized = normalizeSample(rawSample);

  state.metrics = normalized;
  state.lastSampleTs = normalized.ts;
  state.lastSampleArrivalTs = Date.now();
  state.memTotalGb = normalized.memTotalGb || state.memTotalGb;
  state.vramTotalGb = normalized.vramTotalGb || state.vramTotalGb;
  state.coreLoads = normalized.cpuCores;
  state.processes = normalized.processTop;
  syncNetworkIfaceOptions();

  if (options.recordHistory !== false) {
    pushHistoryPoint(normalized);
  }

  if (Array.isArray(normalized.activeAlerts) && normalized.activeAlerts.length >= 0) {
    state.alertFlags = normalized.activeAlerts.length > 0
      ? flagsFromActiveAlerts(normalized.activeAlerts)
      : flagsFromThresholds(normalized);
  } else {
    state.alertFlags = flagsFromThresholds(normalized);
  }

  if (!options.skipEvents && Array.isArray(normalized.events) && normalized.events.length > 0) {
    pushEvents(normalized.events);
  }

  if (!state.frozen && !options.skipRender) {
    requestRender();
  }
}

function resetHistory() {
  state.history = createHistoryStore();
  state.diskVolumeHistory = {};
  state.networkIfaceHistory = {};
}

function replaceHistory(points) {
  if (!Array.isArray(points)) {
    return;
  }
  resetHistory();
  for (const item of points) {
    const normalized = normalizeSample(item);
    pushHistoryPoint(normalized);
  }
}

function getServerBaseUrl() {
  const protocol = window.location.protocol;
  if (protocol === "http:" || protocol === "https:") {
    return window.location.origin;
  }
  return DEFAULT_SERVER_URL;
}

function buildWebSocketUrl(baseUrl) {
  const wsUrl = new URL(baseUrl);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/ws";
  wsUrl.search = "";
  const hostId = selectedHostForQuery();
  if (hostId) {
    wsUrl.searchParams.set("hostId", hostId);
  }
  wsUrl.hash = "";
  return wsUrl.toString();
}

function selectedHostForQuery() {
  return normalizeHostId(state.selectedHostId)
    || normalizeHostId(state.serverLocalHostId)
    || "";
}

function withHostQuery(pathText, hostId) {
  const normalizedHostId = normalizeHostId(hostId);
  if (!normalizedHostId) {
    return pathText;
  }

  const joiner = pathText.includes("?") ? "&" : "?";
  return `${pathText}${joiner}hostId=${encodeURIComponent(normalizedHostId)}`;
}

async function fetchJson(url, timeoutMs = 4000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchBootstrapData(baseUrl) {
  const hostsData = await fetchJson(`${baseUrl}/api/hosts`).catch(() => null);
  if (hostsData) {
    applyHostsPayload(hostsData);
  }

  const hostId = selectedHostForQuery();

  const [metaData, configData, latestData, historyData, eventsData] = await Promise.all([
    fetchJson(withHostQuery(`${baseUrl}/api/meta`, hostId)).catch(() => null),
    fetchJson(`${baseUrl}/api/config`).catch(() => null),
    fetchJson(withHostQuery(`${baseUrl}/api/latest`, hostId)).catch(() => null),
    fetchJson(withHostQuery(`${baseUrl}/api/history?minutes=${state.rangeMinutes}&limit=${maxHistoryPoints()}`, hostId)).catch(() => null),
    fetchJson(withHostQuery(`${baseUrl}/api/events?limit=60`, hostId)).catch(() => null)
  ]);

  if (metaData?.meta) {
    applyMeta(metaData.meta);
  }
  if (metaData?.server?.localHostId) {
    state.serverLocalHostId = normalizeHostId(metaData.server.localHostId);
    syncHostOptions();
  }
  if (metaData?.config) {
    applyConfig(metaData.config);
  }

  if (configData) {
    applyConfig(configData);
  }

  if (Array.isArray(historyData?.points) && historyData.points.length > 0) {
    replaceHistory(historyData.points);
    state.historyLoadedMinutes = state.rangeMinutes;
  }

  if (Array.isArray(eventsData?.events) && eventsData.events.length > 0) {
    pushEvents(eventsData.events);
  }

  if (latestData?.sample) {
    const latestTs = numberOr(latestData.sample.ts, 0);
    const historyLastTs = state.history.ts.length > 0 ? state.history.ts[state.history.ts.length - 1] : 0;
    applySample(latestData.sample, {
      skipRender: true,
      recordHistory: latestTs > historyLastTs,
      skipEvents: true
    });

    if (Array.isArray(latestData.activeAlerts)) {
      state.alertFlags = flagsFromActiveAlerts(latestData.activeAlerts);
    }
  }

  updateSampleRateInteractivity();
}

async function reloadHistoryFromServer(minutes) {
  if (!state.connected) {
    return;
  }

  const baseUrl = getServerBaseUrl();
  const hostId = selectedHostForQuery();
  const historyData = await fetchJson(withHostQuery(
    `${baseUrl}/api/history?minutes=${minutes}&limit=${maxHistoryPoints()}&source=auto`,
    hostId
  ));
  if (!Array.isArray(historyData?.points)) {
    return;
  }

  replaceHistory(historyData.points);
  state.historyLoadedMinutes = minutes;

  const latestTs = state.lastSampleTs;
  const historyLastTs = state.history.ts.length > 0 ? state.history.ts[state.history.ts.length - 1] : 0;
  if (latestTs > historyLastTs) {
    pushHistoryPoint(state.metrics);
  }
}

function sendSocketMessage(message) {
  if (!state.ws || state.ws.readyState !== WebSocket.OPEN) {
    return;
  }
  state.ws.send(JSON.stringify(message));
}

function setConnectionUi(mode, detail) {
  state.connectionMode = mode;
  state.connectionDetail = detail || "";
  dom.connectionBadge.classList.remove("pill-online", "pill-fallback", "pill-offline");

  const selectedHostId = normalizeHostId(state.selectedHostId);
  const selectedHost = state.hosts.find((host) => host.hostId === selectedHostId);
  const hostLabel = selectedHost?.hostName || state.meta.hostName || "当前主机";

  if (mode === "live") {
    dom.connectionBadge.textContent = "实时连接";
    dom.connectionBadge.classList.add("pill-online");
    dom.sourceInfo.textContent = `数据源: ${hostLabel} · 真机采集${detail ? ` · ${detail}` : ""}`;
    return;
  }

  if (mode === "mock") {
    dom.connectionBadge.textContent = "模拟模式";
    dom.connectionBadge.classList.add("pill-fallback");
    dom.sourceInfo.textContent = `数据源: ${hostLabel} · 模拟数据${detail ? ` · ${detail}` : ""}`;
    return;
  }

  if (mode === "connecting") {
    dom.connectionBadge.textContent = "连接中";
    dom.connectionBadge.classList.add("pill-offline");
    dom.sourceInfo.textContent = `数据源: ${hostLabel} · 正在连接采集服务`;
    return;
  }

  dom.connectionBadge.textContent = "离线";
  dom.connectionBadge.classList.add("pill-offline");
  dom.sourceInfo.textContent = `数据源: ${hostLabel} · 离线${detail ? ` · ${detail}` : ""}`;
}

function clearLiveWatchers() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
  if (staleTimer) {
    clearInterval(staleTimer);
    staleTimer = null;
  }
}

function startLiveWatchers() {
  clearLiveWatchers();

  pingTimer = setInterval(() => {
    if (!state.connected) {
      return;
    }
    const clientTs = Date.now();
    sendSocketMessage({
      type: "ping",
      payload: { clientTs }
    });
  }, WS_PING_INTERVAL_MS);

  staleTimer = setInterval(() => {
    if (!state.connected) {
      return;
    }

    const staleThreshold = Math.max(5000, state.sampleRateMs * LIVE_STALE_FACTOR);
    const elapsed = Date.now() - state.lastSampleArrivalTs;
    if (state.lastSampleArrivalTs > 0 && elapsed > staleThreshold) {
      setConnectionUi("offline", "数据超时，自动重连中");
      closeExistingSocket();
      if (!state.usingMock) {
        startMockLoop("实时数据超时");
      }
      scheduleReconnect();
    }
  }, LIVE_STALE_CHECK_INTERVAL_MS);
}

function stopMockLoop() {
  if (mockTimer) {
    clearInterval(mockTimer);
    mockTimer = null;
  }
  state.usingMock = false;
}

function restartMockLoop() {
  if (!state.usingMock) {
    return;
  }
  stopMockLoop();
  startMockLoop("采样频率已调整");
}

function warmupMockHistory(points = 20) {
  for (let index = 0; index < points; index += 1) {
    const sample = generateMockSample();
    applySample(sample, {
      skipRender: true,
      skipEvents: true
    });
  }
}

function startMockLoop(reason = "服务不可达") {
  if (state.usingMock && mockTimer) {
    return;
  }

  clearLiveWatchers();

  state.usingMock = true;
  state.connected = false;
  state.wsLatencyMs = null;
  setConnectionUi("mock", reason);

  if (state.history.ts.length < 8) {
    warmupMockHistory(20);
  }

  mockTimer = setInterval(() => {
    const sample = generateMockSample();
    applySample(sample);
  }, state.sampleRateMs);
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || state.connected) {
    return;
  }

  const delay = Math.min(30000, 1200 * (2 ** Math.min(state.reconnectAttempt, 5)));
  state.reconnectAttempt += 1;

  if (state.usingMock) {
    setConnectionUi("mock", `重连倒计时 ${formatDurationMs(delay)}`);
  } else {
    setConnectionUi("offline", `重连倒计时 ${formatDurationMs(delay)}`);
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectToLiveSource();
  }, delay);
}

function closeExistingSocket() {
  if (!state.ws) {
    return;
  }
  clearLiveWatchers();
  clearHostPolling();
  try {
    state.ws.onclose = null;
    state.ws.close();
  } catch {
    // ignore close errors
  }
  state.ws = null;
}

function handleSocketMessage(rawData) {
  let message;
  try {
    message = JSON.parse(rawData.data);
  } catch {
    return;
  }

  if (!message || typeof message !== "object") {
    return;
  }

  if (message.type === "hello") {
    const payload = message.payload || {};

    if (payload.server?.localHostId) {
      state.serverLocalHostId = normalizeHostId(payload.server.localHostId);
    }

    if (Array.isArray(payload.hosts)) {
      applyHostsPayload({
        localHostId: payload.server?.localHostId || state.serverLocalHostId,
        hosts: payload.hosts
      });
    }

    const incomingHostId = normalizeHostId(payload.host?.hostId);
    if (incomingHostId) {
      state.selectedHostId = incomingHostId;
      saveStoredString(STORAGE_KEYS.selectedHostId, incomingHostId);
      syncHostOptions();
    }

    state.alerts = [];
    state.seenEventIds.clear();
    state.seenEventOrder = [];
    state.alertFlags = {};

    if (payload.meta) {
      applyMeta(payload.meta);
    }
    if (payload.config) {
      applyConfig(payload.config);
    }

    if (Array.isArray(payload.history) && payload.history.length > 0) {
      replaceHistory(payload.history);
      state.historyLoadedMinutes = Math.min(state.rangeMinutes, 5);
    } else {
      resetHistory();
    }

    if (Array.isArray(payload.events) && payload.events.length > 0) {
      pushEvents(payload.events);
    }

    if (payload.latest) {
      const latestTs = numberOr(payload.latest.ts, 0);
      const historyLastTs = state.history.ts.length > 0 ? state.history.ts[state.history.ts.length - 1] : 0;
      applySample(payload.latest, {
        skipRender: true,
        recordHistory: latestTs > historyLastTs,
        skipEvents: true
      });
    }

    if (Array.isArray(payload.activeAlerts)) {
      state.alertFlags = flagsFromActiveAlerts(payload.activeAlerts);
    }

    updateSampleRateInteractivity();
    if (!state.frozen) {
      requestRender();
    }
    return;
  }

  if (message.type === "hosts") {
    applyHostsPayload(message.payload);
    updateSampleRateInteractivity();
    if (!state.frozen) {
      renderSystemFacts();
    }
    return;
  }

  if (message.type === "sample") {
    applySample(message.payload);
    return;
  }

  if (message.type === "events") {
    pushEvents(message.payload);
    if (!state.frozen) {
      requestRender();
    }
    return;
  }

  if (message.type === "config") {
    applyConfig(message.payload);
    updateSampleRateInteractivity();
    if (!state.frozen) {
      requestRender();
    }
    return;
  }

  if (message.type === "pong") {
    const clientTs = numberOr(message.payload?.clientTs, NaN);
    if (Number.isFinite(clientTs)) {
      state.wsLatencyMs = clamp(Date.now() - clientTs, 0, 5000);
      state.lastPongTs = Date.now();
      if (!state.frozen) {
        renderSystemFacts();
      }
    }
  }
}

function openSocket(baseUrl) {
  return new Promise((resolve) => {
    const socketUrl = buildWebSocketUrl(baseUrl);
    const socket = new WebSocket(socketUrl);
    let settled = false;

    const timeout = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      try {
        socket.close();
      } catch {
        // ignore close errors
      }
      resolve(false);
    }, 4500);

    socket.onopen = () => {
      clearTimeout(timeout);
      settled = true;
      closeExistingSocket();
      state.ws = socket;
      state.connected = true;
      state.usingMock = false;
      state.reconnectAttempt = 0;
      state.wsLatencyMs = null;
      setConnectionUi("live", `采样 ${formatSampleRateLabel(state.sampleRateMs)}`);
      stopMockLoop();
      startLiveWatchers();
      startHostPolling();
      sendSocketMessage({
        type: "setHost",
        payload: {
          hostId: selectedHostForQuery()
        }
      });
      sendSocketMessage({
        type: "getHosts"
      });
      sendSocketMessage({
        type: "setSampleRate",
        payload: {
          sampleRateMs: state.sampleRateMs
        }
      });
      sendSocketMessage({
        type: "ping",
        payload: {
          clientTs: Date.now()
        }
      });
      resolve(true);
    };

    socket.onmessage = handleSocketMessage;

    socket.onclose = () => {
      const wasConnected = state.connected;
      if (state.ws === socket) {
        state.ws = null;
      }
      clearLiveWatchers();
      clearHostPolling();
      state.connected = false;
      state.wsLatencyMs = null;

      if (wasConnected) {
        setConnectionUi("offline", "连接中断，自动重连中");
      }

      if (!state.usingMock) {
        startMockLoop("实时数据中断");
      }
      scheduleReconnect();
    };

    socket.onerror = () => {
      if (settled) {
        return;
      }
      clearTimeout(timeout);
      settled = true;
      resolve(false);
    };
  });
}

async function syncSampleRateToServer(sampleRateMs) {
  if (!isViewingLocalHost()) {
    return;
  }

  sendSocketMessage({
    type: "setSampleRate",
    payload: {
      sampleRateMs
    }
  });

  const baseUrl = getServerBaseUrl();
  await fetch(withHostQuery(`${baseUrl}/api/config`, state.serverLocalHostId || selectedHostForQuery()), {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ sampleRateMs })
  }).catch(() => {
    // socket通道可用时，这里失败不影响主流程
  });
}

async function connectToLiveSource() {
  if (state.connecting) {
    return;
  }
  state.connecting = true;
  clearReconnectTimer();
  setConnectionUi("connecting");

  const baseUrl = getServerBaseUrl();

  try {
    await fetchBootstrapData(baseUrl).catch(() => {
      // API预加载失败不阻断WS直连
    });

    const connected = await openSocket(baseUrl);
    if (connected) {
      refreshHostsFromServer().catch(() => {
        // ignore host refresh failures
      });
      if (state.historyLoadedMinutes < state.rangeMinutes) {
        reloadHistoryFromServer(state.rangeMinutes).catch(() => {
          // ignore history reload failures
        });
      }
      requestRender(true);
      return;
    }

    startMockLoop("采集服务不可达");
    scheduleReconnect();
  } finally {
    state.connecting = false;
  }
}

function shiftValue(value, change, min, max) {
  return clamp(value + randomBetween(-change, change), min, max);
}

function generateMockSample() {
  const current = state.metrics;

  const burstCpu = Math.random() < 0.08 ? randomBetween(10, 34) : 0;
  const burstGpu = Math.random() < 0.1 ? randomBetween(8, 24) : 0;
  const burstDisk = Math.random() < 0.12 ? randomBetween(45, 170) : 0;
  const burstNet = Math.random() < 0.1 ? randomBetween(4, 14) : 0;

  const nextCpu = clamp(shiftValue(current.cpu + burstCpu, 8.2, 4, 99), 1, 99);
  const nextCpuFreq = clamp(2.0 + (nextCpu / 100) * 2.3 + randomBetween(-0.14, 0.22), 1.4, 5.4);
  const nextMem = clamp(shiftValue(current.mem + nextCpu * 0.005, 1.2, 24, 96), 24, 96);
  const nextSwap = clamp(shiftValue(current.swap + (nextMem > 84 ? 0.32 : -0.2), 0.45, 0, 40), 0, 40);
  const nextGpu = clamp(shiftValue(current.gpu + burstGpu, 7.4, 1, 100), 1, 100);

  const targetVramTotal = state.vramTotalGb > 0 ? state.vramTotalGb : 12;
  const nextVram = clamp(shiftValue(current.vram + nextGpu * 0.005, 1.2, 8, 98), 8, 98);
  const nextDiskRead = clamp(shiftValue(current.diskRead + burstDisk, 35, 0, 480), 0, 480);
  const nextDiskWrite = clamp(shiftValue(current.diskWrite + burstDisk * 0.45, 24, 0, 320), 0, 320);
  const nextDiskLatency = clamp(2.4 + nextDiskWrite / 20 + randomBetween(-1.4, 3.8), 1.2, 48);
  const nextNetUp = clamp(shiftValue(current.netUp + burstNet * 0.4, 1.8, 0.1, 35), 0.1, 35);
  const nextNetDown = clamp(shiftValue(current.netDown + burstNet, 2.8, 0.1, 120), 0.1, 120);

  mockState.netConnections = Math.round(clamp(mockState.netConnections + randomBetween(-20, 24), 80, 1300));
  mockState.packetLoss = clamp(Math.random() < 0.08 ? randomBetween(0.7, 2.5) : randomBetween(0.0, 0.45), 0, 4.2);
  const nextTemp = clamp(34 + nextCpu * 0.27 + nextGpu * 0.23 + randomBetween(-1.6, 2.4), 35, 96);

  state.coreLoads = state.coreLoads.map((load, index) => {
    const base = nextCpu + (index % 3 === 0 ? randomBetween(4, 16) : randomBetween(-12, 10));
    const mixed = load * 0.35 + base * 0.65 + randomBetween(-5, 5);
    return clamp(mixed, 1, 100);
  });

  mockState.processes = mockState.processes
    .map((item, index) => {
      const cpuDelta = randomBetween(-1.1, 1.6) + (nextCpu / 100) * randomBetween(0.3, 2.4);
      const memDelta = randomBetween(-45, 55) + (nextCpu / 100) * randomBetween(8, 42);
      return {
        ...item,
        cpu: clamp(item.cpu + cpuDelta, 0.1, 36),
        memoryMb: clamp(item.memoryMb + memDelta + (index === 0 ? randomBetween(0, 20) : 0), 90, 3600)
      };
    })
    .sort((left, right) => right.memoryMb - left.memoryMb);

  const primaryRead = round(nextDiskRead * randomBetween(0.62, 0.9), 3);
  const secondaryRead = round(Math.max(0, nextDiskRead - primaryRead), 3);
  const primaryWrite = round(nextDiskWrite * randomBetween(0.55, 0.88), 3);
  const secondaryWrite = round(Math.max(0, nextDiskWrite - primaryWrite), 3);

  const diskVolumes = [
    {
      name: "C:",
      read: primaryRead,
      write: primaryWrite,
      total: round(primaryRead + primaryWrite, 3),
      latencyMs: round(nextDiskLatency * randomBetween(0.88, 1.15), 3),
      source: "mock"
    },
    {
      name: "D:",
      read: secondaryRead,
      write: secondaryWrite,
      total: round(secondaryRead + secondaryWrite, 3),
      latencyMs: round(nextDiskLatency * randomBetween(0.72, 1.28), 3),
      source: "mock"
    }
  ].filter((item) => item.total > 0.001);

  const timestamp = Date.now();

  const sample = {
    ts: timestamp,
    cpu: round(nextCpu, 1),
    cpuFreq: round(nextCpuFreq, 2),
    cpuCores: state.coreLoads.map((value) => round(value, 1)),
    mem: round(nextMem, 1),
    memUsedGb: round((state.memTotalGb * nextMem) / 100, 2),
    memTotalGb: state.memTotalGb,
    swap: round(nextSwap, 1),
    swapUsedGb: round(nextSwap / 100 * 8, 2),
    swapTotalGb: 8,
    gpu: round(nextGpu, 1),
    gpuName: state.meta.gpuModel || "Mock GPU",
    gpuTemp: round(nextTemp - randomBetween(4, 10), 1),
    vram: round(nextVram, 1),
    vramUsedGb: round((targetVramTotal * nextVram) / 100, 2),
    vramTotalGb: targetVramTotal,
    diskRead: round(nextDiskRead, 1),
    diskWrite: round(nextDiskWrite, 1),
    diskLatency: round(nextDiskLatency, 1),
    diskTelemetryAvailable: true,
    diskTelemetrySource: "mock",
    diskVolumes,
    diskLatencyEstimated: true,
    netUp: round(nextNetUp, 3),
    netDown: round(nextNetDown, 3),
    networkRateAvailable: true,
    networkIfaces: ["MockNet"],
    networkInterfaces: [{
      name: "MockNet",
      up: round(nextNetUp, 3),
      down: round(nextNetDown, 3),
      total: round(nextNetUp + nextNetDown, 3),
      rateAvailable: true,
      source: "mock"
    }],
    packetLoss: round(mockState.packetLoss, 2),
    netConnections: mockState.netConnections,
    temp: round(nextTemp, 1),
    processTop: mockState.processes.slice(0, 5).map((item) => ({
      name: item.name,
      cpu: round(item.cpu, 1),
      memoryMb: round(item.memoryMb, 0)
    }))
  };

  const transitions = evaluateAlertTransitions(sample, mockState.alertRegistry);
  sample.activeAlerts = transitions.activeAlerts;
  sample.events = transitions.events;

  return sample;
}

function updateClock() {
  dom.clock.textContent = formatClock(new Date());
  if (!state.frozen) {
    renderSystemFacts();
  }
}

function setTextColor(element, color) {
  element.style.color = color;
}

function levelColor(value, warnAt, dangerAt) {
  if (value >= dangerAt) {
    return cssVar("--danger");
  }
  if (value >= warnAt) {
    return cssVar("--warn");
  }
  return cssVar("--ok");
}

function renderKpis() {
  const sample = state.metrics;

  dom.cpuValue.textContent = `${sample.cpu.toFixed(0)}%`;
  dom.cpuSub.textContent = `频率 ${sample.cpuFreq.toFixed(2)} GHz`;

  dom.memValue.textContent = `${sample.mem.toFixed(0)}%`;
  dom.memSub.textContent = `${sample.memUsedGb.toFixed(1)} / ${sample.memTotalGb.toFixed(1)} GB`;

  dom.gpuValue.textContent = `${sample.gpu.toFixed(0)}%`;
  if (sample.vramTotalGb > 0) {
    dom.gpuSub.textContent = `显存 ${sample.vramUsedGb.toFixed(1)} / ${sample.vramTotalGb.toFixed(1)} GB`;
  } else {
    dom.gpuSub.textContent = "显存数据不可用";
  }

  if (sample.diskTelemetryAvailable) {
    const diskTotal = sample.diskRead + sample.diskWrite;
    const diskSourceLabel = sample.diskTelemetrySource === "windows-counter"
      ? "Windows计数器"
      : (sample.diskTelemetrySource === "mock" ? "模拟数据" : "系统采集");
    dom.diskValue.textContent = `${formatRateMb(diskTotal)} MB/s`;
    dom.diskSub.textContent = `延迟 ${sample.diskLatency.toFixed(1)} ms${sample.diskLatencyEstimated ? " (估算)" : ""} · ${diskSourceLabel}`;
  } else {
    dom.diskValue.textContent = "-- MB/s";
    dom.diskSub.textContent = "磁盘遥测不可用";
  }

  if (sample.networkRateAvailable) {
    dom.netValue.textContent = `↑ ${formatNetworkRate(sample.netUp)} / ↓ ${formatNetworkRate(sample.netDown)}`;
  } else {
    dom.netValue.textContent = "↑ -- / ↓ --";
  }
  const ifaceLabel = Array.isArray(sample.networkIfaces) && sample.networkIfaces.length > 0
    ? ` · ${sample.networkIfaces.join(", ")}`
    : "";
  dom.netSub.textContent = `连接数 ${sample.netConnections}${ifaceLabel}`;

  if (sample.temp > 0) {
    dom.tempValue.textContent = `${sample.temp.toFixed(0)} °C`;
  } else {
    dom.tempValue.textContent = "-- °C";
  }
  if (sample.temp <= 0) {
    dom.tempSub.textContent = "状态 不可用";
  } else if (sample.tempEstimated) {
    dom.tempSub.textContent = "状态 估算";
  } else if (sample.temp >= 82) {
    dom.tempSub.textContent = "状态 过热";
  } else if (sample.temp >= 70) {
    dom.tempSub.textContent = "状态 偏高";
  } else {
    dom.tempSub.textContent = "状态 正常";
  }

  setTextColor(dom.cpuValue, levelColor(sample.cpu, 75, 90));
  setTextColor(dom.memValue, levelColor(sample.mem, 78, 88));
  setTextColor(dom.gpuValue, levelColor(sample.gpu, 75, 90));
  setTextColor(dom.diskValue, sample.diskTelemetryAvailable ? levelColor(sample.diskLatency, 18, 28) : cssVar("--text-sub"));
  setTextColor(dom.netValue, sample.networkRateAvailable ? levelColor(sample.packetLoss, 0.8, 1.5) : cssVar("--text-sub"));
  setTextColor(dom.tempValue, sample.temp > 0 ? levelColor(sample.temp, 70, 82) : cssVar("--text-sub"));
}

function coreGradient(load) {
  const hue = Math.round(clamp(165 - load * 1.6, 0, 165));
  const hueShadow = Math.round(clamp(hue - 20, 0, 165));
  return `linear-gradient(120deg, hsl(${hue} 88% 40%), hsl(${hueShadow} 82% 28%))`;
}

function renderCores() {
  const html = state.coreLoads.map((load, index) => {
    return `<div class="core-cell" style="background:${coreGradient(load)}"><span>C${index + 1}</span><span>${load.toFixed(0)}%</span></div>`;
  }).join("");
  dom.coreHeatmap.innerHTML = html;
}

function renderProcessTable() {
  const rows = state.processes.slice(0, 5).map((item) => {
    return `<tr><td>${item.name}</td><td class="mono">${item.cpu.toFixed(1)}</td><td class="mono">${item.memoryMb.toFixed(0)}</td></tr>`;
  }).join("");
  dom.processRows.innerHTML = rows || `<tr><td colspan="3" class="empty-note">暂无进程数据</td></tr>`;
}

function renderDiskVolumeTable() {
  const rows = state.metrics.diskVolumes.slice(0, 8).map((volume) => {
    return `<tr><td>${volume.name}</td><td class="mono">${formatRateMb(volume.read)}</td><td class="mono">${formatRateMb(volume.write)}</td><td class="mono">${formatRateMb(volume.total)}</td></tr>`;
  }).join("");

  dom.diskVolumeRows.innerHTML = rows || `<tr><td colspan="4" class="empty-note">暂无分盘符速率数据</td></tr>`;
}

function renderNetworkInterfaceTable() {
  const rows = state.metrics.networkInterfaces.slice(0, 8).map((iface) => {
    return `<tr><td>${iface.name}</td><td class="mono">${formatNetworkRate(iface.up)}</td><td class="mono">${formatNetworkRate(iface.down)}</td><td class="mono">${formatNetworkRate(iface.total)}</td></tr>`;
  }).join("");

  dom.networkIfaceRows.innerHTML = rows || `<tr><td colspan="4" class="empty-note">暂无网卡速率数据</td></tr>`;
}

function renderAlerts() {
  if (state.alerts.length === 0) {
    dom.alertList.innerHTML = `<li class="empty-note">暂无异常，系统运行平稳。</li>`;
  } else {
    dom.alertList.innerHTML = state.alerts.slice(0, 16).map((item) => {
      const levelLabel = item.level === "danger" ? "危险" : item.level === "warn" ? "警告" : "恢复";
      const levelClass = item.level === "danger" ? "level-danger" : item.level === "warn" ? "level-warn" : "level-info";
      return `<li class="alert-item ${levelClass}"><span>${item.content}</span><span class="alert-level">${levelLabel}</span><span class="alert-time">${item.time}</span></li>`;
    }).join("");
  }

  const activeCount = Object.values(state.alertFlags).filter(Boolean).length;
  dom.alertBadge.textContent = `告警 ${activeCount}`;
  if (activeCount >= 1) {
    dom.alertBadge.style.color = cssVar("--danger");
    dom.alertBadge.style.borderColor = "rgba(248,113,113,.55)";
  } else {
    dom.alertBadge.style.color = cssVar("--text-sub");
    dom.alertBadge.style.borderColor = cssVar("--panel-border");
  }
}

function renderSystemFacts() {
  const sourceMode = state.connected ? "真机实时采集" : (state.usingMock ? "模拟数据" : "离线");
  const freshness = state.lastSampleArrivalTs > 0
    ? formatDurationMs(Date.now() - state.lastSampleArrivalTs)
    : "--";
  const latency = Number.isFinite(state.wsLatencyMs) ? `${Math.round(state.wsLatencyMs)} ms` : "--";
  const reconnectStatus = state.connected ? "稳定" : `重连次数 ${state.reconnectAttempt}`;
  let diskTelemetryStatus = "不可用";
  if (state.metrics.diskTelemetryAvailable) {
    if (state.metrics.diskTelemetrySource === "windows-counter") {
      diskTelemetryStatus = state.metrics.diskLatencyEstimated ? "Windows计数器(估算延迟)" : "Windows计数器";
    } else if (state.metrics.diskTelemetrySource === "mock") {
      diskTelemetryStatus = "模拟数据";
    } else {
      diskTelemetryStatus = state.metrics.diskLatencyEstimated ? "系统采集(估算延迟)" : "系统采集";
    }
  }
  const temperatureStatus = state.metrics.temp > 0
    ? (state.metrics.tempEstimated ? "估算" : "传感器")
    : "不可用";
  const networkRateStatus = state.metrics.networkRateAvailable ? "可用" : "不可用";
  const networkIfacesText = Array.isArray(state.metrics.networkIfaces) && state.metrics.networkIfaces.length > 0
    ? state.metrics.networkIfaces.join(", ")
    : "未知";
  const selectedHostId = normalizeHostId(state.selectedHostId) || normalizeHostId(state.serverLocalHostId) || "unknown";
  const selectedHost = state.hosts.find((host) => host.hostId === selectedHostId);
  const selectedHostSource = selectedHost ? hostSourceLabel(selectedHost.source) : (isViewingLocalHost() ? "本机" : "unknown");
  const selectedHostStatus = selectedHost ? (selectedHost.online ? "在线" : "离线") : "未知";
  const selectedHostAlerts = selectedHost ? `${selectedHost.activeAlertCount}` : "--";

  const facts = [
    ["主机 ID", selectedHostId],
    ["主机来源", selectedHostSource],
    ["主机在线", selectedHostStatus],
    ["主机告警", selectedHostAlerts],
    ["操作系统", state.meta.os || "Unknown"],
    ["CPU 型号", state.meta.cpuModel || "Unknown"],
    ["核心数量", `${state.meta.physicalCores || "-"}P / ${state.meta.logicalCores || state.coreLoads.length}L`],
    ["总内存", `${state.memTotalGb.toFixed(1)} GB`],
    ["GPU", state.metrics.gpuName || state.meta.gpuModel || "N/A"],
    ["采样频率", formatSampleRateLabel(state.sampleRateMs)],
    ["当前模式", sourceMode],
    ["磁盘遥测", diskTelemetryStatus],
    ["分盘符数量", `${state.metrics.diskVolumes.length}`],
    ["网络速率", networkRateStatus],
    ["网络网卡", networkIfacesText],
    ["选中网卡", state.selectedNetworkIface === "__ALL__" ? "全部网卡" : state.selectedNetworkIface],
    ["温度来源", temperatureStatus],
    ["数据新鲜度", freshness],
    ["WebSocket 延迟", latency],
    ["连接状态", reconnectStatus]
  ];

  dom.systemFacts.innerHTML = facts.map(([label, value]) => {
    return `<div><dt>${label}</dt><dd>${value}</dd></div>`;
  }).join("");
}

function buildAxes(axisMax = 100) {
  return {
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: state.history.labels,
      axisLabel: {
        color: cssVar("--text-sub"),
        fontFamily: "JetBrains Mono",
        fontSize: 10,
        margin: 10
      },
      axisLine: {
        lineStyle: {
          color: cssVar("--panel-border")
        }
      },
      axisTick: {
        show: false
      }
    },
    yAxis: {
      type: "value",
      min: 0,
      max: axisMax,
      axisLabel: {
        color: cssVar("--text-sub"),
        fontFamily: "JetBrains Mono"
      },
      splitLine: {
        lineStyle: {
          color: "rgba(100,116,139,0.18)"
        }
      }
    }
  };
}

function renderCpuChart() {
  const axes = buildAxes();
  charts.cpu.setOption({
    animation: false,
    grid: { left: 40, right: 44, top: 24, bottom: 24 },
    legend: {
      top: 0,
      textStyle: { color: cssVar("--text-sub"), fontSize: 11 },
      itemWidth: 10,
      itemHeight: 10
    },
    tooltip: { trigger: "axis" },
    xAxis: axes.xAxis,
    yAxis: [
      axes.yAxis,
      {
        type: "value",
        min: 1,
        max: 5.5,
        axisLabel: { color: cssVar("--text-sub"), fontFamily: "JetBrains Mono" },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: "CPU%",
        type: "line",
        smooth: 0.3,
        symbol: "none",
        lineStyle: { width: 2.2, color: cssVar("--line-a") },
        areaStyle: { color: "rgba(14,165,233,.14)" },
        data: state.history.cpu
      },
      {
        name: "GHz",
        type: "line",
        yAxisIndex: 1,
        smooth: 0.36,
        symbol: "none",
        lineStyle: { width: 1.8, color: cssVar("--line-b") },
        data: state.history.cpuFreq
      }
    ]
  }, true);
}

function renderMemoryChart() {
  const axes = buildAxes();
  charts.memory.setOption({
    animation: false,
    grid: { left: 40, right: 16, top: 20, bottom: 24 },
    tooltip: { trigger: "axis" },
    xAxis: axes.xAxis,
    yAxis: axes.yAxis,
    series: [
      {
        name: "RAM%",
        type: "line",
        smooth: 0.32,
        symbol: "none",
        lineStyle: { width: 2.2, color: cssVar("--line-c") },
        areaStyle: { color: "rgba(34,211,238,.13)" },
        data: state.history.mem
      },
      {
        name: "Swap%",
        type: "line",
        smooth: 0.3,
        symbol: "none",
        lineStyle: { width: 1.6, color: cssVar("--line-b") },
        data: state.history.swap
      }
    ]
  }, true);
}

function renderGpuChart() {
  const axes = buildAxes();
  charts.gpu.setOption({
    animation: false,
    grid: { left: 40, right: 16, top: 20, bottom: 24 },
    tooltip: { trigger: "axis" },
    xAxis: axes.xAxis,
    yAxis: axes.yAxis,
    series: [
      {
        name: "GPU%",
        type: "line",
        smooth: 0.35,
        symbol: "none",
        lineStyle: { width: 2.1, color: cssVar("--line-a") },
        data: state.history.gpu
      },
      {
        name: "VRAM%",
        type: "line",
        smooth: 0.35,
        symbol: "none",
        lineStyle: { width: 1.8, color: cssVar("--line-b") },
        data: state.history.vram
      }
    ]
  }, true);
}

function renderDiskChart() {
  const axes = buildAxes(500);
  const noData = !state.metrics.diskTelemetryAvailable;
  charts.disk.setOption({
    animation: false,
    title: noData
      ? {
        text: "磁盘速率遥测不可用",
        left: "center",
        top: "middle",
        textStyle: {
          color: cssVar("--text-sub"),
          fontSize: 12,
          fontWeight: 500
        }
      }
      : { text: "" },
    grid: { left: 42, right: 42, top: 22, bottom: 24 },
    legend: {
      top: 0,
      textStyle: { color: cssVar("--text-sub"), fontSize: 11 },
      itemWidth: 10,
      itemHeight: 10
    },
    tooltip: { trigger: "axis" },
    xAxis: axes.xAxis,
    yAxis: [
      axes.yAxis,
      {
        type: "value",
        min: 0,
        max: 80,
        axisLabel: { color: cssVar("--text-sub"), fontFamily: "JetBrains Mono" },
        splitLine: { show: false }
      }
    ],
    series: [
      {
        name: "Read",
        type: "line",
        smooth: 0.28,
        symbol: "none",
        lineStyle: { width: 2, color: cssVar("--line-a") },
        data: noData ? [] : state.history.diskRead
      },
      {
        name: "Write",
        type: "line",
        smooth: 0.28,
        symbol: "none",
        lineStyle: { width: 2, color: cssVar("--line-c") },
        data: noData ? [] : state.history.diskWrite
      },
      {
        name: "Latency",
        type: "line",
        yAxisIndex: 1,
        smooth: 0.32,
        symbol: "none",
        lineStyle: { width: 1.8, color: cssVar("--line-b") },
        data: noData ? [] : state.history.diskLatency
      }
    ]
  }, true);
}

function renderDiskVolumeChart() {
  const selectedVolumes = state.metrics.diskVolumes.slice(0, 4);
  const labels = state.history.labels;

  if (selectedVolumes.length === 0) {
    charts.diskVolume.setOption({
      animation: false,
      title: {
        text: "暂无分盘符曲线数据",
        left: "center",
        top: "middle",
        textStyle: {
          color: cssVar("--text-sub"),
          fontSize: 12,
          fontWeight: 500
        }
      },
      xAxis: { show: false },
      yAxis: { show: false },
      series: []
    }, true);
    return;
  }

  const colorPool = [
    cssVar("--line-a"),
    cssVar("--line-c"),
    cssVar("--line-b"),
    cssVar("--ok"),
    "#16a34a",
    "#0ea5e9"
  ];

  const series = selectedVolumes.map((volume, index) => {
    const values = state.diskVolumeHistory[volume.name] || [];
    return {
      name: volume.name,
      type: "line",
      smooth: 0.28,
      symbol: "none",
      lineStyle: {
        width: 1.8,
        color: colorPool[index % colorPool.length]
      },
      data: values
    };
  });

  charts.diskVolume.setOption({
    animation: false,
    title: { text: "" },
    grid: { left: 42, right: 18, top: 20, bottom: 22 },
    legend: {
      top: 0,
      textStyle: { color: cssVar("--text-sub"), fontSize: 11 },
      itemWidth: 10,
      itemHeight: 10
    },
    tooltip: { trigger: "axis" },
    xAxis: {
      type: "category",
      boundaryGap: false,
      data: labels,
      axisLabel: {
        color: cssVar("--text-sub"),
        fontFamily: "JetBrains Mono",
        fontSize: 10,
        margin: 10
      },
      axisLine: {
        lineStyle: {
          color: cssVar("--panel-border")
        }
      },
      axisTick: {
        show: false
      }
    },
    yAxis: {
      type: "value",
      min: 0,
      axisLabel: {
        color: cssVar("--text-sub"),
        fontFamily: "JetBrains Mono"
      },
      splitLine: {
        lineStyle: {
          color: "rgba(100,116,139,0.18)"
        }
      }
    },
    series
  }, true);
}

function renderNetworkChart() {
  const selectedIface = state.selectedNetworkIface;
  let upSeries = state.history.netUp;
  let downSeries = state.history.netDown;
  let lossSeries = state.history.packetLoss;
  const showLoss = selectedIface === "__ALL__";

  if (selectedIface !== "__ALL__") {
    const ifaceSeries = state.networkIfaceHistory[selectedIface];
    upSeries = ifaceSeries?.up || [];
    downSeries = ifaceSeries?.down || [];
    lossSeries = [];
  }

  const finiteUp = upSeries.filter((value) => Number.isFinite(value));
  const finiteDown = downSeries.filter((value) => Number.isFinite(value));
  const hasRateData = finiteUp.length > 0 || finiteDown.length > 0;

  const peakRate = Math.max(
    ...finiteUp,
    ...finiteDown,
    0
  );
  const dynamicMax = peakRate > 0
    ? Math.max(1, Math.ceil(peakRate * 1.35 * 10) / 10)
    : 1;

  const axes = buildAxes(dynamicMax);
  const noRateData = !hasRateData;
  const titleText = noRateData
    ? "网络速率数据不可用"
    : (selectedIface === "__ALL__" ? "" : `网卡 ${selectedIface}`);

  const series = [
    {
      name: "Down",
      type: "line",
      smooth: 0.3,
      symbol: "none",
      lineStyle: { width: 2.2, color: cssVar("--line-a") },
      areaStyle: { color: "rgba(2,132,199,0.15)" },
      data: noRateData ? [] : downSeries
    },
    {
      name: "Up",
      type: "line",
      smooth: 0.3,
      symbol: "none",
      lineStyle: { width: 1.9, color: cssVar("--line-c") },
      data: noRateData ? [] : upSeries
    }
  ];

  if (showLoss) {
    series.push({
      name: "Loss%",
      type: "line",
      yAxisIndex: 1,
      smooth: 0.25,
      symbol: "none",
      lineStyle: { width: 1.6, color: cssVar("--line-b") },
      data: noRateData ? [] : lossSeries
    });
  }

  const yAxes = [axes.yAxis];
  if (showLoss) {
    yAxes.push({
      type: "value",
      min: 0,
      max: 4,
      axisLabel: { color: cssVar("--text-sub"), fontFamily: "JetBrains Mono" },
      splitLine: { show: false }
    });
  }

  charts.network.setOption({
    animation: false,
    title: titleText
      ? {
        text: titleText,
        left: "center",
        top: noRateData ? "middle" : 2,
        textStyle: {
          color: cssVar("--text-sub"),
          fontSize: 12,
          fontWeight: 500
        }
      }
      : { text: "" },
    grid: { left: 42, right: 42, top: 22, bottom: 24 },
    legend: {
      top: 0,
      textStyle: { color: cssVar("--text-sub"), fontSize: 11 },
      itemWidth: 10,
      itemHeight: 10
    },
    tooltip: {
      trigger: "axis",
      formatter: (params) => {
        if (!Array.isArray(params) || params.length === 0) {
          return "";
        }
        const lines = [String(params[0].axisValueLabel || "")];
        for (const item of params) {
          const value = Number(item.value);
          const marker = item.marker || "";
          if (!Number.isFinite(value)) {
            lines.push(`${marker}${item.seriesName}: --`);
            continue;
          }
          if (item.seriesName === "Loss%") {
            lines.push(`${marker}${item.seriesName}: ${value.toFixed(2)}%`);
          } else {
            lines.push(`${marker}${item.seriesName}: ${formatNetworkRate(value)}`);
          }
        }
        return lines.join("<br/>");
      }
    },
    xAxis: axes.xAxis,
    yAxis: yAxes,
    series
  }, true);
}

function renderCharts() {
  renderCpuChart();
  renderMemoryChart();
  renderGpuChart();
  renderDiskChart();
  renderDiskVolumeChart();
  renderNetworkChart();
}

function renderAll() {
  renderKpis();
  renderCores();
  renderDiskVolumeTable();
  renderNetworkInterfaceTable();
  renderProcessTable();
  renderAlerts();
  renderSystemFacts();
  renderCharts();
}

function requestRender(force = false) {
  if (state.frozen && !force) {
    return;
  }

  if (force) {
    renderQueued = false;
    renderAll();
    return;
  }

  if (renderQueued) {
    return;
  }

  renderQueued = true;
  window.requestAnimationFrame(() => {
    renderQueued = false;
    if (!state.frozen) {
      renderAll();
    }
  });
}

function makeCsvTextFromHistory() {
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
    "netUp",
    "netDown",
    "packetLoss",
    "temp"
  ];

  const lines = [headers.join(",")];
  for (let index = 0; index < state.history.ts.length; index += 1) {
    const row = [
      new Date(state.history.ts[index]).toISOString(),
      state.history.cpu[index],
      state.history.cpuFreq[index],
      state.history.mem[index],
      state.history.swap[index],
      state.history.gpu[index],
      state.history.vram[index],
      state.history.diskRead[index],
      state.history.diskWrite[index],
      state.history.diskLatency[index],
      state.history.netUp[index],
      state.history.netDown[index],
      state.history.packetLoss[index],
      state.history.temp[index]
    ];
    lines.push(row.join(","));
  }

  return `\uFEFF${lines.join("\n")}`;
}

function exportLocalCsv() {
  const csvContent = makeCsvTextFromHistory();
  const blob = new Blob([csvContent], { type: "text/csv;charset=utf-8;" });
  const blobUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = blobUrl;
  link.download = `pulseforge-local-${Date.now()}.csv`;
  link.click();
  URL.revokeObjectURL(blobUrl);
}

function handleSampleRateChange() {
  if (!isViewingLocalHost()) {
    dom.sampleRate.value = String(state.sampleRateMs);
    return;
  }

  state.sampleRateMs = Math.max(250, Number(dom.sampleRate.value));
  saveStoredNumber(STORAGE_KEYS.sampleRate, state.sampleRateMs);
  trimHistoryStore();

  if (state.connected) {
    syncSampleRateToServer(state.sampleRateMs);
  }

  if (state.usingMock) {
    restartMockLoop();
  }

  requestRender();
}

function handleRangeChange() {
  state.rangeMinutes = Number(dom.timeRange.value);
  saveStoredNumber(STORAGE_KEYS.rangeMinutes, state.rangeMinutes);

  if (state.connected) {
    reloadHistoryFromServer(state.rangeMinutes)
      .then(() => {
        requestRender(true);
      })
      .catch(() => {
        trimHistoryStore();
        requestRender();
      });
    return;
  }

  trimHistoryStore();
  requestRender();
}

function handleThemeToggle() {
  state.theme = state.theme === "light" ? "dark" : "light";
  document.documentElement.dataset.theme = state.theme;
  saveStoredString(STORAGE_KEYS.theme, state.theme);
  dom.themeToggle.textContent = state.theme === "dark" ? "浅色模式" : "夜间模式";
  requestRender(true);
}

function handleFreezeToggle() {
  state.frozen = !state.frozen;
  dom.freezeToggle.textContent = state.frozen ? "继续更新" : "冻结画面";
  if (state.frozen) {
    dom.freezeToggle.style.background = "linear-gradient(120deg,#0f172a,#334155)";
  } else {
    dom.freezeToggle.style.background = "linear-gradient(120deg,var(--line-a),var(--line-c))";
    requestRender(true);
  }
}

function handleExportCsv() {
  if (state.connected) {
    const baseUrl = getServerBaseUrl();
    const exportUrl = withHostQuery(`${baseUrl}/api/export.csv?minutes=${state.rangeMinutes}`, selectedHostForQuery());
    const link = document.createElement("a");
    link.href = exportUrl;
    link.target = "_blank";
    link.rel = "noopener";
    link.click();
    return;
  }

  exportLocalCsv();
}

function handleReconnectClick() {
  clearReconnectTimer();
  closeExistingSocket();
  setConnectionUi("connecting");
  connectToLiveSource();
}

async function refreshHostsFromServer() {
  if (!state.connected) {
    return;
  }

  const baseUrl = getServerBaseUrl();
  const payload = await fetchJson(`${baseUrl}/api/hosts`).catch(() => null);
  if (!payload) {
    return;
  }
  applyHostsPayload(payload);
}

function clearHostPolling() {
  if (hostPollTimer) {
    clearInterval(hostPollTimer);
    hostPollTimer = null;
  }
}

function startHostPolling() {
  clearHostPolling();
  hostPollTimer = setInterval(() => {
    refreshHostsFromServer().catch(() => {
      // ignore host polling errors
    });
  }, 5000);
}

function resetHostScopedViewState() {
  resetHistory();
  state.alerts = [];
  state.alertFlags = {};
  state.seenEventIds.clear();
  state.seenEventOrder = [];
  state.selectedNetworkIface = "__ALL__";
  dom.networkIfaceSelect.value = "__ALL__";
}

function handleHostChange() {
  const nextHostId = normalizeHostId(dom.hostSelect?.value || "");
  if (!nextHostId || nextHostId === normalizeHostId(state.selectedHostId)) {
    return;
  }

  state.selectedHostId = nextHostId;
  saveStoredString(STORAGE_KEYS.selectedHostId, nextHostId);
  resetHostScopedViewState();
  updateSampleRateInteractivity();

  if (state.connected) {
    sendSocketMessage({
      type: "setHost",
      payload: {
        hostId: nextHostId
      }
    });

    const baseUrl = getServerBaseUrl();
    fetchBootstrapData(baseUrl)
      .then(() => {
        if (state.historyLoadedMinutes < state.rangeMinutes) {
          return reloadHistoryFromServer(state.rangeMinutes);
        }
        return null;
      })
      .then(() => {
        requestRender(true);
      })
      .catch(() => {
        requestRender(true);
      });
    return;
  }

  requestRender(true);
}

function handleNetworkIfaceChange() {
  const value = String(dom.networkIfaceSelect.value || "__ALL__");
  state.selectedNetworkIface = value;
  requestRender();
}

function bindEvents() {
  if (dom.hostSelect) {
    dom.hostSelect.addEventListener("change", handleHostChange);
  }
  dom.sampleRate.addEventListener("change", handleSampleRateChange);
  dom.timeRange.addEventListener("change", handleRangeChange);
  dom.themeToggle.addEventListener("click", handleThemeToggle);
  dom.freezeToggle.addEventListener("click", handleFreezeToggle);
  dom.exportCsvBtn.addEventListener("click", handleExportCsv);
  dom.reconnectBtn.addEventListener("click", handleReconnectClick);
  dom.networkIfaceSelect.addEventListener("change", handleNetworkIfaceChange);

  window.addEventListener("resize", () => {
    for (const chart of Object.values(charts)) {
      chart.resize();
    }
  });
}

function initializeTheme() {
  document.documentElement.dataset.theme = state.theme;
  dom.themeToggle.textContent = state.theme === "dark" ? "浅色模式" : "夜间模式";
}

function startClockLoop() {
  updateClock();
  if (clockTimer) {
    clearInterval(clockTimer);
  }
  clockTimer = setInterval(updateClock, 1000);
}

function initializeBaseView() {
  initializeTheme();
  dom.sampleRate.value = String(state.sampleRateMs);
  dom.timeRange.value = String(state.rangeMinutes);
  state.historyLoadedMinutes = state.rangeMinutes;

  if (state.hosts.length === 0) {
    const bootstrapHostId = normalizeHostId(state.selectedHostId) || "local";
    state.hosts = [{
      hostId: bootstrapHostId,
      hostName: "当前主机",
      source: "unknown",
      online: false,
      lastSeenTs: 0,
      activeAlertCount: 0
    }];
  }
  syncHostOptions();

  dom.hostName.textContent = String(state.meta.hostName || "HOST-LOCAL").toUpperCase();
  dom.systemInfo.textContent = `${state.meta.os} · ${state.meta.logicalCores} Core · ${state.memTotalGb}GB RAM`;
  setConnectionUi("connecting");
  updateSampleRateInteractivity();

  warmupMockHistory(24);
  requestRender(true);
}

function initialize() {
  bindEvents();
  startClockLoop();
  initializeBaseView();
  connectToLiveSource();
}

initialize();
