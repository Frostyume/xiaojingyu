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
import {
  chunkText, dedupeKey, digestBudget, isSegmentedSource, isSourceFinished, limitDigestChunks,
  migrateLegacySegmentedProgress, pickBodyText, pickNextSource, readCharOffset, segmentDedupeKey
} from '../services/social/outer-world/pipeline.js';
import { evaluateUrl, detectLoginWall } from '../services/social/outer-world/policy.js';
import { createRateLimiter } from '../services/social/outer-world/ratelimit.js';
import { cleanVtt, fetchSubtitleTrack } from '../services/social/outer-world/media/subtitle.js';
import { isAdminOnlyRequest } from '../console/policy.js';

function request(port, pathname, { method = 'GET', token = '', agentToken = '', body } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers = { host: `127.0.0.1:${port}` };
    if (token) headers['x-console-token'] = token;
    if (agentToken) {
      headers['x-agent-token'] = agentToken;
      headers['x-agent-call'] = '1';
    }
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
    assert.equal(notes[0].dedupeKey, `${dedupeKey({ title: '测试读物', url: 'https://example.com/book' })}:p0`, '单页分段来源的去重 key 带分段序号');

    const progress = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'leisure-progress.json'), 'utf8'));
    const progressRows = Object.values(progress);
    assert.equal(progressRows.length, 1);
    assert.equal(progressRows[0].chapterIndex, 1, '读完一章后进度应推进');
    assert.equal(progressRows[0].done, true, '整本在一轮预算内读完，才允许标完结');
    assert.ok(Number(progressRows[0].charOffset) > 0, '单页来源应记录读到的字符偏移');
    assert.equal(progressRows[0].title, '测试读物', '进度带书名');
    assert.ok(Number(progressRows[0].totalChars) > 0, '单页来源带裁剪后总字数');
    assert.equal(progressRows[0].chaptersTotal, 0);

    const status = h.outerWorldStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.quota.items, 1);
    assert.ok(status.quota.chars > 0, '配额记录今日阅读字数');
    assert.equal(status.reading.length, 1, '状态快照带「她在读」');
    assert.equal(status.reading[0].title, '测试读物');
    assert.equal(status.reading[0].percent, 100, '已读完的书 100%');
    assert.equal(status.readingToday.items, 1);
    assert.equal(status.readingToday.chars, status.quota.chars);
    assert.equal(status.readingToday.charsKnown, true);
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

test('模块层：分段阅读的纯函数（预算、分段判定、带序号 key、完结判定、偏移读取）', () => {
  assert.equal(digestBudget(undefined), 6000);
  assert.equal(digestBudget(10), 800, '预算有下限');
  assert.equal(digestBudget(999999), 20000, '预算有上限');
  assert.equal(digestBudget('6000'), 6000);

  assert.equal(isSegmentedSource({ type: 'url', chapters: [] }), true, '无章节目录的单页文本源分段连续读');
  assert.equal(isSegmentedSource({ type: 'gutenberg', url: 'https://example.invalid/a' }), true);
  assert.equal(isSegmentedSource({ type: 'video', url: 'https://example.invalid/v', chapters: [] }), false, '字幕源不进分段分支');
  assert.equal(isSegmentedSource({ type: 'url', chapters: [{ title: '一', url: 'https://example.invalid/1' }] }), false, '章节源逐章推进');
  assert.equal(isSegmentedSource(null), false);

  const base = dedupeKey({ title: '书', url: 'https://example.invalid/a' });
  assert.equal(segmentDedupeKey({ title: '书', url: 'https://example.invalid/a', chapterIndex: 0, segmented: false }), base);
  assert.equal(segmentDedupeKey({ title: '书', url: 'https://example.invalid/a', chapterIndex: 2, segmented: true }), `${base}:p2`);
  assert.notEqual(
    segmentDedupeKey({ title: '书', url: 'https://example.invalid/a', chapterIndex: 0, segmented: true }),
    segmentDedupeKey({ title: '书', url: 'https://example.invalid/a', chapterIndex: 1, segmented: true })
  );

  assert.equal(readCharOffset({ charOffset: 6000 }, true), 6000);
  assert.equal(readCharOffset({ charOffset: 6000 }, false), 0, '非分段源不看偏移');
  assert.equal(readCharOffset({ charOffset: -5 }, true), 0);
  assert.equal(readCharOffset({}, true), 0);
  assert.equal(readCharOffset(null, true), 0);

  assert.equal(isSourceFinished({ segmented: true, hasChapters: false, nextOffset: 6000, bodyLength: 8003 }), false);
  assert.equal(isSourceFinished({ segmented: true, hasChapters: false, nextOffset: 8003, bodyLength: 8003 }), true);
  assert.equal(isSourceFinished({ segmented: false, hasChapters: true, nextIndex: 2, chapterCount: 3 }), false);
  assert.equal(isSourceFinished({ segmented: false, hasChapters: true, nextIndex: 3, chapterCount: 3 }), true);
  assert.equal(isSourceFinished({ segmented: true, hasChapters: false, nextOffset: 10, bodyLength: 8003, doneBySource: true }), true, '来源自己声明读完就读完');
});

test('模块层：旧 done:true 且无 charOffset 的单页进度行会被纠偏', () => {
  const rows = new Map([
    ['legacy', { chapterIndex: 1, lastReadAt: 1, done: true }],
    ['new', { chapterIndex: 3, lastReadAt: 1, done: true, charOffset: 24000 }],
    ['chaptered', { chapterIndex: 9, lastReadAt: 1, done: true }],
    ['video', { chapterIndex: 1, lastReadAt: 1, done: true }],
    ['unfinished', { chapterIndex: 1, lastReadAt: 1 }]
  ]);
  const writes = [];
  const store = {
    progress: {
      get: (id) => (rows.has(id) ? { ...rows.get(id) } : null),
      set: (id, patch) => { writes.push([id, patch]); rows.set(id, { ...rows.get(id), ...patch }); return null; }
    }
  };
  const sources = [
    { id: 'legacy', type: 'url', url: 'https://example.invalid/legacy', chapters: [] },
    { id: 'new', type: 'url', url: 'https://example.invalid/new', chapters: [] },
    { id: 'chaptered', type: 'gutenberg', url: 'https://example.invalid/c', chapters: [{ title: '一', url: 'https://example.invalid/1' }] },
    { id: 'video', type: 'video', url: 'https://example.invalid/v', chapters: [] },
    { id: 'unfinished', type: 'url', url: 'https://example.invalid/u', chapters: [] }
  ];
  assert.deepEqual(migrateLegacySegmentedProgress({ sources, store, digestChars: 6000 }), ['legacy'], '只纠偏单页遗留行');
  assert.deepEqual(writes, [['legacy', { done: false, charOffset: 6000 }]], '从一轮消化量处续读，不重读开头');
  assert.equal(rows.get('new').done, true, '新语义的 done 行不动');
  assert.equal(rows.get('chaptered').done, true, '章节源不动');
  assert.equal(rows.get('video').done, true, '字幕源不动');
  assert.equal(rows.get('unfinished').done, undefined);
  // store 缺失或写入失败时保持原样，不抛异常。
  assert.deepEqual(migrateLegacySegmentedProgress({ sources, store: null, digestChars: 6000 }), []);
});

test('单页长篇：材料按 digestChars 预算截断，没读完不标 done，只记偏移', async () => {
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
    assert.ok(prompts[0].includes('第一段内容写得比较慢'), '预算内仍要留下一块材料');
    assert.equal(prompts[0].includes('第二段继续往下讲'), false, '超预算的部分这一轮不该喂给模型');
    const progress = JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'leisure-progress.json'), 'utf8'));
    const row = Object.values(progress)[0];
    assert.equal(row.done, undefined, '正文没读完的单页来源不得标 done');
    assert.ok(row.charOffset > 0 && row.charOffset <= 1200, `预算下限仍保留一块材料，偏移应等于这块的字符数，实际 ${row.charOffset}`);
    assert.equal(h.outerWorldStatus().limits.digestChars, 800);
  } finally {
    await h.close();
  }
});

// ── 单页文本按字符偏移连续阅读（旧语义读一轮就 done，会让整条见闻线永久空转） ──
const HEAD = '开头暗号';
const MARK = '中段标记';
// 8003 字符；MARK 从 6498 开始，落在默认一轮预算（6000）之外、第二轮之内。
const LONG_TEXT = `${HEAD}${'甲'.repeat(6494)}${MARK}。${'乙'.repeat(1500)}`;
const CHAPTER_TEXT = `${'这一章她读得很慢，句子一段接一段。'.repeat(12)}`;

function progressRows(h) {
  try {
    return JSON.parse(fs.readFileSync(path.join(h.temp, 'state', 'leisure-progress.json'), 'utf8'));
  } catch {
    return {};
  }
}

function writeProgressRows(h, rows) {
  fs.mkdirSync(path.join(h.temp, 'state'), { recursive: true });
  fs.writeFileSync(path.join(h.temp, 'state', 'leisure-progress.json'), JSON.stringify(rows), 'utf8');
}

/** 把某条进度的 lastReadAt 拨回昨天：模拟下一次调度，而不是当天重复读。 */
function rewindSource(h, id) {
  const rows = progressRows(h);
  rows[id] = { ...rows[id], lastReadAt: 0 };
  writeProgressRows(h, rows);
}

function outerWorldHarness(configLeisure) {
  return bridgeHarness({
    config: {
      features: { outerWorld: true },
      simulation: {
        outerWorld: { leisure: { enabled: true, sources: [], maxItemsPerDay: 20, tokenBudget: 0, ...configLeisure }, digest: { pushToOwner: false } }
      }
    }
  });
}

test('单页长篇连续阅读：续读出第二张卡片、读完才 done、旧 done 行会迁移', async (t) => {
  const prompts = [];
  const generate = async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ summary: `梗概${prompts.length}。`, quote: '材料里没有的句子。' });
  };
  const fetchText = async () => LONG_TEXT;
  const h = await outerWorldHarness({});
  try {
    const BIG = { id: 'big-book', title: '连载长文', url: 'https://example.com/big' };

    await t.test('第一轮读满预算：只记偏移、不标 done', async () => {
      h.cfg.simulation.outerWorld.leisure.sources = [BIG];
      const r = await h.runOuterWorld('ow-1', { fetchText, generate });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.equal(r.note.title, '连载长文');
      assert.ok(prompts[0].includes(HEAD), '第一轮材料应含开头');
      assert.equal(prompts[0].includes(MARK), false, '第一轮预算（6000）不应覆盖到中后段标记');
      assert.match(r.note.dedupeKey, /^[0-9a-f]{16}:p0$/, '去重 key 必须带分段序号');
      const row = progressRows(h)['big-book'];
      assert.equal(row.charOffset, 6000, 'charOffset 应记录本轮实际消化的字符数');
      assert.equal(row.done, undefined, '没读完的单页长篇不得标 done');
    });

    await t.test('第二轮从偏移续读：产出第二张卡片，读完才 done', async () => {
      rewindSource(h, 'big-book');
      const before = prompts.length;
      const r = await h.runOuterWorld('ow-2', { fetchText, generate });
      assert.equal(r.ok, true, JSON.stringify(r));
      const prompt2 = prompts[before];
      assert.ok(prompt2.includes(MARK), '第二轮材料应从偏移之后开始，包含中段标记');
      assert.equal(prompt2.includes(HEAD), false, '第二轮不应重读开头');
      assert.equal(r.note.title, '连载长文', '卡片标题措辞不变，不带分段序号字样');
      assert.equal(r.note.chapterIndex, 1, 'note.chapterIndex 要体现推进到第几段');
      assert.match(r.note.dedupeKey, /^[0-9a-f]{16}:p1$/);
      const row = progressRows(h)['big-book'];
      assert.equal(row.charOffset, LONG_TEXT.length, '偏移应恰好停在裁剪后正文末尾');
      assert.equal(row.done, true, '文本读消化完才应 done');
      const notes = fs.readFileSync(path.join(h.temp, 'state', 'outer-world-notes.jsonl'), 'utf8')
        .trim().split('\n').map((line) => JSON.parse(line)).filter((n) => n.sourceId === 'big-book');
      assert.equal(notes.length, 2, '同一单页来源连续两轮应产出两张卡片');
      assert.notEqual(notes[0].dedupeKey, notes[1].dedupeKey);
      assert.notEqual(notes[0].summary, notes[1].summary);
    });

    await t.test('新语义的 done 行（带 charOffset）不再被迁移', async () => {
      rewindSource(h, 'big-book');
      const r = await h.runOuterWorld('ow-3', { fetchText, generate });
      assert.equal(r.skipped, true);
      assert.equal(r.reason, 'no-source');
      const row = progressRows(h)['big-book'];
      assert.equal(row.charOffset, LONG_TEXT.length, '有 charOffset 一律按新语义走，不得清 done 重读');
      assert.equal(row.done, true);
    });

    await t.test('旧 done:true 且无 charOffset 的遗留行：迁移后从一轮消化量续读，而不是永久 no-source', async () => {
      // 旧语义遗留：单页源被整本标 done、chapterIndex=1、没有 charOffset 字段。
      const rows = progressRows(h);
      rows['legacy-book'] = { chapterIndex: 1, lastReadAt: 0, done: true };
      writeProgressRows(h, rows);
      h.cfg.simulation.outerWorld.leisure.sources = [{ id: 'legacy-book', title: '旧日遗留书', url: 'https://example.com/legacy' }];
      const before = prompts.length;
      const r = await h.runOuterWorld('legacy-migrate', { fetchText, generate });
      assert.equal(r.ok, true, JSON.stringify(r));
      assert.notEqual(r.skipped, true, '迁移后首轮就应正常产出卡片，而不是空转');
      const prompt = prompts[before];
      assert.ok(prompt.includes(MARK) && !prompt.includes(HEAD), '迁移后从默认一轮消化量（6000）处续读，不重读开头');
      assert.match(r.note.dedupeKey, /^[0-9a-f]{16}:p1$/, '分段序号沿用旧行的推进值');
      const row = progressRows(h)['legacy-book'];
      assert.equal(row.charOffset, LONG_TEXT.length);
      assert.equal(row.done, true, '剩余部分读消化完才重新 done');
    });
  } finally {
    await h.close();
  }
});

test('章节来源回归：逐章推进、去重 key 无分段后缀、不写 charOffset', async () => {
  const prompts = [];
  const generate = async (prompt) => {
    prompts.push(prompt);
    return JSON.stringify({ summary: `梗概${prompts.length}。`, quote: '这一章她读得很慢' });
  };
  const h = await outerWorldHarness({});
  try {
    h.cfg.simulation.outerWorld.leisure.sources = [{
      id: 'ch-book',
      chapters: [{ title: '第一章', url: 'https://example.com/c1' }, { title: '第二章', url: 'https://example.com/c2' }]
    }];
    const fetchText = async () => CHAPTER_TEXT;
    const r1 = await h.runOuterWorld('ch-1', { fetchText, generate });
    assert.equal(r1.ok, true, JSON.stringify(r1));
    assert.equal(r1.note.title, '第一章');
    assert.match(r1.note.dedupeKey, /^[0-9a-f]{16}$/, '章节来源的 key 保持原格式');
    let row = progressRows(h)['ch-book'];
    assert.equal(row.chapterIndex, 1);
    assert.equal(row.charOffset, undefined, '章节来源不写 charOffset');
    assert.equal(row.done, undefined);
    assert.equal(row.chaptersTotal, 2, '章节来源记录总章数');
    assert.ok(row.title, '进度带来源标题');

    rewindSource(h, 'ch-book');
    const r2 = await h.runOuterWorld('ch-2', { fetchText, generate });
    assert.equal(r2.ok, true, JSON.stringify(r2));
    assert.equal(r2.note.title, '第二章');
    row = progressRows(h)['ch-book'];
    assert.equal(row.chapterIndex, 2);
    assert.equal(row.done, true, '章节目录读完才 done');
    assert.equal(row.charOffset, undefined);
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
    assert.equal(store.quota.get(shanghaiDayKey()).chars, 0);
    assert.deepEqual(store.notes.list(), []);
    assert.equal(store.circuit.isOpen(), false);
    store.progress.get('nope');
    store.audit.read();
    assert.deepEqual(fs.readdirSync(dir), [], '只读操作不得创建任何文件');
    assert.equal(store.quota.inc(shanghaiDayKey(), { chars: 600 }).chars, 600, '今日阅读字数累计');
    assert.equal(store.quota.inc(shanghaiDayKey(), { chars: -1 }).chars, 600, '负数按 0 兜底');

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
