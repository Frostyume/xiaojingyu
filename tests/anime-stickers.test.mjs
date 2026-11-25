import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  ANIME_STICKER_DIR,
  PIXEL_STICKER_DIR,
  STICKER_STYLES,
  assertOnModelEntry,
  loadPixelStickers,
  loadReplyStickers,
  normalizeStickerStyle,
  pickPixelSticker,
  pickReplySticker,
  replyStickerCount,
  replyStickerMoods,
  replyStickerScenes
} from '../services/media/pixel-stickers.js';
import {
  ANIME_SCENE_STICKER_DIR,
  SCENE_STICKER_DIR,
  assertOnModelSceneEntry,
  inferSceneFromText,
  loadSceneStickers,
  pickSceneSticker,
  sceneStickerCount,
  sceneStickerScenes
} from '../services/media/scene-stickers.js';
import { buildConfigSchema, validateConfigPatch } from '../runtime/kernel/config-schema.js';
import { advancedFieldsFor, cardFor, configValueFor } from '../runtime/control/feature-control.js';
import { CONSOLE_SECURITY_HEADERS, evaluateAgentAccess } from '../console/auth.js';
import { agentTokenAllowedPath } from '../console/policy.js';
import { bridgeHarness } from './bridge-harness.mjs';
import { startConsoleFixture } from '../tools/demo-console.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ANIME_MANIFEST = path.join(ANIME_STICKER_DIR, 'manifest.json');
const ANIME_SCENE_MANIFEST = path.join(ANIME_SCENE_STICKER_DIR, 'manifest.json');
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');
const readJson = (file) => JSON.parse(read(file));

function pngHeader(file) {
  const png = fs.readFileSync(file);
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(8), 13, `${path.basename(file)} IHDR 长度应固定为 13`);
  assert.equal(png.toString('ascii', 12, 16), 'IHDR');
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20), colorType: png[25] };
}

function cornerAlpha(file) {
  const png = fs.readFileSync(file);
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png[25], 6, `${path.basename(file)} 必须是 RGBA PNG`);
  let offset = 8;
  const idat = [];
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString('ascii', offset + 4, offset + 8);
    if (type === 'IDAT') idat.push(png.subarray(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  return zlib.inflateSync(Buffer.concat(idat))[4];
}

function imageSends(h) {
  return h.calls.http.filter((call) => /send_(group|private)_msg$/.test(call.url)
    && Array.isArray(call.body?.message)
    && call.body.message.some((segment) => segment.type === 'image' && String(segment.data?.file || '').startsWith('base64://')));
}

function sentBytes(h) {
  return imageSends(h).map((call) => Buffer.from(call.body.message.find((segment) => segment.type === 'image').data.file.slice('base64://'.length), 'base64'));
}

function matchesLibrary(bytes, style, kind = 'mood') {
  const dir = kind === 'mood'
    ? style === 'anime' ? ANIME_STICKER_DIR : PIXEL_STICKER_DIR
    : style === 'anime' ? ANIME_SCENE_STICKER_DIR : SCENE_STICKER_DIR;
  const entries = kind === 'mood' ? loadReplyStickers(style) : loadSceneStickers(style);
  return entries.some((entry) => bytes.equals(fs.readFileSync(path.join(dir, entry.file))));
}

async function withConsole(h, fn) {
  let server = null;
  try {
    server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    await fn({ base, server });
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
}

function assertPrivateSecurityHeaders(response) {
  for (const [name, value] of Object.entries(CONSOLE_SECURITY_HEADERS)) {
    if (name.toLowerCase() === 'cache-control') continue;
    assert.equal(response.headers.get(name.toLowerCase()), value, name);
  }
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
}

function rawRequest(base, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(new URL(base + route), { headers }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers }));
    });
    request.on('error', reject);
    request.end();
  });
}

test('normalizeStickerStyle：仅接受精确 pixel/anime，未知或空值回退 pixel', () => {
  assert.deepEqual(STICKER_STYLES, ['pixel', 'anime']);
  for (const style of STICKER_STYLES) assert.equal(normalizeStickerStyle(style), style);
  for (const style of [undefined, null, '', 'unknown', 'PIXEL', 'Anime', 1, {}]) {
    assert.equal(normalizeStickerStyle(style), 'pixel');
  }
});

test('默认像素兼容：旧导出、旧签名、清单与路径保持可用', () => {
  const manifest = readJson('web/assets/pixel-stickers/manifest.json');
  const pixel = loadReplyStickers();
  assert.equal(manifest.style, 'pixel');
  assert.equal(manifest.count, 120);
  assert.equal(pixel.length, manifest.count);
  assert.deepEqual(loadPixelStickers(), pixel);
  assert.equal(replyStickerCount(), pixel.length);
  assert.ok(pixel.every((entry) => entry.style === 'pixel'));
  const oldPick = pickPixelSticker('happy', () => 0);
  const newPick = pickReplySticker('happy', () => 0, null, [], 'pixel');
  assert.equal(oldPick.file, newPick.file);
  assert.equal(oldPick.style, 'pixel');
  assert.ok(oldPick.path.startsWith(PIXEL_STICKER_DIR + path.sep));
  assert.equal(pickReplySticker('happy', () => 0, null, [], 'unknown').style, 'pixel');
});

test('回复风格隔离：目录、缓存、picker 与未知风格回退均不跨库', () => {
  const pixel = loadReplyStickers('pixel');
  const anime = loadReplyStickers('anime');
  assert.notEqual(PIXEL_STICKER_DIR, ANIME_STICKER_DIR);
  assert.equal(anime.length, 120, `二次元回复资产必须完整：${ANIME_MANIFEST}`);
  assert.equal(loadReplyStickers('unknown'), pixel);
  for (const rng of [() => 0, () => 0.5, () => 0.999999]) {
    const pick = pickReplySticker('happy', rng, null, [], 'anime');
    assert.equal(pick.style, 'anime');
    assert.ok(pick.path.startsWith(ANIME_STICKER_DIR + path.sep));
    assert.ok(anime.some((entry) => entry.file === pick.file));
  }
  const fallback = pickReplySticker('happy', () => 0, null, [], 'not-a-style');
  assert.equal(fallback.style, 'pixel');
  assert.ok(fallback.path.startsWith(PIXEL_STICKER_DIR + path.sep));
});

test('人设护栏：两风格均拒绝 hue/accessory 改造与非法 style', () => {
  for (const style of STICKER_STYLES) {
    const entry = { file: 'whale-anime-test.png', mood: 'happy', crop: 'full', flip: false, style };
    assert.equal(assertOnModelEntry(entry), true);
    assert.throws(() => assertOnModelEntry({ ...entry, hue: 20 }), /不得改色/);
    assert.throws(() => assertOnModelEntry({ ...entry, accessory: 'bow' }), /不得加挂饰/);
    assert.throws(() => assertOnModelEntry({ ...entry, style: 'chibi' }), /贴纸风格非法/);
  }
});

test('二次元回复资产：30 slug parity、每底图四变体、120 文件且角落透明', () => {
  const manifest = JSON.parse(fs.readFileSync(ANIME_MANIFEST, 'utf8'));
  const pixel = loadReplyStickers('pixel');
  const anime = loadReplyStickers('anime');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.kind, 'reply');
  assert.equal(manifest.style, 'anime');
  assert.equal(manifest.count, 120);
  assert.equal(manifest.stickers.length, 120);
  assert.equal(anime.length, 120);
  assert.equal(new Set(anime.map((entry) => entry.file)).size, 120);

  const baseSlug = (entry, style) => {
    const base = path.basename(String(entry.base || ''));
    const prefix = `whale-${style}-`;
    assert.ok(base.startsWith(prefix) && base.endsWith('.png'), `${entry.file} 的底图必须使用 whale-${style}-<slug>.png：${base}`);
    return base.slice(prefix.length, -4);
  };
  const groupByBase = (entries, style) => {
    const groups = new Map();
    for (const entry of entries) {
      const slug = baseSlug(entry, style);
      if (!groups.has(slug)) groups.set(slug, []);
      groups.get(slug).push(entry);
    }
    return groups;
  };
  const variantKeys = (entries) => entries.map((entry) => `${entry.flip}-${entry.crop}`).sort();
  const labelKeys = (entries) => entries.map((entry) => JSON.stringify([entry.mood, entry.scene])).sort();
  const expectedVariants = ['false-full', 'false-head', 'true-full', 'true-head'];
  const pixelGroups = groupByBase(pixel, 'pixel');
  const animeGroups = groupByBase(anime, 'anime');
  assert.equal(pixelGroups.size, 30);
  assert.equal(animeGroups.size, 30);
  assert.deepEqual([...animeGroups.keys()].sort(), [...pixelGroups.keys()].sort());
  for (const [slug, pixelVariants] of pixelGroups) {
    const animeVariants = animeGroups.get(slug);
    assert.ok(animeVariants, `二次元库缺少底图 slug：${slug}`);
    assert.equal(pixelVariants.length, 4, `像素底图 ${slug} 应有四变体`);
    assert.equal(animeVariants.length, 4, `二次元底图 ${slug} 应有四变体`);
    assert.deepEqual(variantKeys(pixelVariants), expectedVariants);
    assert.deepEqual(variantKeys(animeVariants), expectedVariants);
    assert.deepEqual(labelKeys(animeVariants), labelKeys(pixelVariants), `底图 mood/scene parity：${slug}`);
    assert.equal(path.basename(pixelVariants[0].base), `whale-pixel-${slug}.png`);
    assert.equal(animeVariants[0].base, `bases/whale-anime-${slug}.png`);
    assert.ok(fs.existsSync(path.join(ANIME_STICKER_DIR, animeVariants[0].base)), `${animeVariants[0].base} 应存在`);
    for (const variant of animeVariants) {
      assert.equal(variant.style, 'anime');
      assert.equal(variant.hue, undefined);
      assert.equal(variant.accessory, undefined);
      const file = path.join(ANIME_STICKER_DIR, variant.file);
      assert.ok(fs.existsSync(file), `${variant.file} 应存在`);
      assert.equal(cornerAlpha(file), 0, `${variant.file} 角落应透明`);
    }
  }
  assert.deepEqual([...replyStickerMoods('anime')].sort(), [...replyStickerMoods('pixel')].sort());
  assert.deepEqual([...replyStickerScenes('anime')].sort(), [...replyStickerScenes('pixel')].sort());
});

test('场景默认兼容：旧清单、旧签名、rng 第二参与默认像素路径不变', () => {
  const manifest = readJson('web/assets/scene-stickers/manifest.json');
  const pixel = loadSceneStickers();
  assert.equal(manifest.kind, 'scene');
  assert.equal(manifest.style, 'pixel');
  assert.equal(manifest.count, 60);
  assert.equal(pixel.length, 60);
  assert.deepEqual(loadSceneStickers('pixel'), pixel);
  assert.deepEqual(loadSceneStickers('unknown'), pixel);
  assert.ok(pixel.every((entry) => entry.style === 'pixel'));
  assert.equal(sceneStickerCount(), 60);
  assert.deepEqual(sceneStickerScenes('unknown'), sceneStickerScenes('pixel'));
  const pick = pickSceneSticker('reading', () => 0);
  assert.equal(pick.style, 'pixel');
  assert.ok(pick.path.startsWith(SCENE_STICKER_DIR + path.sep));
  assert.ok(pixel.some((entry) => entry.file === pick.file));
  assert.equal(pickSceneSticker('reading', () => 0, 'not-a-style').style, 'pixel');
  assert.equal(inferSceneFromText('读书', () => 0), 'reading');
  assert.equal(inferSceneFromText('读书', () => 0.999999), 'studying');
  assert.equal(inferSceneFromText('', () => 0), null);
  assert.equal(inferSceneFromText('完全没有活动词', () => 0), null);
});

test('场景风格隔离：picker 只走所选目录，infer 第三参接入且未知风格回退像素', () => {
  const pixel = loadSceneStickers('pixel');
  const anime = loadSceneStickers('anime');
  assert.notEqual(SCENE_STICKER_DIR, ANIME_SCENE_STICKER_DIR);
  assert.equal(anime.length, 60, `二次元场景资产必须完整：${ANIME_SCENE_MANIFEST}`);
  for (const scene of ['reading', 'gaming', 'bath']) {
    const pixelPick = pickSceneSticker(scene, () => 0, 'pixel');
    assert.equal(pixelPick.style, 'pixel');
    assert.ok(pixelPick.path.startsWith(SCENE_STICKER_DIR + path.sep));
    assert.ok(pixel.some((entry) => entry.file === pixelPick.file));
    const animePick = pickSceneSticker(scene, () => 0, 'anime');
    assert.equal(animePick.style, 'anime');
    assert.ok(animePick.path.startsWith(ANIME_SCENE_STICKER_DIR + path.sep));
    assert.ok(anime.some((entry) => entry.file === animePick.file));
    assert.equal(inferSceneFromText('今天在家读书', () => 0, 'anime'), inferSceneFromText('今天在家读书', () => 0, 'pixel'));
  }
  assert.equal(pickSceneSticker('not-a-scene', () => 0, 'pixel'), null);
  assert.equal(sceneStickerCount('unknown'), sceneStickerCount('pixel'));
});

test('二次元场景资产：60 对标签 parity、文件存在且为 1024×1024 PNG', () => {
  const manifest = JSON.parse(fs.readFileSync(ANIME_SCENE_MANIFEST, 'utf8'));
  const pixel = loadSceneStickers('pixel');
  const anime = loadSceneStickers('anime');
  assert.equal(manifest.version, 1);
  assert.equal(manifest.kind, 'scene');
  assert.equal(manifest.style, 'anime');
  assert.equal(manifest.count, 60);
  assert.equal(manifest.stickers.length, 60);
  assert.equal(pixel.length, 60);
  assert.equal(anime.length, 60);
  assert.equal(new Set(anime.map((entry) => entry.file)).size, 60);
  const signature = (entry) => ({ scene: entry.scene, label: entry.label, tags: entry.tags });
  assert.deepEqual(anime.map(signature), pixel.map(signature));
  assert.deepEqual([...sceneStickerScenes('anime')].sort(), [...sceneStickerScenes('pixel')].sort());
  for (const entry of pixel) {
    assert.equal(entry.style, 'pixel');
    assert.ok(fs.existsSync(path.join(SCENE_STICKER_DIR, entry.file)), `${entry.file} 应存在`);
    assert.equal(assertOnModelSceneEntry(entry), true);
  }
  for (const entry of anime) {
    assert.equal(entry.style, 'anime');
    assert.ok(entry.file.startsWith('anime-'), `${entry.file} 应以 anime- 开头`);
    assert.equal(assertOnModelSceneEntry(entry), true);
    const file = path.join(ANIME_SCENE_STICKER_DIR, entry.file);
    assert.ok(fs.existsSync(file), `${entry.file} 应存在`);
    const header = pngHeader(file);
    assert.equal(header.width, 1024, `${entry.file} 宽度应为 1024`);
    assert.equal(header.height, 1024, `${entry.file} 高度应为 1024`);
    assert.ok([2, 6].includes(header.colorType), `${entry.file} 应为 RGB/RGBA PNG`);
  }
});

test('场景人设护栏：非法 style、改色、挂饰、缺场景或匹配词均拒绝', () => {
  const entry = { file: 'anime-scene-reading-01.png', scene: 'reading', tags: ['读书'], style: 'anime' };
  assert.equal(assertOnModelSceneEntry(entry), true);
  assert.equal(assertOnModelSceneEntry({ ...entry, style: undefined }), true);
  assert.throws(() => assertOnModelSceneEntry({ ...entry, style: 'chibi' }), /贴纸风格非法/);
  assert.throws(() => assertOnModelSceneEntry({ ...entry, hue: 20 }), /不得改色/);
  assert.throws(() => assertOnModelSceneEntry({ ...entry, accessory: 'bow' }), /不得加挂饰/);
  assert.throws(() => assertOnModelSceneEntry({ ...entry, scene: '' }), /缺少场景标签/);
  assert.throws(() => assertOnModelSceneEntry({ ...entry, tags: [] }), /缺少匹配词/);
});

test('配置/schema/卡片：默认 pixel、枚举校验、高级 select 与默认关闭保持', () => {
  const example = readJson('config.example.json');
  assert.equal(example.simulation.pixelSticker.style, 'pixel');
  assert.equal(example.simulation.sceneSticker.style, 'pixel');
  assert.equal(example.simulation.sceneSticker.enabled, false);
  assert.equal(example.simulation.lifeShare.enabled, false);
  for (const key of ['simulation.pixelSticker.style', 'simulation.sceneSticker.style']) {
    const field = buildConfigSchema(example).fields.find((item) => item.key === key);
    assert.ok(field, key);
    assert.equal(field.default, 'pixel');
    assert.equal(field.restart, 'none');
    assert.deepEqual(field.enum, ['pixel', 'anime']);
    assert.equal(validateConfigPatch(example, { [key]: 'anime' }).ok, true);
    assert.equal(validateConfigPatch(example, { [key]: 'chibi' }).ok, false);
  }
  const generated = readJson('config.schema.json');
  for (const key of ['simulation.pixelSticker.style', 'simulation.sceneSticker.style']) {
    const field = generated['x-fields'].find((item) => item.key === key);
    assert.ok(field, key);
    assert.deepEqual(field.enum, ['pixel', 'anime']);
  }
  const replyCard = cardFor('chatPixelSticker');
  assert.equal(replyCard.label, '心情贴纸（像素/二次元）');
  const sceneCard = cardFor('chatSceneSticker');
  assert.equal(sceneCard.configKey, 'simulation.sceneSticker.enabled');
  for (const [card, key] of [[replyCard, 'simulation.pixelSticker.style'], [sceneCard, 'simulation.sceneSticker.style']]) {
    const select = advancedFieldsFor(card, {}).find((item) => item.key === key);
    assert.equal(select.type, 'select');
    assert.equal(select.value, 'pixel');
    assert.equal(configValueFor(select, 'anime'), 'anime');
    assert.equal(configValueFor(select, 'chibi'), null);
  }
  assert.equal(configValueFor({ type: 'boolean', default: true }, 'true'), true);
  assert.equal(configValueFor({ type: 'number', min: 1, max: 10 }, 20), 10);
  assert.equal(configValueFor({ type: 'time' }, '8:05'), '08:05');
});

test('回复运行链路：默认像素、高级配置热切换与真实发送字节', async () => {
  const h = await bridgeHarness();
  try {
    assert.equal(h.cfg.simulation.pixelSticker.style, 'pixel');
    h.setMode('simulation');
    const send = async () => {
      const state = h.getSimulationState('group:456');
      state.textSendsSinceSticker = 2;
      state.lastPixelStickerAt = 0;
      state.lastMemeStickerAt = 0;
      state.lastStickerAt = 0;
      await h.maybeSendPixelSticker(state, 'group:456');
    };
    await send();
    let bytes = sentBytes(h);
    assert.equal(bytes.length, 1);
    assert.ok(matchesLibrary(bytes[0], 'pixel'));

    h.cfg.simulation.pixelSticker.style = 'anime';
    await send();
    bytes = sentBytes(h);
    assert.equal(bytes.length, 2);
    assert.ok(matchesLibrary(bytes[1], 'anime'));
    assert.ok(!matchesLibrary(bytes[1], 'pixel'));

    const snapshot = h.buildLiveSnapshot();
    assert.equal(snapshot.pixelSticker.style, 'anime');
    assert.equal(snapshot.pixelSticker.count, replyStickerCount('anime'));
    assert.deepEqual(snapshot.pixelSticker.scenes, replyStickerScenes('anime'));
    assert.equal(snapshot.content?.pixelSticker, undefined);
    assert.deepEqual(Object.keys(snapshot.pixelSticker.libraries).sort(), ['anime', 'pixel']);
    for (const style of STICKER_STYLES) {
      const library = snapshot.pixelSticker.libraries[style];
      assert.equal(library.count, replyStickerCount(style));
      assert.deepEqual(library.moods, replyStickerMoods(style));
      assert.deepEqual(library.scenes, replyStickerScenes(style));
    }
  } finally { await h.close(); }
});

test('回复高级配置 API：anime 热更新、非法值拒绝、重置回 pixel', async () => {
  const h = await bridgeHarness({ config: { consoleAuth: { enabled: false } } });
  fs.writeFileSync(path.join(h.temp, 'config.example.json'), read('config.example.json'));
  await withConsole(h, async ({ base }) => {
    const call = async (route, body) => {
      const response = await fetch(base + route, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body)
      });
      return { status: response.status, json: await response.json() };
    };
    const selected = await call('/api/features/advanced', {
      id: 'chatPixelSticker', values: { 'simulation.pixelSticker.style': 'anime' }
    });
    assert.equal(selected.status, 200);
    assert.equal(h.cfg.simulation.pixelSticker.style, 'anime');
    const invalid = await call('/api/features/advanced', {
      id: 'chatPixelSticker', values: { 'simulation.pixelSticker.style': 'chibi' }
    });
    assert.equal(invalid.status, 400);
    assert.equal(h.cfg.simulation.pixelSticker.style, 'anime');
    const reset = await call('/api/features/reset-advanced', { id: 'chatPixelSticker' });
    assert.equal(reset.status, 200);
    assert.equal(h.cfg.simulation.pixelSticker.style, 'pixel');
  });
});

test('场景运行链路：默认关闭、像素/二次元热切换、显式 style 优先与非法调用回退', async () => {
  const h = await bridgeHarness();
  try {
    h.setMode('simulation');
    assert.equal(h.cfg.simulation.sceneSticker.style, 'pixel');
    assert.equal(h.cfg.simulation.sceneSticker.enabled, false);
    assert.equal(await h.sendSceneStickerToKey('group:456', '今天在家读书'), false);
    assert.equal(imageSends(h).length, 0);

    h.cfg.simulation.sceneSticker.enabled = true;
    assert.equal(await h.sendSceneStickerToKey('group:456', '今天在家读书'), true);
    assert.ok(matchesLibrary(sentBytes(h)[0], 'pixel', 'scene'));

    h.cfg.simulation.sceneSticker.style = 'anime';
    assert.equal(await h.sendSceneStickerToKey('group:456', '今天在家读书'), true);
    assert.ok(matchesLibrary(sentBytes(h)[1], 'anime', 'scene'));
    assert.ok(!matchesLibrary(sentBytes(h)[1], 'pixel', 'scene'));

    h.cfg.simulation.sceneSticker.style = 'pixel';
    assert.equal(await h.sendSceneStickerToKey('group:456', '今天在家读书', { style: 'anime' }), true);
    assert.ok(matchesLibrary(sentBytes(h)[2], 'anime', 'scene'));
    assert.equal(await h.sendSceneStickerToKey('group:456', '今天在家读书', { style: 'unknown' }), true);
    assert.ok(matchesLibrary(sentBytes(h)[3], 'pixel', 'scene'));

    const snapshot = h.buildLiveSnapshot();
    assert.equal(snapshot.sceneSticker.style, 'pixel');
    assert.equal(snapshot.sceneSticker.count, sceneStickerCount('pixel'));
    assert.deepEqual(snapshot.sceneSticker.scenes, sceneStickerScenes('pixel'));
    assert.equal(snapshot.content?.sceneSticker, undefined);
    assert.deepEqual(Object.keys(snapshot.sceneSticker.libraries).sort(), ['anime', 'pixel']);
    for (const style of STICKER_STYLES) {
      const library = snapshot.sceneSticker.libraries[style];
      assert.equal(library.count, sceneStickerCount(style));
      assert.deepEqual(library.scenes, sceneStickerScenes(style));
    }
  } finally { await h.close(); }
});

test('贴纸库 API：四库数据、旧/显式图片路由、安全头与根路由', async () => {
  const h = await bridgeHarness({ config: { consoleAuth: { enabled: false } } });
  fs.mkdirSync(path.join(h.temp, 'web'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, 'web', 'deck.html'), path.join(h.temp, 'web', 'deck.html'));
  await withConsole(h, async ({ base }) => {
    const root = await fetch(base + '/');
    assert.equal(root.status, 200);
    assert.equal(await root.text(), read('web/deck.html'));

    const response = await fetch(base + '/api/sticker-library');
    assert.equal(response.status, 200);
    assertPrivateSecurityHeaders(response);
    const library = await response.json();
    assert.equal(library.ok, true);
    assert.deepEqual(library.mood, library.pixel);
    assert.deepEqual(library.scene, library.scenePixel);
    for (const [key, style, count] of [
      ['pixel', 'pixel', 120], ['anime', 'anime', 120],
      ['scenePixel', 'pixel', 60], ['sceneAnime', 'anime', 60]
    ]) {
      assert.equal(library[key].style, style);
      assert.equal(library[key].count, count);
      assert.equal(library[key].stickers.length, count);
      assert.ok(library[key].stickers.every((entry) => entry.style === style));
    }

    for (const [kind, style, dir, file] of [
      ['mood', 'pixel', PIXEL_STICKER_DIR, loadReplyStickers('pixel')[0].file],
      ['mood', 'anime', ANIME_STICKER_DIR, loadReplyStickers('anime')[0].file],
      ['scene', 'pixel', SCENE_STICKER_DIR, loadSceneStickers('pixel')[0].file],
      ['scene', 'anime', ANIME_SCENE_STICKER_DIR, loadSceneStickers('anime')[0].file]
    ]) {
      const image = await fetch(`${base}/api/sticker-library/image/${kind}/${style}/${encodeURIComponent(file)}`);
      assert.equal(image.status, 200, `${kind}/${style}/${file}`);
      assert.equal(image.headers.get('content-type'), 'image/png');
      assertPrivateSecurityHeaders(image);
      assert.ok(Buffer.from(await image.arrayBuffer()).equals(fs.readFileSync(path.join(dir, file))));
      if (style === 'pixel') {
        const legacy = await fetch(`${base}/api/sticker-library/image/${kind}/${encodeURIComponent(file)}`);
        assert.equal(legacy.status, 200);
        assert.ok(Buffer.from(await legacy.arrayBuffer()).equals(fs.readFileSync(path.join(dir, file))));
      }
    }
  });
});

test('贴纸库图片 API：未知风格、跨库、子路径、穿越与未登记文件一律 404', async () => {
  const h = await bridgeHarness({ config: { consoleAuth: { enabled: false } } });
  await withConsole(h, async ({ base }) => {
    const pixelMood = loadReplyStickers('pixel')[0].file;
    const pixelScene = loadSceneStickers('pixel')[0].file;
    const animeScene = loadSceneStickers('anime')[0].file;
    const routes = [
      `/api/sticker-library/image/mood/unknown/${pixelMood}`,
      `/api/sticker-library/image/mood/PIXEL/${pixelMood}`,
      `/api/sticker-library/image/mood/anime/whale-pixel-excited.png`,
      '/api/sticker-library/image/mood/anime/not-listed.png',
      '/api/sticker-library/image/mood/anime/bases%2Fwhale-anime-aggrieved.png',
      '/api/sticker-library/image/mood/anime/..%2Fmanifest.json',
      '/api/sticker-library/image/mood/anime/%2e%2e%2fmanifest.json',
      '/api/sticker-library/image/mood/anime/%E0%A4%A',
      `/api/sticker-library/image/scene/unknown/${pixelScene}`,
      `/api/sticker-library/image/scene/PIXEL/${pixelScene}`,
      `/api/sticker-library/image/scene/anime/${pixelScene}`,
      `/api/sticker-library/image/scene/pixel/${animeScene}`,
      '/api/sticker-library/image/scene/pixel/not-listed.png',
      `/api/sticker-library/image/scene/..%2F${encodeURIComponent(pixelScene)}`,
      '/api/sticker-library/image/unknown/pixel/not-listed.png'
    ];
    for (const route of routes) {
      const response = await fetch(base + route);
      assert.equal(response.status, 404, route);
      assertPrivateSecurityHeaders(response);
      assert.equal((await response.json()).ok, false);
    }
  });
});

test('贴纸库 API console-only：Host/token/agent/CSRF 闸门复用且未进 agent allowlist', async () => {
  assert.equal(agentTokenAllowedPath('/api/sticker-library'), false);
  assert.equal(agentTokenAllowedPath('/api/sticker-library/image/mood/pixel/happy-n-full.png'), false);
  const denied = evaluateAgentAccess({
    method: 'GET', headers: { 'x-agent-token': 'fixture-live-agent-token' }, pathname: '/api/sticker-library',
    simulationPaused: false, simulationEnabled: true, mode: 'simulation', slangStoreWritable: true, stickerStoreWritable: true
  });
  assert.equal(denied.action, 'respond');
  assert.equal(denied.status, 403);

  const h = await bridgeHarness();
  await withConsole(h, async ({ base }) => {
    const token = h.cfg.consoleToken;
    const unauthenticated = await fetch(base + '/api/sticker-library');
    assert.equal(unauthenticated.status, 401);
    const badHost = await rawRequest(base, '/api/sticker-library', { host: 'evil.invalid', 'x-console-token': token });
    assert.equal(badHost.status, 403);
    const invalidAgent = await fetch(base + '/api/sticker-library', {
      headers: { 'x-console-token': token, 'x-agent-call': '1', 'x-agent-token': 'not-live' }
    });
    assert.equal(invalidAgent.status, 403);
    const tokenlessAgent = await fetch(base + '/api/sticker-library', {
      headers: { 'x-console-token': token, 'x-agent-call': '1' }
    });
    assert.equal(tokenlessAgent.status, 403);
    const csrf = await fetch(base + '/api/sticker-library', {
      method: 'POST', headers: { 'x-console-token': token, 'content-type': 'application/json', origin: 'https://evil.invalid' }, body: '{}'
    });
    assert.equal(csrf.status, 403);
    const wrongType = await fetch(base + '/api/sticker-library', {
      method: 'POST', headers: { 'x-console-token': token, 'content-type': 'text/plain' }, body: '{}'
    });
    assert.equal(wrongType.status, 415);
    const allowed = await fetch(base + '/api/sticker-library', { headers: { 'x-console-token': token } });
    assert.equal(allowed.status, 200);
    assertPrivateSecurityHeaders(allowed);
  });
});

test('离线 console fixture：四库 API 与显式 style 图片路由不落入未知请求', async () => {
  const fixture = await startConsoleFixture({ port: 0 });
  try {
    const response = await fetch(fixture.url + '/api/sticker-library');
    assert.equal(response.status, 200);
    assertPrivateSecurityHeaders(response);
    const library = await response.json();
    assert.equal(library.pixel.count, 120);
    assert.equal(library.anime.count, 120);
    assert.equal(library.scenePixel.count, 60);
    assert.equal(library.sceneAnime.count, 60);
    const file = library.anime.stickers[0].file;
    const image = await fetch(`${fixture.url}/api/sticker-library/image/mood/anime/${encodeURIComponent(file)}`);
    assert.equal(image.status, 200);
    assertPrivateSecurityHeaders(image);
    assert.ok(Buffer.from(await image.arrayBuffer()).equals(fs.readFileSync(path.join(ANIME_STICKER_DIR, file))));
    assert.equal((await fetch(`${fixture.url}/api/sticker-library/image/mood/unknown/${file}`)).status, 404);
    for (const route of ['/api/stickers?query=&count=200', '/api/library/images?query=&limit=200']) {
      const response = await fetch(fixture.url + route);
      assert.equal(response.status, 200, route);
      assertPrivateSecurityHeaders(response);
    }
    const saved = await fetch(fixture.url + '/api/simulation/config', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true })
    });
    assert.equal(saved.status, 200);
    const content = await fetch(fixture.url + '/api/content');
    assert.equal(content.status, 200);
    const snapshot = await content.json();
    assert.equal(snapshot.pixelSticker.style, 'pixel');
    assert.equal(snapshot.pixelSticker.count, 120);
    assert.equal(snapshot.sceneSticker.style, 'pixel');
    assert.equal(snapshot.sceneSticker.count, 60);
    assert.deepEqual(fixture.unknownRequests, []);
  } finally { await fixture.close(); }
});

test('console/live/package 接线：四库分区、显式 style、顶层快照、唯一 ID 与 verify', () => {
  const deck = read('web/deck.html');
  const live = read('web/live.html');
  const bridge = read('app/whale.js');
  const fixture = read('tools/demo-console.mjs');
  const ids = [...deck.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((match) => match[1]);
  assert.equal(ids.length, new Set(ids).size);
  for (const id of ['libStickerLibMeta', 'libMoodStickers', 'libAnimeStickers', 'libPixelStickerCount', 'libAnimeStickerCount', 'libSceneStickers', 'libAnimeSceneStickers', 'libPixelSceneStickerCount', 'libAnimeSceneStickerCount']) {
    assert.equal(ids.filter((value) => value === id).length, 1, `${id} 应唯一`);
  }
  assert.match(deck, /field\.type === 'select'/);
  assert.match(deck, /image\/mood\/\$\{style\}\//);
  assert.match(deck, /image\/scene\/\$\{style\}\//);
  assert.match(deck, /<details[^>]*>\s*<summary class="meta">心情（二次元/);
  assert.match(deck, /<details[^>]*>\s*<summary class="meta">场景（二次元/);
  assert.match(deck, /scenePixel \|\| stickerLib\.scene/);
  assert.match(deck, /sceneAnime/);
  assert.match(deck, /style: \$\{style\}/);
  assert.match(live, /const moodSt = data\.pixelSticker \|\| \{\}/);
  assert.match(live, /const sceneSt = data\.sceneSticker \|\| \{\}/);
  assert.match(live, /const stickerStyle = moodSt\.style === 'anime'/);
  assert.match(live, /const sceneStyle = sceneSt\.style === 'anime'/);
  assert.match(live, /二次元 \$\{animeCount\} \/ 像素 \$\{pixelCount\}/);
  assert.match(live, /moodSt\.libraries\?\.anime\?\.count/);
  assert.match(live, /sceneSt\.libraries\?\.anime\?\.count/);
  assert.match(live, /sceneSt\.libraries\?\.pixel\?\.count \?\? sceneSt\.count/);
  assert.doesNotMatch(live, /data\.content\.(pixelSticker|sceneSticker)/);
  assert.match(bridge, /count:\s*replyStickerCount\(normalizeStickerStyle\(cfg\.simulation\?\.pixelSticker\?\.style\)\)/);
  assert.match(bridge, /count:\s*sceneStickerCount\(normalizeStickerStyle\(cfg\.simulation\?\.sceneSticker\?\.style\)\)/);
  assert.match(bridge, /pickReplySticker\(mood, Math\.random, null, pixelStickerRecentBases, style\)/);
  assert.match(bridge, /inferSceneFromText\(text, Math\.random, resolvedStyle\)/);
  assert.match(bridge, /pickSceneSticker\(want, Math\.random, resolvedStyle\)/);
  assert.match(bridge, /pixel:\s*moodLibrary\('pixel'\)/);
  assert.match(bridge, /anime:\s*moodLibrary\('anime'\)/);
  assert.match(bridge, /scenePixel:\s*sceneLibrary\('pixel'\)/);
  assert.match(bridge, /sceneAnime:\s*sceneLibrary\('anime'\)/);
  assert.match(bridge, /path\.join\(ROOT, 'web', 'deck\.html'\)/);
  assert.doesNotMatch(bridge, /public\/console\.html/);
  assert.match(fixture, /pixelSticker:\s*\{\s*enabled:\s*true,\s*afterText:\s*true,\s*style:\s*'pixel'/);
  assert.match(fixture, /sceneSticker:\s*\{\s*enabled:\s*false,\s*style:\s*'pixel'/);
  assert.match(fixture, /scenePixel:\s*sceneLibrary\('pixel'\)/);
  assert.match(fixture, /sceneAnime:\s*sceneLibrary\('anime'\)/);
  const pkg = readJson('package.json');
  const lock = readJson('package-lock.json');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages[''].version, pkg.version);
  assert.equal(pkg.scripts['test:anime-stickers'], 'node tests/anime-stickers.test.mjs');
  assert.match(pkg.scripts.verify, /npm run test:anime-stickers/);
});
