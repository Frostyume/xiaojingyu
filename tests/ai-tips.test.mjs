import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AI_TIP_CATEGORIES,
  rollDailyTarget,
  pickCategory,
  isDuplicateTip,
  normalizeTopicKey,
  windowBounds,
  inWindow,
  nextSlotAt,
  parseTipOutput,
  pickTipLinks,
  similarity,
  topicSimilarity
} from '../runtime/persona/ai-tips.js';

const at = (h, m = 0) => { const d = new Date(2026, 9, 28, h, m, 0, 0); return d.getTime(); };

test('每日目标落在 2–5 且包含边界', () => {
  assert.equal(rollDailyTarget(2, 5, () => 0), 2);
  assert.equal(rollDailyTarget(2, 5, () => 0.999), 5);
  const s = new Set();
  for (let i = 0; i < 200; i += 1) s.add(rollDailyTarget(2, 5));
  assert.deepEqual([...s].sort(), [2, 3, 4, 5]);
  assert.equal(rollDailyTarget(5, 2, () => 0), 2);
  assert.equal(rollDailyTarget(5, 2, () => 0.999), 5);
});

test('类别按最久未讲轮换，新类别随机优先', () => {
  assert.ok(AI_TIP_CATEGORIES.some((c) => pickCategory([], () => 0).id === c.id));
  const history = [{ category: 'basics' }, { category: 'llm' }];
  const next = pickCategory(history, () => 0);
  assert.notEqual(next.id, 'basics');
  assert.notEqual(next.id, 'llm');
  const all = AI_TIP_CATEGORIES.map((c) => ({ category: c.id }));
  const rotated = pickCategory(all, () => 0);
  assert.ok(AI_TIP_CATEGORIES.some((c) => c.id === rotated.id));
});

test('去重：同题、相近题、相近文案都算重复', () => {
  const history = [{ topic: '为什么手机总推你想买的东西', text: '这是推荐系统在猜你喜欢，看的是点击和停留。' }];
  assert.equal(isDuplicateTip({ topic: '为什么手机总推你想买的东西' }, history).duplicate, true);
  assert.equal(isDuplicateTip({ topic: '手机为什么老推荐想买的东西' }, history).duplicate, true);
  assert.equal(isDuplicateTip({ topic: '语音助手怎么听懂人话' }, history).duplicate, false);
  assert.equal(isDuplicateTip({ topic: '推荐系统', text: '这是推荐系统在猜你喜欢，看的是点击和停留时间。' }, history).duplicate, true);
  assert.equal(normalizeTopicKey('AI 是什么？'), normalizeTopicKey('ai是什么'));
  assert.ok(topicSimilarity('为什么手机总推你想买的东西', '手机为什么老推荐想买的东西') > 0.65);
  assert.ok(similarity('为什么手机总推你想买的东西', '手机为什么老推荐想买的东西') < 0.6);
});

test('时间窗：普通窗口与跨夜窗口', () => {
  const day = windowBounds(at(10), 9, 22);
  assert.equal(new Date(day.start).getHours(), 9);
  assert.equal(new Date(day.end).getHours(), 22);
  assert.equal(inWindow(at(9, 0), 9, 22), true);
  assert.equal(inWindow(at(22, 0), 9, 22), false);
  assert.equal(inWindow(at(8, 59), 9, 22), false);
  const night = windowBounds(at(23), 22, 6);
  assert.ok(night.end > night.start);
  const endDate = new Date(night.end);
  assert.equal(endDate.getHours(), 6);
  assert.equal(endDate.getDate(), 29);
  assert.equal(inWindow(at(23), 22, 6), true);
  assert.equal(inWindow(at(12), 22, 6), false);
});

test('下一时间点：遵守最小间隔且落在窗口内', () => {
  const now = at(10);
  const next = nextSlotAt({ now, lastSentAt: at(9), minGapMs: 90 * 60000, jitterMs: 0, startHour: 9, endHour: 22 }, () => 0);
  assert.equal(next, at(10, 30));
  assert.equal(inWindow(next, 9, 22), true);
  const afterClose = nextSlotAt({ now: at(22, 30), lastSentAt: at(21), minGapMs: 60 * 60000, jitterMs: 0, startHour: 9, endHour: 22 }, () => 0);
  const d = new Date(afterClose);
  assert.equal(d.getHours(), 9);
  assert.equal(d.getDate(), 29);
  const beforeOpen = nextSlotAt({ now: at(7), lastSentAt: 0, minGapMs: 0, jitterMs: 0, startHour: 9, endHour: 22 }, () => 0);
  assert.equal(beforeOpen, at(9));
});

test('输出解析：JSON、纯文本、超长、空、标题', () => {
  const j = parseTipOutput('{"topic":"推荐系统","category":"recommend","title":"协同过滤：推荐为什么越刷越准","techName":"协同过滤","phenomenon":"推荐越来越像你","tech":"协同过滤：按相似的人找内容","how":"记录点击停留，再找相似的人","terms":[{"name":"相似度","plain":"两个人爱看的东西有多像"}],"text":"手机不是偷听你，它只是在算你更可能点哪一个，停留时间也算一票，所以越用越准也越容易困住你。","keyTerm":"CF","searchQuery":"推荐系统 原理"}');
  assert.equal(j.ok, true);
  assert.equal(j.topic, '推荐系统');
  assert.equal(j.title, '协同过滤：推荐为什么越刷越准');
  assert.equal(j.techName, '协同过滤');
  assert.equal(j.terms[0].name, '相似度');
  assert.equal(j.category, 'recommend');
  assert.equal(j.tech, '协同过滤：按相似的人找内容');
  assert.equal(j.keyTerm, 'CF');
  assert.equal(j.searchQuery, '推荐系统 原理');
  const plain = parseTipOutput('今天说说语音助手。它不是听懂每个字，而是根据声音猜最像的那句话，所以口音重时容易猜错。');
  assert.equal(plain.ok, true);
  assert.ok(plain.title.length > 0);
  assert.equal(parseTipOutput('太短').ok, false);
  assert.equal(parseTipOutput('{"text":"' + '啊'.repeat(200) + '"}', { maxChars: 120 }).ok, false);
  assert.equal(parseTipOutput('{"title":"' + '标'.repeat(25) + '","text":"这是一个足够长的正文，用来测试标题超长时会被拒绝的情况。"}').error, 'title-too-long');
  assert.equal(parseTipOutput('').ok, false);
});

test('延伸链接：优先可信站点、同站去重、跳过视频站', () => {
  const results = [
    { title: '推荐系统原理详解', url: 'https://www.zhihu.com/question/1', snippet: '原理 实现' },
    { title: '推荐系统是什么', url: 'https://zhuanlan.zhihu.com/p/2', snippet: '科普' },
    { title: '推荐系统', url: 'https://www.douyin.com/video/3', snippet: '视频' },
    { title: '推荐系统入门', url: 'https://www.kepuchina.cn/a', snippet: '机制' },
    { title: '无关内容', url: 'https://example.com/x', snippet: '' }
  ];
  const links = pickTipLinks(results, '推荐系统', { max: 2 });
  assert.equal(links.length, 2);
  assert.ok(links.every((l) => !l.url.includes('douyin')));
  assert.equal(new Set(links.map((l) => new URL(l.url).hostname)).size, links.length);
  assert.ok(links.some((l) => l.url.includes('zhihu') || l.url.includes('kepuchina')));
  assert.equal(pickTipLinks([], '推荐系统').length, 0);

  const rtb = [
    { title: '定向招生_百度百科', url: 'https://baike.baidu.com/item/定向招生', snippet: '' },
    { title: '一张图读懂RTA&RTB', url: 'https://zhuanlan.zhihu.com/p/473114813', snippet: '实时竞价' },
    { title: 'RTB广告_百度百科', url: 'https://baike.baidu.com/item/RTB广告', snippet: '' }
  ];
  const picked = pickTipLinks(rtb, '广告为什么像在跟着你', { max: 3, keyTerm: 'RTB' });
  assert.equal(picked.length, 2);
  assert.ok(picked.every((l) => /RTB|RTA/i.test(l.title)));
  assert.ok(picked.every((l) => !l.url.includes('定向招生')));
  assert.equal(pickTipLinks([{ title: 'x', url: 'https://vertexaisearch.cloud.google.com/x' }], 'x', { keyTerm: 'x' }).length, 0);

  const cnn = [
    { title: '卷积神经网络 (CNN)原理讲解', url: 'https://zhuanlan.zhihu.com/p/1', snippet: '卷积 特征' },
    { title: '美国有线电视新闻网_百度百科', url: 'https://baike.baidu.com/item/x', snippet: 'CNN 新闻' },
    { title: '一文搞懂CNN卷积神经网络', url: 'https://blog.csdn.net/x', snippet: '卷积' }
  ];
  const cnnPicked = pickTipLinks(cnn, '图像识别', { keyTerm: 'CNN', techName: '卷积神经网络', max: 3 });
  assert.equal(cnnPicked.length, 2);
  assert.ok(cnnPicked.every((l) => /卷积|CNN/.test(l.title)));
  assert.ok(!cnnPicked.some((l) => l.title.includes('电视')));
});
