// 出门见闻：存储层（见闻卡片 / 读书进度 / 每日配额 / 审计 / 熔断）。
//
// 只做落盘与读取，不含业务判断：调用方负责内容、配额策略与降级。
// 关闭态零副作用：所有写方法内部才创建目录与文件；读方法一律返回安全默认。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { atomicWriteJson, atomicWriteText, readJsonSafe } from '../../../runtime/kernel/state-file.js';

const FILES = Object.freeze({
  state: 'outer-world.json',
  notes: 'outer-world-notes.jsonl',
  progress: 'leisure-progress.json',
  audit: 'outer-world-audit.jsonl'
});

const DEDUPE_CAP = 2000;
const CIRCUIT_OPEN_AFTER = 3;

export function shanghaiDayKey(ms = Date.now()) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function shortHash(value, len = 12) {
  return crypto.createHash('sha1').update(String(value ?? '')).digest('hex').slice(0, len);
}

function toInt(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
}

function normalizeState(raw) {
  const base = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const quota = base.quota && typeof base.quota === 'object' && !Array.isArray(base.quota) ? base.quota : {};
  const circuit = base.circuit && typeof base.circuit === 'object' && !Array.isArray(base.circuit) ? base.circuit : {};
  const dedupe = base.dedupe && typeof base.dedupe === 'object' && !Array.isArray(base.dedupe) ? base.dedupe : {};
  return {
    ...base,
    quota,
    dedupe,
    circuit: {
      fails: toInt(circuit.fails),
      openedAt: Number(circuit.openedAt) || null,
      lastError: String(circuit.lastError ?? '')
    }
  };
}

function emptyQuota(day) {
  return { day, items: 0, tokens: 0, chars: 0, browse: 0, updatedAt: 0 };
}

function parseLines(text) {
  return String(text || '').split(/\r?\n/).filter((line) => line.trim());
}

function readLines(file) {
  try {
    return parseLines(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}

function appendLines(file, lines) {
  const list = (Array.isArray(lines) ? lines : [lines]).filter(Boolean);
  if (!list.length) return false;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${list.map((line) => JSON.stringify(line)).join('\n')}\n`, 'utf8');
    return true;
  } catch {
    return false;
  }
}

export function createOuterWorldStore({ dir, now = () => Date.now() } = {}) {
  const baseDir = String(dir || '').trim();
  if (!baseDir) throw new Error('createOuterWorldStore 需要 dir');
  const fileOf = (kind) => path.join(baseDir, FILES[kind]);
  const at = () => Number(now()) || Date.now();

  const readState = () => normalizeState(readJsonSafe(fileOf('state'), {}));
  const writeState = (state) => { atomicWriteJson(fileOf('state'), normalizeState(state)); return state; };

  const notes = {
    append(card = {}) {
      const stamp = Number(card.at) || at();
      const id = String(card.id || '') || shortHash(`${card.dedupeKey || ''}|${stamp}|${card.title || ''}|${card.url || ''}`);
      const row = { ...card, id, at: stamp };
      if (!appendLines(fileOf('notes'), [row])) return { ok: false, id, at: stamp };
      return { ok: true, id, at: stamp };
    },
    list({ limit = 20 } = {}) {
      const rows = [];
      for (const line of readLines(fileOf('notes'))) {
        try {
          const row = JSON.parse(line);
          if (row && typeof row === 'object' && !Array.isArray(row)) rows.push(row);
        } catch {}
      }
      return rows.reverse().slice(0, Math.min(200, toInt(limit, 20) || 20));
    },
    dedupeHas(key) {
      const k = String(key || '').trim();
      if (!k) return false;
      if (readState().dedupe[k]) return true;
      return notes.list({ limit: 200 }).some((row) => String(row.dedupeKey || '') === k);
    },
    dedupeAdd(key) {
      const k = String(key || '').trim();
      if (!k) return false;
      const state = readState();
      state.dedupe[k] = toInt(state.dedupe[k], at()) || at();
      const keys = Object.keys(state.dedupe);
      if (keys.length > DEDUPE_CAP) {
        keys.sort((a, b) => (Number(state.dedupe[a]) || 0) - (Number(state.dedupe[b]) || 0));
        for (const old of keys.slice(0, keys.length - DEDUPE_CAP)) delete state.dedupe[old];
      }
      writeState(state);
      return true;
    }
  };

  const progress = {
    get(sourceId) {
      const id = String(sourceId || '').trim();
      if (!id) return null;
      const all = readJsonSafe(fileOf('progress'), {});
      const row = all && typeof all === 'object' ? all[id] : null;
      return row && typeof row === 'object' ? { ...row } : null;
    },
    set(sourceId, patch = {}) {
      const id = String(sourceId || '').trim();
      if (!id) throw new Error('progress.set 需要 sourceId');
      const all = readJsonSafe(fileOf('progress'), {});
      const prev = all && typeof all === 'object' && all[id] && typeof all[id] === 'object' ? all[id] : {};
      const next = { ...prev, ...patch, updatedAt: Number(patch.updatedAt) || at() };
      all[id] = next;
      atomicWriteJson(fileOf('progress'), all);
      return { ...next };
    }
  };

  const quota = {
    get(day = shanghaiDayKey(at())) {
      const key = String(day || '').trim();
      const state = readState();
      const row = state.quota[key];
      if (!row || typeof row !== 'object') return emptyQuota(key);
      return {
        day: key,
        items: toInt(row.items),
        tokens: toInt(row.tokens),
        chars: toInt(row.chars),
        browse: toInt(row.browse),
        updatedAt: Number(row.updatedAt) || 0
      };
    },
    inc(day, patch = {}) {
      const key = String(day || '').trim();
      if (!key) throw new Error('quota.inc 需要 day');
      const state = readState();
      const prev = state.quota[key] && typeof state.quota[key] === 'object' ? state.quota[key] : emptyQuota(key);
      const next = {
        day: key,
        items: toInt(prev.items) + toInt(patch.items),
        tokens: toInt(prev.tokens) + toInt(patch.tokens),
        chars: toInt(prev.chars) + toInt(patch.chars),
        browse: toInt(prev.browse) + toInt(patch.browse),
        updatedAt: at()
      };
      state.quota[key] = next;
      // 只保留最近 14 天配额，避免状态文件无限增长。
      const days = Object.keys(state.quota).sort();
      for (const old of days.slice(0, Math.max(0, days.length - 14))) delete state.quota[old];
      writeState(state);
      return { ...next };
    }
  };

  const audit = {
    append(line = {}) {
      const row = { ...line, at: Number(line.at) || at() };
      return appendLines(fileOf('audit'), [row]);
    },
    read({ limit = 200 } = {}) {
      const rows = [];
      for (const line of readLines(fileOf('audit'))) {
        try {
          const row = JSON.parse(line);
          if (row && typeof row === 'object') rows.push(row);
        } catch {}
      }
      return rows.slice(-Math.min(2000, toInt(limit, 200) || 200));
    },
    prune({ days = 30, maxLines = 5000 } = {}) {
      const cutoff = at() - Math.max(1, toInt(days, 30)) * 24 * 3600 * 1000;
      const limit = Math.max(1, toInt(maxLines, 5000) || 5000);
      const lines = readLines(fileOf('audit'));
      const kept = [];
      for (const line of lines) {
        try {
          const row = JSON.parse(line);
          if ((Number(row?.at) || 0) >= cutoff) kept.push(JSON.stringify(row));
        } catch {}
      }
      const finalLines = kept.slice(-limit);
      if (finalLines.length === lines.length) return { kept: finalLines.length, removed: 0 };
      atomicWriteText(fileOf('audit'), finalLines.length ? `${finalLines.join('\n')}\n` : '');
      return { kept: finalLines.length, removed: lines.length - finalLines.length };
    }
  };

  const circuit = {
    get() { return { ...readState().circuit }; },
    isOpen() { return toInt(readState().circuit.fails) >= CIRCUIT_OPEN_AFTER; },
    fail(error = '') {
      const state = readState();
      const fails = toInt(state.circuit.fails) + 1;
      state.circuit = {
        fails,
        openedAt: fails >= CIRCUIT_OPEN_AFTER ? (Number(state.circuit.openedAt) || at()) : null,
        lastError: String(error ?? '').slice(0, 300)
      };
      writeState(state);
      return { ...state.circuit };
    },
    ok() {
      const state = readState();
      state.circuit = { fails: 0, openedAt: null, lastError: '' };
      writeState(state);
      return { ...state.circuit };
    },
    reset() {
      const state = readState();
      state.circuit = { fails: 0, openedAt: null, lastError: '' };
      writeState(state);
      return { ...state.circuit };
    }
  };

  return { dir: baseDir, notes, progress, quota, audit, circuit };
}
