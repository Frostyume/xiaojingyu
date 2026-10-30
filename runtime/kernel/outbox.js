// 持久化出站队列（outbox）。
//
// 核心不变量：
//   1. 副作用之前先落盘：任何一条要发出去的消息，先有 outbox 行，再调用传输层；
//   2. 同一逻辑消息只落一行（dedupe_key 唯一），启动重放走同一行，不会重复发；
//   3. 进程在发送途中退出（state=sending）→ 启动后标 uncertain，**永不自动重发**，
//      因为无法确认 QQ 侧是否已经收到；由 doctor/控制台提示人工确认。
//
// 语义：sendNow() 会等待「第一次尝试」的结果。
//   · 成功 → { ok: true, sent: true }
//   · 失败 → { ok: false, queued: true }，行留在 pending 由后台按退避重试。
//   调用方必须把 queued 当作「现在没送达」，但**不要**再自行重发同一条内容。

import crypto from 'node:crypto';

function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function rowToItem(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    key: row.key,
    kind: row.kind,
    payload: parseJson(row.payload_json, {}),
    dedupeKey: row.dedupe_key,
    state: row.state,
    attempts: Number(row.attempts),
    nextAttemptAt: row.next_attempt_at === null ? null : Number(row.next_attempt_at),
    lockedUntil: row.locked_until === null ? null : Number(row.locked_until),
    lastError: row.last_error,
    result: parseJson(row.result_json, null),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    sentAt: row.sent_at === null ? null : Number(row.sent_at)
  };
}

export function hashDedupe(...parts) {
  return crypto.createHash('sha1').update(parts.map((p) => String(p ?? '')).join('\u0000')).digest('hex');
}

export class Outbox {
  constructor({
    db,
    deliver,
    now = () => Date.now(),
    maxAttempts = 5,
    retryBaseMs = 5000,
    retryMaxMs = 10 * 60 * 1000,
    sendTimeoutMs = 30000,
    isReady = () => true,
    onTerminal = null,
    logger = () => {}
  } = {}) {
    if (!db) throw new Error('Outbox 需要 db');
    if (typeof deliver !== 'function') throw new Error('Outbox 需要 deliver');
    this.db = db;
    this.deliver = deliver;
    this.now = now;
    this.maxAttempts = Math.max(1, Number(maxAttempts) || 5);
    this.retryBaseMs = Math.max(500, Number(retryBaseMs) || 5000);
    this.retryMaxMs = Math.max(this.retryBaseMs, Number(retryMaxMs) || 10 * 60 * 1000);
    this.sendTimeoutMs = Math.max(1000, Number(sendTimeoutMs) || 30000);
    this.isReady = isReady;
    this.onTerminal = onTerminal;
    this.logger = logger;
    this.chain = Promise.resolve();
    this.timer = null;
    this.stopped = true;
  }

  enqueue({ key, kind = 'text', payload = {}, dedupeKey = null, notBefore = 0 }) {
    const at = this.now();
    const due = Math.max(at, Number(notBefore) || 0);
    try {
      const result = this.db.run(
        `INSERT INTO outbox(key, kind, payload_json, dedupe_key, state, attempts, next_attempt_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'pending', 0, ?, ?, ?)`,
        String(key), String(kind), JSON.stringify(payload ?? {}), dedupeKey, due, at, at
      );
      return { id: Number(result.lastInsertRowid), duplicate: false, state: 'pending' };
    } catch (error) {
      // dedupe_key 唯一约束：取回已有行，按已有状态返回（绝不新建第二条）。
      if (/UNIQUE/i.test(String(error?.message ?? ''))) {
        const existing = dedupeKey ? this.db.get('SELECT * FROM outbox WHERE dedupe_key = ?', dedupeKey) : null;
        if (existing) return { id: Number(existing.id), duplicate: true, state: existing.state };
      }
      throw error;
    }
  }

  get(id) {
    return rowToItem(this.db.get('SELECT * FROM outbox WHERE id = ?', Number(id)));
  }

  findByDedupe(dedupeKey) {
    if (!dedupeKey) return null;
    return rowToItem(this.db.get('SELECT * FROM outbox WHERE dedupe_key = ?', String(dedupeKey)));
  }

  /** 尝试一次投递（串行链内）。返回 'sent' | 'retry' | 'dead' | 'skipped'。 */
  async _attempt(id) {
    const item = this.get(id);
    if (!item || item.state !== 'pending') return 'skipped';
    if (item.nextAttemptAt && item.nextAttemptAt > this.now()) return 'skipped';
    if (!this.isReady()) return 'skipped';

    const at = this.now();
    const claimed = this.db.run(
      `UPDATE outbox SET state = 'sending', attempts = attempts + 1, locked_until = ?, updated_at = ?
       WHERE id = ? AND state = 'pending'`,
      at + this.sendTimeoutMs, at, id
    );
    if (claimed.changes !== 1) return 'skipped';

    const attempt = item.attempts + 1;
    try {
      const result = await Promise.race([
        Promise.resolve().then(() => this.deliver(item.payload, { ...item, attempts: attempt })),
        new Promise((_, reject) => {
          const timer = setTimeout(() => reject(new Error(`投递超时（${this.sendTimeoutMs}ms）`)), this.sendTimeoutMs);
          timer.unref?.();
        })
      ]);
      const done = this.now();
      this.db.run(
        `UPDATE outbox SET state = 'sent', sent_at = ?, updated_at = ?, locked_until = NULL,
         result_json = ?, last_error = NULL WHERE id = ?`,
        done, done, JSON.stringify(result ?? null), id
      );
      this._terminal({ ...item, attempts: attempt, state: 'sent', sentAt: done }, 'sent');
      return 'sent';
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 500);
      const done = this.now();
      // 业务性「稍后再试」（例如静默模式）：不消耗重试次数，按调用方给的间隔挂起。
      if (error?.holdMs) {
        const hold = Math.max(1000, Number(error.holdMs) || 60000);
        this.db.run(
          `UPDATE outbox SET state = 'pending', updated_at = ?, locked_until = NULL,
           attempts = MAX(0, attempts - 1), next_attempt_at = ?, last_error = ? WHERE id = ?`,
          done, done + hold, detail, id
        );
        this.logger(`outbox 暂缓 #${id}（${item.key}），${Math.round(hold / 1000)}s 后再试：${detail}`);
        return 'retry';
      }
      if (attempt >= this.maxAttempts || error?.permanent) {
        this.db.run(
          `UPDATE outbox SET state = 'dead', updated_at = ?, locked_until = NULL, last_error = ? WHERE id = ?`,
          done, detail, id
        );
        this._terminal({ ...item, attempts: attempt, state: 'dead', lastError: detail }, 'dead');
        this.logger(`outbox 放弃投递 #${id}（${item.key}，${attempt} 次）：${detail}`);
        return 'dead';
      }
      const backoff = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (attempt - 1));
      this.db.run(
        `UPDATE outbox SET state = 'pending', updated_at = ?, locked_until = NULL,
         next_attempt_at = ?, last_error = ? WHERE id = ?`,
        done, done + backoff, detail, id
      );
      this.logger(`outbox 投递失败 #${id}（${item.key}，第 ${attempt}/${this.maxAttempts} 次），${Math.round(backoff / 1000)}s 后重试：${detail}`);
      return 'retry';
    }
  }

  _terminal(item, state) {
    if (typeof this.onTerminal !== 'function') return;
    try { this.onTerminal(item, state); } catch (error) { this.logger(`outbox onTerminal 回调异常：${error?.message ?? error}`); }
  }

  /**
   * 入队并立即尝试一次；调用方等待第一次尝试的结果。
   * 返回 { id, duplicate, state, ok, queued }。
   */
  sendNow(options) {
    let entry;
    try {
      entry = this.enqueue(options);
    } catch (error) {
      return Promise.reject(error);
    }
    const run = this.chain.then(async () => {
      if (entry.state === 'sent') return { ...entry, ok: true, queued: false };
      if (!this.isReady()) return { ...entry, ok: false, queued: true };
      const outcome = await this._attempt(entry.id);
      const latest = this.get(entry.id);
      return {
        id: entry.id,
        duplicate: entry.duplicate,
        state: latest?.state ?? entry.state,
        ok: outcome === 'sent' || latest?.state === 'sent',
        queued: outcome === 'retry' || outcome === 'skipped'
      };
    });
    this.chain = run.catch(() => {});
    return run;
  }

  /** 启动恢复：sending 且锁过期的行标 uncertain（可能已送达，绝不自动重发）。 */
  recover() {
    const at = this.now();
    const uncertain = this.db.run(
      `UPDATE outbox SET state = 'uncertain', updated_at = ?, locked_until = NULL,
       last_error = COALESCE(last_error, '进程在发送过程中退出，需人工确认是否已送达') 
       WHERE state = 'sending' AND (locked_until IS NULL OR locked_until < ?)`,
      at, at
    ).changes;
    const pending = this.db.get(
      'SELECT COUNT(*) AS n FROM outbox WHERE state = \'pending\' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)',
      at
    )?.n ?? 0;
    if (uncertain) this.logger(`⚠️ outbox 有 ${uncertain} 条发送中记录因进程退出而无法确认，已标为 uncertain（不会自动重发）`);
    if (pending) this.logger(`outbox 启动重放：${pending} 条待发送`);
    return { uncertain, pending: Number(pending) };
  }

  /** 处理一条到期行（后台 worker 用）。 */
  drainOnce() {
    const at = this.now();
    if (!this.isReady()) return Promise.resolve('not-ready');
    const row = this.db.get(
      `SELECT id FROM outbox WHERE state = 'pending' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY id LIMIT 1`,
      at
    );
    if (!row) return Promise.resolve('idle');
    const run = this.chain.then(() => this._attempt(Number(row.id)));
    this.chain = run.catch(() => {});
    return run;
  }

  async drain(maxItems = 20) {
    let done = 0;
    for (let i = 0; i < maxItems; i += 1) {
      const outcome = await this.drainOnce();
      if (outcome === 'idle' || outcome === 'not-ready' || outcome === 'skipped') break;
      done += 1;
    }
    return done;
  }

  start({ tickMs = 10000 } = {}) {
    if (!this.stopped) return;
    this.stopped = false;
    this.recover();
    const tick = () => { void this.drain().catch((error) => this.logger(`outbox worker 异常：${error?.message ?? error}`)); };
    tick();
    this.timer = setInterval(tick, Math.max(1000, Number(tickMs) || 10000));
    this.timer.unref?.();
  }

  stop() {
    this.stopped = true;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  stats() {
    const rows = this.db.all('SELECT state, COUNT(*) AS n FROM outbox GROUP BY state');
    const byState = Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
    const oldest = this.db.get('SELECT MIN(created_at) AS t FROM outbox WHERE state = \'pending\'');
    return {
      byState,
      pending: byState.pending ?? 0,
      uncertain: byState.uncertain ?? 0,
      dead: byState.dead ?? 0,
      oldestPendingAgeMs: oldest?.t ? Math.max(0, this.now() - Number(oldest.t)) : 0
    };
  }

  list({ state = '', limit = 50 } = {}) {
    const capped = Math.min(500, Math.max(1, Number(limit) || 50));
    const rows = state
      ? this.db.all('SELECT * FROM outbox WHERE state = ? ORDER BY id DESC LIMIT ?', state, capped)
      : this.db.all('SELECT * FROM outbox ORDER BY id DESC LIMIT ?', capped);
    return rows.map((row) => ({ ...rowToItem(row), maxAttempts: this.maxAttempts }));
  }

  /** 人工重试 uncertain/dead 行。这是唯一会把 uncertain 重新发出的入口。 */
  retry(id) {
    const item = this.get(id);
    if (!item || !['uncertain', 'dead', 'failed'].includes(item.state)) return false;
    const at = this.now();
    this.db.run(
      `UPDATE outbox SET state = 'pending', attempts = 0, next_attempt_at = ?, updated_at = ?,
       last_error = NULL, locked_until = NULL WHERE id = ?`,
      at, at, item.id
    );
    return true;
  }

  discard(id, note = '人工丢弃') {
    const at = this.now();
    return this.db.run(
      'UPDATE outbox SET state = \'dead\', updated_at = ?, last_error = ? WHERE id = ? AND state != \'sent\'',
      at, String(note).slice(0, 200), Number(id)
    ).changes > 0;
  }
}
