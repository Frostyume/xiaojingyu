import {createHash,randomUUID} from 'node:crypto';

const SOURCE='life-journal',PREFIX='journal:';
const types=new Set(['activity','daily-review']);
const qqIncoming=new Set(['live-transport','admitted-transport','referenced-qq-api','conversation-turns','admitted-poke-transport','received-qq-forward-node']);
const qqOutgoing=new Set(['acknowledged-delivery','acknowledged-qq-outgoing','isolated-qq-outgoing','conversation-turns']);
const ownObserved=new Set(['public-exploration','verified-workshop-result','own-workroom-change','verified-own-qzone-read','verified-own-qzone-publication','observed-public-sticker','verified-own-profile-result']);
const qqScope=scope=>/^(?:group|private):\d{5,15}$/.test(scope);
const archivedQQ=source=>/^qq-history-pages\/\d{5,15}\.jsonl$/.test(source)||/^runs\/[A-Za-z0-9_-]{1,100}\/events\.jsonl$/.test(source);
function eligibleSource(record,source){
 if(record.role==='self')return ownObserved.has(source)&&(record.scope==='unknown'||source==='verified-workshop-result'&&qqScope(record.scope));
 if(!qqScope(record.scope))return false;
 return record.role==='user'&&(qqIncoming.has(source)||archivedQQ(source))||record.role==='assistant'&&(qqOutgoing.has(source)||archivedQQ(source));
}
const literal=text=>text.trim().replace(/\s+/g,' ');
const credentialPattern=/\bsk-[A-Za-z0-9_-]{12,}|\bBearer\s+[A-Za-z0-9._~+\/-]{12,}|(?:api[_-]?key|access[_-]?token|password|secret|cookie)\s*[:=]\s*["']?[A-Za-z0-9._~+\/-]{8,}|(?:身份证|手机号|电话|QQ(?:号)?|uin|sender_id|user_id)\s*[:：=]?\s*\d{5,20}|(?<!\d)[1-9]\d{5}(?:19|20)\d{2}(?:0[1-9]|1[0-2])(?:0[1-9]|[12]\d|3[01])\d{3}[\dXx](?!\d)/i;
const normalize=(value,max,name)=>{
 if(typeof value!=='string'||!value.trim()||value.length>max)throw Error('Invalid journal '+name);
 return value.trim().replace(/\s+/g,' ');
};
const bound=(value,fallback,max)=>{value??=fallback;if(!Number.isSafeInteger(value)||value<1||value>max)throw Error('Invalid journal bound');return value;};
const parse=text=>JSON.parse(text);
export function beijingJournalDay(at=Date.now()){
 if(!Number.isFinite(at)||at<0)throw Error('Invalid journal time');
 return new Date(at+8*3600000).toISOString().slice(0,10);
}

function interpretation(value={}){
 if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).some(k=>!['feeling','association','share'].includes(k)))throw Error('Invalid journal interpretation');
 const result={};
 if(value.feeling!==undefined)result.feeling=normalize(value.feeling,800,'feeling');
 if(value.association!==undefined)result.association=normalize(value.association,1000,'association');
 if(value.share!==undefined){
  const s=value.share;if(!s||typeof s!=='object'||Array.isArray(s)||Object.keys(s).some(k=>!['audience','reason'].includes(k)))throw Error('Invalid journal sharing thought');
  result.share={audience:normalize(s.audience,80,'audience'),reason:normalize(s.reason,400,'sharing reason')};
 }
 return result;
}

// Interpretation only, never a model reasoning trace. Facts remain in the
// existing ExperienceMemory; journal versions reuse its append-only self_state.
// API: record({kind,day?,evidence_ids,interpretation,public_text?});
// revise({id,expected_revision,reason,evidence_ids?,interpretation?,public_text?});
// get(id,{revision?}), history(id,{limit?}), list({day?,limit?}),
// recent({days?:2,limit?:6}), publicCandidates({days?:2,limit?:4}).
// public_text is a deliberately written self-expression, never an automatic
// quotation of interpretation or another person's QQ message. Retained QQ
// experiences can inspire it; that does not make their original content public.
// No per-entry approval, timer, provider, publishing or duplicate experience store.
export class LifeJournal{
 constructor({store,clock=()=>Date.now()}={}){
  if(!store?.db||typeof store.get!=='function'||typeof store.getState!=='function'||typeof store.setState!=='function'||typeof clock!=='function')throw Error('Journal requires the existing experience store');
  this.store=store;this.clock=clock;
 }
 day(value){
  const today=beijingJournalDay(this.clock()),day=value??today;
  if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||!Number.isFinite(Date.parse(day+'T00:00:00+08:00'))||beijingJournalDay(Date.parse(day+'T00:00:00+08:00'))!==day||day>today)throw Error('Invalid or future journal day');
  return day;
 }
 key(id){if(typeof id!=='string'||!/^journal:[a-f0-9-]{36}$/.test(id))throw Error('Invalid journal ID');return id;}
 atomic(write){
  this.store.db.exec('BEGIN IMMEDIATE');
  try{const result=write();this.store.db.exec('COMMIT');return result;}catch(error){this.store.db.exec('ROLLBACK');throw error;}
 }
 evidence(ids,previous=null){
  if(previous&&ids===undefined)return previous.map(ref=>({...ref}));
  if(!Array.isArray(ids)||!ids.length||ids.length>8||ids.some(id=>typeof id!=='string'||!/^exp-[a-f0-9]{32}$/.test(id)))throw Error('Journal needs 1–8 existing experience IDs');
  return [...new Set(ids)].sort().map(id=>{
   const record=this.store.get({id,maxChars:1});if(!record.found)throw Error('Journal evidence is not in the existing experience store');
   return {id,revision:record.revision,at:record.at,scope:record.scope,role:record.role,author_id:record.sender_id??null};
  });
 }
 publicationRecords(refs){
  if(!refs.length)return null;const records=[];
  for(const ref of refs){
   const record=this.store.get({id:ref.id,revision:ref.revision,maxChars:24000});if(!record.found)return null;
   // Inspect all provenance tags, not get()'s bounded provenance preview.
   const sources=this.store.db.prepare('SELECT DISTINCT source FROM experience_sources WHERE experience_id=? AND revision_id=?').all(ref.id,ref.revision);
   if(!sources.length||!sources.every(row=>eligibleSource(record,row.source)))return null;
   if(record.next_offset!==null)record.text=this.store.db.prepare('SELECT text FROM experience_versions WHERE experience_id=? AND id=?').get(ref.id,ref.revision).text;
   records.push(record);
  }
  return records;
 }
 publicEvidence(refs){
  // Eligibility to support her own expression; this never reclassifies QQ
  // messages or quoted claims as publicly shareable source text.
  return this.publicationRecords(refs)!==null;
 }
 validatePublicText(refs,publicText){
  const records=this.publicationRecords(refs);if(!records)throw Error('Public journal drafts require retained, connected experience sources');
  if(credentialPattern.test(publicText))throw Error('Public journal draft contains a credential or identity number');
  const identities=new Set();
  const collect=(value,depth=0)=>{if(!value||typeof value!=='object'||depth>6)return;for(const [key,item] of Object.entries(value)){if(/^(?:sender_id|user_id|target_id|actor_id|self_id|group_id|reported_id|operator_id|uin|qq)$/.test(key)&&/^\d{5,20}$/.test(String(item)))identities.add(String(item));if(item&&typeof item==='object')collect(item,depth+1);}};
  for(const record of records){
   if(record.sender_id)identities.add(String(record.sender_id));if(qqScope(record.scope))identities.add(record.scope.split(':')[1]);collect(record.metadata);
   let content;try{content=JSON.parse(record.text);collect(content);}catch{}
   const original=typeof content?.body==='string'?content.body:typeof content?.text==='string'?content.text:record.text;
   if(record.role==='user'&&qqScope(record.scope)&&literal(original)===literal(publicText))throw Error('Public journal draft must be independently written, not an original QQ message');
  }
  if([...identities].some(id=>new RegExp('(?<!\\d)'+id+'(?!\\d)').test(publicText)))throw Error('Public journal draft contains an identity number from its evidence');
 }
 value({kind,day,refs,thought,publicText,created,reason=null,previousRevision=null}){
  if(!types.has(kind))throw Error('Invalid journal kind');
  if(publicText!==null)this.validatePublicText(refs,publicText);
  const content={day,kind,evidence:refs,interpretation:thought,public_text:publicText};
  const value={journal_schema:1,...content,evidence_kind:'source-linked-self-interpretation',facts_are_source_references:true,
   interpretation_is_not_source_fact:true,created_at:created,revision_reason:reason,previous_revision:previousRevision,
   fingerprint:createHash('sha256').update(JSON.stringify(content)).digest('hex')};
  if(JSON.stringify(value).length>5600)throw Error('Journal entry is too large; keep a bounded reflection');
  return value;
 }
 rows({from,to,limit=8,kind,fingerprint}={}){
  const where=["s.kind='self'","s.source=?","substr(s.key,1,8)=?","json_valid(s.value)","json_extract(s.value,'$.journal_schema')=1","s.revision=(SELECT max(v.revision) FROM self_state v WHERE v.kind=s.kind AND v.key=s.key)"],args=[SOURCE,PREFIX];
  if(from!==undefined){where.push("json_extract(s.value,'$.day')>=?");args.push(from);}
  if(to!==undefined){where.push("json_extract(s.value,'$.day')<=?");args.push(to);}
  if(kind!==undefined){where.push("json_extract(s.value,'$.kind')=?");args.push(kind);}
  if(fingerprint!==undefined){where.push("json_extract(s.value,'$.fingerprint')=?");args.push(fingerprint);}
  return this.store.db.prepare('SELECT s.* FROM self_state s WHERE '+where.join(' AND ')+" ORDER BY json_extract(s.value,'$.day') DESC,s.at DESC,s.key LIMIT ?").all(...args,limit).map(row=>({...row,value:parse(row.value),evidence:parse(row.evidence)}));
 }
 view(row){
  if(!row||row.source!==SOURCE||row.value?.journal_schema!==1)return {found:false,reason:'journal-not-found'};
  const value=row.value;
  return {found:true,id:row.key,revision:row.revision,day:value.day,kind:value.kind,at:row.at,created_at:value.created_at,
   facts:{evidence:value.evidence,notice:'Pointers to original experience versions; quoted claims are not independently verified facts.'},
   interpretation:value.interpretation,interpretation_is_not_source_fact:true,public_text:value.public_text,
   previous_revision:value.previous_revision,revision_reason:value.revision_reason,published:false};
 }
 get(id,{revision}={}){
  const key=this.key(id);
  if(revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))throw Error('Invalid journal revision');
  if(revision!==undefined){const row=this.store.db.prepare("SELECT * FROM self_state WHERE kind='self' AND key=? AND revision=?").get(key,revision);return this.view(row?{...row,value:parse(row.value),evidence:parse(row.evidence)}:null);}
  return this.view(this.store.getState({kind:'self',key,limit:1})[0]);
 }
 record({kind='activity',day,evidence_ids,interpretation:requested={},public_text}={}){
  const thought=interpretation(requested);if(!Object.keys(thought).length)return {status:'skipped',reason:'no-self-interpretation-requested'};
  return this.atomic(()=>{
   const when=this.clock(),date=this.day(day),refs=this.evidence(evidence_ids),publicText=public_text==null?null:normalize(public_text,1000,'public draft');
   const value=this.value({kind,day:date,refs,thought,publicText,created:when});
   const duplicate=this.rows({from:date,to:date,limit:1,fingerprint:value.fingerprint})[0];
   if(duplicate)return {status:'duplicate',...this.view(duplicate)};
   if(kind==='daily-review'){
    const prior=this.rows({from:date,to:date,kind:'daily-review',limit:1})[0];if(prior)return {status:'requires-revision',reason:'daily-review-already-exists',id:prior.key,revision:prior.revision};
   }
   const key=PREFIX+randomUUID();const saved=this.store.setState({kind:'self',key,value,evidence:refs.map(r=>({type:'message',id:r.id})),at:when,source:SOURCE});
   return {status:'saved',...this.get(key,{revision:saved.revision})};
  });
 }
 revise({id,expected_revision,reason,evidence_ids,interpretation:requested,public_text}={}){
  const key=this.key(id);if(!Number.isSafeInteger(expected_revision)||expected_revision<1)throw Error('A journal revision needs the expected current revision');
  const why=normalize(reason,400,'revision reason');
  return this.atomic(()=>{
   const current=this.store.getState({kind:'self',key,limit:1})[0];
   if(!current||current.source!==SOURCE||current.value?.journal_schema!==1)throw Error('Journal entry not found');
   if(current.revision!==expected_revision)return {status:'conflict',reason:'journal-version-conflict',id:key,current_revision:current.revision};
   const old=current.value,thought=requested===undefined?old.interpretation:interpretation(requested);
   if(!Object.keys(thought).length)return {status:'skipped',reason:'no-self-interpretation-requested'};
   const refs=this.evidence(evidence_ids,old.evidence),publicText=public_text===undefined?old.public_text:public_text===null?null:normalize(public_text,1000,'public draft');
   const value=this.value({kind:old.kind,day:old.day,refs,thought,publicText,created:old.created_at,reason:why,previousRevision:current.revision});
   if(value.fingerprint===old.fingerprint)return {status:'duplicate',...this.view(current)};
   const saved=this.store.setState({kind:'self',key,value,evidence:refs.map(r=>({type:'message',id:r.id})),at:this.clock(),source:SOURCE});
   return {status:'saved',...this.get(key,{revision:saved.revision})};
  });
 }
 history(id,{limit=8}={}){return this.store.getState({kind:'self',key:this.key(id),history:true,limit:bound(limit,8,20)}).map(row=>this.view(row));}
 list({day,limit=6}={}){const date=this.day(day);return {day:date,entries:this.rows({from:date,to:date,limit:bound(limit,6,8)}).map(row=>this.view(row)),notice:'No entry is created by reading a day, including an empty day.'};}
 recent({days=2,limit=6}={}){
  days=bound(days,2,7);const now=this.clock(),from=beijingJournalDay(Math.max(0,now-(days-1)*86400000)),to=beijingJournalDay(now);
  return {from,to,entries:this.rows({from,to,limit:bound(limit,6,12)}).map(row=>this.view(row))};
 }
 publicCandidates({days=2,limit=4}={}){
  limit=bound(limit,4,8);const recent=this.recent({days,limit:12}),candidates=[];
  for(const entry of recent.entries){
   if(!entry.public_text)continue;
   try{this.validatePublicText(entry.facts.evidence,entry.public_text);}catch{continue;}
   candidates.push({journal_id:entry.id,revision:entry.revision,day:entry.day,text:entry.public_text,
    evidence:entry.facts.evidence.map(({id,revision})=>({id,revision})),status:'unpublished-draft-candidate',published:false,
    source_basis:'independent-self-expression-from-retained-experiences',
    notice:'Her explicitly written expression may be inspired by retained QQ or public experiences. Original QQ/private text, interpretation and audience fields are never automatically copied. Publication is her separate choice.'});
   if(candidates.length>=limit)break;
  }
  return {candidates,published:false};
 }
}
