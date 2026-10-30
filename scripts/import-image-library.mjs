// 把一批已下载的图片导入图片库（写文件到库目录 + 登记到 state/images.json）。
//
// 用法：
//   node scripts/import-image-library.mjs --src D:/temp/whale-images --manifest D:/temp/bfa-index.json \
//     --dir D:/qq-bridge-images --subdir memes --origin import --license "CC BY-NC-SA 4.0"
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { loadImageStore, saveImageStore, normalizeImageEntry, detectImageMime } from '../src/image-lib.js';

function arg(name, fallback = '') {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const srcDir = path.resolve(arg('src'));
const manifestPath = arg('manifest');
const libDir = path.resolve(arg('dir', 'D:/qq-bridge-images'));
const subdir = arg('subdir', 'memes').replace(/[^a-z0-9_-]/gi, '') || 'memes';
const origin = arg('origin', 'import');
const license = arg('license', '');
const storeFile = path.resolve(arg('store', 'state/images.json'));

const manifest = manifestPath ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : { stickers: [] };
const byFile = new Map();
for (const s of manifest.stickers || []) {
  const file = String(s.preview || '').split('/').pop();
  if (file) byFile.set(file, s);
}

const entries = loadImageStore(storeFile);
const byMd5 = new Map(entries.map((e) => [e.md5, e]));
let imported = 0;
let skipped = 0;
let bytes = 0;

for (const file of fs.readdirSync(srcDir)) {
  const ext = path.extname(file).toLowerCase();
  if (!['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) continue;
  const abs = path.join(srcDir, file);
  const buffer = fs.readFileSync(abs);
  const md5 = crypto.createHash('md5').update(buffer).digest('hex');
  if (byMd5.has(md5)) { skipped += 1; continue; }
  const meta = byFile.get(file) || {};
  const rel = `${subdir}/${path.basename(file, ext)}${ext}`;
  const dest = path.join(libDir, rel);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(abs, dest);
  const entry = normalizeImageEntry({
    id: md5,
    name: path.basename(file, ext),
    file: rel,
    mime: detectImageMime(buffer) || 'image/webp',
    bytes: buffer.length,
    md5,
    width: Number(meta.width) || 0,
    height: Number(meta.height) || 0,
    note: meta.alt || '',
    tags: Array.isArray(meta.tags) ? meta.tags : [],
    sourceUrl: meta.preview || '',
    license,
    origin
  });
  entries.push(entry);
  byMd5.set(md5, entry);
  imported += 1;
  bytes += buffer.length;
}

saveImageStore(storeFile, entries);
console.log(JSON.stringify({ imported, skipped, total: entries.length, libDir, storeFile, bytes }, null, 1));