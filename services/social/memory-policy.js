// 记忆可见性：把「关于谁」和「允许在哪用」分开。
//
// 默认：一条事实只在其来源会话可见（visibility=session）。
// 显式可选：
//   owner          只在主人私聊可见（沿用 privacy=owner 的语义）
//   shared:<会话>  共享给列出的会话（用 | 分隔）；不按「同一个人」自动扩张
//   global         全局可用；只有显式写入才允许，迁移不会把旧局部数据提升为 global
//   person         兼容旧 person 层数据：只在本人出现在场的 person 查询里可见
//
// 重要：本人身份一致不等于授权把私聊内容带进群；过滤在候选打分与拼 prompt 之前完成。

export const MEMORY_VISIBILITY_KINDS = Object.freeze(['session', 'owner', 'shared', 'global', 'person']);

const SHARED_PREFIX = 'shared:';

export function normalizeVisibility(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (raw === 'session' || raw === 'owner' || raw === 'global' || raw === 'person') return raw;
  if (raw.startsWith(SHARED_PREFIX)) {
    const sessions = raw.slice(SHARED_PREFIX.length).split('|').map((s) => s.trim()).filter(Boolean);
    if (!sessions.length) return null;
    return `${SHARED_PREFIX}${[...new Set(sessions)].join('|')}`;
  }
  return null;
}

export function sharedSessions(visibility) {
  const normalized = normalizeVisibility(visibility);
  if (!normalized || !normalized.startsWith(SHARED_PREFIX)) return [];
  return normalized.slice(SHARED_PREFIX.length).split('|').filter(Boolean);
}

export function shareWith(...sessions) {
  const keys = sessions.flat().map((s) => String(s ?? '').trim()).filter(Boolean);
  return normalizeVisibility(`${SHARED_PREFIX}${[...new Set(keys)].join('|')}`);
}

/** 读取行上的 visibility；旧行没有该列时为 null。 */
export function explicitVisibility(row) {
  if (!row || typeof row !== 'object') return null;
  return normalizeVisibility(row.visibility ?? row.visibilityRaw);
}

/**
 * 旧数据的保守映射：
 *   · 显式 visibility 优先；
 *   · core / scope=global 是历史全局记忆（迁移不写 visibility，靠 scope 识别，不算新的提升）；
 *   · person 层旧数据只在本人到场的 person 查询里可见；
 *   · 其余一律按来源会话处理（owner_key 即来源会话）。
 */
export function effectiveVisibility(row) {
  const explicit = explicitVisibility(row);
  if (explicit) return explicit;
  const scope = String(row?.scope ?? '');
  const tier = String(row?.tier ?? '');
  if (tier === 'core' || scope === 'global') return 'global';
  if (tier === 'person' || scope === 'person') return 'person';
  return 'session';
}

/** 来源会话：新行写 source_session；旧 chat/working 行退回 owner_key。 */
export function sourceSessionOf(row) {
  if (!row || typeof row !== 'object') return null;
  const explicit = row.source_session ?? row.sourceSession;
  if (explicit) return String(explicit);
  const scope = String(row.scope ?? '');
  const tier = String(row.tier ?? '');
  if (scope === 'group' || scope === 'member' || scope === 'work' || tier === 'chat' || tier === 'working') {
    const ownerKey = row.owner_key ?? row.ownerKey;
    return ownerKey ? String(ownerKey) : null;
  }
  return null;
}

function ownerPersonUin(row) {
  const key = String(row?.owner_key ?? row?.ownerKey ?? '');
  const match = /^person:(\d{1,20})$/.exec(key);
  return match ? match[1] : '';
}

export function makeViewer({ chatKey = '', audience = 'public', presentPersonIds = [], ownerQQ = '', isOwnerSession } = {}) {
  const sessionKey = String(chatKey ?? '').trim();
  const owner = String(ownerQQ ?? '').trim();
  const ownerSession = isOwnerSession === undefined
    ? audience === 'owner' && (!owner || sessionKey === `private:${owner}`)
    : isOwnerSession === true;
  return {
    sessionKey,
    audience: ownerSession ? 'owner' : 'public',
    isOwnerSession: ownerSession,
    ownerQQ: owner,
    presentPersonIds: [...new Set((Array.isArray(presentPersonIds) ? presentPersonIds : []).map((id) => String(id ?? '').trim()).filter(Boolean))]
  };
}

/** 单条事实是否允许出现在当前查看上下文。row 可以是 DB 行或 rowToFact 的结果。 */
export function canView(row, viewer) {
  if (!row) return false;
  const ctx = viewer && viewer.sessionKey !== undefined ? viewer : makeViewer(viewer || {});
  const vis = effectiveVisibility(row);
  const source = sourceSessionOf(row);
  if (vis === 'global') return true;
  if (vis === 'owner') return ctx.isOwnerSession === true;
  if (vis === 'person') {
    if (String(row.tier ?? '') !== 'person') return false;
    const uin = ownerPersonUin(row);
    return !!uin && ctx.presentPersonIds.includes(uin);
  }
  if (vis.startsWith(SHARED_PREFIX)) {
    if (!ctx.sessionKey) return false;
    if (source === ctx.sessionKey) return true;
    return sharedSessions(vis).includes(ctx.sessionKey);
  }
  // session：只认来源会话本身；没有来源会话的旧行不会凭空出现在别的会话。
  return !!source && !!ctx.sessionKey && source === ctx.sessionKey;
}

export function filterVisible(rows, viewer) {
  if (!Array.isArray(rows)) return [];
  return rows.filter((row) => canView(row, viewer));
}

export function subjectMatches(row, subjectPersonIds) {
  if (!Array.isArray(subjectPersonIds) || !subjectPersonIds.length) return true;
  const subject = row?.subject_person_id ?? row?.subjectPersonId ?? null;
  if (!subject) return true; // 旧行未解析，不因此隐藏；是否可见仍由 canView 决定
  return subjectPersonIds.includes(subject);
}
