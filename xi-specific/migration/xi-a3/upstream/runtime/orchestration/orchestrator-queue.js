// 主控队列：私聊发起的开发/配置任务在这里排队，由主控会话指派 agent、验收、归档。
// 纯文件操作；不发送消息、不改其他状态。

import fs from 'node:fs';
import { atomicWriteJson } from '../kernel/state-file.js';
import path from 'node:path';

export const TASK_STATUSES = ['pending_review', 'assigned', 'in_progress', 'review', 'done', 'rejected', 'archived'];
const TERMINAL = new Set(['done', 'rejected', 'archived']);
const TASK_ID_RE = /^[a-z][a-z0-9_-]{1,40}$/;

export function validTaskId(id) {
  return TASK_ID_RE.test(String(id || ''));
}

function tasksDir(dir) {
  return path.join(dir, 'tasks');
}

export function taskFile(dir, id) {
  return path.join(tasksDir(dir), `${id}.json`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  return atomicWriteJson(file, value);
}

export function normalizeTask(raw, id) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const status = TASK_STATUSES.includes(String(value.status)) ? String(value.status) : 'pending_review';
  return {
    id: String(value.id || id || '').trim(),
    kind: value.kind === 'config' ? 'config' : 'code',
    source: String(value.source || 'private-chat'),
    status,
    title: String(value.title || value.id || '').slice(0, 80),
    feature: value.feature && typeof value.feature === 'object' ? value.feature : null,
    proposalPath: String(value.proposalPath || ''),
    qoderPrompt: String(value.qoderPrompt || ''),
    resultPath: String(value.resultPath || ''),
    assignedTo: String(value.assignedTo || ''),
    note: String(value.note || '').slice(0, 2000),
    createdAt: Number(value.createdAt) || 0,
    updatedAt: Number(value.updatedAt) || 0,
    closedAt: Number(value.closedAt) || 0,
    history: Array.isArray(value.history) ? value.history.slice(-100) : []
  };
}

export function enqueueTask(dir, { id, title = '', kind = 'code', feature = null, proposalPath = '', qoderPrompt = '', resultPath = '', source = 'private-chat', note = '', now = Date.now() }) {
  if (!validTaskId(id)) return { ok: false, error: '任务 id 必须是 2–41 位小写字母/数字/下划线/连字符' };
  const file = taskFile(dir, id);
  const existing = readJson(file);
  const base = existing ? normalizeTask(existing, id) : normalizeTask({ id, createdAt: now }, id);
  const task = {
    ...base,
    id,
    title: String(title || base.title || id).slice(0, 80),
    kind: kind === 'config' ? 'config' : 'code',
    source,
    feature: feature || base.feature,
    proposalPath: proposalPath || base.proposalPath,
    qoderPrompt: qoderPrompt || base.qoderPrompt,
    resultPath: resultPath || base.resultPath,
    status: existing && TERMINAL.has(base.status) ? base.status : 'pending_review',
    note: note || base.note,
    updatedAt: now
  };
  task.history = [...(base.history || []), { at: now, status: task.status, by: source }].slice(-100);
  writeJson(file, task);
  return { ok: true, task, existed: Boolean(existing) };
}

export function readTask(dir, id) {
  if (!validTaskId(id)) return null;
  const raw = readJson(taskFile(dir, id));
  return raw ? normalizeTask(raw, id) : null;
}

export function listTasks(dir, { statuses = null } = {}) {
  const folder = tasksDir(dir);
  if (!fs.existsSync(folder)) return [];
  const allow = Array.isArray(statuses) && statuses.length ? new Set(statuses) : null;
  return fs.readdirSync(folder)
    .filter((file) => file.endsWith('.json'))
    .map((file) => normalizeTask(readJson(path.join(folder, file)), file.replace(/\.json$/, '')))
    .filter((task) => task.id && (!allow || allow.has(task.status)))
    .sort((a, b) => a.createdAt - b.createdAt);
}

export function updateTask(dir, id, patch = {}, { by = 'orchestrator', note = '', now = Date.now() } = {}) {
  const task = readTask(dir, id);
  if (!task) return { ok: false, error: `任务 ${id} 不存在` };
  const status = patch.status && TASK_STATUSES.includes(patch.status) ? patch.status : task.status;
  const next = {
    ...task,
    ...patch,
    id: task.id,
    status,
    note: note ? String(note).slice(0, 2000) : (patch.note !== undefined ? String(patch.note).slice(0, 2000) : task.note),
    updatedAt: now,
    closedAt: TERMINAL.has(status) ? (task.closedAt || now) : 0
  };
  next.history = [...task.history, { at: now, status, by, note: note ? String(note).slice(0, 200) : '' }].slice(-100);
  writeJson(taskFile(dir, id), next);
  return { ok: true, task: next };
}

/** 关闭任务：done=已合并/已验收，rejected=放弃；随后由主控写入归档文件。 */
export function closeTask(dir, id, { status = 'done', note = '', by = 'orchestrator', now = Date.now() } = {}) {
  if (!['done', 'rejected'].includes(status)) return { ok: false, error: 'close 只接受 done/rejected' };
  return updateTask(dir, id, { status }, { by, note, now });
}

export function renderTaskArchive(task, { date = new Date(), decisions = [], evidence = [] } = {}) {
  const d = date instanceof Date ? date : new Date(date);
  const pad = (n) => String(n).padStart(2, '0');
  const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const lines = [
    `# ${day} ${task.id} · ${task.title || task.id}`,
    '',
    `- 来源：${task.source}`,
    `- 类型：${task.kind}`,
    `- 状态：${task.status}`,
    `- 创建：${task.createdAt ? new Date(task.createdAt).toISOString() : '-'}`,
    `- 关闭：${task.closedAt ? new Date(task.closedAt).toISOString() : '-'}`,
    task.assignedTo ? `- 执行 agent：${task.assignedTo}` : '',
    '',
    '## 结论 / 改动',
    '',
    task.note || '（未填写）',
    '',
    '## 证据',
    '',
    ...(evidence.length ? evidence.map((item) => `- ${item}`) : ['- （未填写）']),
    '',
    '## 决策',
    '',
    ...(decisions.length ? decisions.map((item) => `- ${item}`) : ['- （无）']),
    '',
    '## 遗留风险',
    '',
    '- （未填写）',
    ''
  ];
  return { day, filename: `${day}-${task.id}.md`, markdown: lines.filter((line) => line !== null).join('\n') };
}

export function queueSnapshot(dir) {
  const tasks = listTasks(dir);
  const active = tasks.filter((task) => !TERMINAL.has(task.status));
  return {
    pending: active.length,
    total: tasks.length,
    tasks: tasks.slice(-20).map((task) => ({
      id: task.id,
      kind: task.kind,
      status: task.status,
      title: task.title,
      assignedTo: task.assignedTo,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt
    }))
  };
}
