"use strict";

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function round(value, digits = 2) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return 0;
  }
  return Number(parsed.toFixed(digits));
}

function safeText(value, maxLength = 600) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .slice(0, maxLength);
}

function pickTopSignals(historyPoints = []) {
  if (!Array.isArray(historyPoints) || historyPoints.length === 0) {
    return [];
  }

  const scores = historyPoints.map((sample) => {
    const cpu = Number(sample?.cpu || 0);
    const mem = Number(sample?.mem || 0);
    const temp = Number(sample?.temp || 0);
    const diskLatency = Number(sample?.diskLatency || 0);
    const packetLoss = Number(sample?.packetLoss || 0);
    const score = cpu * 0.3 + mem * 0.2 + temp * 0.2 + diskLatency * 0.8 + packetLoss * 3;
    return {
      ts: Number(sample?.ts || 0),
      cpu: round(cpu, 1),
      mem: round(mem, 1),
      temp: round(temp, 1),
      diskLatency: round(diskLatency, 2),
      packetLoss: round(packetLoss, 2),
      score
    };
  });

  return scores
    .sort((left, right) => right.score - left.score)
    .slice(0, 6)
    .sort((left, right) => left.ts - right.ts);
}

function heuristicDiagnosis({ event, sample, history }) {
  const key = String(event?.key || "unknown");
  const level = String(event?.level || "info");
  const content = safeText(event?.content || "");
  const latest = sample || {};
  const topSignals = pickTopSignals(history);

  let category = "unknown";
  let summary = "告警出现，但暂时无法确定单一根因。";
  let confidence = 0.45;
  const immediate = [];
  const next24h = [];
  const prevention = [];

  if (key.includes("cpu") || content.includes("CPU")) {
    category = "capacity";
    summary = "CPU 峰值过高导致计算拥塞，可能由进程突发负载或并发任务叠加触发。";
    confidence = clamp(0.58 + Number(latest.cpu || 0) / 200, 0.45, 0.9);
    immediate.push("检查进程 Top5，定位瞬时占用最高进程并确认是否可限流");
    immediate.push("将采样周期临时调高到 2000ms，观察是否持续高负载");
    next24h.push("为高 CPU 任务增加并发上限与超时控制");
    prevention.push("建立 CPU 持续高于阈值的分级告警（短峰值与持续峰值分离）");
  } else if (key.includes("mem") || content.includes("内存")) {
    category = "capacity";
    summary = "内存占用持续走高，可能存在缓存积压或对象释放不及时。";
    confidence = clamp(0.56 + Number(latest.mem || 0) / 220, 0.45, 0.9);
    immediate.push("检查是否有异常增长的缓存/队列长度");
    immediate.push("确认进程 RSS 与对象生命周期是否匹配");
    next24h.push("补充内存分层指标（heap/rss/cache）以定位增长来源");
    prevention.push("为关键缓存引入容量上限与淘汰策略");
  } else if (key.includes("temp") || content.includes("温度")) {
    category = "capacity";
    summary = "温度告警通常由高计算负载叠加散热条件触发。";
    confidence = clamp(0.5 + Number(latest.temp || 0) / 220, 0.4, 0.88);
    immediate.push("检查同时间段 CPU/GPU 负载是否持续偏高");
    immediate.push("确认采集温度是否为估算值，必要时校验传感器可用性");
    next24h.push("将温度告警和负载指标做关联展示");
    prevention.push("建立高温持续时的降载策略和告警升级策略");
  } else if (key.includes("disk") || content.includes("磁盘")) {
    category = "dependency";
    summary = "磁盘延迟上升通常由 I/O 队列拥塞、随机读写激增或系统后台任务触发。";
    confidence = clamp(0.55 + Number(latest.diskLatency || 0) / 80, 0.42, 0.9);
    immediate.push("检查分盘符吞吐与延迟，确认是否单盘成为瓶颈");
    immediate.push("排查同时间段大文件写入/杀毒/索引任务");
    next24h.push("对高频 I/O 写路径做批量化与节流");
    prevention.push("建立盘符级别 SLO 和基线偏移告警");
  } else if (key.includes("loss") || content.includes("丢包")) {
    category = "dependency";
    summary = "网络丢包上升通常由链路抖动、网卡拥塞或上游网络质量波动导致。";
    confidence = clamp(0.54 + Number(latest.packetLoss || 0) / 25, 0.4, 0.88);
    immediate.push("确认当前网卡上下行与丢包是否同时升高");
    immediate.push("排查局域网出口或 VPN 链路状态");
    next24h.push("增加接口级丢包趋势与异常时段定位");
    prevention.push("引入网络质量探针并做链路质量分级告警");
  }

  if (immediate.length === 0) {
    immediate.push("检查事件前后 10 分钟内 CPU/内存/磁盘/网络趋势拐点");
    next24h.push("补充更细粒度上下文指标用于下次归因");
    prevention.push("按告警类型建立标准化排障手册");
  }

  return {
    status: "fallback",
    model: "local-heuristic",
    cause: {
      summary,
      category,
      affectedComponent: safeText(event?.key || event?.type || "unknown", 120),
      confidence: round(confidence, 2)
    },
    evidence: topSignals.map((signal) => ({
      signalTs: signal.ts,
      cpu: signal.cpu,
      mem: signal.mem,
      temp: signal.temp,
      diskLatency: signal.diskLatency,
      packetLoss: signal.packetLoss,
      reason: "高风险样本点"
    })),
    remediation: {
      immediate,
      next24h,
      prevention
    },
    meta: {
      eventLevel: level,
      fallbackReason: "missing_or_disabled_ai_provider"
    }
  };
}

class IncidentAiAnalyzer {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.apiKey = String(options.apiKey || "").trim();
    this.baseUrl = String(options.baseUrl || "https://api.openai.com/v1").replace(/\/$/, "");
    this.model = String(options.model || "gpt-4o-mini");
    this.timeoutMs = Math.max(1000, Number(options.timeoutMs || 8000));
    this.maxInputChars = Math.max(3000, Number(options.maxInputChars || 12000));
    this.providerConfigured = this.enabled && this.apiKey.length > 0;
  }

  buildMessages({ hostSnapshot, event, sample, history }) {
    const compactHistory = pickTopSignals(history);
    const payload = {
      host: {
        id: hostSnapshot?.hostId,
        name: hostSnapshot?.hostName,
        source: hostSnapshot?.source
      },
      event: {
        id: event?.id,
        key: event?.key,
        level: event?.level,
        type: event?.type,
        content: safeText(event?.content, 400),
        ts: Number(event?.ts || 0),
        time: event?.time
      },
      sample: sample
        ? {
          ts: Number(sample.ts || 0),
          cpu: round(sample.cpu, 1),
          mem: round(sample.mem, 1),
          temp: round(sample.temp, 1),
          diskLatency: round(sample.diskLatency, 2),
          packetLoss: round(sample.packetLoss, 2),
          netUp: round(sample.netUp, 3),
          netDown: round(sample.netDown, 3)
        }
        : null,
      history: compactHistory
    };

    const jsonPayload = JSON.stringify(payload).slice(0, this.maxInputChars);

    return [
      {
        role: "system",
        content: [
          "你是系统监控事件根因分析助手。",
          "仅基于用户提供的指标和事件进行判断，不得虚构外部信息。",
          "如果证据不足，必须降低置信度并明确说明。",
          "输出必须是 JSON，字段：status,cause,evidence,remediation,meta。"
        ].join("\n")
      },
      {
        role: "user",
        content: `请分析以下监控事件并给出根因、证据和修复建议：\n${jsonPayload}`
      }
    ];
  }

  parseModelJson(text) {
    const rawText = String(text || "").trim();
    if (!rawText) {
      return null;
    }

    try {
      return JSON.parse(rawText);
    } catch {
      const match = rawText.match(/\{[\s\S]*\}/);
      if (!match) {
        return null;
      }
      try {
        return JSON.parse(match[0]);
      } catch {
        return null;
      }
    }
  }

  async callProvider(payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    const startedAt = Date.now();

    try {
      const response = await fetch(`${this.baseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        return {
          ok: false,
          error: `HTTP ${response.status} ${text}`.trim(),
          latencyMs: Date.now() - startedAt
        };
      }

      const body = await response.json().catch(() => null);
      const content = body?.choices?.[0]?.message?.content || "";
      return {
        ok: true,
        content,
        usage: body?.usage || null,
        latencyMs: Date.now() - startedAt
      };
    } catch (error) {
      return {
        ok: false,
        error: String(error.message || error),
        latencyMs: Date.now() - startedAt
      };
    } finally {
      clearTimeout(timer);
    }
  }

  normalizeResult(result, fallbackReason) {
    const cause = result?.cause || {};
    const remediation = result?.remediation || {};
    const evidence = Array.isArray(result?.evidence) ? result.evidence : [];

    return {
      status: String(result?.status || (fallbackReason ? "fallback" : "ok")),
      model: this.model,
      cause: {
        summary: safeText(cause.summary || "未提供根因摘要", 280),
        category: safeText(cause.category || "unknown", 64),
        affectedComponent: safeText(cause.affectedComponent || "unknown", 120),
        confidence: clamp(Number(cause.confidence || 0.45), 0, 1)
      },
      evidence: evidence.slice(0, 8).map((item) => ({
        reason: safeText(item?.reason || "证据项", 240),
        signalTs: Number(item?.signalTs || 0) || null,
        strength: clamp(Number(item?.strength || 0.5), 0, 1)
      })),
      remediation: {
        immediate: Array.isArray(remediation.immediate) ? remediation.immediate.slice(0, 6).map((item) => safeText(item, 180)) : [],
        next24h: Array.isArray(remediation.next24h) ? remediation.next24h.slice(0, 6).map((item) => safeText(item, 180)) : [],
        prevention: Array.isArray(remediation.prevention) ? remediation.prevention.slice(0, 6).map((item) => safeText(item, 180)) : []
      },
      meta: {
        ...(result?.meta && typeof result.meta === "object" ? result.meta : {}),
        fallbackReason: fallbackReason || null
      }
    };
  }

  async analyzeIncident({ hostSnapshot, event, sample, history }) {
    const fallback = heuristicDiagnosis({
      event,
      sample,
      history
    });

    if (!this.enabled || !this.providerConfigured) {
      return fallback;
    }

    const messages = this.buildMessages({
      hostSnapshot,
      event,
      sample,
      history
    });

    const providerResult = await this.callProvider({
      model: this.model,
      messages,
      temperature: 0.2,
      response_format: {
        type: "json_object"
      },
      max_tokens: 900
    });

    if (!providerResult.ok) {
      return {
        ...fallback,
        model: this.model,
        meta: {
          ...fallback.meta,
          fallbackReason: providerResult.error,
          latencyMs: providerResult.latencyMs
        }
      };
    }

    const parsed = this.parseModelJson(providerResult.content);
    if (!parsed) {
      return {
        ...fallback,
        model: this.model,
        meta: {
          ...fallback.meta,
          fallbackReason: "provider_returned_non_json",
          latencyMs: providerResult.latencyMs
        }
      };
    }

    const normalized = this.normalizeResult(parsed, null);
    normalized.model = this.model;
    normalized.meta = {
      ...normalized.meta,
      latencyMs: providerResult.latencyMs,
      usage: providerResult.usage || null
    };
    return normalized;
  }
}

module.exports = {
  IncidentAiAnalyzer
};
