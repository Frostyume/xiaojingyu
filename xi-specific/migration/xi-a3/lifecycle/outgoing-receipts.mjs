import { isOwnedDeliveryPermit } from './owned-generation.mjs';
/** Local trusted transport bookkeeping, never supplied by a model or HTTP body. */
export function createTrustedOutgoingRecorder({ writer, botId, synthetic, contexts, generationId, sourceProvider, onPersistenceFailure }) {
  if (!writer?.prepareOutgoing || !writer?.completeOutgoing || !contexts || !/^\d{5,15}$/.test(String(botId)) || synthetic !== false) throw new Error('Explicit outgoing writer, bot identity, provenance and wake contexts required');
  const identity = String(botId);
  const sourceOrdinals = new Map();
  function prepare({ key, sessionId, messages, replyToMessageId, media }) {
    const activeSource = sourceProvider?.();
    const sourceContext = activeSource ? { ...activeSource, ...(media ? { media } : {}) } : null;
    if (sourceContext) {
      if (!writer.prepareSelfOutgoing || !writer.completeSelfOutgoing) throw new Error('Autonomous canonical writer required');
      const ordinal = (sourceOrdinals.get(sourceContext.operationId) ?? 0) + 1; sourceOrdinals.set(sourceContext.operationId, ordinal);
      const attempt = Object.freeze({ scope: key, attemptId: `owned-${sourceContext.operationId}:send-${ordinal}`, sourceContext,
        text: messages.join('\n'), parts: [...messages], synthetic });
      writer.prepareSelfOutgoing(attempt); return attempt;
    }
    let bound = contexts.claim({ key, sessionId, replyToMessageId });
    if (media) bound = { ...bound, sendContext: { ...bound.sendContext, media } };
    const attempt = Object.freeze({ ...bound, text: messages.join('\n'), parts: [...messages], synthetic });
    writer.prepareOutgoing(attempt); return attempt;
  }
  function part(attempt, partIndex) {
    if (!attempt || attempt.synthetic !== synthetic || !Number.isSafeInteger(partIndex) || !attempt.parts[partIndex]) throw new Error('Trusted prepared part required');
    return { ...attempt, partIndex };
  }
  function complete(attempt, partIndex, receipt) {
    const binding = part(attempt, partIndex);
    try { return (attempt.sourceContext ? writer.completeSelfOutgoing : writer.completeOutgoing)({ ...binding, receipt: { ...receipt, attemptId: attempt.attemptId, scope: attempt.scope, partIndex, botId: identity, synthetic, at: Date.now() } }); }
    catch (error) {
      // A known wire acknowledgment must never become another wire send merely
      // because storage failed. Keep exact repair material in the owned root.
      const pending = { binding, receipt: { ...receipt, attemptId: attempt.attemptId, scope: attempt.scope, partIndex, botId: identity, synthetic, at: Date.now() }, error: error.message, automaticReplay: false };
      if (typeof onPersistenceFailure !== 'function') throw Object.assign(error, { permanent: true, qqReceiptPersistenceFailure: pending });
      onPersistenceFailure(pending);
      return { repairNeeded: true, status: receipt.status, error: error.message };
    }
  }
  async function transmit({ attempt, partIndex, deliveryPermit, send }) {
    if (isOwnedDeliveryPermit(deliveryPermit, generationId ?? attempt.sourceContext?.generation)) {
      // Persisted current-runtime pending rows were already source-bound before
      // enqueue. Reopening the same root need not revive an old model session.
    } else if (attempt.sourceContext) {
      if (!sourceProvider || sourceProvider()?.generation !== attempt.sourceContext.generation) throw Object.assign(new Error('Missing current owned operation source'), { permanent: true });
    } else contexts.assertCurrent(attempt.sendContext);
    part(attempt, partIndex);
    let data;
    try {
      data = await send();
      if (!Number.isSafeInteger(data?.message_id)) throw new Error('OneBot response has no confirmed integer wire message ID');
    } catch (error) {
      const recorded = complete(attempt, partIndex, { status: 'unknown', reason: String(error?.message ?? error) });
      throw Object.assign(error, { permanent: true, qqDeliveryUnknown: true, receiptRepairNeeded: recorded.repairNeeded === true });
    }
    const recorded = complete(attempt, partIndex, { status: 'sent', messageId: data.message_id });
    return { ...data, ...(recorded.repairNeeded ? { experienceReceiptPending: true } : {}) };
  }
  return Object.freeze({ prepare, transmit, identity, synthetic });
}
