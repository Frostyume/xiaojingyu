// Only protocol fields define addressing. Display names and message text are untrusted.
import faceMap from './qq-face-map.json' with {type:'json'};
import {segmentDetails} from './qq-segment-details.mjs';
export function transportMessage(message,{scope,botId,resolveReply=()=>null}={}){
 const segments=message.message.map(s=>{
  const extra=segmentDetails(s);
  if(s.type==='text')return {type:'text',text:String(s.data?.text??'')};
  if(['face','sface','bface','mface'].includes(s.type)){
   const raw=String(s.data?.id??s.data?.face_id??s.data?.faceId??''),id=s.type==='face'?extra.details.face_id:/^\d{1,6}$/.test(raw)?raw:null;
   return {...extra,type:s.type,id,name:s.type==='face'?extra.details.semantic_name:null,known:s.type==='face'&&extra.details.semantic_name_resolved===true,...(s.type!=='face'?{display_summary:String(s.data?.summary??'').slice(0,100),visual_understanding:false}:{})};
  }
  if(s.type==='at')return {type:'at',target:/^(?:\d{5,15}|all)$/.test(String(s.data?.qq))?String(s.data.qq):null};
  if(s.type==='reply'){
   const id=String(s.data?.id??'');
   const referenced=/^-?\d{1,20}$/.test(id)?resolveReply(id):null;
   return {type:'reply',message_id:id.slice(0,20),reference:referenced};
  }
  return {type:String(s.type).slice(0,40),...extra,...(s.type==='image'?{visual_understanding:false}:{})};
 });
 const targets=segments.filter(s=>s.type==='at').map(s=>s.target).filter(Boolean);
 const references=segments.filter(s=>s.type==='reply'&&s.reference).map(s=>s.reference.sender_id);
 const direct=!!botId&&(targets.includes(botId)||references.includes(botId));
 // Quoting one's own earlier sentence can clarify a reply to Xi. It does not
 // establish a conversation with another person; let semantic context decide.
 const others=!direct&&(targets.length>0&&targets.every(t=>t!=='all')||references.length>0&&references.every(id=>id!==botId&&id!==String(message.user_id)));
 return {transport:{conversation:scope.address,sender_id:String(message.user_id),message_id:String(message.message_id),time:message.time,
  display_name:String(message.sender?.card||message.sender?.nickname||'').slice(0,80),
  attention:direct?'direct':others?'others':'open',address_only:direct&&segments.every(s=>s.type==='at'||s.type==='text'&&!s.text.trim())},segments,
  body:segments.map(s=>s.type==='text'?s.text:s.type==='at'?'[at:'+s.target+']':s.type==='reply'?'[reply:'+s.message_id+']':s.type==='face'?'[QQ表情:'+ (s.name??'未知编号'+s.id)+']':s.details?.card?'['+s.type+':'+[s.details.card.title?.value,s.details.card.body?.value].filter(Boolean).join(' ')+']':s.details?.text?.value?'['+s.type+':'+s.details.text.value+']':'['+s.type+']').join('')};
}
