// Offline attachment store. Only the verified transport may import bytes or publish seeds.
// Models receive opaque IDs, never filesystem paths, remote URLs or another chat's data.
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {conversationScope,authorizeReply} from './conversation-scope.mjs';

function imageType(bytes){
 if(bytes.length<12||bytes.length>8*1024*1024)throw Error('Image size rejected');
 if(bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])))return 'image/png';
 if(bytes[0]===255&&bytes[1]===216&&bytes[2]===255)return 'image/jpeg';
 if(['GIF87a','GIF89a'].includes(bytes.subarray(0,6).toString('ascii')))return 'image/gif';
 if(bytes.subarray(0,4).toString()==='RIFF'&&bytes.subarray(8,12).toString()==='WEBP')return 'image/webp';
 throw Error('Unsupported image signature');
}
export class ScopedMedia{
 constructor(path){
  this.db=new DatabaseSync(path);
  this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS scoped_media(id TEXT PRIMARY KEY,owner TEXT NOT NULL,mime TEXT NOT NULL,sha TEXT NOT NULL,bytes BLOB NOT NULL,source TEXT NOT NULL,created INTEGER NOT NULL)');
  this.db.exec('CREATE TABLE IF NOT EXISTS image_analysis(id TEXT,owner TEXT,result TEXT,at INTEGER,PRIMARY KEY(id,owner))');
  this.db.exec('CREATE TABLE IF NOT EXISTS image_sends(owner TEXT,id TEXT,event TEXT,at INTEGER,PRIMARY KEY(owner,id,event))');
 }
 importReceived(scope,message,bytes){
  authorizeReply(scope,message);
  const event=String(message.message_id??'');if(!event||event.length>100)throw Error('Source event required');
  return this.insert(conversationScope(scope.kind,scope.id).key,bytes,event);
 }
 importApprovedSeed(bytes,label){
  if(typeof label!=='string'||!label||label.length>100)throw Error('Seed label required');
  return this.insert('public-seed',bytes,label);
 }
 insert(owner,input,source){
  const bytes=Buffer.from(input),mime=imageType(bytes),sha=createHash('sha256').update(bytes).digest('hex');
  const prior=this.db.prepare('SELECT id FROM scoped_media WHERE owner=? AND sha=?').get(owner,sha);
  if(prior)return {id:prior.id,mime};
  const id=randomUUID();
  this.db.prepare('INSERT INTO scoped_media VALUES(?,?,?,?,?,?,?)').run(id,owner,mime,sha,bytes,source,Date.now());
  return {id,mime};
 }
 list(scope){
  const owner=conversationScope(scope.kind,scope.id).key;
  return this.db.prepare("SELECT m.id,m.mime,length(m.bytes) AS size,CASE WHEN m.owner='public-seed' THEN 'public-sticker-seed' ELSE 'received-in-current-chat' END AS origin,CASE WHEN m.owner='public-seed' THEN m.source ELSE 'Received in this conversation; consult analysis_status/analyze_image before claiming understanding' END AS description,COALESCE(json_extract(a.result,'$.status'),'not-analyzed') AS analysis_status FROM scoped_media m LEFT JOIN image_analysis a ON a.id=m.id AND a.owner=? WHERE m.owner IN (?,?) ORDER BY m.created DESC,m.rowid DESC LIMIT 100").all(owner,owner,'public-seed');
 }
 summary(scope){const owner=conversationScope(scope.kind,scope.id).key;return {received_in_current_chat:this.db.prepare('SELECT count(*) n FROM scoped_media WHERE owner=?').get(owner).n,public_sticker_seeds:this.db.prepare("SELECT count(*) n FROM scoped_media WHERE owner='public-seed'").get().n,history_backfill_guaranteed:false};}
 imageBytes(scope,id){
  if(typeof id!=='string'||!/^[0-9a-f-]{36}$/.test(id))throw Error('Invalid attachment ID');
  const row=this.db.prepare('SELECT mime,sha,bytes FROM scoped_media WHERE id=? AND owner IN (?,?)').get(id,conversationScope(scope.kind,scope.id).key,'public-seed');
  if(!row)throw Error('Attachment unavailable in this conversation');
  const bytes=Buffer.from(row.bytes);if(createHash('sha256').update(bytes).digest('hex')!==row.sha)throw Error('Attachment integrity failed');
  return {mime:row.mime,bytes};
 }
 analysis(scope,id){this.imageBytes(scope,id);const row=this.db.prepare('SELECT result FROM image_analysis WHERE id=? AND owner=?').get(id,conversationScope(scope.kind,scope.id).key);return row?JSON.parse(row.result):null;}
 recentlySent(scope,id,now=Date.now()){const row=this.db.prepare('SELECT max(at) at FROM image_sends WHERE owner=? AND id=?').get(conversationScope(scope.kind,scope.id).key,id);return row?.at!=null&&now-row.at<180000;}
 markSent(scope,id,event){this.db.prepare('INSERT OR IGNORE INTO image_sends VALUES(?,?,?,?)').run(conversationScope(scope.kind,scope.id).key,id,event,Date.now());}
 saveAnalysis(scope,id,result){this.imageBytes(scope,id);const serialized=JSON.stringify(result);if(serialized.length>12000)throw Error('Analysis result limit');this.db.prepare('INSERT OR REPLACE INTO image_analysis VALUES(?,?,?,?)').run(id,conversationScope(scope.kind,scope.id).key,serialized,Date.now());return result;}
 prepareReply(scope,message,id){return {target:authorizeReply(scope,message),...this.imageBytes(scope,id)};}
 close(){this.db.close();}
}
