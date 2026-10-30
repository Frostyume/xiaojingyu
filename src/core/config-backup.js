// config.json 写前快照：统一命名 + 按 tag 轮转，避免 .bak-* 无限堆积。
//
// 为什么需要：写 config 的入口有七八个（控制台改配置、分享模块、功能中心、doctor、
// dsh-ensure、setup-dsh），早期各自 copyFileSync 一份带时间戳的备份却不清理，
// 结果单是 .bak-dsh-* 就攒了几十份。这里把「备份 + 只保留最近 N 份」收成一处。
import fs from 'node:fs';
import path from 'node:path';

/** 每个 tag 保留的份数（按 tag 分桶，互不挤占）。 */
export const CONFIG_BACKUP_KEEP = 8;

export function configBackupPath(file, tag = 'cfg', now = new Date()) {
  const stamp = (now instanceof Date ? now : new Date(now)).toISOString().replace(/[:.]/g, '-');
  const base = `${file}.bak-${tag}-${stamp}`;
  // 同一毫秒内连写两次会撞名，copyFileSync 直接覆盖 → 前一份快照静默消失
  // （压测时表现为「只保留最近 keep 份」偶发少一份）。加序号后缀保证每份都留得住；
  // 后缀只会让同一时刻的备份排在原名之后，轮转顺序仍然稳定。
  let dest = base;
  for (let i = 2; fs.existsSync(dest); i += 1) dest = `${base}-${i}`;
  return dest;
}

/**
 * 复制一份快照并轮转。返回快照路径；源文件不存在或复制失败时返回 null（调用方照常继续）。
 * `now` 只给测试用（固定时钟），生产永远走真实时间。
 */
export function backupConfigFile(file, { tag = 'cfg', keep = CONFIG_BACKUP_KEEP, now = new Date() } = {}) {
  const dest = configBackupPath(file, tag, now);
  try {
    fs.copyFileSync(file, dest);
  } catch {
    return null;
  }
  pruneConfigBackups(file, { tag, keep });
  return dest;
}

/** 删除同 tag 的旧快照，只留最近 keep 份。返回被删的文件名。 */
export function pruneConfigBackups(file, { tag = 'cfg', keep = CONFIG_BACKUP_KEEP } = {}) {
  const dir = path.dirname(file);
  const prefix = `${path.basename(file)}.bak-${tag}-`;
  let names;
  try {
    names = fs.readdirSync(dir).filter((name) => name.startsWith(prefix));
  } catch {
    return [];
  }
  names.sort();
  const removed = names.slice(0, Math.max(0, names.length - keep));
  for (const name of removed) {
    try { fs.rmSync(path.join(dir, name), { force: true }); } catch {}
  }
  return removed;
}
