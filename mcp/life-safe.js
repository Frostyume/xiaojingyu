// 生活管家只读 MCP server（stdio）：life_status / life_brief / life_query /
// life_watch / life_unwatch。
//
// 安全设计：
//   · 所有工具只允许主人私聊（key 必须等于 private:<ownerQQ>），并携带该会话 agentToken；
//   · 工具进程不直接读写 SQLite：统一调用桥接 /api/life/*，避免第二个迁移/写连接；
//   · simulation.lifeButler.enabled=false 时注册期不暴露工具，运行期调用也返回 disabled；
//   · life_query 最多 20 条；返回值只含时间/标题/状态，不含正文、链接集合或密钥。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { serializeModelData } from '../services/social/qq-model-view.js';

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

function agentApiBase() {
  const port = Number(getConfig().consolePort) || 3100;
  return `http://127.0.0.1:${port}`;
}

function readConsoleToken() {
  try {
    const c = getConfig();
    const configured = String(c.consoleToken ?? '').trim();
    if (/^[A-Za-z0-9_-]{16,128}$/.test(configured)) return configured;
  } catch {}
  try {
    return fs.readFileSync(path.join(ROOT, 'state', 'console-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

function errorText(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string') return value.slice(0, 400);
  try { return JSON.stringify(value).slice(0, 400); } catch { return fallback; }
}

async function lifeApi(action, payload = {}, { timeoutMs = 20000 } = {}) {
  const consoleToken = readConsoleToken();
  const res = await fetch(`${agentApiBase()}/api/life/${action}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-agent-call': '1',
      ...(consoleToken ? { 'x-console-token': consoleToken } : {})
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(timeoutMs)
  });
  let data = null;
  try { data = await res.json(); } catch { data = null; }
  if (!res.ok) throw new Error(errorText(data?.error, `桥接 API HTTP ${res.status}`));
  if (!data || typeof data !== 'object') throw new Error('桥接返回空响应');
  return data;
}

function disabledResult(reason = 'simulation.lifeButler.enabled=false') {
  return { ok: false, disabled: true, reason };
}

function freshOwnerConfig() {
  const c = getConfig();
  return {
    enabled: c.simulation?.lifeButler?.enabled === true,
    ownerQQ: c.ownerQQ ? String(c.ownerQQ) : ''
  };
}

const server = new McpServer({ name: 'life-safe', version: '0.2.0-r4' });
const disabledTools = [];
{
  const registerTool = server.tool.bind(server);
  // 注册期开关：默认关闭时不暴露任何 life_* 工具；开启后仍需 DSH 重启才能生效。
  server.tool = (name, ...rest) => {
    if (cfg.simulation?.lifeButler?.enabled !== true) {
      disabledTools.push(name);
      return undefined;
    }
    return registerTool(name, ...rest);
  };
}

async function callLife(action, payload) {
  const fresh = freshOwnerConfig();
  if (!fresh.enabled) return disabledResult('simulation.lifeButler.enabled=false');
  const ownerKey = fresh.ownerQQ ? `private:${fresh.ownerQQ}` : '';
  if (!ownerKey || String(payload.key) !== ownerKey) {
    throw new Error('生活管家只允许主人私聊');
  }
  return lifeApi(action, payload);
}

function result(data) {
  const softDisabled = data?.disabled === true;
  return {
    content: [{ type: 'text', text: serializeModelData(data) }],
    isError: data?.ok === false && !softDisabled
  };
}

function fail(prefix, error) {
  return { content: [{ type: 'text', text: `${prefix}：${error?.message ?? error}` }], isError: true };
}

server.tool(
  'life_status',
  '查看生活管家各适配器状态、最近同步、失败次数、熔断与条目计数（只读）。',
  {
    key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
    token: z.string().describe('会话令牌')
  },
  async ({ key, token }) => {
    try { return result(await callLife('status', { key, token })); }
    catch (error) { return fail('读取生活管家状态失败', error); }
  }
);

server.tool(
  'life_brief',
  '生成今日简报（只含时间、标题、状态，≤300 tokens）。kind=morning/evening。',
  {
    key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
    token: z.string().describe('会话令牌'),
    kind: z.enum(['morning', 'evening']).optional().describe('早间/晚间简报')
  },
  async ({ key, token, kind }) => {
    try { return result(await callLife('brief', { key, token, kind: kind || 'morning' })); }
    catch (error) { return fail('生成生活简报失败', error); }
  }
);

server.tool(
  'life_query',
  '按类型/适配器/状态/关键词/时间范围查询生活条目，最多 20 条；只返回标题、时间与状态。',
  {
    key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
    token: z.string().describe('会话令牌'),
    kind: z.enum(['calendar', 'parcel', 'bill', 'subscription', 'paper', 'todo', 'feed', 'health']).optional(),
    adapter: z.enum(['calendar-ics', 'github', 'arxiv', 'rss']).optional(),
    status: z.enum(['open', 'done', 'dismissed', 'expired']).optional(),
    q: z.string().max(60).optional().describe('标题关键词'),
    from: z.number().optional().describe('起始时间（ms）'),
    to: z.number().optional().describe('结束时间（ms）'),
    limit: z.number().int().min(1).max(20).optional()
  },
  async ({ key, token, kind, adapter, status, q, from, to, limit }) => {
    try {
      return result(await callLife('query', {
        key, token, kind: kind || '', adapter: adapter || '', status: status || '',
        q: q || '', from, to, limit: Math.min(20, Number(limit) || 20)
      }));
    } catch (error) { return fail('查询生活条目失败', error); }
  }
);

server.tool(
  'life_watch',
  '新增关注项（仅写本地 life_watch，不触发外部动作）。adapter=github/arxiv/rss/calendar-ics。',
  {
    key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
    token: z.string().describe('会话令牌'),
    adapter: z.enum(['calendar-ics', 'github', 'arxiv', 'rss']),
    target: z.string().min(1).max(200).describe('仓库 / 频道 / 论文主题 / 关键词'),
    kind: z.enum(['calendar', 'parcel', 'bill', 'subscription', 'paper', 'todo', 'feed', 'health']).optional(),
    options: z.record(z.string(), z.any()).optional().describe('可选过滤条件')
  },
  async ({ key, token, adapter, target, kind, options }) => {
    try {
      return result(await callLife('watch', { key, token, adapter, target, kind: kind || 'feed', options: options ?? null }));
    } catch (error) { return fail('新增关注失败', error); }
  }
);

server.tool(
  'life_unwatch',
  '取消关注项：传 id，或 adapter+kind+target。',
  {
    key: z.string().describe('会话 key，必须是主人私聊 private:QQ号'),
    token: z.string().describe('会话令牌'),
    id: z.string().optional().describe('关注项 id'),
    adapter: z.enum(['calendar-ics', 'github', 'arxiv', 'rss']).optional(),
    kind: z.enum(['calendar', 'parcel', 'bill', 'subscription', 'paper', 'todo', 'feed', 'health']).optional(),
    target: z.string().max(200).optional()
  },
  async ({ key, token, id, adapter, kind, target }) => {
    try {
      return result(await callLife('unwatch', { key, token, id: id || '', adapter: adapter || '', kind: kind || '', target: target || '' }));
    } catch (error) { return fail('取消关注失败', error); }
  }
);

if (disabledTools.length) {
  console.error(`[life-safe] simulation.lifeButler.enabled=false，未注册工具：${disabledTools.join(', ')}`);
}

await server.connect(new StdioServerTransport());