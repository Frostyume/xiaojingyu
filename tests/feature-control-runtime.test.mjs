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
    previewAiTip: async () => ({ status: 'dryRun' })
  });

  // ── 1. 端点快照：4 板块 / 15 卡片 / 分享引擎总闸 ──────────────────────
  const snap = await call('/api/features/control');
  assert.equal(snap.status, 200, 'GET /api/features/control 应成功');
  assert.equal(snap.json.ok, true);
  assert.deepEqual(snap.json.boards.map((b) => b.id), ['shareEngine', 'social', 'ops', 'owner']);
  assert.equal(snap.json.boards.find((b) => b.id === 'shareEngine').master, 'shareModule');
  assert.deepEqual(snap.json.modules.map((m) => m.id).sort(), FEATURE_CARDS.map((c) => c.id).sort());
  assert.equal(snap.json.modules.length, 15);
  for (const module of snap.json.modules) {
    assert.equal(typeof module.enabled, 'boolean', `${module.id} 必须只有一个布尔主开关`);
    assert.ok(module.board, `${module.id} 必须归属板块`);
    assert.equal(module.dependencies.every((d) => d.ok === true), true, `${module.id} 依赖应就绪`);
  }
  assert.equal(snap.json.modules.find((m) => m.id === 'qzone').enabled, true);
  for (const id of ['aiTips', 'lifeFun', 'financeTips', 'llmTips', 's16Share', 'customShare']) {
    const module = snap.json.modules.find((m) => m.id === id);
    assert.equal(module.board, 'shareEngine', `${id} 应归入分享引擎板块`);
    assert.ok(module.dependencies.some((d) => d.key === 'features.shareModule' && d.ok), `${id} 应声明分享引擎总闸依赖`);
  }
  console.log('OK 快照：4 板块 / 15 模块 / 分享引擎总闸');

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
