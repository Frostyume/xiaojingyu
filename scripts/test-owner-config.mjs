import test from 'node:test';
import assert from 'node:assert/strict';
import { readOwnerConfig, validateOwnerConfig, applyOwnerConfig, ownerConfigPatch } from '../src/core/owner-config.js';

const cfg = {
  simulation: {
    innerLife: { qzone: { maxPerDay: 2, minGapMs: 14400000, requireApproval: true }, groupShare: { maxPerDay: 20, minGapMs: 900000 } },
    signature: { minIntervalHours: 12, maxIntervalHours: 48, requireApproval: true },
    voice: { maxPerMinute: 6, maxPerHour: 60, maxSeconds: 45 },
    dailyReport: { enabled: false, at: '21:30' }
  },
  tts: { breeze: { cfgScale: 3.5, darkValenceThreshold: -0.35, darkRecoverValence: -0.1 } }
};

test('读取常用规则', () => {
  assert.equal(readOwnerConfig(cfg, 'qzone.maxPerDay'), 2);
  assert.equal(readOwnerConfig(cfg, 'qzone.minGapMinutes'), 240);
  assert.equal(readOwnerConfig(cfg, 'signature.minIntervalHours'), 12);
  assert.equal(readOwnerConfig(cfg, 'tts.breeze.cfgScale'), 3.5);
  assert.equal(readOwnerConfig(cfg, 'nope'), undefined);
});

test('校验范围与类型', () => {
  assert.equal(validateOwnerConfig('qzone.maxPerDay', 3).ok, true);
  assert.equal(validateOwnerConfig('qzone.maxPerDay', 99).ok, false);
  assert.equal(validateOwnerConfig('qzone.minGapMinutes', 30).ok, true);
  assert.equal(validateOwnerConfig('qzone.minGapMinutes', 5).ok, false);
  assert.equal(validateOwnerConfig('qzone.requireApproval', false).ok, true);
  assert.equal(validateOwnerConfig('qzone.requireApproval', 'no').ok, false);
  assert.equal(validateOwnerConfig('dailyReport.at', '09:05').value, '09:05');
  assert.equal(validateOwnerConfig('dailyReport.at', '25:00').ok, false);
  assert.equal(validateOwnerConfig('tts.breeze.cfgScale', 2.5).restart, undefined);
});

test('生成配置 patch 时做单位转换', () => {
  const gap = ownerConfigPatch('qzone.minGapMinutes', 120);
  assert.equal(gap.ok, true);
  assert.equal(gap.path, 'simulation.innerLife.qzone.minGapMs');
  assert.equal(gap.stored, 7200000);
  const share = applyOwnerConfig(cfg, 'share.maxPerDay', 8);
  assert.equal(share.ok, true);
  assert.equal(share.path, 'simulation.innerLife.groupShare.maxPerDay');
  assert.equal(share.before, 20);
});
