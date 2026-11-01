// Person-bound, revisable interpretations in the existing self_state store.
// No provider, transport, scheduler, identity/permission write or separate DB.
const SOURCE='person-impressions',PREFIX='person:';
const types=new Set(['preference','interaction','circumstance']);
const fields=new Set(['person_id','key','operation','expected_revision','interpretation','type','reason','evidence_ids','evidence_refs','valid_until']);
const incomingSources=new Set(['live-transport','admitted-transport','referenced-qq-api','conversation-turns']);
const NOTICE='These are Xi’s dated, source-linked interpretations, not facts confirmed by the person. Source authors are not automatically the subjects of what they describe. Remembering does not grant permission to quote private content, change identity or permissions, or send anything.';
function reject(reason,detail={}){throw Object.assign(Error(reason),{personImpressionRejection:true,detail});}
function object(value){return value&&typeof value==='object'&&!Array.isArray(value);}
function person(value){if(typeof value!=='string'||!/^\d{5,15}$/.test(value))reject('explicit-person-id-required');return value;}
function text(value,max,name){if(typeof value!=='string'||!value.trim()||value.length>max)reject(name);return value.trim().replace(/\s+/g,' ');}
function keyFor(id,key){if(typeof key!=='string'||!/^\p{L}[\p{L}\p{N}_-]{0,47}$/u.test(key))reject('bounded-stable-impression-key-required');return PREFIX+id+':'+key;}
function clockTime(clock){const value=clock();if(!Number.isSafeInteger(value)||value<0)reject('invalid-impression-clock');return value;}
function limit(value,fallback,max){if(value===undefined)return fallback;if(!Number.isSafeInteger(value)||value<1||value>max)reject('invalid-impression-limit');return value;}
function validUntil(value,type,observed){
 if(value===undefined||value===null)return null;
 if(type!=='circumstance')reject('valid-until-is-only-for-circumstances');
 if(typeof value!=='string'||value.length>40||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(value))reject('valid-until-needs-explicit-time-zone');
 const at=Date.parse(value);if(!Number.isSafeInteger(at)||at<observed)reject('invalid-valid-until');return new Date(at).toISOString();
}

function directSource(store,id,revision,now){
 if(typeof id!=='string'||!/^exp-[a-f0-9]{32}$/.test(id)||revision!==undefined&&(!Number.isSafeInteger(revision)||revision<1))reject('invalid-impression-evidence-reference');
 const record=store.get({id,...(revision===undefined?{}:{revision}),maxChars:1});
 if(!record.found)reject('impression-evidence-unavailable',{evidence_id:id});
 const version=store.db.prepare('SELECT text,recorded_at FROM experience_versions WHERE experience_id=? AND id=?').get(id,record.revision);
 if(!version||!Number.isSafeInteger(version.recorded_at)||version.recorded_at>now)reject('future-impression-evidence',{evidence_id:id});
 let raw;try{raw=JSON.parse(version.text);}catch{reject('impression-needs-direct-source',{evidence_id:id});}
 const wire=raw?.transport,observed=typeof wire?.time==='number'?Math.round(wire.time*1000):NaN;
 const sources=record.sources.map(s=>s.source).filter(s=>incomingSources.has(s));
 if(record.role!=='user'||!record.source_known||!sources.length||!['direct-human-statement','direct-peer-bot-statement'].includes(record.attribution?.evidence_kind)||
  record.attribution.identity_conflict||record.transport_status?.recalled||!wire||wire.conversation!==record.scope||String(wire.message_id)!==record.event||String(wire.sender_id)!==record.author?.id||
  !Number.isSafeInteger(observed)||observed<=0||observed>now)reject('impression-needs-direct-source',{evidence_id:id});
 return {id:record.id,revision:record.revision,scope:record.scope,event:record.event,role:record.role,
  author:{id:record.author.id,kind:record.author.kind},at:observed,recorded_at:version.recorded_at,
  evidence_kind:record.attribution.evidence_kind,sources:[...new Set(sources)].sort(),
  statement_subject:'not-inferred-from-author',original_body_omitted:true};
}

function basisFor(store,args,now){
 const ids=args.evidence_ids??[],explicit=args.evidence_refs??[];
 if(!Array.isArray(ids)||!Array.isArray(explicit)||ids.length>8||explicit.length>8||!ids.length&&!explicit.length)reject('impression-needs-existing-evidence');
 const refs=new Map(),add=ref=>{refs.set(ref.id+'\0'+ref.revision,ref);if(refs.size>8)reject('impression-evidence-count-exceeds-eight');};
 for(const id of ids)add(directSource(store,id,undefined,now));
 for(const ref of explicit){
  if(!object(ref)||Object.keys(ref).some(k=>!['id','revision'].includes(k))||!Number.isSafeInteger(ref.revision)||ref.revision<1)reject('invalid-impression-evidence-reference');
  add(directSource(store,ref.id,ref.revision,now));
 }
 return [...refs.values()].sort((a,b)=>a.id.localeCompare(b.id)||a.revision-b.revision);
}

function knownPerson(store,id,refs,now){
 if(String(store.identities?.botId)===id)reject('person-impressions-are-about-others');
 const direct=refs.find(ref=>ref.author.id===id);if(direct)return direct;
 // An explicit person ID still needs an actual encountered author. Labels,
 // native mentions and unverified forward authors do not establish identity.
 const candidates=store.db.prepare("SELECT id FROM experiences WHERE role='user' AND sender_id=? AND source_known=1 ORDER BY at DESC,rowid DESC LIMIT 64").all(id);
 for(const row of candidates){try{const ref=directSource(store,row.id,undefined,now);if(ref.author.id===id)return ref;}catch(error){if(!error.personImpressionRejection)throw error;}}
 reject('person-not-established-by-direct-experience',{person_id:id});
}

function validity(value,now){
 const circumstance=value.type==='circumstance',expires=circumstance&&value.valid_until?Date.parse(value.valid_until):null;
 const expired=Number.isFinite(expires)&&expires<=now;
 return {observed_at:value.observed_at,valid_until:circumstance?value.valid_until??null:null,stale:expired,
  current_status:expired?'expired':circumstance?'dated-observation-current-situation-unconfirmed':'revisable-understanding',
  currently_confirmed_fact:false};
}

function view(row,now,{compact=false}={}){
 const value=row.value,refs=value.source_refs??[],shown=compact?refs.slice(0,2):refs;
 return {person_id:value.person_id,key:value.key,revision:row.revision,previous_revision:value.previous_revision,
  at:row.at,type:value.type,active:value.active,operation:value.operation,
  interpretation:value.interpretation.slice(0,compact?300:900),interpretation_truncated:compact&&value.interpretation.length>300,
  reason:value.reason.slice(0,compact?160:400),reason_truncated:compact&&value.reason.length>160,
  ...validity(value,now),source_refs:shown,source_ref_count:refs.length,
  identity_basis:value.identity_basis,association_is_self_interpretation:true,interpretation_is_not_source_fact:true,
  authority_grant:false,full_entry_available_with:'read_person_impressions'};
}

export class PersonImpressions{
 constructor(store,{clock=store?.clock??(()=>Date.now())}={}){
  if(!store?.db?.prepare||!store.db.exec||typeof store.get!=='function'||typeof store.setState!=='function'||typeof store.getState!=='function'||typeof clock!=='function')throw TypeError('Person impressions require the existing experience store');
  this.store=store;this.clock=clock;
 }
 write(args){try{return this.writeChecked(args);}catch(error){if(error.personImpressionRejection)return {status:'rejected',reason:error.message,...error.detail};throw error;}}
 writeChecked(args){
  if(!object(args)||Object.keys(args).some(k=>!fields.has(k)))reject('invalid-impression-fields');
  const id=person(args.person_id),key=keyFor(id,args.key),now=clockTime(this.clock);
  if(!['record','correct','retire'].includes(args.operation)||!Number.isSafeInteger(args.expected_revision)||args.expected_revision<0)reject('operation-and-expected-revision-required');
  if(args.type!==undefined&&!types.has(args.type))reject('invalid-impression-type');
  const reason=text(args.reason,400,'bounded-impression-reason-required'),refs=basisFor(this.store,args,now),identity=knownPerson(this.store,id,refs,now);
  const supplied=args.interpretation===undefined?undefined:text(args.interpretation,900,'bounded-impression-interpretation-required');
  if(args.operation!=='retire'&&supplied===undefined)reject('bounded-impression-interpretation-required');
  this.store.db.exec('SAVEPOINT person_impression_write');
  try{
   const current=this.store.getState({kind:'relationship',key,limit:1})[0]??null;
   if(current&&(current.source!==SOURCE||current.value?.person_id!==id||current.value?.key!==args.key))reject('impression-key-owned-by-another-state');
   const revision=current?.revision??0;
   if(revision!==args.expected_revision){this.store.db.exec('RELEASE person_impression_write');return {status:'conflict',reason:'impression-version-conflict',person_id:id,key:args.key,current_revision:revision,current:current?view(current,now):null};}
   if(args.operation!=='record'&&!current)reject('no-prior-impression-to-correct-or-retire');
   const interpretation=supplied??current.value.interpretation,type=args.type??current?.value?.type??null;
   const observed=Math.max(...refs.map(ref=>ref.at)),expires=validUntil(args.valid_until,type,observed),active=args.operation!=='retire';
   const sourceRefs=refs.map(ref=>({...ref,person_association:ref.author.id===id?'direct-author-not-automatic-subject':'associated-by-xi-not-confirmed-by-source-author'}));
   const identityBasis={id:identity.id,revision:identity.revision,scope:identity.scope,event:identity.event,author:identity.author,at:identity.at,
    basis:'actually-encountered-direct-author',identity_or_permission_grant:false};
   const value={person_id:id,key:args.key,type,interpretation,reason,active,operation:args.operation,previous_revision:revision||null,
    observed_at:observed,valid_until:expires,source_refs:sourceRefs,identity_basis:identityBasis,
    interpretation_is_not_source_fact:true,association_is_self_interpretation:true,authority_grant:false,reviewable:true};
   const old=current?.value;
   if(old&&['type','interpretation','reason','active','observed_at','valid_until'].every(field=>old[field]===value[field])&&JSON.stringify(old.source_refs)===JSON.stringify(sourceRefs)){
    this.store.db.exec('RELEASE person_impression_write');return {status:'unchanged',person_id:id,key:args.key,current_revision:revision,current:view(current,now)};
   }
   if(JSON.stringify(value).length>6000)reject('impression-entry-too-large');
   const evidence=[...new Set([...refs.map(ref=>ref.id),identity.id])].map(id=>({type:'message',id}));
   const saved=this.store.setState({kind:'relationship',key,value,evidence,at:now,source:SOURCE});
   this.store.db.exec('RELEASE person_impression_write');
   return {status:'saved',person_id:id,key:args.key,current_revision:saved.revision,revision:saved.revision,previous_revision:revision||null,
    active,at:now,source:SOURCE,entry:view({...saved,value},now),notice:NOTICE};
  }catch(error){this.store.db.exec('ROLLBACK TO person_impression_write; RELEASE person_impression_write');throw error;}
 }
 read({person_id,key,include_retired=false,history=false,limit:requested}={}){
  const id=person(person_id),count=limit(requested,6,20),now=clockTime(this.clock);
  if(typeof include_retired!=='boolean'||typeof history!=='boolean')reject('invalid-impression-read-flags');
  const where=["s.kind='relationship'","s.source=?","json_valid(s.value)","json_extract(s.value,'$.person_id')=?"],args=[SOURCE,id];
  if(key!==undefined){where.push('s.key=?');args.push(keyFor(id,key));}
  if(!history)where.push('s.revision=(SELECT max(v.revision) FROM self_state v WHERE v.kind=s.kind AND v.key=s.key)');
  if(!include_retired)where.push("json_extract(s.value,'$.active')=1");
  const rows=this.store.db.prepare('SELECT s.* FROM self_state s WHERE '+where.join(' AND ')+' ORDER BY s.at DESC,s.revision DESC,s.key LIMIT ?').all(...args,count)
   .map(row=>({...row,value:JSON.parse(row.value)})).filter(row=>row.key===keyFor(id,row.value.key));
  return {person_id:id,entries:rows.map(row=>view(row,now)),history,read_only:true,notice:NOTICE};
 }
 context({person_id,limit:requested,maxChars=2200}={}){
  const count=limit(requested,3,3);
  if(!Number.isSafeInteger(maxChars)||maxChars<300||maxChars>5000)reject('invalid-impression-context-budget');
  const result={person_id:person(person_id),entries:[],read_only:true,interpretation_is_not_source_fact:true,
   notice:'Dated interpretations, not confirmed person facts or permissions. Source authors are not automatically statement subjects; private sources are not authorized for forwarding.'};
  const current=this.read({person_id,limit:20}).entries.filter(entry=>!entry.stale),now=clockTime(this.clock);
  for(const entry of current){
   // The explicit read already has bounded source metadata. The automatic
   // context retains at most two source refs and never adds source bodies.
   if(entry.valid_until&&Date.parse(entry.valid_until)<=now)continue;
   const source=ref=>({id:ref.id,revision:ref.revision,scope:ref.scope,author:ref.author,at:ref.at});
   // Preserve at least one real source/author/version/date before spending the
   // automatic budget on repeated notices or extended identity metadata.
   for(const [sources,interpretationChars,reasonChars] of [[2,240,100],[1,160,60]]){
    const compact={person_id:entry.person_id,key:entry.key,revision:entry.revision,type:entry.type,at:entry.at,
     interpretation:entry.interpretation.slice(0,interpretationChars),interpretation_truncated:entry.interpretation.length>interpretationChars,
     reason:entry.reason.slice(0,reasonChars),reason_truncated:entry.reason.length>reasonChars,
     observed_at:entry.observed_at,valid_until:entry.valid_until,current_status:entry.current_status,currently_confirmed_fact:false,
     source_refs:entry.source_refs.slice(0,sources).map(source),source_ref_count:entry.source_ref_count,
     identity_basis:{id:entry.identity_basis.id,revision:entry.identity_basis.revision,author:entry.identity_basis.author,at:entry.identity_basis.at},
     full_entry_available_with:'read_person_impressions'};
    result.entries.push(compact);if(JSON.stringify(result).length<=maxChars)break;result.entries.pop();
   }
   if(result.entries.length===count)break;
  }
  if(JSON.stringify(result).length>maxChars)result.notice='Dated self-interpretations; not confirmed facts, permissions or forwarding authority.';
  return result;
 }
 tools({signal,canAct=()=>true}={}){
  if(typeof canAct!=='function')throw TypeError('Person impression tools need a lifecycle guard');
  const readArgs={type:'object',properties:{person_id:{type:'string'},key:{type:'string',maxLength:48},include_retired:{type:'boolean'},history:{type:'boolean'},limit:{type:'integer',minimum:1,maximum:20}},required:['person_id'],additionalProperties:false};
  const writeArgs={type:'object',properties:{person_id:{type:'string'},key:{type:'string',maxLength:48},operation:{type:'string',enum:['record','correct','retire']},expected_revision:{type:'integer',minimum:0},
   interpretation:{type:'string',maxLength:900},type:{type:'string',enum:[...types]},reason:{type:'string',maxLength:400},valid_until:{type:'string',description:'Only for a temporary circumstance; optional ISO date/time with timezone. Without this, the situation is dated and explicitly unconfirmed now.'},
   evidence_ids:{type:'array',minItems:1,maxItems:8,items:{type:'string'}},evidence_refs:{type:'array',minItems:1,maxItems:8,items:{type:'object',properties:{id:{type:'string'},revision:{type:'integer',minimum:1}},required:['id','revision'],additionalProperties:false}}},
   required:['person_id','key','operation','expected_revision','reason'],additionalProperties:false};
  return [{name:'read_person_impressions',description:'Read a few dated interpretations about one explicitly identified person, with original source authors and exact versions. These are your revisable understandings, not the person’s confirmed facts or permission to share private content. Read retired/history entries only when useful.',parameters:readArgs,
   handler:async args=>{signal?.throwIfAborted();if(await canAct()!==true)throw Error('Person impressions are paused or ended');signal?.throwIfAborted();
    try{return JSON.stringify(this.read(args));}catch(error){if(error.personImpressionRejection)return JSON.stringify({status:'rejected',reason:error.message});throw error;}}},
  {name:'reflect_person_impression',description:'Optionally record, correct or retire your own brief understanding of one actually encountered person. Use a stable key, exact expected_revision (0 for new), real evidence and a reason. Authorship establishes who spoke, not who experienced everything described; any association with this person remains your interpretation. No affection scores, identity/permission changes, or messages are created. Preferences and interaction patterns have no arbitrary expiry; circumstances are dated and not assumed current. Read the current version before correcting or retiring.',parameters:writeArgs,
   handler:async args=>{signal?.throwIfAborted();if(await canAct()!==true)throw Error('Person impressions are paused or ended');signal?.throwIfAborted();return JSON.stringify(this.write(args));}}];
 }
}
