// 功能控制台的信息架构：板块 → 模块 → 单一总开关。
//
// 这里只放纯数据与判定函数：
//   · 控制台据此渲染卡片、说明文案和高级设置字段；
//   · bridge 据此补齐「打开主开关时应该同时打开哪些子开关」；
//   · 运行期是否真正生效仍由各模块读取 features.<id> 判定，本文件不做调度。
//
// 约定：每个模块只有 features.<id> 一个主开关。旧的 *.enabled 子开关保留在
// config.json 里做兼容，但不再在界面上重复出现；打开主开关时会自动把它们补成 true。

import { FEATURE_MODULES } from './feature-switches.js';

export const FEATURE_BOARDS = Object.freeze([
  { id: 'social', label: '聊天与社交', description: '说说、评论回复、签名和语音：她对外说话的方式。' },
  { id: 'life', label: '主动生活', description: '主动分享：她自己的好奇心。' },
  { id: 'content', label: '内容与资讯', description: '分享模块、AI 小知识、赛事资讯和群日报。' },
  { id: 'owner', label: '主人能力', description: '你在主人私聊里创建的功能中心任务。' }
]);

function dep(key, label, { enableValue, soft = false } = {}) {
  return { key, label, enableValue, soft };
}

const CARD_LIST = [
  {
    id: 'qzone',
    board: 'social',
    label: '空间说说',
    keywords: '空间 说说 qzone 朋友圈',
    description: '到点自己写一条 QQ 空间说说，前几条可以先给你过目。',
    onEffect: '按间隔生成说说；开了「发布前审核」时，每条会先私聊你确认。',
    offEffect: '不再生成、不再发布；已经排好的说说也会停下，待审草稿不能发布。',
    dangerousOff: true,
    customPanel: 'qzone',
    dependencies: [
      dep('simulation.innerLife.enabled', '内心生活总开关', { enableValue: true }),
      dep('simulation.innerLife.qzone.enabled', '空间说说子开关', { enableValue: true })
    ],
    resetKeys: [
      'simulation.innerLife.qzone.requireApproval',
      'simulation.innerLife.qzone.visibility',
      'simulation.innerLife.qzone.maxPerDay',
      'simulation.innerLife.qzone.minGapMs',
      'simulation.innerLife.qzone.maxChars',
      'simulation.innerLife.qzone.skipProbability'
    ]
  },
  {
    id: 'qzoneCommentReply',
    board: 'social',
    label: '空间评论回复',
    keywords: '空间 评论 回复 @ 提及 mention',
    description: '有人评论你的说说、或在好友动态里 @ 小鲸鱼时，自动起草回复。',
    onEffect: '定时检查评论和 @；开了「回复前审核」时，先私聊草稿，你回「发回复」才发布。',
    offEffect: '不再检查评论，也不会再发任何回复；待审草稿不能发布。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.innerLife.enabled', '内心生活总开关', { enableValue: true }),
      dep('simulation.innerLife.qzone.enabled', '空间说说子开关', { enableValue: true }),
      dep('simulation.innerLife.qzone.commentReply.enabled', '评论回复子开关', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.innerLife.qzone.commentReply.maxPerDay', label: '每天最多回复', type: 'number', min: 0, max: 50, default: 5 },
      { key: 'simulation.innerLife.qzone.commentReply.pollMs', label: '检查间隔（分钟）', type: 'number', min: 1, max: 1440, scale: 60000, default: 300000 },
      { key: 'simulation.innerLife.qzone.commentReply.mentionEnabled', label: '回复动态里的 @', type: 'boolean', default: true },
      { key: 'simulation.innerLife.qzone.commentReply.mentionMaxPerDay', label: '@ 每天最多回复', type: 'number', min: 0, max: 50, default: 5 },
      { key: 'simulation.innerLife.qzone.commentReply.requireApproval', label: '回复前先让我审核', type: 'boolean', default: true },
      { key: 'simulation.innerLife.qzone.commentReply.approvalTimeoutMs', label: '审核草稿有效期（分钟）', type: 'number', min: 5, max: 1440, scale: 60000, default: 7200000 }
    ]
  },
  {
    id: 'signature',
    board: 'social',
    label: '个性签名',
    keywords: '签名 signature 个性签名',
    description: '隔一段时间换一句 QQ 个性签名，让状态跟着心情走。',
    onEffect: '到点生成新签名；开启审核时会先私聊你确认，回「发签名」才更新。',
    offEffect: '不再自动改签名；手动「立即更新」也会被拒绝。',
    dangerousOff: true,
    dependencies: [
      dep('simulation.signature.enabled', '自动签名子开关', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.signature.minIntervalHours', label: '最短间隔（小时）', type: 'number', min: 1, max: 720, default: 12 },
      { key: 'simulation.signature.maxIntervalHours', label: '最长间隔（小时）', type: 'number', min: 1, max: 720, default: 48 },
      { key: 'simulation.signature.maxChars', label: '字数上限', type: 'number', min: 10, max: 80, default: 40 },
      { key: 'simulation.signature.requireApproval', label: '先让我审核', type: 'boolean', default: true },
      { key: 'simulation.signature.dryRun', label: '只预览，不真正更新', type: 'boolean', default: false }
    ]
  },
  {
    id: 'voice',
    board: 'social',
    label: '语音与唱歌',
    keywords: '语音 voice sing tts 声音',
    description: '小鲸鱼可以发语音消息，需要本机 TTS 服务在线。',
    onEffect: 'AI 可以按场景发语音。',
    offEffect: 'AI 不再发语音；控制台可以预览音频，但真正发送会被拒绝。',
    dangerousOff: true,
    dependencies: [
      dep('simulation.voice.enabled', 'AI 语音子开关', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.voice.maxPerMinute', label: '每分钟最多', type: 'number', min: 1, max: 60, default: 6 },
      { key: 'simulation.voice.maxPerHour', label: '每小时最多', type: 'number', min: 1, max: 240, default: 60 },
      { key: 'simulation.voice.maxSeconds', label: '单条时长上限（秒）', type: 'number', min: 1, max: 600, default: 300 },
      { key: 'simulation.voice.defaultVolume', label: '默认音量', type: 'number', min: 0.1, max: 2, step: 0.1, default: 1 },
      { key: 'simulation.voice.normalize', label: '响度归一化', type: 'boolean', default: true }
    ]
  },
  {
    id: 'share',
    board: 'life',
    label: '主动分享',
    keywords: '分享 share 好奇 curiosity 群',
    description: '看到有意思的内容，主动分享到指定群。',
    onEffect: '按间隔挑内容发到选中的群；可要求发送前先私聊你审核。',
    offEffect: '不再主动分享；待审草稿不能发布，「立即分享」也会被拒绝。',
    dangerousOff: true,
    customPanel: 'share',
    dependencies: [
      dep('simulation.innerLife.enabled', '内心生活总开关', { enableValue: true }),
      dep('simulation.innerLife.groupShare.enabled', '群分享子开关', { enableValue: true })
    ],
    resetKeys: [
      'simulation.innerLife.groupShare.maxPerDay',
      'simulation.innerLife.groupShare.minGapMs',
      'simulation.innerLife.groupShare.idleMs',
      'simulation.innerLife.groupShare.maxChars',
      'simulation.innerLife.groupShare.requireApproval'
    ]
  },
  {
    id: 'shareModule',
    board: 'content',
    label: '分享模块引擎',
    keywords: '分享模块 shareModule 自定义 主题',
    description: '用一套引擎管理 AI 知识、生活趣事、S16 和自定义领域的分享。',
    onEffect: '已通过验证的模块按排期自动发；验证期每条先私聊确认。',
    offEffect: '所有分享模块停止排期；待发草稿不能发布。',
    dangerousOff: true,
    customPanel: 'shareModule',
    dependencies: [
      dep('simulation.innerLife.enabled', '内心生活总开关', { enableValue: true }),
      dep('simulation.shareModules.enabled', '分享模块子开关', { enableValue: true })
    ],
    resetKeys: [
      'simulation.shareModules.limits.perGroupPerDay',
      'simulation.shareModules.limits.perGroupPerHour',
      'simulation.shareModules.limits.crossModuleGapMs',
      'simulation.shareModules.limits.moduleMaxPerDay',
      'simulation.shareModules.limits.globalMaxPerDay'
    ]
  },
  {
    id: 'aiTips',
    board: 'content',
    label: 'AI 小知识',
    keywords: 'AI 知识 aitips 科普',
    description: '每天在群里讲几条 AI 小知识。',
    onEffect: '在时间窗口内按间隔生成并发送，内容会避开重复。',
    offEffect: '不再生成或发送 AI 小知识；待审草稿不能发布。',
    dangerousOff: true,
    customPanel: 'aiTips',
    dependencies: [
      dep('simulation.innerLife.enabled', '内心生活总开关', { enableValue: true }),
      dep('simulation.innerLife.aiTips.enabled', 'AI 小知识子开关', { enableValue: true })
    ],
    resetKeys: [
      'simulation.innerLife.aiTips.minPerDay',
      'simulation.innerLife.aiTips.maxPerDay',
      'simulation.innerLife.aiTips.windowStartHour',
      'simulation.innerLife.aiTips.windowEndHour',
      'simulation.innerLife.aiTips.minGapMs',
      'simulation.innerLife.aiTips.maxChars',
      'simulation.innerLife.aiTips.images',
      'simulation.innerLife.aiTips.links',
      'simulation.innerLife.aiTips.maxLinks'
    ]
  },
  {
    id: 'esportsFeed',
    board: 'content',
    label: '赛事资讯',
    keywords: 'S16 赛事 esports 赛程 资讯',
    description: '定时抓取 S16 赛事资讯和赛程。',
    onEffect: '按刷新间隔抓取资讯，群订阅会收到相关消息。',
    offEffect: '停止抓取，也不再推送赛事订阅；「立即抓取」会被拒绝。',
    dangerousOff: false,
    customPanel: 'esportsFeed',
    dependencies: [
      dep('simulation.esportsFeed.enabled', '资讯源子开关', { enableValue: true })
    ],
    resetKeys: [
      'simulation.esportsFeed.refreshMs',
      'simulation.esportsFeed.maxItems',
      'simulation.esportsFeed.summaryMaxChars'
    ]
  },
  {
    id: 'dailyReport',
    board: 'content',
    label: '群日报',
    keywords: '日报 daily report 统计',
    description: '每天固定时间把群聊日报发到群里。',
    onEffect: '到点统计并发送日报；没有选群时不会发送。',
    offEffect: '不再生成和发送日报。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.dailyReport.enabled', '日报子开关', { enableValue: true }),
      dep('simulation.dailyReport.groups', '至少选择一个群', { soft: true })
    ],
    advanced: [
      { key: 'simulation.dailyReport.at', label: '发送时间', type: 'time', default: '21:30' },
      { key: 'simulation.dailyReport.maxItems', label: '最多条目', type: 'number', min: 1, max: 50, default: 8 }
    ]
  },
  {
    id: 'ownerFeature',
    board: 'owner',
    label: '功能中心',
    keywords: '功能中心 ownerFeature 定时消息 自动回复',
    description: '你在主人私聊里创建的功能中心任务：定时消息、自动回复、语音等。',
    onEffect: '按各任务的排期执行；执行前仍受会话范围和安静时段限制。',
    offEffect: '所有功能中心任务停止执行。',
    dangerousOff: false,
    customPanel: 'ownerFeature',
    dependencies: [
      dep('simulation.ownerFeatures.enabled', '功能中心子开关', { enableValue: true })
    ],
    resetKeys: []
  }
];

export const FEATURE_CARDS = Object.freeze(CARD_LIST);
export const FEATURE_CARD_BY_ID = Object.freeze(
  Object.fromEntries(FEATURE_CARDS.map((card) => [card.id, card]))
);

// 信息架构必须覆盖全部功能总开关；新增 features.<id> 时这里会直接报错，避免静默漏卡片。
const missing = FEATURE_MODULES.map((item) => item.id).filter((id) => !FEATURE_CARD_BY_ID[id]);
if (missing.length) {
  throw new Error(`功能控制台缺少模块卡片：${missing.join(', ')}`);
}

export function cardFor(id) {
  return FEATURE_CARD_BY_ID[String(id || '')] || null;
}

export function cardDefaultKeys(id) {
  const card = cardFor(id);
  if (!card) return [];
  return [...(card.resetKeys || []), ...((card.advanced || []).map((field) => field.key))];
}

/** 判断模块的依赖是否就绪；soft 依赖只提示，不阻断。 */
export function evaluateDependencies(card, cfg, valueAt) {
  return (card?.dependencies || []).map((item) => {
    const raw = typeof valueAt === 'function' ? valueAt(item.key) : valueAtPath(cfg, item.key, true);
    const ok = Array.isArray(raw) ? raw.length > 0 : Boolean(raw);
    return { key: item.key, label: item.label, ok, soft: item.soft === true, enableValue: item.enableValue };
  });
}

/** 打开主开关时需要顺带写入的子开关；返回扁平补丁。 */
export function featureEnablePatch(card) {
  const patch = {};
  for (const item of card?.dependencies || []) {
    if (item.enableValue !== undefined) patch[item.key] = item.enableValue;
  }
  return patch;
}

/** 读取 `a.b.c` 形式的配置值；用于展示和默认值回填。 */
export function valueAtPath(object, key, fallback = undefined) {
  const parts = String(key).split('.');
  let cur = object;
  for (const part of parts) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return fallback;
    cur = cur[part];
  }
  return cur === undefined ? fallback : cur;
}

function displayValue(field, raw) {
  if (field.type === 'number' && Number.isFinite(Number(raw)) && field.scale) {
    return Number(raw) / field.scale;
  }
  return raw;
}

/** 控制台高级设置字段：把 config 原值换算成可编辑的展示值。 */
export function advancedFieldsFor(card, cfg) {
  return (card?.advanced || []).map((field) => ({
    key: field.key,
    label: field.label,
    type: field.type,
    min: field.min,
    max: field.max,
    step: field.step,
    unit: field.unit || '',
    options: field.options || null,
    value: displayValue(field, valueAtPath(cfg, field.key, field.default)),
    defaultValue: displayValue(field, field.default)
  }));
}

/** 把控制台提交的展示值换算回 config 原值。 */
export function configValueFor(field, input) {
  if (field.type === 'boolean') return input === true || input === 'true';
  if (field.type === 'number') {
    const n = Number(input);
    if (!Number.isFinite(n)) return null;
    const bounded = Math.min(field.max ?? Number.MAX_SAFE_INTEGER, Math.max(field.min ?? Number.MIN_SAFE_INTEGER, n));
    return field.scale ? Math.round(bounded * field.scale) : bounded;
  }
  if (field.type === 'time') {
    const text = String(input ?? '').trim();
    const match = /^(\d{1,2}):(\d{2})$/.exec(text);
    if (!match) return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (hour > 23 || minute > 59) return null;
    return `${String(hour).padStart(2, '0')}:${match[2]}`;
  }
  return String(input ?? '').trim();
}
