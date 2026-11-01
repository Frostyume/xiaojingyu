import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { createBridgeClient } from '../bridge-client.mjs';
import { resolveOwnedRuntimePaths } from '../../upstream/runtime/kernel/xi/owned-paths.mjs';
import { initializeRoot, checkedRoot, resolveDshInstallation } from './paths.mjs';
import { validateProvider, writeProfile } from './profile.mjs';
import { attachAccountingIpc } from './accounting-ipc.mjs';
import { validateAssetsPaths, verifyAssetsSchema } from '../../assets-runtime/paths.mjs';
import { validateWebPaths } from '../../web-runtime/catalog.mjs';
import { validateWebManifest } from './web-credentials.mjs';
import { validateLifePaths } from '../../life-runtime/context.mjs';

const WRAPPERS = { 'session/list': '_request', 'workspace/list': null, 'agentPresets/list': null, 'settings/describe': null };
const REQUEST = new Set(['session/create','session/prompt','session/cancel','session/selectModel','session/rename','session/fork','session/updateQueue','session/page','session/search','session/projections','workspace/create','workspace/rename','workspace/delete','workspace/archiveSession','workspace/insertBefore','workspace/insertSessionBefore']);
const OTHER = new Set(['$events/result', 'llm/models', 'llm/providers']);
const delay = ms => new Promise(resolve => { const timer = setTimeout(resolve, ms); timer.unref(); });
const alive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code !== 'ESRCH'; } };
async function bounded(promise, ms, code) { let timer; try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(code)), ms); timer.unref(); })]); } finally { clearTimeout(timer); } }
async function freePort(port) { await new Promise((resolve, reject) => { const server = createServer(); server.once('error', () => reject(new Error('OWNED_DSH_PORT_OCCUPIED'))); server.listen(port, '127.0.0.1', () => server.close(resolve)); }); }
function environment(home) {
  const env = {};
  for (const [key,value] of Object.entries(process.env)) if (/^(PATH|PATHEXT|SystemRoot|WINDIR|COMSPEC|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|ProgramFiles|ProgramFiles\(x86\)|ProgramData|SystemDrive|NUMBER_OF_PROCESSORS|PROCESSOR_ARCHITECTURE)$/i.test(key)) env[key] = value;
  // Only explicit installation/identity references cross this boundary; no general secret environment inheritance.
  for (const key of ['XI_SELF_ID','XI_PYTHON','XI_NODE_EXE','XI_APPCONTAINER_RUNNER','XI_APPCONTAINER_PROOF','XI_VIDEO_DECODER_CONFIG','XI_AUDIO_DECODER_CONFIG','XI_DSH_SCOPE_DIR','XI_DSH_PROXY_TOKEN_FILE','XI_DSH_PLANNER_PROOF','XI_TIEBA_CLAW_FORUM_IDS']) {
    if (process.env[key]) env[key] = process.env[key];
  }
  return { ...env, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1', DSH_TOOLS_MODE: 'native' };
}

export function createOwnedDshAdapter({ root, installation, port, providerSpec, providerKey = '', modelEnabled = false, modelGate, activationGate, qqHttp = null, memoryPaths = null, assetsPaths = null, assetsGate, webPaths = null, webIdentity = null, webGate, webManifest = null, webCredentials = {}, lifePaths = null, lifeIdentity = null, lifeGate, verifyInactiveQQ = false, accounting = null, personaPrefix } = {}) {
  installation = resolveDshInstallation(installation);
  checkedRoot(root, installation);
  const INSTALL = installation.root, CLI = path.join(INSTALL, 'node_modules/@deepseek-ai/dsh/lib/bin.js');
  if (typeof personaPrefix !== 'string' || !personaPrefix.trim()) throw new Error('OWNED_DSH_PRIVATE_PERSONA_PREFIX_REQUIRED');
  if (!Number.isInteger(port) || port < 1024 || port > 65535 || [3080,3091,3000,3001,5099,17789,17790].includes(port)) throw new Error('OWNED_DSH_EXPLICIT_NEW_PORT_REQUIRED');
  const provider = validateProvider(providerSpec);
  const checkedWebManifest=webManifest?validateWebManifest(webManifest):null;
  if(webIdentity&&(Object.keys(webIdentity).some(key=>!['botId','peerBotIds','guardianIds'].includes(key))||!/^\d{5,15}$/.test(String(webIdentity.botId??''))||['peerBotIds','guardianIds'].some(key=>webIdentity[key]!==undefined&&(!Array.isArray(webIdentity[key])||webIdentity[key].some(value=>!/^\d{5,15}$/.test(String(value)))))))throw new Error('OWNED_DSH_WEB_IDENTITY_FIELDS_REJECTED');
  if(lifeIdentity&&(Object.keys(lifeIdentity).some(key=>!['botId','peerBotIds','guardianIds'].includes(key))||!/^\d{5,15}$/.test(String(lifeIdentity.botId??''))||['peerBotIds','guardianIds'].some(key=>lifeIdentity[key]!==undefined&&(!Array.isArray(lifeIdentity[key])||lifeIdentity[key].some(value=>!/^\d{5,15}$/.test(String(value)))))))throw new Error('OWNED_DSH_LIFE_IDENTITY_FIELDS_REJECTED');
  if(checkedWebManifest&&!webPaths)throw new Error('OWNED_DSH_WEB_PATHS_REQUIRED');
  if (modelEnabled && (typeof modelGate !== 'function' || typeof providerKey !== 'string' || !providerKey)) throw new Error('OWNED_DSH_TRUSTED_MODEL_GATE_AND_MEMORY_KEY_REQUIRED');
  if (modelEnabled && (!accounting?.status?.().connected || typeof accounting.admit!=='function' || typeof accounting.complete!=='function')) throw new Error('OWNED_DSH_EXISTING_LEDGER_ACCOUNTING_REQUIRED');
  if (memoryPaths && (!path.isAbsolute(memoryPaths.db ?? '') || !path.isAbsolute(memoryPaths.approvedRoot ?? ''))) throw new Error('OWNED_DSH_EXPLICIT_MEMORY_PATHS_REQUIRED');
  let state = 'disabled', paths, mainPaths, child, ownsLock = false, exited, modelActive = false, httpActive = false, modelAttempts = 0;
  let starting, stopping, token = '', cookie = '', readyResolve, readyReject, exitResolve, readyPromise, exitPromise, catalog = [], inactiveQQ, cleanupEvidence;
  const baseUrl = `http://127.0.0.1:${port}`;
  const secrets = [providerKey, qqHttp?.token,...Object.values(webCredentials)].filter(x => typeof x === 'string' && x);
  let lines = '', tail = '';
  let accountingWire;
  function logLine(raw) {
    const match = raw.match(/[?&]token=([A-Za-z0-9_-]+)/); if (match) token = match[1];
    let safe = raw.replace(/([?&]token=)[A-Za-z0-9_-]+/g, '$1[REDACTED]').replace(/\x1b\[[0-9;]*m/g, '');
    for (const key of secrets) safe = safe.replaceAll(key, '[REDACTED]');
    fs.appendFileSync(path.join(paths.logs, 'dsh.log'), safe + '\n'); tail = (tail + safe + '\n').slice(-10000);
  }
  async function auth(signal) {
    if (state !== 'running') throw new Error('OWNED_DSH_NOT_RUNNING');
    if (!cookie) { const response = await fetch(`${baseUrl}/?token=${token}`, { redirect: 'manual', signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000) }); cookie = response.headers.getSetCookie().map(x => x.split(';')[0]).join('; '); await response.body?.cancel(); if (!cookie) throw new Error('OWNED_DSH_AUTH_FAILED'); }
  }
  async function callUnary(method, payload, signal) {
    const endpoint = String(method).replace(/\./g, '/');
    if (!REQUEST.has(endpoint) && !OTHER.has(endpoint) && !Object.hasOwn(WRAPPERS, endpoint)) throw new Error('OWNED_DSH_RPC_NOT_SUPPORTED');
    if (endpoint === 'session/prompt' && !modelActive) throw new Error('OWNED_DSH_MODEL_NOT_ACTIVATED');
    await auth(signal);
    const body = endpoint === 'session/prompt' ? { ...payload, requestId: payload?.requestId ?? randomUUID() } : payload ?? {};
    const args = REQUEST.has(endpoint) ? { request: body } : WRAPPERS[endpoint] === null ? {} : WRAPPERS[endpoint] ? { [WRAPPERS[endpoint]]: body } : body;
    const rpcId = randomUUID();
    const response = await fetch(baseUrl + '/api/' + endpoint, { method: 'POST', headers: { 'Content-Type':'application/json', Cookie:cookie }, body: JSON.stringify({ type:'client-request',rpcId,method:endpoint,payload:{args} }), signal: signal ? AbortSignal.any([signal,AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error('OWNED_DSH_HTTP_' + response.status); }
    const result = await response.json();
    if (result.type !== 'server-response' || result.rpcId !== rpcId || !result.result) throw new Error('OWNED_DSH_RPC_ENVELOPE_INVALID');
    return { rpcId, result:result.result };
  }
  const api = createBridgeClient({ baseUrl, callUnary, openWebSocket: async signal => { await auth(signal); return new WebSocket(baseUrl.replace('http:','ws:') + '/api/remote.mux', { headers:{Cookie:cookie} }); } });
  const readMcp = () => {
    const file = paths && path.join(paths.root,'mcp-pids.jsonl');
    if (!file || !fs.existsSync(file)) return [];
    const records = fs.readFileSync(file,'utf8').split('\n').filter(Boolean).map(x => JSON.parse(x));
    if (records.some(x => !Number.isSafeInteger(x.pid) || x.pid < 1)) throw new Error('OWNED_DSH_MCP_PID_RECORD_INVALID');
    return records;
  };
  async function confirmExit() {
    if (!ownsLock) return !child || Boolean(exited);
    if (child && !exited) return false;
    const pids = readMcp().map(x => x.pid);
    for (let n = 0; pids.some(alive) && n < 30; n++) await delay(100);
    cleanupEvidence = { cliExited: !child || Boolean(exited), mcpPids:pids, mcpExited:pids.every(pid => !alive(pid)) };
    if (!cleanupEvidence.mcpExited) return false;
    if(assetsPaths?.workshop&&fs.existsSync(assetsPaths.workshop.db+'.owned-worker.lock')){cleanupEvidence.workshopWorkerLockRetained=true;return false;}
    for (const file of ['owner.lock','mcp-pids.jsonl']) { try { fs.unlinkSync(path.join(paths.root,file)); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    ownsLock = false; return true;
  }
  function askStop() { if (child?.connected && !exited) { try { child.send({type:'owned-dsh-stop'},()=>{}); } catch {} } }
  async function waitExit(ms) { if (!child || exited) return true; try { await bounded(exitPromise,ms,'OWNED_DSH_EXIT_TIMEOUT'); return true; } catch { return false; } }
  async function start(input = {}) {
    if (state === 'running') { if (Object.keys(input).length && JSON.stringify(resolveOwnedRuntimePaths(input)) !== JSON.stringify(mainPaths)) throw new Error('OWNED_DSH_MAIN_PATHS_IMMUTABLE'); return status(); } if (starting) return starting; if (stopping) await stopping;
    starting = (async () => {
      state = 'starting'; mainPaths = resolveOwnedRuntimePaths(input); await freePort(port);
      if (JSON.parse(fs.readFileSync(INSTALL + '/node_modules/@deepseek-ai/dsh/package.json','utf8')).version !== '0.2.1-rc.2') throw new Error('OWNED_DSH_PINNED_VERSION_CHANGED');
      modelActive = modelEnabled && await modelGate({ capability:'model', provider:{...provider}, bridgeRoot:mainPaths.bridgeRoot }) === true;
      if (modelEnabled && !modelActive) throw new Error('OWNED_DSH_MODEL_GATE_REJECTED');
      httpActive = Boolean(qqHttp?.url && qqHttp?.token && typeof activationGate === 'function' && await activationGate({capability:'qq-http',bridgeRoot:mainPaths.bridgeRoot}) === true);
      if (httpActive) { const url = new URL(qqHttp.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || url.username || url.password || url.search || url.hash) throw new Error('OWNED_DSH_QQ_HTTP_URL_REJECTED'); }
      let approvedAssets=null;
      if(assetsPaths){if(typeof assetsGate!=='function'||await assetsGate({capability:'assets',bridgeRoot:mainPaths.bridgeRoot,paths:assetsPaths})!==true)throw new Error('OWNED_DSH_ASSETS_LEASE_REQUIRED');approvedAssets=validateAssetsPaths(assetsPaths);verifyAssetsSchema(approvedAssets);}
      let approvedWeb=null;
      if(webPaths){if(typeof webGate!=='function'||await webGate({capability:'web',bridgeRoot:mainPaths.bridgeRoot,paths:webPaths})!==true)throw new Error('OWNED_DSH_WEB_LEASE_REQUIRED');approvedWeb=validateWebPaths(webPaths);for(const name of ['bilibiliDb','qzoneDb','experienceDb'])if(!fs.existsSync(approvedWeb[name])||!fs.statSync(approvedWeb[name]).isFile())throw new Error('OWNED_DSH_WEB_EXISTING_DATABASE_REQUIRED');if(!/^\d{5,15}$/.test(String(webIdentity?.botId??'')))throw new Error('OWNED_DSH_WEB_TRUSTED_IDENTITY_REQUIRED');}
      let approvedLife=null;
      if(lifePaths){if(typeof lifeGate!=='function'||await lifeGate({capability:'life',bridgeRoot:mainPaths.bridgeRoot,paths:lifePaths})!==true)throw new Error('OWNED_DSH_LIFE_LEASE_REQUIRED');approvedLife=validateLifePaths(lifePaths);if(!/^\d{5,15}$/.test(String(lifeIdentity?.botId??'')))throw new Error('OWNED_DSH_LIFE_TRUSTED_IDENTITY_REQUIRED');}
      paths = initializeRoot(root, installation);
      const lock = path.join(paths.root,'owner.lock');
      try { fs.writeFileSync(lock,JSON.stringify({supervisorPid:process.pid,node:process.execPath,cli:CLI,root:paths.root,instanceId:paths.metadata.instanceId,at:new Date().toISOString()}),{flag:'wx'}); ownsLock = true; } catch { throw new Error('OWNED_DSH_ROOT_ALREADY_OWNED'); }
      try {
        const stale = readMcp(); if (stale.some(x => alive(x.pid))) throw new Error('OWNED_DSH_MCP_STILL_RUNNING'); if (stale.length) fs.unlinkSync(path.join(paths.root,'mcp-pids.jsonl'));
        const profile = writeProfile({paths,main:mainPaths,provider,modelActive,httpActive,memoryPaths,assetsPaths:approvedAssets,webPaths:approvedWeb,webIdentity,webManifest:checkedWebManifest,lifePaths:approvedLife,lifeIdentity,personaPrefix,verifyInactiveQQ,accountingEnabled:Boolean(accounting?.status?.().connected)});
        fs.writeFileSync(path.join(paths.logs,'dsh.log'),''); exited = null; token = ''; cookie = ''; lines = ''; modelAttempts = 0;
        readyPromise = new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;}); exitPromise = new Promise(resolve=>{exitResolve=resolve;});
        const env = { ...environment(paths.home), XI_OWNED_DSH_INSTALLATION_JSON: JSON.stringify(installation), ...(modelActive?{XI_OWNED_PROVIDER_KEY:providerKey}:{}), ...(httpActive?{XI_OWNED_QQ_HTTP_URL:qqHttp.url,XI_OWNED_QQ_HTTP_TOKEN:qqHttp.token}:{}) };
        child = spawn(process.execPath,[CLI,'--profile',profile.profile,'--host','127.0.0.1','--port',String(port),'--no-open'],{cwd:paths.project,env,windowsHide:true,stdio:['ignore','pipe','pipe','ipc']});
        accountingWire=attachAccountingIpc(child,accounting);
        fs.writeFileSync(lock,JSON.stringify({supervisorPid:process.pid,cliPid:child.pid,node:process.execPath,cli:CLI,root:paths.root,instanceId:paths.metadata.instanceId,at:new Date().toISOString()}));
        const consume = chunk => { lines += String(chunk); const all = lines.split(/\r?\n/); lines = all.pop(); for (const line of all) logLine(line); };
        child.stdout.on('data',consume); child.stderr.on('data',consume);
        child.on('error',()=>{if(!child.pid){exited={spawnFailed:true};exitResolve(exited);}readyReject(new Error('OWNED_DSH_SPAWN_FAILED'));});
        child.on('exit',(code,signal)=>{if(lines){logLine(lines);lines='';}exited={code,signal};if(state==='running')state='failed';exitResolve(exited);readyReject(new Error('OWNED_DSH_EXITED_BEFORE_READY'));});
        child.on('message',message=>{if(message?.type==='owned-dsh-ready'){catalog=message.catalog;inactiveQQ=message.inactiveQQ;readyResolve();}if(message?.type==='owned-dsh-start-error')readyReject(new Error(message.message));if(message?.type==='owned-dsh-model-attempt')modelAttempts++;});
        await bounded(readyPromise,120000,'OWNED_DSH_START_TIMEOUT');
        if(!token||exited)throw new Error('OWNED_DSH_LOCAL_AUTH_NOT_READY'); state='running';return status();
      } catch(error) {
        state='failed'; askStop(); if(!await waitExit(8000)&&child){child.kill();await waitExit(3000);} await accountingWire?.close(); if(!await confirmExit())throw new Error('OWNED_DSH_EXIT_UNCONFIRMED_LOCK_RETAINED',{cause:error}); throw error;
      }
    })();
    try{return await starting;}catch(error){state='failed';throw error;}finally{starting=undefined;}
  }
  async function stop() {
    if(stopping)return stopping;
    stopping=(async()=>{if(starting){try{await starting;}catch{}}await api.close();if(child&&!exited){state='stopping';askStop();if(!await waitExit(10000)){state='failed';throw new Error('OWNED_DSH_STOP_TIMEOUT_LOCK_RETAINED');}}await accountingWire?.close();if(!await confirmExit()){state='failed';throw new Error('OWNED_DSH_MCP_EXIT_UNCONFIRMED_LOCK_RETAINED');}child=null;token='';cookie='';state='stopped';return status();})();
    try{return await stopping;}finally{stopping=undefined;}
  }
  function status(){return{kind:'owned-dsh',state,owned:ownsLock,pid:child&&!exited?child.pid:null,root:paths?.root??root,home:paths?.home??null,baseUrl,modelActive,modelAttempts,provider:{...provider},qqHttpConfigured:Boolean(qqHttp?.url&&qqHttp?.token),qqHttpActive:httpActive,catalogCount:catalog.length,productionAccountingConnected:Boolean(accounting?.status?.().connected),accounting:accounting?.status?.()??{connected:false},lastExit:exited??null,cleanupEvidence:cleanupEvidence??null};}
  return {kind:'owned-dsh',api,start,stop,status,catalog:()=>structuredClone(catalog),inactiveQQResult:()=>structuredClone(inactiveQQ),diagnosticTail:()=>tail};
}
