// 审批端口适配（P0 不产生动作，只保留契约）。
//
// 桥接侧实现会复用 control-tiers.js 的待确认语义（6 位码 / 10 分钟 TTL /
// 参数指纹 / 一次性）；内核只依赖 ApprovalPort，不 import 桥接实现。

export function createApprovals({ port, config, audit = null }) {
  return {
    supported: false,
    ttlMs: Number(config?.actions?.approvalTtlMs) || 600000,
    async request(req = {}) {
      if (audit) audit.record({ actor: 'owner', action: 'approval.request', args: req, decision: 'denied', result: { reason: 'p0-read-only' } });
      return {
        approved: false,
        disabled: true,
        reason: 'P0 没有需要审批的外部动作'
      };
    }
  };
}
