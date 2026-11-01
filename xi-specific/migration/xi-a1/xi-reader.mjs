import { DatabaseSync } from 'node:sqlite';
import { realpathSync, statSync } from 'node:fs';
import { relative, isAbsolute } from 'node:path';

const REQUIRED_TABLES = [
  'experiences',
  'experience_versions',
  'experience_sources',
  'attachments',
  'attachment_occurrences',
  'attachment_versions',
  'message_recalls',
  'experience_feedback',
  'self_state',
  'remembered_people'
];

const READ_METHODS = ['get', 'search', 'getState', 'getAttachment'];

function isWithin(root, target) {
  const rel = relative(root, target);
  return !isAbsolute(rel) && rel !== '..' && !/^\.\.[\\/]/.test(rel);
}

export function openXiReader({
  path,
  approvedRoot,
  MemoryClass,
  identities = {},
  clock = () => Date.now()
} = {}) {
  if (typeof path !== 'string' || path.length === 0) {
    throw new TypeError('path must be a non-empty string');
  }
  if (typeof approvedRoot !== 'string' || approvedRoot.length === 0) {
    throw new TypeError('approvedRoot must be a non-empty string');
  }
  if (typeof MemoryClass !== 'function') {
    throw new TypeError('MemoryClass must be a constructor function');
  }
  if (identities === null || typeof identities !== 'object' || Array.isArray(identities)) {
    throw new TypeError('identities must be an object');
  }
  if (typeof clock !== 'function') {
    throw new TypeError('clock must be a function');
  }

  const resolvedRoot = realpathSync(approvedRoot);
  const rootStat = statSync(resolvedRoot);
  if (!rootStat.isDirectory()) {
    throw new Error('approvedRoot must be a directory');
  }

  const resolvedDb = realpathSync(path);
  const dbStat = statSync(resolvedDb);
  if (!dbStat.isFile()) {
    throw new Error('database path must be a regular file');
  }

  if (!isWithin(resolvedRoot, resolvedDb)) {
    throw new Error('database path is outside approvedRoot');
  }

  const proto = MemoryClass.prototype;
  if (proto === null || typeof proto !== 'object') {
    throw new TypeError('MemoryClass.prototype must be an object');
  }
  for (const name of READ_METHODS) {
    if (typeof proto[name] !== 'function') {
      throw new TypeError('MemoryClass.prototype missing read method: ' + name);
    }
  }

  let db = null;
  let internal = null;
  let closed = false;

  const ensureOpen = () => {
    if (closed) {
      throw new Error('XiReader is closed');
    }
  };

  try {
    db = new DatabaseSync(resolvedDb, { readOnly: true });
    db.exec('PRAGMA query_only=ON;');
    db.exec('PRAGMA busy_timeout=1000;');

    const tableRows = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table'")
      .all();
    const present = new Set(tableRows.map((row) => row.name));
    for (const table of REQUIRED_TABLES) {
      if (!present.has(table)) {
        throw new Error('required table missing: ' + table);
      }
    }

    internal = Object.create(MemoryClass.prototype);
    internal.db = db;
    internal.clock = clock;
    internal.identities = {
      botId: null,
      peerBotIds: [],
      guardianIds: [],
      ...identities
    };
    internal.lastRetrievalEvidence = null;
  } catch (err) {
    if (db !== null) {
      try {
        db.close();
      } catch (_) {
        // ignore close failure during cleanup
      }
    }
    throw err;
  }

  const facade = Object.freeze({
    get(args) {
      ensureOpen();
      return internal.get(args);
    },
    search(args) {
      ensureOpen();
      return internal.search(args);
    },
    getState(args) {
      ensureOpen();
      return internal.getState(args);
    },
    getAttachment(id) {
      ensureOpen();
      return internal.getAttachment(id);
    },
    close() {
      if (closed) return;
      closed = true;
      internal = null;
      db.close();
    },
    describe() {
      ensureOpen();
      return {
        readOnly: true,
        transportAttached: false,
        historyReplayed: false
      };
    }
  });

  return facade;
}
