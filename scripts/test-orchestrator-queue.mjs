import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { enqueueTask, readTask, listTasks, updateTask, closeTask, renderTaskArchive, queueSnapshot, validTaskId } from '../src/core/orchestrator-queue.js';

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-test-'));
  return { base, dir: path.join(base, 'orchestrator') };
}

test('任务 id 校验', () => {
  assert.equal(validTaskId('daily_ping'), true);
  assert.equal(validTaskId('../x'), false);
  assert.equal(validTaskId('X'), false);
});

test('入队、FIFO 列表与重复入队', () => {
  const { dir } = sandbox();
  const a = enqueueTask(dir, { id: 'task_a', title: 'A', now: 1000 });
  const b = enqueueTask(dir, { id: 'task_b', title: 'B', kind: 'config', now: 2000 });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.equal(readTask(dir, 'task_a').status, 'pending_review');
  assert.deepEqual(listTasks(dir).map((t) => t.id), ['task_a', 'task_b']);
  const again = enqueueTask(dir, { id: 'task_a', title: 'A2', now: 3000 });
  assert.equal(again.existed, true);
  assert.equal(again.task.title, 'A2');
  assert.equal(again.task.status, 'pending_review');
});

test('状态流转与关闭；终态不会被重新入队覆盖', () => {
  const { dir } = sandbox();
  enqueueTask(dir, { id: 'task_a', title: 'A', now: 1000 });
  updateTask(dir, 'task_a', { status: 'assigned', assignedTo: 'agent-1' }, { by: 'orchestrator', now: 2000 });
  updateTask(dir, 'task_a', { status: 'in_progress' }, { by: 'agent-1', now: 3000 });
  const closed = closeTask(dir, 'task_a', { status: 'done', note: 'merged', now: 4000 });
  assert.equal(closed.ok, true);
  assert.equal(closed.task.status, 'done');
  assert.equal(closed.task.closedAt, 4000);
  assert.ok(closed.task.history.length >= 4);
  assert.equal(closeTask(dir, 'task_a', { status: 'archived' }).ok, false);
  const requeue = enqueueTask(dir, { id: 'task_a', title: 'A', now: 5000 });
  assert.equal(requeue.task.status, 'done');
});

test('快照只统计活跃任务', () => {
  const { dir } = sandbox();
  enqueueTask(dir, { id: 'task_a', now: 1000 });
  enqueueTask(dir, { id: 'task_b', now: 2000 });
  closeTask(dir, 'task_b', { status: 'rejected', now: 3000 });
  const snap = queueSnapshot(dir);
  assert.equal(snap.pending, 1);
  assert.equal(snap.total, 2);
  assert.equal(listTasks(dir, { statuses: ['done', 'rejected'] }).length, 1);
});

test('归档文案包含结论、证据与文件名', () => {
  const { dir } = sandbox();
  enqueueTask(dir, { id: 'task_a', title: '每日播报', kind: 'code', now: 1000 });
  const task = closeTask(dir, 'task_a', { status: 'done', note: '实现了播报', now: new Date(2026, 9, 29, 12).getTime() }).task;
  const archive = renderTaskArchive(task, { date: new Date(2026, 9, 29), evidence: ['npm run verify 44/44'], decisions: ['主人批准合并'] });
  assert.equal(archive.filename, '2026-10-29-task_a.md');
  assert.match(archive.markdown, /每日播报/);
  assert.match(archive.markdown, /实现/);
  assert.match(archive.markdown, /verify 44\/44/);
  assert.match(archive.markdown, /主人批准合并/);
});

test('读取不存在或非法 id 不抛异常', () => {
  const { dir } = sandbox();
  assert.equal(readTask(dir, 'nope'), null);
  assert.equal(readTask(dir, '../x'), null);
  assert.deepEqual(listTasks(dir), []);
});
