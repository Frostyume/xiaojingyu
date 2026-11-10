import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
function modelInputModalities(provider) {
  // Capability declaration for this exact route/model; no private acceptance proof is bundled.
  // Do not infer another model's vision capability from its family/protocol name.
  return provider.kind === 'openai-completions' && provider.route === 'qiniu-conatus'
    && provider.baseURL === 'https://api.qnaigc.com/v1' && provider.model === 'deepseek/deepseek-v4.1-flash-1017'
    ? ['text', 'image'] : ['text'];
}
export function validateProvider(spec = {}) {
  const kind = spec.kind ?? 'deepseek-messages';
  if (!['deepseek-messages', 'openai-completions'].includes(kind)) throw new Error('OWNED_DSH_NATIVE_PROVIDER_KIND_REQUIRED');
  const route = kind === 'deepseek-messages' ? 'deepseek-official' : spec.route;
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(route ?? '') || typeof spec.model !== 'string' || !spec.model) throw new Error('OWNED_DSH_PROVIDER_AND_MODEL_REQUIRED');
  const url = new URL(spec.baseURL);
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('OWNED_DSH_PROVIDER_URL_INVALID');
  const maxTokens = spec.maxTokens ?? 1024;
  if (!Number.isSafeInteger(maxTokens) || maxTokens < 1) throw new Error('OWNED_DSH_MODEL_MAX_TOKENS_INVALID');
  return { kind, route, baseURL: url.href.replace(/\/+$/, ''), model: spec.model, maxTokens, reasoning: spec.reasoning ?? 'off' };
}
export function writeProfile({ paths, main, provider, modelActive, httpActive, memoryPaths, assetsPaths = null, webPaths = null, webIdentity = null, webManifest = null, lifePaths = null, lifeIdentity = null, personaPrefix, verifyInactiveQQ = false, accountingEnabled = false }) {
  const profile = 'xi-owned-web', dir = path.join(paths.home, 'profiles', profile);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'xi-owned-dsh', private: true, dependencies: {}, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }, null, 2));
  const disabled = ['session-title-llm', 'llm-retry', 'llm-deepseek', 'llm-deepseek-account', 'llm-pi-ai', 'deepseek-account', 'account-controller', 'web-search-deepseek', 'web-deepseek-api', 'session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics', 'plugin-manager', 'hmr', 'preset-standard', 'preset-minimal', 'preset-ptc', 'preset-cordis'];
  const patches = disabled.map(id => ({ id, disabled: true }));
  patches.push({ id: 'agent-preset-registry', config: { default: 'qq-chat' } });
  patches.push({ id: 'agent-default-model', config: { provider: provider.route, model: provider.model } });
  if (modelActive && provider.kind === 'deepseek-messages') {
    const row = patches.find(x => x.id === 'llm-deepseek'); row.disabled = false;
    row.config = { baseURL: provider.baseURL, apiKeyEnv: 'XI_OWNED_PROVIDER_KEY', maxTokens: provider.maxTokens, thinking: provider.reasoning === 'off' ? 'disabled' : 'enabled', reasoningEffort: provider.reasoning, models: [{ id: provider.model, maxTokens: provider.maxTokens }], retryPolicy: { mode: 'normal', maxRetries: 0 } };
  } else if (modelActive) {
    const row = patches.find(x => x.id === 'llm-pi-ai'); row.disabled = false;
    row.config = { providers: { [provider.route]: { api: 'openai-completions', baseURL: provider.baseURL, apiKeyEnv: 'XI_OWNED_PROVIDER_KEY',
      models: [{ id: provider.model, input: modelInputModalities(provider), maxTokens: provider.maxTokens, reasoningEfforts: { off: 'off', high: 'high' } }],
      compat: { maxTokensField: 'max_tokens', supportsUsageInStreaming: true, supportsDeveloperRole: false, supportsStore: false, thinkingFormat: 'deepseek' },
      reasoning: provider.reasoning, retryPolicy: { mode: 'normal', maxRetries: 0 } } } };
  }
  const noProviderKey = { XI_OWNED_PROVIDER_KEY: '',XI_OWNED_WEB_CREDENTIALS:'' };
  const rows = [
    { id: 'owned-qq-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'stdio', serverName: 'snowluma', command: process.execPath,
      args: [path.join(HERE, 'mcp-entry.mjs'), '--root', paths.root, '--entry', 'qq'], cwd: paths.project, env: {
        ...noProviderKey, XI_RUNTIME_MODE: 'owned', XI_OWNED_BRIDGE_ROOT: main.bridgeRoot, XI_OWNED_CONFIG_FILE: main.configFile, XI_OWNED_STATE_DIR: main.stateDir,
        XI_OWNED_CONSOLE_PORT: String(main.consolePort), XI_OWNED_QQ_HTTP_ENABLED: httpActive ? '1' : '0'
      }, failOnStartupError: true, toolCallTimeoutMs: 725000, reconnect: { enabled: false } } }
  ];
  if (memoryPaths) rows.push({ id: 'owned-memory-mcp', name: '@deepseek-ai/dsh-mcp-client', config: { transport: 'stdio', serverName: 'xi-memory', command: process.execPath,
    args: [path.join(HERE, 'mcp-entry.mjs'), '--root', paths.root, '--entry', 'memory', '--db', memoryPaths.db, '--approved-root', memoryPaths.approvedRoot],
    env: { ...noProviderKey, XI_OWNED_QQ_HTTP_TOKEN: '' }, cwd: paths.project, failOnStartupError: true, toolCallTimeoutMs: 30000, reconnect: { enabled: false } } });
  if(assetsPaths){
    fs.writeFileSync(path.join(paths.root,'assets-paths.json'),JSON.stringify({paths:assetsPaths,bridgeRoot:main.bridgeRoot,configFile:main.configFile,consolePort:main.consolePort},null,2));
    rows.push({id:'owned-assets-mcp',name:'@deepseek-ai/dsh-mcp-client',config:{transport:'stdio',serverName:'snowluma-host',command:process.execPath,
      args:[path.join(HERE,'mcp-entry.mjs'),'--root',paths.root,'--entry','assets'],env:{...noProviderKey,XI_OWNED_QQ_HTTP_TOKEN:''},cwd:paths.project,failOnStartupError:true,toolCallTimeoutMs:30000,reconnect:{enabled:false}}});
  }
  if(webPaths){
    fs.writeFileSync(path.join(paths.root,'web-paths.json'),JSON.stringify({paths:webPaths,identity:webIdentity,manifest:webManifest,main:{bridgeRoot:main.bridgeRoot,configFile:main.configFile,consolePort:main.consolePort}},null,2));
    rows.push({id:'owned-web-mcp',name:'@deepseek-ai/dsh-mcp-client',config:{transport:'stdio',serverName:'xi-web',command:process.execPath,
      args:[path.join(HERE,'mcp-entry.mjs'),'--root',paths.root,'--entry','web'],env:{...noProviderKey,XI_OWNED_QQ_HTTP_TOKEN:''},cwd:paths.project,failOnStartupError:true,toolCallTimeoutMs:120000,reconnect:{enabled:false}}});
  }
  if(lifePaths){
    fs.writeFileSync(path.join(paths.root,'life-paths.json'),JSON.stringify({paths:lifePaths,identity:lifeIdentity},null,2));
    rows.push({id:'owned-life-mcp',name:'@deepseek-ai/dsh-mcp-client',config:{transport:'stdio',serverName:'xi-life',command:process.execPath,args:[path.join(HERE,'mcp-entry.mjs'),'--root',paths.root,'--entry','life'],env:{...noProviderKey,XI_OWNED_QQ_HTTP_TOKEN:''},cwd:paths.project,failOnStartupError:true,toolCallTimeoutMs:30000,reconnect:{enabled:false}}});
  }
  fs.writeFileSync(path.join(paths.root,'mailbox-paths.json'),JSON.stringify({main:{bridgeRoot:main.bridgeRoot,configFile:main.configFile,stateDir:main.stateDir,consolePort:main.consolePort}},null,2));
  rows.push({id:'owned-mailbox-mcp',name:'@deepseek-ai/dsh-mcp-client',config:{transport:'stdio',serverName:'xi-sister',command:process.execPath,
    args:[path.join(HERE,'mcp-entry.mjs'),'--root',paths.root,'--entry','mailbox'],env:{...noProviderKey,XI_OWNED_QQ_HTTP_TOKEN:''},cwd:paths.project,failOnStartupError:true,toolCallTimeoutMs:30000,reconnect:{enabled:false}}});
  rows.push({ id: 'owned-qq-preset', name: '@deepseek-ai/dsh-agent-preset', config: { id: 'qq-chat', order: 0, plugins: [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { prefix: personaPrefix + "\n聊 B 站评论时按对方这次问的来。比如叫你挑两人的一句来回，像群友那样说「甲说‘……’，乙回他‘……’，这俩是在接梗呀」，到这里就够了。追问刚才是谁，再用名字指回那一对，原话可以省。问本页条数，用工具的 sample 顺口算一次；问到平台数或画面声音，各答一次就收，别用标题、列表把同一个意思再讲一遍。若问完整接龙、不同观点或要求清单，就把相关楼层按实际关系展开。", complete: true, includeRuntimeContext: false } },
    { id: 'qq-guard', name: new URL('./preset-guard.mjs', import.meta.url).href, config: { memory: Boolean(memoryPaths), assets: Boolean(assetsPaths), workshop: Boolean(assetsPaths?.workshop), web: Boolean(webPaths), life: Boolean(lifePaths), mailbox:true } }
  ] } });
  rows.push({ id: 'owned-runtime-control', name: new URL('./runtime.mjs', import.meta.url).href, config: { modelEnabled: modelActive, provider: provider.route, model: provider.model, project: paths.project, maxOutput: provider.maxTokens, verifyInactiveQQ, accountingEnabled } });
  patches.push({ insert: rows });
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), JSON.stringify(patches, null, 2));
  return { profile, dir };
}
