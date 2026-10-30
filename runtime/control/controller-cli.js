// 事件唤醒：任务入队/结果回传时，用 Qoder CLI fork 一个短回合，补齐计划并核对指派。
// 不常驻、不轮询。计划与指派本身已在入队时落盘（见 assignment.js），
// 所以 CLI 不可用（未登录/额度用尽）只会少一次计划复核，不会丢事件。

import fs from 'node:fs';
import { atomicWriteJson } from '../kernel/state-file.js';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const DEFAULT_COOLDOWN_MS = 60 * 1000;
const RUN_LOG_LIMIT = 256 * 1024;
const STALL_MS = 15 * 60 * 1000;

// 这些结局表示 CLI 侧被挡住（没登录 / 没额度 / SDK 环境不对），再唤醒一次也是白跑。
// quota 的提示是「明天再来」，所以只等次日 00:05 探测一次；login / sdk-env 要人工修，
// 探测窗口放宽到 30 分钟。窗口内一律跳过且**不排延迟重试**——事件本身已经排队。
export const BLOCKED_OUTCOMES = Object.freeze(['login', 'quota', 'sdk-env']);

export const DEFAULT_PROMPT = [
  '你是主控的事件处理回合（由桥接事件唤醒的临时会话，不留痕）。',
  '1. 读 qq-bridge/state/orchestrator/wake.request.json 的 pending 列表和 coordinator-inbox.json 的 items；两者都为空才只回复 NOOP 并结束。',
  '2. 逐个任务读 state/orchestrator/tasks/<id>.json、state/orchestrator/plans/<id>.md、state/dev-proposals/<id>.json。',
  '3. 计划缺项（步骤、验收、边界不完整）或与提案不符时，直接补写 plans/<id>.md，并在任务 history 记一条；计划完整就不要改。',
  '4. 不要写业务代码、不要建隔离副本、不要合并/提交/推送/部署、不要改人格资产、不要向 QQ 或群发任何消息——执行由 Qoder Desktop 会话负责，通知由桥接负责。',
  '5. 结束把一句摘要写入 state/orchestrator/reports/latest.md，并回复摘要。'
].join('\n');

export const EXECUTE_PROMPT = [
  '6. 主人已允许本回合执行：在 DEV_WORKTREE_DIR/<id> 隔离副本内实现计划步骤，执行 npm run verify，把结果写到 state/dev-proposals/<id>.result.json；仍不合并、不提交、不 push、不部署。'
].join('\n');

export function controllerConfigFile(dir) {
  return path.join(dir, 'controller.json');
}

export function readControllerConfig(dir) {
  try {
    const raw = JSON.parse(fs.readFileSync(controllerConfigFile(dir), 'utf8'));
    if (!raw || typeof raw !== 'object') return null;
    if (raw.enabled === false) return null;
    if (!raw.sessionId) return null;
    return {
      enabled: true,
      sessionId: String(raw.sessionId),
      // 只认 controller.json：进程可能继承 QODER_CONFIG_DIR 等 edition 环境变量，
      // 静默跟随它会把唤醒目标切到另一版去。
      configDir: String(raw.configDir || ''),
      cwd: String(raw.cwd || ''),
      permissionMode: ['auto', 'dont_ask', 'bypass_permissions'].includes(raw.permissionMode) ? raw.permissionMode : 'auto',
      cooldownMs: Math.max(0, Number(raw.cooldownMs) || DEFAULT_COOLDOWN_MS),
      cliScript: String(raw.cliScript || defaultCliScript()),
      allowExecute: raw.allowExecute === true
    };
  } catch {
    return null;
  }
}

export function defaultCliScript() {
  if (process.env.QODER_CLI_SCRIPT) return process.env.QODER_CLI_SCRIPT;
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@qoder-ai', 'qodercli', 'bundle', 'qodercli.js');
  }
  return 'qodercli';
}

/** 会话文件按 edition 分目录：<configDir>/projects/<项目 slug>/<sessionId>.jsonl。 */
export function sessionFileFor(configDir, sessionId) {
  if (!configDir || !sessionId) return '';
  const projects = path.join(configDir, 'projects');
  let dirs = [];
  try {
    dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((item) => item.isDirectory());
  } catch {
    return '';
  }
  for (const item of dirs) {
    const candidate = path.join(projects, item.name, `${sessionId}.jsonl`);
    if (fs.existsSync(candidate)) return candidate;
  }
  return '';
}

/**
 * 唤醒前置检查。会话文件缺失（换了 edition 或会话被清理）时不要盲目 spawn——
 * 过去正是这里静默失败，才被误判为“唤醒能跑”。
 */
export function preflightController(config) {
  if (!config) return { ok: false, reason: 'no-controller' };
  if (!config.sessionId) return { ok: false, reason: 'no-session' };
  if (config.configDir && !sessionFileFor(config.configDir, config.sessionId)) {
    return { ok: false, reason: 'session-missing' };
  }
  if (path.isAbsolute(config.cliScript) && !fs.existsSync(config.cliScript)) {
    return { ok: false, reason: 'cli-missing' };
  }
  return { ok: true };
}

export function buildCliArgs(config, prompt = DEFAULT_PROMPT) {
  const args = [config.cliScript, '-p'];
  if (config.configDir) args.push('--config-dir', config.configDir);
  args.push(
    '--resume', config.sessionId,
    '--fork-session',
    '--no-session-persistence',
    '-w', config.cwd || process.cwd(),
    '--permission-mode', config.permissionMode || 'auto',
    prompt
  );
  return args;
}

/**
 * 去掉 Qoder 代理环境的 SDK 入口变量，否则 CLI 会要求 stream-json 参数。
 * edition 只认 controller.json 的 configDir：npm 全局包是国际版构建，
 * 进程若继承 QODER_CONFIG_DIR / QODERCN_CONFIG_DIR，会把唤醒打到另一版去。
 */
export function sanitizedEnv(env = process.env) {
  const out = { ...env };
  delete out.QODER_AGENT_SDK_ENTRYPOINT;
  delete out.QODER_AGENT_SDK_DAEMON;
  delete out.QODER_AGENT_SDK_VERSION;
  delete out.QODER_CONFIG_DIR;
  delete out.QODERCN_CONFIG_DIR;
  return out;
}

/**
 * 从 CLI 输出尾部判断失败原因，避免“唤醒失败但没人知道为什么”。
 * 这些字符串来自 CLI 的固定提示，改版后匹配不到就会落到 error/ok。
 */
export function classifyRunTail(text, exitCode = 0) {
  const tail = String(text || '');
  // 同一个 cli.run.log 会累积多轮输出，旧一轮的“未登录”不能盖住新一轮的“额度用尽”。
  // 取**最后出现**的那条失败特征作为结论。
  const patterns = [
    ['login', /not logged in|请先登录|please run \/login/gi],
    ['quota', /usage limit|额度|今日使用|come back tomorrow/gi],
    ['sdk-env', /sdk_invalid_args|Agent SDK entrypoint/gi]
  ];
  let best = '';
  let bestIndex = -1;
  for (const [kind, pattern] of patterns) {
    let match;
    while ((match = pattern.exec(tail)) !== null) {
      if (match.index >= bestIndex) { bestIndex = match.index; best = kind; }
      if (match.index === pattern.lastIndex) pattern.lastIndex += 1;
    }
  }
  if (best) return best;
  if (exitCode !== 0) return 'error';
  return 'ok';
}

/**
 * 阻塞后的下一次自动探测时间。0 表示不自动探测（必须人工处理）。
 * 一个窗口只放一次探测：探测再失败也只是把窗口推到下一个，不会「不断重试」。
 */
export function blockedRetryAt(outcome, now = Date.now()) {
  const at = Number(now) || Date.now();
  if (outcome === 'quota') {
    const next = new Date(at);
    next.setHours(0, 5, 0, 0);
    next.setDate(next.getDate() + 1);
    return next.getTime();
  }
  if (outcome === 'login' || outcome === 'sdk-env') return at + 30 * 60 * 1000;
  return 0;
}

function stateFile(dir) {
  return path.join(dir, 'cli.state.json');
}

function readState(dir) {
  try { return JSON.parse(fs.readFileSync(stateFile(dir), 'utf8')); } catch { return {}; }
}

function writeState(dir, value) {
  atomicWriteJson(stateFile(dir), value);
}

function appendLog(dir, line) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'cli.log'), `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function runLogFile(dir) {
  return path.join(dir, 'cli.run.log');
}

/** 只保留尾部：fork 会重放上下文，日志很容易涨到很大。 */
function trimRunLog(file) {
  try {
    const stat = fs.statSync(file);
    if (stat.size <= RUN_LOG_LIMIT) return;
    const fd = fs.openSync(file, 'r');
    const start = stat.size - Math.floor(RUN_LOG_LIMIT / 2);
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    fs.writeFileSync(file, buffer);
  } catch {}
}

function tailRunLog(file, limit = 4096) {
  try {
    const stat = fs.statSync(file);
    const start = Math.max(0, stat.size - limit);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 只读**本轮**输出（byteOffset 之后）。cli.run.log 是追加写的，
 * 只看尾部会把上一轮遗留的 quota/login 文案算到这一轮头上——
 * 一次正常结束的唤醒因此被记成 quota，进而被当成阻塞。
 */
function readRunSegment(file, byteOffset, limit = 8192) {
  try {
    const stat = fs.statSync(file);
    if (!stat.size) return '';
    const begin = Math.max(0, Math.min(Number(byteOffset) || 0, stat.size));
    if (begin >= stat.size) return '';
    const start = Math.max(begin, stat.size - limit);
    const fd = fs.openSync(file, 'r');
    const buffer = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buffer, 0, buffer.length, start);
    fs.closeSync(fd);
    return buffer.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 上次运行结果。父进程退出后 exit 监听器就没了（唤醒是 detached 的），
 * 有退出回执/启动对账记录时以状态为准；只有完全没有结论时才回看本轮日志段。
 */
export function readWakeOutcome(dir) {
  const state = readState(dir);
  const file = runLogFile(dir);
  let size = 0;
  try { size = fs.statSync(file).size; } catch {}
  const lastAt = Number(state.lastAt) || 0;
  const outcomeAt = Number(state.lastOutcomeAt) || 0;
  const offset = Number(state.lastRunOffset) || 0;
  // 上次退出之后又发起过唤醒：结论只能看本轮起点后的输出，不能回看上一轮。
  if (lastAt > outcomeAt) {
    const startOffset = Number(state.lastRunOffset);
    if (Number.isFinite(startOffset) && startOffset > 0) {
      const segment = readRunSegment(file, startOffset);
      if (segment.trim()) return { outcome: classifyRunTail(segment, 0), source: 'runlog', running: true };
    }
    // 旧版状态没记本轮起点（或被重启打断）：宁可报「未收尾」，也不拿上一轮的失败文案顶替。
    if (Date.now() - lastAt > STALL_MS) return { outcome: 'stalled', source: 'state' };
    return { outcome: 'running', source: 'state' };
  }
  if (!size) return { outcome: String(state.lastOutcome || ''), source: state.lastOutcome ? 'exit' : '' };
  // 有已记录的结局就以它为准：cli.run.log 可能还在被上一进程的 detached CLI 追加，
  // 整段回看会把历史失败重新翻出来（曾经的 quota 误判）。
  if (state.lastOutcome) return { outcome: String(state.lastOutcome), source: 'exit' };
  return { outcome: classifyRunTail(readRunSegment(file, offset) || tailRunLog(file), Number(state.lastExitCode || 0)), source: 'runlog' };
}

/**
 * 启动对账：上一进程 fork 的 CLI 唤醒，退出回执随旧进程一起消失了。
 * 不清理的话状态会一直停在「running」，最后变成误导性的 stalled 告警。
 */
export function reconcileInterruptedWake(dir, now = Date.now()) {
  const state = readState(dir);
  const lastAt = Number(state.lastAt) || 0;
  if (!lastAt || lastAt <= (Number(state.lastOutcomeAt) || 0)) return null;
  // 同时把本轮起点锁到当前日志末尾：旧进程的 detached CLI 可能还在追加输出，
  // 这些字节属于「已对账为 interrupted」的那一轮，不能再参与结论判定。
  let runEnd = Number(state.lastRunOffset) || 0;
  try { runEnd = fs.statSync(runLogFile(dir)).size; } catch {}
  writeState(dir, {
    ...state,
    lastOutcome: 'interrupted',
    lastOutcomeAt: now,
    interruptedAt: now,
    lastRunOffset: runEnd,
    pendingDeferred: false
  });
  appendLog(dir, `reconcile interrupted reason=${state.lastReason || '-'} at=${lastAt}`);
  return { lastAt, lastReason: String(state.lastReason || '') };
}

/** 唤醒链路的只读快照：控制台 / doctor / 提案状态接口共用。 */
export function wakeStatus(dir) {
  const state = readState(dir);
  const { outcome, source } = readWakeOutcome(dir);
  const blocked = state.blocked && typeof state.blocked === 'object' ? state.blocked : null;
  return {
    outcome,
    source,
    blocked: blocked
      ? {
        outcome: String(blocked.outcome || ''),
        since: Number(blocked.since) || 0,
        at: Number(blocked.at) || 0,
        strikes: Number(blocked.strikes) || 0,
        retryAt: Number(blocked.retryAt) || 0
      }
      : null,
    pendingDeferred: state.pendingDeferred === true,
    deferredAt: Number(state.deferredAt) || 0,
    lastAt: Number(state.lastAt) || 0,
    lastReason: String(state.lastReason || ''),
    lastSkip: String(state.lastSkip || '')
  };
}

const deferred = new Map();

function scheduleDeferred(options, waitMs, timers) {
  const dir = String(options.dir);
  const prev = deferred.get(dir);
  if (prev) {
    try { timers.clearTimeoutImpl(prev.timer); } catch {}
  }
  const timer = timers.setTimeoutImpl(() => {
    deferred.delete(dir);
    // 延迟唤醒带 force 绕过冷却；但它不该绕过阻塞闸门，否则等于自动重试。
    const current = readState(dir);
    const blocked = current.blocked && typeof current.blocked === 'object' ? current.blocked : null;
    if (blocked && BLOCKED_OUTCOMES.includes(String(blocked.outcome || ''))) {
      appendLog(dir, `deferred-skip reason=blocked:${blocked.outcome} task=${options.taskId || '-'}`);
      writeState(dir, { ...current, pendingDeferred: false });
      return;
    }
    try {
      wakeControllerViaCli({
        ...options,
        reason: `${options.reason}:deferred`,
        force: true,
        now: timers.nowFn(),
        timers
      });
    } catch (error) {
      appendLog(dir, `deferred-failed ${error?.message ?? error}`);
    }
  }, Math.max(0, waitMs));
  timer?.unref?.();
  deferred.set(dir, { timer, at: timers.nowFn() + waitMs, reason: options.reason, clear: timers.clearTimeoutImpl });
  return timer;
}

export function clearDeferredWake(dir) {
  const entry = deferred.get(String(dir));
  if (!entry) return false;
  try { entry.clear?.(entry.timer); } catch {}
  deferred.delete(String(dir));
  return true;
}

/**
 * 触发一次 CLI fork。返回 { ok, skipped?, reason?, deferredInMs? }。
 * spawnImpl / timers 可注入用于测试。
 */
export function wakeControllerViaCli({
  dir,
  reason = 'task',
  taskId = '',
  now = Date.now(),
  prompt = '',
  spawnImpl = spawn,
  env = process.env,
  force = false,
  timers = null
} = {}) {
  const clocks = {
    setTimeoutImpl: timers?.setTimeoutImpl || setTimeout,
    clearTimeoutImpl: timers?.clearTimeoutImpl || clearTimeout,
    nowFn: timers?.nowFn || Date.now
  };
  const config = readControllerConfig(dir);
  if (!config) return { ok: false, skipped: true, reason: 'no-controller' };
  const gate = preflightController(config);
  if (!gate.ok) {
    appendLog(dir, `skip reason=${gate.reason} session=${config.sessionId} configDir=${config.configDir || '-'}`);
    writeState(dir, { ...readState(dir), lastSkip: gate.reason, lastSkipAt: now });
    return { ok: false, skipped: true, reason: gate.reason };
  }
  const state = readState(dir);
  // 阻塞闸门：被 login/quota/sdk-env 挡过之后，事件继续排队，但不再自动 fork CLI。
  // 窗口内一个唤醒都不发（也不排 deferred），避免每个提案事件都白跑一轮 3–4 分钟的 CLI。
  const blocked = state.blocked && typeof state.blocked === 'object' ? state.blocked : null;
  if (!force && blocked && BLOCKED_OUTCOMES.includes(String(blocked.outcome || ''))) {
    const retryAt = Number(blocked.retryAt) || 0;
    if (!retryAt || now < retryAt) {
      appendLog(dir, `skip reason=blocked:${blocked.outcome} task=${taskId || '-'} retryAt=${retryAt || 'manual'}`);
      writeState(dir, { ...state, lastSkip: `blocked:${blocked.outcome}`, lastSkipAt: now });
      return {
        ok: false,
        skipped: true,
        reason: `blocked:${blocked.outcome}`,
        retryAt,
        deferredInMs: retryAt ? retryAt - now : 0,
        blocked: { ...blocked }
      };
    }
    appendLog(dir, `probe reason=blocked:${blocked.outcome} task=${taskId || '-'}`);
  }
  const lastAt = Number(state.lastAt) || 0;
  if (!force && lastAt && now - lastAt < config.cooldownMs) {
    const waitMs = Math.max(0, lastAt + config.cooldownMs - now);
    scheduleDeferred({ dir, reason, taskId, prompt, spawnImpl, env }, waitMs, clocks);
    writeState(dir, { ...state, pendingDeferred: true, deferredAt: now + waitMs });
    appendLog(dir, `defer reason=${reason} task=${taskId || '-'} waitMs=${waitMs}`);
    return { ok: false, skipped: true, reason: 'cooldown', deferredInMs: waitMs, lastAt };
  }
  clearDeferredWake(dir);
  const previous = readWakeOutcome(dir);
  const base = prompt || (config.allowExecute ? `${DEFAULT_PROMPT}\n${EXECUTE_PROMPT}` : DEFAULT_PROMPT);
  const text = `${base}\n\n本次唤醒原因：${reason}${taskId ? `（任务 ${taskId}）` : ''}`;
  const args = buildCliArgs(config, text);
  const file = runLogFile(dir);
  trimRunLog(file);
  // 记下本轮输出的起点：退出时只按这一段判结论（见 readRunSegment）。
  let runOffset = 0;
  try { runOffset = fs.statSync(file).size; } catch {}
  writeState(dir, {
    ...state,
    lastAt: now,
    lastReason: reason,
    lastTaskId: taskId,
    lastSessionId: config.sessionId,
    lastConfigDir: config.configDir,
    lastRunOffset: runOffset,
    lastRunAt: now,
    previousOutcome: previous.outcome,
    pendingDeferred: false
  });
  appendLog(dir, `wake reason=${reason} task=${taskId || '-'} session=${config.sessionId} configDir=${config.configDir || '-'} script=${config.cliScript}`);

  let fd = null;
  try { fd = fs.openSync(file, 'a'); } catch {}
  const stdio = fd === null ? 'ignore' : ['ignore', fd, fd];
  try {
    const child = spawnImpl(process.execPath, args, {
      cwd: config.cwd || process.cwd(),
      env: sanitizedEnv(env),
      detached: true,
      stdio,
      windowsHide: true
    });
    child.on?.('error', (error) => {
      appendLog(dir, `spawn-error ${error?.message ?? error}`);
      writeState(dir, { ...readState(dir), lastOutcome: 'spawn-error', lastOutcomeAt: Date.now() });
    });
    child.on?.('exit', (code) => {
      const outcome = classifyRunTail(readRunSegment(file, runOffset), Number(code) || 0);
      const at = Date.now();
      const prev = readState(dir);
      const next = {
        ...prev,
        lastExitCode: code,
        lastOutcome: outcome,
        lastOutcomeAt: at,
        lastRunReason: reason
      };
      if (BLOCKED_OUTCOMES.includes(outcome)) {
        // 已经有延迟唤醒在排队的，一起取消：阻塞期间不再自动重试。
        clearDeferredWake(dir);
        next.pendingDeferred = false;
        next.blocked = {
          outcome,
          since: Number(prev.blocked?.since) || at,
          at,
          strikes: (Number(prev.blocked?.strikes) || 0) + 1,
          retryAt: blockedRetryAt(outcome, at)
        };
      } else if (outcome === 'ok') {
        next.blocked = null;
      } else if (prev.blocked && BLOCKED_OUTCOMES.includes(String(prev.blocked.outcome || ''))) {
        // 探测轮也没跑通：保持阻塞，把窗口推到下一个，避免一个窗口内反复探测。
        next.blocked = {
          ...prev.blocked,
          at,
          strikes: (Number(prev.blocked.strikes) || 0) + 1,
          retryAt: blockedRetryAt(String(prev.blocked.outcome), at)
        };
      }
      appendLog(dir, `exit code=${code} outcome=${outcome} reason=${reason}${next.blocked ? ` blocked=${next.blocked.outcome} retryAt=${next.blocked.retryAt}` : ''}`);
      writeState(dir, next);
    });
    child.unref?.();
    return { ok: true, pid: child.pid || 0, sessionId: config.sessionId, configDir: config.configDir, outcome: 'running' };
  } catch (error) {
    appendLog(dir, `spawn-failed ${error?.message ?? error}`);
    return { ok: false, reason: 'spawn-failed', error: error?.message ?? String(error) };
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch {} }
  }
}
