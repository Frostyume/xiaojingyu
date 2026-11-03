// 功能控制台的信息架构：板块 → 模块 → 单一总开关。
//
// 这里只放纯数据与判定函数：
//   · 控制台据此渲染卡片、说明文案和高级设置字段；
//   · bridge 据此补齐「打开主开关时应该同时打开哪些子开关」；
//   · 运行期是否真正生效仍由各模块读取 features.<id> 判定，本文件不做调度。
//
// 约定：每个模块只有一个主开关。默认落在 features.<id>；群聊剧场这类原本就
// 「默认开启、只有显式 false 才关闭」的模块用 configKey 直接复用原配置键，
// 避免升级后多出一层默认关闭的 features.* 把已有行为静默关掉。
// 打开主开关时会自动补齐依赖里的子开关（enableValue）。
// 「群聊剧场」和「分享引擎」是板块级总闸：board.master 指向对应开关，下面的
// 内容模块和旧版主动分享都要再过总闸一次。本仓库没有生活管家（lifeButler）。

import { FEATURE_MODULES, featureEnabled } from './feature-switches.js';

export const FEATURE_BOARDS = Object.freeze([
  {
    id: 'chat',
    label: '群聊剧场',
    master: 'groupChat',
    description: '群聊本身的总闸和常用行为：回不回、冒不冒泡、用不用表情。'
  },
  {
    id: 'shareEngine',
    label: '分享引擎',
    master: 'shareModule',
    description: '总闸统一管理所有主动分享；下面的模块各自有开关，只开你想要的。'
  },
  { id: 'social', label: '聊天与社交', description: '说说、评论回复、签名和语音：她对外说话的方式。' },
  { id: 'ops', label: '群运营', description: '面向整个群的固定推送，比如每日群日报。' },
  { id: 'owner', label: '主人能力', description: '你在主人私聊里创建的功能中心任务。' }
]);

function dep(key, label, { enableValue, soft = false, fallback = true } = {}) {
  return { key, label, enableValue, soft, fallback };
}

const SHARE_ENGINE_DEPS = [
  dep('features.shareModule', '分享引擎总闸', { enableValue: true }),
  dep('simulation.innerLife.enabled', '内心生活总开关', { enableValue: true, fallback: false }),
  dep('simulation.shareModules.enabled', '分享模块子开关', { enableValue: true })
];

const CARD_LIST = [
  // ── 群聊剧场板块 ────────────────────────────────────────────────────────
  {
    id: 'groupChat',
    board: 'chat',
    boardMaster: true,
    configKey: 'simulation.enabled',
    label: '群聊剧场总闸',
    keywords: '群聊 剧场 simulation 回复 仿真 总闸',
    description: '控制整套群聊仿真：群消息是否进入自动回复、冒泡和表情流程。',
    onEffect: '群消息按各自开关进入回复、主动冒泡和表情流程。',
    offEffect: '停止群聊自动行为；主人私聊和控制台操作不受影响。',
    dangerousOff: true,
    dependencies: []
  },
  {
    id: 'chatActivity',
    board: 'chat',
    configKey: 'simulation.wake.defaultMode',
    enabledValue: 'active',
    disabledValue: 'diving',
    label: '活跃控制',
    keywords: '活跃 潜水 深潜 active diving 唤醒 全局控制',
    description: '全局控制所有群聊会话的默认唤醒模式；开启=活跃，关闭=潜水。优先级高于会话级设置。',
    onEffect: '全局活跃：群消息更容易唤醒她；覆盖会话级「潜水」设置，深潜加固暂不生效。',
    offEffect: '全局潜水：只有符合触发条件的消息才会唤醒她；再开深潜则仅主人直接 @ 才回复。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.enabled', '群聊剧场总闸', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.activityControl.deepDive', label: '深潜模式（仅主人直接 @ 才回复）', type: 'boolean', default: false }
    ]
  },
  {
    id: 'chatProactive',
    board: 'chat',
    configKey: 'simulation.proactive.enabled',
    label: '主动冒泡',
    keywords: '主动 冒泡 proactive 冷场 主动机会',
    description: '群聊冷场一段时间后，她按概率主动冒个泡。',
    onEffect: '空闲一段时间后按概率主动发消息，夜间静默时段仍会避开。',
    offEffect: '不再主动冒泡；被叫到仍会正常回复。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.enabled', '群聊剧场总闸', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.proactive.idleThresholdMs', label: '安静多久后考虑冒泡（分钟）', type: 'number', min: 1, max: 1440, scale: 60000, default: 900000 },
      { key: 'simulation.proactive.probability', label: '触发概率', type: 'number', min: 0, max: 1, step: 0.05, default: 0.3 }
    ]
  },
  {
    id: 'chatStickers',
    board: 'chat',
    configKey: 'simulation.sticker.enabled',
    label: '表情包',
    keywords: '表情包 sticker 收藏 斗图',
    description: '她可以从群友发的表情包里挑图回发，也会自动收集新表情。',
    onEffect: '允许在回复中发表情包，并继续自动收集群里的表情。',
    offEffect: '不再发表情包，也不再收集；文字回复不受影响。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.enabled', '群聊剧场总闸', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.sticker.collect.enabled', label: '自动收集群里的新表情', type: 'boolean', default: true }
    ]
  },
  {
    id: 'chatNightQuiet',
    board: 'chat',
    configKey: 'simulation.nightQuiet.enabled',
    label: '夜间静默',
    keywords: '夜间 静默 nightQuiet 免打扰 睡觉',
    description: '在设定时段内不主动冒泡、不打扰；消息仍会照常收到。',
    onEffect: '静默时段内暂停主动冒泡和内心生活的外发动作。',
    offEffect: '夜间也按普通时间处理，主动行为不再避开深夜。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.enabled', '群聊剧场总闸', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.nightQuiet.start', label: '静默开始', type: 'time', default: '23:30' },
      { key: 'simulation.nightQuiet.end', label: '静默结束', type: 'time', default: '08:30' }
    ]
  },

  // ── 分享引擎板块 ────────────────────────────────────────────────────────
  {
    id: 'shareModule',
    board: 'shareEngine',
    boardMaster: true,
    label: '分享引擎总闸',
    keywords: '分享模块 shareModule 自定义 主题 引擎',
    description: '统一管理所有主动分享；总闸关闭后，下面的模块都会停止排期和发布。',
    onEffect: '已通过验证的模块按排期自动发；验证期每条先私聊确认。',
    offEffect: '所有分享模块（包括旧版主动分享和赛事资讯）停止；待发草稿不能发布。',
    dangerousOff: true,
    customPanel: 'shareModule',
    dependencies: [
      dep('simulation.innerLife.enabled', '内心生活总开关', { enableValue: true, fallback: false }),
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
    board: 'shareEngine',
    label: 'AI 知识分享',
    keywords: 'AI 知识 aitips 科普 ai_tips',
    description: '每天在群里讲几条 AI 小知识（ai_tips 模块）。',
    onEffect: '在时间窗口内按间隔生成并发送，内容会避开重复。',
    offEffect: '不再生成或发送 AI 小知识；待审草稿不能发布。',
    dangerousOff: true,
    customPanel: 'aiTips',
    dependencies: [
      ...SHARE_ENGINE_DEPS,
      dep('simulation.innerLife.aiTips.enabled', 'AI 小知识子开关', { enableValue: true, fallback: false })
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
    id: 'lifeFun',
    board: 'shareEngine',
    label: '生活趣闻',
    keywords: '生活趣闻 life_fun 趣事 生活',
    description: '从生活话题里挑内容分享到群里（life_fun 模块）。',
    onEffect: '按分享引擎的排期自动挑选并发布生活趣闻。',
    offEffect: '不再发布生活趣闻；其他分享模块不受影响。',
    dangerousOff: false,
    dependencies: [...SHARE_ENGINE_DEPS]
  },
  {
    id: 'financeTips',
    board: 'shareEngine',
    label: '金融小知识',
    keywords: '金融 理财 finance_tips 钱',
    description: '用生活化的例子讲金融常识（finance_tips 模块）。',
    onEffect: '按分享引擎的排期生成并发布金融小知识。',
    offEffect: '不再发布金融小知识；其他分享模块不受影响。',
    dangerousOff: false,
    dependencies: [...SHARE_ENGINE_DEPS]
  },
  {
    id: 'llmTips',
    board: 'shareEngine',
    label: '大模型科普',
    keywords: '大模型 LLM llm_tips AI 科普',
    description: '解释大模型怎么工作、普通人怎么用（llm_tips 模块）。',
    onEffect: '按分享引擎的排期生成并发布大模型科普。',
    offEffect: '不再发布大模型科普；其他分享模块不受影响。',
    dangerousOff: false,
    dependencies: [...SHARE_ENGINE_DEPS]
  },
  {
    id: 's16Share',
    board: 'shareEngine',
    label: 'S16 分享',
    keywords: 'S16 赛事 分享 s16 赛程',
    description: '把赛事资讯和赛程分享到群里（s16 模块）；抓取本身在「赛事资讯」里控制。',
    onEffect: '按分享引擎的排期把 S16 内容发到目标群。',
    offEffect: '不再分享 S16 内容；赛事资讯抓取仍可单独使用。',
    dangerousOff: false,
    dependencies: [...SHARE_ENGINE_DEPS]
  },
  {
    id: 'customShare',
    board: 'shareEngine',
    label: '自定义分享模块',
    keywords: '自定义 分享模块 custom 自建',
    description: '你在控制台自建的任何分享模块，统一由这个开关控制。',
    onEffect: '所有自建模块按各自排期运行。',
    offEffect: '所有自建模块停止；内置模块不受影响。',
    dangerousOff: false,
    dependencies: [...SHARE_ENGINE_DEPS]
  },
  {
    id: 'esportsFeed',
    board: 'shareEngine',
    label: '赛事资讯',
    keywords: 'S16 赛事 esports 赛程 资讯',
    description: '定时抓取 S16 赛事资讯和赛程，供分享模块和群订阅使用。',
    onEffect: '按刷新间隔抓取资讯，群订阅会收到相关消息。',
    offEffect: '停止抓取，也不再推送赛事订阅；「立即抓取」会被拒绝。',
    dangerousOff: false,
    customPanel: 'esportsFeed',
    dependencies: [
      dep('features.shareModule', '分享引擎总闸', { enableValue: true }),
      dep('simulation.esportsFeed.enabled', '资讯源子开关', { enableValue: true })
    ],
    resetKeys: [
      'simulation.esportsFeed.refreshMs',
      'simulation.esportsFeed.maxItems',
      'simulation.esportsFeed.summaryMaxChars'
    ]
  },
  {
    id: 'share',
    board: 'shareEngine',
    label: '主动分享（旧链路）',
    keywords: '分享 share 好奇 curiosity 群',
    description: '旧版的好奇心/群内主动分享；新部署建议直接用上面的分享模块。',
    onEffect: '按间隔挑内容发到选中的群；可要求发送前先私聊你审核。',
    offEffect: '不再主动分享；待审草稿不能发布，「立即分享」也会被拒绝。',
    dangerousOff: true,
    customPanel: 'share',
    dependencies: [
      dep('features.shareModule', '分享引擎总闸', { enableValue: true }),
      dep('simulation.innerLife.enabled', '内心生活总开关', { enableValue: true, fallback: false }),
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

  // ── 聊天与社交板块 ──────────────────────────────────────────────────────
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
      dep('simulation.innerLife.enabled', '内心生活总开关', { enableValue: true, fallback: false }),
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
      dep('simulation.innerLife.enabled', '内心生活总开关', { enableValue: true, fallback: false }),
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
      dep('simulation.voice.enabled', 'AI 语音子开关', { enableValue: true, fallback: false })
    ],
    advanced: [
      { key: 'simulation.voice.maxPerMinute', label: '每分钟最多', type: 'number', min: 1, max: 60, default: 6 },
      { key: 'simulation.voice.maxPerHour', label: '每小时最多', type: 'number', min: 1, max: 240, default: 60 },
      { key: 'simulation.voice.maxSeconds', label: '单条时长上限（秒）', type: 'number', min: 1, max: 600, default: 300 },
      { key: 'simulation.voice.defaultVolume', label: '默认音量', type: 'number', min: 0.1, max: 2, step: 0.1, default: 1 },
      { key: 'simulation.voice.normalize', label: '响度归一化', type: 'boolean', default: true }
    ]
  },

  // ── 群运营板块 ──────────────────────────────────────────────────────────
  {
    id: 'dailyReport',
    board: 'ops',
    label: '群日报',
    keywords: '日报 daily report 统计',
    description: '每天固定时间把群聊日报发到群里。',
    onEffect: '到点统计并发送日报；没有选群时不会发送。',
    offEffect: '不再生成和发送日报。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.dailyReport.enabled', '日报子开关', { enableValue: true, fallback: false }),
      dep('simulation.dailyReport.groups', '至少选择一个群', { soft: true })
    ],
    advanced: [
      { key: 'simulation.dailyReport.at', label: '发送时间', type: 'time', default: '21:30' },
      { key: 'simulation.dailyReport.maxItems', label: '最多条目', type: 'number', min: 1, max: 50, default: 8 }
    ]
  },

  // ── 主人能力板块 ────────────────────────────────────────────────────────
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
      dep('simulation.ownerFeatures.enabled', '功能中心子开关', { enableValue: true, fallback: false })
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

/** 卡片的实际开关键：默认 features.<id>，声明了 configKey 的复用原配置键。 */
export function cardSwitchKey(card) {
  const item = typeof card === 'string' ? cardFor(card) : card;
  if (!item) return '';
  return item.configKey || `features.${item.id}`;
}

/**
 * 卡片开关是否打开。
 * features.* 沿用严格 true；声明了 enabledValue 的卡片按值的等值判定；
 * 其余 configKey 卡片沿用原模块「默认开、显式 false 才关」。
 */
export function cardEnabled(card, cfg) {
  const key = cardSwitchKey(card);
  if (!key) return false;
  if (key.startsWith('features.')) return featureEnabled(cfg, key.slice('features.'.length));
  const item = typeof card === 'string' ? cardFor(card) : card;
  if (item?.enabledValue !== undefined) {
    return valueAtPath(cfg, key, item.disabledValue) === item.enabledValue;
  }
  return valueAtPath(cfg, key, true) !== false;
}

/** 卡片开关切换时写入配置的值；把布尔开关映射回字符串等非布尔配置。 */
export function cardSwitchValue(card, enabled) {
  const item = typeof card === 'string' ? cardFor(card) : card;
  if (!item) return undefined;
  if (item.enabledValue !== undefined || item.disabledValue !== undefined) {
    return enabled ? item.enabledValue : item.disabledValue;
  }
  return Boolean(enabled);
}

export function cardDefaultKeys(id) {
  const card = cardFor(id);
  if (!card) return [];
  return [...(card.resetKeys || []), ...((card.advanced || []).map((field) => field.key))];
}

/**
 * 判断模块的依赖是否就绪；soft 依赖只提示，不阻断。
 * features.* 与运行期一样只认严格的 true；其余键按各模块归一化后的默认值判定，
 * 避免「配置里没写 / UI 说就绪、运行期却按关闭处理」造成死开关。
 */
export function evaluateDependencies(card, cfg) {
  return (card?.dependencies || []).map((item) => {
    const raw = item.key.startsWith('features.')
      ? featureEnabled(cfg, item.key.slice('features.'.length))
      : valueAtPath(cfg, item.key, item.fallback ?? true);
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
