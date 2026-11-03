// Execute the real bridge initialization/functions against temporary files and fake peers.
// No production config, QQ connection, DSH process, or persistent home is accessed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as markdown from '../services/media/md-to-plain.js';
import * as sensitive from '../runtime/kernel/sensitive.js';
import * as wait from '../services/persona/simulation-wait.js';
import * as safeFetch from '../services/social/safe-fetch.js';
import * as forward from '../services/media/forward.js';
import * as slang from '../services/social/slang-learner.js';
import * as sticker from '../services/media/sticker-lib.js';
import * as modelPrices from '../services/social/model-prices.js';
import * as tokenLedger from '../services/social/token-ledger.js';
import * as voiceLib from '../services/media/send-voice-lib.js';
import * as imageLib from '../services/media/image-lib.js';
import * as presetPrompt from '../services/persona/preset-prompt.js';
import * as roleCard from '../services/persona/role-card.js';
import * as quietHours from '../services/persona/quiet-hours.js';
import * as stateAcl from '../runtime/kernel/state-acl.mjs';
import * as coreDb from '../runtime/kernel/db.js';
import * as coreOutbox from '../runtime/kernel/outbox.js';
import * as coreJobs from '../runtime/kernel/jobs.js';
import * as coreInbox from '../runtime/kernel/inbox.js';
import * as coreConfigSchema from '../runtime/kernel/config-schema.js';
import * as coreConfigStore from '../runtime/kernel/config-store.js';
import * as coreStateFile from '../runtime/kernel/state-file.js';
import * as coreControllerCli from '../runtime/control/controller-cli.js';
import * as consoleAuth from '../console/auth.js';
import * as consolePolicy from '../console/policy.js';
import * as consoleLive from '../console/live.js';
import * as coreLogger from '../runtime/kernel/logger.js';
import * as coreHealth from '../runtime/kernel/health.js';
import * as corePromptBudget from '../runtime/kernel/prompt-budget.js';
import * as coreWakeScore from '../runtime/kernel/wake-score.js';
import * as coreModelRouting from '../runtime/kernel/model-routing.js';
import * as coreMemory from '../runtime/kernel/memory.js';
import * as coreSessionMap from '../runtime/kernel/session-map.js';
import * as coreRelationships from '../runtime/persona/relationships.js';
import * as coreRelationshipModel from '../runtime/persona/relationship-model.js';
import * as coreRichCard from '../runtime/persona/rich-card.js';
import * as corePersonaPack from '../runtime/persona/persona-pack.js';
import * as coreStyleContext from '../runtime/persona/style-context.js';
import * as coreDailyReport from '../runtime/orchestration/daily-report.js';
import * as coreTtsEmotion from '../runtime/persona/tts-emotion.js';
import * as coreSpeech from '../runtime/persona/speech.js';
import * as coreFeatureLoader from '../runtime/kernel/feature-loader.js';
import * as coreEventBus from '../runtime/kernel/event-bus.js';
import * as coreTransport from '../runtime/kernel/transport.js';
import * as coreBudget from '../runtime/kernel/budget.js';
import * as coreSignature from '../runtime/persona/signature.js';
import * as controlTiers from '../runtime/control/control-tiers.js';
import * as ownerConfig from '../runtime/control/owner-config.js';
import * as featureSwitches from '../runtime/control/feature-switches.js';
import * as featureControl from '../runtime/control/feature-control.js';
import * as coreTimeAwareness from '../runtime/kernel/time-awareness.js';
import * as esportsSchedule from '../services/social/esports-schedule.js';
import * as esportsFeed from '../services/social/esports-feed.js';
import { unwrap, createTurnCollector } from '../channels/dsh/client.js';

const root = fileURLToPath(new URL('..', import.meta.url));
export async function bridgeHarness({ config = {}, savedState, files = {}, globals = {} } = {}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-audit-bridge-'));
  fs.mkdirSync(path.join(temp, 'src'));
  fs.mkdirSync(path.join(temp, 'state'));
  const mergedConfig = {
    dsh: { authToken: 'fixture-only' }, ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] }, consolePort: 0,
    consoleToken: 'fixture-console-token', slang: { enabled: false },
    ...config,
    // 离线夹具默认把模块总开关全开：既有回归验证的是各功能行为，不是默认关闭。
    // 总开关默认值/关闭行为由 tests/feature-switches.test.mjs 单独覆盖。
    features: {
      disabled: [],
      ...Object.fromEntries(featureSwitches.FEATURE_IDS.map((id) => [id, true])),
      ...(config.features ?? {})
    },
    // 离线安全回归默认开启控制台令牌；生产默认关闭（consoleAuth.enabled=false）。
    consoleAuth: { enabled: true, ...(config.consoleAuth ?? {}) },
    // 离线测试不能依赖本机时钟：凌晨/夜间跑时，真实夜间静默会吞掉 timeout 唤醒。
    simulation: { nightQuiet: { enabled: false }, ...(config.simulation ?? {}) }
  };
  fs.writeFileSync(path.join(temp, 'config.json'), JSON.stringify(mergedConfig));
  if (savedState) fs.writeFileSync(path.join(temp, 'state/sessions.json'), JSON.stringify(savedState));
  // 额外状态文件（用于测试"启动时读到损坏/旧版文件"这类路径）。
  for (const [rel, content] of Object.entries(files)) {
    const target = path.join(temp, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, typeof content === 'string' ? content : JSON.stringify(content));
  }
  const calls = { created: [], archived: [], sent: [], prompts: [], follows: [], cancelled: [], images: [], faces: [], http: [], models: [] };
  // 语音发送在桥接里是**直接 fetch 网关**（与文本/表情共用 sendChain，但要自己带 record 段），
  // 所以这里给 VM 注入一个记录型 fetch：既不让测试真的发 QQ 消息，又能断言发出的段内容。
  const fakeFetch = async (url, init = {}) => {
    const body = (() => { try { return JSON.parse(init.body ?? '{}'); } catch { return init.body; } })();
    calls.http.push({ url: String(url), body });
    const action = String(url).split('/').pop();
    if (action === 'fetch_ptt_text') {
      return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { text: 'fixture-transcript' } }) };
    }
    // get_msg：语音落地校验用 —— 回一个带 record 段的消息，模拟真实网关
    if (action === 'get_msg') {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          status: 'ok',
          retcode: 0,
          data: { message_id: 9001, message: [{ type: 'record', data: { file: 'fixture-record.amr', duration: 3 } }] }
        })
      };
    }
    return { ok: true, status: 200, json: async () => ({ status: 'ok', retcode: 0, data: { message_id: 9001 } }) };
  };
  const success = (value) => ({ result: { ok: true, value } });
  const api = {
    events: { follow: (id) => calls.follows.push(id) },
    // settings.describe 的默认桩：没有 qq-mode 命名空间 ⇒ refreshMode() 回退到本地 mode.json。
    // 测试可覆盖它来验证「DSH 设置里的空 ownerQQ 不得覆盖 config.json」等契约。
    settings: {
      describe: async () => success({ namespaces: [] }),
      update: async () => success({ updated: true })
    },
    workspace: {
      create: async () => success({ created: false, workspace: { workspaceId: 'fixture-workspace' } }),
      archiveSession: async ({ sessionId }) => { calls.archived.push(sessionId); return success({}); },
    },
    sessions: {
      create: async (params) => { calls.created.push(params); return success({ sessionId: `fixture-${calls.created.length}` }); },
      selectModel: async (params) => { calls.models.push(params); return success({ selected: { provider: params?.provider ?? 'fixture', model: params?.model ?? 'fixture', reasoningEffort: params?.reasoningEffort } }); },
      prompt: async (params) => { calls.prompts.push(params); return success({}); },
    },
    respond: async () => success({}),
    stopSessionWork: async (sessionId) => { calls.cancelled.push(sessionId); return { removed: 0 }; },
    callUnary: async (method, params) => { calls.cancelled.push({ method, params }); return success({ accepted: true }); },
  };
  class FakeBot {
    async sendPrivateMessage(id, text) { calls.sent.push({ kind: 'private', id, text }); }
    async sendGroupMessage(id, text) { calls.sent.push({ kind: 'group', id, text }); }
    async getImage({ file }) {
      calls.images.push(file);
      // Valid 1 × 1 PNG, supplied entirely in memory by the fixture gateway.
      return { base64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+k3ioAAAAASUVORK5CYII=' };
    }
    async getLoginInfo() { return { user_id: 999, nickname: '小鲸鱼' }; }
    async fetchFaceEntity(id) { calls.faces.push(id); return null; }
    async request() { return { status: 'ok', retcode: 0, data: [{ emoji_id: 'fixture-sticker', url: 'https://public.invalid/sticker' }] }; }
  }
  let source = fs.readFileSync(path.join(root, 'app/whale.js'), 'utf8');
  // 去掉顶层 import（VM 里靠 context 注入提供这些绑定）。
  // 必须按行处理：这些 import 有**多行**写法，用单行正则（/^import[\s\S]*?;/gm）会在
  // 第一个分号处停下，把紧跟其后的正常代码一起删掉（曾把 `cfg.simulation.voice = {…}`
  // 整段吞掉，导致语音相关断言在虚拟环境里悄悄失真）。
  source = source.split(/\r?\n/).reduce((acc, line) => {
    if (acc.droppingImport) {
      if (/;\s*$/.test(line)) acc.droppingImport = false;
      return acc;
    }
    if (/^import[\s{*]/.test(line) || /^import\s+['"]/.test(line)) {
      if (!/;\s*$/.test(line)) acc.droppingImport = true;
      return acc;
    }
    acc.out.push(line);
    return acc;
  }, { out: [], droppingImport: false }).out.join('\n');
  source = source.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(path.join(temp, 'app/whale.js')).href));
  source = source.slice(0, source.indexOf("process.on('SIGINT'"));
  source = source.replace('  bot.onPrivateMessage(async (event) => {', `
  return {
    ensureSession, ensureSlangLearnerSession, resolvePresetName, deliverPrompt, drainPromptQueue,
    sendToQQ, sendSticker, handleIncoming, startConsoleServer, cfg, state, api, promptQueues,
    getSimulationState, appendSimulationMessage, recordSentMessages,
    globalActivityMode, isDeepDive, resyncActivityControl,
    appendMemory, formatMemory,
    buildWakePrompt, buildWakeSnapshot, sendWakePrompt, simulation,
    renderWakePrompt, commitWakePrompt, invalidateRoleCards, currentRoleName, isCustomRoleName,
    relationshipStore, relationshipsEnabledForKey, buildRelationshipSnapshot, buildLiveSnapshot,
    refreshMode, modeAllowed, trackTurnEvent, replayPendingWakeReasons,
    collectors, setupSleepTimer,
    scheduleProactiveCheck, cancelProactiveCheck, cancelAllProactiveChecks,
    getInitialPrompt, setInitialPrompt, loadInitialPrompts, formatInitialPrompt,
    initialPrompts, initialPromptMaxChars,
    extractMediaFromSegments, segmentsToText, fetchOneBotImage, fetchMediaData, resolveMediaList,
    emojiCdnCandidates, getImageDimensions, acceptImageBuffer, MAX_MEDIA_BYTES, bot,
    isConversationBusy, simulationTurnStartAt, turnLeaseNoted, TURN_BUSY_LEASE_MS,
    settingFromDshNamespace, selfIdentityText, buildWakeReminderPrompt,
    evaluateWakeTrigger, wakeScoreDecision, buildContextDigest, maybeRotateSessionForContext,
    isNightQuietNow, nightQuietConfig, buildToneNudgeLine, scheduleClingyFollowUp,
    getMode() { return currentMode; },
    signatureState,
    handleSignatureJob,
    handleSignatureOwnerCommand,
    handleDailyReportJob,
    getStickerEntries: () => stickerEntries,
    getImageEntries: () => imageEntries,
    buildSignaturePreview,
    setSelfIdentity(display, id) {
      selfDisplayName = String(display ?? '');
      selfUserId = String(id ?? '');
      selfNickname = selfDisplayName.toLowerCase() || 'deepseek';
    },
    flushQueue, retireSession, disposeConversation,
    // 控制面分层（docs/CONTROL-TIERS-PLAN-2026-10-30.md）：授权判定与待确认动作，
    // 集成测试既走 HTTP，也直接断言判定表与 /确认 回放。
    canActOn, canReadAcrossSessions, ownerDirectiveFreshFor, controlTierCfg,
    ownerChatKey, callerKeyOfToken, ownerHighRiskGuard,
    confirmPendingActionByCode, pendingActionsNow,
    hashActionArgs, createPendingAction, isHighRiskOwnerAction, describePendingAction,
    voiceCfg, voiceLibrary, resolveSimulationVoicePath, resolveVoicePathForOperator,
    voiceBudgetCheck, sendVoiceFile, sendVoiceForConversation, assertOutboundAuditOk,
    setMode(value) { currentMode = value; },
    setReady(value) { dshReady = value; },
    setPresets(value) { dshPresetIds = value; dshDefaultPreset = 'standard'; },
    setSnowlumaConnected(value) { snowlumaHealth.connected = value === true; },
    setInnerLife(value) { innerLife = value; },
    getInnerLife() { return innerLife; },
    resetEpoch() { sessionEpoch++; },
    closeStorage() {
      try { outbox?.stop(); } catch {}
      try { jobQueue?.stop(); } catch {}
      try { reliabilityDb?.close(); } catch {}
    },
  };
  bot.onPrivateMessage(async (event) => {`);
  const timers = new Set();
  const context = vm.createContext({
    fs, os, path, http, crypto, fileURLToPath, URL, Buffer, AbortSignal, console: { log() {}, error() {} },
    fetch: fakeFetch,
    // 锁文件探测用（bridge.js 顶层的 consolePortInUse）；
    // 固定桩掉：测试不应该真去 netstat 宿主机。
    execFileSync: () => '',
    // process 桩要带 env：voice-core / bridge 会读 process.env.FFMPEG_PATH、FFPROBE_PATH 等。
    // 之前只给 pid/platform/kill/exit，导致 `process.env.FFMPEG_PATH` 直接抛 TypeError。
    // uptime 供 /api/live/snapshot 组装展示字段；夹具给一个固定值，断言不依赖真实时钟。
    process: { pid: process.pid, platform: process.platform, kill: process.kill, env: {}, uptime: () => 1234, exit: (code) => { throw new Error('unexpected exit ' + code); } },
    // 挂上原始回调：测试需要确定性地触发一次已排队的定时器（不等真实 60s~90min）。
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timer.__fixtureCallback = fn; timers.add(timer); return timer; },
    clearTimeout, setInterval: () => ({ unref() {} }), clearInterval: () => {},
    NodeApiClient: class { constructor() { return api; } },
    SnowLumaWebSocketClient: FakeBot, text: (s) => s,
    discoverDshLaunchToken: () => '', unwrap, createTurnCollector,
    ...markdown, ...sensitive, ...wait, ...safeFetch, ...forward, ...slang, ...sticker,
    ...modelPrices, ...tokenLedger, ...voiceLib, ...imageLib, ...stateAcl, ...presetPrompt, ...quietHours, ...roleCard,
    ...coreDb, ...coreOutbox, ...coreJobs, ...coreInbox, ...coreConfigSchema, ...coreConfigStore, ...coreStateFile, ...coreLogger,
    ...coreControllerCli,
    ...consoleAuth, ...consolePolicy, ...consoleLive,
    coreAtomicWriteJson: coreStateFile.atomicWriteJson,
    coreAtomicWriteText: coreStateFile.atomicWriteText,
    coreReadJsonSafe: coreStateFile.readJsonSafe,
    ...coreHealth, ...corePromptBudget, ...coreWakeScore, ...coreModelRouting, ...coreMemory,
    ...coreSessionMap, ...coreRelationships, ...coreRelationshipModel, ...coreRichCard, ...corePersonaPack, ...coreStyleContext, ...coreDailyReport,
    relationshipStageLabel: coreRelationshipModel.stageLabel,
    relationshipAxisWords: coreRelationshipModel.axisWords,
    relationshipBond: coreRelationshipModel.computeBond,
    ...coreTtsEmotion, ...coreSpeech, ...coreFeatureLoader, ...coreEventBus, ...coreTransport, ...coreBudget, ...coreSignature, ...controlTiers, ...ownerConfig, ...featureSwitches, ...featureControl, ...coreTimeAwareness,
    ...esportsSchedule,
    ...esportsFeed,
    deepMergeConfig: coreHealth.deepMerge,
    // ACL 收紧会 spawn icacls 去改**真实**文件系统；测试不该做这件事（同理见下面的
    // cleanupTemp / processAudioVolume 桩）。桩成成功，让 hardenStateDirAcl 走正常分支。
    hardenDir: () => ({ ok: true, detail: 'stub' }),
    // 音量靠 ffmpeg；测试环境不该真跑 ffmpeg（也不该在沙箱里 spawn）。
    // 默认桩成"按倍数记账但不转码"，调用方可用 globals 覆盖来断言真实行为。
    processAudioVolume: async (file, { volume = 1, normalize = false, loudness = 'normal' } = {}) => {
      const v = Number(volume);
      const changed = normalize === true || Math.abs(v - 1) > 1e-9;
      return {
        path: changed ? `${file}.vol` : file,
        converted: changed,
        applied: changed,
        volume: normalize ? 1 : v,
        loudness: normalize ? -16 : null,
        mode: normalize ? 'loudnorm' : (changed ? 'volume' : 'original'),
        detail: normalize ? `智能音量（响度归一 ${loudness === 'loud' ? -13 : loudness === 'quiet' ? -20 : -16} LUFS）`
          : (changed ? `音量 ${Math.round(v * 100)}%` : '原始音量')
      };
    },
    cleanupTemp: () => {},
    ...globals,
  });
  // Execute the pure model view in the bridge realm. Its plain-object checks
  // should see the same prototypes as real bridge messages, just as in Node.
  const modelViewSource = fs.readFileSync(path.join(root, 'services/social/qq-model-view.js'), 'utf8').replace(/^export /gm, '');
  vm.runInContext(`Object.assign(globalThis, (() => { ${modelViewSource}\nreturn { compactModelMessage, compactModelData, serializeModelData }; })());`, context);
  vm.runInContext(source + '\nglobalThis.auditReady = main();', context);
  const bridge = await context.auditReady;
  bridge.setPresets(['standard', 'qq-chat-legacy', 'qq-chat']);
  bridge.setReady(true);
  // 夹具模拟「SnowLuma 已连接」：否则 outbox 会把消息留在 pending，测试看不到真实发送。
  bridge.setSnowlumaConnected?.(true);
  return { ...bridge, calls, temp, async close() {
    for (const timer of timers) clearTimeout(timer);
    // SQLite 文件句柄在 Windows 上会阻止删除临时目录：先显式关库/worker。
    try { bridge.closeStorage?.(); } catch {}
    try { fs.rmSync(temp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {}
  } };
}
