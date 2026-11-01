import { randomUUID } from 'node:crypto';

// Owned by the dispatch path, never constructed from tool/model arguments.
export function createWakeSendContexts({ isCurrentSession }) {
  const contexts = new Map();
  function begin({ key, sessionId, snapshot, reason }) {
    const events = (snapshot?.messages ?? []).filter((m) => !m.isSelf && /^-?\d+$/.test(String(m.messageId)) && /^\d{5,15}$/.test(String(m.userId)))
      .map((m) => Object.freeze({ messageId: String(m.messageId), senderId: String(m.userId), seq: m.seq ?? null }));
    if (!events.length) throw new Error('No source-bound incoming events in wake snapshot');
    const trigger = events.at(-1), wakeId = randomUUID();
    const context = { key, sessionId, wakeId, reason, sourceEvents: Object.freeze(events),
      triggerEvent: trigger.messageId, triggerSenderId: trigger.senderId,
      readThroughSeq: snapshot.readThroughSeq, ordinal: 0, active: true };
    contexts.set(key, context); return snapshotOf(context);
  }
  function snapshotOf(value) {
    return structuredClone({ key: value.key, sessionId: value.sessionId, wakeId: value.wakeId, reason: value.reason,
      sourceEvents: value.sourceEvents, triggerEvent: value.triggerEvent, triggerSenderId: value.triggerSenderId,
      readThroughSeq: value.readThroughSeq, logicalSendOrdinal: value.ordinal, active: value.active });
  }
  function assertCurrent(binding) {
    const current = contexts.get(binding.key);
    if (!current || !current.active || current.wakeId !== binding.wakeId || current.sessionId !== binding.sessionId || !isCurrentSession(binding.key, binding.sessionId)) throw new Error('Stale or mismatched wake send context');
  }
  function claim({ key, sessionId, replyToMessageId }) {
    const current = contexts.get(key);
    if (!current || current.sessionId !== sessionId) throw new Error('No dispatched wake context for this session/key');
    assertCurrent(current);
    const selected = replyToMessageId == null ? null : current.sourceEvents.find((m) => m.messageId === String(replyToMessageId));
    if (replyToMessageId != null && !selected) throw new Error('Reply target is outside the bound wake snapshot');
    current.ordinal += 1;
    const binding = snapshotOf(current);
    if (selected) { binding.triggerEvent = selected.messageId; binding.triggerSenderId = selected.senderId; }
    return Object.freeze({ scope: key, triggerEvent: binding.triggerEvent, attemptId: `wake-${current.wakeId}:send-${current.ordinal}`, sendContext: Object.freeze(binding) });
  }
  return Object.freeze({ begin, claim, assertCurrent,
    endSession(sessionId) { for (const value of contexts.values()) if (value.sessionId === sessionId) value.active = false; },
    close() { for (const value of contexts.values()) value.active = false; },
    snapshot: () => [...contexts.values()].map(snapshotOf) });
}
