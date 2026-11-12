// 像素贴纸 + 心情语音 红自测。
// 资产层红测在旧码上真的变红（旧素材白底、无库/改色库）；节奏闸门为新增纯函数。
// 不触网、不发真实 QQ：只读资产/纯函数/配置与卡片登记。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { loadPixelStickers, pixelStickerCount, pickPixelSticker, pixelStickerMoods } from '../services/media/pixel-stickers.js';
import { moodVoiceCadenceOk, MOOD_VOICE_DEFAULTS } from '../services/media/mood-voice-cadence.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ASSETS = path.join(ROOT, 'web', 'assets');
const LIB = path.join(ASSETS, 'pixel-stickers');

// 读 PNG 角落 alpha，判断背景是否透明（不依赖 Pillow）。
function cornerAlpha(file) {
  const buf = fs.readFileSync(file);
  // PNG IHDR: width/height at 16/20, bit depth 24, color type 25.
  const colorType = buf[25];
  if (colorType !== 6) return 255; // 非 RGBA 视为不透明
  let off = 8; const idat = [];
  let w = 0;
  while (off < buf.length) {
    const len = buf.readUInt32BE(off); const type = buf.toString('ascii', off + 4, off + 8);
    if (type === 'IHDR') { w = buf.readUInt32BE(off + 8); }
    if (type === 'IDAT') idat.push(buf.subarray(off + 8, off + 8 + len));
    off += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  // 首扫描线首像素：所有 filter 在 left/up=0 时都还原为原始字节，故 raw[4] 即 alpha。
  return raw[4];
}

test('red: 基础像素素材背景透明（旧白底素材在此变红）', () => {
  for (const name of ['whale-pixel-excited.png', 'whale-pixel-idle.png', 'whale-pixel-wave.png']) {
    const f = path.join(ASSETS, name);
    assert.ok(fs.existsSync(f), `锚点：素材存在 ${name}`);
    assert.equal(cornerAlpha(f), 0, `${name} 角落必须透明（旧白底=255 变红）`);
  }
});

test('red: 像素贴纸库保持人设（原色/无挂饰）且透明（旧改色/挂饰库在此变红）', () => {
  assert.ok(fs.existsSync(path.join(LIB, 'manifest.json')), '锚点：manifest 存在');
  const all = loadPixelStickers();
  const n = all.length;
  assert.ok(n >= 20, `库应>=20 张保持人设变体，实际 ${n}`);
  // 人设护栏：绝不允许改色(hue)或加挂饰(accessory)；只允许翻转+裁剪。
  for (const s of all) {
    assert.ok(s.hue === undefined || s.hue === 0, `不得改色：${s.file}`);
    assert.ok(s.accessory === undefined || s.accessory === 'none', `不得加挂饰：${s.file}`);
    assert.ok(['full', 'head'].includes(s.crop), `裁剪类型合法：${s.file}`);
  }
  const moods = pixelStickerMoods();
  for (const m of ['happy', 'idle', 'pout', 'tired', 'excited']) assert.ok(moods.includes(m), `心情 ${m} 应在库中`);
  const pick = pickPixelSticker('happy', () => 0);
  assert.ok(pick && fs.existsSync(pick.path));
  assert.equal(cornerAlpha(pick.path), 0, '变体背景必须透明');
});

test('pickPixelSticker：按心情挑、未知心情退回全库、空库返回 null', () => {
  const p = pickPixelSticker('pout', () => 0);
  assert.equal(p.mood, 'pout');
  const fallback = pickPixelSticker('no-such-mood', () => 0);
  assert.ok(fallback && fallback.file);
  assert.ok(loadPixelStickers().length > 0);
});

test('moodVoiceCadenceOk：不是每天一条也不是天天一堆（每日上限+最小间隔）', () => {
  const now = Date.UTC(2026, 10, 12, 12, 0, 0);
  // 空历史：放行
  assert.equal(moodVoiceCadenceOk({ times: [], now }).ok, true);
  // 最小间隔内：拒
  assert.equal(moodVoiceCadenceOk({ times: [now - 60000], now, minGapMs: 5 * 3600000 }).ok, false);
  assert.equal(moodVoiceCadenceOk({ times: [now - 60000], now, minGapMs: 5 * 3600000 }).reason, 'gap');
  // 间隔够但当日已达上限：拒
  const day = [now - 6 * 3600000, now - 7 * 3600000, now - 8 * 3600000];
  assert.equal(moodVoiceCadenceOk({ times: day, now, maxPerDay: 3, minGapMs: 3600000 }).ok, false);
  assert.equal(moodVoiceCadenceOk({ times: day, now, maxPerDay: 3, minGapMs: 3600000 }).reason, 'daily');
  // 间隔够且当日未满：放行
  assert.equal(moodVoiceCadenceOk({ times: [now - 6 * 3600000], now, maxPerDay: 3, minGapMs: 3600000 }).ok, true);
  // 跨天重置：昨天的不计入今天
  const yesterday = now - 24 * 3600000;
  assert.equal(moodVoiceCadenceOk({ times: [yesterday, yesterday - 3600000, yesterday - 7200000], now, maxPerDay: 3, minGapMs: 3600000 }).ok, true);
  assert.ok(MOOD_VOICE_DEFAULTS.maxPerDay >= 2 && MOOD_VOICE_DEFAULTS.maxPerDay <= 5, '默认每日上限适中');
});

test('console 同步：配置/卡片/FIELD_META/快照键都登记', () => {
  const example = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'));
  assert.ok(example.simulation.pixelSticker && example.simulation.moodVoice, 'example 应有两功能默认');
  const fc = fs.readFileSync(path.join(ROOT, 'runtime', 'control', 'feature-control.js'), 'utf8');
  assert.ok(fc.includes('chatPixelSticker') && fc.includes('chatMoodVoice'), '功能卡应登记');
  const schema = fs.readFileSync(path.join(ROOT, 'runtime', 'kernel', 'config-schema.js'), 'utf8');
  assert.ok(schema.includes("'simulation.pixelSticker.enabled'") && schema.includes("'simulation.moodVoice.enabled'"), 'FIELD_META 应登记');
  const bridge = fs.readFileSync(path.join(ROOT, 'app', 'whale.js'), 'utf8');
  assert.ok(bridge.includes('pixelSticker: {') && bridge.includes('moodVoice: {'), 'live 快照应暴露两功能状态');
  assert.ok(bridge.includes('maybeSendPixelSticker(st, key)'), '文字回复后应挂像素贴纸钩子');
  assert.ok(bridge.includes('noteStickerSent(st);'), '像素贴纸应复用表情包计数');
});
