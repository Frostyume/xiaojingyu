import assert from 'node:assert/strict';
import {
  normalizePersonaState,
  applyReflectionV3,
  applyMoodNudge,
  applyReflection,
  decayValue,
  targetEnergyAt,
  previewPersonaState,
  moodTierLabel,
  chooseMoodLabel,
  renderPersonaStateBlock,
  MOOD_V3_DEFAULTS
} from '../services/persona/persona-state.js';
import { summarizeMoodHistory } from '../runtime/persona/mood-history.js';
import { classifyMoodEvent, collectAutoMoodEvents } from '../runtime/persona/mood-events.js';
import { beijingParts } from '../runtime/kernel/time-awareness.js';

const now = Date.now();
let passed = 0;
function ok(name, fn) {
  try { fn(); passed += 1; console.log(`✔ ${name}`); }
  catch (e) { console.error(`✖ ${name}: ${e.message}`); process.exitCode = 1; }
}

ok('v1 迁移补齐 setPoint/lastDecayAt', () => {
  const s = normalizePersonaState({ version: 1, mood: { valence: 0.248, arousal: 0.43 }, energy: 0.5, updatedAt: now - 1000 }, now);
  assert.equal(s.version, 2);
  assert.ok(s.mood.setPoint > 0.08 && s.mood.setPoint < 0.2);
  assert.equal(s.mood.lastDecayAt, now - 1000);
});

ok('半衰期衰减', () => {
  assert.ok(Math.abs(decayValue(1, 0, 30 * 3600e3, 30 * 3600e3) - 0.5) < 1e-9);
  assert.ok(Math.abs(decayValue(1, 0, 30 * 3600e3, 60 * 3600e3) - 0.25) < 1e-9);
});

ok('正向强度 5 单次不超过 0.30', () => {
  const s = normalizePersonaState({ version: 2, mood: { valence: 0.08, arousal: 0.45, setPoint: 0.08, lastDecayAt: now }, energy: 0.5 }, now);
  const r = applyReflectionV3(s, { events: [{ what: '大惊喜', intensity: 5, valence: 'positive', arousal: 'up', cause: '惊喜' }] }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.ok(r.meta.delta.v <= 0.3001, `delta=${r.meta.delta.v}`);
});

ok('负向强度 5 仍受 0.30 上限', () => {
  const s = normalizePersonaState({ version: 2, mood: { valence: 0.2, arousal: 0.4, setPoint: 0.1, lastDecayAt: now }, energy: 0.5 }, now);
  const r = applyReflectionV3(s, { events: [{ what: '强冲突', intensity: 5, valence: 'negative', arousal: 'up', cause: '冲突' }] }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.ok(r.meta.delta.v >= -0.32, `delta=${r.meta.delta.v}`);
});

ok('每小时净变化被压缩', () => {
  const s = normalizePersonaState({ version: 2, mood: { valence: 0.0, arousal: 0.4, setPoint: 0.08, lastDecayAt: now }, energy: 0.5 }, now);
  const r = applyReflectionV3(s, {
    events: [
      { what: 'a', intensity: 5, valence: 'positive', arousal: 'none', cause: 'a' },
      { what: 'b', intensity: 5, valence: 'positive', arousal: 'none', cause: 'b' },
      { what: 'c', intensity: 5, valence: 'positive', arousal: 'none', cause: 'c' }
    ]
  }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.ok(r.meta.delta.v <= MOOD_V3_DEFAULTS.budgets.maxHour + 1e-9, `delta=${r.meta.delta.v}`);
});

ok('模型标签越档时回退系统档位', () => {
  const good = chooseMoodLabel(0.6, 0.3, '开心得飘起来');
  assert.equal(good.label, '开心得飘起来');
  const bad = chooseMoodLabel(0.6, 0.3, '有点低落');
  assert.equal(bad.label, moodTierLabel(0.6, 0.3));
});

ok('旧格式 mood 小数仍可用并标记 legacy', () => {
  const s = normalizePersonaState({ version: 2, mood: { valence: 0.1, arousal: 0.4, setPoint: 0.1, lastDecayAt: now }, energy: 0.5 }, now);
  const r = applyReflectionV3(s, { mood: { valence: 0.12, arousal: 0.1 } }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.equal(r.meta.source, 'legacy');
  assert.ok(r.state.mood.valence > 0.1);
});

ok('精力目标在 0.30–0.75', () => {
  for (const h of [0, 3, 6, 9, 12, 15, 18, 21, 23]) {
    const d = new Date(now);
    d.setHours(h, 0, 0, 0);
    const e = targetEnergyAt(d.getTime());
    assert.ok(e >= 0.30 && e <= 0.75, `hour ${h} energy ${e}`);
  }
});

ok('读取态按真实时间预览恢复，不写回原对象', () => {
  const at = new Date('2026-11-04T10:08:00+08:00').getTime();
  const stored = normalizePersonaState({
    version: 2,
    mood: { valence: 0.04, arousal: 0.31, setPoint: 0.1, lastDecayAt: at },
    energy: 0.2946,
    updatedAt: at
  }, at);
  const preview = previewPersonaState(stored, { now: at + 4.3 * 3600e3, cfg: MOOD_V3_DEFAULTS });
  assert.ok(preview.energy > 0.38, `preview energy=${preview.energy}`);
  assert.ok(preview.energy > stored.energy);
  assert.equal(stored.energy, 0.2946, '预览不能改持久化状态');
});

ok('v1 兼容路径仍限制 ±0.15', () => {
  const s = normalizePersonaState({ version: 2, mood: { valence: 0.1, arousal: 0.4, setPoint: 0.1, lastDecayAt: now }, energy: 0.5 }, now);
  const decayed = s.mood.valence + (0.15 - s.mood.valence) * 0.2;
  const r = applyReflection(s, { mood: { valence: 0.9 } }, now);
  assert.ok(Math.abs(r.state.mood.valence - (decayed + 0.15)) <= 1e-9);
});

ok('历史摘要能算跨度与原因覆盖率', () => {
  const entries = [
    { at: now - 3600e3, before: { v: 0.1, a: 0.4, e: 0.5 }, after: { v: 0.2, a: 0.5, e: 0.5 }, delta: { v: 0.1 }, cause: '被夸', mode: 'steady' },
    { at: now - 1800e3, before: { v: 0.2, a: 0.5, e: 0.5 }, after: { v: -0.1, a: 0.6, e: 0.5 }, delta: { v: -0.3 }, cause: '', mode: 'low' }
  ];
  const s = summarizeMoodHistory(entries, { now, state: normalizePersonaState({ version: 2, mood: { valence: -0.1, arousal: 0.6, setPoint: 0.1, lastDecayAt: now }, energy: 0.5 }, now) });
  assert.ok(s.span7dV >= 0.29);
  assert.equal(s.causeCoverage, 0.5);
});

ok('即时事件：弱事件拒绝', () => {
  const s = normalizePersonaState({ version: 2, mood: { valence: 0.1, arousal: 0.4, setPoint: 0.1, lastDecayAt: now }, energy: 0.5 }, now);
  const r = applyMoodNudge(s, { what: '普通接话', intensity: 2, valence: 'positive', cause: '接话' }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.equal(r.status, 'weak');
});

ok('即时事件：强度 4 生效且去重', () => {
  const s = normalizePersonaState({ version: 2, mood: { valence: 0.1, arousal: 0.4, setPoint: 0.1, lastDecayAt: now }, energy: 0.5 }, now);
  const r = applyMoodNudge(s, { what: '被认真夸', intensity: 4, valence: 'positive', arousal: 'up', cause: '被夸', sourceMessageId: 99 }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.equal(r.status, 'ok');
  assert.ok(r.state.mood.valence > s.mood.valence);
  const again = applyMoodNudge(r.state, { what: '被认真夸', intensity: 4, valence: 'positive', arousal: 'up', cause: '被夸', sourceMessageId: 99 }, { now: now + 1000, cfg: MOOD_V3_DEFAULTS });
  assert.equal(again.status, 'duplicate');
});

ok('即时事件：每小时限额', () => {
  let s = normalizePersonaState({ version: 2, mood: { valence: 0.1, arousal: 0.4, setPoint: 0.1, lastDecayAt: now }, energy: 0.5 }, now);
  for (let i = 0; i < MOOD_V3_DEFAULTS.eventNudge.maxPerHour; i += 1) {
    const r = applyMoodNudge(s, { what: '事件' + i, intensity: 3, valence: 'positive', cause: 'c' + i }, { now: now + i * 1000, cfg: MOOD_V3_DEFAULTS });
    assert.equal(r.status, 'ok');
    s = r.state;
  }
  const next = applyMoodNudge(s, { what: '超额事件', intensity: 3, valence: 'positive', cause: 'c-over' }, { now: now + 3000, cfg: MOOD_V3_DEFAULTS });
  assert.equal(next.status, 'limited');
});

function moodState(moodPatch = {}, extra = {}) {
  const p = beijingParts(now);
  return normalizePersonaState({
    version: 2,
    mood: {
      valence: 0.1,
      arousal: 0.4,
      setPoint: 0.1,
      lastDecayAt: now,
      budget: {
        hourKey: `${p.dateKey}-${String(p.hour).padStart(2, '0')}`,
        hourUp: 0,
        hourDown: 0,
        hourTypes: {},
        dayKey: p.dateKey,
        dayUp: 0,
        dayDown: 0,
        dayTypes: {}
      },
      ...moodPatch
    },
    energy: 0.5,
    ...extra
  }, now);
}

function badMood({ hours = 12, valence = -0.75, setPoint = 0.15, lastNegativeAt = null } = {}) {
  return normalizePersonaState({
    version: 2,
    mood: {
      valence,
      arousal: 0.52,
      setPoint,
      lastDecayAt: now - hours * 3600e3,
      lastNegativeAt: lastNegativeAt == null ? now - hours * 3600e3 : lastNegativeAt
    },
    energy: 0.45
  }, now);
}

ok('负向 -0.75 无新事件：12h 后明显回落', () => {
  const r = applyReflectionV3(badMood({ hours: 12 }), { events: [] }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.ok(r.state.mood.valence >= -0.30, `valence=${r.state.mood.valence}`);
});

ok('负向 -0.75 无新事件：24h 后回到接近基线', () => {
  const r = applyReflectionV3(badMood({ hours: 24 }), { events: [] }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.ok(r.state.mood.valence >= -0.10, `valence=${r.state.mood.valence}`);
});

ok('刚发生负面事件时不会立刻抖回基线', () => {
  const r = applyReflectionV3(badMood({ hours: 1, lastNegativeAt: now - 3600e3 }), { events: [] }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.ok(r.state.mood.valence < -0.50, `valence=${r.state.mood.valence}`);
});

ok('恢复切换点（2h）数值连续', () => {
  const a = applyReflectionV3(badMood({ hours: 119 / 60 }), { events: [] }, { now, cfg: MOOD_V3_DEFAULTS });
  const b = applyReflectionV3(badMood({ hours: 121 / 60 }), { events: [] }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.ok(Math.abs(a.state.mood.valence - b.state.mood.valence) < 0.02,
    `${a.state.mood.valence} vs ${b.state.mood.valence}`);
});

ok('负向额度满时，正向事件仍有可观测正 delta', () => {
  const s = moodState({
    valence: -0.6,
    lastNegativeAt: now,
    budget: {
      hourKey: `${beijingParts(now).dateKey}-${String(beijingParts(now).hour).padStart(2, '0')}`,
      hourUp: 0, hourDown: 0.35, hourTypes: {},
      dayKey: beijingParts(now).dateKey,
      dayUp: 0, dayDown: 0.6, dayTypes: {}
    }
  });
  const r = applyMoodNudge(s, { what: '被认真夸', type: 'praise', intensity: 4, valence: 'positive', cause: '被夸' }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.equal(r.status, 'ok');
  assert.ok(r.meta.applied.v > 0.02, `applied=${r.meta.applied.v}`);
  assert.ok(r.state.mood.valence > s.mood.valence);
});

ok('事件类型影响精力：冲突下降、安慰回升', () => {
  const drop = applyMoodNudge(moodState({ valence: 0 }), { what: '冲突', type: 'conflict', intensity: 4, valence: 'negative' }, { now, cfg: MOOD_V3_DEFAULTS });
  const rise = applyMoodNudge(moodState({ valence: 0 }), { what: '安慰', type: 'comfort', intensity: 4, valence: 'positive' }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.ok(drop.state.energy < 0.5, `conflict energy=${drop.state.energy}`);
  assert.ok(rise.state.energy > 0.5, `comfort energy=${rise.state.energy}`);
});

ok('cause 有 TTL，过期后清空', () => {
  const s = normalizePersonaState({
    version: 2,
    mood: { valence: -0.4, arousal: 0.5, setPoint: 0.1, cause: '被挑毛病', causeAt: now - 13 * 3600e3, lastDecayAt: now },
    energy: 0.5
  }, now);
  const r = applyReflectionV3(s, { events: [] }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.equal(r.state.mood.cause, '');
  assert.equal(r.state.mood.causeAt, 0);
});

ok('状态块会提示最近一次实际变化', () => {
  const s = moodState({ valence: 0, lastChange: { at: now - 60e3, dv: 0.08, da: 0, de: 0.03, source: 'nudge' } });
  const block = renderPersonaStateBlock(s);
  assert.ok(block.includes('最近一次状态变化'), block);
});

ok('@自己/名字直呼的夸会自动归类', () => {
  const hit = classifyMoodEvent({ text: '小鲸鱼真可爱', isAt: true, sourceMessageId: 'g:1', receivedAt: now });
  assert.equal(hit?.type, 'praise');
  const named = classifyMoodEvent({ text: '小鲸鱼好棒', namedSelf: true, sourceMessageId: 'g:2', receivedAt: now });
  assert.equal(named?.type, 'praise');
});

ok('私聊里的夸/安慰会触发，普通闲聊不触发', () => {
  const praise = classifyMoodEvent({ text: '你好可爱', isPrivate: true, sourceMessageId: 'p:1', receivedAt: now });
  assert.equal(praise?.type, 'praise');
  const comfort = classifyMoodEvent({ text: '别难过，抱抱', isPrivate: true, sourceMessageId: 'p:2', receivedAt: now });
  assert.equal(comfort?.type, 'comfort');
  const plain = classifyMoodEvent({ text: '今天下雨了', isPrivate: true, sourceMessageId: 'p:3', receivedAt: now });
  assert.equal(plain, null);
});

ok('不是冲她说的普通群聊不触发', () => {
  assert.equal(classifyMoodEvent({ text: '今天下雨了', directed: false }), null);
  assert.equal(classifyMoodEvent({ text: '今天下雨了', directed: true }), null);
});

ok('collectAutoMoodEvents 只收明显事件并跳过我自己的消息', () => {
  const events = collectAutoMoodEvents([
    { isSelf: false, messageId: '1', atSelf: true, text: '小鲸鱼真可爱', time: now },
    { isSelf: false, messageId: '2', text: '今天下雨', time: now + 1 },
    { isSelf: true, messageId: '3', text: '你真好', time: now + 2 },
    { isSelf: false, messageId: '4', directed: true, text: '小鲸鱼好棒', time: now + 3 }
  ], { key: 'group:1', since: now - 1000 });
  assert.equal(events.length, 2, JSON.stringify(events));
  assert.ok(events.every((e) => e.type === 'praise'));
});

ok('自动事件按 sourceMessageId 去重', () => {
  const event = classifyMoodEvent({ text: '小鲸鱼真可爱', directed: true, sourceMessageId: 'g:100', receivedAt: now });
  const s = moodState();
  const first = applyMoodNudge(s, event, { now, cfg: MOOD_V3_DEFAULTS });
  assert.equal(first.status, 'ok');
  const again = applyMoodNudge(first.state, event, { now: now + 1000, cfg: MOOD_V3_DEFAULTS });
  assert.equal(again.status, 'duplicate');
});

ok('模型手动 nudge 与自动事件共用 messageId 去重', () => {
  const event = classifyMoodEvent({ text: '小鲸鱼真可爱', directed: true, sourceMessageId: 'g:101', receivedAt: now });
  const s = moodState();
  const manual = applyMoodNudge(s, { what: '被夸', type: 'praise', intensity: 4, valence: 'positive', cause: '被夸', sourceMessageId: 'g:101' }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.equal(manual.status, 'ok');
  const auto = applyMoodNudge(manual.state, event, { now: now + 500, cfg: MOOD_V3_DEFAULTS });
  assert.equal(auto.status, 'duplicate');
});

ok('自动事件幅度明显小于模型手动提交', () => {
  const s = moodState();
  const manual = applyMoodNudge(s, { what: '被夸', type: 'praise', intensity: 3, valence: 'positive', cause: '被夸' }, { now, cfg: MOOD_V3_DEFAULTS });
  const autoEvent = classifyMoodEvent({ text: '小鲸鱼真可爱', directed: true, sourceMessageId: 'g:102', receivedAt: now });
  const auto = applyMoodNudge(s, autoEvent, { now, cfg: MOOD_V3_DEFAULTS });
  assert.ok(auto.meta.applied.v > 0);
  assert.ok(auto.meta.applied.v < manual.meta.applied.v * 0.75, `auto=${auto.meta.applied.v} manual=${manual.meta.applied.v}`);
});

ok('自动事件有每小时上限', () => {
  const s = moodState();
  const first = applyMoodNudge(s, { type: 'praise', what: '被夸', valence: 'positive', intensity: 3, auto: true, sourceMessageId: 'g:201' }, { now, cfg: MOOD_V3_DEFAULTS });
  assert.equal(first.status, 'ok');
  const second = applyMoodNudge(first.state, { type: 'praise', what: '被夸', valence: 'positive', intensity: 3, auto: true, sourceMessageId: 'g:202' }, { now: now + 1000, cfg: MOOD_V3_DEFAULTS });
  assert.equal(second.status, 'limited');
});

console.log(`\n${passed} passed`);
