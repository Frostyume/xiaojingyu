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
  featureForInnerJob
} from '../runtime/control/feature-switches.js';
import { createInnerLife } from '../services/persona/inner-life.js';
import { listOwnerConfig, readOwnerConfig, validateOwnerConfig, ownerConfigPatch, setOwnerConfigValue } from '../runtime/control/owner-config.js';
import { buildConfigSchema } from '../runtime/kernel/config-schema.js';
import {
  FEATURE_BOARDS,
  FEATURE_CARDS,
  cardFor,
  cardDefaultKeys,
  evaluateDependencies,
  featureEnablePatch,
  advancedFieldsFor,
  configValueFor,
  valueAtPath
} from '../runtime/control/feature-control.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8').replace(/^\uFEFF/, '');

// 开源库没有生活管家（lifeButler），所以是 10 个模块。
const EXPECTED = [
  'qzone', 'qzoneCommentReply', 'signature', 'voice',
  'share', 'shareModule', 'aiTips', 'dailyReport', 'esportsFeed', 'ownerFeature'
];

// 1. 模块清单与默认值
assert.deepEqual([...FEATURE_IDS].sort(), [...EXPECTED].sort(), '模块 id 必须与设计一致');
assert.equal(FEATURE_IDS.length, 10);
for (const id of FEATURE_IDS) assert.equal(FEATURE_DEFAULTS[id], false, `${id} 默认必须关闭`);

const example = JSON.parse(read('config.example.json'));
assert.deepEqual(Object.keys(example.features).sort(), ['disabled', ...EXPECTED].sort(), '示例配置必须包含 10 个开关');
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

// 打开后不再被总开关拦下（这里用 dsh-not-ready 证明已经越过总开关）
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

// 5. inner-life 作业 → 模块映射
assert.equal(featureForInnerJob('curiosity'), 'share');
assert.equal(featureForInnerJob('qzone'), 'qzone');
assert.equal(featureForInnerJob('aiTips'), 'aiTips');
assert.equal(featureForInnerJob('share:ai_tips'), 'aiTips');
assert.equal(featureForInnerJob('share:life_fun'), 'shareModule');
assert.equal(featureForInnerJob('reflection'), '');

// 6. 主人配置白名单：10 个 feature.* 可读可写
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

// 7. 强制调用 / 主人直发 / 待审草稿都不能绕过主开关
cfg.features.share = false;
for (const name of ['qzone', 'aiTips', 'share:life_fun']) {
  const forced = await inner.runJob(name, { force: true });
  assert.equal(forced.status, 'disabled', `${name} 的 force 不能绕过主开关`);
}
const previewCuriosity = await inner.runJob('curiosity', { dryRun: true });
assert.notEqual(previewCuriosity.status, 'disabled', 'dryRun 预览允许跳过主开关（不发送）');
const directQzone = await inner.ownerPublishQzone('离线测试内容');
assert.equal(directQzone.status, 'disabled', '主人/控制台直发不能绕过 features.qzone');
const draftPublish = await inner.publishShareDraft('ai_tips');
assert.equal(draftPublish.status, 'disabled', '待审分享草稿不能绕过 features.aiTips');
const forcedShare = await inner.runShareModule('ai_tips', { force: true });
assert.equal(forcedShare.status, 'disabled', '分享模块的 force 不能绕过主开关');
const sharePreview = await inner.runShareModule('ai_tips', { dryRun: true, force: true });
assert.notEqual(sharePreview.status, 'disabled', '分享模块 dryRun 预览不应被主开关拦住');

// 8. 控制台信息架构：10 个模块各一张卡、每个模块只有一个主开关
assert.deepEqual([...new Set(FEATURE_CARDS.map((card) => card.id))].sort(), [...EXPECTED].sort());
assert.equal(FEATURE_CARDS.length, 10);
assert.equal(FEATURE_MODULES.length, FEATURE_CARDS.length);
assert.deepEqual(FEATURE_BOARDS.map((board) => board.id), ['social', 'life', 'content', 'owner']);
for (const board of FEATURE_BOARDS) {
  assert(FEATURE_CARDS.some((card) => card.board === board.id), `板块 ${board.id} 必须至少有一个模块`);
}
for (const card of FEATURE_CARDS) {
  assert.equal(cardFor(card.id), card);
  assert.equal(typeof card.label, 'string');
  assert.equal(typeof card.onEffect, 'string');
  assert.equal(typeof card.offEffect, 'string');
}
assert.equal(cardFor('not-a-module'), null);

// 打开主开关时必须同时补齐硬依赖子开关，否则会出现「总开、子关」的死开关。
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

// 9. 控制台目录与页面
const catalog = buildConfigSchema(ownerCfg);
for (const id of FEATURE_IDS) {
  const field = catalog.fields.find((item) => item.key === `features.${id}`);
  assert.ok(field, `配置目录必须包含 features.${id}`);
  assert.equal(field.type, 'boolean');
  assert.equal(field.group, '功能总开关');
  assert.equal(field.restart, 'none');
}
const consoleHtml = read('web/deck.html');
assert.match(consoleHtml, /id="featureSwitches"/);
assert.match(consoleHtml, /id="featureSwitchesSave"/);
assert.match(consoleHtml, /data-feature-id/);

fs.rmSync(innerStateDir, { recursive: true, force: true });
console.log('feature switch checks passed');
