// BreezeTTS2 只有一个推理槽位：并发请求时后到的那条会收到 409。
// 语音不是实时流，等几百毫秒到几秒完全可以接受；这里做有上限的指数退避，
// 超过预算才把“正忙”交给上层，让模型改用文字，而不是立刻回退到同样会 409 的 WAV 通道。

export const TTS_BUSY_STATUS = new Set([409, 503]);

export class TtsBusyError extends Error {
  constructor(message) {
    super(message);
    this.name = 'TtsBusyError';
    this.code = 'TTS_BUSY';
  }
}

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {object} opts
 * @param {number} opts.timeoutMs 单次请求超时
 * @param {number} opts.totalMs   忙等总预算（从第一次请求前开始算）
 * @param {number} opts.baseDelayMs
 * @param {number} opts.maxDelayMs
 * @param {number} opts.jitterMs
 * @param {string} opts.label
 * @param {typeof fetch} opts.fetchImpl 测试注入
 * @param {() => number} opts.now 测试注入
 */
export async function fetchWithBusyRetry(url, init = {}, {
  timeoutMs = 45000,
  totalMs = 15000,
  baseDelayMs = 400,
  maxDelayMs = 2000,
  jitterMs = 120,
  label = 'TTS',
  fetchImpl = globalThis.fetch,
  now = Date.now
} = {}) {
  const deadline = now() + Math.max(0, totalMs);
  const busyError = () => new TtsBusyError(`${label} 持续忙碌（已等待约 ${Math.round(totalMs / 1000)} 秒）`);
  let attempt = 0;
  for (;;) {
    attempt += 1;
    const remaining = deadline - now();
    // 剩余窗口太短时不再发起注定会超时的请求，直接按“正忙”返回。
    if (remaining < 25) throw busyError();
    // 单次合成本身可能就要几秒，不能被“忙等预算”截断；预算只约束 409 之后的等待。
    const res = await fetchImpl(url, {
      ...init,
      signal: AbortSignal.timeout(Math.max(1, timeoutMs))
    });
    if (!TTS_BUSY_STATUS.has(res.status)) return res;
    // 必须把错误响应体读掉，否则连接不会及时回到连接池。
    await res.text().catch(() => {});
    const left = deadline - now();
    if (left <= 0) throw busyError();
    const delay = Math.min(maxDelayMs, baseDelayMs * 2 ** Math.min(attempt - 1, 5));
    const wait = Math.min(left, delay + Math.floor(Math.random() * Math.max(0, jitterMs)));
    await sleep(wait);
  }
}
