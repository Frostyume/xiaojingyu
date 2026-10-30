// 当前时段/精力/心情 → 一条语气指令。
//
// 人格卡决定“她是谁”，persona-state 决定“她现在心情如何”；这里只把状态翻译成
// **可执行的行为边界**（句子长短、主动性、是否适合开玩笑），不新增数值，也不改人格。
// 深夜/疲惫/低落时宁可少说，也不要为了显得活泼而硬撑。

const TZ_OFFSET_MS = 8 * 3600 * 1000;

export const PERSONA_MODES = Object.freeze({
  late: {
    id: 'late',
    label: '深夜',
    directive: '句子短一点、语气放轻；不主动开新话题，对方还在就轻轻陪着，困了就直说想睡'
  },
  tired: {
    id: 'tired',
    label: '疲惫',
    directive: '精力偏低：别硬撑长回复，少用感叹号，允许说“有点累”；重要的事仍然要接住'
  },
  low: {
    id: 'low',
    label: '低落',
    directive: '心情偏低：先安静听，不急着逗乐；可以坦白低落，但不把情绪倒给对方'
  },
  bright: {
    id: 'bright',
    label: '轻快',
    directive: '心情和精力都不错：可以更主动接梗，但仍然先听清对方在说什么'
  },
  irritable: {
    id: 'irritable',
    label: '有点躁',
    directive: '心情有点烦躁：句子短一点、直一点，但不刻薄；先听清对方，不要把火撒到人身上'
  },
  steady: {
    id: 'steady',
    label: '平稳',
    directive: '状态平稳：按平时的软黏语气说话，不夸张，也不抢话'
  }
});

function clamp01(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

function shanghaiHour(now) {
  const d = new Date(Number(now) + TZ_OFFSET_MS);
  return d.getUTCHours();
}

/**
 * @param {object} state persona-state（只需要 energy / mood.valence）
 * @param {{now?:number, quiet?:boolean}} [options]
 */
export function derivePersonaMode(state = {}, { now = Date.now(), quiet = false } = {}) {
  const hour = shanghaiHour(now);
  const energy = clamp01(state?.energy, 0.6);
  const valence = Number.isFinite(Number(state?.mood?.valence)) ? Number(state.mood.valence) : 0.15;
  const arousal = Number.isFinite(Number(state?.mood?.arousal)) ? Number(state.mood.arousal) : 0.45;
  if (quiet || hour >= 23 || hour < 6) return PERSONA_MODES.late;
  if (energy <= 0.38) return PERSONA_MODES.tired;
  if (valence <= -0.25) return PERSONA_MODES.low;
  if (arousal >= 0.62 && valence <= 0.0) return PERSONA_MODES.irritable;
  if (energy >= 0.68 && valence >= 0.30) return PERSONA_MODES.bright;
  return PERSONA_MODES.steady;
}

export function renderPersonaMode(mode) {
  const m = mode && typeof mode === 'object' ? mode : PERSONA_MODES.steady;
  return `【当前状态】${m.label}：${m.directive}`;
}
