#!/usr/bin/env node
// DSH 生命周期外壳：
//   node scripts/dsh-ensure.mjs            # 只检查：DSH 进程/端口 vs config.dsh.baseUrl
//   node scripts/dsh-ensure.mjs --fix      # 端口变了就写回 config.json（自动备份）
//   node scripts/dsh-ensure.mjs --json     # 机器可读
//
// 不负责启动/停止 DSH（桌面应用由用户自己打开）；也不重启桥接。
// 写回后需要重启桥接才生效：node scripts/dsh-ensure.mjs --fix && <重启桥接>。

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseNetstatListens, parseProcessList, isDshProcess,
  listeningPortsOf, probeDshPorts, parseUrlSafe
} from '../src/core/health.js';
import { backupConfigFile } from '../src/core/config-backup.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const CONFIG_FILE = path.join(ROOT, 'config.json');
const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const FIX = args.has('--fix');

function run(cmd, argv, timeout = 8000) {
  try { return execFileSync(cmd, argv, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); }
  catch { return ''; }
}

function readJson(file) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch { return null; }
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.dsh-ensure.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

async function main() {
  const cfg = readJson(CONFIG_FILE);
  if (!cfg || typeof cfg !== 'object') {
    console.error('config.json 缺失或不可解析（先复制 config.example.json）');
    process.exitCode = 1;
    return;
  }
  const listens = parseNetstatListens(run('netstat', ['-ano', '-p', 'TCP']));
  const procJson = process.platform === 'win32'
    ? run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'dsh|deepseek' } | Select-Object ProcessId,Name,@{n='Cmd';e={$_.CommandLine}} | ConvertTo-Json -Compress"])
    : '';
  const procs = parseProcessList(procJson).filter(isDshProcess);
  const ports = listeningPortsOf(procs, listens);
  const probes = await probeDshPorts(ports);
  const candidates = probes.filter((p) => p.looksDsh).map((p) => p.port);
  const configured = parseUrlSafe(cfg.dsh?.baseUrl);
  const configuredPort = configured ? Number(configured.port) : 0;
  const reachable = configuredPort ? (await probeDshPorts([configuredPort]))[0]?.status > 0 : false;
  const target = candidates[0] || (reachable ? configuredPort : 0);

  let fixed = false;
  if (FIX && target && target !== configuredPort) {
    const backup = backupConfigFile(CONFIG_FILE, { tag: 'dsh' });
    if (!backup) throw new Error('备份 config.json 失败，已中止写回');
    cfg.dsh = { ...(cfg.dsh ?? {}), baseUrl: `http://127.0.0.1:${target}` };
    atomicWriteJson(CONFIG_FILE, cfg);
    fixed = true;
  }

  const result = {
    ok: Boolean(target),
    configuredPort: configuredPort || null,
    reachable,
    discoveredPorts: candidates,
    dshProcesses: procs.length,
    fixed,
    baseUrl: fixed ? `http://127.0.0.1:${target}` : (cfg.dsh?.baseUrl ?? null),
    note: target
      ? (fixed
        ? '已写回 config.json；重启桥接后生效'
        : (target !== configuredPort ? `当前 DSH 在端口 ${target}，配置仍是 ${configuredPort || '未设置'}；加 --fix 写回` : '端口一致'))
      : '未发现可达的 DSH 端口（DSH 是否启动？）'
  };
  if (JSON_OUT) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(`DSH 进程 ${result.dshProcesses} 个；配置端口 ${result.configuredPort ?? '?'}；发现 ${candidates.length ? candidates.join(', ') : '无'}`);
    console.log(result.note);
  }
  process.exitCode = result.ok ? 0 : 1;
}

main().catch((error) => {
  console.error('[dsh-ensure] 失败:', error?.message ?? error);
  process.exitCode = 1;
});
