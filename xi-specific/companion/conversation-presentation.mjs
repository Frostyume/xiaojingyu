// Model-facing view only. Original transport/history/attachment bytes remain in their stores.
export function presentConversation(text,{role='user',botId,peerBots=[],guardianIds=[]}={}){
 let v;try{v=JSON.parse(text);}catch{return String(text);}
 if(!v?.transport)return String(text);
 const actor=id=>({id:id??null,kind:id&&botId&&String(id)===String(botId)?'self':peerBots.map(String).includes(String(id))?'peer-bot':guardianIds.map(String).includes(String(id))?'guardian-human':id?'human':'unknown'});
 const t=v.transport,view={conversation:t.conversation,event:t.message_id,author:actor(t.sender_id),display_name:t.display_name??null,time:t.time??null,attention:t.attention,dialogue:v.dialogue?.focus,reply_anchor:v.routing??null,said:v.body??'',references:(v.segments??[]).filter(s=>s.type==='reply').map(s=>({event:s.message_id,author:actor(s.reference?.sender_id),said:s.reference?.body??null,time:s.reference?.time??null,source_known:!!s.reference})),mentions:(v.segments??[]).filter(s=>s.type==='at').map(s=>actor(s.target))};
 if(t.event_kind)view.notice={event_kind:t.event_kind,notice_key:t.notice_key,actor:actor(t.actor_id),target:actor(t.target_id),actor_display_name:t.actor_display_name??null,target_display_name:t.target_display_name??null,relation:t.relation??null};
 const other=(v.segments??[]).filter(s=>!['text','reply','at'].includes(s.type));if(other.length)view.attachments_and_expressions=other;
 if(v.received_images)view.received_images=v.received_images;if(v.image_intake?.length)view.image_intake=v.image_intake;if(v.forwarded)view.forwarded_quoted_material=v.forwarded;
 if(v.conversation_intent)view.current_conversation_intent=v.conversation_intent;
 return JSON.stringify(view);
}
