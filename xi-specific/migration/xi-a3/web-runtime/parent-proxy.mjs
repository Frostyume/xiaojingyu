import {WEB_TOOL_NAMES} from './catalog.mjs';
import {readOwnedConsoleToken} from '../dsh/owned/web-credentials.mjs';
import {resolveOwnedRuntimePaths} from '../upstream/runtime/kernel/xi/owned-paths.mjs';

const fault=code=>Object.assign(new Error(code),{code});
async function readJson(response,maxBytes){
  if(!response.ok){await response.body?.cancel();throw fault('WEB_PARENT_REQUEST_REFUSED');}
  const reader=response.body?.getReader();let size=0,text='';const decoder=new TextDecoder();
  if(!reader)throw fault('WEB_PARENT_EMPTY_RESPONSE');
  try{
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw fault('WEB_PARENT_RESPONSE_TOO_LARGE');text+=decoder.decode(value,{stream:true});}
    text+=decoder.decode();return JSON.parse(text);
  }catch(error){await reader.cancel().catch(()=>{});throw error;}
  finally{reader.releaseLock();}
}

// Fixed loopback console routes only. No original SQLite store, platform driver,
// budget book or platform credential resolver is constructed in this process.
export async function createParentWebProxyCatalog({main:input,ownershipGate,fetcher=globalThis.fetch,timeoutMs=180000}={}){
  if(typeof ownershipGate!=='function'||await ownershipGate()!==true)throw fault('WEB_OWNER_NOT_OPEN');
  const main=resolveOwnedRuntimePaths(input);
  if(!main.consolePort||typeof fetcher!=='function'||!Number.isInteger(timeoutMs)||timeoutMs<1||timeoutMs>600000)throw fault('WEB_PARENT_EXPLICIT_CONSOLE_REQUIRED');
  const origin='http://127.0.0.1:'+main.consolePort;
  let closed=false,closing;const pending=new Set();
  const allowed=async()=>!closed&&await ownershipGate()===true;
  async function request(route,body,maxBytes){
    if(!await allowed())throw fault('WEB_OWNER_NOT_OPEN');
    const token=readOwnedConsoleToken(main);
    if(!/^[A-Za-z0-9_-]{16,128}$/.test(token))throw fault('WEB_PARENT_CONSOLE_TOKEN_UNAVAILABLE');
    const headers={'x-console-token':token};if(body!==undefined)headers['content-type']='application/json';
    // Neither x-agent-token nor x-agent-call can enter this header set.
    return readJson(await fetcher(origin+route,{method:body===undefined?'GET':'POST',headers,redirect:'error',cache:'no-store',
      ...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(timeoutMs)}),maxBytes);
  }
  const metadata=await request('/api/xi/web/tools',undefined,262144);
  if(metadata?.ok!==true||!Array.isArray(metadata.tools)||metadata.tools.length!==WEB_TOOL_NAMES.length||
    new Set(metadata.tools.map(tool=>tool.name)).size!==WEB_TOOL_NAMES.length||WEB_TOOL_NAMES.some(name=>!metadata.tools.some(tool=>tool.name===name)))throw fault('WEB_PARENT_EXACT_CATALOG_REQUIRED');
  const tools=WEB_TOOL_NAMES.map(name=>{
    const original=metadata.tools.find(tool=>tool.name===name);
    if(typeof original.description!=='string'||original.parameters?.type!=='object'||!original.parameters.properties)throw fault('WEB_PARENT_SCHEMA_REQUIRED');
    return Object.freeze({name,description:original.description,parameters:structuredClone(original.parameters),mutation:original.mutation===true,
      handler(args={}){
        const job=(async()=>{
          try{
            if(!args||typeof args!=='object'||Array.isArray(args)||Buffer.byteLength(JSON.stringify(args))>65536)throw fault('INVALID_WEB_ARGUMENTS');
            const response=await request('/api/xi/web/call',{name,args},2097152);
            if(response?.ok!==true||!Object.hasOwn(response,'result'))throw fault('WEB_PARENT_CALL_REFUSED');
            const result=typeof response.result==='string'?JSON.parse(response.result):response.result;
            if(!result||typeof result!=='object'||Array.isArray(result))throw fault('WEB_PARENT_INVALID_RESULT');
            return JSON.stringify(result);
          }catch(error){
            const safe=new Set(['WEB_OWNER_NOT_OPEN','WEB_PARENT_REQUEST_REFUSED','WEB_PARENT_CONSOLE_TOKEN_UNAVAILABLE','WEB_PARENT_RESPONSE_TOO_LARGE','WEB_PARENT_CALL_REFUSED','INVALID_WEB_ARGUMENTS']);
            return JSON.stringify({ok:false,status:'unavailable',reason:safe.has(error.code)?error.code:'WEB_PARENT_CALL_UNCONFIRMED',
              automatic_retry:false,...(name==='qzone_publish'?{publication_outcome_unknown:true,notice:'Parent outcome was not received; inspect the original draft/operation receipt, never resend automatically.'}:{})});
          }
        })();pending.add(job);job.finally(()=>pending.delete(job));return job;
      }});
  });
  return Object.freeze({tools,status:()=>({closed,parentProxy:true,originalDatabasesOpened:false,platformCredentialsResolved:false,pending:pending.size}),
    close(){if(closing)return closing;closed=true;return closing=(async()=>{await Promise.allSettled([...pending]);return {closed:true,errors:[]};})();}});
}
