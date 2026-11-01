/** Source-bound self activity; no invented human turn or legacy send queue. */
export function createAutonomousOutgoingStore({ store, history, botId, synthetic, guard }) {
  const planEvent = (id) => 'owned-plan:' + id;
  function load(event) {
    let row = store.get({ scope: 'unknown', event, role: 'self', maxChars: 24000 });
    if (!row.found) return row;
    let text = row.text;
    while (row.next_offset !== null) { row = store.get({ id: row.id, revision: row.revision, offset: row.next_offset, maxChars: 24000 }); text += row.text; }
    return { ...row, text };
  }
  function validate(value) {
    if (!value || value.synthetic !== synthetic || !/^owned-[a-zA-Z0-9:._-]{1,180}$/.test(value.attemptId) || !/^(group|private):\d{5,15}$/.test(value.scope)) throw new Error('Trusted owned source attempt required');
    const source = value.sourceContext;
    if (!source || typeof source.generation !== 'string' || typeof source.sourceKind !== 'string' || typeof source.sourceId !== 'string' || typeof source.operationId !== 'string') throw new Error('Internal scheduler/operation source required');
  }
  function read(attemptId) {
    const row = load(planEvent(attemptId));
    if (!row.found) throw new Error('Retained autonomous outgoing plan required');
    return JSON.parse(row.text);
  }
  function save(plan, revisionKind = 'enrichment') {
    return store.recordMessage({ scope: 'unknown', event: planEvent(plan.attemptId), role: 'self', senderId: String(botId), text: JSON.stringify(plan), at: plan.preparedAt,
      state: plan.parts.every((part) => part.state === 'sent') ? 'sent' : plan.parts.some((part) => part.state === 'uncertain') ? 'uncertain' : 'prepared', revisionKind,
      source: 'owned-autonomous-outgoing-plan', sourceRef: { synthetic, destination: plan.scope, attempt_id: plan.attemptId, source_context: plan.sourceContext } });
  }
  function prepareSelfOutgoing(value) {
    guard(); validate(value);
    if (typeof value.text !== 'string' || value.text.length > 60000 || JSON.stringify(value.sourceContext).length > 16000 || !Array.isArray(value.parts) || !value.parts.length || value.parts.length > 8 || value.parts.some((s) => typeof s !== 'string' || !s.trim()) || value.parts.join('\n') !== value.text) throw new Error('Exact autonomous wire parts required');
    const prior = load(planEvent(value.attemptId));
    if (prior.found) { const p = JSON.parse(prior.text); if (p.scope !== value.scope || p.text !== value.text || JSON.stringify(p.sourceContext) !== JSON.stringify(value.sourceContext)) throw new Error('Immutable autonomous attempt conflict'); return { duplicate: true }; }
    save({ ...value, preparedAt: Date.now(), parts: value.parts.map((text, index) => ({ index, text, state: 'prepared', receipt: null })) }, 'observation');
    return { prepared: true, humanTrigger: false };
  }
  function completeSelfOutgoing({ attemptId, scope, partIndex, receipt }) {
    guard(); const plan = read(attemptId); validate(plan);
    if (scope !== plan.scope || !Number.isSafeInteger(partIndex) || !plan.parts[partIndex] || receipt?.scope !== scope || receipt?.attemptId !== attemptId || receipt.synthetic !== synthetic || !Number.isFinite(receipt.at) || !['sent', 'unknown'].includes(receipt.status)) throw new Error('Trusted source-bound autonomous wire receipt required');
    const part = plan.parts[partIndex];
    if (part.state === 'sent') { if (receipt.status === 'sent' && receipt.messageId !== part.receipt.messageId) throw new Error('Autonomous part already has another wire ID'); return { duplicate: true, lateUnknownIgnored: receipt.status === 'unknown' }; }
    if (receipt.status === 'sent' && (!Number.isSafeInteger(receipt.messageId) || String(receipt.botId) !== String(botId))) throw new Error('Configured bot and actual integer wire receipt required');
    const sent = receipt.status === 'sent';
    if (sent) { const existing = store.get({ scope, event: String(receipt.messageId), role: 'assistant', maxChars: 24000 }); if (existing.found && (existing.sender_id !== String(botId) || existing.text !== part.text)) throw new Error('Autonomous wire author/body conflicts with retained record'); }
    const result = store.recordMessage({ scope, event: sent ? String(receipt.messageId) : 'attempt:' + attemptId + ':part:' + partIndex, role: 'assistant', senderId: String(botId),
      text: part.text, at: receipt.at, state: sent ? 'sent' : 'uncertain', source: sent ? 'acknowledged-qq-outgoing' : 'xi-unconfirmed-outgoing-attempt',
      sourceRef: { synthetic, autonomous: true, human_trigger: false, attempt_id: attemptId, part_index: partIndex, source_context: plan.sourceContext, wire_receipt: { ...receipt, automatic_retry: false } } });
    if (sent) history.importEvent({ type: 'qq.self', source: 'qq', origin: 'external', meta: { conv: scope, message_id: receipt.messageId }, text: part.text, ts: new Date(receipt.at).toISOString() }, 'isolated-qq-outgoing');
    part.state = sent ? 'sent' : 'uncertain'; part.receipt = { ...receipt, automatic_retry: false }; save(plan);
    return { status: part.state, canonical: result, humanTrigger: false, automaticRetry: false };
  }
  function recordSelfActivity({ id, sourceContext, type, payload, state = 'observed' }) {
    guard();
    if (typeof id !== 'string' || !id || id.length > 220 || !sourceContext?.generation || !sourceContext?.sourceKind || !sourceContext?.sourceId || typeof type !== 'string') throw new Error('Trusted self activity source required');
    return store.recordMessage({ scope: 'unknown', event: 'owned-activity:' + id, role: 'self', senderId: String(botId),
      text: JSON.stringify({ type, payload, source_context: sourceContext, synthetic, human_trigger: false }), at: Date.now(), state, revisionKind: 'enrichment',
      source: 'owned-autonomous-activity', sourceRef: { synthetic, source_context: sourceContext, human_trigger: false } });
  }
  return { prepareSelfOutgoing, completeSelfOutgoing, recordSelfActivity };
}
