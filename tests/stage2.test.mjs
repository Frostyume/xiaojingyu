// Stage 2 回归：prompt 预算 / 价值评分 / 模型路由 / 分层记忆 / 会话映射影子副本。
// 全部离线（内存 SQLite）。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openDatabase, SCHEMA_VERSION } from '../runtime/kernel/db.js';
import { estimateTokens, truncateToTokens, assembleSections } from '../runtime/kernel/prompt-budget.js';
import { scoreMessage, topicOverlapScore, scoreInputsFromState, VALUE_SCORE_DEFAULTS } from '../runtime/kernel/wake-score.js';
import { resolveModelRoutes, routeSignature } from '../runtime/kernel/model-routing.js';
import { MemoryStore } from '../runtime/kernel/memory.js';
import { SessionMapStore } from '../runtime/kernel/session-map.js';
import { derivePersonaMode, renderPersonaMode } from '../runtime/persona/persona-mode.js';
import { beijingParts, timeOfDayLabel, timeStampCN, currentTimeBlock, timeConflict } from '../runtime/kernel/time-awareness.js';
import { formatCandidatesForPrompt } from '../services/persona/curiosity.js';
import { parseQzoneComments } from '../services/social/qzone.js';

test('prompt-budget: 未超预算时逐字不变', () => {
  const sections = [
    { id: 'a', text: '第一段\n\n', priority: 100 },
    { id: 'b', text: '第二段\n\n', priority: 50 }
  ];
  const out = assembleSections(sections, { maxTokens: 1000 });
  assert.equal(out.text, '第一段\n\n第二段\n\n');
  assert.equal(out.dropped.length, 0);
  assert.equal(out.trimmed.length, 0);
});

test('prompt-budget: 超预算按 dropOrder 丢可选段，静态段保留', () => {
  const big = '很长的可选段落。'.repeat(200);
  const middleText = '中间段落也要保留。'.repeat(200);
  const sections = [
    { id: 'core', text: '核心人格\n\n', priority: 100 },
    { id: 'optional', text: big, priority: 20 },
    { id: 'middle', text: middleText, priority: 50 }
  ];
  const out = assembleSections(sections, { maxTokens: 300, dropOrder: ['optional'] });
  assert.ok(out.text.startsWith('核心人格'));
  assert.equal(out.text.includes('很长的可选段落。'), false, 'optional 已被丢弃');
  assert.ok(out.dropped.includes('optional'));
  assert.ok(out.tokens <= 300);
});

test('prompt-budget: 可截断段按预算收缩，仍超时硬截', () => {
  const text = '甲'.repeat(1000);
  const out = assembleSections([{ id: 'm', text, priority: 50, trim: true }], { maxTokens: 100 });
  assert.ok(out.tokens <= 100);
  assert.ok(out.text.length < 1000);
  assert.ok(out.text.endsWith('…'));
  assert.ok(truncateToTokens(text, 10).length < text.length);
  assert.ok(estimateTokens('你好世界') > 0);
});

test('wake-score: 显式触发必须直达唤醒', () => {
  for (const key of ['isAt', 'isQuoteSelf', 'isPrivate', 'isQuestion']) {
    const r = scoreMessage({ text: '嗯', [key]: true, night: true, recentSelfCount: 9, duplicateCount: 3 });
    assert.equal(r.action, 'wake');
    assert.equal(r.explicit, true);
  }
});

test('wake-score: 泛监听低价值消息被降级', () => {
  const chatter = scoreMessage({ text: '哈哈哈哈', night: false, recentSelfCount: 3, duplicateCount: 1 });
  assert.notEqual(chatter.action, 'wake');
  const topic = scoreMessage({ text: '刚才那个天气和比赛你怎么看', night: false, topicOverlap: 0.9, familiarity: 0.6 });
  assert.equal(topic.action, 'wake');
  const night = scoreMessage({ text: '有人吗', night: true });
  assert.equal(night.action, 'ignore');
});

test('wake-score: 输入统计与话题重合', () => {
  const st = {
    recentMessages: [
      { isSelf: true, time: Date.now() - 1000 },
      { isSelf: false, time: Date.now() - 2000, plain: '今天天气不错' },
      { isSelf: false, time: Date.now() - 3000, plain: '今天天气不错' }
    ],
    activeTopics: [{ text: '天气和比赛' }],
    memberImpressions: { 小明: { interactionCount: 10 } }
  };
  const inputs = scoreInputsFromState(st, { sender: '小明', text: '今天天气不错', cfg: VALUE_SCORE_DEFAULTS });
  assert.equal(inputs.recentSelfCount, 1);
  assert.ok(inputs.duplicateCount >= 1);
  assert.ok(inputs.familiarity > 0);
  assert.ok(topicOverlapScore('天气和比赛', st.activeTopics) > 0);
});

test('model-routing: tier/fallback/群覆盖与去重', () => {
  const routing = {
    enabled: true,
    tiers: { chat: { model: 'chat-model', effort: 'low' }, reflection: { model: 'deep-model', effort: 'max' } },
    fallback: [{ provider: 'backup', model: 'safe-model' }]
  };
  const dsh = { provider: 'main', model: 'base-model', reasoningEffort: 'max' };
  const chat = resolveModelRoutes({ tier: 'chat', routing, dsh });
  assert.deepEqual(chat.map(routeSignature), ['main/chat-model@low', 'backup/safe-model@max', 'main/base-model@max']);
  const refl = resolveModelRoutes({ tier: 'reflection', routing, dsh });
  assert.equal(refl[0].model, 'deep-model');
  const group = resolveModelRoutes({ tier: 'chat', routing, dsh, groupProfile: { model: 'group-model' } });
  assert.equal(group[0].model, 'group-model');
  const disabled = resolveModelRoutes({ tier: 'chat', routing: { enabled: false, tiers: { chat: { model: 'x' } } }, dsh });
  assert.equal(disabled.length, 1);
  assert.equal(disabled[0].model, 'base-model');
});

test('memory: 去重加权、FTS/LIKE 检索、作用域、排除与遗忘', () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const mem = new MemoryStore({ db, logger: () => {} });
  mem.remember({ scope: 'group', ownerKey: 'group:1', topic: '天气', fact: '主人喜欢下雨天', confidence: 0.8 });
  mem.remember({ scope: 'group', ownerKey: 'group:1', topic: '天气', fact: '主人喜欢下雨天', confidence: 0.9 });
  const all = mem.list({ scope: 'group', ownerKey: 'group:1' });
  assert.equal(all.length, 1, '同一事实只存一条');
  assert.equal(all[0].weight, 2);
  assert.equal(all[0].confidence, 0.9);

  const fts = mem.search('喜欢下雨', { ownerKey: 'group:1' });
  assert.equal(fts.length, 1, 'FTS trigram 命中');
  const like = mem.search('天气', { ownerKey: 'group:1' });
  assert.equal(like.length, 1, '2 字查询走 LIKE');

  mem.remember({ scope: 'group', ownerKey: 'group:2', topic: '游戏', fact: '另一个群在聊比赛' });
  assert.equal(mem.search('另一个群', { ownerKey: 'group:1' }).length, 0, '不得跨群泄漏');
  assert.equal(mem.search('另一个群', { ownerKey: 'group:2' }).length, 1);
  mem.remember({ scope: 'global', ownerKey: null, topic: '偏好', fact: '不喜欢被叫客服' });
  assert.ok(mem.search('不喜欢被叫', { ownerKey: 'group:1' }).some((f) => f.scope === 'global'));
  assert.equal(mem.search('不喜欢被叫', { ownerKey: 'group:1', scopes: ['group'] }).length, 0);

  const block = mem.contextBlock('喜欢下雨', { ownerKey: 'group:1', exclude: ['主人喜欢下雨天'] });
  assert.equal(block, '');
  const block2 = mem.contextBlock('喜欢下雨', { ownerKey: 'group:1' });
  assert.match(block2, /长期记忆/);

  assert.equal(mem.forget(all[0].id), true);
  assert.equal(mem.search('喜欢下雨', { ownerKey: 'group:1' }).length, 0);
  db.close();
});

test('memory: 过期事实不检索', () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const mem = new MemoryStore({ db, logger: () => {} });
  mem.remember({ scope: 'global', ownerKey: null, topic: 'x', fact: '这是一条会过期的记忆', expiresAt: Date.now() - 1000 });
  assert.equal(mem.search('会过期', { ownerKey: 'group:1' }).length, 0);
  assert.equal(mem.list({ includeExpired: true }).length, 1);
  db.close();
});

test('memory: 相关度综合权重/新鲜度，过期低置信度会被清理', () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const mem = new MemoryStore({ db, logger: () => {} });
  mem.remember({ scope: 'group', ownerKey: 'group:1', topic: '周末', fact: '周末喜欢去山里徒步', confidence: 0.8 });
  mem.remember({ scope: 'group', ownerKey: 'group:1', topic: '周末', fact: '周末喜欢去海边散步', confidence: 0.8 });
  const old = mem.list({ scope: 'group', ownerKey: 'group:1' }).find((f) => f.fact.includes('徒步'));
  db.run('UPDATE memory_facts SET last_seen_at = ? WHERE id = ?', Date.now() - 200 * 24 * 3600 * 1000, old.id);
  const ranked = mem.search('周末喜欢', { ownerKey: 'group:1' });
  assert.equal(ranked[0]?.fact, '周末喜欢去海边散步', '新鲜事实应排在两百天前的同权重事实之前');

  db.run('UPDATE memory_facts SET last_seen_at = ?, confidence = 0.2 WHERE id = ?', Date.now() - 200 * 24 * 3600 * 1000, old.id);
  assert.ok(mem.prune({ staleDays: 120, lowConfidence: 0.35 }) >= 1);
  assert.ok(!mem.list({ scope: 'group', ownerKey: 'group:1' }).some((f) => f.fact.includes('徒步')));
  db.close();
});

test('memory: 跨会话个人记忆全局可见、可按 source 过滤', () => {
  const db = openDatabase({ file: ':memory:', logger: () => {} });
  const mem = new MemoryStore({ db, logger: () => {} });
  mem.remember({ scope: 'global', ownerKey: null, topic: '主人偏好', fact: '主人不吃香菜', source: 'personal', confidence: 0.9 });
  mem.remember({ scope: 'global', ownerKey: null, topic: '想说', fact: '想问问大家周末去哪', source: 'thought', confidence: 0.5 });
  const personal = mem.list({ scope: 'global', source: 'personal' });
  assert.equal(personal.length, 1);
  assert.equal(personal[0].fact, '主人不吃香菜');
  assert.equal(mem.stats().personalCount, 1);
  // 个人记忆在任意会话的检索里都能命中（scope=global）。
  assert.ok(mem.search('不吃香菜', { ownerKey: 'group:9' }).some((f) => f.scope === 'global'));
  assert.ok(mem.search('不吃香菜', { ownerKey: 'private:1' }).some((f) => f.scope === 'global'));
  db.close();
});

test('time-awareness: 北京时间锚点、消息时间戳与矛盾检查', () => {
  const now = Date.parse('2026-10-27T08:54:00Z'); // 北京 16:54，下午
  const p = beijingParts(now);
  assert.equal(p.hour, 16);
  assert.equal(timeOfDayLabel(p.hour), '下午');
  assert.match(currentTimeBlock(now), /【现在】.*2026年10月27日.*16:54.*下午/);

  const msgAt = Date.parse('2026-10-27T01:44:00+08:00');
  assert.equal(timeStampCN(msgAt, now), '01:44', '同一天只显示时分');
  assert.equal(timeStampCN(Date.parse('2026-10-26T01:44:00+08:00'), now), '10月26日 01:44', '跨天带日期');

  assert.match(timeConflict('现在是早上，我刚醒', now), /但现在是下午/, '下午说现在是早上要被抓出来');
  assert.equal(timeConflict('现在是下午，我刚醒', now), '', '时间一致不报');
  assert.equal(timeConflict('今天早上发生的事', now), '', '过去的早上不误判');
  assert.equal(timeConflict('刚刚凌晨才睡', now), '写着“刚刚凌晨”，但现在是下午', '几小时前说刚刚凌晨也要抓');
});

test('time-awareness: 候选见闻带发布时间，避免把旧闻说成刚刚', () => {
  const text = formatCandidatesForPrompt([
    { source: 'bilibili', title: '测试视频', url: 'https://example.com/v', publishedAt: Date.parse('2026-10-27T02:00:00Z'), summary: '' }
  ]);
  assert.match(text, /发布于/);
  assert.match(text, /10月27日 10:00/);
});

test('qzone: 评论 HTML 解析出昵称/QQ/内容', () => {
  const html = '<ul class="comments-list"><li class="f-item f-comment" data-uin="12345"><div class="f-info"><a class="f-name q_namecard">小明</a>：好可爱啊</div><a href="javascript:;">回复</a></li></ul>';
  const list = parseQzoneComments(html);
  assert.equal(list.length, 1);
  assert.equal(list[0].uin, '12345');
  assert.equal(list[0].name, '小明');
  assert.equal(list[0].text, '好可爱啊');
  assert.deepEqual(parseQzoneComments('<div>没有评论</div>'), []);
});

test('session-map: 保存/读取/清理，db v2 表存在', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-stage2-'));
  const db = openDatabase({ file: path.join(dir, 'b.db'), logger: () => {} });
  assert.equal(db.get('SELECT MAX(version) AS v FROM schema_migrations').v, SCHEMA_VERSION);
  const map = new SessionMapStore({ db, logger: () => {} });
  map.saveAll({ 'group:1': 's1', 'private:2': 's2' }, { 'group:1': { preset: 'qq-chat' } });
  assert.equal(map.stats().keys, 2);
  assert.equal(map.get('group:1').policy.preset, 'qq-chat');
  map.saveAll({ 'group:1': 's1' });
  assert.equal(map.stats().keys, 1);
  assert.equal(map.loadAll()[0].key, 'group:1');
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

test('persona-mode: 深夜/疲惫/低落/轻快/平稳的时段与状态优先级', () => {
  const noon = Date.UTC(2026, 9, 1, 4, 0, 0); // 上海 12:00
  assert.equal(derivePersonaMode({ energy: 0.9, mood: { valence: 0.5 } }, { now: noon }).id, 'bright');
  assert.equal(derivePersonaMode({ energy: 0.2, mood: { valence: 0.5 } }, { now: noon }).id, 'tired');
  assert.equal(derivePersonaMode({ energy: 0.6, mood: { valence: -0.5 } }, { now: noon }).id, 'low');
  assert.equal(derivePersonaMode({ energy: 0.6, mood: { valence: 0.1 } }, { now: noon }).id, 'steady');
  const late = Date.UTC(2026, 9, 1, 15, 0, 0); // 上海 23:00
  assert.equal(derivePersonaMode({ energy: 0.9, mood: { valence: 0.5 } }, { now: late }).id, 'late');
  assert.equal(derivePersonaMode({ energy: 0.9, mood: { valence: 0.5 } }, { now: noon, quiet: true }).id, 'late');
  const text = renderPersonaMode(derivePersonaMode({ energy: 0.2 }, { now: noon }));
  assert.match(text, /^【当前状态】/);
  assert.ok(!/\d/.test(text), '语气指令不应把原始数值塞进 prompt');
});
