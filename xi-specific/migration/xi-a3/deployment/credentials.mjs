import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CONATUS_CLIENT = fileURLToPath(new URL('../../../workflows/xi/conatus_client.py', import.meta.url));
const fail = code => Object.assign(new Error(code), {code});

function readSmall(file) {
  if (!path.isAbsolute(file ?? '')) throw new Error('Explicit credential file reference required');
  const item = fs.lstatSync(file);
  if (!item.isFile() || item.isSymbolicLink() || item.size > 1024 * 1024) throw new Error('Credential reference is not a bounded regular file');
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}
function pointer(object, value) {
  if (typeof value !== 'string' || !value.startsWith('/')) throw new Error('Explicit JSON pointer required');
  return value.slice(1).split('/').map(p => p.replaceAll('~1', '/').replaceAll('~0', '~')).reduce((current, key) => {
    if (!current || !Object.hasOwn(current, key)) throw new Error('Credential reference no longer matches');
    return current[key];
  }, object);
}
function nonempty(value) {
  if (typeof value !== 'string' || value.trim().length < 1) throw new Error('Required credential is unavailable');
  return value;
}
function readJson(file) {
  try { return JSON.parse(readSmall(file)); }
  catch { throw fail('OWNED_CREDENTIAL_REFERENCE_UNAVAILABLE'); }
}
function officialKey(ref, expectedModel, environment) {
  if (ref?.pointer !== '/secret' || ref.kind !== undefined && ref.kind !== 'deepseek-official-env') throw fail('OWNED_OFFICIAL_REFERENCE_INVALID');
  const cfg = readJson(ref.config_path);
  const keyName = pointer(cfg, ref.pointer);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(keyName)) throw fail('OWNED_OFFICIAL_ENV_REFERENCE_INVALID');
  if (cfg.spec?.model !== expectedModel || typeof cfg.baseUrl !== 'string' || cfg.baseUrl.replace(/\/$/, '') !== 'https://api.deepseek.com') throw fail('OWNED_OFFICIAL_PROVIDER_MAPPING_CHANGED');
  // Original first non-whitespace .env value contract, without expansion.
  return nonempty(environment[keyName] || new RegExp('^[ \\t]*' + keyName + '[ \\t]*=[ \\t]*(\\S+)', 'm').exec(readSmall(ref.env_path))?.[1]);
}
function validateQiniuReference(ref, spec) {
  if (Object.keys(ref).some(key => !['kind','key_path','python_path','provider'].includes(key)) ||
      typeof ref.key_path !== 'string' || !path.isAbsolute(ref.key_path) || typeof ref.python_path !== 'string' || !path.isAbsolute(ref.python_path) ||
      !/^[a-z0-9][a-z0-9-]{0,63}$/.test(ref.provider ?? '') || ref.provider === 'deepseek-official' || ref.provider !== spec?.route ||
      spec?.kind !== 'openai-completions' || spec.baseURL !== 'https://api.qnaigc.com/v1' || spec.model !== 'deepseek/deepseek-v4.1-flash-1017' ||
      Object.hasOwn(spec,'providers') || Object.hasOwn(spec,'fallback')) throw fail('OWNED_QINIU_EXPLICIT_MAPPING_REQUIRED');
}
function qiniuKey(ref) {
  const QINIU_KEY = ref.key_path, PYTHON = ref.python_path;
  // The credential file remains encrypted on disk. Only load_key's stdout pipe
  // carries plaintext internally; no shell, terminal, log or profile sees it.
  // In particular CONATUS_API_KEY cannot override this explicit DPAPI reference.
  let loader;
  try {
    const st=fs.lstatSync(QINIU_KEY);
    if(!st.isFile()||st.isSymbolicLink()||st.size<1||st.size>65536)throw fail('OWNED_QINIU_LOCAL_CREDENTIAL_UNAVAILABLE');
    const env={};for(const [key,value] of Object.entries(process.env))if(/^(PATH|SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA|ProgramData|SystemDrive)$/i.test(key))env[key]=value;
    env.XI_CONATUS_KEY_FILE = QINIU_KEY;
    const program='import importlib.util, pathlib, sys; s=importlib.util.spec_from_file_location("owned_conatus_credentials",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); assert m.credential_path().resolve()==pathlib.Path(sys.argv[2]).resolve(); sys.stdout.write(m.load_key())';
    loader=spawnSync(PYTHON,['-I','-B','-c',program,CONATUS_CLIENT,QINIU_KEY],{windowsHide:true,env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:10000,maxBuffer:16384});
    const value=loader.stdout?.trim();
    if(loader.status!==0||typeof value!=='string'||!value||value.length>8192||/[^\x21-\x7e]/.test(value))throw fail('OWNED_QINIU_LOCAL_CREDENTIAL_UNAVAILABLE');
    return value;
  }catch{throw fail('OWNED_QINIU_LOCAL_CREDENTIAL_UNAVAILABLE');}
  finally{if(loader){loader.stdout='';loader.stderr='';loader.output=null;}}
}

/** Called only by the trusted local launcher. Returns memory values, never logs or persists them. */
export function resolveOwnedCredentials(manifest, {environment = process.env} = {}) {
  try {
  const refs = manifest?.credentialReferences;
  if (!refs?.http || !refs?.ws || !refs?.provider) throw new Error('Credential references incomplete');
  const qiniu=refs.provider.kind==='qiniu-conatus-dpapi',spec=manifest.dsh?.providerSpec;
  if(qiniu)validateQiniuReference(refs.provider,spec);
  else if(refs.provider.kind!==undefined&&refs.provider.kind!=='deepseek-official-env')throw fail('OWNED_PROVIDER_REFERENCE_KIND_UNSUPPORTED');
  const web=manifest.webManifest?.provider;
  if(refs.webProvider && (!web || web.apiKeyReference!=='owned:web-provider' || web.baseUrl!=='https://api.deepseek.com') ||
      web?.apiKeyReference==='owned:web-provider'&&!refs.webProvider || qiniu&&web&&web.apiKeyReference!=='owned:web-provider')throw fail('OWNED_WEB_PROVIDER_REFERENCE_REQUIRED');
  if (refs.http.pointer !== '/networks/httpServers/0/accessToken' || refs.ws.pointer !== '/networks/wsServers/0/accessToken') throw new Error('Unsupported explicit credential reference layout');
  const httpConfig = readJson(refs.http.path);
  const wsConfig = refs.ws.path === refs.http.path ? httpConfig : readJson(refs.ws.path);
  const hs = httpConfig.networks.httpServers[0], ws = wsConfig.networks.wsServers[0];
  if (hs.host !== '127.0.0.1' || ws.host !== '127.0.0.1' ||
      manifest.qqHttp.url !== 'http://127.0.0.1:' + hs.port ||
      manifest.handoffPlan.oneBotEndpoint.replace(/\/$/, '') !== 'ws://127.0.0.1:' + ws.port) throw new Error('Configured QQ endpoint changed; review connection mapping');
  if(!qiniu && (spec?.kind!==undefined&&spec.kind!=='deepseek-messages' || spec?.baseURL!=='https://api.deepseek.com/anthropic'))throw fail('OWNED_OFFICIAL_PROVIDER_MAPPING_CHANGED');
  // Search remains the original official API account/model reference. It never
  // borrows the new Qiniu key, and no provider fallback is attempted on failure.
  const webProviderKey=refs.webProvider?officialKey(refs.webProvider,'deepseek-flash',environment):undefined;
  const providerKey=qiniu?qiniuKey(refs.provider):officialKey(refs.provider,spec?.model,environment);
  return Object.freeze({qqHttpToken: nonempty(pointer(httpConfig, refs.http.pointer)),
    qqWsToken: nonempty(pointer(wsConfig, refs.ws.pointer)), providerKey: nonempty(providerKey),...(webProviderKey===undefined?{}:{webProviderKey})});
  } catch(error) {
    // Do not propagate JSON fragments, native stderr, file contents or causes.
    const safe=new Set(['OWNED_CREDENTIAL_REFERENCE_UNAVAILABLE','OWNED_OFFICIAL_REFERENCE_INVALID','OWNED_OFFICIAL_ENV_REFERENCE_INVALID','OWNED_OFFICIAL_PROVIDER_MAPPING_CHANGED',
      'OWNED_QINIU_EXPLICIT_MAPPING_REQUIRED','OWNED_QINIU_LOCAL_CREDENTIAL_UNAVAILABLE','OWNED_PROVIDER_REFERENCE_KIND_UNSUPPORTED','OWNED_WEB_PROVIDER_REFERENCE_REQUIRED']);
    if(safe.has(error?.code))throw fail(error.code);
    if(error?.message==='Configured QQ endpoint changed; review connection mapping')throw new Error(error.message);
    throw fail('OWNED_CREDENTIAL_RESOLUTION_FAILED');
  }
}
