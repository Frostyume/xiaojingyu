#!/usr/bin/env node
/** 提醒存储：格式校验、按会话过滤、取消只影响本人、到期排序与上限。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  addReminder, cancelReminder, dueReminders, listReminders, loadReminderStore, saveReminderStore
} from '../services/social/reminders.js';

const NOW = Date.parse('2026-11-03T12:00:00+08:00');
const KEY = 'group:87654321';
const OTHER = 'private:12345678';
const anHourLater = NOW + 3600000;

test('addReminder：校验 key / 空内容 / 过去时间 / 超过 120 天', () => {
  const store = { reminders: [] };
  assert.throws(() => addReminder(store, { key: 'bad', text: 'x', dueAt: anHourLater }, NOW), /key 格式/);
  assert.throws(() => addReminder(store, { key: KEY, text: '   ', dueAt: anHourLater }, NOW), /不能为空/);
  assert.throws(() => addReminder(store, { key: KEY, text: 'x', dueAt: 'not-a-date' }, NOW), /ISO 时间/);
  assert.throws(() => addReminder(store, { key: KEY, text: 'x', dueAt: NOW - 120000 }, NOW), /已经过去/);
  assert.throws(() => addReminder(store, { key: KEY, text: 'x', dueAt: NOW + 121 * 24 * 3600000 }, NOW), /120 天/);
  const item = addReminder(store, { key: KEY, text: '  喝水  休息 ', dueAt: anHourLater, note: ' 注意 ', createdBy: 'owner' }, NOW);
  assert.equal(item.key, KEY);
  assert.equal(item.text, '喝水 休息');
  assert.equal(item.status, 'pending');
  assert.equal(store.reminders.length, 1);
});

test('listReminders：只看本会话 pending，按时间升序并标 overdue', () => {
  const store = { reminders: [] };
  addReminder(store, { key: KEY, text: 'later', dueAt: NOW + 7200000 }, NOW);
  addReminder(store, { key: KEY, text: 'earlier', dueAt: NOW + 60000 }, NOW);
  addReminder(store, { key: OTHER, text: 'other', dueAt: NOW + 30000 }, NOW);
  const list = listReminders(store, KEY, NOW);
  assert.deepEqual(list.map((x) => x.text), ['earlier', 'later']);
  assert.equal(list.every((x) => x.overdue === false), true);
  assert.equal(listReminders(store, KEY, NOW + 120000)[0].overdue, true);
});

test('cancelReminder：只有同会话的 pending 项能取消', () => {
  const store = { reminders: [] };
  const item = addReminder(store, { key: KEY, text: 'x', dueAt: anHourLater }, NOW);
  assert.equal(cancelReminder(store, OTHER, item.id, NOW), null, '别的会话不能取消');
  const cancelled = cancelReminder(store, KEY, item.id, NOW);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelReminder(store, KEY, item.id, NOW), null, '已取消的不能再取消');
  assert.equal(listReminders(store, KEY, NOW).length, 0);
});

test('dueReminders：只取到期的 pending，按时间排序并受 limit 限制', () => {
  const store = { reminders: [] };
  addReminder(store, { key: KEY, text: 'a', dueAt: NOW - 60000 }, NOW);
  addReminder(store, { key: KEY, text: 'b', dueAt: NOW - 30000 }, NOW);
  addReminder(store, { key: OTHER, text: 'c', dueAt: NOW - 10000 }, NOW);
  addReminder(store, { key: KEY, text: 'future', dueAt: NOW + 60000 }, NOW);
  const due = dueReminders(store, NOW, 2);
  assert.deepEqual(due.map((x) => x.text), ['a', 'b']);
  assert.equal(dueReminders(store, NOW, 10).length, 3);
  assert.equal(dueReminders(store, NOW, 1).length, 1, 'limit 有下界且生效');
});

test('load/save：往返保留 pending，损坏文件报错而不是清空', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'reminders-'));
  const file = path.join(dir, 'reminders.json');
  try {
    assert.deepEqual(loadReminderStore(file), { reminders: [] }, '不存在时返回空库');
    const store = { reminders: [] };
    addReminder(store, { key: KEY, text: 'x', dueAt: anHourLater }, NOW);
    saveReminderStore(file, store);
    const loaded = loadReminderStore(file);
    assert.equal(loaded.reminders.length, 1);
    assert.equal(loaded.reminders[0].text, 'x');
    fs.writeFileSync(file, '{"reminders":"broken"}');
    assert.throws(() => loadReminderStore(file), /结构不是/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
