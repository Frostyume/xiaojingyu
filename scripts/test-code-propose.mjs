import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeCodeProposalInput,
  codeProposalId,
  queueCodeProposal
} from '../src/core/code-proposal.js';
import { listOwnerCapabilities } from '../src/core/owner-capabilities.js';

const OWNER_KEY = 'private:10001';

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'code-proposal-test-'));
  const dir = path.join(base, 'state', 'dev-proposals');
  const orchestratorDir = path.join(base, 'state', 'orchestrator');
  fs.mkdirSync(dir, { recursive: true });
  fs.mkdirSync(orchestratorDir, { recursive: true });
  return { base, dir, orchestratorDir };
}

const input = {
  title: '语音结尾截断',
  symptom: '语音最后半句被吞掉，结尾总是少一两个字',
  expected: '整句完整播放，结尾不被截断',
  evidence: '连续三条语音都在最后两个字处停住',
  scope: 'voice'
};

function queue(sandboxDir, overrides = {}) {
  const calls = [];
  const result = queueCodeProposal({
    dir: sandboxDir.dir,
    orchestratorDir: sandboxDir.orchestratorDir,
    root: sandboxDir.base,
    ownerKey: OWNER_KEY,
    key: OWNER_KEY,
    input,
    wake: (payload) => { calls.push(payload); },
    ...overrides
  });
  return { result, calls };
}

test('仅主人私聊可以提交', () => {
  const box = sandbox();
  const denied = queueCodeProposal({
    dir: box.dir,
    orchestratorDir: box.orchestratorDir,
    ownerKey: OWNER_KEY,
    key: 'private:20002',
    input
  });
  assert.equal(denied.ok, false);
  assert.equal(denied.code, 403);
  assert.equal(fs.readdirSync(box.dir).length, 0);
  assert.equal(fs.readdirSync(box.orchestratorDir).length, 0);

  const noOwner = queueCodeProposal({ dir: box.dir, orchestratorDir: box.orchestratorDir, ownerKey: '', key: OWNER_KEY, input });
  assert.equal(noOwner.ok, false);
  assert.equal(noOwner.code, 403);
});

test('空字段与超长字段被拒绝', () => {
  const empty = normalizeCodeProposalInput({ title: '  ', symptom: '', expected: '' });
  assert.equal(empty.ok, false);
  assert.ok(empty.errors.some((e) => e.includes('title')));
  assert.ok(empty.errors.some((e) => e.includes('symptom')));
  assert.ok(empty.errors.some((e) => e.includes('expected')));

  const overlong = normalizeCodeProposalInput({ ...input, symptom: 'a'.repeat(801), evidence: 'b'.repeat(1201) });
  assert.equal(overlong.ok, false);
  assert.ok(overlong.errors.some((e) => e.includes('symptom')));
  assert.ok(overlong.errors.some((e) => e.includes('evidence')));

  const wrongType = normalizeCodeProposalInput({ ...input, title: 123 });
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.errors.some((e) => e.includes('title')));

  const box = sandbox();
  const rejected = queue(box, { input: { ...input, expected: '' } });
  assert.equal(rejected.result.ok, false);
  assert.equal(rejected.result.code, 400);
  assert.equal(rejected.calls.length, 0);
  assert.equal(fs.readdirSync(box.dir).length, 0);
});

test('落盘提案与主控任务，字段正确且唤醒一次', () => {
  const box = sandbox();
  const { result, calls } = queue(box);
  assert.equal(result.ok, true);
  assert.equal(result.existed, false);
  assert.match(result.id, /^[a-z][a-z0-9_]{1,31}$/);

  const proposalFile = path.join(box.dir, `${result.id}.json`);
  const taskFile = path.join(box.orchestratorDir, 'tasks', `${result.id}.json`);
  assert.ok(fs.existsSync(proposalFile));
  assert.ok(fs.existsSync(taskFile));

  const proposal = JSON.parse(fs.readFileSync(proposalFile, 'utf8'));
  assert.equal(proposal.id, result.id);
  assert.equal(proposal.feature.type, 'code_feature');
  assert.equal(proposal.feature.label, input.title);
  assert.equal(proposal.feature.symptom, input.symptom);
  assert.equal(proposal.feature.expected, input.expected);
  assert.equal(proposal.feature.evidence, input.evidence);
  assert.equal(proposal.feature.scope, input.scope);
  assert.equal(proposal.feature.source, 'owner-private');
  assert.ok(proposal.feature.contentHash);
  assert.ok(proposal.createdAt > 0);

  const task = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
  assert.equal(task.id, result.id);
  assert.equal(task.kind, 'code');
  assert.equal(task.source, 'owner-private');
  assert.equal(task.status, 'pending_review');
  assert.equal(task.assignedTo, 'coordinator');
  assert.equal(task.title, input.title);
  assert.equal(task.proposalPath, path.join('state', 'dev-proposals', `${result.id}.json`));
  assert.equal(task.resultPath, path.join('state', 'dev-proposals', `${result.id}.result.json`));
  assert.match(task.qoderPrompt, /缺陷/);
  assert.match(task.qoderPrompt, /期望/);

  const planFile = path.join(box.orchestratorDir, 'plans', `${result.id}.json`);
  assert.ok(fs.existsSync(planFile));
  const plan = JSON.parse(fs.readFileSync(planFile, 'utf8'));
  assert.equal(plan.executor, 'qoder-desktop');
  assert.equal(plan.status, 'pending_review');
  assert.equal(plan.dispatcher, 'coordinator');
  assert.equal(plan.planSource, 'skeleton');
  assert.equal(plan.steps.length, 4);
  assert.ok(fs.existsSync(path.join(box.orchestratorDir, 'plans', `${result.id}.md`)));
  assert.equal(result.plan.steps.length, 4);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].taskId, result.id);
  assert.equal(calls[0].reason, 'propose_code');
  assert.equal(calls[0].target, 'coordinator', '提案先到主控，不能直接派给执行器');
});

test('同一提交重复调用幂等：同一 id、不重复入队与唤醒', () => {
  const box = sandbox();
  const first = queue(box);
  const second = queue(box);

  assert.equal(first.result.ok, true);
  assert.equal(second.result.ok, true);
  assert.equal(second.result.id, first.result.id);
  assert.equal(second.result.existed, true);
  assert.equal(second.calls.length, 0);
  assert.equal(fs.readdirSync(box.dir).filter((f) => f.endsWith('.json')).length, 1);
  assert.equal(fs.readdirSync(path.join(box.orchestratorDir, 'tasks')).length, 1);

  const task = JSON.parse(fs.readFileSync(path.join(box.orchestratorDir, 'tasks', `${first.result.id}.json`), 'utf8'));
  assert.equal(task.history.length, 2);

  const different = queue(box, { input: { ...input, title: '分享格式错' } });
  assert.equal(different.result.ok, true);
  assert.notEqual(different.result.id, first.result.id);
  assert.equal(different.calls.length, 1);
});

test('提案 id 由内容与日期稳定生成', () => {
  const now = new Date(2026, 9, 29, 12, 0, 0).getTime();
  const value = normalizeCodeProposalInput(input).value;
  const a = codeProposalId({ value, now });
  const b = codeProposalId({ value, now: now + 60 * 1000 });
  assert.equal(a, b);
  assert.match(a, /^code_20261029_[a-f0-9]{8}$/);
  assert.notEqual(a, codeProposalId({ value: { ...value, symptom: `${value.symptom} ` }, now }));
});

test('能力清单暴露 code_propose 与工具示例', () => {
  const cap = listOwnerCapabilities().find((item) => item.id === 'code_propose');
  assert.ok(cap);
  assert.equal(cap.kind, 'code');
  assert.ok(cap.tools.includes('qq_code_propose'));
  assert.equal(cap.example.tool, 'qq_code_propose');
  assert.ok(cap.example.args.title);
  assert.ok(cap.example.args.symptom);
  assert.ok(cap.example.args.expected);
});

test('提案自带步骤与验收时，计划按提案展开', () => {
  const box = sandbox();
  const { result } = queue(box, {
    input: { ...input, steps: ['定位 TTS 收尾逻辑', '修改截断阈值', '跑 verify'], acceptance: 'verify 全绿；连续三条语音完整' }
  });
  assert.equal(result.ok, true);
  const plan = JSON.parse(fs.readFileSync(path.join(box.orchestratorDir, 'plans', `${result.id}.json`), 'utf8'));
  assert.equal(plan.planSource, 'proposal');
  assert.deepEqual(plan.steps, ['定位 TTS 收尾逻辑', '修改截断阈值', '跑 verify']);
  assert.match(plan.acceptance, /连续三条语音完整/);

  const wrongType = normalizeCodeProposalInput({ ...input, steps: 42 });
  assert.equal(wrongType.ok, false);
  assert.ok(wrongType.errors.some((e) => e.includes('steps')));
});

test('qq_code_propose 工具面覆盖修复/改进/新功能，并透传 steps/acceptance', () => {
  const source = fs.readFileSync(new URL('../src/mcp-snowluma-safe.js', import.meta.url), 'utf8');
  const start = source.indexOf("'qq_code_propose'");
  assert.ok(start > 0);
  const block = source.slice(start, source.indexOf("'qq_feature_code_status'", start));
  assert.match(block, /新功能/);
  assert.match(block, /steps: z\.array\(z\.string\(\)\)/);
  assert.match(block, /acceptance: z\.string\(\)/);
  // 控制面分层后高危工具多一个可选 confirmCode（主人 /确认 后桥接才给出）。
  assert.match(block, /steps, acceptance, confirmCode \}\)/);
  assert.match(block, /confirmCode: z\.string\(\)\.optional\(\)/);
});

test('上一次只写了提案没入队时，补入队而不是重复建任务', () => {
  const box = sandbox();
  const first = queue(box);
  fs.rmSync(path.join(box.orchestratorDir, 'tasks'), { recursive: true, force: true });
  const retry = queue(box);
  assert.equal(retry.result.ok, true);
  assert.equal(retry.result.id, first.result.id);
  assert.equal(retry.result.existed, false);
  assert.equal(retry.calls.length, 1);
  assert.ok(fs.existsSync(path.join(box.orchestratorDir, 'tasks', `${first.result.id}.json`)));
});
