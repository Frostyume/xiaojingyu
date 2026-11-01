import { conversationalBeats } from '../../../companion/qq-bubbles.mjs';
import { conversationScope } from '../../../companion/conversation-scope.mjs';
import { createExperienceWriter } from '../experience/writer.mjs';
import { createAutonomousOutgoingStore } from './autonomous-outgoing.mjs';

const decode = (text) => { try { return JSON.parse(text); } catch { return null; } };
const scopeOf = (value) => {
  if (typeof value === 'object') return conversationScope(value.kind, value.id);
  const m = String(value).match(/^(group|private):(\d{5,15})$/);
  if (!m) throw new Error('Explicit valid destination scope required');
  return conversationScope(m[1], m[2]);
};
const attemptKey = (id) => {
  if (typeof id !== 'string' || !/^[a-zA-Z0-9_.:-]{1,100}$/.test(id)) throw new Error('Stable attemptId required');
  return id;
};
function whole(store, record) {
  let text = record.text;
  while (record.next_offset !== null) {
    record = store.get({ id: record.id, revision: record.revision, offset: record.next_offset, maxChars: 24000 });
    text += record.text;
  }
  return text;
}

// Narrow storage adapter for the existing constructor-created turns table.
// Incoming rows use PrivateConversation.receive(listenOnly); only the outgoing
// states lacking a public write method use this fixed-schema adapter.
function outgoingTurns(engine) {
  const columns = engine.db.prepare('PRAGMA table_info(turns)').all();
  if (columns.map((r) => r.name).join(',') !== 'peer,event,role,text,at,state' ||
      columns.filter((r) => r.pk).map((r) => [r.name, r.pk]).flat().join(',') !== 'peer,1,event,2,role,3') throw new Error('Pinned legacy turns schema changed');
  return {
    get: (peer, event) => engine.db.prepare("SELECT * FROM turns WHERE peer=? AND event=? AND role='assistant'").get(peer, event),
    insert: (peer, event, text, at) => engine.db.prepare("INSERT INTO turns VALUES(?,?,'assistant',?,?,'sending')").run(peer, event, text, at),
    update: (peer, event, text, at, state) => engine.db.prepare("UPDATE turns SET text=?,at=?,state=? WHERE peer=? AND event=? AND role='assistant'").run(text, at, state, peer, event),
    completeUser: (peer, event) => engine.db.prepare("UPDATE turns SET state='completed' WHERE peer=? AND event=? AND role='user'").run(peer, event)
  };
}

export function createCompatibleWriter({ store, engine, ledger, history, botId, clock = () => Date.now(), mode = 'synthetic' } = {}) {
  if (!['synthetic', 'transport'].includes(mode)) throw new Error('Explicit supported provenance mode required');
  const syntheticMode = mode === 'synthetic';
  const canonical = createExperienceWriter({ store, botId, clock, syntheticOnly: syntheticMode });
  const turns = outgoingTurns(engine);
  let closed = false, closePromise;
  const pending = new Set();
  const guard = () => { if (closed) throw new Error('Compatibility writer is closed'); };
  const autonomous = createAutonomousOutgoingStore({ store, history, botId, synthetic: syntheticMode, guard });
  const track = (operation) => {
    guard(); const job = Promise.resolve().then(operation); pending.add(job);
    job.finally(() => pending.delete(job)).catch(() => {}); return job;
  };
  function attemptsOf(parsed) {
    if (!parsed.compatibility.attempts) {
      const legacy = { ...parsed.compatibility, body: parsed.body };
      delete legacy.attempts;
      parsed.compatibility.attempts = [legacy];
    }
    return parsed.compatibility.attempts;
  }
  function getAttempt(scope, triggerEvent, attemptId) {
    attemptKey(attemptId); triggerEvent = String(triggerEvent);
    const row = turns.get(scope.address, triggerEvent), parsed = row && decode(row.text);
    const attempt = parsed?.compatibility && attemptsOf(parsed).find((a) => a.attempt_id === attemptId);
    if (!row || !attempt) throw new Error('Unknown or mismatched prepared attempt');
    return { row, parsed, attempt };
  }
  async function recordIncoming(input) {
    return track(async () => {
      if (input.synthetic !== syntheticMode) throw new Error('Mixed incoming provenance is forbidden for compatibility writer mode ' + mode);
      const result = canonical.recordIncoming(input);
      if (input.historical || result.wrote === false) return result;
      const scope = conversationScope(input.kind, input.id), eventId = String(input.event.message_id);
      const saved = store.get({ id: result.id, maxChars: 24000 });
      const structured = decode(whole(store, saved));
      // The original legacy transport format, without the extra raw-envelope
      // duplicate. Canonical full source remains untouched in ExperienceMemory.
      const text = JSON.stringify({ transport: structured.transport, body: structured.body, segments: structured.segments,
        received_attachments: structured.received_attachments });
      if (text.length > 64000) throw new Error('Legacy turns 64000-char limit; canonical retained, compatibility incomplete');
      const intake = await engine.receive(scope.address, eventId, text, { listenOnly: true });
      if (!['quiet', 'duplicate'].includes(intake.status)) throw new Error('Legacy intake incomplete: ' + intake.status);
      const imported = history.insert(scope, eventId, whole(store, saved), new Date(saved.at).toISOString(), 'admitted-transport');
      if (!['imported', 'duplicate', 'conflict-withheld'].includes(imported)) throw new Error('Legacy history incomplete');
      // Last: never mark an event seen before canonical+attachments+turns+history
      // succeeded. A duplicate canonical row still repairs missing legacy rows.
      const claimed = ledger.claim(input.event, clock());
      return { ...result, legacy: { turns: intake.status, history: imported, claimed,
        ledgerWindow: Math.abs(clock() - input.event.time * 1000) <= 120000 ? 'eligible-or-duplicate' : 'outside-legacy-window',
        noModelOrSend: true }, compatibilityComplete: true };
    });
  }
  function prepareOutgoing({ scope: rawScope, triggerEvent, attemptId, text, parts: explicitParts, sendContext = null, synthetic }) {
    guard(); if (synthetic !== undefined && synthetic !== syntheticMode) throw new Error('Mixed prepared provenance is forbidden');
    const scope = scopeOf(rawScope); attemptKey(attemptId); triggerEvent = String(triggerEvent);
    if (typeof text !== 'string' || !text.trim() || text.length > 60000) throw new Error('Invalid prepared outgoing body');
    const wireParts = explicitParts ?? conversationalBeats(text) ?? [text];
    if (!Array.isArray(wireParts) || !wireParts.length || wireParts.length > 8 || wireParts.some((v) => typeof v !== 'string' || !v.trim()) || wireParts.join('\n') !== text) throw new Error('Prepared parts must match the exact outgoing body');
    if (sendContext !== null && (typeof sendContext !== 'object' || JSON.stringify(sendContext).length > 16000)) throw new Error('Invalid trusted send context');
    const source = engine.db.prepare("SELECT 1 FROM turns WHERE peer=? AND event=? AND role='user'").get(scope.address, triggerEvent);
    if (!source) throw new Error('Outgoing preparation needs a retained admitted trigger');
    const reused = engine.db.prepare("SELECT event,text FROM turns WHERE peer=? AND role='assistant'").all(scope.address)
      .find((r) => { const v = decode(r.text); return v?.compatibility && attemptsOf(v).some((a) => a.attempt_id === attemptId) && r.event !== triggerEvent; });
    if (reused) throw new Error('Attempt ID already belongs to another trigger');
    const prior = turns.get(scope.address, triggerEvent), at = clock();
    const value = prior ? decode(prior.text) : { transport: { conversation: scope.address, sender_id: String(botId), message_id: null, time: at / 1000 }, body: '',
      compatibility: { trigger_event: triggerEvent, synthetic: syntheticMode, attempts: [] } };
    if (!value?.compatibility) throw new Error('Existing legacy reply has no compatible attempt provenance');
    const attempts = attemptsOf(value), existing = attempts.find((a) => a.attempt_id === attemptId);
    if (existing) {
      if (existing.body !== text || JSON.stringify(existing.parts.map((p) => p.text)) !== JSON.stringify(wireParts)) throw new Error('Prepared attempt has another immutable body/parts; no implicit retry');
      return { status: prior.state, attemptId, duplicate: true, parts: existing.parts };
    }
    const next = { attempt_id: attemptId, trigger_event: triggerEvent, prepared_at: at, synthetic: syntheticMode, body: text, send_context: sendContext,
      parts: wireParts.map((body, index) => ({ index, text: body, state: 'prepared', receipt: null })) };
    attempts.push(next); value.body = attempts.map((a) => a.body).join('\n');
    // Preserve first-attempt legacy JSON aliases while retaining every distinct
    // logical send in the same original (peer,event,assistant) turns row.
    value.compatibility.attempt_id = attempts[0].attempt_id;
    value.compatibility.parts = attempts[0].parts;
    const aggregate = attempts.some((a) => a.parts.some((p) => p.state === 'uncertain')) ? 'uncertain' : 'sending';
    if (prior) turns.update(scope.address, triggerEvent, JSON.stringify(value), at, aggregate);
    else turns.insert(scope.address, triggerEvent, JSON.stringify(value), at);
    return { status: aggregate, attemptId, duplicate: false, sendPerformed: false, parts: next.parts };
  }
  function completeOutgoing({ scope: rawScope, triggerEvent, attemptId, partIndex = 0, receipt }) {
    guard(); const scope = scopeOf(rawScope); triggerEvent = String(triggerEvent);
    const { row, parsed, attempt } = getAttempt(scope, triggerEvent, attemptId);
    const parts = attempt.parts ?? [{ index: 0, text: attempt.body, state: row.state, receipt: attempt.receipt }];
    if (!Number.isSafeInteger(partIndex) || !parts[partIndex]) throw new Error('Prepared partIndex required');
    const part = parts[partIndex]; attempt.parts = parts;
    parsed.compatibility.parts = attemptsOf(parsed)[0].parts;
    if (receipt?.synthetic !== undefined && receipt.synthetic !== syntheticMode) throw new Error('Mixed receipt provenance is forbidden');
    if (!receipt || receipt.attemptId !== attemptId || receipt.scope !== scope.address ||
        (receipt.partIndex !== undefined && receipt.partIndex !== partIndex) || !Number.isFinite(receipt.at) || receipt.at < 0 || !['sent', 'unknown'].includes(receipt.status)) throw new Error('Source-bound trusted transport receipt required');
    const aggregate = () => { const all = attemptsOf(parsed).flatMap((a) => a.parts); return all.every((p) => p.state === 'sent') ? 'sent' : all.some((p) => p.state === 'uncertain') ? 'uncertain' : 'sending'; };
    if (part.state === 'sent') {
      if (receipt.status === 'sent' && String(receipt.messageId) !== String(part.receipt.messageId)) throw new Error('Confirmed part already has another wire message ID');
      if (aggregate() === 'sent') turns.completeUser(scope.address, triggerEvent);
      return { status: aggregate(), partStatus: 'sent', duplicate: true, lateUnknownIgnored: receipt.status === 'unknown', sendPerformed: false };
    }
    if (receipt.status === 'unknown') {
      part.receipt = { ...receipt, synthetic: syntheticMode, partIndex, automatic_retry: false }; part.state = 'uncertain';
      turns.update(scope.address, triggerEvent, JSON.stringify(parsed), receipt.at, aggregate());
      const unconfirmed = store.recordMessage({ scope, event: 'attempt:' + attemptId + (parts.length > 1 ? ':part:' + partIndex : ''), role: 'assistant', senderId: String(botId),
        text: JSON.stringify({ body: part.text, transport: parsed.transport, compatibility: { attempt_id: attemptId, part_index: partIndex, receipt: part.receipt } }), at: receipt.at, state: 'uncertain', source: 'xi-unconfirmed-outgoing-attempt',
        sourceRef: { synthetic: syntheticMode, attempt_id: attemptId, trigger_event: triggerEvent, send_context: attempt.send_context ?? null, part_index: partIndex } });
      return { status: aggregate(), partStatus: 'uncertain', canonical: unconfirmed, sendPerformed: false, automaticRetry: false };
    }
    if (!Number.isSafeInteger(receipt.messageId) || String(receipt.botId) !== String(botId)) throw new Error('Confirmed wire message ID and configured sending bot are required');
    if (parts.some((p) => p.index !== partIndex && p.receipt?.status === 'sent' && p.receipt.messageId === receipt.messageId)) throw new Error('Wire message ID already belongs to another part');
    // One authoritative qq.self/acknowledged-qq-outgoing record per actual wire
    // bubble, exactly as the old scoped sender emits. No draft implies sent.
    const existing = store.get({ scope, event: String(receipt.messageId), role: 'assistant', maxChars: 24000 });
    if (existing.found && (existing.sender_id !== String(botId) || whole(store, existing) !== part.text)) throw new Error('Wire receipt conflicts with an existing canonical author/body');
    const wire = store.recordMessage({ scope, event: String(receipt.messageId), role: 'assistant', senderId: String(botId),
      text: part.text, at: receipt.at, state: 'sent', source: 'acknowledged-qq-outgoing',
      sourceRef: { synthetic: syntheticMode, attempt_id: attemptId, trigger_event: triggerEvent, send_context: attempt.send_context ?? null, part_index: partIndex, part_count: parts.length, wire_receipt: { ...receipt, synthetic: syntheticMode } } });
    history.importEvent({ type: 'qq.self', source: 'qq', origin: 'external', meta: { conv: scope, message_id: receipt.messageId }, text: part.text, ts: new Date(receipt.at).toISOString() }, 'isolated-qq-outgoing');
    part.state = 'sent'; part.receipt = { ...receipt, synthetic: syntheticMode, partIndex };
    parsed.transport.message_id = attemptsOf(parsed).length === 1 && parts.length === 1 ? String(receipt.messageId) : null;
    parsed.transport.time = receipt.at / 1000;
    turns.update(scope.address, triggerEvent, JSON.stringify(parsed), receipt.at, aggregate());
    if (aggregate() === 'sent') turns.completeUser(scope.address, triggerEvent);
    return { status: aggregate(), partStatus: 'sent', canonical: wire, duplicate: false, sendPerformed: false };
  }

  return Object.freeze({ kind: 'canonical-legacy-compatible-writer', recordIncoming, recordRecall: (input) => track(() => { if (input.synthetic !== syntheticMode) throw new Error('Mixed recall provenance is forbidden'); return canonical.recordRecall(input); }), get: canonical.get,
    prepareOutgoing, completeOutgoing, ...autonomous,
    status: () => ({ ...canonical.status(), legacyCompatibility: true, provenanceMode: mode, outgoingReceiptContract: true,
      outgoingReceiptsConnected: false, pendingIngests: pending.size, legacyTurns: closed ? null : engine.db.prepare('SELECT count(*) n FROM turns').get().n }),
    close() {
      if (closePromise) return closePromise; closed = true;
      closePromise = (async () => { await Promise.allSettled([...pending]); await engine.close(); history.close(); ledger.close(); canonical.close(); })();
      return closePromise;
    } });
}

