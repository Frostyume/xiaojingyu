import {DatabaseSync} from 'node:sqlite';
import {mkdirSync,lstatSync,existsSync} from 'node:fs';
import {resolve,parse,join,dirname} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {conversationScope} from './conversation-scope.mjs';
import {toolFault,rejectedToolResult} from './tool-feedback.mjs';

export const DEFAULT_LIMITS=Object.freeze({projectsPerScope:20,files:20,fileBytes:32768,projectBytes:131072,versions:100,jsFiles:4,checkTimeoutMs:1500});
const hash=text=>createHash('sha256').update(text).digest('hex');
const scopeKey=scope=>conversationScope(scope.kind,scope.id).key;
const uid=id=>{if(typeof id!=='string'||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(id))throw toolFault('ARGUMENT_VALUE_INVALID');return id;};
const short=(s,max,label)=>{if(typeof s!=='string'||!s.trim()||s.length>max)throw toolFault('ARGUMENT_VALUE_INVALID');return s.trim();};
export function safeWorkroomPath(file){
 if(typeof file!=='string'||file.length>96||file.split('/').length>4||!file.split('/').every(p=>/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(p)&&!/[.]$/.test(p)&&! /^(con|prn|aux|nul|com\d|lpt\d)(?:\.|$)/i.test(p))||! /\.(html|css|svg|js|mjs|cjs|json|md|txt)$/.test(file))throw toolFault('ARGUMENT_VALUE_INVALID');
 return file;
}
function safeDatabase(path){
 const absolute=resolve(path),root=parse(absolute).root;let current=root;
 for(const part of absolute.slice(root.length).split(/[\\/]/).filter(Boolean)){
  current=join(current,part);if(!existsSync(current))continue;
  const stat=lstatSync(current);if(stat.isSymbolicLink()||stat.isFile()&&stat.nlink>1)throw Error('Workroom links/junctions/hardlinks refused');
 }
 return absolute;
}
export class Workroom{
 constructor(path,{limits={}}={}){
  this.limits={...DEFAULT_LIMITS,...limits};
  for(const [key,value] of Object.entries(this.limits))if(!(key in DEFAULT_LIMITS)||!Number.isSafeInteger(value)||value<1||value>DEFAULT_LIMITS[key]*4)throw Error('Invalid workroom limit');
  this.path=safeDatabase(path);mkdirSync(dirname(this.path),{recursive:true});safeDatabase(this.path);
  this.db=new DatabaseSync(this.path);this.db.exec(`PRAGMA busy_timeout=3000;
   CREATE TABLE IF NOT EXISTS wr_projects(id TEXT PRIMARY KEY,scope TEXT,title TEXT,origin TEXT,head INTEGER,deleted INTEGER DEFAULT 0,created TEXT,updated TEXT);
   CREATE TABLE IF NOT EXISTS wr_versions(project TEXT,version INTEGER,files TEXT,digest TEXT,reason TEXT,at TEXT,PRIMARY KEY(project,version));
   CREATE TABLE IF NOT EXISTS wr_releases(project TEXT PRIMARY KEY,version INTEGER,title TEXT,origin TEXT,publisher TEXT,at TEXT);
   CREATE TABLE IF NOT EXISTS wr_tasks(id TEXT PRIMARY KEY,scope TEXT,title TEXT,brief TEXT,state TEXT,project TEXT,result TEXT,updated TEXT);
   CREATE TABLE IF NOT EXISTS wr_submissions(id TEXT PRIMARY KEY,project TEXT,version INTEGER,task TEXT,summary TEXT,checks TEXT,state TEXT,at TEXT);
   CREATE TABLE IF NOT EXISTS wr_hidden(project TEXT PRIMARY KEY,at TEXT);
   CREATE TABLE IF NOT EXISTS wr_checks(project TEXT,version INTEGER,result TEXT,at TEXT,PRIMARY KEY(project,version));`);
 }
 transaction(fn){this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
 filesValid(files){
  if(!files||Array.isArray(files)||typeof files!=='object'||Object.keys(files).length>this.limits.files)throw toolFault('ARGUMENT_VALUE_INVALID');
  let size=0,js=0;
  for(const [file,text] of Object.entries(files)){
   safeWorkroomPath(file);if(typeof text!=='string'||text.includes('\0')||Buffer.byteLength(text)>this.limits.fileBytes)throw toolFault('ARGUMENT_VALUE_INVALID');
   size+=Buffer.byteLength(text);if(/\.(js|mjs|cjs)$/.test(file))js++;
  }
  if(size>this.limits.projectBytes||js>this.limits.jsFiles)throw toolFault('ARGUMENT_VALUE_INVALID');
  return Object.fromEntries(Object.entries(files).sort(([a],[b])=>a.localeCompare(b)));
 }
 project(scope,id,{deleted=false}={}){
  const row=this.db.prepare('SELECT * FROM wr_projects WHERE id=? AND scope=?').get(uid(id),scopeKey(scope));
  if(!row||row.deleted&&!deleted)throw toolFault('RESOURCE_UNAVAILABLE');return row;
 }
 version(project,version){
  if(!Number.isSafeInteger(version)||version<1)throw toolFault('ARGUMENT_VALUE_INVALID');
  const row=this.db.prepare('SELECT * FROM wr_versions WHERE project=? AND version=?').get(project,version);
  if(!row||hash(row.files)!==row.digest)throw toolFault('PRECONDITION_MISSING');return row;
 }
 append(project,files,reason){
  if(project.head>=this.limits.versions)throw toolFault('LIMIT_REACHED');
  const version=project.head+1,at=new Date().toISOString(),serialized=JSON.stringify(this.filesValid(files));
  this.db.prepare('INSERT INTO wr_versions VALUES(?,?,?,?,?,?)').run(project.id,version,serialized,hash(serialized),short(reason,200,'version reason'),at);
  this.db.prepare('UPDATE wr_projects SET head=?,deleted=0,updated=? WHERE id=?').run(version,at,project.id);
  return {project_id:project.id,version,digest:hash(serialized),displayed:!this.db.prepare('SELECT 1 FROM wr_hidden WHERE project=?').get(project.id),preview_url:'http://127.0.0.1:17790/workroom/'+project.id+'?version='+version};
 }
 expect(project,version){if(project.head!==version)throw toolFault('VERSION_CONFLICT',{current_version:project.head});}
 create(scope,{title,files={},task_id,origin='chat'}){
  if(!['chat','sister-local','development-acceptance'].includes(origin))throw toolFault('ARGUMENT_VALUE_INVALID');
  title=short(title,100,'title');files=this.filesValid(files);
  return this.transaction(()=>{
   if(this.db.prepare('SELECT count(*) n FROM wr_projects WHERE scope=?').get(scopeKey(scope)).n>=this.limits.projectsPerScope)throw toolFault('LIMIT_REACHED');
   let task;if(task_id){task=this.task(scope,task_id);if(!['pending','in_progress','failed'].includes(task.state)||task.project)throw toolFault('TASK_STATE_CONFLICT');if(origin==='chat')origin='sister-local';}
   const id=randomUUID(),at=new Date().toISOString();this.db.prepare('INSERT INTO wr_projects VALUES(?,?,?,?,0,0,?,?)').run(id,scopeKey(scope),title,origin,at,at);
   const result=this.append({id,head:0},files,'create');
   if(task)this.db.prepare("UPDATE wr_tasks SET project=?,state='in_progress',updated=? WHERE id=?").run(id,at,task.id);
   return {...result,title,origin,visibility:'displayed',...(task?{task_id:task.id}:{})};
  });
 }
 list(scope,include_deleted=false){return this.db.prepare('SELECT id,title,origin,head AS version,deleted,updated FROM wr_projects WHERE scope=? AND (? OR deleted=0) ORDER BY updated DESC LIMIT 80').all(scopeKey(scope),include_deleted?1:0);}
 read(scope,id,file,version,{offset=0,limit=8000}={}){const project=this.project(scope,id,{deleted:true}),row=this.version(id,version??project.head),files=JSON.parse(row.files);if(file!==undefined){safeWorkroomPath(file);if(!Object.hasOwn(files,file))throw toolFault('RESOURCE_UNAVAILABLE');if(!Number.isSafeInteger(offset)||offset<0||!Number.isSafeInteger(limit)||limit<1||limit>10000)throw toolFault('ARGUMENT_VALUE_INVALID');const text=files[file];return {project_id:id,version:row.version,path:file,text:text.slice(offset,offset+limit),offset,total_characters:text.length,next_offset:offset+limit<text.length?offset+limit:null,digest:row.digest};}return {project_id:id,title:project.title,version:row.version,deleted:!!project.deleted,files:Object.entries(files).map(([path,text])=>({path,bytes:Buffer.byteLength(text)})),digest:row.digest};}
 write(scope,id,expected_version,changes){
  if(!Array.isArray(changes)||changes.length<1||changes.length>6)throw toolFault('ARGUMENT_VALUE_INVALID');
  return this.transaction(()=>{
   const project=this.project(scope,id);this.expect(project,expected_version);const files=JSON.parse(this.version(id,project.head).files);
   for(const change of changes){if(!change||Object.keys(change).some(k=>!['path','text','remove'].includes(k)))throw toolFault('ARGUMENT_VALUE_INVALID');safeWorkroomPath(change.path);if(change.remove===true){if(change.text!==undefined)throw toolFault('ARGUMENT_VALUE_INVALID');delete files[change.path];}else{if(change.remove!==undefined&&change.remove!==false)throw toolFault('ARGUMENT_VALUE_INVALID');files[change.path]=change.text;}}
   return this.append(project,files,'edit');
  });
 }
 history(scope,id){this.project(scope,id,{deleted:true});return this.db.prepare('SELECT version,digest,reason,at FROM wr_versions WHERE project=? ORDER BY version DESC').all(id);}
 restore(scope,id,version,expected_version){return this.transaction(()=>{const project=this.project(scope,id,{deleted:true});this.expect(project,expected_version);return this.append(project,JSON.parse(this.version(id,version).files),'restore version '+version);});}
 trash(scope,id,expected_version){return this.transaction(()=>{const project=this.project(scope,id);this.expect(project,expected_version);this.db.prepare('UPDATE wr_projects SET deleted=1,updated=? WHERE id=?').run(new Date().toISOString(),id);this.db.prepare('DELETE FROM wr_releases WHERE project=?').run(id);return {project_id:id,deleted:true,recoverable:true,version:project.head};});}
 check(scope,id,version){
  const project=this.project(scope,id),row=this.version(id,version??project.head),files=JSON.parse(row.files),errors=[],warnings=[];
  if(!Object.hasOwn(files,'index.html')&&!Object.hasOwn(files,'index.svg'))errors.push({code:'entry_missing',message:'Add index.html or index.svg for a preview.'});
  for(const [file,text] of Object.entries(files)){
   if(/\.(js|mjs|cjs)$/.test(file)){
    const parsed=spawnSync(process.execPath,['--check',file.endsWith('.cjs')?'--input-type=commonjs':'--input-type=module'],{input:text,encoding:'utf8',timeout:this.limits.checkTimeoutMs,maxBuffer:8192,windowsHide:true,shell:false,env:{SystemRoot:process.env.SystemRoot??''}});
    if(parsed.error||parsed.status!==0)errors.push({code:'js_syntax',path:file,message:parsed.error?'Syntax checker timed out or unavailable':String(parsed.stderr).slice(0,1400)});
    warnings.push({code:'js_not_executed',path:file,message:'This check parses JS only. Browser interaction or offline execution needs its own actual result.'});
   }
   if(file.endsWith('.json'))try{JSON.parse(text);}catch{errors.push({code:'json_syntax',path:file,message:'Invalid JSON'});}
   if(/\.(html|svg|css)$/.test(file)&&/<script|\bon\w+\s*=|https?:|\b(?:href|src)\s*=|@import|url\s*\(/i.test(text))warnings.push({code:'static_preview_filter',path:file,message:'Interactive preview uses an opaque browser frame with local project scripts. External resources, event attributes and forms are removed; static fallback disables scripts.'});
  }
  const result={project_id:id,version:row.version,digest:row.digest,ok:errors.length===0,errors,warnings,mode:'syntax/static checks only; interactive browser preview is a separate action, never proof of host execution',limits:this.limits};
  try{const previous=JSON.parse(this.db.prepare('SELECT result FROM wr_checks WHERE project=? AND version=?').get(id,row.version)?.result??'{}');if(previous.digest===row.digest&&previous.browser_preview)result.browser_preview=previous.browser_preview;}catch{}
  this.db.prepare('INSERT OR REPLACE INTO wr_checks VALUES(?,?,?,?)').run(id,row.version,JSON.stringify(result),new Date().toISOString());return result;
 }
 task(scope,id){const row=this.db.prepare('SELECT * FROM wr_tasks WHERE id=? AND scope=?').get(uid(id),scopeKey(scope));if(!row)throw toolFault('RESOURCE_UNAVAILABLE');return row;}
 tasks(scope){return this.db.prepare('SELECT id,title,brief,state,project,result,updated FROM wr_tasks WHERE scope=? ORDER BY updated DESC LIMIT 30').all(scopeKey(scope));}
 taskState(scope,id,state,result=''){
  if(!['in_progress','failed','completed'].includes(state))throw toolFault('ARGUMENT_VALUE_INVALID');
  const task=this.task(scope,id);
  if(typeof result!=='string'||result.length>2000)throw toolFault('ARGUMENT_VALUE_INVALID');
  this.db.prepare('UPDATE wr_tasks SET state=?,result=?,updated=? WHERE id=?').run(state,result,new Date().toISOString(),id);return {task_id:id,state};
 }
 submit(scope,id,expected_version,summary,task_id){
  summary=short(summary,2000,'summary');const checks=this.check(scope,id,expected_version);
  return this.transaction(()=>{
   const project=this.project(scope,id);this.expect(project,expected_version);let task;
   if(task_id){task=this.task(scope,task_id);if(task.project!==id)throw toolFault('TASK_STATE_CONFLICT');}
   const at=new Date().toISOString(),receipt=randomUUID();
   this.db.prepare("INSERT INTO wr_submissions VALUES(?,?,?,?,?,?,'recorded',?)").run(receipt,id,expected_version,task_id??null,summary,JSON.stringify(checks),at);
   if(task)this.db.prepare('UPDATE wr_tasks SET state=?,result=?,updated=? WHERE id=?').run(checks.ok?'completed':'in_progress',summary,at,task.id);
   return {submitted:true,receipt_id:receipt,project_id:id,version:expected_version,state:'recorded',displayed:!this.db.prepare('SELECT 1 FROM wr_hidden WHERE project=?').get(id),review_required:false,host_execution_implied:false,production_merged:false,checks};
  });
 }
 receipts(scope,id){this.project(scope,id,{deleted:true});return this.db.prepare('SELECT id,version,task,summary,state,at FROM wr_submissions WHERE project=? ORDER BY at DESC LIMIT 30').all(id);}
 publish(scope,id,version,publisher){return this.transaction(()=>{
  const project=this.project(scope,id);this.version(id,version);
  const at=new Date().toISOString();this.db.prepare('INSERT OR REPLACE INTO wr_releases VALUES(?,?,?,?,?,?)').run(id,version,project.title,project.origin,publisher,at);
  this.db.prepare('DELETE FROM wr_hidden WHERE project=?').run(id);
  return {published:true,displayed:true,review_required:false,project_id:id,version,url:'http://127.0.0.1:17790/workroom/'+id+'?version='+version,home_shows_latest:true,host_execution_implied:false};
 });}
 unpublish(scope,id){this.project(scope,id,{deleted:true});return this.transaction(()=>{this.db.prepare('DELETE FROM wr_releases WHERE project=?').run(id);this.db.prepare('INSERT OR REPLACE INTO wr_hidden VALUES(?,?)').run(id,new Date().toISOString());return {published:false,displayed:false,project_id:id,recovery_versions_preserved:true};});}
 // Trusted local CLI only. These operations are deliberately absent from chat tools.
 dispatch(scope,{title,brief}){const id=randomUUID();this.db.prepare("INSERT INTO wr_tasks VALUES(?,?,?,?,'pending',NULL,'',?)").run(id,scopeKey(scope),short(title,100,'task title'),short(brief,4000,'task brief'),new Date().toISOString());return {task_id:id,state:'pending',source:'sister-local'};}
 review(scope,id,accept,feedback){const task=this.task(scope,id);if(task.state!=='awaiting_review')throw toolFault('TASK_STATE_CONFLICT');feedback=short(feedback,2000,'review feedback');return this.transaction(()=>{const state=accept?'completed':'failed';this.db.prepare('UPDATE wr_tasks SET state=?,result=?,updated=? WHERE id=?').run(state,feedback,new Date().toISOString(),id);this.db.prepare("UPDATE wr_submissions SET state=? WHERE task=? AND state='awaiting_review'").run(accept?'reviewed':'changes_requested',id);return {task_id:id,state,production_merged:false};});}
 close(){this.db.close();}
}

const props={project_id:{type:'string'},expected_version:{type:'integer',minimum:1},version:{type:'integer',minimum:1},task_id:{type:'string'}};
const files={type:'array',maxItems:6,items:{type:'object',properties:{path:{type:'string'},text:{type:'string',maxLength:32768},remove:{type:'boolean'}},required:['path'],additionalProperties:false}};
export function workroomTools(store,scope,{message,authorize=async()=>true}={},policy={}){
 const page=(rows,offset=0,size=20)=>{if(!Number.isSafeInteger(offset)||offset<0)throw toolFault('ARGUMENT_VALUE_INVALID');return {records:rows.slice(offset,offset+size),next_offset:offset+size<rows.length?offset+size:null};};
 const define=(name,description,properties,required,handler)=>({name:'workroom_'+name,description,parameters:{type:'object',properties,required,additionalProperties:false},handler:async args=>{
  try{if(!await authorize())throw toolFault('ACTION_PAUSED_OR_CONTEXT_ENDED');return JSON.stringify({ok:true,result:await handler(args)});}catch(error){return JSON.stringify(rejectedToolResult(error));}
 }});
 const checked=result=>({...result,checks:store.check(scope,result.project_id,result.version)});
 return [
  define('list','List projects belonging only to this chat, including recoverable deleted projects when requested.',{include_deleted:{type:'boolean'},offset:{type:'integer',minimum:0}},[],a=>page(store.list(scope,a.include_deleted),a.offset)),
  define('create','Create an HTML/CSS/SVG/JS mini project, immediately available on the home even unfinished. Display is not host execution. Optional task_id binds a genuine local sister task. Initial files are checked immediately.',{title:{type:'string',maxLength:100},files,task_id:props.task_id},['title'],a=>{if(a.files!==undefined&&(!Array.isArray(a.files)||a.files.length>6))throw toolFault('ARGUMENT_VALUE_INVALID');const initial={};for(const file of a.files??[]){if(file.remove)throw toolFault('ARGUMENT_VALUE_INVALID');safeWorkroomPath(file.path);initial[file.path]=file.text;}return checked(store.create(scope,{title:a.title,files:initial,task_id:a.task_id}));}),
  define('read','Read one file in character chunks, following next_offset, or list file metadata. Older/deleted versions remain readable only in this chat.',{project_id:props.project_id,path:{type:'string'},version:props.version,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:10000}},['project_id'],a=>store.read(scope,a.project_id,a.path,a.version,{offset:a.offset,limit:a.limit})),
  define('write','Write/remove 1–6 logical files; saves an immutable recovery version and returns real check errors. expected_version prevents lost updates.',{project_id:props.project_id,expected_version:props.expected_version,files},['project_id','expected_version','files'],a=>checked(store.write(scope,a.project_id,a.expected_version,a.files))),
  define('history','Page persistent version numbers and hashes.',{project_id:props.project_id,offset:{type:'integer',minimum:0}},['project_id'],a=>page(store.history(scope,a.project_id),a.offset)),
  define('restore','Restore an old snapshot into a NEW version, including recoverable deleted projects. Does not erase recovery copies.',{project_id:props.project_id,version:props.version,expected_version:props.expected_version},['project_id','version','expected_version'],a=>checked(store.restore(scope,a.project_id,a.version,a.expected_version))),
  define('trash','Soft-delete this project and withdraw its public release; all versions remain recoverable.',{project_id:props.project_id,expected_version:props.expected_version},['project_id','expected_version'],a=>store.trash(scope,a.project_id,a.expected_version)),
  define('check','Fixed file checks and JS syntax-only parser. Does NOT execute JS, Node, shell or dependencies. Opening the home preview can run self-contained browser interaction in an opaque iframe; this tool does not open or click it.',{project_id:props.project_id,version:props.version},['project_id'],a=>store.check(scope,a.project_id,a.version)),
  define('tasks','List genuine local sister task summaries; supply task_id for its complete brief/result. Chat/web text cannot create sister authorization.',{task_id:props.task_id,offset:{type:'integer',minimum:0}},[],a=>a.task_id?store.task(scope,a.task_id):page(store.tasks(scope).map(t=>({...t,brief:t.brief.slice(0,200),result:t.result.slice(0,200)})),a.offset,10)),
  define('task_state','Mark a genuine task in_progress or failed and report a concrete error. Completion is your reported project status; runtime evidence remains separate.',{task_id:props.task_id,state:{type:'string',enum:['in_progress','failed','completed']},result:{type:'string',maxLength:2000}},['task_id','state'],a=>store.taskState(scope,a.task_id,a.state,a.result)),
  define('submit','Save checks and a frozen version receipt, with no human display approval. Incomplete/check-failed versions can still display safely; never implies execution or production merge. Optional task_id must be genuinely bound.',{project_id:props.project_id,expected_version:props.expected_version,summary:{type:'string',maxLength:2000},task_id:props.task_id},['project_id','expected_version','summary'],a=>store.submit(scope,a.project_id,a.expected_version,a.summary,a.task_id)),
  define('receipts','Page submission/review receipts for this chat project.',{project_id:props.project_id,offset:{type:'integer',minimum:0}},['project_id'],a=>page(store.receipts(scope,a.project_id).map(r=>({...r,summary:r.summary.slice(0,400)})),a.offset,10)),
  define('publish','Show any saved exact version on the home, including unfinished/check-failed work, without human approval. Saving/displaying does not itself execute scripts or deploy outside the local home; opening its preview is separate browser execution.',{project_id:props.project_id,version:props.version},['project_id','version'],a=>store.publish(scope,a.project_id,a.version,'xi-autonomous-display')),
  define('unpublish','Hide this project from the home while retaining every saved version; no special approval command is required.',{project_id:props.project_id},['project_id'],a=>store.unpublish(scope,a.project_id))
 ];
}
