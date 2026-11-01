// TTS 情绪 → 参考音色/语速。
//
// 不新增工具参数（避免为了一个可选字段重启 DSH）：桥接/MCP 从要说的文本里做一个
// 保守的情绪推断，再按配置或人格包的映射选择参考音频与语速。推断错了也只是音色略偏，
// 不会改变文本内容或发送对象。

import fs from 'node:fs';
import path from 'node:path';
import { loadPersonaPack } from './persona-pack.js';

export const TTS_EMOTIONS = Object.freeze(['neutral', 'soft', 'shy', 'happy', 'sad', 'excited']);

const RULES = [
  { emotion: 'shy', re: /害羞|不好意|脸红|别夸|唔…|唔\.\.\.|哼|讨厌啦|才没有|嘛～|嘛~/i },
  { emotion: 'happy', re: /开心|高兴|太好|好耶|哈哈|嘿嘿|喜欢|棒|厉害|成功|赢|耶！|耶!|♪/i },
  { emotion: 'sad', re: /难过|伤心|想哭|委屈|失落|孤单|呜呜|唉|可惜|遗憾/i },
  { emotion: 'excited', re: /激动|冲|太爽|绝了|啊啊啊|！！|!!|哇！|哇!/i },
  { emotion: 'soft', re: /晚安|早点睡|抱抱|乖|辛苦|注意身体|慢点|轻声|悄悄|摸摸/i }
];

/** 从文本推断情绪；无法判断返回 neutral。优先级：shy > sad > excited > happy > soft。 */
export function inferTtsEmotion(text) {
  const s = String(text ?? '');
  if (!s.trim()) return 'neutral';
  for (const emotion of ['shy', 'sad', 'excited', 'happy', 'soft']) {
    const rule = RULES.find((r) => r.emotion === emotion);
    if (rule && rule.re.test(s)) return emotion;
  }
  return 'neutral';
}

function pickNumber(map, key) {
  if (!map || typeof map !== 'object') return null;
  const value = Number(map[key]);
  return Number.isFinite(value) ? value : null;
}

/**
 * 解析本次 TTS 的参考音频与语速。
 * 优先级：人格包映射 > config.tts 映射 > 默认参考音频/语速。
 * @returns {{emotion:string, refAudio:string, speed:number|null}}
 */
export function resolveTtsVoice({ text = '', emotion = '', cfg = {}, pack = null, explicitSpeed = null } = {}) {
  const inferred = TTS_EMOTIONS.includes(emotion) ? emotion : inferTtsEmotion(text);
  const packRefs = pack?.voice?.emotionRefs ?? {};
  const packSpeeds = pack?.voice?.emotionSpeed ?? {};
  const cfgRefs = cfg?.emotionRefs ?? {};
  const cfgSpeeds = cfg?.emotionSpeed ?? {};
  const refAudio = packRefs[inferred] || cfgRefs[inferred] || packRefs.neutral || cfgRefs.neutral || '';
  const speed = explicitSpeed ?? pickNumber(packSpeeds, inferred) ?? pickNumber(cfgSpeeds, inferred) ?? null;
  return {
    emotion: inferred,
    refAudio: String(refAudio || ''),
    speed: speed === null ? null : Math.min(1.5, Math.max(0.7, Number(speed) || 1))
  };
}

/** 读取当前角色的人格包（只用于 voice 映射）；任何失败返回 null。 */
export function loadCurrentPersonaPack(root) {
  try {
    const stateFile = path.join(root, 'state', 'current-role.json');
    const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
    const name = String(state?.role ?? '').trim();
    if (!name || name.includes('..') || /[\\/]/.test(name)) return null;
    return loadPersonaPack(path.join(root, 'roles'), name);
  } catch {
    return null;
  }
}
