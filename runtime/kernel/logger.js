// 结构化日志（JSONL）。
//
// 与原有的纯文本控制台日志并存：控制台日志方便人看，JSONL 方便 doctor / 事后检索。
// 每行一个对象：{ ts, level, area, msg, ...meta }，敏感值在写入前脱敏。
//
// 落盘位置默认 state/logs/bridge-YYYY-MM-DD.jsonl；超过 maxBytes 时当天追加 .1、.2。

import fs from 'node:fs';
import path from 'node:path';

const REDACTIONS = [
  [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer ***'],
  [/((?:access_?token|consoleToken|api[_-]?key|authToken|password|secret|cookie)\s*[=:]\s*)["']?[^\s"',;}]{4,}/gi, '$1***'],
  [/([?&](?:token|access_token|key|apikey)=)[^&\s]+/gi, '$1***']
];

export function redactLogText(text) {
  let out = String(text ?? '');
  for (const [re, replacement] of REDACTIONS) out = out.replace(re, replacement);
  return out;
}

function localDate(now) {
  const d = new Date(now);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function createJsonlLogger({
  dir,
  prefix = 'bridge',
  maxBytes = 8 * 1024 * 1024,
  now = () => Date.now(),
  echo = null,
  extraSecrets = []
} = {}) {
  if (!dir) throw new Error('createJsonlLogger 需要 dir');
  fs.mkdirSync(dir, { recursive: true });
  let stream = null;
  let streamDate = '';
  let written = 0;
  const secrets = extraSecrets.filter((s) => typeof s === 'string' && s.length >= 6);

  function scrub(value, depth = 0) {
    if (value === null || value === undefined) return value;
    if (typeof value === 'string') {
      let out = redactLogText(value);
      for (const secret of secrets) if (out.includes(secret)) out = out.split(secret).join('***');
      return out;
    }
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (depth > 3) return '[object]';
    if (Array.isArray(value)) return value.slice(0, 50).map((v) => scrub(v, depth + 1));
    if (typeof value === 'object') {
      const out = {};
      for (const [k, v] of Object.entries(value)) {
        if (/token|secret|password|apikey|api_key|cookie/i.test(k)) out[k] = v ? '***' : '';
        else out[k] = scrub(v, depth + 1);
      }
      return out;
    }
    return String(value);
  }

  function rotateIfNeeded(date) {
    const file = path.join(dir, `${prefix}-${date}.jsonl`);
    let size = 0;
    try { size = fs.statSync(file).size; } catch { /* 尚未创建 */ }
    if (size > maxBytes) {
      for (let i = 4; i >= 1; i -= 1) {
        const from = i === 1 ? file : `${file}.${i - 1}`;
        const to = `${file}.${i}`;
        try { if (fs.existsSync(from)) fs.renameSync(from, to); } catch { /* 抢占失败忽略 */ }
      }
    }
    return file;
  }

  function write(level, msg, meta = {}) {
    const at = now();
    const date = localDate(at);
    try {
      const file = rotateIfNeeded(date);
      const line = JSON.stringify({
        ts: new Date(at).toISOString(),
        level,
        msg: scrub(String(msg ?? '')),
        ...(meta && typeof meta === 'object' ? scrub(meta) : {})
      });
      fs.appendFileSync(file, `${line}\n`, 'utf8');
      written += 1;
      streamDate = date;
    } catch (error) {
      // 日志失败绝不拖垮主流程；只在 stderr 留一行（避免递归写日志）。
      try { console.error('[jsonl-log] 写入失败:', error?.message ?? error); } catch {}
    }
    if (typeof echo === 'function') {
      try { echo({ level, msg, meta }); } catch {}
    }
  }

  return {
    debug: (msg, meta) => write('debug', msg, meta),
    info: (msg, meta) => write('info', msg, meta),
    warn: (msg, meta) => write('warn', msg, meta),
    error: (msg, meta) => write('error', msg, meta),
    child(fields = {}) {
      return {
        debug: (msg, meta) => write('debug', msg, { ...fields, ...meta }),
        info: (msg, meta) => write('info', msg, { ...fields, ...meta }),
        warn: (msg, meta) => write('warn', msg, { ...fields, ...meta }),
        error: (msg, meta) => write('error', msg, { ...fields, ...meta })
      };
    },
    stats() {
      return { dir, prefix, lastDate: streamDate, lines: written };
    }
  };
}

/** 从最近的 JSONL 里读最后 N 行（doctor 用），损坏行跳过。 */
export function readRecentLogs(dir, { prefix = 'bridge', limit = 50 } = {}) {
  let files = [];
  try {
    files = fs.readdirSync(dir)
      .filter((name) => name.startsWith(`${prefix}-`) && name.endsWith('.jsonl'))
      .sort();
  } catch { return []; }
  const out = [];
  for (const name of files.slice(-3).reverse()) {
    let lines = [];
    try { lines = fs.readFileSync(path.join(dir, name), 'utf8').split('\n'); } catch { continue; }
    for (let i = lines.length - 1; i >= 0 && out.length < limit; i -= 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try { out.push(JSON.parse(line)); } catch { /* 跳过损坏行 */ }
    }
    if (out.length >= limit) break;
  }
  return out.reverse();
}
