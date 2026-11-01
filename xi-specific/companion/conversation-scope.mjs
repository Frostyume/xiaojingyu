// Offline isolation building block. Scope comes from validated transport, never model arguments.
import {mkdirSync,lstatSync,existsSync,readFileSync,writeFileSync,readdirSync,renameSync,unlinkSync} from 'node:fs';
import {resolve,join,dirname,parse} from 'node:path';
import {randomUUID} from 'node:crypto';

export function conversationScope(kind,id){
 if(!['group','private'].includes(kind)||!/^\d{5,15}$/.test(String(id)))throw Error('Invalid conversation scope');
 return Object.freeze({kind,id:String(id),key:kind+'-'+id,address:kind+':'+id});
}
function rejectLinks(path){
 const absolute=resolve(path),root=parse(absolute).root;let current=root;
 for(const piece of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)){
  current=join(current,piece);if(existsSync(current)&&lstatSync(current).isSymbolicLink())throw Error('Links/junctions are not conversation files');
 }
}
export class ConversationWorkspace{
 constructor(base,scope){
  const valid=conversationScope(scope.kind,scope.id);this.root=resolve(base,valid.key);
  rejectLinks(this.root);mkdirSync(this.root,{recursive:true});
 }
 path(name){
  if(typeof name!=='string'||!name||name.length>240||/[\\:\x00-\x1f]/.test(name))throw Error('Use a plain relative path');
  const parts=name.split('/');
  if(parts.some(p=>!p||p==='.'||p==='..'||/[. ]$/.test(p)||/^(con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(p)))throw Error('Unsafe path');
  const file=join(this.root,...parts);rejectLinks(file);return file;
 }
 read(name){const file=this.path(name);if(lstatSync(file).size>65536)throw Error('Read limit');return readFileSync(file,'utf8');}
 write(name,text){
  if(typeof text!=='string'||Buffer.byteLength(text)>65536)throw Error('Write limit');
  const file=this.path(name);mkdirSync(dirname(file),{recursive:true});rejectLinks(file);
  const temp=join(dirname(file),'.pending-'+randomUUID());
  try{writeFileSync(temp,text,{encoding:'utf8',flag:'wx'});rejectLinks(file);renameSync(temp,file);}finally{if(existsSync(temp))unlinkSync(temp);}
  return {saved:true,path:name};
 }
 list(){rejectLinks(this.root);return readdirSync(this.root,{withFileTypes:true}).filter(e=>!e.isSymbolicLink()&&!e.name.startsWith('.pending-')).slice(0,100).map(e=>({name:e.name,directory:e.isDirectory()}));}
}
export function scopedHistoryArgs(scope,args){
 const s=conversationScope(scope.kind,scope.id);
 if(args.conversation!==undefined&&args.conversation!==s.address)throw Error('Cross-conversation query denied');
 if(args.group_id!==undefined&&(s.kind!=='group'||String(args.group_id)!==s.id))throw Error('Cross-group query denied');
 return {...args,conversation:s.address,...(s.kind==='group'?{group_id:s.id}:{})};
}
export function authorizeReply(scope,sourceMessage){
 const s=conversationScope(scope.kind,scope.id);
 const kind=sourceMessage?.message_type;
 const id=kind==='group'?sourceMessage.group_id:sourceMessage?.user_id;
 if(kind!==s.kind||String(id)!==s.id)throw Error('Reply source belongs to another conversation');
 return {kind:s.kind,id:Number(s.id)};
}
