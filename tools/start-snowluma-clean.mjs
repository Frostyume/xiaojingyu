#!/usr/bin/env node
// 用干净环境启动 SnowLuma：清掉代理变量再拉起 launcher。
//
// 为什么需要：SnowLuma 2.4 的 add_custom_face 用 Node fetch 上传图片，
// 而系统级 HTTP_PROXY 会把它带进 127.0.0.1 或非标准端口的请求，
// 表现为 `fetch failed`（GIF 收藏失败）。这个包装脚本只影响 SnowLuma 进程本身。
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy'];

function resolveLauncher() {
  const fromEnv = String(process.env.SNOWLUMA_LAUNCHER || '').trim();
  if (fromEnv) return fromEnv;
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const configured = String(cfg?.snowluma?.launcherPath || '').trim();
    if (configured) return configured;
    const homeDir = String(cfg?.snowluma?.homeDir || '').trim();
    if (homeDir) return path.join(homeDir, 'launcher.bat');
  } catch {}
  return '';
}

const launcher = resolveLauncher();
if (!launcher) {
  console.error('找不到 SnowLuma 启动脚本：请在 config.json 配置 snowluma.launcherPath（或 snowluma.homeDir），或设置 SNOWLUMA_LAUNCHER。');
  process.exit(1);
}
if (!fs.existsSync(launcher)) {
  console.error(`SnowLuma 启动脚本不存在：${launcher}`);
  process.exit(1);
}

const env = { ...process.env };
for (const key of PROXY_KEYS) delete env[key];
env.NO_PROXY = '*';
env.no_proxy = '*';

const child = spawn('cmd.exe', ['/c', launcher], {
  cwd: path.dirname(launcher),
  env,
  detached: true,
  stdio: 'ignore',
  windowsHide: false
});
child.unref();
console.log(`SnowLuma 已在无代理环境下启动：${launcher}（PID ${child.pid ?? 'unknown'}）`);
