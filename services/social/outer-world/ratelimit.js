// 出门见闻：域名级限速（每日次数 + 最小间隔）。
//
// 内存态即可：重启归零只会让额度重新开始，不会放大风险。
// 只有 check 放行时才计数，被拒的请求不计入。

function shanghaiDayKey(ms = Date.now()) {
  const d = new Date(Number(ms) + 8 * 3600 * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

export function createRateLimiter({ perDomainPerDay = 20, perSecond = 1, now = () => Date.now() } = {}) {
  const daily = Math.max(0, Number(perDomainPerDay) || 0);
  const rate = Math.max(0.1, Number(perSecond) || 1);
  const gapMs = Math.floor(1000 / rate);
  const entries = new Map();

  return {
    check(host) {
      const key = String(host ?? '').trim().toLowerCase();
      if (!key) return { allow: false, reason: 'no-host' };
      const at = Number(now()) || Date.now();
      const day = shanghaiDayKey(at);
      let row = entries.get(key);
      if (!row || row.day !== day) {
        row = { day, count: 0, lastAt: 0 };
        entries.set(key, row);
      }
      if (row.lastAt && at - row.lastAt < gapMs) {
        return { allow: false, reason: 'too-fast' };
      }
      if (daily > 0 && row.count >= daily) {
        return { allow: false, reason: 'daily-limit' };
      }
      row.count += 1;
      row.lastAt = at;
      return { allow: true, reason: '' };
    },
    snapshot() {
      const out = {};
      for (const [host, row] of entries) out[host] = { ...row };
      return out;
    },
    reset() {
      entries.clear();
    }
  };
}
