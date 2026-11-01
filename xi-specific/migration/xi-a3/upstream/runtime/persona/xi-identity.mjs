export function selectPersonaLayers({ selection, roleName, defaults } = {}) {
  if (defaults === null || typeof defaults !== "object" || Array.isArray(defaults)) {
    throw new TypeError("defaults must be a non-null, non-array object");
  }
  const fields = [
    "kernel",
    "nonText",
    "toneNudge",
    "styleReset",
    "ownerCommands",
    "ownerTargets",
    "memoryWrite"
  ];
  for (const field of fields) {
    if (typeof defaults[field] !== "string") {
      throw new TypeError(`defaults.${field} must be a string`);
    }
  }
  for (const field of ['antiAi', 'multiReply', 'proactive', 'imageStrategy', 'expressionMust']) {
    if (defaults[field] !== undefined && typeof defaults[field] !== 'string') throw new TypeError(`defaults.${field} must be a string when provided`);
  }
  const optional = (source) => Object.fromEntries(['antiAi', 'multiReply', 'proactive', 'imageStrategy', 'expressionMust']
    .filter((field) => source[field] !== undefined).map((field) => [field, source[field]]));
  if (selection === null || selection === undefined) {
    return {
      kernel: defaults.kernel,
      nonText: defaults.nonText,
      toneNudge: defaults.toneNudge,
      styleReset: defaults.styleReset,
      ownerCommands: defaults.ownerCommands,
      ownerTargets: defaults.ownerTargets,
      memoryWrite: defaults.memoryWrite,
      ...optional(defaults)
    };
  }
  if (typeof selection !== "object" || Array.isArray(selection)) {
    throw new TypeError("selection must be a non-null, non-array object when provided");
  }
  if (selection.enabled === false) {
    return {
      kernel: defaults.kernel,
      nonText: defaults.nonText,
      toneNudge: defaults.toneNudge,
      styleReset: defaults.styleReset,
      ownerCommands: defaults.ownerCommands,
      ownerTargets: defaults.ownerTargets,
      memoryWrite: defaults.memoryWrite,
      ...optional(defaults)
    };
  }
  if (selection.enabled !== true) {
    throw new TypeError("selection.enabled must be true or false when selection is provided");
  }
  if (typeof selection.roleName !== "string" || selection.roleName.trim().length === 0) {
    throw new TypeError("selection.roleName must be a nonempty string when enabled");
  }
  if (selection.roleName !== roleName) {
    throw new TypeError("selection.roleName must match roleName exactly");
  }
  if (typeof selection.kernel !== "string" || selection.kernel.trim().length === 0) {
    throw new TypeError("selection.kernel must be a nonempty string when enabled");
  }
  for (const field of ["nonText", "toneNudge", "styleReset", "ownerCommands", "ownerTargets", "memoryWrite"]) {
    if (typeof selection[field] !== "string") {
      throw new TypeError(`selection.${field} must be a string when enabled`);
    }
  }
  for (const field of ['antiAi', 'multiReply', 'proactive', 'imageStrategy', 'expressionMust']) {
    if (selection[field] !== undefined && typeof selection[field] !== 'string') throw new TypeError(`selection.${field} must be a string when provided`);
  }
  return {
    kernel: selection.kernel,
    nonText: selection.nonText,
    toneNudge: selection.toneNudge,
    styleReset: selection.styleReset,
    ownerCommands: selection.ownerCommands,
    ownerTargets: selection.ownerTargets,
    memoryWrite: selection.memoryWrite,
    ...optional(selection)
  };
}
