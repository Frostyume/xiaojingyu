// 启动时确保远程语音主机（Breeze/Opus）的 SSH 隧道在线；已在跑就不动它。
// 隧道是 ad-hoc ssh 转发，重启后不会自己回来；语音要它才能用。
// 远程主机通过环境变量 BREEZE_SSH_HOST 指定（未设置则跳过，不做任何连接）。
// 旧隧道会僵死（本地端口仍 LISTENING，但 SSH 传输已断），必须按端口找到并先杀掉，否则新 ssh 绑定失败、自愈永久失效。
// 跳板链路会间歇性在 banner 阶段超时，所以单次失败不放弃：用 `ssh -f` 后台化并重试几次。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';

const root = path.resolve(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
let cfg = {};
try {
  cfg = JSON.parse(fs.readFileSync(path.join(root, 'config.json'), 'utf8'));
} catch {
  process.exit(0);
}
const breeze = cfg?.tts?.breeze;
if (!breeze || breeze.enabled === false) process.exit(0);

const base = String(breeze.baseUrl || '').trim();
const opus = String(breeze.opusUrl || '').trim();
if (!base) process.exit(0);
const urls = [base, opus].filter(Boolean);
const sshHost = String(process.env.BREEZE_SSH_HOST || '').trim();
if (!sshHost) {
  console.log('[breeze] 未设置 BREEZE_SSH_HOST，跳过隧道自愈');
  process.exit(0);
}
const remoteHost = '127.0.0.1';

const localPort = (u) => Number(new URL(u).port) || 80;
const forwards = [base, opus].filter(Boolean).map((u) => {
  const port = localPort(u);
  // 17861 -> 7861, 17862 -> 7862（约定：本地端口 = 远程端口 + 10000）
  return { local: port, remote: port >= 10000 ? port - 10000 : port };
});
const ports = forwards.map((f) => f.local);

const HEALTH_TIMEOUT_MS = 20000;
const ATTEMPTS = 5;
const ATTEMPT_WAIT_MS = 30000;

const logDir = path.join(root, 'state', 'logs');
fs.mkdirSync(logDir, { recursive: true });
const logFile = path.join(logDir, 'breeze-tunnel.log');
const pidFile = path.join(logDir, 'breeze-tunnel.pid');
const lockFile = path.join(logDir, 'breeze-tunnel.lock');
const fileLog = (msg) => {
  try {
    fs.appendFileSync(logFile, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
};

async function alive(url, timeoutMs = HEALTH_TIMEOUT_MS) {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok;
  } catch {
    return false;
  }
}

function listenerPids() {
  if (process.platform !== 'win32') return [];
  try {
    const out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8', windowsHide: true });
    const pids = new Set();
    for (const line of out.split(/\r?\n/)) {
      const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
      if (m && ports.includes(Number(m[1]))) pids.add(Number(m[2]));
    }
    return [...pids];
  } catch {
    return [];
  }
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isOurTunnel(pid) {
  try {
    const out = execFileSync('powershell', [
      '-NoProfile',
      '-Command',
      `(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CommandLine`
    ], { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    return /ssh/i.test(out) && out.includes(`-L ${ports[0]}:`);
  } catch {
    return false;
  }
}

function killPid(pid) {
  if (process.platform === 'win32') {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true });
  } else {
    process.kill(pid, 'SIGTERM');
  }
}

const readPidFile = () => {
  try {
    return Number(fs.readFileSync(pidFile, 'utf8').trim()) || 0;
  } catch {
    return 0;
  }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function clearStale() {
  const recorded = readPidFile();
  const targets = new Set(listenerPids());
  if (recorded && pidAlive(recorded) && isOurTunnel(recorded)) targets.add(recorded);
  for (const pid of targets) {
    if (pid !== recorded && !isOurTunnel(pid)) {
      fileLog(`port ${ports.join('/')} held by foreign pid ${pid}; not killing`);
      console.log(`[breeze] 端口被其它进程占用（pid ${pid}），不自动终止`);
      return false;
    }
    try {
      killPid(pid);
      fileLog(`killed stale tunnel pid ${pid}`);
      console.log(`[breeze] 已终止僵死隧道 pid ${pid}`);
    } catch (error) {
      fileLog(`kill pid ${pid} failed: ${error?.message ?? error}`);
    }
  }
  if (targets.size) {
    for (let i = 0; i < 10; i += 1) {
      await sleep(1000);
      if (listenerPids().length === 0) break;
    }
  }
  return true;
}

async function attempt() {
  const args = [
    '-f', '-N',
    '-o', 'BatchMode=yes',
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ConnectTimeout=25',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3'
  ];
  for (const f of forwards) args.push('-L', `${f.local}:${remoteHost}:${f.remote}`);
  args.push(sshHost);
  const result = await new Promise((resolve) => {
    const child = spawn('ssh', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (error) => resolve({ code: -1, err: error?.message ?? String(error) }));
    child.on('exit', (code) => resolve({ code, err: err.trim().split(/\r?\n/).slice(-2).join(' | '), out }));
  });
  if (result.code !== 0) {
    fileLog(`ssh attempt failed exit=${result.code} ${result.err}`);
    return false;
  }
  const deadline = Date.now() + ATTEMPT_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(2000);
    if ((await Promise.all(urls.map((u) => alive(u, 8000)))).every(Boolean)) return true;
  }
  fileLog('ssh -f exited 0 but health still failing');
  return false;
}

// 同一时刻只允许一个重建实例，否则两个脚本会互相杀掉对方刚建立的隧道。
try {
  const raw = fs.readFileSync(lockFile, 'utf8').trim().split(/\s+/);
  const otherPid = Number(raw[0]);
  const otherAt = Number(raw[1]);
  if (otherPid && otherPid !== process.pid && pidAlive(otherPid) && Date.now() - otherAt < 10 * 60 * 1000) {
    console.log(`[breeze] 已有重建实例在跑（pid ${otherPid}），跳过`);
    process.exit(0);
  }
} catch {}
fs.writeFileSync(lockFile, `${process.pid} ${Date.now()}`);
const releaseLock = () => {
  try {
    if (Number(fs.readFileSync(lockFile, 'utf8').trim().split(/\s+/)[0]) === process.pid) fs.rmSync(lockFile, { force: true });
  } catch {}
};
process.on('exit', releaseLock);

// 慢链路上首个请求要 10–17 秒，单次探测超时不代表隧道坏了。
let online = false;
for (let round = 1; round <= 2 && !online; round += 1) {
  online = (await Promise.all(urls.map((u) => alive(u)))).every(Boolean);
}
if (online) {
  console.log('[breeze] 隧道在线');
  fileLog('tunnel already online, nothing to do');
  process.exit(0);
}

if (!(await clearStale())) process.exit(1);
try {
  fs.rmSync(pidFile, { force: true });
} catch {}

for (let i = 1; i <= ATTEMPTS; i += 1) {
  fileLog(`attempt ${i}/${ATTEMPTS}: starting ssh -f -N -L ${forwards.map((f) => `${f.local}:${remoteHost}:${f.remote}`).join(' -L ')} ${sshHost}`);
  console.log(`[breeze] 第 ${i}/${ATTEMPTS} 次重建隧道…`);
  if (await attempt()) {
    const pid = listenerPids()[0] || 0;
    if (pid) fs.writeFileSync(pidFile, String(pid));
    console.log('[breeze] 隧道已建立');
    fileLog(`tunnel established (listener pid ${pid || '?'})`);
    process.exit(0);
  }
  if (i < ATTEMPTS) await sleep(3000);
}

console.log(`[breeze] 隧道未建立，请手动运行：ssh -N ${forwards.map((f) => `-L ${f.local}:127.0.0.1:${f.remote}`).join(' ')} ${sshHost}`);
fileLog(`tunnel not established after ${ATTEMPTS} attempts`);
process.exit(1);
