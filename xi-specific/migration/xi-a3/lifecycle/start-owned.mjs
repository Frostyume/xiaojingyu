import fs from 'node:fs';
import path from 'node:path';
import { configureOwnedRuntimePaths } from '../upstream/runtime/kernel/xi/owned-paths.mjs';

/** Trusted launcher entry. A JSON manifest never activates QQ or a provider. */
export async function startOwnedRuntime({ manifest, dshAdapter, experienceWriter, credentials = {}, transportFactory, retainedStateMirror, peerAdmission, friendAdmission, retainedLifeContext, postQzone, webCatalog, mediaIntake, onReady, stopTimeoutMs = 30000 } = {}) {
  let mainOwnsResources = false;
  try {
  if (manifest?.format !== 'xi-owned-launch-manifest-v1') throw new Error('Explicit owned launch manifest required');
  if (manifest.activate === true || manifest.modelEnabled === true) throw new Error('Manifest JSON cannot authorize QQ/model activation');
  process.env.XI_RUNTIME_MODE = 'owned';
  const paths = configureOwnedRuntimePaths(manifest.paths);
  if (!dshAdapter) {
    if (!manifest.dsh || !path.isAbsolute(manifest.dsh.root ?? '')) throw new Error('Explicit owned DSH root and public provider specification required');
    const { createOwnedDshAdapter } = await import('../dsh/owned/adapter.mjs');
    dshAdapter = createOwnedDshAdapter({ root: manifest.dsh.root, installation: manifest.dsh.installation, personaPrefix: manifest.dsh.personaPrefix, port: manifest.dsh.port, providerSpec: manifest.dsh.providerSpec, modelEnabled: false });
  }
  // The factory itself is deferred until branded real handoff activation. HTTP
  // and WS credentials are separate memory arguments, never copied into JSON.
  const createTransport = transportFactory ?? (async ({ url, accessToken }) => {
    if (!credentials.qqWsToken || accessToken !== credentials.qqWsToken) throw new Error('Explicit in-memory QQ WS credential required');
    const config = JSON.parse(fs.readFileSync(paths.configFile, 'utf8'));
    if (config.snowluma?.wsUrl !== url) throw new Error('QQ WS endpoint must be explicit in owned configuration');
    const endpoint = new URL(url);
    if (endpoint.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)) throw new Error('Explicit loopback QQ WS endpoint required');
    const { SnowLumaWebSocketClient } = await import('@snowluma/sdk');
    return new SnowLumaWebSocketClient({ url, accessToken, reconnect: true });
  });
  const { main } = await import('../upstream/app/whale.js');
  mainOwnsResources = true;
  return await main({ experienceWriter, owned: { dshAdapter, credentials, transportFactory: createTransport,
    botId: manifest.identities?.botId, guardianIds: manifest.identities?.guardianIds ?? [], qqHttp: manifest.qqHttp ?? null, conversationMode: manifest.conversationMode ?? 'simulation', retainedStateMirror, peerAdmission, friendAdmission, retainedLifeContext, postQzone, webCatalog, mediaIntake, onReady, stopTimeoutMs } });
  } catch (error) {
    // main owns its cleanup after this transfer; especially do not close its
    // writer behind a DSH stop failure which deliberately retained dependencies.
    if (!mainOwnsResources) {
      const completed = new Set();
      error.retryOwnedCleanup = async () => {
        for (const [name, close] of [['dsh', () => dshAdapter?.stop?.()], ['experience-writer', () => experienceWriter?.close?.()]]) {
          if (completed.has(name)) continue;
          try { await close(); completed.add(name); }
          catch (failure) { return { closed: false, errors: [{ name, message: failure.message }], closedSteps: [...completed] }; }
        }
        return { closed: true, errors: [] };
      };
      error.cleanup = await error.retryOwnedCleanup();
    }
    throw error;
  }
}
