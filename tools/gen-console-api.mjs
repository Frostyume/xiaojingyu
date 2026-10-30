#!/usr/bin/env node
/**
 * 控制台端点清单：把 bridge.js 里声明过的路由（精确匹配 / 前缀匹配）固化成 golden。
 *
 * 用途：P3 要把路由拆出 bridge.js 时，「接口集合与匹配语义一个都不能变」这件事
 * 不能靠人眼。任何新增/删除/改写路由都会让 `--check` 变红，从而强制在 diff 里
 * 显式承认「我改了对外的 URL 面」。
 *
 *   node tools/gen-console-api.mjs           # 重新生成 golden
 *   node tools/gen-console-api.mjs --check   # 只校验（verify 里跑这个）
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bridgePath = resolve(root, 'app/whale.js');
// 控制面的路径名单外提到 policy.js 后（P3），端点面的真相也分散在两个文件里：
// 只扫 bridge.js 会把「前缀匹配搬到名单里」误判成删除路由。
const policyPath = resolve(root, 'console/policy.js');
// 实时状态页的四个分支也在 P3 外提了。
const livePath = resolve(root, 'console/live.js');
const goldenPath = resolve(root, 'tests/fixtures/console-endpoints.golden.json');

function extract(source) {
  const exact = new Set();
  const prefix = new Set();
  for (const m of source.matchAll(/(?:url\.)?pathname\s*===\s*'([^']+)'/g)) exact.add(m[1]);
  for (const m of source.matchAll(/(?:url\.)?pathname\s*===\s*"([^"]+)"/g)) exact.add(m[1]);
  for (const m of source.matchAll(/(?:url\.)?pathname\.startsWith\(\s*'([^']+)'/g)) prefix.add(m[1]);
  for (const m of source.matchAll(/(?:url\.)?pathname\.startsWith\(\s*"([^"]+)"/g)) prefix.add(m[1]);
  return { exact, prefix };
}

/** policy.js 里的名单常量：名字以 _PREFIXES 结尾的算前缀，其余按精确路径。 */
function extractLists(source) {
  const exact = new Set();
  const prefix = new Set();
  const patterns = [
    /export const ([A-Z0-9_]+)\s*=\s*new Set\(\[([\s\S]*?)\]\)/g,
    /export const ([A-Z0-9_]+)\s*=\s*\[([\s\S]*?)\];/g
  ];
  for (const pattern of patterns) {
    for (const m of source.matchAll(pattern)) {
      const target = m[1].endsWith('_PREFIXES') ? prefix : exact;
      for (const lit of m[2].matchAll(/'([^']+)'/g)) {
        if (lit[1].startsWith('/')) target.add(lit[1]);
      }
    }
  }
  return { exact, prefix };
}

function merge(...sets) {
  const out = { exact: new Set(), prefix: new Set() };
  for (const set of sets) {
    for (const p of set.exact) out.exact.add(p);
    for (const p of set.prefix) out.prefix.add(p);
  }
  return { exact: [...out.exact].sort(), prefix: [...out.prefix].sort() };
}

const current = merge(
  extract(readFileSync(bridgePath, 'utf8').replace(/^\uFEFF/, '')),
  extract(readFileSync(policyPath, 'utf8').replace(/^\uFEFF/, '')),
  extract(readFileSync(livePath, 'utf8').replace(/^\uFEFF/, '')),
  extractLists(readFileSync(policyPath, 'utf8').replace(/^\uFEFF/, ''))
);

if (process.argv.includes('--check')) {
  if (!existsSync(goldenPath)) {
    console.error('缺少 tests/fixtures/console-endpoints.golden.json；先跑 node tools/gen-console-api.mjs');
    process.exit(1);
  }
  const golden = JSON.parse(readFileSync(goldenPath, 'utf8'));
  const problems = [];
  for (const kind of ['exact', 'prefix']) {
    const want = new Set(golden[kind] ?? []);
    const have = new Set(current[kind] ?? []);
    for (const p of have) if (!want.has(p)) problems.push(`+ ${kind} ${p}`);
    for (const p of want) if (!have.has(p)) problems.push(`- ${kind} ${p}`);
  }
  if (problems.length) {
    console.error(`控制台端点面发生变化（${problems.length} 处）：`);
    for (const line of problems) console.error(`  ${line}`);
    console.error('确认是有意改动后，跑 node tools/gen-console-api.mjs 更新 golden。');
    process.exit(1);
  }
  console.log(`console endpoints golden ok (exact ${current.exact.length} / prefix ${current.prefix.length})`);
} else {
  writeFileSync(goldenPath, `${JSON.stringify(current, null, 2)}\n`);
  console.log(`wrote ${goldenPath} (exact ${current.exact.length} / prefix ${current.prefix.length})`);
}
