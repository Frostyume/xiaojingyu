const NOTICE='These are your source-linked journal interpretations, not facts about the source authors. Author IDs refer to the original speakers, never ownership of an experience or permission to repeat private text. Mention a diary only if it helps this conversation; nothing here requires a reply.';
const stop=new Set('今天 昨天 明天 刚才 最近 现在 时候 这个 那个 什么 怎么 为什么 是否 一点 一些 有些 一个 自己 我们 你们 他们 她们 有人 大家 一起 已经 还是 就是 不是 可以 不能 觉得 感觉 心情 开心 喜欢 感受 想起 记得 日记 笔记 记录 生活 事情 东西 分享 希望 真的 因为 所以 但是 可能 继续 变化 问题 today yesterday tomorrow remember journal diary feeling feelings think people sharing share about with from this that what have more would'.split(' '));
const segmenter=new Intl.Segmenter('zh-CN',{granularity:'word'});
const parsed=value=>{if(value&&typeof value==='object')return value;try{return JSON.parse(value);}catch{return {body:typeof value==='string'?value:''};}};
const person=id=>/^\d{5,15}$/.test(String(id??''))?String(id):null;
const scopeKey=scope=>typeof scope==='object'?scope.kind+':'+scope.id:String(scope??'').replace(/^(group|private)-/,'$1:');
function terms(text){
 const words=new Set();
 for(const {segment,isWordLike} of segmenter.segment(String(text??'').slice(0,6000).toLowerCase())){
  if(!isWordLike||stop.has(segment))continue;
  if(/\p{Script=Han}/u.test(segment)&&segment.length>=2||/^[a-z][a-z_-]{3,}$/.test(segment))words.add(segment);
 }
 return words;
}
function sourceTopic(record){
 const value=parsed(record.text);
 return typeof value.body==='string'?value.body:typeof value.summary==='string'?value.summary:typeof value.title==='string'?value.title:'';
}

// The general memory context may fill a short page with recent messages. Such
// recency alone is not a journal relevance signal.
export function relevantJournalSourceIds(current,records){
 const data=parsed(current?.text??current),sender=person(data.transport?.sender_id),query=terms(data.body),references=(data.segments??[]).filter(s=>s.type==='reply');
 return records.filter(record=>sender&&person(record.author?.id)===sender||references.some(ref=>String(ref.message_id)===String(record.event)&&scopeKey(record.scope)===scopeKey(data.transport?.conversation))||[...query].some(word=>terms(record.body).has(word))).map(record=>record.id);
}

export class JournalContext{
 constructor({journal,store,clock=()=>Date.now()}){this.journal=journal;this.store=store;this.clock=clock;}
 sources(entry){
  return entry.facts.evidence.map(ref=>{
   const record=this.store.get({id:ref.id,revision:ref.revision,maxChars:24000});
   return {ref,record,author:record.found?{id:person(record.author?.id),kind:record.role==='self'?'self':record.author?.kind??'unknown'}:{id:null,kind:'unknown'}};
  });
 }
 view(entry,sources,{automatic=false,match=[]}={}){
  const thought=entry.interpretation??{},interpretation={};
  if(thought.feeling)interpretation.feeling=thought.feeling.slice(0,automatic?140:800);
  if(thought.association)interpretation.association=thought.association.slice(0,automatic?200:1000);
  if(!automatic&&thought.share)interpretation.sharing_thought={audience:thought.share.audience,reason:thought.share.reason};
  const shown=automatic?sources.slice(0,3):sources;
  return {id:entry.id,revision:entry.revision,day:entry.day,kind:entry.kind,
   interpretation,interpretation_is_not_source_fact:true,source_count:sources.length,
   sources:shown.map(({ref,record,author})=>({id:ref.id,revision:ref.revision,scope:ref.scope,role:ref.role,author,available:record.found===true})),
   ...(shown.length<sources.length?{more_sources_available_with:'read_life_journal'}:{}),
   ...(match.length?{match_basis:match}:{}),notice:'Your interpretation; original authors and experience ownership stay separate. Source bodies are omitted.'};
 }
 read({id,revision,days=2,limit=3}={}){
  if(!Number.isSafeInteger(limit)||limit<1||limit>6)throw Error('Read 1–6 journal entries at a time');
  if(revision!==undefined&&!id)throw Error('A journal revision needs its journal ID');
  const originals=id?[this.journal.get(id,{revision})]:this.journal.recent({days,limit}).entries,entries=[];let truncated=false;
  for(const entry of originals.filter(e=>e.found)){entries.push(this.view(entry,this.sources(entry)));if(JSON.stringify(entries).length>10000){entries.pop();truncated=true;break;}}
  return {found:id?originals[0]?.found===true:true,entries,truncated,read_only:true,notice:NOTICE};
 }
 select({scope,current='',relatedExperienceIds=[],maxChars=1900}={}){
  if(!Number.isSafeInteger(maxChars)||maxChars<500||maxChars>2400)throw Error('Invalid journal context budget');
  const data=parsed(current?.text??current),sender=person(data.transport?.sender_id),body=typeof data.body==='string'?data.body:'',query=terms(body),currentScope=scopeKey(scope??data.transport?.conversation);
  const before=Number.isFinite(data.transport?.time)?data.transport.time*1000:this.clock(),related=new Set(relatedExperienceIds),references=(data.segments??[]).filter(s=>s.type==='reply');
  const ranked=[];
  for(const entry of this.journal.recent({days:7,limit:12}).entries){
   if(entry.at>before)continue;
   const sources=this.sources(entry),match=[];let score=0;
   if(!sources.some(source=>source.record.found))continue;
   if(sources.some(s=>s.record.found&&related.has(s.ref.id))){match.push('related-source-experience');score+=50;}
   if(sources.some(s=>s.record.found&&scopeKey(s.ref.scope)===currentScope&&references.some(r=>String(r.message_id)===String(s.record.event)&&(!r.reference?.sender_id||person(r.reference.sender_id)===s.author.id)))){match.push('current-verified-reference');score+=50;}
   if(sender&&sources.some(s=>s.record.found&&s.author.id===sender)){match.push('current-source-author');score+=30;}
   const corpus=terms([entry.interpretation?.feeling,entry.interpretation?.association,...sources.filter(s=>s.record.found).map(s=>sourceTopic(s.record))].filter(Boolean).join('\n'));
   const overlap=[...query].filter(word=>corpus.has(word));
   if(overlap.length){match.push('specific-topic');score+=10+Math.min(10,overlap.length);}
   if(score)ranked.push({entry,sources,match,score});
  }
  ranked.sort((a,b)=>b.score-a.score||b.entry.at-a.entry.at||a.entry.id.localeCompare(b.entry.id));
  const entries=[];
  for(const item of ranked){
   entries.push(this.view(item.entry,item.sources,{automatic:true,match:item.match}));
   if(JSON.stringify(entries).length>maxChars)entries.pop();
   if(entries.length===2)break;
  }
  return {entries,notice:NOTICE};
 }
}
