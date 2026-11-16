// 稳定身份：Person（一个人）与 Identity（某平台上的一个账号）。
//
// 规则：
//   · 身份用「平台 + 稳定账号标识」表示，如 qq:10001；昵称只是可变的展示属性；
//   · 跨平台/跨账号关联必须显式确认（link({ confirmed: true })），绝不按昵称自动合并；
//   · 旧 member key（例如 member:小明）没有稳定账号标识时保持未解析，不猜归属。

import crypto from 'node:crypto';
import { ensureSocialSchema } from './social-schema.js';

export const IDENTITY_KEY_SEPARATOR = ':';

export class IdentityError extends Error {
  constructor(message, code = 'identity_error') {
    super(message);
    this.name = 'IdentityError';
    this.code = code;
  }
}

export function identityKey(platform, accountId) {
  const p = String(platform ?? '').trim().toLowerCase();
  const a = String(accountId ?? '').trim();
  return p && a ? `${p}${IDENTITY_KEY_SEPARATOR}${a}` : '';
}

export function parseIdentityKey(key) {
  const raw = String(key ?? '').trim();
  const at = raw.indexOf(IDENTITY_KEY_SEPARATOR);
  if (at <= 0) return null;
  return { platform: raw.slice(0, at), accountId: raw.slice(at + 1) };
}

function normalizePlatform(platform) {
  const p = String(platform ?? '').trim().toLowerCase();
  if (!/^[a-z][a-z0-9_-]{0,15}$/.test(p)) throw new IdentityError(`无效平台：${platform}`, 'invalid_platform');
  return p;
}

function normalizeAccountId(platform, accountId) {
  const a = String(accountId ?? '').trim();
  if (!a) throw new IdentityError('账号标识不能为空', 'invalid_account');
  if (a.includes(IDENTITY_KEY_SEPARATOR)) throw new IdentityError('账号标识不能包含冒号', 'invalid_account');
  // QQ 的稳定标识是数字 UIN；昵称、群名片都不可作为账号标识。
  if (platform === 'qq' && !/^\d{1,20}$/.test(a)) throw new IdentityError(`QQ 账号标识必须是数字 UIN：${a}`, 'invalid_account');
  return a;
}

function rowToIdentity(row) {
  if (!row) return null;
  return {
    platform: row.platform,
    accountId: row.account_id,
    personId: row.person_id,
    displayName: row.display_name ?? '',
    confirmed: Number(row.confirmed || 0) > 0,
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

function rowToPerson(row) {
  if (!row) return null;
  return {
    id: row.id,
    displayName: row.display_name ?? '',
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at)
  };
}

export class IdentityStore {
  constructor({ db, now = () => Date.now(), logger = () => {} } = {}) {
    ensureSocialSchema(db);
    if (!db) throw new Error('IdentityStore 需要 db');
    this.db = db;
    this.now = now;
    this.logger = logger;
  }

  _identityRow(platform, accountId) {
    return this.db.get('SELECT * FROM identities WHERE platform = ? AND account_id = ?', platform, accountId);
  }

  getIdentity(platform, accountId) {
    try {
      const p = normalizePlatform(platform);
      return rowToIdentity(this._identityRow(p, normalizeAccountId(p, accountId)));
    } catch {
      return null;
    }
  }

  getPerson(personId) {
    const id = String(personId ?? '').trim();
    if (!id) return null;
    return rowToPerson(this.db.get('SELECT * FROM persons WHERE id = ?', id));
  }

  /** 只读解析：给定平台账号，返回已绑定的人；没有绑定返回 null。 */
  resolve(platform, accountId) {
    const identity = this.getIdentity(platform, accountId);
    if (!identity) return null;
    return this.getPerson(identity.personId);
  }

  /**
   * 取回或创建绑定。昵称只作为展示属性：已存在的身份不会因为传入不同昵称而换人，
   * 也不会覆盖显式 rename 后的展示名。
   */
  ensurePerson({ platform = 'qq', accountId, displayName = '' } = {}) {
    const p = normalizePlatform(platform);
    const a = normalizeAccountId(p, accountId);
    return this.db.transaction(() => {
      const existing = this._identityRow(p, a);
      if (existing) {
        return { person: rowToPerson(this.db.get('SELECT * FROM persons WHERE id = ?', existing.person_id)), identity: rowToIdentity(existing), created: false };
      }
      const at = this.now();
      const personId = `person:${crypto.randomUUID()}`;
      const name = String(displayName ?? '').slice(0, 60);
      this.db.run('INSERT INTO persons(id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)', personId, name, at, at);
      this.db.run(
        `INSERT INTO identities(platform, account_id, person_id, display_name, confirmed, created_at, updated_at)
         VALUES (?, ?, ?, ?, 1, ?, ?)`,
        p, a, personId, name, at, at
      );
      return {
        person: this.getPerson(personId),
        identity: rowToIdentity(this._identityRow(p, a)),
        created: true
      };
    });
  }

  /** 昵称变化只更新展示属性，不改变身份归属。 */
  rename({ platform = 'qq', accountId, displayName = '' } = {}) {
    const p = normalizePlatform(platform);
    const a = normalizeAccountId(p, accountId);
    const row = this._identityRow(p, a);
    if (!row) return null;
    const at = this.now();
    const name = String(displayName ?? '').slice(0, 60);
    this.db.transaction(() => {
      this.db.run('UPDATE identities SET display_name = ?, updated_at = ? WHERE platform = ? AND account_id = ?', name, at, p, a);
      this.db.run('UPDATE persons SET display_name = ?, updated_at = ? WHERE id = ?', name, at, row.person_id);
    });
    return this.getIdentity(p, a);
  }

  /** 人工把某个账号显式绑定到已有的人（不走昵称匹配）。 */
  bind({ platform = 'qq', accountId, personId } = {}) {
    const p = normalizePlatform(platform);
    const a = normalizeAccountId(p, accountId);
    const target = String(personId ?? '').trim();
    if (!target || !this.getPerson(target)) throw new IdentityError('目标 person 不存在', 'person_not_found');
    const at = this.now();
    const row = this._identityRow(p, a);
    if (row) {
      this.db.run('UPDATE identities SET person_id = ?, confirmed = 1, updated_at = ? WHERE platform = ? AND account_id = ?', target, at, p, a);
    } else {
      this.db.run(
        'INSERT INTO identities(platform, account_id, person_id, display_name, confirmed, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
        p, a, target, '', at, at
      );
    }
    return this.getIdentity(p, a);
  }

  /**
   * 跨平台/跨账号关联。必须显式 confirmed: true；否则抛 confirmation_required，
   * 防止因为昵称相同或模型推断把两个人合并。
   */
  link({ from, to, confirmed = false } = {}) {
    if (confirmed !== true) {
      throw new IdentityError('跨账号关联必须显式确认（confirmed: true）', 'confirmation_required');
    }
    const left = from ? parseIdentityKey(identityKey(from.platform ?? 'qq', from.accountId)) : null;
    const right = to ? parseIdentityKey(identityKey(to.platform ?? 'qq', to.accountId)) : null;
    if (!left || !right) throw new IdentityError('link 需要 from/to 两个账号', 'invalid_link');
    const leftRow = this._identityRow(normalizePlatform(left.platform), normalizeAccountId(left.platform, left.accountId));
    const rightRow = this._identityRow(normalizePlatform(right.platform), normalizeAccountId(right.platform, right.accountId));
    if (!leftRow || !rightRow) throw new IdentityError('待关联账号必须已存在', 'identity_not_found');
    const sourceId = leftRow.person_id;
    const targetId = rightRow.person_id;
    if (sourceId === targetId) return { personId: targetId, moved: 0, mergedFrom: null };
    const at = this.now();
    return this.db.transaction(() => {
      const moved = this.db.run(
        'UPDATE identities SET person_id = ?, confirmed = 1, updated_at = ? WHERE person_id = ?',
        targetId, at, sourceId
      ).changes;
      // 通用版不要求 memory_facts 有身份列：有就同步，没有就跳过。
      try { this.db.run('UPDATE memory_facts SET subject_person_id = ? WHERE subject_person_id = ?', targetId, sourceId); } catch {}
      this.db.run('DELETE FROM persons WHERE id = ?', sourceId);
      return { personId: targetId, moved: Number(moved), mergedFrom: sourceId };
    });
  }

  listIdentities(personId) {
    const id = String(personId ?? '').trim();
    if (!id) return [];
    return this.db.all('SELECT * FROM identities WHERE person_id = ? ORDER BY platform, account_id', id).map(rowToIdentity);
  }

  /**
   * 旧 owner_key 是否已能确定到稳定身份。只读、不创建绑定。
   * 认 person:<uin>、private:<uin>、member:qq:<uin>；其余（member:小明 等）保持未解析。
   */
  resolveMemberKey(ownerKey) {
    const raw = String(ownerKey ?? '').trim();
    if (!raw) return { resolved: false, personId: null, reason: 'empty_key' };
    const match = /^(?:person|private|member:qq):(\d{1,20})$/.exec(raw);
    if (!match) return { resolved: false, personId: null, reason: 'no_stable_account_id' };
    const identity = this.getIdentity('qq', match[1]);
    return {
      resolved: true,
      platform: 'qq',
      accountId: match[1],
      personId: identity?.personId ?? null,
      reason: identity ? 'bound' : 'identity_not_bound'
    };
  }

  /** 记忆行里的身份解析情况：用于迁移前后核对，不修改任何行。 */
  memoryIdentityStats() {
    const rows = this.db.all('SELECT owner_key, subject_person_id FROM memory_facts').map((r) => ({
      ownerKey: r.owner_key,
      subjectPersonId: r.subject_person_id ?? null
    }));
    let unresolved = 0;
    let resolved = 0;
    let notApplicable = 0;
    for (const row of rows) {
      if (row.subjectPersonId) { resolved += 1; continue; }
      const key = String(row.ownerKey ?? '');
      if (!key || key.startsWith('group:') || key === 'self') { notApplicable += 1; continue; }
      if (this.resolveMemberKey(key).resolved) resolved += 1;
      else if (key.startsWith('member:')) unresolved += 1; // 昵称等无法确定身份的旧 key
      else notApplicable += 1;
    }
    return { total: rows.length, resolved, unresolved, notApplicable };
  }

  stats() {
    const persons = Number(this.db.get('SELECT COUNT(*) AS n FROM persons')?.n ?? 0);
    const identities = Number(this.db.get('SELECT COUNT(*) AS n FROM identities')?.n ?? 0);
    const linked = Number(this.db.get(
      'SELECT COUNT(*) AS n FROM (SELECT person_id FROM identities GROUP BY person_id HAVING COUNT(*) > 1)'
    )?.n ?? 0);
    return { persons, identities, multiIdentityPersons: linked };
  }
}
