import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { requestWake, readWake, clearWake, consumeWake, wakeFile, coordinatorInboxFile, readCoordinatorInbox } from '../runtime/orchestration/orchestrator-wake.js';

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-wake-'));
  return { base, dir: path.join(base, 'orchestrator') };
}

test('首次唤醒写入请求文件', () => {
  const { dir } = sandbox();
  const payload = requestWake(dir, { taskId: 'task_a', reason: 'code_feature', now: 1000 });
  assert.equal(payload.pending.length, 1);
  assert.equal(payload.pending[0], 'task_a');
  assert.equal(payload.requestedAt, 1000);
  const read = readWake(dir);
  assert.equal(read.reason, 'code_feature');
  assert.ok(fs.existsSync(wakeFile(dir)));
});

test('连续唤醒合并为一个文件并累积 pending', () => {
  const { dir } = sandbox();
  requestWake(dir, { taskId: 'task_a', now: 1000 });
  const second = requestWake(dir, { taskId: 'task_b', now: 2000 });
  assert.deepEqual(second.pending, ['task_a', 'task_b']);
  assert.equal(second.requestedAt, 2000);
  assert.equal(second.firstRequestedAt, 1000);
  const files = fs.readdirSync(dir).filter((name) => name.startsWith('wake.request'));
  assert.equal(files.length, 1);
});

test('无 taskId 的唤醒保留已有 pending', () => {
  const { dir } = sandbox();
  requestWake(dir, { taskId: 'task_a', now: 1000 });
  const second = requestWake(dir, { reason: 'result:tested', now: 2000 });
  assert.deepEqual(second.pending, ['task_a']);
  assert.equal(second.reason, 'result:tested');
});

test('消费后归档为 wake.last.json，新的写入不受影响', () => {
  const { dir } = sandbox();
  requestWake(dir, { taskId: 'task_a', now: 1000 });
  const consumed = consumeWake(dir, { now: 1500 });
  assert.equal(consumed.pending[0], 'task_a');
  assert.equal(consumed.consumedAt, 1500);
  assert.equal(readWake(dir), null);
  assert.ok(fs.existsSync(path.join(dir, 'wake.last.json')));
  requestWake(dir, { taskId: 'task_b', now: 2000 });
  assert.deepEqual(readWake(dir).pending, ['task_b']);
});

test('target=coordinator 只进主控收件箱，不进唤醒队列', () => {
  const { dir } = sandbox();
  const payload = requestWake(dir, { taskId: 'task_a', reason: 'propose_code', target: 'coordinator', now: 1000 });
  assert.equal(payload.items.length, 1);
  assert.equal(payload.items[0].id, 'task_a');
  assert.equal(readWake(dir), null, '插件消费的唤醒文件里不能出现待主控复核的 id');
  assert.ok(fs.existsSync(coordinatorInboxFile(dir)));
  assert.deepEqual(readCoordinatorInbox(dir).map((item) => item.id), ['task_a']);
});

test('同一提案重复入箱只累加次数', () => {
  const { dir } = sandbox();
  requestWake(dir, { taskId: 'task_a', reason: 'propose_code', target: 'coordinator', now: 1000 });
  const second = requestWake(dir, { taskId: 'task_a', reason: 'propose_code', target: 'coordinator', now: 2000 });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].times, 2);
  assert.equal(second.items[0].firstAt, 1000);
  assert.equal(second.items[0].lastAt, 2000);
});

test('执行器派单仍走唤醒队列', () => {
  const { dir } = sandbox();
  const payload = requestWake(dir, { taskId: 'task_a', reason: 'dispatch', target: 'executor', now: 1000 });
  assert.deepEqual(payload.pending, ['task_a']);
  assert.equal(readCoordinatorInbox(dir).length, 0);
});

test('clear 与空目录读取安全', () => {
  const { dir } = sandbox();
  assert.equal(readWake(dir), null);
  assert.equal(consumeWake(dir), null);
  requestWake(dir, { taskId: 'task_a' });
  clearWake(dir);
  assert.equal(readWake(dir), null);
  clearWake(dir);
});
