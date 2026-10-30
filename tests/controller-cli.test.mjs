import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  readControllerConfig,
  buildCliArgs,
  sanitizedEnv,
  wakeControllerViaCli,
  controllerConfigFile,
  preflightController,
  classifyRunTail,
  clearDeferredWake,
  blockedRetryAt,
  wakeStatus,
  reconcileInterruptedWake
} from '../runtime/control/controller-cli.js';

function sandbox(config = {}) {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-cli-'));
  const dir = path.join(base, 'orchestrator');
  fs.mkdirSync(dir, { recursive: true });
  const cliScript = path.join(base, 'cli.js');
  fs.writeFileSync(cliScript, '// fake cli\n');
  fs.writeFileSync(controllerConfigFile(dir), JSON.stringify({
    enabled: true,
    sessionId: 'session-1',
    cwd: base,
    permissionMode: 'auto',
    cooldownMs: 60000,
    cliScript,
    ...config
  }));
  return { base, dir, cliScript };
}

function fakeSpawn(calls) {
  return (command, args, options) => {
    const handlers = {};
    calls.push({ command, args, options, handlers });
    return { pid: 4321, unref() {}, on(event, fn) { handlers[event] = fn; } };
  };
}

function fakeTimers() {
  const scheduled = [];
  return {
    scheduled,
    timers: {
      setTimeoutImpl: (fn, ms) => {
        const entry = { fn, ms, cleared: false, unref() {} };
        scheduled.push(entry);
        return entry;
      },
      clearTimeoutImpl: (entry) => { if (entry) entry.cleared = true; },
      nowFn: () => 30000
    }
  };
}

test('读取配置与缺省值', () => {
  const { dir } = sandbox();
  const config = readControllerConfig(dir);
  assert.equal(config.sessionId, 'session-1');
  assert.equal(config.permissionMode, 'auto');
  assert.equal(config.allowExecute, false);
  fs.writeFileSync(controllerConfigFile(dir), JSON.stringify({ enabled: false, sessionId: 'x' }));
  assert.equal(readControllerConfig(dir), null);
  fs.rmSync(controllerConfigFile(dir));
  assert.equal(readControllerConfig(dir), null);
});

test('CLI 参数与 SDK 环境变量清理', () => {
  const { dir } = sandbox();
  const config = readControllerConfig(dir);
  const args = buildCliArgs(config, 'hello');
  assert.deepEqual(args.slice(0, 8), [config.cliScript, '-p', '--resume', 'session-1', '--fork-session', '--no-session-persistence', '-w', config.cwd]);
  assert.ok(args.includes('--permission-mode'));
  assert.equal(args.at(-1), 'hello');
  const env = sanitizedEnv({
    QODER_AGENT_SDK_ENTRYPOINT: '1',
    QODER_AGENT_SDK_DAEMON: '1',
    QODER_AGENT_SDK_VERSION: '1',
    QODER_CONFIG_DIR: 'C:/Users/x/.qoder-cn',
    QODERCN_CONFIG_DIR: 'C:/Users/x/.qoder-cn',
    PATH: 'x'
  });
  assert.equal(env.QODER_AGENT_SDK_ENTRYPOINT, undefined);
  assert.equal(env.QODER_AGENT_SDK_DAEMON, undefined);
  assert.equal(env.QODER_AGENT_SDK_VERSION, undefined);
  // edition 只能由 controller.json 的 configDir 决定，继承来的会让唤醒跑到另一版
  assert.equal(env.QODER_CONFIG_DIR, undefined);
  assert.equal(env.QODERCN_CONFIG_DIR, undefined);
  assert.equal(env.PATH, 'x');
});

test('指定 configDir 时把 --config-dir 传给 CLI', () => {
  const { dir } = sandbox({ configDir: 'C:/Users/x/.qoder-cn' });
  const config = readControllerConfig(dir);
  const args = buildCliArgs(config, 'hi');
  const index = args.indexOf('--config-dir');
  assert.ok(index > 0);
  assert.equal(args[index + 1], 'C:/Users/x/.qoder-cn');
  assert.ok(args.indexOf('--config-dir') < args.indexOf('--resume'));
});

test('会话文件缺失时跳过而不是盲目 spawn', () => {
  const { dir } = sandbox({ configDir: 'C:/definitely/not/here', sessionId: 'missing-session' });
  const calls = [];
  const result = wakeControllerViaCli({ dir, reason: 'x', now: 1000, spawnImpl: fakeSpawn(calls) });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'session-missing');
  assert.equal(calls.length, 0);
  assert.match(fs.readFileSync(path.join(dir, 'cli.log'), 'utf8'), /skip reason=session-missing/);
  const config = readControllerConfig(dir);
  assert.equal(preflightController(config).reason, 'session-missing');
});

test('触发一次 spawn 并写状态/日志', () => {
  const { dir, base } = sandbox();
  const calls = [];
  const result = wakeControllerViaCli({ dir, reason: 'code_feature', taskId: 't1', now: 1000, spawnImpl: fakeSpawn(calls), env: {} });
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, process.execPath);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio[0], 'ignore');
  assert.match(calls[0].args.at(-1), /code_feature/);
  assert.match(calls[0].args.at(-1), /t1/);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'cli.state.json'), 'utf8'));
  assert.equal(state.lastAt, 1000);
  assert.match(fs.readFileSync(path.join(dir, 'cli.log'), 'utf8'), /wake reason=code_feature/);
  assert.ok(fs.existsSync(path.join(base, 'cli.js')));
});

test('冷却期内改期补唤醒，不丢事件；force 可绕过', () => {
  const { dir } = sandbox();
  const calls = [];
  const { scheduled, timers } = fakeTimers();
  wakeControllerViaCli({ dir, reason: 'a', now: 1000, spawnImpl: fakeSpawn(calls), timers });
  const second = wakeControllerViaCli({ dir, reason: 'b', now: 2000, spawnImpl: fakeSpawn(calls), timers });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'cooldown');
  assert.equal(second.deferredInMs, 59000);
  assert.equal(calls.length, 1);
  assert.equal(scheduled.length, 1);
  assert.equal(scheduled[0].ms, 59000);
  const deferredState = JSON.parse(fs.readFileSync(path.join(dir, 'cli.state.json'), 'utf8'));
  assert.equal(deferredState.pendingDeferred, true);

  scheduled[0].fn();
  assert.equal(calls.length, 2);
  assert.match(calls[1].args.at(-1), /b:deferred/);

  clearDeferredWake(dir);
  const forced = wakeControllerViaCli({ dir, reason: 'c', now: 3000, force: true, spawnImpl: fakeSpawn(calls), timers });
  assert.equal(forced.ok, true);
  assert.equal(calls.length, 3);
});

test('按 CLI 输出识别登录/额度失败', () => {
  assert.equal(classifyRunTail('Not logged in · Please run /login', 1), 'login');
  assert.equal(classifyRunTail("You've reached your daily usage limit", 1), 'quota');
  assert.equal(classifyRunTail('sdk_invalid_args: Agent SDK entrypoint env is set', 1), 'sdk-env');
  assert.equal(classifyRunTail('boom', 2), 'error');
  assert.equal(classifyRunTail('all good', 0), 'ok');
  // 累积日志里旧一轮的“未登录”不能盖住新一轮的结论
  assert.equal(classifyRunTail('Not logged in · Please run /login\nYou have reached the daily usage limit. Please try again later.', 1), 'quota');
  assert.equal(classifyRunTail('You have reached the daily usage limit\nNot logged in · Please run /login', 1), 'login');
});

test('CLI 退出后把失败原因写进状态', () => {
  const { dir } = sandbox();
  const calls = [];
  wakeControllerViaCli({ dir, reason: 'x', now: 1000, spawnImpl: fakeSpawn(calls), env: {} });
  fs.writeFileSync(path.join(dir, 'cli.run.log'), 'Not logged in · Please run /login\n');
  calls[0].handlers.exit(1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'cli.state.json'), 'utf8'));
  assert.equal(state.lastOutcome, 'login');
  assert.equal(state.lastExitCode, 1);
  assert.match(fs.readFileSync(path.join(dir, 'cli.log'), 'utf8'), /outcome=login/);
});

test('没有 controller 配置时安全跳过', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'controller-cli-empty-'));
  const result = wakeControllerViaCli({ dir: base, spawnImpl: () => { throw new Error('should not spawn'); } });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, 'no-controller');
});

test('spawn 抛错时返回失败并记日志', () => {
  const { dir } = sandbox();
  const result = wakeControllerViaCli({ dir, reason: 'x', now: 1000, spawnImpl: () => { throw new Error('boom'); } });
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'spawn-failed');
  assert.match(fs.readFileSync(path.join(dir, 'cli.log'), 'utf8'), /spawn-failed boom/);
});

test('阻塞窗口：quota 等次日 00:05，login/sdk-env 等 30 分钟，其余不自动探测', () => {
  const now = new Date(2026, 9, 30, 10, 15, 0).getTime();
  const quota = blockedRetryAt('quota', now);
  const quotaAt = new Date(quota);
  assert.equal(quotaAt.getDate(), 31);
  assert.equal(quotaAt.getHours(), 0);
  assert.equal(quotaAt.getMinutes(), 5);
  assert.equal(blockedRetryAt('login', now), now + 30 * 60 * 1000);
  assert.equal(blockedRetryAt('sdk-env', now), now + 30 * 60 * 1000);
  assert.equal(blockedRetryAt('error', now), 0);
});

test('阻塞结局落盘后不再唤醒、也不排延迟重试；force 可人工恢复', () => {
  const { dir } = sandbox();
  const calls = [];
  const { scheduled, timers } = fakeTimers();
  wakeControllerViaCli({ dir, reason: 'proposal', now: 1000, spawnImpl: fakeSpawn(calls), timers });
  fs.writeFileSync(path.join(dir, 'cli.run.log'), 'Not logged in · Please run /login\n');
  calls[0].handlers.exit(1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'cli.state.json'), 'utf8'));
  assert.equal(state.blocked.outcome, 'login');
  assert.equal(state.blocked.strikes, 1);
  assert.ok(state.blocked.retryAt > Date.now());

  const second = wakeControllerViaCli({ dir, reason: 'proposal2', now: Date.now() + 1000, spawnImpl: fakeSpawn(calls), timers });
  assert.equal(second.skipped, true);
  assert.equal(second.reason, 'blocked:login');
  assert.equal(second.blocked.outcome, 'login');
  assert.equal(calls.length, 1, '阻塞期间不能 fork CLI');
  assert.equal(scheduled.length, 0, '阻塞期间不能排延迟重试');
  assert.match(fs.readFileSync(path.join(dir, 'cli.log'), 'utf8'), /skip reason=blocked:login/);

  const forced = wakeControllerViaCli({ dir, reason: 'manual', now: Date.now() + 2000, force: true, spawnImpl: fakeSpawn(calls), timers });
  assert.equal(forced.ok, true);
  assert.equal(calls.length, 2);
});

test('阻塞窗口过期后只放一次探测，探测再失败就继续阻塞', () => {
  const { dir } = sandbox();
  const calls = [];
  fs.writeFileSync(path.join(dir, 'cli.state.json'), JSON.stringify({
    lastAt: 0,
    pendingDeferred: false,
    blocked: { outcome: 'quota', since: 1, at: 1, strikes: 1, retryAt: 1000 }
  }));
  const probe = wakeControllerViaCli({ dir, reason: 'probe', now: 2000, spawnImpl: fakeSpawn(calls) });
  assert.equal(probe.ok, true);
  assert.equal(calls.length, 1);
  assert.match(fs.readFileSync(path.join(dir, 'cli.log'), 'utf8'), /probe reason=blocked:quota/);

  fs.appendFileSync(path.join(dir, 'cli.run.log'), "You've reached your daily usage limit\n");
  calls[0].handlers.exit(1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'cli.state.json'), 'utf8'));
  assert.equal(state.blocked.outcome, 'quota');
  assert.equal(state.blocked.strikes, 2);
  assert.ok(state.blocked.retryAt > Date.now());

  const again = wakeControllerViaCli({ dir, reason: 'probe2', now: Date.now() + 1000, spawnImpl: fakeSpawn(calls) });
  assert.equal(again.reason, 'blocked:quota');
  assert.equal(calls.length, 1);
});

test('上一轮的失败输出不会污染本轮结论', () => {
  const { dir } = sandbox();
  const calls = [];
  // 上一轮把 quota 文案留在共享 run.log 里
  fs.writeFileSync(path.join(dir, 'cli.run.log'), "You've reached your daily usage limit\nCome back tomorrow.\n");
  wakeControllerViaCli({ dir, reason: 'a', now: 1000, spawnImpl: fakeSpawn(calls), env: {} });
  fs.appendFileSync(path.join(dir, 'cli.run.log'), '事件回合已处理完，队列里只有这一条待复核项。\n');
  calls[0].handlers.exit(0);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'cli.state.json'), 'utf8'));
  assert.equal(state.lastOutcome, 'ok');
  assert.equal(state.blocked, null);
  assert.equal(wakeStatus(dir).blocked, null);
  assert.equal(wakeStatus(dir).outcome, 'ok');
});

test('成功的唤醒会清掉之前的阻塞状态', () => {
  const { dir } = sandbox();
  const calls = [];
  fs.writeFileSync(path.join(dir, 'cli.state.json'), JSON.stringify({
    lastAt: 0,
    blocked: { outcome: 'login', since: 1, at: 1, strikes: 3, retryAt: 1 }
  }));
  wakeControllerViaCli({ dir, reason: 'probe', now: 2000, spawnImpl: fakeSpawn(calls) });
  fs.appendFileSync(path.join(dir, 'cli.run.log'), 'NOOP\n');
  calls[0].handlers.exit(0);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'cli.state.json'), 'utf8'));
  assert.equal(state.blocked, null);
  const status = wakeStatus(dir);
  assert.equal(status.blocked, null);
  assert.equal(status.outcome, 'ok');
  assert.equal(status.pendingDeferred, false);
});

test('旧状态缺本轮起点时不会把上一轮失败当结论', () => {
  const { dir } = sandbox();
  fs.writeFileSync(path.join(dir, 'cli.run.log'), "You've reached your daily usage limit\n");
  fs.writeFileSync(path.join(dir, 'cli.state.json'), JSON.stringify({
    lastAt: Date.now(), // 刚发起唤醒，还没有退出回执
    lastOutcomeAt: Date.now() - 60000,
    lastOutcome: 'quota'
  }));
  const status = wakeStatus(dir);
  assert.equal(status.outcome, 'running');
  assert.equal(status.source, 'state');
});

test('成功/失败两种结局都按本轮输出段判定', () => {
  const { dir } = sandbox();
  const calls = [];
  fs.writeFileSync(path.join(dir, 'cli.run.log'), "You've reached your daily usage limit\n");
  wakeControllerViaCli({ dir, reason: 'a', now: 1000, spawnImpl: fakeSpawn(calls), env: {} });
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'cli.state.json'), 'utf8'));
  assert.ok(state.lastRunOffset > 0, '本轮起点必须落盘');
  fs.appendFileSync(path.join(dir, 'cli.run.log'), 'Sorry, something went wrong.\n');
  calls[0].handlers.exit(0);
  assert.equal(wakeStatus(dir).outcome, 'ok');

  // 本轮真的撞上额度：即使退出码是 0 也要判 blocked
  fs.appendFileSync(path.join(dir, 'cli.run.log'), "You've reached your daily usage limit\n");
  wakeControllerViaCli({ dir, reason: 'b', now: Date.now() + 1000, spawnImpl: fakeSpawn(calls), env: {} });
  fs.appendFileSync(path.join(dir, 'cli.run.log'), 'Not logged in · Please run /login\n');
  calls[1].handlers.exit(0);
  const blocked = wakeStatus(dir);
  assert.equal(blocked.outcome, 'login');
  assert.equal(blocked.blocked.outcome, 'login');
});

test('启动对账把被重启打断的唤醒标记为 interrupted，已收尾的不动', () => {
  const { dir } = sandbox();
  fs.writeFileSync(path.join(dir, 'cli.state.json'), JSON.stringify({
    lastAt: 1000,
    lastOutcomeAt: 500,
    lastOutcome: 'ok',
    pendingDeferred: true,
    lastReason: 'propose_code'
  }));
  const done = reconcileInterruptedWake(dir, 2000);
  assert.equal(done.lastReason, 'propose_code');
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'cli.state.json'), 'utf8'));
  assert.equal(state.lastOutcome, 'interrupted');
  assert.equal(state.pendingDeferred, false);
  assert.equal(wakeStatus(dir).outcome, 'interrupted');
  // 旧进程的 detached CLI 还在追加输出，也不能把结论改回 quota
  fs.appendFileSync(path.join(dir, 'cli.run.log'), "You've reached your daily usage limit\n");
  assert.equal(wakeStatus(dir).outcome, 'interrupted');
  assert.equal(reconcileInterruptedWake(dir, 3000), null);
});

test('阻塞期间到点的延迟唤醒直接作废', () => {
  const { dir } = sandbox();
  const calls = [];
  const { scheduled, timers } = fakeTimers();
  wakeControllerViaCli({ dir, reason: 'a', now: 1000, spawnImpl: fakeSpawn(calls), timers });
  wakeControllerViaCli({ dir, reason: 'b', now: 2000, spawnImpl: fakeSpawn(calls), timers });
  assert.equal(scheduled.length, 1);
  const state = JSON.parse(fs.readFileSync(path.join(dir, 'cli.state.json'), 'utf8'));
  fs.writeFileSync(path.join(dir, 'cli.state.json'), JSON.stringify({
    ...state,
    blocked: { outcome: 'quota', since: 1, at: 1, strikes: 1, retryAt: Date.now() + 3600000 }
  }));
  scheduled[0].fn();
  assert.equal(calls.length, 1, '阻塞期间延迟唤醒不能再 fork');
  assert.match(fs.readFileSync(path.join(dir, 'cli.log'), 'utf8'), /deferred-skip reason=blocked:quota/);
});
