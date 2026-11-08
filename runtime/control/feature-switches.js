// 模块级功能总开关。
//
// 设计：
//   · 配置位置固定为顶层 features.<module>（features.disabled 仍归 feature loader 使用）；
//   · 默认全部 false：这是主人明确要求的“默认全关”，新环境需在控制台逐个开启；
//   · 生效条件是「总开关 true 且原模块开关允许」，原细项开关语义不变，只在外层加总闸；
//   · 调用方每次调度/工具调用都重新读 cfg，不做启动期缓存，改完立即生效。
//   · 本仓库没有生活管家（lifeButler），因此不提供 features.life。

export const FEATURE_MODULES = Object.freeze([
  { id: 'qzone', label: '空间说说', description: '定时自动发 QQ 空间说说' },
  { id: 'qzoneCommentReply', label: '空间评论回复', description: '自动回复自己说说下的评论与好友动态里的 @' },
  { id: 'signature', label: '个性签名', description: '按间隔自动生成并更新 QQ 个性签名' },
  { id: 'voice', label: '语音发送', description: 'qq_send_voice / qq_speak 与 AI 语音出口' },
  { id: 'share', label: '主动分享（旧链路）', description: '好奇/群内主动分享：curiosity 与 groupShare' },
  { id: 'shareModule', label: '分享引擎总闸', description: '统一管理所有主动分享；下面的内容模块各自有开关' },
  { id: 'aiTips', label: 'AI 知识分享', description: 'ai_tips 分享模块（每日 AI 小知识）' },
  { id: 'lifeFun', label: '生活趣闻', description: 'life_fun 分享模块（生活类内容）' },
  { id: 'financeTips', label: '金融小知识', description: 'finance_tips 分享模块（金融常识）' },
  { id: 'llmTips', label: '大模型科普', description: 'llm_tips 分享模块（大模型科普）' },
  { id: 's16Share', label: 'S16 分享', description: 's16 分享模块（赛事内容）' },
  { id: 'customShare', label: '自定义分享模块', description: '你在控制台自建的其他分享模块' },
  { id: 'dailyReport', label: '群日报', description: '每天定时把群统计发到群里' },
  { id: 'esportsFeed', label: '赛事资讯', description: '定时抓取 S16 赛事资讯与赛程' },
  { id: 'outerWorld', label: '出门见闻', description: '让她自己看书/看视频字幕，把见闻带回来' },
  { id: 'ownerFeature', label: '功能中心', description: '定时消息、自动回复、语音消息等主人功能' }
]);

export const FEATURE_IDS = Object.freeze(FEATURE_MODULES.map((item) => item.id));

export const FEATURE_DEFAULTS = Object.freeze(
  Object.fromEntries(FEATURE_IDS.map((id) => [id, false]))
);

/** 把 config.json 的 features 段补成完整、安全的对象；未知键原样保留。 */
export function normalizeFeatureConfig(raw) {
  return {
    disabled: [],
    ...FEATURE_DEFAULTS,
    ...(raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {})
  };
}

/** 总开关是否打开。只认严格的 true，避免字符串 "false" / 1 之类的误判。 */
export function featureEnabled(cfg, id) {
  return cfg?.features?.[id] === true;
}

/** 控制台/能力清单用的 on/off 快照。 */
export function featureSnapshot(cfg) {
  return Object.fromEntries(FEATURE_IDS.map((id) => [id, featureEnabled(cfg, id)]));
}

/** MCP / HTTP 工具关闭时的统一结果（沿用 disabled 约定）。 */
export function featureDisabled(id) {
  return { ok: false, disabled: true, reason: `features.${id}=false` };
}

/** 内置分享模块 id → 独立总开关；未列出的自建模块统一归 customShare。 */
export const SHARE_MODULE_FEATURES = Object.freeze({
  ai_tips: 'aiTips',
  life_fun: 'lifeFun',
  finance_tips: 'financeTips',
  llm_tips: 'llmTips',
  s16: 's16Share'
});

export const SHARE_ENGINE_FEATURES = Object.freeze([
  'shareModule', 'aiTips', 'lifeFun', 'financeTips', 'llmTips', 's16Share', 'customShare', 'share', 'esportsFeed'
]);

export const SHARE_MODULE_IDS_BY_FEATURE = Object.freeze(
  Object.fromEntries(Object.entries(SHARE_MODULE_FEATURES).map(([moduleId, featureId]) => [featureId, moduleId]))
);

export function featureForShareModule(moduleId) {
  return SHARE_MODULE_FEATURES[String(moduleId || '')] || 'customShare';
}

export function shareModuleIdForFeature(featureId) {
  return SHARE_MODULE_IDS_BY_FEATURE[String(featureId || '')] || '';
}

export function isShareEngineFeature(id) {
  return SHARE_ENGINE_FEATURES.includes(id);
}

/** 分享引擎总闸。所有分享入口都要先过它，再过各自的模块开关。 */
export function shareEngineEnabled(cfg) {
  return featureEnabled(cfg, 'shareModule');
}

export function shareModuleEnabled(cfg, moduleId) {
  return shareEngineEnabled(cfg) && featureEnabled(cfg, featureForShareModule(moduleId));
}

/**
 * 内心生活作业名 → 总开关 id。reflection 属于内部状态维护，不纳入图标开关。
 * share:<module> 按模块映射到各自的开关；自建模块归 customShare。
 */
export function featureForInnerJob(name) {
  if (name === 'curiosity') return 'share';
  if (name === 'qzone') return 'qzone';
  if (name === 'aiTips') return 'aiTips';
  if (typeof name === 'string' && name.startsWith('share:')) {
    return featureForShareModule(name.slice('share:'.length));
  }
  return '';
}
