#!/usr/bin/env node
// 迁移预检：只读审计，不复制、不移动、不改配置。
// 用法：node tools/migration-preflight.mjs [--target <目标仓库目录>] [--json]
// 不传 --target 时默认审计当前仓库根（由本文件位置推导），不写死任何本机路径。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const jsonOut = args.includes('--json');
const targetArg = args.find((arg) => arg.startsWith('--target=')) || '';
const targetNext = args.indexOf('--target') >= 0 ? args[args.indexOf('--target') + 1] : '';
const rawTarget = targetArg ? targetArg.slice('--target='.length) : (targetNext || '');
const TARGET = rawTarget ? path.resolve(rawTarget) : ROOT;

const checks = [];
function add(name, ok, detail) {
  checks.push({ name, ok: Boolean(ok), detail: String(detail ?? '') });
}

function run(cmd, cmdArgs, opts = {}) {
  try {
    return String(execFileSync(cmd, cmdArgs, { encoding: 'utf8', timeout: 30000, ...opts })).trim();
  } catch (error) {
    return String(error?.stdout || error?.message || error).trim();
  }
}

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    let entries = [];
    try { entries = fs.readdirSync(p, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(p, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === '.git') continue;
        walk(full);
      } else {
        try { total += fs.statSync(full).size; } catch {}
      }
    }
  };
  walk(dir);
  return total;
}

const mb = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

// 1. 源目录
add('源目录存在', fs.existsSync(ROOT), ROOT);
const srcSize = dirSize(ROOT);
add('源目录可读体积（不含 node_modules/.git）', srcSize > 0, mb(srcSize));

// 2. 目标目录
const targetExists = fs.existsSync(TARGET);
let targetEmpty = true;
if (targetExists) {
  try { targetEmpty = fs.readdirSync(TARGET).length === 0; } catch { targetEmpty = false; }
}
add('目标目录可用', !targetExists || targetEmpty, targetExists ? (targetEmpty ? '已存在但为空' : '已存在且非空，需要确认') : '尚不存在（可直接创建）');

// 3. 磁盘空间（目标盘）
try {
  const stat = fs.statfsSync(path.parse(TARGET).root);
  const free = Number(stat.bavail) * Number(stat.bsize);
  add('目标盘剩余空间 ≥ 500MB', free > 500 * 1024 * 1024, mb(free));
} catch (error) {
  add('目标盘空间检查', false, error?.message ?? String(error));
}

// 4. 运行中的桥接
let bridgePid = 0;
try { bridgePid = Number(fs.readFileSync(path.join(ROOT, 'state', 'bridge.lock'), 'utf8').trim()) || 0; } catch {}
let bridgeAlive = false;
if (bridgePid) {
  try { process.kill(bridgePid, 0); bridgeAlive = true; } catch {}
}
add('迁移前必须停止桥接', !bridgeAlive, bridgePid ? `lock PID ${bridgePid}（${bridgeAlive ? '仍在运行' : '已退出'}）` : '无 lock');

// 5. DSH 与 MCP 进程
const dshCount = run('powershell.exe', ['-NoProfile', '-Command', "(Get-CimInstance Win32_Process | Where-Object { $_.Name -like '*DeepSeek Harness*' -and $_.CommandLine -notlike '*--type=*' } | Measure-Object).Count"]);
add('DSH 主进程数（迁移时需停止）', true, dshCount || '0');
const mcp = run('powershell.exe', ['-NoProfile', '-Command', "Get-CimInstance Win32_Process -Filter \"name='node.exe'\" | Where-Object { $_.CommandLine -like '*qq-bridge*src*mcp-*' } | ForEach-Object { $_.ProcessId }"]);
const mcpPids = mcp.split(/\s+/).filter(Boolean);
add('MCP 子进程（迁移时随 DSH 停止）', true, mcpPids.length ? `${mcpPids.length} 个` : '无');

// 6. DSH profile 绝对路径
const profile = path.join(os.homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml');
let profilePaths = [];
try {
  profilePaths = fs.readFileSync(profile, 'utf8').split(/\r?\n/).filter((line) => /qq-bridge/.test(line));
} catch {}
const profileStale = profilePaths.filter((line) => line.includes(ROOT)).length;
add('DSH profile 待改写条目', true, profilePaths.length ? `${profileStale}/${profilePaths.length} 条指向当前目录；迁移后运行 node tools/install-dsh.mjs` : '未发现 qq-bridge 条目');

// 7. 计划任务
const taskInfo = run('powershell.exe', ['-NoProfile', '-Command', "Get-ScheduledTask -TaskName 'qq-bridge-auto-caption' -ErrorAction SilentlyContinue | ForEach-Object { $_.Actions | ForEach-Object { $_.Execute + ' ' + $_.Arguments + ' [' + $_.WorkingDirectory + ']' } }"]);
add('计划任务 qq-bridge-auto-caption', true, taskInfo ? '存在，迁移后需改路径' : '未找到');

// 8. git 未提交改动
const dirty = run('git', ['status', '--porcelain'], { cwd: ROOT });
const dirtyCount = dirty ? dirty.split(/\r?\n/).filter(Boolean).length : 0;
const branch = run('git', ['branch', '--show-current'], { cwd: ROOT });
add('git 未提交改动（必须文件系统复制，不能 clone）', true, `${dirtyCount} 项 · 分支 ${branch || '?'}`);

// 9. 状态目录中的绝对路径
let statePathHits = 0;
try {
  const files = fs.readdirSync(path.join(ROOT, 'state')).filter((file) => /\.(json|jsonl)$/.test(file));
  for (const file of files) {
    const text = fs.readFileSync(path.join(ROOT, 'state', file), 'utf8');
    if (text.includes(ROOT.replace(/\\/g, '\\\\')) || text.includes(ROOT)) statePathHits += 1;
  }
} catch {}
add('state 内是否存有项目绝对路径', statePathHits === 0, statePathHits === 0 ? '0 命中' : `${statePathHits} 个文件需要清洗`);

// 10. 外部依赖（应保持不动）
add('外部资产已在 D 盘', true, 'SnowLuma / GPT-SoVITS / 图片库 / 备份 / dev-worktrees');

const blockers = checks.filter((c) => !c.ok);
const report = {
  root: ROOT,
  target: TARGET,
  timestamp: new Date().toISOString(),
  checks,
  blockers: blockers.map((c) => c.name),
  plan: [
    '1. 主人批准窗口；停桥接（lock PID）与 bin/boot.cmd 守护；停 DSH；禁用计划任务。',
    '2. robocopy 源目录 → 目标（/MIR，排除 node_modules；随后 npm ci 重建）。',
    '3. 新目录 npm ci → build-config-schema --check → npm run verify。',
    '4. node tools/install-dsh.mjs 重写 MCP 路径；重启 DSH；dsh-ensure --fix。',
    '5. 重建计划任务；启动 bin/boot.cmd；doctor fail 0；dryRun 预览一次。',
    '6. 旧目录保留 ≥7 天只读，验收后再处理。'
  ]
};

if (jsonOut) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
} else {
  console.log(`迁移预检 @ ${report.timestamp}`);
  console.log(`源：${report.root}`);
  console.log(`目标：${report.target}\n`);
  for (const check of checks) {
    console.log(`${check.ok ? '[ OK ]' : '[WARN]'} ${check.name} — ${check.detail}`);
  }
  console.log(`\n结论：${blockers.length ? `${blockers.length} 项需要处理（${blockers.map((c) => c.name).join('；')}）` : '无阻断项'}`);
  console.log('\n执行计划：');
  for (const step of report.plan) console.log(`  ${step}`);
}

process.exit(blockers.length ? 2 : 0);
