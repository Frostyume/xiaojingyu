#!/usr/bin/env node
/**
 * 功能控制链路：在真实 bridge 实例上验证「控制台关掉 → 配置落盘 → 入口拒绝 → 打开恢复」。
 *
 * 只起临时 config/state 与假 DSH/网关（tests/bridge-harness.mjs），
 * 不连真实 QQ、不向任何群/私聊/空间发送消息。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { bridgeHarness } from './bridge-harness.mjs';
import { FEATURE_CARDS } from '../runtime/control/feature-control.js';

function request(port, pathname, { method = 'GET', token = '', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}` };
    if (token) headers['x-console-token'] = token;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers.origin = `http://127.0.0.1:${port}`;
    }
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

const h = await bridgeHarness({
  config: {
    // 开局：总开关全开，语音/日报子开关也开，便于验证「关掉后真的拦住」。
    features: {
      disabled: [], qzone: true, qzoneCommentReply: true, signature: true, voice: true,
      share: true, shareModule: true, aiTips: true, lifeFun: true, financeTips: true,
      llmTips: true, s16Share: true, customShare: true,
      dailyReport: true, esportsFeed: true, ownerFeature: true
    },
    simulation: {
      nightQuiet: { enabled: false },
      voice: { enabled: true },
      innerLife: {
        enabled: true,
        qzone: { enabled: true, commentReply: { enabled: true } },
        aiTips: { enabled: true },
        groupShare: { enabled: true }
      },
      shareModules: { enabled: true },
      signature: { enabled: true },
      outerWorld: { leisure: { enabled: true } },
      esportsFeed: { enabled: true },
      dailyReport: { enabled: true, at: '21:30', maxItems: 8, groups: ['group:456'] },
      ownerFeatures: { enabled: true }
    }
  },
  files: {
    // 语音 dryRun 只做本地探测；一个非空 .silk 文件足够，不会真的发出去。
    'audio/fixture.silk': 'silk-fixture-bytes',
    'config.example.json': JSON.stringify({ simulation: { dailyReport: { at: '21:30', maxItems: 8 } } })
  }
});

let server;
try {
  server = h.startConsoleServer();
  await new Promise((resolve, reject) => {
    if (server.listening) return resolve();
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = server.address().port;
  const token = String(h.cfg.consoleToken);
  const call = (pathname, opts) => request(port, pathname, { token, ...opts });
  // harness 在 bot.onPrivateMessage 处提前 return，inner-life 尚未创建；这里放一个最小桩，
  // 让控制台入口能走到「总开关判定」这一层（发送动作本身仍由假网关记账）。
  h.setInnerLife({
    runJob: async () => ({ status: 'fixture' }),
    runShareModule: async () => ({ status: 'fixture' }),
    previewAiTip: async () => ({ status: 'dryRun' }),
    handleOwnerCommand: async () => false
  });

  // ── 1. 端点快照：5 板块 / 20 卡片 / 群聊剧场与分享引擎总闸 ─────────────
  const snap = await call('/api/features/control');
  assert.equal(snap.status, 200, 'GET /api/features/control 应成功');
  assert.equal(snap.json.ok, true);
  assert.deepEqual(snap.json.boards.map((b) => b.id), ['chat', 'shareEngine', 'social', 'ops', 'owner']);
  assert.equal(snap.json.boards.find((b) => b.id === 'chat').master, 'groupChat');
  assert.equal(snap.json.boards.find((b) => b.id === 'shareEngine').master, 'shareModule');
  assert.deepEqual(snap.json.modules.map((m) => m.id).sort(), FEATURE_CARDS.map((c) => c.id).sort());
  assert.equal(snap.json.modules.length, 21);
  for (const module of snap.json.modules) {
    assert.equal(typeof module.enabled, 'boolean', `${module.id} 必须只有一个布尔主开关`);
    assert.ok(module.board, `${module.id} 必须归属板块`);
    assert.equal(module.dependencies.every((d) => d.ok === true), true, `${module.id} 依赖应就绪`);
  }
  assert.equal(snap.json.modules.find((m) => m.id === 'qzone').enabled, true);
  assert.equal(snap.json.modules.find((m) => m.id === 'groupChat').enabled, true, '群聊剧场默认开');
  const chatModules = snap.json.boards.find((b) => b.id === 'chat').modules.map((m) => m.id);
  assert.deepEqual(chatModules, ['groupChat', 'chatActivity', 'chatProactive', 'chatStickers', 'chatNightQuiet']);
  for (const id of ['aiTips', 'lifeFun', 'financeTips', 'llmTips', 's16Share', 'customShare']) {
    const module = snap.json.modules.find((m) => m.id === id);
    assert.equal(module.board, 'shareEngine', `${id} 应归入分享引擎板块`);
    assert.ok(module.dependencies.some((d) => d.key === 'features.shareModule' && d.ok), `${id} 应声明分享引擎总闸依赖`);
  }
  console.log('OK 快照：5 板块 / 20 模块 / 群聊剧场与分享引擎总闸');

  // ── 2. 关闭空间说说：配置落盘 + HTTP 入口拒绝 ──────────────────────────
  const offQzone = await call('/api/features/control', { method: 'POST', body: { id: 'qzone', enabled: false } });
  assert.equal(offQzone.status, 200);
  assert.equal(offQzone.json.ok, true);
  assert.equal(offQzone.json.enabled, false);
  assert.ok(offQzone.json.applied.includes('features.qzone'));
  assert.equal(h.cfg.features.qzone, false, '运行期 cfg 必须立即热更新');
  const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
  assert.equal(saved.features.qzone, false, '关闭必须写入 config.json');

  const runQzone = await call('/api/inner-life/run', { method: 'POST', body: { job: 'qzone', force: true } });
  assert.equal(runQzone.status, 403);
  assert.equal(runQzone.json.disabled, true);
  assert.equal(runQzone.json.reason, 'features.qzone=false');
  const previewCuriosity = await call('/api/inner-life/run', { method: 'POST', body: { job: 'curiosity', force: true, dryRun: true } });
  assert.equal(previewCuriosity.status, 200, '预览不发送，应当保留可用');
  console.log('OK 空间说说：关闭后 force 也不能绕过，dryRun 预览仍可用');

  // ── 3. 关闭签名 / 赛事 / 语音：各自入口返回统一 403 ───────────────────
  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'signature', enabled: false } })).status, 200);
  const applySignature = await call('/api/signature/apply', { method: 'POST', body: { text: '离线测试签名' } });
  assert.equal(applySignature.status, 403);
  assert.equal(applySignature.json.reason, 'features.signature=false');

  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'esportsFeed', enabled: false } })).status, 200);
  const refreshEsports = await call('/api/esports/refresh', { method: 'POST', body: {} });
  assert.equal(refreshEsports.status, 403);
  assert.equal(refreshEsports.json.reason, 'features.esportsFeed=false');

  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'voice', enabled: false } })).status, 200);
  const voicePreview = await call('/api/voice/send', { method: 'POST', body: { target: 'group:456', file: 'fixture.silk', dryRun: true } });
  assert.equal(voicePreview.status, 200, '操作者预览不受总开关影响');
  assert.equal(voicePreview.json.dryRun, true);
  const voiceSend = await call('/api/voice/send', { method: 'POST', body: { target: 'group:456', file: 'fixture.silk' } });
  assert.equal(voiceSend.status, 403);
  assert.equal(voiceSend.json.reason, 'features.voice=false');
  const aiVoice = await call('/api/simulation/send-voice', { method: 'POST', body: { key: 'group:456', file: 'fixture.silk' } });
  assert.equal(aiVoice.status, 403);
  assert.equal(aiVoice.json.reason, 'features.voice=false');
  console.log('OK 签名 / 赛事 / 语音：关闭后统一 403，语音预览例外');

  // ── 3b. 群日报：关闭后任务直接 disabled；打开后越过总闸（模式不符只顺延）──
  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'dailyReport', enabled: false } })).status, 200);
  const reportOff = await h.handleDailyReportJob({ key: 'group:456', payload: { date: '2000-01-01' } });
  assert.equal(reportOff.status, 'disabled');
  assert.equal(reportOff.reason, 'features.dailyReport=false');
  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'dailyReport', enabled: true } })).status, 200);
  const reportOn = await h.handleDailyReportJob({ key: 'group:456', payload: { date: '2000-01-01' } });
  assert.notEqual(reportOn.status, 'disabled', '打开后日报任务应继续走原模式/静默检查');
  assert.notEqual(reportOn.reason, 'features.dailyReport=false');
  console.log('OK 群日报：关闭时任务 disabled，打开后恢复原调度');

  // ── 3c. 群聊剧场：卡片直接写 simulation.*，总闸关闭时子卡片 blocked ───
  const offProactive = await call('/api/features/control', { method: 'POST', body: { id: 'chatProactive', enabled: false } });
  assert.equal(offProactive.status, 200);
  assert.ok(offProactive.json.applied.includes('simulation.proactive.enabled'));
  assert.equal(h.cfg.simulation.proactive.enabled, false);
  assert.equal(h.cfg.features.chatProactive, undefined, '群聊卡片不能新造 features.* 键');
  const savedChat = JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8'));
  assert.equal(savedChat.simulation.proactive.enabled, false, '群聊卡片必须写入原配置键');
  const proactiveOffSnap = await call('/api/features/control');
  assert.equal(proactiveOffSnap.json.modules.find((m) => m.id === 'chatProactive').enabled, false);
  assert.equal(proactiveOffSnap.json.modules.find((m) => m.id === 'chatProactive').state, 'off');
  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'chatProactive', enabled: true } })).status, 200);
  assert.equal(h.cfg.simulation.proactive.enabled, true);
  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'chatNightQuiet', enabled: true } })).status, 200);
  assert.equal(h.cfg.simulation.nightQuiet.enabled, true);

  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'groupChat', enabled: false } })).status, 200);
  assert.equal(h.cfg.simulation.enabled, false);
  const chatOffSnap = await call('/api/features/control');
  for (const id of ['chatProactive', 'chatStickers', 'chatNightQuiet']) {
    const module = chatOffSnap.json.modules.find((m) => m.id === id);
    assert.equal(module.enabled, true, `${id} 自己的开关保持不变`);
    assert.equal(module.state, 'blocked', `群聊总闸关闭后 ${id} 应被阻断`);
    assert.equal(module.dependencies.find((d) => d.key === 'simulation.enabled').ok, false);
  }
  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'chatNightQuiet', enabled: true } })).status, 200);
  assert.equal(h.cfg.simulation.enabled, true, '打开子卡片应自动补开群聊总闸');
  console.log('OK 群聊剧场：configKey 写回 simulation.*，总闸阻断子卡片，子卡片自动补开总闸');

  // 活跃控制：开=active、关=diving；高级设置里的深潜开关独立布尔。
  assert.equal(chatOffSnap.json.modules.find((m) => m.id === 'chatActivity').state, 'off', '默认潜水时活跃控制应为关');
  const activityOn = await call('/api/features/control', { method: 'POST', body: { id: 'chatActivity', enabled: true } });
  assert.equal(activityOn.status, 200);
  assert.ok(activityOn.json.applied.includes('simulation.wake.defaultMode'));
  assert.equal(h.cfg.simulation.wake.defaultMode, 'active', '打开活跃控制要热更新到 defaultMode');
  const activitySnap = await call('/api/features/control');
  assert.equal(activitySnap.json.modules.find((m) => m.id === 'chatActivity').enabled, true);
  assert.match(activitySnap.json.modules.find((m) => m.id === 'chatActivity').statusLine, /活跃/);
  const deepOn = await call('/api/features/advanced', { method: 'POST', body: { id: 'chatActivity', values: { 'simulation.activityControl.deepDive': true } } });
  assert.equal(deepOn.status, 200);
  assert.equal(h.cfg.simulation.activityControl.deepDive, true);
  await call('/api/features/control', { method: 'POST', body: { id: 'chatActivity', enabled: false } });
  assert.equal(h.cfg.simulation.wake.defaultMode, 'diving', '关闭活跃控制要写回 diving');
  const deepSnap = await call('/api/features/control');
  assert.match(deepSnap.json.modules.find((m) => m.id === 'chatActivity').statusLine, /深潜/);
  await call('/api/features/advanced', { method: 'POST', body: { id: 'chatActivity', values: { 'simulation.activityControl.deepDive': false } } });

  // ── 3d. 多入口同步：功能页与旧群聊剧场页读同一份配置，双向可见 ─────────
  await call('/api/features/control', { method: 'POST', body: { id: 'chatProactive', enabled: false } });
  const simAfterFeature = await call('/api/simulation/config');
  assert.equal(simAfterFeature.json.config.proactive.enabled, false, '功能页关闭后旧页面必须读到同一值');
  assert.equal((await call('/api/simulation/config', { method: 'POST', body: { proactive: { enabled: true } } })).status, 200);
  let synced = await call('/api/features/control');
  assert.equal(synced.json.modules.find((m) => m.id === 'chatProactive').enabled, true, '旧页面打开后功能页必须同步');
  assert.equal(h.cfg.simulation.proactive.enabled, true);
  await call('/api/simulation/config', { method: 'POST', body: { enabled: false } });
  synced = await call('/api/features/control');
  assert.equal(synced.json.modules.find((m) => m.id === 'groupChat').enabled, false, '旧页面关总闸后功能页同步关闭');
  assert.equal(synced.json.modules.find((m) => m.id === 'chatProactive').state, 'blocked');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).simulation.enabled, false, '旧页面写入也必须落盘');
  await call('/api/simulation/config', { method: 'POST', body: { enabled: true } });
  assert.equal(h.cfg.simulation.enabled, true);
  console.log('OK 多入口同步：功能页与旧群聊剧场页双向一致');

  // ── 3e. 主动冒泡定时器：关闭时取消，触发瞬间再校验一次 ─────────────────
  h.setMode('simulation');
  await call('/api/features/control', { method: 'POST', body: { id: 'chatProactive', enabled: true } });
  h.cfg.simulation.proactive = {
    ...(h.cfg.simulation.proactive || {}),
    enabled: true, probability: 1, idleThresholdMs: 1, checkIntervalMinMs: 60000, checkIntervalMaxMs: 60000
  };
  const chatKey = 'group:456';
  const st = h.getSimulationState(chatKey);
  st.lastIncomingAt = 0;
  const sentinel = { mode: 'passive', infinite: true, triggers: {} };
  st.wakeConfig = sentinel;
  h.scheduleProactiveCheck(chatKey);
  assert.ok(st.proactiveTimer, '应排上主动冒泡定时器');
  const queued = st.proactiveTimer;
  await call('/api/features/control', { method: 'POST', body: { id: 'chatProactive', enabled: false } });
  assert.equal(st.proactiveTimer, null, '关闭主动冒泡必须取消已排队定时器');
  // 竞态：定时器已被取出、配置同时被关掉 —— 触发时仍要再判一次。
  h.cfg.simulation.proactive.enabled = false;
  queued.__fixtureCallback();
  assert.equal(st.wakeConfig, sentinel, '关闭后触发的定时器必须直接返回，不再做任何调度');
  assert.notEqual(st.lastWakeReason, 'proactiveCheck');
  // 正对照：同样触发、开关打开时应继续执行（无效唤醒配置会被重置）。
  h.cfg.simulation.proactive.enabled = true;
  st.wakeConfig = sentinel;
  h.scheduleProactiveCheck(chatKey);
  const queued2 = st.proactiveTimer;
  assert.ok(queued2, '重新打开后应能再排定时器');
  queued2.__fixtureCallback();
  assert.notEqual(st.wakeConfig, sentinel, '开关打开时定时器应继续执行');
  // 总闸关闭时不应再排新的主动冒泡。
  h.cfg.simulation.proactive.enabled = true;
  h.cfg.simulation.enabled = false;
  st.proactiveTimer = null;
  h.scheduleProactiveCheck(chatKey);
  assert.equal(st.proactiveTimer, null, '群聊总闸关闭时不应排主动冒泡');
  h.cfg.simulation.enabled = true;
  h.setMode('chat');
  await call('/api/features/control', { method: 'POST', body: { id: 'chatProactive', enabled: true } });
  console.log('OK 主动冒泡：关闭取消定时器，触发瞬间二次校验');

  // ── 3f. 深潜：群聊只允许主人直接 @，私聊不受影响，定时行为全部失效 ─────
  h.setMode('simulation');
  h.cfg.simulation.wake.defaultMode = 'diving';
  h.cfg.simulation.activityControl = { deepDive: true };
  const deepKey = 'group:456';
  const deepState = h.getSimulationState(deepKey);
  deepState.wakeConfig = {
    mode: 'active', infinite: true, confirmedBy: 'admin',
    triggers: { atMention: true, nameMention: true, keywords: ['小鲸鱼'], question: true, poke: true, anyMessage: true, speakerIds: ['777'], probability: 1 }
  };
  deepState.proactiveTimer = null;
  deepState.sleepTimer = null;
  const eventOf = (userId, segments) => ({
    self_id: 999, user_id: userId, message: segments, raw_message: '小鲸鱼 在吗',
    sender: { nickname: '测试群友', card: '测试群友' }
  });
  const textSeg = [{ type: 'text', data: { text: '小鲸鱼 在吗' } }];
  const atSeg = [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '在吗' } }];
  assert.equal(h.globalActivityMode(), 'deep');
  assert.equal(h.isDeepDive(deepKey), true);
  assert.equal(h.isDeepDive('private:123'), false, '深潜只作用于群聊');
  assert.equal(h.evaluateWakeTrigger(deepKey, deepState, eventOf(777, textSeg), 'group', '小鲸鱼 在吗', '小鲸鱼 在吗', false), null,
    '深潜下非主人的关键词/提问/概率都不唤醒');
  assert.equal(h.evaluateWakeTrigger(deepKey, deepState, eventOf(123, textSeg), 'group', '小鲸鱼 在吗', '小鲸鱼 在吗', false), null,
    '深潜下主人不直接 @ 也不唤醒');
  assert.equal(h.evaluateWakeTrigger(deepKey, deepState, eventOf(123, textSeg), 'group', '小鲸鱼 在吗', '小鲸鱼 在吗', true), null,
    '引用她也不算直接 @');
  assert.equal(h.evaluateWakeTrigger(deepKey, deepState, eventOf(123, atSeg), 'group', '[@小鲸鱼] 在吗', '在吗', false), 'ownerAtMention',
    '深潜下主人本人直接 @ 才唤醒');
  assert.equal(h.evaluateWakeTrigger('private:123', deepState, eventOf(123, textSeg), 'private', '在吗', '在吗', false), 'private',
    '主人私聊不受深潜限制');
  h.scheduleProactiveCheck(deepKey);
  assert.equal(deepState.proactiveTimer, null, '深潜不排主动冒泡');
  h.setupSleepTimer(deepKey);
  assert.equal(deepState.sleepTimer, null, '深潜不排睡眠到期唤醒');
  await h.handleIncoming('group', '456', eventOf(777, textSeg), h.cfg);
  for (let i = 0; i < 20; i += 1) await new Promise((resolve) => setImmediate(resolve));
  assert.equal(deepState.pendingWakeTimer, null, '深潜下非主人群消息不排唤醒');
  // 全局活跃优先于深潜（深潜属于潜水层的加固）；状态行会提示深潜暂不生效。
  h.cfg.simulation.wake.defaultMode = 'active';
  assert.equal(h.globalActivityMode(), 'active');
  assert.equal(h.isDeepDive(deepKey), false);
  h.cfg.simulation.wake.defaultMode = 'diving';
  console.log('OK 深潜：仅主人直接 @ 放行，私聊不受影响，主动/睡眠/进线均被拦截');

  // ── 3g. 全局优先：潜水压住会话 anyMessage，活跃不吞定向触发 ───────────
  h.cfg.simulation.activityControl.deepDive = false;
  h.cfg.simulation.wake.defaultMode = 'diving';
  h.cfg.simulation.valueScore = { enabled: false };
  const prioKey = 'group:456';
  const prioState = h.getSimulationState(prioKey);
  const prioEvent = (userId, text = '随便聊聊') => ({
    self_id: 999, user_id: userId, message: [{ type: 'text', data: { text } }],
    raw_message: text, sender: { nickname: '测试群友', card: '测试群友' }
  });
  const prioAt = (userId) => ({
    ...prioEvent(userId, '在吗'),
    message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '在吗' } }]
  });
  prioState.wakeConfig = {
    mode: 'active', infinite: true, confirmedBy: 'set_wake_config',
    triggers: { atMention: true, nameMention: true, keywords: ['暗号'], question: true, poke: true, anyMessage: true, speakerIds: [], probability: 0 }
  };
  assert.equal(h.evaluateWakeTrigger(prioKey, prioState, prioEvent(777), 'group', '随便聊聊', '随便聊聊', false), null,
    '全局潜水必须压住会话 anyMessage（即使会话 mode=active）');
  assert.equal(h.evaluateWakeTrigger(prioKey, prioState, prioAt(777), 'group', '[@小鲸鱼] 在吗', '在吗', false), 'atMention',
    '全局潜水时显式 @ 仍唤醒');
  assert.equal(h.evaluateWakeTrigger(prioKey, prioState, prioEvent(777, '暗号 在吗'), 'group', '暗号 在吗', '暗号 在吗', false), 'keyword:暗号',
    '全局潜水时关键词仍唤醒');

  h.cfg.simulation.wake.defaultMode = 'active';
  h.cfg.simulation.valueScore = { enabled: true, minScore: 99 };
  prioState.wakeConfig = {
    mode: 'diving', infinite: true, confirmedBy: 'set_wake_config',
    triggers: { atMention: false, nameMention: false, keywords: [], question: false, poke: false, anyMessage: false, speakerIds: ['777'], probability: 0 }
  };
  assert.equal(h.evaluateWakeTrigger(prioKey, prioState, prioEvent(777), 'group', '随便聊聊', '随便聊聊', false), 'speaker:测试群友',
    '全局活跃且评分 defer 时仍应命中指定成员');
  prioState.wakeConfig.triggers = { atMention: false, nameMention: false, keywords: [], question: false, poke: false, anyMessage: false, speakerIds: [], probability: 0 };
  assert.equal(h.evaluateWakeTrigger(prioKey, prioState, prioEvent(777), 'group', '随便聊聊', '随便聊聊', false), null,
    '全局活跃但评分不通过且无定向触发时不唤醒');
  h.cfg.simulation.valueScore = { enabled: false };
  assert.match(h.evaluateWakeTrigger(prioKey, prioState, prioEvent(777), 'group', '随便聊聊', '随便聊聊', false), /^anyMessage:score/,
    '全局活跃且评分通过时走泛监听');

  h.cfg.simulation.wake.defaultMode = 'diving';
  h.cfg.simulation.activityControl.deepDive = true;
  assert.equal(h.evaluateWakeTrigger(prioKey, prioState, prioAt(123), 'group', '[@小鲸鱼] 在吗', '在吗', false), 'ownerAtMention',
    '全局深潜仅主人直接 @ 唤醒');
  assert.equal(h.evaluateWakeTrigger(prioKey, prioState, prioAt(777), 'group', '[@小鲸鱼] 在吗', '在吗', false), null,
    '全局深潜非主人直接 @ 也不唤醒');
  h.cfg.simulation.activityControl.deepDive = false;
  console.log('OK 全局优先：潜水压住会话 anyMessage，活跃评分不吞指定成员/概率');

  // ── 4. 分享引擎总闸 / 模块开关：两层各拦一次 ───────────────────────────
  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'shareModule', enabled: false } })).status, 200);
  const runModule = await call('/api/inner-life/share-modules', { method: 'POST', body: { action: 'run', id: 'offline-demo' } });
  assert.equal(runModule.status, 403);
  assert.equal(runModule.json.reason, 'features.shareModule=false');
  const runBuiltin = await call('/api/inner-life/share-modules', { method: 'POST', body: { action: 'run', id: 'ai_tips' } });
  assert.equal(runBuiltin.status, 403);
  assert.equal(runBuiltin.json.reason, 'features.shareModule=false', '总闸关闭时内置模块也停');
  const runCuriosity = await call('/api/inner-life/run', { method: 'POST', body: { job: 'curiosity', force: true } });
  assert.equal(runCuriosity.status, 403);
  assert.equal(runCuriosity.json.reason, 'features.shareModule=false');

  const onEngine = await call('/api/features/control', { method: 'POST', body: { id: 'shareModule', enabled: true } });
  assert.equal(onEngine.status, 200);
  assert.equal(h.cfg.features.shareModule, true);
  assert.equal(h.cfg.simulation.innerLife.enabled, true, '打开引擎总闸应补齐内心生活总开关');
  assert.equal(h.cfg.simulation.shareModules.enabled, true, '打开引擎总闸应补齐分享模块子开关');

  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'aiTips', enabled: false } })).status, 200);
  const runTips = await call('/api/inner-life/ai-tips', { method: 'POST', body: { action: 'run' } });
  assert.equal(runTips.status, 403);
  assert.equal(runTips.json.reason, 'features.aiTips=false');
  const previewTips = await call('/api/inner-life/ai-tips', { method: 'POST', body: { action: 'run', dryRun: true } });
  assert.equal(previewTips.status, 200, 'AI 小知识预览仍可用');

  // 模块之间互不影响：关掉生活趣闻，AI 小知识和自建模块照常。
  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'aiTips', enabled: true } })).status, 200);
  assert.equal((await call('/api/features/control', { method: 'POST', body: { id: 'lifeFun', enabled: false } })).status, 200);
  const runLifeFun = await call('/api/inner-life/share-modules', { method: 'POST', body: { action: 'run', id: 'life_fun' } });
  assert.equal(runLifeFun.status, 403);
  assert.equal(runLifeFun.json.reason, 'features.lifeFun=false');
  const runAiTips = await call('/api/inner-life/share-modules', { method: 'POST', body: { action: 'run', id: 'ai_tips' } });
  assert.equal(runAiTips.status, 200, '关掉一个模块不能牵连另一个');
  const runCustom = await call('/api/inner-life/share-modules', { method: 'POST', body: { action: 'run', id: 'offline-demo' } });
  assert.equal(runCustom.status, 200, '自建模块归 customShare，仍应可用');
  console.log('OK 分享引擎：总闸先拦、模块各自隔离、预览保留');

  // ── 5. 重新打开：子开关自动补齐，入口恢复 ─────────────────────────────
  const onQzone = await call('/api/features/control', { method: 'POST', body: { id: 'qzone', enabled: true } });
  assert.equal(onQzone.status, 200);
  assert.equal(h.cfg.features.qzone, true);
  assert.equal(h.cfg.simulation.innerLife.qzone.enabled, true, '打开主开关应补齐空间子开关');
  assert.equal(h.cfg.simulation.innerLife.enabled, true, '打开主开关应补齐内心生活总开关');
  const runQzoneAgain = await call('/api/inner-life/run', { method: 'POST', body: { job: 'qzone', force: true } });
  assert.equal(runQzoneAgain.status, 200, '重新打开后入口恢复');

  // ── 6. 旧版 features.disabled 黑名单：打开主开关时顺带清掉同 id ────────
  await call('/api/features/control', { method: 'POST', body: { id: 'voice', enabled: true } });
  assert.equal(h.cfg.features.voice, true);
  h.cfg.features.disabled = ['voice'];
  const onLegacy = await call('/api/features/control', { method: 'POST', body: { id: 'voice', enabled: true } });
  assert.equal(onLegacy.status, 200);
  assert.equal(h.cfg.features.disabled.includes('voice'), false, '打开主开关应清掉旧黑名单项');
  assert.equal(h.cfg.features.voice, true);
  console.log('OK 恢复与旧版 features.disabled 兼容');

  // ── 7. 高级设置：保存/校验/恢复默认 ───────────────────────────────────
  const bad = await call('/api/features/advanced', { method: 'POST', body: { id: 'dailyReport', values: { 'simulation.dailyReport.at': '25:99' } } });
  assert.equal(bad.status, 400, '非法时间必须拒绝');
  const advanced = await call('/api/features/advanced', { method: 'POST', body: { id: 'dailyReport', values: { 'simulation.dailyReport.at': '22:00', 'simulation.dailyReport.maxItems': 8 } } });
  assert.equal(advanced.status, 200);
  assert.equal(h.cfg.simulation.dailyReport.at, '22:00');
  assert.equal(JSON.parse(fs.readFileSync(path.join(h.temp, 'config.json'), 'utf8')).simulation.dailyReport.at, '22:00');
  const reset = await call('/api/features/reset-advanced', { method: 'POST', body: { id: 'dailyReport' } });
  assert.equal(reset.status, 200);
  assert.equal(h.cfg.simulation.dailyReport.at, '21:30', '恢复默认应回到 config.example.json 的值');

  const unknown = await call('/api/features/control', { method: 'POST', body: { id: 'not-a-feature', enabled: true } });
  assert.equal(unknown.status, 400);
  const nonBool = await call('/api/features/control', { method: 'POST', body: { id: 'qzone', enabled: 'yes' } });
  assert.equal(nonBool.status, 400);
  console.log('OK 高级设置保存 / 非法值拒绝 / 恢复默认 / 未知模块拒绝');

  console.log('\n功能控制运行期链路全部通过');
} finally {
  if (server) await new Promise((resolve) => server.close(resolve));
  await h.close();
}
