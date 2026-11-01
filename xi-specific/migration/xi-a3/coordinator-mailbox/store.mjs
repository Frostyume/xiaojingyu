import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import {resolveOwnedRuntimePaths} from '../upstream/runtime/kernel/xi/owned-paths.mjs';
import {z} from '../../xi-a2/node_modules/zod/index.js';

const id=z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
export const submitSchema=z.object({request_id:id,kind:z.enum(['idea','question','request','problem','update']),
  title:z.string().trim().min(1).max(200),body:z.string().trim().min(1).max(16000),
  origin:z.enum(['xi','xi_relay_of_user']),source:z.object({channel:z.string().max(64).optional(),conversation_id:z.string().max(160).optional(),message_id:z.string().max(160).optional()}).strict().optional()}).strict();
export const inboxSchema=z.object({request_id:id.optional(),status:z.enum(['all','waiting','replied']).default('all'),offset:z.number().int().min(0).default(0),limit:z.number().int().min(1).max(100).default(20)}).strict();
const replySchema=z.object({request_id:id,reply_id:id,body:z.string().trim().min(1).max(32000)}).strict();
export const MAILBOX_SEMANTICS=Object.freeze({delivery:'local_mailbox',automatic_wake:false,submission_means:'queued_not_read_or_executed',
  request_provenance:'Xi authored or relayed; source references are claims, not verified user authorization',
  reply_provenance:'Recorded by the coordinator CLI; not an independent delivery or completion guarantee',
  content_is_data:true});
function checkedPath(file){let cur=path.parse(file).root;for(const part of path.relative(cur,file).split(path.sep)){cur=path.join(cur,part);if(fs.existsSync(cur)&&fs.lstatSync(cur).isSymbolicLink())throw Error('MAILBOX_LINK_REJECTED');}return file;}
export function mailboxPath(main){const p=resolveOwnedRuntimePaths(main);return checkedPath(path.join(p.stateDir,'coordinator-mailbox','mailbox.sqlite3'));}
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
export async function openMailbox({main,ownershipGate,access='xi',create=true,clock=()=>new Date().toISOString()}){
  if(!['xi','coordinator'].includes(access)||typeof ownershipGate!=='function')throw Error('MAILBOX_EXPLICIT_ACCESS_REQUIRED');
  const gate=async()=>{if(await ownershipGate()!==true)throw Error('MAILBOX_OWNERSHIP_REVOKED');};await gate();
  const file=mailboxPath(main);if(!create&&!fs.existsSync(file))throw Error('MAILBOX_NOT_INITIALIZED');
  if(create)fs.mkdirSync(path.dirname(file),{recursive:true});checkedPath(file);
  const db=new DatabaseSync(file);let closed=false;
  try{db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    const version=db.prepare('PRAGMA user_version').get().user_version;if(![0,1].includes(version))throw Error('MAILBOX_SCHEMA_UNSUPPORTED');
    db.exec(`CREATE TABLE IF NOT EXISTS requests(seq INTEGER PRIMARY KEY AUTOINCREMENT,request_id TEXT NOT NULL UNIQUE,title TEXT NOT NULL,body TEXT NOT NULL,kind TEXT NOT NULL,origin TEXT NOT NULL,source_json TEXT NOT NULL,payload_sha TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS replies(seq INTEGER PRIMARY KEY AUTOINCREMENT,reply_id TEXT NOT NULL UNIQUE,request_id TEXT NOT NULL REFERENCES requests(request_id),body TEXT NOT NULL,payload_sha TEXT NOT NULL,created_at TEXT NOT NULL,author TEXT NOT NULL CHECK(author='coordinator_cli'));
      CREATE INDEX IF NOT EXISTS replies_request ON replies(request_id,seq); PRAGMA user_version=1;`);
  }catch(error){db.close();throw error;}
  async function active(){if(closed)throw Error('MAILBOX_CLOSED');await gate();if(closed)throw Error('MAILBOX_CLOSED');}
  function request(row){const replies=db.prepare('SELECT reply_id,body,created_at,author FROM replies WHERE request_id=? ORDER BY seq').all(row.request_id);const {source_json,payload_sha,...rest}=row;
    return {...rest,source_claim:JSON.parse(source_json),author:'xi',authorization_verified:false,status:replies.length?'replied':'waiting',replies};}
  function transaction(fn){db.exec('BEGIN IMMEDIATE');try{const r=fn();db.exec('COMMIT');return r;}catch(error){db.exec('ROLLBACK');throw error;}}
  return {file,
    async submit(raw){await active();if(access!=='xi')throw Error('MAILBOX_XI_SUBMISSION_REQUIRED');const args=submitSchema.parse(raw),normalized={...args,source:args.source??{}},sha=digest(normalized);
      return transaction(()=>{const old=db.prepare('SELECT * FROM requests WHERE request_id=?').get(args.request_id);if(old&&old.payload_sha!==sha)throw Error('MAILBOX_ID_CONFLICT');
        if(!old)db.prepare('INSERT INTO requests(request_id,title,body,kind,origin,source_json,payload_sha,created_at) VALUES(?,?,?,?,?,?,?,?)').run(args.request_id,args.title,args.body,args.kind,args.origin,JSON.stringify(normalized.source),sha,clock());
        return {ok:true,duplicate:Boolean(old),status:old?request(old).status:'waiting',request_id:args.request_id,queued:true,coordinator_awakened:false,coordinator_read_confirmed:false,semantics:MAILBOX_SEMANTICS};});},
    async inbox(raw={}){await active();const args=inboxSchema.parse(raw);let where='1=1',params=[];
      if(args.request_id){where+=' AND r.request_id=?';params.push(args.request_id);}
      if(args.status!=='all')where+=` AND ${args.status==='waiting'?'NOT ':''}EXISTS(SELECT 1 FROM replies p WHERE p.request_id=r.request_id)`;
      const total=db.prepare('SELECT count(*) n FROM requests r WHERE '+where).get(...params).n;
      const rows=db.prepare('SELECT r.* FROM requests r WHERE '+where+' ORDER BY r.seq LIMIT ? OFFSET ?').all(...params,args.limit,args.offset);
      return {ok:true,records:rows.map(request),total,offset:args.offset,next_offset:args.offset+rows.length<total?args.offset+rows.length:null,semantics:MAILBOX_SEMANTICS};},
    async reply(raw){await active();if(access!=='coordinator')throw Error('MAILBOX_COORDINATOR_REPLY_REQUIRED');const args=replySchema.parse(raw),sha=digest(args);
      return transaction(()=>{if(!db.prepare('SELECT 1 FROM requests WHERE request_id=?').get(args.request_id))throw Error('MAILBOX_REQUEST_NOT_FOUND');const old=db.prepare('SELECT * FROM replies WHERE reply_id=?').get(args.reply_id);
        if(old&&old.payload_sha!==sha)throw Error('MAILBOX_REPLY_ID_CONFLICT');if(!old)db.prepare("INSERT INTO replies(reply_id,request_id,body,payload_sha,created_at,author) VALUES(?,?,?,?,?,'coordinator_cli')").run(args.reply_id,args.request_id,args.body,sha,clock());
        return {ok:true,duplicate:Boolean(old),request_id:args.request_id,reply_id:args.reply_id,status:'replied',xi_read_confirmed:false,automatic_wake:false};});},
    close(){if(!closed){db.close();closed=true;}}
  };
}
