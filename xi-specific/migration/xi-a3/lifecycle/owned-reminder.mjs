/** New-generation reminder handler; an unknown wire never becomes a new send. */
export async function runOwnedReminder({ job, generation, store, outbox, canSend, send, persist, now = Date.now() }) {
  const item = store.reminders.find((r) => r.id === String(job?.payload?.reminderId ?? ''));
  if (!item || item.status !== 'pending') return { status: 'skip' };
  if (item.ownedGeneration !== generation.id) return { status: 'retained-for-explicit-continuation' };
  if (!canSend(item.key)) return { retryAfterMs: 60000 };
  const dedupeKey = `reminder:${item.id}`;
  let prior = outbox?.findByDedupe(dedupeKey);
  if (prior?.state === 'sent') { item.status = 'sent'; item.lastAttemptAt = now; persist(); return { status: 'sent' }; }
  if (prior && ['uncertain', 'dead'].includes(prior.state)) { item.status = 'uncertain'; item.lastAttemptAt = now; persist(); return { status: 'uncertain', automaticRetry: false }; }
  if (prior && ['pending', 'sending'].includes(prior.state)) return { retryAfterMs: 60000 };
  let confirmed = false;
  try { confirmed = await send(item.key, item.text, { dedupeKey }); }
  catch (error) {
    prior = outbox?.findByDedupe(dedupeKey);
    if (!error.qqDeliveryUnknown && prior?.state !== 'uncertain') throw error;
  }
  item.lastAttemptAt = Date.now();
  if (confirmed) item.status = 'sent';
  else {
    const latest = outbox?.findByDedupe(dedupeKey);
    if (latest && ['pending', 'sending'].includes(latest.state)) return { retryAfterMs: 60000 };
    item.status = 'uncertain';
  }
  persist(); return { status: item.status, automaticRetry: false };
}
