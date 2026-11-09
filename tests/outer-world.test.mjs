#!/usr/bin/env node
/** 出门见闻：关闭态零副作用、假源跑通、去重、熔断、视频缺依赖、策略与 VTT 清洗。 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { bridgeHarness } from './bridge-harness.mjs';
import { createOuterWorldStore, shanghaiDayKey } from '../services/social/outer-world/store.js';
import { chunkText, dedupeKey, limitDigestChunks, pickBodyText, pickNextSource } from '../services/social/outer-world/pipeline.js';
import { evaluateUrl, detectLoginWall } from '../services/social/outer-world/policy.js';
import { createRateLimiter } from '../services/social/outer-world/ratelimit.js';
import { cleanVtt, fetchSubtitleTrack } from '../services/social/outer-world/media/subtitle.js';
import { isAdminOnlyRequest } from '../console/policy.js';

function request(port, pathname, { method = 'GET', token = '', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}` };
    if (token) headers['x-console-token'] = token;
    if (payload !== undefined) {
      headers['content-type'] = 'application/json';
      headers.origin = `http://127.0.0.1:${port}`;
    }
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(data); } catch {}
        resolve({ status: res.statusCode, json, text: data });
      });
    });
    req.on('error', reject);
    req.end(payload);
  });
}

async function listen(server) {
  if (server.listening) return server.address().port;
  await new Promise((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  return server.address().port;
}

const BOOK_HTML = `<html><body><p>${'第一段内容写得比较慢，她读到这里停了一下。'.repeat(12)}</p><p>${'第二段继续往下讲，句子不长。'.repeat(12)}</p></body></html>`;
const fakeGenerate = async () => JSON.stringify({ summary: '她读完这一段，觉得慢慢读也挺好。', quote: '第一段内容写得比较慢' });

function fakeFetch() {
  return async () => BOOK_HTML;
}

test('关闭态：不落盘、不注入提示词、API enabled:false', async () => {
  const h = await bridgeHarness({
    config: {
      features: { outerWorld: false },
      simulation: { outerWorld: { leisure: { enabled: false, sources: [{ url: 'https://example.com/book' }] } } }
    }
  });
  let server = null;
  try {
    const result = await h.runOuterWorld('test', { fetchText: fakeFetch(), generate: fakeGenerate });
    assert.equal(result.ok, false);
    assert.equal(result.enabled, false);
    assert.equal(result.reason, 'disabled');
    const files = fs.readdirSync(path.join(h.temp, 'state')).filter((name) => /outer-world|leisure-progress/.test(name));
    assert.deepEqual(files, [], '关闭态不得写任何见闻状态文件');
    const prompt = h.buildWakePrompt('group:456', 'question');
    assert.equal(prompt.includes('出门见闻'), false, '关闭态提示词不得出现见闻');
    server = h.startConsoleServer();
    const port = await listen(server);
    const call = (pathname, opts) => request(port, pathname, { token: String(h.cfg.consoleToken), ...opts });
    const status = await call('/api/outer-world/status');
    assert.equal(status.status, 200);
    assert.equal(status.json.enabled, false);
    const run = await call('/api/outer-world/run', { method: 'POST', body: {} });
    assert.equal(run.status, 200);
    assert.equal(run.json.enabled, false);
    assert.equal(run.json.reason, 'disabled');
  } finally {
    if (server) await new Promise((resolve) => server.close(resolve));
    await h.close();
  }
});

test('假源跑通：写卡片/进度/配额/审计，提示词只带标题与摘要', async () => {
  const source = { title: '测试读物', url: 'https://example.com/book' };
  const h = await bridgeHarness({
    config: {
      features: { outerWorld: true },
      simulation: {
        outerWorld: {
          leisure: { enabled: true, sources: [source], maxItemsPerDay: 1, noteChars: 120, tokenBudget: 60000 },
          digest: { pushToOwner: false }
        }
      }
    }
  });
  try {
    const result = await h.runOuterWorld('test', { fetchText: fakeFetch(), generate: fakeGenerate });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.note.title, '测试读物');
    assert.equal(result.note.summary, '她读完这一段，觉得慢慢读也挺好。');

    const notesFile = path.join(h.temp, 'state', 'outer-world-notes.jsonl');
    const notes = fs.readFileSync(notesFile, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(notes.length, 1);
    assert.equal(notes[0].sourceHost, 'example.com');
    assert.equal(notes[0].dedupeKey, dedupeKey({ title: '测试读物', url: 'https://example.com/book' }));

    const progress = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'leisure-progress.json'), 'utf8'));
    const progressRows = Object.values(progress);
    assert.equal(progressRows.length, 1);
    assert.equal(progressRows[0].chapterIndex, 1, '读完一章后进度应推进');

    const status = h.outerWorldStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.quota.items, 1);
    assert.equal(status.noteCount, 1);
    const audit = fs.readFileSync(path.join(h.temp, 'state', 'outer-world-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(audit.at(-1).kind, 'read');

    const prompt = h.buildWakePrompt('group:456', 'question');
    assert.ok(prompt.includes('【出门见闻】'), '开启且有 24h 内卡片时应注入');
    assert.ok(prompt.includes('测试读物'));
    assert.ok(prompt.includes('她读完这一段'));
    assert.equal(prompt.includes('example.com'), false, '提示词不得带网址');

    const again = await h.runOuterWorld('test', { fetchText: fakeFetch(), generate: fakeGenerate });
    assert.equal(again.ok, false);
    assert.equal(again.reason, 'quota', '达到每日上限后应直接跳过');
  } finally {
    await h.close();
  }
});

test('模块层：正文提取跳页眉、按章回起取，摘要材料按预算截断', () => {
  const header = '图书编号与制作说明。\n\n*** START OF THE PROJECT GUTENBERG EBOOK TEST BOOK ***\n\n';
  assert.equal(pickBodyText(`${header}序言：这本书写得很慢。\n\nCHAPTER II\n\n正文从这里开始。`).startsWith('CHAPTER II'), true);
  assert.equal(pickBodyText(`${header}小引。\n\n第三回 她出门了\n\n正文从这里开始。`).startsWith('第三回'), true);
  assert.equal(pickBodyText('没有页眉也没有章节标题的一段普通正文。'), '没有页眉也没有章节标题的一段普通正文。');
  assert.equal(pickBodyText(''), '');

  const wide = Array.from({ length: 10 }, () => '句'.repeat(1000));
  assert.deepEqual(limitDigestChunks(wide, 2500).chunks, wide.slice(0, 2));
  assert.equal(limitDigestChunks(wide, 2500).chars, 2000);
  // 预算下限 800 时哪怕第一块更长也要留下一块，否则没有任何材料可摘要。
  const capped = limitDigestChunks(wide, 1);
  assert.equal(capped.chunks.length, 1);
  assert.equal(capped.chars, 1000);
  assert.deepEqual(limitDigestChunks([], 800), { chunks: [], chars: 0 });
});

test('单页来源读完即完结；超长正文按 digestChars 截断后再摘要', async () => {
  const longHtml = `<html><body><p>${'第一段内容写得比较慢，她读到这里停了一下。'.repeat(200)}</p><p>${'第二段继续往下讲，句子不长。'.repeat(200)}</p></body></html>`;
  const prompts = [];
  const h = await bridgeHarness({
    config: {
      features: { outerWorld: true },
      simulation: {
        outerWorld: {
          leisure: {
            enabled: true, sources: [{ title: '长读物', url: 'https://example.com/long' }],
            maxItemsPerDay: 1, noteChars: 120, digestChars: 800, tokenBudget: 0
          },
          digest: { pushToOwner: false }
        }
      }
    }
  });
  try {
    const result = await h.runOuterWorld('test', {
      fetchText: async () => longHtml,
      generate: async (prompt) => {
        prompts.push(prompt);
        return JSON.stringify({ summary: '她把开头这一段读完了。', quote: '第一段内容写得比较慢' });
      }
    });
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.ok(prompts.length === 1, '只应消化一次材料');
    assert.ok(prompts[0].length < 2500, `喂给模型的材料应按预算截断，实际 ${prompts[0].length}`);
    const progress = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'leisure-progress.json'), 'utf8'));
    assert.equal(Object.values(progress)[0].done, true, '没有章节目录的单页来源读完一次即完结');
    assert.equal(h.outerWorldStatus().limits.digestChars, 800);
  } finally {
    await h.close();
  }
});

test('连续失败熔断：三次后不再出门', async () => {
  const h = await bridgeHarness({
    config: {
      features: { outerWorld: true },
      simulation: { outerWorld: { leisure: { enabled: true, sources: [{ title: '坏源', url: 'https://example.com/bad' }], maxItemsPerDay: 10 } } }
    }
  });
  try {
    const badFetch = async () => { throw new Error('network down'); };
    for (let i = 0; i < 3; i += 1) {
      const result = await h.runOuterWorld('test', { fetchText: badFetch, generate: fakeGenerate });
      assert.equal(result.ok, false, `第 ${i + 1} 次应失败`);
    }
    const status = h.outerWorldStatus();
    assert.equal(status.circuit.fails, 3);
    assert.ok(status.circuit.lastError);
    const fourth = await h.runOuterWorld('test', { fetchText: badFetch, generate: fakeGenerate });
    assert.equal(fourth.reason, 'circuit-open');
    const audit = fs.readFileSync(path.join(h.temp, 'state', 'outer-world-audit.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(audit.filter((row) => row.kind === 'fail').length, 3);
  } finally {
    await h.close();
  }
});

test('模块层：关闭态零文件、去重、分块、VTT、访问策略、视频缺依赖', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'outer-world-unit-'));
  try {
    const store = createOuterWorldStore({ dir });
    assert.equal(store.quota.get(shanghaiDayKey()).items, 0);
    assert.deepEqual(store.notes.list(), []);
    assert.equal(store.circuit.isOpen(), false);
    store.progress.get('nope');
    store.audit.read();
    assert.deepEqual(fs.readdirSync(dir), [], '只读操作不得创建任何文件');

    const key = dedupeKey({ title: '书', url: 'https://example.com/a', text: '开头' });
    assert.equal(key, dedupeKey({ title: '书', url: 'https://example.com/a', text: '开头' }));
    assert.notEqual(key, dedupeKey({ title: '书2', url: 'https://example.com/a' }));
    store.notes.append({ title: '书', url: 'https://example.com/a', dedupeKey: key });
    store.notes.dedupeAdd(key);
    assert.equal(store.notes.dedupeHas(key), true);
    assert.equal(store.notes.dedupeHas('other'), false);

    const source = { id: 's1', title: '书', url: 'https://example.com/a', chapters: [] };
    store.progress.set('s1', { lastReadAt: Date.now() });
    assert.equal(pickNextSource({ sources: [source], store }), null, '当天已读的来源应跳过');
    store.progress.set('s1', { lastReadAt: Date.now() - 48 * 3600 * 1000 });
    assert.equal(pickNextSource({ sources: [source], store })?.id, 's1');

    for (let i = 0; i < 3; i += 1) store.circuit.fail('boom');
    assert.equal(store.circuit.isOpen(), true);

    const chunks = chunkText(`${'句子。'.repeat(300)}\n\n短段。`, { maxChars: 200 });
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((chunk) => chunk.length <= 200));

    const vtt = 'WEBVTT\n\n1\n00:00:01.000 --> 00:00:02.000\n<b>你好</b>\n\n2\n00:00:03.000 --> 00:00:04.000\n世界\n世界\n';
    assert.equal(cleanVtt(vtt), '你好\n世界');

    assert.equal(evaluateUrl('http://127.0.0.1/x').allow, false);
    assert.equal(evaluateUrl('http://192.168.1.5/x').reason, 'private-network');
    assert.equal(evaluateUrl('https://example.com/login').allow, false);
    assert.equal(evaluateUrl('https://example.com/book').allow, true);
    assert.equal(detectLoginWall('请先登录后查看全文', { minContentChars: 200 }), true);
    assert.equal(detectLoginWall('正文'.repeat(200), { minContentChars: 200 }), false);
    assert.equal(detectLoginWall('Login', { minContentChars: 200 }), true);

    // 末尾点号主机名归一：访问与黑名单/白名单都按无点号的域名比对。
    const dotted = evaluateUrl('https://example.com./book');
    assert.equal(dotted.allow, true);
    assert.equal(dotted.host, 'example.com');
    assert.equal(evaluateUrl('https://example.com/book', { blockedDomains: ['example.com.'] }).reason, 'blocked-domain');
    assert.equal(evaluateUrl('https://example.com/book', { policy: 'allowlist', allowlist: ['example.com.'] }).allow, true);
    assert.equal(evaluateUrl('https://example.com/app.bin').allow, true, 'bin 不再按下载拦截');

    // 每日上限 0 = 不限；限速间隔向上取整，避免浮点截断后过于宽松。
    let at = 0;
    const unlimited = createRateLimiter({ perDomainPerDay: 0, perSecond: 1000, now: () => (at += 10) });
    for (let i = 0; i < 25; i += 1) assert.equal(unlimited.check('example.com').allow, true, '每日上限 0 不限制次数');
    let boundedAt = 0;
    const bounded = createRateLimiter({ perDomainPerDay: 2, perSecond: 1000, now: () => (boundedAt += 10) });
    assert.equal(bounded.check('example.com').allow, true);
    assert.equal(bounded.check('example.com').allow, true);
    assert.equal(bounded.check('example.com').reason, 'daily-limit');

    const workDir = path.join(dir, 'tmp');
    const missing = await fetchSubtitleTrack({ url: 'https://example.com/video', workDir, ytDlpPath: '', envPath: '', pathBin: '' });
    assert.equal(missing.ok, false);
    assert.equal(missing.reason, 'dependency-missing');

    for (const name of ['/api/outer-world/status', '/api/outer-world/notes', '/api/outer-world/run', '/api/outer-world/stop']) {
      assert.equal(isAdminOnlyRequest(name, 'GET'), true, `${name} 必须仅控制台可用`);
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
