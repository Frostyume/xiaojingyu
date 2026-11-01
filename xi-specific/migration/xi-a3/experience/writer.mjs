import { createHash } from 'node:crypto';
import { conversationScope } from '../../../companion/conversation-scope.mjs';
import { transportMessage } from '../../../companion/group-message.mjs';
import { UnifiedCognition } from '../../../companion/cognition-tools.mjs';
import { QQRecall } from '../../../companion/qq-recall.mjs';

// Writer construction and ownership are explicit. No import, env, config or
// historical source discovers or opens a production memory database.
export function createExperienceWriter({ store, botId, clock = () => Date.now(), syntheticOnly = false } = {}) {
  if (!store || typeof store.recordMessage !== 'function') throw new Error('Explicit canonical ExperienceMemory store required');
  if (!/^\d{5,15}$/.test(String(botId))) throw new Error('Explicit configured bot ID required');
  let closed = false;
  const guard = (synthetic) => {
    if (closed) throw new Error('Experience writer is closed');
    if (syntheticOnly && synthetic !== true) throw new Error('Synthetic ExperienceMemory writer rejects non-synthetic input');
  };
  function resolveReply(scope, id) {
    const records = ['user', 'assistant'].map((role) => store.get({ scope, event: id, role })).filter((r) => r.found &&
      r.sources.some((s) => (r.role === 'assistant' ? ['acknowledged-qq-outgoing', 'isolated-qq-outgoing'] : ['live-transport', 'admitted-transport', 'referenced-qq-api']).includes(s.source)));
    if (records.length !== 1) return null;
    const original = records[0]; let body = original.text;
    try { body = JSON.parse(body).body ?? body; } catch {}
    return { sender_id: original.sender_id, scope: original.scope, body: String(body).slice(0, 1000), time: original.at / 1000,
      transport_status: original.transport_status };
  }
  function recordIncoming({ kind, id, event, synthetic = false, revisionKind = 'observation', historical = false }) {
    guard(synthetic);
    if (historical) return { status: 'historical-not-replayed', wrote: false };
    const scope = conversationScope(kind, id);
    if (event?.message_type !== kind || String(kind === 'group' ? event.group_id : event.user_id) !== scope.id) throw new Error('Inbound scope mismatch');
    if (!Number.isSafeInteger(event.message_id) || !Number.isFinite(event.time) || event.time < 0 || !Array.isArray(event.message)) throw new Error('Canonical incoming requires message ID, timestamp and OneBot segment array');
    if (!/^\d{5,15}$/.test(String(event.user_id))) throw new Error('Invalid transport sender');
    if (event.self_id !== undefined && String(event.self_id) !== String(botId)) throw new Error('Inbound bot identity mismatch');
    if (String(event.user_id) === String(botId)) return { status: 'self-transport-not-incoming', wrote: false };
    if (!['observation', 'correction', 'enrichment'].includes(revisionKind)) throw new Error('Unsupported explicit inbound revision');
    const eventId = String(event.message_id), previous = store.get({ scope, event: eventId });
    // A new observation never replaces current evidence. Explicit revisions
    // must remain attached to the same verified transport author.
    if (previous.found && previous.sender_id !== String(event.user_id)) throw new Error('Experience author conflict; original is preserved');
    if (revisionKind !== 'observation' && !previous.found) throw new Error('Explicit inbound revision needs an original record');
    const structured = transportMessage(event, { scope, botId: String(botId), resolveReply: (id) => resolveReply(scope, id) });
    const attachmentInputs = [];
    for (const [ordinal, segment] of event.message.entries()) {
      if (!['image', 'record', 'video', 'file', 'mface', 'bface', 'sface'].includes(segment.type)) continue;
      const data = segment.data ?? {};
      const wireId = String(data.file_id ?? data.fileId ?? data.id ?? data.file ?? '');
      const identity = `${scope.address}\0${segment.type}\0${wireId || eventId + ':' + ordinal}`;
      const attachmentId = 'xi-in-' + createHash('sha256').update(identity).digest('hex').slice(0, 32);
      attachmentInputs.push({ scope, id: attachmentId, event: eventId, created: event.time * 1000,
        mime: typeof data.mime === 'string' ? data.mime : null, sha: typeof data.sha256 === 'string' ? data.sha256 : null,
        analysis: null, source: 'received', metadata: { segment_type: segment.type, wire_id: wireId || null, ordinal,
          synthetic, transport_sender_id: String(event.user_id), bytes_received: false, analyzed: false } });
    }
    // Keep the original protocol segment data alongside the canonical rendering:
    // text bodies are never routed through the feature event's 500-char preview.
    // This also preserves unexpanded forward/node/attachment identifiers exactly.
    structured.source_message = { post_type: event.post_type ?? 'message', message_type: kind, sub_type: event.sub_type ?? null,
      self_id: String(botId), message_id: eventId, message_seq: event.message_seq ?? null,
      segments: structuredClone(event.message), raw_message: event.raw_message ?? null,
      source_time: event.time, received_at: clock(), synthetic };
    structured.received_attachments = { ids: attachmentInputs.map((a) => a.id), metadata_only: true, fetched: false, analyzed: false };
    // received_at belongs to source metadata, not the content identity. Keep it
    // stable across redelivery so identical protocol events remain duplicates.
    delete structured.source_message.received_at;
    const text = JSON.stringify(structured);
    // The authoritative store's 100000-char bound is explicit: fail rather than
    // silently truncating. There is no new divergent schema or lossy overflow.
    const result = store.recordMessage({ scope, event: eventId, role: 'user', text, at: event.time * 1000,
      senderId: String(event.user_id), source: synthetic ? 'admitted-transport' : 'live-transport', state: 'heard', revisionKind,
      sourceRef: { adapter: 'xi-a3-upstream-inbound', synthetic, message_id: eventId, scope: scope.address },
      metadata: { transport: 'onebot-v11', synthetic, message_seq: event.message_seq ?? null, full_protocol_segments: true } });
    const attachments = attachmentInputs.map((item) => store.recordAttachment(item));
    const feedback = UnifiedCognition.prototype.linkQuotedFeedback.call({ store }, scope, eventId, structured);
    return { ...result, attachments, feedback, fullBodyChars: structured.body.length, synthetic, wokeModel: false };
  }
  async function recordRecall({ event, synthetic = false, admitted = false }) {
    guard(synthetic);
    if (!admitted) return { status: 'not-allowed' };
    const group = event?.notice_type === 'group_recall';
    const scope = conversationScope(group ? 'group' : 'private', group ? event.group_id : event.user_id);
    // Reuse the actual old recall protocol, including identity/author conflict,
    // duplicate recall, early notice, source filtering and original preservation.
    const service = { paused: false, closed: false, cognition: { store }, isAllowed: async () => admitted,
      history: { insert() {} } }; // Canonical recall also records its own notice in ExperienceMemory.
    const result = await new QQRecall({ service, policy: { bot_id: String(botId) }, clock,
      world: { getWatched: () => ({ groups: group ? [scope.id] : [] }) } }).receive(event);
    if (synthetic && ['accepted-recall', 'duplicate-recall'].includes(result?.status)) {
      const noticeKey = 'notice:recall:' + createHash('sha256').update(scope.key + '\0' + String(event.message_id)).digest('hex');
      const notice = store.get({ scope, event: noticeKey, maxChars: 24000 });
      if (notice.found) store.recordMessage({ scope, event: noticeKey, text: notice.text, at: notice.at,
        source: 'xi-synthetic-recall', sourceRef: { synthetic: true, adapter: 'xi-a3-upstream-inbound' } });
    }
    return result;
  }
  return Object.freeze({ kind: 'canonical-experience-writer', recordIncoming, recordRecall,
    get: (args) => { guard(syntheticOnly); return store.get(args); },
    status: () => ({ enabled: true, closed, syntheticOnly, botId: String(botId), counts: closed ? null : store.counts(), outgoingReceiptsConnected: false }),
    close() { if (!closed) { store.close(); closed = true; } } });
}

