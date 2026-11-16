// 像素贴纸 × 表情包 同回合互斥 红自测。
// 不触网、不发真实 QQ：harness 夹具 fetch 记录出站；HTTP 只打本地夹具控制台。
// 反证：turnWindowMs=0（等价旧码无闸）时同一场景会两者同发，证明断言非空转。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function pixelSends(h) {
  return h.calls.http.filter((c) => /send_(group|private)_msg$/.test(c.url)
    && Array.isArray(c.body?.message)
    && c.body.message.some((s) => s.type === 'image' && String(s.data?.file || '').startsWith('base64://')));
}

test('基线：本回合没发过任何贴纸 → 像素贴纸按节奏发出', async () => {
  const h = await bridgeHarness({ config: { simulation: { pixelSticker: { minTextsSince: 1, minGapMs: 60000 } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 2;
    st.lastStickerAt = 0;
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(pixelSends(h).length, 1, '无互斥冲突时应丢一张像素贴纸');
    assert.ok(st.lastPixelStickerAt > 0, '像素贴纸应登记本回合时间戳');
    assert.equal(st.lastMemeStickerAt || 0, 0);
  } finally { await h.close(); }
});

test('red: 本回合已发表情包 → 像素贴纸跳过（旧码无闸会同发）', async () => {
  const h = await bridgeHarness({ config: { simulation: { pixelSticker: { minTextsSince: 1, minGapMs: 60000 } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    h.noteStickerSent(st, 'meme');
    st.textSendsSinceSticker = 2;
    st.lastStickerAt = Date.now() - 120000;
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(pixelSends(h).length, 0, '表情包先发后，本回合不得再丢像素贴纸');
  } finally { await h.close(); }
});

test('反证：turnWindowMs=0（等价旧码）同一场景两者同发 → 证明上条断言非空转', async () => {
  const h = await bridgeHarness({ config: { simulation: { pixelSticker: { minTextsSince: 1, minGapMs: 60000, turnWindowMs: 0 } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    h.noteStickerSent(st, 'meme');
    st.textSendsSinceSticker = 2;
    st.lastStickerAt = Date.now() - 120000;
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(pixelSends(h).length, 1, '关闸后旧行为复现：表情包+像素贴纸同发');
  } finally { await h.close(); }
});

test('red: 排队竞态——像素贴纸在途时表情包落地 → 发出前复查放弃像素', async () => {
  const h = await bridgeHarness({ config: { simulation: { pixelSticker: { minTextsSince: 1, minGapMs: 60000 } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 2;
    st.lastStickerAt = 0;
    const pending = h.maybeSendPixelSticker(st, 'group:456');
    h.noteStickerSent(st, 'meme');
    await pending;
    assert.equal(pixelSends(h).length, 0, '排队期间表情包落地，像素贴纸必须放弃');
  } finally { await h.close(); }
});

test('red: 同回合双像素钩子只发一张（旧码两张都发）', async () => {
  const h = await bridgeHarness({ config: { simulation: { pixelSticker: { minTextsSince: 1, minGapMs: 60000 } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 2;
    st.lastStickerAt = 0;
    await Promise.all([
      h.maybeSendPixelSticker(st, 'group:456'),
      h.maybeSendPixelSticker(st, 'group:456')
    ]);
    assert.equal(pixelSends(h).length, 1, '同一回合并发像素钩子只允许一张');
  } finally { await h.close(); }
});

test('red: 本回合已丢像素贴纸 → agent 的 qq_send_sticker 工具被 409 拦下', async () => {
  const h = await bridgeHarness({
    config: { consoleAuth: { enabled: false }, simulation: { pixelSticker: { minTextsSince: 1, minGapMs: 60000 } } },
    files: { 'state/stickers.json': [{ id: 'fixture-meme', desc: '夹具表情', source: 'qq', url: 'https://public.invalid/meme.png' }] }
  });
  let server = null;
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 2;
    st.lastStickerAt = 0;
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(pixelSends(h).length, 1, '锚点：像素贴纸先发出');
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/simulation/send-sticker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': st.agentToken },
      body: JSON.stringify({ key: 'group:456', stickerId: 'fixture-meme' })
    });
    const body = await res.json();
    assert.equal(res.status, 409, 'agent 通道同回合叠加表情包应被 409 拦下');
    assert.match(body.error, /像素贴纸/);
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('回滚：像素发送失败必须释放占坑，表情包工具不被 409', async () => {
  const h = await bridgeHarness({
    config: { consoleAuth: { enabled: false }, simulation: { pixelSticker: { minTextsSince: 1, minGapMs: 60000 } } },
    files: { 'state/stickers.json': [{ id: 'fixture-meme', desc: '夹具表情', source: 'qq', url: 'https://public.invalid/meme.png' }] }
  });
  let server = null;
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 2;
    st.lastStickerAt = 0;
    const pending = h.maybeSendPixelSticker(st, 'group:456');
    h.setMode('closed-agent');
    await pending;
    assert.equal(pixelSends(h).length, 0, '守卫失败：像素未发出');
    assert.equal(Number(st.lastPixelStickerAt) || 0, 0, '失败必须回滚像素占坑');
    h.setMode('simulation');
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/simulation/send-sticker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': st.agentToken },
      body: JSON.stringify({ key: 'group:456', stickerId: 'fixture-meme' })
    });
    assert.notEqual(res.status, 409, '像素失败后表情包工具不应被占坑拦下');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('turn/start 清零互斥时间戳：新回合恢复按节奏发', async () => {
  const h = await bridgeHarness({
    config: { simulation: { pixelSticker: { minTextsSince: 1, minGapMs: 60000 } } },
    savedState: { sessions: { 'group:456': 'sess-turn-1' }, sessionPolicies: {} }
  });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    h.noteStickerSent(st, 'meme');
    assert.ok(st.lastMemeStickerAt > 0);
    h.trackTurnEvent('sess-turn-1', { type: 'turn/start', data: { turn: 't1' } });
    assert.equal(st.lastMemeStickerAt, 0, '新回合开始应清零表情包时间戳');
    assert.equal(st.lastPixelStickerAt, 0);
    st.textSendsSinceSticker = 2;
    st.lastStickerAt = 0;
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(pixelSends(h).length, 1, '新回合里像素贴纸恢复正常节奏');
  } finally { await h.close(); }
});

test('接线锁：互斥闸挂在像素钩子/表情工具/turn 事件三处', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'app', 'whale.js'), 'utf8');
  assert.ok(bridge.includes('if (!gateNow().allowPixel) return;'), '像素钩子开头应查互斥闸');
  assert.ok(bridge.includes('if (!gateNow().allowPixel) { resolve(null); return; }'), '像素发出前应复查互斥闸');
  assert.ok(bridge.includes('if (!gate.allowMeme) {'), 'qq_send_sticker 应查互斥闸');
  assert.ok(bridge.includes("noteStickerSent(st, 'pixel')"), '像素成功应登记 pixel 时间戳');
  assert.ok(bridge.includes('turnSt.lastMemeStickerAt = 0;'), 'turn/start 应清零互斥时间戳');
  assert.ok(bridge.includes('function claimStickerTurn(st, kind)'), '应有同步占坑函数');
  assert.ok(bridge.includes("const releasePixelClaim = claimStickerTurn(st, 'pixel');"), '像素应在排队前同步占坑');
  assert.ok(bridge.includes("releaseMemeClaim = claimStickerTurn(st, 'meme');"), '表情包工具应在 await 发送前同步占坑');
  assert.ok(bridge.includes('if (!sentData) { releasePixelClaim(); return; }'), '像素复查放弃应回滚占坑');
  assert.ok(bridge.includes('} catch { releasePixelClaim(); }'), '像素发送失败应回滚占坑');
  assert.ok(bridge.includes('if (releaseMemeClaim) releaseMemeClaim();'), '表情包发送失败应回滚占坑');
});