// SQLite 薄适配层。
//
// 业务只依赖这里导出的接口，不直接 import 'node:sqlite'：Node 升级如果改了实验 API，
// 只需要替换本文件（或切到 better-sqlite3），表结构与调用方不动。
//
// 约定：
//   · 所有时间都是毫秒时间戳（INTEGER）；
//   · 所有 JSON 列都存 TEXT，由调用方显式 stringify/parse（便于离线排查）；
//   · 写操作尽量走 transaction()，避免半条记录。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

export const SCHEMA_VERSION = 4;

const MIGRATIONS = [
  {
    version: 1,
    note: 'initial: events/outbox/jobs/memory/relationships/usage_ledger',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS meta (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS events (
          id INTEGER PRIMARY KEY,
          direction TEXT NOT NULL,              -- in / out
          key TEXT NOT NULL,
          kind TEXT,
          message_id TEXT,
          seq INTEGER,
          payload_json TEXT NOT NULL,
          dedupe_key TEXT UNIQUE,
          created_at INTEGER NOT NULL,
          processed_at INTEGER,
          error TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
        CREATE INDEX IF NOT EXISTS idx_events_unprocessed ON events(direction, processed_at, created_at);

        CREATE TABLE IF NOT EXISTS outbox (
          id INTEGER PRIMARY KEY,
          key TEXT NOT NULL,
          kind TEXT NOT NULL,                   -- text/reply/media/voice/reminder/notice
          payload_json TEXT NOT NULL,
          dedupe_key TEXT UNIQUE,
          state TEXT NOT NULL,                  -- pending/sending/sent/failed/dead/uncertain
          attempts INTEGER NOT NULL DEFAULT 0,
          next_attempt_at INTEGER,
          locked_until INTEGER,
          last_error TEXT,
          result_json TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          sent_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_outbox_due ON outbox(state, next_attempt_at);
        CREATE INDEX IF NOT EXISTS idx_outbox_key ON outbox(key, created_at);

        CREATE TABLE IF NOT EXISTS jobs (
          id INTEGER PRIMARY KEY,
          type TEXT NOT NULL,
          job_key TEXT,
          payload_json TEXT,
          dedupe_key TEXT UNIQUE,
          state TEXT NOT NULL,                  -- pending/running/done/failed/dead/cancelled
          run_after INTEGER NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          locked_until INTEGER,
          last_error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          finished_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_jobs_due ON jobs(state, run_after);
        CREATE INDEX IF NOT EXISTS idx_jobs_type ON jobs(type, state);

        CREATE TABLE IF NOT EXISTS memory_facts (
          id INTEGER PRIMARY KEY,
          scope TEXT NOT NULL,                  -- global/group/member
          owner_key TEXT,
          topic TEXT,
          fact TEXT NOT NULL,
          source TEXT,
          confidence REAL NOT NULL DEFAULT 0.7,
          weight REAL NOT NULL DEFAULT 1,
          last_seen_at INTEGER,
          expires_at INTEGER,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_memory_scope ON memory_facts(scope, owner_key);

        CREATE TABLE IF NOT EXISTS member_relationships (
          key TEXT NOT NULL,
          user_id TEXT NOT NULL,
          familiarity REAL NOT NULL DEFAULT 0,
          affinity REAL NOT NULL DEFAULT 0,
          trust REAL NOT NULL DEFAULT 0,
          last_interaction_at INTEGER,
          note TEXT,
          updated_at INTEGER,
          PRIMARY KEY (key, user_id)
        );

        CREATE TABLE IF NOT EXISTS usage_ledger (
          id INTEGER PRIMARY KEY,
          key TEXT,
          session_id TEXT,
          turn INTEGER,
          step INTEGER,
          model TEXT,
          provider TEXT,
          tokens_in INTEGER,
          tokens_out INTEGER,
          cost REAL,
          tier TEXT,
          dedupe_key TEXT UNIQUE,
          created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ledger_created ON usage_ledger(created_at);
        CREATE INDEX IF NOT EXISTS idx_ledger_key ON usage_ledger(key, created_at);
      `);
    }
  },
  {
    version: 2,
    note: 'session_map + memory FTS (trigram)',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS session_map (
          key TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          policy_json TEXT,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_session_map_sid ON session_map(session_id);
      `);
      // 迁移记录丢失后重跑 v2 时，列可能已存在；显式检查，保证迁移可重入。
      const columns = db.all('PRAGMA table_info(memory_facts)').map((c) => String(c.name));
      if (!columns.includes('fact_hash')) db.exec('ALTER TABLE memory_facts ADD COLUMN fact_hash TEXT');
      db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_hash ON memory_facts(fact_hash)');
      // trigram：中文按 3 字符切片，能搜「天气和」这类子串；2 字查询由应用层 LIKE 兜底。
      db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(
          fact, topic, scope UNINDEXED, owner_key UNINDEXED, tokenize='trigram'
        );
      `);
    }
  },
  {
    version: 3,
    note: 'relationship v2: four axes + stages + events/daily',
    up(db) {
      const addColumn = (table, column, definition) => {
        const columns = db.all(`PRAGMA table_info(${table})`).map((c) => String(c.name));
        if (!columns.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
      };
      addColumn('member_relationships', 'affection', 'REAL NOT NULL DEFAULT 8');
      addColumn('member_relationships', 'rapport', 'REAL NOT NULL DEFAULT 0');
      addColumn('member_relationships', 'bond', 'REAL NOT NULL DEFAULT 0');
      addColumn('member_relationships', 'stage', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('member_relationships', 'stage_changed_at', 'INTEGER');
      addColumn('member_relationships', 'stage_hold_until', 'INTEGER');
      addColumn('member_relationships', 'interaction_count', 'INTEGER NOT NULL DEFAULT 0');
      addColumn('member_relationships', 'last_delta_json', 'TEXT');
      addColumn('member_relationships', 'daily_json', 'TEXT');
      addColumn('member_relationships', 'flags_json', 'TEXT');
      // v2 的 familiarity/trust 是 0~1；迁移到 0~100（只转换看起来仍是旧尺度的行）。
      db.exec(`
        UPDATE member_relationships
        SET affection = MIN(100, MAX(0, affinity * 100)),
            familiarity = MIN(100, MAX(0, familiarity * 100)),
            trust = MIN(100, MAX(0, trust * 100))
        WHERE familiarity <= 1 AND trust <= 1
      `);
      db.exec(`
        CREATE TABLE IF NOT EXISTS relationship_events (
          id INTEGER PRIMARY KEY,
          key TEXT NOT NULL,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL,
          reason TEXT,
          affection_delta REAL NOT NULL DEFAULT 0,
          trust_delta REAL NOT NULL DEFAULT 0,
          familiarity_delta REAL NOT NULL DEFAULT 0,
          rapport_delta REAL NOT NULL DEFAULT 0,
          bond_delta REAL NOT NULL DEFAULT 0,
          context_json TEXT,
          source_message_id TEXT,
          dedupe_key TEXT UNIQUE,
          created_at INTEGER NOT NULL,
          day_key TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_rel_events_member ON relationship_events(key, user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_rel_events_day ON relationship_events(day_key);

        CREATE TABLE IF NOT EXISTS relationship_daily (
          key TEXT NOT NULL,
          user_id TEXT NOT NULL,
          day_key TEXT NOT NULL,
          affection_delta REAL NOT NULL DEFAULT 0,
          trust_delta REAL NOT NULL DEFAULT 0,
          familiarity_delta REAL NOT NULL DEFAULT 0,
          rapport_delta REAL NOT NULL DEFAULT 0,
          interactions INTEGER NOT NULL DEFAULT 0,
          stage_end INTEGER,
          bond_end REAL,
          PRIMARY KEY (key, user_id, day_key)
        );
        CREATE INDEX IF NOT EXISTS idx_rel_daily_day ON relationship_daily(day_key);
      `);
    }
  },
  {
    version: 4,
    note: 'recalibrate legacy relationship rows (v2 0.5 → 50 inflation)',
    up(db) {
      const now = Date.now();
      // v3 从旧模型迁移时把“中性 0.5”换成了 50 分，导致老成员一上来就是熟人/眼熟。
      // 只重算“从未被新模型观察过、没有事件、且数值看起来像旧迁移值”的行；
      // 主人/手动设置的高数值行保持不动。
      db.exec(`
        UPDATE member_relationships
        SET affection = 8,
            trust = 5,
            familiarity = 0,
            rapport = 0,
            bond = 4.85,
            stage = 0,
            stage_changed_at = ${now},
            stage_hold_until = ${now + 24 * 3600 * 1000},
            updated_at = ${now}
        WHERE interaction_count = 0
          AND affection BETWEEN 40 AND 85
          AND familiarity <= 20
          AND trust <= 5
          AND NOT EXISTS (
            SELECT 1 FROM relationship_events e
            WHERE e.key = member_relationships.key AND e.user_id = member_relationships.user_id
          )
          AND NOT (affection >= 90 AND trust >= 90 AND familiarity >= 90)
      `);
      // 旧列 affinity 之前被新写入逻辑误写成 0~100；统一恢复成 0~1，避免以后误读。
      db.exec('UPDATE member_relationships SET affinity = affinity / 100.0 WHERE affinity > 1');
    }
  }
];

function ensureDir(file) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
}

function quoteSqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

export class Db {
  constructor(database, { file, readonly = false } = {}) {
    this.raw = database;
    this.file = file;
    this.readonly = readonly;
  }

  exec(sql) {
    return this.raw.exec(sql);
  }

  prepare(sql) {
    return this.raw.prepare(sql);
  }

  run(sql, ...params) {
    return this.raw.prepare(sql).run(...params);
  }

  get(sql, ...params) {
    return this.raw.prepare(sql).get(...params);
  }

  all(sql, ...params) {
    return this.raw.prepare(sql).all(...params);
  }

  transaction(fn) {
    this.raw.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      try { this.raw.exec('ROLLBACK'); } catch { /* 已回滚/未开启 */ }
      throw error;
    }
  }

  /**
   * 在线备份（VACUUM INTO）。WAL 模式下比直接 copy 文件安全：包含尚未 checkpoint 的页。
   * 返回写出的文件路径；同秒重名时追加随机后缀。
   */
  backupTo(dir, prefix = 'bridge') {
    fs.mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    let target = path.join(dir, `${prefix}-${stamp}.db`);
    if (fs.existsSync(target)) target = path.join(dir, `${prefix}-${stamp}-${crypto.randomBytes(3).toString('hex')}.db`);
    this.raw.exec(`VACUUM INTO ${quoteSqlString(target)}`);
    return target;
  }

  stats() {
    const pageCount = this.get('PRAGMA page_count')?.page_count ?? 0;
    const pageSize = this.get('PRAGMA page_size')?.page_size ?? 0;
    const journal = this.get('PRAGMA journal_mode')?.journal_mode ?? 'unknown';
    return { file: this.file, bytes: pageCount * pageSize, journalMode: journal };
  }

  close() {
    try { this.raw.close(); } catch { /* 关闭失败不阻断退出 */ }
  }
}

function appliedVersions(db) {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, note TEXT)');
  return new Set(db.all('SELECT version FROM schema_migrations').map((row) => Number(row.version)));
}

/**
 * 打开数据库并跑迁移。
 *
 * 迁移前默认做一次在线备份（backupDir 为空则跳过）；备份失败只告警，不阻断启动
 * —— 备份是额外的安全网，不是启动前置条件。
 */
export function openDatabase({
  file,
  backupDir = '',
  backupKeepDays = 7,
  readonly = false,
  migrate = true,
  now = () => Date.now(),
  logger = () => {}
} = {}) {
  if (!file) throw new Error('openDatabase 需要 file');
  if (file !== ':memory:') ensureDir(file);
  const db = new DatabaseSync(file, { readOnly: readonly });
  const wrapped = new Db(db, { file, readonly });

  // busy_timeout 必须最先设置：启动瞬间 MCP 工具进程也可能在读同一个库。
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* 老版本忽略 */ }
  if (!readonly) {
    try { db.exec('PRAGMA journal_mode = WAL'); } catch (error) { logger(`SQLite 无法开启 WAL：${error?.message ?? error}`); }
    try { db.exec('PRAGMA synchronous = NORMAL'); } catch {}
    try { db.exec('PRAGMA foreign_keys = ON'); } catch {}
  }

  if (!migrate || readonly) return wrapped;

  const before = appliedVersions(wrapped);
  const pending = MIGRATIONS.filter((m) => !before.has(m.version));
  // 每次打开都清一次过期备份：迁移不一定发生，但备份目录不该无限增长。
  if (backupDir && file !== ':memory:') {
    try { pruneBackups(backupDir, backupKeepDays, now()); } catch { /* 备份目录不可用不影响启动 */ }
  }
  if (pending.length && backupDir && file !== ':memory:' && before.size > 0) {
    try {
      const target = wrapped.backupTo(backupDir);
      logger(`SQLite 迁移前已备份：${target}`);
    } catch (error) {
      logger(`⚠️ SQLite 迁移前备份失败（继续迁移）：${error?.message ?? error}`);
    }
  }

  for (const migration of pending) {
    wrapped.transaction(() => {
      migration.up(wrapped);
      db.prepare('INSERT INTO schema_migrations(version, applied_at, note) VALUES (?, ?, ?)')
        .run(migration.version, now(), migration.note ?? '');
    });
    logger(`SQLite 迁移已应用：v${migration.version} ${migration.note ?? ''}`.trim());
  }
  return wrapped;
}

export function pruneBackups(dir, keepDays, now = Date.now()) {
  const cutoff = now - Math.max(1, Number(keepDays) || 7) * 24 * 3600 * 1000;
  let removed = 0;
  try {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.db')) continue;
      const file = path.join(dir, name);
      try {
        if (fs.statSync(file).mtimeMs < cutoff) { fs.unlinkSync(file); removed += 1; }
      } catch { /* 单个文件失败不影响其它 */ }
    }
  } catch { /* 目录不存在 */ }
  return removed;
}

/** 删除过期行；返回各表删除数量。用于 7×24 运行时的容量控制。 */
export function pruneDatabase(db, { retentionDays = 30, now = Date.now() } = {}) {
  const cutoff = now - Math.max(1, Number(retentionDays) || 30) * 24 * 3600 * 1000;
  const out = {};
  out.events = db.run('DELETE FROM events WHERE created_at < ? AND (processed_at IS NOT NULL OR direction = ?)', cutoff, 'out').changes;
  out.outbox = db.run('DELETE FROM outbox WHERE created_at < ? AND state IN (?, ?)', cutoff, 'sent', 'dead').changes;
  out.jobs = db.run('DELETE FROM jobs WHERE created_at < ? AND state IN (?, ?, ?)', cutoff, 'done', 'dead', 'cancelled').changes;
  out.usage = db.run('DELETE FROM usage_ledger WHERE created_at < ?', cutoff).changes;
  return out;
}
