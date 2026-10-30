#!/usr/bin/env node
// 一条命令定位常见故障：
//   node scripts/doctor.mjs           # 人类可读
//   node scripts/doctor.mjs --json    # 机器可读（CI/控制台）
//   node scripts/doctor.mjs --fix-dsh-port   # 把 config.json 的 dsh.baseUrl 改成当前监听的 DSH 端口
//   node scripts/doctor.mjs --fix-config     # 把配置版本迁移结果写回 config.json（自动备份）
//
// 约束：
//   · 只读检查为主；--fix-* 必须显式给出；
//   · 不打印任何令牌/QQ 号/群号，密钥只报告「已配置/未配置」；
//   · 不启动/停止 SnowLuma（EULA），只探测进程与端口。

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  parseNetstatListens, parseProcessList, isDshProcess, isSnowLumaProcess,
  listeningPortsOf, probeDshPorts, checkTcp, parseUrlSafe, tailLines,
  classifyLogLines, deepMerge, freeDiskSpace, pidAlive
} from '../src/core/health.js';
import { validateConfigObject, migrateConfigObject, CONFIG_VERSION } from '../src/core/config-schema.js';
import { backupConfigFile } from '../src/core/config-backup.js';
import { SCHEMA_VERSION } from '../src/core/db.js';
import { sessionFileFor, wakeStatus } from '../src/core/controller-cli.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const STATE_DIR = path.join(ROOT, 'state');
const CONFIG_FILE = path.join(ROOT, 'config.json');
const args = new Set(process.argv.slice(2));
const JSON_OUT = args.has('--json');
const FIX_DSH_PORT = args.has('--fix-dsh-port');
const FIX_CONFIG = args.has('--fix-config');

const checks = [];
function add(id, status, title, detail, data) {
  checks.push({ id, status, title, detail, ...(data ? { data } : {}) });
  if (!JSON_OUT) {
    const tag = status === 'ok' ? '[ OK ]' : status === 'warn' ? '[WARN]' : '[FAIL]';
    console.log(`${tag} ${title}${detail ? ` — ${detail}` : ''}`);
  }
}

function readJson(file, fallback = null) {
  try {
    const raw = fs.readFileSync(file, 'utf8');
    return JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw);
  } catch { return fallback; }
}

function run(cmd, argv, timeout = 8000) {
  try {
    return execFileSync(cmd, argv, { encoding: 'utf8', timeout, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return ''; }
}

function atomicWriteJson(file, obj) {
  const tmp = `${file}.doctor-${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(obj, null, 2)}\n`, 'utf8');
  fs.renameSync(tmp, file);
}

function backupConfig() {
  return backupConfigFile(CONFIG_FILE, { tag: 'doctor' });
}

function writableDir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.doctor-write-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    return true;
  } catch { return false; }
}

function isIgnored(pattern) {
  try {
    const text = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    return text.split(/\r?\n/).some((line) => line.trim().replace(/^\/+/, '') === pattern);
  } catch { return false; }
}

function parseDshUrlBase(url) {
  const u = parseUrlSafe(url);
  if (!u) return null;
  return u;
}

function fmtBytes(n) {
  if (!Number.isFinite(n)) return '?';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v.toFixed(1)}${units[i]}`;
}

async function main() {
  // ── 运行时 ────────────────────────────────────────────────────────────────
  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > 22 || (major === 22 && minor >= 13);
  add('runtime.node', nodeOk ? 'ok' : 'fail', 'Node 版本', `v${process.versions.node}（要求 >=22.13）`);
  try {
    const sqlite = await import('node:sqlite');
    add('runtime.sqlite', sqlite.DatabaseSync ? 'ok' : 'fail', 'node:sqlite', 'DatabaseSync 可用（实验 API）');
  } catch (error) {
    add('runtime.sqlite', 'fail', 'node:sqlite', `不可用：${error?.message ?? error}`);
  }

  // ── 配置 ──────────────────────────────────────────────────────────────────
  const rawConfig = readJson(CONFIG_FILE, null);
  if (!rawConfig || typeof rawConfig !== 'object') {
    add('config.parse', 'fail', 'config.json', '缺失或不是 JSON 对象（复制 config.example.json 后填写）');
  } else {
    add('config.parse', 'ok', 'config.json', '可解析');
    const migrated = migrateConfigObject(rawConfig);
    add('config.version', migrated.changed ? 'warn' : 'ok', '配置版本',
      migrated.changed ? `v${migrated.from} → v${CONFIG_VERSION}：${migrated.notes.join('；')}（可 --fix-config 落盘）` : `v${CONFIG_VERSION}`);
    const example = readJson(path.join(ROOT, 'config.example.json'), {});
    const expected = deepMerge(example, {
      storage: rawConfig.storage ?? migrateConfigObject({}).config.storage
    });
    const validation = validateConfigObject(expected, rawConfig);
    add('config.validation', validation.errors.length ? 'fail' : 'ok', '配置校验',
      validation.errors.length ? validation.errors.slice(0, 6).join('；') : '类型/范围正常',
      { errors: validation.errors.slice(0, 50), unknown: validation.unknown.slice(0, 50) });
    // 按群 profile / 自定义价目表 / 分享模块实例都是运行期动态键（模板里只有空对象），
    // 不该要求出现在 config.example.json 里。
    const dynamicUnknown = validation.unknown.filter((key) => /^socialV2\.groupProfiles\./.test(key) || /^pricing\.models\./.test(key) || /^socialV2\.shareModules\.modules\./.test(key));
    const templateUnknown = validation.unknown.filter((key) => !dynamicUnknown.includes(key));
    if (templateUnknown.length) {
      add('config.schema-coverage', 'warn', '配置项覆盖率',
        `${templateUnknown.length} 个键不在 config.example.json 里（新增功能段属于正常，但建议补模板）：${templateUnknown.slice(0, 8).join(', ')}${templateUnknown.length > 8 ? '…' : ''}`);
    }
  }
  const cfg = rawConfig ?? {};
  const stateWritable = writableDir(STATE_DIR);
  add('state.writable', stateWritable ? 'ok' : 'fail', 'state/ 可写', stateWritable ? '正常' : '无法写入（ACL/磁盘/只读）');

  // ── 存储 / 队列 ────────────────────────────────────────────────────────────
  const dbPath = path.resolve(ROOT, cfg.storage?.dbPath ?? 'state/db/bridge.db');
  if (fs.existsSync(dbPath)) {
    try {
      const { openDatabase } = await import('../src/core/db.js');
      const db = openDatabase({ file: dbPath, readonly: true, logger: () => {} });
      const outboxRows = db.all('SELECT state, COUNT(*) AS n FROM outbox GROUP BY state');
      const byState = Object.fromEntries(outboxRows.map((r) => [r.state, Number(r.n)]));
      const jobsRows = db.all('SELECT state, COUNT(*) AS n FROM jobs GROUP BY state');
      const jobs = Object.fromEntries(jobsRows.map((r) => [r.state, Number(r.n)]));
      const inbox = Number(db.get("SELECT COUNT(*) AS n FROM events WHERE direction='in' AND processed_at IS NULL")?.n ?? 0);
      const version = Number(db.get('SELECT MAX(version) AS v FROM schema_migrations')?.v ?? 0);
      db.close();
      const stat = fs.statSync(dbPath);
      add('db.open', version > 0 ? 'ok' : 'fail', 'SQLite', `v${version}，${fmtBytes(stat.size)}`);
      add('db.migrations', version === SCHEMA_VERSION ? 'ok' : 'warn', 'SQLite 迁移', `已应用 v${version}（期望 v${SCHEMA_VERSION}）`);
      add('outbox', (byState.uncertain || byState.dead) ? 'warn' : 'ok', '出站队列',
        `pending=${byState.pending ?? 0} sent=${byState.sent ?? 0} uncertain=${byState.uncertain ?? 0} dead=${byState.dead ?? 0}`,
        { byState });
      add('jobs', (jobs.dead ?? 0) > 0 ? 'warn' : 'ok', '任务队列',
        `pending=${jobs.pending ?? 0} running=${jobs.running ?? 0} dead=${jobs.dead ?? 0}`, { byState: jobs });
      add('inbox', inbox > 50 ? 'warn' : 'ok', '入站队列', `未处理=${inbox}`);
    } catch (error) {
      add('db.open', 'fail', 'SQLite', `打不开：${error?.message ?? error}`);
    }
  } else {
    add('db.open', 'ok', 'SQLite', `尚未创建（首次启动会自动建库：${path.relative(ROOT, dbPath)}）`);
  }

  // ── DSH ──────────────────────────────────────────────────────────────────
  const listens = parseNetstatListens(run('netstat', ['-ano', '-p', 'TCP']));
  const procJson = process.platform === 'win32'
    ? run('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -match 'dsh|deepseek|snowluma' } | Select-Object ProcessId,Name,@{n='Cmd';e={$_.CommandLine}} | ConvertTo-Json -Compress"])
    : '';
  const procs = parseProcessList(procJson);
  const dshProcs = procs.filter(isDshProcess);
  const snowProcs = procs.filter(isSnowLumaProcess);
  const dshProcessPorts = listeningPortsOf(dshProcs, listens);

  const dshUrl = parseDshUrlBase(cfg.dsh?.baseUrl);
  add('dsh.config', dshUrl ? 'ok' : 'fail', 'DSH 配置', dshUrl ? `baseUrl 端口 ${dshUrl.port}` : 'dsh.baseUrl 非法');
  add('dsh.process', dshProcs.length ? 'ok' : 'warn', 'DSH 进程', dshProcs.length ? `${dshProcs.length} 个相关进程` : '未检测到（DSH 可能没启动）');

  let discoveredDsh = [];
  if (dshProcessPorts.length) {
    const probes = await probeDshPorts(dshProcessPorts.filter((p) => !dshUrl || p !== Number(dshUrl.port)));
    discoveredDsh = probes.filter((p) => p.looksDsh).map((p) => p.port);
  }
  if (dshUrl) {
    const port = Number(dshUrl.port);
    const probe = await probeDshPorts([port]);
    const reachable = probe[0]?.status > 0;
    add('dsh.http', reachable ? 'ok' : 'fail', 'DSH HTTP', reachable
      ? `${dshUrl.host} 端口 ${port} 可达（HTTP ${probe[0].status}）`
      : `${dshUrl.host} 端口 ${port} 不可达；DSH 重启后端口会变`);
    if (!reachable && discoveredDsh.length) {
      add('dsh.port', 'warn', 'DSH 端口变化', `配置端口 ${port} 不通；当前像 DSH 的端口：${discoveredDsh.join(', ')}（--fix-dsh-port 可自动更新）`, { discovered: discoveredDsh });
    } else if (discoveredDsh.length) {
      add('dsh.port', 'warn', 'DSH 端口', `还发现其它像 DSH 的端口：${discoveredDsh.join(', ')}（多实例？）`, { discovered: discoveredDsh });
    } else {
      add('dsh.port', 'ok', 'DSH 端口', '与配置一致');
    }
  }

  if (FIX_DSH_PORT) {
    const target = discoveredDsh[0];
    if (!target) {
      add('dsh.fix', 'fail', '修正 DSH 端口', '没有发现可用的 DSH 端口，未修改 config.json');
    } else {
      try {
        const backup = backupConfig();
        const file = readJson(CONFIG_FILE, {});
        file.dsh = { ...(file.dsh ?? {}), baseUrl: `http://127.0.0.1:${target}` };
        atomicWriteJson(CONFIG_FILE, file);
        add('dsh.fix', 'ok', '修正 DSH 端口', `dsh.baseUrl → 端口 ${target}；备份 ${path.basename(backup)}；需重启桥接生效`);
      } catch (error) {
        add('dsh.fix', 'fail', '修正 DSH 端口', error?.message ?? String(error));
      }
    }
  }

  // ── SnowLuma ─────────────────────────────────────────────────────────────
  // 进程名不一定叫 SnowLuma（Electron/容器/嵌入运行时都可能）；端口通就以端口为准。
  const ws = parseUrlSafe(cfg.snowluma?.wsUrl);
  const http = parseUrlSafe(cfg.snowluma?.httpUrl);
  if (ws && http) {
    const [tcpWs, tcpHttp] = await Promise.all([
      checkTcp(ws.hostname, Number(ws.port) || 80),
      checkTcp(http.hostname, Number(http.port) || 80)
    ]);
    const reachable = tcpWs.ok || tcpHttp.ok;
    add('snowluma.process', (snowProcs.length || reachable) ? 'ok' : 'warn', 'SnowLuma 进程',
      snowProcs.length
        ? `${snowProcs.length} 个相关进程`
        : (reachable ? '进程名未匹配，但 OneBot 端口可连（以端口为准；不会自动启动）' : '未检测到（不会自动启动，请手动打开）'));
    add('snowluma.ws', tcpWs.ok ? 'ok' : 'warn', 'SnowLuma WS', tcpWs.ok ? `端口 ${ws.port} 可连` : `端口 ${ws.port} 不可连（${tcpWs.error}）`);
    add('snowluma.http', tcpHttp.ok ? 'ok' : 'warn', 'SnowLuma HTTP', tcpHttp.ok ? `端口 ${http.port} 可连` : `端口 ${http.port} 不可连（${tcpHttp.error}）`);
  } else {
    add('snowluma.config', 'fail', 'SnowLuma 配置', 'wsUrl/httpUrl 非法');
  }

  // ── 桥接 / 控制台 ─────────────────────────────────────────────────────────
  const lockPid = Number(String(fs.existsSync(path.join(STATE_DIR, 'bridge.lock'))
    ? fs.readFileSync(path.join(STATE_DIR, 'bridge.lock'), 'utf8').trim() : '0')) || 0;
  const alive = pidAlive(lockPid);
  add('bridge.process', alive ? 'ok' : 'warn', '桥接进程', alive ? `运行中（PID ${lockPid}）` : '未运行 / 锁文件不存在');
  const consolePort = Number(cfg.consolePort) || 3100;
  const consoleListening = listens.some((l) => l.port === consolePort && /^(127\.0\.0\.1|0\.0\.0\.0|::)$/.test(l.addr));
  add('bridge.port', consoleListening ? 'ok' : 'warn', '控制台端口', consoleListening ? `${consolePort} LISTENING` : `${consolePort} 未监听`);

  let token = String(cfg.consoleToken ?? '').trim();
  if (!token) {
    try { token = fs.readFileSync(path.join(STATE_DIR, 'console-token'), 'utf8').trim(); } catch {}
  }
  if (consoleListening && token) {
    try {
      const res = await fetch(`http://127.0.0.1:${consolePort}/api/status`, {
        headers: { 'x-console-token': token }, signal: AbortSignal.timeout(2500)
      });
      const body = await res.json().catch(() => ({}));
      add('bridge.api', res.ok ? 'ok' : 'fail', '控制台 API', res.ok ? '鉴权与响应正常' : `HTTP ${res.status}`);
      if (res.ok && body) {
        add('bridge.mode', 'ok', '当前模式', `${body.mode ?? '?'}；角色 ${body.role || '无'}（${body.roleMode ?? '?'}）`);
        const groups = Array.isArray(body.allowGroups) ? body.allowGroups.length : 0;
        const privates = Array.isArray(body.allowPrivate) ? body.allowPrivate.length : 0;
        add('qq.allow', groups + privates > 0 ? 'ok' : 'warn', '发送白名单', `群 ${groups} 个 / 私聊 ${privates} 个`);
        add('bridge.dsh', body.dshReady ? 'ok' : 'warn', 'DSH 就绪', body.dshReady ? '会话可用' : '桥接尚未连上 DSH');
        add('bridge.snowluma', body.snowluma?.connected ? 'ok' : 'warn', 'SnowLuma 链路',
          body.snowluma?.connected
            ? `已连接；good=${body.snowluma.good ?? '?'}；最近事件 ${Math.round(Number(body.snowluma.lastPacketAgoMs) || 0) / 1000}s 前`
            : '未连接（检查 SnowLuma 是否登录 / token 是否随账号变化）');
      }
    } catch (error) {
      add('bridge.api', 'fail', '控制台 API', String(error?.message ?? error));
    }
  } else {
    add('bridge.api', 'warn', '控制台 API', consoleListening ? '没有可用的控制台令牌' : '控制台未监听，跳过');
  }

  // ── 角色 / preset ─────────────────────────────────────────────────────────
  const roleState = readJson(path.join(STATE_DIR, 'current-role.json'), {});
  const roleName = roleState?.role ? String(roleState.role) : '';
  if (roleName) {
    const roleFile = path.join(ROOT, 'roles', `${roleName}.md`);
    add('role.card', fs.existsSync(roleFile) ? 'ok' : 'fail', '角色卡',
      fs.existsSync(roleFile) ? `${roleName} 存在（${roleState.mode ?? 'active'}）` : `${roleName} 文件缺失`);
  } else {
    add('role.card', 'ok', '角色卡', '未设置角色');
  }
  const presetName = cfg.socialV2?.agentPreset || cfg.agentPreset || 'qq-chat-v2';
  const presetSrc = path.join(ROOT, 'dsh', 'agent-presets', presetName, 'agent.cordis.yml');
  const presetPatch = path.join(ROOT, 'plugins', 'qq-agent-presets', 'presets', `${presetName}.patch.yml`);
  function presetInstallState(name) {
    const home = os.homedir();
    const bundle = path.join(home, '.dsh', 'plugins', 'qq-agent-presets');
    if (fs.existsSync(bundle)) {
      for (const profile of ['desktop', 'web', 'default']) {
        const pkg = readJson(path.join(home, '.dsh', 'profiles', profile, 'package.json'), null);
        const bundles = pkg?.dsh?.profile?.bundles ?? [];
        if (Array.isArray(bundles) && bundles.includes('qq-agent-presets')) return { ok: true, detail: `profile=${profile}` };
      }
    }
    // 0.1.5 旧机制（仅作兜底）
    if (fs.existsSync(path.join(home, '.dsh', '.agent-presets', name))) return { ok: true, detail: 'legacy 目录' };
    return { ok: false, detail: 'qq-agent-presets bundle 未注册（运行 node scripts/setup-dsh.mjs）' };
  }
  if (fs.existsSync(presetSrc)) {
    add('preset.source', 'ok', 'Preset 源文件', presetName);
    if (fs.existsSync(presetPatch)) {
      const srcTime = fs.statSync(presetSrc).mtimeMs;
      const patchTime = fs.statSync(presetPatch).mtimeMs;
      add('preset.patch', srcTime > patchTime + 1000 ? 'warn' : 'ok', 'Preset patch',
        srcTime > patchTime + 1000 ? '源文件比 patch 新，需要 node scripts/build-agent-preset-patches.mjs 并重启 DSH' : '已同步');
    } else {
      add('preset.patch', 'fail', 'Preset patch', `${path.relative(ROOT, presetPatch)} 不存在`);
    }
    const install = presetInstallState(presetName);
    add('preset.installed', install.ok ? 'ok' : 'warn', 'DSH 已安装 preset',
      install.ok ? `${presetName}（${install.detail}）` : install.detail);
  } else {
    add('preset.source', 'fail', 'Preset 源文件', `${path.relative(ROOT, presetSrc)} 缺失`);
  }

  // ── 日志 / 磁盘 / 隐私 ────────────────────────────────────────────────────
  const recentErrors = classifyLogLines(tailLines(path.join(STATE_DIR, 'bridge.log'), 300));
  add('logs.errors', recentErrors.length >= 5 ? 'warn' : 'ok', '最近日志错误',
    recentErrors.length ? `${recentErrors.length} 条可疑行（最近一条：${recentErrors.slice(-1)[0].slice(0, 160)}）` : '未发现明显错误',
    { errors: recentErrors });

  const disk = freeDiskSpace(ROOT);
  if (disk) {
    const freeGB = disk.free / 1024 ** 3;
    add('disk.free', freeGB < 2 ? 'warn' : 'ok', '磁盘余量', `${freeGB.toFixed(1)} GB 可用`);
  }
  // ── 事件唤醒链路：只报事实，不重跑唤醒 ────────────────────────────
  const orchDir = path.join(STATE_DIR, 'orchestrator');
  const controller = readJson(path.join(orchDir, 'controller.json'));
  if (!controller || controller.enabled === false) {
    add('wake.controller', 'warn', '事件唤醒目标', '未配置：事件只落计划与指派，不唤醒控制会话');
  } else {
    const wakeState = wakeStatus(orchDir);
    const outcome = wakeState.outcome;
    const hint = outcome === 'login' ? '（CLI 未登录）' : outcome === 'quota' ? '（CLI 额度用尽）' : outcome === 'interrupted' ? '（上次唤醒被重启打断）' : '';
    const blockedHint = wakeState.blocked
      ? `；阻塞 ${wakeState.blocked.outcome}（第 ${wakeState.blocked.strikes} 次），${wakeState.blocked.retryAt
        ? `最早 ${new Date(wakeState.blocked.retryAt).toLocaleString('zh-CN', { hour12: false })} 自动探测`
        : '需人工恢复'}`
      : '';
    const status = ['login', 'quota', 'error', 'spawn-error', 'sdk-env', 'stalled'].includes(outcome) ? 'warn' : 'ok';
    add('wake.controller', status, '事件唤醒目标', `上次结果 ${outcome || '未运行'}${hint}${blockedHint}`);
    const bound = sessionFileFor(String(controller.configDir || ''), String(controller.sessionId || ''));
    add('wake.session', bound ? 'ok' : 'warn', '唤醒会话绑定',
      bound ? '会话文件存在' : '控制器会话不在当前 edition 的 projects/ 里（切版后先跑 handoff）');
    const editionDir = String(controller.configDir || '');
    add('wake.edition', editionDir ? 'ok' : 'warn', '唤醒 edition',
      editionDir ? `固定 ${editionDir}` : '缺 configDir：CLI 会落到默认 edition（npm 全局包是国际版）');
  }
  const wake = readJson(path.join(orchDir, 'wake.request.json'));
  if (!wake) {
    add('wake.pending', 'ok', '待处理唤醒', '无（队列空闲）');
  } else {
    const pending = Array.isArray(wake.pending) ? wake.pending.length : 0;
    const ageMs = Date.now() - Number(wake.requestedAt || 0);
    const ageH = Math.max(0, Math.round(ageMs / 3600000));
    add('wake.pending', ageMs > 24 * 3600 * 1000 ? 'warn' : 'ok', '待处理唤醒',
      `${pending} 项，最早 ${ageH}h 前${ageMs > 24 * 3600 * 1000 ? '（长时间无人消费）' : ''}`);
  }

  const ignoredConfig = isIgnored('config.json');
  const ignoredState = isIgnored('state/') || isIgnored('state');
  add('privacy.gitignore', ignoredConfig && ignoredState ? 'ok' : 'fail', '.gitignore 隐私',
    ignoredConfig && ignoredState ? 'config.json 与 state/ 已排除' : 'config.json / state/ 未被忽略，禁止提交');

  if (FIX_CONFIG) {
    const migrated = migrateConfigObject(cfg);
    if (!migrated.changed) {
      add('config.fix', 'ok', '配置迁移', '无需修改');
    } else {
      try {
        const backup = backupConfig();
        atomicWriteJson(CONFIG_FILE, migrated.config);
        add('config.fix', 'ok', '配置迁移', `已写入 v${CONFIG_VERSION}；备份 ${path.basename(backup)}；需重启桥接`);
      } catch (error) {
        add('config.fix', 'fail', '配置迁移', error?.message ?? String(error));
      }
    }
  }

  const summary = {
    ok: checks.every((c) => c.status !== 'fail'),
    fail: checks.filter((c) => c.status === 'fail').length,
    warn: checks.filter((c) => c.status === 'warn').length,
    total: checks.length
  };
  if (JSON_OUT) {
    console.log(JSON.stringify({ generatedAt: new Date().toISOString(), summary, checks }, null, 2));
  } else {
    console.log(`\n${summary.ok ? '结论：没有硬故障' : '结论：存在硬故障'}（fail ${summary.fail} / warn ${summary.warn} / 共 ${summary.total} 项）`);
  }
  process.exitCode = summary.ok ? 0 : 1;
}

main().catch((error) => {
  console.error('[doctor] 运行失败:', error?.stack ?? error);
  process.exitCode = 1;
});
