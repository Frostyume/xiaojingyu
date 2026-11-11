#!/usr/bin/env node
// 实时页排版契约：折叠不删数据 / 图谱小正方形 / 心情两列 / 摘录来自真实持久化数据。
// 纯静态断言 + 纯函数单测，不启动桥接、不碰运行期状态。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { attachReadingExcerpts, outerNotesSnapshot } from '../services/social/outer-world/reading-progress.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const html = fs.readFileSync(path.join(ROOT, 'web', 'live.html'), 'utf8');

let bad = 0;
const ok = (cond, name, extra = '') => {
  if (cond) console.log(`  OK   ${name}${extra ? ' — ' + extra : ''}`);
  else { bad++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
};

console.log('## 原有卡片数据锚点全部保留（折叠 ≠ 删除）');
// 重构前 live.html 的全部元素 ID：一个都不许少。
const REQUIRED_IDS = [
  'app', 'sprite', 'selfLine', 'moodSpeech', 'heroPills', 'lastUpdate', 'connState',
  'flow', 'relGraph', 'bondOwner', 'bonds',
  'compass', 'moodDot', 'moodLabel', 'moodUpdated', 'moodCause', 'moodCurve', 'energy', 'energyText', 'moodNote',
  'interests', 'learnings', 'quirks', 'timeline', 'innerCounts', 'innerNote',
  'readingCard', 'readingTag', 'readingList', 'readingToday', 'signals',
  'sessionTag', 'sessions', 'feed', 'health', 'usage', 'usageNote',
  'memoryFacts', 'libraries',
  'login', 'tokenInput', 'loginBtn', 'loginErr'
];
const missingIds = (doc) => REQUIRED_IDS.filter((id) => !doc.includes(`id="${id}"`));
ok(missingIds(html).length === 0, '原有数据锚点都在', missingIds(html).join(', ') || `${REQUIRED_IDS.length} 个`);
// 红自测：检查器本身必须能抓到「锚点被删」——否则上面的绿灯没有意义。
ok(
  JSON.stringify(missingIds(html.replace('id="memoryFacts"', 'id="memoryFactsX"'))) === JSON.stringify(['memoryFacts']),
  '红自测：删掉一个锚点时检查器会报缺失'
);
const ids = [...html.matchAll(/\sid="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]);
ok(ids.length === new Set(ids).size, 'ID 唯一', `共 ${ids.length} 个`);

console.log('## 关系图谱：小正方形，径向布局仍可用');
ok(/\.rel-graph\{[^}]*aspect-ratio:1\/1/.test(html), '容器是正方形（aspect-ratio:1/1）');
ok(/\.rel-graph\{[^}]*width:min\(100%,380px\)/.test(html), '边长上限 380px');
ok(html.includes('function renderRelationshipGraph(host,'), '图谱渲染函数仍在');
ok(/const W = 380;\s*\n\s*const H = 380;/.test(html), 'viewBox 是正方形，布局随容器缩放');
ok(!/const W = 760;/.test(html), '不再是 760 宽横条 viewBox');

console.log('## 心情 × 图谱：宽屏两列、窄屏堆叠');
const moodCard = html.match(/<section class="card span-6">\s*<h2>心情 \/ 精力[\s\S]*?<\/section>/);
const graphCard = html.match(/<section class="card span-6">\s*<h2>关系图谱[\s\S]*?<\/section>/);
ok(Boolean(moodCard), '心情卡是 span-6 半宽');
ok(Boolean(graphCard) && graphCard[0].includes('id="relGraph"'), '图谱卡是 span-6 半宽且含 relGraph');
ok(moodCard && graphCard && html.indexOf(moodCard[0]) < html.indexOf(graphCard[0]), '心情在左、图谱在右（同一行）');
ok(html.includes('.span-7,.span-5,.span-4,.span-6{grid-column:span 12}'), '窄屏（≤760px）span-6 堆叠为整宽');

console.log('## 次要板块默认收起、可手动展开（数据仍在 DOM）');
for (const [cardId, innerId, span] of [['signalsCard', 'signals', 'span-12'], ['memoryCard', 'memoryFacts', 'span-6'], ['libraryCard', 'libraries', 'span-6']]) {
  const block = html.match(new RegExp(`<details class="card fold ${span}" id="${cardId}">[\\s\\S]*?</details>`));
  ok(Boolean(block), `${cardId} 是原生 details 折叠卡`);
  ok(Boolean(block) && block[0].includes(`id="${innerId}"`), `${cardId} 折叠后数据锚点 ${innerId} 仍在 DOM`);
  ok(Boolean(block) && block[0].includes('<summary>'), `${cardId} 有可点击的 summary`);
}
ok(!/<details[^>]*\sopen[\s>]/.test(html), '所有折叠卡默认收起（无 open 属性）');
ok(/details\.fold\[open\]>summary::after\{transform:rotate\(90deg\)\}/.test(html), '展开态有视觉反馈');

console.log('## 读书/见闻可视化：渲染真实快照字段，无数据不编造');
ok(html.includes('item.excerpt'), '读书条目渲染 excerpt 字段');
ok(html.includes('最新读到 · 原文摘录') && html.includes('最新读到 · 消化摘要'), '摘录/摘要有区分标签');
ok(html.includes('还没有摘录，下次阅读后生成'), '没有摘录时明说，不放占位内容');
ok(html.includes('data.outerNotes'), '出门见闻渲染 outerNotes 条目');
ok(html.includes('更早的见闻'), '多条见闻折叠展开');
ok(/charOffset/.test(html) && /reading-bar/.test(html), '进度仍显示 charOffset 与进度条');

console.log('## 摘录派生纯函数：只认真实笔记，取最新，不改输入');
const notes = [
  { id: 'n2', sourceId: 'b1', title: '海底两万里', quote: '大海就是一切。', summary: '摘要B', at: 2000, sourceHost: 'www.gutenberg.org', chapterIndex: 1 },
  { id: 'n1', sourceId: 'b1', title: '海底两万里', quote: '旧摘句。', summary: '摘要A', at: 1000, sourceHost: 'www.gutenberg.org', chapterIndex: 0 },
  { id: 'n3', sourceId: 'b2', title: '别的书', quote: '', summary: '', at: 3000, sourceHost: '', chapterIndex: 0 }
];
const items = [
  { id: 'b1', title: '海底两万里', percent: 19 },
  { id: 'b2', title: '别的书', percent: null },
  { id: 'b3', title: '无笔记的书', percent: 5 }
];
const attached = attachReadingExcerpts(items, notes);
ok(attached[0].excerpt?.quote === '大海就是一切。' && attached[0].excerpt?.at === 2000, '取该来源最新一条笔记（按 at）');
ok(!attached[1].excerpt, 'quote/summary 全空不挂 excerpt');
ok(!attached[2].excerpt, '没有笔记不挂 excerpt（不编造）');
ok(items[0].excerpt === undefined, '不改动输入数组');
ok(attachReadingExcerpts(items, [notes[1], notes[0]])[0].excerpt?.at === 2000, '笔记乱序也取最新');
ok(attachReadingExcerpts(items, null)[0].excerpt === undefined, '空笔记安全');
ok(attachReadingExcerpts(null, notes).length === 0, '空条目安全');
const longQuote = '字'.repeat(300);
const snap = outerNotesSnapshot([{ id: 'x'.repeat(40), title: 't'.repeat(120), quote: longQuote, summary: 's'.repeat(400), at: 1, sourceId: 'b1', sourceHost: 'h'.repeat(90) }, null, { title: '', summary: '', quote: '' }], { limit: 5 });
ok(snap.length === 1, '过滤空行与坏行');
ok(snap[0].quote.length === 160 && snap[0].summary.length === 200 && snap[0].title.length === 80 && snap[0].id.length === 12 && snap[0].sourceHost.length === 60, '字段截断上限');
ok(outerNotesSnapshot(notes, { limit: 2 }).length === 2, 'limit 生效');
ok(outerNotesSnapshot(null).length === 0, '空输入安全');
// 红自测：派生函数必须拒绝「无笔记却有摘录」——用篡改检查证明断言有效。
const fakeAttached = attachReadingExcerpts([{ id: 'ghost', title: '幽灵书' }], []);
ok(fakeAttached[0].excerpt === undefined, '红自测：无笔记的书绝不会凭空出现摘录');

console.log('## bridge 快照接线：只读、局部');
const bridge = fs.readFileSync(path.join(ROOT, 'app', 'whale.js'), 'utf8');
ok(bridge.includes('attachReadingExcerpts(outerWorldReading(), recentNotes)'), 'reading 条目挂摘录走纯函数');
ok(bridge.includes('outerNotes: featureOuterNotes'), '快照新增 outerNotes 只读字段');
const fnStart = bridge.indexOf('function buildLiveSnapshot()');
const fnEnd = bridge.indexOf('// ── 表情包体系');
const fnBody = bridge.slice(fnStart, fnEnd);
ok(fnStart > 0 && fnEnd > fnStart, '能定位 buildLiveSnapshot 函数体');
ok(!/\.set\(|\.append\(|atomicWrite|writeFile/.test(fnBody), '快照构建里没有写操作（只读）');

console.log('## 前端 JS 语法');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
const big = scripts.sort((a, b) => b.length - a.length)[0];
try { new Function(big); ok(true, '主 script 语法可解析', `${big.length} 字符`); }
catch (e) { ok(false, '主 script 语法', e.message); }

console.log(bad === 0 ? '\n全部通过' : `\n${bad} 项失败`);
if (bad > 0) process.exit(1);