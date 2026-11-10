#!/usr/bin/env node
// 她在读：percent 口径 / 章节语义 / 旧数据兼容（纯函数，不读写状态文件）。
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReadingSnapshot, readingPercent, readingToday } from '../services/social/outer-world/reading-progress.js';

test('percent：单页按字符、章节按读完章数、done 优先', () => {
  // 单页文本：charOffset / totalChars，四舍五入到整数百分比。
  assert.equal(readingPercent({ totalChars: 400, charOffset: 100 }), 25);
  assert.equal(readingPercent({ totalChars: 40000, charOffset: 11399 }), 28);
  assert.equal(readingPercent({ totalChars: 400, charOffset: 0 }), 0);
  assert.equal(readingPercent({ totalChars: 100, charOffset: 150 }), 100, '偏移越界封顶 100');
  assert.equal(readingPercent({ totalChars: 500, charOffset: 500 }), 100);

  // 章节来源：chapterIndex 是「下一次要读的下标」，完成度 = 已读完章数 / 总章数。
  assert.equal(readingPercent({ chapterIndex: 0, chaptersTotal: 10 }), 0);
  assert.equal(readingPercent({ chapterIndex: 2, chaptersTotal: 10 }), 20);
  assert.equal(readingPercent({ chapterIndex: 10, chaptersTotal: 10 }), 100);
  assert.equal(readingPercent({ chapterIndex: 99, chaptersTotal: 10 }), 100, '越界封顶');
  assert.equal(readingPercent({ chapterIndex: 3, chaptersTotal: 10, totalChars: 0 }), 30, 'totalChars 为 0 时按章节');

  // done 一律 100；旧单页数据（无 totalChars、无章节）不猜百分比。
  assert.equal(readingPercent({ done: true }), 100);
  assert.equal(readingPercent({ done: true, totalChars: 100, charOffset: 1 }), 100);
  assert.equal(readingPercent({}), null);
});

test('快照：排序、旧数据、章节与视频来源', () => {
  const sources = [
    { id: 'legacy-book', title: '旧书', type: 'url', chapters: [] },
    { id: 'new-book', title: '新书', type: 'url', chapters: [] },
    { id: 'ch-book', title: '章节书', type: 'url', chapters: [{ url: 'a' }, { url: 'b' }, { url: 'c' }, { url: 'd' }] },
    { id: 'video-1', title: '视频一', type: 'video', chapters: [] },
    { id: 'idle-book', title: '没开始', type: 'url', chapters: [] }
  ];
  const progress = {
    'legacy-book': { chapterIndex: 2, charOffset: 11399, lastReadAt: 1000, done: false },
    'new-book': { title: '新书', chapterIndex: 0, charOffset: 6000, totalChars: 24000, lastReadAt: 4000, done: true },
    'ch-book': { chapterIndex: 1, chaptersTotal: 4, lastReadAt: 3000, done: false },
    'video-1': { chapterIndex: 1, lastReadAt: 2000, done: true }
  };

  const items = buildReadingSnapshot({ sources, progress, now: 5000 });
  assert.equal(items.length, 4, '没有进度的来源不出现');
  assert.equal(items[0].id, 'new-book', '按最后阅读时间倒序');
  assert.equal(items[0].percent, 100, 'done 优先');
  assert.equal(items[0].kind, 'book');

  const legacy = items.find((item) => item.id === 'legacy-book');
  assert.equal(legacy.percent, null, '旧数据不猜 percent');
  assert.equal(legacy.note, '进度待下次阅读后补齐');
  assert.equal(legacy.totalChars, null);
  assert.equal(legacy.charOffset, 11399, '保留已读字数用于展示');
  assert.equal(legacy.title, '旧书', '标题回退到来源配置');
  assert.equal(legacy.chaptersTotal, 0);

  const ch = items.find((item) => item.id === 'ch-book');
  assert.equal(ch.chaptersTotal, 4, '章节总数来自来源配置');
  assert.equal(ch.percent, 25, 'chapterIndex=1 表示读完第 1 章');
  assert.equal(ch.note, undefined);

  const video = items.find((item) => item.id === 'video-1');
  assert.equal(video.kind, 'video');
  assert.equal(video.done, true);
  assert.equal(video.percent, 100);

  // 旧数据缺 title / 缺章节数时仍能给出安全项；标题不泄露 URL。
  const fallback = buildReadingSnapshot({
    sources: [{ id: 'x', title: '某本书', type: 'url' }],
    progress: { x: { chapterIndex: 0 } }
  });
  assert.equal(fallback[0].title, '某本书');
  assert.equal(fallback[0].percent, null);
  assert.equal(fallback[0].lastReadAt, 0);
});

test('今日汇总：旧 quota 没 chars 时 charsKnown=false，不伪造字数', () => {
  assert.deepEqual(readingToday({ day: '2026-11-10', items: 1, tokens: 1429 }), {
    day: '2026-11-10', items: 1, chars: 0, tokens: 1429, charsKnown: false
  });
  assert.deepEqual(readingToday({ day: '2026-11-10', items: 2, chars: 12000, tokens: 3000 }), {
    day: '2026-11-10', items: 2, chars: 12000, tokens: 3000, charsKnown: true
  });
  assert.deepEqual(readingToday(null), { day: '', items: 0, chars: 0, tokens: 0, charsKnown: false });

  // 空输入安全。
  assert.deepEqual(buildReadingSnapshot(), []);
  assert.deepEqual(buildReadingSnapshot({ sources: null, progress: null }), []);
});
