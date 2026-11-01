import { StdioServerTransport } from '../../xi-a2/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { createOwnedWebCatalog } from './catalog.mjs';
import { createOwnedWebServer } from './server.mjs';
import { createProductionOwnedWebCatalog } from './production-factory.mjs';
import { createParentWebProxyCatalog } from './parent-proxy.mjs';
export async function startOwnedWebStdio(options) {
  let catalog, server, shutdownPromise;
  const shutdown = () => shutdownPromise ??= (async () => {
    process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); process.stdin.off('end', onEnd);
    try { await server?.close(); } finally { await catalog?.close(); }
    return { closed: true, errors: [] };
  })();
  const onSignal = () => void shutdown().finally(() => process.exit(0));
  const onEnd = () => void shutdown();
  try {
    catalog = options.parentProxy ? await createParentWebProxyCatalog(options.parentProxy)
      : options.production ? await createProductionOwnedWebCatalog({ ...options, ...options.production }) : await createOwnedWebCatalog(options);
    server = createOwnedWebServer({ catalog });
    process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); process.stdin.once('end', onEnd);
    await server.connect(new StdioServerTransport());
    return { shutdown, status: catalog.status };
  } catch (caught) { await shutdown(); throw caught; }
}
