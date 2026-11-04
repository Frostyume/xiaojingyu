// 自定义角色下的 TTS 表演指令。
//
// 声线本身仍是系统固定的同一个音色；这里只替换“语气表演”部分，避免把默认角色的
// 软萌/傲娇/撒娇写进自定义角色的语音 prompt。默认角色仍走原有的 softInstruction/softDelivery。

const CUSTOM_BASE = '标准普通话，自然说话。保持同一个音色，不要重新设计声音；语速中等，句尾自然收住。';
export const CUSTOM_VOICE_DELIVERY = '语气跟着这句话的内容走；不要预设固定人设或撒娇腔，不要哭腔、不要拖长音、不要播音腔。';

const CUSTOM_MOOD_TONE = {
  happy: '这句轻快一些。',
  sad: '这句放低、放慢，带一点低落。',
  angry: '这句短促、直接。',
  shy: '这句放轻、略慢。',
  sleepy: '这句轻、慢，带一点困意。',
  proud: '这句可以有一点得意。',
  playful: '这句活泼一点。'
};

export function neutralVoiceInstruction(breeze = {}, mood = '') {
  const base = String(breeze.baseInstruction || '').trim() || CUSTOM_BASE;
  const moodText = mood ? String(CUSTOM_MOOD_TONE[mood] || '').trim() : '';
  return [base, CUSTOM_VOICE_DELIVERY, moodText].filter(Boolean).join(' ');
}
