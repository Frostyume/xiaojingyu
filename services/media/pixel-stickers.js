// 回复贴纸库：按像素/二次元风格读取各自 manifest，只允许翻转与裁剪。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const PIXEL_STICKER_DIR = path.join(ROOT, 'web', 'assets', 'pixel-stickers');
export const ANIME_STICKER_DIR = path.join(ROOT, 'web', 'assets', 'anime-stickers');
export const STICKER_STYLES = Object.freeze(['pixel', 'anime']);

export function normalizeStickerStyle(style) {
  return STICKER_STYLES.includes(style) ? style : 'pixel';
}

function stickerDir(style) {
  return normalizeStickerStyle(style) === 'anime' ? ANIME_STICKER_DIR : PIXEL_STICKER_DIR;
}

const caches = new Map();
export function loadReplyStickers(style = 'pixel') {
  const normalized = normalizeStickerStyle(style);
  if (caches.has(normalized)) return caches.get(normalized);
  let stickers = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(stickerDir(normalized), 'manifest.json'), 'utf8'));
    stickers = Array.isArray(manifest.stickers) ? manifest.stickers.map((entry) => ({ ...entry, style: normalized })) : [];
  } catch {}
  caches.set(normalized, stickers);
  return stickers;
}

export function loadPixelStickers() {
  return loadReplyStickers();
}

export function replyStickerCount(style = 'pixel') {
  return loadReplyStickers(style).length;
}

export function pixelStickerCount() {
  return replyStickerCount();
}

export function replyStickerMoods(style = 'pixel') {
  return [...new Set(loadReplyStickers(style).map((s) => s.mood))];
}

export function pixelStickerMoods() {
  return replyStickerMoods();
}

export function replyStickerScenes(style = 'pixel') {
  return [...new Set(loadReplyStickers(style).map((s) => s.scene).filter((s) => s && s !== 'none'))];
}

export function pixelStickerScenes() {
  return replyStickerScenes();
}

// 同一回合内像素贴纸与表情包互斥。turn/start 会清零两个时间戳；
// windowMs 是漏掉 turn 事件时的兜底窗口，<=0 表示关闭互斥闸（回滚开关）。
export const STICKER_TURN_WINDOW_MS = 10 * 60 * 1000;
export function stickerTurnGate({ lastMemeStickerAt = 0, lastPixelStickerAt = 0, now = Date.now(), windowMs = STICKER_TURN_WINDOW_MS } = {}) {
  const w = Number(windowMs);
  if (!(w > 0)) return { allowPixel: true, allowMeme: true, reason: null };
  const memeFresh = Number(lastMemeStickerAt) > 0 && now - Number(lastMemeStickerAt) < w;
  const pixelFresh = Number(lastPixelStickerAt) > 0 && now - Number(lastPixelStickerAt) < w;
  if (memeFresh) return { allowPixel: false, allowMeme: true, reason: 'meme-this-turn' };
  if (pixelFresh) return { allowPixel: true, allowMeme: false, reason: 'pixel-this-turn' };
  return { allowPixel: true, allowMeme: true, reason: null };
}

// 人设护栏：库条目只允许翻转+裁剪，绝不允许改色(hue)或加挂饰(accessory)。
export function assertOnModelEntry(s) {
  if (!s || typeof s !== 'object') throw new Error('sticker entry must be an object');
  if (s.style !== undefined && !STICKER_STYLES.includes(s.style)) throw new Error(`贴纸风格非法：${s.file}`);
  if (s.hue !== undefined && s.hue !== 0) throw new Error(`不得改色：${s.file}`);
  if (s.accessory !== undefined && s.accessory !== 'none') throw new Error(`不得加挂饰：${s.file}`);
  if (!['full', 'head'].includes(s.crop)) throw new Error(`裁剪类型非法：${s.file}`);
  if (typeof s.file !== 'string' || !s.file.endsWith('.png')) throw new Error(`文件名非法：${s.file}`);
  if (typeof s.mood !== 'string' || !s.mood) throw new Error(`缺少心情标签：${s.file}`);
  return true;
}

/** 按心情挑一张（可选情景优先）；该心情没有就退回所选风格全库。返回 { ...meta, path } 或 null。 */
export function pickReplySticker(mood, rng = Math.random, scene = null, avoidBases = [], style = 'pixel') {
  const normalized = normalizeStickerStyle(style);
  const all = loadReplyStickers(normalized);
  if (!all.length) return null;
  let list = all.filter((s) => s.mood === mood);
  if (scene) {
    const scoped = list.filter((s) => s.scene === scene);
    if (scoped.length) list = scoped;
  }
  if (!list.length) list = all;
  // 近期底图回避：同一心情/场景里还有别的底图时，先排掉最近发过的，缓解“总是同一张”的观感。
  const avoid = new Set((Array.isArray(avoidBases) ? avoidBases : []).map((base) => String(base ?? '').trim()).filter(Boolean));
  if (avoid.size) {
    const fresh = list.filter((s) => !avoid.has(String(s.base ?? '')));
    if (fresh.length) list = fresh;
  }
  const s = list[Math.floor(rng() * list.length) % list.length];
  return { ...s, style: normalized, path: path.join(stickerDir(normalized), s.file) };
}

export function pickPixelSticker(mood, rng = Math.random, scene = null, avoidBases = []) {
  return pickReplySticker(mood, rng, scene, avoidBases);
}

/** 近期底图列表归一化：去空、去重，保留最近 limit 条。 */
export function normalizeRecentPixelBases(raw, limit = PIXEL_STICKER_RECENT_BASES) {
  const list = (Array.isArray(raw) ? raw : [])
    .map((base) => String(base ?? '').trim())
    .filter(Boolean);
  return [...new Set(list)].slice(-Math.max(1, Number(limit) || PIXEL_STICKER_RECENT_BASES));
}

export const PIXEL_STICKER_RECENT_BASES = 3;

/** 成功发出一张后，把它的底图记到最近列表（推进、去重、封顶）。 */
export function mergeRecentPixelBases(recent, base, limit = PIXEL_STICKER_RECENT_BASES) {
  const value = String(base ?? '').trim();
  const list = normalizeRecentPixelBases(recent, limit);
  if (!value) return list;
  const next = [...list.filter((item) => item !== value), value];
  return next.slice(-Math.max(1, Number(limit) || PIXEL_STICKER_RECENT_BASES));
}
