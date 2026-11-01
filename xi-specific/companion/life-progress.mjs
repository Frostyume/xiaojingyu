import {createHash, randomUUID} from 'node:crypto';

const WINDOW = 12, SOURCES = 40, ATTEMPTS = 24;
const materialLevels = new Set(['page-text', 'thread-posts', 'public-comments', 'subtitles', 'speech-transcript', 'sampled-frames']);
const normalize = value => String(value ?? '').normalize('NFKC').replace(/\s+/gu, ' ').trim();
const hash = value => createHash('sha256').update(value).digest('hex');
const parse = value => {try {return JSON.parse(value);} catch {return null;}};
const short = (value, length) => typeof value === 'string' ? value.slice(0, length) : null;
const reference = row => ({activity: row.activity, discovery: row.id, url: row.url, level: row.level});

export const LIFE_PROGRESS_PROMPT = 'exploration_progress只说明已保存来源的范围和最近尝试，不替你判断喜不喜欢，也不衡量你的成长。new-material只是所列有限窗口内出现不同材料，不保证新知识或结论；same-material也可能值得从新角度想。搜索线索、简介、字幕、抽样画面和机器转写各有实际范围。抓取失败只说明这次入口不可用。可以沿具体未读位置继续、换来源或角度，也可以搁置、换兴趣、创作或休息，不必为了交差再报一遍结果。没有新材料就如实保留，未完成不冒充问题已解决。';

function sourceKey(raw) {
  try {
    const url = new URL(raw); url.hash = '';
    // Preserve semantic parameters (video page, article ID, pagination). Only
    // known attribution parameters are irrelevant to the source identity.
    for (const key of [...url.searchParams.keys()]) if (/^utm_/i.test(key) || ['spm_id_from','vd_source'].includes(key)) url.searchParams.delete(key);
    url.searchParams.sort(); return url.href;
  } catch {return String(raw ?? '');}
}

function commentAtoms(row) {
  if (row.tool !== 'bilibili_comments' || row.level !== 'public-comments') return null;
  const data = parse(row.excerpt);
  if (!data?.bvid || !Array.isArray(data.comments)) return null;
  const atoms = data.comments.filter(item => item?.id && item.author?.id && typeof item.text === 'string' && item.text.trim()).map(item => ({
    key: JSON.stringify([data.bvid, item.id, item.author.id, item.at, item.root_id, item.parent_id]), text: normalize(item.text), truncated:item.text_truncated===true
  }));
  return atoms.length ? atoms.sort((a,b) => a.key.localeCompare(b.key)) : null;
}

function contentOf(row) {
  if (row.tool === 'bilibili_comments') {const atoms=commentAtoms(row); return atoms ? JSON.stringify(atoms) : null;}
  let text = row.excerpt ?? '';
  if (['bilibili_read','bilibili_listen'].includes(row.tool)) {
    const data = parse(text);
    // Stored structured excerpts can be truncated. Do not fingerprint their
    // changing partial envelope as if it were newly understood video content.
    if (!data) return null;
    const content = data.content ?? {}, transcript = data.transcript ?? content.speech_transcript;
    if (row.level === 'subtitles') text = JSON.stringify((content.subtitle ?? []).map(x => [x.from, x.to, normalize(x.text)]));
    else if (row.level === 'speech-transcript') text = JSON.stringify((transcript?.segments ?? []).filter(x => x.state === 'transcribed' && normalize(x.text)).map(x => [x.start_ms ?? x.start_seconds ?? x.start, x.end_ms ?? x.end_seconds ?? x.end, normalize(x.text)]));
    else if (row.level === 'sampled-frames') text = JSON.stringify((content.sampled_frames ?? []).filter(x => x.status === 'vision-ok').map(x => [x.time, x.sha256 ?? null]));
    else text = JSON.stringify([normalize(row.title), normalize(data.author), normalize(data.description)]);
    if (text === '[]' || text === '["","",""]') return null;
  }
  text = normalize(text);
  return text ? text : null;
}

function classify(row, previous) {
  if (!row.content || row.level === 'unknown') return {kind: 'unverified-material', match: null};
  if (row.level === 'public-comments') {
    // The same comment can appear in a root preview, a reply page and its root
    // context. Compare actual seen atoms across page boundaries in this window.
    // Counts, likes, observation time, order and positions do not create material.
    const atoms=commentAtoms(row), candidates=previous.filter(p=>p.level==='public-comments'&&p.content);
    let match=null;
    const seen=atoms?.every(atom=>candidates.some(prior=>(commentAtoms(prior)??[]).some(old=>{
      const same=old.key===atom.key&&(old.text===atom.text||atom.truncated&&old.text.startsWith(atom.text));
      if(same&&!match)match=reference(prior);return same;
    })));
    return {kind:seen?'same-material':'new-material',match:seen?match:null};
  }
  const comparable = previous.filter(p => p.level === row.level && p.content);
  const exact = comparable.find(p => p.fingerprint === row.fingerprint);
  if (exact) return {kind: 'same-material', match: reference(exact)};
  const sameSource = comparable.filter(p => p.source_key === row.source_key);
  // A longer/shorter cut of the same saved passage is not automatically a new
  // finding. Nor is a lightly shifted excerpt with most of its text in common.
  const overlap = sameSource.find(p => p.content.includes(row.content) || row.content.includes(p.content) || overlaps(row.content, p.content));
  if (overlap) return {kind: 'overlapping-material', match: reference(overlap)};
  if (row.level === 'search-lead') return {kind: 'new-lead', match: null};
  if (row.level === 'metadata-only') return {kind: 'new-metadata', match: null};
  if (!materialLevels.has(row.level)) return {kind: 'unverified-material', match: null};
  const priorScope = previous.find(p => p.source_key === row.source_key && p.level !== row.level);
  return {kind: priorScope && !sameSource.length ? 'new-reading-scope' : 'new-material', match: priorScope ? reference(priorScope) : null};
}

function overlaps(a, b) {
  if (Math.min(a.length, b.length) < 160) return false;
  const shorter = a.length <= b.length ? a : b, longer = a.length <= b.length ? b : a;
  let matched = 0, checked = 0;
  for (let offset = 0; offset + 40 <= shorter.length; offset += 40) {checked++; if (longer.includes(shorter.slice(offset, offset + 40))) matched++;}
  return checked > 0 && matched / checked >= 0.8;
}

function failureCategory(result) {
  const value = String(result?.reason ?? result?.code ?? '');
  if (/credential|authorization|login|401|403|412/i.test(value)) return 'access-unavailable';
  if (/429|rate.limit/i.test(value)) return 'rate-limited';
  if (/timeout|timed.out/i.test(value)) return 'timeout';
  if (/abort|interrupt/i.test(value)) return 'interrupted';
  if (/unconfigured|not.configured|unavailable|missing/i.test(value) || ['unavailable','unconfigured'].includes(result?.status)) return 'reader-unavailable';
  if (/unsupported|too.large|exceeds/i.test(value)) return 'unsupported-source';
  return 'no-usable-source';
}

function continuation(result) {
  const scope = result?.read_scope ?? {}, content = result?.content ?? {};
  const unprocessed = content.speech_transcript?.unprocessed_ranges ?? content.speech_transcript?.evidence?.unprocessed_ranges;
  return {
    next_offset: Number.isSafeInteger(result?.next_offset) && result.next_offset >= 0 ? result.next_offset : null,
    next_page: Number.isSafeInteger(scope.next_page) && scope.next_page >= 1 ? scope.next_page : null,
    subtitles_truncated: content.subtitle_truncated === true,
    transcript_unprocessed: Array.isArray(unprocessed) && unprocessed.length > 0,
  };
}

// Evidence descriptions only: no provider, scheduler, interest mutation, retry
// budget, completion decision or sending capability exists in this module.
export class LifeProgress {
  constructor(db, {clock = () => Date.now()} = {}) {
    this.db = db; this.clock = clock;
    db.exec(`CREATE TABLE IF NOT EXISTS life_progress_attempts(
      id TEXT PRIMARY KEY, activity TEXT NOT NULL, tool TEXT NOT NULL,
      request_fingerprint TEXT NOT NULL, status TEXT NOT NULL,
      reason_category TEXT, continuation TEXT NOT NULL, at INTEGER NOT NULL
    ); CREATE INDEX IF NOT EXISTS life_progress_attempt_activity ON life_progress_attempts(activity,at);`);
  }

  recordAttempt(activity, {tool, args = {}, result} = {}) {
    if (!this.db.prepare('SELECT 1 FROM activities WHERE id=?').get(activity)) throw Error('A saved activity is required');
    if (typeof tool !== 'string' || !/^[a-z][a-z0-9_]{0,79}$/.test(tool)) throw Error('A bounded reader name is required');
    if (typeof result === 'string') result = parse(result);
    const rawStatus = result?.status;
    const status = ['ok','empty','partial','failed','unavailable','unconfigured','interrupted'].includes(rawStatus) ? rawStatus : 'unknown';
    // Retain no raw request, URL credentials, error message, response envelope,
    // or provider secret. The hash identifies unchanged attempts locally only.
    const publicArgs = Object.fromEntries(['url','query','topic','video','page','root_id','offset','start_seconds','seconds','thread_id','post_id','forum_id'].filter(k => Object.hasOwn(args, k)).map(k => [k, args[k]]));
    const request = hash(tool + '\0' + JSON.stringify(publicArgs));
    const next = continuation(result), id = randomUUID();
    this.db.prepare('INSERT INTO life_progress_attempts VALUES(?,?,?,?,?,?,?,?)').run(id, activity, tool, request, status, status === 'ok' ? null : failureCategory(result), JSON.stringify(next), this.clock());
    return {id, status, reason_category: status === 'ok' ? null : failureCategory(result)};
  }

  window(activity = null) {
    const anchor = activity ? this.db.prepare('SELECT rowid AS sequence FROM activities WHERE id=?').get(activity) : null;
    if (activity && !anchor) throw Error('Unknown saved activity');
    const rows = anchor ? this.db.prepare('SELECT rowid AS sequence,* FROM activities WHERE rowid<=? ORDER BY rowid DESC LIMIT ?').all(anchor.sequence, WINDOW) :
      this.db.prepare('SELECT rowid AS sequence,* FROM activities ORDER BY rowid DESC LIMIT ?').all(WINDOW);
    const older = rows.length ? !!this.db.prepare('SELECT 1 FROM activities WHERE rowid<? LIMIT 1').get(rows.at(-1).sequence) : false;
    return {rows: rows.reverse(), older};
  }

  describe({rows, older}) {
    const previous = [], summaries = [], previousAttempts = new Map();
    for (const activity of rows) {
      const fetched = this.db.prepare(`SELECT d.rowid AS sequence,d.*,COALESCE(r.level,'unknown') AS level,r.tool,r.details
        FROM discoveries d LEFT JOIN life_reading_evidence r ON r.discovery=d.id AND r.activity=d.activity
        WHERE d.activity=? ORDER BY d.rowid LIMIT ?`).all(activity.id, SOURCES + 1);
      const sources = fetched.slice(0, SOURCES).map(row => {
        const content = contentOf(row), details = parse(row.details) ?? {};
        const current = {...row, content, details, source_key: sourceKey(row.url), fingerprint: content ? hash(content) : null};
        const comparison = classify(current, previous);
        previous.push(current);
        return {...reference(current), title: short(row.title, 160), fingerprint: current.fingerprint, comparison: comparison.kind,
          compared_with: comparison.match, excerpt: short(content, 160), continuation: continuation({...details, content: details.content}),
          scope: {whole_video_watched: false, audio_understood: false, read_scope: details.read_scope ?? null,
            speech_coverage: details.content?.speech_transcript?.coverage ?? null,
            sampled_frames: (details.content?.sampled_frames ?? []).slice(0, 4).map(({time, status}) => ({time, status}))}};
      });
      const attempts = this.db.prepare('SELECT id,tool,request_fingerprint,status,reason_category,continuation,at FROM life_progress_attempts WHERE activity=? ORDER BY rowid DESC LIMIT ?').all(activity.id, ATTEMPTS + 1);
      const kept = attempts.slice(0, ATTEMPTS).reverse().map(row => {
        const prior = previousAttempts.get(row.request_fingerprint) ?? null;
        previousAttempts.set(row.request_fingerprint, {activity: activity.id, attempt: row.id, status: row.status});
        return {...row, continuation: parse(row.continuation), repeated_request_of: prior};
      });
      const counts = Object.fromEntries(['new-material','new-reading-scope','new-lead','new-metadata','same-material','overlapping-material','unverified-material'].map(kind => [kind, sources.filter(s => s.comparison === kind).length]));
      const intention = this.db.prepare('SELECT basis FROM life_intentions WHERE activity=?').get(activity.id);
      const basis = parse(intention?.basis);
      const state = basis?.source_state;
      const followup = this.db.prepare('SELECT id,state,result FROM exploration_followups WHERE activity_id=? ORDER BY updated DESC LIMIT 1').get(activity.id);
      const followupOutcome = parse(followup?.result)?.outcome ?? null;
      const unfinished = followupOutcome === 'partial' || !!(activity.topic || sources.length || kept.length || basis) && activity.state !== 'completed';
      const material = counts['new-material'] + counts['new-reading-scope'];
      const unavailable = kept.filter(a => ['failed','unavailable','unconfigured','interrupted'].includes(a.status));
      const status = material ? 'different-saved-material' : sources.length && counts['same-material'] + counts['overlapping-material'] === sources.length ? 'repeated-or-overlapping-material' :
        sources.length ? 'limited-source-evidence' : unavailable.length ? 'source-unavailable' : 'no-saved-reading';
      summaries.push({activity: activity.id, topic: activity.topic, state: activity.state, summary: short(activity.summary, 400), progress: status, counts,
        source_state: state ? {kind: state.kind, key: state.key, revision: state.revision} : null,
        followup: followup ? {id: followup.id, state: followup.state, outcome: followupOutcome} : null,
        unfinished,
        sources: sources.slice(-4), attempts: kept.slice(-4), unavailable_attempts: unavailable.length,
        repeated_requests: kept.filter(a => a.repeated_request_of).length,
        coverage: {source_limit: SOURCES, sources_omitted: fetched.length > SOURCES, attempt_limit: ATTEMPTS, attempts_omitted: attempts.length > ATTEMPTS, shown_sources: Math.min(sources.length, 4), inspected_sources: sources.length},
        choices: this.choices({status, unfinished, continuation: sources.some(s => s.continuation.next_offset !== null || s.continuation.next_page !== null || s.continuation.subtitles_truncated || s.continuation.transcript_unprocessed) || kept.some(a => a.continuation.next_offset !== null || a.continuation.next_page !== null)})});
    }
    return {recent: summaries.reverse(), coverage: {activity_limit: WINDOW, inspected_activities: rows.length, older_activities_omitted: older,
      meaning: 'Comparisons cover only this bounded saved-source window, not lifetime novelty, understanding or interest. Source records are re-read, so corrections apply without rewriting history.'}};
  }

  choices({status, unfinished, continuation}) {
    return [
      {choice: 'continue', basis: continuation ? 'A saved unread position or incomplete media scope exists; use its actual source reference.' : unfinished ? 'This activity remains unfinished; name a concrete next question before another attempt.' : 'Continue only if there is a particular question or interpretation you want to pursue.'},
      {choice: 'change-angle', basis: status === 'source-unavailable' ? 'The observed access failed; another public source or an offline thought may help. This says nothing about liking the topic.' : 'A different source, question or reflection is available; the same material can support a new interpretation.'},
      {choice: 'pause-or-new-curiosity', basis: 'You may set this aside, change interests, make something or rest. No interest state or human follow-up is changed by this summary.'},
    ];
  }

  inspect(activity) {
    const result = this.describe(this.window(activity));
    return {...result.recent.find(row => row.activity === activity), comparison_window: result.coverage};
  }

  context({candidates = [], limit = 8} = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > WINDOW) throw Error('Choose a bounded progress context');
    const result = this.describe(this.window());
    return {recent: result.recent.slice(0, limit), related_interests: candidates.slice(0, 12).map(candidate => ({
      kind: candidate.kind, key: candidate.key, revision: candidate.revision,
      activities: result.recent.filter(row => row.source_state?.kind === candidate.kind && row.source_state?.key === candidate.key).map(row => row.activity),
    })), coverage: result.coverage, notice: LIFE_PROGRESS_PROMPT};
  }
}
