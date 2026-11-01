import fs from 'node:fs';
import path from 'node:path';

let configured;
function rejectLinks(target) {
  const absolute = path.resolve(target), root = path.parse(absolute).root;
  let cursor = root;
  for (const part of absolute.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('Owned runtime paths cannot traverse links');
  }
}
function inside(root, target) {
  const rel = path.relative(root, target);
  return rel && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** Validates explicitly supplied configuration/state paths, not activation. */
export function resolveOwnedRuntimePaths({ bridgeRoot, configFile, stateDir, personasDir, consolePort } = {}) {
  if (!path.isAbsolute(String(bridgeRoot ?? '')) || !path.isAbsolute(String(configFile ?? ''))) throw new Error('Explicit absolute owned bridgeRoot and configFile required');
  rejectLinks(bridgeRoot); rejectLinks(configFile);
  const root = fs.realpathSync(bridgeRoot), config = path.resolve(configFile);
  if (!fs.statSync(root).isDirectory() || !inside(root, config)) throw new Error('Owned configFile must be inside the explicit owned bridge root');
  const markerPath = path.join(root, '.xi-owned-runtime.json'); rejectLinks(markerPath);
  if (!fs.statSync(markerPath).isFile()) throw new Error('Owned runtime configuration marker required');
  const marker = JSON.parse(fs.readFileSync(markerPath, 'utf8'));
  if (marker.kind !== 'xi-owned-runtime-v1' || typeof marker.runtimeId !== 'string' || !marker.runtimeId || path.resolve(marker.bridgeRoot).toLowerCase() !== root.toLowerCase()) throw new Error('Invalid explicit owned runtime marker');
  if (!fs.statSync(config).isFile()) throw new Error('Owned configuration must be a regular file');
  const state = path.resolve(stateDir ?? path.join(root, 'state'));
  const personas = path.resolve(personasDir ?? path.join(root, 'personas'));
  for (const target of [state, personas]) { rejectLinks(target); if (!inside(root, target)) throw new Error('Owned bridge state/assets must remain within the explicit bridge root'); }
  if (consolePort !== undefined && (!Number.isInteger(Number(consolePort)) || Number(consolePort) < 1 || Number(consolePort) > 65535)) throw new Error('Invalid actual owned console port');
  return Object.freeze({ bridgeRoot: root, configFile: config, stateDir: state, personasDir: personas, runtimeId: marker.runtimeId,
    fixture: marker.fixture === true, ...(consolePort === undefined ? {} : { consolePort: Number(consolePort) }) });
}

export function configureOwnedRuntimePaths(paths) {
  const next = resolveOwnedRuntimePaths(paths);
  if (configured && JSON.stringify(configured) !== JSON.stringify(next)) throw new Error('Owned runtime paths are immutable within a process');
  configured = next; return configured;
}
export function getConfiguredOwnedRuntimePaths() {
  if (!configured) throw new Error('Configure explicit owned runtime paths before importing main');
  return configured;
}
