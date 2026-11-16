import { ensureSocialSchema } from './social-schema.js';
// 人物档案（person dossier）：只读聚合层，不是第三套存储。
//
// 单一事实来源仍是：
//   · persons / identities            身份与 QQ
//   · person_profiles                 称呼、别名、偏好、边界、风格、近况
//   · member_relationships            四轴、阶段、关系事件
//   · memory_facts(person 层)         关于这个人的记忆
//   · episodes / episode_participants 共同经历
//
// 本模块只按 person_id 读取并拼成控制台/提示词需要的视图；除主人编辑的
// impression_json / owner_note 与别名历史外不写任何“档案副本”。

import { SocialGraph, makeSocialViewer, canViewSocial } from './social-graph.js';
import { EpisodeStore } from './episodes.js';
import { axisWords, stageLabel as relationshipStageLabel } from '../../runtime/persona/relationship-model.js';
import { canView } from './memory-policy.js';

export const DOSSIER_LIMITS = Object.freeze({
  impressionChars: 120,
  ownerNoteChars: 300,
  facetChars: 70,
  memoryRecent: 5,
  episodeRecent: 5,
  aliasRows: 30,
  promptChars: 700,
  inferredTtlMs: 14 * 24 * 3600 * 1000
});

export const ALIAS_KINDS = Object.freeze(['nickname', 'group_card', 'private_remark', 'alias']);
const VISIBILITIES = new Set(['public', 'group', 'owner']);
const PROVENANCE_RANK = Object.freeze({ inferred: 0, observed: 1, owner: 2 });

function clean(value, max = 200) {
  return String(value ?? '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

function parseJson(text, fallback = null) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function personIdOf(value) {
  const id = String(value ?? '').trim();
  return /^person:[0-9a-fA-F-]{8,}$/.test(id) ? id : '';
}

function qqOf(identity) {
  return identity?.platform === 'qq' ? String(identity.accountId ?? identity.account_id ?? '') : '';
}

function strongestProvenance(values) {
  let best = 'inferred';
  for (const value of values) {
    if ((PROVENANCE_RANK[value] ?? -1) > (PROVENANCE_RANK[best] ?? -1)) best = value;
  }
  return best;
}

function normalizeVisibility(value, fallback = 'group') {
  const raw = String(value ?? '').trim().toLowerCase();
  return VISIBILITIES.has(raw) ? raw : fallback;
}

function isOwner(viewer) {
  return viewer?.isOwnerSession === true;
}

function sessionKeyOf(viewer) {
  return String(viewer?.sessionKey ?? viewer?.chatKey ?? '');
}

function canViewAliasSource(sourceKey, viewer) {
  if (!sourceKey) return true;
  if (isOwner(viewer)) return true;
  const sessionKey = sessionKeyOf(viewer);
  return Boolean(sessionKey) && sourceKey === sessionKey;
}

function isExpired(item, now) {
  return item?.expiresAt !== null && item?.expiresAt !== undefined && Number(item.expiresAt) <= now;
}

function visibleProfileItems(items, viewer, now) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    if (!item?.text || isExpired(item, now)) return false;
    return viewer ? canViewSocial(item.visibility, viewer) : item.visibility !== 'owner';
  });
}

function itemView(item, now) {
  return {
    text: clean(item.text, 120),
    provenance: item.provenance || 'observed',
    confidence: clamp(item.confidence, 0, 1, 0.5),
    visibility: normalizeVisibility(item.visibility, 'public'),
    updatedAt: Number(item.at) || 0,
    expiresAt: item.expiresAt === null || item.expiresAt === undefined ? null : Number(item.expiresAt)
  };
}

function facet({ text, items, sources, now, provenance = null }) {
  const value = clean(text, DOSSIER_LIMITS.facetChars);
  if (!value) return null;
  const list = Array.isArray(items) ? items.filter(Boolean) : [];
  const prov = provenance || strongestProvenance(list.map((item) => item.provenance));
  const confidence = list.length
    ? Math.max(...list.map((item) => clamp(item.confidence, 0, 1, 0.5)))
    : (prov === 'owner' ? 0.95 : prov === 'observed' ? 0.6 : 0.35);
  return {
    text: value,
    provenance: prov,
    confidence: Number(confidence.toFixed(2)),
    evidence: sources,
    updatedAt: list.reduce((latest, item) => Math.max(latest, Number(item.at) || 0), 0) || now,
    expiresAt: prov === 'inferred' ? now + DOSSIER_LIMITS.inferredTtlMs : null
  };
}

function uniqueNames(list, max = 3) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(list) ? list : []) {
    const text = clean(raw?.text ?? raw, 40);
    if (!text || seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length >= max) break;
  }
  return out;
}

function aliasKindForSource(sourceKey) {
  const key = String(sourceKey ?? '');
  if (key.startsWith('group:')) return 'group_card';
  if (key.startsWith('private:')) return 'private_remark';
  return 'nickname';
}

function sourceLabel(sourceKey) {
  const key = String(sourceKey ?? '');
  if (!key) return '通用昵称';
  if (key.startsWith('group:')) return `群 ${key.slice('group:'.length)}`;
  if (key.startsWith('private:')) return `私聊 ${key.slice('private:'.length)}`;
  return key;
}

export class PersonDossier {
  constructor({
    db,
    now = () => Date.now(),
    logger = () => {},
    ownerQQ = '',
    identityEnabled = false,
    stageLabel = null,
    graph = null,
    episodes = null
  } = {}) {
    if (!db) throw new Error('PersonDossier 需要 db');
    ensureSocialSchema(db);
    this.db = db;
    this.now = now;
    this.logger = logger;
    this.ownerQQ = String(ownerQQ ?? '');
    this.identityEnabled = identityEnabled === true;
    this.stageLabel = typeof stageLabel === 'function'
      ? stageLabel
      : (stage, options) => relationshipStageLabel(stage, options);
    this.graph = graph || new SocialGraph({ db, now, logger });
    this.episodes = episodes || new EpisodeStore({ db, now, logger, socialGraph: this.graph });
  }

  ownerViewerForKey(key = '') {
    return makeSocialViewer({
      chatKey: String(key || (this.ownerQQ ? `private:${this.ownerQQ}` : '')),
      audience: 'owner',
      ownerQQ: this.ownerQQ,
      isOwnerSession: true
    });
  }

  _identities(personId) {
    try {
      return this.db.all(
        `SELECT platform, account_id, person_id, display_name, confirmed, created_at, updated_at
         FROM identities WHERE person_id = ? ORDER BY confirmed DESC, updated_at DESC`,
        personId
      );
    } catch {
      return [];
    }
  }

  _relationRows(personId, key, viewer) {
    const qqs = this._identities(personId).map(qqOf).filter(Boolean);
    if (!qqs.length) return { qqs, rows: [] };
    const placeholders = qqs.map(() => '?').join(',');
    let rows = [];
    try {
      rows = this.db.all(
        `SELECT * FROM member_relationships WHERE user_id IN (${placeholders})
         ORDER BY bond DESC, affection DESC, trust DESC, last_interaction_at DESC`,
        ...qqs
      );
    } catch {
      return { qqs, rows: [] };
    }
    if (!isOwner(viewer) && key) {
      const inSession = rows.filter((row) => row.key === key);
      if (inSession.length) return { qqs, rows: [inSession[0]] };
    }
    if (isOwner(viewer) && key) {
      const preferred = rows.find((row) => row.key === key);
      if (preferred) return { qqs, rows: [preferred, ...rows.filter((row) => row !== preferred)] };
    }
    return { qqs, rows };
  }

  _recentRelationChange(qqs, key, viewer) {
    if (!qqs.length) return null;
    const placeholders = qqs.map(() => '?').join(',');
    const scope = isOwner(viewer) || !key ? '' : ' AND key = ?';
    const params = isOwner(viewer) || !key ? qqs : [...qqs, key];
    let rows = [];
    try {
      rows = this.db.all(
        `SELECT type, reason, key, created_at FROM relationship_events
         WHERE user_id IN (${placeholders})${scope}
         ORDER BY created_at DESC LIMIT 20`,
        ...params
      );
    } catch {
      return null;
    }
    const row = rows.find((item) => item.type !== 'message' && item.type !== 'attention' && item.type !== 'question')
      || rows[0];
    if (!row) return null;
    return {
      type: row.type || '',
      reason: clean(row.reason, 80),
      at: Number(row.created_at) || 0
    };
  }

  _sharedGroups(personId, qqs, key, viewer) {
    const groups = new Set();
    if (qqs.length) {
      const placeholders = qqs.map(() => '?').join(',');
      try {
        for (const row of this.db.all(
          `SELECT DISTINCT key FROM member_relationships WHERE user_id IN (${placeholders})`,
          ...qqs
        )) {
          if (String(row.key).startsWith('group:')) groups.add(String(row.key));
        }
      } catch { /* 旧库缺关系表 */ }
    }
    try {
      for (const row of this.db.all(
        `SELECT DISTINCT to_id FROM social_edges
         WHERE kind = 'person_group' AND from_kind = 'person' AND from_id = ?`,
        personId
      )) {
        if (String(row.to_id).startsWith('group:')) groups.add(String(row.to_id));
      }
    } catch { /* 旧库缺边表 */ }
    if (!isOwner(viewer)) {
      const sessionKey = sessionKeyOf(viewer);
      return sessionKey.startsWith('group:') && groups.has(sessionKey) ? [sessionKey] : [];
    }
    if (key && groups.has(key)) {
      return [key, ...[...groups].filter((item) => item !== key).sort()];
    }
    return [...groups].sort();
  }

  _aliasRows(personId, viewer) {
    let rows = [];
    try {
      rows = this.db.all(
        `SELECT alias, source_key, kind, first_seen, last_seen, seen_count
         FROM person_alias_history WHERE person_id = ?
         ORDER BY last_seen DESC LIMIT ?`,
        personId, DOSSIER_LIMITS.aliasRows
      );
    } catch {
      rows = [];
    }
    const visible = rows
      .filter((row) => canViewAliasSource(row.source_key, viewer))
      .map((row) => ({
        name: clean(row.alias, 40),
        sourceKey: String(row.source_key ?? ''),
        sourceLabel: sourceLabel(row.source_key),
        kind: ALIAS_KINDS.includes(row.kind) ? row.kind : aliasKindForSource(row.source_key),
        firstSeen: Number(row.first_seen) || 0,
        lastSeen: Number(row.last_seen) || 0,
        seenCount: Math.max(1, Number(row.seen_count) || 1)
      }))
      .filter((row) => row.name);
    if (visible.length) return visible;

    // 迁移前/尚未观察到名字时，用当前身份名兜底，不伪造来源与时间。
    return this._identities(personId)
      .filter((identity) => identity.display_name)
      .map((identity) => ({
        name: clean(identity.display_name, 40),
        sourceKey: '',
        sourceLabel: '通用昵称',
        kind: 'nickname',
        firstSeen: Number(identity.created_at) || 0,
        lastSeen: Number(identity.updated_at) || 0,
        seenCount: 1
      }));
  }

  _profileRow(personId) {
    try {
      return this.db.get('SELECT * FROM person_profiles WHERE person_id = ?', personId);
    } catch {
      return null;
    }
  }

  _identityView(personId, viewer, profileRow, relation, aliasRows) {
    const identities = this._identities(personId);
    const qqs = identities.map(qqOf).filter(Boolean);
    const person = this.graph.getPerson(personId);
    const owner = isOwner(viewer);
    const sessionKey = sessionKeyOf(viewer);
    const sessionAlias = aliasRows.find((row) => row.sourceKey === sessionKey);
    const globalAlias = aliasRows.find((row) => !row.sourceKey);
    const latestAlias = aliasRows[0];
    const currentAddress = owner
      ? (clean(profileRow?.display_name, 40) || clean(person?.displayName, 40) || latestAlias?.name || '')
      : (sessionAlias?.name || globalAlias?.name || clean(person?.displayName, 40) || latestAlias?.name || '');
    const times = [
      Number(person?.createdAt) || 0,
      Number(profileRow?.created_at) || 0,
      ...identities.map((row) => Number(row.created_at) || 0),
      ...aliasRows.map((row) => row.firstSeen || 0)
    ].filter(Boolean);
    const lastTimes = [
      ...identities.map((row) => Number(row.updated_at) || 0),
      ...aliasRows.map((row) => row.lastSeen || 0),
      ...relation.rows.map((row) => Number(row.last_interaction_at) || 0)
    ].filter(Boolean);
    return {
      currentAddress,
      // QQ 只在主人/控制台可见；群与普通私聊一律不返回账号。
      qq: owner ? qqs : [],
      aliases: aliasRows,
      sharedGroups: this._sharedGroups(personId, qqs, sessionKey, viewer),
      firstMet: times.length ? Math.min(...times) : null,
      lastInteraction: lastTimes.length ? Math.max(...lastTimes) : null
    };
  }

  _relationshipView(relation, personId, key, viewer) {
    const row = relation.rows[0] || null;
    if (!row) {
      return {
        stageLabel: '',
        axes: null,
        recentChange: null,
        openItems: this._openItems(personId, key, viewer)
      };
    }
    const ownerRelation = Boolean(this.ownerQQ) && String(row.user_id) === this.ownerQQ;
    const words = axisWords({
      affection: row.affection,
      trust: row.trust,
      familiarity: row.familiarity,
      rapport: row.rapport
    });
    return {
      stageLabel: this.stageLabel(Number(row.stage) || 0, { isOwner: ownerRelation }),
      axes: {
        affection: words.affection,
        trust: words.trust,
        familiarity: words.familiarity,
        rapport: words.rapport
      },
      interactions: Math.max(0, Number(row.interaction_count) || 0),
      lastInteraction: Number(row.last_interaction_at) || 0,
      recentChange: this._recentRelationChange(relation.qqs, key, viewer),
      openItems: this._openItems(personId, key, viewer)
    };
  }

  _openItems(personId, key, viewer) {
    try {
      return this.episodes.list({
        groupKey: key || null,
        personId,
        viewer,
        now: this.now(),
        limit: 20
      })
        .filter((episode) => episode.outcome === 'open')
        .slice(0, 3)
        .map((episode) => ({
          id: episode.id,
          at: episode.occurredAt,
          topic: episode.topic || '',
          summary: clean(episode.summary, 100)
        }));
    } catch {
      return [];
    }
  }

  _memoryView(personId, viewer, qqs) {
    const now = this.now();
    const params = [];
    let where = "tier = 'person'";
    if (this.identityEnabled) {
      const placeholders = qqs.map(() => '?').join(',');
      where += ` AND (subject_person_id = ?${placeholders ? ` OR (subject_person_id IS NULL AND owner_key IN (${placeholders}))` : ''})`;
      params.push(personId, ...qqs.map((qq) => `person:${qq}`));
    } else if (qqs.length) {
      where += ` AND owner_key IN (${qqs.map(() => '?').join(',')})`;
      params.push(...qqs.map((qq) => `person:${qq}`));
    } else {
      return { mode: this.identityEnabled ? 'subject_person_id' : 'owner_key', total: 0, topics: [], recent: [] };
    }
    where += " AND (expires_at IS NULL OR expires_at > ?) AND (legacy IS NULL OR legacy = 0)";
    params.push(now);
    let rows = [];
    try {
      rows = this.db.all(
        `SELECT * FROM memory_facts WHERE ${where} ORDER BY COALESCE(last_seen_at, updated_at) DESC LIMIT 50`,
        ...params
      );
    } catch {
      return { mode: this.identityEnabled ? 'subject_person_id' : 'owner_key', total: 0, topics: [], recent: [] };
    }
    const policyViewer = this.identityEnabled
      ? makeSocialViewer({
        chatKey: sessionKeyOf(viewer),
        audience: isOwner(viewer) ? 'owner' : 'public',
        ownerQQ: this.ownerQQ,
        isOwnerSession: isOwner(viewer)
      })
      : null;
    if (policyViewer) policyViewer.presentPersonIds = [...qqs];
    const visible = rows.filter((row) => {
      if (!isOwner(viewer) && String(row.privacy ?? '') === 'owner') return false;
      if (policyViewer && !canView(row, policyViewer)) return false;
      return true;
    });
    const topics = [...new Set(visible.map((row) => clean(row.topic, 30)).filter(Boolean))].slice(0, 3);
    return {
      mode: this.identityEnabled ? 'subject_person_id' : 'owner_key',
      total: visible.length,
      topics,
      recent: visible.slice(0, DOSSIER_LIMITS.memoryRecent).map((row) => ({
        id: Number(row.id),
        topic: clean(row.topic, 30),
        fact: clean(row.fact, 160),
        provenance: row.provenance || 'observed',
        confidence: clamp(row.confidence, 0, 1, 0.5),
        at: Number(row.last_seen_at || row.updated_at || row.created_at) || 0
      }))
    };
  }

  _experienceView(personId, key, viewer) {
    try {
      return this.episodes.list({
        groupKey: key || null,
        personId,
        viewer,
        now: this.now(),
        limit: DOSSIER_LIMITS.episodeRecent
      }).map((episode) => ({
        id: episode.id,
        at: episode.occurredAt,
        topic: episode.topic || '',
        summary: clean(episode.summary, 160),
        valence: episode.valence || null,
        outcome: episode.outcome || null,
        participants: episode.participants.map((item) => clean(item.name, 24) || item.personId || '').filter(Boolean)
      }));
    } catch {
      return [];
    }
  }

  _derivedFacets({ profile, relationView, experiences, recentState, memories, now }) {
    const facets = {};
    const styleItems = profile?.style || [];
    const preferenceItems = profile?.preferences || [];
    if (preferenceItems.length || styleItems.length) {
      const prefs = preferenceItems.slice(0, 2).map((item) => item.text);
      const styles = styleItems.slice(0, 2).map((item) => item.text);
      const parts = [];
      if (prefs.length) parts.push(`偏好${prefs.join('、')}`);
      if (styles.length) parts.push(`说话/相处偏${styles.join('、')}`);
      facets.personality = facet({
        text: parts.join('；'),
        items: [...preferenceItems, ...styleItems],
        sources: [
          ...(preferenceItems.length ? ['profile.preferences'] : []),
          ...(styleItems.length ? ['profile.style'] : [])
        ],
        now
      });
    }
    if (relationView?.stageLabel) {
      const count = Number(relationView.interactions) || 0;
      facets.interaction = facet({
        text: `关系阶段${relationView.stageLabel}${count ? `，互动 ${count} 次` : ''}`,
        items: [],
        sources: ['relationship.stage'],
        now,
        provenance: 'observed'
      });
    }
    // 人物记忆是已过滤的 person 层事实；把它纳入自动印象，避免新档案只有一句“关系阶段”。
    const memoryItems = (Array.isArray(memories?.recent) ? memories.recent : [])
      .filter((item) => item?.fact && !/的关系阶段变成/.test(item.fact))
      .slice(0, 2)
      .map((item) => ({
        text: item.fact,
        provenance: item.provenance,
        confidence: item.confidence,
        visibility: 'group',
        at: item.at
      }));
    if (memoryItems.length) {
      facets.memory = facet({
        text: `记得${memoryItems.map((item) => item.text).join('；')}`,
        items: memoryItems,
        sources: ['memory.person'],
        now,
        provenance: 'observed'
      });
    }
    const recentEpisode = experiences?.[0];
    if (recentState?.text || recentEpisode?.summary) {
      const text = recentState?.text
        ? clean(recentState.text, 50)
        : clean(recentEpisode.summary, 50);
      facets.recent = facet({
        text: recentState?.text ? `近况：${text}` : `最近一起：${text}`,
        items: recentState ? [recentState] : [],
        sources: [recentState?.text ? 'profile.recentState' : 'episode'],
        now,
        provenance: recentState?.provenance || 'observed'
      });
      if (facets.recent && recentEpisode && !recentState?.text) facets.recent.updatedAt = recentEpisode.at;
    }
    return facets;
  }

  _impressionView({ profileRow, facets, viewer, now }) {
    const stored = parseJson(profileRow?.impression_json, null);
    if (stored && typeof stored === 'object') {
      if (stored.cleared === true) {
        return {
          summary: '',
          cleared: true,
          provenance: 'owner',
          confidence: 1,
          visibility: normalizeVisibility(stored.visibility, 'owner'),
          evidence: ['owner:clear'],
          updatedAt: Number(stored.updatedAt) || 0,
          expiresAt: null,
          facets: {},
          source: 'owner'
        };
      }
      const visibility = normalizeVisibility(stored.visibility, 'group');
      if (canViewSocial(visibility, viewer)) {
        const summary = clean(stored.summary, DOSSIER_LIMITS.impressionChars);
        if (summary) {
          return {
            summary,
            cleared: false,
            provenance: 'owner',
            confidence: 1,
            visibility,
            evidence: ['owner:edit'],
            updatedAt: Number(stored.updatedAt) || 0,
            expiresAt: null,
            facets,
            source: 'owner'
          };
        }
      }
    }
    const list = Object.values(facets).filter(Boolean);
    if (!list.length) return null;
    const summary = list.map((item) => item.text).join('；').slice(0, DOSSIER_LIMITS.impressionChars);
    const provenance = strongestProvenance(list.map((item) => item.provenance));
    return {
      summary,
      cleared: false,
      provenance,
      confidence: Number(Math.max(...list.map((item) => item.confidence)).toFixed(2)),
      visibility: 'group',
      evidence: [...new Set(list.flatMap((item) => item.evidence || []))],
      updatedAt: list.reduce((latest, item) => Math.max(latest, item.updatedAt || 0), 0) || now,
      expiresAt: provenance === 'inferred' ? now + DOSSIER_LIMITS.inferredTtlMs : null,
      facets,
      source: 'derived'
    };
  }

  getPersonDossier({ personId, viewer, key = '', now = this.now() } = {}) {
    const id = personIdOf(personId);
    if (!id) return null;
    if (!this.db.get('SELECT id FROM persons WHERE id = ?', id)) return null;
    const profileRow = this._profileRow(id);
    const profile = profileRow
      ? {
        displayName: clean(profileRow.display_name, 40),
        aliases: parseJson(profileRow.aliases_json, []) || [],
        preferences: visibleProfileItems(parseJson(profileRow.preferences_json, []), viewer, now),
        boundaries: visibleProfileItems(parseJson(profileRow.boundaries_json, []), viewer, now),
        style: visibleProfileItems(parseJson(profileRow.style_json, []), viewer, now),
        recentState: parseJson(profileRow.recent_state_json, null),
        updatedAt: Number(profileRow.updated_at) || 0
      }
      : null;
    if (profile?.recentState) {
      const state = profile.recentState;
      const alive = !isExpired(state, now);
      const visible = viewer ? canViewSocial(state.visibility, viewer) : true;
      if (!alive || !visible) profile.recentState = null;
    }
    const relation = this._relationRows(id, String(key ?? ''), viewer);
    const aliasRows = this._aliasRows(id, viewer);
    const identity = this._identityView(id, viewer, profileRow, relation, aliasRows);
    const relationship = this._relationshipView(relation, id, String(key ?? ''), viewer);
    const memories = this._memoryView(id, viewer, relation.qqs);
    const experiences = this._experienceView(id, String(key ?? ''), viewer);
    const facets = this._derivedFacets({
      profile,
      relationView: relationship,
      experiences,
      recentState: profile?.recentState,
      memories,
      now
    });
    const impression = this._impressionView({ profileRow, facets, viewer, now });
    const ownerNote = isOwner(viewer) ? clean(profileRow?.owner_note, DOSSIER_LIMITS.ownerNoteChars) : '';
    return {
      personId: id,
      key: String(key ?? ''),
      identity,
      relationship,
      impression,
      memories,
      experiences,
      preferences: (profile?.preferences || []).map((item) => itemView(item, now)),
      boundaries: (profile?.boundaries || []).map((item) => itemView(item, now)),
      style: (profile?.style || []).map((item) => itemView(item, now)),
      ownerNote: ownerNote || '',
      updatedAt: Math.max(
        Number(profileRow?.updated_at) || 0,
        Number(identity.lastInteraction) || 0,
        impression?.updatedAt || 0
      )
    };
  }

  /**
   * /live 羁绊卡专用：只允许主人视图，额外返回四轴原始分与 QQ。
   * 不返回 owner_note；这些原始分不会进入 getPersonDossier/prompt 公共视图。
   */
  liveCard({ personId, groupKeys = [], now = this.now() } = {}) {
    const id = personIdOf(personId);
    if (!id) return null;
    const viewer = this.ownerViewerForKey('');
    const dossier = this.getPersonDossier({ personId: id, key: '', viewer, now });
    if (!dossier) return null;
    const allGroups = Array.isArray(dossier.identity.sharedGroups) ? dossier.identity.sharedGroups : [];
    const allowed = Array.isArray(groupKeys) ? groupKeys.filter((key) => /^group:\d+$/.test(String(key))) : [];
    const sharedGroups = allowed.length ? allGroups.filter((key) => allowed.includes(key)) : allGroups;
    // 有群记录但都不在白名单里的，不往 live 上展示；只有私聊记录的人保留到「未分群」。
    if (allGroups.length && !sharedGroups.length) return null;
    const relation = this._relationRows(id, '', viewer).rows[0] || null;
    const round = (value) => Math.round((Number(value) || 0) * 10) / 10;
    const seenAliases = new Set();
    const aliases = dossier.identity.aliases
      .filter((item) => {
        const name = clean(item.name, 40);
        if (!name || seenAliases.has(name)) return false;
        seenAliases.add(name);
        return true;
      })
      .slice(0, 6)
      .map((item) => ({
        name: item.name,
        sourceLabel: item.sourceLabel,
        lastSeen: item.lastSeen
      }));
    return {
      personId: id,
      name: dossier.identity.currentAddress || '',
      qq: dossier.identity.qq,
      stage: Math.max(0, Number(relation?.stage) || 0),
      stageLabel: dossier.relationship.stageLabel,
      impression: dossier.impression?.summary || '',
      impressionSource: dossier.impression?.source || '',
      impressionProvenance: dossier.impression?.provenance || '',
      impressionCleared: dossier.impression?.cleared === true,
      firstMet: Number(dossier.identity.firstMet) || 0,
      scores: relation ? {
        bond: round(relation.bond),
        affection: round(relation.affection),
        trust: round(relation.trust),
        familiarity: round(relation.familiarity),
        rapport: round(relation.rapport)
      } : null,
      axes: dossier.relationship.axes,
      interactions: Math.max(0, Number(relation?.interaction_count) || 0),
      lastInteraction: Number(dossier.identity.lastInteraction) || 0,
      aliases,
      sharedGroups,
      memories: dossier.memories,
      experiences: dossier.experiences.slice(0, 4),
      boundaries: dossier.boundaries.slice(0, 2).map((item) => ({ text: item.text, provenance: item.provenance })),
      preferences: dossier.preferences.slice(0, 3).map((item) => ({ text: item.text, provenance: item.provenance })),
      style: dossier.style.slice(0, 2).map((item) => ({ text: item.text, provenance: item.provenance })),
      openItems: dossier.relationship.openItems,
      recentChange: dossier.relationship.recentChange,
      updatedAt: dossier.updatedAt
    };
  }

  listDossiers({ key = '', viewer, userIds = [], limit = 30, now = this.now() } = {}) {
    const ids = [];
    const seen = new Set();
    const push = (id) => {
      const value = personIdOf(id);
      if (!value || seen.has(value)) return;
      seen.add(value);
      ids.push(value);
    };
    for (const userId of Array.isArray(userIds) ? userIds : []) {
      if (!/^\d{1,20}$/.test(String(userId))) continue;
      const identity = this.graph.resolveAccount({ accountId: String(userId) });
      if (identity?.personId) push(identity.personId);
    }
    try {
      if (!ids.length || key) {
        for (const row of this.db.all(
          `SELECT DISTINCT ep.person_id FROM episode_participants ep
           JOIN episodes e ON e.id = ep.episode_id
           WHERE e.group_key = ? AND (e.expires_at IS NULL OR e.expires_at > ?)`,
          String(key), now
        )) push(row.person_id);
      }
    } catch { /* 旧库缺表 */ }
    // 只有主人/控制台才允许在没有会话证据时浏览全库；群/agent 只列当前会话的人。
    if (!ids.length && isOwner(viewer)) {
      try {
        for (const row of this.db.all('SELECT id FROM persons ORDER BY updated_at DESC LIMIT ?', Math.max(1, Number(limit) || 30))) {
          push(row.id);
        }
      } catch { /* persons 缺失 */ }
    }
    const items = [];
    for (const id of ids) {
      if (items.length >= Math.max(1, Number(limit) || 30)) break;
      const dossier = this.getPersonDossier({ personId: id, viewer, key, now });
      if (!dossier) continue;
      const name = dossier.identity.currentAddress || this.graph.getDisplayName(id);
      if (!name) continue;
      items.push({
        personId: id,
        name,
        qq: dossier.identity.qq,
        stageLabel: dossier.relationship.stageLabel,
        impression: dossier.impression?.summary || '',
        boundary: dossier.boundaries[0]?.text || '',
        lastInteraction: dossier.identity.lastInteraction,
        aliasCount: dossier.identity.aliases.length
      });
    }
    items.sort((a, b) => (Number(b.lastInteraction) || 0) - (Number(a.lastInteraction) || 0));
    return { key: String(key ?? ''), total: items.length, people: items, generatedAt: now };
  }

  buildPromptCard({ personId, key = '', viewer, maxChars = DOSSIER_LIMITS.promptChars, now = this.now() } = {}) {
    let dossier;
    try {
      dossier = this.getPersonDossier({ personId, key, viewer, now });
    } catch (error) {
      this.logger(`人物档案 prompt 生成失败（忽略）：${error?.message ?? error}`);
      return '';
    }
    if (!dossier) return '';
    const name = dossier.identity.currentAddress;
    const lines = [];
    if (name) lines.push(`· 称呼：${name}`);
    const stage = dossier.relationship.stageLabel;
    if (stage) lines.push(`· 关系：${stage}`);
    const impression = clean(dossier.impression?.summary, 90);
    if (impression) lines.push(`· 印象：${impression}`);
    const memories = dossier.memories.recent.slice(0, 2).map((item) => clean(item.fact, 50));
    if (memories.length) lines.push(`· 记得：${memories.join('；')}`);
    const experience = dossier.experiences
      .filter((item) => item.summary)
      .slice(0, 1)
      .map((item) => clean(item.summary, 50));
    if (experience.length) lines.push(`· 最近一起：${experience[0]}`);
    const boundaries = dossier.boundaries.slice(0, 2).map((item) => clean(item.text, 40)).filter(Boolean);
    if (boundaries.length) lines.push(`· 边界：${boundaries.join('；')}`);
    if (!lines.length) return '';
    const limit = clamp(maxChars, 120, 2000, DOSSIER_LIMITS.promptChars);
    const text = `【人物档案】\n${lines.join('\n')}`;
    return text.length > limit ? `${text.slice(0, Math.max(0, limit - 1))}…` : text;
  }

  recordAlias({ personId, alias, sourceKey = '', kind = '', at = this.now() } = {}) {
    const id = personIdOf(personId);
    const name = clean(alias, 40);
    if (!id || !name) return false;
    if (!this.db.get('SELECT id FROM persons WHERE id = ?', id)) return false;
    const source = /^(group|private):\d+$/.test(String(sourceKey ?? '')) ? String(sourceKey) : '';
    const type = ALIAS_KINDS.includes(kind) ? kind : aliasKindForSource(source);
    const when = Number(at) || this.now();
    try {
      this.db.run(
        `INSERT INTO person_alias_history(person_id, alias, source_key, kind, first_seen, last_seen, seen_count)
         VALUES (?, ?, ?, ?, ?, ?, 1)
         ON CONFLICT(person_id, alias, source_key, kind) DO UPDATE SET
           last_seen = MAX(person_alias_history.last_seen, excluded.last_seen),
           seen_count = person_alias_history.seen_count + 1`,
        id, name, source, type, when, when
      );
      return true;
    } catch (error) {
      this.logger(`别名历史写入失败（忽略）：${error?.message ?? error}`);
      return false;
    }
  }

  _ensureProfileRow(personId, at) {
    if (this._profileRow(personId)) return;
    this.db.run(
      `INSERT OR IGNORE INTO person_profiles(person_id, display_name, aliases_json, preferences_json, boundaries_json,
         style_json, recent_state_json, confidence, provenance, visibility, created_at, updated_at)
       VALUES (?, '', '[]', '[]', '[]', '[]', NULL, 0.5, 'observed', 'public', ?, ?)`,
      personId, at, at
    );
  }

  setImpression({ personId, summary, visibility = 'group', viewer, action = 'update', now = this.now() } = {}) {
    const id = personIdOf(personId);
    if (!id || !this.db.get('SELECT id FROM persons WHERE id = ?', id)) {
      return { ok: false, error: '人物不存在' };
    }
    if (!isOwner(viewer)) return { ok: false, error: '只有主人可以编辑人物档案' };
    const at = Number(now) || this.now();
    this._ensureProfileRow(id, at);
    if (action === 'clear') {
      const payload = { summary: '', cleared: true, visibility: normalizeVisibility(visibility, 'owner'), updatedAt: at };
      this.db.run('UPDATE person_profiles SET impression_json = ?, updated_at = ? WHERE person_id = ?', JSON.stringify(payload), at, id);
      return { ok: true, cleared: true, impression: payload };
    }
    const text = clean(summary, DOSSIER_LIMITS.impressionChars);
    if (!text) return { ok: false, error: '印象摘要不能为空（如需清空请用 clear）' };
    const payload = {
      summary: text,
      cleared: false,
      visibility: normalizeVisibility(visibility, 'group'),
      provenance: 'owner',
      updatedAt: at
    };
    this.db.run('UPDATE person_profiles SET impression_json = ?, updated_at = ? WHERE person_id = ?', JSON.stringify(payload), at, id);
    return { ok: true, impression: payload };
  }

  setOwnerNote({ personId, note, viewer, now = this.now() } = {}) {
    const id = personIdOf(personId);
    if (!id || !this.db.get('SELECT id FROM persons WHERE id = ?', id)) {
      return { ok: false, error: '人物不存在' };
    }
    if (!isOwner(viewer)) return { ok: false, error: '只有主人可以编辑人物备注' };
    const text = clean(note, DOSSIER_LIMITS.ownerNoteChars);
    const at = Number(now) || this.now();
    this._ensureProfileRow(id, at);
    this.db.run('UPDATE person_profiles SET owner_note = ?, updated_at = ? WHERE person_id = ?', text, at, id);
    return { ok: true, ownerNote: text };
  }
}

export default PersonDossier;
