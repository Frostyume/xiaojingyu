import { McpServer } from '../../xi-a2/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.js';
import { z } from '../../xi-a2/node_modules/zod/index.js';
import { WEB_TOOL_NAMES } from './catalog.mjs';
import { createHash } from 'node:crypto';

// The parent proxy transports JSON. Only this fixed tool may promote verified
// frame bytes to MCP image blocks; remove base64 from the text/structured copy.
export function webToolResult(name, value) {
  const { image_content: rawImages, ...metadata } = value;
  let images = [];
  if (rawImages !== undefined) {
    if (name !== 'bilibili_frames' || value.status !== 'ok' || !Array.isArray(rawImages)
      || rawImages.length < 1 || rawImages.length > 2 || !Array.isArray(metadata.frames)
      || metadata.frames.length !== rawImages.length) throw new Error('WEB_FRAME_RESULT_INVALID');
    images = rawImages.map((image, i) => {
      if (image?.type !== 'image' || !['image/png', 'image/jpeg'].includes(image.mimeType)
        || typeof image.data !== 'string' || image.data.length > 333336) throw new Error('WEB_FRAME_RESULT_INVALID');
      const bytes = Buffer.from(image.data, 'base64');
      if (!bytes.length || bytes.length > 250000 || bytes.toString('base64') !== image.data
        || createHash('sha256').update(bytes).digest('hex') !== metadata.frames[i].sha256
        || image.mimeType !== metadata.frames[i].mimeType) throw new Error('WEB_FRAME_RESULT_INVALID');
      return { type: 'image', mimeType: image.mimeType, data: image.data };
    });
  }
  return { content: [{ type: 'text', text: JSON.stringify(metadata) }, ...images], structuredContent: metadata,
    ...(value.ok === false || ['failed', 'unavailable', 'unconfigured'].includes(value.status) ? { isError: true } : {}) };
}

// Only the flat primitive schemas produced by these original 15 tools are supported.
function schemaFor(schema) {
  const required = new Set(schema.required ?? []), shape = {};
  for (const [name, spec] of Object.entries(schema.properties ?? {})) {
    let value;
    if (spec.type === 'string') {
      value = z.string(); if (spec.minLength !== undefined) value = value.min(spec.minLength);
      if (spec.maxLength !== undefined) value = value.max(spec.maxLength); if (spec.pattern) value = value.regex(new RegExp(spec.pattern));
    } else if (['integer', 'number'].includes(spec.type)) {
      value = z.number(); if (spec.type === 'integer') value = value.int();
      if (spec.minimum !== undefined) value = value.min(spec.minimum); if (spec.maximum !== undefined) value = value.max(spec.maximum);
    } else if (spec.type === 'boolean') value = z.boolean();
    else throw new Error('WEB_PRIMITIVE_SCHEMA_DRIFT');
    if (spec.enum) value = value.refine(item => spec.enum.includes(item), 'Value is outside original allowed values');
    shape[name] = required.has(name) ? value : value.optional();
  }
  return z.object(shape).strict();
}
export function createOwnedWebServer({ catalog }) {
  if (!catalog?.tools || catalog.tools.length !== WEB_TOOL_NAMES.length) throw new Error('WEB_CATALOG_REQUIRED');
  const server = new McpServer({ name: 'xi-owned-web', version: '1.0.0' });
  for (const tool of catalog.tools) server.registerTool(tool.name, { description: tool.description,
    inputSchema: schemaFor(tool.parameters), annotations: { readOnlyHint: !tool.mutation, destructiveHint: false,
      idempotentHint: !tool.mutation, openWorldHint: !['qzone_status', 'qzone_draft', 'qzone_drafts', 'tieba_status', 'bilibili_status'].includes(tool.name) } },
  async args => {
    const value = JSON.parse(await tool.handler(args));
    return webToolResult(tool.name, value);
  });
  return server;
}
