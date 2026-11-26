// 像素贴纸频率红自测：表情包不再饿死像素（计数/间隔解耦），默认降档，表情节奏提示不回归。
// 不触网、不发真实 QQ：harness 夹具 fetch 记录出站；HTTP 只打本地夹具控制台。
// 反证：旧码「表情包清零像素计数 + 间隔看 lastStickerAt」时，下面的触发断言会变红。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadPixelStickers, stickerTurnGate, PIXEL_STICKER_DIR } from '../services/media/pixel-stickers.js';
import { bridgeHarness } from './bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const PIXEL_BASE64 = new Set(loadPixelStickers().map((s) => fs.readFileSync(path.join(PIXEL_STICKER_DIR, s.file)).toString('base64')));
function pixelSends(h) {
  return h.calls.http.filter((c) => /send_(group|private)_msg$/.test(c.url)
    && Array.isArray(c.body?.message)
    && c.body.message.some((s) => s.type === 'image' && PIXEL_BASE64.has(String(s.data?.file || '').slice('base64://'.length))));
}

test('默认降档：minTextsSince=1、minGapMs=10min（仍可配置覆盖）', async () => {
  const h = await bridgeHarness({});
  try {
    assert.equal(h.cfg.simulation.pixelSticker.enabled, false);
    assert.equal(h.cfg.simulation.pixelSticker.minTextsSince, 1);
    assert.equal(h.cfg.simulation.pixelSticker.minGapMs, 10 * 60 * 1000);
  } finally { await h.close(); }
  const o = await bridgeHarness({ config: { simulation: { pixelSticker: { enabled: true, afterText: true, minTextsSince: 3, minGapMs: 1800000 } } } });
  try {
    assert.equal(o.cfg.simulation.pixelSticker.minTextsSince, 3, '配置覆盖必须生效');
    assert.equal(o.cfg.simulation.pixelSticker.minGapMs, 1800000);
  } finally { await o.close(); }
});

test('默认关闭：达到节奏条件也不发图、不占互斥时间戳', async () => {
  const h = await bridgeHarness({});
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 10;
    st.lastPixelStickerAt = 0;
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(pixelSends(h).length, 0, '默认关闭不得自动追加回复贴纸');
    assert.equal(st.lastPixelStickerAt, 0, '默认关闭不得占互斥时间戳');
    assert.equal(st.textSendsSinceSticker, 10, '默认关闭不得消耗像素节奏计数');
  } finally { await h.close(); }
});

test('red: 表情包发送不清零像素计数；像素发送才清零（旧码两者都清 → 红）', async () => {
  const h = await bridgeHarness({});
  try {
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 3;
    h.noteStickerSent(st, 'meme');
    assert.equal(st.textSendsSinceSticker, 3, '表情包不得清零像素节奏计数');
    assert.equal(st.textSendsSinceAnySticker, 0, '任一贴纸都清「距上次贴纸」计数（表情提示用）');
    assert.ok(st.lastStickerAt > 0, 'lastStickerAt 记账保留');
    assert.ok(st.lastMemeStickerAt > 0, '互斥时间戳保留');
    h.noteStickerSent(st, 'pixel');
    assert.equal(st.textSendsSinceSticker, 0, '像素发送才清零像素计数');
  } finally { await h.close(); }
});

test('文字发送递增像素计数：没发表情包的文字回合也能攒够门槛', async () => {
  const h = await bridgeHarness({});
  try {
    const st = h.getSimulationState('group:456');
    h.noteStickerSent(st, 'meme');
    const afterMeme = Number(st.textSendsSinceSticker) || 0;
    h.noteTextSent(st);
    assert.equal(st.textSendsSinceSticker, afterMeme + 1, '文字回合必须把像素计数顶上去');
    assert.equal(st.textSendsSinceAnySticker, 1);
  } finally { await h.close(); }
});

test('red: 表情包之后的纯文字回合能触发像素贴纸（旧码计数被清+门槛2 → 红）', async () => {
  const h = await bridgeHarness({ config: { simulation: { pixelSticker: { enabled: true, afterText: true } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    h.noteStickerSent(st, 'meme');
    h.noteTextSent(st); // 之后一个没发表情包的文字回合
    // 互斥窗口（10min）已过：上一回合的表情包不该再拦本回合
    st.lastMemeStickerAt = Date.now() - 10 * 60 * 1000 - 60000;
    st.lastStickerAt = st.lastMemeStickerAt;
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(pixelSends(h).length, 1, '文字回合应能丢出一张像素贴纸');
    assert.equal(st.textSendsSinceSticker, 0, '发出后像素计数清零');
  } finally { await h.close(); }
});

test('red: 像素间隔只看上一张像素，不被表情包的时间戳饿死（旧码看 lastStickerAt → 红）', async () => {
  const h = await bridgeHarness({ config: { simulation: { pixelSticker: { enabled: true, afterText: true } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 2;
    // 表情包 15min 前发（互斥窗口已过）；上一张像素 30min 前。
    // 旧码：间隔从 lastStickerAt 算 15min < 20min → 拦死；新码：像素间隔 30min > 10min → 放行。
    st.lastStickerAt = Date.now() - 15 * 60 * 1000;
    st.lastMemeStickerAt = st.lastStickerAt;
    st.lastPixelStickerAt = Date.now() - 30 * 60 * 1000;
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(pixelSends(h).length, 1, '表情包刚发过也不该挡住像素自己的间隔');
  } finally { await h.close(); }
});

test('像素自己的间隔仍然生效：上一张像素太近就不发', async () => {
  const h = await bridgeHarness({ config: { simulation: { pixelSticker: { enabled: true, afterText: true } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 5;
    st.lastPixelStickerAt = Date.now() - 60 * 1000; // 1min 前，远小于 10min
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(pixelSends(h).length, 0, '间隔内不得连发');
  } finally { await h.close(); }
});

test('多次触发轮换不同变体：不是一张图发到死', async () => {
  const h = await bridgeHarness({ config: { simulation: { pixelSticker: { enabled: true, afterText: true } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    for (let i = 0; i < 6; i += 1) {
      st.textSendsSinceSticker = 1;
      st.lastPixelStickerAt = 0;
      st.lastMemeStickerAt = 0;
      await h.maybeSendPixelSticker(st, 'group:456');
    }
    const sends = pixelSends(h);
    assert.equal(sends.length, 6, '锚点：六次都应发出');
    const files = new Set(sends.map((c) => c.body.message.find((s) => s.type === 'image').data.file));
    assert.ok(files.size >= 2, `六次至少挑到两种变体，实际 ${files.size} 种`);
  } finally { await h.close(); }
});

test('同回合不双发保留：像素先发后表情包闸不放行（allowMeme=false）', async () => {
  const h = await bridgeHarness({ config: { simulation: { pixelSticker: { enabled: true } } } });
  try {
    const st = h.getSimulationState('group:456');
    h.noteStickerSent(st, 'pixel');
    const gate = stickerTurnGate({ lastMemeStickerAt: st.lastMemeStickerAt, lastPixelStickerAt: st.lastPixelStickerAt });
    assert.equal(gate.allowMeme, false, '本回合已发像素，表情包必须让路');
    assert.equal(gate.allowPixel, true);
  } finally { await h.close(); }
});

test('表情节奏提示不回归：刚发过表情包不催；像素计数高也不误催（旧语义保持）', async () => {
  const h = await bridgeHarness({});
  try {
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 5; // 像素计数再高……
    st.textSendsSinceAnySticker = 0; // ……只要刚发过任一贴纸，表情提示就该安静
    assert.equal(h.buildStickerCadenceLine(st, { enabled: true }), '');
    st.textSendsSinceAnySticker = 1;
    assert.match(h.buildStickerCadenceLine(st, { enabled: true }), /表情节奏/);
    st.textSendsSinceAnySticker = 3;
    assert.match(h.buildStickerCadenceLine(st, { enabled: true }), /主动挑一张/);
  } finally { await h.close(); }
});

test('旧状态兼容：没有 textSendsSinceAnySticker 的旧文件用旧计数续上', async () => {
  const h = await bridgeHarness({
    files: { 'state/simulation.json': { conversations: { 'group:456': { textSendsSinceSticker: 4 } } } }
  });
  try {
    const st = h.getSimulationState('group:456');
    assert.equal(st.textSendsSinceSticker, 4);
    assert.equal(st.textSendsSinceAnySticker, 4, '旧状态加载后表情节奏提示不跳变');
  } finally { await h.close(); }
});

test('接线锁：像素计数仅 pixel 清零、间隔看 lastPixelStickerAt、提示用 any 计数', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'app', 'whale.js'), 'utf8');
  assert.ok(bridge.includes("if (kind === 'pixel') {"), 'noteStickerSent 应按 kind 分支');
  assert.ok(!/st\.textSendsSinceSticker = 0;\s*\n\s*st\.textSendsSinceMedia/.test(bridge), '不得在 kind 分支外清零像素计数');
  assert.ok(bridge.includes('const last = Number(st.lastPixelStickerAt) || 0;'), '像素间隔应看上一张像素');
  assert.ok(bridge.includes('Number(st.textSendsSinceAnySticker) || 0'), '表情节奏提示应用任一贴纸计数');
});
