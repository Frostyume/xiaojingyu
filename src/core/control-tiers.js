// 控制面分层：授权判定、风险分级、待确认动作。
//
// 这里只放纯函数与「给定路径的读写」，不碰 HTTP/QQ。桥接把运行时状态（会话令牌、
// 最近消息）传进来，测试可以逐条覆盖判定表。
//
// 设计边界（见 docs/CONTROL-TIERS-PLAN-2026-10-30.md）：
//   · 「主人在这个群刚说过话」只用于**低风险**动作；它证明不了这句话是指令，
//     所以高危动作永远不能走这条路径。
//   · 待确认动作由桥接自己记账，模型拿到的确认码在没有主人 /确认 之前一律不可用。
import crypto from 'node:crypto';
import { atomicWriteJson, readJsonSafe } from './state-file.js';

export const CONTROL_TIERS_DEFAULTS = Object.freeze({
  enabled: true,
  ownerDirectiveTtlMs: 600000,
  groupEscalationNotify: true,
  requireConfirmForHighRisk: true
});

export const PENDING_ACTION_TTL_MS = 10 * 60 * 1000;

export function normalizeControlTiers(raw) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const bool = (value, fallback) => (typeof value === 'boolean' ? value : fallback);
  const ttl = Number(input.ownerDirectiveTtlMs);
  return {
    enabled: bool(input.enabled, CONTROL_TIERS_DEFAULTS.enabled),
    ownerDirectiveTtlMs: Number.isFinite(ttl)
      ? Math.min(24 * 3600 * 1000, Math.max(60000, ttl))
      : CONTROL_TIERS_DEFAULTS.ownerDirectiveTtlMs,
    groupEscalationNotify: bool(input.groupEscalationNotify, CONTROL_TIERS_DEFAULTS.groupEscalationNotify),
    requireConfirmForHighRisk: bool(input.requireConfirmForHighRisk, CONTROL_TIERS_DEFAULTS.requireConfirmForHighRisk)
  };
}

/** 令牌 → 它绑定的会话 key。entries 为 [key, agentToken] 序列，equals 是定长比较。 */
export function findCallerKey(token, entries, equals) {
  if (typeof token !== 'string' || !token) return '';
  for (const [key, agentToken] of entries) {
    if (agentToken && equals(token, agentToken)) return key;
  }
  return '';
}

/**
 * 群内主人指令是否仍然有效：最后一条「非自己」的消息必须来自主人，且未超过窗口。
 * 群友插话会把最后发言人顶掉，所以「主人说完别人接话」天然失效。
 */
export function isOwnerDirectiveFresh(recentMessages, ownerQQ, { now = Date.now(), windowMs = CONTROL_TIERS_DEFAULTS.ownerDirectiveTtlMs } = {}) {
  const list = Array.isArray(recentMessages) ? recentMessages : [];
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const m = list[i];
    if (!m || typeof m !== 'object' || m.isSelf) continue;
    if (m.isOwner !== true) return false;
    if (ownerQQ != null && m.userId != null && String(m.userId) !== String(ownerQQ)) return false;
    const at = Number(m.time) || 0;
    return at > 0 && now - at <= windowMs;
  }
  return false;
}

/**
 * 跨会话判定的纯函数部分（令牌 → 目标）。
 * 调用方先用 agentTokenOk/ownerTokenOk 处理前两条规则，这里只决定第三条。
 */
export function decideCrossSessionAccess({ targetKey, callerKey, crossSession = false, enabled = true, directiveFresh = false }) {
  if (!callerKey) return { ok: false, status: 403, reason: 'unknown-token', error: 'agent token 无效' };
  if (!crossSession) {
    return {
      ok: false, status: 403, reason: 'target-mismatch',
      error: `没有权限操作 ${targetKey}：群会话只能操作本群；要跨群请让主人在该群直接说`
    };
  }
  if (!enabled) {
    // 关闭开关后必须与旧行为一致：旧行为只会回一句「agent token 无效」。
    return { ok: false, status: 403, reason: 'control-tiers-disabled', error: 'agent token 无效' };
  }
  if (directiveFresh) return { ok: true, grant: 'owner-directive' };
  return {
    ok: false, status: 403, reason: 'owner-directive-stale',
    error: `没有权限操作 ${targetKey}：群会话只能操作本群；要跨群请让主人在该群直接说`
  };
}

/** 高危动作白名单：只有会改变状态/对外发布的分支需要确认；读操作不打扰主人。 */
export function isHighRiskOwnerAction(route, body) {
  const input = body && typeof body === 'object' ? body : {};
  const action = String(input.action ?? '').trim();
  switch (String(route ?? '')) {
    case '/api/socialV2/owner-features':
      return ['apply', 'pause', 'resume', 'delete', 'rollback'].includes(action);
    case '/api/socialV2/dev-proposals':
      return ['propose_code', 'merge', 'reject'].includes(action);
    case '/api/socialV2/owner-config':
      return action === 'set';
    case '/api/socialV2/owner-admin':
      return ['voice_style', 'signature', 'run_share', 'run_qzone', 'pause_qzone', 'resume_qzone', 'set_share_targets'].includes(action);
    case '/api/socialV2/qzone-post':
      return input.dryRun !== true;
    default:
      return false;
  }
}

export function ownerActionCategory(route) {
  switch (String(route ?? '')) {
    case '/api/socialV2/owner-features': return '功能更新';
    case '/api/socialV2/dev-proposals': return '代码变更';
    case '/api/socialV2/owner-config': return '配置修改';
    case '/api/socialV2/qzone-post': return 'Qzone 发布';
    case '/api/socialV2/owner-admin': return '管理动作';
    default: return '高危操作';
  }
}

/** 给主人看的摘要。只写动作与关键参数，不复制整段正文。 */
export function describePendingAction(route, body) {
  const input = body && typeof body === 'object' ? body : {};
  const clip = (value, max = 40) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text.length > max ? `${text.slice(0, max)}…` : text;
  };
  switch (String(route ?? '')) {
    case '/api/socialV2/owner-config':
      return `修改配置 ${clip(input.configKey, 60)} = ${clip(JSON.stringify(input.value), 60)}`;
    case '/api/socialV2/owner-features': {
      const action = String(input.action ?? '');
      const label = input.feature?.label || input.label || input.id || '未命名';
      if (action === 'apply') return `应用功能「${clip(label, 40)}」`;
      if (action === 'delete') return `删除功能「${clip(label, 40)}」`;
      return `功能${action || '操作'}「${clip(label, 40)}」`;
    }
    case '/api/socialV2/dev-proposals': {
      const action = String(input.action ?? '');
      if (action === 'propose_code') return `提交代码提案「${clip(input.title || input.id, 40)}」`;
      if (action === 'merge') return `合并代码提案 ${clip(input.id, 40)}`;
      if (action === 'reject') return `丢弃代码提案 ${clip(input.id, 40)}`;
      return `代码提案${action || '操作'}`;
    }
    case '/api/socialV2/owner-admin': {
      const action = String(input.action ?? '');
      const extra = action === 'signature'
        ? `「${clip(input.text, 30)}」`
        : (action === 'set_share_targets' ? `（${Array.isArray(input.targets) ? input.targets.length : 0} 个群）` : '');
      return `管理动作 ${action}${extra}`;
    }
    case '/api/socialV2/qzone-post':
      return `发布空间说说「${clip(input.text, 30)}」`;
    default:
      return String(route ?? '高危操作');
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** 动作指纹：与 tool/route + 参数绑定；令牌与确认码不参与（它们不是动作本身）。 */
export function hashActionArgs(body) {
  const input = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  delete input.token;
  delete input.confirmCode;
  return crypto.createHash('sha256').update(canonicalJson(input)).digest('hex');
}

export function createPendingAction({
  route, body, summary, now = Date.now(), ttlMs = PENDING_ACTION_TTL_MS,
  randomId, randomCode
} = {}) {
  const id = randomId ? String(randomId()) : crypto.randomBytes(9).toString('hex');
  const code = randomCode ? String(randomCode()) : String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
  const stored = body && typeof body === 'object' && !Array.isArray(body) ? { ...body } : {};
  delete stored.token;
  delete stored.confirmCode;
  return {
    id,
    code,
    route: String(route ?? ''),
    argsHash: hashActionArgs(stored),
    summary: String(summary ?? '').slice(0, 200),
    body: stored,
    status: 'pending',
    createdAt: now,
    expiresAt: now + Math.max(1000, Number(ttlMs) || PENDING_ACTION_TTL_MS)
  };
}

export function pendingActionUsable(pending, { route, argsHash, now = Date.now(), requireApproved = false } = {}) {
  if (!pending || typeof pending !== 'object') return { ok: false, reason: 'not-found' };
  if (pending.status === 'used') return { ok: false, reason: 'used' };
  if (!(Number(pending.expiresAt) > now)) return { ok: false, reason: 'expired' };
  if (route && String(pending.route) !== String(route)) return { ok: false, reason: 'route-mismatch' };
  if (argsHash && String(pending.argsHash) !== String(argsHash)) return { ok: false, reason: 'args-mismatch' };
  if (requireApproved && pending.status !== 'approved') return { ok: false, reason: 'not-approved' };
  return { ok: true };
}

export function findPendingByCode(list, code) {
  const needle = String(code ?? '').trim();
  if (!needle) return null;
  return (Array.isArray(list) ? list : []).find((p) => p && String(p.code) === needle) ?? null;
}

export function prunePendingActions(list, now = Date.now()) {
  const src = Array.isArray(list) ? list : [];
  return src.filter((p) => p && Number(p.expiresAt) > now && p.status !== 'used');
}

export function pendingActionsLoad(file, read = readJsonSafe) {
  const data = read(file, [], false);
  return Array.isArray(data) ? data.filter((p) => p && typeof p === 'object') : [];
}

export function pendingActionsSave(file, list, write = atomicWriteJson) {
  const safe = (Array.isArray(list) ? list : []).map((p) => ({ ...p }));
  write(file, safe);
}
