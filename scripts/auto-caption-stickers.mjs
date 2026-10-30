// 自动给「没有备注」的收藏表情补画面描述 + 标签。
//
// 为什么需要它：QQ 会话用的模型（deepseek-v4.1-flash-1017）不支持图像输入，
// 它自己看不了表情图，也就写不了备注；表情库没备注 → 选图只能瞎猜 → 干脆不发。
// 所以这里用 chat-anywhere 的视觉模型代看，把结果写回桥接的表情库（localNote/tags）。
//
// 触发方式：Windows 计划任务每 30 分钟跑一次（见 scripts/install-caption-task.ps1）。
// 只处理 localNote 为空的表情，已备注的永远跳过，所以重复跑没有额外开销。

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const STATE = path.join(ROOT, 'state');
const LOG = path.join(STATE, 'auto-caption.log');
const BASE = process.env.BRIDGE_CONSOLE ?? 'http://127.0.0.1:3100';
// 主模型用 gemini-2.5-flash-lite：实测每张图约 1.1k 输入 token、3~5 秒、能读出图上的字，
// 比 gpt-4o-mini（同类图 25k+ token）便宜一个数量级，描述也比 gpt-4.1-nano 具体。
// 主模型偶尔返回空内容，所以留一个备用模型兜底。
const VISION_MODEL = process.env.CAPTION_MODEL ?? 'gemini-2.5-flash-lite';
const VISION_FALLBACK = process.env.CAPTION_FALLBACK ?? 'gemini-3.5-flash-lite';
const VISION_BASE = process.env.CAPTION_BASE ?? 'https://api.chatanywhere.tech/v1';

function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
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
  const p = path.join(os.homedir(), '.dsh', '.credentials.yaml');
  if (!fs.existsSync(p)) return '';
  const raw = fs.readFileSync(p, 'utf8');
  const m = raw.match(/CHAT_ANYWHERE_API_KEY\s*:\s*["']?([^\s"']+)/);
  return m ? m[1] : '';
}

function readConsoleToken() {
  const p = path.join(STATE, 'console-token');
  return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : '';
}

function pickKey() {
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const g = cfg?.allow?.groups?.[0];
    if (g) return `group:${g}`;
    const p = cfg?.ownerQQ;
    if (p) return `private:${p}`;
  } catch {}
  return '';
}

const PROMPT =
  '用中文重新识别这张 QQ 表情包。只输出一个 JSON 对象：' +
  '{"title":"不超过12字的标题","description":"画面（角色/表情/动作/文字）+适合什么聊天场景，35字以内","tags":["标签1","标签2"]}。' +
  '标题要具体，不要写“管理员投喂/图片1/表情包”这类来源词；标签 2~4 个，各 2~5 字。';

async function caption(apiKey, b64) {
  const plan = [VISION_MODEL, VISION_MODEL, VISION_FALLBACK];
  for (let attempt = 0; attempt < plan.length; attempt++) {
    const model = plan[attempt];
    try {
      const res = await fetch(`${VISION_BASE}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: [
            { type: 'text', text: PROMPT },
            { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${b64}` } }
          ] }],
          max_tokens: 300
        }),
        signal: AbortSignal.timeout(60000)
      });
      const data = await res.json();
      const line = (data.choices?.[0]?.message?.content || '').replace(/\s+/g, ' ').trim();
      if (line) return line;
      log(`${model} 返回空内容（第 ${attempt + 1} 次）`);
    } catch (e) {
      log(`${model} 调用失败（第 ${attempt + 1} 次）：${e.message}`);
    }
  }
  return '';
}

function parseCaption(line) {
  const raw = String(line || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try {
    const obj = JSON.parse(raw);
    const title = String(obj.title || '').replace(/\s+/g, ' ').trim().slice(0, 20);
    const description = String(obj.description || obj.note || '').replace(/\s+/g, ' ').trim().slice(0, 80);
    const tags = (Array.isArray(obj.tags) ? obj.tags : String(obj.tags || '').split(/[,，、\s]+/))
      .map((t) => String(t).trim()).filter(Boolean).slice(0, 4);
    if (description) return { title: title || description.slice(0, 12), description, tags };
  } catch {}
  const [note, tagStr = ''] = raw.split('|');
  const description = String(note || '').trim();
  return {
    title: description.slice(0, 12),
    description,
    tags: tagStr.split(/[,，、\s]+/).filter(Boolean).slice(0, 4)
  };
}

async function main() {
  const apiKey = readKey();
  const token = readConsoleToken();
  const key = pickKey();
  if (!apiKey || !key) {
    log(`缺少必要信息（key=${!!apiKey} 会话=${!!key}），跳过`);
    return;
  }
  const headers = token ? { 'x-console-token': token } : {};
  const force = process.env.FORCE_CAPTION === '1';

  let list;
  try {
    const res = await fetch(`${BASE}/api/stickers`, { headers });
    if (!res.ok) { log(`读取表情库失败：HTTP ${res.status}`); return; }
    list = await res.json();
  } catch (e) {
    log(`桥接未运行（${e.message}），跳过`);
    return;
  }

  const pending = (list.stickers || []).filter((s) => force
    || !String(s.localNote || '').trim()
    || /管理员投喂|投喂|图片\d+|表情包/i.test(String(s.desc || '')));
  if (!pending.length) return; // 没新表情就完全安静，不写日志
  log(`发现 ${pending.length} 张需要重识别的表情，开始处理${force ? '（force）' : ''}`);

  for (const s of pending) {
    try {
      const imgRes = await fetch(`${BASE}/api/socialV2/sticker-image?key=${encodeURIComponent(key)}&stickerId=${encodeURIComponent(s.md5)}`, {
        headers,
        signal: AbortSignal.timeout(60000)
      });
      const img = await imgRes.json();
      if (!img?.image?.data) { log(`${s.md5} 取图失败：${img?.error ?? '无数据'}`); continue; }

      const line = await caption(apiKey, img.image.data);
      if (!line) { log(`${s.md5} 三次都没拿到描述，跳过`); continue; }
      const parsed = parseCaption(line);
      if (!parsed.description) { log(`${s.md5} 描述为空，跳过`); continue; }

      // 用视觉结果修正 QQ 官方备注（标题），再写本地描述/标签。
      try {
        await fetch(`${BASE}/api/stickers/remark`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...headers },
          body: JSON.stringify({ stickerId: s.md5, remark: parsed.title })
        });
      } catch (e) { log(`${s.md5} 改标题失败：${e.message}`); }
      const saved = await (await fetch(`${BASE}/api/stickers/note`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify({ stickerId: s.md5, note: parsed.description, tags: parsed.tags })
      })).json();
      log(`${s.md5} 「${s.desc || '无备注'}」→ ${parsed.title} / ${parsed.description} [${parsed.tags.join('/')}] ok=${saved.ok}`);
    } catch (e) {
      log(`${s.md5} 处理失败：${e.message}`);
    }
  }
}

main().catch((e) => log(`未捕获错误：${e.message}`));
