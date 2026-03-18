"use strict";

const fs = require("fs");
const path = require("path");

let DatabaseSync = null;
try {
  ({ DatabaseSync } = require("node:sqlite"));
} catch {
  DatabaseSync = null;
}

function safeJsonParse(text, fallbackValue) {
  try {
    return JSON.parse(text);
  } catch {
    return fallbackValue;
  }
}

class SqliteStore {
  constructor(options = {}) {
    if (!DatabaseSync) {
      throw new Error("node:sqlite unavailable (requires newer Node.js runtime)");
    }

    const dbPath = options.dbPath || path.join(process.cwd(), "data", "pulseforge.db");
    const retentionDays = Number(options.retentionDays || 7);

    this.dbPath = dbPath;
    this.retentionDays = Number.isFinite(retentionDays) ? Math.max(1, retentionDays) : 7;
    this.lastPruneTs = 0;

    const dbDir = path.dirname(dbPath);
    fs.mkdirSync(dbDir, { recursive: true });

    this.db = new DatabaseSync(dbPath);
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA synchronous = NORMAL");
    this.db.exec("PRAGMA temp_store = MEMORY");
    this.db.exec("PRAGMA foreign_keys = ON");

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS hosts (
        host_id TEXT PRIMARY KEY,
        host_name TEXT NOT NULL,
        source TEXT NOT NULL,
        meta_json TEXT NOT NULL,
        first_seen_ts INTEGER NOT NULL,
        last_seen_ts INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        host_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        iso_time TEXT NOT NULL,
        sample_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_samples_host_ts ON samples(host_id, ts);

      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        level TEXT NOT NULL,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        event_json TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_events_host_ts ON events(host_id, ts DESC);

      CREATE TABLE IF NOT EXISTS event_analyses (
        event_id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL,
        event_ts INTEGER NOT NULL,
        status TEXT NOT NULL,
        model TEXT NOT NULL,
        analysis_json TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_event_analyses_host_ts ON event_analyses(host_id, event_ts DESC);
    `);

    this.statements = {
      upsertHost: this.db.prepare(`
        INSERT INTO hosts(host_id, host_name, source, meta_json, first_seen_ts, last_seen_ts, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(host_id) DO UPDATE SET
          host_name = excluded.host_name,
          source = excluded.source,
          meta_json = excluded.meta_json,
          last_seen_ts = excluded.last_seen_ts,
          updated_at = excluded.updated_at
      `),
      insertSample: this.db.prepare(`
        INSERT INTO samples(host_id, ts, iso_time, sample_json)
        VALUES(?, ?, ?, ?)
      `),
      insertEvent: this.db.prepare(`
        INSERT OR REPLACE INTO events(id, host_id, ts, level, type, content, event_json)
        VALUES(?, ?, ?, ?, ?, ?, ?)
      `),
      selectLatestSample: this.db.prepare(`
        SELECT sample_json
        FROM samples
        WHERE host_id = ?
        ORDER BY ts DESC
        LIMIT 1
      `),
      selectLatestEvents: this.db.prepare(`
        SELECT event_json
        FROM events
        WHERE host_id = ?
        ORDER BY ts DESC
        LIMIT ?
      `),
      selectHosts: this.db.prepare(`
        SELECT host_id, host_name, source, meta_json, first_seen_ts, last_seen_ts, updated_at
        FROM hosts
        ORDER BY last_seen_ts DESC
      `),
      selectSamplesByRange: this.db.prepare(`
        SELECT sample_json
        FROM samples
        WHERE host_id = ? AND ts >= ? AND ts <= ?
        ORDER BY ts ASC
        LIMIT ?
      `),
      selectEventsByRange: this.db.prepare(`
        SELECT event_json
        FROM events
        WHERE host_id = ? AND ts >= ? AND ts <= ?
        ORDER BY ts DESC
        LIMIT ?
      `),
      selectEventById: this.db.prepare(`
        SELECT event_json
        FROM events
        WHERE host_id = ? AND id = ?
        LIMIT 1
      `),
      upsertEventAnalysis: this.db.prepare(`
        INSERT INTO event_analyses(event_id, host_id, event_ts, status, model, analysis_json, updated_at)
        VALUES(?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(event_id) DO UPDATE SET
          host_id = excluded.host_id,
          event_ts = excluded.event_ts,
          status = excluded.status,
          model = excluded.model,
          analysis_json = excluded.analysis_json,
          updated_at = excluded.updated_at
      `),
      selectEventAnalysis: this.db.prepare(`
        SELECT event_id, host_id, event_ts, status, model, analysis_json, updated_at
        FROM event_analyses
        WHERE event_id = ?
        LIMIT 1
      `),
      deleteOldSamples: this.db.prepare(`
        DELETE FROM samples
        WHERE ts < ?
      `),
      deleteOldEvents: this.db.prepare(`
        DELETE FROM events
        WHERE ts < ?
      `),
      deleteOldEventAnalyses: this.db.prepare(`
        DELETE FROM event_analyses
        WHERE event_ts < ?
      `)
    };

    this.insertBatch = (hostId, hostName, source, hostMeta, firstSeenTs, sample, events) => {
      this.db.exec("BEGIN IMMEDIATE");
      try {
        const now = Date.now();
        this.statements.upsertHost.run(
          hostId,
          hostName,
          source,
          JSON.stringify(hostMeta || {}),
          firstSeenTs,
          sample.ts,
          now
        );

        this.statements.insertSample.run(
          hostId,
          sample.ts,
          String(sample.isoTime || new Date(sample.ts).toISOString()),
          JSON.stringify(sample)
        );

        for (const event of events) {
          this.statements.insertEvent.run(
            String(event.id),
            hostId,
            Number(event.ts || sample.ts),
            String(event.level || "info"),
            String(event.type || "event"),
            String(event.content || ""),
            JSON.stringify(event)
          );
        }

        this.db.exec("COMMIT");
      } catch (error) {
        try {
          this.db.exec("ROLLBACK");
        } catch {
          // ignore rollback errors
        }
        throw error;
      }
    };
  }

  close() {
    this.db.close();
  }

  ensurePruned(nowTs = Date.now()) {
    if (nowTs - this.lastPruneTs < 10 * 60 * 1000) {
      return;
    }

    const retentionMs = this.retentionDays * 24 * 60 * 60 * 1000;
    const cutoff = nowTs - retentionMs;
    this.statements.deleteOldSamples.run(cutoff);
    this.statements.deleteOldEvents.run(cutoff);
    this.statements.deleteOldEventAnalyses.run(cutoff);
    this.lastPruneTs = nowTs;
  }

  persistHostSnapshot(host) {
    const now = Date.now();
    const firstSeenTs = Number(host.firstSeenTs || now);
    const lastSeenTs = Number(host.lastSeenTs || now);

    this.statements.upsertHost.run(
      String(host.hostId),
      String(host.hostName || host.hostId),
      String(host.source || "unknown"),
      JSON.stringify(host.meta || {}),
      firstSeenTs,
      lastSeenTs,
      now
    );
  }

  persistSampleBundle({ hostId, hostName, source, hostMeta, firstSeenTs, sample, events = [] }) {
    if (!sample || !Number.isFinite(Number(sample.ts))) {
      return;
    }

    this.insertBatch(
      String(hostId),
      String(hostName || hostId),
      String(source || "unknown"),
      hostMeta || {},
      Number(firstSeenTs || sample.ts),
      sample,
      Array.isArray(events) ? events : []
    );

    this.ensurePruned(sample.ts);
  }

  getLatestSample(hostId) {
    const row = this.statements.selectLatestSample.get(String(hostId));
    if (!row) {
      return null;
    }
    return safeJsonParse(row.sample_json, null);
  }

  getEvents(hostId, { fromTs = 0, toTs = Number.MAX_SAFE_INTEGER, limit = 120 } = {}) {
    const safeLimit = Math.max(1, Math.min(5000, Number(limit) || 120));
    const rows = this.statements.selectEventsByRange.all(
      String(hostId),
      Number(fromTs) || 0,
      Number(toTs) || Number.MAX_SAFE_INTEGER,
      safeLimit
    );
    return rows.map((row) => safeJsonParse(row.event_json, null)).filter(Boolean);
  }

  getEventById(hostId, eventId) {
    const row = this.statements.selectEventById.get(String(hostId), String(eventId));
    if (!row) {
      return null;
    }
    return safeJsonParse(row.event_json, null);
  }

  upsertEventAnalysis(record) {
    if (!record || !record.eventId) {
      return;
    }

    const updatedAt = Number(record.updatedAt || Date.now());
    this.statements.upsertEventAnalysis.run(
      String(record.eventId),
      String(record.hostId || "unknown"),
      Number(record.eventTs || 0),
      String(record.status || "fallback"),
      String(record.model || "none"),
      JSON.stringify(record.analysis || {}),
      updatedAt
    );
  }

  getEventAnalysis(eventId) {
    const row = this.statements.selectEventAnalysis.get(String(eventId));
    if (!row) {
      return null;
    }

    return {
      eventId: row.event_id,
      hostId: row.host_id,
      eventTs: Number(row.event_ts || 0),
      status: String(row.status || "fallback"),
      model: String(row.model || "none"),
      analysis: safeJsonParse(row.analysis_json, {}),
      updatedAt: Number(row.updated_at || 0)
    };
  }

  getSamples(hostId, { fromTs = 0, toTs = Number.MAX_SAFE_INTEGER, limit = 20000 } = {}) {
    const safeLimit = Math.max(1, Math.min(500000, Number(limit) || 20000));
    const rows = this.statements.selectSamplesByRange.all(
      String(hostId),
      Number(fromTs) || 0,
      Number(toTs) || Number.MAX_SAFE_INTEGER,
      safeLimit
    );
    return rows.map((row) => safeJsonParse(row.sample_json, null)).filter(Boolean);
  }

  getSamplesReplay(hostId, { fromTs, toTs, limit = 20000, stepMs = 1000 } = {}) {
    const samples = this.getSamples(hostId, { fromTs, toTs, limit });
    const safeStep = Math.max(100, Number(stepMs) || 1000);
    if (samples.length <= 2) {
      return samples;
    }

    const replay = [];
    let nextTs = Number(fromTs) || samples[0].ts;

    for (const sample of samples) {
      if (sample.ts >= nextTs || replay.length === 0) {
        replay.push(sample);
        nextTs = sample.ts + safeStep;
      }
    }

    if (replay[replay.length - 1]?.ts !== samples[samples.length - 1]?.ts) {
      replay.push(samples[samples.length - 1]);
    }

    return replay;
  }

  getHosts() {
    const rows = this.statements.selectHosts.all();
    return rows.map((row) => {
      return {
        hostId: row.host_id,
        hostName: row.host_name,
        source: row.source,
        meta: safeJsonParse(row.meta_json, {}),
        firstSeenTs: Number(row.first_seen_ts || 0),
        lastSeenTs: Number(row.last_seen_ts || 0),
        updatedAt: Number(row.updated_at || 0)
      };
    });
  }
}

module.exports = {
  SqliteStore
};
