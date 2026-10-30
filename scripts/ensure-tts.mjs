// 确保本地 GPT-SoVITS 服务在桥接启动时可用；端口已开时绝不重复启动。
// TTS 是独立进程，电脑重启后不会自己回来；这里只做“缺失才拉起”，不接管已有实例。

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
} catch {
  process.exit(0);
}
const tts = cfg?.tts && typeof cfg.tts === 'object' ? cfg.tts : {};
if (tts.enabled !== true || tts.autoStart === false) process.exit(0);

const base = String(tts.baseUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '');
async function alive() {
  try {
    const res = await fetch(`${base}/docs`, { signal: AbortSignal.timeout(2500) });
    return res.ok || res.status === 404; // 有些版本 /docs 404，但端口已经起来
  } catch {
    return false;
  }
}
if (await alive()) {
  console.log('[tts] 服务已在运行');
  process.exit(0);
}

const script = String(tts.startScript || process.env.TTS_START_SCRIPT || 'D:/AI/GPT-SoVITS/start-tts.bat');
if (!fs.existsSync(script)) {
  console.log(`[tts] 启动脚本不存在，跳过：${script}`);
  process.exit(0);
}
const logDir = path.join(root, 'state', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'tts-autostart.log');
const fd = fs.openSync(logFile, 'a');
fs.writeSync(fd, `\n[${new Date().toISOString()}] starting ${script}\n`);
try {
  const child = spawn('cmd.exe', ['/c', 'start', '', `"${script}"`], {
    cwd: path.dirname(script),
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();
  console.log(`[tts] 已拉起：${script}`);
} catch (error) {
  fs.writeSync(fd, `start failed: ${error?.message ?? error}\n`);
  console.log(`[tts] 启动失败：${error?.message ?? error}`);
} finally {
  fs.closeSync(fd);
}
