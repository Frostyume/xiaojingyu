// ChatAnywhere（OpenAI 兼容）搜索适配层：纯映射与配置默认值。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mapChatAnywhereResponse, loadSearchConfig, isWeakSearchResults } from '../services/social/web-search.js';

test('chatanywhere: 提取 url_citation 与回答摘要', () => {
  const results = mapChatAnywhereResponse({
    choices: [{
      message: {
        content: '根据搜索结果，DeepSeek 官方文档在 api-docs.deepseek.com',
        annotations: [
          { type: 'url_citation', url_citation: { url: 'https://api-docs.deepseek.com/zh-cn/', title: 'DeepSeek API Docs' } },
          { type: 'url_citation', url_citation: { url: 'https://api-docs.deepseek.com/zh-cn/', title: '重复' } },
          { type: 'url_citation', url_citation: { url: 'javascript:alert(1)', title: '危险' } }
        ]
      }
    }]
  }, 8);
  assert.equal(results.length, 1, '重复/危险 URL 应去重过滤');
  assert.equal(results[0].title, 'DeepSeek API Docs');
  assert.match(results[0].url, /^https:\/\/api-docs\.deepseek\.com/);
  assert.match(results[0].snippet, /官方文档/);
});

test('chatanywhere: 没有引用时退回整段回答；空响应报错', () => {
  const fallback = mapChatAnywhereResponse({ choices: [{ message: { content: '今天北京晴，20 度' } }] });
  assert.equal(fallback.length, 1);
  assert.equal(fallback[0].url, '');
  assert.match(fallback[0].snippet, /北京/);
  assert.throws(() => mapChatAnywhereResponse({ choices: [{ message: { content: '' } }] }), /没有返回搜索/);
});

test('chatanywhere: 优先使用回答里的真实链接，而不是 grounding 跳转', () => {
  const results = mapChatAnywhereResponse({
    choices: [{
      message: {
        content: '文档在 [DeepSeek API Docs](https://api-docs.deepseek.com/zh-cn/)，可以查看。',
        annotations: [
          { type: 'url_citation', url_citation: { start_index: 4, end_index: 20, title: 'api-docs.deepseek.com', url: 'https://vertexaisearch.cloud.google.com/grounding-api-redirect/abc' } }
        ]
      }
    }]
  }, 8);
  assert.equal(results[0].url, 'https://api-docs.deepseek.com/zh-cn/');
  assert.match(results[0].title, /DeepSeek API Docs/);
});

test('chatanywhere: 只有首页链接视为弱结果，可触发 Bing 兜底', () => {
  assert.equal(isWeakSearchResults([{ url: 'https://www.xiaohongshu.com/' }, { url: 'https://weibo.com/' }]), true);
  assert.equal(isWeakSearchResults([
    { url: 'https://www.bilibili.com/video/BV1xx/' },
    { url: 'https://zhuanlan.zhihu.com/p/1' }
  ]), false);
  assert.equal(isWeakSearchResults([]), true);
});

test('chatanywhere: provider 默认端点/模型/环境变量', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqb-search-'));
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ webSearch: { provider: 'chatanywhere' } }));
  const cfg = loadSearchConfig(dir);
  assert.equal(cfg.provider, 'chatanywhere');
  assert.equal(cfg.baseURL, 'https://api.chatanywhere.tech/v1');
  assert.equal(cfg.model, 'gemini-2.5-flash-lite');
  assert.equal(cfg.apiKeyEnv, 'CHATANYWHERE_API_KEY');
  fs.rmSync(dir, { recursive: true, force: true });
});
