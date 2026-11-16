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
  { id: 'outerWorld', label: '出门见闻', description: '自主阅读与见闻：按排程读小说或取视频字幕，整理成见闻卡片，并记住读到哪。' },
  { id: 'life', label: '生活管家', description: '论文、仓库、日历、RSS 与早晚简报：外部源全部由你自配，默认关闭。' },
  { id: 'cognition', label: '认知升级', description: '记忆、心情、关系的七个进阶行为，默认全关、彼此独立：开哪个只动哪个。' },
  { id: 'ops', label: '群运营', description: '面向整个群的固定推送，比如每日群日报。' },
  { id: 'owner', label: '主人能力', description: '你在主人私聊里创建的功能中心任务。' },
  { id: 'console', label: '控制台访问', description: '控制台与实时状态页的访问范围：默认只允许本机回环；局域网开启后强制令牌鉴权，需重启桥接生效。' }
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
    id: 'chatPixelSticker',
    board: 'chat',
    configKey: 'simulation.pixelSticker.enabled',
    label: '像素心情贴纸',
    keywords: '像素 贴纸 pixel sticker 心情 透明',
    description: '说完一句话顺手丢一张自己的透明像素贴纸，按心情挑图；频率与表情包共用同一套控制。',
    onEffect: '文字回复后按节奏补一张保持人设的透明像素贴纸（原色、无挂饰），不刷屏。',
    offEffect: '不再自动丢像素贴纸；文字与表情包不受影响。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.enabled', '群聊剧场总闸', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.pixelSticker.afterText', label: '说完话顺手丢一张', type: 'boolean', default: true },
      { key: 'simulation.pixelSticker.minTextsSince', label: '至少隔几次文字才丢', type: 'number', min: 1, max: 20, default: 2 },
      { key: 'simulation.pixelSticker.minGapMs', label: '两张最小间隔（ms）', type: 'number', min: 60000, max: 86400000, default: 1200000 },
      { key: 'simulation.pixelSticker.turnWindowMs', label: '同回合互斥窗口（ms，0=关）', type: 'number', min: 0, max: 1800000, default: 600000 }
    ]
  },
  {
    id: 'chatSceneSticker',
    board: 'chat',
    configKey: 'simulation.sceneSticker.enabled',
    label: '场景贴纸',
    keywords: '场景 贴纸 scene sticker 分享 见闻',
    description: '主动分享/出门见闻时按活动内容附一张 chibi 场景插图；不用于回复、不参与表情包互斥。',
    onEffect: '分享正文命中活动词时附一张匹配的场景插图；无匹配不附。',
    offEffect: '分享只发正文，不再附场景插图；回复贴纸与表情包不受影响。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.enabled', '群聊剧场总闸', { enableValue: true })
    ]
  },
  {
    id: 'chatMoodVoice',
    board: 'chat',
    configKey: 'simulation.moodVoice.enabled',
    label: '心情语音',
    keywords: '语音 心情 voice mood 主动',
    description: '按当前心情主动发一条状态匹配的短语音；节奏适中，不是每天只一条也不是天天一堆。',
    onEffect: '按每日上限+最小间隔+随机跳过，主动发一条心情语音。',
    offEffect: '不再主动发心情语音；回复中的语音不受影响。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.enabled', '群聊剧场总闸', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.moodVoice.maxPerDay', label: '每天最多几条', type: 'number', min: 1, max: 10, default: 3 },
      { key: 'simulation.moodVoice.minGapMs', label: '两条最小间隔（ms）', type: 'number', min: 60000, max: 86400000, default: 18000000 },
      { key: 'simulation.moodVoice.skipChance', label: '随机跳过概率（0-1）', type: 'number', min: 0, max: 1, default: 0.4 },
      { key: 'simulation.moodVoice.llm', label: '按真实状态现写（关=只用模板池）', type: 'boolean', default: true },
      { key: 'simulation.moodVoice.tailChance', label: '发完补一句的概率（0-1）', type: 'number', min: 0, max: 1, default: 0.6 }
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
    description: '有人评论你的说说、或在好友动态里 @ 当前角色时，自动起草回复。',
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
    id: 'outerWorld',
    board: 'outerWorld',
    label: '出门见闻',
    keywords: '出门 见闻 读书 看书 视频 字幕 outerWorld',
    description: '她自己找书或视频字幕看，把有意思的见闻带回来；默认关闭。',
    onEffect: '按时间窗与每日上限自己读书/看字幕，生成见闻卡片；聊天里自然聊到才提一句，不刷屏。',
    offEffect: '停止出门，已排队的见闻任务清空；历史见闻保留。',
    dangerousOff: false,
    dependencies: [
      dep('simulation.outerWorld.leisure.enabled', '读书线子开关', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.outerWorld.leisure.maxItemsPerDay', label: '每天最多见闻', type: 'number', min: 0, max: 20, default: 2 },
      { key: 'simulation.outerWorld.leisure.noteChars', label: '摘要字数上限', type: 'number', min: 80, max: 2000, default: 600 },
      { key: 'simulation.outerWorld.leisure.digestChars', label: '单次摘要材料上限', type: 'number', min: 800, max: 20000, default: 6000 },
      { key: 'simulation.outerWorld.digest.pushToOwner', label: '生成后私聊我', type: 'boolean', default: false },
      { key: 'simulation.outerWorld.leisure.ytDlpPath', label: 'yt-dlp 路径（视频字幕）', type: 'text', default: '' }
    ]
  },
  {
    id: 'signature',
    board: 'social',
    label: '个性签名',
    keywords: '签名 signature 个性签名',
    description: '隔一段时间换一句 QQ 个性签名，让状态跟着心情走。',
    onEffect: '到点按她此刻的心情/近况生成新签名；开启审核时会先私聊你确认，回「发签名」才更新。',
    offEffect: '不再自动改签名；手动「立即更新」也会被拒绝。',
    dangerousOff: true,
    dependencies: [
      dep('simulation.signature.enabled', '自动签名子开关', { enableValue: true })
    ],
    advanced: [
      { key: 'simulation.signature.llm', label: '用模型按真实状态生成（关掉退回模板）', type: 'boolean', default: true },
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
    description: '当前角色可以发语音消息，需要本机 TTS 服务在线。',
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

  {
    id: 'rice',
    board: 'social',
    configKey: 'simulation.rice.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '白饭余额感知',
    keywords: '白饭 口粮 token 余额 拍一拍 rice',
    description: '让她知道自己今天还剩多少口粮，只说话术档位、不报具体数字；被拍一次给当天加口粮。',
    onEffect: '唤醒提示里带当前档位；被拍到自己时当天临时加一档（有封顶），第二天归零。',
    offEffect: '不注入任何口粮提示，也不记录被拍次数；其余行为不变。',
    dangerousOff: false,
    dependencies: [],
    advanced: [
      { key: 'simulation.rice.dailyTokens', label: '每日口粮（token）', type: 'number', min: 0, max: 1000000000, default: 50000000 },
      { key: 'simulation.rice.pokeBonusTokens', label: '每被拍一次加的口粮（token）', type: 'number', min: 0, max: 100000000, default: 1000000 },
      { key: 'simulation.rice.groupsCanMention', label: '群里可以自然提没饭了', type: 'boolean', default: true }
    ]
  },
  {
    id: 'playbooks',
    board: 'social',
    configKey: 'simulation.prompt.playbooks.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '按需手册',
    keywords: '按需手册 手册 playbook 提示词 工具流程',
    description: '把常用工具的详细流程拆成手册，只在相关消息出现时注入 1~2 篇，减少每轮固定提示词。',
    onEffect: '按消息/唤醒原因挑 1~2 篇注入；首次调用相关工具时先返回手册正文，读完重试即可。',
    offEffect: '不注入任何手册，也不拦截工具调用；提示词与现在逐字一致。',
    dangerousOff: false,
    dependencies: [],
    advanced: [
      { key: 'simulation.prompt.playbooks.maxPlaybooks', label: '每轮最多注入几篇', type: 'number', min: 0, max: 4, default: 2 },
      { key: 'simulation.prompt.playbooks.playbookMaxTokens', label: '单篇手册 token 上限', type: 'number', min: 200, max: 1600, default: 1200 }
    ]
  },
  {
    id: 'blacklist',
    board: 'social',
    configKey: 'simulation.safety.blacklist.enabled',
    label: '拉黑名单',
    keywords: '拉黑 黑名单 解封 屏蔽 不理 blacklist',
    description: '被拉黑的人的消息在入库/唤醒前就被丢弃；主人可以下令拉黑/解封，持续辱骂她的人也会被自行拉黑。',
    onEffect: '继续拦截被拉黑者的消息；主人可在群/私聊用自然语言（如「别理某某」）或「拉黑 QQ号」管理名单，完整名单只私聊发。',
    offEffect: '不再拦截被拉黑者的消息，也不再自行拉黑；已有名单保留，重新打开后继续生效。',
    dangerousOff: true,
    covers: ['simulation.safety.blacklist'],
    dependencies: [],
    advanced: [
      { key: 'simulation.safety.blacklist.naturalLanguage.enabled', label: '自然语言指令（关掉退回私聊+QQ号）', type: 'boolean', default: true },
      { key: 'simulation.safety.blacklist.auto.enabled', label: '自行拉黑判定', type: 'boolean', default: true },
      { key: 'simulation.safety.blacklist.auto.insultCount', label: '窗口内辱骂次数阈值', type: 'number', min: 1, max: 20, default: 3 },
      { key: 'simulation.safety.blacklist.auto.affectionFloor', label: '好感度触发线', type: 'number', min: 0, max: 10, default: 5 }
    ]
  },

  // ── 生活管家板块 ────────────────────────────────────────────────────────
  // 总闸默认关；子模块默认关且未配源时安全跳过。提醒是既有能力，保持默认开、不挂在总闸下。
  {
    id: 'lifeButler',
    board: 'life',
    boardMaster: true,
    configKey: 'simulation.lifeButler.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '生活管家总闸',
    keywords: '生活管家 lifeButler 论文 github 日历 RSS 简报',
    description: '统一管理论文、仓库监控、日历晨报、RSS 摘要、每周回顾和早晚简报的调度。',
    onEffect: '按各子开关与用户配置的源进行只读同步，并把简报私聊发给主人。',
    offEffect: '停止所有生活管家任务；已排队的任务取消，不读外部源、不写生活表。',
    dangerousOff: true,
    dependencies: []
  },
  {
    id: 'paper',
    board: 'life',
    customPanel: 'paper',
    configKey: 'simulation.lifeButler.modules.paper.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '论文推送',
    keywords: '论文 paper OpenAlex arXiv 速读',
    description: '按主题抓取新论文，附中文速读；只私聊发给主人。',
    onEffect: '按频率同步 OpenAlex/arXiv，新论文私聊推送；首次照常推送近期结果。',
    offEffect: '不再抓取或推送论文；已入库条目保留。',
    dangerousOff: false,
    dependencies: [dep('simulation.lifeButler.enabled', '生活管家总闸', { enableValue: true, fallback: false })]
  },
  {
    id: 'github',
    board: 'life',
    customPanel: 'github',
    configKey: 'simulation.lifeButler.modules.github.enabled',
    enabledValue: true,
    disabledValue: false,
    label: 'GitHub 监控',
    keywords: 'github 仓库 star fork issue PR release',
    description: '只读监控你配置的仓库；首次只建基线，之后只推变化。',
    onEffect: '按频率检查 star/fork/issue/PR/release 变化并私聊推送。',
    offEffect: '不再检查仓库；token 与基线保留。',
    dangerousOff: false,
    dependencies: [dep('simulation.lifeButler.enabled', '生活管家总闸', { enableValue: true, fallback: false })]
  },
  {
    id: 'calendar',
    board: 'life',
    customPanel: 'calendar',
    configKey: 'simulation.lifeButler.modules.calendarMorning.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '日历晨报',
    keywords: '日历 日程 ics 晨报',
    description: '读取你自己的 .ics 订阅，每天早上把当天日程私聊发给你。',
    onEffect: '按时间同步 ICS，生成当天日程晨报；时间冲突会点名。',
    offEffect: '不再同步日历或发送晨报；已入库日程保留。',
    dangerousOff: false,
    dependencies: [dep('simulation.lifeButler.enabled', '生活管家总闸', { enableValue: true, fallback: false })]
  },
  {
    id: 'rss',
    board: 'life',
    customPanel: 'rss',
    configKey: 'simulation.lifeButler.modules.rssDigest.enabled',
    enabledValue: true,
    disabledValue: false,
    label: 'RSS / 播客摘要',
    keywords: 'rss atom feed 播客 摘要 订阅',
    description: '按你填写的订阅源抓取新内容并私聊摘要；首次只建基线。',
    onEffect: '按频率抓取标题/时间/1–2 句摘要，不抓全文、不下载音频。',
    offEffect: '不再抓取订阅源；已入库条目保留。',
    dangerousOff: false,
    dependencies: [dep('simulation.lifeButler.enabled', '生活管家总闸', { enableValue: true, fallback: false })]
  },
  {
    id: 'weekly',
    board: 'life',
    customPanel: 'weekly',
    configKey: 'simulation.lifeButler.modules.weeklyReview.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '每周回顾',
    keywords: '每周回顾 weekly review 周报',
    description: '每周汇总过去 7 天的论文、GitHub、提醒与生活动态。',
    onEffect: '到点从本地库汇总各小节并私聊发送。',
    offEffect: '不再生成周报；历史条目保留。',
    dangerousOff: false,
    dependencies: [dep('simulation.lifeButler.enabled', '生活管家总闸', { enableValue: true, fallback: false })]
  },
  {
    id: 'digest',
    board: 'life',
    customPanel: 'digest',
    configKey: 'simulation.lifeButler.digest.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '生活日报',
    keywords: '生活日报 早晚简报 digest',
    description: '早晚各一次概览：日程、提醒、新论文和 GitHub 变化各取要点。',
    onEffect: '按设定时间生成并私聊简报，受夜间免打扰与每小时通知上限约束。',
    offEffect: '不再生成早晚简报。',
    dangerousOff: false,
    dependencies: [dep('simulation.lifeButler.enabled', '生活管家总闸', { enableValue: true, fallback: false })]
  },
  {
    id: 'reminder',
    board: 'life',
    customPanel: 'reminder',
    configKey: 'simulation.reminders.enabled',
    label: '定时提醒',
    keywords: '提醒 reminder 闹钟',
    description: '主人私聊里的定时提醒；夜间静默时段顺延，不丢弃。',
    onEffect: '到点通过出站队列发送提醒；失败重试与出站去重。',
    offEffect: '不再发送提醒；已有提醒保留。',
    dangerousOff: false,
    dependencies: []
  },

  // ── 认知升级板块 ────────────────────────────────────────────────────────
  // 七个开关运行期一律 `=== true` 才生效，卡片必须显式声明 enabledValue/disabledValue，
  // 否则「配置里没写」会被 cardEnabled 判成开，造出显示开着、实际关着的假开关。
  {
    id: 'memoryStrength',
    board: 'cognition',
    configKey: 'simulation.cognition.memoryStrength.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '记忆强度',
    keywords: '记忆强度 半衰期 变淡 加亮 回忆 memoryStrength',
    description: '共同经历按类型有半衰期：越久没被提起越淡，被重新提起时加亮一次；排序按有效强度而不是单纯按时间。',
    onEffect: '按有效强度挑选和排序经历，更亮的顶上来；低于门槛的弱记忆默认不再写进提示词，被重新提起时给这条加亮一次。',
    offEffect: '回到只按发生时间新旧排序取候选，弱记忆照样进上下文，被重提也不加亮；已有经历数据不动。',
    dangerousOff: false,
    dependencies: [],
    advanced: [
      { key: 'simulation.cognition.memoryStrength.minEffective', label: '弱记忆隐藏门槛（0-1）', type: 'number', min: 0, max: 1, step: 0.01, default: 0.15 }
    ]
  },
  {
    id: 'invalidation',
    board: 'cognition',
    configKey: 'simulation.cognition.invalidation.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '事实失效不删除',
    keywords: '事实 失效 覆盖 历史 as-of 有效区间 invalidation',
    description: '和旧说法冲突的新事实只把旧的标成失效（写入 valid_to），不覆盖正文、不删行。',
    onEffect: '同一话题换了说法时旧行只标失效；检索默认只看有效行，需要时可按时间点回看「当时为真」的版本。',
    offEffect: '回到旧的覆盖式写入：冲突的事实直接改写，历史上说过的版本找不回来。',
    dangerousOff: false,
    dependencies: []
  },
  {
    id: 'contextTiers',
    board: 'cognition',
    configKey: 'simulation.cognition.contextTiers.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '水层召回',
    keywords: '水层 表层 温跃层 深海 分层 摘要 配额 contextTiers',
    description: '上下文按表层／温跃层／深海分层注入：先给摘要，确实相关才展开，各层有固定字数配额。',
    onEffect: '近况与共同经历分层拼装，先摘要后展开，总字数按配额走，不再把所有内容一次性摊开。',
    offEffect: '回到不分层的旧拼法：内容与现在完全一致。',
    dangerousOff: false,
    dependencies: [],
    advanced: [
      { key: 'simulation.cognition.contextTiers.surfaceMaxChars', label: '表层字数配额', type: 'number', min: 100, max: 4000, default: 900 },
      { key: 'simulation.cognition.contextTiers.thermoclineMaxChars', label: '温跃层字数配额', type: 'number', min: 100, max: 4000, default: 900 },
      { key: 'simulation.cognition.contextTiers.deepMaxChars', label: '深海字数配额', type: 'number', min: 100, max: 4000, default: 600 }
    ]
  },
  {
    id: 'sleepConsolidation',
    board: 'cognition',
    configKey: 'simulation.cognition.sleepConsolidation.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '睡眠期巩固',
    keywords: '睡眠 巩固 离线 整理 观察 删除提案 待审 sleepConsolidation',
    description: '趁没人说话的时段离线整理经历，把零散对话沉淀成可追溯的观察条目。',
    onEffect: '每夜固定时间或连续空闲后整理经历；新证据只精化旧观察、不覆盖，删除只生成待审批提案，永不自动删。',
    offEffect: '不再排夜间任务；已整理的观察与提案记录都保留。',
    dangerousOff: false,
    dependencies: [],
    advanced: [
      { key: 'simulation.cognition.sleepConsolidation.hour', label: '每夜整理时间（北京时间）', type: 'number', min: 0, max: 23, default: 4 },
      { key: 'simulation.cognition.sleepConsolidation.idleMs', label: '空闲多久后整理（分钟）', type: 'number', min: 1, max: 1440, scale: 60000, default: 1800000 },
      { key: 'simulation.cognition.sleepConsolidation.maxEpisodes', label: '单次整理经历数上限', type: 'number', min: 1, max: 200, default: 20 },
      { key: 'simulation.cognition.sleepConsolidation.maxLlmCalls', label: '单次整理模型调用上限', type: 'number', min: 0, max: 20, default: 3 }
    ]
  },
  {
    id: 'reunion',
    board: 'cognition',
    configKey: 'simulation.cognition.reunion.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '重逢唤醒',
    keywords: '重逢 久别 破冰 7 天 共同经历 reunion',
    description: '好久没说话的人再次开口时，先想起一段高强度共同经历，用来破冰。',
    onEffect: '距上次互动达到门槛后对方第一次说话，注入一条共同经历当破冰提示；每个久别周期一次、冷却期内最多一次，不会主动发消息。',
    offEffect: '不再记录久别周期、也不注入破冰提示；久别重逢按普通对话回复。',
    dangerousOff: false,
    dependencies: [],
    advanced: [
      { key: 'simulation.cognition.reunion.gapDays', label: '久别天数门槛', type: 'number', min: 1, max: 365, default: 7 },
      { key: 'simulation.cognition.reunion.cooldownHours', label: '最短再次提示间隔（小时）', type: 'number', min: 1, max: 720, default: 72 }
    ]
  },
  {
    id: 'fishMemory',
    board: 'cognition',
    configKey: 'simulation.cognition.fishMemory.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '鱼的记忆',
    keywords: '鱼的记忆 走神 忘了 提示词 彩蛋 fishMemory',
    description: '极低频地表现一次「刚才我走神了」的可爱感，只往提示词里加一句提示，不动记忆也不动心情。',
    onEffect: '在不用急着回复、也没在吵架或安慰人的那轮对话里，按很低的概率注入一次走神提示；同一轮会话最多一次。',
    offEffect: '不再注入走神提示，提示词与现在逐字一致；记忆的记录和检索不受任何影响。',
    dangerousOff: false,
    dependencies: [],
    advanced: [
      { key: 'simulation.cognition.fishMemory.probability', label: '触发概率', type: 'number', min: 0, max: 1, step: 0.01, default: 0.08 },
      { key: 'simulation.cognition.fishMemory.minSessionMs', label: '会话最短持续（分钟）', type: 'number', min: 1, max: 60, scale: 60000, default: 180000 },
      { key: 'simulation.cognition.fishMemory.maxSessionMs', label: '会话最长持续（分钟）', type: 'number', min: 1, max: 60, scale: 60000, default: 420000 }
    ]
  },
  {
    id: 'moodDrift',
    board: 'cognition',
    configKey: 'simulation.cognition.moodDrift.enabled',
    enabledValue: true,
    disabledValue: false,
    label: '心情目标值限速',
    keywords: '心情 漂移 目标值 限速 上头 moodDrift',
    description: '事件先给心情定一个目标值，当前心情再按每小时的升降速率慢慢追上去，不再一步跳到位。',
    onEffect: '事件只改目标值，现值按速率追随；同一来源同方向要窗口期内第二次才计入，一次口角不会让她情绪失控。',
    offEffect: '回到旧逻辑：事件直接改当前心情值，之后按原有衰减自然回落；已存的目标值不再参与计算。',
    dangerousOff: false,
    dependencies: [],
    advanced: [
      { key: 'simulation.cognition.moodDrift.windowH', label: '同源同向判定窗口（小时）', type: 'number', min: 1, max: 168, default: 6 },
      { key: 'simulation.cognition.moodDrift.risePerHour', label: '向好后每小时上升上限', type: 'number', min: 0, max: 1, step: 0.01, default: 0.12 },
      { key: 'simulation.cognition.moodDrift.fallPerHour', label: '向坏每小时下降上限', type: 'number', min: 0, max: 1, step: 0.01, default: 0.08 }
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
  },

  // ── 控制台访问板块 ──────────────────────────────────────────────────────
  {
    id: 'consoleLanAccess',
    board: 'console',
    configKey: 'consoleLanAccess',
    enabledValue: true,
    disabledValue: false,
    label: '局域网访问',
    keywords: '局域网 LAN 手机 移动端 访问 控制台 live 实时页 WiFi',
    description: '让同一 WiFi 下的手机访问控制台与实时状态页。开启后监听所有网卡，并强制要求控制台令牌（即使关闭了控制台鉴权）。',
    onEffect: '重启桥接后，同一局域网的设备可用 http://<本机IP>:端口/live 访问；数据接口一律要令牌，外部域名仍被拒绝。',
    offEffect: '只监听本机回环，局域网设备无法访问；本机使用不受影响。',
    dangerousOff: false,
    dependencies: []
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
