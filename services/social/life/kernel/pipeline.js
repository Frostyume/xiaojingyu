// 同步流水线：拉取 → 归一化 → 去重 → 落库 → 发事件。
//
// 只存归一化后的最小字段：标题、时间、状态；原始正文默认不落库（retention.rawDays=0）。

import crypto from 'node:crypto';
import { sanitizeTitle } from './redact.js';

export const LIFE_KINDS = Object.freeze(['calendar', 'parcel', 'bill', 'subscription', 'paper', 'todo', 'feed', 'health']);
const LIFE_STATUSES = new Set(['open', 'done', 'dismissed', 'expired']);
const MAX_ITEMS_PER_SYNC = 200;
const DAY = 24 * 60 * 60 * 1000;
const MAX_SUMMARY_CHARS = 600;

// 只允许这些元数据落库：推送/日报需要，但不把适配器返回的任意字段原样存下来。
const META_KEYS = new Set([
  'url', 'doi', 'arxivId', 'venue', 'year', 'publicationDate', 'authors', 'institutions',
  'tldr', 'tldrSource', 'repo', 'number', 'author', 'state', 'updatedAt', 'htmlUrl',
  'tag', 'releaseName', 'publishedAt', 'baseline', 'sourceLabel',
  // 日历晨报与 RSS 摘要的展示字段：地点/备注/全天、来源订阅名、播客时长。
  'location', 'description', 'allDay', 'feed', 'duration'
]);

function toInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : null;
}

function cleanSummary(value) {
  const text = String(value ?? '').replace(/https?:\/\/\S+/gi, '').replace(/\s+/g, ' ').trim();
  return text ? Array.from(text).slice(0, MAX_SUMMARY_CHARS).join('') : null;
}

function cleanMeta(raw) {
  const src = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const meta = {};
  for (const [key, value] of Object.entries(src)) {
    if (!META_KEYS.has(key) || value === undefined || value === null) continue;
    if (Array.isArray(value)) {
      meta[key] = value.slice(0, 12).map((item) => String(item ?? '').slice(0, 120)).filter(Boolean);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      meta[key] = value;
    } else {
      meta[key] = String(value).slice(0, 400);
    }
  }
  return meta;
}

function itemId(adapter, dedupeKey) {
  return `life_${crypto.createHash('sha1').update(`${adapter}\u0000${dedupeKey}`).digest('hex').slice(0, 24)}`;
}

export function createPipeline({ db, config, clock, logger = () => {}, audit = null, emit = null }) {
  const now = () => Number(clock.now());

  function normalize(adapterId, draft, { madeAt = now() } = {}) {
    if (!draft || typeof draft !== 'object') return null;
    const dedupeKey = String(draft.dedupeKey ?? '').trim();
    if (!dedupeKey || dedupeKey.length > 200) return null;
    const title = sanitizeTitle(draft.title);
    if (!title) return null;
    const kind = LIFE_KINDS.includes(draft.kind) ? draft.kind : 'feed';
    const status = LIFE_STATUSES.has(draft.status) ? draft.status : 'open';
    const itemDays = Math.max(1, Number(config?.retention?.itemDays) || 90);
    const expiresAt = toInt(draft.expiresAt) ?? (madeAt + itemDays * DAY);
    return {
      id: itemId(adapterId, dedupeKey),
      adapter: adapterId,
      kind,
      externalId: draft.externalId ? String(draft.externalId).slice(0, 200) : null,
      title,
      summary: cleanSummary(draft.summary),
      startsAt: toInt(draft.startsAt),
      endsAt: toInt(draft.endsAt),
      dueAt: toInt(draft.dueAt),
      status,
      risk: 0,
      payload: {
        adapter: adapterId,
        kind,
        source: draft.source ? String(draft.source).slice(0, 40) : null,
        ...cleanMeta(draft.meta)
      },
      dedupeKey,
      sourceRef: draft.sourceRef ? String(draft.sourceRef).slice(0, 200) : null,
      createdAt: madeAt,
      updatedAt: madeAt,
      expiresAt
    };
  }

  function store(adapterId, drafts, { madeAt = now() } = {}) {
    const summary = { inserted: 0, updated: 0, skipped: 0, invalid: 0 };
    const items = [];
    const insertedItems = [];
    db.transaction(() => {
      for (const draft of (Array.isArray(drafts) ? drafts : []).slice(0, MAX_ITEMS_PER_SYNC)) {
        const item = normalize(adapterId, draft, { madeAt });
        if (!item) { summary.invalid += 1; continue; }
        const existing = db.get('SELECT * FROM life_items WHERE dedupe_key = ?', item.dedupeKey);
        if (!existing) {
          db.run(
            `INSERT INTO life_items(id, adapter, kind, external_id, title, summary, starts_at, ends_at, due_at,
               status, risk, payload_json, dedupe_key, source_ref, created_at, updated_at, expires_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`,
            item.id, item.adapter, item.kind, item.externalId, item.title, item.summary, item.startsAt, item.endsAt, item.dueAt,
            item.status, JSON.stringify(item.payload), item.dedupeKey, item.sourceRef,
            item.createdAt, item.updatedAt, item.expiresAt
          );
          summary.inserted += 1;
          items.push(item);
          insertedItems.push(item);
          continue;
        }
        const changed = existing.title !== item.title
          || (existing.summary ?? null) !== item.summary
          || existing.status !== item.status
          || (existing.starts_at ?? null) !== item.startsAt
          || (existing.ends_at ?? null) !== item.endsAt
          || (existing.due_at ?? null) !== item.dueAt;
        if (!changed) { summary.skipped += 1; continue; }
        db.run(
          `UPDATE life_items SET title = ?, summary = ?, status = ?, starts_at = ?, ends_at = ?, due_at = ?,
             external_id = COALESCE(?, external_id), payload_json = ?, expires_at = ?, updated_at = ?
           WHERE dedupe_key = ?`,
          item.title, item.summary, item.status, item.startsAt, item.endsAt, item.dueAt,
          item.externalId, JSON.stringify(item.payload), item.expiresAt, item.updatedAt, item.dedupeKey
        );
        summary.updated += 1;
        items.push({ ...item, id: existing.id });
      }
    });
    if (items.length && typeof emit === 'function') {
      try { emit({ type: 'life.items', adapter: adapterId, count: items.length, at: madeAt }); } catch { /* 事件失败不影响落库 */ }
    }
    return { ...summary, items, insertedItems };
  }

  function readCursor(adapterId) {
    try {
      const row = db.get('SELECT cursor FROM life_sync_state WHERE adapter = ?', adapterId);
      return row?.cursor ?? null;
    } catch {
      return null;
    }
  }

  async function syncAdapter(adapter, { reason = 'schedule', limit = MAX_ITEMS_PER_SYNC, preview = false } = {}) {
    const started = now();
    const result = await adapter.impl.sync({
      config: adapter.config,
      http: adapter.guard,
      log: logger,
      now,
      limit: Math.min(MAX_ITEMS_PER_SYNC, Math.max(1, Number(limit) || MAX_ITEMS_PER_SYNC)),
      cursor: preview ? null : readCursor(adapter.id),
      summarizer: adapter.summarizer ?? null,
      preview
    });
    const drafts = Array.isArray(result?.items) ? result.items : [];
    const summary = preview
      ? { inserted: 0, updated: 0, skipped: 0, invalid: 0, items: drafts, insertedItems: [] }
      : store(adapter.id, drafts, { madeAt: now() });
    const latencyMs = now() - started;
    if (audit) {
      audit.record({
        actor: 'scheduler', adapter: adapter.id, action: `sync.${reason}`,
        args: { reason, preview }, decision: 'executed',
        result: { ...summary, fetched: drafts.length, cursor: Boolean(result?.cursor) }, durationMs: latencyMs
      });
    }
    return {
      ...summary,
      fetched: drafts.length,
      latencyMs,
      cursor: preview ? null : (result?.cursor ?? null),
      meta: result?.meta ?? null
    };
  }

  function rowToItem(row) {
    if (!row) return null;
    return {
      id: row.id,
      adapter: row.adapter,
      kind: row.kind,
      title: row.title,
      startsAt: row.starts_at ?? null,
      endsAt: row.ends_at ?? null,
      dueAt: row.due_at ?? null,
      status: row.status,
      updatedAt: row.updated_at
    };
  }

  /** 内部使用：带 summary/payload 的完整条目；不通过 MCP query 暴露。 */
  function rowToFullItem(row) {
    if (!row) return null;
    let payload = {};
    try { payload = row.payload_json ? JSON.parse(row.payload_json) : {}; } catch { payload = {}; }
    return {
      ...rowToItem(row),
      summary: row.summary ?? null,
      payload,
      externalId: row.external_id ?? null,
      sourceRef: row.source_ref ?? null,
      createdAt: row.created_at,
      expiresAt: row.expires_at ?? null
    };
  }

  /** 查询：只返回脱敏后的展示字段；payload/summary/source_ref 永不出库。 */
  function query({ kind = '', adapter = '', status = '', q = '', from = null, to = null, limit = 20 } = {}) {
    const capped = Math.max(1, Math.min(20, Number(limit) || 20));
    const where = [];
    const params = [];
    if (kind) { where.push('kind = ?'); params.push(String(kind)); }
    if (adapter) { where.push('adapter = ?'); params.push(String(adapter)); }
    if (status) { where.push('status = ?'); params.push(String(status)); }
    if (q) { where.push('title LIKE ?'); params.push(`%${String(q).slice(0, 60).replace(/[%_]/g, '')}%`); }
    // 注意 Number(null) === 0，必须显式排除空值，否则默认查询会被 0..0 窗口掐空。
    const hasFrom = from !== null && from !== undefined && from !== '' && Number.isFinite(Number(from));
    const hasTo = to !== null && to !== undefined && to !== '' && Number.isFinite(Number(to));
    if (hasFrom) { where.push('COALESCE(starts_at, due_at, updated_at) >= ?'); params.push(Number(from)); }
    if (hasTo) { where.push('COALESCE(starts_at, due_at, updated_at) <= ?'); params.push(Number(to)); }
    const sql = `SELECT * FROM life_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(starts_at, due_at, updated_at) ASC LIMIT ?`;
    return db.all(sql, ...params, capped).map(rowToItem);
  }

  function briefCandidates({ nowMs = now(), limit = 120 } = {}) {
    const at = Number(nowMs);
    const rows = db.all(
      `SELECT * FROM life_items
       WHERE status IN ('open', 'done') AND (expires_at IS NULL OR expires_at > ?)
       ORDER BY
         CASE WHEN due_at IS NOT NULL AND due_at < ? THEN 0
              WHEN starts_at IS NOT NULL AND starts_at <= ? THEN 1
              ELSE 2 END,
         COALESCE(starts_at, due_at, updated_at) ASC
       LIMIT ?`,
      at, at, at + DAY, Math.max(1, Math.min(300, Number(limit) || 120))
    );
    return rows.map(rowToItem);
  }

  /** 推送/日报内部使用的完整条目；可按适配器、时间窗口过滤。 */
  function moduleFeed({ adapter = '', kind = '', since = null, until = null, limit = 20 } = {}) {
    const where = [];
    const params = [];
    if (adapter) { where.push('adapter = ?'); params.push(String(adapter)); }
    if (kind) { where.push('kind = ?'); params.push(String(kind)); }
    if (Number.isFinite(Number(since))) { where.push('COALESCE(starts_at, updated_at) >= ?'); params.push(Number(since)); }
    if (Number.isFinite(Number(until))) { where.push('COALESCE(starts_at, updated_at) <= ?'); params.push(Number(until)); }
    const sql = `SELECT * FROM life_items ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY COALESCE(starts_at, updated_at) DESC LIMIT ?`;
    return db.all(sql, ...params, Math.max(1, Math.min(200, Number(limit) || 20))).map(rowToFullItem);
  }

  function countSince(adapter, since) {
    const row = db.get(
      'SELECT COUNT(*) AS n FROM life_items WHERE adapter = ? AND COALESCE(starts_at, updated_at) >= ?',
      String(adapter), Number(since) || 0
    );
    return Number(row?.n) || 0;
  }

  function expire(nowMs = now()) {
    return db.run(
      "UPDATE life_items SET status = 'expired', updated_at = ? WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?",
      Number(nowMs), Number(nowMs)
    ).changes;
  }

  function counts() {
    const rows = db.all('SELECT status, COUNT(*) AS n FROM life_items GROUP BY status');
    return Object.fromEntries(rows.map((row) => [row.status, Number(row.n)]));
  }

  return {
    normalize, store, syncAdapter, query, briefCandidates, moduleFeed, countSince,
    expire, counts, rowToFullItem, MAX_ITEMS_PER_SYNC
  };
}
