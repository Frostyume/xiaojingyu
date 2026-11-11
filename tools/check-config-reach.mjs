#!/usr/bin/env node
// 死开关检测：用户可见的配置键必须真的被运行期读到，否则就是「拨了开关没行为」。
//
// 为什么要这个工具：控制面板会往 config.json 写任意键，写进去 ≠ 有人在读。
// 已知真实例子 simulation.speech.asr.provider —— 运行期只读 asr.enabled /
// asr.timeoutMs / asr.cacheTtlMs（app/whale.js 的 ASR 装配段），全库没有任何地方
// 读 provider，所以它是个假开关。
//
// 用法：
//   node tools/check-config-reach.mjs                 # 人读报告
//   node tools/check-config-reach.mjs --check         # 有硬问题时退出码 1（verify/CI 用）
//   node tools/check-config-reach.mjs --json          # 机器可读（doctor 用）
//   node tools/check-config-reach.mjs --show=reachable # 连判定为可达的键一起列出来
//   node tools/check-config-reach.mjs --trace <key>   # 单个键为什么这么判：证据 + 候选链
//
// 判定口径（原则：宁可降级成 advisory，也不误报 hard）：
//   hard     —— 卡片可见的叶子键，在源码目录里找不到任何读取证据，连父对象都没被读出过；
//   advisory —— 配置目录里声明但非卡片键无人读；或证据形态可疑（只写不读、
//               经别名/取值函数/相似命名读取、父级段名太通用、只是同一行共现、
//               只找到父对象被整体读出而叶子没点名），需要人工确认但不拦门禁。
// tools/reach-allowlist.json 里声明过的键归入「已知未实现」，不算 hard。
//
// 认这些写法当读取证据：
//   完整路径字符串        'simulation.sticker.enabled'
//   可选链逐层访问        cfg.simulation?.sticker?.enabled
//   解构后的局部变量      const { collect } = cfg.simulation.sticker → collect.enabled
//   取值函数别名          const rc = riceConfig() → rc.dailyTokens（riceConfig 体内读的是 simulation.rice）
//   features.* 专用       featureEnabled(cfg, 'outerWorld')
//   父对象整体读出        cognition: cfg.simulation?.cognition?.relationshipModulation（当参数递出去 /
//                         ...展开 / 归一化后交给下游）→ 底下每个叶子算弱证据：拨了有行为，
//                         但静态看不到谁消费了这个叶子，所以只降到 advisory，不判 hard。
//
// 有两族噪声是静态扫描的结构性盲区，永远只能给 advisory，不是缺陷，不许当硬问题修：
//   ① 先取父对象再走局部变量：helper 里读 cfg.simulation.media.frameExtract 后返回新对象，
//      调用方只用 opts.quality 等局部字段；扫描器看不到 opts 与配置路径的绑定。
//      要点：helper 函数内的父链是证据，调用点的 opts.* 不是。
//   ② 父对象整体读出后递参数/展开/归一化：如 tts 整段交给 featureVoiceInstruction(cfg.tts)，
//      或 ...cfg.tts 展开进新对象。叶子由下游按自己的默认值消费，静态上永远没被点名。
// 这两族出现在 advisory 里是正常现象；allowlist 也不收它们，除非另有「源码自注永不读取」的证据。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FEATURE_CARDS, cardSwitchKey } from '../runtime/control/feature-control.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const DEFAULT_ALLOWLIST = 'tools/reach-allowlist.json';
const DEFAULT_CATALOG = 'config.example.json';

// 运行期源码目录（配置读取只可能发生在这里；tools/tests/web 不算）。
const SOURCE_DIRS = ['app', 'runtime', 'services', 'channels', 'features', 'mcp', 'console'];

// 这三个文件是「定义」而不是「读取」：键名以字符串字面量成批出现，
// 拿它们当证据会让每个键都自证可达，工具就废了。它们里面的属性访问链仍然算证据。
const LITERAL_BLIND_FILES = new Set([
  'runtime/kernel/config-schema.js',
  'runtime/control/feature-control.js'
]);

// feature-switches.js 里 FEATURE_MODULES 的 id/label/description 只是声明；但
// SHARE_MODULE_FEATURES / featureForInnerJob 里的取值才是运行期映射到的总开关 id。
const FEATURES_FILE = 'runtime/control/feature-switches.js';

// 父级段名太通用时，「父级.叶子」这种弱证据不能证明读的就是这个键。
const GENERIC_SEGMENT_RE = /^(cfg|config|configs|data|obj|object|item|items|value|values|val|raw|state|meta|info|entry|entries|opts|options|params|args|this|that|current|node|body|row|rows|list|defaults|def|card|cards|field|fields|key|keys|mod|mods|module|modules|section|sections|group|groups|all|source|sources|target|result|results|rec|it|o|p|q|x|y|z|n|s|c|v|t|r|e|a|b)$/;

// 配置对象在代码里的常见根名。
const CONFIG_ROOTS = new Set(['cfg', 'config', 'conf', 'rawConfig', 'fileConfig', 'runtimeConfig']);

const STRONG_LEVELS = new Set(['full', 'tail', 'string', 'feature-call', 'feature-map']);
const WEAK_LEVELS = new Set(['similar', 'tail-generic', 'line', 'alias', 'parent']);

const ACCESS_RE = /\?\.\s*([A-Za-z_$][A-Za-z0-9_$]*)|\.\s*([A-Za-z_$][A-Za-z0-9_$]*)|\[\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\]/g;
const DOTTED_RE = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$/;
const WORD_RE = /[A-Za-z_$][A-Za-z0-9_$]*/g;
const BARE_ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * 把注释和字符串/模板字面量的字面文本挖空，只留下真正的代码；同时收集字符串字面量。
 * keep 只挖注释、不挖字符串内容，用来匹配 `featureEnabled(cfg, 'lifeDigest')` 这类实参。
 */
function scanSource(text) {
  const chars = Array.from(text);
  const keep = Array.from(text);
  const n = chars.length;
  const strings = new Map(); // 内容起始下标 → 字面量值
  const stack = [];
  let lastSignificant = '';

  const blank = (arr, from, to) => {
    for (let k = from; k < to && k < n; k += 1) if (arr[k] !== '\n') arr[k] = ' ';
  };

  let i = 0;
  while (i < n) {
    const c = chars[i];
    const top = stack[stack.length - 1];

    if (top?.type === 'str') {
      if (c === '\\') { blank(chars, i, i + 2); top.val += c + (chars[i + 1] ?? ''); i += 2; continue; }
      if (c === top.quote) { strings.set(top.start, top.val); stack.pop(); i += 1; continue; }
      blank(chars, i, i + 1); top.val += c; i += 1; continue;
    }

    if (top?.type === 'tpl') {
      if (c === '\\') { blank(chars, i, i + 2); i += 2; continue; }
      if (c === '`') { strings.set(top.start, top.val); stack.pop(); i += 1; continue; }
      if (c === '$' && chars[i + 1] === '{') {
        blank(chars, i, i + 2); // 抹掉 ${ ，剩下的交给花括号计数
        stack.push({ type: 'brace', depth: 0 });
        i += 2; continue;
      }
      top.val += c; blank(chars, i, i + 1); i += 1; continue;
    }

    if (top?.type === 'brace') {
      if (c === '{') { top.depth += 1; i += 1; continue; }
      if (c === '}') {
        if (top.depth === 0) {
          stack.pop();
          const tpl = stack[stack.length - 1];
          if (tpl?.type === 'tpl') tpl.start = i + 1; // 表达式结束，模板余下部分仍是字面文本
          i += 1;
          continue;
        }
        top.depth -= 1; i += 1; continue;
      }
      // 其余字符按代码继续处理
    }

    // ── 代码态 ──
    if (c === '/' && chars[i + 1] === '/') { let j = i; while (j < n && chars[j] !== '\n') { blank(chars, j, j + 1); blank(keep, j, j + 1); j += 1; } i = j; continue; }
    if (c === '/' && chars[i + 1] === '*') { let j = i; while (j < n && !(chars[j] === '*' && chars[j + 1] === '/')) { blank(chars, j, j + 1); blank(keep, j, j + 1); j += 1; } blank(chars, j, j + 2); blank(keep, j, j + 2); i = Math.min(n, j + 2); continue; }
    if (c === '"' || c === "'") { stack.push({ type: 'str', quote: c, val: '', start: i + 1 }); i += 1; lastSignificant = c; continue; }
    if (c === '`') { stack.push({ type: 'tpl', val: '', start: i + 1 }); i += 1; lastSignificant = c; continue; }
    if (c === '/' && /[=(,:;[{&|!+\-*%~^?]$/.test(lastSignificant)) {
      // 正则字面量：只跳过，不挖空（里面的 // 不是注释）
      let j = i + 1; let inClass = false;
      while (j < n) {
        if (chars[j] === '\\') { j += 2; continue; }
        if (chars[j] === '[') inClass = true;
        else if (chars[j] === ']') inClass = false;
        else if (chars[j] === '/' && !inClass) break;
        else if (chars[j] === '\n') break;
        j += 1;
      }
      i = Math.min(n, j + 1); lastSignificant = '/'; continue;
    }
    if (!/\s/.test(c)) lastSignificant = c;
    i += 1;
  }

  return { code: chars.join(''), keep: keep.join(''), strings };
}

function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') starts.push(i + 1);
  return starts;
}

function lineOf(starts, index) {
  let lo = 0; let hi = starts.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (starts[mid] <= index) lo = mid; else hi = mid - 1; }
  return lo + 1;
}

/** 从访问符往前找根名（倒着扫，避免对大文件做整段 slice）。 */
function rootBefore(code, index, limit = 6000) {
  let k = index - 1;
  while (k >= 0 && /\s/.test(code[k])) k -= 1;
  if (k < 0) return { root: '', callRoot: false };
  if (code[k] === ')') {
    let depth = 0;
    const floor = Math.max(0, k - limit);
    for (; k >= floor; k -= 1) {
      if (code[k] === ')') depth += 1;
      else if (code[k] === '(') {
        depth -= 1;
        if (depth === 0) {
          k -= 1;
          while (k >= 0 && /\s/.test(code[k])) k -= 1;
          const end = k + 1;
          while (k >= 0 && /[\w$]/.test(code[k])) k -= 1;
          return { root: end > k + 1 ? code.slice(k + 1, end) : '', callRoot: true };
        }
      }
    }
    return { root: '', callRoot: true };
  }
  if (!/[\w$]/.test(code[k])) return { root: '', callRoot: false };
  const end = k + 1;
  while (k >= 0 && /[\w$]/.test(code[k])) k -= 1;
  return { root: code.slice(k + 1, end), callRoot: false };
}

function closeBraceOf(code, openIndex) {
  let depth = 0;
  for (let k = openIndex; k < code.length; k += 1) {
    if (code[k] === '{') depth += 1;
    else if (code[k] === '}') { depth -= 1; if (depth === 0) return k; }
  }
  return code.length - 1;
}

/** 抽取属性访问链：根名 + 连续属性名序列；链尾是赋值目标则整条算「写」。 */
function extractChains(code, from, to) {
  const chains = [];
  let prev = null;
  ACCESS_RE.lastIndex = 0;
  let m;
  while ((m = ACCESS_RE.exec(code)) !== null) {
    if (m.index < from) continue;
    if (m.index >= to) break;
    const prop = m[1] ?? m[2] ?? m[3];
    if (!prop) continue;
    const end = m.index + m[0].length;
    if (prev && /^\s*$/.test(code.slice(prev.end, m.index))) {
      prev.tokens.push(prop);
      prev.end = end;
      continue;
    }
    const rb = rootBefore(code, m.index);
    prev = { root: rb.root, callRoot: rb.callRoot, tokens: [prop], start: m.index, end };
    chains.push(prev);
  }
  return chains;
}

function fileChains(code, { file, lines, starts }) {
  const chains = extractChains(code, 0, code.length);
  for (const chain of chains) {
    chain.file = file;
    chain.line = lineOf(starts, chain.start);
    chain.read = !/^\s*(?:=[^=]|[-+*/%|&^]=|\*\*=|\|\|=|&&=)/.test(code.slice(chain.end, chain.end + 8));
    chain.lineText = (lines[chain.line - 1] ?? '').trim().slice(0, 150);
  }
  return chains;
}

/** const NAME = 一条链 / const { prop } = 一条链 → NAME 是该路径的别名。 */
function extractAliases(code) {
  const aliases = new Map();
  const add = (name, entries) => {
    const list = (entries ?? []).filter(Boolean).slice(0, 4);
    if (!name || !list.length) return;
    if (!aliases.has(name)) aliases.set(name, []);
    const cur = aliases.get(name);
    for (const entry of list) {
      if (cur.length >= 4) break;
      if (cur.some((x) => x.root === entry.root && x.tokens.join('.') === entry.tokens.join('.'))) continue;
      cur.push(entry);
    }
  };
  let m;
  const singleRe = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([^;\n]{0,200}(?:\n[^\n;]{0,200}){0,2})/g;
  while ((m = singleRe.exec(code)) !== null) {
    const end = m.index + m[0].length;
    add(m[1], extractChains(code, end - m[2].length, end));
  }
  // const rc = riceConfig() / const sing = normalizeSingingConfig(t.singing)
  // → rc 走 riceConfig 的函数体，sing 走实参那条链（t 再往前追到 cfg.tts）
  const callRe = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(([^;\n]{0,200})/g;
  while ((m = callRe.exec(code)) !== null) {
    const from = m.index + m[0].length - m[3].length;
    add(m[1], [{ root: m[2], tokens: [] }, ...extractChains(code, from, Math.min(code.length, from + m[3].length))]);
  }
  const destructureRe = /(?:const|let|var)\s*\{([^{}]{0,300})\}\s*=\s*([^;\n]{0,200})/g;
  while ((m = destructureRe.exec(code)) !== null) {
    const pairs = m[1].split(',')
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [prop, local] = part.includes(':') ? part.split(':').map((s) => s.trim()) : [part, part];
        return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prop) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(local) ? { prop, local } : null;
      })
      .filter(Boolean);
    const end = m.index + m[0].length;
    const pick = extractChains(code, end - m[2].length, end)[0];
    if (!pick) continue;
    // const { browse } = cfg.simulation.outerWorld → browse 指向 simulation.outerWorld.browse
    for (const { prop, local } of pairs) add(local, [{ root: pick.root, tokens: [...pick.tokens, prop] }]);
  }
  return aliases;
}

/** function xConfig() { … cfg.simulation?.x … } / const xCfg = () => norm(cfg.simulation?.x) → 读的是 simulation.x */
function extractFnPaths(code) {
  const fnPaths = new Map();
  const collect = (name, from, to) => {
    const body = extractChains(code, from, to)
      .filter((chain) => CONFIG_ROOTS.has(chain.root));
    if (!body.length) return false;
    const sorted = body
      .map((chain) => [chain.root, ...chain.tokens])
      .sort((a, b) => b.length - a.length);
    const uniq = [];
    for (const tokens of sorted) {
      if (uniq.some((t) => t.join('.').startsWith(tokens.join('.')))) continue;
      uniq.push(tokens);
      if (uniq.length >= 3) break;
    }
    if (!fnPaths.has(name)) fnPaths.set(name, uniq);
    return true;
  };
  let m;
  const fnRe = /\bfunction\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*\([^)]*\)\s*\{/g;
  while ((m = fnRe.exec(code)) !== null) {
    const open = m.index + m[0].length - 1;
    collect(m[1], open, closeBraceOf(code, open));
    fnRe.lastIndex = open + 1;
  }
  const arrowRe = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*(?:\([^)]*\)|[A-Za-z_$][A-Za-z0-9_$]*)\s*=>\s*/g;
  while ((m = arrowRe.exec(code)) !== null) {
    const rest = code[m.index + m[0].length];
    const to = rest === '{' ? closeBraceOf(code, m.index + m[0].length) : Math.min(code.length, m.index + m[0].length + 400);
    collect(m[1], m.index + m[0].length, to);
    arrowRe.lastIndex = m.index + m[0].length;
  }
  return fnPaths;
}

function expandName(name, aliases, fnPaths, cache, depth = 3) {
  if (depth <= 0 || !name) return [[name || '_']];
  const cacheKey = `${depth}|${name}`;
  if (cache.has(cacheKey)) return cache.get(cacheKey);
  const local = [];
  const alias = aliases.get(name);
  if (alias) {
    for (const entry of alias) {
      for (const prefix of expandName(entry.root, aliases, fnPaths, cache, depth - 1)) {
        local.push([...prefix, ...entry.tokens]);
      }
    }
  }
  if (!local.length) {
    for (const tokens of fnPaths.get(name) ?? []) {
      for (const prefix of expandName(tokens[0], aliases, fnPaths, cache, depth - 1)) {
        local.push([...prefix, ...tokens.slice(1)]);
      }
    }
  }
  const out = local.length ? local.slice(0, 4) : [[name]];
  cache.set(cacheKey, out);
  return out;
}

function chainPaths(chain, aliases, fnPaths, cache) {
  const heads = chain.root
    ? expandName(chain.root, aliases, fnPaths, cache)
    : [['_']];
  return heads.map((head) => [...head, ...chain.tokens]);
}

function containsPath(tokens, needle) {
  if (!needle.length || tokens.length < needle.length) return false;
  outer: for (let i = 0; i + needle.length <= tokens.length; i += 1) {
    for (let j = 0; j < needle.length; j += 1) if (tokens[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** 链正好停在 needle 上：读的是这个对象本身，而不是它底下某个字段。 */
function endsWithPath(tokens, needle) {
  if (!needle.length || tokens.length < needle.length) return false;
  const offset = tokens.length - needle.length;
  return needle.every((token, j) => tokens[offset + j] === token);
}

function listSourceFiles(root) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (/^(node_modules|state|fixtures|dist|\.git)$/.test(entry.name)) continue;
        walk(path.join(dir, entry.name));
      } else if (entry.name.endsWith('.js')) {
        out.push(path.relative(root, path.join(dir, entry.name)).split(path.sep).join('/'));
      }
    }
  };
  for (const dirName of SOURCE_DIRS) {
    const dir = path.join(root, dirName);
    if (fs.existsSync(dir)) walk(dir);
  }
  return out.sort();
}

export function collectVisibleKeys() {
  const keys = new Map();
  const push = (key, kind, card) => {
    if (!key || typeof key !== 'string') return;
    const current = keys.get(key) ?? { key, kinds: [], cards: [] };
    current.kinds.push(kind);
    if (card) current.cards.push(card);
    keys.set(key, current);
  };
  for (const card of FEATURE_CARDS) {
    push(cardSwitchKey(card), 'card-switch', card.id);
    for (const field of card.advanced || []) push(field.key, 'card-advanced', card.id);
    for (const key of card.resetKeys || []) push(key, 'card-reset', card.id);
    for (const key of card.covers || []) push(key, 'card-cover', card.id);
  }
  return [...keys.values()];
}

/**
 * 配置目录 = 仓库随附的 config.example.json 全量形状（config.schema.json 由它生成）。
 * 这里只静态读取模板，不启动运行期代码，也不读本机 config.json。
 */
export function collectSchemaKeys(root = ROOT) {
  const p = path.join(root, DEFAULT_CATALOG);
  if (!fs.existsSync(p)) return [];
  const flatten = (value, prefix, out) => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      if (prefix) out.push(prefix);
      return out;
    }
    for (const [k, v] of Object.entries(value)) flatten(v, prefix ? `${prefix}.${k}` : k, out);
    return out;
  };
  const keys = flatten(JSON.parse(fs.readFileSync(p, 'utf8')), '', []);
  return [...new Set(keys)].sort();
}

export function readAllowlist(root = ROOT, file = DEFAULT_ALLOWLIST) {
  const p = path.isAbsolute(file) ? file : path.join(root, file);
  if (!fs.existsSync(p)) return [];
  const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
  return Array.isArray(parsed) ? parsed : (parsed.entries ?? []);
}

/**
 * allowlist 防腐锁：条目必须完整、真实、仍不可达、不重复。
 * 任何一条不满足都返回点名的错误，--check 据此判红。
 */
export function validateAllowlist(entries, { schemaKeys = [], reachableKeys = [] } = {}) {
  const problems = [];
  const schema = new Set(schemaKeys);
  const reachable = new Set(reachableKeys);
  const seen = new Set();
  entries.forEach((entry, index) => {
    const at = `allowlist 第 ${index + 1} 项`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`${at} 不是对象`);
      return;
    }
    const key = typeof entry.key === 'string' ? entry.key : '';
    const reason = typeof entry.reason === 'string' ? entry.reason : '';
    if (!key.trim()) problems.push(`${at} 缺少非空 key`);
    if (!reason.trim()) problems.push(`${at}（${key.trim() || '?'}）缺少非空 reason`);
    if (!key.trim()) return;
    if (seen.has(key)) problems.push(`allowlist 重复条目：${key}（第 ${index + 1} 项）`);
    seen.add(key);
    if (!schema.has(key)) problems.push(`${at} 的 key 不在配置目录：${key}（拼错或已删除）`);
    if (reachable.has(key)) problems.push(`allowlist 已过期：${key} 运行期已可达，请删除该条目`);
  });
  return problems;
}

function buildIndex(root, files) {
  const chains = [];
  const literals = new Map();
  const calls = [];
  const featureIds = new Set();
  const words = new Map(); // 「父级名 + 叶子名 同行共现」兜底用
  const accessWords = new Map(); // 只做属性访问（.leaf / ?.leaf / [leaf]）的行号索引
  const expandCache = new Map();
  for (const rel of files) {
    const abs = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(abs)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const starts = lineStarts(text);
    const lines = text.split(/\r?\n/);
    const { code, keep, strings } = scanSource(text);
    const aliases = extractAliases(code);
    const fnPaths = extractFnPaths(code);
    for (const chain of fileChains(code, { file: rel, lines, starts })) {
      chain.paths = chainPaths(chain, aliases, fnPaths, expandCache);
      chains.push(chain);
    }
    for (const [at, value] of strings) {
      if (rel === FEATURES_FILE) {
        // feature-switches.js 里 SHARE_MODULE_FEATURES / featureForInnerJob 的取值就是运行期
        // 映射到的总开关 id；FEATURE_MODULES 的 id/label/description 只是声明，不算证据。
        if (BARE_ID_RE.test(value) && !/(?:id|label|description|reason)\s*:\s*['"`]?\s*$/.test(code.slice(Math.max(0, at - 24), at))) {
          featureIds.add(value);
        }
        continue;
      }
      if (LITERAL_BLIND_FILES.has(rel)) continue;
      if (!DOTTED_RE.test(value)) continue;
      if (!literals.has(value)) literals.set(value, []);
      literals.get(value).push({ file: rel, line: lineOf(starts, at) });
    }
    for (const m of keep.matchAll(/\bfeature(?:Enabled|Disabled)\s*\(\s*(?:[^,()]+,\s*)?'([A-Za-z0-9_]+)'/g)) {
      calls.push({ file: rel, id: m[1], line: lineOf(starts, m.index) });
    }
    // 「父级名 + 叶子名 同行共现」兜底：只用挖掉注释和字符串之后的代码；
    // 叶子必须真的是属性访问（.leaf），否则 config 默认值里的 `enabled: false` 会自证可达。
    const codeLines = code.split('\n');
    for (let ln = 0; ln < codeLines.length; ln += 1) {
      for (const w of codeLines[ln].matchAll(WORD_RE)) {
        const at = `${rel}:${ln + 1}`;
        if (!words.has(w[0])) words.set(w[0], new Set());
        words.get(w[0]).add(at);
      }
      for (const w of codeLines[ln].matchAll(ACCESS_RE)) {
        const prop = w[1] ?? w[2] ?? w[3];
        if (!prop) continue;
        const at = `${rel}:${ln + 1}`;
        if (!accessWords.has(prop)) accessWords.set(prop, new Set());
        accessWords.get(prop).add(at);
      }
    }
  }
  // 按 token 建倒排：判定某个键只看含叶子名的链，否则几百个键 × 几万条链太慢。
  const byToken = new Map();
  for (const chain of chains) {
    for (const token of new Set(chain.paths.flatMap((p) => p))) {
      if (!byToken.has(token)) byToken.set(token, []);
      byToken.get(token).push(chain);
    }
  }
  return { chains, literals, calls, featureIds, words, accessWords, byToken };
}

function similar(a, b) {
  if (!a || !b || a === b) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 4 && longer.startsWith(shorter);
}

function coOccurrence(index, parent, leaf) {
  const leafLines = index.accessWords.get(leaf);
  const parentLines = index.words.get(parent);
  if (!leafLines || !parentLines) return null;
  const [small, big] = leafLines.size <= parentLines.size ? [leafLines, parentLines] : [parentLines, leafLines];
  for (const at of small) if (big.has(at)) return at;
  return null;
}

function evidenceFor(key, index) {
  const segments = key.split('.');
  const leaf = segments[segments.length - 1];
  const parent = segments[segments.length - 2] ?? '';
  const hits = [];

  for (const chain of index.byToken.get(leaf) ?? []) {
    if (chain.paths.some((tokens) => containsPath(tokens, segments))) {
      hits.push({ level: 'full', file: chain.file, line: chain.line, read: chain.read, text: chain.lineText });
    } else if (segments.length >= 2 && chain.paths.some((tokens) => containsPath(tokens, [parent, leaf]))) {
      hits.push({
        level: GENERIC_SEGMENT_RE.test(parent) ? 'tail-generic' : 'tail',
        file: chain.file,
        line: chain.line,
        read: chain.read,
        text: chain.lineText
      });
    } else if (segments.length >= 2 && similar(chain.root, parent)) {
      hits.push({ level: 'similar', file: chain.file, line: chain.line, text: chain.lineText });
    }
  }

  for (const literal of index.literals.get(key) ?? []) {
    hits.push({ level: 'string', file: literal.file, line: literal.line, read: true, text: `'${key}'` });
  }
  if (segments[0] === 'features' && segments.length === 2) {
    for (const call of index.calls) {
      if (call.id === leaf) hits.push({ level: 'feature-call', file: call.file, line: call.line, read: true, text: `featureEnabled(cfg, '${call.id}')` });
    }
    if (index.featureIds.has(leaf)) {
      hits.push({ level: 'feature-map', file: FEATURES_FILE, line: 0, read: true, text: `feature-switches.js 的映射表把运行期入口接到 ${leaf}` });
    }
  }
  if (!hits.some((h) => STRONG_LEVELS.has(h.level)) && segments.length >= 2) {
    // 父对象整体被读（当参数递出去、展开进别的对象、归一化后交给下游）时，叶子没被点名
    // 也不算假开关。但「读到父对象」≠「消费了这个叶子」，所以只给弱证据、落 advisory。
    const parentSegments = segments.slice(0, -1);
    let checked = 0;
    for (const chain of index.byToken.get(parentSegments[parentSegments.length - 1]) ?? []) {
      if (checked++ > 4000) break;
      if (!chain.read) continue;
      if (!chain.paths.some((tokens) => endsWithPath(tokens, parentSegments))) continue;
      hits.push({
        level: 'parent',
        file: chain.file,
        line: chain.line,
        read: true,
        text: `父对象 ${parentSegments.join('.')} 被整体读出：${chain.file}:${chain.line} ${chain.lineText}`
      });
      break;
    }
  }
  if (!hits.some((h) => STRONG_LEVELS.has(h.level)) && parent) {
    const at = coOccurrence(index, parent, leaf);
    if (at) hits.push({ level: 'line', read: true, text: `同一行同时出现 ${parent} 与 ${leaf}：${at}` });
  }
  return hits;
}

export function analyzeConfigReach({ root = ROOT, extraVisibleKeys = [], allowlistEntries = null, allowlistFile = DEFAULT_ALLOWLIST } = {}) {
  const files = listSourceFiles(root);
  const index = buildIndex(root, files);
  const extra = extraVisibleKeys.map((item) => (typeof item === 'string'
    ? { key: item, kinds: ['card-switch'], cards: [] }
    : { key: item.key, kinds: [item.kind ?? 'card-switch'], cards: item.cards ?? [] }));
  const visible = collectVisibleKeys().concat(extra);
  const schemaKeys = collectSchemaKeys(root);
  const allowlist = allowlistEntries ?? readAllowlist(root, allowlistFile);
  const allow = new Map(allowlist.map((entry) => [entry.key, entry.reason ?? '']));

  const visibleLeaf = new Set(visible.filter((v) => !v.kinds.includes('card-cover')).map((v) => v.key));
  const visibleCover = new Set(visible.filter((v) => v.kinds.includes('card-cover')).map((v) => v.key));
  const hard = [];
  const advisory = [];
  const suppressed = [];
  const reachable = [];

  const evaluate = (key, { kind, cards, prefix }) => {
    const hits = evidenceFor(key, index);
    const strong = hits.filter((h) => STRONG_LEVELS.has(h.level) && h.read);
    const writes = hits.filter((h) => STRONG_LEVELS.has(h.level) && h.read === false);
    const weak = hits.filter((h) => WEAK_LEVELS.has(h.level));
    const record = { key, kind, cards: [...new Set(cards ?? [])], levels: [...new Set(hits.map((h) => h.level))], hits: hits.slice(0, 3) };
    if (strong.length) { reachable.push(record); return; }
    if (allow.has(key)) { suppressed.push({ ...record, reason: allow.get(key) }); return; }
    if (weak.length) {
      const hit = weak.find((h) => h.level === 'parent') ?? weak[0];
      advisory.push({
        ...record,
        weak: true,
        why: hit.level === 'parent'
          ? `只找到父对象被整体读出（递参数/展开/归一化），叶子本身没点到名：${hit.text}`
          : `证据可疑（${hit.level}）：${hit.text || hit.file || ''}`
      });
      return;
    }
    if (writes.length) { advisory.push({ ...record, why: '只找到写入/迁移，没找到运行期读取' }); return; }
    if (prefix || kind === 'card-cover') { advisory.push({ ...record, why: '卡片声明的覆盖前缀无人读（不是开关本身）' }); return; }
    if (visibleLeaf.has(key)) { hard.push({ ...record, why: '控制台能拨这个开关/改这个字段，但源码目录里没有任何读取证据' }); return; }
    advisory.push({ ...record, why: '配置目录里声明、非卡片键，运行期无人读' });
  };

  for (const entry of visible) evaluate(entry.key, { kind: entry.kinds.join(','), cards: entry.cards, prefix: entry.kinds.includes('card-cover') });
  for (const key of schemaKeys) {
    if (visibleLeaf.has(key) || visibleCover.has(key)) continue;
    evaluate(key, { kind: 'schema', cards: [], prefix: false });
  }

  return {
    files: files.length,
    visibleTotal: visible.length,
    schemaTotal: schemaKeys.length,
    reachable: reachable.length,
    hard,
    advisory,
    suppressed,
    reachableKeys: reachable.map((r) => r.key).sort(),
    allowlistProblems: validateAllowlist(allowlist, { schemaKeys, reachableKeys: reachable.map((r) => r.key) }),
    stats: { hard: hard.length, advisory: advisory.length, suppressed: suppressed.length, allowlist: allowlist.length }
  };
}

function fmtList(items, { detail = false } = {}) {
  if (!items.length) return ['  （无）'];
  return items.map((item) => {
    const where = item.cards.length ? `卡片 ${item.cards.join('/')}` : item.kind;
    const line = `  - ${item.key}  【${where}】${item.why ? ` —— ${item.why}` : ''}${item.reason ? ` —— ${item.reason}` : ''}`;
    if (!detail || !item.hits.length) return line;
    return `${line}\n      证据：${item.hits.map((h) => `${h.level} ${h.file ?? ''}${h.line ? `:${h.line}` : ''} ${h.text}`).join('  |  ')}`;
  });
}

export function formatReport(result) {
  const lines = [];
  lines.push(`死开关检测：扫描 ${result.files} 个源文件，卡片可见键 ${result.visibleTotal} 个 / 配置目录键 ${result.schemaTotal} 个`);
  lines.push(`判定：可达 ${result.reachable}，硬问题 ${result.stats.hard}，advisory ${result.stats.advisory}，allowlist 命中 ${result.stats.suppressed}`);
  lines.push('');
  lines.push('硬问题（用户可见、运行期无人读，--check 会拦）：');
  lines.push(...fmtList(result.hard, { detail: true }));
  lines.push('');
  lines.push('advisory（建议人工确认，不拦门禁）：');
  lines.push(...fmtList(result.advisory));
  lines.push('');
  lines.push(`已知未实现（allowlist，共 ${result.suppressed.length} 项）：`);
  lines.push(...fmtList(result.suppressed));
  lines.push('');
  if (result.allowlistProblems?.length) {
    lines.push(`allowlist 自检失败（${result.allowlistProblems.length} 项，--check 会拦）：`);
    for (const problem of result.allowlistProblems) lines.push(`  - ${problem}`);
  } else {
    lines.push(`allowlist 自检通过（${result.stats.allowlist} 项：key/reason 完整、配置目录存在、仍不可达、无重复）`);
  }
  return lines.join('\n');
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const args = process.argv.slice(2);
  const traceAt = args.indexOf('--trace');
  if (traceAt >= 0 && args[traceAt + 1]) {
    const key = args[traceAt + 1];
    const index = buildIndex(ROOT, listSourceFiles(ROOT));
    const hits = evidenceFor(key, index);
    console.log(`${key} 的读取证据：`);
    for (const hit of hits) {
      console.log(`  [${hit.level}]${hit.read ? '' : '（写）'} ${hit.file ?? ''}${hit.line ? `:${hit.line}` : ''}  ${hit.text}`);
    }
    if (!hits.length) console.log('  （一条证据都没有）');
    const leaf = key.split('.').pop();
    console.log(`\n含 ${leaf} 的访问链（最多 12 条）：`);
    for (const chain of (index.byToken.get(leaf) ?? []).slice(0, 12)) {
      console.log(`  ${chain.file}:${chain.line} ${chain.paths.map((p) => p.join('.')).join(' / ')}${chain.read ? '' : '（写）'}`);
    }
    process.exitCode = 0;
  } else {
    const result = analyzeConfigReach();
    if (args.includes('--json')) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(formatReport(result));
      if (args.includes('--show=reachable')) {
        console.log('\n可达键：');
        console.log(...fmtList(result.reachableKeys.map((key) => ({ key, cards: [], kind: 'reachable' }))));
      }
    }
    if (args.includes('--check') && (result.hard.length || result.allowlistProblems.length)) process.exitCode = 1;
  }
}
