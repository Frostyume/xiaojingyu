// Fixed-self QZone, text-only drafts and explicit publication. No cookie export,
// arbitrary OneBot tool, browser login, media fetch or automatic resend.
import {DatabaseSync} from 'node:sqlite';
import {createHash,randomUUID} from 'node:crypto';
import {qzoneReadback} from './qzone-readback.mjs';

import {trustedSelfId} from './installation-config.mjs';
const PRIVACY=Object.freeze({public:1,friends:4,self:64});
const MAX_TEXT=6000;
const messages={closed:'QZone service is closed',paused:'QZone actions are paused','not-authorized':'QZone action is not authorized','identity-mismatch':'Only the configured QQ account is permitted','login-error':'Current QQ identity could not be verified','api-error':'QZone API failed; this is not an empty page','invalid-response':'QZone returned an unverified response shape','invalid-input':'Invalid fixed-self QZone argument','draft-not-found':'Saved QZone draft was not found','version-conflict':'Draft changed; read its current version','draft-locked':'This draft already has a sending, verified or uncertain attempt','duplicate-publication':'The same content and privacy already has a sent or uncertain attempt; inspect the receipt instead of resending','readback-unconfirmed':'The returned post ID/content was not confirmed by both detail and own list','context-denied':'This conversation no longer authorizes the tool'};
const fault=code=>Object.assign(Error(messages[code]??messages['api-error']),{code});
const fields=(value,keys)=>{if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(key=>!keys.includes(key)))throw fault('invalid-input');};
const integer=(value,min,max)=>Number.isSafeInteger(value)&&value>=min&&value<=max;
const tid=value=>typeof value==='string'&&value.length>0&&value.length<=200&&!/[\u0000-\u001f\u007f]/.test(value);
const digest=(content,privacy)=>createHash('sha256').update(JSON.stringify({content,privacy})).digest('hex');
function input(content,privacy){
 if(typeof content!=='string'||!content.trim()||content.length>MAX_TEXT||!Object.hasOwn(PRIVACY,privacy))throw fault('invalid-input');
 content=content.replace(/\r\n/g,'\n').trim();return {content,privacy,digest:digest(content,privacy)};
}
function text(value,max=20000){if(typeof value!=='string'||value.length>max)throw fault('invalid-response');return value;}
function time(value){if(!integer(value,0,Number.MAX_SAFE_INTEGER))throw fault('invalid-response');return value;}
function comment(value){
 if(!value||!integer(value.uin,1,Number.MAX_SAFE_INTEGER)||typeof value.comment_id!=='string'||value.comment_id!==''&&!tid(value.comment_id))throw fault('invalid-response');
 return {uin:value.uin,name:text(value.name,500),time:time(value.time),content:text(value.content),comment_id:value.comment_id||null,comment_id_known:value.comment_id!==''};
}
function listResult(value){
 if(!value||!integer(value.total,0,Number.MAX_SAFE_INTEGER)||!Array.isArray(value.msglist)||value.msglist.length>100)throw fault('invalid-response');
 return {total:value.total,msglist:value.msglist.map(post=>{
  if(!post||!tid(post.tid)||typeof post.is_private!=='boolean'||!Array.isArray(post.images)||post.images.length>100||!integer(post.comment_num,0,Number.MAX_SAFE_INTEGER))throw fault('invalid-response');
  return {tid:post.tid,content:text(post.content),time:time(post.time),time_known:post.time>0,comment_num:post.comment_num,is_private:post.is_private,images:post.images.map(url=>text(url,8192))};
 })};
}
function detailResult(value,expectedTid){
 if(!value||value.tid!==expectedTid||!integer(value.comment_num,0,Number.MAX_SAFE_INTEGER)||!Array.isArray(value.comments)||value.comments.length>100)throw fault('invalid-response');
 return {tid:expectedTid,content:text(value.content),comment_num:value.comment_num,comments:value.comments.map(item=>{
  if(!Array.isArray(item.replies)||item.replies.length>100)throw fault('invalid-response');return {...comment(item),replies:item.replies.map(comment)};
 })};
}
export class QQSelfQZone{
 constructor({selfId,path,driver,authorize=async()=>true,clock=()=>Date.now(),onVerified=async()=>{}}){
  Object.defineProperty(this,'selfId',{value:trustedSelfId(selfId),enumerable:false});
  if(typeof driver?.callApi!=='function')throw fault('invalid-input');
  Object.assign(this,{driver,authorize,clock,onVerified});this.paused=false;this.closed=false;this.queue=Promise.resolve();this.reads=new Set();this.closePromise=null;this.dbClosed=false;
  this.db=new DatabaseSync(path);this.db.exec(`PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS qzone_meta(key TEXT PRIMARY KEY,value TEXT);
   CREATE TABLE IF NOT EXISTS qzone_drafts(id TEXT PRIMARY KEY,version INTEGER,content TEXT,privacy TEXT,digest TEXT,state TEXT,created INTEGER,updated INTEGER);
   CREATE TABLE IF NOT EXISTS qzone_draft_versions(draft TEXT,version INTEGER,content TEXT,privacy TEXT,digest TEXT,at INTEGER,PRIMARY KEY(draft,version));
   CREATE TABLE IF NOT EXISTS qzone_operations(id TEXT PRIMARY KEY,draft TEXT,version INTEGER,digest TEXT,privacy TEXT,state TEXT,tid TEXT,receipt TEXT,error TEXT,at INTEGER,updated INTEGER);
   CREATE UNIQUE INDEX IF NOT EXISTS qzone_publication_digest ON qzone_operations(digest) WHERE state IN ('sending','verified','uncertain');
   CREATE TABLE IF NOT EXISTS qzone_reads(id TEXT PRIMARY KEY,kind TEXT,result TEXT,at INTEGER);`);
  const owner=this.db.prepare("SELECT value FROM qzone_meta WHERE key='self_id'").get()?.value;
  if(owner&&owner!==this.selfId){this.db.close();throw fault('identity-mismatch');}
  this.db.prepare("INSERT OR IGNORE INTO qzone_meta VALUES('self_id',?)").run(this.selfId);
  const recovered=this.db.prepare("SELECT count(*) n FROM qzone_operations WHERE state='sending'").get().n;
  this.db.exec("UPDATE qzone_operations SET state='uncertain',error='service-restart-after-send-reservation' WHERE state='sending';UPDATE qzone_operations SET state='failed-before-send',error='service-restart-before-send' WHERE state='prepared';UPDATE qzone_drafts SET state='uncertain' WHERE EXISTS(SELECT 1 FROM qzone_operations o WHERE o.draft=qzone_drafts.id AND o.version=qzone_drafts.version AND o.state='uncertain');");
  if(recovered)this.remember('publication',{state:'uncertain',code:'service-restart-after-send-reservation',automatic_retry:false});
 }
 remember(key,value){this.db.prepare('INSERT OR REPLACE INTO qzone_meta VALUES(?,?)').run(key,JSON.stringify({...value,observed_at:this.clock()}));}
 remembered(key){const row=this.db.prepare('SELECT value FROM qzone_meta WHERE key=?').get(key);try{return row?JSON.parse(row.value):null;}catch{return null;}}
 failure(error){const code=Object.hasOwn(messages,error?.code)?error.code:'api-error';return {code,message:messages[code]};}
 async permission(){if(this.closed)throw fault('closed');if(this.paused)throw fault('paused');let allowed=false;try{allowed=await this.authorize();}catch{}if(!allowed)throw fault('not-authorized');if(this.closed)throw fault('closed');if(this.paused)throw fault('paused');}
 async identity(){
  await this.permission();let value;try{value=await this.driver.callApi('get_login_info',{});}catch{this.remember('login',{state:'login-error'});throw fault('login-error');}
  if(String(value?.user_id)!==this.selfId){this.remember('login',{state:'identity-mismatch'});throw fault('identity-mismatch');}
  await this.permission();this.remember('login',{state:'verified',self_id:this.selfId});return {self_id:this.selfId};
 }
 status(){
  if(this.dbClosed)return {self_id:this.selfId,state:'closed',paused:true};
  const read=this.remembered('read'),publication=this.remembered('publication');
  return {self_id:this.selfId,state:this.closed?'closed':this.paused?'paused':read?.state??'not-read',paused:this.paused,login:this.remembered('login'),read,publication,draft_states:Object.fromEntries(this.db.prepare('SELECT state,count(*) n FROM qzone_drafts GROUP BY state').all().map(row=>[row.state,row.n])),default_privacy:'public',privacy_values:{...PRIVACY},notice:'Default public means everyone can view a published post. Drafts are local; privacy may be public, friends or self. Status is a persisted observation, not a live login guarantee. No automatic publication/retry.'};
 }
 exclusive(job){const next=this.queue.catch(()=>{}).then(job);this.queue=next;return next;}
 trackRead(job){const promise=job();this.reads.add(promise);promise.finally(()=>this.reads.delete(promise)).catch(()=>{});return promise;}
 source(action,params){return {action,self_id:this.selfId,target_uin:Number(this.selfId),parameters:params,observed_at:this.clock(),owner_basis:'fixed target plus fresh get_login_info; response has no owner field',untrusted_content:true,actions_authorized:false};}
 readOwn(args={}){return this.trackRead(()=>this.inspect(args));}
 listOwn(args={}){return this.readOwn(args);}
 async inspect(args={}){
  try{
   fields(args,['tid','pos','num']);const {tid:postId=null,pos=0,num=20}=args;
   if(!integer(pos,0,1_000_000)||!integer(num,1,100)||postId!==null&&!tid(postId))throw fault('invalid-input');
   await this.identity();const action=postId===null?'get_qzone_msg_list':'get_qzone_msg_detail',params={...(postId===null?{}:{tid:postId}),target_uin:Number(this.selfId),pos,num};
   let raw;try{raw=await this.driver.callApi(action,params);}catch{throw fault('api-error');}
   if(JSON.stringify(raw)?.length>1_000_000)throw fault('invalid-response');
   const data=postId===null?listResult(raw):detailResult(raw,postId),source=this.source(action,params),result={ok:true,state:'read',kind:postId===null?'own-post-list':'own-post-detail',data,source,notice:postId===null?'Image URLs are returned facts and were not downloaded. total is not the number of rows on this page.':'Comment authors are historical claims, not the logged-in account. Inline replies may be incomplete; this response does not verify privacy, images or publication time.'};
   this.db.prepare('INSERT INTO qzone_reads VALUES(?,?,?,?)').run(randomUUID(),result.kind,JSON.stringify(result),this.clock());this.remember('read',{state:'read',kind:result.kind,action,items:postId===null?data.msglist.length:data.comments.length});return result;
  }catch(error){const failure=this.failure(error);if(!this.dbClosed)this.remember('read',{state:['identity-mismatch','login-error'].includes(failure.code)?failure.code:failure.code==='paused'||failure.code==='closed'?'unavailable':'api-failed',code:failure.code});return {ok:false,state:failure.code,error:failure,self_id:this.selfId,not_an_empty_page:true};}
 }
 row(id){if(typeof id!=='string'||!id||id.length>100)throw fault('invalid-input');const row=this.db.prepare('SELECT * FROM qzone_drafts WHERE id=?').get(id);if(!row)throw fault('draft-not-found');return row;}
 attempts(draftId){return this.db.prepare('SELECT * FROM qzone_operations WHERE draft=? ORDER BY at DESC,rowid DESC LIMIT 10').all(draftId).map(row=>{let receipt=null;try{receipt=row.receipt?JSON.parse(row.receipt):null;}catch{}return {operation_id:row.id,draft_version:row.version,state:row.state,tid:row.tid,recorded_at:row.at,updated_at:row.updated,error_code:row.error,receipt,automatic_retry:false};});}
 view(row){const published=row.state==='verified'?true:['sending','uncertain'].includes(row.state)?null:false;return {draft_id:row.id,version:row.version,content:row.content,privacy:row.privacy,ugc_right:PRIVACY[row.privacy],state:row.state,digest:row.digest,created_at:row.created,updated_at:row.updated,local_draft:true,local_only:published===false,published,default_privacy:'public'};}
 draft(args){return this.exclusive(async()=>{
  try{
   fields(args,['draft_id','expected_version','content','privacy']);await this.permission();
   const previous=args.draft_id===undefined?null:this.row(args.draft_id);
   if(previous&&(!integer(args.expected_version,1,Number.MAX_SAFE_INTEGER)||previous.version!==args.expected_version))throw fault('version-conflict');
   if(previous&&!['draft','failed-before-send'].includes(previous.state))throw fault('draft-locked');
   if(!previous&&args.expected_version!==undefined)throw fault('invalid-input');
   const data=input(args.content,args.privacy===undefined?previous?.privacy??'public':args.privacy),id=previous?.id??randomUUID(),version=(previous?.version??0)+1,at=this.clock();
   this.db.exec('BEGIN IMMEDIATE');try{
    if(previous){const updated=this.db.prepare("UPDATE qzone_drafts SET version=?,content=?,privacy=?,digest=?,state='draft',updated=? WHERE id=? AND version=? AND state IN ('draft','failed-before-send')").run(version,data.content,data.privacy,data.digest,at,id,previous.version);if(!updated.changes)throw fault('version-conflict');}
    else this.db.prepare("INSERT INTO qzone_drafts VALUES(?,?,?,?,?,'draft',?,?)").run(id,version,data.content,data.privacy,data.digest,at,at);
    this.db.prepare('INSERT INTO qzone_draft_versions VALUES(?,?,?,?,?,?)').run(id,version,data.content,data.privacy,data.digest,at);this.db.exec('COMMIT');
   }catch(error){this.db.exec('ROLLBACK');throw error;}
   return {ok:true,state:'draft-saved',draft:this.view(this.row(id)),published:false,notice:'Saved locally only. Publishing defaults to public unless friends/self was selected; no per-post extra approval is required by this module.'};
  }catch(error){return {ok:false,state:'draft-rejected',error:this.failure(error),published:false};}
 });}
 readDraft(id,{version}={}){try{if(this.dbClosed)throw fault('closed');const row=this.row(id);if(version===undefined)return {ok:true,draft:this.view(row),attempts:this.attempts(id)};if(!integer(version,1,Number.MAX_SAFE_INTEGER))throw fault('invalid-input');const saved=this.db.prepare('SELECT * FROM qzone_draft_versions WHERE draft=? AND version=?').get(id,version);if(!saved)throw fault('draft-not-found');return {ok:true,draft:{draft_id:id,version:saved.version,content:saved.content,privacy:saved.privacy,ugc_right:PRIVACY[saved.privacy],digest:saved.digest,saved_at:saved.at,historical:true,local_draft_snapshot:true,publication_basis:'inspect matching attempt receipts; a local snapshot is not evidence of unsent status'},attempts:this.attempts(id).filter(row=>row.draft_version===version)};}catch(error){return {ok:false,error:this.failure(error)};}}
 listDrafts({offset=0,limit=20}={}){try{if(this.dbClosed)throw fault('closed');if(!integer(offset,0,1_000_000)||!integer(limit,1,30))throw fault('invalid-input');const total=this.db.prepare('SELECT count(*) n FROM qzone_drafts').get().n;return {ok:true,drafts:this.db.prepare('SELECT * FROM qzone_drafts ORDER BY updated DESC,rowid DESC LIMIT ? OFFSET ?').all(limit,offset).map(row=>this.view(row)),total,next_offset:offset+limit<total?offset+limit:null};}catch(error){return {ok:false,error:this.failure(error)};}}
 publish(draftId,expectedVersion){return this.exclusive(()=>this.applyPublication(draftId,expectedVersion));}
 async applyPublication(draftId,expectedVersion){
  let draft,operationId=null,attempted=false,postId=null,readback=null;
  try{
   if(this.closed)throw fault('closed');draft=this.row(draftId);if(!integer(expectedVersion,1,Number.MAX_SAFE_INTEGER)||draft.version!==expectedVersion)throw fault('version-conflict');
   if(!['draft','failed-before-send'].includes(draft.state))throw fault('draft-locked');
   if(this.db.prepare("SELECT 1 FROM qzone_operations WHERE digest=? AND state IN ('sending','verified','uncertain')").get(draft.digest))throw fault('duplicate-publication');
   operationId=randomUUID();const at=this.clock();this.db.prepare("INSERT INTO qzone_operations VALUES(?,?,?,?,?,'prepared',NULL,NULL,NULL,?,?)").run(operationId,draft.id,draft.version,draft.digest,draft.privacy,at,at);
   await this.identity();await this.permission();
   this.db.exec('BEGIN IMMEDIATE');try{
    if(this.db.prepare("SELECT 1 FROM qzone_operations WHERE digest=? AND state IN ('sending','verified','uncertain')").get(draft.digest))throw fault('duplicate-publication');
    const claim=this.db.prepare("UPDATE qzone_drafts SET state='sending',updated=? WHERE id=? AND version=? AND state IN ('draft','failed-before-send')").run(this.clock(),draft.id,draft.version);if(!claim.changes)throw fault('version-conflict');
    this.db.prepare("UPDATE qzone_operations SET state='sending',updated=? WHERE id=?").run(this.clock(),operationId);this.db.exec('COMMIT');
   }catch(error){this.db.exec('ROLLBACK');throw error;}
   attempted=true;this.remember('publication',{state:'sending',operation_id:operationId,draft_id:draft.id});
   let sent;try{sent=await this.driver.callApi('send_qzone_msg',{content:draft.content,ugc_right:PRIVACY[draft.privacy]});}catch{throw fault('api-error');}
   if(!sent||!tid(sent.tid)||!integer(sent.time,0,Number.MAX_SAFE_INTEGER))throw fault('invalid-response');postId=sent.tid;
   this.db.prepare('UPDATE qzone_operations SET tid=?,updated=? WHERE id=?').run(postId,this.clock(),operationId);
   const detail=await this.inspect({tid:postId,pos:0,num:1}),list=await this.inspect({pos:0,num:20});
   const listed=list.ok?list.data.msglist.find(item=>item.tid===postId):null;
   readback=qzoneReadback({postId,expectedContent:draft.content,detail,list},{selfId:this.selfId});
   if(!readback.verified)throw fault('readback-unconfirmed');
   const receipt={operation_id:operationId,draft_id:draft.id,draft_version:draft.version,self_id:this.selfId,tid:postId,content:draft.content,requested_privacy:draft.privacy,requested_ugc_right:PRIVACY[draft.privacy],privacy_verified:false,server_time:sent.time,server_time_known:sent.time>0,verified_at:this.clock(),verification:{detail_tid:true,detail_content:true,list_tid:true,list_content:true,privacy:false,images:'not-verified-text-only-request'},sources:[detail.source,list.source],automatic_retry:false};
   receipt.readback=readback;receipt.confirmed_content=detail.data.content;
   this.db.exec('BEGIN IMMEDIATE');try{this.db.prepare("UPDATE qzone_operations SET state='verified',receipt=?,error=NULL,updated=? WHERE id=?").run(JSON.stringify(receipt),this.clock(),operationId);this.db.prepare("UPDATE qzone_drafts SET state='verified',updated=? WHERE id=? AND version=?").run(this.clock(),draft.id,draft.version);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
   this.remember('publication',{state:'verified',operation_id:operationId,draft_id:draft.id,tid:postId,content_readback_verified:true,privacy_verified:false});
   try{await this.onVerified(receipt);}catch{receipt.postprocessing='failed-result-preserved';try{this.db.prepare('UPDATE qzone_operations SET receipt=? WHERE id=?').run(JSON.stringify(receipt),operationId);}catch{}}
   return {ok:true,state:'verified',receipt,notice:'Server returned a post ID and both fixed-self detail/list confirmed its content. Requested privacy was sent, but this interface does not independently verify it. No automatic resend.'};
  }catch(error){
   const failure=this.failure(error),state=attempted?'uncertain':'failed-before-send';
   if(operationId){this.db.prepare('UPDATE qzone_operations SET state=?,tid=COALESCE(?,tid),error=?,receipt=?,updated=? WHERE id=?').run(state,postId,failure.code,readback?JSON.stringify({state,readback}):null,this.clock(),operationId);this.db.prepare("UPDATE qzone_drafts SET state=?,updated=? WHERE id=? AND version=? AND state IN ("+(attempted?"'sending'":"'draft','failed-before-send'")+")").run(state,this.clock(),draft.id,draft.version);}
   if(!this.dbClosed)this.remember('publication',{state,operation_id:operationId,draft_id:draft?.id??null,tid:postId,code:failure.code,automatic_retry:false});
   return {ok:false,state,operation_id:operationId,draft_id:draft?.id??null,tid:postId,error:failure,may_have_published:attempted,not_retried:true,notice:attempted?'Publication or confirmation was uncertain. Inspect this receipt/current own posts; do not resend the same content/privacy.':'No publish API call was made in this attempt. A safe draft may be revised using its current version.'};
  }
 }
 reconcile(operationId){return this.exclusive(async()=>{
  try{
   if(typeof operationId!=='string'||!operationId||operationId.length>100)throw fault('invalid-input');await this.permission();
   const row=this.db.prepare('SELECT o.*,v.content FROM qzone_operations o JOIN qzone_draft_versions v ON v.draft=o.draft AND v.version=o.version WHERE o.id=?').get(operationId);if(!row)throw fault('draft-not-found');
   if(row.state==='verified')return {ok:true,state:'verified',receipt:JSON.parse(row.receipt),already_confirmed:true,new_read_performed:false,notice:'Previously confirmed receipt, not a new publication or a fresh platform read.'};
   if(row.state!=='uncertain'||!tid(row.tid))return {ok:false,state:row.state,may_have_published:row.state==='uncertain',not_retried:true,reason:row.tid?'not-an-uncertain-attempt':'No returned post ID; text similarity cannot bind a publication. Inspect independent post-ID evidence, never resend.'};
   const detail=await this.inspect({tid:row.tid,pos:0,num:1}),list=await this.inspect({pos:0,num:100}),readback=qzoneReadback({postId:row.tid,expectedContent:row.content,detail,list},{selfId:this.selfId});
   if(!readback.verified){this.db.prepare('UPDATE qzone_operations SET receipt=?,error=?,updated=? WHERE id=? AND state=\'uncertain\'').run(JSON.stringify({state:'uncertain',readback}),'readback-unconfirmed',this.clock(),operationId);return {ok:false,state:'uncertain',operation_id:operationId,tid:row.tid,readback,may_have_published:true,not_retried:true,new_send_performed:false};}
   const observed=list.data.msglist.find(p=>p.tid===row.tid),now=this.clock(),receipt={operation_id:operationId,draft_id:row.draft,draft_version:row.version,self_id:this.selfId,tid:row.tid,content:row.content,confirmed_content:detail.data.content,requested_privacy:row.privacy,requested_ugc_right:PRIVACY[row.privacy],privacy_verified:false,server_time:observed.time,server_time_known:observed.time>0,server_time_source:'own-post-list-reported-time',original_operation_at:row.at,verified_at:now,reconciled_at:now,reconciled:true,readback,verification:{detail_tid:true,detail_content:true,list_tid:true,list_content:true,privacy:false,images:'not-verified-text-only-request'},sources:[detail.source,list.source],automatic_retry:false};
   this.db.exec('BEGIN IMMEDIATE');try{const changed=this.db.prepare("UPDATE qzone_operations SET state='verified',receipt=?,error=NULL,updated=? WHERE id=? AND state='uncertain'").run(JSON.stringify(receipt),now,operationId);if(!changed.changes)throw fault('version-conflict');this.db.prepare("UPDATE qzone_drafts SET state='verified',updated=? WHERE id=? AND version=?").run(now,row.draft,row.version);this.db.exec('COMMIT');}catch(error){this.db.exec('ROLLBACK');throw error;}
   this.remember('publication',{state:'verified',operation_id:operationId,draft_id:row.draft,tid:row.tid,operation_at:row.at,reconciled:true,content_readback_verified:true,privacy_verified:false});
   try{await this.onVerified(receipt);}catch{receipt.postprocessing='failed-result-preserved';}
   return {ok:true,state:'verified',receipt,new_send_performed:false,notice:'The existing returned post ID was confirmed by fixed-own detail/list and text evidence; only line separators may differ. No publication API was called.'};
  }catch(error){return {ok:false,state:'reconcile-failed',error:this.failure(error),new_send_performed:false,not_retried:true};}
 });}
 tools(context={}){
  const tool=(name,description,properties,required,mutation,handler)=>({name,description,mutation,parameters:{type:'object',properties,required,additionalProperties:false},handler:async(args={})=>{try{fields(args,Object.keys(properties));if(required.some(key=>!Object.hasOwn(args,key)))throw fault('invalid-input');if(context.authorize&&!await context.authorize())throw fault('context-denied');return JSON.stringify(await handler(args));}catch(error){return JSON.stringify({ok:false,error:this.failure(error)});}}});
  const id={type:'string'},version={type:'integer',minimum:1},privacy={type:'string',enum:['public','friends','self']};
  return [
   tool('qzone_status','Read persisted capability/read/login/publication state for your own QZone, not a fresh login probe. Defaults: public=everyone; friends and self are optional. An uncertain send must not be retried.',{},[],false,()=>this.status()),
   tool('qzone_read','Read your own QZone list or one known post plus one comment page. Fresh fixed-account identity is checked; target cannot be chosen. Image URLs are not downloaded; comment authors are historical claims. Errors are not empty pages.',{tid:id,pos:{type:'integer',minimum:0,maximum:1000000},num:{type:'integer',minimum:1,maximum:100}},[],false,args=>this.readOwn(args)),
   tool('qzone_reconcile','Only re-read and confirm an existing uncertain operation by its original returned post ID. Never publishes or retries a send. Requires fixed-own detail/list, exact tid and exact text or CRLF/CR/LF separator difference only; missing post IDs cannot be guessed from matching text.',{operation_id:id},['operation_id'],false,args=>this.reconcile(args.operation_id)),
   tool('qzone_draft','Save/edit a local text-only QZone draft. Existing drafts require expected_version. Default privacy public means everyone; friends=QQ friends, self=only you. This does not publish. Sending/verified/uncertain drafts remain frozen.',{draft_id:id,expected_version:version,content:{type:'string',maxLength:MAX_TEXT},privacy},['content'],true,args=>this.draft(args)),
   tool('qzone_drafts','Read local drafts or an immutable historical draft version, without publishing or network. IDs and versions permit exact inspection and CAS edits.',{draft_id:id,version,offset:{type:'integer',minimum:0,maximum:1000000},limit:{type:'integer',minimum:1,maximum:30}},[],false,args=>args.draft_id?this.readDraft(args.draft_id,{version:args.version}):this.listDrafts({offset:args.offset,limit:args.limit})),
   tool('qzone_publish','Publish the exact saved text-only draft/version to your own QZone now. No extra per-post approval gate. Default public is everyone; inspect draft privacy first. Durable dedupe blocks already sent/uncertain content+privacy. Verified means both detail and list confirmed tid/content; privacy itself is not independently verified.',{draft_id:id,expected_version:version},['draft_id','expected_version'],true,args=>this.publish(args.draft_id,args.expected_version))
  ];
 }
 async pause(){this.paused=true;await this.queue.catch(()=>{});await Promise.allSettled([...this.reads]);}
 resume(){if(!this.closed)this.paused=false;}
 close(){if(this.closePromise)return this.closePromise;this.closed=true;return this.closePromise=(async()=>{await this.pause();this.db.close();this.dbClosed=true;})();}
}
