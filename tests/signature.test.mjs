// 自动个性签名：本地生成规则 + 桥接 API（不真改 QQ）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSignature, normalizeSignatureState, appendSignatureHistory, randomSignatureIntervalMs, isSignatureAdjustCommand, isDuplicateSignatureInstruction } from '../runtime/persona/signature.js';
import { bridgeHarness } from './bridge-harness.mjs';

async function pendingSignatureHarness() {
  const h = await bridgeHarness({
    config: {
      consoleAuth: { enabled: false },
      simulation: { signature: { enabled: true, requireApproval: true, approvalTimeoutMs: 7200000 } }
    }
  });
  h.setSnowlumaConnected(true);
  h.setMode('simulation');
  const draft = await h.handleSignatureJob({});
  assert.equal(draft.status, 'draft');
  assert.ok(h.signatureState.pending?.text);
  return h;
}

test('signature: 生成有内容的签名、无末尾句号、避开历史、可带兴趣', () => {
  const now = Date.UTC(2026, 9, 26, 14, 0); // 上海 22:00
  const text = generateSignature({
    persona: { state: { energy: 0.8, mood: { valence: 0.5 }, interests: [{ topic: '羽毛球' }] } },
    now,
    maxChars: 30,
    history: []
  });
  assert.ok(text.length > 0 && text.length <= 30);
  assert.ok(text.length >= 22, `签名不应退化回短句，实际 ${text.length} 字`);
  assert.match(text, /尾巴|鲸鱼|米饭|摸鱼|懒|嘴硬|水里|游|饭/, '签名应带小鲸鱼的生活记号');
  assert.ok(!/[。.]$/.test(text), '末尾不留句号');
  const repeated = generateSignature({ now, maxChars: 30, history: [{ text }] });
  assert.notEqual(repeated, text, '应避开最近用过的签名');
  assert.ok(repeated.length >= 22, '换一条后仍应是有内容的句子');
  assert.match(repeated, /尾巴|鲸鱼|米饭|摸鱼|懒|嘴硬|水里|游|饭/);

  const low = generateSignature({ persona: { state: { energy: 0.2, mood: { valence: -0.4 } } }, now, maxChars: 40, history: [] });
  assert.ok(low.length >= 22);
  const morning = generateSignature({ persona: { state: { energy: 0.8, mood: { valence: 0.5 }, interests: [{ topic: '比赛' }] } }, now, maxChars: 40, history: [] });
  assert.ok(morning.length >= 22);
});

test('signature: 历史有界与旧格式兼容', () => {
  let history = [];
  for (let i = 0; i < 30; i += 1) history = appendSignatureHistory(history, `签名${i}`, 1000 + i);
  assert.equal(history.length, 20);
  const state = normalizeSignatureState({ history: ['旧签名', { text: '新签名', at: 123 }], lastText: '旧签名' });
  assert.equal(state.lastText, '旧签名');
  assert.equal(state.history.length, 2);
  assert.equal(state.history[0].text, '旧签名');
  const withPending = normalizeSignatureState({ pending: { text: '待审签名草稿', expiresAt: 456 } });
  assert.equal(withPending.pending.text, '待审签名草稿');
  assert.equal(withPending.pending.expiresAt, 456);
});

test('signature: 12~48 小时随机间隔', () => {
  assert.equal(randomSignatureIntervalMs(12, 48, { random: () => 0 }), 12 * 3600 * 1000);
  assert.equal(randomSignatureIntervalMs(12, 48, { random: () => 1 }), 48 * 3600 * 1000);
  const mid = randomSignatureIntervalMs(12, 48, { random: () => 0.5 });
  assert.equal(mid, 30 * 3600 * 1000);
});

test('signature: 触发判定只认显式命令或引用草稿', () => {
  const pending = { messageId: 'm1', messageIds: ['m0', 'm1'], text: '草稿' };
  assert.deepEqual(isSignatureAdjustCommand('改签名 短一点', pending), { ok: true, instruction: '短一点' });
  assert.deepEqual(isSignatureAdjustCommand('改签名：短一点', pending), { ok: true, instruction: '短一点' });
  assert.deepEqual(isSignatureAdjustCommand('改签名', pending), { ok: true, instruction: '换一版，别和现在这版一样' });
  assert.equal(isSignatureAdjustCommand('改签名吗', pending).ok, false, '提问不是命令');
  assert.equal(isSignatureAdjustCommand('你知识分享过于频繁了，别这么频繁', pending, { replyToId: 'm9' }).ok, false);
  assert.equal(isSignatureAdjustCommand('短一点', pending, { replyToId: 'm0' }).ok, true);
  assert.equal(isSignatureAdjustCommand('短一点', pending, { explicitOnly: true, replyToId: 'm0' }).ok, false);
  assert.equal(isSignatureAdjustCommand('短一点', pending, { qzonePending: true, replyToId: 'm0' }).ok, false);
  assert.equal(isDuplicateSignatureInstruction({ text: '草稿', lastInstruction: '短一点', lastInstructionText: '草稿' }, '短一点'), true);
  assert.equal(isDuplicateSignatureInstruction({ text: '新草稿', lastInstruction: '短一点', lastInstructionText: '草稿' }, '短一点'), false);
});

test('signature: 草稿状态保留消息 id 与去重字段', () => {
  const state = normalizeSignatureState({
    pending: {
      text: '待审签名', messageId: 'm1', messageIds: ['m0', 'm1'],
      lastInstruction: '短一点', lastInstructionText: '旧草稿', lastInstructionAt: 99
    }
  });
  assert.deepEqual(state.pending.messageIds, ['m0', 'm1']);
  assert.equal(state.pending.lastInstruction, '短一点');
  assert.equal(state.pending.lastInstructionText, '旧草稿');
  assert.equal(state.pending.lastInstructionAt, 99);
});

test('signature: 草稿在等审核时，无关消息不触发改写、不回模板', async () => {
  const h = await pendingSignatureHarness();
  try {
    const beforeText = h.signatureState.pending.text;
    const beforeCount = h.calls.http.length;
    const handled = await h.handleSignatureOwnerCommand('你知识分享过于频繁了，别这么频繁', {
      kind: 'private', isOwner: true, explicitOnly: false, replyToId: ''
    });
    assert.equal(handled, false, '无关消息必须放行给正常对话');
    assert.equal(h.signatureState.pending.text, beforeText, '草稿不能被无关消息改写');
    const after = h.calls.http.slice(beforeCount);
    assert.equal(after.filter((c) => String(c.url).endsWith('/send_private_msg')).length, 0, '不应回复模板或草稿');
    assert.equal(h.calls.http.some((c) => JSON.stringify(c.body ?? '').includes('好，我按你说的改一下')), false);
  } finally { await h.close(); }
});

test('signature: 引用签名草稿才微调，结果一条消息交付', async () => {
  const h = await pendingSignatureHarness();
  try {
    const draftId = h.signatureState.pending.messageId;
    assert.ok(draftId, '草稿应记录消息 id');
    const calls = [];
    h.setInnerLife({
      getState: () => ({ pendingDraft: null }),
      refineText: async ({ instruction, current }) => {
        calls.push({ instruction, current });
        return '夜里安静，慢慢游着，不急着说话';
      }
    });
    const handled = await h.handleSignatureOwnerCommand('短一点', {
      kind: 'private', isOwner: true, explicitOnly: false, replyToId: draftId
    });
    assert.equal(handled, true);
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(calls.length, 1);
    assert.equal(calls[0].instruction, '短一点');
    assert.equal(h.signatureState.pending.text, '夜里安静，慢慢游着，不急着说话');
    const sends = h.calls.http.filter((c) => String(c.url).endsWith('/send_private_msg'));
    assert.ok(sends.some((c) => JSON.stringify(c.body).includes('个性签名草稿·已改')));
    assert.equal(sends.some((c) => JSON.stringify(c.body).includes('好，我按你说的改一下')), false, '不能用模板回执');
  } finally { await h.close(); }
});

test('signature: 引用其他消息的抱怨不算改签名', async () => {
  const h = await pendingSignatureHarness();
  try {
    const handled = await h.handleSignatureOwnerCommand('你知识分享过于频繁了', {
      kind: 'private', isOwner: true, explicitOnly: false, replyToId: 'some-other-message'
    });
    assert.equal(handled, false);
  } finally { await h.close(); }
});

test('signature: 连续两条不同修改指令只交付最后一版', async () => {
  const h = await pendingSignatureHarness();
  try {
    const waiting = [];
    h.setInnerLife({
      getState: () => ({ pendingDraft: null }),
      refineText: ({ instruction }) => new Promise((resolve) => waiting.push({ instruction, resolve }))
    });
    await h.handleSignatureOwnerCommand('改签名 再短一点', { kind: 'private', isOwner: true, explicitOnly: true });
    await h.handleSignatureOwnerCommand('改签名 温柔一点', { kind: 'private', isOwner: true, explicitOnly: true });
    assert.equal(waiting.length, 2);
    waiting[1].resolve('温柔一点的版本');
    await new Promise((resolve) => setTimeout(resolve, 20));
    waiting[0].resolve('更短的版本');
    await new Promise((resolve) => setTimeout(resolve, 20));
    const revised = h.calls.http.filter((c) => JSON.stringify(c.body ?? '').includes('个性签名草稿·已改'));
    assert.equal(revised.length, 1, '过时结果不得再交付一版');
    assert.ok(JSON.stringify(revised[0].body).includes('温柔一点的版本'));
    assert.equal(h.signatureState.pending.text, '温柔一点的版本');
  } finally { await h.close(); }
});

test('signature: 同一句修改连发两次只生成一版草稿', async () => {
  const h = await pendingSignatureHarness();
  try {
    let resolveRefine;
    let refineCount = 0;
    h.setInnerLife({
      getState: () => ({ pendingDraft: null }),
      refineText: () => {
        refineCount += 1;
        return new Promise((resolve) => { resolveRefine = resolve; });
      }
    });
    const first = await h.handleSignatureOwnerCommand('改签名 再短一点', { kind: 'private', isOwner: true, explicitOnly: true });
    const second = await h.handleSignatureOwnerCommand('改签名 再短一点', { kind: 'private', isOwner: true, explicitOnly: true });
    assert.equal(first, true);
    assert.equal(second, true);
    assert.equal(refineCount, 1, '重复指令不应再次调用模型');
    resolveRefine('再短一点就这版');
    await new Promise((resolve) => setTimeout(resolve, 30));
    const revised = h.calls.http.filter((c) => JSON.stringify(c.body ?? '').includes('个性签名草稿·已改'));
    assert.equal(revised.length, 1, '只应生成一版草稿');
    assert.equal(h.signatureState.pending.text, '再短一点就这版');
  } finally { await h.close(); }
});

test('signature: 自动签名先私聊主人审核，回「发签名」才写 QQ', async () => {
  const h = await bridgeHarness({
    config: {
      consoleAuth: { enabled: false },
      simulation: { signature: { enabled: true, requireApproval: true, approvalTimeoutMs: 7200000 } }
    }
  });
  try {
    h.setSnowlumaConnected(true);
    h.setMode('simulation');
    const draft = await h.handleSignatureJob({});
    assert.equal(draft.status, 'draft');
    assert.ok(h.signatureState.pending?.text, '应生成待审草稿');
    const sentDraft = h.calls.http.find((c) => String(c.url).endsWith('/send_private_msg')
      && JSON.stringify(c.body).includes('个性签名草稿'));
    assert.ok(sentDraft, '应私聊主人发送签名草稿');
    assert.match(JSON.stringify(sentDraft.body), /发签名/);
    assert.equal(h.calls.http.filter((c) => String(c.url).endsWith('/set_qq_profile')).length, 0, '未审核前不能改 QQ');

    const handled = await h.handleSignatureOwnerCommand('发签名', { kind: 'private', isOwner: true });
    assert.equal(handled, true);
    assert.equal(h.signatureState.pending, null);
    assert.equal(h.signatureState.lastText, draft.pending?.text || h.signatureState.lastText);
    const call = h.calls.http.find((c) => String(c.url).endsWith('/set_qq_profile'));
    assert.ok(call, '主人确认后才调用 set_qq_profile');
    assert.equal(call.body.personal_note, h.signatureState.lastText);
  } finally { await h.close(); }
});

test('signature API: 预览与手动更新（fixture 网关）', async () => {
  const h = await bridgeHarness({
    config: { consoleAuth: { enabled: false }, simulation: { signature: { enabled: true, firstDelayMs: 60000 } } }
  });
  try {
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const base = `http://127.0.0.1:${port}`;
    const get = await fetch(`${base}/api/signature`).then((r) => r.json());
    assert.equal(get.ok, true);
    assert.equal(get.enabled, true);
    assert.ok(get.preview);

    const preview = await fetch(`${base}/api/signature/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).then((r) => r.json());
    assert.ok(preview.text);
    assert.ok(preview.text.length >= 22, `预览也应是有内容的签名，实际 ${preview.text.length} 字`);

    const applied = await fetch(`${base}/api/signature/apply`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: '今天在水里慢慢游' })
    }).then((r) => r.json());
    assert.equal(applied.ok, true);
    const call = h.calls.http.find((c) => String(c.url).endsWith('/set_qq_profile'));
    assert.ok(call, '应调用 set_qq_profile');
    assert.equal(call.body.personal_note, '今天在水里慢慢游');
    assert.equal(call.body.nickname, '小鲸鱼', '应带上当前昵称，避免被清空');

    const after = await fetch(`${base}/api/signature`).then((r) => r.json());
    assert.equal(after.lastText, '今天在水里慢慢游');
    assert.ok(after.history.some((x) => x.text === '今天在水里慢慢游'));
    assert.ok(after.nextAt > after.lastAppliedAt, '应安排下一次更新');
    const interval = after.nextAt - after.lastAppliedAt;
    assert.ok(interval >= 12 * 3600 * 1000 - 60000 && interval <= 48 * 3600 * 1000 + 60000, `下一次间隔应在 12~48h，实际 ${interval}ms`);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  } finally { await h.close(); }
});
