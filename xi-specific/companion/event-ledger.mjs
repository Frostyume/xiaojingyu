import {DatabaseSync} from 'node:sqlite';
import {mkdirSync} from 'node:fs';
import {dirname} from 'node:path';
export class EventLedger {
  constructor(path){
    if(path!==':memory:')mkdirSync(dirname(path),{recursive:true});
    this.db=new DatabaseSync(path);
    this.db.exec('PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS seen(id TEXT PRIMARY KEY,at INTEGER NOT NULL)');
  }
  claim(message,now){
    const stamp=Number(message.time)*1000;
    if(!Number.isFinite(stamp)||stamp>now+30_000||now-stamp>120_000||message.message_id==null)return false;
    const id=JSON.stringify([String(message.group_id),String(message.user_id),String(message.message_id),stamp]);
    return this.db.prepare('INSERT OR IGNORE INTO seen VALUES(?,?)').run(id,now).changes===1;
  }
  close(){this.db.close();}
}
