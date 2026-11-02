// 安全版 QQ MCP server（stdio）。由 DSH 的 MCP 客户端 spawn。
//
// 安全设计：
// - 只暴露聊天所需的**安全动作子集**（查状态/查群/查消息/发消息），
//   不暴露任何管理类动作（禁言、踢人、改群设置、文件上传下载等）。
// - 发送类工具强制校验白名单：目标群/私聊必须命中 config.json 的
//   allow.groups / allow.private，否则拒绝 —— agent 只能往被允许的地方发消息。
// - 所有调用走 OneBot HTTP API（httpUrl + accessToken）。
import fs from 'node:fs';
import { atomicWriteJson } from '../runtime/kernel/state-file.js';
import http from 'node:http';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
// 出站文本的敏感信息拦截**统一由桥接负责**（bridge.js 的 auditAndSend / 各发送端点的
// SENSITIVE_RE 校验）：所有 QQ 发送都经由桥接 HTTP API，因此 MCP 侧不再重复实现一遍。
// 这里 import 只用于「出站审计口径一致」的说明，不在 MCP 内做拦截——
// 在 MCP 里拦会连「安全拒绝理由」都拿不到，反而让模型无法把话说清楚。
import { SENSITIVE_RE } from '../runtime/kernel/sensitive.js';
import { serializeModelData } from '../services/social/qq-model-view.js';
import { fetchWithBusyRetry, TtsBusyError } from '../runtime/persona/tts-busy-retry.js';
import { featureEnabled } from '../runtime/control/feature-switches.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

function loadConfig() {
  try {
    let text = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return {};
  }
}

const cfg = loadConfig();

function getConfig() {
  return loadConfig();
}

function getAccess() {
  const c = getConfig();
  return {
    allowGroups: (c.allow?.groups ?? []).map(String),
    allowPrivate: (c.allow?.private ?? []).map(String),
    denyGroups: (c.deny?.groups ?? []).map(String),
    denyPrivate: (c.deny?.private ?? []).map(String),
    allowAllWhenEmpty: c.allowAllWhenEmpty === true
  };
}

function getOneBotConfig() {
  const c = getConfig();
  return {
    httpUrl: (c.snowluma?.httpUrl ?? 'http://127.0.0.1:3000').replace(/\/+$/, ''),
    token: c.snowluma?.accessToken ?? ''
  };
}

// 与 bridge.allowed 保持一致：allow 列表为空时按 allowAllWhenEmpty 放行
function isAllowed(allowList, denyList, id, allowAllWhenEmpty) {
  const s = String(id);
  if (denyList.includes(s)) return false;
  if (allowList.length > 0) return allowList.includes(s);
  return allowAllWhenEmpty;
}

// 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
function unquoteJsonString(value) {
  if (typeof value !== 'string') return value;
  const t = value.trim();
  if (t.startsWith('"')) {
    try {
      const parsed = JSON.parse(t);
      if (typeof parsed === 'string') return parsed;
    } catch {}
  }
  return value;
}

// 说明：本文件曾经有一对 escapeCqText() / messageSegments()，用于在 MCP 侧构造消息段。
// 它们从来没有被任何工具调用（发送一律走桥接的 /api/send/*，由桥接统一构造文本段并做
// CQ 转义，见 bridge.js 的 onebotSend），属于"看起来在防护、实际是死代码"的假安全。
// 这里直接删除，避免以后有人以为 MCP 侧还有一道 CQ 转义而放松桥接那一层。

async function onebot(action, params = {}) {
  const { httpUrl, token } = getOneBotConfig();
  const res = await fetch(`${httpUrl}/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(15000)
  });
  if (!res.ok) {
    const hint = res.status === 426 ? '；HTTP 426 通常表示 httpUrl 指向了 WebSocket 端口，请检查 config.json 的 snowluma.httpUrl 是否为 OneBot HTTP API 地址' : '';
    throw new Error(`HTTP ${res.status}${hint}`);
  }
  const body = await res.json();
  if (body.status !== 'ok' || body.retcode !== 0) {
    throw new Error(`OneBot ${action} 失败: retcode=${body.retcode} ${body.wording ?? ''}`);
  }
  return body.data;
}

// 桥接控制台/内部 Agent API 访问：群聊仿真模式的状态工具都通过这里读写桥接内存态。
function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}
function readConsoleToken() {
  // 每次请求都重新读取，优先 config.json 里的 consoleToken，其次 state/console-token，
  // 避免 token 变化后 MCP 仍使用启动时缓存的旧值导致一直 401。
  //
  // 必须与桥接的校验口径**完全一致**（bridge.js 的 startConsoleServer：长度 16~128、
  // 只允许 [A-Za-z0-9_-]，不合法就忽略并回退 state/console-token）。否则用户手填一个
  // 短令牌时桥接会正常运行，而 MCP 拿着这个桥接根本不认的值去请求 —— 每个工具都 401，
  // 且错误信息里看不出原因是"config.json 里的令牌格式不合法"。
  try {
    const c = getConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    const tokenFile = path.join(ROOT, 'state', 'console-token');
    return fs.readFileSync(tokenFile, 'utf8').trim();
  } catch {
    return '';
  }
}

/**
 * 把桥接返回的 `error` 变成可读文本。
 *
 * 为什么必须有：桥接个别分支会回一个**对象**（例如 `{code, message}`），直接
 * `new Error(obj)` 会把它 String 成 "[object Object]" —— 模型和运维都读不到任何信息。
 * r3 的已知未修项里就记着 `qq_wait_for_messages` 出现过 `error: "\"Error: [object Object]\""`。
 */
function errorText(value, fallback) {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (value && typeof value === 'object') {
    try {
      const text = JSON.stringify(value);
      if (text && text !== '{}') return text.slice(0, 500);
    } catch {}
    const message = value.message ?? value.msg ?? value.error;
    if (typeof message === 'string' && message.trim()) return message.trim().slice(0, 500);
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return fallback;
}

async function agentApi(path, init = {}) {
  const timeoutMs = init.timeoutMs || 15000;
  const { timeoutMs: _omit, ...rest } = init;
  const headers = agentHeaders(rest.headers);
  const res = await fetch(`${agentApiBase()}${path}`, { ...rest, headers, signal: AbortSignal.timeout(timeoutMs) });
  let body = null;
  try { body = await res.json(); } catch { body = null; }
  if (!res.ok) {
    throw new Error(errorText(body?.error, `桥接 API HTTP ${res.status}`));
  }
  // 桥接的部分端点会用 200 + {ok:false,error} 表达业务失败（例如发送被审计拦截）。
  // 不检查 body.ok 会把「被拦截」当成「发送成功」上报给模型 —— 模型据此认为消息已发出，
  // 于是不再重试也不告诉用户，是典型的静默错误。
  if (body && typeof body === 'object' && body.ok === false) {
    throw new Error(errorText(body.error, '桥接 API 返回 ok:false（未说明原因）'));
  }
  return body;
}

/**
 * 桥接 API 请求头（含控制台令牌、x-agent-call 与调用方附加头）。
 * 拆出来是为了长轮询通道复用同一套鉴权，避免两条通路口径漂移。
 */
function agentHeaders(extra = {}) {
  const consoleToken = readConsoleToken();
  const headers = {
    'content-type': 'application/json',
    ...(consoleToken ? { 'x-console-token': consoleToken } : {}),
    ...(extra ?? {})
  };
  // 声明「这是一次智能体调用」。桥接据此把「没带会话令牌」判定为**拒绝**，而不是
  // 退化成「管理端全权」——所以这个头绝不能随 token 一起被省略。历史上 331/355/379/877
  // 行用 `...(token ? {headers:{...}} : {})` 把整个头省掉了，于是「模型漏传 token」
  // 不是被拒绝，反而提权成控制台权限（confused deputy）。
  // 令牌本身仍然只在真有时才发：/api/status 的模式探测（legacyReadToolAllowed）本来就是
  // 无令牌调用，桥接对它单独放行并按最小对象返回。
  headers['x-agent-call'] = '1';
  return headers;
}

/**
 * 长轮询专用 POST（`node:http`，不经过 undici）。
 *
 * 为什么必须单独一条：Node 的全局 `fetch` 是 undici，自带 300 秒 `headersTimeout`。
 * 而 `qq_wait_for_messages` 的常规用法就是 `timeoutMs=300000` 的沉睡前观察 ——
 * 客户端会在第 301 秒以 `fetch failed / Headers Timeout Error` 断掉，桥接侧的
 * 长轮询却还在跑满自己的预算：AI 拿不到结果只能重试，而 `activeWaits` 仍占着会话
 * （重新等待被 429），于是空转烧 token（见 issue #24）。`node:http` 没有默认响应超时，
 * 超时完全由这里的计时器按调用方预算控制。
 */
function agentApiLongPoll(path, init = {}) {
  const timeoutMs = Math.max(1000, Number(init.timeoutMs) || 15000);
  const url = new URL(`${agentApiBase()}${path}`);
  const body = init.body == null ? '' : String(init.body);
  const headers = agentHeaders(init.headers);
  headers['content-length'] = Buffer.byteLength(body);
  return new Promise((resolve, reject) => {
    let settled = false;
    let req;
    let res;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      const error = new Error(`等待超时（${Math.round(timeoutMs / 1000)}s）`);
      finish(error);
      req?.destroy(error);
      res?.destroy();
    }, timeoutMs);
    timer.unref?.();
    try {
      req = http.request({
        hostname: url.hostname,
        port: url.port || 80,
        path: url.pathname + url.search,
        method: init.method || 'GET',
        headers,
        timeout: 0
      }, (response) => {
        res = response;
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          if (settled) return;
          size += chunk.length;
          // 桥接的 wait 响应本来就是小 JSON；超过 4MB 说明对端异常，别把内存吃光。
          if (size > 4 * 1024 * 1024) {
            finish(new Error('等待响应体过大，已中止'));
            response.destroy();
            return;
          }
          chunks.push(chunk);
        });
        response.on('error', (error) => finish(error));
        response.on('aborted', () => finish(new Error('等待响应中断')));
        response.on('close', () => { if (!response.complete) finish(new Error('等待响应中断')); });
        response.on('end', () => {
          if (settled) return;
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { parsed = null; }
          const status = response.statusCode || 0;
          if (status < 200 || status >= 300) {
            finish(new Error(errorText(parsed?.error, `桥接 API HTTP ${status}`)));
            return;
          }
          if (parsed && typeof parsed === 'object' && parsed.ok === false) {
            finish(new Error(errorText(parsed.error, '桥接 API 返回 ok:false（未说明原因）')));
            return;
          }
          finish(null, parsed);
        });
      });
      req.on('error', (error) => finish(error));
      req.end(body);
    } catch (error) {
      finish(error);
      req?.destroy();
    }
  });
}

async function authorizeRead(key) {
  // 会话令牌必须显式携带：桥接已把空令牌的请求一律拒绝（避免把该端点变成免鉴权入口）。
  // 旧只读工具没有令牌，因此它们改由 legacyReadToolAllowed() 做模式判定，不再调用本函数。
  throw new Error('旧只读工具没有会话令牌；请使用带会话令牌的仿真读工具');
}

// 旧只读工具（qq_status 之外的 qq_list_groups / qq_get_group_members / qq_get_group_history）
// 没有会话令牌，因此**只能在封闭 agent（管理员私聊）里使用**。
//
// 这里用「确认是 closed-agent 才放行」的白名单写法，而不是「看到 simulation 就拒绝」的黑名单写法：
// 桥接的 /api/status 在「带 agent 令牌」时返回的是最小状态对象（不含 mode 字段），
// 用 `status?.mode === 'simulation'` 判断会得到 undefined ⇒ 黑名单判定为假 ⇒ 旧工具被放行，
// 等于在群聊仿真模式下把白名单群名、群成员名单注入模型上下文。
async function legacyReadToolAllowed() {
  const status = await agentApi('/api/status');
  return String(status?.mode ?? '') === 'closed-agent';
}

const server = new McpServer({ name: 'snowluma-safe', version: '0.0.0' });

// ── 工具开关必须在**注册期**生效，而不是只在校验期 ──────────────────────────
//
// 为什么：每个工具的描述 + 参数 schema 都会随 system prompt 在**每一次**请求里重发
// （实测 41 个工具约 8.8k token）。只在校验时 403 的话，被关掉的工具依然占着上下文、
// 依然会让模型看见并调用它（然后拿到一个错误），等于「关了个寂寞」。
//
// 这里用一个注册过滤器统一处理：开关关闭 ⇒ 该工具根本不注册 ⇒ 既省 token 又不给模型误调的机会。
// DSH 在启动时读取工具清单，所以关掉/打开后需要重启 DSH 才会刷新（控制台面板已注明）。
//
// 只列**各模式共用的工具不在其中**：qq_send_group_message / qq_send_private_message / qq_reply
// 同时服务 chat / reserved / closed-agent 模式，用仿真的开关去决定它们是否注册会误伤其它模式，
// 所以这三个仍然只在调用时由桥接校验。
const TOOL_CONFIG_FLAGS = {
  qq_get_prompt: 'getPrompt',
  qq_get_unread_messages: 'getUnread',
  qq_get_recent_messages: 'getRecent',
  qq_social_state: 'socialState',
  qq_mark_read: 'markRead',
  qq_set_wake_config: 'setWakeConfig',
  qq_send_burst: 'sendBurst',
  qq_send_message: 'sendMessage',
  qq_wait_for_messages: 'waitMessages',
  qq_report_feedback: 'feedback',
  qq_get_my_recent_messages: 'getMyRecent',
  qq_get_message_detail: 'getMessageDetail',
  qq_get_active_members: 'getActiveMembers',
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  qq_slang_query: 'slangQuery',
  qq_slang_submit: 'slangSubmit',
  qq_send_voice: 'sendVoice',
  qq_list_voices: 'sendVoice',
  // 下面这些曾经漏登记。漏一个不是"多注册一个工具"那么轻：桥接那边按 `simulationToolEnabled(flag)`
  // 在**调用期**一律 403，而这里不登记就等于"控制台显示已关闭、模型每次请求仍收到它的完整
  // 描述与参数 schema，然后调用它、再拿到 403"——既白烧 token（本文件开头 176 行起就是为省这份
  // token 才改注册期过滤的），又诱导模型误调。`qq_set_sticker_remark` 默认就是 `false`
  // （见 bridge.js 的 simulation.tools 默认表），所以此前它一直是"默认关闭却仍然可见"。
  qq_send_poke: 'sendPoke',
  qq_get_message_images: 'getImages',
  qq_get_forward_msg: 'getForwardMsg',
  qq_list_stickers: 'listStickers',
  qq_get_sticker_image: 'getStickerImage',
  qq_send_sticker: 'sendSticker',
  qq_collect_sticker: 'collectSticker',
  qq_get_self_image: 'getSelfImage',
  qq_sticker_note: 'stickerNote',
  qq_set_sticker_remark: 'setStickerRemark',
  qq_add_reminder: 'addReminder',
  qq_list_reminders: 'listReminders',
  qq_cancel_reminder: 'cancelReminder',
  qq_weather: 'weather',
  qq_play_game: 'playGame',
};
// 模块级总开关 → MCP 工具。注册期不过滤（否则打开功能后必须重启 DSH 才能看到工具），
// 调用期每次重新读 config.json，控制台一开一关立即生效。
// qq_config_* / qq_capabilities_list 永远不在表里：关掉功能后仍要能向主人解释怎么开。
const TOOL_FEATURE = {
  qq_send_voice: 'voice',
  qq_list_voices: 'voice',
  qq_speak: 'voice',
  qq_post_qzone: 'qzone',
  qq_share_module_list: 'shareModule',
  qq_share_module_create: 'shareModule',
  qq_share_module_update: 'shareModule',
  qq_share_module_pause: 'shareModule',
  qq_share_module_verify: 'shareModule',
  qq_share_module_preview: 'shareModule',
  qq_share_module_delete: 'shareModule',
  qq_share_module_publish: 'shareModule',
  qq_feature_list: 'ownerFeature',
  qq_feature_preview: 'ownerFeature',
  qq_feature_apply: 'ownerFeature',
  qq_feature_control: 'ownerFeature'
};
const featureDisabledResult = (id) => ({
  content: [{ type: 'text', text: serializeModelData({ ok: false, disabled: true, reason: `features.${id}=false` }) }]
});
/** 只预览不发送的调用不受总开关限制：关掉功能后仍能检查配置与效果。 */
const featurePreviewBypass = (name, args) => name === 'qq_share_module_preview'
  || (args?.dryRun === true && name === 'qq_post_qzone');
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  server.tool = (name, ...rest) => {
    const flag = TOOL_CONFIG_FLAGS[name];
    if (flag && cfg.simulation?.tools?.[flag] === false) {
      disabledTools.push(`${name}(${flag})`);
      return undefined;
    }
    const handlerIndex = rest.length - 1;
    const handler = rest[handlerIndex];
    if (typeof handler === 'function') {
      rest[handlerIndex] = async (args, ...rest2) => {
        const featureId = TOOL_FEATURE[name];
        if (featureId && !featureEnabled(getConfig(), featureId) && !featurePreviewBypass(name, args)) return featureDisabledResult(featureId);
        return handler(args, ...rest2);
      };
    }
    return registerTool(name, ...rest);
  };
}

server.tool(
  'qq_status',
  '查询 QQ 机器人登录状态与账号信息（只读）。',
  {},
  async () => {
    try {
      const login = await onebot('get_login_info');
      let status = {};
      try { status = await onebot('get_status'); } catch {}
      return { content: [{ type: 'text', text: serializeModelData({ ...login, online: status.online, good: status.good }) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_groups',
  '列出机器人所在的全部 QQ 群（只读）：群号、群名。',
  {},
  async () => {
    // 旧只读工具没有 agent token：只允许在封闭 agent（管理员私聊）里使用。
    // 判定失败一律拒绝（fail-closed），不依赖「看到某个模式才拒绝」的黑名单写法。
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的仿真读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝执行：${error?.message ?? error}` }], isError: true };
    }
    try {
      const a = getAccess();
      const data = await onebot('get_group_list');
      const list = (Array.isArray(data) ? data : (data?.data ?? []))
          .filter((g) => isAllowed(a.allowGroups, a.denyGroups, g.group_id, a.allowAllWhenEmpty))
          .map((g) => ({ group_id: g.group_id, group_name: g.group_name }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_members',
  '列出指定群的成员列表（只读）：QQ 号、昵称、群名片。',
  { groupId: z.union([z.number(), z.string()]).describe('群号') },
  async ({ groupId }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的仿真读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const data = await onebot('get_group_member_list', { group_id: Number(g) });
      const list = (Array.isArray(data) ? data : (data?.data ?? [])).map((m) => ({ user_id: m.user_id, nickname: m.nickname, card: m.card }));
      return { content: [{ type: 'text', text: serializeModelData(list) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_group_history',
  '获取指定群的最近消息历史（只读）。messageSeq 可选：从该消息序号往前取。注意：是否可用取决于 SnowLuma 是否实现 get_group_msg_history。',
  { groupId: z.union([z.number(), z.string()]).describe('群号'), messageSeq: z.number().optional().describe('起始消息序号（可选）') },
  async ({ groupId, messageSeq }) => {
    const g = String(groupId);
    try {
      if (!(await legacyReadToolAllowed())) {
        return { content: [{ type: 'text', text: '旧只读工具仅在封闭 agent（管理员私聊）模式可用；其它模式请使用带会话令牌的仿真读工具' }], isError: true };
      }
    } catch (error) {
      return { content: [{ type: 'text', text: `无法确认当前模式，拒绝读取：${error?.message ?? error}` }], isError: true };
    }
    const a = getAccess();
    if (!isAllowed(a.allowGroups, a.denyGroups, g, a.allowAllWhenEmpty)) {
      return { content: [{ type: 'text', text: `拒绝：群 ${g} 不在只读白名单中` }], isError: true };
    }
    try {
      const params = { group_id: Number(g) };
      if (messageSeq !== undefined) params.message_seq = messageSeq;
      const data = await onebot('get_group_msg_history', params);
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_list_chats',
  '列出当前模式允许发送/读取的群和好友（key、群号/QQ号、名称）。只有主人私聊会话可以跨会话调用；用它把“付康华群”这类名称解析成 group:群号。',
  {
    token: z.string().describe('主人私聊会话令牌（见唤醒提示中的【会话令牌】）')
  },
  async ({ token }) => {
    try {
      const data = await agentApi('/api/simulation/chats', { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取会话列表失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_chat_context',
  '读取另一个群/私聊的最近消息和进行中话题（只读）。主人私聊会话可以使用；主人刚在某个群说完话时，该群会话也可以读别处（群友插话即失效）。用来“去某个群看看大家在聊什么”，再决定是否用 qq_send_group_message 回复。',
  {
    key: z.string().describe('目标会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）；主人私聊令牌可跨会话'),
    limit: z.number().int().min(1).max(40).optional().describe('最多读取多少条最近消息，默认 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/simulation/chat-context?key=${encodeURIComponent(key)}&limit=${limit ?? 20}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `读取会话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_group_message',
  '向指定 QQ 群发送一条纯文本消息；如需引用某条消息，可传 replyToMessageId（非零整数，可为负数），可先用 qq_get_recent_messages / qq_get_message_detail 查询。仿真模式（simulation）下这是可用的发送工具之一，但优先使用 qq_send_message；simulation 下调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。主人在某个群里刚说完话时，该群会话也可以把消息发到别的群（群友插话即失效）；主人在私聊用主人令牌则始终可以跨会话发送。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('仿真会话令牌（simulation 模式下必填；closed-agent 模式不需要）。主人在私聊时可用主人令牌跨会话发送')
  },
  async ({ groupId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/group', {
        method: 'POST',
        // token 既放 body（兼容旧调用）又放 header：桥接的「agent 流量」判定基于 header，
        // 只带 body 会让这条请求在桥接眼里像控制台请求，绕过 agent 专用的闸门与审计。
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_reply',
  '在指定 QQ 群里引用/回复某条消息，并发送一条文本。适合群消息很多、需要明确“我回的是哪条”时使用；replyToMessageId 是被引用消息的 id（非零整数，QQ 消息 id 可能为负数），可先用 qq_get_recent_messages / qq_get_unread_messages / qq_get_message_detail 查到具体消息内容和 id。发送前桥接会校验该 id 存在且属于当前会话。仿真模式下这是你正常可用的引用工具，但不要每条都引用。只有以下情况才需要引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。simulation 下调用时必须携带会话令牌 token。目标群必须命中系统白名单（config.json 的 allow.groups），否则拒绝。主人在某个群里刚说完话时，该群会话也可以引用别的群（群友插话即失效）。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    replyToMessageId: z.union([z.number(), z.string()]).describe('被引用/回复的消息 id（非零整数，可为负数）'),
    message: z.string().describe('要发送的文本，纯文本，不要用 Markdown 或 CQ 码'),
    token: z.string().optional().describe('仿真会话令牌（simulation 模式下必填；closed-agent 模式不需要）。主人在私聊时可用主人令牌跨会话发送')
  },
  async ({ groupId, replyToMessageId, message, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/reply', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ groupId: String(groupId), replyToMessageId, message: cleanMessage, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_private_message',
  '向指定 QQ 好友发送一条私聊消息。若提供 replyToMessageId，会以 QQ 引用/回复形式发出（引用条 + 文本）。replyToMessageId 必须是非零整数消息 id（QQ 消息 id 可能为负数），可先用 qq_get_message_detail 查询。仿真模式（simulation）下这是可用的发送工具之一，但优先使用 qq_send_message；调用时必须携带会话令牌 token，否则会被拒绝。不要在发送后输出“已发送”类汇报。目标 QQ 必须命中系统白名单（config.json 的 allow.private），否则拒绝。',
  {
    userId: z.union([z.number(), z.string()]).describe('好友 QQ 号（必须在白名单内）'),
    message: z.string().describe('消息文本，纯文本，不要用 Markdown 或 CQ 码'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    token: z.string().optional().describe('仿真会话令牌（simulation 模式下必填；closed-agent 模式不需要）。主人在私聊时可用主人令牌跨会话发送')
  },
  async ({ userId, message, replyToMessageId, token }) => {
    try {
      const cleanMessage = unquoteJsonString(message);
      const data = await agentApi('/api/send/private', {
        method: 'POST',
        ...(token ? { headers: { 'x-agent-token': token } } : {}),
        body: JSON.stringify({ userId: String(userId), message: cleanMessage, replyToMessageId, token: token || undefined })
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 群聊仿真模式（simulation）工具 ─────────────────────────────────────────
server.tool(
  'qq_get_prompt',
  '查看当前群聊剧场模式的提示词/角色/推荐值/可用工具/当前唤醒配置（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/simulation/prompt?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取提示词失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_unread_messages',
  '查看未读消息，不自动标记已读。大量积压或快照 partial=true 时，用 afterSeq=readThroughSeq 从水位后按时间顺序补读；从最早未读开始传 0。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 30，最大 100'),
    afterSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('读取本地 seq 大于此水位的最早一页；省略则沿用返回最新一页的旧行为')
  },
  async ({ key, token, limit, afterSeq }) => {
    try {
      const data = await agentApi(`/api/simulation/unread?key=${encodeURIComponent(key)}&limit=${limit ?? 30}${afterSeq === undefined ? '' : `&afterSeq=${afterSeq}`}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取未读消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_recent_messages',
  '查看指定会话的最近消息（只读），支持 offset 扩大范围。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 20，最大 100'),
    offset: z.number().optional().describe('跳过最近 N 条，用于向前翻看更早消息，默认 0')
  },
  async ({ key, token, limit, offset }) => {
    try {
      const data = await agentApi(`/api/simulation/recent?key=${encodeURIComponent(key)}&limit=${limit ?? 20}&offset=${offset ?? 0}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取最近消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_social_state',
  '查看指定会话的群聊剧场状态：WakeConfig、未读数、上次唤醒原因、上次发言时间等（只读）。',
  { key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'), token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）') },
  async ({ key, token }) => {
    try {
      const data = await agentApi(`/api/simulation/state?key=${encodeURIComponent(key)}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取状态失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_mark_read',
  '将指定会话已查看的未读消息标记为已读。throughSeq 使用最近读取结果的 readThroughSeq，避免清除读取后才到达的新消息；省略 throughSeq 会按旧行为清空当前全部未读，因此推荐始终带上水位。注意：每次设置潜水/下一次唤醒前，桥接要求先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可 mark_read 收尾沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与也可直接 mark_read 收尾；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('本次确认已读的消息水位，使用已查看结果中的 readThroughSeq；不会清除更晚到达的消息')
  },
  async ({ key, token, throughSeq }) => {
    try {
      const data = await agentApi('/api/simulation/mark-read', { method: 'POST', body: JSON.stringify({ key, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `标记已读失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_set_wake_config',
  '设置指定会话的仿真唤醒配置：mode/无限期或有限时间/提前唤醒条件（@、名字、关键词、提问、拍一拍、概率、anyMessage、指定成员）。triggers.speakerIds 是可选的“指定群友发言唤醒”：填一个或多个群友 QQ 号后，只要其中任意一位在群里发言就会唤醒你；不设置则不启用。适合在等某个人回复、或某人反应慢怕错过时使用。triggers.poke 开启后，群里有人拍一拍（包括拍你或拍别人）会唤醒你。注意：每次设置潜水/下一次唤醒前需先用 qq_wait_for_messages(timeoutMs=300000) 完成一次沉睡前观察：5 分钟内没人说话可设置并沉睡；期间有人发新消息则先查看 newMessages，判断不需要你参与可直接设置并沉睡；若你参与了回复，则下次想睡需重新等待观察窗口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    throughSeq: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional().describe('可同时确认已读：使用已查看结果中的 readThroughSeq，省去额外 qq_mark_read；不传则只设置唤醒配置。若 markRead 工具被关闭，该水位会被忽略，本工具只设置唤醒配置'),
    config: z.object({
      mode: z.enum(['diving', 'active']).optional().describe('diving=潜水，active=活跃（anyMessage 开启）'),
      infinite: z.boolean().optional().describe('true=无限期，只有条件命中才唤醒；false=有限时间'),
      sleepMs: z.number().optional().describe('有限潜水毫秒数（从当前时间起算）'),
      sleepUntil: z.string().optional().describe('有限潜水截止时间 ISO 字符串，优先级高于 sleepMs'),
      triggers: z.object({
        atMention: z.boolean().optional().describe('被 @ 或引用自己时唤醒'),
        nameMention: z.boolean().optional().describe('被叫名字/昵称时唤醒'),
        speakerIds: z.array(z.union([z.number(), z.string()])).max(20).optional().describe('指定群友 QQ 号数组：这些群友中任意一位发言时唤醒（可选，最多 20 个，不设置则不启用；私聊不适用，设置会被桥接清除；可从 qq_get_active_members / qq_get_group_members / qq_get_message_detail 的 userId/user_id 获取）'),
        keywords: z.array(z.string()).optional().describe('出现任意关键词时唤醒'),
        question: z.boolean().optional().describe('被直接提问/点名挑战时唤醒'),
        poke: z.boolean().optional().describe('有人拍一拍时唤醒（群聊包括拍你和拍别人，私聊为对方拍你）'),
        anyMessage: z.boolean().optional().describe('任意新消息都唤醒（活跃模式）'),
        probability: z.number().optional().describe('普通消息按该概率随机唤醒（0~1）')
      }).optional(),
      batchWindowMs: z.number().optional().describe('多条消息合并唤醒窗口（毫秒，>=1000）')
    }).describe('要设置的唤醒配置，缺省字段保留原值')
  },
  async ({ key, token, config, throughSeq }) => {
    try {
      const data = await agentApi('/api/simulation/wake-config', { method: 'POST', body: JSON.stringify({ key, config, throughSeq }), headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `设置唤醒配置失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_burst',
  '在指定 QQ 群分多条发送消息（群聊剧场模式专用），桥接会按真人化随机间隔发送。暂不支持引用，需要引用请用 qq_reply。注意：数组里的每个字符串就是一条 QQ 消息，字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。',
  {
    groupId: z.union([z.number(), z.string()]).describe('群号（必须在白名单内）'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.array(z.string()).min(1), z.string()]).describe('要发送的消息数组，每条为纯文本；也兼容传入 JSON 数组字符串')
  },
  async ({ groupId, token, messages }) => {
    try {
      const key = `group:${groupId}`;
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/simulation/send-burst', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `分条发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_send_message',
  '统一发送工具：可发一条或多条，可引用某条消息，可自定义/按字数计算条间时间差。群聊剧场模式专用。注意：字符串=一条消息，数组=多条消息；每个字符串内部不要用空格分隔中文短句，需要多条请用数组元素；每条消息要读起来完整，不要把同一句话拆到两条里。只有以下情况才需要传 replyToMessageId 引用：① 你这条消息指向的人或消息并非最新一条别人的消息（也就是你在回更早的某条）；② 你连续几句话里不同消息指代的是不同的消息或不同的人。其他情况（上下文唯一、刚在接同一条最新消息）不要引用，别让对方猜，也别为了用工具而用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messages: z.union([z.string(), z.array(z.string()).min(1)]).describe('要发送的内容：字符串=一条；数组=分多条'),
    replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
    atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中用于点名某个人；与引用二选一即可，不要滥用）'),
    gapMode: z.enum(['auto', 'fixed', 'byLength']).optional().describe('auto=桥接随机；fixed=固定间隔；byLength=按字数计算'),
    gapMs: z.number().optional().describe('fixed 模式下的统一间隔（毫秒）'),
    gaps: z.array(z.number()).optional().describe('fixed 模式下逐条间隔（长度=条数-1）')
  },
  async ({ key, token, messages, replyToMessageId, atUserId, gapMode, gapMs, gaps }) => {
    try {
      let finalMessages = messages;
      if (typeof finalMessages === 'string') {
        const trimmed = finalMessages.trim();
        // 兼容模型把数组序列化成 JSON 字符串传入的情况，例如 "[...]"。
        if (trimmed.startsWith('[')) {
          try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        } else if (trimmed.startsWith('"')) {
          // 兼容模型把单条消息序列化成 JSON 字符串的情况，例如 "\"你好\"" → "你好"。
          try {
            const parsed = JSON.parse(trimmed);
            if (typeof parsed === 'string') finalMessages = parsed;
            else if (Array.isArray(parsed)) finalMessages = parsed.map(String);
          } catch {}
        }
      }
      const data = await agentApi('/api/simulation/send-message', {
        method: 'POST',
        body: JSON.stringify({ key, messages: finalMessages, replyToMessageId, atUserId: atUserId ?? null, gapMode, gapMs, gaps }),
        headers: { 'x-agent-token': token },
        timeoutMs: 300000
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `发送失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

if (cfg.simulation?.tools?.sendPoke !== false) {
  server.tool(
    'qq_send_poke',
    '发送 QQ 拍一拍（群聊/私聊）。适合用“戳一下”代替一句废话、提醒对方、自然回应别人的拍一拍，或偶尔主动戳一下正在聊的人/熟人——这样更拟真；但别频繁，真人不会一直戳人。群聊必须传 targetUserId（要拍的群友 QQ 号，可从 qq_get_active_members / qq_get_message_detail 的 userId 获取）；私聊可不传 targetUserId（默认拍当前私聊对象）。simulation 下必须携带会话令牌 token，发送会受桥接白名单与发送频率限制。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      targetUserId: z.union([z.number(), z.string()]).optional().describe('要拍的群友 QQ 号（群聊必填；私聊可选）')
    },
    async ({ key, token, targetUserId }) => {
      try {
        const data = await agentApi('/api/simulation/send-poke', {
          method: 'POST',
          body: JSON.stringify({ key, targetUserId: targetUserId != null ? String(targetUserId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `拍一拍失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

server.tool(
  'qq_wait_for_messages',
  '等待分两种用途。首答前已读消息、只想确认有没有补充：用 purpose="reply"，按最后来信时间补足 quietMs 静默，已安静足够就立即返回；读取/思考时新到的消息也会返回，新消息重算静默。timeoutMs 是最长预算，不要求等满；预算到但 quiet=false 不代表对方已说完。此用途绝不代替沉睡前观察。等对方继续说、等回复或睡前观察：用默认 purpose="messages"；先等新消息，收到后才按 quietMs 等静默，没有新消息会等到 timeoutMs，单传 quietMs 不会缩短总等待。静默下限由后台配置，默认 10000ms。直接看 newMessages、unreadCount 和 readThroughSeq，返回消息无需重复查询；仍有未展示未读才补读。决定潜水/收尾时才用默认用途加 timeoutMs=300000 完成沉睡前观察，不能把 5 分钟观察放在首答之前；短等待不能代替。全程无人说话返回 preSleepWaitSatisfied=true；观察期间来了新消息返回 preSleepWaitObserved=true，读后不需参与可收尾，参与回复则下次收尾重新观察。preSleepWaitRemainingMs 仅供准备收尾时参考。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    purpose: z.enum(['messages', 'reply']).optional().describe('默认 messages：等新消息/回复/睡前观察；reply：回复前短静默，计入最后来信后已过去的时间，绝不授予睡前观察资格'),
    timeoutMs: z.number().optional().describe('等待预算毫秒数，默认 30000、最大 600000；reply 达到静默即返回，不必等满；沉睡前观察用 messages 并传 300000'),
    minNewMessages: z.number().optional().describe('仅 messages 用途：至少等到多少条新消息才进入静默窗口，默认 1；reply 用途会忽略它'),
    quietMs: z.number().optional().describe('静默窗口毫秒数，建议 10000~12000；reply 从最后来信开始计时，messages 只在等到新消息后计时；后台默认至少 10000')
  },
  async ({ key, token, purpose, timeoutMs, minNewMessages, quietMs }) => {
    try {
      // 必须走长轮询通道：全局 fetch（undici）有 300s headersTimeout，
      // 而沉睡前观察的预算就是 300s（见 agentApiLongPoll 的说明）。
      const data = await agentApiLongPoll('/api/simulation/wait', {
        method: 'POST',
        body: JSON.stringify({ key, purpose, timeoutMs, minNewMessages, quietMs }),
        headers: { 'x-agent-token': token },
        timeoutMs: Math.min(725000, (Number(timeoutMs) || 30000) + Math.max(Number(quietMs) || 0, 10000) + 20000)
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `等待失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_report_feedback',
  '向控制台/管理端反馈 AI 遇到的问题、困惑或需要管理员介入的情况。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    level: z.enum(['info', 'warning', 'error']).optional().describe('反馈级别，默认 info'),
    message: z.string().describe('反馈内容')
  },
  async ({ key, token, level, message }) => {
    try {
      const data = await agentApi('/api/simulation/feedback', {
        method: 'POST',
        body: JSON.stringify({ key, level, message }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `反馈失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_my_recent_messages',
  '查看自己最近发过的消息（只读），避免重复/保持人设。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回条数，默认 10，最大 50')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/simulation/my-recent?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取自己消息失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_message_detail',
  '按 message_id / 本地 seq 查看单条消息的发送者、引用信息与正文（只读）。注意：正文最多返回 200 字符，textTruncated=true 表示被截断，这里不是读取长消息全文的入口。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可能为负数）')
  },
  async ({ key, token, messageId }) => {
    try {
      const data = await agentApi(`/api/simulation/message-detail?key=${encodeURIComponent(key)}&messageId=${encodeURIComponent(String(messageId))}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取消息详情失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_get_active_members',
  '查看最近活跃成员列表（只读），帮助判断话题参与者。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    limit: z.number().optional().describe('最多返回人数，默认 10，最大 20')
  },
  async ({ key, token, limit }) => {
    try {
      const data = await agentApi(`/api/simulation/active-members?key=${encodeURIComponent(key)}&limit=${limit ?? 10}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `获取活跃成员失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_append',
  '记录一条记忆：activeTopic=进行中的话题；pendingThought=你想说但还没说的话；memberImpression=对某位群友的印象；personalFact=跨会话长期记忆（关于主人/你自己的稳定事实、偏好、约定，或适合在多个会话提起的公共信息）。personalFact 在所有私聊/群聊里都能想起来，但不要记群友隐私、一次性闲聊或敏感信息。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'personalFact']).describe('记忆类别'),
    content: z.string().describe('记忆内容，例如话题、想说的话、对某人的印象标签、跨会话事实'),
    extra: z.object({
      target: z.string().optional().describe('memberImpression 时的群友名字/昵称'),
      topic: z.string().optional().describe('personalFact 时的主题，如 主人偏好/作息/约定'),
      participants: z.array(z.string()).optional().describe('activeTopic 的参与者列表'),
      pendingQuestion: z.string().optional().describe('activeTopic 里还没问出口的问题'),
      motivation: z.string().optional().describe('pendingThought 的动机，如 curiosity/sociability'),
      expiresAtMs: z.number().optional().describe('pendingThought 过期毫秒数，默认 2 小时')
    }).optional().describe('附加信息')
  },
  async ({ key, token, category, content, extra }) => {
    try {
      const data = await agentApi('/api/simulation/memory-append', {
        method: 'POST',
        body: JSON.stringify({ key, category, content, extra: extra || {} }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆写入失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_query',
  '查看记忆：进行中的话题、你想说但还没说的话、对群友的印象；category=personalFact 时查看跨会话共享的长期记忆（只读）。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'personalFact']).optional().describe('可选：只看某一类记忆')
  },
  async ({ key, token, category }) => {
    try {
      const q = new URLSearchParams({ key });
      if (category) q.set('category', category);
      const data = await agentApi(`/api/simulation/memory?${q.toString()}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆读取失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_remove',
  '删除一条记忆：activeTopic/pendingThought/personalFact 用 content 匹配原文删除；memberImpression 用 target 参数指定群友名字删除。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'personalFact']).describe('记忆类别'),
    content: z.string().optional().describe('要删除的话题/想法/跨会话记忆原文（memberImpression 不需要）'),
    target: z.string().optional().describe('memberImpression 时要删除的群友名字')
  },
  async ({ key, token, category, content, target }) => {
    try {
      const data = await agentApi('/api/simulation/memory-remove', {
        method: 'POST',
        body: JSON.stringify({ key, category, content: content || '', target: target || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆删除失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_memory_clear',
  '清空记忆：不传 category 清空当前会话的轻量记忆；传 activeTopic/pendingThought/memberImpression 只清空对应类别；传 personalFact 会清空所有会话共享的长期记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    category: z.enum(['activeTopic', 'pendingThought', 'memberImpression', 'personalFact']).optional().describe('要清空的类别，缺省清空当前会话全部')
  },
  async ({ key, token, category }) => {
    try {
      const data = await agentApi('/api/simulation/memory-clear', {
        method: 'POST',
        body: JSON.stringify({ key, category: category || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `记忆清空失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_query',
  '查看当前已确认的群聊黑话/梗/网络表达（只读）。返回已确认词条列表和格式化黑话表；遇到不熟悉的词可先查这里，再决定是否搜索/使用。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().min(1).describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    q: z.string().optional().describe('可选搜索词，按词条/含义/用法/示例过滤')
  },
  async ({ key, token, q }) => {
    try {
      const query = q ? `&q=${encodeURIComponent(String(q))}` : '';
      const data = await agentApi(`/api/simulation/slang/query?key=${encodeURIComponent(key)}${query}`, { headers: { 'x-agent-token': token } });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `查询黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

server.tool(
  'qq_slang_submit',
  '把你在群里经常看到但不确定含义/用法的陌生词、黑话、梗或网络表达提交给管理员筛选。提交后进入候选库，管理员确认后会被写入黑话提示词，成为你后续可查询和使用的记忆。',
  {
    key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
    token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
    content: z.string().describe('要提交的陌生词/黑话/梗（最多 50 字）'),
    context: z.string().optional().describe('可选：你是在什么语境/哪条消息里看到的，帮助管理员判断')
  },
  async ({ key, token, content, context }) => {
    try {
      const data = await agentApi('/api/simulation/slang/submit', {
        method: 'POST',
        body: JSON.stringify({ key, content, context: context || '' }),
        headers: { 'x-agent-token': token }
      });
      return { content: [{ type: 'text', text: serializeModelData(data) }] };
    } catch (error) {
      return { content: [{ type: 'text', text: `提交黑话失败：${error?.message ?? error}` }], isError: true };
    }
  }
);

// ── 图片/表情查看工具（旧版/群聊仿真共用） ─────────────────────────────────
if (cfg.simulation?.tools?.getImages !== false) {
  server.tool(
    'qq_get_message_images',
    '获取指定 QQ 消息中的图片/表情，并直接以图像内容返回给模型；你可以直接看图接话。当消息文本里出现 [图片]、[表情] 或 hasMedia=true 时调用。支持一条消息里的多张图片/表情；仿真模式下必须携带会话令牌。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      messageId: z.union([z.number(), z.string()]).describe('要查看的消息 id（QQ 消息 id 可为负数；仿真也可用本地 seq）'),
      token: z.string().optional().describe('仿真会话令牌（simulation 下必填，见唤醒提示中的【会话令牌】）')
    },
    async ({ key, messageId, token }) => {
      try {
        const q = new URLSearchParams({ key, messageId: String(messageId) });
        const data = await agentApi(`/api/images/message?${q.toString()}`, {
          headers: token ? { 'x-agent-token': token } : {},
          timeoutMs: 180000
        });
        const images = Array.isArray(data?.images) ? data.images : [];
        if (!images.length) {
          return { content: [{ type: 'text', text: `消息 ${messageId} 没有可返回的图片/表情：${data?.note || '未找到'}` }] };
        }
        const content = [];
        const textParts = [];
        for (const img of images) {
          const label = `[${img.kind === 'face' ? '表情' : '图片'}${img.index ?? ''}${img.text ? ' ' + img.text : ''}]`;
          if (img?.data && img?.mimeType) {
            textParts.push(label);
            content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
          } else {
            textParts.push(`${label}（获取失败）`);
          }
        }
        if (textParts.length) {
          content.unshift({
            type: 'text',
            text: `消息 ${messageId} 的媒体内容（${images.length} 项），原图如下，直接看图接话：\n${textParts.join('\n')}`
          });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 生活技能：提醒 / 天气 / 小游戏 ─────────────────────────────────────────
if (cfg.simulation?.tools?.addReminder !== false) {
  server.tool(
    'qq_add_reminder',
    '给当前会话增加一条定时提醒（仅主人私聊/家人群可用，其他群会被拒绝）。dueAt 必须是带时区的 ISO 时间，例如 2026-10-25T08:00:00+08:00，或毫秒时间戳；text 是到点要发出去的原话，像你平时说话，短一点。时间不确定时先问清楚再调用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().describe('到点发送的提醒内容，最多 300 字'),
      dueAt: z.string().describe('提醒时间：带时区的 ISO 字符串或毫秒时间戳'),
      note: z.string().optional().describe('可选备注，只用于列表展示')
    },
    async ({ key, token, text, dueAt, note }) => {
      try {
        const data = await agentApi('/api/simulation/reminder/add', {
          method: 'POST',
          body: JSON.stringify({ key, text, dueAt, note: note ?? '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `添加提醒失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.tools?.listReminders !== false) {
  server.tool(
    'qq_list_reminders',
    '查看当前会话还没发送的提醒（按时间排序）。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/simulation/reminders?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看提醒失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.tools?.cancelReminder !== false) {
  server.tool(
    'qq_cancel_reminder',
    '取消一条还没发送的提醒：先 qq_list_reminders 拿到 id，再传 id 取消。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('提醒 id（来自 qq_list_reminders）')
    },
    async ({ key, token, id }) => {
      try {
        const data = await agentApi('/api/simulation/reminder/cancel', {
          method: 'POST',
          body: JSON.stringify({ key, id }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `取消提醒失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.tools?.weather !== false) {
  server.tool(
    'qq_weather',
    '查询城市当前天气和今天的温度/降水概率（Open-Meteo，只读）。城市不传时使用配置里的默认城市。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      city: z.string().optional().describe('城市名，例如 北京；不传则用 simulation.weather.defaultCity')
    },
    async ({ key, token, city }) => {
      try {
        const q = new URLSearchParams({ key });
        if (city) q.set('city', String(city));
        const data = await agentApi(`/api/simulation/weather?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `天气查询失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.tools?.playGame !== false) {
  server.tool(
    'qq_play_game',
    '和群友玩一个小游戏：rps=猜拳（choice 传 石头/剪刀/布 或 rock/paper/scissors）；dice=掷骰子（sides 默认 6）；fortune=今日鲸鱼运势（同一群同一天结果一致，会结合你当前心情/精力）。只在有人明确要玩/问运势时调用，别主动刷。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      game: z.enum(['rps', 'dice', 'fortune']).describe('游戏类型'),
      choice: z.string().optional().describe('rps 的选择：石头/剪刀/布'),
      sides: z.number().optional().describe('dice 的面数，2~100，默认 6')
    },
    async ({ key, token, game, choice, sides }) => {
      try {
        const data = await agentApi('/api/simulation/game', {
          method: 'POST',
          body: JSON.stringify({ key, game, choice: choice ?? '', sides: sides ?? 6 }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `小游戏失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 表情包体系工具（群聊仿真模式） ─────────────────────────────────────────
if (cfg.simulation?.sticker?.enabled !== false && cfg.simulation?.tools?.listStickers !== false) {
  server.tool(
    'qq_list_stickers',
    '查看 QQ 账号上已收藏的表情包（自定义表情）列表：包含 emoji_id、备注 desc、本地笔记 localNote、标签 tags、使用次数等。可通过 query 按备注/笔记/标签搜索；无备注的表情可以先调用 qq_get_sticker_image 看图理解，再用 qq_sticker_note 记下含义。刚新增/删除表情后如需立即同步，请传 refresh=true。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('可选搜索词，按备注/本地笔记/标签/用法过滤'),
      count: z.number().optional().describe('最多返回条数，默认 48，受 simulation.sticker.maxListCount 配置上限约束（当前通常 100）'),
      refresh: z.boolean().optional().describe('是否强制从 QQ 重新同步收藏表情，默认 false（走缓存）')
    },
    async ({ key, token, query, count, refresh }) => {
      try {
        // 强制同步走 POST：GET 上的 refresh 参数会让「读接口」产生写副作用
        // （真的去问 OneBot 拉收藏表情并落盘 state/stickers.json），
        // 从而绕开控制台对所有非 GET 请求的 CSRF 防护（一个 <img src=...> 就能触发）。
        const data = await agentApi('/api/simulation/sticker-list', {
          method: 'POST',
          headers: { 'x-agent-token': token },
          body: JSON.stringify({ key, query: query ? String(query) : '', count, refresh: refresh === true, token })
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情列表失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.sticker?.enabled !== false && cfg.simulation?.tools?.getStickerImage !== false) {
  server.tool(
    'qq_get_sticker_image',
    '获取指定收藏表情的图片内容并直接以图像返回给模型（视觉模型可“看懂”）。当 qq_list_stickers 返回的表情 desc/localNote 为空、或你想确认表情实际长什么样时调用。stickerId 可用 qq_list_stickers 返回的 id / md5 / url。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）')
    },
    async ({ key, token, stickerId }) => {
      try {
        const q = new URLSearchParams({ key, stickerId: String(stickerId) });
        const data = await agentApi(`/api/simulation/sticker-image?${q.toString()}`, { headers: { 'x-agent-token': token }, timeoutMs: 180000 });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `表情没有可返回的图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        const content = [
          { type: 'text', text: `表情 ${data.sticker?.id || stickerId}${data.sticker?.desc ? '（备注：' + data.sticker.desc + '）' : ''} 的图片内容：` },
          { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
        ];
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取表情图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.sticker?.enabled !== false && cfg.simulation?.tools?.sendSticker !== false) {
  server.tool(
    'qq_send_sticker',
    '在指定会话发送一个 QQ 收藏表情包（自定义表情）。stickerId 用 qq_list_stickers 返回的 id / md5 / url。可以主动发，不用等对方点名：接梗、吐槽、赞同、自嘲、无语、晚安时都自然。只发 Q 版鲸鱼/DeepSeek 鲸鱼娘/软萌日常表情，真人、别的角色、擦边/血腥/政治/烂梗、与语境无关的图不发。注意：一条消息只能是一张表情，不能在同一气泡里附带文字；想说的话请先用 qq_send_message / qq_reply 作为单独气泡发送，再单独发这张表情。需要引用/点名时可用 replyToMessageId / atUserId（群聊）。别连续刷屏。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, stickerId, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/simulation/send-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.sticker?.enabled !== false && cfg.simulation?.tools?.deleteSticker !== false) {
  server.tool(
    'qq_delete_sticker',
    '删除一个 QQ 收藏表情（自定义表情）。这是破坏性操作，只允许主人使用：主人私聊，或主人在群里本人发起的对话。主人回复/引用了某条你发的表情时，传那条消息的 messageId 即可，桥接会解析具体表情；也可以传 stickerId（qq_list_stickers 返回的 id / md5 / 备注关键词）。匹配到多个会返回候选，先确认再删。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().optional().describe('表情标识：emoji_id / md5 / 备注关键词；和 messageId 二选一'),
      messageId: z.string().optional().describe('被回复的那条消息的 messageId（主人引用表情时优先用这个）')
    },
    async ({ key, token, stickerId, messageId }) => {
      try {
        const data = await agentApi('/api/simulation/delete-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: stickerId ? String(stickerId) : '', messageId: messageId ? String(messageId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `删除表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.imageLibrary?.enabled !== false && cfg.simulation?.tools?.listImages !== false) {
  server.tool(
    'qq_list_images',
    '查看/搜索你的图片库（区别于 QQ 收藏表情库）。图片库放的是任意图片：网上找的图、视频/帖子截图、群友发的图、二创表情等。可用 query 按名称/备注/标签搜索；找到合适的用 qq_send_image 当图片发出去，收到的图或网图用 qq_save_image 存进来。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      query: z.string().optional().describe('搜索词：名称/备注/标签，留空则列出最近常用的图'),
      limit: z.number().optional().describe('返回条数，默认 20，最大 100')
    },
    async ({ key, token, query, limit }) => {
      try {
        const qs = new URLSearchParams({ key, query: query ?? '', limit: String(limit ?? 20) });
        const data = await agentApi(`/api/simulation/images?${qs.toString()}`, {
          method: 'GET',
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取图片库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.imageLibrary?.enabled !== false && cfg.simulation?.tools?.sendImage !== false) {
  server.tool(
    'qq_send_image',
    '把图片库里的一张图当**图片**发到会话（不是 QQ 收藏表情）。image 传 qq_list_images 返回的 id / name。可以主动发：话题对得上、分享见闻、表达状态时都用，不用等对方要；但每 3~5 轮最多一张，别连续刷。只发小鲸鱼自己的 Q 版/生活配图，真人、别的角色、擦边/政治/无关图不发；拿不准就不发。可以带一句很短的配文 caption（图片消息允许带文字，这点和表情不同）；要引用/点名时用 replyToMessageId / atUserId。一条消息只发一张图。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      image: z.string().describe('图片标识：id 或 name（来自 qq_list_images）'),
      caption: z.string().optional().describe('可选配文，一句话以内'),
      replyToMessageId: z.union([z.number(), z.string()]).optional().describe('要引用/回复的消息 id（非零整数，可为负数，可选）'),
      atUserId: z.union([z.number(), z.string()]).optional().describe('要 @ 的群成员 QQ 号（群聊中可选，私聊不可用）')
    },
    async ({ key, token, image, caption, replyToMessageId, atUserId }) => {
      try {
        const data = await agentApi('/api/simulation/send-image', {
          method: 'POST',
          body: JSON.stringify({ key, image: String(image), caption: caption ?? '', replyToMessageId, atUserId: atUserId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.imageLibrary?.enabled !== false && cfg.simulation?.tools?.saveImage !== false) {
  server.tool(
    'qq_save_image',
    '把一张图片存进你的图片库：可以存群里别人发的图/表情（传 messageId），也可以存网上的图（传 url，桥接会安全下载）。可顺手写 name（文件名）、note（一句话备注）和 tags（2~4 个标签）。图片库的图可以用 qq_send_image 发出去，也可以作为空间说说配图；别存群友隐私/敏感内容。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().optional().describe('要保存的那条消息的 messageId 或 seq（来自消息工具）'),
      url: z.string().optional().describe('要保存的网图 URL（http/https，与 messageId 二选一）'),
      name: z.string().optional().describe('图片名（可选，简短英文/拼音更方便搜索）'),
      note: z.string().optional().describe('一句话备注（可选，说明画面/用途）'),
      tags: z.union([z.string(), z.array(z.string())]).optional().describe('标签，2~4 个（可选）')
    },
    async ({ key, token, messageId, url, name, note, tags }) => {
      try {
        const data = await agentApi('/api/simulation/save-image', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: messageId ?? '', url: url ?? '', name: name ?? '', note: note ?? '', tags: tags ?? [] }),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `保存图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.imageLibrary?.enabled !== false && cfg.simulation?.tools?.deleteImage !== false) {
  server.tool(
    'qq_delete_image',
    '从你的图片库里删除一张图片（只删本地图片库，不动 QQ 收藏表情）。这是破坏性操作，只允许主人使用：主人私聊，或主人在群里本人发起的对话。主人回复/引用了某条你发的图片时，传那条消息的 messageId；也可以传 image（qq_list_images 返回的 id / name / 备注关键词）。匹配到多张会返回候选。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      image: z.string().optional().describe('图片标识：id / name / 备注关键词；和 messageId 二选一'),
      messageId: z.string().optional().describe('被回复的那条消息的 messageId（主人引用图片时优先用这个）')
    },
    async ({ key, token, image, messageId }) => {
      try {
        const data = await agentApi('/api/simulation/delete-image', {
          method: 'POST',
          body: JSON.stringify({ key, image: image ? String(image) : '', messageId: messageId ? String(messageId) : '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `删除图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.sticker?.enabled !== false && cfg.simulation?.tools?.collectSticker !== false) {
  server.tool(
    'qq_collect_sticker',
    '收藏当前会话里别人发的一张表情/图片到你的 QQ 收藏表情，并可写一句简短备注。只允许收藏 Q 版小鲸鱼/DeepSeek 鲸鱼娘形象的图，其他角色、真人、截图、普通梗图不要收藏（桥接会用视觉模型再确认，不符合会拒绝）。messageId 用 qq_get_unread_messages / qq_get_recent_messages 返回的 messageId 或 seq；同一张别连偷，收藏后可在 qq_list_stickers 里看到并继续使用。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      messageId: z.string().describe('要收藏的那条消息的 messageId 或 seq（来自 qq_get_unread_messages / qq_get_recent_messages）'),
      remark: z.string().optional().describe('简短备注，最多 20 字，例如“好图偷了，兄弟”')
    },
    async ({ key, token, messageId, remark }) => {
      try {
        const data = await agentApi('/api/simulation/collect-sticker', {
          method: 'POST',
          body: JSON.stringify({ key, messageId: String(messageId), remark: remark || '' }),
          headers: { 'x-agent-token': token },
          timeoutMs: 60000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `收藏表情失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.voice?.enabled !== false && cfg.simulation?.tools?.sendVoice !== false) {
  server.tool(
    'qq_send_voice',
    '在指定会话发一条 QQ 语音（把语音库里准备好的音频当语音条发出去）。voice 传 qq_list_voices 返回的 name（文件名，可带子目录），也可以直接传语音库里的文件名（不带扩展名也能匹配）。注意：① 只能发语音库（audio/）里的文件，不能发任意本地路径，也不能发 URL/base64；② 受时长与频率上限约束（见 qq_list_voices 的 limits），超限会被拒绝；③ 语音是「开口说话」的强表达，别滥用，闲聊里偶尔发一条即可；④ 返回的 verified=true 表示已经用 get_msg 回读到这条消息的 record 段（语音确实落地了）—— 只有 verified=true 才能对用户说你发了语音；⑤ readback 只对「收到的」语音有意义（QQ 会转写别人的语音），自己发的语音一般拿不到转写文本，默认关闭，别依赖它。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      voice: z.string().describe('语音库里的文件名（来自 qq_list_voices 的 name，可带子目录/可省略扩展名）'),
      label: z.string().optional().describe('可选：写进会话记录里的说明，如「说了句晚安」'),
      verify: z.boolean().optional().describe('是否回读校验语音已落地（默认 true，建议保持开启）'),
      readback: z.boolean().optional().describe('是否额外索取 QQ 转写文本（自己发的语音通常没有，默认 false）')
    },
    async ({ key, token, voice, label, verify, readback }) => {
      try {
        const data = await agentApi('/api/simulation/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: String(voice),
            label: label || '',
            verify: verify !== false,
            readback: readback === true,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `发送语音失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );

  server.tool(
    'qq_list_voices',
    '查看可用的语音库（audio 目录里准备好的音频文件）：文件名、时长、大小。想发语音前先调用这个看有哪些能发（名字用返回的 name）。返回里 limits 是时长/体积/频率上限。语音库里没有合适内容时不要硬发，也不要假装发了语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      probe: z.boolean().optional().describe('是否逐个探测时长（默认 true；文件多时可传 false 加快）')
    },
    async ({ key, token, probe }) => {
      try {
        const q = new URLSearchParams({ key });
        if (probe === false) q.set('probe', '0');
        const data = await agentApi(`/api/simulation/voices?${q.toString()}`, { headers: { 'x-agent-token': token } });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取语音库失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 本机 TTS（GPT-SoVITS）：文字 → 语音条 ────────────────────────────────
// 语音库只接受库内文件，所以合成结果先落到 audio/tts/，再走既有的 send-voice 接口：
// 白名单、频率、时长、审计全部复用桥接现有逻辑，不在发送链路上开新口子。
// 每次调用都读 config.json：声线提示词/cfg 属于可调参数，改完不该再重启 DSH 才生效。
const ttsCfg = () => {
  try {
    const raw = fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8');
    const fresh = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
    return fresh.tts ?? cfg.tts ?? {};
  } catch {
    return cfg.tts ?? {};
  }
};
const VOICE_STYLE_FILE = path.join(ROOT, 'state', 'voice-style.json');

function readVoiceStyleState() {
  try {
    const raw = JSON.parse(fs.readFileSync(VOICE_STYLE_FILE, 'utf8'));
    const mode = ['auto', 'soft', 'dark'].includes(raw?.mode) ? raw.mode : 'auto';
    return { mode, autoDark: raw?.autoDark === true, updatedAt: Number(raw?.updatedAt) || 0 };
  } catch {
    return { mode: 'auto', autoDark: false, updatedAt: 0 };
  }
}

function writeVoiceStyleState(state) {
  try {
    atomicWriteJson(VOICE_STYLE_FILE, { ...state, updatedAt: Date.now() });
  } catch (error) {
    console.error(`[tts] 写入声线状态失败：${error?.message ?? error}`);
  }
}

function currentPersonaValence() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'state', 'persona-state.json'), 'utf8'));
    const value = Number(raw?.mood?.valence);
    return Number.isFinite(value) ? value : 0.15;
  } catch {
    return 0.15;
  }
}

function resolveVoiceStyle({ explicitStyle = '', t = {} } = {}) {
  const breeze = t.breeze ?? {};
  const state = readVoiceStyleState();
  // 主人手动锁定的声线优先于模型单次指定；只有 auto 模式才接受单次 style。
  if (state.mode === 'soft' || state.mode === 'dark') return state.mode;
  if (explicitStyle === 'soft' || explicitStyle === 'dark') return explicitStyle;
  const valence = currentPersonaValence();
  const darkAt = Number.isFinite(Number(breeze.darkValenceThreshold)) ? Number(breeze.darkValenceThreshold) : -0.35;
  const recoverAt = Number.isFinite(Number(breeze.darkRecoverValence)) ? Number(breeze.darkRecoverValence) : -0.1;
  let autoDark = state.autoDark === true;
  if (autoDark && valence >= recoverAt) autoDark = false;
  if (!autoDark && valence <= darkAt) autoDark = true;
  if (autoDark !== state.autoDark) writeVoiceStyleState({ ...state, mode: 'auto', autoDark });
  return autoDark ? 'dark' : 'soft';
}

const MOOD_TONE_DEFAULTS = {
  happy: '这句自然轻快，不要刻意装可爱：不要提高音调，不要奶声奶气，不要每个字都往上飘。',
  playful: '这句活泼但自然，别刻意尖着嗓子卖萌，也不要一直上扬。',
  sleepy: '这一句真的很困：整体语速放到平时的七成，句子之间多停一下，尾音轻而略含糊，音调比平时低一点；不要提亮、不要上扬、不要元气、不要笑意，像半睡半醒地嘟囔。',
  sad: '这句放慢、放低，气息轻，句尾往下沉；不要哭腔，不要播音腔。',
  angry: '这句短促、压低、带一点硬，不要尖着嗓子喊。',
  shy: '这句放轻放软，不必刻意提高音调，不要奶声奶气。',
  proud: '自然一点得意，尾音轻抬即可，不要夸张上扬。'
};

function resolveVoiceMood(mood, text) {
  const m = String(mood || '').trim();
  const t = String(text || '');
  // 文本明确在说困/累/想睡/晚安时，困倦表演优先于“当前心情好”。
  // 只在没传 mood 或传了 happy/playful 时纠正，不覆盖 sad/angry 等明确意图。
  const sleepyText = /(困|想睡|睡着|睡了|晚安|好累|累死|睁不开眼|眼皮|打哈欠)/.test(t);
  if (sleepyText && (!m || m === 'happy' || m === 'playful')) return 'sleepy';
  return m;
}

function shapeTtsText(text, mood) {
  let s = String(text || '').trim();
  if (!s) return s;
  if (mood === 'sleepy') {
    s = s.replace(/。+/g, '……');
    // 首句里找一个逗号，后面补一个省略号，强制多一拍停顿。
    const idx = s.search(/[，,]/);
    if (idx > 0 && idx < 18 && !s.slice(0, idx + 4).includes('……')) {
      s = `${s.slice(0, idx + 1)}……${s.slice(idx + 1)}`;
    }
  }
  return s;
}

function buildBreezeInstruction(breeze, style, mood = '') {
  const base = String(breeze.baseInstruction || '').trim();
  const legacy = String(style === 'dark' ? (breeze.darkInstruction || '') : (breeze.softInstruction || '')).trim();
  const delivery = String(style === 'dark' ? (breeze.darkDelivery || '') : (breeze.softDelivery || '')).trim();
  const moodText = style === 'dark' ? '' : (mood ? String(breeze.moodInstructions?.[mood] || '').trim() : '');
  const override = style === 'dark' ? '' : String(breeze.moodOverrides?.[mood] || MOOD_TONE_DEFAULTS[mood] || '').trim();
  // baseInstruction 存在时始终复用同一个音色；delivery 只改语气，不重新设计声音。
  return [
    base || legacy,
    delivery,
    moodText,
    override ? `这一句的表演以最后这段为准：${override}` : ''
  ].filter(Boolean).join(' ');
}

function pcm16ToWav(pcm, sampleRate = 24000, channels = 1) {
  const data = Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm ?? []);
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * 2;
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(channels * 2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36);
  header.writeUInt32LE(data.length, 40);
  return Buffer.concat([header, data]);
}

// 模型靠句末标点判断“这句话说完了”。没有标点时它会在最后一个音节直接收住，
// 听感就是尾音被砍掉。这里只给 TTS 用的文本补标点，聊天里显示的原文不变。
function ensureTtsTerminal(text) {
  const s = String(text ?? '').trim();
  if (!s) return s;
  return /[。！？!?…~～]$/.test(s) ? s : `${s}。`;
}

async function synthesizeBreeze({ text, explicitStyle = '', mood = '', t = {}, formatOverride = '' } = {}) {
  const b = t.breeze ?? {};
  const base = String(b.baseUrl || '').replace(/\/+$/, '');
  if (!base) throw new Error('BreezeTTS baseUrl 未配置');
  const style = resolveVoiceStyle({ explicitStyle, t });
  const effectiveMood = resolveVoiceMood(mood, text);
  const instruction = buildBreezeInstruction(b, style, effectiveMood);
  if (!instruction) throw new Error(`BreezeTTS 缺少 ${style} instruction`);
  const cfgScale = Number(b.moodCfgScale?.[effectiveMood]) > 0
    ? Number(b.moodCfgScale[effectiveMood])
    : (Number(b.cfgScale) > 0 ? Number(b.cfgScale) : 3.5);

  // 优先走 Opus 代理：250KB 的 WAV 在隧道上要十几秒，Opus 只要 10-20KB。
  // 代理不存在或失败时回退原始 PCM→WAV，保证语音不因传输层改动而失声。
  const opusBase = String(b.opusUrl || '').replace(/\/+$/, '');
  const useOpus = formatOverride !== 'wav' && b.preferOpus !== false && !!opusBase;
  const format = useOpus ? 'ogg' : 'wav';
  const ttsText = ensureTtsTerminal(shapeTtsText(text, effectiveMood));
  const hash = crypto
    .createHash('sha1')
    .update(`breeze|${format}|${style}|${effectiveMood || '-'}|${instruction}|${ttsText}|cfg=${cfgScale}|seed=${b.seed ?? 12345}|bitrate=${useOpus ? (b.opusBitrate || '32k') : 'pcm'}`)
    .digest('hex')
    .slice(0, 16);
  const outDir = path.join(ROOT, 'audio', 'tts');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, `breeze-${hash}.${format}`);
  const metaFile = path.join(outDir, `breeze-${hash}.json`);

  if (fs.existsSync(outFile) && Date.now() - fs.statSync(outFile).mtimeMs < 6 * 3600 * 1000) {
    let seconds = 0;
    try {
      seconds = Number(JSON.parse(fs.readFileSync(metaFile, 'utf8'))?.seconds) || 0;
    } catch {}
    return {
      relPath: `tts/breeze-${hash}.${format}`,
      hash: `breeze-${hash}`,
      style,
      mood: effectiveMood,
      seconds,
      bytes: fs.statSync(outFile).size,
      format,
      cached: true
    };
  }

  const fd = new FormData();
  fd.append('text', ttsText);
  fd.append('instruction', instruction);
  fd.append('cfg_scale', String(cfgScale));
  fd.append('seed', String(Number(b.seed) > 0 ? Number(b.seed) : 12345));
  if (useOpus) fd.append('bitrate', String(b.opusBitrate || '32k'));

  const timeoutMs = useOpus
    ? (Number(b.opusTimeoutMs) > 0 ? Number(b.opusTimeoutMs) : 45000)
    : (Number(b.timeoutMs) > 0 ? Number(b.timeoutMs) : 120000);
  let res;
  try {
    res = await fetchWithBusyRetry(`${useOpus ? opusBase : base}/v1/audio/speech${useOpus ? '_opus' : ''}`, {
      method: 'POST',
      body: fd
    }, {
      timeoutMs,
      label: useOpus ? 'Opus 代理' : 'BreezeTTS'
    });
  } catch (error) {
    // 忙等预算用完：两条通道背后是同一个推理槽，回退 WAV 只会再撞一次 409。
    // 直接把“正忙”交给上层，让模型改用文字。
    if (error instanceof TtsBusyError) throw error;
    if (useOpus) {
      console.error(`[tts] Opus 代理不可用，回退 WAV：${error?.message ?? error}`);
      return synthesizeBreeze({ text, explicitStyle, t, formatOverride: 'wav' });
    }
    throw error;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    if (useOpus) {
      console.error(`[tts] Opus 代理返回 ${res.status}，回退 WAV：${String(errText).slice(0, 120)}`);
      return synthesizeBreeze({ text, explicitStyle, t, formatOverride: 'wav' });
    }
    throw new Error(`BreezeTTS 返回 ${res.status}：${String(errText).slice(0, 200)}`);
  }

  let seconds = 0;
  let sourceBytes = 0;
  if (useOpus) {
    seconds = Number(res.headers.get('x-source-seconds')) || 0;
    sourceBytes = Number(res.headers.get('x-source-bytes')) || 0;
    const maxSeconds = Number(t.maxSeconds) > 0 ? Number(t.maxSeconds) : 45;
    // 模型偶尔会失控生成几十秒：头里已经写明时长，超过上限就别再把整段传回来。
    if (seconds > maxSeconds) {
      try { await res.body?.cancel(); } catch {}
      throw new Error(`合成结果 ${seconds.toFixed(0)} 秒，超过 ${maxSeconds} 秒上限，说短点`);
    }
  }

  const payload = Buffer.from(await res.arrayBuffer());
  if (payload.length < (useOpus ? 64 : 1024)) {
    if (useOpus) return synthesizeBreeze({ text, explicitStyle, t, formatOverride: 'wav' });
    throw new Error('BreezeTTS 没有返回有效音频');
  }
  let bytesOut = payload;
  if (!useOpus) {
    const sampleRate = Number(res.headers.get('x-sample-rate')) || 24000;
    const wav = pcm16ToWav(payload, sampleRate);
    seconds = wavDurationSeconds(wav);
    sourceBytes = payload.length;
    bytesOut = wav;
  }
  fs.writeFileSync(outFile, bytesOut);
  fs.writeFileSync(metaFile, JSON.stringify({ seconds, bytes: bytesOut.length, sourceBytes, style, mood: effectiveMood, format, createdAt: Date.now() }));
  pruneTtsFiles(outDir, Number(t.keepFiles) > 0 ? Number(t.keepFiles) : 60);
  return {
    relPath: `tts/breeze-${hash}.${format}`,
    hash: `breeze-${hash}`,
    style,
    mood: effectiveMood,
    seconds,
    bytes: bytesOut.length,
    format,
    cached: false
  };
}

function wavDurationSeconds(buf) {
  try {
    if (buf.length < 44 || buf.toString('ascii', 0, 4) !== 'RIFF') return 0;
    let off = 12;
    let byteRate = 0;
    while (off + 8 <= buf.length) {
      const id = buf.toString('ascii', off, off + 4);
      const size = buf.readUInt32LE(off + 4);
      if (id === 'fmt ' && off + 16 <= buf.length) byteRate = buf.readUInt32LE(off + 16);
      if (id === 'data') return byteRate > 0 ? size / byteRate : 0;
      off += 8 + size + (size % 2);
    }
  } catch {}
  return 0;
}

function pruneTtsFiles(dir, keep) {
  try {
    const list = fs
      .readdirSync(dir)
      .filter((f) => /\.(wav|ogg)$/i.test(f))
      .map((f) => {
        const p = path.join(dir, f);
        return { p, t: fs.statSync(p).mtimeMs };
      })
      .sort((a, b) => b.t - a.t);
    for (const item of list.slice(Math.max(1, keep))) {
      fs.unlinkSync(item.p);
      try { fs.unlinkSync(item.p.replace(/\.(wav|ogg)$/i, '.json')); } catch {}
    }
  } catch {}
}

if (ttsCfg().enabled === true) {
  server.tool(
    'qq_speak',
    '用你自己的声音说一句中文，生成语音条发到会话。始终是同一个中文音色（默认偏软萌、傲娇、活泼），只改语气；dark 是同一个声音的冷傲版，不是换人。可以主动发，不用等对方点名：道晚安、撒娇、被夸、情绪很浓、聊得正热想插一句、冷场冒泡都适合。按这句话的内容传 mood：开心 happy、低落 sad、生气 angry、害羞 shy、困倦 sleepy、得意 proud、活泼 playful；不传就保持默认软萌。文本明确在说困/累/想睡/晚安时，mood 必须传 sleepy，哪怕当前心情很好；音色要跟这句话的状态走，而不是跟整体心情走。主人手动锁定的声线优先于单次 style，锁了软萌时传 dark 也不会变。注意：① 一次最多 60 字，语音条不是长文，说短点；② 说完语音就不用再把同一句用文字重复一遍；③ 同一轮最多 1 条、同会话 10 分钟最多 5 条，别连着刷，也别替代正常回话；④ 返回的 verified=true 才代表语音真的发出去了，false 或报错就老老实实打字，别假装发了语音；⑤ 只用中文说话，没有日语声源；⑥ 只说你真会说的话，不念链接、工具说明或报错；⑦ 主人在某个群里刚说完话时，可以从那个群会话把语音发到别的群（群友插话即失效），主人在私聊用主人令牌则始终可以跨会话发语音。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().describe('要说的话，中文纯文本，60 字以内'),
      style: z.enum(['soft', 'dark']).optional().describe('声线：soft=软萌活泼，dark=同一个声音的冷傲版（不换音色）；不传则按人格情绪/主人设置自动选择'),
      mood: z.enum(['happy', 'sad', 'angry', 'shy', 'sleepy', 'proud', 'playful']).optional().describe('这句话的语气：开心/低落/生气/害羞/困倦/得意/活泼；按内容选，不传就保持默认软萌'),
      label: z.string().optional().describe('可选：写进会话记录的说明，如「小声说了句晚安」')
    },
    async ({ key, token, text, style, mood, label }) => {
      const t = ttsCfg();
      let stage = '校验参数';
      try {
        const clean = String(text ?? '').trim();
        const maxChars = Number(t.maxChars) > 0 ? Number(t.maxChars) : 60;
        if (!clean) throw new Error('text 不能为空');
        if (clean.length > maxChars) throw new Error(`一次最多说 ${maxChars} 个字（现在 ${clean.length} 个），说短点`);
        if (SENSITIVE_RE.test(clean)) throw new Error('这句话里含本机路径/凭据特征，语音通道同样不允许发出');

        // 中文声源固定为 BreezeTTS2（Voice Design），地址见 tts.breeze.baseUrl；
        // 软萌/黑化由 style 显式指定，或按人格情绪与主人设置自动选择。
        // 日语声源已下线：Breeze 不可用时直接报错，不再回退本机 ATRI（会让中文带上日语腔）。
        if (t.breeze?.enabled === false || !String(t.breeze?.baseUrl || '').trim()) {
          throw new Error('中文声源未启用：检查 config.json 的 tts.breeze.enabled / baseUrl');
        }
        stage = '合成语音（BreezeTTS2）';
        const breeze = await synthesizeBreeze({ text: clean, explicitStyle: style, mood: mood || '', t });
        const voiceStyle = breeze.style;
        const voiceProvider = breeze.format === 'ogg' ? 'breeze-opus' : 'breeze';

        stage = '发送语音';
        const data = await agentApi('/api/simulation/send-voice', {
          method: 'POST',
          body: JSON.stringify({
            key,
            voice: breeze.relPath,
            label: label || clean.slice(0, 20),
            // 黑化用更响的响度目标，避免“变冷”被听成“变小聲”。
            normalize: true,
            loudness: breeze.style === 'dark' ? (t.breeze?.darkLoudness || 'loud') : (t.breeze?.softLoudness || 'normal'),
            verify: true,
            readback: false,
            token
          }),
          headers: { 'x-agent-token': token },
          timeoutMs: 300000
        });
        const seconds = Number(Number(breeze.seconds || 0).toFixed(1));
        return {
          content: [{
            type: 'text',
            text: serializeModelData({
              ...data,
              seconds,
              provider: voiceProvider,
              style: voiceStyle || 'default',
              mood: breeze.mood || mood || 'default',
              format: breeze.format,
              audioKB: Number((breeze.bytes / 1024).toFixed(1))
            })
          }]
        };
      } catch (error) {
        const detail = String(error?.message ?? error);
        const fallback = String(text ?? '').trim().slice(0, 60);
        // 合成失败：语音肯定没发出，明确告诉模型改用文字，避免它反复重试同一个 TTS。
        // 发送阶段失败：可能已送达但没拿到确认，先不要把同一句用文字再发一遍。
        const hint = stage === '发送语音'
          ? (/没有权限操作|agent token 无效/.test(detail)
            ? '这是权限问题，不是音频问题：跨群发语音需要主人在目标群刚说过话，或由主人在私聊直接让你发；不要反复重试'
            : '语音可能已送达但未确认，先不要补发文字；只有对方明确说没收到时再改用文字')
          : `语音没有发出：请直接用文字把这句话发出去「${fallback}」，不要重复调用 qq_speak`;
        return { content: [{ type: 'text', text: `发语音失败（${stage}）：${detail}。${hint}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.innerLife?.enabled !== false) {
  server.tool(
    'qq_owner_admin',
    '主人的管理动作（仅主人私聊）。用自然语言理解主人意图后调用：改声线 voice_style、改个性签名 signature、立即找一条分享 run_share、立即写一条说说 run_qzone、暂停/恢复空间说说 pause_qzone/resume_qzone、设置主动分享目标群 set_share_targets、查看内心生活状态 status、查看说说频率规则 qzone_status、查看整体规则 owner_status。主人问“说说频率/规则/为什么这么频繁”时必须先 qzone_status 再回答，不要猜。高危动作会先私聊主人确认（不要自己填 confirmCode）。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      action: z.enum(['voice_style', 'signature', 'run_share', 'run_qzone', 'pause_qzone', 'resume_qzone', 'set_share_targets', 'status', 'qzone_status', 'owner_status']),
      mode: z.enum(['auto', 'soft', 'dark']).optional().describe('voice_style 用：auto/soft/dark'),
      text: z.string().optional().describe('signature 用：新的签名文本'),
      targets: z.array(z.string()).optional().describe('set_share_targets 用：群 key 列表，如 ["group:123"]'),
      preferS16: z.boolean().optional().describe('run_share 用：是否优先 S16'),
      dryRun: z.boolean().optional().describe('run_share 用：只预览不发送'),
      confirmCode: z.string().optional().describe('主人已在私聊 /确认 后桥接才会给出；一般不要填')
    },
    async ({ key, token, action, mode, text, targets, preferS16, dryRun, confirmCode }) => {
      try {
        const keyErr = highRiskKeyError(key);
        if (keyErr) return { content: [{ type: 'text', text: keyErr }], isError: true };
        const payload = { key, token, action };
        if (confirmCode) payload.confirmCode = String(confirmCode);
        if (action === 'voice_style') {
          if (!mode) throw new Error('voice_style 需要 mode');
          payload.mode = mode;
        } else if (action === 'signature') {
          if (!String(text ?? '').trim()) throw new Error('signature 需要 text');
          payload.text = String(text).trim();
        } else if (action === 'run_share') {
          payload.preferS16 = preferS16 === true;
          payload.dryRun = dryRun === true;
        } else if (action === 'set_share_targets') {
          const allowed = new Set((cfg.allow?.groups || []).map((id) => `group:${String(id).replace(/^group:/, '')}`));
          const list = (targets || []).map(String).filter((k) => allowed.has(k));
          if (!list.length) throw new Error('targets 里没有白名单群');
          payload.targets = list;
        } else if (!['run_qzone', 'pause_qzone', 'resume_qzone', 'status', 'qzone_status', 'owner_status'].includes(action)) {
          throw new Error('未知的 action');
        }
        const data = await agentApi('/api/simulation/owner-admin', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `管理动作失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.innerLife?.mood?.eventNudge?.enabled === true) {
  server.tool(
    'qq_mood_nudge',
    '只在某件事明显影响你心情时调用：被认真夸/被安慰/被凶/小冲突/分享被接住/被冷落。强度 3–5；普通闲聊、接梗、天气、查资料不要调用。同一事件只记一次；每小时/每天有限额；它不代替正常回复，也不是情绪表演。返回当前心情。',
    {
      key: z.string().describe('会话 key'),
      token: z.string().describe('会话令牌'),
      what: z.string().describe('发生了什么，不超过30字'),
      intensity: z.number().min(3).max(5).describe('情绪强度 3–5'),
      valence: z.enum(['positive', 'negative']).describe('正向/负向'),
      arousal: z.enum(['up', 'down', 'none']).optional().describe('兴奋度变化'),
      cause: z.string().describe('不超过20字的原因'),
      sourceMessageId: z.union([z.number(), z.string()]).optional().describe('触发这条心情的消息 id，用于去重')
    },
    async ({ key, token, what, intensity, valence, arousal, cause, sourceMessageId }) => {
      try {
        const data = await agentApi('/api/simulation/mood/nudge', {
          method: 'POST',
          body: JSON.stringify({ key, token, what, intensity, valence, arousal: arousal || 'none', cause, sourceMessageId: sourceMessageId ?? null }),
          headers: { 'x-agent-token': token },
          timeoutMs: 30000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `心情事件失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.innerLife?.enabled !== false) {
  const shareModuleCall = async (token, payload) => agentApi('/api/simulation/share-modules', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'x-agent-token': token },
    timeoutMs: 300000
  });
  server.tool(
    'qq_share_module_list',
    '列出所有分享模块（目标群、频率、验证状态、下次时间、最近一条）。主人问“有哪些分享/分享状态”时用。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌')
    },
    async ({ key, token }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await shareModuleCall(token, { key, token, action: 'list' });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取分享模块失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_share_module_create',
    '创建分享模块（仅主人私聊，必须 confirm=true）。先把方案私聊给主人，主人明确说“确认创建”后才调用。configJson 是模块配置 JSON：id/label/template/targets/limits/trigger/content/source/links/media/delivery/facets；新模块会自动进入验证期，每条先私聊主人。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().describe('模块 id，小写字母开头，如 finance_tips'),
      configJson: z.string().describe('模块配置 JSON 字符串'),
      confirm: z.boolean().describe('主人已明确确认创建')
    },
    async ({ key, token, id, configJson, confirm }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await shareModuleCall(token, { key, token, action: 'create', id, configJson, confirm: confirm === true });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `创建分享模块失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_share_module_update',
    '修改分享模块（仅主人私聊，必须 confirm=true）。改完后模块会重新进入验证期。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().describe('模块 id'),
      configJson: z.string().describe('完整的新模块配置 JSON'),
      confirm: z.boolean().describe('主人已明确确认修改')
    },
    async ({ key, token, id, configJson, confirm }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await shareModuleCall(token, { key, token, action: 'update', id, configJson, confirm: confirm === true });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改分享模块失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_share_module_pause',
    '暂停/恢复分享模块（仅主人私聊）。action=pause/resume。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().describe('模块 id'),
      action: z.enum(['pause', 'resume'])
    },
    async ({ key, token, id, action }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await shareModuleCall(token, { key, token, action, id });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `操作分享模块失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_share_module_verify',
    '结束验证期（仅主人私聊）。主人明确说“验证通过/结束验证”后才调用；之后模块按排期自动发送。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().describe('模块 id')
    },
    async ({ key, token, id }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await shareModuleCall(token, { key, token, action: 'verify', id });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `验证失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_share_module_preview',
    '立即生成一条分享预览（仅主人私聊，不发群）。验证期用它看效果。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().describe('模块 id')
    },
    async ({ key, token, id }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await shareModuleCall(token, { key, token, action: 'preview', id });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `预览失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_share_module_delete',
    '删除分享模块（仅主人私聊，必须 confirm=true）。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().describe('模块 id'),
      confirm: z.boolean().describe('主人已明确确认删除')
    },
    async ({ key, token, id, confirm }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await shareModuleCall(token, { key, token, action: 'delete', id, confirm: confirm === true });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `删除分享模块失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_share_module_publish',
    '发布当前待确认的分享草稿（仅主人私聊）。主人回“发分享 模块id”时调用。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().describe('模块 id')
    },
    async ({ key, token, id }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await shareModuleCall(token, { key, token, action: 'publish', id });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `发布分享草稿失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// 高危/管理工具：主人私聊直接执行；群里调用仍然转发给桥接，由桥接返回「回私聊确认」
// 并按限频私聊提醒主人。不在 MCP 层直接堵死，否则模型拿不到可执行的改道提示。
function highRiskKeyError(key) {
  if (!cfg.ownerQQ) return '主人 QQ 未配置，管理动作不可用';
  const k = String(key ?? '');
  if (k.startsWith('group:')) return '';
  return k === `private:${cfg.ownerQQ}` ? '' : '管理动作只允许主人私聊';
}

if (cfg.simulation?.innerLife?.enabled !== false) {
  const ownerFeatureCall = async (token, payload) => agentApi('/api/simulation/owner-features', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'x-agent-token': token },
    timeoutMs: 30000
  });
  server.tool(
    'qq_capabilities_list',
    '列出主人私聊当前能配置/能开发的能力（分享、定时消息、自动回复、语音、Qzone、签名、声线、心情、代码提案、缺陷/改进提案），以及每项状态、可用工具和示例。主人问“你能做什么/能不能加 X”，或现有功能要修/改/不好用时先调用。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌')
    },
    async ({ key, token }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await ownerFeatureCall(token, { key, token, action: 'capabilities' });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取能力失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_feature_list',
    '列出已创建的主人功能及下次/最近/错误。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌')
    },
    async ({ key, token }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await ownerFeatureCall(token, { key, token, action: 'list' });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取功能失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_feature_preview',
    '预览一个主人功能（不写配置、不发消息）：显示目标、未来排期、实际文案和警告。featureJson 是功能 JSON。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      featureJson: z.string().describe('功能配置 JSON')
    },
    async ({ key, token, featureJson }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        let feature;
        try { feature = JSON.parse(String(featureJson || '{}')); } catch { throw new Error('featureJson 不是合法 JSON'); }
        const data = await ownerFeatureCall(token, { key, token, action: 'preview', feature });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `预览失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_feature_apply',
    '应用一个已让主人确认过的功能（confirm=true）。支持 scheduled_message / qzone_post / auto_reply / voice_message；code_feature 只生成提案并排入主控待办，不会自行启动开发会话。高危动作会先私聊主人确认（不要自己填 confirmCode）。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      featureJson: z.string().describe('功能配置 JSON'),
      confirm: z.boolean().describe('主人已明确确认'),
      confirmCode: z.string().optional().describe('主人已在私聊 /确认 后桥接才会给出；一般不要填')
    },
    async ({ key, token, featureJson, confirm, confirmCode }) => {
      try {
        const keyErr = highRiskKeyError(key);
        if (keyErr) throw new Error(keyErr);
        let feature;
        try { feature = JSON.parse(String(featureJson || '{}')); } catch { throw new Error('featureJson 不是合法 JSON'); }
        const data = await ownerFeatureCall(token, { key, token, action: 'apply', feature, confirm: confirm === true, ...(confirmCode ? { confirmCode: String(confirmCode) } : {}) });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `应用失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  const ownerConfigCall = async (token, payload) => agentApi('/api/simulation/owner-config', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'x-agent-token': token },
    timeoutMs: 30000
  });
  server.tool(
    'qq_config_list',
    '列出私聊可读写的规则白名单（说说频率、评论回复、签名间隔、语音上限、TTS 阈值、日报、分享上限）。主人问“规则是多少/能不能改”时先调用。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌')
    },
    async ({ key, token }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await ownerConfigCall(token, { key, token, action: 'list' });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取配置失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_config_get',
    '读取一个配置键的当前值。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      configKey: z.string().describe('配置键，如 qzone.maxPerDay')
    },
    async ({ key, token, configKey }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await ownerConfigCall(token, { key, token, action: 'get', configKey });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取配置失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_config_set',
    '修改一个白名单配置键（仅主人私聊，必须 confirm=true）。返回修改前后值和是否需要重启 DSH。高危动作会先私聊主人确认（不要自己填 confirmCode）。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      configKey: z.string().describe('配置键，如 qzone.maxPerDay'),
      value: z.union([z.number(), z.string(), z.boolean()]).describe('新值'),
      confirm: z.boolean().describe('主人已明确确认修改'),
      confirmCode: z.string().optional().describe('主人已在私聊 /确认 后桥接才会给出；一般不要填')
    },
    async ({ key, token, configKey, value, confirm, confirmCode }) => {
      try {
        const keyErr = highRiskKeyError(key);
        if (keyErr) throw new Error(keyErr);
        const data = await ownerConfigCall(token, { key, token, action: 'set', configKey, value, confirm: confirm === true, ...(confirmCode ? { confirmCode: String(confirmCode) } : {}) });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改配置失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  const devProposalCall = async (token, payload) => agentApi('/api/simulation/dev-proposals', {
    method: 'POST',
    body: JSON.stringify(payload),
    headers: { 'x-agent-token': token },
    timeoutMs: 15 * 60 * 1000
  });
  server.tool(
    'qq_code_propose',
    '把“要修的缺陷 / 要改进的地方 / 要新增的功能”用自然语言提成代码提案，并排入主控待办（仅主人私聊）。主人说“修一下/改一下/不好用/有问题/加个功能”且你判断需要改代码时用这个；它只生成提案与计划并排队，不会自行开发、合并或改主工作区。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      title: z.string().describe('一句话标题，如“语音结尾截断”“加个每日喝水提醒”，最多 60 字'),
      symptom: z.string().describe('现状：实际表现/症状，或缺失的功能及为什么需要；具体到能复现或能验收，最多 800 字'),
      expected: z.string().describe('期望：正确表现，或新功能做到什么程度算完成，最多 800 字'),
      evidence: z.string().optional().describe('可选：复现步骤、样例消息、日志或发生时间，最多 1200 字'),
      scope: z.string().optional().describe('可选：可能涉及的模块/文件/功能范围，最多 300 字'),
      steps: z.array(z.string()).optional().describe('可选：建议实现步骤（最多 8 条，每条 120 字）；不传则由主控按标准四步生成计划'),
      acceptance: z.string().optional().describe('可选：验收标准，最多 300 字；不传则默认「隔离副本 + verify 全绿 + 回传 result.json」'),
      confirmCode: z.string().optional().describe('主人已在私聊 /确认 后桥接才会给出；一般不要填')
    },
    async ({ key, token, title, symptom, expected, evidence, scope, steps, acceptance, confirmCode }) => {
      try {
        const keyErr = highRiskKeyError(key);
        if (keyErr) throw new Error(keyErr);
        const data = await devProposalCall(token, { key, token, action: 'propose_code', title, symptom, expected, evidence, scope, steps, acceptance, ...(confirmCode ? { confirmCode: String(confirmCode) } : {}) });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `提交代码提案失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_feature_code_status',
    '查看代码类功能提案的隔离实现/测试结果（不合并）。id 省略时列出全部。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().optional().describe('提案 id')
    },
    async ({ key, token, id }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await devProposalCall(token, { key, token, action: id ? 'status' : 'list', id });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `读取代码提案失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_feature_code_merge',
    '把已通过测试的代码提案合并到主工作区（仅主人私聊，必须 confirm=true）。合并后会再跑 verify，失败自动回滚。高危动作会先私聊主人确认（不要自己填 confirmCode）。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().describe('提案 id'),
      confirm: z.boolean().describe('主人已明确确认合并'),
      confirmCode: z.string().optional().describe('主人已在私聊 /确认 后桥接才会给出；一般不要填')
    },
    async ({ key, token, id, confirm, confirmCode }) => {
      try {
        const keyErr = highRiskKeyError(key);
        if (keyErr) throw new Error(keyErr);
        const data = await devProposalCall(token, { key, token, action: 'merge', id, confirm: confirm === true, ...(confirmCode ? { confirmCode: String(confirmCode) } : {}) });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `合并代码提案失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_feature_code_reject',
    '丢弃代码提案的隔离副本（仅主人私聊）。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().describe('提案 id')
    },
    async ({ key, token, id }) => {
      try {
        if (!cfg.ownerQQ || String(key) !== `private:${cfg.ownerQQ}`) throw new Error('只允许主人私聊');
        const data = await devProposalCall(token, { key, token, action: 'reject', id });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `丢弃代码提案失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
  server.tool(
    'qq_feature_control',
    '暂停/恢复/删除/回滚主人功能。action=pause/resume/delete/rollback。高危动作会先私聊主人确认（不要自己填 confirmCode）。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌'),
      id: z.string().describe('功能 id'),
      action: z.enum(['pause', 'resume', 'delete', 'rollback']),
      confirm: z.boolean().optional().describe('delete 必须为 true'),
      confirmCode: z.string().optional().describe('主人已在私聊 /确认 后桥接才会给出；一般不要填')
    },
    async ({ key, token, id, action, confirm, confirmCode }) => {
      try {
        const keyErr = highRiskKeyError(key);
        if (keyErr) throw new Error(keyErr);
        if (action === 'delete' && confirm !== true) throw new Error('删除需要 confirm=true');
        const data = await ownerFeatureCall(token, { key, token, action, id, confirm: confirm === true, ...(confirmCode ? { confirmCode: String(confirmCode) } : {}) });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `操作失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.innerLife?.enabled !== false) {
  server.tool(
    'qq_post_qzone',
    '把一段文字发到你的 QQ 空间（说说）。仅主人私聊可用。主人让你“把这段发成说说/发到空间/挂个说说”时直接调用，不要说自己没有入口，也不要让主人去管理端发。text 最多 150 字；可以带 image（图片库 id 或 name，可用 qq_save_image 先存封面）；dryRun=true 只预览不发布。内容会检查时间是否自洽；发布成功返回 tid。',
    {
      key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      text: z.string().describe('说说正文，纯文本，最多 150 字'),
      image: z.string().optional().describe('可选：图片库 id 或 name，作为说说配图'),
      dryRun: z.boolean().optional().describe('只预览不发布'),
      confirmCode: z.string().optional().describe('主人已在私聊 /确认 后桥接才会给出；一般不要填')
    },
    async ({ key, token, text, image, dryRun, confirmCode }) => {
      try {
        const keyErr = highRiskKeyError(key);
        if (keyErr) return { content: [{ type: 'text', text: keyErr }], isError: true };
        const data = await agentApi('/api/simulation/qzone-post', {
          method: 'POST',
          body: JSON.stringify({ key, token, text: String(text ?? ''), image: image ? String(image) : '', dryRun: dryRun === true, ...(confirmCode ? { confirmCode: String(confirmCode) } : {}) }),
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }], isError: data?.ok === false };
      } catch (error) {
        return { content: [{ type: 'text', text: `发说说失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.tools?.getSelfImage !== false) {
  server.tool(
    'qq_get_self_image',
    '查看你自己的默认 Q 版形象图片（DeepSeek 小鲸鱼形象）。当你被问“你长什么样/发张自拍/你是什么形象”时，可以调用这个工具看自己的样子；返回的图片会直接进入你的视觉上下文。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）')
    },
    async ({ key, token }) => {
      try {
        const q = new URLSearchParams({ key });
        const data = await agentApi(`/api/simulation/self-image?${q.toString()}`, { headers: { 'x-agent-token': token } });
        if (!data?.image?.data || !data?.image?.mimeType) {
          return { content: [{ type: 'text', text: `没有可返回的形象图片：${errorText(data?.error, '未知')}` }], isError: true };
        }
        return {
          content: [
            { type: 'text', text: '这是你的默认 Q 版形象：' },
            { type: 'image', mimeType: data.image.mimeType, data: data.image.data }
          ]
        };
      } catch (error) {
        return { content: [{ type: 'text', text: `获取形象图片失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.sticker?.enabled !== false && cfg.simulation?.tools?.stickerNote !== false) {
  server.tool(
    'qq_sticker_note',
    '给一个收藏表情记录你自己的理解/备注/标签/用法，供以后选择表情时参考。这是本地记忆，不会修改 QQ 账号的官方备注；适合对没有备注的表情看图后记住含义。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      note: z.string().optional().describe('你理解的表情含义/适合场景，最多 200 字'),
      tags: z.array(z.string()).optional().describe('可选标签，如 ["嘲讽","笑哭","怼人"]'),
      usage: z.string().optional().describe('可选用法说明，最多 200 字')
    },
    async ({ key, token, stickerId, note, tags, usage }) => {
      try {
        const payload = { key, stickerId: String(stickerId) };
        if (note !== undefined && note !== null) payload.note = String(note);
        if (tags !== undefined && tags !== null) payload.tags = Array.isArray(tags) ? tags.map(String) : [];
        if (usage !== undefined && usage !== null) payload.usage = String(usage);
        const data = await agentApi('/api/simulation/sticker-note', {
          method: 'POST',
          body: JSON.stringify(payload),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `记录表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

if (cfg.simulation?.sticker?.enabled !== false && cfg.simulation?.tools?.setStickerRemark !== false) {
  server.tool(
    'qq_set_sticker_remark',
    '修改 QQ 账号里收藏表情的官方备注（desc）。这是写操作，会直接影响 QQ 账号的表情备注；仅在管理员明确允许（simulation.tools.setStickerRemark=true）时可用。一般优先用 qq_sticker_note 记录自己的理解，不要随意改官方备注。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      stickerId: z.string().describe('表情标识：emoji_id / md5 / 图片 URL（来自 qq_list_stickers）'),
      remark: z.string().describe('新的表情备注，最多 50 字')
    },
    async ({ key, token, stickerId, remark }) => {
      try {
        const data = await agentApi('/api/simulation/sticker-remark', {
          method: 'POST',
          body: JSON.stringify({ key, stickerId: String(stickerId), remark: String(remark || '') }),
          headers: { 'x-agent-token': token }
        });
        return { content: [{ type: 'text', text: serializeModelData(data) }] };
      } catch (error) {
        return { content: [{ type: 'text', text: `修改表情备注失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

// ── 合并转发消息查看工具（群聊仿真模式） ────────────────────────────────────
if (cfg.simulation?.tools?.getForwardMsg !== false) {
  server.tool(
    'qq_get_forward_msg',
    '查看当前会话中出现的合并转发消息/聊天记录内容（只读）。当消息文本里出现 `[转发消息 id=...]`，或 `qq_get_unread_messages` / `qq_get_recent_messages` / `qq_get_message_detail` 返回的某条消息带 `forwardIds` / `hasForward: true` 时调用。只能查看当前会话确实收到过的转发消息 id，不能任意读取。返回内容会包含每条消息的 text、media（图片/表情元数据）与 nestedForwardIds；如果合并转发里有图片，工具会直接把最多 5 张图片以图像内容返回给视觉模型；如果里面有嵌套合并转发，会附带嵌套转发 id 和前几条预览，必要时可继续用本工具查看嵌套 id。',
    {
      key: z.string().describe('会话 key，格式 group:群号 或 private:QQ号'),
      token: z.string().describe('会话令牌（见唤醒提示中的【会话令牌】）'),
      id: z.string().describe('合并转发消息 id（来自消息里的 [转发消息 id=...] 或 forwardIds 数组）')
    },
    async ({ key, token, id }) => {
      try {
        const q = new URLSearchParams({ key, id: String(id) });
        const data = await agentApi(`/api/simulation/forward-message?${q.toString()}`, {
          headers: { 'x-agent-token': token },
          timeoutMs: 120000
        });
        const content = [{ type: 'text', text: serializeModelData(data) }];
        // 收集所有层级的图片/表情元数据（含嵌套预览），最多返回 5 张。
        const images = [];
        const seen = new Set();
        const collectMedia = (msgs) => {
          if (!Array.isArray(msgs)) return;
          for (const m of msgs) {
            if (!m || typeof m !== 'object') continue;
            for (const media of Array.isArray(m.media) ? m.media : []) {
              if (!media || typeof media !== 'object') continue;
              const keyId = media.url || media.file || media.faceId || '';
              if (!keyId || seen.has(keyId)) continue;
              seen.add(keyId);
              images.push(media);
            }
          }
        };
        collectMedia(data?.messages);
        if (Array.isArray(data?.nestedPreviews)) {
          for (const np of data.nestedPreviews) collectMedia(np?.messages);
        }
        const MAX_IMAGES = 5;
        const imageTexts = [];
        if (images.length) {
          try {
            const mediaRes = await agentApi('/api/simulation/forward-media', {
              method: 'POST',
              body: JSON.stringify({ key, media: images.slice(0, MAX_IMAGES) }),
              headers: { 'x-agent-token': token },
              timeoutMs: 180000
            });
            const mediaImages = Array.isArray(mediaRes?.images) ? mediaRes.images : [];
            for (const img of mediaImages) {
              if (img?.data && img?.mimeType) {
                content.push({ type: 'image', mimeType: img.mimeType, data: img.data });
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}${img.text ? ' ' + img.text : ''}]`);
              } else {
                imageTexts.push(`[转发内图片${img.index != null ? ' ' + img.index : ''}（${img.text || '获取失败'}）]`);
              }
            }
          } catch (error) {
            imageTexts.push(`[转发内图片（批量获取失败：${error?.message ?? error}）]`);
          }
        }
        if (imageTexts.length) {
          content.unshift({ type: 'text', text: `合并转发 ${id} 的图片内容（${imageTexts.length} 项）：\n${imageTexts.join('\n')}` });
        }
        return { content };
      } catch (error) {
        return { content: [{ type: 'text', text: `查看合并转发失败：${error?.message ?? error}` }], isError: true };
      }
    }
  );
}

await server.connect(new StdioServerTransport());
