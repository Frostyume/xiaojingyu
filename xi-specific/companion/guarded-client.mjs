import {DatabaseSync} from 'node:sqlite';
import {randomUUID} from 'node:crypto';
import {providerDiagnostics} from './provider-diagnostics.mjs';

// Internal accounting, micro-CNY. Rate validation remains a deployment requirement.
export class SpendingBook {
  constructor(path,cap=15_000_000,{maxOutput=4096}={}){
    if(!Number.isSafeInteger(maxOutput)||maxOutput<1||maxOutput>32768)throw Error('Invalid accounting output bound');
    this.cap=cap;this.maxOutput=maxOutput;this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS calls(id TEXT PRIMARY KEY,day TEXT,reserved INTEGER,actual INTEGER,state TEXT)');
    this.db.exec('CREATE TABLE IF NOT EXISTS usage_receipts(call_id TEXT PRIMARY KEY,attempt_id TEXT,input INTEGER,cached_input INTEGER,output INTEGER,ceiling INTEGER)');
    this.db.exec('CREATE TABLE IF NOT EXISTS reservation_bounds(call_id TEXT PRIMARY KEY,input_upper INTEGER,max_output INTEGER,request_bytes INTEGER,at TEXT)');
    this.db.exec('CREATE TABLE IF NOT EXISTS provider_failures(call_id TEXT PRIMARY KEY,category TEXT,http_status INTEGER,attempt_count INTEGER,at TEXT)');
    this.db.exec('CREATE TABLE IF NOT EXISTS provider_diagnostics(call_id TEXT PRIMARY KEY,detail TEXT,at TEXT)');
  }
  reserve(amount,now=new Date()){
    if(!Number.isSafeInteger(amount)||amount<=0)throw new Error('Invalid reservation');
    const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const {total}=this.db.prepare("SELECT COALESCE(SUM(CASE WHEN state='pending' THEN reserved ELSE actual END),0) total FROM calls WHERE state='pending' OR day=?").get(day);
      if(this.cap!==null&&total+amount>this.cap)throw new Error('Daily spending allowance exhausted');
      const id=randomUUID();this.db.prepare("INSERT INTO calls VALUES(?,?,?,NULL,'pending')").run(id,day,amount);this.db.exec('COMMIT');return id;
    }catch(e){this.db.exec('ROLLBACK');throw e;}
  }
  settle(id,attempts){
    if(!Array.isArray(attempts)||!attempts.length)return;
    let total=0;
    for(const attempt of attempts){
      if(!attempt.charges?.length)return;
      for(const charge of attempt.charges){
        if(charge.quote?.currency!=='CNY'||charge.quote?.basis!=='marginal'||charge.amount===null||!Number.isFinite(charge.amount)||charge.amount<0||charge.missing?.length)return;
        total+=Math.ceil(charge.amount*1_000_000);
      }
    }
    if(!Number.isSafeInteger(total))throw new Error('Invalid charge');
    this.db.prepare("UPDATE calls SET actual=?,state='settled' WHERE id=? AND state='pending'").run(total,id);
  }
  settleDeepSeek(id,attempts){
    // Conservative CNY ceiling from official pricing checked 2026-10-24.
    // Always peak, but honor measured cache hits; this is not an invoice.
    if(!Array.isArray(attempts)||attempts.length!==1)return;
    const {input,output,cachedInput}=attempts[0].meters??{};
    if(!Number.isSafeInteger(input)||input<0||!Number.isSafeInteger(output)||output<0)return;
    if(input>1_048_576||output>this.maxOutput)throw new Error('Provider usage exceeds validated bounds');
    const cached=Number.isSafeInteger(cachedInput)&&cachedInput>=0&&cachedInput<=input?cachedInput:0;
    const ceiling=Math.ceil(((input-cached)*200+cached*4+output*800)/100);
    this.db.exec('BEGIN IMMEDIATE');
    try{
      const changed=this.db.prepare("UPDATE calls SET actual=?,state='settled' WHERE id=? AND state='pending'").run(ceiling,id);
      if(changed.changes)this.db.prepare('INSERT INTO usage_receipts VALUES(?,?,?,?,?,?)').run(id,attempts[0].id??null,input,cached,output,ceiling);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');throw error;}
  }
  close(){this.db.close();}
}

export function boundedReservation(request,options,maxOutput){
 // Byte fallback is a deliberately loose upper estimate, with a 4x margin and
 // fixed framing reserve. Never include raw request content in accounting data.
 const bytes=Buffer.byteLength(JSON.stringify({request:options.context?{...request,input:options.context}:request,nativeSpec:options.nativeSpec??null}));
 const inputUpper=bytes*4+8192;
 if(inputUpper>1_048_576)throw Error('Request exceeds validated reservation bound');
 if(!Number.isSafeInteger(maxOutput)||maxOutput<1||maxOutput>32768)throw Error('Invalid output bound');
 return {amount:Math.max(50000,Math.ceil((inputUpper*200+maxOutput*800)/100)),inputUpper,maxOutput,bytes};
}
export function guardedClient(resolveClient,book,{maxOutput=4096,reservation,searchPublic}={}){
  const make=(client)=>({
    bind(){return make(client??resolveClient());},
    async searchPublic(request,options={}){
      if(typeof searchPublic!=='function')throw Error('Public search not connected');
      if(typeof request?.query!=='string'||[...request.query].length>128||!Number.isSafeInteger(request.count)||request.count<1||request.count>10||request.need_content!==false)throw Error('Invalid public search request');
      book.db.exec('CREATE TABLE IF NOT EXISTS external_tool_calls(id TEXT PRIMARY KEY,tool TEXT,status TEXT,http_status INTEGER,result_count INTEGER,at TEXT)');
      const id=book.reserve(50000); // Provisional reserve, never an invented invoice.
      try{const result=await searchPublic(request,options);book.db.prepare('INSERT INTO external_tool_calls VALUES(?,?,?,?,?,?)').run(id,'deepseek-public-search','completed-cost-unknown',200,result.results?.length??0,new Date().toISOString());return result;}
      catch(error){book.db.prepare('INSERT INTO external_tool_calls VALUES(?,?,?,?,?,?)').run(id,'deepseek-public-search','failed-cost-unknown',Number.isInteger(error.status)?error.status:null,null,new Date().toISOString());throw error;}
    },
    canInitiate(now=new Date()){
      if(book.cap===null)return true;
      const day=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now);
      const {total}=book.db.prepare("SELECT COALESCE(SUM(CASE WHEN state='pending' THEN reserved ELSE actual END),0) total FROM calls WHERE state='pending' OR day=?").get(day);
      return total+50000<=book.cap;
    },
    async respond(request,options={}){
      if(request.model!=='deepseek-flash')throw new Error('Unvalidated model');
      if(request.max_output_tokens!=null&&(!Number.isSafeInteger(request.max_output_tokens)||request.max_output_tokens<1))throw Error('Invalid output bound');
      const output=Math.min(maxOutput,book.maxOutput??4096,request.max_output_tokens??8192);
      const resolved=client??resolveClient();
      const bounded=reservation===undefined?boundedReservation(request,options,output):null;
      const id=book.reserve(reservation??bounded.amount);
      if(bounded)book.db.prepare('INSERT INTO reservation_bounds VALUES(?,?,?,?,?)').run(id,bounded.inputUpper,bounded.maxOutput,bounded.bytes,new Date().toISOString());
      try{
        const result=await resolved.respond({...request,max_output_tokens:output},{...options,nativeSpec:{...options.nativeSpec,maxTokens:output},diagnostic:true});
        book.settleDeepSeek(id,result.attempts);return result;
      }catch(e){
        book.settleDeepSeek(id,e.attempts);
        const attempts=Array.isArray(e.attempts)?e.attempts:[],raw=e.status??attempts.at(-1)?.status;
        const status=Number.isInteger(raw)&&raw>=100&&raw<=599?raw:null;
        book.db.prepare('INSERT OR REPLACE INTO provider_failures VALUES(?,?,?,?,?)').run(id,status?'http-rejected-or-unavailable':e.name==='AbortError'?'aborted':'unclassified',status,Math.min(attempts.length,100),new Date().toISOString());
        try{book.db.prepare('INSERT OR REPLACE INTO provider_diagnostics VALUES(?,?,?)').run(id,JSON.stringify(providerDiagnostics(e,request)),new Date().toISOString());}catch{}
        throw e;
      }
    }
  });
  return make(null);
}
