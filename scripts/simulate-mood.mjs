#!/usr/bin/env node
// 30 天离线模拟：不写线上状态，只验证 mood v3 的幅度、恢复和下游模式。
// 用法：node scripts/simulate-mood.mjs [out.html]

import fs from 'node:fs';
import { applyReflectionV3, normalizePersonaState, MOOD_V3_DEFAULTS } from '../src/persona-state.js';
import { derivePersonaMode } from '../src/core/persona-mode.js';

const out = process.argv[2] || '';
const day = 24 * 3600 * 1000;
const start = Date.now() - 30 * day;
let state = normalizePersonaState({ version: 2, mood: { valence: 0.08, arousal: 0.44, setPoint: 0.08, lastDecayAt: start }, energy: 0.58 }, start);
const history = [];

const plans = {
  2: [{ what: '主人夸声音', intensity: 4, valence: 'positive', arousal: 'up', cause: '被夸' }],
  3: [{ what: '分享被接梗', intensity: 3, valence: 'positive', arousal: 'up', cause: '分享有人接' }],
  5: [{ what: '比赛赢了', intensity: 4, valence: 'positive', arousal: 'up', cause: '赢了' }],
  8: [{ what: '被误解', intensity: 3, valence: 'negative', arousal: 'up', cause: '被误解' }],
  11: [{ what: '群里 spam', intensity: 2, valence: 'negative', arousal: 'up', cause: '被刷屏' }],
  12: [{ what: '被冷落', intensity: 2, valence: 'negative', arousal: 'down', cause: '没人接话' }],
  13: [{ what: '又被凶', intensity: 3, valence: 'negative', arousal: 'up', cause: '被凶' }],
  14: [{ what: '主人来哄', intensity: 4, valence: 'positive', arousal: 'up', cause: '被哄' }],
  17: [{ what: '熬夜聊天', intensity: 3, valence: 'positive', arousal: 'up', cause: '聊得开心' }],
  20: [{ what: '猫咪视频', intensity: 3, valence: 'positive', arousal: 'up', cause: '猫' }],
  24: [{ what: '分享成功', intensity: 3, valence: 'positive', arousal: 'up', cause: '被接住' }]
};

for (let d = 0; d < 30; d += 1) {
  for (const hour of [1, 8, 14, 20]) {
    const now = start + d * day + hour * 3600e3;
    const events = hour === 14 ? (plans[d] || []) : [];
    const energy = hour === 1 && (d === 17 || d === 18) ? { direction: 'down', intensity: 3 } : { direction: 'up', intensity: 1 };
    const r = applyReflectionV3(state, {
      events,
      energy,
      moodCause: events[0]?.cause || '',
      interests: d === 20 ? [{ topic: '猫', delta: 0.1 }] : []
    }, { now, cfg: MOOD_V3_DEFAULTS, rested: hour === 8 });
    state = r.state;
    const mode = derivePersonaMode(state, { now, quiet: false });
    history.push({
      at: now,
      v: state.mood.valence,
      a: state.mood.arousal,
      e: state.energy,
      mode: mode.id,
      cause: state.mood.cause,
      events: events.length
    });
  }
}

const byDay = new Map();
for (const h of history) {
  const key = Math.floor((h.at - start) / day);
  if (!byDay.has(key)) byDay.set(key, []);
  byDay.get(key).push(h);
}
const spans = [...byDay.values()].map((list) => Math.max(...list.map((x) => x.v)) - Math.min(...list.map((x) => x.v)));
const last7 = history.slice(-28);
const last7span = Math.max(...last7.map((x) => x.v)) - Math.min(...last7.map((x) => x.v));
const modeCounts = history.reduce((m, x) => (m[x.mode] = (m[x.mode] || 0) + 1, m), {});
const caused = history.filter((x) => x.cause).length;
const bigJumps = history.filter((x) => Math.abs(x.v - (history[history.indexOf(x) - 1]?.v || x.v)) > 0.32).length;

console.log(JSON.stringify({
  points: history.length,
  last7span: Number(last7span.toFixed(3)),
  maxDaySpan: Number(Math.max(...spans).toFixed(3)),
  modeCounts,
  causeCoverage: Number((caused / history.length).toFixed(3)),
  bigJumps,
  final: { v: Number(state.mood.valence.toFixed(3)), a: Number(state.mood.arousal.toFixed(3)), e: Number(state.energy.toFixed(3)), label: state.mood.label, setPoint: Number(state.mood.setPoint.toFixed(3)) }
}, null, 2));

if (out) {
  const w = 900, h = 260;
  const pts = history.map((x, i) => `${((i / (history.length - 1)) * w).toFixed(1)},${((1 - (x.v + 1) / 2) * h).toFixed(1)}`).join(' ');
  fs.writeFileSync(out, `<!doctype html><meta charset=utf-8><title>mood v3 sim</title><body style="background:#12151c;color:#e8ecf4;font:14px system-ui"><h2>30-day mood v3 simulation</h2><svg viewBox="0 0 ${w} ${h}" style="width:100%;height:280px;background:#1a1f2a"><polyline points="${pts}" fill="none" stroke="#fbbf24" stroke-width="2"/></svg><pre>${JSON.stringify({ last7span, maxDaySpan: Math.max(...spans), modeCounts, causeCoverage: caused / history.length, bigJumps, final: state.mood }, null, 2)}</pre></body>`);
}
