// Import existing transport-attributed records as read-only historical evidence.
// Never enqueue them as live prompts; unscoped persona/diary content stays in the original store.
import {DatabaseSync} from 'node:sqlite';
import {createHash} from 'node:crypto';
import {conversationScope} from './conversation-scope.mjs';
const digest=text=>createHash('sha256').update(text).digest('hex');
export class ScopedHistory{
 constructor(path){
  this.db=new DatabaseSync(path);
  this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS history(scope TEXT,event TEXT,text TEXT,at TEXT,source TEXT,hash TEXT,PRIMARY KEY(scope,event)); CREATE TABLE IF NOT EXISTS conflicts(scope TEXT,event TEXT,hash TEXT,PRIMARY KEY(scope,event,hash)); CREATE INDEX IF NOT EXISTS history_scope_time ON history(scope,at)');
 }
 importEvent(record,source){
  if(record?.source!=='qq'||record.origin!=='external'||!['qq.message','qq.self','qq.transcript'].includes(record.type))return 'unscoped-or-nonmessage';
  const conv=record.meta?.conv;let scope;
  try{scope=conversationScope(conv?.kind,conv?.id);}catch{return 'invalid-scope';}
  if(typeof record.text!=='string'||record.text.length>100000||!Number.isFinite(Date.parse(record.ts)))return 'invalid-record';
  const id=record.meta?.message_id;
  if(!Number.isSafeInteger(id))return 'missing-message-id';
  // Transcript enrichment may share an ID with the original audio; retain separately.
  const event=String(id)+(record.type==='qq.transcript'?':transcript':'');
  return this.insert(scope,event,record.text,record.ts,source);
 }
 insert(scope,event,text,at,source){
  const key=conversationScope(scope.kind,scope.id).key,hash=digest(text);
  const prior=this.db.prepare('SELECT hash FROM history WHERE scope=? AND event=?').get(key,event);
  if(prior){
   if(prior.hash===hash)return 'duplicate';
   this.db.prepare('INSERT OR IGNORE INTO conflicts VALUES(?,?,?)').run(key,event,hash);return 'conflict-withheld';
  }
  this.db.prepare('INSERT INTO history VALUES(?,?,?,?,?,?)').run(key,event,text,at,source,hash);return 'imported';
 }
 search(scope,keyword='',offset=0){
  const key=conversationScope(scope.kind,scope.id).key;
  if(typeof keyword!=='string'||keyword.length>100||!Number.isSafeInteger(offset)||offset<0)throw Error('Invalid search');
  const where='scope=? AND instr(text,?)>0 AND NOT EXISTS(SELECT 1 FROM conflicts c WHERE c.scope=history.scope AND c.event=history.event)';
  const count=this.db.prepare('SELECT COUNT(*) n FROM history WHERE '+where).get(key,keyword).n;
  const rows=this.db.prepare('SELECT event,text,at,source FROM history WHERE '+where+' ORDER BY at,event LIMIT 30 OFFSET ?').all(key,keyword,offset);
  return {scope:key,notice:'Historical records, not current requests; scoped local coverage only, not all-time completeness. Conflicting copies withheld.',total:count,next_offset:offset+30<count?offset+30:null,records:rows.map(r=>({...r,text:r.text.slice(0,2000)}))};
 }
 close(){this.db.close();}
}
