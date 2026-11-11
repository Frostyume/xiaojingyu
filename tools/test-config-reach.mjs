#!/usr/bin/env node
/**
 * 死开关检测工具自身的回归：
 *   1. 卡片可见但全库零引用（连父对象都没被读出过）的键 → 必须判 hard；
 *   2. 父对象整体被读出、叶子没点名的键 → 只能 advisory，不许 hard；
 *   3. allowlist 里声明过的键 → 不算 hard；
 *   4. 真实可读的键 → 判可达，且本仓库当前 hard 必须为 0；
 *   5. allowlist 四条防腐锁（缺 reason / 拼错键 / 已可达过期 / 重复）都要点名报错。
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { analyzeConfigReach, collectVisibleKeys, collectSchemaKeys, formatReport, validateAllowlist } from './check-config-reach.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// —— 1+3：真实仓库基线 ——
const base = analyzeConfigReach({ root });
assert.ok(base.files > 50, `扫描到的源文件太少（${base.files}），像是源码目录配置错了`);
assert.deepEqual(base.hard, [], `真实仓库里不该有硬问题：\n${formatReport({ ...base, advisory: [], suppressed: [] })}`);
assert.ok(base.reachableKeys.includes('simulation.sticker.enabled'), 'simulation.sticker.enabled 运行期有人读，必须判可达');
assert.ok(base.reachableKeys.includes('simulation.enabled'), 'simulation.enabled 运行期有人读，必须判可达');
assert.ok(base.suppressed.some((item) => item.key === 'simulation.speech.asr.provider'), '已知的假开关要归入「已知未实现」');
assert.ok(!base.hard.some((item) => item.key === 'simulation.speech.asr.provider'), 'allowlist 命中后不能算硬问题');
assert.deepEqual(base.allowlistProblems, [], `真实 allowlist 必须自检通过：${JSON.stringify(base.allowlistProblems)}`);

// 配置目录口径：只读仓库随附的 config.example.json，不读本机 config.json。
// 这里独立 flatten 一遍做夹具值断言，避免「扫描器读了别的文件」也能蒙混过关。
const example = JSON.parse(fs.readFileSync(path.join(root, 'config.example.json'), 'utf8'));
const flat = (value, prefix, out) => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) { if (prefix) out.push(prefix); return out; }
  for (const [k, v] of Object.entries(value)) flat(v, prefix ? `${prefix}.${k}` : k, out);
  return out;
};
const expectedSchema = [...new Set(flat(example, '', []))].sort();
assert.deepEqual(collectSchemaKeys(root), expectedSchema, '配置目录键必须与 config.example.json 的全量形状一致');
assert.ok(expectedSchema.includes('tts.textSplitMethod'), '只在 example 里声明（无 FIELD_META 条目）的键也要进配置目录');

// —— 5：allowlist 四条防腐锁（每条都要点名）——
const schemaKeys = collectSchemaKeys(root);
const lockedKey = 'simulation.outerWorld.browse.maxSteps';
assert.ok(base.suppressed.some((item) => item.key === lockedKey), `${lockedKey} 应已列入 allowlist`);
const lockCases = [
  { label: '缺 reason', entries: [{ key: lockedKey, reason: '  ' }], pattern: /缺少非空 reason/ },
  { label: 'key 拼错', entries: [{ key: 'simulation.outerWorld.browse.maxStepz', reason: '测试用' }], pattern: /不在配置目录/ },
  { label: '已可达（过期）', entries: [{ key: 'simulation.sticker.enabled', reason: '测试用' }], pattern: /已过期/ },
  { label: '重复', entries: [{ key: lockedKey, reason: '测试用' }, { key: lockedKey, reason: '测试用 2' }], pattern: /重复条目/ }
];
for (const item of lockCases) {
  const problems = validateAllowlist(item.entries, { schemaKeys, reachableKeys: base.reachableKeys });
  const hit = problems.find((problem) => item.pattern.test(problem));
  assert.ok(hit, `防腐锁应拦「${item.label}」：${JSON.stringify(problems)}`);
  assert.ok(hit.includes(item.entries[0].key), `报错要点名 ${item.entries[0].key}：${hit}`);
}
// __CHUNK__
