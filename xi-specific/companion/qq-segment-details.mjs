// Descriptive only: no network, file access, script execution, entity resolution
// or authority decisions. The transport keeps the original segment type/order.
import faceMap from './qq-face-map.json' with {type:'json'};
const CARD_LIMIT=65536,VALUE_LIMIT=8192,MAX_NODES=512,MAX_DEPTH=12;
const secretKey=/token|secret|password|authorization|cookie|credential|access.?key/i;
const own=(value,key)=>value&&typeof value==='object'&&!Array.isArray(value)?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
function scalar(value,limit=300){
 if(typeof value==='number')return Number.isFinite(value)?value:null;
 if(typeof value==='boolean')return value;
 if(typeof value!=='string')return null;
 return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'').slice(0,limit);
}
function field(value,limit=VALUE_LIMIT){
 if(value==null||value==='')return {status:'missing',value:null};
 if(typeof value!=='string')return {status:'unsupported-value-type',value:null};
 const clean=scalar(value,value.length).trim();
 if(!clean)return {status:'missing',value:null};
 return {status:clean.length>limit?'truncated':'present',value:clean.slice(0,limit),...(clean.length>limit?{original_chars:clean.length}:{}),untrusted_content:true};
}
function number(value){const n=typeof value==='number'?value:typeof value==='string'&&/^\d+(?:\.\d+)?$/.test(value)?Number(value):NaN;return Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER?n:null;}
function first(...values){return values.find(v=>v!==undefined&&v!==null&&v!=='');}
function link(value){
 if(typeof value!=='string'||!value.trim())return {status:'missing',value:null,fetched:false};
 value=value.trim();if(value.length>4096)return {status:'rejected',reason:'url-length-limit',value:null,fetched:false};
 let parsed;try{parsed=new URL(value);}catch{return {status:'rejected',reason:'invalid-url',value:scalar(value,300),fetched:false};}
 if(parsed.username||parsed.password)return {status:'rejected',reason:'url-contains-credentials',value:null,fetched:false};
 if(!['http:','https:'].includes(parsed.protocol))return {status:'unsupported-scheme',scheme:parsed.protocol,value:null,fetched:false};
 const host=parsed.hostname.toLowerCase().replace(/^\[|\]$/g,'');
 const nonpublic=/^(?:localhost|localhost\.|0\.|10\.|127\.|169\.254\.|192\.168\.|172\.(?:1[6-9]|2\d|3[01])\.|::|::1$|f[cd][0-9a-f]{2}:|fe[89ab][0-9a-f]:)/i.test(host)||!host.includes('.')&&!host.includes(':');
 return {status:nonpublic?'nonpublic-address-unfetched':'http-url-unfetched',value:parsed.href,fetched:false,network_verified:false,automatic_fetch:false};
}
function safeJson(raw){
 if(typeof raw==='string'){
  if(raw.length>CARD_LIMIT)return {error:'card-size-limit'};
  try{raw=JSON.parse(raw);}catch{return {error:'invalid-json'};}
 }
 if(!raw||typeof raw!=='object'||Array.isArray(raw))return {error:'json-card-not-object'};
 let nodes=0,chars=0;const seen=new Set();
 const visit=(value,depth)=>{
  if(++nodes>MAX_NODES||depth>MAX_DEPTH)throw Error('json-structure-limit');
  if(typeof value==='string'){chars+=value.length;if(chars>CARD_LIMIT)throw Error('card-size-limit');return;}
  if(value&&typeof value==='object'){
   if(seen.has(value))throw Error('cyclic-json-value');seen.add(value);
   const keys=Object.keys(value);if(keys.length>128)throw Error('json-structure-limit');
   for(const key of keys){chars+=key.length;if(chars>CARD_LIMIT)throw Error('card-size-limit');const descriptor=Object.getOwnPropertyDescriptor(value,key);if(!descriptor||descriptor.get||descriptor.set)throw Error('json-accessor-not-supported');visit(descriptor.value,depth+1);}
   seen.delete(value);
  }
 };
 try{visit(raw,0);}catch(error){return {error:error.message};}return {value:raw};
}
function cardJson(data){
 const result=safeJson(first(own(data,'data'),own(data,'json'),own(data,'content')));
 if(result.error)return {details:{card:{format:'json',parse_status:'rejected',title:field(null),body:field(null),link:link(null)}},understanding:{status:'rejected',reason:result.error}};
 const root=result.value,meta=own(root,'meta'),sections=[];
 if(meta&&typeof meta==='object'&&!Array.isArray(meta)){
  for(const key of ['detail_1','detail','news','mannounce','music','video'])if(own(meta,key)&&typeof own(meta,key)==='object')sections.push(own(meta,key));
  const keys=Object.keys(meta);if(keys.length===1&&!sections.includes(own(meta,keys[0])))sections.push(own(meta,keys[0]));
 }
 const values=(...keys)=>sections.flatMap(section=>keys.map(key=>own(section,key)));
 const title=field(first(...values('title','name'),own(root,'title'),own(root,'prompt')),500);
 const body=field(first(...values('desc','summary','text','content'),own(root,'desc'),own(root,'text'),own(root,'summary')));
 const target=link(first(...values('qqdocurl','url','jumpUrl','jump_url','jumpurl','targetUrl','target_url'),own(root,'url'),own(root,'jumpUrl')));
 return {details:{card:{format:'json',parse_status:'parsed-selected-fields',app:scalar(own(root,'app'),150),view:scalar(own(root,'view'),100),title,body,link:target,external_content_read:false,complete_document:false}},understanding:{status:title.value||body.value?'text-extracted':'metadata-only',reason:title.value||body.value?'selected-card-fields-only':'no-recognized-card-text'}};
}
function xmlDecode(value){
 return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi,(_,entity)=>{
  const fixed={amp:'&',lt:'<',gt:'>',quot:'"',apos:"'"};if(Object.hasOwn(fixed,entity))return fixed[entity];
  const n=entity.toLowerCase().startsWith('#x')?Number.parseInt(entity.slice(2),16):Number.parseInt(entity.slice(1),10);
  return Number.isInteger(n)&&n>0&&n<=0x10ffff&&!(n>=0xd800&&n<=0xdfff)?String.fromCodePoint(n):'�';
 });
}
// A deliberately small non-expanding XML recognizer. It validates nesting and
// bounded tag count; DTDs, ENTITY declarations, custom entities and declarations
// other than the XML prolog are rejected before text extraction.
function inspectXml(raw){
 if(typeof raw!=='string'||!raw.trim())return {error:'missing-xml-card'};
 if(raw.length>CARD_LIMIT)return {error:'card-size-limit'};
 if(/<!\s*(?:DOCTYPE|ENTITY)\b/i.test(raw)||/\b(?:SYSTEM|PUBLIC)\s+["']/i.test(raw))return {error:'xml-dtd-or-entity-forbidden'};
 if(/&(?!amp;|lt;|gt;|quot;|apos;|#\d+;|#x[0-9a-f]+;)/i.test(raw))return {error:'xml-custom-entity-forbidden'};
 const stack=[],tags=[];let pos=0,count=0,roots=0;
 while(pos<raw.length){
  const start=raw.indexOf('<',pos);if(start<0){if(!stack.length&&raw.slice(pos).trim())return {error:'malformed-xml'};break;}
  if(!stack.length&&raw.slice(pos,start).trim())return {error:'malformed-xml'};
  if(raw.startsWith('<!--',start)){const end=raw.indexOf('-->',start+4);if(end<0)return {error:'malformed-xml'};pos=end+3;continue;}
  if(raw.startsWith('<![CDATA[',start)){if(!stack.length)return {error:'malformed-xml'};const end=raw.indexOf(']]>',start+9);if(end<0)return {error:'malformed-xml'};pos=end+3;continue;}
  if(raw.startsWith('<?',start)){const end=raw.indexOf('?>',start+2);if(end<0||!/^<\?xml\s/i.test(raw.slice(start,end+2))||roots)return {error:'xml-processing-instruction-forbidden'};pos=end+2;continue;}
  let end=start+1,quote=null;
  for(;end<raw.length;end++){const c=raw[end];if(quote){if(c===quote)quote=null;}else if(c==='"'||c==="'")quote=c;else if(c==='>')break;}
  if(end>=raw.length||++count>MAX_NODES)return {error:end>=raw.length?'malformed-xml':'xml-structure-limit'};
  const token=raw.slice(start+1,end),closing=token.startsWith('/'),match=token.match(/^\/?([a-z_][\w:.-]*)(?=\s|\/|$)/i);if(!match)return {error:'malformed-xml'};
  const name=match[1];if(closing){if(!/^\/[a-z_][\w:.-]*\s*$/i.test(token)||stack.pop()!==name)return {error:'malformed-xml'};}
  else{const tail=token.slice(name.length);if(!/^(?:\s+[a-z_][\w:.-]*\s*=\s*(?:"[^"]*"|'[^']*'))*\s*\/?\s*$/i.test(tail))return {error:'malformed-xml'};if(!stack.length&&++roots>1)return {error:'malformed-xml'};tags.push({name,token,start,end});if(!/\/\s*$/.test(token)){stack.push(name);if(stack.length>MAX_DEPTH)return {error:'xml-structure-limit'};}}
  pos=end+1;
 }
 if(stack.length||roots!==1)return {error:'malformed-xml'};return {value:raw,tags};
}
function cardXml(data){
 const result=inspectXml(first(own(data,'data'),own(data,'xml'),own(data,'content')));
 const empty={format:'xml',parse_status:'rejected',title:field(null),body:field(null),link:link(null)};
 if(result.error)return {details:{card:empty},understanding:{status:'rejected',reason:result.error}};
 const raw=result.value;
 const tagText=name=>{const re=new RegExp('<'+name+'(?:\\s[^>]*)?>([\\s\\S]*?)<\\/'+name+'\\s*>','i'),match=raw.match(re);if(!match)return null;const pieces=[];let pos=0;for(const cdata of match[1].matchAll(/<!\[CDATA\[([\s\S]*?)\]\]>/g)){pieces.push(xmlDecode(match[1].slice(pos,cdata.index).replace(/<[^>]*>/g,'')),cdata[1]);pos=cdata.index+cdata[0].length;}pieces.push(xmlDecode(match[1].slice(pos).replace(/<[^>]*>/g,'')));return pieces.join('');};
 const attribute=(name)=>{const candidate=result.tags.find(t=>['msg','item','url'].includes(t.name.toLowerCase())&&new RegExp('(?:^|\\s)'+name+'\\s*=','i').test(t.token));if(!candidate)return null;const match=candidate.token.match(new RegExp('(?:^|\\s)'+name+'\\s*=\\s*(["\'])([\\s\\S]*?)\\1','i'));return match?xmlDecode(match[2]):null;};
 const title=field(tagText('title'),500),body=field(first(tagText('summary'),tagText('description'),tagText('content'),tagText('desc'))),target=link(first(attribute('url'),attribute('href'),tagText('url')));
 return {details:{card:{format:'xml',parse_status:'parsed-selected-fields',subtype:scalar(first(own(data,'resid'),own(data,'id')),80),title,body,link:target,external_content_read:false,complete_document:false,entity_expansion:false}},understanding:{status:title.value||body.value?'text-extracted':'metadata-only',reason:title.value||body.value?'selected-card-fields-only':'no-recognized-card-text'}};
}
function media(data,type){
 const file=first(own(data,'name'),own(data,'filename'),own(data,'fileName'),own(data,'file_name'),own(data,'file'));
 const filename=typeof file==='string'&&!/^(?:https?:|base64:|data:)/i.test(file)?file.split(/[\\/]/).at(-1):null;
 const metadata={name:field(filename,300),id:scalar(first(own(data,'file_id'),own(data,'fileId'),own(data,'id')),160),size:number(first(own(data,'file_size'),own(data,'fileSize'),own(data,'size'))),duration:number(first(own(data,'duration'),own(data,'length'))),width:number(own(data,'width')),height:number(own(data,'height')),url:link(first(own(data,'url'),own(data,'imageUrl'),typeof file==='string'&&/^https?:/i.test(file)?file:undefined)),thumbnail_url:link(first(own(data,'thumb'),own(data,'thumb_url'),own(data,'thumbUrl'))),content_read:false};
 if(['image','mface','bface','sface'].includes(type)){
  const emoji=scalar(first(own(data,'emoji_id'),own(data,'emojiId')),160),summary=field(first(own(data,'summary'),own(data,'text')),500),gif=typeof file==='string'&&/\.gif(?:$|[?#])/i.test(file)||typeof own(data,'url')==='string'&&/\.gif(?:$|[?#])/i.test(own(data,'url'));
  return {details:{media:{...metadata,summary,subtype:scalar(first(own(data,'sub_type'),own(data,'subType')),30),flash:own(data,'type')==='flash',sticker:!!emoji||type!=='image',emoji_id:emoji,emoji_package_id:scalar(first(own(data,'emoji_package_id'),own(data,'emojiPackageId')),80),animation:{status:gif?'gif-indicated-not-inspected':'unknown',actually_viewed:false,static_frame_is_full_animation:false},visual_understanding:false}},understanding:{status:'metadata-only',reason:'image-content-requires-intake-and-analysis-receipt'}};
 }
 if(type==='record')metadata.transcribed=false;
 if(type==='video'){metadata.actually_watched=false;metadata.transcribed=false;}
 return {details:{media:metadata},understanding:{status:'metadata-only',reason:type==='record'?'audio-not-transcribed':type==='video'?'video-not-watched':'file-content-not-read'}};
}
const knownRawKeys=new Set(['id','name','title','summary','text','label','type','sub_type','subType','file_id','fileId','file_size','size','width','height','duration','time','format','scene_type','fileset_id','filesetId']);
function unknown(data){const fields={};let omitted=0;for(const key of Object.keys(data).slice(0,64)){if(secretKey.test(key)||!knownRawKeys.has(key)){omitted++;continue;}const value=scalar(own(data,key),300);if(value===null){omitted++;continue;}fields[key]=value;if(Object.keys(fields).length>=16)break;}return {details:{raw_fields:fields,omitted_fields:omitted,raw_complete:false},understanding:{status:'not-understood',reason:'unsupported-segment-type'}};}

function nativeFace(data){
 const raw=first(own(data,'id'),own(data,'face_id'),own(data,'faceId'));
 const valid=typeof raw==='string'?/^\d{1,6}$/.test(raw):typeof raw==='number'&&Number.isSafeInteger(raw)&&raw>=0&&raw<=999999;
 const id=valid?String(Number(raw)):null,name=id!==null&&Object.hasOwn(faceMap.names,id)?faceMap.names[id]:null;
 return {details:{face_id:id,semantic_name:name,semantic_name_resolved:name!==null,known:name!==null,aliases:name?faceMap.aliases?.[id]??[]:[],large:[true,1,'1','true'].includes(own(data,'large')),representation:'native-face',image_attachment:false,visual_understanding:false,meaning_scope:'catalog-label-only; sender emotion and intent are not inferred',name_source:name?{kind:'pinned-native-face-map',version:faceMap.version}:null},understanding:{status:name?'semantic-label-resolved':'metadata-only',reason:name?'native-face-catalog-name':id===null?'invalid-or-missing-native-face-id':'unknown-native-face-id'}};
}

export function segmentDetails(segment){
 const sourceType=scalar(own(segment,'type'),80)??'unknown';let data=segment&&typeof segment==='object'&&!Array.isArray(segment)?own(segment,'data'):null;
 if(!data||typeof data!=='object'||Array.isArray(data))return {details:{source_type:sourceType},understanding:{status:'rejected',reason:'segment-data-not-object',untrusted_content:true,actions_authorized:false}};
 let result;
 try{
  if(sourceType==='json')result=cardJson(data);
  else if(sourceType==='xml')result=cardXml(data);
  else if(['image','mface','bface','sface','record','video','file'].includes(sourceType))result=media(data,sourceType);
  else if(['text','markdown'].includes(sourceType)){const text=field(first(own(data,'text'),own(data,'content')));result={details:{text},understanding:{status:text.value?'text-extracted':'metadata-only',reason:text.status==='truncated'?'text-size-limit':text.value?'literal-text-only':'missing-text'}};}
  else if(sourceType==='share'){const title=field(own(data,'title'),500),body=field(first(own(data,'content'),own(data,'summary')));result={details:{card:{format:'share',title,body,link:link(own(data,'url')),external_content_read:false}},understanding:{status:title.value||body.value?'text-extracted':'metadata-only',reason:'share-metadata-only'}};}
  else if(sourceType==='face')result=nativeFace(data);
  else if(sourceType==='at')result={details:{target:scalar(first(own(data,'qq'),own(data,'targetUin')),30),identity_authority:'transport-resolved-by-caller'},understanding:{status:'metadata-only',reason:'target-is-not-a-quoted-display-name'}};
  else if(sourceType==='reply')result={details:{quoted_message_id:scalar(first(own(data,'id'),own(data,'replyMessageId')),100),embedded_preview:own(data,'message')!=null?'present-untrusted-not-authority':'absent',reference_lookup:'required'},understanding:{status:'metadata-only',reason:'reference-requires-source-bound-lookup'}};
  else if(sourceType==='forward')result={details:{forward_id:scalar(first(own(data,'id'),own(data,'res_id'),own(data,'forward_id')),240),nodes_expanded:false},understanding:{status:'metadata-only',reason:'forward-nodes-not-expanded'}};
  else if(sourceType==='node')result={details:{display_name:scalar(first(own(data,'name'),own(data,'nickname')),100),claimed_sender_id:scalar(first(own(data,'uin'),own(data,'user_id'),own(data,'qq')),30),claimed_time:scalar(own(data,'time'),50),node_content_present:own(data,'content')!=null,identity_verified:false},understanding:{status:'metadata-only',reason:'forward-node-is-quoted-material-not-transport-identity'}};
  else if(sourceType==='inline_keyboard'){const rows=own(data,'rows');result={details:{button_rows:Array.isArray(rows)?Math.min(rows.length,30):null,interaction_performed:false},understanding:{status:'metadata-only',reason:'button-actions-not-executed'}};}
  else if(sourceType==='poke')result={details:{subtype:scalar(first(own(data,'type'),own(data,'sub_type')),30),action_performed:false},understanding:{status:'metadata-only',reason:'message-element-not-a-service-notice'}};
  else result=unknown(data);
 }catch{result={details:{},understanding:{status:'rejected',reason:'segment-metadata-unreadable'}};}
 return {details:{source_type:sourceType,...result.details},understanding:{...result.understanding,untrusted_content:true,actions_authorized:false}};
}
