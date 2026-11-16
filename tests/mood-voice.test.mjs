// 心情语音：模板池多句/近期去重/LLM 失败退模板/每次新鲜音频 + 群轮换 + 提示词由头。
// 不触网、不发真实 QQ、不打真实模型：LLM 用假生成器，TTS 的 fetch 全部桩掉。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  MOOD_VOICE_LINES,
  MOOD_VOICE_MAX_CHARS,
  MOOD_VOICE_TAIL_MAX_CHARS,
  cleanMoodVoiceText,
  cleanMoodVoiceTail,
  normalizeMoodVoiceRecent,
  mergeMoodVoiceRecent,
  pickMoodVoiceLine,
  normalizeMoodVoiceGroups,
  pickMoodVoiceGroup,
  moodVoiceTailDue,
  resolveMoodVoiceLine
} from '../services/media/mood-voice-cadence.js';
import { synthesizeFeatureVoice } from '../runtime/orchestration/feature-voice.js';
import { createInnerLife } from '../services/persona/inner-life.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const MOODS = ['happy', 'sleepy', 'pout', 'idle'];
// 裸报心情的典型说法：模板/提示词都不该再产出这类没有来由的句子。
const BARE_STATUS = ['心情挺好', '人倒不闷', '心情不错', '心情好得', '状态在线', '有点困了', '眼皮好沉', '困得不行', '脑子转不动', '有点不开心', '没什么事，就是'];
// 由头：刚做完的事/时间氛围；轻社交：主动朝人开口。每句至少各占一个。
const OPEN_HOOKS = ['刚', '熬', '睡醒', '忙完', '闲下来', '看看你们', '翻完', '冒个泡', '想和你们', '想你们', '唠', '跟你们说', '说两句', '打个招呼', '这会儿'];
const SOCIAL_HOOKS = ['你们', '唠', '冒个泡', '打招呼', '聊聊', '说说', '说说话', '说两句', '吐槽'];

const ttsCfg = () => ({
  tts: { breeze: { enabled: true, opusUrl: 'http://127.0.0.1:9', seed: 12345 }, maxSeconds: 45 }
});

function stubTtsFetch() {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), body: init.body });
    return new Response(Buffer.alloc(128, 7), {
      status: 200,
      headers: { 'x-source-seconds': '1.2' }
    });
  };
  return {
    calls,
    restore() { globalThis.fetch = original; }
  };
}

// 假 DSH 内心会话：捕获真正发给模型的提示词，并回注可控输出。
async function moodVoiceLlmHarness(outputs) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-mood-voice-llm-'));
  const prompts = [];
  let calls = 0;
  let innerRef = null;
  const cfg = {
    ownerQQ: '',
    features: {},
    simulation: { innerLife: { enabled: true }, nightQuiet: { enabled: false } }
  };
  const api = {
    events: { follow: () => {} },
    workspace: { create: async () => ({ result: { ok: true, value: { created: true, workspaceId: 'ws1' } } }) },
    sessions: {
      create: async () => ({ result: { ok: true, value: { sessionId: 'mood-sess' } } }),
      prompt: async ({ content }) => {
        prompts.push(content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
        const text = outputs[Math.min(calls, outputs.length - 1)];
        calls += 1;
        const turn = `t${calls}`;
        innerRef.handleEvent('mood-sess', { type: 'turn/start', data: { turn } });
        innerRef.handleEvent('mood-sess', { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
        innerRef.handleEvent('mood-sess', { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
        return { result: { ok: true } };
      }
    }
  };
  const inner = createInnerLife({
    cfg, api, stateDir,
    log: () => {},
    sendToQQ: async () => true,
    lastSendSucceeded: () => true,
    onebotSend: async () => ({ message_id: 'm1' }),
    mdToPlain: (t) => String(t ?? ''),
    getSimulationState: () => ({ recentMessages: [], unread: [], lastIncomingAt: 0 }),
    isSessionAllowedInCurrentMode: () => true,
    ensureChatModel: async () => 'applied',
    resolvePresetName: () => 'safe-preset',
    unwrap: (r) => r.result.value,
    getRoleText: () => '',
    getRoleName: () => '小鲸鱼',
    isDshReady: () => true,
    getMode: () => 'simulation',
    isPaused: () => false,
    appendActivity: () => {},
    imageLibrary: { sendToKey: async () => true, sendManyToKey: async () => true, add: () => ({ id: 'img1' }), remove: () => {} }
  });
  innerRef = inner;
  return { inner, prompts, cleanup: () => fs.rmSync(stateDir, { recursive: true, force: true }) };
}

test('模板池：每种心情至少 5 句，全部不超长且彼此不同', () => {
  for (const mood of MOODS) {
    const pool = MOOD_VOICE_LINES[mood];
    assert.ok(Array.isArray(pool) && pool.length >= 5, `${mood} 至少要有 5 句`);
    assert.equal(new Set(pool).size, pool.length, `${mood} 模板池内部不得重复`);
    for (const line of pool) {
      assert.ok(line && line.length <= MOOD_VOICE_MAX_CHARS, `${mood} 模板超长：${line}（${line.length}）`);
    }
  }
});

test('模板池：全部是有由头/轻社交的主动搭话，没有裸报心情', () => {
  for (const mood of MOODS) {
    for (const line of MOOD_VOICE_LINES[mood]) {
      for (const bare of BARE_STATUS) {
        assert.ok(!line.includes(bare), `${mood} 模板仍是裸报心情（含「${bare}」）：${line}`);
      }
      assert.ok(OPEN_HOOKS.some((hook) => line.includes(hook)), `${mood} 模板没有由头：${line}`);
      assert.ok(SOCIAL_HOOKS.some((hook) => line.includes(hook)), `${mood} 模板没有主动朝人开口：${line}`);
    }
  }
});

test('心情语音 LLM：提示词要求先挂真实由头，带反例→正例与轻社交兜底', async () => {
  const good = '熬夜欠的，脑子还没醒，来跟你们说两句';
  const h = await moodVoiceLlmHarness([good]);
  try {
    const text = await h.inner.generateMoodVoiceText({
      moodLabel: 'sleepy', valence: -0.1, energy: 0.3, cause: '熬夜', maxChars: MOOD_VOICE_MAX_CHARS
    });
    assert.equal(text, good);
    assert.equal(h.prompts.length, 1);
    const prompt = h.prompts[0];
    assert.match(prompt, /由头/, '必须要求开口前先挂由头');
    assert.match(prompt, /反例/);
    assert.match(prompt, /正例/);
    assert.match(prompt, /轻社交/, '挑不出由头时要有轻社交兜底');
    assert.match(prompt, /当前状态/, '应指向已注入的真实近况找由头');
    assert.match(prompt, /最近群聊|最近群里在聊/, '应允许从群聊近况挑由头');
    assert.match(prompt, /熬夜欠的，脑子还没醒，来跟你们说两句/, '正例要具体可学');
    assert.match(prompt, /裸报心情|干巴巴/, '必须明令禁止没有来由的裸报心情');
  } finally { h.cleanup(); }
});

test('挑句：避开近期用过；全部用过时也绝不连续重复同一句', () => {
  const pool = MOOD_VOICE_LINES.happy;
  const recent = pool.slice(0, pool.length - 1).map((text, index) => ({ text, at: index + 1 }));
  for (let i = 0; i < 50; i += 1) {
    assert.equal(pickMoodVoiceLine({ mood: 'happy', recent }), pool[pool.length - 1], '只剩一句没用过时必须挑它');
  }
  let rolling = pool.map((text, index) => ({ text, at: index + 1 }));
  let last = rolling[rolling.length - 1].text;
  for (let i = 0; i < 200; i += 1) {
    const next = pickMoodVoiceLine({ mood: 'happy', recent: rolling });
    assert.notEqual(next, last, '连续两条心情语音不得相同');
    rolling = mergeMoodVoiceRecent(rolling, next, Date.now(), 20);
    last = next;
  }
});

test('近期文本：落盘结构最多保留 20 条，兼容旧版字符串数组', () => {
  let recent = [];
  for (let i = 0; i < 25; i += 1) recent = mergeMoodVoiceRecent(recent, `第${i}条`, i, 20);
  assert.equal(recent.length, 20);
  assert.equal(recent[0].text, '第5条');
  assert.equal(recent[19].text, '第24条');
  assert.deepEqual(normalizeMoodVoiceRecent(['旧句子一', '旧句子二']).map((item) => item.text), ['旧句子一', '旧句子二']);
});

test('清洗：去引号/标签并拒绝空与超长（不截断造病句）', () => {
  assert.equal(cleanMoodVoiceText('“今天有点困”'), '今天有点困');
  assert.equal(cleanMoodVoiceText('语音：想去水里游一圈。'), '想去水里游一圈。');
  assert.equal(cleanMoodVoiceText(''), '');
  assert.equal(cleanMoodVoiceText('一'.repeat(MOOD_VOICE_MAX_CHARS + 1)), '');
  assert.equal(cleanMoodVoiceTail('「接着说一句」'), '接着说一句');
  assert.equal(cleanMoodVoiceTail('一'.repeat(MOOD_VOICE_TAIL_MAX_CHARS + 1)), '');
});

test('群轮换：私聊键一律忽略，按游标轮完一圈折回', () => {
  assert.deepEqual(normalizeMoodVoiceGroups(['group:1', 'private:2', 'group:1', '3']), ['group:1', 'group:3']);
  const groups = ['group:11', 'group:22'];
  const first = pickMoodVoiceGroup({ groups, cursor: 0 });
  assert.deepEqual(first, { key: 'group:11', index: 0, nextCursor: 1 });
  const second = pickMoodVoiceGroup({ groups, cursor: first.nextCursor });
  assert.deepEqual(second, { key: 'group:22', index: 1, nextCursor: 0 });
  assert.equal(pickMoodVoiceGroup({ groups: ['private:9'], cursor: 0 }), null);
  assert.equal(pickMoodVoiceGroup({ groups: [], cursor: 3 }), null);
});

test('续句概率：0=不补、1=必补、越界收敛', () => {
  assert.equal(moodVoiceTailDue({ tailChance: 0 }), false);
  assert.equal(moodVoiceTailDue({ tailChance: 1 }), true);
  assert.equal(moodVoiceTailDue({ tailChance: 0.6, rng: () => 0.59 }), true);
  assert.equal(moodVoiceTailDue({ tailChance: 0.6, rng: () => 0.61 }), false);
});

test('LLM 关闭（回滚开关）：只走模板，不调用生成器', async () => {
  let called = 0;
  const result = await resolveMoodVoiceLine({
    mood: 'happy',
    llmEnabled: false,
    generate: async () => { called += 1; return '假的'; }
  });
  assert.equal(called, 0);
  assert.equal(result.source, 'template');
  assert.ok(MOOD_VOICE_LINES.happy.includes(result.text));
});

test('LLM 抛错：退回模板，不把异常抛给调用方', async () => {
  const result = await resolveMoodVoiceLine({
    mood: 'sleepy',
    generate: async () => { throw new Error('fixture-llm-down'); }
  });
  assert.equal(result.source, 'template');
  assert.ok(MOOD_VOICE_LINES.sleepy.includes(result.text));
});

test('LLM 与近期重复：带 hint 重试一次后采用新句', async () => {
  const duplicate = MOOD_VOICE_LINES.happy[0];
  const seen = [];
  const result = await resolveMoodVoiceLine({
    mood: 'happy',
    recent: [{ text: duplicate, at: 1 }],
    maxChars: MOOD_VOICE_MAX_CHARS,
    generate: async (args) => {
      seen.push(args);
      return seen.length === 1 ? duplicate : '水凉凉的今天也还行';
    }
  });
  assert.equal(result.source, 'llm');
  assert.equal(result.text, '水凉凉的今天也还行');
  assert.equal(seen.length, 2, '重复一次后带 hint 重试一次');
  assert.ok(seen[1].hint, '重试必须带 hint');
  assert.deepEqual(seen[0].avoidTexts, [duplicate], '近期文本要交给模型避重');
});

test('LLM 超长：判不合格并重试一次', async () => {
  let called = 0;
  const result = await resolveMoodVoiceLine({
    mood: 'pout',
    generate: async () => {
      called += 1;
      return called === 1 ? '一'.repeat(MOOD_VOICE_MAX_CHARS + 5) : '算了不气了';
    }
  });
  assert.equal(called, 2);
  assert.equal(result.source, 'llm');
  assert.equal(result.text, '算了不气了');
});

test('LLM 两次都不合格：退回模板', async () => {
  let called = 0;
  const result = await resolveMoodVoiceLine({
    mood: 'idle',
    generate: async () => { called += 1; return ''; }
  });
  assert.equal(called, 2, '最多重试两次');
  assert.equal(result.source, 'template');
  assert.ok(MOOD_VOICE_LINES.idle.includes(result.text));
});

test('新鲜音频：fresh=true 且不同 seed → 不同文件，且不吃旧缓存', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-voice-'));
  const stub = stubTtsFetch();
  try {
    const cfg = ttsCfg();
    const base = await synthesizeFeatureVoice({ text: '今天心情不错', mood: 'happy', cfg, outDir: dir });
    assert.equal(base.cached, false);
    const sameTextDefaultSeed = await synthesizeFeatureVoice({ text: '今天心情不错', mood: 'happy', cfg, outDir: dir, fresh: true });
    assert.equal(sameTextDefaultSeed.cached, false, 'fresh=true 不得返回旧缓存');
    assert.notEqual(sameTextDefaultSeed.path, base.path);
    const a = await synthesizeFeatureVoice({ text: '今天心情不错', mood: 'happy', cfg, outDir: dir, fresh: true, seed: 111 });
    const b = await synthesizeFeatureVoice({ text: '今天心情不错', mood: 'happy', cfg, outDir: dir, fresh: true, seed: 222 });
    const aAgain = await synthesizeFeatureVoice({ text: '今天心情不错', mood: 'happy', cfg, outDir: dir, fresh: true, seed: 111 });
    assert.notEqual(a.path, b.path, '不同 seed 必须生成不同文件');
    assert.notEqual(aAgain.path, a.path, '同一 seed + fresh 也要每次新文件');
    assert.equal(a.cached, false);
    assert.equal(b.cached, false);
    assert.equal(stub.calls.at(-1).body.get('seed'), '111', '随机 seed 必须真正发给 TTS');
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('向后兼容：不传 seed/fresh 仍命中 6 小时缓存，seed 仍是配置值', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mood-voice-'));
  const stub = stubTtsFetch();
  try {
    const cfg = ttsCfg();
    const first = await synthesizeFeatureVoice({ text: '签名用的稳定句子', mood: 'idle', cfg, outDir: dir });
    const second = await synthesizeFeatureVoice({ text: '签名用的稳定句子', mood: 'idle', cfg, outDir: dir });
    assert.equal(second.cached, true);
    assert.equal(second.path, first.path);
    assert.equal(stub.calls[0].body.get('seed'), '12345');
    const seeded = await synthesizeFeatureVoice({ text: '签名用的稳定句子', mood: 'idle', cfg, outDir: dir, seed: 333 });
    assert.notEqual(seeded.path, first.path, '显式 seed 单独成缓存');
    const seededAgain = await synthesizeFeatureVoice({ text: '签名用的稳定句子', mood: 'idle', cfg, outDir: dir, seed: 333 });
    assert.equal(seededAgain.cached, true, '同一显式 seed 仍可命中缓存');
  } finally {
    stub.restore();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('接线锁：群轮换/私聊不发/入上下文/续句/真实状态现写', () => {
  const bridge = fs.readFileSync(path.join(ROOT, 'app', 'whale.js'), 'utf8');
  assert.ok(bridge.includes('pickMoodVoiceGroup'), '应走群轮换');
  assert.ok(bridge.includes('moodVoiceTargetGroups'), '目标只从白名单群过滤');
  assert.ok(!bridge.includes('const targets = (Array.isArray(mv.targets)'), '心情语音不应回退到私聊目标池');
  assert.ok(bridge.includes('recordVoiceSent(key, sent'), '语音文本应写进会话上下文');
  assert.ok(bridge.includes('moodVoiceTailDue'), '应支持续句概率');
  assert.ok(bridge.includes('generateMoodVoiceText'), '应支持按真实状态现写');
  assert.ok(bridge.includes('fresh: true'), '每次应新鲜合成，不吃同一缓存');
  assert.ok(bridge.includes('tailChance'), '续句概率应可配置');
});