// 生活管家表结构：只在真正启用时才建（可重入），总开关关闭时不碰数据库。
let ready = new WeakSet();

export function ensureLifeSchema(db) {
  if (!db || typeof db.exec !== 'function') return false;
  if (ready.has(db)) return true;
  db.exec(`
    CREATE TABLE IF NOT EXISTS life_items (
      id            TEXT PRIMARY KEY,
      adapter       TEXT NOT NULL,
      kind          TEXT NOT NULL,
      external_id   TEXT,
      title         TEXT NOT NULL,
      summary       TEXT,
      starts_at     INTEGER,
      ends_at       INTEGER,
      due_at        INTEGER,
      status        TEXT NOT NULL DEFAULT 'open',
      risk          INTEGER NOT NULL DEFAULT 0,
      payload_json  TEXT,
      dedupe_key    TEXT UNIQUE,
      source_ref    TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      expires_at    INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_life_items_due ON life_items(status, due_at);
    CREATE INDEX IF NOT EXISTS idx_life_items_kind ON life_items(adapter, kind, starts_at);

    CREATE TABLE IF NOT EXISTS life_watch (
      id            TEXT PRIMARY KEY,
      adapter       TEXT NOT NULL,
      kind          TEXT NOT NULL,
      target        TEXT NOT NULL,
      options_json  TEXT,
      enabled       INTEGER NOT NULL DEFAULT 1,
      created_at    INTEGER NOT NULL,
      last_checked  INTEGER,
      UNIQUE(adapter, kind, target)
    );

    CREATE TABLE IF NOT EXISTS life_sync_state (
      adapter               TEXT PRIMARY KEY,
      cursor                TEXT,
      last_success          INTEGER,
      last_error            TEXT,
      consecutive_failures  INTEGER NOT NULL DEFAULT 0,
      open_until            INTEGER,
      state                 TEXT NOT NULL DEFAULT 'ok',
      next_allowed_at       INTEGER,
      latency_ms            INTEGER,
      items_last            INTEGER,
      updated_at            INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS life_health (
      adapter     TEXT PRIMARY KEY,
      state       TEXT NOT NULL,
      latency_ms  INTEGER,
      items_last  INTEGER,
      quota_json  TEXT,
      updated_at  INTEGER NOT NULL
    );
  `);
  ready.add(db);
  return true;
}