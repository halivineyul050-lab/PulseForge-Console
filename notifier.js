"use strict";

const crypto = require("crypto");

function numberOr(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function trimUrl(url) {
  const value = String(url || "").trim();
  return value.length > 0 ? value : null;
}

function classifyLevel(level) {
  const normalized = String(level || "info").toLowerCase();
  if (normalized === "danger" || normalized === "error") {
    return "danger";
  }
  if (normalized === "warn" || normalized === "warning") {
    return "warn";
  }
  return "info";
}

function levelEmoji(level) {
  if (level === "danger") {
    return "🔴";
  }
  if (level === "warn") {
    return "🟠";
  }
  return "🟢";
}

function toHostMarkdown(hostSnapshot) {
  return `${hostSnapshot.hostName} (${hostSnapshot.hostId})`;
}

function arrayHead(items, size = 2) {
  if (!Array.isArray(items)) {
    return [];
  }
  return items.slice(0, size).map((item) => String(item || "").trim()).filter(Boolean);
}

function readAiSummary(analysisRecord) {
  if (!analysisRecord || typeof analysisRecord !== "object") {
    return null;
  }

  const status = String(analysisRecord.status || analysisRecord.analysis?.status || "unknown");
  const model = String(analysisRecord.model || analysisRecord.analysis?.model || "unknown");
  const cause = analysisRecord.analysis?.cause || {};
  const remediation = analysisRecord.analysis?.remediation || {};

  return {
    status,
    model,
    summary: String(cause.summary || "").trim(),
    category: String(cause.category || "unknown").trim(),
    confidence: Number.isFinite(Number(cause.confidence)) ? Number(cause.confidence) : null,
    immediate: arrayHead(remediation.immediate, 2),
    next24h: arrayHead(remediation.next24h, 2),
    prevention: arrayHead(remediation.prevention, 2)
  };
}

function appendAiMarkdown(markdownLines, analysisRecord) {
  const ai = readAiSummary(analysisRecord);
  if (!ai) {
    return;
  }

  if (ai.status === "pending") {
    markdownLines.push(`- AI分析: 排队中（模型 ${ai.model}）`);
    return;
  }

  const confidenceText = ai.confidence === null ? "--" : `${Math.round(ai.confidence * 100)}%`;
  markdownLines.push(`- AI分析: ${ai.status} / ${ai.category} / 置信度 ${confidenceText}`);

  if (ai.summary) {
    markdownLines.push(`- AI根因: ${ai.summary}`);
  }

  if (ai.immediate.length > 0) {
    markdownLines.push(`- AI立即处理: ${ai.immediate.join("；")}`);
  }

  if (ai.next24h.length > 0) {
    markdownLines.push(`- AI 24h建议: ${ai.next24h.join("；")}`);
  }
}

class AlertNotifier {
  constructor(options = {}) {
    this.genericWebhookUrl = trimUrl(options.webhookUrl);
    this.wechatWebhookUrl = trimUrl(options.wechatWebhookUrl);
    this.dingtalkWebhookUrl = trimUrl(options.dingtalkWebhookUrl);
    this.dingtalkSecret = trimUrl(options.dingtalkSecret);
    this.requestTimeoutMs = Math.max(1000, numberOr(options.timeoutMs, 5000));

    this.enabled = Boolean(
      this.genericWebhookUrl
      || this.wechatWebhookUrl
      || this.dingtalkWebhookUrl
    );
  }

  async notifyEvents({ hostSnapshot, events = [], sample = null }) {
    if (!this.enabled || !Array.isArray(events) || events.length === 0) {
      return;
    }

    const tasks = [];
    for (const event of events) {
      tasks.push(this.notifySingleEvent({ hostSnapshot, event, sample }));
    }

    await Promise.all(tasks);
  }

  async notifySingleEvent({ hostSnapshot, event, sample }) {
    const level = classifyLevel(event.level);
    const analysisRecord = event?.aiAnalysis || null;
    const eventEnvelope = {
      source: "pulseforge",
      host: {
        id: hostSnapshot.hostId,
        name: hostSnapshot.hostName,
        source: hostSnapshot.source
      },
      event,
      aiAnalysis: analysisRecord,
      sampleSummary: sample
        ? {
          ts: sample.ts,
          cpu: sample.cpu,
          mem: sample.mem,
          temp: sample.temp,
          packetLoss: sample.packetLoss
        }
        : null
    };

    const markdownLines = [
      `### ${levelEmoji(level)} PulseForge 告警`,
      `- 主机: ${toHostMarkdown(hostSnapshot)}`,
      `- 级别: ${level.toUpperCase()}`,
      `- 时间: ${event.time || new Date(event.ts || Date.now()).toLocaleString("zh-CN")}`,
      `- 内容: ${event.content}`
    ];

    if (sample) {
      markdownLines.push(`- 指标: CPU ${sample.cpu}% / MEM ${sample.mem}% / TEMP ${sample.temp}°C / Loss ${sample.packetLoss}%`);
    }

    appendAiMarkdown(markdownLines, analysisRecord);
    const markdownText = markdownLines.join("\n");

    const tasks = [];

    if (this.genericWebhookUrl) {
      tasks.push(this.safePostJson(this.genericWebhookUrl, eventEnvelope, "webhook"));
    }

    if (this.wechatWebhookUrl) {
      tasks.push(this.safePostJson(this.wechatWebhookUrl, {
        msgtype: "markdown",
        markdown: {
          content: markdownText
        }
      }, "wechat"));
    }

    if (this.dingtalkWebhookUrl) {
      const targetUrl = this.dingtalkSecret
        ? this.signedDingtalkUrl(this.dingtalkWebhookUrl)
        : this.dingtalkWebhookUrl;

      tasks.push(this.safePostJson(targetUrl, {
        msgtype: "markdown",
        markdown: {
          title: "PulseForge 告警",
          text: markdownText
        }
      }, "dingtalk"));
    }

    await Promise.all(tasks);
  }

  async notifyAnalysisUpdate({ hostSnapshot, event, analysisRecord, sample = null }) {
    if (!this.enabled || !analysisRecord || !event) {
      return;
    }

    const ai = readAiSummary(analysisRecord);
    if (!ai || ai.status === "pending") {
      return;
    }

    const level = classifyLevel(event.level);
    const markdownLines = [
      `### 🤖 PulseForge AI 分析更新`,
      `- 主机: ${toHostMarkdown(hostSnapshot)}`,
      `- 级别: ${level.toUpperCase()}`,
      `- 事件: ${event.content || event.key || event.id}`,
      `- 分析状态: ${ai.status} (${ai.model})`
    ];

    appendAiMarkdown(markdownLines, analysisRecord);

    if (sample) {
      markdownLines.push(`- 当前指标: CPU ${sample.cpu}% / MEM ${sample.mem}% / TEMP ${sample.temp}°C / Loss ${sample.packetLoss}%`);
    }

    const markdownText = markdownLines.join("\n");
    const payload = {
      source: "pulseforge",
      type: "analysis_update",
      host: {
        id: hostSnapshot.hostId,
        name: hostSnapshot.hostName,
        source: hostSnapshot.source
      },
      event,
      aiAnalysis: analysisRecord,
      sampleSummary: sample
        ? {
          ts: sample.ts,
          cpu: sample.cpu,
          mem: sample.mem,
          temp: sample.temp,
          packetLoss: sample.packetLoss
        }
        : null
    };

    const tasks = [];
    if (this.genericWebhookUrl) {
      tasks.push(this.safePostJson(this.genericWebhookUrl, payload, "webhook"));
    }

    if (this.wechatWebhookUrl) {
      tasks.push(this.safePostJson(this.wechatWebhookUrl, {
        msgtype: "markdown",
        markdown: {
          content: markdownText
        }
      }, "wechat"));
    }

    if (this.dingtalkWebhookUrl) {
      const targetUrl = this.dingtalkSecret
        ? this.signedDingtalkUrl(this.dingtalkWebhookUrl)
        : this.dingtalkWebhookUrl;

      tasks.push(this.safePostJson(targetUrl, {
        msgtype: "markdown",
        markdown: {
          title: "PulseForge AI 分析更新",
          text: markdownText
        }
      }, "dingtalk"));
    }

    await Promise.all(tasks);
  }

  signedDingtalkUrl(baseUrl) {
    const timestamp = Date.now();
    const stringToSign = `${timestamp}\n${this.dingtalkSecret}`;
    const sign = encodeURIComponent(
      crypto
        .createHmac("sha256", this.dingtalkSecret)
        .update(stringToSign)
        .digest("base64")
    );

    const joiner = baseUrl.includes("?") ? "&" : "?";
    return `${baseUrl}${joiner}timestamp=${timestamp}&sign=${sign}`;
  }

  async safePostJson(url, payload, channelName) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });

      if (!response.ok) {
        const text = await response.text().catch(() => "");
        console.warn(`[notifier] ${channelName} failed: HTTP ${response.status} ${text}`);
      }
    } catch (error) {
      console.warn(`[notifier] ${channelName} failed: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  }
}

module.exports = {
  AlertNotifier
};
