// 审计：只记「谁、对哪个适配器、做了什么、结果如何」，参数只存哈希与脱敏摘要。
// P0 没有 life_audit 表（设计稿 P0 范围只建 4 张表），审计走结构化日志端口，便于后续落表。

import crypto from 'node:crypto';
import { redactText } from './redact.js';

function stable(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stable(value[key])}`).join(',')}}`;
}

export function hashArgs(args) {
  return crypto.createHash('sha256').update(stable(args ?? {})).digest('hex').slice(0, 32);
}

export function createAudit({ clock, logger = () => {} }) {
  return {
    record({ actor = 'system', adapter = null, action = '', args = null, decision = '', result = null, durationMs = null } = {}) {
      const entry = {
        at: Number(clock.now()),
        actor: String(actor).slice(0, 40),
        adapter: adapter ? String(adapter).slice(0, 40) : null,
        action: String(action).slice(0, 80),
        argsHash: args == null ? null : hashArgs(args),
        decision: String(decision).slice(0, 40),
        result: result == null ? null : redactText(JSON.stringify(result)).slice(0, 400),
        durationMs: durationMs == null ? null : Math.max(0, Math.round(Number(durationMs) || 0))
      };
      try { logger('info', 'life.audit', entry); } catch { /* 日志失败不影响业务 */ }
      return entry;
    }
  };
}
