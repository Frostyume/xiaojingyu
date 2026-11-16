#!/usr/bin/env node
// B2 回归：白饭感知、按需手册（选择/注入/闸门）、会话影子副本已存在、默认关闭零影响。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bridgeHarness } from './bridge-harness.mjs';
import {
  normalizeRiceConfig,
  riceBucket,
  loadRiceBonus,
  addPokeBonus,
  saveRiceBonus,
  buildRiceLine,
  RICE_BUCKET_LABELS
} from '../runtime/persona/rice.js';
import {
  catalog,
  clearPlaybookCache,
  loadPlaybook,
  selectPlaybooks,
  planSections,
  survivingPlaybooks
} from '../runtime/persona/prompt-registry.js';
import { createPlaybookGate } from '../runtime/persona/playbook-gate.js';
import { SessionMapStore } from '../runtime/kernel/session-map.js';
import { openDatabase } from '../runtime/kernel/db.js';

console.log('## 白饭：只给档位、不报数字');
assert.equal(normalizeRiceConfig({}).enabled, false, '默认关闭');
assert.equal(normalizeRiceConfig({ enabled: true }).enabled, true);
assert.equal(riceBucket({ used: 0, allowance: 1000 }).level, 'plenty');
assert.equal(riceBucket({ used: 200, allowance: 1000 }).level, 'enough');
assert.equal(riceBucket({ used: 600, allowance: 1000 }).level, 'fine');
assert.equal(riceBucket({ used: 800, allowance: 1000 }).level, 'low');
assert.equal(riceBucket({ used: 950, allowance: 1000 }).level, 'empty');
assert.equal(riceBucket({ used: 1, allowance: 0 }).level, 'unknown', 'allowance 为 0 时整段省略');
for (const level of Object.keys(RICE_BUCKET_LABELS)) {
  const line = buildRiceLine({ level });
  assert.ok(line.length > 0);
  assert.ok(!/\d/.test(line), `档位 ${level} 的提示词不得包含数字`);
}
assert.match(buildRiceLine({ level: 'low' }), /口粮不多了/);
assert.match(buildRiceLine({ level: 'low', groupsCanMention: false }), /群里不要主动提/);

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rice-test-'));
const riceFile = path.join(dir, 'rice.json');
const day = '2026-11-16';
assert.deepEqual(loadRiceBonus(riceFile, { today: day }), { day, bonusTokens: 0, pokes: 0 }, '文件不存在按零额度');
let bonus = addPokeBonus(null, { today: day, perPoke: 600, capTokens: 1000 });
assert.equal(bonus.bonusTokens, 600);
bonus = addPokeBonus(bonus, { today: day, perPoke: 600, capTokens: 1000 });
assert.equal(bonus.bonusTokens, 1000, '口粮封顶');
assert.equal(bonus.pokes, 2, '封顶后仍累计拍打次数');
saveRiceBonus(riceFile, bonus);
assert.equal(loadRiceBonus(riceFile, { today: day }).bonusTokens, 1000);
assert.equal(loadRiceBonus(riceFile, { today: '2026-11-17' }).bonusTokens, 0, '跨天归零');
console.log('OK 白饭');

console.log('## 按需手册：目录、选择、预算存活');
clearPlaybookCache();
const list = catalog();
assert.equal(list.length, 9, '九篇手册都应可读');
assert.deepEqual(list.map((x) => x.id).sort(), ['life', 'media', 'memory', 'messaging', 'owner', 'search', 'slang', 'voice', 'wait']);
assert.equal(selectPlaybooks({ text: '给我发张图片看看' })[0], 'media');
assert.equal(selectPlaybooks({ text: '看看这个', reason: 'poke' })[0], 'media');
assert.equal(selectPlaybooks({ text: '改一下配置和规则' }).length, 0, 'owner 手册只在主人私聊参与');
assert.equal(selectPlaybooks({ text: '改一下配置和规则', ownerChat: true })[0], 'owner');
assert.equal(selectPlaybooks({ text: '然后呢', reason: 'replyCheck' })[0], 'wait');
assert.deepEqual(selectPlaybooks({ text: '发条语音', limit: 0 }), []);
const capped = loadPlaybook('media', { maxTokens: 60 });
assert.ok(capped.text.endsWith('…'), '超过预算应截断');
const planned = planSections([{ id: 'x', text: 'x' }], { playbookIds: ['media'], playbookTexts: { media: '正文' } });
assert.equal(planned.length, 2);
assert.match(planned[1].text, /【按需手册｜/);
assert.deepEqual(survivingPlaybooks(['media', 'voice'], { dropped: ['playbook:voice'] }), ['media']);
console.log('OK 按需手册');

console.log('## 闸门：首次 block、后续放行、annotate 不拦');
{
  const gate = createPlaybookGate({ load: (id) => ({ title: id, text: `${id}-text` }) });
  const first = await gate.check({ tool: 'qq_send_sticker', key: 'group:789' });
  assert.equal(first.mode, 'block');
  assert.match(first.text, /media-text/);
  assert.equal(await gate.check({ tool: 'qq_send_sticker', key: 'group:789' }), null, '同会话只拦一次');
  const annotate = await gate.check({ tool: 'qq_wait_for_messages', key: 'group:789' });
  assert.equal(annotate.mode, 'annotate');
  const injected = createPlaybookGate({
    load: () => ({ title: 'x', text: 'x' }),
    injected: async () => ['media']
  });
  assert.equal(await injected.check({ tool: 'qq_send_sticker', key: 'group:1' }), null, '桥接已注入则不再拦');
}
console.log('OK 闸门');

console.log('## 会话影子副本：主文件丢了也能补齐映射');
{
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const map = new SessionMapStore({ db, logger: () => {} });
  map.saveAll({ 'group:1': 's1', 'private:2': 's2' }, { 'group:1': { preset: 'qq-chat' } });
  const rows = map.loadAll();
  assert.equal(rows.length, 2);
  assert.equal(map.get('group:1').sessionId, 's1');
  assert.deepEqual(map.get('group:1').policy, { preset: 'qq-chat' });
  map.saveAll({ 'group:1': 's1' });
  assert.equal(map.get('private:2'), null, '已不在 sessions.json 的 key 会被清掉');
  db.close();
}
console.log('OK 会话影子副本');

console.log('## 默认关闭：提示词逐字不变');
{
  const h = await bridgeHarness({ config: { allow: { private: ['123'], groups: ['789'] } } });
  try {
    h.appendSimulationMessage('group:789', '小明', '发条语音给我', '发条语音给我', false, false, 'b2-off-1', [], '20001', [], { text: '发条语音给我', directed: true });
    const prompt = h.buildWakePrompt('group:789', 'timeout');
    assert.ok(!prompt.includes('【按需手册'), '关闭时不得注入手册');
    assert.ok(!prompt.includes('【今天的白饭】'), '关闭时不得注入白饭');
  } finally { await h.close(); }
}
console.log('OK 默认关闭');

console.log('## 开启后接线：白饭档位 + 相关手册');
{
  const h = await bridgeHarness({
    config: {
      allow: { private: ['123'], groups: ['789'] },
      simulation: {
        rice: { enabled: true, dailyTokens: 1000, pokeBonusTokens: 100 },
        prompt: { playbooks: { enabled: true, maxPlaybooks: 2, playbookMaxTokens: 800 } }
      }
    }
  });
  try {
    h.appendSimulationMessage('group:789', '小明', '发条语音给我', '发条语音给我', false, false, 'b2-on-1', [], '20001', [], { text: '发条语音给我', directed: true });
    const prompt = h.buildWakePrompt('group:789', 'timeout');
    assert.ok(prompt.includes('【今天的白饭】'), '开启后应注入档位');
    const block = prompt.split('【今天的白饭】')[1]?.split('\n\n')[0] || '';
    assert.ok(!/\d/.test(block), '注入的话术不得含数字');
    assert.ok(prompt.includes('【按需手册｜发语音】'), '相关消息应带上语音手册');
  } finally { await h.close(); }
}
console.log('OK 开启接线');

console.log('OK B2 四项');