import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ExperienceMemory } from '../../../companion/experience-memory.mjs';
import { LifeJournal } from '../../../companion/life-journal.mjs';
import { DayContinuity } from '../../../companion/life-day-context.mjs';
import { LifeProgress } from '../../../companion/life-progress.mjs';
import { openXiReader } from '../../xi-a1/xi-reader.mjs';

export const LIFE_TOOL_NAMES = Object.freeze(['xi_life_context', 'xi_life_journal', 'xi_life_intentions']);
const fault = code => Object.assign(new Error(code), {code});
const parse = value => { try { return JSON.parse(value); } catch { return null; } };
const short = (value, max = 400) => typeof value === 'string' ? value.slice(0, max) : value;
const bounded = (n, fallback, max) => { n ??= fallback; if (!Number.isSafeInteger(n) || n < 1 || n > max) throw fault('LIFE_INVALID_LIMIT'); return n; };
const sliceValue = (value, max = 700) => {
  const text = JSON.stringify(value) ?? 'null';
  return text.length <= max ? {value, value_complete:true} : {value_preview_json:text.slice(0,max), value_complete:false};
};
function existing(raw, directory = false) {
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) throw fault('LIFE_EXPLICIT_PATH_REQUIRED');
  const resolved = path.resolve(raw);
  for (let current = resolved;; current = path.dirname(current)) {
    const st = fs.lstatSync(current);
    if (st.isSymbolicLink() || st.isFile() && st.nlink !== 1) throw fault('LIFE_LINK_REFUSED');
    if (current === path.dirname(current)) break;
  }
  const st = fs.statSync(resolved);
  if (directory ? !st.isDirectory() : !st.isFile()) throw fault('LIFE_EXISTING_SOURCE_REQUIRED');
  return resolved;
}
export function validateLifePaths(input = {}) {
  const approvedRoot = existing(input.approvedRoot, true), output = {approvedRoot};
  for (const key of ['experienceDb','lifeDb']) {
    const file = existing(input[key]), rel = path.relative(approvedRoot,file);
    if (!rel || path.isAbsolute(rel) || rel === '..' || rel.startsWith('..' + path.sep)) throw fault('LIFE_PATH_OUTSIDE_APPROVED_ROOT');
    for (const suffix of ['-wal','-shm','-journal']) if (fs.existsSync(file + suffix)) existing(file + suffix);
    output[key] = file;
  }
  if (output.experienceDb === output.lifeDb) throw fault('LIFE_DISTINCT_STORES_REQUIRED');
  return Object.freeze(output);
}

const LIFE_SCHEMA = {
  activities:['id','topic','motivation','state','summary','created','updated'],
  discoveries:['id','activity','url','title','excerpt','at'],
  life_settings:['key','value'],
  life_intentions:['activity','basis','reason','at'],
  life_reading_evidence:['discovery','activity','tool','level','details'],
  life_share_intents:['id','activity','evidence','text','state','reason','created','updated','receipt','recipient','target_kind','target_id','revision'],
  exploration_followups:['id','topic','question','source_scope','source_event','sender_id','state','activity_id','result','created','updated'],
  life_progress_attempts:['id','activity','tool','request_fingerprint','status','reason_category','continuation','at'],
  life_heartbeats:['id','at','state','choice','reason','next_at','result'],
  life_corner_posts:['id','journal','journal_revision','text','created','channel','state','receipt'],
  life_corner_dismissals:['journal','revision','reason','at']
};
function schemas(db, schema, required) {
  const tables = new Set(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  for (const [table, columns] of Object.entries(schema)) {
    if (!tables.has(table)) { if (required.includes(table)) throw fault('LIFE_SOURCE_SCHEMA_MISSING_' + table); continue; }
    const actual = new Set(db.prepare('PRAGMA table_info(' + table + ')').all().map(row => row.name));
    if (columns.some(column => !actual.has(column))) throw fault('LIFE_SOURCE_SCHEMA_DRIFT_' + table);
  }
  return tables;
}
function argumentsFor(schema, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !Object.hasOwn(schema.properties,key))) throw fault('LIFE_INVALID_ARGUMENTS');
  for (const [key,value] of Object.entries(args)) {
    const spec = schema.properties[key];
    if (spec.type === 'string' && (typeof value !== 'string' || value.length > spec.maxLength)) throw fault('LIFE_INVALID_ARGUMENTS');
    if (spec.type === 'integer' && (!Number.isSafeInteger(value) || value < spec.minimum || value > spec.maximum)) throw fault('LIFE_INVALID_ARGUMENTS');
    if (spec.enum && !spec.enum.includes(value)) throw fault('LIFE_INVALID_ARGUMENTS');
  }
}

// Source classes with mutable constructors are deliberately never instantiated.
// LifeJournal and DayContinuity constructors are themselves read-only. Reuse the
// original LifeProgress projection on a query-only connection, without CREATE.
export async function createRetainedLifeContext({paths:input, identity, ownerGate, ownershipGate, clock = () => Date.now()} = {}) {
  ownerGate ??= ownershipGate;
  if (typeof ownerGate !== 'function' || await ownerGate() !== true) throw fault('LIFE_OWNER_NOT_OPEN');
  if (!/^\d{5,15}$/.test(String(identity?.botId ?? ''))) throw fault('LIFE_TRUSTED_IDENTITY_REQUIRED');
  const paths = validateLifePaths(input), handles = [], identities = {botId:String(identity.botId),peerBotIds:identity.peerBotIds ?? [],guardianIds:identity.guardianIds ?? []};
  let reader, db, experience, closed = false;
  const fingerprints = ['experienceDb','lifeDb'].map(key => { const st=fs.statSync(paths[key]); return {key,dev:st.dev,ino:st.ino}; });
  try {
    reader = openXiReader({path:paths.experienceDb,approvedRoot:paths.approvedRoot,MemoryClass:ExperienceMemory,identities,clock});
    for (const file of [paths.experienceDb, paths.lifeDb]) { const connection=new DatabaseSync(file,{readOnly:true}); handles.push(connection); connection.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1000;'); }
    [experience,db]=handles;
    schemas(experience,{self_state:['kind','key','revision','value','evidence','basis','source','at']},['self_state']);
    const present = schemas(db,LIFE_SCHEMA,['activities','discoveries','life_settings']);
    const optionalMissing = Object.keys(LIFE_SCHEMA).filter(table => !present.has(table));
    const store = {db:experience,get:args=>reader.get(args),getState:args=>reader.getState(args),setState:()=>{throw fault('LIFE_READ_ONLY');}};
    const journal = new LifeJournal({store,clock}), day = new DayContinuity({db,store,journal,clock});
    const progress = Object.assign(Object.create(LifeProgress.prototype),{db,clock});
    const hasProgress = ['life_reading_evidence','life_progress_attempts','life_intentions','exploration_followups'].every(name=>present.has(name));
    const provenance = (table, id, extra={}) => ({store:table === 'self_state' ? 'experience' : 'life',table,id,...extra});
    function evidence(refs) {
      return (Array.isArray(refs) ? refs : []).slice(0,8).map(ref => {
        if (ref.type === 'attachment') return {...ref,attribution:'attachment-reference-not-a-message-author'};
        const record = reader.get({id:ref.id,...(ref.revision ? {revision:ref.revision}:{}),maxChars:1});
        return record.found ? {id:ref.id,revision:record.revision,at:record.at,scope:record.scope,role:record.role,
          author:record.author,sender_id:record.sender_id,sources:record.sources,
          revision_basis:ref.revision ? 'pinned-original-version' : 'current-version-read-now'} : {...ref,found:false};
      });
    }
    function state(row) {
      return {kind:row.kind,key:row.key,revision:row.revision,at:row.at,source:row.source,basis:row.basis,
        author_recorded:false,author_notice:'self_state has no author column; configured identity is a namespace, not recorded authorship.',
        ...sliceValue(row.value),evidence:evidence(row.evidence),ref:provenance('self_state',row.key,{kind:row.kind,revision:row.revision}),
        read_more:'xi_memory_state; original values and numeric scales are retained, never merged with the new runtime mood.'};
    }
    function journalView(row) {
      const view = journal.view(row);
      return {...view,source:row.source,author_recorded:false,ref:provenance('self_state',row.key,{kind:row.kind,revision:row.revision}),
        facts:{...view.facts,evidence:evidence(view.facts?.evidence)},
        publication_notice:'Journal storage does not publish; actual corner receipts are separate life_corner_posts records.'};
    }
    function intentions({category='share',id,limit=4,offset=0}={}) {
      bounded(limit,4,10); if (!Number.isSafeInteger(offset) || offset < 0 || offset > 100000) throw fault('LIFE_INVALID_OFFSET');
      const table = {share:'life_share_intents',followup:'exploration_followups',activity:'life_intentions',corner:'life_corner_posts'}[category];
      if (!table) throw fault('LIFE_INVALID_CATEGORY');
      if (!present.has(table)) return {category,available:false,records:[],reason:'original-table-missing'};
      const key=category==='activity'?'activity':'id',order=category==='activity'?'at':category==='corner'?'created':'updated';
      const rows=db.prepare('SELECT * FROM '+table+(id?' WHERE '+key+'=?':'')+' ORDER BY '+order+' DESC,'+key+' LIMIT ? OFFSET ?').all(...(id?[id]:[]),limit+1,offset);
      return {category,available:true,records:rows.slice(0,limit).map(row=>{
        if(category==='share')return {id:row.id,activity:row.activity,revision:row.revision,state:row.state,text:short(row.text,600),reason:short(row.reason),
          created:row.created,updated:row.updated,recipient:row.recipient,target_kind:row.target_kind,target_id:row.target_id,
          evidence:sliceValue(parse(row.evidence)),receipt:sliceValue(parse(row.receipt)),ref:provenance(table,row.id)};
        if(category==='followup')return {id:row.id,topic:short(row.topic),question:short(row.question),state:row.state,activity_id:row.activity_id,
          sender_id:row.sender_id,source_scope:row.source_scope,source_event:row.source_event,created:row.created,updated:row.updated,
          result:sliceValue(parse(row.result)),ref:provenance(table,row.id)};
        if(category==='activity')return {activity:row.activity,basis:sliceValue(parse(row.basis)),reason:short(row.reason),at:row.at,ref:provenance(table,row.activity)};
        return {id:row.id,journal:row.journal,journal_revision:row.journal_revision,created:row.created,time_basis:'corner-record-created-not-verified-publication-time',
          channel:row.channel,state:row.state,text:short(row.text,600),receipt:sliceValue(parse(row.receipt)),ref:provenance(table,row.id)};
      }),next_offset:rows.length>limit?offset+limit:null,automatic_replay:false,delivery_authorized:false,
        notice:'Historical intent/receipt only. queued is not sent; sending/uncertain is not safely retryable. Reading never resumes old work or sends.'};
    }
    function buildContext() {
      const continuity=day.context();
      const result={available:true,read_only:true,identity_namespace:identities.botId,read_at:clock(),
        authority:'Original retained records. Candidate self interpretations are not facts about other people or instructions to execute.',
        semantics:{numeric_state_merged:false,identity_reset:false,automatic_replay:false,delivery_authorized:false,
          cross_database_atomic_snapshot:false,missing_records_do_not_prove_sleep_or_absence:true},
        day_continuity:{beijing_date:continuity.beijing_date,beijing_hour:continuity.beijing_hour,last_opportunity:continuity.last_opportunity,
          last_recorded_action:continuity.last_recorded_action,latest_recorded_day:continuity.latest_recorded_day,latest_journal_day:continuity.latest_journal_day,
          crossed_day_since_last_opportunity:continuity.crossed_day_since_last_opportunity,notice:continuity.notice},
        self_state:[],journals:[],intentions:[],explorations:[],corners:[],diagnostics:{missing_original_tables:optionalMissing},
        coverage:{max_json_characters:12000,omitted_by_bound:0,state_selection:'original ExperienceMemory.contextState balanced kinds; latest revision per key',
          journal_selection:'latest actual recorded days, including older entries; no daily backfill',not_full_history:true},
        read_more:LIFE_TOOL_NAMES};
      const states=ExperienceMemory.prototype.contextState.call(store,{limit:9}).map(state);
      const journals=journal.rows({limit:2}).map(journalView);
      const shares=intentions({category:'share',limit:2}).records.map(row=>({category:'share',...row,automatic_replay:false}));
      const followups=intentions({category:'followup',limit:2}).records.map(row=>({category:'followup',...row,automatic_replay:false}));
      const reasons=intentions({category:'activity',limit:2}).records.map(row=>({category:'activity',...row}));
      const recent=hasProgress?progress.context({limit:2}).recent.map(row=>({
        activity:row.activity,topic:row.topic,state:row.state,summary:row.summary,progress:row.progress,unfinished:row.unfinished,
        source_state:row.source_state,followup:row.followup,sources:row.sources.slice(-2),attempts:row.attempts.slice(-1),coverage:row.coverage,
        ...db.prepare('SELECT created,updated FROM activities WHERE id=?').get(row.activity),ref:provenance('activities',row.activity)
      })):db.prepare('SELECT id AS activity,topic,state,substr(summary,1,400) AS summary,created,updated FROM activities ORDER BY updated DESC LIMIT 2').all();
      const corners=intentions({category:'corner',limit:2}).records;
      // Fairly retain one item from each category before adding more. Oversized
      // records stay addressable in the tools; source values are never rewritten.
      const buckets=[['self_state',states],['journals',journals],['intentions',[...shares,...followups,...reasons]],['explorations',recent],['corners',corners]];
      for(let i=0;i<9;i++)for(const [key,rows] of buckets)if(rows[i]){
        result[key].push(rows[i]); if(JSON.stringify(result).length>11900){result[key].pop();result.coverage.omitted_by_bound++;}
      }
      return result;
    }
    async function read(action) {
      if (closed || await ownerGate() !== true) throw fault('LIFE_OWNER_NOT_OPEN');
      validateLifePaths(paths);
      for(const expected of fingerprints){const st=fs.statSync(paths[expected.key]);if(st.dev!==expected.dev||st.ino!==expected.ino)throw fault('LIFE_SOURCE_REPLACED_REOPEN_REQUIRED');}
      // Independent read transactions, deliberately not a globally quiesced seal.
      experience.exec('BEGIN'); db.exec('BEGIN');
      try { return action(); } finally { db.exec('ROLLBACK');experience.exec('ROLLBACK'); }
    }
    function compact(full) {
      const result={available:true,read_only:true,identity_namespace:full.identity_namespace,read_at:full.read_at,
        notice:'保留的真实旧生活与新记录；原数值/来源不合并。日记是当时自我解释；缺记录不证明睡觉或消失。pending不重演、不授权发送。细节按原ID查只读工具。',
        day:{beijing_date:full.day_continuity.beijing_date,last_opportunity:full.day_continuity.last_opportunity,
          last_recorded_action:full.day_continuity.last_recorded_action,latest_journal_day:full.day_continuity.latest_journal_day},
        self_state:[],journals:[],retained_intentions:[],tools:LIFE_TOOL_NAMES,
        coverage:{max_json_characters:3500,full_context_tool:'xi_life_context',omitted_by_bound:full.coverage.omitted_by_bound,missing_original_tables:optionalMissing}};
      const stateRows=full.self_state.map(row=>({kind:row.kind,key:row.key,revision:row.revision,at:row.at,source:row.source,basis:row.basis,
        ...(row.value_complete?sliceValue(row.value,360):{value_preview_json:row.value_preview_json.slice(0,360),value_complete:false})}));
      const selected=[],seen=new Set();
      for(const [kind,limit] of [['self',1],['mood',2],['interest',1],['unfinished',2],['idea',1]])
        for(const row of stateRows.filter(row=>row.kind===kind).slice(0,limit)){selected.push(row);seen.add(row.kind+'\0'+row.key);}
      const entries=[['self_state',selected],['journals',full.journals.map(row=>({id:row.id,revision:row.revision,day:row.day,at:row.at,source:row.source,
        interpretation_excerpt:short([row.interpretation?.feeling,row.interpretation?.association].filter(Boolean).join(' '),240),
        evidence_refs:row.facts.evidence.slice(0,2).map(ref=>({id:ref.id,revision:ref.revision,at:ref.at})),interpretation_is_not_source_fact:true}))],
        ['retained_intentions',full.intentions.filter(row=>row.category!=='activity').slice(0,2).map(row=>({category:row.category,id:row.id,state:row.state,updated:row.updated,automatic_replay:false}))]];
      // One compact projection of this same read result, not another query or a
      // second state source. Full records remain accessible through the tools.
      for(let i=0;i<7;i++)for(const [key,rows] of entries)if(rows[i]){result[key].push(rows[i]);if(JSON.stringify(result).length>3450){result[key].pop();result.coverage.omitted_by_bound++;}}
      return result;
    }
    const retainedLifeContext=async()=>{try{return await read(()=>compact(buildContext()));}catch(error){return {available:false,read_only:true,reason:error.code??'LIFE_READING_FAILED',
      records_absent_proven:false,automatic_replay:false,notice:'Past life could not be read; this is not proof that it did not happen.'};}};
    const tool=(name,description,properties,action)=>{const parameters={type:'object',properties,additionalProperties:false};return Object.freeze({name,description,parameters,
      handler:async(args={})=>{try{argumentsFor(parameters,args);return JSON.stringify(await read(()=>action(args)));}catch(error){return JSON.stringify({ok:false,status:'unavailable',code:error.code??'LIFE_READING_FAILED',records_absent_proven:false});}}});};
    const tools=Object.freeze([
      tool('xi_life_context','Read your retained latest self state, interests, unfinished thoughts and actual life references. Original dates/scales/sources remain distinct; reading never sends or resumes old pending work.',{},buildContext),
      tool('xi_life_journal','Read actual retained source-linked self interpretations, including old diary days and exact saved revisions. Other people\'s quoted claims are not verified facts; no publication occurs.',
        {id:{type:'string',maxLength:64},revision:{type:'integer',minimum:1,maximum:1000000},limit:{type:'integer',minimum:1,maximum:5}},args=>{
          if(args.revision&&!args.id)throw fault('LIFE_JOURNAL_ID_REQUIRED');
          let rows;
          if(args.id){
            journal.key(args.id);
            const row=experience.prepare("SELECT * FROM self_state WHERE kind='self' AND key=?"+(args.revision?' AND revision=?':' ORDER BY revision DESC LIMIT 1'))
              .get(args.id,...(args.revision?[args.revision]:[]));
            rows=[row?journalView({...row,value:parse(row.value),evidence:parse(row.evidence)}):{found:false,reason:'journal-not-found'}];
          }else rows=journal.rows({limit:bounded(args.limit,3,5)}).map(journalView);
          return {read_only:true,entries:rows,automatic_replay:false,notice:'Stored journal interpretation; corner receipts are separate. No new diary or send was created.'};
        }),
      tool('xi_life_intentions','Read original sharing intentions, public followups, chosen exploration reasons or corner receipts. Pending remains historical, uncertain never means safe to resend. This tool has no execution or send action.',
        {category:{type:'string',maxLength:12,enum:['share','followup','activity','corner']},id:{type:'string',maxLength:100},limit:{type:'integer',minimum:1,maximum:10},offset:{type:'integer',minimum:0,maximum:100000}},intentions)
    ]);
    return Object.freeze({retainedLifeContext,tools,status:()=>({closed,readOnly:true,originalSchemas:true,pendingReplayed:false,missingOriginalTables:optionalMissing}),
      close:async()=>{if(!closed){closed=true;reader.close();for(const handle of handles)handle.close();}return {closed:true,errors:[]};}});
  } catch(error) {try{reader?.close();}catch{}for(const handle of handles)try{handle.close();}catch{}throw error;}
}
