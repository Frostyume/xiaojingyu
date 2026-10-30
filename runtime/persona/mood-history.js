// 心情/精力变化的追加式历史，供 Live、控制台和后续校准使用。
// 只追加不重写主状态；写失败不能影响心情本身。

import fs from 'node:fs';
import { atomicWriteText } from '../kernel/state-file.js';
import path from 'node:path';

const DEFAULT_KEEP_DAYS = 180;
const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;

function parseLine(line) {
  try {
    const item = JSON.parse(line);
    return item && typeof item === 'object' && Number.isFinite(Number(item.at)) ? item : null;
  } catch {
    return null;
  }
}

function compact(file, { now, keepDays }) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return; }
  const cutoff = now - keepDays * 24 * 3600 * 1000;
  const lines = raw.split('\n').map((line) => line.trim()).filter(Boolean);
  const keep = [];
  for (const line of lines) {
    const item = parseLine(line);
    if (item && Number(item.at) >= cutoff) keep.push(JSON.stringify(item));
  }
  try {
    atomicWriteText(file, keep.length ? `${keep.join('\n')}\n` : '');
  } catch {}
}

export function appendMoodHistory(file, entry, {
  now = Date.now(),
  keepDays = DEFAULT_KEEP_DAYS,
  maxBytes = DEFAULT_MAX_BYTES
} = {}) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    let size = 0;
    try { size = fs.statSync(file).size; } catch {}
    if (size > maxBytes) compact(file, { now, keepDays });
  } catch {
    // 历史只是观测数据，写失败不影响主状态。
  }
}

export function readMoodHistory(file, { days = 7, limit = 500, now = Date.now() } = {}) {
  let raw = '';
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return []; }
  const cutoff = now - Math.max(1, Number(days) || 7) * 24 * 3600 * 1000;
  const out = [];
  for (const line of raw.split('\n')) {
    const item = parseLine(line.trim());
    if (!item || Number(item.at) < cutoff) continue;
    out.push(item);
  }
  out.sort((a, b) => Number(a.at) - Number(b.at));
  return out.slice(-Math.max(1, Number(limit) || 500));
}

export function summarizeMoodHistory(entries, { now = Date.now(), state = null } = {}) {
  const list = Array.isArray(entries) ? entries : [];
  const day = 24 * 3600 * 1000;
  const last24 = list.filter((item) => now - Number(item.at) <= day);
  const last7d = list.filter((item) => now - Number(item.at) <= 7 * day);
  const valences = last7d.map((item) => Number(item?.after?.v)).filter(Number.isFinite);
  const arousals = last7d.map((item) => Number(item?.after?.a)).filter(Number.isFinite);
  const base = last24[0]?.before || null;
  const current = state?.mood
    ? { v: Number(state.mood.valence) || 0, a: Number(state.mood.arousal) || 0, e: Number(state.energy) || 0 }
    : (list[list.length - 1]?.after || { v: 0, a: 0, e: 0 });
  const modeCounts = {};
  for (const item of last7d) {
    const mode = String(item.mode || 'unknown');
    modeCounts[mode] = (modeCounts[mode] || 0) + 1;
  }
  const caused = last7d.filter((item) => String(item.cause || '').trim()).length;
  const bigJumps = last7d.filter((item) => Math.abs(Number(item.delta?.v) || 0) > 0.3001).length;
  return {
    points: last7d.length,
    current,
    change24h: base ? { v: current.v - Number(base.v || 0), a: current.a - Number(base.a || 0), e: current.e - Number(base.e || 0) } : null,
    minV: valences.length ? Math.min(...valences) : current.v,
    maxV: valences.length ? Math.max(...valences) : current.v,
    minA: arousals.length ? Math.min(...arousals) : current.a,
    maxA: arousals.length ? Math.max(...arousals) : current.a,
    span7dV: valences.length ? Math.max(...valences) - Math.min(...valences) : 0,
    modeCounts,
    causeCoverage: last7d.length ? caused / last7d.length : 0,
    bigJumps,
    recent: list.slice(-20).reverse()
  };
}
