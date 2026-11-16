#!/usr/bin/env node
// 认知升级七模块回归：默认关闭不生效，开启后行为可验证。
// 覆盖：记忆强度、事实失效、水层召回、睡眠巩固、重逢、鱼的记忆、心情目标值限速。
import assert from 'node:assert/strict';
import {
  ExperienceStore,
  effectiveExperienceStrength,
  experienceKind,
  experienceSchemaExists,
  buildExperience
} from '../runtime/persona/cognition/experience.js';
import { buildContextTiers, classifyTier } from '../runtime/persona/cognition/context-tiers.js';
import {
  noteReunionInteraction,
  planReunion,
  reunionPromptLine
} from '../runtime/persona/cognition/reunion.js';
import { hintForTurn, conversationAnchor } from '../runtime/persona/cognition/fish-memory.js';
import {
  SleepConsolidator,
  sleepSchemaExists,
  nextSleepAt
} from '../runtime/persona/cognition/sleep-consolidation.js';
import { MemoryStore } from '../runtime/kernel/memory.js';
import { openDatabase } from '../runtime/kernel/db.js';
import { applyReflectionV3, defaultPersonaState, normalizePersonaState, MOOD_V3_DEFAULTS, previewPersonaState } from '../services/persona/persona-state.js';

const DAY = 24 * 3600 * 1000;
const HOUR = 3600 * 1000;
const now = Date.parse('2026-11-16T12:00:00+08:00');
const memDb = (label) => openDatabase({ file: ':memory:', logger: () => {} });

// ── 1. 记忆强度：类型半衰期、有效强度、重提加亮、弱记忆过滤 ─────────────
assert.equal(experienceKind({ valence: 'negative' }), 'conflict');
assert.equal(experienceKind({ outcome: 'resolved' }), 'milestone');
assert.equal(experienceKind({ topic: '心情' }), 'chat');
assert.equal(experienceKind({ topic: '闲聊' }), 'other');

const chat = { occurredAt: now - 3 * DAY, strength: 0.5, topic: '心情' };
const conflict = { occurredAt: now - 3 * DAY, strength: 0.5, valence: 'negative' };
assert(Math.abs(effectiveExperienceStrength(chat, { now }) - 0.25) < 1e-6, '普通聊天 3 天剩一半');
assert(effectiveExperienceStrength(conflict, { now }) > 0.45, '冲突 30 天半衰期，3 天后仍然很亮');

{
  const db = memDb('strength');
  const store = new ExperienceStore({ db, now: () => now, strength: { enabled: true }, minEffective: 0.15 });
  const first = store.record({ occurredAt: now - 2 * DAY, scopeKey: 'group:1', topic: '对话', summary: '一起看比赛', dedupeKey: 'k1' });
  assert(first.created, '首次写入应新建');
  const again = store.record({ occurredAt: now - 2 * DAY, scopeKey: 'group:1', topic: '对话', summary: '一起看比赛', dedupeKey: 'k1' });
  assert.equal(again.created, false);
  assert.equal(again.reinforced, true, '同键重提应加亮');
  assert(again.experience.strength > first.experience.strength, '强度必须上升');
  // 另一条很老的弱记忆：默认不进列表，includeWeak 才可见。
  const weak = store.record({ occurredAt: now - 40 * DAY, scopeKey: 'group:1', topic: '对话', summary: '很久以前的小事', dedupeKey: 'k2' });
  db.run('UPDATE cognition_experiences SET strength = 0.01 WHERE id = ?', weak.experience.id);
  const visible = store.list({ scopeKey: 'group:1', now, limit: 10 });
  assert(visible.every((item) => item.id !== weak.experience.id), '弱记忆默认隐藏');
  const all = store.list({ scopeKey: 'group:1', now, limit: 10, includeWeak: true });
  assert(all.some((item) => item.id === weak.experience.id), 'includeWeak 仍可诊断');
  assert(all[0].effectiveStrength >= all[all.length - 1].effectiveStrength, '按有效强度排序');

  // 关闭强度：保留在列表里，不加亮。
  const off = new ExperienceStore({ db: memDb('strength-off'), now: () => now, strength: { enabled: false } });
  const a = off.record({ occurredAt: now, summary: 'a', dedupeKey: 'off1' });
  const b = off.record({ occurredAt: now, summary: 'a', dedupeKey: 'off1' });
  assert.equal(b.reinforced, undefined, '关闭时不加亮');
  assert.equal(b.experience.strength, a.experience.strength, '关闭时强度不变');
  assert.equal(experienceSchemaExists(memDb('empty')), false, '全关时不建表');
  console.log('OK 记忆强度');
}

// ── 2. 事实失效不删除：valid_to + as-of 回看 ────────────────────────────
{
  const db = memDb('invalidation');
  const store = new MemoryStore({ db, now: () => now, invalidation: { enabled: true } });
  const t1 = Date.parse('2026-10-01T10:00:00+08:00');
  store.remember({ scope: 'member', ownerKey: 'private:1', topic: '喜好', fact: '喜欢奶茶', confidence: 0.9 });
  // now() 固定，用有效时间列模拟“后来改了说法”。
  db.run('UPDATE memory_facts SET valid_from = ?, created_at = ?', t1, t1);
  const tea = db.get("SELECT * FROM memory_facts WHERE fact = '喜欢奶茶'");
  store.remember({ scope: 'member', ownerKey: 'private:1', topic: '喜好', fact: '喜欢咖啡', confidence: 0.9 });
  const old = db.get('SELECT * FROM memory_facts WHERE id = ?', tea.id);
  assert(old.valid_to !== null && old.valid_to !== undefined, '旧事实必须写 valid_to');
  assert.equal(old.fact, '喜欢奶茶', '旧正文不能被覆盖');
  const current = store.list({ scope: 'member', ownerKey: 'private:1', limit: 10 });
  assert.deepEqual(current.map((f) => f.fact), ['喜欢咖啡'], '默认只看有效行');
  const past = store.list({ scope: 'member', ownerKey: 'private:1', limit: 10, asOf: t1 + 1000 });
  assert.deepEqual(past.map((f) => f.fact), ['喜欢奶茶'], 'asOf 能回看当时为真的事实');
  // 旧说法被重新写入：恢复有效。
  store.remember({ scope: 'member', ownerKey: 'private:1', topic: '喜好', fact: '喜欢奶茶', confidence: 0.9 });
  const restored = db.get("SELECT * FROM memory_facts WHERE fact = '喜欢奶茶'");
  assert.equal(restored.valid_to, null, '重新写入应恢复有效');

  // 关闭：不加列、不失效，两条都可见（旧行为）。
  const offDb = memDb('invalidation-off');
  const off = new MemoryStore({ db: offDb });
  off.remember({ scope: 'member', ownerKey: 'private:1', topic: '喜好', fact: '喜欢奶茶' });
  off.remember({ scope: 'member', ownerKey: 'private:1', topic: '喜好', fact: '喜欢咖啡' });
  const cols = offDb.all('PRAGMA table_info(memory_facts)').map((c) => c.name);
  assert.equal(cols.includes('valid_to'), false, '关闭时不加有效时间列');
  assert.equal(off.list({ scope: 'member', ownerKey: 'private:1', limit: 10 }).length, 2, '关闭时冲突事实都保留');
  console.log('OK 事实失效');
}

// ── 3. 水层召回：分层、配额、先摘要后展开 ───────────────────────────────
{
  assert.equal(classifyTier(now - HOUR, now), 'surface');
  assert.equal(classifyTier(now - 5 * DAY, now), 'thermocline');
  assert.equal(classifyTier(now - 60 * DAY, now), 'deep');
  const messages = Array.from({ length: 6 }, (_, i) => ({
    time: now - (6 - i) * 60 * 1000,
    isSelf: i % 2 === 0,
    plain: `第 ${i + 1} 句闲聊内容`
  }));
  const experiences = [
    { occurredAt: now - 2 * DAY, summary: '一起看比赛', effectiveStrength: 0.8 },
    { occurredAt: now - 10 * DAY, summary: '聊到喜欢的书', effectiveStrength: 0.4 }
  ];
  const tiered = buildContextTiers({ recentMessages: messages, experiences, deep: '她最近常熬夜。', now, level: 'L1' });
  assert.equal(tiered.counts.surface, 6);
  assert.equal(tiered.counts.thermocline, 2);
  assert.match(tiered.text, /【表层/);
  assert.match(tiered.text, /【温跃层/);
  assert.match(tiered.text, /【深海/);
  assert(tiered.levels.surface.L2.length >= 1, 'L2 原文单独存着，不默认渲染');
  assert(!tiered.text.includes('最近 6 条消息'), 'L1 不包含 L0 摘要行');
  const l0 = buildContextTiers({ recentMessages: messages, experiences, now, level: 'L0' });
  assert(l0.text.length < tiered.text.length || l0.text.includes('最近'), 'L0 更短，只给摘要');
  console.log('OK 水层召回');
}

// ── 4. 睡眠巩固：关闭零痕迹、开启只观察、删除只提案 ─────────────────────
{
  const offDb = memDb('sleep-off');
  const off = new SleepConsolidator({ db: offDb, config: { enabled: false } });
  const offResult = await off.run({ now });
  assert.equal(offResult.reason, 'disabled');
  assert.equal(sleepSchemaExists(offDb), false, '关闭时不建任何认知表');

  const db = memDb('sleep-on');
  const store = new ExperienceStore({ db, now: () => now, strength: { enabled: true } });
  const old = store.record({ occurredAt: now - 200 * DAY, scopeKey: 'group:1', topic: '闲聊', summary: '很久以前的一次闲聊', dedupeKey: 'old' });
  db.run('UPDATE cognition_experiences SET strength = 0.01 WHERE id = ?', old.experience.id);
  const consolidator = new SleepConsolidator({
    db,
    now: () => now,
    config: { enabled: true, maxEpisodes: 20, maxLlmCalls: 0, forgetBelow: 0.05, maxProposals: 5 }
  });
  const result = await consolidator.run({ now, reason: 'sleep' });
  assert.equal(result.done, true);
  assert.equal(result.processed, 1);
  assert.equal(result.observations, 1, '产出可追溯观察');
  assert.equal(result.proposals, 1, '弱且超保留期 → 只出提案');
  assert(store.get(old.experience.id), '提案阶段绝不删除经历');
  const observations = consolidator.listObservations({ limit: 10 });
  assert.equal(observations.length, 1);
  assert.equal(observations[0].quote, '很久以前的一次闲聊', '观察保留原话证据');
  const [proposal] = consolidator.listPendingProposals();
  assert(proposal && proposal.targetKind === 'experience');
  // 幂等：同批重跑不重复产出（此时经历还在）。
  const rerun = await consolidator.run({ now: now + 1000, reason: 'sleep' });
  assert.equal(rerun.processed, 0, 'observed_at 标记避免重复整理');
  const approve = consolidator.decideProposal({ id: proposal.id, decision: 'approve' });
  assert.equal(approve.ok, true);
  assert.equal(store.get(old.experience.id), null, '只有显式审批才删除');
  assert(nextSleepAt(Date.parse('2026-11-16T03:59:00+08:00'), 4) > Date.parse('2026-11-16T03:59:00+08:00'));
  console.log('OK 睡眠巩固');
}

// ── 5. 重逢唤醒：久别一次、冷却限频、关闭不查询 ─────────────────────────
{
  const last = now - 9 * DAY;
  const episodes = [{ occurredAt: last - DAY, summary: '一起熬夜看比赛', valence: 'positive', effectiveStrength: 0.7 }];
  const plan = planReunion({ lastInteractionAt: last, now, episodes });
  assert(plan && plan.gapDays === 9, '应识别久别天数');
  assert.match(plan.hint, /一起熬夜看比赛/);
  const tooSoon = planReunion({ lastInteractionAt: now - 2 * DAY, now, episodes });
  assert.equal(tooSoon, null, '没到门槛不提示');
  const cooled = planReunion({ lastInteractionAt: last, now, episodes, lastReunionAt: now - HOUR });
  assert.equal(cooled, null, '冷却期内不重复');

  const cycles = new Map();
  const cycleA = noteReunionInteraction(cycles, { key: 'private:1', userId: '1', priorLastInteractionAt: now - 8 * DAY, now });
  const cycle = noteReunionInteraction(cycles, { key: 'private:1', userId: '2', priorLastInteractionAt: now - 8 * DAY, now });
  assert(cycleA && cycle && cycleA.anchor === now - 8 * DAY);
  assert.equal(cycles.size, 2, 'store 键按 key+user 分开');
  let loaded = 0;
  const closed = reunionPromptLine({ enabled: false, cycle, now, loadEpisodes: () => { loaded += 1; return episodes; } });
  assert.equal(closed, '', '关闭时返回空串');
  assert.equal(loaded, 0, '关闭时不得触发经历查询');
  const opened = reunionPromptLine({ enabled: true, cycle, now, episodes });
  assert.match(opened, /【重逢】/);
  assert.match(reunionPromptLine({ enabled: true, cycle, now: now + 1000, episodes }), /^$/, '同一轮只提示一次');
  console.log('OK 重逢唤醒');
}

// ── 6. 鱼的记忆：极低频、吵架/必回不触发、关闭不触发 ─────────────────────
{
  const messages = [
    { time: now - 4 * 60 * 1000, isSelf: false, plain: '在吗' },
    { time: now - 3 * 60 * 1000, isSelf: true, plain: '在的' },
    { time: now - 60 * 1000, isSelf: false, plain: '今天吃了什么' }
  ];
  assert.equal(conversationAnchor(messages, now), messages[0].time, '会话锚点应是沉默后的第一条');
  const baseFlags = { enabled: true, mustReply: false, random: 0.01 };
  assert.equal(hintForTurn({ now, messages, flags: { ...baseFlags, enabled: false } }), null, '关闭时不出提示');
  assert.equal(hintForTurn({ now, messages, flags: { ...baseFlags, mustReply: true } }), null, '必回消息不卖萌');
  assert.match(hintForTurn({ now, messages, flags: baseFlags }), /小小走神/);
  assert.equal(hintForTurn({ now, messages, flags: { ...baseFlags, random: 0.9 } }), null, '概率之外不触发');
  const conflict = messages.map((m, i) => (i === messages.length - 1 ? { ...m, plain: '别烦我 滚' } : m));
  assert.equal(hintForTurn({ now, messages: conflict, flags: baseFlags }), null, '冲突现场不触发');
  console.log('OK 鱼的记忆');
}

// ── 7. 心情目标值限速：先定目标再追、关闭走旧逻辑 ───────────────────────
{
  const t0 = Date.parse('2026-11-16T09:00:00+08:00');
  const base = defaultPersonaState(t0);
  const event = {
    events: [{ what: '被夸', type: 'praise', intensity: 5, valence: 'positive', sourceKey: 'group:1' }],
    moodCause: '被夸'
  };
  const driftCfg = { ...MOOD_V3_DEFAULTS, moodDrift: { ...MOOD_V3_DEFAULTS.moodDrift, enabled: true } };
  const first = applyReflectionV3(base, event, { now: t0 + 1000, cfg: driftCfg }).state;
  assert(Math.abs(first.mood.target - base.mood.target) < 1e-9, '第一次同源事件只进待定，不改目标');
  const second = applyReflectionV3(first, event, { now: t0 + 2000, cfg: driftCfg }).state;
  assert(second.mood.target > first.mood.target, '窗口内第二次才改目标');
  assert(second.mood.valence - first.mood.valence < 0.001, '现值只能按每小时速率追，不能一步跳');
  const later = previewPersonaState(second, { now: t0 + 2 * HOUR, cfg: driftCfg });
  assert(later.mood.valence > second.mood.valence, '时间推进后向目标靠近');
  const normalized = normalizePersonaState(JSON.parse(JSON.stringify(second)), t0 + 3000);
  assert.equal(normalized.mood.target, second.mood.target, '目标值必须持久化');

  const old = applyReflectionV3(base, event, { now: t0 + 1000, cfg: MOOD_V3_DEFAULTS }).state;
  assert(old.mood.valence > base.mood.valence + 0.05, '关闭时事件直接改现值（旧逻辑）');
  assert.equal(old.mood.target, base.mood.target, '关闭时目标值不参与');
  console.log('OK 心情目标值限速');
}

console.log('OK 认知升级七模块');