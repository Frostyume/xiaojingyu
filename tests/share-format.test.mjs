import test from 'node:test';
import assert from 'node:assert/strict';
import {
  paragraphizeShareText,
  normalizeParagraphs,
  formatShareCaption,
  formatShareLinksText,
  formatAiTipLinks,
  formatTipCaption
} from '../runtime/share/share-format.js';

const INDENT = '\u3000\u3000';

const FIVE = '装个新软件，一打开就跳出好几个框。很多授权其实用不上。比如读通讯录、看短信。能不给的就不给。位置权限改成仅使用期间。';
const THREE = '刷到的内容越来越像你爱看的。这背后是推荐系统的协同过滤。它靠相似的人喜欢什么来猜。';

function contentLines(caption) {
  return caption.split('\n').filter((line) => line.trim() !== '');
}

test('标题后恰好一个空行，且全长不出现连续三换行', () => {
  const caption = formatShareCaption({ title: '隐私授权：权限要那么多干什么', text: FIVE }, 'knowledge');
  assert.ok(caption.startsWith('隐私授权：权限要那么多干什么\n\n'), caption);
  assert.doesNotMatch(caption, /\n{3,}/);
});

test('多段正文段首不缩进，段间一个空行', () => {
  const body = paragraphizeShareText(FIVE, 'knowledge');
  const paragraphs = body.split('\n\n');
  assert.equal(paragraphs.length, 2);
  const caption = formatShareCaption({ title: '标题', text: FIVE }, 'knowledge');
  const lines = contentLines(caption);
  assert.equal(lines[0], '标题');
  for (const line of lines.slice(1)) assert.ok(!line.startsWith(INDENT), line);
  assert.ok(!caption.includes(INDENT), caption);
  assert.equal(caption.split('\n\n').length, 3); // 标题 / 2 段正文
});

test('三段正文（≥7 句）段首也不缩进', () => {
  const seven = '第一句。第二句。第三句。第四句。第五句。第六句。第七句。';
  const body = paragraphizeShareText(seven, 'finance');
  assert.equal(body.split('\n\n').length, 3);
  const caption = formatShareCaption({ title: '年化收益率', text: seven }, 'finance');
  for (const line of contentLines(caption).slice(1)) assert.ok(!line.startsWith(INDENT), line);
  assert.ok(!caption.includes(INDENT), caption);
});

test('单段正文不缩进', () => {
  const caption = formatShareCaption({ title: '机器学习', text: THREE }, 'knowledge');
  assert.equal(caption, `机器学习\n\n${THREE}`);
});

test('riskNote 与正文之间恰好一个空行', () => {
  const caption = formatShareCaption({ title: '标题', text: THREE, riskNote: '仅为科普，不构成投资建议。' }, 'knowledge');
  assert.ok(caption.endsWith(`\n\n仅为科普，不构成投资建议。`));
  assert.doesNotMatch(caption, /\n{3,}/);
});

test('空文本/空标题不产生多余空行', () => {
  assert.equal(formatShareCaption({ title: '只有标题', text: '' }, 'knowledge'), '只有标题');
  assert.equal(formatShareCaption({ title: '', text: THREE }, 'knowledge'), THREE);
  assert.equal(formatShareCaption({}, 'knowledge'), '');
});

test('延伸阅读：标题一行、其后空行、条目间空行且条目不缩进', () => {
  const links = [
    { title: '什么是隐私授权', url: 'https://example.com/a' },
    { title: '权限管理指南', url: 'https://example.com/b' }
  ];
  const text = formatShareLinksText(links, { imageHosts: 'example.com' });
  assert.equal(text, [
    '延伸阅读：',
    '',
    '1. 什么是隐私授权',
    'https://example.com/a',
    '',
    '2. 权限管理指南',
    'https://example.com/b',
    '',
    '配图来源：example.com'
  ].join('\n'));
  for (const line of text.split('\n')) assert.ok(!line.startsWith(INDENT));
});

test('来源未被条目覆盖时单独成段，且最多三条', () => {
  const links = [1, 2, 3, 4].map((i) => ({ title: `条目${i}`, url: `https://example.com/${i}` }));
  const text = formatShareLinksText(links, { sourceUrl: 'https://example.com/x' });
  assert.equal((text.match(/^\d+\. /gm) || []).length, 3);
  assert.ok(text.endsWith('\n\n来源：https://example.com/x'));
});

test('小知识延伸阅读同样排版', () => {
  const text = formatAiTipLinks([{ title: '协同过滤', url: 'https://example.com/cf' }], 'zhihu.com');
  assert.equal(text, ['延伸阅读：', '', '1. 协同过滤', 'https://example.com/cf', '', '配图来源：zhihu.com'].join('\n'));
});

test('normalizeParagraphs 主动剥掉已有全角缩进（非空操作），且幂等', () => {
  // 锚点/反空操作：喂进带缩进的旧文本，必须被剥成无缩进，证明函数真的在去缩进。
  assert.equal(normalizeParagraphs(`${INDENT}第一段\n\n${INDENT}第二段`), '第一段\n\n第二段');
  const once = normalizeParagraphs(paragraphizeShareText(FIVE, 'knowledge'));
  assert.equal(normalizeParagraphs(once), once);
  assert.ok(!once.includes(INDENT), once);
});

test('小知识正文统一走同一 formatter（不缩进）', () => {
  const caption = formatTipCaption({ title: '隐私授权', text: FIVE });
  assert.ok(caption.startsWith('隐私授权\n\n'));
  for (const line of contentLines(caption).slice(1)) assert.ok(!line.startsWith(INDENT), line);
  assert.ok(!caption.includes(INDENT), caption);
});
