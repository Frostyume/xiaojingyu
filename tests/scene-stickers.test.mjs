// 场景贴纸红自测：推断/挑选/人设护栏 + 场景只随主动分享附送、不在回复顶替表情包。
// 不触网、不发真实 QQ：harness 夹具 fetch 记录出站；inner-life 用 stub 依赖 + 临时状态目录。
// 反证：无匹配词/开关关闭/dryRun 时不附；回复链路只出像素贴纸不出场景图。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  loadSceneStickers, sceneStickerCount, sceneStickerScenes,
  assertOnModelSceneEntry, inferSceneFromText, pickSceneSticker
} from '../services/media/scene-stickers.js';
import { createInnerLife } from '../services/persona/inner-life.js';
import { bridgeHarness } from './bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SCENE_DIR = path.join(ROOT, 'web', 'assets', 'scene-stickers');

function sceneBase64Set() {
  return new Set(loadSceneStickers().map((s) => fs.readFileSync(path.join(SCENE_DIR, s.file)).toString('base64')));
}
function imageSends(h) {
  return h.calls.http.filter((c) => /send_(group|private)_msg$/.test(c.url)
    && Array.isArray(c.body?.message)
    && c.body.message.some((s) => s.type === 'image' && String(s.data?.file || '').startsWith('base64://')));
}
function sceneSends(h) {
  const set = sceneBase64Set();
  return imageSends(h).filter((c) => c.body.message.some((s) => s.type === 'image' && set.has(String(s.data?.file || '').slice('base64://'.length))));
}

test('manifest 完整性：计数一致、条目过护栏、文件存在、三类场景起点在库', () => {
  const m = JSON.parse(fs.readFileSync(path.join(SCENE_DIR, 'manifest.json'), 'utf8'));
  const list = loadSceneStickers();
  assert.equal(m.count, list.length);
  assert.equal(sceneStickerCount(), list.length);
  assert.ok(list.length >= 7);
  for (const s of list) {
    assert.equal(assertOnModelSceneEntry(s), true);
    assert.ok(fs.existsSync(path.join(SCENE_DIR, s.file)), s.file);
  }
  for (const scene of ['reading', 'video', 'gaming']) assert.ok(sceneStickerScenes().includes(scene), scene);
});

test('red: 场景人设护栏拒绝改色/挂饰/缺标签条目', () => {
  const ok = { file: 'scene-reading-01.png', scene: 'reading', tags: ['读书'] };
  assert.equal(assertOnModelSceneEntry(ok), true);
  assert.throws(() => assertOnModelSceneEntry({ ...ok, hue: 40 }), /不得改色/);
  assert.throws(() => assertOnModelSceneEntry({ ...ok, accessory: 'bow' }), /不得加挂饰/);
  assert.throws(() => assertOnModelSceneEntry({ ...ok, scene: '' }), /场景标签/);
  assert.throws(() => assertOnModelSceneEntry({ ...ok, tags: [] }), /匹配词/);
  assert.throws(() => assertOnModelSceneEntry({ ...ok, file: 'x.jpg' }), /文件名非法/);
});

test('scene 推断：活动词命中对应场景；无命中/空文本返回 null；平局按 rng 取首', () => {
  assert.equal(inferSceneFromText('今天在家读书，这本小说真好看'), 'reading');
  assert.equal(inferSceneFromText('晚上开黑打游戏上分'), 'gaming');
  assert.equal(inferSceneFromText('在追剧看视频'), 'video');
  assert.equal(inferSceneFromText('今天天气不错'), null);
  assert.equal(inferSceneFromText(''), null);
  assert.equal(inferSceneFromText(null), null);
  const tie = inferSceneFromText('读书 开黑', () => 0);
  assert.ok(['reading', 'gaming'].includes(tie), '平局应在并列场景里取');
  assert.equal(inferSceneFromText('读书 开黑', () => 0), tie, '同 rng 平局结果稳定');
});

test('pick：只挑指定场景，未知场景不回退全库', () => {
  const p = pickSceneSticker('reading', () => 0);
  assert.ok(p && p.scene === 'reading');
  assert.ok(fs.existsSync(p.path));
  assert.equal(pickSceneSticker('no-such-scene'), null);
});

test('场景附图：主动分享文本命中 → 发一张场景图；不登记回复互斥时间戳', async () => {
  const h = await bridgeHarness({ config: { simulation: { sceneSticker: { enabled: true }, pixelSticker: { minTextsSince: 1, minGapMs: 60000 } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    const ok = await h.sendSceneStickerToKey('group:456', '今天在家读书，这本小说真好看');
    assert.equal(ok, true);
    assert.equal(sceneSends(h).length, 1, '命中活动词应附一张场景贴纸');
    assert.equal(st.lastPixelStickerAt || 0, 0, '场景附图不得登记像素贴纸互斥时间戳');
    assert.equal(st.lastMemeStickerAt || 0, 0, '场景附图不得登记表情包互斥时间戳');
    h.noteStickerSent(st, 'meme');
    st.textSendsSinceSticker = 2;
    st.lastStickerAt = Date.now() - 120000;
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(imageSends(h).length, 1, '表情包先发后像素贴纸仍被互斥闸拦下（场景附图不扰动互斥）');
  } finally { await h.close(); }
});

test('red: 场景附图不受回复互斥闸限制（表情包在本回合也不拦分享附图）', async () => {
  const h = await bridgeHarness({ config: { simulation: { sceneSticker: { enabled: true } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    h.noteStickerSent(st, 'meme');
    const ok = await h.sendSceneStickerToKey('group:456', '晚上开黑打游戏');
    assert.equal(ok, true, '场景贴纸走分享链路，不应被回复互斥闸拦下');
    assert.equal(sceneSends(h).length, 1);
  } finally { await h.close(); }
});

test('red: 无匹配词/开关关闭 → 不附场景图', async () => {
  const h = await bridgeHarness({ config: { simulation: { sceneSticker: { enabled: false } } } });
  try {
    h.setMode('simulation');
    assert.equal(await h.sendSceneStickerToKey('group:456', '今天在家读书'), false, '开关关闭不附');
    assert.equal(sceneSends(h).length, 0);
  } finally { await h.close(); }
  const h2 = await bridgeHarness({ config: { simulation: { sceneSticker: { enabled: true } } } });
  try {
    h2.setMode('simulation');
    assert.equal(await h2.sendSceneStickerToKey('group:456', '今天天气不错'), false, '无匹配不附');
    assert.equal(sceneSends(h2).length, 0);
  } finally { await h2.close(); }
});

test('red: 回复链路只出像素贴纸，绝不出场景图（场景不顶替表情包）', async () => {
  const h = await bridgeHarness({ config: { simulation: { sceneSticker: { enabled: true }, pixelSticker: { minTextsSince: 1, minGapMs: 60000 } } } });
  try {
    h.setMode('simulation');
    const st = h.getSimulationState('group:456');
    st.textSendsSinceSticker = 2;
    st.lastStickerAt = 0;
    await h.maybeSendPixelSticker(st, 'group:456');
    assert.equal(imageSends(h).length, 1, '锚点：回复后像素贴纸发出');
    assert.equal(sceneSends(h).length, 0, '回复链路不得附场景贴纸');
  } finally { await h.close(); }
});

// ── 主动分享接线：inner-life stub 依赖，pendingShare 审批 → sendGroupShare → 场景附图 ──
function makeInnerLife(tmp, { sceneSpy, shareSends, cfgExtra = {} }) {
  const innerLife = { groupShare: { enabled: true, maxPerDay: 20, minGapMs: 0, idleMs: 0, maxChars: 500 }, ...(cfgExtra.simulation?.innerLife || {}) };
  const cfg = {
    ownerQQ: '',
    features: {},
    simulation: { innerLife, naturalShare: { enabled: false }, nightQuiet: { enabled: false }, ...(cfgExtra.simulation || {}) }
  };
  return createInnerLife({
    cfg,
    api: {},
    log: () => {},
    stateDir: tmp,
    sendToQQ: async (key, text) => { shareSends.push({ key, text }); },
    onebotSend: async () => {},
    // 真实契约：inner-life 只递文本，推断/开关在 bridge 侧 sendSceneStickerToKey 里做。
    sendSceneSticker: async (key, text, opts) => {
      const scene = opts?.scene || inferSceneFromText(text);
      if (!scene) return false;
      sceneSpy.push({ key, text, opts });
      return true;
    },
    lastSendSucceeded: () => true,
    getSimulationState: () => ({ lastIncomingAt: 0 }),
    getEsportsFeed: () => null,
    isSessionAllowedInCurrentMode: () => true,
    ensureChatModel: async () => {},
    resolvePresetName: () => 'standard',
    unwrap: (x) => x,
    getRoleText: () => '',
    getRoleName: () => '小鲸鱼',
    isDshReady: () => false,
    getMode: () => 'simulation',
    isPaused: () => false,
    mdToPlain: (x) => String(x ?? ''),
    appendActivity: () => {},
    imageLibrary: null,
    collectImageStickers: async () => {},
    relationshipStore: null
  });
}

function seedPendingShare(tmp, text) {
  fs.writeFileSync(path.join(tmp, 'inner-life.json'), JSON.stringify({
    pendingShare: { text, target: 'group:456', expiresAt: Date.now() + 120000, item: null }
  }));
}

test('主动分享审批发出后按内容附场景贴纸；无匹配词不附（红）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-share-'));
  const sceneSpy = [];
  const shareSends = [];
  const il = makeInnerLife(tmp, { sceneSpy, shareSends });
  try {
    seedPendingShare(tmp, '今天在家读书，这本小说真好看 https://example.invalid/a');
    const handled = await il.handleOwnerCommand('发分享', { kind: 'private', isOwner: true });
    assert.equal(handled, true);
    assert.equal(shareSends.length, 1, '锚点：分享正文发出');
    assert.equal(sceneSpy.length, 1, '分享命中活动词应附场景贴纸');
    assert.equal(sceneSpy[0].key, 'group:456');
    assert.match(sceneSpy[0].text, /读书/);

    seedPendingShare(tmp, '今天天气不错 https://example.invalid/b');
    await il.handleOwnerCommand('发分享', { kind: 'private', isOwner: true });
    assert.equal(shareSends.length, 2, '锚点：第二条分享发出');
    assert.equal(sceneSpy.length, 1, '无匹配词的分享不得附场景贴纸');
  } finally {
    try { il.stop(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('red: dryRun 分享不发送也不附场景贴纸', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'scene-share-dry-'));
  const sceneSpy = [];
  const shareSends = [];
  const il = makeInnerLife(tmp, { sceneSpy, shareSends, cfgExtra: { simulation: { innerLife: { dryRun: true, groupShare: { enabled: true, maxPerDay: 20, minGapMs: 0, idleMs: 0, maxChars: 500 } } } } });
  try {
    seedPendingShare(tmp, '今天在家读书 https://example.invalid/c');
    await il.handleOwnerCommand('发分享', { kind: 'private', isOwner: true });
    assert.equal(shareSends.length, 0, 'dryRun 不真发');
    assert.equal(sceneSpy.length, 0, 'dryRun 不附场景贴纸');
  } finally {
    try { il.stop(); } catch {}
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('接线锁：分享两条链路都附图，回复链路不附图', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'app', 'whale.js'), 'utf8');
  const inner = fs.readFileSync(path.join(ROOT, 'services', 'persona', 'inner-life.js'), 'utf8');
  assert.ok(bridge.includes('sendSceneSticker: (key, text, opts) => sendSceneStickerToKey'), '桥接应把场景附图注入内心生活');
  assert.ok(bridge.includes('出门见闻'), '出门见闻应保留');
  assert.ok(inner.includes('sendSceneSticker?.(key, shareText)'), '主动分享应附图');
  assert.ok(inner.includes('sendSceneSticker?.(target'), '分享模块应附图');
  assert.ok(bridge.includes('try { await sendSceneStickerToKey(key, text); } catch {}'), '心情语音发完应接场景附图');
});

// ── 心情语音接线：发完语音按文本推断场景附图（无匹配不附、不进互斥计数） ──
function moodVoiceSceneCfg(overrides = {}) {
  return {
    ownerQQ: 123,
    allow: { private: ['123'], groups: ['456'] },
    simulation: {
      nightQuiet: { enabled: false },
      sceneSticker: { enabled: true },
      voice: { enabled: true, maxPerMinute: 50, maxPerHour: 50 },
      moodVoice: { enabled: true, maxPerDay: 10, minGapMs: 0, skipChance: 0, tailChance: 0, llm: true, targets: [] },
      ...overrides
    }
  };
}
function synthStub() {
  let n = 0;
  return async ({ mood, outDir }) => {
    n += 1;
    fs.mkdirSync(outDir, { recursive: true });
    const file = path.join(outDir, `feature-fixture-${n}.ogg`);
    fs.writeFileSync(file, Buffer.alloc(512, 3));
    return { path: file, mood, cached: false };
  };
}
function voiceInner(voiceText) {
  return {
    personaInfo: () => ({ state: { energy: 0.6, mood: { valence: 0.1, cause: '' } } }),
    generateMoodVoiceText: async () => voiceText
  };
}
const recordSends = (h) => h.calls.http.filter((c) => /send_(group|private)_msg$/.test(c.url)
  && Array.isArray(c.body?.message) && c.body.message.some((s) => s.type === 'record'));

test('red: 心情语音文本命中场景 → 发完语音附一张场景图（旧码没接线 → 红）', async () => {
  const h = await bridgeHarness({
    config: moodVoiceSceneCfg(),
    globals: { synthesizeFeatureVoice: synthStub() }
  });
  try {
    h.setMode('simulation');
    h.setSnowlumaConnected(true);
    h.setInnerLife(voiceInner('刚读完那本小说，来跟你们说说'));
    await h.maybeSendMoodVoice({ now: 1_800_000_000_000, rng: () => 0.99 });
    assert.equal(recordSends(h).length, 1, '锚点：语音发出');
    const scenes = sceneSends(h);
    assert.equal(scenes.length, 1, '命中活动词应附一张场景贴纸');
    assert.equal(scenes[0].body.group_id, 456, '场景图发到语音同一个群');
    const st = h.getSimulationState('group:456');
    assert.equal(st.lastPixelStickerAt || 0, 0, '场景附图不登记像素互斥时间戳');
    assert.equal(st.lastMemeStickerAt || 0, 0, '场景附图不登记表情包互斥时间戳');
    assert.equal(st.lastStickerAt || 0, 0, '场景附图不记回复贴纸时间戳');
  } finally { await h.close(); }
});

test('red: 心情语音无匹配场景 → 只发语音不附图；开关关闭同样不附', async () => {
  const h = await bridgeHarness({
    config: moodVoiceSceneCfg(),
    globals: { synthesizeFeatureVoice: synthStub() }
  });
  try {
    h.setMode('simulation');
    h.setSnowlumaConnected(true);
    h.setInnerLife(voiceInner('忙完这阵了，过来跟你们说两句'));
    await h.maybeSendMoodVoice({ now: 1_800_000_000_000, rng: () => 0.99 });
    assert.equal(recordSends(h).length, 1, '锚点：语音照发');
    assert.equal(sceneSends(h).length, 0, '无匹配词不附场景图');
  } finally { await h.close(); }
  const off = await bridgeHarness({
    config: moodVoiceSceneCfg({ sceneSticker: { enabled: false } }),
    globals: { synthesizeFeatureVoice: synthStub() }
  });
  try {
    off.setMode('simulation');
    off.setSnowlumaConnected(true);
    off.setInnerLife(voiceInner('刚读完那本小说，来跟你们说说'));
    await off.maybeSendMoodVoice({ now: 1_800_000_000_000, rng: () => 0.99 });
    assert.equal(recordSends(off).length, 1);
    assert.equal(sceneSends(off).length, 0, '开关关闭不附');
  } finally { await off.close(); }
});