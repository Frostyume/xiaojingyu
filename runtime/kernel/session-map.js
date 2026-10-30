// QQ 会话 ↔ DSH sessionId 的持久化备份。
//
// `state/sessions.json` 仍是主读路径（人可读、可手工修）；SQLite 只是**影子副本**：
//   · 每次 saveState() 同步写入；
//   · 启动时若某 key 在 sessions.json 里缺失（文件损坏/被误删/回滚），用 DB 补回来；
//   · 写失败只告警，绝不影响主流程。
//
// 这不是确定性 UUID 映射（DSH 的 sessionId 由 DSH 创建），但能把「状态文件丢了
// ⇒ 每个会话都开新上下文」降级成「只有最后几条没来得及落盘的映射丢失」。

function rowToEntry(row) {
  if (!row) return null;
  return {
    key: row.key,
    sessionId: row.session_id,
    policy: (() => { try { return row.policy_json ? JSON.parse(row.policy_json) : null; } catch { return null; } })(),
    updatedAt: Number(row.updated_at)
  };
}

export class SessionMapStore {
  constructor({ db, now = () => Date.now(), logger = () => {} } = {}) {
    if (!db) throw new Error('SessionMapStore 需要 db');
    this.db = db;
    this.now = now;
    this.logger = logger;
  }

  saveAll(sessions = {}, policies = {}) {
    const at = this.now();
    let written = 0;
    for (const [key, sessionId] of Object.entries(sessions ?? {})) {
      if (!key || !sessionId) continue;
      const policy = policies?.[key] ?? null;
      this.db.run(
        `INSERT INTO session_map(key, session_id, policy_json, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET session_id = excluded.session_id,
           policy_json = excluded.policy_json, updated_at = excluded.updated_at`,
        key, String(sessionId), policy ? JSON.stringify(policy) : null, at
      );
      written += 1;
    }
    // 清掉已经不在 sessions.json 里的 key（例如会话被重置/退役）。
    const keys = Object.keys(sessions ?? {});
    if (keys.length) {
      const placeholders = keys.map(() => '?').join(',');
      this.db.run(`DELETE FROM session_map WHERE key NOT IN (${placeholders})`, ...keys);
    } else {
      this.db.run('DELETE FROM session_map');
    }
    return written;
  }

  loadAll() {
    return this.db.all('SELECT * FROM session_map ORDER BY updated_at DESC').map(rowToEntry);
  }

  get(key) {
    return rowToEntry(this.db.get('SELECT * FROM session_map WHERE key = ?', String(key)));
  }

  remove(key) {
    return this.db.run('DELETE FROM session_map WHERE key = ?', String(key)).changes > 0;
  }

  stats() {
    return { keys: Number(this.db.get('SELECT COUNT(*) AS n FROM session_map')?.n ?? 0) };
  }
}
