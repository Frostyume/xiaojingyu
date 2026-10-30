// 模型 / effort 路由与 fallback（纯函数）。
//
// 解析顺序（先命中先用）：
//   1. 群级覆盖：socialV2.groupProfiles[key].model
//   2. 任务档位：routing.tiers[<chat|reflection|research>]
//   3. 备用链路：routing.fallback[]（provider 故障/模型下线时降级）
//   4. 基础配置：dsh.provider / dsh.model / dsh.reasoningEffort
//
// 去重按 provider+model+effort；空 provider/model 的条目会被忽略或补齐基础值。

export const ROUTE_TIERS = Object.freeze(['chat', 'reflection', 'research']);

export function normalizeRouteEntry(entry, base) {
  if (!entry) return null;
  if (typeof entry === 'string') {
    // 支持 "provider/model" 或只写 "model"
    const [maybeProvider, maybeModel] = entry.includes('/') ? entry.split('/') : [null, entry];
    entry = { provider: maybeProvider ?? undefined, model: maybeModel };
  }
  if (typeof entry !== 'object' || Array.isArray(entry)) return null;
  const provider = String(entry.provider ?? base.provider ?? '').trim();
  const model = String(entry.model ?? base.model ?? '').trim();
  if (!provider || !model) return null;
  const effort = entry.effort === null ? '' : String(entry.effort ?? base.effort ?? '').trim();
  return { provider, model, effort };
}

export function routeSignature(route) {
  return `${route.provider}/${route.model}@${route.effort || '-'}`;
}

export function resolveModelRoutes({ tier = 'chat', routing = null, dsh = {}, groupProfile = null } = {}) {
  const base = normalizeRouteEntry({}, {
    provider: dsh.provider || 'deepseek-official',
    model: dsh.model || 'deepseek-flash',
    effort: dsh.reasoningEffort || ''
  }) ?? { provider: 'deepseek-official', model: 'deepseek-flash', effort: '' };
  const routes = [];
  const add = (entry) => {
    const route = normalizeRouteEntry(entry, base);
    if (!route) return;
    if (routes.some((r) => routeSignature(r) === routeSignature(route))) return;
    routes.push(route);
  };
  const enabled = routing?.enabled !== false;
  if (enabled) {
    if (groupProfile?.model) add(groupProfile.model);
    if (groupProfile?.provider || groupProfile?.effort) {
      add({
        provider: groupProfile.provider ?? base.provider,
        model: groupProfile.model ?? base.model,
        effort: groupProfile.effort ?? base.effort
      });
    }
    add(routing?.tiers?.[tier]);
    for (const fallback of (Array.isArray(routing?.fallback) ? routing.fallback : [])) add(fallback);
  }
  add(base);
  return routes;
}
