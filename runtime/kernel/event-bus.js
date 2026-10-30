// 轻量事件总线：feature 之间的唯一解耦点。
//
// 原则：
//   · 监听器按 priority 从高到低执行；
//   · 单个监听器抛错/超时只记录，不影响其它监听器和主流程；
//   · 支持 '*' 与 'prefix.*' 通配；
//   · 没有监听器时 emit 立即返回，零成本。

export class EventBus {
  constructor({ logger = () => {}, defaultTimeoutMs = 5000 } = {}) {
    this.logger = logger;
    this.defaultTimeoutMs = Math.max(100, Number(defaultTimeoutMs) || 5000);
    this.handlers = new Map(); // event -> [{ id, priority, fn }]
    this.seq = 0;
  }

  on(event, fn, { id = '', priority = 0 } = {}) {
    if (typeof fn !== 'function') throw new Error('监听器必须是函数');
    const key = String(event);
    if (!this.handlers.has(key)) this.handlers.set(key, []);
    const entry = { id: id || `h${++this.seq}`, priority: Number(priority) || 0, fn };
    this.handlers.get(key).push(entry);
    this.handlers.get(key).sort((a, b) => b.priority - a.priority);
    return () => this.off(key, entry.id);
  }

  off(event, id) {
    const list = this.handlers.get(String(event));
    if (!list) return false;
    const next = list.filter((h) => h.id !== id);
    if (next.length) this.handlers.set(String(event), next);
    else this.handlers.delete(String(event));
    return next.length !== list.length;
  }

  _matching(event) {
    const out = [];
    for (const [pattern, list] of this.handlers) {
      const prefix = pattern.endsWith('.*') ? pattern.slice(0, -1) : '';
      const matches = pattern === event || pattern === '*'
        || (prefix && (event.startsWith(prefix) || event.startsWith(`${prefix.slice(0, -1)}/`)));
      if (matches) out.push(...list);
    }
    return out.sort((a, b) => b.priority - a.priority);
  }

  async emit(event, payload = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    const handlers = this._matching(String(event));
    if (!handlers.length) return { event, handled: 0, errors: [] };
    const errors = [];
    for (const handler of handlers) {
      try {
        await Promise.race([
          Promise.resolve().then(() => handler.fn(payload, { event, id: handler.id })),
          new Promise((_, reject) => {
            const timer = setTimeout(() => reject(new Error(`监听器超时（${timeoutMs}ms）`)), timeoutMs);
            timer.unref?.();
          })
        ]);
      } catch (error) {
        const message = String(error?.message ?? error);
        errors.push({ id: handler.id, message });
        this.logger(`事件 ${event} 监听器 ${handler.id} 失败（已隔离）：${message}`);
      }
    }
    return { event, handled: handlers.length - errors.length, errors };
  }

  has(event) {
    return this._matching(String(event)).length > 0;
  }

  stats() {
    return {
      events: [...this.handlers.keys()],
      handlers: [...this.handlers.values()].reduce((sum, list) => sum + list.length, 0)
    };
  }
}
