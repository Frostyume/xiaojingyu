// Stage 2 桥接层集成回归：价值评分接入唤醒、上下文旋转/摘要、prompt 预算、模型路由、长期记忆注入。
// 复用 audit-bridge-harness（离线、假 DSH/SnowLuma、临时 state）。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

const quietNight = { socialV2: { nightQuiet: { enabled: false } } };

await test('S1 价值评分：泛监听低价值消息不唤醒，@ 仍然直达', async () => {
  const h = await bridgeHarness({ config: quietNight });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.wakeConfig.triggers = { ...st.wakeConfig.triggers, anyMessage: true, atMention: true, nameMention: false, keywords: [], question: false, probability: 0 };
    st.recentMessages = Array.from({ length: 6 }, () => ({ isSelf: true, time: Date.now() - 1000 }));
    const event = { self_id: '999', message: [], sender: { card: '甲' }, user_id: '111' };
    const quiet = h.evaluateWakeTriggerV2('group:456', st, event, 'group', '嗯嗯', '嗯嗯', false);
    assert.equal(quiet, null, '复读/低信息量消息不应唤醒');
    assert.ok(st.scoreStats.defer + st.scoreStats.ignore >= 1, '应记录评分统计');

    const atEvent = { self_id: '999', message: [{ type: 'at', data: { qq: '999' } }], sender: { card: '甲' }, user_id: '111' };
    const at = h.evaluateWakeTriggerV2('group:456', st, atEvent, 'group', '@小鲸鱼 在吗', '在吗', false);
    assert.equal(at, 'atMention', '@ 必须直达唤醒');
  } finally { await h.close(); }
});

await test('S2 上下文旋转：归档旧会话 + 生成衔接摘要并只注入一次', async () => {
  const h = await bridgeHarness({ config: { socialV2: { context: { rotateAtTokens: 1000, digestMaxChars: 800 } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    st.lastContextTokens = 5000;
    st.activeTopics = [{ text: '周末去爬山', lastMentionAt: Date.now() }];
    st.recentMessages = [{ sender: '甲', plain: '周末去爬山吗', time: Date.now(), isSelf: false }];
    h.state.sessions['group:456'] = 'fixture-old';
    const rotated = h.maybeRotateSessionForContext('group:456', st, 'timeout');
    assert.equal(rotated, true, '超过阈值应旋转');
    assert.equal(h.state.sessions['group:456'], undefined, '旧映射应退役');
    assert.match(String(st.pendingDigest), /爬山/);
    assert.equal(st.lastContextTokens, 0);

    const prompt = h.buildWakePromptV2('group:456', 'timeout');
    assert.match(prompt, /衔接摘要/);
    assert.match(prompt, /爬山/);
    assert.equal(st.pendingDigest, '', '摘要只注入一次');
  } finally { await h.close(); }
});

await test('S3 prompt 预算：小预算显著缩短，但关键段保留', async () => {
  const long = await bridgeHarness({ config: { socialV2: { context: { wakeBudgetTokens: 20000 } } } });
  const short = await bridgeHarness({ config: { socialV2: { context: { wakeBudgetTokens: 900 } } } });
  try {
    long.setMode('reserved2');
    short.setMode('reserved2');
    const a = long.buildWakePromptV2('group:456', 'timeout');
    const b = short.buildWakePromptV2('group:456', 'timeout');
    assert.ok(a.length > b.length, '小预算应更短');
    assert.ok(b.length < a.length * 0.85, `预算应带来明显缩短（${a.length} → ${b.length}）`);
    assert.match(b, /会话令牌/, '核心段不得被裁掉');
    assert.match(b, /当前时间/);
  } finally { await long.close(); await short.close(); }
});

await test('S4 模型路由：chat tier 覆盖默认模型', async () => {
  const h = await bridgeHarness({
    config: { routing: { enabled: true, tiers: { chat: { provider: 'fixture-provider', model: 'tier-chat-model', effort: 'low' } } } }
  });
  try {
    h.setMode('reserved2');
    await h.ensureSession('group:456');
    const applied = h.calls.models.at(-1);
    assert.equal(applied?.model, 'tier-chat-model');
    assert.equal(applied?.reasoningEffort, 'low');
  } finally { await h.close(); }
});

await test('S5 长期记忆：旧事实在新一轮 prompt 中可检索', async () => {
  const h = await bridgeHarness({ config: { socialV2: { memory: { enabled: true, topK: 5 } } } });
  try {
    h.setMode('reserved2');
    const st = h.getSocialV2State('group:456');
    h.appendMemoryV2(st, 'activeTopic', '主人喜欢下雨天', { key: 'group:456' });
    // 模拟轻量数组已滚动掉这条旧话题，只剩 FTS 里的事实
    st.activeTopics = [];
    st.recentMessages = [{ sender: '甲', plain: '主人喜欢下雨天吗', time: Date.now(), isSelf: false }];
    const prompt = h.buildWakePromptV2('group:456', 'timeout');
    assert.match(prompt, /长期记忆/, '应注入长期记忆块');
    assert.match(prompt, /下雨天/);
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\nStage 2 桥接集成：${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\nStage 2 桥接集成全部通过');
}
