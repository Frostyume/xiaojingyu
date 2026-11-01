// 自然语言代码提案：主人私聊说“修一下/改一下/不好用”时，把缺陷转成提案并排入主控待办。
// 只做校验、落盘与入队；唤醒与回执由调用方注入，方便单测不触达真实 state 与 CLI。

import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import { createProposal, readProposal, buildQoderTaskPrompt } from './dev-proposals.js';
import { enqueueTask, readTask, updateTask } from './orchestrator-queue.js';
import { requestWake } from './orchestrator-wake.js';
import { normalizeSteps, buildAssignment, writeAssignment } from './assignment.js';

export const FIELD_LIMITS = Object.freeze({ title: 60, symptom: 800, expected: 800, evidence: 1200, scope: 300 });
const REQUIRED_FIELDS = ['title', 'symptom', 'expected'];

function cleanText(value) {
  return String(value ?? '')
    .replace(/\r\n/g, '\n')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
    .trim();
}

export function normalizeCodeProposalInput(raw = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['入参必须是对象'], value: null };
  }
  const errors = [];
  const value = {};
  for (const [field, max] of Object.entries(FIELD_LIMITS)) {
    const input = raw[field];
    if (input === undefined || input === null) { value[field] = ''; continue; }
    if (typeof input !== 'string') { errors.push(`${field} 必须是字符串`); value[field] = ''; continue; }
    const text = cleanText(input);
    if (text.length > max) errors.push(`${field} 超长（最多 ${max} 字）`);
    value[field] = text;
  }
  for (const field of REQUIRED_FIELDS) {
    if (!value[field]) errors.push(`${field} 不能为空`);
  }
  if (raw.acceptance !== undefined && typeof raw.acceptance !== 'string') {
    errors.push('acceptance 必须是字符串');
  }
  if (raw.steps !== undefined && typeof raw.steps !== 'string' && !Array.isArray(raw.steps)) {
    errors.push('steps 必须是字符串或字符串数组');
  }
  // 骨架步骤依赖提案 id，留到 stageCodeProposal 再展开；这里只处理主人/角色给出的步骤。
  const planned = raw.steps === undefined ? { steps: [], source: 'skeleton' } : normalizeSteps(raw.steps);
  value.steps = planned.steps;
  value.stepSource = planned.source;
  value.acceptance = cleanText(raw.acceptance).slice(0, 300);
  return { ok: errors.length === 0, errors, value };
}

export function codeProposalHash(value = {}) {
  const steps = Array.isArray(value.steps) ? value.steps.join('\n') : String(value.steps || '');
  const digest = crypto.createHash('sha1')
    .update([value.title, value.symptom, value.expected, value.evidence, value.scope, steps, value.acceptance]
      .map((v) => String(v || ''))
      .join('\n'))
    .digest('hex');
  return digest;
}

export function codeProposalId({ value, now = Date.now() }) {
  const d = new Date(now);
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `code_${stamp}_${codeProposalHash(value).slice(0, 8)}`;
}

export function codeProposalRequirement(value) {
  return [
    `缺陷：${value.symptom}`,
    `期望：${value.expected}`,
    value.evidence ? `复现/证据：${value.evidence}` : '',
    value.scope ? `范围：${value.scope}` : ''
  ].filter(Boolean).join('\n');
}

export function buildCodeProposalFeature({ id, value, now = Date.now() }) {
  return {
    id,
    label: value.title,
    type: 'code_feature',
    capability: 'code_feature',
    enabled: true,
    targets: ['self'],
    trigger: { type: 'keyword', times: [], days: [], at: '', keywords: [], match: 'contains' },
    action: { type: 'code_feature', text: codeProposalRequirement(value), image: '', mood: '' },
    symptom: value.symptom,
    expected: value.expected,
    evidence: value.evidence,
    scope: value.scope,
    steps: Array.isArray(value.steps) ? value.steps : [],
    stepSource: value.stepSource || 'skeleton',
    acceptance: value.acceptance || '',
    contentHash: codeProposalHash(value),
    source: 'owner-private',
    createdAt: now
  };
}

/**
 * 提案落盘 + 任务入队 + 唤醒。调用方注入 wake，默认只写 wake 文件。
 * 返回 { ok, id, task } 或 { ok:false, error }。
 */
export function stageCodeProposal({
  id,
  feature,
  dir,
  orchestratorDir,
  root = process.cwd(),
  source = 'owner-private',
  reason = 'propose_code',
  wake = null
}) {
  const created = createProposal({ dir, id, feature });
  if (!created.ok) return { ok: false, error: created.error };
  const worktreeDir = process.env.DEV_WORKTREE_DIR || path.join(os.homedir(), 'dsh-dev-worktrees');
  const qoderPrompt = buildQoderTaskPrompt({ id, feature, root, worktreeDir });
  const queued = enqueueTask(orchestratorDir, {
    id,
    title: feature.label,
    kind: 'code',
    feature,
    proposalPath: path.join('state', 'dev-proposals', `${id}.json`),
    qoderPrompt,
    resultPath: path.join('state', 'dev-proposals', `${id}.result.json`),
    source
  });
  if (!queued.ok) return { ok: false, error: queued.error || '任务入队失败' };
  // 计划与指派都在这一步落盘：事件一到就有可执行计划，不依赖 CLI 唤醒是否成功。
  const planned = normalizeSteps(feature.steps, { id });
  const assignment = buildAssignment({
    id,
    task: queued.task,
    feature,
    steps: planned.steps,
    source: planned.source,
    acceptance: feature.acceptance,
    status: 'pending_review',
    dispatcher: 'coordinator'
  });
  const paths = writeAssignment(orchestratorDir, assignment);
  // 提案先到主控：这里只落计划并等待复核，不把任务标成已指派，
  // 桌面插件收到 target=coordinator 也不会自动开执行会话。
  const assigned = updateTask(orchestratorDir, id, { status: 'pending_review', assignedTo: 'coordinator' }, {
    by: 'bridge',
    note: '计划已生成，等待主控复核与派单（提案先到主控）'
  });
  const notify = typeof wake === 'function'
    ? wake
    : ({ taskId }) => requestWake(orchestratorDir, { taskId, reason, target: 'coordinator' });
  try {
    notify({ id, taskId: id, reason, target: 'coordinator' });
  } catch {
    // 唤醒失败不影响计划与任务入队；事件已落盘，下次唤醒或交接会读到。
  }
  return { ok: true, id, task: assigned.ok ? assigned.task : queued.task, plan: { ...assignment, paths } };
}

/**
 * 自然语言提案入口：校验（含仅主人私聊）→ 生成稳定 id → 幂等落盘入队 → 唤醒。
 */
export function queueCodeProposal({
  dir,
  orchestratorDir,
  input = {},
  now = Date.now(),
  root = process.cwd(),
  ownerKey = '',
  key = '',
  wake = null
}) {
  if (!ownerKey || String(key || '').trim() !== ownerKey) {
    return { ok: false, code: 403, error: '代码提案只允许主人私聊' };
  }
  const checked = normalizeCodeProposalInput(input);
  if (!checked.ok) return { ok: false, code: 400, error: checked.errors[0], errors: checked.errors };
  const value = checked.value;
  const id = codeProposalId({ value, now });
  const existing = readProposal(dir, id);
  const existingTask = readTask(orchestratorDir, id);
  if (existing?.feature?.contentHash === codeProposalHash(value) && existingTask) {
    return { ok: true, id, existed: true, feature: existing.feature, task: existingTask };
  }
  const feature = existing?.feature?.contentHash === codeProposalHash(value)
    ? existing.feature
    : buildCodeProposalFeature({ id, value, now });
  if (!existingTask) {
    const staged = stageCodeProposal({ id, feature, dir, orchestratorDir, root, source: 'owner-private', reason: 'propose_code', wake });
    if (!staged.ok) return { ok: false, code: 500, error: staged.error };
    return { ok: true, id, existed: false, feature, task: staged.task, plan: staged.plan };
  }
  return { ok: true, id, existed: true, feature, task: existingTask };
}
