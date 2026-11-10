import fs from 'node:fs';
import path from 'node:path';
import {spawn} from 'node:child_process';

const MiB=1024*1024;
function demand(ok,message){if(!ok)throw Error(message);}
export function runContainer({runner,work,executable,test,cancel,signal}){
  return new Promise((resolve,reject)=>{
    signal.throwIfAborted();
    const child=spawn(runner,[work,executable,test,cancel],{windowsHide:true,shell:false,
      env:{SystemRoot:process.env.SystemRoot||'C:/Windows',TEMP:path.dirname(cancel),TMP:path.dirname(cancel)},stdio:['pipe','pipe','ignore']});
    let lines='',tooLarge=false, scratchExceeded=false;
    const stop=()=>{try{fs.writeFileSync(cancel,'stop')}catch{} child.stdin.end();};
    signal.addEventListener('abort',stop,{once:true});child.stdin.on('error',()=>{});
    if(signal.aborted)stop();
    child.stdout.on('data',chunk=>{if(lines.length<24000)lines+=chunk.toString();else{tooLarge=true;stop();}});
    const guard=setInterval(()=>{
      let n=0,b=0;
      function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const full=path.join(dir,e.name);if(++n>20000)throw Error();if(e.isDirectory()&&!e.isSymbolicLink())visit(full);else if(e.isFile()){b+=fs.lstatSync(full).size;if(b>144*MiB)throw Error();}}}
      try{visit(work)}catch{scratchExceeded=true;stop();}
    },500);guard.unref();
    const done=()=>{clearInterval(guard);signal.removeEventListener('abort',stop);};
    child.once('error',e=>{done();reject(e);});
    child.once('close',code=>{
      done();
      try {
        signal.throwIfAborted();
        demand(!tooLarge&&!scratchExceeded,'测试超过工单资源限制');
        const events=lines.trim().split(/\r?\n/).filter(Boolean).map(x=>JSON.parse(x));
        const last=events.find(e=>e.event==='finished');
        demand(last?.appcontainer===true && last.capabilities===0 && !last.cancelled && events.some(e=>e.event==='profile-cleanup'&&e.hresult===0),'隔离进程未完整退出');
        demand(code===0 && last.exit_code===0,'原测试失败，退出码 '+last.exit_code);
        resolve({backend:'Windows AppContainer',network:false,exitCode:last.exit_code,elapsedMs:last.duration_ms});
      }catch(e){reject(e);}
    });
  });
}
