// state/*.json 的原子读写：**唯一**实现。
//
// 之前 bridge + 7 个 core 模块各抄了一份「写 tmp → rename → 失败就删目标再 rename」。
// 其中「删目标再 rename」最危险：第二次 rename 再失败时，旧文件已删除、新文件还在 tmp，
// 等于数据丢了。这里统一成桥接原本的实现——只重试 rename（Windows 上 EPERM 常来自
// Defender/编辑器拿着句柄），绝不先删目标。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

/**
 * 原子替换：Windows 上 rename 覆盖一个「正被打开」的目标会抛 EPERM/EBUSY/EACCES，
 * 退避重试；其它错误直接抛。目标文件在任何时刻都是完整的旧版或新版。
 */
export function renameWithRetry(from, to, attempts = 4) {
  let lastError;
  for (let i = 0; i < attempts; i += 1) {
    try {
      fs.renameSync(from, to);
      return;
    } catch (error) {
      lastError = error;
      if (error?.code !== 'EPERM' && error?.code !== 'EBUSY' && error?.code !== 'EACCES') throw error;
      // 同步忙等：调用点大多在启动/收尾路径，不值得为它改成异步。
      try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 40 * (i + 1)); } catch {}
    }
  }
  throw lastError;
}

function tempName(file) {
  return `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
}

/** 原子写 JSON（2 空格缩进 + 结尾换行，便于 diff）。失败时清掉临时文件再抛。 */
export function atomicWriteJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  try {
    fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

/** 原子写文本。失败时清掉临时文件再抛。 */
export function atomicWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = tempName(file);
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf8', mode: 0o600 });
    renameWithRetry(tmp, file);
  } catch (error) {
    try { fs.unlinkSync(tmp); } catch {}
    throw error;
  }
}

/**
 * 读 JSON 并容错：Windows 下常见 UTF-8 BOM（\uFEFF）会令 JSON.parse 失败。
 * required=true 时文件缺失或解析失败直接抛错（用于启动必需配置，fail-fast）。
 */
export function readJsonSafe(file, fallback, required = false) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch (error) {
    if (required) throw new Error(`配置文件读取/解析失败：${file}（${error?.message ?? error}）`);
    return fallback;
  }
}
