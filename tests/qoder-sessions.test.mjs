import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  archiveSession,
  bindSession,
  findWorkspace,
  readSessionMap,
  reconcileTaskSessions,
  recordSession,
} from '../runtime/orchestration/qoder-sessions.js';

const ROOT_PATH = 'D:\\MyProjects\\demo';
const WORKSPACE_ID = '11111111-2222-3333-4444-555555555555';
const TARGET_JSON = JSON.stringify({
  mode: 'local',
  host: { id: 'local', kind: 'local', label: 'Local' },
  workspace: { id: 'ws_demo', path: ROOT_PATH },
});

function sandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qoder-sessions-'));
  const stateDir = path.join(dir, 'wake-bridge');
  const dbFile = path.join(dir, 'main.sqlite');
  const db = new DatabaseSync(dbFile);
  db.exec(`
    create table workspaces (workspace_id text primary key, name text, root_paths_json text, deleted_at integer);
    create table chat_sessions (
      session_id text primary key, workspace_id text, cwd text, execution_target_json text,
      archived integer not null default 0, archived_at integer, updated_at integer, deleted_at integer
    );
  `);
  db.prepare('insert into workspaces values (?,?,?,?)').run(WORKSPACE_ID, 'demo', JSON.stringify([ROOT_PATH]), null);
  // 工作区里已有的会话，作为 execution_target 模板
  db.prepare('insert into chat_sessions (session_id, workspace_id, cwd, execution_target_json, updated_at) values (?,?,?,?,?)')
    .run('tpl-session', WORKSPACE_ID, ROOT_PATH, TARGET_JSON, 100);
  db.prepare('insert into chat_sessions (session_id, workspace_id, cwd, execution_target_json, updated_at) values (?,?,?,?,?)')
    .run('wake-session', null, 'C:\\Users\\demo\\Documents\\Qoder\\2026-10-29\\wake',
      JSON.stringify({ mode: 'local', host: { id: 'local', kind: 'local', label: 'Local' }, workspace: { id: 'ws_tmp', path: 'C:\\Users\\demo\\Documents\\Qoder\\2026-10-29\\wake' } }), 200);
  db.close();
  return { dir, stateDir, dbFile };
}

function withDb(dbFile, fn) {
  const db = new DatabaseSync(dbFile);
  try { return fn(db); } finally { db.close(); }
}

test('会话映射可写入、去重、损坏文件安全', () => {
  const { stateDir } = sandbox();
  assert.deepEqual(readSessionMap(stateDir), {});
  recordSession(stateDir, { taskId: 'task_a', sessionId: 's-1', now: 10 });
  assert.equal(readSessionMap(stateDir).task_a.sessionId, 's-1');
  recordSession(stateDir, { taskId: 'task_a', sessionId: 's-1', now: 20 });
  assert.equal(readSessionMap(stateDir).task_a.createdAt, 10);
  fs.writeFileSync(path.join(stateDir, 'sessions.json'), '{not json');
  assert.deepEqual(readSessionMap(stateDir), {});
});

test('按根路径找到工作区', () => {
  const { dbFile } = sandbox();
  withDb(dbFile, (db) => {
    assert.equal(findWorkspace(db, 'd:/myprojects/demo/').workspaceId, WORKSPACE_ID);
    assert.equal(findWorkspace(db, 'D:\\nowhere'), null);
  });
});

test('绑定会话：补 workspace_id/cwd，沿用工作区模板的 execution_target，幂等', () => {
  const { dbFile } = sandbox();
  withDb(dbFile, (db) => {
    const first = bindSession(db, { sessionId: 'wake-session', rootPath: ROOT_PATH });
    assert.equal(first.ok, true);
    assert.equal(first.changed, true);
    const row = db.prepare('select workspace_id, cwd, execution_target_json from chat_sessions where session_id = ?').get('wake-session');
    assert.equal(row.workspace_id, WORKSPACE_ID);
    assert.equal(row.cwd, ROOT_PATH);
    const target = JSON.parse(row.execution_target_json);
    assert.equal(target.workspace.id, 'ws_demo');
    assert.equal(target.workspace.path, ROOT_PATH);
    assert.equal(bindSession(db, { sessionId: 'wake-session', rootPath: ROOT_PATH }).changed, false);
    assert.equal(bindSession(db, { sessionId: 'missing', rootPath: ROOT_PATH }).ok, false);
  });
});

test('归档会话：写 archived + archived_at，重复调用不再改', () => {
  const { dbFile } = sandbox();
  withDb(dbFile, (db) => {
    assert.equal(archiveSession(db, { sessionId: 'wake-session', now: 1234 }).changed, true);
    const row = db.prepare('select archived, archived_at from chat_sessions where session_id = ?').get('wake-session');
    assert.equal(row.archived, 1);
    assert.equal(row.archived_at, 1234);
    assert.equal(archiveSession(db, { sessionId: 'wake-session', now: 9999 }).changed, false);
  });
});

test('对账：未闭环绑定、已闭环绑定后归档，缺会话只报错不抛', async () => {
  const { stateDir, dbFile } = sandbox();
  recordSession(stateDir, { taskId: 'task_open', sessionId: 'wake-session', now: 1 });
  recordSession(stateDir, { taskId: 'task_done', sessionId: 'done-session', now: 1 });
  withDb(dbFile, (db) => {
    db.prepare('insert into chat_sessions (session_id, workspace_id, cwd, updated_at) values (?,?,?,?)')
      .run('done-session', null, 'C:\\tmp\\done', 300);
  });
  const statuses = { task_open: 'in_progress', task_done: 'done', task_missing: 'assigned' };
  const result = await reconcileTaskSessions({
    stateDir,
    dbFile,
    rootPath: ROOT_PATH,
    taskStatusOf: (id) => statuses[id] || '',
    now: 5000,
  });
  assert.deepEqual(result.bound, ['task_open', 'task_done']);
  assert.deepEqual(result.archived, ['task_done']);
  withDb(dbFile, (db) => {
    assert.equal(db.prepare('select workspace_id from chat_sessions where session_id = ?').get('wake-session').workspace_id, WORKSPACE_ID);
    const done = db.prepare('select workspace_id, archived, archived_at from chat_sessions where session_id = ?').get('done-session');
    assert.equal(done.workspace_id, WORKSPACE_ID);
    assert.equal(done.archived, 1);
    assert.equal(done.archived_at, 5000);
  });

  recordSession(stateDir, { taskId: 'task_ghost', sessionId: 'ghost-session', now: 1 });
  const second = await reconcileTaskSessions({ stateDir, dbFile, rootPath: ROOT_PATH, taskStatusOf: () => 'in_progress', now: 6000 });
  assert.equal(second.errors.length, 1);
  assert.match(second.errors[0], /会话不存在/);
});

test('会话库缺失时返回错误而不是抛异常', async () => {
  const { stateDir, dir } = sandbox();
  recordSession(stateDir, { taskId: 'task_a', sessionId: 's-1', now: 1 });
  const result = await reconcileTaskSessions({ stateDir, dbFile: path.join(dir, 'nope.sqlite'), rootPath: ROOT_PATH });
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /会话库不存在/);
});
