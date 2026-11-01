// Fixed decoder in the existing verified zero-capability AppContainer. No host ffmpeg execution.
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,copyFileSync,lstatSync,realpathSync,rmSync} from 'node:fs';import {join,resolve,sep} from 'node:path';import {spawn} from 'node:child_process';import {createHash} from 'node:crypto';
import {NativeWorkshopBackend} from './workshop-native.mjs';import {readVideoDecoderConfig} from './video-decoder-config.mjs';
const sha=b=>createHash('sha256').update(b).digest('hex');
export async function finishVideoArtifacts({root,run,result,primaryError,runnerStarted=false,runnerExited=false,executionVerified=false,remove=rmSync}){
 const record={pending:false,attempts:0};
 try{
  if(runnerStarted&&!runnerExited)throw Error('video-runner-exit-not-confirmed');
  const parent=realpathSync(root),target=realpathSync(run);
  if(!target.startsWith(parent+sep)||resolve(target)!==resolve(run))throw Error('video-cleanup-path-refused');
  for(let attempt=0;attempt<3;attempt++){
   record.attempts++;
   try{remove(target,{recursive:true,force:true});return record;}
   catch(e){if(attempt===2||!['EBUSY','EPERM','EACCES','ENOTEMPTY'].includes(e.code))throw e;await new Promise(ok=>setTimeout(ok,50*(attempt+1)));}
  }
 }catch(e){
  record.pending=true;record.reason=['video-runner-exit-not-confirmed','video-cleanup-path-refused'].includes(e.message)?e.message:'video-artifact-cleanup-pending';
  // Cleanup cannot replace a decode/validation failure, nor turn an unverified
  // process into success. Verified frame bytes remain useful when Windows has
  // a transient handle on a copied executable after the runner has exited.
  if(primaryError){primaryError.cleanup=record;return record;}
  if(result&&executionVerified&&(!runnerStarted||runnerExited)&&record.reason==='video-artifact-cleanup-pending'){
   result.evidence.cleanup_pending=true;result.evidence.cleanup=record;return record;
  }
  throw e;
 }
}
export function videoDecoderStatus({nativeOptions,decoderConfigPath}={}){try{const native=new NativeWorkshopBackend(nativeOptions),capability=native.capabilities();if(!capability.ready)return {ready:false,reason:capability.reason};const decoder=readVideoDecoderConfig(decoderConfigPath);if(sha(readFileSync(decoder.binary))!==decoder.binary_sha256)throw Error('decoder-source-hash-mismatch');return {ready:true};}catch(error){return {ready:false,reason:['XI_MISSING_CONFIG','XI_INVALID_CONFIG'].includes(error?.code)?error.message:'Verified decoder configuration or binary unavailable'};}}
export function videoDecoderAvailable(options){return videoDecoderStatus(options).ready;}
export async function sampleVideoFrames(bytes,{root,duration,signal,nativeOptions,decoderConfigPath}={}){
 const status=videoDecoderStatus({nativeOptions,decoderConfigPath});if(!status.ready)throw Error(status.reason);const native=new NativeWorkshopBackend(nativeOptions),decoder=readVideoDecoderConfig(decoderConfigPath);
 if(!Buffer.isBuffer(bytes)||bytes.length>64_000_000||!Number.isFinite(duration)||duration<=0)throw Error('verified-video-decoder-unavailable-or-input-bound');signal?.throwIfAborted();mkdirSync(root,{recursive:true});const run=mkdtempSync(join(root,'video-')),work=join(run,'project'),runtime=join(run,'runtime');mkdirSync(work);mkdirSync(runtime);const times=[Math.min(duration-0.2,duration*0.2),Math.min(duration-0.2,duration*0.7)].map(t=>Math.max(0,t));
 let result,primaryError,runnerStarted=false,runnerExited=false,executionVerified=false;
 try{writeFileSync(join(work,'input.mp4'),bytes);copyFileSync(native.node,join(runtime,'node.exe'));if(sha(readFileSync(join(runtime,'node.exe')))!==sha(readFileSync(native.node)))throw Error('video-node-copy-mismatch');copyFileSync(decoder.binary,join(runtime,'ffmpeg.exe'));if(sha(readFileSync(join(runtime,'ffmpeg.exe')))!==decoder.binary_sha256)throw Error('decoder-copy-mismatch');
 writeFileSync(join(work,'main.mjs'),`import {spawn} from 'node:child_process';for(const [i,t] of ${JSON.stringify(times)}.entries()){await new Promise((ok,no)=>{const p=spawn('../runtime/ffmpeg.exe',['-nostdin','-loglevel','error','-protocol_whitelist','file,pipe','-ss',String(t),'-i','input.mp4','-frames:v','1','-vf','scale=576:-2','-q:v','6','-threads','1','-y','frame'+i+'.jpg'],{stdio:'ignore',shell:false});p.on('error',no);p.on('close',c=>c===0?ok():no(Error('decode failed')));});}`);
 const child=spawn(native.runner,[work,join(runtime,'node.exe'),'main.mjs',join(run,'cancel')],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot??'C:/Windows'}});runnerStarted=true;let output='';child.stdout.on('data',b=>{output+=b;if(output.length>24000)abort();});child.stderr.resume();child.stdin.on('error',()=>{});const abort=()=>{writeFileSync(join(run,'cancel'),'cancel');child.stdin.end();};signal?.addEventListener('abort',abort,{once:true});const timer=setTimeout(abort,45000);if(signal?.aborted)abort();let code;try{code=await new Promise((ok,no)=>{child.on('error',no);child.on('close',c=>{runnerExited=true;ok(c);});});}finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);child.stdin.destroy();}signal?.throwIfAborted();const events=output.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse),done=events.find(e=>e.event==='finished');if(code!==0||!done||done.cancelled||done.appcontainer!==true||done.capabilities!==0||events.find(e=>e.event==='profile-cleanup')?.hresult!==0)throw Error('restricted-video-decode-failed');executionVerified=true;
 const frames=times.map((time,i)=>{const path=join(work,'frame'+i+'.jpg'),s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>250000)throw Error('unsafe-frame-artifact');const data=readFileSync(path);if(data[0]!==255||data[1]!==216)throw Error('invalid-frame');return {time,bytes:data,sha256:sha(data)};});result={frames,evidence:{backend:'Windows AppContainer fixed ffmpeg',appcontainer:true,capabilities:0,process_tree_drained:true,decoder_sha256:decoder.binary_sha256,media_sha256:sha(bytes),sample_times:times,audio_processed:false,whole_video_watched:false}};return result;
 }catch(e){primaryError=e;throw e;}
 finally{await finishVideoArtifacts({root,run,result,primaryError,runnerStarted,runnerExited,executionVerified});}
}
