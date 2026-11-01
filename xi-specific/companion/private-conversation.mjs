import {isUncertainToolResult} from './tool-feedback.mjs';
// Isolated private-text prototype with explicitly bound tools. No QQ connection or shared-memory reads.
import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {runScopedTurn} from './scoped-tools.mjs';
import {conversationFailure} from './conversation-errors.mjs';
import {buildConversationTime} from './conversation-time.mjs';
import {presentConversation} from './conversation-presentation.mjs';
import {recentExchange} from './recent-exchange.mjs';

const activeTaskStates=['working','ready','sending'];
const workroomMutations=new Set(['workroom_create','workroom_write','workroom_restore','workroom_trash','workroom_submit','workroom_task_state','workroom_publish','workroom_unpublish']);
function senderOf(text){try{const id=JSON.parse(text??'').transport?.sender_id;return /^\d{5,15}$/.test(String(id))?String(id):null;}catch{return null;}}
const textHash=text=>createHash('sha256').update(text).digest('hex');
function presentedSource(row,scope,presented){
 let source;try{source=JSON.parse(row.text);}catch{source=null;}
 const body=typeof source?.body==='string'?source.body:row.text;
 let view;try{view=JSON.parse(presented);}catch{view=null;}
 // Match what was actually emitted, not merely a row that was considered.
 if(presented!==row.text&&view?.said!==body)return null;
 return {scope,event:String(row.event),role:row.role,source_text_sha256:textHash(row.text),body_sha256:textHash(body),body_complete:true};
}
function checkpointFor(tool,args,result,ok){
  let value=result;if(typeof result==='string'){try{value=JSON.parse(result);}catch{value=null;}}
  if(value?.ok===true&&value.result)value=value.result;
  const detail={tool,ok:ok!==false};
  for(const key of ['project_id','version','expected_version','task_id','path','state','receipt_id']){
    const v=value?.[key]??args?.[key];if(typeof v==='string')detail[key]=v.slice(0,200);else if(Number.isSafeInteger(v))detail[key]=v;
  }
  if(value?.checks&&Array.isArray(value.checks.errors))detail.check_errors=value.checks.errors.length;
  return detail;
}

export class PrivateConversation {
  constructor({path,client,profile,send,isAllowed,toolsFor=()=>[],contextFor=async()=>null,evidenceFor=()=>[],presentation={},clock=()=>Date.now()}) {
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS turns(peer TEXT,event TEXT,role TEXT,text TEXT,at INTEGER,state TEXT, PRIMARY KEY(peer,event,role))');
    this.db.exec('CREATE TABLE IF NOT EXISTS turn_failures(peer TEXT,event TEXT,phase TEXT,category TEXT,error_type TEXT,http_status INTEGER,attempt_count INTEGER,at INTEGER,PRIMARY KEY(peer,event))');
    this.db.exec('CREATE TABLE IF NOT EXISTS generation_steps(peer TEXT,event TEXT,step INTEGER,detail TEXT,at INTEGER,PRIMARY KEY(peer,event,step))');
    this.db.exec('CREATE TABLE IF NOT EXISTS generation_tool_events(id INTEGER PRIMARY KEY AUTOINCREMENT,peer TEXT,event TEXT,tool TEXT,status TEXT,refs TEXT,at INTEGER)');
    this.db.exec('CREATE TABLE IF NOT EXISTS task_runs(peer TEXT,event TEXT,sender TEXT,state TEXT,activity TEXT,checkpoint TEXT,started INTEGER,updated INTEGER,PRIMARY KEY(peer,event))');
    this.db.exec('CREATE TABLE IF NOT EXISTS task_events(id INTEGER PRIMARY KEY AUTOINCREMENT,peer TEXT,event TEXT,state TEXT,detail TEXT,at INTEGER)');
    // A restart never replays mutations or an uncertain send. Existing projects
    // and their immutable versions remain available for an explicit continuation.
    for(const row of this.db.prepare("SELECT peer,event,state FROM task_runs WHERE state IN ('working','ready','sending')").all())this.setTaskState(row.peer,row.event,row.state==='sending'?'delivery-uncertain':'interrupted',{reason:'service-restart'});
    this.db.exec("UPDATE turns SET state='expired' WHERE role='user' AND state='image-pending'");
    Object.assign(this,{client,profile,send,isAllowed,toolsFor,contextFor,evidenceFor,presentation,clock});this.queues=new Map();this.revisions=new Map();this.closed=false;this.paused=false;this.generation=0;this.controllers=new Set();this.turnControllers=new Map();
  }
  setTaskState(peer,event,state,detail={}){
    const at=this.clock?.()??Date.now();
    const changed=this.db.prepare('UPDATE task_runs SET state=?,updated=? WHERE peer=? AND event=?').run(state,at,peer,event);
    if(changed.changes)this.db.prepare('INSERT INTO task_events(peer,event,state,detail,at) VALUES(?,?,?,?,?)').run(peer,event,state,JSON.stringify(detail),at);
    return !!changed.changes;
  }
  taskStatus(peer,event){
    const rows=event===undefined?this.db.prepare('SELECT * FROM task_runs WHERE peer=? ORDER BY updated DESC LIMIT 20').all(peer):[this.db.prepare('SELECT * FROM task_runs WHERE peer=? AND event=?').get(peer,String(event))].filter(Boolean);
    const decoded=rows.map(row=>({...row,checkpoint:JSON.parse(row.checkpoint)}));return event===undefined?decoded:decoded[0]??null;
  }
  activeTask(peer){return this.taskStatus(peer).find(row=>activeTaskStates.includes(row.state))??null;}
  shouldPreserveTask(peer,event){const task=this.taskStatus(peer,String(event));return !!task&&activeTaskStates.includes(task.state);}
  canDeliver(peer,event,revision){
    const task=this.taskStatus(peer,String(event));
    if(task&&!activeTaskStates.includes(task.state))return false;
    return this.shouldPreserveTask(peer,event)||revision===null||revision===undefined||revision===(this.revisions.get(peer)??0);
  }
  markTask(peer,event,tool,args,result,{ok=true}={}){
    event=String(event);if(typeof tool!=='string'||!tool.startsWith('workroom_'))return null;
    try{if((typeof result==='string'?JSON.parse(result):result)?.ok===false)ok=false;}catch{}
    let task=this.taskStatus(peer,event);
    if(!task&&(!workroomMutations.has(tool)||ok===false))return null;
    const detail=checkpointFor(tool,args,result,ok),at=this.clock();
    const control=this.turnControllers.get(peer+'|'+event);
    const state=task?.state??(control?.controller.signal.aborted?(this.paused?'paused':'cancelled'):'working');
    if(!task){
      const source=this.db.prepare("SELECT text FROM turns WHERE peer=? AND event=? AND role='user'").get(peer,event);
      if(!source)throw Error('Task source is unavailable');
      this.db.prepare('INSERT INTO task_runs VALUES(?,?,?,?,?,?,?,?)').run(peer,event,senderOf(source.text),state,tool,JSON.stringify(detail),at,at);
    }else this.db.prepare('UPDATE task_runs SET activity=?,checkpoint=?,updated=? WHERE peer=? AND event=?').run(tool,JSON.stringify(detail),at,peer,event);
    this.db.prepare('INSERT INTO task_events(peer,event,state,detail,at) VALUES(?,?,?,?,?)').run(peer,event,state,JSON.stringify(detail),at);
    return this.taskStatus(peer,event);
  }
  cancelTask(peer,{event=null,senderId,guardian=false}={}){
    const accepted=[];
    for(const task of this.taskStatus(peer)){
      if(event!==null&&task.event!==String(event)||!activeTaskStates.includes(task.state))continue;
      if(!guardian&&(!senderId||String(senderId)!==task.sender))continue;
      this.setTaskState(peer,task.event,'cancelled',{reason:'explicit-cancel'});accepted.push(task.event);
      this.turnControllers.get(peer+'|'+task.event)?.controller.abort();
    }
    // A deliberate correction/cancel can arrive before the first project tool
    // returns. Abort that caller's in-flight turn too, without inventing a task.
    for(const [key,turn] of this.turnControllers){
      if(turn.peer!==peer||event!==null&&turn.event!==String(event))continue;
      if(!guardian&&(!senderId||String(senderId)!==turn.sender))continue;
      turn.controller.abort();if(!accepted.includes(turn.event))accepted.push(turn.event);
    }
    return {cancelled:accepted};
  }
  pauseTask(peer,authorization={}){
    const result=this.cancelTask(peer,authorization);
    for(const event of result.cancelled)this.setTaskState(peer,event,'paused',{reason:'explicit-task-pause'});
    return {paused:result.cancelled};
  }
  requestTaskContinuation(peer,{senderId,guardian=false}={}){
    const task=this.taskStatus(peer).find(t=>['paused','interrupted','failed','awaiting-input','continuation-requested'].includes(t.state)&&(guardian||t.sender===String(senderId)));
    if(!task)return null;
    this.setTaskState(peer,task.event,'continuation-requested',{reason:'explicit-new-request; restore from checkpoint, never replay prior delivery'});
    return this.taskStatus(peer,task.event);
  }
  invalidate(peer){const revision=(this.revisions.get(peer)??0)+1;this.revisions.set(peer,revision);return revision;}
  async receive(peer,event,text,{listenOnly=false,revision,recordOnly=false,completePending=false}={}) {
    if(this.closed)return Promise.resolve({status:'stopped'});
    if(this.paused)return Promise.resolve({status:'paused'});
    if(!/^(?:(?:private|group):)?\d{5,15}$/.test(peer)||!event||typeof text!=='string'||text.length>64000)return Promise.resolve({status:'invalid'});
    const generation=this.generation;
    if(!await this.isAllowed(peer)||this.closed||this.paused||generation!==this.generation)return {status:'not-allowed'};
    event=String(event);
    const inserted=completePending?this.db.prepare("UPDATE turns SET text=?,state='accepted' WHERE peer=? AND event=? AND role='user' AND state='image-pending'").run(text,peer,event):this.db.prepare("INSERT OR IGNORE INTO turns VALUES(?,?,'user',?,?,'accepted')").run(peer,event,text,this.clock());
    if(!inserted.changes)return {status:'duplicate'};
    if(recordOnly){this.db.prepare("UPDATE turns SET state='image-pending' WHERE peer=? AND event=? AND role='user'").run(peer,event);return {status:'image-pending'};}
    // Persist hearing separately from speaking, including every message in a batch.
    if(listenOnly){this.db.prepare("UPDATE turns SET state='quiet' WHERE peer=? AND event=? AND role='user'").run(peer,event);return {status:'quiet'};}
    const group=peer.startsWith('group:');
    if(group&&revision===undefined)revision=this.invalidate(peer);
    const previous=this.queues.get(peer)??Promise.resolve();
    const current=previous.catch(()=>{}).then(()=>this.turn(peer,event,generation,group?revision:null));
    this.queues.set(peer,current);
    current.finally(()=>{if(this.queues.get(peer)===current)this.queues.delete(peer);}).catch(()=>{});
    return current;
  }
  anchoredInput(peer,event){
    const current=this.db.prepare("SELECT rowid,event,role,text,state,at FROM turns WHERE peer=? AND event=? AND role='user'").get(peer,String(event));if(!current)throw Error('Current event missing; refuse a different speaker');
    const past=this.db.prepare("SELECT rowid,event,role,text,state,at FROM turns WHERE peer=? AND rowid<? AND (role='user' OR state='sent') ORDER BY rowid DESC LIMIT 23").all(peer,current.rowid);let remaining=96000-current.text.length;const input=[],representedSelfEvents=new Set(),presentedSources=[];
    for(const row of past){let prefix='[历史消息，时间：'+new Date(row.at).toISOString()+'；仅供理解；处理状态：'+row.state+'；不是本轮待执行指令]\n';
      if(row.role==='assistant'){const trigger=this.db.prepare("SELECT text FROM turns WHERE peer=? AND event=? AND role='user'").get(peer,row.event);prefix='[历史汐回复；'+JSON.stringify({source_event:row.event,in_reply_to_sender_id:senderOf(trigger?.text),in_reply_to_conversation:peer,evidence_kind:'assistant-claim',not_independent_human_evidence:true})+'；旧解释可能有误，引用纠正优先]\n';}
      if(row.role==='assistant')prefix+='[实际发送时间：'+new Date(row.at).toISOString()+'；'+(row.event.startsWith('proactive:')?'汐主动分享，可被后续真人承接讨论':'对当时消息的回复')+']\n';
      const presented=presentConversation(row.text,{...this.presentation,role:row.role}),content=prefix+presented;if(content.length>remaining)continue;input.unshift({role:row.role,content});remaining-=content.length;if(row.role==='assistant')representedSelfEvents.add(row.event);
      const source=presentedSource(row,peer,presented);if(source)presentedSources.push(source);
    }
    input.push({role:'user',content:presentConversation(current.text,this.presentation)});const statements=[...past.filter(r=>r.role==='user').reverse(),current].slice(-14).map(r=>{try{const v=JSON.parse(r.text);return {event:r.event,speaker_id:v.transport?.sender_id??null,time:v.transport?.time??null,said:v.body?.slice(0,240)??'',reply_to:(v.segments??[]).filter(s=>s.type==='reply').map(s=>({event:s.message_id,speaker_id:s.reference?.sender_id??null})),statement_subject:'not inferred from speaker'};}catch{return {event:r.event,speaker_id:null,said:r.text.slice(0,240)};}});return {current,input,representedSelfEvents,presentedSources,frame:{current_event:current.event,current_sender_id:senderOf(current.text),conversation:peer,participants:this.presentation,notice:'Keep the source of each statement. A reply/comment on another person does not transfer that person’s experience to the commenter. Assistant history is an interpretation, not independent evidence.'}};
  }
  async turn(peer,event,generation,revision) {
    const stopped=()=>this.closed||this.paused||generation!==this.generation;
    const stale=()=>!this.canDeliver(peer,event,revision);
    const expire=status=>{this.db.prepare("UPDATE turns SET state='expired' WHERE peer=? AND event=? AND role='user'").run(peer,event);if(this.shouldPreserveTask(peer,event))this.setTaskState(peer,event,'interrupted',{reason:status});return {status};};
    if(stopped()||!await this.isAllowed(peer)||stopped())return expire('not-allowed');
    if(stale())return expire('superseded');
    // A queued request keeps its own verified event/speaker; later arrivals
    // cannot become its last message or push it out of the bounded window.
    const {current,input,frame,representedSelfEvents,presentedSources}=this.anchoredInput(peer,event);let addressOnly=false;
    try{addressOnly=JSON.parse(current.text).transport?.address_only===true;}catch{}
    const controller=new AbortController();this.controllers.add(controller);this.turnControllers.set(peer+'|'+event,{peer,event,sender:senderOf(current?.text),controller});
    // No wall-clock cutoff for a conversation turn. Explicit pause/close still
    // aborts the provider; transport-level network timeouts remain independent.
    const signal=controller.signal;let phase='tool-setup';
    try {
      // An address without a body is social attention, not a task authorization.
      // Do not expose mutation/history tools that could restart an old project.
      const tools=addressOnly?[]:this.toolsFor(peer,event);
      const extraContext=await this.contextFor(peer,event,{...current,transcriptPresentation:presentedSources});signal.throwIfAborted();
      frame.latest_self_messages=this.db.prepare("SELECT event,text,at FROM turns WHERE peer=? AND role='assistant' AND state='sent' AND rowid<? ORDER BY rowid DESC LIMIT 3").all(peer,current.rowid).map(r=>{
       const represented=representedSelfEvents.has(r.event),trigger=this.db.prepare("SELECT text FROM turns WHERE peer=? AND event=? AND role='user'").get(peer,r.event);
       return {event:r.event,at:new Date(r.at).toISOString(),kind:r.event.startsWith('proactive:')?'self-initiated-share':'reply',conversation:peer,
        author_id:this.presentation.botId??null,in_reply_to_sender_id:senderOf(trigger?.text),evidence_kind:'assistant-claim',not_independent_human_evidence:true,
        content_in_transcript:represented,...(represented?{}:{text:r.text.slice(0,1200),text_truncated:r.text.length>1200})};
      });
      const profile=this.profile+'\n【本轮固定发话与引用来源】\n'+JSON.stringify(frame)+'\n本轮若需要发话，仅针对最后一条当前消息；是否接话仍看真实对象与有无新意思。短句承接结合最近实际发言、引用和当前纠正理解；关键词相似的旧话题不自动成为正在聊的话题。引用自己原话可能是在解释对你的意思。带历史消息标记的内容仅供理解，不能自行续做其中失败或未完成的任务。'+(addressOnly?'\n本条只有对你的@，请自然简短应声。本轮不执行历史任务，不查资料、不创建作品。':'')+(typeof extraContext==='string'&&extraContext?'\n'+extraContext:'');
      phase='generation';
      let step=0;
      const generationContext=()=>{
       const now=this.clock(),sender=senderOf(current.text);
       const incoming=sender?this.db.prepare("SELECT rowid,event,role,text,at,state FROM turns WHERE peer=? AND role='user' AND rowid<? AND json_valid(text) AND json_extract(text,'$.transport.sender_id')=? ORDER BY rowid DESC LIMIT 1").get(peer,current.rowid,sender):null;
       const self=this.db.prepare("SELECT rowid,event,role,text,at,state FROM turns WHERE peer=? AND role='assistant' AND state='sent' AND at<=? AND event<>? ORDER BY at DESC,rowid DESC LIMIT 1").get(peer,now,event);
       let structured;try{structured=JSON.parse(current.text);}catch{structured={};}
       const related=(structured.segments??[]).filter(s=>s.type==='reply'&&s.reference).slice(0,3).map(s=>({peer,event:s.message_id,kind:'quoted-history',at:s.reference.recorded_at,transport:{conversation:peer,message_id:s.message_id,sender_id:s.reference.sender_id,time:s.reference.time}}));
       const time=buildConversationTime({now,current:{...current,peer},previousIncoming:incoming?{...incoming,peer}:null,previousSelf:self?{...self,peer,role:'assistant',state:'sent'}:null,relevantEvents:related});
       if(self){const trigger=this.db.prepare("SELECT text FROM turns WHERE peer=? AND event=? AND role='user'").get(peer,self.event);time.previous_self.in_reply_to_sender_id=senderOf(trigger?.text);time.previous_self.was_reply_to_current_sender=sender!==null&&senderOf(trigger?.text)===sender;}
       const recent=recentExchange(this.db,{peer,current,now,presentation:this.presentation});
       for(const item of recent.recent_human_messages){
        const shown=presentedSources.find(source=>source.scope===item.scope&&source.event===String(item.event)&&source.role==='user'&&source.body_complete===true);
        if(!shown)continue;
        const original=this.db.prepare("SELECT text FROM turns WHERE peer=? AND event=? AND role='user'").get(item.scope,String(item.event));
        if(!original||textHash(original.text)!==shown.source_text_sha256)continue;
        delete item.body_excerpt;delete item.excerpt_truncated;item.content_in_transcript=true;
       }
       return '\n【本次生成即时计算的时间事实，不是情绪或催促依据】\n'+JSON.stringify(time)+'\n【当前会话最近记录的实际距离，可能已经换话题；跨会话最近联系见recent_contacts】\n'+JSON.stringify(recent);
      };
      const reply=await runScopedTurn({client:this.client,profile,input,tools,generationContext,maxRounds:tools.some(t=>t.name==='workroom_create')?64:32,signal,onStep:detail=>this.db.prepare('INSERT OR REPLACE INTO generation_steps VALUES(?,?,?,?,?)').run(peer,event,++step,JSON.stringify({...detail,anchor:{conversation:peer,event,sender_id:senderOf(current.text),attention:JSON.parse(current.text).transport?.attention??null,routing:JSON.parse(current.text).routing??null},recalled:this.evidenceFor(peer)}),this.clock()),onTool:({name,args,result,ok})=>{this.recordTool(peer,event,name,result,ok);return this.markTask(peer,event,name,args,result,{ok});}});
      if(this.shouldPreserveTask(peer,event))this.setTaskState(peer,event,'ready');
      if(stale())return expire('superseded');
      if(reply===null){this.db.prepare("UPDATE turns SET state='quiet' WHERE peer=? AND event=? AND role='user'").run(peer,event);if(this.shouldPreserveTask(peer,event))this.setTaskState(peer,event,'awaiting-input');return {status:'quiet'};}
      if(stopped()||!await this.isAllowed(peer)||stopped()||stale()){
        return expire('expired-before-send');
      }
      const imageOnly=reply?.kind==='image-only'||reply?.kind==='native-only';
      this.db.prepare("INSERT INTO turns VALUES(?,?,'assistant',?,?,'sending')").run(peer,event,imageOnly?'[Selected attachment expression without text; see acknowledged QQ message for contents]':reply,this.clock());
      phase='send';
      if(this.shouldPreserveTask(peer,event))this.setTaskState(peer,event,'sending');
      const delivered=await this.send(peer,imageOnly?'':reply,event);
      if(imageOnly&&typeof delivered==='string')this.db.prepare("UPDATE turns SET text=? WHERE peer=? AND event=? AND role='assistant'").run(delivered,peer,event);
      phase='receipt';
      this.db.prepare("UPDATE turns SET state='sent' WHERE peer=? AND event=? AND role='assistant'").run(peer,event);
      this.db.prepare("UPDATE turns SET state='completed' WHERE peer=? AND event=? AND role='user'").run(peer,event);
      if(this.shouldPreserveTask(peer,event))this.setTaskState(peer,event,'completed');
      return {status:'sent'};
    } catch(error) {
      const failure=conversationFailure(error,phase,signal);
      this.db.prepare('INSERT OR REPLACE INTO turn_failures VALUES(?,?,?,?,?,?,?,?)').run(peer,event,failure.phase,failure.category,failure.error_type,failure.http_status,failure.attempt_count,this.clock());
      // Do not retry uncertain delivery or put the reply into future context as sent.
      this.db.prepare("UPDATE turns SET state='uncertain' WHERE peer=? AND event=? AND state='sending'").run(peer,event);
      this.db.prepare("UPDATE turns SET state='failed' WHERE peer=? AND event=? AND role='user'").run(peer,event);
      if(this.shouldPreserveTask(peer,event))this.setTaskState(peer,event,phase==='send'?'delivery-uncertain':'failed',{category:failure.category});
      return {status:'failed-no-retry',failure};
    } finally {this.controllers.delete(controller);this.turnControllers.delete(peer+'|'+event);}
  }
  recordTool(peer,event,name,result,ok){
    let v;try{v=typeof result==='string'?JSON.parse(result):result;}catch{v=null;}
    const refs=[],visit=(x,depth=0)=>{if(depth>6||refs.length>=24||!x||typeof x!=='object')return;if(Array.isArray(x)){for(const y of x.slice(0,24))visit(y,depth+1);return;}if((x.id||x.event)&&('scope'in x||'sender_id'in x||'author'in x))refs.push({id:String(x.id??x.event).slice(0,160),scope:x.scope??null,author:x.author?.id??x.sender_id??null});for(const key of ['records','messages','attachments','results'])visit(x[key],depth+1);};visit(v);
    const status=isUncertainToolResult(v,ok!==false)?'uncertain':ok===false?'rejected':v?.ok===false?'not-ok':typeof v?.status==='string'&&/^[a-zA-Z0-9_-]{1,50}$/.test(v.status)?v.status:'returned';
    this.db.prepare('INSERT INTO generation_tool_events(peer,event,tool,status,refs,at) VALUES(?,?,?,?,?,?)').run(peer,event,name,status,JSON.stringify(refs),this.clock());
  }
  async pause() {
    this.paused=true;this.generation++;
    for(const row of this.db.prepare("SELECT peer,event FROM task_runs WHERE state IN ('working','ready')").all())this.setTaskState(row.peer,row.event,'paused',{reason:'explicit-pause'});
    for(const controller of this.controllers)controller.abort();
    // Drain sends already handed to transport; never pretend cancellation recalls them.
    await Promise.allSettled([...this.queues.values()]);
  }
  resume(){if(!this.closed)this.paused=false;}
  async close() {
    if(this.closePromise)return this.closePromise;
    this.closed=true;
    return this.closePromise=(async()=>{await this.pause();this.db.close();})();
  }
}
