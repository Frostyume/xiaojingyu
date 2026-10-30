import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { backupConfigFile, pruneConfigBackups, CONFIG_BACKUP_KEEP } from '../runtime/kernel/config-backup.js';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'config-backup-'));
  const file = path.join(dir, 'config.json');
  fs.writeFileSync(file, '{"a":1}');
  return { dir, file };
}

test('备份命名带 tag 与时间戳，且内容与源一致', () => {
  const { file } = sandbox();
  const dest = backupConfigFile(file, { tag: 'dsh' });
  assert.match(path.basename(dest), /^config\.json\.bak-dsh-\d{4}-\d{2}-\d{2}T/);
  assert.equal(fs.readFileSync(dest, 'utf8'), '{"a":1}');
});

test('同一 tag 只保留最近 keep 份', () => {
  const { dir, file } = sandbox();
  for (let i = 0; i < CONFIG_BACKUP_KEEP + 4; i += 1) {
    backupConfigFile(file, { tag: 'dsh', keep: CONFIG_BACKUP_KEEP });
  }
  const left = fs.readdirSync(dir).filter((n) => n.startsWith('config.json.bak-dsh-'));
  assert.equal(left.length, CONFIG_BACKUP_KEEP);
  // 留下的是最新的（名字升序的末 keep 个）
  assert.equal(left.sort().at(-1), fs.readdirSync(dir).filter((n) => n.startsWith('config.json.bak-dsh-')).sort().at(-1));
});

test('不同 tag 分桶轮转，互不挤占', () => {
  const { dir, file } = sandbox();
  for (let i = 0; i < 3; i += 1) backupConfigFile(file, { tag: 'share', keep: 2 });
  for (let i = 0; i < 3; i += 1) backupConfigFile(file, { tag: 'console', keep: 2 });
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('config.json.bak-share-')).length, 2);
  assert.equal(fs.readdirSync(dir).filter((n) => n.startsWith('config.json.bak-console-')).length, 2);
});

test('源文件缺失时返回 null，不抛错', () => {
  const { dir } = sandbox();
  assert.equal(backupConfigFile(path.join(dir, 'missing.json'), { tag: 'dsh' }), null);
});

test('prune 对不存在的目录安全返回空数组', () => {
  const { dir } = sandbox();
  assert.deepEqual(pruneConfigBackups(path.join(dir, 'nope', 'config.json')), []);
});
