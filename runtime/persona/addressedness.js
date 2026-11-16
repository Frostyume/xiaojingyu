// 消息级收件人判定：这句话到底在对谁说。
// 只做纯计算，不读配置、不调网络；引用归属由调用方先解析好再传进来。

const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const QQ_RE = /^\d{5,12}$/;
const PERSON_PREFIX = 'person:';
const NAME_PREFIX = 'name:';

// 群里的常见叫法：没 @、没引用时也能认出是在叫她（config selfCallNames 会追加）。
// 通用版不内置任何角色名：调用方用配置/角色卡传入 selfCallNames。
export const DEFAULT_SELF_CALL_VARIANTS = Object.freeze([]);

const CALL_BOUNDARY_RE = /[\s，。！？、；：…—～·,\.!?;:()（）【】\[\]「」『』《》<>"“”‘’@#]/;
// 称呼左边的语气词/动词（“越来越萌了小鱼”“请问小鱼在吗”）。
const CALL_LEFT_PREFIX = new Set([...'了的啊呀哦诶欸哎喂嘿嗨嘛呢请问找叫给跟和帮让求谢是与同向替']);
// 称呼右边常见的语气词/后续词。
const CALL_RIGHT_OK = new Set([...'啊呀呢吗嘛哦喔噢啦耶诶欸哎嘿嗨哇呗咯喽嘞么吧在你您帮来快说看想好别给了']);
// 右侧紧接这些字基本是在组词（小鱼干、大肥鱼尾巴），左边的边界不算数。
const CALL_COMPOUND_SUFFIX = new Set([...'干片丸汤翅排骨刺鳞油粉丝冻皮头尾塘池缸苗饵钩网市条块罐']);

function cleanName(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function lowerNames(names) {
  return (Array.isArray(names) ? names : [names])
    .map((name) => String(name ?? '').trim().toLowerCase())
    .filter(Boolean);
}

/**
 * 从文本里认出一个“叫她”的变体称呼；认不出返回空串。
 * 中文用边界规则：右侧是标点/结尾/语气词/常见后续词，或左侧是标点/语气词/常见前缀
 * 且右侧不是在组词；ASCII 名字用词边界。单字（如「鱼」）不参与匹配。
 */
export function matchSelfCallName(text, names = []) {
  const source = String(text ?? '');
  if (!source) return '';
  const lower = source.toLowerCase();
  const tokens = [...new Map(
    (Array.isArray(names) ? names : [names])
      .map((name) => cleanName(name))
      .filter((name) => name.length >= 2)
      .map((name) => [name.toLowerCase(), name])
  )].sort((a, b) => b[0].length - a[0].length);
  for (const [token, raw] of tokens) {
    if (/^[a-z0-9][a-z0-9 ._-]*$/.test(token)) {
      const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (new RegExp(`(^|[^a-z0-9])${escaped}(?![a-z0-9])`, 'i').test(source)) return raw;
      continue;
    }
    let from = 0;
    while (from <= lower.length - token.length) {
      const index = lower.indexOf(token, from);
      if (index < 0) break;
      from = index + 1;
      const left = index > 0 ? source[index - 1] : '';
      const right = index + token.length < source.length ? source[index + token.length] : '';
      const leftOk = !left || CALL_BOUNDARY_RE.test(left) || CALL_LEFT_PREFIX.has(left);
      const rightOk = !right || CALL_BOUNDARY_RE.test(right) || CALL_RIGHT_OK.has(right);
      if (rightOk) return raw;
      if (leftOk && right && !CALL_COMPOUND_SUFFIX.has(right)) return raw;
    }
  }
  return '';
}

/**
 * @param {object} input
 * @param {Array} input.message OneBot 消息段
 * @param {string} input.selfId 机器人 QQ
 * @param {string[]} input.selfNames 机器人昵称/旧昵称
 * @param {string[]} input.selfCallNames 群里的额外叫法（会做边界匹配）
 * @param {string} input.plainText 当前消息自己的文字（不含引用原文）
 * @param {{self?:boolean, other?:boolean, otherIds?:string[]}} input.quote 引用解析结果
 * @param {boolean} input.isPrivate
 */
export function classifyAddressedness({
  message = [],
  selfId = '',
  selfNames = [],
  selfCallNames = [],
  plainText = '',
  quote = null,
  isPrivate = false
} = {}) {
  let atSelf = false;
  let atAll = false;
  const atOthers = [];
  for (const seg of Array.isArray(message) ? message : []) {
    if (seg?.type !== 'at') continue;
    const qq = String(seg.data?.qq ?? '').trim();
    if (!qq) continue;
    if (qq === 'all' || qq === 'everyone') {
      atAll = true;
    } else if (selfId && qq === String(selfId)) {
      atSelf = true;
    } else if (!atOthers.includes(qq)) {
      atOthers.push(qq);
    }
  }
  const names = lowerNames([selfNames].flat());
  const lower = String(plainText ?? '').toLowerCase();
  const quoteSelf = quote?.self === true;
  const quoteOther = quote?.other === true;
  const namedSelf = !isPrivate && names.length > 0 && names.some((name) => lower.includes(name));
  const matchedSelfCall = !isPrivate && !namedSelf && atOthers.length === 0 && !quoteOther
    ? matchSelfCallName(plainText, selfCallNames)
    : '';
  let addressedTo = 'unknown';
  if (isPrivate) addressedTo = 'self';
  else if (atAll) addressedTo = 'all';
  else if (atSelf || quoteSelf || namedSelf) addressedTo = 'self';
  // 明确 @/引用了别人时，文本里顺带出现的称呼不推翻它（“@小明 大肥鱼”）。
  else if (atOthers.length > 0 || quoteOther) addressedTo = 'other';
  else if (matchedSelfCall) addressedTo = 'self';
  return {
    atSelf,
    atOthers,
    atAll,
    quoteSelf,
    quoteOther,
    namedSelf,
    calledSelf: Boolean(matchedSelfCall),
    matchedSelfCall,
    addressedTo
  };
}

/** 唤醒提示里“是否点名你”：是 / 否 / 不确定。 */
export function addressedToSelfLabel(address) {
  if (!address) return '不确定';
  if (address.addressedTo === 'self') return '是';
  if (address.addressedTo === 'other') return '否';
  return '不确定';
}

function recentUserIdForName(name, recentMessages) {
  const wanted = cleanName(name);
  if (!wanted) return [];
  const ids = new Set();
  for (const msg of Array.isArray(recentMessages) ? recentMessages : []) {
    if (!msg || msg.isSelf) continue;
    if (cleanName(msg.sender) !== wanted) continue;
    const id = String(msg.userId ?? '').trim();
    if (QQ_RE.test(id)) ids.add(id);
  }
  return [...ids];
}

function recentNameForId(id, recentMessages) {
  const wanted = String(id ?? '').trim();
  if (!wanted) return '';
  for (const msg of [...(Array.isArray(recentMessages) ? recentMessages : [])].reverse()) {
    if (!msg || msg.isSelf) continue;
    if (String(msg.userId ?? '').trim() === wanted) return cleanName(msg.sender);
  }
  return '';
}

/** 把名字/QQ 解析成成员印象的存储 key；名字无法唯一对应时返回错误。 */
export function resolveImpressionTarget(target, recentMessages = []) {
  const raw = cleanName(target);
  if (!raw) return { ok: false, code: 'empty', error: 'target 不能为空' };
  if (FORBIDDEN_KEYS.has(raw)) return { ok: false, code: 'invalid', error: '非法的群友名字' };
  if (raw.startsWith(PERSON_PREFIX)) {
    const id = raw.slice(PERSON_PREFIX.length);
    if (!QQ_RE.test(id)) return { ok: false, code: 'invalid', error: 'person: 后面必须是 QQ 号' };
    return { ok: true, key: raw, displayName: recentNameForId(id, recentMessages) || id };
  }
  if (raw.startsWith(NAME_PREFIX)) {
    const name = raw.slice(NAME_PREFIX.length);
    if (!name) return { ok: false, code: 'invalid', error: 'name: 后面不能为空' };
    return { ok: true, key: raw, displayName: name };
  }
  if (QQ_RE.test(raw)) {
    return { ok: true, key: `${PERSON_PREFIX}${raw}`, displayName: recentNameForId(raw, recentMessages) || raw };
  }
  const ids = recentUserIdForName(raw, recentMessages);
  if (ids.length === 1) return { ok: true, key: `${PERSON_PREFIX}${ids[0]}`, displayName: raw };
  if (ids.length > 1) {
    return {
      ok: false,
      code: 'ambiguous',
      error: `「${raw}」在最近消息里对应多个 QQ（${ids.join('、')}），请改用 QQ 号指定`
    };
  }
  return {
    ok: false,
    code: 'unresolved',
    error: `最近消息里找不到「${raw}」对应的 QQ，请改用 QQ 号指定`
  };
}

function mergeImpression(previous, next) {
  const traits = Array.isArray(previous?.traits) ? previous.traits.slice(0, 10) : [];
  for (const trait of Array.isArray(next?.traits) ? next.traits : []) {
    const text = String(trait ?? '').slice(0, 50);
    if (text && !traits.includes(text)) traits.push(text);
  }
  return {
    ...previous,
    ...next,
    traits,
    interactionCount: Math.max(Number(previous?.interactionCount) || 0, Number(next?.interactionCount) || 0),
    lastSeenAt: Math.max(Number(previous?.lastSeenAt) || 0, Number(next?.lastSeenAt) || 0)
  };
}

/**
 * 旧名字 key 的一次性迁移：能唯一映射到 QQ 的转 person:<QQ>，
 * 歧义/找不到的保留但加 name: 前缀。已经带前缀的条目原样保留 ⇒ 幂等。
 */
export function migrateMemberImpressions(impressions, recentMessages = []) {
  const source = impressions && typeof impressions === 'object' ? impressions : {};
  const out = {};
  let changed = false;
  for (const [key, value] of Object.entries(source)) {
    if (FORBIDDEN_KEYS.has(key)) { changed = true; continue; }
    if (key.startsWith(PERSON_PREFIX) || key.startsWith(NAME_PREFIX)) {
      out[key] = value;
      continue;
    }
    changed = true;
    const resolved = resolveImpressionTarget(key, recentMessages);
    if (resolved.ok && resolved.key.startsWith(PERSON_PREFIX)) {
      if (out[resolved.key]) {
        out[resolved.key] = mergeImpression(out[resolved.key], value);
      } else {
        out[resolved.key] = {
          ...value,
          displayName: cleanName(value?.displayName) || resolved.displayName || cleanName(key)
        };
      }
    } else {
      const nameKey = `${NAME_PREFIX}${cleanName(key)}`;
      out[nameKey] = {
        ...value,
        displayName: cleanName(value?.displayName) || cleanName(key)
      };
    }
  }
  return { impressions: out, changed };
}

/** 提示词里展示用的可读名字。 */
export function impressionDisplayName(key, entry, recentMessages = []) {
  const stored = cleanName(entry?.displayName);
  if (stored) return stored;
  const raw = String(key ?? '');
  if (raw.startsWith(PERSON_PREFIX)) {
    return recentNameForId(raw.slice(PERSON_PREFIX.length), recentMessages) || raw.slice(PERSON_PREFIX.length);
  }
  if (raw.startsWith(NAME_PREFIX)) return raw.slice(NAME_PREFIX.length);
  return raw;
}

export const IMPRESSION_KEY_PREFIXES = Object.freeze([PERSON_PREFIX, NAME_PREFIX]);
