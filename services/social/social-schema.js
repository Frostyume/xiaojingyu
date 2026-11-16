// 社会记忆表结构：只在 socialMemory 总开关开启时惰性创建（可重入）。
// 关闭时不建任何表；旧库即使已有同名表也按 IF NOT EXISTS 复用。
const ready = new WeakSet();

export function ensureSocialSchema(db) {
  if (!db || typeof db.exec !== 'function') return false;
  if (ready.has(db)) return true;
  db.exec(`
    CREATE TABLE IF NOT EXISTS persons (
      id            TEXT PRIMARY KEY,
      display_name  TEXT,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS identities (
      platform      TEXT NOT NULL,
      account_id    TEXT NOT NULL,
      person_id     TEXT NOT NULL,
      display_name  TEXT,
      confirmed     INTEGER NOT NULL DEFAULT 0,
      created_at    INTEGER NOT NULL,
      updated_at    INTEGER NOT NULL,
      PRIMARY KEY (platform, account_id)
    );
    CREATE INDEX IF NOT EXISTS idx_identities_person ON identities(person_id);

    CREATE TABLE IF NOT EXISTS person_profiles (
      person_id           TEXT PRIMARY KEY,
      display_name        TEXT,
      aliases_json        TEXT NOT NULL DEFAULT '[]',
      preferences_json    TEXT NOT NULL DEFAULT '[]',
      boundaries_json     TEXT NOT NULL DEFAULT '[]',
      style_json          TEXT NOT NULL DEFAULT '[]',
      recent_state_json   TEXT,
      impression_json     TEXT,
      owner_note          TEXT,
      confidence          REAL NOT NULL DEFAULT 0.5,
      provenance          TEXT NOT NULL DEFAULT 'observed',
      visibility          TEXT NOT NULL DEFAULT 'public',
      created_at          INTEGER NOT NULL,
      updated_at          INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_person_profiles_updated ON person_profiles(updated_at);

    CREATE TABLE IF NOT EXISTS social_edges (
      id            TEXT PRIMARY KEY,
      kind          TEXT NOT NULL,
      from_kind     TEXT NOT NULL,
      from_id       TEXT NOT NULL,
      to_kind       TEXT NOT NULL,
      to_id         TEXT NOT NULL,
      weight        REAL NOT NULL DEFAULT 0.3,
      confidence    REAL NOT NULL DEFAULT 0.5,
      evidence_json TEXT NOT NULL DEFAULT '[]',
      first_seen    INTEGER NOT NULL,
      last_seen     INTEGER NOT NULL,
      visibility    TEXT NOT NULL DEFAULT 'public',
      UNIQUE(kind, from_kind, from_id, to_kind, to_id)
    );
    CREATE INDEX IF NOT EXISTS idx_social_edges_from ON social_edges(from_kind, from_id, last_seen);
    CREATE INDEX IF NOT EXISTS idx_social_edges_to ON social_edges(to_kind, to_id, last_seen);

    CREATE TABLE IF NOT EXISTS episodes (
      id                TEXT PRIMARY KEY,
      occurred_at       INTEGER NOT NULL,
      group_key         TEXT,
      topic             TEXT,
      summary           TEXT NOT NULL,
      participants_json TEXT NOT NULL DEFAULT '[]',
      valence           TEXT,
      energy            TEXT,
      outcome           TEXT,
      source_event_id   TEXT,
      memory_fact_ids   TEXT NOT NULL DEFAULT '[]',
      dedupe_key        TEXT UNIQUE,
      visibility        TEXT NOT NULL DEFAULT 'public',
      expires_at        INTEGER,
      consolidated_at   INTEGER,
      created_at        INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_episodes_time ON episodes(occurred_at);
    CREATE INDEX IF NOT EXISTS idx_episodes_group ON episodes(group_key, occurred_at);
    CREATE INDEX IF NOT EXISTS idx_episodes_expiry ON episodes(expires_at);
    CREATE INDEX IF NOT EXISTS idx_episodes_unconsolidated ON episodes(consolidated_at, occurred_at);

    CREATE TABLE IF NOT EXISTS episode_participants (
      episode_id  TEXT NOT NULL,
      person_id   TEXT NOT NULL,
      role        TEXT NOT NULL DEFAULT 'speaker',
      PRIMARY KEY (episode_id, person_id)
    );
    CREATE INDEX IF NOT EXISTS idx_episode_participants_person ON episode_participants(person_id, episode_id);

    CREATE TABLE IF NOT EXISTS person_alias_history (
      person_id  TEXT NOT NULL,
      alias      TEXT NOT NULL,
      source_key TEXT NOT NULL DEFAULT '',
      kind       TEXT NOT NULL DEFAULT 'nickname',
      first_seen INTEGER NOT NULL,
      last_seen  INTEGER NOT NULL,
      seen_count INTEGER NOT NULL DEFAULT 1,
      PRIMARY KEY (person_id, alias, source_key, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_alias_history_person ON person_alias_history(person_id, last_seen);
  `);
  ready.add(db);
  return true;
}