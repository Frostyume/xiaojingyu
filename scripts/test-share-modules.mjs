import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeShareConfig,
  normalizeShareModule,
  engineFacets,
  hasEngineFacets,
  facetRuntime,
  pickShareFacet,
  validateShareOutput,
  verificationPending,
  moduleDayTarget,
  inWindowAt,
  recentShareUrls,
  urlAlreadyShared
} from '../src/core/share-modules.js';
import {
  localDayKey,
  loadShareState,
  groupBudgetCheck,
  recordGroupSend,
  recordModuleSend,
  migrateAiTipsState,
  setVerification
} from '../src/core/share-state.js';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const at = (h, m = 0) => new Date(2026, 9, 29, h, m, 0, 0).getTime();

test('模块规范化：目标、facet、默认值', () => {
  const module = normalizeShareModule({
    label: 'S16',
    template: 'news',
    targets: 'group:1',
    facets: [
      { id: 'news', template: 'news', weight: 2 },
      { id: 'fun', template: 'fun', weight: 1, trigger: { windowStartHour: 10, windowEndHour: 21 } }
    ]
  }, 's16');
  assert.equal(module.id, 's16');
  assert.deepEqual(module.targets, ['group:1']);
  assert.equal(module.facets.length, 2);
  assert.equal(module.facets[0].weight, 2);
  assert.equal(module.facets[1].trigger.windowStartHour, 10);
  assert.equal(module.delivery.mode, 'approval');
  assert.equal(module.verification.status, 'pending');
});

test('配置表与加权抽样：窗口/上限/facet 权重', () => {
  const cfg = normalizeShareConfig({
    modules: {
      s16: {
        template: 'news',
        targets: ['group:1'],
        facets: [
          { id: 'news', template: 'news', weight: 2, trigger: { type: 'schedule', windowStartHour: 8, windowEndHour: 22 } },
          { id: 'fun', template: 'fun', weight: 1, trigger: { type: 'schedule', windowStartHour: 10, windowEndHour: 21 }, limits: { maxPerDay: 1 } }
        ]
      }
    }
  });
  const module = cfg.modules.s16;
  assert.equal(cfg.enabled, true);
  const state = { facets: {} };
  const facet = pickShareFacet(module, state, at(9), () => 0.1);
  assert.equal(facet.id, 'news');
  assert.equal(pickShareFacet(module, state, at(7), () => 0.1), null);
  state.facets = { fun: { day: localDayKey(at(9)), count: 1, lastAt: 0 } };
  assert.equal(pickShareFacet(module, state, at(11), () => 0.99).id, 'news');
});

test('输出校验：知识/金融/资讯/趣闻', () => {
  const knowledge = normalizeShareModule({ template: 'knowledge', content: { minChars: 20, maxChars: 300 } }, 'k');
  const ok = validateShareOutput('knowledge', {
    title: '协同过滤：推荐为什么越刷越准',
    techName: '协同过滤',
    text: '协同过滤会记录点击和停留，再找相似的人爱看什么，所以推荐越刷越像你。'.repeat(2),
    terms: [{ name: '相似度', plain: '两个人爱看的东西有多像' }, { name: '行为表', plain: '谁看过什么的记录' }]
  }, knowledge, knowledge.facets[0]);
  assert.equal(ok.ok, true);
  const missingTerm = validateShareOutput('knowledge', { title: 'x', techName: '协同过滤', text: '协同过滤'.repeat(20), terms: [] }, knowledge, knowledge.facets[0]);
  assert.equal(missingTerm.error, 'missing-terms');

  const finance = normalizeShareModule({ template: 'finance', content: { minChars: 20, maxChars: 300 } }, 'f');
  const fin = validateShareOutput('finance', {
    title: '利率：钱的价格',
    techName: '利率',
    text: '利率可以理解成借钱的价格。'.repeat(8),
    terms: [{ name: '利率', plain: '借钱的价格' }, { name: '复利', plain: '利息也生利息' }],
    riskNote: '以上只是常识科普，不构成投资建议。'
  }, finance, finance.facets[0]);
  assert.equal(fin.ok, true);
  assert.equal(validateShareOutput('finance', { title: 'x', text: '钱'.repeat(200), terms: [{ name: 'a', plain: 'b' }, { name: 'c', plain: 'd' }] }, finance, finance.facets[0]).error, 'missing-risk-note');

  const news = normalizeShareModule({ template: 'news' }, 'n');
  assert.equal(validateShareOutput('news', { title: '赛果', text: '比赛结束。'.repeat(10), time: '10 月 29 日 20:00', sourceUrl: 'https://example.com/a' }, news, news.facets[0]).ok, true);
  assert.equal(validateShareOutput('news', { title: '赛果', text: '比赛结束。'.repeat(10), time: '', sourceUrl: 'https://example.com/a' }, news, news.facets[0]).error, 'missing-time');

  const fun = normalizeShareModule({ template: 'fun' }, 'fun');
  assert.equal(validateShareOutput('fun', { text: '今天看到一个特别离谱的猫，居然会自己开冰箱。' }, fun, fun.facets[0]).ok, true);
});

test('验证状态：必须明确通过', () => {
  const module = normalizeShareModule({ template: 'fun' }, 'f');
  assert.equal(verificationPending(module, { verification: { status: 'pending' } }), true);
  assert.equal(verificationPending(module, { verification: { status: 'approved' } }), false);
});

test('每日目标与时间窗', () => {
  assert.equal(moduleDayTarget({ limits: { minPerDay: 2, maxPerDay: 5 } }, () => 0), 2);
  assert.equal(moduleDayTarget({ limits: { minPerDay: 2, maxPerDay: 5 } }, () => 0.99), 5);
  assert.equal(inWindowAt(at(9), 9, 22), true);
  assert.equal(inWindowAt(at(22), 9, 22), false);
  assert.equal(inWindowAt(at(23), 22, 6), true);
});

test('群级预算：每日/每小时/间隔', () => {
  const now = at(10);
  const state = { groups: {}, modules: {} };
  const limits = { perGroupPerDay: 2, perGroupPerHour: 3, crossModuleGapMs: 15 * 60000 };
  assert.equal(groupBudgetCheck(state, 'group:1', now, limits).ok, true);
  recordGroupSend(state, 'group:1', now);
  assert.equal(groupBudgetCheck(state, 'group:1', now + 1000, limits).reason, 'group-gap');
  assert.equal(groupBudgetCheck(state, 'group:1', now + 16 * 60000, { ...limits, perGroupPerHour: 1 }).reason, 'group-hourly-limit');
  recordGroupSend(state, 'group:1', now + 61 * 60000);
  assert.equal(groupBudgetCheck(state, 'group:1', now + 61 * 60000, limits).reason, 'group-daily-limit');
});

test('状态落盘与旧 ai-tips 迁移', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-state-'));
  const file = path.join(dir, 'share-modules.json');
  fs.writeFileSync(file, JSON.stringify({ version: 1, groups: {}, modules: { ai_tips: { day: '2000-01-01', sentToday: 4 } } }));
  const state = loadShareState(file, { now: at(10), moduleIds: ['ai_tips'] });
  assert.equal(state.modules.ai_tips.sentToday, 0);
  assert.equal(state.modules.ai_tips.verification.status, 'pending');
  const migrated = migrateAiTipsState({ day: localDayKey(at(10)), sentToday: 2, history: [{ title: 't', text: 'x' }] }, { now: at(10), nextAt: at(12) });
  assert.equal(migrated.sentToday, 2);
  assert.equal(migrated.history.length, 1);
  assert.equal(migrated.verification.status, 'approved');
  assert.equal(migrated.nextAt, at(12));
  state.modules.ai_tips = migrated;
  setVerification(state, 'ai_tips', 'pending');
  assert.equal(state.modules.ai_tips.verification.status, 'pending');
  // pending / 迁移标记必须原样保留，否则草稿会在下一次读盘时丢失。
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    groups: {},
    modules: { finance: { day: localDayKey(at(10)), pending: { title: '复利' }, _migrated: true, _verificationSet: true, verification: { status: 'pending' } } }
  }));
  const again = loadShareState(file, { now: at(10), moduleIds: ['finance'] });
  assert.equal(again.modules.finance.pending.title, '复利');
  assert.equal(again.modules.finance._migrated, true);
  assert.equal(again.modules.finance._verificationSet, true);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('模块记账：facet 计数与历史', () => {
  const state = { groups: {}, modules: { s16: { day: localDayKey(at(10)), sentToday: 0, facets: { news: { day: localDayKey(at(10)), count: 0, lastAt: 0 } }, history: [], stats: { sent: 0 } } } };
  recordModuleSend(state, 's16', 'news', at(10), { title: '赛果', text: 'x', links: [] });
  assert.equal(state.modules.s16.sentToday, 1);
  assert.equal(state.modules.s16.facets.news.count, 1);
  assert.equal(state.modules.s16.history[0].title, '赛果');
});

test('运行时隔离：legacy facet 不参与引擎调度，避免同一期发两次', () => {
  const module = normalizeShareModule({
    template: 'news',
    runtime: 'legacy-s16',
    targets: ['group:1'],
    facets: [
      { id: 'news', template: 'news', runtime: 'legacy-s16', trigger: { type: 'feed-event' } },
      { id: 'fun', template: 'fun', runtime: 'engine', trigger: { type: 'schedule', windowStartHour: 10, windowEndHour: 21 }, limits: { maxPerDay: 1 } }
    ]
  }, 's16');
  assert.equal(facetRuntime(module.facets[0], module), 'legacy-s16');
  assert.equal(facetRuntime(module.facets[1], module), 'engine');
  const engineList = engineFacets(module);
  assert.deepEqual(engineList.map((f) => f.id), ['fun']);
  assert.equal(hasEngineFacets(module), true);
  // 任何时间都不会抽到 legacy news
  for (const hour of [10, 12, 18, 20]) {
    const facet = pickShareFacet(module, { facets: {} }, at(hour), () => 0.5);
    assert.equal(facet?.id, 'fun');
  }
  // 只有 legacy facet 的模块整体不进引擎
  const legacyOnly = normalizeShareModule({ template: 'fun', runtime: 'legacy-curiosity', facets: [{ id: 'default', template: 'fun', runtime: 'legacy-curiosity' }] }, 'life_fun');
  assert.equal(hasEngineFacets(legacyOnly), false);
  assert.equal(pickShareFacet(legacyOnly, { facets: {} }, at(12)), null);
});

test('跨模块链接去重：同一期只发一次', () => {
  const history = [
    { sourceUrl: 'https://news.example.com/a?x=1#frag' },
    { links: [{ url: 'https://b.example.com/v/2/' }] }
  ];
  const urls = recentShareUrls(history);
  assert.equal(urlAlreadyShared('https://news.example.com/a?x=1', urls), true);
  assert.equal(urlAlreadyShared('https://b.example.com/v/2', urls), true);
  assert.equal(urlAlreadyShared('https://new.example.com/z', urls), false);
  assert.equal(urlAlreadyShared('', urls), false);
});

test('模块记账保留 url/source，供跨期去重与 UI 使用', () => {
  const state = { groups: {}, modules: { s16: { day: localDayKey(at(10)), sentToday: 0, facets: {}, history: [], stats: { sent: 0 } } } };
  recordModuleSend(state, 's16', 'fun', at(10), { text: 'x', url: 'https://a.example.com/1', source: 's16', links: [] });
  assert.equal(state.modules.s16.history[0].url, 'https://a.example.com/1');
  assert.equal(state.modules.s16.history[0].source, 's16');
});
