// 控制台访问策略：**纯数据 + 纯判定**，不碰 req/res、不读写状态。
//
// 为什么单独拆出来：以前这些路径名单散在 startConsoleServer 的三段 if 里，
// 「新增一个管理端点忘了拉黑」「改名单时漏改另一段」都只能靠人眼。收成表后
// 单测可以直接穷举名单，桥接只负责按判定结果回响应。
//
// 语义必须与拆分前逐字一致：改这里等于改控制台的权限边界。

/** 智能体（带 x-agent-token）可以访问的会话面：暂停/关闭/模式检查都看这三段。 */
export const AGENT_SURFACE_PREFIXES = ['/api/simulation/', '/api/send/', '/api/images/'];

/** 不带令牌的智能体调用只允许这条非仿真会话面（closed-agent 模式的工具靠它）。 */
export const TOKENLESS_AGENT_PATHS = new Set(['/api/status']);
export const TOKENLESS_AGENT_PREFIXES = ['/api/send/', '/api/images/'];

/** 带令牌智能体的总白名单；其余端点一律视为「仅控制台」。 */
export const AGENT_ALLOWED_PATHS = new Set(['/api/status', '/api/authorize/read']);
export const AGENT_ALLOWED_PREFIXES = ['/api/simulation/', '/api/send/', '/api/images/'];

/** 只允许控制台、智能体令牌一律拒绝的 仿真管理端点。 */
export const ADMIN_ONLY_SIM_PATHS = new Set([
  '/api/simulation/config',
  '/api/simulation/activity',
  '/api/simulation/reset',
  '/api/simulation/states',
  '/api/simulation/wake',
  '/api/simulation/initial-prompt',
  '/api/simulation/group-profiles',
  '/api/simulation/group-profile',
  '/api/simulation/wake-preview'
]);

/** 实时状态页的静态外壳（不含数据，允许未带令牌先加载）。 */
export function isLiveShell(method, pathname) {
  return method === 'GET' && (pathname === '/live' || pathname.startsWith('/live-assets/'));
}

/** 实时状态页允许读取的图片资源。 */
export const LIVE_ASSET_NAMES = new Set([
  'whale-pixel-wave.png',
  'whale-pixel-sit.png',
  'whale-pixel-idle.png',
  'whale-pixel-excited.png',
  'whale-pixel-pout.png'
]);

/** 只读降级涉及的写端点：启动时库加载失败后必须明确 503，而不是假装保存成功。 */
export const READONLY_SLANG_PATHS = new Set([
  '/api/slang',
  '/api/slang/clear',
  '/api/slang/extract',
  '/api/slang/research',
  '/api/simulation/slang/submit'
]);
export const READONLY_SLANG_PREFIXES = ['/api/slang/batch-'];
export const READONLY_STICKER_PATHS = new Set([
  '/api/stickers/sync',
  '/api/stickers/note',
  '/api/stickers/remark',
  '/api/simulation/sticker-note',
  '/api/simulation/sticker-remark',
  '/api/simulation/collect-sticker'
]);

export function isAgentSurface(pathname) {
  return AGENT_SURFACE_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function tokenlessAgentAllowed(pathname) {
  return TOKENLESS_AGENT_PATHS.has(pathname) || TOKENLESS_AGENT_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function agentTokenAllowedPath(pathname) {
  return AGENT_ALLOWED_PATHS.has(pathname) || AGENT_ALLOWED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

export function isAdminOnlyRequest(pathname, method) {
  return ADMIN_ONLY_SIM_PATHS.has(pathname)
    || (pathname === '/api/simulation/feedback' && method === 'GET')
    || (pathname === '/api/simulation/tool-log' && method === 'GET');
}

export function isStickerConsoleOnly(pathname) {
  return pathname === '/api/stickers' || pathname.startsWith('/api/stickers/');
}

/**
 * 只读降级判定：返回 '黑话库' / '表情库' / ''。
 * 只对写操作生效（GET 照常可读）。
 */
export function readonlyStoreFor(pathname, method, { slangStoreWritable, stickerStoreWritable }) {
  if (method === 'GET') return '';
  if (!slangStoreWritable && (READONLY_SLANG_PATHS.has(pathname) || READONLY_SLANG_PREFIXES.some((p) => pathname.startsWith(p)))) {
    return '黑话库';
  }
  if (!stickerStoreWritable && READONLY_STICKER_PATHS.has(pathname)) return '表情库';
  return '';
}

/** 控制台只监听回环：合法 Host/Origin 只可能是这三种拼写。 */
export function allowedLoopbackHosts(port) {
  return [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`];
}

export function hostHeaderAllowed(hostHeader, port) {
  return allowedLoopbackHosts(port).includes(String(hostHeader ?? '').toLowerCase());
}

export function originAllowed(origin, port) {
  let originHost = '';
  try { originHost = new URL(String(origin)).host; } catch {}
  return allowedLoopbackHosts(port).includes(originHost);
}

/** 初始化 consoleToken 的合法性判定（长度 16–128、仅 A-Za-z0-9_-）。 */
export function validConsoleTokenShape(token) {
  return token.length >= 16 && token.length <= 128 && /^[A-Za-z0-9_-]+$/.test(token);
}
