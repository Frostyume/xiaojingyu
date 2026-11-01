import fs from 'node:fs';
import { inspectFrozenSourceForSnapshot } from './handoff-gate.mjs';
try {
  if (process.argv.length !== 3) throw new Error('Explicit plan file required');
  const plan = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
  const result = await inspectFrozenSourceForSnapshot({ plan });
  process.stdout.write(JSON.stringify(result) + '\n');
} catch (error) {
  process.stdout.write(JSON.stringify({ allowed: false, code: error.code ?? 'SOURCE_GATE_FAILED', blockers: error.report?.blockers ?? [] }) + '\n');
  process.exitCode = 2;
}
