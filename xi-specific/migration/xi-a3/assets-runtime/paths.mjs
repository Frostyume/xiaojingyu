import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';

const SOURCE_ROOT=fileURLToPath(new URL('../../../companion/',import.meta.url));
export const SOURCE_PINS=Object.freeze({
  'scoped-media.mjs':'1430806e274658b1bd039d467393d77ba15fb6410fca35aabb653b2c52aae9be',
  'workroom.mjs':'1040acca9c1d245400498d26755e85db67d04de89fdaf2bbbbe99e192d3ce894'
});
const schema=JSON.parse(fs.readFileSync(new URL('../../xi-a2/assets/schema.json',import.meta.url),'utf8'));
function existing(raw,directory=false){
  if(!path.isAbsolute(String(raw??'')))throw new Error('ASSETS_EXPLICIT_ABSOLUTE_PATH_REQUIRED');
  const absolute=path.resolve(raw),base=path.parse(absolute).root;let cursor=base;
  for(const part of absolute.slice(base.length).split(path.sep).filter(Boolean)){
    cursor=path.join(cursor,part);const stat=fs.lstatSync(cursor);
    if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw new Error('ASSETS_LINK_REJECTED');
  }
  const stat=fs.lstatSync(absolute);if(directory?!stat.isDirectory():!stat.isFile())throw new Error('ASSETS_EXISTING_PATH_REQUIRED');
  return absolute;
}
export function validateAssetsPaths(input={}){
  const approvedRoot=existing(input.approvedRoot,true),mediaDb=existing(input.mediaDb),workroomDb=existing(input.workroomDb);
  for(const file of [mediaDb,workroomDb]){const relative=path.relative(approvedRoot,file);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('ASSETS_PATH_OUTSIDE_APPROVED_ROOT');for(const suffix of ['-wal','-shm','-journal'])if(fs.existsSync(file+suffix))existing(file+suffix);}
  if(mediaDb.toLowerCase()===workroomDb.toLowerCase())throw new Error('ASSETS_DISTINCT_DATABASES_REQUIRED');
  const scope=input.creationScope;if(!['group','private'].includes(scope?.kind)||!/^\d{5,15}$/.test(String(scope?.id??'')))throw new Error('ASSETS_TRUSTED_CREATION_SCOPE_REQUIRED');
  let workshop;
  if(input.workshop){workshop={db:existing(input.workshop.db),runsRoot:existing(input.workshop.runsRoot,true),runner:existing(input.workshop.runner),node:existing(input.workshop.node),verification:existing(input.workshop.verification)};for(const item of [workshop.db,workshop.runsRoot]){const relative=path.relative(approvedRoot,item);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))throw new Error('ASSETS_WORKSHOP_PATH_OUTSIDE_APPROVED_ROOT');}for(const suffix of ['-wal','-shm','-journal'])if(fs.existsSync(workshop.db+suffix))existing(workshop.db+suffix);}
  let previewBaseURL=null;if(input.previewBaseURL){const url=new URL(input.previewBaseURL);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||!url.port||[17789,17790,17791].includes(Number(url.port))||url.username||url.password||url.pathname!=='/'||url.search||url.hash)throw new Error('ASSETS_PREVIEW_URL_REJECTED');previewBaseURL=url.origin;}
  return {approvedRoot,mediaDb,workroomDb,creationScope:{kind:scope.kind,id:String(scope.id)},...(previewBaseURL?{previewBaseURL}:{}),...(workshop?{workshop}:{})};
}
export function verifyAssetsSchema(paths){
  for(const [kind,file] of [['media',paths.mediaDb],['workroom',paths.workroomDb]]){
    const db=new DatabaseSync(file,{readOnly:true});
    try{for(const [table,columns] of Object.entries(schema.columns[kind])){const observed=db.prepare(`PRAGMA table_info(${table})`).all().map(x=>x.name);if(JSON.stringify(observed)!==JSON.stringify(columns))throw new Error('ASSETS_SCHEMA_MISMATCH');}}
    finally{db.close();}
  }
}
export async function loadOriginalClasses(){
  for(const [name,expected] of Object.entries(SOURCE_PINS))if(createHash('sha256').update(fs.readFileSync(path.join(SOURCE_ROOT,name))).digest('hex')!==expected)throw new Error('ASSETS_ORIGINAL_SOURCE_CHANGED');
  const [{ScopedMedia},{Workroom,safeWorkroomPath}]=await Promise.all([import('../../../companion/scoped-media.mjs'),import('../../../companion/workroom.mjs')]);
  return {ScopedMedia,Workroom,safeWorkroomPath};
}
