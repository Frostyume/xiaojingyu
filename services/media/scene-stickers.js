// 场景贴纸库：按像素/二次元风格读取独立场景插图，只随主动分享/心情语音/见闻附图。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeStickerStyle, STICKER_STYLES } from './pixel-stickers.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const SCENE_STICKER_DIR = path.join(ROOT, 'web', 'assets', 'scene-stickers');
export const ANIME_SCENE_STICKER_DIR = path.join(ROOT, 'web', 'assets', 'anime-scene-stickers');

const caches = new Map();

function sceneStickerDir(style) {
  return normalizeStickerStyle(style) === 'anime' ? ANIME_SCENE_STICKER_DIR : SCENE_STICKER_DIR;
}

export function loadSceneStickers(style = 'pixel') {
  const normalized = normalizeStickerStyle(style);
  if (caches.has(normalized)) return caches.get(normalized);
  let stickers = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(sceneStickerDir(normalized), 'manifest.json'), 'utf8'));
    stickers = Array.isArray(manifest.stickers)
      ? manifest.stickers.map((entry) => ({ ...entry, style: normalized }))
      : [];
  } catch {}
  caches.set(normalized, stickers);
  return stickers;
}

export function sceneStickerCount(style = 'pixel') {
  return loadSceneStickers(style).length;
}

export function sceneStickerScenes(style = 'pixel') {
  return [...new Set(loadSceneStickers(style).map((s) => s.scene).filter(Boolean))];
}

// 人设护栏：场景插图同样不许改色/加挂饰；条目必须带场景标签与匹配词。
export function assertOnModelSceneEntry(s) {
  if (!s || typeof s !== 'object') throw new Error('scene sticker entry must be an object');
  if (s.style !== undefined && !STICKER_STYLES.includes(s.style)) throw new Error(`贴纸风格非法：${s.file}`);
  if (s.hue !== undefined && s.hue !== 0) throw new Error(`不得改色：${s.file}`);
  if (s.accessory !== undefined && s.accessory !== 'none') throw new Error(`不得加挂饰：${s.file}`);
  if (typeof s.file !== 'string' || !s.file.endsWith('.png')) throw new Error(`文件名非法：${s.file}`);
  if (typeof s.scene !== 'string' || !s.scene) throw new Error(`缺少场景标签：${s.file}`);
  if (!Array.isArray(s.tags) || !s.tags.length || s.tags.some((t) => typeof t !== 'string' || !t)) throw new Error(`缺少匹配词：${s.file}`);
  return true;
}

/** 按分享正文推断场景：命中匹配词最多的场景胜出，平局随机；无命中返回 null（不附）。 */
export function inferSceneFromText(text, rng = Math.random, style = 'pixel') {
  const t = String(text ?? '');
  if (!t) return null;
  const matched = new Map();
  for (const s of loadSceneStickers(style)) {
    for (const tag of s.tags || []) {
      if (!tag || !t.includes(tag)) continue;
      if (!matched.has(s.scene)) matched.set(s.scene, new Set());
      matched.get(s.scene).add(tag);
    }
  }
  if (!matched.size) return null;
  const best = Math.max(...[...matched.values()].map((set) => set.size));
  const tops = [...matched.entries()].filter(([, set]) => set.size === best).map(([scene]) => scene);
  return tops[Math.floor(rng() * tops.length) % tops.length];
}

/** 挑一张指定场景的插图；该场景没有就返回 null（不回退全库，无匹配不附）。 */
export function pickSceneSticker(scene, rng = Math.random, style = 'pixel') {
  const normalized = normalizeStickerStyle(style);
  const list = loadSceneStickers(normalized).filter((s) => s.scene === scene);
  if (!list.length) return null;
  const s = list[Math.floor(rng() * list.length) % list.length];
  return { ...s, style: normalized, path: path.join(sceneStickerDir(normalized), s.file) };
}
