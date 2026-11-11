// 配置目录（catalog）、校验与版本迁移。
//
// 设计取舍：
//   · 不复制一份默认值 —— 默认值仍以 bridge.js 的 loadConfig 为准（避免两处漂移）。
//   · catalog 由「运行时已合并的 cfg」+ 这里的元数据生成，所以**只要 loadConfig 里有，
//     控制台/doctor 就能看到**，不会漏掉新增开关。
//   · 校验类型以运行时值为参照；范围/枚举/标签/密钥标记集中在 FIELD_META。
//   · 非法值在写入边界拒绝（400）；启动时只告警并回退默认，避免一条错配置让机器人起不来。

import { FEATURE_MODULES } from '../control/feature-switches.js';

export const CONFIG_VERSION = 2;

const GROUP_LABELS = {
  dsh: 'DSH 连接与模型',
  snowluma: 'SnowLuma / QQ',
  role: '人格注入',
  allow: '发送白名单',
  deny: '发送黑名单',
  security: '安全',
  slang: '黑话学习',
  social: '旧版仿真（reserved）',
  simulation: '群聊剧场',
  features: '功能总开关',
  webSearch: '联网搜索',
  tts: 'TTS 语音合成',
  storage: '存储与可靠性',
  routing: '模型路由',
  pricing: '价目表',
  core: '基础'
};

// 排序必须与环境无关：默认 localeCompare 跟随机器 locale，CI（en-US）与本地（zh-CN）
// 会得到不同顺序，生成物因此被 --check 判成"不是最新"。组顺序取 GROUP_LABELS 的声明顺序，
// 其余组（FIELD_META 里直接写中文名的）排在后面按码位；组内按字段名码位。
const GROUP_RANK = new Map(Object.keys(GROUP_LABELS).map((key, index) => [GROUP_LABELS[key], index]));
const byCodeUnit = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const groupRank = (group) => GROUP_RANK.get(group) ?? GROUP_RANK.size;

const FIELD_META = {
  // ── 基础 / 连接 ────────────────────────────────────────────────────────────
  'dsh.baseUrl': { label: 'DSH 地址', group: 'DSH 连接与模型', restart: 'bridge', description: 'DSH 重启后端口会变，需要同步更新' },
  'dsh.provider': { label: '模型 provider', group: 'DSH 连接与模型', restart: 'none' },
  'dsh.model': { label: '模型', group: 'DSH 连接与模型', restart: 'none' },
  'dsh.reasoningEffort': { label: '思考强度', group: 'DSH 连接与模型', restart: 'none', enum: ['off', 'low', 'medium', 'high', 'max'] },
  'dsh.authToken': { label: 'DSH auth token', group: 'DSH 连接与模型', restart: 'bridge', secret: true },
  'dsh.authHeader': { label: '鉴权 header', group: 'DSH 连接与模型', restart: 'bridge', advanced: true },
  'dsh.authPrefix': { label: '鉴权前缀', group: 'DSH 连接与模型', restart: 'bridge', advanced: true },
  'dsh.allowRemote': { label: '允许把 launch token 发往非回环地址', group: 'DSH 连接与模型', restart: 'bridge', advanced: true },

  'snowluma.wsUrl': { label: 'SnowLuma WS 地址', group: 'SnowLuma / QQ', restart: 'bridge' },
  'snowluma.httpUrl': { label: 'SnowLuma HTTP 地址', group: 'SnowLuma / QQ', restart: 'bridge' },
  'snowluma.accessToken': { label: 'SnowLuma access token', group: 'SnowLuma / QQ', restart: 'bridge', secret: true },
  'snowluma.homeDir': { label: 'SnowLuma 安装目录', group: 'SnowLuma / QQ', restart: 'none', advanced: true },
  'snowluma.launcherPath': { label: 'SnowLuma 启动器路径', group: 'SnowLuma / QQ', restart: 'bridge', advanced: true },
  'snowluma.followDiscoveredEndpoint': { label: '跟随自动发现的端点', group: 'SnowLuma / QQ', restart: 'bridge', advanced: true },
  'snowluma.silenceWarnMs': { label: '静默告警阈值（ms）', group: 'SnowLuma / QQ', restart: 'bridge', min: 60000, max: 86400000, advanced: true },

  ownerQQ: { label: '管理员 QQ', group: '基础', restart: 'none', secret: true, type: 'number', nullable: true },
  agentPreset: { label: '默认 agent preset', group: '基础', restart: 'dsh' },
  workspaceTitle: { label: '工作区标题', group: '基础', restart: 'bridge' },
  sessionCwd: { label: '会话工作目录', group: '基础', restart: 'bridge', advanced: true },
  allowAllWhenEmpty: { label: '白名单为空时放行所有', group: '基础', restart: 'none' },
  ackMessage: { label: '思考中回执', group: '基础', restart: 'none' },
  sendDelayMs: { label: '发送间隔（ms）', group: '基础', restart: 'none', min: 0, max: 10000 },
  questionTimeoutMs: { label: '提问超时（ms）', group: '基础', restart: 'none', min: 5000, max: 3600000 },
  consolePort: { label: '控制台端口', group: '基础', restart: 'bridge', min: 1, max: 65535 },
  consoleToken: { label: '控制台令牌', group: '基础', restart: 'bridge', secret: true },
  'consoleAuth.enabled': { label: '控制台要求访问令牌', group: '基础', restart: 'bridge', description: '默认关闭：仅本机回环 + Host/CSRF 防护；开启后浏览器需输入令牌' },
  'role.maxInjectChars': { label: '人格注入上限（字符）', group: '人格注入', restart: 'none', min: 1000, max: 20000 },

  'security.interceptNotify': { label: '敏感回复拦截时通知管理员', group: '安全', restart: 'none' },
  pricing: { label: '价目表覆盖', group: '价目表', restart: 'none', type: 'object', nullable: true, advanced: true },

  // ── 存储与可靠性（本轮新增） ────────────────────────────────────────────────
  'storage.enabled': { label: '启用 SQLite 可靠性层', group: '存储与可靠性', restart: 'bridge' },
  'storage.dbPath': { label: '数据库路径', group: '存储与可靠性', restart: 'bridge', advanced: true },
  'storage.backupDir': { label: '备份目录', group: '存储与可靠性', restart: 'bridge', advanced: true },
  'storage.backupKeepDays': { label: '备份保留天数', group: '存储与可靠性', restart: 'bridge', min: 1, max: 90, advanced: true },
  'storage.retentionDays': { label: '数据保留天数', group: '存储与可靠性', restart: 'bridge', min: 1, max: 365, advanced: true },
  'storage.outboxEnabled': { label: '出站消息先落盘', group: '存储与可靠性', restart: 'bridge' },
  'storage.inboxEnabled': { label: '入站消息去重与恢复', group: '存储与可靠性', restart: 'bridge' },
  'storage.jobsEnabled': { label: '统一任务队列', group: '存储与可靠性', restart: 'bridge' },
  'storage.inboxReplayMaxAgeMs': { label: '入站重放窗口（ms）', group: '存储与可靠性', restart: 'bridge', min: 1000, max: 3600000, advanced: true },
  'storage.outboxMaxAttempts': { label: '出站重试次数', group: '存储与可靠性', restart: 'bridge', min: 1, max: 20, advanced: true },
  'storage.outboxRetryBaseMs': { label: '出站重试基数（ms）', group: '存储与可靠性', restart: 'bridge', min: 500, max: 300000, advanced: true },
  'storage.outboxRetryMaxMs': { label: '出站重试上限（ms）', group: '存储与可靠性', restart: 'bridge', min: 1000, max: 3600000, advanced: true },
  'storage.configStrict': { label: '配置非法时拒绝启动', group: '存储与可靠性', restart: 'bridge', advanced: true },
  'storage.logJsonl': { label: '结构化日志（JSONL）', group: '存储与可靠性', restart: 'bridge' },

  // ── 控制面分层 ────────────────────────────────────────────────────────────
  'simulation.controlTiers.enabled': { label: '控制面分层', group: '控制面分层', restart: 'none', description: '关闭后恢复旧行为：群会话不能跨会话发消息/读上下文' },
  'simulation.controlTiers.ownerDirectiveTtlMs': { label: '群内主人指令有效期（ms）', group: '控制面分层', restart: 'none', min: 60000, max: 86400000 },
  'simulation.controlTiers.groupEscalationNotify': { label: '群里高危被拒时私聊提醒主人', group: '控制面分层', restart: 'none' },
  'simulation.controlTiers.requireConfirmForHighRisk': { label: '高危动作需私聊确认', group: '控制面分层', restart: 'none' },

  // ── 语音 ──────────────────────────────────────────────────────────────────
  'simulation.voice.enabled': { label: '语音发送', group: '语音', restart: 'none' },
  'simulation.voice.dir': { label: '语音库目录', group: '语音', restart: 'none' },
  'simulation.voice.maxSeconds': { label: '单条最长（秒）', group: '语音', restart: 'none', min: 1, max: 600 },
  'simulation.voice.maxBytes': { label: '单条最大字节', group: '语音', restart: 'none', min: 1024, max: 104857600 },
  'simulation.voice.maxPerMinute': { label: '每分钟上限', group: '语音', restart: 'none', min: 0, max: 60 },
  'simulation.voice.maxPerHour': { label: '每小时上限', group: '语音', restart: 'none', min: 0, max: 600 },
  'simulation.voice.allowAbsolutePath': { label: '允许绝对路径', group: '语音', restart: 'none', advanced: true },
  'simulation.voice.defaultVolume': { label: '默认音量倍数', group: '语音', restart: 'none', min: 0.1, max: 4 },
  'simulation.voice.loudness': { label: '智能音量', group: '语音', restart: 'none', enum: ['quiet', 'normal', 'loud'] },
  'simulation.voice.normalize': { label: '响度归一', group: '语音', restart: 'none', description: '开启后按目标 LUFS 统一语音响度（-16 为日常）' },
  'simulation.innerLife.groupShare.targets': { label: '主动分享目标群', group: '内容引擎', restart: 'none', description: '可多选；每次只挑一个群分享，按最近分享时间轮换' },
  'simulation.voice.ffmpegPath': { label: 'ffmpeg 路径', group: '语音', restart: 'none', advanced: true },
  'simulation.voice.autoReadback': { label: '语音后自动朗读', group: '语音', restart: 'none', advanced: true },

  'tts.enabled': { label: 'TTS 合成', group: 'TTS 语音合成', restart: 'none' },
  'tts.baseUrl': { label: 'TTS 服务地址', group: 'TTS 语音合成', restart: 'none' },
  'tts.refAudio': { label: '参考音频', group: 'TTS 语音合成', restart: 'none', advanced: true },
  'tts.promptText': { label: '参考音频文本', group: 'TTS 语音合成', restart: 'none', advanced: true },
  'tts.promptLang': { label: '参考音频语言', group: 'TTS 语音合成', restart: 'none', advanced: true },
  'tts.textLang': { label: '合成语言', group: 'TTS 语音合成', restart: 'none' },
  'tts.maxChars': { label: '单条最大字数', group: 'TTS 语音合成', restart: 'none', min: 1, max: 500 },
  'tts.maxSeconds': { label: '单条最长（秒）', group: 'TTS 语音合成', restart: 'none', min: 1, max: 600 },
  'tts.speedFactor': { label: '语速倍数', group: 'TTS 语音合成', restart: 'none', min: 0.5, max: 2 },
  'tts.keepFiles': { label: '保留合成文件数', group: 'TTS 语音合成', restart: 'none', min: 0, max: 500, advanced: true },
  'tts.timeoutMs': { label: '合成超时（ms）', group: 'TTS 语音合成', restart: 'none', min: 1000, max: 300000, advanced: true },
  'tts.emotionRefs': { label: '情绪 → 参考音色', group: 'TTS 语音合成', restart: 'dsh', advanced: true, type: 'object', description: '修改后需重启 DSH（MCP 工具进程）才生效' },
  'tts.emotionSpeed': { label: '情绪 → 语速', group: 'TTS 语音合成', restart: 'dsh', advanced: true, type: 'object' },

  // ── 群聊剧场里的高频开关（其余自动推断） ────────────────────────────────────
  'simulation.enabled': { label: '群聊剧场总开关', group: '群聊剧场', restart: 'none' },
  'simulation.agentPreset': { label: '仿真预设', group: '群聊剧场', restart: 'dsh' },
  'simulation.autoReplyCheckMs': { label: '回复检查间隔（ms）', group: '群聊剧场', restart: 'none', min: 1000, max: 600000 },
  'simulation.provideRecommendations': { label: '提供推荐参数', group: '群聊剧场', restart: 'none' },
  'simulation.initialPromptMaxChars': { label: '初始提示词上限（字符）', group: '群聊剧场', restart: 'none', min: 100, max: 8000 },
  'simulation.send.maxSendPerMinute': { label: '每分钟发送上限', group: '群聊剧场', restart: 'none', min: 0, max: 120 },
  'simulation.send.maxSendPerHour': { label: '每小时发送上限', group: '群聊剧场', restart: 'none', min: 0, max: 2000 },
  'simulation.send.maxMessageChars': { label: '单条最大字数', group: '群聊剧场', restart: 'none', min: 1, max: 4000 },
  'simulation.wake.maxWakePerMinute': { label: '每分钟唤醒上限', group: '群聊剧场', restart: 'none', min: 0, max: 60 },
  'simulation.wake.maxWakePerHour': { label: '每小时唤醒上限', group: '群聊剧场', restart: 'none', min: 0, max: 600 },
  'simulation.wake.defaultMode': { label: '群聊默认唤醒模式', group: '群聊剧场', restart: 'none', options: ['active', 'diving'], description: '全局活跃控制：active=活跃（所有群按活跃处理），diving=潜水（按各会话触发条件）。优先级高于会话级设置。' },
  'simulation.activityControl.deepDive': { label: '深潜模式', group: '群聊剧场', restart: 'none', description: '潜水层的硬约束：群里只有主人本人直接 @ 小鲸鱼才会唤醒，其余消息、关键词、拍一拍和主动冒泡都不触发。全局活跃时暂不生效。' },
  'simulation.sticker.enabled': { label: '表情包体系', group: '表情与图片', restart: 'none' },
  'simulation.sticker.collect.enabled': { label: '允许收藏表情', group: '表情与图片', restart: 'none' },
  'simulation.sticker.collect.maxBytes': { label: '单个表情上限（字节）', group: '表情与图片', restart: 'none', min: 65536, max: 4194304, advanced: true },
  'simulation.sticker.collect.compress': { label: '超过上限自动压缩 GIF', group: '表情与图片', restart: 'none', description: '默认关闭（优先原图，压缩会改变字节/MD5）；打开后超过上限用本机 Python + Pillow 压缩' },
  'simulation.sticker.collect.pythonPath': { label: 'Python 可执行文件', group: '表情与图片', restart: 'none', advanced: true, description: '留空则用 PATH 里的 python' },
  'simulation.sticker.collect.shrinkScriptPath': { label: '压缩脚本路径', group: '表情与图片', restart: 'none', advanced: true, description: '留空则用仓库 tools/shrink-gif.py' },
  'simulation.imageLibrary.enabled': { label: '通用图片库', group: '表情与图片', restart: 'none' },
  'simulation.imageLibrary.dir': { label: '图片库目录', group: '表情与图片', restart: 'none' },
  'simulation.media.maxBytes': { label: '单条图片总字节上限', group: '表情与图片', restart: 'bridge' },
  'simulation.media.maxCount': { label: '单条图片张数上限', group: '表情与图片', restart: 'bridge' },
  'simulation.media.maxPixels': { label: '单张图解码像素上限', group: '表情与图片', restart: 'bridge' },
  'simulation.reminders.enabled': { label: '提醒', group: '提醒 / 天气 / 订阅', restart: 'none' },
  'simulation.reminders.overdueGraceMs': { label: '过期容忍（ms）', group: '提醒 / 天气 / 订阅', restart: 'none', min: 60000, max: 86400000 },
  'simulation.weather.enabled': { label: '天气', group: '提醒 / 天气 / 订阅', restart: 'none' },
  'simulation.weather.defaultCity': { label: '默认城市', group: '提醒 / 天气 / 订阅', restart: 'none' },
  'simulation.esportsFeed.enabled': { label: '电竞资讯', group: '提醒 / 天气 / 订阅', restart: 'none' },
  'simulation.innerLife.enabled': { label: '内心生活', group: '内心生活', restart: 'none' },
  'simulation.innerLife.dryRun': { label: '内心生活演练模式', group: '内心生活', restart: 'none' },
  'simulation.innerLife.qzone.enabled': { label: 'QQ 空间', group: '内心生活', restart: 'none' },
  'simulation.innerLife.qzone.commentReply.pollMs': { label: '空间评论检查间隔（ms）', group: '内心生活', restart: 'bridge' },
  'simulation.innerLife.groupShare.enabled': { label: '群内分享', group: '内心生活', restart: 'none' },
  'simulation.outerWorld.leisure.enabled': { label: '读书线', group: '出门见闻', restart: 'none', description: '让她自己读公开网页/电子书，生成见闻卡片；默认关闭' },
  'simulation.outerWorld.leisure.maxItemsPerDay': { label: '每天最多见闻', group: '出门见闻', restart: 'none', min: 0, max: 20, advanced: true },
  'simulation.outerWorld.leisure.noteChars': { label: '摘要字数上限', group: '出门见闻', restart: 'none', min: 80, max: 2000, advanced: true },
  'simulation.outerWorld.leisure.digestChars': { label: '单次摘要材料上限（字符）', group: '出门见闻', restart: 'none', min: 800, max: 20000, advanced: true, description: '整本一次喂给模型会爆上下文，按预算只取开头若干块' },
  'simulation.outerWorld.leisure.tokenBudget': { label: '每日 token 预算', group: '出门见闻', restart: 'none', min: 0, max: 10000000, advanced: true },
  'simulation.outerWorld.leisure.ytDlpPath': { label: 'yt-dlp 路径', group: '出门见闻', restart: 'none', advanced: true, description: '留空时依次查 YT_DLP_PATH 与 PATH；只用于视频字幕' },
  'simulation.outerWorld.leisure.subtitleLang': { label: '字幕语言', group: '出门见闻', restart: 'none', advanced: true },
  'simulation.outerWorld.browse.policy': { label: '访问策略', group: '出门见闻', restart: 'none', enum: ['public', 'allowlist'], advanced: true },
  'simulation.outerWorld.digest.pushToOwner': { label: '生成后私聊主人', group: '出门见闻', restart: 'none', advanced: true },
  'simulation.outerWorld.schedule.minGapMs': { label: '最小间隔（ms）', group: '出门见闻', restart: 'none', min: 60000, max: 86400000, advanced: true },
  'simulation.outerWorld.schedule.window.start': { label: '窗口开始', group: '出门见闻', restart: 'none', advanced: true },
  'simulation.outerWorld.schedule.window.end': { label: '窗口结束', group: '出门见闻', restart: 'none', advanced: true },

  // ── 上下文 / 成本 / 记忆 / 路由 ───────────────────────────────────────────
  'simulation.context.wakeBudgetTokens': { label: '唤醒 prompt token 预算', group: '上下文与成本', restart: 'none', min: 300, max: 20000, description: '超出时按优先级丢可选段，核心人格/工具协议不丢' },
  'simulation.context.rotateAtTokens': { label: '会话旋转阈值（tokens）', group: '上下文与成本', restart: 'none', min: 0, max: 500000, description: '0=关闭；超过阈值时下一次唤醒归档旧会话并注入衔接摘要' },
  'simulation.context.digestMaxChars': { label: '衔接摘要上限（字符）', group: '上下文与成本', restart: 'none', min: 300, max: 4000, advanced: true },
  'simulation.valueScore.enabled': { label: '价值评分', group: '上下文与成本', restart: 'none', description: '只影响泛监听（任意消息/概率），@/引用/私聊/提问永不降级' },
  'simulation.valueScore.wakeThreshold': { label: '唤醒阈值', group: '上下文与成本', restart: 'none', min: 0, max: 1 },
  'simulation.valueScore.deferThreshold': { label: '延后阈值', group: '上下文与成本', restart: 'none', min: 0, max: 1 },
  'simulation.memory.enabled': { label: '分层长期记忆', group: '上下文与成本', restart: 'none' },
  'simulation.memory.topK': { label: '记忆检索条数', group: '上下文与成本', restart: 'none', min: 1, max: 30 },
  'simulation.memory.maxChars': { label: '记忆注入上限（字符）', group: '上下文与成本', restart: 'none', min: 100, max: 4000 },
  'simulation.memory.minConfidence': { label: '记忆最低置信度', group: '上下文与成本', restart: 'none', min: 0, max: 1, advanced: true },
  'routing.enabled': { label: '模型/effort 路由', group: '模型路由', restart: 'none' },
  'transport.kind': { label: '传输类型', group: '传输', restart: 'bridge', enum: ['snowluma', 'onebot'], description: 'onebot = 通用 OneBot v11 HTTP（NapCat 等）；入站仍按 SnowLuma WS' },
  'features.disabled': { label: '禁用的 feature', group: '扩展', restart: 'bridge' },
  'simulation.dailyReport.enabled': { label: '群日报', group: '群日报', restart: 'none', description: '默认关闭；按群开启，每天固定时间发送本地统计摘要（不调用模型）' },
  'simulation.dailyReport.at': { label: '发送时间（HH:MM）', group: '群日报', restart: 'none' },
  'simulation.dailyReport.groups': { label: '开启日报的群', group: '群日报', restart: 'none' },
  'simulation.dailyReport.maxItems': { label: '摘录条数', group: '群日报', restart: 'none', min: 1, max: 20 },
  'simulation.speech.asr.enabled': { label: '语音转写（ASR）', group: '语音', restart: 'bridge', description: '默认关闭；开启后收到的语音会附加 [语音转写]' },
  'simulation.speech.asr.timeoutMs': { label: '转写超时（ms）', group: '语音', restart: 'bridge', min: 1000, max: 120000, advanced: true },
  'simulation.speech.asr.cacheTtlMs': { label: '转写缓存时长（ms）', group: '语音', restart: 'bridge', advanced: true },
  'simulation.budget.enabled': { label: 'token 预算', group: '预算', restart: 'none', description: '超预算只压制非显式唤醒；@/引用/私聊/提问/关键词仍会回' },
  'simulation.budget.dailyTokensPerKey': { label: '每会话每日 token', group: '预算', restart: 'none', min: 0, max: 100000000 },
  'simulation.budget.dailyTokensGlobal': { label: '全局每日 token', group: '预算', restart: 'none', min: 0, max: 1000000000 },
  'simulation.budget.blockNonExplicitOnly': { label: '只压制非显式唤醒', group: '预算', restart: 'none' },
  'simulation.relationships.enabled': { label: '群友关系（galgame）', group: '群友关系', restart: 'none', description: '默认开启；家人群自动排除；可按群开关' },
  'simulation.relationships.excludeFamily': { label: '自动排除家人群', group: '群友关系', restart: 'none' },
  'simulation.relationships.excludedGroups': { label: '额外排除的群', group: '群友关系', restart: 'none' },
  'simulation.relationships.promptLimit': { label: 'prompt 关系卡人数', group: '群友关系', restart: 'none', min: 1, max: 12 },
  'simulation.relationships.liveLimit': { label: '实时页展示人数', group: '群友关系', restart: 'none', min: 1, max: 12 },
  'simulation.signature.enabled': { label: '自动个性签名', group: '个性签名', restart: 'none', description: '按心情/精力/兴趣/近况生成短签名并更新 QQ personal_note；不发群消息' },
  'simulation.signature.llm': { label: '用模型按真实状态生成', group: '个性签名', restart: 'none', description: '开启后签名由内心会话按她此刻的心情/精力/近况生成；关闭或模型不可用时退回干净模板兜底（回滚开关）' },
  'simulation.signature.minIntervalHours': { label: '最短间隔（小时）', group: '个性签名', restart: 'none', min: 1, max: 720 },
  'simulation.signature.maxIntervalHours': { label: '最长间隔（小时）', group: '个性签名', restart: 'none', min: 1, max: 720 },
  'simulation.signature.firstDelayMs': { label: '首次延迟（ms）', group: '个性签名', restart: 'none', min: 60000, max: 86400000, advanced: true },
  'simulation.signature.maxChars': { label: '签名最大字数', group: '个性签名', restart: 'none', min: 8, max: 60 },
  'simulation.signature.dryRun': { label: '只预览不更新', group: '个性签名', restart: 'none' },

  // ── 搜索 ──────────────────────────────────────────────────────────────────
  'webSearch.provider': { label: '搜索 provider', group: '联网搜索', restart: 'none', enum: ['auto', 'deepseek', 'bing', 'chatanywhere'], description: 'auto=DeepSeek 优先、失败回退 Bing；chatanywhere=OpenAI 兼容搜索模型（需 key 支持 web_search_options）' },
  'webSearch.apiKey': { label: '搜索 API Key', group: '联网搜索', restart: 'none', secret: true },
  'webSearch.apiKeyEnv': { label: 'API Key 环境变量名', group: '联网搜索', restart: 'none', advanced: true },
  'webSearch.baseURL': { label: '搜索 API 地址', group: '联网搜索', restart: 'none', advanced: true },
  'webSearch.model': { label: '搜索模型', group: '联网搜索', restart: 'none' },
  'webSearch.maxUses': { label: '单轮最多搜索次数', group: '联网搜索', restart: 'none', min: 1, max: 50 },
  'webSearch.maxResults': { label: '最多结果数', group: '联网搜索', restart: 'none', min: 1, max: 50 },
  'webSearch.timeoutMs': { label: '搜索超时（ms）', group: '联网搜索', restart: 'none', min: 1000, max: 120000 },

  // ── 模块级总开关 ──────────────────────────────────────────────────────────
  ...Object.fromEntries(FEATURE_MODULES.map(({ id, label, description }) => [
    `features.${id}`,
    { label: `总开关：${label}`, group: '功能总开关', restart: 'none', description }
  ]))
};

const SECRET_KEY_RE = /(token|api[_-]?key|secret|password|passwd|cookie)$/i;
const ADVANCED_PREFIX_RE = /^(pricing|social\.|slang\.)/;

function humanize(key) {
  const last = String(key).split('.').pop() ?? key;
  return last
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function groupFor(key) {
  const meta = FIELD_META[key];
  if (meta?.group) return meta.group;
  const top = String(key).split('.')[0];
  if (GROUP_LABELS[top]) return GROUP_LABELS[top];
  if (String(key).startsWith('simulation.tools.')) return '仿真工具开关';
  return GROUP_LABELS.core;
}

function typeOf(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'object') return 'object';
  return typeof value;
}

function flatten(value, prefix = '', out = []) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    out.push({ key: prefix, value });
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) flatten(v, key, out);
    else out.push({ key, value: v });
  }
  return out;
}

export function flattenConfig(cfg) {
  return flatten(cfg);
}

function fieldFrom(key, value, { masked = false } = {}) {
  const meta = FIELD_META[key] ?? {};
  const type = typeOf(value);
  const secret = Boolean(meta.secret) || (type === 'string' && SECRET_KEY_RE.test(key));
  const itemType = type === 'array' && value.length ? typeOf(value[0]) : undefined;
  const configured = secret && (value !== '' && value !== null && value !== undefined);
  return {
    key,
    label: meta.label ?? (String(key).startsWith('simulation.tools.') ? `工具 ${String(key).slice('simulation.tools.'.length)}` : humanize(key)),
    group: groupFor(key),
    type: meta.type ?? type,
    itemType,
    nullable: meta.nullable ?? (type === 'null' || key === 'pricing'),
    default: secret ? undefined : value,
    value: secret ? (configured ? '已配置' : '未配置') : value,
    configured: secret ? configured : undefined,
    secret,
    restart: meta.restart ?? (String(key).startsWith('dsh.') || String(key).startsWith('snowluma.') ? 'bridge' : 'none'),
    advanced: Boolean(meta.advanced) || ADVANCED_PREFIX_RE.test(String(key)) || String(key).startsWith('simulation.tools.'),
    min: meta.min,
    max: meta.max,
    enum: meta.enum,
    description: meta.description ?? ''
  };
}

/** 运行时配置 → 控制台/doctor 可用的字段清单。密钥只返回「已配置/未配置」。 */
export function buildConfigSchema(cfg, { includeSecrets = false } = {}) {
  const fields = flattenConfig(cfg)
    .filter(({ key }) => key && !/\.authTokenExplicit$/.test(key) && !String(key).startsWith('configValidation.'))
    .map(({ key, value }) => fieldFrom(key, value))
    .sort((a, b) => groupRank(a.group) - groupRank(b.group) || byCodeUnit(a.group, b.group) || byCodeUnit(a.key, b.key));
  return {
    version: CONFIG_VERSION,
    generatedAt: new Date().toISOString(),
    groups: [...new Set(fields.map((f) => f.group))],
    fields: fields.map((f) => (f.secret && !includeSecrets ? f : f))
  };
}

/** 校验单个字段值；返回 { ok, error, value }。 */
export function validateField(field, value) {
  const type = field.type;
  if (value === null) {
    return field.nullable ? { ok: true, value: null } : { ok: false, error: `${field.key} 不能为 null` };
  }
  if (type === 'boolean') {
    return typeof value === 'boolean' ? { ok: true, value } : { ok: false, error: `${field.key} 必须是布尔值` };
  }
  if (type === 'number') {
    if (typeof value !== 'number' || !Number.isFinite(value)) return { ok: false, error: `${field.key} 必须是数字` };
    if (field.min !== undefined && value < field.min) return { ok: false, error: `${field.key} 不能小于 ${field.min}` };
    if (field.max !== undefined && value > field.max) return { ok: false, error: `${field.key} 不能大于 ${field.max}` };
    return { ok: true, value };
  }
  if (type === 'string') {
    if (typeof value !== 'string') return { ok: false, error: `${field.key} 必须是字符串` };
    if (value.length > 20000) return { ok: false, error: `${field.key} 过长（>20000 字符）` };
    if (Array.isArray(field.enum) && field.enum.length && !field.enum.includes(value)) {
      return { ok: false, error: `${field.key} 只能是 ${field.enum.join(' / ')}` };
    }
    return { ok: true, value };
  }
  if (type === 'array') {
    if (!Array.isArray(value)) return { ok: false, error: `${field.key} 必须是数组` };
    if (value.length > 2000) return { ok: false, error: `${field.key} 元素过多` };
    if (field.itemType) {
      const bad = value.find((v) => (value.length && field.itemType === 'number' ? typeof v !== 'number' : typeof v !== field.itemType));
      if (bad !== undefined) return { ok: false, error: `${field.key} 的元素必须是 ${field.itemType}` };
    }
    return { ok: true, value };
  }
  if (type === 'object' || type === 'null') {
    if (typeof value === 'object' && !Array.isArray(value)) return { ok: true, value };
    return { ok: false, error: `${field.key} 必须是对象` };
  }
  return { ok: true, value };
}

/**
 * 校验一份「扁平的配置补丁」。
 * patch = { 'simulation.voice.enabled': true, ... }；未知 key 直接拒绝（防拼错静默无效）。
 */
export function validateConfigPatch(runtimeCfg, patch) {
  const catalog = new Map(buildConfigSchema(runtimeCfg).fields.map((f) => [f.key, f]));
  const errors = [];
  const values = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, errors: ['配置补丁必须是对象'], values };
  }
  for (const [key, raw] of Object.entries(patch)) {
    const field = catalog.get(key);
    if (!field) { errors.push(`未知配置项：${key}`); continue; }
    const result = validateField(field, raw);
    if (!result.ok) { errors.push(result.error); continue; }
    values[key] = result.value;
  }
  return { ok: errors.length === 0, errors, values };
}

/**
 * 用运行时配置做参照，校验一份完整配置文件（用于 doctor / 启动告警）。
 * 返回 errors（类型/范围错误）与 unknown（参照里没有的 key，仅提示）。
 */
export function validateConfigObject(referenceCfg, fileCfg) {
  const catalog = new Map(buildConfigSchema(referenceCfg).fields.map((f) => [f.key, f]));
  const errors = [];
  const unknown = [];
  for (const { key, value } of flattenConfig(fileCfg)) {
    const field = catalog.get(key);
    if (!field) { unknown.push(key); continue; }
    const result = validateField(field, value);
    if (!result.ok) errors.push(result.error);
  }
  return { ok: errors.length === 0, errors, unknown };
}

function setDeep(obj, dotted, value) {
  const parts = String(dotted).split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i += 1) {
    const part = parts[i];
    if (cur[part] === null || typeof cur[part] !== 'object' || Array.isArray(cur[part])) cur[part] = {};
    cur = cur[part];
  }
  cur[parts[parts.length - 1]] = value;
}

/** 应用扁平补丁（写入 config.json 前用）。 */
export function applyConfigPatch(fileCfg, values) {
  const next = JSON.parse(JSON.stringify(fileCfg ?? {}));
  for (const [key, value] of Object.entries(values ?? {})) setDeep(next, key, value);
  return next;
}

/**
 * 配置版本迁移（纯函数）。
 * v1 → v2：补 storage 段与 configVersion；旧别名 allow.privates/group 归一。
 * 不写入磁盘：调用方决定是「只内存迁移」还是显式落盘。
 */
export function migrateConfigObject(input, { now = Date.now() } = {}) {
  const cfg = JSON.parse(JSON.stringify(input ?? {}));
  const notes = [];
  const originalFrom = Number.isFinite(Number(cfg.configVersion)) ? Number(cfg.configVersion) : 1;
  let from = originalFrom;
  if (!cfg.configVersion) {
    cfg.configVersion = 1;
    notes.push('缺少 configVersion，按 v1 处理');
  }

  if (Array.isArray(cfg.allow?.privates) && !Array.isArray(cfg.allow?.private)) {
    cfg.allow.private = cfg.allow.privates;
    delete cfg.allow.privates;
    notes.push('allow.privates → allow.private');
  }
  if (Array.isArray(cfg.allow?.group) && !Array.isArray(cfg.allow?.groups)) {
    cfg.allow.groups = cfg.allow.group;
    delete cfg.allow.group;
    notes.push('allow.group → allow.groups');
  }
  if (Array.isArray(cfg.deny?.privates) && !Array.isArray(cfg.deny?.private)) {
    cfg.deny.private = cfg.deny.privates;
    delete cfg.deny.privates;
    notes.push('deny.privates → deny.private');
  }
  if (Array.isArray(cfg.deny?.group) && !Array.isArray(cfg.deny?.groups)) {
    cfg.deny.groups = cfg.deny.group;
    delete cfg.deny.group;
    notes.push('deny.group → deny.groups');
  }

  if (from < 2) {
    cfg.storage = {
      enabled: true,
      dbPath: 'state/db/bridge.db',
      backupDir: process.platform === 'win32' ? 'D:/xiaojingyu-backups' : 'state/backups',
      backupKeepDays: 7,
      retentionDays: 30,
      outboxEnabled: true,
      inboxEnabled: true,
      jobsEnabled: true,
      inboxReplayMaxAgeMs: 120000,
      outboxMaxAttempts: 5,
      outboxRetryBaseMs: 5000,
      outboxRetryMaxMs: 600000,
      configStrict: false,
      logJsonl: true,
      ...(cfg.storage ?? {})
    };
    cfg.configVersion = 2;
    from = 2;
    notes.push('v1 → v2：新增 storage 段');
  }

  // 出门见闻：旧配置没有这一段时补默认对象（全部关闭），不改变已有行为。
  const isObject = (value) => value && typeof value === 'object' && !Array.isArray(value);
  cfg.simulation = isObject(cfg.simulation) ? cfg.simulation : {};
  const ow = isObject(cfg.simulation.outerWorld) ? cfg.simulation.outerWorld : null;
  const owNext = {
    leisure: { enabled: false, sources: [], maxItemsPerDay: 2, noteChars: 600, digestChars: 6000, tokenBudget: 60000, ytDlpPath: '', subtitleLang: 'zh-Hans', subtitleTimeoutMs: 60000, ...(isObject(ow?.leisure) ? ow.leisure : {}) },
    browse: { enabled: false, policy: 'public', allowlist: [], blockedDomains: [], maxSteps: 8, snapshotChars: 1000, readOnly: true, ...(isObject(ow?.browse) ? ow.browse : {}) },
    digest: { enabled: false, pushToOwner: false, mentionPolicy: 'natural', ...(isObject(ow?.digest) ? ow.digest : {}) },
    schedule: {
      minGapMs: 7200000,
      ...(isObject(ow?.schedule) ? ow.schedule : {}),
      window: { start: '09:00', end: '23:00', idleOnly: true, ...(isObject(ow?.schedule?.window) ? ow.schedule.window : {}) }
    }
  };
  if (!ow) notes.push('新增 simulation.outerWorld 默认段（全关）');
  cfg.simulation.outerWorld = owNext;

  return { config: cfg, from: originalFrom, to: CONFIG_VERSION, changed: notes.length > 0, notes, at: now };
}
