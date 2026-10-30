// 主控唤醒信号：任务入队/结果回传时写一个极小的请求文件，由主控会话的后台等待任务消费。
// 纯文件操作；不启动任何进程、不发消息。

import fs from 'node:fs';
import { atomicWriteJson } from './state-file.js';
import path from 'node:path';

export function wakeFile(dir) {
  return path.join(dir, 'wake.request.json');
}

export function wakeArchiveFile(dir) {
  return path.join(dir, 'wake.last.json');
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

export function coordinatorInboxFile(dir) {
  return path.join(dir, 'coordinator-inbox.json');
}

/**
 * 主控收件箱：目标为主控的事件**不写** wake.request.json。
 * 桌面插件只消费 wake.request.json（会据此建执行会话），所以把待复核项挡在门外，
 * 旧版插件在内存里也不会替主控开工。
 */
export function noteCoordinatorItem(dir, { taskId = '', reason = '', now = Date.now() } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const file = coordinatorInboxFile(dir);
  const prev = readJson(file) || {};
  const items = Array.isArray(prev.items) ? prev.items.filter((item) => item && typeof item.id === 'string') : [];
  const id = String(taskId || '');
  const at = Number(now) || Date.now();
  const text = String(reason || 'task');
  const existing = id ? items.find((item) => item.id === id) : null;
  const next = existing
    ? items.map((item) => (item.id === id
      ? { ...item, reason: text, lastAt: at, times: (Number(item.times) || 1) + 1 }
      : item))
    : [...items, { id, reason: text, firstAt: at, lastAt: at, times: 1 }];
  const payload = { version: 1, updatedAt: at, items: next.slice(-100) };
  atomicWriteJson(file, payload);
  return payload;
}

export function readCoordinatorInbox(dir) {
  const raw = readJson(coordinatorInboxFile(dir));
  return raw && Array.isArray(raw.items) ? raw.items.filter((item) => item && typeof item === 'object') : [];
}

/**
 * 合并式写入：连续多次唤醒只保留一个文件，pending 累积任务 id。
 * target='coordinator' 走主控收件箱（见 noteCoordinatorItem），不进 pending；
 * 其余事件（含执行器派单）照旧进 pending，由桌面插件建会话执行。
 */
export function requestWake(dir, { taskId = '', reason = '', target = '', now = Date.now() } = {}) {
  if (target === 'coordinator') return noteCoordinatorItem(dir, { taskId, reason, now });
  fs.mkdirSync(dir, { recursive: true });
  const file = wakeFile(dir);
  const prev = readJson(file) || {};
  const pending = new Set(Array.isArray(prev.pending) ? prev.pending.map(String) : []);
  if (taskId) pending.add(String(taskId));
  const payload = {
    version: 1,
    requestedAt: Number(now) || Date.now(),
    firstRequestedAt: Number(prev.firstRequestedAt) || Number(now) || Date.now(),
    reason: String(reason || prev.reason || 'task'),
    pending: [...pending].slice(-50)
  };
  atomicWriteJson(file, payload);
  return payload;
}

export function readWake(dir) {
  return readJson(wakeFile(dir));
}

export function clearWake(dir) {
  try { fs.rmSync(wakeFile(dir), { force: true }); } catch {}
}

/** 消费：读取内容后把请求文件改名为 wake.last.json，避免“刚删又被写”的竞态。 */
export function consumeWake(dir, { now = Date.now() } = {}) {
  const payload = readWake(dir);
  if (!payload) return null;
  try {
    fs.renameSync(wakeFile(dir), wakeArchiveFile(dir));
  } catch {
    clearWake(dir);
  }
  return { ...payload, consumedAt: now, archive: 'wake.last.json' };
}
