import {lookup} from 'node:dns/promises';
import {isIP} from 'node:net';
import {publicHttpsUrl,publicInternetAddress,securePublicRequest} from './public-exploration.mjs';
const idPattern=/^BV[1-9A-HJ-NP-Za-km-z]{10}$/;
const fullHosts=new Set(['www.bilibili.com','m.bilibili.com','bilibili.com']);
async function abortable(run,signal){
 signal.throwIfAborted();let abort;const stopped=new Promise((_,reject)=>{abort=()=>reject(signal.reason??Error('bilibili-link-aborted'));signal.addEventListener('abort',abort,{once:true});});
 try{return await Promise.race([Promise.resolve().then(run),stopped]);}finally{signal.removeEventListener('abort',abort);}
}
export function parseBilibiliReference(input){
 if(typeof input!=='string'||input.length>2048)throw Error('invalid-bilibili-reference');
 if(idPattern.test(input))return {bvid:input,page:1,url:'https://www.bilibili.com/video/'+input+'/'};
 // Known platform links can be upgraded without making an insecure request.
 input=input.replace(/^http:\/\/(?=(?:b23\.tv|(?:www\.|m\.)?bilibili\.com)\/)/,'https://');
 let raw;try{raw=new URL(input);}catch{throw Error('invalid-bilibili-reference');}
 if(raw.username||raw.password)throw Error('bilibili-link-credentials-rejected');
 // Only known share-tracking names are removed before the generic credential
 // check. An unrelated token/session parameter still fails closed.
 if(raw.hostname==='b23.tv'||fullHosts.has(raw.hostname))for(const key of [...raw.searchParams.keys()])if(/^(share_medium|share_source|share_session_id|bbid|ts|vd_source|spm_id_from)$/i.test(key))raw.searchParams.delete(key);
 const u=publicHttpsUrl(raw.href);
 if(u.hostname==='b23.tv'){
  if(!/^\/[A-Za-z0-9]{1,32}\/?$/.test(u.pathname))throw Error('invalid-bilibili-short-link');
  return {short:true,url:'https://b23.tv'+u.pathname}; // Drop share tracking/identity parameters.
 }
 if(!fullHosts.has(u.hostname))throw Error('unapproved-bilibili-link-host');
 const match=/^\/video\/(BV[1-9A-HJ-NP-Za-km-z]{10})\/?$/.exec(u.pathname);if(!match)throw Error('bilibili-video-link-required');
 const values=u.searchParams.getAll('p');if(values.length>1||values[0]!==undefined&&!/^[1-9]\d{0,2}$/.test(values[0]))throw Error('invalid-video-page');
 const page=values.length?Number(values[0]):1;if(page>100)throw Error('invalid-video-page');
 return {bvid:match[1],page,url:'https://www.bilibili.com/video/'+match[1]+'/'+(page!==1?'?p='+page:'')};
}
export async function resolveBilibiliReference(input,{signal,resolver=lookup,transport=securePublicRequest}={}){
 const original=parseBilibiliReference(input);if(!original.short)return {...original,requested_url:original.url,redirects:[],search_substitute:false};
 const active=signal?AbortSignal.any([signal,AbortSignal.timeout(20000)]):AbortSignal.timeout(20000),seen=new Set(),redirects=[];let current=original;
 for(let hop=0;hop<4;hop++){
  active.throwIfAborted();if(seen.has(current.url))throw Error('bilibili-short-link-loop');seen.add(current.url);
  const url=new URL(current.url),addresses=await abortable(()=>resolver(url.hostname,{all:true,verbatim:true}),active);active.throwIfAborted();
  if(!Array.isArray(addresses)||!addresses.length||addresses.some(a=>!publicInternetAddress(a.address)||a.family!==isIP(a.address)))throw Error('unsafe-public-dns');
  const response=await abortable(()=>transport(url,{address:addresses.find(a=>a.family===4)??addresses[0],signal:active,maxBytes:16000,requestHeaders:{'User-Agent':'Mozilla/5.0 (PersonalAgent public link resolver)','Referer':'https://www.bilibili.com/'}}),active);
  active.throwIfAborted();
  if(response.redirected||response.url&&response.url!==url.href)throw Error('unverified-bilibili-redirect');
  if(![301,302,303,307,308].includes(response.status)){void response.body?.cancel().catch(()=>{});throw Error('bilibili-short-link-http-'+response.status);}
  const location=response.headers.get('location');if(!location)throw Error('bilibili-short-link-no-location');
  const next=parseBilibiliReference(new URL(location,url).href);redirects.push({from:current.url,to:next.url});
  if(!next.short)return {...next,requested_url:original.url,redirects,search_substitute:false};current=next;
 }
 throw Error('bilibili-short-link-redirect-limit');
}
