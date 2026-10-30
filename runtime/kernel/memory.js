// 分层长期记忆。
//
// 只存「未来仍有用」的事实/偏好/事件，不逐条存聊天：
//   scope = global | group | member
//   owner_key = 会话 key（group:xxx）/ 群内成员（group:xxx:昵称）/ null
// 每条带来源、置信度、权重、过期时间；重复出现时权重 +1，而不是新增一条。
//
// 检索优先 FTS5(trigram)，2 字中文查询自动回退 LIKE（trigram 需要 ≥3 字符）。

import crypto from 'node:crypto';

export const MEMORY_DEFAULTS = Object.freeze({
  limit: 6,
  maxChars: 800,
  minConfidence: 0.5,
  staleDays: 120
});

function normalize(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim();
}

function hashFact(scope, ownerKey, fact) {
  return crypto.createHash('sha1')
    .update(`${scope}\u0000${ownerKey ?? ''}\u0000${normalize(fact).toLowerCase()}`)
    .digest('hex');
}

function rowToFact(row) {
  if (!row) return null;
  return {
    id: Number(row.id),
    scope: row.scope,
    ownerKey: row.owner_key,
    topic: row.topic,
    fact: row.fact,
    source: row.source,
    confidence: Number(row.confidence),
    weight: Number(row.weight),
    lastSeenAt: row.last_seen_at === null ? null : Number(row.last_seen_at),
    expiresAt: row.expires_at === null ? null : Number(row.expires_at),
    createdAt: Number(row.created_at)
  };
}

export class MemoryStore {
  constructor({ db, now = () => Date.now(), logger = () => {} } = {}) {
    if (!db) throw new Error('MemoryStore 需要 db');
    this.db = db;
    this.now = now;
    this.logger = logger;
    this.ftsReady = true;
  }

  _ftsUpsert(fact) {
    if (!this.ftsReady) return;
    try {
      const row = this.db.get('SELECT id FROM memory_facts WHERE fact_hash = ?', fact.hash);
      if (!row) return;
      this.db.run('DELETE FROM memory_fts WHERE rowid = ?', row.id);
      this.db.run('INSERT INTO memory_fts(rowid, fact, topic, scope, owner_key) VALUES (?, ?, ?, ?, ?)',
        row.id, fact.fact, fact.topic ?? '', fact.scope, fact.ownerKey ?? '');
    } catch (error) {
      // FTS 不可用（老 SQLite/编译选项）时降级为 LIKE，不影响主流程。
      this.ftsReady = false;
      this.logger(`memory FTS 不可用，已降级 LIKE：${error?.message ?? error}`);
    }
  }

  /** 写入/更新一条记忆；相同 scope+owner+fact 只累加权重。 */
  remember({
    scope = 'group',
    ownerKey = null,
    topic = '',
    fact,
    source = '',
    confidence = 0.7,
    expiresAt = null
  } = {}) {
    const text = normalize(fact);
    if (!text) return null;
    const at = this.now();
    const hash = hashFact(scope, ownerKey, text);
    const conf = Math.min(1, Math.max(0, Number(confidence) || 0.7));
    this.db.run(
      `INSERT INTO memory_facts(scope, owner_key, topic, fact, source, confidence, weight, last_seen_at, expires_at, created_at, updated_at, fact_hash)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
       ON CONFLICT(fact_hash) DO UPDATE SET
         weight = memory_facts.weight + 1,
         confidence = MAX(memory_facts.confidence, excluded.confidence),
         last_seen_at = excluded.last_seen_at,
         updated_at = excluded.updated_at,
         topic = CASE WHEN excluded.topic != '' THEN excluded.topic ELSE memory_facts.topic END`,
      scope, ownerKey, normalize(topic), text.slice(0, 500), String(source || '').slice(0, 100),
      conf, at, expiresAt === null ? null : Number(expiresAt), at, at, hash
    );
    this._ftsUpsert({ hash, fact: text.slice(0, 500), topic: normalize(topic), scope, ownerKey });
    return this.db.get('SELECT * FROM memory_facts WHERE fact_hash = ?', hash);
  }

  _ftsQuery(query) {
    const q = normalize(query);
    if (!q) return [];
    // trigram 需要 ≥3 字符；把查询切成 3-gram 用 OR 连接，
    // 这样「主人喜欢下雨天吗」也能命中「主人喜欢下雨天」。
    const segments = q.split(/[\s\p{P}\p{S}]+/u).filter((s) => s.length >= 3);
    const terms = [];
    for (const seg of segments) {
      for (let i = 0; i <= seg.length - 3; i += 1) terms.push(seg.slice(i, i + 3));
    }
    const unique = [...new Set(terms)].slice(0, 16);
    if (!unique.length) return [];
    const expr = unique.map((t) => `"${t.replace(/"/g, '""')}"`).join(' OR ');
    try {
      return this.db.all(
        'SELECT rowid, rank FROM memory_fts WHERE memory_fts MATCH ? ORDER BY rank LIMIT 50',
        expr
      ).map((r) => Number(r.rowid));
    } catch {
      return [];
    }
  }

  _likeTerms(query) {
    const q = normalize(query);
    if (!q) return [];
    // 2 字查询直接用整词；更长的查询额外切 3-gram（不用 2-gram：太容易误命中）。
    if (q.length <= 2) return [q];
    const grams = [];
    for (let i = 0; i <= q.length - 3; i += 1) grams.push(q.slice(i, i + 3));
    return [...new Set([q, ...grams])].slice(0, 10);
  }

  search(query, { scopes = ['group', 'global'], ownerKey = null, limit = MEMORY_DEFAULTS.limit, minConfidence = MEMORY_DEFAULTS.minConfidence } = {}) {
    const at = this.now();
    const allowed = Array.isArray(scopes) && scopes.length ? scopes : ['group', 'global'];
    const scopePlaceholders = allowed.map(() => '?').join(',');
    const ids = this._ftsQuery(query);
    let rows = [];
    if (ids.length) {
      const placeholders = ids.map(() => '?').join(',');
      rows = this.db.all(
        `SELECT * FROM memory_facts WHERE id IN (${placeholders})
         AND scope IN (${scopePlaceholders}) AND (scope = 'global' OR owner_key = ?)
         AND confidence >= ? AND (expires_at IS NULL OR expires_at > ?)
         LIMIT 50`,
        ...ids, ...allowed, ownerKey, Number(minConfidence), at
      );
    } else {
      const terms = this._likeTerms(query);
      if (!terms.length) return [];
      const likeClause = terms.map(() => '(fact LIKE ? OR topic LIKE ?)').join(' OR ');
      const likeParams = terms.flatMap((t) => [`%${t}%`, `%${t}%`]);
      rows = this.db.all(
        `SELECT * FROM memory_facts
         WHERE (${likeClause}) AND scope IN (${scopePlaceholders})
         AND (scope = 'global' OR owner_key = ?)
         AND confidence >= ? AND (expires_at IS NULL OR expires_at > ?)
         ORDER BY weight DESC, last_seen_at DESC LIMIT 50`,
        ...likeParams, ...allowed, ownerKey, Number(minConfidence), at
      );
    }
    // 相关度不能只看 FTS rank：口语化查询经常让一条只被提过一次的旧事实
    // 压过反复出现、最近还在用的记忆。这里把 rank/权重/置信度/新鲜度合成分数，
    // 近 45 天内有更新的记忆优先级更高，但不会完全埋掉高权重旧事实。
    const rankMap = new Map(ids.map((id, i) => [Number(id), i]));
    const score = (row) => {
      const rank = rankMap.get(Number(row.id));
      const rankBoost = rank === undefined ? 0 : 1 / (1 + rank * 0.2);
      const days = Math.max(0, (at - Number(row.last_seen_at || at)) / (24 * 3600 * 1000));
      return rankBoost
        + Number(row.weight || 0) * 0.6
        + Number(row.confidence || 0) * 0.8
        + Math.exp(-days / 45) * 0.5;
    };
    rows.sort((a, b) => score(b) - score(a));
    return rows.slice(0, Math.max(1, Number(limit) || MEMORY_DEFAULTS.limit)).map(rowToFact);
  }

  /** 生成可注入 prompt 的短块；exclude 里的内容（当前话题等）不重复列出。 */
  contextBlock(query, { scopes, ownerKey, limit = 6, maxChars = MEMORY_DEFAULTS.maxChars, exclude = [] } = {}) {
    const excluded = new Set((Array.isArray(exclude) ? exclude : []).map((x) => normalize(x).toLowerCase()));
    const facts = this.search(query, { scopes, ownerKey, limit: Math.max(limit * 2, limit) })
      .filter((f) => !excluded.has(normalize(f.fact).toLowerCase()))
      .slice(0, limit);
    if (!facts.length) return '';
    const lines = ['【长期记忆】（按相关度检索，不一定都是今天的）'];
    let used = lines[0].length;
    for (const f of facts) {
      const line = `- ${f.topic ? `${f.topic}：` : ''}${f.fact}${f.weight > 1 ? `（提到 ${f.weight} 次）` : ''}`;
      if (used + line.length > maxChars) break;
      lines.push(line);
      used += line.length;
    }
    return lines.length > 1 ? lines.join('\n') : '';
  }

  list({ scope = '', ownerKey = '', source = '', limit = 100, includeExpired = false } = {}) {
    const at = this.now();
    const where = [];
    const params = [];
    if (scope) { where.push('scope = ?'); params.push(scope); }
    if (ownerKey) { where.push('owner_key = ?'); params.push(ownerKey); }
    if (source) { where.push('source = ?'); params.push(source); }
    if (!includeExpired) { where.push('(expires_at IS NULL OR expires_at > ?)'); params.push(at); }
    const sql = `SELECT * FROM memory_facts ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY weight DESC, last_seen_at DESC LIMIT ?`;
    return this.db.all(sql, ...params, Math.min(1000, Math.max(1, Number(limit) || 100))).map(rowToFact);
  }

  forget(id) {
    const row = this.db.get('SELECT id FROM memory_facts WHERE id = ?', Number(id));
    if (!row) return false;
    this.db.run('DELETE FROM memory_facts WHERE id = ?', Number(id));
    try { this.db.run('DELETE FROM memory_fts WHERE rowid = ?', Number(id)); } catch {}
    return true;
  }

  clear({ scope = '', ownerKey = '' } = {}) {
    const where = [];
    const params = [];
    if (scope) { where.push('scope = ?'); params.push(scope); }
    if (ownerKey) { where.push('owner_key = ?'); params.push(ownerKey); }
    if (!where.length) return 0;
    const ids = this.db.all(`SELECT id FROM memory_facts WHERE ${where.join(' AND ')}`, ...params).map((r) => Number(r.id));
    for (const id of ids) this.forget(id);
    return ids.length;
  }

  prune({ staleDays = MEMORY_DEFAULTS.staleDays, lowConfidence = 0.35 } = {}) {
    const at = this.now();
    const cutoff = at - Math.max(1, Number(staleDays) || 120) * 24 * 3600 * 1000;
    const removed = this.db.run(
      'DELETE FROM memory_facts WHERE (expires_at IS NOT NULL AND expires_at <= ?) OR (last_seen_at < ? AND confidence < ?)',
      at, cutoff, Number(lowConfidence)
    ).changes;
    if (removed) {
      // 独立 FTS 表没有 external content，不能 'rebuild'；直接按当前事实表重建。
      try {
        this.db.run('DELETE FROM memory_fts');
        const rows = this.db.all('SELECT id, fact, topic, scope, owner_key FROM memory_facts');
        for (const row of rows) {
          this.db.run('INSERT INTO memory_fts(rowid, fact, topic, scope, owner_key) VALUES (?, ?, ?, ?, ?)',
            row.id, row.fact, row.topic ?? '', row.scope, row.owner_key ?? '');
        }
      } catch { /* FTS 不可用时忽略 */ }
    }
    return removed;
  }

  stats() {
    return {
      total: Number(this.db.get('SELECT COUNT(*) AS n FROM memory_facts')?.n ?? 0),
      byScope: Object.fromEntries(this.db.all('SELECT scope, COUNT(*) AS n FROM memory_facts GROUP BY scope').map((r) => [r.scope, Number(r.n)])),
      bySource: Object.fromEntries(this.db.all('SELECT source, COUNT(*) AS n FROM memory_facts GROUP BY source').map((r) => [r.source, Number(r.n)])),
      personalCount: Number(this.db.get("SELECT COUNT(*) AS n FROM memory_facts WHERE scope = 'global' AND source = 'personal'")?.n ?? 0),
      ftsReady: this.ftsReady
    };
  }
}
