// Fixed labels only: never persist raw errors, response bodies, headers or messages.
export function conversationFailure(error,phase,signal){
 const allowed=new Set(['AbortError','TimeoutError','TypeError','RangeError','ReferenceError','GenerationError','ResponseProtocolError','Error']);
 const name=allowed.has(error?.name)?error.name:'OtherError';
 const attempts=Array.isArray(error?.attempts)?error.attempts:[];
 const value=error?.status??attempts.at(-1)?.status;
 const status=Number.isInteger(value)&&value>=100&&value<=599?value:null;
 let category='generation-failed';
 if(phase==='send')category='delivery-uncertain';
 else if(name==='ReferenceError')category='local-code-error';
 else if(error?.message==='Daily spending allowance exhausted')category='budget-blocked';
 else if(signal?.aborted||name==='AbortError'||name==='TimeoutError')category=signal?.reason?.name==='TimeoutError'||name==='TimeoutError'?'generation-timeout':'cancelled';
 else if(error?.code==='SCOPED_OUTPUT_LIMIT')category='generation-output-limit';
 else if(status&&status>=400)category=status===429?'provider-rate-limit':status<500?'provider-request-rejected':'provider-unavailable';
 else if(error?.code==='SCOPED_TOOL_ROUNDS')category='tool-round-limit';
 else if(error?.code==='SCOPED_REPLY_INVALID')category='invalid-model-reply';
 else if(error?.code==='SCOPED_RESPONSE_INCOMPLETE')category='incomplete-model-response';
 else if(phase==='tool-setup')category='tool-setup-failed';
 else if(phase==='receipt')category='receipt-storage-failed';
 return {phase,category,error_type:name,http_status:status,attempt_count:Math.min(attempts.length,100)};
}
