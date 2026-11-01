import { randomUUID } from 'node:crypto';
import { createAccountingIpc, accountedStream } from './accounting-ipc.mjs';
export const name = 'owned-dsh-runtime-control';
export const inject = ['appReady', 'appExit', 'agents', 'agentPresets', 'tools', 'llm'];
export async function apply(ctx, config) {
  let inspection;
  const accounting = createAccountingIpc();
  ctx.effect(()=>()=>accounting.close());
  const stop = message => { if (message?.type === 'owned-dsh-stop') ctx.appExit(0); };
  process.on('message', stop);
  ctx.effect(() => () => process.off('message', stop));
  ctx.on('llm/stream', async function* (options, next) {
    if (!config.modelEnabled) throw new Error('OWNED_DSH_MODEL_NOT_ACTIVATED');
    if (options.provider !== config.provider || options.model !== config.model) throw new Error('OWNED_DSH_PROVIDER_NOT_SELECTED');
    process.send?.({ type: 'owned-dsh-model-attempt', provider: options.provider, model: options.model });
    yield* accountedStream(options,next,accounting,{maxOutput:config.maxOutput,enabled:config.accountingEnabled});
  });
  ctx.effect(() => ctx.appReady.onReady(() => {
    void (async () => {
      try {
        inspection = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: config.project, agentPreset: 'qq-chat' }, setup: agentCtx => ctx.agentPresets.mount(agentCtx, 'qq-chat').then(() => undefined) });
        const catalog = ctx.tools.schemas(inspection.agent);
        const inactiveQQ = config.verifyInactiveQQ ? await ctx.tools.execute({ callId: randomUUID(), name: 'mcp__snowluma__qq_status', arguments: {}, agent: inspection.agent, signal: AbortSignal.timeout(10000) }) : null;
        await inspection.dispose(); inspection = null;
        process.send?.({ type: 'owned-dsh-ready', catalog, inactiveQQ, presets: await ctx.agentPresets.list() });
      } catch (error) { process.send?.({ type: 'owned-dsh-start-error', message: error.message }); }
    })();
  }));
  ctx.effect(() => async () => { await inspection?.dispose(); });
}
