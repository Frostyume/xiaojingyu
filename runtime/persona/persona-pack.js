// 结构化人格包（persona pack）。
//
// 角色卡（`personas/<name>.md`）仍是人格的**权威**文本；人格包是同一人格的结构化补充，
// 用来：① 让语气/情绪/语音映射可机器读取；② 可导入导出、按群复用；③ 不破坏现有 Markdown 流程。
//
// 约定：
//   · 文件位置 `personas/<name>.persona.json`，与角色卡同名；
//   · 缺失/损坏时**静默回退** Markdown（只由调用方记录一次告警）；
//   · 所有字符串限长、数值 clamp 到 0~1；拒绝 __proto__ 等危险键。

import fs from 'node:fs';
import path from 'node:path';

export const PERSONA_PACK_VERSION = 1;
const MAX_STRING = 400;
const MAX_LIST = 20;
const MAX_ITEM = 300;

function clamp01(value, fallback = 0.5) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function cleanString(value, max = MAX_STRING) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function cleanList(value, maxItems = MAX_LIST, maxItem = MAX_ITEM) {
  if (!Array.isArray(value)) return [];
  return value
    .map((v) => cleanString(v, maxItem))
    .filter(Boolean)
    .slice(0, maxItems);
}

function cleanMap(value, { numeric = false, maxKeys = 12 } = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out = {};
  for (const [k, v] of Object.entries(value)) {
    const key = cleanString(k, 40);
    if (!key || ['__proto__', 'constructor', 'prototype'].includes(key)) continue;
    out[key] = numeric
      ? (Number.isFinite(Number(v)) ? Number(v) : 1)
      : cleanString(v, 200);
    if (Object.keys(out).length >= maxKeys) break;
  }
  return out;
}

/** 校验并归一化人格包；返回 { ok, errors, value }。 */
export function validatePersonaPack(raw) {
  const errors = [];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['人格包必须是 JSON 对象'], value: null };
  }
  const name = cleanString(raw.name, 60);
  if (!name) errors.push('name 不能为空');
  const identity = raw.identity && typeof raw.identity === 'object' && !Array.isArray(raw.identity) ? raw.identity : {};
  const tone = raw.tone && typeof raw.tone === 'object' && !Array.isArray(raw.tone) ? raw.tone : {};
  const voice = raw.voice && typeof raw.voice === 'object' && !Array.isArray(raw.voice) ? raw.voice : {};
  const value = {
    version: PERSONA_PACK_VERSION,
    name,
    identity: {
      displayName: cleanString(identity.displayName, 60),
      species: cleanString(identity.species, 40),
      age: cleanString(identity.age, 20),
      note: cleanString(identity.note, 200)
    },
    tone: {
      warmth: clamp01(tone.warmth, 0.7),
      verbosity: clamp01(tone.verbosity, 0.4),
      humor: clamp01(tone.humor, 0.5),
      clinginess: clamp01(tone.clinginess, 0.5)
    },
    examples: cleanList(raw.examples),
    boundaries: cleanList(raw.boundaries),
    emotions: cleanMap(raw.emotions),
    voice: {
      refAudio: cleanString(voice.refAudio, MAX_ITEM),
      emotionRefs: cleanMap(voice.emotionRefs),
      emotionSpeed: cleanMap(voice.emotionSpeed, { numeric: true })
    }
  };
  if (value.voice.emotionSpeed) {
    for (const [k, v] of Object.entries(value.voice.emotionSpeed)) {
      value.voice.emotionSpeed[k] = Math.min(1.5, Math.max(0.7, Number(v) || 1));
    }
  }
  return { ok: errors.length === 0, errors, value };
}

/** 读 sidecar；不存在返回 null；损坏/非法抛错（由调用方决定是否降级）。 */
export function loadPersonaPack(rolesDir, name) {
  const safe = String(name ?? '').trim();
  if (!safe || safe.includes('..') || /[\\/]/.test(safe)) return null;
  const file = path.join(rolesDir, `${safe}.persona.json`);
  if (!fs.existsSync(file)) return null;
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const checked = validatePersonaPack(raw);
  if (!checked.ok) {
    const error = new Error(`人格包校验失败：${checked.errors.join('；')}`);
    error.pack = checked.value;
    throw error;
  }
  return checked.value;
}

export function personaPackPath(rolesDir, name) {
  return path.join(rolesDir, `${String(name)}.persona.json`);
}

export function savePersonaPack(rolesDir, name, pack) {
  const checked = validatePersonaPack(pack);
  if (!checked.ok) return { ok: false, errors: checked.errors };
  fs.mkdirSync(rolesDir, { recursive: true });
  fs.writeFileSync(personaPackPath(rolesDir, name), `${JSON.stringify(checked.value, null, 2)}\n`, 'utf8');
  return { ok: true, value: checked.value, file: personaPackPath(rolesDir, name) };
}

/** 渲染成可追加到角色卡后的短段；没有可用内容返回空串。 */
export function renderPersonaPack(pack) {
  if (!pack) return '';
  const lines = [];
  const id = pack.identity ?? {};
  const idBits = [id.displayName, id.species, id.age].filter(Boolean);
  if (idBits.length) lines.push(`- 身份：${idBits.join(' / ')}${id.note ? `；${id.note}` : ''}`);
  const tone = pack.tone ?? {};
  const toneBits = [];
  if (Number.isFinite(tone.warmth)) toneBits.push(tone.warmth >= 0.7 ? '偏暖' : tone.warmth <= 0.35 ? '偏冷' : '温和');
  if (Number.isFinite(tone.verbosity)) toneBits.push(tone.verbosity >= 0.65 ? '话稍多' : tone.verbosity <= 0.3 ? '短句为主' : '长度适中');
  if (Number.isFinite(tone.humor)) toneBits.push(tone.humor >= 0.6 ? '可以接梗' : '少开玩笑');
  if (Number.isFinite(tone.clinginess)) toneBits.push(tone.clinginess >= 0.65 ? '对主人可以黏一点' : '保持分寸');
  if (toneBits.length) lines.push(`- 语气：${toneBits.join('、')}`);
  const emotions = Object.entries(pack.emotions ?? {});
  if (emotions.length) lines.push(`- 情绪表达：${emotions.map(([k, v]) => `${k}=${v}`).join('；')}`);
  if (pack.examples?.length) lines.push(`- 说话示例：\n${pack.examples.slice(0, 4).map((e) => `  · ${e}`).join('\n')}`);
  if (pack.boundaries?.length) lines.push(`- 边界：${pack.boundaries.slice(0, 6).join('；')}`);
  if (!lines.length) return '';
  return `【结构化人格包】以下与角色卡配合使用；若冲突，以角色卡为准。\n${lines.join('\n')}\n`;
}
