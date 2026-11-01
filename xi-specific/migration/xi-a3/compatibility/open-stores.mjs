import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { ExperienceMemory } from '../../../companion/experience-memory.mjs';
import { PrivateConversation } from '../../../companion/private-conversation.mjs';
import { ScopedHistory } from '../../../companion/scoped-history.mjs';
import { EventLedger } from '../../../companion/event-ledger.mjs';
import { createCompatibleWriter } from './writer.mjs';

const requiredPaths = ['experience', 'turns', 'history', 'ledger'];
const id = (value) => /^\d{5,15}$/.test(String(value));
function explicitFile(value) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new Error('Every canonical store path must be explicitly absolute');
  const resolved = path.resolve(value), root = path.parse(resolved).root;
  let cursor = root;
  for (const piece of resolved.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, piece);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Explicit store paths cannot traverse links');
  }
  if (fs.existsSync(resolved) && !fs.statSync(resolved).isFile()) throw new Error('Explicit store target must be a regular file');
  return resolved;
}
async function closeHandles(resources) {
  const errors = [];
  for (const { name, handle } of [...resources].reverse()) {
    if (handle.db?.isOpen === false) continue;
    try { await handle.close(); }
    catch (error) {
      // Constructors are only storage readers/writers here, with no model or
      // sender. If an old close path throws, still release its native database.
      try { if (handle.db?.isOpen !== false) handle.db?.close(); } catch {}
      if (!/database is not open/i.test(error.message)) errors.push({ name, error: error.message });
    }
  }
  return errors;
}

/** No production root, environment, cwd, provider or launcher discovery. */
export async function openCompatibleStores({ paths, identities, mode, clock = () => Date.now() } = {}) {
  if (!['synthetic', 'transport'].includes(mode)) throw new Error('Caller must explicitly select provenance mode');
  if (!identities || !id(identities.botId) || !Array.isArray(identities.guardianIds) || !Array.isArray(identities.peerBotIds) ||
      !identities.guardianIds.every(id) || !identities.peerBotIds.every(id)) throw new Error('Explicit botId, guardianIds and peerBotIds are required');
  if (typeof clock !== 'function') throw new Error('Invalid explicit clock');
  const files = Object.fromEntries(requiredPaths.map((key) => [key, explicitFile(paths?.[key])]));
  if (new Set(Object.values(files).map((value) => value.toLowerCase())).size !== requiredPaths.length) throw new Error('Canonical stores must use distinct files');
  // Reject malformed existing SQLite files with an owned read-only probe before
  // invoking old constructors. No production path is selected automatically.
  for (const file of Object.values(files)) {
    if (!fs.existsSync(file)) continue;
    let probe;
    try { probe = new DatabaseSync(file, { readOnly: true }); if (probe.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw new Error('Canonical SQLite quick_check failed'); }
    finally { probe?.close(); }
  }
  const resources = [];
  const opened = (name, handle) => { resources.push({ name, handle }); return handle; };
  try {
    const normalized = { botId: String(identities.botId), guardianIds: identities.guardianIds.map(String), peerBotIds: identities.peerBotIds.map(String) };
    const store = opened('experience', new ExperienceMemory({ path: files.experience, ...normalized, clock }));
    const engine = opened('turns', new PrivateConversation({ path: files.turns, clock, client: {}, profile: 'storage-only',
      presentation: { botId: normalized.botId, peerBots: normalized.peerBotIds, guardianIds: normalized.guardianIds },
      isAllowed: async () => true, send: () => { throw new Error('Storage factory has no sender or model'); } }));
    fs.mkdirSync(path.dirname(files.history), { recursive: true });
    const history = opened('history', new ScopedHistory(files.history));
    const ledger = opened('ledger', new EventLedger(files.ledger));
    const writer = createCompatibleWriter({ store, engine, history, ledger, botId: normalized.botId, mode, clock });
    const sourceInfo = Object.freeze(Object.fromEntries(['experience-memory.mjs', 'private-conversation.mjs', 'scoped-history.mjs', 'event-ledger.mjs']
      .map((name) => [name, createHash('sha256').update(fs.readFileSync(new URL('../../../companion/' + name, import.meta.url))).digest('hex')])));
    let closing;
    return Object.freeze({ ...writer, paths: Object.freeze(files), identities: Object.freeze(normalized), sourceInfo,
      // Trusted bridge projection only; never exposed as a model tool or QQ event.
      recordRetainedState({event, text, at, sourceRef, state}) {
        if (typeof event !== 'string' || !event.startsWith('bridge:')) throw new Error('Expected retained bridge-state identity');
        return store.recordMessage({scope: 'unknown', event, role: 'self', senderId: normalized.botId,
          text, at, state, source: 'owned-bridge-state', sourceRef, revisionKind: 'note-update',
          metadata: {interpretationIsNotHumanSource: true, provenanceMode: mode}});
      },
      close() {
        if (!closing) closing = (async () => {
          let failure;
          try { await writer.close(); } catch (error) { failure = error; }
          const errors = await closeHandles(resources);
          if (failure || errors.length) throw Object.assign(new Error('Canonical stores closed with cleanup errors'), { cause: failure, cleanupErrors: errors });
        })();
        return closing;
      } });
  } catch (error) {
    error.cleanupErrors = await closeHandles(resources);
    throw error;
  }
}
