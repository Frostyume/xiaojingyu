// LifePort 契约（JSDoc + 运行时断言）。
//
// 内核与适配器只通过这里的端口与外部世界交互：不 import src/bridge.js、
// src/core/memory.js、src/core/outbox.js、src/core/prompt-*。
// 桥接负责构造端口；测试可注入假时钟、假 db、假 http（fixtures 不联网）。

/**
 * @typedef {Object} LifePort
 * @property {() => object} config        只读配置快照（lifeButler 段，可含其他桥接字段）
 * @property {(level: string, message: string, meta?: object) => void} log
 * @property {{ now: () => number }} clock
 * @property {object} db                  仅 life_* 表 + jobs；需 get/all/run/exec/transaction
 * @property {(text: string, opts?: object) => Promise<object>} notify
 * @property {object} scheduler           { enqueue(input), register(type, handler) | registerHandler(type, handler), cancel(dedupeKey) }
 * @property {{ fetch: Function }} http   受限抓取（仅 HTTPS + 白名单）；也可直接传函数
 * @property {object} [memory]            remember/search/forget（P0 未使用）
 * @property {Function} [approval]        (req) => Promise<{approved:boolean, code?:string}>（P0 未使用）
 * @property {object} [reminders]         add/list/cancel（P0 未使用）
 * @property {(section: object) => void} [prompt] 注册按需小节（P0 未使用）
 * @property {(event: object) => void} [emit]     事件总线（可选）
 */

const DB_METHODS = ['get', 'all', 'run'];

/** 必填端口：总开关打开时才强制 db / scheduler / http / notify。 */
export const REQUIRED_PORT_KEYS = Object.freeze(['config', 'log', 'clock']);

export function assertLifePort(port, { enabled = false } = {}) {
  if (!port || typeof port !== 'object') throw new Error('LifePort 必须是对象');
  for (const key of REQUIRED_PORT_KEYS) {
    if (!(key in port)) throw new Error(`LifePort 缺少端口：${key}`);
  }
  if (typeof port.config !== 'function') throw new Error('LifePort.config 必须是函数');
  if (typeof port.log !== 'function') throw new Error('LifePort.log 必须是函数');
  if (!port.clock || typeof port.clock.now !== 'function') throw new Error('LifePort.clock.now 必须是函数');
  if (!enabled) return true;

  if (!port.db || typeof port.db !== 'object') throw new Error('LifePort.db 缺失（启用生活管家时需要 SQLite）');
  for (const key of DB_METHODS) {
    if (typeof port.db[key] !== 'function') throw new Error(`LifePort.db.${key} 必须是函数`);
  }
  if (!port.scheduler || typeof port.scheduler !== 'object') throw new Error('LifePort.scheduler 缺失');
  const hasRegister = typeof port.scheduler.register === 'function' || typeof port.scheduler.registerHandler === 'function';
  if (!hasRegister) throw new Error('LifePort.scheduler.register 必须是函数');
  if (typeof port.scheduler.enqueue !== 'function') throw new Error('LifePort.scheduler.enqueue 必须是函数');
  if (typeof port.notify !== 'function') throw new Error('LifePort.notify 必须是函数');
  const hasFetch = typeof port.http === 'function' || (port.http && typeof port.http.fetch === 'function');
  if (!hasFetch) throw new Error('LifePort.http.fetch 必须是函数');
  return true;
}

/** 统一的抓取入口：既接受 `http: fn`，也接受 `{fetch}`。 */
export function httpFetch(port) {
  return typeof port.http === 'function' ? port.http : port.http.fetch;
}

/** 调度器注册兼容：桥接可能暴露 register 或 registerHandler。 */
export function registerJobHandler(port, type, handler) {
  const scheduler = port.scheduler;
  if (typeof scheduler.registerHandler === 'function') return scheduler.registerHandler(type, handler);
  return scheduler.register(type, handler);
}

export function portLog(port, level, message, meta) {
  try {
    port.log(level, message, meta);
  } catch {
    // 日志失败不能影响业务。
  }
}
