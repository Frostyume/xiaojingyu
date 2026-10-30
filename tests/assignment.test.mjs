import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeSteps,
  skeletonSteps,
  buildAssignment,
  renderAssignmentMarkdown,
  writeAssignment,
  readAssignment,
  planMdFile,
  STEP_LIMIT
} from '../runtime/orchestration/assignment.js';

function sandbox() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'assignment-'));
  return { base, orchestratorDir: path.join(base, 'state', 'orchestrator') };
}

const feature = {
  label: '语音结尾截断',
  action: { text: '缺陷：结尾少一两个字\n期望：整句完整播放' },
  steps: ['定位语音流水线', '修掉尾部截断', '跑 verify'],
  acceptance: 'verify 全绿；结尾完整'
};

test('步骤归一：数组、字符串、上限与骨架兜底', () => {
  const fromArray = normalizeSteps([' 1. 定位  ', '', '实现']);
  assert.deepEqual(fromArray.steps, ['定位', '实现']);
  assert.equal(fromArray.source, 'proposal');

  const fromText = normalizeSteps('定位问题\n修复\n验证');
  assert.deepEqual(fromText.steps, ['定位问题', '修复', '验证']);

  const many = normalizeSteps(Array.from({ length: 20 }, (_, i) => `步骤${i}`));
  assert.equal(many.steps.length, STEP_LIMIT);

  const long = normalizeSteps(['x'.repeat(400)]);
  assert.equal(long.steps[0].length, 120);

  const empty = normalizeSteps(undefined, { id: 'code_20261029_abcdef12' });
  assert.equal(empty.source, 'skeleton');
  assert.deepEqual(empty.steps, skeletonSteps('code_20261029_abcdef12'));
  assert.match(empty.steps.at(-1), /code_20261029_abcdef12\.result\.json/);
});

test('计划落盘：JSON + Markdown，幂等覆盖', () => {
  const box = sandbox();
  const assignment = buildAssignment({
    id: 'code_20261029_abcdef12',
    task: { resultPath: 'state/dev-proposals/code_20261029_abcdef12.result.json' },
    feature,
    steps: feature.steps,
    source: 'proposal',
    acceptance: feature.acceptance,
    now: 1793272338410
  });
  const paths = writeAssignment(box.orchestratorDir, assignment);
  assert.ok(fs.existsSync(paths.jsonPath));
  assert.ok(fs.existsSync(paths.mdPath));

  const stored = readAssignment(box.orchestratorDir, assignment.id);
  assert.equal(stored.executor, 'qoder-desktop');
  assert.equal(stored.planSource, 'proposal');
  assert.deepEqual(stored.steps, feature.steps);
  assert.equal(stored.boundaries.length, 4);

  const md = fs.readFileSync(paths.mdPath, 'utf8');
  assert.match(md, /## 需求/);
  assert.match(md, /1\. 定位语音流水线/);
  assert.match(md, /## 验收/);
  assert.match(md, /不合并、不提交、不 push/);
  assert.match(md, /不部署/);

  writeAssignment(box.orchestratorDir, { ...assignment, steps: ['只剩一步'] });
  assert.deepEqual(readAssignment(box.orchestratorDir, assignment.id).steps, ['只剩一步']);
  assert.equal(fs.readdirSync(path.dirname(paths.jsonPath)).filter((f) => f.endsWith('.json')).length, 1);
});

test('计划里不出现敏感信息', () => {
  const box = sandbox();
  const assignment = buildAssignment({
    id: 'code_20261029_abcdef12',
    task: {},
    feature,
    steps: feature.steps,
    source: 'proposal'
  });
  const paths = writeAssignment(box.orchestratorDir, assignment);
  const text = `${fs.readFileSync(paths.jsonPath, 'utf8')}${fs.readFileSync(paths.mdPath, 'utf8')}`;
  for (const key of ['ownerQQ', 'allowGroups', 'authToken', 'token', 'secret']) {
    assert.equal(text.includes(key), false, `不应包含 ${key}`);
  }
  const md = fs.readFileSync(paths.mdPath, 'utf8');
  assert.equal(/\d{9,}/.test(md), false, '不应出现疑似 QQ 号的长数字');
  assert.equal(planMdFile(box.orchestratorDir, assignment.id), paths.mdPath);
});
