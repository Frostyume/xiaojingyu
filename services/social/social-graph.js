import { ensureSocialSchema } from './social-schema.js';
// 社会关系图谱底座：稳定身份 + 人物画像 + 关系边。
//
// 只做 DB 读写，不依赖 bridge / memory / 配置；调用方负责把 QQ 消息里的 userId 传进来。
// 合并规则只有一个入口：同一平台账号永远是同一个人；跨账号合并必须显式 confirmed。
// 同名、同群名片、昵称相似都不合并。

import crypto from 'node:crypto';
import { IdentityStore } from './identity-store.js';
import { makeViewer } from './memory-policy.js';

export const SOCIAL_VISIBILITY = Object.freeze(['public', 'group', 'owner']);
export const SOCIAL_PROVENANCE = Object.freeze(['owner', 'observed', 'inferred']);
export const EDGE_KINDS = Object.freeze(['person_person', 'person_group', 'person_topic', 'self_person']);
export const PROFILE_ITEM_KINDS = Object.freeze(['preferences', 'boundaries', 'style']);

export const SOCIAL_LIMITS = Object.freeze({
  aliases: 12,
  preferences: 20,
  boundaries: 20,
  style: 12,
  textChars: 120,
  recentStateChars: 100,
  evidence: 20,
  inferredTtlMs: 14 * 24 * 3600 * 1000
});

// 只拦“推断出来的”敏感属性；本人明确说过的（observed/owner）允许记录，但不会默认公开。
const SENSITIVE_RE = new RegExp([
  '健康', '病史', '疾病', '癌症', '化疗', '手术', '抑郁', '焦虑', '精神', '残疾',
  '性取向', '同性恋', '双性恋', '跨性别', '恋爱对象', '暗恋', '出轨',
  '政治', '党派', '选举', '宗教', '信仰', '民族', '种族',
  '收入', '工资', '存款', '债务', '贷款', '身份证', '住址', '定位', '病历',
  '怀孕', '流产', 'hiv', '艾滋', 'sexual orientation', 'religion', 'politics', 'salary', 'diagnosis'
].join('|'), 'i');

export class SocialGraphError extends Error {
  constructor(message, code = 'social_graph_error') {
    super(message);
    this.name = 'SocialGraphError';
    this.code = code;
  }
}

const VIS_RANK = Object.freeze({ owner: 0, group: 1, public: 2 });
const PROVENANCE_RANK = Object.freeze({ inferred: 0, observed: 1, owner: 2 });

export function normalizeSocialVisibility(value, fallback = 'public') {
  const raw = String(value ?? '').trim().toLowerCase();
  return SOCIAL_VISIBILITY.includes(raw) ? raw : fallback;
}

export function canViewSocial(visibility, viewer) {
  const vis = normalizeSocialVisibility(visibility);
  if (vis === 'public') return true;
  if (!viewer) return false;
  const sessionKey = String(viewer.sessionKey ?? viewer.chatKey ?? '');
  // 只认显式 isOwnerSession；不因为调用方随手传了 audience:'owner' 就放开。
  const isOwnerSession = viewer.isOwnerSession === true;
  if (vis === 'owner') return isOwnerSession;
  if (vis === 'group') return isOwnerSession || sessionKey.startsWith('group:');
  return false;
}

export function makeSocialViewer({ chatKey = '', audience = 'public', ownerQQ = '', isOwnerSession } = {}) {
  return makeViewer({ chatKey, audience, ownerQQ, isOwnerSession });
}

function clamp01(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0;
}

function normalizeText(text, maxChars = SOCIAL_LIMITS.textChars) {
  return String(text ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s·•\-*]+/, '')
    .trim()
    .slice(0, maxChars);
}

export function isSensitiveProfileText(text) {
  return SENSITIVE_RE.test(String(text ?? ''));
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

function strongerProvenance(a, b) {
  const left = SOCIAL_PROVENANCE.includes(a) ? a : 'observed';
  const right = SOCIAL_PROVENANCE.includes(b) ? b : 'observed';
  return (PROVENANCE_RANK[right] ?? 1) >= (PROVENANCE_RANK[left] ?? 1) ? right : left;
}

// 画像/事实的可见性取更严格的一边：owner 事实不会因为后一次公开观察而被放大。
function lessVisible(a, b) {
  const left = normalizeSocialVisibility(a);
  const right = normalizeSocialVisibility(b);
  return (VIS_RANK[left] ?? 2) <= (VIS_RANK[right] ?? 2) ? left : right;
}

function moreVisible(a, b) {
  const left = normalizeSocialVisibility(a);
  const right = normalizeSocialVisibility(b);
  return (VIS_RANK[left] ?? 2) >= (VIS_RANK[right] ?? 2) ? left : right;
}

function personIdOf(value) {
  return String(value ?? '').trim();
}

function defaultItem({ provenance = 'observed', visibility = 'public', confidence = 0.6, at, text, expiresAt } = {}) {
  return {
    text: normalizeText(text),
    provenance: SOCIAL_PROVENANCE.includes(provenance) ? provenance : 'observed',
    visibility: normalizeSocialVisibility(visibility, 'public'),
    confidence: clamp01(confidence ?? 0.6),
    at: Number(at) || 0,
    expiresAt: expiresAt === null ? null : (Number(expiresAt) || null)
  };
}

function normalizeItem(raw, defaults, now) {
  if (!raw || typeof raw !== 'object') return null;
  const text = normalizeText(raw.text);
  if (!text) return null;
  const provenance = SOCIAL_PROVENANCE.includes(raw.provenance) ? raw.provenance : defaults.provenance;
  const item = defaultItem({
    text,
    provenance,
    visibility: normalizeSocialVisibility(raw.visibility, defaults.visibility),
    confidence: raw.confidence ?? defaults.confidence,
    at: raw.at ?? now,
    expiresAt: raw.expiresAt !== undefined
      ? raw.expiresAt
      : (provenance === 'inferred' ? (Number(raw.at ?? now) + SOCIAL_LIMITS.inferredTtlMs) : null)
  });
  if (item.provenance === 'inferred' && isSensitiveProfileText(item.text)) return { rejected: 'sensitive_attribute' };
  // 本人明说过的敏感信息允许记，但不默认 public，避免被带进群。
  if (isSensitiveProfileText(item.text) && item.visibility === 'public') item.visibility = 'group';
  return item;
}

function mergeItemList(existing, incoming, limit) {
  const out = Array.isArray(existing) ? existing.map((item) => ({ ...item })) : [];
  for (const item of incoming) {
    const index = out.findIndex((row) => row.text === item.text);
    if (index < 0) {
      out.push({ ...item });
      continue;
    }
    const prev = out[index];
    out[index] = {
      ...prev,
      provenance: strongerProvenance(prev.provenance, item.provenance),
      visibility: lessVisible(prev.visibility, item.visibility),
      confidence: Math.max(clamp01(prev.confidence), clamp01(item.confidence)),
      at: Math.max(Number(prev.at) || 0, Number(item.at) || 0),
      expiresAt: prev.expiresAt === null || item.expiresAt === null
        ? null
        : Math.min(Number(prev.expiresAt), Number(item.expiresAt))
    };
  }
  return out.slice(-limit);
}

function activeItems(items, now, viewer, { includeHidden = false } = {}) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const expiresAt = item?.expiresAt;
    if (expiresAt !== null && expiresAt !== undefined && Number(expiresAt) <= now) return false;
    if (includeHidden) return true;
    return canViewSocial(item?.visibility, viewer);
  });
}

function rowToProfile(row, now = Date.now(), { includeHidden = false, viewer = null } = {}) {
  if (!row) return null;
  const profile = {
    personId: row.person_id,
    displayName: row.display_name ? normalizeText(row.display_name, 40) : '',
    aliases: parseArray(row.aliases_json).map((a) => normalizeText(a, 40)).filter(Boolean),
    preferences: parseArray(row.preferences_json).filter((item) => item && item.text),
    boundaries: parseArray(row.boundaries_json).filter((item) => item && item.text),
    style: parseArray(row.style_json).filter((item) => item && item.text),
    recentState: row.recent_state_json ? parseArraySafeObject(row.recent_state_json) : null,
    confidence: clamp01(row.confidence ?? 0.5),
    provenance: SOCIAL_PROVENANCE.includes(row.provenance) ? row.provenance : 'observed',
    visibility: normalizeSocialVisibility(row.visibility),
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0
  };
  profile.preferences = activeItems(profile.preferences, now, viewer, { includeHidden });
  profile.boundaries = activeItems(profile.boundaries, now, viewer, { includeHidden });
  profile.style = activeItems(profile.style, now, viewer, { includeHidden });
  if (profile.recentState) {
    const state = profile.recentState;
    const alive = state.expiresAt === null || state.expiresAt === undefined || Number(state.expiresAt) > now;
    const visible = includeHidden || canViewSocial(state.visibility, viewer);
    if (!alive || !visible) profile.recentState = null;
  }
  return profile;
}

function parseArraySafeObject(text) {
  if (!text) return null;
  try {
    const value = JSON.parse(text);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const normalized = {
      text: normalizeText(value.text, SOCIAL_LIMITS.recentStateChars),
      provenance: SOCIAL_PROVENANCE.includes(value.provenance) ? value.provenance : 'observed',
      visibility: normalizeSocialVisibility(value.visibility),
      at: Number(value.at) || 0,
      expiresAt: value.expiresAt === null ? null : (Number(value.expiresAt) || null)
    };
    return normalized.text ? normalized : null;
  } catch {
    return null;
  }
}

function serializeRecentState(state) {
  if (!state) return null;
  return JSON.stringify(state);
}

function emptyProfileRow(personId, at) {
  return {
    person_id: personId,
    display_name: '',
    aliases_json: '[]',
    preferences_json: '[]',
    boundaries_json: '[]',
    style_json: '[]',
    recent_state_json: null,
    confidence: 0.5,
    provenance: 'observed',
    visibility: 'public',
    created_at: at,
    updated_at: at
  };
}

function normalizeEndpoint(endpoint, label) {
  if (!endpoint || typeof endpoint !== 'object') {
    throw new SocialGraphError(`edge ${label} 缺少端点`, 'invalid_endpoint');
  }
  const kind = String(endpoint.kind ?? '').trim();
  const id = String(endpoint.id ?? '').trim().slice(0, 200);
  if (!['person', 'group', 'topic', 'self'].includes(kind) || !id) {
    throw new SocialGraphError(`edge ${label} 端点无效`, 'invalid_endpoint');
  }
  return { kind, id };
}

function validateEdgeShape(kind, from, to) {
  const allowed = {
    person_person: ['person', 'person'],
    person_group: ['person', 'group'],
    person_topic: ['person', 'topic'],
    self_person: ['self', 'person']
  }[kind];
  if (!allowed) throw new SocialGraphError(`未知 edge kind：${kind}`, 'invalid_edge_kind');
  if (from.kind !== allowed[0] || to.kind !== allowed[1]) {
    throw new SocialGraphError(`edge ${kind} 端点类型不匹配`, 'invalid_edge_shape');
  }
}

function edgeKey(kind, from, to) {
  return crypto.createHash('sha1')
    .update([kind, from.kind, from.id, to.kind, to.id].join('\u0000'))
    .digest('hex')
    .slice(0, 24);
}

function normalizeEvidence(evidence, at) {
  if (!evidence) return null;
  if (typeof evidence === 'string') {
    const key = normalizeText(evidence, 120);
    return key ? { key, at } : null;
  }
  if (typeof evidence !== 'object') return null;
  const type = normalizeText(evidence.type ?? 'event', 24) || 'event';
  const id = evidence.id ?? evidence.key ?? null;
  const key = id === null || id === undefined || id === ''
    ? `${type}:${at}`
    : `${type}:${String(id).slice(0, 100)}`;
  const out = { key, type, at };
  if (id !== null && id !== undefined) out.id = String(id).slice(0, 100);
  if (evidence.note) out.note = normalizeText(evidence.note, 80);
  return out;
}

function edgeRowToObject(row) {
  if (!row) return null;
  return {
    id: row.id,
    kind: row.kind,
    from: { kind: row.from_kind, id: row.from_id },
    to: { kind: row.to_kind, id: row.to_id },
    weight: Number(row.weight) || 0,
    confidence: Number(row.confidence) || 0,
    evidence: parseArray(row.evidence_json),
    firstSeen: Number(row.first_seen) || 0,
    lastSeen: Number(row.last_seen) || 0,
    visibility: normalizeSocialVisibility(row.visibility)
  };
}

export class SocialGraph {
  constructor({ db, now = () => Date.now(), logger = () => {}, identity = null, identityStore = null } = {}) {
    ensureSocialSchema(db);
    if (!db) throw new Error('SocialGraph 需要 db');
    this.db = db;
    this.now = now;
    this.logger = logger;
    this.identity = identityStore || identity || new IdentityStore({ db, now, logger });
  }

  ensurePerson({ platform = 'qq', accountId, displayName = '' } = {}) {
    const ensured = this.identity.ensurePerson({ platform, accountId, displayName });
    return ensured;
  }

  resolveAccount({ platform = 'qq', accountId } = {}) {
    return this.identity.getIdentity(platform, accountId);
  }

  getPerson(personId) {
    return this.identity.getPerson(personId);
  }

  getDisplayName(personId) {
    const id = personIdOf(personId);
    if (!id) return '';
    const profile = this.db.get('SELECT display_name FROM person_profiles WHERE person_id = ?', id);
    if (profile?.display_name) return profile.display_name;
    const person = this.db.get('SELECT display_name FROM persons WHERE id = ?', id);
    if (person?.display_name) return person.display_name;
    const identity = this.db.get(
      "SELECT display_name, account_id FROM identities WHERE person_id = ? ORDER BY confirmed DESC, updated_at DESC LIMIT 1",
      id
    );
    if (identity?.display_name) return identity.display_name;
    return identity?.account_id || id;
  }

  getProfile(personId, { viewer = undefined, now = this.now(), includeHidden = false } = {}) {
    const id = personIdOf(personId);
    if (!id) return null;
    const row = this.db.get('SELECT * FROM person_profiles WHERE person_id = ?', id);
    if (!row) return null;
    if (!includeHidden && viewer !== undefined && !canViewSocial(row.visibility, viewer)) return null;
    return rowToProfile(row, now, { includeHidden, viewer: includeHidden ? null : viewer });
  }

  _writeProfile(personId, mutate) {
    const id = personIdOf(personId);
    if (!id) throw new SocialGraphError('personId 不能为空', 'invalid_person');
    if (!this.db.get('SELECT id FROM persons WHERE id = ?', id)) {
      throw new SocialGraphError('person 不存在，先 ensurePerson', 'person_not_found');
    }
    const at = this.now();
    return this.db.transaction(() => {
      const row = this.db.get('SELECT * FROM person_profiles WHERE person_id = ?', id) || emptyProfileRow(id, at);
      const profile = rowToProfile(row, at, { includeHidden: true });
      const result = mutate(profile, at);
      if (result === false) return null;
      this.db.run(
        `INSERT INTO person_profiles(
           person_id, display_name, aliases_json, preferences_json, boundaries_json, style_json,
           recent_state_json, confidence, provenance, visibility, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(person_id) DO UPDATE SET
           display_name = excluded.display_name,
           aliases_json = excluded.aliases_json,
           preferences_json = excluded.preferences_json,
           boundaries_json = excluded.boundaries_json,
           style_json = excluded.style_json,
           recent_state_json = excluded.recent_state_json,
           confidence = excluded.confidence,
           provenance = excluded.provenance,
           visibility = excluded.visibility,
           updated_at = excluded.updated_at`,
        id,
        profile.displayName,
        JSON.stringify(profile.aliases),
        JSON.stringify(profile.preferences),
        JSON.stringify(profile.boundaries),
        JSON.stringify(profile.style),
        serializeRecentState(profile.recentState),
        profile.confidence,
        profile.provenance,
        profile.visibility,
        profile.createdAt || at,
        at
      );
      return this.getProfile(id, { includeHidden: true, now: at });
    });
  }

  upsertProfile(personId, patch = {}) {
    const aliases = [...new Set(
      (Array.isArray(patch.aliases) ? patch.aliases : [patch.aliases])
        .map((alias) => normalizeText(alias, 40))
        .filter(Boolean)
    )];
    return this._writeProfile(personId, (profile, at) => {
      if (patch.displayName !== undefined) profile.displayName = normalizeText(patch.displayName, 40);
      if (aliases.length) {
        profile.aliases = [...new Set([...profile.aliases, ...aliases])].slice(-SOCIAL_LIMITS.aliases);
      }
      const defaults = {
        provenance: SOCIAL_PROVENANCE.includes(patch.provenance) ? patch.provenance : 'observed',
        visibility: normalizeSocialVisibility(patch.visibility, 'public'),
        confidence: patch.confidence ?? 0.6
      };
      for (const key of ['preferences', 'boundaries', 'style']) {
        const raw = Array.isArray(patch[key]) ? patch[key] : (patch[key] ? [patch[key]] : []);
        if (!raw.length) continue;
        const items = [];
        for (const item of raw) {
          const normalized = normalizeItem(typeof item === 'string' ? { text: item } : item, defaults, at);
          if (normalized?.rejected) continue;
          if (normalized) items.push(normalized);
        }
        profile[key] = mergeItemList(profile[key], items, SOCIAL_LIMITS[key]);
      }
      if (patch.recentState !== undefined && patch.recentState !== null) {
        const text = normalizeText(
          typeof patch.recentState === 'string' ? patch.recentState : patch.recentState.text,
          SOCIAL_LIMITS.recentStateChars
        );
        if (text) {
          const provenance = SOCIAL_PROVENANCE.includes(patch.recentState.provenance)
            ? patch.recentState.provenance
            : defaults.provenance;
          if (!(provenance === 'inferred' && isSensitiveProfileText(text))) {
            const next = {
              text,
              provenance,
              visibility: normalizeSocialVisibility(patch.recentState.visibility, defaults.visibility),
              at,
              expiresAt: patch.recentState.expiresAt !== undefined
                ? patch.recentState.expiresAt
                : (provenance === 'inferred' ? at + SOCIAL_LIMITS.inferredTtlMs : null)
            };
            const prev = profile.recentState;
            const newer = !prev || Number(next.at) >= Number(prev.at)
              || (PROVENANCE_RANK[next.provenance] ?? 1) > (PROVENANCE_RANK[prev.provenance] ?? 1);
            if (newer) profile.recentState = next;
          }
        }
      }
      profile.confidence = Math.max(
        clamp01(profile.confidence),
        clamp01(patch.confidence ?? defaults.confidence)
      );
      profile.provenance = strongerProvenance(profile.provenance, defaults.provenance);
      profile.visibility = moreVisible(profile.visibility, defaults.visibility);
      return true;
    });
  }

  addAlias(personId, alias) {
    return this.upsertProfile(personId, { aliases: [alias] });
  }

  _addItem(personId, listKey, item = {}) {
    const provenance = SOCIAL_PROVENANCE.includes(item.provenance) ? item.provenance : 'observed';
    const normalized = normalizeItem({ ...item, provenance }, {
      provenance,
      visibility: normalizeSocialVisibility(item.visibility, 'public'),
      confidence: item.confidence ?? 0.6
    }, this.now());
    if (normalized?.rejected) {
      return { ok: false, code: normalized.rejected, error: '敏感属性不允许靠推断记录' };
    }
    if (!normalized) return { ok: false, code: 'empty', error: '内容为空' };
    const profile = this._writeProfile(personId, (draft, at) => {
      draft[listKey] = mergeItemList(draft[listKey], [normalized], SOCIAL_LIMITS[listKey]);
      draft.confidence = Math.max(clamp01(draft.confidence), normalized.confidence);
      draft.provenance = strongerProvenance(draft.provenance, normalized.provenance);
      draft.visibility = moreVisible(draft.visibility, normalized.visibility);
      draft.updatedAt = at;
      return true;
    });
    return { ok: true, profile, item: normalized };
  }

  addPreference(personId, item = {}) {
    return this._addItem(personId, 'preferences', item);
  }

  addBoundary(personId, item = {}) {
    return this._addItem(personId, 'boundaries', item);
  }

  addStyle(personId, item = {}) {
    return this._addItem(personId, 'style', item);
  }

  setRecentState(personId, state = {}) {
    return this.upsertProfile(personId, { recentState: state });
  }

  listProfiles(personIds, options = {}) {
    const ids = [...new Set((Array.isArray(personIds) ? personIds : [personIds]).map(personIdOf).filter(Boolean))];
    return ids.map((id) => this.getProfile(id, options)).filter(Boolean);
  }

  /** 按展示名/别名查人，只返回候选，不自动合并。 */
  findByAlias(name, { viewer = undefined, limit = 10 } = {}) {
    const wanted = normalizeText(name, 40).toLowerCase();
    if (!wanted) return [];
    const rows = this.db.all('SELECT id FROM persons ORDER BY updated_at DESC');
    const out = [];
    for (const row of rows) {
      const personId = row.id;
      const names = new Set();
      const person = this.db.get('SELECT display_name FROM persons WHERE id = ?', personId);
      if (person?.display_name) names.add(person.display_name);
      for (const identity of this.db.all('SELECT display_name FROM identities WHERE person_id = ?', personId)) {
        if (identity?.display_name) names.add(identity.display_name);
      }
      const profileRow = this.db.get('SELECT * FROM person_profiles WHERE person_id = ?', personId);
      if (profileRow && (viewer === undefined || canViewSocial(profileRow.visibility, viewer))) {
        if (profileRow.display_name) names.add(profileRow.display_name);
        for (const alias of parseArray(profileRow.aliases_json)) names.add(alias);
      }
      if (![...names].some((candidate) => String(candidate).trim().toLowerCase() === wanted)) continue;
      out.push({ personId, displayName: this.getDisplayName(personId) });
      if (out.length >= limit) break;
    }
    return out;
  }

  upsertEdge({
    kind,
    from,
    to,
    weight = 0.3,
    confidence = 0.5,
    evidence = null,
    visibility = 'public',
    at = this.now()
  } = {}) {
    const edgeKind = String(kind ?? '').trim();
    const left = normalizeEndpoint(from, 'from');
    const right = normalizeEndpoint(to, 'to');
    validateEdgeShape(edgeKind, left, right);
    for (const endpoint of [left, right]) {
      if (endpoint.kind !== 'person') continue;
      if (!this.db.get('SELECT 1 AS ok FROM persons WHERE id = ?', endpoint.id)) {
        throw new SocialGraphError(`person 不存在：${endpoint.id}`, 'person_not_found');
      }
    }
    const when = Number(at) || this.now();
    const vis = normalizeSocialVisibility(visibility);
    const incomingWeight = clamp01(weight);
    const incomingConfidence = clamp01(confidence);
    const ev = normalizeEvidence(evidence, when);
    const id = `edge:${edgeKey(edgeKind, left, right)}`;

    return this.db.transaction(() => {
      const row = this.db.get('SELECT * FROM social_edges WHERE id = ?', id);
      if (!row) {
        this.db.run(
          `INSERT INTO social_edges(id, kind, from_kind, from_id, to_kind, to_id, weight, confidence, evidence_json,
             first_seen, last_seen, visibility)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          id, edgeKind, left.kind, left.id, right.kind, right.id,
          incomingWeight, incomingConfidence, JSON.stringify(ev ? [ev] : []),
          when, when, vis
        );
        return edgeRowToObject(this.db.get('SELECT * FROM social_edges WHERE id = ?', id));
      }
      const list = parseArray(row.evidence_json);
      let added = false;
      if (ev && !list.some((item) => item?.key === ev.key)) {
        list.push(ev);
        added = true;
      }
      let nextWeight = Math.max(Number(row.weight) || 0, incomingWeight);
      if (added) nextWeight = clamp01(nextWeight + 0.05);
      const nextConfidence = Math.max(Number(row.confidence) || 0, incomingConfidence);
      const nextFirst = Math.min(Number(row.first_seen) || when, when);
      const nextLast = added ? Math.max(Number(row.last_seen) || 0, when) : Number(row.last_seen) || when;
      const nextVisibility = lessVisible(row.visibility, vis);
      this.db.run(
        `UPDATE social_edges SET weight = ?, confidence = ?, evidence_json = ?,
           first_seen = ?, last_seen = ?, visibility = ? WHERE id = ?`,
        nextWeight, nextConfidence, JSON.stringify(list.slice(-SOCIAL_LIMITS.evidence)),
        nextFirst, nextLast, nextVisibility, id
      );
      return edgeRowToObject(this.db.get('SELECT * FROM social_edges WHERE id = ?', id));
    });
  }

  queryEdges({ personIds = [], kinds = null, viewer = undefined, limit = 20, now = this.now() } = {}) {
    const ids = [...new Set((Array.isArray(personIds) ? personIds : [personIds]).map(personIdOf).filter(Boolean))];
    const kindList = kinds
      ? (Array.isArray(kinds) ? kinds : [kinds]).filter((k) => EDGE_KINDS.includes(k))
      : null;
    let rows = [];
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      rows = this.db.all(
        `SELECT * FROM social_edges
         WHERE ((from_kind = 'person' AND from_id IN (${placeholders}))
            OR (to_kind = 'person' AND to_id IN (${placeholders})))
         ORDER BY last_seen DESC LIMIT ?`,
        ...ids, ...ids, Math.min(200, Math.max(1, Number(limit) * 4 || 80))
      );
    } else {
      rows = this.db.all('SELECT * FROM social_edges ORDER BY last_seen DESC LIMIT ?',
        Math.min(200, Math.max(1, Number(limit) * 4 || 80)));
    }
    const out = [];
    for (const row of rows) {
      if (kindList && !kindList.includes(row.kind)) continue;
      if (viewer !== undefined && !canViewSocial(row.visibility, viewer)) continue;
      out.push(edgeRowToObject(row));
      if (out.length >= Math.min(100, Math.max(1, Number(limit) || 20))) break;
    }
    return out;
  }

  /**
   * /live 关系图谱的只读输入。只取构图需要的列，并做行数限流：
   * 画像 60、关系行 300、边 200。不写库，不改任何数据的可见性。
   */
  liveGraphRaw({ profiles = 60, relations = 300, edges = 200 } = {}) {
    const safeAll = (sql, ...args) => {
      try { return this.db.all(sql, ...args); } catch { return []; }
    };
    return {
      persons: safeAll(
        `SELECT person_id, display_name, impression_json, recent_state_json, updated_at
         FROM person_profiles ORDER BY updated_at DESC LIMIT ?`,
        Math.max(1, Math.min(60, Number(profiles) || 60))
      ),
      identities: safeAll('SELECT person_id, account_id FROM identities LIMIT 500'),
      relations: safeAll(
        `SELECT key, user_id, stage, affection, trust, familiarity, rapport, bond,
                interaction_count, last_delta_json, last_interaction_at
         FROM member_relationships LIMIT ?`,
        Math.max(1, Math.min(300, Number(relations) || 300))
      ),
      edges: safeAll(
        `SELECT kind, from_kind, from_id, to_kind, to_id, weight
         FROM social_edges ORDER BY last_seen DESC LIMIT ?`,
        Math.max(1, Math.min(200, Number(edges) || 200))
      )
    };
  }

  /**
   * 跨账号合并：只有 confirmed:true 才执行。
   * 自己实现事务而不是转调 IdentityStore.link，是因为画像/边/参与人必须在
   * 删除源 person 之前改挂到目标；link 内部会直接 DELETE persons。
   */
  mergeAccounts({ from, to, confirmed = false } = {}) {
    if (confirmed !== true) {
      throw new SocialGraphError('跨账号合并必须显式确认（confirmed: true）', 'confirmation_required');
    }
    const split = (value) => {
      const platform = String(value?.platform ?? 'qq').trim().toLowerCase();
      const accountId = String(value?.accountId ?? '').trim();
      if (!platform || !accountId) throw new SocialGraphError('合并需要 from/to 两个账号', 'invalid_link');
      return { platform, accountId };
    };
    const fromKey = split(from);
    const toKey = split(to);
    const left = this.identity.getIdentity(fromKey.platform, fromKey.accountId);
    const right = this.identity.getIdentity(toKey.platform, toKey.accountId);
    if (!left || !right) throw new SocialGraphError('待合并账号尚未建立身份', 'identity_not_found');
    if (left.personId === right.personId) {
      return { merged: false, personId: right.personId, mergedFrom: null };
    }
    const source = left.personId;
    const target = right.personId;
    const at = this.now();
    const counts = this.db.transaction(() => {
      const result = { profiles: 0, edges: 0, participants: 0 };
      const sourceProfile = this.db.get('SELECT * FROM person_profiles WHERE person_id = ?', source);
      const targetProfile = this.db.get('SELECT * FROM person_profiles WHERE person_id = ?', target);
      if (sourceProfile && !targetProfile) {
        this.db.run('UPDATE person_profiles SET person_id = ? WHERE person_id = ?', target, source);
        result.profiles += 1;
      } else if (sourceProfile && targetProfile) {
        const src = rowToProfile(sourceProfile, at, { includeHidden: true });
        const dst = rowToProfile(targetProfile, at, { includeHidden: true });
        const mergedProfile = {
          ...dst,
          displayName: dst.displayName || src.displayName,
          aliases: [...new Set([...dst.aliases, ...src.aliases])].slice(-SOCIAL_LIMITS.aliases),
          preferences: mergeItemList(dst.preferences, src.preferences, SOCIAL_LIMITS.preferences),
          boundaries: mergeItemList(dst.boundaries, src.boundaries, SOCIAL_LIMITS.boundaries),
          style: mergeItemList(dst.style, src.style, SOCIAL_LIMITS.style),
          recentState: src.recentState && (!dst.recentState || (src.recentState.at || 0) > (dst.recentState.at || 0))
            ? src.recentState
            : dst.recentState,
          confidence: Math.max(dst.confidence, src.confidence),
          provenance: strongerProvenance(dst.provenance, src.provenance),
          visibility: moreVisible(dst.visibility, src.visibility)
        };
        this.db.run(
          `UPDATE person_profiles SET display_name = ?, aliases_json = ?, preferences_json = ?, boundaries_json = ?,
             style_json = ?, recent_state_json = ?, confidence = ?, provenance = ?, visibility = ?,
             impression_json = ?, owner_note = ?, updated_at = ?
           WHERE person_id = ?`,
          mergedProfile.displayName, JSON.stringify(mergedProfile.aliases),
          JSON.stringify(mergedProfile.preferences), JSON.stringify(mergedProfile.boundaries),
          JSON.stringify(mergedProfile.style), serializeRecentState(mergedProfile.recentState),
          mergedProfile.confidence, mergedProfile.provenance, mergedProfile.visibility,
          targetProfile.impression_json || sourceProfile.impression_json || null,
          targetProfile.owner_note || sourceProfile.owner_note || null,
          at, target
        );
        this.db.run('DELETE FROM person_profiles WHERE person_id = ?', source);
        result.profiles += 1;
      }

      const edges = this.db.all(
        `SELECT * FROM social_edges
         WHERE (from_kind = 'person' AND from_id = ?) OR (to_kind = 'person' AND to_id = ?)`,
        source, source
      );
      for (const edge of edges) {
        const nextFrom = edge.from_kind === 'person' && edge.from_id === source ? target : edge.from_id;
        const nextTo = edge.to_kind === 'person' && edge.to_id === source ? target : edge.to_id;
        if (nextFrom === edge.from_id && nextTo === edge.to_id) continue;
        const nextId = `edge:${edgeKey(edge.kind, { kind: edge.from_kind, id: nextFrom }, { kind: edge.to_kind, id: nextTo })}`;
        const conflict = this.db.get('SELECT * FROM social_edges WHERE id = ?', nextId);
        if (conflict) {
          const mergedEvidence = [
            ...parseArray(conflict.evidence_json),
            ...parseArray(edge.evidence_json).filter((ev) => !parseArray(conflict.evidence_json).some((x) => x?.key === ev?.key))
          ].slice(-SOCIAL_LIMITS.evidence);
          this.db.run(
            `UPDATE social_edges SET weight = ?, confidence = ?, evidence_json = ?, first_seen = ?, last_seen = ?, visibility = ?
             WHERE id = ?`,
            Math.max(Number(conflict.weight) || 0, Number(edge.weight) || 0),
            Math.max(Number(conflict.confidence) || 0, Number(edge.confidence) || 0),
            JSON.stringify(mergedEvidence),
            Math.min(Number(conflict.first_seen) || at, Number(edge.first_seen) || at),
            Math.max(Number(conflict.last_seen) || 0, Number(edge.last_seen) || 0),
            lessVisible(conflict.visibility, edge.visibility),
            nextId
          );
          this.db.run('DELETE FROM social_edges WHERE id = ?', edge.id);
        } else {
          this.db.run(
            'UPDATE social_edges SET id = ?, from_id = ?, to_id = ? WHERE id = ?',
            nextId, nextFrom, nextTo, edge.id
          );
        }
        result.edges += 1;
      }

      const moved = this.db.run(
        `INSERT OR IGNORE INTO episode_participants(episode_id, person_id, role)
         SELECT episode_id, ?, role FROM episode_participants WHERE person_id = ?`,
        target, source
      ).changes;
      this.db.run('DELETE FROM episode_participants WHERE person_id = ?', source);
      result.participants += Number(moved) || 0;

      // 别名历史按 (alias, source_key, kind) 合并：保留更早的首见与更晚的末见。
      try {
        for (const alias of this.db.all('SELECT * FROM person_alias_history WHERE person_id = ?', source)) {
          const conflict = this.db.get(
            'SELECT * FROM person_alias_history WHERE person_id = ? AND alias = ? AND source_key = ? AND kind = ?',
            target, alias.alias, alias.source_key, alias.kind
          );
          if (conflict) {
            this.db.run(
              `UPDATE person_alias_history SET first_seen = ?, last_seen = ?, seen_count = ?
               WHERE person_id = ? AND alias = ? AND source_key = ? AND kind = ?`,
              Math.min(Number(conflict.first_seen) || at, Number(alias.first_seen) || at),
              Math.max(Number(conflict.last_seen) || 0, Number(alias.last_seen) || 0),
              Number(conflict.seen_count || 0) + Number(alias.seen_count || 0),
              target, alias.alias, alias.source_key, alias.kind
            );
            this.db.run(
              'DELETE FROM person_alias_history WHERE person_id = ? AND alias = ? AND source_key = ? AND kind = ?',
              source, alias.alias, alias.source_key, alias.kind
            );
          } else {
            this.db.run('UPDATE person_alias_history SET person_id = ? WHERE person_id = ? AND alias = ? AND source_key = ? AND kind = ?',
              target, source, alias.alias, alias.source_key, alias.kind);
          }
        }
      } catch { /* v10 未迁移的库没有这张表 */ }

      this.db.run(
        'UPDATE identities SET person_id = ?, confirmed = 1, updated_at = ? WHERE person_id = ?',
        target, at, source
      );
      try { this.db.run('UPDATE memory_facts SET subject_person_id = ? WHERE subject_person_id = ?', target, source); } catch {}
      this.db.run('DELETE FROM persons WHERE id = ?', source);
      return result;
    });
    if (this.logger) this.logger(`社会图谱合并：${source} → ${target}，画像 ${counts.profiles}，边 ${counts.edges}，参与人 ${counts.participants}`);
    return { merged: true, personId: target, mergedFrom: source, ...counts };
  }

  stats() {
    const count = (sql) => Number(this.db.get(sql)?.n ?? 0);
    return {
      persons: count('SELECT COUNT(*) AS n FROM persons'),
      identities: count('SELECT COUNT(*) AS n FROM identities'),
      profiles: count('SELECT COUNT(*) AS n FROM person_profiles'),
      edges: count('SELECT COUNT(*) AS n FROM social_edges'),
      edgesByKind: Object.fromEntries(
        this.db.all('SELECT kind, COUNT(*) AS n FROM social_edges GROUP BY kind').map((row) => [row.kind, Number(row.n)])
      ),
      profilesWithoutPerson: count(
        'SELECT COUNT(*) AS n FROM person_profiles p LEFT JOIN persons s ON s.id = p.person_id WHERE s.id IS NULL'
      ),
      orphanParticipants: count(
        'SELECT COUNT(*) AS n FROM episode_participants p LEFT JOIN persons s ON s.id = p.person_id WHERE s.id IS NULL'
      )
    };
  }
}
