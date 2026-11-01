import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createXiMemoryServer } from './server.mjs';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openXiReader } from '../../xi-a1/xi-reader.mjs';
import { ExperienceMemory as MemoryClass } from '../../xi-a1/legacy/experience-memory.mjs';

const log = (m) => { try { process.stderr.write('[xi-memory] ' + m + '\n'); } catch {} };

export async function startXiMemoryStdio(args = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      strict: true,
      allowPositionals: false,
      options: { db: { type: 'string' }, 'approved-root': { type: 'string' } }
    });
  } catch { log('invalid arguments'); throw new Error('INVALID_ARGUMENTS'); }
  const db = parsed.values.db;
  const approvedRoot = parsed.values['approved-root'];
  if (typeof db !== 'string' || db.length === 0 || typeof approvedRoot !== 'string' || approvedRoot.length === 0) {
    log('missing required arguments'); throw new Error('MISSING_ARGUMENTS');
  }

  let reader = null;
  let server = null;
  let transport = null;
  let closed = false;

  const shutdown = async (why) => {
    if (closed) return; closed = true;
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
    process.stdin.off('end', onEnd);
    log('shutting down: ' + why);
    try { if (reader && typeof reader.close === 'function') await reader.close(); } catch {}
    try { if (transport && typeof transport.close === 'function') await transport.close(); } catch {}
    try { if (server && typeof server.close === 'function') await server.close(); } catch {}
  };

  const onSig = (sig) => { void shutdown(sig).finally(() => process.exit(0)); };
  const onEnd = () => { void shutdown('stdin-end'); };

  try {
    reader = await openXiReader({ path: db, approvedRoot, MemoryClass, identities: {}, clock: () => Date.now() });
    server = createXiMemoryServer({ reader });
    transport = new StdioServerTransport();
    process.on('SIGINT', onSig);
    process.on('SIGTERM', onSig);
    process.stdin.once('end', onEnd);
    if (transport.onclose === undefined) transport.onclose = () => { void shutdown('transport-close'); };
    else transport.onclose = ((orig) => () => { try { orig?.(); } catch {} void shutdown('transport-close'); })(transport.onclose);
    await server.connect(transport);
    return { server, transport, reader, shutdown };
  } catch (e) {
    log('startup failed');
    await shutdown('startup-failed');
    throw new Error('STARTUP_FAILED');
  }
}

const isDirect = (() => {
  try { return fileURLToPath(import.meta.url) === resolve(process.argv[1] ?? ''); } catch { return false; }
})();

if (isDirect) {
  startXiMemoryStdio().catch(() => { log('fatal'); process.exit(1); });
}
