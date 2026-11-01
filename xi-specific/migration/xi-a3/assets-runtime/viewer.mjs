import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveOwnedRuntimePaths } from '../upstream/runtime/kernel/xi/owned-paths.mjs';
import { validateAssetsPaths } from './paths.mjs';
async function bounded(promise,ms,message){let timer;try{return await Promise.race([promise,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error(message)),ms);timer.unref();})]);}finally{clearTimeout(timer);}}
export function createOwnedWorkroomViewer({mainPaths,assetsPaths,port=17792,ownershipGate,python=process.env.XI_PYTHON}={}){
  let child,actualPort,state='disabled',exitPromise,exitResult,nonce,lock;
  function status(){return {kind:'owned-original-workroom-viewer',state,root:mainPaths?.bridgeRoot??null,pid:child&&!exitResult?child.pid:null,port:actualPort??null,baseURL:actualPort?'http://127.0.0.1:'+actualPort:null,readOnly:true,renderer:'original-workroom_view.py',browserExecution:false,lastExit:exitResult??null};}
  async function stop(){
    if(child&&!exitResult){state='stopping';child.stdin.end('stop\n');try{await bounded(exitPromise,5000,'VIEWER_STOP_TIMEOUT');}catch{child.kill();await bounded(exitPromise,3000,'VIEWER_EXIT_UNCONFIRMED_LOCK_RETAINED');}}
    if(lock&&nonce&&fs.existsSync(lock)){const value=JSON.parse(fs.readFileSync(lock,'utf8'));if(value.nonce!==nonce)throw new Error('VIEWER_LOCK_OWNER_CHANGED');fs.unlinkSync(lock);nonce=null;}
    state='stopped';return status();
  }
  async function start(){
    if(!python || !path.isAbsolute(python) || !fs.statSync(python).isFile())throw new Error('VIEWER_EXPLICIT_PYTHON_REQUIRED');
    if(state==='running')return status();if(state==='starting')throw new Error('VIEWER_START_IN_PROGRESS');
    if(typeof ownershipGate!=='function'||await ownershipGate({operation:'start-owned-workroom-viewer',mainPaths})!==true)throw new Error('VIEWER_LEASE_REQUIRED');
    const main=resolveOwnedRuntimePaths(mainPaths),assets=validateAssetsPaths(assetsPaths);
    if(!Number.isInteger(port)||!(port>=1024&&port<=65535||port===0&&main.fixture)||[17789,17790,17791].includes(port))throw new Error('VIEWER_EXPLICIT_NEW_PORT_REQUIRED');
    lock=path.join(main.bridgeRoot,'.workroom-viewer.lock');nonce=randomUUID();fs.writeFileSync(lock,JSON.stringify({nonce,parentPid:process.pid}),{flag:'wx'});state='starting';exitResult=null;
    let readyResolve,readyReject;const ready=new Promise((resolve,reject)=>{readyResolve=resolve;readyReject=reject;});let resolveExit;exitPromise=new Promise(resolve=>{resolveExit=resolve;});
    const env=Object.fromEntries(Object.entries(process.env).filter(([key])=>/^(PATH|SystemRoot|WINDIR|TEMP|TMP|USERPROFILE|LOCALAPPDATA|APPDATA)$/i.test(key)));env.PYTHONDONTWRITEBYTECODE='1';env.PYTHONUTF8='1';
    try{
      child=spawn(python,['-B',fileURLToPath(new URL('./viewer.py',import.meta.url)),'--db',assets.workroomDb,'--renderer',fileURLToPath(new URL('../../../companion/home/workroom_view.py',import.meta.url)),'--port',String(port)],{windowsHide:true,env,stdio:['pipe','pipe','pipe']});
      let output='';child.stdout.on('data',chunk=>{output+=String(chunk);if(output.includes('\n')){try{const value=JSON.parse(output.split('\n')[0]);if(value.ready&&value.pid===child.pid){actualPort=value.port;readyResolve();}}catch{readyReject(new Error('VIEWER_READY_INVALID'));}}});child.stderr.resume();
      child.once('error',()=>{if(!child.pid){exitResult={spawnFailed:true};resolveExit(exitResult);}readyReject(new Error('VIEWER_PROCESS_ERROR'));});
      child.once('exit',(code,signal)=>{exitResult={code,signal};if(state==='running')state='failed';resolveExit(exitResult);readyReject(new Error('VIEWER_EXITED_BEFORE_READY'));});
      await bounded(ready,10000,'VIEWER_START_TIMEOUT');state='running';fs.writeFileSync(lock,JSON.stringify({nonce,parentPid:process.pid,pid:child.pid,port:actualPort}));return status();
    }catch(error){state='failed';await stop();throw error;}
  }
  return {start,stop,status};
}
