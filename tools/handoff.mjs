#!/usr/bin/env node
// 交接快照：只读采集运行状态，生成 docs/orchestration/handoff/{latest.json,HANDOFF-RESUME.md}。
// 不发送 QQ 消息、不改运行状态、不 commit/push；输出不含 QQ 号、群号、token。
// 用法：node tools/handoff.mjs [--check|--dry-run] [--json] [--full] [--no-memory] [--quiet]

import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(BRIDGE_DIR, "..");
const DOCS_DIR = path.join(PROJECT_ROOT, "docs", "orchestration");
const OUT_DIR = path.join(DOCS_DIR, "handoff");
const LATEST_JSON = path.join(OUT_DIR, "latest.json");
const RESUME_MD = path.join(OUT_DIR, "HANDOFF-RESUME.md");
const STATE_DIR = path.join(BRIDGE_DIR, "state");

const DOC_FILES = [
  "00-PROJECT-OVERVIEW.md",
  "05-BASELINE.md",
  "06-HANDOFF-PROTOCOL.md",
  "10-PROGRESS.md",
  "20-LESSONS.md",
  "30-COLLABORATION.md",
  "40-TASK-BOARD.md",
  "50-ARCHITECTURE.md",
  "99-HANDOFF-PROMPT.md",
];

const SNAPSHOT_SCHEMA = 1;
const STALE_MS = 24 * 60 * 60 * 1000;
const STALE_SNAPSHOT_MS = 7 * 24 * 60 * 60 * 1000;

const argv = new Set(process.argv.slice(2));
const opts = {
  check: argv.has("--check"),
  dryRun: argv.has("--dry-run"),
  resume: argv.has("--resume"),
  json: argv.has("--json"),
  full: argv.has("--full"),
  noMemory: argv.has("--no-memory"),
  noController: argv.has("--no-controller"),
  quiet: argv.has("--quiet"),
  help: argv.has("--help") || argv.has("-h"),
};

if (opts.help) {
  console.log(`交接快照

  node tools/handoff.mjs [--resume]      采集 + 写 latest.json / HANDOFF-RESUME.md + 同步记忆指针
  node tools/handoff.mjs --check         只读自检，失败时退出码 1
  node tools/handoff.mjs --dry-run       只采集并打印，不写文件
  node tools/handoff.mjs --json          以 JSON 输出（可与上面任意参数组合）
  node tools/handoff.mjs --full          额外运行 doctor（约 10-30 秒）
  node tools/handoff.mjs --no-memory     跳过 .qoder / .qoder-cn 记忆指针同步
  node tools/handoff.mjs --no-controller 跳过 controller.json 的 edition 同步
`);
  process.exit(0);
}

function readText(file) {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

function readJson(file) {
  const text = readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function meta(file) {
  try {
    const st = fs.statSync(file);
    const buf = fs.readFileSync(file);
    return {
      path: path.relative(PROJECT_ROOT, file).replace(/\\/g, "/"),
      sha8: crypto.createHash("sha256").update(buf).digest("hex").slice(0, 8),
      bytes: st.size,
      mtime: new Date(st.mtimeMs).toISOString(),
    };
  } catch {
    return null;
  }
}

function fmtLocal(date = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  const off = -date.getTimezoneOffset();
  const sign = off >= 0 ? "+" : "-";
  const abs = Math.abs(off);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())} ` +
    `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

function isoNow() {
  return new Date().toISOString();
}

async function fetchJson(url, timeoutMs = 2500) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
    const json = await res.json();
    return { ok: res.ok, json };
  } catch (err) {
    return { ok: false, error: err?.message || String(err) };
  }
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function portOf(baseUrl) {
  try {
    const u = new URL(baseUrl);
    return Number(u.port) || (u.protocol === "https:" ? 443 : 80);
  } catch {
    return null;
  }
}

function git(args) {
  try {
    return execFileSync("git", args, {
      cwd: BRIDGE_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 15000,
    }).trim();
  } catch {
    return null;
  }
}

function readConfigSafe() {
  // 只取非敏感字段，避免任何 token/号码进入快照。
  const cfg = readJson(path.join(BRIDGE_DIR, "config.json")) || {};
  return {
    consolePort: cfg.consolePort || 3100,
    dshBaseUrl: cfg.dsh?.baseUrl || null,
    dshModel: cfg.dsh?.model || null,
  };
}

function readQueue() {
  const tasksDir = path.join(STATE_DIR, "orchestrator", "tasks");
  const items = [];
  const byStatus = {};
  if (fs.existsSync(tasksDir)) {
    for (const name of fs.readdirSync(tasksDir)) {
      if (!name.endsWith(".json")) continue;
      const task = readJson(path.join(tasksDir, name));
      if (!task) continue;
      const status = String(task.status || "unknown");
      byStatus[status] = (byStatus[status] || 0) + 1;
      items.push({ id: String(task.id || name.replace(/\.json$/, "")), status });
    }
  }
  const proposalDir = path.join(STATE_DIR, "dev-proposals");
  let proposals = 0;
  if (fs.existsSync(proposalDir)) {
    proposals = fs
      .readdirSync(proposalDir)
      .filter((f) => f.endsWith(".json") && !f.endsWith(".result.json")).length;
  }
  return { tasks: items.length, byStatus, items, proposals };
}

function parseBoard(markdown) {
  const result = { active: [], waiting: [] };
  let current = null;
  for (const line of String(markdown || "").split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading) {
      current = /进行中/.test(heading[1])
        ? "active"
        : /等待主人/.test(heading[1])
          ? "waiting"
          : null;
      continue;
    }
    if (!current || !line.trim().startsWith("|")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (!cells.length) continue;
    const first = cells[0];
    if (!first || first === "ID" || first === "—" || /^-+$/.test(first)) continue;
    result[current].push({ id: first, cells });
  }
  return result;
}

function firstHeading(markdown) {
  const match = /^##\s+(.+?)\s*$/m.exec(String(markdown || ""));
  return match ? match[1] : null;
}

function getPath(obj, dotted) {
  return dotted.split(".").reduce((acc, key) => (acc == null ? acc : acc[key]), obj);
}

async function runDoctor() {
  try {
    const out = execFileSync(process.execPath, ["tools/healthcheck.mjs"], {
      cwd: BRIDGE_DIR,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 180000,
    });
    const m = /fail\s*(\d+)\s*\/\s*warn\s*(\d+)\s*\/\s*共\s*(\d+)\s*项/.exec(out);
    return {
      ran: true,
      ok: true,
      fail: m ? Number(m[1]) : null,
      warn: m ? Number(m[2]) : null,
      checks: m ? Number(m[3]) : null,
    };
  } catch (err) {
    const out = `${err?.stdout || ""}\n${err?.stderr || ""}`;
    const m = /fail\s*(\d+)\s*\/\s*warn\s*(\d+)\s*\/\s*共\s*(\d+)\s*项/.exec(out);
    return {
      ran: true,
      ok: false,
      fail: m ? Number(m[1]) : null,
      warn: m ? Number(m[2]) : null,
      checks: m ? Number(m[3]) : null,
    };
  }
}

async function collect() {
  const baselinePath = path.join(DOCS_DIR, "05-BASELINE.md");
  const baselineText = readText(baselinePath);
  const baselineVersion = /版本：\s*(v[\d.]+)/.exec(baselineText || "")?.[1] || null;
  const baselineMeta = meta(baselinePath);

  const docs = [];
  for (const name of DOC_FILES) {
    const info = meta(path.join(DOCS_DIR, name));
    docs.push(info ? info : { path: `docs/orchestration/${name}`, missing: true });
  }

  const cfg = readConfigSafe();
  const statusProbe = await fetchJson(`http://127.0.0.1:${cfg.consolePort}/api/status`);
  const status = statusProbe.ok ? statusProbe.json : null;
  const reliabilityProbe = status
    ? await fetchJson(`http://127.0.0.1:${cfg.consolePort}/api/reliability`)
    : { ok: false };
  const reliability = reliabilityProbe.ok ? reliabilityProbe.json : null;

  const lockText = readText(path.join(STATE_DIR, "bridge.lock"));
  const pid = Number.parseInt(String(lockText || "").trim(), 10);

  const runtime = {
    consolePort: cfg.consolePort,
    bridge: {
      pid: Number.isInteger(pid) ? pid : null,
      alive: pidAlive(pid),
      httpOk: Boolean(status),
      mode: status?.mode ?? null,
      role: status?.role ?? null,
      roleMode: status?.roleMode ?? null,
      dshReady: status?.dshReady ?? null,
      simulationPaused: status?.simulationPaused ?? null,
      consoleAuthEnabled: status?.consoleAuthEnabled ?? null,
      whitelist: status?.allowGroups
        ? { groups: status.allowGroups.length, private: (status.allowPrivate || []).length }
        : null,
      snowluma: status?.snowluma
        ? {
            connected: Boolean(status.snowluma.connected),
            accountOnline: Boolean(status.snowluma.accountOnline),
            good: status.snowluma.good !== false,
          }
        : null,
    },
    dsh: {
      port: portOf(cfg.dshBaseUrl),
      model: cfg.dshModel,
      ready: status?.dshReady ?? null,
    },
    queues: reliability
      ? {
          outbox: {
            pending: reliability.outbox?.pending ?? null,
            uncertain: reliability.outbox?.uncertain ?? null,
            dead: reliability.outbox?.dead ?? null,
          },
          jobsPending: reliability.jobs?.pending ?? null,
          storageReady: reliability.storage?.ready ?? null,
        }
      : null,
  };

  const queue = readQueue();
  const board = parseBoard(readText(path.join(DOCS_DIR, "40-TASK-BOARD.md")));
  const progressHead = firstHeading(readText(path.join(DOCS_DIR, "10-PROGRESS.md")));

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const head = git(["log", "-1", "--format=%h"]);
  const headSubject = git(["log", "-1", "--format=%s"]);
  const dirtyCount = (() => {
    const out = git(["status", "--porcelain"]);
    return out === null ? null : out.split(/\r?\n/).filter(Boolean).length;
  })();
  const aheadBehind = (() => {
    const out = git(["rev-list", "--left-right", "--count", "HEAD...origin/main"]);
    if (!out) return null;
    const [ahead, behind] = out.split(/\s+/).map(Number);
    return { ahead, behind };
  })();

  return {
    schema: SNAPSHOT_SCHEMA,
    generatedAt: isoNow(),
    generatedAtLocal: fmtLocal(),
    projectRoot: PROJECT_ROOT,
    baseline: {
      path: "docs/orchestration/05-BASELINE.md",
      version: baselineVersion,
      sha8: baselineMeta?.sha8 ?? null,
      mtime: baselineMeta?.mtime ?? null,
    },
    docs,
    runtime,
    queue,
    board: {
      activeIds: board.active.map((row) => row.id),
      waitingIds: board.waiting.map((row) => row.id),
      active: board.active,
      waiting: board.waiting,
    },
    git: {
      branch,
      head,
      headSubject,
      dirtyCount,
      aheadBehind,
    },
    progressHead,
    memory: { dirs: [] },
    doctor: opts.full ? await runDoctor() : { ran: false },
  };
}

function diffSnapshots(prev, next) {
  if (!prev || prev.schema !== next.schema) return { firstRun: !prev, changes: [] };
  const fields = [
    "baseline.version",
    "runtime.bridge.mode",
    "runtime.bridge.pid",
    "runtime.bridge.httpOk",
    "runtime.bridge.dshReady",
    "runtime.bridge.snowluma.good",
    "runtime.dsh.port",
    "queue.tasks",
    "queue.proposals",
    "git.branch",
    "git.head",
    "git.dirtyCount",
  ];
  const changes = [];
  for (const field of fields) {
    const before = getPath(prev, field);
    const after = getPath(next, field);
    if (JSON.stringify(before) !== JSON.stringify(after)) {
      changes.push({ field, from: before ?? null, to: after ?? null });
    }
  }
  const prevStatus = JSON.stringify(prev.queue?.byStatus || {});
  const nextStatus = JSON.stringify(next.queue?.byStatus || {});
  if (prevStatus !== nextStatus) {
    changes.push({ field: "queue.byStatus", from: prev.queue?.byStatus || {}, to: next.queue?.byStatus || {} });
  }
  const prevActive = (prev.board?.activeIds || []).join(",");
  const nextActive = (next.board?.activeIds || []).join(",");
  if (prevActive !== nextActive) {
    changes.push({ field: "board.activeIds", from: prev.board?.activeIds || [], to: next.board?.activeIds || [] });
  }
  const prevDocs = new Map((prev.docs || []).map((doc) => [doc.path, doc.sha8]));
  const changedDocs = (next.docs || [])
    .filter((doc) => !doc.missing && prevDocs.has(doc.path) && prevDocs.get(doc.path) !== doc.sha8)
    .map((doc) => doc.path);
  if (changedDocs.length) changes.push({ field: "docs.changed", from: null, to: changedDocs });
  return { firstRun: false, changes };
}

function memoryDirs() {
  const slug = PROJECT_ROOT.replace(/[:\\/]/g, "-");
  const home = os.homedir();
  return [
    { edition: "qoder", dir: path.join(home, ".qoder", "projects", slug, "memory") },
    { edition: "qoder-cn", dir: path.join(home, ".qoder-cn", "projects", slug, "memory") },
  ];
}

/**
 * 当前 edition 与本项目最近活跃的会话。
 * 交接命令总是在主人刚打开的那个 edition 里执行，所以“最近改动的会话”
 * 就是这次接手的控制会话。
 */
function currentEditionSession() {
  const slug = PROJECT_ROOT.replace(/[:\\/]/g, "-").toLowerCase();
  const editions = [
    { edition: "qoder", dir: path.join(os.homedir(), ".qoder") },
    { edition: "qoder-cn", dir: path.join(os.homedir(), ".qoder-cn") },
  ];
  let best = null;
  for (const item of editions) {
    const projects = path.join(item.dir, "projects");
    let dirs = [];
    try {
      dirs = fs.readdirSync(projects, { withFileTypes: true }).filter((entry) => entry.isDirectory());
    } catch {
      continue;
    }
    for (const entry of dirs) {
      if (entry.name.toLowerCase() !== slug) continue;
      const abs = path.join(projects, entry.name);
      let files = [];
      try {
        files = fs.readdirSync(abs).filter((name) => name.endsWith(".jsonl"));
      } catch {
        continue;
      }
      for (const name of files) {
        let stat;
        try {
          stat = fs.statSync(path.join(abs, name));
        } catch {
          continue;
        }
        if (!best || stat.mtimeMs > best.mtimeMs) {
          best = {
            edition: item.edition,
            configDir: item.dir,
            sessionId: name.replace(/\.jsonl$/, ""),
            mtimeMs: stat.mtimeMs,
          };
        }
      }
    }
  }
  return best;
}

function cliScriptPath() {
  if (process.env.QODER_CLI_SCRIPT) return process.env.QODER_CLI_SCRIPT;
  if (process.platform !== "win32") return "qodercli";
  const appdata = process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming");
  return path.join(appdata, "npm", "node_modules", "@qoder-ai", "qodercli", "bundle", "qodercli.js");
}

/** 把唤醒目标钉到当前 edition，避免切版后仍 fork 上一版的会话。 */
async function syncController({ dryRun = false } = {}) {
  const file = path.join(STATE_DIR, "orchestrator", "controller.json");
  const found = currentEditionSession();
  if (!found) return { ok: false, reason: "no-session" };
  const current = readJson(file) || {};
  if (!current || typeof current !== "object") return { ok: false, reason: "invalid-controller" };
  const next = {
    ...current,
    sessionId: found.sessionId,
    configDir: found.configDir,
    cliScript: current.cliScript || cliScriptPath(),
    updatedAt: new Date().toISOString(),
    updatedBy: "handoff",
  };
  const changed = current.sessionId !== next.sessionId
    || current.configDir !== next.configDir
    || current.cliScript !== next.cliScript;
  if (changed && !dryRun) await writeAtomic(file, `${JSON.stringify(next, null, 2)}\n`);
  return { ok: true, changed, edition: found.edition, sessionId: found.sessionId, dryRun };
}

function pointerFile(snapshot) {
  return `---
name: handoff-pointer
description: 交接指针（脚本生成）：接手先跑 node qq-bridge/tools/handoff.mjs --resume；指向最新快照与回执
metadata:
  type: reference
---

<!-- 由 qq-bridge/tools/handoff.mjs 生成，请勿手改；规则以 docs/orchestration/05-BASELINE.md 为准。 -->

- 生成时间：${snapshot.generatedAtLocal}
- 基准：${snapshot.baseline.version || "未知"}（sha ${snapshot.baseline.sha8 || "?"}）
- 最新快照：\`docs/orchestration/handoff/latest.json\`
- 交接回执：\`docs/orchestration/handoff/HANDOFF-RESUME.md\`
- 接手命令：在 \`${PROJECT_ROOT}\` 运行 \`node qq-bridge\\scripts\\handoff.mjs --resume\`
- 一句话触发：主人在会话里说「交接」「接手」「继续」「handoff」时执行上面的命令并读回执。
`;
}

const MEMORY_LINE =
  "- [Handoff pointer](handoff-pointer.md) — 接手先跑 `node qq-bridge/tools/handoff.mjs --resume`；快照由脚本生成";

async function syncMemory(snapshot) {
  const synced = [];
  for (const { edition, dir } of memoryDirs()) {
    if (!fs.existsSync(dir)) continue;
    await writeAtomic(path.join(dir, "handoff-pointer.md"), pointerFile(snapshot));
    const indexPath = path.join(dir, "MEMORY.md");
    let index = readText(indexPath);
    if (index === null) index = "";
    const lineRe = /^-\s*\[Handoff pointer\]\(handoff-pointer\.md\).*$/m;
    if (lineRe.test(index)) {
      index = index.replace(lineRe, MEMORY_LINE);
    } else {
      const body = index.trim();
      index = body ? `${body}\n${MEMORY_LINE}\n` : `${MEMORY_LINE}\n`;
    }
    await writeAtomic(indexPath, index);
    synced.push({ edition, dir });
  }
  return synced;
}

async function writeAtomic(file, content) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  await fsp.writeFile(tmp, content, "utf8");
  await fsp.rename(tmp, file);
}

function code(value) {
  return value === null || value === undefined ? "未知" : String(value);
}

function byStatusText(byStatus) {
  const entries = Object.entries(byStatus || {});
  return entries.length ? entries.map(([status, count]) => `${status} ${count}`).join(" / ") : "无";
}

function renderResume(snapshot, diff) {
  const b = snapshot.runtime.bridge;
  const dsh = snapshot.runtime.dsh;
  const snow = b.snowluma;
  const checksLine = snapshot.doctor.ran
    ? `doctor fail ${code(snapshot.doctor.fail)} / warn ${code(snapshot.doctor.warn)} / 共 ${code(snapshot.doctor.checks)} 项`
    : "doctor 未运行（需要时用 --full）";

  const activeLines = snapshot.board.active.length
    ? snapshot.board.active.map((row) => `- ${row.cells.join(" ｜ ")}`).join("\n")
    : "- 无";
  const waitingLines = snapshot.board.waiting.length
    ? snapshot.board.waiting.map((row) => `- ${row.cells.join(" ｜ ")}`).join("\n")
    : "- 无";

  const changeLines = diff.firstRun
    ? "- 首次生成，无基线可比。"
    : diff.changes.length
      ? diff.changes
          .map((c) => `- \`${c.field}\`：${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`)
          .join("\n")
      : "- 无变化。";

  return `# 交接回执（脚本生成）

> 生成：${snapshot.generatedAtLocal} ｜ 基准：${code(snapshot.baseline.version)}（sha ${code(snapshot.baseline.sha8)}）
> 本文件每次运行覆盖；规则以 \`docs/orchestration/05-BASELINE.md\` 为准，本文件只报状态。
> 协议：\`docs/orchestration/06-HANDOFF-PROTOCOL.md\`

## 1. 给接手会话的第一段话（可直接粘贴）

你是「小鲸鱼」项目的新主控会话。项目根在 \`${PROJECT_ROOT}\`（代码在 \`qq-bridge\\\`）。

第一步（只读自检）：

\`\`\`bat
cd /d ${PROJECT_ROOT}
node qq-bridge\\scripts\\handoff.mjs --check
\`\`\`

然后按顺序读，不要整篇塞上下文：

1. \`docs/orchestration/05-BASELINE.md\` 第 0 节 + 第 10 节
2. \`docs/orchestration/06-HANDOFF-PROTOCOL.md\` 第 4 节（接手清单）
3. \`docs/orchestration/10-PROGRESS.md\` 最近 2 条（当前最新：${code(snapshot.progressHead)}）
4. \`docs/orchestration/40-TASK-BOARD.md\`（有活跃项时才读）

当前快照（已核对）：

- 模式 \`${code(b.mode)}\`，角色 \`${code(b.role)}\`（${code(b.roleMode)}）
- 桥接 PID ${code(b.pid)}，控制台 ${code(snapshot.runtime.consolePort)} ${b.httpOk ? "正常" : "不可达"}；DSH 端口 ${code(dsh.port)}，就绪 ${code(b.dshReady)}
- SnowLuma ${snow ? (snow.good ? "good" : "异常") : "未知"}；发送白名单 群 ${code(b.whitelist?.groups)} / 私聊 ${code(b.whitelist?.private)}
- 队列：task ${snapshot.queue.tasks} / proposal ${snapshot.queue.proposals}；任务板 进行中 ${snapshot.board.activeIds.length} / 待主人 ${snapshot.board.waitingIds.length}
- Git \`${code(snapshot.git.branch)}\` @ ${code(snapshot.git.head)}，未提交 ${code(snapshot.git.dirtyCount)} 项（不要清理、不要提交、不要推送）
- ${checksLine}

规则：主人是最高决策者；不自动合并/提交/push；不发真实 QQ 消息；不删数据；改代码后 \`npm run verify\` 全绿、\`npm run doctor\` fail 0。
汇报顺序：结论 → 证据 → 风险 → 下一步。

## 2. 运行状态

| 项 | 值 |
| --- | --- |
| 模式 / 角色 | ${code(b.mode)} / ${code(b.role)}（${code(b.roleMode)}） |
| 桥接 | PID ${code(b.pid)}，存活 ${b.alive ? "是" : "否"}，控制台 ${code(snapshot.runtime.consolePort)} ${b.httpOk ? "可达" : "不可达"} |
| DSH | 端口 ${code(dsh.port)}，ready ${code(b.dshReady)}，model ${code(dsh.model)} |
| SnowLuma | ${snow ? `connected=${snow.connected} online=${snow.accountOnline} good=${snow.good}` : "未知"} |
| 白名单 | 群 ${code(b.whitelist?.groups)} / 私聊 ${code(b.whitelist?.private)} |
| 社交暂停 | ${code(b.simulationPaused)} ｜ 控制台鉴权 ${code(b.consoleAuthEnabled)} |
| 出站队列 | pending ${code(snapshot.runtime.queues?.outbox?.pending)} / uncertain ${code(snapshot.runtime.queues?.outbox?.uncertain)} / dead ${code(snapshot.runtime.queues?.outbox?.dead)} |
| 任务队列 | pending ${code(snapshot.runtime.queues?.jobsPending)} ｜ 存储 ready ${code(snapshot.runtime.queues?.storageReady)} |
| 机器队列 | task ${snapshot.queue.tasks}（${byStatusText(snapshot.queue.byStatus)}），proposal ${snapshot.queue.proposals} |
| Git | ${code(snapshot.git.branch)} @ ${code(snapshot.git.head)} ${code(snapshot.git.headSubject)}；未提交 ${code(snapshot.git.dirtyCount)}；相对 origin/main ${snapshot.git.aheadBehind ? `ahead ${snapshot.git.aheadBehind.ahead} / behind ${snapshot.git.aheadBehind.behind}` : "未知"} |

## 3. 与上次交接的差异

${changeLines}

## 4. 任务板

进行中：

${activeLines}

等待主人：

${waitingLines}

## 5. 接手动作

1. 运行 \`node qq-bridge\\scripts\\handoff.mjs --check\`，确认没有 FAIL。
2. 读基准第 0 节，按第 4 节清单逐项核对。
3. 对照本回执第 2 节与实况；有差异先报告，不改代码。
4. 向主人回报「当前状态 + 差异 + 下一步」，得到确认后再动手。

## 6. 保护

- 不自动合并 / 提交 / push / 开源；不发真实 QQ 消息；不删数据。
- 不把 \`config.json\`、\`state\`、日志、真实 QQ 号/群号/token 写进文档或消息。
- 本文件与 \`latest.json\` 由脚本生成，手改会被覆盖。
`;
}

function printSummary(snapshot, diff, extra) {
  const b = snapshot.runtime.bridge;
  const snow = b.snowluma;
  const lines = [];
  lines.push(`交接快照 ${snapshot.generatedAtLocal}`);
  lines.push(
    `基准 ${code(snapshot.baseline.version)} (sha ${code(snapshot.baseline.sha8)}) ｜ 模式 ${code(b.mode)} ｜ 角色 ${code(b.role)}`,
  );
  lines.push(
    `桥接 PID ${code(b.pid)} ${b.alive ? "存活" : "未存活"} / 控制台 ${snapshot.runtime.consolePort} ${b.httpOk ? "正常" : "不可达"} ｜ DSH ${code(snapshot.runtime.dsh.port)} ready=${code(b.dshReady)}`,
  );
  lines.push(
    `SnowLuma ${snow ? (snow.good ? "good" : "异常") : "未知"} ｜ 白名单 群 ${code(b.whitelist?.groups)} / 私聊 ${code(b.whitelist?.private)}`,
  );
  if (snapshot.doctor.ran) {
    lines.push(
      `doctor fail ${code(snapshot.doctor.fail)} / warn ${code(snapshot.doctor.warn)} / 共 ${code(snapshot.doctor.checks)} 项`,
    );
  }
  lines.push(
    `队列 task ${snapshot.queue.tasks} proposal ${snapshot.queue.proposals} ｜ 任务板 进行中 ${snapshot.board.activeIds.length} / 待主人 ${snapshot.board.waitingIds.length}`,
  );
  lines.push(
    `Git ${code(snapshot.git.branch)} @ ${code(snapshot.git.head)} 未提交 ${code(snapshot.git.dirtyCount)}`,
  );
  if (diff.firstRun) lines.push("差异：首次生成");
  else if (!diff.changes.length) lines.push("差异：无");
  else {
    lines.push(`差异：${diff.changes.length} 项`);
    for (const c of diff.changes.slice(0, 8)) {
      lines.push(`  - ${c.field}: ${JSON.stringify(c.from)} → ${JSON.stringify(c.to)}`);
    }
  }
  if (extra) lines.push(extra);
  console.log(lines.join("\n"));
}

function runChecks(snapshot) {
  const checks = [];
  const add = (level, name, detail) => checks.push({ level, name, detail });

  if (!snapshot.baseline.sha8) add("fail", "基准文档", "05-BASELINE.md 不可读");
  else add("ok", "基准文档", `${code(snapshot.baseline.version)} (sha ${snapshot.baseline.sha8})`);

  const mode = snapshot.runtime.bridge.mode;
  if (mode === "simulation") add("ok", "当前模式", "simulation");
  else add("fail", "当前模式", `期望 simulation，实际 ${code(mode)}`);

  const b = snapshot.runtime.bridge;
  if (b.httpOk) add("ok", "桥接", `PID ${b.pid}，控制台 ${snapshot.runtime.consolePort} 可达`);
  else add("fail", "桥接", `控制台 ${snapshot.runtime.consolePort} 不可达`);

  if (b.dshReady === true) add("ok", "DSH", `端口 ${snapshot.runtime.dsh.port} ready`);
  else add("fail", "DSH", `ready=${code(b.dshReady)}`);

  const prev = readJson(LATEST_JSON);
  if (!prev) {
    add("warn", "交接快照", "尚未生成（先跑一次 handoff.mjs）");
  } else {
    const age = Date.now() - Date.parse(prev.generatedAt || 0);
    if (Number.isFinite(age) && age > STALE_SNAPSHOT_MS) {
      add("warn", "交接快照", `超过 7 天未更新（${prev.generatedAtLocal || prev.generatedAt}）`);
    } else {
      add("ok", "交接快照", `${prev.generatedAtLocal || prev.generatedAt}`);
    }
  }

  const pendingReview = snapshot.queue.byStatus?.pending_review || 0;
  if (pendingReview > 0) add("warn", "待审任务", `${pendingReview} 个 pending_review 需主控处理`);
  if (snapshot.queue.byStatus?.in_progress > 1) {
    add("warn", "并发任务", `${snapshot.queue.byStatus.in_progress} 个 in_progress，超出单任务上限`);
  }
  if (snapshot.board.activeIds.length > 0 && snapshot.queue.tasks === 0) {
    add("warn", "任务板一致性", "任务板有活跃项但机器队列为空");
  }
  if (snapshot.git.dirtyCount === null) add("warn", "Git", "无法读取状态");
  else add("ok", "Git", `${snapshot.git.dirtyCount} 项未提交（历史状态，不得清理）`);

  const failed = checks.filter((c) => c.level === "fail");
  return { ok: failed.length === 0, checks };
}

function printChecks(result, snapshot) {
  console.log(`交接自检 ${snapshot.generatedAtLocal}`);
  for (const c of result.checks) {
    const tag = c.level === "ok" ? " OK " : c.level === "warn" ? "WARN" : "FAIL";
    console.log(`[${tag}] ${c.name} — ${c.detail}`);
  }
  const failed = result.checks.filter((c) => c.level === "fail").length;
  const warned = result.checks.filter((c) => c.level === "warn").length;
  console.log(`结论：${result.ok ? "可接手" : "不可接手"}（fail ${failed} / warn ${warned}）`);
}

async function main() {
  const prev = readJson(LATEST_JSON);
  const snapshot = await collect();
  const diff = diffSnapshots(prev, snapshot);

  if (opts.check) {
    const result = runChecks(snapshot);
    if (opts.json) {
      console.log(JSON.stringify({ schema: SNAPSHOT_SCHEMA, check: result, snapshot }, null, 2));
    } else {
      printChecks(result, snapshot);
    }
    process.exit(result.ok ? 0 : 1);
  }

  const controller = opts.noController ? { ok: false, reason: "skipped" } : await syncController({ dryRun: opts.dryRun });

  if (opts.dryRun) {
    const controllerText = controller.ok
      ? `控制器：${controller.edition}（${controller.changed ? "待更新" : "已一致"}，未写文件）`
      : `控制器：未同步（${controller.reason}）`;
    if (opts.json) {
      console.log(JSON.stringify({ schema: SNAPSHOT_SCHEMA, dryRun: true, controller: { ok: controller.ok, edition: controller.edition, changed: controller.changed, reason: controller.reason }, diff, snapshot }, null, 2));
    } else {
      printSummary(snapshot, diff, `${controllerText}\n未写文件（--dry-run）`);
    }
    return;
  }

  let memorySynced = [];
  if (!opts.noMemory) {
    memorySynced = await syncMemory(snapshot);
    snapshot.memory = {
      dirs: memorySynced.map((item) => ({ edition: item.edition, dir: item.dir })),
    };
  }

  // 只记 edition 与是否变化，不把会话 id 写进快照（快照会进记忆指针）。
  snapshot.controller = controller.ok
    ? { edition: controller.edition, updated: controller.changed }
    : { updated: false, reason: controller.reason };

  await writeAtomic(LATEST_JSON, `${JSON.stringify({ ...snapshot, diff }, null, 2)}\n`);
  await writeAtomic(RESUME_MD, renderResume(snapshot, diff));

  if (opts.json) {
    console.log(
      JSON.stringify(
        {
          schema: SNAPSHOT_SCHEMA,
          wrote: {
            snapshot: path.relative(PROJECT_ROOT, LATEST_JSON).replace(/\\/g, "/"),
            resume: path.relative(PROJECT_ROOT, RESUME_MD).replace(/\\/g, "/"),
            memory: snapshot.memory.dirs,
          },
          controller: snapshot.controller,
          diff,
          snapshot,
        },
        null,
        2,
      ),
    );
    return;
  }

  if (opts.quiet) return;
  const memoryText = snapshot.memory.dirs.length
    ? `记忆指针：${snapshot.memory.dirs.map((d) => d.edition).join(" + ")}`
    : "记忆指针：未同步";
  const controllerText = controller.ok
    ? `事件唤醒目标：${controller.edition}（${controller.changed ? "已更新" : "已一致"}）`
    : `事件唤醒目标：未同步（${controller.reason}）`;
  printSummary(
    snapshot,
    diff,
    `${memoryText}\n${controllerText}\n已写入 docs/orchestration/handoff/{latest.json,HANDOFF-RESUME.md}`,
  );
}

main().catch((err) => {
  console.error(`交接脚本失败：${err?.message || err}`);
  process.exit(2);
});
