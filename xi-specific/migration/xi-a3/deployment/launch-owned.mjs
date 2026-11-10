import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { resolveOwnedCredentials } from './credentials.mjs';
import { acquireOwnedHandoff, recoverAbandonedOwnedLease, isOwnedHandoffLease } from './handoff-gate.mjs';
import { openCompatibleStores } from '../compatibility/open-stores.mjs';
import { openOwnedAccounting } from '../dsh/owned/accounting.mjs';
import { createOwnedDshAdapter } from '../dsh/owned/adapter.mjs';
import { startOwnedRuntime } from '../lifecycle/start-owned.mjs';
import { createRetainedStateMirror } from './retained-state.mjs';
import { createOwnedWorkroomViewer } from '../assets-runtime/viewer.mjs';
import { createOwnedPeerAdmission } from './peer-admission.mjs';
import { createOwnedFriendAdmission } from './friend-admission.mjs';
import { createProductionOwnedWebCatalog } from '../web-runtime/production-factory.mjs';
import { createRetainedLifeContext } from '../life-runtime/context.mjs';
import { createOwnedMediaIntake } from '../assets-runtime/media-intake.mjs';
import { openAssetsStore } from '../assets-runtime/store.mjs';
import { materializeRetainedMedia } from '../assets-runtime/delivery.mjs';

const read = file => JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const closed = () => ({closed: true, errors: []});

export function validateRelease(manifestPath) {
  if (!path.isAbsolute(manifestPath ?? '')) throw new Error('Explicit absolute launch manifest required');
  const raw = fs.readFileSync(manifestPath), manifest = JSON.parse(raw.toString('utf8'));
  if (manifest.format !== 'xi-owned-launch-manifest-v1' || manifest.activationReady !== true || !Array.isArray(manifest.pending) || manifest.pending.length) throw new Error('Owned release is still being prepared; no production resources opened');
  if (path.resolve(path.dirname(manifestPath)) !== path.resolve(manifest.paths.bridgeRoot)) throw new Error('Manifest must belong to this owned root');
  const release = read(path.join(manifest.paths.bridgeRoot, 'release-ready.json'));
  if (release.format !== 'xi-owned-reviewed-release-v1' || release.runtimeId !== manifest.runtimeId || release.manifestSha256 !== createHash('sha256').update(raw).digest('hex')) throw new Error('Release review no longer matches prepared configuration');
  const receipt = read(release.snapshotReceipt);
  if (receipt.format !== 'xi-stopped-private-snapshot-receipt-v1' || receipt.status !== 'encrypted_full_source_restore_verified' || receipt.synthetic_only !== false || receipt.actual_os_gates !== true || !Number.isInteger(receipt.databases_verified) || receipt.databases_verified < 18 || !fs.existsSync(receipt.encrypted_file)) throw new Error('Actual complete encrypted recovery evidence required');
  if (receipt.ciphertext_sha256 !== release.snapshotCiphertextSha256) throw new Error('Snapshot evidence mismatch');
  return {manifest, release};
}

/** This launcher alone owns production preparation and final activation.
 * No JSON boolean substitutes for the fresh OS lease. It does not stop the old
 * service or disable tasks; the controlled cutover performs those steps first.
 */
export async function launchOwned({manifestPath, recoverAbandoned = false, onActive, onOwnership} = {}) {
  const {manifest} = validateRelease(manifestPath);
  let lease, accounting, writer, adapter, app, viewer, webCatalog, life, mediaIntake, startupCleanup, adopted = false;
  let stage='handoff';
  const owns = ({bridgeRoot} = {}) => isOwnedHandoffLease(lease) && lease.productionEligible === true &&
    lease.newOwnedRoot === path.resolve(manifest.paths.bridgeRoot) &&
    (!bridgeRoot || path.resolve(bridgeRoot) === lease.newOwnedRoot) &&
    ['open', 'closing', 'close_failed'].includes(lease.status().state);
  try {
    lease = recoverAbandoned ? await recoverAbandonedOwnedLease({plan: manifest.handoffPlan, reason: 'Explicit trusted launcher recovery after verified owner/child exit'}) : await acquireOwnedHandoff({plan: manifest.handoffPlan});
    await onOwnership?.({manifest});
    stage='credential-references';
    const credentials = resolveOwnedCredentials(manifest);
    const cap = manifest.accounting.policy.hard;
    if (cap !== null) throw new Error('Changed monetary limit needs an explicit current policy mapping');
    stage='original-accounting';
    accounting = await openOwnedAccounting({ledgerPath: manifest.accounting.path, cap, maxOutput: manifest.dsh.providerSpec.maxTokens,
      provider: {...manifest.dsh.providerSpec, route:manifest.dsh.providerSpec.route ?? (manifest.dsh.providerSpec.kind === 'deepseek-messages' ? 'deepseek-official' : undefined)}, ownershipGate: owns});
    lease.defer('original-accounting', async () => { accounting.close(); return closed(); });
    if (manifest.lifePaths) {
      stage='original-life-reader';
      life = await createRetainedLifeContext({paths:manifest.lifePaths,identity:manifest.identities,ownerGate:owns});
      lease.defer('original-life-reader',()=>life.close());
    }
    if (manifest.webPaths) {
      stage='original-web-catalog';
      const webCredentials = {'owned:web-provider':credentials.webProviderKey,'owned:qq-http':credentials.qqHttpToken};
      // Legacy official route only. Never pass an alternative provider's key to official search.
      if (manifest.dsh.providerSpec.kind === 'deepseek-messages') webCredentials['owned:provider'] = credentials.providerKey;
      webCatalog = await createProductionOwnedWebCatalog({paths:manifest.webPaths,identity:manifest.identities,ownershipGate:owns,
        manifest:manifest.webManifest,resolveCredential:ref=>Object.hasOwn(webCredentials,ref)?webCredentials[ref]:undefined,
        authorizeExternalActions:()=>owns() && app?.status().phase==='active' && app.status().owned.ingressOpen===true});
      lease.defer('original-web-catalog',async()=>{await webCatalog.close();return closed();});
    }
    let assetsPaths = manifest.assetsPaths;
    if (assetsPaths) {
      stage='original-assets';
      mediaIntake=await createOwnedMediaIntake({paths:assetsPaths,identity:manifest.identities,ownershipGate:owns});
      lease.defer('original-media-intake',()=>Promise.resolve(mediaIntake.close()));
      const retained=await openAssetsStore({paths:assetsPaths,ownershipGate:owns});
      try {
        const ids=retained.mediaList({query:'public-seed',limit:100}).records.filter(row=>row.owner==='public-seed').map(row=>row.id);
        if(ids.length)await materializeRetainedMedia({store:retained,mainPaths:manifest.paths,ids,ownershipGate:owns});
      } finally { retained.close(); }
    }
    if (assetsPaths && manifest.viewer) {
      stage='workroom-viewer';
      viewer = createOwnedWorkroomViewer({mainPaths: manifest.paths, assetsPaths, port: manifest.viewer.port,
        python: manifest.viewer.python, ownershipGate: () => owns()});
      lease.defer('workroom-viewer', async () => { await viewer.stop(); return closed(); });
      assetsPaths = {...assetsPaths, previewBaseURL: (await viewer.start()).baseURL};
    }
    // Before main has accepted ownership, this fallback retains accounting until
    // every started child and unadopted store is confirmed closed.
    lease.defer('pre-main-resources', async () => {
      if (adopted) return closed();
      if (startupCleanup) return await startupCleanup();
      if (app) return await app.stop();
      await adapter?.stop(); await writer?.close(); return closed();
    });
    stage='canonical-stores';
    writer = await openCompatibleStores({paths: manifest.canonicalPaths, identities: manifest.identities, mode: 'transport'});
    const mirror = createRetainedStateMirror({bridgeDb: path.join(manifest.paths.stateDir, 'db/bridge.db'),
      cursorFile: path.join(manifest.paths.stateDir, 'retained-state-cursor.json'), runtimeId: manifest.runtimeId,
      record: input => writer.recordRetainedState(input)});
    const peer = createOwnedPeerAdmission({peerBotIds:manifest.identities.peerBotIds, ...manifest.peerPolicy});
    const friendAdmission = createOwnedFriendAdmission({url:manifest.qqHttp.url,token:credentials.qqHttpToken,
      botId:manifest.identities.botId,enabled:manifest.friendPrivateEnabled === true,
      authorize:()=>owns() && app?.status().phase === 'active'});
    stage='owned-dsh-construction';
    adapter = createOwnedDshAdapter({root: manifest.dsh.root, installation: manifest.dsh.installation, personaPrefix: manifest.dsh.personaPrefix, port: manifest.dsh.port, providerSpec: manifest.dsh.providerSpec,
      providerKey: credentials.providerKey, modelEnabled: true, modelGate: owns, activationGate: owns, accounting,
      qqHttp: {url: manifest.qqHttp.url, token: credentials.qqHttpToken}, memoryPaths: manifest.memoryPaths,
      ...(manifest.lifePaths ? {lifePaths:manifest.lifePaths,lifeIdentity:manifest.identities,lifeGate:owns} : {}),
      ...(assetsPaths ? {assetsPaths, assetsGate: owns} : {}),
      ...(manifest.webPaths ? {webPaths:manifest.webPaths,webIdentity:manifest.identities,webGate:owns,
        webManifest:manifest.webManifest} : {})});
    stage='main-initialization';
    await startOwnedRuntime({manifest, dshAdapter: adapter, experienceWriter: writer, credentials,
      retainedStateMirror: () => mirror.sync(), peerAdmission:event=>peer.evaluate(event), friendAdmission,
      webCatalog, mediaIntake, postQzone:webCatalog ? request=>webCatalog.publishOwnText(request) : undefined,
      retainedLifeContext:life?.retainedLifeContext,
      onReady: async handle => { app = handle; await app.attachHandoffLease(lease); adopted = true; app.reloadAssets(); }});
    await lease.recordOwnedChildren({pids: [adapter.status().pid, viewer?.status().pid].filter(Number.isInteger)});
    stage='qq-activation';
    await app.activate(lease);
    const status = {state: 'active', runtimeId: manifest.runtimeId, at: new Date().toISOString(), pid: process.pid,
      consolePort: app.status().console.port, dshPort: manifest.dsh.port,
      credentialValuesStored: false, originalAccounting: true, originalExperience: true};
    fs.writeFileSync(path.join(manifest.paths.bridgeRoot, 'runtime-status.json'), JSON.stringify(status, null, 2));
    await onActive?.(status);
    return {app, lease, manifest, async stop() {
      const result = await app.stop();
      fs.writeFileSync(path.join(manifest.paths.bridgeRoot, 'owned-stop.json'), JSON.stringify(result, null, 2));
      return result;
    }};
  } catch (error) {
    startupCleanup = typeof error.retryOwnedCleanup === 'function' ? error.retryOwnedCleanup : startupCleanup;
    const cleanup = lease ? await lease.close() : closed();
    throw Object.assign(new Error('Owned launch failed; inspect local receipt before retry', {cause: error}),
      {cleanup, stage, reasonCode: error.code ?? (error.message ?? '').match(/^qq-guard \(file:\/\/[^\r\n()]{1,2048}\/preset-guard\.mjs\): (OWNED_DSH_MCP_NOT_READY(?:_(?:QQ|MEMORY|ASSETS|WORKSHOP|WEB|LIFE|MAILBOX)){1,7})$/)?.[1] ?? (/^(?:OWNED_|XI_)[A-Z0-9_]+$/.test(error.message ?? '') ? error.message : error.name), retryCleanup:()=>lease ? lease.close() : Promise.resolve(closed())});
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const index = process.argv.indexOf('--manifest');
  let running, startup, startupError, stopRequested = false, stopping, controlTimer, controlManifest;
  const launchId = randomUUID();
  function recordClosed(result) {
    if (!controlManifest) return;
    const root=controlManifest.paths.bridgeRoot;
    fs.writeFileSync(path.join(root,'owned-stop.json'),JSON.stringify({...result,launchId,at:new Date().toISOString()},null,2));
    if (result.closed && result.released !== false) {
      clearInterval(controlTimer);
      fs.writeFileSync(path.join(root,'runtime-status.json'),JSON.stringify({state:'stopped',runtimeId:controlManifest.runtimeId,pid:process.pid,launchId,at:new Date().toISOString()},null,2));
    }
  }
  async function stop() {
    stopRequested = true;
    if (!startup) return;
    try {
      try { running = await startup; } catch(error) { startupError=error; }
      if (!stopping) stopping = (running ? running.stop() : startupError.retryCleanup()).finally(() => { stopping = undefined; });
      const result = await stopping;
      recordClosed(result);
      if (!result.closed || result.released === false) process.exitCode = 1;
    } catch { process.exitCode = 1; }
  }
  process.on('SIGINT', () => { void stop(); }); process.on('SIGTERM', () => { void stop(); });
  startup = launchOwned({manifestPath: index >= 0 ? process.argv[index + 1] : undefined,
    recoverAbandoned: process.argv.includes('--recover-abandoned'), onActive: status => console.log(JSON.stringify(status)),
    onOwnership:({manifest})=>{
      controlManifest=manifest; const root=manifest.paths.bridgeRoot;
      fs.writeFileSync(path.join(root,'launcher.json'),JSON.stringify({pid:process.pid,launchId,runtimeId:manifest.runtimeId,at:new Date().toISOString()},null,2));
      // Publish control only after this process owns the exclusive lease. A
      // failed competing start must not overwrite the live process's control.
      controlTimer=setInterval(()=>{
        const file=path.join(root,'stop-request.json');
        try{const request=read(file);if(request.launchId===launchId && request.pid===process.pid){fs.unlinkSync(file);void stop();}}catch{}
      },1000);
    }});
  try {
    running = await startup;
    if (stopRequested) await stop();
  }
  catch (error) {
    startupError=error; if(error.cleanup)recordClosed(error.cleanup);
    console.error(JSON.stringify({state:'not-active',errorType:error.name,stage:error.stage??'release-validation',reason:error.reasonCode??'release-not-ready',cleanup:error.cleanup??null}));
    process.exitCode=1;
  }
}
