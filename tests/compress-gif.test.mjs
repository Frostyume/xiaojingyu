#!/usr/bin/env node
/** 压缩链路直测：真造一个 GIF，真调 tools/shrink-gif.py 压到更小。
 * 缺 Python/Pillow 时默认失败（写明安装方法），只有 QODER_SKIP_PILLOW=1 才打印 SKIP 并跳过。 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SCRIPT = join(ROOT, 'tools', 'shrink-gif.py');
const PYTHON = process.env.PYTHON || 'python';
const skip = process.env.QODER_SKIP_PILLOW === '1';

function python(code, extra = []) {
  return spawnSync(PYTHON, ['-c', code, ...extra], { encoding: 'utf8', timeout: 120000, windowsHide: true });
}

assert.ok(existsSync(SCRIPT), `找不到压缩脚本：${SCRIPT}`);

const probe = python('import PIL; print(PIL.__version__)');
const pillowReady = probe.status === 0;
if (skip) {
  console.log(`SKIP compress-gif: 已按 QODER_SKIP_PILLOW=1 跳过（PYTHON=${PYTHON}，Pillow=${pillowReady ? String(probe.stdout).trim() : '不可用'}）`);
  process.exit(0);
}
if (!pillowReady) {
  const detail = String(probe.stderr || probe.stdout || '').trim().split(/\r?\n/).slice(-2).join(' ');
  console.error('FAIL compress-gif: 需要 Python 3 + Pillow 才能验证压缩链路');
  console.error(`  当前解释器：${PYTHON}（可用 PYTHON 环境变量覆盖）`);
  if (detail) console.error(`  探测输出：${detail}`);
  console.error('  安装方法：python -m pip install Pillow');
  console.error('  仅本地临时跳过（CI 不跳过）：QODER_SKIP_PILLOW=1 npm run test:compress');
  process.exit(1);
}

const workdir = mkdtempSync(join(tmpdir(), 'qq-bridge-gif-'));
try {
  const source = join(workdir, 'source.gif');
  const target = join(workdir, 'target.gif');
  const built = python([
    'import sys',
    'from PIL import Image',
    'frames = [Image.effect_noise((240, 180), 90).convert("RGB") for _ in range(6)]',
    'frames[0].save(sys.argv[1], save_all=True, append_images=frames[1:], duration=80, loop=0)'
  ].join('\n'), [source]);
  assert.equal(built.status, 0, `生成测试 GIF 失败：${String(built.stderr || '').trim()}`);

  const before = statSync(source).size;
  const limit = Math.floor(before / 2);
  const shrunk = spawnSync(PYTHON, [SCRIPT, source, target, String(limit)], { encoding: 'utf8', timeout: 120000, windowsHide: true });
  assert.equal(shrunk.status, 0, `shrink-gif.py 退出码 ${shrunk.status}：${String(shrunk.stderr || '').trim()}`);
  assert.ok(existsSync(target), '压缩后输出文件不存在');

  const after = statSync(target).size;
  assert.ok(after <= limit, `压缩后 ${after} 字节仍超过上限 ${limit}`);
  assert.ok(after < before, `压缩后 ${after} 字节没有小于原始 ${before} 字节`);
  assert.equal(Number(String(shrunk.stdout).trim()), after, 'stdout 应输出最终字节数');
  const magic = readFileSync(target).subarray(0, 6).toString('latin1');
  assert.ok(magic === 'GIF89a' || magic === 'GIF87a', `输出不是 GIF（magic=${JSON.stringify(magic)}）`);

  console.log(`PASS compress-gif: ${before} -> ${after} 字节（上限 ${limit}）`);
} finally {
  rmSync(workdir, { recursive: true, force: true });
}
