// 发布前自检（只读、离线）。不替代人工审查，只把“能把真实信息带进公开历史”的硬错误挡在提交前。
//
// 用法：npm run release:check
// 退出码：0 = 硬检查通过（仍需完成脚本末尾的人工清单）；1 = 有硬错误。

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const failures = [];

function fail(message) {
  failures.push(message);
  console.error(`  ✗ ${message}`);
}

function ok(message) {
  console.log(`  ✓ ${message}`);
}

function run(script) {
  const res = spawnSync(process.execPath, [script], { cwd: ROOT, stdio: 'inherit', timeout: 10 * 60 * 1000 });
  return res.status === 0;
}

function git(args) {
  const res = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  if (res.error || res.status !== 0) return null;
  return (res.stdout ?? '').split('\n').map((s) => s.trim()).filter(Boolean);
}

console.log('[release-check] 1/4 敏感文件');
const tracked = git(['ls-files']);
if (!tracked) {
  fail('无法读取 git 跟踪文件（不在 git 仓库或 git 不可用）');
} else {
  const forbidden = tracked.filter((file) => (
    file === 'config.json'
    || file.startsWith('state/')
    || file.startsWith('audio/')
    || /\.(log|bak)$/i.test(file)
    || /(^|\/)\.env(\.|$)/i.test(file)
  ));
  if (forbidden.length) fail(`以下敏感/运行文件已被 git 跟踪：${forbidden.slice(0, 8).join(', ')}${forbidden.length > 8 ? '…' : ''}`);
  else ok(`已跟踪文件 ${tracked.length} 个，未发现 config/state/audio/日志/备份`);
}

console.log('[release-check] 2/4 .gitignore 基线');
let ignore = '';
try { ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8'); } catch { fail('缺少 .gitignore'); }
for (const rule of ['config.json', 'state/', 'audio/']) {
  if (ignore && !ignore.split(/\r?\n/).some((line) => line.trim() === rule || line.trim() === `/${rule}`)) {
    fail(`.gitignore 缺少 ${rule}`);
  }
}
if (ignore) ok('config.json / state/ / audio/ 均在 .gitignore');

console.log('[release-check] 3/4 配置模板');
for (const file of ['config.example.json', 'tools/privacy-rules.example.json']) {
  try {
    JSON.parse(fs.readFileSync(path.join(ROOT, file), 'utf8').replace(/^\uFEFF/, ''));
    ok(`${file} 可解析`);
  } catch (error) {
    fail(`${file} 无法解析：${error?.message ?? error}`);
  }
}

console.log('[release-check] 4/4 隐私扫描');
if (!run('tools/privacy-scan.mjs')) fail('隐私扫描未通过（见上方命中）');
else ok('隐私扫描通过');

if (failures.length) {
  console.error(`\n[release-check] 硬检查失败 ${failures.length} 项，禁止发布/推送`);
  process.exitCode = 1;
} else {
  console.log('\n[release-check] 硬检查通过。发布前仍需人工完成：');
  console.log('  1. 轮换 QQ 密码、SnowLuma 访问令牌、DSH 令牌、搜索 API Key');
  console.log('  2. 替换 config.example.json 里的 ownerQQ/群号/路径为占位值');
  console.log('  3. 检查 personas/*.md 与 docs 中是否有真实昵称、群名、联系方式');
  console.log('  4. 用全新 clone 跑一次 npm ci && npm run verify，确认不依赖本机状态');
  console.log('  5. 确认 git 历史里没有曾经提交过 config.json/state/真实凭据');
}
