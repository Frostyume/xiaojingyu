// 共同经历（experience）：一段被压缩过的互动摘要，只存摘要不存原文。
//
// 纯函数负责规范化、去重键、类型归类与有效强度；ExperienceStore 只负责落库。
// 默认关闭：调用方在 simulation.cognition.memoryStrength.enabled 不为 true 时
// 不读写强度列，也不按强度过滤/排序，行为与旧版按时间排序一致。
//
// 表在第一次真正读写时才建（ensureSchema），所以七个认知开关全关时
// 数据库里不会多出任何表或列。

import crypto from 'node:crypto';

const DAY_MS = 24 * 3600 * 1000;

export const EXPERIENCE_LIMITS = Object.freeze({
  summaryChars: 240,
  topicChars: 40,
  ttlMs: 180 * DAY_MS,
  bucketMs: 6 * 3600 * 1000
});

/** 记忆强度：初始 0.5，被重提 +0.15，低于 0.15 视为弱记忆。 */
export const EXPERIENCE_STRENGTH = Object.freeze({
  initial: 0.5,
  recallBoost: 0.15,
  minEffective: 0.15
});

/** 类型半衰期：普通聊天 3 天；里程碑/冲突/安慰 30 天；其余 7 天。 */
export const EXPERIENCE_HALF_LIFE_MS = Object.freeze({
  chat: 3 * DAY_MS,
  milestone: 30 * DAY_MS,
  conflict: 30 * DAY_MS,
  comfort: 30 * DAY_MS,
  other: 7 * DAY_MS
});

export const EXPERIENCE_VALENCE = Object.freeze(['positive', 'neutral', 'negative', 'mixed']);
export const EXPERIENCE_ENERGY = Object.freeze(['low', 'medium', 'high']);

function cleanText(value, max) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function sha1(value) {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex');
}

export function experienceKind(experience = {}) {
  const hint = String(experience?.kind ?? experience?.type ?? '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EXPERIENCE_HALF_LIFE_MS, hint)) return hint;
  if (experience?.outcome === 'resolved') return 'milestone';
  if (experience?.valence === 'negative') return 'conflict';
  const text = `${experience?.topic ?? ''} ${experience?.summary ?? ''}`;
  if (text.includes('安慰')) return 'comfort';
  if (experience?.topic === '心情' || experience?.topic === '关系') return 'chat';
  return 'other';
}

export function experienceHalfLifeMs(experience = {}) {
  return EXPERIENCE_HALF_LIFE_MS[experienceKind(experience)];
}

/** effective = clamp(strength * 0.5^(age/halfLife), 0, 1)，age 从 occurredAt 起算。 */
export function effectiveExperienceStrength(experience = {}, { now = Date.now() } = {}) {
  const strength = Number(experience?.strength);
  const base = Number.isFinite(strength) ? strength : EXPERIENCE_STRENGTH.initial;
  const occurredAt = Number(experience?.occurredAt ?? experience?.occurred_at);
  if (!Number.isFinite(occurredAt)) return Math.min(1, Math.max(0, base));
  const ageMs = Math.max(0, Number(now) - occurredAt);
  const value = base * (0.5 ** (ageMs / experienceHalfLifeMs(experience)));
  return Math.min(1, Math.max(0, value));
}

export function buildExperience(input = {}, { now = Date.now(), bucketMs = EXPERIENCE_LIMITS.bucketMs, ttlMs = EXPERIENCE_LIMITS.ttlMs } = {}) {
  const summary = cleanText(input.summary, EXPERIENCE_LIMITS.summaryChars);
  if (!summary) return null;
  const occurredAt = Number(input.occurredAt ?? input.occurred_at) || Number(now) || Date.now();
  const scopeKey = cleanText(input.scopeKey ?? input.scope_key ?? input.groupKey, 80) || null;
  const topic = cleanText(input.topic, EXPERIENCE_LIMITS.topicChars) || null;
  let dedupeKey;
  if (input.dedupeKey) {
    const manual = cleanText(input.dedupeKey, 120);
    dedupeKey = manual.startsWith('manual:') ? manual : `manual:${manual}`;
  } else {
    const bucket = Math.floor(occurredAt / Math.max(60 * 1000, Number(bucketMs) || EXPERIENCE_LIMITS.bucketMs));
    dedupeKey = `summary:${sha1([scopeKey ?? '', topic ?? '', summary, bucket].join('\u0000'))}`;
  }
  const expiresAt = input.expiresAt !== undefined
    ? (input.expiresAt === null ? null : Number(input.expiresAt) || null)
    : (ttlMs === null ? null : occurredAt + Number(ttlMs));
  return {
    id: `exp:${sha1(dedupeKey).slice(0, 24)}`,
    occurredAt,
    scopeKey,
    topic,
    summary,
    valence: EXPERIENCE_VALENCE.includes(input.valence) ? input.valence : null,
    energy: EXPERIENCE_ENERGY.includes(input.energy) ? input.energy : null,
    outcome: cleanText(input.outcome, 40) || null,
    dedupeKey,
    expiresAt,
    createdAt: Number(now) || Date.now()
  };
}

function rowToExperience(row) {
  if (!row) return null;
  return {
    id: row.id,
    occurredAt: Number(row.occurred_at),
    scopeKey: row.scope_key ?? null,
    topic: row.topic ?? null,
    summary: row.summary,
    valence: row.valence ?? null,
    energy: row.energy ?? null,
    outcome: row.outcome ?? null,
    strength: row.strength === null || row.strength === undefined ? EXPERIENCE_STRENGTH.initial : Number(row.strength),
    recallCount: Number(row.recall_count) || 0,
    lastRecalledAt: row.last_recalled_at === null || row.last_recalled_at === undefined ? null : Number(row.last_recalled_at),
    observedAt: row.observed_at === null || row.observed_at === undefined ? null : Number(row.observed_at),
    dedupeKey: row.dedupe_key,
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    createdAt: Number(row.created_at)
  };
}

/** 可重入 DDL：只建表/索引，不删不改既有数据。 */
export function ensureExperienceSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS cognition_experiences (
      id              TEXT PRIMARY KEY,
      occurred_at     INTEGER NOT NULL,
      scope_key       TEXT,
      topic           TEXT,
      summary         TEXT NOT NULL,
      valence         TEXT,
      energy          TEXT,
      outcome         TEXT,
      strength        REAL NOT NULL DEFAULT 0.5,
      recall_count    INTEGER NOT NULL DEFAULT 0,
      last_recalled_at INTEGER,
      observed_at     INTEGER,
      dedupe_key      TEXT NOT NULL,
      expires_at      INTEGER,
      created_at      INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cog_exp_dedupe ON cognition_experiences(dedupe_key);
    CREATE INDEX IF NOT EXISTS idx_cog_exp_scope ON cognition_experiences(scope_key, occurred_at);
  `);
  return true;
}

export function experienceSchemaExists(db) {
  try {
    return Boolean(db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cognition_experiences'"));
  } catch {
    return false;
  }
}

export class ExperienceStore {
  constructor({ db, now = () => Date.now(), logger = () => {}, strength = null, minEffective = EXPERIENCE_STRENGTH.minEffective } = {}) {
    if (!db) throw new Error('ExperienceStore 需要 db');
    this.db = db;
    this.now = now;
    this.logger = logger;
    this.strengthEnabled = strength === true || strength?.enabled === true;
    this.minEffective = Math.min(1, Math.max(0, Number(minEffective) || EXPERIENCE_STRENGTH.minEffective));
    this._schemaReady = false;
  }

  _ensure() {
    if (this._schemaReady) return;
    ensureExperienceSchema(this.db);
    this._schemaReady = true;
  }

  _reinforceRow(id, at) {
    this.db.run(
      `UPDATE cognition_experiences SET
         strength = MIN(1, COALESCE(strength, ?) + ?),
         recall_count = recall_count + 1,
         last_recalled_at = ?
       WHERE id = ?`,
      EXPERIENCE_STRENGTH.initial, EXPERIENCE_STRENGTH.recallBoost, at, id
    );
  }

  record(input = {}, options = {}) {
    const built = buildExperience(input, { now: this.now(), ...options });
    if (!built) return { experience: null, created: false, reason: 'empty_summary' };
    this._ensure();
    return this.db.transaction(() => {
      const existing = this.db.get('SELECT * FROM cognition_experiences WHERE dedupe_key = ?', built.dedupeKey);
      if (existing) {
        // 同去重键再次出现＝被重提；只在开关开启时加亮，关闭时完全走旧路径。
        if (this.strengthEnabled) this._reinforceRow(existing.id, this.now());
        return {
          experience: rowToExperience(this.db.get('SELECT * FROM cognition_experiences WHERE id = ?', existing.id)),
          created: false,
          reason: 'duplicate',
          ...(this.strengthEnabled ? { reinforced: true } : {})
        };
      }
      this.db.run(
        `INSERT INTO cognition_experiences(
           id, occurred_at, scope_key, topic, summary, valence, energy, outcome,
           strength, recall_count, last_recalled_at, observed_at, dedupe_key, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, NULL, ?, ?, ?)`,
        built.id, built.occurredAt, built.scopeKey, built.topic, built.summary,
        built.valence, built.energy, built.outcome,
        EXPERIENCE_STRENGTH.initial,
        built.dedupeKey, built.expiresAt, built.createdAt
      );
      return { experience: rowToExperience(this.db.get('SELECT * FROM cognition_experiences WHERE id = ?', built.id)), created: true };
    });
  }

  list({
    scopeKey = null,
    topic = null,
    since = null,
    until = null,
    now = this.now(),
    limit = 20,
    includeExpired = false,
    includeWeak = false
  } = {}) {
    if (!experienceSchemaExists(this.db)) return [];
    const maxItems = Math.min(200, Math.max(1, Number(limit) || 20));
    const where = [];
    const params = [];
    if (!includeExpired) {
      where.push('(expires_at IS NULL OR expires_at > ?)');
      params.push(now);
    }
    if (scopeKey) { where.push('scope_key = ?'); params.push(String(scopeKey)); }
    if (topic) { where.push('topic = ?'); params.push(String(topic).slice(0, 40)); }
    if (since) { where.push('occurred_at >= ?'); params.push(Number(since)); }
    if (until) { where.push('occurred_at <= ?'); params.push(Number(until)); }
    const sql = `SELECT * FROM cognition_experiences${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, created_at DESC LIMIT ?`;
    // 强度排序可能把较早但更亮的记忆顶上来，开启时多取一批候选。
    params.push(this.strengthEnabled ? Math.min(500, Math.max(100, maxItems * 10)) : Math.min(200, Math.max(maxItems, maxItems * 3)));
    const rows = this.db.all(sql, ...params);
    const out = [];
    for (const row of rows) {
      const experience = rowToExperience(row);
      if (this.strengthEnabled) {
        experience.effectiveStrength = effectiveExperienceStrength(experience, { now });
        if (!includeWeak && experience.effectiveStrength < this.minEffective) continue;
      }
      out.push(experience);
    }
    if (this.strengthEnabled) {
      out.sort((a, b) => (b.effectiveStrength - a.effectiveStrength)
        || (b.occurredAt - a.occurredAt)
        || (b.createdAt - a.createdAt));
    }
    return out.slice(0, maxItems);
  }

  reinforce(ref = {}, { at = this.now() } = {}) {
    if (!this.strengthEnabled) return { updated: 0, experiences: [] };
    if (!experienceSchemaExists(this.db)) return { updated: 0, experiences: [] };
    const now = Number(at) || this.now();
    const where = [];
    const params = [];
    const id = typeof ref === 'string' ? ref : ref?.id;
    if (id) {
      where.push('id = ?');
      params.push(String(id));
    } else if (ref?.dedupeKey) {
      where.push('dedupe_key = ?');
      params.push(String(ref.dedupeKey));
    } else if (ref?.topic) {
      where.push('topic = ?');
      params.push(String(ref.topic));
      if (ref.scopeKey) { where.push('scope_key = ?'); params.push(String(ref.scopeKey)); }
    } else {
      return { updated: 0, experiences: [] };
    }
    const rows = this.db.all(
      `SELECT id FROM cognition_experiences WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC LIMIT 50`,
      ...params
    );
    this.db.transaction(() => {
      for (const row of rows) this._reinforceRow(row.id, now);
    });
    return { updated: rows.length, experiences: rows.map((row) => this.get(row.id)) };
  }

  get(id) {
    if (!experienceSchemaExists(this.db)) return null;
    return rowToExperience(this.db.get('SELECT * FROM cognition_experiences WHERE id = ?', String(id ?? '')));
  }

  expire({ now = this.now() } = {}) {
    if (!experienceSchemaExists(this.db)) return 0;
    // 强度模式把“过期”降级为“变淡”：保留行，只靠有效强度过滤。
    if (this.strengthEnabled) return 0;
    const result = this.db.run(
      'DELETE FROM cognition_experiences WHERE expires_at IS NOT NULL AND expires_at <= ?',
      now
    );
    return Number(result.changes) || 0;
  }

  stats() {
    if (!experienceSchemaExists(this.db)) return { total: 0, weak: 0 };
    const total = Number(this.db.get('SELECT COUNT(*) AS n FROM cognition_experiences')?.n ?? 0);
    return { total, weak: this.strengthEnabled ? this.list({ limit: 200, includeWeak: true }).filter((x) => x.effectiveStrength < this.minEffective).length : 0 };
  }
}