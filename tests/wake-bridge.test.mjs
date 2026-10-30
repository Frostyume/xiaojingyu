import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(
  path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')),
  '..'
);
// 桌面插件是可选依赖：公开仓库里没有它，找不到就跳过这组用例。
const pluginPath = [
  process.env.WAKE_BRIDGE_PLUGIN,
  path.resolve(repoRoot, '..', 'qoder-plugin', 'wake-bridge', 'dist', 'node', 'main.cjs'),
  path.resolve(repoRoot, 'qoder-plugin', 'wake-bridge', 'dist', 'node', 'main.cjs')
].filter(Boolean).find((candidate) => fs.existsSync(candidate));
if (!pluginPath) {
  console.log('skip: 未找到 qoder-plugin/wake-bridge 构建产物（可选依赖，可用 WAKE_BRIDGE_PLUGIN 指定路径）');
  process.exit(0);
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wake-bridge-'));
const bridgeDir = path.join(root, 'bridge');
const stateDir = path.join(root, 'state');
const orchestrator = path.join(bridgeDir, 'state', 'orchestrator');

fs.mkdirSync(path.join(orchestrator, 'plans'), { recursive: true });
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(
  path.join(orchestrator, 'plans', 'code_20260101_aaaaaaaa.md'),
  '# 计划\n\n1. 定位缓存未清理\n2. 补测试\n'
);
fs.writeFileSync(
  path.join(orchestrator, 'wake.request.json'),
  JSON.stringify({ pending: ['code_20260101_aaaaaaaa'], firstRequestedAt: new Date().toISOString() })
);

process.env.WAKE_BRIDGE_BRIDGE_DIR = bridgeDir;
process.env.WAKE_BRIDGE_STATE_DIR = stateDir;

const plugin = require(pluginPath);

const created = [];
const context = {
  extensionPath: path.dirname(pluginPath),
  subscriptions: [],
  api: {
    chat: {
      async getState() {
        return { sessions: [] };
      },
      async createSession() {
        throw new Error('APP_PLUGIN_CREATE_SESSION_INVALID');
      },
      async createDetachedSession(input) {
        created.push(input);
        return { sessionId: 'session-' + created.length, turnId: 'turn-' + created.length };
      },
    },
  },
};

await plugin.activate(context);

assert.equal(created.length, 1, 'startup should create one session for the pending task');
assert.match(created[0].prompt, /code_20260101_aaaaaaaa/);
assert.match(created[0].prompt, /定位缓存未清理/, 'prompt should embed the plan body');
assert.match(created[0].prompt, /不合并/, 'prompt should carry the boundary lines');
assert.equal(created[0].permissionMode, 'auto', 'detached session needs an explicit permission mode');
assert.match(created[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'requestId must be a UUID');

const handled = JSON.parse(fs.readFileSync(path.join(stateDir, 'handled.json'), 'utf8'));
assert.deepEqual(handled, ['code_20260101_aaaaaaaa'], 'handled ids should be persisted');
assert.equal(fs.existsSync(path.join(orchestrator, 'wake.request.json')), false, 'wake file should be archived after processing');
assert.ok(fs.existsSync(path.join(orchestrator, 'wake.last.json')), 'archived copy stays readable');

await plugin.activate(context);
assert.equal(created.length, 1, 're-activation must not re-create a session for the same task');

const events = fs
  .readFileSync(path.join(stateDir, 'events.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.ok(events.some((e) => e.kind === 'session-attempt-failed'), 'failed attempt should be logged');
const createdEvent = events.find((e) => e.kind === 'session-created');
assert.ok(createdEvent && /createDetachedSession/.test(createdEvent.via), 'fallback should report which method worked');

// 提案先到主控：target=coordinator 时插件不得新建任何会话，只记一条待办。
const coordStateDir = path.join(root, 'state-coordinator');
process.env.WAKE_BRIDGE_STATE_DIR = coordStateDir;
fs.writeFileSync(
  path.join(orchestrator, 'wake.request.json'),
  JSON.stringify({
    pending: ['code_20260101_cccccccc'],
    targets: { code_20260101_cccccccc: 'coordinator' },
  })
);
delete require.cache[require.resolve(pluginPath)];
const coordPlugin = require(pluginPath);
const coordSessions = [];
await coordPlugin.activate({
  extensionPath: path.dirname(pluginPath),
  subscriptions: [],
  api: {
    chat: {
      async createSession() {
        coordSessions.push('createSession');
        throw new Error('APP_PLUGIN_ID_INVALID');
      },
      async createDetachedSession() {
        coordSessions.push('createDetachedSession');
        return { sessionId: 'should-not-exist' };
      },
    },
  },
});
assert.equal(coordSessions.length, 0, 'coordinator-targeted proposal must not spawn a session');
const coordEvents = fs
  .readFileSync(path.join(coordStateDir, 'events.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.ok(coordEvents.some((e) => e.kind === 'coordinator-deferred'), 'coordinator deferral should be logged');
assert.deepEqual(
  JSON.parse(fs.readFileSync(path.join(coordStateDir, 'deferred.json'), 'utf8')),
  ['code_20260101_cccccccc']
);
assert.equal(fs.existsSync(path.join(coordStateDir, 'handled.json')), false, 'deferred ids must stay dispatchable');

// 主控收件箱：只唤醒 controller.json 指名的会话，绝不新建会话、也不动 handled.json。
const inboxStateDir = path.join(root, 'state-inbox');
process.env.WAKE_BRIDGE_STATE_DIR = inboxStateDir;
fs.rmSync(path.join(orchestrator, 'wake.request.json'), { force: true });
fs.writeFileSync(
  path.join(orchestrator, 'controller.json'),
  JSON.stringify({ enabled: true, sessionId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' })
);
const inboxFile = path.join(orchestrator, 'coordinator-inbox.json');
const writeInbox = (times) =>
  fs.writeFileSync(
    inboxFile,
    JSON.stringify({
      version: 1,
      items: [{ id: 'code_20260101_dddddddd', reason: 'proposal', firstAt: 1000, lastAt: 1000 * times, times }],
    })
  );
writeInbox(1);

delete require.cache[require.resolve(pluginPath)];
const inboxPlugin = require(pluginPath);
const continued = [];
let spawnAttempts = 0;
const inboxChat = {
  async createSession() {
    spawnAttempts += 1;
    throw new Error('APP_PLUGIN_ID_INVALID');
  },
  async createDetachedSession() {
    spawnAttempts += 1;
    return { sessionId: 'should-not-exist' };
  },
  async continueSession(input) {
    continued.push(input);
    return { sessionId: input.sessionId, turnId: 'turn-inbox' };
  },
};
const inboxContext = { extensionPath: path.dirname(pluginPath), subscriptions: [], api: { chat: inboxChat } };

await inboxPlugin.activate(inboxContext);
assert.equal(continued.length, 1, 'inbox item should wake the coordinator session once');
assert.equal(continued[0].sessionId, 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'wake must target controller.json sessionId');
assert.match(continued[0].prompt, /code_20260101_dddddddd/, 'prompt should name the task');
assert.match(continued[0].prompt, /不合并|不提交/, 'prompt should carry the boundary lines');
assert.match(continued[0].requestId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/, 'requestId must be a UUID');
assert.equal(spawnAttempts, 0, 'inbox wake must never spawn a session');
assert.equal(fs.existsSync(path.join(inboxStateDir, 'handled.json')), false, 'inbox wake must not mark the task handled');
assert.ok(fs.existsSync(inboxFile), 'inbox stays for the coordinator to clear itself');

// 重启插件不重复叫醒同一版本条目；桥接把 times 加一后才再次叫醒。
delete require.cache[require.resolve(pluginPath)];
await require(pluginPath).activate(inboxContext);
assert.equal(continued.length, 1, 're-activation must not wake the same inbox item again');
writeInbox(2);
delete require.cache[require.resolve(pluginPath)];
await require(pluginPath).activate(inboxContext);
assert.equal(continued.length, 2, 'a bumped inbox item should wake again');

const inboxEvents = fs
  .readFileSync(path.join(inboxStateDir, 'events.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.ok(inboxEvents.some((e) => e.kind === 'coordinator-woken'), 'coordinator wake should be logged');
fs.rmSync(path.join(orchestrator, 'controller.json'), { force: true });
fs.rmSync(inboxFile, { force: true });

const failingStateDir = path.join(root, 'state-fail');
process.env.WAKE_BRIDGE_STATE_DIR = failingStateDir;
delete require.cache[require.resolve(pluginPath)];
const failingPlugin = require(pluginPath);

const failContext = {
  extensionPath: path.dirname(pluginPath),
  subscriptions: [],
  api: {
    chat: {
      async getState() {
        return {};
      },
      async createDetachedSession() {
        throw new Error('PERMISSION_DENIED: chat.createDetachedSession');
      },
    },
  },
};

fs.writeFileSync(
  path.join(orchestrator, 'wake.request.json'),
  JSON.stringify({ pending: ['code_20260101_bbbbbbbb'] })
);
await failingPlugin.activate(failContext);

const failEvents = fs
  .readFileSync(path.join(failingStateDir, 'events.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line));
assert.ok(failEvents.some((e) => e.kind === 'session-attempt-failed'));
const failEvent = failEvents.find((e) => e.kind === 'session-failed');
assert.ok(failEvent, 'all attempts failing should log session-failed');
assert.match(failEvent.error, /PERMISSION_DENIED/);
const failedHandled = JSON.parse(fs.readFileSync(path.join(failingStateDir, 'handled.json'), 'utf8'));
assert.deepEqual(failedHandled, ['code_20260101_bbbbbbbb'], 'failed task must not retry in a loop');

fs.rmSync(root, { recursive: true, force: true });
console.log('test-wake-bridge: passed');
