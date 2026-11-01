import fs from 'node:fs';
import path from 'node:path';
export const WEB_CREDENTIAL_KEYS=Object.freeze(['owned:provider','owned:web-provider','owned:qq-http','owned:tieba']);
export function validateWebManifest(input){
  if(!input||typeof input!=='object'||Array.isArray(input)||Object.keys(input).some(key=>!['provider','tiebaTokenReference','oneBot','publicationLimit','nativeSpeech'].includes(key)))throw new Error('OWNED_WEB_MANIFEST_FIELDS_REJECTED');
  const manifest=structuredClone(input);
  const fields=(value,allowed)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!allowed.includes(key)))throw new Error('OWNED_WEB_MANIFEST_FIELDS_REJECTED');};
  if(manifest.provider){fields(manifest.provider,['baseUrl','apiKeyReference','budgetDb','capMicroCny','maxOutput']);if(!['owned:provider','owned:web-provider'].includes(manifest.provider.apiKeyReference))throw new Error('OWNED_WEB_PROVIDER_REFERENCE_REQUIRED');if(!(manifest.provider.capMicroCny===null||Number.isSafeInteger(manifest.provider.capMicroCny)&&manifest.provider.capMicroCny>=0))throw new Error('OWNED_WEB_EXPLICIT_CURRENT_BUDGET_REQUIRED');if(manifest.provider.baseUrl!=='https://api.deepseek.com'||!path.isAbsolute(manifest.provider.budgetDb??'')||!Number.isInteger(manifest.provider.maxOutput)||manifest.provider.maxOutput<1||manifest.provider.maxOutput>32768)throw new Error('OWNED_WEB_ORIGINAL_PROVIDER_CONTRACT_REQUIRED');}
  if(manifest.oneBot){fields(manifest.oneBot,['httpUrl','accessTokenReference']);if(manifest.oneBot.accessTokenReference!=='owned:qq-http')throw new Error('OWNED_WEB_HTTP_REFERENCE_REQUIRED');const url=new URL(manifest.oneBot.httpUrl);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw new Error('OWNED_WEB_EXPLICIT_HTTP_ORIGIN_REQUIRED');}
  if(manifest.tiebaTokenReference!==undefined&&manifest.tiebaTokenReference!=='owned:tieba')throw new Error('OWNED_WEB_TIEBA_REFERENCE_REQUIRED');
  if(manifest.publicationLimit){fields(manifest.publicationLimit,['maxSendAttempts','sinceMs']);if(!(manifest.publicationLimit.maxSendAttempts===null||Number.isSafeInteger(manifest.publicationLimit.maxSendAttempts)&&manifest.publicationLimit.maxSendAttempts>=0)||!Number.isSafeInteger(manifest.publicationLimit.sinceMs)||manifest.publicationLimit.sinceMs<0)throw new Error('OWNED_WEB_EXISTING_PUBLICATION_POLICY_REQUIRED');}
  if(manifest.nativeSpeech!==undefined&&typeof manifest.nativeSpeech!=='boolean')throw new Error('OWNED_WEB_NATIVE_SPEECH_INVALID');
  return manifest;
}
export function createWebCredentialResolver(manifest,credentials={}){
  const checked=validateWebManifest(manifest),refs=new Set([checked.provider?.apiKeyReference,checked.oneBot?.accessTokenReference,checked.tiebaTokenReference].filter(Boolean));
  if(!credentials||typeof credentials!=='object'||Array.isArray(credentials)||Object.keys(credentials).some(key=>!WEB_CREDENTIAL_KEYS.includes(key)))throw new Error('OWNED_WEB_CREDENTIAL_KEYS_REJECTED');
  for(const [key,value] of Object.entries(credentials))if(typeof value!=='string'||!value||value.length>4096||/[\r\n\x00]/.test(value))throw new Error('OWNED_WEB_CREDENTIAL_VALUE_REJECTED');
  for(const reference of refs)if(!Object.hasOwn(credentials,reference))throw new Error('OWNED_WEB_REFERENCED_CREDENTIAL_UNAVAILABLE');
  return reference=>{if(!refs.has(reference)||!Object.hasOwn(credentials,reference))throw new Error('OWNED_WEB_CREDENTIAL_REFERENCE_REJECTED');return credentials[reference];};
}
export function readOwnedConsoleToken(main){
  const config=JSON.parse(fs.readFileSync(main.configFile,'utf8'));let token=String(config.consoleToken??'').trim();
  if(!/^[A-Za-z0-9_-]{16,128}$/.test(token)){try{token=fs.readFileSync(path.join(main.stateDir,'console-token'),'utf8').trim();}catch{token='';}}
  return token;
}
/** Fixed local state check, not new per-post approval or platform login. */
export function createWebExternalActionGuard(main,ownershipGate,{fetcher=fetch}={}){
  return async()=>{
    if(await ownershipGate()!==true||!main.consolePort)return false;
    const token=readOwnedConsoleToken(main);if(!token)return false;
    try{
      const response=await fetcher('http://127.0.0.1:'+main.consolePort+'/api/xi/lifecycle',{headers:{'x-console-token':token},signal:AbortSignal.timeout(5000)});
      if(!response.ok){await response.body?.cancel();return false;}
      const value=await response.json();return value.owned?.activated===true&&value.owned?.ingressOpen===true&&path.resolve(value.owned.paths?.bridgeRoot??'').toLowerCase()===path.resolve(main.bridgeRoot).toLowerCase();
    }catch{return false;}
  };
}
