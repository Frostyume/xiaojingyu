// 主人拉黑指令·自然语言化：安全不变量 + 名字→QQ 解析 + 回滚开关 + 旧码反证。
//
// 全部离线：桥接跑在临时 ROOT 的 VM 里，QQ 网关是假发送（calls.sent），LLM 是确定性 mock。
// 绝不向真实群/私聊发消息，绝不触网。夹具一律用假 QQ 号（30001/30002…）与假名字。
//
// 反证（Part 4）内嵌「改动前」的旧处理器逐字源码：先证明旧码确实做不到主人群裡自然语言
// 拉黑/按名字拉黑（旧码变红），再用 anchor 守卫证明旧夹具本身能跑（私聊+QQ号仍拉黑），
// 避免「空操作夹具假装变红」。同一批场景在新处理器上必须变绿。
// 开源仓 base 完全没有拉黑功能：Part 5 另做源码级反证（无此 feature 时接线断言必红）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  createBlacklist, parseBlacklistCommand, BLACKLIST_DEFAULTS,
  looksLikeBlacklistTalk, parseBlacklistIntentOutput, resolveBlacklistTarget
} from '../runtime/control/blacklist.js';
import { bridgeHarness } from './bridge-harness.mjs';

const OWNER_QQ = '123';
const SELF_QQ = '999';
const GROUP = 'group:456';
const PRIVATE = `private:${OWNER_QQ}`;

// ── Part 1：纯函数 ──────────────────────────────────────────────────────────

test('触发闸：像拉黑/解封/名单的话才命中，普通聊天不命中', () => {
  for (const text of ['别理洛洛', '以后不想理他了', '拉黑这个人', '别再理阿澄', '屏蔽他', '可以理洛洛了', '解封他', '把他放出来', '黑名单', '看看拉黑名单', '把他拉进小黑屋']) {
    assert.equal(looksLikeBlacklistTalk(text), true, `应命中：${text}`);
  }
  assert.equal(looksLikeBlacklistTalk('别理洛洛', { hasAt: true }), true);
  assert.equal(looksLikeBlacklistTalk('@洛洛 以后别这样', { hasAt: true }), true, '@+指令词命中');
  for (const text of ['今天天气不错', '哈哈哈哈', '我去吃饭了', '理解你的意思', '处理一下这个问题']) {
    assert.equal(looksLikeBlacklistTalk(text), false, `不应命中：${text}`);
  }
  assert.equal(looksLikeBlacklistTalk(''), false);
  assert.equal(looksLikeBlacklistTalk('   '), false);
});

test('意图解析：合法 JSON / 带围栏 / 垃圾输入一律归一，不确定→none', () => {
  assert.deepEqual(parseBlacklistIntentOutput('{"action":"block","targetRef":"洛洛","reason":"骂人"}'), { action: 'block', targetRef: '洛洛', reason: '骂人' });
  assert.deepEqual(parseBlacklistIntentOutput('```json\n{"action":"unblock","targetRef":"30001"}\n```'), { action: 'unblock', targetRef: '30001', reason: '' });
  assert.deepEqual(parseBlacklistIntentOutput('前言 {"action":"list","targetRef":"","reason":""} 后语'), { action: 'list', targetRef: '', reason: '' });
  for (const bad of ['', '随便说点什么', '{}', '{"action":"delete"}', '{"action":"block"', '[]', 'null', '{"action":null}']) {
    assert.deepEqual(parseBlacklistIntentOutput(bad), { action: 'none', targetRef: '', reason: '' }, `应归 none：${bad}`);
  }
  // 超长字段被裁剪，不会把整段提示词塞进 reason
  const long = parseBlacklistIntentOutput(JSON.stringify({ action: 'block', targetRef: 'x'.repeat(200), reason: 'y'.repeat(300) }));
  assert.ok(long.targetRef.length <= 80 && long.reason.length <= 120);
});

test('名字→QQ：@ 优先、唯一名字命中、数字 QQ 须有出处', () => {
  const speakers = [{ name: '洛洛', qq: '30001' }, { name: '阿澄', qq: '30002' }];
  // 唯一名字
  assert.deepEqual(resolveBlacklistTarget({ targetRef: '洛洛', speakers }), { ok: true, qq: '30001', name: '洛洛', via: 'name' });
  // 大小写/空白归一
  assert.equal(resolveBlacklistTarget({ targetRef: ' 洛洛 ', speakers }).qq, '30001');
  // @ 优先于名字：ref 是代词且只有一个 @
  const at = [{ qq: '30002', name: '阿澄' }];
  assert.deepEqual(resolveBlacklistTarget({ targetRef: '他', ats: at, speakers }), { ok: true, qq: '30002', name: '阿澄', via: 'at' });
  // 数字 QQ 出现在原话里 → 命中
  assert.equal(resolveBlacklistTarget({ targetRef: '30001', rawText: '拉黑 30001', speakers }).qq, '30001');
  // 数字 QQ 在上下文发言人里 → 命中（即使原话没写号码）
  assert.equal(resolveBlacklistTarget({ targetRef: '30002', rawText: '别理阿澄', speakers }).qq, '30002');
});

test('名字→QQ：歧义/找不到/编造 QQ 一律不猜拉', () => {
  const ambiguous = [{ name: '洛洛', qq: '30001' }, { name: '洛洛', qq: '30009' }];
  const r = resolveBlacklistTarget({ targetRef: '洛洛', speakers: ambiguous });
  assert.equal(r.ok, false);
  assert.equal(r.error, 'ambiguous');
  assert.deepEqual(r.candidates.map((c) => c.qq).sort(), ['30001', '30009']);
  // 找不到
  assert.equal(resolveBlacklistTarget({ targetRef: '不存在', speakers: [{ name: '洛洛', qq: '30001' }] }).error, 'not-found');
  // LLM 编造的 QQ：原话和上下文都没有 → not-found（反幻觉闸）
  assert.equal(resolveBlacklistTarget({ targetRef: '88888', rawText: '别理洛洛', speakers: [{ name: '洛洛', qq: '30001' }] }).error, 'not-found');
  // 多个 @ + 代词 → 歧义
  const multiAt = [{ qq: '30001', name: '洛洛' }, { qq: '30002', name: '阿澄' }];
  assert.equal(resolveBlacklistTarget({ targetRef: '他', ats: multiAt }).error, 'ambiguous');
  // 代词但没有任何 @ → not-found
  assert.equal(resolveBlacklistTarget({ targetRef: '他', speakers: [{ name: '洛洛', qq: '30001' }] }).error, 'not-found');
});

test('名字→QQ：永不解析出主人或她自己', () => {
  // 用合规 5–12 位假 QQ：解析器候选池按 QQ_RE 过滤，短号不入池（生产 ownerQQ 是真实长号）。
  const owner = '10001';
  const self = '10000';
  const speakers = [{ name: '洛洛', qq: '30001' }];
  for (const ref of ['我', '我自己', '主人', '老板']) {
    assert.equal(resolveBlacklistTarget({ targetRef: ref, speakers, ownerQQ: owner }).error, 'protected-owner', `ref=${ref}`);
  }
  for (const ref of ['你', '你自己', '您']) {
    assert.equal(resolveBlacklistTarget({ targetRef: ref, speakers, selfQQ: self }).error, 'protected-self', `ref=${ref}`);
  }
  assert.equal(resolveBlacklistTarget({ targetRef: '小鲸鱼', speakers, selfQQ: self, selfNames: ['小鲸鱼'] }).error, 'protected-self');
  // 即使按名字/号码解析到主人 QQ，也拦下
  assert.equal(resolveBlacklistTarget({ targetRef: '主人昵称', speakers: [{ name: '主人昵称', qq: owner }], ownerQQ: owner }).error, 'protected-owner');
  assert.equal(resolveBlacklistTarget({ targetRef: owner, rawText: `拉黑 ${owner}`, ownerQQ: owner }).error, 'protected-owner');
  assert.equal(resolveBlacklistTarget({ targetRef: self, rawText: `拉黑 ${self}`, selfQQ: self }).error, 'protected-self');
});

// ── Part 2/3：桥接集成（mock LLM + mock 发言人 + 假发送）─────────────────────

async function makeHarness({ nl = true, speakers = [], key = GROUP } = {}) {
  const h = await bridgeHarness({
    config: { simulation: { safety: { blacklist: { enabled: true, naturalLanguage: { enabled: nl } } } } }
  });
  h.setSnowlumaConnected(true);
  const llm = { calls: [], result: { action: 'none', targetRef: '', reason: '' }, error: null };
  h.setInnerLife({
    extractBlacklistIntent: async (args) => { llm.calls.push(args); if (llm.error) throw llm.error; return llm.result; },
    handleOwnerCommand: async () => false
  });
  const st = h.getSimulationState(key);
  for (const s of speakers) st.recentMessages.push({ sender: s.name, userId: s.qq, text: 'hi', isSelf: false });
  const sent = () => h.calls.sent.slice();
  const ownerEvent = (text, extra = []) => ({
    self_id: Number(SELF_QQ), user_id: Number(OWNER_QQ), message_id: Math.floor(Math.random() * 1e6),
    message: [...extra, { type: 'text', data: { text } }], raw_message: text, sender: { nickname: 'owner', card: 'owner' }
  });
  return { h, llm, sent, ownerEvent };
}

const lastText = (sent) => (sent.length ? sent[sent.length - 1].text : '');

test('集成：主人群裡「别理洛洛」（唯一发言人）→ 拉黑对应 QQ + 回显名字QQ', async () => {
  const { h, llm, sent, ownerEvent } = await makeHarness({ speakers: [{ name: '洛洛', qq: '30001' }] });
  try {
    llm.result = { action: 'block', targetRef: '洛洛', reason: '一直骂人' };
    const ok = await h.handleBlacklistOwnerCommand('别理洛洛', { kind: 'group', isOwner: true, key: GROUP, event: ownerEvent('别理洛洛') });
    assert.equal(ok, true);
    assert.equal(h.blacklistStore.isBlocked('30001'), true);
    assert.equal(h.blacklistStore.get('30001').origin, 'owner');
    assert.equal(llm.calls.length, 1, '应调用一次 LLM 意图抽取');
    const reply = sent().find((m) => m.kind === 'group' && String(m.id) === '456');
    assert.ok(reply, '群里应有确认');
    assert.match(reply.text, /洛洛/, '回显名字');
    assert.match(reply.text, /30001/, '回显 QQ');
  } finally { await h.close(); }
});

test('集成：主人私聊「别理洛洛」→ 同样拉黑 + 回显', async () => {
  const { h, llm, sent, ownerEvent } = await makeHarness({ key: PRIVATE, speakers: [{ name: '洛洛', qq: '30001' }] });
  try {
    llm.result = { action: 'block', targetRef: '洛洛', reason: '' };
    const ok = await h.handleBlacklistOwnerCommand('以后不想理洛洛了', { kind: 'private', isOwner: true, key: PRIVATE, event: ownerEvent('以后不想理洛洛了') });
    assert.equal(ok, true);
    assert.equal(h.blacklistStore.isBlocked('30001'), true);
    assert.match(lastText(sent()), /洛洛（30001）/);
  } finally { await h.close(); }
});

test('集成：非主人在群/私聊说「别理洛洛」→ 绝不拉黑、不调 LLM', async () => {
  for (const kind of ['group', 'private']) {
    const key = kind === 'group' ? GROUP : PRIVATE;
    const { h, llm, sent } = await makeHarness({ key, speakers: [{ name: '洛洛', qq: '30001' }] });
    try {
      llm.result = { action: 'block', targetRef: '洛洛', reason: '' };
      const strangerEvent = { self_id: 999, user_id: 4444, message: [{ type: 'text', data: { text: '别理洛洛' } }], raw_message: '别理洛洛', sender: { nickname: '路人' } };
      const ok = await h.handleBlacklistOwnerCommand('别理洛洛', { kind, isOwner: false, key, event: strangerEvent });
      assert.equal(ok, false, `${kind}：非主人指令不生效`);
      assert.equal(h.blacklistStore.isBlocked('30001'), false, `${kind}：黑名单未变`);
      assert.equal(llm.calls.length, 0, `${kind}：不该为非主人调 LLM`);
      assert.equal(sent().length, 0, `${kind}：不该有拉黑回执`);
    } finally { await h.close(); }
  }
});

test('集成：@某人 +「别理他」→ 用 @ 的 QQ', async () => {
  const { h, llm, sent, ownerEvent } = await makeHarness({ speakers: [{ name: '洛洛', qq: '30001' }, { name: '阿澄', qq: '30002' }] });
  try {
    llm.result = { action: 'block', targetRef: '他', reason: '' };
    const at = { type: 'at', data: { qq: '30002' } };
    const ok = await h.handleBlacklistOwnerCommand('别理他', { kind: 'group', isOwner: true, key: GROUP, event: ownerEvent('别理他', [at]) });
    assert.equal(ok, true);
    assert.equal(h.blacklistStore.isBlocked('30002'), true, '拉黑 @ 的人');
    assert.equal(h.blacklistStore.isBlocked('30001'), false, '不误伤另一个发言人');
    assert.match(lastText(sent()), /30002/);
  } finally { await h.close(); }
});

test('集成：「可以理洛洛了」→ 解封 + 确认', async () => {
  const { h, llm, sent, ownerEvent } = await makeHarness({ speakers: [{ name: '洛洛', qq: '30001' }] });
  try {
    h.blacklistStore.add({ qq: '30001', name: '洛洛', origin: 'owner' });
    llm.result = { action: 'unblock', targetRef: '洛洛', reason: '' };
    const ok = await h.handleBlacklistOwnerCommand('可以理洛洛了', { kind: 'group', isOwner: true, key: GROUP, event: ownerEvent('可以理洛洛了') });
    assert.equal(ok, true);
    assert.equal(h.blacklistStore.isBlocked('30001'), false);
    assert.match(lastText(sent()), /已解封/);
    assert.match(lastText(sent()), /30001/);
  } finally { await h.close(); }
});

test('集成：完整名单只私聊发；群里问名单不公开整份', async () => {
  const { h, llm, sent, ownerEvent } = await makeHarness({ speakers: [] });
  try {
    h.blacklistStore.add({ qq: '30001', name: '洛洛', reason: '骂人', origin: 'owner' });
    h.blacklistStore.add({ qq: '30002', name: '阿澄', reason: '刷屏', origin: 'auto' });
    llm.result = { action: 'list', targetRef: '', reason: '' };
    const ok = await h.handleBlacklistOwnerCommand('黑名单', { kind: 'group', isOwner: true, key: GROUP, event: ownerEvent('黑名单') });
    assert.equal(ok, true);
    const groupMsgs = sent().filter((m) => m.kind === 'group');
    const privateMsgs = sent().filter((m) => m.kind === 'private');
    // 群里只有一句简短提示，不含任何 QQ/名字
    assert.ok(groupMsgs.every((m) => !/30001|30002|洛洛|阿澄/.test(m.text)), '群里不得公开名单内容');
    // 完整名单走主人私聊
    const full = privateMsgs.find((m) => /30001/.test(m.text) && /30002/.test(m.text));
    assert.ok(full, '完整名单应私聊发给主人');
  } finally { await h.close(); }
});

test('集成：私聊查名单 → 完整名单私聊发', async () => {
  const { h, sent, ownerEvent } = await makeHarness({ key: PRIVATE, speakers: [] });
  try {
    h.blacklistStore.add({ qq: '30001', name: '洛洛', origin: 'owner' });
    const ok = await h.handleBlacklistOwnerCommand('黑名单', { kind: 'private', isOwner: true, key: PRIVATE, event: ownerEvent('黑名单') });
    assert.equal(ok, true);
    assert.match(lastText(sent()), /30001/);
    assert.ok(sent().every((m) => m.kind === 'private'));
  } finally { await h.close(); }
});

test('集成：LLM 返回 none / 抛错 → 不动作（fail-safe）', async () => {
  const { h, llm, sent, ownerEvent } = await makeHarness({ speakers: [{ name: '洛洛', qq: '30001' }] });
  try {
    llm.result = { action: 'none', targetRef: '', reason: '' };
    assert.equal(await h.handleBlacklistOwnerCommand('他拉黑了我真无语', { kind: 'group', isOwner: true, key: GROUP, event: ownerEvent('他拉黑了我真无语') }), false);
    assert.equal(h.blacklistStore.count(), 0);
    llm.error = new Error('模型超时');
    assert.equal(await h.handleBlacklistOwnerCommand('别理洛洛', { kind: 'group', isOwner: true, key: GROUP, event: ownerEvent('别理洛洛') }), false);
    assert.equal(h.blacklistStore.isBlocked('30001'), false, 'LLM 失败绝不能误拉');
    assert.equal(sent().length, 0);
  } finally { await h.close(); }
});

test('集成：名字歧义 / 找不到 / 编造 QQ → 反问，黑名单未变', async () => {
  const cases = [
    { name: '歧义', speakers: [{ name: '洛洛', qq: '30001' }, { name: '洛洛', qq: '30009' }], intent: { action: 'block', targetRef: '洛洛' }, ask: /多个人/ },
    { name: '找不到', speakers: [{ name: '阿澄', qq: '30002' }], intent: { action: 'block', targetRef: '洛洛' }, ask: /没找到/ },
    { name: '编造QQ', speakers: [{ name: '洛洛', qq: '30001' }], intent: { action: 'block', targetRef: '88888' }, ask: /没找到/ }
  ];
  for (const c of cases) {
    const { h, llm, sent, ownerEvent } = await makeHarness({ speakers: c.speakers });
    try {
      llm.result = { ...c.intent, reason: '' };
      const before = h.blacklistStore.count();
      const ok = await h.handleBlacklistOwnerCommand('别理洛洛', { kind: 'group', isOwner: true, key: GROUP, event: ownerEvent('别理洛洛') });
      assert.equal(ok, true, `${c.name}：应回执反问`);
      assert.equal(h.blacklistStore.count(), before, `${c.name}：黑名单未变`);
      assert.match(lastText(sent()), c.ask, `${c.name}：反问文案`);
      assert.match(lastText(sent()), /@|QQ/, `${c.name}：请主人 @ 或给 QQ`);
    } finally { await h.close(); }
  }
});

test('集成：主人说「拉黑我」/「拉黑你自己」→ 拒绝，谁都没被拉黑', async () => {
  const { h, llm, sent, ownerEvent } = await makeHarness({ speakers: [] });
  try {
    llm.result = { action: 'block', targetRef: '我', reason: '' };
    assert.equal(await h.handleBlacklistOwnerCommand('拉黑我', { kind: 'private', isOwner: true, key: PRIVATE, event: ownerEvent('拉黑我') }), true);
    assert.equal(h.blacklistStore.isBlocked(OWNER_QQ), false, '主人永不被拉黑');
    assert.match(lastText(sent()), /不能拉黑主人/);
    llm.result = { action: 'block', targetRef: '你自己', reason: '' };
    assert.equal(await h.handleBlacklistOwnerCommand('拉黑你自己', { kind: 'private', isOwner: true, key: PRIVATE, event: ownerEvent('拉黑你自己') }), true);
    assert.equal(h.blacklistStore.isBlocked(SELF_QQ), false, '她自己永不被拉黑');
    assert.equal(h.blacklistStore.count(), 0);
  } finally { await h.close(); }
});

test('集成：显式「拉黑 QQ号」走确定性快路径，不花 LLM（群里也认）', async () => {
  const { h, llm, sent, ownerEvent } = await makeHarness({ speakers: [] });
  try {
    const ok = await h.handleBlacklistOwnerCommand('拉黑 30001 一直骂人', { kind: 'group', isOwner: true, key: GROUP, event: ownerEvent('拉黑 30001 一直骂人') });
    assert.equal(ok, true);
    assert.equal(h.blacklistStore.isBlocked('30001'), true);
    assert.equal(llm.calls.length, 0, '显式 QQ 命令不该调 LLM');
    assert.match(lastText(sent()), /30001/);
  } finally { await h.close(); }
});

test('集成：主人用真实长度 QQ 下令「拉黑自己」→ 快路径 exec 护栏也拒绝', async () => {
  const h = await bridgeHarness({ config: { ownerQQ: 10001, allow: { private: ['10001', '123'], groups: ['456'] }, simulation: { safety: { blacklist: { enabled: true } } } } });
  h.setSnowlumaConnected(true);
  const llm = { calls: [] };
  h.setInnerLife({ extractBlacklistIntent: async (a) => { llm.calls.push(a); return { action: 'none', targetRef: '', reason: '' }; }, handleOwnerCommand: async () => false });
  try {
    const event = { self_id: 999, user_id: 10001, message: [{ type: 'text', data: { text: '拉黑 10001' } }], raw_message: '拉黑 10001', sender: { nickname: 'owner' } };
    const ok = await h.handleBlacklistOwnerCommand('拉黑 10001', { kind: 'private', isOwner: true, key: 'private:10001', event });
    assert.equal(ok, true);
    assert.equal(h.blacklistStore.isBlocked('10001'), false, '主人永不被拉黑（数字护栏）');
    assert.equal(llm.calls.length, 0, '显式 QQ 走快路径，不调 LLM');
    assert.match(h.calls.sent.at(-1).text, /不能拉黑主人/);
  } finally { await h.close(); }
});

test('集成：回滚开关 false → 逐字回旧路径（私聊+QQ号），群裡自然语言不生效', async () => {
  const { h, llm, sent, ownerEvent } = await makeHarness({ nl: false, speakers: [{ name: '洛洛', qq: '30001' }] });
  try {
    // 群裡自然语言：旧路径不认（kind!=='private' 直接 false）
    llm.result = { action: 'block', targetRef: '洛洛', reason: '' };
    assert.equal(await h.handleBlacklistOwnerCommand('别理洛洛', { kind: 'group', isOwner: true, key: GROUP, event: ownerEvent('别理洛洛') }), false);
    assert.equal(h.blacklistStore.isBlocked('30001'), false);
    assert.equal(llm.calls.length, 0, '回滚后不该调 LLM');
    // 私聊按名字：旧解析器不认（没有 QQ 号）
    assert.equal(await h.handleBlacklistOwnerCommand('别理洛洛', { kind: 'private', isOwner: true, key: PRIVATE, event: ownerEvent('别理洛洛') }), false);
    assert.equal(h.blacklistStore.isBlocked('30001'), false);
    // 私聊 + QQ号：旧路径仍工作
    assert.equal(await h.handleBlacklistOwnerCommand('拉黑 30001', { kind: 'private', isOwner: true, key: PRIVATE, event: ownerEvent('拉黑 30001') }), true);
    assert.equal(h.blacklistStore.isBlocked('30001'), true);
    assert.ok(sent().every((m) => m.kind === 'private'), '旧路径回执只走主人私聊');
  } finally { await h.close(); }
});

// ── Part 3：端到端 handleIncoming 接线 ──────────────────────────────────────

test('端到端：主人群消息经 handleIncoming → 真的拉黑（证明调用点传了 key/event）', async () => {
  const { h, llm, ownerEvent } = await makeHarness({ speakers: [{ name: '洛洛', qq: '30001' }] });
  try {
    llm.result = { action: 'block', targetRef: '洛洛', reason: '' };
    await h.handleIncoming('group', '456', ownerEvent('别理洛洛'), h.cfg);
    assert.equal(h.blacklistStore.isBlocked('30001'), true, '端到端应拉黑');
    assert.equal(llm.calls.length, 1);
    assert.equal(llm.calls[0].kind, 'group');
  } finally { await h.close(); }
});

test('端到端：被拉黑者的消息在入库前被丢弃（入站拦截保留不动）', async () => {
  const { h, llm } = await makeHarness({ speakers: [] });
  try {
    h.blacklistStore.add({ qq: '30001', name: '洛洛', origin: 'owner' });
    const st = h.getSimulationState(GROUP);
    const before = st.recentMessages.length;
    const blockedEvent = { self_id: 999, user_id: 30001, message_id: 1, message: [{ type: 'text', data: { text: '我又来了' } }], raw_message: '我又来了', sender: { nickname: '洛洛' } };
    await h.handleIncoming('group', '456', blockedEvent, h.cfg);
    assert.equal(st.recentMessages.length, before, '被拉黑者消息不得入库');
    assert.equal(llm.calls.length, 0);
  } finally { await h.close(); }
});

// ── Part 4：旧码反证（内嵌改动前逐字源码 + anchor 守卫）─────────────────────

// 改动前私有仓 bridge.js 的 handleBlacklistOwnerCommand（base 183b56a，逐字）。
// 它只认「主人私聊 + parseBlacklistCommand 的固定关键词 + QQ号」。
const LEGACY_HANDLER_SOURCE = `async function handleBlacklistOwnerCommand(text, { kind, isOwner } = {}) {
    if (!isOwner || kind !== 'private') return false;
    const cmd = parseBlacklistCommand(text);
    if (!cmd) return false;
    const ownerKey = \`private:\${cfg.ownerQQ}\`;
    const reply = (msg) => sendToQQ(ownerKey, msg);
    if (cmd.action === 'list') {
      const rows = blacklistStore.list();
      if (!rows.length) { await reply('黑名单是空的。'); return true; }
      const lines = rows.map((row) => \`\${row.qq}\${row.name ? \`（\${row.name}）\` : ''} · \${row.origin === 'auto' ? '她自行拉黑' : '你下令'} · \${row.reason || '没有原因'}\`);
      await reply([\`黑名单 \${rows.length} 人：\`, ...lines].join(String.fromCharCode(10)));
      return true;
    }
    if (!cmd.qq) { await reply('要带 QQ 号，例如：拉黑 123456 一直骂人 / 解封 123456'); return true; }
    if (cmd.action === 'block') {
      if (String(cmd.qq) === String(cfg.ownerQQ ?? '')) { await reply('不能拉黑主人自己。'); return true; }
      if (blacklistStore.isBlocked(cmd.qq)) { await reply(\`\${cmd.qq} 已经在黑名单里了；说「解封 \${cmd.qq}」可以解除。\`); return true; }
      const r = blacklistStore.add({ qq: cmd.qq, reason: cmd.reason || '主人要求不再理这个人', origin: 'owner' });
      if (!r.ok) { await reply('QQ 号格式不对，应该是 5–12 位数字。'); return true; }
      try { recordLiveEvent('blacklist', \`\${cmd.qq} 被主人拉黑\`); } catch {}
      await reply(\`已拉黑 \${cmd.qq}\${cmd.reason ? \`（\${cmd.reason}）\` : ''}。之后不再回复他，也不会记他的消息；说「解封 \${cmd.qq}」解除。\`);
      return true;
    }
    const r = blacklistStore.remove(cmd.qq);
    await reply(r.ok ? \`已解封 \${cmd.qq}，可以正常回复了。\` : \`\${cmd.qq} 不在黑名单里。\`);
    return true;
  }`;

function makeLegacy() {
  const store = createBlacklist({ file: '' });
  const sent = [];
  const cfg = { ownerQQ: OWNER_QQ };
  const sendToQQ = async (key, msg) => { sent.push({ key, text: msg }); };
  const recordLiveEvent = () => {};
  // eslint-disable-next-line no-new-func
  const factory = new Function('parseBlacklistCommand', 'blacklistStore', 'cfg', 'sendToQQ', 'recordLiveEvent', `return (${LEGACY_HANDLER_SOURCE});`);
  const handler = factory(parseBlacklistCommand, store, cfg, sendToQQ, recordLiveEvent);
  return { store, sent, handler };
}

test('反证 anchor：旧夹具本身能跑（私聊+QQ号仍拉黑），不是空操作', async () => {
  const { store, sent, handler } = makeLegacy();
  const ok = await handler('拉黑 30001 骂人', { kind: 'private', isOwner: true });
  assert.equal(ok, true, 'anchor：旧码私聊+QQ号必须能拉黑，否则夹具坏了');
  assert.equal(store.isBlocked('30001'), true);
  assert.ok(sent.length > 0, 'anchor：旧码应有回执（证明 sendToQQ 真的被接到）');
  // 空操作守卫：非主人/群聊在旧码下确实不动（与预期一致）
  assert.equal(await handler('拉黑 30002', { kind: 'private', isOwner: false }), false);
  assert.equal(store.isBlocked('30002'), false);
});

test('反证：旧码做不到主人群裡自然语言拉黑 / 按名字拉黑（这些场景在旧码上变红）', async () => {
  const scenarios = [
    { name: '群裡「别理洛洛」', text: '别理洛洛', kind: 'group' },
    { name: '私聊「别理洛洛」（按名字）', text: '别理洛洛', kind: 'private' },
    { name: '私聊「以后不想理洛洛了」', text: '以后不想理洛洛了', kind: 'private' },
    { name: '私聊「可以理洛洛了」（按名字解封）', text: '可以理洛洛了', kind: 'private' }
  ];
  for (const s of scenarios) {
    const { store, handler } = makeLegacy();
    store.add({ qq: '30001', name: '洛洛', origin: 'owner' }); // 预置，便于观察解封是否发生
    const before = store.isBlocked('30001');
    const ok = await handler(s.text, { kind: s.kind, isOwner: true });
    // 旧码对这些自然语言场景一律不生效：要么直接 false，要么回执「要带 QQ 号」但黑名单不变。
    const changed = store.isBlocked('30001') !== before;
    assert.equal(changed, false, `旧码不该改变黑名单：${s.name}`);
    if (s.text.startsWith('可以理')) {
      assert.equal(store.isBlocked('30001'), true, `旧码无法按名字解封：${s.name}`);
    } else {
      assert.equal(ok, false, `旧码不认自然语言拉黑（返回 false）：${s.name}`);
    }
  }
});

test('反证（红测）：把新行为断言施加到旧码上必须抛错；anchor 守卫证明非空操作', async () => {
  // 新行为期望：主人群裡「别理洛洛」后 30001 应被拉黑。把这条断言跑在旧码上 → 必须红。
  const { store, handler } = makeLegacy();
  await handler('别理洛洛', { kind: 'group', isOwner: true });
  assert.throws(
    () => assert.equal(store.isBlocked('30001'), true, '新行为：群裡按名字拉黑应生效'),
    /AssertionError/,
    '旧码上这条新断言必须变红，否则反证无效'
  );
  // anchor/空操作守卫：同一旧夹具在「私聊+QQ号」下必须能拉黑（证明夹具不是恒红的空壳）。
  const anchor = makeLegacy();
  await anchor.handler('拉黑 30001', { kind: 'private', isOwner: true });
  assert.doesNotThrow(() => assert.equal(anchor.store.isBlocked('30001'), true), 'anchor：旧码私聊+QQ号必须能拉黑');
  assert.ok(anchor.sent.length > 0, 'anchor：旧夹具确有回执（sendToQQ 真的被接到，非空操作）');
});

test('反证对照：同一批场景在新处理器上变绿（群裡/按名字都能拉黑与解封）', async () => {
  // 群裡按名字拉黑
  {
    const { h, llm, ownerEvent } = await makeHarness({ speakers: [{ name: '洛洛', qq: '30001' }] });
    try {
      llm.result = { action: 'block', targetRef: '洛洛', reason: '' };
      await h.handleBlacklistOwnerCommand('别理洛洛', { kind: 'group', isOwner: true, key: GROUP, event: ownerEvent('别理洛洛') });
      assert.equal(h.blacklistStore.isBlocked('30001'), true, '新码：群裡按名字拉黑生效');
    } finally { await h.close(); }
  }
  // 私聊按名字解封
  {
    const { h, llm, ownerEvent } = await makeHarness({ key: PRIVATE, speakers: [{ name: '洛洛', qq: '30001' }] });
    try {
      h.blacklistStore.add({ qq: '30001', name: '洛洛', origin: 'owner' });
      llm.result = { action: 'unblock', targetRef: '洛洛', reason: '' };
      await h.handleBlacklistOwnerCommand('可以理洛洛了', { kind: 'private', isOwner: true, key: PRIVATE, event: ownerEvent('可以理洛洛了') });
      assert.equal(h.blacklistStore.isBlocked('30001'), false, '新码：私聊按名字解封生效');
    } finally { await h.close(); }
  }
});

// ── Part 5：开源 base 反证（base 完全没有拉黑功能，接线断言在 base 上必红）─────

test('反证（无此 feature）：base 源码没有拉黑接线；anchor/空操作守卫证明源码夹具非空读', () => {
  const source = fs.readFileSync(new URL('../app/whale.js', import.meta.url), 'utf8');
  // anchor：夹具真的读到了桥接源码（既有签名命令接线必须在，base 也有）。
  assert.ok(source.includes('handleSignatureOwnerCommand(plainContent'), 'anchor：应读到既有主人命令接线');
  // 空操作守卫：故意不存在的标记必须找不到（证明匹配不是恒真）。
  assert.ok(!source.includes('blacklistStore.isBlocked(event.__NO_SUCH_FIELD__)'), '空操作守卫：不存在的标记不得命中');
  // 新行为断言：入站拦截 + 主人命令接线必须存在；base（无此 feature）上这两条都红。
  assert.ok(source.includes('blacklistStore.isBlocked(event.user_id)'), '入站拦截必须接在 handleIncoming');
  assert.ok(source.includes('handleBlacklistOwnerCommand(plainContent'), '主人拉黑命令必须接在 handleIncoming');
  // 拦截必须先于入库：handleIncoming 里拦截点要在 appendSimulationMessage 调用之前。
  const incoming = source.slice(source.indexOf('async function handleIncoming'));
  const guardAt = incoming.indexOf('blacklistStore.isBlocked(event.user_id)');
  const appendAt = incoming.indexOf('appendSimulationMessage(key');
  assert.ok(guardAt > 0 && appendAt > 0 && guardAt < appendAt, '拉黑拦截必须先于消息入库');
});