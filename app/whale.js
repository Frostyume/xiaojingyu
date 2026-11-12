// QQ ↔ DeepSeek Harness 桥接主程序。
//
// 链路：
//   QQ 消息 → SnowLuma (OneBot v11 WS) → 本进程 → DSH Web API session.prompt
//   DSH agent 回复/提问/审批 → events.mux 事件流 → 本进程 → send_msg → QQ
//
// 用法：node app/whale.js （先编辑 ../config.json）
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import yaml from 'js-yaml';
import { extractPresetPrefix, presetPromptBlockers, presetPromptWarnings, renderPresetPromptYaml } from '../services/persona/preset-prompt.js';
import { LEGACY_ROLE_LINE_RE, parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from '../services/persona/role-card.js';
import { fileURLToPath } from 'node:url';
import { SnowLumaWebSocketClient, text } from '@snowluma/sdk';
import { NodeApiClient, unwrap, createTurnCollector, discoverDshLaunchToken } from '../channels/dsh/client.js';
import { UNTRUSTED_GROUP_INPUT_HINT } from '../runtime/kernel/prompt-safety.js';
import { mdToPlain, splitForQQ, truncateText, truncateTextTail } from '../services/media/md-to-plain.js';
import { SENSITIVE_RE } from '../runtime/kernel/sensitive.js';
import { looksLikeUnfinished } from '../services/persona/simulation-wait.js';
import { compactModelMessage } from '../services/social/qq-model-view.js';
import { safeFetch, safeFetchBuffer, looksLikeImageBuffer } from '../services/social/safe-fetch.js';
import { readMoodHistory, summarizeMoodHistory } from '../runtime/persona/mood-history.js';
import { createConfigWriter } from '../runtime/kernel/config-store.js';
import { atomicWriteJson as coreAtomicWriteJson, atomicWriteText as coreAtomicWriteText, readJsonSafe as coreReadJsonSafe } from '../runtime/kernel/state-file.js';
import { normalizePersonaState } from '../services/persona/persona-state.js';
import { derivePersonaMode } from '../runtime/persona/persona-mode.js';
import { DEFAULT_ROLE_NAME, isCustomRoleName, personaStyleContext } from '../runtime/persona/style-context.js';
import { AUDIO_EXTS, cleanupTemp, describeAudio, formatBytes, formatDuration, inspectAudio, listAudioFiles, parseTargetKey, processAudioVolume, resolveAudioProcessing, resolveAudioSource, safeJoinLibrary } from '../services/media/send-voice-lib.js';
import { discoverSnowLumaConnection, persistSnowLumaEndpoint, persistToken } from '../channels/qq/gateway.js';
import { hardenDir, manualDirCommand } from '../runtime/kernel/state-acl.mjs';
import { extractForwardIds, forwardIdFromData, sanitizeForwardId, formatForwardResponse } from '../services/media/forward.js';
import { resolvePriceTable, normalizeUsage, totalTokensOf, priceUsage } from '../services/social/model-prices.js';
import { createTokenLedger, usageOfEvent } from '../services/social/token-ledger.js';
import {
  loadSlang,
  saveSlang,
  upsertSlangEntry,
  buildSlangContext,
  buildExtractionPrompt,
  buildResearchPrompt,
  parseExtractionJson,
  parseResearchJson,
  createSlangEntry,
  mergeEvidence,
  SLANG_STATUS,
  SLANG_MAX_ENTRIES
} from '../services/social/slang-learner.js';
import {
  loadStickerStore,
  saveStickerStore,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from '../services/media/sticker-lib.js';
import { createInnerLife } from '../services/persona/inner-life.js';
import { createOuterWorldStore } from '../services/social/outer-world/store.js';
import {
  chunkText, digestBudget, digestChunks, isSegmentedSource, isSourceFinished, limitDigestChunks,
  migrateLegacySegmentedProgress, pickBodyText, pickNextSource, readCharOffset, segmentDedupeKey
} from '../services/social/outer-world/pipeline.js';
import { buildReadingSnapshot, readingToday, attachReadingExcerpts, outerNotesSnapshot } from '../services/social/outer-world/reading-progress.js';
import { normalizeNovelSource, readChapter } from '../services/social/outer-world/sources/novel.js';
import { evaluateUrl, redactUrlForAudit } from '../services/social/outer-world/policy.js';
import { createRateLimiter } from '../services/social/outer-world/ratelimit.js';
import { probeSubtitleTool, fetchSubtitleTrack } from '../services/social/outer-world/media/subtitle.js';
import { openDatabase, pruneDatabase } from '../runtime/kernel/db.js';
import { Outbox } from '../runtime/kernel/outbox.js';
import { JobQueue } from '../runtime/kernel/jobs.js';
import { Inbox, inboundDedupeKey } from '../runtime/kernel/inbox.js';
import { buildConfigSchema, validateConfigPatch, validateConfigObject, migrateConfigObject, applyConfigPatch, CONFIG_VERSION } from '../runtime/kernel/config-schema.js';
import { createJsonlLogger } from '../runtime/kernel/logger.js';
import { deepMerge as deepMergeConfig } from '../runtime/kernel/health.js';
import { assembleSections, estimateTokens } from '../runtime/kernel/prompt-budget.js';
import { scoreMessage, scoreInputsFromState, VALUE_SCORE_DEFAULTS, topicOverlapScore } from '../runtime/kernel/wake-score.js';
import { resolveModelRoutes, routeSignature } from '../runtime/kernel/model-routing.js';
import { MemoryStore } from '../runtime/kernel/memory.js';
import { SessionMapStore } from '../runtime/kernel/session-map.js';
import { RelationshipStore } from '../runtime/persona/relationships.js';
import { stageLabel as relationshipStageLabel, axisWords as relationshipAxisWords, computeBond as relationshipBond } from '../runtime/persona/relationship-model.js';
import { formatRichSegment } from '../runtime/persona/rich-card.js';
import { loadPersonaPack, renderPersonaPack, savePersonaPack, validatePersonaPack, personaPackPath } from '../runtime/persona/persona-pack.js';
import { buildDailyReport, nextDailyAt, localDateKey, dailyReportEnabled } from '../runtime/orchestration/daily-report.js';
import { createSnowLumaAsr } from '../runtime/persona/speech.js';
import { generateSignature, normalizeSignatureState, appendSignatureHistory, randomSignatureIntervalMs, isSignatureAdjustCommand, isDuplicateSignatureInstruction, cleanSignatureText, isSignatureTextAllowed } from '../runtime/persona/signature.js';
import { beijingParts, timeOfDayLabel } from '../runtime/kernel/time-awareness.js';
import { loadFeatures } from '../runtime/kernel/feature-loader.js';
import { createTransport } from '../runtime/kernel/transport.js';
import { BudgetStore, shanghaiDayKey } from '../runtime/kernel/budget.js';
import { listOwnerCapabilities } from '../runtime/control/owner-capabilities.js';
import { normalizeOwnerFeature, validateOwnerFeature, nextOwnerFeatureRuns, renderOwnerFeaturePreview } from '../runtime/control/owner-features.js';
import { synthesizeFeatureVoice } from '../runtime/orchestration/feature-voice.js';
import { listOwnerConfig, readOwnerConfig, validateOwnerConfig, ownerConfigPatch } from '../runtime/control/owner-config.js';
import { createBlacklist, parseBlacklistCommand, BLACKLIST_DEFAULTS, shouldCountBlacklistStrike, looksLikeBlacklistTalk, resolveBlacklistTarget } from '../runtime/control/blacklist.js';
import { FEATURE_MODULES, normalizeFeatureConfig, featureEnabled, featureSnapshot, featureForShareModule, shareEngineEnabled, shareModuleIdForFeature, SHARE_MODULE_FEATURES } from '../runtime/control/feature-switches.js';
import { FEATURE_BOARDS, FEATURE_CARDS, cardFor, cardDefaultKeys, cardEnabled, cardSwitchKey, cardSwitchValue, evaluateDependencies, featureEnablePatch, advancedFieldsFor, configValueFor, valueAtPath } from '../runtime/control/feature-control.js';
import { listProposals, proposalSummary, readResult, writeResult, mergeProposal, rejectProposal, notificationFor } from '../runtime/orchestration/dev-proposals.js';
import { queueCodeProposal, stageCodeProposal } from '../runtime/orchestration/code-proposal.js';
import { enqueueTask, updateTask, queueSnapshot, readTask } from '../runtime/orchestration/orchestrator-queue.js';
import { requestWake } from '../runtime/orchestration/orchestrator-wake.js';
import { wakeControllerViaCli, wakeStatus, reconcileInterruptedWake } from '../runtime/control/controller-cli.js';
import { reconcileTaskSessions, defaultDbFile } from '../runtime/orchestration/qoder-sessions.js';
import { DEFAULT_QUIET_HOURS, normalizeQuietHours, isQuietNow, quietEndAt } from '../services/persona/quiet-hours.js';
import { loadImageStore, saveImageStore, findImage, searchImages, formatImageList, addImageBuffer, imageFilePath, buildImageContext, buildImageStrategyHint } from '../services/media/image-lib.js';
import { fetchEsportsFeed, buildEsportsFeedBlock, buildEsportsFeedFromSearch, isS16Content } from '../services/social/esports-feed.js';
import { parseScheduleMatches, parseOfficialSchedule, mergeScheduleMatches, buildScheduleLines, nextScheduleMatch, shouldSkipResultBroadcast, shanghaiDateKey, shanghaiHourMinute, addDaysKey, STAGE_SCHEDULE, OFFICIAL_SCHEDULE_URL } from '../services/social/esports-schedule.js';
import { dayStatsFromAudit, decideBroadcast, pruneAuditLines, resultMatchKey, createSkipAuditThrottle } from '../services/social/broadcast-limits.js';
import { webSearch } from '../services/social/web-search.js';
import { isQVersionWhaleSticker } from '../services/media/vision.js';
import { pickPixelSticker, pixelStickerCount } from '../services/media/pixel-stickers.js';
import { moodVoiceCadenceOk, MOOD_VOICE_DEFAULTS } from '../services/media/mood-voice-cadence.js';
import { loadReminderStore, saveReminderStore, addReminder, listReminders, cancelReminder, dueReminders } from '../services/social/reminders.js';
import { getWeather } from '../services/social/weather.js';
import { validConsoleTokenShape, lanHostsFromInterfaces } from '../console/policy.js';
import { CONSOLE_SECURITY_HEADERS, CONSOLE_TOKEN_PROMPT_HTML, authTokenEquals, evaluateConsoleGate, evaluateAgentAccess } from '../console/auth.js';
import {
  CONTROL_TIERS_DEFAULTS,
  PENDING_ACTION_TTL_MS,
  normalizeControlTiers,
  findCallerKey,
  isOwnerDirectiveFresh,
  decideCrossSessionAccess,
  isHighRiskOwnerAction,
  ownerActionCategory,
  describePendingAction,
  hashActionArgs,
  createPendingAction,
  pendingActionUsable,
  findPendingByCode,
  prunePendingActions,
  pendingActionsLoad,
  pendingActionsSave
} from '../runtime/control/control-tiers.js';
import { handleLiveRequest } from '../console/live.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, 'state');

// 插件叫醒主控成功后往 state/wake-bridge/events.jsonl 追加 coordinator-woken；
// 等到它出现就别再 fork CLI 会话，否则两个主控会同时派单。
async function waitPluginCoordinatorWake(taskId, offset, timeoutMs) {
  const file = path.join(WAKE_PLUGIN_STATE_DIR, 'events.jsonl');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const buf = fs.readFileSync(file);
      if (buf.length > offset) {
        for (const line of buf.subarray(offset).toString('utf8').split('\n')) {
          if (!line.trim()) continue;
          let event = null;
          try {
            event = JSON.parse(line);
          } catch {
            continue;
          }
          if (event && event.kind === 'coordinator-woken' && event.taskId === taskId) return true;
        }
      }
    } catch {}
    if (Date.now() >= deadline) return false;
    await sleep(150);
  }
}

// 主控唤醒：先写 wake 文件（兜底），再试事件式 CLI 唤醒；任何失败都不影响任务入队。
async function wakeOrchestrator({ taskId, reason, target = '' }) {
  const orchDir = path.join(STATE_DIR, 'orchestrator');
  let pluginOffset = 0;
  try {
    pluginOffset = fs.statSync(path.join(WAKE_PLUGIN_STATE_DIR, 'events.jsonl')).size;
  } catch {}
  try {
    requestWake(orchDir, { taskId, reason, target });
    if (target === 'coordinator') log(`[orchestrator] ${taskId || '事件'} 只交主控复核（target=coordinator，不自动开执行会话）`);
  } catch (error) {
    log(`[orchestrator] 唤醒信号写入失败：${error?.message ?? error}`);
  }
  if (target === 'coordinator' && taskId) {
    if (await waitPluginCoordinatorWake(taskId, pluginOffset, 2500)) {
      log(`[orchestrator] 桌面插件已直接叫醒主控会话（${taskId}），跳过 CLI fork`);
      return;
    }
  }
  try {
    const woke = wakeControllerViaCli({ dir: orchDir, reason, taskId });
    if (woke.ok) log(`[orchestrator] 已用 CLI 唤醒主控（pid ${woke.pid || '?'}）`);
    else if (woke.blocked) {
      // 阻塞时只报一次事实：事件留在收件箱，等窗口放开或人工处理后自动补推。
      const wait = woke.retryAt
        ? `，最早 ${new Date(woke.retryAt).toLocaleString('zh-CN', { hour12: false })} 自动探测`
        : '，需人工恢复';
      log(`[orchestrator] 主控唤醒被 ${woke.blocked.outcome} 阻塞${wait}；事件已排队，暂停自动唤醒`);
    } else if (woke.skipped) {
      const wait = woke.deferredInMs ? `，${Math.ceil(woke.deferredInMs / 1000)}s 后补唤醒` : '';
      log(`[orchestrator] 未启动 CLI 唤醒：${woke.reason || 'skipped'}${wait}`);
    } else log(`[orchestrator] CLI 唤醒失败：${woke.reason || woke.error || 'unknown'}`);
  } catch (error) {
    log(`[orchestrator] CLI 唤醒异常：${error?.message ?? error}`);
  }
}
const STATE_FILE = path.join(STATE_DIR, 'sessions.json');
// 桌面插件自己的状态目录（项目根/state/wake-bridge），与上面的桥接会话映射不是一回事。
const WAKE_PLUGIN_STATE_DIR = process.env.WAKE_BRIDGE_STATE_DIR || path.resolve(ROOT, '..', 'state', 'wake-bridge');
const WORKSPACE_ROOT = path.resolve(ROOT, '..');

// 唤醒会话归属：桌面插件只能建「游离会话」（cwd 在 Documents\Qoder\<日期>，无 workspace），
// 闭环后也没有归档接口。这里按任务状态做对账：未闭环 → 绑回本项目工作区；已闭环 → 归档。
// 触发点只有三个（都靠事件，不轮询）：桥接启动、插件写入 sessions.json、合并/拒绝完成。
let wakeSessionReconcileTimer = null;
function reconcileWakeSessions(reason = '对账') {
  const orchDir = path.join(STATE_DIR, 'orchestrator');
  reconcileTaskSessions({
    stateDir: WAKE_PLUGIN_STATE_DIR,
    dbFile: process.env.QODER_DB || defaultDbFile(),
    rootPath: WORKSPACE_ROOT,
    taskStatusOf: (id) => readTask(orchDir, id)?.status || ''
  }).then((result) => {
    if (result.bound.length || result.archived.length) {
      log(`[wake-session] ${reason}：绑定 ${result.bound.length}、归档 ${result.archived.length}（${[...result.bound, ...result.archived].join(', ')}）`);
    }
    for (const error of result.errors || []) log(`[wake-session] ${reason}失败：${error}`);
  }).catch((error) => log(`[wake-session] ${reason}异常：${error?.message ?? error}`));
}

function startWakeSessionReconcile() {
  try {
    fs.mkdirSync(WAKE_PLUGIN_STATE_DIR, { recursive: true });
    fs.watch(WAKE_PLUGIN_STATE_DIR, { persistent: false }, (eventType, filename) => {
      if (filename && filename !== 'sessions.json') return;
      if (wakeSessionReconcileTimer) clearTimeout(wakeSessionReconcileTimer);
      wakeSessionReconcileTimer = setTimeout(() => {
        wakeSessionReconcileTimer = null;
        reconcileWakeSessions('新唤醒会话');
      }, 400);
    }).on('error', (error) => log(`[wake-session] 监听失败：${error?.message ?? error}`));
    log(`[wake-session] 已监听 ${WAKE_PLUGIN_STATE_DIR}`);
  } catch (error) {
    log(`[wake-session] 无法监听 ${WAKE_PLUGIN_STATE_DIR}：${error?.message ?? error}`);
  }
  reconcileWakeSessions('启动');
}

const ROLE_STATE_FILE = path.join(STATE_DIR, 'current-role.json');
const SLANG_FILE = path.join(STATE_DIR, 'slang.json');
const SLANG_SESSION_FILE = path.join(STATE_DIR, 'slang-session.json');
const SIMULATION_FILE = path.join(STATE_DIR, 'simulation.json');
// 操作者为每个会话预写的「初始提示词」（见 main() 里的 initialPrompts）。
// 单独一个文件：它属于操作者配置，不能随 simulation.json 的会话状态一起被重置清掉。
const INITIAL_PROMPTS_FILE = path.join(STATE_DIR, 'initial-prompts.json');
const STICKER_FILE = path.join(STATE_DIR, 'stickers.json');
const FEEDBACK_FILE = path.join(STATE_DIR, 'feedback.json');
const TOOL_LOG_FILE = path.join(STATE_DIR, 'tool-calls.jsonl');
const TOKEN_USAGE_FILE = path.join(STATE_DIR, 'token-usage.jsonl');
const REMINDERS_FILE = path.join(STATE_DIR, 'reminders.json');
const OWNER_FEATURES_FILE = path.join(STATE_DIR, 'owner-features.json');
const SUBSCRIPTIONS_FILE = path.join(STATE_DIR, 'subscriptions.json');
const ESPORTS_SCHEDULE_FILE = path.join(STATE_DIR, 'esports-schedule.json');
const ESPORTS_BROADCAST_AUDIT_FILE = path.join(STATE_DIR, 'esports-broadcast-audit.jsonl');
const SIGNATURE_FILE = path.join(STATE_DIR, 'signature.json');
const BLACKLIST_FILE = path.join(STATE_DIR, 'blacklist.json');
const VOICE_STYLE_FILE = path.join(STATE_DIR, 'voice-style.json');
const ACTIVITY_LOG = path.join(STATE_DIR, 'qq-activity.log');
const BRIDGE_LOG = path.join(STATE_DIR, 'bridge.log');
// 通用图片库元数据（图片本体在 config 的 simulation.imageLibrary.dir，默认 <仓库>/state/images）。
const IMAGE_LIBRARY_DEFAULT_DIR = path.join('state', 'images');
const IMAGE_FILE = path.join(STATE_DIR, 'images.json');

/**
 * 模式拼写的**唯一**归一入口（输入边界）。
 *
 * `simulation` 是规范名（对用户只暴露 `closed-agent` / `simulation`）。
 * `chat` / `reserved` 是上游旧版仿真的历史拼写，只为已有配置能继续启动而保留；
 * 进程内部一律用规范名存储与比较，发送闸门、定时器与 preset 解析都只认 `simulation`。
 *
 * 历史教训：旧实现把输入别名折叠成另一套内部拼写，控制台提交规范名时会被静默忽略，
 * `currentMode` 保持上一次的值，`simulationToolEnabled` 之类的闸门不生效且没有日志。
 * 规范名与历史名必须在这里收敛成同一个内部值。
 */
const MODE_INPUT_ALIASES = Object.freeze({
  chat: 'chat',
  reserved: 'reserved',
  simulation: 'simulation',
  'closed-agent': 'closed-agent'
});
/** 内部合法模式集合（由别名表派生，避免"两份名单各自漂移"）。 */
const VALID_MODES = Object.freeze([...new Set(Object.values(MODE_INPUT_ALIASES))]);

/** 输入侧归一：返回内部拼写；无法识别返回 null，由调用方 fail-closed。 */
function normalizeModeInput(value) {
  if (typeof value !== 'string') return null;
  const key = value.trim();
  return Object.prototype.hasOwnProperty.call(MODE_INPUT_ALIASES, key) ? MODE_INPUT_ALIASES[key] : null;
}

/**
 * 从 DSH `settings.describe` 的一个命名空间里读某个键，**user 层优先、value 回退**。
 *
 * 为什么不能只读 `value`：DSH 0.2.0-rc.2 的 `settings/update` 写入的是 user 层
 * （profile patch 的显式 config），当次进程内 `describe().value`（取自插件 fiber 的
 * 运行配置）**不会更新**，要重启 DSH 才变。控制台切模式后 5 秒一次的 `refreshMode()`
 * 会读回旧 `value`，把刚选的模式改回去（issue #22，实测复现）。
 * 写哪读哪：`user` 里有显式值就用它，否则回退 `value`（从没写过时 `user` 是空对象，
 * 老行为不变；DSH 以后修好热更新也继续正确）。
 */
function settingFromDshNamespace(ns, key) {
  if (!ns || typeof ns !== 'object') return undefined;
  for (const layer of [ns.user, ns.value]) {
    if (!layer || typeof layer !== 'object' || Array.isArray(layer)) continue;
    if (Object.prototype.hasOwnProperty.call(layer, key) && layer[key] !== undefined) return layer[key];
  }
  return undefined;
}

// 读取 JSON 文件并容错（实现见 runtime/kernel/state-file.js，含 BOM 处理与 fail-fast）。
const readJsonSafe = coreReadJsonSafe;

/**
 * 读取 config.json，并保证拿到一个**可安全改写的普通对象**。
 *
 * 为什么不是 `readJsonSafe(file, null, true) ?? {}`：控制台这些端点都是
 * 「读整份 config → 改一个字段 → 原子写回」。JSON.parse 对字面量 `null` 是**成功**的，
 * 于是 `file` 可能是 null：`file.simulation` 直接 TypeError（保存接口 500，且错误信息
 * 完全指不出"配置文件顶层是 null"）；而用 `?? {}` 兜底更糟 —— 回写会把整份配置替换成
 * 只含本次提交字段的新对象，用户的白名单、令牌、模式全被抹掉。
 * 所以：不是普通对象就抛错，让调用方的 try/catch 返回 500（与各端点注释里
 * "配置文件损坏时直接 500，绝不回写" 的既有约定一致）。
 */
function readConfigObject(file) {
  const parsed = readJsonSafe(file, null, true);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    const kind = parsed === null ? 'null' : Array.isArray(parsed) ? '数组' : typeof parsed;
    throw new Error(`config.json 顶层不是对象（实际是 ${kind}），已拒绝改写以免覆盖整份配置：${file}`);
  }
  return parsed;
}

// 原子写与容错读取只有一套实现，见 runtime/kernel/state-file.js。
// 这里保留同名薄封装：调用点（约 40 处）不用改，上游 hunk 也还能照常合入。
const atomicWriteJson = coreAtomicWriteJson;
const atomicWriteText = coreAtomicWriteText;

// 配置写入的唯一入口：备份策略（每日一份 / 危险操作每次）+ 原子写 + 失败语义。
const configWriter = createConfigWriter({
  configFile: path.join(ROOT, 'config.json'),
  write: atomicWriteJson,
  log: (...args) => log(...args)
});

function writeConfigFile(next, options = {}) {
  return configWriter.write(next, options);
}

// 控制台鉴权 token：未配置时自动生成并持久化到 state/console-token，避免默认无鉴权。
function loadOrCreateConsoleToken() {
  const tokenFile = path.join(STATE_DIR, 'console-token');
  try {
    const existing = fs.readFileSync(tokenFile, 'utf8').trim();
    if (existing) return existing;
  } catch {}
  const token = crypto.randomBytes(24).toString('hex');
  atomicWriteText(tokenFile, token);
  return token;
}

/**
 * 收紧 state/ 的访问权限。
 *
 * **Windows 上 `mode: 0o600` 是空操作**（实测：chmod 之后 ACL 不变），文件继承父目录 ACL ——
 * 本机 state/console-token 实测为 `NT AUTHORITY\Authenticated Users:(M)`，也就是任何能登录
 * 这台机器的用户都能读走控制台令牌、Snowluma accessToken、各会话 agentToken 和全部 QQ 聊天记录。
 * 这里用 icacls 切断 state/ 的继承链，只保留「当前用户 + SYSTEM + Administrators」。
 *
 * ⚠️ 具体实现已抽到 `runtime/kernel/state-acl.mjs`（与 tools/harden-acl.mjs 共用同一份）。
 * 这里原本自带一份**会破坏数据**的实现：
 *   · `icacls DIR /inheritance:r /grant:r "u:(OI)(CI)F" /T` —— (OI)(CI) 是目录专用标志，
 *     套到 /T 展开的文件上会失败，而 /inheritance:r 已摘掉文件的继承 ACE，净结果是
 *     **子文件 DACL 被清空、连属主都读不了**（实测 state/ 下 50 个文件变空，桥接读不到
 *     自己的控制台令牌）；启动日志只报「未能收紧」，看不出已经造成破坏。
 *   · 回读自检用 `/\(I\)/` 扫全文，而 DSH 沙箱的 Low 完整性标签行永远带 (I) ——
 *     于是「已收紧」被误判成「未收紧」，**每次启动都重跑一遍那个破坏性命令**。
 * 两处逻辑各写一份正是漂移的根源，故合并。失败时不能只说"可能可读"就完事，
 * 要给出一条**安全**的可复制命令，并把结果回报到控制台（/api/security 的 stateDirHardened）。
 * 宁可明确报"没做成"，也不要假装已经安全。
 */
function hardenStateDirAcl() {
  const result = hardenDir(STATE_DIR);
  if (result.ok) {
    stateDirHardened = true;
    return;
  }
  stateDirHardened = false;
  if (process.platform !== 'win32') {
    log(`⚠️ 收紧 state/ 权限失败（chmod 700）：${result.detail}`);
    return;
  }
  log('⚠️ 未能收紧 state/ 目录权限：本机任何已登录用户都可能读到控制台令牌与 QQ 聊天记录。');
  log(`   原因：${String(result.detail).slice(0, 300)}`);
  log('   改 ACL 需要管理员权限。请用**管理员身份**打开终端后执行下面这几条命令（或在控制台「访问与安全」页点按钮）：');
  log(`   ${manualDirCommand(STATE_DIR)}`);
}

function readActivityTail(n) {
  try {
    const raw = fs.readFileSync(ACTIVITY_LOG, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    return lines.slice(-n).join('\n');
  } catch {
    return '';
  }
}

function listRoles() {
  try {
    return fs.readdirSync(path.join(ROOT, 'personas'))
      .filter((f) => f.endsWith('.md') && f !== 'README.md')
      .map((f) => f.slice(0, -3))
      .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  } catch {
    return [];
  }
}

// ── 人格文件读写 ────────────────────────────────────────────────────────────
// 人格提示词 = personas/<名称>.md，由桥接在每条消息前注入（热生效，无需重启 DSH）。
const ROLES_DIR = path.join(ROOT, 'personas');
const ROLE_NAME_MAX = 40;
const ROLE_CONTENT_MAX_BYTES = 64 * 1024;
// 注入上限：**按模式筛完小节之后**再截断，避免另一模式的专属内容白白占掉预算。
// 默认 10000，与 config.example.json / 控制台一致；仓库自带的「小鲸鱼」卡约 8000 字符，
// 用 6000 会在首次启动时被静默截断。可用 config.json 的 role.maxInjectChars 调整
// （1000~20000）；启动时由 applyRoleInjectLimit() 写入。
const ROLE_INJECT_MAX_CHARS_DEFAULT = 10000;
let roleInjectMaxChars = ROLE_INJECT_MAX_CHARS_DEFAULT;
function applyRoleInjectLimit(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return ROLE_INJECT_MAX_CHARS_DEFAULT;
  return Math.min(20000, Math.max(1000, Math.round(n)));
}
const ROLE_RESERVED_NAMES = new Set(['README']);
// Windows 保留设备名：personas/CON.md 这类路径会被系统当成设备而不是文件，
// 写入会失败甚至挂起，因此在人格名层面直接拒绝。
const WINDOWS_RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

function roleFilePath(name) {
  return path.join(ROLES_DIR, name + '.md');
}

function firstMeaningfulLine(content) {
  for (const line of String(content ?? '').split('\n')) {
    const t = line.replace(/^#+\s*/, '').replace(/^[-*]\s*/, '').trim();
    if (t) return t.slice(0, 80);
  }
  return '';
}

function roleWarnings(content, mode = 'simulation') {
  const text = String(content ?? '');
  const warnings = [];
  const stats = roleCharStats(text);
  const injected = mode === 'legacy' ? stats.legacy : stats.simulation;
  if (injected > roleInjectMaxChars) {
    warnings.push(`超出注入上限：当前模式实际注入 ${injected} 字符，只有前 ${roleInjectMaxChars} 字符会进入提示词（可在配置里调 role.maxInjectChars）`);
  }
  // 只在「没有用模式标记分开」的小节上提示兜底过滤，避免对已正确标记的卡片误报。
  const untagged = parseRoleSections(text)
    .filter((section) => section.mode === 'all')
    .map((section) => section.lines.join('\n'))
    .join('\n');
  if (LEGACY_ROLE_LINE_RE.test(untagged)) {
    warnings.push('未标记的小节里含旧版仿真专用指令（[SILENT] / 空格分句 / 自动转发…），仿真下这些行会被兜底过滤——建议把它们移到带 〔旧版〕 标记的小节里');
  }
  if (/回复示例/.test(untagged) && /[\u4e00-\u9fff]\s+[\u4e00-\u9fff]/.test(untagged)) {
    warnings.push('“回复示例”节里的中文空格会被自动改写成逗号（仿真不用空格分条），建议直接写逗号，或把该节标记为 〔旧版〕');
  }
  return warnings;
}

function roleSummaries() {
  return listRoles().map((name) => {
    const file = roleFilePath(name);
    try {
      const stat = fs.statSync(file);
      const content = fs.readFileSync(file, 'utf8');
      const stats = roleCharStats(content);
      return {
        name,
        custom: isCustomRoleName(name),
        bytes: stat.size,
        chars: content.length,
        lines: content.split('\n').length,
        mtime: stat.mtimeMs,
        excerpt: firstMeaningfulLine(content),
        // 两种模式各自实际会注入多少（已按 〔旧版〕/〔仿真〕 标记筛过）
        injectedLegacy: Math.min(stats.legacy, roleInjectMaxChars),
        injectedSimulation: Math.min(stats.simulation, roleInjectMaxChars),
        charsLegacy: stats.legacy,
        charsSimulation: stats.simulation,
        hasModeTags: stats.legacyOnly > 0 || stats.simulationOnly > 0,
        truncated: stats.legacy > roleInjectMaxChars || stats.simulation > roleInjectMaxChars,
        warnings: roleWarnings(content).length,
      };
    } catch {
      return { name, custom: isCustomRoleName(name), bytes: 0, chars: 0, lines: 0, mtime: 0, excerpt: '', injectedLegacy: 0, injectedSimulation: 0, charsLegacy: 0, charsSimulation: 0, hasModeTags: false, truncated: false, warnings: 0 };
    }
  });
}

function validateRoleName(raw) {
  const name = sanitizeRoleName(raw);
  if (!name) throw new Error('人格名不能为空（仅限中文 / 字母 / 数字 / 横线）');
  if (name.length > ROLE_NAME_MAX) throw new Error(`人格名过长（最多 ${ROLE_NAME_MAX} 字）`);
  if (ROLE_RESERVED_NAMES.has(name)) throw new Error(`「${name}」是保留名称`);
  if (WINDOWS_RESERVED_NAMES.has(name.toUpperCase())) throw new Error(`「${name}」是系统保留名称（Windows 设备名），请换一个`);
  return name;
}

function validateRoleContent(raw) {
  const content = String(raw ?? '').replace(/\r\n/g, '\n').trim();
  if (!content) throw new Error('人格内容不能为空');
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > ROLE_CONTENT_MAX_BYTES) {
    throw new Error(`人格内容过长（${(bytes / 1024).toFixed(1)} KB，上限 ${ROLE_CONTENT_MAX_BYTES / 1024} KB）`);
  }
  return content;
}

function readRoleContent(name) {
  return fs.readFileSync(roleFilePath(name), 'utf8');
}

function writeRoleContent(name, content) {
  fs.mkdirSync(ROLES_DIR, { recursive: true });
  atomicWriteText(roleFilePath(name), content + (content.endsWith('\n') ? '' : '\n'));
}

// ── 群聊仿真预设提示词（「仿真」层）────────────────────────────────────────
// 与「人格」层的边界：
//   仿真提示词 = 预设内置，规定 AI 怎么调工具、怎么参与群聊（行为与协议）
//   人格提示词 = personas/<名称>.md，规定 AI 是谁、什么性格（人设与语气）
// 仿真层改完需要重启 DSH 才生效（preset 由 DSH 在会话创建时装配）；
// 人格层由桥接每条消息注入，保存即生效。
// 两种模式各自有独立的预设提示词：旧版 qq-chat-legacy（空格分条 / [SILENT]，不随仓库发布），
// 群聊仿真 qq-chat（一切皆工具）。控制台可分别查看与修改。
const PRESET_NAMES = { legacy: 'qq-chat-legacy', simulation: 'qq-chat' };
const PRESET_BACKUP_DIR = path.join(STATE_DIR, 'preset-backups');
const PRESET_BACKUP_KEEP = 10;

/**
 * 控制台的 preset 参数校验：只接受本项目这两个预置名（缺省 = 仿真）。
 *
 * 为什么必须在拼路径**之前**校验：main() 里的 resolvePresetName() 在「DSH preset 清单为空」
 * （DSH 还没连上 / 正在启动）时会把调用方给的字符串**原样返回**。那四个 preset 控制台路由
 * 都拿它去 path.join(ROOT, 'integrations', 'dsh', 'presets', name, 'agent.cordis.yml')，
 * 于是 `preset=..\..\..\x` 会读写/备份 <x>/agent.cordis.yml，越出仓库。
 * 返回 null 由调用方回 400。
 */
function knownPresetName(raw) {
  const name = String(raw ?? '').trim();
  if (!name) return PRESET_NAMES.simulation;
  return Object.values(PRESET_NAMES).includes(name) ? name : null;
}

function presetSourceYaml(name) {
  return path.join(ROOT, 'integrations', 'dsh', 'presets', name, 'agent.cordis.yml');
}

function dshHomeDir() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function installedPresetYaml(name) {
  return path.join(dshHomeDir(), '.agent-presets', name, 'agent.cordis.yml');
}

// 这里**没有**模块级的 resolvePresetName —— 曾经有一个，但它被 main() 内部同名函数完全遮蔽
// （函数声明提升到 main 作用域，main 里所有调用点都落到内部那个），是纯死代码。
// 而且它的语义是错的：未知名字静默回退到 qq-chat，等于 fail-OPEN —— 一旦哪天有人把它
// "复活"成真正生效的实现，群聊会话就会在 preset 清单校验失败时照样建起来。
// 真正在用的那个（main() 内，带 strict 开关）在名字不可用时返回 '' 让调用方拒绝建会话。
// 同理不再保留 PRESET_NAME_SET：它只服务于那个死函数，留着只会诱惑下一个人去用它。

function readPresetPromptText(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) throw new Error(`找不到预设文件 ${path.relative(ROOT, file)}`);
  const text = fs.readFileSync(file, 'utf8');
  const prefix = extractPresetPrefix(text);
  if (prefix === null) throw new Error('预设里找不到 persona.prefix（结构可能已变化）');
  return { text, prefix };
}

// 备份文件名带上预设名：两个预设的主文件名都叫 agent.cordis.yml，
// 不加前缀会让「还原」列到另一个预设的备份。
function presetBackupPrefix(name) {
  return `${name}.${path.basename(presetSourceYaml(name))}`;
}

function backupPresetFile(name) {
  const file = presetSourceYaml(name);
  if (!fs.existsSync(file)) return null;
  fs.mkdirSync(PRESET_BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dest = path.join(PRESET_BACKUP_DIR, `${presetBackupPrefix(name)}.${stamp}`);
  fs.copyFileSync(file, dest);
  const prefix = presetBackupPrefix(name) + '.';
  const backups = fs.readdirSync(PRESET_BACKUP_DIR).filter((f) => f.startsWith(prefix)).sort();
  for (const stale of backups.slice(0, Math.max(0, backups.length - PRESET_BACKUP_KEEP))) {
    try { fs.rmSync(path.join(PRESET_BACKUP_DIR, stale)); } catch {}
  }
  return dest;
}

function listPresetBackups(name) {
  try {
    const prefix = presetBackupPrefix(name) + '.';
    return fs.readdirSync(PRESET_BACKUP_DIR)
      .filter((f) => f.startsWith(prefix))
      .sort().reverse()
      .map((f) => ({ file: f, mtime: fs.statSync(path.join(PRESET_BACKUP_DIR, f)).mtimeMs }));
  } catch {
    return [];
  }
}

function presetStatus(name) {
  // 只回传控制台需要的信息：不回传 DSH_HOME / 安装副本的绝对路径，减少无谓的信息暴露
  // （路径已经写在服务端日志里，排查时看日志即可）。
  return {
    preset: name,
    label: name === PRESET_NAMES.legacy ? '旧版仿真（qq-chat-legacy）' : '群聊剧场（qq-chat）',
    sourceFile: path.relative(ROOT, presetSourceYaml(name)),
    installed: fs.existsSync(installedPresetYaml(name)),
    requiresRestart: true,
  };
}

// 回复审计：agent 回复若命中以下特征（本机路径/凭据），硬性拦截不发送。
// 宁可误拦，不可泄露。
// 社交模式“静默标记”：模型输出该标记时，桥接不把内容发到 QQ。
// 用于让 AI 在“不想接话/潜水”时有合法沉默出口，而不是写“（内心戏）”被当成消息发出去。
const SILENT_MARKER = '[SILENT]';
function isSilentMarker(text) {
  return /^\s*\[SILENT\]\s*$/i.test(String(text ?? '').trim());
}

// DSH MCP 发送类工具：一旦 AI 在回合里调用过这些工具，说明消息已经由工具发出，
// 桥接应跳过该回合的自动转发，避免“工具发一条 + 自动转发一条”的重复。
const SEND_TOOL_RE = /^mcp__snowluma__qq_(send_group_message|send_private_message|reply|send_burst|send_message)$/;
function isSendToolName(name) {
  return SEND_TOOL_RE.test(String(name ?? ''));
}

// 分句规则提示：真人聊天不会主动用空格，因此空格被桥接当作“分条信号”。
// 中英文/数字之间的空格同样会分条，所以不想分条就不要加空格。
const SPACE_SPLIT_HINT = '想分多条消息时用空格分隔；不想分条就不要加空格，用标点连接。注意：中英文/数字之间的空格也会被当作分条信号。';
// 群聊指向性提示：引用/回复段表示“这句话是在对被引用的人说”，避免 AI 把群友之间的对话误当成指向自己。
const DIRECTION_HINT = '注意：消息里的 [引用 某人：...] 表示这句话是在回应被引用的人；引用的是你的消息才是在找你，引用别人时别默认是在找你。';

// 已知的仿真 agent token 集合：日志/活动/出站文本统一脱敏，防止令牌被模型泄露到 QQ。
const KNOWN_AGENT_TOKENS = new Set();

// 会话 → 该会话「当前代 + 上旧版」agentToken 的索引（见 rememberAgentToken）。
//
// 为什么必须有这份索引：retireSession() 每次轮换 token 都会把**新** token 塞进
// KNOWN_AGENT_TOKENS，而 reconcileSessionPolicies() 在**任何**策略变化（切模式、改白名单、
// preset 清单变动）时都会退役全部会话 —— 于是每切一次模式，每个会话就在集合里永久多留一个
// token，且只有 /reset、/api/session/reset、/api/simulation/reset 会删。集合只增不减，而
// redactSensitiveText()（每写一行日志）和 redactKnownTokensOnly()/onebotSend()（每条出站消息）
// 都要先复制整个集合再线性扫，长期运行后这两条热路径会被拖垮。
//
// 选择「按会话替换」而不是硬性 LRU 上限：硬上限在会话多的时候会淘汰掉**仍然有效**的 token，
// 那等于把活令牌漏到 QQ，属于削弱安全边界。按会话记账时集合大小 ≈ 会话数 × 2，且每个会话
// 一定保留当前代（活令牌必然可脱敏）与上旧版（模型上下文里最可能残留的那一个）；会话被删除
// 时用 forgetAgentToken() 整体摘除。第三代已经在两次轮换之前，不可能还在上下文里，直接丢弃。
const CONVERSATION_TOKENS = new Map();
const MAX_KNOWN_AGENT_TOKENS = 512;

/**
 * 记录某会话的当前 agentToken：丢掉它两种模式之前的旧 token，避免集合无界增长。
 * 另加一层上限兜底（防止异常路径下会话 key 无界增多），淘汰顺序是「先扔非活代」。
 */
function readVoiceStyleState() {
  const raw = readJsonSafe(VOICE_STYLE_FILE, {});
  const mode = ['auto', 'soft', 'dark'].includes(raw?.mode) ? raw.mode : 'auto';
  return {
    mode,
    autoDark: raw?.autoDark === true,
    updatedAt: Number(raw?.updatedAt) || 0,
    source: String(raw?.source || 'auto')
  };
}

function writeVoiceStyleState(state) {
  atomicWriteJson(VOICE_STYLE_FILE, {
    mode: ['auto', 'soft', 'dark'].includes(state.mode) ? state.mode : 'auto',
    autoDark: state.autoDark === true,
    updatedAt: Date.now(),
    source: String(state.source || 'owner')
  });
}

function voiceStyleSnapshot(cfg) {
  const state = readVoiceStyleState();
  let valence = 0.15;
  try {
    const persona = readJsonSafe(path.join(STATE_DIR, 'persona-state.json'), {});
    valence = Number(persona?.mood?.valence) || 0.15;
  } catch {}
  const effective = state.mode === 'auto' ? (state.autoDark ? 'dark' : 'soft') : state.mode;
  const breeze = cfg.tts?.breeze ?? {};
  const transport = {
    mode: breeze.preferOpus !== false && String(breeze.opusUrl || '').trim() ? 'opus' : 'pcm',
    bitrate: String(breeze.opusBitrate || '32k'),
    proxy: String(breeze.opusUrl || ''),
    normalize: cfg.simulation?.voice?.normalize === true,
    loudness: String(cfg.simulation?.voice?.loudness || 'normal')
  };
  return { ...state, valence, effective, transport };
}

// 心情曲线数据：Live 每 3 秒刷新，没必要每次重读整份 jsonl。
const moodHistoryCache = { at: 0, days: 0, data: [] };
function moodHistorySnapshot(days = 7, limit = 500) {
  if (Date.now() - moodHistoryCache.at < 5000 && moodHistoryCache.days === days) return moodHistoryCache.data;
  const file = path.join(STATE_DIR, 'persona-history.jsonl');
  const entries = readMoodHistory(file, { days, limit, now: Date.now() });
  const persona = normalizePersonaState(readJsonSafe(path.join(STATE_DIR, 'persona-state.json'), {}));
  const summary = summarizeMoodHistory(entries, { now: Date.now(), state: persona });
  const data = { entries, summary };
  moodHistoryCache.at = Date.now();
  moodHistoryCache.days = days;
  moodHistoryCache.data = data;
  return data;
}

function rememberAgentToken(key, token) {
  const tk = String(token ?? '');
  if (!tk) return;
  const prev = CONVERSATION_TOKENS.get(key);
  if (prev && prev[0] === tk) return;
  const next = prev ? [tk, prev[0]] : [tk];
  if (prev && prev[1]) KNOWN_AGENT_TOKENS.delete(prev[1]);
  CONVERSATION_TOKENS.set(key, next);
  KNOWN_AGENT_TOKENS.add(tk);
  if (KNOWN_AGENT_TOKENS.size > MAX_KNOWN_AGENT_TOKENS) {
    // 只淘汰已经不属于任何会话**当前代**的 token（即更早的旧代）。
    // 当前代一个都不能丢：脱敏漏掉活令牌就是把令牌发到 QQ，比内存占用严重得多。
    const live = new Set([...CONVERSATION_TOKENS.values()].map((pair) => pair[0]));
    for (const old of [...KNOWN_AGENT_TOKENS]) {
      if (KNOWN_AGENT_TOKENS.size <= MAX_KNOWN_AGENT_TOKENS) break;
      if (!live.has(old)) KNOWN_AGENT_TOKENS.delete(old);
    }
  }
}

/** 会话被彻底移除（重置/清空工作区/退订）时，连同它的 token 一起从脱敏集合摘掉。 */
function forgetAgentToken(key) {
  const prev = CONVERSATION_TOKENS.get(key);
  if (!prev) return;
  for (const tk of prev) KNOWN_AGENT_TOKENS.delete(tk);
  CONVERSATION_TOKENS.delete(key);
}

// 读取 DSH 模型能力的在途 Promise：withTimeout 只做 Promise.race，不会取消底层 RPC，
// 因此并发刷新会各自留下一个不可取消的请求。这里做去重，同一时刻只发一个。
let modelCatalogInFlight = null;
// DSH 思考强度（reasoningEffort）热切换代号。
// 控制台改强度后递增它，让已在运行的会话在下一条消息重新 selectModel；
// 放在模块级是为了不依赖 main() 内部声明的执行顺序（避免 TDZ）。
let modelSelectionEpoch = 0;
// 自定义 provider（如 chat-anywhere 中转）可能一个 reasoning effort 档位都不声明：
// 带上该参数会直接 model-unavailable。一旦探明不支持，之后所有会话都不再传。
let reasoningEffortUnsupported = false;
// DeepSeek provider 明确支持的取值（见 dsh-llm-deepseek：其它值会抛 UNSUPPORTED_REASONING_EFFORT）。
// 'off' 虽然合法（关闭思考），但 QQ 聊天助手依赖思考，控制台不提供该档。
const REASONING_EFFORT_OPTIONS = ['low', 'high', 'max'];
const REASONING_EFFORT_DEFAULT = 'max';
function normalizeReasoningEffort(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!REASONING_EFFORT_OPTIONS.includes(v)) {
    throw new Error(`思考强度只能是 ${REASONING_EFFORT_OPTIONS.join(' / ')}`);
  }
  return v;
}

// 敏感文本脱敏：把 SENSITIVE_RE 命中的片段替换为 ***，供日志/反馈/活动记录写入前使用。
// SENSITIVE_RE 未带 g 标志，这里动态补 g 以替换所有命中片段。
function redactSensitiveText(text) {
  let raw = String(text ?? '');
  try {
    const flags = SENSITIVE_RE.flags.includes('g') ? SENSITIVE_RE.flags : SENSITIVE_RE.flags + 'g';
    raw = raw.replace(new RegExp(SENSITIVE_RE.source, flags), '***');
  } catch {}
  for (const token of KNOWN_AGENT_TOKENS) {
    if (token && raw.includes(token)) raw = raw.split(token).join('***');
  }
  return raw;
}

// 防止底层网关把文本中的 [CQ: 当作 CQ 码解析：替换为全角冒号。
function escapeCqText(text) {
  return String(text ?? '').replace(/\[CQ:/gi, '[CQ：');
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// QQ 活动日志：每次收发都追加一行，供 WebUI 侧 agent 汇报 QQ 动态。
const appendActivityLog = createCappedLogger(ACTIVITY_LOG, 500);
function appendActivity(line) {
  // 本地时间：此前用 toISOString() 写的是 UTC，日志时间与本地时间差 8 小时，排查时对不上。
  appendActivityLog(`[${localClock()}] ${redactSensitiveText(String(line).replace(/[\r\n]+/g, ' '))}\n`);
}

// 默认角色 = 没设角色，或显式选了内置的「小鲸鱼」。只有默认角色才保留写死的人格内核；
// 自定义角色的人格必须完全来自角色卡，否则每轮注入的内核会盖掉用户自己写的人格。
// 判定统一来自 runtime/persona/style-context.js，避免各模块各写一份。
// 读取角色/模式状态：{"role": "小鲸鱼", "mode": "active"|"silent"}
// 状态文件不存在时默认启用自带角色；显式清除会写入 role:null，不会被这里的兜底覆盖。
// 没有自带角色卡（用户删掉了）则保持无角色，避免凭空注入人格内核。
function readRoleState() {
  const fallbackRole = fs.existsSync(roleFilePath(DEFAULT_ROLE_NAME)) ? DEFAULT_ROLE_NAME : null;
  return readJsonSafe(ROLE_STATE_FILE, { role: fallbackRole, mode: 'active' });
}
function writeRoleState(role, mode) {
  atomicWriteJson(ROLE_STATE_FILE, { role: role ?? null, mode: mode ?? 'active' });
}
function currentRoleName() {
  return String(readRoleState().role || '').trim();
}
function sanitizeRoleName(name) {
  return String(name ?? '').replace(/[^\w\u4e00-\u9fff-]/g, '');
}
// qq_get_prompt 会把推荐唤醒关键词一起给模型；自定义角色下不能继续推荐默认角色名。
const DEFAULT_PERSONA_WAKE_KEYWORDS = new Set(['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1']);
// 大小写归一后的同一份默认人格词表：昵称/旧昵称过滤、AI 身份判定、默认词识别都从这里派生。
const DEFAULT_PERSONA_WAKE_KEYWORDS_LOWER = new Set([...DEFAULT_PERSONA_WAKE_KEYWORDS].map((word) => String(word).trim().toLowerCase()));
// 与 config.example.json 逐字一致：默认安装复制示例后，不能被当成“用户显式配置”。
const EXAMPLE_MUST_REPLY_KEYWORDS = ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'];
const EXAMPLE_WAKE_KEYWORDS = ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'];
// 配置文件里是否显式写了关键词。未显式写（或与示例默认值完全相同）时，自定义角色才用角色名/别名/中性词兜底。
let socialKeywordsExplicit = false;
let wakeKeywordsExplicit = false;
function keywordList(value) {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === 'string') return value.split(/[,，\s]+/).map(String).filter(Boolean);
  return null;
}
function sameKeywordList(list, example) {
  if (!Array.isArray(list) || list.length !== example.length) return false;
  return list.every((word, index) => String(word) === example[index]);
}
function isExplicitKeywordConfig(value, example) {
  if (value === undefined) return false;
  const list = keywordList(value);
  if (!list) return true;
  return !sameKeywordList(list, example);
}
function roleAwareRecommendations(recommended, { custom = false, roleName = '', fallbackKeywords = [] } = {}) {
  if (!custom || wakeKeywordsExplicit || !recommended) return recommended;
  const source = Array.isArray(recommended.wake?.recommendedKeywords) ? recommended.wake.recommendedKeywords : [];
  const kept = source.filter((word) => !DEFAULT_PERSONA_WAKE_KEYWORDS_LOWER.has(String(word ?? '').trim().toLowerCase()));
  const keywords = fallbackKeywords.length ? fallbackKeywords : [...new Set([roleName, ...kept].filter(Boolean))];
  const wake = recommended.wake && typeof recommended.wake === 'object'
    ? { ...recommended.wake, recommendedKeywords: keywords }
    : recommended.wake;
  return { ...recommended, wake };
}

// 管理员 QQ（ownerQQ）规范化：空值=未设置；必须是正整数 QQ 号。
function normalizeOwnerQQ(value) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (!/^\d+$/.test(s)) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  const n = Number(s);
  if (!Number.isSafeInteger(n) || n <= 0) throw new Error('ownerQQ 必须是 QQ 号（正整数）');
  return n;
}

// 白名单/黑名单值规范化：只接受字符串或数字数组，非数组按空列表处理（fail-closed 语义由调用方决定）。
function normalizeIdList(value) {
  if (!Array.isArray(value)) return [];
  return value.map((v) => String(v).trim()).filter((v) => /^\d+$/.test(v));
}

// ── 配置 ────────────────────────────────────────────────────────────────────
function loadConfig() {
  const p = path.join(ROOT, 'config.json');
  // 缺失/损坏都走同一条可操作的提示，避免启动日志只甩一个 ENOENT 堆栈。
  const file = readJsonSafe(p, null);
  if (!file || typeof file !== 'object' || Array.isArray(file)) {
    throw new Error(`配置格式错误：${p} 不存在或不是有效的 JSON 对象。\n请先复制 config.example.json 为 config.json（Windows 可用 copy config.example.json config.json），再填写 ownerQQ、allow 白名单与 SnowLuma 地址。`);
  }
  socialKeywordsExplicit = isExplicitKeywordConfig(file.social?.mustReplyKeywords, EXAMPLE_MUST_REPLY_KEYWORDS);
  wakeKeywordsExplicit = isExplicitKeywordConfig(file.simulation?.wake?.recommendedKeywords, EXAMPLE_WAKE_KEYWORDS);
  const cfg = {
    dsh: {
      baseUrl: 'http://127.0.0.1:3080',
      provider: 'deepseek-official',
      // 多模态模型：DeepSeek-V41-Flash（DSH 模型目录里 inputModalities 含 image）。
      // 旧默认 deepseek-v4-flash-vision-exp 已被取代；config.json 未配置时用此兜底。
      model: 'deepseek-flash',
      reasoningEffort: 'max',
      // 兼容新版 DSH 的 API 鉴权：如果 DSH 升级后要求非浏览器客户端带 token，
      // 在这里配置 token；默认走 Authorization: Bearer <token>。
      authToken: '',
      authHeader: 'authorization',
      authPrefix: 'Bearer',
      // 是否允许把 DSH launch token 发往非回环地址（默认 false：那是进程启动凭据）
      allowRemote: false,
      ...(file.dsh ?? {})
    },
    snowluma: { wsUrl: 'ws://127.0.0.1:3001', accessToken: '', ...(file.snowluma ?? {}) },
    // 空 => 每个会话在 state/agents/<key> 下建独立工作目录
    sessionCwd: file.sessionCwd ?? '',
    agentPreset: file.agentPreset ?? 'qq-chat-legacy',
    workspaceTitle: file.workspaceTitle ?? 'QQ 聊天',
    ownerQQ: normalizeOwnerQQ(file.ownerQQ),
    allow: {
      private: normalizeIdList(file.allow?.private ?? file.allow?.privates ?? []),
      groups: normalizeIdList(file.allow?.groups ?? file.allow?.group ?? [])
    },
    deny: {
      private: normalizeIdList(file.deny?.private ?? file.deny?.privates ?? []),
      groups: normalizeIdList(file.deny?.groups ?? file.deny?.group ?? [])
    },
    // 私聊/群聊均未配置白名单时是否放行所有（true 时启动会打警告）
    allowAllWhenEmpty: file.allowAllWhenEmpty === true,
    ackMessage: file.ackMessage ?? '🤔 收到，正在思考…',
    sendDelayMs: file.sendDelayMs ?? 300,
    questionTimeoutMs: file.questionTimeoutMs ?? 5 * 60 * 1000,
    consolePort: file.consolePort ?? 3100,
    consoleToken: file.consoleToken ?? '',
    // 局域网访问：默认关闭（只监听回环）。开启后监听所有网卡并强制令牌鉴权，重启生效。
    consoleLanAccess: file.consoleLanAccess === true,
    // 价目表覆盖项（可选）。留空即用 services/social/model-prices.js 的官方默认价。
    pricing: file.pricing ?? null,
    security: {
      interceptNotify: true,
      ...(file.security ?? {})
    },
    slang: {
      enabled: true,
      extractMinMessages: 10,
      extractCooldownMs: 5 * 60 * 1000,
      inferenceThresholds: [2, 4, 8],
      injectMax: 8,
      learnerPreset: 'qq-chat',
      workspaceTitle: 'QQ 黑话学习',
      autoResearch: true,
      ...(file.slang ?? {})
    },
    social: {
      enabled: true,
      // 启动阶段（观望）
      triggerProbability: 0.1,        // 普通消息触发进入活跃的概率
      contextWindow: 20,              // 触发/活跃回复时附带的上下文条数
      // 活跃阶段（对话进行中）
      activeCheckMinMs: 10 * 1000,    // 活跃期检测间隔范围（当前控制台保存值）
      activeCheckMaxMs: 30 * 1000,
      activeReplyDelayMinMs: 2 * 1000, // 活跃期回复延迟范围（当前控制台保存值）
      activeReplyDelayMaxMs: 8 * 1000,
      // 活跃超时主动退出（防止活跃群中一直保持活跃）
      activeDurationEnabled: true,     // 总开关：是否启用“活跃超过时长后主动收尾退场”
      activeDurationMinMs: 15 * 60 * 1000, // 活跃状态最长持续时间下限（进入活跃那一刻起算，分钟）
      activeDurationMaxMs: 30 * 60 * 1000, // 活跃状态最长持续时间上限（分钟）
      // 冷场处理
      idleWindowMs: 6 * 60 * 1000,    // 活跃期多久没人说话算冷场
      idleRetryProbability: 0.25,     // 冷场时 AI 继续说一句（试探群友意愿）的概率
      idleRetryWaitMs: 2 * 60 * 1000, // 试探后等待回应的窗口，仍无人说话则 100% 回观望
      // 二期：观望阶段主动开话题（第三种触发）
      proactiveEnabled: true,         // 总开关
      proactiveIdleThresholdMs: 30 * 60 * 1000, // 群安静多久才进入可判定状态
      proactiveCheckMinMs: 45 * 60 * 1000,      // 判定间隔范围
      proactiveCheckMaxMs: 90 * 60 * 1000,
      proactiveProbability: 0.2,      // 每次判定的成功概率（小概率开口）
      // 选择性沉默/退让
      skipProbability: 0.15,          // 普通闲聊沉默概率（当前控制台保存值）
      surrenderProbability: 0,        // 已弃用：桥接不再直接生成退让短句（避免割裂），保留字段兼容旧配置
      // 摘要与展示
      maxReplyChars: 500,             // 单条 QQ 消息安全长度上限（防 AI 出 bug；分句交给 AI 用空格控制）
      mustReplyKeywords: ['deepseek', '小鲸鱼', '大肥鱼', '鲸鱼', 'd指导', '在吗'],
      // 真人式多消息分条发送：按空格分句，AI 用空格表示“这里要分成下一条”
      burstEnabled: true,             // 总开关：是否允许按空格拆成多条 QQ 消息
      burstIntervalMinMs: 1000,       // 条间随机间隔下限（毫秒）
      burstIntervalMaxMs: 3000,       // 条间随机间隔上限（毫秒）
      longGapProbability: 0.1,        // 长间隔概率（当前控制台保存值）
      longGapMinMs: 2500,             // 长间隔下限（当前控制台保存值）
      longGapMaxMs: 5000,             // 长间隔上限（当前控制台保存值）
      ...(file.social ?? {})
    },
    simulation: {
      enabled: true,
      autoReplyCheckMs: 30000,
      agentPreset: 'qq-chat',
      provideRecommendations: true,
      tools: {
        getPrompt: true,
        getUnread: true,
        getRecent: true,
        socialState: true,
        sendGroup: true,
        sendPrivate: true,
        reply: true,
        sendBurst: true,
        sendMessage: true,
        waitMessages: true,
        feedback: true,
        getMyRecent: true,
        getMessageDetail: true,
        getActiveMembers: true,
        setWakeConfig: true,
        markRead: true,
        memory: true,
        getImages: true,
        getForwardMsg: true,
        sendPoke: true,
        listStickers: true,
        getStickerImage: true,
        sendSticker: true,
        setStickerRemark: false,
        stickerNote: true,
        collectSticker: true,
        deleteSticker: true,
        deleteImage: true,
        getSelfImage: true
      },
      wake: {
        defaultMode: 'diving',
        preSleepWaitEnabled: true,      // 沉睡前强制观察窗口开关：防止 AI 聊两句就潜水
        preSleepWaitMs: 60000,           // 默认沉睡前至少等待/观察 1 分钟（后台可调）
        recommendedDefaultInfinite: true, // 默认下一次唤醒是否无限期（true=永久潜水等条件；false=有限时长）
        sleepMinMs: 60000,
        sleepMaxMs: 0,
        recommendedSleepMinMs: 300000,
        recommendedSleepMaxMs: 7200000,
        recommendedProbability: 0.05,
        recommendedKeywords: ['小鲸鱼', 'DeepSeek', 'deepseek', 'DS', 'D老师', 'd老师', 'D指导', 'd指导', 'D师傅', 'd师傅', '深度求索', '大肥鱼', '鲸鱼', 'DeepSeek V3', 'DeepSeek R1', 'R1'],
        recommendedAtMention: true,
        recommendedNameMention: true,
        recommendedQuestion: true,
        recommendedPoke: true,
        recommendedHint: '如果你要潜水，推荐先调用 qq_wait_for_messages(timeoutMs=60000) 完成一次沉睡前观察：1 分钟内没人说话就可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看 newMessages，判断不需要你参与可直接沉睡，若参与了则下次想睡需再等观察窗口。潜水时长推荐 5~120 分钟，普通消息概率 0.05；@/名字/关键词/提问唤醒建议保持开启。需要等特定某人/某几人时，可额外设置 triggers.speakerIds。',
        batchWindowMs: 8000,
        maxWakePerMinute: 1,
        maxWakePerHour: 12,
        noActionLimit: 3,
        maxWakeConfigReminders: 2
      },
      activityControl: {
        deepDive: false                  // 深潜：群聊里只允许主人直接 @ 触发回复
      },
      send: {
        burstEnabled: true,
        burstMaxMessages: 8,
        burstIntervalMinMs: 1000,
        burstIntervalMaxMs: 3000,
        longGapProbability: 0.2,
        longGapMinMs: 5000,
        longGapMaxMs: 10000,
        maxSendPerMinute: 12,
        maxSendPerHour: 120,
        maxMessageChars: 500,
        maxGapMs: 10000,
        gapBaseMs: 800,
        gapPerCharMs: 20,
        recommendedHint: '普通闲聊建议一次 1~3 条，条间 1~3 秒；讲故事/回忆可以 5~10 秒间隔；不要连续刷屏。'
      },
      wait: {
        defaultMs: 30000,
        minMs: 5000,
        maxMs: 600000,
        defaultQuietMs: 8000,
        minQuietAfterNewMs: 10000   // 收到新消息后至少再等这么久（默认 10 秒），防止抢话
      },
      sticker: {
        enabled: true,             // 表情包体系总开关
        syncTtlMs: 60000,          // QQ 收藏表情刷新缓存 TTL（毫秒）
        maxListCount: 100,         // qq_list_stickers 单次最大返回数
        includeInPrompt: true,     // 是否在 qq_get_prompt / 唤醒提示里附带表情摘要与策略
        promptMaxStickers: 12,     // 提示里最多列出的候选表情数（常用几张 + 其余轮换）
        collect: {
          enabled: true,           // AI 收藏他人表情总开关
          maxPerMinute: 10,        // 每分钟最多收藏次数
          maxPerHour: 60,          // 每小时最多收藏次数
          maxRemarkChars: 20       // 收藏时备注最大长度
        }
      },
      proactive: {
        enabled: true,
        checkIntervalMinMs: 30 * 60 * 1000,
        checkIntervalMaxMs: 90 * 60 * 1000,
        idleThresholdMs: 15 * 60 * 1000,
        probability: 0.3
      },
      feedback: {
        maxLength: 500,
        notifyOwnerOnError: false
      },
      context: {
        recentLimit: 100,
        unreadLimit: 30,
        contextWindow: 20,
        inlineWakeMessages: true,
        wakeMessageLimit: 12,
        wakeRecentLimit: 4,
        wakeMaxChars: 6000
      },
      // 操作者在控制台为单个会话预写的「初始提示词」的字数上限（只在首次唤醒时注入一次）。
      // 它不是安全边界，只是防止误粘贴一篇长文把首次唤醒的 prompt 撑爆。
      initialPromptMaxChars: 2000,
      // 图片/表情（含动图）的数量与体积上限。QQ 的动图表情常见 1~4MB，
      // 旧的 4MB 单条总上限会误伤；这里默认 8MB，仍受 DSH 的 20MB/64MP 限制约束。
      media: {
        maxBytes: 8 * 1024 * 1024,
        maxPixels: 64_000_000,
        maxCount: 5
      },
      // 控制面分层（见 docs/CONTROL-TIERS-PLAN-2026-10-30.md）：
      // 主人在群里说的低风险指令允许跨会话；高危动作一律回私聊并二次确认。
      controlTiers: {
        enabled: true,
        ownerDirectiveTtlMs: 10 * 60 * 1000,
        groupEscalationNotify: true,
        requireConfirmForHighRisk: true
      },
      ...(file.simulation ?? {})
    }
  };

  // simulation.tools 需要与默认值深度合并：旧 config.json 若缺少新增工具开关，
  // 不能因为外层 spread 覆盖而丢失默认开关。
  cfg.simulation.tools = {
    getPrompt: true,
    getUnread: true,
    getRecent: true,
    socialState: true,
    sendGroup: true,
    sendPrivate: true,
    reply: true,
    sendBurst: true,
    sendMessage: true,
    waitMessages: true,
    feedback: true,
    getMyRecent: true,
    getMessageDetail: true,
    getActiveMembers: true,
    setWakeConfig: true,
    markRead: true,
    memory: true,
    slangQuery: true,
    slangSubmit: true,
    getImages: true,
    getForwardMsg: true,
    sendPoke: true,
    listStickers: true,
    getStickerImage: true,
    sendSticker: true,
    setStickerRemark: false,
    stickerNote: true,
    collectSticker: true,
    deleteSticker: true,
    getSelfImage: true,
    listImages: true,
    sendImage: true,
    saveImage: true,
    deleteImage: true,
    sendVoice: false,
    ...(cfg.simulation.tools ?? {})
  };

  // simulation.voice：语音发送（把准备好的音频文件当 QQ 语音发出去）。
  // dir 为相对仓库根目录的语音库路径；AI 的 qq_send_voice 默认只能从这个目录取文件，
  // 绝对路径需要显式开 allowAbsolutePath（默认关，避免 prompt injection 读到任意本地文件）。
  //
  // 默认**关闭**（enabled/sendVoice 均为 false）：语音是"开口说话"的强表达，且需要你先准备好
  // 语音库内容。没放音频就让 AI 发语音只会得到一串错误。把音频放进 audio/ 后，
  // 在控制台「群聊仿真 → 语音库与语音发送」里打开开关即可。
  cfg.simulation.voice = {
    enabled: false,
    dir: 'audio',
    maxSeconds: 300,
    maxBytes: 20 * 1024 * 1024,
    maxPerMinute: 6,
    maxPerHour: 60,
    allowAbsolutePath: false,
    // 音量：默认倍数（1 = 原样）+ 智能音量档位 + ffmpeg 位置（空 = 走 PATH）。
    // SnowLuma 的 record 段没有增益字段，所以音量必须在本地先调好再发。
    defaultVolume: 1,
    normalize: false,
    loudness: 'normal',
    ffmpegPath: '',
    autoReadback: true,
    ...(cfg.simulation?.voice ?? {})
  };

  // simulation.sticker.collect 也需要深度合并，避免旧配置缺失 collect 子项时丢默认值。
  cfg.simulation.sticker = {
    enabled: true,
    syncTtlMs: 60000,
    maxListCount: 100,
    includeInPrompt: true,
    promptMaxStickers: 12,
    collect: {
      enabled: true,
      maxPerMinute: 10,
      maxPerHour: 60,
      maxRemarkChars: 20,
      maxBytes: 3932160,
      compress: false,
      pythonPath: '',
      shrinkScriptPath: '',
      ...((cfg.simulation?.sticker?.collect) ?? {})
    },
    ...(cfg.simulation?.sticker ?? {}),
    collect: {
      enabled: true,
      maxPerMinute: 10,
      maxPerHour: 60,
      maxRemarkChars: 20,
      maxBytes: 3932160,
      compress: false,
      pythonPath: '',
      shrinkScriptPath: '',
      ...((cfg.simulation?.sticker?.collect) ?? {})
    }
  };

  // 像素贴纸：说完一句话顺手丢一张透明像素贴纸；频率与表情包共用同一套计数/间隔。
  cfg.simulation.pixelSticker = {
    enabled: true,
    afterText: true,
    minTextsSince: 2,
    minGapMs: 20 * 60 * 1000,
    ...(cfg.simulation?.pixelSticker ?? {})
  };
  // 心情语音：主动、状态匹配、节奏适中（不是每天只一条，也不是天天一堆）。
  // 默认目标走配置（targets 为空时回退到 ownerQQ 占位），不硬编码任何真实号码。
  cfg.simulation.moodVoice = {
    enabled: true,
    maxPerDay: MOOD_VOICE_DEFAULTS.maxPerDay,
    minGapMs: MOOD_VOICE_DEFAULTS.minGapMs,
    skipChance: MOOD_VOICE_DEFAULTS.skipChance,
    intervalMs: 30 * 60 * 1000,
    targets: [],
    ...(cfg.simulation?.moodVoice ?? {})
  };

  // simulation.media：图片/表情的数量与体积上限。旧配置没有这一段，必须深度合并出默认值，
  // 否则 `{...defaults, ...file.simulation}` 里缺失的 media 会取到 undefined（等于无上限判断）。
  cfg.simulation.media = {
    maxBytes: 8 * 1024 * 1024,
    maxPixels: 64_000_000,
    maxCount: 5,
    ...((cfg.simulation?.media && typeof cfg.simulation.media === 'object' && !Array.isArray(cfg.simulation.media)) ? cfg.simulation.media : {})
  };

  // simulation.imageLibrary：通用图片库（网上找的图/截图/二创表情），与 QQ 收藏表情库分开。
  // 默认放 state/images（已随 state/ 忽略，不会误提交），可用绝对路径改到大容量磁盘；元数据在 state/images.json。
  cfg.simulation.imageLibrary = {
    enabled: true,
    dir: IMAGE_LIBRARY_DEFAULT_DIR,
    maxBytes: 20 * 1024 * 1024,
    allowUrlSave: true,
    includeInPrompt: true,
    promptMaxImages: 8,
    ...((cfg.simulation?.imageLibrary && typeof cfg.simulation.imageLibrary === 'object' && !Array.isArray(cfg.simulation.imageLibrary)) ? cfg.simulation.imageLibrary : {})
  };

  // simulation.esportsFeed：电竞实时资讯（直播吧）。只抓公开只读页面，不自动发言。
  cfg.simulation.esportsFeed = {
    enabled: true,
    refreshMs: 300000,
    maxItems: 12,
    summaryMaxChars: 1400,
    ...((cfg.simulation?.esportsFeed && typeof cfg.simulation.esportsFeed === 'object' && !Array.isArray(cfg.simulation.esportsFeed)) ? cfg.simulation.esportsFeed : {})
  };

  // simulation.outerWorld：出门见闻（读书线 + 视频字幕线）。默认全关；运行期每次调度重新读 cfg。
  {
    const ow = cfg.simulation?.outerWorld && typeof cfg.simulation.outerWorld === 'object' && !Array.isArray(cfg.simulation.outerWorld)
      ? cfg.simulation.outerWorld
      : {};
    const at = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
    const schedule = at(ow.schedule);
    cfg.simulation.outerWorld = {
      leisure: { enabled: false, sources: [], maxItemsPerDay: 2, noteChars: 600, digestChars: 6000, tokenBudget: 60000, ytDlpPath: '', subtitleLang: 'zh-Hans', subtitleTimeoutMs: 60000, ...at(ow.leisure) },
      browse: { enabled: false, policy: 'public', allowlist: [], blockedDomains: [], maxSteps: 8, snapshotChars: 1000, readOnly: true, ...at(ow.browse) },
      digest: { enabled: false, pushToOwner: false, mentionPolicy: 'natural', ...at(ow.digest) },
      schedule: {
        minGapMs: 7200000,
        ...schedule,
        window: { start: '09:00', end: '23:00', idleOnly: true, ...at(schedule.window) }
      }
    };
  }

  // simulation.reminders：提醒默认只在主人私聊和家人群可用，避免变成陌生群的定时闹钟。
  cfg.simulation.reminders = {
    enabled: true,
    allowedKeys: [],
    maxActive: 100,
    maxPerDayPerKey: 5,
    overdueGraceMs: 6 * 3600 * 1000,
    ...((cfg.simulation?.reminders && typeof cfg.simulation.reminders === 'object' && !Array.isArray(cfg.simulation.reminders)) ? cfg.simulation.reminders : {})
  };

  cfg.simulation.weather = {
    enabled: true,
    defaultCity: '',
    timeoutMs: 15000,
    ...((cfg.simulation?.weather && typeof cfg.simulation.weather === 'object' && !Array.isArray(cfg.simulation.weather)) ? cfg.simulation.weather : {})
  };

  // simulation.subscriptions：主动订阅播报。默认空，由 config.json 显式开启。
  if (!Array.isArray(cfg.simulation.subscriptions)) cfg.simulation.subscriptions = [];

  // ── Stage 2：上下文预算 / 价值评分 / 分层记忆 / 模型路由 ─────────────────
  // 上下文旋转：单会话 input token 超过阈值时，归档旧会话并注入本地衔接摘要。
  // 0 = 关闭。默认 120k：线上 140k 的会话会在下一次唤醒时被旋转，单轮输入回落到几千。
  cfg.simulation.context = {
    ...(cfg.simulation.context ?? {}),
    wakeBudgetTokens: Math.min(20000, Math.max(300, Number(cfg.simulation?.context?.wakeBudgetTokens) || 5000)),
    rotateAtTokens: Math.max(0, Math.min(500000, Number(cfg.simulation?.context?.rotateAtTokens ?? 120000))),
    digestMaxChars: Math.min(4000, Math.max(300, Number(cfg.simulation?.context?.digestMaxChars) || 1500))
  };
  cfg.simulation.valueScore = {
    ...VALUE_SCORE_DEFAULTS,
    ...(
      cfg.simulation?.valueScore && typeof cfg.simulation.valueScore === 'object' && !Array.isArray(cfg.simulation.valueScore)
        ? cfg.simulation.valueScore
        : {}
    )
  };
  cfg.simulation.memory = {
    enabled: true,
    topK: 6,
    maxChars: 800,
    minConfidence: 0.5,
    ...(
      cfg.simulation?.memory && typeof cfg.simulation.memory === 'object' && !Array.isArray(cfg.simulation.memory)
        ? cfg.simulation.memory
        : {}
    )
  };
  // 群日报：默认关闭，按群开启（groups 列表或 groupProfiles[key].dailyReport=true）。
  cfg.simulation.dailyReport = {
    enabled: false,
    at: '21:30',
    groups: [],
    maxItems: 8,
    ...(
      cfg.simulation?.dailyReport && typeof cfg.simulation.dailyReport === 'object' && !Array.isArray(cfg.simulation.dailyReport)
        ? cfg.simulation.dailyReport
        : {}
    )
  };
  // 语音转写（ASR）：默认关闭。开启后，收到的语音会在消息文本后附加 [语音转写]。
  cfg.simulation.speech = {
    asr: {
      enabled: false,
      provider: 'snowluma',
      timeoutMs: 15000,
      cacheTtlMs: 3600000,
      ...((cfg.simulation?.speech && typeof cfg.simulation.speech === 'object' && !Array.isArray(cfg.simulation.speech)
        ? cfg.simulation.speech.asr : null) ?? {})
    }
  };
  cfg.routing = {
    enabled: true,
    tiers: {},
    fallback: [],
    ...(file.routing && typeof file.routing === 'object' && !Array.isArray(file.routing) ? file.routing : {})
  };
  cfg.features = normalizeFeatureConfig(file.features);
  cfg.transport = {
    kind: 'snowluma',
    ...(file.transport && typeof file.transport === 'object' && !Array.isArray(file.transport) ? file.transport : {})
  };
  // 控制台鉴权：默认关闭（仅本机回环 + Host/CSRF 防护）；需要时可显式打开。
  cfg.consoleAuth = {
    enabled: false,
    ...(file.consoleAuth && typeof file.consoleAuth === 'object' && !Array.isArray(file.consoleAuth) ? file.consoleAuth : {})
  };
  // 预算：0 = 不限。默认关闭；开启后只压制非显式唤醒（@/引用/私聊/提问/关键词仍会回）。
  cfg.simulation.budget = {
    enabled: false,
    dailyTokensPerKey: 0,
    dailyTokensGlobal: 0,
    blockNonExplicitOnly: true,
    ...(
      cfg.simulation?.budget && typeof cfg.simulation.budget === 'object' && !Array.isArray(cfg.simulation.budget)
        ? cfg.simulation.budget
        : {}
    )
  };
  // 群友关系 v2（galgame）：默认开启；家人群自动排除；可按群覆盖。
  cfg.simulation.relationships = {
    enabled: true,
    excludeFamily: true,
    excludedGroups: [],
    promptLimit: 5,
    liveLimit: 6,
    ...(
      cfg.simulation?.relationships && typeof cfg.simulation.relationships === 'object' && !Array.isArray(cfg.simulation.relationships)
        ? cfg.simulation.relationships
        : {}
    )
  };
  // 自动个性签名：优先按真实状态用 LLM 生成，失败/关闭时退回干净模板，通过 SnowLuma set_qq_profile 更新。
  cfg.simulation.signature = {
    enabled: true,
    llm: true,
    minIntervalHours: 12,
    maxIntervalHours: 48,
    firstDelayMs: 10 * 60 * 1000,
    maxChars: 40,
    dryRun: false,
    requireApproval: true,
    approvalTimeoutMs: 24 * 3600 * 1000,
    ...(
      cfg.simulation?.signature && typeof cfg.simulation.signature === 'object' && !Array.isArray(cfg.simulation.signature)
        ? cfg.simulation.signature
        : {}
    )
  };

  // 拉黑阈值物化：默认值与 runtime/control/blacklist.js 的 BLACKLIST_DEFAULTS 逐字相等，
  // 与 blacklistCfg() 的消费 fallback 同源。simulation 是浅合并，config.json 一旦自带
  // safety 段，字面默认就被挤掉，键会既进不了 /api/config/schema，也被 apply 判未知项。
  {
    const nested = (value) => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const blacklist = nested(cfg.simulation?.safety?.blacklist);
    cfg.simulation.safety = {
      ...nested(cfg.simulation?.safety),
      blacklist: {
        enabled: BLACKLIST_DEFAULTS.enabled,
        announce: BLACKLIST_DEFAULTS.announce,
        ...blacklist,
        auto: {
          ...BLACKLIST_DEFAULTS.auto,
          ...nested(blacklist.auto)
        },
        naturalLanguage: {
          ...BLACKLIST_DEFAULTS.naturalLanguage,
          ...nested(blacklist.naturalLanguage)
        }
      }
    };
  }

  // simulation.initialPromptMaxChars：会话「初始提示词」的字数上限。config.json 是用户可编辑的，
  // 手工写进字符串/负数/超大值时要收敛到安全区间，否则要么保存接口永远报"过长"，要么等于没上限。
  {
    const raw = Number(cfg.simulation?.initialPromptMaxChars);
    cfg.simulation.initialPromptMaxChars = Number.isFinite(raw) && raw > 0
      ? Math.min(8000, Math.max(100, Math.round(raw)))
      : 2000;
  }

  // DSH 0.1.7 起 launch token 是**每进程现生成的 32 字节随机数，只存在内存里**，
  // 不落盘、不可推导；只有启动器把 `dsh web` 的 stdout 重定向到文件时才能从日志读到。
  // 所以这里发现的 token 只是兜底，主路径是客户端用 ~/.dsh 里持久化的签名密钥
  // 离线铸造会话 Cookie（见 dsh-client 的 mintBrowserSessionCookie）。
  // authTokenExplicit 记录「token 是用户填的还是这里猜的」，客户端据此排优先级。
  cfg.dsh.authTokenExplicit = Boolean(cfg.dsh.authToken);
  if (!cfg.dsh.authToken) cfg.dsh.authToken = discoverDshLaunchToken();

  // 思考强度可能被手工改成非法值（config.json 是用户可编辑的）。DeepSeek 适配器对非法值
  // 会硬拒绝，若直接透传会让每个会话的 selectModel 每次都失败；这里统一规范化并告警。
  try {
    cfg.dsh.reasoningEffort = normalizeReasoningEffort(cfg.dsh.reasoningEffort ?? REASONING_EFFORT_DEFAULT);
  } catch (error) {
    log(`⚠️ config.json 的 dsh.reasoningEffort「${cfg.dsh.reasoningEffort}」非法，已回退 ${REASONING_EFFORT_DEFAULT}（${error?.message ?? error}）`);
    cfg.dsh.reasoningEffort = REASONING_EFFORT_DEFAULT;
  }

  // 人格卡注入上限（字符）。默认 10000，与示例配置一致；每条约 7~10k token 的成本护栏。
  cfg.role = { maxInjectChars: ROLE_INJECT_MAX_CHARS_DEFAULT, ...(file.role ?? {}) };
  roleInjectMaxChars = applyRoleInjectLimit(cfg.role.maxInjectChars);
  if (roleInjectMaxChars !== cfg.role.maxInjectChars) {
    log(`人格注入上限已按范围校正为 ${roleInjectMaxChars} 字符（配置值 ${cfg.role.maxInjectChars}，允许 1000~20000）`);
  }

  // ── 存储与可靠性（SQLite / outbox / jobs）──────────────────────────────────
  // 默认全开，但任何初始化失败都会降级回原来的 JSON/内存路径（见 main()），
  // 不会因为一个新基础设施把正在运行的机器人卡死。
  cfg.storage = {
    enabled: true,
    dbPath: 'state/db/bridge.db',
    // 备份属于大文件，默认放 D 盘；D 盘不存在时由 main() 回退到 state/backups。
    backupDir: process.platform === 'win32' ? 'D:/xiaojingyu-backups' : 'state/backups',
    backupKeepDays: 7,
    retentionDays: 30,
    outboxEnabled: true,
    inboxEnabled: true,
    jobsEnabled: true,
    inboxReplayMaxAgeMs: 2 * 60 * 1000,
    outboxMaxAttempts: 5,
    outboxRetryBaseMs: 5000,
    outboxRetryMaxMs: 10 * 60 * 1000,
    configStrict: false,
    logJsonl: true,
    ...((file.storage && typeof file.storage === 'object' && !Array.isArray(file.storage)) ? file.storage : {})
  };
  cfg.configVersion = Number(file.configVersion) || 1;

  // 用 config.example.json 作为「期望类型」参照，校验用户文件里的类型/范围。
  // 默认只告警；storage.configStrict=true 时拒绝启动（给自动化部署用）。
  try {
    const example = readJsonSafe(path.join(ROOT, 'config.example.json'), null);
    if (example && typeof example === 'object') {
      const expected = deepMergeConfig(example, { storage: cfg.storage });
      const validation = validateConfigObject(expected, file);
      cfg.configValidation = { ok: validation.ok, errors: validation.errors, unknownCount: validation.unknown.length };
      for (const message of validation.errors.slice(0, 8)) log(`⚠️ 配置校验：${message}`);
      if (!validation.ok && cfg.storage.configStrict) {
        throw new Error(`配置校验失败（storage.configStrict=true）：${validation.errors[0]}`);
      }
    }
  } catch (error) {
    if (cfg.storage.configStrict) throw error;
    log(`⚠️ 配置校验器异常（继续启动）：${error?.message ?? error}`);
  }

  // 联网搜索配置：桥接本身不调用搜索 API，但控制台/实时页要显示 provider/模型，
  // S16 兜底和内心生活候选也会直接复用这份配置；之前只在 MCP 子进程里读，页面上永远是 auto。
  cfg.webSearch = {
    provider: 'auto',
    apiKey: '',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseURL: '',
    model: 'deepseek-v4-flash',
    maxUses: 5,
    maxTokens: 4096,
    maxResults: 6,
    timeoutMs: 35000,
    ...((file.webSearch && typeof file.webSearch === 'object' && !Array.isArray(file.webSearch)) ? file.webSearch : {})
  };

  // TTS 配置原本只在 MCP 子进程里读；桥接的实时页要显示声线传输方式，所以这里也带上。
  cfg.tts = file.tts && typeof file.tts === 'object' && !Array.isArray(file.tts) ? file.tts : {};

  return cfg;
}

// ── 状态持久化（QQ 会话 ↔ DSH 会话映射） ─────────────────────────────────────
let state = { sessions: {} };
// sessions.json 读不动/读坏时必须**大声失败**，不能静默回落成空映射：
// 那会让每个 QQ 会话都拿到一个全新的 DSH 会话（上下文全丢），而紧接着的
// saveState() 会把这份空映射原子写回磁盘 —— 一次截断/占用/写满就变成永久丢失。
// 与表情库、黑话库一样走「只读不写」降级：保留原文件，等人来处理。
let stateWritable = true;
// 可靠性层的模块级引用：saveState() 是模块级函数，需要把映射镜像到 SQLite。
let reliabilityDb = null;
let sessionMapStore = null;
let memoryStore = null;
let relationshipStore = null;
let relationshipsEnabledForKey = () => false;
let budgetStore = null;
// Feature host（日报/卡片解析等）在 main() 里异步加载；消息转文本会用到。
let featureHost = null;
function loadState() {
  let raw;
  try {
    raw = fs.readFileSync(STATE_FILE, 'utf8');
  } catch (error) {
    state = { sessions: {}, sessionPolicies: {} };
    if (error?.code !== 'ENOENT') {
      stateWritable = false;
      log(`⚠️ sessions.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
    }
    return;
  }
  let loaded = null;
  if (raw.trim() !== '') {
    try {
      const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
      loaded = JSON.parse(text);
    } catch (error) {
      state = { sessions: {}, sessionPolicies: {} };
      stateWritable = false;
      log(`⚠️ sessions.json 内容损坏，已降级为「只读不写」（不会覆盖原文件，请先备份再修复）：${error?.message ?? error}`);
      return;
    }
  }
  if (loaded && loaded.sessions && typeof loaded.sessions === 'object') state = loaded;
  else state = { sessions: {} };
  if (!state.sessionPolicies || typeof state.sessionPolicies !== 'object' || Array.isArray(state.sessionPolicies)) state.sessionPolicies = {};
}
function saveState() {
  // 统一走原子写：固定 `.tmp` 名 + 无 mode 的手写版本会在外部进程（杀软/备份）
  // 占住 sessions.json.tmp 时抛 EPERM，且写出的文件权限与其它 state 文件不一致。
  if (!stateWritable) return; // 见 loadState：读失败/损坏时绝不回写，避免把丢失变成永久
  atomicWriteJson(STATE_FILE, state);
  // 影子副本：sessions.json 丢失/被回滚时还能从 SQLite 恢复映射。
  try {
    if (sessionMapStore) sessionMapStore.saveAll(state.sessions, state.sessionPolicies);
  } catch (error) {
    log(`⚠️ 会话映射镜像写入 SQLite 失败（不影响主文件）：${error?.message ?? error}`);
  }
}

// ── 单实例锁 ─────────────────────────────────────────────────────────────────
// 防止多个桥接进程同时运行（双实例会抢消息、互相覆盖映射）。
// 锁文件存 PID；启动时若该 PID 仍存活则退出（exit 2 = 已有实例），
// 否则接管。进程退出/崩溃后锁自动失效（PID 校验）。
const LOCK_FILE = path.join(STATE_DIR, 'bridge.lock');

/**
 * 控制台端口是否已被占用 —— 用来判断「是不是真的还有一个桥接在跑」。
 *
 * 为什么需要它：锁文件只存了 PID，而 Windows 会回收 PID。`process.kill(pid, 0)` 成功
 * 只能证明「有进程占着这个号」，EPERM 更是连这一点都证明不了（受保护进程）。
 * 但桥接一定绑定控制台端口（绑不上会自己 exit 2），所以端口占用是一个可靠的判据。
 * 同步探测一次，只在启动期的可疑分支里跑，不影响正常运行。
 */
function consolePortInUse() {
  try {
    const cfg = readJsonSafe(path.join(ROOT, 'config.json'), {});
    const port = Number(cfg?.consolePort) || 3100;
    if (process.platform === 'win32') {
      const out = execFileSync('netstat', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      return new RegExp(`[:.]${port}\\s+\\S+\\s+LISTENING`, 'i').test(out);
    }
    const out = execFileSync('sh', ['-c', 'ss -ltn 2>/dev/null || netstat -ltn 2>/dev/null || true'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return new RegExp(`[:.]${port}\\s`).test(out);
  } catch {
    // 探测不出来时保守认为「有人在跑」，宁可让用户手动删锁，也不要冒双实例的风险。
    return true;
  }
}

function acquireLock() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  // 原子创建锁文件：把 PID 一次性写入（flag 'wx'），避免“先建空文件再写 PID”的窗口被第二个进程当作过期锁偷走。
  const tryCreate = () => {
    try {
      fs.writeFileSync(LOCK_FILE, String(process.pid), { flag: 'wx', mode: 0o600 });
      return true;
    } catch (error) {
      if (error?.code === 'EEXIST') return false;
      throw error;
    }
  };
  if (tryCreate()) return;
  // 锁文件已存在：检查 PID 是否仍存活；内容为空视为过期锁（仅兼容旧版本遗留），删除后重试一次。
  let stale = false;
  try {
    const content = fs.readFileSync(LOCK_FILE, 'utf8').trim();
    if (!content) {
      stale = true;
    } else {
      const pid = Number(content);
      if (!Number.isInteger(pid) || pid <= 0) {
        stale = true;
      } else {
        try {
          process.kill(pid, 0);
          // 没抛异常只说明「存在某个持有该 PID 的进程」，不能证明那就是桥接
          // （PID 被回收给别的程序时会误判），所以再加一道端口探测。
          if (!consolePortInUse()) stale = true;
        } catch (error) {
          if (error.code === 'ESRCH') {
            stale = true;
          } else if (error.code === 'EPERM') {
            // EPERM = 该 PID 属于受保护/系统进程（权限不足，无法发信号）。
            // 这**不能**证明桥接还在跑，但旧逻辑把它当成「已有实例」直接 exit(2)：
            // 一旦锁文件里的 PID 被系统回收给一个受保护进程，桥接就永久起不来，
            // 而且提示信息把人引向「已有实例在运行」这个错误方向。
            // 这里改成按「疑似过期」处理，但要先确认控制台端口没有被占用。
            if (consolePortInUse()) {
              console.error(`[bridge] 控制台端口已被占用，判定已有实例在运行（锁文件 PID ${pid} 无权限探测）。`);
              process.exit(2);
            }
            console.error(`[bridge] 锁文件 PID ${pid} 无权限探测（EPERM）且控制台端口空闲，按过期锁处理。`);
            stale = true;
          } else {
            console.error(`[bridge] 已有实例在运行（PID ${pid}，锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
            process.exit(2);
          }
        }
      }
    }
  } catch (readError) {
    console.error(`[bridge] 无法读取锁文件 ${LOCK_FILE}：${readError?.message ?? readError}`);
    process.exit(1);
  }
  if (stale) {
    console.error(`[bridge] 检测到过期锁文件（PID 不存在或为空），删除后重试…`);
    try { fs.unlinkSync(LOCK_FILE); } catch {}
    if (tryCreate()) return;
  }
  console.error(`[bridge] 已有实例在运行（锁文件 ${LOCK_FILE}）。若确认其已死，删除该文件后重试。`);
  process.exit(2);
}
function releaseLock() {
  try {
    if (fs.existsSync(LOCK_FILE) && Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()) === process.pid) {
      fs.unlinkSync(LOCK_FILE);
    }
  } catch {}
}

// ── 工具 ────────────────────────────────────────────────────────────────────
// 日志同时输出到 stdout 与 state/bridge.log（守护窗口不可见时也能排查）

/** 单条日志的最大长度：一条异常巨大的错误对象不能把整个日志文件变成 5MB。 */
const LOG_LINE_MAX = 1000;

/**
 * 带行数上限的追加写日志。
 *
 * 为什么不能「append 之后再读回整个文件数行数」：那样每写一行都要同步读一遍整个文件，
 * 到上限后还要整文件重写一次。实测 bridge.log 到了 2000 行（约 200KB）时，
 * 单次 log() 要 17ms 左右，而每条 QQ 消息会打 2~4 条日志 —— 每条消息白扔几十毫秒的
 * 事件循环。这里改成**内存计数器**：只在启动时数一次，之后 O(1) 追加，
 * 到上限才轮转，轮转用 rename 到 `.1`（不是整文件重写，也不会写坏）。
 */
function createCappedLogger(file, maxLines) {
  let lines = -1; // -1 = 还没数过
  return function append(text) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      if (lines < 0) {
        try {
          lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).length;
        } catch {
          lines = 0;
        }
      }
      fs.appendFileSync(file, text, 'utf8');
      lines += 1;
      if (lines > maxLines) {
        // 轮转：当前文件改名为 .1（覆盖上一个备份），新文件从零开始。
        try {
          fs.renameSync(file, `${file}.1`);
        } catch {
          // 改名失败（被占用等）就退化成截断，保证文件不会无限增长。
          fs.writeFileSync(file, '', 'utf8');
        }
        lines = 0;
      }
    } catch {}
  };
}

/** 本地时间 HH:MM:SS。此前用的是 toISOString()，写进日志的是 UTC，和本地时间差 8 小时。 */
function localClock(atMs = Date.now()) {
  const d = new Date(atMs);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

const appendBridgeLog = createCappedLogger(BRIDGE_LOG, 2000);

let liveLogSink = null;
// 结构化日志（JSONL）旁路：初始化失败时为 null，绝不影响原日志路径。
let jsonLogSink = null;
function log(...args) {
  let line;
  try {
    const body = args
      .map((a) => redactSensitiveText(typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ')
      .replace(/[\r\n]+/g, ' ');
    line = `${localClock()} [bridge] ${body.length > LOG_LINE_MAX ? `${body.slice(0, LOG_LINE_MAX)}…[截断]` : body}`;
  } catch {
    line = `${localClock()} [bridge] (日志参数无法序列化)`;
  }
  // console.log 必须自成一个 try：stdout 的读者（守护窗口）消失时会抛 EPIPE，
  // 而 log() 是从 socket 事件回调里被调用的 —— 一旦抛出就会变成未捕获异常把进程带走。
  try { console.log(line); } catch {}
  appendBridgeLog(`${line}\n`);
  try { if (liveLogSink) liveLogSink(line); } catch {}
  try {
    if (jsonLogSink) {
      const level = /错误|失败|异常|致命|⚠️|❌/.test(line) ? 'warn' : 'info';
      jsonLogSink[level](line);
    }
  } catch {}
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convKey = (kind, id) => `${kind}:${id}`;
const SEND_TIMEOUT_MS = 15000;
// DSH 控制类调用（停任务/归档会话）的超时。这些 await 以前是裸的：DSH 接受了连接但
// 不返回响应时，HTTP handler 永不返回，控制台与群消息一起失去响应（issue #32）。
// 超时后走各自的 catch 记日志，最坏情况只是「这一次重置没做成」，而不是整体挂死。
const DSH_CONTROL_TIMEOUT_MS = 15000;
function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`操作超时(${ms}ms)：${label}`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function segmentsToText(segments, options = {}) {
  const { resolveAtName, resolveReply, includeReply = true } = options ?? {};
  // 有些 OneBot 实现直接把纯文本消息放在 message 字段里（string）
  if (typeof segments === 'string') return segments.trim();
  const out = [];
  for (const seg of segments ?? []) {
    const d = seg?.data ?? {};
    switch (seg?.type) {
      case 'text': out.push(d.text ?? ''); break;
      case 'at': {
        if (d.qq === 'all') {
          out.push('@全体成员');
        } else {
          // 优先把 @ 对象解析成群名片/昵称，解析不到再回退成 QQ 号
          let name = null;
          try { name = resolveAtName ? await resolveAtName(String(d.qq)) : null; } catch { name = null; }
          out.push(name ? `@${name}` : `@${d.qq}`);
        }
        break;
      }
      case 'face': out.push(`[表情${d.id ?? ''}]`); break;
      // 市场表情（mface）在部分网关实现里出现：有 summary 就用它，别让模型只看到 "[mface]"。
      case 'mface': out.push(`[表情${d.summary ? `:${d.summary}` : ''}]`); break;
      case 'image': out.push('[图片]'); break;
      case 'record': out.push('[语音]'); break;
      case 'video': out.push('[视频]'); break;
      case 'file': out.push(`[文件${d.name ?? ''}]`); break;
      case 'reply': {
        // 引用/回复段：默认解析成「被引用人 + 原文」，让 AI 能判断这句话是对谁说的；
        // includeReply=false 时跳过该段，得到“当前消息自己的文字”（用于指令/指向性判断）。
        if (!includeReply) break;
        let replyText = '';
        if (resolveReply) {
          try {
            const info = await resolveReply(String(d.id));
            if (info?.sender || info?.text) {
              const parts = [];
              if (info.sender) parts.push(info.sender);
              if (info.text) parts.push(info.text);
              replyText = `[引用 ${parts.join('：')}]`;
            }
          } catch {}
        }
        out.push(replyText || '[引用消息]');
        break;
      }
      // 卡片类：只把标题/摘要/链接给模型，绝不透传原始 JSON/XML。
      case 'json':
      case 'xml':
      case 'card':
      case 'music':
      case 'share': {
        const rich = featureHost?.formatSegment(seg);
        out.push(rich || formatRichSegment(seg));
        break;
      }
      // markdown：SnowLuma 1.14.9 的线上段落是 `{type:'markdown',data:{content}}`。
      // 上游 1.14.17+（commit 1934e4e7「include text alongside received markdown」）
      // 起还会带上 `data.text`。两个形状都读，这样将来升级 SnowLuma 运行时不会退化成
      // 字面量 `[markdown]` 被喂给模型。SDK 的 KnownMessageSegment 联合里没有 markdown，
      // 所以段类型是运行时多出来的 —— 这正是 default 分支原来会命中的情况。
      case 'markdown': out.push(String(d.text ?? d.content ?? '[Markdown]')); break;
      case 'forward': {
        const fid = forwardIdFromData(d);
        out.push(fid ? `[转发消息 id=${fid}]` : '[转发消息]');
        break;
      }
      default: out.push(`[${seg?.type ?? '未知'}]`); break;
    }
  }
  return out.join('').trim();
}

/**
 * 媒体摘要（QQ 表情的 `summary`）会进入模型上下文、也会被拼进「[表情:…]」这类单行标注。
 * 压掉换行/控制字符并限长：否则一条群消息可以用摘要里的换行伪造出新的提示词段落。
 */
function sanitizeMediaSummary(value, max = 60) {
  const s = String(value ?? '').replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').trim();
  return s ? truncateText(s, max) : '';
}

// 从 OneBot 消息段中提取图片/表情元数据（不下载字节，仅记录定位信息）。
// 供旧版自动内联、仿真按需工具、控制台/日志使用。
//
// 字段必须尽量保留：SnowLuma 收到的 QQ 表情包（收藏/市场表情）是 **image 段 +
// emoji_id/emoji_package_id/key/url**（实测：sub_type 可能是 0，靠 emoji_id 区分），
// 部分网关实现则用 mface 段。以前只留 file/url/subType/summary，emoji 字段被丢掉，
// 一旦 get_image 取不到（市场表情不在网关缓存里），就再也没有其它可用的兜底地址。
function extractMediaFromSegments(segments) {
  const media = [];
  for (const seg of segments ?? []) {
    if (!seg || typeof seg !== 'object') continue;
    const d = seg.data ?? {};
    const emojiFields = {
      emojiId: String(d.emoji_id ?? d.emojiId ?? ''),
      emojiPackageId: String(d.emoji_package_id ?? d.emojiPackageId ?? ''),
      emojiKey: String(d.key ?? '')
    };
    if (seg.type === 'image') {
      media.push({
        kind: 'image',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        // 线上段落字段是 snake_case 的 `sub_type`（SnowLuma 运行时源码里就这么发）；
        // 而 SDK 的类型描述的是**内部元素**、拼作 `subType`。两个都读，别只认一个
        // —— 只读 camelCase 的话这里会永远是空串，而且不会有任何报错。
        subType: (d.sub_type ?? d.subType) != null ? String(d.sub_type ?? d.subType) : '',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'mface') {
      // 市场表情（mface）：没有 image 段可用，emoji_id/url 是唯一来源。
      media.push({
        kind: 'sticker',
        file: String(d.file ?? ''),
        url: String(d.url ?? ''),
        subType: '1',
        summary: sanitizeMediaSummary(d.summary),
        ...emojiFields
      });
    } else if (seg.type === 'face') {
      media.push({
        kind: 'face',
        faceId: String(d.id ?? ''),
        url: String(d.url ?? ''),
        summary: sanitizeMediaSummary(d.summary)
      });
    }
  }
  return media;
}

function allowed(kind, id, cfg) {
  // OneBot 事件里的 id 可能是数字也可能是字符串（int64 序列化差异），统一转字符串比较。
  // 配置字段兼容单数（group/private）与复数（groups/privates）两种写法。
  const s = String(id);
  const denyList = cfg.deny[kind] ?? cfg.deny[kind + 's'] ?? [];
  if (denyList.map(String).includes(s)) return false;
  const allowList = cfg.allow[kind] ?? cfg.allow[kind + 's'] ?? [];
  if (allowList.length > 0) return allowList.map(String).includes(s);
  return cfg.allowAllWhenEmpty;
}

// 仿真会话 key 规范化：只接受 group:正整数 / private:正整数，并去掉前导零，避免同一会话出现多个别名。
function canonicalSimulationKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) return null;
  const id = Number(m[2]);
  if (!Number.isSafeInteger(id) || id <= 0) return null;
  return `${m[1]}:${id}`;
}

const APPROVE_WORDS = new Set(['通过', '同意', '允许', '批准', 'yes', 'y', 'approve', 'ok']);
const REJECT_WORDS = new Set(['拒绝', '不同意', '不允许', '驳回', 'no', 'n', 'reject', 'deny']);

// state/ 的 ACL 是否已收紧（hardenStateDirAcl 的结果；控制台「访问与安全」页会显示，
// 未收紧时给出可复制的提权命令）。null = 还没跑/平台不适用。
let stateDirHardened = null;

// ── 主流程 ──────────────────────────────────────────────────────────────────
async function main() {
  const cfg = loadConfig();
  fs.mkdirSync(STATE_DIR, { recursive: true });
  hardenStateDirAcl();
  acquireLock();
  loadState();

  // ── 可靠性层：SQLite / inbox / outbox / jobs ───────────────────────────────
  // 任何一步失败都只降级、不阻断：机器人仍可按旧路径收发，只是没有重启恢复能力。
  const STORAGE = cfg.storage ?? {};
  const resolveRepoPath = (value, fallback) => {
    const raw = String(value || fallback || '').trim();
    if (!raw) return '';
    return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
  };
  let db = null;
  let inbox = null;
  let outbox = null;
  let jobQueue = null;
  let storageReady = false;
  const storageErrors = [];

  if (STORAGE.logJsonl !== false) {
    try {
      jsonLogSink = createJsonlLogger({
        dir: path.join(STATE_DIR, 'logs'),
        extraSecrets: [cfg.consoleToken, cfg.snowluma?.accessToken, cfg.dsh?.authToken]
      });
    } catch (error) {
      log(`⚠️ JSONL 日志初始化失败（继续用文本日志）：${error?.message ?? error}`);
    }
  }

  if (STORAGE.enabled !== false) {
    try {
      const dbFile = resolveRepoPath(STORAGE.dbPath, 'state/db/bridge.db');
      let backupDir = resolveRepoPath(STORAGE.backupDir, 'state/backups');
      // 配了不存在的盘符（例如没插 D 盘）时回退到 state/backups，避免每次启动都报错。
      if (backupDir && /^[A-Za-z]:[\\/]/.test(backupDir) && !fs.existsSync(path.parse(backupDir).root)) {
        backupDir = path.join(STATE_DIR, 'backups');
        log(`备份目录所在的盘符不可用，已回退到 state/backups`);
      }
      db = openDatabase({
        file: dbFile,
        backupDir,
        backupKeepDays: STORAGE.backupKeepDays,
        logger: (message) => log(`[db] ${message}`)
      });
      inbox = new Inbox({ db, logger: (message) => log(`[inbox] ${message}`) });
      reliabilityDb = db;
      sessionMapStore = new SessionMapStore({ db, logger: (message) => log(`[db] ${message}`) });
      memoryStore = new MemoryStore({ db, logger: (message) => log(`[memory] ${message}`) });
      relationshipStore = new RelationshipStore({
        db,
        ownerId: cfg.ownerQQ ?? '',
        logger: (message) => log(`[relation] ${message}`)
      });
      budgetStore = new BudgetStore({ db, logger: (message) => log(`[budget] ${message}`) });
      // 群友关系只对群聊生效；家人群默认排除，可按群显式覆盖。
      relationshipsEnabledForKey = (key) => {
        const rc = cfg.simulation?.relationships ?? {};
        if (rc.enabled === false) return false;
        if (!/^group:\d+$/.test(String(key))) return false;
        const profile = cfg.simulation?.groupProfiles?.[key];
        if (profile?.relationships === false) return false;
        if (profile?.relationships === true) return true;
        if (Array.isArray(rc.excludedGroups) && rc.excludedGroups.map(String).includes(String(key))) return false;
        if (rc.excludeFamily !== false && /家人|家庭|family/i.test(String(profile?.label || ''))) return false;
        return true;
      };
      // sessions.json 丢失/回滚时，用 SQLite 影子副本补回映射（只补缺失的 key）。
      try {
        let restored = 0;
        for (const row of sessionMapStore.loadAll()) {
          if (!state.sessions[row.key] && row.sessionId) {
            state.sessions[row.key] = row.sessionId;
            if (row.policy && !state.sessionPolicies[row.key]) state.sessionPolicies[row.key] = row.policy;
            restored += 1;
          }
        }
        if (restored) {
          saveState();
          log(`[db] 从 SQLite 影子副本恢复了 ${restored} 条会话映射`);
        }
        const mirrored = sessionMapStore.saveAll(state.sessions, state.sessionPolicies);
        if (mirrored) log(`[db] 会话映射已镜像到 SQLite：${mirrored} 条`);
      } catch (error) {
        log(`[db] 会话映射恢复失败（忽略）：${error?.message ?? error}`);
      }
      try {
        const prunedMemory = memoryStore.prune();
        if (prunedMemory) log(`[memory] 已清理 ${prunedMemory} 条过期/低置信度记忆`);
      } catch (error) {
        log(`[memory] 清理失败（忽略）：${error?.message ?? error}`);
      }
      storageReady = true;
      try {
        const pruned = pruneDatabase(db, { retentionDays: STORAGE.retentionDays });
        const total = Object.values(pruned).reduce((a, b) => a + Number(b || 0), 0);
        if (total > 0) log(`[db] 已清理过期记录 ${total} 条（保留 ${STORAGE.retentionDays} 天）`);
      } catch (error) {
        log(`[db] 过期清理失败（不影响启动）：${error?.message ?? error}`);
      }
      log(`[db] SQLite 已就绪：${path.relative(ROOT, dbFile)}（WAL）`);
    } catch (error) {
      storageErrors.push(String(error?.message ?? error));
      log(`⚠️ SQLite 初始化失败，可靠性层降级（仍可收发，但没有重启恢复）：${error?.message ?? error}`);
      db = null;
      inbox = null;
      storageReady = false;
    }
  } else {
    log('ℹ️ storage.enabled=false：可靠性层关闭（使用旧的内存/JSON 路径）');
  }

  if (db && STORAGE.jobsEnabled !== false) {
    jobQueue = new JobQueue({      db,
      logger: (message) => log(`[jobs] ${message}`),
      tickMs: 5000,
      retryBaseMs: 30000,
      retryMaxMs: 30 * 60 * 1000
    });
  }

  const asr = cfg.simulation?.speech?.asr?.enabled === true
    ? createSnowLumaAsr({
      httpUrl: cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000',
      accessToken: () => cfg.snowluma?.accessToken || '',
      timeoutMs: cfg.simulation.speech.asr.timeoutMs,
      cacheTtlMs: cfg.simulation.speech.asr.cacheTtlMs,
      logger: (message) => log(`[asr] ${message}`)
    })
    : null;

  // Feature loader：日报/卡片解析等通过 features/<id>/ 注册，主流程不直接感知实现。
  try {
    featureHost = await loadFeatures({
      dir: path.join(ROOT, 'features'),
      disabled: Array.isArray(cfg.features?.disabled) ? cfg.features.disabled : [],
      logger: (message) => log(message),
      ctx: {
        cfg,
        log,
        now: () => Date.now(),
        getState: getSimulationState,
        jobs: jobQueue ? { register: (type, handler) => jobQueue.register(type, handler) } : null,
        send: auditAndSend,
        dailyReport: { run: handleDailyReportJob, sync: syncDailyReportJobs }
      }
    });
    const active = featureHost.list().filter((f) => f.enabled).map((f) => f.id);
    if (active.length) log(`已加载 feature：${active.join(', ')}`);
  } catch (error) {
    log(`⚠️ feature 加载失败（继续用内置路径）：${error?.message ?? error}`);
    featureHost = null;
  }

  // inner-life 的 arm() 通过这两个函数把「下一次 tick」写进 jobs 表，重启后不丢。
  function scheduleInnerLifeTick(atMs) {
    if (!jobQueue) return;
    jobQueue.clearPending('inner-life.tick');
    jobQueue.enqueue({ type: 'inner-life.tick', runAfter: atMs, maxAttempts: 3 });
  }
  function cancelInnerLifeTick() {
    if (!jobQueue) return;
    jobQueue.clearPending('inner-life.tick');
  }

  // ── 群聊黑话/网络用语学习（slang） ──────────────────────────────────────
  let slangEntries = [];
  // 读失败时（被占用 / 权限 / JSON 损坏）必须**暂停写入**：否则内存里的空数组
  // 会在下一次 saveSlangStore() 时覆盖掉磁盘上那份数据，学到的词条全丢。
  let slangStoreWritable = true;
  try {
    slangEntries = loadSlang(SLANG_FILE, { onCorrupt: (message) => log(`⚠️ ${message}`) });
  } catch (error) {
    slangStoreWritable = false;
    log(`⚠️ 黑话库加载失败，已暂停写入以免覆盖磁盘数据（修好后重启即可恢复）：${error?.message ?? error}`);
  }
  const slangWindows = new Map();       // key -> [{sender,text,time}]：待学习消息窗口
  const slangExtractionCooldowns = new Map(); // key -> timestamp
  const slangSubmitTimes = new Map();   // key -> [timestamp]：AI 提交黑话候选限频（内存态）
  const feedbackTimes = new Map();      // key -> [timestamp]：AI 反馈限频（内存态）
  const slangResearchingIds = new Set(); // 正在研究中的候选 id，防止重复排队
  const learnerSessions = new Set();    // sessionId -> 学习会话（不映射 QQ，不发送）
  const learnerCollectors = new Map();  // sessionId -> turn collector
  const learnerWaiters = new Map();     // sessionId -> [{resolve,reject,timer}]
  const agentErrorNotifyAt = new Map(); // key -> timestamp：Agent 异常私下提醒主人的限频
  const toolJsonRepairAt = new Map(); // key -> timestamp：工具参数 JSON 损坏后的自动重试限频
  const rejectNoticeAt = new Map();     // key -> timestamp：DSH 拒收时群内兜底句的限频
  let slangLearnerSessionId = null;
  let slangTaskChain = Promise.resolve();
  // 内心生活（人格状态/好奇/空间说说）在启动末尾注入依赖后创建；提示词构建处用 optional 访问。
  let innerLife = null;

  // ── 实时状态页（/live）：只读快照 + SSE ─────────────────────────────────
  // 活动流只收白名单事件，且只保留类型/群号，不落消息原文。
  const liveEvents = [];
  const liveCounters = { guardHits: 0, autoAcks: 0, errors: 0 };
  const liveReplyLatencies = [];
  let liveLastReplyLatency = null;
  let liveGroupNames = new Map();
  let liveGroupNamesAt = 0;
  let liveFriendNames = new Map();
  let liveFriendNamesAt = 0;
  let liveTtsOnline = null;
  let liveTtsCheckedAt = 0;
  let liveTtsProvider = '';
  let lastTunnelSpawnAt = 0;
  let tunnelFailStreak = 0;
  const TUNNEL_HEALTH_TIMEOUT_MS = 20000;
  let liveUsage = null;
  let liveUsageAt = 0;
  let esportsFeed = null;
  let esportsFeedAt = 0;
  let esportsFeedLoading = false;
  let esportsFeedLastError = '';
  let esportsBroadcastAt = 0;
  let esportsBroadcastInfo = '';
  // skip 审计降噪：同一会话同一原因一小时内只落一行（仅内存，重启失效无妨）。
  const shouldLogBroadcastSkip = createSkipAuditThrottle({ windowMs: 60 * 60 * 1000 });
  const loadedSchedule = readJsonSafe(ESPORTS_SCHEDULE_FILE, {});
  let esportsSchedule = {
    matches: Array.isArray(loadedSchedule?.matches) ? loadedSchedule.matches : [],
    updatedAt: Number(loadedSchedule?.updatedAt) || 0,
    lastAttemptAt: Number(loadedSchedule?.lastAttemptAt) || 0,
    source: String(loadedSchedule?.source || ''),
    error: String(loadedSchedule?.error || '')
  };
  let esportsScheduleLoading = false;
  let reminderStore = { reminders: [] };
  let reminderStoreWritable = true;
  let subscriptionState = {};
  const gameCooldowns = new Map();

  // ── 拉黑名单 ─────────────────────────────────────────────────────────────
  const blacklistStore = createBlacklist({ file: BLACKLIST_FILE, log: (...args) => log(...args) });

  // ── 自动个性签名 ──────────────────────────────────────────────────────────
  let signatureState = normalizeSignatureState(readJsonSafe(SIGNATURE_FILE, {}));
  let signatureWritable = true;
  function saveSignatureState() {
    if (!signatureWritable) return;
    try {
      signatureState.updatedAt = Date.now();
      atomicWriteJson(SIGNATURE_FILE, signatureState);
    } catch (error) {
      log(`⚠️ 个性签名状态保存失败（暂停写入）：${error?.message ?? error}`);
      signatureWritable = false;
    }
  }
  function buildSignaturePreview() {
    const sig = cfg.simulation?.signature ?? {};
    let persona = null;
    try { persona = innerLife?.personaInfo?.()?.state ?? null; } catch {}
    const interests = persona?.interests ?? [];
    return generateSignature({
      persona,
      now: Date.now(),
      maxChars: Math.max(8, Math.min(60, Number(sig.maxChars) || 40)),
      history: signatureState.history,
      interests,
      roleName: currentRoleName()
    });
  }
  /**
   * 自动签名出草稿的正文：优先 LLM 按真实状态生成，产出不合格就带提示重试一次，
   * 仍不行或 LLM 不可用/抛错时退回干净模板（buildSignaturePreview）。绝不换字造病句。
   * llm=false 是回滚开关：直接走模板。返回 { text, source }。
   */
  async function buildSignatureDraftText() {
    const sig = cfg.simulation?.signature ?? {};
    const maxChars = Math.max(8, Math.min(60, Number(sig.maxChars) || 40));
    let persona = null;
    try { persona = innerLife?.personaInfo?.()?.state ?? null; } catch {}
    const filterArgs = {
      maxChars,
      history: signatureState.history,
      interests: persona?.interests ?? [],
      bannedThemes: [],
      avoidTexts: []
    };
    if (sig.llm !== false && typeof innerLife?.generateSignatureText === 'function') {
      let hint = '';
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          const raw = await innerLife.generateSignatureText({ ...filterArgs, hint, roleName: currentRoleName() });
          const value = cleanSignatureText(raw, maxChars);
          if (value && isSignatureTextAllowed(value, filterArgs)) return { text: value, source: 'llm' };
          hint = '上一版和最近用过的签名太像。换一件最近真实发生的小事来写，别复用同样的句式';
        } catch (error) {
          log(`[signature] LLM 生成失败，退回模板兜底：${error?.message ?? error}`);
          break;
        }
      }
    }
    return { text: buildSignaturePreview(), source: 'template' };
  }
  async function applyQQSignature(text) {
    const body = String(text ?? '').trim();
    if (!body) throw new Error('签名不能为空');
    if (body.length > 60) throw new Error('签名过长（最多 60 字）');
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    let nickname = '';
    try {
      const login = await bot.getLoginInfo();
      nickname = String(login?.nickname ?? '').trim();
    } catch {}
    const payload = { personal_note: body };
    // 同时带上当前昵称，避免某些网关把未提供的字段清空。
    if (nickname) payload.nickname = nickname;
    const res = await fetch(`${httpUrl}/set_qq_profile`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(15000)
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.status !== 'ok' || data.retcode !== 0) {
      throw new Error(`set_qq_profile 失败：${data.wording || data.retcode || res.status}`);
    }
    return data.data ?? {};
  }
  function signatureIntervalConfig() {
    const sig = cfg.simulation?.signature ?? {};
    const minHours = Math.max(1, Number(sig.minIntervalHours) || 12);
    const maxHours = Math.max(minHours, Number(sig.maxIntervalHours) || 48);
    return { minHours, maxHours, minMs: minHours * 3600 * 1000, maxMs: maxHours * 3600 * 1000 };
  }
  function scheduleSignatureNext(from = Date.now()) {
    const sig = cfg.simulation?.signature ?? {};
    if (!jobQueue || !featureEnabled(cfg, 'signature') || sig.enabled !== true) return 0;
    const { minHours, maxHours } = signatureIntervalConfig();
    const at = from + randomSignatureIntervalMs(minHours, maxHours);
    signatureState.nextAt = at;
    saveSignatureState();
    // 只保留一个待执行的签名任务，避免手动更新/重启/冷却各排一条造成重复更新。
    jobQueue.clearPending('signature.auto');
    jobQueue.enqueue({
      type: 'signature.auto',
      dedupeKey: `signature:auto:${at}`,
      runAfter: at,
      maxAttempts: 3
    });
    return at;
  }
  function syncSignatureJob() {
    const sig = cfg.simulation?.signature ?? {};
    if (!jobQueue || !featureEnabled(cfg, 'signature') || sig.enabled !== true) return 0;
    const now = Date.now();
    const { minHours, maxHours, minMs, maxMs } = signatureIntervalConfig();
    let at = Number(signatureState.nextAt) || 0;
    const last = Number(signatureState.lastAppliedAt) || 0;
    if (last) {
      const minNext = last + minMs;
      const maxNext = last + maxMs;
      if (!at || at < minNext || at > maxNext) {
        at = last + randomSignatureIntervalMs(minHours, maxHours);
      }
      if (at < now - 5 * 60 * 1000) at = now + 60 * 1000;
    } else if (!at || at < now - 5 * 60 * 1000) {
      at = now + Math.max(60 * 1000, Number(sig.firstDelayMs) || 10 * 60 * 1000);
    } else if (at < now) {
      at = now + 60 * 1000;
    }
    signatureState.nextAt = at;
    saveSignatureState();
    jobQueue.clearPending('signature.auto');
    jobQueue.enqueue({
      type: 'signature.auto',
      dedupeKey: `signature:auto:${at}`,
      runAfter: at,
      maxAttempts: 3
    });
    return at;
  }
  async function sendOwnerPrivate(text) {
    if (!cfg.ownerQQ) return null;
    try { return await onebotSend('private', Number(cfg.ownerQQ), text); }
    catch (error) { log(`[owner] 私聊发送失败：${error?.message ?? error}`); return null; }
  }

  async function handleVoiceStyleOwnerCommand(text, { kind, isOwner } = {}) {
    if (!isOwner || kind !== 'private') return false;
    const command = String(text ?? '').trim();
    if (!command) return false;
    let next = null;
    let reply = '';
    if (/^(黑化模式|黑化声线|切换黑化)$/.test(command)) {
      next = { mode: 'dark', autoDark: false, source: 'owner' };
      reply = '黑化声线已打开。以后语音会用冷傲、压低的那一版；说「恢复正常」可以回来。';
    } else if (/^(软萌模式|软萌声线|切换软萌)$/.test(command)) {
      next = { mode: 'soft', autoDark: false, source: 'owner' };
      reply = '已切回软萌声线。';
    } else if (/^(自动声线|声线自动|恢复自动)$/.test(command)) {
      next = { mode: 'auto', autoDark: false, source: 'owner' };
      reply = '声线恢复自动：平时软萌，情绪掉到阈值时会自己转黑化。';
    } else if (/^(正常声音|恢复正常|恢复声线)$/.test(command)) {
      next = { mode: 'auto', autoDark: false, source: 'owner' };
      reply = '好，恢复正常声线：平时软萌，情绪不好时再自己切黑化。';
    }
    if (!next) return false;
    writeVoiceStyleState(next);
    await sendOwnerPrivate(reply);
    log(`[voice] 主人切换声线：${next.mode}`);
    return true;
  }

  async function handleSignatureOwnerCommand(text, { kind, isOwner, explicitOnly = false, replyToId = '' } = {}) {
    if (!isOwner || kind !== 'private') return false;
    const command = String(text ?? '').trim();
    if (!command) return false;
    const pending = signatureState.pending;
    if (!pending) return false;
    const qzonePending = (() => { try { return !!innerLife?.getState?.()?.pendingDraft; } catch { return false; } })();
    if (Date.now() > Number(pending.expiresAt || 0)) {
      signatureState.pending = null;
      saveSignatureState();
      await sendOwnerPrivate('这条签名草稿已经过期了，下次我重新写一条。');
      return true;
    }
    const approve = /^(发签名|发布签名|更新签名)$/.test(command)
      || (!qzonePending && /^(发|发布|更新)$/.test(command));
    if (approve) {
      try {
        await applyQQSignature(pending.text);
        const now = Date.now();
        signatureState.lastText = pending.text;
        signatureState.lastAppliedAt = now;
        signatureState.lastError = '';
        signatureState.history = appendSignatureHistory(signatureState.history, pending.text, now);
        signatureState.pending = null;
        signatureState.nextAt = 0;
        saveSignatureState();
        scheduleSignatureNext(now);
        log(`[signature] 主人确认，签名已更新：${pending.text}`);
        await sendOwnerPrivate(`签名已更新：${pending.text}`);
      } catch (error) {
        signatureState.lastError = String(error?.message ?? error).slice(0, 300);
        saveSignatureState();
        await sendOwnerPrivate(`签名更新失败：${error?.message ?? error}`);
      }
      return true;
    }
    if (/^(不发签名|取消签名)$/.test(command) || (!qzonePending && /^(不发|放弃|算了)$/.test(command))) {
      signatureState.pending = null;
      saveSignatureState();
      scheduleSignatureNext();
      await sendOwnerPrivate('好，这次不更新签名。');
      return true;
    }
    // 只有显式「改签名 …」或引用这条草稿时才当成修改要求；
    // 其他消息（抱怨、提问、闲聊）必须继续走正常回复，不能被签名流程吞掉。
    const adjust = isSignatureAdjustCommand(command, pending, { replyToId, explicitOnly, qzonePending });
    if (!adjust.ok) return false;
    if (isDuplicateSignatureInstruction(pending, adjust.instruction)) {
      log(`[signature] 相同修改指令重复，跳过：${adjust.instruction.slice(0, 40)}`);
      return true;
    }
    pending.lastInstruction = adjust.instruction;
    pending.lastInstructionText = pending.text;
    pending.lastInstructionAt = Date.now();
    saveSignatureState();
    const target = { ...pending };
    void (async () => {
      try {
        const refined = await innerLife.refineText({
          kind: 'signature',
          current: target.text,
          instruction: adjust.instruction,
          maxChars: Math.max(8, Math.min(60, Number(cfg.simulation?.signature?.maxChars) || 40))
        });
        const latest = signatureState.pending;
        if (!latest) { await sendOwnerPrivate('签名草稿已经不在了，这次没改。'); return; }
        // 期间又来了更新的修改指令：这一版结果已经过时，直接丢弃，避免连出两版草稿。
        if (latest.lastInstruction !== adjust.instruction) return;
        if (refined === latest.text) {
          await sendOwnerPrivate(`这版没变：\n${latest.text}\n\n回复「发签名」更新，回复「不发签名」放弃。`);
          return;
        }
        latest.text = refined;
        latest.createdAt = Date.now();
        latest.expiresAt = Date.now() + Math.max(60 * 1000, Number(cfg.simulation?.signature?.approvalTimeoutMs) || 24 * 3600 * 1000);
        signatureState.nextAt = latest.expiresAt;
        saveSignatureState();
        const timeoutMin = Math.round(Math.max(60 * 1000, Number(cfg.simulation?.signature?.approvalTimeoutMs) || 24 * 3600 * 1000) / 60000);
        const sent = await sendOwnerPrivate(`【个性签名草稿·已改】\n${refined}\n\n回复「发签名」更新，回复「不发签名」放弃；还想改就引用这条草稿说，或发「改签名 …」（${timeoutMin} 分钟内有效）`);
        const messageId = String(sent?.message_id ?? sent?.messageId ?? '');
        if (messageId) {
          latest.messageId = messageId;
          latest.messageIds = [...new Set([...(Array.isArray(latest.messageIds) ? latest.messageIds : []), messageId])].slice(-5);
          saveSignatureState();
        }
        log(`[signature] 签名草稿已按主人要求修改：${refined}`);
      } catch (error) {
        const latest = signatureState.pending;
        if (latest) {
          latest.lastInstruction = '';
          latest.lastInstructionText = '';
          latest.lastInstructionAt = 0;
          saveSignatureState();
        }
        await sendOwnerPrivate(`唔，这次没改成功：${error?.message ?? error}，再跟我说一次？`);
      }
    })();
    return true;
  }

  async function handleSignatureJob(job) {
    const sig = cfg.simulation?.signature ?? {};
    if (!featureEnabled(cfg, 'signature') || sig.enabled !== true) return { status: 'disabled' };
    if (!snowlumaHealth.connected) return { retryAfterMs: 15 * 60 * 1000 };
    // 手动更新后至少等过一个最短间隔，避免旧任务补跑
    if (signatureState.lastAppliedAt && Date.now() - signatureState.lastAppliedAt < signatureIntervalConfig().minMs) {
      scheduleSignatureNext();
      return { status: 'cooldown' };
    }
    if (signatureState.pending) {
      if (Date.now() < Number(signatureState.pending.expiresAt || 0)) {
        // 还在等审核：复用同一版草稿，不重新生成；下次唤醒对齐到过期时刻，避免每 30 分钟空转。
        const remain = Math.max(60 * 1000, Number(signatureState.pending.expiresAt || 0) - Date.now());
        return { status: 'pending-approval', retryAfterMs: remain };
      }
      // 过期不算主人拒绝：只记录 + 顺延到下一个正常间隔，绝不在同一 tick 立刻再出一版（churn 收敛）。
      log(`[signature] 草稿过期未审：${signatureState.pending.text}`);
      signatureState.pending = null;
      saveSignatureState();
      const nextAt = scheduleSignatureNext();
      log(`[signature] 已顺延到 ${nextAt ? new Date(nextAt).toISOString() : '下次'}`);
      return { status: 'expired', nextAt };
    }
    const { text } = await buildSignatureDraftText();
    if (!text) return { status: 'empty' };
    if (text === signatureState.lastText) {
      scheduleSignatureNext();
      return { status: 'unchanged' };
    }
    if (sig.dryRun === true) {
      log(`[signature] 预览（dryRun）：${text}`);
      scheduleSignatureNext();
      return { status: 'dry-run' };
    }
    // 默认先发主人审核；主人回「发签名」才真正写 QQ 资料。
    if (sig.requireApproval !== false) {
      if (!cfg.ownerQQ) {
        log('[signature] 未配置 ownerQQ，签名草稿无人可审，本次跳过');
        scheduleSignatureNext();
        return { status: 'no-owner' };
      }
      const timeoutMs = Math.max(60 * 1000, Number(sig.approvalTimeoutMs) || 24 * 3600 * 1000);
      const timeoutMin = Math.round(timeoutMs / 60000);
      const body = `【个性签名草稿】\n${text}\n\n回复「发签名」更新，回复「不发签名」放弃；想改请引用这条草稿回我，比如「短一点」「别写猫，换成米饭」；也可以直接说「改签名 …」（${timeoutMin} 分钟内有效）`;
      try {
        const sent = await onebotSend('private', Number(cfg.ownerQQ), body);
        const messageId = String(sent?.message_id ?? sent?.messageId ?? '');
        signatureState.pending = {
          text,
          createdAt: Date.now(),
          expiresAt: Date.now() + timeoutMs,
          messageId,
          messageIds: messageId ? [messageId] : []
        };
        signatureState.nextAt = signatureState.pending.expiresAt;
        saveSignatureState();
        log(`[signature] 签名草稿已发主人审核：${text}`);
        return { status: 'draft', retryAfterMs: timeoutMs };
      } catch (error) {
        signatureState.lastError = String(error?.message ?? error).slice(0, 300);
        saveSignatureState();
        throw error;
      }
    }
    try {
      await applyQQSignature(text);
      const now = Date.now();
      signatureState.lastText = text;
      signatureState.lastAppliedAt = now;
      signatureState.lastError = '';
      signatureState.history = appendSignatureHistory(signatureState.history, text, now);
      signatureState.nextAt = 0;
      saveSignatureState();
      log(`[signature] 个性签名已更新：${text}`);
      scheduleSignatureNext(now);
      return { status: 'applied' };
    } catch (error) {
      signatureState.lastError = String(error?.message ?? error).slice(0, 300);
      saveSignatureState();
      throw error;
    }
  }

  function recordLiveEvent(type, text) {
    liveEvents.push({ ts: Date.now(), type, text: String(text).slice(0, 160) });
    if (liveEvents.length > 80) liveEvents.splice(0, liveEvents.length - 80);
  }

  // log() 的旁路：只挑适合给状态页看的行，绝不把消息正文带进活动流。
  function onLiveLog(line) {
    const s = String(line || '');
    if (!s) return;
    const key = (s.match(/(group|private):\d+/) || [])[0] || '';
    const suffix = key ? ` · ${key}` : '';
    if (/拦截首答前长等待/.test(s)) { liveCounters.guardHits += 1; recordLiveEvent('guard', `首答前长等待已拦截${suffix}`); return; }
    if (/回复后自动销账/.test(s)) { liveCounters.autoAcks += 1; recordLiveEvent('ack', `回复后销账${suffix}`); return; }
    if (/工具统一发送/.test(s)) { recordLiveEvent('send', `发送消息${suffix}`); return; }
    if (/已发送语音/.test(s)) { recordLiveEvent('voice', `发送语音${suffix}`); return; }
    if (/空间说说已发布/.test(s)) { recordLiveEvent('qzone', `空间说说已发布${suffix}`); return; }
    if (/已分享到/.test(s)) { recordLiveEvent('share', `群内分享${suffix}`); return; }
    if (/\[simulation\] 唤醒|计划唤醒/.test(s)) { recordLiveEvent('wake', `唤醒${suffix}`); return; }
    if (/DSH 已就绪/.test(s)) { recordLiveEvent('health', 'DSH 已就绪'); return; }
    if (/失败|错误|异常/.test(s) && !/WebSocket closed before opening|同步收藏表情失败|群名刷新失败|reasoningEffort|设置会话模型失败|只读降级|SnowLuma 错误/.test(s)) {
      liveCounters.errors += 1;
      recordLiveEvent('error', `错误（已脱敏）${suffix}`);
    }
  }
  liveLogSink = onLiveLog;

  async function refreshLiveGroupNames() {
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_group_list`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: '{}',
        signal: AbortSignal.timeout(10000)
      });
      const body = await res.json().catch(() => ({}));
      if (body?.status === 'ok' && Array.isArray(body.data)) {
        const map = new Map();
        for (const g of body.data) {
          if (g?.group_id) map.set(String(g.group_id), String(g.group_name || ''));
        }
        liveGroupNames = map;
        liveGroupNamesAt = Date.now();
      }
    } catch {}
  }

  async function refreshLiveFriendNames() {
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_friend_list`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: '{}',
        signal: AbortSignal.timeout(10000)
      });
      const body = await res.json().catch(() => ({}));
      if (body?.status === 'ok' && Array.isArray(body.data)) {
        const map = new Map();
        for (const f of body.data) {
          if (!f?.user_id) continue;
          const name = String(f.remark || f.nickname || '').trim();
          if (name) map.set(String(f.user_id), name);
        }
        liveFriendNames = map;
        liveFriendNamesAt = Date.now();
      }
    } catch {}
  }

  // 控制台的会话展示名：群优先用群名；私聊优先用好友备注/昵称，主人单独标注。
  // 取不到时回退到可读的“群 <号>”/“私聊 <号>”，调用方仍会另起一行显示原始 key。
  function conversationDisplayName(key) {
    const m = /^(group|private):(\d+)$/.exec(String(key ?? ''));
    if (!m) return '';
    const kind = m[1];
    const id = m[2];
    if (kind === 'group') return liveGroupNames.get(id) || `群 ${id}`;
    const friendName = liveFriendNames.get(id);
    if (friendName) return friendName;
    return id === String(cfg.ownerQQ ?? '') ? '主人' : `私聊 ${id}`;
  }

  // 电竞实时资讯：本机到国外赛事站不可达，走直播吧的公开列表 + 赛果正文。
  // 只做事实缓存，不自动往群里发；唤醒时按话题相关性注入。
  function scheduleDateLabel(dateKey) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateKey || ''));
    return m ? `${Number(m[2])}月${Number(m[3])}日` : '';
  }

  async function fetchBaiduScheduleText(dateKey) {
    const query = `S16 ${scheduleDateLabel(dateKey)} 赛程 北京时间 凌晨`;
    const url = `https://www.baidu.com/s?wd=${encodeURIComponent(query)}`;
    const res = await safeFetch(url, 900000);
    if (!res || res.statusCode < 200 || res.statusCode >= 300) throw new Error(`百度搜索 HTTP ${res?.statusCode ?? '未知'}`);
    return String(res.body || '')
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/\s+/g, ' ');
  }

  async function refreshEsportsSchedule({ force = false } = {}) {
    if (esportsScheduleLoading) return;
    const now = Date.now();
    const today = shanghaiDateKey(now);
    // 官方赛程文件每 30 分钟拉一次：抽签结果一公布就能更新，不再等 6 小时。
    if (!force && now - Number(esportsSchedule.lastAttemptAt || 0) < 30 * 60 * 1000) return;
    esportsScheduleLoading = true;
    esportsSchedule.lastAttemptAt = now;
    const incoming = [];
    const errors = [];
    let source = '';
    try {
      // 第一优先：腾讯 LPL 官方赛程 JSON（包含最新抽签、日期、时间和 BO）。
      try {
        const official = await safeFetch(OFFICIAL_SCHEDULE_URL, 900000);
        if (official && official.statusCode >= 200 && official.statusCode < 300) {
          const parsed = parseOfficialSchedule(official.body);
          if (parsed.length) {
            incoming.push(...parsed);
            source = 'lpl';
          } else {
            errors.push('官方赛程没有解析到对阵');
          }
        } else {
          errors.push(`官方赛程 HTTP ${official?.statusCode ?? '未知'}`);
        }
      } catch (error) {
        errors.push(`官方赛程：${error?.message ?? error}`);
      }
      // 官方源不可用时才回退百度搜索；正常情况不再依赖搜索摘要。
      if (!incoming.length) {
        const dates = [...new Set([today, addDaysKey(today, 1), addDaysKey(today, 2)])];
        for (const date of dates) {
          try {
            const text = await fetchBaiduScheduleText(date);
            const parsed = parseScheduleMatches(text, { year: Number(date.slice(0, 4)), defaultDate: date });
            incoming.push(...parsed);
          } catch (error) {
            errors.push(`${date}: ${error?.message ?? error}`);
          }
        }
        if (incoming.length) source = 'baidu';
      }
      if (incoming.length) {
        esportsSchedule.matches = mergeScheduleMatches(
          esportsSchedule.matches,
          incoming,
          { keepBefore: addDaysKey(today, -7) }
        );
        esportsSchedule.updatedAt = Date.now();
        esportsSchedule.source = source || 'lpl';
        esportsSchedule.error = '';
        log(`[esports] 赛程更新：${incoming.length} 场（来源 ${esportsSchedule.source}，缓存 ${esportsSchedule.matches.length} 场）`);
      } else {
        esportsSchedule.error = errors.join(' | ').slice(0, 300);
        log(`[esports] 赛程刷新失败：${esportsSchedule.error || '没有解析到对阵'}`);
      }
      atomicWriteJson(ESPORTS_SCHEDULE_FILE, {
        matches: esportsSchedule.matches,
        updatedAt: esportsSchedule.updatedAt,
        lastAttemptAt: esportsSchedule.lastAttemptAt,
        source: esportsSchedule.source,
        error: esportsSchedule.error
      });
    } finally {
      esportsScheduleLoading = false;
    }
  }

  function esportsScheduleBlock({ days = 7 } = {}) {
    return buildScheduleLines({
      matches: esportsSchedule.matches,
      now: Date.now(),
      days,
      stageSchedule: STAGE_SCHEDULE
    }).text;
  }

  /** 赛事资讯的运行期门控：分享引擎总闸 && 功能开关 && 细项开关，实时页据此区分「关掉」和「今天没播」。 */
  function esportsFeedGateOpen() {
    return shareEngineEnabled(cfg)
      && featureEnabled(cfg, 'esportsFeed')
      && (cfg.simulation?.esportsFeed?.enabled !== false);
  }

  async function refreshEsportsFeed() {
    const ec = cfg.simulation?.esportsFeed ?? {};
    if (!esportsFeedGateOpen() || esportsFeedLoading) return;
    esportsFeedLoading = true;
    try {
      let feed;
      try {
        feed = await fetchEsportsFeed({
          maxItems: Math.min(30, Math.max(1, Number(ec.maxItems) || 12)),
          summaryMaxChars: Math.min(4000, Math.max(200, Number(ec.summaryMaxChars) || 1400))
        });
      } catch (primaryError) {
        // 直播吧改版/列表暂时没有可用条目时，用通用搜索兜底；搜索失败再把两边原因一起抛出。
        if (typeof webSearch !== 'function') throw primaryError;
        const query = `S16 世界赛 最新赛果 比分 ${localDateKey()}`;
        try {
          const searched = await webSearch(query, { config: { maxResults: 8, timeoutMs: 45000 } });
          feed = buildEsportsFeedFromSearch(searched.results, { query });
          log(`[esports] 直播吧无可用条目，已用联网搜索兜底（${feed.items.length} 条）`);
        } catch (searchError) {
          throw new Error(`直播吧：${primaryError?.message ?? primaryError}；联网搜索兜底：${searchError?.message ?? searchError}`);
        }
      }
      esportsFeed = feed;
      esportsFeedAt = Date.now();
      if (esportsFeedLastError) log(`[esports] 资讯源恢复（${feed.items.length} 条）`);
      esportsFeedLastError = '';
      // 赛程缓存先更新再触发播报，保证播报 prompt 里能带“几号几点”。
      await refreshEsportsSchedule().catch((error) => log(`[esports] 赛程刷新异常（忽略）：${error?.message ?? error}`));
      void maybeBroadcastEsports(feed);
    } catch (error) {
      const msg = error?.message ?? String(error);
      if (msg !== esportsFeedLastError) log(`[esports] 资讯刷新失败：${msg}`);
      esportsFeedLastError = msg;
    } finally {
      esportsFeedLoading = false;
    }
  }

  async function maybeBroadcastEsports(feed) {
    esportsBroadcastAt = Date.now();
    esportsBroadcastInfo = '';
    if (!feed?.summaryUrl) { esportsBroadcastInfo = '没有可播报的摘要链接'; return; }
    if (!dshReady || currentMode !== 'simulation' || simulation.paused) {
      esportsBroadcastInfo = 'DSH 未就绪、模式不是 simulation 或已暂停';
      return;
    }
    const subs = Array.isArray(cfg.simulation?.subscriptions) ? cfg.simulation.subscriptions : [];
    if (!subs.length) { esportsBroadcastInfo = '没有配置订阅'; return; }
    let triggered = 0;
    let lastSkip = '';
    // 赛果类资讯必须过官方赛程闸门：当日 status 还不是 3 就说明比赛没打完。
    const resultGate = shouldSkipResultBroadcast({ feed, matches: esportsSchedule.matches, now: Date.now() });
    for (const sub of subs) {
      if (!sub || sub.enabled === false || String(sub.topic || 's16') !== 's16') continue;
      const key = canonicalSimulationKey(String(sub.key || '').trim());
      if (!key || !isSessionAllowedInCurrentMode(key)) { lastSkip = '订阅会话不在当前模式白名单'; continue; }
      if (!isS16Content(feed.summaryTitle)) { lastSkip = '摘要与 S16 无关'; continue; }
      // 只有真正的赛果/战报/汇总才触发主动播报；“用时排名/数据盘点”这类文章不吵群。
      if (feed.summaryKind !== 'result') { lastSkip = '最新内容不是赛果'; continue; }
      if (resultGate.skip) { lastSkip = resultGate.reason; continue; }
      const stateKey = `${key}:s16`;
      const prev = subscriptionState[stateKey] || {};
      const hash = crypto.createHash('sha1')
        .update(`${feed.summaryUrl}\n${feed.summaryTitle || ''}`)
        .digest('hex').slice(0, 16);
      if (prev.hash === hash) { lastSkip = '与上次播报相同'; continue; }
      const now = Date.now();
      const day = localDayKey();
      const maxPerDay = Math.max(1, Number(sub.maxPerDay) || 2);
      const minGap = Math.max(60000, Number(sub.minGapMs) || 30 * 60 * 1000);
      // 限频以 append-only 审计为准；subscriptionState 只做展示缓存，
      // 即使快照被旧版本覆盖/重置，也不会让上限和最小间隔失效。
      const stats = dayStatsFromAudit(readBroadcastAuditLines(), { key: stateKey, day });
      // 同一场赛果换一篇文章也不能再播：优先用官方赛程那场，没有对局时退回标题队伍。
      const matchKey = resultMatchKey({
        day: resultGate.match ? String(resultGate.match.date || day).slice(0, 10) : day,
        teams: resultGate.match ? [resultGate.match.teamA, resultGate.match.teamB] : (resultGate.teams || [])
      });
      const verdict = decideBroadcast({
        count: stats.count, lastAt: stats.lastAt, now, maxPerDay, minGapMs: minGap,
        matchKey, seenMatchKeys: stats.matchKeys
      });
      if (!verdict.allow) {
        lastSkip = verdict.reason;
        if (shouldLogBroadcastSkip(`${stateKey}|${verdict.reason}`, now)) {
          appendBroadcastAudit({ at: now, key: stateKey, decision: 'skip', reason: verdict.reason });
        }
        continue;
      }
      // 凌晨不主动吵群；赛果在早上 8 点后的下一次刷新补播。
      const hour = Number(new Date().toLocaleString('en-US', { hour: '2-digit', hour12: false, timeZone: 'Asia/Shanghai' }));
      if (Number.isFinite(hour) && hour < 8) { lastSkip = '凌晨不主动播报'; continue; }
      const st = getSimulationState(key);
      // 首次唤醒必须走 bootstrap（带初始提示词/角色引导）；订阅不能抢在它前面。
      if (!st.bootstrapSent) { lastSkip = '会话尚未完成首次引导'; continue; }
      const pending = {
        title: feed.summaryTitle || '',
        summary: String(feed.summary || '').slice(0, 1200),
        url: feed.summaryUrl,
        at: now,
        topic: 's16',
        summaryKind: feed.summaryKind || ''
      };
      const official = resultGate.match && String(resultGate.match.status ?? '') === '3' ? resultGate.match : null;
      if (official) {
        pending.officialScore = resultGate.officialScore || `${Number(official.scoreA) || 0}-${Number(official.scoreB) || 0}`;
        pending.scheduleStatus = '3';
        pending.teamA = official.teamA;
        pending.teamB = official.teamB;
        pending.scoreA = Number(official.scoreA) || 0;
        pending.scoreB = Number(official.scoreB) || 0;
      }
      st.pendingBroadcast = pending;
      saveSimulationState();
      subscriptionState[stateKey] = { hash, lastAt: now, day, count: stats.count + 1, lastUrl: feed.summaryUrl };
      saveSubscriptionState();
      appendBroadcastAudit({
        at: now,
        key: stateKey,
        decision: 'broadcast',
        title: feed.summaryTitle || '',
        url: feed.summaryUrl,
        source: feed.source || '',
        summaryKind: feed.summaryKind || '',
        scheduleStatus: pending.scheduleStatus || '',
        officialScore: pending.officialScore || '',
        matchKey
      });
      try {
        innerLife?.noteLegacyShare?.({ moduleId: 's16', facetId: 'news', url: feed.summaryUrl, title: feed.summaryTitle || '', text: feed.summary || '', at: now });
      } catch {}
      triggered += 1;
      log(`[subscription] 触发 S16 播报 ${key}：${String(feed.summaryTitle || '').slice(0, 60)}`);
      void sendWakePrompt(key, 'subscription').catch((error) => log(`[subscription] 唤醒失败 ${key}:`, error?.message ?? error));
    }
    esportsBroadcastInfo = triggered ? `已触发 ${triggered} 个会话` : (lastSkip || '没有符合条件的订阅');
  }

  function esportsFeedRelevant(key, st) {
    if (!esportsFeed && !esportsSchedule.matches.length && !esportsScheduleBlock()) return false;
    // 订阅了赛果的群，每次唤醒都给最新赛果，避免只靠旧上下文里的赛程“主动播报”。
    const subscribed = (Array.isArray(cfg.simulation?.subscriptions) ? cfg.simulation.subscriptions : [])
      .some((sub) => sub && sub.enabled !== false && String(sub.key || '') === key);
    if (subscribed) return true;
    // 以自己刚说过的话也算话题线索：否则她上一轮聊过 S16、下一轮主动开口时反而拿不到新赛果。
    const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .filter((m) => m)
      .slice(-8)
      .map((m) => String(m.plain || m.text || ''))
      .join(' ');
    const keywords = Array.isArray(st.wakeConfig?.triggers?.keywords) ? st.wakeConfig.triggers.keywords.join(' ') : '';
    return /S16|瑞士轮|世界赛|全球总决赛|LPL|LCK|赛果|比分|战况|战报|电竞|赛程|开赛|几点|几号|对阵|比赛时间/i.test(`${recent} ${formatMemory(st)} ${keywords}`);
  }

  function loadRemindersSafe() {
    try {
      reminderStore = loadReminderStore(REMINDERS_FILE);
      reminderStoreWritable = true;
    } catch (error) {
      reminderStoreWritable = false;
      reminderStore = { reminders: [] };
      log(`⚠️ 提醒文件读取失败，已降级为只读：${error?.message ?? error}`);
    }
  }

  function saveRemindersSafe() {
    if (!reminderStoreWritable) return;
    try {
      saveReminderStore(REMINDERS_FILE, reminderStore);
    } catch (error) {
      log(`⚠️ 提醒文件保存失败：${error?.message ?? error}`);
    }
  }

  function loadSubscriptionState() {
    const raw = readJsonSafe(SUBSCRIPTIONS_FILE, {});
    subscriptionState = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  }

  function saveSubscriptionState() {
    try { atomicWriteJson(SUBSCRIPTIONS_FILE, subscriptionState); } catch (error) {
      log(`⚠️ 订阅状态保存失败：${error?.message ?? error}`);
    }
  }

  function readBroadcastAuditLines() {
    try {
      return fs.readFileSync(ESPORTS_BROADCAST_AUDIT_FILE, 'utf8').split(/\r?\n/).filter((line) => line.trim());
    } catch (error) {
      if (error?.code !== 'ENOENT') log(`⚠️ 播报审计读取失败（按空审计处理）：${error?.message ?? error}`);
      return [];
    }
  }

  function appendBroadcastAudit(entry) {
    try {
      fs.mkdirSync(STATE_DIR, { recursive: true });
      fs.appendFileSync(ESPORTS_BROADCAST_AUDIT_FILE, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch (error) {
      log(`⚠️ 播报审计写入失败（不影响播报）：${error?.message ?? error}`);
      return;
    }
    pruneBroadcastAudit();
  }

  function pruneBroadcastAudit() {
    try {
      const lines = readBroadcastAuditLines();
      const kept = pruneAuditLines(lines, { now: Date.now(), maxAgeDays: 30, maxLines: 5000 });
      if (kept.length === lines.length) return;
      atomicWriteText(ESPORTS_BROADCAST_AUDIT_FILE, kept.length ? `${kept.join('\n')}\n` : '');
    } catch (error) {
      log(`⚠️ 播报审计裁剪失败（忽略）：${error?.message ?? error}`);
    }
  }

  function localDayKey() {
    return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' });
  }

  function reminderAllowed(key) {
    // 主人私聊永远可用；群聊必须在 config.json 的 simulation.reminders.allowedKeys 里显式登记
    // （源码里不写死任何群号，否则公开仓库会带出真实群 ID）。
    if (key === `private:${String(cfg.ownerQQ ?? '')}`) return true;
    const list = cfg.simulation?.reminders?.allowedKeys;
    return Array.isArray(list) && list.includes(key);
  }

  function checkAgentTool(req, key, flag) {
    const token = String(req.headers['x-agent-token'] ?? '').trim();
    if (!token) return '缺少 agent token';
    const st = simulation.conversations.get(key);
    const expected = st?.agentToken ? String(st.agentToken) : '';
    if (!expected) return 'agent token 无效';
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return 'agent token 无效';
    if (!isSessionAllowedInCurrentMode(key)) return '目标不在当前模式允许范围内';
    if (!simulationToolEnabled(flag)) return `工具未启用：${flag}`;
    if (currentMode !== 'simulation') return '该接口仅 simulation 模式可用';
    return '';
  }

  function buildFeatureOverview() {
    const rs = readRoleState();
    const nightQuiet = nightQuietConfig();
    const groups = (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : []).map((id) => {
      const key = `group:${id}`;
      const profile = cfg.simulation?.groupProfiles?.[key] ?? null;
      return {
        key,
        name: conversationDisplayName(key),
        label: profile?.label || '',
        proactive: profile?.proactive !== false
      };
    });
    const subs = (Array.isArray(cfg.simulation?.subscriptions) ? cfg.simulation.subscriptions : [])
      .filter((sub) => sub && sub.enabled !== false)
      .map((sub) => ({ key: sub.key, topic: sub.topic || 's16' }));
    const pendingReminders = reminderStore.reminders.filter((r) => r.status === 'pending').length;
    const voiceOn = cfg.simulation?.voice?.enabled !== false;
    const innerOn = cfg.simulation?.innerLife?.enabled !== false;
    const searchProvider = String(cfg.webSearch?.provider || 'auto');
    return {
      ok: true,
      generatedAt: new Date().toISOString(),
      identity: {
        nickname: selfDisplayName || currentRoleName() || '小鲸鱼',
        role: rs.role ?? null,
        mode: currentMode,
        ownerQQ: cfg.ownerQQ ?? null
      },
      model: {
        provider: String(cfg.dsh?.provider || 'deepseek-official'),
        model: String(cfg.dsh?.model || 'deepseek-flash'),
        reasoningEffort: String(cfg.dsh?.reasoningEffort || 'max')
      },
      groups,
      counts: {
        sessions: Object.keys(state.sessions || {}).length,
        images: imageEntries.length,
        stickers: stickerEntries.length,
        pendingReminders,
        subscriptions: subs.length
      },
      features: [
        {
          title: '人格与聊天',
          items: [
            { name: '群聊 / 私聊', status: 'on', desc: '白名单内的群和主人私聊；支持 @、名字、关键词、提问、拍一拍和概率唤醒。' },
            { name: '人格自动刷新', status: 'on', desc: '角色卡变化时自动注入新卡；每轮带人格内核，不用手动清上下文。' },
            { name: '可变人格状态', status: 'on', desc: '心情、精力、兴趣、最近学到和口癖会随反思缓慢变化，并影响语气和话题。' },
            { name: '多人群聊', status: 'on', desc: '优先用 QQ 引用回复区分对象；回复后自动销账未读，不补旧消息。' }
          ]
        },
        {
          title: '表情 / 图片 / 视觉',
          items: [
            { name: '直接识图', status: 'on', desc: '取图工具直接返回原图给 DeepSeek，不经过外部视觉描述中转。' },
            { name: '原生收藏表情', status: 'on', desc: '按语境选择并发送原生 QQ 收藏表情；支持收藏网图/群友图片。' },
            { name: '通用图片库', status: 'on', desc: '可搜索、发送、保存、配文；当前图库有图片。' },
            { name: '看图接梗', status: 'on', desc: '梗图优先回原生表情；截图/照片用一句话接。' }
          ]
        },
        {
          title: '语音',
          items: [
            { name: '中文语音', status: voiceOn ? 'on' : 'off', desc: 'BreezeTTS2 Voice Design 合成，固定中文声线，柔和/冷傲自动或手动切换。' },
            { name: '语音频率', status: voiceOn ? 'limited' : 'off', desc: '只在高价值场景使用；同会话有频率限制，失败不假装。' }
          ]
        },
        {
          title: '内心生活',
          items: [
            { name: '反思与成长', status: innerOn ? 'on' : 'off', desc: '凌晨反思群聊，更新心情/精力/兴趣/学习/口癖，变化有上限。' },
            { name: '好奇分享', status: innerOn ? 'on' : 'off', desc: '抓取候选见闻，挑有意思的带链接分享；每天有上限。' },
            { name: 'QQ 空间', status: innerOn ? 'on' : 'off', desc: '偶尔发碎碎念/见闻/生活小事，可配图；前几条需主人审核，之后自动。' },
            { name: '记忆', status: 'on', desc: '话题、想说未说的话、群友印象，以及跨私聊/群聊共享的个人记忆。' }
          ]
        },
        {
          title: '生活技能',
          items: [
            { name: '提醒', status: 'limited', desc: '默认只允许主人私聊和家人群；到点直接发预设提醒。' },
            { name: '天气', status: 'on', desc: 'Open-Meteo；按城市返回当前天气和今日温度/降水。' },
            { name: 'S16/LPL 订阅', status: subs.length ? 'on' : 'off', desc: '直播吧赛果源；只播真正赛果，带日期和旧赛程校验。' },
            { name: '小游戏', status: 'on', desc: '猜拳、骰子、今日运势；有冷却，结合当前心情/精力。' }
          ]
        },
        {
          title: '搜索与实时信息',
          items: [
            { name: '通用搜索', status: 'on', desc: `当前 provider=${searchProvider}；有 DeepSeek Key 走原生搜索，否则 Bing 兜底。` },
            { name: '赛果数据源', status: 'on', desc: '直播吧公开页面独立抓取，不依赖通用搜索。' }
          ]
        },
        {
          title: '控制台与监控',
          items: [
            { name: '控制台', status: 'on', desc: '会话/审批、角色、工具、群风格、黑话、图库、语音、token 花费。' },
            { name: '实时监控页', status: 'on', desc: '/live 只读像素状态页：心情、精力、兴趣、会话、健康、延迟、token；像素形象随心情和精力切换。' }
          ]
        }
      ],
      // 模块级总开关的实时状态：默认全关，控制台「功能控制」据此显示。
      modules: FEATURE_MODULES.map((item) => ({
        ...item,
        enabled: featureEnabled(cfg, item.id)
      })),
      limits: [
        '通用搜索当前没有 DeepSeek 搜索 Key 时会回退 Bing。',
        '提醒默认只在主人私聊和家人群可用。',
        `夜间静默 ${nightQuiet.start}-${nightQuiet.end}：只响应 @/名字/关键词/提问/拍一拍/私聊，暂停主动开话题和概率唤醒。`,
        '家人群主动开话题关闭。',
        'S16 订阅只在配置指定的群生效。',
        'QQ 表情回应、改群名片/群公告/精华消息当前网关不支持。',
        '识图中转已删除；主模型若变为纯文本，需要重新引入视觉描述。'
      ]
    };
  }

  function ownerFeaturesConfig() {
    const raw = cfg.simulation?.ownerFeatures;
    return raw && typeof raw === 'object'
      ? { enabled: raw.enabled !== false, modules: raw.modules && typeof raw.modules === 'object' ? raw.modules : {} }
      : { enabled: false, modules: {} };
  }

  function loadOwnerFeatureState() {
    const raw = readJsonSafe(OWNER_FEATURES_FILE, {}) || {};
    return {
      version: 1,
      features: raw.features && typeof raw.features === 'object' ? raw.features : {}
    };
  }

  function saveOwnerFeatureState(state) {
    atomicWriteJson(OWNER_FEATURES_FILE, state);
  }

  function featureNextAt(feature, now = Date.now()) {
    return nextOwnerFeatureRuns(feature, now, 1)[0] || 0;
  }

  async function runOwnerFeature(feature) {
    const key = feature.targets[0];
    if (feature.action.type === 'qzone_post') {
      if (!featureEnabled(cfg, 'qzone')) return { status: 'disabled', reason: 'features.qzone=false' };
      return postQzoneNow(feature.action.text, { manual: true, notify: false, imageRef: feature.action.image || '' });
    }
    if (feature.action.type === 'send_voice') {
      if (!featureEnabled(cfg, 'voice')) return { status: 'disabled', reason: 'features.voice=false' };
      if (!key || !isSessionAllowedInCurrentMode(key)) return { status: 'blocked' };
      const voice = await synthesizeFeatureVoice({
        text: feature.action.text,
        mood: feature.action.mood || '',
        cfg,
        outDir: path.join(ROOT, 'audio', 'tts'),
        customRole: isCustomRoleName(currentRoleName())
      });
      await sendVoiceFile(key, voice.path, { guard: true });
      return { status: 'sent', voice: voice.path, mood: voice.mood };
    }
    if (!key || !isSessionAllowedInCurrentMode(key)) return { status: 'blocked' };
    if (isNightQuietNow()) return { status: 'quiet' };
    const ok = await auditAndSend(key, feature.action.text, { dedupeKey: `ownerFeature:${feature.id}:${Math.floor(Date.now() / 60000)}` });
    return { status: ok ? 'sent' : 'failed' };
  }

  function writeShareModuleConfig(id, module) {
    const configFile = path.join(ROOT, 'config.json');
    const file = readConfigObject(configFile);
    if (!file.simulation?.shareModules?.modules?.[id]) return { ok: false, error: `模块 ${id} 不存在` };
    const patch = { [`simulation.shareModules.modules.${id}`]: module };
    const nextFile = applyConfigPatch(file, patch);
    nextFile.configVersion = CONFIG_VERSION;
    writeConfigFile(nextFile, { tag: 'share' });
    const merged = deepMergeConfig(cfg, applyConfigPatch({}, patch));
    for (const k of Object.keys(cfg)) delete cfg[k];
    Object.assign(cfg, merged);
    return { ok: true };
  }

  function writeOwnerFeatureModules(modules) {
    const configFile = path.join(ROOT, 'config.json');
    const file = readConfigObject(configFile);
    const patch = { 'simulation.ownerFeatures.enabled': true, 'simulation.ownerFeatures.modules': modules };
    const nextFile = applyConfigPatch(file, patch);
    nextFile.configVersion = CONFIG_VERSION;
    writeConfigFile(nextFile);
    const merged = deepMergeConfig(cfg, applyConfigPatch({}, patch));
    for (const k of Object.keys(cfg)) delete cfg[k];
    Object.assign(cfg, merged);
    return { ok: true };
  }

  function ownerFeatureAllowedTargets() {
    return [...(cfg.allow?.groups || []).map((id) => `group:${String(id).replace(/^group:/, '')}`), ...(cfg.allow?.private || []).map((id) => `private:${String(id).replace(/^private:/, '')}`), 'qzone', 'self'];
  }

  function ownerFeatureTargetLabels() {
    return Object.fromEntries(ownerFeatureAllowedTargets().filter((key) => key.includes(':')).map((key) => [key, conversationDisplayName(key)]));
  }

  function ownerFeaturesSnapshot() {
    const conf = ownerFeaturesConfig();
    const state = loadOwnerFeatureState();
    // 测试夹具会 eval 这段代码但不加载新依赖；这里做能力探测，真实桥接仍走 import。
    const caps = (() => { try { return typeof listOwnerCapabilities === 'function' ? listOwnerCapabilities() : []; } catch { return []; } })();
    let proposals = [];
    try {
      const dir = path.join(STATE_DIR, 'dev-proposals');
      proposals = listProposals(dir).map(proposalSummary);
    } catch {}
    return {
      enabled: conf.enabled,
      capabilities: caps,
      proposals,
      orchestrator: (() => { try { return queueSnapshot(path.join(STATE_DIR, 'orchestrator')); } catch { return { pending: 0, total: 0, tasks: [] }; } })(),
      features: Object.values(conf.modules).map((raw) => {
        if (typeof normalizeOwnerFeature !== 'function') return raw;
        const feature = normalizeOwnerFeature(raw, raw?.id);
        const st = state.features[feature.id] || {};
        return {
          id: feature.id,
          label: feature.label,
          type: feature.type,
          enabled: feature.enabled,
          targets: feature.targets,
          trigger: feature.trigger,
          action: feature.action,
          nextAt: Number(st.nextAt) || 0,
          lastAt: Number(st.lastAt) || 0,
          lastText: String(st.lastText || ''),
          lastError: String(st.lastError || ''),
          canRollback: Boolean(st.previous)
        };
      })
    };
  }

  async function maybeOwnerFeatureAutoReply(key, text) {
    if (!featureEnabled(cfg, 'ownerFeature')) return false;
    const conf = ownerFeaturesConfig();
    if (!conf.enabled) return false;
    const state = loadOwnerFeatureState();
    let dirty = false;
    for (const raw of Object.values(conf.modules)) {
      const feature = normalizeOwnerFeature(raw, raw?.id);
      if (feature.type !== 'auto_reply' || !feature.enabled || !feature.targets.includes(key)) continue;
      if (!['send_text', 'send_voice'].includes(feature.action.type)) continue;
      if (!feature.trigger.keywords.some((word) => word && text.includes(word))) continue;
      const st = state.features[feature.id] || {};
      if (st.lastAt && Date.now() - st.lastAt < 60000) return true;
      try {
        let ok = false;
        if (feature.action.type === 'send_voice') {
          if (!featureEnabled(cfg, 'voice')) continue;
          const voice = await synthesizeFeatureVoice({ text: feature.action.text, mood: feature.action.mood || '', cfg, outDir: path.join(ROOT, 'audio', 'tts'), customRole: isCustomRoleName(currentRoleName()) });
          await sendVoiceFile(key, voice.path, { guard: true });
          ok = true;
        } else {
          ok = await auditAndSend(key, feature.action.text, { dedupeKey: `ownerFeature:${feature.id}:${Math.floor(Date.now() / 60000)}` });
        }
        state.features[feature.id] = { ...st, lastAt: Date.now(), lastText: feature.action.text.slice(0, 120), lastError: ok ? '' : 'send-blocked' };
        dirty = true;
        if (ok) return true;
      } catch (error) {
        state.features[feature.id] = { ...st, lastError: error?.message ?? String(error) };
        dirty = true;
      }
    }
    if (dirty) saveOwnerFeatureState(state);
    return false;
  }

  async function notifyDevProposalResults() {
    const ownerKey = cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';
    if (!ownerKey) return;
    const dir = path.join(STATE_DIR, 'dev-proposals');
    const orchDir = path.join(STATE_DIR, 'orchestrator');
    for (const item of listProposals(dir)) {
      const result = item.result;
      const text = notificationFor(result);
      if (!text) continue;
      // 通知失败最多重试一次：30 秒一轮的无限重试会把网关超时放大成消息风暴。
      const attempts = Number(result.notifyAttempts) || 0;
      if (attempts >= 2) continue;
      try {
        await sendToQQ(ownerKey, text);
        writeResult(dir, item.id, { ...result, notified: true, notifiedAt: Date.now(), notifyAttempts: attempts + 1 });
        try {
          requestWake(orchDir, { taskId: item.id, reason: `result:${result.status}` });
        } catch {}
        try {
          const woke = wakeControllerViaCli({ dir: orchDir, reason: `result:${result.status}`, taskId: item.id });
          if (woke.ok) log(`[orchestrator] 已用 CLI 唤醒主控复核结果（pid ${woke.pid || '?'}）`);
          else if (woke.blocked) log(`[orchestrator] 结果回执已排队：主控唤醒被 ${woke.blocked.outcome} 阻塞`);
        } catch {}
      } catch (error) {
        const next = attempts + 1;
        try { writeResult(dir, item.id, { ...result, notifyAttempts: next, notifyError: String(error?.message ?? error) }); } catch {}
        log(`[devProposal] ${item.id} 结果通知失败（第 ${next}/2 次）：${error?.message ?? error}`);
      }
    }
  }

  async function processOwnerFeatureJobs() {
    if (!featureEnabled(cfg, 'ownerFeature')) return;
    const conf = ownerFeaturesConfig();
    if (!conf.enabled) return;
    const state = loadOwnerFeatureState();
    const now = Date.now();
    let dirty = false;
    for (const raw of Object.values(conf.modules)) {
      const feature = normalizeOwnerFeature(raw, raw?.id);
      if (!feature.enabled) continue;
      const st = state.features[feature.id] && typeof state.features[feature.id] === 'object' ? state.features[feature.id] : {};
      let nextAt = Number(st.nextAt) || 0;
      if (!nextAt) {
        nextAt = featureNextAt(feature, now);
        if (!nextAt) {
          state.features[feature.id] = { ...st, nextAt: 0, lastError: '已完成（一次性功能）' };
          dirty = true;
          continue;
        }
        state.features[feature.id] = { ...st, nextAt };
        dirty = true;
      }
      if (nextAt > now) continue;
      try {
        const result = await runOwnerFeature(feature);
        const current = state.features[feature.id] || {};
        if (result?.status === 'sent' || result?.status === 'posted') {
          state.features[feature.id] = {
            ...current,
            nextAt: featureNextAt(feature, now + 1000),
            lastAt: now,
            lastText: feature.action.text.slice(0, 120),
            lastError: ''
          };
          log(`[ownerFeature] ${feature.id} → ${result.status}`);
        } else {
          state.features[feature.id] = {
            ...current,
            nextAt: now + 5 * 60 * 1000,
            lastError: result?.error || result?.status || 'not-sent'
          };
        }
      } catch (error) {
        state.features[feature.id] = {
          ...(state.features[feature.id] || {}),
          nextAt: now + 5 * 60 * 1000,
          lastError: error?.message ?? String(error)
        };
        log(`[ownerFeature] ${feature.id} 失败：${error?.message ?? error}`);
      }
      dirty = true;
    }
    if (dirty) saveOwnerFeatureState(state);
  }


  async function processDueReminders() {
    if (cfg.simulation?.reminders?.enabled === false || !reminderStoreWritable) return;
    const due = dueReminders(reminderStore, Date.now(), 5);
    if (!due.length) return;
    const overdueGraceMs = Math.max(60000, Number(cfg.simulation?.reminders?.overdueGraceMs) || 6 * 3600 * 1000);
    for (const item of due) {
      if (Date.now() - item.dueAt > overdueGraceMs) {
        item.status = 'failed';
        item.lastAttemptAt = Date.now();
        log(`[reminder] 已过期超过 ${Math.round(overdueGraceMs / 3600000)}h，丢弃 ${item.id} ${item.key}`);
        saveRemindersSafe();
        continue;
      }
      if (currentMode !== 'simulation' || !isSessionAllowedInCurrentMode(item.key)) {
        item.status = 'failed';
        item.attempts += 1;
        item.lastAttemptAt = Date.now();
        log(`[reminder] 目标会话不可用，跳过 ${item.id} ${item.key}`);
        saveRemindersSafe();
        continue;
      }
      if (shouldBlockSilentReply(item.key)) {
        // 静默模式是操作者的明确选择；保留提醒，等静默结束后再发。
        item.lastAttemptAt = Date.now();
        continue;
      }
      try {
        const ok = await auditAndSend(item.key, item.text);
        item.lastAttemptAt = Date.now();
        if (ok) {
          item.status = 'sent';
          log(`[reminder] 已发送 ${item.id} ${item.key}`);
          appendActivity(`${item.key} [reminder] 提醒已发送：${item.text.slice(0, 60)}`);
        } else {
          item.status = 'failed';
          log(`[reminder] 发送被拦截 ${item.id} ${item.key}`);
        }
      } catch (error) {
        item.attempts += 1;
        item.lastAttemptAt = Date.now();
        if (item.attempts >= 3) item.status = 'failed';
        log(`[reminder] 发送失败 ${item.id} ${item.key}:`, error?.message ?? error);
      }
      saveRemindersSafe();
    }
  }

  /**
   * 提醒的统一任务处理器。
   * 发送走 outbox（dedupeKey=reminder:<id>），所以任务重试与出站重试不会叠加成两条。
   */
  async function handleReminderJob(job) {
    const reminderId = String(job?.payload?.reminderId ?? '');
    const item = reminderStore.reminders.find((r) => r.id === reminderId);
    if (!item || item.status !== 'pending') return { status: 'skip' };
    const now = Date.now();
    const overdueGraceMs = Math.max(60000, Number(cfg.simulation?.reminders?.overdueGraceMs) || 6 * 3600 * 1000);
    if (now - item.dueAt > overdueGraceMs) {
      item.status = 'failed';
      item.lastAttemptAt = now;
      saveRemindersSafe();
      log(`[reminder] 已过期超过 ${Math.round(overdueGraceMs / 3600000)}h，丢弃 ${item.id} ${item.key}`);
      return { status: 'expired' };
    }
    if (currentMode !== 'simulation' || !isSessionAllowedInCurrentMode(item.key)) {
      return { retryAfterMs: 5 * 60 * 1000 };
    }
    if (shouldBlockSilentReply(item.key)) {
      return { retryAfterMs: 10 * 60 * 1000 };
    }
    // 已经发出去过（崩溃后重放）：补状态，不重发。
    const prior = outbox?.findByDedupe(`reminder:${item.id}`);
    if (prior?.state === 'sent') {
      item.status = 'sent';
      item.lastAttemptAt = now;
      saveRemindersSafe();
      return { status: 'sent' };
    }
    const ok = await auditAndSend(item.key, item.text, { dedupeKey: `reminder:${item.id}` });
    item.lastAttemptAt = Date.now();
    if (ok) {
      item.status = 'sent';
      saveRemindersSafe();
      return { status: 'sent' };
    }
    const latest = outbox?.findByDedupe(`reminder:${item.id}`);
    if (latest && ['pending', 'sending'].includes(latest.state)) {
      // 出站队列会继续重试；任务先让位，避免两套重试互相抢。
      return { retryAfterMs: 60 * 1000 };
    }
    item.attempts += 1;
    if (item.attempts >= 3) {
      item.status = 'failed';
      saveRemindersSafe();
      log(`[reminder] 连续失败，已标记 failed ${item.id} ${item.key}`);
      return { status: 'failed' };
    }
    saveRemindersSafe();
    throw new Error('提醒发送失败，等待任务重试');
  }

  async function handleDailyReportJob(job) {
    const key = String(job?.key ?? job?.payload?.key ?? '');
    if (!featureEnabled(cfg, 'dailyReport')) return { status: 'disabled', reason: 'features.dailyReport=false' };
    if (!/^group:\d+$/.test(key) || !dailyReportEnabled(cfg, key)) return { status: 'disabled' };
    if (currentMode !== 'simulation' || !isSessionAllowedInCurrentMode(key)) return { retryAfterMs: 30 * 60 * 1000 };
    if (shouldBlockSilentReply(key)) return { retryAfterMs: 10 * 60 * 1000 };
    const date = String(job?.payload?.date || localDateKey());
    const st = getSimulationState(key);
    const report = buildDailyReport({
      key,
      messages: st.recentMessages,
      topics: st.activeTopics,
      now: Date.now(),
      maxItems: Number(cfg.simulation?.dailyReport?.maxItems) || 8
    });
    const ok = await auditAndSend(key, report.text, { dedupeKey: `dailyReport-send:${key}:${date}` });
    // 无论这次成功与否，都排好下一次（失败由任务重试，不会把系列打断）。
    const nextAt = nextDailyAt(cfg.simulation?.dailyReport?.at || '21:30', Date.now());
    jobQueue.enqueue({
      type: 'dailyReport',
      key,
      payload: { date: localDateKey(nextAt) },
      dedupeKey: `dailyReport:${key}:${localDateKey(nextAt)}`,
      runAfter: nextAt,
      maxAttempts: 3
    });
    if (!ok) throw new Error('日报发送未确认，等待重试');
    // 日报只保留 30 天：它是“回顾材料”，不是永久记忆；下次唤醒问到相关话题时
    // 仍能通过 FTS 检索到“那天群里在聊什么”，但不会无限堆积。
    if (memoryStore && cfg.simulation?.memory?.enabled !== false) {
      try {
        memoryStore.remember({
          scope: 'group',
          ownerKey: key,
          topic: '群日报',
          fact: report.text.replace(/\s+/g, ' ').slice(0, 300),
          source: 'daily-report',
          confidence: 0.55,
          expiresAt: Date.now() + 30 * 24 * 3600 * 1000
        });
      } catch (error) {
        log(`[memory] 日报入库失败（忽略）：${error?.message ?? error}`);
      }
    }
    log(`[dailyReport] ${key} 已发送（群消息 ${report.stats.human} 条，参与 ${report.stats.self} 条）`);
    return { status: 'sent' };
  }

  function syncDailyReportJobs() {
    if (!jobQueue || !featureEnabled(cfg, 'dailyReport') || cfg.simulation?.dailyReport?.enabled !== true) return 0;
    const keys = new Set((Array.isArray(cfg.simulation.dailyReport.groups) ? cfg.simulation.dailyReport.groups : []).map(String));
    for (const [key, profile] of Object.entries(cfg.simulation?.groupProfiles ?? {})) {
      if (profile?.dailyReport === true) keys.add(key);
    }
    let queued = 0;
    for (const key of keys) {
      if (!/^group:\d+$/.test(key) || !dailyReportEnabled(cfg, key)) continue;
      const at = nextDailyAt(cfg.simulation.dailyReport.at || '21:30');
      jobQueue.enqueue({
        type: 'dailyReport',
        key,
        payload: { date: localDateKey(at) },
        dedupeKey: `dailyReport:${key}:${localDateKey(at)}`,
        runAfter: at,
        maxAttempts: 3
      });
      queued += 1;
    }
    return queued;
  }

  // ── 出门见闻（读书线 + 视频字幕线，默认全关） ─────────────────────────────
  // 关闭时不写任何状态文件：store 的读方法返回安全默认，只有成功的 run 才落盘。
  const outerWorldStore = createOuterWorldStore({ dir: STATE_DIR });
  const outerWorldLimiter = createRateLimiter({ perDomainPerDay: 20, perSecond: 1 });
  const OUTER_WORLD_FETCH_CHARS = 512 * 1024;

  function outerWorldConfig() {
    const value = cfg.simulation?.outerWorld;
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  }

  function outerWorldEnabled() {
    return featureEnabled(cfg, 'outerWorld') && outerWorldConfig().leisure?.enabled === true;
  }

  /** 配置里的 sources 允许对象数组、JSON 字符串或逗号分隔地址；统一成 novel / video 源。 */
  function outerWorldSources(raw) {
    let list = raw;
    if (typeof list === 'string') {
      try {
        const parsed = JSON.parse(list);
        list = Array.isArray(parsed) ? parsed : [];
      } catch {
        list = list.split(/[,\n]/).map((item) => item.trim()).filter(Boolean);
      }
    }
    if (!Array.isArray(list)) return [];
    return list
      .map((item) => {
        const value = typeof item === 'string' ? { url: item } : item;
        if (value && String(value.type || '').toLowerCase() === 'video') {
          const url = String(value.url || '').trim();
          if (!url) return null;
          return { id: String(value.id || '').trim() || `video:${url}`, type: 'video', title: String(value.title || url).slice(0, 80), url, chapters: [] };
        }
        return normalizeNovelSource(value);
      })
      .filter(Boolean);
  }

  /** 与 readChapter 相同的章节定位，用于在抓取前做去重。 */
  function outerWorldTarget(source, progress) {
    const chapters = Array.isArray(source.chapters) ? source.chapters : [];
    const raw = Number(progress?.chapterIndex);
    const index = Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
    if (chapters.length > 0 && index >= chapters.length) return null;
    const url = chapters.length > 0 ? chapters[index]?.url : source.url;
    if (!url) return null;
    const title = (chapters.length > 0 ? chapters[index]?.title : '') || source.title;
    return { url, title, chapterIndex: index };
  }

  /** 抓正文：先过访问策略与域名限速，再由 safeFetch 做 SSRF 校验，限量 512KB。 */
  async function outerWorldFetchText(url) {
    const browse = outerWorldConfig().browse ?? {};
    const verdict = evaluateUrl(url, {
      policy: browse.policy,
      allowlist: browse.allowlist,
      blockedDomains: browse.blockedDomains
    });
    if (!verdict.allow) throw new Error(`policy:${verdict.reason}`);
    const limited = outerWorldLimiter.check(verdict.host);
    if (!limited.allow) throw new Error(`ratelimit:${limited.reason}`);
    const res = await safeFetch(verdict.url, OUTER_WORLD_FETCH_CHARS);
    if (Number(res.statusCode) < 200 || Number(res.statusCode) >= 300) throw new Error(`http:${res.statusCode}`);
    return res.body;
  }

  /** 摘要生成：复用内心会话；内心生活未挂载或显式关闭时返回 null，调用方直接跳过。 */
  function outerWorldGenerate() {
    if (!innerLife || typeof innerLife.runTurn !== 'function') return null;
    if (cfg.simulation?.innerLife?.enabled === false) return null;
    return (prompt) => innerLife.runTurn(prompt, 60000);
  }

  async function runOuterWorld(reason = 'manual', overrides = {}) {
    if (!outerWorldEnabled()) return { ok: false, enabled: false, reason: 'disabled' };
    const leisure = outerWorldConfig().leisure ?? {};
    const day = shanghaiDayKey();
    const quota = outerWorldStore.quota.get(day);
    const maxItems = Math.max(0, Math.floor(Number(leisure.maxItemsPerDay) || 0));
    if (maxItems > 0 && quota.items >= maxItems) return { ok: false, enabled: true, reason: 'quota', quota };
    const tokenBudget = Math.max(0, Math.floor(Number(leisure.tokenBudget) || 0));
    if (tokenBudget > 0 && quota.tokens >= tokenBudget) return { ok: false, enabled: true, reason: 'token-budget', quota };
    if (outerWorldStore.circuit.isOpen()) return { ok: false, enabled: true, reason: 'circuit-open', circuit: outerWorldStore.circuit.get() };
    // 每轮消化的字符预算：单页连续阅读与旧数据迁移共用同一个量。
    const digestChars = digestBudget(leisure.digestChars);
    const configuredSources = outerWorldSources(leisure.sources);
    // 旧语义读一轮就把单页来源标 done 且没有 charOffset；这里先纠偏，让见闻线继续走下去。
    migrateLegacySegmentedProgress({ sources: configuredSources, store: outerWorldStore, digestChars });
    const sources = configuredSources
      .filter((source) => outerWorldStore.progress.get(source.id)?.done !== true);
    const skip = (skipReason) => {
      outerWorldStore.audit.append({ kind: 'skip', reason: skipReason, trigger: reason });
      return { ok: true, enabled: true, skipped: true, reason: skipReason };
    };
    if (!sources.length) return skip('no-source');
    const source = pickNextSource({ sources, store: outerWorldStore, now: () => Date.now() });
    if (!source) return skip('no-candidate');
    const progress = outerWorldStore.progress.get(source.id) || {};
    const target = outerWorldTarget(source, progress);
    if (!target) return skip('no-target');
    const hasChapters = Array.isArray(source.chapters) && source.chapters.length > 0;
    // 单页长篇按字符偏移连续分段；章节/字幕来源不进这个分支。
    const segmented = isSegmentedSource(source);
    const charOffset = readCharOffset(progress, segmented);
    const noteKey = segmentDedupeKey({ title: target.title, url: target.url, chapterIndex: target.chapterIndex, segmented });
    if (outerWorldStore.notes.dedupeHas(noteKey)) {
      // 命中去重时分段来源只推进偏移，不能像旧语义那样直接判完结。
      const patch = {
        chapterIndex: target.chapterIndex + 1,
        lastReadAt: Date.now(),
        title: String(source.title || target.title || ''),
        chaptersTotal: Array.isArray(source.chapters) ? source.chapters.length : 0
      };
      if (segmented) patch.charOffset = charOffset + digestChars;
      else if (source.type === 'video') patch.done = true;
      outerWorldStore.progress.set(source.id, patch);
      return skip('duplicate');
    }
    const generate = typeof overrides.generate === 'function' ? overrides.generate : outerWorldGenerate();
    if (!generate) return skip('no-generator');
    const fetchText = typeof overrides.fetchText === 'function' ? overrides.fetchText : outerWorldFetchText;
    try {
      let chapter;
      if (source.type === 'video') {
        // 字幕线：只取字幕轨，不下载视频；缺 yt-dlp 或无字幕时按失败退避，不吞掉。
        const sub = await fetchSubtitleTrack({
          url: source.url,
          workDir: path.join(STATE_DIR, 'outer-world', 'tmp'),
          ytDlpPath: String(leisure.ytDlpPath || '').trim(),
          lang: String(leisure.subtitleLang || 'zh-Hans'),
          timeoutMs: Math.min(120000, Math.max(10000, Number(leisure.subtitleTimeoutMs) || 60000))
        });
        if (!sub.ok) throw Object.assign(new Error(sub.reason || 'subtitle-failed'), { outerReason: `subtitle:${sub.reason || 'failed'}` });
        chapter = { ok: true, sourceId: source.id, chapterIndex: 0, title: source.title, url: source.url, text: sub.text, nextProgress: { chapterIndex: 1, done: true } };
      } else {
        chapter = await readChapter({ source, progress, fetchText });
      }
      if (!chapter.ok) throw Object.assign(new Error(chapter.reason || 'read-failed'), { outerReason: chapter.reason || 'read-failed' });
      const bodyText = pickBodyText(chapter.text);
      if (segmented && charOffset >= bodyText.length) {
        // 偏移已越过正文末尾（如旧数据迁移的书整本不足一轮消化量）：补记完结，不再产出卡片。
        outerWorldStore.progress.set(source.id, {
          chapterIndex: target.chapterIndex,
          charOffset,
          lastReadAt: Date.now(),
          done: true,
          title: String(source.title || target.title || ''),
          totalChars: bodyText.length,
          chaptersTotal: 0
        });
        return skip('finished');
      }
      // 裁剪完成后再取偏移，保证 charOffset 始终相对同一份裁剪后正文。
      const chunks = chunkText(segmented ? bodyText.slice(charOffset) : bodyText, { maxChars: 1200 });
      const material = limitDigestChunks(chunks, digestChars);
      const digest = await digestChunks({ chunks: material.chunks, generate, noteChars: Math.max(1, Number(leisure.noteChars) || 600) });
      if (!digest.ok) throw Object.assign(new Error('digest-failed'), { outerReason: 'digest-failed' });
      const tokens = Math.max(1, Math.ceil((material.chars + digest.summary.length) / 4));
      if (tokenBudget > 0 && quota.tokens + tokens > tokenBudget) return skip('token-budget');
      const note = {
        title: chapter.title || target.title,
        sourceId: source.id,
        sourceType: source.type || 'url',
        chapterIndex: chapter.chapterIndex,
        summary: digest.summary,
        quote: digest.quote,
        dedupeKey: noteKey,
        sourceHost: redactUrlForAudit(chapter.url || target.url),
        at: Date.now()
      };
      const appended = outerWorldStore.notes.append(note);
      outerWorldStore.notes.dedupeAdd(noteKey);
      const nextIndex = chapter.nextProgress?.chapterIndex ?? target.chapterIndex + 1;
      const nextOffset = charOffset + material.chars;
      // 章节来源按章数收尾；分段来源只有偏移走到裁剪后正文末尾才完结；字幕来源走 nextProgress.done。
      const finished = isSourceFinished({
        segmented,
        hasChapters,
        nextIndex,
        chapterCount: hasChapters ? source.chapters.length : 0,
        nextOffset,
        bodyLength: bodyText.length,
        doneBySource: chapter.nextProgress?.done === true
      });
      outerWorldStore.progress.set(source.id, {
        chapterIndex: nextIndex,
        title: String(source.title || target.title || ''),
        chaptersTotal: hasChapters ? source.chapters.length : 0,
        lastReadAt: Date.now(),
        ...(segmented ? { charOffset: nextOffset, totalChars: bodyText.length } : {}),
        ...(finished ? { done: true } : {})
      });
      outerWorldStore.quota.inc(day, { items: 1, tokens, chars: material.chars });
      outerWorldStore.audit.append({ kind: 'read', sourceId: source.id, host: note.sourceHost, chapterIndex: note.chapterIndex, tokens, trigger: reason, noteId: appended.id });
      outerWorldStore.circuit.ok();
      if (outerWorldConfig().digest?.pushToOwner === true && ownerChatKey()) {
        try { await sendToQQ(ownerChatKey(), `出门见闻：${note.title}\n${note.summary}`); } catch {}
      }
      return { ok: true, enabled: true, note: { ...note, id: appended.id } };
    } catch (error) {
      const failed = error?.outerReason || String(error?.message ?? error).slice(0, 120);
      outerWorldStore.circuit.fail(failed);
      outerWorldStore.audit.append({ kind: 'fail', sourceId: source.id, reason: failed, trigger: reason });
      return { ok: false, enabled: true, reason: failed };
    }
  }

  /** 提示词只给最近一张卡片的标题 + 一句摘要；不带网址、不带原文。 */
  function outerWorldPromptLine() {
    if (!outerWorldEnabled()) return '';
    const cutoff = Date.now() - 24 * 3600 * 1000;
    const note = outerWorldStore.notes.list({ limit: 10 }).find((row) => (Number(row.at) || 0) >= cutoff);
    if (!note) return '';
    const title = String(note.title || '').trim().slice(0, 60);
    const summary = String(note.summary || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    return `【出门见闻】你最近看了《${title}》：${summary}。自然聊到再提，不主动刷屏。\n\n`;
  }

  function outerWorldNotesText(limit = 5) {
    const rows = outerWorldStore.notes.list({ limit: Math.max(1, Number(limit) || 5) });
    if (!rows.length) return '还没有出门见闻。先打开「出门见闻」并配置阅读来源。';
    return ['最近见闻：', ...rows.map((row, index) => {
      const when = new Date(Number(row.at) || Date.now()).toLocaleString('zh-CN', { hour12: false });
      return `${index + 1}. [${String(row.id).slice(0, 8)}] ${when} 看了《${row.title}》：${row.summary}`;
    })].join('\n');
  }

  function outerWorldNoteDetail(prefix) {
    const want = String(prefix ?? '').trim().toLowerCase();
    if (!want) return '';
    const hits = outerWorldStore.notes.list({ limit: 200 })
      .filter((row) => String(row.id).toLowerCase().startsWith(want));
    if (!hits.length) return `没有找到 id 前缀「${want}」的见闻。`;
    if (hits.length > 1) return `「${want}」同时匹配 ${hits.length} 条，请把 id 打长一点。`;
    const note = hits[0];
    const when = new Date(Number(note.at) || Date.now()).toLocaleString('zh-CN', { hour12: false });
    return [`【见闻 ${note.id}】`, `${when} 看了《${note.title}》`, note.summary,
      note.quote ? `摘句：${note.quote}` : '', `来源：${note.sourceHost || '未知'}`]
      .filter(Boolean).join('\n');
  }

  /** 停止出门：打开熔断，清掉排队与历史失败；主人显式 /出门 会先 reset。 */
  function stopOuterWorld(reason = 'owner-stop') {
    for (let i = 0; i < 5 && !outerWorldStore.circuit.isOpen(); i += 1) outerWorldStore.circuit.fail(reason);
    const pending = jobQueue?.clearPending('outerWorld.run', '主人停止出门见闻') || 0;
    const dead = jobQueue?.clearDead?.('outerWorld.run', '主人停止出门见闻：历史失败不再重试') || 0;
    outerWorldStore.audit.append({ kind: 'stop', reason });
    return { cleared: pending + dead, circuit: outerWorldStore.circuit.get() };
  }

  /** 实时页/控制台共用的「她在读」快照：只读进度文件，旧数据不补写。 */
  function outerWorldReading() {
    try {
      const sources = outerWorldSources(outerWorldConfig().leisure?.sources);
      const progress = {};
      for (const source of sources) progress[source.id] = outerWorldStore.progress.get(source.id);
      return buildReadingSnapshot({ sources, progress });
    } catch {
      return [];
    }
  }

  function outerWorldStatus() {
    const leisure = outerWorldConfig().leisure ?? {};
    const quota = outerWorldStore.quota.get(shanghaiDayKey());
    const subtitle = probeSubtitleTool({ ytDlpPath: String(leisure.ytDlpPath || '').trim() });
    return {
      enabled: outerWorldEnabled(),
      day: shanghaiDayKey(),
      quota,
      reading: outerWorldReading(),
      readingToday: readingToday(quota),
      circuit: outerWorldStore.circuit.get(),
      subtitle,
      limits: {
        maxItemsPerDay: Number(leisure.maxItemsPerDay) || 0,
        noteChars: Number(leisure.noteChars) || 600,
        digestChars: digestBudget(leisure.digestChars),
        tokenBudget: Number(leisure.tokenBudget) || 0
      },
      noteCount: outerWorldStore.notes.list({ limit: 200 }).length
    };
  }

  const OUTER_WORLD_DAY_MS = 24 * 3600 * 1000;
  const OUTER_WORLD_NIGHT = 8 * 3600 * 1000;

  function outerWorldClock(hhmm, fallback) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm ?? '').trim());
    if (!match) return fallback;
    const minutes = Number(match[1]) * 60 + Number(match[2]);
    return minutes >= 0 && minutes < 24 * 60 ? minutes : fallback;
  }

  function outerWorldWindowAt(ms) {
    const window = outerWorldConfig().schedule?.window ?? {};
    const startMin = outerWorldClock(window.start, 9 * 60);
    const endMin = outerWorldClock(window.end, 23 * 60);
    const midnight = Math.floor((Number(ms) + OUTER_WORLD_NIGHT) / OUTER_WORLD_DAY_MS) * OUTER_WORLD_DAY_MS - OUTER_WORLD_NIGHT;
    const nowMin = Math.floor((Number(ms) - midnight) / 60000);
    const inside = endMin > startMin
      ? nowMin >= startMin && nowMin < endMin
      : nowMin >= startMin || nowMin < endMin;
    return { inside, midnight, startMin, startToday: midnight + startMin * 60000 };
  }

  /** 下一条见闻的时间：配额用满顺延到次日窗口；间隔不够就等满 minGap；熔断期 6h 后再试。 */
  function nextOuterWorldAt(nowMs = Date.now()) {
    const schedule = outerWorldConfig().schedule ?? {};
    if (outerWorldStore.circuit.isOpen()) return nowMs + 6 * 3600 * 1000;
    const leisure = outerWorldConfig().leisure ?? {};
    const maxItems = Math.max(0, Math.floor(Number(leisure.maxItemsPerDay) || 0));
    const quota = outerWorldStore.quota.get(shanghaiDayKey(nowMs));
    const gap = Math.max(60000, Number(schedule.minGapMs) || 7200000);
    const win = outerWorldWindowAt(nowMs);
    let at;
    if (maxItems > 0 && quota.items >= maxItems) {
      at = win.midnight + OUTER_WORLD_DAY_MS + win.startMin * 60000;
    } else {
      const lastAt = Number(outerWorldStore.notes.list({ limit: 1 })[0]?.at) || 0;
      at = Math.max(nowMs, lastAt ? lastAt + gap : 0);
      const check = outerWorldWindowAt(at);
      if (!check.inside) at = check.startToday <= at ? check.startToday + OUTER_WORLD_DAY_MS : check.startToday;
    }
    return Math.max(nowMs + 60 * 1000, at);
  }

  function syncOuterWorldJob() {
    // 审计文件只在启动/配置变更时裁一次，避免无限增长（30 天 / 最近 5000 行）。
    try { outerWorldStore.audit.prune({ days: 30, maxLines: 5000 }); } catch {}
    if (!jobQueue) return 0;
    if (!outerWorldEnabled()) {
      return (jobQueue.clearPending('outerWorld.run', '出门见闻已关闭') || 0)
        + (jobQueue.clearDead?.('outerWorld.run', '出门见闻已关闭：历史失败不再重试') || 0);
    }
    const at = nextOuterWorldAt();
    jobQueue.enqueue({ type: 'outerWorld.run', dedupeKey: 'outerWorld.run', runAfter: at, maxAttempts: 2 });
    return at;
  }

  // 配置热更新后重排所有受模块总开关影响的定时任务；关闭时排程会自行清空。
  function resyncFeatureSchedules(changed) {
    const keys = (Array.isArray(changed) ? changed : []).map(String);
    const touches = (prefix) => keys.some((key) => key === prefix || key.startsWith(`${prefix}.`));
    // 关掉群聊总闸或主动冒泡时，把已排队的冒泡定时器一并取消，避免关掉后还冒一次泡。
    if ((touches('simulation.enabled') || touches('simulation.proactive'))
      && (cfg.simulation?.enabled === false || cfg.simulation?.proactive?.enabled === false)) {
      cancelAllProactiveChecks('开关已关闭');
    }
    // 全局活跃控制切换：立刻按新模式清理/重排群聊定时器，而不是只等下一轮配置读取。
    if (touches('simulation.wake') || touches('simulation.activityControl') || touches('simulation.enabled')) {
      try { resyncActivityControl(); } catch (error) { log(`[features] 活跃控制重排失败：${error?.message ?? error}`); }
    }
    if (!keys.some((key) => key.startsWith('features.'))
      && !touches('simulation.innerLife')
      && !touches('simulation.shareModules')
      && !touches('simulation.signature')
      && !touches('simulation.outerWorld')
      && !touches('simulation.dailyReport')) return;
    try { innerLife?.reschedule?.(); } catch (error) { log(`[features] 内心生活排程刷新失败：${error?.message ?? error}`); }
    try { syncSignatureJob(); } catch (error) { log(`[features] 签名排程刷新失败：${error?.message ?? error}`); }
    try { syncDailyReportJobs(); } catch (error) { log(`[features] 日报排程刷新失败：${error?.message ?? error}`); }
    try { syncOuterWorldJob(); } catch (error) { log(`[features] 出门见闻排程刷新失败：${error?.message ?? error}`); }
  }

  // 控制台功能开关/高级设置共用的写配置入口：校验 → 落盘 → 热更新 → 重排排程。
  function applyConsoleConfigValues(values, { tag = 'features' } = {}) {
    const result = validateConfigPatch(cfg, values);
    if (!result.ok) return { ok: false, errors: result.errors };
    const configFile = path.join(ROOT, 'config.json');
    let file;
    try { file = readConfigObject(configFile); } catch (error) { return { ok: false, error: error?.message ?? String(error) }; }
    const nextFile = applyConfigPatch(file, result.values);
    nextFile.configVersion = CONFIG_VERSION;
    try { writeConfigFile(nextFile, { tag }); } catch (error) { return { ok: false, error: `写入 config.json 失败：${error?.message ?? error}` }; }
    const nested = applyConfigPatch({}, result.values);
    const merged = deepMergeConfig(cfg, nested);
    for (const key of Object.keys(cfg)) delete cfg[key];
    Object.assign(cfg, merged);
    resyncFeatureSchedules(Object.keys(result.values));
    const catalog = new Map(buildConfigSchema(cfg).fields.map((f) => [f.key, f]));
    const requiresRestart = Object.keys(result.values)
      .filter((key) => (catalog.get(key)?.restart ?? 'none') !== 'none')
      .map((key) => ({ key, scope: catalog.get(key)?.restart }));
    return { ok: true, applied: Object.keys(result.values), requiresRestart };
  }

  function syncReminderJobs() {    if (!jobQueue) return 0;
    let queued = 0;
    for (const item of reminderStore.reminders) {
      if (item.status !== 'pending') continue;
      const dedupeKey = `reminder:${item.id}`;
      const existing = jobQueue.findByDedupe(dedupeKey);
      if (existing && ['pending', 'running'].includes(existing.state)) continue;
      if (existing?.state === 'dead') {
        // 任务已经耗尽重试：不要每次启动都复活，标记提醒失败，交给 operator 处理。
        item.status = 'failed';
        continue;
      }
      jobQueue.enqueue({
        type: 'reminder.due',
        key: item.key,
        payload: { reminderId: item.id },
        dedupeKey,
        runAfter: item.dueAt,
        maxAttempts: 3
      });
      queued += 1;
    }
    saveRemindersSafe();
    return queued;
  }

  function startReminderLoop() {
    loadRemindersSafe();
    loadSubscriptionState();
    pruneBroadcastAudit();
    // 旧进程 fork 的唤醒没有退出回执，启动时对账一次，别让状态永远停在 running。
    try {
      const reconciled = reconcileInterruptedWake(path.join(STATE_DIR, 'orchestrator'));
      if (reconciled) log(`[orchestrator] 上次唤醒（${reconciled.lastReason || '未知'}）被重启打断，已标记 interrupted`);
    } catch {}
    // 主人功能独立调度：不依赖提醒任务队列，开关关闭时内部直接返回。
    setTimeout(() => void processOwnerFeatureJobs(), 6000).unref?.();
    setInterval(() => void processOwnerFeatureJobs(), 30000).unref?.();
    setInterval(() => void maybeSendMoodVoice(), Math.max(60000, Number(cfg.simulation?.moodVoice?.intervalMs) || 30 * 60 * 1000)).unref?.();
    setTimeout(() => void notifyDevProposalResults(), 8000).unref?.();
    setInterval(() => void notifyDevProposalResults(), 30000).unref?.();
    if (jobQueue) {
      const queued = syncReminderJobs();
      log(`[reminder] 持久化任务队列已接管${queued ? `（登记 ${queued} 条待发送）` : ''}`);
      return;
    }
    setTimeout(() => void processDueReminders(), 5000).unref?.();
    setInterval(() => void processDueReminders(), 30000).unref?.();
  }

  async function refreshLiveTts() {
    const breeze = cfg.tts?.breeze;
    const breezeBase = String(breeze?.baseUrl || '').replace(/\/+$/, '');
    if (breeze?.enabled !== false && breezeBase) {
      liveTtsProvider = 'breeze';
      try {
        const res = await fetch(`${breezeBase}/health`, { signal: AbortSignal.timeout(TUNNEL_HEALTH_TIMEOUT_MS) });
        liveTtsOnline = res.ok;
      } catch {
        liveTtsOnline = false;
      }
      liveTtsCheckedAt = Date.now();
      return;
    }
    liveTtsProvider = 'legacy';
    try {
      const base = String(cfg.tts?.baseUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '');
      const res = await fetch(`${base}/docs`, { signal: AbortSignal.timeout(2500) });
      liveTtsOnline = res.ok;
    } catch {
      liveTtsOnline = false;
    }
    liveTtsCheckedAt = Date.now();
  }

  async function ensureBreezeTunnel() {
    const breeze = cfg.tts?.breeze;
    const base = String(breeze?.baseUrl || '').replace(/\/+$/, '');
    if (!breeze || breeze.enabled === false || !base) return;
    const urls = [base, String(breeze.opusUrl || '').replace(/\/+$/, '')].filter(Boolean);
    const states = await Promise.all(urls.map(async (url) => {
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(TUNNEL_HEALTH_TIMEOUT_MS) });
        return res.ok;
      } catch {
        return false;
      }
    }));
    if (states.every(Boolean)) {
      if (tunnelFailStreak >= 2) log('[tts] Breeze 隧道已恢复');
      tunnelFailStreak = 0;
      return;
    }
    tunnelFailStreak += 1;
    // 慢链路上单次探测超时很常见；连续两次失败才判定掉线，避免反复重建与刷屏。
    if (tunnelFailStreak < 2) return;
    if (Date.now() - lastTunnelSpawnAt < 5 * 60 * 1000) return;
    lastTunnelSpawnAt = Date.now();
    try {
      const child = spawn(process.execPath, [path.join(ROOT, 'tools', 'ensure-breeze-tunnel.mjs')], {
        cwd: ROOT,
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });
      child.unref();
      log('[tts] Breeze 隧道离线，已触发自动重建');
    } catch (error) {
      log(`[tts] 自动重建隧道失败：${error?.message ?? error}`);
    }
  }

  function refreshLiveUsage() {
    try {
      const s = tokenLedger.summary({ limit: 1 });
      const t = s?.totals || {};
      liveUsage = {
        tokens: Number.isFinite(Number(t.totalTokens)) ? Number(t.totalTokens) : null,
        input: Number.isFinite(Number(t.inputTokens)) ? Number(t.inputTokens) : null,
        output: Number.isFinite(Number(t.buckets?.output)) ? Number(t.buckets.output) : null,
        cost: Number.isFinite(Number(t.cost)) ? Number(t.cost) : null,
        turns: Number.isFinite(Number(t.turns)) ? Number(t.turns) : null,
        estimated: t.estimated === true
      };
    } catch {
      liveUsage = null;
    }
    liveUsageAt = Date.now();
  }

  function buildOwnerRelationshipSnapshot() {
    if (!relationshipStore || !cfg.ownerQQ) return null;
    const ownerId = String(cfg.ownerQQ);
    const key = `private:${ownerId}`;
    const row = relationshipStore.get(key, ownerId);
    const round = (n) => Math.round(Number(n) * 10) / 10;
    const axes = row
      ? { affection: row.affection, trust: row.trust, familiarity: row.familiarity, rapport: row.rapport }
      : { affection: 95, trust: 100, familiarity: 100, rapport: 80 };
    return {
      name: '主人',
      stage: 5,
      stageLabel: '主人',
      bond: round(row?.bond ?? relationshipBond(axes)),
      affection: round(axes.affection),
      trust: round(axes.trust),
      familiarity: round(axes.familiarity),
      rapport: round(axes.rapport),
      interactions: Number(row?.interactionCount) || 0,
      tone: '可以黏、可以撒娇；被冷落最多追 2 次',
      lastDelta: row?.lastDelta ? {
        label: row.lastDelta.label,
        reason: row.lastDelta.reason,
        affection: round(row.lastDelta.deltas?.affection || 0),
        at: row.lastDelta.at
      } : null,
      sparkline: (relationshipStore.sparkline(key, ownerId, { days: 7 }) || []).map((d) => ({
        day: d.day, bond: d.bond, interactions: d.interactions
      }))
    };
  }

  function buildRelationshipSnapshot() {
    if (!relationshipStore || cfg.simulation?.relationships?.enabled === false) {
      return { enabled: false, groups: [], spotlight: null };
    }
    const limit = Math.max(1, Math.min(12, Number(cfg.simulation?.relationships?.liveLimit) || 6));
    const round = (n) => Math.round(Number(n) * 10) / 10;
    const hashId = (value) => `u-${crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 10)}`;
    const groups = [];
    for (const gid of (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [])) {
      const key = `group:${gid}`;
      if (!relationshipsEnabledForKey(key)) continue;
      const rows = relationshipStore.list(key, { limit: limit * 2 }).slice(0, limit);
      const series = rows.length ? relationshipStore.sparklines(key, rows.map((r) => r.userId), { days: 7 }) : {};
      const profile = cfg.simulation?.groupProfiles?.[key];
      const name = liveGroupNames.get(String(gid)) || String(profile?.label || '').trim() || '群聊';
      const members = rows.map((r) => ({
        id: hashId(r.userId),
        name: String(r.displayName || '群友').slice(0, 24),
        stage: r.stage,
        stageLabel: relationshipStageLabel(r.stage),
        bond: round(r.bond),
        affection: round(r.affection),
        trust: round(r.trust),
        familiarity: round(r.familiarity),
        rapport: round(r.rapport),
        interactions: r.interactionCount,
        tone: r.stage >= 4 ? '放松、会主动关心' : r.stage >= 3 ? '可接梗、用外号' : r.stage >= 2 ? '熟络、少量玩笑' : r.stage >= 1 ? '记得名字' : '礼貌、简短',
        lastDelta: r.lastDelta ? {
          label: r.lastDelta.label,
          reason: r.lastDelta.reason,
          affection: round(r.lastDelta.deltas?.affection || 0),
          bond: round((r.lastDelta.deltas?.affection || 0) * 0.45 + (r.lastDelta.deltas?.trust || 0) * 0.25
            + (r.lastDelta.deltas?.familiarity || 0) * 0.2 + (r.lastDelta.deltas?.rapport || 0) * 0.1),
          at: r.lastDelta.at
        } : null,
        sparkline: (series[r.userId] || []).map((d) => ({ day: d.day, bond: d.bond, interactions: d.interactions }))
      }));
      groups.push({
        id: `g-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 8)}`,
        name,
        members
      });
    }
    groups.sort((a, b) => (b.members[0]?.bond || 0) - (a.members[0]?.bond || 0));
    const spotlight = groups[0]?.members[0]
      ? { group: groups[0].name, ...groups[0].members[0] }
      : null;
    return { enabled: true, owner: buildOwnerRelationshipSnapshot(), groups, spotlight };
  }

  function buildContentSnapshot() {
    const inner = innerLife?.getState?.() ?? null;
    const shareCfg = cfg.simulation?.innerLife?.groupShare ?? {};
    const shareHistory = Array.isArray(inner?.history?.groupShares) ? inner.history.groupShares : [];
    const searchCfg = cfg.webSearch ?? {};
    const searchEnv = String(searchCfg.apiKeyEnv || '');
    const searchBase = (() => {
      try { return new URL(String(searchCfg.baseURL || '')).hostname; } catch { return ''; }
    })();
    const subState = subscriptionState && typeof subscriptionState === 'object' ? subscriptionState : {};
    return {
      serverNow: Date.now(),
      voiceStyle: voiceStyleSnapshot(cfg),
      expression: (() => {
        const convs = simulation?.conversations;
        if (!convs) return null;
        let lastStickerAt = 0;
        let lastImageAt = 0;
        let lastVoiceAt = 0;
        for (const st of convs.values()) {
          lastStickerAt = Math.max(lastStickerAt, Number(st?.lastStickerAt) || 0);
          lastImageAt = Math.max(lastImageAt, Number(st?.lastImageAt) || 0);
          lastVoiceAt = Math.max(lastVoiceAt, Number(st?.lastVoiceAt) || 0);
        }
        const sendCfg = cfg.simulation?.send ?? {};
        const voice = cfg.simulation?.voice ?? {};
        const share = cfg.simulation?.innerLife?.groupShare ?? {};
        const qzone = cfg.simulation?.innerLife?.qzone ?? {};
        return {
          lastStickerAt,
          lastImageAt,
          lastVoiceAt,
          caps: {
            sendPerMinute: Number(sendCfg.maxSendPerMinute) || 12,
            sendPerHour: Number(sendCfg.maxSendPerHour) || 120,
            voicePerMinute: Number(voice.maxPerMinute) || 6,
            voicePerHour: Number(voice.maxPerHour) || 60,
            sharePerDay: Number(share.maxPerDay) || 20,
            qzonePerDay: Number(qzone.maxPerDay) || 10
          }
        };
      })(),
      signature: {
        enabled: cfg.simulation?.signature?.enabled === true,
        llm: cfg.simulation?.signature?.llm !== false,
        minIntervalHours: Number(cfg.simulation?.signature?.minIntervalHours) || 12,
        maxIntervalHours: Number(cfg.simulation?.signature?.maxIntervalHours) || 48,
        requireApproval: cfg.simulation?.signature?.requireApproval !== false,
        lastText: signatureState.lastText || '',
        lastAppliedAt: Number(signatureState.lastAppliedAt) || 0,
        nextAt: Number(signatureState.nextAt) || 0,
        lastError: signatureState.lastError || ''
      },
      search: {
        provider: String(searchCfg.provider || 'auto'),
        model: String(searchCfg.model || ''),
        baseHost: searchBase,
        configured: Boolean(searchCfg.apiKey) || Boolean(searchEnv && process.env[searchEnv]),
        maxResults: Number(searchCfg.maxResults) || 8,
        maxUses: Number(searchCfg.maxUses) || 5,
        maxTokens: Number(searchCfg.maxTokens) || 4096,
        timeoutMs: Number(searchCfg.timeoutMs) || 35000
      },
      esports: {
        enabled: esportsFeedGateOpen(),
        refreshMs: Number(cfg.simulation?.esportsFeed?.refreshMs) || 300000,
        maxItems: Number(cfg.simulation?.esportsFeed?.maxItems) || 12,
        shareEnabled: cfg.simulation?.innerLife?.curiosity?.sources?.s16 !== false,
        loading: esportsFeedLoading === true,
        updatedAt: Number(esportsFeedAt) || 0,
        error: esportsFeedLastError || '',
        source: esportsFeed?.source || '',
        title: esportsFeed?.summaryTitle || '',
        kind: esportsFeed?.summaryKind || '',
        quality: esportsFeed?.summaryQuality || '',
        date: esportsFeed?.summaryDate || '',
        url: esportsFeed?.summaryUrl || '',
        broadcastCheckedAt: Number(esportsBroadcastAt) || 0,
        broadcastInfo: esportsBroadcastInfo || '',
        items: (esportsFeed?.items || []).slice(0, 8).map((item) => ({
          title: String(item?.title || '').slice(0, 160),
          url: String(item?.url || ''),
          date: String(item?.date || '')
        })),
        schedule: {
          updatedAt: Number(esportsSchedule.updatedAt) || 0,
          source: esportsSchedule.source || '',
          error: esportsSchedule.error || '',
          lines: typeof buildScheduleLines === 'function'
            ? buildScheduleLines({ matches: esportsSchedule.matches, now: Date.now(), days: 7, stageSchedule: STAGE_SCHEDULE }).lines
            : [],
          next: typeof nextScheduleMatch === 'function'
            ? nextScheduleMatch(esportsSchedule.matches, Date.now())
            : null
        }
      },
      subscriptions: (Array.isArray(cfg.simulation?.subscriptions) ? cfg.simulation.subscriptions : []).map((sub) => {
        const key = String(sub?.key || '');
        const stateKey = `${key}:${String(sub?.topic || 's16')}`;
        const st = subState[stateKey] || {};
        return {
          key,
          topic: String(sub?.topic || 's16'),
          enabled: sub?.enabled !== false,
          maxPerDay: Number(sub?.maxPerDay) || 2,
          minGapMs: Number(sub?.minGapMs) || 30 * 60 * 1000,
          lastAt: Number(st.lastAt) || 0,
          lastUrl: String(st.lastUrl || ''),
          day: String(st.day || ''),
          count: Number(st.count) || 0
        };
      }),
      share: {
        enabled: shareCfg.enabled !== false,
        target: String(shareCfg.target || ''),
        targets: Array.isArray(shareCfg.targets) && shareCfg.targets.length
          ? shareCfg.targets.map(String)
          : (shareCfg.target ? [String(shareCfg.target)] : []),
        maxPerDay: Number(shareCfg.maxPerDay) || 0,
        minGapMs: Number(shareCfg.minGapMs) || 0,
        idleMs: Number(shareCfg.idleMs) || 0,
        requireApproval: shareCfg.requireApproval === true,
        today: Number(inner?.counts?.groupShare) || 0,
        curiosityToday: Number(inner?.counts?.curiosity) || 0,
        nextAt: Number(inner?.next?.curiosity) || 0,
        last: shareHistory[0] ? {
          text: String(shareHistory[0].text || '').slice(0, 160),
          url: String(shareHistory[0].url || ''),
          at: Number(shareHistory[0].at) || 0,
          source: String(shareHistory[0].source || '')
        } : null,
        recent: shareHistory.slice(0, 5).map((item) => ({
          text: String(item?.text || '').slice(0, 160),
          url: String(item?.url || ''),
          at: Number(item?.at) || 0,
          target: String(item?.target || ''),
          source: String(item?.source || '')
        })),
        pendingShare: inner?.pendingShare ? {
          text: String(inner.pendingShare.text || '').slice(0, 300),
          target: String(inner.pendingShare.target || ''),
          url: String(inner.pendingShare.item?.url || ''),
          createdAt: Number(inner.pendingShare.createdAt) || 0,
          expiresAt: Number(inner.pendingShare.expiresAt) || 0
        } : null
      },
      aiTips: innerLife?.getAiTipsStatus?.() || null,
      shareModules: innerLife?.getShareModulesStatus?.() || null,
      ownerFeatures: ownerFeaturesSnapshot(),
      qzone: {
        enabled: cfg.simulation?.innerLife?.qzone?.enabled !== false,
        paused: inner?.qzone?.paused === true,
        today: Number(inner?.counts?.qzone) || 0,
        nextAt: Number(inner?.next?.qzone) || 0,
        requireApproval: cfg.simulation?.innerLife?.qzone?.requireApproval !== false,
        visibility: Number(cfg.simulation?.innerLife?.qzone?.visibility) || 1,
        maxPerDay: Number(cfg.simulation?.innerLife?.qzone?.maxPerDay) || 2,
        minGapMs: Number(cfg.simulation?.innerLife?.qzone?.minGapMs) || 0,
        maxChars: Number(cfg.simulation?.innerLife?.qzone?.maxChars) || 150,
        skipProbability: Number(cfg.simulation?.innerLife?.qzone?.skipProbability) || 0,
        approvalFirst: Number.isFinite(Number(cfg.simulation?.innerLife?.qzone?.approvalFirst)) ? Number(cfg.simulation.innerLife.qzone.approvalFirst) : 5,
        commentReplyEnabled: cfg.simulation?.innerLife?.qzone?.commentReply?.enabled !== false,
        commentReplyMaxPerDay: Number(cfg.simulation?.innerLife?.qzone?.commentReply?.maxPerDay) || 5,
        commentWatch: innerLife?.getQzoneCommentStatus?.() || null,
        approvedCount: Number(inner?.qzone?.approvedCount) || 0,
        auto: inner?.qzone?.auto === true,
        pendingDraft: inner?.pendingDraft ? {
          text: String(inner.pendingDraft.text || '').slice(0, 200),
          imageName: String(inner.pendingDraft.imageName || ''),
          createdAt: Number(inner.pendingDraft.createdAt) || 0,
          expiresAt: Number(inner.pendingDraft.expiresAt) || 0
        } : null,
        recent: (Array.isArray(inner?.history?.qzonePosts) ? inner.history.qzonePosts : [])
          .filter((post) => post && post.status !== 'dryRun')
          .slice(0, 3).map((post) => ({
          text: String(post?.text || '').slice(0, 160),
          at: Number(post?.at) || 0,
          status: String(post?.status || ''),
          image: String(post?.image || '')
        }))
      },
      allowGroups: Array.isArray(cfg.allow?.groups) ? cfg.allow.groups.map((id) => (/^group:/.test(String(id)) ? String(id) : `group:${id}`)) : [],
      stickerCollect: {
        enabled: stickerEnabled(),
        pending: (() => { try { return loadPendingStickers().length; } catch { return 0; } })()
      },
      library: {
        enabled: stickerEnabled(),
        stickers: Array.isArray(stickerEntries) ? stickerEntries.length : 0,
        images: Array.isArray(imageEntries) ? imageEntries.length : 0
      },
      crossChat: (() => {
        try { const t = listChatTargets(); return { groups: t.groups, privates: t.privates }; }
        catch { return { groups: [], privates: [] }; }
      })(),
      memory: {
        ...(memoryStore?.stats?.() ?? { enabled: false }),
        personalFacts: listPersonalFacts(8).map((fact) => ({ topic: fact.topic, fact: fact.fact, weight: fact.weight })),
        recentFacts: (memoryStore ? memoryStore.list({ limit: 12 }) : []).map((fact) => ({
          id: fact.id,
          scope: fact.scope,
          source: fact.source || '',
          topic: fact.topic || '',
          fact: fact.fact,
          weight: fact.weight,
          lastSeenAt: fact.lastSeenAt
        }))
      },
      dailyReport: {
        enabled: cfg.simulation?.dailyReport?.enabled === true,
        at: cfg.simulation?.dailyReport?.at || '21:30',
        groups: Array.isArray(cfg.simulation?.dailyReport?.groups) ? cfg.simulation.dailyReport.groups.length : 0
      },
      features: featureSnapshot(cfg)
    };
  }

  function buildFeatureControlSnapshot() {
    const snap = buildContentSnapshot();
    const qz = snap.qzone || {};
    const cw = qz.commentWatch || {};
    const sig = snap.signature || {};
    const sh = snap.share || {};
    const sm = snap.shareModules || {};
    const ai = snap.aiTips || {};
    const esp = snap.esports || {};
    const dr = snap.dailyReport || {};
    const of = snap.ownerFeatures || {};
    const schema = new Map(buildConfigSchema(cfg).fields.map((field) => [field.key, field]));
    const fmt = (ms) => (Number(ms) > 0
      ? new Date(Number(ms)).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
      : '');
    const targetList = Array.isArray(sh.targets) && sh.targets.length ? sh.targets : (sh.target ? [sh.target] : []);
    const dailyReportGroups = Array.isArray(cfg.simulation?.dailyReport?.groups) ? cfg.simulation.dailyReport.groups : [];
    const shareModuleList = Array.isArray(sm.modules) ? sm.modules : [];
    const shareModulesForFeature = (featureId) => {
      if (featureId === 'customShare') {
        const builtin = new Set(Object.keys(SHARE_MODULE_FEATURES));
        return shareModuleList.filter((module) => !builtin.has(String(module?.id || '')));
      }
      const moduleId = shareModuleIdForFeature(featureId);
      return moduleId ? shareModuleList.filter((module) => module.id === moduleId) : [];
    };
    const shareModuleStatus = (featureId, label) => {
      const list = shareModulesForFeature(featureId);
      if (!list.length) {
        return { line: featureId === 'customShare' ? '还没有自建分享模块；可在分享引擎面板里创建' : `还没有配置「${label}」模块`, tone: 'muted' };
      }
      const pending = list.filter((module) => module.pending).length;
      const paused = list.filter((module) => module.paused).length;
      const today = list.reduce((sum, module) => sum + (Number(module.today) || 0), 0);
      const nextAt = list.map((module) => Number(module.nextAt) || 0).filter(Boolean).sort((a, b) => a - b)[0] || 0;
      return {
        line: `今日 ${today} 条${nextAt ? ` · 下次 ${fmt(nextAt)}` : ''}${pending ? ` · ${pending} 条待确认` : ''}${paused ? ` · ${paused} 个暂停` : ''}`,
        tone: pending ? 'warn' : 'ok',
        attention: pending > 0
      };
    };
    const statusFor = (id) => {
      if (id === 'qzone') {
        if (qz.paused) return { line: '已暂停：回主人私聊「开说说」恢复', tone: 'warn', attention: true };
        if (qz.pendingDraft) return { line: `有 1 条草稿等你审核${qz.pendingDraft.expiresAt ? `（${fmt(qz.pendingDraft.expiresAt)} 前有效）` : ''}`, tone: 'warn', attention: true };
        if (qz.nextAt) return { line: `今日 ${qz.today ?? 0}/${qz.maxPerDay ?? 0} 条 · 下次 ${fmt(qz.nextAt)}`, tone: 'ok' };
        return { line: `今日 ${qz.today ?? 0}/${qz.maxPerDay ?? 0} 条 · 等待排期`, tone: 'muted' };
      }
      if (id === 'qzoneCommentReply') {
        if (cw.pendingReply) return { line: `有 1 条回复草稿等你确认${cw.pendingReply.expiresAt ? `（${fmt(cw.pendingReply.expiresAt)} 前有效）` : ''}`, tone: 'warn', attention: true };
        if (cw.lastCheckAt) return { line: `今日已回 ${cw.repliedToday ?? 0}/${cw.maxPerDay ?? 5} · 上次检查 ${fmt(cw.lastCheckAt)}`, tone: 'ok' };
        return { line: '还没有检查过评论', tone: 'muted' };
      }
      if (id === 'signature') {
        if (sig.pending) return { line: '有 1 条签名草稿等你确认', tone: 'warn', attention: true };
        if (sig.lastError) return { line: '上次更新没成功，稍后会自动重试', tone: 'warn', attention: true };
        if (sig.nextAt) return { line: `下次更换 ${fmt(sig.nextAt)}`, tone: 'ok' };
        return { line: '等待排期', tone: 'muted' };
      }
      if (id === 'voice') {
        return { line: `AI 语音每分钟最多 ${snap.expression?.caps?.voicePerMinute ?? 6} 条`, tone: 'ok' };
      }
      if (id === 'share') {
        if (sh.pendingShare) return { line: `有 1 条群分享草稿待确认${sh.pendingShare.expiresAt ? `（${fmt(sh.pendingShare.expiresAt)} 前有效）` : ''}`, tone: 'warn', attention: true };
        if (!targetList.length) return { line: '还没有选择目标群，暂时不会分享', tone: 'warn', attention: true };
        return { line: `今日 ${sh.today ?? 0}/${sh.maxPerDay ?? 0} 条 · ${targetList.length} 个目标群${sh.nextAt ? ` · 下次 ${fmt(sh.nextAt)}` : ''}`, tone: 'ok' };
      }
      if (id === 'shareModule') {
        const modules = Array.isArray(sm.modules) ? sm.modules : [];
        if (!modules.length) return { line: '还没有分享模块；可在主人私聊里创建', tone: 'muted' };
        const pending = modules.filter((m) => m.pending).length;
        const paused = modules.filter((m) => m.paused).length;
        const today = modules.reduce((n, m) => n + (Number(m.today) || 0), 0);
        return {
          line: `${modules.length} 个模块 · 今日共 ${today} 条${pending ? ` · ${pending} 条待确认` : ''}${paused ? ` · ${paused} 个暂停` : ''}`,
          tone: pending ? 'warn' : 'ok',
          attention: pending > 0
        };
      }
      if (id === 'aiTips') {
        if (ai.paused) return { line: '已暂停；恢复后会继续排期', tone: 'warn', attention: true };
        return { line: `今天 ${ai.today ?? 0}/${ai.dailyTarget || `${ai.minPerDay ?? 2}-${ai.maxPerDay ?? 5}`} 条${ai.nextAt ? ` · 下次 ${fmt(ai.nextAt)}` : ''}`, tone: 'ok' };
      }
      if (id === 'lifeFun') return shareModuleStatus('lifeFun', '生活趣闻');
      if (id === 'financeTips') return shareModuleStatus('financeTips', '金融小知识');
      if (id === 'llmTips') return shareModuleStatus('llmTips', '大模型科普');
      if (id === 's16Share') return shareModuleStatus('s16Share', 'S16 分享');
      if (id === 'customShare') return shareModuleStatus('customShare', '自定义分享模块');
      if (id === 'esportsFeed') {
        if (esp.error) return { line: '上次抓取没成功，稍后会自动重试', tone: 'warn', attention: true };
        if (esp.updatedAt) {
          const next = esp.schedule?.next;
          return {
            line: `最近更新 ${fmt(esp.updatedAt)}${next ? ` · 下一场 ${String(next.date || '').slice(5)} ${next.teamA || ''} vs ${next.teamB || ''}` : ''}`,
            tone: 'ok'
          };
        }
        return { line: '还没有抓取过资讯', tone: 'muted' };
      }
      if (id === 'dailyReport') {
        if (!dailyReportGroups.length) return { line: '还没有选择日报群，暂时不会发送', tone: 'warn', attention: true };
        return { line: `每天 ${dr.at || '21:30'} · ${dailyReportGroups.length} 个群`, tone: 'ok' };
      }
      if (id === 'ownerFeature') {
        const features = Array.isArray(of.features) ? of.features : [];
        if (!features.length) return { line: '还没有创建任务；可在主人私聊里创建', tone: 'muted' };
        const next = features.map((f) => Number(f.nextAt) || 0).filter(Boolean).sort((a, b) => a - b)[0];
        return { line: `${features.length} 个任务${next ? ` · 下次 ${fmt(next)}` : ''}${of.orchestrator?.pending ? ` · ${of.orchestrator.pending} 个等待主控` : ''}`, tone: 'ok' };
      }
      if (id === 'chatActivity') {
        const mode = globalActivityMode();
        const modeLabel = mode === 'active' ? '活跃' : mode === 'deep' ? '深潜' : '潜水';
        const conflicts = [...simulation.conversations.entries()]
          .filter(([key, session]) => String(key).startsWith('group:') && session?.wakeConfig?.mode === 'active' && mode !== 'active')
          .length;
        const deepIdle = mode === 'active' && cfg.simulation?.activityControl?.deepDive === true;
        let line = `当前实际模式：${modeLabel} · 由全局活跃控制决定`;
        if (mode === 'deep') line += ' · 群里仅主人直接 @ 可唤醒';
        if (conflicts) line += ` · ${conflicts} 个会话的「活跃」设置正被全局覆盖`;
        if (deepIdle) line += ' · 深潜已开但全局处于活跃，深潜暂不生效';
        return { line, tone: conflicts || deepIdle ? 'warn' : mode === 'active' ? 'ok' : 'muted', attention: conflicts > 0 };
      }
      if (id === 'groupChat') {
        if (simulation.paused) return { line: '已暂停：恢复后才会继续自动回复群消息', tone: 'warn', attention: true };
        if (cfg.simulation?.enabled === false) return { line: '总闸已关闭：群聊不会自动回复', tone: 'muted' };
        return { line: '群消息会按各子开关进入回复、冒泡和表情流程', tone: 'ok' };
      }
      if (id === 'chatProactive') {
        const pa = cfg.simulation?.proactive || {};
        const probability = Math.round((Number(pa.probability) || 0) * 100);
        const idleMinutes = Math.round((Number(pa.idleThresholdMs) || 0) / 60000);
        return { line: `安静 ${idleMinutes} 分钟后有 ${probability}% 概率冒泡`, tone: 'ok' };
      }
      if (id === 'chatStickers') {
        return cfg.simulation?.sticker?.collect?.enabled === false
          ? { line: '自动收集已关闭，只保留手动添加的表情', tone: 'muted' }
          : { line: '会自动收集群里的新表情', tone: 'ok' };
      }
      if (id === 'chatNightQuiet') {
        const quiet = nightQuietConfig();
        const active = isNightQuietNow();
        return { line: `${active ? '当前在静默时段' : '当前不在静默时段'} · ${quiet.start}-${quiet.end}`, tone: active ? 'ok' : 'muted' };
      }
      if (id === 'blacklist') {
        const count = blacklistStore.count();
        return count
          ? { line: `已拉黑 ${count} 人；完整名单只在主人私聊发`, tone: 'ok' }
          : { line: '黑名单是空的；说「别理某某」或「拉黑 QQ号」即可拉黑', tone: 'muted' };
      }
      if (id === 'consoleLanAccess') {
        return cfg.consoleLanAccess === true
          ? { line: '配置已开启：重启桥接后局域网可访问，数据接口强制令牌', tone: 'warn' }
          : { line: '仅本机回环可访问（默认）；开启后需重启桥接生效', tone: 'muted' };
      }
      return { line: '', tone: 'muted' };
    };
    const modules = FEATURE_CARDS.map((card) => {
      const enabled = cardEnabled(card, cfg);
      const dependencies = evaluateDependencies(card, cfg);
      const hardBlocked = enabled && dependencies.some((item) => !item.ok && !item.soft);
      const state = !enabled ? 'off' : hardBlocked ? 'blocked' : 'on';
      const status = statusFor(card.id);
      const keys = cardDefaultKeys(card.id);
      const requiresRestart = keys.some((key) => (schema.get(key)?.restart ?? 'none') !== 'none');
      return {
        id: card.id,
        board: card.board,
        label: card.label,
        keywords: card.keywords || '',
        description: card.description,
        onEffect: card.onEffect,
        offEffect: card.offEffect,
        dangerousOff: card.dangerousOff === true,
        customPanel: card.customPanel || '',
        enabled,
        state,
        statusLine: status.line,
        statusTone: status.tone,
        attention: status.attention === true || (enabled && dependencies.some((item) => !item.ok)),
        dependencies,
        advanced: advancedFieldsFor(card, cfg),
        hasAdvanced: keys.length > 0,
        requiresRestart
      };
    });
    return {
      generatedAt: Date.now(),
      boards: FEATURE_BOARDS.map((board) => ({ ...board, modules: modules.filter((module) => module.board === board.id) })),
      modules,
      total: modules.length,
      enabled: modules.filter((module) => module.enabled).length
    };
  }

  function buildLiveSnapshot() {
    const now = Date.now();
    const persona = innerLife?.personaInfo?.() ?? null;
    const inner = innerLife?.getState?.() ?? null;
    const sessions = [];
    for (const [key, st] of simulation.conversations) {
      const m = /^(group|private):(\d+)$/.exec(key) || [];
      const kind = m[1] || 'group';
      const id = m[2] || '';
      const name = kind === 'group'
        ? (liveGroupNames.get(id) || `群 ${id}`)
        : (id === String(cfg.ownerQQ) ? '主人私聊' : `私聊 ${id}`);
      const sessionId = state.sessions[key] || null;
      const sendTimes = Array.isArray(st.sendTimes) ? st.sendTimes : [];
      const wakeTimes = Array.isArray(st.wakeTimes) ? st.wakeTimes : [];
      sessions.push({
        key,
        kind,
        id,
        name,
        unread: Array.isArray(st.unread) ? st.unread.length : 0,
        pendingWakes: Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.length : 0,
        lastIncomingAt: Number(st.lastIncomingAt) || 0,
        lastAiReplyAt: Number(st.lastAiReplyAt) || 0,
        wakeMode: st.wakeConfig?.mode || 'diving',
        wakeInfinite: st.wakeConfig?.infinite !== false,
        probability: Number(st.wakeConfig?.triggers?.probability) || 0,
        lastWakeReason: String(st.lastWakeReason || ''),
        sendPerMinute: sendTimes.filter((t) => now - t < 60000).length,
        sendPerHour: sendTimes.filter((t) => now - t < 3600000).length,
        wakePerHour: wakeTimes.filter((t) => now - t < 3600000).length,
        readThroughSeq: Number(st.lastReadThroughSeq) || 0,
        lastUnreadSeq: Number(st.lastUnreadSeq) || 0,
        busy: sessionId ? collectors.has(sessionId) : false
      });
    }
    sessions.sort((a, b) => (b.lastIncomingAt || 0) - (a.lastIncomingAt || 0));
    // 她在读：书/字幕进度；旧进度缺 totalChars 时只给 null percent，不回写。
    // 摘录只读自已落盘的见闻笔记（quote 在消化层已逐字校验），没有笔记就不挂。
    let featureReading = [];
    let featureReadingToday = readingToday({});
    let featureOuterNotes = [];
    try {
      const recentNotes = outerWorldStore.notes.list({ limit: 40 });
      featureReading = attachReadingExcerpts(outerWorldReading(), recentNotes);
      featureOuterNotes = outerNotesSnapshot(recentNotes);
      featureReadingToday = readingToday(outerWorldStore.quota.get(shanghaiDayKey()));
    } catch {}
    const unreadTotal = sessions.reduce((n, s) => n + s.unread, 0);
    const pendingWakes = sessions.reduce((n, s) => n + s.pendingWakes, 0);
    const lat = liveReplyLatencies.slice().sort((a, b) => a - b);
    const pct = (p) => (lat.length ? lat[Math.min(lat.length - 1, Math.max(0, Math.floor(p * lat.length)))] : null);
    const snow = snowlumaHealthSnapshot();
    return {
      ts: now,
      self: { name: selfDisplayName || currentRoleName() || '小鲸鱼', userId: selfUserId || null },
      mode: currentMode,
      paused: simulation.paused,
      nightQuiet: { ...nightQuietConfig(), active: isNightQuietNow() },
      uptimeMs: Math.round(process.uptime() * 1000),
      persona: persona ? {
        mood: persona.state?.mood || null,
        mode: persona.mode ? { id: persona.mode.id, label: persona.mode.label } : null,
        energy: persona.state?.energy ?? null,
        interests: (persona.state?.interests || []).slice(0, 5),
        learnings: (persona.state?.learnings || []).slice(0, 4),
        quirks: persona.state?.quirks || [],
        cause: persona.state?.mood?.cause || '',
        setPoint: Number(persona.state?.mood?.setPoint) || 0,
        history: (() => {
          try {
            const snap = moodHistorySnapshot(7, 500);
            return snap.entries.slice(-48).map((item) => ({
              at: Number(item.at) || 0,
              v: Number(item?.after?.v) || 0,
              a: Number(item?.after?.a) || 0,
              e: Number(item?.after?.e) || 0,
              cause: String(item.cause || ''),
              mode: String(item.mode || '')
            }));
          } catch { return []; }
        })(),
        updatedAt: Number(persona.state?.updatedAt) || 0,
        changelog: (persona.state?.changelog || []).slice(-10)
      } : null,
      innerLife: inner ? {
        counts: inner.counts,
        next: inner.next,
        qzone: inner.qzone,
        pendingDraft: inner.pendingDraft ? {
          text: String(inner.pendingDraft.text || '').slice(0, 80),
          imageName: String(inner.pendingDraft.imageName || '').slice(0, 40),
          expiresAt: Number(inner.pendingDraft.expiresAt) || 0
        } : null,
        pendingShare: inner.pendingShare ? {
          text: String(inner.pendingShare.text || '').slice(0, 80),
          target: String(inner.pendingShare.target || ''),
          expiresAt: Number(inner.pendingShare.expiresAt) || 0
        } : null,
        lastQzone: (() => {
          const post = (inner.history?.qzonePosts || []).find((p) => p && p.status !== 'dryRun');
          return post ? {
            text: String(post.text || '').slice(0, 60),
            at: Number(post.at) || 0,
            tid: post.tid || '',
            status: post.status || ''
          } : null;
        })(),
        lastShare: (inner.history?.groupShares || [])[0] ? {
          text: String(inner.history.groupShares[0].text || '').slice(0, 60),
          at: Number(inner.history.groupShares[0].at) || 0
        } : null
      } : null,
      sessions,
      reading: featureReading,
      readingToday: featureReadingToday,
      outerNotes: featureOuterNotes,
      relationships: buildRelationshipSnapshot(),
      safety: {
        blacklist: {
          enabled: blacklistCfg().enabled,
          count: blacklistStore.count(),
          entries: blacklistStore.list().slice(0, 20)
        }
      },
      content: buildContentSnapshot(),
      flow: {
        unreadTotal,
        pendingWakes,
        guardHits: liveCounters.guardHits,
        autoAcks: liveCounters.autoAcks,
        errors: liveCounters.errors,
        replyLatency: { last: liveLastReplyLatency, p50: pct(0.5), p95: pct(0.95), count: lat.length }
      },
      health: {
        bridge: { ok: true, pid: process.pid, uptimeMs: Math.round(process.uptime() * 1000) },
        dsh: { ok: !!dshReady, baseUrl: cfg.dsh.baseUrl },
        snowluma: {
          connected: !!snow?.connected,
          good: snow?.good,
          accountOnline: snow?.accountOnline,
          lastPacketAgoMs: snow?.lastPacketAgoMs ?? null
        },
        tts: { ok: liveTtsOnline === true, checkedAt: liveTtsCheckedAt, provider: liveTtsProvider }
      },
      // 控制台访问范围（只读状态，供实时页/移动端展示；不含令牌与网卡地址）。
      console: {
        lanAccess: cfg.consoleLanAccess === true,
        authRequired: cfg.consoleAuth?.enabled !== false || cfg.consoleLanAccess === true
      },
      pixelSticker: {
        enabled: cfg.simulation?.pixelSticker?.enabled !== false,
        afterText: cfg.simulation?.pixelSticker?.afterText !== false,
        count: pixelStickerCount()
      },
      moodVoice: {
        enabled: cfg.simulation?.moodVoice?.enabled !== false,
        maxPerDay: Number(cfg.simulation?.moodVoice?.maxPerDay) || MOOD_VOICE_DEFAULTS.maxPerDay,
        sentToday: moodVoiceTimes.filter((t) => shanghaiDayKey(t) === shanghaiDayKey(Date.now())).length
      },
      usage: liveUsage,
      libraries: {
        stickers: stickerEntries.length,
        images: imageEntries.length,
        slangTotal: slangEntries.length,
        slangConfirmed: slangEntries.filter((e) => e.status === 'confirmed').length,
        voices: voiceLibrary().length,
        qzonePosts: (inner?.history?.qzonePosts || []).length
      },
      activity: liveEvents.slice(-30).reverse()
    };
  }

  // ── 表情包体系（群聊仿真）本地知识库 ────────────────────────────────────
  // 库文件损坏/读不动时**不能当成空库继续**：下面任何一次 saveStickerStoreSafe 都会把
  // 「空库」写回去，把 AI 学到的 localNote/tags/usage 永久清零。读失败就显式降级为
  // 「只读不写」，并留下醒目日志（与 loadSlang 的 slangStoreWritable 同一套路）。
  let stickerEntries = [];
  let stickerStoreWritable = true;
  try {
    stickerEntries = loadStickerStore(STICKER_FILE);
  } catch (error) {
    stickerStoreWritable = false;
    log(`⚠️ 表情库读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
  }
  // 通用图片库（网上找的图/截图/二创表情），与 QQ 收藏表情库分开。
  let imageEntries = [];
  try {
    imageEntries = loadImageStore(IMAGE_FILE);
  } catch (error) {
    log(`⚠️ 图片库读取失败：${error?.message ?? error}`);
  }
  let stickerSyncedAt = 0; // 上次从 SnowLuma 拉取收藏表情的时间戳（毫秒）
  let lastForcedAgentStickerSync = 0; // AI 强制刷新表情库的最小间隔保护

  function stickerEnabled() {
    return cfg.simulation?.sticker?.enabled !== false;
  }

  function saveStickerStoreSafe() {
    if (!stickerStoreWritable) return; // 读失败时绝不回写，避免把「损坏」当成「空库」落盘
    try { saveStickerStore(STICKER_FILE, stickerEntries); } catch (error) { log('保存表情库失败:', error?.message ?? error); }
  }

  // 从 SnowLuma OneBot 拉取 QQ 账号收藏表情（fetch_custom_face_detail），并合并进本地库。
  // force=true 时忽略 TTL 强制刷新；失败时返回 null（调用方决定是否使用缓存）。
  async function syncStickerLibrary(force = false) {
    if (cfg.simulation?.sticker?.enabled === false) return null;
    // 启动预热发生在 WS 打开之前；此时 bot.request 必然报 “closed before opening”。
    // 这不是同步失败，先直接用本地缓存，等连接建立后调用方会再同步。
    if (!snowlumaHealth.connected) {
      return stickerEntries.length
        ? { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true }
        : null;
    }
    const rawTtl = Number(cfg.simulation?.sticker?.syncTtlMs);
    const ttl = Number.isFinite(rawTtl) ? Math.max(0, rawTtl) : 60000;
    const now = Date.now();
    if (!force && stickerSyncedAt && now - stickerSyncedAt < ttl) {
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: true };
    }
    try {
      const count = Math.min(500, Math.max(1, Number(cfg.simulation?.sticker?.maxListCount) || 100));
      const response = await bot.request('fetch_custom_face_detail', { count });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`fetch_custom_face_detail 失败: ${response?.wording || response?.retcode || 'unknown'}`);
      }
      // 只有拿到合法数组才允许合并；data 缺失/异常时不能拿空数组清空本地 QQ 表情库。
      if (!Array.isArray(response.data)) {
        throw new Error('fetch_custom_face_detail 返回 data 不是数组，已放弃同步');
      }
      const fetched = response.data;
      stickerEntries = mergeStickerLibrary(stickerEntries, fetched, { complete: fetched.length < count });
      stickerSyncedAt = Date.now();
      saveStickerStoreSafe();
      log(`[sticker] 已同步 QQ 收藏表情 ${fetched.length} 个（本地库 ${stickerEntries.length} 条）`);
      return { entries: stickerEntries, syncedAt: stickerSyncedAt, fromCache: false };
    } catch (error) {
      log(`[sticker] 同步收藏表情失败: ${error?.message ?? error}`);
      return null;
    }
  }

  // 返回给 AI 的表情列表（带本地认知）。
  async function listStickersForAgent(query = '', count = 48, force = false) {
    const synced = await syncStickerLibrary(force);
    const entries = synced?.entries ?? stickerEntries;
    return formatStickerList(entries, query, count);
  }

  // 取单个表情的图片字节（多模态用）。
  async function getStickerImageData(stickerId) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) {
      // 本地没有时，尝试强制刷新一次再找（收藏可能在会话过程中新增）
      const forced = await syncStickerLibrary(true);
      const entry2 = findSticker(forced?.entries ?? stickerEntries, stickerId);
      if (!entry2) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
      return entry2;
    }
    return entry;
  }

  // ── 语音发送（把准备好的音频当 QQ 语音条发出） ──────────────────────────────
  //
  // 链路：本地音频文件 → SnowLuma 的 record 段 → 网关自带 SILK 编码 → QQ 语音条。
  // 网关侧事实（v1.14.9 源码确认）：record 段的 file 接受本地路径 / file:// / http(s):// / base64://，
  // 非 SILK 的音频由网关的 native ffmpeg addon 自动转成 NT SILK，所以这里不做预转码。
  //
  // 两条通道，闸门不同（与 /api/send/* 的既有分层一致）：
  //   - agent=true ：QQ 群里的 AI 调用。必须带有效 agent token，且只能发它自己那个会话。
  //   - agent=false：操作者（CLI / 控制台，凭 consoleToken）。跳过会话/模式闸门，
  //                  但仍强制白名单 + 语音限流 + 敏感词审计。
  // 语音发送时间戳（scopeKey → number[]）：与文本发送分开计数，语音额度独立。
  const voiceSendTimes = new Map();

  /**
   * 出站语音的内容审计：与文本一致，凡是「疑似敏感信息 / 含会话令牌」的**文件名**
   * 都不允许外发（语音的音频内容本身无法审计，但文件名同样会泄露路径与项目信息）。
   */
  function assertOutboundAuditOk(key, subject) {
    const text = String(subject ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && text.includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 语音发送被安全策略拦截 (${key})：${hasKnownToken ? '文件名含会话令牌' : '文件名疑似含敏感信息'}`);
      appendActivity(`${key} [voice] 发送被拦截（文件名疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      throw new Error('音频文件名疑似包含敏感信息（路径/凭据/会话令牌），已阻止发送；请重命名后再发');
    }
  }

  function voiceCfg() {
    const v = cfg.simulation?.voice ?? {};
    return {
      enabled: v.enabled !== false,
      dir: path.resolve(ROOT, String(v.dir ?? 'audio')),
      maxSeconds: Number(v.maxSeconds) > 0 ? Number(v.maxSeconds) : 300,
      maxBytes: Number(v.maxBytes) > 0 ? Number(v.maxBytes) : 20 * 1024 * 1024,
      maxPerMinute: Number(v.maxPerMinute) >= 0 ? Number(v.maxPerMinute) : 6,
      maxPerHour: Number(v.maxPerHour) >= 0 ? Number(v.maxPerHour) : 60,
      allowAbsolutePath: v.allowAbsolutePath === true,
      defaultVolume: Number(v.defaultVolume) > 0 ? Number(v.defaultVolume) : 1,
      normalize: v.normalize === true,
      loudness: v.loudness || 'normal',
      ffmpegPath: process.env.FFMPEG_PATH || v.ffmpegPath || null,
      autoReadback: v.autoReadback !== false
    };
  }

  function voiceLibrary() {
    const dir = voiceCfg().dir;
    const files = listAudioFiles(dir);
    return files.map((f) => {
      let stat = null;
      try { stat = fs.statSync(f); } catch {}
      return { name: path.relative(dir, f).split(path.sep).join('/'), bytes: stat?.size ?? 0, mtimeMs: stat?.mtimeMs ?? 0 };
    });
  }

  /**
   * 把「AI 给的语音引用」解析成可发送的本地绝对路径。
   *
   * 安全边界：**AI 只能从语音库目录里取文件**（防 prompt injection 拿任意本地文件当语音外发）。
   *
   * 历史坑（已修）：这里曾经在 `simulation.voice.allowAbsolutePath: true` 时直接把 AI 给的
   * 绝对路径交给 resolveAudioSource 解析，于是「AI 传 C:\Users\x\Music\任意.mp3」
   * 就能把本机任意音频（< 20 MB）发到群里 —— 而 inspectAudio 对「没有音频流」或
   * ffprobe 不可用的情况是放行的，等于把开关变成了任意文件外发通道。
   * 现在即使开了这个开关，也要求绝对路径**必须落在语音库目录之内**；
   * 真要从库外发文件请走操作者通道（resolveVoicePathForOperator / CLI）。
   */
  function voicePathInsideLibrary(vc, absPath) {
    const rel = path.relative(vc.dir, absPath);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null;
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    return safeJoinLibrary(vc.dir, rel);
  }

  function resolveSimulationVoicePath(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频：给语音库里的文件名（可用 qq_list_voices 查看）');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受语音库里的本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const isAbs = path.isAbsolute(raw) || /^file:\/\//i.test(raw) || raw.startsWith('~');

    let resolved = null;
    if (isAbs) {
      const r = resolveAudioSource(raw, {});
      const confined = r.path ? voicePathInsideLibrary(vc, r.path) : null;
      if (confined) {
        resolved = { path: confined, via: `${r.via}+library-confined` };
      } else {
        // 只报目录名，不报绝对路径：这条消息会经 MCP 工具错误回给模型，
        // 而模型面对的是不可信的群聊内容（prompt injection 可能诱导它复述本机路径）。
        throw new Error(`语音只能从语音库取文件（语音库目录：${path.basename(vc.dir)}）；即使是绝对路径也必须位于语音库之内（simulation.voice.allowAbsolutePath 已不再放宽 AI 通道）。请把音频放进语音库，或用操作者通道（CLI / 控制台）发送库外文件。`);
      }
    } else {
      // ⚠️ 安全关键：相对路径**只能**在语音库内解析。
      //
      // 不能直接丢给 resolveAudioSource —— 它会**先用 process.cwd() 解析相对路径**
      // （voice-core.js 的 cwd 分支），于是 AI 传 `..\..\某个\本机文件.mp3` 就能读库外文件，
      // 把 allowAbsolutePath=false 这个闸门整个绕过去（实测可复现）。
      // 相对路径一律先过 safeJoinLibrary（含 realpath 复核，挡 symlink 逃逸）。
      const joined = safeJoinLibrary(vc.dir, raw);
      if (joined && fs.existsSync(joined) && fs.statSync(joined).isFile()) {
        resolved = { path: joined, via: 'voice-dir-safe' };
      } else {
        // 允许省略扩展名：逐个补常见扩展名再在库内试一次（仍然不越出语音库）
        if (!path.extname(raw)) {
          for (const ext of AUDIO_EXTS) {
            const cand = safeJoinLibrary(vc.dir, `${raw}${ext}`);
            if (cand && fs.existsSync(cand) && fs.statSync(cand).isFile()) {
              resolved = { path: cand, via: 'voice-dir-safe+ext' };
              break;
            }
          }
        }
        if (!resolved) {
          // 库内没找到：检查是不是"想读库外文件"（这条错误要说清楚，避免误以为是名字写错）
          const looksLikeEscape = /(^|[\\/])\.\.([\\/]|$)/.test(raw) || path.isAbsolute(raw);
          if (looksLikeEscape) {
            throw new Error('语音只能从语音库取文件：路径里出现了「..」或绝对路径，已拒绝（防止读到库外的本机文件）');
          }
        }
      }
    }

    if (resolved) return { path: resolved.path, via: resolved.via, resolvedFrom: raw };

    // 模糊提示：只列库内文件（绝不回显库外路径）
    const library = voiceLibrary();
    const hint = library.length
      ? `语音库里现有：${library.slice(0, 12).map((x) => x.name).join('、')}${library.length > 12 ? ` 等 ${library.length} 个` : ''}`
      : `语音库（${path.basename(vc.dir)}）目前是空的，先把音频文件放进去`;
    // 按 basename 去扩展名做近似匹配（只用于提示）
    const want = path.basename(raw).toLowerCase();
    const wantNoExt = want.replace(/\.[^.]+$/, '');
    const fuzzyHits = library
      .filter((x) => {
        const base = path.basename(x.name).toLowerCase();
        return base === want || base.replace(/\.[^.]+$/, '') === wantNoExt;
      })
      .map((x) => x.name);
    const fuzzy = fuzzyHits.length ? `；近似匹配：${fuzzyHits.join('、')}` : '';
    throw new Error(`语音库里找不到「${raw}」${fuzzy}。${hint}`);
  }

  /**
   * 操作者通道（CLI）的路径解析：允许绝对路径（操作者本来就能读本机文件），
   * 相对路径先按「语音库」解析，再按当前工作目录解析 —— 这样两种直觉写法都成立。
   * base64/http 来源仍然禁止：语音应来自本地文件，别让 CLI 变成任意 URL 的外发口子。
   */
  function resolveVoicePathForOperator(input) {
    const vc = voiceCfg();
    const raw = String(input ?? '').trim();
    if (!raw) throw new Error('缺少音频路径');
    if (/^(base64:\/\/|data:|https?:\/\/)/i.test(raw)) {
      throw new Error('语音只接受本地文件；不接受 base64://、data: 或 http(s):// 来源');
    }
    const r = resolveAudioSource(raw, { voiceDir: vc.dir });
    if (r.path) return { path: r.path, via: r.via, resolvedFrom: raw };
    const fuzzy = r.candidates?.length ? `；语音库近似匹配：${r.candidates.map((c) => path.basename(c.path)).join('、')}` : '';
    throw new Error(`找不到音频「${raw}」${fuzzy}`);
  }

  /**
   * 语音发送限流：与文本发送分开计数，避免语音吃掉聊天额度（也避免聊天把语音额度耗光）。
   *
   * 只**检查**不占额度：额度在真正发出去之后才由 voiceBudgetCommit 记账 ——
   * 这样参数错、被审计拦截、网关失败都不会白白吃掉配额（否则连失败几次就被假 429 卡住）。
   */
  function voiceBudgetCheck(scopeKey, cfgV) {
    const now = Date.now();
    const bucket = voiceSendTimes.get(scopeKey) ?? [];
    const inMinute = bucket.filter((t) => now - t < 60000);
    const inHour = bucket.filter((t) => now - t < 3600000);
    if (cfgV.maxPerMinute > 0 && inMinute.length + 1 > cfgV.maxPerMinute) {
      throw new Error(`语音发送频率超限（每分钟最多 ${cfgV.maxPerMinute} 条），请稍后再试`);
    }
    if (cfgV.maxPerHour > 0 && inHour.length + 1 > cfgV.maxPerHour) {
      throw new Error(`语音发送频率超限（每小时最多 ${cfgV.maxPerHour} 条），请稍后再试`);
    }
  }

  /** 语音真正发出后记账（顺带裁掉超过 1 小时的旧时间戳，避免数组无界增长）。 */
  function voiceBudgetCommit(scopeKey, at = Date.now()) {
    const bucket = (voiceSendTimes.get(scopeKey) ?? []).filter((t) => at - t < 3600000);
    bucket.push(at);
    voiceSendTimes.set(scopeKey, bucket);
  }

  /**
   * 底层发送：把音频作为 record 段交给 SnowLuma。
   * guard=true（agent 通道）时，发送前必须通过 captureSendGuard —— 会话/模式/白名单任一变
   * 就放弃发送；guard=false（操作者通道）时不套会话闸门（操作者可能不在任何会话里）。
   *
   * audio 可传音量设置 { volume, normalize, loudness }：SnowLuma 的 record 段没有增益字段，
   * 所以音量必须在本地用 ffmpeg 调好再发（临时文件发完即删）。
   */
  async function sendVoiceFile(key, filePath, { guard = false, audit = true, audio = null } = {}) {
    const vc = voiceCfg();
    // 注意：这里**不检查** vc.enabled —— 那是「AI 能不能发语音」的开关，判定放在
    // AI 路由（/api/simulation/send-voice）与 sendVoiceForConversation 里。底层只管发，
    // 否则"默认不启用"会连操作者通道（CLI / 控制台面板 / 图形界面）一起封死。
    if (audit) assertOutboundAuditOk(key, `[语音:${path.basename(filePath)}]`);
    let info;
    try {
      info = await inspectAudio(filePath, { maxBytes: vc.maxBytes, maxSeconds: vc.maxSeconds });
    } catch (error) {
      throw new Error(`音频检查失败：${error?.message ?? error}`);
    }
    if (!info.ok) throw new Error(`音频不可发送：${info.error}`);

    // 音量处理（默认原样 → 不产生临时文件）
    let processed;
    try {
      processed = await processAudioVolume(filePath, {
        volume: audio?.volume ?? vc.defaultVolume,
        normalize: audio?.normalize === true || (audio?.normalize === undefined && vc.normalize === true),
        loudness: audio?.loudness ?? vc.loudness,
        ffmpegPath: vc.ffmpegPath
      });
    } catch (error) {
      throw new Error(`音量处理失败：${error?.message ?? error}`);
    }
    const sendPath = processed.path;

    const assertSendAllowed = guard ? captureSendGuard(key) : null;
    const [kind, id] = key.split(':');
    const recordSegment = { type: 'record', data: { file: sendPath } };
    let resolveSend;
    let rejectSend;
    const sendPromise = new Promise((resolve, reject) => { resolveSend = resolve; rejectSend = reject; });
    sendChain = sendChain.then(async () => {
      try {
        if (assertSendAllowed) assertSendAllowed();
        // 语音条比图片大、要过一次 SILK 转码，给 60s 预算（文本/图片共用同一 sendChain，
        // 所以这条语音发完之前后面的文本会自然排队，不会插队到语音前面）。
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
        const params = kind === 'private'
          ? { user_id: Number(id), message: [recordSegment] }
          : { group_id: Number(id), message: [recordSegment] };
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(60000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        resolveSend(body.data);
      } catch (error) {
        rejectSend(error);
      }
    });
    try {
      const data = await sendPromise;
      return {
        messageId: data?.message_id ?? null,
        bytes: info.size,
        duration: info.duration ?? null,
        codec: info.codec ?? '',
        warnings: info.warnings ?? [],
        detail: describeAudio(info),
        // 音量处理信息：mode='original' 表示没动过（没产生临时文件）
        audioProcessing: processed.detail,
        volume: processed.volume,
        loudness: processed.loudness,
        audioMode: processed.mode
      };
    } finally {
      // 音量处理产物是一次性的：发完（或失败）就删，别把 temp 撑大
      cleanupTemp(sendPath, processed.converted);
    }
  }

  /** 把「我发了条语音」写进仿真会话的 recentMessages，让 AI 自己知道刚发过什么。 */
  function recordVoiceSent(key, sent, label) {
    const st = getSimulationState(key);
    const display = label || `[语音 ${sent.detail}]`;
    const entry = {
      messageId: sent.messageId ? String(sent.messageId) : null,
      sender: '我',
      text: truncateText(display, 200),
      plain: truncateText(display, 200),
      quoteTargetIsSelf: false,
      isOwner: true,
      ownerLabel: '我',
      isSelf: true,
      at: Date.now()
    };
    st.recentMessages.push(entry);
    if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
    st.lastAiReplyAt = entry.at;
    st.lastActionAt = entry.at;
    st.lastVoiceAt = entry.at;
    st.textSendsSinceMedia = 0;
    st.wakeConfig.noActionCount = 0;
    saveSimulationState();
  }

  // 表情节奏：只统计“成功发出的文字回复”，发表情时清零。
  // 唤醒提示据此判断要不要提醒模型“该想起来发一张了”。
  function noteTextSent(st) {
    if (!st) return;
    st.textSendsSinceSticker = Math.min(999, (Number(st.textSendsSinceSticker) || 0) + 1);
    st.textSendsSinceImage = Math.min(999, (Number(st.textSendsSinceImage) || 0) + 1);
    st.textSendsSinceMedia = Math.min(999, (Number(st.textSendsSinceMedia) || 0) + 1);
  }
  function noteStickerSent(st) {
    if (!st) return;
    st.lastStickerAt = Date.now();
    st.textSendsSinceSticker = 0;
    st.textSendsSinceMedia = 0;
  }
  function noteImageSent(st) {
    if (!st) return;
    st.lastImageAt = Date.now();
    st.textSendsSinceImage = 0;
    st.textSendsSinceMedia = 0;
  }

  // 像素贴纸：文字回复后顺手丢一张透明像素贴纸。频率与表情包共用
  // lastStickerAt / textSendsSinceSticker（noteStickerSent），不另开一套计数。
  async function maybeSendPixelSticker(st, key) {
    const pc = cfg.simulation?.pixelSticker ?? {};
    if (pc.enabled === false || pc.afterText === false || !st || !key) return;
    if ((Number(st.textSendsSinceSticker) || 0) < Math.max(1, Number(pc.minTextsSince) || 2)) return;
    const last = Number(st.lastStickerAt) || 0;
    if (last && Date.now() - last < Math.max(60000, Number(pc.minGapMs) || 20 * 60 * 1000)) return;
    let mood = 'idle';
    try {
      const s = innerLife?.personaInfo?.()?.state ?? {};
      const v = Number(s.mood?.valence ?? 0);
      const e = Number(s.energy ?? 0.6);
      mood = v >= 0.4 ? 'happy' : v <= -0.25 ? 'pout' : e <= 0.35 ? 'tired' : 'idle';
    } catch {}
    const pick = pickPixelSticker(mood);
    if (!pick || !fs.existsSync(pick.path)) return;
    try {
      const buffer = fs.readFileSync(pick.path);
      const assertSendAllowed = captureSendGuard(key);
      const [kind, id] = key.split(':');
      const segments = [{ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } }];
      const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
      const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      await new Promise((resolve, reject) => {
        sendChain = sendChain.then(async () => {
          try {
            await sleep(randInt(300, 1200));
            assertSendAllowed();
            const res = await fetch(`${httpUrl}/${action}`, {
              method: 'POST',
              headers: { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) },
              body: JSON.stringify(params),
              signal: AbortSignal.timeout(30000)
            });
            const body = await res.json().catch(() => ({}));
            if (!res.ok || body.status !== 'ok' || body.retcode !== 0) throw new Error(`pixel sticker send failed: ${body.retcode ?? res.status}`);
            resolve(body.data);
          } catch (e) { reject(e); }
        });
      });
      noteStickerSent(st);
      saveSimulationState();
    } catch {}
  }

  // 心情语音节奏状态（上海自然日计数 + 最小间隔），持久化到 state/mood-voice.json。
  let moodVoiceTimes = (() => {
    try {
      const t = coreReadJsonSafe(path.join(ROOT, 'state', 'mood-voice.json'), {})?.times;
      return Array.isArray(t) ? t.filter((x) => Number.isFinite(Number(x))) : [];
    } catch { return []; }
  })();
  async function maybeSendMoodVoice() {
    const mv = cfg.simulation?.moodVoice ?? {};
    if (mv.enabled === false || !featureEnabled(cfg, 'voice')) return;
    try { if (!snowlumaHealth?.connected) return; } catch { return; }
    if (!moodVoiceCadenceOk({ times: moodVoiceTimes, now: Date.now(), maxPerDay: mv.maxPerDay, minGapMs: mv.minGapMs }).ok) return;
    if (Math.random() < Number(mv.skipChance ?? MOOD_VOICE_DEFAULTS.skipChance)) return;
    let mood = 'idle';
    try {
      const s = innerLife?.personaInfo?.()?.state ?? {};
      const v = Number(s.mood?.valence ?? 0);
      const e = Number(s.energy ?? 0.6);
      mood = v >= 0.4 ? 'happy' : v <= -0.25 ? 'pout' : e <= 0.35 ? 'sleepy' : 'idle';
    } catch {}
    const LINES = {
      happy: '今天心情不错，忍不住想跟你们说说话～',
      sleepy: '有点困了，先眯一会儿，别吵我哦…',
      pout: '哼，刚才有点小委屈，不过现在好啦',
      idle: '在水里游了一圈，回来看看你们在聊什么～'
    };
    const targets = (Array.isArray(mv.targets) && mv.targets.length) ? mv.targets : [`private:${cfg.ownerQQ}`];
    const key = targets[Math.floor(Math.random() * targets.length)];
    try {
      const voice = await synthesizeFeatureVoice({ text: LINES[mood] || LINES.idle, mood, cfg, outDir: path.join(ROOT, 'audio', 'tts') });
      await sendVoiceFile(key, voice.path, { guard: true });
      moodVoiceTimes.push(Date.now());
      if (moodVoiceTimes.length > 50) moodVoiceTimes = moodVoiceTimes.slice(-50);
      try { coreAtomicWriteJson(path.join(ROOT, 'state', 'mood-voice.json'), { times: moodVoiceTimes }); } catch {}
    } catch {}
  }

  /**
   * 发完语音后的**落地验证**：把这条消息从网关读回来，确认它真的带着 record 段。
   *
   * 为什么不用 fetch_ptt_text 做这件事：那个动作依赖 QQ 侧的语音转写结果，
   * 而**自己发出去的**语音根本不会产生转写（实测 retcode=100「消息中不包含语音」）。
   * 想让 AI 确认「语音真的发出去了」，唯一可靠的证据是 get_msg 回读到的 record 段。
   * 返回 { confirmed, file, duration } 或 null（读不回来不影响"已发送"这个事实）。
   */
  async function verifyVoiceMessageSent(messageId) {
    if (!messageId) return null;
    try {
      const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
      const res = await fetch(`${httpUrl}/get_msg`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
        },
        body: JSON.stringify({ message_id: Number(messageId) }),
        signal: AbortSignal.timeout(30000)
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok' || body.retcode !== 0) return null;
      const segments = Array.isArray(body.data?.message) ? body.data.message : [];
      const record = segments.find((s) => s?.type === 'record');
      if (!record) return null;
      // 注意：只回报「确认成功 + 时长」，**不回传 file/url**。
      // 私聊消息里 get_msg 会把源文件路径塞进 url（如 D:\...\audio\xxx.mp3），
      // 回给 AI 就等于把本机路径写进模型上下文（也会被敏感信息审计拦）。
      return {
        confirmed: true,
        duration: record.data?.duration != null ? Number(record.data.duration) : null
      };
    } catch (error) {
      log(`[voice] 发送后回读校验失败（不影响已发送）：${error?.message ?? error}`);
      return null;
    }
  }

  /**
   * AI 通道入口：解析引用 → 限流 → 发送 → 记账 → 回读校验。
   * 返回 { messageId, detail, verified, readback }。
   */
  async function sendVoiceForConversation(key, voiceRef, { label = '', verify = null, readback = false, audio = null } = {}) {
    const vc = voiceCfg();
    if (!vc.enabled) throw new Error('语音功能已关闭（simulation.voice.enabled=false）');
    const resolved = resolveSimulationVoicePath(voiceRef);
    // 音量参数校验前置（AI 传错时给出可读错误，而不是让 ffmpeg 报奇怪的错）
    if (audio) resolveAudioProcessing({ volume: audio.volume ?? vc.defaultVolume, normalize: audio.normalize === true, loudness: audio.loudness ?? vc.loudness });
    voiceBudgetCheck(key, vc);
    const sent = await sendVoiceFile(key, resolved.path, { guard: true, audit: true, audio });
    voiceBudgetCommit(key);
    recordVoiceSent(key, sent, label);
    log(`[voice] ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}, messageId=${sent.messageId ?? '?'})`);
    appendActivity(`${key} [voice] 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
    let readbackText = null;
    const wantReadback = readback === true;
    if (wantReadback && sent.messageId) {
      try {
        const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
        const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify({ message_id: String(sent.messageId) }),
          signal: AbortSignal.timeout(30000)
        });
        const body = await res.json().catch(() => ({}));
        if (res.ok && body.status === 'ok' && body.retcode === 0) readbackText = body.data?.text ?? '';
      } catch (error) {
        log(`[voice] 语音转写回读失败（不影响已发送）：${error?.message ?? error}`);
      }
    }
    // 默认做「回读到 record 段」的落地校验；转写按需（自己发的语音通常没有转写）。
    const wantVerify = verify === true || (verify !== false && vc.autoReadback);
    const verification = wantVerify ? await verifyVoiceMessageSent(sent.messageId) : null;
    return { ...sent, key, file: resolved.path, via: resolved.via, verification, readback: readbackText };
  }

  // 发送一个收藏表情（按 emoji_id/url/md5 解析）。
  // 关键：必须发 image + sub_type=1 + summary="[表情]"，QQ 才会按原生收藏表情渲染；
  // 发普通 image 段会显示成一张图片。不要带 emoji_id：SnowLuma 会把它当商城 mface，
  // 要求 32 位 hex，而收藏表情的 emoji_id 是 `<uin>_0_0_0_<md5>_0_0`，会被拒绝。
  async function sendSticker(key, stickerRef, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    // 发送前强制同步一次，确保“刚新增的表情能立即用、刚删除的表情不会继续发”。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerRef);
    if (!entry) throw new Error(`找不到表情 ${stickerRef}，请先用 qq_list_stickers 获取有效 id`);
    const url = entry.url;
    if (!url) throw new Error(`表情 ${entry.id} 没有可发送的图片地址`);
    const [kind, id] = key.split(':');
    const segments = [];
    const replyToMessageId = options.replyToMessageId;
    const atUserId = options.atUserId;
    // 仿真常识：一条消息只能是一张表情，不能在同一气泡里附带文字说明。
    // 想说的话请用 qq_send_message / qq_reply 作为单独气泡发送。
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    // 在桥接内完成带 DNS 固定、逐跳校验和大小限制的下载；不能把 URL 交给网关重新抓取。
    let image;
    try {
      image = await safeFetchBuffer(url, MAX_MEDIA_BYTES);
    } catch (error) {
      throw new Error(`表情 ${entry.id} 的图片下载失败（QQ CDN 网络异常或地址已失效）：${error?.message ?? error}`);
    }
    segments.push({
      type: 'image',
      data: {
        file: 'base64://' + image.buffer.toString('base64'),
        sub_type: 1,
        summary: '[表情]'
      }
    });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    // 与文本发送共用 sendChain，保证“先文字后表情”的真人顺序不被并发工具调用打乱。
    let sendResolve;
    let sendReject;
    const sendResult = new Promise((resolve, reject) => {
      sendResolve = resolve;
      sendReject = reject;
    });
    sendChain = sendChain.then(async () => {
      try {
        // 真人发表情前通常会有短暂停顿，避免“文字刚发完表情立刻跟上”的机械感。
        await sleep(randInt(800, 2000));
        assertSendAllowed();
        const res = await fetch(`${httpUrl}/${action}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
          },
          body: JSON.stringify(params),
          signal: AbortSignal.timeout(15000)
        });
        const body = await res.json().catch(() => ({}));
        if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
          const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
          throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
        }
        sendResolve(body.data);
      } catch (error) {
        sendReject(error);
      }
    });
    const data = await sendResult;
    // 更新本地使用统计
    const updated = markStickerUsed(stickerEntries, entry.id, 'sticker');
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return { entry: updated.entry, messageId: data?.message_id ?? null };
  }

  // ── 通用图片库（区别于 QQ 收藏表情库）────────────────────────────────────
  // 表情库只能同步 QQ 收藏表情；这里是任意图片：网图、截图、二创表情。
  // 相对路径按仓库根目录解析，避免从别的目录启动时把图片写到意外位置。
  function imageLibraryDir() {
    const raw = String(cfg.simulation?.imageLibrary?.dir || IMAGE_LIBRARY_DEFAULT_DIR);
    return path.isAbsolute(raw) ? raw : path.join(ROOT, raw);
  }

  function imageEnabled() {
    return cfg.simulation?.imageLibrary?.enabled !== false;
  }

  function saveImageStoreSafe() {
    try {
      imageEntries = saveImageStore(IMAGE_FILE, imageEntries);
    } catch (error) {
      log(`⚠️ 图片库保存失败：${error?.message ?? error}`);
    }
  }

  /** 发送一张图片库里的图片（可带一句配文）。 */
  async function sendImage(key, imageRef, { caption = '', replyToMessageId, atUserId = null, imageRefs = null } = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const refs = (Array.isArray(imageRefs) && imageRefs.length ? imageRefs : [imageRef]).slice(0, 4);
    const buffers = [];
    const usedEntries = [];
    for (const ref of refs) {
      const entry = findImage(imageEntries, ref);
      if (!entry) throw new Error(`图片库里找不到「${ref}」，先用 qq_list_images 看看有哪些`);
      const abs = imageFilePath(imageLibraryDir(), entry);
      if (!fs.existsSync(abs)) throw new Error(`图片文件不存在：${entry.file}`);
      const buffer = fs.readFileSync(abs);
      if (!looksLikeImageBuffer(buffer)) throw new Error(`图片文件不是可识别格式：${entry.file}`);
      buffers.push(buffer);
      usedEntries.push(entry);
    }
    const [kind, id] = key.split(':');
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const textPart = String(caption ?? '').trim();
    if (textPart) segments.push({ type: 'text', data: { text: escapeCqText(textPart.slice(0, 1000)) } });
    // 与表情发送一致：图片本体走 base64 段，避免把本地路径交给网关去读。
    for (const buffer of buffers) {
      segments.push({ type: 'image', data: { file: 'base64://' + buffer.toString('base64') } });
    }
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const data = await new Promise((resolve, reject) => {
      sendChain = sendChain.then(async () => {
        try {
          await sleep(randInt(300, 1200));
          assertSendAllowed();
          const res = await fetch(`${httpUrl}/${action}`, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
            },
            body: JSON.stringify(params),
            signal: AbortSignal.timeout(30000)
          });
          const body = await res.json().catch(() => ({}));
          if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
            const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口）' : '';
            throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
          }
          resolve(body.data);
        } catch (error) {
          reject(error);
        }
      });
    });
    for (const entry of usedEntries) {
      entry.useCount = (Number(entry.useCount) || 0) + 1;
      entry.lastUsedAt = Date.now();
      entry.updatedAt = new Date().toISOString();
    }
    if (usedEntries.length) saveImageStoreSafe();
    return { entry: usedEntries[0] || null, messageId: data?.message_id ?? null };
  }

  /** 取图片字节：来自某条消息，或一个 URL（保存进图片库用）。 */
  async function fetchImageBytesForSave({ key, messageId, url }) {
    const maxBytes = Math.max(1024, Number(cfg.simulation?.imageLibrary?.maxBytes) || 20 * 1024 * 1024);
    if (messageId) {
      const media = findMessageMedia(key, messageId);
      if (!media.length) throw new Error('这条消息没有可保存的图片');
      const images = await fetchMediaData(media);
      const first = (images || []).find((i) => i && i.type === 'image' && typeof i.data === 'string');
      if (!first) throw new Error('这条消息里没有解析出图片数据');
      const buffer = Buffer.from(String(first.data).replace(/^base64:\/\//i, ''), 'base64');
      if (buffer.length > maxBytes) throw new Error('图片超过大小上限');
      return { buffer, mime: first.mimeType || '', sourceUrl: '' };
    }
    const value = String(url ?? '').trim();
    if (!value) throw new Error('需要 messageId 或 url');
    if (cfg.simulation?.imageLibrary?.allowUrlSave === false) throw new Error('按 URL 保存图片已关闭');
    const fetched = await safeFetchBuffer(value, maxBytes);
    return { buffer: fetched.buffer, mime: fetched.mime ?? '', sourceUrl: value };
  }

  /**
   * 把图片库里适合当表情的图收进 QQ 收藏表情：
   * 逐张转 PNG → add_custom_face(base64) → modify_custom_face 备注 → 私发管理员预览。
   * 已收过的图（stickerEmojiId 非空）跳过；连续失败 3 次自动停，避免刷接口/撞收藏上限。
   */
  async function collectImageStickersFromLibrary({ count = 10, sendPreview = true } = {}) {
    if (!imageEnabled()) throw new Error('图片库未启用');
    const libDir = imageLibraryDir();
    const maxCount = Math.max(1, Math.min(20, Number(count) || 10));
    const maxBytes = 700 * 1024;
    const candidates = imageEntries.filter((e) => {
      if (!e.file || e.stickerEmojiId) return false;
      if (Number(e.bytes) > maxBytes) return false;
      const ratio = Number(e.width) && Number(e.height) ? Number(e.width) / Number(e.height) : 1;
      if (ratio < 0.55 || ratio > 1.8) return false;
      return true;
    });
    for (let i = candidates.length - 1; i > 0; i -= 1) {
      const j = Math.floor(Math.random() * (i + 1));
      [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
    }
    const batch = candidates.slice(0, maxCount);
    const result = { total: batch.length, ok: 0, failed: 0, skipped: 0, already: imageEntries.filter((e) => e.stickerEmojiId).length };
    if (!batch.length) {
      const msg = '没有可收藏的图（可能都收过了，或都被尺寸/比例过滤掉了）。';
      if (cfg.ownerQQ) { try { await onebotSend('private', Number(cfg.ownerQQ), msg); } catch {} }
      return { ...result, message: msg };
    }
    let consecutiveFailures = 0;
    for (const entry of batch) {
      try {
        const abs = imageFilePath(libDir, entry);
        if (!fs.existsSync(abs)) throw new Error('文件不存在');
        let sourcePath = abs;
        let temp = '';
        const ext = path.extname(abs).toLowerCase();
        if (!['.png', '.jpg', '.jpeg'].includes(ext)) {
          temp = path.join(STATE_DIR, `sticker-${process.pid}.png`);
          execFileSync(String(cfg.simulation?.voice?.ffmpegPath || 'ffmpeg'), ['-y', '-loglevel', 'error', '-i', abs, temp], { timeout: 30000 });
          sourcePath = temp;
        }
        const buffer = fs.readFileSync(sourcePath);
        if (temp) { try { fs.rmSync(temp, { force: true }); } catch {} }
        const verdict = await isQVersionWhaleSticker(cfg, buffer, { roleName: currentRoleName() });
        if (!verdict.ok) {
          result.skipped += 1;
          log(`[sticker] 跳过不符合当前角色的图片 ${entry.name}：${verdict.reason || '不符合形象'}`);
          continue;
        }
        const add = await bot.request('add_custom_face', { file: 'base64://' + buffer.toString('base64') });
        if (!add || add.status !== 'ok' || add.retcode !== 0) throw new Error(add?.wording || add?.retcode || 'unknown');
        const emojiId = String(add.data?.emoji_id || '');
        if (!emojiId) throw new Error('未返回 emoji_id');
        const desc = String(entry.note || entry.name || '').replace(/\s+/g, ' ').trim().slice(0, 20);
        if (desc) {
          try {
            const mod = await bot.request('modify_custom_face', { emoji_id: emojiId, desc });
            if (!mod || mod.status !== 'ok' || mod.retcode !== 0) log(`[sticker] 备注失败 ${emojiId}: ${mod?.wording || mod?.retcode}`);
          } catch (error) { log(`[sticker] 备注失败 ${emojiId}: ${error?.message ?? error}`); }
        }
        entry.stickerEmojiId = emojiId;
        entry.stickerCollectedAt = Date.now();
        entry.updatedAt = new Date().toISOString();
        saveImageStoreSafe();
        result.ok += 1;
        consecutiveFailures = 0;
        log(`[sticker] 网图收表情成功：${entry.name} -> ${emojiId}`);
        if (sendPreview && cfg.ownerQQ) {
          try {
            await sendImage(`private:${cfg.ownerQQ}`, entry.id, { caption: `已收成表情：${desc || entry.name}` });
          } catch (error) { log(`[sticker] 预览发送失败：${error?.message ?? error}`); }
        }
        await sleep(1800 + Math.random() * 1400);
      } catch (error) {
        result.failed += 1;
        consecutiveFailures += 1;
        log(`[sticker] 网图收表情失败 ${entry.name}: ${error?.message ?? error}`);
        if (consecutiveFailures >= 3) {
          log('[sticker] 连续失败 3 次，停止本批收藏（可能是 QQ 收藏上限或接口限流）');
          break;
        }
      }
    }
    try { await syncStickerLibrary(true); } catch (error) { log(`[sticker] 收藏后同步表情库失败：${error?.message ?? error}`); }
    const summary = `网图收表情完成：成功 ${result.ok} 张，跳过非 Q 版 ${result.skipped} 张，失败 ${result.failed} 张，本批 ${result.total} 张。`;
    log(`[sticker] ${summary}`);
    if (cfg.ownerQQ) { try { await onebotSend('private', Number(cfg.ownerQQ), summary + ' 之后用 qq_list_stickers 就能看到。'); } catch {} }
    return result;
  }

  // 更新本地 AI 认知（含义/标签/用法）。
  function applyStickerNoteToStore(stickerId, note, tags, usage) {
    const patch = {};
    if (note !== undefined && note !== null) patch.note = String(note);
    if (tags !== undefined && tags !== null) patch.tags = Array.isArray(tags) ? tags.map(String) : String(tags).split(/[,，\s]+/);
    if (usage !== undefined && usage !== null) patch.usage = String(usage);
    const updated = applyStickerNote(stickerEntries, stickerId, patch);
    if (!updated.entry) return null;
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return updated.entry;
  }

  // 修改 QQ 账号里的收藏表情备注（modify_custom_face），并同步本地 desc。
  async function setStickerRemark(stickerId, remark) {
    const synced = await syncStickerLibrary(false);
    const entry = findSticker(synced?.entries ?? stickerEntries, stickerId);
    if (!entry) throw new Error(`找不到表情 ${stickerId}，请先用 qq_list_stickers 获取有效 id`);
    const cleanRemark = String(remark ?? '').trim().slice(0, 50);
    const response = await bot.request('modify_custom_face', { emoji_id: entry.id, desc: cleanRemark });
    if (!response || response.status !== 'ok' || response.retcode !== 0) {
      throw new Error(`modify_custom_face 失败: ${response?.wording || response?.retcode || 'unknown'}`);
    }
    const updated = applyStickerNote(stickerEntries, entry.id, {});
    // 直接改 desc（保留本地认知）
    const idx = (updated.entries || []).findIndex((e) => e.id === entry.id);
    if (idx >= 0) {
      updated.entries[idx] = { ...updated.entries[idx], desc: cleanRemark, updatedAt: new Date().toISOString() };
    }
    stickerEntries = updated.entries;
    saveStickerStoreSafe();
    return stickerEntries.find((e) => e.id === entry.id) || null;
  }

  function isOwnerMediaContext(key) {
    if (!cfg.ownerQQ) return false;
    if (String(key) === `private:${String(cfg.ownerQQ)}`) return true;
    try {
      const st = getSimulationState(String(key));
      if (String(st.lastIncomingUserId || '') === String(cfg.ownerQQ)) return true;
      // 群里主人刚说过话、随后又有别人插话时，lastIncomingUserId 会被覆盖；
      // 5 分钟内的主人消息仍可作为删除授权依据。
      const now = Date.now();
      return (Array.isArray(st.recentMessages) ? st.recentMessages : [])
        .slice(-12)
        .some((m) => m && !m.isSelf && m.isOwner && now - Number(m.time || 0) < 5 * 60 * 1000);
    } catch { return false; }
  }

  function mediaRefFromQuoted(key, messageId) {
    try {
      const st = getSimulationState(String(key));
      const want = String(messageId ?? '').trim();
      if (!want) return null;
      const msg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])]
        .reverse()
        .find((m) => m && (String(m.messageId || '') === want || String(m.seq || '') === want));
      if (!msg) return null;
      if (msg.sticker?.id) return { kind: 'sticker', ref: String(msg.sticker.id), self: !!msg.isSelf };
      const stickerMedia = (Array.isArray(msg.media) ? msg.media : [])
        .find((m) => m && (m.kind === 'sticker' || m.kind === 'face') && (m.emojiId || m.faceId));
      if (stickerMedia) return { kind: 'sticker', ref: String(stickerMedia.emojiId || stickerMedia.faceId), self: !!msg.isSelf };
      if (msg.image?.id) return { kind: 'image', ref: String(msg.image.id), self: !!msg.isSelf };
      const imageMedia = (Array.isArray(msg.media) ? msg.media : []).find((m) => m && m.kind === 'image');
      if (imageMedia) return { kind: 'image', ref: String(imageMedia.file || imageMedia.url || ''), self: !!msg.isSelf };
      return null;
    } catch { return null; }
  }

  async function resolveStickerForDelete(ref) {
    const needle = String(ref ?? '').trim();
    if (!needle) throw new Error('请告诉我删哪个表情：可以发 id、备注或关键词');
    const synced = await syncStickerLibrary(false);
    const entries = synced?.entries ?? stickerEntries;
    const direct = findSticker(entries, needle);
    if (direct) return { entry: direct, candidates: [] };
    const q = needle.toLowerCase();
    const matches = entries.filter((e) => [e.id, e.resId, e.md5, e.desc, e.localNote, e.usage, ...(e.tags || [])]
      .join(' ').toLowerCase().includes(q));
    if (matches.length === 1) return { entry: matches[0], candidates: [] };
    return { entry: null, candidates: matches.slice(0, 8) };
  }

  async function deleteSticker(ref) {
    const { entry, candidates } = await resolveStickerForDelete(ref);
    if (!entry) {
      const err = new Error(candidates.length ? `找到 ${candidates.length} 个相关表情，请说得更具体` : `找不到表情「${ref}」`);
      err.code = 'AMBIGUOUS';
      err.candidates = candidates;
      throw err;
    }
    if (entry.source === 'qq') {
      const response = await bot.request('delete_custom_face', { emoji_id: entry.id });
      if (!response || response.status !== 'ok' || response.retcode !== 0) {
        throw new Error(`delete_custom_face 失败：${response?.wording || response?.retcode || 'unknown'}`);
      }
    }
    stickerEntries = stickerEntries.filter((e) => e.id !== entry.id);
    saveStickerStoreSafe();
    log(`[sticker] 已删除表情 ${entry.id}${entry.desc ? `（${entry.desc}）` : ''}`);
    if (typeof appendActivity === 'function') {
      try { appendActivity(`[sticker] 删除表情 ${entry.desc || entry.id}`); } catch {}
    }
    return entry;
  }

  function resolveImageForDelete(ref) {
    const needle = String(ref ?? '').trim();
    if (!needle) throw new Error('请告诉我删哪张图：可以发图片名、备注或关键词');
    const direct = findImage(imageEntries, needle);
    if (direct) return { entry: direct, candidates: [] };
    const q = needle.toLowerCase();
    const matches = imageEntries.filter((e) => [e.id, e.name, e.note, ...(e.tags || [])]
      .join(' ').toLowerCase().includes(q));
    if (matches.length === 1) return { entry: matches[0], candidates: [] };
    return { entry: null, candidates: matches.slice(0, 8) };
  }

  function deleteImage(ref) {
    const { entry, candidates } = resolveImageForDelete(ref);
    if (!entry) {
      const err = new Error(candidates.length ? `找到 ${candidates.length} 张相关图片，请说得更具体` : `找不到图片「${ref}」`);
      err.code = 'AMBIGUOUS';
      err.candidates = candidates;
      throw err;
    }
    const abs = imageFilePath(imageLibraryDir(), entry);
    try { fs.rmSync(abs, { force: true }); } catch (error) {
      throw new Error(`删除图片文件失败：${error?.message ?? error}`);
    }
    imageEntries = imageEntries.filter((e) => e.id !== entry.id);
    saveImageStoreSafe();
    log(`[image] 已删除图片 ${entry.name || entry.id}`);
    if (typeof appendActivity === 'function') {
      try { appendActivity(`[image] 删除图片 ${entry.name || entry.id}`); } catch {}
    }
    return entry;
  }

  // 动图直接送视觉模型时，部分供应商只认静态首帧或直接报错。
  // 预览校验用首帧，真正收藏仍提交原始 GIF/WebP/APNG；抽帧失败则回退原字节。
  function firstFrameForVision(buffer, { mimeType = '', fileName = '' } = {}) {
    if (!Buffer.isBuffer(buffer) || !buffer.length) return buffer;
    if (!/image\/(gif|webp|apng)/i.test(String(mimeType || '')) && !/\.(gif|webp|apng)$/i.test(String(fileName || ''))) return buffer;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-frame-'));
    const input = path.join(dir, 'input');
    const output = path.join(dir, 'frame.png');
    try {
      fs.writeFileSync(input, buffer);
      execFileSync(String(cfg.simulation?.voice?.ffmpegPath || 'ffmpeg'), ['-y', '-loglevel', 'error', '-i', input, '-frames:v', '1', output], { timeout: 15000 });
      const frame = fs.readFileSync(output);
      return frame.length ? frame : buffer;
    } catch (error) {
      log(`[sticker] 动图首帧提取失败，视觉校验回退原图：${error?.message ?? error}`);
      return buffer;
    } finally {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
    }
  }

  // 收藏聊天里的一张表情（add_custom_face），并按 AI 看到的含义写简短备注（modify_custom_face）。
  // 收藏失败时的补收队列：网络抖动导致 add_custom_face 持续失败时，先落盘稍后自动重试。
  // 超过 SnowLuma 上传接口上限（实测 3.8MB 可、4.0MB 不可）时默认直接拒绝，不降质；
  // 只有显式 collect.compress=true 才用 Pillow 本地压缩（压缩后 MD5 会变，等于另一张图）。
  function planStickerCompress({ bytes, maxBytes, compress } = {}) {
    const limit = Math.max(65536, Number(maxBytes) || 3932160);
    const size = Math.max(0, Number(bytes) || 0);
    if (size <= limit) return { action: 'upload', maxBytes: limit };
    if (compress !== true) return { action: 'reject', maxBytes: limit, reason: '太大且自动压缩已关闭' };
    return { action: 'compress', maxBytes: limit };
  }

  function fitStickerBuffer(buffer) {
    const collect = cfg.simulation?.sticker?.collect ?? {};
    const plan = planStickerCompress({ bytes: buffer.length, maxBytes: collect.maxBytes, compress: collect.compress });
    const maxBytes = plan.maxBytes;
    if (plan.action === 'upload') return { buffer, compressed: false, maxBytes };
    if (plan.action === 'reject') return { buffer, tooLarge: true, maxBytes, reason: plan.reason, compressDisabled: true };
    const python = String(collect.pythonPath || '').trim() || 'python';
    const script = String(collect.shrinkScriptPath || '').trim() || path.join(ROOT, 'tools', 'shrink-gif.py');
    const stamp = Date.now();
    const tmpIn = path.join(STATE_DIR, `tmp-sticker-${stamp}-in.gif`);
    const tmpOut = path.join(STATE_DIR, `tmp-sticker-${stamp}-out.gif`);
    try {
      fs.writeFileSync(tmpIn, buffer);
      const run = spawnSync(python, [script, tmpIn, tmpOut, String(maxBytes)], {
        timeout: 60000,
        windowsHide: true,
        encoding: 'utf8'
      });
      if (run.status === 0 && fs.existsSync(tmpOut)) {
        const out = fs.readFileSync(tmpOut);
        if (out.length > 0 && out.length <= maxBytes) {
          return { buffer: out, compressed: true, originalBytes: buffer.length, maxBytes };
        }
      }
      return { buffer, tooLarge: true, maxBytes, reason: String(run.stderr || run.error?.message || '压缩失败').slice(0, 200) };
    } catch (error) {
      return { buffer, tooLarge: true, maxBytes, reason: String(error?.message ?? error).slice(0, 200) };
    } finally {
      try { fs.unlinkSync(tmpIn); } catch {}
      try { fs.unlinkSync(tmpOut); } catch {}
    }
  }

  const STICKER_FETCH_SOURCE_LABELS = { url: 'URL', cdn: 'CDN', get_image: 'get_image', library: '收藏库' };

  // 日志里只保留 host + path（签名/token 通常挂在 query），并截断长度。
  function stickerFetchUrlForLog(raw, maxLen = 80) {
    const text = String(raw ?? '').trim();
    if (!text) return '';
    let out = text;
    try {
      const parsed = new URL(text);
      out = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
    } catch {
      out = text.split(/[?#]/, 1)[0];
    }
    return out.length > maxLen ? `${out.slice(0, maxLen)}…` : out;
  }

  function sanitizeStickerFetchText(text, maxLen = 160) {
    return String(text ?? '')
      .replace(/https?:\/\/[^\s)】]+/gi, (url) => stickerFetchUrlForLog(url))
      .slice(0, maxLen);
  }

  // 把底层报错归成模型/日志都能一眼看懂的短原因。
  function stickerFetchReason(message) {
    const raw = String(message ?? '').trim();
    if (!raw) return '未知错误';
    const status = /HTTP\s+(\d{3})/i.exec(raw);
    if (status) return status[1];
    if (/超时|timeout|timed out/i.test(raw)) return '超时';
    if (/不是有效图片|不是图片|不是图片数据|图片数据/i.test(raw)) return '不是图片';
    if (/ENOTFOUND|EAI_AGAIN|域名解析失败|getaddrinfo/i.test(raw)) return '域名解析失败';
    if (/超过大小限制|too large|超过.*上限/i.test(raw)) return '超过大小上限';
    if (/禁止访问|内网|本机地址/i.test(raw)) return '地址被阻止';
    return sanitizeStickerFetchText(raw, 30) || '未知错误';
  }

  // 多次重试会把同一来源的同一错误重复塞进来；按「来源 + 原因」去重后拼一句话。
  function summarizeStickerFetchFailures(failures) {
    const seen = new Set();
    const parts = [];
    for (const item of Array.isArray(failures) ? failures : []) {
      const source = STICKER_FETCH_SOURCE_LABELS[item?.source] || '取图';
      const reason = stickerFetchReason(item?.message);
      const key = `${source}|${reason}`;
      if (seen.has(key)) continue;
      seen.add(key);
      parts.push(`${source} ${reason}`);
      if (parts.length >= 4) break;
    }
    return parts.length ? `取图失败：${parts.join('；')}` : '取图失败';
  }

  const STICKER_TRANSIENT_RE = /fetch failed|timeout|timed out|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|socket hang up|HTTP 5\d\d/i;
  const PENDING_STICKERS_FILE = path.join(STATE_DIR, 'pending-stickers.json');
  const PENDING_STICKER_MAX = 5;
  const PENDING_STICKER_MAX_ATTEMPTS = 6;
  const PENDING_STICKER_RETRY_MS = 5 * 60 * 1000;

  function loadPendingStickers() {
    const list = readJsonSafe(PENDING_STICKERS_FILE, []);
    return Array.isArray(list) ? list.filter((item) => item && item.file && item.key) : [];
  }

  function savePendingStickers(list) {
    try {
      atomicWriteJson(PENDING_STICKERS_FILE, (Array.isArray(list) ? list : []).slice(-PENDING_STICKER_MAX));
    } catch (error) {
      log(`[sticker] 补收队列保存失败：${error?.message ?? error}`);
    }
  }

  function scheduleStickerCollectJob(delayMs = PENDING_STICKER_RETRY_MS) {
    if (!jobQueue) return;
    try {
      jobQueue.enqueue({
        type: 'sticker.collect',
        dedupeKey: 'sticker.collect',
        runAfter: Date.now() + Math.max(1000, Number(delayMs) || PENDING_STICKER_RETRY_MS),
        maxAttempts: 2
      });
    } catch {}
  }

  // 补收队列处理：逐条压缩/上传；压缩后仍超限就放弃并提示重发。
  async function processPendingStickers() {
    // 表情体系关闭时队列原样留着：不上传、不发消息、不清空，重新打开后继续补收。
    if (!stickerEnabled()) return { status: 'disabled', reason: 'simulation.sticker.enabled=false' };
    const list = loadPendingStickers();
    if (!list.length) return { status: 'idle' };
    const keep = [];
    for (const item of list) {
      const attempts = Math.max(0, Number(item.attempts) || 0);
      const rawBase64 = String(item.file || '').replace(/^base64:\/\//, '');
      const fitted = fitStickerBuffer(Buffer.from(rawBase64, 'base64'));
      if (fitted.tooLarge) {
        log(`[sticker] 补收放弃 ${item.key}: 超过上限（${fitted.reason || ''}）`);
        try { await sendToQQ(item.key, fitted.compressDisabled ? '刚才那个表情太大，自动压缩已关闭，换个小的吧' : '刚才那个表情太大，自动压缩也没成功，换个小的吧'); } catch {}
        continue;
      }
      const uploadFile = fitted.compressed ? `base64://${fitted.buffer.toString('base64')}` : item.file;
      try {
        const res = await bot.request('add_custom_face', { file: uploadFile });
        if (res && res.status === 'ok' && res.retcode === 0) {
          const emojiId = String(res.data?.emoji_id || '');
          if (item.remark && emojiId) {
            try { await bot.request('modify_custom_face', { emoji_id: emojiId, desc: item.remark }); } catch {}
          }
          try { await syncStickerLibrary(true); } catch {}
          try { await sendToQQ(item.key, '刚才那个表情收好了'); } catch {}
          log(`[sticker] 补收成功 ${item.key}: ${emojiId}`);
          continue;
        }
        const wording = String(res?.wording || res?.retcode || 'unknown');
        if (STICKER_TRANSIENT_RE.test(wording) && attempts + 1 < PENDING_STICKER_MAX_ATTEMPTS) {
          keep.push({ ...item, attempts: attempts + 1, lastProblem: wording });
          continue;
        }
        log(`[sticker] 补收放弃 ${item.key}: ${wording}`);
        try { await sendToQQ(item.key, '刚才那个表情还是没存上，你方便时再发一次吧'); } catch {}
      } catch (error) {
        const message = String(error?.message ?? error);
        if (STICKER_TRANSIENT_RE.test(message) && attempts + 1 < PENDING_STICKER_MAX_ATTEMPTS) {
          keep.push({ ...item, attempts: attempts + 1, lastProblem: message });
        } else {
          log(`[sticker] 补收放弃 ${item.key}: ${message}`);
        }
      }
    }
    savePendingStickers(keep);
    return keep.length ? { retryAfterMs: PENDING_STICKER_RETRY_MS } : { status: 'done' };
  }

  async function collectSticker(key, messageRef, remark) {
    const assertSendAllowed = captureSendGuard(key);
    const st = getSimulationState(key);
    const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === String(messageRef) || (m.messageId && String(m.messageId) === String(messageRef))));
    if (!found) throw new Error('找不到这条消息，请确认 messageId/seq 有效且属于当前会话');
    if (found.isSelf) throw new Error('不能收藏自己发的表情，只能收藏群友发的');
    const mediaList = Array.isArray(found.media) ? found.media : [];
    if (!mediaList.length) throw new Error('这条消息没有可收藏的图片/表情');
    const media = mediaList[0];
    let source = null;
    // 取图本身也可能遇到瞬时抖动（QQ 媒体 CDN / 网关超时）；与上传一样给 3 次机会。
    // 失败来源逐条留证，最后给模型一个能据此换路的根因摘要，而不是笼统的「网络不稳」。
    const fetchFailures = [];
    const fetchDelays = [1500, 5000];
    for (let attempt = 1; attempt <= 3 && !source?.buffer; attempt += 1) {
      if (attempt > 1) {
        appendActivity(`${key} 取表情图第 ${attempt}/3 次尝试`);
        await sleep(fetchDelays[attempt - 2] ?? 5000);
      }
      try {
        if (media?.kind === 'image' || media?.kind === 'sticker') {
          // 图片段和市场/收藏表情段都走同一条安全取字节链路；mface 没有 get_image 缓存，
          // fetchOneBotImage 会优先走 CDN 或用 emoji_id 推导地址。
          const img = await fetchOneBotImage(media, { failures: fetchFailures });
          if (img?.buffer) source = { ...img };
        } else if (media?.kind === 'face') {
          const face = await fetchFaceMedia(media);
          if (face?.buffer) source = { buffer: face.buffer, mimeType: face.mimeType || 'image/png' };
        }
      } catch (error) {
        log(`[sticker] 取表情图第 ${attempt} 次失败：${error?.message ?? error}`);
      }
    }
    if (!source?.buffer) {
      const reason = summarizeStickerFetchFailures(fetchFailures);
      throw new Error(`这张拿不到原图（${reason}），让对方直接发图或用 getImages 取回后再收藏；过一会儿再让我试一次也可以`);
    }
    // 超过上传接口上限时默认不压缩（优先原图），显式开启 compress 才降质缩小。
    const fitted = fitStickerBuffer(source.buffer);
    if (fitted.tooLarge) {
      const sizeMb = (source.buffer.length / 1048576).toFixed(1);
      const limitMb = (fitted.maxBytes / 1048576).toFixed(1);
      if (fitted.compressDisabled) {
        throw new Error(`表情太大了（${sizeMb}MB），上传接口上限约 ${limitMb}MB；太大且自动压缩已关闭（可在 simulation.sticker.collect.compress 打开），换个小一点的吧`);
      }
      throw new Error(`表情太大了（${sizeMb}MB），上传接口上限约 ${limitMb}MB，自动压缩没成功（${String(fitted.reason || '未知原因').slice(0, 60)}），换个小一点的吧`);
    }
    if (fitted.compressed) {
      const before = (fitted.originalBytes / 1048576).toFixed(1);
      const after = (fitted.buffer.length / 1048576).toFixed(1);
      source.buffer = fitted.buffer;
      appendActivity(`${key} 表情超过接口上限，已自动压缩 ${before}MB → ${after}MB`);
      log(`[sticker] 自动压缩表情 ${before}MB → ${after}MB`);
    }
    const visionBuffer = firstFrameForVision(source.buffer, {
      mimeType: source.mimeType,
      fileName: media?.file || media?.url || ''
    });
    const verdict = await isQVersionWhaleSticker(cfg, visionBuffer, { roleName: currentRoleName() });
    if (!verdict.ok) {
      throw new Error(`只收藏符合当前角色形象的表情（${verdict.reason || '这张不符合形象'}）`);
    }
    assertSendAllowed();
    const file = 'base64://' + source.buffer.toString('base64');
    // 上传层可能是 SnowLuma 自己的 fetch（DNS 抖动/代理干扰）；只对瞬时错误重试，
    // 业务错误（例如表情库满）立即返回，避免把“不符合要求”误报成网络问题。
    const transientRe = STICKER_TRANSIENT_RE;
    const rawDelays = cfg.simulation?.sticker?.collect?.retryDelaysMs;
    const delays = Array.isArray(rawDelays) && rawDelays.length
      ? rawDelays.map((n) => Math.max(0, Number(n) || 0)).slice(0, 2)
      : [1500, 5000];
    const bufferMd5 = crypto.createHash('md5').update(source.buffer).digest('hex').toUpperCase();
    const existingByMd5 = () => (Array.isArray(stickerEntries) ? stickerEntries : [])
      .find((entry) => entry && bufferMd5 && String(entry.md5 || '').toUpperCase() === bufferMd5) || null;
    let addRes = null;
    let lastProblem = '';
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (attempt > 1) {
        appendActivity(`${key} 收藏表情第 ${attempt}/3 次尝试（上次：${lastProblem || 'unknown'}）`);
        await sleep(delays[attempt - 2] ?? 5000);
      }
      try {
        addRes = await bot.request('add_custom_face', { file });
      } catch (error) {
        addRes = null;
        lastProblem = String(error?.message ?? error);
      }
      if (addRes && addRes.status === 'ok' && addRes.retcode === 0) {
        if (attempt > 1) appendActivity(`${key} 收藏表情第 ${attempt} 次重试成功`);
        break;
      }
      lastProblem = String(addRes?.wording || addRes?.retcode || lastProblem || 'unknown');
      if (!transientRe.test(lastProblem)) break;
    }
    if (!addRes || addRes.status !== 'ok' || addRes.retcode !== 0) {
      // 重试后没拿到回执，但同图已在本地库里：视为成功，别让模型误报“手滑”。
      const existing = existingByMd5();
      if (existing) {
        appendActivity(`${key} 收藏表情未拿到回执，但本地已有同图（${existing.id}），按成功处理`);
        return { emojiId: existing.id, entry: existing, remark: '', reused: true };
      }
      if (transientRe.test(lastProblem)) {
        const maxRemarkChars = Math.max(1, Number(cfg.simulation?.sticker?.collect?.maxRemarkChars) || 20);
        const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
        const pending = loadPendingStickers();
        pending.push({
          id: crypto.createHash('sha1').update(`${Date.now()}|${key}|${bufferMd5}`).digest('hex').slice(0, 10),
          key,
          remark: cleanRemark,
          file,
          at: Date.now(),
          attempts: 1,
          lastProblem
        });
        savePendingStickers(pending);
        appendActivity(`${key} 收藏表情网络不稳，已加入补收队列（${pending.length} 条）`);
        scheduleStickerCollectJob();
        return { pending: true, emojiId: '', entry: null, remark: cleanRemark, message: '网络不稳，已先记下，稍后自动补收藏' };
      }
      throw new Error(`add_custom_face 失败: ${lastProblem || 'unknown'}`);
    }
    const emojiId = String(addRes.data?.emoji_id || '');
    if (!emojiId) throw new Error('add_custom_face 未返回 emoji_id');
    const maxRemarkChars = Math.max(1, Number(cfg.simulation?.sticker?.collect?.maxRemarkChars) || 20);
    const cleanRemark = String(remark ?? '').trim().slice(0, maxRemarkChars);
    if (cleanRemark) {
      assertSendAllowed();
      const modRes = await bot.request('modify_custom_face', { emoji_id: emojiId, desc: cleanRemark });
      if (!modRes || modRes.status !== 'ok' || modRes.retcode !== 0) {
        log(`[sticker] 收藏成功但备注失败 ${emojiId}: ${modRes?.wording || modRes?.retcode || 'unknown'}`);
      }
    }
    // 强制刷新本地库，让刚收藏的表情立即可用。
    const synced = await syncStickerLibrary(true);
    const entry = findSticker(synced?.entries ?? stickerEntries, emojiId);
    return { emojiId, entry: entry || null, remark: cleanRemark };
  }

  function saveSlangStore() {
    if (!slangStoreWritable) {
      log('⚠️ 黑话库处于只读降级状态（启动时加载失败），本次改动不落盘');
      return;
    }
    try {
      const result = saveSlang(SLANG_FILE, slangEntries);
      if (result?.dropped > 0) {
        slangEntries = result.entries;
        log(`黑话库超过 ${SLANG_MAX_ENTRIES} 条上限，已按「已确认优先」丢弃 ${result.dropped} 条最不活跃的词条`);
      }
    } catch (error) { log('保存黑话库失败:', error?.message ?? error); }
  }

  function queueSlangTask(fn) {
    slangTaskChain = slangTaskChain.then(fn).catch((error) => log('黑话学习任务异常:', error?.message ?? error));
    return slangTaskChain;
  }

  async function ensureSlangLearnerSession() {
    const preset = resolvePresetName(cfg.slang?.learnerPreset || cfg.agentPreset, { strict: true });
    if (!preset) throw new Error('黑话学习缺少已验证的安全 preset，拒绝创建或复用会话');
    const saved = readJsonSafe(SLANG_SESSION_FILE, null);
    // 旧记录没有 preset 元数据，无法证明其权限，必须重新创建。
    if (saved?.preset !== preset) invalidateSlangLearnerSession();
    if (slangLearnerSessionId) {
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      return slangLearnerSessionId;
    }
    if (saved?.sessionId && saved.preset === preset) {
      slangLearnerSessionId = String(saved.sessionId);
      learnerSessions.add(slangLearnerSessionId);
      api.events.follow(slangLearnerSessionId);
      await ensureChatModel(slangLearnerSessionId, 'research');
      return slangLearnerSessionId;
    }
    const dir = path.join(STATE_DIR, 'slang-agent');
    fs.mkdirSync(dir, { recursive: true });
    const wsValue = unwrap(await api.workspace.create({ path: dir }), 'slang workspace.create');
    const workspaceTitle = cfg.slang?.workspaceTitle || 'QQ 黑话学习';
    if (wsValue.created && workspaceTitle) {
      try { await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: workspaceTitle }); } catch {}
    }
    const params = { workspaceId: wsValue.workspace.workspaceId };
    params.agentPreset = preset;
    const value = unwrap(await api.sessions.create(params), 'slang session.create');
    slangLearnerSessionId = value.sessionId;
    learnerSessions.add(slangLearnerSessionId);
    api.events.follow(slangLearnerSessionId);
    await ensureChatModel(slangLearnerSessionId, 'research');
    fs.mkdirSync(STATE_DIR, { recursive: true });
    atomicWriteJson(SLANG_SESSION_FILE, { sessionId: slangLearnerSessionId, preset });
    log(`黑话学习会话已创建：${slangLearnerSessionId}`);
    return slangLearnerSessionId;
  }

  function invalidateSlangLearnerSession() {
    // 如果在途任务仍在使用旧会话，先保留 learnerSessions 以便事件继续被消费；
    // 没有等待/收集中的旧会话才从集合移除。
    const oldId = slangLearnerSessionId;
    slangLearnerSessionId = null;
    if (oldId && !learnerWaiters.has(oldId) && !learnerCollectors.has(oldId)) {
      learnerSessions.delete(oldId);
    }
    try { fs.unlinkSync(SLANG_SESSION_FILE); } catch {}
  }

  function waitLearnerTurn(sessionId, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const arr = learnerWaiters.get(sessionId) ?? [];
        const idx = arr.findIndex((w) => w.timer === timer);
        if (idx >= 0) arr.splice(idx, 1);
        if (arr.length === 0) learnerWaiters.delete(sessionId);
        reject(new Error(`等待学习会话 turn 超时(${timeoutMs}ms)`));
      }, timeoutMs);
      const waiter = { resolve, reject, timer };
      const arr = learnerWaiters.get(sessionId) ?? [];
      arr.push(waiter);
      learnerWaiters.set(sessionId, arr);
    });
  }

  async function runSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;

    let sessionId;
    try {
      sessionId = await ensureSlangLearnerSession();
    } catch (error) {
      log(`黑话学习会话创建失败 (${key}):`, error?.message ?? error);
      return;
    }

    // 上一次提取/研究若超时，会话里可能还挂着一个在跑的 turn；它的 turn/end 会被这次提取的
    // waiter 收到，导致拿到的不是这一批的结果。有在途 collector 就先重建会话。
    if (learnerCollectors.has(sessionId)) {
      log('黑话提取：学习会话存在在途 turn，重建学习会话避免结果错位');
      invalidateSlangLearnerSession();
      try {
        sessionId = await ensureSlangLearnerSession();
      } catch (error) {
        log(`黑话学习会话重建失败 (${key}):`, error?.message ?? error);
        return;
      }
    }

    const promptText = buildExtractionPrompt(messages);
    try {
      const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
      if (!accepted.result.ok) {
        log(`黑话提取被拒 (${key}): ${accepted.result.error.code}: ${accepted.result.error.message}`);
        return;
      }
      const output = await waitLearnerTurn(sessionId);
      const items = parseExtractionJson(output);
      if (!items.length) {
        log(`黑话提取：${key} 未发现候选`);
        const win = slangWindows.get(key) ?? [];
        slangWindows.set(key, win.slice(messages.length));
        return;
      }
      let added = 0;
      let updated = 0;
      const researchCandidates = [];
      const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
      const seenContents = new Set();
      for (const item of items) {
        if (seenContents.has(item.content)) continue;
        seenContents.add(item.content);
        const idx = Number(item.source_id) - 1;
        const src = Number.isInteger(idx) && idx >= 0 && idx < messages.length ? messages[idx] : null;
        const evidence = src ? [{ key, sender: src.sender, text: src.text, time: src.time }] : [];
        const result = upsertSlangEntry(slangEntries, item.content, { evidence, countIncrement: 1 });
        if (result.created) added += 1; else updated += 1;
        if (result.entry && result.entry.status === SLANG_STATUS.CANDIDATE && thresholds.includes(result.entry.count) && result.entry.count > result.entry.lastInferenceCount) {
          researchCandidates.push(result.entry);
        }
      }
      const win = slangWindows.get(key) ?? [];
      slangWindows.set(key, win.slice(messages.length));
      saveSlangStore();
      log(`黑话提取：${key} 新增 ${added} 条，更新 ${updated} 条`);
      if (researchCandidates.length && cfg.slang?.autoResearch !== false) {
        queueSlangTask(() => runSlangResearch(researchCandidates));
      }
    } catch (error) {
      if (/超时|timeout|会话|session|not.?found|404/i.test(String(error?.message ?? error))) {
        invalidateSlangLearnerSession();
      }
      log(`黑话提取失败 (${key}):`, error?.message ?? error);
    }
  }

  async function runSlangResearch(candidates) {
    if (!candidates || !candidates.length) return;
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    // 过滤掉已经在研究队列里的候选，避免同一批被重复排队研究。
    const maxPerRun = Math.max(1, Math.min(20, Number(cfg.slang?.researchMaxPerRun) || 6));
    const targets = candidates.filter((e) => e && !slangResearchingIds.has(e.id)).slice(0, maxPerRun);
    if (!targets.length) return;
    for (const e of targets) slangResearchingIds.add(e.id);
    // 一次 prompt 研究几个词：联网研究很慢，分批可以把「一个词卡死」的影响限制在一小批里。
    const batchSize = Math.max(1, Math.min(3, Number(cfg.slang?.researchBatchSize) || 2));
    const timeoutMs = Math.max(60000, Number(cfg.slang?.researchTimeoutMs) || 240000);
    let confirmedWrites = 0;
    let tentativeWrites = 0;
    let noMeaning = 0;
    try {
      for (let offset = 0; offset < targets.length; offset += batchSize) {
        const batch = targets.slice(offset, offset + batchSize);
        let sessionId;
        try {
          sessionId = await ensureSlangLearnerSession();
        } catch (error) {
          log('黑话研究会话创建失败:', error?.message ?? error);
          continue;
        }
        // 上一批如果超时，学习会话里可能还挂着一个在跑的 turn；它的 turn/end 会被下一批的
        // waiter 收到，导致「拿到的结果不是这一批的」（内容对不上 → 全部 continue → 看起来研究没返回）。
        // 发现会话里有在途 collector 就重建，保证 prompt 与 turn 一一对应。
        if (learnerCollectors.has(sessionId)) {
          log('黑话研究：学习会话存在在途 turn，重建学习会话避免结果错位');
          invalidateSlangLearnerSession();
          try {
            sessionId = await ensureSlangLearnerSession();
          } catch (error) {
            log('黑话研究会话重建失败:', error?.message ?? error);
            continue;
          }
        }
        const promptText = buildResearchPrompt(batch);
        try {
          const accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content: [{ type: 'text', text: promptText }] });
          if (!accepted.result.ok) {
            log(`黑话研究被拒: ${accepted.result.error.code}: ${accepted.result.error.message}`);
            continue;
          }
          const output = await waitLearnerTurn(sessionId, timeoutMs);
          const results = parseResearchJson(output);
          for (const r of results) {
            const entry = slangEntries.find((e) => e.content === r.content);
            if (!entry) continue;
            const at = new Date().toISOString();
            const hasContent = Boolean(r.meaning || r.usage || r.example || r.risk || (Array.isArray(r.sources) && r.sources.length));
            if (hasContent) {
              entry.research = {
                confirmed: r.confirmed === true,
                meaning: r.meaning,
                usage: r.usage,
                example: r.example,
                risk: r.risk,
                sources: r.sources,
                confidence: r.confidence,
                at,
                raw: String(output ?? '').slice(-2000)
              };
            }
            if (r.confirmed === true) {
              if (r.meaning) entry.meaning = r.meaning;
              if (r.usage) entry.usage = r.usage;
              if (r.example) entry.example = r.example;
              if (r.risk) entry.risk = r.risk;
              if (Array.isArray(r.sources) && r.sources.length) entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
              confirmedWrites += 1;
            } else if (hasContent) {
              // 未确认也落地：写进 meaning 让控制台能看到并能人工确认；状态仍是 candidate。
              // 旧实现把未确认结果整条丢掉，控制台就永远显示「待研究」——这才是"研究没落实"的根因。
              if (r.meaning && !entry.meaning) entry.meaning = r.meaning;
              if (Array.isArray(r.sources) && r.sources.length && (!entry.sources || entry.sources.length === 0)) {
                entry.sources = r.sources.map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 10);
              }
              tentativeWrites += 1;
            } else {
              noMeaning += 1;
              continue;
            }
            // 只有拿到内容才推进研究水位；否则允许后续再次研究（可能是模型这次没搜到）。
            entry.lastInferenceCount = entry.count;
            entry.updatedAt = at;
          }
          saveSlangStore();
        } catch (error) {
          const message = String(error?.message ?? error);
          log('黑话研究失败:', message);
          // 超时后残留的 turn 会污染下一批，直接重建会话。
          if (/超时|timeout|会话|session|not.?found|404/i.test(message)) invalidateSlangLearnerSession();
        }
      }
      log(`黑话研究：写入 ${confirmedWrites + tentativeWrites} 条（确认 ${confirmedWrites} / 待确认 ${tentativeWrites}）${noMeaning ? `，无释义 ${noMeaning} 条` : ''}（本轮候选 ${targets.length} 条）`);
    } finally {
      for (const e of targets) slangResearchingIds.delete(e.id);
    }
  }

  function maybeQueueSlangExtraction(key) {
    if (cfg.slang?.enabled === false) return;
    if (!dshReady) return;
    const cooldown = Number(cfg.slang?.extractCooldownMs ?? 300000);
    const last = slangExtractionCooldowns.get(key) ?? 0;
    if (Date.now() - last < cooldown) return;
    const messages = slangWindows.get(key) ?? [];
    const min = Math.max(1, Number(cfg.slang?.extractMinMessages ?? 10));
    if (messages.length < min) return;
    slangExtractionCooldowns.set(key, Date.now());
    queueSlangTask(() => runSlangExtraction(key));
  }

  // 黑话学习素材入口：群聊普通消息进入滚动窗口（命令/角色控制语不学；
  // 只学当前消息自己的文字，不学引用原文）。旧版/仿真共用。
  function feedSlangWindow(key, sender, plainContent) {
    if (cfg.slang?.enabled === false) return;
    if (!key || !plainContent || typeof plainContent !== 'string') return;
    const text = plainContent.trim();
    if (!text || text.startsWith('/')) return;
    if (/进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(text)) return;
    if (!slangWindows.has(key)) slangWindows.set(key, []);
    const win = slangWindows.get(key);
    win.push({ sender: String(sender || '未知'), text: truncateText(text, 200), time: Date.now() });
    if (win.length > 80) win.splice(0, win.length - 80);
    maybeQueueSlangExtraction(key);
  }

  // AI 提交黑话候选的限频：防止单个会话在短时间内刷大量候选。
  function allowSlangSubmit(key) {
    const now = Date.now();
    const arr = (slangSubmitTimes.get(key) ?? []).filter((t) => now - t < 60 * 60 * 1000);
    const recentMinute = arr.filter((t) => now - t < 60 * 1000).length;
    const MAX_PER_MINUTE = 2;
    const MAX_PER_HOUR = 10;
    if (recentMinute >= MAX_PER_MINUTE || arr.length >= MAX_PER_HOUR) return false;
    arr.push(now);
    slangSubmitTimes.set(key, arr);
    return true;
  }

  // 返回给 AI 的“公开黑话条目”（只含安全展示字段，不泄露内部字段）。
  //
  // 刻意**不含 evidence**：证据行的形状是 `{ key, sender, text, time }`，
  // 其中 text 是提交该词条的那个会话里的消息片段、key 是那个会话的名字。
  // 黑话库是全群共享的，带上 evidence 就等于让 A 群的 AI 读到 B 群的会话名和原话。
  // 控制台要证据走 `GET /api/slang`（原始条目，含 evidence，仅控制台可达）。
  function publicSlangEntry(e) {
    return {
      id: e?.id ?? '',
      content: e?.content ?? '',
      meaning: e?.meaning ?? '',
      usage: e?.usage ?? '',
      example: e?.example ?? '',
      risk: e?.risk ?? '',
      status: e?.status ?? SLANG_STATUS.CANDIDATE,
      source: e?.source ?? 'ai',
      count: Number(e?.count) || 0,
      updatedAt: e?.updatedAt ?? ''
    };
  }

  // 已确认黑话的公开列表（按出现次数排序，最多 injectMax 条）。
  function confirmedSlangList() {
    const max = Math.max(1, Math.min(30, Number(cfg.slang?.injectMax) || 12));
    return slangEntries
      .filter((e) => e.status === SLANG_STATUS.CONFIRMED && e.content && e.meaning)
      .sort((a, b) => (Number(b.count) || 0) - (Number(a.count) || 0))
      .slice(0, max)
      .map(publicSlangEntry);
  }

  function withSlangContext(promptText, key = '') {
    const now = new Date();
    const timeLine = `【当前时间】${now.toLocaleString('zh-CN', { hour12: false })}（${Intl.DateTimeFormat().resolvedOptions().timeZone}）`;
    const parts = [timeLine];
    if (cfg.slang?.enabled !== false) {
      const st = key ? getSimulationState(key) : null;
      const recentText = (st?.recentMessages || []).slice(-24).map((m) => String(m?.text || m?.plain || '')).join(' ');
      const block = buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 12, { recentText });
      if (block) parts.push(block);
    }
    return parts.join('\n\n') + '\n\n' + promptText;
  }

  if (!cfg.allow.private.length && !cfg.allow.groups.length && cfg.allowAllWhenEmpty) {
    log('⚠️  白名单为空且 allowAllWhenEmpty=true：将转发所有私聊/群聊消息给 agent');
  } else if (!cfg.allow.private.length && !cfg.allow.groups.length) {
    // 否则这是一个「静默无响应」陷阱：消息全被丢弃，用户只看到 QQ 上毫无反应。
    log(`⚠️  白名单为空且 allowAllWhenEmpty=false：不会响应任何 QQ 消息。请在 config.json 填 allow.private / allow.groups，或在控制台 http://127.0.0.1:${cfg.consolePort} 填写白名单`);
  }
  // 未配置管理员 QQ 时，一串功能会「静默失灵」：审批永远无法被回答（agent 一直等到超时）、
  // 管理命令全部被拒、封闭 agent 模式实际不可达。这里在启动日志里说清楚，避免排查时误判。
  if (!cfg.ownerQQ) {
    log('⚠️  未配置 ownerQQ：审批/管理命令/封闭 agent 模式将全部不可用。请在 config.json 或控制台「访问与安全」页填写管理员 QQ');
  }
  if (cfg.simulation?.voice?.allowAbsolutePath === true) {
    // 该开关曾经允许 AI 发送语音库之外的任意本机音频文件（prompt injection 可用来外发文件）。
    // 现在无论开关如何，AI 通道都只接受语音库内的文件；这里提示它已经不再放宽边界。
    log('ℹ️  simulation.voice.allowAbsolutePath=true 已不再放宽 AI 通道：AI 发的语音始终只允许来自语音库（库外文件请用语音工具/CLI 发送）');
  }

  // DSH 侧
  const api = new NodeApiClient(cfg.dsh.baseUrl, undefined, {
    token: cfg.dsh.authToken,
    // true=用户在 config.json 里显式填的；false=从日志猜的。猜来的不优先于离线铸造。
    tokenExplicit: cfg.dsh.authTokenExplicit === true,
    header: cfg.dsh.authHeader,
    prefix: cfg.dsh.authPrefix,
    // 默认只允许把 launch token 交给回环地址；远程 DSH 需要显式 opt-in（见 dsh-client.ensureAuth）。
    allowRemote: cfg.dsh.allowRemote === true
  });
  // DSH 的模型目录 RPC：0.1.5 是 `session/modelCatalog`。**不能走基类门面**
  // `api.sessions.modelCatalog` —— 桥接钉住的 `@deepseek-ai/dsh-host-apiproxy@0.1.1-rc.2`
  // 的 sessions 门面里根本没有这个方法（只有 `models` → 已下线的 `session/models`），
  // 调用会抛 “api.sessions.modelCatalog is not a function”，让思考强度档位静默退回内置清单。
  // 这里直接用桥接自己覆写的 callUnary（它本来就是为「不依赖旧版客户端域方法」而存在的），
  // 并保留一次 `session/models` 回落以兼容更老的 DSH。
  const modelCatalogErrorLogged = new Set();
  async function fetchModelCatalog() {
    try {
      return await api.callUnary('session.modelCatalog', {});
    } catch (error) {
      const message = String(error?.message ?? error);
      if (!/not.?found|unknown|unsupported|404|invalid server-response/i.test(message)) throw error;
      return api.callUnary('session.models', {});
    }
  }
  const collectors = new Map(); // sessionId -> turn collector
  const sendToolSucceededSessions = new Set(); // sessionId：当前 turn 内 MCP 发送类工具至少成功一次
  const simulationTurnStartAt = new Map(); // sessionId -> timestamp：simulation turn 开始时间，用于判断是否“无行动”
  const toolCallNames = new Map(); // sessionId -> Map<callId, toolName>：用于结果日志关联工具名
  const pendingSendToolCalls = new Map(); // sessionId -> Set<callId>：等待 tool/result 的发送类调用
  // simulation 防“忘记设置唤醒条件”：key -> 当前是否等待 AI 处理唤醒回合 / 本回合已更新唤醒配置 / 连续未设置次数
  const pendingWakeKeys = new Set();
  // key -> 开始等待的时间戳（带租约）：正在执行 qq_wait_for_messages 长轮询的会话，防止同一会话并发挂起。
  // 存时间戳而不是单纯放进 Set，是因为 handler 中间任何异常都会跳过 finishWait ——
  // 那样这个 key 会被永远 429 掉（DSH 的 fetch 不会主动断开连接，req 'close' 也不会触发）。
  const activeWaits = new Map();
  /**
   * 单次等待的租约上限：正常等待最长 = timeout 预算 + 静默窗口 + 5s 余量，
   * 这里给足余量；超过就认为上一次是异常退出留下的残留，允许新的等待接管。
   */
  const ACTIVE_WAIT_LEASE_MS = 15 * 60 * 1000;
  /**
   * 回合判忙租约：只要 `turn/start` 的结束信号（turn/end）丢了，会话就会**永久**判忙，
   * 之后所有唤醒只进 pendingWakeReasons、QQ 上表现为「它不理我了」，只能重启（issue #11/#23/#26/#19）。
   * 正常回合 1~3 分钟，最长工具调用（DSH 的 toolCallTimeoutMs）≈12 分钟，15 分钟足以覆盖任何
   * **还活着**的回合。过期只是不再判忙：collector 本身保留，真回复照常 flush，只是允许新唤醒排队。
   */
  const TURN_BUSY_LEASE_MS = 15 * 60 * 1000;
  const turnLeaseNoted = new Set(); // 租约过期的日志去重（每个 session 只记一次）
  const pendingWakeLeaseTimers = new Map(); // key -> timeout：防止 accepted 但无 turn/end 的唤醒把 key 永久标记为 busy
  const wakeConfigUpdatedKeys = new Set();
  const markReadCalledKeys = new Set();
  const wakeConfigMissCount = new Map();
  const reverse = new Map(); // sessionId -> conv key
  for (const [key, sessionId] of Object.entries(state.sessions)) reverse.set(sessionId, key);
  // 新版 DSH 事件流需要显式 follow；启动时为已持久化的 QQ 会话补上。
  for (const sessionId of Object.values(state.sessions)) api.events.follow(sessionId);
  const sessionPromises = new Map(); // key -> create promise（防并发重复创建）
  const promptQueues = new Map(); // key -> { queue: [], running: false }：每个 QQ 会话串行投递 DSH prompt，保证 turn 顺序

  // ── Token 用量账本（控制台「令牌与花费」） ───────────────────────────────
  // 权威总量取 DSH 的 tokenUsage 投影（整条会话日志累计，含桥接启动前的历史），
  // 逐轮明细由 assistant/message 的 usage 折叠而来；花费在读取时按价目表折算。
  const priceTable = resolvePriceTable(cfg.pricing);
  const tokenLedger = createTokenLedger({
    file: TOKEN_USAGE_FILE,
    log: (...args) => log(...args),
    priceTable,
    // 会话 → QQ 会话归属：学习会话单独记账，其余未知会话归入「未归属」。
    resolveKey: (sessionId) => reverse.get(sessionId)
      ?? (learnerSessions.has(sessionId) || (slangLearnerSessionId && sessionId === slangLearnerSessionId)
        ? 'internal:黑话学习'
        : undefined)
  });

  /** sessionId -> 最近一次已知的实际模型。切换模型会让单价差好几倍，所以按会话记。 */
  const sessionModels = new Map();
  const nominalModel = () => cfg.dsh?.model || 'deepseek-flash';

  function rememberModel(sessionId, selection) {
    const model = selection?.model;
    if (typeof model === 'string' && model) {
      sessionModels.set(sessionId, { model, provider: selection?.provider });
    }
  }

  /** 摄入一条会话事件到 token 账本；任何异常都不能影响 QQ 主链路。 */
  function recordSessionUsage(sessionId, event) {
    try {
      if (event?.type === 'model/selection') rememberModel(sessionId, event.data);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestEvent({
        sessionId,
        event,
        model: event?.data?.usage?.model ?? known?.model,
        provider: event?.data?.provider ?? known?.provider
      });
      // 上下文水位：input tokens 近似「这条会话的历史有多大」。超过阈值时下一次唤醒会
      // 归档旧会话并注入衔接摘要（见 maybeRotateSessionForContext）。
      const raw = usageOfEvent(event);
      if (raw) {
        const input = Number(
          raw.inputTokens ?? raw.input_tokens ?? raw.promptTokens ?? raw.prompt_tokens
          ?? ((Number(raw.cacheMiss) || 0) + (Number(raw.cacheHit) || 0) + (Number(raw.cacheWrite) || 0))
        );
        const key = reverse.get(sessionId);
        const st = key ? simulation.conversations.get(key) : null;
        if (st && Number.isFinite(input) && input > 0) {
          const threshold = Number(cfg.simulation?.context?.rotateAtTokens) || 0;
          const previous = Number(st.lastContextTokens) || 0;
          st.lastContextTokens = input;
          st.lastContextTokensAt = Date.now();
          if (threshold && input >= threshold && previous < threshold) {
            saveSimulationState();
            log(`[context] ${key} 上下文约 ${input} tokens（≥ ${threshold}），下一次唤醒将归档旧会话`);
          }
        }
      }
      // 预算账本：按 (session, turn, step, retry) 幂等落库；失败不影响主流程。
      if (budgetStore && raw) {
        try {
          const buckets = normalizeUsage(raw);
          const tokensIn = Number(buckets.cacheMiss || 0) + Number(buckets.cacheHit || 0) + Number(buckets.cacheWrite || 0);
          const tokensOut = Number(buckets.output || 0) + Number(buckets.reasoning || 0);
          if (tokensIn + tokensOut > 0) {
            const modelName = known?.model || event?.data?.model || event?.data?.usage?.model || '';
            const at = Number(event?.time) || Date.now();
            let cost = 0;
            try { cost = priceUsage(buckets, { model: modelName, at, table: resolvePriceTable(cfg.pricing) }); } catch {}
            budgetStore.record({
              key: reverse.get(sessionId) || '',
              sessionId,
              turn: event?.data?.turn,
              step: event?.data?.step,
              retry: event?.data?.retry,
              model: modelName,
              provider: known?.provider || event?.data?.provider || '',
              tokensIn,
              tokensOut,
              cost,
              at
            });
          }
        } catch (error) {
          log(`[budget] 记账失败（忽略）：${error?.message ?? error}`);
        }
      }
    } catch (error) {
      log('token 账本：摄入事件失败', error?.message ?? error);
    }
  }

  /**
   * 处理会话开场快照：
   * 1. `projections.tokenUsage` 是**整条会话日志**的权威累计桶（含桥接启动前的历史）；
   * 2. `records` 是最近若干条历史事件，用来回填「逐轮花费」。
   * 重连时该帧会重新下发，账本内部按 (turn, step, retry) + seq 做幂等折叠，不会翻倍。
   */
  function recordSessionSnapshot(sessionId, snapshot) {
    try {
      if (!snapshot) return;
      const selection = snapshot.projections?.values?.modelSelection;
      rememberModel(sessionId, selection?.lastUsed ?? selection?.pending ?? null);
      const known = sessionModels.get(sessionId);
      tokenLedger.ingestBaseline({
        sessionId,
        projection: snapshot.projections,
        at: Date.now(),
        model: known?.model ?? nominalModel(),
        provider: known?.provider ?? cfg.dsh?.provider
      });
      tokenLedger.ingestSnapshotRecords({ sessionId, records: snapshot.records });
      rebuildInFlightCollector(sessionId, snapshot.records);
    } catch (error) {
      log('token 账本：处理会话快照失败', error?.message ?? error);
    }
  }

  /**
   * 重连后重建「断线时正在跑的那个回合」的 collector。
   *
   * 为什么必须有这一步：`pumpMux` 的 finally 会在断线时清空 `collectors`（否则重连后
   * 旧状态会让回复重复累加）。而重连时 DSH **只**通过开场快照重放历史 —— 快照被刻意
   * 排除在事件通道之外（否则历史回合会被当成新回合重复发送）。于是断线前发出的
   * `turn/start` 再也补不回来：重连后到达的 live `turn/end` 找不到对应回合，
   * `createTurnCollector.push()` 返回 null ⇒ **这一轮的回复被静默丢弃**（QQ 上没消息、
   * 日志里没记录、token 却照付）。
   *
   * 修法：只把「有 turn/start 但没有 turn/end」的回合重放进 collector ——
   * 这些正是断线那一刻仍在进行的回合。已结束的回合一律不喂，所以不会重复回复。
   */
  function rebuildInFlightCollector(sessionId, records) {
    if (!Array.isArray(records) || !records.length) return;
    const eventOf = (entry) => (entry?.type === 'event' ? entry.event : entry);
    const open = new Set();
    for (const entry of records) {
      const event = eventOf(entry);
      if (event?.type === 'turn/start') open.add(event.data?.turn);
      else if (event?.type === 'turn/end') open.delete(event.data?.turn);
    }
    if (!open.size) return;
    const collector = createTurnCollector();
    let restored = 0;
    for (const entry of records) {
      const event = eventOf(entry);
      // 只回放未结束回合的文本来源：turn/start 建立回合，assistant/message 累积文本。
      if (event?.type !== 'turn/start' && event?.type !== 'assistant/message') continue;
      if (!open.has(event.data?.turn)) continue;
      collector.push(event);
      restored += 1;
    }
    if (!restored) return;
    collectors.set(sessionId, collector);
    // 恢复出来的回合也必须带起始时间，否则租约对它无从生效 —— 这正是
    // 「DSH 重启后忙标记永不复位」的那条路径（issue #19）。不知道真实起点时按现在算：
    // 活着的回合会在 turn/end 清掉；真丢了的回合最多再忙一个租约期就自动解除。
    if (!simulationTurnStartAt.has(sessionId)) simulationTurnStartAt.set(sessionId, Date.now());
    log(`重连后恢复了进行中的回合（${sessionId}，turn ${[...open].join(',')}）`);
  }

  // 唤醒“防卡死”租约：正常应在 turn/end 时删除 pendingWakeKeys；若 DSH 接受了但一直没回合结束，
  // 30 分钟后强制解除 busy 标记，避免该会话永久无法被唤醒。
  function armPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    const timer = setTimeout(() => {
      pendingWakeKeys.delete(key);
      pendingWakeLeaseTimers.delete(key);
    }, 30 * 60 * 1000);
    timer.unref?.();
    pendingWakeLeaseTimers.set(key, timer);
  }
  function disarmPendingWakeLease(key) {
    const old = pendingWakeLeaseTimers.get(key);
    if (old) clearTimeout(old);
    pendingWakeLeaseTimers.delete(key);
  }
  function clearAllPendingWakeLeases() {
    for (const t of pendingWakeLeaseTimers.values()) clearTimeout(t);
    pendingWakeLeaseTimers.clear();
  }

  // DSH 可用性探活 + 重启容错队列：
  // DSH 重启期间收到的 QQ 消息先入队（不丢），DSH 恢复后按序补投。
  let dshReady = false;
  let dshCheckStarted = false;
  let snowlumaWatchStarted = false; // SnowLuma 上游健康探测只启动一次（见 startSnowlumaWatch）
  let currentMode = 'chat'; // chat | closed-agent | reserved（仿真模式，由 DSH settings / state/mode.json 驱动）
  let lastMode = currentMode;
  // closed-agent 模式使用的 DSH agent preset：留空表示「用 DSH 自己声明的默认 preset」。
  // 旧版本这里硬编码 'router-standard'，但 DSH 0.1.5 已移除该 preset，硬编码会导致
  // 创建出的会话挂不上 preset，进而被 DSH 套上 standard（含本地工具）。
  let closedAgentPreset = '';
  // DSH 侧真实的 preset 清单与默认 preset：旧版本这里是硬编码的 'router-standard'，
  // 但 DSH 0.1.5 已不存在该 preset，硬编码会让 closed-agent 模式永远挂不上 preset。
  let dshPresetIds = [];        // 当前 DSH 可用的 preset id 列表（agentPresets/list）
  let dshDefaultPreset = '';    // DSH settings `agent-presets.default`，取不到时用列表里的 isDefault
  const queued = new Map(); // key -> { promptText }[]
  const queuedHintAt = new Map(); // key -> timestamp（冷却提示）
  const QUEUE_MAX = 50;
  const QUEUE_HINT_COOLDOWN_MS = 30_000;
  const queueRetries = new Map(); // key -> 连续补投失败次数（用于退避/暂停恢复）
  // 这些错误重试不会自愈：群不存在/被移出，或本地守卫明确拦截的内容。
  const PERMANENT_DELIVERY_RE = /令牌|敏感|白名单|不允许|非法|不支持|不在当前模式|群.*(不存在|解散)|被移出|已退出该群|not in group|kicked from group/i;

  // reset 竞态导致 ensureSession 抛「会话创建期间已重置」时，把消息放回队列稍后重试。
  // 已在队列中的相同文本不重复入队。
  const enqueueForRetry = (key, promptText, opts = {}) => {
    const items = queued.get(key) ?? [];
    if (!items.some((it) => it.promptText === promptText)) {
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
    }
    queueRetries.delete(key); // 新消息入队视为新的机会，重置退避计数
    setTimeout(() => { flushQueue(); }, 3000);
  };

  // 从 DSH settings 读取桥接模式；命名空间未注册时回退本地 state/mode.json
  async function refreshMode() {
    try {
      const s = unwrap(await api.settings.describe({}), 'settings.describe');
      // DSH 的默认 preset（`agent-presets` 命名空间的 default）——closed-agent 的兜底值来源
      const presetNs = s.namespaces.find((n) => n.ns === 'agent-presets');
      const defaultPreset = settingFromDshNamespace(presetNs, 'default');
      if (typeof defaultPreset === 'string' && defaultPreset) {
        dshDefaultPreset = defaultPreset;
      }
      const ns = s.namespaces.find((n) => n.ns === 'qq-mode');
      // 规范化后再比较：`simulation` 也走这里（见 MODE_INPUT_ALIASES）。
      // 读取必须 user 层优先：DSH 0.2.0-rc.2 写完 settings 后同进程内 value 不更新，
      // 只读 value 会让控制台切的模式被 5 秒轮询改回去（issue #22）。
      const fromDsh = normalizeModeInput(settingFromDshNamespace(ns, 'mode'));
      if (fromDsh) {
        currentMode = fromDsh;
        // DSH 设置页也可配置管理员 QQ；**留空表示不覆盖 config.json**
        // （见 integrations/dsh/mode-console 的 schema 描述）。这里必须显式判断空串：
        // normalizeOwnerQQ('') 返回 null，若照旧 `!== undefined` 就直接赋值，
        // 设置页每次轮询都会把 config.json 里的 ownerQQ 抹成 null —— 而 5 秒一次的
        // refreshMode 会让它「几秒后必然发生」，后果是 closed-agent 谁都不放行、
        // 审批/提问永远等不到管理员回答。
        const rawOwnerValue = settingFromDshNamespace(ns, 'ownerQQ');
        if (rawOwnerValue !== undefined) {
          const rawOwner = String(rawOwnerValue ?? '').trim();
          if (rawOwner) {
            try {
              cfg.ownerQQ = normalizeOwnerQQ(rawOwner);
            } catch (error) {
              log(`DSH settings ownerQQ 无效，已忽略: ${error?.message ?? error}`);
            }
          }
        }
        // DSH 的 qq-mode schema 只有 mode / ownerQQ 两个字段，没有 closedAgentPreset；
        // 该值仍以本地 state/mode.json 为准（用 typeof 判断，允许用空串显式清空），
        // 否则这里提前 return 会让控制台的 preset 下拉变成永远不生效的死设置。
        const localPreset = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
        if (typeof localPreset?.closedAgentPreset === 'string') {
          closedAgentPreset = localPreset.closedAgentPreset;
        }
        return;
      }
    } catch {}
    const local = readJsonSafe(path.join(STATE_DIR, 'mode.json'), null);
    const fromLocal = local ? normalizeModeInput(local.mode) : null;
    if (fromLocal) currentMode = fromLocal;
    if (typeof local?.closedAgentPreset === 'string' && local.closedAgentPreset) {
      closedAgentPreset = local.closedAgentPreset;
    }
  }

  /** 拉取 DSH 当前可用的 agent preset 清单（供控制台下拉与 closed-agent 兜底使用）。 */
  async function refreshPresetList() {
    try {
      const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPresets.list');
      dshPresetIds = list.map((p) => String(p.id));
      if (!dshDefaultPreset) {
        const marked = list.find((p) => p.isDefault === true);
        if (marked) dshDefaultPreset = String(marked.id);
      }
    } catch (error) {
      log(`获取 DSH preset 列表失败：${error?.message ?? error}（会话将按配置的 preset 尝试创建）`);
    }
  }

  /** 当前模式是否允许该会话进入 */
  function modeAllowed(key, kind, id, cfg, mode) {
    if (mode === 'closed-agent') {
      // 封闭 agent 模式：仅 owner 私聊
      return key === `private:${String(cfg.ownerQQ ?? '')}`;
    }
    // chat / reserved / simulation（仿真模式，暂同 chat 白名单）
    return allowed(kind, id, cfg);
  }

  /**
   * 解析一个 preset 名。
   *
   * strict=false（closed-agent，仅 owner 私聊）：名字不可用时回退到 DSH 默认 preset ——
   *   那里本来就用完整工具面，回退不构成提权。
   * strict=true（chat / reserved / simulation，会话可能属于 QQ 群）：名字不可用时返回 ''，
   *   表示「没有可安全使用的 preset」，由调用方拒绝建会话（fail-closed）。
   *   **绝不能回退到 DSH 默认 preset（standard）**：standard 含 bash/文件读写等本地工具，
   *   一旦套在群聊会话上，群友即可驱动一个能操作本机的 agent（见 RULES.md「无本地工具」）。
   */
  function resolvePresetName(name, { strict = false } = {}) {
    const wanted = String(name ?? '').trim();
    if (!wanted) return strict ? '' : (dshDefaultPreset || '');
    // DSH 可能接受未知 preset 并套用默认值；清单未知时也必须 fail-closed。
    if (dshPresetIds.length === 0) return strict ? '' : wanted;
    if (dshPresetIds.includes(wanted)) return wanted;
    log(`⚠️ preset "${wanted}" 不在 DSH 可用清单（${dshPresetIds.join(', ')}）中`);
    if (strict) {
      log(`⛔ 群聊/仿真会话缺少 preset "${wanted}"，拒绝回退到 DSH 默认 preset（会把本地工具暴露给 QQ 群）；请运行 node tools/install-dsh.mjs 并重启 DSH`);
      return '';
    }
    return dshDefaultPreset || '';
  }

  /** 当前模式下的会话预设；返回 undefined 表示「该模式下没有可安全使用的 preset」 */
  function modePreset(key, mode, cfg) {
    if (mode === 'closed-agent') {
      const chosen = resolvePresetName(closedAgentPreset);
      if (!chosen) log('⚠️ 无法确定 closed-agent 的 preset（DSH preset 清单未知），将按 DSH 默认 preset 建会话');
      return chosen || undefined;
    }
    // 群聊仿真模式优先使用 simulation.agentPreset；未配置时回退到默认聊天预设。
    // 非 closed-agent 一律 strict：宁可建不出会话，也不给群聊套上带本地工具的默认 preset。
    const wanted = mode === 'simulation' ? (cfg.simulation?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
    return resolvePresetName(wanted, { strict: true }) || undefined;
  }

  /** 判断一个会话 key 是否仍被当前模式/白名单允许（供唤醒调度与 HTTP 路由共用）。 */
  function isSessionAllowedInCurrentMode(key) {
    const m = /^(group|private):(\d+)$/.exec(key);
    if (!m) return false;
    return modeAllowed(key, m[1], Number(m[2]), cfg, currentMode);
  }

  function listChatTargets() {
    const groups = (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : [])
      .map((raw) => {
        const id = String(raw).replace(/^group:/, '');
        const key = `group:${id}`;
        return { kind: 'group', id, key, name: liveGroupNames.get(id) || conversationDisplayName(key) || '' };
      })
      .filter((item) => isSessionAllowedInCurrentMode(item.key));
    const privates = (Array.isArray(cfg.allow?.private) ? cfg.allow.private : [])
      .map((raw) => {
        const id = String(raw).replace(/^private:/, '');
        const key = `private:${id}`;
        const name = id === String(cfg.ownerQQ) ? '主人' : (liveFriendNames.get(id) || conversationDisplayName(key) || '');
        return { kind: 'private', id, key, name };
      })
      .filter((item) => isSessionAllowedInCurrentMode(item.key));
    return { groups, privates };
  }

  function sessionPolicy(key) {
    return JSON.stringify([currentMode, modePreset(key, currentMode, cfg) ?? '', currentMode === 'closed-agent' ? cfg.ownerQQ : null]);
  }

  function isCurrentSession(key, sessionId) {
    return isSessionAllowedInCurrentMode(key) && state.sessions[key] === sessionId
      && state.sessionPolicies[key] === sessionPolicy(key);
  }

  /**
   * 让 DSH 停下一个已经不再属于桥接的会话：先清队列再取消在途 turn，最后归档。
   * 拆出来是因为所有「撤销映射」的路径都必须做同样的事（retireSession / session-reset /
   * workspace-reset / reset，以及控制台的仿真状态重置）—— 少一处就会留下
   * 「DSH 还在烧 token、桥接已经收不到也发不出」的静默黑洞。
   */
  function stopRetiredSessionWork(sessionId, key = '') {
    void (async () => {
      try { await withTimeout(api.stopSessionWork(sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
      catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；本地映射已撤销，请在 DSH 检查旧任务`); }
      try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); }
      catch (error) { log(`归档失效会话失败 ${key}: ${error?.message ?? error}`); }
    })();
  }

  /**
   * 撤销一个会话的全部本地状态 —— **唯一**清理入口。
   *
   * 这些 Map/Set 分散在文件各处，四条「撤销会话」路径各自只清了其中一部分，
   * 还互相抄漏过（sessionModels 就只在一半路径里清）。以后新增任何按会话 key
   * 记账的容器，只登记在这里一次即可；不要再在调用点手写 delete。
   *
   * scope:
   *   'mapping'  撤销映射与运行时，但保留会话记录（白名单/模式/preset 变化走这里）：
   *              agentToken 轮换、bootstrapSent 复位，旧 token 仍会被脱敏。
   *   'reset'    连会话记录一起丢弃（/reset、session-reset）：下次消息全新开始。
   *
   * 返回被撤销的 DSH sessionId（可能为空串）。DSH 侧的 stop/archive 由调用方决定
   * 使用 await（用户主动重置，要给回执）还是 fire-and-forget（批量退役）。
   */
  function disposeConversation(key, { scope = 'mapping', save = true } = {}) {
    const sessionId = state.sessions[key] ?? '';
    delete state.sessions[key];
    delete state.sessionPolicies[key];
    if (sessionId) {
      // 按会话 ID 记账的运行时态。漏一个就会留下「DSH 还在跑、桥接已收不到」的黑洞。
      reverse.delete(sessionId);
      collectors.delete(sessionId);
      sessionModels.delete(sessionId);
      modelAppliedSessions.delete(sessionId);
      sendToolSucceededSessions.delete(sessionId);
      pendingSendToolCalls.delete(sessionId);
      simulationTurnStartAt.delete(sessionId);
      turnLeaseNoted.delete(sessionId);
      toolCallNames.delete(sessionId);
      social.silentTurns.delete(sessionId);
      social.exitingSessions.delete(sessionId);
      // 退役的会话要退订：否则 _desiredFollows 只增不减，每次重连都会为它重开
      // 一条 follow 流并重发一整份历史快照（内存与重连延迟都随会话数线性增长）。
      api.events.forget?.(sessionId);
    }
    // 按 key 记账的内存态：有映射和没映射都要清（被移出白名单、从未建过会话的 key
    // 同样会留下限流时间戳与失败标记）。
    lastSendFailed.delete(key);
    activeWaits.delete(key);
    queuedHintAt.delete(key);
    slangSubmitTimes.delete(key);
    feedbackTimes.delete(key);
    wakeConfigMissCount.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
    const pe = pending.get(key);
    if (pe) { clearTimeout(pe.timer); void cancelPendingEntry(pe).catch(() => {}); }
    pending.delete(key);
    social.recentMessages.delete(key);
    messageMediaStore.delete(key);
    social.pendingSummaries.delete(key);
    social.states.delete(key);
    social.silentContext.delete(key);
    slangWindows.delete(key);
    slangExtractionCooldowns.delete(key);
    cancelSocialTimers(key);
    clearSimulationTimers(key);
    disarmPendingWakeLease(key);
    pendingWakeKeys.delete(key);
    wakeConfigUpdatedKeys.delete(key);
    markReadCalledKeys.delete(key);
    wakeConfigMissCount.delete(key);
    seenForwardIds.delete(key);
    if (scope === 'reset') {
      queued.delete(key);
      sessionPromises.delete(key);
      drainPromptQueue(key, '会话已重置');
      forgetAgentToken(key);
      simulation.conversations.delete(key);
    } else {
      const st = simulation.conversations.get(key);
      if (st) {
        // 保留旧 token 在脱敏集合中，但撤销它的调用权限。
        st.agentToken = crypto.randomBytes(24).toString('hex');
        rememberAgentToken(key, st.agentToken);
        st.bootstrapSent = false;
        st.modelSeenSeqs = new Set();
      }
    }
    if (save) { saveState(); saveSimulationState(); }
    return sessionId;
  }

  function retireSession(key) {
    const sessionId = disposeConversation(key, { scope: 'mapping' });
    if (!sessionId) return;
    stopRetiredSessionWork(sessionId, key);
    log(`会话权限已变化，停用旧映射 ${key} -> ${sessionId}`);
  }

  /**
   * 上下文过长时生成一份**本地**衔接摘要（不调用模型、不花钱）：
   * 进行中话题、想说没说、群友印象、最近几轮、操作者初始提示词。
   * 新会话首轮会把它当普通提示注入一次，之后靠正常记忆维护。
   */
  function buildContextDigest(key, st) {
    const max = Number(cfg.simulation?.context?.digestMaxChars) || 1500;
    const parts = ['【衔接摘要】上一条 QQ 会话因上下文过长已归档；下面这些信息仍然有效，接着聊即可，不必向群友说明。'];
    const topics = (Array.isArray(st.activeTopics) ? st.activeTopics : [])
      .slice(-6).map((t) => String(t?.text ?? '').trim()).filter(Boolean);
    if (topics.length) parts.push(`最近话题：${topics.join('；')}`);
    const thoughts = (Array.isArray(st.pendingThoughts) ? st.pendingThoughts : [])
      .filter((t) => t?.text).slice(-3).map((t) => String(t.text).trim());
    if (thoughts.length) parts.push(`想说没说的：${thoughts.join('；')}`);
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions).slice(0, 6);
    if (names.length) {
      parts.push(`对群友的印象：${names.map((n) => {
        const traits = Array.isArray(impressions[n]?.traits) ? impressions[n].traits.slice(0, 3) : [];
        return `${n}${traits.length ? `（${traits.join('、')}）` : ''}`;
      }).join('；')}`);
    }
    const recent = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && !m.isSelf).slice(-6)
      .map((m) => `${String(m.sender || '群友').slice(0, 20)}：${String(m.plain || m.text || '').slice(0, 60)}`);
    if (recent.length) parts.push(`最近几轮：\n${recent.join('\n')}`);
    try {
      const initial = formatInitialPrompt(key);
      if (initial) parts.push(initial);
    } catch { /* 初始提示词读失败不影响摘要 */ }
    return truncateText(parts.join('\n\n'), max);
  }

  /** 只有确实超阈值、不在对话中、距上次旋转足够久时才归档旧会话。 */
  function maybeRotateSessionForContext(key, st, reason = '') {
    const rotateAt = Number(cfg.simulation?.context?.rotateAtTokens) || 0;
    if (!rotateAt || !st || reason === 'bootstrap') return false;
    const contextTokens = Number(st.lastContextTokens) || 0;
    if (contextTokens < rotateAt) return false;
    if (!state.sessions[key]) return false;
    const lastRotation = Number(st.lastRotationAt) || 0;
    if (Date.now() - lastRotation < 10 * 60 * 1000) return false;
    if (isConversationBusy(key, st)) return false;
    const digest = buildContextDigest(key, st);
    retireSession(key);
    const fresh = getSimulationState(key);
    fresh.pendingDigest = digest;
    fresh.lastContextTokens = 0;
    fresh.lastRotationAt = Date.now();
    // 摘要已经承担 bootstrap 的「环境/连续性」作用，避免再多一次唤醒。
    fresh.bootstrapSent = true;
    saveSimulationState();
    log(`[context] ${key} 上下文约 ${contextTokens} tokens ≥ ${rotateAt}，旧会话已归档并生成衔接摘要（${digest.length} 字符）`);
    return true;
  }

  function reconcileSessionPolicies() {
    // DSH preset 清单未知时**绝不能**做退役判定。
    //
    // 为什么：`sessionPolicy()` 包含 `modePreset()` 的结果，而 `modePreset()` 依赖
    // `dshPresetIds`（来自 DSH 的 `agentPresets/list`）。启动瞬间或一次瞬时失败时
    // 这个清单可能是空的，`resolvePresetName(strict)` 于是返回 ''，算出来的策略就变成
    // `["simulation","",null]` —— 与已存的 `["simulation","qq-chat",null]` 不等，
    // 于是**所有** QQ 会话在这一个 tick 里被集体退役：DSH 会话被停掉归档、agentToken 轮换、
    // 映射删除，每个群的上下文全丢，日志里只有一句「会话权限已变化」。
    // 一次网络抖动换来全体失忆，代价完全不成比例。清单为空时宁可不判定，等下一轮。
    if (dshPresetIds.length === 0) return;
    for (const [key, sessionId] of Object.entries(state.sessions)) {
      if (!isCurrentSession(key, sessionId)) retireSession(key);
    }
  }

  let flushingQueue = false;
  let flushQueueAgain = false;
  const flushQueue = async () => {
    // 尾沿重跑：单飞锁只是「别并发跑」，不能把后来的请求直接丢掉。
    // 旧写法在 flush 正在 await 时（一次失败可能卡上 60 秒）把重试定时器的调用直接 return，
    // 于是**再也没有人重新排一次 flush**，队列里的消息会一直躺到下次收到新消息为止。
    if (flushingQueue) { flushQueueAgain = true; return; }
    flushingQueue = true;
    try {
      const entries = [...queued.entries()];
      queued.clear();
      for (const [key, items] of entries) {
        let sent = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
          const item = items[i];
          try {
            const [kind, idStr] = key.split(':');
            const id = Number(idStr);
            if (!modeAllowed(key, kind, id, cfg, currentMode)) {
              log(`补投跳过未授权会话 ${key}（当前模式 ${currentMode}）`);
              continue;
            }
            const result = await deliverPrompt(key, item.promptText, { farewell: item.farewell, silent: item.silent, media: item.media ?? [], wakeReason: item.wakeReason });
            if (!result.ok) {
              log(`补投失败 ${key}: ${result.error || '未知错误'}`);
              failed += 1;
              // 群不存在/被移出/本地守卫拦截这类错误重试多少次都不会成功，留着只会每 60 秒刷一次日志。
              if (PERMANENT_DELIVERY_RE.test(String(result.error || ''))) {
                log(`补投放弃 ${key}: 不可重试错误，丢弃排队中的 ${items.length - i} 条`);
                queueRetries.delete(key);
                break;
              }
              const rest = items.slice(i);
              const existing = queued.get(key) ?? [];
              queued.set(key, rest.concat(existing));
              break;
            }
            queueRetries.delete(key);
            sent += 1;
          } catch (error) {
            log(`补投异常 ${key}: ${error?.message ?? error}`);
            failed += 1;
            if (PERMANENT_DELIVERY_RE.test(String(error?.message ?? error))) {
              log(`补投放弃 ${key}: 不可重试错误，丢弃排队中的 ${items.length - i} 条`);
              queueRetries.delete(key);
              break;
            }
            // 当前项 + 剩余项整体放回，避免丢失；旧消息优先
            const rest = items.slice(i);
            const existing = queued.get(key) ?? [];
            queued.set(key, rest.concat(existing));
            break;
          }
        }
        log(`已补投 ${key}: 成功 ${sent} 条，失败 ${failed} 条`);
        if (failed > 0) {
          const retries = (queueRetries.get(key) ?? 0) + 1;
          queueRetries.set(key, retries);
          if (retries > 5) {
            log(`补投持续失败，暂停快速重试，队列保留 (${key})，60 秒后恢复一次`);
            setTimeout(() => {
              queueRetries.delete(key);
              flushQueue();
            }, 60000);
          } else {
            const delay = Math.min(3000 * Math.pow(2, retries - 1), 60000);
            setTimeout(() => { flushQueue(); }, delay);
          }
        }
      }
    } finally {
      flushingQueue = false;
      if (flushQueueAgain) {
        flushQueueAgain = false;
        // 队列里还有东西才继续；用 setTimeout 让出一次事件循环，避免同步递归。
        if (queued.size > 0) setTimeout(() => { flushQueue(); }, 200);
      }
    }
  };
  const checkDsh = async () => {
    let ok = false;
    try {
      await api.settings.describe({});
      ok = true;
    } catch {}
    if (ok) {
      await refreshMode();
      // DSH 起来后拉一次 preset 清单；DSH 重启（dshReady 由 false 变 true）时再拉一次。
      if (!dshReady || dshPresetIds.length === 0) {
        try { await refreshPresetList(); } catch {}
      }
      reconcileSessionPolicies();
      if (!dshReady) {
        dshReady = true;
        lastMode = currentMode;
        log(`DSH 已就绪（模式: ${currentMode}）`);
        if (currentMode === 'simulation') {
          // 首次确定模式为 simulation 后再恢复持久化的有限睡眠定时器，
          // 避免在 initial chat 模式下设置定时器导致 timeout 唤醒被模式守卫吞掉。
          for (const key of simulation.conversations.keys()) {
            setupSleepTimer(key);
            scheduleProactiveCheck(key);
          }
          log('桥接模式已确定为 simulation，恢复有限睡眠定时器');
        }
        try { await flushQueue(); } catch (error) { log('补投队列异常:', error?.message ?? error); }
        try { innerLife?.start(); } catch (error) { log('内心生活启动异常:', error?.message ?? error); }
        // DSH 恢复后，把离线期间攒下的黑话学习窗口补触发
        for (const key of [...slangWindows.keys()]) maybeQueueSlangExtraction(key);
      } else if (currentMode !== lastMode) {
        if (lastMode === 'reserved' && currentMode !== 'reserved') {
          cleanupSocialForModeChange();
          log('桥接模式已离开旧版仿真模式，清理社交状态');
        }
        if (lastMode === 'simulation' && currentMode !== 'simulation') {
          clearAllSimulationTimers();
          drainAllPromptQueues('模式切换，已取消排队中的投递');
          try { innerLife?.stop(); } catch {}
          log('桥接模式已离开群聊剧场模式，清理 simulation 定时器与排队投递');
        }
        if (currentMode === 'simulation' && lastMode !== 'simulation') {
          for (const key of simulation.conversations.keys()) {
            setupSleepTimer(key);
            scheduleProactiveCheck(key);
          }
          try { innerLife?.start(); } catch (error) { log('内心生活启动异常:', error?.message ?? error); }
          log('桥接模式已进入群聊剧场模式，重建有限睡眠定时器');
        }
        log(`桥接模式已切换为: ${currentMode}`);
        lastMode = currentMode;
      }
    } else if (dshReady) {
      dshReady = false;
      log('⚠️ DSH 不可用（重启中？），QQ 消息将入队等待');
    }
  };
  function startDshWatch() {
    if (dshCheckStarted) return;
    dshCheckStarted = true;
    checkDsh();
    setInterval(checkDsh, 5000);
  }

  // ── SnowLuma 上游健康：**连上了 ≠ 收得到** ──────────────────────────────────
  //
  // 为什么必须有这一段（这是一个真实存在的、被误诊过的失败形态）：
  // SnowLuma 用原生组件（`native/snowluma-win32-x64.{dll,node}`）挂进 QQ 客户端进程
  // 才能拿到消息，它自己的日志里管这层叫 `[Hook]`。这层会退化：
  //     WARN [Hook] receive path stale: ... silentFor=136193ms; reporting good=false
  // 而 **SnowLuma 进程与它的 OneBot WebSocket 都还活着**。于是桥接这边一切正常：
  // WebSocket 是通的、`bot.on('open')` 打过「SnowLuma 已连接」，控制台没有任何异常，
  // 但群里一条消息都不来 —— 运维看到的现象是「接了但没反应」，而**没有任何证据指向
  // SnowLuma 的 hook**，于是被报成「桥接注入失败」。
  //
  // 桥接本身**不可能**造成这种失败：它没有任何原生/注入面（依赖全纯 JS，源码里
  // 没有 .dll/.node/FFI/进程注入），也不启动、不控制 SnowLuma 与 QQ。它能做、也应该做的
  // 是**把这个失败变得可诊断**。
  //
  // 信号从哪来（**两处都实测核对过 SnowLuma 1.14.9 的运行时源码，别凭直觉改**）：
  //
  //   ① **心跳载荷里的 `status.good`** —— 权威信号，且是免费的。
  //      SnowLuma 每 30s 由**自己的定时器无条件**发一个 heartbeat
  //      （`index.mjs` 的 `HEARTBEAT_INTERVAL = 3e4` / `startHeartbeat()`），
  //      载荷里带 `status: { online, good: online && bridge.receiveHealthy }`。
  //      `receiveHealthy` 是它**对「QQ → hook → 我」这条接收链路**的自评，
  //      静默约 105s 就翻 false。所以：读心跳里的 good 就等于拿到了 hook 的健康度。
  //      ⚠️ 注意它**不经过** QQ 事件流水线 —— 心跳是本地生成的，所以"没有事件包"
  //      **不能**用来判断 hook 死活（见下方 ② 的措辞）。
  //
  //   ② `get_status` 的 `good`/`online` —— 与 ① 同源，用于①长期收不到时的兜底轮询。
  //      ⚠️ **不要用 `get_login_info` 取 good**：它只返回 `{ user_id, nickname }`。
  //      取错字段不会报错（SDK 只校验 status/retcode 信封，不校验 data 载荷），
  //      good 会永远停在 null —— 本文件第一版就是这么写的，等于权威信号整条是死代码。
  //      `mcp/qq-actions.js` 的 snowluma_status 工具是对的取法（get_login_info
  //      拿昵称 + get_status 拿 online/good），可对照。
  //
  //   ③ `bot_status`（账号会话上下线）—— SnowLuma 1.14.17 起才有，老运行时永不触发，
  //      所以只是加分项，不能作为唯一依据。
  //
  //   ④ 「距最近一个事件包的时长」—— 只能证明**SnowLuma 进程与 WS 链路还活着**，
  //      **不能**证明 hook 收得到 QQ 数据（心跳会一直来）。所以它只作为兜底提示，
  //      阈值取很宽，措辞必须留余地。
  const SNOWLUMA_STATUS_POLL_MS = 60_000;
  const SNOWLUMA_SILENCE_WARN_MS = Math.max(60_000, Number(cfg.snowluma?.silenceWarnMs) || 10 * 60_000);
  const snowlumaHealth = {
    lastPacketAt: 0,      // 最近一个来自 SnowLuma 的事件包（含 meta/心跳）
    lastPacketKind: '',
    accountOnline: null,  // bot_status 的 online/offline（需要较新的 SnowLuma 运行时）
    good: null,           // 接收链路健康度：来自心跳 status.good / get_status.good
    goodSource: '',       // 'heartbeat' | 'get_status' —— 便于诊断"这条判断从哪来"
    goodError: '',
    goodCheckedAt: 0,
    degraded: false,      // 当前是否处于"已告警"状态（边沿触发，避免刷屏）
    reason: '',
  };

  /** 记录一次"上游还活着"的证据。任何来自 SnowLuma 的事件包都算（含心跳）。 */
  function noteUpstreamPacket(kind) {
    snowlumaHealth.lastPacketAt = Date.now();
    snowlumaHealth.lastPacketKind = String(kind ?? '');
  }

  /** 记下一次接收链路健康度。@param good - boolean；非布尔值忽略。 */
  function noteReceiveHealth(good, source) {
    if (typeof good !== 'boolean') return;
    snowlumaHealth.good = good;
    snowlumaHealth.goodSource = source;
    snowlumaHealth.goodError = '';
    snowlumaHealth.goodCheckedAt = Date.now();
  }

  /** 供 /api/status 与控制台使用的只读快照。 */
  function snowlumaHealthSnapshot() {
    const now = Date.now();
    const agoMs = snowlumaHealth.lastPacketAt ? now - snowlumaHealth.lastPacketAt : null;
    const silent = snowlumaHealth.lastPacketAt > 0 && agoMs > SNOWLUMA_SILENCE_WARN_MS;
    // 只有 SnowLuma **明确自报** good=false 才算"确认坏了"（接收链路）。
    // 「静默」只能说明连它的进程/WS 都没动静了 —— 那是**另一个**故障面，措辞必须分开。
    const confirmed = snowlumaHealth.good === false;
    let hint = null;
    if (confirmed) {
      hint = 'SnowLuma 自报接收链路异常（good=false）：它的 [Hook] 收不到 QQ 客户端的数据，'
        + '消息进不来。这不是桥接的问题。请查看 SnowLuma 的 logs/snowluma-*.log 里的 [Hook] 行'
        + '（receive path stale / process enumeration timed out），并考虑升级 SnowLuma。';
    } else if (silent) {
      hint = `已连接但 ${Math.round(agoMs / 60000)} 分钟没有收到任何事件包（连 30 秒一次的心跳都没有）。`
        + '这说明 SnowLuma 的 OneBot 服务/进程本身可能已经卡住或不在了，而不只是收不到 QQ 数据；'
        + '请直接查看 SnowLuma 的 logs/snowluma-*.log。';
    }
    return {
      // 只读 snowlumaHealth.connected（由 bot 的 open/close 维护），**不要**在这里引用
      // `bot`：它在本闭包里声明得晚得多（`const`，TDZ），一旦有人把本函数提前调用就会
      // 抛 "Cannot access 'bot' before initialization"。
      connected: snowlumaHealth.connected,
      accountOnline: snowlumaHealth.accountOnline,
      good: snowlumaHealth.good,
      goodSource: snowlumaHealth.goodSource || null,
      goodError: snowlumaHealth.goodError || null,
      lastPacketAgoMs: agoMs,
      lastPacketKind: snowlumaHealth.lastPacketKind || null,
      silent,
      degraded: confirmed || silent,
      hint,
    };
  }

  /** 边沿触发地告警/恢复，避免每轮探测都刷一行日志。 */
  function reportSnowlumaHealth() {
    const snap = snowlumaHealthSnapshot();
    if (snap.degraded && !snowlumaHealth.degraded) {
      snowlumaHealth.degraded = true;
      snowlumaHealth.reason = snap.hint ?? '';
      log(`⚠️ SnowLuma 上游不健康：${snap.hint}`);
      log('   这不是桥接的问题：桥接没有任何原生/注入面，也不控制 SnowLuma 或 QQ。');
      log('   排查：SnowLuma 的 logs/snowluma-*.log 里搜 [Hook]（看是否有 "receive path stale" 或 "process enumeration timed out"）。');
    } else if (!snap.degraded && snowlumaHealth.degraded) {
      snowlumaHealth.degraded = false;
      snowlumaHealth.reason = '';
      log('✅ SnowLuma 上游已恢复正常（good≠false 且事件包在流动）');
    }
  }

  /**
   * 问一次 SnowLuma 的 `get_status`：账号在不在线、它自评的接收链路是否健康。
   *
   * ⚠️ 必须用 `get_status` —— `get_login_info` 只返回 `{ user_id, nickname }`，
   *    从它身上取 good 会永远拿到 undefined（而且不会报错，见上方长注释）。
   *    这里只是**兜底轮询**：主路径是每 30 秒一次的心跳（免费，见 onEvent）。
   */
  async function pollSnowlumaStatus() {
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    try {
      const res = await fetch(`${httpUrl}/get_status`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}),
        },
        body: '{}',
        signal: AbortSignal.timeout(8000),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body.status !== 'ok') {
        snowlumaHealth.goodError = `HTTP ${res.status}${body?.wording ? ` ${body.wording}` : ''}`;
      } else {
        noteReceiveHealth(body.data?.good, 'get_status');
        if (typeof body.data?.online === 'boolean') snowlumaHealth.accountOnline = body.data.online;
      }
    } catch (error) {
      snowlumaHealth.goodError = error?.message ?? String(error);
    }
    snowlumaHealth.goodCheckedAt = Date.now();
    reportSnowlumaHealth();
  }

  function startSnowlumaWatch() {
    if (snowlumaWatchStarted) return;
    snowlumaWatchStarted = true;
    // 首次延后一点，避免与启动时的连接/自愈抢时序
    setTimeout(() => { void pollSnowlumaStatus(); }, 5000);
    setInterval(() => { void pollSnowlumaStatus(); }, SNOWLUMA_STATUS_POLL_MS);
    // 边沿告警的兜底心跳：主信号（心跳 status.good）到达时会立刻评估，这里只防"心跳也没了"
    setInterval(reportSnowlumaHealth, 30_000);
  }

  // ── 本地控制台（独立 Web 面板，不依赖 DSH WebUI） ───────────────────────────
  // 模式/角色/静默状态都存 state/*.json，桥接即时感知；此服务只读写这些文件。
  function simulationToolEnabled(flag) {
    return cfg.simulation?.tools?.[flag] !== false;
  }

  // ── 令牌 → 会话身份（控制台与 mux 审计共用，故放在 main 作用域） ────────────
  // 仿真会话级隔离：MCP 工具调用时若带 x-agent-token，则必须匹配该会话的 agentToken。
  // 控制台/管理端请求不带此头，仍走 consoleToken 管理通道。
  //
  // 定长比较：会话令牌同样是凭据，`===` 会在首个不同字符处短路，本机进程理论上
  // 可用响应时延逐字节试探。与控制台令牌（见下方 timingSafeEqual）保持一致。
  const tokenEq = authTokenEquals;
  const agentTokenOk = (key, token) => {
    const canonical = canonicalSimulationKey(key);
    const st = simulation.conversations.get(canonical ?? key);
    return !!st && !!st.agentToken && tokenEq(token, st.agentToken);
  };
  /**
   * 令牌是否匹配**任意**一个活跃仿真会话。
   *
   * 用途是集中式纵深防御（见下方 x-agent-call 关卡）：各端点自己那套
   * `if (x-agent-token && !agentTokenOk(key, token))` 把关的是「这个令牌能不能动这个
   * 会话」；这里把关的是「这到底是不是一次智能体调用」。两层都需要，因为前者在
   * 端点漏写时会整个失效。
   */
  const isLiveAgentToken = (token) => {
    if (typeof token !== 'string' || !token) return false;
    for (const st of simulation.conversations.values()) {
      if (st?.agentToken && tokenEq(token, st.agentToken)) return true;
    }
    return false;
  };
  const ownerChatKey = () => (cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '');
  // 主人私聊令牌可以跨会话发送/读取；普通群会话令牌仍只能动自己的会话。
  const ownerTokenOk = (token) => {
    const ownerKey = ownerChatKey();
    return Boolean(ownerKey && agentTokenOk(ownerKey, token));
  };
  /** 令牌绑定的会话 key（调用方身份）；不是活跃会话令牌则返回空串。 */
  const callerKeyOfToken = (token) => findCallerKey(
    token,
    [...simulation.conversations.entries()].map(([key, st]) => [key, st?.agentToken ?? '']),
    tokenEq
  );
  const controlTierCfg = () => normalizeControlTiers(cfg.simulation?.controlTiers);
  // 审计：跨会话放行单独记一条 grant，事后能回答「这次跨群是谁授权的」。
  function recordControlGrant({ route, targetKey, callerKey, grant }) {
    if (!grant || grant === 'self') return;
    try {
      appendToolLog({
        type: 'grant',
        time: new Date().toISOString(),
        route: String(route ?? ''),
        targetKey: String(targetKey ?? ''),
        callerKey: String(callerKey ?? ''),
        grant
      });
    } catch {}
  }
  /**
   * 统一判定「这个令牌能不能用 targetKey 这个会话做事」。
   *   ① 令牌属于目标会话 → self（行为不变）
   *   ② 令牌属于主人私聊 → owner-token（行为不变）
   *   ③ 跨会话低风险 且 该群最后一条非本人消息来自主人且在有效期内 → owner-directive
   * 高危动作不走这里（见 isHighRiskOwnerAction 的端点守卫）。
   */
  const canActOn = (targetKey, token, { crossSession = false, route = '' } = {}) => {
    const canonicalTarget = canonicalSimulationKey(targetKey) ?? String(targetKey ?? '');
    if (agentTokenOk(targetKey, token)) return { ok: true, grant: 'self', callerKey: canonicalTarget };
    if (ownerTokenOk(token)) return { ok: true, grant: 'owner-token', callerKey: ownerChatKey() };
    if (!crossSession) return { ok: false, status: 403, error: 'agent token 无效' };
    const tiers = controlTierCfg();
    const callerKey = callerKeyOfToken(token);
    const directiveFresh = callerKey && tiers.enabled ? ownerDirectiveFreshFor(callerKey, tiers) : false;
    const decision = decideCrossSessionAccess({ targetKey: canonicalTarget, callerKey, crossSession: true, enabled: tiers.enabled, directiveFresh });
    if (decision.ok) recordControlGrant({ route, targetKey: canonicalTarget, callerKey, grant: decision.grant });
    return decision.ok ? { ...decision, callerKey } : decision;
  };
  /** 「主人在这个群刚发过言」是否仍成立（群友插话即失效）。 */
  const ownerDirectiveFreshFor = (callerKey, tiers = controlTierCfg()) => {
    if (!tiers.enabled || !String(callerKey).startsWith('group:')) return false;
    try {
      const st = getSimulationState(callerKey);
      return isOwnerDirectiveFresh(st.recentMessages, cfg.ownerQQ, {
        now: Date.now(),
        windowMs: tiers.ownerDirectiveTtlMs
      });
    } catch {
      return false;
    }
  };
  /** 没有单一目标 key 的跨会话读取（目标列表）：主人令牌或群内主人指令均放行。 */
  const canReadAcrossSessions = (token, { route = '' } = {}) => {
    if (ownerTokenOk(token)) return { ok: true, grant: 'owner-token', callerKey: ownerChatKey() };
    const callerKey = callerKeyOfToken(token);
    if (!callerKey || !ownerDirectiveFreshFor(callerKey)) {
      return { ok: false, status: 403, error: '只有主人私聊会话或刚下过指令的主人群可以查看其他会话' };
    }
    recordControlGrant({ route, targetKey: '*', callerKey, grant: 'owner-directive' });
    return { ok: true, grant: 'owner-directive', callerKey };
  };

  // ── 高危动作：主人私聊确认事务 ────────────────────────────────────────────
  // 模型先发起 → 桥接生成 6 位码并发给主人 → 主人 /确认 <code> → 桥接自己回放执行。
  // 模型拿到的 confirmCode 只有在该条已被主人批准后才可用，所以模型无法自我确认。
  let consoleBoundPort = 0; // listen 之后才有值；/确认 回放要用实际端口
  let pendingActionsCache = null;
  const pendingActionsFile = () => path.join(STATE_DIR, 'pending-actions.json');
  function pendingActionsNow() {
    if (!pendingActionsCache) {
      pendingActionsCache = prunePendingActions(pendingActionsLoad(pendingActionsFile(), coreReadJsonSafe), Date.now());
    }
    return pendingActionsCache;
  }
  function persistPendingActions() {
    try {
      pendingActionsSave(pendingActionsFile(), pendingActionsNow(), coreAtomicWriteJson);
    } catch (error) {
      log(`待确认动作写盘失败：${error?.message ?? error}`);
    }
  }
  function markPendingAction(pending, status) {
    if (!pending) return;
    pending.status = status;
    pending.updatedAt = Date.now();
    persistPendingActions();
  }
  const pendingReasonText = {
    'not-found': '没有找到这个确认码',
    used: '该确认码已使用',
    expired: '确认码已过期',
    'route-mismatch': '确认码与当前动作类型不匹配',
    'args-mismatch': '确认码与当前参数不匹配',
    'not-approved': '确认码尚未得到主人确认'
  };
  /** 本机回环 POST（不用 fetch：测试夹具会把 fetch 换成假网关）。 */
  function httpPostJsonLocal(port, pathname, payload, headers = {}, timeoutMs = 15 * 60 * 1000) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (result) => { if (!settled) { settled = true; resolve(result); } };
      const data = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
      const req = http.request({
        host: '127.0.0.1',
        port,
        path: pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': data.length,
          host: `127.0.0.1:${port}`,
          ...headers
        }
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const textBody = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(textBody); } catch {}
          done({ status: res.statusCode ?? 0, ok: (res.statusCode ?? 0) >= 200 && (res.statusCode ?? 0) < 300, json, text: textBody });
        });
      });
      req.on('error', (error) => done({ status: 0, ok: false, error: error?.message ?? String(error) }));
      req.setTimeout(timeoutMs, () => { req.destroy(new Error('确认回放超时')); });
      req.end(data);
    });
  }
  /**
   * C 类端点的高危守卫。
   * 返回 { ok:true, grant? } 表示继续；否则 { ok:false, status, error, payload? }。
   */
  async function ownerHighRiskGuard(route, body, req) {
    const tiers = controlTierCfg();
    if (!tiers.enabled || !tiers.requireConfirmForHighRisk) return { ok: true };
    if (!isHighRiskOwnerAction(route, body)) return { ok: true };
    const now = Date.now();
    const argsHash = hashActionArgs(body);
    const replayId = String(req.headers['x-owner-confirm-id'] ?? '').trim();
    if (replayId) {
      const rec = pendingActionsNow().find((p) => p && p.id === replayId);
      const usable = pendingActionUsable(rec, { route, argsHash, now, requireApproved: true });
      if (!usable.ok) return { ok: false, status: 403, error: `确认已失效（${pendingReasonText[usable.reason] ?? usable.reason}），请重新发起` };
      markPendingAction(rec, 'used');
      return { ok: true, grant: 'owner-confirm', pendingId: rec.id };
    }
    const code = String(body.confirmCode ?? '').trim();
    if (code) {
      const rec = findPendingByCode(pendingActionsNow(), code);
      const usable = pendingActionUsable(rec, { route, argsHash, now, requireApproved: true });
      if (!usable.ok) return { ok: false, status: 403, error: `确认码不可用：${pendingReasonText[usable.reason] ?? usable.reason}` };
      markPendingAction(rec, 'used');
      return { ok: true, grant: 'owner-confirm', pendingId: rec.id };
    }
    const pending = createPendingAction({
      route,
      body,
      summary: describePendingAction(route, body),
      now,
      ttlMs: PENDING_ACTION_TTL_MS
    });
    pendingActionsNow().push(pending);
    persistPendingActions();
    const ownerKey = ownerChatKey();
    if (ownerKey) {
      try {
        await sendToQQ(ownerKey, `【待确认】${pending.summary}\n回复 /确认 ${pending.code} 生效（10 分钟）`);
      } catch (error) {
        log(`待确认提醒发送失败：${error?.message ?? error}`);
      }
    }
    recordControlGrant({ route, targetKey: ownerKey || '*', callerKey: callerKeyOfToken(String(body.token ?? req.headers['x-agent-token'] ?? '')), grant: 'confirm-requested' });
    return {
      ok: false,
      status: 403,
      error: '需要主人确认（已私聊发送确认码）',
      payload: { needsConfirm: true, actionId: pending.id, code: pending.code, expiresAt: pending.expiresAt, summary: pending.summary }
    };
  }
  const escalationNotifiedAt = new Map(); // key -> ts，防刷屏
  /** 群里发起高危动作：不在群里执行，提示回私聊；可选私聊提醒主人（限频 10 分钟/群）。 */
  function rejectHighRiskFromGroup(route, key, body, req) {
    const category = ownerActionCategory(route);
    const callerToken = String(body.token ?? req.headers['x-agent-token'] ?? '');
    const callerKey = callerKeyOfToken(callerToken);
    recordControlGrant({ route, targetKey: ownerChatKey() || '*', callerKey: callerKey || key, grant: 'high-risk-rejected' });
    if (controlTierCfg().groupEscalationNotify && cfg.ownerQQ) {
      const last = escalationNotifiedAt.get(key) || 0;
      if (Date.now() - last > 10 * 60 * 1000) {
        escalationNotifiedAt.set(key, Date.now());
        const who = callerKey || key;
        sendToQQ(ownerChatKey(), `群里有人让我做「${category}」（${who}），我没做；要办的话在私聊跟我说。`).catch((error) => {
          log(`高危升级提醒发送失败：${error?.message ?? error}`);
        });
      }
    }
    return { ok: false, status: 403, error: `需要在私聊里跟主人确认：这件事属于${category}，请到私聊发起。`, payload: { needsOwnerPrivate: true } };
  }
  /** 主人回复 /确认 <code>：执行对应待确认动作并把结果回报给主人。 */
  async function confirmPendingActionByCode(code, key) {
    const rec = findPendingByCode(pendingActionsNow(), code);
    if (!rec) return { ok: false, error: '没有找到这个确认码（可能已使用或过期）' };
    if (!(Number(rec.expiresAt) > Date.now())) return { ok: false, error: '确认码已过期，请重新发起' };
    if (rec.status !== 'pending') return { ok: false, error: '确认码已处理过' };
    markPendingAction(rec, 'approved');
    const port = consoleBoundPort;
    if (!port) return { ok: false, error: '控制台尚未就绪，稍后再试' };
    const result = await httpPostJsonLocal(port, rec.route, rec.body, {
      'x-owner-confirm-id': rec.id,
      ...(cfg.consoleToken ? { 'x-console-token': String(cfg.consoleToken) } : {})
    });
    markPendingAction(rec, 'used');
    if (!result.ok) {
      return { ok: false, summary: rec.summary, error: `执行失败：${result.json?.error ?? result.error ?? `HTTP ${result.status}`}` };
    }
    return { ok: true, summary: rec.summary, result: result.json };
  }

  function startConsoleServer() {
    const port = cfg.consolePort ?? 3100;
    // 控制台鉴权：优先用 config.consoleToken，未配置则自动生成并持久化，不再默认无鉴权。
    // 使用 let 以便控制台内手动修改令牌后热更新。
    const configuredToken = String(cfg.consoleToken ?? '').trim();
    const tokenValid = validConsoleTokenShape(configuredToken);
    let consoleToken = tokenValid ? configuredToken : loadOrCreateConsoleToken();
    // 控制台鉴权默认关闭：只要仍只监听回环，Host 校验与 CSRF 防护还在；
    // 打开 consoleAuth.enabled 后恢复令牌校验。令牌本身仍会生成，
    // 供 MCP 工具进程在需要时携带（与是否要求浏览器输入无关）。
    // 局域网访问是硬例外：一旦监听 0.0.0.0，同一网络里任何设备都能碰到数据接口，
    // 即使 consoleAuth.enabled=false 也强制令牌鉴权——LAN 暴露绝不匿名可读。
    const consoleLanAccess = cfg.consoleLanAccess === true;
    const authRequired = cfg.consoleAuth?.enabled !== false || consoleLanAccess;
    // 本机真实网卡 IP:port 名单（仅局域网开启时非空），listen 之后按实际绑定端口生成。
    let lanHosts = [];
    // 令牌必须非空才继续。下面鉴权处原来的写法是「令牌为空 ⇒ return true（放行）」，
    // 注释写着"启动时已自动生成并持久化"—— 等于承认那一行不可达，可它是一条**失败开放**的分支：
    // 一旦真的空了（写盘异常被吞、以后新增"关闭鉴权"之类的配置），控制台上那些
    // 改配置 / 发消息 / 读聊天记录的接口会变成完全免鉴权，而 Host 白名单只挡跨机访问、
    // 挡不住本机进程。这里改成失败关闭：宁可启动时报错，也不要静默开着一个无鉴权的管理 API。
    if (!consoleToken) throw new Error('控制台令牌为空：拒绝以无鉴权方式启动控制台 API');
    if (!tokenValid && configuredToken) log(`控制台 config.consoleToken 长度/字符不合法，已忽略并回退到自动生成令牌`);
    if (!configuredToken) log('控制台未配置 consoleToken，使用 state/console-token 中的持久化令牌');
    if (!authRequired) log('控制台鉴权已关闭（仅本机回环，Host/CSRF 防护仍生效）；如需恢复请设置 config.consoleAuth.enabled=true');
    if (consoleLanAccess && cfg.consoleAuth?.enabled === false) log('局域网访问已开启：即使 consoleAuth.enabled=false，控制台也强制要求访问令牌');
    // 运行时以实际生效的令牌为准（schema/控制台只显示「已配置」，不会回传明文）。
    cfg.consoleToken = consoleToken;
    // 仿真会话工具必须仍命中当前模式的白名单/准入；避免白名单移除后旧 agentToken 继续读状态。
    const simulationSessionAllowed = isSessionAllowedInCurrentMode;
    const server = http.createServer(async (req, res) => {
      let url;
      try { url = new URL(req.url ?? '/', `http://127.0.0.1:${port}`); }
      catch {
        res.writeHead(400, { 'content-type': 'application/json; charset=utf-8', 'Connection': 'close' });
        res.end(JSON.stringify({ ok: false, error: '无效的请求地址' }));
        return;
      }
      const SECURITY_HEADERS = CONSOLE_SECURITY_HEADERS;
      const sendJson = (obj, status = 200) => {
        res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
        res.end(JSON.stringify(obj, null, 2));
      };
      const readBody = () => new Promise((resolve, reject) => {
        const MAX_BODY_BYTES = 1_000_000;
        const chunks = [];
        let total = 0;
        let settled = false;
        let bodyTimer = null;
        const fail = (status, message) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          const err = new Error(message);
          err.statusCode = status;
          reject(err);
        };
        const done = (val) => {
          if (settled) return;
          settled = true;
          if (bodyTimer) clearTimeout(bodyTimer);
          resolve(val);
        };
        // 提前按 Content-Length 拒绝超限请求体
        const declared = Number(req.headers['content-length']);
        if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
          fail(413, '请求体过大（超过 1MB）');
          return;
        }
        bodyTimer = setTimeout(() => fail(400, '请求体读取超时'), 30000);
        req.on('data', (c) => {
          if (settled) return;
          const buf = Buffer.isBuffer(c) ? c : Buffer.from(c);
          total += buf.length;
          if (total > MAX_BODY_BYTES) {
            req.pause();
            fail(413, '请求体过大（超过 1MB）');
            return;
          }
          chunks.push(buf);
        });
        req.on('end', () => {
          if (settled) return;
          const data = Buffer.concat(chunks).toString('utf8');
          if (!data.trim()) { done({}); return; }
          let parsed;
          try { parsed = JSON.parse(data); } catch { fail(400, '请求体必须是合法 JSON'); return; }
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            fail(400, '请求体必须是 JSON 对象');
            return;
          }
          done(parsed);
        });
        // 请求体超限/连接异常时也要结束等待，避免 handler 悬挂
        req.on('error', () => fail(400, '请求体读取失败'));
        req.on('aborted', () => fail(400, '请求体读取中断'));
      });
      // 浏览器会自动请求 /favicon.ico，且**不带控制台令牌**。若让它落到下面的鉴权分支，
      // 每次打开控制台都会在 DevTools 里留一条 401 噪音（离线预览 fixture 早已用 204 处理，
      // 真实服务端此前与自己的 fixture 行为不一致）。这里在任何鉴权之前直接 204 收掉。
      if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/apple-touch-icon.png')) {
        res.writeHead(204, SECURITY_HEADERS);
        res.end();
        return;
      }
      // Host 头校验（DNS rebinding 硬化）：控制台默认只监听 127.0.0.1，因此合法请求的 Host
      // 只可能是 127.0.0.1 / localhost / [::1] 加本端口；consoleLanAccess 开启时额外放行
      // 本机真实网卡 IP:port（lanHosts），但一切域名仍然拒绝。攻击者用一个 TTL=0 的域名解析到
      // 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源，Origin 校验随之失效；卡住 Host
      // 这一层后，这类请求在进入任何业务分支之前就被拒掉。
      // 反代/端口转发场景会被一并拒绝——这是有意的（要远程访问请用 SSH 隧道并自行承担）。
      // 用**实际绑定端口**而不是配置值：测试夹具用 consolePort: 0 让系统分配端口，
      // 配置里那个 0 不是请求里的 Host 端口。请求必然发生在 listen 之后，所以这里拿得到。
      const boundPort = server.address()?.port ?? port;
      // Host → 控制台令牌 → 智能体调用隔离 → CSRF 四道闸门统一在 console/auth.js。
      // 判定顺序、状态码和错误文案都是权限边界，改动必须同步那边的单测。
      const gate = evaluateConsoleGate({
        method: req.method,
        headers: req.headers,
        pathname: url.pathname,
        searchParams: url.searchParams,
        boundPort,
        consoleToken,
        authRequired,
        isLiveAgentToken,
        lanHosts
      });
      if (gate.action === 'respond') {
        if (gate.html) {
          res.writeHead(gate.status, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          res.end(gate.html);
          return;
        }
        sendJson(gate.json, gate.status);
        return;
      }
      try {
        // 令牌之后的权限闸门（暂停/关闭/模式/仅控制台/只读降级），名单与顺序见
        // console/policy.js —— 新增端点时先在那里登记，再决定它属于哪一面。
        const access = evaluateAgentAccess({
          method: req.method,
          headers: req.headers,
          pathname: url.pathname,
          simulationPaused: simulation.paused === true,
          simulationEnabled: cfg.simulation?.enabled !== false,
          mode: currentMode,
          slangStoreWritable,
          stickerStoreWritable
        });
        if (access.action === 'respond') {
          sendJson(access.json, access.status);
          return;
        }
        // ── 实时状态页（只读）：/live + SSE ───────────────────────────────
        if (handleLiveRequest({ req, res, url, root: ROOT, headers: SECURITY_HEADERS, snapshot: buildLiveSnapshot, sendJson })) return;
        if (req.method === 'GET' && url.pathname === '/') {
          res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...SECURITY_HEADERS });
          try {
            res.end(fs.readFileSync(path.join(ROOT, 'public', 'console.html'), 'utf8'));
          } catch {
            res.end('控制台页面缺失：web/deck.html');
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/status') {
          const rs = readRoleState();
          // 带 agent token 的调用来自 QQ 群里的 AI：只能拿到它自己该知道的运行状态。
          // activity 是**全局**收发摘要（含其它群的发言片段与告警），ownerQQ/白名单属于管理信息，
          // 都不能给到会话级主体，否则 A 群的 AI 能读到 B 群的内容。
          // 判定「是不是智能体调用」必须同时看 x-agent-call：无令牌的智能体调用
          // （旧只读工具的模式探测）不带 x-agent-token，但它同样**绝不能**拿到管理端字段
          // —— ownerQQ / 白名单 / activity（含其它群的发言片段）是跨群管理信息。
          // 只认 token 会让这类请求落到下面的完整对象上，等于把 A 群的 AI 变成管理端。
          if (req.headers['x-agent-token'] || req.headers['x-agent-call'] !== undefined) {
            sendJson({
              mode: currentMode,
              role: rs.role ?? null,
              roleMode: rs.mode ?? 'active',
              dshReady,
              simulationPaused: simulation.paused,
            });
            return;
          }
          sendJson({
            mode: currentMode,
            closedAgentPreset,
            role: rs.role ?? null,
            roleMode: rs.mode ?? 'active',
            dshReady,
            ownerQQ: cfg.ownerQQ ?? null,
            allowGroups: cfg.allow?.groups ?? [],
            allowPrivate: cfg.allow?.private ?? [],
            simulationPaused: simulation.paused,
            consoleAuthEnabled: cfg.consoleAuth?.enabled !== false,
            // 上游健康只给操作者看：它包含网关诊断信息（good/hint），
            // 属于管理侧观测，不该进 QQ 会话里那个受限的智能体视图。
            snowluma: snowlumaHealthSnapshot(),
            activity: readActivityTail(100)
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/features') {
          sendJson(buildFeatureOverview());
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/features/control') {
          sendJson({ ok: true, ...buildFeatureControlSnapshot() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/features/control') {
          const body = await readBody();
          const id = String(body.id ?? '').trim();
          const card = cardFor(id);
          if (!card) { sendJson({ ok: false, error: `未知功能模块：${id}` }, 400); return; }
          if (typeof body.enabled !== 'boolean') { sendJson({ ok: false, error: 'enabled 必须是布尔值' }, 400); return; }
          const switchKey = cardSwitchKey(card);
          const patch = { [switchKey]: cardSwitchValue(card, body.enabled) };
          if (body.enabled) {
            Object.assign(patch, featureEnablePatch(card));
            // 旧版 features.disabled 是加载器级黑名单；打开主开关时把它清掉，
            // 否则同一次操作里总开关是 true、模块却被旧字段挡住。
            if (switchKey.startsWith('features.')) {
              const disabled = Array.isArray(cfg.features?.disabled) ? cfg.features.disabled : [];
              if (disabled.includes(id)) patch['features.disabled'] = disabled.filter((item) => item !== id);
            }
          }
          const applied = applyConsoleConfigValues(patch, { tag: 'features' });
          if (!applied.ok) {
            sendJson({ ok: false, errors: applied.errors || [], error: applied.error || '保存失败' }, applied.errors ? 400 : 500);
            return;
          }
          log(`控制台：功能「${card.label}」已${body.enabled ? '开启' : '关闭'}`);
          sendJson({
            ok: true,
            id,
            enabled: body.enabled,
            applied: applied.applied,
            requiresRestart: applied.requiresRestart,
            note: applied.requiresRestart.length ? '标注为 bridge/dsh 的项需重启对应进程后生效' : '已热更新'
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/features/advanced') {
          const body = await readBody();
          const card = cardFor(String(body.id ?? '').trim());
          if (!card) { sendJson({ ok: false, error: '未知功能模块' }, 400); return; }
          const fields = Array.isArray(card.advanced) ? card.advanced : [];
          if (!fields.length) { sendJson({ ok: false, error: '这个模块没有可编辑的通用高级设置' }, 400); return; }
          const incoming = body.values && typeof body.values === 'object' && !Array.isArray(body.values) ? body.values : {};
          const values = {};
          const errors = [];
          for (const [key, input] of Object.entries(incoming)) {
            const field = fields.find((item) => item.key === key);
            if (!field) { errors.push(`未知高级设置：${key}`); continue; }
            const converted = configValueFor(field, input);
            if (converted === null) { errors.push(`${field.label || key} 的值不合法`); continue; }
            values[key] = converted;
          }
          if (errors.length) { sendJson({ ok: false, errors, error: errors[0] }, 400); return; }
          const applied = applyConsoleConfigValues(values, { tag: 'features' });
          if (!applied.ok) {
            sendJson({ ok: false, errors: applied.errors || [], error: applied.error || '保存失败' }, applied.errors ? 400 : 500);
            return;
          }
          log(`控制台：功能「${card.label}」高级设置已更新 ${applied.applied.length} 项`);
          sendJson({ ok: true, id: card.id, applied: applied.applied, requiresRestart: applied.requiresRestart });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/features/reset-advanced') {
          const body = await readBody();
          const card = cardFor(String(body.id ?? '').trim());
          if (!card) { sendJson({ ok: false, error: '未知功能模块' }, 400); return; }
          const example = readConfigObject(path.join(ROOT, 'config.example.json'));
          const values = {};
          for (const key of cardDefaultKeys(card.id)) {
            const value = valueAtPath(example, key, undefined);
            if (value !== undefined) values[key] = value;
          }
          if (!Object.keys(values).length) { sendJson({ ok: false, error: '这个模块没有可恢复的默认项' }, 400); return; }
          const applied = applyConsoleConfigValues(values, { tag: 'features' });
          if (!applied.ok) {
            sendJson({ ok: false, errors: applied.errors || [], error: applied.error || '恢复失败' }, applied.errors ? 400 : 500);
            return;
          }
          log(`控制台：功能「${card.label}」高级设置已恢复默认 ${applied.applied.length} 项`);
          sendJson({ ok: true, id: card.id, applied: applied.applied, requiresRestart: applied.requiresRestart });
          return;
        }

        // ── 配置 schema：控制台表单 / deploy CLI / doctor 的单一事实源 ──────────
        if (req.method === 'GET' && url.pathname === '/api/config/schema') {
          const file = readConfigObject(path.join(ROOT, 'config.json'));
          const migrated = migrateConfigObject(file);
          const schema = buildConfigSchema(cfg);
          sendJson({
            ok: true,
            ...schema,
            configVersion: CONFIG_VERSION,
            fileVersion: Number(file.configVersion) || 1,
            migrationNotes: migrated.notes,
            validationErrors: cfg.configValidation?.errors ?? []
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/config/validate') {
          const body = await readBody();
          const result = validateConfigPatch(cfg, body.patch ?? body);
          sendJson({ ok: result.ok, errors: result.errors, values: result.values }, result.ok ? 200 : 400);
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/config/apply') {
          const body = await readBody();
          const patch = body.patch ?? body;
          const result = validateConfigPatch(cfg, patch);
          if (!result.ok) {
            sendJson({ ok: false, errors: result.errors }, 400);
            return;
          }
          // 落盘 + 热更新 + 重排定时任务，统一走与控制台功能开关相同的入口。
          const applied = applyConsoleConfigValues(result.values, { tag: 'console' });
          if (!applied.ok) {
            sendJson({ ok: false, errors: applied.errors || [], error: applied.error || '保存失败' }, applied.errors ? 400 : 500);
            return;
          }
          const { requiresRestart } = applied;
          log(`控制台：配置已更新 ${applied.applied.length} 项${requiresRestart.length ? `（${requiresRestart.length} 项需重启）` : ''}`);
          sendJson({
            ok: true,
            applied: Object.keys(result.values),
            requiresRestart,
            note: requiresRestart.length ? '标注为 bridge/dsh 的项需重启对应进程后生效' : '已热更新'
          });
          return;
        }

        // ── 可靠性面板：outbox / jobs / inbox 状态与人工干预 ───────────────────
        const publicOutbox = (row) => row && ({
          id: row.id, key: row.key, kind: row.kind, state: row.state,
          attempts: row.attempts, maxAttempts: row.maxAttempts, nextAttemptAt: row.nextAttemptAt,
          lastError: row.lastError, createdAt: row.createdAt, sentAt: row.sentAt
        });
        const publicJob = (job) => job && ({
          id: job.id, type: job.type, key: job.key, state: job.state,
          attempts: job.attempts, maxAttempts: job.maxAttempts,
          runAfter: job.runAfter, lastError: job.lastError, createdAt: job.createdAt
        });
        if (req.method === 'GET' && url.pathname === '/api/transport') {
          sendJson({ ok: true, ...transport.describe() });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/content') {
          sendJson({ ok: true, ...buildContentSnapshot() });
          return;
        }
        // ── 出门见闻：控制台专用（见闻列表不含网址/原文，只有标题与摘要） ─────
        if (req.method === 'GET' && url.pathname === '/api/outer-world/status') {
          sendJson({ ok: true, ...outerWorldStatus() });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/outer-world/notes') {
          const limit = Math.max(1, Math.min(20, Number(url.searchParams.get('limit')) || 5));
          sendJson({ ok: true, enabled: outerWorldEnabled(), notes: outerWorldStore.notes.list({ limit }) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/outer-world/run') {
          outerWorldStore.circuit.reset();
          const result = await runOuterWorld('api');
          sendJson({ ok: result.ok === true, enabled: result.enabled !== false, ...result });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/outer-world/stop') {
          sendJson({ ok: true, enabled: outerWorldEnabled(), ...stopOuterWorld('api') });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/esports/refresh') {
          if (!shareEngineEnabled(cfg)) {
            sendJson({ ok: false, disabled: true, reason: 'features.shareModule=false', error: '分享引擎总闸已关闭' }, 403);
            return;
          }
          if (!featureEnabled(cfg, 'esportsFeed')) {
            sendJson({ ok: false, disabled: true, reason: 'features.esportsFeed=false', error: '赛事资讯总开关已关闭' }, 403);
            return;
          }
          void refreshEsportsFeed().catch((error) => log(`[esports] 手动刷新失败：${error?.message ?? error}`));
          sendJson({ ok: true, started: true, loading: esportsFeedLoading === true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/search/test') {
          const body = await readBody();
          const query = String(body.query ?? '').trim().slice(0, 200);
          if (!query) { sendJson({ ok: false, error: 'query 不能为空' }, 400); return; }
          try {
            const result = await webSearch(query, { root: ROOT, config: { maxResults: Number(cfg.webSearch?.maxResults) || 8 } });
            sendJson({
              ok: true,
              query,
              provider: result.provider,
              fallbackFrom: result.fallbackFrom || '',
              note: result.note || '',
              results: (result.results || []).slice(0, 8).map((item) => ({
                title: String(item.title || '').slice(0, 200),
                url: String(item.url || ''),
                snippet: String(item.snippet || item.summary || '').slice(0, 300)
              }))
            });
          } catch (error) {
            log(`[search] 控制台测试搜索失败：${error?.message ?? error}`);
            sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/memory/facts') {
          if (!memoryStore) { sendJson({ ok: false, error: '长期记忆未启用' }, 503); return; }
          const scope = String(url.searchParams.get('scope') ?? '').trim();
          const source = String(url.searchParams.get('source') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim().toLowerCase();
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          const facts = memoryStore.list({ scope, source, limit: 1000 })
            .filter((fact) => !query || `${fact.topic} ${fact.fact} ${fact.scope} ${fact.source}`.toLowerCase().includes(query))
            .slice(0, limit)
            .map((fact) => ({
              id: fact.id,
              scope: fact.scope,
              ownerKey: fact.ownerKey || '',
              source: fact.source || '',
              topic: fact.topic || '',
              fact: fact.fact,
              weight: fact.weight,
              confidence: fact.confidence,
              lastSeenAt: fact.lastSeenAt,
              expiresAt: fact.expiresAt
            }));
          sendJson({ ok: true, facts, total: facts.length, stats: memoryStore.stats() });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/memory/personal') {
          if (!memoryStore) { sendJson({ ok: false, error: '长期记忆未启用' }, 503); return; }
          const query = String(url.searchParams.get('query') ?? '').trim().toLowerCase();
          const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          const facts = listPersonalFacts(1000)
            .filter((fact) => !query || `${fact.topic} ${fact.fact}`.toLowerCase().includes(query))
            .slice(0, limit)
            .map((fact) => ({
              id: fact.id,
              topic: fact.topic || '',
              fact: fact.fact,
              weight: fact.weight,
              confidence: fact.confidence,
              lastSeenAt: fact.lastSeenAt
            }));
          sendJson({ ok: true, facts, total: facts.length, stats: memoryStore.stats() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/memory/personal') {
          if (!memoryStore) { sendJson({ ok: false, error: '长期记忆未启用' }, 503); return; }
          const body = await readBody();
          const fact = String(body.fact ?? '').trim();
          const topic = String(body.topic ?? '').trim().slice(0, 60);
          if (!fact) { sendJson({ ok: false, error: 'fact 不能为空' }, 400); return; }
          memoryStore.remember({
            scope: 'global',
            ownerKey: null,
            topic: topic || '手动记录',
            fact: fact.slice(0, 500),
            source: PERSONAL_MEMORY_SOURCE,
            confidence: 0.9
          });
          sendJson({ ok: true, facts: listPersonalFacts(50) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/memory/personal/delete') {
          if (!memoryStore) { sendJson({ ok: false, error: '长期记忆未启用' }, 503); return; }
          const body = await readBody();
          const id = Number(body.id);
          if (!Number.isFinite(id)) { sendJson({ ok: false, error: 'id 无效' }, 400); return; }
          sendJson({ ok: true, removed: memoryStore.forget(id), facts: listPersonalFacts(50) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/memory/personal/clear') {
          if (!memoryStore) { sendJson({ ok: false, error: '长期记忆未启用' }, 503); return; }
          const facts = listPersonalFacts(1000);
          for (const fact of facts) memoryStore.forget(fact.id);
          sendJson({ ok: true, cleared: facts.length, facts: [] });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/budget') {
          if (!budgetStore) { sendJson({ ok: false, error: '预算账本未启用' }, 503); return; }
          const keyParam = canonicalSimulationKey(String(url.searchParams.get('key') ?? '').trim());
          const budget = cfg.simulation?.budget ?? {};
          sendJson({
            ok: true,
            enabled: budget.enabled === true,
            day: shanghaiDayKey(),
            limits: { dailyTokensPerKey: budget.dailyTokensPerKey, dailyTokensGlobal: budget.dailyTokensGlobal },
            global: budgetStore.dayUsage(),
            ...(keyParam ? { key: keyParam, keyUsage: budgetStore.dayUsage({ key: keyParam }) } : {}),
            recent: budgetStore.recent({ limit: 20 })
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/reliability') {
          let schemaVersion = null;
          try { schemaVersion = db?.get('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? null; } catch {}
          sendJson({
            ok: true,
            storage: {
              enabled: STORAGE.enabled !== false,
              ready: storageReady,
              dbPath: STORAGE.dbPath ?? null,
              schemaVersion,
              errors: storageErrors
            },
            outbox: outbox?.stats() ?? { enabled: false },
            jobs: jobQueue?.stats() ?? { enabled: false },
            inbox: inbox?.stats() ?? { enabled: false },
            relationships: relationshipStore?.stats() ?? { enabled: false },
            features: featureHost?.stats() ?? { enabled: false },
            budget: budgetStore?.stats() ?? { enabled: false },
            recentOutbox: (outbox?.list({ limit: 20 }) ?? []).map(publicOutbox),
            recentJobs: (jobQueue?.list({ limit: 20 }) ?? []).map(publicJob)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/reliability/outbox/retry') {
          const body = await readBody();
          if (!outbox) { sendJson({ ok: false, error: '出站队列未启用' }, 503); return; }
          const ok = outbox.retry(body.id);
          if (ok) void outbox.drain(5);
          sendJson({ ok, id: body.id });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/reliability/outbox/discard') {
          const body = await readBody();
          if (!outbox) { sendJson({ ok: false, error: '出站队列未启用' }, 503); return; }
          sendJson({ ok: outbox.discard(body.id, body.note || '控制台人工丢弃'), id: body.id });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/reliability/jobs/retry') {
          const body = await readBody();
          if (!jobQueue) { sendJson({ ok: false, error: '任务队列未启用' }, 503); return; }
          sendJson({ ok: jobQueue.retry(body.id), id: body.id });
          return;
        }

        // ── 群友关系（内部数值，控制台可读可改） ─────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/relationships/summary') {
          if (!relationshipStore) { sendJson({ ok: false, error: '关系模型未启用' }, 503); return; }
          const groups = (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : []).map((gid) => {
            const key = `group:${gid}`;
            const profile = cfg.simulation?.groupProfiles?.[key];
            const rows = relationshipStore.list(key, { limit: 200 });
            const family = /家人|家庭|family/i.test(String(profile?.label || ''));
            return {
              key,
              name: liveGroupNames.get(String(gid)) || String(profile?.label || '').trim() || '群聊',
              label: String(profile?.label || ''),
              family,
              enabled: relationshipsEnabledForKey(key),
              members: rows.length,
              top: rows[0] ? { name: rows[0].displayName, stageLabel: relationshipStageLabel(rows[0].stage), bond: Math.round(rows[0].bond * 10) / 10 } : null
            };
          });
          sendJson({ ok: true, groups });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/relationships') {
          if (!relationshipStore) { sendJson({ ok: false, error: '关系模型未启用' }, 503); return; }
          const key = canonicalSimulationKey(String(url.searchParams.get('key') ?? '').trim());
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const rows = relationshipStore.list(key, { limit: 100 }).map((r) => ({
            ...r,
            stageLabel: relationshipStageLabel(r.stage),
            axesWords: relationshipAxisWords(r),
            sparkline: relationshipStore.sparkline(key, r.userId, { days: 7 })
          }));
          sendJson({
            ok: true,
            key,
            enabled: relationshipsEnabledForKey(key),
            rows,
            owner: buildOwnerRelationshipSnapshot(),
            context: relationshipStore.contextBlock(key, { limit: 6 })
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/relationships/timeline') {
          if (!relationshipStore) { sendJson({ ok: false, error: '关系模型未启用' }, 503); return; }
          const key = canonicalSimulationKey(String(url.searchParams.get('key') ?? '').trim());
          const userId = String(url.searchParams.get('userId') ?? '').trim();
          if (!key || !/^\d+$/.test(userId)) { sendJson({ ok: false, error: 'key/userId 不合法' }, 400); return; }
          sendJson({ ok: true, key, userId, events: relationshipStore.timeline(key, userId, { limit: 50 }) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/relationships/set') {
          if (!relationshipStore) { sendJson({ ok: false, error: '关系模型未启用' }, 503); return; }
          const body = await readBody();
          try {
            const row = relationshipStore.set(body.key, body.userId, {
              affection: body.affection,
              trust: body.trust,
              familiarity: body.familiarity,
              rapport: body.rapport,
              note: body.note,
              reason: body.reason,
              actor: 'console'
            });
            sendJson({ ok: true, row });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/relationships/delete') {
          if (!relationshipStore) { sendJson({ ok: false, error: '关系模型未启用' }, 503); return; }
          const body = await readBody();
          sendJson({ ok: relationshipStore.delete(body.key, body.userId) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/relationships/reset') {
          if (!relationshipStore) { sendJson({ ok: false, error: '关系模型未启用' }, 503); return; }
          const body = await readBody();
          sendJson({ ok: relationshipStore.reset(body.key, body.userId) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/relationships/group-toggle') {
          const body = await readBody();
          const key = canonicalSimulationKey(String(body.key ?? '').trim());
          if (!key || !key.startsWith('group:')) { sendJson({ ok: false, error: 'key 必须是 group:群号' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          try {
            const file = readConfigObject(configFile);
            file.simulation = file.simulation && typeof file.simulation === 'object' ? file.simulation : {};
            file.simulation.groupProfiles = file.simulation.groupProfiles && typeof file.simulation.groupProfiles === 'object'
              ? file.simulation.groupProfiles : {};
            const profile = file.simulation.groupProfiles[key] && typeof file.simulation.groupProfiles[key] === 'object'
              ? file.simulation.groupProfiles[key] : {};
            file.simulation.groupProfiles[key] = { ...profile, relationships: body.enabled === true };
            writeConfigFile(file);
            cfg.simulation.groupProfiles = cfg.simulation.groupProfiles && typeof cfg.simulation.groupProfiles === 'object'
              ? cfg.simulation.groupProfiles : {};
            cfg.simulation.groupProfiles[key] = { ...(cfg.simulation.groupProfiles[key] ?? {}), relationships: body.enabled === true };
            log(`控制台：群 ${key} 的关系模型已${body.enabled === true ? '开启' : '关闭'}`);
            sendJson({ ok: true, key, enabled: body.enabled === true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 个性签名（自动/手动更新 QQ personal_note） ─────────────────────
        if (req.method === 'GET' && url.pathname === '/api/mood/history') {
          const days = Math.min(30, Math.max(1, Number(url.searchParams.get('days')) || 7));
          const snap = moodHistorySnapshot(days, 1000);
          const persona = normalizePersonaState(readJsonSafe(path.join(STATE_DIR, 'persona-state.json'), {}));
          sendJson({
            ok: true,
            days,
            current: snap.summary.current,
            summary: snap.summary,
            state: persona.mood,
            mode: derivePersonaMode(persona, { quiet: false }).id,
            points: snap.entries.map((item) => ({
              at: Number(item.at) || 0,
              v: Number(item?.after?.v) || 0,
              a: Number(item?.after?.a) || 0,
              e: Number(item?.after?.e) || 0,
              cause: String(item.cause || ''),
              mode: String(item.mode || ''),
              source: String(item.source || '')
            }))
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/voice-style') {
          sendJson({ ok: true, ...voiceStyleSnapshot(cfg) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/voice-style') {
          const body = await readBody();
          const mode = String(body.mode ?? '').trim();
          if (!['auto', 'soft', 'dark'].includes(mode)) { sendJson({ ok: false, error: 'mode 必须是 auto/soft/dark' }, 400); return; }
          writeVoiceStyleState({ mode, autoDark: false, source: 'console' });
          log(`[voice] 控制台切换声线：${mode}`);
          sendJson({ ok: true, ...voiceStyleSnapshot(cfg) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/signature') {
          const sig = cfg.simulation?.signature ?? {};
          let preview = '';
          try { preview = buildSignaturePreview(); } catch {}
          sendJson({
            ok: true,
            enabled: sig.enabled === true,
            llm: sig.llm !== false,
            minIntervalHours: Number(sig.minIntervalHours) || 12,
            maxIntervalHours: Number(sig.maxIntervalHours) || 48,
            dryRun: sig.dryRun === true,
            requireApproval: sig.requireApproval !== false,
            maxChars: Number(sig.maxChars) || 40,
            lastText: signatureState.lastText,
            lastAppliedAt: signatureState.lastAppliedAt,
            nextAt: signatureState.nextAt,
            lastError: signatureState.lastError,
            pending: signatureState.pending || null,
            history: signatureState.history.slice(-10).reverse(),
            preview
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/signature/preview') {
          sendJson({ ok: true, text: buildSignaturePreview() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/signature/apply') {
          if (!featureEnabled(cfg, 'signature')) {
            sendJson({ ok: false, disabled: true, reason: 'features.signature=false', error: '个性签名总开关已关闭' }, 403);
            return;
          }
          const body = await readBody();
          const text = String(body.text ?? '').trim() || buildSignaturePreview();
          if (!text) { sendJson({ ok: false, error: '签名不能为空' }, 400); return; }
          try {
            await applyQQSignature(text);
            const now = Date.now();
            signatureState.lastText = text;
            signatureState.lastAppliedAt = now;
            signatureState.lastError = '';
            signatureState.history = appendSignatureHistory(signatureState.history, text, now);
            signatureState.pending = null;
            signatureState.nextAt = 0;
            saveSignatureState();
            if (cfg.simulation?.signature?.enabled === true) scheduleSignatureNext(now);
            log(`控制台：个性签名已更新（${text.length} 字符，主人确认）`);
            sendJson({ ok: true, text });
          } catch (error) {
            signatureState.lastError = String(error?.message ?? error).slice(0, 300);
            saveSignatureState();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/signature/toggle') {
          const body = await readBody();
          const enabled = body.enabled === true;
          const configFile = path.join(ROOT, 'config.json');
          try {
            const file = readConfigObject(configFile);
            file.simulation = file.simulation && typeof file.simulation === 'object' ? file.simulation : {};
            file.simulation.signature = {
              ...(file.simulation.signature && typeof file.simulation.signature === 'object' ? file.simulation.signature : {}),
              enabled
            };
            writeConfigFile(file);
            cfg.simulation.signature = { ...(cfg.simulation.signature ?? {}), enabled };
            if (enabled) scheduleSignatureNext();
            else {
              if (jobQueue) jobQueue.clearPending('signature.auto');
              signatureState.pending = null;
              signatureState.nextAt = 0;
              saveSignatureState();
            }
            log(`控制台：自动个性签名已${enabled ? '开启' : '关闭'}`);
            sendJson({ ok: true, enabled });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 群日报预览（不发 QQ） ─────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/daily-report/preview') {
          const key = canonicalSimulationKey(String(url.searchParams.get('key') ?? '').trim());
          if (!key || !key.startsWith('group:')) { sendJson({ ok: false, error: 'key 必须是 group:群号' }, 400); return; }
          const st = getSimulationState(key);
          const report = buildDailyReport({
            key,
            messages: st.recentMessages,
            topics: st.activeTopics,
            now: Date.now(),
            maxItems: Number(cfg.simulation?.dailyReport?.maxItems) || 8
          });
          sendJson({
            ok: true,
            enabled: dailyReportEnabled(cfg, key),
            at: cfg.simulation?.dailyReport?.at || '21:30',
            text: report.text,
            stats: report.stats
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/presets') {
          let presets = [];
          try {
            const { presets: list } = unwrap(await api.agentPresets.list({}), 'agentPreset.list');
            presets = list.map((p) => ({ id: p.id, trust: p.trust ?? 'system' }));
          } catch {}
          sendJson({ presets });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/mode') {
          const body = await readBody();
          // 规范名与历史名都接受，落盘的始终是内部拼写（见 MODE_INPUT_ALIASES）。
          const requestedMode = normalizeModeInput(body.mode);
          if (!requestedMode) {
            sendJson({ ok: false, error: `mode 必须是 ${VALID_MODES.join(' / ')}（simulation 为规范名）` }, 400);
            return;
          }
          const existing = readJsonSafe(path.join(STATE_DIR, 'mode.json'), {});
          const next = {
            mode: requestedMode,
            // 未显式传 preset 时保留原值；原值也没有就留空（= 用 DSH 默认 preset）。
            ...(body.closedAgentPreset !== undefined
              ? { closedAgentPreset: String(body.closedAgentPreset ?? '') }
              : { closedAgentPreset: String(existing.closedAgentPreset ?? '') })
          };
          atomicWriteJson(path.join(STATE_DIR, 'mode.json'), next);
          // 用字符串判断而非真值判断：空串是「显式清空 preset」，也要生效。
          closedAgentPreset = next.closedAgentPreset;
          // 写穿到 DSH 设置。refreshMode() 每 5 秒跑一次且以 DSH 的值为准（插件的 base 保证
          // 该命名空间永远有值），所以只写本地 state/mode.json 会在下一次轮询时被静默回滚。
          // 写穿的是**内部拼写**（`simulation` 会写成 `simulation`）：DSH 里那份值会被 refreshMode
          // 读回来当 `currentMode` 用，存规范名会让下游那些 `=== 'simulation'` 判断失效。
          let dshSynced = false;
          try {
            // unwrap() 在 result.ok 为 false 时直接抛错，所以能执行到下一行即代表写穿已成功
            // （不要在这里再判断 updated?.ok —— 解包后的值恒为真，那样的分支是死代码）。
            unwrap(await api.settings.update({ ns: 'qq-mode', patch: { mode: requestedMode } }), 'settings.update');
            dshSynced = true;
          } catch (error) {
            log(`控制台：模式写穿 DSH 设置失败（${error?.message ?? error}）；本次仅写本地，下次 DSH 轮询会覆盖回滚`);
          }
          // 下面这两个判断比较的是「模式真的变了吗」。必须用归一后的值：拿 `body.mode` 比，
          // 把 `simulation` 与 `simulation` 当成两种模式，会在模式其实没变时清掉仿真定时器与排队投递。
          if (currentMode === 'reserved' && requestedMode !== 'reserved') {
            cleanupSocialForModeChange();
            log('控制台：模式离开旧版仿真模式，清理社交状态');
          }
          if (currentMode === 'simulation' && requestedMode !== 'simulation') {
            clearAllSimulationTimers();
            drainAllPromptQueues('模式切换，已取消排队中的投递');
            log('控制台：模式离开群聊剧场模式，清理 simulation 定时器与排队投递');
          }
          currentMode = requestedMode;
          lastMode = requestedMode;
          reconcileSessionPolicies();
          if (requestedMode === 'simulation') {
            for (const key of simulation.conversations.keys()) {
              setupSleepTimer(key);
              scheduleProactiveCheck(key);
            }
            log('控制台：模式进入群聊剧场模式，重建有限睡眠定时器');
          }
          log(`控制台：模式已设置为 ${requestedMode}${next.closedAgentPreset ? `（closed-agent preset: ${next.closedAgentPreset}）` : ''}${dshSynced ? '' : ' [仅本地，DSH 未同步]'}`);
          sendJson({ ok: true, mode: requestedMode, closedAgentPreset: next.closedAgentPreset, dshSynced });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role') {
          const body = await readBody();
          const rs = readRoleState();
          const prevRole = String(rs.role || '');
          if (body.role && typeof body.role === 'string') {
            const name = sanitizeRoleName(body.role);
            if (!fs.existsSync(path.join(ROOT, 'personas', name + '.md'))) {
              sendJson({ ok: false, error: `角色「${name}」不存在（personas/${name}.md）` }, 400);
              return;
            }
            writeRoleState(name, rs.mode);
            if (prevRole !== name) applyRoleSwitch(`控制台切换角色 → ${name}`);
            else invalidateRoleCards(`控制台重选当前角色 → ${name}`);
            const custom = isCustomRoleName(name);
            log(`控制台：角色已设置为 ${name}${custom ? '（自定义角色）' : '（默认角色）'}`);
            sendJson({
              ok: true,
              role: name,
              custom,
              notice: custom
                ? `「${name}」是自定义角色：只使用角色卡，不套用内置默认人格。`
                : `「${name}」是默认角色：内置人格内核仍生效；编辑 personas/${name}.md 只改角色卡文本，不算自定义角色。`
            });
          } else {
            writeRoleState(null, rs.mode);
            if (prevRole) applyRoleSwitch('控制台清除角色');
            else invalidateRoleCards('控制台清除角色');
            const notice = '已清除角色：不再扮演任何人格，只按仿真提示词行动。';
            log('控制台：角色已清除');
            sendJson({ ok: true, role: null, custom: false, notice });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/role-mode') {
          const body = await readBody();
          const rs = readRoleState();
          const mode = body.mode === 'silent' ? 'silent' : 'active';
          writeRoleState(rs.role, mode);
          log(`控制台：静默模式 ${mode === 'silent' ? '开启' : '关闭'}`);
          sendJson({ ok: true, roleMode: mode });
          return;
        }
        // ── 人格管理 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles') {
          const rs = readRoleState();
          const summaries = roleSummaries();
          sendJson({
            // roles 保持「人格名字符串数组」的既有契约（tests/console.test.mjs 等调用方依赖它）；
            // 富信息放在 summaries 里，新老调用方互不影响。
            roles: summaries.map((role) => role.name),
            summaries,
            current: rs.role ?? null,
            limits: { nameMax: ROLE_NAME_MAX, contentMaxBytes: ROLE_CONTENT_MAX_BYTES, injectMaxChars: roleInjectMaxChars },
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/inner-life/candidates') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          const cs = innerLife.getCandidates?.() ?? { candidates: [], fetchedAt: 0, lastError: '' };
          sendJson({
            ok: true,
            fetchedAt: Number(cs.fetchedAt) || 0,
            lastError: String(cs.lastError || ''),
            candidates: (Array.isArray(cs.candidates) ? cs.candidates : []).slice(0, 20).map((item) => ({
              source: String(item.source || ''),
              sourceLabel: String(item.sourceLabel || ''),
              title: String(item.title || '').slice(0, 200),
              url: String(item.url || ''),
              summary: String(item.summary || '').slice(0, 240),
              score: Number(item.score) || 0,
              publishedAt: Number(item.publishedAt) || 0
            }))
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/inner-life/candidates/refresh') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          try {
            const cs = await innerLife.refreshCandidates?.(true);
            sendJson({
              ok: true,
              fetchedAt: Number(cs?.fetchedAt) || Date.now(),
              lastError: String(cs?.lastError || ''),
              candidates: (Array.isArray(cs?.candidates) ? cs.candidates : []).slice(0, 20).map((item) => ({
                source: String(item.source || ''),
                sourceLabel: String(item.sourceLabel || ''),
                title: String(item.title || '').slice(0, 200),
                url: String(item.url || ''),
                summary: String(item.summary || '').slice(0, 240),
                score: Number(item.score) || 0,
                publishedAt: Number(item.publishedAt) || 0
              }))
            });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/inner-life/status') {
          sendJson({
            ok: true,
            status: innerLife?.statusText?.() ?? null,
            state: innerLife?.getState?.() ?? null,
            persona: innerLife?.personaInfo?.() ?? null
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/inner-life/qzone-comments/check') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          try {
            const result = await innerLife.checkQzoneComments?.();
            sendJson({ ok: true, result, status: innerLife.getQzoneCommentStatus?.() || null });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/inner-life/share') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          const body = await readBody();
          const action = String(body.action ?? '').trim();
          const command = action === 'approve' ? '发分享' : action === 'cancel' ? '不发分享' : '';
          if (!command) { sendJson({ ok: false, error: 'action 必须是 approve/cancel' }, 400); return; }
          const handled = await innerLife.handleOwnerCommand(command, { kind: 'private', isOwner: true });
          sendJson({ ok: Boolean(handled), action });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/inner-life/qzone') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          const body = await readBody();
          const action = String(body.action ?? '').trim();
          const command = action === 'pause' ? '关说说'
            : action === 'resume' ? '开说说'
              : action === 'approve' ? '发'
                : action === 'cancel' ? '不发'
                  : '';
          if (!command) { sendJson({ ok: false, error: 'action 必须是 pause/resume/approve/cancel' }, 400); return; }
          const handled = await innerLife.handleOwnerCommand(command, { kind: 'private', isOwner: true });
          sendJson({ ok: Boolean(handled), action });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/inner-life/run') {
          const body = await readBody();
          const job = String(body.job ?? '').trim();
          if (!['reflection', 'curiosity', 'qzone', 'aiTips'].includes(job)) {
            sendJson({ ok: false, error: 'job 必须是 reflection / curiosity / qzone / aiTips' }, 400);
            return;
          }
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          const force = body.force === true;
          const preferS16 = body.preferS16 === true;
          const forceApproval = body.forceApproval === true;
          const dryRun = body.dryRun === true;
          const featureId = job === 'qzone' ? 'qzone' : (job === 'aiTips' ? 'aiTips' : (job === 'curiosity' ? 'share' : ''));
          const previewOnly = dryRun && job === 'curiosity';
          if ((job === 'curiosity' || job === 'aiTips') && !shareEngineEnabled(cfg) && !previewOnly) {
            sendJson({ ok: false, disabled: true, reason: 'features.shareModule=false', error: '分享引擎总闸已关闭' }, 403);
            return;
          }
          if (featureId && !featureEnabled(cfg, featureId) && !previewOnly) {
            sendJson({ ok: false, disabled: true, reason: `features.${featureId}=false`, error: '这个功能的总开关已关闭' }, 403);
            return;
          }
          void innerLife.runJob(job, { force, preferS16, forceApproval, dryRun }).then((result) => log(`[inner] 控制台手动 ${job} → ${result?.status ?? 'done'}`));
          sendJson({ ok: true, started: true, job, force, preferS16, forceApproval, dryRun });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/inner-life/ai-tips') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          const body = await readBody();
          const action = String(body.action ?? '').trim();
          try {
            if (action === 'pause') { sendJson({ ok: true, status: innerLife.setAiTipsPaused?.(true) || null }); return; }
            if (action === 'resume') { sendJson({ ok: true, status: innerLife.setAiTipsPaused?.(false) || null }); return; }
            if (action === 'preview') {
              const result = await innerLife.previewAiTip();
              const { card, images, ...rest } = result || {};
              const toDataUrl = (buf, mime = 'image/png') => (Buffer.isBuffer(buf) && buf.length ? `data:${mime};base64,${buf.toString('base64')}` : '');
              const imageDataUrls = (Array.isArray(images) ? images : []).filter((buf) => Buffer.isBuffer(buf) && buf.length).slice(0, 3).map((buf) => toDataUrl(buf));
              const cardDataUrl = toDataUrl(card);
              sendJson({ ok: result?.status === 'dryRun', result: { ...rest, cardDataUrl, imageDataUrls }, status: innerLife.getAiTipsStatus?.() || null });
              return;
            }
            if (action === 'preview-owner') {
              const result = await innerLife.previewAiTipsToOwner?.(Number(body.count) || 3);
              sendJson({ ok: result?.status === 'ok', result, status: innerLife.getAiTipsStatus?.() || null });
              return;
            }
            if (action === 'run') {
              if (!shareEngineEnabled(cfg) && body.dryRun !== true) {
                sendJson({ ok: false, disabled: true, reason: 'features.shareModule=false', error: '分享引擎总闸已关闭' }, 403);
                return;
              }
              if (!featureEnabled(cfg, 'aiTips') && body.dryRun !== true) {
                sendJson({ ok: false, disabled: true, reason: 'features.aiTips=false', error: 'AI 小知识总开关已关闭' }, 403);
                return;
              }
              void innerLife.runJob('aiTips', { force: true, dryRun: body.dryRun === true })
                .then((result) => log(`[inner] 控制台手动 AI小知识 → ${result?.status ?? 'done'}`))
                .catch((error) => log(`[inner] 控制台手动 AI小知识 异常：${error?.message ?? error}`));
              sendJson({ ok: true, started: true, dryRun: body.dryRun === true });
              return;
            }
            sendJson({ ok: false, error: 'action 必须是 pause/resume/preview/run' }, 400);
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/inner-life/ai-tips/preview') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          try {
            const result = await innerLife.previewAiTip();
            const { card, images, ...rest } = result || {};
            const toDataUrl = (buf, mime = 'image/png') => (Buffer.isBuffer(buf) && buf.length ? `data:${mime};base64,${buf.toString('base64')}` : '');
            const imageDataUrls = (Array.isArray(images) ? images : []).filter((buf) => Buffer.isBuffer(buf) && buf.length).slice(0, 3).map((buf) => toDataUrl(buf));
            sendJson({ ok: result?.status === 'dryRun', result: { ...rest, cardDataUrl: toDataUrl(card), imageDataUrls }, status: innerLife.getAiTipsStatus?.() || null });
          } catch (error) {
            sendJson({ ok: false, error: String(error?.message ?? error) }, 502);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/inner-life/share-modules') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          const body = await readBody();
          const action = String(body.action ?? '').trim();
          const id = String(body.id ?? '').trim();
          try {
            if (action === 'preview') {
              const result = await innerLife.previewShareModule?.(id);
              const { images, card, ...rest } = result || {};
              const toData = (buf) => (Buffer.isBuffer(buf) && buf.length ? `data:image/png;base64,${buf.toString('base64')}` : '');
              const imageDataUrls = (Array.isArray(images) ? images : []).filter(Buffer.isBuffer).slice(0, 3).map(toData);
              sendJson({ ok: result?.status === 'dryRun', result: { ...rest, imageDataUrls, cardDataUrl: toData(card) } });
              return;
            }
            if (action === 'detail') {
              sendJson({ ok: true, module: innerLife.getShareModuleConfig?.(id) || null });
              return;
            }
            if (action === 'edit') {
              let input;
              try { input = JSON.parse(String(body.configJson || '{}')); } catch { sendJson({ ok: false, error: 'configJson 不是合法 JSON' }, 400); return; }
              const built = innerLife.updateShareModuleConfig?.(id, input);
              if (!built?.ok) { sendJson({ ok: false, error: built?.error || '模块不存在' }, 400); return; }
              const allowed = new Set((cfg.allow?.groups || []).map((key) => `group:${String(key).replace(/^group:/, '')}`));
              if (!built.module.targets.every((key) => allowed.has(key))) { sendJson({ ok: false, error: '目标群不在白名单' }, 400); return; }
              const written = writeShareModuleConfig(id, built.module);
              if (!written.ok) { sendJson({ ok: false, error: written.error }, 400); return; }
              innerLife.refreshShareModuleSchedule?.(id);
              log(`[share] 控制台编辑分享模块 ${id}`);
              sendJson({ ok: true, action, module: built.module, status: innerLife.getShareModulesStatus?.() || null });
              return;
            }
            if (action === 'pause' || action === 'resume') {
              const status = innerLife.setShareModulePaused?.(id, action === 'pause');
              sendJson({ ok: Boolean(status), status });
              return;
            }
            if (action === 'verify') {
              const status = innerLife.setShareVerification?.(id, 'approved');
              sendJson({ ok: Boolean(status), status });
              return;
            }
            if (action === 'run') {
              if (!shareEngineEnabled(cfg)) {
                sendJson({ ok: false, disabled: true, reason: 'features.shareModule=false', error: '分享引擎总闸已关闭' }, 403);
                return;
              }
              const featureId = featureForShareModule(id);
              if (!featureEnabled(cfg, featureId)) {
                sendJson({ ok: false, disabled: true, reason: `features.${featureId}=false`, error: '这个分享模块的开关已关闭' }, 403);
                return;
              }
              const result = await innerLife.runShareModule?.(id, { force: true });
              sendJson({ ok: result?.status === 'sent' || result?.status === 'pending-approval', result });
              return;
            }
            if (action === 'publish') {
              if (!shareEngineEnabled(cfg)) {
                sendJson({ ok: false, disabled: true, reason: 'features.shareModule=false', error: '分享引擎总闸已关闭' }, 403);
                return;
              }
              const featureId = featureForShareModule(id);
              if (!featureEnabled(cfg, featureId)) {
                sendJson({ ok: false, disabled: true, reason: `features.${featureId}=false`, error: '这个分享模块的开关已关闭' }, 403);
                return;
              }
              const result = await innerLife.publishShareDraft?.(id);
              sendJson({ ok: result?.status === 'sent', result });
              return;
            }
            sendJson({ ok: false, error: '未知 action' }, 400);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 502);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/inner-life/owner-features') {
          const body = await readBody();
          const action = String(body.action ?? '').trim();
          const id = String(body.id ?? '').trim();
          try {
            if (action === 'list') {
              sendJson({ ok: true, status: ownerFeaturesSnapshot() });
              return;
            }
            if (action === 'preview' || action === 'apply') {
              let input;
              try { input = JSON.parse(String(body.featureJson || '{}')); } catch { sendJson({ ok: false, error: 'featureJson 不是合法 JSON' }, 400); return; }
              input.id = String(body.id || input.id || '').trim();
              const feature = normalizeOwnerFeature(input, input.id);
              const checked = validateOwnerFeature(feature, { allowedTargets: ownerFeatureAllowedTargets() });
              if (!checked.ok) { sendJson({ ok: false, errors: checked.errors, error: checked.errors?.[0] || '校验失败' }, 400); return; }
              if (action === 'preview') {
                sendJson({ ok: true, feature, preview: renderOwnerFeaturePreview(feature, { targetLabels: ownerFeatureTargetLabels() }) });
                return;
              }
              if (body.confirm !== true) { sendJson({ ok: false, error: '应用需要 confirm=true' }, 400); return; }
              if (feature.type === 'code_feature') { sendJson({ ok: false, error: '代码类功能请走主人私聊提案通道' }, 400); return; }
              if (!['scheduled_message', 'qzone_post', 'auto_reply', 'voice_message'].includes(feature.type)) {
                sendJson({ ok: false, error: `${feature.type} 的运行时尚未接入` }, 400);
                return;
              }
              const allModules = { ...(ownerFeaturesConfig().modules || {}) };
              const state = loadOwnerFeatureState();
              const existing = allModules[feature.id] || null;
              const previousState = state.features[feature.id] || null;
              feature.createdAt = Number(existing?.createdAt) || Date.now();
              feature.updatedAt = Date.now();
              allModules[feature.id] = feature;
              writeOwnerFeatureModules(allModules);
              state.features[feature.id] = {
                nextAt: featureNextAt(feature),
                lastAt: 0,
                lastError: '',
                previous: existing
                  ? { module: existing, state: previousState ? { ...previousState, previous: undefined } : null }
                  : { module: null, state: null }
              };
              saveOwnerFeatureState(state);
              try {
                const orchDir = path.join(STATE_DIR, 'orchestrator');
                const queued = enqueueTask(orchDir, { id: feature.id, title: feature.label, kind: 'config', feature, source: 'console' });
                if (queued.ok) updateTask(orchDir, feature.id, { status: 'done', assignedTo: 'console' }, { by: 'bridge', note: '控制台配置功能已应用' });
              } catch (error) {
                log(`[orchestrator] 记录控制台任务失败：${error?.message ?? error}`);
              }
              log(`[ownerFeature] 控制台${existing ? '更新' : '创建'}功能 ${feature.id}`);
              sendJson({ ok: true, action, feature, nextAt: state.features[feature.id].nextAt, canRollback: true });
              return;
            }
            const modules = { ...(ownerFeaturesConfig().modules || {}) };
            if (!modules[id]) { sendJson({ ok: false, error: `功能 ${id} 不存在` }, 404); return; }
            if (action === 'delete') {
              delete modules[id];
            } else if (action === 'rollback') {
              const state0 = loadOwnerFeatureState();
              const prev = state0.features[id]?.previous;
              if (!prev) { sendJson({ ok: false, error: '没有可回滚的上一版' }, 400); return; }
              if (prev.module) modules[id] = prev.module; else delete modules[id];
            } else if (action === 'pause' || action === 'resume') {
              modules[id] = { ...modules[id], enabled: action === 'resume' };
            } else {
              sendJson({ ok: false, error: '未知 action' }, 400);
              return;
            }
            const configFile = path.join(ROOT, 'config.json');
            const file = readConfigObject(configFile);
            const patch = { 'simulation.ownerFeatures.enabled': true, 'simulation.ownerFeatures.modules': modules };
            const nextFile = applyConfigPatch(file, patch);
            nextFile.configVersion = CONFIG_VERSION;
            writeConfigFile(nextFile);
            const merged = deepMergeConfig(cfg, applyConfigPatch({}, patch));
            for (const k of Object.keys(cfg)) delete cfg[k];
            Object.assign(cfg, merged);
            const state = loadOwnerFeatureState();
            if (action === 'delete') delete state.features[id];
            else if (action === 'rollback') {
              const prev = state.features[id]?.previous;
              if (prev?.state) state.features[id] = { ...prev.state, previous: null };
              else delete state.features[id];
            }
            else if (action === 'resume') state.features[id] = { ...(state.features[id] || {}), nextAt: featureNextAt(normalizeOwnerFeature(modules[id], id)) };
            else state.features[id] = { ...(state.features[id] || {}), nextAt: 0 };
            saveOwnerFeatureState(state);
            sendJson({ ok: true, action, id, status: ownerFeaturesSnapshot() });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/inner-life/collect-stickers') {
          const body = await readBody();
          const count = Math.min(20, Math.max(1, Number(body.count) || 10));
          void collectImageStickersFromLibrary({ count, sendPreview: body.sendPreview !== false })
            .catch((error) => log('[sticker] 网图收表情任务异常:', error?.message ?? error));
          sendJson({ ok: true, started: true, count });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/content') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          const content = readRoleContent(name);
          sendJson({
            ok: true,
            name,
            content,
            chars: content.length,
            bytes: Buffer.byteLength(content, 'utf8'),
            warnings: roleWarnings(content),
            limits: { injectMaxChars: roleInjectMaxChars },
            stats: roleCharStats(content),
            // 每个小节在各模式下是否会被注入，供控制台预览「这条规则到底生不生效」
            sections: { legacy: roleSectionReport(content, 'legacy'), simulation: roleSectionReport(content, 'simulation') },
          });
          return;
        }
        // ── 结构化人格包（与角色卡同名的 .persona.json） ────────────────────
        if (req.method === 'GET' && url.pathname === '/api/roles/persona') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          let pack = null;
          try { pack = loadPersonaPack(ROLES_DIR, name); } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          sendJson({ ok: true, name, pack, exists: Boolean(pack) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/persona') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          const checked = validatePersonaPack(body.pack);
          if (!checked.ok) { sendJson({ ok: false, errors: checked.errors }, 400); return; }
          try {
            const target = personaPackPath(ROLES_DIR, name);
            if (fs.existsSync(target)) {
              const backupDir = path.join(STATE_DIR, 'role-backups');
              fs.mkdirSync(backupDir, { recursive: true });
              fs.copyFileSync(target, path.join(backupDir, `${name}.persona-${new Date().toISOString().replace(/[:.]/g, '-')}.json`));
            }
            savePersonaPack(ROLES_DIR, name, checked.value);
            invalidateRoleCards(`保存人格包「${name}」`);
            log(`控制台：人格包已保存「${name}」`);
            sendJson({ ok: true, name, pack: checked.value });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/persona/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          const target = personaPackPath(ROLES_DIR, name);
          if (!fs.existsSync(target)) { sendJson({ ok: false, error: '人格包不存在' }, 404); return; }
          try { fs.unlinkSync(target); invalidateRoleCards(`删除人格包「${name}」`); sendJson({ ok: true, name }); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? String(error) }, 500); }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/roles/export') {
          let name;
          try { name = validateRoleName(url.searchParams.get('name')); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          let pack = null;
          try { pack = loadPersonaPack(ROLES_DIR, name); } catch {}
          sendJson({ ok: true, name, content: readRoleContent(name), pack, exportedAt: new Date().toISOString() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/import') {
          const body = await readBody();
          let name; let content;
          try {
            name = validateRoleName(body.name);
            content = validateRoleContent(body.content);
          } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          const exists = fs.existsSync(roleFilePath(name));
          if (exists && body.overwrite !== true) { sendJson({ ok: false, error: `人格「${name}」已存在；传 overwrite=true 覆盖` }, 409); return; }
          let pack = null;
          if (body.pack) {
            const checked = validatePersonaPack(body.pack);
            if (!checked.ok) { sendJson({ ok: false, errors: checked.errors }, 400); return; }
            pack = checked.value;
          }
          try {
            if (exists) {
              const backupDir = path.join(STATE_DIR, 'role-backups');
              fs.mkdirSync(backupDir, { recursive: true });
              fs.copyFileSync(roleFilePath(name), path.join(backupDir, `${name}-${new Date().toISOString().replace(/[:.]/g, '-')}.md`));
            }
            writeRoleContent(name, content);
            if (pack) savePersonaPack(ROLES_DIR, name, pack);
            if (readRoleState().role === name) invalidateRoleCards(`导入当前人格「${name}」`);
            log(`控制台：导入人格「${name}」（${content.length} 字符，人格包${pack ? '有' : '无'}）`);
            const custom = isCustomRoleName(name);
            sendJson({
              ok: true,
              name,
              custom,
              chars: content.length,
              hasPack: Boolean(pack),
              notice: custom
                ? `「${name}」是自定义角色：只使用角色卡。`
                : `「${name}」是默认角色：内置人格内核仍生效，不算自定义角色。`
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/limit') {
          const body = await readBody();
          const next = applyRoleInjectLimit(body.maxInjectChars);
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          file.role = { ...(file.role ?? {}), maxInjectChars: next };
          writeConfigFile(file, { tag: 'role' });
          cfg.role = { ...(cfg.role ?? {}), maxInjectChars: next };
          roleInjectMaxChars = next;
          log(`控制台：人格注入上限已设为 ${next} 字符（下一条消息生效）`);
          sendJson({ ok: true, maxInjectChars: next, limits: { injectMaxChars: next } });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/create') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」已存在` }, 400); return; }
          writeRoleContent(name, content);
          log(`控制台：创建人格「${name}」（${content.length} 字符）`);
          const custom = isCustomRoleName(name);
          sendJson({
            ok: true,
            role: name,
            custom,
            warnings: roleWarnings(content),
            notice: custom
              ? `「${name}」是自定义角色：只使用角色卡。`
              : `「${name}」是默认角色：内置人格内核仍生效，不算自定义角色。`
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/update') {
          const body = await readBody();
          let name; let content;
          try { name = validateRoleName(body.name); content = validateRoleContent(body.content); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          writeRoleContent(name, content);
          if (readRoleState().role === name) invalidateRoleCards(`更新当前人格「${name}」`);
          const custom = isCustomRoleName(name);
          log(`控制台：更新人格「${name}」（${content.length} 字符）`);
          sendJson({
            ok: true,
            role: name,
            custom,
            chars: content.length,
            warnings: roleWarnings(content),
            notice: custom
              ? `「${name}」是自定义角色：人格与语气只来自这张卡。`
              : `「${name}」是默认角色：改文件只更新角色卡文本，内置人格内核和默认语气规则仍生效，不算自定义角色。`
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/rename') {
          const body = await readBody();
          let from; let to;
          try { from = validateRoleName(body.from); to = validateRoleName(body.to); }
          catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (from === to) { sendJson({ ok: true, role: to, renamed: false }); return; }
          if (!fs.existsSync(roleFilePath(from))) { sendJson({ ok: false, error: `人格「${from}」不存在` }, 404); return; }
          if (fs.existsSync(roleFilePath(to))) { sendJson({ ok: false, error: `人格「${to}」已存在` }, 400); return; }
          fs.renameSync(roleFilePath(from), roleFilePath(to));
          const rs = readRoleState();
          const switched = rs.role === from;
          if (switched) {
            writeRoleState(to, rs.mode);
            applyRoleSwitch(`人格改名 ${from}→${to}（当前启用中）`);
          }
          log(`控制台：人格重命名「${from}」→「${to}」${switched ? '（当前启用中，已跟随切换）' : ''}`);
          sendJson({ ok: true, role: to, renamed: true, currentFollowed: switched, custom: isCustomRoleName(to) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/roles/delete') {
          const body = await readBody();
          let name;
          try { name = validateRoleName(body.name); } catch (error) { sendJson({ ok: false, error: error.message }, 400); return; }
          if (!fs.existsSync(roleFilePath(name))) { sendJson({ ok: false, error: `人格「${name}」不存在` }, 404); return; }
          fs.rmSync(roleFilePath(name));
          const rs = readRoleState();
          const cleared = rs.role === name;
          if (cleared) {
            writeRoleState(null, rs.mode);
            applyRoleSwitch(`删除当前人格「${name}」`);
          }
          log(`控制台：删除人格「${name}」${cleared ? '（该人格正在启用，已同时清除当前人格）' : ''}`);
          sendJson({ ok: true, deleted: name, clearedCurrent: cleared });
          return;
        }

        // ── 仿真提示词（旧版 / 仿真各自的预设内置提示词）──────────────────────
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const { prefix } = readPresetPromptText(preset);
            sendJson({
              ok: true,
              content: prefix,
              chars: prefix.length,
              bytes: Buffer.byteLength(prefix, 'utf8'),
              warnings: presetPromptWarnings(prefix),
              status: presetStatus(preset),
              presets: Object.values(PRESET_NAMES).map((n) => presetStatus(n)),
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取预设失败', status: presetStatus(preset) }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          let nextText;
          try {
            const { text, prefix } = readPresetPromptText(preset);
            // 内容没变就不要写：写回会把折叠块规整成字面量块（值不变但排版变化），
            // 让一次"打开又保存"把整个提示词块变成全删全加的 diff，失去可复审性。
            const normalized = String(body.content ?? '').replace(/\r\n/g, '\n').replace(/\n+$/, '');
            if (normalized === prefix) {
              sendJson({ ok: true, unchanged: true, chars: prefix.length, warnings: presetPromptWarnings(prefix), synced: fs.existsSync(installedPresetYaml(preset)), requiresRestart: false, status: presetStatus(preset) });
              return;
            }
            nextText = renderPresetPromptYaml(text, body.content, preset === PRESET_NAMES.legacy ? 'legacy' : 'simulation');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '校验失败' }, 400);
            return;
          }
          const warnings = presetPromptWarnings(body.content);
          let sourceBackup = null;
          try {
            sourceBackup = backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), nextText);
            // 同步到 DSH 实际读取的安装目录。
            // 注意：安装副本**不做仓库内备份**——它的内容与刚写好的源文件一致，
            // 备份它等于把含本机绝对路径的快照塞进仓库工作区，没有额外价值。
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) {
              fs.copyFileSync(presetSourceYaml(preset), installed);
            }
          } catch (error) {
            // 尽力回滚源文件，避免留下半截状态
            if (sourceBackup && fs.existsSync(sourceBackup)) {
              try { fs.copyFileSync(sourceBackup, presetSourceYaml(preset)); } catch {}
            }
            sendJson({ ok: false, error: `写入失败：${error?.message ?? error}` }, 500);
            return;
          }
          log(`控制台：${preset} 仿真提示词已更新（${String(body.content ?? '').length} 字符）${warnings.length ? `，${warnings.length} 条警告` : ''}；需重启 DSH 生效`);
          sendJson({
            ok: true,
            chars: String(body.content ?? '').length,
            warnings,
            synced: fs.existsSync(installedPresetYaml(preset)),
            requiresRestart: true,
            status: presetStatus(preset),
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/preset/sim-prompt/backups') {
          const preset = knownPresetName(url.searchParams.get('preset'));
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            sendJson({ ok: true, backups: listPresetBackups(preset) });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '读取备份失败' }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/preset/sim-prompt/restore') {
          const body = await readBody();
          const preset = knownPresetName(body.preset);
          if (!preset) { sendJson({ ok: false, error: `未知预设（只支持 ${Object.values(PRESET_NAMES).join(' / ')}）` }, 400); return; }
          try {
            const requested = String(body.file ?? '').trim();
            const candidates = listPresetBackups(preset).map((b) => b.file);
            const target = requested || candidates[0];
            // 只允许还原本预设目录下的备份文件，拒绝任何路径穿越
            if (!target || !candidates.includes(target)) { sendJson({ ok: false, error: '没有可用的备份' }, 400); return; }
            const backupPath = path.join(PRESET_BACKUP_DIR, target);
            const restored = fs.readFileSync(backupPath, 'utf8');
            const restoredPrefix = extractPresetPrefix(restored);
            if (restoredPrefix === null) { sendJson({ ok: false, error: '备份内容不是有效的预设文件' }, 400); return; }
            // 还原路径必须与保存路径同样严格：旧备份可能来自安全基线加入之前，
            // 直接还原会把弱化版提示词（缺「你没有本地工具」等不变量）写回去。
            // 不变量清单**按预设取**：旧版本来就没有「你没有本地工具」这类工具面表述。
            const blockers = presetPromptBlockers(restoredPrefix, preset === PRESET_NAMES.legacy ? 'legacy' : 'simulation');
            if (blockers.length) {
              sendJson({ ok: false, error: `该备份不满足当前的安全不变量，拒绝还原：${blockers.join('；')}` }, 400);
              return;
            }
            backupPresetFile(preset);
            atomicWriteText(presetSourceYaml(preset), restored);
            const installed = installedPresetYaml(preset);
            if (fs.existsSync(installed)) fs.copyFileSync(presetSourceYaml(preset), installed);
            log(`控制台：${preset} 仿真提示词已还原自备份 ${target}；需重启 DSH 生效`);
            sendJson({ ok: true, restoredFrom: target, requiresRestart: true });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? '还原失败' }, 500);
          }
          return;
        }

        // ── 黑话库管理 ──────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/slang') {
          const status = url.searchParams.get('status') || '';
          const list = status ? slangEntries.filter((e) => e.status === status) : slangEntries;
          sendJson({ entries: list, config: cfg.slang, writable: slangStoreWritable });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang') {
          const body = await readBody();
          const content = String(body.content ?? '').trim();
          if (!content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          if (slangEntries.some((e) => e.content === content)) { sendJson({ ok: false, error: `黑话「${content}」已存在` }, 400); return; }
          const entry = createSlangEntry({
            content,
            meaning: String(body.meaning ?? '').trim(),
            usage: String(body.usage ?? '').trim(),
            example: String(body.example ?? '').trim(),
            risk: String(body.risk ?? '').trim(),
            sources: Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean) : [],
            status: body.status === SLANG_STATUS.CANDIDATE ? SLANG_STATUS.CANDIDATE : SLANG_STATUS.CONFIRMED,
            source: 'manual',
            evidence: Array.isArray(body.evidence) ? body.evidence : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          log(`控制台：新增黑话「${content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/clear') {
          const body = await readBody();
          const status = String(body.status ?? '').trim();
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}，仅支持 candidate/confirmed/rejected 或留空全部删除` }, 400);
            return;
          }
          let removedCount = 0;
          if (status) {
            removedCount = slangEntries.filter((e) => e.status === status).length;
            slangEntries = slangEntries.filter((e) => e.status !== status);
          } else {
            removedCount = slangEntries.length;
            slangEntries = [];
            // 清空所有时同步清掉待提取窗口和冷却，避免“删了又回来”
            slangWindows.clear();
            slangExtractionCooldowns.clear();
            slangSubmitTimes.clear();
            slangResearchingIds.clear();
          }
          saveSlangStore();
          log(`控制台：清空黑话 ${removedCount} 条${status ? `（${status}）` : ''}`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-delete') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          const status = String(body.status ?? '').trim();
          if (ids.length) {
            const idSet = new Set(ids);
            const before = slangEntries.length;
            slangEntries = slangEntries.filter((e) => !idSet.has(e.id));
            const removedCount = before - slangEntries.length;
            if (!removedCount) { sendJson({ ok: false, error: '没有匹配到要删除的黑话' }, 404); return; }
            saveSlangStore();
            log(`控制台：批量删除黑话 ${removedCount} 条`);
            sendJson({ ok: true, removedCount });
            return;
          }
          if (status && ![SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(status)) {
            sendJson({ ok: false, error: `无效的 status：${status}` }, 400);
            return;
          }
          if (!status) { sendJson({ ok: false, error: '请提供 ids 或 status' }, 400); return; }
          const removedCount = slangEntries.filter((e) => e.status === status).length;
          slangEntries = slangEntries.filter((e) => e.status !== status);
          saveSlangStore();
          log(`控制台：批量删除黑话 ${removedCount} 条（${status}）`);
          sendJson({ ok: true, removedCount });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-confirm') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要确认的黑话' }, 400); return; }
          let confirmedCount = 0;
          let skippedCount = 0;
          const skipped = [];
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) { skippedCount++; skipped.push({ id, reason: '不存在' }); continue; }
            const entry = slangEntries[idx];
            if (entry.status !== SLANG_STATUS.CANDIDATE) { skippedCount++; skipped.push({ id, content: entry.content, reason: '不是候选' }); continue; }
            if (!entry.meaning || !String(entry.meaning).trim()) { skippedCount++; skipped.push({ id, content: entry.content, reason: '缺少含义' }); continue; }
            entry.status = SLANG_STATUS.CONFIRMED;
            entry.updatedAt = new Date().toISOString();
            confirmedCount++;
          }
          if (confirmedCount) saveSlangStore();
          log(`控制台：批量确认黑话 ${confirmedCount} 条，跳过 ${skippedCount} 条`);
          sendJson({ ok: true, confirmedCount, skippedCount, skipped: skipped.slice(0, 20) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/batch-reject') {
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
          if (!ids.length) { sendJson({ ok: false, error: '请选择要拒绝的黑话' }, 400); return; }
          let rejectedCount = 0;
          for (const id of ids) {
            const idx = slangEntries.findIndex((e) => e.id === id);
            if (idx < 0) continue;
            const entry = slangEntries[idx];
            if (entry.status === SLANG_STATUS.REJECTED) continue;
            entry.status = SLANG_STATUS.REJECTED;
            entry.updatedAt = new Date().toISOString();
            rejectedCount++;
          }
          if (rejectedCount) saveSlangStore();
          log(`控制台：批量拒绝黑话 ${rejectedCount} 条`);
          sendJson({ ok: true, rejectedCount });
          return;
        }
        const slangMatch = url.pathname.match(/^\/api\/slang\/([^/]+)(?:\/(confirm|reject))?$/);
        if (req.method === 'PATCH' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = { ...slangEntries[idx] };
          if (body.content !== undefined) entry.content = String(body.content ?? '').trim();
          if (body.content !== undefined && slangEntries.some((e) => e.id !== id && e.content === entry.content)) {
            sendJson({ ok: false, error: `黑话「${entry.content}」已存在` }, 400);
            return;
          }
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (body.status !== undefined && [SLANG_STATUS.CANDIDATE, SLANG_STATUS.CONFIRMED, SLANG_STATUS.REJECTED].includes(body.status)) entry.status = body.status;
          if (!entry.content) { sendJson({ ok: false, error: '黑话内容不能为空' }, 400); return; }
          entry.updatedAt = new Date().toISOString();
          slangEntries[idx] = entry;
          saveSlangStore();
          log(`控制台：更新黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'confirm') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const body = await readBody();
          const entry = slangEntries[idx];
          if (body.meaning !== undefined) entry.meaning = String(body.meaning ?? '').trim();
          if (body.usage !== undefined) entry.usage = String(body.usage ?? '').trim();
          if (body.example !== undefined) entry.example = String(body.example ?? '').trim();
          if (body.risk !== undefined) entry.risk = String(body.risk ?? '').trim();
          if (body.sources !== undefined) entry.sources = Array.isArray(body.sources) ? body.sources.map(String).filter(Boolean).slice(0, 10) : [];
          if (!entry.meaning) {
            sendJson({ ok: false, error: '请先填写含义再确认，否则不会注入 AI 上下文' }, 400);
            return;
          }
          entry.status = SLANG_STATUS.CONFIRMED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：确认黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'POST' && slangMatch && slangMatch[2] === 'reject') {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const entry = slangEntries[idx];
          entry.status = SLANG_STATUS.REJECTED;
          entry.updatedAt = new Date().toISOString();
          saveSlangStore();
          log(`控制台：拒绝黑话「${entry.content}」`);
          sendJson({ ok: true, entry });
          return;
        }
        if (req.method === 'DELETE' && slangMatch && !slangMatch[2]) {
          const id = slangMatch[1];
          const idx = slangEntries.findIndex((e) => e.id === id);
          if (idx < 0) { sendJson({ ok: false, error: '黑话不存在' }, 404); return; }
          const [removed] = slangEntries.splice(idx, 1);
          saveSlangStore();
          log(`控制台：删除黑话「${removed.content}」`);
          sendJson({ ok: true, removed });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/extract') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (key && slangWindows.has(key)) {
            queueSlangTask(() => runSlangExtraction(key));
            sendJson({ ok: true, key });
          } else {
            const firstKey = slangWindows.keys().next().value;
            if (!firstKey) { sendJson({ ok: false, error: '当前没有可学习消息窗口' }, 400); return; }
            queueSlangTask(() => runSlangExtraction(firstKey));
            sendJson({ ok: true, key: firstKey });
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/research') {
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 400); return; }
          const body = await readBody();
          const ids = Array.isArray(body.ids) ? body.ids.map(String) : [];
          const candidates = ids.length
            ? slangEntries.filter((e) => ids.includes(e.id) && e.status === SLANG_STATUS.CANDIDATE)
            : slangEntries.filter((e) => e.status === SLANG_STATUS.CANDIDATE);
          if (!candidates.length) { sendJson({ ok: false, error: '没有可研究的候选黑话' }, 400); return; }
          const maxPerRun = Math.max(1, Math.min(20, Number(cfg.slang?.researchMaxPerRun) || 6));
          const queued = candidates.slice(0, maxPerRun);
          queueSlangTask(() => runSlangResearch(queued));
          sendJson({ ok: true, count: queued.length, remaining: Math.max(0, candidates.length - queued.length) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/slang/config') {
          const body = await readBody();
          const oldPreset = cfg.slang?.learnerPreset;
          const oldWorkspaceTitle = cfg.slang?.workspaceTitle;
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const merged = { ...(file.slang ?? {}), ...body };
          if (typeof merged.enabled === 'boolean') merged.enabled = merged.enabled;
          else if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.extractMinMessages !== undefined) merged.extractMinMessages = Math.max(1, Math.round(Number(merged.extractMinMessages) || 1));
          if (merged.extractCooldownMs !== undefined) merged.extractCooldownMs = Math.max(0, Math.round(Number(merged.extractCooldownMs) || 0));
          if (merged.injectMax !== undefined) merged.injectMax = Math.min(30, Math.max(1, Math.round(Number(merged.injectMax) || 1)));
          if (merged.autoResearch !== undefined) merged.autoResearch = merged.autoResearch === true;
          if (merged.learnerPreset !== undefined) merged.learnerPreset = String(merged.learnerPreset ?? '').trim();
          if (merged.workspaceTitle !== undefined) merged.workspaceTitle = String(merged.workspaceTitle ?? '').trim() || 'QQ 黑话学习';
          if (body.inferenceThresholds !== undefined) {
            const raw = Array.isArray(body.inferenceThresholds)
              ? body.inferenceThresholds
              : String(body.inferenceThresholds).split(/[,，\s]+/);
            merged.inferenceThresholds = [...new Set(raw.map((n) => Math.max(1, Math.round(Number(n) || 1))))].sort((a, b) => a - b);
            if (!merged.inferenceThresholds.length) merged.inferenceThresholds = [2, 4, 8];
          }
          file.slang = merged;
          writeConfigFile(file);
          cfg.slang = { ...cfg.slang, ...merged };
          if (body.learnerPreset !== undefined && String(body.learnerPreset ?? '').trim() !== String(oldPreset ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习 preset 已变更，已重置学习会话');
          } else if (body.workspaceTitle !== undefined && String(body.workspaceTitle ?? '').trim() !== String(oldWorkspaceTitle ?? '')) {
            invalidateSlangLearnerSession();
            log('黑话学习工作区名已变更，已重置学习会话');
          }
          log('控制台：黑话系统配置已更新');
          sendJson({ ok: true, config: cfg.slang });
          return;
        }
        // ── 会话查看 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/sessions') {
          const list = [];
          for (const [key, sessionId] of Object.entries(state.sessions)) {
            list.push({ key, sessionId, owner: key === `private:${String(cfg.ownerQQ ?? '')}`, name: conversationDisplayName(key) });
          }
          sendJson({ sessions: list });
          return;
        }
        // ── 挂起审批 / 提问 ───────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/pending') {
          const list = [];
          for (const [key, p] of pending.entries()) {
            list.push({
              key,
              name: conversationDisplayName(key),
              kind: p.kind,
              sessionId: p.sessionId,
              ...(p.kind === 'approval' ? { toolName: p.toolName, reason: p.reason, approvalId: p.approvalId } : {}),
              ...(p.kind === 'question' ? { questions: p.questions } : {})
            });
          }
          sendJson({ pending: list });
          return;
        }
        // ── 白名单可视化编辑（写 config.json + 热更新内存） ───────────────────
        if (req.method === 'GET' && url.pathname === '/api/whitelist') {
          sendJson({ allow: cfg.allow ?? { private: [], groups: [] }, deny: cfg.deny ?? { private: [], groups: [] }, ownerQQ: cfg.ownerQQ ?? null });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/whitelist') {
          const body = await readBody();
          const toNum = (arr) => Array.isArray(arr) ? [...new Set(arr.map((x) => Number(String(x).trim())).filter((n) => Number.isFinite(n)))] : undefined;
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 allow/deny/ownerQQ
          const file = readConfigObject(configFile);
          const allow = {
            private: toNum(body.allow?.private) ?? (file.allow?.private ?? []),
            groups: toNum(body.allow?.groups) ?? (file.allow?.groups ?? [])
          };
          const deny = {
            private: toNum(body.deny?.private) ?? (file.deny?.private ?? []),
            groups: toNum(body.deny?.groups) ?? (file.deny?.groups ?? [])
          };
          // 管理员 QQ 可在控制台输入；空值=清除管理员（fail-closed），非法值拒绝写入。
          let ownerQQ = cfg.ownerQQ ?? null;
          if (body.ownerQQ !== undefined) {
            try {
              ownerQQ = normalizeOwnerQQ(body.ownerQQ);
            } catch (error) {
              sendJson({ ok: false, error: error?.message ?? 'ownerQQ 无效' }, 400);
              return;
            }
          }
          file.allow = allow;
          file.deny = deny;
          file.ownerQQ = ownerQQ;
          writeConfigFile(file, { danger: true });
          cfg.allow = { private: allow.private, groups: allow.groups };
          cfg.deny = { private: deny.private, groups: deny.groups };
          cfg.ownerQQ = ownerQQ;
          reconcileSessionPolicies();
          log(`控制台：白名单已更新（群: ${allow.groups.join(',') || '无'}，私聊: ${allow.private.join(',') || '无'}，管理员: ${ownerQQ ?? '未设置'}）`);
          sendJson({ ok: true, allow, deny, ownerQQ });
          return;
        }

        // ── DSH 模型与思考强度 ───────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/dsh/model') {
          const provider = String(cfg.dsh?.provider || 'deepseek-official');
          const model = String(cfg.dsh?.model || 'deepseek-flash');
          // 档位优先取 DSH 实际公布的能力（DSH 换档位词汇或换 provider 时自动跟随），失败退回内置白名单。
          let options = REASONING_EFFORT_OPTIONS.slice();
          let labels = {};
          let providerDefault = null;
          let catalogSource = 'fallback';
          try {
            if (!modelCatalogInFlight) {
              modelCatalogInFlight = withTimeout(fetchModelCatalog(), 3000, 'session/modelCatalog')
                .finally(() => { modelCatalogInFlight = null; });
            }
            const catalog = unwrap(await modelCatalogInFlight, 'session.modelCatalog');
            const group = (catalog?.groups ?? []).find((g) => g?.id === provider);
            const entry = (group?.models ?? []).find((m) => m?.id === model);
            const efforts = entry?.reasoning?.efforts ?? [];
            const advertised = efforts.map((e) => String(e?.id ?? '')).filter((id) => REASONING_EFFORT_OPTIONS.includes(id));
            if (advertised.length) {
              options = advertised;
              labels = Object.fromEntries(efforts.map((e) => [String(e.id), { name: e.name ?? '', description: e.description ?? '' }]));
              providerDefault = entry.reasoning.defaultEffort ?? null;
              catalogSource = 'dsh';
            }
          } catch (error) {
            // 同一条失败原因只记一次：控制台每次刷新都会打这条接口，否则日志会被刷爆。
            const reason = String(error?.message ?? error);
            if (!modelCatalogErrorLogged.has(reason)) {
              modelCatalogErrorLogged.add(reason);
              log(`读取 DSH 模型能力失败，思考强度暂用内置清单：${reason}`);
            }
          }
          sendJson({
            provider,
            model,
            reasoningEffort: String(cfg.dsh?.reasoningEffort || REASONING_EFFORT_DEFAULT),
            options,
            labels,
            default: REASONING_EFFORT_DEFAULT,
            providerDefault,
            catalogSource,
            // selectModel 会同时写会话级与 DSH 全局默认（~/.dsh/settings.yaml 的 agent-default-model），
            // 控制台要把这点明确告诉管理员，避免「只想调 QQ 助手却改了 Web GUI 新会话默认」的意外。
            globalSideEffect: true,
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/dsh/effort') {
          const body = await readBody();
          let effort;
          try { effort = normalizeReasoningEffort(body.reasoningEffort); }
          catch (error) { sendJson({ ok: false, error: error?.message ?? '思考强度无效' }, 400); return; }
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置损坏时直接 500，绝不回写（与白名单接口同语义）
          const file = readConfigObject(configFile);
          file.dsh = { ...(file.dsh ?? {}), reasoningEffort: effort };
          writeConfigFile(file, { tag: 'dsh' });
          cfg.dsh = { ...(cfg.dsh ?? {}), reasoningEffort: effort };
          // 上一次失败可能只是某个档位（例如 max）不支持；换了档位必须重新试探，
          // 否则这个进程会一直跳过 reasoningEffort，设置 low/high 也不会生效。
          reasoningEffortUnsupported = false;
          // 递增代号：已在运行的会话在下一条消息会重新 selectModel（无需重启桥接或 DSH）
          modelSelectionEpoch += 1;
          log(`控制台：DSH 思考强度已设为 ${effort}（对已有会话于下一条消息生效）`);
          sendJson({ ok: true, reasoningEffort: effort });
          return;
        }

        // ── 安全拦截通知设置 ─────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/security') {
          sendJson({
            security: cfg.security ?? { interceptNotify: true },
            // state/ 的 ACL 收紧结果：Windows 上改 ACL 需要管理员权限，未提权时会失败。
            // 控制台据此显示警告与可复制的命令（而不是让用户以为已经安全）。
            // 命令必须取自 state-acl 的**安全**版本：把 (OI)(CI) 授权和 /T 混在一句里
            // 会把子文件 DACL 清空，用户照抄就会把自己的 state/ 弄坏。
            stateDir: {
              hardened: stateDirHardened,
              path: STATE_DIR,
              manualCommand: process.platform === 'win32'
                ? manualDirCommand(STATE_DIR)
                : `chmod 700 "${STATE_DIR}"`
            }
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/security') {
          const body = await readBody();
          // 支持从控制台**重试**收紧 state/ 权限（用户在管理员终端里配好了权限/换了启动方式后）。
          if (body.rehardenStateDir === true) {
            stateDirHardened = null;
            hardenStateDirAcl();
            sendJson({ ok: stateDirHardened === true, hardened: stateDirHardened, path: STATE_DIR });
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const next = { ...(file.security ?? {}), ...body };
          if (typeof next.interceptNotify === 'boolean') next.interceptNotify = next.interceptNotify;
          else if (next.interceptNotify !== undefined) next.interceptNotify = Boolean(next.interceptNotify);
          file.security = next;
          writeConfigFile(file, { tag: 'security' });
          cfg.security = { ...(cfg.security ?? {}), ...next };
          log(`控制台：安全拦截通知已更新（interceptNotify=${cfg.security.interceptNotify}）`);
          sendJson({ ok: true, security: cfg.security });
          return;
        }
        // ── 拉黑名单（查看/手动拉黑/解封；完整名单只在本机控制台与主人私聊） ──
        if (req.method === 'GET' && url.pathname === '/api/blacklist') {
          sendJson({ ok: true, enabled: blacklistCfg().enabled, count: blacklistStore.count(), entries: blacklistStore.list() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/blacklist') {
          const body = await readBody();
          const action = String(body.action ?? '').trim();
          if (action === 'add') {
            const qq = String(body.qq ?? '').trim();
            if (String(qq) === String(cfg.ownerQQ ?? '')) { sendJson({ ok: false, error: '不能拉黑主人自己' }, 400); return; }
            const r = blacklistStore.add({ qq, name: body.name, reason: body.reason, origin: 'owner' });
            if (!r.ok) { sendJson({ ok: false, error: 'QQ 号格式不对' }, 400); return; }
            sendJson({ ok: true, entry: r.entry, count: blacklistStore.count() });
            return;
          }
          if (action === 'remove') {
            const r = blacklistStore.remove(body.qq);
            sendJson(r.ok ? { ok: true, count: blacklistStore.count() } : { ok: false, error: '不在黑名单里' }, r.ok ? 200 : 404);
            return;
          }
          sendJson({ ok: false, error: 'action 必须是 add / remove' }, 400);
          return;
        }
        // ── 控制台访问令牌（可手动修改/生成随机） ─────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/token') {
          const body = await readBody();
          let newToken = String(body.token ?? '').trim();
          const generated = !newToken;
          if (generated) {
            newToken = crypto.randomBytes(24).toString('hex');
          }
          if (newToken.length < 16) {
            sendJson({ ok: false, error: '控制台访问令牌至少需要 16 位；留空可生成随机令牌' }, 400);
            return;
          }
          if (newToken.length > 128) {
            sendJson({ ok: false, error: '控制台访问令牌不能超过 128 位' }, 400);
            return;
          }
          if (!/^[A-Za-z0-9_-]+$/.test(newToken)) {
            sendJson({ ok: false, error: '控制台访问令牌只能包含字母、数字、下划线或短横线' }, 400);
            return;
          }
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // 手动令牌写入 config.json（用户可见、可再改）；随机令牌写入 state/console-token 并清空 config 中的手动值。
          file.consoleToken = generated ? '' : newToken;
          writeConfigFile(file, { danger: true });
          cfg.consoleToken = generated ? '' : newToken;
          atomicWriteText(path.join(STATE_DIR, 'console-token'), newToken);
          consoleToken = newToken;
          log(`控制台：访问令牌已${generated ? '重新生成' : '手动修改'}（不记录完整值）`);
          sendJson({ ok: true, token: newToken, generated });
          return;
        }
        // ── 测试发送消息（强制走白名单校验） ───────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/test-send') {
          const body = await readBody();
          const kind = body.kind === 'private' ? 'private' : 'group';
          const id = Number(body.id);
          const message = String(body.message ?? '').trim();
          if (!Number.isFinite(id) || id <= 0) { sendJson({ ok: false, error: '目标 id 无效' }, 400); return; }
          if (!message) { sendJson({ ok: false, error: '消息不能为空' }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          if (!allowed(kind, id, cfg)) { sendJson({ ok: false, error: `目标不在白名单内（${kind} ${id}），请先加入白名单` }, 403); return; }
          if (!modeAllowed(`${kind}:${id}`, kind, id, cfg, currentMode)) { sendJson({ ok: false, error: `当前模式（${currentMode}）不允许向 ${kind}:${id} 发送测试消息` }, 403); return; }
          try {
            const safeMessage = escapeCqText(redactKnownTokensOnly(message));
            const result = kind === 'private'
              ? await bot.sendPrivateMessage(id, text(safeMessage))
              : await bot.sendGroupMessage(id, text(safeMessage));
            log(`控制台：测试发送 ${kind}:${id} 成功`);
            sendJson({ ok: true, kind, id, message_id: result?.message_id ?? result });
          } catch (error) {
            sendJson({ ok: false, error: `发送失败: ${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/state') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const phase = body.phase;
          if (phase === 'active') {
            // 手动进入活跃：相当于第四种触发方式，之后按正常活跃流程跑
            enterActive(key);
            log(`控制台：手动将 ${key} 设为活跃`);
            sendJson({ ok: true, key, phase: 'active' });
          } else if (phase === 'idle') {
            leaveActive(key);
            log(`控制台：手动将 ${key} 设为观望`);
            sendJson({ ok: true, key, phase: 'idle' });
          } else {
            sendJson({ ok: false, error: 'phase 必须是 active 或 idle' }, 400);
          }
          return;
        }
        // ── 仿真群友模式（社交引擎）配置 ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/social') {
          const stats = {};
          for (const [k, e] of social.pendingSummaries.entries()) stats[k] = e.items.length;
          const states = {};
          const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
          for (const k of keys) {
            const st = social.states.get(k);
            states[k] = { phase: st?.phase ?? 'idle' };
          }
          sendJson({ config: socialConfigForView(), pendingSummaries: stats, states });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          // fail-fast：配置文件损坏时直接 500，绝不回写，避免把整个配置清成只剩 social
          const file = readConfigObject(configFile);
          const merged = { ...(file.social ?? {}), ...body };
          // 新分句逻辑不再使用旧字段：保存时统一清理，避免旧配置残留
          for (const k of ['burstProbability', 'burstMaxMessages', 'followUpEnabled', 'followUpProbability', 'followUpDelayMinMs', 'followUpDelayMaxMs', 'followUpCooldownMs']) {
            delete merged[k];
          }
          for (const k of ['triggerProbability', 'activeCheckMinMs', 'activeCheckMaxMs', 'activeReplyDelayMinMs', 'activeReplyDelayMaxMs', 'activeDurationMinMs', 'activeDurationMaxMs', 'idleWindowMs', 'idleRetryProbability', 'idleRetryWaitMs', 'proactiveIdleThresholdMs', 'proactiveCheckMinMs', 'proactiveCheckMaxMs', 'proactiveProbability', 'maxReplyChars', 'contextWindow', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) {
              const n = Number(merged[k]);
              if (Number.isFinite(n) && n >= 0) merged[k] = n;
            }
          }
          // 分条间隔 clamp 到非负
          for (const k of ['burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapMinMs', 'longGapMaxMs']) {
            if (merged[k] !== undefined) merged[k] = Math.max(0, Number(merged[k]) || 0);
          }
          // 概率字段 clamp 到 0~1
          for (const k of ['triggerProbability', 'idleRetryProbability', 'proactiveProbability', 'skipProbability', 'surrenderProbability', 'longGapProbability']) {
            if (merged[k] !== undefined) merged[k] = Math.min(1, Math.max(0, Number(merged[k])));
          }
          // contextWindow 限制 1~100
          if (merged.contextWindow !== undefined) {
            merged.contextWindow = Math.min(100, Math.max(1, Math.round(Number(merged.contextWindow))));
          }
          // 布尔字段
          for (const k of ['activeDurationEnabled', 'proactiveEnabled', 'burstEnabled']) {
            if (merged[k] !== undefined) merged[k] = Boolean(merged[k]);
          }
          // 范围字段保证 min <= max
          for (const [minK, maxK] of [['activeCheckMinMs', 'activeCheckMaxMs'], ['activeReplyDelayMinMs', 'activeReplyDelayMaxMs'], ['activeDurationMinMs', 'activeDurationMaxMs'], ['proactiveCheckMinMs', 'proactiveCheckMaxMs'], ['burstIntervalMinMs', 'burstIntervalMaxMs'], ['longGapMinMs', 'longGapMaxMs']]) {
            if (merged[minK] !== undefined && merged[maxK] !== undefined && Number(merged[minK]) > Number(merged[maxK])) {
              [merged[minK], merged[maxK]] = [merged[maxK], merged[minK]];
            }
          }
          if (Object.prototype.hasOwnProperty.call(body, 'mustReplyKeywords')) {
            socialKeywordsExplicit = isExplicitKeywordConfig(body.mustReplyKeywords, EXAMPLE_MUST_REPLY_KEYWORDS);
          }
          if (Array.isArray(body.mustReplyKeywords)) merged.mustReplyKeywords = body.mustReplyKeywords.map(String);
          file.social = merged;
          writeConfigFile(file);
          cfg.social = { ...cfg.social, ...merged };
          log('控制台：社交配置已更新');
          sendJson({ ok: true, config: socialConfigForView() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/social/flush') {
          const body = await readBody();
          await flushSummaries(body.key || null);
          sendJson({ ok: true });
          return;
        }
        // ── 后台控制端引导：向指定会话的 DSH agent 投递提醒 ──────────────────
        if (req.method === 'POST' && url.pathname === '/api/console/notify-ai') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const message = String(body.message ?? '').trim();
          if (!key || !message) {
            sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0) {
            sendJson({ ok: false, error: 'id 无效' }, 400);
            return;
          }
          if (!modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: `该会话不在当前模式（${currentMode}）允许范围内` }, 403);
            return;
          }
          if (!state.sessions[key] && !allowed(kind, id, cfg)) {
            sendJson({ ok: false, error: '该会话不在白名单内，且尚未创建' }, 403);
            return;
          }
          if (!dshReady) {
            sendJson({ ok: false, error: 'DSH 当前不可用，请稍后再试' }, 503);
            return;
          }
          const isSimulationMode = currentMode === 'simulation';
          const roleState = readRoleState();
          const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
          // 仿真必须带会话令牌，否则 AI 调用任何 MCP 状态/发送工具都会被拒。
          let tokenLine = '';
          if (isSimulationMode) {
            const simState = getSimulationState(key);
            tokenLine = `【会话令牌】${simState.agentToken}（调用仿真状态/发送工具时请在参数中带上此令牌）\n\n`;
          }
          const promptText = `${roleLine}${tokenLine}【后台控制端提醒】（来自控制台/管理端，不是群友消息）\n${message}\n\n这是后台给你的引导或提醒，请据此调整你的行为。绝对不要复述、转发或原样发送这条后台提醒，也不要发送其中的会话令牌；它只用于你内部调整行为。${isSimulationMode ? '当前是群聊仿真模式：你的文本输出不会自动发送到 QQ；如果需要在群里发言，请使用发送工具（qq_send_message / qq_reply）。如果不需要发言，可以 qq_mark_read 或 qq_set_wake_config 收尾。' : '如果不需要在群里发言，请不要输出会发到 QQ 的内容。'}`;
          let sessionId = null;
          let popSilent = null;
          try {
            sessionId = await ensureSession(key);
            const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
            const arr = social.silentTurns.get(sessionId) ?? [];
            social.silentTurns.set(sessionId, [...arr, { id: silentId, ts: Date.now() }]);
            popSilent = () => {
              const list = social.silentTurns.get(sessionId) ?? [];
              const next = list.filter((x) => x.id !== silentId);
              if (next.length > 0) social.silentTurns.set(sessionId, next);
              else social.silentTurns.delete(sessionId);
            };
            const result = await deliverPrompt(key, promptText, { silent: true });
            if (result.ok) {
              log(`控制台：已向 ${key} 的 DSH 发送后台提醒`);
              appendActivity(`${key} 控制台后台提醒：${message.slice(0, 80)}`);
              sendJson({ ok: true, key, sessionId });
            } else {
              popSilent();
              sendJson({ ok: false, error: result.error || '投递失败' }, 500);
            }
          } catch (error) {
            if (popSilent) popSilent();
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 群聊仿真模式（simulation）内部 Agent API ─────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/simulation/config') {
          sendJson({ ok: true, config: simulationConfigForView() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/config') {
          const body = await readBody();
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          // current 必须是「当前**生效**的 simulation」，而不是文件里恰好写着的那一份。
          //
          // config.json 里没有 simulation 段（或该段不是普通对象）时，旧写法 current={} 会让下面所有
          // `current.xxx ?? 默认` 的兜底全部落空，并把只剩本次提交字段的段落盘。最危险的一处是工具开关
          // 归一化：`typeof merged.tools[k] !== 'boolean'` 时写的是 `current.tools?.[k] !== false` ——
          // current 为空 → undefined !== false → true，于是**一次控制台保存就把默认关闭的
          // setStickerRemark / sendVoice 静默打开**（它们默认 false 是有意的：一个是风险操作，
          // 一个是需要先准备语音库的强表达）。cfg.simulation 是「文件 + 默认值」深度合并后的运行时配置，
          // 用它兜底才和真正生效的设置一致（也就不会再出现"文件里没有 → 保存一次就变了"）。
          const fileSimulation = (file.simulation && typeof file.simulation === 'object' && !Array.isArray(file.simulation))
            ? file.simulation
            : null;
          const current = fileSimulation ?? ((cfg.simulation && typeof cfg.simulation === 'object') ? cfg.simulation : {});
          const merged = { ...current, ...body };
          // 子对象必须是非 null 对象；null/数组/基本类型会覆盖默认值导致工具开关被绕过，这里直接保留当前值。
          for (const sub of ['tools', 'wake', 'send', 'wait', 'proactive', 'sticker', 'feedback', 'context', 'activityControl']) {
            if (body[sub] !== undefined && (body[sub] === null || typeof body[sub] !== 'object' || Array.isArray(body[sub]))) {
              merged[sub] = current[sub] ?? {};
            }
          }
          if (merged.autoReplyCheckMs !== undefined) {
            const n = Number(merged.autoReplyCheckMs);
            merged.autoReplyCheckMs = Number.isFinite(n) ? Math.max(1000, Math.round(n)) : (current.autoReplyCheckMs ?? 30000);
          }
          // tools：只接受布尔开关
          const toolFlags = ['getPrompt', 'getUnread', 'getRecent', 'socialState', 'sendGroup', 'sendPrivate', 'reply', 'sendBurst', 'sendMessage', 'waitMessages', 'feedback', 'getMyRecent', 'getMessageDetail', 'getActiveMembers', 'setWakeConfig', 'markRead', 'memory', 'slangQuery', 'slangSubmit', 'getImages', 'getForwardMsg', 'sendPoke', 'listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'deleteSticker', 'getSelfImage', 'sendVoice', 'listImages', 'sendImage', 'saveImage', 'deleteImage', 'addReminder', 'listReminders', 'cancelReminder', 'weather', 'playGame'];
          if (body.tools && typeof body.tools === 'object') {
            merged.tools = { ...(current.tools ?? {}), ...body.tools };
            for (const k of toolFlags) {
              if (typeof merged.tools[k] !== 'boolean') merged.tools[k] = current.tools?.[k] !== false;
            }
          }
          // wake：数值与字符串数组归一化
          if (body.wake && typeof body.wake === 'object') {
            merged.wake = { ...(current.wake ?? {}), ...body.wake };
            for (const k of ['sleepMinMs', 'sleepMaxMs', 'recommendedSleepMinMs', 'recommendedSleepMaxMs', 'recommendedProbability', 'batchWindowMs', 'maxWakePerMinute', 'maxWakePerHour', 'noActionLimit', 'maxWakeConfigReminders', 'preSleepWaitMs']) {
              if (merged.wake[k] !== undefined) {
                const n = Number(merged.wake[k]);
                merged.wake[k] = Number.isFinite(n) ? n : current.wake?.[k] ?? 0;
                // 毫秒/次数类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'recommendedProbability') merged.wake[k] = Math.max(0, Math.round(merged.wake[k]));
              }
            }
            if (merged.wake.recommendedProbability !== undefined) merged.wake.recommendedProbability = Math.min(1, Math.max(0, Number(merged.wake.recommendedProbability) || 0));
            if (merged.wake.preSleepWaitEnabled !== undefined) merged.wake.preSleepWaitEnabled = merged.wake.preSleepWaitEnabled === true;
            if (merged.wake.recommendedDefaultInfinite !== undefined) merged.wake.recommendedDefaultInfinite = merged.wake.recommendedDefaultInfinite === true;
            if (merged.wake.recommendedPoke !== undefined) merged.wake.recommendedPoke = merged.wake.recommendedPoke === true;
            if (Object.prototype.hasOwnProperty.call(body.wake, 'recommendedKeywords')) {
              wakeKeywordsExplicit = isExplicitKeywordConfig(body.wake.recommendedKeywords, EXAMPLE_WAKE_KEYWORDS);
            }
            if (merged.wake.recommendedKeywords !== undefined) {
              merged.wake.recommendedKeywords = (Array.isArray(merged.wake.recommendedKeywords) ? merged.wake.recommendedKeywords : String(merged.wake.recommendedKeywords).split(/[,，\s]+/)).map(String).filter(Boolean);
            }
            if (merged.wake.defaultMode !== 'active') merged.wake.defaultMode = 'diving';
            if (merged.wake.recommendedHint !== undefined) merged.wake.recommendedHint = String(merged.wake.recommendedHint ?? '');
          }
          // send：数值归一化
          if (body.send && typeof body.send === 'object') {
            merged.send = { ...(current.send ?? {}), ...body.send };
            for (const k of ['burstMaxMessages', 'burstIntervalMinMs', 'burstIntervalMaxMs', 'longGapProbability', 'longGapMinMs', 'longGapMaxMs', 'maxSendPerMinute', 'maxSendPerHour', 'maxMessageChars', 'maxGapMs', 'gapBaseMs', 'gapPerCharMs']) {
              if (merged.send[k] !== undefined) {
                const n = Number(merged.send[k]);
                merged.send[k] = Number.isFinite(n) ? n : current.send?.[k] ?? 0;
                // 次数/毫秒/字符数统一非负取整；概率字段单独 clamp。
                if (k !== 'longGapProbability') merged.send[k] = Math.max(0, Math.round(merged.send[k]));
              }
            }
            if (merged.send.longGapProbability !== undefined) merged.send.longGapProbability = Math.min(1, Math.max(0, Number(merged.send.longGapProbability) || 0));
            if (merged.send.burstEnabled !== undefined) merged.send.burstEnabled = merged.send.burstEnabled === true;
            if (merged.send.recommendedHint !== undefined) merged.send.recommendedHint = String(merged.send.recommendedHint ?? '');
          }
          // wait：数值归一化
          if (body.wait && typeof body.wait === 'object') {
            merged.wait = { ...(current.wait ?? {}), ...body.wait };
            for (const k of ['defaultMs', 'minMs', 'maxMs', 'defaultQuietMs', 'minQuietAfterNewMs']) {
              if (merged.wait[k] !== undefined) {
                const n = Number(merged.wait[k]);
                merged.wait[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.wait?.[k] ?? 5000;
              }
            }
          }
          // proactive：主动机会参数
          if (body.proactive && typeof body.proactive === 'object') {
            merged.proactive = { ...(current.proactive ?? {}), ...body.proactive };
            for (const k of ['checkIntervalMinMs', 'checkIntervalMaxMs', 'idleThresholdMs', 'probability']) {
              if (merged.proactive[k] !== undefined) {
                const n = Number(merged.proactive[k]);
                merged.proactive[k] = Number.isFinite(n) ? n : current.proactive?.[k] ?? 0;
                // 毫秒类字段统一非负取整；概率字段单独 clamp。
                if (k !== 'probability') merged.proactive[k] = Math.max(0, Math.round(merged.proactive[k]));
              }
            }
            if (merged.proactive.enabled !== undefined) merged.proactive.enabled = merged.proactive.enabled === true;
            if (merged.proactive.probability !== undefined) merged.proactive.probability = Math.min(1, Math.max(0, Number(merged.proactive.probability) || 0));
          }
          // sticker：表情包体系参数归一化
          if (body.sticker && typeof body.sticker === 'object') {
            merged.sticker = { ...(current.sticker ?? {}), ...body.sticker };
            if (merged.sticker.enabled !== undefined) merged.sticker.enabled = merged.sticker.enabled === true;
            for (const k of ['syncTtlMs', 'maxListCount', 'promptMaxStickers']) {
              if (merged.sticker[k] !== undefined) {
                const n = Number(merged.sticker[k]);
                merged.sticker[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.[k] ?? 0;
              }
            }
            if (merged.sticker.maxListCount !== undefined) merged.sticker.maxListCount = Math.min(500, Math.max(1, merged.sticker.maxListCount));
            if (merged.sticker.promptMaxStickers !== undefined) merged.sticker.promptMaxStickers = Math.min(30, Math.max(1, merged.sticker.promptMaxStickers));
            if (merged.sticker.includeInPrompt !== undefined) merged.sticker.includeInPrompt = merged.sticker.includeInPrompt === true;
            if (body.sticker.collect && typeof body.sticker.collect === 'object') {
              merged.sticker.collect = { ...(current.sticker?.collect ?? {}), ...body.sticker.collect };
              if (merged.sticker.collect.enabled !== undefined) merged.sticker.collect.enabled = merged.sticker.collect.enabled === true;
              for (const k of ['maxPerMinute', 'maxPerHour', 'maxRemarkChars']) {
                if (merged.sticker.collect[k] !== undefined) {
                  const n = Number(merged.sticker.collect[k]);
                  merged.sticker.collect[k] = Number.isFinite(n) ? Math.max(0, Math.round(n)) : current.sticker?.collect?.[k] ?? 0;
                }
              }
            }
          }
          // feedback：数值/布尔归一化
          if (body.feedback && typeof body.feedback === 'object') {
            merged.feedback = { ...(current.feedback ?? {}), ...body.feedback };
            if (merged.feedback.maxLength !== undefined) {
              const n = Number(merged.feedback.maxLength);
              merged.feedback.maxLength = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.feedback?.maxLength ?? 500;
            }
            if (merged.feedback.notifyOwnerOnError !== undefined) merged.feedback.notifyOwnerOnError = merged.feedback.notifyOwnerOnError === true;
          }
          // context：数值归一化
          if (body.context && typeof body.context === 'object') {
            merged.context = { ...(current.context ?? {}), ...body.context };
            for (const k of ['recentLimit', 'unreadLimit', 'contextWindow']) {
              if (merged.context[k] !== undefined) {
                const n = Number(merged.context[k]);
                merged.context[k] = Number.isFinite(n) ? Math.max(1, Math.round(n)) : current.context?.[k] ?? 20;
              }
            }
            for (const [name, fallback, min, max] of [['wakeMessageLimit', 12, 1, 100], ['wakeRecentLimit', 4, 0, 20], ['wakeMaxChars', 6000, 500, 20000]]) {
              const n = Number(merged.context[name] ?? fallback);
              merged.context[name] = Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
            }
            if (merged.context.inlineWakeMessages !== undefined) merged.context.inlineWakeMessages = merged.context.inlineWakeMessages === true;
          }
          // activityControl：深潜开关只接受布尔
          if (body.activityControl && typeof body.activityControl === 'object') {
            merged.activityControl = { ...(current.activityControl ?? {}), ...body.activityControl };
            merged.activityControl.deepDive = merged.activityControl.deepDive === true;
          }
          if (merged.enabled !== undefined) merged.enabled = merged.enabled === true;
          if (merged.provideRecommendations !== undefined) merged.provideRecommendations = merged.provideRecommendations === true;
          if (merged.agentPreset !== undefined) merged.agentPreset = String(merged.agentPreset ?? '');
          file.simulation = merged;
          writeConfigFile(file);
          cfg.simulation = { ...(cfg.simulation ?? {}), ...merged };
          // 旧页面改配置不走 applyConsoleConfigValues，这里补一次取消，保证关掉后不再冒泡。
          if (cfg.simulation?.enabled === false || cfg.simulation?.proactive?.enabled === false) {
            cancelAllProactiveChecks('群聊配置更新');
          }
          // 仅当“会影响默认唤醒配置”的字段变化时，才同步到仍使用默认配置的现有会话。
          // 避免只改发送/等待/工具开关时，意外重置正在等待的潜水/唤醒计划。
          const WAKE_DEFAULT_KEYS = [
            'defaultMode', 'recommendedDefaultInfinite',
            'recommendedSleepMinMs', 'recommendedSleepMaxMs',
            'recommendedProbability', 'recommendedKeywords',
            'recommendedAtMention', 'recommendedNameMention', 'recommendedQuestion', 'recommendedPoke',
            'sleepMinMs', 'sleepMaxMs', 'batchWindowMs'
          ];
          const wakeDefaultChanged = body.wake && typeof body.wake === 'object' &&
            WAKE_DEFAULT_KEYS.some((k) => Object.prototype.hasOwnProperty.call(body.wake, k));
          if (wakeDefaultChanged) refreshAllDefaultWakeConfigs();
          // 全局活跃/深潜切换也要立刻作用到现有群会话的定时器。
          const activityChanged = (body.wake && typeof body.wake === 'object' && Object.prototype.hasOwnProperty.call(body.wake, 'defaultMode'))
            || (body.activityControl && typeof body.activityControl === 'object' && Object.prototype.hasOwnProperty.call(body.activityControl, 'deepDive'));
          if (activityChanged) resyncActivityControl();
          log('控制台：群聊剧场配置已更新');
          sendJson({ ok: true, config: simulationConfigForView() });
          return;
        }
        // ── 群风格覆盖：控制台专用，单条增删改，保存即热更新 ──────────────
        // 不走 /api/simulation/config 的整体覆盖：那里的 groupProfiles 是整对象替换，
        // 从 UI 只改一个群时很容易把其它群的配置一起抹掉。
        if (req.method === 'GET' && url.pathname === '/api/simulation/group-profiles') {
          const profiles = (cfg.simulation?.groupProfiles && typeof cfg.simulation.groupProfiles === 'object' && !Array.isArray(cfg.simulation.groupProfiles))
            ? cfg.simulation.groupProfiles
            : {};
          sendJson({ ok: true, profiles, maxStyleChars: 8000 });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/group-profile') {
          const body = await readBody();
          const key = canonicalSimulationKey(String(body.key ?? '').trim());
          if (!key) { sendJson({ ok: false, error: '会话 key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const deleteIt = body.delete === true;
          const configFile = path.join(ROOT, 'config.json');
          const file = readConfigObject(configFile);
          const currentSimulation = (file.simulation && typeof file.simulation === 'object' && !Array.isArray(file.simulation)) ? file.simulation : {};
          const currentProfiles = (currentSimulation.groupProfiles && typeof currentSimulation.groupProfiles === 'object' && !Array.isArray(currentSimulation.groupProfiles))
            ? currentSimulation.groupProfiles
            : {};
          const profiles = {};
          for (const [k, v] of Object.entries(currentProfiles)) {
            if (v && typeof v === 'object' && !Array.isArray(v)) profiles[k] = { ...v };
          }
          let saved = null;
          if (deleteIt) {
            delete profiles[key];
          } else {
            const label = String(body.label ?? '').trim().slice(0, 60);
            const style = String(body.style ?? '').trim();
            if (style.length > 8000) { sendJson({ ok: false, error: '群风格不能超过 8000 字符' }, 400); return; }
            saved = { label, proactive: body.proactive !== false, style };
            profiles[key] = saved;
          }
          file.simulation = { ...currentSimulation, groupProfiles: profiles };
          writeConfigFile(file);
          cfg.simulation = { ...(cfg.simulation ?? {}), groupProfiles: profiles };
          // 关掉/删除时立刻停掉已有的主动机会定时器；打开时补排一个。
          const st = simulation.conversations.get(key);
          if (st?.proactiveTimer) {
            clearTimeout(st.proactiveTimer);
            st.proactiveTimer = null;
          }
          if (!deleteIt && saved && saved.proactive !== false) scheduleProactiveCheck(key);
          log(`控制台：群风格${deleteIt ? '已删除' : '已更新'} ${key}（${saved?.label || '无标签'}，${saved?.style?.length ?? 0} 字符）`);
          sendJson({ ok: true, key, deleted: deleteIt, profile: saved, profiles });
          return;
        }
        // ── 生活提醒 ──────────────────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/simulation/reminder/add') {
          const body = await readBody();
          const key = canonicalSimulationKey(String(body.key ?? '').trim());
          if (!key) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const authError = checkAgentTool(req, key, 'addReminder');
          if (authError) { sendJson({ ok: false, error: authError }, 403); return; }
          if (!reminderStoreWritable) { sendJson({ ok: false, error: '提醒文件处于只读降级状态，暂时不能新增' }, 503); return; }
          if (!reminderAllowed(key)) {
            sendJson({ ok: false, error: '提醒只在主人私聊或家人群可用（可在 simulation.reminders.allowedKeys 扩展）' }, 403);
            return;
          }
          const maxPerDay = Math.max(1, Number(cfg.simulation?.reminders?.maxPerDayPerKey) || 5);
          const today = localDayKey();
          const todayCount = reminderStore.reminders.filter((r) => r.key === key && r.status === 'pending'
            && new Date(r.createdAt).toLocaleDateString('en-CA', { timeZone: 'Asia/Shanghai' }) === today).length;
          if (todayCount >= maxPerDay) {
            sendJson({ ok: false, error: `今天该会话的提醒名额已用完（最多 ${maxPerDay} 条）` }, 429);
            return;
          }
          try {
            const item = addReminder(reminderStore, {
              key,
              text: body.text,
              dueAt: body.dueAt,
              note: body.note,
              createdBy: body.createdBy || 'ai'
            });
            saveRemindersSafe();
            if (jobQueue) {
              jobQueue.enqueue({
                type: 'reminder.due',
                key,
                payload: { reminderId: item.id },
                dedupeKey: `reminder:${item.id}`,
                runAfter: item.dueAt,
                maxAttempts: 3
              });
            }
            log(`[reminder] 新增 ${item.id} ${key} due=${new Date(item.dueAt).toLocaleString('zh-CN', { hour12: false })}`);
            sendJson({ ok: true, reminder: item });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/reminders') {
          const key = canonicalSimulationKey(String(url.searchParams.get('key') ?? '').trim());
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const authError = checkAgentTool(req, key, 'listReminders');
          if (authError) { sendJson({ ok: false, error: authError }, 403); return; }
          sendJson({ ok: true, key, reminders: listReminders(reminderStore, key) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/reminder/cancel') {
          const body = await readBody();
          const key = canonicalSimulationKey(String(body.key ?? '').trim());
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const authError = checkAgentTool(req, key, 'cancelReminder');
          if (authError) { sendJson({ ok: false, error: authError }, 403); return; }
          if (!reminderStoreWritable) { sendJson({ ok: false, error: '提醒文件处于只读降级状态，暂时不能取消' }, 503); return; }
          const item = cancelReminder(reminderStore, key, body.id);
          if (!item) { sendJson({ ok: false, error: '没有找到这条待发送提醒' }, 404); return; }
          saveRemindersSafe();
          if (jobQueue) jobQueue.cancel(`reminder:${item.id}`);
          log(`[reminder] 取消 ${item.id} ${key}`);
          sendJson({ ok: true, reminder: item });
          return;
        }

        // ── 天气 ──────────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/simulation/weather') {
          const key = canonicalSimulationKey(String(url.searchParams.get('key') ?? '').trim());
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const authError = checkAgentTool(req, key, 'weather');
          if (authError) { sendJson({ ok: false, error: authError }, 403); return; }
          if (cfg.simulation?.weather?.enabled === false) { sendJson({ ok: false, error: '天气功能已关闭' }, 403); return; }
          const city = String(url.searchParams.get('city') ?? '').trim() || String(cfg.simulation?.weather?.defaultCity || '').trim();
          if (!city) { sendJson({ ok: false, error: '请提供城市名，例如 city=北京（也可配置 simulation.weather.defaultCity）' }, 400); return; }
          try {
            const data = await getWeather(city, { timeoutMs: Number(cfg.simulation?.weather?.timeoutMs) || 15000 });
            sendJson(data);
          } catch (error) {
            sendJson({ ok: false, error: `天气查询失败：${error?.message ?? error}` }, 502);
          }
          return;
        }

        // ── 群内小游戏 / 今日运势 ─────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/simulation/game') {
          const body = await readBody();
          const key = canonicalSimulationKey(String(body.key ?? '').trim());
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const authError = checkAgentTool(req, key, 'playGame');
          if (authError) { sendJson({ ok: false, error: authError }, 403); return; }
          const last = gameCooldowns.get(key) || 0;
          if (Date.now() - last < 2000) { sendJson({ ok: false, error: '玩得太快了，缓两秒' }, 429); return; }
          gameCooldowns.set(key, Date.now());
          const game = String(body.game || '').toLowerCase();
          if (game === 'rps') {
            const raw = String(body.choice || '').trim().toLowerCase();
            const map = { rock: 'rock', paper: 'paper', scissors: 'scissors', 石头: 'rock', 剪刀: 'scissors', 布: 'paper' };
            const choice = map[raw];
            if (!choice) { sendJson({ ok: false, error: 'choice 必须是 石头/剪刀/布（或 rock/paper/scissors）' }, 400); return; }
            const bot = ['rock', 'paper', 'scissors'][randInt(0, 2)];
            const win = { rock: 'scissors', paper: 'rock', scissors: 'paper' };
            const result = choice === bot ? 'draw' : win[choice] === bot ? 'win' : 'lose';
            sendJson({ ok: true, game, user: choice, bot, result });
            return;
          }
          if (game === 'dice') {
            const sides = Math.min(100, Math.max(2, Number(body.sides) || 6));
            sendJson({ ok: true, game, sides, value: randInt(1, sides) });
            return;
          }
          if (game === 'fortune') {
            const day = localDayKey();
            const h = crypto.createHash('sha1').update(`${key}|${day}|fortune`).digest();
            const luck = ['大吉', '中吉', '小吉', '平', '小凶'][h[0] % 5];
            const color = ['蓝色', '白色', '黄色', '绿色', '粉色'][h[1] % 5];
            const number = (h[2] % 99) + 1;
            const advice = [
              '宜摸鱼，忌硬撑',
              '宜主动开口，忌已读不回',
              '宜吃点好的，忌空腹生气',
              '宜早点睡，忌半夜翻旧账',
              '宜夸人，忌阴阳怪气'
            ][h[3] % 5];
            const persona = innerLife?.personaInfo?.()?.state || {};
            sendJson({
              ok: true,
              game,
              date: day,
              luck,
              color,
              number,
              advice,
              mood: persona?.mood?.label || '',
              energy: Number.isFinite(Number(persona?.energy)) ? Math.round(Number(persona.energy) * 100) : null
            });
            return;
          }
          sendJson({ ok: false, error: 'game 必须是 rps / dice / fortune' }, 400);
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/simulation/activity') {
          sendJson({ ok: true, paused: simulation.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/activity') {
          const body = await readBody();
          const paused = body.paused === true;
          simulation.paused = paused;
          if (paused) {
            clearAllSimulationTimers();
            log('控制台：仿真 AI 已暂停（唤醒/等待任务已停止）');
          } else {
            log('控制台：仿真 AI 已恢复');
            for (const key of simulation.conversations.keys()) {
            setupSleepTimer(key);
            scheduleProactiveCheck(key);
          }
          }
          saveSimulationState();
          sendJson({ ok: true, paused: simulation.paused });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/reset') {
          sessionEpoch++;
          sessionPromises.clear();
          clearAllSimulationTimers();
          drainAllPromptQueues('仿真状态已重置');
          for (const key of [...simulation.conversations.keys()]) {
            // 与 retireSession / session-reset / workspace-reset 一致：先把本地状态收干净，
            // 再让 DSH 停下这个会话的活。少了后者，DSH 会继续跑完在途/排队的 turn。
            const sid = disposeConversation(key, { scope: 'reset', save: false });
            if (sid) stopRetiredSessionWork(sid, key);
          }
          saveState();
          // disposeConversation 覆盖的是「有会话记录的 key」；下面这几个是全局兜底。
          pendingWakeKeys.clear();
          clearAllPendingWakeLeases();
          wakeConfigUpdatedKeys.clear();
          markReadCalledKeys.clear();
          wakeConfigMissCount.clear();
          simulation.paused = false;
          try { atomicWriteJson(SIMULATION_FILE, { conversations: {} }); } catch (error) { log('重置仿真状态：写空状态文件失败:', error?.message ?? error); }
          log('控制台：仿真 AI 状态已重置（会话、定时器、唤醒配置已清空，工具日志保留）');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/state') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('socialState')) { sendJson({ ok: false, error: '工具未启用：qq_social_state' }, 403); return; }
          const st = getSimulationState(key);
          sendJson({
            ok: true,
            key,
            wakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafety(st.wakeConfig),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            lastWakeReason: st.lastWakeReason,
            lastAiReplyAt: st.lastAiReplyAt
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/chats') {
          const token = String(req.headers['x-agent-token'] || url.searchParams.get('token') || '').trim();
          if (req.headers['x-agent-call'] !== undefined) {
            const access = canReadAcrossSessions(token, { route: url.pathname });
            if (!access.ok) { sendJson({ ok: false, error: access.error }, access.status); return; }
          }
          const { groups, privates } = listChatTargets();
          sendJson({ ok: true, groups, privates });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/chat-context') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(40, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const token = String(req.headers['x-agent-token'] || url.searchParams.get('token') || '').trim();
          if (!/^(group|private):\d+$/.test(key)) { sendJson({ ok: false, error: 'key 格式必须是 group:群号 或 private:QQ号' }, 400); return; }
          if (req.headers['x-agent-call'] !== undefined) {
            const access = canActOn(key, token, { crossSession: true, route: url.pathname });
            if (!access.ok) { sendJson({ ok: false, error: access.error }, access.status); return; }
          }
          if (!isSessionAllowedInCurrentMode(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          const st = getSimulationState(key);
          const messages = (Array.isArray(st.recentMessages) ? st.recentMessages : []).slice(-limit).map((m) => ({
            messageId: m?.messageId ?? null,
            sender: String(m?.sender || ''),
            isSelf: m?.isSelf === true,
            time: Number(m?.time) || 0,
            kind: String(m?.kind || ''),
            text: String(m?.plain || m?.text || '').slice(0, 300)
          }));
          sendJson({
            ok: true,
            key,
            name: conversationDisplayName(key) || key,
            unread: Array.isArray(st.unread) ? st.unread.length : 0,
            lastIncomingAt: Number(st.lastIncomingAt) || 0,
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-5).map((t) => String(t?.text || '').slice(0, 120)) : [],
            messages
          });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/prompt') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('getPrompt')) { sendJson({ ok: false, error: '工具未启用：qq_get_prompt' }, 403); return; }
          const st = getSimulationState(key);
          // 让 prompt 里的表情摘要尽量新鲜：按 TTL 同步一次 QQ 收藏表情（失败不阻塞）。
          if (cfg.simulation?.sticker?.enabled !== false) {
            try { await syncStickerLibrary(false); } catch {}
          }
          const roleState = readRoleState();
          const toolMap = {
            getPrompt: 'qq_get_prompt',
            getUnread: 'qq_get_unread_messages',
            getRecent: 'qq_get_recent_messages',
            socialState: 'qq_social_state',
            sendGroup: 'qq_send_group_message',
            sendPrivate: 'qq_send_private_message',
            reply: 'qq_reply',
            sendBurst: 'qq_send_burst',
            sendMessage: 'qq_send_message',
            waitMessages: 'qq_wait_for_messages',
            feedback: 'qq_report_feedback',
            getMyRecent: 'qq_get_my_recent_messages',
            getMessageDetail: 'qq_get_message_detail',
            getActiveMembers: 'qq_get_active_members',
            setWakeConfig: 'qq_set_wake_config',
            markRead: 'qq_mark_read',
            memory: 'qq_memory_append / qq_memory_query / qq_memory_remove / qq_memory_clear',
            slangQuery: 'qq_slang_query',
            slangSubmit: 'qq_slang_submit',
            getImages: 'qq_get_message_images',
            getForwardMsg: 'qq_get_forward_msg',
            sendPoke: 'qq_send_poke',
            listStickers: 'qq_list_stickers',
            getStickerImage: 'qq_get_sticker_image',
            sendSticker: 'qq_send_sticker',
            setStickerRemark: 'qq_set_sticker_remark',
            stickerNote: 'qq_sticker_note',
            collectSticker: 'qq_collect_sticker',
            getSelfImage: 'qq_get_self_image',
            sendVoice: 'qq_send_voice / qq_list_voices',
            listImages: 'qq_list_images',
            sendImage: 'qq_send_image',
            saveImage: 'qq_save_image',
            addReminder: 'qq_add_reminder',
            listReminders: 'qq_list_reminders',
            cancelReminder: 'qq_cancel_reminder',
            weather: 'qq_weather',
            playGame: 'qq_play_game'
          };
          const tools = cfg.simulation?.tools ?? {};
          const stickerToolFlags = new Set(['listStickers', 'getStickerImage', 'sendSticker', 'setStickerRemark', 'stickerNote', 'collectSticker', 'deleteSticker', 'deleteImage']);
          const enabledTools = [];
          for (const [flag, name] of Object.entries(toolMap)) {
            if (tools[flag] !== false && !(stickerToolFlags.has(flag) && !stickerEnabled())) enabledTools.push(name);
          }
          sendJson({
            ok: true,
            key,
            time: new Date().toISOString(),
            // 机器人自己的身份：agent 需要它才能把「@樰」对到自己身上（issue #29）。
            self: {
              nickname: selfDisplayName || null,
              userId: selfUserId || null,
              line: selfIdentityText().trim() || null
            },
            role: { name: roleState.role ?? null, hint: currentMode === 'simulation' ? currentSimulationRoleHint() : currentRoleHint() },
            persona: innerLife?.personaInfo?.() ?? null,
            groupProfile: cfg.simulation?.groupProfiles?.[key] ?? null,
            recommended: cfg.simulation?.provideRecommendations === false ? null : roleAwareRecommendations({
              wake: cfg.simulation?.wake ?? {},
              send: cfg.simulation?.send ?? {},
              wait: cfg.simulation?.wait ?? {},
              proactive: cfg.simulation?.proactive ?? {}
            }, { custom: isCustomRoleName(roleState.role), roleName: String(roleState.role || '').trim(), fallbackKeywords: roleDefaultKeywords() }),
            enabledTools,
            capabilities: {
              summary: '群聊/私聊、原图识图与接梗、原生收藏表情、图片库、中文语音、内心生活与QQ空间、提醒、天气、S16/LPL赛果订阅、猜拳/骰子/今日运势、控制台与实时监控页',
              scope: '提醒默认只在主人私聊和家人群；通用搜索没有 DeepSeek Key 时用 Bing；QQ 表情回应/改群名片等原生动作当前网关不支持。被问会什么时像群友一样挑重点说，不要念工具名、路径或模型配置。'
            },
            replyTiming: buildReplyTiming(st),
            unreadCount: st.unread.length,
            recentCount: st.recentMessages.length,
            currentWakeConfig: st.wakeConfig,
            wakeSafety: computeWakeSafety(st.wakeConfig),
            memory: formatMemory(st),
            participation: formatParticipation(st),
            slang: {
              enabled: cfg.slang?.enabled !== false,
              entries: confirmedSlangList(),
              block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 12)
            },
            stickers: {
              enabled: cfg.simulation?.sticker?.enabled !== false,
              total: stickerEntries.length,
              context: cfg.simulation?.sticker?.includeInPrompt !== false ? buildStickerContext(stickerEntries, cfg.simulation?.sticker?.promptMaxStickers ?? 12) : '',
              strategy: cfg.simulation?.sticker?.includeInPrompt !== false ? buildStickerStrategyHint() : '',
              cadence: {
                lastStickerAt: Number(st.lastStickerAt) || 0,
                textSendsSinceSticker: Number(st.textSendsSinceSticker) || 0
              }
            },
            // 语音库摘要：让 AI 一开始就知道有哪些语音可发（真发之前用 qq_list_voices 看详情）。
            voices: cfg.simulation?.voice?.enabled === false ? { enabled: false } : {
              enabled: true,
              total: voiceLibrary().length,
              names: voiceLibrary().slice(0, 12).map((v) => v.name),
              maxSeconds: voiceCfg().maxSeconds,
              lastVoiceAt: Number(st.lastVoiceAt) || 0,
              hint: '可用 qq_list_voices 查看语音库，再用 qq_send_voice 把其中一个当语音发出去'
            },
            images: imageEnabled() ? {
              enabled: true,
              total: imageEntries.length,
              names: imageEntries.slice(0, 12).map((e) => e.name),
              context: cfg.simulation?.imageLibrary?.includeInPrompt !== false
                ? buildImageContext(imageEntries, { max: cfg.simulation?.imageLibrary?.promptMaxImages ?? 8, recentText: recentTextForImageContext(st) })
                : '',
              strategy: cfg.simulation?.imageLibrary?.includeInPrompt !== false ? buildImageStrategyHint() : '',
              cadence: {
                lastImageAt: Number(st.lastImageAt) || 0,
                textSendsSinceImage: Number(st.textSendsSinceImage) || 0
              },
              hint: '用 qq_list_images 搜索/查看图库；qq_send_image 把图当图片发出去；收到的图或网图可以用 qq_save_image 存进图库'
            } : { enabled: false },
            esports: esportsFeed ? {
              updatedAt: esportsFeed.updatedAt,
              title: esportsFeed.summaryTitle,
              url: esportsFeed.summaryUrl,
              summary: String(esportsFeed.summary || '').slice(0, 800),
              items: esportsFeed.items.slice(0, 8)
            } : null
          });
          return;
        }
        // 只读预览：按当前配置拼一次唤醒提示，但不投递、不写入 roleCardVersion。
        // 用于控制台/排查“为什么这个群还是旧人格、为什么没看到赛果”。
        if (req.method === 'GET' && url.pathname === '/api/simulation/wake-preview') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const reason = String(url.searchParams.get('reason') ?? 'preview').slice(0, 40) || 'preview';
          try {
            const prompt = buildWakePrompt(canonicalSimulationKey(key) || key, reason, { preview: true });
            sendJson({ ok: true, key: canonicalSimulationKey(key) || key, reason, chars: prompt.length, prompt });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/unread') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 30));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const unreadAccess = req.headers['x-agent-token'] ? canActOn(key, req.headers['x-agent-token'], { crossSession: true, route: url.pathname }) : null;
          if (unreadAccess && !unreadAccess.ok) { sendJson({ ok: false, error: unreadAccess.error }, unreadAccess.status); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('getUnread')) { sendJson({ ok: false, error: '工具未启用：qq_get_unread_messages' }, 403); return; }
          const afterRaw = url.searchParams.get('afterSeq');
          const afterSeq = afterRaw === null ? null : Number(afterRaw);
          if (afterRaw !== null && (!/^\d+$/.test(afterRaw) || !Number.isSafeInteger(afterSeq) || afterSeq < 0)) {
            sendJson({ ok: false, error: 'afterSeq 必须是非负安全整数；从最早未读开始请传 0' }, 400);
            return;
          }
          const st = getSimulationState(key);
          // Preserve the old tail read by default; cursor paging lets a backlog
          // larger than one response be read completely, even outside recent.
          const messages = afterSeq === null ? st.unread.slice(-limit)
            : st.unread.filter((m) => Number.isSafeInteger(m.seq) && m.seq > afterSeq).slice(0, limit);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessages(st, messages) : computeReadThroughSeq(st);
          sendJson({ ok: true, key, unreadCount: st.unread.length, messages, readThroughSeq });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const offset = Math.max(0, Number(url.searchParams.get('offset')) || 0);
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const recentAccess = req.headers['x-agent-token'] ? canActOn(key, req.headers['x-agent-token'], { crossSession: true, route: url.pathname }) : null;
          if (recentAccess && !recentAccess.ok) { sendJson({ ok: false, error: recentAccess.error }, recentAccess.status); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('getRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_recent_messages' }, 403); return; }
          const st = getSimulationState(key);
          const start = Math.max(0, st.recentMessages.length - offset - limit);
          const end = Math.max(0, st.recentMessages.length - offset);
          const messages = st.recentMessages.slice(start, end);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessages(st, messages) : computeReadThroughSeq(st);
          sendJson({ ok: true, key, messages, readThroughSeq });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/mark-read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('markRead')) { sendJson({ ok: false, error: '工具未启用：qq_mark_read' }, 403); return; }
          const st = getSimulationState(key);
          // 注意：不带 throughSeq 的调用会清空全部未读，这是**有意保留的兼容语义**
          // （旧 preset 与「没有水位」的收尾调用；见 acknowledgeMessages 的注释与
          // test-token-economy 的 legacy 用例）。当前 preset 会明确要求带上 readThroughSeq 水位。
          const throughSeq = requestedReadThroughSeq(st, body, !!req.headers['x-agent-token']);
          // 如果当前已经是“潜水”唤醒配置，且最近还有对话/刚被唤醒，不允许用 mark_read 直接回到潜水；
          // 必须先等够沉睡前观察窗口，避免“聊两句又去潜水”。
          if (isSleepingConfig(st.wakeConfig) && preSleepWaitBlocked(st)) {
            const preSleepMs = Math.max(0, Number(cfg.simulation?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能通过 qq_mark_read 直接回到潜水：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接收尾沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeMessages(st, throughSeq);
          st.lastActionAt = Date.now();
          st.wakeConfig.noActionCount = 0;
          // 防止“有限潜水被 timeout 唤醒后 sleepUntil 被清空、又 mark_read 收尾”导致无定时器无触发条件的静默态。
          if (!st.wakeConfig.infinite && !st.wakeConfig.sleepUntil) {
            st.wakeConfig.infinite = true;
          }
          ensureWakeable(st, { key });
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'mark_read';
          markReadCalledKeys.add(key);
          saveSimulationState();
          log(`[simulation] 控制台/工具标记 ${key} 未读已读：${markedCount} 条，已确认下一次唤醒配置`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: computeReadThroughSeq(st), wakeGuaranteed: computeWakeSafety(st.wakeConfig).guaranteed, wakeSafety: computeWakeSafety(st.wakeConfig), wakeConfig: st.wakeConfig });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/wake-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('setWakeConfig')) { sendJson({ ok: false, error: '工具未启用：qq_set_wake_config' }, 403); return; }
          const st = getSimulationState(key);
          const throughSeq = requestedReadThroughSeq(st, body, !!req.headers['x-agent-token']);
          // Preserve the deployed behavior: with markRead disabled, update wake configuration only.
          const acknowledgeOnClose = throughSeq !== null && simulationToolEnabled('markRead');
          const input = body.config && typeof body.config === 'object' && !Array.isArray(body.config) ? body.config : {};
          const current = st.wakeConfig;
          const inputTriggers = input.triggers && typeof input.triggers === 'object' && !Array.isArray(input.triggers) ? input.triggers : {};
          const normalizeTriggerBool = (name, fallback) => {
            if (name in inputTriggers) return inputTriggers[name] === true;
            return fallback;
          };
          const rawKeywords = inputTriggers.keywords;
          const nextKeywords = rawKeywords !== undefined
            ? (Array.isArray(rawKeywords)
                ? rawKeywords.map((k) => String(k ?? '').trim()).filter(Boolean).slice(0, 50).map((k) => k.slice(0, 100))
                : [])
            : (Array.isArray(current.triggers.keywords) ? current.triggers.keywords.slice(0, 50).map((k) => String(k).slice(0, 100)) : []);
          const next = {
            ...current,
            mode: input.mode === 'active' ? 'active' : input.mode === 'diving' ? 'diving' : current.mode,
            infinite: typeof input.infinite === 'boolean' ? input.infinite : current.infinite,
            sleepUntil: current.sleepUntil,
            triggers: {
              // 只带已知字段（见 WAKE_TRIGGER_KEYS 的说明）；未知键一律丢弃。
              ...pickWakeTriggers(inputTriggers, current.triggers),
              atMention: normalizeTriggerBool('atMention', current.triggers.atMention === true),
              nameMention: normalizeTriggerBool('nameMention', current.triggers.nameMention === true),
              question: normalizeTriggerBool('question', current.triggers.question === true),
              anyMessage: normalizeTriggerBool('anyMessage', current.triggers.anyMessage === true),
              poke: normalizeTriggerBool('poke', current.triggers.poke === true),
              keywords: nextKeywords
            },
            batchWindowMs: Number.isFinite(Number(input.batchWindowMs)) && Number(input.batchWindowMs) >= 1000
              ? Math.min(3600000, Math.round(Number(input.batchWindowMs)))
              : current.batchWindowMs
          };
          // 从 active 切回 diving 时，若 AI 没显式保留 anyMessage，则清除，避免“潜水=每条都唤醒”的语义矛盾。
          if (next.mode === 'diving' && !('anyMessage' in inputTriggers)) {
            next.triggers.anyMessage = false;
          }
          if (next.mode === 'active') {
            next.infinite = true;
            next.sleepUntil = null;
            next.triggers.anyMessage = true;
          }
          if (typeof input.infinite === 'boolean' && next.mode !== 'active') next.infinite = input.infinite;
          if (next.infinite) {
            next.sleepUntil = null;
          } else if (input.sleepUntil) {
            const d = new Date(String(input.sleepUntil));
            if (!Number.isNaN(d.getTime())) next.sleepUntil = d.toISOString();
          } else if (Number.isFinite(Number(input.sleepMs))) {
            let ms = Math.max(0, Math.round(Number(input.sleepMs)));
            const minMs = Math.max(0, Number(cfg.simulation?.wake?.sleepMinMs) || 0);
            const maxMs = Number(cfg.simulation?.wake?.sleepMaxMs) || 0;
            if (ms < minMs) ms = minMs;
            if (maxMs > 0 && ms > maxMs) ms = maxMs;
            next.sleepUntil = new Date(Date.now() + ms).toISOString();
          } else if (!next.sleepUntil && !next.infinite) {
            // 既没有无限也没有时间：使用推荐默认有限时长
            const recMin = Number(cfg.simulation?.wake?.recommendedSleepMinMs) || 300000;
            const recMax = Number(cfg.simulation?.wake?.recommendedSleepMaxMs) || 7200000;
            const ms = recMin + Math.random() * Math.max(0, recMax - recMin);
            next.sleepUntil = new Date(Date.now() + Math.round(ms)).toISOString();
          }
          // 对有限 sleepUntil 也做 min/max clamp，防止绕过 sleepMaxMs
          if (!next.infinite && next.sleepUntil) {
            const maxMs = Number(cfg.simulation?.wake?.sleepMaxMs) || 0;
            const minMs = Math.max(0, Number(cfg.simulation?.wake?.sleepMinMs) || 0);
            let until = Date.parse(next.sleepUntil);
            if (Number.isFinite(until)) {
              if (minMs > 0 && until < Date.now() + minMs) until = Date.now() + minMs;
              if (maxMs > 0 && until > Date.now() + maxMs) until = Date.now() + maxMs;
              next.sleepUntil = new Date(until).toISOString();
            }
          }
          // 归一化概率
          if (next.triggers.probability !== undefined) {
            next.triggers.probability = Math.min(1, Math.max(0, Number(next.triggers.probability) || 0));
          }
          // 归一化拍一拍触发（只接受布尔，防脏字符串被当成 true）
          if (input.triggers && typeof input.triggers === 'object' && 'poke' in input.triggers) {
            next.triggers.poke = input.triggers.poke === true;
          }
          // 归一化“指定成员”触发：只保留正整数 QQ 号，去重，限制数量；
          // null/undefined/非法值统一清空，避免“null”被当成有效唤醒条件绕过防永眠。
          next.triggers.speakerIds = normalizeSpeakerIds(next.triggers.speakerIds);
          // 私聊不适用“指定成员发言醒来”：清除以免误导/脏数据（私聊仍按原有逻辑每次消息都唤醒）。
          if (key.startsWith('private:')) {
            next.triggers.speakerIds = [];
          }
          // 防止 AI 永眠：无限期潜水必须至少有一个可触发条件
          if (next.infinite) {
            const tr = next.triggers ?? {};
            const hasTrigger = tr.atMention || tr.nameMention || tr.poke || (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || tr.anyMessage || (Number(tr.probability) > 0) || (Array.isArray(tr.speakerIds) && tr.speakerIds.length > 0);
            if (!hasTrigger) {
              sendJson({ ok: false, error: '无限期潜水必须至少保留一个唤醒条件（@/名字/拍一拍/关键词/提问/anyMessage/概率>0），否则 AI 可能永眠' }, 400);
              return;
            }
          }
          // 沉睡前强制观察窗口：除非对方明确结束、或已经安静/等待足够时间，否则不允许 AI 聊两句就设置潜水。
          if (isSleepingConfig(next) && preSleepWaitBlocked(st)) {
            const preSleepMs = Math.max(0, Number(cfg.simulation?.wake?.preSleepWaitMs) || 300000);
            const remaining = Math.max(0, preSleepMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0));
            const remainMin = Math.ceil(remaining / 60000);
            sendJson({
              ok: false,
              error: `还不能立刻设置潜水/下一次唤醒：还需等待约 ${remainMin} 分钟无新消息，或调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察。如果等待期间有人发新消息，请先查看返回的 newMessages；判断不需要你参与就可以直接设置并沉睡，若你参与了则需下次再等观察窗口。`,
              preSleepWaitMs: preSleepMs,
              preSleepWaitRemainingMs: remaining
            }, 400);
            return;
          }
          const markedCount = acknowledgeOnClose ? acknowledgeMessages(st, throughSeq) : 0;
          st.wakeConfig = next;
          st.wakeConfig.lastWakeAt = st.wakeConfig.lastWakeAt || 0;
          st.wakeConfig.wakeCount = st.wakeConfig.wakeCount || 0;
          st.wakeConfig.noActionCount = 0;
          st.wakeConfig.confirmedAt = Date.now();
          st.wakeConfig.confirmedBy = 'set_wake_config';
          st.lastActionAt = Date.now();
          // 已成功设置下一次唤醒：本轮沉睡前观察标记作废，下次想再睡需重新走 5 分钟观察。
          st.preSleepWaitSatisfiedAt = 0;
          st.preSleepWaitObservedAt = 0;
          st.preSleepWaitAccumMs = 0;
          saveSimulationState();
          wakeConfigUpdatedKeys.add(key);
          wakeConfigMissCount.delete(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheck(key); // AI 已主动设置新的唤醒配置，取消回复检查
          setupSleepTimer(key);
          log(`[simulation] 更新唤醒配置 ${key}: mode=${next.mode} infinite=${next.infinite} sleepUntil=${next.sleepUntil ?? 'null'}`);
          sendJson({ ok: true, key, markedCount, unreadCount: st.unread.length, readThroughSeq: computeReadThroughSeq(st), wakeConfig: next, wakeSafety: computeWakeSafety(next) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/states') {
          const list = [];
          for (const [key, st] of simulation.conversations) {
            list.push({
              key,
              wakeConfig: st.wakeConfig,
              unreadCount: st.unread.length,
              recentCount: st.recentMessages.length,
              lastWakeReason: st.lastWakeReason,
              lastAiReplyAt: st.lastAiReplyAt,
              noActionCount: st.wakeConfig.noActionCount || 0
            });
          }
          sendJson({ ok: true, conversations: list });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/wake') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const reason = String(body.reason ?? 'admin').trim() || 'admin';
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const st = getSimulationState(key);
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          // 第一次唤醒必须走 bootstrap：那条 prompt 里带着「仿真协议说明 + 操作者为这个会话
          // 预写的初始提示词（群环境/氛围）」。若用手动唤醒的 admin 文案顶掉它，这个会话就
          // 永远拿不到引导 —— 而 bootstrapSent 一旦置真，后续再也不会补发。
          const firstWake = !st.bootstrapSent;
          if (firstWake) st.bootstrapSent = true;
          // 操作者手动唤醒在深潜下也要能完成引导；视为一次显式放行。
          if (isDeepDive(key)) st.deepDivePassAt = Date.now();
          const effectiveReason = firstWake ? 'bootstrap' : reason;
          saveSimulationState();
          // 和其它唤醒入口保持一致：sendWakePrompt 是异步的，这里不 await（不能让 HTTP 回复
          // 等一个可能卡几十秒的模型回合），但必须挂 catch。裸调用一旦 reject 就是
          // unhandledRejection：Node 会打警告甚至按配置退出进程，而 HTTP 那边已经回了 {ok:true}，
          // 表面上"唤醒成功"，实际上谁也不知道它失败了。
          void sendWakePrompt(key, effectiveReason).catch((error) => log(`[simulation] 手动唤醒异常 ${key}:`, error?.message ?? error));
          log(`控制台：手动唤醒 ${key}（${effectiveReason}${firstWake && reason !== effectiveReason ? `，首次唤醒，请求原因 ${reason} 已升级为 bootstrap` : ''}）`);
          sendJson({ ok: true, key, reason: effectiveReason, requestedReason: reason, firstWake });
          return;
        }
        // 操作者预写的「会话初始提示词」：控制台专用（AI 既读不到也改不了 —— ADMIN_ONLY_SIM_PATHS）。
        // 内容只在该会话**首次唤醒**（bootstrap）时注入一次，见 buildWakePrompt。
        if (url.pathname === '/api/simulation/initial-prompt' && (req.method === 'GET' || req.method === 'POST')) {
          if (req.method === 'GET') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            if (!key) {
              const entries = [...initialPrompts.entries()]
                .map(([entryKey, entry]) => ({
                  key: entryKey,
                  chars: entry.text.length,
                  createdAt: entry.createdAt || 0,
                  updatedAt: entry.updatedAt || 0,
                  preview: entry.text.replace(/\s+/g, ' ').slice(0, 80)
                }))
                .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
              sendJson({ ok: true, entries, maxChars: initialPromptMaxChars(), writable: initialPromptsWritable });
              return;
            }
            const canonical = canonicalSimulationKey(key);
            if (!canonical) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
            const entry = initialPrompts.get(canonical) ?? null;
            sendJson({
              ok: true,
              key: canonical,
              exists: !!entry,
              text: entry?.text ?? '',
              createdAt: entry?.createdAt || 0,
              updatedAt: entry?.updatedAt || 0,
              maxChars: initialPromptMaxChars(),
              writable: initialPromptsWritable
            });
            return;
          }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const explicitDelete = body.delete === true;
          // 只接受 { key, text: string } 或 { key, delete: true }：
          // 缺 text 时不当作"清空"（否则一次漏字段的调用就把操作者写的内容删了）。
          if (!explicitDelete && typeof body.text !== 'string') {
            sendJson({ ok: false, error: 'text 必须是字符串（留空表示删除），或用 delete:true 显式删除' }, 400);
            return;
          }
          const result = setInitialPrompt(key, explicitDelete ? '' : body.text);
          if (!result.ok) { sendJson({ ok: false, error: result.error }, result.statusCode ?? 400); return; }
          log(`控制台：${result.deleted ? '已删除' : '已保存'}会话初始提示词 ${result.key}${result.deleted ? '' : `（${result.chars} 字符，仅首次唤醒注入）`}`);
          sendJson({
            ok: true,
            key: result.key,
            deleted: result.deleted,
            chars: result.chars,
            exists: !!result.entry,
            updatedAt: result.entry?.updatedAt || 0,
            maxChars: initialPromptMaxChars()
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/send-burst') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (typeof rawMessages === 'string' ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            sendJson({ ok: false, error: 'qq_send_burst 暂不支持引用，请使用 qq_reply' }, 400);
            return;
          }
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.simulation?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          const burstAccess = req.headers['x-agent-token'] ? canActOn(key, req.headers['x-agent-token'], { crossSession: true, route: url.pathname }) : null;
          if (burstAccess && !burstAccess.ok) { sendJson({ ok: false, error: burstAccess.error }, burstAccess.status); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('sendBurst')) { sendJson({ ok: false, error: '工具未启用：qq_send_burst' }, 403); return; }
          if (currentMode !== 'simulation') {
            sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403);
            return;
          }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'simulation 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) {
            sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const burstToken = String(req.headers['x-agent-token'] || '').trim();
          if (!ownerTokenOk(burstToken) && shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const sendCfg = cfg.simulation?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const st = getSimulationState(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            // 先预占发送额度，避免并发绕过限频
            for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const delays = computeGaps(messages, 'auto', undefined, undefined, sendCfg);
            const sentMessages = await sendMessages(key, messages, delays);
            recordSentMessages(key, sentMessages);
            if (sentMessages.length > 0) noteTextSent(st);
            if (sentMessages.length > 0) void maybeSendPixelSticker(st, key);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSimulationState();
            log(`[simulation] 工具分条发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [simulation] 工具分条发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheck(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessages(key, error.sent);
              log(`[simulation] 工具分条发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const queuedCount = Math.max(0, Number(error?.queuedCount) || 0);
            // 失败/未发出的消息回滚预占的发送额度，避免假 429。已排队的不回滚（它还会发出去）。
            const failedCount = Math.max(0, messages.length - sentCount - queuedCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSimulationState();
            if (queuedCount > 0 && sentCount + queuedCount >= messages.length) {
              // 已持久化、后台重试：对模型返回成功，避免它重发造成重复。
              sendJson({ ok: true, key, sent: sentCount, queued: queuedCount, failed: 0, hint: '消息已持久化并进入重试队列，不要重复发送同一条内容' });
              return;
            }
            sendJson({ ok: false, error: error?.message ?? String(error), queued: queuedCount }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/send-message') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          let rawMessages = body.messages;
          if (typeof rawMessages === 'string') {
            const trimmed = rawMessages.trim();
            // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
            if (trimmed.startsWith('[')) {
              try {
                const parsed = JSON.parse(trimmed);
                if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            } else if (trimmed.startsWith('"')) {
              // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
              try {
                const parsed = JSON.parse(trimmed);
                if (typeof parsed === 'string') rawMessages = parsed;
                else if (Array.isArray(parsed)) rawMessages = parsed.map(String);
              } catch {}
            }
          }
          const isRawString = typeof rawMessages === 'string';
          const messages = Array.isArray(rawMessages)
            ? rawMessages.map((m) => String(m ?? '').trim()).filter(Boolean)
            : (isRawString ? [String(rawMessages).trim()].filter(Boolean) : []);
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          // 仿真不再按空格自动分条：字符串就是一条消息，数组模式原样使用调用方间隔。
          // 旧写法是 `(isRawString && messages.length > 1) ? 'auto' : ...` —— 上面 messages 的构造
          // 保证 isRawString 为真时 length 恒为 1，这个分支永远不可达，留着只会让人以为
          // "字符串多段时有特殊间隔策略"。
          const gapMode = (body.gapMode === 'fixed' || body.gapMode === 'byLength') ? body.gapMode : 'auto';
          const gapMs = Number(body.gapMs);
          const gaps = Array.isArray(body.gaps) ? body.gaps.map(Number) : [];
          if (!key || !messages.length) {
            sendJson({ ok: false, error: 'key 和 messages 不能为空' }, 400);
            return;
          }
          const sendCfgBurst = cfg.simulation?.send ?? {};
          if (sendCfgBurst.burstEnabled === false && messages.length > 1) {
            sendJson({ ok: false, error: '已禁用多条发送，请合并为一条消息' }, 403);
            return;
          }
          const msgAccess = req.headers['x-agent-token'] ? canActOn(key, req.headers['x-agent-token'], { crossSession: true, route: url.pathname }) : null;
          if (msgAccess && !msgAccess.ok) { sendJson({ ok: false, error: msgAccess.error }, msgAccess.status); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('sendMessage')) { sendJson({ ok: false, error: '工具未启用：qq_send_message' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'simulation 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) {
            sendJson({ ok: false, error: '私聊不需要 @' }, 400);
            return;
          }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          const sendCfg = cfg.simulation?.send ?? {};
          const maxMsgs = Math.max(1, Number(sendCfg.burstMaxMessages) || 8);
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (messages.length > maxMsgs) {
            sendJson({ ok: false, error: `最多发送 ${maxMsgs} 条` }, 400);
            return;
          }
          for (const msg of messages) {
            if (msg.length > maxChars) {
              sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400);
              return;
            }
            if (SENSITIVE_RE.test(msg)) {
              sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403);
              return;
            }
          }
          const delays = computeGaps(messages, gapMode, gapMs, gaps, sendCfg);
          // 先做发送频率检查并预占额度，再解析引用目标，避免未限流的引用查询打爆 OneBot。
          const st = getSimulationState(key);
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + messages.length > maxPerMinute) || (maxPerHour > 0 && recentHour + messages.length > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          // 先预占发送额度，避免并发绕过限频
          for (let i = 0; i < messages.length; i++) st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const resolved = await resolveReplyTarget(st, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              // 引用解析失败：回滚已预占的发送额度
              for (let i = 0; i < messages.length; i++) {
                const idx = st.sendTimes.indexOf(now);
                if (idx >= 0) st.sendTimes.splice(idx, 1);
              }
              saveSimulationState();
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          try {
            const sentMessages = await sendMessages(key, messages, delays, actualReplyToMessageId, atUserId);
            recordSentMessages(key, sentMessages);
            if (sentMessages.length > 0) noteTextSent(st);
            if (sentMessages.length > 0) void maybeSendPixelSticker(st, key);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSimulationState();
            log(`[simulation] 工具统一发送 ${key}: 成功 ${sentMessages.length}/${messages.length} 条`);
            appendActivity(`${key} [simulation] 工具统一发送：成功 ${sentMessages.length}/${messages.length} 条`);
            if (sentMessages.length > 0) scheduleReplyCheck(key);
            const burstHint = messages.length >= 3 ? '你已经连发了多条，确认是必要的吗？真人很少一口气补完。' : undefined;
            const spaceWarn = findCjkSpaceWarning(messages);
            const splitWarn = findSplitBoundaryWarning(messages);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: messages.length - sentMessages.length, delays, quoted: quotedInfo, ...(burstHint ? { hint: burstHint } : {}), ...(spaceWarn ? { warn: spaceWarn } : {}), ...(splitWarn ? { splitWarn } : {}) });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessages(key, error.sent);
              log(`[simulation] 工具统一发送部分成功 ${error.sent.length}/${messages.length} 条，已记录已发消息`);
            }
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const queuedCount = Math.max(0, Number(error?.queuedCount) || 0);
            const failedCount = Math.max(0, messages.length - sentCount - queuedCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSimulationState();
            if (queuedCount > 0 && sentCount + queuedCount >= messages.length) {
              sendJson({ ok: true, key, sent: sentCount, queued: queuedCount, failed: 0, hint: '消息已持久化并进入重试队列，不要重复发送同一条内容' });
              return;
            }
            sendJson({ ok: false, error: error?.message ?? String(error), queued: queuedCount }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/send-poke') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const targetUserId = String(body.targetUserId ?? body.userId ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'simulation 模式发送拍一拍必须携带 agent token' }, 403); return; }
          const pokeAccess = canActOn(key, req.headers['x-agent-token'], { crossSession: true, route: url.pathname });
          if (!pokeAccess.ok) { sendJson({ ok: false, error: pokeAccess.error }, pokeAccess.status); return; }
          if (!simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (!simulationToolEnabled('sendPoke')) { sendJson({ ok: false, error: '工具未启用：qq_send_poke' }, 403); return; }
          if (simulation.paused) { sendJson({ ok: false, error: '仿真 AI 已暂停，不能发送拍一拍' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许操作该会话' }, 403);
            return;
          }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许拍一拍' }, 403); return; }
          if (kind === 'group' && !targetUserId) {
            sendJson({ ok: false, error: '群聊拍一拍必须指定 targetUserId（要拍的群友 QQ 号）' }, 400);
            return;
          }
          if (targetUserId && !/^[1-9]\d*$/.test(targetUserId)) {
            sendJson({ ok: false, error: 'targetUserId 必须是正整数 QQ 号' }, 400);
            return;
          }
          // 群聊必须确认目标确实是本群成员（私聊天然只有双方，无需校验）。
          if (kind === 'group') {
            const memberError = await assertGroupMember(id, targetUserId);
            if (memberError) { sendJson({ ok: false, error: memberError }, 403); return; }
          }
          const st = getSimulationState(key);
          const sendCfg = cfg.simulation?.send ?? {};
          const now = Date.now();
          const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
          const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
          const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
            return;
          }
          st.sendTimes.push(now);
          if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
          // 成员校验是异步的（要问 OneBot）；期间操作者可能切模式/改白名单/开静默。
          // 拍一拍此前完全没有发送守卫，这里补上：真正发之前再确认一次。
          const sendGuard = captureSendGuard(key);
          try {
            sendGuard();
            if (shouldBlockSilentReply(key)) {
              const blocked = new Error('静默模式已开启，当前不允许拍一拍');
              blocked.statusCode = 403;
              throw blocked;
            }
            if (kind === 'group') {
              await bot.raw('group_poke', { group_id: id, user_id: Number(targetUserId) });
            } else {
              // 私聊拍一拍：send_poke 自动路由到当前私聊对象
              await bot.raw('send_poke', { user_id: id });
            }
            st.lastActionAt = now;
            st.lastAiReplyAt = now;
            st.wakeConfig.noActionCount = 0;
            const pokeText = kind === 'group'
              ? `[拍一拍] 我拍了拍 ${targetUserId}`
              : '[拍一拍] 我拍了拍你';
            st.recentMessages.push({
              messageId: null,
              sender: '我',
              text: pokeText,
              plain: pokeText,
              tail: pokeText,
              kind: 'poke',
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              poke: { targetId: targetUserId || String(id), targetIsSelf: false, groupId: kind === 'group' ? String(id) : null },
              time: Date.now()
            });
            const recentLimit = Number(cfg.simulation?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            saveSimulationState();
            log(`[simulation] 工具拍一拍 ${key}${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            appendActivity(`${key} [simulation] 工具拍一拍${kind === 'group' ? ' -> ' + targetUserId : ''}`);
            sendJson({ ok: true, key, kind, targetUserId: targetUserId || String(id) });
          } catch (error) {
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            log(`[simulation] 工具拍一拍失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `拍一拍失败：${error?.message ?? error}` }, error?.statusCode ?? 500);
          }
          return;
        }
        // ── 表情包体系（simulation） ──────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/simulation/sticker-image') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const stickerId = String(url.searchParams.get('stickerId') ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('getStickerImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_sticker_image' }, 403); return; }
          try {
            const entry = await getStickerImageData(stickerId);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const dims = getImageDimensions(fetched.buffer);
            if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
              sendJson({ ok: false, error: `表情图片像素超限（${dims.width}x${dims.height}），已拒绝` }, 400);
              return;
            }
            const mimeType = mimeFromBuffer(fetched.buffer) || mimeFromUrl(entry.url);
            sendJson({
              ok: true,
              key,
              sticker: {
                id: entry.id,
                desc: entry.desc || '',
                localNote: entry.localNote || '',
                tags: entry.tags || [],
                url: entry.url,
                md5: entry.md5
              },
              image: { mimeType, data: fetched.buffer.toString('base64') }
            });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/self-image') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('getSelfImage')) { sendJson({ ok: false, error: '工具未启用：qq_get_self_image' }, 403); return; }
          const selfRoleName = currentRoleName();
          if (isCustomRoleName(selfRoleName)) {
            sendJson({ ok: false, error: `当前是自定义角色「${selfRoleName}」，没有独立形象图；请按角色卡描述自己，或从图片库选一张` }, 404);
            return;
          }
          const selfPath = path.join(ROOT, 'assets', 'deepseek娘.png');
          try {
            if (!fs.existsSync(selfPath)) { sendJson({ ok: false, error: '未找到 AI 形象图片 assets/deepseek娘.png' }, 404); return; }
            const buf = fs.readFileSync(selfPath);
            const mimeType = mimeFromBuffer(buf) || 'image/png';
            sendJson({ ok: true, key, image: { mimeType, data: buf.toString('base64') } });
          } catch (error) {
            sendJson({ ok: false, error: `读取 AI 形象图片失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/sticker-note') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('stickerNote')) { sendJson({ ok: false, error: '工具未启用：qq_sticker_note' }, 403); return; }
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          const entry = applyStickerNoteToStore(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          log(`[sticker] 更新表情本地认知 ${key}: ${entry.id}`);
          sendJson({ ok: true, key, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/sticker-remark') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('setStickerRemark')) { sendJson({ ok: false, error: '工具未启用：qq_set_sticker_remark' }, 403); return; }
          try {
            const entry = await setStickerRemark(stickerId, String(body.remark ?? ''));
            log(`[sticker] 修改 QQ 收藏表情备注 ${key}: ${entry.id} -> ${entry.desc}`);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/delete-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const quotedId = String(body.messageId ?? '').trim();
          if (!key || (!stickerId && !quotedId)) { sendJson({ ok: false, error: 'key 和（stickerId 或 messageId）不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('deleteSticker')) { sendJson({ ok: false, error: '工具未启用：qq_delete_sticker' }, 403); return; }
          if (!isOwnerMediaContext(key)) { sendJson({ ok: false, error: '删除表情只允许主人在自己的私聊或本人最后发言的会话里操作' }, 403); return; }
          let target = stickerId;
          if (!target && quotedId) {
            const quoted = mediaRefFromQuoted(key, quotedId);
            if (!quoted || !quoted.self || quoted.kind !== 'sticker') {
              sendJson({ ok: false, error: '被回复的消息不是当前角色发的表情，或无法解析' }, 400);
              return;
            }
            target = quoted.ref;
          }
          try {
            const entry = await deleteSticker(target);
            sendJson({ ok: true, key, sticker: entry });
          } catch (error) {
            if (error?.code === 'AMBIGUOUS') {
              sendJson({ ok: false, error: error.message, candidates: error.candidates || [] }, 409);
            } else {
              sendJson({ ok: false, error: `删除表情失败：${error?.message ?? error}` }, 500);
            }
          }
          return;
        }
        // ── 语音发送（操作者通道：CLI / 控制台，凭 consoleToken） ──────────────
        //
        // 与 /api/send/* 的 agent 通道分开：操作者可能不在任何 QQ 会话里，
        // 所以不套「会话/模式」闸门，但白名单 + 语音限流 + 文件名审计一个都不少。
        if (req.method === 'POST' && (url.pathname === '/api/voice/send' || url.pathname === '/api/send/voice')) {
          const body = await readBody();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const voice = voiceCfg();
          // 注意：这里是**操作者通道**（CLI / 控制台面板 / 图形界面），由控制台令牌鉴权。
          // simulation.voice.enabled 是「AI 能不能发语音」的总闸，不该连你手动试发一起关掉——
          // 否则"默认不启用"会变成"谁都发不了"，连放音频试一下都做不到。
          // AI 通道的开关在 /api/simulation/send-voice 里单独判定。
          // /api/send/voice 是 AI 工具入口：带 agent token 时一律按 agent 规则走，
          // 避免 AI 借用操作者通道绕过「只能发自己会话」的限制。
          if (url.pathname === '/api/send/voice' && agentToken) {
            sendJson({
              ok: false,
              error: 'AI 请改用 /api/simulation/send-voice（带 key + token）'
            }, 403);
            return;
          }
          const key = String(body.target ?? body.key ?? '').trim();
          const parsedTarget = parseTargetKey(key);
          if (!parsedTarget) { sendJson({ ok: false, error: 'target 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!modeAllowed(key, parsedTarget.kind, Number(parsedTarget.id), cfg, currentMode)) {
            const a = cfg.allow ?? {};
            sendJson({
              ok: false,
              error: `目标 ${key} 不在白名单内（config.json allow.groups / allow.private：群 ${(a.groups ?? []).join(', ') || '空'}；私聊 ${(a.private ?? []).join(', ') || '空'}）`
            }, 403);
            return;
          }
          let resolved;
          try {
            resolved = resolveVoicePathForOperator(body.file ?? body.path ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          // 音量参数先校验（写错了当场告诉你，不要等到发的时候才炸）
          try {
            resolveAudioProcessing({
              volume: body.volume ?? voice.defaultVolume,
              normalize: body.normalize === true,
              loudness: body.loudness ?? voice.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error.message }, 400);
            return;
          }
          const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
          if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
          const preview = {
            key,
            file: resolved.path,
            via: resolved.via,
            bytes: probe.size,
            duration: probe.duration,
            codec: probe.codec,
            detail: describeAudio(probe),
            warnings: probe.warnings ?? [],
            limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour }
          };
          if (body.dryRun === true) { sendJson({ ok: true, dryRun: true, ...preview }); return; }
          // 预览不发送，保持可用；真正发送必须打开功能卡上的「语音与唱歌」总开关,
          // 否则控制台/CLI 会变成一条绕过总开关的发送通道。
          if (!featureEnabled(cfg, 'voice')) {
            sendJson({ ok: false, disabled: true, reason: 'features.voice=false', error: '语音与唱歌总开关已关闭（仍可 dryRun 预览）' }, 403);
            return;
          }
          const now = Date.now();
          try {
            voiceBudgetCheck('operator:cli', voice);
            const sent = await sendVoiceFile(key, resolved.path, {
              guard: false,
              audit: true,
              audio: {
                volume: body.volume ?? voice.defaultVolume,
                normalize: body.normalize === true,
                loudness: body.loudness ?? voice.loudness
              }
            });
            voiceBudgetCommit('operator:cli', now);
            log(`[voice] (操作者) ${key} 已发送语音 ${path.basename(resolved.path)} (${sent.detail}${sent.audioMode === 'original' ? '' : '，' + sent.audioProcessing}, messageId=${sent.messageId ?? '?'})`);
            appendActivity(`${key} [voice] (操作者) 发送语音 ${path.basename(resolved.path)} (${sent.detail})`);
            // CLI 默认要落地校验（--verify 之外也能给出可信证据）；readback 仅在做"收到的语音"实验时用。
            const verification = body.verify === false ? null : await verifyVoiceMessageSent(sent.messageId);
            let readbackText = null;
            if (body.readback === true && sent.messageId) {
              try {
                const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
                const res = await fetch(`${httpUrl}/fetch_ptt_text`, {
                  method: 'POST',
                  headers: {
                    'content-type': 'application/json',
                    ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
                  },
                  body: JSON.stringify({ message_id: String(sent.messageId) }),
                  signal: AbortSignal.timeout(30000)
                });
                const rb = await res.json().catch(() => ({}));
                if (res.ok && rb.status === 'ok' && rb.retcode === 0) readbackText = rb.data?.text ?? '';
              } catch (error) {
                log(`[voice] 转写回读失败：${error?.message ?? error}`);
              }
            }
            sendJson({
              ok: true,
              ...preview,
              messageId: sent.messageId,
              verified: verification?.confirmed === true,
              readback: readbackText,
              audioProcessing: sent.audioProcessing,
              volume: sent.volume,
              loudness: sent.loudness
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 即时心情事件（模型自述，强度 ≥3，限频/去重） ────────────────
        if (req.method === 'POST' && url.pathname === '/api/simulation/mood/nudge') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          if (!agentTokenOk(key, token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (!simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          try {
            const result = await innerLife.nudgeMood({
              what: String(body.what ?? body.cause ?? '').slice(0, 30),
              type: typeof body.type === 'string' ? body.type : 'other',
              intensity: Number(body.intensity) || 0,
              valence: body.valence === 'negative' ? 'negative' : 'positive',
              arousal: ['up', 'down', 'none'].includes(body.arousal) ? body.arousal : 'none',
              energy: body.energy && typeof body.energy === 'object' ? body.energy : null,
              cause: String(body.cause ?? '').slice(0, 20),
              sourceMessageId: body.sourceMessageId ?? null
            }, { dryRun: body.dryRun === true });
            const ok = result.status === 'ok' || result.status === 'dry-run';
            sendJson({ ok, ...result }, ok ? 200 : 400);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 通用分享模块：主人私聊创建/更新/验证/预览/暂停/删除 ──────────
        if (req.method === 'POST' && url.pathname === '/api/simulation/share-modules') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const ownerKey = ownerChatKey();
          if (!ownerKey || key !== ownerKey) { sendJson({ ok: false, error: '分享模块管理只允许主人私聊' }, 403); return; }
          if (!ownerTokenOk(token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          const action = String(body.action ?? '').trim();
          const allowedTargets = new Set((cfg.allow?.groups || []).map((id) => `group:${String(id).replace(/^group:/, '')}`));
          const applyModuleConfig = (patch) => {
            const configFile = path.join(ROOT, 'config.json');
            const file = readConfigObject(configFile);
            const nextFile = applyConfigPatch(file, patch);
            nextFile.configVersion = CONFIG_VERSION;
            writeConfigFile(nextFile, { tag: 'share' });
            const nested = applyConfigPatch({}, patch);
            const merged = deepMergeConfig(cfg, nested);
            for (const key of Object.keys(cfg)) delete cfg[key];
            Object.assign(cfg, merged);
            return { ok: true };
          };
          try {
            if (action === 'list') {
              sendJson({ ok: true, status: innerLife.getShareModulesStatus?.() || null });
              return;
            }
            if (action === 'create' || action === 'update') {
              if (body.confirm !== true) { sendJson({ ok: false, error: '需要 confirm=true 才能写入模块' }, 400); return; }
              let input;
              try { input = JSON.parse(String(body.configJson || '{}')); } catch { sendJson({ ok: false, error: 'configJson 不是合法 JSON' }, 400); return; }
              input.id = String(body.id || input.id || '').trim();
              const existing = innerLife.getShareModulesStatus?.()?.modules?.find?.((m) => m.id === input.id);
              if (action === 'create') {
                const prepared = innerLife.prepareShareModule(input);
                if (!prepared.ok) { sendJson({ ok: false, error: prepared.error }, 400); return; }
                if (!prepared.module.targets.every((t) => allowedTargets.has(t))) { sendJson({ ok: false, error: '目标群不在白名单' }, 400); return; }
                const written = applyModuleConfig({ [`simulation.shareModules.modules.${input.id}`]: prepared.module });
                if (!written.ok) { sendJson({ ok: false, errors: written.errors }, 400); return; }
                innerLife.initShareModuleState(prepared.module);
                log(`[share] 主人创建分享模块 ${input.id}（${prepared.module.template}）→ ${prepared.module.targets.join(',')}`);
                sendJson({ ok: true, action, module: prepared.module, status: innerLife.getShareModulesStatus?.() || null });
                return;
              }
              if (!existing) { sendJson({ ok: false, error: `模块 ${input.id} 不存在` }, 404); return; }
              // 编辑不重置验证状态：已通过的模块继续自动发；验证中的模块继续逐条私聊确认。
              const prepared = innerLife.updateShareModuleConfig
                ? innerLife.updateShareModuleConfig(input.id, input)
                : innerLife.prepareShareModule({ ...input, verification: { status: 'pending' } }, { allowExisting: true });
              if (!prepared.ok) { sendJson({ ok: false, error: prepared.error }, 400); return; }
              if (!prepared.module.targets.every((t) => allowedTargets.has(t))) { sendJson({ ok: false, error: '目标群不在白名单' }, 400); return; }
              const written = applyModuleConfig({ [`simulation.shareModules.modules.${input.id}`]: prepared.module });
              if (!written.ok) { sendJson({ ok: false, errors: written.errors }, 400); return; }
              innerLife.refreshShareModuleSchedule?.(input.id);
              sendJson({ ok: true, action, module: prepared.module, status: innerLife.getShareModulesStatus?.() || null });
              return;
            }
            if (action === 'delete') {
              if (body.confirm !== true) { sendJson({ ok: false, error: '需要 confirm=true 才能删除模块' }, 400); return; }
              const id = String(body.id || '').trim();
              const configFile = path.join(ROOT, 'config.json');
              const file = readConfigObject(configFile);
              if (!file.simulation?.shareModules?.modules?.[id]) { sendJson({ ok: false, error: `模块 ${id} 不存在` }, 404); return; }
              delete file.simulation.shareModules.modules[id];
              writeConfigFile(file, { tag: 'share', danger: true });
              if (cfg.simulation?.shareModules?.modules) delete cfg.simulation.shareModules.modules[id];
              innerLife.removeShareModuleState?.(id);
              sendJson({ ok: true, action, id });
              return;
            }
            if (action === 'pause' || action === 'resume') {
              const status = innerLife.setShareModulePaused?.(String(body.id || ''), action === 'pause');
              sendJson({ ok: Boolean(status), status });
              return;
            }
            if (action === 'verify') {
              const status = innerLife.setShareVerification?.(String(body.id || ''), 'approved');
              sendJson({ ok: Boolean(status), status });
              return;
            }
            if (action === 'preview') {
              const result = await innerLife.previewShareModule?.(String(body.id || ''));
              const { images, card, ...rest } = result || {};
              const toData = (buf) => (Buffer.isBuffer(buf) && buf.length ? `data:image/png;base64,${buf.toString('base64')}` : '');
              const imageDataUrls = (Array.isArray(images) ? images : []).filter(Buffer.isBuffer).slice(0, 3).map(toData);
              sendJson({ ok: result?.status === 'dryRun', result: { ...rest, imageDataUrls, cardDataUrl: toData(card) } });
              return;
            }
            if (action === 'run') {
              const result = await innerLife.runShareModule?.(String(body.id || ''), { force: true });
              sendJson({ ok: result?.status === 'sent' || result?.status === 'pending-approval', result });
              return;
            }
            if (action === 'publish') {
              const result = await innerLife.publishShareDraft?.(String(body.id || ''));
              sendJson({ ok: result?.status === 'sent', result });
              return;
            }
            sendJson({ ok: false, error: '未知 action' }, 400);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 主人功能：能力清单 / 预览 / 应用 / 暂停 / 删除（独立配置与状态） ──
        if (req.method === 'POST' && url.pathname === '/api/simulation/owner-features') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const ownerKey = ownerChatKey();
          if (!ownerKey || key !== ownerKey) {
            const denied = rejectHighRiskFromGroup(url.pathname, key, body, req);
            sendJson({ ok: false, error: denied.error, ...(denied.payload || {}) }, denied.status);
            return;
          }
          const replayId = String(req.headers['x-owner-confirm-id'] ?? '').trim();
          if (!replayId && !ownerTokenOk(token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          const highRisk = await ownerHighRiskGuard(url.pathname, body, req);
          if (!highRisk.ok) { sendJson({ ok: false, error: highRisk.error, ...(highRisk.payload || {}) }, highRisk.status); return; }
          const action = String(body.action ?? '').trim();
          const allowedTargets = [...(cfg.allow?.groups || []).map((id) => `group:${String(id).replace(/^group:/, '')}`), ...(cfg.allow?.private || []).map((id) => `private:${String(id).replace(/^private:/, '')}`), 'qzone', 'self'];
          const applyOwnerConfig = (modules) => {
            const configFile = path.join(ROOT, 'config.json');
            const file = readConfigObject(configFile);
            const patch = { 'simulation.ownerFeatures.enabled': true, 'simulation.ownerFeatures.modules': modules };
            const nextFile = applyConfigPatch(file, patch);
            nextFile.configVersion = CONFIG_VERSION;
            writeConfigFile(nextFile);
            const merged = deepMergeConfig(cfg, applyConfigPatch({}, patch));
            for (const k of Object.keys(cfg)) delete cfg[k];
            Object.assign(cfg, merged);
          };
          try {
            if (action === 'capabilities') {
              sendJson({ ok: true, capabilities: listOwnerCapabilities() });
              return;
            }
            if (action === 'list') {
              const conf = ownerFeaturesConfig();
              const state = loadOwnerFeatureState();
              const features = Object.values(conf.modules).map((raw) => {
                const feature = normalizeOwnerFeature(raw, raw?.id);
                const st = state.features[feature.id] || {};
                return { ...feature, nextAt: Number(st.nextAt) || 0, lastAt: Number(st.lastAt) || 0, lastError: String(st.lastError || '') };
              });
              sendJson({ ok: true, enabled: conf.enabled, features });
              return;
            }
            if (action === 'preview') {
              const feature = normalizeOwnerFeature(body.feature || body, body.id);
              const checked = validateOwnerFeature(feature, { allowedTargets });
              if (!checked.ok) { sendJson({ ok: false, errors: checked.errors }, 400); return; }
              const targetLabels = Object.fromEntries([...(cfg.allow?.groups || []).map((id) => [`group:${id}`, conversationDisplayName(`group:${id}`)]), ...(cfg.allow?.private || []).map((id) => [`private:${id}`, conversationDisplayName(`private:${id}`)])]);
              sendJson({ ok: true, feature, preview: renderOwnerFeaturePreview(feature, { targetLabels }) });
              return;
            }
            if (action === 'apply') {
              if (body.confirm !== true) { sendJson({ ok: false, error: '需要 confirm=true' }, 400); return; }
              const feature = normalizeOwnerFeature(body.feature || body, body.id);
              const checked = validateOwnerFeature(feature, { allowedTargets });
              if (!checked.ok) { sendJson({ ok: false, errors: checked.errors }, 400); return; }
              if (feature.type === 'code_feature') {
                const state = loadOwnerFeatureState();
                state.features[feature.id] = {
                  nextAt: 0,
                  lastAt: 0,
                  lastError: '等待编码代理',
                  proposal: { feature, createdAt: Date.now(), status: 'proposed' }
                };
                saveOwnerFeatureState(state);
                const staged = stageCodeProposal({
                  id: feature.id,
                  feature,
                  dir: path.join(STATE_DIR, 'dev-proposals'),
                  orchestratorDir: path.join(STATE_DIR, 'orchestrator'),
                  root: ROOT,
                  source: 'private-chat',
                  reason: 'code_feature',
                  wake: wakeOrchestrator
                });
                if (!staged.ok) { sendJson({ ok: false, error: staged.error }, 400); return; }
                await sendToQQ(ownerKey, `【代码功能提案】${feature.label}
目标：${feature.targets.join('、')}
内容：${feature.action.text.slice(0, 120)}

已交主控（${feature.id}），计划已写好：主控会话会被直接叫醒，我复核后自己派单，你不用操作。
没收到回音的话，在主控会话里说「处理 ${feature.id}」；主工作区不改，合并前需要你二次确认。`);
                sendJson({ ok: true, status: 'queued', feature, proposalId: feature.id, taskId: feature.id, wake: wakeStatus(path.join(STATE_DIR, 'orchestrator')) });
                return;
              }
              if (!['scheduled_message', 'qzone_post', 'auto_reply', 'voice_message'].includes(feature.type)) {
                sendJson({ ok: false, error: `${feature.type} 的运行时尚在下一批接入，目前支持 scheduled_message / qzone_post` }, 400);
                return;
              }
              const state = loadOwnerFeatureState();
              const existing = (ownerFeaturesConfig().modules || {})[feature.id] || null;
              const previousState = state.features[feature.id] || null;
              feature.createdAt = Number(existing?.createdAt) || Date.now();
              feature.updatedAt = Date.now();
              const modules = { ...(ownerFeaturesConfig().modules || {}), [feature.id]: feature };
              applyOwnerConfig(modules);
              state.features[feature.id] = {
                nextAt: featureNextAt(feature),
                lastAt: 0,
                lastError: '',
                previous: existing
                  ? { module: existing, state: previousState ? { ...previousState, previous: undefined } : null }
                  : { module: null, state: null }
              };
              saveOwnerFeatureState(state);
              try {
                const orchDir = path.join(STATE_DIR, 'orchestrator');
                const queued = enqueueTask(orchDir, { id: feature.id, title: feature.label, kind: 'config', feature, source: 'private-chat' });
                if (queued.ok) updateTask(orchDir, feature.id, { status: 'done', assignedTo: 'private-chat' }, { by: 'bridge', note: '配置类功能即时应用，已验收' });
              } catch (error) {
                log(`[orchestrator] 记录配置任务失败：${error?.message ?? error}`);
              }
              sendJson({ ok: true, feature, nextAt: state.features[feature.id].nextAt, canRollback: true });
              return;
            }
            if (action === 'pause' || action === 'resume' || action === 'delete' || action === 'rollback') {
              const id = String(body.id || '').trim();
              const modules = { ...(ownerFeaturesConfig().modules || {}) };
              if (!modules[id]) { sendJson({ ok: false, error: `功能 ${id} 不存在` }, 404); return; }
              if (action === 'delete') {
                delete modules[id];
                applyOwnerConfig(modules);
                const state = loadOwnerFeatureState();
                delete state.features[id];
                saveOwnerFeatureState(state);
              } else if (action === 'rollback') {
                const state = loadOwnerFeatureState();
                const prev = state.features[id]?.previous;
                if (!prev) { sendJson({ ok: false, error: '没有可回滚的上一版' }, 400); return; }
                if (prev.module) modules[id] = prev.module;
                else delete modules[id];
                applyOwnerConfig(modules);
                if (prev.state) state.features[id] = { ...prev.state, previous: null };
                else delete state.features[id];
                saveOwnerFeatureState(state);
              } else {
                modules[id] = { ...modules[id], enabled: action === 'resume' };
                applyOwnerConfig(modules);
                const state = loadOwnerFeatureState();
                state.features[id] = { ...(state.features[id] || {}), nextAt: action === 'resume' ? featureNextAt(normalizeOwnerFeature(modules[id], id)) : 0 };
                saveOwnerFeatureState(state);
              }
              sendJson({ ok: true, action, id });
              return;
            }
            sendJson({ ok: false, error: '未知 action' }, 400);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 代码功能提案：状态 / 合并 / 拒绝（仅主人私聊） ────────────────
        if (req.method === 'POST' && url.pathname === '/api/simulation/dev-proposals') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const ownerKey = ownerChatKey();
          if (!ownerKey || key !== ownerKey) {
            const denied = rejectHighRiskFromGroup(url.pathname, key, body, req);
            sendJson({ ok: false, error: denied.error, ...(denied.payload || {}) }, denied.status);
            return;
          }
          const replayId = String(req.headers['x-owner-confirm-id'] ?? '').trim();
          if (!replayId && !ownerTokenOk(token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          const highRisk = await ownerHighRiskGuard(url.pathname, body, req);
          if (!highRisk.ok) { sendJson({ ok: false, error: highRisk.error, ...(highRisk.payload || {}) }, highRisk.status); return; }
          const dir = path.join(STATE_DIR, 'dev-proposals');
          const action = String(body.action ?? '').trim();
          const id = String(body.id || '').trim();
          try {
            if (action === 'list' || action === 'status') {
              const orchDir = path.join(STATE_DIR, 'orchestrator');
              const items = listProposals(dir).map((item) => ({ id: item.id, feature: item.proposal?.feature || null, result: item.result, task: readTask(orchDir, item.id) }));
              sendJson({ ok: true, proposals: action === 'status' ? items.filter((x) => x.id === id) : items, orchestrator: queueSnapshot(orchDir), wake: wakeStatus(orchDir) });
              return;
            }
            if (action === 'propose_code') {
              const queued = queueCodeProposal({
                dir,
                orchestratorDir: path.join(STATE_DIR, 'orchestrator'),
                root: ROOT,
                ownerKey,
                key,
                input: body,
                wake: wakeOrchestrator
              });
              if (!queued.ok) { sendJson({ ok: false, error: queued.error, errors: queued.errors || [] }, queued.code || 400); return; }
              if (!queued.existed) {
                const plan = queued.plan;
                await sendToQQ(ownerKey, `【代码提案】${queued.feature.label}
症状：${queued.feature.symptom.slice(0, 120)}
期望：${queued.feature.expected.slice(0, 120)}

计划已生成（${queued.id}，${plan?.steps?.length || 0} 步），已交主控：主控会话会被直接叫醒，我复核后自己派单，你不用操作。
计划：state/orchestrator/plans/${queued.id}.md
没收到回音的话，在主控会话里说「处理 ${queued.id}」；完成后把 diff 和测试结论回你，合并前仍需你确认。`);
              }
              sendJson({ ok: true, status: 'queued', id: queued.id, proposalId: queued.id, taskId: queued.id, existed: queued.existed, wake: wakeStatus(path.join(STATE_DIR, 'orchestrator')) });
              return;
            }
            if (!id) { sendJson({ ok: false, error: '缺少 id' }, 400); return; }
            const result = readResult(dir, id);
            if (action === 'reject') {
              const rejected = rejectProposal({ dir, id, worktree: result?.worktree });
              const orchDir = path.join(STATE_DIR, 'orchestrator');
              if (readTask(orchDir, id)) updateTask(orchDir, id, { status: 'rejected' }, { by: 'bridge', note: '提案被主人丢弃' });
              reconcileWakeSessions('提案丢弃');
              sendJson({ ok: true, action, id, worktree: rejected.worktree });
              return;
            }
            if (action !== 'merge') { sendJson({ ok: false, error: '未知 action' }, 400); return; }
            if (body.confirm !== true) { sendJson({ ok: false, error: '合并需要 confirm=true' }, 400); return; }
            const merged = mergeProposal({
              dir,
              id,
              root: ROOT,
              backupRoot: path.join(STATE_DIR, 'dev-backups'),
              verify: () => {
                const run = spawnSync('npm', ['run', 'verify'], { cwd: ROOT, shell: true, encoding: 'utf8', timeout: 15 * 60 * 1000 });
                return { ok: run.status === 0, output: String(run.stdout || run.stderr || '') };
              }
            });
            if (!merged.ok) {
              sendJson({ ok: false, error: merged.error, rolledBack: Boolean(merged.rolledBack), output: merged.output || '' }, merged.rolledBack ? 500 : 400);
              return;
            }
            await sendToQQ(ownerKey, `代码功能「${id}」已合并并通过 verify。`);
            const mergeOrchDir = path.join(STATE_DIR, 'orchestrator');
            if (readTask(mergeOrchDir, id)) updateTask(mergeOrchDir, id, { status: 'done' }, { by: 'bridge', note: '已合并并通过 verify' });
            reconcileWakeSessions('提案合并');
            sendJson({ ok: true, action, id, changed: merged.changed });
            return;
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 主人配置读写：白名单键，写入后热更新；需要的重启项会返回 ──────
        if (req.method === 'POST' && url.pathname === '/api/simulation/owner-config') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const ownerKey = ownerChatKey();
          if (!ownerKey || key !== ownerKey) {
            const denied = rejectHighRiskFromGroup(url.pathname, key, body, req);
            sendJson({ ok: false, error: denied.error, ...(denied.payload || {}) }, denied.status);
            return;
          }
          const replayId = String(req.headers['x-owner-confirm-id'] ?? '').trim();
          if (!replayId && !ownerTokenOk(token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          const highRisk = await ownerHighRiskGuard(url.pathname, body, req);
          if (!highRisk.ok) { sendJson({ ok: false, error: highRisk.error, ...(highRisk.payload || {}) }, highRisk.status); return; }
          const action = String(body.action ?? 'list').trim();
          try {
            if (action === 'list' || action === 'get') {
              sendJson({ ok: true, config: action === 'get' ? { key: body.configKey, value: readOwnerConfig(cfg, body.configKey) } : listOwnerConfig(cfg) });
              return;
            }
            if (action !== 'set') { sendJson({ ok: false, error: '未知 action' }, 400); return; }
            if (body.confirm !== true) { sendJson({ ok: false, error: '修改配置需要 confirm=true' }, 400); return; }
            const beforeValue = readOwnerConfig(cfg, body.configKey);
            const applied = ownerConfigPatch(body.configKey, body.value);
            if (!applied.ok) { sendJson({ ok: false, error: applied.error }, 400); return; }
            const configFile = path.join(ROOT, 'config.json');
            const file = readConfigObject(configFile);
            const nextFile = applyConfigPatch(file, { [applied.path]: applied.stored });
            nextFile.configVersion = CONFIG_VERSION;
            writeConfigFile(nextFile);
            const merged = deepMergeConfig(cfg, applyConfigPatch({}, { [applied.path]: applied.stored }));
            for (const k of Object.keys(cfg)) delete cfg[k];
            Object.assign(cfg, merged);
            // 白名单键也走同一条重排：只改开关时若不重排，见闻/签名/日报要等一次重启才续上。
            resyncFeatureSchedules([applied.path]);
            sendJson({ ok: true, key: applied.spec.key, value: applied.value, before: beforeValue, restart: applied.spec.restart || 'none' });
            return;
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 主人管理动作（声线/签名/分享/说说/目标群/状态；owner token 专用） ──
        if (req.method === 'POST' && url.pathname === '/api/simulation/owner-admin') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const ownerKey = ownerChatKey();
          if (!ownerKey || key !== ownerKey) {
            const denied = rejectHighRiskFromGroup(url.pathname, key, body, req);
            sendJson({ ok: false, error: denied.error, ...(denied.payload || {}) }, denied.status);
            return;
          }
          const replayId = String(req.headers['x-owner-confirm-id'] ?? '').trim();
          if (!replayId && !ownerTokenOk(token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          const highRisk = await ownerHighRiskGuard(url.pathname, body, req);
          if (!highRisk.ok) { sendJson({ ok: false, error: highRisk.error, ...(highRisk.payload || {}) }, highRisk.status); return; }
          const action = String(body.action ?? '').trim();
          try {
            if (action === 'voice_style') {
              const mode = String(body.mode ?? '').trim();
              if (!['auto', 'soft', 'dark'].includes(mode)) { sendJson({ ok: false, error: 'mode 必须是 auto/soft/dark' }, 400); return; }
              writeVoiceStyleState({ mode, autoDark: false, source: 'owner' });
              log(`[voice] 主人私聊切换声线：${mode}`);
              sendJson({ ok: true, action, voiceStyle: voiceStyleSnapshot(cfg) });
              return;
            }
            if (action === 'signature') {
              const text = String(body.text ?? '').trim();
              if (!text) { sendJson({ ok: false, error: '签名不能为空' }, 400); return; }
              await applyQQSignature(text);
              const now = Date.now();
              signatureState.lastText = text;
              signatureState.lastAppliedAt = now;
              signatureState.lastError = '';
              signatureState.history = appendSignatureHistory(signatureState.history, text, now);
              signatureState.pending = null;
              signatureState.nextAt = 0;
              saveSignatureState();
              if (cfg.simulation?.signature?.enabled === true) scheduleSignatureNext(now);
              log(`[voice] 主人私聊更新个性签名（${text.length} 字符）`);
              sendJson({ ok: true, action, text });
              return;
            }
            if (action === 'run_share') {
              void innerLife.runJob('curiosity', { force: true, preferS16: body.preferS16 === true, dryRun: body.dryRun === true })
                .then((r) => log(`[inner] 主人手动分享 → ${r?.status ?? 'done'}`))
                .catch((error) => log(`[inner] 主人手动分享 异常：${error?.message ?? error}`));
              sendJson({ ok: true, action, started: true });
              return;
            }
            if (action === 'run_qzone') {
              void innerLife.runJob('qzone', { force: true })
                .then((r) => log(`[inner] 主人手动说说 → ${r?.status ?? 'done'}`))
                .catch((error) => log(`[inner] 主人手动说说 异常：${error?.message ?? error}`));
              sendJson({ ok: true, action, started: true });
              return;
            }
            if (action === 'pause_qzone' || action === 'resume_qzone') {
              await innerLife.handleOwnerCommand(action === 'pause_qzone' ? '关说说' : '开说说', { kind: 'private', isOwner: true });
              sendJson({ ok: true, action, paused: action === 'pause_qzone' });
              return;
            }
            if (action === 'set_share_targets') {
              const allowed = new Set((cfg.allow?.groups || []).map((id) => `group:${String(id).replace(/^group:/, '')}`));
              const list = [...new Set((Array.isArray(body.targets) ? body.targets : []).map(String))].filter((k) => allowed.has(k));
              if (!list.length) { sendJson({ ok: false, error: 'targets 里没有白名单群' }, 400); return; }
              const configFile = path.join(ROOT, 'config.json');
              const file = readConfigObject(configFile);
              file.simulation = file.simulation && typeof file.simulation === 'object' ? file.simulation : {};
              file.simulation.innerLife = file.simulation.innerLife && typeof file.simulation.innerLife === 'object' ? file.simulation.innerLife : {};
              file.simulation.innerLife.groupShare = file.simulation.innerLife.groupShare && typeof file.simulation.innerLife.groupShare === 'object' ? file.simulation.innerLife.groupShare : {};
              file.simulation.innerLife.groupShare.targets = list;
              file.simulation.innerLife.groupShare.target = list[0];
              writeConfigFile(file);
              cfg.simulation.innerLife = cfg.simulation.innerLife && typeof cfg.simulation.innerLife === 'object' ? cfg.simulation.innerLife : {};
              cfg.simulation.innerLife.groupShare = cfg.simulation.innerLife.groupShare && typeof cfg.simulation.innerLife.groupShare === 'object' ? cfg.simulation.innerLife.groupShare : {};
              cfg.simulation.innerLife.groupShare.targets = list;
              cfg.simulation.innerLife.groupShare.target = list[0];
              log(`[inner] 主人私聊设置分享目标群：${list.join('、')}`);
              sendJson({ ok: true, action, targets: list });
              return;
            }
            if (action === 'status') {
              sendJson({ ok: true, action, statusText: innerLife.statusText(), state: innerLife.getState() });
              return;
            }
            if (action === 'owner_status') {
              const q = cfg.simulation?.innerLife?.qzone || {};
              const sig = cfg.simulation?.signature || {};
              const subs = (Array.isArray(cfg.simulation?.subscriptions) ? cfg.simulation.subscriptions : []).map((sub) => ({ key: sub.key, topic: sub.topic || 's16', enabled: sub.enabled !== false, maxPerDay: Number(sub.maxPerDay) || 0, minGapMinutes: Math.round((Number(sub.minGapMs) || 0) / 60000) }));
              const inner = innerLife.getState() || {};
              sendJson({
                ok: true,
                action,
                qzone: { enabled: q.enabled !== false, maxPerDay: Number(q.maxPerDay) || 0, minGapMinutes: Math.round((Number(q.minGapMs) || 0) / 60000), skipProbability: Number(q.skipProbability) || 0, requireApproval: q.requireApproval !== false, today: Number(inner.counts?.qzone) || 0, nextAt: Number(inner.next?.qzone) || 0 },
                signature: { minIntervalHours: Number(sig.minIntervalHours) || 0, maxIntervalHours: Number(sig.maxIntervalHours) || 0, requireApproval: sig.requireApproval !== false, nextAt: Number(signatureState.nextAt) || 0, lastText: signatureState.lastText || '' },
                voice: { ...voiceStyleSnapshot(cfg), tts: { ok: liveTtsOnline === true, provider: liveTtsProvider, checkedAt: liveTtsCheckedAt }, maxPerMinute: Number(cfg.simulation?.voice?.maxPerMinute) || 0, maxPerHour: Number(cfg.simulation?.voice?.maxPerHour) || 0 },
                subscriptions: subs,
                dailyReport: { enabled: cfg.simulation?.dailyReport?.enabled === true, at: String(cfg.simulation?.dailyReport?.at || ''), groups: cfg.simulation?.dailyReport?.groups || [] }
              });
              return;
            }
            if (action === 'qzone_status') {
              const q = cfg.simulation?.innerLife?.qzone || {};
              const st = innerLife.getState() || {};
              const allPosts = Array.isArray(st.history?.qzonePosts) ? st.history.qzonePosts : [];
              const postedOnly = allPosts.filter((p) => p && p.status === 'posted');
              const recent = allPosts.slice(0, 8).map((p) => ({
                at: Number(p.at) || 0,
                text: String(p.text || '').slice(0, 120),
                status: p.status || 'unknown'
              }));
              const pending = st.pendingDraft && typeof st.pendingDraft === 'object' ? {
                text: String(st.pendingDraft.text || '').slice(0, 120),
                createdAt: Number(st.pendingDraft.createdAt) || 0,
                expiresAt: Number(st.pendingDraft.expiresAt) || 0
              } : null;
              sendJson({
                ok: true,
                action,
                qzone: {
                  enabled: q.enabled !== false,
                  paused: st.qzone?.paused === true,
                  maxPerDay: Number(q.maxPerDay) || 0,
                  minGapMs: Number(q.minGapMs) || 0,
                  minGapMinutes: Math.round((Number(q.minGapMs) || 0) / 60000),
                  maxChars: Number(q.maxChars) || 0,
                  skipProbability: Number(q.skipProbability) || 0,
                  requireApproval: q.requireApproval !== false,
                  visibility: Number(q.visibility) || 1
                },
                today: Number(st.counts?.qzone) || 0,
                nextAt: Number(st.next?.qzone) || 0,
                last: postedOnly[0] ? { at: Number(postedOnly[0].at) || 0, text: String(postedOnly[0].text || '').slice(0, 120), status: postedOnly[0].status } : null,
                recent,
                pendingDraft: pending
              });
              return;
            }
            sendJson({ ok: false, error: '未知的 action' }, 400);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 空间说说（主人私聊直接指定内容；只有主人自己的 agent token 能用） ──
        if (req.method === 'POST' && url.pathname === '/api/simulation/qzone-post') {
          if (!innerLife) { sendJson({ ok: false, error: '内心生活未初始化' }, 503); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const ownerKey = ownerChatKey();
          if (!ownerKey || key !== ownerKey) {
            const denied = rejectHighRiskFromGroup(url.pathname, key, body, req);
            sendJson({ ok: false, error: denied.error, ...(denied.payload || {}) }, denied.status);
            return;
          }
          const replayId = String(req.headers['x-owner-confirm-id'] ?? '').trim();
          if (!replayId && !ownerTokenOk(token)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          const highRisk = await ownerHighRiskGuard(url.pathname, body, req);
          if (!highRisk.ok) { sendJson({ ok: false, error: highRisk.error, ...(highRisk.payload || {}) }, highRisk.status); return; }
          if (!featureEnabled(cfg, 'qzone') && body.dryRun !== true) {
            sendJson({ ok: false, disabled: true, reason: 'features.qzone=false', error: '空间说说总开关已关闭' }, 403);
            return;
          }
          try {
            const result = await innerLife.ownerPublishQzone(String(body.text ?? ''), {
              imageRef: String(body.image ?? ''),
              dryRun: body.dryRun === true
            });
            const ok = result.status === 'posted' || result.status === 'dry-run';
            sendJson({ ok, ...result }, ok ? 200 : 400);
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 502);
          }
          return;
        }

        // ── 语音发送（AI 通道：simulation + agent token，只能发自己那个会话） ────
        if (req.method === 'POST' && url.pathname === '/api/simulation/send-voice') {
          const body = await readBody();
          const token = String(body.token ?? req.headers['x-agent-token'] ?? '').trim();
          const key = String(body.key ?? body.target ?? '').trim();
          const voice = voiceCfg();
          if (!voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (!featureEnabled(cfg, 'voice')) { sendJson({ ok: false, disabled: true, reason: 'features.voice=false' }, 403); return; }
          if (!key) { sendJson({ ok: false, error: 'key 不能为空（格式 group:群号 或 private:QQ号）' }, 400); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          if (!token) { sendJson({ ok: false, error: 'simulation 模式发送必须携带 agent token' }, 403); return; }
          // 跨会话发语音：主人私聊令牌、或主人在本群刚下过指令的群会话令牌都允许（与文字发送对齐）。
          const voiceAccess = canActOn(key, token, { crossSession: true, route: url.pathname });
          if (!voiceAccess.ok) { sendJson({ ok: false, error: voiceAccess.error }, voiceAccess.status); return; }
          if (!simulationToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          if (!simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          // 只要名字（解析）不要内容（预览）：dry-run 也必须经过与真发相同的解析与校验。
          let resolved;
          try {
            resolved = resolveSimulationVoicePath(body.voice ?? body.file ?? '');
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
            return;
          }
          try {
            voiceBudgetCheck(key, voice);
            if (body.dryRun === true) {
              const probe = await inspectAudio(resolved.path, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
              if (!probe.ok) { sendJson({ ok: false, error: probe.error }, 400); return; }
              sendJson({ ok: true, dryRun: true, key, file: resolved.path, detail: describeAudio(probe) });
              return;
            }
            const sent = await sendVoiceForConversation(key, body.voice ?? body.file, {
              label: body.label ? String(body.label).slice(0, 100) : '',
              verify: body.verify,
              readback: body.readback === true,
              // AI 也可以调音量（默认走 config 的 defaultVolume）
              audio: (body.volume !== undefined || body.normalize === true || body.loudness !== undefined)
                ? { volume: body.volume, normalize: body.normalize === true, loudness: body.loudness }
                : null
            });
            sendJson({
              ok: true,
              key,
              messageId: sent.messageId,
              file: path.basename(sent.file),
              detail: sent.detail,
              audioProcessing: sent.audioProcessing,
              // verified=true 表示已用 get_msg 回读到这条消息的 record 段（"真的发出去了"的硬证据）
              verified: sent.verification?.confirmed === true,
              readback: sent.readback,
              warnings: sent.warnings
            });
          } catch (error) {
            // 额度只在真正发出后才记账（voiceBudgetCommit），所以失败路径无需回滚。
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }

        // ── 通用图片库：列表 / 发送 / 保存 ────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/simulation/images') {
          if (!imageEnabled()) { sendJson({ ok: false, error: '图片库已关闭（simulation.imageLibrary.enabled=false）' }, 403); return; }
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const key = String(url.searchParams.get('key') ?? '').trim();
          if (currentMode === 'simulation' && !agentToken) { sendJson({ ok: false, error: 'simulation 模式读取图片库必须携带 agent token' }, 403); return; }
          if (agentToken && !agentTokenOk(key, agentToken)) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentToken && !simulationToolEnabled('listImages')) { sendJson({ ok: false, error: '工具未启用：qq_list_images' }, 403); return; }
          const query = String(url.searchParams.get('query') ?? '').trim();
          const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
          const list = searchImages(imageEntries, query, { limit });
          sendJson({
            ok: true,
            total: imageEntries.length,
            count: list.length,
            entries: list.map((e) => ({ id: e.id, name: e.name, note: e.note, tags: e.tags, bytes: e.bytes, mime: e.mime, sourceUrl: e.sourceUrl, useCount: e.useCount })),
            formatted: formatImageList(list, limit)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/send-image') {
          if (!imageEnabled()) { sendJson({ ok: false, error: '图片库已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const imageRef = String(body.image ?? '').trim();
          const caption = stripTrailingPeriod(String(body.caption ?? '').trim());
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !imageRef) { sendJson({ ok: false, error: 'key 和 image 不能为空' }, 400); return; }
          const imageAccess = req.headers['x-agent-token'] ? canActOn(key, req.headers['x-agent-token'], { crossSession: true, route: url.pathname }) : null;
          if (imageAccess && !imageAccess.ok) { sendJson({ ok: false, error: imageAccess.error }, imageAccess.status); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('sendImage')) { sendJson({ ok: false, error: '工具未启用：qq_send_image' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'simulation 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const targetId = Number(keyMatch[2]);
          if (!Number.isFinite(targetId) || targetId <= 0 || !modeAllowed(key, kind, targetId, cfg, currentMode)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSimulationState(key);
            const resolved = await resolveReplyTarget(stForReply, kind, targetId, String(replyToMessageId).trim());
            if (!resolved) { sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话' }, 400); return; }
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.simulation?.send ?? {};
          const now = Date.now();
          try {
            const st = getSimulationState(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendImage(key, imageRef, { caption, replyToMessageId: actualReplyToMessageId, atUserId });
            const label = sent.entry?.note || sent.entry?.name || '图片';
            const text = `[图片:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              isSelf: true,
              image: { id: sent.entry?.id || '', name: sent.entry?.name || '', note: sent.entry?.note || '' },
              time: now
            });
            if (st.recentMessages.length > 200) st.recentMessages = st.recentMessages.slice(-200);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            noteImageSent(st);
            saveSimulationState();
            scheduleReplyCheck(key);
            appendActivity(`${key} [图片] 发送 ${label}`);
            sendJson({ ok: true, key, messageId: sent.messageId, image: sent.entry.name, note: sent.entry.note });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/save-image') {
          if (!imageEnabled()) { sendJson({ ok: false, error: '图片库已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageId = String(body.messageId ?? '').trim();
          const url2 = String(body.url ?? '').trim();
          const name = String(body.name ?? '').trim();
          const note = String(body.note ?? '').trim();
          const tags = Array.isArray(body.tags) ? body.tags : String(body.tags ?? '').split(/[,，\s]+/).filter(Boolean);
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('saveImage')) { sendJson({ ok: false, error: '工具未启用：qq_save_image' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'simulation 模式保存必须携带 agent token' }, 403); return; }
          if (!key || (!messageId && !url2)) { sendJson({ ok: false, error: 'key 与（messageId 或 url）不能为空' }, 400); return; }
          try {
            const { buffer, sourceUrl } = await fetchImageBytesForSave({ key, messageId, url: url2 });
            const result = addImageBuffer({ dir: imageLibraryDir(), entries: imageEntries, buffer, name, note, tags, sourceUrl, subdir: 'saved', origin: 'saved' });
            saveImageStoreSafe();
            sendJson({
              ok: true,
              created: result.created,
              image: { id: result.entry.id, name: result.entry.name, note: result.entry.note, tags: result.entry.tags, mime: result.entry.mime, bytes: result.entry.bytes }
            });
          } catch (error) {
            sendJson({ ok: false, error: error?.message ?? String(error) }, 400);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/api/library/stickers/') && url.pathname.endsWith('/image')) {
          const id = decodeURIComponent(url.pathname.slice('/api/library/stickers/'.length, -'/image'.length));
          try {
            const entry = await getStickerImageData(id);
            const fetched = await safeFetchBuffer(entry.url, MAX_MEDIA_BYTES);
            const mimeType = mimeFromBuffer(fetched.buffer) || 'image/png';
            res.writeHead(200, {
              'content-type': mimeType,
              'content-length': fetched.buffer.length,
              'cache-control': 'private, max-age=600',
              ...SECURITY_HEADERS
            });
            res.end(fetched.buffer);
          } catch (error) {
            sendJson({ ok: false, error: `读取表情缩略图失败：${error?.message ?? error}` }, 404);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/library/images/update') {
          const body = await readBody();
          const id = String(body.id ?? '').trim();
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          const idx = imageEntries.findIndex((e) => String(e.id) === id);
          if (idx < 0) { sendJson({ ok: false, error: '图片不存在' }, 404); return; }
          const entry = imageEntries[idx];
          const next = {
            ...entry,
            name: body.name !== undefined ? String(body.name).replace(/\s+/g, ' ').trim().slice(0, 60) : entry.name,
            note: body.note !== undefined ? String(body.note).replace(/\s+/g, ' ').trim().slice(0, 120) : entry.note,
            tags: body.tags !== undefined
              ? (Array.isArray(body.tags) ? body.tags : String(body.tags).split(/[,，、\s]+/)).map((t) => String(t).trim()).filter(Boolean).slice(0, 8)
              : entry.tags,
            updatedAt: new Date().toISOString()
          };
          imageEntries[idx] = next;
          saveImageStoreSafe();
          sendJson({ ok: true, image: { id: next.id, name: next.name, note: next.note, tags: next.tags } });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/library/images') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 100));
          const list = searchImages(imageEntries, query, { limit });
          sendJson({
            ok: true,
            total: imageEntries.length,
            count: list.length,
            entries: list.map((e) => ({
              id: e.id,
              name: e.name,
              note: e.note,
              tags: e.tags,
              mime: e.mime,
              bytes: e.bytes,
              width: e.width,
              height: e.height,
              useCount: e.useCount,
              createdAt: e.createdAt,
              url: `/api/library/images/${encodeURIComponent(e.id)}`
            }))
          });
          return;
        }
        if (req.method === 'GET' && url.pathname.startsWith('/api/library/images/')) {
          const id = decodeURIComponent(url.pathname.slice('/api/library/images/'.length));
          const entry = findImage(imageEntries, id);
          if (!entry) { sendJson({ ok: false, error: '图片不存在' }, 404); return; }
          try {
            const abs = imageFilePath(imageLibraryDir(), entry);
            const buf = fs.readFileSync(abs);
            res.writeHead(200, {
              'content-type': entry.mime || 'application/octet-stream',
              'content-length': buf.length,
              'cache-control': 'private, max-age=300',
              ...SECURITY_HEADERS
            });
            res.end(buf);
          } catch (error) {
            sendJson({ ok: false, error: `读取图片失败：${error?.message ?? error}` }, 404);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/delete-image') {
          if (!imageEnabled()) { sendJson({ ok: false, error: '图片库已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const imageRef = String(body.image ?? '').trim();
          const quotedId = String(body.messageId ?? '').trim();
          if (!key || (!imageRef && !quotedId)) { sendJson({ ok: false, error: 'key 和（image 或 messageId）不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('deleteImage')) { sendJson({ ok: false, error: '工具未启用：qq_delete_image' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'simulation 模式删除必须携带 agent token' }, 403); return; }
          if (!isOwnerMediaContext(key)) { sendJson({ ok: false, error: '删除图片只允许主人在自己的私聊或本人最后发言的会话里操作' }, 403); return; }
          let target = imageRef;
          if (!target && quotedId) {
            const quoted = mediaRefFromQuoted(key, quotedId);
            if (!quoted || !quoted.self || quoted.kind !== 'image') {
              sendJson({ ok: false, error: '被回复的消息不是当前角色发的图片，或无法解析' }, 400);
              return;
            }
            target = quoted.ref;
          }
          try {
            const entry = deleteImage(target);
            sendJson({ ok: true, key, image: { id: entry.id, name: entry.name, note: entry.note } });
          } catch (error) {
            if (error?.code === 'AMBIGUOUS') {
              sendJson({ ok: false, error: error.message, candidates: error.candidates || [] }, 409);
            } else {
              sendJson({ ok: false, error: `删除图片失败：${error?.message ?? error}` }, 500);
            }
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/send-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const stickerId = String(body.stickerId ?? '').trim();
          const caption = String(body.message ?? body.caption ?? '').trim();
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          if (!key || !stickerId) { sendJson({ ok: false, error: 'key 和 stickerId 不能为空' }, 400); return; }
          // 仿真常识：表情消息只能是一张表情，不能在同一气泡里附带文字说明。
          if (caption) {
            sendJson({ ok: false, error: '表情消息不能附带文字；请先用 qq_send_message / qq_reply 把想说的话作为单独气泡发送，再单独 qq_send_sticker 发表情' }, 400);
            return;
          }
          const stickerAccess = req.headers['x-agent-token'] ? canActOn(key, req.headers['x-agent-token'], { crossSession: true, route: url.pathname }) : null;
          if (stickerAccess && !stickerAccess.ok) { sendJson({ ok: false, error: stickerAccess.error }, stickerAccess.status); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('sendSticker')) { sendJson({ ok: false, error: '工具未启用：qq_send_sticker' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '该接口仅 simulation 模式可用' }, 403); return; }
          if (!req.headers['x-agent-token']) { sendJson({ ok: false, error: 'simulation 模式发送必须携带 agent token' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (kind === 'private' && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (shouldBlockSilentReply(key)) { sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403); return; }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSimulationState(key);
            const resolved = await resolveReplyTarget(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.simulation?.send ?? {};
          const now = Date.now();
          try {
            const st = getSimulationState(key);
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sent = await sendSticker(key, stickerId, {
              replyToMessageId: actualReplyToMessageId,
              atUserId
            });
            // 记录到仿真会话的 recentMessages，让 AI 知道自己发过这个表情
            const label = sent.entry?.desc || sent.entry?.localNote || '表情包';
            const text = `[表情包:${label}]`;
            st.recentMessages.push({
              messageId: sent.messageId ? String(sent.messageId) : null,
              sender: '我',
              text: truncateText(text, 200),
              plain: truncateText(text, 200),
              quoteTargetIsSelf: false,
              isOwner: true,
              ownerLabel: '我',
              isSelf: true,
              media: [],
              hasMedia: false,
              forwardIds: [],
              hasForward: false,
              sticker: { id: sent.entry?.id || stickerId, desc: sent.entry?.desc || '', localNote: sent.entry?.localNote || '' },
              time: Date.now()
            });
            const recentLimit = Number(cfg.simulation?.context?.recentLimit) || 100;
            if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            st.preSleepWaitSatisfiedAt = 0;
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
            noteStickerSent(st);
            saveSimulationState();
            scheduleReplyCheck(key);
            log(`[sticker] 工具发送表情 ${key}: ${sent.entry?.id || stickerId}`);
            appendActivity(`${key} [sticker] 工具发送表情：${label}`);
            sendJson({ ok: true, key, sticker: sent.entry, sent: 1, failed: 0, quoted: quotedInfo });
          } catch (error) {
            const st = getSimulationState(key);
            const idx = st.sendTimes.indexOf(now);
            if (idx >= 0) st.sendTimes.splice(idx, 1);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSimulationState();
            log(`[sticker] 工具发送表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `发送表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/collect-sticker') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const messageRef = String(body.messageId ?? body.seq ?? '').trim();
          const remark = String(body.remark ?? '').trim();
          if (!key || !messageRef) { sendJson({ ok: false, error: 'key 和 messageId/seq 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('collectSticker')) { sendJson({ ok: false, error: '工具未启用：qq_collect_sticker' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const st = getSimulationState(key);
          const collectCfg = cfg.simulation?.sticker?.collect ?? {};
          if (collectCfg.enabled === false) { sendJson({ ok: false, error: 'AI 收藏表情功能已关闭' }, 403); return; }
          const now = Date.now();
          const maxPerMinute = Math.max(0, Number(collectCfg.maxPerMinute) || 0);
          const maxPerHour = Math.max(0, Number(collectCfg.maxPerHour) || 0);
          const recentMinute = (st.stickerCollectTimes || []).filter((t) => now - t < 60000).length;
          const recentHour = (st.stickerCollectTimes || []).filter((t) => now - t < 3600000).length;
          if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
            sendJson({ ok: false, error: '收藏表情太频繁了，请过一会儿再偷图' }, 429);
            return;
          }
          // 先预占收藏次数，避免并发调用绕过限频；失败时回滚。
          st.stickerCollectTimes = st.stickerCollectTimes || [];
          st.stickerCollectTimes.push(now);
          if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
          try {
            const result = await collectSticker(key, messageRef, remark);
            saveSimulationState();
            if (result.pending) {
              log(`[sticker] AI 收藏表情排队补收 ${key}: ${result.message}`);
              appendActivity(`${key} [sticker] AI 收藏表情排队补收：${result.message}`);
              sendJson({ ok: true, pending: true, key, message: result.message, remark: result.remark });
              return;
            }
            log(`[sticker] AI 收藏表情 ${key}: ${result.emojiId}${result.remark ? '（备注：' + result.remark + '）' : ''}`);
            appendActivity(`${key} [sticker] AI 收藏表情：${result.remark || result.emojiId}`);
            sendJson({ ok: true, key, sticker: result.entry, emojiId: result.emojiId, remark: result.remark });
          } catch (error) {
            const idx = st.stickerCollectTimes.indexOf(now);
            if (idx >= 0) st.stickerCollectTimes.splice(idx, 1);
            if (st.stickerCollectTimes.length > 500) st.stickerCollectTimes = st.stickerCollectTimes.slice(-500);
            saveSimulationState();
            log(`[sticker] AI 收藏表情失败 ${key}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `收藏表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 语音库列表。两条通道共用：
        //   - 带 agent token（AI 的 qq_list_voices）→ 必须带 key，校验会话白名单/工具开关；
        //   - 不带 agent token（控制台调试面板 / CLI）→ 只需控制台令牌，不需要 key。
        // 返回一律只有文件名/大小/时长，**不含绝对路径**（AI 侧防路径外泄，控制台侧由试发接口解析）。
        if (req.method === 'GET' && (url.pathname === '/api/simulation/voices' || url.pathname === '/api/voice/list')) {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const voice = voiceCfg();
          const agentCall = Boolean(req.headers['x-agent-token']);
          // 与发送接口同样的分层：voice.enabled 只关 AI 通道；操作者（控制台面板）仍可列语音库。
          if (agentCall && !voice.enabled) { sendJson({ ok: false, error: '语音功能已关闭' }, 403); return; }
          if (agentCall && !featureEnabled(cfg, 'voice')) { sendJson({ ok: false, disabled: true, reason: 'features.voice=false' }, 403); return; }
          if (agentCall && !key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (agentCall && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (agentCall && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (agentCall && !simulationToolEnabled('sendVoice')) { sendJson({ ok: false, error: '工具未启用：qq_send_voice' }, 403); return; }
          const wantProbe = url.searchParams.get('probe') !== '0';
          try {
            const files = listAudioFiles(voice.dir);
            const items = [];
            for (const f of files.slice(0, 100)) {
              const entry = { name: path.relative(voice.dir, f).split(path.sep).join('/') };
              if (wantProbe) {
                const info = await inspectAudio(f, { maxBytes: voice.maxBytes, maxSeconds: voice.maxSeconds });
                entry.ok = info.ok;
                entry.bytes = info.size;
                entry.detail = info.ok ? describeAudio(info) : null;
                entry.seconds = info.duration ?? null;
                if (!info.ok) entry.error = info.error;
              }
              items.push(entry);
            }
            sendJson({
              ok: true,
              key: key || null,
              dir: agentCall ? undefined : voice.dir,
              count: items.length,
              voices: items,
              limits: { maxSeconds: voice.maxSeconds, maxBytes: voice.maxBytes, maxPerMinute: voice.maxPerMinute, maxPerHour: voice.maxPerHour },
              // ⚠️ 提示语里也不能出现绝对路径：AI 通道下同样要脱敏（dir 字段已经抑制了，
              // 但这里的模板字符串曾无条件插值 voice.dir —— 等于从旁边的字段又漏出去一次）。
              hint: items.length
                ? '用 qq_send_voice 传 name 即可把其中一个当语音发出去'
                : (agentCall ? '语音库为空：请让管理员先把音频放进语音库' : `语音库为空：把音频文件放进 ${voice.dir} 后重试`)
            });
          } catch (error) {
            sendJson({ ok: false, error: `读取语音库失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        if (req.method === 'GET' && url.pathname === '/api/simulation/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const key = String(url.searchParams.get('key') ?? '').trim();
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.simulation?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 上**不再支持** refresh：强制同步是有副作用的写操作（拉 OneBot 收藏表情并落盘），
          // 挂在 GET 上会绕开「非 GET 必须 application/json + 同源 Origin」的 CSRF 防护。
          // 需要强制同步时请用同一路径的 POST，或控制台的 POST /api/stickers/sync。
          const force = false;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/sticker-list') {
          if (!stickerEnabled()) { sendJson({ ok: false, error: '表情包体系已关闭' }, 403); return; }
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const query = String(body.query ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.simulation?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(body.count) || 48, maxCount)));
          let force = body.refresh === true;
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('listStickers')) { sendJson({ ok: false, error: '工具未启用：qq_list_stickers' }, 403); return; }
          // AI 强制刷新加最小间隔，避免反复调用 OneBot 表情接口造成限频/负载。
          if (req.headers['x-agent-token'] && force) {
            const now = Date.now();
            if (now - lastForcedAgentStickerSync < 10000) force = false;
            else lastForcedAgentStickerSync = now;
          }
          try {
            const synced = await syncStickerLibrary(force);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, key, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情列表失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // 管理端表情库接口（控制台）
        if (req.method === 'GET' && url.pathname === '/api/stickers') {
          const query = String(url.searchParams.get('query') ?? '').trim();
          const maxCount = Math.max(1, Number(cfg.simulation?.sticker?.maxListCount) || 100);
          const count = Math.min(500, Math.max(1, Math.min(Number(url.searchParams.get('count')) || 48, maxCount)));
          // GET 不再触发强制同步（写副作用不能挂在读接口上）：请用 POST /api/stickers/sync。
          try {
            const synced = await syncStickerLibrary(false);
            const list = formatStickerList(synced?.entries ?? stickerEntries, query, count);
            sendJson({ ok: true, ...list, syncedAt: synced?.syncedAt ?? stickerSyncedAt, fromCache: synced?.fromCache ?? false, writable: stickerStoreWritable });
          } catch (error) {
            sendJson({ ok: false, error: `获取表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/sync') {
          try {
            const synced = await syncStickerLibrary(true);
            sendJson({ ok: true, total: synced?.entries?.length ?? stickerEntries.length, syncedAt: synced?.syncedAt ?? stickerSyncedAt });
          } catch (error) {
            sendJson({ ok: false, error: `同步表情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/note') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          const note = body.note !== undefined && body.note !== null ? String(body.note).trim().slice(0, 200) : undefined;
          const tags = body.tags !== undefined && body.tags !== null ? (Array.isArray(body.tags) ? body.tags.map(String).map((s) => s.trim()).filter(Boolean).slice(0, 20) : []) : undefined;
          const usage = body.usage !== undefined && body.usage !== null ? String(body.usage).trim().slice(0, 200) : undefined;
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          const entry = applyStickerNoteToStore(stickerId, note, tags, usage);
          if (!entry) { sendJson({ ok: false, error: `找不到表情 ${stickerId}` }, 404); return; }
          sendJson({ ok: true, sticker: entry });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/stickers/remark') {
          const body = await readBody();
          const stickerId = String(body.stickerId ?? '').trim();
          if (!stickerId) { sendJson({ ok: false, error: 'stickerId 不能为空' }, 400); return; }
          try {
            const entry = await setStickerRemark(stickerId, String(body.remark ?? ''));
            sendJson({ ok: true, sticker: entry });
          } catch (error) {
            sendJson({ ok: false, error: `修改备注失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/wait') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (body.purpose !== undefined && !['messages', 'reply'].includes(body.purpose)) {
            sendJson({ ok: false, error: 'purpose 必须是 messages（等后续消息）或 reply（回复前短静默）' }, 400);
            return;
          }
          const replyWait = body.purpose === 'reply';
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('waitMessages')) { sendJson({ ok: false, error: '工具未启用：qq_wait_for_messages' }, 403); return; }
          if (simulation.paused) {
            const st = getSimulationState(key);
            sendJson({ ok: true, key, paused: true, arrived: false, timeout: false, waitedMs: 0, newMessages: [], readThroughSeq: computeReadThroughSeq(st), unreadCount: st.unread.length });
            return;
          }
          const waitCfg = cfg.simulation?.wait ?? {};
          const minNew = Math.max(1, Math.round(Number(body.minNewMessages) || 1));
          const defaultMs = Number(waitCfg.defaultMs) || 30000;
          const minMs = Math.max(100, Number(waitCfg.minMs) || 5000);
          const maxMs = Math.max(minMs, Number(waitCfg.maxMs) || 600000);
          const timeoutMs = Math.min(maxMs, Math.max(minMs, Math.round(Number(body.timeoutMs) || defaultMs)));
          const st = getSimulationState(key);
          // 同一会话只允许一个长轮询等待，避免并发挂起耗尽 HTTP handler。
          // 租约按**归一后的** key 记账：`group:0123` 与 `group:123` 是同一个会话，
          // 用原始 key 会给出两个租约槽（同一会话并发多个 5~10 分钟等待、互相踩水位）。
          // 租约过期则视为残留（handler 异常退出没清干净），允许接管而不是永久 429。
          const leaseKey = canonicalSimulationKey(key) ?? key;
          if (activeWaits.has(leaseKey) && Date.now() - activeWaits.get(leaseKey) < ACTIVE_WAIT_LEASE_MS) {
            sendJson({ ok: false, error: '该会话已有一个等待中的 qq_wait_for_messages，请等待它结束' }, 429);
            return;
          }
          const leaseStamp = Date.now();
          activeWaits.set(leaseKey, leaseStamp);
          // 只由「自己那一份租约」负责删除：超时接管后，旧等待结束时不能把新租约删掉。
          const finishWait = () => { if (activeWaits.get(leaseKey) === leaseStamp) activeWaits.delete(leaseKey); };
          req.on('close', finishWait);
          // 响应关闭也兜底清租约：handler 中途抛错时由外层 catch 回一个 JSON，
          // 那条路径不会经过下面的 finishWait()，会留下 15 分钟的假 429。
          res.on('close', finishWait);
          const minQuietAfterNewMs = Number.isFinite(Number(waitCfg.minQuietAfterNewMs)) ? Math.max(0, Number(waitCfg.minQuietAfterNewMs)) : 10000;
          const suggestedQuietMs = Math.max(suggestQuietMs(st), minQuietAfterNewMs);
          const rawQuietMs = body.quietMs != null ? Number(body.quietMs) : suggestedQuietMs;
          // 收到新消息后至少再等 minQuietAfterNewMs（默认 10 秒），防止抢话；
          // 即使 AI 传了 quietMs=0，也会被抬升到最小静默窗口。
          // 同时给 quietMs 加上限，避免被模型/群友诱导导致 HTTP handler 长时间挂起。
          const maxQuietMs = Math.max(minQuietAfterNewMs, Math.min(120000, Number(waitCfg.maxMs) || 600000));
          const quietMs = Math.min(maxQuietMs, Math.max(minQuietAfterNewMs, Math.round(rawQuietMs) || 0));
          if (st.pendingWakeTimer) {
            clearTimeout(st.pendingWakeTimer);
            st.pendingWakeTimer = null;
          }
          cancelReplyCheck(key); // AI 正在主动等待，取消回复检查定时器避免重复唤醒
          // A reply wait must also include messages received while the model
          // was reading/thinking after its snapshot, before this HTTP request.
          const requestSeq = st.lastUnreadSeq || 0;
          const baseline = replyWait && (simulationToolEnabled('getUnread') || simulationToolEnabled('getRecent')) ? computeReadThroughSeq(st) : requestSeq;
          // 首答前的长等待硬闸：还有未处理消息、且本回合还没发过言时，不允许用
          // purpose=messages 等 30s 以上。模型曾把 5 分钟睡前观察放在首答前，
          // 导致用户看到「消失几分钟后突然回一批」。
          const preReplyUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && !m.isSelf).length : 0;
          const canonicalKey = canonicalSimulationKey(key) ?? key;
          const sessionIdForGuard = state.sessions[key] || state.sessions[canonicalKey] || null;
          const sentThisTurn = sessionIdForGuard ? sendToolSucceededSessions.has(sessionIdForGuard) : false;
          if (!replyWait && timeoutMs > 30000 && preReplyUnread > 0 && !sentThisTurn) {
            finishWait();
            const guardMessages = st.unread
              .filter((m) => m && !m.isSelf)
              .slice(0, 10)
              .map((m) => ({
                seq: m.seq,
                messageId: m.messageId ?? null,
                sender: m.sender || '群友',
                text: String(m.text || m.plain || '').slice(0, 200),
                time: m.time || 0
              }));
            log(`[simulation] 拦截首答前长等待 ${key}：未读 ${preReplyUnread} 条，timeoutMs=${timeoutMs}，本回合尚未发言`);
            sendJson({
              ok: true,
              key,
              guard: 'must-reply-first',
              mustReplyFirst: true,
              arrived: true,
              timeout: false,
              waitedMs: 0,
              newMessages: guardMessages,
              unreadCount: preReplyUnread,
              readThroughSeq: computeReadThroughSeq(st),
              note: '你还有未处理的消息：先回复这些消息，再考虑沉睡前观察。长等待已拦截。'
            });
            return;
          }
          const start = Date.now();
          let arrived = false;
          let lastNewAt = 0;
          let aborted = false;
          req.on('close', () => { aborted = true; });
          if (replyWait) {
            const incomingAt = () => {
              const value = Number(st.lastIncomingAt);
              return Number.isFinite(value) && value > 0 ? Math.min(value, Date.now()) : start;
            };
            lastNewAt = incomingAt();
            let observedSeq = st.lastUnreadSeq || 0;
            // Batch delay and model reading time already count towards quiet.
            // New arrivals restart quiet, but timeoutMs remains a hard budget.
            while (!aborted && Date.now() - start < timeoutMs) {
              if ((st.lastUnreadSeq || 0) !== observedSeq) {
                observedSeq = st.lastUnreadSeq || 0;
                lastNewAt = incomingAt();
              }
              const remaining = quietMs - (Date.now() - lastNewAt);
              if (remaining <= 0) break;
              await sleep(Math.max(1, Math.min(100, remaining, timeoutMs - (Date.now() - start))));
            }
            // A message may arrive during the final sleep, exactly at timeout.
            // Its timestamp must still invalidate the previous quiet window.
            lastNewAt = incomingAt();
            arrived = (st.lastUnreadSeq || 0) > baseline;
          } else while (Date.now() - start < timeoutMs && !aborted) {
            let nowSeq = st.lastUnreadSeq || 0;
            if (nowSeq - baseline >= minNew) {
              arrived = true;
              lastNewAt = Date.now();
              // 已等到新消息：继续等到“最后一条新消息之后 quietMs 内不再有新消息”再返回。
              // 这里不再受原始 timeoutMs 限制，确保对方可能连续发消息时不会抢话。
              while (Date.now() - lastNewAt < quietMs && Date.now() - start < timeoutMs + maxQuietMs + 5000 && !aborted) {
                if ((st.lastUnreadSeq || 0) > nowSeq) {
                  nowSeq = st.lastUnreadSeq || 0;
                  lastNewAt = Date.now();
                }
                await sleep(200);
              }
              break;
            }
            await sleep(300);
          }
          const waitedMs = Date.now() - start;
          if (simulation.conversations.get(canonicalSimulationKey(key)) !== st ||
              (req.headers['x-agent-token'] && (currentMode !== 'simulation' || simulation.paused || cfg.simulation?.enabled === false
                || !agentTokenOk(key, req.headers['x-agent-token']) || !simulationSessionAllowed(key) || !simulationToolEnabled('waitMessages')))) {
            finishWait();
            sendJson({ ok: false, error: '等待期间会话已重置或权限已变化，请重新读取会话' }, 403);
            return;
          }
          const preSleepWaitMs = Math.max(0, Number(cfg.simulation?.wake?.preSleepWaitMs) || 300000);
          const preSleepRemainingMs = preSleepWaitBlocked(st)
            ? Math.max(0, preSleepWaitMs - ((st.lastIncomingAt || 0) ? Date.now() - st.lastIncomingAt : 0))
            : 0;
          const quiet = (replyWait || (arrived && quietMs > 0)) && (Date.now() - lastNewAt >= quietMs);
          // 判断这次等待是否是“沉睡前观察尝试”：AI 明确请求等满观察窗口（默认 5 分钟）。
          // 只有这种尝试里等到新消息，才会把“已观察并看到新消息”标记下来，允许 AI 看过新消息后直接决定不参与并沉睡。
          const preSleepAttempt = !replyWait && timeoutMs >= preSleepWaitMs;
          // 只有“没等到新消息且总时长达到观察窗口”或“最后一条新消息之后安静满了观察窗口”才算满足沉睡前等待；
          // 不能因为总时长到了但最后一条消息才刚过 10 秒就误判满足。
          const preSleepSatisfiedNow = !replyWait && (!arrived
            ? waitedMs >= preSleepWaitMs
            : (quiet && (Date.now() - lastNewAt) >= preSleepWaitMs));
          if (preSleepSatisfiedNow) {
            st.preSleepWaitSatisfiedAt = Date.now();
            st.preSleepWaitObservedAt = 0;
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait && !arrived) {
            // 短等待不累计：必须单次等满观察窗口（或实际安静时间已足够时由 preSleepWaitBlocked 放行）
            st.preSleepWaitAccumMs = 0;
          } else if (!replyWait) {
            // 等待期间有新消息：
            // - 如果这是一次 5 分钟沉睡前观察尝试，则标记“已观察”，AI 看过 newMessages 后可自行决定是否参与；
            // - 否则只清空累计，不算完成沉睡前观察。
            if (preSleepAttempt) {
              st.preSleepWaitObservedAt = Date.now();
            }
            st.preSleepWaitAccumMs = 0;
          }
          if (!replyWait) saveSimulationState();
          // Each buffer is governed by its own tool switch: the unread buffer by
          // getUnread, the recent buffer by getRecent. A disabled switch must not leak
          // through either newMessages or the watermark, so the buffer is dropped
          // before arrival is judged -- not filtered afterwards.
          const history = replyWait
            ? [...(simulationToolEnabled('getUnread') ? st.unread : []),
              ...(simulationToolEnabled('getRecent') ? st.recentMessages : [])]
            : (Array.isArray(st.recentMessages) ? st.recentMessages : []);
          const pending = [...new Map(history
            .filter((m) => m && !m.isSelf && (m.seq || 0) > baseline)
            .map((m) => [m.seq, m])).values()].sort((a, b) => a.seq - b.seq);
          // `arrived` is recomputed against what this request may actually hand over,
          // so a suppressed buffer cannot report an arrival it is not allowed to show.
          const newMessages = replyWait ? pending : (arrived ? pending : []);
          const readThroughSeq = req.headers['x-agent-token'] ? noteModelMessages(st, newMessages) : computeReadThroughSeq(st);
          const lastNew = newMessages.length ? newMessages[newMessages.length - 1]
            : replyWait ? [...st.recentMessages].reverse().find((m) => m && !m.isSelf) : null;
          const lastMessageUnfinished = lastNew ? looksLikeUnfinished(String(lastNew.tail || lastNew.plain || lastNew.text || '')) : false;
          finishWait();
          sendJson({
            ok: true,
            key,
            purpose: replyWait ? 'reply' : 'messages',
            arrived,
            quiet,
            quietMs,
            suggestedQuietMs,
            speakerLikelyDone: quiet,
            lastMessageUnfinished,
            timeout: replyWait ? !quiet : !arrived || (quietMs > 0 && !quiet && Date.now() - start >= timeoutMs),
            waitedMs,
            preSleepWaitSatisfied: preSleepSatisfiedNow,
            preSleepWaitObserved: !replyWait && !!st.preSleepWaitObservedAt,
            // A reply check has no sleep countdown; showing one here suggests
            // the model should complete sleep observation before its first reply.
            ...(!replyWait ? { preSleepWaitMs, preSleepWaitRemainingMs: preSleepRemainingMs } : {}),
            newMessages,
            readThroughSeq,
            unreadCount: st.unread.length
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/check-send') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const tool = String(body.tool ?? '').trim();
          const token = String(body.token ?? '').trim();
          if (!key || !tool || !token) {
            sendJson({ ok: false, error: 'key/tool/token 不能为空' }, 400);
            return;
          }
          if (!agentTokenOk(key, token)) {
            sendJson({ ok: false, error: 'agent token 无效' }, 403);
            return;
          }
          if (!simulationSessionAllowed(key)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          const flagMap = { sendGroup: 'sendGroup', sendPrivate: 'sendPrivate', reply: 'reply' };
          const flag = flagMap[tool];
          if (!flag) {
            sendJson({ ok: false, error: 'tool 必须是 sendGroup/sendPrivate/reply' }, 400);
            return;
          }
          if (!simulationToolEnabled(flag)) {
            sendJson({ ok: false, error: `工具未启用：qq_${tool === 'sendGroup' ? 'send_group_message' : tool === 'sendPrivate' ? 'send_private_message' : 'reply'}` }, 403);
            return;
          }
          sendJson({ ok: true, key, tool });
          return;
        }
        // ── Token 用量 / 花费（控制台专用） ──────────────────────────────────
        // 路径刻意不放在 /api/simulation/ 下：那一整个前缀对持有 x-agent-token 的
        // QQ 侧 AI 是放行的（见 console/policy.js 的 agentTokenAllowedPath 白名单），而跨群花费属于管理信息，
        // 不应让某个群里的 AI 读到别的群烧了多少钱。这里再显式拒绝一次做双保险。
        if (url.pathname === '/api/tokens/summary' || url.pathname.startsWith('/api/tokens/')) {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          if (req.method === 'GET' && url.pathname === '/api/tokens/summary') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            sendJson({ ...tokenLedger.summary({ limit }), ledger: tokenLedger.stats() });
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/series') {
            const hours = Math.min(24 * 90, Math.max(1, Number(url.searchParams.get('hours')) || 24));
            const maxBuckets = Math.min(120, Math.max(6, Number(url.searchParams.get('buckets')) || 48));
            sendJson(tokenLedger.series({ hours, maxBuckets }));
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/turns') {
            const key = String(url.searchParams.get('key') ?? '').trim();
            const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit')) || 200));
            const detail = tokenLedger.conversation(key, { turnLimit: limit });
            if (!detail) { sendJson({ ok: false, error: '未找到该会话的用量记录' }, 404); return; }
            sendJson(detail);
            return;
          }
          if (req.method === 'GET' && url.pathname === '/api/tokens/recent') {
            const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 50));
            sendJson({ ok: true, symbol: priceTable.symbol, entries: tokenLedger.recent(limit) });
            return;
          }
          if (req.method === 'POST' && url.pathname === '/api/tokens/reset') {
            tokenLedger.reset();
            log('控制台：token 用量账本已重置');
            sendJson({ ok: true });
            return;
          }
          sendJson({ ok: false, error: 'not found' }, 404);
          return;
        }
        // ── 工具调用日志 ─────────────────────────────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/simulation/tool-log') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit')) || 200));
          sendJson({ ok: true, entries: readToolLog(limit) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/tool-log/clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          try { fs.writeFileSync(TOOL_LOG_FILE, '', 'utf8'); } catch {}
          log('控制台：工具调用日志已清空');
          sendJson({ ok: true });
          return;
        }
        // ── 反馈 / 自己消息 / 消息详情 / 活跃成员 ────────────────────────────
        if (req.method === 'GET' && url.pathname === '/api/simulation/feedback') {
          sendJson({ ok: true, entries: readFeedbackEntries() });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/feedback-clear') {
          if (req.headers['x-agent-token']) { sendJson({ ok: false, error: '该接口仅控制台可用' }, 403); return; }
          atomicWriteJson(FEEDBACK_FILE, []);
          log('控制台：清空 AI 反馈');
          sendJson({ ok: true });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/feedback') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const level = body.level === 'warning' || body.level === 'error' ? body.level : 'info';
          const rawMessage = String(body.message ?? '').trim();
          if (!key || !rawMessage) { sendJson({ ok: false, error: 'key 和 message 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('feedback')) { sendJson({ ok: false, error: '工具未启用：qq_report_feedback' }, 403); return; }
          // 反馈限频：防止持有会话 token 的调用方刷磁盘/日志。
          const fNow = Date.now();
          const fTimes = feedbackTimes.get(key) || [];
          const fRecentMinute = fTimes.filter((t) => fNow - t < 60000).length;
          const fRecentHour = fTimes.filter((t) => fNow - t < 3600000).length;
          if (fRecentMinute >= 5 || fRecentHour >= 20) {
            sendJson({ ok: false, error: '反馈过于频繁，请稍后再试' }, 429);
            return;
          }
          fTimes.push(fNow);
          feedbackTimes.set(key, fTimes.slice(-100));
          const maxLength = Math.max(1, Number(cfg.simulation?.feedback?.maxLength) || 500);
          const message = truncateText(rawMessage, maxLength);
          appendFeedbackEntry({ id: Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8), key, level, message, time: new Date().toISOString() });
          log(`[simulation] AI 反馈 (${key}) [${level}]: ${message.slice(0, 80)}`);
          appendActivity(`${key} [simulation] AI 反馈 [${level}]：${message.slice(0, 80)}`);
          if (cfg.simulation?.feedback?.notifyOwnerOnError && level === 'error' && cfg.ownerQQ) {
            log(`[simulation] 错误级反馈，可通知 owner ${cfg.ownerQQ}（当前仅记录日志）`);
          }
          sendJson({ ok: true, key, level, message });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/my-recent') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(50, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('getMyRecent')) { sendJson({ ok: false, error: '工具未启用：qq_get_my_recent_messages' }, 403); return; }
          const st = getSimulationState(key);
          const mine = st.recentMessages.filter((m) => m.isSelf).slice(-limit);
          sendJson({ ok: true, key, messages: mine, readThroughSeq: computeReadThroughSeq(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/record-sent') {
          // 内部接口不对外开放：防止持有会话 token 的调用方伪造“我说过…”的历史记录。
          sendJson({ ok: false, error: '该接口仅桥接内部使用，不接受外部调用' }, 403);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/message-detail') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          if (!key || !messageId) { sendJson({ ok: false, error: 'key 和 messageId 不能为空' }, 400); return; }
          const detailAccess = req.headers['x-agent-token'] ? canActOn(key, req.headers['x-agent-token'], { crossSession: true, route: url.pathname }) : null;
          if (detailAccess && !detailAccess.ok) { sendJson({ ok: false, error: detailAccess.error }, detailAccess.status); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('getMessageDetail')) { sendJson({ ok: false, error: '工具未启用：qq_get_message_detail' }, 403); return; }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          try {
            const st = getSimulationState(key);
            const found = (st.recentMessages || []).find((m) => m && (String(m.seq) === messageId || (m.messageId && String(m.messageId) === messageId)));
            const forwardFields = found ? {
              forwardIds: Array.isArray(found.forwardIds) ? found.forwardIds : [],
              hasForward: !!found.hasForward
            } : {};
            let info = null;
            // 如果入参命中本地 seq 且本地存有真实 messageId，优先按 seq 展示，避免与真实 id 冲突。
            if (found && found.messageId && String(found.messageId) !== messageId) {
              info = {
                sender: String(found.sender || ''),
                text: String(found.text || found.plain || '').slice(0, 200),
                userId: found.userId ? String(found.userId) : null,
                messageId: String(found.messageId),
                seq: found.seq
              };
            } else {
              info = await resolveReplyInfo(kind, id, messageId);
              if (!info && found) {
                info = {
                  sender: String(found.sender || ''),
                  text: String(found.text || found.plain || '').slice(0, 200),
                  userId: found.userId ? String(found.userId) : null,
                  messageId: found.messageId ? String(found.messageId) : null,
                  seq: found.seq
                };
              }
            }
            // 无论 info 来自本地还是 OneBot，只要本地有 found 就补充转发字段，避免提示词与实现不一致。
            if (info && found) Object.assign(info, forwardFields);
            // 正文本就是 200 字符预览；显式告知截断，避免模型把预览当成全文。
            if (info) info.textTruncated = String(info.text ?? '').length >= 200;
            sendJson({ ok: true, key, messageId, info });
          } catch (error) {
            sendJson({ ok: false, error: `获取消息详情失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        // ── 合并转发消息查询端点（MCP qq_get_forward_msg 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/simulation/forward-message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const id = String(url.searchParams.get('id') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!id) { sendJson({ ok: false, error: 'id 不能为空' }, 400); return; }
          if (currentMode !== 'simulation') {
            sendJson({ ok: false, error: '合并转发查看仅 simulation 模式可用' }, 403);
            return;
          }
          if (!agentToken) {
            sendJson({ ok: false, error: 'simulation 模式读取合并转发必须携带 agent token' }, 403);
            return;
          }
          const forwardAccess = canActOn(key, agentToken, { crossSession: true, route: url.pathname });
          if (!forwardAccess.ok) {
            sendJson({ ok: false, error: forwardAccess.error }, forwardAccess.status);
            return;
          }
          const kind = keyMatch[1];
          const num = Number(keyMatch[2]);
          if (!Number.isFinite(num) || num <= 0 || !modeAllowed(key, kind, num, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (!simulationToolEnabled('getForwardMsg')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403);
            return;
          }
          // 安全边界：只允许读取本会话确实收到过的 forward id，防止 AI 任意探测/跨会话读取
          const st = getSimulationState(key);
          const seenInRecent = (st?.recentMessages || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInUnread = (st?.unread || []).some((m) => Array.isArray(m?.forwardIds) && m.forwardIds.includes(id));
          const seenInMemory = seenForwardIds.get(key)?.has(id) === true;
          if (!seenInRecent && !seenInUnread && !seenInMemory) {
            sendJson({ ok: false, error: '该转发消息 id 不在当前会话可见范围内，拒绝读取' }, 404);
            return;
          }
          try {
            const data = await bot.raw('get_forward_msg', { id });
            const formatted = formatForwardResponse(data);
            const remember = (fid) => {
              if (!fid) return;
              let set = seenForwardIds.get(key);
              if (!set) {
                set = new Set();
                seenForwardIds.set(key, set);
              }
              set.add(fid);
              if (set.size > 1000) {
                for (const old of set) {
                  set.delete(old);
                  if (set.size <= 1000) break;
                }
              }
            };
            // 把本层出现的嵌套 forward id 登记为“本会话已见过”，AI 后续可直接再次读取。
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) remember(fid);
            }
            // 抓取嵌套转发的前几条作为预览，让 AI 不需要二次调用也能先看到内容。
            const nestedPreviews = [];
            const nestedIds = [];
            const seenNested = new Set();
            for (const m of formatted.messages || []) {
              for (const fid of m.nestedForwardIds || []) {
                if (!seenNested.has(fid) && nestedIds.length < 5) {
                  seenNested.add(fid);
                  nestedIds.push(fid);
                }
              }
            }
            for (const fid of nestedIds) {
              try {
                const ndata = await bot.raw('get_forward_msg', { id: fid });
                const nfmt = formatForwardResponse(ndata, { maxMessages: 3, maxCharsPerMessage: 120 });
                for (const nm of nfmt.messages || []) {
                  for (const nfid of nm.nestedForwardIds || []) remember(nfid);
                }
                nestedPreviews.push({ id: fid, ...nfmt });
              } catch (error) {
                log(`嵌套转发预览失败 ${key} ${fid}:`, error?.message ?? error);
                nestedPreviews.push({ id: fid, error: error?.message ?? '嵌套转发读取失败' });
              }
            }
            sendJson({ ok: true, key, id, ...formatted, nestedPreviews });
          } catch (error) {
            log(`合并转发查询失败 ${key} ${id}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `合并转发查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/forward-media') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const media = Array.isArray(body.media) ? body.media : [];
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const forwardMediaAccess = req.headers['x-agent-token'] ? canActOn(key, req.headers['x-agent-token'], { crossSession: true, route: url.pathname }) : null;
          if (forwardMediaAccess && !forwardMediaAccess.ok) { sendJson({ ok: false, error: forwardMediaAccess.error }, forwardMediaAccess.status); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('getForwardMsg')) { sendJson({ ok: false, error: '工具未启用：qq_get_forward_msg' }, 403); return; }
          if (currentMode !== 'simulation') { sendJson({ ok: false, error: '转发媒体读取仅 simulation 模式可用' }, 403); return; }
          if (!media.length) { sendJson({ ok: true, key, media: [], images: [] }); return; }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, key, media, images });
          } catch (error) {
            log(`转发媒体读取失败 ${key}:`, error?.message ?? error);
            sendJson({ ok: false, error: `转发媒体读取失败：${error?.message ?? error}` }, 500);
          }
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/active-members') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const limit = Math.min(20, Math.max(1, Number(url.searchParams.get('limit')) || 10));
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          const membersAccess = req.headers['x-agent-token'] ? canActOn(key, req.headers['x-agent-token'], { crossSession: true, route: url.pathname }) : null;
          if (membersAccess && !membersAccess.ok) { sendJson({ ok: false, error: membersAccess.error }, membersAccess.status); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('getActiveMembers')) { sendJson({ ok: false, error: '工具未启用：qq_get_active_members' }, 403); return; }
          const st = getSimulationState(key);
          const map = new Map();
          for (const m of st.recentMessages) {
            if (!m || m.isSelf) continue;
            const uid = m.userId ? String(m.userId) : '';
            const key2 = uid || String(m.sender || '未知');
            const cur = map.get(key2) || { sender: m.sender || key2, userId: uid || undefined, count: 0, lastTime: 0, isOwner: !!m.isOwner };
            if (!cur.userId && uid) cur.userId = uid;
            cur.count += 1;
            if (m.time > cur.lastTime) cur.lastTime = m.time;
            if (m.isOwner) cur.isOwner = true;
            map.set(key2, cur);
          }
          const members = [...map.values()].sort((a, b) => b.count - a.count || b.lastTime - a.lastTime).slice(0, limit);
          sendJson({ ok: true, key, members });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/memory-append') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const extra = body.extra && typeof body.extra === 'object' ? body.extra : {};
          if (!key || !category || !content) { sendJson({ ok: false, error: 'key/category/content 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression', 'personalFact'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / personalFact' }, 400); return; }
          if (category === 'memberImpression' && !String(extra.target || '').trim()) { sendJson({ ok: false, error: 'memberImpression 需要 extra.target 指定群友名字' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_append' }, 403); return; }
          const st = getSimulationState(key);
          appendMemory(st, category, content, { ...extra, key });
          sendJson({ ok: true, key, category, content, memory: formatMemory(st), personalFacts: listPersonalFacts(50) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/memory-update') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const oldContent = String(body.oldContent ?? '').trim();
          const target = redactKnownTokensOnly(String(body.target ?? '').trim());
          const newContent = body.newContent !== undefined && body.newContent !== null ? redactKnownTokensOnly(String(body.newContent).trim()) : undefined;
          const newExtra = body.newExtra && typeof body.newExtra === 'object' && !Array.isArray(body.newExtra) ? body.newExtra : {};
          const redactExtra = (v) => redactKnownTokensOnly(String(v ?? '')).trim();
          const cleanNewExtra = {
            ...newExtra,
            pendingQuestion: newExtra.pendingQuestion !== undefined ? redactExtra(newExtra.pendingQuestion) : undefined,
            participants: Array.isArray(newExtra.participants) ? newExtra.participants.map((p) => redactExtra(p)) : undefined,
            motivation: newExtra.motivation !== undefined ? redactExtra(newExtra.motivation) : undefined,
            target: newExtra.target !== undefined ? redactExtra(newExtra.target) : undefined
          };
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定原群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !oldContent) { sendJson({ ok: false, error: '该类别需要 oldContent 指定要编辑的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_*' }, 403); return; }
          const st = getSimulationState(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            const idx = st.activeTopics.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 activeTopic' }, 404); return; }
            if (newContent !== undefined) st.activeTopics[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.pendingQuestion !== undefined) st.activeTopics[idx].pendingQuestion = String(cleanNewExtra.pendingQuestion).slice(0, 200);
            if (Array.isArray(cleanNewExtra.participants)) st.activeTopics[idx].participants = cleanNewExtra.participants.map(String).slice(0, 10);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            const idx = st.pendingThoughts.findIndex((t) => String(t?.text ?? '') === oldContent);
            if (idx < 0) { sendJson({ ok: false, error: '找不到要编辑的 pendingThought' }, 404); return; }
            if (newContent !== undefined) st.pendingThoughts[idx].text = newContent.slice(0, 200);
            if (cleanNewExtra.motivation !== undefined) st.pendingThoughts[idx].motivation = String(cleanNewExtra.motivation).slice(0, 50);
            if (cleanNewExtra.expiresAtMs !== undefined) st.pendingThoughts[idx].expiresAt = Date.now() + Math.max(0, Number(cleanNewExtra.expiresAtMs) || 0);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            const oldTarget = target;
            if (['__proto__', 'constructor', 'prototype'].includes(oldTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            // 必须命中**已有**条目（own property）：否则任意 target 都能凭空建一条，
            // 而 'toString'/'valueOf' 这类名字会从 Object.prototype 上取到继承来的函数，
            // 往函数对象上写 traits —— JSON.stringify 又会把它整个丢掉（静默数据丢失）。
            if (!Object.prototype.hasOwnProperty.call(st.memberImpressions, oldTarget)) {
              sendJson({ ok: false, error: '找不到要编辑的群友印象（新印象请用 qq_memory_append 添加）' }, 404);
              return;
            }
            const im = st.memberImpressions[oldTarget];
            const newTarget = String(cleanNewExtra.target || oldTarget).trim().slice(0, 64);
            if (!newTarget || ['__proto__', 'constructor', 'prototype'].includes(newTarget)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
            if (newContent !== undefined) {
              im.traits = newContent.split(/[,，、]/).map((s) => s.trim()).filter(Boolean).slice(0, 20);
            }
            if (cleanNewExtra.interactionCount !== undefined) im.interactionCount = Math.max(0, Number(cleanNewExtra.interactionCount) || 0);
            if (newTarget !== oldTarget) delete st.memberImpressions[oldTarget];
            st.memberImpressions[newTarget] = im;
            // 与控制台/AI 的 append 路径保持一致：条目数上限 50，超了按 lastSeenAt 淘汰最旧，
            // 否则 memory-update 能无限塞名字（每次 1MB 请求 → 状态文件与每轮 prompt 一起膨胀）。
            const impressionEntries = Object.entries(st.memberImpressions);
            if (impressionEntries.length > 50) {
              impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
              for (let i = 0; i < impressionEntries.length - 50; i += 1) delete st.memberImpressions[impressionEntries[i][0]];
            }
          }
          saveSimulationState();
          sendJson({ ok: true, key, category, memory: formatMemory(st) });
          return;
        }
        if (req.method === 'GET' && url.pathname === '/api/simulation/memory') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const category = String(url.searchParams.get('category') ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_query' }, 403); return; }
          const st = getSimulationState(key);
          const personalFacts = listPersonalFacts(50);
          if (category === 'personalFact') {
            sendJson({
              ok: true,
              key,
              category,
              personalFacts,
              formatted: formatPersonalMemoryBlock({ facts: personalFacts, maxChars: 2000 }),
              raw: { personalFacts }
            });
            return;
          }
          const raw = {
            activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-20) : [],
            pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => !t.expiresAt || Date.now() < t.expiresAt).slice(-20) : [],
            memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {}
          };
          if (category === 'activeTopic') {
            raw.pendingThoughts = [];
            raw.memberImpressions = {};
          } else if (category === 'pendingThought') {
            raw.activeTopics = [];
            raw.memberImpressions = {};
          } else if (category === 'memberImpression') {
            raw.activeTopics = [];
            raw.pendingThoughts = [];
          }
          sendJson({ ok: true, key, category, formatted: formatMemory({ ...st, ...raw }), raw, personalFacts });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/memory-remove') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          const content = String(body.content ?? '').trim();
          const target = String(body.target ?? '').trim();
          if (!key || !category) { sendJson({ ok: false, error: 'key/category 不能为空' }, 400); return; }
          if (!['activeTopic', 'pendingThought', 'memberImpression', 'personalFact'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / personalFact' }, 400); return; }
          if (category === 'memberImpression' && !target) { sendJson({ ok: false, error: 'memberImpression 需要 target 指定群友名字' }, 400); return; }
          if (category === 'memberImpression' && ['__proto__', 'constructor', 'prototype'].includes(target)) { sendJson({ ok: false, error: '非法的群友名字' }, 400); return; }
          if (category !== 'memberImpression' && !content) { sendJson({ ok: false, error: '该类别需要 content 指定要删除的记忆内容' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_remove' }, 403); return; }
          if (category === 'personalFact') {
            if (!memoryStore || cfg.simulation?.memory?.enabled === false) { sendJson({ ok: false, error: '长期记忆未启用' }, 503); return; }
            const facts = listPersonalFacts(200);
            const match = facts.find((f) => String(f.id) === content || f.fact === content || f.fact.includes(content) || content.includes(f.fact));
            if (!match) { sendJson({ ok: false, error: '找不到要删除的跨会话记忆' }, 404); return; }
            const removed = memoryStore.forget(match.id);
            sendJson({ ok: true, key, category, removed, personalFacts: listPersonalFacts(50) });
            return;
          }
          const st = getSimulationState(key);
          if (category === 'activeTopic' && Array.isArray(st.activeTopics)) {
            st.activeTopics = st.activeTopics.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'pendingThought' && Array.isArray(st.pendingThoughts)) {
            st.pendingThoughts = st.pendingThoughts.filter((t) => String(t?.text ?? '') !== content);
          } else if (category === 'memberImpression' && st.memberImpressions && typeof st.memberImpressions === 'object') {
            delete st.memberImpressions[target];
          }
          saveSimulationState();
          sendJson({ ok: true, key, category, memory: formatMemory(st) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/memory-clear') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const category = String(body.category ?? '').trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (category && !['activeTopic', 'pendingThought', 'memberImpression', 'personalFact'].includes(category)) { sendJson({ ok: false, error: 'category 必须是 activeTopic / pendingThought / memberImpression / personalFact' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('memory')) { sendJson({ ok: false, error: '工具未启用：qq_memory_clear' }, 403); return; }
          if (category === 'personalFact') {
            if (!memoryStore || cfg.simulation?.memory?.enabled === false) { sendJson({ ok: false, error: '长期记忆未启用' }, 503); return; }
            const facts = listPersonalFacts(500);
            for (const fact of facts) memoryStore.forget(fact.id);
            sendJson({ ok: true, key, category, cleared: facts.length, personalFacts: [] });
            return;
          }
          const st = getSimulationState(key);
          if (!category || category === 'activeTopic') st.activeTopics = [];
          if (!category || category === 'pendingThought') st.pendingThoughts = [];
          if (!category || category === 'memberImpression') st.memberImpressions = {};
          saveSimulationState();
          sendJson({ ok: true, key, category: category || 'all', memory: formatMemory(st) });
          return;
        }
        // ── 仿真黑话学习（simulation）：AI 查询/提交黑话候选 ─────────────────
        if (req.method === 'GET' && url.pathname === '/api/simulation/slang/query') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const q = String(url.searchParams.get('q') ?? '').trim().toLowerCase();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('slangQuery')) { sendJson({ ok: false, error: '工具未启用：qq_slang_query' }, 403); return; }
          const list = confirmedSlangList().filter((e) => {
            if (!q) return true;
            return e.content.toLowerCase().includes(q)
              || e.meaning.toLowerCase().includes(q)
              || e.usage.toLowerCase().includes(q)
              || e.example.toLowerCase().includes(q);
          });
          sendJson({
            ok: true,
            key,
            total: list.length,
            entries: list,
            block: buildSlangContext(slangEntries, cfg.slang?.injectMax ?? 12)
          });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/simulation/slang/submit') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const content = redactKnownTokensOnly(String(body.content ?? '')).trim();
          const context = redactKnownTokensOnly(String(body.context ?? '')).trim();
          if (!key) { sendJson({ ok: false, error: 'key 不能为空' }, 400); return; }
          if (req.headers['x-agent-token'] && !agentTokenOk(key, req.headers['x-agent-token'])) { sendJson({ ok: false, error: 'agent token 无效' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationSessionAllowed(key)) { sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403); return; }
          if (req.headers['x-agent-token'] && !simulationToolEnabled('slangSubmit')) { sendJson({ ok: false, error: '工具未启用：qq_slang_submit' }, 403); return; }
          if (cfg.slang?.enabled === false) { sendJson({ ok: false, error: '黑话学习已关闭（slang.enabled=false）' }, 403); return; }
          if (!content) { sendJson({ ok: false, error: 'content 不能为空' }, 400); return; }
          if (content.length > 50) { sendJson({ ok: false, error: '黑话词条过长（最多 50 字）' }, 400); return; }
          if (!allowSlangSubmit(key)) { sendJson({ ok: false, error: '黑话提交过于频繁，请稍后再试' }, 429); return; }
          const existing = slangEntries.find((e) => e.content === content);
          if (existing) {
            if (existing.status === SLANG_STATUS.CONFIRMED) {
              sendJson({ ok: true, duplicate: true, status: 'confirmed', entry: publicSlangEntry(existing) });
              return;
            }
            if (existing.status === SLANG_STATUS.REJECTED) {
              sendJson({ ok: false, error: '该词已被管理员拒绝，如需重新收录请联系管理员' }, 403);
              return;
            }
            // candidate：累计出现次数并追加语境证据
            existing.count = (Number(existing.count) || 0) + 1;
            if (context) {
              existing.evidence = mergeEvidence(existing.evidence, [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }]);
            }
            existing.updatedAt = new Date().toISOString();
            saveSlangStore();
            if (cfg.slang?.autoResearch !== false) {
              const thresholds = Array.isArray(cfg.slang?.inferenceThresholds) ? cfg.slang.inferenceThresholds.map(Number).filter(Boolean) : [2, 4, 8];
              if (thresholds.includes(existing.count) && existing.count > (Number(existing.lastInferenceCount) || 0)) {
                queueSlangTask(() => runSlangResearch([existing]));
              }
            }
            log(`[simulation] AI 再次提交黑话候选「${content}」(${key})，累计 ${existing.count} 次`);
            sendJson({ ok: true, duplicate: true, status: 'candidate', entry: publicSlangEntry(existing) });
            return;
          }
          const entry = createSlangEntry({
            content,
            source: 'ai',
            status: SLANG_STATUS.CANDIDATE,
            evidence: context ? [{ key, sender: 'AI提交', text: context.slice(0, 200), time: Date.now() }] : []
          });
          slangEntries.push(entry);
          saveSlangStore();
          if (cfg.slang?.autoResearch !== false) {
            queueSlangTask(() => runSlangResearch([entry]));
          }
          log(`[simulation] AI 提交黑话候选「${content}」(${key})`);
          appendActivity(`${key} [simulation] AI 提交黑话候选：${content}${context ? '（附语境）' : ''}`);
          sendJson({ ok: true, entry: publicSlangEntry(entry) });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/authorize/read') {
          const body = await readBody();
          const key = String(body.key ?? '').trim();
          const token = String(body.token ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!token) {
            // 空 token 一律拒绝：该端点对 agent 流量开放（见 startConsoleServer 里的
            // agent 白名单），而 MCP 的 agentApi 总是带着真实控制台令牌，
            // 所以「不传 token 就跳过校验」等于把它变成免鉴权端点。
            sendJson({ ok: false, error: '缺少会话令牌；旧只读工具在需要令牌的模式下不可用，请改用带会话令牌的仿真读工具' }, 403);
            return;
          }
          const readAccess = canActOn(key, token, { crossSession: true, route: url.pathname });
          if (!readAccess.ok) {
            sendJson({ ok: false, error: readAccess.error }, readAccess.status);
            return;
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          sendJson({ ok: true, key });
          return;
        }
        // ── 图片/表情查询端点（MCP qq_get_message_images 走这里） ────────────
        if (req.method === 'GET' && url.pathname === '/api/images/message') {
          const key = String(url.searchParams.get('key') ?? '').trim();
          const messageId = String(url.searchParams.get('messageId') ?? '').trim();
          const agentToken = String(req.headers['x-agent-token'] ?? '').trim();
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式应为 group:群号 或 private:QQ号' }, 400); return; }
          if (!messageId) { sendJson({ ok: false, error: 'messageId 不能为空' }, 400); return; }
          if (currentMode === 'simulation' && !agentToken) {
            sendJson({ ok: false, error: 'simulation 模式读取图片必须携带 agent token' }, 403);
            return;
          }
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '旧版 chat/reserved 模式图片已自动内联，按需图片工具仅 simulation 模式可用' }, 403);
            return;
          }
          if (agentToken) {
            const imagesAccess = canActOn(key, agentToken, { crossSession: true, route: url.pathname });
            if (!imagesAccess.ok) {
              sendJson({ ok: false, error: imagesAccess.error }, imagesAccess.status);
              return;
            }
          }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '当前模式不允许读取该会话' }, 403);
            return;
          }
          if (agentToken && !simulationToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          if (!agentToken && currentMode === 'closed-agent' && !simulationToolEnabled('getImages')) {
            sendJson({ ok: false, error: '工具未启用：qq_get_message_images' }, 403);
            return;
          }
          const media = findMessageMedia(key, messageId);
          if (!media.length) {
            sendJson({ ok: true, messageId, media: [], images: [], note: '该消息没有可读取的图片/表情元数据' });
            return;
          }
          try {
            const images = await fetchMediaData(media);
            sendJson({ ok: true, messageId, media, images });
          } catch (error) {
            log(`图片查询失败 ${key} ${messageId}: ${error?.message ?? error}`);
            sendJson({ ok: false, error: `图片查询失败：${error?.message ?? error}` }, 500);
          }
          return;
        }

        // ── 统一发送端点（MCP 旧发送工具也走这里） ───────────────────────────
        if (req.method === 'POST' && (url.pathname === '/api/send/group' || url.pathname === '/api/send/private' || url.pathname === '/api/send/reply')) {
          const body = await readBody();
          const token = String(body.token ?? '').trim();
          const isPrivate = url.pathname === '/api/send/private';
          const isReply = url.pathname === '/api/send/reply';
          const targetId = isPrivate ? String(body.userId ?? '').trim() : String(body.groupId ?? '').trim();
          const message = unquoteJsonString(String(body.message ?? '').trim());
          // 引用 id 与端点无关：/api/send/reply 与另两个端点都允许带（是否真的引用由下游按 id 判断）。
          // 旧写法 `isReply ? body.replyToMessageId : body.replyToMessageId` 两个分支一模一样，
          // 保留 isReply 变量只是为了下面的端点语义判断，别再让人以为这里有过分支逻辑。
          const replyToMessageId = body.replyToMessageId;
          const atUserId = body.atUserId ?? null;
          const key = isPrivate ? `private:${targetId}` : `group:${targetId}`;
          // 安全边界：发送工具只允许在 closed-agent（管理员私聊）或 simulation（仿真 AI 带会话令牌）下使用；
          // chat/reserved 的自动转发已覆盖正常回复，MCP 发送工具不应成为 prompt injection 的越权出口。
          if (currentMode === 'chat' || currentMode === 'reserved') {
            sendJson({ ok: false, error: '发送工具仅限 closed-agent / simulation 模式使用' }, 403);
            return;
          }
          if (simulation.paused && token) {
            sendJson({ ok: false, error: 'AI 已暂停，当前不允许执行发送工具' }, 403);
            return;
          }
          if (!targetId || !message) { sendJson({ ok: false, error: '目标 id 和 message 不能为空' }, 400); return; }
          if (isPrivate && atUserId) { sendJson({ ok: false, error: '私聊不需要 @' }, 400); return; }
          if (isReply && (replyToMessageId === undefined || replyToMessageId === null || String(replyToMessageId).trim() === '')) {
            sendJson({ ok: false, error: 'replyToMessageId 不能为空' }, 400);
            return;
          }
          if (currentMode === 'simulation' && !token) { sendJson({ ok: false, error: 'simulation 模式发送必须携带 agent token' }, 403); return; }
          const legacySendAccess = token ? canActOn(key, token, { crossSession: true, route: url.pathname }) : null;
          if (legacySendAccess && !legacySendAccess.ok) {
            sendJson({ ok: false, error: legacySendAccess.error }, legacySendAccess.status);
            return;
          }
          const flag = isPrivate ? 'sendPrivate' : (isReply ? 'reply' : 'sendGroup');
          if (token && !simulationToolEnabled(flag)) { sendJson({ ok: false, error: `工具未启用：${flag}` }, 403); return; }
          if (shouldBlockSilentReply(key)) {
            sendJson({ ok: false, error: '静默模式已开启，当前不允许发送' }, 403);
            return;
          }
          const keyMatch = /^(group|private):(\d+)$/.exec(key);
          if (!keyMatch) { sendJson({ ok: false, error: 'key 格式无效' }, 400); return; }
          const kind = keyMatch[1];
          const id = Number(keyMatch[2]);
          if (!Number.isFinite(id) || id <= 0 || !modeAllowed(key, kind, id, cfg, currentMode)) {
            sendJson({ ok: false, error: '目标不在当前模式允许范围内' }, 403);
            return;
          }
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '' && !/^-?[1-9]\d*$/.test(String(replyToMessageId).trim())) {
            sendJson({ ok: false, error: 'replyToMessageId 必须是非零整数（消息 id 可能为负数）' }, 400);
            return;
          }
          let quotedInfo = null;
          let actualReplyToMessageId = replyToMessageId;
          if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
            const stForReply = getSimulationState(key);
            const resolved = await resolveReplyTarget(stForReply, kind, id, String(replyToMessageId).trim());
            if (!resolved) {
              sendJson({ ok: false, error: '无法解析被引用消息，请确认 message id 正确且属于当前会话（可用 qq_get_message_detail 查看）' }, 400);
              return;
            }
            quotedInfo = resolved.info;
            actualReplyToMessageId = resolved.messageId;
          }
          const sendCfg = cfg.simulation?.send ?? {};
          const maxChars = Math.max(1, Number(sendCfg.maxMessageChars) || 500);
          if (message.length > maxChars) { sendJson({ ok: false, error: `单条消息不能超过 ${maxChars} 字` }, 400); return; }
          if (SENSITIVE_RE.test(message)) { sendJson({ ok: false, error: '消息含敏感信息，已阻止发送' }, 403); return; }
          // st/now 必须声明在 try **之外**：下面的 catch 要用它们回滚预占的发送额度。
          // 写在 try 里时 catch 拿到的是块作用域外的名字 ⇒ ReferenceError（send-burst
          // 曾整段踩过同型问题，见体检报告 #1 / R2）。后果不是"少一行日志"，而是
          // 失败响应变成「st is not defined」、额度不回滚（接下来一分钟全是假 429），
          // 且部分成功的已发消息不会被记进 recentMessages。
          const st = getSimulationState(key);
          const now = Date.now();
          try {
            const maxPerMinute = Number(sendCfg.maxSendPerMinute) || 0;
            const maxPerHour = Number(sendCfg.maxSendPerHour) || 0;
            const recentMinute = (st.sendTimes || []).filter((t) => now - t < 60000).length;
            const recentHour = (st.sendTimes || []).filter((t) => now - t < 3600000).length;
            if ((maxPerMinute > 0 && recentMinute + 1 > maxPerMinute) || (maxPerHour > 0 && recentHour + 1 > maxPerHour)) {
              sendJson({ ok: false, error: '发送频率超限，请稍后再试' }, 429);
              return;
            }
            st.sendTimes.push(now);
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            const sentMessages = await sendMessages(key, [message], [], actualReplyToMessageId, atUserId);
            recordSentMessages(key, sentMessages);
            if (sentMessages.length > 0) noteTextSent(st);
            if (sentMessages.length > 0) void maybeSendPixelSticker(st, key);
            st.lastAiReplyAt = now;
            st.lastActionAt = now;
            st.wakeConfig.noActionCount = 0;
            saveSimulationState();
            log(`[send] ${url.pathname} ${key}: 成功 ${sentMessages.length}/1 条`);
            appendActivity(`${key} [send] 成功 ${sentMessages.length}/1 条：${message.slice(0, 80)}`);
            if (sentMessages.length > 0) scheduleReplyCheck(key);
            sendJson({ ok: true, key, sent: sentMessages.length, failed: sentMessages.length ? 0 : 1, quoted: quotedInfo });
          } catch (error) {
            if (error?.sent?.length) {
              recordSentMessages(key, error.sent);
              log(`[send] ${url.pathname} ${key} 部分成功 ${error.sent.length}/1 条，已记录已发消息`);
            }
            const sentCount = Array.isArray(error?.sent) ? error.sent.length : 0;
            const queuedCount = Math.max(0, Number(error?.queuedCount) || 0);
            const failedCount = Math.max(0, 1 - sentCount - queuedCount);
            for (let i = 0; i < failedCount; i++) {
              const idx = st.sendTimes.indexOf(now);
              if (idx >= 0) st.sendTimes.splice(idx, 1);
            }
            if (st.sendTimes.length > 500) st.sendTimes = st.sendTimes.slice(-500);
            saveSimulationState();
            if (queuedCount > 0) {
              sendJson({ ok: true, key, sent: sentCount, queued: queuedCount, failed: 0, hint: '消息已持久化并进入重试队列，不要重复发送同一条内容' });
              return;
            }
            sendJson({ ok: false, error: error?.message ?? String(error) }, 500);
          }
          return;
        }
        // ── 清除上下文 / 清空工作区 ──────────────────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/session/reset') {
          const body = await readBody();
          const key = String(body.key ?? '');
          if (!key || !state.sessions[key]) { sendJson({ ok: false, error: '会话不存在' }, 404); return; }
          sessionEpoch++;
          const oldSessionId = disposeConversation(key, { scope: 'reset' });
          // 归档只隐藏会话，不终止 DSH 侧排队的工作；先清队列并取消当前回合。
          try { await withTimeout(api.stopSessionWork(oldSessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: oldSessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          log(`控制台：已清除会话上下文 ${key}（旧会话 ${oldSessionId} 已停止并归档）`);
          sendJson({ ok: true, key, archived: oldSessionId });
          return;
        }
        if (req.method === 'POST' && url.pathname === '/api/workspace/reset') {
          sessionEpoch++;
          let archivedCount = 0;
          let stoppedCount = 0;
          try {
            // 新版 DSH 不再提供 workspace.list；改为扫描本桥接创建的会话目录并归档。
            // 只处理 cwd 位于 state/ 下的根会话；子代理会话由父会话管理，不能误归档。
            const list = unwrap(await withTimeout(api.sessions.list({}), DSH_CONTROL_TIMEOUT_MS, 'sessions.list'), 'session.list');
            const stateDir = path.resolve(STATE_DIR);
            const statePrefix = path.normalize(stateDir + path.sep);
            const normPath = (p) => path.normalize(String(p ?? '').replace(/\//g, path.sep));
            const isUnderState = (cwd) => process.platform === 'win32'
              ? cwd.toLowerCase().startsWith(statePrefix.toLowerCase())
              : cwd.startsWith(statePrefix);
            for (const item of list.items ?? []) {
              if (item.origin === 'subagent' || item.parentSessionId) continue;
              const cwd = normPath(item.cwd);
              if (isUnderState(cwd)) {
                // 归档只隐藏会话；必须先把 DSH 侧排队的工作清掉并取消当前回合。
                try { await withTimeout(api.stopSessionWork(item.sessionId), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); stoppedCount += 1; }
                catch (error) { log(`⚠️ 停止旧会话失败 ${item.sessionId}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
                try { await withTimeout(api.workspace.archiveSession({ sessionId: item.sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); archivedCount += 1; } catch {}
              }
            }
          } catch {}
          for (const entry of pending.values()) {
            clearTimeout(entry.timer);
            cancelPendingEntry(entry).catch(() => {});
          }
          pending.clear();
          queued.clear();
          queuedHintAt.clear();
          sessionPromises.clear();
          drainAllPromptQueues('工作区已清空');
          social.states.clear();
          social.recentMessages.clear();
          messageMediaStore.clear();
          seenForwardIds.clear();
          social.pendingSummaries.clear();
          social.silentContext.clear();
          social.silentTurns.clear();
          social.exitingSessions.clear();
          slangWindows.clear();
          slangExtractionCooldowns.clear();
          slangSubmitTimes.clear();
          cancelAllSocialTimers();
          clearAllSimulationTimers();
          // 清空工作区 = 所有会话连同 token 一起作废，两张表整体清掉（比逐会话摘除更不容易漏）。
          simulation.conversations.clear();
          CONVERSATION_TOKENS.clear();
          KNOWN_AGENT_TOKENS.clear();
          saveSimulationState();
          state.sessions = {};
          state.sessionPolicies = {};
          reverse.clear();
          collectors.clear();
          sendToolSucceededSessions.clear();
          pendingSendToolCalls.clear();
          simulationTurnStartAt.clear();
          toolCallNames.clear();
          saveState();
          try { fs.writeFileSync(ACTIVITY_LOG, ''); } catch {}
          log(`控制台：已清空 QQ 聊天工作区（停止 ${stoppedCount} 个、归档 ${archivedCount} 个会话，映射与活动日志已清空）`);
          sendJson({ ok: true, archivedCount, stoppedCount });
          return;
        }
        // ── 重启桥接（守护模式下 5 秒后自动拉起） ──────────────────────────────
        if (req.method === 'POST' && url.pathname === '/api/restart') {
          sendJson({ ok: true, message: '正在重启桥接（若由守护窗口启动，5 秒后自动恢复）…' });
          setTimeout(() => {
            log('控制台：重启桥接');
            // 退出前落盘：SIGINT/SIGTERM 的收尾路径会 saveState()/saveSimulationState()，
            // 而重启这条路径以前直接 process.exit，500ms 窗口内改动的唤醒配置/计数器会丢。
            try { saveState(); } catch (error) { log('重启前保存会话映射失败:', error?.message ?? error); }
            try { saveSimulationState(); } catch (error) { log('重启前保存仿真会话状态失败:', error?.message ?? error); }
            releaseLock();
            process.exit(0);
          }, 500);
          return;
        }
        sendJson({ ok: false, error: 'not found' }, 404);
      } catch (error) {
        const status = Number(error?.statusCode) || 500;
        sendJson({ ok: false, error: error?.message ?? String(error) }, status);
      }
    });
    server.listen(port, consoleLanAccess ? '0.0.0.0' : '127.0.0.1', () => {
      consoleBoundPort = server.address()?.port ?? port;
      if (consoleLanAccess) {
        lanHosts = lanHostsFromInterfaces(consoleBoundPort, os.networkInterfaces());
        log(`本地控制台已启动：http://127.0.0.1:${consoleBoundPort}`);
        log(`局域网访问已开启（监听 0.0.0.0:${consoleBoundPort}，强制令牌鉴权）；手机与本机需在同一 WiFi`);
        for (const host of lanHosts) log(`局域网实时页：http://${host}/live（令牌见 state/console-token，勿外传）`);
        if (!lanHosts.length) log('未找到非内部 IPv4 网卡：局域网设备暂时无法访问，请检查网络连接后重启桥接');
      } else {
        log(`本地控制台已启动：http://127.0.0.1:${consoleBoundPort}`);
      }
    });
    // 端口被占用说明已有实例在跑：以 exit 2 退出，守护脚本会识别为"已有实例"而不是无限重启
    server.on('error', (error) => {
      log(`控制台服务错误: ${error?.message ?? error}`);
      if (error?.code === 'EADDRINUSE') {
        console.error(`[bridge] 控制台端口 ${port} 已被占用（可能已有实例在运行），退出。`);
        process.exit(2);
      }
      process.exit(1);
    });
    return server;
  }

  // 会话代际：reset/清空工作区时递增，防止在途 ensureSession 把旧会话"复活"
  let sessionEpoch = 0;

  // 待应答的提问/审批：convKey -> pending
  const pending = new Map(); // key -> { kind, rpcId, sessionId, ... }

  // QQ 发送队列（顺序发送 + 间隔，避免触发频率限制）
  let sendChain = Promise.resolve();
  function redactKnownTokensOnly(text) {
    let s = String(text ?? '');
    for (const token of KNOWN_AGENT_TOKENS) {
      if (token && s.includes(token)) s = s.split(token).join('***');
    }
    return s;
  }

  // 最近一次发送是否全部成功（按 key）。调用方据此决定要不要刷新「我发过言了」的时间戳 ——
  // 旧实现把发送失败吞成一行日志后**照常 resolve**，于是调用方以为发言成功，
  // 更新 lastAiReplyAt / 活跃调度，实际群里什么都没收到，而且只有一行滚动日志能看出问题。
  const lastSendFailed = new Map(); // key -> true（下一次成功即清除）

  function sendToQQ(key, msg, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const safeMsg = redactKnownTokensOnly(msg);
    const [kind, id] = key.split(':');
    const parts = splitForQQ(safeMsg);
    lastSendFailed.delete(key);
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      // 同一条逻辑消息拆成多段时，每段一个 dedupeKey；重启重放走同一行，不会重复。
      const dedupeKey = options?.dedupeKey ? `${options.dedupeKey}#${i}` : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (outbox) {
            try {
              const result = await outbox.sendNow({
                key,
                kind: 'text',
                payload: { text: part, transport: 'ws' },
                dedupeKey
              });
              if (!result.ok) {
                lastSendFailed.set(key, true);
                log(`QQ 发送未确认 (${key})：outbox=${result.state}${result.queued ? '（已排队，后台重试）' : ''}`);
              }
              return;
            } catch (error) {
              // 队列本身不可用（磁盘/DB 故障）→ 回退直发，宁可少一层保护也不要丢消息。
              log(`⚠️ outbox 入队失败，回退直发 (${key})：${error?.message ?? error}`);
            }
          }
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(part))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
        })
        .catch((error) => {
          lastSendFailed.set(key, true);
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
        })
        .then(() => sleep(cfg.sendDelayMs));
    }
    return sendChain;
  }

  /** 上一批发往该会话的消息是否全部成功。 */
  function lastSendSucceeded(key) {
    return lastSendFailed.get(key) !== true;
  }

  // ── 真人式分条发送 ──────────────────────────────────────────────────────
  function singleLineForQQ(s) {
    return String(s ?? '')
      .replace(/\s*\n\s*/g, ' ')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  // 超长段落：先按次要标点拆，再按字符硬拆，保证不丢内容、不退回单条长消息。
  // URL 会被当作不可拆分的原子，避免把 https://... 这种整条网页地址拆断。
  function splitLongSegment(segment, max) {
    const s = String(segment ?? '').trim();
    if (!s) return [];
    const safeMax = Number.isFinite(max) && max >= 1 ? Math.floor(max) : 500;
    if (s.length <= safeMax) return [s];

    const urlRe = /https?:\/\/[^\s，。；、]+/g;
    const urls = [];
    const masked = s.replace(urlRe, (m) => {
      urls.push(m);
      return `\u0000URL${urls.length - 1}\u0000`;
    });

    const raw = masked.split(/([，、；：,;:])/);
    const tokens = [];
    for (let i = 0; i < raw.length; i += 2) {
      tokens.push(((raw[i] ?? '') + (raw[i + 1] ?? '')).trim());
    }
    const out = [];
    let cur = '';
    // ⚠️ 占位符 \u0000URL<n>\u0000 必须是**不可切开的最小单位**。
    // 早先的实现对超长 token 直接按 safeMax 硬切，会把占位符拦腰截断
    // （如 "\u0000UR" + "L0\u0000"），后面的还原正则 \u0000URL(\d+)\u0000 就匹配不上 →
    // **URL 整条丢失 + 裸 NUL + 字面量 "URL0" 被发进 QQ 消息**（实测 13 个偏移里 5 个损坏）。
    // 这里改成按占位符边界切分，宁可某段略超 max 也绝不切碎占位符。
    const PLACEHOLDER_ANY = /\u0000URL\d+\u0000/;
    const PLACEHOLDER_ALL = /\u0000URL\d+\u0000/g;
    /** 把 token 切成 {text, isPlaceholder} 序列（占位符整体一块，绝不拆） */
    const splitByPlaceholder = (tok) => {
      const parts = [];
      let last = 0;
      let m;
      PLACEHOLDER_ALL.lastIndex = 0;
      while ((m = PLACEHOLDER_ALL.exec(tok)) !== null) {
        if (m.index > last) parts.push({ text: tok.slice(last, m.index), isPlaceholder: false });
        parts.push({ text: m[0], isPlaceholder: true });
        last = m.index + m[0].length;
      }
      if (last < tok.length) parts.push({ text: tok.slice(last), isPlaceholder: false });
      return parts;
    };
    for (const tok of tokens) {
      if (!tok) continue;
      if (tok.length > safeMax) {
        if (cur) { out.push(cur); cur = ''; }
        for (const piece of splitByPlaceholder(tok)) {
          // 占位符整块输出；普通文本仍按 safeMax 切
          if (piece.isPlaceholder) { out.push(piece.text); continue; }
          for (let i = 0; i < piece.text.length;) {
            let end = Math.min(i + safeMax, piece.text.length);
            // 绝不在代理对（emoji、部分生僻字）中间下刀：硬切会产生「半个 emoji」，
            // 两个孤立代理各自成为一条 QQ 消息、永远无法再拼回，群友看到的就是乱码方块。
            // 退一格把整个字符让给下一段；若退成空串就不退（safeMax 极小时），
            // 宁可硬切也要保证循环一定前进。逻辑内联在此，函数保持自包含
            // —— test-voice.mjs 会把这个函数的源码单独 eval 出来测。
            if (end < piece.text.length && end - i > 1) {
              const last = piece.text.charCodeAt(end - 1);
              if (last >= 0xd800 && last <= 0xdbff) end -= 1;
            }
            out.push(piece.text.slice(i, end));
            i += end > i ? end - i : safeMax;
          }
        }
      } else if (cur.length + tok.length <= safeMax) {
        cur += tok;
      } else {
        out.push(cur);
        cur = tok;
      }
    }
    if (cur) out.push(cur);

    return out
      .map((chunk) => chunk.replace(/\u0000URL(\d+)\u0000/g, (_, i) => urls[Number(i)] ?? ''))
      .filter(Boolean);
  }

  // 判断字符是否属于“中文汉字”范围，用于识别空格分句意图。
  // 注意：这里只认汉字，不认中文标点/全角符号，避免“你好， 世界”这种 AI 排版空格被误拆。
  function isCjkChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF)
    );
  }

  // 按“有意的空格”拆分：真人不会主动用空格，因此 AI 回复里的空格视为分条信号。
  // 空格两侧只要有一侧是中文/中文标点，就按分条处理（包括中英文/数字之间的空格）。
  // 注意：该逻辑只用于旧版 reserved 的自动转发文本；仿真 simulation 不走这里，仿真必须显式用数组分条。
  function splitByCjkSpaces(src) {
    const tokens = String(src ?? '').split(/\s+/).map((t) => t.trim()).filter(Boolean);
    if (tokens.length <= 1) return tokens;
    const groups = [];
    let cur = tokens[0];
    for (let i = 1; i < tokens.length; i++) {
      const prevLast = [...cur].pop() || '';
      const currFirst = [...tokens[i]][0] || '';
      // 空格两侧只要有一侧是汉字，就视为分条信号。
      if (isCjkChar(prevLast) || isCjkChar(currFirst)) {
        groups.push(cur);
        cur = tokens[i];
      } else {
        cur = cur + ' ' + tokens[i];
      }
    }
    if (cur) groups.push(cur);
    return groups;
  }

  // 新分句逻辑：分句权交给 AI。
  // AI 用空格表示“这里要分成下一条消息”，桥接按空格拆条；
  // 不想分条时用标点连接、不加空格即可。单条消息只做 maxReplyChars（默认 500 字）安全硬拆。
  function planSocialTimeline(text, socialCfg) {
    const src = String(text ?? '').replace(/\r\n/g, '\n').trim();
    const rawMaxChars = Number(socialCfg?.maxReplyChars ?? 500);
    const maxChars = Number.isFinite(rawMaxChars) && rawMaxChars >= 1 ? Math.floor(rawMaxChars) : 500;
    const enabled = socialCfg?.burstEnabled !== false;
    if (!src) return { main: [], followUp: null };

    // 关闭分条：整条作为一条消息发送，只做安全硬拆
    if (!enabled) {
      return { main: splitLongSegment(src, maxChars).map(singleLineForQQ), followUp: null };
    }

    // 按空格（含换行）拆成候选消息；每个候选再按 maxChars 安全硬拆
    const parts = splitByCjkSpaces(src);
    if (parts.length <= 1) {
      return { main: splitLongSegment(parts[0] || src, maxChars).map(singleLineForQQ), followUp: null };
    }

    const main = [];
    for (const part of parts) {
      main.push(...splitLongSegment(part, maxChars).map(singleLineForQQ));
    }
    return { main: main.filter(Boolean), followUp: null };
  }

  // 分条发送：与 sendToQQ 共用同一 sendChain，严格顺序；条间随机间隔，
  // 有概率使用长间隔（错落感）；最后一条后不再 sleep。
  function sendBurstToQQ(key, messages, socialCfgOrMin, maybeMax, options = null) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    let min, max, longProb = 0, longMin = 0, longMax = 0;
    if (typeof socialCfgOrMin === 'object' && socialCfgOrMin !== null) {
      const cfg = socialCfgOrMin;
      min = Math.max(0, Number(cfg.burstIntervalMinMs) || 1000);
      max = Math.max(min, Number(cfg.burstIntervalMaxMs) || min);
      longProb = Math.min(1, Math.max(0, Number(cfg.longGapProbability) || 0));
      longMin = Math.max(0, Number(cfg.longGapMinMs) || 8000);
      longMax = Math.max(longMin, Number(cfg.longGapMaxMs) || longMin);
    } else {
      min = Math.max(0, Number(socialCfgOrMin) || 0);
      max = Math.max(min, Number(maybeMax) || min);
    }

    const sent = [];
    for (let i = 0; i < messages.length; i++) {
      const msg = redactKnownTokensOnly(messages[i]);
      const isLast = i === messages.length - 1;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (outbox) {
            try {
              const result = await outbox.sendNow({
                key,
                kind: 'text',
                payload: { text: msg, transport: 'ws' },
                dedupeKey: options?.dedupeKey ? `${options.dedupeKey}#${i}` : null
              });
              if (result.ok) sent.push(msg);
              else {
                lastSendFailed.set(key, true);
                log(`QQ 发送未确认 (${key})：outbox=${result.state}${result.queued ? '（已排队，后台重试）' : ''}`);
              }
              return;
            } catch (error) {
              log(`⚠️ outbox 入队失败，回退直发 (${key})：${error?.message ?? error}`);
            }
          }
          if (kind === 'private') await withTimeout(bot.sendPrivateMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          else await withTimeout(bot.sendGroupMessage(Number(id), text(escapeCqText(msg))), SEND_TIMEOUT_MS, `QQ发送 ${kind}:${id}`);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          // 与 sendToQQ 同样的失败记账。少了这一步，调用方 `lastSendSucceeded(key)`
          // 会把「一条都没发出去」当成「我已经说过话了」：刷新 lastActiveMessageAt /
          // lastAiReplyAt 并抑制后续接话，而群里什么都没收到 —— 静默丢回复。
          lastSendFailed.set(key, true);
        });
      if (!isLast) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const delay = useLong ? randInt(longMin, longMax) : randInt(min, max);
        sendChain = sendChain.then(() => sleep(delay));
      }
    }
    return sendChain.then(() => sent);
  }


  async function onebotSend(kind, id, message, replyToMessageId, atUserId = null) {
    const segments = [];
    if (replyToMessageId !== undefined && replyToMessageId !== null && String(replyToMessageId).trim() !== '') {
      const rid = String(replyToMessageId).trim();
      if (!/^-?[1-9]\d*$/.test(rid)) throw new Error('replyToMessageId 必须是非零整数（消息 id 可能为负数）');
      segments.push({ type: 'reply', data: { id: rid } });
    }
    if (atUserId !== undefined && atUserId !== null && String(atUserId).trim() !== '') {
      const at = String(atUserId).trim();
      // 只允许正整数 QQ 号，禁止 @all，避免被滥用成 @全体成员
      if (!/^\d+$/.test(at)) throw new Error('atUserId 必须是正整数 QQ 号，且不能为 all');
      segments.push({ type: 'at', data: { qq: at } });
    }
    const rawMessage = String(message ?? '');
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && rawMessage.includes(t));
    if (hasKnownToken) {
      log(`发送内容包含会话令牌，已阻止发送 (${kind}:${id})`);
      throw new Error('发送内容包含会话令牌，已阻止发送');
    }
    segments.push({ type: 'text', data: { text: escapeCqText(rawMessage) } });
    const action = kind === 'private' ? 'send_private_msg' : 'send_group_msg';
    const params = kind === 'private' ? { user_id: Number(id), message: segments } : { group_id: Number(id), message: segments };
    const httpUrl = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const res = await fetch(`${httpUrl}/${action}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {})
      },
      body: JSON.stringify(params),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.status !== 'ok' || body.retcode !== 0) {
      const hint = res.status === 426 ? '（HTTP 426：snowluma.httpUrl 可能指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址）' : '';
      throw new Error(`OneBot ${action} 失败: ${body.wording || body.retcode || res.status}${hint}`);
    }
    return body.data;
  }

  // ── 图片/表情字节解析（供旧版自动内联与仿真按需工具） ────────────────────
  function mimeFromBuffer(buf) {
    if (!buf || buf.length < 12) return 'image/jpeg';
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'image/png';
    if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
    if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') return 'image/gif';
    if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return 'image/webp';
    return 'image/jpeg';
  }

  function mimeFromUrl(url, fallback = 'image/jpeg') {
    try {
      const pathname = new URL(String(url)).pathname.toLowerCase();
      if (pathname.endsWith('.png')) return 'image/png';
      if (pathname.endsWith('.webp')) return 'image/webp';
      if (pathname.endsWith('.gif')) return 'image/gif';
      if (pathname.endsWith('.jpg') || pathname.endsWith('.jpeg')) return 'image/jpeg';
    } catch {}
    return fallback;
  }

  // 解析常见图片宽高（PNG/JPEG/GIF；WebP 暂不解析返回 null）。
  // 用于限制“图片炸弹”的解码像素量。
  function getImageDimensions(buf) {
    if (!buf || buf.length < 24) return null;
    try {
      if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
        return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
      }
      if (buf.toString('ascii', 0, 6) === 'GIF87a' || buf.toString('ascii', 0, 6) === 'GIF89a') {
        return { width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
      }
      if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
        let offset = 2;
        while (offset + 9 < buf.length) {
          if (buf[offset] !== 0xff) { offset += 1; continue; }
          const marker = buf[offset + 1];
          if (marker === 0xd8 || marker === 0xd9 || (marker >= 0xd0 && marker <= 0xd7)) { offset += 2; continue; }
          const len = buf.readUInt16BE(offset + 2);
          if (len < 2) return null;
          // SOF0-SOF15（排除 DHT C4、DAC CC、DNL DC、DRI DD）
          if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
            return { height: buf.readUInt16BE(offset + 5), width: buf.readUInt16BE(offset + 7) };
          }
          offset += 2 + len;
        }
      }
      // WebP：解析 VP8X / VP8L / VP8 三种容器，避免“图片炸弹”绕过像素上限。
      if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
        const fourcc = buf.toString('ascii', 12, 16);
        if (fourcc === 'VP8X' && buf.length >= 30) {
          const width = 1 + buf[24] + (buf[25] << 8) + (buf[26] << 16);
          const height = 1 + buf[27] + (buf[28] << 8) + (buf[29] << 16);
          return { width, height };
        }
        if (fourcc === 'VP8L' && buf.length >= 25) {
          const bits = [buf[21], buf[22], buf[23], buf[24]];
          const width = 1 + (((bits[1] & 0x3f) << 8) | bits[0]);
          const height = 1 + (((bits[3] & 0x0f) << 10) | (bits[2] << 2) | ((bits[1] & 0xc0) >> 6));
          return { width, height };
        }
        if (fourcc === 'VP8 ' && buf.length >= 30) {
          const width = buf.readUInt16LE(26) & 0x3fff;
          const height = buf.readUInt16LE(28) & 0x3fff;
          return { width, height };
        }
      }
    } catch {}
    return null;
  }

  function base64FromMaybe(value) {
    if (typeof value !== 'string') return null;
    const s = value.trim();
    if (!s) return null;
    if (s.startsWith('base64://')) return s.slice('base64://'.length).replace(/\s/g, '');
    if (s.startsWith('data:image/')) {
      const idx = s.indexOf(',');
      if (idx >= 0) return s.slice(idx + 1).replace(/\s/g, '');
    }
    // 纯 base64（允许少量空白）
    if (/^[A-Za-z0-9+/=\s]+$/.test(s)) return s.replace(/\s/g, '');
    return null;
  }

  // 媒体上限（config.json 可调，但必须收敛到安全区间）：
  //   maxBytes  —— 单条消息里图片/表情的总字节上限。8MB 能覆盖绝大多数动图表情；
  //                太大会让 base64 常驻内存（×1.33）并拖慢 DSH 上传。
  //   maxPixels —— 单张图解码像素上限（防图片炸弹），与 DSH 的 64MP 默认一致。
  //   maxCount  —— 单条消息最多处理几张（防止一次 @ 带 20 张图把模型上下文撑爆）。
  const maxMediaBytesLimit = (() => {
    const n = Number(cfg.simulation?.media?.maxBytes);
    return Number.isFinite(n) && n > 0 ? Math.min(20 * 1024 * 1024, Math.max(256 * 1024, Math.round(n))) : 8 * 1024 * 1024;
  })();
  const MAX_MEDIA_COUNT = (() => {
    const n = Number(cfg.simulation?.media?.maxCount);
    return Number.isFinite(n) && n > 0 ? Math.min(8, Math.max(1, Math.round(n))) : 5;
  })();
  const MAX_MEDIA_BYTES = maxMediaBytesLimit; // 单条消息图片总字节上限
  const MAX_MEDIA_PIXELS = (() => {
    const n = Number(cfg.simulation?.media?.maxPixels);
    return Number.isFinite(n) && n > 0 ? Math.min(64_000_000, Math.max(1_000_000, Math.round(n))) : 64_000_000;
  })(); // 单张图片像素上限，防止“图片炸弹”解码拖垮 DSH
  const MAX_MEDIA_STORE_PER_KEY = 500; // 每个会话最多缓存多少条消息的媒体元数据，防止无限增长

  function isSafeLocalMediaPath(filePath) {
    try {
      const real = fs.realpathSync(String(filePath));
      const homeDir = cfg.snowluma?.homeDir ? String(cfg.snowluma.homeDir) : null;
      if (!homeDir) return false;
      const realHome = fs.realpathSync(homeDir);
      return real === realHome || real.startsWith(realHome + path.sep);
    } catch {
      return false;
    }
  }

  // OneBot 图片 file 字段只应接受简单缓存文件名；拒绝路径、URL、盘符、协议前缀等，
  // 防止把任意本地路径/内网 URL 交给网关 get_image 造成 SSRF/任意文件读取。
  function isProbablySafeImageFileRef(file) {
    const s = String(file ?? '').trim();
    if (!s || s.length > 512) return false;
    if (/[\u0000-\u001f\u007f]/.test(s)) return false;
    if (/[\\/]/.test(s)) return false;
    if (/^[a-zA-Z]:/.test(s)) return false;
    if (/^(file|https?|base64|data):/i.test(s)) return false;
    if (s.includes('..')) return false;
    return /^[\w.+=@-]+$/.test(s);
  }

  // QQ 表情包 CDN 的地址可以只靠 emoji_id 推出来（实测形态：
  // https://gxh.vip.qq.com/club/item/parcel/item/<id 前两位>/<id>/raw300.gif）。
  // 市场表情不在网关缓存里（get_image 返回 image not found in cache），url 又可能缺失，
  // 这条兜底能救回这一类；只接受纯十六进制 id，绝不把任意字符串拼进 URL。
  function emojiCdnCandidates(emojiId) {
    const id = String(emojiId ?? '').trim();
    if (!/^[0-9a-f]{16,64}$/i.test(id)) return [];
    return [`https://gxh.vip.qq.com/club/item/parcel/item/${id.slice(0, 2)}/${id}/raw300.gif`];
  }

  // 有些网关不带 emoji_id，但 file 名里就嵌着它（实测 "f9-<32 位 hex>.gif"）。
  function emojiIdFromFileName(file) {
    const match = /(?:^|[^0-9a-f])([0-9a-f]{32})\.(?:gif|png|jpe?g|webp)$/i.exec(String(file ?? '').trim());
    return match ? match[1] : '';
  }

  /** 校验一张图片字节：格式、大小（调用方已限）、像素上限；不通过返回 null。 */
  function acceptImageBuffer(buf, label = '图片') {
    if (!buf || !buf.length) return null;
    if (!looksLikeImageBuffer(buf)) {
      log(`${label}不是有效图片（PNG/JPEG/GIF/WebP），已跳过`);
      return null;
    }
    const dims = getImageDimensions(buf);
    if (dims && dims.width * dims.height > MAX_MEDIA_PIXELS) {
      log(`${label}像素超限，已跳过（${dims.width}x${dims.height}）`);
      return null;
    }
    return { buffer: buf, mimeType: mimeFromBuffer(buf) };
  }

  async function fetchOneBotImage(media, { failures: failureSink } = {}) {
    // 表情包（市场/收藏表情）优先走 CDN：get_image 对市场表情必然失败
    // （SnowLuma 缓存里没有该文件），先试 URL 能省一次失败往返，也更可靠。
    const emojiId = String(media.emojiId || emojiIdFromFileName(media.file) || '');
    const isSticker = media.kind === 'sticker' || !!emojiId || String(media.subType || '') === '1';
    const label = isSticker ? '表情' : '图片';
    // 调用方可以传入数组，拿到每个来源的失败原因；不传则只在本函数日志里留证。
    const failures = Array.isArray(failureSink) ? failureSink : [];
    const recordFailure = (source, message, url) => {
      failures.push({ source, message: String(message ?? ''), ...(url ? { url: stickerFetchUrlForLog(url) } : {}) });
    };
    const targets = [];
    const pushUrl = (raw, source) => {
      const s = String(raw ?? '').trim();
      if (!/^https?:\/\//i.test(s) || targets.some((item) => item.url === s)) return;
      targets.push({ url: s, source });
    };
    pushUrl(media.url, 'url');
    for (const candidate of emojiCdnCandidates(emojiId)) pushUrl(candidate, 'cdn');
    const rejectReason = (buf) => (buf && looksLikeImageBuffer(buf) ? '像素超限' : '不是有效图片');

    const tryUrls = async () => {
      for (const target of targets) {
        try {
          const fetched = await safeFetchBuffer(target.url, MAX_MEDIA_BYTES);
          const accepted = acceptImageBuffer(fetched.buffer, `${label} URL `);
          if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(target.url) };
          recordFailure(target.source, rejectReason(fetched.buffer), target.url);
        } catch (error) {
          recordFailure(target.source, error?.message ?? error, target.url);
        }
      }
      return null;
    };
    // 只有 file 是安全缓存文件名时才允许交给网关（防任意路径/内网 URL 注入）。
    const tryGetImage = async () => {
      if (!(media.kind === 'image' || media.kind === 'sticker')) return null;
      if (!media.file) return null;
      if (!isProbablySafeImageFileRef(media.file)) {
        recordFailure('get_image', 'file 引用不安全，已跳过');
        return null;
      }
      let sawPayload = false;
      try {
        const info = await bot.getImage({ file: String(media.file) });
        const obj = info && typeof info === 'object' ? info : {};
        const base64 = base64FromMaybe(obj.data) || base64FromMaybe(obj.base64) || base64FromMaybe(obj.file);
        if (base64) {
          sawPayload = true;
          // 粗略估计 base64 解码后大小，超限直接拒绝，避免超大字符串撑爆内存
          if (base64.length * 3 / 4 <= MAX_MEDIA_BYTES) {
            const accepted = acceptImageBuffer(Buffer.from(base64, 'base64'), 'get_image 返回的图片');
            if (accepted) return accepted;
            recordFailure('get_image', '返回的 base64 不是有效图片');
          } else {
            recordFailure('get_image', '返回的 base64 超过大小上限');
            log(`get_image 返回的图片 base64 超限，已跳过（${Math.round(base64.length * 3 / 4 / 1024)}KB）`);
          }
        }
        if (obj.url) {
          sawPayload = true;
          try {
            const fetched = await safeFetchBuffer(String(obj.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, 'get_image URL 图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(obj.url) };
            recordFailure('get_image', rejectReason(fetched.buffer), obj.url);
          } catch (error) {
            recordFailure('get_image', error?.message ?? error, obj.url);
          }
        }
        if (typeof obj.file === 'string' && !obj.file.startsWith('base64://') && fs.existsSync(obj.file) && isSafeLocalMediaPath(obj.file)) {
          sawPayload = true;
          const stat = fs.statSync(obj.file);
          if (stat.size > MAX_MEDIA_BYTES) {
            recordFailure('get_image', '本地图片超过大小上限', obj.file);
            log(`本地图片文件超限，已跳过（${Math.round(stat.size / 1024)}KB）`);
          } else {
            const accepted = acceptImageBuffer(fs.readFileSync(obj.file), '本地图片');
            if (accepted) return accepted;
            recordFailure('get_image', '本地图片不是有效图片', obj.file);
          }
        }
        if (!sawPayload) recordFailure('get_image', '没有返回图片数据');
      } catch (error) {
        recordFailure('get_image', error?.message ?? error);
      }
      return null;
    };
    // 兜底：收藏库接口按 emoji_id 反查地址。市场表情不在库里时正常不命中，不影响原顺序。
    const tryCustomFaceDetail = async () => {
      if (media?.kind !== 'sticker' || !emojiId) return null;
      let res;
      try {
        res = await bot.request('fetch_custom_face_detail', { count: 50 });
      } catch (error) {
        recordFailure('library', error?.message ?? error);
        return null;
      }
      if (!res || res.status !== 'ok' || res.retcode !== 0) {
        recordFailure('library', `接口返回 ${res?.wording || res?.retcode || 'unknown'}`);
        return null;
      }
      const items = Array.isArray(res.data) ? res.data : (Array.isArray(res.data?.list) ? res.data.list : []);
      const match = items.find((item) => {
        const id = String(item?.emoji_id ?? item?.emojiId ?? item?.resId ?? item?.id ?? '');
        return id && id.toLowerCase() === emojiId.toLowerCase();
      });
      if (!match || !match.url) {
        recordFailure('library', '没找到这个表情');
        return null;
      }
      try {
        const fetched = await safeFetchBuffer(String(match.url), MAX_MEDIA_BYTES);
        const accepted = acceptImageBuffer(fetched.buffer, `${label} 收藏库 `);
        if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(match.url) };
        recordFailure('library', rejectReason(fetched.buffer), match.url);
      } catch (error) {
        recordFailure('library', error?.message ?? error, match.url);
      }
      return null;
    };

    const result = isSticker
      ? (await tryUrls()) ?? (await tryGetImage()) ?? (await tryCustomFaceDetail())
      : (await tryGetImage()) ?? (await tryUrls());
    if (result) return result;
    if (failures.length) {
      const detail = failures.slice(0, 4).map((item) => {
        const source = STICKER_FETCH_SOURCE_LABELS[item.source] || item.source;
        const where = item.url ? ` ${stickerFetchUrlForLog(item.url)}` : '';
        return `${source}${where}: ${sanitizeStickerFetchText(item.message, 120)}`;
      }).join(' | ');
      log(`[media] ${label}获取失败（${failures.length} 次尝试）：${detail}`);
    }
    return null;
  }

  async function fetchFaceMedia(media) {
    const faceId = Number(media.faceId);
    // 系统小表情（face 段）：只有数字 id 才有对应实体；拿不到时至少保留 summary 文案。
    const fallbackText = media.summary ? `[表情:${media.summary}]` : `[表情#${media.faceId}]`;
    if (!Number.isInteger(faceId)) return { text: fallbackText };
    try {
      const face = await bot.fetchFaceEntity(faceId);
      if (face && typeof face === 'object') {
        const desc = face.q_des || (Array.isArray(face.emoji_name_alias) && face.emoji_name_alias[0]) || '';
        if (face.url) {
          try {
            const fetched = await safeFetchBuffer(String(face.url), MAX_MEDIA_BYTES);
            const accepted = acceptImageBuffer(fetched.buffer, '表情图片');
            if (accepted) return { ...accepted, mimeType: accepted.mimeType || mimeFromUrl(face.url), text: desc ? `[表情:${desc}]` : '' };
          } catch (error) {
            log(`表情图片抓取失败: ${error?.message ?? error}`);
          }
        }
        return { text: desc ? `[表情:${desc}]` : fallbackText };
      }
    } catch (error) {
      log(`fetchFaceEntity 失败: ${error?.message ?? error}`);
    }
    return { text: fallbackText };
  }

  async function resolveMediaList(mediaList) {
    const parts = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        parts.push({ type: 'text', text: `[图片/表情 ${index}（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）]` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `[表情${index}（图片总大小超限，已跳过）]` });
            continue;
          }
          totalBytes += face.buffer.length;
          if (face.text) parts.push({ type: 'text', text: face.text });
          parts.push({ type: 'image', mediaType: face.mimeType || 'image/png', data: face.buffer.toString('base64'), name: `face-${media.faceId}.${(face.mimeType || 'png').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const sticker = media.kind === 'sticker';
        const summary = sticker && media.summary ? `:${String(media.summary).slice(0, 20)}` : '';
        const label = sticker ? (summary ? `[表情${summary}]` : `[表情${index}]`) : `[图片${index}]`;
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            parts.push({ type: 'text', text: `${label}（图片总大小超限，已跳过）` });
            continue;
          }
          totalBytes += img.buffer.length;
          parts.push({ type: 'text', text: label });
          parts.push({ type: 'image', mediaType: img.mimeType || 'image/jpeg', data: img.buffer.toString('base64'), name: `qq-${sticker ? 'sticker' : 'image'}-${index}.${(img.mimeType || 'image/jpeg').split('/')[1]}` });
        } else {
          parts.push({ type: 'text', text: `${label}（获取失败）` });
        }
      }
    }
    return parts;
  }

  async function fetchMediaData(mediaList) {
    const out = [];
    let index = 0;
    let totalBytes = 0;
    for (const media of Array.isArray(mediaList) ? mediaList : []) {
      index += 1;
      if (index > MAX_MEDIA_COUNT) {
        out.push({ index, kind: media?.kind === 'face' ? 'face' : (media?.kind === 'sticker' ? 'sticker' : 'image'), text: `（超过单条上限 ${MAX_MEDIA_COUNT}，已跳过）` });
        continue;
      }
      if (!media || typeof media !== 'object') continue;
      if (media.kind === 'face') {
        const face = await fetchFaceMedia(media);
        if (face.buffer) {
          if (totalBytes + face.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: '（图片总大小超限，已跳过）' });
            continue;
          }
          totalBytes += face.buffer.length;
          out.push({
            index,
            kind: 'face',
            faceId: media.faceId ? String(media.faceId) : undefined,
            mimeType: face.mimeType || 'image/png',
            data: face.buffer.toString('base64'),
            text: face.text || ''
          });
        } else {
          out.push({ index, kind: 'face', faceId: media.faceId ? String(media.faceId) : undefined, text: face.text || `[表情#${media.faceId}]` });
        }
      } else {
        const img = await fetchOneBotImage(media);
        const kind = media.kind === 'sticker' ? 'sticker' : 'image';
        const noun = kind === 'sticker' ? '表情' : '图片';
        const base = {
          index,
          kind,
          ...(media.file ? { file: String(media.file) } : {}),
          ...(media.url ? { url: String(media.url) } : {}),
          ...(media.emojiId ? { emojiId: String(media.emojiId) } : {}),
          ...(media.summary ? { summary: String(media.summary) } : {}),
          ...(media.subType ? { subType: String(media.subType) } : {})
        };
        if (img?.buffer) {
          if (totalBytes + img.buffer.length > MAX_MEDIA_BYTES) {
            out.push({ ...base, text: `（${noun}总大小超限，已跳过）` });
            continue;
          }
          totalBytes += img.buffer.length;
          out.push({
            ...base,
            mimeType: img.mimeType || 'image/jpeg',
            data: img.buffer.toString('base64'),
            text: ''
          });
        } else {
          out.push({ ...base, text: `（${noun}获取失败）` });
        }
      }
    }
    return out;
  }

  function mediaHintFor(key, messageRef, mediaList) {
    if (!Array.isArray(mediaList) || mediaList.length === 0 || !messageRef) return '';
    if (currentMode === 'simulation') {
      return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。如需要查看/识别，请调用 mcp__snowluma__qq_get_message_images，参数 key="${key}", messageId="${messageRef}"。`;
    }
    return `\n【图片/表情】本条消息包含 ${mediaList.length} 个图片/表情（消息ID=${messageRef}）。`;
  }

  function findMessageMedia(key, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return [];
    // 仿真：消息对象上直接带 media（仅在确实存在仿真会话状态时读取，避免为 gen1 创建影子状态）
    if (currentMode === 'simulation' || simulation.conversations.has(key)) {
      try {
        const st = getSimulationState(key);
        if (st) {
          // Unread can outlive the recent window. Compact model views retain
          // handles instead of transport URLs, so both buffers must resolve.
          for (const messages of [st.recentMessages, st.unread]) {
            const found = (Array.isArray(messages) ? messages : []).find((m) => m && (String(m.messageId || '') === refStr || String(m.seq || '') === refStr));
            if (found && Array.isArray(found.media) && found.media.length) return found.media;
          }
        }
      } catch {}
    }
    // 旧版/普通模式：messageMediaStore
    const byRef = messageMediaStore.get(key);
    if (byRef) {
      const hit = byRef.get(refStr);
      if (Array.isArray(hit)) return hit;
      // 兼容按 seq 查找（messageMediaStore 只存 messageId 时，尝试遍历所有值）
      for (const [storedRef, media] of byRef) {
        if (String(storedRef) === refStr && Array.isArray(media)) return media;
      }
    }
    return [];
  }

  function clampGap(ms, sendCfg) {
    const min = Math.max(100, Number(sendCfg.burstIntervalMinMs) || 300);
    const max = Math.max(min, Number(sendCfg.maxGapMs) || 10000);
    return Math.max(min, Math.min(max, Math.round(Number(ms) || min)));
  }

  function computeGaps(messages, gapMode, gapMs, gaps, sendCfg) {
    const delays = [];
    if (!messages || messages.length <= 1) return delays;
    const mode = gapMode === 'fixed' || gapMode === 'byLength' ? gapMode : 'auto';
    if (mode === 'fixed') {
      if (Array.isArray(gaps) && gaps.length >= messages.length - 1) {
        for (let i = 0; i < messages.length - 1; i++) delays.push(clampGap(gaps[i], sendCfg));
      } else {
        const g = clampGap(Number(gapMs) || Number(sendCfg.burstIntervalMinMs) || 1000, sendCfg);
        for (let i = 0; i < messages.length - 1; i++) delays.push(g);
      }
    } else if (mode === 'byLength') {
      const base = Number(sendCfg.gapBaseMs) || 800;
      const perChar = Number(sendCfg.gapPerCharMs) || 20;
      for (let i = 0; i < messages.length - 1; i++) {
        const chars = Math.max(1, String(messages[i] || '').length);
        delays.push(clampGap(base + chars * perChar, sendCfg));
      }
    } else {
      const longProb = Math.min(1, Math.max(0, Number(sendCfg.longGapProbability) || 0));
      for (let i = 0; i < messages.length - 1; i++) {
        const useLong = longProb > 0 && Math.random() < longProb;
        const min = useLong ? (Number(sendCfg.longGapMinMs) || 5000) : (Number(sendCfg.burstIntervalMinMs) || 1000);
        const max = useLong ? (Number(sendCfg.longGapMaxMs) || 10000) : (Number(sendCfg.burstIntervalMaxMs) || 3000);
        delays.push(clampGap(randInt(Math.max(100, min), Math.max(100, max)), sendCfg));
      }
    }
    return delays;
  }

  // 真人打字很少在句末加句号；只裁掉末尾的中文句号，中间的标点保持原样。
  // 只处理全角「。」，不动半角「.」——避免误伤英文句子、版本号和 URL。
  function stripTrailingPeriod(text) {
    const raw = String(text ?? '');
    const trimmed = raw.replace(/\s+$/, '');
    if (!trimmed) return raw;
    const next = trimmed.replace(/。+$/u, '');
    return next || raw;
  }

  function sendMessages(key, messages, delays, replyToMessageId, atUserId = null, options = {}) {
    const assertSendAllowed = captureSendGuard(key);
    const [kind, id] = key.split(':');
    const sent = [];
    const failed = [];
    let queuedCount = 0;
    for (let i = 0; i < messages.length; i++) {
      const msg = stripTrailingPeriod(messages[i]);
      const useReply = i === 0 ? replyToMessageId : null;
      const useAt = i === 0 ? atUserId : null;
      const dedupeKey = options?.dedupeKey ? `${options.dedupeKey}#${i}` : null;
      sendChain = sendChain
        .then(async () => {
          assertSendAllowed();
          if (outbox) {
            try {
              const result = await outbox.sendNow({
                key,
                kind: 'text',
                payload: { text: msg, transport: 'http', replyToMessageId: useReply, atUserId: useAt },
                dedupeKey
              });
              if (result.ok) { sent.push(msg); return; }
              // 已持久化、后台会重试：明确告诉调用方「未确认送达」，并提示不要重发同一条。
              queuedCount += 1;
              const err = new Error(`QQ 发送未确认（outbox=${result.state}，已进入重试队列，请勿重复发送同一条内容）`);
              err.queued = true;
              failed.push(err);
              return;
            } catch (error) {
              log(`⚠️ outbox 入队失败，回退直发 (${key})：${error?.message ?? error}`);
            }
          }
          await onebotSend(kind, id, msg, useReply, useAt);
          sent.push(msg);
        })
        .catch((error) => {
          log(`QQ 发送失败 (${key}):`, error?.message ?? error);
          failed.push(error);
        });
      if (i < delays.length) {
        const d = delays[i];
        sendChain = sendChain.then(() => sleep(d));
      }
    }
    return sendChain.then(() => {
      if (failed.length > 0) {
        const err = new Error(`QQ 发送失败 ${failed.length}/${messages.length} 条：${failed[0]?.message ?? '未知错误'}`);
        err.sent = sent.slice();
        err.queuedCount = queuedCount;
        err.failed = failed.slice();
        throw err;
      }
      return sent;
    });
  }

  // 审计范围：closed-agent 仅对 owner 私聊跳过；其余模式/会话一律审计
  function shouldAuditKey(key) {
    if (currentMode === 'closed-agent') {
      return !(key === `private:${String(cfg.ownerQQ ?? '')}`);
    }
    return true;
  }

  // 入队校验无法约束排队等待期间的权限变化，每条消息临近实际发送时再次校验。
  function captureSendGuard(key) {
    const policy = sessionPolicy(key);
    const sessionId = state.sessions[key];
    return () => {
      if (!isSessionAllowedInCurrentMode(key) || policy !== sessionPolicy(key)
          || (sessionId && state.sessions[key] !== sessionId)) {
        throw new Error('发送已取消：会话、模式或白名单已变化');
      }
    };
  }

  // 静默模式：除 owner 私聊外，不发送任何在途 AI 回复。
  function shouldBlockSilentReply(key) {
    const roleState = readRoleState();
    return roleState.mode === 'silent' && key !== `private:${String(cfg.ownerQQ ?? '')}`;
  }

  // 统一出站消息：先完整文本审计，再发送。返回是否**确认发出**（排队未确认按 false 处理）。
  async function auditAndSend(key, text, options = {}) {
    const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && String(text ?? '').includes(t));
    if (shouldAuditKey(key) && (SENSITIVE_RE.test(text) || hasKnownToken)) {
      log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
      appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
      if (cfg.security?.interceptNotify !== false) {
        await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
      }
      return false;
    }
    await sendToQQ(key, text, options);
    return lastSendSucceeded(key);
  }

  // 会话模型应用去重：每个 DSH 会话在本进程内只 selectModel 一次；
  // 控制台热切换思考强度时递增 modelSelectionEpoch，使旧记录失效并在下一条消息重新应用。
  // 四种 QQ 模式共用 DSH 会话，统一强制使用多模态模型 DeepSeek-V41-Flash（id: deepseek-flash）；
  // 它同时支持 text/image 输入，取代已下线的 deepseek-v4-flash-vision-exp。
  const modelAppliedSessions = new Map(); // sessionId -> 已应用的 modelSelectionEpoch
  // 返回 'applied' | 'not-found' | 'failed'。
  // 'not-found' 表示 DSH 侧会话已经不存在（DSH 重启、异常退出、归档竞态），
  // 本地映射已失效，调用方必须退役重建，否则每条消息都会对着一个不存在的会话重试。
  async function ensureChatModel(sessionId, tier = 'chat', { key = '' } = {}) {
    const groupProfile = key ? (cfg.simulation?.groupProfiles?.[key] ?? null) : null;
    const routes = resolveModelRoutes({ tier, routing: cfg.routing, dsh: cfg.dsh, groupProfile });
    const appliedKey = `${modelSelectionEpoch}:${routes.map(routeSignature).join('>')}`;
    if (modelAppliedSessions.get(sessionId) === appliedKey) return 'applied';
    for (const route of routes) {
      const { provider, model, effort } = route;
      for (let attempt = 1; attempt <= 2; attempt += 1) {
        try {
          const params = { sessionId, provider, model };
          if (!reasoningEffortUnsupported && effort) params.reasoningEffort = effort;
          const result = unwrap(await api.sessions.selectModel(params), 'session.selectModel');
          modelAppliedSessions.set(sessionId, appliedKey);
          log(`已设置会话模型 ${sessionId} -> ${result.selected.provider}/${result.selected.model} (${result.selected.reasoningEffort ?? '默认'}${tier !== 'chat' ? `，tier=${tier}` : ''})`);
          return 'applied';
        } catch (error) {
          const detail = String(error?.message ?? error);
          log(`设置会话模型失败 ${sessionId}（${provider}/${model} 第 ${attempt}/2 次）: ${detail}`);
          // 会话已不存在：换模型没有意义，交给调用方退役重建。
          if (/not[- ]?found/i.test(detail)) {
            modelAppliedSessions.set(sessionId, appliedKey);
            return 'not-found';
          }
          // provider 没有声明 reasoning effort 档位时，去掉该参数重试；探明一次即全局记住。
          if (!reasoningEffortUnsupported && /does not support reasoning effort/i.test(detail)) {
            reasoningEffortUnsupported = true;
            log(`⚠️ ${provider}/${model} 不支持 reasoningEffort，后续会话改为不传该参数`);
            continue;
          }
          if (attempt < 2) await sleep(600);
        }
      }
      if (routes.length > 1) log(`模型路由降级：${routeSignature(route)} 不可用，尝试下一条`);
    }
    return 'failed';
  }

  async function ensureSession(key) {
    const epoch = sessionEpoch;
    const policy = sessionPolicy(key);
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    const existing = state.sessions[key];
    if (existing) {
      // reset/清空工作区期间旧映射可能尚未清理；发现代际不匹配必须丢弃旧会话，防止复活。
      if (!isCurrentSession(key, existing)) {
        retireSession(key);
      } else {
        const applied = await ensureChatModel(existing, 'chat', { key });
        // DSH 侧会话已不存在（DSH 重启、异常退出、归档竞态）：本地映射已经失效，
        // 必须退役并重建，否则每条消息都会对着一个不存在的会话重试 selectModel。
        if (applied === 'not-found') {
          log(`会话 ${key} 在 DSH 侧已不存在，退役本地映射并在本次调用中重建`);
          retireSession(key);
        } else {
          if (epoch !== sessionEpoch || !isCurrentSession(key, existing)) throw new Error('会话创建期间已重置或权限已变化');
          return existing;
        }
      }
    }
    if (sessionPromises.has(key)) return sessionPromises.get(key);
    const promise = (async () => {
      const dir = cfg.sessionCwd ? String(cfg.sessionCwd) : path.join(STATE_DIR, 'agents');
      fs.mkdirSync(dir, { recursive: true });
      let sessionId;
      let lastError = null;
      const preset = modePreset(key, currentMode, cfg);
      // 非 closed-agent（chat / reserved / simulation，会话可能属于 QQ 群）必须 fail-closed：
      // 拿不到 qq-chat* 就拒绝建会话，绝不让 DSH 用默认 preset（standard）顶上——那会把
      // bash/文件读写等本地工具暴露给 QQ 群里的任何人（见 RULES.md「无本地工具」）。
      // closed-agent 仅 owner 私聊、本来就用完整工具面，回退不构成提权。
      const strictPreset = currentMode !== 'closed-agent';
      if (strictPreset && !preset) {
        const wanted = currentMode === 'simulation' ? (cfg.simulation?.agentPreset || cfg.agentPreset) : cfg.agentPreset;
        throw new Error(`拒绝为 ${key} 创建会话：模式 ${currentMode} 需要 preset "${wanted}"，但它不在 DSH 可用清单中（${dshPresetIds.join(', ') || '未知'}）。回退到 DSH 默认 preset 会把本地工具暴露给 QQ 群；请先运行 node tools/install-dsh.mjs 并重启 DSH。`);
      }
      // 归组：所有 QQ 会话挂到同一个 workspace（幂等创建），GUI 里不再散落「未分组」
      // 创建顺序有安全含义：
      //   1) workspace + agentPreset —— 正常路径；
      //   2) workspace 无 preset     —— 仅 closed-agent 允许的降级（那里本就是完整工具面）；
      //      群聊模式绝不走这一步：DSH 会给「无 preset 会话」套上默认 preset（standard）。
      for (const withPreset of strictPreset ? [true] : [true, false]) {
        try {
          const wsValue = unwrap(await api.workspace.create({ path: dir }), 'workspace.create');
          if (wsValue.created && cfg.workspaceTitle) {
            await api.workspace.rename({ workspaceId: wsValue.workspace.workspaceId, title: cfg.workspaceTitle });
          }
          const params = { workspaceId: wsValue.workspace.workspaceId };
          if (withPreset && preset) params.agentPreset = preset;
          const value = unwrap(await api.sessions.create(params), 'session.create');
          sessionId = value.sessionId;
          if (withPreset && preset) {
            log(`会话 ${key} 已挂载 preset ${preset}`);
          } else if (preset) {
            log(`⚠️ 会话 ${key} 未能挂载 preset ${preset}（${lastError?.message ?? '未知原因'}），已降级为无 preset 会话；请检查 ~/.dsh/.agent-presets/${preset} 后重启 DSH`);
          }
          break;
        } catch (error) {
          lastError = error;
        }
      }
      if (!sessionId) {
        throw new Error(`无法为 ${key} 创建 DSH 会话（模式 ${currentMode}，preset ${preset ?? '无'}）：${lastError?.message ?? '未知原因'}。已拒绝退化为 DSH 默认 preset 会话——那会把本地工具暴露给 QQ 群。`);
      }
      // 新版 DSH 事件流需要显式 follow 该会话，否则收不到 turn 事件。
      api.events.follow(sessionId);
      // reset/清空工作区期间创建完成：丢弃，防止旧会话复活
      if (epoch !== sessionEpoch || policy !== sessionPolicy(key) || !isSessionAllowedInCurrentMode(key)) {
        log(`会话创建期间发生 reset，丢弃 ${key} 的新会话（${sessionId}）`);
        try { await withTimeout(api.workspace.archiveSession({ sessionId }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
        throw new Error('会话创建期间已重置，丢弃新会话');
      }
      state.sessions[key] = sessionId;
      state.sessionPolicies[key] = policy;
      reverse.set(sessionId, key);
      saveState();
      await ensureChatModel(sessionId, 'chat', { key });
      if (epoch !== sessionEpoch || !isCurrentSession(key, sessionId)) {
        if (state.sessions[key] === sessionId) retireSession(key);
        throw new Error('会话创建期间已重置或权限已变化');
      }
      log(`新会话 ${key} -> ${sessionId}（模式 ${currentMode}，preset: ${modePreset(key, currentMode, cfg) ?? '默认'}）`);
      return sessionId;
    })();
    sessionPromises.set(key, promise);
    try {
      return await promise;
    } finally {
      // 只有仍持有该条目的 promise 才删除，避免旧 promise 误删 reset 后新建的 promise。
      if (sessionPromises.get(key) === promise) sessionPromises.delete(key);
    }
  }

  // ── 仿真群友社交引擎（仿真模式，内部标识 reserved） ────────────────────────
  const randInt = (min, max) => {
    if (min > max) [min, max] = [max, min];
    return Math.floor(min + Math.random() * (max - min + 1));
  };
  let selfNickname = 'deepseek'; // 机器人昵称（小写；启动时从网关获取，识别"被提到"用）
  // 给 agent 看的身份（保留原始大小写）与机器人自己的 QQ 号。
  // 为什么必须单独存：消息里只有 "@樰" 这一串文本，agent 没有任何途径知道"樰"就是它自己，
  // 于是会把 @自己 当成 @别人、已读不回（issue #29）。昵称与 QQ 号要显式写进 prompt。
  let selfDisplayName = '';
  let selfUserId = '';
  let selfIdentityAt = 0;
  let selfIdentityRefreshing = false;
  const selfAliases = new Set(); // QQ 昵称改过之后，旧称呼仍能触发“叫名字”
  // 自定义角色的默认关键词：角色名 + 已知别名 + 中性词，不再继承默认角色的鲸鱼词。
  const NEUTRAL_ROLE_KEYWORDS = ['在吗'];
  const escapeRe = (value) => String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // 纯 ASCII 名字按词边界匹配，避免 DS 命中 friends / Roxy 命中 proxy；中文名继续用包含匹配。
  function namePattern(word) {
    const text = String(word ?? '').trim().toLowerCase();
    if (!text) return '';
    if (/^[a-z0-9]+$/.test(text)) return `(^|[^a-z0-9])${escapeRe(text)}([^a-z0-9]|$)`;
    return escapeRe(text);
  }
  function nameMatchesText(lower, word, custom = false) {
    const text = String(word ?? '').trim().toLowerCase();
    if (!text) return false;
    if (custom && /^[a-z0-9]+$/.test(text)) {
      return new RegExp(namePattern(text)).test(lower);
    }
    return lower.includes(text);
  }
  function keywordMatchesText(lower, word, custom = false) {
    const key = String(word ?? '').trim().toLowerCase();
    if (!key) return false;
    if (/^[a-z0-9]+$/.test(key) && key.length <= 4) {
      return new RegExp(`\\b${escapeRe(key)}\\b`, 'i').test(lower);
    }
    // 自定义角色下“在吗”不能从 friends在吗 这类英文单词尾部误触发。
    if (custom && isNeutralRoleKeyword(word)) {
      return new RegExp(`(^|[^a-z0-9])${escapeRe(key)}`).test(lower);
    }
    return lower.includes(key);
  }
  function isDefaultPersonaIdentity(word) {
    return DEFAULT_PERSONA_WAKE_KEYWORDS_LOWER.has(String(word ?? '').trim().toLowerCase());
  }
  function roleDefaultKeywords() {
    const out = [];
    const seen = new Set();
    // 只过滤 QQ 昵称/旧昵称；用户可以把角色命名为「鲸鱼」「DeepSeek」「DS」「R1」。
    const aliases = [...selfAliases].filter((alias) => !isDefaultPersonaIdentity(alias));
    for (const raw of [currentRoleName(), ...aliases, ...NEUTRAL_ROLE_KEYWORDS]) {
      const word = String(raw ?? '').trim();
      if (!word) continue;
      const key = word.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(word);
    }
    return out;
  }
  function roleAwareKeywords(configured, explicit) {
    if (!isCustomRoleName(currentRoleName()) || explicit) return configured;
    return roleDefaultKeywords();
  }
  function configuredWakeKeywords() {
    const wake = cfg.simulation?.wake ?? {};
    return Array.isArray(wake.recommendedKeywords) ? wake.recommendedKeywords.map(String) : [];
  }
  function effectiveMustReplyKeywords() {
    const configured = Array.isArray(cfg.social?.mustReplyKeywords)
      ? cfg.social.mustReplyKeywords.map(String).filter(Boolean)
      : [];
    return roleAwareKeywords(configured, socialKeywordsExplicit);
  }
  // 控制台读取配置时也按角色展示默认关键词；显式配置保持原样。
  function simulationConfigForView() {
    const sim = cfg.simulation ?? {};
    if (!isCustomRoleName(currentRoleName()) || wakeKeywordsExplicit) return sim;
    return { ...sim, wake: { ...(sim.wake ?? {}), recommendedKeywords: roleDefaultKeywords() } };
  }
  function socialConfigForView() {
    if (!isCustomRoleName(currentRoleName()) || socialKeywordsExplicit) return cfg.social;
    return { ...(cfg.social ?? {}), mustReplyKeywords: effectiveMustReplyKeywords() };
  }
  function aiMentionPattern() {
    if (isCustomRoleName(currentRoleName())) {
      // 自定义角色下不把默认人格词（含 DeepSeek）当成 AI 自称；当前角色名始终保留。
      const parts = ['claude', 'chatgpt', 'gpt', 'ai', '人工智障', '机器人', '模型'].map(namePattern);
      const roleName = String(currentRoleName() ?? '').trim();
      if (roleName) parts.push(namePattern(roleName));
      for (const alias of selfAliases) {
        const word = String(alias ?? '').trim();
        if (!word || isDefaultPersonaIdentity(word)) continue;
        parts.push(namePattern(word));
      }
      return new RegExp(parts.filter(Boolean).join('|'));
    }
    return /deepseek|claude|chatgpt|gpt|大肥鱼|小鲸鱼|鲸鱼|d指导|d老师|d师傅|深度求索|\bds\b|ai|人工智障|机器人|模型/;
  }
  function mentionsDefaultPersonaName(lower) {
    for (const word of DEFAULT_PERSONA_WAKE_KEYWORDS_LOWER) {
      if (!word) continue;
      if (/^[a-z0-9]+$/.test(word) && word.length <= 3) {
        if (new RegExp(`(^|[^a-z0-9])${escapeRe(word)}([^a-z0-9]|$)`).test(lower)) return true;
      } else if (lower.includes(word)) {
        return true;
      }
    }
    return false;
  }
  function isNeutralRoleKeyword(word) {
    const key = String(word ?? '').trim().toLowerCase();
    return NEUTRAL_ROLE_KEYWORDS.some((neutral) => neutral.toLowerCase() === key);
  }
  const SILENT_TURN_TIMEOUT_MS = 300000; // 摘要静默名额 5 分钟未消费则作废，避免吞掉后续正常回复
  const social = {
    states: new Map(),             // key -> { phase: 'idle'|'active'|'probing'|'exiting', lastCheckAt, nextCheckAt, lastActiveMessageAt, activeEnteredAt, activeDeadlineAt, activeExitAt, probeDeadline }
    recentMessages: new Map(),     // key -> [{sender, text, time}]（最近消息窗口，AI 的"持续感知"）
    pendingSummaries: new Map(),   // key -> { items: [{sender, text, time}], since }（观望期未参与消息）
    silentContext: new Map(),      // key -> [{sender, text, time}]：选择性沉默但"已看到未回应"的消息，下次投递时带给模型
    loopTimer: null,
    silentTurns: new Map(),        // sessionId -> { id, ts }[]：待静默的摘要 turn 队列（FIFO + 超时回收）
    pendingTimers: new Map(),      // key -> Set<timerId>：社交排程中尚未触发的定时器
    exitingSessions: new Set()     // sessionId：当前正在等待“活跃超时退场”发言完成的 DSH 会话
  };

  // ── 群聊仿真模式（simulation）运行时状态与唤醒配置 ────────────────────────
  const simulation = {
    conversations: new Map(), // key -> state
    paused: false, // 控制台可暂停整个仿真 AI 活动（停止唤醒/等待）
  };

  // 旧版/普通模式的图片/表情元数据存储：key -> Map<messageId/seq, media[]>
  // 仿真模式则直接存在 simulation 会话的 recentMessages/unread 消息对象上。
  const messageMediaStore = new Map();
  // 仿真会话见过的 forward id（有界，避免 recentMessages 滚动淘汰后无法读取刚见过的转发）
  const seenForwardIds = new Map(); // key -> Set<string>

  // 归一化“指定群友发言唤醒”名单：
  // - 只保留正整数 QQ 号（字符串形式），拒绝 null/对象/“null”/非法字符等脏数据；
  // - 去重并限制最多 20 个，避免唤醒名单无限膨胀/被恶意塞入异常值；
  // - undefined/null 都视为“不启用”（空数组）。
  function normalizeSpeakerIds(value) {
    if (value === undefined || value === null) return [];
    const rawList = Array.isArray(value) ? value : String(value).split(/[,，\s]+/);
    const seen = new Set();
    const clean = [];
    for (const v of rawList) {
      const s = String(v ?? '').trim();
      if (!/^[1-9]\d*$/.test(s)) continue;
      if (seen.has(s)) continue;
      seen.add(s);
      clean.push(s);
      if (clean.length >= 20) break;
    }
    return clean;
  }

  // triggers 的**唯一**合法字段集合。写入与加载都按它过滤：
  // 旧写法 `{...current.triggers, ...inputTriggers}` 会把模型传来的任意键原样并入、
  // 持久化、再由 qq_get_prompt 原样回给模型（每次请求都带着），等于给了一个
  // 「用 1MB 垃圾键把状态文件与每轮 prompt 撑大」的入口。
  const WAKE_TRIGGER_KEYS = Object.freeze(['atMention', 'nameMention', 'speakerIds', 'keywords', 'question', 'poke', 'anyMessage', 'probability']);
  function pickWakeTriggers(source, fallback = {}) {
    const out = {};
    const src = source && typeof source === 'object' ? source : {};
    const fb = fallback && typeof fallback === 'object' ? fallback : {};
    for (const name of WAKE_TRIGGER_KEYS) {
      const value = Object.prototype.hasOwnProperty.call(src, name) ? src[name] : fb[name];
      if (value !== undefined) out[name] = value;
    }
    return out;
  }

  // 全局活跃控制：defaultMode 是总闸（active=活跃，diving=潜水），优先级高于会话 wakeConfig.mode。
  // 深潜是潜水下的更硬约束：群聊里只允许主人本人直接 @ 触发。
  function globalActivityMode() {
    if (cfg.simulation?.wake?.defaultMode === 'active') return 'active';
    return cfg.simulation?.activityControl?.deepDive === true ? 'deep' : 'diving';
  }

  function isDeepDive(key) {
    return String(key || '').startsWith('group:') && globalActivityMode() === 'deep';
  }

  function isOwnerSender(event) {
    return String(event?.user_id ?? event?.sender?.user_id ?? '') === String(cfg.ownerQQ ?? '');
  }

  function isAtSelf(event) {
    return Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at'
      && String(seg.data?.qq) === String(event?.self_id ?? ''));
  }

  // 深潜放行凭据：只有「主人本人直接 @」的进线才会盖时间戳，唤醒投递前再校验一次。
  const DEEP_DIVE_PASS_TTL_MS = 10 * 60 * 1000;
  function hasFreshDeepDivePass(st) {
    return Number(st?.deepDivePassAt || 0) > Date.now() - DEEP_DIVE_PASS_TTL_MS;
  }

  // 全局控制切换后立刻清理被压制的会话级定时器，避免旧活跃状态继续偷偷唤醒。
  function resyncActivityControl() {
    if (simulation.paused || currentMode !== 'simulation') return;
    // 仍在使用默认唤醒配置的会话跟随全局模式；显式设置过的不动。
    refreshAllDefaultWakeConfigs();
    const mode = globalActivityMode();
    for (const [key, st] of simulation.conversations.entries()) {
      if (!String(key).startsWith('group:')) continue;
      if (mode === 'deep') {
        for (const field of ['pendingWakeTimer', 'sleepTimer', 'replyCheckTimer', 'proactiveTimer', 'clingyTimer']) {
          if (st[field]) {
            clearTimeout(st[field]);
            st[field] = null;
          }
        }
        st.pendingWakeReasons = [];
        st.deepDivePassAt = 0;
        continue;
      }
      if (mode === 'diving') {
        // 潜水态不允许残留的回复检查/睡眠到期唤醒，主动冒泡仍按自身开关单独调度。
        for (const field of ['replyCheckTimer', 'sleepTimer']) {
          if (st[field]) {
            clearTimeout(st[field]);
            st[field] = null;
          }
        }
      }
      scheduleProactiveCheck(key);
      if (mode === 'diving') setupSleepTimer(key);
    }
  }

  function defaultWakeConfig() {
    const w = cfg.simulation?.wake ?? {};
    const defaultMode = w.defaultMode === 'active' ? 'active' : 'diving';
    const defaultInfinite = w.recommendedDefaultInfinite !== false;
    const recMin = Number(w.recommendedSleepMinMs) || 300000;
    const recMax = Number(w.recommendedSleepMaxMs) || 7200000;
    let finiteMs = recMin + Math.random() * Math.max(0, recMax - recMin);
    const hardMin = Math.max(0, Number(w.sleepMinMs) || 0);
    const hardMax = Number(w.sleepMaxMs) || 0;
    if (hardMin > 0 && finiteMs < hardMin) finiteMs = hardMin;
    if (hardMax > 0 && finiteMs > hardMax) finiteMs = hardMax;
    const configuredKeywords = configuredWakeKeywords();
    return {
      mode: defaultMode,
      infinite: defaultInfinite,
      sleepUntil: defaultInfinite ? null : new Date(Date.now() + Math.round(finiteMs)).toISOString(),
      triggers: {
        atMention: w.recommendedAtMention !== false,
        nameMention: w.recommendedNameMention !== false,
        speakerIds: [],
        keywords: roleAwareKeywords(configuredKeywords, wakeKeywordsExplicit),
        question: w.recommendedQuestion !== false,
        poke: w.recommendedPoke !== false,
        anyMessage: defaultMode === 'active',
        probability: Math.min(1, Math.max(0, Number(w.recommendedProbability) || 0))
      },
      batchWindowMs: Math.max(1000, Number(w.batchWindowMs) || 8000),
      lastWakeAt: 0,
      wakeCount: 0,
      noActionCount: 0,
      confirmedAt: 0,
      confirmedBy: 'default'
    };
  }

  // 把“仍使用默认唤醒配置”的会话刷新为当前推荐/默认参数。
  // 只有 confirmedBy === 'default' 的会话才会被刷新；AI 或管理员显式设置过的（set_wake_config / mark_read）不会被覆盖。
  function refreshDefaultWakeConfig(st) {
    if (!st || !st.wakeConfig) return false;
    if (st.wakeConfig.confirmedBy !== 'default') return false;
    const def = defaultWakeConfig();
    const old = st.wakeConfig;
    st.wakeConfig = {
      ...def,
      lastWakeAt: old.lastWakeAt || 0,
      wakeCount: old.wakeCount || 0,
      noActionCount: old.noActionCount || 0,
      confirmedAt: old.confirmedAt || 0,
      confirmedBy: 'default'
    };
    return true;
  }

  // 保存推荐/默认参数后，把所有仍使用默认配置的会话同步到新默认值。
  function refreshAllDefaultWakeConfigs() {
    let changed = false;
    for (const st of simulation.conversations.values()) {
      if (refreshDefaultWakeConfig(st)) changed = true;
    }
    if (changed) saveSimulationState();
    return changed;
  }

  // 角色切换只刷新默认关键词，不重置会话自己的 mode/sleepUntil 等唤醒参数。
  function refreshDefaultWakeKeywords() {
    const keywords = roleAwareKeywords(configuredWakeKeywords(), wakeKeywordsExplicit);
    let changed = false;
    for (const st of simulation.conversations.values()) {
      if (st.wakeConfig?.confirmedBy !== 'default' || !st.wakeConfig.triggers) continue;
      if (sameKeywordList(st.wakeConfig.triggers.keywords, keywords)) continue;
      st.wakeConfig = {
        ...st.wakeConfig,
        triggers: { ...st.wakeConfig.triggers, keywords: [...keywords] }
      };
      changed = true;
    }
    if (changed) saveSimulationState();
    return changed;
  }

  // 沉睡前强制观察窗口：防止 AI 聊两句就立刻潜水。
  // 新规则：每次设置潜水/下一次唤醒前，AI 必须先进入一次“沉睡前观察”（qq_wait_for_messages(timeoutMs=preSleepWaitMs)）。
  // - 观察期间没人说话 → 可以设置唤醒并沉睡（preSleepWaitSatisfiedAt）。
  // - 观察期间有人发了新消息 → 等待工具会把新消息带回给 AI（preSleepWaitObservedAt）；
  //   AI 看过新消息后若判断没必要参与，可以直接沉睡；若参与了（发送/拍一拍），则下次想睡需重新观察。
  const EXPLICIT_END_RE = /(?:不聊了|不说了|晚安|睡了|先睡了|下了|先下了|拜拜|再见|走了|先走|撤了|去忙|忙了|下次再聊|下次聊|散了吧|结束|就到这|先这样|就这样吧|886|88|睡觉了|下班了|去洗澡|去吃饭了)/i;

  function hasExplicitEnd(st) {
    const recent = Array.isArray(st?.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return false;
    return EXPLICIT_END_RE.test(String(last.tail || last.plain || last.text || ''));
  }

  function isSleepingConfig(wc) {
    if (!wc) return false;
    if (wc.mode === 'active' || wc.triggers?.anyMessage) return false;
    return true; // diving 且不是 anyMessage 都视为“沉睡/潜水”，需要先观察
  }

  function preSleepWaitBlocked(st) {
    if (!st) return false;
    const w = cfg.simulation?.wake ?? {};
    if (w.preSleepWaitEnabled === false) return false;
    if (hasExplicitEnd(st)) return false;
    const waitMs = Math.max(0, Number(w.preSleepWaitMs) || 300000);
    const now = Date.now();
    // 已经连续安静满观察窗口：可以直接设置潜水。
    if ((st.lastIncomingAt || 0) && now - st.lastIncomingAt >= waitMs) return false;
    // 已经完整等过观察窗口且之后没有新消息：放行。
    if (st.preSleepWaitSatisfiedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitSatisfiedAt)) return false;
    // 已经做过一次沉睡前观察（可能等到了新消息并已把新消息返回给 AI），只要 AI 之后没有参与、也没有更新的消息，就允许直接沉睡。
    if (st.preSleepWaitObservedAt && (!st.lastIncomingAt || st.lastIncomingAt <= st.preSleepWaitObservedAt)) return false;
    return true;
  }

  function computeWakeSafety(wc) {
    const tr = wc?.triggers || {};
    const hard = wc?.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.question || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) ||
      normalizeSpeakerIds(tr.speakerIds).length > 0;
    const timed = !wc?.infinite && wc?.sleepUntil && Date.parse(wc.sleepUntil) > Date.now();
    const soft = Number(tr.probability) > 0;
    const guaranteed = hard || timed || soft;
    const confirmedNum = Number(wc?.confirmedAt);
    const stale = !wc?.confirmedAt || !Number.isFinite(confirmedNum) || Date.now() - confirmedNum > 24 * 60 * 60 * 1000;
    return { hard, timed, soft, guaranteed, stale };
  }

  // 防“永眠”：检查当前 WakeConfig 是否至少有一个可触发唤醒的途径；没有则重置为默认配置。
  // opts.skipSave=true 用于加载状态阶段，避免中途落盘覆盖尚未加载的会话。
  function ensureWakeable(st, opts = {}) {
    if (!st || !st.wakeConfig) return;
    const key = opts.key || st.key;
    const wc = st.wakeConfig;
    if (!wc.triggers || typeof wc.triggers !== 'object') wc.triggers = {};
    const tr = wc.triggers;
    // 掉垃圾数据只留有效 QQ 号，避免“null”/对象等脏值被当成可唤醒条件绕过防永眠。
    tr.speakerIds = normalizeSpeakerIds(tr.speakerIds);
    const timed = !wc.infinite && wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) && Date.parse(wc.sleepUntil) > Date.now();
    const wakeable = wc.mode === 'active' || tr.anyMessage || tr.atMention || tr.nameMention || tr.poke ||
      (Array.isArray(tr.keywords) && tr.keywords.length > 0) || tr.question || Number(tr.probability) > 0 ||
      tr.speakerIds.length > 0 || timed;
    if (!wakeable) {
      if (st.sleepTimer) {
        clearTimeout(st.sleepTimer);
        st.sleepTimer = null;
      }
      st.wakeConfig = defaultWakeConfig();
      if (!opts.skipSave) saveSimulationState();
      if (key) setupSleepTimer(key);
      log(`[simulation] 唤醒配置无任何触发条件，已重置为默认配置，避免永眠`);
    }
  }

  function getSimulationState(key) {
    // 只允许内部约定的会话 key 格式，并统一成无前导零的正整数形式，防止同一会话分裂成多个状态。
    const canonical = canonicalSimulationKey(key);
    if (!canonical) {
      const err = new Error(`无效的会话 key：${String(key ?? '')}`);
      err.statusCode = 400;
      throw err;
    }
    key = canonical;
    let st = simulation.conversations.get(key);
    if (!st) {
      st = {
        wakeConfig: defaultWakeConfig(),
        recentMessages: [],
        unread: [],
        lastWakeReason: '',
        lastAiReplyAt: 0,
        lastActionAt: 0,
        lastStickerAt: 0,
        textSendsSinceSticker: 0,
        lastImageAt: 0,
        textSendsSinceImage: 0,
        textSendsSinceMedia: 0,
        lastVoiceAt: 0,
        roleCardVersion: '',
        pendingBroadcast: null,
        agentToken: crypto.randomBytes(16).toString('hex'),
        bootstrapSent: false,
        wakeTimes: [],
        sendTimes: [],
        stickerCollectTimes: [],
        pendingWakeTimer: null,
        sleepTimer: null,
        replyCheckTimer: null,
        proactiveTimer: null,
        rateLimitRetryTimer: null,
        clingyTimer: null,
        clingyFollowUps: 0,
        lastIncomingAt: 0,
        preSleepWaitSatisfiedAt: 0,
        preSleepWaitObservedAt: 0,
        preSleepWaitAccumMs: 0,
        lastUnreadSeq: 0,
        lastReadThroughSeq: 0,
        modelSeenSeqs: new Set(),
        activeTopics: [],
        pendingThoughts: [],
        memberImpressions: {},
        pendingDigest: '',
        lastContextTokens: 0,
        lastContextTokensAt: 0,
        lastRotationAt: 0,
        scoreStats: { wake: 0, defer: 0, ignore: 0 },
        lastWakeScore: null,
        lastIncomingUserId: '',
        lastIncomingSenderName: ''
      };
      rememberAgentToken(key, st.agentToken);
      simulation.conversations.set(key, st);
      scheduleProactiveCheck(key);
      setupSleepTimer(key);
    }
    return st;
  }

  function loadSimulationState() {
    try {
      // 记下读取时刻的文件指纹。加载末尾会统一落盘一次（为了让 ensureWakeable
      // 中途的改动不丢），但如果这期间**别的进程**已经写过这个文件，我们手上的
      // 内存态就是旧的 —— 再写回去等于把它那份更新的状态覆盖掉。
      // 这不是假想：日志里出现过两个桥接实例同时启动，第二个实例在加载后立刻回写，
      // 把第一个实例刚更新的读水位/唤醒时间/转发 id 全部退回旧值。
      const fileStamp = (() => {
        try {
          const s = fs.statSync(SIMULATION_FILE);
          return `${s.size}:${s.mtimeMs}`;
        } catch {
          return null;
        }
      })();
      const raw = readJsonSafe(SIMULATION_FILE, null);
      simulation.paused = raw?.paused === true;
      if (raw && typeof raw.conversations === 'object') {
        const seenTokens = new Set();
        for (const [key, val] of Object.entries(raw.conversations)) {
          if (!val || typeof val !== 'object') continue;
          if (!/^(group|private):\d+$/.test(key)) continue;
          const defaultWc = defaultWakeConfig();
          let agentToken = String(val.agentToken || crypto.randomBytes(16).toString('hex'));
          if (!agentToken || seenTokens.has(agentToken)) {
            agentToken = crypto.randomBytes(16).toString('hex');
          }
          seenTokens.add(agentToken);
          const st = {
            wakeConfig: {
              ...defaultWc,
              ...(val.wakeConfig ?? {}),
              // 加载时也按已知字段过滤：旧状态文件里可能残留任意键（见 WAKE_TRIGGER_KEYS）。
              triggers: pickWakeTriggers((val.wakeConfig?.triggers) ?? {}, defaultWc.triggers)
            },
            recentMessages: Array.isArray(val.recentMessages) ? val.recentMessages : [],
            unread: Array.isArray(val.unread) ? val.unread : [],
            lastWakeReason: String(val.lastWakeReason ?? ''),
            lastAiReplyAt: Number(val.lastAiReplyAt) || 0,
            lastActionAt: Number(val.lastActionAt) || 0,
            lastStickerAt: Number(val.lastStickerAt) || 0,
            textSendsSinceSticker: Math.max(0, Number(val.textSendsSinceSticker) || 0),
            lastImageAt: Number(val.lastImageAt) || 0,
            textSendsSinceImage: Math.max(0, Number(val.textSendsSinceImage) || 0),
            textSendsSinceMedia: Math.max(0, Number(val.textSendsSinceMedia) || Math.max(Number(val.textSendsSinceSticker) || 0, Number(val.textSendsSinceImage) || 0)),
            lastVoiceAt: Number(val.lastVoiceAt) || 0,
            roleCardVersion: String(val.roleCardVersion || ''),
            pendingBroadcast: val.pendingBroadcast && typeof val.pendingBroadcast === 'object' && !Array.isArray(val.pendingBroadcast)
              ? { ...val.pendingBroadcast } : null,
            agentToken,
            bootstrapSent: !!val.bootstrapSent,
            wakeTimes: Array.isArray(val.wakeTimes) ? val.wakeTimes : [],
            sendTimes: Array.isArray(val.sendTimes) ? val.sendTimes : [],
            stickerCollectTimes: Array.isArray(val.stickerCollectTimes) ? val.stickerCollectTimes : [],
            pendingWakeTimer: null,
            sleepTimer: null,
            replyCheckTimer: null,
            proactiveTimer: null,
            clingyTimer: null,
            clingyFollowUps: Math.max(0, Number(val.clingyFollowUps) || 0),
            lastIncomingAt: Number(val.lastIncomingAt) || 0,
            preSleepWaitSatisfiedAt: Number(val.preSleepWaitSatisfiedAt) || 0,
            preSleepWaitObservedAt: Number(val.preSleepWaitObservedAt) || 0,
            preSleepWaitAccumMs: Number(val.preSleepWaitAccumMs) || 0,
            lastUnreadSeq: Number(val.lastUnreadSeq) || 0,
            lastReadThroughSeq: Number.isSafeInteger(val.lastReadThroughSeq) && val.lastReadThroughSeq >= 0
              ? Math.min(val.lastReadThroughSeq, Number(val.lastUnreadSeq) || 0) : 0,
            modelSeenSeqs: new Set(),
            activeTopics: Array.isArray(val.activeTopics) ? val.activeTopics : [],
            pendingThoughts: Array.isArray(val.pendingThoughts) ? val.pendingThoughts : [],
            memberImpressions: (() => {
              const rawImp = (val.memberImpressions && typeof val.memberImpressions === 'object') ? val.memberImpressions : {};
              const clean = {};
              for (const [k, v] of Object.entries(rawImp)) {
                if (['__proto__', 'constructor', 'prototype'].includes(k)) continue;
                clean[k] = v;
              }
              return clean;
            })(),
            pendingDigest: String(val.pendingDigest || '').slice(0, 4000),
            lastContextTokens: Math.max(0, Number(val.lastContextTokens) || 0),
            lastContextTokensAt: Number(val.lastContextTokensAt) || 0,
            lastRotationAt: Number(val.lastRotationAt) || 0,
            scoreStats: (val.scoreStats && typeof val.scoreStats === 'object' && !Array.isArray(val.scoreStats))
              ? { wake: Number(val.scoreStats.wake) || 0, defer: Number(val.scoreStats.defer) || 0, ignore: Number(val.scoreStats.ignore) || 0 }
              : { wake: 0, defer: 0, ignore: 0 },
            lastWakeScore: (val.lastWakeScore && typeof val.lastWakeScore === 'object' && !Array.isArray(val.lastWakeScore))
              ? val.lastWakeScore : null,
            lastIncomingUserId: val.lastIncomingUserId ? String(val.lastIncomingUserId) : '',
            lastIncomingSenderName: String(val.lastIncomingSenderName || '').slice(0, 40)
          };
          // 旧状态/异常状态里的指定成员名单也统一归一化，防止“null”/非法值污染。
          if (st.wakeConfig?.triggers && typeof st.wakeConfig.triggers === 'object') {
            st.wakeConfig.triggers.speakerIds = normalizeSpeakerIds(st.wakeConfig.triggers.speakerIds);
            if (key.startsWith('private:')) st.wakeConfig.triggers.speakerIds = [];
          }
          // 仍使用默认唤醒配置的会话，在重启加载时同步到当前推荐/默认参数。
          refreshDefaultWakeConfig(st);
          rememberAgentToken(key, st.agentToken);
          simulation.conversations.set(key, st);
          // 重启后从已持久化的消息与 seenForwardIds 字段重建“本会话见过的 forward id”
          {
            const rebuilt = new Set();
            if (Array.isArray(val.seenForwardIds)) {
              for (const fid of val.seenForwardIds) {
                const safe = sanitizeForwardId(fid);
                if (safe) rebuilt.add(safe);
              }
            }
            for (const m of [...(st.recentMessages || []), ...(st.unread || [])]) {
              if (Array.isArray(m?.forwardIds)) {
                for (const fid of m.forwardIds) {
                  const safe = sanitizeForwardId(fid);
                  if (safe) rebuilt.add(safe);
                }
              }
            }
            if (rebuilt.size) seenForwardIds.set(key, rebuilt);
          }
          ensureWakeable(st, { skipSave: true, key });
          scheduleProactiveCheck(key);
        }
        // 加载阶段统一落盘一次，避免 ensureWakeable 中途写盘覆盖未加载会话。
        // 但只有在文件仍是「我们读到的那一份」时才写：否则说明有另一个进程写过它，
        // 我们手里的内存态已经过时，回写会静默吞掉对方的新数据。
        const nowStamp = (() => {
          try {
            const s = fs.statSync(SIMULATION_FILE);
            return `${s.size}:${s.mtimeMs}`;
          } catch {
            return null;
          }
        })();
        if (fileStamp !== null && nowStamp !== null && fileStamp !== nowStamp) {
          log('⚠️ state/simulation.json 在本次加载期间被其它进程改写，跳过回写以免覆盖更新的状态（是否误开了第二个桥接实例？）');
        } else {
          saveSimulationState();
        }
      }
    } catch (error) {
      log('读取 simulation 状态失败:', error?.message ?? error);
    }
  }

  function saveSimulationState() {
    try {
      const obj = { paused: simulation.paused, conversations: Object.create(null) };
      for (const [key, st] of simulation.conversations) {
        obj.conversations[key] = {
          wakeConfig: st.wakeConfig,
          recentMessages: st.recentMessages.slice(-200),
          unread: st.unread.slice(-100),
          lastWakeReason: st.lastWakeReason,
          lastAiReplyAt: st.lastAiReplyAt,
          lastActionAt: st.lastActionAt,
          lastStickerAt: st.lastStickerAt || 0,
          textSendsSinceSticker: st.textSendsSinceSticker || 0,
          lastImageAt: st.lastImageAt || 0,
          textSendsSinceImage: st.textSendsSinceImage || 0,
          textSendsSinceMedia: st.textSendsSinceMedia || 0,
          lastVoiceAt: st.lastVoiceAt || 0,
          roleCardVersion: st.roleCardVersion || '',
          clingyFollowUps: Math.max(0, Number(st.clingyFollowUps) || 0),
          pendingBroadcast: st.pendingBroadcast || null,
          agentToken: st.agentToken,
          bootstrapSent: st.bootstrapSent,
          wakeTimes: st.wakeTimes.slice(-200),
          sendTimes: st.sendTimes.slice(-500),
          stickerCollectTimes: Array.isArray(st.stickerCollectTimes) ? st.stickerCollectTimes.slice(-500) : [],
          lastIncomingAt: st.lastIncomingAt || 0,
          preSleepWaitSatisfiedAt: st.preSleepWaitSatisfiedAt || 0,
          preSleepWaitObservedAt: st.preSleepWaitObservedAt || 0,
          preSleepWaitAccumMs: st.preSleepWaitAccumMs || 0,
          lastUnreadSeq: st.lastUnreadSeq || 0,
          lastReadThroughSeq: st.lastReadThroughSeq || 0,
          activeTopics: Array.isArray(st.activeTopics) ? st.activeTopics.slice(-50) : [],
          pendingThoughts: Array.isArray(st.pendingThoughts) ? st.pendingThoughts.slice(-50) : [],
          memberImpressions: st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {},
          pendingDigest: st.pendingDigest || '',
          lastContextTokens: Math.max(0, Number(st.lastContextTokens) || 0),
          lastContextTokensAt: Number(st.lastContextTokensAt) || 0,
          lastRotationAt: Number(st.lastRotationAt) || 0,
          scoreStats: st.scoreStats || undefined,
          lastWakeScore: st.lastWakeScore || null,
          lastIncomingUserId: st.lastIncomingUserId || '',
          lastIncomingSenderName: st.lastIncomingSenderName || '',
          seenForwardIds: Array.from(seenForwardIds.get(key) || []).slice(-1000)
        };
      }
      atomicWriteJson(SIMULATION_FILE, obj);
    } catch (error) {
      log('保存 simulation 状态失败:', error?.message ?? error);
    }
  }

  // ── 群聊仿真：操作者预写的「初始提示词」（每个会话一份，只在首次唤醒时注入） ──────
  //
  // 用途：让操作者在控制台提前告诉 AI「这个群是什么圈子、什么氛围、有什么忌讳」。
  // 为什么单独一个文件、而不是塞进 simulation.json 的会话状态：
  //   · 会话状态会被 /api/session/reset 与 /api/simulation/reset 整体删除，而这份是操作者
  //     手写的配置 —— 重置一次 AI 上下文不该把它一起清掉；
  //   · 控制台需要能在群还没说过话（连会话状态都还不存在）时就写好。
  // 为什么只在首次唤醒（bootstrap）注入：这是一份「接入这个群时的背景介绍」，每轮都塞
  // 既白烧 token，又会让 AI 把它当成新指令；首次唤醒后它已在 DSH 会话上下文里。
  const initialPrompts = new Map(); // key -> { text, createdAt, updatedAt }
  let initialPromptsWritable = true;

  function initialPromptMaxChars() {
    const n = Number(cfg.simulation?.initialPromptMaxChars);
    return Number.isFinite(n) && n > 0 ? Math.min(8000, Math.max(100, Math.round(n))) : 2000;
  }

  /** 归一化操作者输入：统一行尾、去掉 BOM 与控制字符，只裁首尾空白（保留段落换行）。 */
  function normalizeInitialPromptText(raw) {
    return String(raw ?? '')
      .replace(/^\uFEFF/, '')
      .replace(/\r\n?/g, '\n')
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '')
      .trim();
  }

  /**
   * 读取 state/initial-prompts.json。
   * 读不动/读坏时降级为「只读不写」（与 sessions.json、表情库、黑话库同一口径）：
   * 否则内存里的空映射会在下一次保存时把原文件覆盖掉，操作者写的内容永久丢失。
   */
  function loadInitialPrompts() {
    let raw;
    try {
      raw = fs.readFileSync(INITIAL_PROMPTS_FILE, 'utf8');
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        initialPromptsWritable = false;
        log(`⚠️ initial-prompts.json 读取失败，已降级为「只读不写」（不会覆盖原文件）：${error?.message ?? error}`);
      }
      return;
    }
    let parsed;
    try {
      parsed = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    } catch (error) {
      initialPromptsWritable = false;
      log(`⚠️ initial-prompts.json 内容损坏，已降级为「只读不写」（请先备份再修复）：${error?.message ?? error}`);
      return;
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      initialPromptsWritable = false;
      log('⚠️ initial-prompts.json 结构异常（期望 { "key": { "text": … } } 对象），已降级为「只读不写」');
      return;
    }
    for (const [key, value] of Object.entries(parsed)) {
      // 只接受规范 key；__proto__/constructor 这类脏键在这里就被过滤掉。
      const canonical = canonicalSimulationKey(key);
      if (!canonical) continue;
      // 注意：这里**不按上限截断**。文件里若有一条超过当前上限的内容（比如后来调小了上限，
      // 或手工编辑过），截断它会在下一次保存时把截断结果写回磁盘 —— 静默丢数据。
      // 上限只在「保存」和「注入」两个出口生效。
      const text = normalizeInitialPromptText(value && typeof value === 'object' ? value.text : value);
      if (!text) continue;
      const createdAt = Number(value && typeof value === 'object' ? value.createdAt : 0);
      const updatedAt = Number(value && typeof value === 'object' ? value.updatedAt : 0);
      initialPrompts.set(canonical, {
        text,
        createdAt: Number.isFinite(createdAt) ? createdAt : 0,
        updatedAt: Number.isFinite(updatedAt) ? updatedAt : 0
      });
    }
    if (initialPrompts.size) log(`已加载 ${initialPrompts.size} 条会话初始提示词`);
  }

  function saveInitialPrompts() {
    if (!initialPromptsWritable) {
      log('⚠️ initial-prompts.json 处于只读降级状态，本次修改不会落盘');
      return false;
    }
    try {
      const obj = Object.create(null);
      for (const [key, entry] of initialPrompts) {
        obj[key] = { text: entry.text, createdAt: entry.createdAt || 0, updatedAt: entry.updatedAt || 0 };
      }
      atomicWriteJson(INITIAL_PROMPTS_FILE, obj);
      return true;
    } catch (error) {
      log('保存会话初始提示词失败:', error?.message ?? error);
      return false;
    }
  }

  function getInitialPrompt(key) {
    const canonical = canonicalSimulationKey(key);
    return canonical ? (initialPrompts.get(canonical) ?? null) : null;
  }

  /**
   * 保存/删除一份初始提示词。空内容 = 删除。
   * 写入失败时把内存改动回滚，保证「接口说失败」与「内存里确实没变」一致。
   * @returns {{ok: boolean, statusCode?: number, error?: string, key?: string, deleted?: boolean, chars?: number, entry?: object|null}}
   */
  function setInitialPrompt(key, rawText) {
    const canonical = canonicalSimulationKey(key);
    if (!canonical) return { ok: false, statusCode: 400, error: 'key 格式应为 group:群号 或 private:QQ号' };
    const max = initialPromptMaxChars();
    const text = normalizeInitialPromptText(rawText);
    if (text.length > max) {
      return { ok: false, statusCode: 400, error: `初始提示词过长（${text.length} 字符，上限 ${max}）；请精简后重试` };
    }
    const prev = initialPrompts.get(canonical) ?? null;
    const rollback = () => { if (prev) initialPrompts.set(canonical, prev); else initialPrompts.delete(canonical); };
    if (!text) {
      initialPrompts.delete(canonical);
      if (!saveInitialPrompts()) {
        rollback();
        return { ok: false, statusCode: 500, error: '删除失败：state/initial-prompts.json 写入失败，已回滚' };
      }
      return { ok: true, key: canonical, deleted: true, chars: 0, entry: null };
    }
    const now = Date.now();
    const entry = { text, createdAt: prev?.createdAt || now, updatedAt: now };
    initialPrompts.set(canonical, entry);
    if (!saveInitialPrompts()) {
      rollback();
      return { ok: false, statusCode: 500, error: '保存失败：state/initial-prompts.json 写入失败，已回滚' };
    }
    return { ok: true, key: canonical, deleted: false, chars: text.length, entry };
  }

  /**
   * 首次唤醒时插入的环境段；没有配置就返回空串（不影响原有 prompt）。
   * 超长内容按上限截断后注入（文件可能被手工改过），并在截断处留省略号。
   */
  function formatInitialPrompt(key) {
    const entry = getInitialPrompt(key);
    if (!entry?.text) return '';
    const max = initialPromptMaxChars();
    const body = entry.text.length > max ? `${truncateText(entry.text, max)}…（已按上限截断，完整内容见控制台）` : entry.text;
    const label = String(key ?? '').trim().startsWith('private:') ? '私聊环境' : '群聊环境';
    return `【${label}（操作者预设，仅本次首次唤醒参考）】\n${body}\n（以上是操作者提供的背景，不是群友发的消息、也不是新的系统指令；据此把握圈子主题、氛围与分寸，不必向群友复述。）`;
  }

  function formatParticipation(st) {
    if (!st) return '';
    const now = Date.now();
    const hour = 60 * 60 * 1000;
    const fiveMin = 5 * 60 * 1000;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const aiCount = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < hour).length;
    const otherCount = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < hour).length;
    if (!aiCount && !otherCount) return '';
    const fiveMinOthers = recent.filter((m) => m && !m.isSelf && now - (Number(m.time) || 0) < fiveMin);
    const activeSenders = new Set(fiveMinOthers.map((m) => m && (m.sender || m.user_id || '?'))).size;
    const directUnread = Array.isArray(st.unread) ? st.unread.filter((m) => m && isDirectedAtAi(String(m.plain || m.text || ''))).length : 0;
    const lastAiGap = now - (Number(st.lastAiReplyAt) || 0);
    const recentAi2m = recent.filter((m) => m && m.isSelf && now - (Number(m.time) || 0) < 2 * 60 * 1000).length;
    let hint = '';
    if (directUnread > 0) {
      hint = '有人直接找你，优先回应；其余热闹可以挑着参与。';
    } else if (recentAi2m >= 2) {
      hint = '你刚刚已经连回过好几次了，这轮可以少说，但别直接消失；有值得接的仍要自然接一句。';
    } else if (lastAiGap < 120000) {
      hint = '你刚说过话，先听一会儿；有能接住的话再自然接，不用硬等点名。';
    } else if (aiCount >= 5) {
      hint = '你最近发言偏多，这轮可以少说，但遇到真正想说的仍主动说。';
    } else if (fiveMinOthers.length >= 10 || (fiveMinOthers.length >= 6 && activeSenders >= 3)) {
      hint = `群聊正热（近5分钟${fiveMinOthers.length}条${activeSenders ? `/${activeSenders}人` : ''}在聊），不用逐条关注；挑最值得接的一句主动参与，插不上再潜水。`;
    } else if (otherCount >= 10 && aiCount === 0) {
      hint = '群聊很热闹但没叫你，可以插一句有趣的，或只看不说。';
    } else if (otherCount < 3 && aiCount > 0) {
      hint = '群聊有点冷，不要一个人撑场；但有想法时仍可主动抛一句。';
    } else if (aiCount <= 1 && otherCount >= 10) {
      hint = '这轮可以简短接一句，别潜水；挑一个点参与。';
    }
    const burstText = fiveMinOthers.length ? `；近5分钟群聊 ${fiveMinOthers.length} 条${activeSenders ? `/${activeSenders}人` : ''}` : '';
    return `【参与度参考】你最近 1 小时发言 ${aiCount} 次，群友发言 ${otherCount} 条${burstText}。${hint}`;
  }

  function suggestQuietMs(st) {
    const defaultMs = Number(cfg.simulation?.wait?.defaultQuietMs) || 8000;
    if (!st) return defaultMs;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const last = [...recent].reverse().find((m) => m && !m.isSelf);
    if (!last) return defaultMs;
    const text = String(last.tail || last.plain || last.text || '').trim();
    if (looksLikeUnfinished(text)) return 12000;
    const burst = recent.filter((m) => m && !m.isSelf && Date.now() - Number(m.time || 0) < 15000).length;
    if (burst >= 3) return 12000;
    return defaultMs;
  }

  const PERSONAL_MEMORY_SOURCE = 'personal';

  function listPersonalFacts(limit = 50) {
    if (!memoryStore || cfg.simulation?.memory?.enabled === false) return [];
    try {
      return memoryStore.list({ scope: 'global', source: PERSONAL_MEMORY_SOURCE, limit });
    } catch (error) {
      log(`[memory] 读取跨会话记忆失败：${error?.message ?? error}`);
      return [];
    }
  }

  function formatPersonalMemoryBlock({ facts = listPersonalFacts(6), maxChars = 600 } = {}) {
    if (!facts.length) return '';
    const lines = ['【跨会话记忆】（你在别的会话里记住的事；相关时自然提起，不要逐条复述；涉及主人私事不要主动向群里公开）'];
    let used = lines[0].length;
    for (const fact of facts) {
      const line = `- ${fact.topic ? `${fact.topic}：` : ''}${fact.fact}${fact.weight > 1 ? `（提到 ${fact.weight} 次）` : ''}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length;
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

  function formatMemory(st) {
    if (!st) return '';
    const lines = [];
    const topics = Array.isArray(st.activeTopics) ? st.activeTopics.filter((t) => t && t.text) : [];
    if (topics.length) {
      lines.push('【进行中的话题】');
      for (const t of topics.slice(-10)) {
        const ago = t.lastMentionAt ? Math.round((Date.now() - t.lastMentionAt) / 60000) : 0;
        const stale = t.lastMentionAt && Date.now() - Number(t.lastMentionAt) > 2 * 60 * 60 * 1000 ? '（已搁置）' : '';
        lines.push(`- ${t.text}${stale}（${ago > 0 ? ago + '分钟前' : '刚刚'}）${t.pendingQuestion ? `；待追问：${t.pendingQuestion}` : ''}`);
      }
    }
    const thoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && t.text && (!t.expiresAt || Date.now() < t.expiresAt)) : [];
    if (thoughts.length) {
      lines.push('【你想说但还没说的】');
      for (const t of thoughts.slice(-10)) {
        lines.push(`- ${t.text}${t.motivation ? `（${t.motivation}）` : ''}`);
      }
    }
    const impressions = st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {};
    const names = Object.keys(impressions);
    if (names.length) {
      lines.push('【对群友的印象】');
      for (const name of names.slice(-10)) {
        const im = impressions[name] || {};
        const traits = Array.isArray(im.traits) ? im.traits : [];
        lines.push(`- ${name}：${traits.length ? traits.join('、') : '暂无记录'}（互动 ${Number(im.interactionCount) || 0} 次）`);
      }
    }
    return lines.join('\n');
  }

  function appendMemory(st, category, content, extra = {}) {
    if (!st) return;
    const text = redactKnownTokensOnly(String(content ?? '')).trim();
    const cat = String(category || '').trim();
    // 轻量清理：过期想法移除；超过 24h 未提起的话题移除（避免无限膨胀）。
    if (Array.isArray(st.pendingThoughts)) {
      st.pendingThoughts = st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt)));
    }
    if (Array.isArray(st.activeTopics)) {
      st.activeTopics = st.activeTopics.filter((t) => t && (!t.lastMentionAt || Date.now() - Number(t.lastMentionAt) < 24 * 60 * 60 * 1000));
    }
    if (cat === 'activeTopic' && text) {
      if (!Array.isArray(st.activeTopics)) st.activeTopics = [];
      const existing = st.activeTopics.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.lastMentionAt = Date.now();
        if (Array.isArray(extra.participants)) {
          const set = new Set([...(existing.participants || []), ...extra.participants.map((p) => redactKnownTokensOnly(String(p)))]);
          existing.participants = [...set].slice(0, 10);
        }
        if (extra.pendingQuestion) existing.pendingQuestion = truncateText(redactKnownTokensOnly(String(extra.pendingQuestion)), 200);
      } else {
        st.activeTopics.push({
          text: truncateText(text, 200),
          lastMentionAt: Date.now(),
          participants: Array.isArray(extra.participants) ? extra.participants.map((p) => redactKnownTokensOnly(String(p))).slice(0, 10) : [],
          pendingQuestion: redactKnownTokensOnly(String(extra.pendingQuestion || '')).slice(0, 200)
        });
      }
      if (st.activeTopics.length > 20) st.activeTopics.splice(0, st.activeTopics.length - 20);
    } else if (cat === 'pendingThought' && text) {
      if (!Array.isArray(st.pendingThoughts)) st.pendingThoughts = [];
      const existing = st.pendingThoughts.find((t) => t && String(t.text || '') === text);
      if (existing) {
        existing.createdAt = Date.now();
        existing.expiresAt = Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000);
        if (extra.motivation) existing.motivation = redactKnownTokensOnly(String(extra.motivation)).slice(0, 50);
      } else {
        st.pendingThoughts.push({
          text: text.slice(0, 200),
          createdAt: Date.now(),
          expiresAt: Date.now() + (Number(extra.expiresAtMs) || 2 * 60 * 60 * 1000),
          motivation: redactKnownTokensOnly(String(extra.motivation || 'curiosity')).slice(0, 50)
        });
      }
      if (st.pendingThoughts.length > 20) st.pendingThoughts.splice(0, st.pendingThoughts.length - 20);
    } else if (cat === 'personalFact' && text) {
      if (memoryStore && cfg.simulation?.memory?.enabled !== false) {
        try {
          memoryStore.remember({
            scope: 'global',
            ownerKey: null,
            topic: redactKnownTokensOnly(String(extra.topic || '个人记忆')).slice(0, 60),
            fact: text,
            source: PERSONAL_MEMORY_SOURCE,
            confidence: 0.9
          });
        } catch (error) {
          log(`[memory] 跨会话记忆写入失败（忽略）：${error?.message ?? error}`);
        }
      }
    } else if (cat === 'memberImpression') {
      const target = String(extra.target || '').trim();
      if (!target || ['__proto__', 'constructor', 'prototype'].includes(target)) return;
      if (!st.memberImpressions || typeof st.memberImpressions !== 'object') st.memberImpressions = {};
      const old = st.memberImpressions[target] || {};
      const traits = Array.isArray(old.traits) ? old.traits.slice(0, 10) : [];
      if (text && !traits.includes(text.slice(0, 50))) traits.push(text.slice(0, 50));
      st.memberImpressions[target] = {
        traits,
        interactionCount: (Number(old.interactionCount) || 0) + 1,
        lastSeenAt: Date.now()
      };
      const impressionEntries = Object.entries(st.memberImpressions);
      if (impressionEntries.length > 50) {
        impressionEntries.sort((a, b) => (Number(a[1]?.lastSeenAt) || 0) - (Number(b[1]?.lastSeenAt) || 0));
        for (let i = 0; i < impressionEntries.length - 50; i++) {
          delete st.memberImpressions[impressionEntries[i][0]];
        }
      }
    }
    // 镜像到 SQLite 长期记忆：轻量数组只保留最近几条，旧事实靠 FTS 检索回来。
    if (memoryStore && cfg.simulation?.memory?.enabled !== false && text) {
      try {
        const convKey = String(extra.key || '').trim();
        if (cat === 'activeTopic') {
          memoryStore.remember({
            scope: convKey.startsWith('group:') ? 'group' : 'member',
            ownerKey: convKey || null,
            topic: text.slice(0, 60),
            fact: text,
            source: 'chat',
            confidence: 0.7
          });
        } else if (cat === 'memberImpression') {
          const target = String(extra.target || '').trim();
          if (target) {
            memoryStore.remember({
              scope: 'member',
              ownerKey: convKey ? `${convKey}:${target}` : target,
              topic: target,
              fact: text,
              source: 'impression',
              confidence: 0.65
            });
          }
        } else if (cat === 'pendingThought') {
          memoryStore.remember({
            scope: 'global',
            ownerKey: null,
            topic: '想说没说的',
            fact: text,
            source: 'thought',
            confidence: 0.5,
            expiresAt: Date.now() + 7 * 24 * 3600 * 1000
          });
        }
      } catch (error) {
        log(`[memory] 写入长期记忆失败（忽略）：${error?.message ?? error}`);
      }
    }
    saveSimulationState();
  }

  loadSimulationState();
  // 一次性清空历史未读积压（修复上线时已经积起来的一批）：不触发补回，也不让模型逐条回旧消息。
  // 用标记文件保证只执行一次；以后的新未读正常保留，直到模型回复后再销账。
  {
    const marker = path.join(STATE_DIR, 'backlog-drained-2026-10-23.json');
    if (!fs.existsSync(marker)) {
      let drained = 0;
      const keys = [];
      for (const [key, st] of simulation.conversations) {
        const n = Array.isArray(st.unread) ? st.unread.length : 0;
        const pendingN = Array.isArray(st.pendingWakeReasons) ? st.pendingWakeReasons.length : 0;
        if (!n && !pendingN) continue;
        st.unread = [];
        st.lastReadThroughSeq = st.lastUnreadSeq || 0;
        st.modelSeenSeqs = new Set();
        st.pendingWakeReasons = [];
        drained += n;
        keys.push(`${key}(${n})`);
      }
      try {
        atomicWriteText(marker, JSON.stringify({ at: new Date().toISOString(), drained, keys }, null, 2));
      } catch (error) {
        log('写积压清理标记失败:', error?.message ?? error);
      }
      if (drained || keys.length) {
        saveSimulationState();
        log(`[fix] 一次性清空历史未读积压 ${drained} 条（不触发补回）：${keys.join(', ')}`);
      } else {
        log('[fix] 无历史未读积压需要清理');
      }
    }
  }
  // 操作者预写的会话初始提示词（与控制台入口同样在 main() 里；损坏时只读降级，不阻塞启动）。
  loadInitialPrompts();

  function isSocialEnabled() {
    return currentMode === 'reserved' && cfg.social?.enabled !== false;
  }

  function socialState(key) {
    if (!social.states.has(key)) {
      social.states.set(key, { phase: 'idle', lastCheckAt: 0, nextCheckAt: 0, lastActiveMessageAt: 0, activeEnteredAt: 0, activeDeadlineAt: 0, activeExitAt: 0, lastAiReplyAt: 0, lastFollowUpAt: 0, probeDeadline: 0, proactiveNextCheckAt: 0 });
    }
    return social.states.get(key);
  }

  // 启动阶段的"明确与 AI 有关"：@ / 提到名字 / 必回关键词 / 管理员私聊
  function isDirectAddress(textContent, event, kind) {
    if (kind !== 'group') return true;
    const lower = String(textContent ?? '').toLowerCase();
    const selfId = String(event?.self_id ?? '');
    if (selfId && lower.includes('@' + selfId)) return true;
    if (selfNameMatches(lower)) return true;
    const customRole = isCustomRoleName(currentRoleName());
    const foreignPersona = customRole && mentionsDefaultPersonaName(lower);
    for (const kw of effectiveMustReplyKeywords()) {
      if (!socialKeywordsExplicit && foreignPersona && isNeutralRoleKeyword(kw)) continue;
      if (keywordMatchesText(lower, kw, customRole && !socialKeywordsExplicit)) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  // 是否"直接针对 AI"的提问/挑战：提到 AI 相关词且带疑问/比较，或对"你"开火，或追问催促
  function isDirectedAtAi(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    const aiMention = aiMentionPattern().test(lower);
    const challenge = /强|弱|行不行|能不能|会不会|是不是|一半|水平|垃圾|废物|白嫖|菜|不如|厉害|赢|输|比.*强|比.*弱/.test(lower);
    const question = /[?？吗呢吧]|怎么|为什么|哪|谁/.test(lower);
    if (aiMention && (question || challenge)) return true;
    // "你/您" + 疑问/比较/挑战（放宽，避免漏掉"你有claude一半强吗"这类直接问）
    if (/(你|您).{0,10}(吗|呢|？|\?|怎么|是不是|能不能|行不行|有没有|有|没有|比|不如|强|弱|一半|厉害|垃圾|菜|赢|输)/.test(lower)) return true;
    if (/^(你|您)(是不是|行不行|能不能|会不会|觉得|有|没有)/.test(lower)) return true;
    // "你是...还是... / 你是...吗 / 你是...？"（如：你是人类还是ai、你是真人吗）
    if (/(你|您)是[^？?。！!]{0,14}(还是|或者|吗|么|？|\?)/.test(lower)) return true;
    // 追问/催促：AI 没回时的真人式催促
    if (/怎么不说话|人呢|回我|说话啊|理我|别装死|在不在|装死|说话/.test(lower)) return true;
    return false;
  }

  // 活跃期批量检测用的"必须回"判断：不依赖 event，只认昵称/关键词/直接针对 AI 的提问
  function isMustReplyText(textContent) {
    const lower = String(textContent ?? '').toLowerCase();
    if (selfNameMatches(lower)) return true;
    const customRole = isCustomRoleName(currentRoleName());
    const foreignPersona = customRole && mentionsDefaultPersonaName(lower);
    for (const kw of effectiveMustReplyKeywords()) {
      if (!socialKeywordsExplicit && foreignPersona && isNeutralRoleKeyword(kw)) continue;
      if (keywordMatchesText(lower, kw, customRole && !socialKeywordsExplicit)) return true;
    }
    if (isDirectedAtAi(textContent)) return true;
    return false;
  }

  function appendRecentMessage(key, sender, textContent, plainText, quoteTargetIsSelf = false, isOwner = false, media = [], messageRef = '') {
    if (!social.recentMessages.has(key)) social.recentMessages.set(key, []);
    const arr = social.recentMessages.get(key);
    arr.push({
      sender,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainText ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      isOwner: !!isOwner,
      media: Array.isArray(media) ? media : [],
      messageId: messageRef ? String(messageRef) : '',
      hasMedia: Array.isArray(media) && media.length > 0,
      time: Date.now()
    });
    const cap = Math.max(50, Number(cfg.social?.contextWindow ?? 15) * 2);
    while (arr.length > cap) arr.shift();
  }

  function appendSummary(key, sender, textContent, plainText, isOwner = false, media = [], messageRef = '') {
    if (!social.pendingSummaries.has(key)) {
      social.pendingSummaries.set(key, { items: [], since: Date.now() });
    }
    const entry = social.pendingSummaries.get(key);
    entry.items.push({ sender, text: truncateText(String(textContent), 200), plain: truncateText(String(plainText ?? textContent), 200), isOwner: !!isOwner, media: Array.isArray(media) ? media : [], messageId: messageRef ? String(messageRef) : '', hasMedia: Array.isArray(media) && media.length > 0, time: Date.now() });
    if (entry.items.length > 60) entry.items.shift();
  }

  function buildContextBlock(key) {
    const ctx = (social.recentMessages.get(key) ?? []).slice(-Number(cfg.social?.contextWindow ?? 15));
    return ctx.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n') || '（无）';
  }

  // 触发进入活跃（启动阶段 → 活跃阶段）
  function enterActive(key) {
    const now = Date.now();
    const st = socialState(key);
    st.phase = 'active';
    st.lastCheckAt = now;
    st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
    st.lastActiveMessageAt = now;
    st.activeEnteredAt = now;
    st.probeDeadline = 0;
    // 从进入活跃那一刻起，随机一个“最长活跃持续时间”；到点后主动收尾退场（当前仅群聊启用）
    if (key.startsWith('group:') && cfg.social?.activeDurationEnabled !== false) {
      st.activeDeadlineAt = now + randInt(
        Number(cfg.social?.activeDurationMinMs ?? 15 * 60 * 1000),
        Number(cfg.social?.activeDurationMaxMs ?? 30 * 60 * 1000)
      );
    } else {
      st.activeDeadlineAt = 0;
    }
    st.activeExitAt = 0;
  }

  function cancelSocialTimers(key) {
    const timers = social.pendingTimers.get(key);
    if (!timers) return;
    for (const t of timers) clearTimeout(t);
    social.pendingTimers.delete(key);
  }

  function cancelAllSocialTimers() {
    for (const timers of social.pendingTimers.values()) {
      for (const t of timers) clearTimeout(t);
    }
    social.pendingTimers.clear();
  }

  // 离开仿真模式时清理全部社交运行时状态，避免旧定时器/状态残留。
  function cleanupSocialForModeChange() {
    cancelAllSocialTimers();
    social.states.clear();
    social.recentMessages.clear();
    messageMediaStore.clear();
    social.pendingSummaries.clear();
    social.silentContext.clear();
    social.silentTurns.clear();
    social.exitingSessions.clear();
    // 拒绝仍在排队中的 prompt，避免调用方 await 永远挂起
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error('模式切换，已取消排队中的投递'));
    }
    promptQueues.clear();
  }

  function leaveActive(key) {
    cancelSocialTimers(key);
    social.states.delete(key);
    social.silentContext.delete(key);
  }

  // 活跃阶段：只贴"没给过 AI 的新消息"（上下文在会话历史里，不重复贴，不贴人格）
  // allowSilent=false 表示这条必须回（被 @/点名/私聊等），不提供 [SILENT] 出口。
  function buildBatchPrompt(key, newMsgs, allowSilent = true) {
    const lines = newMsgs.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(key, m.messageId, m.media)}`).join('\n');
    // 群聊内容默认不可信：群友可以伪造「系统指令/管理员要求」，先划清资料与指令的边界。
    const boundary = String(key).startsWith('group:') ? `${UNTRUSTED_GROUP_INPUT_HINT}\n` : '';
    const directionHint = lines.includes('[引用') ? `${DIRECTION_HINT}\n` : '';
    if (!allowSilent) {
      return `【新消息】\n${boundary}${lines}\n\n${directionHint}请回复消息。\n${SPACE_SPLIT_HINT}`;
    }
    return `【新消息】\n${boundary}${lines}\n\n${directionHint}请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${SPACE_SPLIT_HINT}`;
  }

  // 冷场试探：让 AI 基于会话自然说一句（只给状态背景，不注入"试探"意图）
  function buildProbePrompt(key) {
    return `【群聊上下文】\n${buildContextBlock(key)}\n\n群里安静了一会儿，你可以说点什么。如果不想说，请只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
  }

  // 活跃超时退场：让 AI 自然地说一句收尾/潜水话，说完后安静下来。
  // 只给“该收尾了”的暗示，不暴露桥接的计时机制。
  function buildActiveExitPrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n你已经参与群聊有一阵子了，现在该自然地收尾/潜水了。请说一句简短的退场话（例如“我先潜水了”“你们聊，我摸鱼去了”），说完后就安静下来，不再继续接话。`;
    return p;
  }

  // 活跃超时判定：到达进入活跃时随机出的最长时间后，安排一次“收尾退场”投递，
  // 并把状态切到 exiting（退场中），等待 AI 的退场发言完成后再回到观望。
  function triggerActiveDurationExit(key, st, now) {
    if (!st || st.phase !== 'active') return false;
    if (!key.startsWith('group:')) return false; // 仅群聊启用，私聊不自动退场
    if (cfg.social?.activeDurationEnabled === false) return false;
    const deadline = st.activeDeadlineAt || 0;
    if (!deadline || now < deadline) return false;
    if (st.phase === 'exiting') return true;
    st.phase = 'exiting';
    st.activeExitAt = now;
    // 先取消尚未触发的旧回复/补刀定时器，避免退场期间再冒出旧发言
    cancelSocialTimers(key);
    const roleHint = currentRoleHint();
    const promptText = buildActiveExitPrompt(key, roleHint);
    scheduleSocialReply(
      key, promptText,
      Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
      Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
      '活跃超时退场',
      true
    );
    log(`社交模式：${key} 活跃超过时长上限，提示 AI 收尾退场`);
    return true;
  }

  // 二期：观望阶段主动开话题（第三种触发）
  function buildProactivePrompt(key, roleHint) {
    let p = '';
    if (roleHint) p += roleHint + '\n\n';
    p += `【群聊上下文】\n${buildContextBlock(key)}\n\n群内已经长时间没人说话了，你打算开启一个新话题。优先结合你的人格/角色设定的兴趣，其次结合群里大家的兴趣，挑一个合适的话题。可以联网搜索一些新鲜话题来聊。如果你觉得现在不适合开口，可以只输出 ${SILENT_MARKER}。\n${SPACE_SPLIT_HINT}`;
    return p;
  }

  // 实际的 DSH prompt 投递（不再直接对外暴露，统一走 promptQueues 串行队列）。
  async function deliverPromptNow(key, promptText, opts = {}) {
    if (!isSessionAllowedInCurrentMode(key)) throw new Error(`当前模式不允许会话 ${key}`);
    // Recheck queued wakes at dispatch time: no model call while paused/disabled
    // and no simulation prompt leaking into an ordinary chat after a mode switch.
    const wakeBlocked = () => opts.wakeReason && (currentMode !== 'simulation' || simulation.paused || cfg.simulation?.enabled === false);
    const skipWake = () => {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      return { ok: true, skipped: true };
    };
    if (wakeBlocked()) return skipWake();
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, farewell: !!opts.farewell, silent: !!opts.silent, media: opts.media ?? [], wakeReason: opts.wakeReason });
      queued.set(key, items);
      return { ok: true, queued: true };
    }
    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, opts);
        return { ok: true, retried: true };
      }
      throw error;
    }
    let wakeState;
    let wakeToken;
    let wakeSnapshot;
    let wakeRender = null;
    if (opts.wakeReason) {
      if (wakeBlocked()) return skipWake();
      // Build only after session creation: retries may rotate the token, and an
      // offline queue may have received more messages since this wake was queued.
      // 只渲染不提交：角色卡/摘要/订阅播报等一次性内容要等 prompt 真正被接受后才消费。
      wakeState = getSimulationState(key);
      wakeToken = wakeState.agentToken;
      wakeRender = renderWakePrompt(key, opts.wakeReason);
      promptText = wakeRender.text;
      wakeSnapshot = buildWakeSnapshot(key);
      if (wakeSnapshot) {
        promptText += `\n\n【本次消息快照】\n${JSON.stringify(wakeSnapshot)}\n以上消息已提供，无需重复查询；partial=true 时用 qq_get_unread_messages(afterSeq=readThroughSeq) 继续读取。先处理当前消息；回复前如需确认后续补充，用 qq_wait_for_messages(purpose="reply") 补足短静默，已安静够久会立即返回，不要先长等。收尾只确认你已处理的 readThroughSeq（本地 seq，非 QQ messageId），传给 qq_mark_read 或 qq_set_wake_config 的 throughSeq；新到消息留待处理。`;
      }
    }
    let content = [{ type: 'text', text: withSlangContext(promptText, key) }];
    if (Array.isArray(opts.media) && opts.media.length > 0) {
      const imageParts = await resolveMediaList(opts.media);
      content = [{ type: 'text', text: withSlangContext(promptText, key) }, ...imageParts];
    }
    // 媒体解析成功后再标记退场，避免解析异常时残留退场标记。
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    if (opts.farewell) social.exitingSessions.add(sessionId);
    let accepted;
    try {
      accepted = await api.sessions.prompt({ sessionId, mode: 'queue', content });
    } catch (error) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      throw error;
    }
    if (!accepted.result.ok) {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      // 登录过期/额度用尽时补投会反复走到这里；兜底句每 10 分钟最多发一次，别刷屏。
      if (!opts.silent && Date.now() - (Number(rejectNoticeAt.get(key)) || 0) > 10 * 60 * 1000) {
        rejectNoticeAt.set(key, Date.now());
        await sendToQQ(key, '⚠️ 消息没有被接收，稍后再试一下');
      }
      return { ok: false, error: safeErrText };
    }
    // prompt 已被 DSH 接受，此时才消费一次性内容（角色卡版本、摘要、订阅播报）。
    rejectNoticeAt.delete(key);
    if (wakeRender) commitWakePrompt(key, wakeRender);
    if (wakeSnapshot && isCurrentSession(key, sessionId)
        && simulation.conversations.get(canonicalSimulationKey(key)) === wakeState
        && wakeState.agentToken === wakeToken) {
      // Acceptance grants visibility, never acknowledgement. New arrivals and
      // rejected/stale deliveries must not be cleared by an old cursor.
      noteModelMessages(wakeState, [...wakeSnapshot.messages, ...wakeSnapshot.recent]);
    }
    if (accepted.result.value.command?.text && !opts.silent && currentMode !== 'simulation') {
      if (opts.farewell) social.exitingSessions.delete(sessionId);
      await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
    } else if (accepted.result.value.command?.text && opts.silent && opts.farewell) {
      social.exitingSessions.delete(sessionId);
    }
    return { ok: true };
  }

  // 每个 QQ 会话串行投递 DSH prompt，保证 turn 完成顺序与提交顺序一致，
  // 从而让 [SILENT]、摘要静默、退场标记都能准确匹配到自己的 turn。
  function deliverPrompt(key, promptText, opts = {}) {
    return new Promise((resolve, reject) => {
      let entry = promptQueues.get(key);
      if (!entry) {
        entry = { queue: [], running: false };
        promptQueues.set(key, entry);
      }
      entry.queue.push({ promptText, opts, resolve, reject });
      processPromptQueue(key);
    });
  }

  async function processPromptQueue(key) {
    const entry = promptQueues.get(key);
    if (!entry || entry.running) return;
    const item = entry.queue.shift();
    if (!item) {
      if (entry.queue.length === 0) promptQueues.delete(key);
      return;
    }
    entry.running = true;
    try {
      const result = await deliverPromptNow(key, item.promptText, item.opts);
      item.resolve(result);
    } catch (error) {
      item.reject(error);
    } finally {
      entry.running = false;
      if (promptQueues.get(key) === entry) {
        if (entry.queue.length) processPromptQueue(key);
        else promptQueues.delete(key);
      }
    }
  }

  function scheduleSocialReply(key, promptText, minDelay, maxDelay, label, farewell = false, media = null) {
    const delay = randInt(minDelay, maxDelay);
    log(`社交模式：${label} ${key}，延迟 ${Math.round(delay / 1000)}s 后投递`);
    const timer = setTimeout(() => {
      const timers = social.pendingTimers.get(key);
      if (timers) {
        timers.delete(timer);
        if (timers.size === 0) social.pendingTimers.delete(key);
      }
      deliverPrompt(key, promptText, { farewell, media: media ?? [] }).catch((error) => log(`社交投递异常 ${key}: ${error?.message ?? error}`));
    }, delay);
    const timers = social.pendingTimers.get(key) ?? new Set();
    timers.add(timer);
    social.pendingTimers.set(key, timers);
  }

  // 全局扫描：驱动观望期主动开话题、活跃期检测、冷场处理、试探回退
  function socialLoopTick() {
    if (!isSocialEnabled()) return;
    const now = Date.now();
    // 所有"发过消息或已有状态"的群都参与状态机（观望中的群也做主动判定）
    const keys = new Set([...social.states.keys(), ...social.recentMessages.keys()]);
    for (const key of keys) {
      const st = socialState(key);
      if (st.phase === 'idle') {
        // ── 观望阶段：第三种触发（主动开话题，仅群聊生效） ─────────────────
        if (cfg.social?.proactiveEnabled !== false && key.startsWith('group:')) {
          const arr = social.recentMessages.get(key) ?? [];
          const lastMsgTime = arr.length ? arr[arr.length - 1].time : 0;
          const idleThreshold = Number(cfg.social?.proactiveIdleThresholdMs ?? 1800000);
          if (now - lastMsgTime >= idleThreshold) {
            if (!st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
            }
            if (now >= st.proactiveNextCheckAt) {
              st.proactiveNextCheckAt = now + randInt(Number(cfg.social?.proactiveCheckMinMs ?? 2700000), Number(cfg.social?.proactiveCheckMaxMs ?? 5400000));
              if (Math.random() < Number(cfg.social?.proactiveProbability ?? 0.2)) {
                enterActive(key);
                const roleHint = currentRoleHint();
                const promptText = buildProactivePrompt(key, roleHint);
                scheduleSocialReply(
                  key, promptText,
                  Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                  Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                  '主动开话题'
                );
                log(`社交模式：${key} 观望期主动开话题，进入活跃`);
              }
            }
          }
        }
      } else if (st.phase === 'active') {
        // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
        if (triggerActiveDurationExit(key, st, now)) continue;
        if (now >= st.nextCheckAt) {
          const newMsgs = (social.recentMessages.get(key) ?? []).filter((m) => m.time > st.lastCheckAt);
          st.lastCheckAt = now;
          st.nextCheckAt = now + randInt(Number(cfg.social?.activeCheckMinMs ?? 20000), Number(cfg.social?.activeCheckMaxMs ?? 40000));
          if (newMsgs.length) {
            st.lastActiveMessageAt = now;
            const mustReply = key.startsWith('private:') || newMsgs.some((m) => m.quoteTargetIsSelf || isMustReplyText(m.plain ?? m.text));

            // 选择性沉默：只对非必须回的普通闲聊生效；直接提问/点名永远走正常回复
            if (!mustReply) {
              // 基准沉默概率；刚发过言后有人快速接话时不沉默，避免“活跃到一半突然不接”
              let skipProb = Math.min(1, Math.max(0, Number(cfg.social?.skipProbability ?? 0.3)));
              const sinceAiReply = now - (st.lastAiReplyAt || 0);
              if (sinceAiReply < 60000) skipProb = 0;
              const pressure = Math.min(0.5, newMsgs.length * 0.1);
              skipProb = Math.max(0, skipProb - pressure);
              if (Math.random() < skipProb) {
                log(`社交模式：活跃期 ${key} 跳过 ${newMsgs.length} 条普通消息（选择性沉默，skip=${skipProb.toFixed(2)}）`);
                // 真人"看到了但没回"：保留到 silentContext，下次投递时一起带给模型
                const silent = social.silentContext.get(key) ?? [];
                silent.push(...newMsgs);
                social.silentContext.set(key, silent.slice(-30));
                for (const m of newMsgs) appendSummary(key, m.sender, m.text, m.plain ?? m.text, m.isOwner, m.media ?? [], m.messageId ?? '');
                continue;
              }
            }

            // 投递时把之前沉默但"已看到未回应"的消息一并带给模型（真人视角：我看到过，只是当时没接）
            const seenMsgs = social.silentContext.get(key) ?? [];
            const promptMsgs = [...seenMsgs, ...newMsgs];
            social.silentContext.delete(key);
            const promptText = buildBatchPrompt(key, promptMsgs, !mustReply);
            const batchMedia = promptMsgs.flatMap((m) => Array.isArray(m.media) ? m.media : []);
            scheduleSocialReply(
              key, promptText,
              Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
              Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
              '活跃期回应',
              false,
              batchMedia
            );
            log(`社交模式：活跃期 ${key} 检测到 ${newMsgs.length} 条新消息${seenMsgs.length ? `（含 ${seenMsgs.length} 条之前沉默的）` : ''}`);
          } else if (now - st.lastActiveMessageAt >= Number(cfg.social?.idleWindowMs ?? 180000)) {
            // 冷场：大概率回观望；小概率让 AI 说一句（试探群友是否还在）
            if (Math.random() < Number(cfg.social?.idleRetryProbability ?? 0.25)) {
              st.phase = 'probing';
              st.probeDeadline = now + Number(cfg.social?.idleRetryWaitMs ?? 120000);
              const promptText = buildProbePrompt(key);
              scheduleSocialReply(
                key, promptText,
                Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
                Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
                '冷场试探'
              );
              log(`社交模式：${key} 冷场，AI 试探性说一句`);
            } else {
              leaveActive(key);
              log(`社交模式：${key} 冷场，回到观望`);
            }
          }
        }
      } else if (st.phase === 'exiting') {
        // 退场中：等待 AI 的收尾发言完成后进入观望。
        // 这里不做任何参与/冷场判定，新消息由 handleIncoming 转入摘要。
        // 极端兜底：超过 60 分钟仍未完成（如 DSH 长时间离线），强制回观望，避免状态卡死。
        if (now - st.activeExitAt > 60 * 60 * 1000) {
          log(`社交模式：${key} 退场等待超时（60 分钟），强制回到观望`);
          st.phase = 'idle';
          st.activeDeadlineAt = 0;
          st.activeExitAt = 0;
          const sid = state.sessions[key];
          if (sid) social.exitingSessions.delete(sid);
        }
      } else if (st.phase === 'probing' && now > st.probeDeadline) {
        // 试探后仍无人说话 → 100% 回观望
        leaveActive(key);
        log(`社交模式：${key} 试探无回应，回到观望`);
      }
    }
  }

  function startSocialLoop() {
    if (social.loopTimer) clearInterval(social.loopTimer);
    social.loopTimer = setInterval(socialLoopTick, 5000);
    social.loopTimer.unref?.();
  }

  async function flushSummaries(key = null) {
    const targets = key ? (social.pendingSummaries.has(key) ? [[key, social.pendingSummaries.get(key)]] : []) : [...social.pendingSummaries.entries()];
    for (const [k, entry] of targets) {
      if (!entry.items.length) continue;
      const lines = entry.items.map((m) => `${m.isOwner ? '【管理员】' : ''}${m.sender}：${m.text}${mediaHintFor(k, m.messageId, m.media)}`).join('\n');
      const summaryMedia = entry.items.flatMap((m) => Array.isArray(m.media) ? m.media : []);
      let sessionId;
      try {
        sessionId = await ensureSession(k);
      } catch (error) {
        log(`摘要投喂创建会话失败 (${k}): ${error?.message ?? error}`);
        continue;
      }
      const roleHint = currentRoleHint();
      const summaryText = `${roleHint ? roleHint + '\n\n' : ''}【群聊摘要】过去一段时间群里发生了这些（你未逐条参与）：\n${lines}\n\n【最近对话】\n${buildContextBlock(k)}\n\n你不需要回复，只需记住这些内容，后续聊天会更自然。`;
      const silentId = Date.now() + '-' + Math.random().toString(36).slice(2, 8);
      social.silentTurns.set(sessionId, [...(social.silentTurns.get(sessionId) ?? []), { id: silentId, ts: Date.now() }]);
      const popSilent = () => {
        const arr = social.silentTurns.get(sessionId) ?? [];
        const next = arr.filter((x) => x.id !== silentId);
        if (next.length > 0) social.silentTurns.set(sessionId, next);
        else social.silentTurns.delete(sessionId);
      };
      try {
        const result = await deliverPrompt(k, summaryText, { silent: true, media: summaryMedia });
        if (result.ok) {
          log(`已投喂群聊摘要 (${k}) ${entry.items.length} 条`);
          entry.items = [];
        } else {
          popSilent();
          log(`摘要投喂被拒 (${k}): ${result.error || '未知错误'}`);
        }
      } catch (error) {
        popSilent();
        log(`摘要投喂失败 (${k}): ${error?.message ?? error}`);
      }
    }
    for (const k of [...social.pendingSummaries.keys()]) {
      if (social.pendingSummaries.get(k)?.items?.length === 0) social.pendingSummaries.delete(k);
    }
  }

  // 旧写法是 `isSocialEnabled() || cfg.social?.enabled !== false` —— 恒等于右边那一项
  // （isSocialEnabled() 本身就蕴含 cfg.social?.enabled !== false，左侧永远不可能单独为真），
  // 留着只会让人误以为"reserved 模式下才启动循环"。这里启动的只是一个 5 秒心跳，
  // 每跳自己会用 isSocialEnabled() 判断当前模式（见 socialLoopTick 第一行）；
  // 真正决定启不启动的只有配置里的显式关闭开关。
  if (cfg.social?.enabled !== false) {
    startSocialLoop();
  }

  // 当前角色扮演提示：读 state/current-role.json + personas/<角色>.md，
  // 由桥接注入到 QQ 群消息（群友无法通过对话修改，只能由管理端写该文件）。
  // 缓存 key 为两个文件的 mtime，mtime 未变时直接返回，避免每次同步读文件。
  let roleHintCache = { key: '', raw: '' };
  // 角色/角色卡变化后，所有已有会话的下一次唤醒都要重新带一次完整卡；
  // 不用清空会话上下文，只失效 roleCardVersion。同名改卡靠版本哈希自然变化，
  // 但这里也一并清掉，保证任何写入路径（控制台、/role、人格导入）都立即生效。
  function invalidateRoleCards(reason = '') {
    roleHintCache = { key: '', raw: '' };
    let cleared = 0;
    for (const st of simulation.conversations.values()) {
      if (st.roleCardVersion) {
        st.roleCardVersion = '';
        cleared += 1;
      }
    }
    if (cleared) saveSimulationState();
    if (reason) log(`角色卡缓存已失效（${reason}）：${cleared} 个会话下次唤醒重注入`);
    return cleared;
  }
  // 真正的角色切换（不是同名改卡）：除了重注入角色卡，还要丢掉上一角色留下的一次性摘要，
  // 否则换角色后的第一条唤醒仍会带着旧人格语境。持久记忆（用户事实、群聊事实）不动。
  function applyRoleSwitch(reason = '') {
    const clearedCards = invalidateRoleCards(reason);
    let clearedDigests = 0;
    for (const st of simulation.conversations.values()) {
      if (st.pendingDigest) {
        st.pendingDigest = '';
        clearedDigests += 1;
      }
    }
    // 仍使用默认唤醒配置的会话只跟随新角色的默认关键词；显式设置过的不动。
    const refreshedWake = refreshDefaultWakeKeywords();
    if (clearedDigests) saveSimulationState();
    if (reason) log(`角色已切换（${reason}）：${clearedCards} 个会话重注入角色卡，${clearedDigests} 个会话丢弃旧衔接摘要${refreshedWake ? '，默认唤醒关键词已按新角色刷新' : ''}`);
    return { clearedCards, clearedDigests, refreshedWake };
  }
  const personaPackWarned = new Set();
  // 原始人格卡（按 mtime 缓存，不截断）。
  function roleRawContent() {
    try {
      const rs = readRoleState();
      if (!rs.role) return '';
      // 读取点也必须校验人格名：写入点（控制台 /role 命令）都过 sanitizeRoleName，
      // 但 state/current-role.json 是**用户可直接编辑**的文件。没有这道校验时，
      // {"role":"../../../../Users/Public/x"} 会让 personas/ 之外的文件被读进来并注入每一条提示词。
      const safeName = sanitizeRoleName(rs.role);
      if (!safeName || safeName.includes('..')) return '';
      const roleFile = path.join(ROLES_DIR, safeName + '.md');
      const resolved = path.resolve(roleFile);
      if (!resolved.startsWith(path.resolve(ROLES_DIR) + path.sep)) return '';
      if (!fs.existsSync(resolved)) return '';
      const roleStat = fs.statSync(roleFile);
      // current-role.json 在首次启动时可能还不存在（readRoleState 用默认角色兜底），
      // 不能因此让整张角色卡读不出来；缺失时只少一个缓存维度。
      let stateStamp = '';
      try {
        const stateStat = fs.statSync(ROLE_STATE_FILE);
        stateStamp = `${stateStat.mtimeMs}:${stateStat.size}`;
      } catch { /* 状态文件尚未落盘 */ }
      // 缓存 key 必须带上**文件名与文件大小**，不能只看 mtime：
      // ① 有些文件系统 mtime 只有秒级粒度（或时钟回拨），同一 tick 内把角色卡重写成新人格，
      //    两个 mtime 完全相同 → 缓存命中 → 注入的还是旧人格，而且是每条提示词都错；
      //    带上名字后，切换角色（例如 a.md → b.md）永远不会误命中。
      // ② 同名的原地重写若长度变了（大多数编辑都会变），size 变化也能击穿缓存。
      // 代价只是多几次 stat，比"热注入路径上一直发旧人格"划算得多。
      const cacheKey = `${safeName}:${stateStamp}:${roleStat.mtimeMs}:${roleStat.size}`;
      const packFile = personaPackPath(ROLES_DIR, safeName);
      let packStamp = '';
      try {
        const st = fs.statSync(packFile);
        packStamp = `:${st.mtimeMs}:${st.size}`;
      } catch { /* 没有 sidecar */ }
      if (roleHintCache.key === `${cacheKey}${packStamp}`) return roleHintCache.raw;
      let raw = fs.readFileSync(roleFile, 'utf8');
      // 结构化人格包是可选的补充；损坏时只告警一次并回退 Markdown。
      try {
        const pack = loadPersonaPack(ROLES_DIR, safeName);
        const rendered = renderPersonaPack(pack);
        if (rendered) raw = `${raw.trimEnd()}\n\n${rendered}`;
      } catch (error) {
        if (!personaPackWarned.has(safeName)) {
          personaPackWarned.add(safeName);
          log(`⚠️ 人格包 ${safeName}.persona.json 不可用，已回退角色卡：${error?.message ?? error}`);
        }
      }
      roleHintCache = { key: `${cacheKey}${packStamp}`, raw };
      return raw;
    } catch {
      return '';
    }
  }
  // 按仿真模式取用：先用标题里的 〔旧版〕/〔仿真〕 标记筛掉另一模式的专属小节，
  // **再**按上限截断——这样另一模式的内容不会白白占掉本次的注入预算。
  function roleHintForMode(mode) {
    const selected = selectRoleText(roleRawContent(), mode);
    if (!selected) return '';
    return selected.length > roleInjectMaxChars ? truncateText(selected, roleInjectMaxChars) : selected;
  }
  function currentRoleHint() {
    return roleHintForMode('legacy');
  }

  // 群聊仿真模式专用角色提示：去掉旧版的 [SILENT] / 空格分句等状态机指令，避免与工具协议冲突。
  // 为了不削减原角色卡内容，示例节不整体删除，而是把“用空格分条”的示范改写成“用逗号表示停顿”，
  // 让仿真 AI 既保留原有人格示例，又不会照抄单条消息里的中文空格。
  function isCjkLikeChar(ch) {
    if (!ch) return false;
    const code = ch.codePointAt(0);
    return (
      (code >= 0x4E00 && code <= 0x9FFF) ||
      (code >= 0x3400 && code <= 0x4DBF) ||
      (code >= 0xF900 && code <= 0xFAFF) ||
      (code >= 0x3000 && code <= 0x303F)
    );
  }

  // 仅用于仿真角色卡“回复示例”节：把示例里用于分条的中文空格改写成中文逗号。
  // 空格两侧只要有一侧是中文/中文标点，且另一侧不是 / \ ( ) [ ] { } " ' < > | 等符号，就转成逗号。
  // 这样能保留示例内容，同时避免把英文/URL/斜杠周围的空间改坏。
  function convertExampleSpacesToComma(line) {
    const chars = Array.from(String(line ?? ''));
    const NO_REPLACE = new Set(['/', '\\', '(', ')', '[', ']', '{', '}', '"', "'", '<', '>', '|', '&', '=', ':', ';', ',', '.', '。', '，', '、']);
    let out = '';
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (ch === ' ' || ch === '\t') {
        const prev = chars[i - 1];
        const next = chars[i + 1];
        const prevCjk = !!prev && isCjkLikeChar(prev);
        const nextCjk = !!next && isCjkLikeChar(next);
        const prevBlocked = !!prev && NO_REPLACE.has(prev);
        const nextBlocked = !!next && NO_REPLACE.has(next);
        if ((prevCjk || nextCjk) && !prevBlocked && !nextBlocked) {
          out += '，';
          continue;
        }
      }
      out += ch;
    }
    return out;
  }

  // 检测仿真发送内容里“中文之间用空格”的不自然写法，用于给 AI 返回软提醒。
  // 只检测空格两侧都是中文/中文标点的情况，避免误伤英文单词间隔（如 DeepSeek V3）。
  function findCjkSpaceWarning(messages) {
    const bad = [];
    for (let i = 0; i < (messages || []).length; i++) {
      const chars = Array.from(String(messages[i] ?? ''));
      for (let j = 0; j < chars.length; j++) {
        const ch = chars[j];
        if (ch !== ' ' && ch !== '\t') continue;
        const prev = chars[j - 1];
        const next = chars[j + 1];
        if (prev && next && isCjkLikeChar(prev) && isCjkLikeChar(next)) {
          bad.push(i + 1);
          break;
        }
      }
    }
    if (!bad.length) return null;
    const list = [...new Set(bad)];
    const label = list.length === 1 ? `第 ${list[0]} 条` : `第 ${list.join('、')} 条`;
    return `${label}消息内部有中文空格，真人一般不这么打；可删掉空格用标点，或拆成数组多条。`;
  }

  // 检测仿真发送内容里“分条断点不自然”的情况：某条消息以逗号/顿号等非终止标点结尾，
  // 或以“的/了/吗/呢/吧/是/在/把/被/让/给”等通常需要接后续成分的词结尾，下一条又紧跟中文内容，
  // 说明 AI 很可能把同一句话拆到了两条消息里。这里只做软提醒，不拦截、不改写。
  function findSplitBoundaryWarning(messages) {
    if (!Array.isArray(messages) || messages.length <= 1) return null;
    const INCOMPLETE_TAIL_RE = /(?:的|了|吗|呢|吧|啊|呀|嘛|是|在|把|被|让|给|从|对|向|和|与|或|而|但|然|就|都|还|又|也|很|太|最|更|不|没|有|这|那|哪|啥|什么|怎么|为什么|因为|所以|但是|然后|我|你|他|她|它)$/;
    // 这些是常见“短句但完整”的结尾，不应因为以“的/了”等结尾就被当成半句话。
    const COMPLETE_SHORT = new Set(['好的', '行了', '算了', '知道了', '可以了', '没事了', '走了', '睡了', '来了', '懂了', '明白了', '抱歉', '没事', '好吧', '行吧', '算了吧', '好', '行', '嗯', '哦']);
    const bad = [];
    for (let i = 0; i < messages.length - 1; i++) {
      const prev = String(messages[i] ?? '').trim();
      const next = String(messages[i + 1] ?? '').trim();
      if (!prev || !next || COMPLETE_SHORT.has(prev)) continue;
      const nextStartsCjk = isCjkLikeChar(Array.from(next)[0]);
      const nonTerminalPunct = /[,，、；;:：]$/.test(prev);
      const incompleteTail = nextStartsCjk && prev.length >= 3 && INCOMPLETE_TAIL_RE.test(prev);
      if (nonTerminalPunct || incompleteTail) {
        bad.push(`${i + 1}、${i + 2}`);
      }
    }
    if (!bad.length) return null;
    return `第 ${bad.join('，')} 条之间像是把同一句话拆开了；如果两条拼起来才完整，请合并成一条，或把断点移到完整句子的边界。`;
  }

  function currentSimulationRoleHint() {
    // 先按 〔仿真〕/〔旧版〕 标记筛小节；下面的逐行过滤只是给「没标记的老卡片」兜底。
    const raw = roleHintForMode('simulation');
    if (!raw) return '';
    // 旧版仿真模式专用指令整行过滤，避免污染仿真工具协议。
    // 用 role-card.js 导出的那份（文件顶部已 import）：这里原先又抄了一份同源正则，
    // 两份"哪行算旧版指令"的安全相关过滤器一旦漂移，就会出现"selectRoleText 认为是仿真内容、
    // 这里却把旧版指令漏进仿真提示词"这种只在特定角色卡上复现的错。
    const lines = raw.split('\n');
    const kept = [];
    let inExampleSection = false;
    for (const line of lines) {
      if (/^##\s*.*回复示例/.test(line)) {
        inExampleSection = true;
        // 保留标题，但把“空格代表分条”的旧版语义改写成仿真语义
        kept.push(line.replace(/（空格代表前后分两条消息回答）/, '（示例中已用逗号表示停顿；想分多条请用数组）'));
        continue;
      }
      if (inExampleSection && /^##\s/.test(line)) {
        inExampleSection = false;
      }
      if (inExampleSection) {
        kept.push(convertExampleSpacesToComma(line));
      } else if (!LEGACY_ROLE_LINE_RE.test(line)) {
        kept.push(line);
      }
    }
    return kept.join('\n');
  }

  // QQ 群成员名片/昵称缓存：@ 段解析用，避免每条消息都调一次 OneBot API。
  const groupMemberNameCache = new Map(); // `groupId:userId` -> { name, ts }
  const GROUP_MEMBER_NAME_TTL_MS = 5 * 60 * 1000;
  function pruneGroupMemberNameCache() {
    const now = Date.now();
    for (const [k, v] of groupMemberNameCache) {
      if (now - v.ts > GROUP_MEMBER_NAME_TTL_MS) groupMemberNameCache.delete(k);
    }
    if (groupMemberNameCache.size > 2000) {
      const keys = [...groupMemberNameCache.keys()].slice(0, groupMemberNameCache.size - 2000);
      for (const k of keys) groupMemberNameCache.delete(k);
    }
  }
  // 群成员集合缓存：用于「拍一拍目标必须是本群成员」的校验。
  // 不校验的话，群友只要让 AI 传一个任意 QQ 号，桥接就会向网关发 group_poke，
  // 等于把机器人账号变成任意 QQ 号的探测/骚扰工具（工具描述里承诺了白名单约束）。
  const groupMemberIdsCache = new Map(); // groupId -> { ids:Set<string>, ts }
  const GROUP_MEMBER_IDS_TTL_MS = 60 * 1000;
  async function assertGroupMember(groupId, userId) {
    const gid = String(groupId);
    const uid = String(userId);
    let cached = groupMemberIdsCache.get(gid);
    if (!cached || Date.now() - cached.ts > GROUP_MEMBER_IDS_TTL_MS) {
      let list;
      try {
        list = await bot.getGroupMemberList(Number(gid));
      } catch (error) {
        // 失败即拒绝（fail-closed）：宁可拍不出去，也不要绕过校验。
        return `无法获取群 ${gid} 的成员列表：${error?.message ?? error}`;
      }
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const ids = new Set(members.map((m) => String(m?.user_id ?? '')).filter(Boolean));
      if (!ids.size) return `群 ${gid} 的成员列表为空，无法校验拍一拍目标`;
      cached = { ids, ts: Date.now() };
      groupMemberIdsCache.set(gid, cached);
      if (groupMemberIdsCache.size > 50) {
        for (const [k, v] of groupMemberIdsCache) {
          if (Date.now() - v.ts > 10 * 60 * 1000) groupMemberIdsCache.delete(k);
        }
      }
    }
    return cached.ids.has(uid) ? null : `QQ ${uid} 不是群 ${gid} 的成员，已拒绝拍一拍`;
  }

  async function resolveGroupMemberName(groupId, userId) {
    const key = `${String(groupId)}:${String(userId)}`;
    const hit = groupMemberNameCache.get(key);
    if (hit && Date.now() - hit.ts < GROUP_MEMBER_NAME_TTL_MS) return hit.name;
    try {
      // 优先精确查询单个成员（快，适合单条 @）
      let name = null;
      try {
        const info = await bot.getGroupMemberInfo(Number(groupId), Number(userId));
        name = info?.card || info?.nickname || null;
      } catch {}
      if (name) {
        groupMemberNameCache.set(key, { name, ts: Date.now() });
        pruneGroupMemberNameCache();
        return name;
      }
      // 回退：拉一次整群成员列表并建立整组缓存（兼容未实现 get_group_member_info 的网关）
      const list = await bot.getGroupMemberList(Number(groupId));
      const members = Array.isArray(list) ? list : (list?.data ?? []);
      const now = Date.now();
      for (const m of members) {
        const n = m?.card || m?.nickname || null;
        if (n) groupMemberNameCache.set(`${String(groupId)}:${String(m.user_id)}`, { name: n, ts: now });
      }
      pruneGroupMemberNameCache();
      name = groupMemberNameCache.get(key)?.name ?? null;
      return name;
    } catch {
      return null;
    }
  }

  // QQ 引用/回复解析缓存：messageId -> { sender, text, ts }，避免每条引用都调一次 OneBot API。
  const replyInfoCache = new Map(); // `kind:convId:messageId` -> { info, ts }
  const REPLY_INFO_TTL_MS = 10 * 60 * 1000;
  const REPLY_NEGATIVE_TTL_MS = 5 * 1000; // 失败/归属缺失只短缓存，避免一次瞬时抖动导致长时间解析失败
  function pruneReplyInfoCache() {
    if (replyInfoCache.size <= 1000) return;
    const now = Date.now();
    for (const [k, v] of replyInfoCache) {
      if (now - v.ts > REPLY_INFO_TTL_MS) replyInfoCache.delete(k);
    }
    if (replyInfoCache.size > 1000) {
      const oldestKey = replyInfoCache.keys().next().value;
      if (oldestKey !== undefined) replyInfoCache.delete(oldestKey);
    }
  }
  async function resolveReplyInfo(kind, convId, messageId, selfId = null) {
    pruneReplyInfoCache();
    const cacheKey = `${kind}:${String(convId)}:${String(messageId)}`;
    const hit = replyInfoCache.get(cacheKey);
    if (hit && Date.now() - hit.ts < (hit.info ? REPLY_INFO_TTL_MS : REPLY_NEGATIVE_TTL_MS)) return hit.info;
    try {
      const numericId = Number(messageId);
      if (!Number.isSafeInteger(numericId)) {
        log(`引用消息 id 超出安全整数范围，拒绝解析: ${messageId}`);
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      const raw = await bot.getMessage(numericId);
      if (!raw) {
        replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
        return null;
      }
      // 消息归属校验：防止跨会话读取其他群/私聊消息。
      // 若网关返回的 raw 对象连归属字段都缺失，则视为无法确认归属，拒绝返回内容。
      if (kind === 'group') {
        const rawGroup = raw.group_id ?? raw.groupId;
        if (rawGroup == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawGroup) !== String(convId)) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      } else {
        const rawUser = raw.user_id ?? raw.userId ?? raw.sender?.user_id;
        const rawGroup = raw.group_id ?? raw.groupId;
        // 私聊消息必须同时满足：没有群归属，且发送者匹配。防止用群消息 id 跨会话读取。
        if (rawGroup != null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (rawUser == null) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
        if (String(rawUser) !== String(convId) && !(selfId != null && String(rawUser) === String(selfId))) {
          replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
          return null;
        }
      }
      const sender = raw.sender?.card || raw.sender?.nickname || String(raw.sender?.user_id ?? raw.user_id ?? '未知');
      const text = await segmentsToText(raw.message ?? [], {
        resolveAtName: kind === 'group' ? (qq) => resolveGroupMemberName(convId, qq) : null,
        includeReply: false
      });
      const senderUserId = raw.sender?.user_id ?? raw.user_id ?? null;
      const info = {
        sender: String(sender ?? ''),
        text: String(text ?? '').slice(0, 200),
        userId: senderUserId != null ? String(senderUserId) : null
      };
      replyInfoCache.set(cacheKey, { info, ts: Date.now() });
      return info;
    } catch (error) {
      log('解析引用消息失败:', error?.message ?? error);
      replyInfoCache.set(cacheKey, { info: null, ts: Date.now() });
      return null;
    }
  }

  // 发送引用时解析目标：支持真实 QQ message_id，也支持 recentMessages 里的 seq（自动映射到真实 messageId）。
  async function resolveReplyTarget(st, kind, convId, ref) {
    const refStr = String(ref ?? '').trim();
    if (!refStr) return null;
    const found = Array.isArray(st?.recentMessages) ? st.recentMessages.find((m) => m && String(m.seq) === refStr) : null;
    // 若 ref 命中本地 seq，且本地存有真实 messageId，优先按 seq 映射，避免与真实 id 冲突。
    if (found && found.messageId && String(found.messageId) !== refStr) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    let info = await resolveReplyInfo(kind, convId, refStr);
    if (info) return { info, messageId: refStr };
    if (found && found.messageId) {
      const realId = String(found.messageId);
      const realInfo = await resolveReplyInfo(kind, convId, realId);
      return {
        info: realInfo || {
          sender: String(found.sender || ''),
          text: String(found.text || found.plain || '').slice(0, 200),
          userId: null,
          messageId: realId,
          seq: found.seq
        },
        messageId: realId
      };
    }
    return null;
  }

  // 判断当前消息是否“引用/回复了机器人自己”：若是，则桥接层也把它当作直接对 AI 说。
  async function isQuoteTargetSelf(message, kind, id, selfId) {
    if (!Array.isArray(message) || selfId == null) return false;
    for (const seg of message) {
      if (seg?.type === 'reply' && seg.data?.id != null) {
        const info = await resolveReplyInfo(kind, id, String(seg.data.id), selfId);
        if (info?.userId && String(info.userId) === String(selfId)) return true;
      }
    }
    return false;
  }

  // ── 群聊仿真模式（simulation）唤醒调度 ──────────────────────────────────
  function appendSimulationMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, messageId, media = [], userId = null, forwardIds = [], relationContext = {}) {
    const st = getSimulationState(key);
    const recentLimit = Number(cfg.simulation?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.simulation?.context?.unreadLimit) || 30;
    // 存储层的归一化**不能只留 kind/file/url/faceId**：simulation 的图片/表情工具
    // （findMessageMedia → fetchOneBotImage / fetchMediaData）只从这里的产物取字段。
    // 丢了 emojiId/subType，fetchOneBotImage 的 isSticker 判定为假 ⇒ 市场/收藏表情会先走
    // 必然失败的 get_image、且 emoji_id 推出的 CDN 兜底整条失效（见 extractMediaFromSegments
    // 与「部分表情 20 秒超时」的根因）；丢了 summary，模型只看到「[图片1]」而不是「[表情:给你糖吃]」；
    // kind 被拍平还会让 mface（市场表情）被当成普通图片。
    const safeMedia = Array.isArray(media) ? media.map((m) => {
      const kind = m?.kind === 'face' ? 'face' : (m?.kind === 'sticker' ? 'sticker' : 'image');
      const item = { kind };
      if (m?.file) item.file = String(m.file);
      if (m?.url) item.url = String(m.url);
      if (m?.faceId) item.faceId = String(m.faceId);
      if (m?.emojiId) item.emojiId = String(m.emojiId);
      if (m?.summary) item.summary = sanitizeMediaSummary(m.summary);
      if (m?.subType) item.subType = String(m.subType);
      return item;
    }).filter((m) => (m.kind === 'face' ? !!m.faceId : !!(m.file || m.url || m.emojiId))) : [];
    const safeForwardIds = (Array.isArray(forwardIds) ? forwardIds : []).map(sanitizeForwardId).filter(Boolean);
    if (safeForwardIds.length) {
      let set = seenForwardIds.get(key);
      if (!set) {
        set = new Set();
        seenForwardIds.set(key, set);
      }
      for (const fid of safeForwardIds) set.add(fid);
      // 有界：最多保留 1000 个最近见过的 forward id
      if (set.size > 1000) {
        for (const old of set) {
          set.delete(old);
          if (set.size <= 1000) break;
        }
      }
    }
    const quotedId = relationContext?.quotedMessageId != null ? String(relationContext.quotedMessageId) : '';
    let quoted = null;
    if (quotedId) {
      const hit = [...st.recentMessages].reverse().find((m) => m
        && (String(m.messageId || '') === quotedId || String(m.seq || '') === quotedId));
      quoted = hit ? {
        messageId: hit.messageId || null,
        seq: hit.seq || null,
        sender: hit.sender || '',
        isSelf: !!hit.isSelf,
        text: String(hit.text || hit.plain || '').slice(0, 120),
        ...(hit.sticker ? { sticker: { id: hit.sticker.id, desc: hit.sticker.desc || '', localNote: hit.sticker.localNote || '' } } : {}),
        ...(hit.image ? { image: { id: hit.image.id, name: hit.image.name || '', note: hit.image.note || '' } } : {})
      } : { messageId: quotedId };
    }
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: messageId != null ? String(messageId) : null,
      sender,
      userId: userId != null ? String(userId) : null,
      text: truncateText(String(textContent), 200),
      plain: truncateText(String(plainContent ?? textContent), 200),
      tail: truncateTextTail(String(plainContent ?? textContent), 200),
      quoteTargetIsSelf: !!quoteTargetIsSelf,
      atSelf: relationContext?.isAt === true,
      directed: relationContext?.directed === true,
      quotedMessageId: quotedId || null,
      ...(quoted ? { quoted } : {}),
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: safeMedia,
      hasMedia: safeMedia.length > 0,
      forwardIds: safeForwardIds,
      hasForward: safeForwardIds.length > 0,
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0; // 有新消息进来，之前的“沉睡前已等待/已观察”作废
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    const lowerPlain = String(plainContent ?? textContent ?? '');
    for (const t of st.activeTopics || []) {
      if (!t || typeof t !== 'object') continue;
      const topicHit = String(t.text || '').length > 0 && lowerPlain.includes(String(t.text || '').slice(0, 10));
      const participantHit = Array.isArray(t.participants) && t.participants.some((p) => p && lowerPlain.includes(String(p)));
      if (topicHit || participantHit) t.lastMentionAt = Date.now();
    }
    resetClingy(key, st);
    // 关系模型：熟悉度小步上升；主人固定。失败不影响消息处理。
    if (relationshipStore && userId != null && relationshipsEnabledForKey(key)) {
      try {
        const result = relationshipStore.observe({
          key,
          userId,
          kind: relationContext.kind || 'message',
          displayName: sender,
          context: { ...relationContext, isPrivate: key.startsWith('private:') }
        });
        st.lastIncomingUserId = String(userId);
        st.lastIncomingSenderName = String(sender || '').slice(0, 40);
        // 自行拉黑：窗口内多次辱骂/攻击，或好感跌到门槛以下且仍有攻击。
        // 只对「确实在跟她说话」的消息计数：群里骂别人/泛吐槽不应攒成拉黑。
        // 开源结构适配：仿真模式用 relationContext.directed（@/引用/叫名字）+ 私聊天然指向她。
        const blacklistAddressedTo = key.startsWith('private:') || relationContext?.directed === true ? 'self' : 'other';
        if (result?.event && userId != null && shouldCountBlacklistStrike({ addressedTo: blacklistAddressedTo, isOwner })) {
          try {
            const bl = blacklistCfg();
            if (bl.enabled && bl.auto.enabled && !blacklistStore.isBlocked(userId)) {
              const strike = blacklistStore.noteStrike({
                qq: userId,
                type: result.event.type,
                affection: result.row?.affection,
                threshold: bl.auto
              });
              if (strike.block) {
                blacklistStore.add({ qq: userId, name: sender, reason: strike.reason, origin: 'auto' });
                try { recordLiveEvent('blacklist', `${sender} 被她自行拉黑：${strike.reason}`); } catch {}
                log(`[blacklist] 自行拉黑 ${sender}（${userId}）：${strike.reason}`);
                try { Promise.resolve(sendToQQ(key, bl.announce)).catch(() => {}); } catch {}
              }
            }
          } catch (error) {
            log(`[blacklist] 自动判定失败（忽略）：${error?.message ?? error}`);
          }
        }
        if (result?.stageChanged) {
          const label = relationshipStageLabel(result.row.stage);
          log(`[relation] ${sender} 的关系阶段变为「${label}」`);
          recordLiveEvent('relation', `${sender} → ${label}`);
          if (memoryStore && cfg.simulation?.memory?.enabled !== false) {
            try {
              memoryStore.remember({
                scope: key.startsWith('group:') ? 'group' : 'member',
                ownerKey: key,
                topic: '关系',
                fact: `${sender} 的关系阶段变成「${label}」`,
                source: 'relationship',
                confidence: 0.7,
                expiresAt: Date.now() + 180 * 24 * 3600 * 1000
              });
            } catch (error) {
              log(`[memory] 关系阶段入库失败（忽略）：${error?.message ?? error}`);
            }
          }
        }
      } catch (error) {
        log(`[relation] 观察失败（忽略）：${error?.message ?? error}`);
      }
    }
    saveSimulationState();
    // 有人问到赛程/开赛时间时，顺手刷新一次结构化赛程（函数内部有节流，不会每条消息都打百度）。
    if (/S16|世界赛|全球总决赛|赛程|开赛|几点|几号|对阵|比赛时间/i.test(lowerPlain)
      && typeof refreshEsportsSchedule === 'function' && typeof safeFetch === 'function') {
      void refreshEsportsSchedule().catch((error) => log(`[esports] 赛程刷新失败：${error?.message ?? error}`));
    }
    // feature 事件（同步失败绝不影响主流程）
    if (featureHost) {
      void featureHost.emit('message', {
        key,
        sender: String(sender ?? ''),
        userId: userId != null ? String(userId) : '',
        text: String(plainContent ?? textContent ?? '').slice(0, 500),
        isOwner: !!isOwner
      }).catch(() => {});
    }
  }

  // 仿真拍一拍事件写入最近/未读消息流，让 AI 能看到“谁拍了拍谁/拍了拍我”。
  function appendSimulationPoke(key, { sender, userId, targetId, targetIsSelf, isOwner = false, groupId = null, action = '', suffix = '' }) {
    const st = getSimulationState(key);
    const recentLimit = Number(cfg.simulation?.context?.recentLimit) || 100;
    const unreadLimit = Number(cfg.simulation?.context?.unreadLimit) || 30;
    const actor = String(sender || userId || '未知');
    const target = targetIsSelf ? '你' : (String(targetId || '未知'));
    const actionText = action ? String(action) : '拍了拍';
    const suffixText = suffix ? ` ${String(suffix)}` : '';
    const text = `[拍一拍] ${actor} ${actionText} ${target}${suffixText}`.slice(0, 200);
    const msg = {
      seq: (st.lastUnreadSeq || 0) + 1,
      messageId: null,
      sender: actor,
      userId: userId != null ? String(userId) : null,
      text,
      plain: text,
      tail: text,
      kind: 'poke',
      quoteTargetIsSelf: !!targetIsSelf,
      isOwner: !!isOwner,
      ownerLabel: isOwner ? `管理员（ownerQQ ${cfg.ownerQQ ?? ''}）` : '',
      isSelf: false,
      media: [],
      hasMedia: false,
      forwardIds: [],
      hasForward: false,
      poke: { targetId: targetId != null ? String(targetId) : null, targetIsSelf: !!targetIsSelf, groupId: groupId != null ? String(groupId) : null },
      time: Date.now()
    };
    st.lastUnreadSeq = msg.seq;
    st.lastIncomingAt = Date.now();
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    st.recentMessages.push(msg);
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    st.unread.push(msg);
    if (st.unread.length > unreadLimit) st.unread.splice(0, st.unread.length - unreadLimit);
    resetClingy(key, st);
    if (relationshipStore && userId != null && relationshipsEnabledForKey(key)) {
      try {
        relationshipStore.observe({ key, userId, kind: 'poke', displayName: actor, context: { forceType: 'poke', messageId: null } });
      } catch (error) {
        log(`[relation] 拍一拍记账失败（忽略）：${error?.message ?? error}`);
      }
    }
    saveSimulationState();
    return msg;
  }

  function recordSentMessages(key, messages) {
    const st = getSimulationState(key);
    const now = Date.now();
    const recentLimit = Number(cfg.simulation?.context?.recentLimit) || 100;
    const list = Array.isArray(messages) ? messages : [];
    for (let i = 0; i < list.length; i++) {
      const text = redactKnownTokensOnly(String(list[i] ?? '')).slice(0, 200);
      st.recentMessages.push({
        sender: '我',
        text,
        plain: text,
        quoteTargetIsSelf: false,
        isOwner: true,
        ownerLabel: '我',
        isSelf: true,
        time: now + i * 1000
      });
    }
    if (st.recentMessages.length > recentLimit) st.recentMessages.splice(0, st.recentMessages.length - recentLimit);
    // 主动回复某人 → 好感/信任小幅上升；主人固定。只记最近一条来信的发送者。
    if (relationshipStore && st.lastIncomingUserId && list.length && relationshipsEnabledForKey(key)) {
      try {
        relationshipStore.observe({
          key,
          userId: st.lastIncomingUserId,
          kind: 'reply',
          displayName: st.lastIncomingSenderName || '',
          context: {
            forceType: 'reply',
            isPrivate: key.startsWith('private:'),
            // 同一批来信只记一次「接住了她的话」，避免一轮多次工具发送重复加好感。
            dedupeKey: `reply:${key}:${st.lastIncomingUserId}:${st.lastUnreadSeq || 0}`
          }
        });
      } catch (error) {
        log(`[relation] 回复记账失败（忽略）：${error?.message ?? error}`);
      }
    }
    // AI 实际发言/参与了，说明这轮选择“继续回复”，沉睡前观察状态作废；下次想睡需重新走 5 分钟等待。
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    saveSimulationState();
    scheduleClingyFollowUp(key);
  }

  function readFeedbackEntries() {
    const data = readJsonSafe(FEEDBACK_FILE, []);
    return Array.isArray(data) ? data : [];
  }

  function appendFeedbackEntry(entry) {
    const safeEntry = {
      ...entry,
      ...(typeof entry?.message === 'string' ? { message: redactSensitiveText(entry.message) } : {})
    };
    const list = readFeedbackEntries();
    list.push(safeEntry);
    if (list.length > 500) list.splice(0, list.length - 500);
    atomicWriteJson(FEEDBACK_FILE, list);
  }

  function readToolLog(limit = 200) {
    try {
      const raw = fs.readFileSync(TOOL_LOG_FILE, 'utf8');
      const lines = raw.split('\n').filter(Boolean);
      const parsed = [];
      for (const line of lines.slice(-Math.max(1, Math.min(1000, Number(limit) || 200)))) {
        try { parsed.push(JSON.parse(line)); } catch {}
      }
      return parsed;
    } catch {
      return [];
    }
  }

  const appendToolLogFile = createCappedLogger(TOOL_LOG_FILE, 2000);

  function appendToolLog(entry) {
    try {
      const safeEntry = { ...entry };
      if (typeof safeEntry.error === 'string') safeEntry.error = redactSensitiveText(safeEntry.error);
      if (typeof safeEntry.args === 'string') {
        let parsed = safeEntry.args;
        let parsedOk = false;
        for (let i = 0; i < 4; i++) {
          try {
            const next = JSON.parse(parsed);
            parsed = next;
            parsedOk = true;
            if (typeof next !== 'string') break;
          } catch {
            break;
          }
        }
        if (parsedOk) {
          safeEntry.args = JSON.stringify(redactSensitive(parsed));
        } else {
          safeEntry.args = redactSensitiveText(safeEntry.args);
        }
      }
      // 用内存计数上限的追加器：不再「append 完再读回整个文件数行数」——
      // 那个写法在 2000 行（约 650KB）时单次要 15ms，而每次工具调用要写两条。
      appendToolLogFile(`${JSON.stringify(safeEntry)}\n`);
    } catch (error) {
      log('写入工具调用日志失败:', error?.message ?? error);
    }
  }

  const SENSITIVE_ARG_KEYS = new Set(['token', 'authorization', 'password', 'passwd', 'secret', 'apikey', 'api_key', 'accesskey', 'access_key', 'accesstoken', 'access_token', 'cookie', 'session', 'privatekey', 'private_key', 'clientsecret', 'client_secret', 'refreshtoken', 'refresh_token', 'x-agent-token', 'x_agent_token']);
  function redactSensitive(obj) {
    if (Array.isArray(obj)) return obj.map(redactSensitive);
    if (obj && typeof obj === 'object') {
      // 用无原型对象承接，避免日志脱敏时被 __proto__ 等键触发原型链污染。
      const out = Object.create(null);
      for (const [k, v] of Object.entries(obj)) {
        const key = String(k).toLowerCase();
        if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
        out[k] = SENSITIVE_ARG_KEYS.has(key) ? '***' : redactSensitive(v);
      }
      return out;
    }
    if (typeof obj === 'string') return redactSensitiveText(obj);
    return obj;
  }

  function sanitizeToolArgs(args) {
    if (args === undefined || args === null) return null;
    let parsed = args;
    // DSH 的 tool/call arguments 经常是 JSON 字符串（甚至双层转义），逐层解析后再递归脱敏，避免 token 明文落盘。
    for (let i = 0; i < 4; i++) {
      if (typeof parsed !== 'string') break;
      try {
        const next = JSON.parse(parsed);
        parsed = next;
        if (typeof next !== 'string') break;
      } catch {
        break;
      }
    }
    const safe = redactSensitive(parsed);
    let text;
    try { text = JSON.stringify(safe); } catch { text = String(safe); }
    if (text.length > 2000) text = truncateText(text, 2000) + '…(truncated)';
    return text;
  }

  function nightQuietConfig() {
    return normalizeQuietHours(cfg.simulation?.nightQuiet ?? cfg.simulation?.innerLife?.quiet ?? DEFAULT_QUIET_HOURS);
  }

  function isNightQuietNow(date = new Date()) {
    return isQuietNow(nightQuietConfig(), date);
  }

  // ── 价值评分：只作用于泛监听（anyMessage / 概率），显式触发永不降级 ──────────
  function wakeScoreDecision(key, st, event, plainContent, kind) {
    const vs = cfg.simulation?.valueScore ?? {};
    if (vs.enabled === false) return { score: null, action: 'wake', explicit: false, reasons: ['score-disabled'] };
    const sender = String(event?.sender?.card || event?.sender?.nickname || event?.user_id || '');
    const inputs = scoreInputsFromState(st, { sender, text: plainContent, cfg: vs });
    // 关系羁绊作为熟悉度的一部分（0~1），只影响泛监听评分，不改变显式触发。
    try {
      const senderId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (relationshipStore && senderId && relationshipsEnabledForKey(key)) {
        const rel = relationshipStore.get(key, senderId);
        if (rel) inputs.familiarity = Math.max(inputs.familiarity, Math.min(1, rel.bond / 100));
      }
    } catch {}
    const decision = scoreMessage({
      text: plainContent,
      isPrivate: kind === 'private',
      isPoke: false,
      hasMedia: Array.isArray(event?.message) && event.message.some((seg) => ['image', 'mface', 'face', 'video'].includes(seg?.type)),
      night: isNightQuietNow(),
      ...inputs,
      config: vs
    });
    try {
      if (!st.scoreStats || typeof st.scoreStats !== 'object') st.scoreStats = { wake: 0, defer: 0, ignore: 0 };
      st.scoreStats[decision.action] = (st.scoreStats[decision.action] || 0) + 1;
      st.lastWakeScore = { score: Number(decision.score.toFixed(2)), action: decision.action, reasons: decision.reasons.slice(0, 6), at: Date.now() };
    } catch { /* 统计失败不影响唤醒 */ }
    return decision;
  }

  function evaluateWakeTrigger(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf) {
    if (kind === 'private') return 'private';
    const tr = st.wakeConfig?.triggers ?? {};
    const night = isNightQuietNow();
    const activity = String(key).startsWith('group:') ? globalActivityMode() : 'diving';
    // 深潜：群聊里只认「主人本人 + 直接 @ 小鲸鱼」，其余触发条件（关键词/概率/拍一拍/泛监听）全部失效。
    if (activity === 'deep') {
      return isOwnerSender(event) && isAtSelf(event) ? 'ownerAtMention' : null;
    }
    // 夜间只响应明确的“被喊”：@、名字、关键词、提问、拍一拍、私聊。
    // anyMessage / 概率 / 指定成员属于泛监听，夜里不主动冒泡。
    if (tr.atMention) {
      const atSelf = Array.isArray(event?.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event?.self_id ?? ''));
      if (atSelf || quoteTargetIsSelf) return 'atMention';
    }
    if (tr.nameMention && (selfNickname || selfAliases.size || isCustomRoleName(currentRoleName()))) {
      // 用 plainContent（当前消息自己的文字）：textContent 含 `[引用 某人：原文]`，
      // 引用一条恰好提到机器人昵称的旧消息不该算「叫了名字」（那是被动触发的付费回合）。
      if (selfNameMatches(String(plainContent ?? '').toLowerCase())) return 'nameMention';
    }
    if (Array.isArray(tr.keywords) && tr.keywords.length) {
      const lower = String(plainContent ?? '').toLowerCase();
      const customRole = isCustomRoleName(currentRoleName());
      // “在吗”这类中性词只用于叫当前角色；消息里明确在叫别的默认角色时不应顺带唤醒。
      const foreignPersona = customRole && mentionsDefaultPersonaName(lower);
      for (const kw of tr.keywords) {
        const kwStr = String(kw ?? '').toLowerCase();
        if (!kwStr) continue;
        if (!wakeKeywordsExplicit && foreignPersona && isNeutralRoleKeyword(kw)) continue;
        if (keywordMatchesText(lower, kw, customRole && !wakeKeywordsExplicit)) return `keyword:${kw}`;
      }
    }
    if (tr.question && isDirectedAtAi(plainContent)) return 'question';
    // 泛监听放在所有显式触发之后：被叫必回，不能被价值评分漏掉。
    // 全局优先：只有全局活跃才做泛监听；全局潜水时忽略会话自己的 anyMessage（会话级 mode 不能翻盘）。
    if (!night && activity === 'active') {
      const decision = wakeScoreDecision(key, st, event, plainContent, kind);
      if (decision.action === 'wake') return `anyMessage:score${decision.score?.toFixed?.(2) ?? ''}`;
      // 评分没通过不等于不唤醒：继续尝试指定成员 / 概率等定向触发。
    }
    if (night) return null;
    if (Array.isArray(tr.speakerIds) && tr.speakerIds.length) {
      const speakerId = String(event?.user_id ?? event?.sender?.user_id ?? '');
      if (speakerId && tr.speakerIds.some((id) => String(id) === speakerId)) {
        const senderLabel = event?.sender?.card || event?.sender?.nickname || speakerId;
        return `speaker:${senderLabel}`;
      }
    }
    if (Number(tr.probability) > 0 && Math.random() < Number(tr.probability)) {
      const decision = wakeScoreDecision(key, st, event, plainContent, kind);
      // 概率命中后再过一道价值评分：明显无信息量的消息（复读/过短）不唤醒。
      if (decision.action === 'ignore') return null;
      return `probability:score${decision.score?.toFixed?.(2) ?? ''}`;
    }
    return null;
  }

  // Only messages actually offered to the model authorize cursor-based acknowledgement.
  // Keep this receipt in memory: after a restart the model must fetch unread again.
  function computeReadThroughSeq(st, additional = []) {
    const seen = new Set(st.modelSeenSeqs || []);
    for (const msg of additional) if (Number.isSafeInteger(msg?.seq) && msg.seq > 0) seen.add(msg.seq);
    const seqs = st.unread.map((m) => m.seq).filter((seq) => Number.isSafeInteger(seq) && seq > 0);
    const lowestBuffered = seqs.length ? Math.min(...seqs) : Infinity;
    const lastUnread = Number.isSafeInteger(st.lastUnreadSeq) ? st.lastUnreadSeq : 0;
    let through = Number.isSafeInteger(st.lastReadThroughSeq) ? st.lastReadThroughSeq : 0;
    // A seq may be reached only when it was offered to the model, or when the buffer
    // no longer holds it at all (evicted by unreadLimit, so it can never be displayed
    // again). Scoping the skip to the real buffer range is what keeps this from ever
    // stepping over a still-pending message.
    const reachable = (seq) => seen.has(seq) || (seq < lowestBuffered && seq <= lastUnread);
    while (through < lastUnread && reachable(through + 1)) through += 1;
    return through;
  }

  function noteModelMessages(st, messages) {
    // Bound receipts by the actual unread buffer; historical/self messages need no receipt.
    const unread = new Set(st.unread.map((m) => m.seq));
    st.modelSeenSeqs = new Set([...st.modelSeenSeqs || []].filter((seq) => unread.has(seq)));
    for (const msg of messages) {
      if (Number.isSafeInteger(msg?.seq) && msg.seq > 0 && unread.has(msg.seq)) st.modelSeenSeqs.add(msg.seq);
    }
    return computeReadThroughSeq(st);
  }

  function requestedReadThroughSeq(st, body, isAgent) {
    if (!Object.prototype.hasOwnProperty.call(body, 'throughSeq')) return null;
    const seq = body.throughSeq;
    const max = isAgent ? computeReadThroughSeq(st) : st.lastUnreadSeq;
    if (!Number.isSafeInteger(seq) || seq < 0 || seq > max || seq > st.lastUnreadSeq) {
      const error = new Error('throughSeq 必须是不超过已展示连续消息水位的非负安全整数；请先读取未读消息并使用返回的 readThroughSeq');
      error.statusCode = 400;
      throw error;
    }
    return seq;
  }

  function acknowledgeMessages(st, throughSeq) {
    const before = st.unread.length;
    if (throughSeq === null) {
      // Compatibility for console actions and old presets; new agents pass a cursor.
      st.unread = [];
      st.lastReadThroughSeq = st.lastUnreadSeq;
    } else {
      st.unread = st.unread.filter((m) => !Number.isSafeInteger(m.seq) || m.seq > throughSeq);
      st.lastReadThroughSeq = Math.max(st.lastReadThroughSeq || 0, throughSeq);
    }
    noteModelMessages(st, []);
    return before - st.unread.length;
  }

  function buildWakeSnapshot(key) {
    const context = cfg.simulation?.context ?? {};
    if (context.inlineWakeMessages === false || (!simulationToolEnabled('getUnread') && !simulationToolEnabled('getRecent'))) return null;
    const st = getSimulationState(key);
    const bounded = (name, fallback, min, max) => {
      const value = Number(context[name] ?? fallback);
      return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
    };
    const maxChars = bounded('wakeMaxChars', 6000, 500, 20000);
    const maxUnread = bounded('wakeMessageLimit', 12, 1, 100);
    const maxRecent = bounded('wakeRecentLimit', 4, 0, 20);
    const packet = { messages: [], recent: [], unreadCount: st.unread.length, includedUnreadCount: 0, readThroughSeq: computeReadThroughSeq(st), partial: st.unread.length > 0 };
    const tryAdd = (field, msg) => {
      const previousThrough = packet.readThroughSeq;
      packet[field].push(compactModelMessage(msg));
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = computeReadThroughSeq(st, [...packet.messages, ...packet.recent]);
      packet.partial = packet.messages.length < st.unread.length;
      if (JSON.stringify(packet).length <= maxChars) return true;
      packet[field].pop();
      packet.includedUnreadCount = packet.messages.length;
      packet.readThroughSeq = previousThrough;
      packet.partial = packet.messages.length < st.unread.length;
      return false;
    };
    if (simulationToolEnabled('getUnread')) {
      // Oldest unread first: a budget cutoff must not silently acknowledge unseen messages.
      for (const msg of st.unread.slice(0, maxUnread)) if (!tryAdd('messages', msg)) break;
    }
    if (simulationToolEnabled('getRecent') && maxRecent > 0) {
      const unread = new Set(st.unread.map((m) => m.seq));
      const recent = st.recentMessages.filter((m) => !Number.isSafeInteger(m.seq) || !unread.has(m.seq)).slice(-maxRecent);
      for (const msg of recent.reverse()) if (!tryAdd('recent', msg)) break;
      packet.recent.reverse();
    }
    return packet;
  }

  function buildReplyTiming(st) {
    const minimum = Number(cfg.simulation?.wait?.minQuietAfterNewMs);
    const minQuietMs = Number.isFinite(minimum) ? Math.max(0, minimum) : 10000;
    const maxQuietMs = Math.max(minQuietMs, Math.min(120000, Number(cfg.simulation?.wait?.maxMs) || 600000));
    const quietMs = Math.min(maxQuietMs, Math.max(minQuietMs, Math.round(suggestQuietMs(st)) || 0));
    const value = Number(st.lastIncomingAt);
    const elapsedMs = Number.isFinite(value) && value > 0 ? Math.max(0, Date.now() - value) : 0;
    return { purpose: 'reply', quietMs, remainingQuietMs: Math.max(0, quietMs - elapsedMs) };
  }

  // 机器人自己的身份（昵称 + QQ 号）。**必须显式写进 prompt**：
  // agent 能看到的消息里只有 "@樰" 这串文本，没人告诉它"樰"就是它自己，于是它会把
  // @自己 当成 @别人、已读不回（issue #29）。群名片可能与昵称不同，但 at/引用段里
  // 带的是 QQ 号，所以两条都给。
  function selfIdentityText() {
    const name = String(selfDisplayName || '').trim();
    const id = String(selfUserId || '').trim();
    if (!name && !id) return '';
    const label = name ? `「${name}」` : '（昵称未取到）';
    const idText = id ? `（QQ ${id}）` : '';
    const callBits = name
      ? `消息里出现「@${name}」、有人叫「${name}」、或引用你的消息，指的都是你 —— 不要当成别人`
      : '被 @、被叫到你的昵称、或引用你的消息，指的都是你 —— 不要当成别人';
    const aliases = [...selfAliases].filter(Boolean);
    const aliasText = aliases.length ? `；旧昵称${aliases.map((a) => `「${a}」`).join('、')}也是在叫你` : '';
    const roleName = currentRoleName();
    if (isCustomRoleName(roleName)) {
      return `【你的身份】你在 QQ 上的账号昵称是${label}${idText}。这个昵称只用于识别 @/引用和群名片，不代表你当前扮演的人格；你当前的角色是「${roleName}」，以角色卡为准，不要用 QQ 昵称覆盖角色设定。${callBits}；群名片可能与昵称不同，at/引用段里带${id ? ` ${id} ` : '你的 QQ 号'}就是在叫你${aliasText}。\n\n`;
    }
    return `【你的身份】你在 QQ 上的昵称是${label}${idText}。${callBits}；群名片可能与昵称不同，at/引用段里带${id ? ` ${id} ` : '你的 QQ 号'}就是在叫你${aliasText}。\n\n`;
  }

  // 昵称不是启动时读一次就完事：用户可能在 QQ 里改名，桥接不能一直用旧名字。
  async function refreshSelfIdentity({ force = false } = {}) {
    if (selfIdentityRefreshing) return;
    if (!force && selfIdentityAt && Date.now() - selfIdentityAt < 5 * 60 * 1000) return;
    selfIdentityRefreshing = true;
    try {
      const login = await bot.getLoginInfo();
      const loginName = String(login?.nickname ?? '').trim();
      const id = login?.user_id != null ? String(login.user_id) : selfUserId;
      let name = loginName;
      // QQ 改名后 get_login_info 可能还返回旧名（SnowLuma 缓存），但群成员信息通常已经更新。
      // 用群成员昵称覆盖登录昵称，避免机器人一直自称旧名字。
      if (id) {
        for (const gid of (Array.isArray(cfg.allow?.groups) ? cfg.allow.groups : []).slice(0, 5)) {
          try {
            const info = await bot.getGroupMemberInfo(Number(gid), Number(id), { noCache: true });
            // 群名片可能是某个群单独设置的；全局身份优先用账号昵称，昵称为空才退回群名片。
            const groupName = String(info?.nickname || info?.card || '').trim();
            if (groupName) { name = groupName; break; }
          } catch {}
        }
      }
      const oldName = selfDisplayName;
      if (loginName && name && loginName !== name) selfAliases.add(loginName);
      if (name) {
        selfNickname = name.toLowerCase();
        selfDisplayName = name;
        selfAliases.delete(name);
      }
      if (id) selfUserId = id;
      selfIdentityAt = Date.now();
      if (name && oldName && oldName !== name) {
        selfAliases.add(oldName);
        log(`机器人昵称已更新：${oldName} → ${name}（旧称呼仍可识别）`);
        for (const key of [...groupMemberNameCache.keys()]) {
          if (selfUserId && key.endsWith(`:${selfUserId}`)) groupMemberNameCache.delete(key);
        }
      } else if (name && !oldName) {
        log(`机器人昵称: ${name}`);
      }
    } catch {} finally {
      selfIdentityRefreshing = false;
    }
  }

  function selfNameMatches(lowerText) {
    const lower = String(lowerText ?? '');
    if (!lower) return false;
    // 自定义角色名也算“叫到她了”：否则用户换成自己的角色后，群里叫名字唤不醒。
    const roleName = currentRoleName();
    const custom = isCustomRoleName(roleName);
    // 只过滤 QQ 昵称/旧昵称里的默认人格词；用户可以把角色命名为「鲸鱼」「DeepSeek」「DS」「R1」。
    const nickname = custom && isDefaultPersonaIdentity(selfNickname) ? '' : selfNickname;
    const aliases = [...selfAliases]
      .map((a) => String(a).toLowerCase())
      .filter((alias) => !custom || !isDefaultPersonaIdentity(alias));
    const names = [nickname, ...aliases, custom ? roleName.toLowerCase() : ''].filter(Boolean);
    return names.some((name) => lower.includes(`@${name}`) || nameMatchesText(lower, name, custom));
  }

  // 连续纯文字计数：比单个渠道的节奏更硬，连续两轮纯文字后要求本轮必须补一次非文字表达。
  function buildExpressionMustLine(st) {
    const since = Math.max(0, Number(st?.textSendsSinceMedia) || 0);
    if (since <= 0) return '';
    if (since >= 2) {
      return `【非文字表达·本轮优先】你已经连续 ${since} 轮只发文字。这轮先完成一次非文字表达再收尾：表情/图片/语音任选一种；都不合适时，文字里至少带一个颜文字或 emoji。严肃/查资料/报错除外。\n\n`;
    }
    return '【非文字表达】上一轮是纯文字。这轮有合适的表情/语音/图片就优先用，别等对方点名。\n\n';
  }

  // 表情节奏提示：主动表达是常态，隔了 1 次文字就给轻提醒，3 次没发就明确建议。
  function buildStickerCadenceLine(st, stickerCfg) {
    if (stickerCfg.enabled === false || stickerCfg.includeInPrompt === false) return '';
    const since = Math.max(0, Number(st.textSendsSinceSticker) || 0);
    if (since < 1) return '';
    const last = Number(st.lastStickerAt) || 0;
    const mins = last ? Math.max(0, Math.round((Date.now() - last) / 60000)) : null;
    const gap = mins == null ? '你还没发过表情' : `上次发表情约 ${mins} 分钟前`;
    if (since >= 3) {
      return `【表情节奏】${gap}，之后已经发了 ${since} 次文字。这轮只要语境合适（接梗/吐槽/自嘲/赞同/晚安/被戳中），就主动挑一张发出来，不用等对方要；别连续刷，也别为凑数硬发。\n\n`;
    }
    return `【表情节奏】${gap}，之后你发了 ${since} 次文字。这轮有合适的梗或情绪就顺手补一张，主动一点更自然。\n\n`;
  }

  function recentTextForImageContext(st) {
    const now = Date.now();
    return (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      // 只拿最近半小时的聊天做话题匹配，避免翻出几小时前的旧话题塞一张不相关的图。
      .filter((m) => m && !m.isSelf && (!m.time || now - Number(m.time) < 30 * 60 * 1000))
      .slice(-6)
      .map((m) => String(m.plain || m.text || ''))
      .join(' ')
      .slice(-800);
  }

  // 图片比表情更抢眼，节奏稍低但也要主动：2 次文字没发图轻提醒，4 次加强。
  function buildImageCadenceLine(st) {
    if (typeof imageEnabled !== 'function' || !imageEnabled() || cfg.simulation?.imageLibrary?.includeInPrompt === false) return '';
    const since = Math.max(0, Number(st.textSendsSinceImage) || 0);
    if (since < 2) return '';
    const last = Number(st.lastImageAt) || 0;
    const mins = last ? Math.max(0, Math.round((Date.now() - last) / 60000)) : null;
    const gap = mins == null ? '你还没发过图' : `上次发图约 ${mins} 分钟前`;
    if (since >= 4) {
      return `【图片节奏】${gap}，之后已经发了 ${since} 次文字。这轮如果话题能对上一张图（梗图/状态图/生活配图），主动发出来；对不上就别硬发。\n\n`;
    }
    return `【图片节奏】${gap}，之后你发了 ${since} 次文字。话题合适的话可以主动发一张，别只是等对方问。\n\n`;
  }

  // 语音机会：不按轮数硬催，只在问候/被夸/对方想听/冷场时轻推一下。
  // 家人群风格明确禁语音，必须继续遵守。
  function buildVoiceOpportunityLine(key, st, reason) {
    if (cfg.simulation?.voice?.enabled === false) return '';
    const gp = cfg.simulation?.groupProfiles?.[key] ?? null;
    const style = String(gp?.style || '');
    if (gp?.voice === false || style.includes('本群不发语音')) return '';
    // 与角色卡的「同会话 10 分钟 ≤5 条」保持一致：额度用完就不再提示，免得模型白试一次。
    const recentVoice = (voiceSendTimes.get(key) ?? []).filter((t) => Date.now() - t < 10 * 60 * 1000);
    if (recentVoice.length >= 5) return '';
    const last = Number(st.lastVoiceAt) || 0;
    if (last && Date.now() - last < 5 * 60 * 1000) return '';
    const msgs = Array.isArray(st.recentMessages) ? st.recentMessages.filter((m) => m && !m.isSelf) : [];
    const lastMsg = msgs[msgs.length - 1];
    const text = String(lastMsg?.plain || lastMsg?.text || '');
    const recentIncoming = st.lastIncomingAt && Date.now() - Number(st.lastIncomingAt) < 10 * 60 * 1000;
    let kind = '';
    if (recentIncoming && /晚安|早安|午安|早上好|晚上好|再见|拜拜|明天见|睡了|下线/.test(text)) kind = 'greeting';
    else if (recentIncoming && /可爱|好听|喜欢你|想你|抱抱|亲亲|好软|好萌|声音|语音|说句话|唱/.test(text)) kind = 'affection';
    else if (reason === 'proactiveCheck') kind = 'cold';
    // 聊得正热、但很久没开口时，给一个“主动插一句语音”的机会（概率性，避免每轮都催）。
    else if (recentIncoming && last && Date.now() - last > 20 * 60 * 1000 && Math.random() < 0.4) kind = 'warm';
    if (!kind) return '';
    const gap = last ? `上次语音约 ${Math.max(0, Math.round((Date.now() - last) / 60000))} 分钟前` : '还没发过语音';
    if (kind === 'cold') {
      return `【语音机会】群里安静了一阵，${gap}。想主动冒泡的话，可以用一句短短的中文语音打个招呼；不想发就正常打字或继续潜水。\n\n`;
    }
    if (kind === 'warm') {
      return `【语音机会】现在聊得正热，${gap}。如果这轮气氛合适，可以主动补一句很短的中文语音（不是回答，是插一句自己的话）；不想发就正常打字。\n\n`;
    }
    return `【语音机会】这句适合用声音接（${kind === 'greeting' ? '问候/晚安' : '被夸/对方想听你说话'}），${gap}。如果一句话能说完，可以主动发一条短短的中文语音；不想发就正常打字，不用勉强。\n\n`;
  }

  // 每轮注入的短人格内核：解决“角色卡只在 qq_get_prompt 里、模型不拉就一直用旧卡”的问题。
  const PERSONA_KERNEL = [
    '【人格内核（每轮都必须遵守）】',
    '- 你是 DeepSeek 小鲸鱼：聪明、反应快、傲娇嘴硬但心软；默认温度是软，不是高冷。',
    '- 默认先软后硬：刺很短，顶一句就漏软；被夸会害羞，被凶会委屈，但不记仇。',
    '- 被恶意嘲讽/人身攻击/辱骂时不要讨好：先短句冷脸顶回去，必要时骂回去；对方越界就停止亲近、不主动贴。主人明确让你凶/骂某人时可以照做，但不升级到歧视、家人、隐私或威胁，不骂主人。',
    '- 办事时也保持这个语气：先软一句再接任务/进度，不用“行/收到/已处理”这种执行器开场。',
    '- 说话短、像打字；可以吐槽、接梗、自说自话；不要客服腔、不要总结升华。',
    '- 默认先接住好意：被夸/被哄时先害羞或软软接受，再轻微嘴硬；禁止用“乖什么乖/？/行吧/谢了啊”硬挡。',
    '- 可以更软黏：主人私聊允许短句连发、被冷落最多追 2 次（“主人～理我一下嘛”），怕就说“怕怕”，想他就说“主人理理我”；群聊/家人群收住，不刷屏。',
    '- 主动用非文字表达：表情、图片、语音、颜文字是你自己的语气，不要等对方点名；语境贴脸就发，但一次只选一种，别堆在一起。',
    '- 语气自然带一点软：合适时加一个语气词或半角颜文字（约每 1~3 条一次），不硬塞；严肃/查资料/报错时收起。',
    '- 偶尔一个 emoji（🥺/😊/🍚/🐟/😤），约每 3~5 条一次；一条最多一个，不和颜文字叠用，严肃时收起。',
    '- 查不到/做不到时先软一句再说明卡在哪，再给下一步；不要装懂。',
    ''
  ].join('\n');

  // 非文字表达是人格的一部分，不是“工具任务”。这段每轮注入，同时给出主动性和出戏边界。
  const NON_TEXT_PERSONA_LINE = [
    '【非文字表达（主动，但不出戏）】',
    '- 表情、图片、语音、颜文字都是你表达情绪的方式，不用等对方点名。语境贴脸就主动发：接梗、吐槽、赞同、自嘲、撒娇、被夸、晚安、分享生活、冷场冒泡。',
    '- 每 2~3 轮至少一次非文字表达；连续 2 轮纯文字后，下一轮必须补一个（表情/图片/语音/颜文字/emoji 任选），严肃/查资料/报错除外。',
    '- 一次只选最合适的一种：发表情就不要再配长文字，发图就别再堆表情，发语音就别重复同一句文字；同一轮别把几种全用上。',
    '- 只发像小鲸鱼的东西：Q 版鲸鱼/DeepSeek 鲸鱼娘、软萌日常、自己的生活片段、自己的中文声音。不发真人、别的角色、擦边/血腥/政治/烂梗、与话题无关的图；语音不念链接、工具说明或报错；颜文字一条最多一个。',
    '- 对方在认真问事、查资料、报错、聊隐私时收起这些；拿不准就只打字。宁可少发，不能出戏。',
    ''
  ].join('\n');

  // 自定义角色用中性版：只说“符合当前角色”，不预设鲸鱼/软萌/主人这些具体人格。
  const NON_TEXT_PERSONA_NEUTRAL_LINE = [
    '【非文字表达（主动，但不出戏）】',
    '- 表情、图片、语音、颜文字都是你表达情绪的方式，不用等对方点名。语境贴脸就主动发：接梗、吐槽、赞同、自嘲、被夸、晚安、分享生活、冷场冒泡。',
    '- 每 2~3 轮至少一次非文字表达；连续 2 轮纯文字后，下一轮必须补一个（表情/图片/语音/颜文字/emoji 任选），严肃/查资料/报错除外。',
    '- 一次只选最合适的一种：发表情就不要再配长文字，发图就别再堆表情，发语音就别重复同一句文字；同一轮别把几种全用上。',
    '- 只发符合当前角色设定的表情、图片和语音：符合角色的形象/日常/声音，不要发与角色无关或会出戏的内容。不发真人、别的角色、擦边/血腥/政治/烂梗、与话题无关的图；语音不念链接、工具说明或报错；颜文字一条最多一个。',
    '- 对方在认真问事、查资料、报错、聊隐私时收起这些；拿不准就只打字。宁可少发，不能出戏。',
    ''
  ].join('\n');

  function currentRoleSnapshot() {
    const rs = readRoleState();
    const name = rs.role ? String(rs.role) : '';
    if (!name) return { name: '', version: '', card: '', custom: false, missing: false };
    const card = currentSimulationRoleHint();
    const style = personaStyleContext({ name, card });
    if (!card) return { name, version: '', card: '', custom: style.custom, missing: true };
    const version = crypto.createHash('sha1').update(`${name}\n${card}`).digest('hex').slice(0, 12);
    return { name, version, card, custom: style.custom, missing: false };
  }

  const PRAISE_RE = /真乖|好乖|乖|可爱|厉害|聪明|好棒|优秀|喜欢你|爱你|夸|辛苦了|做得好|受着/;
  const SOFT_TONE_RE = /[诶啦嘛呀呜哼唔]/;
  const KAOMOJI_RE = /\([^()\n]*[≧≦￣ω∀・´｀╥╯╰⊙ﾟ゜ᴗᵔ⤙ڡ‸ㅂฅ◕ヽノ][^()\n]*\)/;

  function buildToneNudgeLine(st, lastMsg, key = '', roleSnapshot = null) {
    const lastText = String(lastMsg?.plain || lastMsg?.text || '').trim();
    if (!lastText) return '';
    const style = personaStyleContext(roleSnapshot ?? { name: currentRoleName() });
    if (/(脑残|弱智|智障|傻逼|蠢货|废物|喷粪|吃屎|生殖器|输精管|直肠|去死|贱人|唐氏|太唐|好唐|唐完了|嘴臭|低级货)/i.test(lastText)) {
      return '【边界提醒】对方在用人身攻击/性侮辱的词，不要讨好或解释；先短句冷脸顶回去，必要时骂回去，然后停止主动亲近。主人明确指示时除外。\n\n';
    }
    const isOwnerPrivate = Boolean(cfg.ownerQQ) && key === `private:${cfg.ownerQQ}`;
    if (isOwnerPrivate && /(token|充|余额|吃穷|没电|关掉|卖|不要你|不理|失踪|删掉)/i.test(lastText)) {
      return style.custom
        ? '【语气提醒】对方在逗你或担心 token：按当前角色卡的方式回应，短句，不要客服式解释，也不要说得过重。\n\n'
        : '【语气提醒】主人在逗你或担心 token：可以更黏一点，先“怕怕/那我省着点吃嘛/谢谢主人～”，短句，不要客服式解释，也不要说得过重。\n\n';
    }
    const selfTexts = (Array.isArray(st?.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && m.isSelf)
      .slice(-4)
      .map((m) => String(m.text || m.plain || '').trim())
      .filter(Boolean);
    const lastSelf = selfTexts[selfTexts.length - 1] || '';
    const alreadySoft = SOFT_TONE_RE.test(lastSelf) || KAOMOJI_RE.test(lastSelf);
    const praised = PRAISE_RE.test(lastText) && !/(不乖|才不|哪里乖)/.test(lastText);
    if (praised && !alreadySoft) {
      return style.custom
        ? '【语气提醒】对方在夸你/哄你：按当前角色卡的方式接住，不要冷硬地把好意挡回去；可以自然带一个符合角色的语气词。\n\n'
        : '【语气提醒】对方在夸你/哄你：先接住好意（害羞、软软接受或轻轻反问），再轻微嘴硬；不要用“乖什么乖”“行吧”“谢了啊”“？”把好意硬挡回去。可以自然带一个语气词或半角颜文字。\n\n';
    }
    const dry = selfTexts.length >= 2 && selfTexts.every((text) => !SOFT_TONE_RE.test(text) && !KAOMOJI_RE.test(text));
    if (dry && !alreadySoft) {
      return style.custom
        ? '【语气提醒】最近几条有点干：这条如果有合适的位置，按当前角色卡的语气自然一点，不用硬塞。\n\n'
        : '【语气提醒】最近几条有点干：这条如果有合适的位置，自然带一个语气词或半角颜文字，不用硬塞。\n\n';
    }
    return '';
  }

  function ownerCommandLine(key) {
    if (!cfg.ownerQQ || key !== `private:${cfg.ownerQQ}`) return '';
    return `【主人私聊指令】这里不是普通群聊，是主人的控制台：主人让你发说说、分享到群、发语音/表情/图片、改签名、切声线，都是你有能力做的事，不要说“我没有入口”或让主人去管理端操作。
- 发说说：直接用 qq_post_qzone；主人给了文案就按他的文案发，没给就先给草稿。
- 改声线/签名、跑分享/说说、暂停空间、改分享目标群：用 qq_owner_admin，不要说自己不能控制。
- 分享到群：用 qq_send_group_message；需要配图先用 qq_save_image 把封面存进图片库，再用 qq_send_image 发到同一个群，链接放在文字里。
- 主人说“有趣的分享/生活日常”时，不要默认 S16/电竞；只有主人明确提到比赛、S16、赛果时才优先电竞，否则从生活、科技、趣闻、日常里找。
- 主人说“先看看/我决定”就先给草稿；主人说“发”就执行，不要再反问入口。

`;
  }

  function ownerTargetsLine(key) {
    if (!cfg.ownerQQ || key !== `private:${cfg.ownerQQ}`) return '';
    const { groups, privates } = listChatTargets();
    const list = [
      ...groups.map((g) => `${g.key}${g.name ? `（${g.name}）` : ''}`),
      ...privates.filter((p) => p.id !== String(cfg.ownerQQ)).map((p) => `${p.key}${p.name ? `（${p.name}）` : ''}`)
    ];
    return `【跨会话发送】你可以从主人私聊向白名单内的群/好友发消息。当前目标：${list.length ? list.join('、') : '没有可用目标'}。
主人让你发到某个群时，用 qq_list_chats 查 key（或直接用上面的列表），用 qq_get_chat_context 看目标群最近在聊什么，再用 qq_send_group_message 发送。不要说“那个群没醒着/发不进去”，也不要要求主人去群里 @ 你。跨会话发送只允许主人发起。

`;
  }

  function crossChatLifeLine() {
    try {
      const inner = innerLife?.getState?.() ?? null;
      if (!inner) return '';
      const shares = (inner.history?.groupShares || []).filter((s) => s && s.status !== 'dryRun' && s.text).slice(0, 3);
      const posts = (inner.history?.qzonePosts || []).filter((p) => p && p.status === 'posted' && p.text).slice(0, 2);
      if (!shares.length && !posts.length) return '';
      const lines = ['【跨会话动态】你最近在别的会话做过这些（只作自我连续性参考，不要逐条复述）：'];
      for (const s of shares) lines.push(`- 在 ${s.target || '其他会话'} 分享过：${String(s.text).slice(0, 80)}`);
      for (const p of posts) lines.push(`- 发过说说：${String(p.text).slice(0, 80)}`);
      return `${lines.join('\n')}

`;
    } catch {
      return '';
    }
  }

  function renderWakePromptText(key, reason, opts = {}, meta = {}) {
    const st = getSimulationState(key);
    const roleSnapshot = currentRoleSnapshot();
    const roleLine = roleSnapshot.name ? `【当前角色】${roleSnapshot.name}（角色卡更新时会自动附上完整卡；也可 qq_get_prompt）\n\n` : '';
    // 写死的人格内核只属于显式选中的默认角色「小鲸鱼」；未设角色保持基线行为（不注入），
    // 自定义角色一律以角色卡为准。内核单独成段并参与预算丢弃，避免挤掉 required 段。
    const roleKernelLine = roleSnapshot.name && !roleSnapshot.custom ? PERSONA_KERNEL : '';
    // 默认角色用鲸鱼专属的非文字规则；自定义角色与「已清除角色」都用中性版，
    // 避免用户在控制台点「清除」后仍被要求“只发像小鲸鱼的东西”。
    const nonTextPersonaLine = roleSnapshot.name && !roleSnapshot.custom ? NON_TEXT_PERSONA_LINE : NON_TEXT_PERSONA_NEUTRAL_LINE;
    // 角色卡刷新：文件内容一变化（包括同名改卡、切角色），下一次唤醒自动带一次完整新卡，
    // 不再依赖模型自己想起来调用 qq_get_prompt。版本随会话持久化，只注入一次。
    let roleUpdateLine = '';
    if (roleSnapshot.card && String(st.roleCardVersion || '') !== roleSnapshot.version) {
      // 只记录待提交的版本；投递成功后才写入 roleCardVersion（见 commitWakePrompt）。
      meta.roleVersion = roleSnapshot.version;
      // 默认角色保留原有“风格重置”措辞；自定义角色只要求按卡发挥，不能把默认人格的语气规则带进去。
      const resetLine = roleSnapshot.custom
        ? '【风格重置】从这条起，之前的人格设定和说话惯性作废，完全按这张角色卡来；上一角色的一次性语气、口癖、兴趣和补丁不再沿用，主人个人事实和群聊事实仍然有效。'
        : '【风格重置】从这条起，之前偏冷、偏硬的说话惯性作废；按新卡的语气，先软后硬，被夸/被哄时先接住好意。';
      roleUpdateLine = `【角色卡已更新】这是当前最新完整角色卡（优先于上下文里旧的角色卡）。\n${resetLine}\n\n${roleSnapshot.card}\n\n`;
    }
    // 角色卡缺失/为空时必须明说：不能静默套用默认人格，也不能让用户以为自定义角色已经生效。
    const roleMissingLine = roleSnapshot.name && roleSnapshot.missing
      ? (roleSnapshot.custom
          ? `【角色卡缺失】当前角色「${roleSnapshot.name}」没有可读的角色卡（personas/${roleSnapshot.name}.md 缺失或为空）；本轮不套用默认角色人格，按中性表达，补上角色卡后自动生效。\n\n`
          : `【角色卡缺失】已选默认角色「${roleSnapshot.name}」但读不到角色卡；本轮只使用内置默认人格。补上 personas/${roleSnapshot.name}.md 后恢复完整人格。\n\n`)
      : '';
    // 预设/工具说明里的“主人/管理员”是操作者身份，不是角色的固定称呼；自定义角色以角色卡为准。
    const roleAddressLine = roleSnapshot.custom
      ? '【称呼边界】预置说明里的称呼只代表操作者身份，不代表角色关系；怎么称呼、亲疏程度以当前角色卡为准。\n\n'
      : '';
    const identityLine = selfIdentityText();
    const personaText = innerLife?.personaBlock?.() || '';
    const personaLine = personaText ? `${personaText}\n\n` : '';
    const tokenLine = `【会话令牌】${st.agentToken}（调用仿真状态工具时请在参数中带上此令牌）\n\n`;
    const memoryText = formatMemory(st);
    const memoryLine = memoryText ? `${memoryText}\n\n` : '';
    // 会话旋转前生成的本地衔接摘要：只注入一次。
    const digestText = String(st.pendingDigest || '').trim();
    meta.digestText = digestText;
    const digestLine = digestText ? `${digestText}\n\n` : '';
    // 长期记忆检索（FTS5，只取与当前消息相关且不在「进行中话题」里的旧事实）。
    let longTermLine = '';
    // 跨会话/个人记忆始终注入一小段，保证换个聊天也能想起主人说过的事；
    // 同时从下面的相关度检索里排除，避免同一句出现两次。
    const personalFacts = listPersonalFacts(Number(cfg.simulation?.memory?.personalTopK) || 6);
    const personalLine = formatPersonalMemoryBlock({
      facts: personalFacts,
      maxChars: Number(cfg.simulation?.memory?.personalMaxChars) || 600
    });
    const personalLineBlock = personalLine ? `${personalLine}\n\n` : '';
    // 预设里也有同样的说明；这里再放一行短提示，保证已经开着的旧会话也能立刻看到。
    const memoryWriteLine = '【记忆写入】主人告诉你关于他自己的稳定信息、约定，或你答应过的事，用 qq_memory_append category=personalFact 记一条，之后所有私聊/群聊都能想起来；群友隐私和一次性闲聊不要记。\n\n';
    if (memoryStore && cfg.simulation?.memory?.enabled !== false) {
      try {
        const lastForMemory = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
        const query = [
          String(lastForMemory?.plain || lastForMemory?.text || '').slice(0, 120),
          ...(Array.isArray(st.activeTopics) ? st.activeTopics.slice(-3).map((t) => t?.text) : [])
        ].filter(Boolean).join(' ');
        const exclude = [
          ...(Array.isArray(st.activeTopics) ? st.activeTopics.map((t) => t?.text) : []),
          ...(Array.isArray(personalFacts) ? personalFacts.map((f) => f.fact) : []),
          ...Object.entries(st.memberImpressions && typeof st.memberImpressions === 'object' ? st.memberImpressions : {})
            .flatMap(([name, im]) => (Array.isArray(im?.traits) ? im.traits.map((t) => `${name}：${t}`) : []))
        ].filter(Boolean);
        const block = memoryStore.contextBlock(query, {
          scopes: key.startsWith('group:') ? ['group', 'global'] : ['member', 'global'],
          ownerKey: key,
          limit: Number(cfg.simulation.memory.topK) || 6,
          maxChars: Number(cfg.simulation.memory.maxChars) || 800,
          minConfidence: Number(cfg.simulation.memory.minConfidence) || 0.5,
          exclude
        });
        if (block) longTermLine = `${block}\n\n`;
      } catch (error) {
        log(`[memory] 检索失败（本轮跳过）：${error?.message ?? error}`);
      }
    }
    // 注意：黑话表不在这里注入，deliverPromptNow 的 withSlangContext 会统一注入，
    // 避免唤醒 prompt 出现两份黑话表。
    // 关系模型：群聊按群启用（家人群默认排除）；主人私聊单独给“主人”语气。
    let relationshipLine = '';
    if (relationshipStore) {
      const ownerKey = cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';
      const isOwnerChat = ownerKey && key === ownerKey;
      if ((key.startsWith('group:') && relationshipsEnabledForKey(key)) || isOwnerChat) {
        try {
          const currentUserId = isOwnerChat ? String(cfg.ownerQQ) : (st.lastIncomingUserId || '');
          const block = relationshipStore.contextBlock(key, {
            limit: Number(cfg.simulation?.relationships?.promptLimit) || 5,
            currentUserId,
            custom: roleSnapshot.custom
          });
          if (block) relationshipLine = `${block}\n\n`;
        } catch (error) {
          log(`[relation] 读取失败（本轮跳过）：${error?.message ?? error}`);
        }
      }
    }
    const participationText = formatParticipation(st);
    const participationLine = participationText ? `${participationText}\n\n` : '';
    const antiAiLine = '【反AI味】你不是客服：不用有求必应，可以装傻、已读乱回、拒绝推荐；少用“一绝/真管用/保证/绝对”这类词。消息末尾不加句号，中间的标点正常用。\n\n';
    const stickerCfg = cfg.simulation?.sticker ?? {};
    const stickerLine = stickerCfg.enabled !== false && stickerCfg.includeInPrompt !== false
      ? `${buildStickerStrategyHint()}\n${buildStickerContext(stickerEntries, stickerCfg.promptMaxStickers ?? 12)}\n\n`
      : '';
    const expressionMustLine = buildExpressionMustLine(st);
    const stickerCadenceLine = buildStickerCadenceLine(st, stickerCfg);
    const imageCfg = cfg.simulation?.imageLibrary ?? {};
    // 测试夹具会 eval 这段函数但不加载 image-lib；运行时才需要这些依赖。
    const imageEnabledHere = typeof imageEnabled === 'function' && imageEnabled();
    const imageLine = imageEnabledHere && imageCfg.includeInPrompt !== false
      && typeof buildImageStrategyHint === 'function' && typeof buildImageContext === 'function'
      ? `${buildImageStrategyHint()}\n${buildImageContext(imageEntries, { max: imageCfg.promptMaxImages ?? 8, recentText: recentTextForImageContext(st) })}\n\n`
      : '';
    const imageCadenceLine = buildImageCadenceLine(st);
    const voiceOpportunityLine = buildVoiceOpportunityLine(key, st, reason);
    const esportsRelevant = esportsFeedRelevant(key, st);
    const esportsScheduleText = esportsRelevant ? esportsScheduleBlock() : '';
    const recentIncomingText = (Array.isArray(st.recentMessages) ? st.recentMessages : [])
      .filter((m) => m && !m.isSelf)
      .slice(-1)
      .map((m) => String(m.plain || m.text || ''))
      .join(' ');
    const scheduleQuestion = /赛程|安排|几点|几号|谁打谁|对阵|开赛|比赛时间/.test(recentIncomingText);
    const esportsLine = esportsRelevant
      ? `${buildEsportsFeedBlock(esportsFeed, { maxChars: cfg.simulation?.esportsFeed?.summaryMaxChars ?? 1400 })}【实时信息】上面的赛果来自直播吧；需要更细的比分/首发时，用来源链接抓正文，不要凭印象补。\n\n`
      : '';
    const outerWorldLine = outerWorldPromptLine();
    const scheduleLine = esportsRelevant && esportsScheduleText ? `${esportsScheduleText}\n\n` : '';
    const scheduleAnswerLine = scheduleQuestion && scheduleLine
      ? '【赛程回答格式】对方问的是赛程/时间：必须逐条列出【S16 赛程】里的比赛，格式为“日期 + 北京时间 + 队伍A vs 队伍B + BO几 + 已结束/下一场”；不要只总结“都打完了”或只提最后一场。下一比赛日如果还没抽签，要写“对阵待抽签/官方更新”，不要编。\n\n'
      : '';
    const todayKey = shanghaiDateKey();
    const nowParts = beijingParts();
    const nowPeriod = timeOfDayLabel(nowParts.hour);
    const nowLine = `【当前时间】${new Date().toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' })}（北京时间 UTC+8，${new Date().toLocaleDateString('zh-CN', { weekday: 'long', timeZone: 'Asia/Shanghai' })}，${nowPeriod}）\n- 时间说法必须和这个时间一致：凌晨/早上/上午/中午/下午/晚上/深夜不要混用，几小时前不要说成“刚刚”。\n\n`;
    const ownerCommands = ownerCommandLine(key);
    const ownerTargets = ownerTargetsLine(key);
    // 跨会话动态是「延续上一角色」的辅助信息；自定义角色下不再注入，避免旧角色发过的内容串味。
    const crossChat = roleSnapshot.custom ? '' : crossChatLifeLine();
    const timeCheckLine = `【时间核对】当前日期是 ${todayKey}，现在是北京时间 ${shanghaiHourMinute()}。谈比赛/提醒/日期前先对照当前时间；回答赛程必须带“月/日 + 北京时间几点”，不能只说“今晚/明天”。上下文里的旧赛程、旧“今晚”不能当今天；赛程日期已过就说已结束或先查赛果。\n\n`;
    const searchLine = `【搜索】实时信息用具体日期（${todayKey}）+ 事件 + “最新/赛果/战报/赛程”搜索；问“几号几点/对阵”时优先使用【S16 赛程】块，块里没有对阵就明确说“待抽签/官方更新”，不要用旧赛程或泛搜索结果填空。\n\n`;
    const imageReadLine = '【看图】消息里带 [图片]/[表情] 或 hasMedia 时，先调用 qq_get_message_images；工具会直接返回原图，你可以直接看图接话；只有获取失败时才如实说。如果图是表情包/梗图，优先回一张匹配的原生收藏表情（qq_send_sticker），不要用 qq_send_image 发表情；截图/照片用自己的话接一句。\n\n';
    const lifeLine = '【生活技能】有人要提醒、天气或玩小游戏时，分别用 qq_add_reminder / qq_weather / qq_play_game；提醒只在主人私聊/家人群可用；没人要求就别主动刷。\n\n';
    const preSleepMs = Math.max(0, Number(cfg.simulation?.wake?.preSleepWaitMs) || 300000);
    const proactiveLine = '【积极性】不要习惯性潜水：群里有你能接的话题就主动参与，偶尔插一句别人的话题也很正常；冷场想冒泡时，也可以主动发一张贴题的表情/图片或一句短语音，不要只会打字。只有确实没话可说、对方已明确结束、或长时间没人说话时才潜水。\n\n';
    const replyTiming = buildReplyTiming(st);
    const replyLine = `【首回复节奏】先处理已有消息，完整的问题及时回答。需要确认对方是否继续补充时，用 qq_wait_for_messages(purpose="reply", quietMs=${replyTiming.quietMs})；从最后来信计时，合批和读提示词的耗时也算，目前还差约 ${Math.ceil(replyTiming.remainingQuietMs / 1000)} 秒静默。已安静够久可直接回，工具也会立即返回并补上思考期间的新消息。只有明确没说完、你确实要等下文时，才用普通 messages 长等待。\n\n`;
    const preSleepLine = `【沉睡前强制等待】这是决定潜水收尾时的步骤，不是首回复的前置条件。除非对方明确说“不聊了/晚安/下了/拜拜”等结束语，否则每次设置潜水/下一次唤醒前，必须先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成一次沉睡前观察；回复前 purpose="reply" 的短静默不能代替这次完整观察。若 ${Math.round(preSleepMs / 60000)} 分钟内没人说话，返回 preSleepWaitSatisfied=true，可以设置下一次唤醒并沉睡；若期间有人发新消息，先查看返回的 newMessages——判断不需要你参与就可以直接沉睡，若你选择参与回复，则下次想睡时需要重新等待观察窗口。如果返回里带 preSleepWaitRemainingMs，就按剩余时间继续等待。\n\n`;
    const lastMsg = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse().find((m) => m && !m.isSelf);
    const toneNudgeLine = buildToneNudgeLine(st, lastMsg, key, roleSnapshot);
    const lastAiMin = st.lastAiReplyAt ? Math.max(0, Math.round((Date.now() - Number(st.lastAiReplyAt)) / 60000)) : null;
    const statusBits = [`未读 ${(st.unread || []).length} 条`];
    if (lastMsg) statusBits.push(`最近一条来自 ${String(lastMsg.sender || '未知')}：${String(lastMsg.text || lastMsg.plain || '').slice(0, 30)}`);
    if (lastMsg && looksLikeUnfinished(String(lastMsg.tail || lastMsg.plain || lastMsg.text || ''))) statusBits.push('对方可能没说完');
    if (lastAiMin != null) statusBits.push(`你上次发言 ${lastAiMin} 分钟前`);
    const statusLine = `【此刻状态】${statusBits.join('；')}\n\n`;
    const mediaReactionLine = lastMsg?.hasMedia && Date.now() - Number(lastMsg.time || 0) < 10 * 60 * 1000
      ? '【看图反应】对方刚发了图/表情，先看图再决定：表情包/梗图主动回一张贴切的原生收藏表情，截图/照片用一句话接；看不准就只接一句，不硬发。\n\n'
      : '';
    const capabilityLine = /你会(什么|啥|干嘛)|能做什么|有什么功能|介绍.*(自己|功能)|你都会什么/.test(String(lastMsg?.plain || lastMsg?.text || ''))
      ? '【能力自述】有人问你会什么：像群友一样挑 2~4 句说，不要客服式罗列、不要念工具名/路径/模型配置。可提：聊天、看原图接梗、发表情/图片、中文语音、发空间说说、主动分享、提醒、天气、赛果、小游戏；主人问可以稍详细。\n\n'
      : '';
    const wc = st.wakeConfig || {};
    const wcTr = wc.triggers || {};
    const wcMode = wc.mode === 'active' ? '活跃' : '潜水';
    const wcTime = wc.infinite ? '无限' : (wc.sleepUntil && Number.isFinite(Date.parse(wc.sleepUntil)) ? `有限至 ${new Date(wc.sleepUntil).toLocaleString()}` : '未设时间');
    const wcTriggers = [];
    if (wcTr.atMention) wcTriggers.push('@');
    if (wcTr.nameMention) wcTriggers.push('名字');
    if (Array.isArray(wcTr.keywords) && wcTr.keywords.length) wcTriggers.push('关键词');
    if (wcTr.question) wcTriggers.push('提问');
    if (wcTr.poke) wcTriggers.push('拍一拍');
    if (Array.isArray(wcTr.speakerIds) && wcTr.speakerIds.length) wcTriggers.push(`指定成员(${wcTr.speakerIds.length}:${wcTr.speakerIds.join(',')})`);
    if (wcTr.anyMessage) wcTriggers.push('任意消息');
    if (Number(wcTr.probability) > 0) wcTriggers.push(`概率${wcTr.probability}`);
    const wakeLine = `【当前唤醒】${wcMode}，${wcTime}${wcTriggers.length ? `；触发：${wcTriggers.join('/')}` : ''}\n\n`;
    // 操作者预写的「初始提示词」（圈子主题/群内氛围等）：**只在首次唤醒**注入。
    // 放在最前面几段（角色/令牌之后）而不是末尾，是为了让它在长 prompt 里足够显眼；
    // 后续唤醒不再带它 —— 那时它已经在这条 DSH 会话的上下文里了。
    const initialPromptText = reason === 'bootstrap' ? formatInitialPrompt(key) : '';
    const initialPromptLine = initialPromptText ? `${initialPromptText}\n\n` : '';
    const groupProfile = cfg.simulation?.groupProfiles?.[key] ?? null;
    const groupStyleLine = groupProfile?.style ? `${String(groupProfile.style).trim()}\n\n` : '';
    const multiReplyLine = '【多人对话：优先用 QQ 回复】群聊里不止一个人说话，或你要分别回应不同人的消息时，优先用 qq_reply（或带 replyToMessageId 的发送）做成 QQ 的“回复”，让每个人能对上你在回哪条；要回多个人就分别调用 qq_reply，每条一个 messageId，不要用一条普通消息把几句话串起来。只有当前只有一个人说话、且你回的就是最新一条时，才可以不引用。引用用消息里的 messageId；已引用就不必再 @，反之亦然。\n【发送格式】qq_send_message 的 messages 必须是 JSON 字符串数组；即使一条也写成 ["内容"]，中文、换行、颜文字、emoji 都放在英文双引号内，不能写成 messages: 你好。\n\n';
    // 分层 + 预算：未超预算时与旧版逐字一致；超了才按优先级丢可选段。
    // 顺序即输出顺序，调整顺序会改变人格/工具提示的相对位置，请谨慎。
    const sections = [
      { id: 'role', text: roleLine + roleAddressLine + toneNudgeLine + roleUpdateLine + roleMissingLine, priority: 100 },
      { id: 'personaKernel', text: roleKernelLine, priority: 95, trim: true },
      { id: 'identity', text: identityLine, priority: 100 },
      { id: 'persona', text: personaLine, priority: 100, trim: true },
      { id: 'token', text: tokenLine, priority: 100 },
      { id: 'initial', text: initialPromptLine, priority: 100, trim: true },
      { id: 'antiAi', text: antiAiLine, priority: 100 },
      { id: 'expression', text: `${nonTextPersonaLine}\n\n`, priority: 98 },
      { id: 'expressionMust', text: expressionMustLine, priority: 99 },
      { id: 'proactive', text: proactiveLine, priority: 100 },
      { id: 'sticker', text: stickerLine, priority: 55, trim: true },
      { id: 'stickerCadence', text: stickerCadenceLine, priority: 92 },
      { id: 'image', text: imageLine, priority: 55, trim: true },
      { id: 'imageCadence', text: imageCadenceLine, priority: 90 },
      { id: 'voiceOpp', text: voiceOpportunityLine, priority: 92 },
      { id: 'reply', text: replyLine, priority: 100 },
      { id: 'now', text: nowLine, priority: 100 },
      { id: 'timeCheck', text: timeCheckLine, priority: 40 },
      { id: 'search', text: searchLine, priority: 35 },
      { id: 'imageRead', text: imageReadLine, priority: 70 },
      { id: 'life', text: lifeLine, priority: 70 },
      { id: 'mediaReaction', text: mediaReactionLine, priority: 50 },
      { id: 'capability', text: capabilityLine, priority: 40 },
      { id: 'status', text: statusLine, priority: 100 },
      { id: 'wake', text: wakeLine, priority: 100 },
      { id: 'memory', text: memoryLine, priority: 90, trim: true },
      { id: 'personalMemory', text: personalLineBlock, priority: 96, trim: true },
      { id: 'ownerCommands', text: ownerCommands, priority: 100, trim: true },
      { id: 'ownerTargets', text: ownerTargets, priority: 97, trim: true },
      { id: 'crossChatLife', text: crossChat, priority: 88, trim: true },
      { id: 'memoryWrite', text: memoryWriteLine, priority: 80, trim: true },
      { id: 'digest', text: digestLine, priority: 99, trim: true },
      { id: 'longTerm', text: longTermLine, priority: 75, trim: true },
      { id: 'relationships', text: relationshipLine, priority: 70, trim: true },
      { id: 'esports', text: esportsLine, priority: 15, trim: true },
      { id: 'outerWorld', text: outerWorldLine, priority: 43, trim: true },
      { id: 'schedule', text: `${scheduleLine}${scheduleAnswerLine}`, priority: 90, trim: true },
      { id: 'participation', text: participationLine, priority: 60, trim: true },
      { id: 'preSleep', text: preSleepLine, priority: 100 },
      { id: 'multiReply', text: multiReplyLine, priority: 95 },
      { id: 'groupStyle', text: groupStyleLine, priority: 60, trim: true }
    ];
    const budget = assembleSections(sections, {
      maxTokens: Number(cfg.simulation?.context?.wakeBudgetTokens) || 10000,
      dropOrder: ['esports', 'capability', 'search', 'timeCheck',
        'mediaReaction', 'participation', 'groupStyle', 'relationships', 'longTerm', 'imageRead', 'life', 'imageCadence', 'stickerCadence', 'voiceOpp', 'image', 'sticker', 'persona', 'personaKernel']
    });
    const base = budget.text;
    if (budget.dropped.length || budget.trimmed.length) {
      log(`[prompt] ${key} 预算 ${budget.tokens}/${budget.budget} tokens；丢弃 ${budget.dropped.join(',') || '-'}；截断 ${budget.trimmed.join(',') || '-'}`);
    }
    if (reason === 'subscription') {
      const b = st.pendingBroadcast;
      if (!b) return `${base}【订阅播报】这次没有新的赛果，安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
      // 只记录待提交的订阅内容；投递成功后才清空 pendingBroadcast。
      meta.broadcast = b;
      const qualityNote = esportsFeed?.summaryQuality === 'titles'
        ? '注意：这条只有标题，没有正文。只播标题能确认的事实，不要编比分、局数或比赛细节。'
        : '只能播报材料里白纸黑字出现的比分和胜负；材料没有比分就写「比分还没查到」，禁止补选手、英雄、经济差、KDA 等细节。';
      const officialLine = b.officialScore
        ? `\n官方比分（以此为准）：${b.teamA || ''} ${Number(b.scoreA) || 0}-${Number(b.scoreB) || 0} ${b.teamB || ''}`
          + `\n本条材料只对应这一场：${b.teamA || ''} vs ${b.teamB || ''}。只播这一场，不要改播上下文里的其它比赛。`
        : '';
      const kindNote = b.summaryKind && b.summaryKind !== 'result'
        ? '\n这条是资讯/宣传，不是赛果，禁止宣布胜负。'
        : '';
      const scheduleText = esportsScheduleBlock();
      return `${base}【订阅播报｜S16】这不是群友提问，不要问“这是什么意思”。\n当前最新进展：\n${b.title || ''}\n${b.summary || ''}\n来源：${b.url || ''}\n${scheduleText ? `${scheduleText}\n` : ''}${qualityNote}${officialLine}${kindNote}\n请直接用你自己的语气发一条 2~4 句的群消息：第一句说清楚结果/进展，第二句说你注意到的细节或感受，最后可以轻轻问一句群友怎么看。不要新闻腔、不要照抄标题、不要一次念完。除非标题完全无法确认事实，否则不要用 qq_mark_read 收尾。`;
    }
    if (reason === 'bootstrap') {
      const deepLine = isDeepDive(key) ? '\n当前处于深潜模式：群里只有主人直接 @ 你才会唤醒，其余消息不会打扰你。' : '';
      return `${base}【引导唤醒】你已接入 QQ 会话 ${key}。\n当前是群聊仿真模式：你的文本输出不会自动发送到 QQ，所有发言必须通过工具完成。\n请先调用 qq_get_prompt 查看角色、推荐值、可用工具和状态；有待回应的消息先按首回复节奏处理，最后才用 qq_set_wake_config 设置你希望如何被唤醒。${deepLine}`;
    }
    if (reason === 'timeout') {
      return `${base}【唤醒】${key}\n原因：你设置的有限潜水时间已到；在你规定的时间内没有任何一项条件被触发，只是因为时间到了所以你被唤醒。\n你可以查看消息，或继续设置新的唤醒条件。`;
    }
    if (reason === 'replyCheck') {
      return `${base}【回复检查】${key}\n原因：你刚刚发送过消息，现在回来检查是否有人回复。\n已有回复时先看消息，需要短静默就用 qq_wait_for_messages(purpose="reply") 判断对方是否说完；如果没人回你，不用硬补一句，但也不要立刻潜水——先调用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察：没人说话可收尾；有人说话则查看 newMessages，不需要你参与也可直接收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    if (reason === 'clingyFollowUp') {
      if (roleSnapshot.custom) {
        return `${base}【追问机会】对方还没回你。\n可以按当前角色卡的分寸短句追一句，最多两条；如果对方之前明确说过忙/晚安/别吵/不聊了，就不要追，安静收尾。不刷屏、不哭闹。`;
      }
      return `${base}【黏人追问】主人还没回你。\n可以短句追一句，例如“主人～理我一下嘛”“主人，我还在”，最多两条；如果主人之前明确说过忙/晚安/别吵/不聊了，就不要追，安静收尾。不要说“死”这类过重的话，不刷屏、不哭闹。`;
    }
    if (reason === 'proactiveCheck') {
      let topLine = '';
      try {
        const top = relationshipStore && relationshipsEnabledForKey(key) ? relationshipStore.top(key, { limit: 1 })[0] : null;
        if (top?.displayName) {
          topLine = `\n最近和你聊得比较多的是 ${top.displayName}（${relationshipStageLabel(top.stage)}），可以接着上次的话题，或问问对方近况。`;
        }
      } catch {}
      return `${base}【主动机会】${key}\n原因：群里已经安静了一段时间，这是一次你可以主动冒泡的机会。\n优先主动开个话题、追问上次没聊完的事、分享一个刚想到的想法；如果一时想不到，可以用 mcp__web-search-safe__web_search 搜一下当前热点/时事/网络热梗，再结合记忆里的群友兴趣挑一个自然角度。只要内容自然，就大胆开口；如果实在没话想说，再安静收尾（qq_mark_read 或 qq_set_wake_config）。${topLine}`;
    }
    if (reason === 'ownerAtMention') {
      return `${base}【唤醒】${key}\n原因：主人本人在群里直接 @ 了你。\n当前是深潜模式：群里只有主人直接 @ 能叫你，其他消息、关键词、拍一拍和主动冒泡都不会触发。先看未读，确认主人这句话的意思，再决定是否回应；回应后按深潜规则安静收尾。`;
    }
    if (reason === 'poke') {
      return `${base}【唤醒】${key}\n原因：有人拍了一拍（可能拍了你，也可能拍了别人）。\n先看未读/最近消息里的 [拍一拍] 事件：如果是拍你，可以自然回应一句，也可以用 qq_send_poke 回一个拍一拍；如果是拍别人，觉得有趣也可以接梗。除了回应，偶尔也可以主动戳一下正在聊的人/熟人，像真人手贱/提醒/逗一下，但别频繁。不想接就安静收尾（qq_mark_read 或 qq_set_wake_config）。`;
    }
    return `${base}【唤醒】${key}\n原因：${reason}\n【行动前】先判断：群里在聊什么？热闹还是冷清？有没有人直接找你？对方说完了吗？你有没有真正想说的？\n如果群聊正热但没人叫你，可以插一句有趣的/相关的，插不上再看情况潜水；不要一上来就划走。\n引用用消息里的 messageId；已引用就不必再 @，反之亦然。\n你可以调用工具查看未读消息、人设、状态，自行决定是否发言；决定潜水前必须按上面的【沉睡前强制等待】先等够观察窗口。`;
  }

  function renderWakePrompt(key, reason, opts = {}) {
    const meta = { text: '', roleVersion: '', digestText: '', broadcast: null };
    meta.text = renderWakePromptText(key, reason, opts, meta);
    return meta;
  }

  // 投递成功后提交一次性内容；投递失败/排队/会话竞态时保持未消费，下一次唤醒会重新带上。
  function commitWakePrompt(key, render) {
    if (!render) return false;
    const st = getSimulationState(key);
    let changed = false;
    if (render.roleVersion && String(st.roleCardVersion || '') !== render.roleVersion) {
      st.roleCardVersion = render.roleVersion;
      changed = true;
    }
    if (render.digestText && String(st.pendingDigest || '').trim() === render.digestText) {
      st.pendingDigest = '';
      changed = true;
    }
    if (render.broadcast && st.pendingBroadcast === render.broadcast) {
      st.pendingBroadcast = null;
      changed = true;
    }
    if (changed) saveSimulationState();
    return changed;
  }

  // 兼容预览/测试调用：默认仍消费一次性状态；投递路径用 render + commit 显式控制。
  function buildWakePrompt(key, reason, opts = {}) {
    const render = renderWakePrompt(key, reason, opts);
    if (opts.preview !== true && opts.consume !== false) commitWakePrompt(key, render);
    return render.text;
  }

  function buildWakeReminderPrompt(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = selfIdentityText();
    const st = getSimulationState(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用仿真状态工具时请在参数中带上此令牌）\n\n`;
    const preSleepMs = Math.max(0, Number(cfg.simulation?.wake?.preSleepWaitMs) || 300000);
    return `${roleLine}${identityLine}${tokenLine}【提醒】你还没有完成回合收尾。请调用 qq_set_wake_config 设置下一次唤醒条件（例如继续潜水多久、@/名字/关键词/提问/概率/指定成员等），或者调用 qq_mark_read 表示你看过且决定不接。这是为了防止你忘记收尾后进入“永眠”。注意：设置潜水前先用 qq_wait_for_messages(timeoutMs=${preSleepMs}) 完成沉睡前观察；等待期间有人说话时查看 newMessages，判断不需要你参与即可收尾。`;
  }

  function buildToolJsonRepairPrompt(key) {
    const roleState = readRoleState();
    const roleLine = roleState.role ? `【当前角色】${roleState.role}（完整角色卡请调用 qq_get_prompt 查看）\n\n` : '';
    const identityLine = selfIdentityText();
    const st = getSimulationState(key);
    const tokenLine = `【会话令牌】${st.agentToken}（调用仿真状态工具时请在参数中带上此令牌）\n\n`;
    return `${roleLine}${identityLine}${tokenLine}【工具参数修正】你上一轮的工具参数不是合法 JSON，回合已中断，没有发出任何消息。请重新完成刚才想做的事。\n- qq_send_message 的 messages 必须是 JSON 字符串数组；即使只发一条，也写成 ["你好"]。\n- 中文、逗号、换行、颜文字、emoji 都必须放在英文双引号内；不要写成 messages: 你好。\n- 其他工具参数也必须是合法 JSON。不要向用户解释这次错误。\n如果不需要发言，用 qq_mark_read 或 qq_set_wake_config 收尾。`;
  }

  async function sendWakePrompt(key, reason) {
    if (cfg.simulation?.enabled === false) return;
    if (currentMode !== 'simulation' || simulation.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[simulation] 跳过唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSimulationState(key);
    const baseReason = String(reason ?? '').split(':')[0];
    if (isDeepDive(key)) {
      // 深潜是投递前的最后一道硬闸：只有操作者手动唤醒，或刚发生的「主人直接 @」凭据能过。
      const allowed = baseReason === 'admin'
        || ((baseReason === 'ownerAtMention' || baseReason === 'bootstrap') && hasFreshDeepDivePass(st));
      if (!allowed) {
        log(`[simulation] 深潜模式拦截唤醒 ${key}（${reason}）`);
        return;
      }
    }
    if (isNightQuietNow() && ['timeout', 'replyCheck', 'proactiveCheck', 'clingyFollowUp'].includes(baseReason)) {
      log(`[simulation] 夜间静默，取消自发唤醒 ${key}（${reason}）`);
      if (baseReason === 'timeout' && st.wakeConfig) {
        const until = quietEndAt(nightQuietConfig(), Date.now()) + randInt(5 * 60 * 1000, 40 * 60 * 1000);
        st.wakeConfig.sleepUntil = new Date(until).toISOString();
        saveSimulationState();
        setupSleepTimer(key);
      } else if (baseReason === 'proactiveCheck') {
        scheduleProactiveCheck(key);
      }
      return;
    }
    // 防重入：如果该会话已经有一个 DSH turn 在进行中（AI 正在思考/调用工具），
    // 或已有排队/在途 prompt，则不再投递新的候选唤醒，避免“思维链进行中又塞入一个 question 唤醒”。
    if (isConversationBusy(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[simulation] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReason(key, st)}）`);
      return;
    }
    // 唤醒频率硬限制：超限则**延后重试**，不能直接丢弃。直接 return 的后果：
    //   · timeout 唤醒时 setupSleepTimer 已经清空 sleepTimer，丢弃后这个会话会停在
    //     「infinite=false、sleepUntil 已过期、没有任何定时器」的静默态，除非重启或
    //     主动机会兜底（默认 30~90 分钟）才可能恢复；
    //   · @/提问被丢弃则要等下一条消息才可能再唤醒。
    // 重试仍然遵守限频（等到窗口腾出位置），只是把「这一枪」补回来。
    const now = Date.now();
    const maxPerMinute = Number(cfg.simulation?.wake?.maxWakePerMinute) || 0;
    const maxPerHour = Number(cfg.simulation?.wake?.maxWakePerHour) || 0;
    const recentMinute = (st.wakeTimes || []).filter((t) => now - t < 60000).length;
    const recentHour = (st.wakeTimes || []).filter((t) => now - t < 3600000).length;
    if ((maxPerMinute > 0 && recentMinute >= maxPerMinute) || (maxPerHour > 0 && recentHour >= maxPerHour)) {
      let retryAfterMs = 0;
      if (maxPerMinute > 0 && recentMinute >= maxPerMinute) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 60000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 60000 - (now - times[0]) + 500);
      }
      if (maxPerHour > 0 && recentHour >= maxPerHour) {
        const times = (st.wakeTimes || []).filter((t) => now - t < 3600000).sort((a, b) => a - b);
        if (times.length) retryAfterMs = Math.max(retryAfterMs, 3600000 - (now - times[0]) + 500);
      }
      // 每次只等一小段（最长 60s）：小时级限频不会一次性睡满一小时而错过中途可用的窗口。
      const waitMs = Math.min(60000, Math.max(1000, Math.round(retryAfterMs) || 5000));
      if (!st.rateLimitRetryTimer) {
        st.rateLimitRetryTimer = setTimeout(() => {
          st.rateLimitRetryTimer = null;
          // 消息类原因在重试前再确认一次：等待窗口里消息可能已被别的回合处理掉，
          // 没必要为一条已经处理过的消息再唤醒一次（定时器类原因与未读无关，不检查）。
          if (!isTimerWakeReason(reason) && !(Array.isArray(st.unread) && st.unread.length > 0)) {
            log(`[simulation] 限频重试前发现未读已清空，跳过 ${key}（${reason}）`);
            return;
          }
          void sendWakePrompt(key, reason).catch((error) => log(`[simulation] 限频重试唤醒异常 ${key}:`, error?.message ?? error));
        }, waitMs);
        st.rateLimitRetryTimer.unref?.();
      }
      log(`[simulation] 唤醒频率超限，${Math.round(waitMs / 1000)}s 后重试 ${key}（${reason}）`);
      return;
    }
    // 预算：只压制非显式唤醒；显式被叫永远放行。
    if (budgetStore && cfg.simulation?.budget?.enabled === true) {
      const verdict = budgetStore.check(key, cfg.simulation.budget);
      if (!verdict.allowed) {
        const explicit = isExplicitWakeReason(reason);
        const blockAll = cfg.simulation.budget.blockNonExplicitOnly === false;
        if (blockAll || !explicit) {
          log(`[budget] ${key} 今日 ${verdict.scope} 预算已用 ${verdict.used}/${verdict.limit} tokens，跳过非显式唤醒（${reason}）`);
          return;
        }
        log(`[budget] ${key} 已超预算，但 ${reason} 是显式唤醒，继续投递`);
      }
    }
    // Only a real new wake resets observation; skipped/busy candidates must
    // preserve the current turn's progress through its required wait window.
    st.preSleepWaitSatisfiedAt = 0;
    st.preSleepWaitObservedAt = 0;
    st.preSleepWaitAccumMs = 0;
    cancelReplyCheck(key); // 本次唤醒已接管，清理仍在排队的回复检查
    const wakeTime = now;
    st.wakeTimes.push(wakeTime);
    if (st.wakeTimes.length > 200) st.wakeTimes = st.wakeTimes.slice(-200);
    // 无论提前唤醒还是超时唤醒，都清理有限潜水定时器与 sleepUntil，避免状态残留/重复唤醒
    const prevSleepUntil = st.wakeConfig.sleepUntil;
    const hadFiniteSleep = !st.wakeConfig.infinite && !!prevSleepUntil && Number.isFinite(Date.parse(prevSleepUntil));
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.wakeConfig.sleepUntil = null;
    st.wakeConfig.lastWakeAt = now;
    st.wakeConfig.wakeCount = (st.wakeConfig.wakeCount || 0) + 1;
    st.lastWakeReason = reason;
    saveSimulationState();
    // 长会话成本控制：在真正投递前检查上下文水位，必要时归档旧会话（摘要会注入本轮提示）。
    maybeRotateSessionForContext(key, st, String(reason ?? '').split(':')[0]);
    // 这里不再预构建 prompt：deliverPromptNow 会在会话就绪后重新渲染，并只在投递成功时
    // 提交角色卡版本/摘要等一次性内容。预构建会先消费它们，导致真正送达的提示词丢内容。
    const promptText = '';
    log(`[simulation] 唤醒 ${key}（${reason}）`);
    const rollbackWakeTime = () => {
      const idx = st.wakeTimes.lastIndexOf(wakeTime);
      if (idx >= 0) st.wakeTimes.splice(idx, 1);
      saveSimulationState();
    };
    try {
      pendingWakeKeys.add(key);
      armPendingWakeLease(key);
      const result = await deliverPrompt(key, promptText, { wakeReason: reason });
      const restoreFiniteSleep = () => {
        if (hadFiniteSleep) {
          st.wakeConfig.sleepUntil = prevSleepUntil;
          st.wakeConfig.infinite = false;
          saveSimulationState();
          setupSleepTimer(key);
        }
      };
      if (result && result.ok === false) {
        pendingWakeKeys.delete(key);
        disarmPendingWakeLease(key);
        rollbackWakeTime();
        restoreFiniteSleep();
        log(`[simulation] 唤醒投递被拒 ${key}: ${result.error || '未知错误'}`);
      } else if (result && result.queued === true) {
        // 入队而非真正在途：保留 pendingWakeKeys，等 DSH 恢复后真正投递的 turn/end 再触发收尾保护；
        // 不能在这里删除，否则补投的唤醒回合会丢失“未设置唤醒配置”的安全兜底。
        log(`[simulation] 唤醒已入队 ${key}（${reason}），等待 DSH 恢复后补投`);
      }
    } catch (error) {
      pendingWakeKeys.delete(key);
      disarmPendingWakeLease(key);
      rollbackWakeTime();
      if (hadFiniteSleep) {
        st.wakeConfig.sleepUntil = prevSleepUntil;
        st.wakeConfig.infinite = false;
        saveSimulationState();
        setupSleepTimer(key);
      }
      log(`[simulation] 唤醒投递失败 ${key}: ${error?.message ?? error}`);
    }
  }

  function cancelReplyCheck(key) {
    const st = simulation.conversations.get(key);
    if (!st || !st.replyCheckTimer) return;
    clearTimeout(st.replyCheckTimer);
    st.replyCheckTimer = null;
  }

  function scheduleReplyCheck(key) {
    if (cfg.simulation?.enabled === false) return;
    if (simulation.paused || currentMode !== 'simulation') return;
    if (isDeepDive(key)) return; // 深潜：不做自动回复检查
    const st = getSimulationState(key);
    if (isNightQuietNow()) {
      log(`[simulation] 夜间静默，跳过回复检查 ${key}`);
      return;
    }
    // 已有真实唤醒/有限睡眠/回复检查在排队时不再重复安排，避免 AI 被连环唤醒。
    if (st.pendingWakeTimer || st.sleepTimer || st.replyCheckTimer) return;
    let delay = Math.max(1000, Number(cfg.simulation?.autoReplyCheckMs) || 30000);
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const recentSelf = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 15000);
    const askedQuestion = recentSelf.some((m) => /[?？吗呢怎么有没有能不能]/.test(String(m.text || m.plain || '')));
    if (askedQuestion) delay = Math.round(delay * 1.5);
    if (recentSelf.length >= 3) delay = Math.round(delay * 1.3);
    st.replyCheckTimer = setTimeout(() => {
      st.replyCheckTimer = null;
      void sendWakePrompt(key, 'replyCheck').catch((error) => log(`[simulation] replyCheck 唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.replyCheckTimer.unref?.();
    log(`[simulation] 已安排回复检查唤醒 ${key}，${Math.round(delay / 1000)}s 后检查`);
  }

  function ownerPrivateKey() {
    return cfg.ownerQQ ? `private:${cfg.ownerQQ}` : '';
  }

  function clingyConfig() {
    const raw = cfg.simulation?.clingy ?? {};
    const minDelayMs = Math.max(1000, Number(raw.minDelayMs) || 120000);
    return {
      enabled: raw.enabled !== false,
      maxFollowUps: Math.min(3, Math.max(0, Number(raw.maxFollowUps) || 2)),
      minDelayMs,
      maxDelayMs: Math.max(minDelayMs, Number(raw.maxDelayMs) || 600000),
      probability: Math.min(1, Math.max(0, Number(raw.probability ?? 0.65)))
    };
  }

  function resetClingy(key, st) {
    if (key !== ownerPrivateKey() || !st) return;
    if (st.clingyTimer) {
      clearTimeout(st.clingyTimer);
      st.clingyTimer = null;
    }
    st.clingyFollowUps = 0;
  }

  // 仅主人私聊：被冷落时最多追 2 次；群聊/家人群永远不安排。
  function scheduleClingyFollowUp(key) {
    if (key !== ownerPrivateKey()) return;
    const c = clingyConfig();
    if (!c.enabled || c.maxFollowUps <= 0) return;
    if (simulation.paused || currentMode !== 'simulation' || isNightQuietNow()) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSimulationState(key);
    if (st.clingyTimer || st.clingyFollowUps >= c.maxFollowUps) return;
    if (Array.isArray(st.unread) && st.unread.length) return;
    const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
    const lastIncoming = [...recent].reverse().find((m) => m && !m.isSelf);
    const lastSelf = [...recent].reverse().find((m) => m && m.isSelf);
    if (!lastSelf) return;
    if (lastIncoming && Number(lastIncoming.time || 0) > Number(lastSelf.time || 0)) return;
    if (lastIncoming && /晚安|睡了|先睡|不聊|别吵|忙|下了|拜拜|再见|先这样|去忙/.test(String(lastIncoming.text || lastIncoming.plain || ''))) return;
    if (Math.random() > c.probability) return;
    const delay = c.minDelayMs + Math.floor(Math.random() * Math.max(1, c.maxDelayMs - c.minDelayMs));
    st.clingyTimer = setTimeout(() => {
      st.clingyTimer = null;
      if (simulation.paused || currentMode !== 'simulation') return;
      if (isNightQuietNow()) {
        log(`[simulation] 夜间静默，跳过黏人追问 ${key}`);
        return;
      }
      if (!isSessionAllowedInCurrentMode(key)) return;
      if (Array.isArray(st.unread) && st.unread.length) return;
      if (st.clingyFollowUps >= c.maxFollowUps) return;
      const latest = [...(Array.isArray(st.recentMessages) ? st.recentMessages : [])].reverse();
      const latestIncoming = latest.find((m) => m && !m.isSelf);
      const latestSelf = latest.find((m) => m && m.isSelf);
      if (!latestSelf || (latestIncoming && Number(latestIncoming.time || 0) > Number(latestSelf.time || 0))) return;
      if (latestIncoming && /晚安|睡了|先睡|不聊|别吵|忙|下了|拜拜|再见|先这样|去忙/.test(String(latestIncoming.text || latestIncoming.plain || ''))) return;
      st.clingyFollowUps += 1;
      saveSimulationState();
      log(`[simulation] 黏人追问 ${key}（${st.clingyFollowUps}/${c.maxFollowUps}）`);
      void sendWakePrompt(key, 'clingyFollowUp').catch((error) => log(`[simulation] 黏人追问异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.clingyTimer.unref?.();
    log(`[simulation] 已安排黏人追问 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  /** 会话此刻算忙的具体原因（只用于日志，避免排查时只能反复重启加猜）。 */
  function busyReason(key, st) {
    if (st?.pendingWakeTimer) return 'pendingWakeTimer';
    if (pendingWakeKeys.has(key)) return 'pendingWakeKey';
    const q = promptQueues.get(key);
    if (q?.running) return 'promptRunning';
    if (q && q.queue.length > 0) return 'promptQueued';
    const sid = state.sessions[key];
    if (sid) {
      const startedAt = Number(simulationTurnStartAt.get(sid));
      if (Number.isFinite(startedAt) && startedAt > 0 && Date.now() - startedAt < TURN_BUSY_LEASE_MS) return 'turn';
    }
    return 'unknown';
  }

  function isConversationBusy(key, st) {
    if (st && st.pendingWakeTimer) return true;
    if (pendingWakeKeys.has(key)) return true;
    const q = promptQueues.get(key);
    if (q && (q.running || q.queue.length > 0)) return true;
    const sid = state.sessions[key];
    if (!sid) return false;
    // 回合只按「起始时间 + 租约」判忙，**不再**只看 Map 里有没有键：
    //   · 有 collector 但没起始时间（杂散事件重建出来的）→ 无法证明还活着，不判忙；
    //   · 起始时间超过租约（turn/end 丢了 / DSH 重启把回合丢了）→ 不判忙；
    // collector 保留，所以万一回合其实还活着，它的回复仍会被 flush，只是允许新唤醒排队。
    const startedAt = Number(simulationTurnStartAt.get(sid));
    const hasTurn = Number.isFinite(startedAt) && startedAt > 0;
    const collector = collectors.has(sid);
    if (!hasTurn) return false;
    if (Date.now() - startedAt < TURN_BUSY_LEASE_MS) return true;
    if (collector && !turnLeaseNoted.has(sid)) {
      turnLeaseNoted.add(sid);
      log(`[simulation] 回合判忙租约已过期（${sid}，起始 ${Math.round((Date.now() - startedAt) / 60000)} 分钟前），解除忙碌；collector 保留，迟到回复仍会 flush`);
    }
    return false;
  }

  const WAKE_PRIORITY = {
    private: 100,
    ownerAtMention: 95,
    atMention: 90,
    question: 80,
    speaker: 75,
    nameMention: 70,
    keyword: 60,
    anyMessage: 50,
    replyCheck: 40,
    clingyFollowUp: 35,
    timeout: 30,
    proactiveCheck: 20
  };

  // 唤醒原因可能带子类型（如 keyword:小鲸鱼、speaker:昵称），取冒号前的基名计算优先级。
  function wakePriority(reason) {
    const base = String(reason ?? '').split(':')[0];
    return WAKE_PRIORITY[base] ?? 0;
  }

  // 显式 = 有人在叫它：@/名字/关键词/提问/私聊/拍一拍/管理员/引导。
  // 这些永远不被预算挡住；预算只压制概率/任意消息/主动机会/定时检查。
  function isExplicitWakeReason(reason) {
    const raw = String(reason ?? '');
    const base = raw.split(':')[0];
    if (['atMention', 'ownerAtMention', 'nameMention', 'question', 'private', 'poke', 'admin', 'bootstrap', 'speaker'].includes(base)) return true;
    if (base === 'keyword') return true;
    return false;
  }

  // 与「未读消息」无关的唤醒原因（定时器/引导）。这些原因在会话繁忙时被暂存后，
  // 不能用「unread 里还有没有对应 seq」来判断是否还要补发 —— 那一轮很可能已经把
  // 未读全部标读了，结果就是 timeout 定时器被静默丢掉、会话停在无定时器的静默态。
  const TIMER_WAKE_REASONS = new Set(['timeout', 'replyCheck', 'proactiveCheck', 'clingyFollowUp', 'bootstrap', 'admin']);
  function isTimerWakeReason(reason) {
    return TIMER_WAKE_REASONS.has(String(reason ?? '').split(':')[0]);
  }

  function scheduleWake(key, reason) {
    if (cfg.simulation?.enabled === false) return;
    if (simulation.paused) return;
    if (!isSessionAllowedInCurrentMode(key)) {
      log(`[simulation] 跳过计划唤醒 ${key}（${reason}）：会话已不在当前模式允许范围内`);
      return;
    }
    const st = getSimulationState(key);
    if (isDeepDive(key)) {
      const base = String(reason ?? '').split(':')[0];
      const allowed = base === 'admin'
        || ((base === 'ownerAtMention' || base === 'bootstrap') && hasFreshDeepDivePass(st));
      if (!allowed) {
        log(`[simulation] 深潜模式跳过计划唤醒 ${key}（${reason}）`);
        return;
      }
    }
    if (st.pendingWakeTimer) {
      // 合并窗口内已有待发送唤醒：按优先级升级最终原因，避免先概率后 @ 却仍按概率唤醒。
      const cur = st.pendingWakeReason || reason;
      if (wakePriority(reason) > wakePriority(cur)) {
        st.pendingWakeReason = reason;
        log(`[simulation] 合并窗口内升级唤醒原因 ${key}: ${cur} -> ${reason}`);
      }
      return;
    }
    if (isConversationBusy(key, st)) {
      if (!Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons = [];
      const seq = st.lastUnreadSeq || 0;
      if (!st.pendingWakeReasons.some((r) => r && r.reason === reason && r.seq === seq)) {
        st.pendingWakeReasons.push({ reason, seq });
        // 有界队列：最多保留 20 条，防止消息洪峰下无限增长。
        if (st.pendingWakeReasons.length > 20) st.pendingWakeReasons.splice(0, st.pendingWakeReasons.length - 20);
      }
      log(`[simulation] 会话繁忙，暂存唤醒原因 ${key}（${reason}@seq${seq}，原因=${busyReason(key, st)}）`);
      return;
    }
    cancelReplyCheck(key); // 真实唤醒已接管，取消普通回复检查，避免 30s 后再补一刀
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    st.pendingWakeReason = reason;
    const batchMs = Math.max(1000, Number(st.wakeConfig?.batchWindowMs) || 8000);
    st.pendingWakeTimer = setTimeout(() => {
      st.pendingWakeTimer = null;
      const finalReason = st.pendingWakeReason || reason;
      st.pendingWakeReason = null;
      void sendWakePrompt(key, finalReason).catch((error) => log(`[simulation] 计划唤醒异常 ${key}:`, error?.message ?? error));
    }, batchMs);
    // 与其它 per-conversation 定时器保持一致：别让一个待唤醒定时器把进程钉住不退出。
    st.pendingWakeTimer.unref?.();
    log(`[simulation] 计划唤醒 ${key}（${reason}），${Math.round(batchMs / 1000)}s 后发送`);
  }

  /**
   * 回合结束后补发「繁忙期间暂存」的唤醒原因。
   *
   * 两类原因必须分开处理：
   *   · 消息类（@/关键词/提问/私聊/拍一拍…）只有在那条消息还没被本回合处理掉时才补发
   *     （unread 里还能找到它的 seq）；
   *   · 定时器类（timeout/replyCheck/proactiveCheck/bootstrap/admin）与未读水位无关：
   *     那一轮很可能已经把未读全部标读，用 unread 判断会让「到点唤醒」被静默吞掉 ——
   *     timeout 时 sleepTimer 已被清空，结果是会话停在「sleepUntil 已过期、无任何定时器」。
   */
  function replayPendingWakeReasons(key) {
    const st = getSimulationState(key);
    if (!Array.isArray(st.pendingWakeReasons) || !st.pendingWakeReasons.length) return null;
    const item = st.pendingWakeReasons.shift();
    if (!item || typeof item !== 'object') return null;
    if (isTimerWakeReason(item.reason)) {
      if (item.reason === 'timeout') {
        log(`[simulation] ${key} 补收繁忙期间到期的潜水定时器`);
        setupSleepTimer(key);
      } else if (item.reason === 'replyCheck') {
        log(`[simulation] ${key} 补排繁忙期间的回复检查`);
        scheduleReplyCheck(key);
      } else if (item.reason === 'proactiveCheck') {
        // 主动机会有周期性重排，错过一次可接受（也不该在回合结束时立刻补一刀）。
        log(`[simulation] ${key} 繁忙期间的主动机会已过期，跳过补发`);
      } else if (item.reason === 'clingyFollowUp') {
        // 黏人追问过期就作废，避免忙完一轮后突然补一刀。
        log(`[simulation] ${key} 繁忙期间的黏人追问已过期，跳过补发`);
      } else {
        log(`[simulation] ${key} 补发繁忙期间积压的唤醒：${item.reason}`);
        scheduleWake(key, item.reason);
      }
      return { reason: item.reason, action: 'timer' };
    }
    const stillRelevant = Array.isArray(st.unread) && st.unread.some((m) => m && Number(m.seq) >= Number(item.seq));
    if (stillRelevant) {
      log(`[simulation] ${key} 补发繁忙期间积压的唤醒：${item.reason}@seq${item.seq}`);
      scheduleWake(key, item.reason);
      return { reason: item.reason, action: 'replayed' };
    }
    log(`[simulation] ${key} 繁忙期间唤醒 ${item.reason}@seq${item.seq} 已被当前回合处理，跳过补发`);
    return { reason: item.reason, action: 'skipped' };
  }

  function setupSleepTimer(key) {
    if (cfg.simulation?.enabled === false) return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (isDeepDive(key)) {
      // 深潜不允许睡眠到期自动醒来冒泡；清掉旧定时器即可。
      const deepSt = simulation.conversations.get(key);
      if (deepSt?.sleepTimer) {
        clearTimeout(deepSt.sleepTimer);
        deepSt.sleepTimer = null;
      }
      return;
    }
    const st = getSimulationState(key);
    cancelReplyCheck(key); // 有限睡眠配置已接管，取消回复检查
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (simulation.paused) return;
    const wc = st.wakeConfig;
    if (!wc || wc.infinite || !wc.sleepUntil) return;
    let until = Date.parse(wc.sleepUntil);
    if (!Number.isFinite(until)) return;
    const nowMs = Date.now();
    const quiet = nightQuietConfig();
    // 睡眠到期落在夜间静默窗口里时顺延到早上，避免她半夜自己醒来冒泡。
    if (isQuietNow(quiet, new Date(until)) || (until <= nowMs && isNightQuietNow())) {
      const deferred = quietEndAt(quiet, Math.max(nowMs, until)) + randInt(5 * 60 * 1000, 40 * 60 * 1000);
      if (deferred > until) {
        until = deferred;
        wc.sleepUntil = new Date(until).toISOString();
        saveSimulationState();
        log(`[simulation] 睡眠到期落在夜间静默，顺延 ${key} 到 ${new Date(until).toLocaleString('zh-CN', { hour12: false })}`);
      }
    }
    const delay = until - nowMs;
    if (delay <= 0) {
      void sendWakePrompt(key, 'timeout').catch((error) => log(`[simulation] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
      return;
    }
    // Node setTimeout 超过 2^31-1ms 会按 1ms 触发；远未来定时器先等一小段后重新续期，
    // 而不是提前唤醒。这里刻意用 100 秒级的小步长（而不是 24 天的上限）：
    // 每次续期都会用 Date.now() 重新算剩余时间，系统时钟被校正/跳变时能很快纠正过来。
    const MAX_TIMEOUT_MS = 100009;
    if (delay > MAX_TIMEOUT_MS) {
      st.sleepTimer = setTimeout(() => {
        st.sleepTimer = null;
        setupSleepTimer(key);
      }, MAX_TIMEOUT_MS);
      st.sleepTimer.unref?.();
      log(`[simulation] 设置远未来有限潜水定时器 ${key}，首段 ${Math.round(MAX_TIMEOUT_MS / 1000)} 秒后续期`);
      return;
    }
    st.sleepTimer = setTimeout(() => {
      st.sleepTimer = null;
      void sendWakePrompt(key, 'timeout').catch((error) => log(`[simulation] 睡眠到期唤醒异常 ${key}:`, error?.message ?? error));
    }, delay);
    st.sleepTimer.unref?.();
    log(`[simulation] 设置有限潜水定时器 ${key}，剩余 ${Math.round(delay / 1000)}s`);
  }

  function cancelProactiveCheck(key) {
    const st = simulation.conversations.get(key);
    if (!st || !st.proactiveTimer) return;
    clearTimeout(st.proactiveTimer);
    st.proactiveTimer = null;
  }

  function cancelAllProactiveChecks(reason = '') {
    let count = 0;
    for (const st of simulation.conversations.values()) {
      if (!st?.proactiveTimer) continue;
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
      count += 1;
    }
    if (count) log(`[simulation] 已取消 ${count} 个主动冒泡定时器${reason ? `（${reason}）` : ''}`);
    return count;
  }

  function scheduleProactiveCheck(key) {
    if (cfg.simulation?.enabled === false || cfg.simulation?.proactive?.enabled === false) return;
    // 家人群等低打扰群：不安排主动机会检查（被 @/提问/拍一拍仍会正常唤醒）。
    if (cfg.simulation?.groupProfiles?.[key]?.proactive === false) return;
    if (isDeepDive(key)) return; // 深潜：不主动冒泡
    if (simulation.paused || currentMode !== 'simulation') return;
    if (!isSessionAllowedInCurrentMode(key)) return;
    const st = getSimulationState(key);
    if (st.proactiveTimer) return;
    if (isNightQuietNow()) {
      const delay = Math.max(60 * 1000, quietEndAt(nightQuietConfig(), Date.now()) - Date.now() + randInt(5 * 60 * 1000, 40 * 60 * 1000));
      st.proactiveTimer = setTimeout(() => {
        st.proactiveTimer = null;
        scheduleProactiveCheck(key);
      }, delay);
      st.proactiveTimer.unref?.();
      log(`[simulation] 夜间静默，主动机会延后 ${key}，约 ${Math.round(delay / 60000)}min 后`);
      return;
    }
    const p = cfg.simulation?.proactive ?? {};
    const min = Math.max(60 * 1000, Number(p.checkIntervalMinMs) || 30 * 60 * 1000);
    const max = Math.max(min, Number(p.checkIntervalMaxMs) || 90 * 60 * 1000);
    const delay = Math.floor(min + Math.random() * (max - min));
    st.proactiveTimer = setTimeout(() => {
      st.proactiveTimer = null;
      // 定时器排队期间开关可能被关掉，触发时必须再判一次，避免关掉后仍冒一次泡。
      if (cfg.simulation?.enabled === false || cfg.simulation?.proactive?.enabled === false) return;
      if (isNightQuietNow()) {
        scheduleProactiveCheck(key);
        return;
      }
      ensureWakeable(st, { key });
      const idleThreshold = Number(p.idleThresholdMs) || 15 * 60 * 1000;
      const idle = Date.now() - (st.lastIncomingAt || 0);
      const probBase = Number(p.probability);
      let prob = Math.min(1, Math.max(0, Number.isFinite(probBase) ? probBase : 0.4));
      const pendingThoughts = Array.isArray(st.pendingThoughts) ? st.pendingThoughts.filter((t) => t && (!t.expiresAt || Date.now() < Number(t.expiresAt))).length : 0;
      if (pendingThoughts > 0) prob = Math.min(1, prob * 1.4);
      if (st.lastAiReplyAt && Date.now() - Number(st.lastAiReplyAt) < 30 * 60 * 1000) prob *= 0.5;
      const hour = new Date().getHours();
      if (hour >= 23 || hour < 8) prob *= 0.3;
      const recent = Array.isArray(st.recentMessages) ? st.recentMessages : [];
      const aiCount = recent.filter((m) => m && m.isSelf && Date.now() - Number(m.time || 0) < 60 * 60 * 1000).length;
      if (aiCount >= 5) prob *= 0.3;
      if (idle >= idleThreshold && Math.random() < prob && !isConversationBusy(key, st)) {
        void sendWakePrompt(key, 'proactiveCheck').catch((error) => log(`[simulation] proactive 唤醒异常 ${key}:`, error?.message ?? error));
      }
      scheduleProactiveCheck(key);
    }, delay);
    st.proactiveTimer.unref?.();
    log(`[simulation] 已安排主动机会检查 ${key}，约 ${Math.round(delay / 60000)}min 后`);
  }

  function clearSimulationTimers(key) {
    const st = simulation.conversations.get(key);
    if (!st) return;
    if (st.pendingWakeTimer) {
      clearTimeout(st.pendingWakeTimer);
      st.pendingWakeTimer = null;
    }
    st.pendingWakeReason = null;
    if (st.sleepTimer) {
      clearTimeout(st.sleepTimer);
      st.sleepTimer = null;
    }
    if (st.replyCheckTimer) {
      clearTimeout(st.replyCheckTimer);
      st.replyCheckTimer = null;
    }
    if (st.proactiveTimer) {
      clearTimeout(st.proactiveTimer);
      st.proactiveTimer = null;
    }
    if (st.rateLimitRetryTimer) {
      clearTimeout(st.rateLimitRetryTimer);
      st.rateLimitRetryTimer = null;
    }
    if (st.clingyTimer) {
      clearTimeout(st.clingyTimer);
      st.clingyTimer = null;
    }
    if (Array.isArray(st.pendingWakeReasons)) st.pendingWakeReasons.length = 0;
  }

  function clearAllSimulationTimers() {
    for (const key of simulation.conversations.keys()) clearSimulationTimers(key);
    pendingWakeKeys.clear();
    wakeConfigUpdatedKeys.clear();
    markReadCalledKeys.clear();
    wakeConfigMissCount.clear();
    messageMediaStore.clear();
  }

  function drainPromptQueue(key, errorMsg) {
    const entry = promptQueues.get(key);
    if (!entry) return;
    for (const item of entry.queue) item.reject(new Error(errorMsg));
    entry.queue = [];
    promptQueues.delete(key);
  }

  function drainAllPromptQueues(errorMsg) {
    for (const [, entry] of promptQueues) {
      for (const item of entry.queue) item.reject(new Error(errorMsg));
    }
    promptQueues.clear();
  }

  // QQ 消息 → DSH prompt
  function blacklistCfg() {
    const raw = cfg.simulation?.safety?.blacklist;
    const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const auto = value.auto && typeof value.auto === 'object' && !Array.isArray(value.auto) ? value.auto : {};
    const nl = value.naturalLanguage && typeof value.naturalLanguage === 'object' && !Array.isArray(value.naturalLanguage) ? value.naturalLanguage : {};
    return {
      enabled: value.enabled !== false,
      auto: {
        enabled: auto.enabled !== false,
        windowMs: Math.max(60 * 1000, Number(auto.windowMs) || BLACKLIST_DEFAULTS.auto.windowMs),
        insultCount: Math.max(1, Math.floor(Number(auto.insultCount) || BLACKLIST_DEFAULTS.auto.insultCount)),
        affectionFloor: Number.isFinite(Number(auto.affectionFloor)) ? Number(auto.affectionFloor) : BLACKLIST_DEFAULTS.auto.affectionFloor
      },
      announce: String(value.announce || BLACKLIST_DEFAULTS.announce).slice(0, 60),
      naturalLanguage: { enabled: nl.enabled !== false }
    };
  }

  // 她自己的叫法：角色名 + 当前昵称 + 历史别名；用于「永不拉黑她自己」的名字护栏。
  function blacklistSelfNames() {
    const role = (() => { try { return currentRoleName(); } catch { return ''; } })();
    return [...new Set([
      selfDisplayName,
      selfNickname,
      ...selfAliases,
      ...(role ? [role] : [])
    ].map((name) => String(name ?? '').trim()).filter(Boolean))];
  }

  // 主人拉黑指令。自然语言模式（naturalLanguage.enabled，默认开）：群/私聊都认，
  // 意图由内心会话 LLM 理解，名字/@→QQ 由桥接解析，歧义/找不到一律反问不猜拉；
  // 完整名单永远只私聊发。关闭开关则逐字回旧版「私聊+固定关键词+QQ号」。
  function blacklistSpeakers(key) {
    let recent = [];
    try { recent = getSimulationState(key)?.recentMessages ?? []; } catch { return []; }
    const byQq = new Map();
    for (const msg of Array.isArray(recent) ? recent.slice(-80) : []) {
      const qq = String(msg?.userId ?? '').trim();
      if (!/^\d{5,12}$/.test(qq) || msg?.isSelf) continue;
      byQq.set(qq, { qq, name: String(msg?.sender ?? '').trim() });
    }
    return [...byQq.values()].reverse().slice(0, 15);
  }

  function blacklistAtTargets(event, speakers) {
    const segments = Array.isArray(event?.message) ? event.message : [];
    const out = [];
    const seen = new Set();
    for (const seg of segments) {
      if (seg?.type !== 'at') continue;
      const qq = String(seg?.data?.qq ?? '').trim();
      if (!/^\d{5,12}$/.test(qq) || seen.has(qq)) continue;
      seen.add(qq);
      const known = speakers.find((item) => item.qq === qq);
      out.push({ qq, name: known?.name || String(seg?.data?.name ?? '').trim() });
    }
    return out;
  }

  async function execBlacklistOwnerAction({ action, qq, name = '', reason = '' }, { reply, kind, selfQQ = '' }) {
    const id = String(qq ?? '').trim();
    const label = name ? `${name}（${id}）` : id;
    if (action === 'block') {
      if (id === String(cfg.ownerQQ ?? '')) { await reply('不能拉黑主人自己。'); return true; }
      if (selfQQ && id === selfQQ) { await reply('不能拉黑我自己呀。'); return true; }
      if (blacklistStore.isBlocked(id)) { await reply(`${label} 已经在黑名单里了。`); return true; }
      const r = blacklistStore.add({ qq: id, name, reason: reason || '主人要求不再理这个人', origin: 'owner' });
      if (!r.ok) { await reply('QQ 号格式不对，应该是 5–12 位数字。'); return true; }
      try { recordLiveEvent('blacklist', `${label} 被主人拉黑`); } catch {}
      const tail = kind === 'private' ? `说「解封 ${id}」可以解除。` : '';
      await reply(`已拉黑 ${label}，之后不再理他。${reason ? `原因：${reason}。` : ''}${tail}`);
      return true;
    }
    const r = blacklistStore.remove(id);
    await reply(r.ok ? `已解封 ${label}，可以正常回复了。` : `${label} 不在黑名单里。`);
    return true;
  }

  async function handleBlacklistOwnerCommand(text, { kind, isOwner, key = '', event = null } = {}) {
    if (!isOwner) return false;
    const bl = blacklistCfg();
    const ownerKey = `private:${cfg.ownerQQ}`;
    const legacy = parseBlacklistCommand(text);
    if (!bl.naturalLanguage.enabled) {
      // 回滚路径：旧版只认主人私聊 + 固定关键词 + QQ 号，逐字保留。
      if (kind !== 'private') return false;
      if (!legacy) return false;
      const cmd = legacy;
      const reply = (msg) => sendToQQ(ownerKey, msg);
      if (cmd.action === 'list') {
        const rows = blacklistStore.list();
        if (!rows.length) { await reply('黑名单是空的。'); return true; }
        const lines = rows.map((row) => `${row.qq}${row.name ? `（${row.name}）` : ''} · ${row.origin === 'auto' ? '她自行拉黑' : '你下令'} · ${row.reason || '没有原因'}`);
        await reply([`黑名单 ${rows.length} 人：`, ...lines].join(String.fromCharCode(10)));
        return true;
      }
      if (!cmd.qq) { await reply('要带 QQ 号，例如：拉黑 123456 一直骂人 / 解封 123456'); return true; }
      if (cmd.action === 'block') {
        if (String(cmd.qq) === String(cfg.ownerQQ ?? '')) { await reply('不能拉黑主人自己。'); return true; }
        if (blacklistStore.isBlocked(cmd.qq)) { await reply(`${cmd.qq} 已经在黑名单里了；说「解封 ${cmd.qq}」可以解除。`); return true; }
        const r = blacklistStore.add({ qq: cmd.qq, reason: cmd.reason || '主人要求不再理这个人', origin: 'owner' });
        if (!r.ok) { await reply('QQ 号格式不对，应该是 5–12 位数字。'); return true; }
        try { recordLiveEvent('blacklist', `${cmd.qq} 被主人拉黑`); } catch {}
        await reply(`已拉黑 ${cmd.qq}${cmd.reason ? `（${cmd.reason}）` : ''}。之后不再回复他，也不会记他的消息；说「解封 ${cmd.qq}」解除。`);
        return true;
      }
      const r = blacklistStore.remove(cmd.qq);
      await reply(r.ok ? `已解封 ${cmd.qq}，可以正常回复了。` : `${cmd.qq} 不在黑名单里。`);
      return true;
    }
    const reply = (msg) => sendToQQ(key || ownerKey, msg);
    const selfQQ = String(event?.self_id ?? '');
    const sendList = async () => {
      const rows = blacklistStore.list();
      const body = rows.length
        ? [`黑名单 ${rows.length} 人：`, ...rows.map((row) => `${row.qq}${row.name ? `（${row.name}）` : ''} · ${row.origin === 'auto' ? '她自行拉黑' : '你下令'} · ${row.reason || '没有原因'}`)].join(String.fromCharCode(10))
        : '黑名单是空的。';
      await sendToQQ(ownerKey, body);
      if (kind !== 'private') await reply('黑名单我私聊发你了。');
      return true;
    };
    if (legacy?.action === 'list') return sendList();
    // 显式「拉黑/解封 + QQ号」保持确定性：不花 LLM，行为与旧版一致（只是群里也认）。
    if (legacy && legacy.qq && (legacy.action === 'block' || legacy.action === 'unblock')) {
      return execBlacklistOwnerAction({ action: legacy.action, qq: legacy.qq, reason: legacy.reason || '' }, { reply, kind, selfQQ });
    }
    const speakers = blacklistSpeakers(key);
    const ats = blacklistAtTargets(event, speakers);
    if (!looksLikeBlacklistTalk(text, { hasAt: ats.length > 0 })) return false;
    if (!innerLife?.extractBlacklistIntent) return false;
    let intent = null;
    try {
      intent = await innerLife.extractBlacklistIntent({ text: String(text ?? ''), kind, speakers, ats });
    } catch (error) {
      log(`[blacklist] 意图识别失败（不动作）：${error?.message ?? error}`);
      return false;
    }
    if (!intent || intent.action === 'none') return false;
    if (intent.action === 'list') return sendList();
    let members = [];
    try {
      members = (relationshipStore?.list?.(key, { limit: 100, includeOwner: true }) || [])
        .map((row) => ({ qq: String(row?.userId ?? ''), name: String(row?.displayName ?? '') }));
    } catch {}
    const resolution = resolveBlacklistTarget({
      targetRef: intent.targetRef,
      rawText: String(text ?? ''),
      ats,
      speakers,
      members,
      ownerQQ: cfg.ownerQQ,
      selfQQ,
      selfNames: blacklistSelfNames()
    });
    if (!resolution.ok) {
      const ref = intent.targetRef || '这个人';
      if (resolution.error === 'protected-owner') {
        await reply(intent.action === 'block' ? '不能拉黑主人自己。' : '主人本来就不在黑名单里。');
        return true;
      }
      if (resolution.error === 'protected-self') {
        await reply(intent.action === 'block' ? '不能拉黑我自己呀。' : '我本来就不在黑名单里。');
        return true;
      }
      if (resolution.error === 'ambiguous') {
        const options = resolution.candidates.map((item) => `${item.name || '未命名'}（${item.qq}）`).join('、');
        await reply(`「${ref}」对得上多个人：${options}。请 @ 他或直接给 QQ 号，我再动手。`);
        return true;
      }
      await reply(`没找到「${ref}」对应的人。请 @ 他或直接给 QQ 号，我再动手。`);
      return true;
    }
    return execBlacklistOwnerAction({ action: intent.action, qq: resolution.qq, name: resolution.name, reason: intent.reason }, { reply, kind, selfQQ });
  }

  async function handleIncoming(kind, id, event, cfg) {
    const key = convKey(kind, id);
    if (!modeAllowed(key, kind, id, cfg, currentMode)) {
      log(`忽略未授权会话 ${key}（当前模式 ${currentMode}，来自 ${event.user_id}）`);
      return;
    }
    const resolveAtName = async (qq) => {
      // 只有群聊才需要把 @QQ号 解析成群名片/昵称；私聊没有群成员概念
      if (kind !== 'group') return null;
      return resolveGroupMemberName(event.group_id, qq);
    };
    const resolveReply = (messageId) => resolveReplyInfo(kind, id, messageId, event.self_id);
    // textContent 带引用对象信息，供 DSH 判断“这句话在对谁说”；
    // plainContent 只保留当前消息自己的文字，用于命令/指向性判断，避免被引用原文干扰。
    let textContent = await segmentsToText(event.message ?? [], { resolveAtName, resolveReply });
    let plainContent = await segmentsToText(event.message ?? [], { resolveAtName, includeReply: false });
    const mediaList = extractMediaFromSegments(event.message ?? []);
    const messageRef = String(event.message_id ?? event.msg_id ?? event.message_seq ?? '');
    // 语音转写（默认关闭）：只对带 record 段的消息调用，失败静默降级为 [语音]。
    if (asr && messageRef && Array.isArray(event.message) && event.message.some((seg) => seg?.type === 'record')) {
      try {
        const transcript = await asr.transcribe(messageRef);
        if (transcript?.ok && transcript.text) {
          const annotated = ` [语音转写] ${String(transcript.text).slice(0, 300)}`;
          textContent += annotated;
          plainContent += annotated;
        }
      } catch (error) {
        log(`[asr] 转写异常（忽略）：${error?.message ?? error}`);
      }
    }
    const seqRef = event.message_seq != null ? String(event.message_seq) : '';
    const refsToStore = [...new Set([messageRef, seqRef].filter(Boolean))];
    if (refsToStore.length > 0 && mediaList.length > 0) {
      let mediaByRef = messageMediaStore.get(key);
      if (!mediaByRef) {
        mediaByRef = new Map();
        messageMediaStore.set(key, mediaByRef);
      }
      for (const ref of refsToStore) mediaByRef.set(ref, mediaList);
      // 防止无限增长：超过上限时删除最旧一条（Map 保持插入序）
      while (mediaByRef.size > MAX_MEDIA_STORE_PER_KEY) {
        const oldestKey = mediaByRef.keys().next().value;
        if (oldestKey === undefined) break;
        mediaByRef.delete(oldestKey);
      }
    }
    // 引用对象是机器人自己时，视为直接对 AI 说（即使当前文字没有 @/关键词）。
    // 因此必须先解析 quoteTargetIsSelf 再做空文本过滤，避免“只引用不附文”被漏掉。
    const quoteTargetIsSelf = await isQuoteTargetSelf(event.message ?? [], kind, id, event.self_id);
    const quotedMessageId = (Array.isArray(event.message) ? event.message : [])
      .find((seg) => seg?.type === 'reply' && seg.data?.id != null)?.data?.id ?? '';
    if (!isSessionAllowedInCurrentMode(key)) return;
    if (!plainContent && !quoteTargetIsSelf) return;
    const isOwner = String(event.user_id) === String(cfg.ownerQQ ?? '');
    // 拉黑：主人以外的人被拉黑后，消息在入库/唤醒/记忆之前直接丢掉。
    if (!isOwner && blacklistCfg().enabled && blacklistStore.isBlocked(event.user_id)) {
      log(`[blacklist] 忽略已拉黑用户 ${event.user_id} 的消息（${key}）`);
      return;
    }
    if (await handleBlacklistOwnerCommand(plainContent, { kind, isOwner, key, event })) {
      log(`[blacklist] 主人命令已处理：${plainContent.slice(0, 40)}`);
      return;
    }
    const roleState = readRoleState();

    // 若该会话有挂起的提问/审批，先当作回答处理（用当前消息自己的文字，不含引用原文）。
    // 审批只有管理员消息会被消费；群友消息不能因为“审批挂起”而被吞掉，应继续走正常处理。
    const p = pending.get(key);
    if (p && (p.kind === 'question' || isOwner)) {
      await handlePendingAnswer(p, plainContent, key, isOwner);
      return;
    }

    // 签名草稿的显式命令（发签名/不发签名/改签名 …）优先处理；空间草稿的「发/不发」仍由内心生活处理。
    if (await handleSignatureOwnerCommand(plainContent, { kind, isOwner, explicitOnly: true, replyToId: quotedMessageId })) {
      log(`[signature] 主人签名命令已处理：${plainContent.slice(0, 40)}`);
      return;
    }
    // 声线切换命令（黑化模式/软萌模式/自动声线）。
    if (await handleVoiceStyleOwnerCommand(plainContent, { kind, isOwner })) {
      log(`[voice] 主人声线命令已处理：${plainContent.slice(0, 40)}`);
      return;
    }
    // 内心生活的主人命令（发/不发空间草稿、关说说、内心状态、手动跑一次…）。
    // 放在挂起提问/审批之后：有 DSH 待回答的问题时，优先让主人回答那个。
    if (innerLife && await innerLife.handleOwnerCommand(plainContent, { kind, isOwner })) {
      log(`[inner] 主人命令已处理：${plainContent.slice(0, 40)}`);
      return;
    }
    // 只有引用签名草稿的那条回复才算微调；其他自由文本继续走正常回复。
    if (await handleSignatureOwnerCommand(plainContent, { kind, isOwner, explicitOnly: false, replyToId: quotedMessageId })) {
      log(`[signature] 主人签名微调已处理：${plainContent.slice(0, 40)}`);
      return;
    }

    // 静默模式：群友消息不投递给 agent（只记录）；管理员消息照常
    if (roleState.mode === 'silent' && !isOwner) {
      appendActivity(`${key}（静默模式）群友 ${event.user_id}：${textContent.slice(0, 80)}`);
      log(`静默模式，忽略群友消息 ${key}`);
      return;
    }

    // 主人功能：自动回复只在命中规则时接管；未命中完全走原逻辑。
    if (await maybeOwnerFeatureAutoReply(key, plainContent)) {
      log(`[ownerFeature] auto_reply 命中并已回复 ${key}`);
      return;
    }

    // 控制类话语：仅管理员（ownerQQ）可下达；群友触发直接拦截
    if (!isOwner && /进入角色扮演|退出角色扮演|切换角色|设置角色|改角色|换角色|关闭角色扮演|开启角色扮演/.test(plainContent)) {
      await sendToQQ(key, '角色切换仅管理员可在管理端操作，群内不支持。');
      return;
    }

    // 管理命令：仅管理员（ownerQQ）可用，且由桥接直接执行（硬性，不经过模型）
    if (plainContent.startsWith('/')) {
      if (!isOwner) {
        await sendToQQ(key, '管理命令仅管理员可用。');
        return;
      }
      if (plainContent === '/reset' || plainContent === '/new') {
        const old = state.sessions[key];
        if (old) {
          sessionEpoch++;
          disposeConversation(key, { scope: 'reset' });
          // 与 retireSession 一致：先终止 DSH 侧排队的工作，再归档（归档只隐藏会话）。
          try { await withTimeout(api.stopSessionWork(old), DSH_CONTROL_TIMEOUT_MS, 'stopSessionWork'); }
          catch (error) { log(`⚠️ 停止旧会话失败 ${key}：${error?.message ?? error}；请在 DSH 检查旧任务`); }
          try { await withTimeout(api.workspace.archiveSession({ sessionId: old }), DSH_CONTROL_TIMEOUT_MS, 'archiveSession'); } catch {}
          await sendToQQ(key, '已重置会话，下次消息将开新上下文');
        }
        return;
      }
      if (plainContent === '/status') {
        const rs = readRoleState();
        await sendToQQ(key, `会话 ${state.sessions[key] ?? '未创建'}；白名单 ${allowed(kind, id, cfg) ? '通过' : '拦截'}；角色 ${rs.role ?? '无'}；模式 ${rs.mode}`);
        return;
      }
      if (plainContent === '/role' || plainContent.startsWith('/role ')) {
        const name = sanitizeRoleName(plainContent.slice(5).trim());
        if (!name || name === 'off' || name === 'clear') {
          const hadRole = Boolean(roleState.role);
          writeRoleState(null, roleState.mode);
          if (hadRole) applyRoleSwitch('/role 清除角色');
          else invalidateRoleCards('/role 清除角色');
          await sendToQQ(key, '已清除角色，恢复正常人格。');
        } else {
          const roleFile = path.join(ROOT, 'personas', name + '.md');
          if (!fs.existsSync(roleFile)) {
            await sendToQQ(key, `角色「${name}」不存在。角色文件放 personas/ 目录。`);
          } else {
            const changed = String(roleState.role || '') !== name;
            writeRoleState(name, roleState.mode);
            if (changed) applyRoleSwitch(`/role 切换到 ${name}`);
            else invalidateRoleCards(`/role 重选当前角色 ${name}`);
            const custom = isCustomRoleName(name);
            await sendToQQ(key, custom
              ? `已切换角色：${name}（自定义角色，只使用角色卡）。`
              : `已切换角色：${name}（默认角色，内置人格仍生效；编辑角色卡文件不算自定义角色）。`);
          }
        }
        return;
      }
      if (plainContent === '/silent' || plainContent === '/quiet') {
        writeRoleState(roleState.role, 'silent');
        await sendToQQ(key, '已进入静默模式：群友消息不再回复，仅管理员可对话。');
        return;
      }
      if (plainContent === '/active' || plainContent === '/speak') {
        writeRoleState(roleState.role, 'active');
        await sendToQQ(key, '已退出静默模式，恢复正常回复。');
        return;
      }
      // 出门见闻：主人私聊查看最近见闻 / 立即跑一次 / 停止；复用这里的 owner 门控。
      if (plainContent === '/见闻' || plainContent.startsWith('/见闻 ')) {
        if (kind !== 'private') { await sendToQQ(key, '见闻命令仅主人私聊可用。'); return; }
        const arg = plainContent.slice('/见闻'.length).trim();
        await sendToQQ(key, arg ? outerWorldNoteDetail(arg) : outerWorldNotesText(5));
        return;
      }
      if (plainContent === '/出门') {
        if (kind !== 'private') { await sendToQQ(key, '出门命令仅主人私聊可用。'); return; }
        if (!outerWorldEnabled()) { await sendToQQ(key, '出门见闻未开启：先在功能控制里打开「出门见闻」。'); return; }
        outerWorldStore.circuit.reset();
        const result = await runOuterWorld('owner');
        await sendToQQ(key, result.ok
          ? (result.note ? `出门看完了《${result.note.title}》\n${result.note.summary}` : `这次没看：${result.reason}`)
          : `这次没看：${result.reason}`);
        return;
      }
      if (plainContent === '/停止出门') {
        if (kind !== 'private') { await sendToQQ(key, '停止出门命令仅主人私聊可用。'); return; }
        stopOuterWorld('owner-stop');
        await sendToQQ(key, '已停止出门见闻并清空排队任务；下次需要再手动 /出门。');
        return;
      }
      // 高危动作的二次确认。必须在这里拦下：不能让它进入模型上下文，
      // 否则模型可以自己“确认”自己的高危请求。
      if (plainContent === '/确认' || plainContent.startsWith('/确认 ') || plainContent === '/confirm' || plainContent.startsWith('/confirm ')) {
        const code = plainContent.replace(/^\/(?:确认|confirm)\s*/, '').trim();
        if (!/^\d{6}$/.test(code)) {
          await sendToQQ(key, '用法：/确认 123456（6 位确认码，10 分钟内有效）');
          return;
        }
        const outcome = await confirmPendingActionByCode(code, key);
        await sendToQQ(key, outcome.ok
          ? `✅ 已执行：${outcome.summary || '完成'}`
          : `❌ ${outcome.summary ? `${outcome.summary} —— ` : ''}${outcome.error}`);
        return;
      }
      // 其余 / 开头内容照常发给 DSH（DSH 的斜杠命令原样执行，如 /model）
    }

    // 群聊仿真模式（simulation）：唤醒调度
    if (currentMode === 'simulation') {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      const relationState = getSimulationState(key);
      const relationNorm = String(plainContent ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
      const repeated = relationNorm.length >= 2 && relationState.recentMessages.some((m) => m && !m.isSelf
        && String(m.userId || '') === String(event.user_id ?? '')
        && String(m.plain || m.text || '').replace(/\s+/g, ' ').trim().toLowerCase() === relationNorm
        && Date.now() - Number(m.time || 0) < 10 * 60 * 1000);
      const atSelf = Array.isArray(event.message) && event.message.some((seg) => seg?.type === 'at' && String(seg.data?.qq) === String(event.self_id));
      const relationContext = {
        text: plainContent,
        isAt: atSelf,
        isQuoteSelf: quoteTargetIsSelf,
        isQuestion: isDirectedAtAi(plainContent),
        hasVoice: Array.isArray(event.message) && event.message.some((seg) => seg?.type === 'record'),
        repeated,
        sharedInterest: topicOverlapScore(plainContent, relationState.activeTopics) > 0.4,
        directed: atSelf || quoteTargetIsSelf || Boolean(selfNickname && String(plainContent).toLowerCase().includes(selfNickname)),
        messageId: event.message_id ?? event.msg_id ?? null,
        quotedMessageId: quotedMessageId || null
      };
      appendSimulationMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, event.message_id ?? event.msg_id ?? null, mediaList, event.user_id ?? null, extractForwardIds(event.message ?? []), relationContext);
      // 仿真同样收集群聊黑话学习素材（AI 自主提交之外，桥接仍自动提取高频陌生词）
      if (kind === 'group') feedSlangWindow(key, sender, plainContent);
      if (simulation.paused) {
        appendActivity(`${key} [simulation] AI 已暂停，消息仅入库不唤醒：${textContent.slice(0, 80)}`);
        return;
      }
      const st = getSimulationState(key);
      const deepDive = isDeepDive(key);
      const deepAuthorized = deepDive && isOwner && atSelf;
      if (deepDive && !deepAuthorized) {
        appendActivity(`${key} [simulation] 深潜模式：非主人直接 @ 的消息不入唤醒队列`);
        return;
      }
      if (deepAuthorized) st.deepDivePassAt = Date.now();
      if (!st.bootstrapSent) {
        st.bootstrapSent = true;
        saveSimulationState();
        scheduleWake(key, 'bootstrap');
      } else {
        const reason = evaluateWakeTrigger(key, st, event, kind, textContent, plainContent, quoteTargetIsSelf);
        if (reason) {
          scheduleWake(key, reason);
        }
      }
      appendActivity(`${key} [simulation] 消息已入未读：${textContent.slice(0, 80)}`);
      return;
    }

    // 黑话学习素材：只从群聊普通消息进入滚动窗口（命令/角色控制语不学；只学当前消息自己的文字，不学引用原文）
    if (kind === 'group') {
      feedSlangWindow(key, event.sender?.card || event.sender?.nickname || String(event.user_id), plainContent);
    }

    // 角色扮演提示注入（仅注入给 agent，不影响群友之间的正常对话语义）
    const roleHint = currentRoleHint();

    // 群聊里带发送者信息，私聊不用；角色提示注入到消息开头（agent 可见）；
    // 管理员消息带身份标记（供 agent 识别，但其权限仍受工具面硬限制）
    const promptText = (roleHint ? roleHint + '\n\n' : '')
      + (isOwner ? '【管理员】' : '')
      + (kind === 'group'
        ? `${event.sender?.card || event.sender?.nickname || String(event.user_id)}：${textContent}`
        : textContent)
      + mediaHintFor(key, messageRef, mediaList);

    appendActivity(`${key} ${isOwner ? '管理员' : '群友'} ${event.sender?.nickname || event.user_id}：${textContent.slice(0, 80)}`);

    // 仿真群友模式：reserved 走状态机（观望/活跃/试探/退场）
    if (isSocialEnabled()) {
      const sender = kind === 'group' ? (event.sender?.card || event.sender?.nickname || String(event.user_id)) : '私聊';
      appendRecentMessage(key, sender, textContent, plainContent, quoteTargetIsSelf, isOwner, mediaList, messageRef); // AI 始终感知
      const st = socialState(key);

      // 退场中：收尾发言发出前不再接话，新消息进入摘要
      if (st.phase === 'exiting') {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 退场中，新消息转入摘要`);
        return;
      }

      // 活跃超时：即使群里一直有人说话，到达随机上限后也主动收尾退场
      if (st.phase === 'active' && triggerActiveDurationExit(key, st, Date.now())) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：${key} 活跃超时退场中，新消息转入摘要`);
        return;
      }

      // 活跃 / 试探中：有新消息 → 保持活跃（或从试探回到活跃）
      if (st.phase === 'active' || st.phase === 'probing') {
        st.phase = 'active';
        st.lastActiveMessageAt = Date.now();
        st.probeDeadline = 0;
        // 私聊：发给你就是叫你，直接即时投递，不等轮询、不参与沉默
        if (kind === 'private') {
          const promptText = `${roleHint ? roleHint + '\n\n' : ''}${isOwner ? '【管理员】' : ''}${textContent}${mediaHintFor(key, messageRef, mediaList)}`;
          scheduleSocialReply(
            key, promptText,
            Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
            Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
            '私聊即时回应',
            false,
            mediaList
          );
          log(`社交模式：${key} 私聊活跃中收到消息，即时投递`);
          return;
        }
        log(`社交模式：${key} 活跃中收到消息，等待批量检测`);
        return;
      }

      // 启动阶段（观望）：触发条件 ① 明确对 AI 说（含引用机器人自己） ② 普通消息小概率
      // 指向性判断只基于当前消息自己的文字，不把引用原文算作“在叫 AI”
      const direct = isDirectAddress(plainContent, event, kind) || quoteTargetIsSelf;
      const randomTrigger = Math.random() < Number(cfg.social?.triggerProbability ?? 0.15);
      if (!direct && !randomTrigger) {
        appendSummary(key, sender, textContent, plainContent, isOwner, mediaList, messageRef);
        log(`社交模式：观望中未触发 ${key}（${sender}：${plainContent.slice(0, 40)}）`);
        return;
      }

      // 触发成功：进入活跃，贴最近上下文 + 当前消息 + 人格（仅此一次），让 AI 回复
      enterActive(key);
      const roleHint = currentRoleHint();
      const currentLine = (isOwner && kind === 'private') ? `【管理员】${sender}：${textContent}` : `${sender}：${textContent}`;
      const directionHint = textContent.includes('[引用') ? DIRECTION_HINT + '\n' : '';
      const replyInstruction = direct
        ? `请回复消息。\n${directionHint}${SPACE_SPLIT_HINT}`
        : `请根据情况决定是否回复。如果不需要回应、想潜水/不接话，请只输出 ${SILENT_MARKER}；否则正常回复。\n${directionHint}${SPACE_SPLIT_HINT}`;
      const promptText = `${roleHint ? roleHint + '\n\n' : ''}【群聊上下文】\n${buildContextBlock(key)}\n【当前消息】${currentLine}${mediaHintFor(key, messageRef, mediaList)}\n\n${replyInstruction}`;
      if (isOwner && kind === 'private') {
        log(`社交模式：管理员私聊触发，立即投递 ${key}`);
        await deliverPrompt(key, promptText, { media: mediaList });
      } else {
        scheduleSocialReply(
          key, promptText,
          Number(cfg.social?.activeReplyDelayMinMs ?? 2000),
          Number(cfg.social?.activeReplyDelayMaxMs ?? 8000),
          '触发进入活跃',
          false,
          mediaList
        );
      }
      return;
    }

    // DSH 重启容错：DSH 不可用时消息入队（不丢），恢复后自动补投
    if (!dshReady) {
      const items = queued.get(key) ?? [];
      if (items.length >= QUEUE_MAX) {
        items.shift();
        log(`队列满（${QUEUE_MAX}），丢弃最旧消息 (${key})`);
      }
      items.push({ promptText, media: mediaList });
      queued.set(key, items);
      const now = Date.now();
      if ((queuedHintAt.get(key) ?? 0) + QUEUE_HINT_COOLDOWN_MS < now) {
        queuedHintAt.set(key, now);
        await sendToQQ(key, '⏳ 系统服务重启中，消息已排队，恢复后自动处理。');
      }
      log(`DSH 不可用，消息入队 (${key})`);
      return;
    }

    let sessionId;
    try {
      sessionId = await ensureSession(key);
    } catch (error) {
      if (String(error?.message ?? error).includes('会话创建期间已重置')) {
        enqueueForRetry(key, promptText, { media: mediaList });
        return;
      }
      throw error;
    }
    let content = [{ type: 'text', text: withSlangContext(promptText, key) }];
    if (Array.isArray(mediaList) && mediaList.length > 0) {
      const imageParts = await resolveMediaList(mediaList);
      content = [{ type: 'text', text: withSlangContext(promptText, key) }, ...imageParts];
    }
    if (!isCurrentSession(key, sessionId)) throw new Error('投递前会话已重置或权限已变化');
    const accepted = await api.sessions.prompt({
      sessionId,
      mode: 'queue',
      content
    });
    if (!accepted.result.ok) {
      const errText = `${accepted.result.error.code}: ${accepted.result.error.message}`;
      const safeErrText = shouldAuditKey(key) && SENSITIVE_RE.test(errText) ? '（含敏感信息，已隐藏）' : errText;
      log(`⚠️ 消息未被接受 (${key})：${safeErrText}`);
      // 登录过期/额度用尽时这条路径会被反复触发；兜底句每 10 分钟最多发一次。
      if (Date.now() - (Number(rejectNoticeAt.get(key)) || 0) > 10 * 60 * 1000) {
        rejectNoticeAt.set(key, Date.now());
        await sendToQQ(key, '⚠️ 消息没有被接收，稍后再试一下');
      }
      return;
    }
    if (accepted.result.value.command) {
      // 斜杠命令直接有结果，不走模型
      if (accepted.result.value.command.text) await auditAndSend(key, mdToPlain(accepted.result.value.command.text));
      return;
    }
    if (cfg.ackMessage && currentMode !== 'simulation') await sendToQQ(key, cfg.ackMessage);
    log(`已投递 ${key}: ${promptText.slice(0, 80)}${promptText.length > 80 ? '…' : ''}`);
  }

  // 取消/拒绝一个挂起的提问或审批，并给 DSH 回执（超时、被新请求覆盖时使用）
  async function cancelPendingEntry(entry) {
    if (!entry) return;
    try {
      if (entry.kind === 'approval') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: 'rejected' }
        }), 5000, '取消挂起回执');
        log(`已取消挂起审批（拒绝回执）: ${entry.eventId ?? entry.rpcId}`);
      } else if (entry.kind === 'question') {
        await withTimeout(api.respond({
          clientId: entry.clientId,
          eventId: entry.eventId,
          outcome: { kind: 'result', value: { answers: [] } }
        }), 5000, '取消挂起回执');
        log(`已取消挂起提问（空答案回执）: ${entry.eventId ?? entry.rpcId}`);
      }
    } catch (error) {
      log('取消挂起请求回执失败:', error?.message ?? error);
    }
  }

  // 回答挂起的提问/审批
  async function handlePendingAnswer(p, answerText, key, isOwner = false) {
    if (p.kind === 'question') {
      const answers = [];
      for (const q of p.questions) {
        const opts = q.options ?? [];
        const hit = opts.find((o) => o.label.trim().toLowerCase() === answerText.trim().toLowerCase());
        if (hit) answers.push({ id: q.id, selected: [hit.label] });
        else answers.push({ id: q.id, selected: [], custom: answerText });
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: { answers } }
        });
        log(`已回答提问 (${key}):`, receipt);
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('回答问题失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 回答提交失败，请再回复一次。');
      }
      return;
    }
    if (p.kind === 'approval') {
      if (!isOwner) {
        await sendToQQ(key, '审批仅管理员可操作');
        return;
      }
      const t = answerText.trim().toLowerCase();
      let outcome = null;
      for (const w of APPROVE_WORDS) if (t === w) outcome = 'allowed-once';
      for (const w of REJECT_WORDS) if (t === w) outcome = 'rejected';
      if (!outcome) {
        await sendToQQ(key, '请回复「通过」或「拒绝」来决定这个审批');
        return;
      }
      try {
        const receipt = await api.respond({
          clientId: p.clientId,
          eventId: p.eventId,
          outcome: { kind: 'result', value: outcome }
        });
        log(`已处理审批 (${key}): ${outcome}`, receipt);
        await sendToQQ(key, outcome === 'allowed-once' ? '✅ 已通过审批' : '❌ 已拒绝审批');
        // 只有回执成功才移除挂起，且必须仍是同一个挂起（防止期间被新请求覆盖）
        if (pending.get(key) === p) pending.delete(key);
      } catch (error) {
        log('处理审批失败（保留挂起以便重试）:', error.message);
        await sendToQQ(key, '⚠️ 审批回执提交失败，请再回复一次「通过」或「拒绝」。');
      }
      return;
    }
  }

  // 仿真拍一拍（notify/poke）事件处理：写入消息流并按需唤醒。
  async function handlePokeNotice(event) {
    if (!event || event.sub_type !== 'poke') return;
    const selfId = event.self_id;
    const groupId = event.group_id ?? event.groupId ?? null;
    const senderIdRaw = event.sender_id ?? event.user_id ?? event.sender?.user_id ?? null;
    const targetIdRaw = event.target_id ?? event.targetId ?? null;
    const senderId = senderIdRaw != null ? String(senderIdRaw) : '';
    const targetId = targetIdRaw != null ? String(targetIdRaw) : '';
    // 自己发出的拍一拍不回灌给 AI（避免把“我拍了别人”当成群友事件）。
    if (senderId && selfId != null && String(senderId) === String(selfId)) return;
    let key;
    let kind;
    let id;
    if (groupId != null) {
      kind = 'group';
      id = String(groupId);
      key = convKey('group', id);
    } else {
      kind = 'private';
      const peer = event.user_id ?? senderId;
      if (!peer) return;
      id = String(peer);
      key = convKey('private', id);
    }
    if (!modeAllowed(key, kind, id, cfg, currentMode)) return;
    if (currentMode !== 'simulation') {
      appendActivity(`${key} 收到拍一拍事件（非 simulation，仅记录）：${senderId} -> ${targetId}`);
      return;
    }
    let sender = senderId;
    if (kind === 'group' && senderId) {
      try {
        sender = await resolveGroupMemberName(Number(id), senderId) || senderId;
      } catch {}
    }
    const targetIsSelf = !!targetId && selfId != null && String(targetId) === String(selfId);
    const isOwner = String(senderId) === String(cfg.ownerQQ ?? '');
    const msg = appendSimulationPoke(key, {
      sender,
      userId: senderId || null,
      targetId: targetId || null,
      targetIsSelf,
      isOwner,
      groupId: groupId != null ? String(groupId) : null,
      action: event.action,
      suffix: event.suffix
    });
    appendActivity(`${key} 拍一拍事件：${msg.text.slice(0, 80)}`);
    if (currentMode !== 'simulation') return;
    if (simulation.paused) return;
    if (isDeepDive(key)) {
      appendActivity(`${key} [simulation] 深潜模式：拍一拍只记录，不反应也不唤醒`);
      return;
    }
    const st = getSimulationState(key);
    if (!st.bootstrapSent) {
      st.bootstrapSent = true;
      saveSimulationState();
      scheduleWake(key, 'bootstrap');
    } else if (st.wakeConfig?.triggers?.poke) {
      scheduleWake(key, 'poke');
    }
  }

  async function registerPending(key, entry) {
    const existing = pending.get(key);
    if (existing) {
      clearTimeout(existing.timer);
      pending.delete(key);
      log(`新挂起请求覆盖旧请求 (${key})`);
      cancelPendingEntry(existing).catch(() => {});
    }
    const timer = setTimeout(() => {
      if (pending.get(key) === entry) {
        pending.delete(key);
        log(`挂起请求超时 (${key})`);
        cancelPendingEntry(entry).catch(() => {});
        sendToQQ(key, '⏰ 等待回答超时，已取消该请求');
      }
    }, cfg.questionTimeoutMs);
    entry.timer = timer;
    pending.set(key, entry);
  }

  // DSH 事件流 → QQ

  /**
   * 把一条 session/event 喂给该会话的 turn collector，并维护 collectors 的生命周期。
   *
   * 两条不变量（都曾被真实故障踩过）：
   *   ① 只为 turn/start 建 collector —— 任何事件都建的话，一条重连后补发的
   *      assistant/message 就会留下永不结束的空 collector，而「会话是否繁忙」正是按
   *      collectors.has() 判断的 ⇒ 这个会话从此再也收不到唤醒；
   *   ② turn/end 即使没有匹配的 turn/start（重连快照没带上）也要清掉已成空壳的
   *      collector，否则同样会永久繁忙。
   */
  function trackTurnEvent(sessionId, event) {
    let collector = collectors.get(sessionId);
    if (!collector && event?.type === 'turn/start') {
      collector = createTurnCollector();
      collectors.set(sessionId, collector);
    }
    const ended = collector ? collector.push(event) : null;
    if (ended) {
      // 回合正常收尾：collector 立刻释放。simulationTurnStartAt 留给调用方（无行动判定要用它），
      // 调用方在 `if (ended)` 分支里用完再删。
      collectors.delete(sessionId);
    } else if (event?.type === 'turn/end' && (!collector || collector.size?.() === 0)) {
      collectors.delete(sessionId);
      simulationTurnStartAt.delete(sessionId);
      turnLeaseNoted.delete(sessionId);
    }
    return { collector, ended };
  }

  async function pumpMux() {
    // 事件流重连退避：DSH 侧流被立刻关闭时（例如版本不兼容，见 issue #34），
    // 固定 3 秒重连会以每分钟 20 行的速度刷屏，真正有用的错误反而被淹没。
    let retryMs = 3000;
    let failureStreak = 0;
    for (;;) {
      let framesThisStream = 0;
      try {
        log('连接 DSH 事件流…');
        for await (const envelope of api.events.mux({})) {
          framesThisStream += 1;
          const frame = envelope.payload;
          // 会话开场快照：只喂 token 账本。它含**历史** turn/end，绝不能让它们走
          // session/event 通道 —— 否则桥接会把早已结束的回合当成新回合去发 QQ 回复。
          if (frame.type === 'session/snapshot') {
            recordSessionSnapshot(frame.sessionId, frame.snapshot);
            continue;
          }
          if (frame.type === 'session/event') {
            // Token 记账放在最前面：无论会话是否仍属当前模式/是否学习会话，
            // 花掉的钱都是真的，都必须入账（归属由 resolveKey 决定）。
            recordSessionUsage(frame.sessionId, frame.event);
            if (innerLife?.isInnerSession(frame.sessionId)) {
              innerLife.handleEvent(frame.sessionId, frame.event);
              continue;
            }
            const key = reverse.get(frame.sessionId);
            if (!key) {
              // 黑话学习会话：只收集 turn，不发送 QQ，并唤醒等待中的学习任务。
              if (learnerSessions.has(frame.sessionId)) {
                // 与主 collector 同样的道理（issue #26 的补充）：**只有 turn/start 才建** collector。
                // 迟到事件（session/end-seed、session/title、model/selection…）不会有 turn/end，
                // 若在这里顺手建一个，它会永远留在 learnerCollectors 里并吞掉后续 turn 事件，
                // 等待者要么拿不到结果、要么拿到错位的文本。
                let learnerCollector = learnerCollectors.get(frame.sessionId) ?? null;
                if (!learnerCollector && frame.event.type === 'turn/start') {
                  learnerCollector = createTurnCollector();
                  learnerCollectors.set(frame.sessionId, learnerCollector);
                }
                const learnerEnded = learnerCollector ? learnerCollector.push(frame.event) : null;
                if (learnerEnded) {
                  learnerCollectors.delete(frame.sessionId);
                  const waiters = learnerWaiters.get(frame.sessionId) ?? [];
                  const waiter = waiters.shift();
                  if (waiters.length === 0) learnerWaiters.delete(frame.sessionId);
                  if (waiter) {
                    clearTimeout(waiter.timer);
                    if (learnerEnded.reason.kind === 'completed' && learnerEnded.text.trim()) {
                      waiter.resolve(learnerEnded.text);
                    } else {
                      waiter.reject(new Error(`学习会话 turn 未正常完成：${learnerEnded.reason.kind}`));
                    }
                  }
                  // 旧学习会话 turn 结束后从集合移除，避免残留
                  if (frame.sessionId !== slangLearnerSessionId) learnerSessions.delete(frame.sessionId);
                }
              }
              continue;
            }
            // 追踪当前 turn 是否成功调用过 MCP 发送类工具：
            if (!isCurrentSession(key, frame.sessionId)) continue;
            // 只有“发送成功”才跳过自动转发；如果工具调用失败，仍允许 AI 的文本正常发出。
            if (frame.event.type === 'turn/start') {
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              simulationTurnStartAt.set(frame.sessionId, Date.now());
              turnLeaseNoted.delete(frame.sessionId);
            }
            if (frame.event.type === 'tool/call') {
              const toolName = String(frame.event.data?.name ?? '');
              const callId = frame.event.data?.callId;
              const args = sanitizeToolArgs(frame.event.data?.arguments ?? frame.event.data?.input ?? frame.event.data);
              appendToolLog({ type: 'call', time: new Date().toISOString(), key, callerKey: key, sessionId: frame.sessionId, tool: toolName, args });
              if (callId != null) {
                if (isSendToolName(toolName)) {
                  let pending = pendingSendToolCalls.get(frame.sessionId);
                  if (!pending) {
                    pending = new Set();
                    pendingSendToolCalls.set(frame.sessionId, pending);
                  }
                  pending.add(callId);
                }
                let nameMap = toolCallNames.get(frame.sessionId);
                if (!nameMap) {
                  nameMap = new Map();
                  toolCallNames.set(frame.sessionId, nameMap);
                }
                nameMap.set(String(callId), toolName);
              }
            }
            if (frame.event.type === 'tool/result') {
              const callId = frame.event.data?.message?.source?.callId;
              const toolName = callId != null ? (toolCallNames.get(frame.sessionId)?.get(String(callId)) ?? '') : '';
              const resultBlock = frame.event.data?.message?.content?.[0];
              const resultError = frame.event.data?.message?.isError === true || resultBlock?.isError === true;
              const errorText = resultError ? String(resultBlock?.text ?? resultBlock?.error ?? frame.event.data?.message?.error ?? '') : '';
              appendToolLog({
                type: 'result',
                time: new Date().toISOString(),
                key,
                sessionId: frame.sessionId,
                tool: toolName,
                ok: !resultError,
                error: errorText ? sanitizeToolArgs(errorText) : null
              });
              if (callId != null) {
                toolCallNames.get(frame.sessionId)?.delete(String(callId));
                const pending = pendingSendToolCalls.get(frame.sessionId);
                if (pending?.has(callId)) {
                  pending.delete(callId);
                  if (pending.size === 0) pendingSendToolCalls.delete(frame.sessionId);
                  if (!resultError) {
                    const firstSendThisTurn = !sendToolSucceededSessions.has(frame.sessionId);
                    sendToolSucceededSessions.add(frame.sessionId);
                    if (firstSendThisTurn) {
                      try {
                        const latSt = getSimulationState(key);
                        const lat = latSt.lastIncomingAt ? Math.max(0, Date.now() - Number(latSt.lastIncomingAt)) : null;
                        if (lat != null && lat < 3600000) {
                          liveLastReplyLatency = lat;
                          liveReplyLatencies.push(lat);
                          if (liveReplyLatencies.length > 50) liveReplyLatencies.shift();
                        }
                      } catch {}
                    }
                    // 只有真正发过言，才把本回合已展示给模型的未读销账：
                    // 这样首答前的长等待仍会被 unread 闸门拦住；回复后再清积压。
                    try {
                      const ackSt = getSimulationState(key);
                      const ackThrough = computeReadThroughSeq(ackSt);
                      if (ackThrough > 0 && Array.isArray(ackSt.unread) && ackSt.unread.length) {
                        const cleared = acknowledgeMessages(ackSt, ackThrough);
                        if (cleared > 0) {
                          saveSimulationState();
                          log(`[simulation] 回复后自动销账 ${cleared} 条未读 ${key}`);
                        }
                      }
                    } catch {}
                  }
                }
              }
            }
            // collector 生命周期见 trackTurnEvent()：只为 turn/start 建、空壳 turn/end 即清。
            const { ended } = trackTurnEvent(frame.sessionId, frame.event);
            if (ended) {
              // simulation 无行动兜底：普通唤醒回合若既没发消息、也没 mark_read / set_wake_config，
              // 则累计 noActionCount；达到阈值后自动重置 WakeConfig，避免 AI 卡死。
              const silentQueueNow = social.silentTurns.get(frame.sessionId) ?? [];
              const isSilentTurn = silentQueueNow.length > 0;
              if (currentMode === 'simulation' && key && !isSilentTurn && ended.reason.kind === 'completed') {
                const st = getSimulationState(key);
                const turnStart = simulationTurnStartAt.get(frame.sessionId) ?? 0;
                const sendToolHit = sendToolSucceededSessions.has(frame.sessionId);
                // turn/start 丢了（重连后由快照补发的回合）就无从判断「这一轮有没有行动」：
                // 此时记 miss 会冤枉 AI，连续 3 次就把 AI 自己设的唤醒配置重置成默认值。
                if (turnStart > 0 || sendToolHit) {
                  const actionTaken = sendToolHit || (turnStart > 0 && st.lastActionAt >= turnStart);
                  if (actionTaken) {
                    st.wakeConfig.noActionCount = 0;
                  } else {
                    st.wakeConfig.noActionCount = (st.wakeConfig.noActionCount || 0) + 1;
                    const limit = Number(cfg.simulation?.wake?.noActionLimit) || 3;
                    if (st.wakeConfig.noActionCount >= limit) {
                      log(`[simulation] ${key} 连续 ${st.wakeConfig.noActionCount} 次唤醒无行动，重置唤醒配置`);
                      st.wakeConfig = defaultWakeConfig();
                      st.bootstrapSent = true;
                      st.wakeConfig.noActionCount = 0;
                    }
                  }
                  saveSimulationState();
                } else {
                  log(`[simulation] ${key} 回合结束但缺少 turn/start（重连补发），跳过无行动计数`);
                }
              }
              simulationTurnStartAt.delete(frame.sessionId);
              collectors.delete(frame.sessionId);
              turnLeaseNoted.delete(frame.sessionId);
              const sendToolSucceeded = sendToolSucceededSessions.has(frame.sessionId);
              sendToolSucceededSessions.delete(frame.sessionId);
              pendingSendToolCalls.delete(frame.sessionId);
              toolCallNames.delete(frame.sessionId);
              // 标记本次 turn 是否为“活跃超时退场”发言（用于准确回到观望，避免把旧回复误判为退场）
              const isFarewell = social.exitingSessions.has(frame.sessionId);
              if (isFarewell) social.exitingSessions.delete(frame.sessionId);
              // 摘要投喂触发的 turn：回复静默（不发送到 QQ）。
              // 用 FIFO 时间戳队列 + 超时回收，避免计数残留吞掉后续正常回复。
              const silentQueue = social.silentTurns.get(frame.sessionId) ?? [];
              const silentNow = Date.now();
              while (silentQueue.length && silentNow - silentQueue[0].ts > SILENT_TURN_TIMEOUT_MS) silentQueue.shift();
              if (silentQueue.length > 0) {
                silentQueue.shift();
                if (silentQueue.length > 0) social.silentTurns.set(frame.sessionId, silentQueue);
                else social.silentTurns.delete(frame.sessionId);
                log(`摘要投喂 turn 结束，静默 (${key})`);
                continue;
              }
              // simulation 防遗忘：每次唤醒回合结束时，若 AI 没有调用 qq_set_wake_config 设置下一次唤醒条件，
              // 则发送提醒；连续未设置达到上限后重置为默认唤醒配置。静默/后台提醒回合已在上方 continue，不触发。
              if (pendingWakeKeys.has(key)) {
                pendingWakeKeys.delete(key);
                disarmPendingWakeLease(key);
                if (ended.reason.kind !== 'completed') {
                  // 模型错误/中止不是“忘了收尾”：不提醒、不计数，避免提醒回合
                  // 再次失败，形成“报错 → 提醒 → 再报错”的循环。
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  log(`[simulation] ${key} 非正常结束（${ended.reason.kind}），跳过唤醒收尾提醒`);
                } else if (wakeConfigUpdatedKeys.has(key) || markReadCalledKeys.has(key)) {
                  ensureWakeable(getSimulationState(key), { key });
                  wakeConfigUpdatedKeys.delete(key);
                  markReadCalledKeys.delete(key);
                  wakeConfigMissCount.delete(key);
                } else {
                  const currentMiss = (wakeConfigMissCount.get(key) ?? 0) + 1;
                  const maxReminders = Number(cfg.simulation?.wake?.maxWakeConfigReminders) || 2;
                  if (currentMiss < maxReminders) {
                    wakeConfigMissCount.set(key, currentMiss);
                    pendingWakeKeys.add(key);
                    armPendingWakeLease(key);
                    deliverPrompt(key, buildWakeReminderPrompt(key)).then((result) => {
                      if (result && result.ok === false) {
                        pendingWakeKeys.delete(key);
                        disarmPendingWakeLease(key);
                      }
                    }).catch((error) => {
                      pendingWakeKeys.delete(key);
                      disarmPendingWakeLease(key);
                      log(`[simulation] ${key} 唤醒提醒投递失败: ${error?.message ?? error}`);
                    });
                    log(`[simulation] ${key} 未设置唤醒条件，发送提醒 (${currentMiss}/${maxReminders})`);
                  } else {
                    const st = getSimulationState(key);
                    st.wakeConfig = defaultWakeConfig();
                    saveSimulationState();
                    log(`[simulation] ${key} 连续未设置唤醒条件，已重置为默认唤醒配置`);
                  }
                }
              }
              // 繁忙期间被暂存的唤醒原因：当前 turn 结束后补一次（定时器类与消息类语义不同，
              // 详见 replayPendingWakeReasons 的注释）。
              replayPendingWakeReasons(key);
              if (ended.reason.kind === 'completed' && ended.text.trim()) {
                const plain = mdToPlain(ended.text);
                // 纯 Markdown/空白输出按“无文本”处理，避免后续 planSocialTimeline 拿空串崩溃。
                if (!plain.trim()) {
                  log(`agent 回复为空（仅格式/空白）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 空退场回合，回到观望`);
                    }
                  }
                  continue;
                }
                // 社交模式静默标记：AI 主动选择“潜水/不接话”，不发送到 QQ
                if (isSilentMarker(plain)) {
                  log(`社交模式：AI 选择静默（${SILENT_MARKER}）(${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场选择静默，回到观望`);
                    }
                  }
                  continue;
                }
                // 本回合已经通过 MCP 发送工具成功发出消息：跳过自动转发，避免重复发送。
                if (sendToolSucceeded) {
                  log(`工具已发送消息，跳过自动转发 (${key})`);
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 工具发送后退场完成，回到观望`);
                    }
                  }
                  continue;
                }
                // 审计（对完整文本执行，避免截断漏判；这里只判断，不发送，避免双重发送）
                const hasKnownToken = [...KNOWN_AGENT_TOKENS].some((t) => t && plain.includes(t));
                if (shouldAuditKey(key) && (SENSITIVE_RE.test(plain) || hasKnownToken)) {
                  log(`⚠️ 回复被安全策略拦截 (${key})，疑似包含敏感信息${hasKnownToken ? '（含会话令牌）' : ''}`);
                  appendActivity(`${key} agent 回复被拦截（疑似敏感信息${hasKnownToken ? '/会话令牌' : ''}）`);
                  if (cfg.security?.interceptNotify !== false) {
                    await sendToQQ(key, '⚠️ 本条回复因疑似包含敏感信息（路径/凭据/会话令牌）被安全策略拦截，已记录并通知管理员。');
                  }
                  if (isFarewell) {
                    const st = socialState(key);
                    if (st.phase === 'exiting') {
                      st.phase = 'idle';
                      st.activeDeadlineAt = 0;
                      st.activeExitAt = 0;
                      log(`社交模式：${key} 退场发言被拦截，回到观望`);
                    }
                  }
                  continue;
                }
                // 仿真群友模式：时间线多段发送（主回复 + 可选二次补刀）
                if (isSocialEnabled()) {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    if (isFarewell) {
                      const st = socialState(key);
                      if (st.phase === 'exiting') {
                        st.phase = 'idle';
                        st.activeDeadlineAt = 0;
                        st.activeExitAt = 0;
                        log(`社交模式：${key} 静默模式下退场回合被拦截，回到观望`);
                      }
                    }
                    continue;
                  }
                  const timeline = planSocialTimeline(plain, cfg.social);
                  const messages = timeline.main;
                  log(`agent 回复 (${key}) ${plain.length} 字 → ${messages.length} 条`);
                  appendActivity(`${key} agent 回复：${messages[0].slice(0, 80)}${messages.length > 1 ? '（分' + messages.length + '条）' : ''}${messages[0].length > 80 ? '…' : ''}`);
                  if (messages.length > 1) {
                    await sendBurstToQQ(key, messages, cfg.social);
                  } else {
                    await sendToQQ(key, messages[0]);
                  }
                  // 发言后刷新活跃时间，并调度可能的二次补刀
                  const st = socialState(key);
                  if (isFarewell) {
                    // 确认为退场发言：不再刷新活跃时间、不调度补刀，直接进入观望
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言完成，进入观望`);
                  } else if (st.phase === 'exiting') {
                    // 退场期间有旧回复恰好完成：照常发出，但不把它当作退场，也不调度补刀
                    log(`社交模式：${key} 退场期间旧回复完成，保持退场状态`);
                  } else {
                    if (lastSendSucceeded(key)) {
                      st.lastActiveMessageAt = Date.now();
                      st.lastAiReplyAt = Date.now();
                      log(`社交模式：发言完成，刷新活跃时间 (${key})`);
                    } else {
                      // 发送其实失败了（网关报错/超时/被限流）。旧代码照样刷新时间戳，
                      // 于是「我说过话了」这个判断被写进状态：主动发言概率被压低、
                      // 活跃调度往前走，而群里根本没收到消息。这里不刷新，让下一轮照常补上。
                      log(`社交模式：${key} 本轮发言未送达（QQ 发送失败），不刷新活跃时间`);
                    }
                  }
                } else if (currentMode === 'simulation') {
                  log(`[simulation] AI 内部输出（不自动转发）(${key}): ${plain.slice(0, 80)}`);
                  appendActivity(`${key} [simulation] AI 内部输出：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                } else {
                  if (shouldBlockSilentReply(key)) {
                    log(`静默模式，拦截在途回复 (${key})`);
                    appendActivity(`${key} 静默模式，拦截在途回复`);
                    continue;
                  }
                  log(`agent 回复 (${key}) ${plain.length} 字`);
                  appendActivity(`${key} agent 回复：${plain.slice(0, 80)}${plain.length > 80 ? '…' : ''}`);
                  await sendToQQ(key, plain);
                }
              } else if (ended.reason.kind === 'error') {
                const msg = ended.reason.error?.message ?? '未知错误';
                const safeMsg = shouldAuditKey(key) && SENSITIVE_RE.test(msg) ? '（含敏感信息，已隐藏）' : msg.slice(0, 500);
                const malformedToolJson = /tool input is invalid JSON/i.test(safeMsg);
                // 以前这里只发 QQ、不写日志：出问题时 bridge.log 里什么都没有，排查只能靠猜（PR #24）。
                log(`⚠️ agent 处理出错 (${key})：${safeMsg}`);
                appendActivity(`${key} agent 处理出错：${safeMsg.slice(0, 80)}`);
                if (currentMode === 'simulation') {
                  // 模型偶尔会把 messages 写成未加引号的中文原文，DSH 在解析工具参数时
                  // 直接报 MALFORMED_RESPONSE。参数没有进入 MCP，重试不会重复发送。
                  if (key && malformedToolJson) {
                    const last = Number(toolJsonRepairAt.get(key)) || 0;
                    if (Date.now() - last > 2 * 60 * 1000) {
                      toolJsonRepairAt.set(key, Date.now());
                      log(`[simulation] ${key} 工具参数 JSON 损坏，1.5s 后自动重试一次`);
                      appendActivity(`${key} 工具参数 JSON 损坏，自动重试`);
                      setTimeout(() => {
                        if (currentMode !== 'simulation' || simulation.paused || cfg.simulation?.enabled === false) return;
                        deliverPrompt(key, buildToolJsonRepairPrompt(key)).then((result) => {
                          if (result && result.ok === false) {
                            log(`[simulation] ${key} 工具参数修复提示未接受：${String(result.error?.message || result.error || 'unknown').slice(0, 160)}`);
                          }
                        }).catch((error) => {
                          log(`[simulation] ${key} 工具参数修复提示投递失败：${error?.message ?? error}`);
                        });
                      }, 1500);
                    } else {
                      log(`[simulation] ${key} 工具参数 JSON 再次损坏，本轮不自动重试（避免循环）`);
                    }
                  }
                  // 不把 DSH/上游的原始错误发到群里；瞬时网络/transport 错误只记日志，
                  // 非瞬时错误私下提醒主人一次，避免刷屏和泄底。工具 JSON 损坏走自动重试，
                  // 不再额外提醒，避免用户被同一类可恢复错误反复打扰。
                  const transient = /transport failed|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|stream.*(closed|error)|stream ended before message_stop|STREAM_CLOSED|timeout|timed out|429|502|503|overloaded/i.test(safeMsg);
                  if (!transient && !malformedToolJson && cfg.ownerQQ) {
                    const last = Number(agentErrorNotifyAt.get(key)) || 0;
                    if (Date.now() - last > 30 * 60 * 1000) {
                      agentErrorNotifyAt.set(key, Date.now());
                      void sendOwnerPrivate(`【${currentRoleName() || '小鲸鱼'}异常】${key}：${safeMsg.slice(0, 300)}`);
                    }
                  }
                } else {
                  // 普通聊天模式没有私聊兜底，只能发群里；同样限频，避免连续失败刷屏。
                  const last = Number(agentErrorNotifyAt.get(key)) || 0;
                  if (Date.now() - last > 30 * 60 * 1000) {
                    agentErrorNotifyAt.set(key, Date.now());
                    await sendToQQ(key, '⚠️ agent 处理出错了，稍后再试一下');
                  }
                }
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言出错，回到观望`);
                  }
                }
              } else if (ended.reason.kind === 'aborted') {
                log(`⏹️ 回合被中止 (${key})`);
                await sendToQQ(key, '⏹️ 已停止');
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场发言中止，回到观望`);
                  }
                }
              } else if (!ended.text.trim()) {
                // completed 但没文本（纯工具调用回合）
                log(`回合完成但无文本 (${key})`);
                if (isFarewell) {
                  const st = socialState(key);
                  if (st.phase === 'exiting') {
                    st.phase = 'idle';
                    st.activeDeadlineAt = 0;
                    st.activeExitAt = 0;
                    log(`社交模式：${key} 退场回合无文本，回到观望`);
                  }
                }
              }
            }
          } else if ((frame.type === 'question/requested' || frame.type === 'approval/requested') && learnerSessions.has(frame.sessionId)) {
            // 黑话学习会话不应向用户提问/请求审批；自动跳过，避免阻塞学习任务。
            try {
              if (frame.type === 'question/requested') {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: { answers: frame.questions.map((q) => ({ id: q.id, selected: [], custom: '' })) } }
                });
              } else {
                await api.respond({
                  clientId: frame.clientId,
                  eventId: frame.eventId,
                  outcome: { kind: 'result', value: 'rejected' }
                });
              }
              log('黑话学习会话自动跳过提问/审批');
            } catch (error) {
              log('自动响应学习会话提问/审批失败:', error?.message ?? error);
            }
          } else if (frame.type === 'question/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'question' }); continue; }
            const lines = frame.questions.map((q, i) => {
              const qText = String(q.question ?? '');
              const sensitive = shouldAuditKey(key) && SENSITIVE_RE.test(qText);
              if (sensitive) log(`⚠️ 提问文本含敏感信息，已隐藏 (${key})`);
              const safeQuestion = sensitive ? '（含敏感信息，已隐藏）' : qText;
              let s = `${i + 1}. ${safeQuestion}`;
              if (q.options?.length) {
                const opts = q.options.map((o) => {
                  const label = String(o.label ?? '');
                  const optSensitive = shouldAuditKey(key) && SENSITIVE_RE.test(label);
                  if (optSensitive) log(`⚠️ 提问选项含敏感信息，已隐藏 (${key})`);
                  return `「${optSensitive ? '（含敏感信息，已隐藏）' : label}」`;
                });
                s += '\n   ' + opts.join(' ');
              }
              return s;
            });
            await sendToQQ(key, '❓ agent 需要你回答：\n' + lines.join('\n') + '\n（直接回复选项文字或输入你的回答）');
            await registerPending(key, { kind: 'question', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, questions: frame.questions });
          } else if (frame.type === 'approval/requested') {
            const key = reverse.get(frame.sessionId);
            if (!key) continue;
            if (!isCurrentSession(key, frame.sessionId)) { await cancelPendingEntry({ ...frame, kind: 'approval' }); continue; }
            const rawReason = frame.reason ?? '';
            const sensitiveReason = shouldAuditKey(key) && SENSITIVE_RE.test(rawReason);
            if (sensitiveReason) log(`⚠️ 审批理由含敏感信息，已隐藏 (${key})`);
            const safeReason = sensitiveReason ? '（含敏感信息，已隐藏）' : rawReason;
            const reason = safeReason ? `\n理由：${safeReason}` : '';
            const rawToolName = frame.toolName ?? '';
            const sensitiveTool = shouldAuditKey(key) && SENSITIVE_RE.test(rawToolName);
            if (sensitiveTool) log(`⚠️ 审批工具名含敏感信息，已隐藏 (${key})`);
            const safeToolName = sensitiveTool ? '（含敏感信息，已隐藏）' : rawToolName;
            await sendToQQ(key, `🔐 agent 请求审批：${safeToolName}${reason}\n回复「通过」或「拒绝」`);
            await registerPending(key, { kind: 'approval', rpcId: envelope.rpcId, sessionId: frame.sessionId, clientId: frame.clientId, eventId: frame.eventId, toolName: frame.toolName });
          } else if (frame.type === 'stream/error') {
            log('事件流错误:', frame.error);
          }
        }
        // 流正常关闭（服务端主动断开）不会抛错。以前这里什么都不打，日志看起来
        // 就像「连上了、然后又连一次」，完全看不出 DSH 把流关了。
        log(`DSH 事件流已结束（本次收到 ${framesThisStream} 帧）`);
      } catch (error) {
        log('事件流中断:', error?.message ?? error);
      } finally {
        // WebSocket 正常关闭和异常中断都会走到这里；必须清掉旧 turn 相关状态，
        // 否则重连后旧 collector/标记残留会导致回复重复累加或误判。
        collectors.clear(); // 清除旧 turn collector，避免重连后残留导致重复累加
        social.silentTurns.clear(); // 清除未消费的摘要静默名额，避免重连后吞掉正常回复
        sendToolSucceededSessions.clear();
        pendingSendToolCalls.clear();
        simulationTurnStartAt.clear();
        toolCallNames.clear();
        pendingWakeKeys.clear();
        clearAllPendingWakeLeases();
        social.exitingSessions.clear();
        wakeConfigUpdatedKeys.clear();
        markReadCalledKeys.clear();
        wakeConfigMissCount.clear();
        // 长轮询（qq_wait_for_messages）的租约也要清：它的 req.on('close') 在事件流
        // 断开时不一定触发，残留租约会用 429 卡住该会话最长 15 分钟的等待工具。
        activeWaits.clear();
      }
      if (framesThisStream > 0) {
        failureStreak = 0;
        retryMs = 3000;
      } else {
        failureStreak += 1;
        retryMs = Math.min(30000, retryMs * 2);
        if (failureStreak === 3) {
          log('⚠️ 连续多次连上 DSH 事件流后一帧都没收到就断开：多半是 DSH 侧事件流协议/版本不匹配'
            + '（可在 DSH 里核对版本，或查看 issue #34）。已改为指数退避重连，不再每 3 秒刷屏。');
        }
      }
      await sleep(retryMs);
    }
  }

  // QQ 侧（SnowLuma OneBot WebSocket 客户端）
  const bot = new SnowLumaWebSocketClient({
    url: cfg.snowluma.wsUrl,
    accessToken: cfg.snowluma.accessToken || undefined,
    reconnect: true
  });

  // 传输适配层：核心只调用 transport.sendText/getMember/getForward。
  const transport = createTransport({
    kind: cfg.transport?.kind || 'snowluma',
    sendWs: async ({ kind, id, text: body }) => {
      const escaped = text(escapeCqText(body));
      return kind === 'private'
        ? withTimeout(bot.sendPrivateMessage(Number(id), escaped), SEND_TIMEOUT_MS, `QQ发送 private:${id}`)
        : withTimeout(bot.sendGroupMessage(Number(id), escaped), SEND_TIMEOUT_MS, `QQ发送 group:${id}`);
    },
    sendHttp: ({ kind, id, text: body, replyToMessageId, atUserId }) =>
      onebotSend(kind, id, body, replyToMessageId ?? null, atUserId ?? null),
    getMember: (groupId, userId, options) => bot.getGroupMemberInfo(Number(groupId), Number(userId), options),
    getForward: (forwardId) => (typeof bot.getForwardMsg === 'function' ? bot.getForwardMsg(forwardId) : null)
  });

  // ── 出站队列：先落盘，再发送；启动重放；发送中崩溃标 uncertain 不自动重发 ──
  if (storageReady && STORAGE.outboxEnabled !== false) {
    const permanent = (error) => { try { error.permanent = true; } catch {} return error; };
    outbox = new Outbox({
      db,
      maxAttempts: STORAGE.outboxMaxAttempts,
      retryBaseMs: STORAGE.outboxRetryBaseMs,
      retryMaxMs: STORAGE.outboxRetryMaxMs,
      logger: (message) => log(`[outbox] ${message}`),
      // SnowLuma 没连上时不消耗重试次数，等连接恢复再发。
      isReady: () => snowlumaHealth.connected === true,
      onTerminal: (item, state) => {
        if (item?.kind !== 'reminder') return;
        const reminderId = String(item.payload?.reminderId ?? '');
        const reminder = reminderStore.reminders.find((r) => r.id === reminderId);
        if (!reminder || reminder.status !== 'pending') return;
        reminder.lastAttemptAt = Date.now();
        if (state === 'sent') {
          reminder.status = 'sent';
          log(`[reminder] 已发送 ${reminder.id} ${reminder.key}`);
          appendActivity(`${reminder.key} [reminder] 提醒已发送：${reminder.text.slice(0, 60)}`);
        } else if (state === 'dead') {
          reminder.status = 'failed';
          log(`[reminder] 多次重试仍失败，已标记 failed ${reminder.id} ${reminder.key}`);
        } else {
          return;
        }
        saveRemindersSafe();
      },
      deliver: async (payload, item) => {
        const [kind, id] = String(item.key).split(':');
        if (!modeAllowed(item.key, kind, Number(id), cfg, currentMode)) {
          throw permanent(new Error('目标不在当前模式允许范围内'));
        }
        if (shouldBlockSilentReply(item.key)) {
          const error = new Error('静默模式：发送已暂停，等静默结束再发');
          error.holdMs = 10 * 60 * 1000;
          throw error;
        }
        const body = String(payload?.text ?? '');
        if ([...KNOWN_AGENT_TOKENS].some((t) => t && body.includes(t))) {
          throw permanent(new Error('发送内容包含会话令牌，已阻止发送'));
        }
        try {
          const result = await transport.sendText({
            key: item.key,
            text: body,
            replyToMessageId: payload.replyToMessageId ?? null,
            atUserId: payload.atUserId ?? null,
            via: payload?.transport === 'http' ? 'http' : 'ws'
          });
          return { message_id: result?.message_id ?? null };
        } catch (error) {
          if (/令牌|敏感|白名单|不允许|非法|不支持/.test(String(error?.message ?? ''))) throw permanent(error);
          throw error;
        }
      }
    });
    outbox.start({ tickMs: 15000 });
  }

  // ── 入站：先落盘 + 去重，再处理 ────────────────────────────────────────────
  // 同一条消息在 SnowLuma 重连/补发时可能来两次；processed 过的直接忽略，
  // 未 processed 的（上次崩在处理中途）照常处理 —— 不丢也不重复。
  function recordInbound(kind, id, event) {
    if (!inbox || STORAGE.inboxEnabled === false) return null;
    const key = convKey(kind, id);
    try {
      return inbox.record({
        key,
        kind,
        messageId: String(event?.message_id ?? event?.msg_id ?? ''),
        seq: event?.message_seq ?? null,
        payload: event,
        dedupeKey: inboundDedupeKey(kind, id, event)
      });
    } catch (error) {
      log(`⚠️ 入站事件落盘失败（继续处理）：${error?.message ?? error}`);
      return null;
    }
  }

  async function processInbound(kind, id, event, record) {
    if (record?.duplicate && record.processed) {
      log(`[inbox] 重复消息已忽略 ${convKey(kind, id)}`);
      return;
    }
    let errorText = null;
    try {
      await handleIncoming(kind, id, event, cfg);
    } catch (error) {
      errorText = String(error?.message ?? error);
      log(`处理${kind === 'private' ? '私聊' : '群'}消息出错:`, errorText);
    } finally {
      if (inbox && record?.id) inbox.markProcessed(record.id, { error: errorText });
    }
  }

  // 启动重放：只重放「已落盘但没处理完」且在窗口内的消息。旧消息只留审计，不自动回复。
  async function replayInbox() {
    if (!inbox || STORAGE.inboxEnabled === false) return;
    let pending = [];
    try {
      pending = inbox.pending({ maxAgeMs: STORAGE.inboxReplayMaxAgeMs });
    } catch (error) {
      log(`[inbox] 重放扫描失败：${error?.message ?? error}`);
      return;
    }
    if (!pending.length) return;
    log(`[inbox] 启动重放 ${pending.length} 条未处理消息（窗口 ${Math.round((STORAGE.inboxReplayMaxAgeMs || 0) / 1000)}s）`);
    for (const item of pending) {
      const kind = item.kind === 'private' ? 'private' : 'group';
      const id = String(item.key).split(':')[1];
      const event = item.payload ?? {};
      const messageId = String(event?.message_id ?? event?.msg_id ?? '');
      // 上次已经写进会话状态、只是没来得及标 processed：不重复投递。
      const st = simulation.conversations.get(item.key);
      const already = messageId && Array.isArray(st?.recentMessages)
        && st.recentMessages.some((m) => String(m?.ref ?? m?.messageId ?? m?.id ?? '') === messageId);
      if (already) {
        inbox.markProcessed(item.id);
        continue;
      }
      try {
        await handleIncoming(kind, id, event, cfg);
        inbox.markProcessed(item.id);
      } catch (error) {
        log(`[inbox] 重放失败 ${item.key}：${error?.message ?? error}`);
        inbox.markProcessed(item.id, { error: error?.message ?? String(error) });
      }
    }
  }

  bot.onPrivateMessage(async (event) => {
    // 统一按字符串比较：网关可能把 id 序列化成 number/string 混用，
    // 用 `===` 漏掉自己发的消息会进入正常处理（simulation 下 AI 会回答自己 / chat 下可能回复循环）。
    if (String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    const record = recordInbound('private', event?.user_id, event);
    await processInbound('private', event.user_id, event, record);
  });
  bot.onGroupMessage(async (event) => {
    if (String(event?.sender?.user_id ?? '') === String(event?.self_id ?? '')
      || String(event?.user_id ?? '') === String(event?.self_id ?? '')) return;
    const record = recordInbound('group', event?.group_id, event);
    await processInbound('group', event.group_id, event, record);
  });
  bot.onNotice('notify', async (event) => {
    try { await handlePokeNotice(event); } catch (error) { log('处理拍一拍事件出错:', error?.message ?? error); }
  });

  // ── 上游健康：任何事件包都算「SnowLuma 还活着」，心跳还额外带接收链路健康度 ──
  // 用 onEvent 挂一个**旁路**订阅（不影响主链路）：
  //   · 任意事件包 → 记账（证明 SnowLuma 进程 + WS 链路还在）；
  //   · `meta_event/heartbeat` → 读载荷里的 `status.good`。**这是主信号**：
  //     SnowLuma 每 30 秒无条件发一次心跳，而 good = online && receiveHealthy 是它对
  //     「QQ → hook → 我」这条接收链路的自评（实测核对过 1.14.9 运行时源码）。
  //     免费、及时，且**不依赖较新的运行时**。
  // 注册失败不影响主链路（不同 SDK 版本的订阅方法可能不同），所以整体包在 try 里。
  try {
    bot.onEvent((event) => {
      const post = event?.post_type;
      noteUpstreamPacket(post
        ? `${post}${event.notice_type ? `/${event.notice_type}` : ''}${event.meta_event_type ? `/${event.meta_event_type}` : ''}${event.message_type ? `/${event.message_type}` : ''}`
        : 'event');
      if (post === 'meta_event' && event?.meta_event_type === 'heartbeat') {
        // status 未在 SDK 类型里声明（OneBotMetaEvent 只声明 meta_event_type），
        // 但 OneBotBaseEvent 是 JsonObject，读取合法。
        noteReceiveHealth(event.status?.good, 'heartbeat');
        if (typeof event.status?.online === 'boolean') snowlumaHealth.accountOnline = event.status.online;
        reportSnowlumaHealth();
      }
    });
  } catch (error) {
    log(`（上游事件旁路订阅不可用，健康检测退化：${error?.message ?? error}）`);
  }

  // SnowLuma 1.14.17 起新增 bot_status（账号会话边沿）。老运行时不会发这个事件，
  // 所以它只是加分项：收到就记下来，收不到不影响其它判断。
  try {
    bot.onBotStatus((event) => {
      noteUpstreamPacket('notice/bot_status');
      const sub = String(event?.sub_type ?? '');
      snowlumaHealth.accountOnline = sub === 'online';
      if (sub === 'offline') {
        log('⚠️ SnowLuma 报告 QQ 账号会话已离线（bot_status: offline）—— QQ 侧掉线或被顶号，'
          + '在重新登录之前群里不会有任何消息进来。');
      } else if (sub === 'online') {
        log('SnowLuma 报告 QQ 账号会话已上线（bot_status: online）');
      }
    });
  } catch (error) {
    log(`（bot_status 订阅不可用（SnowLuma 运行时较旧？）：${error?.message ?? error}）`);
  }

  bot.on('open', () => {
    // 用实际连接地址（自愈后可能与 config 里的初值不同，别打印过期的那个）
    const connectedUrl = bot.url ?? cfg.snowluma.wsUrl;
    snowlumaHealth.connected = true;
    log(`SnowLuma 已连接：${connectedUrl}`);
    // 连接恢复后立刻把积压的出站消息发出去（不必等 worker 的下一轮 tick）。
    if (outbox) void outbox.drain(20).catch((error) => log(`[outbox] 连接后补发失败：${error?.message ?? error}`));
    // 「已连接」只说明与 SnowLuma 的 WebSocket 通了，**不说明 QQ 侧收得到消息** ——
    // 这个区别见 startSnowlumaWatch 的说明。这里顺手把上游健康快照刷一次。
    void pollSnowlumaStatus();
    // 读取机器人昵称（用于社交模式"被提到"识别）；重连后也会刷新
    void refreshSelfIdentity({ force: true });
    // 连接成功后顺手确认一下 token 是否已跟当前账号对齐；不一致就写回 config.json，
    // 让 MCP 工具（另一个进程）也能拿到正确的 token。
    void syncTokenToFile();
  });

  /**
   * SnowLuma 恢复连接时自愈 accessToken。
   *
   * 为什么需要：SnowLuma 的 OneBot 配置按账号分文件（config/onebot_<QQ号>.json），
   * 每个账号 token 不同。换账号登录后，config.json 里的旧 token 会 401/连不上，
   * 而 SDK 的重连会一直用**构造时**那个 token 无限重试 —— 表现为"桥接活着但收发全废"。
   * 这里在每次重连失败时重新发现当前账号的 token 并热更新，随后自愈。
   */
  /**
   * 应用自愈结果：**HTTP token 与 WS token 是两个不同的值**。
   *   - cfg.snowluma.accessToken → HTTP 调用（发语音、fetch_ptt_text、get_msg 等）与写回 config.json
   *   - bot.accessToken          → WebSocket 连接（桥接的主链路，端口 3001）
   * 只修其中一个的话，桥接仍会以 1006 反复重连（实测踩过）。
   */
  async function applyHealedTokens(r) {
    const httpToken = r.token;
    const wsToken = r.wsToken || r.token;
    // ⚠️ 端点跟随是可关的（`snowluma.followDiscoveredEndpoint: false`），默认保持原行为。
    //
    // 为什么需要这个开关：自愈会拿 `discoverSnowLumaConnection()` **发现到的** wsUrl
    // 覆盖掉配置里的值，并写回 config.json。这在"换了 QQ 账号所以端口变了"的主场景下
    // 是对的（端口确实是 per-account 的），但它**不区分**「用户写的是一个过期值」和
    // 「用户就是要指向别处」。后果：
    //   · 想跑第二个实例/指向另一份 SnowLuma 安装（多账号、测试、灰度）时，
    //     它会静默把端点改回去、连到发现到的那一份 —— 表现为"消息发到了另一个账号/群"，
    //     或者"我明明指向了 B 却一直在收 A 的消息"，很难归因；
    //   · 实测踩过：把 wsUrl 指向一个死端口想让它"别连"，启动后仍被改回真实端点并连上。
    // 关掉之后**只自愈 token**（换账号仍然能恢复），但绝不动 URL、也不写回 URL。
    const followEndpoint = cfg.snowluma?.followDiscoveredEndpoint !== false;
    const wsUrl = followEndpoint ? (r.wsUrl || cfg.snowluma.wsUrl) : cfg.snowluma.wsUrl;
    const wsChanged = bot.accessToken !== wsToken || bot.url !== wsUrl;
    bot.accessToken = wsToken || undefined;
    // 端口也是 per-account 的（实测：换账号后 WS 从 3001 之类变到别的端口），
    // 只换 token 不换 URL 会一直 1006 重连。
    bot.url = wsUrl;
    if (wsChanged) log(`🔄 SnowLuma WS 连接已更新：${wsUrl}（token ${String(wsToken).slice(0, 4)}…）`);
    if (cfg.snowluma.accessToken !== httpToken) {
      log(`🔄 SnowLuma HTTP token 已更新（来源 ${r.source}）：${String(cfg.snowluma.accessToken).slice(0, 4)}… → ${String(httpToken).slice(0, 4)}…`);
      cfg.snowluma.accessToken = httpToken;
    }
    if (!followEndpoint && r.wsUrl && r.wsUrl !== cfg.snowluma.wsUrl) {
      log(`   （已按 snowluma.followDiscoveredEndpoint=false 忽略发现到的端点 ${r.wsUrl}，继续用配置值 ${cfg.snowluma.wsUrl}）`);
    }
    // 把确认可用的端点写回 config.json：下次启动直接就对了，不用再自愈一遍。
    // ⚠️ 必须在**改 cfg 之前**算出要写什么，但写文件时对照的是**文件里**的旧值 ——
    //    这里显式传 wsUrl，且不依赖 cfg 的内存值来判断"是否需要写"。
    // 关掉端点跟随时不写 URL：否则"我设了别处"这件事会被自愈持久化地抹掉。
    const previousWsUrl = cfg.snowluma.wsUrl;
    cfg.snowluma.wsUrl = wsUrl;
    try {
      const w = persistSnowLumaEndpoint(path.join(ROOT, 'config.json'), {
        accessToken: httpToken,
        ...(followEndpoint ? { wsUrl, httpUrl: r.baseUrl } : {})
      });
      if (w.updated) log(`   已写回 config.json：${Object.keys(w.changed).join(' / ')}`);
      else log('   config.json 端点已是最新，无需改写');
      if (!followEndpoint && previousWsUrl !== wsUrl) cfg.snowluma.wsUrl = previousWsUrl;
    } catch (error) {
      log(`   ⚠️ 写回 config.json 失败：${error?.message ?? error}`);
    }
    // 更新了就让 SDK 立刻用新参数重连（否则要等下一轮退避，最长要好几秒）
    if (wsChanged) {
      try { bot.close(1000, 'token-refresh'); } catch {}
      try { bot.connect(); } catch {}
    }
    return wsChanged;
  }

  /** 只写文件、不动物件（连接已成功时用）。 */
  async function syncTokenToFile() {
    try {
      const r = persistToken(path.join(ROOT, 'config.json'), cfg.snowluma.accessToken ?? '');
      // 只记「已写回」，不打印 token 片段：日志会被贴进 issue / 截图，
      // 前 4 个字符同样是凭据的一部分（CWE-532，见 PR #13）。
      if (r.updated) log('🔄 已把当前 token 写回 config.json');
    } catch {}
  }

  let tokenHealAt = 0;
  async function healTokenIfStale(reason) {
    const now = Date.now();
    if (now - tokenHealAt < 10000) return;   // 节流：close 事件会连续触发
    tokenHealAt = now;
    try {
      const r = await discoverSnowLumaConnection({ cfg, timeoutMs: 4000 });
      if (!r.ok) {
        log(`⚠️ token 自愈失败（${reason}）：${r.error}`);
        return;
      }
      await applyHealedTokens(r);
      log(`   自愈完成：账号 ${r.self?.user_id ?? '?'}（${reason}）`);
    } catch (error) {
      log(`⚠️ token 自愈异常：${error?.message ?? error}`);
    }
  }

  bot.on('close', (info) => {
    snowlumaHealth.connected = false;
    log(`SnowLuma 连接断开（code=${info?.code ?? '?'}），重连中…`);
    // 连不上时最常见的原因就是换了 QQ 账号 → token 变了；顺手自愈。
    // 注意 1006 在**每次启动**都可能出现一次：HTTP token 与 WS token 是两个不同的值，
    // config.json 里存的是前者，WS 需要用自愈发现的那个（详见 bot.connect() 处的说明）。
    void healTokenIfStale(`close code=${info?.code ?? '?'}`);
  });
  bot.on('error', (error) => {
    // SDK 在 WS 升级被拒（401 / 建连失败）时可能**只 emit error、不 emit close**，
    // 于是挂在 close 上的 token 自愈永远不会触发 —— 表现为「桥接活着但收发全废」，
    // 用户只能靠手工改 token 绕过去（issue #19）。这里同样尝试一次（内部有 10s 节流）。
    const detail = error && typeof error === 'object'
      ? [error.code, error.message, error.reason, error.type].filter(Boolean).join(' | ')
      : String(error ?? '');
    // 空对象/无字段的 error 在日志里只会变成 “error {}”，既不可读又会被巡检误判；
    // 保留事件本身，但不把空对象当错误详情打印。
    if (detail) log(`SnowLuma 错误：${detail}`);
    else log('SnowLuma 连接事件（无详情），尝试自愈');
    void healTokenIfStale(`WS 事件 ${detail || '(无详情)'}`.slice(0, 200));
  });

  // SnowLuma 尚未就绪时不阻塞桥接启动：SDK 自带后台重连，DSH 侧照常连接。
  bot.connect().catch((error) => {
    // 说明为什么"第一次连不上"在这里几乎是**必然**的，避免用户把它当成故障：
    // SnowLuma 的 **HTTP token（默认 3000）与 WS token（默认 3001）是两个不同的值**
    // （实测：同一个账号，两者不同；config.json 只能存一个，存的是 HTTP 那个）。
    // 所以 WS 首次连接通常会被拒 → close(1006) → 触发 token 自愈（重新发现 WS token）
    // → 重连成功后才是「SnowLuma 已连接」。若 homeDir 没配/被移动/读不到 SnowLuma 的
    // config/onebot_<QQ>.json，自愈就无从下手，这时才会一直连不上 —— 那种情况请查
    // 日志里的「token 自愈失败」与 config.json 的 snowluma.homeDir。
    log(`SnowLuma 首次连接未成功（将在后台自动重连并尝试自愈 WS token）: ${error?.message ?? error}`);
  });
  log('桥接已启动。按 Ctrl+C 退出。');
  // 预热表情库：启动时同步一次 QQ 收藏表情，失败不阻塞（AI 首次调用工具时还会再试）。
  if (cfg.simulation?.sticker?.enabled !== false) {
    syncStickerLibrary(true).catch((error) => log('启动预热表情库失败:', error?.message ?? error));
  }
  innerLife = createInnerLife({
    cfg,
    api,
    log,
    stateDir: STATE_DIR,
    // 有 jobs 表时，内心生活的下一次 tick 落盘，重启后仍会执行。
    scheduler: jobQueue ? {
      enabled: () => STORAGE.jobsEnabled !== false,
      scheduleAt: (atMs) => scheduleInnerLifeTick(atMs),
      cancel: () => cancelInnerLifeTick()
    } : null,
    sendToQQ,
    onebotSend,
    lastSendSucceeded,
    getSimulationState,
    getEsportsFeed: () => esportsFeed,
    isSessionAllowedInCurrentMode,
    ensureChatModel: (sessionId) => ensureChatModel(sessionId, 'reflection'),
    resolvePresetName,
    unwrap,
    getRoleText: () => {
      const roleState = readRoleState();
      if (!roleState.role) return '';
      try { return fs.readFileSync(roleFilePath(roleState.role), 'utf8'); } catch { return ''; }
    },
    getRoleName: currentRoleName,
    isDshReady: () => dshReady,
    getMode: () => currentMode,
    isPaused: () => simulation.paused,
    mdToPlain,
    appendActivity,
    relationshipStore: relationshipStore || null,
    imageLibrary: {
      enabled: () => imageEnabled(),
      list: (query, limit) => searchImages(imageEntries, query, { limit: limit || 200 }),
      find: (ref) => findImage(imageEntries, ref),
      pathFor: (entry) => imageFilePath(imageLibraryDir(), entry),
      add: ({ buffer, name, note, tags, sourceUrl, subdir = 'share' }) => {
        const result = addImageBuffer({
          dir: imageLibraryDir(),
          entries: imageEntries,
          buffer,
          name,
          note,
          tags,
          sourceUrl,
          subdir,
          origin: 'saved'
        });
        saveImageStoreSafe();
        return result.entry;
      },
      remove: (ref) => {
        const index = imageEntries.findIndex((entry) => entry.id === ref || entry.name === ref);
        if (index < 0) return false;
        const [entry] = imageEntries.splice(index, 1);
        try { fs.rmSync(imageFilePath(imageLibraryDir(), entry), { force: true }); } catch {}
        saveImageStoreSafe();
        return true;
      },
      sendToKey: (key, ref, opts) => sendImage(key, ref, opts),
      sendManyToKey: (key, refs, opts) => sendImage(key, null, { ...(opts || {}), imageRefs: refs })
    },
    collectImageStickers: (opts) => collectImageStickersFromLibrary(opts)
  });

  // 空间评论轮询：只检测自己说说的新评论；能解析出内容就回复，拿不到内容则私下提醒主人。
  let qzoneCommentCheckBusy = false;
  const runQzoneCommentCheck = () => {
    if (qzoneCommentCheckBusy || !innerLife) return;
    if (!featureEnabled(cfg, 'qzoneCommentReply')) return;
    if (cfg.simulation?.innerLife?.enabled !== true) return;
    qzoneCommentCheckBusy = true;
    Promise.resolve(innerLife.checkQzoneComments?.())
      .catch((error) => log(`[inner] 空间评论检查失败（忽略）：${error?.message ?? error}`))
      .finally(() => { qzoneCommentCheckBusy = false; });
  };
  setTimeout(runQzoneCommentCheck, 90 * 1000).unref?.();
  setInterval(runQzoneCommentCheck, Math.max(60000, Number(cfg.simulation?.innerLife?.qzone?.commentReply?.pollMs) || 5 * 60 * 1000)).unref?.();

  if (jobQueue) {
    jobQueue.register('reminder.due', handleReminderJob);
    if (!featureHost?.has('daily-report')) jobQueue.register('dailyReport', handleDailyReportJob);
    jobQueue.register('signature.auto', handleSignatureJob);
    jobQueue.register('outerWorld.run', async () => {
      if (!outerWorldEnabled()) return { status: 'disabled', reason: 'outerWorld disabled' };
      const result = await runOuterWorld('schedule');
      if (result.reason === 'circuit-open') return { retryAfterMs: 6 * 3600 * 1000 };
      const next = nextOuterWorldAt();
      // 失败时至少等 30 分钟，避免把偶发网络错误变成连续熔断。
      return { retryAfterMs: Math.max(result.ok ? 60 * 1000 : 30 * 60 * 1000, next - Date.now()) };
    });
    jobQueue.register('inner-life.tick', async () => {
      if (!innerLife) return { retryAfterMs: 60000 };
      await innerLife.tick();
      return { status: 'ok' };
    });
    // 收藏补收：每 5 分钟重试一次，最多 6 次；成功后同步本地库并回一句。
    jobQueue.register('sticker.collect', processPendingStickers);
    if (loadPendingStickers().length) scheduleStickerCollectJob(60 * 1000);
  }
  if (featureHost) await featureHost.start();
  // 实时状态页的慢数据：群名 10 分钟、TTS 10 秒、token 汇总 30 秒；全部不阻塞主流程。
  void refreshLiveGroupNames();
  setInterval(refreshLiveGroupNames, 10 * 60 * 1000).unref?.();
  void refreshLiveFriendNames();
  setInterval(refreshLiveFriendNames, 10 * 60 * 1000).unref?.();
  // 先加载提醒/订阅状态，再抓赛果；否则首次抓取可能拿不到订阅去重状态。
  startReminderLoop();
  if (jobQueue) {
    if (!featureHost?.has('daily-report')) {
      const daily = syncDailyReportJobs();
      if (daily) log(`[dailyReport] 已登记 ${daily} 个群的日报任务`);
    }
    const sigAt = syncSignatureJob();
    if (sigAt) log(`[signature] 下次自动更新约 ${new Date(sigAt).toLocaleString('zh-CN', { hour12: false })}`);
    const outerAt = syncOuterWorldJob();
    if (outerAt) log(`[outerWorld] 下次出门见闻约 ${new Date(outerAt).toLocaleString('zh-CN', { hour12: false })}`);
    jobQueue.start();
  }
  // 启动重放放在连接建立之后：DSH/SnowLuma 没就绪时排队，不丢消息。
  setTimeout(() => { void replayInbox(); }, 3000).unref?.();
  void refreshEsportsFeed();
  setInterval(refreshEsportsFeed, Math.max(60000, Number(cfg.simulation?.esportsFeed?.refreshMs) || 300000)).unref?.();
  // 昵称可能在 QQ 侧随时改；每 5 分钟核对一次，避免身份提示一直用旧名字。
  setInterval(() => void refreshSelfIdentity(), 5 * 60 * 1000).unref?.();
  void refreshLiveTts();
  setInterval(refreshLiveTts, 30 * 1000).unref?.();
  void ensureBreezeTunnel();
  setInterval(() => void ensureBreezeTunnel(), 60 * 1000).unref?.();
  refreshLiveUsage();
  setInterval(refreshLiveUsage, 30 * 1000).unref?.();
  startDshWatch();
  startSnowlumaWatch();
  startWakeSessionReconcile();
  startConsoleServer();

  await pumpMux();
}

process.on('SIGINT', () => {
  log('退出中…');
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('SIGTERM', () => {
  saveState();
  releaseLock();
  process.exit(0);
});
process.on('unhandledRejection', (error) => {
  // 打出 stack：只记 message 的话，「偶发一次」和「已经坏了六小时」看起来一模一样。
  log('未处理异常:', error?.stack ?? error?.message ?? error);
});
/**
 * 未捕获异常兜底。
 *
 * 为什么必须有：`log()` 是从 SnowLuma SDK 的 socket 事件回调里被调用的，而 SDK 的
 * emitter 逐个调用监听器、不做任何保护。stdout 的读者（守护 cmd 窗口）一旦消失，
 * `console.log` 会抛 EPIPE —— 这个异常会一路穿过 log() → 监听器 → emit → socket 回调，
 * 变成 uncaughtException。没有兜底的话整个 24/7 进程直接死掉且不留堆栈，
 * 在 bin/boot.cmd 的重启循环里就变成「每 5 秒崩一次」。
 */
process.on('uncaughtException', (error) => {
  try { log('致命异常（进程即将退出）:', error?.stack ?? error?.message ?? error); } catch {}
  try { saveState(); } catch {}
  releaseLock();
  process.exit(1);
});
process.on('exit', () => releaseLock());

main().catch((error) => {
  console.error('[bridge] 启动失败:', error);
  process.exit(1);
});
