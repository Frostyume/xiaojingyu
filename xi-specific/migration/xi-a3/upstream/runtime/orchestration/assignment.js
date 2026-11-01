// 事件唤醒的「计划 + 指派」产物：提案入队时同步落盘，不依赖任何 CLI/模型额度。
// 纯文件操作；不发送消息、不执行代码、不改其他状态。

import fs from 'node:fs';
import { atomicWriteJson } from '../kernel/state-file.js';
import path from 'node:path';

export const STEP_LIMIT = 8;
export const STEP_TEXT_LIMIT = 120;
export const EXECUTOR = 'qoder-desktop';

const ACCEPTANCE = [
  '在隔离副本内完成，主工作区保持无改动',
  'npm run verify 全绿',
  '回传 state/dev-proposals/<id>.result.json（status/worktree/changed/diffStat）'
];

const BOUNDARIES = [
  '不合并、不提交、不 push',
  '不部署，部署需主人确认',
  '不向 QQ 或群发送任何消息',
  '不改人格资产、不动工作区外的个人目录'
];

/** 提案没给步骤时的标准骨架：与 buildQoderTaskPrompt 的执行步骤一致。 */
export function skeletonSteps(id) {
  return [
    '在隔离副本内定位相关代码路径，记录文件与函数',
    '实现改动，保持最小 diff',
    '在隔离副本执行 npm run verify，必须全绿',
    `生成 diff 与统计，回传 state/dev-proposals/${id}.result.json`
  ];
}

function cleanStep(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .replace(/^\s*(?:\d+[.、)]|[-*•])\s*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, STEP_TEXT_LIMIT);
}

/**
 * 步骤归一：接受数组或换行/分号分隔的字符串；超限截断到 8 步。
 * 返回 { steps, source }，source 用于区分提案自带计划与标准骨架。
 */
export function normalizeSteps(raw, { id = '' } = {}) {
  const list = Array.isArray(raw)
    ? raw
    : String(raw ?? '').split(/\r?\n|；|;/);
  const steps = list.map(cleanStep).filter(Boolean).slice(0, STEP_LIMIT);
  if (steps.length) return { steps, source: 'proposal' };
  return { steps: skeletonSteps(id), source: 'skeleton' };
}

export function plansDir(orchestratorDir) {
  return path.join(orchestratorDir, 'plans');
}

export function assignmentFile(orchestratorDir, id) {
  return path.join(plansDir(orchestratorDir), `${id}.json`);
}

export function planMdFile(orchestratorDir, id) {
  return path.join(plansDir(orchestratorDir), `${id}.md`);
}

export function buildAssignment({ id, task, feature, steps, source, acceptance = '', executor = EXECUTOR, status = 'assigned', dispatcher = '', now = Date.now() }) {
  const title = String(feature?.label || task?.title || id);
  const requirement = String(feature?.action?.text || '').slice(0, 2000);
  return {
    version: 1,
    id,
    taskId: id,
    proposalId: id,
    kind: 'code',
    title,
    executor,
    dispatcher,
    status,
    planSource: source === 'proposal' ? 'proposal' : 'skeleton',
    steps: Array.isArray(steps) ? steps.slice(0, STEP_LIMIT) : [],
    acceptance: String(acceptance || '').slice(0, 300) || ACCEPTANCE.join('；'),
    boundaries: BOUNDARIES,
    requirement,
    proposalPath: path.join('state', 'dev-proposals', `${id}.json`),
    taskPath: path.join('state', 'orchestrator', 'tasks', `${id}.json`),
    resultPath: String(task?.resultPath || path.join('state', 'dev-proposals', `${id}.result.json`)),
    createdAt: Number(now) || Date.now()
  };
}

export function renderAssignmentMarkdown(assignment) {
  const steps = assignment.steps.length
    ? assignment.steps.map((step, index) => `${index + 1}. ${step}`)
    : ['1. （未提供）'];
  return [
    `# ${assignment.title} · ${assignment.id}`,
    '',
    `- 执行器：${assignment.executor === EXECUTOR ? 'Qoder Desktop（隔离副本）' : assignment.executor}`,
    `- 状态：${assignment.status}`,
    ...(assignment.dispatcher === 'coordinator' ? ['- 派单：主控复核后决定是否开工（默认不开执行会话）'] : []),
    `- 计划来源：${assignment.planSource === 'proposal' ? '提案自带步骤' : '标准骨架'}`,
    `- 创建：${new Date(assignment.createdAt).toISOString()}`,
    `- 提案：${assignment.proposalPath}`,
    `- 任务：${assignment.taskPath}`,
    '',
    '## 需求',
    '',
    assignment.requirement || '（见提案）',
    '',
    '## 步骤',
    '',
    ...steps,
    '',
    '## 验收',
    '',
    ...assignment.acceptance.split('；').filter(Boolean).map((item) => `- ${item}`),
    '',
    '## 边界',
    '',
    ...assignment.boundaries.map((item) => `- ${item}`),
    ''
  ].join('\n');
}

/** 幂等写入：同一提案重复提交只覆盖同一份计划。 */
export function writeAssignment(orchestratorDir, assignment) {
  const dir = plansDir(orchestratorDir);
  fs.mkdirSync(dir, { recursive: true });
  const jsonPath = assignmentFile(orchestratorDir, assignment.id);
  const mdPath = planMdFile(orchestratorDir, assignment.id);
  atomicWriteJson(jsonPath, assignment);
  fs.writeFileSync(mdPath, renderAssignmentMarkdown(assignment));
  return { jsonPath, mdPath };
}

export function readAssignment(orchestratorDir, id) {
  try {
    const raw = JSON.parse(fs.readFileSync(assignmentFile(orchestratorDir, id), 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}
