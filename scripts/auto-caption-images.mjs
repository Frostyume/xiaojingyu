// 批量重识别通用图片库：用 ChatAnywhere 视觉模型修正名称/备注/标签。
// 运行：node scripts/auto-caption-images.mjs
// 重跑全部：FORCE_IMAGES=1 node scripts/auto-caption-images.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = path.join(ROOT, 'state');
const LOG = path.join(STATE, 'auto-caption-images.log');
const PROGRESS = path.join(STATE, 'auto-caption-images-progress.json');
const BASE = process.env.BRIDGE_CONSOLE ?? 'http://127.0.0.1:3100';
const MODEL = process.env.CAPTION_MODEL ?? 'gemini-2.5-flash-lite';
const FALLBACK = process.env.CAPTION_FALLBACK ?? 'gemini-3.5-flash-lite';
const API_BASE = process.env.CAPTION_BASE ?? 'https://api.chatanywhere.tech/v1';
const FORCE = process.env.FORCE_IMAGES === '1';
const CONCURRENCY = Math.max(1, Math.min(5, Number(process.env.CAPTION_CONCURRENCY) || 3));

const PROMPT = '用中文重新识别这张图片（可能是表情、截图、梗图或网络图片）。只输出 JSON：'
  + '{"title":"不超过18字的具体标题","description":"画面内容+适合什么场景，40字以内","tags":["标签1","标签2"]}。'
  + '标题不要写“图片1/截图/表情包/管理员投喂”这类来源词；标签 2~4 个，各 2~6 字。';

function log(message) {
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}

function readKey() {
  if (process.env.CHAT_ANYWHERE_API_KEY) return process.env.CHAT_ANYWHERE_API_KEY;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const k = String(cfg?.webSearch?.apiKey || '').trim();
    if (k) return k;
  } catch {}
  try {
    const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
    const m = fs.readFileSync(p, 'utf8').match(/CHAT_ANYWHERE_API_KEY\s*:\s*["']?([^\s"']+)/);
    return m ? m[1] : '';
  } catch { return ''; }
}

function readToken() {
  try {
    const p = path.join(STATE, 'console-token');
    return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
  } catch { return ''; }
}

function parseCaption(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    const obj = JSON.parse(raw);
    const title = String(obj.title || '').replace(/\s+/g, ' ').trim().slice(0, 18);
    const description = String(obj.description || obj.note || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const tags = (Array.isArray(obj.tags) ? obj.tags : String(obj.tags || '').split(/[,，、\s]+/))
      .map((t) => String(t).trim()).filter(Boolean).slice(0, 4);
    if (description) return { title: title || description.slice(0, 12), description, tags };
  } catch {}
  return null;
}

async function caption(apiKey, b64, mime) {
  for (const model of [MODEL, MODEL, FALLBACK]) {
    try {
      const res = await fetch(`${API_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:${mime || 'image/jpeg'};base64,${b64}` } }
          ] }],
          max_tokens: 300,
          temperature: 0
        }),
        signal: AbortSignal.timeout(60000)
      });
      const data = await res.json().catch(() => ({}));
      const parsed = parseCaption(data.choices?.[0]?.message?.content);
      if (parsed) return parsed;
    } catch (error) {
      log(`${model} 失败：${error?.message ?? error}`);
    }
  }
  return null;
}

function loadProgress() {
  try { return JSON.parse(fs.readFileSync(PROGRESS, 'utf8')) || {}; } catch { return {}; }
}
function saveProgress(value) {
  try { fs.writeFileSync(PROGRESS, JSON.stringify(value, null, 2)); } catch {}
}

async function main() {
  const apiKey = readKey();
  if (!apiKey) { log('缺少视觉模型 key，退出'); return; }
  const token = readToken();
  const headers = token ? { 'x-console-token': token } : {};
  const list = await fetch(`${BASE}/api/library/images?limit=500`, { headers }).then((r) => r.json());
  if (!list?.ok) { log(`读取图片库失败：${list?.error ?? 'unknown'}`); return; }
  const progress = loadProgress();
  const pending = (list.entries || []).filter((e) => FORCE || !progress[e.id]);
  log(`共 ${list.total} 张，本次待处理 ${pending.length} 张，并发 ${CONCURRENCY}`);
  let index = 0;
  let ok = 0;
  let failed = 0;

  async function worker() {
    while (index < pending.length) {
      const entry = pending[index++];
      try {
        const res = await fetch(`${BASE}/api/library/images/${encodeURIComponent(entry.id)}`, { headers, signal: AbortSignal.timeout(60000) });
        if (!res.ok) throw new Error(`取图 HTTP ${res.status}`);
        const buffer = Buffer.from(await res.arrayBuffer());
        const parsed = await caption(apiKey, buffer.toString('base64'), entry.mime || res.headers.get('content-type'));
        if (!parsed) throw new Error('视觉模型未返回有效描述');
        const saved = await fetch(`${BASE}/api/library/images/update`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ id: entry.id, name: parsed.title, note: parsed.description, tags: parsed.tags })
        }).then((r) => r.json());
        if (!saved?.ok) throw new Error(saved?.error || '写入失败');
        ok += 1;
        progress[entry.id] = { at: Date.now(), title: parsed.title };
        if (ok % 5 === 0) saveProgress(progress);
        log(`${entry.id} ${entry.name || '未命名'} → ${parsed.title} / ${parsed.description}`);
      } catch (error) {
        failed += 1;
        log(`${entry.id} 失败：${error?.message ?? error}`);
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  saveProgress(progress);
  log(`完成：成功 ${ok}，失败 ${failed}，累计已处理 ${Object.keys(progress).length}/${list.total}`);
}

main().catch((error) => log(`未捕获错误：${error?.message ?? error}`));
