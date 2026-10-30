#!/usr/bin/env node
// 从 config.example.json + storage 默认值生成 config.schema.json。
// 用途：外部工具/编辑器补全、部署脚本、控制台表单；不含任何本机配置值。
//
// 用法：node tools/gen-config-schema.mjs [--check]
//   --check：只校验现有文件是否最新（CI 用），不写盘。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildConfigSchema, CONFIG_VERSION } from '../runtime/kernel/config-schema.js';
import { migrateConfigObject } from '../runtime/kernel/config-schema.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const exampleFile = path.join(ROOT, 'config.example.json');
const outFile = path.join(ROOT, 'config.schema.json');

const example = JSON.parse(fs.readFileSync(exampleFile, 'utf8'));
const withDefaults = migrateConfigObject({ ...example, configVersion: 1 }).config;

function toJsonType(field) {
  if (field.nullable) return [field.type === 'null' ? 'object' : field.type, 'null'];
  return field.type === 'null' ? 'null' : field.type;
}

const fields = buildConfigSchema(withDefaults).fields;
const properties = {};
for (const field of fields) {
  if (field.secret) continue; // 密钥不写进公开 schema 的默认值示例
  const parts = field.key.split('.');
  let cur = properties;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur[parts[i]] ??= { type: 'object', properties: {} };
    cur = cur[parts[i]].properties;
  }
  const node = {
    title: field.label,
    type: toJsonType(field),
    default: field.nullable && field.default === null ? null : field.default
  };
  if (field.min !== undefined) node.minimum = field.min;
  if (field.max !== undefined) node.maximum = field.max;
  if (Array.isArray(field.enum) && field.enum.length) node.enum = field.enum;
  if (field.description) node.description = field.description;
  if (field.secret) node['x-secret'] = true;
  cur[parts[parts.length - 1]] = node;
}

// 密钥字段也要出现在结构里（只是不写默认值），方便控制台知道字段存在。
for (const field of fields.filter((f) => f.secret)) {
  const parts = field.key.split('.');
  let cur = properties;
  for (let i = 0; i < parts.length - 1; i += 1) {
    cur[parts[i]] ??= { type: 'object', properties: {} };
    cur = cur[parts[i]].properties;
  }
  cur[parts[parts.length - 1]] ??= {
    title: field.label,
    type: 'string',
    'x-secret': true,
    description: field.description || '密钥/标识：只存本地，控制台只显示是否已配置'
  };
}

const doc = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://example.invalid/qq-bridge/config.schema.json',
  title: 'qq-bridge config',
  description: 'qq-bridge 运行配置。真实 config.json 不入库；本文件只描述结构、类型与范围。',
  type: 'object',
  additionalProperties: true,
  'x-config-version': CONFIG_VERSION,
  'x-generated-from': 'config.example.json',
  properties,
  'x-fields': fields.filter((f) => !f.secret).map((f) => ({
    key: f.key,
    label: f.label,
    group: f.group,
    type: f.type,
    restart: f.restart,
    advanced: f.advanced,
    ...(f.min !== undefined ? { min: f.min } : {}),
    ...(f.max !== undefined ? { max: f.max } : {}),
    ...(f.enum ? { enum: f.enum } : {})
  }))
};

const text = `${JSON.stringify(doc, null, 2)}\n`;
const check = process.argv.includes('--check');
if (check) {
  // 比较前统一换行：仓库里存 LF，但 core.autocrlf=true 的检出会写回 CRLF，
  // 直接比字符串会在干净克隆上误报"不是最新"。
  const normalize = (s) => s.replace(/\r\n/g, '\n');
  const existing = fs.existsSync(outFile) ? normalize(fs.readFileSync(outFile, 'utf8')) : '';
  if (existing !== normalize(text)) {
    console.error('config.schema.json 不是最新：请运行 node tools/gen-config-schema.mjs');
    process.exitCode = 1;
  } else {
    console.log('config.schema.json 已是最新');
  }
} else {
  fs.writeFileSync(outFile, text, 'utf8');
  console.log(`已生成 ${path.relative(ROOT, outFile)}（${fields.length} 个字段）`);
}
