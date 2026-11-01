import { readOwnedConsoleToken } from '../dsh/owned/web-credentials.mjs';
import path from 'node:path';
export function createWorkshopAdmission(main,ownershipGate,{fetcher=fetch}={}){
  return async()=>{
    if(await ownershipGate()!==true||!main.consolePort)return false;
    try{const token=readOwnedConsoleToken(main);if(!token)return false;const response=await fetcher('http://127.0.0.1:'+main.consolePort+'/api/xi/workshop/admit',{method:'POST',headers:{'content-type':'application/json','x-console-token':token},body:'{}',signal:AbortSignal.timeout(5000)});if(!response.ok){await response.body?.cancel();return false;}const value=await response.json();return value.ok===true&&typeof value.root==='string'&&path.resolve(value.root).toLowerCase()===path.resolve(main.bridgeRoot).toLowerCase();}catch{return false;}
  };
}
