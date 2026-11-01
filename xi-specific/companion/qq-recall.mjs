// Protocol notices annotate evidence; they never authorize a task or imply erasure.
import {createHash} from 'node:crypto';import {conversationScope} from './conversation-scope.mjs';
export class QQRecall{
 constructor({service,world,policy,clock=()=>Date.now()}){Object.assign(this,{service,world,policy,clock});}
 async receive(event){
  if(event.post_type!=='notice'||!['group_recall','friend_recall'].includes(event.notice_type))return null;
  if(this.service.paused||this.service.closed)return {status:'paused-or-closed'};
  if(event.self_id!==undefined&&String(event.self_id)!==String(this.policy.bot_id))return {status:'recall-self-mismatch'};
  if(!Number.isSafeInteger(event.message_id)||!/^\d{5,15}$/.test(String(event.user_id)))return {status:'invalid-recall'};
  let scope;try{scope=conversationScope(event.notice_type==='group_recall'?'group':'private',event.notice_type==='group_recall'?event.group_id:event.user_id);}catch{return {status:'invalid-recall'};}
  if(scope.kind==='group'){if(!this.world.getWatched().groups.map(String).includes(scope.id))return {status:'not-allowed'};}
  else if(!await this.service.isAllowed(scope))return {status:'not-allowed'};
  if(this.service.paused||this.service.closed)return {status:'paused-or-closed'};
  const messageId=String(event.message_id),key='notice:recall:'+createHash('sha256').update(scope.key+'\0'+messageId).digest('hex'),store=this.service.cognition.store;
  const candidates=['user','assistant'].map(role=>store.get({scope,event:messageId,role})).filter(r=>r.found&&r.sources?.some(s=>(r.role==='assistant'?['acknowledged-qq-outgoing','isolated-qq-outgoing']:['live-transport','admitted-transport','referenced-qq-api']).includes(s.source))),original=candidates.length===1?candidates[0]:null;
  // group author is explicit; private user_id is only the correspondent, not the actor.
  const mismatch=scope.kind==='group'&&original?.sender_id&&original.sender_id!==String(event.user_id);
  if(mismatch)return {status:'recall-author-conflict',linked:false,original_preserved:true};
  const operator=scope.kind==='group'&&/^\d{5,15}$/.test(String(event.operator_id))?String(event.operator_id):null;
  const notice={transport:{conversation:scope.address,event_kind:'recall-notice',original_event:messageId,notice_key:key,reported_author:scope.kind==='group'?String(event.user_id):null,operator_id:operator,source_time:Number.isFinite(event.time)?event.time:null,received_at:this.clock()},body:'QQ撤回通知；原记录保留并标注已撤回。不是永久遗忘指令、提问或新授权。',linked_experience_id:original?.id??null,original_available:!!original,notice_reply_policy:'listen-only'};
  const result=store.markRecalled({scope,event:messageId,noticeKey:key,operator,reportedAuthor:notice.transport.reported_author,at:Number.isFinite(event.time)?event.time*1000:this.clock(),linkedId:original?.id??null});
  if(result.duplicate)return {status:'duplicate-recall'};
  this.service.history.insert(scope,key,JSON.stringify(notice),new Date(this.clock()).toISOString(),'admitted-recall-transport');store.recordMessage({scope,event:key,role:'user',text:JSON.stringify(notice),at:this.clock(),source:'admitted-recall-transport',metadata:{original_event:messageId,linked_experience_id:original?.id??null},state:'notice'});
  return {status:'accepted-recall',linked:!!original,original_preserved:true,permanent_forgetting:false,woke_model:false};
 }
}
