// 交接脚本自检：字段契约 + 脱敏 + 只读模式。
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRIDGE_DIR = path.resolve(__dirname, "..");
const PROJECT_ROOT = path.resolve(BRIDGE_DIR, "..");
const SCRIPT = path.join(BRIDGE_DIR, "scripts", "handoff.mjs");
const RESUME = path.join(PROJECT_ROOT, "docs", "orchestration", "handoff", "HANDOFF-RESUME.md");

function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], {
      cwd: PROJECT_ROOT,
      encoding: "utf8",
      timeout: 120000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout };
  } catch (err) {
    return { code: err.status ?? 1, stdout: `${err.stdout || ""}${err.stderr || ""}` };
  }
}

function collectKeys(value, keys = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
  } else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      keys.add(k);
      collectKeys(v, keys);
    }
  }
  return keys;
}

const FORBIDDEN_KEYS = ["ownerQQ", "allowGroups", "allowPrivate", "authToken", "token", "key", "secret"];

test("--check --json 输出契约且不泄露标识", () => {
  const { code, stdout } = run(["--check", "--json", "--no-memory"]);
  assert.ok(code === 0 || code === 1, `unexpected exit ${code}`);
  const payload = JSON.parse(stdout);
  assert.equal(payload.schema, 1);
  assert.ok(payload.check && Array.isArray(payload.check.checks));
  assert.equal(typeof payload.check.ok, "boolean");
  assert.ok(payload.snapshot.runtime.bridge.mode);
  assert.ok(Array.isArray(payload.snapshot.docs));

  const keys = collectKeys(payload);
  for (const forbidden of FORBIDDEN_KEYS) {
    assert.ok(!keys.has(forbidden), `payload leaked key: ${forbidden}`);
  }
  assert.ok(!/\d{9,}/.test(stdout), "payload contains a 9+ digit identifier (QQ/group id)");
});

test("--dry-run --json 不写文件", () => {
  const before = fs.existsSync(RESUME) ? fs.statSync(RESUME).mtimeMs : null;
  const { code, stdout } = run(["--dry-run", "--json", "--no-memory"]);
  assert.equal(code, 0);
  const payload = JSON.parse(stdout);
  assert.equal(payload.dryRun, true);
  const after = fs.existsSync(RESUME) ? fs.statSync(RESUME).mtimeMs : null;
  assert.equal(before, after, "dry-run must not rewrite the resume doc");
});

test("回执可被接手方直接使用", () => {
  const text = fs.readFileSync(RESUME, "utf8");
  for (const marker of [
    "交接回执",
    "05-BASELINE.md",
    "06-HANDOFF-PROTOCOL.md",
    "handoff.mjs --check",
    "不自动合并",
  ]) {
    assert.ok(text.includes(marker), `resume doc missing marker: ${marker}`);
  }
  assert.ok(!/\d{9,}/.test(text), "resume doc contains a 9+ digit identifier");
});

test("记忆指针双向存在且索引只有一行", () => {
  const home = process.env.USERPROFILE || process.env.HOME;
  const slug = PROJECT_ROOT.replace(/[:\\/]/g, "-");
  for (const edition of [".qoder", ".qoder-cn"]) {
    const dir = path.join(home, edition, "projects", slug, "memory");
    if (!fs.existsSync(dir)) continue;
    const pointer = path.join(dir, "handoff-pointer.md");
    assert.ok(fs.existsSync(pointer), `${edition} missing handoff-pointer.md`);
    assert.ok(fs.readFileSync(pointer, "utf8").includes("handoff.mjs"), `${edition} pointer not informative`);
    const index = fs.readFileSync(path.join(dir, "MEMORY.md"), "utf8");
    const hits = index.match(/\[Handoff pointer\]\(handoff-pointer\.md\)/g) || [];
    assert.equal(hits.length, 1, `${edition} MEMORY.md should reference the pointer exactly once`);
  }
});
