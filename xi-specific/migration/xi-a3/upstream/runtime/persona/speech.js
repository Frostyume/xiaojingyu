// ASR（语音转文字）provider。
//
// 当前只实现 SnowLuma 的 `fetch_ptt_text`（QQ 侧转写；不额外接云厂商）。
// 默认关闭：转写依赖上游是否真的给出了文字，失败时静默降级为 [语音]，不阻塞消息处理。
//
// 接口保持小而稳，将来接 faster-whisper / 云 ASR 时只加一个 provider，不改调用方。

export function createSnowLumaAsr({
  httpUrl = 'http://127.0.0.1:3000',
  accessToken = '',
  timeoutMs = 15000,
  cacheTtlMs = 3600000,
  fetchImpl = globalThis.fetch,
  now = () => Date.now(),
  logger = () => {}
} = {}) {
  const base = String(httpUrl).replace(/\/+$/, '');
  const cache = new Map(); // messageId -> { text, at }

  async function transcribe(messageId) {
    const id = String(messageId ?? '').trim();
    if (!id) return { ok: false, error: '缺少 messageId' };
    const hit = cache.get(id);
    if (hit && now() - hit.at < cacheTtlMs) return { ok: true, text: hit.text, cached: true };
    try {
      const token = typeof accessToken === 'function' ? accessToken() : accessToken;
      const res = await fetchImpl(`${base}/fetch_ptt_text`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { authorization: `Bearer ${token}` } : {})
        },
        body: JSON.stringify({ message_id: id }),
        signal: AbortSignal.timeout(Math.max(1000, Number(timeoutMs) || 15000))
      });
      const body = await res.json().catch(() => ({}));
      const ok = res.ok && body?.status === 'ok' && body?.retcode === 0;
      const text = String(body?.data?.text ?? '').replace(/\s+/g, ' ').trim();
      if (!ok || !text) {
        return { ok: false, error: ok ? '上游没有返回转写文本' : `HTTP ${res.status}` };
      }
      cache.set(id, { text, at: now() });
      if (cache.size > 500) {
        for (const key of [...cache.keys()].slice(0, cache.size - 500)) cache.delete(key);
      }
      return { ok: true, text };
    } catch (error) {
      const message = String(error?.message ?? error);
      logger(`ASR 失败（忽略）：${message}`);
      return { ok: false, error: message };
    }
  }

  return { transcribe, kind: 'snowluma' };
}
