// Fixed trusted dependency construction. No request, credential resolution or
// platform login occurs here; credentials are resolved only at a real tool call.
import fs from 'node:fs';
import path from 'node:path';
import { lookup } from 'node:dns/promises';
import { DatabaseSync } from 'node:sqlite';
import { biliGet } from '../../../companion/bilibili-public.mjs';
import { resolveBilibiliReference } from '../../../companion/bilibili-links.mjs';
import { securePublicRequest } from '../../../companion/public-exploration.mjs';
import { createDeepSeekPublicSearch } from '../../../companion/deepseek-public-search.mjs';
import { SpendingBook, guardedClient } from '../../../companion/guarded-client.mjs';
import { audioDecoderAvailable, transcribeVideoAudio } from '../../../companion/video-audio.mjs';
import { sampleVideoFrames, videoDecoderAvailable } from '../../../companion/video-frames.mjs';
import { createHttpClient } from '../../xi-a2/node_modules/@snowluma/sdk/dist/client/http-client.js';
import { createOwnedWebCatalog, validateWebPaths } from './catalog.mjs';

function fail(code) { return Object.assign(new Error(code), { code }); }
function existingBudget(file, root) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw fail('WEB_EXPLICIT_ORIGINAL_BUDGET_REQUIRED');
  const absolute = path.resolve(file), relative = path.relative(root, absolute);
  if (!relative || relative === '..' || relative.startsWith('..' + path.sep) || path.isAbsolute(relative)) throw fail('WEB_BUDGET_OUTSIDE_APPROVED_ROOT');
  for (let current = absolute;; current = path.dirname(current)) {
    const st = fs.lstatSync(current); if (st.isSymbolicLink() || st.isFile() && st.nlink !== 1) throw fail('WEB_BUDGET_LINK_REFUSED');
    if (current === root) break;
  }
  if (!fs.statSync(absolute).isFile()) throw fail('WEB_ORIGINAL_BUDGET_MISSING');
  return absolute;
}

export function createProductionWebDependencies({ paths: rawPaths, manifest, resolveCredential, transports = {}, visionClient, authorizeExternalActions } = {}) {
  const paths = validateWebPaths(rawPaths);
  if (!manifest || typeof manifest !== 'object' || Object.keys(manifest).some(k => !['provider', 'tiebaTokenReference', 'oneBot', 'publicationLimit', 'nativeSpeech'].includes(k))) throw fail('WEB_TRUSTED_MANIFEST_REQUIRED');
  const refs = [manifest.tiebaTokenReference, manifest.provider?.apiKeyReference, manifest.oneBot?.accessTokenReference].filter(x => x !== undefined);
  if (refs.some(x => typeof x !== 'string' || !x) || refs.length && typeof resolveCredential !== 'function') throw fail('WEB_TRUSTED_CREDENTIAL_RESOLVER_REQUIRED');
  if (manifest.provider && !manifest.provider.apiKeyReference || manifest.oneBot && !manifest.oneBot.accessTokenReference) throw fail('WEB_TRUSTED_CREDENTIAL_RESOLVER_REQUIRED');
  if (manifest.oneBot && typeof authorizeExternalActions !== 'function') throw fail('WEB_EXISTING_QZONE_AUTHORIZATION_REQUIRED');
  const credential = async reference => {
    const value = await resolveCredential(reference);
    if (typeof value !== 'string' || !value || value.length > 4096 || /[\r\n\x00]/.test(value)) throw fail('WEB_CREDENTIAL_UNAVAILABLE');
    return value;
  };
  const publicTransport = transports.publicTransport ?? securePublicRequest, resolver = transports.resolver ?? lookup;
  const fetcher = transports.fetcher ?? globalThis.fetch;
  const dependencies = {
    bilibili: { request: (url, options) => biliGet(url, { ...options, resolver, transport: publicTransport }),
      linkResolver: (input, options) => resolveBilibiliReference(input, { ...options, resolver, transport: publicTransport }),
      directFrameSampler: sampleVideoFrames, directFramesReady: videoDecoderAvailable },
    tieba: { request: publicTransport, resolver, ...(manifest.tiebaTokenReference ? {
      credentialReference: manifest.tiebaTokenReference, tokenReader: () => credential(manifest.tiebaTokenReference) } : {}) },
  };
  let book;
  try {
  if (manifest.provider) {
    const provider = manifest.provider, url = new URL(provider.baseUrl);
    if (url.origin !== 'https://api.deepseek.com' || url.username || url.password || url.search || url.hash
        || !(provider.capMicroCny === null || Number.isSafeInteger(provider.capMicroCny) && provider.capMicroCny > 0)
        || !Number.isSafeInteger(provider.maxOutput) || provider.maxOutput < 1 || provider.maxOutput > 32768) throw fail('WEB_ORIGINAL_PROVIDER_BUDGET_CONTRACT_REQUIRED');
    book = new SpendingBook(existingBudget(provider.budgetDb, paths.root), provider.capMicroCny, { maxOutput: provider.maxOutput });
    const searchPublic = async (request, options) => {
      const apiKey = await credential(provider.apiKeyReference);
      return createDeepSeekPublicSearch({ credentials: () => ({ baseUrl: provider.baseUrl, apiKey }), fetcher })(request, options);
    };
    dependencies.publicClient = guardedClient(() => {
      if (typeof visionClient?.respond !== 'function') throw fail('WEB_APPROVED_VISION_CLIENT_NOT_CONNECTED');
      return visionClient;
    }, book, { maxOutput: provider.maxOutput, searchPublic });
  }
  if (manifest.nativeSpeech === true) {
    dependencies.bilibili.speechReady = audioDecoderAvailable;
    dependencies.bilibili.speechTranscriber = transcribeVideoAudio;
  }
  if (manifest.oneBot) {
    const url = new URL(manifest.oneBot.httpUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
        || !url.port || url.username || url.password || url.search || url.hash || url.pathname !== '/') throw fail('WEB_EXPLICIT_LOOPBACK_HTTP_REQUIRED');
    const policy = manifest.publicationLimit;
    if (!policy || !(policy.maxSendAttempts === null || Number.isSafeInteger(policy.maxSendAttempts) && policy.maxSendAttempts >= 0)
        || !Number.isSafeInteger(policy.sinceMs) || policy.sinceMs < 0) throw fail('WEB_EXISTING_SEND_LIMIT_REQUIRED');
    const count = () => {
      const db = new DatabaseSync(paths.qzoneDb, { readOnly: true });
      try { return db.prepare("SELECT count(*) n FROM qzone_operations WHERE at>=? AND state IN ('sending','verified','uncertain')").get(policy.sinceMs).n; }
      finally { db.close(); }
    };
    dependencies.qzone = { authorize: typeof authorizeExternalActions === 'function' ? authorizeExternalActions : () => true,
      publicationLimits: { check: () => policy.maxSendAttempts === null || count() < policy.maxSendAttempts,
        beforeSend: () => { if (policy.maxSendAttempts !== null && count() > policy.maxSendAttempts) throw fail('WEB_EXISTING_SEND_LIMIT'); } },
      driver: { callApi: async (action, args) => {
        if (!['get_login_info', 'get_qzone_msg_list', 'get_qzone_msg_detail', 'send_qzone_msg'].includes(action)) throw fail('WEB_QZONE_ACTION_REJECTED');
        const accessToken = await credential(manifest.oneBot.accessTokenReference);
        // Reuse the installed SDK HTTP facade; constructing it opens no WS or QQ process.
        return createHttpClient({ baseUrl: url.href, accessToken, fetch: (target, options) => fetcher(target, { ...options, redirect: 'error' }), requestTimeoutMs: 20000 }).call(action, args);
      } },
    };
  }
  return { dependencies, close() { book?.close(); }, contract: {
    publicBilibiliTransport: 'original biliGet + securePublicRequest + DNS pinning; no cookie/key',
    tiebaCredentialConfigured: Boolean(manifest.tiebaTokenReference), publicSearchConfigured: Boolean(manifest.provider),
    qzoneHttpConfigured: Boolean(manifest.oneBot), nativeSpeechApproved: manifest.nativeSpeech === true,
    frameVisionConfigured: false, directFrameImagesConfigured: true,
    frameVisionRoute: 'bilibili_frames MCP images to current conversation model; no separate vision API',
    networkPerformedDuringConstruction: false, credentialsReadDuringConstruction: false,
  } };
  } catch (caught) { book?.close(); throw caught; }
}

export async function createProductionOwnedWebCatalog(options) {
  if (typeof options?.ownershipGate !== 'function' || await options.ownershipGate() !== true) throw fail('WEB_OWNER_NOT_OPEN');
  const factory = createProductionWebDependencies(options);
  let catalog;
  try { catalog = await createOwnedWebCatalog({ ...options, dependencies: factory.dependencies }); }
  catch (error) { factory.close(); throw error; }
  let closing;
  return Object.freeze({ ...catalog, dependencyContract: factory.contract,
    close() { return closing ??= (async () => { try { return await catalog.close(); } finally { factory.close(); } })(); },
  });
}
