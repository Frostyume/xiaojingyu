// 当前角色是否属于「默认角色」的统一判定。
//
// 默认角色 = 没设角色，或显式选了内置的「小鲸鱼」。只有默认角色保留写死的语气/内核；
// 自定义角色的人格和语气必须完全来自角色卡，否则每轮注入的默认规则会盖掉用户自己写的人设。

export const DEFAULT_ROLE_NAME = '小鲸鱼';

export function isCustomRoleName(name) {
  const n = String(name ?? '').trim();
  return Boolean(n) && n !== DEFAULT_ROLE_NAME;
}

/**
 * @param {string|{name?:string, card?:string}} [roleOrOptions]
 * @returns {{name:string, custom:boolean, isDefault:boolean, card:string}}
 */
export function personaStyleContext(roleOrOptions = {}) {
  const opts = typeof roleOrOptions === 'string' ? { name: roleOrOptions } : (roleOrOptions ?? {});
  const name = String(opts.name ?? '').trim();
  const custom = isCustomRoleName(name);
  return {
    name,
    custom,
    isDefault: !custom,
    card: String(opts.card ?? '')
  };
}
