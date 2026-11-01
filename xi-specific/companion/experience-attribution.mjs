// Pure provenance description. It does not extract factual subjects, resolve
// pronouns, promote a forwarded author, or treat anyone's statement as proof.
const object=x=>x&&typeof x==='object'&&!Array.isArray(x)?x:null;
const short=(x,max=120)=>typeof x==='string'||typeof x==='number'?String(x).slice(0,max):null;
const person=x=>/^\d{5,15}$/.test(String(x??''))?String(x):null;
const scope=x=>{const m=String(x??'').match(/^(group|private)[:-](\d{5,15})$/);return m?m[1]+':'+m[2]:null;};
function parsed(value,max=100000){if(object(value))return value;if(typeof value!=='string'||value.length>max)return null;try{return object(JSON.parse(value));}catch{return null;}}
const directSources=new Set(['live-transport','admitted-transport','referenced-qq-api','conversation-turns','admitted-poke-transport']);
const acknowledgedSources=new Set(['acknowledged-delivery','acknowledged-qq-outgoing','isolated-qq-outgoing']);
function replyReferences(items,forwarded=false){
 const result=[];
 for(const part of (Array.isArray(items)?items:[]).slice(0,160)){
  if(part?.type!=='reply')continue;
  if(forwarded)result.push({message_id:short(part.id??part.message_id,80),sender_id:null,claimed_sender_id:person(part.reported_author_id),basis:'forwarded-reference-claim'});
  else result.push({message_id:short(part.message_id,80),sender_id:person(part.reference?.sender_id),claimed_sender_id:null,basis:part.reference?'source-bound-reference':'unresolved-reference'});
  if(result.length>=4)break;
 }
 return result;
}
export function authorFor(id,{botId=null,peerBotIds=[],guardianIds=[]}={},displayName=null){
 id=person(id);const self=person(botId),peers=new Set(peerBotIds.map(person).filter(Boolean)),guardians=new Set(guardianIds.map(person).filter(Boolean));
 const kind=!id?'unknown':id===self?'self':peers.has(id)?'peer-bot':'human';
 return {id,kind,relationship:id&&guardians.has(id)?'guardian':null,label:kind==='self'?'汐':kind==='peer-bot'?'另一AI':kind==='human'?'真人':'作者未知',display_name:short(displayName,80),display_name_is_identity:false,basis:id?'configured-account-id-and-source':'unknown-source',identity_or_authority_grant:false};
}
export function attributionFor(record={},identities={}){
 const role=short(record.role,20),body=parsed(record.text),metadata=parsed(record.metadata,16000)??{},sourceNames=(Array.isArray(record.sources)?record.sources:[]).slice(0,20).map(s=>short(typeof s==='string'?s:s?.source,120)).filter(Boolean);
 if(typeof record.source==='string')sourceNames.push(record.source.slice(0,120));
 const sources=new Set(sourceNames),sourceScope=scope(record.scope),transport=object(body?.transport),outer=object(body?.outer_source),node=object(body?.node);
 const isAssistant=role==='assistant',forwarded=!isAssistant&&(sources.has('received-qq-forward-node')||!!metadata.forward_id||!!node?.original_author||!!body?.forwarded||Array.isArray(body?.segments)&&body.segments.some(s=>s?.type==='forward'));
 let evidenceKind='unknown';
 if(isAssistant)evidenceKind='assistant-claim';
 else if(role==='self'&&sources.has('public-exploration'))evidenceKind='public-discovery';
 else if(role==='self'&&(sources.has('self-note')||String(record.event??'').startsWith('note:')))evidenceKind='self-note';
 else if(forwarded)evidenceKind='forwarded-claim';
 else if(role==='user'&&([...sources].some(s=>directSources.has(s))||transport&&scope(transport.conversation)===sourceScope&&sourceScope!==null))evidenceKind='direct-human-statement';
 const storedSender=person(record.sender_id),envelopeSender=!isAssistant&&evidenceKind==='direct-human-statement'&&sourceScope!==null&&scope(transport?.conversation)===sourceScope?person(transport?.sender_id):null;
 const forwarder=forwarded&&sourceScope!==null&&scope(outer?.conversation)===sourceScope?person(outer?.sender_id):null;
 // Legacy ingestion may have derived an assistant row's sender_id from its
 // generated JSON. Only actual outgoing-wire provenance may identify it here;
 // generic acknowledged-delivery/conversation-turns never validate that ID.
 const trustedAssistantSender=isAssistant&&(sources.has('acknowledged-qq-outgoing')||sources.has('isolated-qq-outgoing'))?storedSender:null;
 const transportSender=isAssistant?trustedAssistantSender:storedSender??envelopeSender??forwarder;
 const original=object(metadata.original_author)??object(node?.original_author)??object(body?.original_author);
 const author=forwarded&&original?{reported_id:person(original.reported_id),display_name:short(original.display_name,120),identity_verified:false}:null;
 const state=short(record.state,40),hasAck=[...sources].some(s=>acknowledgedSources.has(s)),uncertain=state==='uncertain'||state==='sending';
 const confirmed=isAssistant&&!uncertain&&(state==='sent'||hasAck),recalled=record.transport_status?.recalled===true;
 const delivery={status:recalled?'recalled':isAssistant?(confirmed?'confirmed-sent':uncertain?'uncertain':'not-confirmed'):'not-applicable-to-claim-truth',state,confirmed_sent:isAssistant?confirmed:null};
 const configuredWireConflict=!!(isAssistant&&person(identities.botId)&&trustedAssistantSender&&trustedAssistantSender!==person(identities.botId));
 const speaker=authorFor(configuredWireConflict?null:isAssistant||role==='self'?person(identities.botId)??trustedAssistantSender:transportSender,identities,transport?.display_name);
 if(evidenceKind==='direct-human-statement'&&speaker.kind==='peer-bot')evidenceKind='direct-peer-bot-statement';
 if(evidenceKind==='direct-human-statement'&&speaker.kind==='self')evidenceKind='self-transport-statement';
 return {
  author:speaker,
  evidence_kind:evidenceKind,
  transport_sender_id:transportSender,
  speaker_id:transportSender,
  speaker_basis:isAssistant?(trustedAssistantSender?'verified-outgoing-wire-sender':'assistant-identity-not-provided'):storedSender?'stored-transport-sender':envelopeSender?'source-bound-transport-envelope':forwarder?'source-bound-forward-outer':'unknown',
  identity_conflict:configuredWireConflict||!!(storedSender&&(envelopeSender&&storedSender!==envelopeSender||forwarder&&storedSender!==forwarder)),
  forwarded_claimed_author:author,
  statement_subject:{status:'not-extracted',person_id:null},
  is_authoritative_fact:false,
  reply_to:forwarded?replyReferences(node?.message??body?.message,true):isAssistant?[]:replyReferences(body?.segments),
  delivery_status:delivery,
  assistant_status:isAssistant?{is_assistant_claim:true,delivery_confirmed:confirmed,not_human_evidence:true,embedded_sender_not_identity:!trustedAssistantSender&&!!(storedSender||body?.transport?.sender_id)}:null,
 };
}
