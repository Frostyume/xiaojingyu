import { randomUUID } from 'node:crypto';

/** Parent side: only the already-owned DSH process gets this ledger capability. */
export function attachAccountingIpc(child, accounting) {
  const active=new Set();
  const listener=message=>{
    if(message?.type!=='owned-accounting-request')return;
    const task=(async()=>{
      let response;
      try{if(!accounting)throw new Error('OWNED_ACCOUNTING_NOT_CONNECTED');const result=message.op==='admit'?await accounting.admit(message.payload):message.op==='complete'?await accounting.complete(message.payload):(()=>{throw new Error('OWNED_ACCOUNTING_OPERATION_REJECTED');})();response={ok:true,result};}
      catch(error){response={ok:false,error:error.message};}
      if(child.connected){try{child.send({type:'owned-accounting-response',id:message.id,...response},()=>{});}catch{}}
    })();active.add(task);task.finally(()=>active.delete(task)).catch(()=>{});
  };
  child.on('message',listener);
  return {async drain(){await Promise.all([...active]);},async close(){child.off('message',listener);await Promise.all([...active]);}};
}

/** Child side: small request/receipt IPC, never private prompts or credentials. */
export function createAccountingIpc() {
  const pending=new Map();
  const listener=message=>{
    if(message?.type!=='owned-accounting-response')return;
    const entry=pending.get(message.id);if(!entry)return;
    pending.delete(message.id);clearTimeout(entry.timer);
    if(message.ok)entry.resolve(message.result);else entry.reject(new Error(message.error??'OWNED_ACCOUNTING_REJECTED'));
  };
  process.on('message',listener);
  function close(){process.off('message',listener);for(const entry of pending.values()){clearTimeout(entry.timer);entry.reject(new Error('OWNED_ACCOUNTING_IPC_CLOSED'));}pending.clear();}
  return {request(op,payload){
    if(!process.connected||typeof process.send!=='function')return Promise.reject(new Error('OWNED_ACCOUNTING_PARENT_UNAVAILABLE'));
    const id=randomUUID();return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{pending.delete(id);reject(new Error('OWNED_ACCOUNTING_IPC_TIMEOUT'));},15000);timer.unref();pending.set(id,{resolve,reject,timer});
      process.send({type:'owned-accounting-request',id,op,payload},error=>{if(error){const entry=pending.get(id);if(entry){pending.delete(id);clearTimeout(timer);reject(new Error('OWNED_ACCOUNTING_IPC_SEND_FAILED'));}}});
    });
  },close};
}

export async function* accountedStream(options,next,ipc,{maxOutput,enabled}) {
  if(!enabled)throw new Error('OWNED_ACCOUNTING_NOT_CONNECTED');
  const requestId=randomUUID();
  const requestBytes=Buffer.byteLength(JSON.stringify({system:options.system??'',messages:options.messages??[],tools:options.tools??[]}));
  const output=options.maxTokens??maxOutput;
  const admission=await ipc.request('admit',{requestId,requestBytes,maxOutput:output,provider:options.provider,model:options.model});
  let usage=null,finished=false;
  try{
    for await(const chunk of next()){if(chunk.type==='usage')usage=chunk.usage;if(chunk.type==='finish')finished=true;yield chunk;}
  }finally{
    // Error/abort and absent/zero/incomplete usage never become a fabricated 0.
    await ipc.request('complete',{...admission,requestId,outcome:finished?'completed':'failed-or-aborted',usage:finished?usage:null});
  }
}
