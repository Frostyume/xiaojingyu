// 像素贴纸库：读取生成器产出的 manifest，按心情挑一张透明像素贴纸。
// 库由 tools/gen-pixel-stickers.py 生成（保持人设、背景透明），这里只读不写。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const DIR = path.join(ROOT, 'web', 'assets', 'pixel-stickers');

let cache = null;
export function loadPixelStickers() {
  if (cache) return cache;
  try {
    const m = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.json'), 'utf8'));
    cache = Array.isArray(m.stickers) ? m.stickers : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function pixelStickerCount() {
  return loadPixelStickers().length;
}

export function pixelStickerMoods() {
  return [...new Set(loadPixelStickers().map((s) => s.mood))];
}

/** 按心情挑一张；该心情没有就退回全库。返回 { ...meta, path } 或 null。 */
export function pickPixelSticker(mood, rng = Math.random) {
  const all = loadPixelStickers();
  if (!all.length) return null;
  const pool = all.filter((s) => s.mood === mood);
  const list = pool.length ? pool : all;
  const s = list[Math.floor(rng() * list.length) % list.length];
  return { ...s, path: path.join(DIR, s.file) };
}