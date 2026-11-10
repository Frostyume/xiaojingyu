import { apply as originalGuard } from '../../upstream/integrations/dsh/agent-presets/qq-tool-restrict.mjs';
import { ASSET_DSH_NAMES,WORKSHOP_DSH_NAMES } from '../../assets-runtime/catalog.mjs';
import { WEB_TOOL_NAMES } from '../../web-runtime/catalog.mjs';
import { LIFE_TOOL_NAMES } from '../../life-runtime/context.mjs';
import { MAILBOX_TOOL_NAMES } from '../../coordinator-mailbox/catalog.mjs';
export const name = 'owned-qq-preset-boundary';
export const inject = ['tools'];
const MEMORY = new Set(['search', 'get', 'state', 'attachment'].map(x => 'mcp__xi-memory__xi_memory_' + x));
const WEB=WEB_TOOL_NAMES.map(name=>'mcp__xi-web__'+name);
const LIFE=LIFE_TOOL_NAMES.map(name=>'mcp__xi-life__'+name);
const MAILBOX=MAILBOX_TOOL_NAMES.map(name=>'mcp__xi-sister__'+name);
export async function apply(ctx, config) {
  const deadline = Date.now() + 20000;
  const groups = [
    ['QQ', true, ['mcp__snowluma__qq_status']],
    ['MEMORY', config.memory, MEMORY], ['ASSETS', config.assets, ASSET_DSH_NAMES],
    ['WORKSHOP', config.workshop, WORKSHOP_DSH_NAMES], ['WEB', config.web, WEB],
    ['LIFE', config.life, LIFE], ['MAILBOX', config.mailbox, MAILBOX]
  ];
  for (;;) {
    const missing = groups.filter(([, enabled, names]) => enabled && !Array.from(names).every(name => ctx.tools.get(name)));
    if (!missing.length) break;
    if (Date.now() >= deadline) throw new Error('OWNED_DSH_MCP_NOT_READY_' + missing.map(([group]) => group).join('_'));
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  // Explicit owned capability extension: these 15 named platform operations
  // include authorized publication. Do not borrow the old read-search prefix.
  originalGuard({tools:{restrict:options=>ctx.tools.restrict(options),guard:policy=>ctx.tools.guard(exec=>config.web&&WEB.includes(exec?.name)||config.life&&LIFE.includes(exec?.name)||config.mailbox&&MAILBOX.includes(exec?.name)?undefined:policy(exec))}});
  // Keep the authoritative execution policy and hide remaining inherited host
  // surfaces, including names introduced after its original deny list.
  const names = ctx.tools.schemas().map(t => t.name).filter(name => name.startsWith('mcp__snowluma__') || config.memory && MEMORY.has(name) || config.assets && ASSET_DSH_NAMES.includes(name) || config.workshop && WORKSHOP_DSH_NAMES.includes(name) || config.web && WEB.includes(name) || config.life && LIFE.includes(name) || config.mailbox && MAILBOX.includes(name));
  ctx.tools.restrict({ allow: names });
  const exact=new Set(names);ctx.tools.guard(exec=>exact.has(exec?.name)?undefined:'Tool is not in this owned runtime’s configured exact catalog');
}
