// Prompt 注册表：把「每轮都要的人格/协议」和「按需才用的操作手册」分开。
//
// 预设保留「宪法」：安全边界 + 工具名与一句话语义 + 行为准则；永远加载。
// 详细流程拆成 personas/playbooks/<id>.md；由本模块按当前消息/唤醒原因挑选，
// 只把真正相关的 1~2 篇注入本轮 prompt；模型也可以主动 qq_prompt_load(id)。
//
// 默认关闭：调用方在建议手册开关未开启时不会调用本模块，提示词逐字不变。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { estimateTokens, truncateToTokens } from '../kernel/prompt-budget.js';

export const PLAYBOOK_DIR = fileURLToPath(new URL('../../personas/playbooks/', import.meta.url));

/** 手册目录（id → 标题、触发词、预算、唤醒原因加分）。id 同时是文件名。 */
export const PLAYBOOKS = Object.freeze({
  media: {
    title: '看图、转发、表情与图片',
    budgetTokens: 1200,
    triggers: [/图片|照片|截图|表情|表情包|梗图|动图|gif|转发|收藏|偷图|这张|看看这个|发图/i],
    reasons: ['poke']
  },
  voice: {
    title: '发语音',
    budgetTokens: 700,
    triggers: [/语音|发条语音|想听你说话|听你说|唱歌|哼一|声音/i],
    reasons: []
  },
  life: {
    title: '提醒、天气与小游戏',
    budgetTokens: 700,
    triggers: [/提醒|叫我|闹钟|天气|下雨|气温|温度|预报|游戏|猜拳|骰子|抽签/i],
    reasons: []
  },
  search: {
    title: '联网搜索与看链接',
    budgetTokens: 700,
    triggers: [/https?:\/\//i, /搜一下|搜下|查一下|查查|最新|热搜|新闻|赛果|战报|赛程|谁赢了|比分|刚刚发生/],
    reasons: []
  },
  memory: {
    title: '记忆与记忆卫生',
    budgetTokens: 900,
    triggers: [/记得|上次|以前|说过|忘了|别忘|提醒过|答应|约定|记忆|印象/],
    reasons: []
  },
  slang: {
    title: '黑话与网络梗',
    budgetTokens: 500,
    triggers: [/梗|黑话|什么意思|缩写|谐音|网络词|这话什么/],
    reasons: []
  },
  wait: {
    title: '等、回与沉睡前观察',
    budgetTokens: 900,
    triggers: [/等一下|等我|我跟你讲|但是|所以说|然后|那个|就是|对了|还有|你知道/],
    reasons: ['replyCheck', 'clingyFollowUp']
  },
  owner: {
    title: '主人私聊控制台',
    budgetTokens: 1400,
    triggers: [/发到|发去|转到|说说|空间|分享|配置|设置|规则|频率|上限|功能|加个|改一下|修一下|不好用|有问题|代码|部署|重启|模块/i],
    reasons: [],
    ownerOnly: true
  },
  messaging: {
    title: '发送、引用、分条与节奏',
    budgetTokens: 700,
    triggers: [/分条|引用|回复我|连发|拍一拍|@你|艾特|多个人|分别回/],
    reasons: []
  }
});

const CACHE = new Map();
const VALID_ID = /^[a-z][a-z0-9-]{1,40}$/;

function fileFor(id) {
  return path.join(PLAYBOOK_DIR, `${id}.md`);
}

function parsePlaybook(id, raw) {
  const text = String(raw ?? '').replace(/^\uFEFF/, '').trim();
  const lines = text.split(/\r?\n/);
  const title = (lines.find((line) => /^#\s+/.test(line)) ?? '').replace(/^#\s+/, '').trim()
    || PLAYBOOKS[id]?.title || id;
  const summaryLine = lines.find((line) => /^摘要[:：]/.test(line)) ?? '';
  const summary = summaryLine.replace(/^摘要[:：]\s*/, '').trim();
  return { id, title, summary, text, chars: text.length, tokens: estimateTokens(text) };
}

/** 读一篇手册；文件不存在/id 非法返回 null。按 mtime 缓存，改文件不用重启。 */
export function loadPlaybook(id, { maxTokens = 0 } = {}) {
  const key = String(id ?? '').trim();
  if (!VALID_ID.test(key)) return null;
  const file = fileFor(key);
  let stat;
  try { stat = fs.statSync(file); } catch { return null; }
  const cached = CACHE.get(key);
  let entry;
  if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
    entry = cached.entry;
  } else {
    let raw;
    try { raw = fs.readFileSync(file, 'utf8'); } catch { return null; }
    entry = parsePlaybook(key, raw);
    CACHE.set(key, { mtimeMs: stat.mtimeMs, size: stat.size, entry });
  }
  const budget = Math.max(0, Number(maxTokens) || 0);
  if (!budget || entry.tokens <= budget) return { ...entry };
  return { ...entry, text: truncateToTokens(entry.text, budget), truncated: true };
}

/** 目录：只给 id/标题/摘要/体量，不返回全文，避免把整个手册库塞进上下文。 */
export function catalog({ ids = null } = {}) {
  const wanted = Array.isArray(ids) && ids.length ? ids : Object.keys(PLAYBOOKS);
  const out = [];
  for (const id of wanted) {
    const entry = loadPlaybook(id);
    if (!entry) continue;
    out.push({ id: entry.id, title: entry.title, summary: entry.summary, chars: entry.chars, tokens: entry.tokens });
  }
  return out;
}

/**
 * 按当前消息/唤醒原因挑手册。
 * 只做关键词打分，不调用模型；命中越多越靠前；带图/转发时 media 直接加权。
 * owner 手册只在主人私聊里参与，避免群友说“改一下设置”就加载控制台流程。
 */
export function selectPlaybooks({
  text = '',
  reason = '',
  ownerChat = false,
  hasMedia = false,
  hasForward = false,
  limit = 2
} = {}) {
  const source = String(text ?? '');
  const scores = new Map();
  const bump = (id, amount) => scores.set(id, (scores.get(id) ?? 0) + amount);
  for (const [id, def] of Object.entries(PLAYBOOKS)) {
    if (def.ownerOnly && !ownerChat) continue;
    let score = 0;
    for (const re of def.triggers ?? []) {
      if (re.test(source)) score += 1;
    }
    if (score && Array.isArray(def.reasons) && def.reasons.includes(reason)) score += 2;
    if (score) scores.set(id, score);
  }
  if (hasMedia) bump('media', 3);
  if (hasForward) bump('media', 2);
  if (ownerChat && (reason === 'replyCheck' || reason === 'bootstrap')) bump('owner', 0.5);
  const max = Math.max(0, Math.min(4, Number(limit) || 0));
  if (!max) return [];
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([id]) => id);
}

/**
 * 给 bridge 的段落补上 tag，并追加本轮选中的手册段。
 * 手册段 id 为 `playbook:<id>`，可截断、可丢弃。
 */
export function planSections(sections, { playbookTexts = {}, playbookIds = [] } = {}) {
  const planned = (Array.isArray(sections) ? sections : []).map((section) => ({
    ...section,
    tag: section.tag ?? 'optional'
  }));
  for (const id of playbookIds) {
    const text = playbookTexts[id];
    if (!text) continue;
    const def = PLAYBOOKS[id];
    planned.push({
      id: `playbook:${id}`,
      tag: 'playbook',
      text: `【按需手册｜${def?.title ?? id}】\n${text}\n\n`,
      priority: 86,
      trim: true
    });
  }
  return planned;
}

/**
 * 预算裁剪后仍完整保留的手册；被丢弃或截断的不算“已注入”。
 * 否则闸门会被 prompt-injected 误导，首次真实调用时不再补发完整手册。
 */
export function survivingPlaybooks(playbookIds, { dropped = [], trimmed = [] } = {}) {
  const gone = new Set([...dropped, ...trimmed]
    .map((id) => String(id ?? ''))
    .filter((id) => id.startsWith('playbook:')));
  return (Array.isArray(playbookIds) ? playbookIds : [])
    .filter((id) => !gone.has(`playbook:${id}`));
}

/** 清空文件缓存（测试/热更新用）。 */
export function clearPlaybookCache() {
  CACHE.clear();
}