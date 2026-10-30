#!/usr/bin/env node
/** 状态文件适配层：原子写不留 tmp、失败不毁旧值、BOM 容错、required 语义。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicWriteJson, atomicWriteText, readJsonSafe, renameWithRetry } from '../src/core/state-file.js';

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'state-file-'));
  return { dir, file: path.join(dir, 'state.json') };
}

function tmps(dir) {
  return fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
}

test('写 JSON 后可原样读回，且不留临时文件', () => {
  const { dir, file } = sandbox();
  atomicWriteJson(file, { a: 1, nested: { b: [2, 3] } });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { a: 1, nested: { b: [2, 3] } });
  assert.equal(tmps(dir).length, 0);
});

test('写文本后内容一致，且不留临时文件', () => {
  const { dir, file } = sandbox();
  atomicWriteText(file, '第一行\n第二行\n');
  assert.equal(fs.readFileSync(file, 'utf8'), '第一行\n第二行\n');
  assert.equal(tmps(dir).length, 0);
});

test('自动创建父目录', () => {
  const { dir } = sandbox();
  const deep = path.join(dir, 'a', 'b', 'state.json');
  atomicWriteJson(deep, { ok: true });
  assert.deepEqual(JSON.parse(fs.readFileSync(deep, 'utf8')), { ok: true });
});

test('目标不可替换时抛错：旧文件保持完整，临时文件被清掉', () => {
  const { dir, file } = sandbox();
  fs.writeFileSync(file, JSON.stringify({ old: true }));
  // 目标改成只读：Windows 上 rename 覆盖只读文件会失败（非 EPERM/EBUSY/EACCES 也照样抛）。
  fs.chmodSync(file, 0o444);
  let threw = false;
  try {
    atomicWriteJson(file, { new: true });
  } catch {
    threw = true;
  }
  fs.chmodSync(file, 0o644);
  // 关键不变量：目标要么是完整旧值，要么是完整新值——绝不允许「删了旧值、只剩 tmp」。
  const content = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(content.old === true || content.new === true, '目标文件必须始终可解析');
  assert.equal(tmps(dir).length, 0, '失败不得留下临时文件');
  if (threw) assert.equal(content.old, true, '抛错时旧值必须还在');
});

test('JSON.stringify 失败时直接抛错且不动原文件', () => {
  const { dir, file } = sandbox();
  fs.writeFileSync(file, JSON.stringify({ old: true }));
  const circular = {};
  circular.self = circular;
  assert.throws(() => atomicWriteJson(file, circular));
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { old: true });
  assert.equal(tmps(dir).length, 0);
});

test('readJsonSafe：容忍 UTF-8 BOM', () => {
  const { file } = sandbox();
  fs.writeFileSync(file, `\uFEFF${JSON.stringify({ bom: true })}`);
  assert.deepEqual(readJsonSafe(file, null), { bom: true });
});

test('readJsonSafe：文件缺失 / 内容损坏时返回 fallback', () => {
  const { file } = sandbox();
  assert.equal(readJsonSafe(file, 'fallback'), 'fallback');
  fs.writeFileSync(file, '{ 不是 JSON');
  assert.equal(readJsonSafe(file, 'fallback'), 'fallback');
});

test('readJsonSafe：required 时缺失或损坏都要抛，并点明文件', () => {
  const { file } = sandbox();
  assert.throws(() => readJsonSafe(file, null, true), /配置文件读取\/解析失败/);
  fs.writeFileSync(file, 'not json');
  assert.throws(() => readJsonSafe(file, null, true), /state\.json/);
});

test('renameWithRetry：不可重试的错误立刻抛出', () => {
  const { dir } = sandbox();
  const started = Date.now();
  assert.throws(() => renameWithRetry(path.join(dir, 'missing'), path.join(dir, 'target')));
  assert.ok(Date.now() - started < 200, '不该对 ENOENT 做退避重试');
});
