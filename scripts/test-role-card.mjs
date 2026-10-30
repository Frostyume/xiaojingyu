// 人格卡按仿真模式取用（src/role-card.js）的离线单测。
// 保证：模式标记能被正确识别与剥离、未标记的老卡片行为不变、真实人格卡可用。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { parseRoleSections, roleCharStats, roleSectionReport, selectRoleText } from '../src/role-card.js';

const CARD = [
  '# 角色卡：测试',
  '',
  '## 一、你是谁',
  '- 你是群里的测试角色。',
  '',
  '## 二、分条方式 〔旧版〕',
  '- 想分条就用空格分隔；想沉默就输出 [SILENT]。',
  '',
  '## 三、发言方式 〔仿真〕',
  '- 用 qq_send_message 的数组分条，潜水走 qq_mark_read。',
  '',
  '## 四、说话风格',
  '- 简短、口语化。',
].join('\n');

test('模式标记能被识别，未标记的小节两种模式都注入', () => {
  const sections = parseRoleSections(CARD);
  const byHeading = Object.fromEntries(sections.filter((s) => s.heading).map((s) => [s.heading, s.mode]));
  assert.equal(byHeading['一、你是谁'], 'all');
  assert.equal(byHeading['二、分条方式'], 'legacy');
  assert.equal(byHeading['三、发言方式'], 'simulation');
  assert.equal(byHeading['四、说话风格'], 'all');
});

test('按模式筛选：只保留公共小节 + 该模式专属小节', () => {
  const v1 = selectRoleText(CARD, 'legacy');
  const simulationText = selectRoleText(CARD, 'simulation');
  // 公共内容两边都有
  for (const text of [v1, simulationText]) {
    assert.match(text, /你是群里的测试角色/);
    assert.match(text, /简短、口语化/);
  }
  // 专属内容互不串场
  assert.match(v1, /空格分隔/);
  assert.doesNotMatch(v1, /qq_send_message/);
  assert.match(simulationText, /qq_send_message/);
  assert.doesNotMatch(simulationText, /\[SILENT\]/);
});

test('注入文本里不再残留模式标记', () => {
  assert.doesNotMatch(selectRoleText(CARD, 'legacy'), /〔旧版〕|〔仿真〕/);
  assert.doesNotMatch(selectRoleText(CARD, 'simulation'), /〔旧版〕|〔仿真〕/);
  // 标题保留但已清洗
  assert.match(selectRoleText(CARD, 'simulation'), /## 三、发言方式\n/);
});

test('多种标记写法都认（[legacy] / （simulation） / 〔群聊仿真〕）', () => {
  const card = [
    '## A [legacy]', '- a',
    '## B （simulation）', '- b',
    '## C 〔群聊仿真〕', '- c',
    '## D [旧版]', '- d',
  ].join('\n');
  const v1 = selectRoleText(card, 'legacy');
  const simulationText = selectRoleText(card, 'simulation');
  assert.match(v1, /- a/); assert.match(v1, /- d/);
  assert.doesNotMatch(v1, /- b/); assert.doesNotMatch(v1, /- c/);
  assert.match(simulationText, /- b/); assert.match(simulationText, /- c/);
  assert.doesNotMatch(simulationText, /- a/); assert.doesNotMatch(simulationText, /- d/);
});

test('没有模式标记的老卡片：两种模式都完整注入（向后兼容）', () => {
  const legacy = '# 老卡\n\n- 性格：傲娇\n- 说话风格：简短';
  assert.equal(selectRoleText(legacy, 'legacy'), legacy);
  assert.equal(selectRoleText(legacy, 'simulation'), legacy);
});

test('标题之外的内容（前言）不受影响', () => {
  const card = '开头一句话\n\n## X 〔旧版〕\n- x\n\n## Y\n- y';
  assert.match(selectRoleText(card, 'simulation'), /开头一句话/);
  assert.doesNotMatch(selectRoleText(card, 'simulation'), /- x/);
  assert.match(selectRoleText(card, 'simulation'), /- y/);
});

test('统计与小节报告可用于控制台预览', () => {
  const stats = roleCharStats(CARD);
  assert.ok(stats.legacyOnly > 0 && stats.simulationOnly > 0, '应能统计出两种模式各自专属的字符数');
  assert.ok(stats.legacy < stats.total && stats.simulation < stats.total, '筛选后应短于原文');
  assert.notEqual(stats.legacy, stats.simulation, '两种模式内容不同，长度不应相等');
  const report = roleSectionReport(CARD, 'legacy');
  const simulationSection = report.find((r) => r.heading === '三、发言方式');
  assert.equal(simulationSection.injected, false, '仿真专属小节在旧版下应标为不注入');
  const common = report.find((r) => r.heading === '一、你是谁');
  assert.equal(common.injected, true);
});

// 注入预算：运行时不做截断，这条守卫只防止人格文本无限膨胀。2026-10-30 由 8000 提到 10000
// （主仓角色卡当时正好 8000/8000、零余量，任何编辑都会被测试挡下）。
const ROLE_INJECT_MAX_CHARS = 10000;

test('小鲸鱼的颜文字库使用半角括号、覆盖足够多且不超注入上限', () => {
  const raw = fs.readFileSync(new URL('../roles/小鲸鱼.md', import.meta.url), 'utf8');
  const start = raw.indexOf('颜文字工具箱');
  const end = raw.indexOf('短句优先用小的');
  assert.ok(start > 0 && end > start, '应能找到颜文字库');
  const block = raw.slice(start, end);
  assert.doesNotMatch(block, /（/, '颜文字库不得使用全角括号');
  assert.ok((block.match(/\(/g) || []).length >= 40, '颜文字库应覆盖足够多的表情');
  assert.ok(selectRoleText(raw, 'simulation').length <= ROLE_INJECT_MAX_CHARS, `角色卡应低于注入上限 ${ROLE_INJECT_MAX_CHARS}`);
  assert.match(raw, /语气词/);
  assert.match(raw, /emoji/);
  assert.match(raw, /还真是/);
});

test('CRLF 检出的人格卡与 LF 版本计长一致', () => {
  const crlf = CARD.replace(/\n/g, '\r\n');
  assert.equal(selectRoleText(crlf, 'simulation').length, selectRoleText(CARD, 'simulation').length, 'CRLF 不应被算进注入长度');
  assert.doesNotMatch(selectRoleText(crlf, 'simulation'), /\r/, '注入文本里不应残留 \\r');
});

test('真实人格卡可用，且筛选不丢公共内容', () => {
  const file = new URL('../roles/小鲸鱼.md', import.meta.url);
  const raw = fs.readFileSync(file, 'utf8');
  const simulationText = selectRoleText(raw, 'simulation');
  const v1 = selectRoleText(raw, 'legacy');
  assert.ok(simulationText.length > 0 && v1.length > 0);
  // 人设部分两种模式都必须保留
  for (const text of [v1, simulationText]) {
    assert.match(text, /小鲸鱼/);
    assert.match(text, /AI 味|去 AI 味/);
  }
  // 仿真注入的文本里不应再出现旧版的分条机制
  assert.doesNotMatch(simulationText, /空格分隔（例如|\[SILENT\]/);
});
