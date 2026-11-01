import fs from 'node:fs';
import path from 'node:path';
import {parseArgs} from 'node:util';
import {openMailbox} from './store.mjs';
const {values,positionals}=parseArgs({allowPositionals:true,strict:true,options:{'runtime-root':{type:'string'},file:{type:'string'},'request-id':{type:'string'},status:{type:'string',default:'waiting'},offset:{type:'string',default:'0'},limit:{type:'string',default:'20'}}});
let mailbox;try{
  const command=positionals[0];if(positionals.length!==1||!['list','read','reply'].includes(command))throw Error('Usage: cli.mjs list|read|reply [--request-id ID] [--file reply.json]');
  if(!path.isAbsolute(values['runtime-root']??''))throw Error('MAILBOX_EXPLICIT_ABSOLUTE_RUNTIME_ROOT_REQUIRED');
  const root=path.resolve(values['runtime-root']);mailbox=await openMailbox({main:{bridgeRoot:root,configFile:path.join(root,'config.json')},ownershipGate:()=>true,access:'coordinator',create:false});
  let result;if(command==='reply'){if(!values.file)throw Error('MAILBOX_REPLY_FILE_REQUIRED');result=await mailbox.reply(JSON.parse(fs.readFileSync(values.file,'utf8').replace(/^\uFEFF/,'')));}
  else result=await mailbox.inbox({...(values['request-id']?{request_id:values['request-id']}:{ }),status:command==='read'?'all':values.status,offset:Number(values.offset),limit:Number(values.limit)});
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}catch(error){process.stderr.write(JSON.stringify({ok:false,error:error.name==='ZodError'?'MAILBOX_INVALID_INPUT':error.message})+'\n');process.exitCode=1;}finally{mailbox?.close();}
