// 签名具体化红自测：生活记号/开头词去重、超长整句作废、LLM 提示词正反例。
// 不触网、不发真实 QQ、不打真实模型：LLM 用假 DSH 会话注入可控输出。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  isSignatureTextAllowed, sanitizeSignatureText, signatureMarks,
  signatureOpener, signatureRecentCues
} from '../runtime/persona/signature.js';
import { createInnerLife } from '../services/persona/inner-life.js';
import { bridgeHarness } from './bridge-harness.mjs';

async function signatureLlmHarness(outputs) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sig-llm-'));
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
      create: async () => ({ result: { ok: true, value: { sessionId: 'sig-sess' } } }),
      prompt: async ({ content }) => {
        prompts.push(content.filter((c) => c.type === 'text').map((c) => c.text).join('\n'));
        const text = outputs[Math.min(calls, outputs.length - 1)];
        calls += 1;
        const turn = `t${calls}`;
        innerRef.handleEvent('sig-sess', { type: 'turn/start', data: { turn } });
        innerRef.handleEvent('sig-sess', { type: 'assistant/message', data: { turn, message: { content: [{ type: 'text', text }] } } });
        innerRef.handleEvent('sig-sess', { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
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

test('signature: 最近高频生活记号与开头词会判候选不合格（自定义角色不套鲸鱼规则）', () => {
  const history = [
    { text: '在浅水区缩着，尾巴都懒得摇，先缓一缓' },
    { text: '今天话不多，尾巴还在晃，说明也没那么糟' }
  ];
  assert.ok(signatureMarks(history[0].text).includes('尾巴'), '锚点：记号识别按词表命中尾巴');
  assert.equal(signatureRecentCues({ history }).blockedMarks.includes('尾巴'), true, '连续两条都有尾巴，应进入硬性避开名单');
  const reuseMark = '刚游完两圈，尾巴还翘着，心情不错';
  assert.equal(isSignatureTextAllowed(reuseMark, { maxChars: 40, history }), false, '复用最近高频记号（尾巴）的候选应被拒');
  const fresh = '下午把书架最上层擦了一遍，翻出一张旧车票';
  assert.equal(isSignatureTextAllowed(fresh, { maxChars: 40, history }), true, '换掉记号的具体句应通过');
  assert.equal(isSignatureTextAllowed(reuseMark, { maxChars: 40, history, roleName: '阿岚' }), true, '自定义角色不套鲸鱼记号规则');

  assert.equal(signatureOpener(history[1].text), '今天', '锚点：开头词取归一化前两字');
  assert.equal(isSignatureTextAllowed('今天把杯子洗了三遍，总觉得没洗干净', { maxChars: 40, history }), false, '与最近开头相同应被拒');
  assert.equal(isSignatureTextAllowed('晚上把杯子洗了三遍，总觉得没洗干净', { maxChars: 40, history: [history[1]] }), true, '换一种开头应通过');
});

test('signature: 超长候选整句作废，不再截断加省略号', () => {
  const long = '把'.repeat(41);
  assert.equal(isSignatureTextAllowed(long, { maxChars: 40, history: [] }), false, '超长候选应判不合格');
  assert.ok(!sanitizeSignatureText(long).endsWith('…'), '清洗不得自己造省略号');
  assert.equal(isSignatureTextAllowed(`${'把'.repeat(40)}…`, { maxChars: 40, history: [] }), false, '带省略号的 41 字同样作废');
});

test('signature LLM: 超长产出不再截断返回，而是整句作废交给上层重试', async () => {
  const h = await signatureLlmHarness(['把'.repeat(48)]);
  try {
    await assert.rejects(
      () => h.inner.generateSignatureText({ maxChars: 40 }),
      /签名生成不合格/,
      '超长输出必须整句作废，不能截断成断气句'
    );
    assert.equal(h.prompts.length, 1);
  } finally { h.cleanup(); }
});

test('signature LLM: 提示词写具体、带正反例，并避开最近的生活记号与开头词', async () => {
  const good = '刚把昨天没看完那篇翻完了，结局比想的干脆';
  const h = await signatureLlmHarness([good]);
  try {
    const text = await h.inner.generateSignatureText({ maxChars: 40, avoidMarks: ['尾巴', '米饭'], avoidOpeners: ['今天', '这个'] });
    assert.equal(text, good);
    const prompt = h.prompts[0];
    assert.match(prompt, /具体/, '必须要求写具体');
    assert.match(prompt, /反例/);
    assert.match(prompt, /正例/);
    assert.match(prompt, /尾巴、米饭/, '最近用过的记号要传给模型要求避开');
    assert.match(prompt, /今天、这个/, '最近的开头词要传给模型要求避开');
    assert.match(prompt, /慢慢来/, '空洞填词要作为指令列给模型');
  } finally { h.cleanup(); }
});

test('signature: 超长产出带「压短」提示重试一次后采用第二版，不截断', async () => {
  const long = '把'.repeat(60);
  const good = '刚把昨天没看完那篇翻完了，结局比想的干脆';
  const h = await bridgeHarness({
    config: { consoleAuth: { enabled: false }, simulation: { signature: { enabled: true, requireApproval: true, llm: true } } }
  });
  try {
    h.setSnowlumaConnected(true);
    h.setMode('simulation');
    const hints = [];
    h.setInnerLife({
      personaInfo: () => ({ state: { energy: 0.7, mood: { valence: 0.3 }, interests: [] } }),
      generateSignatureText: async (args) => {
        hints.push(String(args.hint || ''));
        return hints.length === 1 ? long : good;
      }
    });
    const result = await h.handleSignatureJob({});
    assert.equal(result.status, 'draft');
    assert.equal(hints.length, 2, '超长应先重试一次');
    assert.match(hints[1], /超过|压到/, '重试提示应要求写短');
    assert.equal(h.signatureState.pending.text, good, '重试合格后应采用第二版');
    assert.ok(!h.signatureState.pending.text.includes('…'), '草稿不得含截断省略号');
  } finally { await h.close(); }
});

test('接线锁：草稿生成传 cues 并拒绝超长，不再截断', () => {
  const bridge = fs.readFileSync(new URL('../app/whale.js', import.meta.url), 'utf8');
  assert.ok(bridge.includes('signatureRecentCues({ history })'), '应把最近记号/开头交给模型');
  assert.ok(bridge.includes('avoidMarks'), '提示词应带避免记号');
  assert.ok(bridge.includes('avoidOpeners'), '提示词应带避免开头');
  assert.ok(bridge.includes('value.length <= maxChars'), '超长应整句作废');
  assert.ok(bridge.includes('压到 ${maxChars} 字以内'), '超长应带压短提示重试');
});