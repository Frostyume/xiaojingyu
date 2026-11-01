// Process-local immutable policy. Changes require a new process, never a UI toggle.
import { createRuntimePolicy, resolveRuntimeMode } from './runtime-policy.mjs';
export const runtimePolicy = createRuntimePolicy({ mode: resolveRuntimeMode(process.env) });
