// 群友关系 v2 存储。
//
// 四轴：好感 affection / 信任 trust / 熟悉 familiarity / 默契 rapport（0~100）。
// 每次互动写入 relationship_events；按天聚合到 relationship_daily；读取时做衰减与阶段更新。
// 主人固定；群友最高“特别的朋友”，不进入恋爱/占有语气。

import {
  BASELINE, DAY_MS, LIMITS, STAGE_HOLD_MS, axisWords, clamp, classifyMessage, computeBond,
  decayAxes, diminishingFactor, applyDailyCaps, nextStage, stageById, stageIntensity,
  stageLabel, toneDirective, EVENT_DEFS, STAGE_DOWN_HYSTERESIS
} from './relationship-model.js';
import { shanghaiDayKey } from '../kernel/budget.js';

function rowToRel(row) {
  if (!row) return null;
  return {
    key: row.key,
    userId: String(row.user_id),
    displayName: row.note || '',
    affection: Number(row.affection ?? 8),
    trust: Number(row.trust ?? 5),
    familiarity: Number(row.familiarity ?? 0),
    rapport: Number(row.rapport ?? 0),
    bond: Number(row.bond ?? 0),
    stage: Number(row.stage ?? 0),
    stageChangedAt: row.stage_changed_at === null ? null : Number(row.stage_changed_at),
    stageHoldUntil: row.stage_hold_until === null ? null : Number(row.stage_hold_until),
    interactionCount: Number(row.interaction_count ?? 0),
    lastDelta: (() => { try { return row.last_delta_json ? JSON.parse(row.last_delta_json) : null; } catch { return null; } })(),
    lastInteractionAt: row.last_interaction_at === null ? null : Number(row.last_interaction_at),
    updatedAt: row.updated_at === null ? null : Number(row.updated_at)
  };
}

function parseJson(text) {
  try { return text ? JSON.parse(text) : null; } catch { return null; }
}

// Trusted profile presentation only; this never changes owner authority or scores.
export function resolveRelationshipPresentation(presentationByUserId, userId) {
  if (!presentationByUserId || typeof presentationByUserId !== 'object'
    || Array.isArray(presentationByUserId) || !Object.hasOwn(presentationByUserId, String(userId))) return null;
  const presentation = presentationByUserId[String(userId)];
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)
    || !['address', 'label', 'tone'].every((field) => typeof presentation[field] === 'string'
      && presentation[field].trim() && presentation[field].length <= 300 && !/[\r\n]/.test(presentation[field]))) {
    throw new TypeError('Invalid trusted relationship presentation');
  }
  return presentation;
}

export class RelationshipStore {
  constructor({ db, ownerId = '', now = () => Date.now(), logger = () => {} } = {}) {
    if (!db) throw new Error('RelationshipStore 需要 db');
    this.db = db;
    this.ownerId = ownerId ? String(ownerId) : '';
    this.now = now;
    this.logger = logger;
    // 同一个人（QQ 号）在所有群/私聊共用一套关系数值；旧版本按群存的 rows 先合并一次。
    this._mergeUsers();
  }

  _defaultRow(key, userId, now) {
    return {
      key,
      userId,
      displayName: '',
      affection: BASELINE.affection,
      trust: BASELINE.trust,
      familiarity: BASELINE.familiarity,
      rapport: BASELINE.rapport,
      bond: 0,
      stage: 0,
      stageChangedAt: now,
      stageHoldUntil: now + STAGE_HOLD_MS,
      interactionCount: 0,
      lastDelta: null,
      lastInteractionAt: now,
      updatedAt: now
    };
  }

  _load(key, userId) {
    return rowToRel(this.db.get(
      'SELECT * FROM member_relationships WHERE key = ? AND user_id = ?',
      String(key), String(userId)
    ));
  }

  /** 同一 QQ 号在任意群/私聊里最强的那份关系，用作跨群继承的基准。 */
  _loadBest(userId) {
    return rowToRel(this.db.get(
      'SELECT * FROM member_relationships WHERE user_id = ? ORDER BY bond DESC, affection DESC, trust DESC, familiarity DESC, last_interaction_at DESC LIMIT 1',
      String(userId)
    ));
  }

  /** 把当前 QQ 号的关系数值同步到该 QQ 号在所有群/私聊的行；每个群的昵称/备注保留。 */
  _syncUser(row) {
    const uid = String(row.userId);
    if (!uid) return;
    this.db.run(
      `UPDATE member_relationships
       SET familiarity = ?, affinity = ?, trust = ?, affection = ?, rapport = ?, bond = ?,
           stage = ?, stage_changed_at = ?, stage_hold_until = ?, interaction_count = ?,
           last_interaction_at = ?, updated_at = ?, last_delta_json = ?
       WHERE user_id = ? AND key <> ?`,
      clamp(row.familiarity, 0, 100), clamp(row.affection, 0, 100) / 100, clamp(row.trust, 0, 100),
      clamp(row.affection, 0, 100), clamp(row.rapport, 0, 100), Number(row.bond) || 0,
      clamp(Math.round(row.stage || 0), 0, 5), row.stageChangedAt ?? row.updatedAt ?? this.now(),
      row.stageHoldUntil ?? (this.now() + STAGE_HOLD_MS), Math.max(0, Math.round(row.interactionCount || 0)),
      row.lastInteractionAt ?? row.updatedAt ?? this.now(), row.updatedAt ?? this.now(),
      row.lastDelta ? JSON.stringify(row.lastDelta) : null,
      uid, String(row.key)
    );
  }

  /**
   * 旧库是“每个群一份关系”，同一 QQ 会散落在多行。这里按用户合并成一套：
   * 四轴取各群最高值，互动次数取最高值（避免每次启动重复累加），阶段取最高；
   * 每个群的 note/昵称保留，后续读写继续同步。幂等，可反复启动。
   */
  _mergeUsers() {
    let users = [];
    try {
      users = this.db.all('SELECT DISTINCT user_id FROM member_relationships').map((r) => String(r.user_id));
    } catch { return; }
    for (const uid of users) {
      const rows = this.db.all('SELECT * FROM member_relationships WHERE user_id = ?', uid).map(rowToRel);
      if (rows.length <= 1) continue;
      const pickMax = (field) => Math.max(...rows.map((r) => Number(r[field]) || 0));
      const best = rows.slice().sort((a, b) => (b.bond - a.bond) || (b.affection - a.affection) || (b.lastInteractionAt || 0) - (a.lastInteractionAt || 0))[0];
      const axes = {
        affection: pickMax('affection'),
        trust: pickMax('trust'),
        familiarity: pickMax('familiarity'),
        rapport: pickMax('rapport')
      };
      if (this.ownerId && uid === this.ownerId) {
        axes.affection = Math.max(95, axes.affection);
        axes.trust = 100;
        axes.familiarity = 100;
        axes.rapport = Math.max(80, axes.rapport);
      }
      const bond = computeBond(axes);
      const stage = this.ownerId && uid === this.ownerId ? 5 : pickMax('stage');
      const stageChangedAt = Math.max(...rows.map((r) => Number(r.stageChangedAt) || 0));
      const stageHoldUntil = Math.max(...rows.map((r) => Number(r.stageHoldUntil) || 0));
      const interactionCount = pickMax('interactionCount');
      const lastInteractionAt = Math.max(...rows.map((r) => Number(r.lastInteractionAt) || 0));
      for (const r of rows) {
        this.db.run(
          `UPDATE member_relationships
           SET familiarity = ?, affinity = ?, trust = ?, affection = ?, rapport = ?, bond = ?,
               stage = ?, stage_changed_at = ?, stage_hold_until = ?, interaction_count = ?,
               last_interaction_at = ?, last_delta_json = ?
           WHERE key = ? AND user_id = ?`,
          axes.familiarity, axes.affection / 100, axes.trust, axes.affection, axes.rapport, bond,
          stage, stageChangedAt || this.now(), stageHoldUntil || (this.now() + STAGE_HOLD_MS), interactionCount,
          lastInteractionAt || this.now(), best?.lastDelta ? JSON.stringify(best.lastDelta) : null,
          r.key, uid
        );
      }
    }
  }

  _write(row, at = this.now()) {
    const isOwner = this.ownerId && String(row.userId) === this.ownerId;
    const stage = isOwner ? 5 : clamp(Math.round(row.stage || 0), 0, 5);
    const axes = isOwner
      ? {
        affection: clamp(row.affection ?? 95, 95, 100),
        trust: 100,
        familiarity: 100,
        rapport: clamp(row.rapport ?? 80, 80, 100)
      }
      : row;
    const bond = computeBond(axes);
    this.db.run(
      `INSERT INTO member_relationships
        (key, user_id, familiarity, affinity, trust, last_interaction_at, note, updated_at,
         affection, rapport, bond, stage, stage_changed_at, stage_hold_until, interaction_count, last_delta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key, user_id) DO UPDATE SET
         familiarity = excluded.familiarity,
         affinity = excluded.affinity,
         trust = excluded.trust,
         last_interaction_at = excluded.last_interaction_at,
         note = CASE WHEN excluded.note != '' THEN excluded.note ELSE member_relationships.note END,
         updated_at = excluded.updated_at,
         affection = excluded.affection,
         rapport = excluded.rapport,
         bond = excluded.bond,
         stage = excluded.stage,
         stage_changed_at = excluded.stage_changed_at,
         stage_hold_until = excluded.stage_hold_until,
         interaction_count = excluded.interaction_count,
         last_delta_json = excluded.last_delta_json`,
      String(row.key), String(row.userId),
      clamp(axes.familiarity, 0, 100), clamp(axes.affection, 0, 100) / 100, clamp(axes.trust, 0, 100),
      row.lastInteractionAt ?? row.updatedAt ?? at, String(row.displayName ?? '').slice(0, 40), at,
      clamp(axes.affection, 0, 100), clamp(axes.rapport, 0, 100), bond,
      stage, row.stageChangedAt ?? at, row.stageHoldUntil ?? (at + STAGE_HOLD_MS),
      Math.max(0, Math.round(row.interactionCount || 0)),
      row.lastDelta ? JSON.stringify(row.lastDelta) : null
    );
    const saved = { ...row, ...axes, bond, stage, updatedAt: at };
    this._syncUser(saved);
    return saved;
  }

  _hydrate(row, now = this.now()) {
    if (!row) return null;
    const decayed = decayAxes(row, { lastSettledAt: row.updatedAt || now, now });
    const next = {
      ...row,
      affection: decayed.affection,
      trust: decayed.trust,
      familiarity: decayed.familiarity,
      rapport: decayed.rapport
    };
    next.bond = computeBond(next);
    const transition = nextStage({
      bond: next.bond,
      currentStage: row.stage,
      stageHoldUntil: row.stageHoldUntil,
      now
    });
    if (transition.changed) {
      next.stage = transition.stage;
      next.stageChangedAt = now;
      next.stageHoldUntil = now + STAGE_HOLD_MS;
    }
    if (decayed.decayed || transition.changed) {
      const saved = this._write(next, now);
      if (transition.changed) {
        this._recordStageChange({
          key: row.key, userId: row.userId, from: row.stage, to: transition.stage,
          at: now, day: shanghaiDayKey(now), source: 'decay'
        });
      }
      return saved;
    }
    return next;
  }

  _daily(key, userId, day) {
    return this.db.get(
      'SELECT * FROM relationship_daily WHERE key = ? AND user_id = ? AND day_key = ?',
      String(key), String(userId), day
    );
  }

  _touchDaily(key, userId, day, deltas, stage, bond, { countInteraction = true } = {}) {
    const bump = countInteraction ? 1 : 0;
    this.db.run(
      `INSERT INTO relationship_daily(key, user_id, day_key, affection_delta, trust_delta, familiarity_delta, rapport_delta, interactions, stage_end, bond_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(key, user_id, day_key) DO UPDATE SET
         affection_delta = relationship_daily.affection_delta + excluded.affection_delta,
         trust_delta = relationship_daily.trust_delta + excluded.trust_delta,
         familiarity_delta = relationship_daily.familiarity_delta + excluded.familiarity_delta,
         rapport_delta = relationship_daily.rapport_delta + excluded.rapport_delta,
         interactions = relationship_daily.interactions + excluded.interactions,
         stage_end = excluded.stage_end,
         bond_end = excluded.bond_end`,
      String(key), String(userId), day,
      Number(deltas.affection) || 0, Number(deltas.trust) || 0,
      Number(deltas.familiarity) || 0, Number(deltas.rapport) || 0,
      bump, stage, bond
    );
  }

  _insertEvent({ key, userId, type, reason, deltas = {}, bondDelta = 0, context = {}, sourceMessageId = null, dedupeKey = null, at, day }) {
    try {
      this.db.run(
        `INSERT OR IGNORE INTO relationship_events(key, user_id, type, reason, affection_delta, trust_delta, familiarity_delta, rapport_delta, bond_delta, context_json, source_message_id, dedupe_key, created_at, day_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        String(key), String(userId), String(type), String(reason || ''),
        Number(deltas.affection) || 0, Number(deltas.trust) || 0,
        Number(deltas.familiarity) || 0, Number(deltas.rapport) || 0,
        Number(bondDelta) || 0, JSON.stringify(context ?? {}), sourceMessageId ?? null,
        dedupeKey ?? null, at, day
      );
    } catch (error) {
      this.logger(`关系事件写入失败（忽略）：${error?.message ?? error}`);
    }
  }

  _recordStageChange({ key, userId, from, to, at, day, source = 'observe' }) {
    const fromId = clamp(Math.round(Number(from) || 0), 0, 5);
    const toId = clamp(Math.round(Number(to) || 0), 0, 5);
    if (fromId === toId) return;
    const fromLabel = stageLabel(fromId);
    const toLabel = stageLabel(toId);
    this._insertEvent({
      key,
      userId,
      type: 'stage',
      reason: `阶段变化：${fromLabel} → ${toLabel}`,
      context: { stageFrom: fromId, stageTo: toId, stageFromLabel: fromLabel, stageToLabel: toLabel, source },
      dedupeKey: `stage:${key}:${userId}:${at}:${toId}`,
      at,
      day
    });
  }

  get(key, userId) {
    return this._hydrate(this._load(key, userId) ?? this._loadBest(userId), this.now());
  }

  /**
   * 记录一次互动。
   * @returns {{row:object,event:object|null,stageChanged:boolean}|null}
   */
  observe({ key, userId, kind = 'message', displayName = '', context = {} } = {}) {
    const k = String(key ?? '');
    const uid = String(userId ?? '');
    if (!/^(group|private):\d+$/.test(k) || !/^\d+$/.test(uid)) return null;
    const now = this.now();
    const day = shanghaiDayKey(now);
    const isOwner = Boolean(this.ownerId) && uid === this.ownerId;
    const prior = this._load(k, uid) ?? this._loadBest(uid);
    let row = prior ? { ...prior, key: k } : this._defaultRow(k, uid, now);
    if (displayName) row.displayName = String(displayName).slice(0, 40);
    // 连续互动 / 隔一阵回来：只对「普通发言」生效，夸/骂/语音等更强的事件优先。
    // 连续按“上海自然日”判断，间隔超过 3 天算回归，避免把跨时区/熬夜误判成断档。
    const priorAt = Number(prior?.lastInteractionAt || 0);
    const gapMs = priorAt > 0 ? Math.max(0, now - priorAt) : 0;
    const temporalType = priorAt > 0
      ? (gapMs >= 3 * DAY_MS
        ? 'return'
        : (shanghaiDayKey(priorAt) !== day && gapMs <= 2 * DAY_MS ? 'streak' : ''))
      : '';

    // 先结算到现在的衰减，再叠加本次事件。
    const decayed = decayAxes(row, { lastSettledAt: row.updatedAt || now, now });
    row.affection = decayed.affection;
    row.trust = decayed.trust;
    row.familiarity = decayed.familiarity;
    row.rapport = decayed.rapport;
    row.bond = computeBond(row);
    const bondBefore = row.bond;
    row.lastInteractionAt = now;

    // 里程碑与上下文
    const flags = parseJson(this.db.get('SELECT flags_json FROM member_relationships WHERE key = ? AND user_id = ?', k, uid)?.flags_json) ?? {};
    const eventContext = { ...context, isPrivate: context.isPrivate || k.startsWith('private:') };
    if (!flags.firstPrivate && eventContext.isPrivate) eventContext.isMilestone = true;
    if (!flags.firstVoice && eventContext.hasVoice) eventContext.isMilestone = true;
    let classification = classifyMessage({ kind, ...eventContext });
    if (temporalType && classification.type === 'message') {
      classification = { type: temporalType, reason: EVENT_DEFS[temporalType].label };
      eventContext.temporal = temporalType;
    }
    const def = EVENT_DEFS[classification.type] ?? EVENT_DEFS.message;
    const eventDedupeKey = context.dedupeKey
      || (context.messageId ? `${context.messageId}:${classification.type}${isOwner ? ':owner' : ''}` : null);
    // 同一条消息被重放/重复观察时，关系数值也必须幂等，不能只靠事件表去重。
    if (eventDedupeKey && this.db.get('SELECT 1 AS hit FROM relationship_events WHERE dedupe_key = ?', eventDedupeKey)) {
      return { row: this.get(k, uid), event: null, stageChanged: false };
    }

    if (isOwner) {
      row.affection = clamp(Number(row.affection) || 95, 95, 100);
      row.trust = 100;
      row.familiarity = 100;
      row.rapport = clamp(Number(row.rapport) || 80, 80, 100);
      const daily = this._daily(k, uid, day) ?? {};
      // 主人：信任/熟悉固定 100；好感 95→100、默契 80→100 可缓慢上涨，负面事件不扣。
      const affBase = def.affection > 0 ? Math.min(0.3, def.affection * 0.2) : 0;
      const rapBase = def.rapport > 0 ? Math.min(0.4, def.rapport * 0.2) : 0;
      const aff = Math.min(affBase, Math.max(0, 1 - Number(daily.affection_delta || 0)));
      const rap = Math.min(rapBase, Math.max(0, 2 - Number(daily.rapport_delta || 0)));
      const beforeBond = computeBond(row);
      row.affection = clamp(row.affection + aff, 95, 100);
      row.rapport = clamp(row.rapport + rap, 80, 100);
      row.bond = computeBond(row);
      row.interactionCount += 1;
      row.updatedAt = now;
      row.stage = 5;
      row.stageChangedAt = row.stageChangedAt || now;
      row.stageHoldUntil = now + STAGE_HOLD_MS;
      if (aff > 0 || rap > 0) {
        row.lastDelta = {
          type: classification.type,
          label: def.label,
          reason: classification.reason,
          deltas: { affection: Number(aff.toFixed(2)), trust: 0, familiarity: 0, rapport: Number(rap.toFixed(2)) },
          stageChanged: false,
          direction: 'same',
          at: now
        };
      }
      const saved = this._write(row, now);
      let event = null;
      if (aff > 0 || rap > 0) {
        event = {
          key: k,
          userId: uid,
          type: classification.type,
          reason: classification.reason,
          deltas: { affection: Number(aff.toFixed(2)), trust: 0, familiarity: 0, rapport: Number(rap.toFixed(2)) },
          bondDelta: Number((saved.bond - beforeBond).toFixed(2)),
          context: eventContext,
          at: now
        };
        const dedupeKey = eventDedupeKey;
        try {
          this.db.run(
            `INSERT OR IGNORE INTO relationship_events(key, user_id, type, reason, affection_delta, trust_delta, familiarity_delta, rapport_delta, bond_delta, context_json, source_message_id, dedupe_key, created_at, day_key)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            k, uid, classification.type, classification.reason,
            event.deltas.affection, 0, 0, event.deltas.rapport,
            event.bondDelta, JSON.stringify({ kind, owner: true }), context.messageId || null, dedupeKey, now, day
          );
        } catch (error) {
          this.logger(`主人关系事件写入失败（忽略）：${error?.message ?? error}`);
        }
      }
      this._touchDaily(k, uid, day, { affection: aff, trust: 0, familiarity: 0, rapport: rap }, 5, saved.bond);
      return { row: saved, event, stageChanged: false };
    }

    const sameTypeToday = Number(this.db.get(
      'SELECT COUNT(*) AS n FROM relationship_events WHERE key = ? AND user_id = ? AND day_key = ? AND type = ?',
      k, uid, day, classification.type
    )?.n ?? 0);
    const factor = stageIntensity(row.stage) * diminishingFactor(sameTypeToday);
    const deltas = {
      affection: def.affection * factor,
      trust: def.trust * factor,
      familiarity: def.familiarity * factor,
      rapport: def.rapport * factor
    };
    const daily = this._daily(k, uid, day) ?? {};
    const capped = applyDailyCaps(deltas, {
      affection: daily.affection_delta,
      trust: daily.trust_delta,
      familiarity: daily.familiarity_delta,
      rapport: daily.rapport_delta
    });

    row.affection = clamp(row.affection + capped.affection, 0, 100);
    row.trust = clamp(row.trust + capped.trust, 0, 100);
    row.familiarity = clamp(row.familiarity + capped.familiarity, 0, 100);
    row.rapport = clamp(row.rapport + capped.rapport, 0, 100);
    row.interactionCount += 1;
    row.bond = computeBond(row);
    const transition = nextStage({
      bond: row.bond,
      currentStage: row.stage,
      stageHoldUntil: row.stageHoldUntil,
      now
    });
    if (transition.changed) {
      row.stage = transition.stage;
      row.stageChangedAt = now;
      row.stageHoldUntil = now + STAGE_HOLD_MS;
    }
    row.lastDelta = {
      type: classification.type,
      label: def.label,
      reason: classification.reason,
      deltas: {
        affection: Number(capped.affection.toFixed(2)),
        trust: Number(capped.trust.toFixed(2)),
        familiarity: Number(capped.familiarity.toFixed(2)),
        rapport: Number(capped.rapport.toFixed(2))
      },
      stageChanged: transition.changed,
      direction: transition.direction,
      at: now
    };
    row.updatedAt = now;
    if (eventContext.isMilestone) flags[eventContext.firstVoice ? 'firstVoice' : 'firstPrivate'] = true;
    const saved = this._write(row, now);
    if (Object.keys(flags).length) {
      this.db.run('UPDATE member_relationships SET flags_json = ? WHERE key = ? AND user_id = ?', JSON.stringify(flags), k, uid);
    }

    const dedupeKey = eventDedupeKey;
    const event = {
      key: k,
      userId: uid,
      type: classification.type,
      reason: classification.reason,
      deltas: {
        affection: Number(capped.affection.toFixed(2)),
        trust: Number(capped.trust.toFixed(2)),
        familiarity: Number(capped.familiarity.toFixed(2)),
        rapport: Number(capped.rapport.toFixed(2))
      },
      bondDelta: Number((saved.bond - bondBefore).toFixed(2)),
      context: eventContext,
      at: now
    };
    try {
      this.db.run(
        `INSERT OR IGNORE INTO relationship_events(key, user_id, type, reason, affection_delta, trust_delta, familiarity_delta, rapport_delta, bond_delta, context_json, source_message_id, dedupe_key, created_at, day_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        k, uid, classification.type, classification.reason,
        event.deltas.affection, event.deltas.trust, event.deltas.familiarity, event.deltas.rapport,
        event.bondDelta, JSON.stringify({ kind, milestone: eventContext.isMilestone === true }), context.messageId || null, dedupeKey, now, day
      );
    } catch (error) {
      this.logger(`关系事件写入失败（忽略）：${error?.message ?? error}`);
    }
    if (transition.changed) {
      this._recordStageChange({
        key: k, userId: uid, from: prior?.stage ?? 0, to: transition.stage,
        at: now, day, source: 'observe'
      });
    }
    this._touchDaily(k, uid, day, capped, saved.stage, saved.bond);
    return { row: saved, event, stageChanged: transition.changed };
  }

  list(key, { limit = 50, includeOwner = false } = {}) {
    const now = this.now();
    const rows = this.db.all(
      'SELECT * FROM member_relationships WHERE key = ? ORDER BY bond DESC, affection DESC LIMIT ?',
      String(key), Math.min(500, Math.max(1, Number(limit) || 50))
    ).map((r) => this._hydrate(rowToRel(r), now));
    return rows.filter((r) => r && (includeOwner || r.userId !== this.ownerId));
  }

  top(key, { limit = 5, includeOwner = false } = {}) {
    return this.list(key, { limit: Math.max(limit * 2, limit), includeOwner }).slice(0, Math.max(1, Number(limit) || 5));
  }

  /**
   * prompt 用：只给阶段/描述/最近原因，不给数值与 QQ 号。
   * @param {string} key
   * @param {{limit?:number,currentUserId?:string|number,presentationByUserId?:object}} options
   */
  contextBlock(key, { limit = 5, currentUserId = '', presentationByUserId } = {}) {
    const rows = this.top(key, { limit, includeOwner: true });
    if (!rows.length) return '';
    const lines = ['【群友关系】（内部参考：不要向群友报数值，也不要直接复述这张表）'];
    for (const r of rows) {
      const owner = Boolean(this.ownerId) && r.userId === this.ownerId;
      const presentation = resolveRelationshipPresentation(presentationByUserId, r.userId);
      const label = presentation?.label ?? stageLabel(r.stage, { isOwner: owner });
      const words = axisWords(r);
      const last = r.lastDelta ? `；最近 ${r.lastDelta.label}${r.lastDelta.reason && r.lastDelta.reason !== r.lastDelta.label ? `（${r.lastDelta.reason}）` : ''}` : '';
      lines.push(`- ${presentation?.address ?? (r.displayName || (owner ? '主人' : '群友'))}：${label}（好感${words.affection}、${words.trust}、${words.familiarity}、${words.rapport}）${last}`);
    }
    const current = currentUserId
      ? rows.find((r) => r.userId === String(currentUserId))
      : null;
    if (current) {
      const owner = Boolean(this.ownerId) && current.userId === this.ownerId;
      const presentation = resolveRelationshipPresentation(presentationByUserId, current.userId);
      lines.push(`【对当前说话人的语气】${presentation?.address ?? (current.displayName || (owner ? '主人' : '对方'))}：${presentation?.tone ?? toneDirective(current.stage, { isOwner: owner })}`);
    }
    return lines.join('\n');
  }

  timeline(key, userId, { limit = 30 } = {}) {
    return this.db.all(
      'SELECT * FROM relationship_events WHERE key = ? AND user_id = ? ORDER BY id DESC LIMIT ?',
      String(key), String(userId), Math.min(200, Math.max(1, Number(limit) || 30))
    ).map((r) => {
      const context = parseJson(r.context_json) ?? {};
      return {
        id: Number(r.id),
        type: r.type,
        reason: r.reason,
        affection: Number(r.affection_delta),
        trust: Number(r.trust_delta),
        familiarity: Number(r.familiarity_delta),
        rapport: Number(r.rapport_delta),
        bond: Number(r.bond_delta),
        stageFrom: context.stageFrom ?? null,
        stageTo: context.stageTo ?? null,
        stageFromLabel: context.stageFromLabel || '',
        stageToLabel: context.stageToLabel || '',
        actor: context.actor || '',
        source: context.source || '',
        at: Number(r.created_at),
        day: r.day_key
      };
    });
  }

  /** 跨群/跨人的最近关系事件，只给心情反思做聚合，不暴露原始私聊内容。 */
  recentEvents({ since = 0, limit = 200 } = {}) {
    return this.db.all(
      'SELECT key, type, reason, created_at FROM relationship_events WHERE created_at >= ? ORDER BY id DESC LIMIT ?',
      Math.max(0, Number(since) || 0), Math.min(300, Math.max(1, Number(limit) || 200))
    ).map((r) => ({
      key: r.key,
      type: r.type,
      reason: r.reason,
      at: Number(r.created_at)
    }));
  }

  sparkline(key, userId, { days = 7, at = null } = {}) {
    const series = this.sparklines(key, [userId], { days, at });
    return series[String(userId)] ?? [];
  }

  /** 批量 7 日曲线：实时页一次查询，避免每个成员各查一遍。 */
  sparklines(key, userIds = [], { days = 7, at = null } = {}) {
    const now = Number(at) || this.now();
    const ids = [...new Set((Array.isArray(userIds) ? userIds : []).map(String).filter(Boolean))];
    if (!ids.length) return {};
    const dayKeys = [];
    for (let i = days - 1; i >= 0; i -= 1) dayKeys.push(shanghaiDayKey(now - i * 24 * 3600 * 1000));
    const placeholders = ids.map(() => '?').join(',');
    const rows = this.db.all(
      `SELECT user_id, day_key, bond_end, interactions, affection_delta
       FROM relationship_daily
       WHERE key = ? AND user_id IN (${placeholders}) AND day_key >= ?`,
      String(key), ...ids, dayKeys[0]
    );
    const map = new Map(rows.map((r) => [`${r.user_id}|${r.day_key}`, r]));
    const out = {};
    for (const id of ids) {
      out[id] = dayKeys.map((day) => {
        const row = map.get(`${id}|${day}`);
        return {
          day,
          bond: row?.bond_end === null || row?.bond_end === undefined ? null : Number(row.bond_end),
          interactions: Number(row?.interactions ?? 0),
          affectionDelta: Number(row?.affection_delta ?? 0)
        };
      });
    }
    return out;
  }

  set(key, userId, { affection, trust, familiarity, rapport, note, reason = '', actor = 'console' } = {}) {
    const k = String(key ?? '');
    const uid = String(userId ?? '');
    if (!/^(group|private):\d+$/.test(k) || !/^\d+$/.test(uid)) throw new Error('key 或 userId 格式不合法');
    const now = this.now();
    const day = shanghaiDayKey(now);
    const existing = this._load(k, uid) ?? this._loadBest(uid) ?? this._defaultRow(k, uid, now);
    const isOwner = Boolean(this.ownerId) && uid === this.ownerId;
    const row = {
      ...existing,
      key: k,
      affection: isOwner ? clamp(affection ?? existing.affection, 95, 100) : clamp(affection ?? existing.affection, 0, 100),
      trust: isOwner ? 100 : clamp(trust ?? existing.trust, 0, 100),
      familiarity: isOwner ? 100 : clamp(familiarity ?? existing.familiarity, 0, 100),
      rapport: isOwner ? clamp(rapport ?? existing.rapport, 80, 100) : clamp(rapport ?? existing.rapport, 0, 100),
      displayName: note === undefined ? existing.displayName : String(note ?? '').slice(0, 40),
      lastInteractionAt: existing.lastInteractionAt,
      updatedAt: now,
      stageHoldUntil: 0
    };
    const bond = computeBond(row);
    const transition = nextStage({ bond, currentStage: existing.stage, stageHoldUntil: 0, now });
    row.stage = transition.stage;
    row.stageChangedAt = now;
    row.stageHoldUntil = now + STAGE_HOLD_MS;
    const saved = this._write(row, now);
    const deltas = {
      affection: Number((saved.affection - existing.affection).toFixed(2)),
      trust: Number((saved.trust - existing.trust).toFixed(2)),
      familiarity: Number((saved.familiarity - existing.familiarity).toFixed(2)),
      rapport: Number((saved.rapport - existing.rapport).toFixed(2))
    };
    const stageChanged = saved.stage !== existing.stage;
    const noteChanged = saved.displayName !== existing.displayName;
    const changed = stageChanged || noteChanged || Object.values(deltas).some((v) => Math.abs(v) >= 0.01);
    const reasonText = String(reason ?? '').trim().slice(0, 120);
    if (changed || reasonText) {
      this._insertEvent({
        key: k,
        userId: uid,
        type: 'manual',
        reason: reasonText || (stageChanged ? '控制台手动调整（阶段变化）' : '控制台手动调整'),
        deltas,
        bondDelta: Number((saved.bond - existing.bond).toFixed(2)),
        context: {
          actor: String(actor || 'console').slice(0, 30),
          note: saved.displayName,
          stageFrom: existing.stage,
          stageTo: saved.stage,
          stageFromLabel: stageLabel(existing.stage),
          stageToLabel: stageLabel(saved.stage),
          source: 'manual'
        },
        dedupeKey: `manual:${k}:${uid}:${now}`,
        at: now,
        day
      });
    }
    if (stageChanged) {
      this._recordStageChange({
        key: k, userId: uid, from: existing.stage, to: saved.stage,
        at: now, day, source: 'manual'
      });
    }
    this._touchDaily(k, uid, day, { affection: 0, trust: 0, familiarity: 0, rapport: 0 }, saved.stage, saved.bond, { countInteraction: false });
    return saved;
  }

  delete(key, userId) {
    // 关系按 QQ 号全局共享：删除某人的关系时，所有群/私聊的映射一起删。
    return this.db.run('DELETE FROM member_relationships WHERE user_id = ?', String(userId)).changes > 0;
  }

  reset(key, userId) {
    const uid = String(userId);
    this.db.run('DELETE FROM relationship_events WHERE user_id = ?', uid);
    this.db.run('DELETE FROM relationship_daily WHERE user_id = ?', uid);
    return this.db.run('DELETE FROM member_relationships WHERE user_id = ?', uid).changes > 0;
  }

  stats() {
    return {
      total: Number(this.db.get('SELECT COUNT(*) AS n FROM member_relationships')?.n ?? 0),
      keys: Number(this.db.get('SELECT COUNT(DISTINCT key) AS n FROM member_relationships')?.n ?? 0),
      byStage: Object.fromEntries(this.db.all('SELECT stage, COUNT(*) AS n FROM member_relationships GROUP BY stage').map((r) => [r.stage, Number(r.n)])),
      events: Number(this.db.get('SELECT COUNT(*) AS n FROM relationship_events')?.n ?? 0)
    };
  }
}
