// 代码提案通道：提案/结果文件约定、隔离副本合并（备份、verify 门禁、失败回滚）。
// 纯文件操作，verify 与发送消息由调用方注入，方便单测。

import fs from 'node:fs';
import { atomicWriteJson } from '../kernel/state-file.js';
import path from 'node:path';

export const PROPOSAL_ID_RE = /^[a-z][a-z0-9_-]{1,40}$/;

export const RESULT_STATUSES = ['proposed', 'implementing', 'tested', 'failed', 'merged', 'rejected'];

export function validProposalId(id) {
  return PROPOSAL_ID_RE.test(String(id || ''));
}

export function proposalFile(dir, id) {
  return path.join(dir, `${id}.json`);
}

export function resultFile(dir, id) {
  return path.join(dir, `${id}.result.json`);
}

export function patchFile(dir, id) {
  return path.join(dir, `${id}.patch`);
}

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

function writeJson(file, value) {
  return atomicWriteJson(file, value);
}

export function createProposal({ dir, id, feature, now = Date.now() }) {
  if (!validProposalId(id)) return { ok: false, error: '提案 id 必须是 2–41 位小写字母/数字/下划线/连字符，且以字母开头' };
  const proposal = { id, feature, createdAt: now };
  writeJson(proposalFile(dir, id), proposal);
  return { ok: true, proposal };
}

export function readProposal(dir, id) {
  return readJson(proposalFile(dir, id));
}

export function readResult(dir, id) {
  return readJson(resultFile(dir, id));
}

export function writeResult(dir, id, result) {
  writeJson(resultFile(dir, id), { ...result, id });
}

export function listProposals(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((file) => file.endsWith('.json') && !file.endsWith('.result.json'))
    .map((file) => {
      const id = file.replace(/\.json$/, '');
      return { id, proposal: readProposal(dir, id), result: readResult(dir, id) };
    })
    .filter((item) => item.proposal || item.result);
}

export function proposalSummary({ id, proposal, result }) {
  return {
    id,
    label: String(proposal?.feature?.label || ''),
    status: String(result?.status || 'proposed'),
    summary: String(result?.diffStat || '').slice(0, 300),
    changed: Array.isArray(result?.changed) ? result.changed : [],
    worktree: String(result?.worktree || ''),
    error: String(result?.error || ''),
    notified: result?.notified === true
  };
}

/**
 * 归一化 Qoder 会话回传的结果；只接受 tested/failed，改动必须是仓库相对路径。
 * 返回 { ok, result } 或 { ok:false, error }。
 */
export function normalizeProposalResult(raw) {
  const value = raw && typeof raw === 'object' ? raw : {};
  const status = String(value.status || '').trim();
  if (!['tested', 'failed'].includes(status)) return { ok: false, error: `status 必须是 tested/failed（收到 ${status || '空'}）` };
  const worktree = String(value.worktree || '').trim();
  if (!worktree) return { ok: false, error: '缺少 worktree（隔离副本路径）' };
  const changed = [];
  for (const rel of Array.isArray(value.changed) ? value.changed : []) {
    const safe = safeRelTarget(rel);
    if (!safe) return { ok: false, error: `改动路径不安全：${String(rel)}` };
    if (!changed.includes(safe)) changed.push(safe);
  }
  if (status === 'tested' && !changed.length) return { ok: false, error: 'tested 结果必须列出至少一个改动文件' };
  return {
    ok: true,
    result: {
      status,
      worktree,
      changed,
      diffStat: String(value.diffStat || '').slice(0, 4000),
      logPath: String(value.logPath || '').slice(0, 400),
      error: String(value.error || '').slice(0, 1000),
      finishedAt: Number(value.finishedAt) || Date.now()
    }
  };
}

/** 仓库内相对路径；拒绝绝对路径、盘符、..、空串。 */
export function safeRelTarget(rel) {
  const raw = String(rel ?? '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (raw.startsWith('/')) return '';
  if (/^[a-zA-Z]:/.test(raw)) return '';
  const parts = raw.split('/').filter((part) => part && part !== '.');
  if (!parts.length || parts.includes('..')) return '';
  return parts.join('/');
}

export function notificationFor(result) {
  if (!result || result.notified === true) return null;
  if (result.status === 'tested') {
    return `【代码提案完成】${result.id}
测试通过，改动 ${result.changed?.length || 0} 个文件。
${String(result.diffStat || '').slice(0, 500)}
回「合并 ${result.id}」我会二次确认后合并；回「丢弃 ${result.id}」放弃。`;
  }
  if (result.status === 'failed') {
    return `【代码提案失败】${result.id}
${String(result.logPath || result.error || '').slice(0, 120)}
可让我查看日志后重试，或丢弃提案。`;
  }
  return null;
}

/**
 * 合并：逐文件备份 → 复制 → 跑 verify → 失败回滚。
 * verify: () => ({ ok:boolean, output:string })
 */
export function mergeProposal({ dir, id, root, backupRoot, verify }) {
  if (!validProposalId(id)) return { ok: false, error: '提案 id 非法' };
  const result = readResult(dir, id);
  if (!result) return { ok: false, error: '提案结果不存在' };
  if (result.status !== 'tested') return { ok: false, error: `提案尚未通过测试（当前 ${result.status || '未知'}）` };
  const checked = normalizeProposalResult(result);
  if (!checked.ok) return { ok: false, error: checked.error };
  if (!result.worktree || !fs.existsSync(result.worktree)) return { ok: false, error: '隔离副本已被清理，无法合并' };
  const backupDir = path.join(backupRoot, id);
  const applied = [];
  for (const rel of checked.result.changed) {
    const src = path.join(result.worktree, rel);
    const dst = path.join(root, rel);
    if (!fs.existsSync(src)) return { ok: false, error: `隔离副本缺少文件：${rel}` };
    const backup = path.join(backupDir, rel);
    const existed = fs.existsSync(dst);
    fs.mkdirSync(path.dirname(backup), { recursive: true });
    if (existed) fs.copyFileSync(dst, backup);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
    applied.push({ rel, existed });
  }
  let verifyResult = { ok: false, output: '' };
  try {
    verifyResult = verify ? verify() : { ok: false, output: 'no-verify-runner' };
  } catch (error) {
    verifyResult = { ok: false, output: error?.message ?? String(error) };
  }
  if (!verifyResult?.ok) {
    // 回滚本身也可能失败（文件被占用/权限变化）。逐项记下来，别把失败报成“已回滚”。
    const rollbackErrors = [];
    for (const item of applied) {
      const dst = path.join(root, item.rel);
      const backup = path.join(backupDir, item.rel);
      try {
        if (item.existed) fs.copyFileSync(backup, dst);
        else fs.rmSync(dst, { force: true });
      } catch (error) {
        rollbackErrors.push(`${item.rel}: ${error?.message ?? error}`);
      }
    }
    writeResult(dir, id, {
      ...result,
      lastMergeError: String(verifyResult?.output || '').slice(-1200),
      lastMergeRollbackErrors: rollbackErrors.slice(0, 20),
      lastMergeAt: Date.now()
    });
    return {
      ok: false,
      error: rollbackErrors.length
        ? `合并后 verify 失败，回滚未完成（${rollbackErrors.length} 个文件）`
        : '合并后 verify 失败，已回滚',
      rolledBack: rollbackErrors.length === 0,
      rollbackErrors: rollbackErrors.slice(0, 10),
      output: String(verifyResult?.output || '').slice(-1200)
    };
  }
  writeResult(dir, id, { ...result, status: 'merged', mergedAt: Date.now() });
  return { ok: true, changed: applied.map((item) => item.rel), backedUp: true };
}

export function rejectProposal({ dir, id, worktree }) {
  const result = readResult(dir, id);
  const target = String(worktree || result?.worktree || '').trim();
  if (target) {
    try { fs.rmSync(target, { recursive: true, force: true }); } catch {}
  }
  try { fs.rmSync(patchFile(dir, id), { force: true }); } catch {}
  if (result) writeResult(dir, id, { ...result, status: 'rejected', rejectedAt: Date.now() });
  return { ok: true, id, worktree: target };
}

/**
 * 交给 Qoder 会话的自包含任务文本（含回传路径约定）。
 * 只描述任务和边界，不包含 token、QQ 号或真实群号。
 */
export function buildQoderTaskPrompt({ id, feature, root, worktreeDir }) {
  const label = String(feature?.label || id);
  const requirement = String(feature?.action?.text || feature?.description || '').slice(0, 2000);
  const resultPath = path.join(root, 'state', 'dev-proposals', `${id}.result.json`);
  const worktree = worktreeDir ? path.join(worktreeDir, id) : '';
  return [
    `在隔离副本中实现一个代码类功能；不要修改主工作区。`,
    `提案 id：${id}`,
    `功能：${label}`,
    `需求：${requirement}`,
    worktree ? `隔离副本：${worktree}（从主工作区复制，排除 node_modules/state/audio/秘密配置；可用 junction 复用 node_modules）` : '',
    `工作步骤：`,
    `1. 在隔离副本内实现改动；`,
    `2. 在隔离副本执行 npm run verify，必须全绿；`,
    `3. 生成 diff（git diff 或文件对比），统计改动文件与增删行数；`,
    `4. 把结果写入主工作区文件：${resultPath}`,
    `   字段：{ "status": "tested" | "failed", "worktree": "<隔离副本绝对路径>", "changed": ["仓库相对路径"], "diffStat": "...", "logPath": "...", "error": "" }`,
    `5. 不要合并、不要提交、不要 push；不要向 QQ 或群发送任何消息。`,
    `回传后由桥接私聊主人，等主人确认才会合并。`
  ].filter(Boolean).join('\n');
}
