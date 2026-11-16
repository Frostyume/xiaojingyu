// 睡眠期巩固：把“整理记忆”这件苦活从在线聊天路径挪走。
//
// 默认关闭。关闭时本模块不被调用、不建表、不写文件，提示词逐字不变。
//
// 三条硬规则：
//   1. 只增不删：产出 observation（摘要 + 原话证据 + proof_count）；新证据用新行
//      refine 旧 observation（refines_id 指向被精化的行），旧行原文永不覆盖。
//   2. 删除只能提案：睡眠期只往 cognition_deletion_proposals 写 status='pending'
//      的提案，永不执行 DELETE。唯一的删除入口是主人显式审批（decideProposal）。
//   3. 预算与幂等：单次最多 maxEpisodes 条经历、maxLlmCalls 次模型调用；
//      batch_hash 唯一索引兜底，重跑同批不重复产出。
//
// 审计只记 id/动作/时间，不落原文。

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { effectiveExperienceStrength, ensureExperienceSchema } from './experience.js';

export const SLEEP_DAY_MS = 24 * 3600 * 1000;
export const SLEEP_HOUR_MS = 3600 * 1000;
export const TZ_OFFSET_MS = 8 * 3600 * 1000; // Asia/Shanghai，无夏令时

export const SLEEP_DEFAULTS = Object.freeze({
  hour: 4,
  idleMs: 30 * 60 * 1000,
  maxEpisodes: 20,
  maxLlmCalls: 3,
  quoteChars: 120,
  summaryChars: 160,
  forgetBelow: 0.05,
  maxProposals: 5
});

const clampNum = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/** 生效配置：只补默认值，非法值回落到默认，不猜。 */
export function sleepSettings(raw = {}) {
  const c = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return {
    enabled: c.enabled === true,
    hour: clampNum(c.hour, 0, 23, SLEEP_DEFAULTS.hour),
    idleMs: clampNum(c.idleMs, 60 * 1000, 24 * SLEEP_HOUR_MS, SLEEP_DEFAULTS.idleMs),
    maxEpisodes: clampNum(c.maxEpisodes, 1, 200, SLEEP_DEFAULTS.maxEpisodes),
    maxLlmCalls: clampNum(c.maxLlmCalls, 0, 20, SLEEP_DEFAULTS.maxLlmCalls),
    quoteChars: clampNum(c.quoteChars, 20, 400, SLEEP_DEFAULTS.quoteChars),
    summaryChars: clampNum(c.summaryChars, 20, 400, SLEEP_DEFAULTS.summaryChars),
    forgetBelow: clampNum(c.forgetBelow, 0, 0.5, SLEEP_DEFAULTS.forgetBelow),
    maxProposals: clampNum(c.maxProposals, 0, 50, SLEEP_DEFAULTS.maxProposals)
  };
}

/** 下一个北京时间 hour:00 的 UTC 毫秒；正好落在整点时取明天，避免同一小时内反复触发。 */
export function nextSleepAt(now = Date.now(), hour = SLEEP_DEFAULTS.hour) {
  const at = Number(now);
  if (!Number.isFinite(at)) return 0;
  const h = clampNum(hour, 0, 23, SLEEP_DEFAULTS.hour);
  const shifted = at + TZ_OFFSET_MS;
  const localDayStart = Math.floor(shifted / SLEEP_DAY_MS) * SLEEP_DAY_MS;
  const target = localDayStart + h * SLEEP_HOUR_MS - TZ_OFFSET_MS;
  return target > at ? target : target + SLEEP_DAY_MS;
}

/** 空闲判定：从未收到消息也算空闲（夜里没人聊天时同样该整理）。 */
export function isIdleSince(lastIncomingAt, now = Date.now(), idleMs = SLEEP_DEFAULTS.idleMs) {
  const at = Number(now);
  const last = Number(lastIncomingAt);
  if (!Number.isFinite(at)) return false;
  if (!Number.isFinite(last) || last <= 0) return true;
  return at - last >= Number(idleMs);
}

function shortHash(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 32);
}

function cleanText(value, limit) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/** 可重入 DDL：只加表/索引；关闭态不会调用到这里。 */
export function ensureSleepSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_observations (
      id                 TEXT PRIMARY KEY,
      obs_key            TEXT NOT NULL,
      person_id          TEXT,
      topic              TEXT,
      summary            TEXT NOT NULL,
      quote              TEXT NOT NULL DEFAULT '',
      proof_count        INTEGER NOT NULL DEFAULT 1,
      source_episode_ids TEXT NOT NULL DEFAULT '[]',
      batch_hash         TEXT NOT NULL,
      refines_id         TEXT,
      visibility         TEXT NOT NULL DEFAULT 'owner',
      last_evidence_at   INTEGER NOT NULL,
      created_at         INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cog_obs_batch ON cognition_observations(batch_hash);
    CREATE INDEX IF NOT EXISTS idx_cog_obs_key ON cognition_observations(obs_key, created_at);

    CREATE TABLE IF NOT EXISTS cognition_deletion_proposals (
      id          TEXT PRIMARY KEY,
      target_kind TEXT NOT NULL,
      target_id   TEXT NOT NULL,
      reason      TEXT NOT NULL,
      evidence    TEXT NOT NULL DEFAULT '',
      status      TEXT NOT NULL DEFAULT 'pending',
      created_at  INTEGER NOT NULL,
      decided_at  INTEGER,
      UNIQUE(target_kind, target_id)
    );
    CREATE INDEX IF NOT EXISTS idx_cog_proposals_status ON cognition_deletion_proposals(status, created_at);
  `);
  const columns = db.all('PRAGMA table_info(cognition_experiences)').map((c) => String(c.name));
  if (columns.length && !columns.includes('observed_at')) {
    db.exec('ALTER TABLE cognition_experiences ADD COLUMN observed_at INTEGER');
  }
  return true;
}

/**
 * 一批经历 → 若干条 observation 素材（按 会话 × 话题 聚合）。
 * 纯函数、不碰数据库，方便单独验证聚合、截断与预算。
 */
export function buildObservations(rows = [], {
  quoteChars = SLEEP_DEFAULTS.quoteChars,
  summaryChars = SLEEP_DEFAULTS.summaryChars
} = {}) {
  const groups = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || !String(row.summary ?? '').trim()) continue;
    const topic = cleanText(row.topic, 40);
    const scopeKey = cleanText(row.scope_key, 80);
    const key = `${scopeKey || '-'}\u0000${topic || '-'}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  const built = [];
  for (const [obsKey, list] of groups) {
    const ordered = [...list].sort((a, b) => Number(a.occurred_at) - Number(b.occurred_at));
    const latest = ordered[ordered.length - 1];
    const ids = ordered.map((r) => String(r.id)).sort();
    const [scopeKey, topic] = obsKey.split('\u0000');
    built.push({
      obsKey,
      personId: null,
      topic: topic === '-' ? null : topic,
      scopeKey: scopeKey === '-' ? null : scopeKey,
      episodeIds: ids,
      batchHash: shortHash(ids.join(',')),
      quote: cleanText(latest.summary, quoteChars),
      summary: cleanText(ordered.map((r) => String(r.summary)).filter(Boolean).join('；'), summaryChars),
      valence: latest.valence ?? null,
      visibility: 'owner',
      lastEvidenceAt: Number(latest.occurred_at) || 0
    });
  }
  return built.sort((a, b) => a.obsKey.localeCompare(b.obsKey));
}

/** 审计行：只允许 at/run/action/id 四个键。用白名单构造，结构上不可能把原文写进去。 */
export function auditLine({ at, run, action, id } = {}) {
  return { at: Number(at) || 0, run: String(run ?? ''), action: String(action ?? ''), id: String(id ?? '') };
}

export const PROPOSAL_AUDIT_ACTIONS = Object.freeze({ approve: 'approve_delete', reject: 'reject_delete' });

function tableExists(db, name) {
  try {
    return Boolean(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", name));
  } catch {
    return false;
  }
}

/** 追加 JSONL；目录不存在时创建。失败由调用方兜住，巩固不能因为审计写不下而中断。 */
export function appendAudit(file, lines = []) {
  const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
  if (!list.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${list.map((l) => JSON.stringify(l)).join('\n')}\n`, 'utf8');
  return list.length;
}

export class SleepConsolidator {
  constructor({
    db,
    now = () => Date.now(),
    logger = () => {},
    config = {},
    auditFile = null,
    generate = null
  } = {}) {
    if (!db) throw new Error('SleepConsolidator 需要 db');
    this.db = db;
    this.now = now;
    this.logger = logger;
    this.settings = sleepSettings(config);
    this.auditFile = auditFile;
    this.generate = typeof generate === 'function' ? generate : null;
  }

  /**
   * 单次睡眠巩固。budget 只能收紧、不能放宽配置上限。
   * 关闭态：不建表、不查库、不写审计，返回 disabled。
   */
  async run({ now = null, reason = 'sleep', limit = null, maxLlmCalls = null, lastIncomingAt = null } = {}) {
    const settings = { ...this.settings };
    const tighten = (value, key) => {
      if (value === null || value === undefined) return;
      const n = Number(value);
      if (!Number.isFinite(n)) return;
      settings[key] = Math.min(settings[key], Math.max(0, n));
    };
    tighten(limit, 'maxEpisodes');
    tighten(maxLlmCalls, 'maxLlmCalls');
    const zero = { done: false, reason: 'disabled', processed: 0, observations: 0, refined: 0, proposals: 0, llmCalls: 0, skipped: 0 };
    if (!settings.enabled) return zero;
    if (reason === 'idle' && settings.idleMs > 0
      && !isIdleSince(lastIncomingAt, now || this.now(), settings.idleMs)) {
      return { ...zero, done: false, reason: 'busy' };
    }

    const at = Number(now) || this.now();
    ensureExperienceSchema(this.db);
    ensureSleepSchema(this.db);
    const rows = this.db.all(
      `SELECT * FROM cognition_experiences WHERE observed_at IS NULL
       ORDER BY occurred_at ASC LIMIT ?`,
      Math.min(1000, Math.max(1, Math.round(settings.maxEpisodes)))
    );
    const runId = shortHash(`${at}:${reason}`);
    const audit = [];
    let llmCalls = 0;
    let observations = 0;
    let refined = 0;
    let skipped = 0;

    for (const group of buildObservations(rows, settings)) {
      let summary = group.summary;
      if (this.generate && llmCalls < settings.maxLlmCalls) {
        llmCalls += 1;
        try {
          const text = await this.generate({ ...group, reason, now: at });
          const cleaned = cleanText(text, settings.summaryChars);
          if (cleaned) summary = cleaned;
        } catch (error) {
          this.logger(`睡眠巩固摘要失败（退回拼接摘要）：${error?.message ?? error}`);
        }
      }
      // refine 只新增行并指向旧行；旧 observation 的 summary/quote 一个字节都不改。
      const prev = this.db.get(
        `SELECT id, proof_count FROM cognition_observations WHERE obs_key = ?
         ORDER BY created_at DESC, id ASC LIMIT 1`,
        group.obsKey
      );
      const id = shortHash(`obs:${group.batchHash}`);
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO cognition_observations(
           id, obs_key, person_id, topic, summary, quote, proof_count, source_episode_ids,
           batch_hash, refines_id, visibility, last_evidence_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        id, group.obsKey, group.personId, group.topic, summary, group.quote,
        (prev ? Number(prev.proof_count) || 0 : 0) + group.episodeIds.length,
        JSON.stringify(group.episodeIds), group.batchHash, prev?.id ?? null,
        group.visibility, group.lastEvidenceAt || at, at
      );
      if (!Number(inserted?.changes)) { skipped += 1; continue; }
      if (prev) refined += 1; else observations += 1;
      audit.push(auditLine({ at, run: runId, action: prev ? 'refine' : 'observe', id }));
    }

    // 整批都算“已经看过”：包括摘要为空、被跳过的行，否则它们会一直占着下次预算。
    for (const row of rows) {
      this.db.run('UPDATE cognition_experiences SET observed_at = ? WHERE id = ? AND observed_at IS NULL', at, String(row.id));
    }
    const proposals = this._propose({ at, rows, runId, audit, settings });

    if (this.auditFile && audit.length) {
      try { appendAudit(this.auditFile, audit); } catch (error) {
        this.logger(`睡眠巩固审计写入失败（忽略）：${error?.message ?? error}`);
      }
    }
    return {
      done: true, reason, runId,
      processed: rows.length, observations, refined, proposals, llmCalls, skipped,
      auditLines: audit.length
    };
  }

  /**
   * 只出提案，绝不执行删除：写 cognition_deletion_proposals(status='pending')。
   * UNIQUE(target_kind,target_id) 兜底，同一目标不重复提。
   */
  _propose({ at, rows, runId, audit, settings }) {
    const cap = Math.max(0, Math.round(settings.maxProposals));
    if (!cap || !rows.length) return 0;
    const strengthOf = (row) => effectiveExperienceStrength({
      occurredAt: Number(row.occurred_at),
      strength: Number(row.strength),
      valence: row.valence ?? null,
      topic: row.topic ?? null
    }, { now: at });
    const ordered = [...rows].sort((a, b) => strengthOf(a) - strengthOf(b));
    let created = 0;
    for (const row of ordered) {
      if (created >= cap) break;
      const ageDays = Math.max(0, (at - Number(row.occurred_at || at)) / SLEEP_DAY_MS);
      // 还没到 180 天保留期的不提：睡眠期无权提前判“该忘了”。
      if (ageDays < 180) continue;
      const strength = strengthOf(row);
      if (!(strength < settings.forgetBelow)) continue;
      const id = shortHash(`prop:experience:${row.id}`);
      const inserted = this.db.run(
        `INSERT OR IGNORE INTO cognition_deletion_proposals(
           id, target_kind, target_id, reason, evidence, status, created_at)
         VALUES (?, 'experience', ?, 'sleep_consolidation', ?, 'pending', ?)`,
        id, String(row.id),
        `effective_strength=${strength.toFixed(4)};age_days=${Math.floor(ageDays)}`, at
      );
      if (!Number(inserted?.changes)) continue;
      created += 1;
      audit.push(auditLine({ at, run: runId, action: 'propose_delete', id }));
    }
    return created;
  }

  /** 待审批提案（只读）。表还没建时返回空列表，不报错、更不建表。 */
  listPendingProposals({ limit = 20 } = {}) {
    if (!tableExists(this.db, 'cognition_deletion_proposals')) return [];
    return this.db.all(
      `SELECT id, target_kind, target_id, reason, evidence, status, created_at
       FROM cognition_deletion_proposals WHERE status = 'pending'
       ORDER BY created_at ASC LIMIT ?`,
      Math.min(100, Math.max(1, Number(limit) || 20))
    ).map((r) => ({
      id: r.id,
      targetKind: r.target_kind,
      targetId: r.target_id,
      reason: r.reason,
      evidence: r.evidence,
      status: r.status,
      createdAt: Number(r.created_at)
    }));
  }

  getProposal(id) {
    const pid = String(id ?? '').trim();
    if (!pid || !tableExists(this.db, 'cognition_deletion_proposals')) return null;
    const r = this.db.get(
      `SELECT id, target_kind, target_id, reason, evidence, status, created_at, decided_at
       FROM cognition_deletion_proposals WHERE id = ?`,
      pid
    );
    if (!r) return null;
    return {
      id: r.id,
      targetKind: r.target_kind,
      targetId: r.target_id,
      reason: r.reason,
      evidence: r.evidence,
      status: r.status,
      createdAt: Number(r.created_at),
      decidedAt: r.decided_at == null ? null : Number(r.decided_at)
    };
  }

  countProposals() {
    if (!this.settings.enabled || !tableExists(this.db, 'cognition_deletion_proposals')) {
      return { pending: 0, approved: 0, rejected: 0, total: 0 };
    }
    const row = this.db.get(
      `SELECT COUNT(*) AS total,
              SUM(status = 'pending') AS pending,
              SUM(status = 'approved') AS approved,
              SUM(status = 'rejected') AS rejected
       FROM cognition_deletion_proposals`
    ) ?? {};
    return {
      pending: Number(row.pending) || 0,
      approved: Number(row.approved) || 0,
      rejected: Number(row.rejected) || 0,
      total: Number(row.total) || 0
    };
  }

  /**
   * 主人显式审批一条提案——这是全系统唯一能删经历的地方。
   * 只对 status='pending' 生效，重复审批是幂等空操作。
   * 关闭态、表不存在、id 不存在、目标类型不是 experience：一律不删、不建表。
   */
  decideProposal({ id, decision, at = null, runId = '' } = {}) {
    const action = PROPOSAL_AUDIT_ACTIONS[String(decision ?? '').trim()];
    if (!action) return { ok: false, error: 'decision 只能是 approve 或 reject' };
    if (!this.settings.enabled) return { ok: false, error: '睡眠巩固未启用' };
    const pid = String(id ?? '').trim();
    if (!pid) return { ok: false, error: '缺少提案 id' };
    if (!tableExists(this.db, 'cognition_deletion_proposals')) {
      return { ok: false, error: `提案不存在：${pid}` };
    }
    const row = this.db.get(
      'SELECT id, target_kind, target_id, status FROM cognition_deletion_proposals WHERE id = ?',
      pid
    );
    if (!row) return { ok: false, error: `提案不存在：${pid}` };
    if (row.status !== 'pending') {
      return { ok: false, error: `提案已是 ${row.status}，不再重复处理`, status: row.status };
    }
    if (action === 'approve_delete' && String(row.target_kind) !== 'experience') {
      return { ok: false, error: `暂不支持删除 ${row.target_kind} 类型的提案目标` };
    }
    const stamp = Number(at) || this.now();
    let deleted = 0;
    try {
      this.db.transaction(() => {
        const changed = this.db.run(
          'UPDATE cognition_deletion_proposals SET status = ?, decided_at = ? WHERE id = ? AND status = \'pending\'',
          action === 'approve_delete' ? 'approved' : 'rejected', stamp, pid
        );
        if (!Number(changed?.changes)) throw new Error('提案状态已变化，未执行删除');
        if (action === 'approve_delete') {
          deleted = Number(this.db.run('DELETE FROM cognition_experiences WHERE id = ?', String(row.target_id))?.changes) || 0;
        }
      });
    } catch (error) {
      this.logger(`提案审批失败（已回滚）：${error?.message ?? error}`);
      return { ok: false, error: `审批失败，已回滚：${error?.message ?? error}` };
    }
    if (this.auditFile) {
      try {
        appendAudit(this.auditFile, [auditLine({ at: stamp, run: String(runId ?? ''), action, id: pid })]);
      } catch (error) {
        this.logger(`提案审批审计写入失败（忽略）：${error?.message ?? error}`);
      }
    }
    return { ok: true, id: pid, status: action === 'approve_delete' ? 'approved' : 'rejected', deleted };
  }

  /** 观察条目（只读）。表没建时返回空列表。 */
  listObservations({ limit = 20 } = {}) {
    if (!tableExists(this.db, 'cognition_observations')) return [];
    return this.db.all(
      `SELECT id, obs_key, person_id, topic, summary, quote, proof_count, source_episode_ids,
              refines_id, visibility, created_at
       FROM cognition_observations ORDER BY created_at DESC, id ASC LIMIT ?`,
      Math.min(100, Math.max(1, Number(limit) || 20))
    );
  }
}

/** 表是否已建立：只查 sqlite_master，不创建任何东西，用于“关闭态不留痕迹”的断言。 */
export function sleepSchemaExists(db) {
  try {
    const names = db.all("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => String(r.name));
    return names.includes('cognition_observations') || names.includes('cognition_deletion_proposals');
  } catch {
    return false;
  }
}