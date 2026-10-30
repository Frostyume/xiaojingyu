import test from 'node:test';
import assert from 'node:assert/strict';
import { listOwnerCapabilities, capabilityById } from '../src/core/owner-capabilities.js';
import { normalizeOwnerFeature, validateOwnerFeature, nextOwnerFeatureRuns, renderOwnerFeaturePreview } from '../src/core/owner-features.js';

const at = (h, m = 0) => new Date(2026, 9, 29, h, m, 0, 0).getTime();

test('能力清单包含配置类与代码类', () => {
  const caps = listOwnerCapabilities();
  assert.ok(caps.some((c) => c.id === 'scheduled_message' && c.kind === 'config'));
  assert.ok(caps.some((c) => c.id === 'auto_reply'));
  assert.ok(caps.some((c) => c.id === 'voice_message'));
  assert.ok(caps.some((c) => c.id === 'qzone_post'));
  assert.ok(caps.some((c) => c.id === 'code_feature' && c.kind === 'code'));
  assert.equal(capabilityById('nope'), null);
});

test('定时消息：校验、排期、预览', () => {
  const feature = normalizeOwnerFeature({
    id: 'dad_medicine',
    type: 'scheduled_message',
    label: '爸爸吃药提醒',
    targets: ['group:1'],
    trigger: { type: 'daily', times: ['21:00'] },
    action: { type: 'send_text', text: '该吃药了，别忘了。' }
  });
  assert.equal(validateOwnerFeature(feature, { allowedTargets: ['group:1'], now: at(10) }).ok, true);
  const runs = nextOwnerFeatureRuns(feature, at(10), 2);
  assert.equal(runs.length, 2);
  assert.equal(new Date(runs[0]).getHours(), 21);
  const preview = renderOwnerFeaturePreview(feature, { now: at(10), targetLabels: { 'group:1': '家人群' } });
  assert.match(preview.text, /家人群/);
  assert.match(preview.scheduleText, /21:00/);
  assert.equal(validateOwnerFeature(feature, { allowedTargets: ['group:2'] }).ok, false);
});

test('自动回复：关键词 + 文本/语音', () => {
  const feature = normalizeOwnerFeature({
    id: 'weather_reply',
    type: 'auto_reply',
    targets: ['group:1'],
    trigger: { type: 'keyword', keywords: ['天气'] },
    action: { type: 'send_text', text: '我去查一下。' }
  });
  assert.equal(validateOwnerFeature(feature, { allowedTargets: ['group:1'] }).ok, true);
  assert.match(renderOwnerFeaturePreview(feature).text, /天气/);
  const bad = normalizeOwnerFeature({ ...feature, action: { type: 'send_voice', text: '太长了'.repeat(40) } });
  assert.equal(validateOwnerFeature(bad).ok, false);
});

test('语音/Qzone/一次性功能约束', () => {
  const voice = normalizeOwnerFeature({ id: 'v1', type: 'voice_message', targets: ['private:1'], trigger: { type: 'once', at: new Date(at(10) + 3600000).toISOString() }, action: { text: '晚安。' } });
  assert.equal(validateOwnerFeature(voice, { now: at(10) }).ok, true);
  assert.equal(nextOwnerFeatureRuns(voice, at(10)).length, 1);
  const qzone = normalizeOwnerFeature({ id: 'q1', type: 'qzone_post', targets: ['qzone'], trigger: { type: 'daily', times: ['12:00'] }, action: { text: '今天太阳很好。' } });
  assert.equal(validateOwnerFeature(qzone, { now: at(10) }).ok, true);
  const past = normalizeOwnerFeature({ id: 'o1', type: 'scheduled_message', targets: ['group:1'], trigger: { type: 'once', at: new Date(at(9)).toISOString() }, action: { text: 'x' } });
  assert.equal(validateOwnerFeature(past, { now: at(10) }).ok, false);
});

test('代码类功能只走提案，不在配置层应用', () => {
  const spec = normalizeOwnerFeature({ id: 'img_gen', type: 'code_feature', targets: ['self'], trigger: { type: 'keyword', keywords: ['画图'] }, action: { text: '生成图片' } });
  assert.equal(validateOwnerFeature(spec).ok, true);
  assert.match(renderOwnerFeaturePreview(spec).warnings.join(' '), /提案/);
});
