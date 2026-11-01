// Diagnostics contain only protocol shape, closed-vocabulary tokens and a digest.
import {createHash} from 'node:crypto';
const words=new Set('invalid invalid_request_error invalid_request unsupported unsupported_parameter unsupported_value missing required empty null duplicate unknown length max_tokens max_output_tokens context_length_exceeded input output messages message content role user assistant system tool tools function_call function_call_output tool_calls tool_call_id reasoning reasoning_content reasoning_text reasoning_effort input_text output_text input_image image_url image content_filter moderation rejected expected got must cannot not found id call_id previous_response_id completed status incomplete pending budget quota rate_limit insufficient_balance bad_request format parameter allowed image_url'.split(' '));
const kinds=new Set(['message','reasoning','function_call','function_call_output','input_text','output_text','input_image']);
export function providerDiagnostics(error,request){
 let parsed;try{parsed=JSON.parse(error?.body??'');}catch{}
 const remote=parsed?.error??parsed??{},message=typeof remote.message==='string'?remote.message:String(error?.message??'');
 const safe=value=>typeof value==='string'&&words.has(value.toLowerCase())?value.toLowerCase():null;
 const params=String(remote.param??'').match(/^(?:input|messages|tools|reasoning|max_tokens|max_output_tokens|model)(?:\[\d{1,4}\]|\.(?:content|role|type|id|name|arguments|output|summary|reasoning_text|reasoning_content|image_url|effort))*$/);
 const tokens=[...new Set((message.toLowerCase().match(/[a-z_]+/g)??[]).filter(x=>words.has(x)))].slice(0,40);
 const shapes=(Array.isArray(request.input)?request.input:[]).map(item=>({type:kinds.has(item.type)?item.type:'other',...(item.role?{role:['user','assistant','system','developer'].includes(item.role)?item.role:'other'}:{}),content_chars:typeof item.content==='string'?item.content.length:undefined,parts:Array.isArray(item.content)?item.content.map(p=>kinds.has(p.type)?p.type:'other'):undefined}));
 return {provider_code:safe(remote.code),provider_type:safe(remote.type),provider_param:params?.[0]??null,error_tokens:tokens,error_digest:createHash('sha256').update(message).digest('hex'),request_shape:{items:shapes,tool_names:(request.tools??[]).map(t=>t.name).filter(n=>/^[a-z_]{1,50}$/.test(n)),reasoning_effort:request.reasoning?.effort??null}};
}
