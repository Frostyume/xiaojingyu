// 社会记忆运行时编排：把 social-graph / episodes / attention / social-context
// 接成一个模块，供 bridge 与 inner-life 调用；本文件不 import bridge、不碰网络。
//
// 职责边界：
//   · bootstrap：从 persons/identities、person 记忆、member_relationships 补图谱；
//   · 入站：只在明确关系事件/心情事件时写 episode，普通闲聊不写；
//   · prompt：生成注意力片段与社会上下文片段（可见性由 viewer 过滤）；
//   · 只读 API：给控制台/agent token 返回当前会话可见的人物、边、episode；
//   · 巩固：episode → 画像近况/关系边/可选事实，可重入、可关闭。

import { SocialGraph, makeSocialViewer, canViewSocial } from './social-graph.js';
import {
  EpisodeStore,
  EPISODE_SCENE_WINDOW_MS,
  episodeFromMoodEvent,
  episodeFromRelationshipEvent,
  episodeFromChatTurn,
  canViewEpisode
} from './episodes.js';
import { decideAttention, attentionPromptFragment } from '../../runtime/persona/attention.js';
import { buildSocialContext, degreeLabel } from './social-context.js';
import { PersonDossier } from './person-dossier.js';

export const RELATION_EPISODE_TYPES = Object.freeze(['praise', 'comfort', 'insult', 'conflict', 'tease', 'milestone']);
export const MOOD_EPISODE_TYPES = Object.freeze([
  'praise', 'comfort', 'tease', 'insult', 'conflict', 'neglect',
  'success', 'failure', 'novelty', 'rest'
]);

const RELATION_EPISODE_SET = new Set(RELATION_EPISODE_TYPES);
const MOOD_EPISODE_SET = new Set(MOOD_EPISODE_TYPES);
const DEFAULT_STAGE_LABELS = ['陌生人', '眼熟', '熟人', '朋友', '好友', '亲近'];

// 对话经历只是轻量近况：30 天后自然过期，避免每日上限 × 180 天把库撑大。
const CHAT_EPISODE_TTL_MS = 30 * 24 * 3600 * 1000;

// 运行期 fallback：键缺失时 settings() 实际用的就是这组值；bridge 归一化也引用它，避免两处漂移。
export const CHAT_EPISODES_DEFAULTS = Object.freeze({
  enabled: true,
  windowMs: 10 * 60 * 1000,
  minSpeakers: 2,
  dailyLimit: 40
});

function beijingDayStart(at) {
  const dayMs = 24 * 3600 * 1000;
  const offset = 8 * 3600 * 1000;
  return Math.floor((Number(at) + offset) / dayMs) * dayMs - offset;
}

function clamp(value, min, max, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
}

function clean(value, max = 80) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function isSessionKey(key) {
  return /^(group|private):\d+$/.test(String(key ?? ''));
}

function isQq(value) {
  return /^\d{1,20}$/.test(String(value ?? ''));
}

// 关系库的 note 有时是会话占位或系统提示（"私聊"、"你已被移出群聊"），
// 不能当成人名写进图谱；真正的昵称会随之后的入站消息补上。
const PLACEHOLDER_NAMES = new Set(['私聊', '群聊', '未知', '你已被移出群聊', '该用户不存在']);
function usablePersonName(value) {
  const name = clean(value, 40);
  if (!name || PLACEHOLDER_NAMES.has(name)) return '';
  if (/^\d{5,}$/.test(name)) return '';
  if (/(移出群聊|加入群聊|撤回了一条消息|退出了群聊)$/.test(name)) return '';
  return name;
}

export class SocialMemory {
  constructor({
    db,
    cfg,
    now = () => Date.now(),
    logger = () => {},
    ownerQQ = '',
    relationshipStore = null,
    memoryStore = null,
    stageLabel = null
  } = {}) {
    this.db = db || null;
    this.cfg = cfg || {};
    this.now = now;
    this.logger = logger;
    this.ownerQQ = String(ownerQQ ?? '');
    this.relationshipStore = relationshipStore || null;
    // 人物档案读模型只读 memory_facts；这里只借用 identity 开关决定按
    // subject_person_id 还是 owner_key='person:<QQ>' 读取，不持有 MemoryStore。
    this.memoryIdentityEnabled = memoryStore?.identityEnabled === true;
    this.dossier = null;
    this.stageLabel = typeof stageLabel === 'function'
      ? stageLabel
      : (stage) => DEFAULT_STAGE_LABELS[Math.max(0, Math.min(5, Number(stage) || 0))];
    this.graph = null;
    this.episodes = null;
    this.bootstrapped = false;
    this.lastBootstrap = null;
    this.lastError = '';
    this._liveDossiersCache = null;
    // 频控只看内存：同群同一时间窗只尝试写一条，进程重启后由 episode 去重键兜底。
    this._chatEpisodeBuckets = new Map();
  }

  settings() {
    const raw = this.cfg.simulation?.socialMemory;
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const chatEpisodes = value.chatEpisodes && typeof value.chatEpisodes === 'object' && !Array.isArray(value.chatEpisodes)
      ? value.chatEpisodes
      : {};
    return {
      enabled: value.enabled === true,
      graph: { enabled: value.graph?.enabled !== false },
      episodes: { enabled: value.episodes?.enabled !== false },
      chatEpisodes: {
        enabled: chatEpisodes.enabled !== false,
        windowMs: clamp(chatEpisodes.windowMs, 60000, 3600000, CHAT_EPISODES_DEFAULTS.windowMs),
        minSpeakers: clamp(chatEpisodes.minSpeakers, 2, 6, CHAT_EPISODES_DEFAULTS.minSpeakers),
        dailyLimit: clamp(chatEpisodes.dailyLimit, 1, 200, CHAT_EPISODES_DEFAULTS.dailyLimit)
      },
      prompt: {
        enabled: value.prompt?.enabled !== false,
        maxChars: clamp(value.prompt?.maxChars, 120, 2000, 700),
        maxPeople: clamp(value.prompt?.maxPeople, 1, 6, 3),
        maxEpisodes: clamp(value.prompt?.maxEpisodes, 0, 5, 2)
      },
      attention: {
        enabled: value.attention?.enabled !== false,
        promptMaxChars: clamp(value.attention?.promptMaxChars, 80, 800, 320),
        maxTargets: clamp(value.attention?.maxTargets, 1, 6, 3)
      },
      consolidate: {
        enabled: value.consolidate?.enabled !== false,
        intervalMs: clamp(value.consolidate?.intervalMs, 60000, 24 * 3600 * 1000, 30 * 60 * 1000)
      },
      bootstrap: { enabled: value.bootstrap?.enabled !== false },
      memoryStrength: {
        enabled: this.cfg.simulation?.cognition?.memoryStrength?.enabled === true
      },
      contextTiers: {
        enabled: this.cfg.simulation?.cognition?.contextTiers?.enabled === true
      }
    };
  }

  get enabled() {
    return this.settings().enabled && Boolean(this.db);
  }

  _ready() {
    if (!this.db) return false;
    if (!this.graph) this.graph = new SocialGraph({ db: this.db, now: this.now, logger: this.logger });
    if (!this.episodes) {
      this.episodes = new EpisodeStore({
        db: this.db,
        now: this.now,
        logger: this.logger,
        socialGraph: this.graph,
        memoryStrength: this.settings().memoryStrength.enabled
      });
    }
    if (!this.dossier) {
      this.dossier = new PersonDossier({
        db: this.db,
        now: this.now,
        logger: this.logger,
        ownerQQ: this.ownerQQ,
        identityEnabled: this.memoryIdentityEnabled,
        stageLabel: this.stageLabel,
        graph: this.graph,
        episodes: this.episodes
      });
    }
    return true;
  }

  viewerForKey(key) {
    const normalized = String(key ?? '');
    const isOwnerSession = Boolean(this.ownerQQ) && normalized === `private:${this.ownerQQ}`;
    return makeSocialViewer({
      chatKey: normalized,
      audience: isOwnerSession ? 'owner' : 'public',
      ownerQQ: this.ownerQQ,
      isOwnerSession
    });
  }

  episodeVisibilityForKey(key) {
    const value = String(key ?? '');
    if (value.startsWith('group:')) return 'group';
    // 私聊共同经历只留在当前私聊；owner 私聊仍由 owner session 看到。
    return 'session';
  }

  _ensureProfileName(personId, displayName) {
    const name = usablePersonName(displayName);
    if (!personId || !name) return false;
    try {
      const profile = this.graph.getProfile(personId, { includeHidden: true });
      if (!profile || !profile.displayName) {
        this.graph.upsertProfile(personId, { displayName: name, visibility: 'public', provenance: 'observed' });
        return true;
      }
    } catch (error) {
      this.logger(`[social] 画像称呼写入失败（忽略）：${error?.message ?? error}`);
    }
    return false;
  }

  /** 启动/配置开启时的幂等补图。不生成 episode，不猜敏感属性。 */
  bootstrap({ memoryStore = null, force = false } = {}) {
    const empty = { ok: false, persons: 0, profiles: 0, edges: 0, linkedFacts: 0 };
    if (!this.enabled || !this._ready()) return empty;
    if (this.bootstrapped && !force) return this.lastBootstrap || empty;
    if (this.settings().bootstrap?.enabled === false) return empty;
    try {
      const at = this.now();
      let profiles = 0;
      let edges = 0;
      let linkedFacts = 0;
      if (memoryStore?.identityEnabled) {
        try {
          const backfill = memoryStore.backfillPersonIdentityLinks();
          linkedFacts = Number(backfill?.linked) || 0;
        } catch (error) {
          this.logger(`[social] 旧 person 记忆回填失败（忽略）：${error?.message ?? error}`);
        }
      }

      // persons/identities 已存在：补一层人物称呼，不新建身份。
      let identities = [];
      try {
        identities = this.db.all(
          "SELECT person_id, display_name FROM identities WHERE platform = 'qq' AND display_name <> ''"
        );
      } catch { /* 旧库缺表 */ }
      for (const identity of identities) {
        if (this._ensureProfileName(identity.person_id, identity.display_name)) profiles += 1;
      }

      // member_relationships 是已有的可信来源：补人物、当前群的人—群边、她对人的边。
      let rows = [];
      try {
        rows = this.db.all(
          `SELECT key, user_id, note AS display_name, stage, familiarity, bond
           FROM member_relationships WHERE user_id <> ''`
        );
      } catch { /* 旧库缺表 */ }
      const people = new Map();
      for (const row of rows) {
        if (!isQq(row.user_id)) continue;
        const displayName = usablePersonName(row.display_name);
        let person = people.get(String(row.user_id));
        if (!person) {
          try {
            person = this.graph.ensurePerson({ accountId: String(row.user_id), displayName }).person;
            people.set(String(row.user_id), person);
          } catch (error) {
            this.logger(`[social] 补人物失败（忽略）：${error?.message ?? error}`);
            continue;
          }
        }
        if (this._ensureProfileName(person.id, displayName)) profiles += 1;
        const familiarity = clamp(row.familiarity, 0, 100, 0);
        const stage = clamp(row.stage, 0, 5, 0);
        if (String(row.key).startsWith('group:')) {
          try {
            this.graph.upsertEdge({
              kind: 'person_group',
              from: { kind: 'person', id: person.id },
              to: { kind: 'group', id: String(row.key) },
              weight: clamp(0.25 + familiarity / 200 + stage * 0.04 + clamp(row.bond, 0, 100, 0) / 800, 0, 1, 0.3),
              confidence: 0.5,
              evidence: { type: 'relationship_backfill', id: `${row.key}:${row.user_id}` },
              visibility: 'group',
              at
            });
            edges += 1;
          } catch (error) {
            this.logger(`[social] 补群边失败（忽略）：${error?.message ?? error}`);
          }
        }
        if (stage >= 1 || familiarity >= 20) {
          try {
            this.graph.upsertEdge({
              kind: 'self_person',
              from: { kind: 'self', id: 'self' },
              to: { kind: 'person', id: person.id },
              weight: clamp(0.3 + stage * 0.08 + familiarity / 300, 0, 1, 0.35),
              confidence: 0.5,
              evidence: { type: 'relationship_backfill', id: `self:${row.user_id}` },
              visibility: 'owner',
              at
            });
            edges += 1;
          } catch (error) {
            this.logger(`[social] 补她对人的边失败（忽略）：${error?.message ?? error}`);
          }
        }
      }

      this.bootstrapped = true;
      this.lastBootstrap = {
        ok: true,
        persons: people.size,
        profiles,
        edges,
        linkedFacts
      };
      this.logger(`[social] 图谱补全：人物 ${this.lastBootstrap.persons}，画像 ${profiles}，边 ${edges}，回填事实 ${linkedFacts}`);
      return this.lastBootstrap;
    } catch (error) {
      this.lastError = String(error?.message ?? error);
      this.logger(`[social] 启动补图失败（忽略）：${this.lastError}`);
      return { ...empty, error: this.lastError };
    }
  }

  /**
   * 同场参与者：事件发起人 + 同会话、同场窗口内真实发过言的其他人。
   * 只认 recentMessages 里出现过的账号，不按群成员名单或互动次数推断；
   * 按 userId 排序，保证同一批人写出的两两配对方向稳定，边权重能叠加。
   */
  _sceneParticipants({ at, userId, sender = '', recentMessages = [], windowMs = EPISODE_SCENE_WINDOW_MS } = {}) {
    const eventAt = Number(at) || this.now();
    const sceneWindow = Number(windowMs) > 0 ? Number(windowMs) : EPISODE_SCENE_WINDOW_MS;
    const rows = new Map();
    const add = (uid, displayName, role) => {
      const accountId = clean(uid, 40);
      if (!accountId || !isQq(accountId) || rows.has(accountId)) return;
      let personId = '';
      try {
        personId = this.graph.resolveAccount({ accountId })?.personId || '';
        if (!personId) {
          personId = this.graph.ensurePerson({ accountId, displayName: clean(displayName, 40) }).person.id;
        }
      } catch (error) {
        this.logger(`[social] 同场人物解析失败（忽略）：${error?.message ?? error}`);
        return;
      }
      rows.set(accountId, { personId, userId: accountId, name: clean(displayName, 40), role });
    };
    add(userId, sender, 'speaker');
    // 图谱关闭时保持旧行为：只记发起人，不为人—人边额外建身份。
    if (this.settings().graph.enabled) {
      for (const message of Array.isArray(recentMessages) ? recentMessages : []) {
        if (!message || message.isSelf === true) continue;
        const when = Number(message.time);
        if (!Number.isFinite(when) || Math.abs(when - eventAt) > sceneWindow) continue;
        add(message.userId, message.sender, 'witness');
      }
    }
    return [...rows.values()].sort((a, b) => a.userId.localeCompare(b.userId));
  }

  /**
   * 对话经历：同群一轮里 ≥minSpeakers 位发言人、且至少一条点名她时，写一条轻量摘要。
   * 纯模板拼接，不调模型；同群同一时间窗最多一条，另有每日本上限。
   * 只记她真正在场的轮次，普通群聊与单人发言都不写。
   */
  _maybeRecordChatEpisode({ key, messageId = null, recentMessages = [] } = {}) {
    const settings = this.settings();
    const chat = settings.chatEpisodes;
    if (!settings.enabled || !settings.episodes.enabled || !chat.enabled || !settings.graph.enabled) return null;
    const groupKey = String(key ?? '');
    if (!groupKey.startsWith('group:')) return null;
    const at = this.now();
    const messages = (Array.isArray(recentMessages) ? recentMessages : []).filter((message) => {
      if (!message || message.isSelf === true || !isQq(message.userId)) return false;
      const when = Number(message.time);
      return Number.isFinite(when) && when <= at + 5000 && at - when <= chat.windowMs;
    });
    const speakerIds = new Set(messages.map((message) => String(message.userId)));
    if (speakerIds.size < chat.minSpeakers) return null;
    const anchors = messages.filter((message) => message.addressedTo === 'self');
    if (!anchors.length) return null;
    const anchor = anchors[anchors.length - 1];
    const anchorAt = Number(anchor.time) || at;
    const bucket = Math.floor(anchorAt / chat.windowMs);
    const state = this._chatEpisodeBuckets.get(groupKey);
    if (state && (state.bucket === bucket || at - state.at < chat.windowMs)) return null;
    // 同一条消息已经记过关系/心情经历时不再叠一条，避免同一次互动占两条记忆。
    const ids = [...new Set([
      messageId != null ? String(messageId) : '',
      anchor.messageId != null ? String(anchor.messageId) : ''
    ].filter(Boolean))];
    for (const id of ids) {
      if (this.db.get('SELECT 1 AS ok FROM episodes WHERE source_event_id = ?', id)) {
        this._chatEpisodeBuckets.set(groupKey, { bucket, at });
        return null;
      }
    }
    const sceneParticipants = this._sceneParticipants({
      at: anchorAt,
      userId: anchor.userId,
      sender: anchor.sender,
      recentMessages,
      windowMs: chat.windowMs
    });
    if (sceneParticipants.length < chat.minSpeakers) return null;
    const todayCount = Number(this.db.get(
      `SELECT COUNT(*) AS n FROM episodes
       WHERE group_key = ? AND dedupe_key LIKE 'manual:chat-episode:%' AND occurred_at >= ?`,
      groupKey, beijingDayStart(at)
    )?.n ?? 0);
    if (todayCount >= chat.dailyLimit) {
      this._chatEpisodeBuckets.set(groupKey, { bucket, at });
      return null;
    }
    const built = episodeFromChatTurn(
      { name: anchor.sender, text: anchor.plain || anchor.text, at: anchorAt },
      {
        groupKey,
        participants: sceneParticipants,
        presentNames: sceneParticipants
          .filter((person) => person.userId !== String(anchor.userId))
          .map((person) => person.name),
        speakerCount: speakerIds.size,
        dedupeKey: `chat-episode:${groupKey}:${bucket}`,
        visibility: this.episodeVisibilityForKey(groupKey)
      },
      { now: this.now(), ttlMs: CHAT_EPISODE_TTL_MS }
    );
    if (!built) return null;
    const recorded = this.episodes.record(built, { now: this.now() });
    this._chatEpisodeBuckets.set(groupKey, { bucket, at });
    return recorded;
  }

  /**
   * 入站消息：确保身份、补称呼；只有明确关系事件才写 episode。
   * relationResult 是 RelationshipStore.observe() 的返回值。
   */
  handleIncoming({ key, userId, sender = '', messageId = null, relationResult = null, recentMessages = [] } = {}) {
    const settings = this.settings();
    if (!settings.enabled || !this._ready()) return null;
    if (!isSessionKey(key) || !isQq(userId)) return null;
    try {
      const ensured = this.graph.ensurePerson({ accountId: String(userId), displayName: sender });
      const personId = ensured.person.id;
      if (settings.graph.enabled) this._ensureProfileName(personId, sender);
      if (settings.graph.enabled && sender) {
        this.dossier?.recordAlias({
          personId,
          alias: sender,
          sourceKey: String(key),
          at: this.now()
        });
      }
      let episode = null;
      const event = relationResult?.event;
      if (settings.episodes.enabled
        && event
        && RELATION_EPISODE_SET.has(String(event.type))
        && this.graph) {
        const occurredAt = Number(event.at) || this.now();
        const sceneParticipants = this._sceneParticipants({
          at: occurredAt,
          userId,
          sender,
          recentMessages
        });
        const built = episodeFromRelationshipEvent(event, {
          groupKey: String(key),
          topic: '关系',
          participantName: sender,
          participants: sceneParticipants,
          visibility: this.episodeVisibilityForKey(key),
          at: occurredAt
        }, { now: this.now() });
        if (built) {
          const recorded = this.episodes.record({
            occurredAt,
            groupKey: String(key),
            topic: '关系',
            summary: built.summary,
            participants: sceneParticipants,
            valence: built.valence,
            energy: built.energy,
            outcome: 'closed',
            // 与心情事件共用 messageId：同一条消息只会有一条 episode。
            sourceEventId: messageId !== null && messageId !== undefined && messageId !== ''
              ? String(messageId)
              : undefined,
            visibility: this.episodeVisibilityForKey(key)
          }, { now: this.now() });
          episode = recorded.episode;
        }
      }
      // 关系事件已经覆盖这条消息时不再写对话经历；心情事件在独立链路里写，不在这里判重。
      const chatEpisode = episode
        ? null
        : this._maybeRecordChatEpisode({ key, messageId, recentMessages });
      return { personId, episode, chatEpisode, created: episode !== null };
    } catch (error) {
      this.logger(`[social] 入站写入失败（忽略）：${error?.message ?? error}`);
      return null;
    }
  }

  /** 心情事件（自动或模型手动）：与关系事件共用 sourceMessageId 去重。 */
  recordMoodEvent(event = {}, { key = '', userId = '', sender = '', messageId = null, recentMessages = [] } = {}) {
    const settings = this.settings();
    if (!settings.enabled || !settings.episodes.enabled || !this._ready()) return null;
    if (!event || !MOOD_EPISODE_SET.has(String(event.type))) return null;
    if (!isSessionKey(key)) return null;
    const uid = isQq(userId) ? String(userId) : (String(key).startsWith('private:') ? String(key).slice('private:'.length) : '');
    try {
      let personId = null;
      let name = clean(sender, 40);
      if (isQq(uid)) {
        const ensured = this.graph.ensurePerson({ accountId: uid, displayName: name });
        personId = ensured.person.id;
        if (settings.graph.enabled) this._ensureProfileName(personId, name);
        if (settings.graph.enabled && name) {
          this.dossier?.recordAlias({ personId, alias: name, sourceKey: String(key), at: this.now() });
        }
        if (!name) name = this.graph.getDisplayName(personId);
      }
      const occurredAt = Number(event.receivedAt) || this.now();
      const sceneParticipants = this._sceneParticipants({
        at: occurredAt,
        userId: uid,
        sender: name,
        recentMessages
      });
      const participants = sceneParticipants.length
        ? sceneParticipants
        : (personId ? [{ personId, userId: uid, name }] : (name ? [{ userId: uid, name }] : []));
      const built = episodeFromMoodEvent(event, {
        groupKey: key,
        topic: '心情',
        participants,
        visibility: this.episodeVisibilityForKey(key),
        at: this.now()
      }, { now: this.now() });
      if (!built) return null;
      const sourceId = messageId !== null && messageId !== undefined && messageId !== ''
        ? String(messageId)
        : (event.sourceMessageId ? String(event.sourceMessageId) : undefined);
      return this.episodes.record({
        occurredAt,
        groupKey: key,
        topic: '心情',
        summary: built.summary,
        participants,
        valence: built.valence,
        energy: built.energy,
        outcome: 'closed',
        sourceEventId: sourceId,
        visibility: this.episodeVisibilityForKey(key)
      }, { now: this.now() });
    } catch (error) {
      this.logger(`[social] 心情 episode 写入失败（忽略）：${error?.message ?? error}`);
      return null;
    }
  }

  /** 唤醒 prompt 的注意力片段；只做提示，不改变 addressedness 的硬规则。 */
  buildAttentionLine(key, st, { globalActivity = 'diving' } = {}) {
    const settings = this.settings();
    if (!settings.enabled || !settings.attention.enabled) return '';
    if (!st || !Array.isArray(st.recentMessages) || !st.recentMessages.length) return '';
    try {
      const decision = decideAttention({
        messages: st.recentMessages.slice(-30),
        session: {
          key: String(key),
          isPrivate: String(key).startsWith('private:'),
          mode: st.wakeConfig?.mode || 'diving',
          globalActivity,
          activeTopics: st.activeTopics
        },
        now: this.now(),
        config: { maxTargets: settings.attention.maxTargets }
      });
      const fragment = attentionPromptFragment(decision, { maxChars: settings.attention.promptMaxChars });
      return fragment ? `${fragment}\n\n` : '';
    } catch (error) {
      this.logger(`[social] 注意力片段生成失败（忽略）：${error?.message ?? error}`);
      return '';
    }
  }

  _personIdsForUsers(userIds) {
    const out = [];
    const seen = new Set();
    for (const userId of userIds) {
      if (!isQq(userId)) continue;
      const identity = this.graph.resolveAccount({ accountId: String(userId) });
      if (!identity?.personId || seen.has(identity.personId)) continue;
      seen.add(identity.personId);
      out.push(identity.personId);
    }
    return out;
  }

  _personNotesForPersons(key, personIds, userIdByPerson) {
    const notes = {};
    if (!this.relationshipStore) return notes;
    for (const personId of personIds) {
      const userId = userIdByPerson.get(personId);
      if (!userId) continue;
      try {
        const row = this.relationshipStore.get(String(key), String(userId));
        if (row) notes[personId] = `关系阶段 ${this.stageLabel(row.stage)}`;
      } catch { /* 关系读取失败不阻断 */ }
    }
    return notes;
  }

  /** 身份卡之后的社会上下文；≤ maxChars，无内容返回空串。 */
  buildContextLine(key, st, { triggerUserId = '', tiers = null } = {}) {
    const settings = this.settings();
    if (!settings.enabled || !settings.graph.enabled || !settings.prompt.enabled) return '';
    if (!this._ready() || !isSessionKey(key)) return '';
    try {
      const userIds = [];
      const seen = new Set();
      const pushUser = (id) => {
        const value = String(id ?? '').trim();
        if (!value || seen.has(value) || !isQq(value)) return;
        seen.add(value);
        userIds.push(value);
      };
      if (String(key).startsWith('private:')) pushUser(String(key).slice('private:'.length));
      pushUser(triggerUserId);
      pushUser(st?.lastIncomingUserId);
      for (const message of [...(Array.isArray(st?.recentMessages) ? st.recentMessages : [])].reverse()) {
        if (message && !message.isSelf) pushUser(message.userId);
        if (userIds.length >= settings.prompt.maxPeople) break;
      }
      if (!userIds.length) return '';
      const userIdByPerson = new Map();
      for (const userId of userIds) {
        const identity = this.graph.resolveAccount({ accountId: userId });
        if (identity?.personId) userIdByPerson.set(identity.personId, userId);
      }
      const personIds = this._personIdsForUsers(userIds).slice(0, settings.prompt.maxPeople);
      if (!personIds.length) return '';
      const topic = String(st?.activeTopics?.[0]?.text ?? '').slice(0, 40);
      const viewer = this.viewerForKey(key);
      // 人物档案：只给当前 trigger 人（其次最后说话人）一张紧凑卡片。
      // 复用 socialContext 这个 section，不新增提示词段位。
      const dossierCard = this.dossier?.buildPromptCard({
        personId: personIds[0],
        key: String(key),
        viewer,
        // 档案卡固定不超过 700 字；即使社会上下文预算调大也不跟着膨胀。
        maxChars: Math.min(700, settings.prompt.maxChars),
        now: this.now()
      }) || '';
      const out = buildSocialContext({
        graph: this.graph,
        episodes: this.episodes,
        personIds,
        viewer,
        chatKey: String(key),
        groupKey: String(key),
        topic,
        personNotes: this._personNotesForPersons(key, personIds, userIdByPerson),
        now: this.now(),
        maxChars: settings.prompt.maxChars,
        maxPeople: settings.prompt.maxPeople,
        maxEpisodes: settings.prompt.maxEpisodes,
        ...(tiers && tiers.enabled !== false && settings.contextTiers.enabled ? {
          tiers: {
            ...tiers,
            enabled: true,
            recentMessages: tiers.recentMessages ?? st?.recentMessages,
            deep: tiers.deep ?? dossierCard
          }
        } : {})
      });
      const tieredOn = Boolean(tiers && tiers.enabled !== false && settings.contextTiers.enabled);
      // 开启水层后深海已折叠进分层块，不再单独前置档案卡。
      const combined = tieredOn ? out.text : [dossierCard, out.text].filter(Boolean).join('\n\n');
      return combined ? `${combined}\n\n` : '';
    } catch (error) {
      this.logger(`[social] 社会上下文生成失败（忽略）：${error?.message ?? error}`);
      return '';
    }
  }

  /** 控制台人物列表：只返回当前会话可见的画像/边界/近期 episode，不含原始分数。 */
  listPeople({ key = '', userIds = [], limit = 30 } = {}) {
    if (!this.enabled || !this._ready() || !isSessionKey(key)) {
      return { key, people: [], episodes: [], stats: this.stats() };
    }
    const viewer = this.viewerForKey(key);
    const fromUsers = this._personIdsForUsers(Array.isArray(userIds) ? userIds : []);
    // 关系模型关闭或还没记账时，回退到当前会话 episode 的参与人，避免图谱永远空白。
    let fromEpisodes = [];
    try {
      fromEpisodes = this.episodes.list({ groupKey: key, viewer, now: this.now(), limit: 50 })
        .flatMap((episode) => episode.participants.map((p) => p.personId))
        .filter(Boolean);
    } catch { /* episode 读取失败不影响列表 */ }
    const ids = [...new Set([...fromUsers, ...fromEpisodes])].slice(0, Math.max(1, Number(limit) || 30));
    const userIdByPerson = new Map();
    for (const userId of userIds) {
      const identity = this.graph.resolveAccount({ accountId: String(userId) });
      if (identity?.personId) userIdByPerson.set(identity.personId, String(userId));
    }
    const people = [];
    for (const personId of ids) {
      const profile = this.graph.getProfile(personId, { viewer, now: this.now() });
      if (!profile) continue;
      const stageRow = userIdByPerson.get(personId)
        ? (() => { try { return this.relationshipStore?.get(key, userIdByPerson.get(personId)); } catch { return null; } })()
        : null;
      people.push({
        personId,
        name: profile.displayName || this.graph.getDisplayName(personId),
        aliases: profile.aliases,
        stageLabel: stageRow ? this.stageLabel(stageRow.stage) : '',
        recentState: profile.recentState?.text || '',
        preferences: profile.preferences.map((item) => item.text),
        boundaries: profile.boundaries.map((item) => item.text)
      });
    }
    const episodes = this.episodes.list({
      groupKey: key,
      personIds: ids.length ? ids : null,
      viewer,
      now: this.now(),
      limit: 8
    }).map((episode) => ({
      id: episode.id,
      at: episode.occurredAt,
      topic: episode.topic,
      summary: episode.summary,
      participants: episode.participants.map((p) => p.name || p.personId).filter(Boolean)
    }));
    return { key, people, episodes, stats: this.stats() };
  }

  /** 单个人物详情：当前会话可见的画像、边（只给定性标签）、近期 episode。 */
  getPersonDetail({ key = '', personId = '' } = {}) {
    if (!this.enabled || !this._ready() || !isSessionKey(key) || !personId) {
      return { key, person: null, edges: [], episodes: [] };
    }
    const viewer = this.viewerForKey(key);
    const profile = this.graph.getProfile(personId, { viewer, now: this.now() });
    if (!profile) return { key, person: null, edges: [], episodes: [] };
    const edges = [];
    for (const edge of this.graph.queryEdges({ personIds: [personId], viewer, limit: 20, now: this.now() })) {
      if (edge.kind === 'person_person') {
        const otherId = edge.from.id === personId ? edge.to.id : edge.from.id;
        edges.push({ kind: 'person_person', otherName: this.graph.getDisplayName(otherId), degree: degreeLabel(edge.weight) });
      } else if (edge.kind === 'person_group') {
        if (String(key).startsWith('group:') && edge.to.id === key) {
          edges.push({ kind: 'person_group', group: key });
        }
      } else if (edge.kind === 'person_topic') {
        edges.push({ kind: 'person_topic', topic: clean(edge.to.id, 20) });
      } else if (edge.kind === 'self_person') {
        edges.push({ kind: 'self_person', degree: degreeLabel(edge.weight) });
      }
    }
    const episodes = this.episodes.list({
      groupKey: key,
      personId,
      viewer,
      now: this.now(),
      limit: 10
    }).map((episode) => ({
      id: episode.id,
      at: episode.occurredAt,
      topic: episode.topic,
      summary: episode.summary
    }));
    return {
      key,
      person: {
        personId,
        name: profile.displayName || this.graph.getDisplayName(personId),
        aliases: profile.aliases,
        preferences: profile.preferences.map((item) => item.text),
        boundaries: profile.boundaries.map((item) => item.text),
        recentState: profile.recentState?.text || ''
      },
      edges,
      episodes
    };
  }

  ownerViewerForKey(key = '') {
    return makeSocialViewer({
      chatKey: String(key || (this.ownerQQ ? `private:${this.ownerQQ}` : '')),
      audience: 'owner',
      ownerQQ: this.ownerQQ,
      isOwnerSession: true
    });
  }

  /** 人物档案读模型：控制台传 owner:true，agent 沿用当前会话 viewer。 */
  getPersonDossier({ key = '', personId = '', viewer = null, owner = false, now = this.now() } = {}) {
    if (!this._ready()) return null;
    const ctx = viewer || (owner ? this.ownerViewerForKey(key) : this.viewerForKey(key));
    return this.dossier.getPersonDossier({ personId, key: String(key), viewer: ctx, now });
  }

  listDossiers({ key = '', userIds = [], viewer = null, owner = false, limit = 30, now = this.now() } = {}) {
    if (!this._ready()) return { key: String(key), total: 0, people: [], generatedAt: now };
    const ctx = viewer || (owner ? this.ownerViewerForKey(key) : this.viewerForKey(key));
    return this.dossier.listDossiers({ key: String(key), userIds, viewer: ctx, limit, now });
  }

  /** 只有主人会话可以改档案；agent token 一律拒绝。 */
  updatePersonDossier({ key = '', personId = '', viewer = null, action = 'update', impression = null, ownerNote, now = this.now() } = {}) {
    if (!this._ready()) return { ok: false, error: '社会记忆未启用' };
    const ctx = viewer || this.ownerViewerForKey(key);
    if (ctx?.isOwnerSession !== true) return { ok: false, error: '只有主人可以编辑人物档案' };
    const results = {};
    if (action === 'clear') {
      results.impression = this.dossier.setImpression({ personId, action: 'clear', viewer: ctx, now });
    } else if (impression !== null && impression !== undefined) {
      const summary = typeof impression === 'string' ? impression : impression?.summary;
      const visibility = typeof impression === 'object' ? impression?.visibility : undefined;
      results.impression = this.dossier.setImpression({ personId, summary, visibility, viewer: ctx, now });
    }
    if (ownerNote !== undefined) {
      results.ownerNote = this.dossier.setOwnerNote({ personId, note: ownerNote, viewer: ctx, now });
    }
    if (!Object.keys(results).length) return { ok: false, error: '没有可更新的字段' };
    this._liveDossiersCache = null;
    const failed = Object.values(results).find((item) => item && item.ok === false);
    return failed ? { ok: false, error: failed.error, ...results } : { ok: true, ...results };
  }

  consolidate({ limit = 200 } = {}) {
    const settings = this.settings();
    if (!settings.enabled || !settings.consolidate.enabled || !this._ready()) return { done: false, reason: 'disabled' };
    try {
      const result = this.episodes.consolidate({ now: this.now(), limit, graph: this.graph });
      this._liveDossiersCache = null;
      return result;
    } catch (error) {
      this.logger(`[social] 巩固失败（忽略）：${error?.message ?? error}`);
      return { done: false, error: String(error?.message ?? error) };
    }
  }

  stats() {
    if (!this._ready()) return { enabled: false };
    try {
      return {
        enabled: true,
        graph: this.graph.stats(),
        episodes: this.episodes.stats(),
        bootstrapped: this.bootstrapped
      };
    } catch (error) {
      return { enabled: true, error: String(error?.message ?? error) };
    }
  }

  /** /live 只读概览：计数 + 最近人物 + 最近经历；不返回 QQ、原始分数或 owner 备注。 */
  liveOverview({ limit = 6 } = {}) {
    if (!this.enabled || !this._ready()) return { enabled: false };
    const graph = this.graph.stats();
    const episodes = this.episodes.stats();
    const take = Math.max(1, Math.min(20, Number(limit) || 6));
    let recentPeople = [];
    let recentEpisodes = [];
    try {
      recentPeople = this.db.all(
        `SELECT p.person_id, p.display_name, p.recent_state_json, p.impression_json,
                (SELECT MAX(r.stage) FROM identities i
                   JOIN member_relationships r ON r.user_id = i.account_id
                  WHERE i.person_id = p.person_id) AS stage
           FROM person_profiles p ORDER BY p.updated_at DESC LIMIT ?`, take * 3
      ).map((row) => {
        let impression = '';
        let recent = '';
        try {
          const imp = JSON.parse(row.impression_json || 'null');
          impression = String(imp?.summary || '').trim().slice(0, 90);
        } catch {}
        try {
          const state = JSON.parse(row.recent_state_json || 'null');
          recent = String(state?.text || '').trim().slice(0, 90);
        } catch {}
        const stage = Number(row.stage);
        return {
          name: usablePersonName(row.display_name),
          stageLabel: Number.isFinite(stage) ? String(this.stageLabel(stage) || '') : '',
          impression,
          recent
        };
      }).filter((item) => item.name).slice(0, take);
    } catch { /* 旧库缺列时只显示计数 */ }
    try {
      recentEpisodes = this.db.all(
        `SELECT topic, summary, occurred_at FROM episodes ORDER BY occurred_at DESC LIMIT ?`, take
      ).map((row) => ({
        topic: String(row.topic || '').slice(0, 24),
        summary: String(row.summary || '').slice(0, 90),
        at: Number(row.occurred_at) || 0
      }));
    } catch { /* 旧库缺表时只显示计数 */ }
    return {
      enabled: true,
      persons: graph.persons,
      profiles: graph.profiles,
      edges: graph.edges,
      episodes: episodes.total,
      unconsolidated: episodes.unconsolidated,
      recentPeople,
      recentEpisodes
    };
  }

  /**
   * /live 人物档案卡：主人只读视图，带四轴原始分、QQ、别名、记忆与共同经历。
   * 只在显式 live 路径使用；getPersonDossier 的公共视图仍不返回原始分和 owner 备注。
   * 每 8 秒最多重算一次，避免 1 秒刷新的 live 页反复打库。
   */
  liveDossiers({ groupKeys = [], limit = 200, now = this.now() } = {}) {
    if (!this.enabled || !this._ready()) {
      return { enabled: false, generatedAt: now, groups: [], people: [] };
    }
    const allowed = [...new Set(
      (Array.isArray(groupKeys) ? groupKeys : [])
        .map((key) => String(key))
        .filter((key) => /^group:\d+$/.test(key))
    )].sort();
    const take = Math.max(1, Math.min(500, Number(limit) || 200));
    const cacheKey = `${allowed.join('|')}:${take}`;
    if (this._liveDossiersCache
      && this._liveDossiersCache.key === cacheKey
      && now - this._liveDossiersCache.at < 8000) {
      return this._liveDossiersCache.data;
    }
    let ids = [];
    try {
      ids = this.db.all('SELECT id FROM persons ORDER BY updated_at DESC LIMIT ?', take).map((row) => String(row.id));
    } catch { /* 旧库缺 persons */ }
    const people = [];
    for (const id of ids) {
      let card = null;
      try {
        card = this.dossier.liveCard({ personId: id, groupKeys: allowed, now });
      } catch (error) {
        this.logger(`[social] live 档案卡生成失败（忽略）：${error?.message ?? error}`);
      }
      if (!card || !usablePersonName(card.name)) continue;
      if (this.ownerQQ && (card.qq || []).includes(this.ownerQQ)) continue;
      people.push(card);
    }
    people.sort((a, b) => (b.lastInteraction || 0) - (a.lastInteraction || 0)
      || (b.updatedAt || 0) - (a.updatedAt || 0));
    const counts = new Map();
    for (const person of people) {
      for (const key of person.sharedGroups || []) {
        counts.set(key, (counts.get(key) || 0) + 1);
      }
    }
    const data = {
      enabled: true,
      generatedAt: now,
      groups: [...counts.entries()].map(([key, count]) => ({ key, count })),
      people
    };
    this._liveDossiersCache = { key: cacheKey, at: now, data };
    return data;
  }
}

export { canViewSocial, canViewEpisode };
