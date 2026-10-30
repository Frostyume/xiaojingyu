// 关系 v2 桥接层回归：按群启用（家人群排除）、事件记账、prompt 语气卡、实时快照脱敏。
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';
import { openDatabase } from '../src/core/db.js';
import { RelationshipStore } from '../src/core/relationships.js';

let failures = 0;
async function test(name, run) {
  try { await run(); console.log('PASS', name); }
  catch (error) { failures += 1; console.error('FAIL', name, '—', error?.stack ?? error); }
}

function append(h, key, userId, name, text, extra = {}) {
  return h.appendSocialV2Message(
    key, name, text, text, false, false, extra.messageId || `m-${userId}-${Date.now()}`,
    [], userId, [], { text, directed: true, ...extra }
  );
}

await test('R1 家人群默认排除、普通群默认开启、可按群覆盖', async () => {
  const h = await bridgeHarness({
    config: {
      allow: { private: ['123'], groups: ['456', '789'] },
      socialV2: {
        groupProfiles: {
          'group:456': { label: '家人群' },
          'group:789': { label: '普通群' }
        }
      }
    }
  });
  try {
    assert.equal(h.relationshipsEnabledForKey('group:456'), false, '家人群应排除');
    assert.equal(h.relationshipsEnabledForKey('group:789'), true, '普通群应开启');
    h.setMode('reserved2');
    append(h, 'group:456', '20001', '家人', '晚上好');
    assert.equal(h.relationshipStore.get('group:456', '20001'), null, '排除群不应记账');
    append(h, 'group:789', '20001', '小明', '晚上好');
    const row = h.relationshipStore.get('group:789', '20001');
    assert.ok(row && row.interactionCount >= 1, '普通群应记账');
  } finally { await h.close(); }
});

await test('R2 事件分类、负向下降、prompt 语气卡不带 ID/数值', async () => {
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['789'] } } });
  try {
    h.setMode('reserved2');
    append(h, 'group:789', '20001', '小明', '你好呀', { isQuestion: true });
    const before = h.relationshipStore.get('group:789', '20001');
    append(h, 'group:789', '20001', '小明', '滚开，烦死了');
    const after = h.relationshipStore.get('group:789', '20001');
    assert.ok(after.affection < before.affection, '负向事件应降低好感');

    h.relationshipStore.set('group:789', '20001', { affection: 72, trust: 55, familiarity: 70, rapport: 50, note: '小明' });
    const prompt = h.buildWakePromptV2('group:789', 'timeout');
    assert.match(prompt, /群友关系/);
    assert.match(prompt, /对当前说话人的语气/);
    assert.ok(!prompt.includes('20001'), 'prompt 不得包含 QQ 号');
    assert.ok(!/好感\d|信任\d|羁绊\d/.test(prompt), 'prompt 不得包含原始数值');
  } finally { await h.close(); }
});

await test('R2b 同一批来信多次发送只记一次回复好感', async () => {
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['789'] } } });
  try {
    h.setMode('reserved2');
    append(h, 'group:789', '20001', '小明', '你好呀');
    h.recordSentMessagesV2('group:789', ['回复一']);
    h.recordSentMessagesV2('group:789', ['回复二']);
    const events = h.relationshipStore.timeline('group:789', '20001', { limit: 20 }).filter((e) => e.type === 'reply');
    assert.equal(events.length, 1, '一轮多次发送只应记一次 reply 事件');
  } finally { await h.close(); }
});

await test('R2c 连续互动/久别回归 + 阶段变化/手动调整写入时间线', async () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  let now = Date.UTC(2026, 9, 1, 4, 0, 0); // 上海时间 12:00
  const store = new RelationshipStore({ db, now: () => now, logger: () => {} });
  const key = 'group:789';
  const uid = '20001';
  try {
    store.observe({ key, userId: uid, kind: 'message', displayName: '小明', context: { text: '你好', messageId: 'm1' } });
    now += 25 * 3600 * 1000;
    store.observe({ key, userId: uid, kind: 'message', displayName: '小明', context: { text: '在吗', messageId: 'm2' } });
    let events = store.timeline(key, uid, { limit: 20 });
    assert.ok(events.some((e) => e.type === 'streak'), '隔天连续发言应记 streak');

    now += 4 * 24 * 3600 * 1000;
    store.observe({ key, userId: uid, kind: 'message', displayName: '小明', context: { text: '我回来了', messageId: 'm3' } });
    events = store.timeline(key, uid, { limit: 20 });
    assert.ok(events.some((e) => e.type === 'return'), '隔 3 天以上应记 return');

    const manualUser = '20002';
    const beforeStage = store.get(key, manualUser)?.stage ?? 0;
    store.set(key, manualUser, {
      affection: 30, trust: 20, familiarity: 30, rapport: 20,
      note: '小红', reason: '测试手动提升'
    });
    events = store.timeline(key, manualUser, { limit: 30 });
    const manual = events.find((e) => e.type === 'manual');
    assert.equal(manual?.reason, '测试手动提升');
    assert.equal(manual?.actor, 'console');
    const stage = events.find((e) => e.type === 'stage');
    assert.ok(stage, '阶段变化应单独写入时间线');
    assert.equal(stage.stageFrom, beforeStage);
    assert.ok(stage.stageTo > stage.stageFrom);
    assert.ok(stage.stageFromLabel && stage.stageToLabel);
    const daily = db.get(
      'SELECT interactions FROM relationship_daily WHERE key = ? AND user_id = ? ORDER BY day_key DESC LIMIT 1',
      key, manualUser
    );
    assert.equal(Number(daily.interactions), 0, '手动调整不应冒充群聊互动次数');
  } finally {
    db.close();
  }
});

await test('R2d 订阅群的唤醒 prompt 带精确赛程日期/北京时间/对阵', async () => {
  // 用“北京时间的明天”做固定样本，避免测试跨过午夜后样本变成过去赛程。
  const tomorrow = new Date(Date.now() + 8 * 3600 * 1000);
  tomorrow.setUTCDate(tomorrow.getUTCDate() + 1);
  const dayKey = `${tomorrow.getUTCFullYear()}-${String(tomorrow.getUTCMonth() + 1).padStart(2, '0')}-${String(tomorrow.getUTCDate()).padStart(2, '0')}`;
  const dayLabel = `${tomorrow.getUTCMonth() + 1}/${tomorrow.getUTCDate()}`;
  const h = await bridgeHarness({
    config: {
      allow: { private: ['123'], groups: ['789'] },
      socialV2: { subscriptions: [{ key: 'group:789', topic: 's16', enabled: true, maxPerDay: 2 }] }
    },
    files: {
      'state/esports-schedule.json': {
        updatedAt: Date.now(),
        source: 'baidu',
        matches: [
          { date: dayKey, time: '02:00', teamA: 'BLG', teamB: 'KC', format: 'BO1' },
          { date: dayKey, time: '06:00', teamA: 'TLAW', teamB: 'AL', format: 'BO3' }
        ]
      }
    }
  });
  try {
    h.setMode('reserved2');
    append(h, 'group:789', '20001', '小明', '今天赛程是什么');
    const prompt = h.buildWakePromptV2('group:789', 'timeout');
    assert.match(prompt, /当前时间.*北京时间 UTC\+8/);
    assert.match(prompt, /S16 赛程/);
    assert.match(prompt, /赛程回答格式/);
    assert.ok(prompt.includes(dayLabel), '应包含样本比赛日期');
    assert.match(prompt, /02:00 BLG vs KC/);
    assert.match(prompt, /06:00 TLAW vs AL/);
  } finally { await h.close(); }
});

await test('R5 同一 QQ 号跨群共享关系，群昵称各自保留', async () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  let now = Date.UTC(2026, 9, 1, 4, 0, 0);
  const store = new RelationshipStore({ db, now: () => now, logger: () => {} });
  const uid = '20001';
  try {
    store.observe({ key: 'group:111', userId: uid, kind: 'message', displayName: '小明', context: { text: '你好', messageId: 'g1m1' } });
    now += 60 * 1000;
    store.observe({ key: 'group:222', userId: uid, kind: 'message', displayName: '小红', context: { text: '又见面啦', messageId: 'g2m1' } });
    const a = store.get('group:111', uid);
    const b = store.get('group:222', uid);
    assert.ok(a && b, '两个群都应有这个 QQ 的关系行');
    for (const field of ['affection', 'trust', 'familiarity', 'rapport', 'bond', 'stage', 'interactionCount']) {
      assert.equal(a[field], b[field], `${field} 应跨群一致`);
    }
    assert.equal(a.displayName, '小明', 'A 群昵称保留');
    assert.equal(b.displayName, '小红', 'B 群昵称保留');
    store.set('group:222', uid, { affection: 70, trust: 60, familiarity: 55, rapport: 45, note: '小红' });
    assert.equal(store.get('group:111', uid).affection, 70, '控制台调整也应同步到其他群');
    store.delete('group:111', uid);
    assert.equal(store.get('group:222', uid), null, '删除关系应按 QQ 号全局生效');
  } finally { db.close(); }
});

await test('R3 实时快照：昵称 + 脱敏 id + sparkline + spotlight', async () => {  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['789'] } } });
  try {
    h.setMode('reserved2');
    append(h, 'group:789', '20001', '小明', '今天聊比赛');
    append(h, 'group:789', '20002', '小红', '我来了', { isAt: true });
    h.relationshipStore.set('group:789', '20001', { affection: 65, trust: 50, familiarity: 60, rapport: 40, note: '小明' });
    const snap = h.buildRelationshipSnapshot();
    assert.equal(snap.enabled, true);
    assert.ok(snap.groups.length >= 1);
    const members = snap.groups[0].members;
    assert.ok(members.length >= 1);
    for (const m of members) {
      assert.match(m.id, /^u-[0-9a-f]{10}$/);
      assert.ok(!m.id.includes('20001'));
      assert.ok(m.name && m.stageLabel);
      assert.ok(Array.isArray(m.sparkline) && m.sparkline.length === 7);
    }
    assert.ok(snap.spotlight?.name);
    assert.ok(snap.owner, '快照应包含主人关系');
    assert.equal(snap.owner.stageLabel, '主人');
    assert.ok(!JSON.stringify(snap).includes('20001'), '实时快照不得泄露 QQ 号');
  } finally { await h.close(); }
});

await test('R4 控制台鉴权关闭时，本机请求无需 token', async () => {
  const h = await bridgeHarness({ config: { consoleAuth: { enabled: false } } });
  try {
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/status`);
    assert.equal(res.status, 200, '关闭鉴权后本机请求应直接可用');
    const body = await res.json();
    assert.equal(body.consoleAuthEnabled, false);
    const content = await fetch(`http://127.0.0.1:${port}/api/content`).then((r) => r.json());
    assert.equal(content.ok, true);
    for (const key of ['signature', 'search', 'esports', 'share', 'memory']) {
      assert.ok(content[key] && typeof content[key] === 'object', `/api/content 应包含 ${key}`);
    }
    await new Promise((resolve) => server.close(resolve));
  } finally { await h.close(); }
});

await test('R6 辱骂/嘲讽按严重度扣好感，普通吐槽不误伤', async () => {
  const h = await bridgeHarness({
    config: { allow: { private: ['123'], groups: ['456'] }, socialV2: { groupProfiles: {} } }
  });
  try {
    h.setMode('reserved2');
    append(h, 'group:456', '30001', '攻击者', '你不是小鲸鱼，你是脑残', { messageId: 'atk-1' });
    append(h, 'group:456', '30001', '攻击者', '你把输精管和直肠装到嘴巴里', { messageId: 'atk-2' });
    append(h, 'group:456', '30001', '攻击者', '一直喷精喷粪就行了', { messageId: 'atk-3' });
    const row = h.relationshipStore.get('group:456', '30001');
    assert.ok(row.affection < 8, `恶意攻击应降低好感，实际 ${row.affection}`);
    const events = h.relationshipStore.timeline('group:456', '30001', { limit: 10 });
    assert.ok(events.some((e) => e.type === 'insult'), '应记录 insult 事件');
    // 非指向性的普通吐槽不应被当成辱骂
    h.appendSocialV2Message('group:456', '路人', '这游戏真垃圾', '这游戏真垃圾', false, false, 'norm-1', [], '30002', [], {
      text: '这游戏真垃圾', directed: false
    });
    const normal = h.relationshipStore.get('group:456', '30002');
    const normalEvents = h.relationshipStore.timeline('group:456', '30002', { limit: 5 });
    assert.ok(!normalEvents.some((e) => e.type === 'insult' || e.type === 'hostile'), '普通吐槽不应记攻击');
    assert.ok(normal.affection >= 8, '普通吐槽不应掉好感');
  } finally { await h.close(); }
});

if (failures) {
  console.error(`\n关系 v2 桥接回归：${failures} 项失败`);
  process.exitCode = 1;
} else {
  console.log('\n关系 v2 桥接回归全部通过');
}
