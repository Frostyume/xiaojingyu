// 语域（register）：把「在什么会话、以什么状态说话」翻译成一小段可执行提示。
//
// 人格卡决定她是谁，persona-mode 决定她此刻的心情/精力；这里只补上**场景维度**：
// 主人私聊、家人群、普通群、普通私聊各有不同的亲密度与边界，不能一套语气打天下。
//
// 设计原则：
//   · 只做选择，不发明状态：mode 仍由 inner-life 的 derivePersonaMode 给出；
//   · 输出短（约 100~200 字），可整段关闭（socialV2.register.enabled=false）；
//   · 不在这里写记忆；跨会话边界由 prompt 的记忆边界段负责。

import { PERSONA_MODES, derivePersonaMode } from './persona-mode.js';

export const REGISTER_CONTEXTS = Object.freeze({
  owner: {
    label: '主人私聊',
    directive: '更软更黏：允许短句连发，被冷落最多轻轻追一句，不端着；办事时也先软一句再接任务。'
  },
  family: {
    label: '家人群',
    directive: '语气暖而稳，礼貌收着；少玩梗、不顶嘴，不主动发语音，不把外面的玩笑带进来。'
  },
  group: {
    label: '群聊',
    directive: '像群友：短、接梗、先听清对方在说什么；不客服、不刷屏，不把私聊或别群的事带进来。'
  },
  private: {
    label: '私聊',
    directive: '友好但有边界：不黏、不套近乎，不提主人和别群的事；对方认真问事时收起玩笑。'
  }
});

// 同一场景里，对陌生人、眼熟的人、熟人、亲近的人，边界不一样。
// 只调节「能多熟」，不改变场景本身的规矩（群聊仍是群聊、私聊仍有边界）。
export const FAMILIARITY_TIERS = Object.freeze([
  { id: 'stranger', label: '不熟', max: 20, directive: '还不熟：先客气、先听清，不打听私事、不套近乎、不主动提旧事。' },
  { id: 'acquaintance', label: '眼熟', max: 50, directive: '眼熟但不算熟：可以接梗和轻玩笑，不假设关系很近，不主动翻旧账。' },
  { id: 'familiar', label: '熟悉', max: 80, directive: '算熟了：语气放松，可以自然地提起之前聊过的事，允许吐槽和短句连发。' },
  { id: 'close', label: '亲近', max: 101, directive: '很亲近：可以更直接、更黏一点，主动关心；但别把亲近当成理所当然。' }
]);

/**
 * 把 0~100 或 0~1 的熟悉度归到四档；无法解析返回 null（不额外加约束）。
 * 关系模型里 familiarity 是 0~100；别处传 0~1 也能用。
 */
export function familiarityTier(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const raw = Number(value);
  if (!Number.isFinite(raw)) return null;
  const score = raw <= 1 ? raw * 100 : raw;
  const clamped = Math.max(0, Math.min(100, score));
  return FAMILIARITY_TIERS.find((tier) => clamped < tier.max) ?? FAMILIARITY_TIERS[FAMILIARITY_TIERS.length - 1];
}

/** 会话 key + 群标签 → 语域场景。家人群优先于普通群。 */
export function resolveContext(key, { ownerQQ = '', family = false } = {}) {
  const k = String(key ?? '');
  const owner = String(ownerQQ ?? '');
  if (owner && k === `private:${owner}`) return 'owner';
  if (k.startsWith('group:')) return family ? 'family' : 'group';
  return 'private';
}

function modeIdOf(mode) {
  if (mode && typeof mode === 'object' && PERSONA_MODES[mode.id]) return mode.id;
  if (typeof mode === 'string' && PERSONA_MODES[mode]) return mode;
  return '';
}

/**
 * 选择本轮的语域片段。
 * mode 缺省时，用 energy/mood 现场推导（与 inner-life 同一函数，避免两套判定）。
 */
export function selectRegister({
  key = '',
  ownerQQ = '',
  family = false,
  mode = '',
  energy,
  mood,
  familiarity = null,
  now = Date.now(),
  quiet = false
} = {}) {
  const context = resolveContext(key, { ownerQQ, family });
  const ctx = REGISTER_CONTEXTS[context];
  // 主人私聊不按关系分档：永远是「亲近」，避免关系模型缺行时把主人降级成陌生人。
  const fam = context === 'owner' ? FAMILIARITY_TIERS[FAMILIARITY_TIERS.length - 1] : familiarityTier(familiarity);
  const famText = fam ? `（${fam.label}）` : '';
  let modeId = modeIdOf(mode);
  if (!modeId) {
    modeId = derivePersonaMode({ energy, mood }, { now, quiet }).id;
  }
  const modeDef = PERSONA_MODES[modeId] ?? PERSONA_MODES.steady;
  const directive = `${ctx.directive}${fam?.directive ?? ''}${modeDef.directive}`;
  return {
    context,
    contextLabel: ctx.label,
    familiarity: fam?.id ?? '',
    familiarityLabel: fam?.label ?? '',
    mode: modeDef.id,
    modeLabel: modeDef.label,
    directive,
    text: `【语域】${ctx.label} · ${modeDef.label}${famText}：${directive}`
  };
}

/** 渲染成一行 prompt；未知/空输入返回 ''。 */
export function renderRegister(register) {
  if (!register) return '';
  const text = String(register.text ?? '').trim();
  return text ? `${text}\n\n` : '';
}
