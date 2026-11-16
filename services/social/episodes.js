// 事件记忆（episode）：把一次有意义的共同经历压成一行摘要，只存摘要不存原文。
//
// 写入是纯函数：buildEpisode() 负责规范化、去重键和过期时间；EpisodeStore 只负责落库。
// 巩固（consolidate）把 episode 变成人物画像/关系边/可选的外部事实，可重入、可关闭。
//
// 生成入口：
//   · episodeFromMoodEvent        心情事件
//   · episodeFromRelationshipEvent 关系记账事件
//   · episodeFromCommitment       承诺/未闭环事项
//   · episodeFromExplicit         显式调用
// 所有入口都不直接 import bridge / relationship-model，调用方传结构化事件即可。

import crypto from 'node:crypto';
import { ensureSocialSchema } from './social-schema.js';

export const EPISODE_LIMITS = Object.freeze({
  summaryChars: 240,
  topicChars: 40,
  outcomeChars: 40,
  participants: 12,
  memoryFacts: 20,
  ttlMs: 180 * 24 * 3600 * 1000,
  bucketMs: 6 * 3600 * 1000
});

/**
 * 同场窗口：事件前后这段时间里、同一会话中被识别到的发言人算“在场”。
 * 只用来补全 episode 参与者，不参与任何频次判定。
 */
export const EPISODE_SCENE_WINDOW_MS = 10 * 60 * 1000;

export const EPISODE_VALENCE = Object.freeze(['positive', 'neutral', 'negative', 'mixed']);
export const EPISODE_ENERGY = Object.freeze(['low', 'medium', 'high']);
export const EPISODE_VISIBILITY = Object.freeze(['public', 'group', 'owner', 'session']);

const DAY_MS = 24 * 3600 * 1000;

/** 记忆强度（借鉴 MemoryBank）：默认关闭，关闭时 list() 与旧行为一致。 */
export const EPISODE_STRENGTH = Object.freeze({
  initial: 0.5,
  recallBoost: 0.15,
  minEffective: 0.15
});

/** 类型半衰期：普通聊天 3 天；里程碑/冲突/安慰 30 天；其余 7 天。 */
export const EPISODE_HALF_LIFE_MS = Object.freeze({
  chat: 3 * DAY_MS,
  milestone: 30 * DAY_MS,
  conflict: 30 * DAY_MS,
  comfort: 30 * DAY_MS,
  other: 7 * DAY_MS
});

/**
 * episode 没有持久化 type 列；按现有字段做确定性归类。
 * 调用方也可显式传 kind/type（仅内存态，用于纯函数计算）。
 */
export function episodeKind(episode = {}) {
  const hint = String(episode?.kind ?? episode?.type ?? '').toLowerCase();
  if (Object.prototype.hasOwnProperty.call(EPISODE_HALF_LIFE_MS, hint)) return hint;
  if (episode?.outcome === 'resolved') return 'milestone';
  if (episode?.valence === 'negative') return 'conflict';
  const text = `${episode?.topic ?? ''} ${episode?.summary ?? ''}`;
  if (text.includes('安慰')) return 'comfort';
  if (episode?.topic === '心情' || episode?.topic === '关系') return 'chat';
  return 'other';
}

export function episodeHalfLifeMs(episode = {}) {
  return EPISODE_HALF_LIFE_MS[episodeKind(episode)];
}

/**
 * effective = clamp(strength * 0.5^(age/halfLife), 0, 1)，age 从 occurred_at 起算。
 */
export function episodeEffectiveStrength(episode = {}, { now = Date.now() } = {}) {
  const strength = Number(episode?.strength);
  const base = Number.isFinite(strength) ? strength : EPISODE_STRENGTH.initial;
  const occurredAt = Number(episode?.occurredAt ?? episode?.occurred_at);
  if (!Number.isFinite(occurredAt)) return Math.min(1, Math.max(0, base));
  const ageMs = Math.max(0, Number(now) - occurredAt);
  const value = base * (0.5 ** (ageMs / episodeHalfLifeMs(episode)));
  return Math.min(1, Math.max(0, value));
}

/** 给 episode 行补齐强度列；可重入，旧库启动时自动加列。 */
export function ensureEpisodeStrengthSchema(db) {
  const columns = db.all('PRAGMA table_info(episodes)').map((c) => String(c.name));
  if (!columns.length) return false;
  if (!columns.includes('strength')) {
    db.exec(`ALTER TABLE episodes ADD COLUMN strength REAL NOT NULL DEFAULT ${EPISODE_STRENGTH.initial}`);
  }
  if (!columns.includes('last_recalled_at')) db.exec('ALTER TABLE episodes ADD COLUMN last_recalled_at INTEGER');
  if (!columns.includes('recall_count')) db.exec('ALTER TABLE episodes ADD COLUMN recall_count INTEGER NOT NULL DEFAULT 0');
  return true;
}

export function normalizeEpisodeVisibility(value, fallback = 'public') {
  const raw = String(value ?? '').trim().toLowerCase();
  return EPISODE_VISIBILITY.includes(raw) ? raw : fallback;
}

/**
 * episode 可见性：
 *   public  任意会话
 *   group   只在本群或主人私聊
 *   owner   只在主人私聊
 *   session 只在这个私聊/会话本身（私聊共同经历用）
 */
export function canViewEpisode(episode, viewer) {
  if (!episode) return false;
  const vis = normalizeEpisodeVisibility(episode.visibility);
  if (vis === 'public') return true;
  if (!viewer) return false;
  const sessionKey = String(viewer.sessionKey ?? viewer.chatKey ?? '');
  const isOwnerSession = viewer.isOwnerSession === true;
  if (vis === 'owner') return isOwnerSession;
  if (vis === 'group') {
    if (isOwnerSession) return true;
    return sessionKey.startsWith('group:') && (!episode.groupKey || episode.groupKey === sessionKey);
  }
  if (vis === 'session') {
    if (isOwnerSession) return true;
    return Boolean(sessionKey) && episode.groupKey === sessionKey;
  }
  return false;
}

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

function parseArray(text) {
  if (!text) return [];
  try {
    const value = JSON.parse(text);
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

function normalizeParticipant(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const personId = cleanText(raw.personId ?? raw.person_id, 120);
  const userId = cleanText(raw.userId ?? raw.user_id, 40);
  const name = cleanText(raw.name ?? raw.sender, 40);
  if (!personId && !userId && !name) return null;
  const role = ['speaker', 'target', 'witness', 'bystander', 'other'].includes(raw.role) ? raw.role : 'speaker';
  return {
    ...(personId ? { personId } : {}),
    ...(userId ? { userId } : {}),
    ...(name ? { name } : {}),
    role
  };
}

function participantKey(item) {
  return item.personId || (item.userId ? `qq:${item.userId}` : `name:${item.name}`);
}

function normalizeParticipants(participants) {
  const list = Array.isArray(participants) ? participants : (participants ? [participants] : []);
  const out = [];
  const seen = new Set();
  for (const raw of list) {
    const item = normalizeParticipant(raw);
    if (!item) continue;
    const key = participantKey(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
    if (out.length >= EPISODE_LIMITS.participants) break;
  }
  return out;
}

function normalizeIds(ids) {
  const list = Array.isArray(ids) ? ids : (ids === null || ids === undefined ? [] : [ids]);
  const out = [];
  const seen = new Set();
  for (const id of list) {
    const value = typeof id === 'number' ? id : cleanText(id, 120);
    if (value === '' || value === null || value === undefined) continue;
    if (seen.has(String(value))) continue;
    seen.add(String(value));
    out.push(value);
    if (out.length >= EPISODE_LIMITS.memoryFacts) break;
  }
  return out;
}

/**
 * @param {object} input
 * @param {number} [input.occurredAt]
 * @param {string} [input.groupKey]
 * @param {string} [input.topic]
 * @param {string} input.summary
 * @param {Array} [input.participants]
 * @param {'positive'|'neutral'|'negative'|'mixed'} [input.valence]
 * @param {'low'|'medium'|'high'} [input.energy]
 * @param {string} [input.outcome]
 * @param {string} [input.sourceEventId]
 * @param {number[]} [input.memoryFactIds]
 * @param {string} [input.visibility]
 * @param {number|null} [input.expiresAt]
 * @param {string} [input.dedupeKey]
 */
export function buildEpisode(input = {}, { now = Date.now(), bucketMs = EPISODE_LIMITS.bucketMs, ttlMs = EPISODE_LIMITS.ttlMs } = {}) {
  const summary = cleanText(input.summary, EPISODE_LIMITS.summaryChars);
  if (!summary) return null;
  const occurredAt = Number(input.occurredAt ?? input.occurred_at) || Number(now) || Date.now();
  const groupKey = cleanText(input.groupKey ?? input.group_key, 80) || null;
  const topic = cleanText(input.topic, EPISODE_LIMITS.topicChars) || null;
  const participants = normalizeParticipants(input.participants);
  const sourceEventId = cleanText(input.sourceEventId ?? input.source_event_id, 120) || null;
  let dedupeKey;
  if (input.dedupeKey) {
    // record() 会对已构建的 episode 再走一遍 buildEpisode；已带 manual: 前缀时不再叠加。
    const manual = cleanText(input.dedupeKey, 120);
    dedupeKey = manual.startsWith('manual:') ? manual : `manual:${manual}`;
  } else if (sourceEventId) {
    dedupeKey = `event:${sourceEventId}`;
  } else {
    const bucket = Math.floor(occurredAt / Math.max(60 * 1000, Number(bucketMs) || EPISODE_LIMITS.bucketMs));
    const signature = [
      groupKey ?? '',
      topic ?? '',
      summary,
      participants.map(participantKey).sort().join(','),
      bucket
    ].join('\u0000');
    dedupeKey = `summary:${sha1(signature)}`;
  }
  const expiresAt = input.expiresAt !== undefined
    ? (input.expiresAt === null ? null : Number(input.expiresAt) || null)
    : (ttlMs === null ? null : occurredAt + Number(ttlMs));

  return {
    id: `episode:${sha1(dedupeKey).slice(0, 24)}`,
    occurredAt,
    groupKey,
    topic,
    summary,
    participants,
    valence: EPISODE_VALENCE.includes(input.valence) ? input.valence : null,
    energy: EPISODE_ENERGY.includes(input.energy) ? input.energy : null,
    outcome: cleanText(input.outcome, EPISODE_LIMITS.outcomeChars) || null,
    sourceEventId,
    memoryFactIds: normalizeIds(input.memoryFactIds),
    dedupeKey,
    visibility: normalizeEpisodeVisibility(input.visibility, 'public'),
    expiresAt,
    createdAt: Number(now) || Date.now()
  };
}

function rowToEpisode(row) {
  if (!row) return null;
  return {
    id: row.id,
    occurredAt: Number(row.occurred_at),
    groupKey: row.group_key ?? null,
    topic: row.topic ?? null,
    summary: row.summary,
    participants: parseArray(row.participants_json),
    valence: row.valence ?? null,
    energy: row.energy ?? null,
    outcome: row.outcome ?? null,
    sourceEventId: row.source_event_id ?? null,
    memoryFactIds: parseArray(row.memory_fact_ids),
    visibility: normalizeEpisodeVisibility(row.visibility),
    expiresAt: row.expires_at === null || row.expires_at === undefined ? null : Number(row.expires_at),
    consolidatedAt: row.consolidated_at === null || row.consolidated_at === undefined ? null : Number(row.consolidated_at),
    strength: row.strength === null || row.strength === undefined ? EPISODE_STRENGTH.initial : Number(row.strength),
    lastRecalledAt: row.last_recalled_at === null || row.last_recalled_at === undefined ? null : Number(row.last_recalled_at),
    recallCount: Number(row.recall_count) || 0,
    createdAt: Number(row.created_at)
  };
}

export class EpisodeStore {
  constructor({ db, now = () => Date.now(), logger = () => {}, socialGraph = null, graph = null, memoryStrength = false } = {}) {
    ensureSocialSchema(db);
    if (!db) throw new Error('EpisodeStore 需要 db');
    this.db = db;
    this.now = now;
    this.logger = logger;
    this.graph = socialGraph || graph || null;
    this.memoryStrengthEnabled = memoryStrength === true || memoryStrength?.enabled === true;
    ensureEpisodeStrengthSchema(db);
  }

  _linkParticipants(episodeId, participants) {
    let linked = 0;
    for (const participant of participants) {
      if (!participant?.personId) continue;
      const result = this.db.run(
        'INSERT OR IGNORE INTO episode_participants(episode_id, person_id, role) VALUES (?, ?, ?)',
        episodeId, participant.personId, participant.role || 'speaker'
      );
      linked += Number(result.changes) || 0;
    }
    return linked;
  }

  _reinforceRow(id, at) {
    this.db.run(
      `UPDATE episodes SET
         strength = MIN(1, COALESCE(strength, ?) + ?),
         recall_count = recall_count + 1,
         last_recalled_at = ?
       WHERE id = ?`,
      EPISODE_STRENGTH.initial, EPISODE_STRENGTH.recallBoost, at, id
    );
  }

  record(input = {}, options = {}) {
    const built = buildEpisode(input, { now: this.now(), ...options });
    if (!built) return { episode: null, created: false, reason: 'empty_summary' };
    return this.db.transaction(() => {
      const existing = this.db.get('SELECT * FROM episodes WHERE dedupe_key = ?', built.dedupeKey);
      if (existing) {
        this._linkParticipants(existing.id, built.participants);
        // 同去重键再次出现＝被重提；只在开关开启时加亮，关闭时完全走旧路径。
        if (this.memoryStrengthEnabled) this._reinforceRow(existing.id, this.now());
        return {
          episode: rowToEpisode(this.db.get('SELECT * FROM episodes WHERE id = ?', existing.id)),
          created: false,
          reason: 'duplicate',
          ...(this.memoryStrengthEnabled ? { reinforced: true } : {})
        };
      }
      this.db.run(
        `INSERT INTO episodes(id, occurred_at, group_key, topic, summary, participants_json, valence, energy, outcome,
           source_event_id, memory_fact_ids, dedupe_key, visibility, expires_at, consolidated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?)`,
        built.id, built.occurredAt, built.groupKey, built.topic, built.summary,
        JSON.stringify(built.participants), built.valence, built.energy, built.outcome,
        built.sourceEventId, JSON.stringify(built.memoryFactIds), built.dedupeKey,
        built.visibility, built.expiresAt, built.createdAt
      );
      this._linkParticipants(built.id, built.participants);
      return { episode: rowToEpisode(this.db.get('SELECT * FROM episodes WHERE id = ?', built.id)), created: true };
    });
  }

  recordMany(inputs, options = {}) {
    const out = [];
    for (const input of Array.isArray(inputs) ? inputs : []) out.push(this.record(input, options));
    return out;
  }

  list({
    groupKey = null,
    personId = null,
    personIds = null,
    topic = null,
    since = null,
    until = null,
    viewer = undefined,
    now = this.now(),
    limit = 10,
    includeExpired = false,
    includeWeak = false
  } = {}) {
    const maxItems = Math.min(50, Math.max(1, Number(limit) || 10));
    const where = [];
    const params = [];
    if (!includeExpired) {
      where.push('(expires_at IS NULL OR expires_at > ?)');
      params.push(now);
    }
    if (groupKey) {
      where.push('group_key = ?');
      params.push(String(groupKey));
    }
    if (since) { where.push('occurred_at >= ?'); params.push(Number(since)); }
    if (until) { where.push('occurred_at <= ?'); params.push(Number(until)); }
    if (topic) {
      where.push('topic LIKE ?');
      params.push(`%${String(topic).slice(0, 40)}%`);
    }
    const ids = [...new Set(
      (personIds ?? (personId ? [personId] : []))
        .map((id) => String(id ?? '').trim())
        .filter(Boolean)
    )];
    if (ids.length) {
      where.push(`EXISTS (SELECT 1 FROM episode_participants ep
        WHERE ep.episode_id = episodes.id AND ep.person_id IN (${ids.map(() => '?').join(',')}))`);
      params.push(...ids);
    }
    const sql = `SELECT * FROM episodes${where.length ? ` WHERE ${where.join(' AND ')}` : ''}
      ORDER BY occurred_at DESC, created_at DESC LIMIT ?`;
    // 强度排序可能把较早但更亮的记忆顶上来，开启时多取一批候选。
    params.push(this.memoryStrengthEnabled
      ? Math.min(500, Math.max(100, Number(limit) * 10 || 100))
      : Math.min(100, Math.max(1, Number(limit) * 3 || 30)));
    const rows = this.db.all(sql, ...params);
    const out = [];
    for (const row of rows) {
      const episode = rowToEpisode(row);
      if (viewer !== undefined && !canViewEpisode(episode, viewer)) continue;
      if (this.memoryStrengthEnabled) {
        episode.effectiveStrength = episodeEffectiveStrength(episode, { now });
        // 弱记忆默认不进上下文，但仍可 includeWeak 诊断；行本身从不删除。
        if (!includeWeak && episode.effectiveStrength < EPISODE_STRENGTH.minEffective) continue;
      }
      out.push(episode);
    }
    if (this.memoryStrengthEnabled) {
      out.sort((a, b) => (b.effectiveStrength - a.effectiveStrength)
        || (b.occurredAt - a.occurredAt)
        || (b.createdAt - a.createdAt));
    }
    return out.slice(0, maxItems);
  }

  /**
   * 独立强化入口：检索命中/主人重提时调用，避免诊断性 list() 顺带加亮。
   * ref 支持 { id } / { dedupeKey } / { topic, groupKey }（同 topic 精确匹配）。
   */
  reinforce(ref = {}, { at = this.now() } = {}) {
    if (!this.memoryStrengthEnabled) return { updated: 0, episodes: [] };
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
      if (ref.groupKey) {
        where.push('group_key = ?');
        params.push(String(ref.groupKey));
      }
    } else {
      return { updated: 0, episodes: [] };
    }
    const rows = this.db.all(
      `SELECT id FROM episodes WHERE ${where.join(' AND ')} ORDER BY occurred_at DESC LIMIT 50`,
      ...params
    );
    this.db.transaction(() => {
      for (const row of rows) this._reinforceRow(row.id, now);
    });
    return { updated: rows.length, episodes: rows.map((row) => this.get(row.id)) };
  }

  get(id) {
    return rowToEpisode(this.db.get('SELECT * FROM episodes WHERE id = ?', String(id ?? '')));
  }

  expire({ now = this.now() } = {}) {
    // 强度模式把“过期”降级为“变淡”：保留行，只靠有效强度过滤。
    if (this.memoryStrengthEnabled) return 0;
    const result = this.db.run(
      'DELETE FROM episodes WHERE expires_at IS NOT NULL AND expires_at <= ?',
      now
    );
    return Number(result.changes) || 0;
  }

  /**
   * episode → 画像/边/事实。
   *   · 不传 graph 时只做外部事实回调；
   *   · 同一 episode 只会被巩固一次（consolidated_at 标记），重跑返回 processed:0；
   *   · 单条失败不标记，留待下次重试，不阻塞其它 episode。
   */
  consolidate({
    now = this.now(),
    limit = 200,
    enabled = true,
    dryRun = false,
    onFact = null,
    graph = null
  } = {}) {
    const result = { done: true, processed: 0, facts: 0, profiles: 0, edges: 0, skipped: 0 };
    if (!enabled) return { ...result, done: false, reason: 'disabled' };
    const sink = graph || this.graph;
    const rows = this.db.all(
      `SELECT * FROM episodes
       WHERE consolidated_at IS NULL AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY occurred_at ASC LIMIT ?`,
      now, Math.min(1000, Math.max(1, Number(limit) || 200))
    );
    for (const row of rows) {
      const episode = rowToEpisode(row);
      const participants = episode.participants.filter((p) => p.personId)
        .filter((p) => this.db.get('SELECT 1 AS ok FROM persons WHERE id = ?', p.personId));
      const factIds = [...episode.memoryFactIds];
      try {
        if (typeof onFact === 'function') {
          for (const personId of [...new Set(participants.map((p) => p.personId))]) {
            const out = onFact({
              episode,
              personId,
              summary: episode.summary,
              topic: episode.topic,
              occurredAt: episode.occurredAt,
              valence: episode.valence,
              outcome: episode.outcome,
              visibility: episode.visibility
            });
            for (const value of [out].flat()) {
              if (value === null || value === undefined) continue;
              const id = typeof value === 'object' ? (value.id ?? value.factId) : value;
              if (id === null || id === undefined || factIds.includes(id)) continue;
              factIds.push(id);
              result.facts += 1;
            }
          }
        }
        if (sink) {
          // 画像/边只支持 public/group/owner：私聊 episode 的细节按 owner 处理，避免进群。
          const graphVisibility = episode.visibility === 'group' ? 'group'
            : (episode.visibility === 'public' ? 'public' : 'owner');
          for (const personId of [...new Set(participants.map((p) => p.personId))]) {
            try {
              sink.setRecentState(personId, {
                text: episode.topic ? `最近在聊${episode.topic}：${episode.summary}` : episode.summary,
                provenance: 'observed',
                visibility: graphVisibility,
                at: episode.occurredAt
              });
              result.profiles += 1;
            } catch (error) {
              if (error?.code !== 'person_not_found') throw error;
            }
          }
          const people = [...new Set(participants.map((p) => p.personId))];
          for (let i = 0; i < people.length; i += 1) {
            for (let j = i + 1; j < people.length; j += 1) {
              sink.upsertEdge({
                kind: 'person_person',
                from: { kind: 'person', id: people[i] },
                to: { kind: 'person', id: people[j] },
                weight: 0.35,
                confidence: 0.55,
                evidence: { type: 'episode', id: episode.id },
                visibility: graphVisibility,
                at: episode.occurredAt
              });
              result.edges += 1;
            }
          }
        }
        if (!dryRun) {
          this.db.run(
            'UPDATE episodes SET consolidated_at = ?, memory_fact_ids = ? WHERE id = ?',
            now, JSON.stringify(normalizeIds(factIds)), episode.id
          );
        }
        result.processed += 1;
      } catch (error) {
        result.skipped += 1;
        this.logger(`episode 巩固失败（下次重试）：${error?.message ?? error}`);
      }
    }
    return result;
  }

  stats() {
    const count = (sql, ...params) => Number(this.db.get(sql, ...params)?.n ?? 0);
    return {
      total: count('SELECT COUNT(*) AS n FROM episodes'),
      unconsolidated: count('SELECT COUNT(*) AS n FROM episodes WHERE consolidated_at IS NULL'),
      expired: count('SELECT COUNT(*) AS n FROM episodes WHERE expires_at IS NOT NULL AND expires_at <= ?', this.now()),
      participants: count('SELECT COUNT(*) AS n FROM episode_participants')
    };
  }
}

/** 心情事件 → episode。不引用消息原文，只写事件类型和心情方向。 */
export function episodeFromMoodEvent(event = {}, context = {}, options = {}) {
  if (!event || typeof event !== 'object') return null;
  const valence = EPISODE_VALENCE.includes(event.valence) ? event.valence : 'neutral';
  const cause = cleanText(event.cause || event.what || '心情变化', 30);
  return buildEpisode({
    occurredAt: Number(event.receivedAt) || Number(context.at) || undefined,
    groupKey: context.groupKey,
    topic: context.topic || '心情',
    summary: `被${cause}，心情${valence === 'positive' ? '变好' : (valence === 'negative' ? '变差' : '有波动')}`,
    participants: context.participants,
    valence,
    energy: event.arousal === 'up' ? 'high' : (event.arousal === 'down' ? 'low' : null),
    outcome: 'closed',
    sourceEventId: event.sourceMessageId || event.source_event_id || null,
    visibility: context.visibility
  }, options);
}

const RELATION_LABELS = Object.freeze({
  praise: '被夸了',
  comfort: '得到了安慰',
  apology: '互相道了歉',
  insult: '被说了重话',
  hostile: '起了冲突',
  tease: '互相调侃了',
  ignore: '感觉被冷落',
  cold: '气氛冷了下来'
});

/** 关系记账事件 → episode。 */
export function episodeFromRelationshipEvent(event = {}, context = {}, options = {}) {
  if (!event || typeof event !== 'object') return null;
  const name = cleanText(context.participantName || context.name || '群友', 24);
  const label = RELATION_LABELS[event.type] || cleanText(event.reason, 30) || '有互动';
  const delta = Number(event.affection_delta ?? event.affectionDelta ?? 0) + Number(event.trust_delta ?? event.trustDelta ?? 0);
  const valence = delta > 0 ? 'positive' : (delta < 0 ? 'negative' : 'neutral');
  return buildEpisode({
    occurredAt: Number(event.created_at ?? event.createdAt) || Number(context.at) || undefined,
    groupKey: context.groupKey,
    topic: context.topic || '关系',
    summary: `${name}${label}`,
    participants: context.participants,
    valence,
    outcome: 'closed',
    sourceEventId: event.dedupe_key || event.dedupeKey || event.source_message_id || null,
    visibility: context.visibility
  }, options);
}

const COMMITMENT_OUTCOME = Object.freeze({
  done: 'resolved',
  cancelled: 'abandoned',
  expired: 'abandoned',
  failed: 'abandoned'
});

/** 承诺/未闭环事项 → episode。 */
export function episodeFromCommitment(commitment = {}, context = {}, options = {}) {
  if (!commitment || typeof commitment !== 'object') return null;
  const goal = cleanText(commitment.goal || commitment.title || commitment.text, 60);
  if (!goal) return null;
  const status = String(commitment.status || 'active');
  const outcome = COMMITMENT_OUTCOME[status] || 'open';
  const stage = outcome === 'resolved' ? '已完成' : (outcome === 'abandoned' ? '已取消' : '还在跟进');
  return buildEpisode({
    occurredAt: Number(commitment.updated_at ?? commitment.updatedAt ?? commitment.created_at) || Number(context.at) || undefined,
    groupKey: context.groupKey,
    topic: context.topic || '承诺',
    summary: `承诺事项「${goal}」${stage}`,
    participants: context.participants,
    valence: outcome === 'resolved' ? 'positive' : 'neutral',
    outcome,
    sourceEventId: commitment.id ? `commitment:${commitment.id}` : null,
    visibility: context.visibility
  }, options);
}

export function episodeFromExplicit(input = {}, context = {}, options = {}) {
  return buildEpisode({ ...context, ...input }, options);
}

// 对话经历的固定话题词：只做本地关键词匹配，不调模型，也不改动消息原文。
const CHAT_TOPIC_RULES = Object.freeze([
  [/(比赛|开赛|赛程|战队|冠军|决赛|总决赛|S\d+)/i, '比赛'],
  [/(游戏|开黑|上分|排位|副本|皮肤)/, '游戏'],
  [/(考试|作业|上课|学习|复习|论文)/, '学习'],
  [/(工作|加班|上班|项目|会议|老板)/, '工作'],
  [/(吃|饭|外卖|奶茶|火锅|早餐|午饭|晚饭)/, '吃饭'],
  [/(电影|电视剧|动漫|番剧|小说|看书)/, '看剧'],
  [/(歌|音乐|唱歌|演唱会)/, '音乐'],
  [/(天气|下雨|降温|好热|好冷)/, '天气'],
  [/(周末|放假|旅行|出去玩)/, '周末']
]);

export function chatEpisodeTopic(text = '') {
  const value = String(text ?? '');
  for (const [rule, label] of CHAT_TOPIC_RULES) {
    if (rule.test(value)) return label;
  }
  return '闲聊';
}

/**
 * 对话经历：一条被点名的话 + 同场其他人的事实拼接，不保留原文以外的模型加工。
 * anchor: { name, text, at }；context.presentNames 是除发言人外的在场者。
 */
export function episodeFromChatTurn(anchor = {}, context = {}, options = {}) {
  if (!anchor || typeof anchor !== 'object') return null;
  const name = cleanText(anchor.name || context.anchorName, 24) || '有人';
  const excerpt = cleanText(
    String(anchor.text ?? '')
      .replace(/\[CQ:at,[^\]]*\]/gi, ' ')
      .replace(/^@\S+\s+/, ' '),
    40
  ) || '发了一条消息';
  const present = [...new Set(
    (Array.isArray(context.presentNames) ? context.presentNames : [])
      .map((item) => cleanText(item, 24))
      .filter(Boolean)
  )].slice(0, 5);
  const truncated = Number(context.speakerCount) > present.length + 1;
  const presentText = present.length
    ? `；${present.join('、')}${truncated ? `等${context.speakerCount}人` : ''}在场`
    : '';
  return buildEpisode({
    occurredAt: Number(anchor.at) || Number(context.at) || undefined,
    groupKey: context.groupKey,
    topic: context.topic || chatEpisodeTopic(anchor.text),
    summary: `${name}对她说「${excerpt}」${presentText}`,
    participants: context.participants,
    valence: 'neutral',
    energy: 'low',
    outcome: 'closed',
    dedupeKey: context.dedupeKey,
    visibility: context.visibility
  }, options);
}
