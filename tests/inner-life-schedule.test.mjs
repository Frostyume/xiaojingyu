#!/usr/bin/env node
/** 内心生活调度与夜间静默的离线断言，不启动桥接、不连 DSH、不读生产 config。 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeQuietHours, isQuietNow, quietEndAt } from '../services/persona/quiet-hours.js';

// 固定夹具：跨越午夜（23:30 → 08:30）。生产把时间改成什么，都不影响这一段。
const quiet = normalizeQuietHours({ enabled: true, start: '23:30', end: '08:30' });
assert.equal(quiet.enabled, true, '夹具应启用夜间静默');
assert.equal(isQuietNow(quiet, new Date('2026-10-26T23:29:00')), false, '起点前一分钟不在窗口内');
assert.equal(isQuietNow(quiet, new Date('2026-10-26T23:30:00')), true, '起点即在窗口内');
assert.equal(isQuietNow(quiet, new Date('2026-10-27T02:00:00')), true, '跨午夜后仍在窗口内');
assert.equal(isQuietNow(quiet, new Date('2026-10-27T08:29:00')), true, '结束前仍在窗口内');
assert.equal(isQuietNow(quiet, new Date('2026-10-27T08:30:00')), false, '结束点即出窗口');
const endAt = quietEndAt(quiet, new Date('2026-10-27T02:00:00').getTime());
assert.equal(new Date(endAt).getHours(), 8, '静默结束应落在 08 点');

const disabled = normalizeQuietHours({ enabled: false, start: '23:00', end: '08:30' });
assert.equal(isQuietNow(disabled, new Date('2026-10-27T02:00:00')), false, '关闭后任何时间都不静默');

// 生产 config 的一致性检查：只断言"不可能同时成立"的约束，
// 不锁具体数值（避免主人调参把测试调红）。
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const configPath = resolve(root, 'config.json');
if (existsSync(configPath)) {
  const config = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  const inner = config.simulation?.innerLife ?? {};
  const reflection = inner.reflection ?? {};
  if (reflection.minIntervalMs != null && reflection.maxIntervalMs != null) {
    assert(
      reflection.maxIntervalMs >= reflection.minIntervalMs,
      '反思间隔上限不得小于下限'
    );
  }
  const qzone = inner.qzone ?? {};
  if (qzone.enabled === true) {
    assert((qzone.skipProbability ?? 0) <= 0.2, '随机跳过概率过高会让说说长期不出现');
  }
  if (inner.approvalTimeoutMs != null) {
    assert(inner.approvalTimeoutMs >= 2 * 3600000, '草稿审核有效期至少 2 小时');
  }
}

console.log('inner-life schedule checks passed');
