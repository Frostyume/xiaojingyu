import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  validProposalId,
  safeRelTarget,
  createProposal,
  listProposals,
  proposalSummary,
  readResult,
  writeResult,
  normalizeProposalResult,
  mergeProposal,
  rejectProposal,
  notificationFor,
  buildQoderTaskPrompt
} from '../runtime/orchestration/dev-proposals.js';

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'dev-proposal-test-'));
  const dir = path.join(base, 'state', 'dev-proposals');
  const repo = path.join(base, 'repo');
  const worktree = path.join(base, 'worktree');
  fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
  fs.mkdirSync(path.join(worktree, 'src'), { recursive: true });
  fs.mkdirSync(dir, { recursive: true });
  return { base, dir, repo, worktree };
}

const feature = {
  id: 'daily_ping',
  label: '每日播报',
  action: { type: 'send_text', text: '每天播一条天气' },
  targets: ['group:1']
};

test('提案 id 与路径安全', () => {
  assert.equal(validProposalId('daily_ping'), true);
  assert.equal(validProposalId('../evil'), false);
  assert.equal(validProposalId('Bad-Id'), false);
  assert.equal(safeRelTarget('src/a.js'), 'src/a.js');
  assert.equal(safeRelTarget('src\\a.js'), 'src/a.js');
  assert.equal(safeRelTarget('../a.js'), '');
  assert.equal(safeRelTarget('C:/a.js'), '');
  assert.equal(safeRelTarget('/etc/passwd'), '');
  assert.equal(safeRelTarget(''), '');
});

test('提案落盘、列表与摘要', () => {
  const { dir } = sandbox();
  const created = createProposal({ dir, id: 'daily_ping', feature, now: 1000 });
  assert.equal(created.ok, true);
  assert.ok(fs.existsSync(path.join(dir, 'daily_ping.json')));
  const listed = listProposals(dir);
  assert.equal(listed.length, 1);
  const summary = proposalSummary(listed[0]);
  assert.equal(summary.id, 'daily_ping');
  assert.equal(summary.status, 'proposed');
  assert.equal(summary.label, '每日播报');
  assert.equal(createProposal({ dir, id: '../x', feature }).ok, false);
});

test('Qoder 回传结果校验：只接受 tested/failed 与安全相对路径', () => {
  const ok = normalizeProposalResult({ status: 'tested', worktree: 'D:/wt/daily_ping', changed: ['src/a.js', 'src\\b.js'] });
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.result.changed, ['src/a.js', 'src/b.js']);
  assert.equal(normalizeProposalResult({ status: 'done', worktree: 'x' }).ok, false);
  assert.equal(normalizeProposalResult({ status: 'tested', worktree: '' }).ok, false);
  assert.equal(normalizeProposalResult({ status: 'tested', worktree: 'x', changed: [] }).ok, false);
  assert.equal(normalizeProposalResult({ status: 'tested', worktree: 'x', changed: ['../evil.js'] }).ok, false);
  assert.equal(normalizeProposalResult({ status: 'failed', worktree: 'x', changed: [] }).ok, true);
});

test('端到端：提案 → 隔离实现回传 → 通知 → 确认合并 → verify 通过', () => {
  const { dir, repo, worktree } = sandbox();
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'old');
  fs.writeFileSync(path.join(worktree, 'src', 'a.js'), 'new');
  createProposal({ dir, id: 'daily_ping', feature });
  // Qoder 会话在隔离副本完成后回传 result.json
  writeResult(dir, 'daily_ping', {
    status: 'tested',
    worktree,
    changed: ['src/a.js'],
    diffStat: ' src/a.js | 2 +-',
    logPath: 'state/dev-proposals/daily_ping.log'
  });
  const result = readResult(dir, 'daily_ping');
  const text = notificationFor(result);
  assert.match(text, /代码提案完成/);
  assert.match(text, /合并 daily_ping/);
  // 通知一次后不再重复
  writeResult(dir, 'daily_ping', { ...result, notified: true });
  assert.equal(notificationFor(readResult(dir, 'daily_ping')), null);

  const merged = mergeProposal({
    dir,
    id: 'daily_ping',
    root: repo,
    backupRoot: path.join(dir, '..', 'dev-backups'),
    verify: () => ({ ok: true, output: '44/44' })
  });
  assert.equal(merged.ok, true);
  assert.deepEqual(merged.changed, ['src/a.js']);
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8'), 'new');
  assert.equal(fs.readFileSync(path.join(dir, '..', 'dev-backups', 'daily_ping', 'src', 'a.js'), 'utf8'), 'old');
  assert.equal(readResult(dir, 'daily_ping').status, 'merged');
});

test('合并门禁：未测试拒绝、verify 失败回滚、副本缺失拒绝', () => {
  const { dir, repo, worktree } = sandbox();
  fs.writeFileSync(path.join(repo, 'src', 'a.js'), 'old');
  fs.writeFileSync(path.join(worktree, 'src', 'a.js'), 'new');
  fs.writeFileSync(path.join(worktree, 'src', 'b.js'), 'brand-new');
  createProposal({ dir, id: 'daily_ping', feature });
  const backupRoot = path.join(dir, '..', 'dev-backups');
  writeResult(dir, 'daily_ping', { status: 'proposed', worktree, changed: ['src/a.js'] });
  assert.equal(mergeProposal({ dir, id: 'daily_ping', root: repo, backupRoot, verify: () => ({ ok: true }) }).ok, false);

  writeResult(dir, 'daily_ping', { status: 'tested', worktree, changed: ['src/a.js', 'src/b.js'] });
  const failed = mergeProposal({ dir, id: 'daily_ping', root: repo, backupRoot, verify: () => ({ ok: false, output: 'boom' }) });
  assert.equal(failed.ok, false);
  assert.equal(failed.rolledBack, true);
  assert.equal(fs.readFileSync(path.join(repo, 'src', 'a.js'), 'utf8'), 'old');
  assert.equal(fs.existsSync(path.join(repo, 'src', 'b.js')), false);
  assert.equal(readResult(dir, 'daily_ping').status, 'tested');
  assert.match(readResult(dir, 'daily_ping').lastMergeError, /boom/);

  writeResult(dir, 'daily_ping', { status: 'tested', worktree: path.join(dir, 'missing'), changed: ['src/a.js'] });
  assert.equal(mergeProposal({ dir, id: 'daily_ping', root: repo, backupRoot, verify: () => ({ ok: true }) }).ok, false);
});

test('丢弃提案：清理副本并标记 rejected', () => {
  const { dir, worktree } = sandbox();
  createProposal({ dir, id: 'daily_ping', feature });
  writeResult(dir, 'daily_ping', { status: 'tested', worktree, changed: ['src/a.js'] });
  fs.writeFileSync(path.join(dir, 'daily_ping.patch'), 'diff');
  const rejected = rejectProposal({ dir, id: 'daily_ping' });
  assert.equal(rejected.ok, true);
  assert.equal(fs.existsSync(worktree), false);
  assert.equal(fs.existsSync(path.join(dir, 'daily_ping.patch')), false);
  assert.equal(readResult(dir, 'daily_ping').status, 'rejected');
});

test('交给 Qoder 的任务文本包含回传路径约定与边界', () => {
  const prompt = buildQoderTaskPrompt({ id: 'daily_ping', feature, root: 'C:/repo/qq-bridge', worktreeDir: 'D:/wt' });
  assert.match(prompt, /dev-proposals[\\/]daily_ping\.result\.json/);
  assert.match(prompt, /D:[\\/]wt[\\/]daily_ping/);
  assert.match(prompt, /不要合并/);
  assert.match(prompt, /不要向 QQ/);
  assert.match(prompt, /npm run verify/);
});
