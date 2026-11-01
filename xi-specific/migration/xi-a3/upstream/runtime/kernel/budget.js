// 预算与账本（按天、按会话）。
//
// 数据来源：DSH 的 provider usage（assistant/message 等事件），按 (session, turn, step, retry) 幂等落库。
// 预算单位是 **token 总量**（cacheHit 也算上下文规模）；费用由价目表估算，仅用于展示。
//
// 超预算时的策略由调用方决定：桥接默认只压制「非显式」唤醒（概率/任意消息/主动机会），
// @/引用/私聊/提问/关键词永远不被预算挡住 —— 钱可以省，被叫必回不能丢。

export function shanghaiDayKey(at = Date.now()) {
  const d = new Date(at + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function dayStartMs(at = Date.now()) {
  const shifted = at + 8 * 3600 * 1000;
  const d = new Date(shifted);
  const localMidnightUtc = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 0, 0, 0);
  return localMidnightUtc - 8 * 3600 * 1000;
}

export class BudgetStore {
  constructor({ db, now = () => Date.now(), logger = () => {} } = {}) {
    if (!db) throw new Error('BudgetStore 需要 db');
    this.db = db;
    this.now = now;
    this.logger = logger;
  }

  record({ key = '', sessionId = '', turn = null, step = null, retry = null, model = '', provider = '', tokensIn = 0, tokensOut = 0, cost = 0, tier = '', at = null, dedupeKey = '' } = {}) {
    const atMs = Number(at) || this.now();
    const dedupe = dedupeKey || (sessionId && Number.isFinite(Number(turn)) && Number.isFinite(Number(step))
      ? `${sessionId}:${turn}:${step}:${retry ?? 0}` : '');
    if (!dedupe) return false;
    try {
      const result = this.db.run(
        `INSERT OR IGNORE INTO usage_ledger(key, session_id, turn, step, model, provider, tokens_in, tokens_out, cost, tier, dedupe_key, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        key || null, sessionId || null, Number.isFinite(Number(turn)) ? Number(turn) : null,
        Number.isFinite(Number(step)) ? Number(step) : null,
        model || null, provider || null,
        Math.max(0, Number(tokensIn) || 0), Math.max(0, Number(tokensOut) || 0),
        Math.max(0, Number(cost) || 0), tier || null, dedupe, atMs
      );
      return result.changes > 0;
    } catch (error) {
      this.logger(`预算记账失败（忽略）：${error?.message ?? error}`);
      return false;
    }
  }

  usageSince(since, { key = '' } = {}) {
    const row = key
      ? this.db.get(
        'SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS turns FROM usage_ledger WHERE created_at >= ? AND key = ?',
        since, key
      )
      : this.db.get(
        'SELECT COALESCE(SUM(tokens_in + tokens_out), 0) AS tokens, COALESCE(SUM(cost), 0) AS cost, COUNT(*) AS turns FROM usage_ledger WHERE created_at >= ?',
        since
      );
    return { tokens: Number(row?.tokens ?? 0), cost: Number(row?.cost ?? 0), turns: Number(row?.turns ?? 0) };
  }

  dayUsage({ key = '', at = null } = {}) {
    const atMs = Number(at) || this.now();
    return { day: shanghaiDayKey(atMs), ...this.usageSince(dayStartMs(atMs), { key }) };
  }

  /**
   * @param {string} key
   * @param {{dailyTokensPerKey?:number,dailyTokensGlobal?:number}} limits 0 = 不限
   * @returns {{allowed:boolean, scope:'', used:number, limit:number, day:string, globalUsed:number}}
   */
  check(key, limits = {}) {
    const at = this.now();
    const day = shanghaiDayKey(at);
    const keyLimit = Math.max(0, Number(limits.dailyTokensPerKey) || 0);
    const globalLimit = Math.max(0, Number(limits.dailyTokensGlobal) || 0);
    const own = this.dayUsage({ key, at });
    const global = this.dayUsage({ at });
    if (keyLimit > 0 && own.tokens >= keyLimit) {
      return { allowed: false, scope: 'key', used: own.tokens, limit: keyLimit, day, globalUsed: global.tokens };
    }
    if (globalLimit > 0 && global.tokens >= globalLimit) {
      return { allowed: false, scope: 'global', used: global.tokens, limit: globalLimit, day, globalUsed: global.tokens };
    }
    return { allowed: true, scope: '', used: own.tokens, limit: keyLimit, day, globalUsed: global.tokens };
  }

  stats() {
    const day = this.dayUsage();
    return { day: day.day, tokens: day.tokens, cost: Number(day.cost.toFixed(6)), turns: day.turns };
  }

  recent({ limit = 20 } = {}) {
    return this.db.all(
      'SELECT key, session_id, model, provider, tokens_in, tokens_out, cost, tier, created_at FROM usage_ledger ORDER BY id DESC LIMIT ?',
      Math.min(200, Math.max(1, Number(limit) || 20))
    ).map((r) => ({
      key: r.key,
      sessionId: r.session_id,
      model: r.model,
      provider: r.provider,
      tokensIn: Number(r.tokens_in),
      tokensOut: Number(r.tokens_out),
      cost: Number(r.cost),
      tier: r.tier,
      at: Number(r.created_at)
    }));
  }
}
