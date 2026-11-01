import fs from 'node:fs';
import path from 'node:path';
import { randomUUID,createHash } from 'node:crypto';
import { resolveOwnedRuntimePaths } from '../upstream/runtime/kernel/xi/owned-paths.mjs';
import { normalizeImageEntry } from '../upstream/services/media/image-lib.js';

function checkedTarget(root,file){
  const relative=path.relative(root,file);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('ASSETS_DELIVERY_OUTSIDE_OWNED_ROOT');
  let cursor=path.parse(file).root;for(const part of file.slice(cursor.length).split(path.sep).filter(Boolean)){cursor=path.join(cursor,part);if(fs.existsSync(cursor)){const stat=fs.lstatSync(cursor);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw new Error('ASSETS_DELIVERY_LINK_REJECTED');}}
  return file;
}
function atomicJson(root,file,value){checkedTarget(root,file);const temp=path.join(path.dirname(file),'.retained-'+randomUUID());try{fs.writeFileSync(temp,JSON.stringify(value,null,2),{flag:'wx'});checkedTarget(root,file);fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}}
/** Private materialization only. Main remains the only writer of images.json. */
export async function materializeRetainedMedia({store,mainPaths,ids,ownershipGate}){
  if(typeof ownershipGate!=='function'||await ownershipGate({operation:'materialize-retained-media',mainPaths})!==true)throw new Error('ASSETS_DELIVERY_LEASE_REQUIRED');
  const main=resolveOwnedRuntimePaths(mainPaths),config=JSON.parse(fs.readFileSync(main.configFile,'utf8'));
  const imageDir=path.resolve(main.bridgeRoot,'images'),configured=config.simulation?.imageLibrary?.dir;
  if(configured&&path.resolve(configured).toLowerCase()!==imageDir.toLowerCase())throw new Error('ASSETS_DELIVERY_IMAGE_CONFIG_MISMATCH');
  if(!Array.isArray(ids)||!ids.length||ids.length>100)throw new Error('ASSETS_DELIVERY_EXPLICIT_IDS_REQUIRED');
  checkedTarget(main.bridgeRoot,imageDir);checkedTarget(main.bridgeRoot,main.stateDir);fs.mkdirSync(imageDir,{recursive:true});fs.mkdirSync(main.stateDir,{recursive:true});
  const mapFile=checkedTarget(main.bridgeRoot,path.join(main.stateDir,'retained-media-map.json'));
  const lock=checkedTarget(main.bridgeRoot,path.join(main.stateDir,'.retained-media.lock')),nonce=randomUUID();
  fs.writeFileSync(lock,JSON.stringify({pid:process.pid,nonce}),{flag:'wx'});
  try{
    let images=[];if(fs.existsSync(mapFile)){const old=JSON.parse(fs.readFileSync(mapFile,'utf8'));if(old.format!=='xi-retained-media-v1'||!Array.isArray(old.images)||old.images.length>5000)throw new Error('ASSETS_DELIVERY_MAP_INVALID');images=old.images;}
    const prepared=[];
    for(const id of new Set(ids)){
      const {metadata,bytes,mime}=store.mediaPayload(id),extension={'image/png':'.png','image/jpeg':'.jpg','image/gif':'.gif','image/webp':'.webp'}[mime];if(!extension)throw new Error('ASSETS_DELIVERY_MIME_UNSUPPORTED');
      const ref='retained-'+id,file=ref+extension,target=checkedTarget(main.bridgeRoot,path.join(imageDir,file));
      if(fs.existsSync(target)){if(createHash('sha256').update(fs.readFileSync(target)).digest('hex')!==metadata.sha)throw new Error('ASSETS_DELIVERY_EXISTING_BYTES_CONFLICT');}
      else fs.writeFileSync(target,bytes,{flag:'wx'});
      const descriptor=normalizeImageEntry({id:ref,name:ref,file,mime,bytes:bytes.length,md5:createHash('md5').update(bytes).digest('hex'),note:('汐原收藏 · '+metadata.source).slice(0,500),tags:['retained-memory'],sourceUrl:'',origin:'import',createdAt:new Date(metadata.created).toISOString(),retainedSource:{kind:'scoped_media',id,owner:metadata.owner,source:metadata.source,sha256:metadata.sha,created:metadata.created}});
      if(!descriptor.retainedSource)throw new Error('ASSETS_DELIVERY_PROVENANCE_REJECTED');
      const index=images.findIndex(row=>row.id===ref);if(index>=0)images[index]={...images[index],...descriptor,useCount:images[index].useCount??0,lastUsedAt:images[index].lastUsedAt??0};else images.push(descriptor);
      prepared.push({id,image_ref:ref,sha256:metadata.sha,source:descriptor.retainedSource});
    }
    if(images.length>5000)throw new Error('ASSETS_DELIVERY_IMAGE_COUNT_BOUND');
    atomicJson(main.bridgeRoot,mapFile,{format:'xi-retained-media-v1',images});
    return {prepared,mapFile,imageDir,indexOwnedByMain:true,qq_sent:false};
  }finally{const value=JSON.parse(fs.readFileSync(lock,'utf8'));if(value.nonce===nonce)fs.unlinkSync(lock);}
}

export async function prepareMediaForMain({store,mainPaths,id,ownershipGate}){
  const result=await materializeRetainedMedia({store,mainPaths,ids:[id],ownershipGate});
  const main=resolveOwnedRuntimePaths(mainPaths),config=JSON.parse(fs.readFileSync(main.configFile,'utf8'));
  let consoleToken=String(config.consoleToken??'').trim();if(!/^[A-Za-z0-9_-]{16,128}$/.test(consoleToken)){try{consoleToken=fs.readFileSync(path.join(main.stateDir,'console-token'),'utf8').trim();}catch{consoleToken='';}}
  if(!main.consolePort||!consoleToken)return {prepared:true,image_ref:result.prepared[0].image_ref,reloaded:false,reason:'main-console-not-configured',qq_sent:false};
  try{
    const response=await fetch('http://127.0.0.1:'+main.consolePort+'/api/xi/assets/reload',{method:'POST',headers:{'content-type':'application/json','x-console-token':consoleToken},body:'{}',signal:AbortSignal.timeout(10000)});
    const body=await response.json();if(!response.ok||body.ok!==true)throw new Error('reload-rejected');
    return {prepared:true,image_ref:result.prepared[0].image_ref,reloaded:true,source:result.prepared[0].source,qq_sent:false,next_action:'Use existing qq_send_image with the trusted current key/token; preparation itself never sends.'};
  }catch{return {prepared:true,image_ref:result.prepared[0].image_ref,reloaded:false,reason:'main-not-active-or-reload-unconfirmed',qq_sent:false};}
}
