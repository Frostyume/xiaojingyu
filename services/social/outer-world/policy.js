// 出门见闻：访问策略（公开放行 / 登录墙 / 内网与高风险路径硬拦）。
//
// 只做判定，不发请求：调用方拿到 allow/reason 后再决定是否打开页面。
// 规则顺序固定，先硬拦后放行；policy='public' 是默认，allowlist 为可选的更严模式。

import { URL } from 'node:url';

const LOGIN_RE = /login|signin|sign-in|passport|sso|oauth|auth|verify|captcha|register|signup/i;
const PAY_RE = /pay|checkout|order|billing|subscribe/i;
const DOWNLOAD_RE = /\.(zip|exe|msi|apk|dmg|iso|7z|rar|tar|gz|bin)(?:$|[?#])/i;
const LOGIN_WALL_RE = /请先登录|扫码登录|登录后查看|登录查看全文|登录后继续|Sign in to continue|Log in to see|Log in or sign up|Please log in/i;

const PRIVATE_HOSTS = ['localhost', '::1', '[::1]'];
const PRIVATE_PREFIXES = ['127.', '10.', '192.168.', '169.254.'];

function isPrivateIPv4(host) {
  if (PRIVATE_PREFIXES.some((p) => host.startsWith(p))) return true;
  const m = /^172\.(\d+)\./.exec(host);
  if (m) {
    const n = Number(m[1]);
    return n >= 16 && n <= 31;
  }
  return false;
}

function isPrivateHost(host) {
  if (!host) return true;
  if (PRIVATE_HOSTS.includes(host)) return true;
  if (host.endsWith('.local')) return true;
  return isPrivateIPv4(host);
}

function hostMatches(host, domain) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d) return false;
  const bare = d.replace(/^(https?:)?\/\//, '').replace(/\/.*$/, '');
  return host === bare || host.endsWith(`.${bare}`);
}

export function normalizeUrl(raw) {
  const value = String(raw ?? '').trim();
  if (!value) return { ok: false, reason: 'empty' };
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return { ok: false, reason: 'invalid-url' };
  }
  return {
    ok: true,
    url: parsed.href,
    protocol: parsed.protocol,
    host: parsed.hostname.toLowerCase(),
    hasCredentials: Boolean(parsed.username || parsed.password),
    pathname: parsed.pathname,
    search: parsed.search
  };
}

export function evaluateUrl(rawUrl, { policy = 'public', allowlist = [], blockedDomains = [] } = {}) {
  const info = normalizeUrl(rawUrl);
  if (!info.ok) return { allow: false, reason: info.reason, url: String(rawUrl ?? ''), host: '' };
  const host = info.host;
  const deny = (reason) => ({ allow: false, reason, url: info.url, host });

  if (info.protocol !== 'http:' && info.protocol !== 'https:') return deny('protocol');
  if (info.hasCredentials) return deny('userinfo');
  if (isPrivateHost(host)) return deny('private-network');
  if (LOGIN_RE.test(`${host}${info.pathname}${info.search}`)) return deny('login-required');
  if (PAY_RE.test(`${info.pathname}${info.search}`)) return deny('payment');
  if (DOWNLOAD_RE.test(info.pathname)) return deny('download');

  const blocked = (Array.isArray(blockedDomains) ? blockedDomains : []);
  if (blocked.some((domain) => hostMatches(host, domain))) return deny('blocked-domain');

  if (String(policy || 'public') === 'allowlist') {
    const listed = (Array.isArray(allowlist) ? allowlist : []);
    if (!listed.some((domain) => hostMatches(host, domain))) return deny('not-allowlisted');
  }

  return { allow: true, reason: '', url: info.url, host };
}

export function evaluateRedirect(fromUrl, toUrl, opts = {}) {
  const result = evaluateUrl(toUrl, opts);
  if (!result.allow) return { ...result, reason: `redirect:${result.reason}` };
  return result;
}

export function detectLoginWall(text, { minContentChars = 200 } = {}) {
  const body = String(text ?? '').trim();
  if (!body) return false;
  if (body.length >= Math.max(0, Number(minContentChars) || 0)) return false;
  return LOGIN_WALL_RE.test(body);
}

export function redactUrlForAudit(rawUrl) {
  const info = normalizeUrl(rawUrl);
  return info.ok ? info.host : '';
}
