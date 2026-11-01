// config.json 的唯一写入口：备份策略 + 原子写 + 失败语义集中在一处。
//
// 背景：桥接里曾有 20 处各自 `atomicWriteJson(configFile, ...)`，其中只有 4 处带备份，
// 于是「改一次配置丢一次历史」是常态；备份策略也没人说得清（有的每次备份、
// 有的从不备份）。这里把规则写成代码，调用点只声明「这次写属于哪类操作」。
//
// 策略：
//   - 普通写：同一 tag 每个自然日最多留一份快照（跨天第一写、重启后第一写都会触发）；
//   - 危险写（改白名单/管理员/控制台令牌/删模块）：每次都备份，且备份失败就**拒绝写入**；
//   - 普通写备份失败只记日志，不阻断（磁盘问题的正确暴露点是写入本身）；
//   - 写入前校验目标必须是普通对象，避免把整份 config 覆盖成 null/数组。
import fs from 'node:fs';
import path from 'node:path';
import { backupConfigFile } from './config-backup.js';

function utcDay(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

/**
 * @param {object} options
 * @param {string} options.configFile  config.json 绝对路径
 * @param {(file: string, obj: object) => void} options.write  原子写实现（由调用方注入，便于测试）
 * @param {() => Date} [options.now]
 * @param {(...args: any[]) => void} [options.log]
 */
export function createConfigWriter({ configFile, write, now = () => new Date(), log = () => {} }) {
  if (!configFile) throw new Error('createConfigWriter 需要 configFile');
  if (typeof write !== 'function') throw new Error('createConfigWriter 需要 write 函数');

  function hasBackupForDay(tag, day) {
    try {
      const prefix = `${path.basename(configFile)}.bak-${tag}-${day}`;
      return fs.readdirSync(path.dirname(configFile)).some((name) => name.startsWith(prefix));
    } catch {
      return false;
    }
  }

  /**
   * 写 config.json。
   * @param {object} next 完整配置文件内容
   * @param {{tag?: string, danger?: boolean}} [options]
   */
  function writeConfig(next, { tag = 'console', danger = false } = {}) {
    if (!next || typeof next !== 'object' || Array.isArray(next)) {
      throw new Error('配置写入被拒绝：目标不是普通对象');
    }
    const day = utcDay(now());
    const at = now();
    let backedUp = false;
    if (danger || !hasBackupForDay(tag, day)) {
      // backupConfigFile 失败时返回 null（而不是抛错），所以这里必须看返回值。
      const dest = backupConfigFile(configFile, { tag, now: at });
      if (!dest) {
        if (danger) {
          // 危险操作没有快照就等于没有回滚点，宁可失败也不写。
          throw new Error(`配置备份失败，已拒绝写入（${tag}）`);
        }
        log(`⚠️ 配置备份失败（${tag}），本次继续写入`);
      } else {
        backedUp = true;
      }
    }
    write(configFile, next);
    return { ok: true, tag, backedUp };
  }

  return { write: writeConfig, configFile, path: configFile };
}
