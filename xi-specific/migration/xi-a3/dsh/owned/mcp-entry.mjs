import { parseArgs } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { checkedRoot } from './paths.mjs';
const { values } = parseArgs({ options: { root: { type: 'string' }, entry: { type: 'string' }, db: { type: 'string' }, 'approved-root': { type: 'string' } }, strict: true });
const root = checkedRoot(values.root);
const marker = JSON.parse(fs.readFileSync(path.join(root, '.owned-dsh.json'), 'utf8'));
if (marker.kind !== 'xi-owned-dsh-v1') throw new Error('OWNED_MCP_ROOT_MARKER_REQUIRED');
fs.appendFileSync(path.join(root, 'mcp-pids.jsonl'), JSON.stringify({ pid: process.pid, parentPid: process.ppid, role: values.entry, at: new Date().toISOString() }) + '\n');
const ownershipGate=()=>{
  try{const lock=JSON.parse(fs.readFileSync(path.join(root,'owner.lock'),'utf8'));if(lock.instanceId!==marker.instanceId||path.resolve(lock.root)!==root||!Number.isSafeInteger(lock.supervisorPid))return false;process.kill(lock.supervisorPid,0);return true;}catch{return false;}
};
if (values.entry === 'qq') await import('../../upstream/mcp/qq-actions.js');
else if (values.entry === 'memory') {
  const { startXiMemoryStdio } = await import('../../../xi-a2/memory/stdio.mjs');
  await startXiMemoryStdio(['--db', values.db, '--approved-root', values['approved-root']]);
} else if(values.entry==='assets'){
  const config=JSON.parse(fs.readFileSync(path.join(root,'assets-paths.json'),'utf8'));
  const {resolveOwnedRuntimePaths}=await import('../../upstream/runtime/kernel/xi/owned-paths.mjs');
  resolveOwnedRuntimePaths(config);
  const {startAssetsStdio}=await import('../../assets-runtime/stdio.mjs');
  await startAssetsStdio({paths:config.paths,mainPaths:config,ownershipGate});
} else if(values.entry==='web'){
  const config=JSON.parse(fs.readFileSync(path.join(root,'web-paths.json'),'utf8'));
  const {resolveOwnedRuntimePaths}=await import('../../upstream/runtime/kernel/xi/owned-paths.mjs');const main=resolveOwnedRuntimePaths(config.main);
  delete process.env.XI_OWNED_WEB_CREDENTIALS;
  const {startOwnedWebStdio}=await import('../../web-runtime/stdio.mjs');
  await startOwnedWebStdio({parentProxy:{main,ownershipGate}});
} else if(values.entry==='mailbox'){
  const config=JSON.parse(fs.readFileSync(path.join(root,'mailbox-paths.json'),'utf8'));
  const {startMailboxStdio}=await import('../../coordinator-mailbox/stdio.mjs');
  await startMailboxStdio({main:config.main,ownershipGate});
} else if(values.entry==='life'){
  const config=JSON.parse(fs.readFileSync(path.join(root,'life-paths.json'),'utf8'));
  const {startRetainedLifeStdio}=await import('../../life-runtime/stdio.mjs');
  await startRetainedLifeStdio({paths:config.paths,identity:config.identity,ownershipGate});
} else throw new Error('OWNED_MCP_ENTRY_REJECTED');
