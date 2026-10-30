// 功能中心的语音 action：复用 Breeze 的声线与 mood 表演，独立于聊天语音链路。
// 只负责合成，不负责发送；发送由桥接的 sendVoiceFile 完成。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const MOOD_OVERRIDES = {
  happy: '这句自然轻快，不要刻意装可爱：不要提高音调，不要奶声奶气，不要每个字都往上飘。',
  playful: '这句活泼但自然，别刻意尖着嗓子卖萌，也不要一直上扬。',
  sleepy: '这一句真的很困：整体语速放到平时的七成，句子之间多停一下，尾音轻而略含糊，音调比平时低一点；不要提亮、不要上扬、不要元气、不要笑意，像半睡半醒地嘟囔。',
  sad: '这句放慢、放低，气息轻，句尾往下沉；不要哭腔，不要播音腔。',
  angry: '这句短促、压低、带一点硬，不要尖着嗓子喊。',
  shy: '这句放轻放软，不必刻意提高音调，不要奶声奶气。',
  proud: '自然一点得意，尾音轻抬即可，不要夸张上扬。'
};

function resolveMood(mood, text) {
  const m = String(mood || '').trim();
  const sleepyText = /(困|想睡|睡着|睡了|晚安|好累|累死|睁不开眼|眼皮|打哈欠)/.test(String(text || ''));
  if (sleepyText && (!m || m === 'happy' || m === 'playful')) return 'sleepy';
  return m;
}

function shapeText(text, mood) {
  let s = String(text || '').trim();
  if (mood === 'sleepy') {
    s = s.replace(/。+/g, '……');
    const idx = s.search(/[，,]/);
    if (idx > 0 && idx < 18 && !s.slice(0, idx + 4).includes('……')) s = `${s.slice(0, idx + 1)}……${s.slice(idx + 1)}`;
  }
  return /[。！？!?…~～]$/.test(s) ? s : `${s}。`;
}

export function featureVoiceInstruction(tts, mood = '') {
  const b = tts?.breeze || {};
  const base = String(b.baseInstruction || '').trim();
  const delivery = String(b.softDelivery || '').trim();
  const moodText = String(b.moodInstructions?.[mood] || '').trim();
  const override = String(b.moodOverrides?.[mood] || MOOD_OVERRIDES[mood] || '').trim();
  return [base, delivery, moodText, override ? `这一句的表演以最后这段为准：${override}` : ''].filter(Boolean).join(' ');
}

export async function synthesizeFeatureVoice({ text, mood = '', cfg, outDir }) {
  const b = cfg?.tts?.breeze || {};
  if (b.enabled === false || !b.opusUrl) throw new Error('Breeze 语音未启用');
  const clean = String(text || '').trim();
  if (!clean) throw new Error('语音内容为空');
  if (clean.length > 60) throw new Error('语音最多 60 字');
  const effectiveMood = resolveMood(mood, clean);
  const instruction = featureVoiceInstruction(cfg.tts, effectiveMood);
  const ttsText = shapeText(clean, effectiveMood);
  const cfgScale = Number(b.moodCfgScale?.[effectiveMood]) > 0 ? Number(b.moodCfgScale[effectiveMood]) : (Number(b.cfgScale) || 3.5);
  const hash = crypto.createHash('sha1')
    .update(`feature|${effectiveMood}|${instruction}|${ttsText}|cfg=${cfgScale}`)
    .digest('hex').slice(0, 16);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `feature-${hash}.ogg`);
  if (fs.existsSync(outFile) && Date.now() - fs.statSync(outFile).mtimeMs < 6 * 3600 * 1000) {
    return { path: outFile, mood: effectiveMood, cached: true };
  }
  const fd = new FormData();
  fd.append('text', ttsText);
  fd.append('instruction', instruction);
  fd.append('cfg_scale', String(cfgScale));
  fd.append('seed', String(Number(b.seed) || 12345));
  fd.append('bitrate', String(b.opusBitrate || '32k'));
  const res = await fetch(`${String(b.opusUrl).replace(/\/+$/, '')}/v1/audio/speech_opus`, {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(Number(b.opusTimeoutMs) > 0 ? Number(b.opusTimeoutMs) : 45000)
  });
  if (!res.ok) throw new Error(`语音合成失败：HTTP ${res.status} ${(await res.text()).slice(0, 120)}`);
  const seconds = Number(res.headers.get('x-source-seconds')) || 0;
  if (seconds > (Number(cfg?.tts?.maxSeconds) || 45)) throw new Error(`语音结果 ${seconds.toFixed(0)} 秒，超长`);
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length < 64) throw new Error('语音合成没有返回有效音频');
  fs.writeFileSync(outFile, buffer);
  return { path: outFile, mood: effectiveMood, seconds, bytes: buffer.length, cached: false };
}
