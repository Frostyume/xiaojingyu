import {installationPath} from './installation-config.mjs';
// Offline OS boundary; DSH remains separately installed and separately budgeted.
import {mkdirSync,mkdtempSync,readFileSync,writeFileSync,copyFileSync,readdirSync,lstatSync,realpathSync,existsSync,unlinkSync,rmdirSync,openSync,readSync,closeSync,fstatSync} from 'node:fs';
import {join,dirname,resolve,relative,sep} from 'node:path';import {fileURLToPath} from 'node:url';import {createHash,randomUUID} from 'node:crypto';import {spawn} from 'node:child_process';import {safeWorkroomPath} from './workroom.mjs';
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
function boundedText(path,root,limit){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||!realpathSync(path).startsWith(realpathSync(root)+sep))throw Error('Unsafe diagnostic artifact');const fd=openSync(path,'r');try{const open=fstatSync(fd);if(!open.isFile()||open.nlink!==1)throw Error('Unsafe diagnostic descriptor');const bytes=Buffer.alloc(limit);return bytes.subarray(0,readSync(fd,bytes,0,limit,0)).toString('utf8');}finally{closeSync(fd);}}
const here=dirname(fileURLToPath(import.meta.url));
export class NativeWorkshopBackend{
 constructor({root,runner=process.env.XI_APPCONTAINER_RUNNER,node=process.env.XI_NODE_EXE,verification=process.env.XI_APPCONTAINER_PROOF}={}){Object.assign(this,{root,runner,node,verification});}
 capabilities(){
  try{installationPath('XI_APPCONTAINER_RUNNER',this.runner);installationPath('XI_NODE_EXE',this.node);installationPath('XI_APPCONTAINER_PROOF',this.verification);const proof=JSON.parse(readFileSync(this.verification,'utf8'));if(process.platform!=='win32'||proof.verified!==true||proof.backend_sha256!==sha(readFileSync(fileURLToPath(import.meta.url)))||proof.runner_sha256!==sha(readFileSync(this.runner))||proof.node_sha256!==sha(readFileSync(this.node)))throw Error('Release/runtime proof mismatch');
   return {ready:true,backend:'Windows AppContainer offline Node',entrypoint_required:true,runtime:'Node '+proof.node_version,network:false,host_shell:false,dsh_execution:false,dsh_gateway_unchanged:true,independent_daily_cap_cny:1,proof_at:proof.at,limits:{job_memory_bytes:1073741824,processes:16,export_file_bytes:32768,export_project_bytes:131072},notice:'Runs the explicitly selected project entrypoint. No network/npm/DSH model; result requires an actual artifact and trusted process receipt.'};
  }catch(error){return {ready:false,backend:'Windows AppContainer offline Node',reason:['XI_MISSING_CONFIG','XI_INVALID_CONFIG'].includes(error?.code)?error.message:'Verified runner/runtime release is unavailable or changed; execution disabled',independent_daily_cap_cny:1};}
 }
 async run({job_id,files,expected_outputs,checkpoint,signal,onCheckpoint=()=>{}}){
  signal?.throwIfAborted();const capability=this.capabilities();if(!capability.ready)throw Error(capability.reason);
  const entry=safeWorkroomPath(checkpoint?.entrypoint??'main.mjs');if(!/\.(mjs|cjs|js)$/.test(entry)||!Object.hasOwn(files,entry))throw Error('Create a JS entrypoint in the frozen project version first');
  mkdirSync(this.root,{recursive:true});const run=mkdtempSync(join(this.root,'run-')),work=join(run,'project'),runtime=join(run,'runtime'),cancel=join(run,'cancel');mkdirSync(work);mkdirSync(runtime);
  for(const [path,text] of Object.entries(files)){safeWorkroomPath(path);const file=join(work,path);mkdirSync(dirname(file),{recursive:true});writeFileSync(file,text,{flag:'wx'});}
  for(const output of expected_outputs){safeWorkroomPath(output);if(output===entry)throw Error('Entrypoint cannot also be a generated output');const previous=join(work,output);if(existsSync(previous))unlinkSync(previous);}
  const localNode=join(runtime,'node.exe');copyFileSync(this.node,localNode);if(sha(readFileSync(localNode))!==sha(readFileSync(this.node)))throw Error('Runtime copy hash mismatch');
  const runId=randomUUID(),events=[],started=Date.now();let buffer='',oversized=false,stopReason=null;
  const child=spawn(this.runner,[work,localNode,entry,cancel],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot??'C:/Windows',windir:process.env.SystemRoot??'C:/Windows',TEMP:run,TMP:run,PATH:join(process.env.SystemRoot??'C:/Windows','System32')}});
  const stop=reason=>{stopReason??=reason;try{writeFileSync(cancel,'cancel');}catch{};child.stdin.end();};const aborted=()=>stop('explicit-cancellation');signal?.addEventListener('abort',aborted,{once:true});if(signal?.aborted)aborted();
  child.stdout.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>24000){stop('runner-receipt-limit');return;}let at;while((at=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,at).trim();buffer=buffer.slice(at+1);if(!line)continue;try{const event=JSON.parse(line);events.push(event);if(event.event==='started')onCheckpoint({...checkpoint,phase:'running',run_id:runId,runner_pid:child.pid,process_pid:event.pid,execution_backend:'Windows AppContainer offline Node'});}catch{stop('invalid-trusted-receipt');}}});
  child.stdin.on('error',()=>{});
  let runnerError='';child.stderr.on('data',chunk=>{runnerError=(runnerError+chunk).slice(0,2000);});
  const usage=()=>{let bytes=0,count=0;const scan=dir=>{for(const item of readdirSync(dir)){const path=join(dir,item),stat=lstatSync(path);if(stat.isSymbolicLink())continue;if(stat.isDirectory())scan(path);else{count++;bytes+=stat.size;}if(bytes>16*1024*1024||count>1000)throw Error('scratch-space guard');}};scan(work);};
  const guard=setInterval(()=>{try{usage();}catch{oversized=true;stop('scratch-space-guard');}},250);guard.unref();
  let code;
  try{code=await new Promise((ok,no)=>{child.once('error',no);child.once('close',ok);});}finally{clearInterval(guard);signal?.removeEventListener('abort',aborted);child.stdin.destroy();try{unlinkSync(localNode);rmdirSync(runtime);}catch{}}
  const finished=events.find(e=>e.event==='finished'),cleanup=events.find(e=>e.event==='profile-cleanup');
  const evidence={backend:'Windows AppContainer offline Node',run_id:runId,job_id,entrypoint:entry,elapsed_ms:Date.now()-started,events,stop_reason:stopReason};writeFileSync(join(run,'execution-receipt.json'),JSON.stringify(evidence,null,2),{flag:'wx'});
  signal?.throwIfAborted();if(oversized)throw Error('Workshop scratch-space guard stopped execution');
  if(code!==0||!finished||finished.exit_code!==0||finished.cancelled||finished.appcontainer!==true||finished.capabilities!==0||cleanup?.hresult!==0){let message='';try{message=boundedText(join(work,'.stderr.log'),work,1800);}catch{}throw Error('Restricted execution did not complete: '+String(events.find(e=>e.event==='runner-error')?.error??message??runnerError).slice(0,1800));}
  const exported={},artifacts=[];let total=0;const base=realpathSync(work);
  const collect=(dir,prefix='')=>{for(const name of readdirSync(dir)){if(name.startsWith('.'))continue;const path=join(dir,name),sub=prefix+name,stat=lstatSync(path);if(stat.isSymbolicLink()||stat.nlink>1||!realpathSync(path).startsWith(base+sep))throw Error('Linked/reparse artifact refused');if(stat.isDirectory()){collect(path,sub+'/');continue;}if(!stat.isFile())throw Error('Artifact is not a regular file');try{safeWorkroomPath(sub);}catch{continue;}if(stat.size>32768||Object.keys(exported).length>=20)throw Error('Artifact export size/count limit');const bytes=readFileSync(path);if(total+bytes.length>131072)throw Error('Artifact export project size limit');const text=bytes.toString('utf8');if(text.includes('\0')||!Buffer.from(text).equals(bytes))throw Error('Artifact is not UTF-8 text');total+=bytes.length;exported[sub]=text;artifacts.push({path:sub,bytes:bytes.length,sha256:sha(bytes)});}};
  collect(work);for(const expected of expected_outputs)if(!Object.hasOwn(exported,expected)||!exported[expected].length)throw Error('Expected actual artifact is absent: '+expected);
  onCheckpoint({...checkpoint,phase:'executed',run_id:runId,artifact_paths:artifacts.map(a=>a.path)});
  return {status:'completed',files:exported,evidence:{...evidence,artifacts,tool_results:[{tool:'windows-appcontainer-node',status:'completed',exit_code:0,token_appcontainer:true,capabilities:0,actual_artifacts:artifacts.length}]}};
 }
}
