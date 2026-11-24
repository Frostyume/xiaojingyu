#!/usr/bin/env node
/** 生活分享（生活日常）红自测：间隔、场景加权/避重复、草稿不自动发、审批/拒绝、目标轮换、像素底图回避。
 * 不触网、不发真实 QQ：inner-life 用假 DSH 回合，发送只进内存数组。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DAY_MS,
  LIFE_SHARE_DEFAULTS,
  normalizeLifeShareConfig,
  lifeShareIntervalDays,
  nextLifeShareAt,
  pickLifeScene,
  resolveLifeShareLine,
  pickLifeShareTarget,
  normalizeLifeShareTarget,
  normalizePendingLifeShare,
  lifeShareTextSimilar,
  LIFE_SCENE_TEMPLATES,
  normalizeLifeShareLine,
  buildLifeShareDraft
} from '../runtime/persona/life-share.js';
import { pickPixelSticker, mergeRecentPixelBases, normalizeRecentPixelBases } from '../services/media/pixel-stickers.js';
import { ANIME_SCENE_STICKER_DIR, SCENE_STICKER_DIR, loadSceneStickers } from '../services/media/scene-stickers.js';
import { createInnerLife } from '../services/persona/inner-life.js';

test('red: 间隔落在 [minDays,maxDays] 天（旧逻辑没有这个作业，锚点先证明区间）', () => {
  const cfg = normalizeLifeShareConfig({ minDays: 1, maxDays: 7 });
  assert.equal(lifeShareIntervalDays(cfg, () => 0), 1);
  assert.equal(lifeShareIntervalDays(cfg, () => 0.999), 7);
  for (const r of [0, 0.1, 0.5, 0.999]) {
    const days = lifeShareIntervalDays(cfg, () => r);
    assert.ok(days >= 1 && days <= 7, `间隔 ${days} 天必须在 1–7 天内`);
  }
  assert.equal(nextLifeShareAt(1000, cfg, () => 0), 1000 + 1 * DAY_MS);
  // max 不得小于 min；非法值回落到默认区间
  assert.deepEqual(normalizeLifeShareConfig({ minDays: 5, maxDays: 2 }), { enabled: false, minDays: 5, maxDays: 5 });
  assert.equal(normalizeLifeShareConfig({ minDays: -3, maxDays: 200 }).maxDays, 30, 'max 上限 30 天');
  assert.equal(LIFE_SHARE_DEFAULTS.enabled, false, '开源默认关，开启后仍由审批闸拦住');
  assert.equal(normalizeLifeShareConfig({ enabled: true }).enabled, true);
});

test('场景加权：时段 + 兴趣提高权重，近期用过的场景先被排掉', () => {
  const catalog = [
    { scene: 'sunbathing', label: '晒太阳', tags: ['晒太阳'] },
    { scene: 'coding', label: '写代码', tags: ['代码'] }
  ];
  const noon = new Date(2026, 10, 23, 13, 0, 0).getTime();
  const picked = pickLifeScene({ now: noon, interests: ['晒太阳'], recentScenes: [], rng: () => 0.1, catalog });
  assert.equal(picked.scene, 'sunbathing', '兴趣+时段加权应压过另一场景');
  const noInterest = pickLifeScene({ now: noon, interests: [], recentScenes: [], rng: () => 0.1, catalog });
  assert.equal(noInterest.scene, 'sunbathing', '13 点在晒太阳时段内应加权');
  const avoided = pickLifeScene({ now: noon, interests: [], recentScenes: ['sunbathing'], rng: () => 0.1, catalog });
  assert.equal(avoided.scene, 'coding', '近期用过的场景应先被排掉');
  const allRecent = pickLifeScene({ now: noon, interests: [], recentScenes: ['sunbathing', 'coding'], rng: () => 0, catalog });
  assert.ok(allRecent && allRecent.scene, '全被排掉时放宽回全库，不能空');
});

test('文本兜底：模型不可用/无效时用场景模板句；近似重复会被换掉', () => {
  for (const [scene, templates] of Object.entries(LIFE_SCENE_TEMPLATES)) {
    for (const text of templates) {
      const line = normalizeLifeShareLine(text, 30);
      assert.ok(line, `${scene} 模板必须可用且 ≤30 字：${text}`);
      assert.ok(!/[。．.]$/.test(line), '模板不得留中文句号');
    }
  }
  const fallback = resolveLifeShareLine({ raw: '', scene: 'sunbathing', recentTexts: [], rng: () => 0 });
  assert.equal(fallback.source, 'template');
  assert.equal(fallback.text, LIFE_SCENE_TEMPLATES.sunbathing[0]);
  const overlong = resolveLifeShareLine({ raw: '这是一句故意写得非常非常长的生活分享句子用来测试超过三十字上限的情况', scene: 'sunbathing', recentTexts: [], rng: () => 0 });
  assert.equal(overlong.source, 'template', '超长必须退回模板，不能截断造半句');
  const first = LIFE_SCENE_TEMPLATES.sunbathing[0];
  const dup = resolveLifeShareLine({ raw: first, scene: 'sunbathing', recentTexts: [first], rng: () => 0 });
  assert.notEqual(dup.text, first, '与近期重复时不得重复使用');
  assert.ok(lifeShareTextSimilar('中午晒了会儿太阳，整个人暖乎乎的', '中午晒了会儿太阳整个人暖乎乎'), '近似句应判重');
});

test('目标轮换：空间与白名单群轮流，跳过上一个目标', () => {
  assert.equal(normalizeLifeShareTarget('group:123'), 'group:123');
  assert.equal(normalizeLifeShareTarget('123'), 'group:123');
  assert.equal(normalizeLifeShareTarget('private:1'), '');
  const one = pickLifeShareTarget({ groups: ['group:456'], qzone: true, cursor: 0, lastTarget: '' });
  assert.equal(one.target, 'qzone');
  const two = pickLifeShareTarget({ groups: ['group:456'], qzone: true, cursor: one.cursor, lastTarget: one.target });
  assert.equal(two.target, 'group:456');
  const three = pickLifeShareTarget({ groups: ['group:456'], qzone: true, cursor: two.cursor, lastTarget: two.target });
  assert.equal(three.target, 'qzone');
  const jump = pickLifeShareTarget({ groups: ['group:456', 'group:789'], qzone: true, cursor: 1, lastTarget: 'group:456' });
  assert.equal(jump.target, 'group:789', '上一个仍是目标时跳过它');
  assert.equal(pickLifeShareTarget({ groups: [], qzone: false }).target, '', '没有目标时返回空');
});

// ── inner-life 夹具：假 DSH 回合 + 内存发送记录 ──────────────────────────────
test('生活分享草稿冻结风格：非法/缺失风格回退像素', () => {
  const now = Date.now();
  const base = { text: '晒了会儿太阳', scene: 'sunbathing', target: 'group:456', now };
  assert.equal(buildLifeShareDraft({ ...base, style: 'anime' }).style, 'anime');
  assert.equal(buildLifeShareDraft(base).style, 'pixel');
  assert.equal(buildLifeShareDraft({ ...base, style: 'chibi' }).style, 'pixel');
  const pending = normalizePendingLifeShare({ ...buildLifeShareDraft(base), expiresAt: now + 3600000 });
  assert.equal(pending.style, 'pixel');
  assert.equal(normalizePendingLifeShare({ ...pending, style: 'unknown' }).style, 'pixel');
});

function makeInner(tmp, { output = '', cfgExtra = {} } = {}) {
  let innerRef = null;
  let currentOutput = output;
  const ownerMessages = [];
  const groupSends = [];
  const sceneSends = [];
  const contextNotes = [];
  const api = {
    events: { follow: () => {} },
    workspace: {
      create: async () => ({ result: { ok: true, value: { created: true, workspaceId: 'ws1' } } }),
      rename: async () => ({ result: { ok: true, value: {} } })
    },
    sessions: {
      create: async () => ({ result: { ok: true, value: { sessionId: 'sess1' } } }),
      prompt: async ({ sessionId }) => {
        const text = String(currentOutput ?? '');
        innerRef.handleEvent(sessionId, { type: 'turn/start', data: { turn: 't1' } });
        innerRef.handleEvent(sessionId, { type: 'assistant/message', data: { turn: 't1', message: { content: [{ type: 'text', text }] } } });
        innerRef.handleEvent(sessionId, { type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } });
        return { result: { ok: true } };
      }
    }
  };
  const cfg = {
    ownerQQ: 999,
    allow: { groups: ['456'], private: ['999'] },
    features: { qzone: false },
    simulation: {
      agentPreset: 'standard',
      nightQuiet: { enabled: false },
      sceneSticker: { enabled: true },
      lifeShare: { enabled: true, minDays: 1, maxDays: 7 },
      innerLife: { enabled: true, qzone: { enabled: false }, groupShare: { enabled: true, maxPerDay: 20, minGapMs: 0, idleMs: 0 } },
      ...(cfgExtra.simulation || {})
    },
    ...(cfgExtra.top || {})
  };
  const inner = createInnerLife({
    cfg,
    api,
    stateDir: tmp,
    log: () => {},
    sendToQQ: async (key, msg) => { groupSends.push({ key, msg: String(msg) }); },
    onebotSend: async (kind, id, msg) => { ownerMessages.push({ kind, id, msg: String(msg) }); return { message_id: 'm1' }; },
    sendSceneSticker: async (key, text, opts) => { sceneSends.push({ key, text, scene: opts?.scene, style: opts?.style }); return true; },
    lastSendSucceeded: () => true,
    getSimulationState: () => ({ recentMessages: [], unread: [], lastIncomingAt: 0 }),
    isSessionAllowedInCurrentMode: () => true,
    ensureChatModel: async () => 'applied',
    resolvePresetName: () => 'standard',
    unwrap: (r) => r.result.value,
    getRoleText: () => '',
    getRoleName: () => '小鲸鱼',
    isDshReady: () => true,
    getMode: () => 'simulation',
    isPaused: () => false,
    mdToPlain: (t) => String(t ?? ''),
    appendActivity: () => {},
    imageLibrary: null,
    collectImageStickers: async () => {},
    relationshipStore: null,
    listChatTargets: () => ({ groups: [{ key: 'group:456', name: '测试群' }], privates: [] }),
    noteSelfSent: (key, text) => { contextNotes.push({ key, text }); }
  });
  innerRef = inner;
  return { inner, cfg, ownerMessages, groupSends, sceneSends, contextNotes, setOutput: (value) => { currentOutput = value; } };
}

function writePending(tmp, overrides = {}) {
  const now = Date.now();
  const draft = {
    text: '中午晒了会儿太阳，整个人暖乎乎的',
    scene: 'sunbathing',
    sceneLabel: '晒太阳',
    sceneFile: 'scene-sunbathing-01.png',
    target: 'group:456',
    createdAt: now,
    expiresAt: now + 3600 * 1000,
    ...overrides
  };
  fs.writeFileSync(path.join(tmp, 'inner-life.json'), JSON.stringify({ pendingLifeShare: draft }));
  return draft;
}

test('生成后不自动发送：草稿含 text+scene+target，等主人这句批准（红）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-share-'));
  const line = '今天过得慢慢悠悠的，没什么大事也挺好';
  const h = makeInner(tmp, { output: line });
  try {
    const result = await h.inner.runJob('lifeShare', { force: true });
    assert.equal(result.status, 'pending-approval', '生成后应是待审状态，不能直接发');
    assert.ok(result.text && result.scene && result.target, '草稿必须包含 text/scene/target');
    assert.equal(h.groupSends.length, 0, '未批准前绝不能发到群里');
    assert.equal(h.sceneSends.filter((item) => item.key.startsWith('group:')).length, 0, '未批准前不能发群贴纸');
    const state = h.inner.getState();
    assert.ok(state.pendingLifeShare, '待审草稿应落盘');
    assert.equal(state.pendingLifeShare.text, line);
    assert.ok(state.pendingLifeShare.scene);
    assert.equal(state.pendingLifeShare.target, 'group:456');
    assert.ok(state.pendingLifeShare.sceneFile, '草稿要记下对应的场景贴纸');
    const notice = h.ownerMessages.map((m) => m.msg).join('\n');
    assert.match(notice, /生活分享草稿/, '必须私聊主人告知有草稿');
    assert.match(notice, /发生活/, '必须告诉主人怎么同意');
    assert.match(notice, /不发生活/, '必须告诉主人怎么拒绝');
    assert.match(notice, /测试群/, '目标要说清是哪个群');
    assert.equal(h.sceneSends[0]?.key, 'private:999', '贴纸先作为预览发给主人');
    assert.equal(h.sceneSends[0]?.scene, state.pendingLifeShare.scene);
  } finally {
    h.inner.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('二次元草稿：预览与批准群发都使用生成时冻结的风格', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-share-anime-'));
  const h = makeInner(tmp, { output: '晒了会儿太阳，整个人暖乎乎的' });
  try {
    h.cfg.simulation.sceneSticker.style = 'anime';
    const result = await h.inner.runJob('lifeShare', { force: true });
    assert.equal(result.status, 'pending-approval');
    assert.equal(result.style, 'anime');
    assert.ok(result.scene);
    const pending = h.inner.getState().pendingLifeShare;
    assert.equal(pending.style, 'anime');
    assert.ok(pending.sceneFile.startsWith('anime-'));
    assert.equal(h.sceneSends[0]?.style, 'anime');

    h.cfg.simulation.sceneSticker.style = 'pixel';
    await h.inner.handleOwnerCommand('发生活', { kind: 'private', isOwner: true });
    const groupSticker = h.sceneSends.find((item) => item.key === 'group:456');
    assert.equal(groupSticker?.style, 'anime', '批准时热切换不能串库');
    assert.equal(h.groupSends.length, 1);
  } finally {
    h.inner.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('模型不可用/无效时退回场景模板，仍然是待审草稿', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-share-'));
  const overlong = '这一句故意写得很长很长很长超过三十个字的上限以便测试模板兜底是否生效';
  const h = makeInner(tmp, { output: overlong });
  try {
    const result = await h.inner.runJob('lifeShare', { force: true });
    assert.equal(result.status, 'pending-approval');
    assert.ok(result.text && result.text.length <= 30, '模板兜底也要 ≤30 字');
    assert.notEqual(result.text, overlong, '超长模型输出不能直接拿来用');
    assert.equal(h.groupSends.length, 0);
  } finally {
    h.inner.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('批准 → 发到目标群：文字 + 指定场景贴纸 + 入上下文', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-share-'));
  const h = makeInner(tmp);
  try {
    const draft = writePending(tmp);
    const handled = await h.inner.handleOwnerCommand('发生活', { kind: 'private', isOwner: true });
    assert.equal(handled, true);
    assert.equal(h.groupSends.length, 1);
    assert.equal(h.groupSends[0].key, 'group:456');
    assert.equal(h.groupSends[0].msg, draft.text);
    assert.equal(h.sceneSends.filter((item) => item.key === 'group:456').length, 1, '同群要发对应场景贴纸');
    assert.equal(h.sceneSends.find((item) => item.key === 'group:456').scene, 'sunbathing');
    assert.equal(h.contextNotes.length, 1, '发出去的话要写回会话上下文');
    const state = h.inner.getState();
    assert.equal(state.pendingLifeShare, null, '批准后草稿清空');
    assert.equal(state.lifeShare.recent.at(-1).status, 'sent');
    assert.ok(state.next.lifeShare > Date.now(), '成功发送后要重排下一次 1–7 天后的排期');
    const done = h.ownerMessages.map((m) => m.msg).join('\n');
    assert.match(done, /已发到/);
  } finally {
    h.inner.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('拒绝 → 丢弃，不发送；过期草稿也不发送', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-share-'));
  const h = makeInner(tmp);
  try {
    const draft = writePending(tmp);
    const handled = await h.inner.handleOwnerCommand('不发生活', { kind: 'private', isOwner: true });
    assert.equal(handled, true);
    assert.equal(h.groupSends.length, 0, '拒绝后绝不能发送');
    const state = h.inner.getState();
    assert.equal(state.pendingLifeShare, null);
    assert.equal(state.lifeShare.recent.at(-1).status, 'rejected');
    assert.ok(state.next.lifeShare > Date.now());
    assert.equal(draft.text, '中午晒了会儿太阳，整个人暖乎乎的');
  } finally {
    h.inner.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('过期草稿：runJob 丢弃不再发；主人再批准也只会告知已过期', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-share-'));
  const expired = { createdAt: Date.now() - 3 * 3600 * 1000, expiresAt: Date.now() - 2 * 3600 * 1000 };
  writePending(tmp, expired);
  const h = makeInner(tmp);
  try {
    await h.inner.runJob('lifeShare', { force: true });
    const state = h.inner.getState();
    assert.equal(state.pendingLifeShare, null, '过期草稿必须清掉');
    assert.equal(h.groupSends.length, 0, '过期草稿不得被发送');
  } finally {
    h.inner.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const tmp2 = fs.mkdtempSync(path.join(os.tmpdir(), 'life-share-'));
  writePending(tmp2, expired);
  const h2 = makeInner(tmp2);
  try {
    const handled = await h2.inner.handleOwnerCommand('发生活', { kind: 'private', isOwner: true });
    assert.equal(handled, true);
    assert.equal(h2.groupSends.length, 0);
    assert.match(h2.ownerMessages.map((m) => m.msg).join('\n'), /过期/);
    assert.equal(h2.inner.getState().pendingLifeShare, null);
  } finally {
    h2.inner.stop();
    fs.rmSync(tmp2, { recursive: true, force: true });
  }
});

test('批准目标为空间 → 发一条带场景配图的说说（网关只在内存里响应）', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-share-'));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { tid: '123456789' } })
    };
  };
  const h = makeInner(tmp);
  // 空间目标需要顶层 features.qzone 与 innerLife.qzone 同时可用（运行期直接读 cfg）。
  h.cfg.features.qzone = true;
  h.cfg.simulation.innerLife.qzone.enabled = true;
  try {
    writePending(tmp, { target: 'qzone', text: '晒了会儿太阳，整个人暖乎乎的' });
    const handled = await h.inner.handleOwnerCommand('发生活', { kind: 'private', isOwner: true });
    assert.equal(handled, true);
    assert.equal(calls.length, 1, '应向 SnowLuma 发一次 send_qzone_msg');
    assert.match(calls[0].url, /send_qzone_msg$/);
    assert.equal(calls[0].body.content, '晒了会儿太阳，整个人暖乎乎的');
    assert.ok(Array.isArray(calls[0].body.images) && calls[0].body.images[0].startsWith('base64://'), '说说要带场景贴纸配图');
    // base64 必须是库内 PNG（scene-sunbathing-01.png）
    const png = Buffer.from(calls[0].body.images[0].slice('base64://'.length), 'base64');
    assert.equal(png.subarray(0, 4).toString('hex'), '89504e47', '配图应是 PNG');
    assert.match(h.ownerMessages.map((m) => m.msg).join('\n'), /已发空间/);
    const state = h.inner.getState();
    assert.equal(state.pendingLifeShare, null);
    assert.equal(state.lifeShare.recent.at(-1).status, 'sent');
    assert.equal(state.lifeShare.lastTarget, 'qzone');
  } finally {
    globalThis.fetch = originalFetch;
    h.inner.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('二次元空间分享：配图使用草稿冻结风格的精确资产字节', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-share-qzone-anime-'));
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
    return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { tid: '123456789' } }) };
  };
  const h = makeInner(tmp);
  h.cfg.features.qzone = true;
  h.cfg.simulation.innerLife.qzone.enabled = true;
  try {
    writePending(tmp, {
      target: 'qzone', style: 'anime', sceneFile: 'anime-scene-sunbathing-01.png',
      text: '晒了会儿太阳，整个人暖乎乎的'
    });
    h.cfg.simulation.sceneSticker.style = 'pixel';
    assert.equal(await h.inner.handleOwnerCommand('发生活', { kind: 'private', isOwner: true }), true);
    assert.equal(calls.length, 1);
    const png = Buffer.from(calls[0].body.images[0].slice('base64://'.length), 'base64');
    assert.ok(png.equals(fs.readFileSync(path.join(ANIME_SCENE_STICKER_DIR, 'anime-scene-sunbathing-01.png'))));
  } finally {
    globalThis.fetch = originalFetch;
    h.inner.stop();
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('空间配图白名单：跨库文件与路径穿越都不进入 images', async () => {
  assert.ok(fs.existsSync(path.join(SCENE_STICKER_DIR, 'scene-sunbathing-01.png')));
  assert.ok(loadSceneStickers('pixel').some((entry) => entry.file === 'scene-sunbathing-01.png'));
  const originalFetch = globalThis.fetch;
  try {
    for (const sceneFile of ['scene-sunbathing-01.png', '../anime-scene-sunbathing-01.png', 'not-listed.png']) {
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'life-share-qzone-safe-'));
      const calls = [];
      globalThis.fetch = async (url, init = {}) => {
        calls.push({ url: String(url), body: JSON.parse(String(init.body ?? '{}')) });
        return { ok: true, status: 200, text: async () => JSON.stringify({ status: 'ok', retcode: 0, data: { tid: '123456789' } }) };
      };
      const h = makeInner(tmp);
      h.cfg.features.qzone = true;
      h.cfg.simulation.innerLife.qzone.enabled = true;
      try {
        writePending(tmp, { target: 'qzone', style: 'anime', sceneFile });
        assert.equal(await h.inner.handleOwnerCommand('发生活', { kind: 'private', isOwner: true }), true);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].body.images || [], [], `${sceneFile} 不得作为空间配图`);
      } finally {
        h.inner.stop();
        fs.rmSync(tmp, { recursive: true, force: true });
      }
    }
  } finally { globalThis.fetch = originalFetch; }
});

test('控制台可见：配置/卡片/FIELD_META/控制台面板/实时页/审批接口都登记', () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const read = (rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
  const example = JSON.parse(read('config.example.json'));
  assert.ok(example.simulation.lifeShare, 'config.example.json 要有 lifeShare 默认值');
  assert.equal(example.simulation.lifeShare.enabled, false, '开源默认关');
  const fc = read('runtime/control/feature-control.js');
  assert.match(fc, /id: 'lifeShare'[\s\S]*configKey: 'simulation\.lifeShare\.enabled'/, '功能控制台要登记卡片');
  const schema = read('runtime/kernel/config-schema.js');
  for (const key of ['simulation.lifeShare.enabled', 'simulation.lifeShare.minDays', 'simulation.lifeShare.maxDays']) {
    assert.ok(schema.includes(`'${key}'`), `FIELD_META 要登记 ${key}`);
  }
  const deck = read('web/deck.html');
  assert.match(deck, /data-feature-panel="lifeShare"/, '控制台要有生活分享面板');
  assert.match(deck, /\/api\/inner-life\/life-share/, '控制台审批要走管理接口');
  const live = read('web/live.html');
  assert.match(live, /生活分享/, '实时页要展示生活分享状态');
  const bridge = read('app/whale.js');
  assert.match(bridge, /'\/api\/inner-life\/life-share'/, '桥接要暴露审批接口');
  assert.match(bridge, /pendingLifeShare/, '实时/内容快照要暴露待审草稿');
  assert.match(bridge, /normalizeLifeShareConfig/, '桥接配置默认值要与核心归一化一致');
});

test('像素贴纸：挑图避开最近用过的底图，最近列表推进且去重', () => {
  const all = pickPixelSticker('idle', () => 0, null, []);
  assert.ok(all?.base);
  const avoid = [all.base];
  const next = pickPixelSticker('idle', () => 0, null, avoid);
  assert.ok(next, '有替代底图时必须还能挑出来');
  assert.notEqual(next.base, all.base, '不能连续挑同一个底图');
  let recent = [];
  for (const base of ['a.png', 'b.png', 'c.png', 'd.png']) recent = mergeRecentPixelBases(recent, base, 3);
  assert.deepEqual(recent, ['b.png', 'c.png', 'd.png'], '只保留最近 3 个');
  recent = mergeRecentPixelBases(recent, 'c.png', 3);
  assert.deepEqual(recent, ['b.png', 'd.png', 'c.png'], '重复出现时移到末尾而不是留两份');
  assert.deepEqual(normalizeRecentPixelBases(['x.png', '', 'x.png', 'y.png'], 3), ['x.png', 'y.png']);
});
