import path from 'node:path';

const validId = (value) => typeof value === 'string' && /^\d{5,15}$/.test(value);
function ids(values, label) {
  if (!Array.isArray(values) || !values.every(validId)) throw new Error('Invalid ' + label);
  return [...new Set(values)];
}
function loopback(value, protocol) {
  const url = new URL(value);
  if (url.protocol !== protocol || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || !['', '/'].includes(url.pathname)) throw new Error('Explicit credential-free loopback origin required');
  return url.origin;
}
function credentialFree(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(apiKey|accessToken|wsAccessToken|authToken|token|password|secret)$/i.test(key) && typeof child === 'string' && child) throw new Error('Configuration preparation accepts references, not credentials');
    credentialFree(child);
  }
}

/** Pure preparation. This does not open stores, resolve secrets, connect or activate. */
export function buildOwnedConfig({ base, inputs, profile, bridgeRoot, dshOrigin, providerSelector, providerSpec, consolePort } = {}) {
  credentialFree(base); credentialFree(providerSpec);
  if (inputs?.format !== 'xi-owned-private-inputs-v1' || inputs.http_verified_account !== true || !validId(inputs.account_id) || !validId(inputs.owner_id)) throw new Error('Verified private connection metadata required');
  if (typeof bridgeRoot !== 'string' || !path.isAbsolute(bridgeRoot)) throw new Error('Explicit absolute bridge root required');
  if (!Number.isInteger(consolePort) || consolePort < 1024 || consolePort > 65535 || consolePort === Number(new URL(dshOrigin).port)) throw new Error('Distinct valid console and DSH ports required');
  if (typeof providerSelector !== 'string' || !providerSelector || providerSpec?.model !== inputs.provider.model) throw new Error('Explicit preserved model and catalog provider required');
  if (!profile?.card || !profile.xiIdentity?.enabled || typeof profile.roleName !== 'string' || !profile.roleName.trim() || profile.xiIdentity.roleName !== profile.roleName || !Array.isArray(profile.wakeKeywords) || !profile.wakeKeywords.length) throw new Error('Approved Xi profile adapter required');
  const guardians = ids(inputs.guardian_ids, 'guardian IDs');
  const friends = ids(inputs.friend_ids, 'current friend IDs');
  const groups = ids(inputs.configured_group_ids, 'enabled group IDs');
  const peerBots = ids(inputs.peer_bot_ids, 'peer bot IDs');
  const quiet = inputs.quiet_hours;
  if (!quiet || ![quiet.start, quiet.end].every(x => typeof x === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(x))) throw new Error('Explicit quiet hours required');
  const cfg = structuredClone(base);
  cfg.ownerQQ = Number(inputs.owner_id);
  cfg.allow = { groups, private: [...new Set([...guardians, ...(inputs.friend_private_enabled ? friends : [])])].filter(x => x !== inputs.account_id) };
  cfg.allowAllWhenEmpty = false;
  cfg.snowluma = { ...cfg.snowluma, wsUrl: loopback(inputs.ws_origin, 'ws:'), httpUrl: loopback(inputs.http_origin, 'http:'),
    accessToken: '', followDiscoveredEndpoint: false, launcherPath: '', homeDir: '' };
  cfg.dsh = { ...cfg.dsh, baseUrl: loopback(dshOrigin, 'http:'), provider: providerSelector, model: providerSpec.model,
    reasoningEffort: providerSpec.reasoningEffort ?? providerSpec.reasoning ?? 'off', authToken: '', allowRemote: false };
  cfg.agentPreset = 'qq-chat';
  cfg.consolePort = consolePort;
  cfg.consoleAuth = { ...cfg.consoleAuth, enabled: true };
  cfg.consoleToken = ''; // Owned launcher supplies/generates the private token; none exported here.
  cfg.storage = { ...cfg.storage, enabled: true, dbPath: 'state/db/bridge.db', backupDir: path.join(bridgeRoot, 'backups') };
  cfg.sessionCwd = path.join(bridgeRoot, 'workspace');
  cfg.xiIdentity = structuredClone(profile.xiIdentity);
  cfg.role = { ...cfg.role, maxInjectChars: Math.max(16000, profile.card.length + 1000) };
  cfg.simulation = { ...cfg.simulation, enabled: true, agentPreset: 'qq-chat',
    nightQuiet: { enabled: true, start: quiet.start, end: quiet.end },
    wake: { ...cfg.simulation.wake, recommendedKeywords: [...profile.wakeKeywords] },
    send: { ...cfg.simulation.send, recommendedHint: '按内容决定一条还是几条，每条保留完整意思；对象清楚时不必引用。不要为了显得活泼而刷屏。' },
    imageLibrary: { ...cfg.simulation.imageLibrary, dir: path.join(bridgeRoot, 'images') },
    voice: { ...cfg.simulation.voice, dir: path.join(bridgeRoot, 'audio') } };
  return { config: cfg, identities: { botId: inputs.account_id, guardianIds: guardians, peerBotIds: peerBots },
    canonicalPaths: structuredClone(inputs.canonical_paths), credentialReferences: structuredClone(inputs.credential_references),
    providerSpec: structuredClone(providerSpec), budgetPolicy: structuredClone(inputs.budget_cny),
    profileSource: structuredClone(profile.source), activated: false,
    notes: ['No secrets in this object; trusted launcher resolves explicit references into memory.',
      'Original enabled groups and current friends are preserved. Future friend changes need the admission adapter.',
      'Original budget and historical usage must be carried; null limits are not replaced with historical defaults.',
      'Original assets/workroom/life abilities still require actual adapters; this config alone does not migrate them.'] };
}
