// Bounded speech transcription of already obtained local media. No network or provider calls.
import {mkdirSync,mkdtempSync,writeFileSync,readFileSync,copyFileSync,lstatSync,realpathSync,rmSync,readdirSync,createReadStream} from 'node:fs';
import {join,dirname,resolve,isAbsolute,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {spawn} from 'node:child_process';
import {NativeWorkshopBackend} from './workshop-native.mjs';
import worker from './audio-worker.cjs';
import {readVideoDecoderConfig} from './video-decoder-config.mjs';
import {installationPath} from './installation-config.mjs';

const here=dirname(fileURLToPath(import.meta.url));
const NATIVE_NAMES=['sherpa-onnx.node','onnxruntime.dll','onnxruntime_providers_shared.dll','sherpa-onnx-c-api.dll','sherpa-onnx-cxx-api.dll'];
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
async function hashFile(path){const hash=createHash('sha256');for await(const bytes of createReadStream(path))hash.update(bytes);return hash.digest('hex');}
function sourceFile(path,max){const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.nlink!==1||stat.size<1||stat.size>max)throw Error('invalid-audio-runtime-file');return stat;}

export function planAudioSegments({duration,startSeconds=0,maxSeconds=120,segmentSeconds=30,timeoutMs=180000}={}){
  if(!Number.isFinite(duration)||duration<=0||!Number.isFinite(maxSeconds)||maxSeconds<=0||maxSeconds>300||
     !Number.isFinite(startSeconds)||startSeconds<0||startSeconds>=duration||!Number.isSafeInteger(Math.round(duration*16000))||
     !Number.isFinite(segmentSeconds)||segmentSeconds<1||segmentSeconds>30||!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw Error('audio-input-bound');
  const seconds=Math.floor(Math.min(duration-startSeconds,maxSeconds)*16000)/16000;
  if(seconds<=0||Math.ceil(seconds/segmentSeconds)>10)throw Error('audio-segment-bound');
  const segments=[];for(let elapsed=0;elapsed<seconds;){const length=Math.min(segmentSeconds,seconds-elapsed);segments.push({file:`clip-${segments.length}.wav`,start_seconds:startSeconds+elapsed,seconds:length});elapsed+=length;}
  return {seconds,segments,timeoutMs};
}

export function readAudioConfig(configPath=process.env.XI_AUDIO_DECODER_CONFIG){
  configPath=installationPath('XI_AUDIO_DECODER_CONFIG',configPath);sourceFile(configPath,32768);const config=JSON.parse(readFileSync(configPath,'utf8'));
  if(config.version!==1||config.model_id!=='sensevoice-small-int8-2024-07-17'||!['auto','zh','en','ja','ko','yue'].includes(config.language??'auto')||
     !Array.isArray(config.native_files)||config.native_files.length!==NATIVE_NAMES.length)throw Error('invalid-audio-decoder-config');
  const validate=(file,max)=>{if(!file||typeof file.path!=='string'||!isAbsolute(file.path)||!/^[a-f0-9]{64}$/.test(file.sha256))throw Error('invalid-audio-decoder-config');sourceFile(file.path,max);};
  validate(config.model,400_000_000);validate(config.tokens,2_000_000);
  const names=new Set();for(const file of config.native_files){if(!NATIVE_NAMES.includes(file.name)||names.has(file.name))throw Error('invalid-audio-native-list');names.add(file.name);validate(file,40_000_000);}
  return {...config,language:config.language??'auto'};
}

async function copyPinned(file,target){copyFileSync(file.path,target);if(await hashFile(target)!==file.sha256)throw Error('audio-runtime-copy-hash-mismatch');}

// The generated coordinator has no externally supplied code, command, URL, or path.
const ENTRY=String.raw`'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {transcribeWavs}=require('./audio-worker.cjs');
const job=JSON.parse(fs.readFileSync(path.join(__dirname,'job.json'),'utf8'));
(async()=>{
 for(const segment of job.segments){
  const filter='aresample=16000,atrim=end_sample='+Math.floor(segment.seconds*16000)+',asetpts=PTS-STARTPTS';
  const args=['-nostdin','-hide_banner','-loglevel','error','-protocol_whitelist','file,pipe','-ss',String(segment.start_seconds),'-i','input.mp4','-map','0:a:0','-vn','-sn','-dn','-af',filter,'-t',String(segment.seconds),'-ac','1','-ar','16000','-c:a','pcm_s16le','-threads','1','-f','wav','-fs',String(Math.ceil(segment.seconds*32000)+65536),'-y',segment.file];
  await new Promise((ok,no)=>{const p=spawn(path.join(__dirname,'ffmpeg.exe'),args,{shell:false,windowsHide:true,stdio:'ignore'});p.once('error',()=>no(Error('audio-decode-start-failed')));p.once('close',code=>code===0?ok():no(Error('audio-decode-failed')));});
 }
 const result=await transcribeWavs(job);fs.writeFileSync('transcript.json',JSON.stringify(result),{flag:'wx'});
})().catch(error=>{const allowed=new Set(['audio-decode-start-failed','audio-decode-failed','unsafe-audio-artifact','short-audio-artifact','invalid-audio-job','invalid-asr-result','audio-transcript-text-limit','audio-asr-native-load-failed','audio-wav-read-failed','audio-asr-model-load-failed','audio-asr-stream-failed','audio-asr-decode-failed']);const pcm=/^invalid-pcm-wav:[a-z-]+$/.test(error.message);fs.writeFileSync('failure.json',JSON.stringify({error:allowed.has(error.message)||pcm?error.message:'audio-asr-worker-failed',...(pcm?{pcm_diagnostics:error.pcm_diagnostics}:{})}),{flag:'wx'});process.exitCode=1;});
`;

class AppContainerAudioBoundary{
  constructor(nativeOptions){this.native=new NativeWorkshopBackend(nativeOptions);}
  ready(){return this.native.capabilities().ready;}
  async prepare(runtime,config,job,decoder){
    const node=join(runtime,'node.exe'),nodeHash=await hashFile(this.native.node);
    copyFileSync(this.native.node,node);if(await hashFile(node)!==nodeHash)throw Error('audio-node-copy-mismatch');
    await copyPinned({path:decoder.binary,sha256:decoder.binary_sha256},join(runtime,'ffmpeg.exe'));
    await copyPinned(config.model,join(runtime,'model.int8.onnx'));await copyPinned(config.tokens,join(runtime,'tokens.txt'));
    for(const file of config.native_files)await copyPinned(file,join(runtime,file.name));
    const workerBytes=readFileSync(join(here,'audio-worker.cjs'));writeFileSync(join(runtime,'audio-worker.cjs'),workerBytes,{flag:'wx'});
    writeFileSync(join(runtime,'entry.cjs'),ENTRY,{flag:'wx'});writeFileSync(join(runtime,'job.json'),JSON.stringify(job),{flag:'wx'});
    return {node_sha256:nodeHash,worker_sha256:sha(workerBytes)};
  }
  async run({run,work,runtime,signal,timeoutMs,scratchBytes}){
    signal?.throwIfAborted();const cancel=join(run,'cancel');
    const child=spawn(this.native.runner,[work,join(runtime,'node.exe'),'main.cjs',cancel],{windowsHide:true,shell:false,stdio:['pipe','pipe','pipe'],env:{SystemRoot:process.env.SystemRoot??'C:/Windows'}});
    let text='',stopped=null,forced=false,killTimer;
    const stop=reason=>{if(stopped)return;stopped=reason;try{writeFileSync(cancel,'cancel');}catch{}child.stdin.end();killTimer=setTimeout(()=>{forced=true;child.kill();},10000);killTimer.unref();};
    const abort=()=>stop('audio-cancelled');signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
    child.stdout.on('data',bytes=>{if(text.length+bytes.length>24000){stop('audio-runner-receipt-limit');return;}text+=bytes.toString('utf8');});
    child.stderr.resume();child.stdin.on('error',()=>{});
    const usage=()=>{let total=0,count=0;const scan=dir=>{for(const name of readdirSync(dir)){const path=join(dir,name),stat=lstatSync(path);if(stat.isSymbolicLink()||stat.nlink>1&&!stat.isDirectory())throw Error();if(stat.isDirectory())scan(path);else{if(!stat.isFile()||++count>128||(/\.(?:stdout|stderr)\.log$/.test(name)&&stat.size>131072))throw Error();total+=stat.size;}if(total>scratchBytes)throw Error();}};scan(work);};
    const guard=setInterval(()=>{try{usage();}catch{stop('audio-scratch-bound');}},100);guard.unref();
    const timer=setTimeout(()=>stop('audio-timeout'),timeoutMs);
    let code;try{code=await new Promise((ok,no)=>{child.once('error',no);child.once('close',ok);});}
    finally{clearInterval(guard);clearTimeout(timer);clearTimeout(killTimer);signal?.removeEventListener('abort',abort);child.stdin.destroy();}
    signal?.throwIfAborted();if(stopped)throw Error(stopped+(forced?'-forced-runner-close':''));
    let events;try{events=text.trim().split(/\r?\n/).filter(Boolean).map(JSON.parse);}catch{throw Error('invalid-audio-runner-receipt');}
    const finished=events.filter(e=>e.event==='finished'),cleanup=events.filter(e=>e.event==='profile-cleanup');
    if(code!==0||finished.length!==1||finished[0].exit_code!==0||finished[0].cancelled!==false||finished[0].appcontainer!==true||finished[0].capabilities!==0||cleanup.length!==1||cleanup[0].hresult!==0){
      let reason='restricted-audio-execution-failed';try{const failure=JSON.parse(worker.readRegular(join(work,'failure.json'),work,1024));if(/^audio-|^invalid-|^unsafe-|^short-/.test(failure.error)&&failure.error.length<80)reason=failure.error;}catch{}throw Error(reason);
    }
    return {backend:'Windows AppContainer fixed ffmpeg + Sherpa CPU',appcontainer:true,capabilities:0,process_tree_drained:true,profile_cleanup:true};
  }
}

export function audioDecoderAvailable({configPath=process.env.XI_AUDIO_DECODER_CONFIG,decoderConfigPath,nativeOptions}={}){
  // Cheap readiness only: every copied executable, DLL and model is hash-verified before execution.
  try{readAudioConfig(configPath);const decoder=readVideoDecoderConfig(decoderConfigPath);sourceFile(decoder.binary,150_000_000);return new AppContainerAudioBoundary(nativeOptions).ready();}catch{return false;}
}

function collectTranscript(result,job,work,duration){
  if(result.version!==1||result.kind!=='speech-transcript'||result.media_sha256!==job.media_sha256||result.sample_rate!==16000||
     result.audio_understood!==false||result.non_speech_understood!==false||result.alignment!=='segment-window-not-word-timestamps'||
     !Array.isArray(result.segments)||result.segments.length!==job.segments.length)throw Error('invalid-audio-transcript-artifact');
  let chars=0;const coverage=[];
  for(let i=0;i<result.segments.length;i++){
    const segment=result.segments[i],planned=job.segments[i];
    const bytes=worker.readRegular(join(work,planned.file),work,Math.ceil(planned.seconds*32000)+65536),wav=worker.parsePcmWav(bytes,planned.seconds);
    if(segment.start_ms!==Math.round(planned.start_seconds*1000)||segment.end_ms!==Math.round((planned.start_seconds+wav.seconds)*1000)||
       segment.wav_sha256!==wav.sha256||segment.samples!==wav.samples.length||typeof segment.text!=='string'||segment.text.length>4000||
       (chars+=segment.text.length)>16000||!['transcribed','no_transcript','silent_pcm'].includes(segment.state)||
       (segment.state==='transcribed')!==Boolean(segment.text)||(segment.state==='silent_pcm')!==wav.silent_pcm)throw Error('invalid-audio-transcript-artifact');
    if(segment.end_ms>segment.start_ms)coverage.push({start_ms:segment.start_ms,end_ms:segment.end_ms});
  }
  const gaps=[];let end=0;for(const range of coverage){if(range.start_ms>end)gaps.push({start_ms:end,end_ms:range.start_ms});end=Math.max(end,range.end_ms);}const durationMs=Math.round(duration*1000);if(end<durationMs)gaps.push({start_ms:end,end_ms:durationMs});
  return {coverage,unprocessed_ranges:gaps};
}

// Boundary injection exists for deterministic tests; production uses the fixed verified boundary.
export function createVideoAudioTranscriber({configPath=process.env.XI_AUDIO_DECODER_CONFIG,decoderConfigPath,nativeOptions,boundary=new AppContainerAudioBoundary(nativeOptions)}={}){
  return async function transcribe(bytes,{root,duration,signal,startSeconds=0,maxSeconds=120,segmentSeconds=30,timeoutMs=180000}={}){
    signal?.throwIfAborted();if(!Buffer.isBuffer(bytes)||bytes.length<1||bytes.length>64_000_000||typeof root!=='string'||!root)throw Error('audio-input-bound');
    const plan=planAudioSegments({duration,startSeconds,maxSeconds,segmentSeconds,timeoutMs}),config=readAudioConfig(configPath),decoder=readVideoDecoderConfig(decoderConfigPath);
    if(!boundary.ready())throw Error('verified-audio-boundary-unavailable');
    mkdirSync(root,{recursive:true});const base=realpathSync(root),run=mkdtempSync(join(base,'audio-')),work=join(run,'project'),runtime=join(run,'runtime');mkdirSync(work);mkdirSync(runtime);
    try{
      const job={version:1,media_sha256:sha(bytes),language:config.language,source_duration_seconds:duration,start_seconds:startSeconds,segments:plan.segments};
      writeFileSync(join(work,'input.mp4'),bytes,{flag:'wx'});writeFileSync(join(work,'main.cjs'),"require('../runtime/entry.cjs');",{flag:'wx'});
      const prepared=await boundary.prepare(runtime,config,job,decoder);signal?.throwIfAborted();
      const started=Date.now(),execution=await boundary.run({run,work,runtime,signal,timeoutMs:plan.timeoutMs,scratchBytes:bytes.length+Math.ceil(plan.seconds*32000)+2_000_000,job});
      signal?.throwIfAborted();const resultBytes=worker.readRegular(join(work,'transcript.json'),work,131072),result=JSON.parse(resultBytes);
      const intervals=collectTranscript(result,job,work,duration);
      const segments=result.segments.map(({start_ms,end_ms,text,state,wav_sha256,samples})=>({start_ms,end_ms,text,state,wav_sha256,samples}));
      return {version:1,kind:'speech-transcript',media_sha256:job.media_sha256,sample_rate:16000,alignment:'segment-window-not-word-timestamps',audio_understood:false,non_speech_understood:false,untrusted_external_content:true,segments,evidence:{...execution,...prepared,decoder_sha256:decoder.binary_sha256,model_id:config.model_id,model_sha256:config.model.sha256,tokens_sha256:config.tokens.sha256,
        media_sha256:job.media_sha256,transcript_sha256:sha(resultBytes),source_duration_seconds:duration,requested_start_seconds:startSeconds,requested_seconds:plan.seconds,...intervals,elapsed_ms:Date.now()-started,
        scope:'speech text from bounded local PCM; no sound/music/whale-call understanding',whole_video_watched:false}};
    }finally{const target=realpathSync(run);if(target.startsWith(base+sep)&&resolve(target)===resolve(run))rmSync(run,{recursive:true,force:true});}
  };
}

export async function transcribeVideoAudio(bytes,options={}){
  const {configPath=process.env.XI_AUDIO_DECODER_CONFIG,decoderConfigPath,nativeOptions,...rest}=options;return createVideoAudioTranscriber({configPath,decoderConfigPath,nativeOptions})(bytes,rest);
}
