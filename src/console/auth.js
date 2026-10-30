// 控制台请求闸门：把「Host → 控制台令牌 → 智能体调用隔离 → CSRF」四道检查
// 收成可单测的纯函数。桥接只负责把判定结果写回响应。
//
// 这些都是失败关闭的边界：任何一条判定出错都必须拒绝，而不是放行。
import crypto from 'node:crypto';
import {
  hostHeaderAllowed, originAllowed, isAgentSurface, tokenlessAgentAllowed,
  agentTokenAllowedPath, isAdminOnlyRequest, isStickerConsoleOnly, readonlyStoreFor, isLiveShell
} from './policy.js';

export const CONSOLE_SECURITY_HEADERS = {
  'X-Frame-Options': 'DENY',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'",
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer'
};

/** 令牌提示页：未带令牌打开 / 时用它引导输入，而不是回一坨 JSON。 */
export const CONSOLE_TOKEN_PROMPT_HTML = '<!doctype html><meta charset="utf-8"><title>需要令牌</title><script>const t=prompt(\'请输入控制台访问令牌\');if(t)location.href=\'/?token=\'+encodeURIComponent(t);</script>';

/**
 * 定长比较：`===` 会在首个不同字符处短路，本机进程理论上可用响应时延逐字节试探。
 * 令牌是 192 bit 随机值且只监听回环，这是纵深防御而非在野漏洞。
 */
export function authTokenEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || !a || !b) return false;
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function json(status, error) {
  return { action: 'respond', status, json: { ok: false, error } };
}

const CONTINUE = { action: 'continue' };

/**
 * Host → 控制台令牌 → 智能体调用 → CSRF。
 * 返回值：{ action:'continue' } 或 { action:'respond', status, json?, html? }。
 */
export function evaluateConsoleGate({ method, headers, pathname, searchParams, boundPort, consoleToken, authRequired, isLiveAgentToken }) {
  // Host 头校验（DNS rebinding 硬化）：控制台只监听 127.0.0.1，攻击者把 TTL=0 的域名
  // 解析到 127.0.0.1 时，浏览器会把 evil.com:3100 当作同源；卡住 Host 这一层后，
  // 这类请求在进入任何业务分支之前就被拒掉。反代/端口转发会被一并拒绝——这是有意的。
  const hostHeader = String(headers.host ?? '');
  if (!hostHeaderAllowed(hostHeader, boundPort)) {
    return json(403, `Host 头不被允许（${hostHeader || '缺失'}）：控制台只接受本机回环访问`);
  }
  const suppliedToken = String(searchParams?.get('token') ?? headers['x-console-token'] ?? '');
  const tokenMatches = authTokenEquals(suppliedToken, consoleToken);
  if (authRequired && !tokenMatches) {
    if (method === 'GET' && pathname === '/') {
      return { action: 'respond', status: 401, html: CONSOLE_TOKEN_PROMPT_HTML };
    }
    // 实时状态页的静态外壳和角色图不含数据，允许先加载；数据和 SSE 仍要求 consoleToken。
    if (!isLiveShell(method, pathname)) {
      return json(401, '未授权：请提供控制台访问令牌');
    }
  }
  // 智能体调用隔离（集中关卡）：MCP 端一律带 x-agent-call: 1。
  // 带了令牌就必须命中某个活跃会话——端点自己漏写校验也不会退回管理端全权（confused deputy）。
  if (headers['x-agent-call'] !== undefined) {
    const agentToken = headers['x-agent-token'];
    const hasToken = typeof agentToken === 'string' && agentToken !== '';
    if (hasToken && !isLiveAgentToken(agentToken)) {
      return json(403, '未授权：智能体调用携带的会话令牌无效');
    }
    // 无令牌的智能体调用只放行非仿真会话面；整个 /api/simulation/ 一概不放。
    if (!hasToken && !tokenlessAgentAllowed(pathname)) {
      return json(403, '未授权：该接口的智能体调用必须携带有效的会话令牌');
    }
  }
  // CSRF 防护：所有写操作必须是 application/json，且（若带 Origin）必须来自本机页面。
  if (method !== 'GET') {
    const ctype = String(headers['content-type'] ?? '');
    if (!ctype.toLowerCase().includes('application/json')) {
      return json(415, '请求必须是 application/json');
    }
    const origin = headers.origin;
    if (origin && !originAllowed(origin, boundPort)) {
      return json(403, '跨站请求被拒绝');
    }
  }
  return CONTINUE;
}

/**
 * 令牌通过之后的智能体权限闸门（暂停/关闭/模式/仅控制台/只读降级）。
 * 判定顺序与拆分前一致：先身份，再权限，最后可写性。
 */
export function evaluateAgentAccess({
  method, headers, pathname,
  simulationPaused, simulationEnabled, mode,
  slangStoreWritable, stickerStoreWritable
}) {
  const agentToken = headers['x-agent-token'];
  if (agentToken === '') return json(403, 'agent token 不能为空');
  if (agentToken) {
    const onAgentSurface = isAgentSurface(pathname);
    if (simulationPaused && onAgentSurface) return json(403, 'AI 已暂停，当前不允许执行仿真工具');
    if (simulationEnabled === false && onAgentSurface) return json(403, '仿真模式已关闭，当前不允许执行仿真工具');
    if (pathname.startsWith('/api/simulation/') && mode !== 'simulation') return json(403, '该接口仅 simulation 模式可用');
    if (isAdminOnlyRequest(pathname, method)) return json(403, '该接口仅控制台可用');
    if (isStickerConsoleOnly(pathname)) return json(403, '该接口仅控制台可用');
    if (!agentTokenAllowedPath(pathname)) return json(403, '该接口仅控制台可用');
  }
  const readonlyStore = readonlyStoreFor(pathname, method, { slangStoreWritable, stickerStoreWritable });
  if (readonlyStore) {
    return json(503, `${readonlyStore}处于只读降级状态（启动时加载失败，未覆盖原文件），本次修改不会落盘；请修复 state/ 下的对应文件后重启桥接`);
  }
  return CONTINUE;
}
