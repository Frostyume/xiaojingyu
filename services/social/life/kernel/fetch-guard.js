// 生活管家专用抓取守卫：仅 HTTPS、域名白名单、拒绝私网、限制重定向/超时/响应体。
//
// 为什么不直接用 safe-fetch.js：safe-fetch 面向「任意公网只读抓取」，
// 允许 http、也没有域名白名单。生活适配器的来源是固定的几个 API/订阅，
// 因此这里在 safe-fetch 的私网判定之上再加一层「白名单 + 仅 HTTPS」。
// 私网判定复用 safe-fetch.isPrivateIp，避免两套规则漂移。

import { isPrivateIp, resolveSafeAddresses } from '../../safe-fetch.js';

export class LifeHttpError extends Error {
  constructor(message, { status = 0, code = '' } = {}) {
    super(message);
    this.name = 'LifeHttpError';
    this.status = status;
    this.code = code;
  }
}

export class LifeAuthError extends LifeHttpError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'auth' });
    this.name = 'LifeAuthError';
  }
}

export class LifeQuotaError extends LifeHttpError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'quota' });
    this.name = 'LifeQuotaError';
  }
}

export class LifeOversizeError extends LifeHttpError {
  constructor(message, opts = {}) {
    super(message, { ...opts, code: 'oversize' });
    this.name = 'LifeOversizeError';
  }
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const DEFAULT_MAX_BYTES = 512 * 1024;
const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_MAX_REDIRECTS = 3;

/** 精确匹配，或 `*.example.com` 形式的子域匹配；大小写不敏感。 */
export function hostAllowed(hostname, allowedHosts = []) {
  const host = String(hostname ?? '').toLowerCase().replace(/\.$/, '');
  if (!host) return false;
  for (const pattern of allowedHosts) {
    const p = String(pattern ?? '').toLowerCase().replace(/\.$/, '');
    if (!p) continue;
    if (p.startsWith('*.')) {
      const suffix = p.slice(1);
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (host === p) {
      return true;
    }
  }
  return false;
}

function parseUrl(raw) {
  let url;
  try {
    url = new URL(String(raw ?? '').trim());
  } catch {
    throw new LifeHttpError('URL 无效', { code: 'bad-url' });
  }
  if (url.protocol !== 'https:') throw new LifeHttpError('生活管家只允许 HTTPS', { code: 'not-https' });
  if (url.username || url.password) throw new LifeHttpError('URL 不能包含凭据', { code: 'credentials' });
  return url;
}

/** 同步形状检查：协议 / 凭据 / 白名单 / IP 字面量私网。DNS 检查在 assertUrlAllowed。 */
export function checkUrlShape(raw, { allowedHosts = [] } = {}) {
  const url = parseUrl(raw);
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) {
    throw new LifeHttpError('禁止访问内网/本机地址', { code: 'private-host' });
  }
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) {
    if (isPrivateIp(host)) throw new LifeHttpError('禁止访问内网/本机地址', { code: 'private-host' });
  }
  if (!hostAllowed(host, allowedHosts)) {
    throw new LifeHttpError(`域名不在白名单：${host}`, { code: 'host-not-allowed' });
  }
  return url;
}

/** 形状 + DNS 全部解析结果检查（防解析到内网/DNS rebinding 的基础防护）。 */
export async function assertUrlAllowed(raw, { allowedHosts = [], resolve = resolveSafeAddresses } = {}) {
  const url = checkUrlShape(raw, { allowedHosts });
  const host = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try {
    addresses = await resolve(host);
  } catch (error) {
    if (error instanceof LifeHttpError) throw error;
    throw new LifeHttpError(`域名解析失败：${error?.message ?? error}`, { code: 'dns' });
  }
  const list = Array.isArray(addresses) ? addresses : [addresses];
  if (!list.length) throw new LifeHttpError('域名没有解析结果', { code: 'dns' });
  for (const address of list) {
    const value = typeof address === 'string' ? address : address?.address;
    if (!value || isPrivateIp(value)) throw new LifeHttpError('域名解析到内网/本机地址，已阻止', { code: 'private-host' });
  }
  return { url, addresses: list.map((a) => (typeof a === 'string' ? a : a.address)) };
}

function headerOf(headers, name) {
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name);
  const key = Object.keys(headers).find((k) => k.toLowerCase() === name);
  return key ? headers[key] : null;
}

async function readCapped(response, maxBytes) {
  const declared = Number(headerOf(response.headers, 'content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new LifeOversizeError(`响应体超过上限（${declared} > ${maxBytes} 字节）`, { status: response.status });
  }
  const body = response.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let size = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value?.byteLength ?? value?.length ?? 0;
      if (size > maxBytes) {
        try { await reader.cancel(); } catch { /* 已关闭 */ }
        throw new LifeOversizeError(`响应体超过上限（>${maxBytes} 字节）`, { status: response.status });
      }
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks).toString('utf8');
  }
  const text = typeof response.text === 'function' ? await response.text() : '';
  if (Buffer.byteLength(String(text), 'utf8') > maxBytes) {
    throw new LifeOversizeError(`响应体超过上限（>${maxBytes} 字节）`, { status: response.status });
  }
  return String(text);
}

/**
 * 创建抓取守卫。
 *
 * @param {{allowedHosts:string[], timeoutMs?:number, maxBytes?:number, maxRedirects?:number,
 *          fetchImpl?:Function, resolve?:Function, userAgent?:string}} options
 */
export function createFetchGuard({
  allowedHosts = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxBytes = DEFAULT_MAX_BYTES,
  maxRedirects = DEFAULT_MAX_REDIRECTS,
  fetchImpl = globalThis.fetch,
  resolve = resolveSafeAddresses,
  userAgent = 'qq-bridge-life/0.1 (+read-only)'
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('createFetchGuard 需要 fetch 实现');
  const hosts = Object.freeze([...allowedHosts]);
  const budget = Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const limit = Math.max(1024, Number(maxBytes) || DEFAULT_MAX_BYTES);
  const redirects = Math.max(0, Math.min(10, Number(maxRedirects) || 0));

  async function fetchGuarded(raw, { headers = {}, maxBytes: overrideBytes } = {}) {
    const effectiveLimit = Math.max(1024, Number(overrideBytes) || limit);
    const deadline = Date.now() + budget;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), budget);
    timer.unref?.();
    let current = String(raw);
    try {
      for (let hop = 0; hop <= redirects; hop += 1) {
        await assertUrlAllowed(current, { allowedHosts: hosts, resolve });
        let response;
        try {
          response = await fetchImpl(current, {
            method: 'GET',
            redirect: 'manual',
            signal: controller.signal,
            headers: { 'user-agent': userAgent, accept: 'application/json, application/xml, text/xml, text/calendar, */*;q=0.5', ...headers }
          });
        } catch (error) {
          if (controller.signal.aborted) throw new LifeHttpError(`请求超时（${budget}ms）`, { code: 'timeout' });
          throw new LifeHttpError(`请求失败：${error?.message ?? error}`, { code: 'network' });
        }
        const status = Number(response?.status) || 0;
        if (REDIRECTS.has(status)) {
          const location = headerOf(response.headers, 'location');
          if (!location) throw new LifeHttpError(`重定向缺少 Location（HTTP ${status}）`, { status, code: 'redirect' });
          if (hop === redirects) throw new LifeHttpError('重定向次数过多，已停止', { status, code: 'redirect-limit' });
          current = new URL(String(location), current).toString();
          continue;
        }
        const rateRemaining = headerOf(response.headers, 'x-ratelimit-remaining');
        if (status === 403 && rateRemaining != null && Number(rateRemaining) === 0) {
          throw new LifeQuotaError('速率限制（HTTP 403）', { status });
        }
        if (status === 401 || status === 403) throw new LifeAuthError(`认证失效（HTTP ${status}）`, { status });
        if (status === 429) throw new LifeQuotaError('配额耗尽（HTTP 429）', { status });
        if (status < 200 || status >= 300) throw new LifeHttpError(`抓取失败：HTTP ${status}`, { status, code: 'http' });
        if (Date.now() > deadline) throw new LifeHttpError(`请求超时（${budget}ms）`, { code: 'timeout' });
        const text = await readCapped(response, effectiveLimit);
        const contentType = String(headerOf(response.headers, 'content-type') || '');
        return { url: current, status, body: text, contentType, bytes: Buffer.byteLength(text, 'utf8') };
      }
      throw new LifeHttpError('重定向次数过多，已停止', { code: 'redirect-limit' });
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    allowedHosts: hosts,
    timeoutMs: budget,
    maxBytes: limit,
    fetch: fetchGuarded,
    /** 仅用于测试/预检：不发起请求。 */
    check: (raw) => checkUrlShape(raw, { allowedHosts: hosts })
  };
}

export const FETCH_LIMITS = Object.freeze({ DEFAULT_MAX_BYTES, DEFAULT_TIMEOUT_MS, DEFAULT_MAX_REDIRECTS });
