// AI 知识分享的纯逻辑：类别轮换、每天目标、时间窗调度、选题去重、输出解析。
// 不碰网络/文件，方便单测。

export const AI_TIP_CATEGORIES = [
  { id: 'basics', label: 'AI 基础', hint: 'AI、机器学习、深度学习、模型各指什么；能做什么、不能做什么' },
  { id: 'learning', label: '学习原理', hint: '数据、标注、训练、推理、过拟合、监督/无监督/强化学习' },
  { id: 'llm', label: '大模型与生成', hint: 'token、参数、上下文、幻觉、提示词，为什么它像在说人话' },
  { id: 'senses', label: '看和听', hint: '图像识别、人脸、文字识别、语音识别与合成、语音助手' },
  { id: 'recommend', label: '推荐与搜索', hint: '信息流、协同过滤、排序、广告为什么好像懂你' },
  { id: 'robots', label: '机器人与自动驾驶', hint: '传感器、感知-决策-控制、为什么落地比演示难' },
  { id: 'society', label: 'AI 与社会', hint: '隐私、偏见、版权、真假信息、就业、安全边界' },
  { id: 'history', label: '历史与里程碑', hint: '图灵、深蓝、ImageNet、AlphaGo、ChatGPT 等关键节点' },
  { id: 'daily', label: '身边的 AI', hint: '手机、家电、客服、翻译、导航、拍照里的 AI' }
];

export function randomInt(min, max, rng = Math.random) {
  const a = Math.min(min, max);
  const b = Math.max(min, max);
  return Math.floor(a + rng() * (b - a + 1));
}

export function rollDailyTarget(min, max, rng = Math.random) {
  const a = Math.max(0, Math.min(10, Math.floor(Number(min) || 0)));
  const b = Math.max(0, Math.min(10, Math.floor(Number(max) || 0)));
  const lo = Math.min(a, b);
  const hi = Math.max(a, b);
  return randomInt(lo, hi, rng);
}

export function normalizeTopicKey(topic) {
  return String(topic ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .slice(0, 60);
}

function bigrams(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const set = new Set();
  if (clean.length < 2) {
    if (clean) set.add(clean);
    return set;
  }
  for (let i = 0; i < clean.length - 1; i += 1) set.add(clean.slice(i, i + 2));
  return set;
}

function unigrams(text) {
  const clean = String(text ?? '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  return new Set(clean ? [...clean] : []);
}

function dice(x, y) {
  if (!x.size || !y.size) return 0;
  let hit = 0;
  for (const gram of x) if (y.has(gram)) hit += 1;
  return hit / (x.size + y.size - hit);
}

export function similarity(a, b) {
  return dice(bigrams(a), bigrams(b));
}

/**
 * 标题相似度：中文改写常会调换语序（“为什么手机总推…” vs “手机为什么老推荐…”），
 * 只看相邻两字会漏，所以取“单字 Dice”和“双字 Dice”的较大值。
 */
export function topicSimilarity(a, b) {
  return Math.max(dice(unigrams(a), unigrams(b)), dice(bigrams(a), bigrams(b)));
}

/**
 * 判断一个选题/文案是否和近期历史重复。
 * 只看最近 recent 条；topic 相同、topic 高度相似、或整段文案高度相似都算重复。
 */
export function isDuplicateTip({ topic = '', text = '' } = {}, history = [], {
  recent = 30,
  topicThreshold = 0.65,
  textThreshold = 0.78
} = {}) {
  const key = normalizeTopicKey(topic);
  const list = (Array.isArray(history) ? history : []).slice(0, Math.max(0, recent));
  for (const item of list) {
    const otherTopic = String(item?.topic ?? '');
    if (key && normalizeTopicKey(otherTopic) === key) return { duplicate: true, reason: 'topic', with: otherTopic };
    if (topic && otherTopic && topicSimilarity(topic, otherTopic) >= topicThreshold) {
      return { duplicate: true, reason: 'topic-similar', with: otherTopic };
    }
    if (text && item?.text && similarity(text, item.text) >= textThreshold) {
      return { duplicate: true, reason: 'text-similar', with: otherTopic };
    }
  }
  return { duplicate: false };
}

/** 选一个最久没讲过的类别；从没用过的类别里随机挑，避免总是从第一个开始。 */
export function pickCategory(history = [], rng = Math.random, categories = AI_TIP_CATEGORIES) {
  const lastUse = new Map(categories.map((c) => [c.id, -1]));
  const list = Array.isArray(history) ? history : [];
  for (let i = 0; i < list.length; i += 1) {
    const id = String(list[i]?.category || '');
    if (lastUse.has(id) && lastUse.get(id) === -1) lastUse.set(id, i);
  }
  const unused = categories.filter((c) => lastUse.get(c.id) === -1);
  if (unused.length) return unused[Math.floor(rng() * unused.length) % unused.length];
  const oldest = Math.max(...[...lastUse.values()]);
  const pool = categories.filter((c) => lastUse.get(c.id) === oldest);
  return pool[Math.floor(rng() * pool.length) % pool.length];
}

export function categoryById(id, categories = AI_TIP_CATEGORIES) {
  return categories.find((c) => c.id === String(id || '')) || null;
}

/** 返回 [start, end) 两个时间戳；endHour <= startHour 视为跨夜。 */
export function windowBounds(now, startHour, endHour) {
  const sh = Math.max(0, Math.min(23, Number(startHour) || 0));
  const eh = Math.max(0, Math.min(24, Number(endHour) || 0));
  const start = new Date(now);
  start.setHours(sh, 0, 0, 0);
  const end = new Date(now);
  end.setHours(eh >= 24 ? 0 : eh, 0, 0, 0);
  if (eh >= 24 || eh <= sh) end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

export function inWindow(now, startHour, endHour) {
  const { start, end } = windowBounds(now, startHour, endHour);
  return now >= start && now < end;
}

function nextWindowStart(now, startHour, endHour) {
  const { start } = windowBounds(now, startHour, endHour);
  if (now < start) return start;
  const d = new Date(start);
  d.setDate(d.getDate() + 1);
  return d.getTime();
}

/**
 * 下一次可以发的时间：距上次至少 minGap，再加一点随机抖动；
 * 掉出当天窗口就顺延到窗口开始 + 抖动，保证“不定时”但仍落在白天。
 */
export function nextSlotAt({
  now,
  lastSentAt = 0,
  minGapMs = 75 * 60 * 1000,
  jitterMs = 90 * 60 * 1000,
  startHour = 9,
  endHour = 22
} = {}, rng = Math.random) {
  const jitter = Math.floor(rng() * Math.max(0, jitterMs));
  const from = Math.max(Number(now) || 0, (Number(lastSentAt) || 0) + (Number(minGapMs) || 0));
  const candidate = from + jitter;
  const { start, end } = windowBounds(candidate, startHour, endHour);
  if (candidate >= start && candidate < end) return candidate;
  const nextStart = nextWindowStart(candidate, startHour, endHour);
  const extra = Math.floor(rng() * Math.max(0, jitterMs));
  const { end: nextEnd } = windowBounds(nextStart, startHour, endHour);
  return Math.min(nextStart + extra, nextEnd - 60 * 1000);
}

function cleanText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').replace(/^["'“”‘’]+|["'“”‘’]+$/g, '').trim();
}

export function parseTipOutput(output, { maxChars = 200 } = {}) {
  const raw = String(output ?? '').trim();
  if (!raw) return { ok: false, error: 'empty' };
  let obj = null;
  const fenced = raw.replace(/^```[a-zA-Z]*\s*/m, '').replace(/```\s*$/m, '').trim();
  const start = fenced.indexOf('{');
  const end = fenced.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { obj = JSON.parse(fenced.slice(start, end + 1)); } catch { obj = null; }
  }
  const topic = cleanText(obj?.topic || obj?.title || '');
  const category = cleanText(obj?.category || '');
  const title = cleanText(obj?.title || obj?.headline || '');
  const text = cleanText(obj?.text || obj?.content || (obj ? '' : fenced));
  const phenomenon = cleanText(obj?.phenomenon || obj?.example || '');
  const tech = cleanText(obj?.tech || obj?.technology || '');
  const how = cleanText(obj?.how || obj?.implementation || '');
  const techName = cleanText(obj?.techName || obj?.name || '');
  const searchQuery = cleanText(obj?.searchQuery || obj?.query || '');
  const keyTerm = cleanText(obj?.keyTerm || obj?.term || '');
  const terms = (Array.isArray(obj?.terms) ? obj.terms : [])
    .map((item) => ({ name: cleanText(item?.name), plain: cleanText(item?.plain || item?.meaning || item?.desc) }))
    .filter((item) => item.name && item.plain)
    .slice(0, 3);
  if (!text) return { ok: false, error: 'empty-text' };
  if (text.length < 20) return { ok: false, error: 'too-short' };
  if (text.length > maxChars) return { ok: false, error: 'too-long' };
  if (title && title.length > 20) return { ok: false, error: 'title-too-long' };
  const derived = topic || text.replace(/^[，。！？、~～\s]+/, '').slice(0, 18);
  const finalTitle = title || derived.slice(0, 16);
  return { ok: true, title: finalTitle, topic: derived, category, text, phenomenon, tech, how, techName, terms, searchQuery, keyTerm };
}

const TRUSTED_LINK_HOSTS = [
  'kepuchina.cn', 'kepu.net.cn', 'zhihu.com', 'guokr.com', 'jiqizhixin.com', 'qbitai.com',
  'wikipedia.org', 'sspai.com', 'infoq.cn', '36kr.com', 'thepaper.cn', 'xinhuanet.com',
  'people.com.cn', 'cctv.com', 'cas.cn', 'mooc.cn', 'baike.baidu.com'
];
const BLOCKED_LINK_HOSTS = [
  'douyin.com', 'kuaishou.com', 'ixigua.com', 'toutiao.com', 'weibo.com',
  'vertexaisearch.cloud.google.com', 'google.com', 'bing.com'
];

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * 从搜索结果里挑 1–3 个延伸阅读：优先可信科普/媒体站点，并要求结果里真的出现了 keyTerm；
 * 只允许搜索真实返回的 URL，避免模型编链接。同一站点最多一条。
 * keyTerm 全部命中不到时，退一步只接受可信站点里标题相近的结果。
 */
export function pickTipLinks(results, topic, { max = 3, keyTerm = '', techName = '' } = {}) {
  const list = Array.isArray(results) ? results : [];
  const term = String(keyTerm || '').trim().toLowerCase();
  const name = String(techName || '').trim();
  const scored = [];
  const seenUrl = new Set();
  for (const item of list) {
    const url = String(item?.url || '').trim();
    if (!/^https?:\/\//i.test(url) || seenUrl.has(url)) continue;
    const host = hostOf(url);
    if (!host || BLOCKED_LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))) continue;
    if (host.endsWith('baidu.com')) {
      try { if (new URL(url).pathname.startsWith('/link')) continue; } catch {}
    }
    seenUrl.add(url);
    const title = String(item?.title || '').trim();
    const snippet = String(item?.snippet || '');
    // 中文选题不要给纯英文词典/单词页（compound、learning 这类），对长辈没有阅读价值。
    if (/[\u4e00-\u9fa5]/.test(`${topic} ${name}`) && title && !/[\u4e00-\u9fa5]/.test(title)) continue;
    const trusted = TRUSTED_LINK_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));
    let isHome = false;
    try { const pathname = new URL(url).pathname; isHome = pathname === '/' || pathname === ''; } catch {}
    const hay = `${title} ${snippet} ${url}`.toLowerCase();
    const termHit = term.length >= 2 ? hay.includes(term) : false;
    // 缩写歧义：CNN 既可能是卷积神经网络，也可能是新闻台；要求标题/摘要和中文技术名也对得上。
    const nameHit = !name || hay.includes(name.toLowerCase()) || topicSimilarity(name, `${title} ${snippet}`) >= 0.22;
    let score = 0;
    if (trusted) score += 2;
    if (isHome && !trusted) score -= 1.5;
    if (topic && title) score += topicSimilarity(topic, title) * 3;
    if (/原理|实现|如何|怎么|是什么|入门|科普|机制/.test(`${title} ${snippet}`)) score += 0.6;
    if (/广告|优惠|下载|直播|视频|课程报名/.test(title)) score -= 1.2;
    scored.push({ title: title || host, url, host, score, trusted, termHit, nameHit });
  }
  scored.sort((a, b) => b.score - a.score);
  const out = [];
  const usedHosts = new Set();
  const accept = (item) => {
    if (usedHosts.has(item.host)) return;
    usedHosts.add(item.host);
    out.push({ title: item.title.slice(0, 60), url: item.url });
  };
  const primary = term ? scored.filter((item) => item.termHit && item.nameHit) : scored.filter((item) => item.nameHit);
  for (const item of primary) {
    accept(item);
    if (out.length >= 3) break;
  }
  if (!out.length && term) {
    for (const item of scored) {
      if (!item.trusted || !item.nameHit) continue;
      accept(item);
      if (out.length >= 3) break;
    }
  }
  return out.slice(0, Math.max(1, Math.min(3, Number(max) || 3)));
}
