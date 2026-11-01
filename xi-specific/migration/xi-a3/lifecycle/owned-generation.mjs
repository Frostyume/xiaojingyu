import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { JobQueue } from '../upstream/runtime/kernel/jobs.js';
import { Outbox } from '../upstream/runtime/kernel/outbox.js';

const field = '__xiOwnedGeneration';
const deliveryPermits = new WeakSet();
export function isOwnedDeliveryPermit(permit, generationId) { return Boolean(permit && deliveryPermits.has(permit) && permit.generation === generationId); }
export function createOwnedGeneration({ id = randomUUID(), onWork = (_name, work) => work, onSource = () => {} } = {}) {
  const local = new AsyncLocalStorage(); let admitted = false, serial = 0;
  const prefix = `owned:${id}:`;
  function source() { return local.getStore() ?? null; }
  function runSource(origin, action) {
    if (!admitted) throw new Error('Owned generation admission is paused');
    if (!origin || typeof origin.kind !== 'string' || typeof origin.id !== 'string') throw new Error('Internal scheduler/operation source required');
    serial++;
    const value = Object.freeze({ generation: id, sourceKind: origin.kind, sourceId: origin.id, sourceKey: origin.key ?? null,
      sourceRefs: structuredClone(origin.evidence ?? []), operationId: `${id}:${randomUUID()}`, createdAt: Date.now() });
    onSource(value);
    return onWork('owned:' + origin.kind, local.run(value, () => Promise.resolve().then(action)));
  }
  return Object.freeze({ id, prefix, field, source, runSource,
    runRetainedSource(context, action) {
      if (!context || context.generation !== id || typeof context.operationId !== 'string') throw new Error('Current retained operation source required');
      return onWork('owned:retained-send', local.run(Object.freeze(structuredClone(context)), () => Promise.resolve().then(action)));
    },
    admit() { admitted = true; }, pause() { admitted = false; }, isAdmitted: () => admitted,
    owns: (payload) => payload?.[field] === id,
    payload: (payload) => ({ ...payload, [field]: id }),
    dedupe: (key) => key == null ? null : prefix + key,
    status: () => ({ id, admitted, operationsCreated: serial }) });
}

// The original schemas and execution handlers are retained. Only admission and
// claims are generation-scoped, so old rows are never recovered or rewritten.
export class OwnedGenerationJobQueue extends JobQueue {
  constructor({ generation, ...options }) { super(options); this.generation = generation; }
  enqueue(options) { return super.enqueue({ ...options, payload: this.generation.payload(options.payload ?? {}), dedupeKey: this.generation.dedupe(options.dedupeKey) }); }
  findByDedupe(key) { return super.findByDedupe(this.generation.dedupe(key)); }
  cancel(key) { return super.cancel(this.generation.dedupe(key)); }
  clearPending(type, note = 'Replaced within current owned generation') {
    return this.db.run("UPDATE jobs SET state='cancelled',last_error=?,updated_at=?,finished_at=? WHERE type=? AND state='pending' AND json_extract(payload_json,'$.__xiOwnedGeneration')=?", note, this.now(), this.now(), type, this.generation.id).changes;
  }
  recover() { return { stale: 0, due: Number(this.db.get("SELECT count(*) n FROM jobs WHERE state='pending' AND run_after<=? AND json_extract(payload_json,'$.__xiOwnedGeneration')=?", this.now(), this.generation.id)?.n ?? 0) }; }
  _claimDue() {
    if (!this.generation.isAdmitted()) return null;
    const at = this.now(), row = this.db.get("SELECT id FROM jobs WHERE state='pending' AND run_after<=? AND json_extract(payload_json,'$.__xiOwnedGeneration')=? ORDER BY run_after,id LIMIT 1", at, this.generation.id);
    if (!row) return null;
    const claimed = this.db.run("UPDATE jobs SET state='running',attempts=attempts+1,locked_until=?,updated_at=? WHERE id=? AND state='pending'", at + this.jobTimeoutMs, at, row.id);
    if (claimed.changes !== 1) return null;
    return this._explicitRow(row.id);
  }
  _explicitRow(id) {
    const r = this.db.get('SELECT * FROM jobs WHERE id=?', id);
    return { id: Number(r.id), type: r.type, key: r.job_key, payload: JSON.parse(r.payload_json), dedupeKey: r.dedupe_key, state: r.state,
      runAfter: Number(r.run_after), attempts: Number(r.attempts), maxAttempts: Number(r.max_attempts), lockedUntil: r.locked_until,
      createdAt: Number(r.created_at), updatedAt: Number(r.updated_at) };
  }
  _execute(job) { return this.generation.runSource({ kind: 'scheduler-job', id: String(job.id), key: job.key,
    evidence: [{ type: job.type, dedupeKey: job.dedupeKey, payload: job.payload }] }, () => super._execute(job)); }
  retry(id) {
    const r = this.db.get('SELECT payload_json FROM jobs WHERE id=?', Number(id));
    return r && this.generation.owns(JSON.parse(r.payload_json)) ? super.retry(id) : false;
  }
}

export class OwnedGenerationOutbox extends Outbox {
  constructor({ generation, ...options }) {
    const unknown = new Set(), deliver = options.deliver, terminal = options.onTerminal;
    super({ ...options, deliver: async (payload, item) => {
      const deliveryPermit = Object.freeze({ generation: generation.id, outboxId: item.id }); deliveryPermits.add(deliveryPermit);
      const admittedPayload = payload.xiOutgoingPart ? { ...payload, xiOutgoingPart: { ...payload.xiOutgoingPart, deliveryPermit } } : payload;
      try { return await deliver(admittedPayload, item); }
      catch (error) { if (error.qqDeliveryUnknown) unknown.add(item.id); throw error; }
    }, onTerminal: (item, state) => { if (!unknown.has(item.id)) terminal?.(item, state); } });
    this.generation = generation; this.unknown = unknown;
  }
  enqueue(options) { return super.enqueue({ ...options, payload: this.generation.payload(options.payload ?? {}), dedupeKey: this.generation.dedupe(options.dedupeKey) }); }
  findByDedupe(key) { return super.findByDedupe(this.generation.dedupe(key)); }
  recover() { return { uncertain: 0, pending: 0 }; }
  _attempt(id) {
    const item = this.get(id);
    // Already admitted in-flight sends may drain while admission is paused.
    if (!this.generation.owns(item?.payload)) return Promise.resolve('skipped');
    const run = async () => {
      const outcome = await super._attempt(id);
      if (this.unknown.delete(id)) {
        this.db.run("UPDATE outbox SET state='uncertain',next_attempt_at=NULL,locked_until=NULL WHERE id=? AND state!='sent'", id);
        return 'uncertain';
      }
      return outcome;
    };
    const source = item.payload.xiOutgoingPart?.attempt?.sourceContext;
    return source ? this.generation.runRetainedSource(source, run) : run();
  }
  drainOnce() {
    if (!this.generation.isAdmitted() || !this.isReady()) return Promise.resolve('not-ready');
    const row = this.db.get("SELECT id FROM outbox WHERE state='pending' AND (next_attempt_at IS NULL OR next_attempt_at<=?) AND json_extract(payload_json,'$.__xiOwnedGeneration')=? ORDER BY id LIMIT 1", this.now(), this.generation.id);
    if (!row) return Promise.resolve('idle');
    const run = this.chain.then(() => this._attempt(Number(row.id))); this.chain = run.catch(() => {}); return run;
  }
  retry(id) { return this.generation.owns(this.get(id)?.payload) ? super.retry(id) : false; }
}

export function ownedContinuationInventory({ db, generation, reminders = [] }) {
  const other = (r) => !generation.owns(JSON.parse(r.payload_json));
  return { generation: generation.id, automaticReplay: false, capturedAt: new Date().toISOString(),
    jobs: db.all("SELECT id,type,job_key,state,run_after,attempts,dedupe_key,payload_json FROM jobs WHERE state IN ('pending','running')").filter(other),
    outbox: db.all("SELECT id,key,kind,state,attempts,dedupe_key,payload_json,result_json,last_error FROM outbox WHERE state IN ('pending','sending','uncertain')").filter(other),
    unprocessedIncoming: db.all("SELECT id,key,kind,message_id,created_at,error FROM events WHERE direction='in' AND processed_at IS NULL"),
    currentGenerationPending: {
      jobs: db.all("SELECT id,type,state,run_after,attempts,payload_json,last_error FROM jobs WHERE state IN ('pending','running')").filter((row) => !other(row)),
      outbox: db.all("SELECT id,key,state,attempts,payload_json,result_json,last_error FROM outbox WHERE state IN ('pending','sending','uncertain')").filter((row) => !other(row)),
      reminders: reminders.filter((item) => ['pending','uncertain'].includes(item.status) && item.ownedGeneration === generation.id).map((item) => structuredClone(item))
    },
    reminders: reminders.filter((item) => item.status === 'pending' && item.ownedGeneration !== generation.id).map((item) => structuredClone(item)) };
}
