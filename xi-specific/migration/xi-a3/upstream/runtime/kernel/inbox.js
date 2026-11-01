// 入站事件日志（inbox）。
//
// 作用有两个：
//   1. 去重：SnowLuma/OneBot 在重连、补发时可能把同一条消息投递两次；
//      dedupe_key = 会话 + message_id，唯一约束保证只处理一次。
//   2. 恢复：消息已落盘但处理未完成时（进程崩溃/DSH 重启），启动后可以按时间窗重放。
//
// 注意：重放只处理「未标记 processed」且足够新的消息（默认 2 分钟）。更旧的消息
// 只保留为审计记录，不自动回复 —— 隔了很久再突然回复旧消息比丢一条更糟。

import crypto from 'node:crypto';

function parseJson(text, fallback = null) {
  if (text === null || text === undefined || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function rowToEvent(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    direction: row.direction,
    key: row.key,
    kind: row.kind,
    messageId: row.message_id,
    seq: row.seq === null ? null : Number(row.seq),
    payload: parseJson(row.payload_json, {}),
    dedupeKey: row.dedupe_key,
    createdAt: Number(row.created_at),
    processedAt: row.processed_at === null ? null : Number(row.processed_at),
    error: row.error
  };
}

export function inboundDedupeKey(kind, id, event = {}) {
  const messageId = String(event?.message_id ?? event?.msg_id ?? event?.message_seq ?? '').trim();
  if (messageId) return `${kind}:${id}:msg:${messageId}`;
  const stamp = String(event?.time ?? event?.timestamp ?? '');
  const text = String(event?.raw_message ?? event?.message ?? '');
  return `${kind}:${id}:h:${crypto.createHash('sha1').update(`${stamp}\u0000${text}`).digest('hex').slice(0, 20)}`;
}

export class Inbox {
  constructor({ db, now = () => Date.now(), logger = () => {} } = {}) {
    if (!db) throw new Error('Inbox 需要 db');
    this.db = db;
    this.now = now;
    this.logger = logger;
  }

  /** 落盘一条入站事件。重复返回 { duplicate: true, id: 已有行 }。 */
  record({ key, kind = '', messageId = '', seq = null, payload = {}, dedupeKey = null, createdAt = null }) {
    const at = Number(createdAt) || this.now();
    try {
      const result = this.db.run(
        `INSERT INTO events(direction, key, kind, message_id, seq, payload_json, dedupe_key, created_at)
         VALUES ('in', ?, ?, ?, ?, ?, ?, ?)`,
        String(key), String(kind ?? ''), messageId === null ? null : String(messageId),
        seq === null || seq === undefined ? null : Number(seq),
        JSON.stringify(payload ?? {}), dedupeKey, at
      );
      return { id: Number(result.lastInsertRowid), duplicate: false };
    } catch (error) {
      if (/UNIQUE/i.test(String(error?.message ?? ''))) {
        const existing = dedupeKey
          ? this.db.get('SELECT id, processed_at FROM events WHERE dedupe_key = ?', dedupeKey)
          : null;
        return {
          id: existing ? Number(existing.id) : null,
          duplicate: true,
          processed: Boolean(existing && existing.processed_at !== null)
        };
      }
      throw error;
    }
  }

  markProcessed(id, { error = null } = {}) {
    if (!id) return false;
    return this.db.run(
      'UPDATE events SET processed_at = ?, error = ? WHERE id = ?',
      this.now(), error ? String(error).slice(0, 500) : null, Number(id)
    ).changes > 0;
  }

  /** 未处理且在 maxAgeMs 内的入站事件（旧的先标 expired，避免每次启动都扫）。 */
  pending({ maxAgeMs = 2 * 60 * 1000, limit = 20 } = {}) {
    const at = this.now();
    const cutoff = at - Math.max(1000, Number(maxAgeMs) || 2 * 60 * 1000);
    const expired = this.db.run(
      `UPDATE events SET error = COALESCE(error, '超过重放窗口，未自动处理')
       WHERE direction = 'in' AND processed_at IS NULL AND created_at < ?`,
      cutoff
    ).changes;
    const rows = this.db.all(
      `SELECT * FROM events WHERE direction = 'in' AND processed_at IS NULL AND created_at >= ?
       ORDER BY id LIMIT ?`,
      cutoff, Math.min(100, Math.max(1, Number(limit) || 20))
    );
    if (expired) this.logger(`inbox：${expired} 条过旧消息未处理（不重放）`);
    return rows.map(rowToEvent);
  }

  markExpired() {
    const at = this.now();
    return this.db.run(
      `UPDATE events SET error = COALESCE(error, '未处理')
       WHERE direction = 'in' AND processed_at IS NULL AND created_at < ?`,
      at
    ).changes;
  }

  stats() {
    const unprocessed = Number(this.db.get(
      'SELECT COUNT(*) AS n FROM events WHERE direction = \'in\' AND processed_at IS NULL'
    )?.n ?? 0);
    return { unprocessed, total: Number(this.db.get('SELECT COUNT(*) AS n FROM events')?.n ?? 0) };
  }

  recent({ key = '', limit = 50 } = {}) {
    const capped = Math.min(500, Math.max(1, Number(limit) || 50));
    const rows = key
      ? this.db.all('SELECT * FROM events WHERE key = ? ORDER BY id DESC LIMIT ?', key, capped)
      : this.db.all('SELECT * FROM events ORDER BY id DESC LIMIT ?', capped);
    return rows.map(rowToEvent);
  }
}
