export function createResourceScope() {
  const resources = [];
  const names = new Set();
  let state = 'open';
  let closePromise;

  function defer(name, dispose) {
    if (state !== 'open') {
      throw new Error(`Cannot register a resource unless the scope is open (state: ${state})`);
    }

    if (typeof name !== 'string' || name.trim().length === 0) {
      throw new TypeError('Resource name must be a non-empty string');
    }

    if (typeof dispose !== 'function') {
      throw new TypeError(`Dispose for resource "${name}" must be a function`);
    }

    if (names.has(name)) {
      throw new Error(`Resource "${name}" is already registered`);
    }

    names.add(name);
    resources.push({ name, dispose });
  }

  function close() {
    if (closePromise !== undefined) {
      return closePromise;
    }

    state = 'closing';

    let resolveClose;
    let rejectClose;
    closePromise = new Promise((resolve, reject) => {
      resolveClose = resolve;
      rejectClose = reject;
    });

    (async () => {
      const errors = [];

      for (let index = resources.length - 1; index >= 0; index -= 1) {
        const { name, dispose } = resources[index];

        try {
          await dispose();
        } catch (error) {
          errors.push({
            name,
            message: String(error?.message ?? error),
          });
        }
      }

      state = 'closed';
      return { closed: true, errors };
    })().then(resolveClose, rejectClose);

    return closePromise;
  }

  function snapshot() {
    return {
      state,
      registered: resources.map(({ name }) => name),
    };
  }

  return { defer, close, snapshot };
}
