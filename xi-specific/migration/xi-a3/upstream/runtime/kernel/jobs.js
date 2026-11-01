// 持久化任务队列（jobs）。
//
// 用来替代「各自 setTimeout/setInterval + 内存状态」的调度：
//   · 任务先落盘再执行，进程重启后仍能继续；
//   · 同一时刻只执行一个任务（桥接里的任务都有副作用，串行最安全）；
//   · 失败按指数退避重试，超过 max_attempts 进 dead，doctor/控制台可见；
//   · dedupe_key 唯一：重复登记（例如同一个提醒被同步两次）不会产生两条任务。

function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function rowToJob(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    type: row.type,
    key: row.job_key,
    payload: parseJson(row.payload_json, {}),
    dedupeKey: row.dedupe_key,
    state: row.state,
    runAfter: Number(row.run_after),
    attempts: Number(row.attempts),
    maxAttempts: Number(row.max_attempts),
    lockedUntil: row.locked_until === null ? null : Number(row.locked_until),
    lastError: row.last_error,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    finishedAt: row.finished_at === null ? null : Number(row.finished_at)
  };
}

export class JobQueue {
  constructor({
    db,
    handlers = {},
    now = () => Date.now(),
    logger = () => {},
    tickMs = 5000,
    jobTimeoutMs = 10 * 60 * 1000,
    retryBaseMs = 30000,
    retryMaxMs = 60 * 60 * 1000
  } = {}) {
    if (!db) throw new Error('JobQueue 需要 db');
    this.db = db;
    this.handlers = new Map(Object.entries(handlers));
    this.now = now;
    this.logger = logger;
    this.tickMs = Math.max(1000, Number(tickMs) || 5000);
    this.jobTimeoutMs = Math.max(10000, Number(jobTimeoutMs) || 10 * 60 * 1000);
    this.retryBaseMs = Math.max(1000, Number(retryBaseMs) || 30000);
    this.retryMaxMs = Math.max(this.retryBaseMs, Number(retryMaxMs) || 60 * 60 * 1000);
    this.timer = null;
    this.running = false;
    this.executing = false;
  }

  register(type, handler) {
    if (typeof handler !== 'function') throw new Error('handler 必须是函数');
    this.handlers.set(String(type), handler);
    return this;
  }

  findByDedupe(dedupeKey) {
    if (!dedupeKey) return null;
    return rowToJob(this.db.get('SELECT * FROM jobs WHERE dedupe_key = ?', String(dedupeKey)));
  }

  /**
   * 登记任务。
   * dedupeKey 已存在时复用该行：pending 更新触发时间；running 直接返回；done/dead 重置为 pending。
   */
  enqueue({ type, key = null, payload = {}, dedupeKey = null, runAfter = 0, maxAttempts = 3 }) {
    const at = this.now();
    const due = Math.max(at, Number(runAfter) || 0);
    const max = Math.max(1, Number(maxAttempts) || 3);
    if (dedupeKey) {
      const existing = this.db.get('SELECT * FROM jobs WHERE dedupe_key = ?', dedupeKey);
      if (existing) {
        if (existing.state === 'running') {
          return { id: Number(existing.id), existed: true, running: true, state: 'running' };
        }
        this.db.run(
          `UPDATE jobs SET type = ?, job_key = ?, payload_json = ?, state = 'pending', run_after = ?,
           attempts = 0, max_attempts = ?, locked_until = NULL, last_error = NULL, updated_at = ?, finished_at = NULL
           WHERE id = ?`,
          String(type), key, JSON.stringify(payload ?? {}), due, max, at, existing.id
        );
        return { id: Number(existing.id), existed: true, running: false, state: 'pending' };
      }
    }
    const result = this.db.run(
      `INSERT INTO jobs(type, job_key, payload_json, dedupe_key, state, run_after, attempts, max_attempts, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'pending', ?, 0, ?, ?, ?)`,
      String(type), key, JSON.stringify(payload ?? {}), dedupeKey, due, max, at, at
    );
    return { id: Number(result.lastInsertRowid), existed: false, running: false, state: 'pending' };
  }

  cancel(dedupeKey) {
    return this.db.run(
      'UPDATE jobs SET state = \'cancelled\', last_error = ?, updated_at = ?, finished_at = ? WHERE dedupe_key = ? AND state IN (\'pending\', \'running\')',
      '已取消', this.now(), this.now(), String(dedupeKey)
    ).changes;
  }

  /** 丢弃某类型的待执行任务（正在执行的不动）；用于「重新排下一次」的单例任务。 */
  clearPending(type, note = '已被新的排程取代') {
    const at = this.now();
    return this.db.run(
      'UPDATE jobs SET state = \'cancelled\', last_error = ?, updated_at = ?, finished_at = ? WHERE type = ? AND state = \'pending\'',
      note, at, at, String(type)
    ).changes;
  }

  recover() {
    const at = this.now();
    const stale = this.db.run(
      `UPDATE jobs SET state = 'pending', locked_until = NULL, updated_at = ?,
       last_error = COALESCE(last_error, '进程在任务执行中退出，已重新排队')
       WHERE state = 'running' AND (locked_until IS NULL OR locked_until < ?)`,
      at, at
    ).changes;
    if (stale) this.logger(`⚠️ jobs 有 ${stale} 个任务因进程退出而重新排队`);
    const due = Number(this.db.get(
      'SELECT COUNT(*) AS n FROM jobs WHERE state = \'pending\' AND run_after <= ?', at
    )?.n ?? 0);
    return { stale, due };
  }

  _claimDue() {
    const at = this.now();
    const row = this.db.get(
      'SELECT * FROM jobs WHERE state = \'pending\' AND run_after <= ? ORDER BY run_after, id LIMIT 1',
      at
    );
    if (!row) return null;
    const claimed = this.db.run(
      `UPDATE jobs SET state = 'running', attempts = attempts + 1, locked_until = ?, updated_at = ?
       WHERE id = ? AND state = 'pending'`,
      at + this.jobTimeoutMs, at, row.id
    );
    if (claimed.changes !== 1) return null;
    return rowToJob(this.db.get('SELECT * FROM jobs WHERE id = ?', row.id));
  }

  async _execute(job) {
    const handler = this.handlers.get(job.type);
    const at = this.now();
    if (!handler) {
      this.db.run(
        'UPDATE jobs SET state = \'dead\', last_error = ?, updated_at = ?, finished_at = ? WHERE id = ?',
        `未注册的任务类型 ${job.type}`, at, at, job.id
      );
      this.logger(`jobs 未注册任务类型 ${job.type}（#${job.id}）`);
      return 'dead';
    }
    let outcome;
    try {
      outcome = await handler(job);
    } catch (error) {
      const detail = String(error?.message ?? error).slice(0, 500);
      const done = this.now();
      if (job.attempts >= job.maxAttempts) {
        this.db.run(
          'UPDATE jobs SET state = \'dead\', last_error = ?, updated_at = ?, finished_at = ?, locked_until = NULL WHERE id = ?',
          detail, done, done, job.id
        );
        this.logger(`job 放弃 #${job.id} ${job.type}（${job.attempts} 次）：${detail}`);
        return 'dead';
      }
      const backoff = Math.min(this.retryMaxMs, this.retryBaseMs * 2 ** (job.attempts - 1));
      this.db.run(
        `UPDATE jobs SET state = 'pending', locked_until = NULL, run_after = ?, last_error = ?, updated_at = ?
         WHERE id = ?`,
        done + backoff, detail, done, job.id
      );
      this.logger(`job 失败 #${job.id} ${job.type}（第 ${job.attempts}/${job.maxAttempts} 次），${Math.round(backoff / 1000)}s 后重试：${detail}`);
      return 'retry';
    }
    const done = this.now();
    if (outcome && outcome.retryAfterMs) {
      const attempts = job.attempts;
      this.db.run(
        `UPDATE jobs SET state = 'pending', locked_until = NULL, run_after = ?, updated_at = ?,
         attempts = ? WHERE id = ?`,
        done + Math.max(1000, Number(outcome.retryAfterMs)), done, Math.max(0, attempts - 1), job.id
      );
      return 'retry';
    }
    this.db.run(
      'UPDATE jobs SET state = \'done\', updated_at = ?, finished_at = ?, locked_until = NULL WHERE id = ?',
      done, done, job.id
    );
    return 'done';
  }

  async runDueOnce() {
    if (this.executing) return 'busy';
    this.executing = true;
    try {
      const job = this._claimDue();
      if (!job) return 'idle';
      return await this._execute(job);
    } finally {
      this.executing = false;
    }
  }

  async runDue(maxJobs = 20) {
    let count = 0;
    for (let i = 0; i < maxJobs; i += 1) {
      const outcome = await this.runDueOnce();
      if (outcome === 'idle' || outcome === 'busy') break;
      count += 1;
    }
    return count;
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.recover();
    const tick = () => {
      if (!this.running) return;
      void this.runDue().catch((error) => this.logger(`jobs worker 异常：${error?.message ?? error}`));
    };
    tick();
    this.timer = setInterval(tick, this.tickMs);
    this.timer.unref?.();
  }

  stop() {
    this.running = false;
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
  }

  stats() {
    const rows = this.db.all('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state');
    const byState = Object.fromEntries(rows.map((r) => [r.state, Number(r.n)]));
    const next = this.db.get('SELECT MIN(run_after) AS t FROM jobs WHERE state = \'pending\'');
    return { byState, pending: byState.pending ?? 0, dead: byState.dead ?? 0, nextRunAt: next?.t ?? null };
  }

  list({ state = '', limit = 50 } = {}) {
    const capped = Math.min(500, Math.max(1, Number(limit) || 50));
    const rows = state
      ? this.db.all('SELECT * FROM jobs WHERE state = ? ORDER BY run_after, id LIMIT ?', state, capped)
      : this.db.all('SELECT * FROM jobs ORDER BY id DESC LIMIT ?', capped);
    return rows.map(rowToJob);
  }

  retry(id) {
    const job = rowToJob(this.db.get('SELECT * FROM jobs WHERE id = ?', Number(id)));
    if (!job || !['dead', 'failed'].includes(job.state)) return false;
    const at = this.now();
    this.db.run(
      `UPDATE jobs SET state = 'pending', attempts = 0, run_after = ?, locked_until = NULL,
       last_error = NULL, updated_at = ?, finished_at = NULL WHERE id = ?`,
      at, at, job.id
    );
    return true;
  }
}
