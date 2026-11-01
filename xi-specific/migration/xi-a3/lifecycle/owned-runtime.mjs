import { EventEmitter } from 'node:events';

export async function verifyOwnedQQIdentity(transport, expectedBotId) {
  if (!/^\d{5,15}$/.test(String(expectedBotId))) throw new Error('Explicit owned bot identity required before QQ activation');
  const login = await transport.getLoginInfo();
  const actual = String(login?.user_id ?? login?.data?.user_id ?? '');
  if (actual !== String(expectedBotId)) throw Object.assign(new Error('Owned QQ login identity does not match the launch manifest; ingress and workers remain paused'), { code: 'XI_OWNED_QQ_IDENTITY_MISMATCH' });
  return { verified: true, botId: actual };
}

export function createOwnedLifecycle({ pauseIngress, stopSchedulers, snapshotWork, closeResources, persistUncertain }) {
  let phase = 'starting', stopping;
  const work = new Map(); let serial = 0;
  function snapshot() { return { phase, tracked: [...work.values()], observed: snapshotWork?.() ?? [] }; }
  function track(name, operation) {
    const id = ++serial; work.set(id, { id, name });
    const result = Promise.resolve(operation); result.finally(() => work.delete(id)).catch(() => {}); return result;
  }
  async function pause() {
    if (phase === 'stopped') return snapshot();
    phase = 'paused'; await pauseIngress(); await stopSchedulers(); return snapshot();
  }
  async function drain({ timeoutMs = 30000 } = {}) {
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (work.size || (snapshotWork?.() ?? []).length) {
      if (Date.now() >= deadline) return { drained: false, ...snapshot() };
      await new Promise((resolve) => setTimeout(resolve, Math.min(20, Math.max(1, deadline - Date.now()))));
    }
    return { drained: true, ...snapshot() };
  }
  function stop({ timeoutMs = 30000 } = {}) {
    if (stopping) return stopping;
    if (phase === 'stopped') return Promise.resolve({ closed: true, errors: [], state: snapshot() });
    stopping = (async () => {
      await pause(); phase = 'draining';
      const result = await drain({ timeoutMs });
      if (!result.drained) {
        phase = 'drain-timeout'; await persistUncertain(result);
        return { closed: false, errors: [{ name: 'drain', message: 'Owned runtime drain timed out; resources and lock retained' }], uncertain: result };
      }
      phase = 'closing'; const closed = await closeResources();
      phase = closed.closed && !closed.errors.length ? 'stopped' : 'close-failed'; return { ...closed, state: snapshot() };
    })().finally(() => { if (phase !== 'stopped') stopping = undefined; });
    return stopping;
  }
  return Object.freeze({ track, pause, drain, stop, snapshot, ready() { phase = 'ready-paused'; }, activated() { phase = 'active'; } });
}

/** Owns one connection supplied by the trusted launcher only after activation. */
export function createOwnedQQProxy({ onPausedEvent } = {}) {
  const events = new EventEmitter(), notices = new Set();
  const buffered = [];
  let transport, accepting = false, connected = false, transportClosed = false;
  const dispatch = async (name, event) => {
    if (!accepting) {
      await onPausedEvent?.(name, event);
      if (buffered.length < 500) buffered.push({ name, event: structuredClone(event) });
      return;
    }
    await Promise.all(events.listeners(name).map((fn) => fn(event)));
  };
  const own = {
    on: events.on.bind(events),
    onPrivateMessage(fn) { events.on('private', fn); }, onGroupMessage(fn) { events.on('group', fn); },
    onNotice(type, fn) { notices.add(type); events.on('notice:' + type, fn); },
    onEvent(fn) { events.on('event', fn); }, onBotStatus(fn) { events.on('bot_status', fn); },
    pauseAdmission() { accepting = false; }, async resumeAdmission() {
      if (!connected) throw new Error('No activated owned QQ connection'); accepting = true;
      while (accepting && buffered.length) { const next = buffered.shift(); await dispatch(next.name, next.event); }
    },
    async activate(factory) {
      if (transport) throw new Error('Owned QQ transport already exists');
      if (typeof factory !== 'function') throw new Error('Explicit owned QQ transport factory required');
      transport = await factory();
      if (!transport || typeof transport.connect !== 'function' || typeof transport.close !== 'function') throw new Error('Invalid owned QQ transport');
      transport.onPrivateMessage?.((event) => dispatch('private', event)); transport.onGroupMessage?.((event) => dispatch('group', event));
      for (const type of notices) transport.onNotice?.(type, (event) => dispatch('notice:' + type, event));
      transport.onEvent?.((event) => dispatch('event', event)); transport.onBotStatus?.((event) => dispatch('bot_status', event));
      for (const type of ['open', 'close', 'error']) transport.on?.(type, (event) => events.emit(type, event));
      await transport.connect(); connected = true;
    },
    async close() { accepting = false; if (transport && !transportClosed) { await transport.close(); transportClosed = true; } connected = false; events.removeAllListeners(); buffered.length = 0; },
    status: () => ({ kind: 'owned-qq', activated: Boolean(transport), connected, accepting, buffered: buffered.length, ownsConnection: Boolean(transport) })
  };
  return new Proxy(own, { get(target, key) {
    if (key in target) return target[key];
    if (key === 'then') return undefined;
    return (...args) => {
      if (!transport || !connected || typeof transport[key] !== 'function') throw new Error('Owned QQ operation is not activated/configured: ' + String(key));
      return transport[key](...args);
    };
  } });
}
