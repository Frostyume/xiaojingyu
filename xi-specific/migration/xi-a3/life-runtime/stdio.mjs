import {StdioServerTransport} from '../../xi-a2/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import {createRetainedLifeContext} from './context.mjs';
import {createRetainedLifeServer} from './server.mjs';
export async function startRetainedLifeStdio({paths,identity,ownershipGate}) {
  let catalog,server,shutdownPromise;
  const shutdown=()=>shutdownPromise??=(async()=>{
    process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);process.stdin.off('end',onEnd);
    try{await server?.close();}finally{await catalog?.close();}return {closed:true,errors:[]};
  })();
  const onSignal=()=>void shutdown().finally(()=>process.exit(0)),onEnd=()=>void shutdown();
  try{
    catalog=await createRetainedLifeContext({paths,identity,ownerGate:ownershipGate});server=createRetainedLifeServer({catalog});
    process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);process.stdin.once('end',onEnd);
    await server.connect(new StdioServerTransport());return {shutdown,status:catalog.status};
  }catch(error){await shutdown();throw error;}
}
