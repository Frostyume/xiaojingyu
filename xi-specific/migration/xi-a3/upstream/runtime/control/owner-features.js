// 主人功能的统一规格：校验、排期模拟、预览描述。
// 纯逻辑；不写配置、不发消息。

import { capabilityById } from './owner-capabilities.js';

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const FEATURE_TYPES = new Set(['scheduled_message', 'auto_reply', 'voice_message', 'qzone_post', 'share_module', 'code_feature']);

function clampText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeTargets(raw) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : []);
  return [...new Set(list.map((v) => String(v || '').trim()).filter(Boolean))];
}

function parseTime(value) {
  const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : null;
}

export function normalizeOwnerFeature(raw = {}, id = '') {
  const type = String(raw.type || raw.capability || 'scheduled_message');
  const capability = capabilityById(type) || capabilityById(raw.capability || '');
  const trigger = raw.trigger && typeof raw.trigger === 'object' ? raw.trigger : {};
  const action = raw.action && typeof raw.action === 'object' ? raw.action : {};
  return {
    id: String(raw.id || id || '').trim(),
    label: clampText(raw.label || raw.name || id, 40),
    type,
    capability: capability?.id || String(raw.capability || type),
    enabled: raw.enabled !== false,
    targets: normalizeTargets(raw.targets ?? raw.target),
    trigger: {
      type: String(trigger.type || (type === 'auto_reply' ? 'keyword' : 'daily')),
      times: Array.isArray(trigger.times) ? trigger.times.map((t) => String(t).trim()).filter(Boolean).slice(0, 8) : [],
      days: Array.isArray(trigger.days) ? trigger.days.map((d) => String(d).toLowerCase()).filter((d) => DAY_NAMES.includes(d)) : [],
      at: String(trigger.at || '').trim(),
      keywords: Array.isArray(trigger.keywords) ? trigger.keywords.map((k) => clampText(k, 30)).filter(Boolean).slice(0, 10) : [],
      match: String(trigger.match || 'contains')
    },
    action: {
      type: String(action.type || (type === 'voice_message' ? 'send_voice' : type === 'qzone_post' ? 'qzone_post' : 'send_text')),
      text: clampText(action.text || raw.text || '', Number(action.maxChars) || 600),
      image: clampText(action.image || '', 80),
      mood: ['happy', 'sad', 'angry', 'shy', 'sleepy', 'proud', 'playful'].includes(action.mood) ? action.mood : ''
    },
    approval: {
      mode: ['none', 'always'].includes(raw.approval?.mode) ? raw.approval.mode : 'none',
      requireCodeApproval: raw.approval?.requireCodeApproval !== false
    },
    createdAt: Number(raw.createdAt) || 0,
    updatedAt: Number(raw.updatedAt) || 0
  };
}

export function validateOwnerFeature(feature, { allowedTargets = [], now = Date.now() } = {}) {
  const errors = [];
  if (!/^[a-z][a-z0-9_]{1,31}$/.test(feature.id)) errors.push('id 必须是 2–32 位小写字母/数字/下划线');
  if (!FEATURE_TYPES.has(feature.type)) errors.push(`不支持的功能类型 ${feature.type}`);
  if (!feature.targets.length) errors.push('至少选择一个目标');
  if (Array.isArray(allowedTargets) && allowedTargets.length) {
    for (const target of feature.targets) {
      if (target === 'qzone' || target === 'self') continue;
      if (!allowedTargets.includes(target)) errors.push(`目标不在白名单：${target}`);
    }
  }
  if (feature.type === 'share_module') {
    errors.push('分享模块请用 qq_share_module_* 工具创建（已有验证期/预览/去重）');
  }
  if (feature.type === 'code_feature') {
    // 代码类功能只允许走提案通道，不在这里直接应用。
    return { ok: errors.length === 0, errors };
  }
  if (feature.type === 'auto_reply') {
    if (!feature.trigger.keywords.length) errors.push('自动回复至少需要一个关键词');
    if (feature.action.type !== 'send_text' && feature.action.type !== 'send_voice') errors.push('自动回复只支持文本或语音');
  } else {
    if (feature.trigger.type === 'daily') {
      if (!feature.trigger.times.length) errors.push('至少设置一个发送时间');
      for (const time of feature.trigger.times) if (!parseTime(time)) errors.push(`时间格式不对：${time}（应为 HH:MM）`);
    } else if (feature.trigger.type === 'once') {
      const at = Date.parse(feature.trigger.at);
      if (!Number.isFinite(at) || at <= now) errors.push('一次性功能需要一个未来的时间');
    } else if (feature.trigger.type !== 'keyword') {
      errors.push(`不支持的触发方式 ${feature.trigger.type}`);
    }
  }
  if (!feature.action.text) errors.push('内容不能为空');
  const max = feature.action.type === 'send_voice' || feature.type === 'voice_message'
    ? 60
    : feature.type === 'qzone_post' ? 150 : 600;
  if (feature.action.text.length > max) errors.push(`内容超长（最多 ${max} 字）`);
  return { ok: errors.length === 0, errors };
}

export function nextOwnerFeatureRuns(feature, now = Date.now(), count = 3) {
  const at = Number(now) || Date.now();
  if (feature.trigger.type === 'once') {
    const once = Date.parse(feature.trigger.at);
    return Number.isFinite(once) && once > at ? [once] : [];
  }
  if (feature.trigger.type !== 'daily') return [];
  const out = [];
  const start = new Date(at);
  for (let dayOffset = 0; dayOffset < 14 && out.length < count; dayOffset += 1) {
    const day = new Date(start);
    day.setDate(day.getDate() + dayOffset);
    const dayName = DAY_NAMES[day.getDay()];
    if (feature.trigger.days.length && !feature.trigger.days.includes(dayName)) continue;
    const times = feature.trigger.times
      .map(parseTime)
      .filter(Boolean)
      .sort((a, b) => a.hour * 60 + a.minute - (b.hour * 60 + b.minute));
    for (const time of times) {
      const d = new Date(day);
      d.setHours(time.hour, time.minute, 0, 0);
      if (d.getTime() > at) out.push(d.getTime());
      if (out.length >= count) break;
    }
  }
  return out;
}

export function renderOwnerFeaturePreview(feature, { now = Date.now(), targetLabels = {} } = {}) {
  const runs = nextOwnerFeatureRuns(feature, now, 3);
  const targetText = feature.targets.map((t) => targetLabels[t] || t).join('、');
  const scheduleText = feature.type === 'auto_reply'
    ? `命中关键词：${feature.trigger.keywords.join(' / ')}`
    : runs.length
      ? runs.map((t) => new Date(t).toLocaleString('zh-CN', { hour12: false })).join('；')
      : '未安排';
  const warnings = [];
  if (!runs.length && feature.type !== 'auto_reply') warnings.push('当前排期为空');
  if (feature.type === 'voice_message') warnings.push('语音会占用一次 TTS 合成，内容最多 60 字');
  if (feature.type === 'qzone_post') warnings.push('会自动发布到 QQ 空间');
  if (feature.type === 'code_feature') warnings.push('代码类功能只生成提案，不直接改主工作区');
  return {
    id: feature.id,
    label: feature.label,
    type: feature.type,
    targets: feature.targets,
    targetText,
    scheduleText,
    runs,
    action: feature.action,
    enabled: feature.enabled,
    warnings,
    text: feature.type === 'auto_reply'
      ? `当消息命中「${feature.trigger.keywords.join('、')}」时回复：${feature.action.text}`
      : `将于 ${scheduleText} 向 ${targetText} 发送：${feature.action.text}`
  };
}
