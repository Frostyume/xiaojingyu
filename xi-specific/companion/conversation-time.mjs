// Pure, per-generation time facts. No clock polling, message text output or
// temporal emotion/urgency judgments. The caller supplies the fresh `now`.
const ZONE='Asia/Shanghai',MAX_EPOCH=253402300799999;
const format=new Intl.DateTimeFormat('en-CA',{timeZone:ZONE,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',fractionalSecondDigits:3,hourCycle:'h23',timeZoneName:'longOffset'});
const object=value=>value&&typeof value==='object'&&!Array.isArray(value)?value:null;
const own=(value,key)=>object(value)?Object.getOwnPropertyDescriptor(value,key)?.value:undefined;
const has=(value,key)=>object(value)&&Object.hasOwn(value,key);
function opaque(value,max=120){if(typeof value==='number')return Number.isSafeInteger(value)?String(value):null;if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f\u007f]/.test(value))return null;return value;}
function scopeOf(value){
 if(object(value)){const kind=own(value,'kind'),id=opaque(own(value,'id'));return ['group','private'].includes(kind)&&/^\d{5,15}$/.test(id??'')?kind+':'+id:null;}
 const match=typeof value==='string'?/^(group|private)[:-](\d{5,15})$/.exec(value):null;return match?match[1]+':'+match[2]:null;
}
function envelope(record){const outer=object(record)??{},text=own(outer,'text');if(typeof text==='string'&&text.length<=256000){try{const parsed=object(JSON.parse(text));if(parsed)return {outer,payload:parsed,transport:object(own(parsed,'transport'))};}catch{}}return {outer,payload:outer,transport:object(own(outer,'transport'))};}
function unknown(source,reason='missing-or-invalid-time'){return {status:'unknown',epoch_ms:null,absolute_iso:null,local_iso:null,local_label:'时间未知',time_zone:ZONE,source,reason};}
function point(value,unit,source){
 const epoch=typeof value==='number'&&Number.isFinite(value)?unit==='seconds'?Math.round(value*1000):value:NaN;
 if(!Number.isSafeInteger(epoch)||epoch<0||epoch>MAX_EPOCH||unit==='seconds'&&value<=0)return unknown(source);
 const date=new Date(epoch),parts=Object.fromEntries(format.formatToParts(date).map(part=>[part.type,part.value]));
 const offset=parts.timeZoneName==='GMT'?'+00:00':parts.timeZoneName.replace(/^GMT/,'');
 const localIso=parts.year+'-'+parts.month+'-'+parts.day+'T'+parts.hour+':'+parts.minute+':'+parts.second+'.'+parts.fractionalSecond+offset;
 return {status:'known',epoch_ms:epoch,absolute_iso:date.toISOString(),local_iso:localIso,local_label:parts.year+'-'+parts.month+'-'+parts.day+' '+parts.hour+':'+parts.minute+':'+parts.second+'（'+ZONE+' '+offset+'）',time_zone:ZONE,source,original_value:value,original_unit:unit,...(unit==='seconds'?{conversion:'Unix seconds to nearest millisecond; original numeric value retained'}:{})};
}
function duration(ms){
 const seconds=Math.floor(Math.abs(ms)/1000);if(!seconds)return '不到1秒';
 const days=Math.floor(seconds/86400),hours=Math.floor(seconds/3600)%24,minutes=Math.floor(seconds/60)%60,rest=seconds%60;
 if(days)return days+'天'+(hours?hours+'小时':'');
 if(hours)return hours+'小时'+(minutes?minutes+'分钟':'');
 if(minutes)return minutes+'分钟'+(rest?rest+'秒':'');return rest+'秒';
}
function age(now,time){
 if(now.status!=='known'||time.status!=='known')return {status:'unknown',elapsed_ms:null,label:'间隔未知',basis:'generation-now minus event absolute time'};
 const elapsed=now.epoch_ms-time.epoch_ms;
 return {status:elapsed<0?'future':'known',elapsed_ms:elapsed,label:elapsed<0?'来源时间晚于当前计算时间'+duration(elapsed)+'（负间隔，不能当成已等待）':elapsed===0?'此刻（0秒）':duration(elapsed)+'前',basis:'generation-now minus event absolute time'};
}
function interval(from,to,fromId,toId){
 if(from.status!=='known'||to.status!=='known')return {from:fromId,to:toId,status:'unknown',delta_ms:null,label:'事件间隔未知'};
 const delta=to.epoch_ms-from.epoch_ms;return {from:fromId,to:toId,status:delta<0?'negative':'known',delta_ms:delta,label:delta<0?'后项记录时间早于前项'+duration(delta)+'（负间隔）':delta===0?'两项记录时间相同':'两项记录相隔'+duration(delta)};
}
function binding(record,{current=false}={}){
 const {outer,payload,transport}=envelope(record),transportScope=scopeOf(own(transport,'conversation')),recordScope=scopeOf(own(outer,'peer')??own(outer,'scope')??own(payload,'scope'));
 const sourceEvent=opaque(own(transport,'message_id')),recordEvent=opaque(own(outer,'event')??own(payload,'event'));
 const issues=[];if(transportScope&&recordScope&&transportScope!==recordScope)issues.push('transport-record-scope-mismatch');if(sourceEvent&&recordEvent&&sourceEvent!==recordEvent)issues.push('transport-record-event-mismatch');
 const sender=opaque(own(transport,'sender_id')??(!current?own(outer,'sender_id')??own(outer,'senderId'):null));
 const validTransport=!!transport&&!!transportScope&&!!sourceEvent&&/^\d{5,15}$/.test(sender??'')&&!issues.length;
 const reference={scope:current?(validTransport?transportScope:null):transportScope??recordScope,event:current?(validTransport?sourceEvent:null):sourceEvent??recordEvent,sender_id:current?(validTransport?sender:null):/^\d{5,15}$/.test(sender??'')?sender:null,role:opaque(own(outer,'role'),30),state:opaque(own(outer,'state')??own(outer,'delivery_state'),40)};
 return {outer,payload,transport,reference,validTransport,issues,record_event:recordEvent,transport_event:sourceEvent,record_rowid:Number.isSafeInteger(own(outer,'rowid'))?own(outer,'rowid'):null};
}
function clocks(bound,{current=false,self=false}={}){
 const transport=point(own(bound.transport,'time'),'seconds','transport.time (Unix seconds)'),recorded=point(own(bound.outer,'at'),'milliseconds','turns.at (Unix milliseconds)');
 let effective;
 if(current&&!bound.validTransport)effective=unknown('current.transport','current-transport-identity-or-binding-unverified');
 else effective=self?recorded:transport.status==='known'?transport:recorded;
 return {transport,recorded,effective};
}
function forwarded(bound){const node=object(own(bound.payload,'node'))??bound.payload;return !bound.transport&&(has(node,'original_time')||has(node,'original_author')||own(bound.payload,'untrusted_forwarded_content')===true||/forward/.test(String(own(bound.payload,'kind')??'')));}
function prior(record,kind,current,now){
 if(!object(record))return {included:false,reason:'not-supplied',elapsed_ms:null,label:'没有可用记录'};
 const bound=binding(record),self=kind==='previous_self',time=clocks(bound,{self}),base={reference:bound.reference,time,counts_as_waiting:false};
 let reason=null;
 if(!current.reference.scope)reason='current-scope-unknown';
 else if(bound.issues.length)reason=bound.issues[0];
 else if(bound.reference.scope!==current.reference.scope)reason='different-or-unknown-conversation';
 else if(forwarded(bound))reason='forwarded-history-is-not-a-current-incoming-message';
 else if(self&&(bound.reference.state!=='sent'||bound.reference.role&&bound.reference.role!=='assistant'))reason='not-confirmed-self-delivery';
 else if(!self&&bound.reference.role&&bound.reference.role!=='user')reason='not-an-incoming-record';
 else if(bound.reference.event&&bound.reference.event===current.reference.event)reason='current-event-is-not-previous';
 if(reason)return {...base,included:false,reason,elapsed_ms:null,label:'不计为本会话间隔：'+reason};
 return {...base,included:true,...age(now,time.effective),same_sender_as_current:self?null:bound.reference.sender_id&&current.reference.sender_id?bound.reference.sender_id===current.reference.sender_id:null,time_basis:self?'turns.at is the stored assistant-row time; sent confirms delivery outcome, not an exact acknowledgement timestamp or recipient read time':'prefer transport.time seconds; explicitly fall back to turns.at milliseconds when source time is unknown',meaning:self?'本会话上一条已确认发送的汐回应；间隔基于turns.at记录时间，不代表精确送达确认时间，也不代表对方已读':'本会话上一条来话；sender_id可能不是本轮发话人，不能据此宣称本人已等待'};
}
function batches(bound){
 const ids=[];for(const source of [bound.transport,bound.payload,bound.outer])for(const key of ['batch_message_ids','message_ids','batch_event_ids']){const values=own(source,key);if(Array.isArray(values))for(const value of values.slice(0,24)){const id=opaque(value);if(id&&!ids.includes(id))ids.push(id);}}
 const recent=own(bound.payload,'recent_messages');if(Array.isArray(recent))for(const item of recent.slice(-24)){const id=opaque(own(own(item,'transport'),'message_id')??own(item,'message_id')??own(item,'event'));if(id&&!ids.includes(id))ids.push(id);}
 return {record_event:bound.record_event,transport_event:bound.transport_event,record_rowid:bound.record_rowid,queue_event_id:opaque(own(bound.outer,'queue_event_id')??own(bound.transport,'queue_event_id')),batch_id:opaque(own(bound.transport,'batch_id')??own(bound.outer,'batch_id')),batch_message_ids:ids.slice(0,24)};
}
function relevant(record,index,current,now){
 const bound=binding(record),isForward=forwarded(bound),node=object(own(bound.payload,'node'))??bound.payload;
 if(isForward){
  const original=point(own(node,'original_time'),'seconds','forwarded node original_time (reported Unix seconds)'),outer=point(own(own(bound.payload,'outer_source'),'time'),'seconds','forward outer_source.time (received Unix seconds)');
  return {id:opaque(own(bound.outer,'id')??own(node,'key'))??'relevant-'+index,kind:'forwarded-history',included:false,counts_as_waiting:false,reason:'forwarded-original-and-current-transport-are-different-events',reference:bound.reference,original_time:original,outer_time:outer,interval_to_outer:interval(original,outer,'forwarded-original','outer-received'),notice:'Original author/time are forwarded claims. Unknown original time is not replaced with reception time.'};
 }
 const time=clocks(bound,{self:bound.reference.role==='assistant'&&bound.reference.state==='sent'}),included=!!current.reference.scope&&bound.reference.scope===current.reference.scope&&!bound.issues.length;
 return {id:opaque(own(bound.outer,'id'))??'relevant-'+index,kind:opaque(own(bound.payload,'kind'),60)??'related-event',reference:bound.reference,time,included,counts_as_waiting:false,...(included?age(now,time.effective):{status:'excluded',elapsed_ms:null,label:'不同或未知会话，不计算本会话间隔'}),interval_to_current:included?interval(time.effective,current.time.effective,'relevant-'+index,'current'):null};
}
export function buildConversationTime({now,current,previousIncoming=null,previousSelf=null,relevantEvents=[]}={}){
 const nowMs=now instanceof Date?Date.prototype.getTime.call(now):now,computed=point(nowMs,'milliseconds','caller-supplied fresh generation time'),bound=binding(current,{current:true}),time=clocks(bound,{current:true});
 const currentResult={...bound.reference,verified_current_transport:bound.validTransport,binding:batches(bound),issues:bound.issues,time,...age(computed,time.effective),recorded_to_generation:bound.validTransport?age(computed,time.recorded):age(computed,unknown('turns.at','current-transport-unverified'))};
 const currentRef={reference:bound.reference,time};
 const incoming=prior(previousIncoming,'previous_incoming',currentRef,computed),self=prior(previousSelf,'previous_self',currentRef,computed),events=Array.isArray(relevantEvents)?relevantEvents:[];
 const intervals=[];if(incoming.included)intervals.push(interval(incoming.time.effective,time.effective,'previous_incoming','current'));if(self.included)intervals.push(interval(self.time.effective,time.effective,'previous_self','current'));
 return {time_zone:ZONE,computed_at:computed,current:currentResult,previous_incoming:incoming,previous_self:self,relevant_events:events.slice(0,16).map((record,index)=>relevant(record,index,currentRef,computed)),relevant_events_omitted:Math.max(0,events.length-16),intervals,notice:'Recompute for each generation. elapsed_ms is generation time minus the named event; intervals compare the two named absolute events. No date-word inference across midnight, emotional waiting threshold, claim of read status, or timing inference from another chat/forwarded history.'};
}
