import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
// Operator-controlled installation references; no service path is inferred from HOME.
export function resolveDshInstallation(input) {
  if (!input) {
    try { input = JSON.parse(process.env.XI_OWNED_DSH_INSTALLATION_JSON ?? 'null'); }
    catch { throw new Error('OWNED_DSH_INSTALLATION_REQUIRED'); }
  }
  if (!input || Object.keys(input).some(key => !['root', 'forbiddenRoots'].includes(key)) ||
      !path.isAbsolute(String(input.root ?? '')) || !Array.isArray(input.forbiddenRoots) ||
      !input.forbiddenRoots.length || input.forbiddenRoots.some(value => !path.isAbsolute(String(value ?? ''))))
    throw new Error('OWNED_DSH_EXPLICIT_INSTALLATION_AND_FORBIDDEN_ROOTS_REQUIRED');
  const root = path.resolve(input.root);
  return Object.freeze({ root, forbiddenRoots: [...new Set(input.forbiddenRoots.map(value => path.resolve(value)))] });
}
export function checkedRoot(raw, installation) {
  installation = resolveDshInstallation(installation);
  if (!path.isAbsolute(String(raw ?? ''))) throw new Error('OWNED_DSH_ABSOLUTE_ROOT_REQUIRED');
  const root = path.resolve(raw), lower = root.toLowerCase();
  for (const blocked of [installation.root, ...installation.forbiddenRoots]) {
    const base = path.resolve(blocked).toLowerCase();
    if (lower === base || lower.startsWith(base + path.sep)) throw new Error('OWNED_DSH_EXISTING_SERVICE_ROOT_REJECTED');
  }
  if (root === path.parse(root).root) throw new Error('OWNED_DSH_VOLUME_ROOT_REJECTED');
  let cursor = path.parse(root).root;
  for (const part of root.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    if (fs.existsSync(cursor) && fs.lstatSync(cursor).isSymbolicLink()) throw new Error('OWNED_DSH_LINK_REJECTED');
  }
  return root;
}
export function initializeRoot(raw, installation) {
  const root = checkedRoot(raw, installation), marker = path.join(root, '.owned-dsh.json');
  fs.mkdirSync(root, { recursive: true });
  if (!fs.existsSync(marker)) {
    if (fs.readdirSync(root).length) throw new Error('OWNED_DSH_UNMARKED_NONEMPTY_ROOT');
    fs.writeFileSync(marker, JSON.stringify({ kind: 'xi-owned-dsh-v1', instanceId: randomUUID(), root }), { flag: 'wx' });
  }
  const metadata = JSON.parse(fs.readFileSync(marker, 'utf8'));
  if (metadata.kind !== 'xi-owned-dsh-v1' || path.resolve(metadata.root).toLowerCase() !== root.toLowerCase()) throw new Error('OWNED_DSH_ROOT_MARKER_INVALID');
  for (const name of ['home', 'logs', 'project']) fs.mkdirSync(path.join(root, name), { recursive: true });
  return { root, home: path.join(root, 'home'), logs: path.join(root, 'logs'), project: path.join(root, 'project'), metadata };
}
