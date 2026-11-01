import { StdioServerTransport } from '../../xi-a2/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import { openAssetsStore } from './store.mjs';
import { createAssetsServer } from './server.mjs';
import { prepareMediaForMain } from './delivery.mjs';
import { createOwnedWorkshopController } from './workshop.mjs';
import { createWorkshopAdmission } from './workshop-admission.mjs';
import { resolveOwnedRuntimePaths } from '../upstream/runtime/kernel/xi/owned-paths.mjs';
export async function startAssetsStdio(options){
  let store,server,transport,workshop,closed=false;
  async function shutdown(){if(closed)return;closed=true;process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);process.stdin.off('end',onEnd);try{await server?.close();}finally{await workshop?.close();store?.close();}}
  const onSignal=()=>void shutdown().finally(()=>process.exit(0));
  const onEnd=()=>void shutdown();
  try{
    store=await openAssetsStore(options);store.mediaPrepare=({id})=>prepareMediaForMain({store,mainPaths:options.mainPaths,id,ownershipGate:options.ownershipGate});if(options.paths.workshop)workshop=await createOwnedWorkshopController({...options,admitExecution:createWorkshopAdmission(resolveOwnedRuntimePaths(options.mainPaths),options.ownershipGate)});server=createAssetsServer({store,workshop});transport=new StdioServerTransport();
    process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);process.stdin.once('end',onEnd);
    await server.connect(transport);return {shutdown};
  }catch(error){await shutdown();throw error;}
}
