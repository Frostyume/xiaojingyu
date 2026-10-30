// 自动个性签名：本地生成规则 + 桥接 API（不真改 QQ）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { generateSignature, normalizeSignatureState, appendSignatureHistory, randomSignatureIntervalMs } from '../src/core/signature.js';
import { bridgeHarness } from './audit-bridge-harness.mjs';

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
    await new Promise((resolve) => server.close(resolve));
  } finally { await h.close(); }
});
