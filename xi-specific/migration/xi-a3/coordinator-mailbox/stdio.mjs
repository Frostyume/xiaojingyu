import {StdioServerTransport} from '../../xi-a2/node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js';
import {openMailbox} from './store.mjs';
import {createMailboxServer} from './server.mjs';
export async function startMailboxStdio({main,ownershipGate}){
  let mailbox,server,shutdownPromise;
  const shutdown=()=>shutdownPromise??=(async()=>{process.off('SIGINT',onSignal);process.off('SIGTERM',onSignal);process.stdin.off('end',onEnd);try{await server?.close();}finally{mailbox?.close();}})();
  const onSignal=()=>void shutdown().finally(()=>process.exit(0)),onEnd=()=>void shutdown();
  try{mailbox=await openMailbox({main,ownershipGate,access:'xi'});server=createMailboxServer({mailbox});process.on('SIGINT',onSignal);process.on('SIGTERM',onSignal);process.stdin.once('end',onEnd);await server.connect(new StdioServerTransport());return {shutdown};}
  catch(error){await shutdown();throw error;}
}
