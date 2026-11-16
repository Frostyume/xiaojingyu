// 关注（watch）：增删本地关注项（L1 只写本地）。
// 唯一键 (adapter, kind, target)；重复添加返回已有记录，不产生重复行。

import crypto from 'node:crypto';
import { LIFE_KINDS } from './pipeline.js';

function watchId(adapter, kind, target) {
  return `watch_${crypto.createHash('sha1').update(`${adapter}\u0000${kind}\u0000${target}`).digest('hex').slice(0, 24)}`;
}

function rowToWatch(row) {
  if (!row) return null;
  return {
    id: row.id,
    adapter: row.adapter,
    kind: row.kind,
    target: row.target,
    options: row.options_json ? JSON.parse(row.options_json) : null,
    enabled: Number(row.enabled) === 1,
    createdAt: row.created_at,
    lastChecked: row.last_checked ?? null
  };
}

export function createWatches({ db, clock, adapterIds = [], audit = null }) {
  const known = new Set(adapterIds);

  function add({ adapter, kind = 'feed', target, options = null } = {}) {
    const adapterId = String(adapter ?? '').trim();
    if (!known.has(adapterId)) return { ok: false, error: `未知适配器：${adapterId || '(空)'}` };
    if (!LIFE_KINDS.includes(kind)) return { ok: false, error: `未知类型：${kind}` };
    const clean = String(target ?? '').trim().replace(/[\u0000-\u001f]/g, ' ').slice(0, 200);
    if (!clean) return { ok: false, error: 'target 不能为空' };
    const at = Number(clock.now());
    const id = watchId(adapterId, kind, clean);
    const existing = db.get('SELECT * FROM life_watch WHERE adapter = ? AND kind = ? AND target = ?', adapterId, kind, clean);
    if (existing) {
      db.run('UPDATE life_watch SET enabled = 1 WHERE id = ?', existing.id);
      if (audit) audit.record({ actor: 'owner', adapter: adapterId, action: 'watch.add', args: { kind, target: clean }, decision: 'executed', result: { existed: true } });
      return { ok: true, watch: { ...rowToWatch(existing), enabled: true }, existed: true };
    }
    db.run(
      `INSERT INTO life_watch(id, adapter, kind, target, options_json, enabled, created_at, last_checked)
       VALUES (?, ?, ?, ?, ?, 1, ?, NULL)`,
      id, adapterId, kind, clean, options ? JSON.stringify(options).slice(0, 2000) : null, at
    );
    if (audit) audit.record({ actor: 'owner', adapter: adapterId, action: 'watch.add', args: { kind, target: clean }, decision: 'executed', result: { existed: false } });
    return { ok: true, watch: rowToWatch(db.get('SELECT * FROM life_watch WHERE id = ?', id)), existed: false };
  }

  function remove({ id = '', adapter = '', kind = '', target = '' } = {}) {
    let changes = 0;
    if (id) {
      changes = db.run('DELETE FROM life_watch WHERE id = ?', String(id)).changes;
    } else {
      const clean = String(target ?? '').trim().slice(0, 200);
      if (!adapter || !kind || !clean) return { ok: false, error: '需要 id，或 adapter/kind/target' };
      changes = db.run('DELETE FROM life_watch WHERE adapter = ? AND kind = ? AND target = ?', String(adapter), String(kind), clean).changes;
    }
    if (audit) audit.record({ actor: 'owner', adapter: adapter || null, action: 'watch.remove', args: { id, adapter, kind, target }, decision: changes ? 'executed' : 'noop', result: { changes } });
    return { ok: changes > 0, removed: changes };
  }

  function list({ adapter = '', limit = 50 } = {}) {
    const capped = Math.max(1, Math.min(100, Number(limit) || 50));
    const rows = adapter
      ? db.all('SELECT * FROM life_watch WHERE adapter = ? ORDER BY created_at DESC LIMIT ?', String(adapter), capped)
      : db.all('SELECT * FROM life_watch ORDER BY created_at DESC LIMIT ?', capped);
    return rows.map(rowToWatch);
  }

  return { add, remove, list };
}
