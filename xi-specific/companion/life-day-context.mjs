import {beijingJournalDay} from './life-journal.mjs';

const DAY = 86400000, OFFSET = 8 * 3600000, LIMIT = 3;
const parse = value => {try {return JSON.parse(value);} catch {return null;}};
const small = (value, max = 160) => typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : null;
const validTime = value => Number.isSafeInteger(value) && value >= 0 && value <= 253402271999999;
const validDay = day => typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && Number.isFinite(Date.parse(day + 'T00:00:00+08:00')) && new Date(Date.parse(day + 'T00:00:00+08:00') + OFFSET).toISOString().slice(0, 10) === day;
const table = (db, name) => !!db?.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
const timed = (alias, column) => `typeof(${alias}.${column})='integer' AND ${alias}.${column}>=0 AND ${alias}.${column}<=?`;
const sample = rows => ({records: rows.slice(0, LIMIT), more_records: rows.length > LIMIT});
const reference = row => ({id: row.id, revision: row.revision, at: validTime(row.at) ? row.at : null});

export const DAY_CONTINUITY_PROMPT = 'day_continuity按北京时间零点划分今天和昨天，07点只是已有生活机会时段，不是睡醒证明。last_opportunity记录的是机会开始时间，last_recorded_action来自已落库行为；缺少记录、进程停过或隔了几天，均不能编成自己睡觉、出门或一直研究。日记小卡是当时有来源的自我解释，不是他人的事实或必须复述的台词；可以按ID接着读，沿未完想法继续，也可以换兴趣或休息，不必每天补日记。老爹或家人没回消息不证明冷落，不扣心情或关系分。这份内部连续性上下文不授权公开日记、引用他人私聊或发送消息。';

// A read-only projection over existing stores. Constructor and context perform
// no migration, backfill, model call, timer registration or state mutation.
export class DayContinuity {
  constructor({db, store, journal, clock = () => Date.now()} = {}) {
    if (!db?.prepare || !store?.db?.prepare || typeof journal?.view !== 'function' || typeof clock !== 'function') throw Error('Day continuity requires existing life, experience and journal stores');
    Object.assign(this, {db, store, journal, clock});
  }

  heartbeats(now) {
    if (!table(this.db, 'life_heartbeats')) return {available: false, last: null, current: null};
    const get = condition => this.db.prepare(`SELECT id,at,state,choice FROM life_heartbeats h WHERE ${timed('h','at')} AND ${condition} ORDER BY at DESC,rowid DESC LIMIT 1`).get(now) ?? null;
    return {available: true, last: get("state<>'thinking'"), current: get("state='thinking'")};
  }

  sources(now, range = null) {
    if (!table(this.db, 'discoveries')) return [];
    const reading = table(this.db, 'life_reading_evidence');
    const rows = this.db.prepare(`SELECT d.id,d.activity,d.at,d.url,substr(d.title,1,120) AS title,${reading ? "COALESCE(r.level,'unknown')" : "'unknown'"} AS level
      FROM discoveries d ${reading ? 'LEFT JOIN life_reading_evidence r ON r.discovery=d.id AND r.activity=d.activity' : ''}
      WHERE ${timed('d','at')} ${range ? 'AND d.at>=? AND d.at<?' : ''} ORDER BY d.at DESC,d.rowid DESC LIMIT ?`)
      .all(now, ...(range ?? []), range ? LIMIT + 1 : 1);
    return rows.map(row => ({...row, kind: 'saved-exploration-source', time_basis: 'source-saved-at', title: small(row.title, 120)}));
  }

  attempts(now, range = null) {
    if (!table(this.db, 'life_progress_attempts')) return [];
    return this.db.prepare(`SELECT id,activity,tool,status,reason_category,at FROM life_progress_attempts a WHERE ${timed('a','at')}
      ${range ? 'AND a.at>=? AND a.at<?' : ''} ORDER BY at DESC,rowid DESC LIMIT ?`).all(now, ...(range ?? []), range ? LIMIT + 1 : 1)
      .map(row => ({...row, kind: 'exploration-attempt', time_basis: 'attempt-recorded-at', success_claimed: row.status === 'ok'}));
  }

  work(now, range = null) {
    const db = this.store.db;
    if (!['experiences','experience_versions','experience_sources'].every(name => table(db, name))) return [];
    const rows = db.prepare(`SELECT e.id,e.at,e.current_revision AS revision,substr(v.text,1,4000) AS text,v.metadata,
      CASE WHEN e.event LIKE 'own-workshop-result:%' THEN 'verified-workshop-result' ELSE 'own-workroom-change' END AS source
      FROM experiences e JOIN experience_versions v ON v.id=e.current_revision AND v.experience_id=e.id
      WHERE e.role='self' AND ${timed('e','at')} AND json_valid(v.metadata)
      AND json_extract(v.metadata,'$.source_event') LIKE 'life:%'
      AND ((e.scope='unknown' AND e.event LIKE 'own-workroom-change:%' AND EXISTS(SELECT 1 FROM experience_sources s WHERE s.experience_id=e.id AND s.revision_id=v.id AND s.source='own-workroom-change'))
        OR (e.event LIKE 'own-workshop-result:%' AND EXISTS(SELECT 1 FROM experience_sources s WHERE s.experience_id=e.id AND s.revision_id=v.id AND s.source='verified-workshop-result')))
      ${range ? 'AND e.at>=? AND e.at<?' : ''} ORDER BY e.at DESC,e.id LIMIT ?`).all(now, ...(range ?? []), range ? LIMIT + 1 : 1);
    return rows.map(row => {
      const data = parse(row.text) ?? {}, metadata = parse(row.metadata) ?? {};
      const verified = row.source === 'verified-workshop-result' && metadata.execution_verified === true && data.execution_verified === true && data.state === 'completed';
      return {...reference(row), kind: 'own-creative-record', source: row.source, time_basis: 'experience-event-at',
        title: small(data.title, 120), project_id: small(metadata.project_id, 100), version: Number.isSafeInteger(metadata.version) ? metadata.version : null,
        action: small(data.action, 60), state: verified ? 'completed-with-saved-receipt' : 'saved-change-or-request', execution_verified: verified,
        notice: verified ? 'A saved own-workshop result; no new execution occurred while reading this context.' : 'Saved files, checks or queued work do not mean execution completed.'};
    });
  }

  posts(now, range = null) {
    if (!table(this.db, 'life_corner_posts')) return [];
    return this.db.prepare(`SELECT id,journal,journal_revision,channel,state,created AS at,substr(text,1,160) AS text FROM life_corner_posts p
      WHERE ${timed('p','created')} ${range ? 'AND p.created>=? AND p.created<?' : ''}
      ORDER BY created DESC,rowid DESC LIMIT ?`).all(now, ...(range ?? []), range ? LIMIT + 1 : 1)
      .map(row => ({id: row.id, kind: 'corner-publication-record', at: row.at, time_basis: 'publication-record-created-at',
        journal_id: row.journal, journal_revision: row.journal_revision, channel: row.channel, current_state: row.state,
        published_confirmed: row.state === 'published', public_text_excerpt: row.state === 'published' ? small(row.text) : null,
        notice: 'Grouped by record creation day. Current receipt state is not a timestamp of publication or proof that anyone read it.'}));
  }

  journalRows(now, {day = null, latestByTime = false} = {}) {
    if (!table(this.store.db, 'self_state')) return [];
    const today = beijingJournalDay(now);
    return this.store.db.prepare(`SELECT s.* FROM self_state s WHERE s.kind='self' AND s.source='life-journal' AND substr(s.key,1,8)='journal:'
      AND json_valid(s.value) AND json_extract(s.value,'$.journal_schema')=1
      AND s.revision=(SELECT max(v.revision) FROM self_state v WHERE v.kind=s.kind AND v.key=s.key)
      AND ${timed('s','at')} AND json_extract(s.value,'$.day')<=?
      ${day ? "AND json_extract(s.value,'$.day')=?" : ''}
      ORDER BY ${latestByTime ? 's.at DESC' : "json_extract(s.value,'$.day') DESC,s.at DESC"},s.key LIMIT ?`)
      .all(now, today, ...(day ? [day] : []), day ? LIMIT + 1 : 4)
      .map(row => ({...row, value: parse(row.value), evidence: parse(row.evidence)})).filter(row => validDay(row.value?.day));
  }

  journalCard(row, now) {
    const entry = this.journal.view(row), thought = entry.interpretation ?? {};
    return {id: entry.id, revision: entry.revision, day: entry.day, kind: entry.kind, recorded_at: entry.at,
      created_at: validTime(entry.created_at) && entry.created_at <= now ? entry.created_at : null,
      interpretation_excerpt: small([thought.feeling, thought.association].filter(value => typeof value === 'string').join(' '), 200),
      evidence: (entry.facts?.evidence ?? []).slice(0, 3).map(ref => ({...reference(ref), at: validTime(ref.at) && ref.at <= now ? ref.at : null})), evidence_omitted: (entry.facts?.evidence ?? []).length > 3,
      interpretation_is_not_source_fact: true, read_more_with: 'read_life_journal'};
  }

  day(day, now) {
    const start = Date.parse(day + 'T00:00:00+08:00'), range = [start, start + DAY];
    const journals = this.journalRows(now, {day});
    return {day, journals: sample(journals.map(row => this.journalCard(row, now))),
      exploration_sources: sample(this.sources(now, range)), exploration_attempts: sample(this.attempts(now, range)),
      own_work: sample(this.work(now, range)), corner_records: sample(this.posts(now, range)),
      notice: 'Only saved records are shown. An empty day is not evidence of sleep, absence, activity or a duty to write a diary.'};
  }

  unfinished(now) {
    if (!table(this.store.db, 'self_state')) return {records: [], more_records: false};
    const rows = this.store.db.prepare(`SELECT s.key,s.revision,s.value,s.evidence,s.basis,s.at FROM self_state s
      WHERE s.kind='unfinished' AND s.revision=(SELECT max(v.revision) FROM self_state v WHERE v.kind=s.kind AND v.key=s.key)
      AND json_valid(s.value) AND COALESCE(json_type(s.value,'$.active'),'')<>'false' AND ${timed('s','at')}
      ORDER BY s.at DESC,s.key LIMIT ?`).all(now, LIMIT + 1);
    return sample(rows.map(row => ({kind: 'unfinished', key: row.key, revision: row.revision, at: row.at, basis: row.basis,
      interpretation_excerpt: small(parse(row.value)?.interpretation ?? parse(row.value)?.question, 200),
      evidence: (parse(row.evidence) ?? []).slice(0, 3).map(ref => ({type: ref.type, id: ref.id})),
      notice: 'A saved unfinished thought, not a scheduled obligation or a completed result.'})));
  }

  context() {
    const now = this.clock(); if (!validTime(now)) throw Error('Invalid day continuity clock');
    const today = beijingJournalDay(now), midnight = Date.parse(today + 'T00:00:00+08:00');
    const yesterday = beijingJournalDay(Math.max(0, midnight - 1));
    const heartbeats = this.heartbeats(now);
    const latestJournal = this.journalRows(now)[0] ?? null, journalAction = this.journalRows(now, {latestByTime: true})[0];
    const actions = [...this.sources(now), ...this.attempts(now), ...this.work(now), ...this.posts(now),
      ...(journalAction ? [{id: journalAction.key, revision: journalAction.revision, at: journalAction.at, kind: 'journal-recorded', time_basis: 'journal-version-recorded-at'}] : [])];
    const lastAction = actions.sort((a, b) => b.at - a.at)[0] ?? null;
    const stamp = row => row ? {id: row.id, kind: row.kind ?? 'life-opportunity', at: row.at, day: beijingJournalDay(row.at),
      elapsed_seconds: Math.floor((now - row.at) / 1000), time_basis: row.time_basis ?? 'opportunity-started-at',
      ...(row.state ? {state: row.state} : {}), ...(row.status ? {status: row.status} : {})} : null;
    const lastDay = lastAction ? beijingJournalDay(lastAction.at) : heartbeats.last ? beijingJournalDay(heartbeats.last.at) : null;
    const oldDays = [...new Set([lastDay, latestJournal?.value.day].filter(day => day && day !== today && day !== yesterday))];
    return {now: new Date(now).toISOString(), beijing_date: today, beijing_hour: new Date(now + OFFSET).getUTCHours(),
      day_starts_at: new Date(midnight).toISOString(), yesterday_date: yesterday,
      last_opportunity: stamp(heartbeats.last), current_started_opportunity: stamp(heartbeats.current),
      crossed_day_since_last_opportunity: heartbeats.last ? beijingJournalDay(heartbeats.last.at) !== today : null,
      last_recorded_action: stamp(lastAction), latest_recorded_day: lastDay, latest_journal_day: latestJournal?.value.day ?? null,
      days: {today: this.day(today, now), yesterday: this.day(yesterday, now), earlier_recorded_days: oldDays.map(day => this.day(day, now))},
      unfinished: this.unfinished(now), coverage: {per_category_limit: LIMIT, earlier_day_limit: 2, heartbeat_store_available: heartbeats.available,
        stores_available: {sources: table(this.db, 'discoveries'), attempts: table(this.db, 'life_progress_attempts'), corner: table(this.db, 'life_corner_posts'), journal: table(this.store.db, 'self_state'),
          work: ['experiences','experience_versions','experience_sources'].every(name => table(this.store.db, name))},
        future_or_invalid_timestamps_excluded: true, current_journal_revision_only: true, gap_activity_known: false,
        work_scope: 'Only existing own-workroom-change / own-workshop-result experiences linked to life opportunities; no workshop status call or new memory is produced.'},
      notice: DAY_CONTINUITY_PROMPT};
  }
}
