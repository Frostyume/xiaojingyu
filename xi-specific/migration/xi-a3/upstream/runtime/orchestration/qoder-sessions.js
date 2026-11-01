// Qoder 会话归属与归档（唤醒通道的收尾）。
//
// 背景：桌面插件只能 createDetachedSession，宿主把 cwd 固定成
// `Documents\Qoder\<日期>\<会话前 8 位>`，workspace_id 为空、归档接口也没有权限。
// 于是任务闭环后会话永远留在「最近任务」列表里，且看起来不属于本项目工作区。
//
// 这里只做两件行级更新（SQLite，WAL 下可并发；实测改完前端列表立即生效）：
//   bind    workspace_id / cwd / execution_target_json → 本项目工作区
//   archive archived=1 + archived_at（= 应用里的「归档」，不是删除，历史与证据都还在）
// 不创建会话、不发消息、不碰消息表。

import fs from 'node:fs';
import { atomicWriteJson } from '../kernel/state-file.js';
import path from 'node:path';

export const SESSION_MAP_FILE = 'sessions.json';
export const TERMINAL_TASK_STATUSES = new Set(['done', 'rejected', 'archived']);

export function sessionMapFile(stateDir) {
  return path.join(stateDir, SESSION_MAP_FILE);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  return atomicWriteJson(file, value);
}

/** 任务 id → 会话 id 的映射（插件建完会话后写入，桥接读它做对账）。 */
export function readSessionMap(stateDir) {
  const raw = readJson(sessionMapFile(stateDir));
  const sessions = raw && typeof raw.sessions === 'object' && raw.sessions ? raw.sessions : {};
  const out = {};
  for (const [taskId, entry] of Object.entries(sessions)) {
    const sessionId = String(entry?.sessionId || '').trim();
    if (!taskId || !sessionId) continue;
    out[taskId] = {
      taskId,
      sessionId,
      createdAt: Number(entry.createdAt) || 0,
      updatedAt: Number(entry.updatedAt) || 0,
    };
  }
  return out;
}

export function recordSession(stateDir, { taskId, sessionId, now = Date.now() }) {
  const id = String(taskId || '').trim();
  const sid = String(sessionId || '').trim();
  if (!id || !sid) return null;
  const map = readSessionMap(stateDir);
  const prev = map[id];
  if (prev && prev.sessionId === sid) return prev;
  const entry = { taskId: id, sessionId: sid, createdAt: prev?.createdAt || now, updatedAt: now };
  map[id] = entry;
  writeJson(sessionMapFile(stateDir), { version: 1, updatedAt: now, sessions: map });
  return entry;
}

/** Qoder 桌面应用的会话库；`QODER_DB` 可覆盖（测试用）。 */
export function defaultDbFile(env = process.env) {
  const base = env.APPDATA || '';
  return base ? path.join(base, 'com.qodercn.app.stable', 'main.sqlite') : '';
}

function normPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
}

async function openDb(file) {
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(file);
}

export function findWorkspace(db, rootPath) {
  const rows = db.prepare('select workspace_id, name, root_paths_json from workspaces where deleted_at is null').all();
  for (const row of rows) {
    let roots = [];
    try { roots = JSON.parse(row.root_paths_json || '[]'); } catch {}
    if (Array.isArray(roots) && roots.some((root) => normPath(root) === normPath(rootPath))) {
      return { workspaceId: String(row.workspace_id), name: String(row.name || ''), rootPath: String(rootPath) };
    }
  }
  return null;
}

function workspaceExecutionTarget(db, workspaceId) {
  const row = db.prepare(
    'select execution_target_json from chat_sessions where workspace_id = ? and execution_target_json is not null order by updated_at desc limit 1'
  ).get(workspaceId);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.execution_target_json);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

export function bindSession(db, { sessionId, rootPath }) {
  const row = db.prepare(
    'select session_id, workspace_id, cwd, execution_target_json from chat_sessions where session_id = ?'
  ).get(sessionId);
  if (!row) return { ok: false, changed: false, error: `会话不存在：${sessionId}` };
  const workspace = findWorkspace(db, rootPath);
  if (!workspace) return { ok: false, changed: false, error: `未登记的工作区：${rootPath}` };
  if (row.workspace_id === workspace.workspaceId && normPath(row.cwd) === normPath(rootPath)) {
    return { ok: true, changed: false, workspaceId: workspace.workspaceId };
  }
  let target = null;
  try { target = row.execution_target_json ? JSON.parse(row.execution_target_json) : null; } catch {}
  const template = workspaceExecutionTarget(db, workspace.workspaceId);
  const base = template || target || { mode: 'local', host: { id: 'local', kind: 'local', label: 'Local' } };
  const nextTarget = { ...base, workspace: { ...(base.workspace || {}), path: String(rootPath) } };
  if (template?.workspace?.id) nextTarget.workspace.id = template.workspace.id;
  db.prepare('update chat_sessions set workspace_id = ?, cwd = ?, execution_target_json = ? where session_id = ?')
    .run(workspace.workspaceId, String(rootPath), JSON.stringify(nextTarget), sessionId);
  return { ok: true, changed: true, workspaceId: workspace.workspaceId };
}

export function archiveSession(db, { sessionId, now = Date.now() }) {
  const row = db.prepare('select archived, archived_at from chat_sessions where session_id = ?').get(sessionId);
  if (!row) return { ok: false, changed: false, error: `会话不存在：${sessionId}` };
  if (Number(row.archived) === 1 && Number(row.archived_at) > 0) return { ok: true, changed: false };
  db.prepare('update chat_sessions set archived = 1, archived_at = ? where session_id = ?').run(Number(now) || Date.now(), sessionId);
  return { ok: true, changed: true };
}

/**
 * 对账：任务已终态 → 归档会话；否则 → 绑定到工作区。
 * 幂等，可在启动、收到新会话映射、合并/拒绝后重复调用。
 * @param {{stateDir: string, dbFile: string, rootPath: string, taskStatusOf?: (id: string) => string}} options
 */
export async function reconcileTaskSessions({ stateDir, dbFile, rootPath, taskStatusOf = null, now = Date.now() }) {
  const map = readSessionMap(stateDir);
  const entries = Object.values(map);
  if (!entries.length) return { checked: 0, bound: [], archived: [], errors: [] };
  if (!dbFile || !fs.existsSync(dbFile)) {
    return { checked: entries.length, bound: [], archived: [], errors: [`会话库不存在：${dbFile || '(未配置)'}`] };
  }
  let db;
  try {
    db = await openDb(dbFile);
  } catch (error) {
    return { checked: entries.length, bound: [], archived: [], errors: [`打开会话库失败：${error?.message ?? error}`] };
  }
  const result = { checked: entries.length, bound: [], archived: [], errors: [] };
  try {
    for (const entry of entries) {
      const status = taskStatusOf ? String(taskStatusOf(entry.taskId) || '') : '';
      try {
        // 先绑回工作区（归档的会话也留在本工作区的归档里），再按状态归档。
        const bound = bindSession(db, { sessionId: entry.sessionId, rootPath });
        if (!bound.ok) result.errors.push(`${entry.taskId}: ${bound.error}`);
        else if (bound.changed) result.bound.push(entry.taskId);
        if (bound.ok && TERMINAL_TASK_STATUSES.has(status)) {
          const done = archiveSession(db, { sessionId: entry.sessionId, now });
          if (!done.ok) result.errors.push(`${entry.taskId}: ${done.error}`);
          else if (done.changed) result.archived.push(entry.taskId);
        }
      } catch (error) {
        result.errors.push(`${entry.taskId}: ${error?.message ?? error}`);
      }
    }
  } finally {
    try { db.close(); } catch {}
  }
  return result;
}
