import { validateAssetsPaths, verifyAssetsSchema, loadOriginalClasses } from './paths.mjs';

const id=value=>{if(typeof value!=='string'||! /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(value))throw new Error('ASSETS_ID_INVALID');return value;};
const sourceScope=value=>{const match=/^(group|private)-(\d{5,15})$/.exec(value);if(!match)throw new Error('ASSETS_SOURCE_SCOPE_UNSUPPORTED');return {kind:match[1],id:match[2]};};
const provenance=project=>({scope:project.scope,title:project.title,origin:project.origin,created:project.created,updated:project.updated,deleted:Boolean(project.deleted)});
const page=(rows,offset=0,limit=20)=>({records:rows.slice(offset,offset+limit),next_offset:offset+limit<rows.length?offset+limit:null});
const preview=(base,id,version)=>base?base+'/workroom/'+id+'?version='+version:null;
const saved=(result,base)=>({project_id:result.project_id,version:result.version,digest:result.digest,storage_saved:true,storage_display_flag:Boolean(result.displayed),preview_available:Boolean(base),preview_url:preview(base,result.project_id,result.version),host_execution:false,qq_sent:false});

/** All paths are supplied by the leased parent. Tools never accept a DB/root. */
export async function openAssetsStore({paths:input,ownershipGate}={}){
  if(typeof ownershipGate!=='function'||await ownershipGate({operation:'open-existing-assets',paths:input})!==true)throw new Error('ASSETS_LEASE_REQUIRED');
  const paths=validateAssetsPaths(input);verifyAssetsSchema(paths);
  const {ScopedMedia,Workroom}=await loadOriginalClasses();
  const media=new ScopedMedia(paths.mediaDb);media.db.exec('PRAGMA query_only=ON');
  let workroom;try{workroom=new Workroom(paths.workroomDb);}catch(error){media.close();throw error;}
  let closed=false;
  const active=()=>{if(closed)throw new Error('ASSETS_STORE_CLOSED');};
  const projectRow=projectId=>{active();const row=workroom.db.prepare('SELECT * FROM wr_projects WHERE id=?').get(id(projectId));if(!row)throw new Error('ASSETS_RESOURCE_UNAVAILABLE');return row;};
  const authorizeWrite=async()=>{active();if(await ownershipGate({operation:'write-existing-workroom',paths})!==true)throw new Error('ASSETS_LEASE_REVOKED');active();};
  return {
    describe(){return {existingDatabases:true,globalXiMemory:true,mediaReadOnly:true,workroomSchema:'xi-assets-a2-v1',newProjectScope:paths.creationScope,previewAvailable:Boolean(paths.previewBaseURL),mediaDownloadConfigured:false,qqSendConfigured:false};},
    mediaList({query='',offset=0,limit=20}={}){
      active();const rows=media.db.prepare('SELECT id,owner,mime,sha,length(bytes) AS bytes,source,created FROM scoped_media WHERE id LIKE ? OR source LIKE ? OR owner LIKE ? ORDER BY created DESC,rowid DESC LIMIT ? OFFSET ?').all('%'+query+'%','%'+query+'%','%'+query+'%',limit+1,offset);
      return {records:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null,byte_payload_included:false};
    },
    mediaGet({id:mediaId}){
      active();const row=media.db.prepare('SELECT id,owner,mime,sha,length(bytes) AS bytes,source,created FROM scoped_media WHERE id=?').get(id(mediaId));if(!row)throw new Error('ASSETS_RESOURCE_UNAVAILABLE');
      if(row.bytes<12||row.bytes>8*1024*1024)throw new Error('ASSETS_MEDIA_BYTE_BOUND');
      const scope=row.owner==='public-seed'?paths.creationScope:sourceScope(row.owner);
      const verified=media.imageBytes(scope,mediaId);
      const analyses=media.db.prepare('SELECT owner,result,at FROM image_analysis WHERE id=? ORDER BY at DESC').all(mediaId).map(value=>{if(Buffer.byteLength(value.result)>48000)throw new Error('ASSETS_ANALYSIS_BYTE_BOUND');return {...value,result:JSON.parse(value.result)};});
      return {...row,integrity_verified:verified.bytes.length===row.bytes,analyses,byte_payload_included:false,download_performed:false,qq_sent:false};
    },
    mediaPayload(mediaId){const metadata=this.mediaGet({id:mediaId});const scope=metadata.owner==='public-seed'?paths.creationScope:sourceScope(metadata.owner);return {metadata,...media.imageBytes(scope,mediaId)};},
    workList({query='',include_deleted=false,offset=0,limit=20}={}){
      active();const rows=workroom.db.prepare('SELECT p.*,EXISTS(SELECT 1 FROM wr_hidden h WHERE h.project=p.id) AS hidden FROM wr_projects p WHERE (? OR deleted=0) AND (id LIKE ? OR title LIKE ? OR scope LIKE ?) ORDER BY updated DESC LIMIT ? OFFSET ?').all(include_deleted?1:0,'%'+query+'%','%'+query+'%','%'+query+'%',limit+1,offset);
      return {records:rows.slice(0,limit),next_offset:rows.length>limit?offset+limit:null};
    },
    workRead({project_id,path,version,offset,limit}){
      const row=projectRow(project_id);return {...workroom.read(sourceScope(row.scope),project_id,path,version,{offset,limit}),provenance:provenance(row),content_is_untrusted:true};
    },
    workHistory({project_id,offset=0,limit=20}){const row=projectRow(project_id);return {...page(workroom.history(sourceScope(row.scope),project_id),offset,limit),provenance:provenance(row)};},
    async workCreate({title,files=[]}){
      await authorizeWrite();const entries={};for(const file of files){if(Object.hasOwn(entries,file.path))throw new Error('ASSETS_DUPLICATE_LOGICAL_FILE');entries[file.path]=file.text;}
      const result=workroom.create(paths.creationScope,{title,files:entries,origin:'chat'});return {...saved(result,paths.previewBaseURL),provenance:provenance(projectRow(result.project_id)),review_required:false};
    },
    async workWrite({project_id,expected_version,files}){await authorizeWrite();const row=projectRow(project_id);return {...saved(workroom.write(sourceScope(row.scope),project_id,expected_version,files),paths.previewBaseURL),provenance:provenance(projectRow(project_id)),review_required:false};},
    async workRestore({project_id,version,expected_version}){await authorizeWrite();const row=projectRow(project_id);return {...saved(workroom.restore(sourceScope(row.scope),project_id,version,expected_version),paths.previewBaseURL),provenance:provenance(projectRow(project_id)),review_required:false};},
    async workDisplay({project_id,version}){
      await authorizeWrite();const row=projectRow(project_id);const result=workroom.publish(sourceScope(row.scope),project_id,version,'xi-autonomous-display');
      return {project_id,version:result.version,release_recorded:true,review_required:false,preview_available:Boolean(paths.previewBaseURL),preview_url:preview(paths.previewBaseURL,project_id,result.version),qq_sent:false,host_execution:false,provenance:provenance(row)};
    },
    close(){if(!closed){closed=true;workroom.close();media.close();}}
  };
}
