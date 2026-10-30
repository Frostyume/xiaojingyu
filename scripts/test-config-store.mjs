#!/usr/bin/env node
/** 配置写入口：备份策略（每日一份 / 危险操作每次）+ 拒绝写坏 + 备份失败语义。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createConfigWriter } from '../src/core/config-store.js';

function sandbox(initial = { socialV2: { enabled: true } }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, JSON.stringify(initial));
  const writes = [];
  const writer = createConfigWriter({
    configFile: file,
    write: (target, obj) => { writes.push({ target, obj }); fs.writeFileSync(target, JSON.stringify(obj)); },
    now: () => new Date('2026-10-30T03:00:00Z')
  });
  return { dir, file, writer, writes };
}

function backups(dir, tag) {
  return fs.readdirSync(dir).filter((n) => n.startsWith(`config.json.bak-${tag}-`));
}

test('同一天多次普通写只备份一次', () => {
  const { dir, writer } = sandbox();
  writer.write({ a: 1 }, { tag: 'social' });
  writer.write({ a: 2 }, { tag: 'social' });
  writer.write({ a: 3 }, { tag: 'social' });
  assert.equal(backups(dir, 'social').length, 1);
});

test('危险写每次都备份（即使当天已备份过）', () => {
  const { dir, writer } = sandbox();
  writer.write({ a: 1 }, { tag: 'console' });
  writer.write({ allow: { groups: [] } }, { tag: 'console', danger: true });
  writer.write({ allow: { groups: [1] } }, { tag: 'console', danger: true });
  assert.equal(backups(dir, 'console').length, 3);
});

test('不同 tag 分桶，互不影响每日去重', () => {
  const { dir, writer } = sandbox();
  writer.write({ a: 1 }, { tag: 'social' });
  writer.write({ b: 1 }, { tag: 'share' });
  assert.equal(backups(dir, 'social').length, 1);
  assert.equal(backups(dir, 'share').length, 1);
});

test('写入内容落到磁盘且原文件被替换', () => {
  const { dir, file, writer } = sandbox();
  writer.write({ socialV2: { enabled: false }, extra: 1 }, { tag: 'social' });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { socialV2: { enabled: false }, extra: 1 });
  assert.equal(backups(dir, 'social').length, 1);
  // 备份是写之前的内容
  const bak = path.join(dir, backups(dir, 'social')[0]);
  assert.deepEqual(JSON.parse(fs.readFileSync(bak, 'utf8')), { socialV2: { enabled: true } });
});

test('非对象目标一律拒绝，不落盘', () => {
  const { writer, writes } = sandbox();
  for (const bad of [null, [], 'x', 42]) {
    assert.throws(() => writer.write(bad, { tag: 'social' }), /目标不是普通对象/);
  }
  assert.equal(writes.length, 0);
});

test('危险写备份失败时拒绝写入（没有回滚点就不动手）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-store-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{}');
  const writes = [];
  const writer = createConfigWriter({
    configFile: file,
    write: (target) => writes.push(target)
  });
  // 让备份目录不可读：把 config 换成一个不存在目录下的路径
  const broken = createConfigWriter({
    configFile: path.join(dir, 'no-such-dir', 'config.json'),
    write: (target) => writes.push(target)
  });
  assert.throws(() => broken.write({ a: 1 }, { tag: 'console', danger: true }), /备份失败/);
  assert.equal(writes.length, 0, '备份失败时不得写入');
  // 普通写仍然放行（只是没有快照）
  writer.write({ a: 1 }, { tag: 'console' });
  assert.equal(writes.length, 1);
});
