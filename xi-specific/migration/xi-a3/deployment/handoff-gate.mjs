// Owned sender activation gate. No stop/disable/restart, credential or health API.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { spawn } from 'node:child_process';

const here = path.dirname(fileURLToPath(import.meta.url));
const brands = new WeakSet();
const supported = new Set(['format', 'oldRuntimeRoot', 'oldTaskName', 'oldTaskPath', 'oldCorePort', 'oneBotEndpoint', 'newOwnedRoot', 'ownerLockPath']);

function fail(code, detail, report) {
  const error = new Error(detail); error.code = code;
  if (report) error.report = report;
  return error;
}

function noLinks(raw, { exists = true } = {}) {
  if (typeof raw !== 'string' || !path.isAbsolute(raw)) throw fail('ABSOLUTE_PATH_REQUIRED', 'Explicit absolute paths are required');
  const result = path.resolve(raw);
  for (let current = result;; current = path.dirname(current)) {
    if (fs.existsSync(current)) {
      const item = fs.lstatSync(current);
      if (item.isSymbolicLink() || item.isFile() && item.nlink !== 1) throw fail('LINK_REFUSED', 'Owned paths cannot traverse links or hardlinks');
    }
    if (current === path.dirname(current)) break;
  }
  if (exists && !fs.existsSync(result)) throw fail('PATH_MISSING', 'Registered directory is missing');
  return result;
}

function inside(parent, child) {
  const relative = path.relative(parent, child);
  return relative !== '' && relative !== '..' && !relative.startsWith('..' + path.sep) && !path.isAbsolute(relative);
}

export function validateHandoffPlan(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(k => !supported.has(k))) {
    throw fail('INVALID_HANDOFF_PLAN', 'Only the explicit handoff plan fields are accepted');
  }
  if (input.format !== 'xi-owned-handoff-plan-v1' || typeof input.oldTaskName !== 'string' || !input.oldTaskName.trim()
      || typeof input.oldTaskPath !== 'string' || !input.oldTaskPath.startsWith('\\')
      || !Number.isInteger(input.oldCorePort) || input.oldCorePort < 1 || input.oldCorePort > 65535) {
    throw fail('INVALID_HANDOFF_PLAN', 'Runtime/task/port/endpoint/owned-lock plan is incomplete');
  }
  const oldRuntimeRoot = noLinks(input.oldRuntimeRoot), newOwnedRoot = noLinks(input.newOwnedRoot);
  if (!fs.statSync(oldRuntimeRoot).isDirectory() || !fs.statSync(newOwnedRoot).isDirectory()
      || oldRuntimeRoot === newOwnedRoot || inside(oldRuntimeRoot, newOwnedRoot) || inside(newOwnedRoot, oldRuntimeRoot)) {
    throw fail('ROOTS_NOT_SEPARATE', 'Old and new owned roots must be separate directories');
  }
  const ownerLockPath = noLinks(input.ownerLockPath, { exists: false });
  if (!inside(newOwnedRoot, ownerLockPath) || !fs.statSync(noLinks(path.dirname(ownerLockPath))).isDirectory()) {
    throw fail('LOCK_OUTSIDE_OWNED_ROOT', 'Owner lock parent must exist inside the new owned root');
  }
  let endpoint;
  try { endpoint = new URL(input.oneBotEndpoint); } catch { throw fail('INVALID_ONEBOT_ENDPOINT', 'Explicit loopback OneBot endpoint required'); }
  if (!['ws:', 'wss:'].includes(endpoint.protocol) || !['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname)
      || !endpoint.port || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) {
    throw fail('INVALID_ONEBOT_ENDPOINT', 'Only an explicit loopback OneBot endpoint without credentials is supported');
  }
  const oneBotPort = Number(endpoint.port);
  if (!Number.isInteger(oneBotPort) || oneBotPort < 1 || oneBotPort > 65535) throw fail('INVALID_ONEBOT_ENDPOINT', 'Invalid OneBot port');
  return Object.freeze({ ...input, oldRuntimeRoot, newOwnedRoot, ownerLockPath,
    oneBotEndpoint: endpoint.href, oneBotPort });
}

export function assessHandoffObservation(observation, plan) {
  const blockers = [], warnings = [];
  const block = (code, detail, metadata = {}) => blockers.push({ code, detail, ...metadata });
  if (!observation || observation.format !== 'xi-owned-handoff-os-v1' || observation.status !== 'observed'
      || !Array.isArray(observation.errors) || observation.errors.length
      || !Array.isArray(observation.processes) || !Array.isArray(observation.listeners)
      || !Array.isArray(observation.qqClients) || !Array.isArray(observation.tasks)) {
    block('OS_PROBE_FAILED', 'Actual process/port/task observation is incomplete');
    return { allowed: false, blockers, warnings };
  }
  for (const item of observation.processes) {
    const roles = new Set(item.roles ?? []);
    if (['old_core', 'old_launcher', 'old_entry_host'].some(r => roles.has(r))) {
      block('OLD_ENTRY_ACTIVE', 'Old core/launcher/entry is still present', { pid: item.pid, roles: [...roles] });
    } else if (roles.has('runtime_path_process')) {
      const editor = ['notepad.exe', 'notepad++.exe', 'code.exe', 'wordpad.exe'].includes(String(item.name).toLowerCase());
      warnings.push({ code: 'PATH_MATCH_ONLY', pid: item.pid, classification: editor ? 'potential_manual_editor' : 'unknown_observer',
        detail: 'Not established as a writer. Recheck before cutover; never close it automatically.' });
    }
  }
  for (const item of observation.listeners) {
    if (item.port === plan.oldCorePort) block('OLD_CORE_PORT_ACTIVE', 'Old core port is still listening', { pid: item.pid });
  }
  for (const item of observation.qqClients) block('ONEBOT_CLIENT_PRESENT', 'An existing OneBot client may send', { pid: item.pid });
  const selected = observation.tasks.filter(t => t.name === plan.oldTaskName && t.taskPath === plan.oldTaskPath);
  if (selected.length !== 1) block('OLD_TASK_NOT_VERIFIED', 'Selected old task state was not observed exactly once');
  for (const item of observation.tasks) {
    if (typeof item.enabled !== 'boolean' || typeof item.state !== 'string') block('OLD_TASK_NOT_VERIFIED', 'Task enabled/state metadata is missing');
    else if (item.enabled || item.state === 'Running') block('OLD_AUTOMATIC_ENTRY_AVAILABLE', 'Old task is enabled or running', { task: item.name });
  }
  return { allowed: blockers.length === 0, blockers, warnings };
}

function actualProbe(plan, evidenceRequest = {}) {
  if (process.platform !== 'win32') return Promise.reject(fail('OS_PROBE_UNSUPPORTED', 'Production handoff requires the Windows OS probe'));
  const receipt = path.join(plan.oldRuntimeRoot, 'runtime.json');
  if (fs.existsSync(receipt)) {
    noLinks(receipt);
    if (fs.statSync(receipt).size > 1024 * 1024) return Promise.reject(fail('RECEIPT_TOO_LARGE', 'Runtime control receipt exceeds bound'));
  }
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(here, 'handoff-probe.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', rejected = false;
    const rejectOnce = error => { if (!rejected) { rejected = true; reject(error); } };
    const timer = setTimeout(() => { child.kill(); rejectOnce(fail('OS_PROBE_TIMEOUT', 'Read-only observer timed out; no service control was performed')); }, 45000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', value => {
      output += value;
      if (output.length > 1024 * 1024) { child.kill(); rejectOnce(fail('OS_PROBE_OUTPUT_LIMIT', 'Observer output exceeds bound')); }
    });
    child.stderr.resume(); // Never echo raw process output/command lines.
    child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); rejectOnce(fail('OS_PROBE_FAILED', 'Read-only OS observer could not start')); });
    child.on('close', code => {
      clearTimeout(timer);
      if (rejected) return;
      if (code !== 0) { rejectOnce(fail('OS_PROBE_FAILED', 'Read-only OS observer failed')); return; }
      try { resolve(JSON.parse(output.replace(/^\uFEFF/, ''))); }
      catch { rejectOnce(fail('OS_PROBE_FAILED', 'Read-only OS observer returned invalid metadata')); }
    });
    child.stdin.end(JSON.stringify({ ...plan, observerPid: process.pid,
      identitiesToInspect: evidenceRequest.identitiesToInspect ?? [], includeLineage: evidenceRequest.includeLineage === true }));
  });
}

async function checkedProbe(plan, probe, evidenceRequest = {}) {
  const observation = await probe(plan, evidenceRequest);
  const report = assessHandoffObservation(observation, plan);
  if (!report.allowed) throw fail('HANDOFF_BLOCKED', 'Existing sender/entry or incomplete OS evidence blocks activation', report);
  const identity = observation.observer;
  if (!identity || identity.pid !== process.pid || typeof identity.creationTimeUtc !== 'string'
      || !Number.isFinite(Date.parse(identity.creationTimeUtc))) {
    throw fail('OWNER_IDENTITY_UNVERIFIED', 'Current owner process creation identity was not verified');
  }
  return { observation, report, identity };
}

async function acquire(planInput, probe, productionEligible, recovery = null) {
  const plan = validateHandoffPlan(planInput);
  let latest = await checkedProbe(plan, probe);
  const ownerBootTimeUtc = latest.observation.bootTimeUtc ?? null;
  if (productionEligible && (!ownerBootTimeUtc || !Number.isFinite(Date.parse(ownerBootTimeUtc)))) {
    throw fail('BOOT_IDENTITY_UNVERIFIED', 'OS boot identity is required before creating a reservation');
  }
  const token = randomBytes(32).toString('hex');
  let handle;
  try { handle = fs.openSync(plan.ownerLockPath, 'wx', 0o600); }
  catch (error) {
    if (error.code === 'EEXIST') throw fail('OWNED_LOCK_EXISTS', 'Existing owner lock is never removed or automatically reclaimed');
    throw error;
  }
  const lockIdentity = fs.fstatSync(handle);
  const lock = { format: 'xi-owned-handoff-lock-v2', token, ownerPid: process.pid,
    ownerCreationTimeUtc: latest.identity.creationTimeUtc, acquiredAt: new Date().toISOString(),
    ownerBootTimeUtc, newOwnedRoot: plan.newOwnedRoot, oneBotEndpoint: plan.oneBotEndpoint, productionEligible,
    ownedChildren: [], childInventory: { format: 'xi-owned-child-journal-v1', complete: false, revision: 0,
      reason: 'No trusted invalidate-before-every-spawn adapter has sealed the complete child set' }, recovery };
  try { fs.writeFileSync(handle, JSON.stringify(lock, null, 2) + '\n'); fs.fsyncSync(handle); }
  finally { fs.closeSync(handle); }
  const resources = [];
  let state = 'open', closePromise = null, activationChecked = false;

  function assertLockOwned() {
    noLinks(plan.ownerLockPath);
    const meta = fs.statSync(plan.ownerLockPath);
    if (!meta.isFile() || meta.nlink !== 1 || meta.dev !== lockIdentity.dev || meta.ino !== lockIdentity.ino || meta.size > 1024 * 1024) {
      throw fail('OWNED_LOCK_CHANGED', 'Owner lock changed; no file will be removed');
    }
    let value;
    try { value = JSON.parse(fs.readFileSync(plan.ownerLockPath, 'utf8')); } catch { throw fail('OWNED_LOCK_CHANGED', 'Owner lock is no longer readable; no file will be removed'); }
    if (value.token !== token || value.ownerPid !== process.pid || value.ownerCreationTimeUtc !== lock.ownerCreationTimeUtc) {
      throw fail('OWNED_LOCK_CHANGED', 'Owner identity/token mismatch; no file will be removed');
    }
  }

  function persistOwnedJournal() {
    assertLockOwned();
    const fd = fs.openSync(plan.ownerLockPath, 'r+');
    try {
      const meta = fs.fstatSync(fd);
      if (meta.dev !== lockIdentity.dev || meta.ino !== lockIdentity.ino) throw fail('OWNED_LOCK_CHANGED', 'Owner lock changed before journal write');
      const bytes = Buffer.from(JSON.stringify(lock, null, 2) + '\n');
      fs.writeSync(fd, bytes, 0, bytes.length, 0); fs.ftruncateSync(fd, bytes.length); fs.fsyncSync(fd);
    } finally { fs.closeSync(fd); }
  }

  function releaseAfterDrain() {
    if (state === 'released') return { closed: true, released: true };
    if (!['closing', 'resources_closed'].includes(state) || resources.some(r => !r.closed)) {
      throw fail('RESOURCES_NOT_CLOSED', 'All registered resources must return a successful closed receipt before release');
    }
    assertLockOwned();
    fs.unlinkSync(plan.ownerLockPath); // Only this exact token/PID/creation/inode; never stale/other locks.
    state = 'released';
    return { closed: true, released: true };
  }

  const lease = Object.freeze({
    productionEligible,
    newOwnedRoot: plan.newOwnedRoot,
    ownerLockPath: plan.ownerLockPath,
    recovery,
    markOwnedChildrenUncertain(reason = 'owned-child change pending') {
      if (!['open'].includes(state)) throw fail('OWNER_CLOSING', 'Cannot update children of a closing owner');
      lock.childInventory.complete = false; lock.childInventory.revision += 1;
      lock.childInventory.reason = String(reason).slice(0, 200); persistOwnedJournal();
    },
    async recordOwnedChildren({ pids } = {}) {
      if (state !== 'open' || !Array.isArray(pids) || pids.some(pid => !Number.isInteger(pid) || pid <= 0 || pid === process.pid)) {
        throw fail('INVALID_CHILD_IDENTITIES', 'Explicit positive owned-child PIDs required');
      }
      lock.childInventory.complete = false; lock.childInventory.revision += 1; persistOwnedJournal();
      const observation = await probe(plan, { identitiesToInspect: [...new Set(pids)], includeLineage: true });
      if (observation?.format !== 'xi-owned-handoff-os-v1' || observation.status !== 'observed' || !Array.isArray(observation.errors)
          || observation.errors.length || !Array.isArray(observation.identityProcesses) || !Array.isArray(observation.lineageProcesses)) {
        throw fail('CHILD_IDENTITY_UNVERIFIED', 'Fresh OS child identity/tree observation failed; journal remains incomplete');
      }
      const lineage = new Map(observation.lineageProcesses.map(p => [p.pid, p]));
      for (const pid of new Set(pids)) {
        const rows = observation.identityProcesses.filter(p => p.pid === pid);
        if (rows.length !== 1 || rows[0].exists !== true || !Number.isFinite(Date.parse(rows[0].creationTimeUtc))) {
          throw fail('CHILD_IDENTITY_UNVERIFIED', 'Owned child was not positively observed; journal remains incomplete');
        }
        const child = rows[0]; let cursor = child; const seen = new Set();
        while (cursor && cursor.parentPid !== process.pid && !seen.has(cursor.pid)) { seen.add(cursor.pid); cursor = lineage.get(cursor.parentPid); }
        if (!cursor || cursor.parentPid !== process.pid || Date.parse(child.creationTimeUtc) < Date.parse(lock.ownerCreationTimeUtc)) {
          throw fail('CHILD_OWNERSHIP_UNVERIFIED', 'A live parent chain to this owner was not proven');
        }
        if (!lock.ownedChildren.some(p => p.pid === pid && p.creationTimeUtc === child.creationTimeUtc)) {
          lock.ownedChildren.push({ pid, creationTimeUtc: child.creationTimeUtc, parentPid: child.parentPid, role: 'verified-owned-descendant' });
        }
      }
      lock.childInventory.reason = 'Known identities recorded; dynamic child completeness is not certified';
      persistOwnedJournal();
      return { recorded: lock.ownedChildren.length, complete: false };
    },
    defer(name, dispose) {
      if (state !== 'open' || activationChecked || typeof name !== 'string' || !name.trim() || typeof dispose !== 'function'
          || resources.some(r => r.name === name)) throw fail('INVALID_RESOURCE_REGISTRATION', 'Register each owned resource once before activation');
      resources.push({ name, dispose, closed: false });
    },
    async assertForActivation({ newOwnedRoot } = {}) {
      if (!productionEligible) throw fail('SYNTHETIC_LEASE_NOT_PRODUCTION_ELIGIBLE', 'A test lease cannot authorize a real sender');
      if (state !== 'open' || !resources.length || noLinks(newOwnedRoot) !== plan.newOwnedRoot) {
        throw fail('INVALID_ACTIVATION_OWNER', 'Live owner, correct root and registered shutdown resource are required');
      }
      assertLockOwned();
      latest = await checkedProbe(plan, probe); // Actual production probe; never a JSON quiescent flag.
      if (state !== 'open') throw fail('OWNER_CLOSING', 'Owner closed while activation was being checked');
      assertLockOwned(); activationChecked = true;
      return { allowed: true, productionEligible: true, observedAt: latest.observation.createdAt,
        warnings: latest.report.warnings, barrierRequirement: 'The external old-entry freeze barrier must remain held' };
    },
    status() { return { state, productionEligible, activationChecked, childInventory: { ...lock.childInventory },
      resources: resources.map(r => ({ name: r.name, closed: r.closed })), warnings: latest.report.warnings }; },
    releaseAfterDrain,
    close() {
      if (state === 'released') return Promise.resolve({ closed: true, released: true, errors: [] });
      if (closePromise) return closePromise;
      state = 'closing';
      closePromise = (async () => {
        const errors = [];
        for (const resource of [...resources].reverse()) {
          if (resource.closed) continue;
          try {
            const receipt = await resource.dispose();
            if (!receipt || receipt.closed !== true || !Array.isArray(receipt.errors) || receipt.errors.length) {
              errors.push({ resource: resource.name, code: 'CLOSE_NOT_CONFIRMED' });
              break; // Earlier dependencies must remain available for the unfinished drain.
            } else resource.closed = true;
          } catch { errors.push({ resource: resource.name, code: 'CLOSE_FAILED' }); break; }
        }
        if (errors.length) { state = 'close_failed'; return { closed: false, released: false, lockHeld: true, errors }; }
        state = 'resources_closed';
        try { return { ...releaseAfterDrain(), errors: [] }; }
        catch { state = 'resources_closed'; return { closed: true, released: false, lockHeld: true, errors: [{ code: 'OWNED_LOCK_CHANGED' }] }; }
      })().finally(() => { closePromise = null; });
      return closePromise;
    },
  });
  brands.add(lease);
  try {
    const after = await checkedProbe(plan, probe); // Close acquisition window before any caller resource starts.
    if (after.identity.creationTimeUtc !== lock.ownerCreationTimeUtc) throw fail('OWNER_IDENTITY_CHANGED', 'OS owner identity changed during acquisition');
    latest = after;
    return lease;
  } catch (error) {
    await lease.close(); // No caller resource was exposed/started yet. Only this process's own empty lock may release.
    throw error;
  }
}

export function isOwnedHandoffLease(value) { return value !== null && typeof value === 'object' && brands.has(value); }

export async function acquireOwnedHandoff(options) {
  if (!options || Object.keys(options).some(k => k !== 'plan')) throw fail('INVALID_HANDOFF_OPTIONS', 'Production gate accepts only a plan; probe injection is prohibited');
  return acquire(options.plan, actualProbe, true);
}

// Dedicated test seam. Its brand is real, but productionEligible:false and activation always rejects.
export async function acquireSyntheticHandoffForTests({ plan, probe }) {
  if (typeof probe !== 'function') throw fail('TEST_PROBE_REQUIRED', 'Explicit pure fake probe required');
  return acquire(plan, probe, false);
}

function abandonedSnapshot(plan, productionEligible) {
  noLinks(plan.ownerLockPath);
  const before = fs.statSync(plan.ownerLockPath, { bigint: true });
  if (!before.isFile() || before.nlink !== 1n || before.size > 1048576n) throw fail('ABANDONED_LOCK_INVALID', 'Abandoned lock is not a bounded plain file');
  const bytes = fs.readFileSync(plan.ownerLockPath);
  const after = fs.statSync(plan.ownerLockPath, { bigint: true });
  if (before.ino !== after.ino || before.size !== after.size || before.mtimeNs !== after.mtimeNs) throw fail('ABANDONED_LOCK_CHANGED', 'Lock changed while reading');
  let lock; try { lock = JSON.parse(bytes.toString('utf8')); } catch { throw fail('ABANDONED_LOCK_INVALID', 'Control lock is not readable'); }
  if (lock.format !== 'xi-owned-handoff-lock-v2' || lock.newOwnedRoot !== plan.newOwnedRoot || lock.oneBotEndpoint !== plan.oneBotEndpoint
      || !/^[a-f0-9]{64}$/.test(lock.token ?? '') || !Number.isInteger(lock.ownerPid) || lock.ownerPid <= 0
      || ![lock.ownerCreationTimeUtc, lock.acquiredAt, lock.ownerBootTimeUtc].every(s => typeof s === 'string' && Number.isFinite(Date.parse(s)))
      || !Array.isArray(lock.ownedChildren) || lock.childInventory?.format !== 'xi-owned-child-journal-v1'
      || productionEligible && lock.productionEligible !== true) {
    throw fail('ABANDONED_EVIDENCE_INSUFFICIENT', 'Legacy/unknown/incomplete lock identity requires explicit operator review; age is not evidence');
  }
  if (Date.parse(lock.ownerBootTimeUtc) > Date.parse(lock.ownerCreationTimeUtc) || Date.parse(lock.ownerCreationTimeUtc) > Date.parse(lock.acquiredAt)) {
    throw fail('ABANDONED_EVIDENCE_INSUFFICIENT', 'Recorded boot/process/lock times conflict');
  }
  for (const child of lock.ownedChildren) if (!Number.isInteger(child.pid) || child.pid <= 0 || child.pid === lock.ownerPid
      || !Number.isFinite(Date.parse(child.creationTimeUtc))) throw fail('ABANDONED_EVIDENCE_INSUFFICIENT', 'Owned child identity is incomplete');
  return { lock, bytes, inode: before.ino.toString(), sha256: createHash('sha256').update(bytes).digest('hex') };
}

function verifyAbandonedProcesses(snapshot, observation) {
  const { lock } = snapshot;
  const boot = Date.parse(observation.bootTimeUtc);
  if (!Number.isFinite(boot) || !Array.isArray(observation.identityProcesses) || !Array.isArray(observation.lineageProcesses)) {
    throw fail('ABANDONED_EVIDENCE_INSUFFICIENT', 'Fresh boot and requested process identity observations are required');
  }
  if (boot > Date.parse(observation.observer?.creationTimeUtc) || Date.parse(observation.observer?.creationTimeUtc) > Date.parse(observation.createdAt)) {
    throw fail('ABANDONED_EVIDENCE_INSUFFICIENT', 'Fresh OS boot/process/observation times conflict');
  }
  const identities = [{ pid: lock.ownerPid, creationTimeUtc: lock.ownerCreationTimeUtc, owner: true }, ...lock.ownedChildren];
  for (const identity of identities) {
    const found = observation.identityProcesses.filter(p => p.pid === identity.pid);
    if (found.length !== 1 || typeof found[0].exists !== 'boolean' || found[0].exists && !Number.isFinite(Date.parse(found[0].creationTimeUtc))) {
      throw fail('ABANDONED_EVIDENCE_INSUFFICIENT', 'A requested old process identity is unknown');
    }
    if (found[0].exists && Date.parse(found[0].creationTimeUtc) === Date.parse(identity.creationTimeUtc)) {
      throw fail(identity.owner ? 'ABANDONED_OWNER_STILL_ALIVE' : 'ABANDONED_CHILD_STILL_ALIVE', 'Recorded exact process identity is still alive; nothing will be killed');
    }
  }
  const newerBoot = boot > Date.parse(lock.acquiredAt) && boot > Date.parse(lock.ownerBootTimeUtc);
  if (!newerBoot) {
    if (boot !== Date.parse(lock.ownerBootTimeUtc) || lock.childInventory.complete !== true
        || lock.childInventory.spawnBarrierContract !== 'invalidate-before-every-child-spawn') {
      throw fail('OWNED_CHILD_SET_NOT_COMPLETE', 'Same-boot recovery requires a trusted complete child journal; current default journal is incomplete');
    }
    const parents = new Set([lock.ownerPid, ...lock.ownedChildren.map(p => p.pid)]);
    for (const item of observation.lineageProcesses) if (parents.has(item.parentPid)) {
      if (!Number.isFinite(Date.parse(item.creationTimeUtc))) throw fail('ABANDONED_EVIDENCE_INSUFFICIENT', 'A possible descendant creation identity is unknown');
      if (Date.parse(item.creationTimeUtc) >= Date.parse(lock.ownerCreationTimeUtc)) throw fail('POSSIBLE_OWNED_DESCENDANT_ALIVE', 'A current descendant candidate remains; identity lineage is not cleared');
    }
  }
  return { basis: newerBoot ? 'fresh-system-boot-after-original-lock' : 'same-boot-complete-child-journal', exactOldIdentitiesGone: true };
}

function archiveExactLock(plan, snapshot, archivePath) {
  if (process.platform !== 'win32') return Promise.reject(fail('ATOMIC_ARCHIVE_UNSUPPORTED', 'Recovery requires Windows exclusive handle archival'));
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File',
      path.join(here, 'archive-owned-lock.ps1')], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    let output = '', done = false;
    const rejectOnce = () => { if (!done) { done = true; reject(fail('ATOMIC_ARCHIVE_REFUSED', 'Exclusive identity/hash check or archival failed; do not remove any lock manually')); } };
    const timer = setTimeout(() => { child.kill(); rejectOnce(); }, 45000);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', data => { output += data; if (output.length > 65536) { child.kill(); rejectOnce(); } });
    child.stderr.resume(); child.stdin.on('error', () => {});
    child.on('error', () => { clearTimeout(timer); rejectOnce(); });
    child.on('close', code => {
      clearTimeout(timer); if (done) return;
      try {
        const result = JSON.parse(output.replace(/^\uFEFF/, ''));
        if (code !== 0 || result.archived !== true || result.sha256 !== snapshot.sha256) throw new Error();
        done = true; resolve(result);
      } catch { rejectOnce(); }
    });
    child.stdin.end(JSON.stringify({ lockPath: plan.ownerLockPath, archivePath, expectedSha256: snapshot.sha256, expectedInode: snapshot.inode }));
  });
}

async function recoverAbandoned(planInput, reason, probe, productionEligible, beforeArchive) {
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 200) throw fail('EXPLICIT_RECOVERY_REASON_REQUIRED', 'Trusted startup must explicitly request recovery with a short reason');
  const plan = validateHandoffPlan(planInput);
  const snapshot = abandonedSnapshot(plan, productionEligible);
  const request = { identitiesToInspect: [...new Set([snapshot.lock.ownerPid, ...snapshot.lock.ownedChildren.map(p => p.pid)])], includeLineage: true };
  let checked = await checkedProbe(plan, probe, request);
  verifyAbandonedProcesses(snapshot, checked.observation);
  // Refresh a second time immediately before the exclusive archive transaction.
  checked = await checkedProbe(plan, probe, request);
  const evidence = verifyAbandonedProcesses(snapshot, checked.observation);
  if (beforeArchive) await beforeArchive(); // Test-only race seam; never exposed by production API.
  const archivePath = plan.ownerLockPath + '.abandoned.' + randomBytes(16).toString('hex') + '.json';
  await archiveExactLock(plan, snapshot, archivePath);
  // If another legitimate launcher wins wx now, leave its lock untouched and retain the old archive.
  return acquire(planInput, probe, productionEligible, { archivePath, originalSha256: snapshot.sha256,
    reason, basis: evidence.basis, recoveredAt: new Date().toISOString() });
}

export async function recoverAbandonedOwnedLease(options) {
  if (!options || Object.keys(options).some(k => !['plan', 'reason'].includes(k))) {
    throw fail('INVALID_RECOVERY_OPTIONS', 'Production recovery accepts only plan and explicit reason; no JSON/probe unlock');
  }
  return recoverAbandoned(options.plan, options.reason, actualProbe, true);
}

export async function recoverSyntheticAbandonedOwnedLeaseForTests({ plan, reason, probe, beforeArchive }) {
  if (typeof probe !== 'function') throw fail('TEST_PROBE_REQUIRED', 'Explicit pure fake probe required');
  return recoverAbandoned(plan, reason, probe, false, beforeArchive);
}

// Snapshot adapter's read-only entry. No lock acquisition/recovery and no injectable evidence.
export async function inspectFrozenSourceForSnapshot(options) {
  if (!options || Object.keys(options).some(k => k !== 'plan')) throw fail('INVALID_HANDOFF_OPTIONS', 'Snapshot observer accepts only an explicit plan');
  const plan = validateHandoffPlan(options.plan);
  const checked = await checkedProbe(plan, actualProbe);
  return { format: 'xi-stopped-source-observation-v1', allowed: true, observedAt: checked.observation.createdAt,
    bootTimeUtc: checked.observation.bootTimeUtc, observer: checked.identity, warnings: checked.report.warnings,
    actualOsProbe: true, scope: 'Known old entry/task/port and OneBot clients; external write barrier must remain held' };
}
