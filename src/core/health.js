// doctor 的纯函数与探测helpers。
// 单独成模块是为了能在离线测试里覆盖「端口解析 / DSH 识别 / 日志分类」，
// 不需要真的启动 DSH 或 SnowLuma。

import fs from 'node:fs';
import net from 'node:net';

/** 解析 `netstat -ano -p TCP` 输出，只保留 LISTENING。 */
export function parseNetstatListens(text) {
  const out = [];
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const m = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/i.exec(line);
    if (!m) continue;
    out.push({ addr: m[1], port: Number(m[2]), pid: Number(m[3]) });
  }
  return out;
}

/** 解析 PowerShell Get-CimInstance 的进程 JSON（单个对象或数组）。 */
export function parseProcessList(jsonText) {
  let parsed;
  try { parsed = JSON.parse(String(jsonText ?? 'null')); } catch { return []; }
  const list = Array.isArray(parsed) ? parsed : (parsed ? [parsed] : []);
  return list
    .map((p) => ({ pid: Number(p.ProcessId), name: String(p.Name ?? ''), cmd: String(p.Cmd ?? '') }))
    .filter((p) => Number.isFinite(p.pid) && p.pid > 0);
}

export function isDshProcess(proc) {
  return /dsh|deepseek harness/i.test(`${proc.name} ${proc.cmd}`);
}

export function isSnowLumaProcess(proc) {
  return /snowluma/i.test(`${proc.name} ${proc.cmd}`);
}

export function listeningPortsOf(processes, listens) {
  const pids = new Set(processes.map((p) => p.pid));
  return [...new Set(listens.filter((l) => pids.has(l.pid)).map((l) => l.port))].sort((a, b) => a - b);
}

/**
 * 找出真正像 DSH 的端口：HTTP 根路径返回 200/401/403，且响应体/头里出现 dsh/deepseek。
 * 401 是正常状态（DSH 需要 Cookie），所以不能只看 200。
 */
export async function probeDshPorts(ports, { timeoutMs = 1500, fetchImpl = globalThis.fetch } = {}) {
  const results = [];
  for (const port of ports) {
    const url = `http://127.0.0.1:${port}/`;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs), headers: { accept: '*/*' } });
      const body = await res.text().catch(() => '');
      const hay = `${body.slice(0, 2000)} ${[...(res.headers?.entries?.() ?? [])].flat().join(' ')}`;
      const looksDsh = (res.status === 200 || res.status === 401 || res.status === 403) && /dsh|deepseek/i.test(hay);
      results.push({ port, url, status: res.status, looksDsh, hint: body.slice(0, 160) });
    } catch (error) {
      results.push({ port, url, status: 0, looksDsh: false, error: String(error?.message ?? error) });
    }
  }
  return results;
}

/** TCP 连通性（SnowLuma / 控制台端口），不发送任何协议数据。 */
export function checkTcp(host, port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port });
    let settled = false;
    const finish = (ok, error = '') => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch {}
      resolve({ ok, error });
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false, 'timeout'));
    socket.once('error', (error) => finish(false, String(error?.code ?? error?.message ?? error)));
  });
}

export function parseUrlSafe(value) {
  try { return new URL(String(value)); } catch { return null; }
}

export function tailLines(file, n = 200) {
  try {
    const stat = fs.statSync(file);
    const size = Math.min(stat.size, 512 * 1024);
    const fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(size);
    fs.readSync(fd, buf, 0, size, stat.size - size);
    fs.closeSync(fd);
    return buf.toString('utf8').split(/\r?\n/).filter(Boolean).slice(-n);
  } catch { return []; }
}

const ERROR_RE = /error|fatal|失败|错误|异常|崩溃|⚠️|❌/i;

export function classifyLogLines(lines) {
  const errors = [];
  for (const line of lines) {
    if (!ERROR_RE.test(line)) continue;
    // 自愈完成本身是成功事件；reason 里可能带 "error"/"失败" 字样（例如
    // close 事件的原始描述），把它算进“最近错误”会让巡检永远有一条假警告。
    if (/自愈完成/.test(line)) continue;
    // 启动预热早于 WS 打开，旧版本会刷这条 warn；根因已在 syncStickerLibrary 里改为
    // 未连接时直接用缓存，历史日志行不应继续污染巡检。
    if (/\[sticker\] 同步收藏表情失败: SnowLuma WebSocket closed before opening/.test(line)) continue;
    errors.push(String(line)
      .replace(/(Bearer\s+)\S+/gi, '$1***')
      .replace(/((?:token|key|secret|password)\s*[=:]\s*)\S+/gi, '$1***')
      // QQ 号/群号至少 6 位；端口通常 4~5 位，不受影响。
      .replace(/\b\d{6,}\b/g, '<id>')
      .slice(0, 400));
  }
  return errors.slice(-10);
}

export function deepMerge(base, override) {
  if (override === null || typeof override !== 'object' || Array.isArray(override)) return override === undefined ? base : override;
  const out = (base && typeof base === 'object' && !Array.isArray(base)) ? { ...base } : {};
  for (const [k, v] of Object.entries(override)) {
    out[k] = (v && typeof v === 'object' && !Array.isArray(v)) ? deepMerge(out[k], v) : v;
  }
  return out;
}

export function freeDiskSpace(dir) {
  try {
    const stat = fs.statfsSync(dir);
    return { total: stat.blocks * stat.bsize, free: stat.bavail * stat.bsize };
  } catch { return null; }
}

export function pidAlive(pid) {
  if (!Number.isFinite(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
