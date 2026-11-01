const MODES = Object.freeze(['shadow', 'lab', 'owned', 'live']);
const KNOWN_EFFECTS = Object.freeze([
  'console.listen', 'local.read', 'qq.connect', 'qq.send', 'qq.discover',
  'dsh.connect', 'dsh.credentials', 'scheduler.start', 'process.spawn',
  'external.fetch', 'state.write'
]);
const ISOLATED_ALLOWED = Object.freeze(['console.listen', 'local.read']);
const LIVE_ALLOWED = Object.freeze(KNOWN_EFFECTS);
const ISOLATED_GET_HEAD_PATHS = Object.freeze([
  '/', '/index.html', '/live', '/live/', '/live/index.html', '/api/xi/lifecycle'
]);

function isKnown(list, value) {
  return list.indexOf(value) !== -1;
}

function deny(effect, mode) {
  const err = new Error('XI effect denied: ' + effect + ' in mode ' + mode);
  err.code = 'XI_EFFECT_DENIED';
  err.effect = effect;
  err.mode = mode;
  return err;
}

export function createRuntimePolicy({ mode = 'shadow' } = {}) {
  // intent: only an explicit, non-empty, exact mode string is accepted
  const effectiveMode = typeof mode === 'string' ? mode.trim() : mode;
  const candidateMode = (typeof mode === 'string' && mode !== '' && mode === effectiveMode && isKnown(MODES, mode)) ? mode : undefined;
  if (candidateMode === undefined) {
    const err = new Error('Invalid runtime mode');
    err.code = 'XI_INVALID_MODE';
    throw err;
  }
  const isolated = candidateMode !== 'live';
  const allowedList = isolated ? ISOLATED_ALLOWED : LIVE_ALLOWED;

  function allows(effect) {
    return isKnown(allowedList, effect);
  }

  function assert(effect) {
    if (!isKnown(KNOWN_EFFECTS, effect)) throw deny(effect, candidateMode);
    if (!allows(effect)) throw deny(effect, candidateMode);
    return true;
  }

  function wrap(effect, operation) {
    if (typeof effect !== 'string' || !isKnown(KNOWN_EFFECTS, effect)) throw deny(effect, candidateMode);
    if (typeof operation !== 'function') {
      const err = new TypeError('operation must be a function');
      throw err;
    }
    // Creating a denied wrapper is safe; reject before invoking its operation.
    return function wrapped(...args) {
      assert(effect);
      return operation.apply(this, args);
    };
  }

  return Object.freeze({ mode: candidateMode, isolated, allows, assert, wrap });
}

export function resolveRuntimeMode(env = {}) {
  if (env === null || typeof env !== 'object') return 'shadow';
  // intent: only own XI_RUNTIME_MODE key counts; absent => shadow; empty/typo/whitespace rejected
  if (!Object.prototype.hasOwnProperty.call(env, 'XI_RUNTIME_MODE')) return 'shadow';
  const raw = env.XI_RUNTIME_MODE;
  if (typeof raw !== 'string' || raw === '' || raw !== raw.trim() || !isKnown(MODES, raw)) {
    const err = new Error('Invalid XI_RUNTIME_MODE');
    err.code = 'XI_INVALID_MODE';
    throw err;
  }
  return raw;
}

export function consoleRequestAllowed(policy, method, pathname) {
  if (policy === null || typeof policy !== 'object' || typeof policy.isolated !== 'boolean') return false;
  if (policy.isolated === false) return true;
  if (typeof method !== 'string' || typeof pathname !== 'string') return false;
  return (method === 'GET' || method === 'HEAD') && isKnown(ISOLATED_GET_HEAD_PATHS, pathname);
}
