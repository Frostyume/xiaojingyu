// 动作状态机（P0 只读：没有任何执行路径）。
//
// 状态：proposed → approved → executing → succeeded | failed | uncertain | cancelled | expired
// uncertain = 请求可能已发出但结果未知：不自动重试，要求人工核对（沿用 outbox 语义）。
// L3 永久禁用：即使配置误开也没有自动执行代码路径。

export const ACTION_STATES = Object.freeze([
  'proposed', 'approved', 'executing', 'succeeded', 'failed', 'uncertain', 'cancelled', 'expired'
]);

const TERMINAL = new Set(['succeeded', 'failed', 'uncertain', 'cancelled', 'expired']);
const TRANSITIONS = Object.freeze({
  proposed: ['approved', 'cancelled', 'expired'],
  approved: ['executing', 'cancelled', 'expired'],
  executing: ['succeeded', 'failed', 'uncertain'],
  failed: [],
  succeeded: [],
  uncertain: [],
  cancelled: [],
  expired: []
});

export function canTransition(from, to) {
  return (TRANSITIONS[from] ?? []).includes(to);
}

export function createActions({ config, audit = null }) {
  const readOnly = () => ({
    ok: false,
    disabled: true,
    reason: 'P0 只读：生活管家没有外部写动作；L2/L3 也未启用任何执行路径'
  });

  return {
    readOnly,
    /** P0 恒拒绝：不创建提案、不写表、不调用任何外部接口。 */
    propose() {
      if (audit) audit.record({ actor: 'owner', action: 'action.propose', decision: 'denied', result: { reason: 'read-only-p0' } });
      return readOnly();
    },
    approve() {
      const l2 = config?.actions?.l2Enabled === true;
      if (audit) audit.record({ actor: 'owner', action: 'action.approve', decision: 'denied', result: { l2 } });
      return readOnly();
    },
    execute() {
      return readOnly();
    },
    cancel() {
      return { ok: false, disabled: true, reason: 'P0 没有可取消的动作' };
    },
    canTransition,
    isTerminal: (state) => TERMINAL.has(state)
  };
}
