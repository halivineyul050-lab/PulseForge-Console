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
    const eventEnvelope = {
      source: "pulseforge",
      host: {
        id: hostSnapshot.hostId,
        name: hostSnapshot.hostName,
        source: hostSnapshot.source
      },
      event,
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
