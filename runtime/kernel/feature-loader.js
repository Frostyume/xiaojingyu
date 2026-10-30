// Feature loader：新功能通过 `features/<id>/index.js` 注册，不再改 bridge.js 主流程。
//
// 约定：
//   · manifest 必须有 id/name/hooks；id 必须与目录名一致；
//   · permissions 默认无权限，加载时按白名单逐项授予 ctx 能力；
//   · 单个 feature 的 setup/hook 抛错只禁用自己，不影响桥接；
//   · hooks 通过事件总线派发（onMessage→message、onTurnEnd→turn/end…），
//     formatSegment 是同步直调（消息转文本需要立即返回）。
//
// 迁移策略：先迁低风险、无状态副作用的功能（日报、卡片格式化），再迁内心生活/提醒。

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { EventBus } from './event-bus.js';

const ALLOWED_PERMISSIONS = new Set([
  'state:read',
  'state:write',
  'jobs:write',
  'qq:send',
  'prompt:inject',
  'console:route',
  'service:daily-report',
  'service:memory'
]);

const HOOK_EVENTS = {
  onMessage: 'message',
  onWake: 'wake',
  onTurnEnd: 'turn/end',
  onSchedule: 'schedule',
  beforeSend: 'beforeSend',
  onConsoleRequest: 'console/request'
};

function validateManifest(manifest, dirName) {
  const errors = [];
  if (!manifest || typeof manifest !== 'object') return { ok: false, errors: ['manifest 必须是对象'] };
  if (!manifest.id || manifest.id !== dirName) errors.push(`id 必须与目录名一致（${dirName}）`);
  if (!manifest.name) errors.push('name 不能为空');
  if (!manifest.hooks || typeof manifest.hooks !== 'object') errors.push('hooks 必须是对象');
  const permissions = Array.isArray(manifest.permissions) ? manifest.permissions : [];
  for (const p of permissions) if (!ALLOWED_PERMISSIONS.has(p)) errors.push(`未知权限：${p}`);
  return { ok: errors.length === 0, errors, permissions };
}

function scopedContext(feature, base) {
  const perms = new Set(feature.permissions);
  const ctx = {
    featureId: feature.id,
    cfg: base.cfg,
    log: (message) => base.log(`[feature:${feature.id}] ${message}`),
    now: base.now ?? (() => Date.now())
  };
  if (perms.has('state:read') && base.getState) ctx.getState = base.getState;
  if (perms.has('jobs:write') && base.jobs) ctx.jobs = base.jobs;
  if (perms.has('qq:send') && base.send) ctx.send = base.send;
  if (perms.has('prompt:inject') && base.prompt) ctx.prompt = base.prompt;
  if (perms.has('service:daily-report') && base.dailyReport) ctx.dailyReport = base.dailyReport;
  if (perms.has('service:memory') && base.memory) ctx.memory = base.memory;
  return ctx;
}

export class FeatureHost {
  constructor({ features = [], bus, logger = () => {} } = {}) {
    this.features = features;
    this.bus = bus ?? new EventBus({ logger });
    this.logger = logger;
    this.started = false;
  }

  has(id) {
    return this.features.some((f) => f.id === id && f.enabled !== false);
  }

  list() {
    return this.features.map((f) => ({
      id: f.id, name: f.name, version: f.version ?? 1,
      enabled: f.enabled !== false, permissions: f.permissions,
      hooks: Object.keys(f.hooks ?? {})
    }));
  }

  async start() {
    if (this.started) return;
    this.started = true;
    for (const f of this.features) {
      if (f.enabled === false) continue;
      try {
        if (typeof f.start === 'function') await f.start(f.ctx);
      } catch (error) {
        this.logger(`feature ${f.id} start 失败（已禁用）：${error?.message ?? error}`);
        f.enabled = false;
      }
    }
    await this.bus.emit('feature/start', { features: this.list() });
  }

  async stop() {
    for (const f of this.features) {
      if (f.enabled === false) continue;
      try { await f.stop?.(f.ctx); } catch (error) { this.logger(`feature ${f.id} stop 失败：${error?.message ?? error}`); }
    }
    this.started = false;
  }

  /** 同步：消息段 → 文本。返回 null 表示该 feature 不处理。 */
  formatSegment(segment) {
    for (const f of this.features) {
      if (f.enabled === false) continue;
      const fn = f.hooks?.formatSegment;
      if (typeof fn !== 'function') continue;
      try {
        const result = fn(segment, f.ctx);
        if (typeof result === 'string' && result) return result;
      } catch (error) {
        this.logger(`feature ${f.id} formatSegment 失败（已隔离）：${error?.message ?? error}`);
      }
    }
    return null;
  }

  emit(event, payload) {
    return this.bus.emit(event, payload);
  }

  stats() {
    return { features: this.list(), bus: this.bus.stats() };
  }
}

/** 扫描目录并加载 feature；单个失败只记录，不阻断启动。 */
export async function loadFeatures({ dir, ctx = {}, disabled = [], logger = () => {} } = {}) {
  const bus = new EventBus({ logger });
  const features = [];
  const errors = [];
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).filter((e) => e.isDirectory());
  } catch {
    return new FeatureHost({ features, bus, logger });
  }
  const disabledSet = new Set((Array.isArray(disabled) ? disabled : []).map(String));
  for (const entry of entries) {
    const id = entry.name;
    const file = path.join(dir, id, 'index.js');
    if (!fs.existsSync(file)) continue;
    if (disabledSet.has(id)) {
      errors.push({ id, error: '配置中已禁用' });
      continue;
    }
    try {
      const mod = await import(pathToFileURL(file).href);
      const manifest = mod.default;
      const checked = validateManifest(manifest, id);
      if (!checked.ok) {
        errors.push({ id, error: checked.errors.join('；') });
        continue;
      }
      const feature = {
        ...manifest,
        permissions: checked.permissions,
        enabled: true,
        hooks: manifest.hooks ?? {},
        ctx: scopedContext(manifest, ctx)
      };
      // 注册事件类 hook
      for (const [hookName, event] of Object.entries(HOOK_EVENTS)) {
        const fn = feature.hooks[hookName];
        if (typeof fn === 'function') {
          bus.on(event, (payload) => fn(payload, feature.ctx), { id: `${id}:${hookName}`, priority: Number(manifest.priority) || 0 });
        }
      }
      if (typeof manifest.setup === 'function') {
        try { await manifest.setup(feature.ctx); }
        catch (error) {
          errors.push({ id, error: `setup 失败：${error?.message ?? error}` });
          feature.enabled = false;
        }
      }
      features.push(feature);
    } catch (error) {
      errors.push({ id, error: String(error?.message ?? error) });
    }
  }
  for (const e of errors) logger(`feature ${e.id} 未加载：${e.error}`);
  return new FeatureHost({ features, bus, logger });
}
