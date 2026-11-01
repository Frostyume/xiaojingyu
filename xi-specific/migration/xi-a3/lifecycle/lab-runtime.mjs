import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'node:events';

// Legacy function names are retained for the no-account app mode. This module
// cannot construct fixtures, select an account, or enable a network transport.
function rejectLinks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error('Diagnostic data cannot contain links');
    if (entry.isDirectory()) rejectLinks(path.join(dir, entry.name));
  }
}
export function resolveLabDataRoot(raw) {
  if (!path.isAbsolute(String(raw ?? ''))) throw new Error('Explicit absolute diagnostic root required');
  const root = path.resolve(raw);
  let cursor = path.parse(root).root;
  for (const part of root.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Diagnostic root cannot traverse links');
  }
  if (root === path.parse(root).root) throw new Error('Diagnostic volume root rejected');
  for (const name of ['.xi-diagnostic-runtime.json', 'config.json']) {
    const item = fs.lstatSync(path.join(root, name));
    if (!item.isFile() || item.isSymbolicLink()) throw new Error('Diagnostic marker and config must be regular files');
  }
  rejectLinks(root);
  const marker = JSON.parse(fs.readFileSync(path.join(root, '.xi-diagnostic-runtime.json'), 'utf8'));
  if (marker.kind !== 'xi-no-account-diagnostic-v1') throw new Error('Explicit no-account diagnostic marker required');
  return root;
}
export function assertLabConfig(cfg, root) {
  rejectLinks(root);
  if (cfg.ownerQQ || cfg.snowluma?.accessToken || cfg.dsh?.authToken || cfg.consoleToken ||
      cfg.allow?.private?.length || cfg.allow?.groups?.length || cfg.allowAllWhenEmpty)
    throw new Error('Diagnostic config cannot contain account identity, credentials or admission');
  for (const url of [cfg.dsh?.baseUrl, cfg.snowluma?.wsUrl]) {
    const endpoint = new URL(url);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) || endpoint.port !== '1' || endpoint.username || endpoint.password)
      throw new Error('Diagnostic endpoints must use disabled loopback port 1');
  }
  if (cfg.storage?.enabled === false || cfg.storage?.jobsEnabled === false) throw new Error('Diagnostic mode requires local SQLite and jobs');
  const inside = raw => {
    if (typeof raw !== 'string' || !raw) throw new Error('Explicit diagnostic storage required');
    const resolved = path.resolve(root, raw), relative = path.relative(root, resolved);
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('Diagnostic storage must stay below its root');
    let cursor = root;
    for (const part of relative.split(path.sep)) {
      cursor = path.join(cursor, part);
      if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Diagnostic storage cannot traverse links');
    }
  };
  for (const raw of [cfg.storage.dbPath, cfg.storage.backupDir, 'state', cfg.simulation?.imageLibrary?.dir, cfg.simulation?.voice?.dir]) inside(raw);
}

export function createDisabledDshAdapter() {
  let rejected = 0;
  const denied = async () => { rejected += 1; const e = new Error('Diagnostic DSH/model is not connected'); e.code = 'XI_DIAGNOSTIC_DSH_DISABLED'; throw e; };
  const api = { events: { follow() {}, unfollow() {} }, callUnary: denied };
  for (const domain of ['settings', 'sessions', 'workspaces', 'agentPresets', 'providers', 'host']) api[domain] = new Proxy({}, { get: () => denied });
  return { kind: 'disabled', api, status: () => ({ kind: 'disabled', connected: false, modelConnected: false, rejected }) };
}

export function createDisabledQQAdapter() {
  const emitter = new EventEmitter();
  let rejected = 0;
  const deny = async () => { rejected += 1; const e = new Error('Diagnostic QQ transport forbids real connection and sending'); e.code = 'XI_DIAGNOSTIC_QQ_DISABLED'; throw e; };
  Object.assign(emitter, {
    url: 'diagnostic://disabled', connect: deny, close() { emitter.removeAllListeners(); },
    onPrivateMessage(fn) { emitter.on('private', fn); }, onGroupMessage(fn) { emitter.on('group', fn); },
    onNotice(type, fn) { emitter.on(`notice:${type}`, fn); }, onEvent(fn) { emitter.on('event', fn); },
    onBotStatus(fn) { emitter.on('bot_status', fn); },
    sendPrivateMessage: deny, sendGroupMessage: deny, getGroupMemberInfo: deny, getForwardMsg: deny,
    status: () => ({ kind: 'disabled', connected: false, realSends: 0, rejected })
  });
  return emitter;
}
