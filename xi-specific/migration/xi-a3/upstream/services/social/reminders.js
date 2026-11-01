// 轻量提醒存储。只存元数据，到点由桥接直接发送预先写好的话。
//
// 设计边界：
// - 不解析自然语言时间；由 AI 把时间解析成带时区的 ISO 字符串再写入。
// - 默认只允许主人私聊与家人群（由桥接的 allowedKeys 控制），避免在陌生群变成定时闹钟。
// - 文件损坏时抛出错误，调用方降级为只读，绝不把损坏文件覆盖成空库。

import fs from 'node:fs';
import { atomicWriteJson } from '../../runtime/kernel/state-file.js';
import crypto from 'node:crypto';

const MAX_TEXT = 300;
const MAX_NOTE = 80;
const MAX_ACTIVE = 100;
const MAX_AHEAD_MS = 120 * 24 * 3600 * 1000;
const MAX_PAST_MS = 60 * 1000;

function cleanText(value, max) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id || '').trim();
  const key = String(raw.key || '').trim();
  const text = cleanText(raw.text, MAX_TEXT);
  const dueAt = Number(raw.dueAt);
  if (!id || !/^(group|private):\d+$/.test(key) || !text || !Number.isFinite(dueAt)) return null;
  return {
    id,
    key,
    text,
    dueAt,
    createdAt: Number(raw.createdAt) || Date.now(),
    createdBy: String(raw.createdBy || ''),
    note: cleanText(raw.note, MAX_NOTE),
    status: raw.status === 'sent' || raw.status === 'failed' || raw.status === 'cancelled' ? raw.status : 'pending',
    attempts: Number(raw.attempts) || 0,
    lastAttemptAt: Number(raw.lastAttemptAt) || 0
  };
}

export function loadReminderStore(file) {
  if (!fs.existsSync(file)) return { reminders: [] };
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!parsed || !Array.isArray(parsed.reminders)) throw new Error('提醒文件结构不是 { reminders: [] }');
  return { reminders: parsed.reminders.map(normalizeItem).filter(Boolean) };
}

export function saveReminderStore(file, store) {
  atomicWriteJson(file, store);
}

export function addReminder(store, { key, text, dueAt, note, createdBy }, now = Date.now()) {
  const cleanKey = String(key || '').trim();
  if (!/^(group|private):\d+$/.test(cleanKey)) throw new Error('key 格式应为 group:群号 或 private:QQ号');
  const clean = cleanText(text, MAX_TEXT);
  if (!clean) throw new Error('提醒内容不能为空');
  const due = typeof dueAt === 'number' ? dueAt : Date.parse(String(dueAt || ''));
  if (!Number.isFinite(due)) throw new Error('dueAt 必须是带时区的 ISO 时间或毫秒时间戳');
  if (due < now - MAX_PAST_MS) throw new Error('提醒时间已经过去了');
  if (due > now + MAX_AHEAD_MS) throw new Error('提醒时间不能超过 120 天');
  const active = store.reminders.filter((item) => item.status === 'pending').length;
  if (active >= MAX_ACTIVE) throw new Error(`待发送提醒已达上限（${MAX_ACTIVE} 条）`);
  const item = {
    id: `rm-${now.toString(36)}-${crypto.randomBytes(3).toString('hex')}`,
    key: cleanKey,
    text: clean,
    dueAt: due,
    createdAt: now,
    createdBy: String(createdBy || ''),
    note: cleanText(note, MAX_NOTE),
    status: 'pending',
    attempts: 0,
    lastAttemptAt: 0
  };
  store.reminders.push(item);
  // 保留最近的已结束项，避免文件无限增长
  const finished = store.reminders.filter((x) => x.status !== 'pending');
  if (finished.length > 200) {
    const drop = new Set(finished.sort((a, b) => a.createdAt - b.createdAt).slice(0, finished.length - 200).map((x) => x.id));
    store.reminders = store.reminders.filter((x) => !drop.has(x.id));
  }
  return item;
}

export function listReminders(store, key, now = Date.now()) {
  return store.reminders
    .filter((item) => item.key === key && item.status === 'pending')
    .sort((a, b) => a.dueAt - b.dueAt)
    .map((item) => ({ ...item, overdue: item.dueAt < now }));
}

export function cancelReminder(store, key, id, now = Date.now()) {
  const item = store.reminders.find((x) => x.id === String(id) && x.key === key && x.status === 'pending');
  if (!item) return null;
  item.status = 'cancelled';
  item.lastAttemptAt = now;
  return item;
}

export function dueReminders(store, now = Date.now(), limit = 5) {
  return store.reminders
    .filter((item) => item.status === 'pending' && item.dueAt <= now)
    .sort((a, b) => a.dueAt - b.dueAt)
    .slice(0, Math.max(1, limit));
}
