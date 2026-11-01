import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';

const hash = value => createHash('sha256').update(value).digest('hex');
const tables = Object.freeze({memory_facts: ['id'], member_relationships: ['key', 'user_id'],
  relationship_events: ['id'], relationship_daily: ['key', 'user_id', 'day_key']});

/** Read committed upstream facts and interpretations into the original experience
 * store, without pretending they are a new human message. Full bridge and DSH
 * roots still belong in every stopped data generation; this is not their backup.
 */
export function createRetainedStateMirror({bridgeDb, cursorFile, runtimeId, record, clock = () => Date.now()} = {}) {
  if (!path.isAbsolute(bridgeDb ?? '') || !path.isAbsolute(cursorFile ?? '') || !/^[\w-]{1,100}$/.test(runtimeId ?? '') || typeof record !== 'function') throw new Error('Explicit retained-state binding required');
  let prior = {format: 'xi-retained-state-cursor-v1', runtimeId, rows: {}};
  if (fs.existsSync(cursorFile)) {
    prior = JSON.parse(fs.readFileSync(cursorFile, 'utf8'));
    if (prior.format !== 'xi-retained-state-cursor-v1' || prior.runtimeId !== runtimeId || !prior.rows) throw new Error('Retained-state cursor belongs to another generation');
  }
  return Object.freeze({sync() {
    if (!fs.existsSync(bridgeDb)) throw new Error('Bridge state is not initialized');
    const db = new DatabaseSync(bridgeDb, {readOnly: true}), snapshot = [];
    try {
      db.exec('PRAGMA busy_timeout=5000; BEGIN');
      for (const [table, keys] of Object.entries(tables)) {
        const rows = db.prepare('SELECT * FROM ' + table + ' LIMIT 10001').all();
        if (rows.length > 10000) throw new Error('Retained-state page limit reached; full source remains preserved');
        for (const row of rows) {
          const identity = keys.map(key => {
            if (!Object.hasOwn(row, key)) throw new Error('Retained-state schema changed');
            return row[key];
          });
          const key = table + ':' + hash(JSON.stringify(identity)).slice(0, 32);
          snapshot.push({key, table, identity, row, digest: hash(JSON.stringify(row))});
        }
      }
      db.exec('COMMIT');
    } finally { db.close(); }
    const next = {format: prior.format, runtimeId, rows: {}}, observedAt = clock();
    let changed = 0, removed = 0;
    for (const item of snapshot) {
      const existing = prior.rows[item.key];
      if (existing?.digest !== item.digest || existing?.removed) {
        const description = item.table === 'memory_facts' ? '角色在当前底座保存的一条理解或事实笔记' : '角色在当前底座形成的关系观察或状态';
        record({event: 'bridge:' + runtimeId + ':' + item.key,
          text: JSON.stringify({body: description + '，不是对应群友的新发言。\n' + JSON.stringify(item.row),
            interpretation: true, removed: false, table: item.table, row: item.row}),
          at: Number(item.row.updated_at ?? item.row.created_at ?? observedAt),
          sourceRef: {runtimeId, table: item.table, identity: item.identity, rowSha256: item.digest}, state: 'retained-interpretation'});
        changed++;
      }
      next.rows[item.key] = {digest: item.digest, table: item.table, identity: item.identity};
    }
    for (const [key, item] of Object.entries(prior.rows)) {
      if (Object.hasOwn(next.rows, key)) continue;
      if (!item.removed) {
        record({event: 'bridge:' + runtimeId + ':' + key,
          text: JSON.stringify({body: '这条新底座笔记或关系记录已被删除，不应继续当作当前有效理解。历史版本仅保留来源。', removed: true, table: item.table}),
          at: observedAt, sourceRef: {runtimeId, table: item.table, identity: item.identity}, state: 'removed-interpretation'});
        removed++;
      }
      next.rows[key] = {...item, removed: true};
    }
    fs.mkdirSync(path.dirname(cursorFile), {recursive: true});
    const temporary = cursorFile + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next), {flag: 'wx'}); fs.renameSync(temporary, cursorFile); prior = next;
    return {changed, removed, rowsObserved: snapshot.length, source: 'owned-bridge-state', modelRequests: 0};
  }});
}
