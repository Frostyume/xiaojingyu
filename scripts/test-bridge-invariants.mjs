#!/usr/bin/env node
/**
 * 桥接不变量：把「重构不能悄悄改掉的东西」钉死。
 *
 * 这里的断言都只依赖 harness 暴露的内部符号与纯状态操作：
 *   1. 内部符号面（导出契约）—— bridge.js 每次重构都会挪函数，但下面这些名字
 *      是对外/对测试的稳定面，删改必须显式改本文件并说明原因；
 *   2. 会话状态按 key 隔离 —— 两个会话互不污染（P4 收成 dispose(key) 的前提）；
 *   3. 白名单硬边界 —— 非白名单目标不允许发出任何消息；
 *   4. 未知会话退役不得抛错 —— /reset、模式切换、会话过期都会走到这里。
 */
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

const SURFACE = [
  'ensureSession', 'deliverPrompt', 'drainPromptQueue', 'sendToQQ', 'sendSticker',
  'handleIncoming', 'startConsoleServer', 'getSimulationState', 'appendSimulationMessage',
  'recordSentMessages', 'buildWakePrompt', 'buildWakeSnapshot', 'sendWakePrompt',
  'relationshipsEnabledForKey', 'buildRelationshipSnapshot', 'buildLiveSnapshot',
  'refreshMode', 'modeAllowed', 'trackTurnEvent', 'replayPendingWakeReasons',
  'setupSleepTimer', 'getInitialPrompt', 'setInitialPrompt', 'formatInitialPrompt',
  'extractMediaFromSegments', 'segmentsToText', 'resolveMediaList', 'isConversationBusy',
  'evaluateWakeTrigger', 'wakeScoreDecision', 'buildContextDigest',
  'maybeRotateSessionForContext', 'isNightQuietNow', 'nightQuietConfig', 'buildToneNudgeLine',
  'scheduleClingyFollowUp', 'flushQueue', 'retireSession', 'disposeConversation', 'voiceBudgetCheck', 'sendVoiceFile',
  'assertOutboundAuditOk', 'setMode', 'setReady', 'setPresets', 'setSnowlumaConnected', 'closeStorage'
];

const h = await bridgeHarness({ config: { simulation: { valueScore: { enabled: false } } } });
try {
  // 1) 导出契约
  const missing = SURFACE.filter((name) => typeof h[name] !== 'function');
  assert.deepEqual(missing, [], `harness 导出面缺少符号：${missing.join(', ')}`);
  for (const name of ['cfg', 'state', 'simulation']) {
    assert(h[name] && typeof h[name] === 'object', `harness 应暴露对象 ${name}`);
  }
  // 这两个是容器/存储句柄，可能是 null（功能关闭时），但名字必须还在。
  for (const name of ['relationshipStore', 'collectors']) {
    assert(Object.hasOwn(h, name), `harness 导出面缺少 ${name}`);
  }

  // 2) 会话状态隔离：改 A 不得影响 B
  const a = h.getSimulationState('group:456');
  const b = h.getSimulationState('group:789');
  assert.notEqual(a, b, '不同 key 必须拿到不同状态对象');
  a.unread.push({ seq: 1, text: '只属于 A' });
  a.marker = 'A-only';
  b.unread.push({ seq: 1, text: '只属于 B' });
  assert.equal(h.getSimulationState('group:456').unread.length, 1);
  assert.equal(h.getSimulationState('group:789').unread.length, 1);
  assert.equal(h.getSimulationState('group:456').unread[0].text, '只属于 A');
  assert.equal(h.getSimulationState('group:789').unread[0].text, '只属于 B');
  assert.equal(h.getSimulationState('group:456').marker, 'A-only');
  assert.equal(h.getSimulationState('group:789').marker, undefined, '自定义字段不应串到别的 key');
  assert.equal(h.getSimulationState('group:789'), b, '同一 key 应返回同一对象（单写者语义）');

  // 3) 白名单硬边界：非白名单目标一条都发不出去
  h.setMode('simulation');
  const before = h.calls.sent.length;
  for (const target of ['private:99999', 'group:99999']) {
    // sendToQQ 自身吞掉错误（只记 lastSendFailed），所以断言看的是"有没有真的到网关"。
    await h.sendToQQ(target, '边界测试');
    assert.equal(h.calls.sent.length, before, `非白名单目标 ${target} 不得真正发出`);
  }

  // 4) 未知会话退役：不得抛错，也不得凭空造会话
  h.retireSession('group:404404');
  assert.equal(h.getSimulationState('group:404404').unread.length, 0, '退役未知会话不应带入残留');

  // 5) disposeConversation：两条撤销路径的边界不能互相污染
  //    mapping（白名单/模式变化）：保留会话记录、轮换令牌、复位 bootstrap
  const keepKey = 'group:456';
  const kept = h.getSimulationState(keepKey);
  kept.bootstrapSent = true;
  const tokenBefore = kept.agentToken;
  h.disposeConversation(keepKey, { scope: 'mapping' });
  assert.equal(h.simulation.conversations.get(keepKey), kept, 'mapping 必须保留会话记录');
  assert.notEqual(kept.agentToken, tokenBefore, 'mapping 必须轮换 agentToken（旧令牌立即失效）');
  assert.equal(kept.bootstrapSent, false, 'mapping 必须复位 bootstrapSent（新会话要重新注入初始提示词）');

  //    reset（/reset、session-reset）：连会话记录一起丢弃
  const resetKey = 'group:789';
  h.getSimulationState(resetKey);
  h.disposeConversation(resetKey, { scope: 'reset' });
  assert.equal(h.simulation.conversations.has(resetKey), false, 'reset 必须丢弃会话记录');

  //    session 映射与权限元数据必须一起消失，否则会永久残留在 sessions.json 里
  const sid = await h.ensureSession('private:123');
  assert.equal(h.state.sessions['private:123'], sid);
  assert.equal(h.disposeConversation('private:123', { scope: 'reset' }), sid, 'dispose 应返回被撤销的 sessionId');
  assert.equal(h.state.sessions['private:123'], undefined);
  assert.equal(h.state.sessionPolicies['private:123'], undefined, '权限元数据不得成为孤儿');

  console.log(`bridge invariants checks passed (${SURFACE.length} symbols)`);
} finally {
  await h.close();
}
