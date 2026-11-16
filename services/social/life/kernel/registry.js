// 适配器注册表：加载 manifest.json、严格校验字段、按开关实例化。
//
// manifest 是适配器与内核之间唯一的契约：字段固定，未知字段拒绝加载
// （拼写错误不能静默生效）。单个适配器加载失败只记日志，不影响其它适配器。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateCron } from './time.js';
import { createFetchGuard } from './fetch-guard.js';
import { moduleIdForAdapter } from '../config.js';

export const MANIFEST_KEYS = Object.freeze([
  'id', 'name', 'version', 'sourceType', 'description', 'auth', 'capabilities',
  'schedule', 'actions', 'risk', 'rateLimit', 'retention', 'health', 'configSchema'
]);

export const CAPABILITIES = Object.freeze([
  'read:calendar', 'read:mail', 'read:code', 'read:paper', 'read:feed', 'read:home',
  'write:calendar', 'write:home', 'notify:owner'
]);

const SOURCE_TYPES = new Set(['A', 'B', 'C', 'D', 'E', 'F']);
const RISKS = new Set(['L0', 'L1', 'L2', 'L3']);
const AUTH_TYPES = new Set(['none', 'url-secret', 'token-secret', 'oauth2']);
const CONFIG_TYPES = new Set(['secret', 'string', 'number', 'boolean', 'array']);
const ADAPTER_ID = /^[a-z][a-z0-9-]{0,40}$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function unknownKeys(obj, allowed, where, errors) {
  for (const key of Object.keys(obj)) {
    if (!allowed.includes(key)) errors.push(`${where} 未知字段：${key}`);
  }
}

function requireFields(obj, fields, where, errors) {
  for (const field of fields) {
    if (!(field in obj)) errors.push(`${where} 缺少字段：${field}`);
  }
}

function checkInt(value, min, max, where, errors) {
  if (!Number.isInteger(value) || value < min || value > max) errors.push(`${where} 必须是 ${min}~${max} 的整数`);
}

/** 返回 {ok, errors}。errors 为空才允许加载。 */
export function validateManifest(manifest, { dirName = '' } = {}) {
  const errors = [];
  if (!isObject(manifest)) return { ok: false, errors: ['manifest 必须是对象'] };
  unknownKeys(manifest, MANIFEST_KEYS, 'manifest', errors);
  requireFields(manifest, MANIFEST_KEYS, 'manifest', errors);

  if (typeof manifest.id !== 'string' || !ADAPTER_ID.test(manifest.id)) errors.push('id 必须是小写字母开头的 slug');
  if (dirName && manifest.id !== dirName) errors.push(`id（${manifest.id}）必须等于目录名（${dirName}）`);
  if (typeof manifest.name !== 'string' || !manifest.name.trim()) errors.push('name 必须是非空字符串');
  if (typeof manifest.version !== 'string' || !SEMVER.test(manifest.version)) errors.push('version 必须是语义化版本');
  if (!SOURCE_TYPES.has(manifest.sourceType)) errors.push('sourceType 必须是 A–F');
  if (typeof manifest.description !== 'string') errors.push('description 必须是字符串');

  const auth = manifest.auth;
  if (!isObject(auth)) errors.push('auth 必须是对象');
  else {
    unknownKeys(auth, ['type', 'scopes', 'secretRef'], 'auth', errors);
    requireFields(auth, ['type', 'scopes'], 'auth', errors);
    if (!AUTH_TYPES.has(auth.type)) errors.push('auth.type 非法');
    if (!Array.isArray(auth.scopes) || auth.scopes.some((s) => typeof s !== 'string')) errors.push('auth.scopes 必须是字符串数组');
    if ('secretRef' in auth && typeof auth.secretRef !== 'string') errors.push('auth.secretRef 必须是字符串');
  }

  if (!Array.isArray(manifest.capabilities) || !manifest.capabilities.length) errors.push('capabilities 必须是非空数组');
  else {
    for (const cap of manifest.capabilities) {
      if (!CAPABILITIES.includes(cap)) errors.push(`未知 capability：${cap}`);
      if (String(cap).startsWith('write:')) errors.push(`P0 不允许写能力：${cap}`);
    }
  }

  const schedule = manifest.schedule;
  if (!isObject(schedule)) errors.push('schedule 必须是对象');
  else {
    unknownKeys(schedule, ['sync', 'jitterSec', 'catchUp', 'timeoutMs'], 'schedule', errors);
    requireFields(schedule, ['sync', 'jitterSec', 'catchUp', 'timeoutMs'], 'schedule', errors);
    try { validateCron(schedule.sync); } catch (error) { errors.push(`schedule.sync 非法：${error.message}`); }
    checkInt(schedule.jitterSec, 0, 3600, 'schedule.jitterSec', errors);
    if (!['none', 'once'].includes(schedule.catchUp)) errors.push('schedule.catchUp 必须是 none/once');
    checkInt(schedule.timeoutMs, 1000, 120000, 'schedule.timeoutMs', errors);
  }

  if (!Array.isArray(manifest.actions)) errors.push('actions 必须是数组');
  else if (manifest.actions.length) errors.push('P0 适配器不允许声明 actions（只读）');
  else if (!manifest.actions.every(isObject)) errors.push('actions 元素必须是对象');

  const risk = manifest.risk;
  if (!isObject(risk)) errors.push('risk 必须是对象');
  else {
    unknownKeys(risk, ['default', 'max'], 'risk', errors);
    requireFields(risk, ['default', 'max'], 'risk', errors);
    if (!RISKS.has(risk.default)) errors.push('risk.default 非法');
    if (!RISKS.has(risk.max)) errors.push('risk.max 非法');
    if (risk.max !== 'L0') errors.push('P0 适配器 risk.max 必须是 L0');
  }

  const rate = manifest.rateLimit;
  if (!isObject(rate)) errors.push('rateLimit 必须是对象');
  else {
    unknownKeys(rate, ['perMinute', 'perDay'], 'rateLimit', errors);
    requireFields(rate, ['perMinute', 'perDay'], 'rateLimit', errors);
    checkInt(rate.perMinute, 1, 1000, 'rateLimit.perMinute', errors);
    checkInt(rate.perDay, 1, 100000, 'rateLimit.perDay', errors);
  }

  const retention = manifest.retention;
  if (!isObject(retention)) errors.push('retention 必须是对象');
  else {
    unknownKeys(retention, ['rawDays', 'itemDays'], 'retention', errors);
    requireFields(retention, ['rawDays', 'itemDays'], 'retention', errors);
    if (retention.rawDays !== 0) errors.push('retention.rawDays 必须为 0（原始正文默认不落库）');
    checkInt(retention.itemDays, 1, 3650, 'retention.itemDays', errors);
  }

  const health = manifest.health;
  if (!isObject(health)) errors.push('health 必须是对象');
  else {
    unknownKeys(health, ['authErrorStops', 'failuresToOpen', 'openMs'], 'health', errors);
    requireFields(health, ['authErrorStops', 'failuresToOpen', 'openMs'], 'health', errors);
    if (typeof health.authErrorStops !== 'boolean') errors.push('health.authErrorStops 必须是布尔值');
    checkInt(health.failuresToOpen, 1, 20, 'health.failuresToOpen', errors);
    checkInt(health.openMs, 60000, 86400000, 'health.openMs', errors);
  }

  const configSchema = manifest.configSchema;
  if (!isObject(configSchema)) errors.push('configSchema 必须是对象');
  else {
    for (const [key, spec] of Object.entries(configSchema)) {
      const where = `configSchema.${key}`;
      if (!/^[A-Za-z][A-Za-z0-9_-]{0,40}$/.test(key)) { errors.push(`${where} 字段名非法`); continue; }
      if (!isObject(spec)) { errors.push(`${where} 必须是对象`); continue; }
      unknownKeys(spec, ['type', 'required', 'label', 'default', 'min', 'max', 'enum'], where, errors);
      requireFields(spec, ['type'], where, errors);
      if (!CONFIG_TYPES.has(spec.type)) errors.push(`${where}.type 非法`);
      if ('required' in spec && typeof spec.required !== 'boolean') errors.push(`${where}.required 必须是布尔值`);
      if ('label' in spec && typeof spec.label !== 'string') errors.push(`${where}.label 必须是字符串`);
      if ('enum' in spec && (!Array.isArray(spec.enum) || !spec.enum.length)) errors.push(`${where}.enum 必须是非空数组`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function defaultAdaptersDir() {
  return fileURLToPath(new URL('../adapters/', import.meta.url));
}

/**
 * 加载适配器目录。
 *
 * @param {{dir?:string, config:object, logger?:Function, resolve?:Function,
 *          fetchImpl?:Function, guardFactory?:Function}} options
 * @returns {Promise<{adapters:Array, invalid:Array}>}
 */
export async function loadAdapters({
  dir = defaultAdaptersDir(),
  config,
  logger = () => {},
  resolve,
  fetchImpl,
  summarizer = null,
  guardFactory = createFetchGuard
} = {}) {
  const adapters = [];
  const invalid = [];
  let names = [];
  try {
    names = fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch (error) {
    logger('warn', `适配器目录不可读：${error?.message ?? error}`);
    return { adapters, invalid };
  }

  for (const dirName of names) {
    const manifestFile = path.join(dir, dirName, 'manifest.json');
    if (!fs.existsSync(manifestFile)) continue;
    let manifest;
    try {
      manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8').replace(/^\uFEFF/, ''));
    } catch (error) {
      invalid.push({ dir: dirName, errors: [`manifest.json 解析失败：${error?.message ?? error}`] });
      logger('warn', `适配器 ${dirName} manifest 解析失败，已跳过`);
      continue;
    }
    const check = validateManifest(manifest, { dirName });
    if (!check.ok) {
      invalid.push({ dir: dirName, errors: check.errors });
      logger('warn', `适配器 ${dirName} manifest 无效，已跳过：${check.errors.join('；')}`);
      continue;
    }
    let module;
    try {
      module = await import(pathToFileURL(path.join(dir, dirName, 'index.js')).href);
    } catch (error) {
      invalid.push({ dir: dirName, errors: [`index.js 加载失败：${error?.message ?? error}`] });
      logger('warn', `适配器 ${dirName} 加载失败，已跳过：${error?.message ?? error}`);
      continue;
    }
    const impl = module.default ?? module;
    if (!impl || typeof impl.sync !== 'function') {
      invalid.push({ dir: dirName, errors: ['index.js 必须导出 sync()'] });
      logger('warn', `适配器 ${dirName} 未导出 sync()，已跳过`);
      continue;
    }
    if (impl.id && impl.id !== manifest.id) {
      invalid.push({ dir: dirName, errors: [`实现 id（${impl.id}）与 manifest 不一致`] });
      logger('warn', `适配器 ${dirName} 实现 id 与 manifest 不一致，已跳过`);
      continue;
    }
    // 模块可以和适配器不同名：calendarMorning → calendar-ics、rssDigest → rss。
    // 只有模块真正开启时才把模块配置叠加到适配器上，避免模块默认值（如
    // lookaheadDays=1）覆盖单独开启日历/ RSS 时适配器自己的配置。
    const moduleId = moduleIdForAdapter(manifest.id) ?? (config?.modules?.[manifest.id] ? manifest.id : null);
    const moduleConfig = moduleId ? config?.modules?.[moduleId] : null;
    const moduleOn = moduleConfig?.enabled === true;
    const adapterConfig = {
      ...(config?.adapters?.[manifest.id] ?? {}),
      ...(moduleOn && moduleConfig && typeof moduleConfig === 'object' ? moduleConfig : {})
    };
    if (moduleId === 'calendarMorning' && moduleOn) {
      const need = Math.max(1, Math.min(7, Number(moduleConfig.lookaheadDays) || 1));
      const tomorrow = moduleConfig.tomorrowPreview === false ? 0 : 1;
      adapterConfig.lookaheadDays = Math.max(Number(adapterConfig.lookaheadDays) || 0, need + tomorrow + 1);
    }
    const allowedHosts = typeof impl.allowedHosts === 'function'
      ? impl.allowedHosts(adapterConfig, manifest)
      : (Array.isArray(impl.allowedHosts) ? impl.allowedHosts : []);
    const guard = guardFactory({
      allowedHosts,
      timeoutMs: manifest.schedule.timeoutMs,
      maxBytes: impl.maxBytes ?? 512 * 1024,
      fetchImpl,
      resolve
    });
    // paper/github 只认模块开关；calendar-ics/rss 允许「模块开或适配器单独开」。
    const ownedByModule = manifest.id === 'paper' || manifest.id === 'github';
    const enabled = config?.enabled === true
      && (ownedByModule
        ? config?.modules?.[manifest.id]?.enabled === true
        : (moduleConfig?.enabled === true || config?.adapters?.[manifest.id]?.enabled === true));
    adapters.push({
      id: manifest.id,
      manifest,
      impl,
      config: adapterConfig,
      enabled,
      allowedHosts,
      guard,
      summarizer: typeof summarizer === 'function' ? summarizer : null
    });
  }
  return { adapters, invalid };
}
