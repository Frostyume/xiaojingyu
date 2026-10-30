// 轻量视觉判断：只用于「这张图能不能当小鲸鱼表情」这类二元分类。
// 复用 ChatAnywhere 的视觉模型；失败时不猜，直接拒绝入库（表情收藏宁可少，不要脏）。

import { detectImageMime } from './image-lib.js';

function visionConfig(cfg) {
  const ws = cfg?.webSearch ?? {};
  const key = String(ws.apiKey || '').trim() || String(process.env[String(ws.apiKeyEnv || 'CHATANYWHERE_API_KEY')] || '').trim();
  if (!key) throw new Error('未配置视觉模型凭据（webSearch.apiKey / CHATANYWHERE_API_KEY）');
  return {
    key,
    baseURL: String(ws.baseURL || 'https://api.chatanywhere.tech/v1').replace(/\/+$/, ''),
    model: String(ws.model || 'gemini-2.5-flash-lite')
  };
}

function dataUrl(buffer) {
  const mime = detectImageMime(buffer) || 'image/jpeg';
  const b64 = Buffer.from(buffer).toString('base64');
  return `data:${mime};base64,${b64}`;
}

async function askVision(cfg, prompt, buffer, { maxTokens = 200, timeoutMs = 60000 } = {}) {
  const conf = visionConfig(cfg);
  const res = await fetch(`${conf.baseURL}/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${conf.key}` },
    body: JSON.stringify({
      model: conf.model,
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          { type: 'image_url', image_url: { url: dataUrl(buffer) } }
        ]
      }],
      max_tokens: maxTokens,
      temperature: 0
    }),
    signal: AbortSignal.timeout(Math.max(5000, Number(timeoutMs) || 60000))
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`视觉模型 HTTP ${res.status}：${String(data?.error?.message || data?.message || '').slice(0, 160)}`);
  return String(data?.choices?.[0]?.message?.content || '').replace(/\s+/g, ' ').trim();
}

function parseJson(text) {
  const raw = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim();
  try { return JSON.parse(raw); } catch { return null; }
}

/**
 * 是否是「小鲸鱼 Q 版形象」表情。只输出 true 才允许进 QQ 收藏表情。
 * 失败/不确定一律 false，避免把截图、梗图、其他角色塞进表情库。
 */
export async function isQVersionWhaleSticker(cfg, buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 100) return { ok: false, reason: '图片数据无效' };
  const prompt = [
    '判断这张图能否作为「小鲸鱼 / DeepSeek 鲸鱼娘」的 Q 版形象表情。',
    '必须同时满足：1) 二次元 Q 版/卡通角色；2) 主角是蓝发、鲸鱼尾、小鲸鱼或明显同一角色；3) 不是真人、聊天截图、纯文字图、其他角色、普通动物照片。',
    '只输出 JSON：{"ok":true或false,"reason":"不超过30字"}。不确定就 false。'
  ].join('');
  const text = await askVision(cfg, prompt, buffer, { maxTokens: 160, timeoutMs: 45000 });
  const obj = parseJson(text);
  if (!obj || typeof obj.ok !== 'boolean') return { ok: false, reason: '视觉模型未给出明确判断' };
  return { ok: obj.ok === true, reason: String(obj.reason || '').slice(0, 80) };
}
