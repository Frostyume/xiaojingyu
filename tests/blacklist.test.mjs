// 拉黑名单：存储持久化、自行拉黑门槛、主人命令解析。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBlacklist, normalizeBlacklistState, parseBlacklistCommand, shouldCountBlacklistStrike } from '../runtime/control/blacklist.js';

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-blacklist-'));
  return { dir, file: path.join(dir, 'blacklist.json') };
}

test('存储：拉黑/重复拉黑/解封/持久化', () => {
  const { dir, file } = tempFile();
  try {
    const store = createBlacklist({ file });
    assert.equal(store.isBlocked('30001'), false);
    const first = store.add({ qq: '30001', name: '阿澄', reason: '一直骂人', origin: 'owner' });
    assert.equal(first.ok, true);
    assert.equal(store.isBlocked('30001'), true);
    assert.equal(store.count(), 1);

    const again = store.add({ qq: '30001', reason: '', origin: 'auto' });
    assert.equal(again.replaced, true);
    assert.equal(store.get('30001').origin, 'auto');
    assert.equal(store.get('30001').reason, '一直骂人', '重复拉黑没写原因时保留旧原因');
    assert.equal(store.count(), 1);

    const reopened = createBlacklist({ file });
    assert.equal(reopened.isBlocked('30001'), true, '重新加载后仍在黑名单');
    assert.equal(reopened.get('30001').name, '阿澄');

    assert.equal(store.remove('30001').ok, true);
    assert.equal(store.remove('30001').ok, false);
    assert.equal(createBlacklist({ file }).count(), 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('存储：非法 QQ 号一律拒绝，脏数据读出时被清掉', () => {
  const { dir, file } = tempFile();
  try {
    const store = createBlacklist({ file });
    assert.equal(store.add({ qq: 'abc' }).ok, false);
    assert.equal(store.add({ qq: '123' }).ok, false);
    assert.equal(store.count(), 0);
    fs.writeFileSync(file, JSON.stringify({
      entries: { '40001': { origin: 'weird', at: 1 }, bad: {} },
      autoHits: { '40001': [1, 'x', 2], nope: [1] }
    }));
    const reopened = createBlacklist({ file });
    assert.equal(reopened.count(), 1);
    assert.equal(reopened.get('40001').origin, 'owner', '未知来源归一到 owner');
    assert.deepEqual(normalizeBlacklistState({}).entries, {});
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('自行拉黑：窗口内 3 次辱骂触发，普通消息不计，窗口外会过期', () => {
  const { dir, file } = tempFile();
  try {
    const store = createBlacklist({ file });
    const threshold = { windowMs: 60 * 60 * 1000, insultCount: 3, affectionFloor: 5 };
    const t0 = 1_700_000_000_000;
    assert.equal(store.noteStrike({ qq: '30002', type: 'message', affection: 8, threshold, at: t0 }).counted, false);
    assert.equal(store.noteStrike({ qq: '30002', type: 'insult', affection: 8, threshold, at: t0 }).block, false);
    assert.equal(store.noteStrike({ qq: '30002', type: 'hostile', affection: 7, threshold, at: t0 + 1000 }).block, false);
    const third = store.noteStrike({ qq: '30002', type: 'insult', affection: 6, threshold, at: t0 + 2000 });
    assert.equal(third.block, true, '第 3 次攻击应触发');
    assert.match(third.reason, /3 次/);

    assert.equal(store.noteStrike({ qq: '30003', type: 'insult', affection: 8, threshold, at: t0 }).block, false);
    assert.equal(store.noteStrike({ qq: '30003', type: 'insult', affection: 8, threshold, at: t0 + 2 * 60 * 60 * 1000 }).block, false, '窗口外旧记录过期');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('自行拉黑：好感跌到门槛以下时，单次攻击即可触发', () => {
  const { dir, file } = tempFile();
  try {
    const store = createBlacklist({ file });
    const threshold = { windowMs: 3600 * 1000, insultCount: 3, affectionFloor: 5 };
    const r = store.noteStrike({ qq: '30004', type: 'insult', affection: 3, threshold, at: Date.now() });
    assert.equal(r.block, true);
    assert.match(r.reason, /好感/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('主人命令：拉黑 / 解封 / 查名单，以及不误伤普通句子', () => {
  assert.deepEqual(parseBlacklistCommand('拉黑 30005 一直开黄腔'), { action: 'block', qq: '30005', reason: '一直开黄腔' });
  assert.deepEqual(parseBlacklistCommand('以后别理 30005'), { action: 'block', qq: '30005', reason: '' });
  assert.deepEqual(parseBlacklistCommand('别再理 30005'), { action: 'block', qq: '30005', reason: '' });
  assert.deepEqual(parseBlacklistCommand('解封 30005'), { action: 'unblock', qq: '30005' });
  assert.deepEqual(parseBlacklistCommand('可以理 30005 了'), { action: 'unblock', qq: '30005' });
  assert.deepEqual(parseBlacklistCommand('黑名单'), { action: 'list' });
  assert.equal(parseBlacklistCommand('拉黑'), null, '缺 QQ 号不算命令');
  assert.equal(parseBlacklistCommand('他拉黑了我'), null, '普通陈述不能命中');
  assert.equal(parseBlacklistCommand('以后别理他了'), null, '没有号码时不猜');
});

test('自行拉黑闸：只有确实指向她的消息才计数', () => {
  assert.equal(shouldCountBlacklistStrike({ addressedTo: 'self' }), true, '点名/@/引用她：计数');
  assert.equal(shouldCountBlacklistStrike({ addressedTo: 'other' }), false, '在跟别人说话：不计数');
  assert.equal(shouldCountBlacklistStrike({ addressedTo: 'unknown' }), false, '背景聊天：不计数');
  assert.equal(shouldCountBlacklistStrike({ addressedTo: 'all' }), false, '@全体不是单独骂她：不计数');
  assert.equal(shouldCountBlacklistStrike({ addressedTo: '' }), false);
  assert.equal(shouldCountBlacklistStrike({ addressedTo: 'self', isOwner: true }), false, '主人永远不拉黑');
});