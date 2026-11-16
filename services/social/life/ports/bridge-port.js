// 桥接侧 LifePort 组装：只接收注入函数，不 import 桥接内部模块。
//
// 约束（docs/LIFE_BUTLER.md 1.2）：内核与适配器只能看到这个端口，
// 不直接接触 bridge.js / memory / outbox / prompt-*。桥接（或测试）负责把
// 日志、数据库、任务队列、私聊通知和抓取实现注入进来。

/**
 * @param {{
 *   getConfig: () => object,
 *   log: (...args: any[]) => void,
 *   now?: () => number,
 *   db: object,
 *   scheduler: { enqueue: Function, register?: Function, registerHandler?: Function },
 *   notify: (text: string, opts?: object) => Promise<any>,
 *   http: { fetch: Function } | Function
 * }} deps
 * @returns {import('./life-port.js').LifePort}
 */
export function createBridgeLifePort({ getConfig, log, now, db, scheduler, notify, http }) {
  if (typeof getConfig !== 'function') throw new Error('createBridgeLifePort 需要 getConfig');
  if (typeof log !== 'function') throw new Error('createBridgeLifePort 需要 log');
  if (!db) throw new Error('createBridgeLifePort 需要 db');
  if (!scheduler || typeof scheduler.enqueue !== 'function') throw new Error('createBridgeLifePort 需要 scheduler');
  if (typeof notify !== 'function') throw new Error('createBridgeLifePort 需要 notify');
  const fetchFn = typeof http === 'function' ? http : http?.fetch;
  if (typeof fetchFn !== 'function') throw new Error('createBridgeLifePort 需要 http.fetch');

  return {
    config: () => getConfig(),
    log: (level, message, meta) => log(message, meta),
    clock: { now: typeof now === 'function' ? now : () => Date.now() },
    db,
    scheduler,
    notify,
    http: { fetch: fetchFn }
  };
}
