// 保留策略：每日清理过期条目与陈旧健康记录。
//
// 原始正文默认不落库（rawDays=0）；条目按 manifest/全局 itemDays 设置 expires_at。
// P0 没有 life_actions / life_audit 表，actionDays 仅保留在配置里供 P1 使用。

const DAY = 24 * 60 * 60 * 1000;

export function createRetention({ db, config, clock, logger = () => {}, audit = null }) {
  function run(nowMs = Number(clock.now()), { adapterIds = [] } = {}) {
    const itemDays = Math.max(1, Number(config?.retention?.itemDays) || 90);
    const healthDays = Math.max(1, Number(config?.retention?.healthDays) || 30);
    const at = Number(nowMs);
    const cutoff = at - itemDays * DAY;
    const healthCutoff = at - healthDays * DAY;
    const out = { expired: 0, items: 0, health: 0 };
    try {
      out.expired = db.run(
        "UPDATE life_items SET status = 'expired', updated_at = ? WHERE status = 'open' AND expires_at IS NOT NULL AND expires_at <= ?",
        at, at
      ).changes;
      out.items = db.run(
        "DELETE FROM life_items WHERE (expires_at IS NOT NULL AND expires_at <= ?) OR updated_at < ?",
        at, cutoff
      ).changes;
      const keep = new Set(adapterIds);
      for (const row of db.all('SELECT adapter, updated_at FROM life_health')) {
        if (!keep.has(row.adapter) && Number(row.updated_at) < healthCutoff) {
          out.health += db.run('DELETE FROM life_health WHERE adapter = ?', row.adapter).changes;
        }
      }
    } catch (error) {
      logger('warn', `生活管家清理失败（不影响其它功能）：${error?.message ?? error}`);
    }
    if (audit) audit.record({ actor: 'scheduler', action: 'retention.run', result: out });
    return out;
  }

  return { run };
}
