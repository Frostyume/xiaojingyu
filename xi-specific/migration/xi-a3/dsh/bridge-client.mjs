// Reuse the pinned namespace facade; only the wire transport/mux differs.
// Protocol: A2 upstream channels/dsh/client.js, explicit owned-instance auth only.
import { AbstractApiClient } from '../../xi-a2/node_modules/@deepseek-ai/dsh-host-apiproxy/lib/types/fetch/client.js';
import { randomUUID } from 'node:crypto';

export function createBridgeClient({ baseUrl, callUnary, openWebSocket }) {
  const parsed = new URL(baseUrl);
  if (parsed.protocol !== 'http:' || parsed.hostname !== '127.0.0.1' || ['3080', '3091'].includes(parsed.port)) throw new Error('XI_A3_BRIDGE_REQUIRES_OWNED_LOOPBACK');
  class OwnedBridgeClient extends AbstractApiClient {
    constructor() {
      super(15000);
      this.baseUrl = baseUrl;
      this.desired = new Set(); this.active = new Set(); this.controls = { followSent: 0, cancelSent: 0 };
      this.agentPresets = { list: (payload, signal) => this.callUnary('agentPresets/list', payload, signal) };
      this.events = {
        mux: (_payload, signal, onOpen) => this.mux(signal, onOpen),
        host: (_payload, signal, onOpen) => this.mux(signal, onOpen),
        follow: id => { if (id) { this.desired.add(String(id)); for (const run of this.active) run.follow(String(id)); } },
        forget: id => { this.desired.delete(String(id)); for (const run of this.active) run.forget(String(id)); },
        unfollow: id => this.events.forget(id)
      };
    }
    callUnary(method, payload, signal) { return callUnary(method, payload, signal); }
    resolveBase() { return baseUrl; }
    async respond(message, signal) {
      if (!message?.clientId || !message?.eventId || !message?.outcome) throw new Error('XI_A3_LEGACY_RESPOND_DISABLED');
      return this.callUnary('$events/result', message, signal);
    }
    status() { return { activeMuxes: this.active.size, desiredSessions: [...this.desired], activeSessionStreams: [...this.active].reduce((sum, run) => sum + run.count(), 0), controls: { ...this.controls } }; }
    async close() { await Promise.all([...this.active].map(run => run.close())); this.desired.clear(); }
    mux(signal, onOpen) {
      const client = this;
      const generator = (async function* () {
        signal?.throwIfAborted();
        const controller = new AbortController();
        const abort = () => controller.abort();
        signal?.addEventListener('abort', abort, { once: true });
        let socket, wake, ended = false, opened = false, eventClientId = null;
        const queue = [], sessionStreams = new Map(), streamSessions = new Map();
        const eventsId = randomUUID();
        let closeResolve;
        const closed = new Promise(resolve => { closeResolve = resolve; });
        const enqueue = value => { queue.push(value); const fn = wake; wake = null; fn?.(); };
        const end = () => { if (!ended) { ended = true; enqueue(null); } };
        const send = frame => { if (socket?.readyState === 1) socket.send(JSON.stringify(frame)); };
        const run = {
          follow(id) {
            if (!opened || ended || sessionStreams.has(id)) return;
            const streamId = randomUUID(); sessionStreams.set(id, streamId); streamSessions.set(streamId, id);
            send({ type: 'open', streamId, endpoint: 'session/follow', payload: { args: { request: { address: { kind: 'session', sessionId: id }, maxMessages: 200 } } } });
            client.controls.followSent++;
          },
          forget(id) {
            const streamId = sessionStreams.get(id);
            if (streamId) { send({ type: 'cancel', streamId }); client.controls.cancelSent++; sessionStreams.delete(id); streamSessions.delete(streamId); }
          },
          count() { return sessionStreams.size; },
          async close() {
            controller.abort(); end();
            if (!socket) return;
            if (socket.readyState === 0 || socket.readyState === 1) socket.close();
            let timer;
            try { await Promise.race([closed, new Promise(resolve => { timer = setTimeout(() => { socket.terminate(); resolve(); }, 1500); timer.unref(); })]); }
            finally { clearTimeout(timer); }
          }
        };
        client.active.add(run);
        controller.signal.addEventListener('abort', () => { end(); if (socket?.readyState === 0 || socket?.readyState === 1) socket.close(); }, { once: true });
        try {
          socket = await openWebSocket(controller.signal);
          socket.on('open', () => {
            if (controller.signal.aborted) { socket.close(); return; }
            opened = true;
            for (const id of client.desired) run.follow(id);
            send({ type: 'open', streamId: eventsId, endpoint: '$events', payload: { args: {} } });
            onOpen?.();
          });
          socket.on('message', bytes => {
            let message;
            try { message = JSON.parse(String(bytes)); } catch { return; }
            const sessionId = streamSessions.get(message.streamId);
            if (message.type === 'item' && message.streamId === eventsId) {
              const value = message.value;
              if (value?.type === 'ready') { eventClientId = value.clientId; enqueue({ rpcId: eventsId, payload: { type: 'bridge/ready' } }); }
              else if (value?.type === 'waterfall' && eventClientId && ['approval/request', 'user-questions/request'].includes(value.event)) {
                enqueue({ rpcId: value.eventId, payload: { ...value.request, type: value.event === 'approval/request' ? 'approval/requested' : 'question/requested', sessionId: value.agentId, clientId: eventClientId, eventId: value.eventId } });
              }
            } else if (message.type === 'item' && sessionId && message.value?.type === 'snapshot') {
              // Historical events never become fresh chat/delivery events.
              enqueue({ rpcId: message.streamId, payload: { type: 'session/snapshot', sessionId, snapshot: message.value } });
            } else if (message.type === 'item' && sessionId && message.value?.type === 'event') {
              enqueue({ rpcId: message.streamId, payload: { type: 'session/event', sessionId, event: message.value.event } });
            } else if (message.type === 'error') {
              enqueue({ rpcId: message.streamId, payload: { type: 'stream/error', sessionId, error: message.error } }); end(); socket.close();
            } else if (message.type === 'end' && message.streamId === eventsId) { end(); socket.close(); }
            else if (message.type === 'end' && sessionId) { sessionStreams.delete(sessionId); streamSessions.delete(message.streamId); }
          });
          socket.on('close', () => { closeResolve(); end(); });
          socket.on('error', () => { closeResolve(); end(); });
          while (true) {
            if (!queue.length) await new Promise(resolve => { wake = resolve; });
            while (queue.length) { const next = queue.shift(); if (next === null) return; client.onEnvelope(next); yield next; }
          }
        } finally {
          signal?.removeEventListener('abort', abort);
          client.active.delete(run); await run.close();
        }
      })();
      return { [Symbol.asyncIterator]: () => generator, follow: id => client.events.follow(id), forget: id => client.events.forget(id), unfollow: id => client.events.forget(id) };
    }
  }
  return new OwnedBridgeClient();
}
