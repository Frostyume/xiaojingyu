import assert from 'node:assert/strict';
import {
  normalizePersonaState,
  applyReflectionV3,
  applyMoodNudge,
  applyReflection,
  decayValue,
  targetEnergyAt,
  moodTierLabel,
  chooseMoodLabel,
  MOOD_V3_DEFAULTS
} from '../src/persona-state.js';
import { summarizeMoodHistory } from '../src/core/mood-history.js';

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
  for (let i = 0; i < 2; i += 1) {
    const r = applyMoodNudge(s, { what: '事件' + i, intensity: 3, valence: 'positive', cause: 'c' + i }, { now: now + i * 1000, cfg: MOOD_V3_DEFAULTS });
    s = r.state;
  }
  const third = applyMoodNudge(s, { what: '第三个', intensity: 3, valence: 'positive', cause: 'c3' }, { now: now + 3000, cfg: MOOD_V3_DEFAULTS });
  assert.equal(third.status, 'limited');
});

console.log(`\n${passed} passed`);
