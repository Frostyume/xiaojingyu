// 自动个性签名：本地生成规则 + 桥接 API（不真改 QQ）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSignature, normalizeSignatureState, appendSignatureHistory, randomSignatureIntervalMs, isSignatureAdjustCommand, isDuplicateSignatureInstruction } from '../runtime/persona/signature.js';
import { atomicWriteJson, readJsonSafe } from '../runtime/kernel/state-file.js';
import { bridgeHarness } from './bridge-harness.mjs';

const signatureSends = (h) => h.calls.http.filter((c) => String(c.url).endsWith('/send_private_msg'));

// ── 红自测共用工具 ──────────────────────────────────────────────────────────
// 只依赖既有导出 + 读源码，保证「换回旧源码」时这些测试仍能运行并真的变红。
const SIG_SOURCE = fileURLToPath(new URL('../runtime/persona/signature.js', import.meta.url));
const sigSource = () => fs.readFileSync(SIG_SOURCE, 'utf8');
const CORRUPT_RE = /\uFFFD/;

// 与模块内 clean() 同口径（本地复刻，不依赖新导出）。
const cleanLocal = (text, maxChars = 40) => {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[。．.]+$/u, '');
  if (s.length > maxChars) s = `${s.slice(0, Math.max(1, maxChars - 1))}…`;
  return s;
};

// 抽取源码里所有含中文的单引号字面量（模板/尾巴/语气词等），作为干净输出空间的超集。
const cjkLiterals = (source) => {
  const out = new Set();
  const re = /'([^'\n]*[\u4e00-\u9fff][^'\n]*)'/g;
  let m;
  while ((m = re.exec(source))) out.add(m[1]);
  return [...out];
};

// 纯模板空间：全部模板字面量 + 兴趣主题组合。强制拼接的尾巴不属于其中，
// 所以「出口硬补尾巴」的旧行为能被识别为越界。
const buildTemplateSpace = (maxChars = 40) => {
  const space = new Set();
  for (const lit of cjkLiterals(sigSource())) {
    space.add(cleanLocal(lit, maxChars));
    space.add(cleanLocal(lit.replace('{topic}', '羽毛球'), maxChars));
  }
  space.delete('');
  return space;
};

// 完整干净空间：纯模板 + 新旧兜底短尾组合（枯竭测试用，覆盖所有合法兜底出口）。
const buildCleanSpace = (maxChars = 40) => {
  const tails = ['，尾巴还在', '，摸鱼中', '，米饭要紧', '，懒得动', '，慢慢来嘛', '，慢慢来就好', '，想到什么再补', '，今天也不急', '，先游一圈再说', '，先缓一缓再说'];
  const space = buildTemplateSpace(maxChars);
  for (const lit of cjkLiterals(sigSource())) {
    for (const tail of tails) space.add(cleanLocal(`${lit}${tail}`, maxChars));
  }
  space.delete('');
  return space;
};

// 编码损坏夹具：GBK 字节被按 UTF-8 有损解码后留下的 U+FFFD（与真实坏条目同形，ASCII 安全）。
const CORRUPT_FIXTURE = '\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\u05be\u00fb\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\u02fc\ufffd\ufffd\ufffd\ufffd\ufffd\ufffd\u04bb\ufffd\ufffd\u04bb\ufffd\ufffd\ufffd';
const CLEAN_FIXTURE = '记忆与持久化比想象中有意思，正在一点一点啃';

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

test('signature: 自定义角色不出现小鲸鱼生活记号', () => {
  for (const energy of [0.1, 0.5, 0.9]) {
    for (const valence of [-0.5, 0, 0.6]) {
      for (let i = 0; i < 12; i += 1) {
        const text = generateSignature({
          persona: { state: { energy, mood: { valence }, interests: [{ topic: '游泳' }] } },
          now: Date.UTC(2026, 9, 26, 14, 0) + i * 3600 * 1000,
          maxChars: 40,
          history: [],
          roleName: '阿岚'
        });
        assert.doesNotMatch(text, /尾巴|鲸鱼|鲸生|米饭|摸鱼|水里|浅水|冒泡|大肥鱼|游/u, `自定义角色签名串味：${text}`);
      }
    }
  }
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

// ── 红自测：必须在旧行为上真的变红（带锚点/空操作守卫）──────────────────────

test('signature red: 强制尾巴兜底已删除，池子枯竭宁可交空也不造垃圾', () => {
  // Part A 静态：ensureVoice 固定尾巴必须从源码彻底删除（开源旧版的病句来源是硬拼尾巴）。
  const src = sigSource();
  assert.ok(src.includes('export function generateSignature'), '锚点：应读到签名生成源码（非空文件）');
  assert.ok(!src.includes('ensureVoice'), '强制补尾巴的 ensureVoice 必须已删除');
  assert.ok(!src.includes('VOICE_TAILS'), '固定尾巴数组 VOICE_TAILS 必须已删除');

  // Part B 行为：正常输出必须是纯模板句（生活记号靠选句偏好），不许硬拼尾巴。
  const templateSpace = buildTemplateSpace(40);
  assert.ok(templateSpace.size > 50, '锚点：模板空间应覆盖全部模板');
  assert.ok(templateSpace.has(cleanLocal('慢慢游，慢慢想，今天也不急着给答案，事情一件一件来就好', 40)), '锚点：已知模板应在空间内');
  const persona = { state: { energy: 0.6, mood: { valence: 0.1 } } };
  const base = Date.UTC(2026, 9, 26, 2, 0);
  // 空操作守卫：历史为空时仍应正常产出干净模板（证明 '' 是枯竭所致，而非模块坏掉）。
  const normal = generateSignature({ persona, now: base, maxChars: 40, history: [], interests: [] });
  assert.ok(normal && templateSpace.has(normal), `正常应产出纯模板句，实际：${normal}`);
  for (let i = 0; i < 24; i += 1) {
    const text = generateSignature({ persona, now: base + i * 3700000, maxChars: 40, history: [], interests: [] });
    assert.ok(text && templateSpace.has(text), `出口不得硬拼尾巴/造病句，实际：${text}`);
  }

  // Part C 行为：把所有干净输出塞进历史/废案制造彻底枯竭，只能交空，绝不重复废案。
  const space = buildCleanSpace(40);
  const avoid = [...space].map((text) => ({ text }));
  for (const roleName of ['', '阿岚']) {
    for (let i = 0; i < 8; i += 1) {
      const text = generateSignature({
        persona, now: base + i * 3700000, maxChars: 40,
        history: avoid, avoidTexts: avoid, interests: [], bannedThemes: [], roleName
      });
      assert.equal(text, '', `池子枯竭时宁可交空也不重复/造垃圾（roleName=${roleName || '默认'}），实际：${text}`);
      assert.ok(!CORRUPT_RE.test(text), '输出不得含编码损坏标记');
    }
  }
});

test('signature red: 中文持久化往返无损，编码损坏历史条目自愈', () => {
  // 守卫：UTF-8 原子写读往返，中文必须无损（持久化层本就 UTF-8，这是回归 guard）。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sig-enc-'));
  try {
    const file = path.join(dir, 'signature.json');
    atomicWriteJson(file, { history: [{ text: CLEAN_FIXTURE, at: 1 }] });
    const back = readJsonSafe(file, {});
    assert.equal(back.history[0].text, CLEAN_FIXTURE, '中文经持久化往返必须无损');
    assert.ok(!CORRUPT_RE.test(back.history[0].text), '往返不得引入 U+FFFD');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }

  // 红：旧 normalizeSignatureState 会保留 U+FFFD 坏条目；新版必须自愈丢弃。
  const healed = normalizeSignatureState({ history: [CLEAN_FIXTURE, CORRUPT_FIXTURE], lastText: CORRUPT_FIXTURE });
  assert.ok(healed.history.every((h) => !CORRUPT_RE.test(h.text)), '历史里的编码损坏条目必须被清除');
  assert.ok(healed.history.some((h) => h.text === CLEAN_FIXTURE), '干净条目必须原样保留');
  assert.equal(healed.history.length, 1, '坏条目丢弃后只剩干净那条');
  assert.equal(healed.lastText, CLEAN_FIXTURE, 'lastText 损坏时回退到最近干净历史');
  // 空操作守卫：纯干净历史不得被误删。
  const intact = normalizeSignatureState({ history: [CLEAN_FIXTURE], lastText: CLEAN_FIXTURE });
  assert.equal(intact.history.length, 1);
  assert.equal(intact.history[0].text, CLEAN_FIXTURE);
  assert.equal(intact.lastText, CLEAN_FIXTURE);
  // 坏 pending 同样自愈（开源状态模型没有 rejected/bannedThemes，对应字段不存在即不校验）。
  const mixed = normalizeSignatureState({ pending: { text: CORRUPT_FIXTURE, expiresAt: 9 } });
  assert.equal(mixed.pending, null, '损坏 pending 应清空');
});

test('signature red: 有 pending 时不在同一 tick 重新生成草稿', async () => {
  const T = Date.now();
  const pendingText = '最近被羽毛球勾住了，明明想偷懒，脑子却一直往那边跑';

  // 场景一：未过期 pending —— 复用同一版，唤醒对齐到剩余有效期（不是固定 30 分钟空转）。
  const live = await bridgeHarness({
    config: { consoleAuth: { enabled: false }, simulation: { signature: { enabled: true, requireApproval: true, approvalTimeoutMs: 7200000 } } },
    files: { 'state/signature.json': { pending: { text: pendingText, createdAt: T, expiresAt: T + 5 * 60 * 1000, messageId: 'm1', messageIds: ['m1'] } } }
  });
  try {
    live.setSnowlumaConnected(true);
    live.setMode('simulation');
    let llmCalls = 0;
    live.setInnerLife({ personaInfo: () => ({ state: { energy: 0.8, mood: { valence: 0.5 }, interests: [] } }), generateSignatureText: async () => { llmCalls += 1; return '不该被调用的一版'; } });
    const before = signatureSends(live).length;
    const result = await live.handleSignatureJob({});
    assert.equal(result.status, 'pending-approval');
    assert.equal(live.signatureState.pending.text, pendingText, '未过期必须复用同一版草稿');
    assert.equal(llmCalls, 0, '等审核时不得调用模型重新生成');
    assert.equal(signatureSends(live).length, before, '等审核时不得再发新草稿');
    assert.ok(result.retryAfterMs > 4 * 60 * 1000 && result.retryAfterMs <= 5 * 60 * 1000, `唤醒应对齐剩余有效期（约 5 分钟），而非固定 30 分钟，实际 ${result.retryAfterMs}`);
  } finally { await live.close(); }

  // 场景二：已过期 pending —— 记录 + 顺延，绝不在同一 tick 再出一版（churn 收敛）。
  const expired = await bridgeHarness({
    config: { consoleAuth: { enabled: false }, simulation: { signature: { enabled: true, requireApproval: true, approvalTimeoutMs: 7200000 } } },
    files: { 'state/signature.json': { pending: { text: pendingText, createdAt: T - 7200000, expiresAt: T - 1000, messageId: 'm1', messageIds: ['m1'] } } }
  });
  try {
    expired.setSnowlumaConnected(true);
    expired.setMode('simulation');
    let llmCalls = 0;
    expired.setInnerLife({ personaInfo: () => ({ state: { energy: 0.8, mood: { valence: 0.5 }, interests: [] } }), generateSignatureText: async () => { llmCalls += 1; return '过期后不该立刻生成的新一版'; } });
    const before = signatureSends(expired).length;
    const result = await expired.handleSignatureJob({});
    assert.equal(result.status, 'expired', '过期只记录+顺延，不在同一 tick 重生成');
    assert.equal(expired.signatureState.pending, null, '过期后清空 pending');
    assert.equal(llmCalls, 0, '过期这一 tick 不得调用模型');
    assert.equal(signatureSends(expired).length, before, '过期这一 tick 不得再私聊发新草稿');
    assert.ok(result.nextAt > T, '过期后应顺延到下一个正常间隔');
    assert.equal(expired.signatureState.nextAt, result.nextAt);
  } finally { await expired.close(); }
});

test('signature red: 自动签名走 LLM 真实状态，失败/关闭退回干净模板', async () => {
  const space = buildCleanSpace(40);
  const llmText = '今天把一段卡住的代码理顺了，心里踏实不少';
  const persona = () => ({ state: { energy: 0.7, mood: { valence: 0.3 }, interests: [] } });

  // 红：开启 LLM 且模型可用时，草稿正文必须是模型按真实状态写的那一句（旧代码只会套模板）。
  const ok = await bridgeHarness({ config: { consoleAuth: { enabled: false }, simulation: { signature: { enabled: true, requireApproval: true, llm: true } } } });
  try {
    ok.setSnowlumaConnected(true);
    ok.setMode('simulation');
    let calls = 0;
    ok.setInnerLife({ personaInfo: persona, generateSignatureText: async () => { calls += 1; return llmText; } });
    const result = await ok.handleSignatureJob({});
    assert.equal(result.status, 'draft');
    assert.equal(calls, 1, '应调用模型按真实状态生成');
    assert.equal(ok.signatureState.pending.text, llmText, '草稿应采用 LLM 产出，而非模板');
  } finally { await ok.close(); }

  // 守卫：模型抛错时退回干净模板（非空、无损坏、属于干净模板空间），绝不产病句。
  const fail = await bridgeHarness({ config: { consoleAuth: { enabled: false }, simulation: { signature: { enabled: true, requireApproval: true, llm: true } } } });
  try {
    fail.setSnowlumaConnected(true);
    fail.setMode('simulation');
    fail.setInnerLife({ personaInfo: persona, generateSignatureText: async () => { throw new Error('模型不可用'); } });
    const result = await fail.handleSignatureJob({});
    assert.equal(result.status, 'draft');
    const text = fail.signatureState.pending.text;
    assert.ok(text && !CORRUPT_RE.test(text), '兜底必须是非空干净文本');
    assert.ok(space.has(text), `兜底必须是干净模板，绝不换字造病句，实际：${text}`);
  } finally { await fail.close(); }

  // 守卫：llm=false 回滚开关 —— 即便模型可用也走模板。
  const off = await bridgeHarness({ config: { consoleAuth: { enabled: false }, simulation: { signature: { enabled: true, requireApproval: true, llm: false } } } });
  try {
    off.setSnowlumaConnected(true);
    off.setMode('simulation');
    let calls = 0;
    off.setInnerLife({ personaInfo: persona, generateSignatureText: async () => { calls += 1; return llmText; } });
    const result = await off.handleSignatureJob({});
    assert.equal(result.status, 'draft');
    assert.equal(calls, 0, 'llm=false 时不得调用模型');
    assert.notEqual(off.signatureState.pending.text, llmText, 'llm=false 应退回模板');
    assert.ok(space.has(off.signatureState.pending.text), '回滚兜底也必须是干净模板');
  } finally { await off.close(); }
});
