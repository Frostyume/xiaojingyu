// 生活分享（生活日常）：随机 1–7 天一次，主动分享「一句话 + 场景贴纸」。
//
// 这里只放纯函数：排期间隔、场景加权挑选、每场景模板兜底、文本清洗、目标轮换、
// 草稿与状态归一化。真正的生成（inner-life 的 buildBasePrompt）、审批私聊和发送
// 都在 inner-life；桥接只负责配置默认值与快照。
//
// 约束：
//   · 草稿必须先经主人私聊/控制台批准才发送，本模块不产生任何发送副作用；
//   · 场景回避近期用过的（最近 8 次），无替代时才放宽；
//   · 文本一句 ≤30 字，不留中文句号；LLM 不可用/无效时用该场景的模板句；
//   · 默认关闭（开源新功能默认关），开启后仍受审批闸约束，不会自动打扰。

import { loadSceneStickers } from '../../services/media/scene-stickers.js';
import { normalizeStickerStyle } from '../../services/media/pixel-stickers.js';

export const DAY_MS = 24 * 60 * 60 * 1000;
export const LIFE_SHARE_DEFAULTS = Object.freeze({ enabled: false, minDays: 1, maxDays: 7 });
export const LIFE_SHARE_LINE_MAX = 30;
export const LIFE_SHARE_RECENT_SCENES = 8;
export const LIFE_SHARE_RECENT_RECORDS = 12;

const clampRng = (rng) => {
  const n = Number(rng());
  if (!Number.isFinite(n)) return 0;
  return Math.min(0.999999, Math.max(0, n));
};

const clampInt = (value, fallback, min, max) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/** 配置归一化：间隔按天，1–30 天，max 不得小于 min；enabled 默认关（发送仍由审批闸拦住）。 */
export function normalizeLifeShareConfig(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const minDays = clampInt(obj.minDays, LIFE_SHARE_DEFAULTS.minDays, 1, 30);
  const maxDays = Math.max(minDays, clampInt(obj.maxDays, LIFE_SHARE_DEFAULTS.maxDays, 1, 30));
  return {
    enabled: typeof obj.enabled === 'boolean' ? obj.enabled : LIFE_SHARE_DEFAULTS.enabled,
    minDays,
    maxDays
  };
}

/** 随机间隔天数（含两端）。 */
export function lifeShareIntervalDays(config, rng = Math.random) {
  const cfg = normalizeLifeShareConfig(config);
  const span = cfg.maxDays - cfg.minDays + 1;
  return cfg.minDays + Math.floor(clampRng(rng) * span);
}

/** 下一次生活分享时间：now + rand[minDays..maxDays] 天。 */
export function nextLifeShareAt(now, config, rng = Math.random) {
  return Number(now) + lifeShareIntervalDays(config, rng) * DAY_MS;
}

// 每个场景更自然的时段（本地小时，左闭右开；未列出的场景不限时段）。
const SCENE_HOURS = Object.freeze({
  waking: [[6, 10]],
  sunbathing: [[10, 15]],
  nap: [[12, 15]],
  sleeping: [[22, 24], [0, 2]],
  stars: [[19, 24], [0, 1]],
  eating: [[7, 9], [11, 14], [17, 20]],
  cooking: [[10, 13], [16, 19]],
  coffee: [[8, 11], [14, 17]],
  milktea: [[12, 18]],
  tea: [[14, 18]],
  hotpot: [[17, 21]],
  movie: [[18, 24]],
  video: [[18, 24]],
  gaming: [[18, 24]],
  library: [[9, 18]],
  studying: [[8, 22]],
  coding: [[9, 23]],
  diary: [[19, 24]],
  reading: [[8, 22]],
  bath: [[19, 23]],
  running: [[6, 9], [17, 21]],
  yoga: [[7, 10], [18, 21]],
  cycling: [[7, 10], [16, 19]],
  swimming: [[10, 20]],
  park: [[9, 18]],
  walking: [[8, 21]],
  shopping: [[10, 20]],
  cleaning: [[9, 18]],
  dishes: [[12, 21]],
  laundry: [[9, 18]],
  gardening: [[9, 17]],
  cat: [[7, 22]],
  beach: [[9, 18]],
  sea: [[9, 19]],
  camping: [[16, 22]],
  picnic: [[9, 16]],
  kite: [[10, 17]],
  snowman: [[9, 17]],
  photo: [[9, 18]],
  tired: [[18, 24]],
  slacking: [[9, 18]],
  bus: [[7, 10], [17, 20]],
  wave: [[8, 21]]
});

function hourInWindow(hour, windows) {
  return (Array.isArray(windows) ? windows : []).some(([from, to]) => hour >= from && hour < to);
}

// 每个场景的兜底模板句：一句具体、生活化、第一人称，≤30 字，不留句号。
export const LIFE_SCENE_TEMPLATES = Object.freeze({
  bath: ['热水泡了一会儿，浑身都松下来了'],
  beach: ['踩在沙滩上走了几圈，海风把头发吹乱了'],
  bored: ['什么事都不想干，先趴在桌上晾一会儿'],
  bus: ['坐在车上晃晃悠悠，看着窗外的路灯发呆'],
  cafe: ['在咖啡馆坐了一下午，续了两次水'],
  camping: ['支好帐篷，坐在外面等天黑'],
  cat: ['楼下那只猫又来了，摸了半天舍不得走'],
  cleaning: ['把屋子收拾了一遍，看着干净的地板很满足'],
  coding: ['代码跑通的瞬间，整个人都轻快了'],
  coffee: ['慢慢喝了一杯咖啡，脑子终于醒过来'],
  cooking: ['刚炒完一个菜，厨房里全是香味'],
  cycling: ['骑了一路单车，风吹在脸上很舒服'],
  daydream: ['对着窗外发了一会儿呆，什么也没想'],
  diary: ['把今天的事写进本子里，心里踏实了点'],
  dishes: ['把碗洗完码好，水池终于清爽了'],
  drawing: ['画了半页小涂鸦，虽然歪歪扭扭的'],
  eating: ['刚吃完一顿饭，胃里暖乎乎的'],
  excited: ['有件小事让我高兴了好一阵'],
  fishing: ['坐在水边等了半天，鱼没上钩也不亏'],
  gaming: ['打了两把游戏，赢了那一把特别爽'],
  gardening: ['给花浇了水，叶子看着精神了不少'],
  hotpot: ['围着热锅涮了一顿，辣得直冒汗'],
  hug: ['抱了一会儿软软的东西，心情平稳下来'],
  kite: ['把风筝放起来了，线在手里轻轻拽着'],
  laundry: ['晾好一排衣服，阳台都是洗衣粉的味道'],
  library: ['在图书馆坐了半下午，安安静静的'],
  milktea: ['喝到一杯热奶茶，甜度刚刚好'],
  movie: ['看完一场电影，出场时还沉浸在剧情里'],
  music: ['戴着耳机听了一圈歌，脚步都轻了'],
  nap: ['中午眯了二十分钟，醒来清爽不少'],
  park: ['在公园慢慢走了一圈，看见好多遛狗的人'],
  phone: ['刷了会儿手机，看到几条好笑的东西'],
  photo: ['随手拍了几张照片，光线正好'],
  picnic: ['在草地上铺开垫子，吃了一顿野餐'],
  rain: ['下了会儿雨，坐在窗边听水声'],
  reading: ['读到一本好看的书，一不小心看了小半本'],
  running: ['跑完几圈，虽然喘，但身上很舒服'],
  sea: ['看着海面发了一会儿呆，心里安静下来'],
  shopping: ['逛了一圈超市，顺手买了点想吃的东西'],
  sick: ['今天有点不舒服，先窝着缓一缓'],
  slacking: ['正事干到一半，偷偷摸鱼缓口气'],
  sleeping: ['困得不行，先睡一觉再说'],
  snack: ['拆了一包零食，边吃边看窗外'],
  snowman: ['第一次堆雪人，手冻红了也开心'],
  stars: ['抬头看了会儿星星，夜里很安静'],
  studying: ['啃了半本书，脑子有点满了'],
  sunbathing: ['中午晒了会儿太阳，整个人暖乎乎的'],
  swimming: ['在水里游了两圈，整个人都轻了'],
  tea: ['泡了一壶茶，慢慢喝到凉'],
  tired: ['今天有点累，想早点躺下'],
  travel: ['到了一个陌生的地方，看什么都新鲜'],
  video: ['追了一集剧，结尾留了个钩子'],
  waking: ['刚睡醒，脑子还在慢慢开机'],
  walking: ['沿着路边慢慢走，晚风刚好'],
  wave: ['远远看见熟人，抬手挥了挥'],
  yoga: ['跟着拉伸了一会儿，肩膀松快不少']
});

const GENERIC_TEMPLATES = Object.freeze([
  '今天过得慢慢悠悠的，没什么大事也挺好',
  '随手做了点小事，心里觉得挺踏实',
  '忙完一阵，终于能歇口气了'
]);

function sceneCatalog(style = 'pixel') {
  const map = new Map();
  for (const s of loadSceneStickers(style)) {
    if (!s || typeof s !== 'object' || !s.scene) continue;
    if (!map.has(s.scene)) map.set(s.scene, { scene: s.scene, label: s.label || s.scene, tags: Array.isArray(s.tags) ? s.tags : [] });
  }
  return [...map.values()];
}

/**
 * 按「当前时段 + 她的兴趣」加权挑一个场景，并回避最近用过的场景。
 * 近期全被排掉时放宽为全库，保证还能挑出东西。
 */
export function pickLifeScene({ now = Date.now(), interests = [], recentScenes = [], rng = Math.random, style = 'pixel', catalog = sceneCatalog(style) } = {}) {
  const all = Array.isArray(catalog) ? catalog.filter((s) => s && s.scene) : [];
  if (!all.length) return null;
  const hour = new Date(Number(now)).getHours();
  const recent = new Set(
    (Array.isArray(recentScenes) ? recentScenes : [])
      .map((scene) => String(scene ?? '').trim())
      .filter(Boolean)
      .slice(-LIFE_SHARE_RECENT_SCENES)
  );
  let pool = all.filter((s) => !recent.has(s.scene));
  if (!pool.length) pool = all;
  const topics = (Array.isArray(interests) ? interests : [])
    .map((item) => String(typeof item === 'string' ? item : item?.topic ?? '').trim().toLowerCase())
    .filter(Boolean);
  const weighted = pool.map((s) => {
    let weight = 1;
    if (hourInWindow(hour, SCENE_HOURS[s.scene])) weight += 0.8;
    let hits = 0;
    for (const topic of topics) {
      const hay = `${s.label} ${(s.tags || []).join(' ')}`.toLowerCase();
      if (hay.includes(topic)) hits += 1;
      if (hits >= 2) break;
    }
    weight += 0.6 * hits;
    return { scene: s, weight };
  });
  const total = weighted.reduce((sum, item) => sum + item.weight, 0);
  if (!(total > 0)) return weighted[weighted.length - 1]?.scene ?? null;
  let pick = clampRng(rng) * total;
  for (const item of weighted) {
    pick -= item.weight;
    if (pick < 0) return item.scene;
  }
  return weighted[weighted.length - 1].scene;
}

/** 该场景的模板句（没有就返回空串）。 */
export function lifeShareTemplate(scene, rng = Math.random) {
  const pool = LIFE_SCENE_TEMPLATES[String(scene ?? '')];
  if (!pool || !pool.length) return '';
  const idx = Math.min(pool.length - 1, Math.floor(clampRng(rng) * pool.length));
  return String(pool[idx] ?? '');
}

/** 单句清洗：取第一行、去前缀/引号/末尾句号；超长直接判不合格（不截断造半句）。 */
export function normalizeLifeShareLine(raw, maxChars = LIFE_SHARE_LINE_MAX) {
  let text = String(raw ?? '').replace(/\r/g, '\n').trim();
  if (!text) return '';
  text = text.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '');
  const first = text.split('\n').map((line) => line.trim()).find(Boolean) || '';
  const cleaned = first
    .replace(/^【?生活(?:分享|日常|场景)?】?[:：]?\s*/u, '')
    .replace(/^["'“”‘’「『]+|["'“”‘’」』]+$/g, '')
    .replace(/\s+/gu, ' ')
    .replace(/[。．.]+$/u, '')
    .trim();
  if (!cleaned || /\uFFFD/.test(cleaned)) return '';
  return cleaned.length > maxChars ? '' : cleaned;
}

function normalizeForCompare(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 近似重复检测：去掉标点空白后逐字重合度过高就视为同一句。 */
export function lifeShareTextSimilar(a, b) {
  const left = normalizeForCompare(a);
  const right = normalizeForCompare(b);
  if (!left || !right) return false;
  if (left === right) return true;
  const shorter = left.length <= right.length ? left : right;
  const longer = left.length <= right.length ? right : left;
  if (shorter.length < 4) return false;
  let hit = 0;
  for (let i = 0; i < shorter.length - 1; i += 1) {
    if (longer.includes(shorter.slice(i, i + 2))) hit += 1;
  }
  return hit / (shorter.length - 1) >= 0.75;
}

/**
 * 把模型产出转成可用的一句；不可用/不合格/与近期重复时退回该场景模板句。
 * 返回 { text, source: 'llm'|'template'|'none' }。
 */
export function resolveLifeShareLine({ raw = '', scene = '', recentTexts = [], rng = Math.random, maxChars = LIFE_SHARE_LINE_MAX } = {}) {
  const recent = (Array.isArray(recentTexts) ? recentTexts : [])
    .map((text) => normalizeLifeShareLine(text, maxChars))
    .filter(Boolean);
  const cleaned = normalizeLifeShareLine(raw, maxChars);
  if (cleaned && !recent.some((text) => lifeShareTextSimilar(cleaned, text))) {
    return { text: cleaned, source: 'llm' };
  }
  const pool = [
    ...(LIFE_SCENE_TEMPLATES[String(scene ?? '')] || []).map((text) => normalizeLifeShareLine(text, maxChars)),
    ...GENERIC_TEMPLATES.map((text) => normalizeLifeShareLine(text, maxChars))
  ].filter(Boolean);
  const fresh = pool.filter((text) => !recent.some((prev) => lifeShareTextSimilar(text, prev)));
  const usable = fresh.length ? fresh : pool;
  if (!usable.length) return { text: '', source: 'none' };
  const idx = Math.min(usable.length - 1, Math.floor(clampRng(rng) * usable.length));
  return { text: usable[idx], source: 'template' };
}

/** 目标归一化：'qzone' 或 'group:<数字>'；其他一律视为无效。 */
export function normalizeLifeShareTarget(value) {
  const raw = String(value ?? '').trim();
  if (raw === 'qzone') return 'qzone';
  const match = /^(?:group:)?(\d+)$/.exec(raw);
  return match ? `group:${match[1]}` : '';
}

export function lifeShareTargetKind(target) {
  const normalized = normalizeLifeShareTarget(target);
  if (normalized === 'qzone') return 'qzone';
  return normalized ? 'group' : '';
}

/**
 * 目标轮换：列表按 [空间, 白名单群…] 排，cursor 依次前进；
 * 上一目标仍在列表时先跳过它，避免同一处连发两次。
 */
export function pickLifeShareTarget({ groups = [], qzone = true, cursor = 0, lastTarget = '' } = {}) {
  const list = [];
  if (qzone) list.push('qzone');
  for (const group of Array.isArray(groups) ? groups : []) {
    const target = normalizeLifeShareTarget(group);
    if (target && target !== 'qzone' && !list.includes(target)) list.push(target);
  }
  if (!list.length) return { target: '', kind: '', cursor: 0 };
  let idx = clampInt(cursor, 0, 0, list.length - 1);
  let target = list[idx];
  const last = normalizeLifeShareTarget(lastTarget);
  if (target === last && list.length > 1) {
    idx = (idx + 1) % list.length;
    target = list[idx];
  }
  return { target, kind: lifeShareTargetKind(target), cursor: (idx + 1) % list.length };
}

/** 生活分享的持久状态：轮换游标与近期记录（供场景回避/重复检测）。排期在 state.next.lifeShare。 */
export function normalizeLifeShareState(raw) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const recent = (Array.isArray(obj.recent) ? obj.recent : [])
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const text = String(item.text ?? '').trim().slice(0, 80);
      if (!text) return null;
      return {
        at: Number(item.at) || 0,
        scene: String(item.scene ?? '').trim(),
        text,
        target: normalizeLifeShareTarget(item.target),
        status: String(item.status ?? '').slice(0, 12)
      };
    })
    .filter(Boolean)
    .slice(-LIFE_SHARE_RECENT_RECORDS);
  return {
    cursor: Math.max(0, Math.floor(Number(obj.cursor) || 0)),
    lastTarget: normalizeLifeShareTarget(obj.lastTarget),
    lastSentAt: Number(obj.lastSentAt) || 0,
    recent
  };
}

/** 待审草稿校验：文本/场景/目标/有效期缺一不可，坏数据直接丢弃（返回 null）。 */
export function normalizePendingLifeShare(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const text = normalizeLifeShareLine(raw.text, Math.max(LIFE_SHARE_LINE_MAX, Number(raw.maxChars) || LIFE_SHARE_LINE_MAX));
  const scene = String(raw.scene ?? '').trim();
  const target = normalizeLifeShareTarget(raw.target);
  const createdAt = Number(raw.createdAt) || 0;
  const expiresAt = Number(raw.expiresAt) || 0;
  if (!text || !scene || !target) return null;
  if (!(createdAt > 0) || !(expiresAt > createdAt)) return null;
  const sceneFile = /^[A-Za-z0-9._-]+\.png$/.test(String(raw.sceneFile ?? '')) ? String(raw.sceneFile) : '';
  return {
    text,
    scene,
    style: normalizeStickerStyle(raw.style),
    sceneLabel: String(raw.sceneLabel ?? '').slice(0, 20),
    sceneFile,
    target,
    targetKind: lifeShareTargetKind(target),
    createdAt,
    expiresAt
  };
}

/** 组装待审草稿（纯数据，不发送）。 */
export function buildLifeShareDraft({ text, scene, style = 'pixel', sceneLabel = '', sceneFile = '', target, now = Date.now(), ttlMs = 2 * 3600 * 1000 }) {
  const normalizedText = normalizeLifeShareLine(text);
  if (!normalizedText || !scene || !normalizeLifeShareTarget(target)) return null;
  return {
    text: normalizedText,
    scene: String(scene),
    style: normalizeStickerStyle(style),
    sceneLabel: String(sceneLabel || '').slice(0, 20),
    sceneFile: /^[A-Za-z0-9._-]+\.png$/.test(String(sceneFile)) ? String(sceneFile) : '',
    target: normalizeLifeShareTarget(target),
    targetKind: lifeShareTargetKind(target),
    createdAt: Number(now) || Date.now(),
    expiresAt: (Number(now) || Date.now()) + Math.max(60000, Number(ttlMs) || 2 * 3600 * 1000)
  };
}
