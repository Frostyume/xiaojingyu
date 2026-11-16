// 适配器健康与熔断。
//
// 规则（docs/LIFE_BUTLER.md 1.4/1.11）：
//   · 连续失败 3 次 → open 30 分钟（half-open 试一次）；
//   · 认证失效 → 立即 disabled，不重试，等主人处理；
//   · 退避：1 分钟 → 5 分钟 → 15 分钟 → 1 小时封顶。
// 状态落 life_sync_state（调度用）与 life_health（展示用），重启后仍然生效。

import { redactText } from './redact.js';
import { ensureLifeSchema } from './schema.js';

const BACKOFF_MS = [60 * 1000, 5 * 60 * 1000, 15 * 60 * 1000, 60 * 60 * 1000];

function parseJson(text, fallback = null) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

export function createHealth({ db, clock, logger = () => {}, audit = null }) {
  ensureLifeSchema(db);
  const now = () => Number(clock.now());

  function ensure(adapterId) {
    const at = now();
    db.run(
      `INSERT OR IGNORE INTO life_sync_state(adapter, consecutive_failures, state, updated_at)
       VALUES (?, 0, 'ok', ?)`,
      adapterId, at
    );
    db.run(
      `INSERT OR IGNORE INTO life_health(adapter, state, updated_at) VALUES (?, 'ok', ?)`,
      adapterId, at
    );
  }

  function row(adapterId) {
    ensure(adapterId);
    const sync = db.get('SELECT * FROM life_sync_state WHERE adapter = ?', adapterId) ?? {};
    const health = db.get('SELECT * FROM life_health WHERE adapter = ?', adapterId) ?? {};
    return { sync, health };
  }

  /**
   * 是否允许本次同步。
   * @returns {{allowed:boolean, reason?:string, retryAfterMs?:number, halfOpen?:boolean}}
   */
  function canRun(adapterId, manifest = {}) {
    const { sync } = row(adapterId);
    const at = now();
    if (sync.state === 'disabled') return { allowed: false, reason: 'auth', retryAfterMs: null };
    const openUntil = Number(sync.open_until) || 0;
    if (openUntil && at < openUntil) {
      return { allowed: false, reason: 'open', retryAfterMs: openUntil - at };
    }
    const nextAllowed = Number(sync.next_allowed_at) || 0;
    if (nextAllowed && at < nextAllowed) {
      return { allowed: false, reason: 'backoff', retryAfterMs: nextAllowed - at };
    }
    if (openUntil && at >= openUntil) {
      // half-open：只放一次；结果由 recordSuccess/recordFailure 决定。
      return { allowed: true, halfOpen: true };
    }
    return { allowed: true };
  }

  function recordSuccess(adapterId, { latencyMs = 0, items = 0, cursor = null } = {}) {
    const at = now();
    ensure(adapterId);
    db.run(
      `UPDATE life_sync_state SET cursor = COALESCE(?, cursor), last_success = ?, last_error = NULL,
         consecutive_failures = 0, open_until = NULL, next_allowed_at = NULL, state = 'ok',
         latency_ms = ?, items_last = ?, updated_at = ?
       WHERE adapter = ?`,
      cursor, at, Math.max(0, Math.round(latencyMs)), Math.max(0, Math.round(items)), at, adapterId
    );
    db.run(
      `UPDATE life_health SET state = 'ok', latency_ms = ?, items_last = ?, updated_at = ? WHERE adapter = ?`,
      Math.max(0, Math.round(latencyMs)), Math.max(0, Math.round(items)), at, adapterId
    );
  }

  function recordFailure(adapterId, error, { auth = false, manifest = {} } = {}) {
    const at = now();
    ensure(adapterId);
    const { sync } = row(adapterId);
    const failures = Number(sync.consecutive_failures || 0) + 1;
    const detail = redactText(String(error?.message ?? error)).slice(0, 300) || '同步失败';
    const authStops = manifest?.health?.authErrorStops !== false;
    const threshold = Math.max(1, Number(manifest?.health?.failuresToOpen) || 3);
    const openMs = Math.max(60000, Number(manifest?.health?.openMs) || 30 * 60 * 1000);

    let state = 'degraded';
    let openUntil = null;
    let nextAllowed = null;
    if (auth && authStops) {
      state = 'disabled';
    } else if (failures >= threshold) {
      state = 'open';
      openUntil = at + openMs;
    } else {
      nextAllowed = at + BACKOFF_MS[Math.min(failures - 1, BACKOFF_MS.length - 1)];
    }

    db.run(
      `UPDATE life_sync_state SET last_error = ?, consecutive_failures = ?, open_until = ?,
         next_allowed_at = ?, state = ?, updated_at = ?
       WHERE adapter = ?`,
      detail, failures, openUntil, nextAllowed, state, at, adapterId
    );
    db.run(
      `UPDATE life_health SET state = ?, updated_at = ? WHERE adapter = ?`,
      state, at, adapterId
    );
    if (audit) audit.record({ actor: 'scheduler', adapter: adapterId, action: 'sync.failed', decision: 'failed', result: { auth, failures, state } });
    if (state === 'disabled') logger('warn', `适配器 ${adapterId} 认证失效，已停止且不重试`);
    else if (state === 'open') logger('warn', `适配器 ${adapterId} 连续失败 ${failures} 次，熔断 ${Math.round(openMs / 60000)} 分钟`);
    return { state, failures, openUntil, nextAllowed };
  }

  function reset(adapterId) {
    const at = now();
    ensure(adapterId);
    db.run(
      `UPDATE life_sync_state SET consecutive_failures = 0, open_until = NULL, next_allowed_at = NULL,
         state = 'ok', last_error = NULL, updated_at = ? WHERE adapter = ?`,
      at, adapterId
    );
    db.run(`UPDATE life_health SET state = 'ok', updated_at = ? WHERE adapter = ?`, at, adapterId);
  }

  function snapshot(adapterId) {
    const { sync, health } = row(adapterId);
    return {
      adapter: adapterId,
      state: sync.state || health.state || 'ok',
      lastSuccess: sync.last_success ?? null,
      lastError: sync.last_error ?? null,
      consecutiveFailures: Number(sync.consecutive_failures || 0),
      openUntil: sync.open_until ?? null,
      nextAllowedAt: sync.next_allowed_at ?? null,
      latencyMs: sync.latency_ms ?? health.latency_ms ?? null,
      itemsLast: sync.items_last ?? health.items_last ?? null,
      cursor: sync.cursor ?? null,
      quota: parseJson(health.quota_json, null)
    };
  }

  function list(adapterIds) {
    const ids = Array.isArray(adapterIds) ? adapterIds : [];
    return ids.map((id) => snapshot(id));
  }

  return { ensure, canRun, recordSuccess, recordFailure, reset, snapshot, list, _backoff: BACKOFF_MS };
}
