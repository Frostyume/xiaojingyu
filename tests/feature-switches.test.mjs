#!/usr/bin/env node
/** 模块级总开关：默认关闭、调度跳过、MCP 禁用文案、主人配置白名单、示例配置一致性。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  FEATURE_IDS,
  FEATURE_DEFAULTS,
  FEATURE_MODULES,
  normalizeFeatureConfig,
  featureSnapshot,
  featureDisabled,
  featureForInnerJob,
  featureForShareModule,
  shareModuleIdForFeature,
  shareEngineEnabled,
  shareModuleEnabled
} from '../runtime/control/feature-switches.js';
import { createInnerLife } from '../services/persona/inner-life.js';
import { listOwnerConfig, readOwnerConfig, validateOwnerConfig, ownerConfigPatch, setOwnerConfigValue } from '../runtime/control/owner-config.js';
import { buildConfigSchema } from '../runtime/kernel/config-schema.js';
import {
  FEATURE_BOARDS,
  FEATURE_CARDS,
  cardFor,
  cardDefaultKeys,
  cardEnabled,
  cardSwitchKey,
  cardSwitchValue,
  evaluateDependencies,
  featureEnablePatch,
  advancedFieldsFor,
  configValueFor,
  valueAtPath
} from '../runtime/control/feature-control.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');

// 开源库没有生活管家（lifeButler），所以是 16 个模块。
const EXPECTED = [
  'qzone', 'qzoneCommentReply', 'signature', 'voice',
  'share', 'shareModule', 'aiTips', 'lifeFun', 'financeTips', 'llmTips',
  's16Share', 'customShare', 'dailyReport', 'esportsFeed', 'outerWorld', 'ownerFeature'
];

// 1. 模块清单与默认值
assert.deepEqual([...FEATURE_IDS].sort(), [...EXPECTED].sort(), '模块 id 必须与设计一致');
assert.equal(FEATURE_IDS.length, 16);
for (const id of FEATURE_IDS) assert.equal(FEATURE_DEFAULTS[id], false, `${id} 默认必须关闭`);

const example = JSON.parse(read('config.example.json'));
assert.deepEqual(Object.keys(example.features).sort(), ['disabled', ...EXPECTED].sort(), '示例配置必须包含 16 个开关');
for (const id of FEATURE_IDS) assert.equal(example.features[id], false, `示例配置 ${id} 默认必须为 false`);

const normalized = normalizeFeatureConfig(example.features);
for (const id of FEATURE_IDS) assert.equal(normalized[id], false);
assert.deepEqual(featureSnapshot({ features: normalized }), Object.fromEntries(FEATURE_IDS.map((id) => [id, false])));
const kept = normalizeFeatureConfig({ disabled: ['legacy-x'], voice: true });
assert.deepEqual(kept.disabled, ['legacy-x'], 'features.disabled 旧注册表不能被覆盖');
assert.equal(kept.voice, true);

// 2. loadConfig 从同一份 normalize 生成默认值（避免示例/运行期两处漂移）
assert.match(read('app/whale.js'), /cfg\.features = normalizeFeatureConfig\(file\.features\)/);

// 3. 关闭时调度器直接跳过（不读状态、不排期）
const cfg = {
  simulation: { innerLife: { enabled: true }, nightQuiet: { enabled: false } },
  features: normalizeFeatureConfig({})
};
const innerStateDir = path.join(os.tmpdir(), `qq-bridge-feature-switch-${process.pid}`);
fs.mkdirSync(innerStateDir, { recursive: true });
const inner = createInnerLife({
  cfg,
  stateDir: innerStateDir,
  log: () => {},
  isDshReady: () => false,
  getMode: () => 'reserved2',
  isPaused: () => false
});

for (const name of ['qzone', 'curiosity', 'aiTips', 'share:life_fun']) {
  const result = await inner.runJob(name);
  assert.equal(result.status, 'disabled', `${name} 关闭后必须跳过`);
  assert.match(result.reason, /^features\.[a-zA-Z]+=false$/);
}
const commentCheck = await inner.checkQzoneComments();
assert.equal(commentCheck.status, 'disabled');
assert.equal(commentCheck.reason, 'features.qzoneCommentReply=false');

// 打开后不再被总开关拦下（这里用 dsh-not-ready 证明已经越过总开关）。
// 旧链路主动分享仍要先过分享引擎总闸，所以 shareModule 必须一起开。
cfg.features.shareModule = true;
cfg.features.share = true;
const curiosity = await inner.runJob('curiosity');
assert.equal(curiosity.status, 'dsh-not-ready', '总开关打开后应继续走原有细分开关/依赖检查');
// 评论回复打开后应越过总开关；用「今日已达上限」让它在联网前返回，测试不触达真 Qzone。
cfg.features.qzoneCommentReply = true;
fs.writeFileSync(path.join(innerStateDir, 'qzone-comments.json'), JSON.stringify({ count: 99 }));
const commentOpen = await inner.checkQzoneComments();
assert.notEqual(commentOpen.reason, 'features.qzoneCommentReply=false', '打开评论回复后应继续走原有细分开关检查');
assert.equal(commentOpen.status, 'daily-limit', '测试应在上限处返回，避免联网');
fs.rmSync(path.join(innerStateDir, 'qzone-comments.json'), { force: true });

// 评论回复卡片声明了「内心生活总开关」依赖：总闸关掉时运行期也必须停，不能只靠 UI 拦。
cfg.simulation.innerLife.enabled = false;
const commentNoInner = await inner.checkQzoneComments();
assert.equal(commentNoInner.status, 'disabled');
assert.equal(commentNoInner.reason, 'simulation.innerLife.enabled=false', '内心生活总闸关闭时评论回复必须停');
cfg.simulation.innerLife.enabled = true;

// 4. MCP 禁用文案：工具在调用期按功能开关拦截
assert.deepEqual(featureDisabled('voice'), { ok: false, disabled: true, reason: 'features.voice=false' });
const mcpActions = read('mcp/qq-actions.js');
assert.match(mcpActions, /featureDisabledResult\(featureId\)/, 'MCP 工具必须在调用期按功能开关拦截');
for (const [tool, feature] of [
  ['qq_send_voice', 'voice'],
  ['qq_speak', 'voice'],
  ['qq_post_qzone', 'qzone'],
  ['qq_share_module_list', 'shareModule'],
  ['qq_feature_list', 'ownerFeature']
]) {
  const re = new RegExp(`${tool}: '${feature}'`);
  assert.match(mcpActions, re, `${tool} 必须映射到 features.${feature}`);
}
assert.doesNotMatch(mcpActions, /qq_config_(list|get|set): '/, '配置读写工具不能被总开关锁死');
assert.doesNotMatch(mcpActions, /qq_capabilities_list:\s*'/, '能力发现工具必须始终可用，否则关掉功能后无法向主人解释怎么开');
assert.match(mcpActions, /featurePreviewBypass\(name, args\)/, '只预览不发送的调用必须绕过总开关');

// 5. 分享引擎：引擎总闸 + 模块开关，自建模块统一归 customShare
assert.equal(featureForShareModule('ai_tips'), 'aiTips');
assert.equal(featureForShareModule('life_fun'), 'lifeFun');
assert.equal(featureForShareModule('finance_tips'), 'financeTips');
assert.equal(featureForShareModule('llm_tips'), 'llmTips');
assert.equal(featureForShareModule('s16'), 's16Share');
assert.equal(featureForShareModule('offline-demo'), 'customShare');
assert.equal(shareModuleIdForFeature('s16Share'), 's16');
assert.equal(shareModuleIdForFeature('customShare'), '');
assert.equal(shareEngineEnabled({ features: { shareModule: true } }), true);
assert.equal(shareModuleEnabled({ features: { shareModule: false, aiTips: true } }, 'ai_tips'), false);
assert.equal(shareModuleEnabled({ features: { shareModule: true, aiTips: false } }, 'ai_tips'), false);
assert.equal(shareModuleEnabled({ features: { shareModule: true, aiTips: true } }, 'ai_tips'), true);
assert.equal(shareModuleEnabled({ features: { shareModule: true, customShare: true } }, 'offline-demo'), true);

// 6. inner-life 作业 → 模块映射
assert.equal(featureForInnerJob('curiosity'), 'share');
assert.equal(featureForInnerJob('qzone'), 'qzone');
assert.equal(featureForInnerJob('aiTips'), 'aiTips');
assert.equal(featureForInnerJob('share:ai_tips'), 'aiTips');
assert.equal(featureForInnerJob('share:life_fun'), 'lifeFun');
assert.equal(featureForInnerJob('share:finance_tips'), 'financeTips');
assert.equal(featureForInnerJob('share:llm_tips'), 'llmTips');
assert.equal(featureForInnerJob('share:s16'), 's16Share');
assert.equal(featureForInnerJob('share:offline-demo'), 'customShare');
assert.equal(featureForInnerJob('reflection'), '');

// 7. 主人配置白名单：15 个 feature.* 可读可写
const ownerCfg = { features: normalizeFeatureConfig({}) };
const ownerList = listOwnerConfig(ownerCfg);
for (const id of FEATURE_IDS) {
  const key = `feature.${id}`;
  const row = ownerList.find((item) => item.key === key);
  assert.ok(row, `qq_config_list 必须能列出 ${key}`);
  assert.equal(row.type, 'boolean');
  assert.equal(row.restart, 'none');
  assert.equal(row.value, false);
  assert.equal(readOwnerConfig(ownerCfg, key), false);
  assert.equal(validateOwnerConfig(key, true).ok, true);
  assert.equal(validateOwnerConfig(key, 'yes').ok, false);
  const patch = ownerConfigPatch(key, true);
  assert.equal(patch.ok, true);
  assert.equal(patch.path, `features.${id}`);
  assert.equal(patch.stored, true);
}
const applied = setOwnerConfigValue(ownerCfg, 'feature.voice', true);
assert.equal(applied.ok, true);
assert.equal(ownerCfg.features.voice, true, '写入后立即反映到运行期配置');
assert.equal(readOwnerConfig(ownerCfg, 'feature.voice'), true);

// 8. 强制调用 / 主人直发 / 待审草稿都不能绕过主开关
cfg.features.share = false;
for (const name of ['qzone', 'aiTips', 'share:life_fun']) {
  const forced = await inner.runJob(name, { force: true });
  assert.equal(forced.status, 'disabled', `${name} 的 force 不能绕过主开关`);
}
const moduleReason = await inner.runJob('share:life_fun', { force: true });
assert.equal(moduleReason.reason, 'features.lifeFun=false', '引擎开着时，模块自己的开关仍然拦得住');
cfg.features.shareModule = false;
const engineOff = await inner.runJob('curiosity', { force: true });
assert.equal(engineOff.reason, 'features.shareModule=false', '引擎总闸关闭后旧链路也停');
const engineOffDraft = await inner.publishShareDraft('ai_tips');
assert.equal(engineOffDraft.reason, 'features.shareModule=false', '总闸关闭时草稿原因指向引擎');
cfg.features.shareModule = true;
const previewCuriosity = await inner.runJob('curiosity', { dryRun: true });
assert.notEqual(previewCuriosity.status, 'disabled', 'dryRun 预览允许跳过主开关（不发送）');
const directQzone = await inner.ownerPublishQzone('离线测试内容');
assert.equal(directQzone.status, 'disabled', '主人/控制台直发不能绕过 features.qzone');
const draftPublish = await inner.publishShareDraft('ai_tips');
assert.equal(draftPublish.status, 'disabled', '待审分享草稿不能绕过 features.aiTips');
assert.equal(draftPublish.reason, 'features.aiTips=false');
const forcedShare = await inner.runShareModule('ai_tips', { force: true });
assert.equal(forcedShare.status, 'disabled', '分享模块的 force 不能绕过主开关');
assert.equal(forcedShare.reason, 'features.aiTips=false');
const sharePreview = await inner.runShareModule('ai_tips', { dryRun: true, force: true });
assert.notEqual(sharePreview.status, 'disabled', '分享模块 dryRun 预览不应被主开关拦住');

// 9. 控制台信息架构：群聊剧场总闸 + 15 个 features 模块各一张卡
const CHAT_CARDS = ['groupChat', 'chatActivity', 'chatProactive', 'chatStickers', 'chatNightQuiet'];
assert.deepEqual([...new Set(FEATURE_CARDS.map((card) => card.id))].sort(), [...EXPECTED, ...CHAT_CARDS].sort());
assert.equal(FEATURE_CARDS.length, 21);
assert.equal(FEATURE_MODULES.length, EXPECTED.length);
assert.deepEqual(FEATURE_BOARDS.map((board) => board.id), ['chat', 'shareEngine', 'social', 'ops', 'owner']);
assert.equal(FEATURE_BOARDS.find((board) => board.id === 'chat').master, 'groupChat');
assert.equal(FEATURE_BOARDS.find((board) => board.id === 'shareEngine').master, 'shareModule');
for (const board of FEATURE_BOARDS) {
  assert(FEATURE_CARDS.some((card) => card.board === board.id), `板块 ${board.id} 必须至少有一个模块`);
}
const chatChildren = FEATURE_CARDS.filter((card) => card.board === 'chat' && !card.boardMaster).map((card) => card.id);
assert.deepEqual(chatChildren, ['chatActivity', 'chatProactive', 'chatStickers', 'chatNightQuiet']);
const shareEngineChildren = FEATURE_CARDS.filter((card) => card.board === 'shareEngine' && !card.boardMaster).map((card) => card.id);
assert.deepEqual(shareEngineChildren.sort(), ['aiTips', 'customShare', 'esportsFeed', 'financeTips', 'lifeFun', 'llmTips', 's16Share', 'share'].sort());
for (const card of FEATURE_CARDS) {
  assert.equal(cardFor(card.id), card);
  assert.equal(typeof card.label, 'string');
  assert.equal(typeof card.onEffect, 'string');
  assert.equal(typeof card.offEffect, 'string');
  if (card.board === 'shareEngine' && !card.boardMaster) {
    assert(card.dependencies.some((item) => item.key === 'features.shareModule'), `${card.id} 必须依赖分享引擎总闸`);
  }
  if (card.board === 'chat' && !card.boardMaster) {
    assert(card.dependencies.some((item) => item.key === 'simulation.enabled'), `${card.id} 必须依赖群聊剧场总闸`);
  }
}
assert.equal(cardFor('not-a-module'), null);

// 群聊剧场卡片复用 simulation.*：默认开、只有显式 false 才是关，升级后不会把已有行为关掉。
assert.equal(cardSwitchKey('groupChat'), 'simulation.enabled');
assert.equal(cardSwitchKey('chatActivity'), 'simulation.wake.defaultMode');
assert.equal(cardSwitchKey('chatProactive'), 'simulation.proactive.enabled');
assert.equal(cardSwitchKey('chatStickers'), 'simulation.sticker.enabled');
assert.equal(cardSwitchKey('chatNightQuiet'), 'simulation.nightQuiet.enabled');
assert.equal(cardFor('chatActivity').board, 'chat');
assert.equal(cardFor('chatActivity').advanced[0].default, false);
assert.equal(cardEnabled('chatActivity', {}), false, '默认潜水');
assert.equal(cardEnabled('chatActivity', { simulation: { wake: { defaultMode: 'active' } } }), true);
assert.equal(cardEnabled('chatActivity', { simulation: { wake: { defaultMode: 'diving' } } }), false);
assert.equal(cardEnabled('chatActivity', { simulation: { wake: { defaultMode: 'active' }, activityControl: { deepDive: true } } }), true);
assert.equal(cardSwitchValue('chatActivity', true), 'active');
assert.equal(cardSwitchValue('chatActivity', false), 'diving');
assert.equal(cardSwitchKey('qzone'), 'features.qzone');
assert.equal(cardEnabled('groupChat', {}), true);
assert.equal(cardEnabled('groupChat', { simulation: { enabled: false } }), false);
assert.equal(cardEnabled('chatProactive', { simulation: {} }), true);
assert.equal(cardEnabled('chatProactive', { simulation: { proactive: { enabled: false } } }), false);
assert.equal(cardEnabled('chatNightQuiet', { simulation: { nightQuiet: { enabled: false } } }), false);
assert.equal(cardEnabled('qzone', {}), false);
assert.equal(cardEnabled('qzone', { features: { qzone: true } }), true);
assert.deepEqual(featureEnablePatch(cardFor('groupChat')), {});
assert.equal(featureEnablePatch(cardFor('chatProactive'))['simulation.enabled'], true);
assert.equal(cardDefaultKeys('groupChat').length, 0);
assert.equal(advancedFieldsFor(cardFor('chatNightQuiet'), {}).find((field) => field.key === 'simulation.nightQuiet.start').value, '23:30');
assert.equal(evaluateDependencies(cardFor('chatStickers'), { simulation: { enabled: false } }).find((item) => item.key === 'simulation.enabled').ok, false);
assert.equal(evaluateDependencies(cardFor('chatStickers'), {}).find((item) => item.key === 'simulation.enabled').ok, true);

// 默认关闭的键：配置里没写时必须判为未就绪，不能按真值显示「已就绪」而运行期不执行。
for (const [id, key] of [
  ['qzone', 'simulation.innerLife.enabled'],
  ['voice', 'simulation.voice.enabled'],
  ['ownerFeature', 'simulation.ownerFeatures.enabled']
]) {
  const depItem = evaluateDependencies(cardFor(id), {}).find((item) => item.key === key);
  assert.ok(depItem, `${id} 必须声明依赖 ${key}`);
  assert.equal(depItem.ok, false, `${id}：${key} 未配置时应判为未就绪（运行期默认关闭）`);
}
// 默认开启的键仍按「没写就是开」判定，避免把正常状态误报成被拦住。
assert.equal(evaluateDependencies(cardFor('chatProactive'), {}).find((item) => item.key === 'simulation.enabled').ok, true);

// 打开主开关时必须同时补齐硬依赖子开关，否则会出现「总开、子关」的死开关。
const enginePatch = featureEnablePatch(cardFor('shareModule'));
assert.equal(enginePatch['simulation.innerLife.enabled'], true);
assert.equal(enginePatch['simulation.shareModules.enabled'], true);
const lifeFunPatch = featureEnablePatch(cardFor('lifeFun'));
assert.equal(lifeFunPatch['features.shareModule'], true, '打开内容模块要顺带打开分享引擎总闸');
assert.equal(lifeFunPatch['simulation.shareModules.enabled'], true);
const qzonePatch = featureEnablePatch(cardFor('qzone'));
assert.equal(qzonePatch['simulation.innerLife.enabled'], true);
assert.equal(qzonePatch['simulation.innerLife.qzone.enabled'], true);
const voicePatch = featureEnablePatch(cardFor('voice'));
assert.equal(voicePatch['simulation.voice.enabled'], true);
assert.deepEqual(featureEnablePatch(cardFor('dailyReport')), { 'simulation.dailyReport.enabled': true });

// 数组型依赖不能因为空数组是真值就判为就绪（日报群）。
const dailyDeps = evaluateDependencies(cardFor('dailyReport'), { simulation: { dailyReport: { enabled: true, groups: [] } } });
const groupDep = dailyDeps.find((item) => item.key === 'simulation.dailyReport.groups');
assert.equal(groupDep.ok, false);
assert.equal(groupDep.soft, true);
const groupDepsOk = evaluateDependencies(cardFor('dailyReport'), { simulation: { dailyReport: { enabled: true, groups: ['group:87654321'] } } });
assert.equal(groupDepsOk.find((item) => item.key === 'simulation.dailyReport.groups').ok, true);

// 高级设置只暴露卡片声明的键，展示值与存储值按 scale 双向换算。
const advanced = advancedFieldsFor(cardFor('qzoneCommentReply'), {
  simulation: { innerLife: { qzone: { commentReply: { pollMs: 600000, maxPerDay: 3 } } } }
});
assert.equal(advanced.find((field) => field.key === 'simulation.innerLife.qzone.commentReply.pollMs').value, 10);
assert.equal(advanced.find((field) => field.key === 'simulation.innerLife.qzone.commentReply.maxPerDay').value, 3);
assert.equal(configValueFor({ type: 'number', min: 1, max: 60, scale: 60000 }, '15'), 900000);
assert.equal(configValueFor({ type: 'number', min: 1, max: 60 }, 999), 60);
assert.equal(configValueFor({ type: 'time' }, '08:30'), '08:30');
assert.equal(configValueFor({ type: 'time' }, '8:05'), '08:05');
assert.equal(configValueFor({ type: 'time' }, '25:99'), null);
assert.equal(configValueFor({ type: 'time' }, '8点半'), null);
assert.equal(valueAtPath({ a: { b: 1 } }, 'a.b'), 1);
assert.equal(valueAtPath({ a: {} }, 'a.b.c', 'fallback'), 'fallback');
assert(cardDefaultKeys('qzone').includes('simulation.innerLife.qzone.requireApproval'));
assert.deepEqual(cardDefaultKeys('ownerFeature'), []);

// 10. 控制台目录与页面
const catalog = buildConfigSchema(ownerCfg);
for (const id of FEATURE_IDS) {
  const field = catalog.fields.find((item) => item.key === `features.${id}`);
  assert.ok(field, `配置目录必须包含 features.${id}`);
  assert.equal(field.type, 'boolean');
  assert.equal(field.group, '功能总开关');
  assert.equal(field.restart, 'none');
}
const schemaDoc = JSON.parse(read('config.schema.json'));
assert.equal(
  schemaDoc.properties.simulation.properties.activityControl.properties.deepDive.default,
  false,
  '生成的 config.schema.json 必须包含深潜开关，高级设置才能校验'
);
const consoleHtml = read('web/deck.html');
assert.match(consoleHtml, /id="featureSwitches"/);
assert.match(consoleHtml, /id="featureSwitchesSave"/);
assert.match(consoleHtml, /data-feature-id/);
// 关闭态在实时页/概览要写「已关闭」，不能只报一个 0 让人以为功能开着却没数据。
const liveHtml = read('web/live.html');
assert.match(liveHtml, /esp\.enabled === false \? '已关闭'/, '赛事关闭时实时页显示已关闭');
assert.match(liveHtml, /stq\.enabled === false \? '已关闭'/, '收藏补收关闭时显示已关闭而不是条数');
assert.match(liveHtml, /libSig\.enabled === false \? '已关闭'/, '表情体系关闭时资源库显示已关闭');
assert.match(liveHtml, /const dist = minR \+ \(1 - m\.bond \/ 100\) \* \(maxR - minR\)/, '关系图谱按羁绊决定离中心的距离');
assert.match(liveHtml, /dot\.setAttribute\('r', String\(r\)\)/, '关系图谱节点半径随羁绊增大');
assert.match(liveHtml, /0\.8 \+ \(p\.m\.bond \/ 100\) \* 2\.4/, '关系图谱连线粗细随羁绊增大');
assert.match(read('app/whale.js'), /cfg\.simulation\?\.innerLife\?\.enabled !== true\) return;/, '空间评论轮询必须再判内心生活总闸');
assert.match(consoleHtml, /const shown = deps\.filter\(\(item\) => !item\.ok\)/, '依赖只提示未满足项，避免满屏绿条');
assert.match(consoleHtml, /featureFilterShown = shown \+ mastersShown/, '显示计数必须包含板块总闸');
assert.match(consoleHtml, /if \(page === 'simulation'\) \{[\s\S]{0,160}loadSimConfig\(\)/, '进入群聊剧场页必须重读配置，防止旧状态回写');

fs.rmSync(innerStateDir, { recursive: true, force: true });
console.log('feature switch checks passed');
