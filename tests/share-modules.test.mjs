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
  urlAlreadyShared,
  SHARE_LIMITS_DEFAULTS
} from '../runtime/share/share-modules.js';
import {
  localDayKey,
  loadShareState,
  groupBudgetCheck,
  recordGroupSend,
  recordModuleSend,
  migrateAiTipsState,
  setVerification,
  globalBudgetCheck,
  recordGlobalSend,
  nextGlobalWindowAt
} from '../runtime/share/share-state.js';
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

test('技术词兜底：历史正文不再误报 tech-name-not-in-text', () => {
  const module = normalizeShareModule({ template: 'knowledge' }, 'llm_tips');
  const samples = [
    '问一件很具体的事，它答得又快又稳，连细枝末节都给你，可一查，压根没这回事。这就是为什么大模型会一本正经胡说，因为它说话求的是顺，不是准。这里有两个词得说清：自信语气是它答什么都笃定，输出里没有“不确定”这个挡箭牌；知识边界是它不清楚自己哪里不会，也没法在回答之前先翻一遍书。具体做法是它顺着眼前那几句话往下接，接得越顺越像真的。不过这毛病多出在冷门、具体的事上，多问一句出处，常能看出虚实。',
    '在手机上打一句话，它就能顺着说下去一大段，看着像很懂行。这背后就是大家说的大模型，简单说，它是个从海量文字里学出来的接话能手。这里有两个词得说清：参数是它学到的那些数值，像一本越记越厚的笔记；训练是拿海量文字反复练，让它学会每个位置接下来最可能是什么字。具体做法是先大量读、再一个字一个字往下接，所以看着像在琢磨，其实一直在猜。不过它没真去查过资料，碰上冷门、具体的事就可能说岔，写得长也不代表全对。'
  ];
  for (const text of samples) {
    const result = validateShareOutput('knowledge', {
      title: '大模型科普',
      techName: 'Transformer',
      text,
      terms: [{ name: '参数', plain: '学到的数值' }, { name: '训练', plain: '反复练' }]
    }, module, module.facets[0]);
    assert.notEqual(result.error, 'tech-name-not-in-text');
  }
});

test('技术词兜底：命中任一技术词即通过，没有技术词仍失败', () => {
  const module = normalizeShareModule({ template: 'knowledge' }, 'llm_tips');
  const hit = validateShareOutput('knowledge', {
    title: '大模型为什么会接话',
    techName: 'Transformer',
    text: '大模型会顺着上下文往下接话，所以听起来很自然。'.repeat(8),
    terms: [{ name: '上下文', plain: '前面说过的话' }, { name: '接话', plain: '顺着往下猜' }]
  }, module, module.facets[0]);
  assert.equal(hit.ok, true);
  const miss = validateShareOutput('knowledge', {
    title: '今天去公园',
    techName: 'Transformer',
    text: '今天天气不错，我们去公园散步，看到很多花开了。'.repeat(10),
    terms: [{ name: '散步', plain: '慢慢走' }, { name: '花', plain: '开了的花' }]
  }, module, module.facets[0]);
  assert.equal(miss.error, 'tech-name-not-in-text');
});

test('技术词兜底：模块或 facet 的 content.techTerms 生效', () => {
  const output = {
    title: '它是个会接话的大本子',
    techName: 'Transformer',
    text: '大本子只会顺着前一句往下接，像鹦鹉学舌一样复述，并不真懂意思。'.repeat(6),
    terms: [{ name: '复述', plain: '照着再说一遍' }, { name: '接话', plain: '顺着往下猜' }]
  };
  const plain = normalizeShareModule({ template: 'knowledge' }, 'llm_tips');
  assert.equal(validateShareOutput('knowledge', output, plain, plain.facets[0]).error, 'tech-name-not-in-text');
  const moduleLevel = normalizeShareModule({ template: 'knowledge', content: { techTerms: ['鹦鹉学舌'] } }, 'llm_tips');
  assert.equal(validateShareOutput('knowledge', output, moduleLevel, moduleLevel.facets[0]).ok, true);
  const facetLevel = normalizeShareModule({ template: 'knowledge', facets: [{ content: { techTerms: ['鹦鹉学舌'] } }] }, 'llm_tips');
  assert.equal(validateShareOutput('knowledge', output, facetLevel, facetLevel.facets[0]).ok, true);
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

const nextDayAt = (h, m = 0) => new Date(2026, 9, 30, h, m, 0, 0).getTime();
const globalState = (day = at(8)) => ({ daily: { day: localDayKey(day), sent: 0, windows: {} } });

test('全局总闸默认值：每天 2 条，上午/下午各 1 条', () => {
  assert.equal(SHARE_LIMITS_DEFAULTS.globalMaxPerDay, 2);
  const cfg = normalizeShareConfig({});
  assert.equal(cfg.limits.globalMaxPerDay, 2);
  assert.deepEqual(cfg.limits.windows, [{ start: 7, end: 12 }, { start: 12, end: 21 }]);
  const custom = normalizeShareConfig({ limits: { globalMaxPerDay: 99, windows: [{ start: 9, end: 11 }] } });
  assert.equal(custom.limits.globalMaxPerDay, 10);
  assert.deepEqual(custom.limits.windows, [{ start: 9, end: 11 }]);
  assert.deepEqual(normalizeShareConfig({ limits: { windows: [{ start: 12, end: 12 }] } }).limits.windows, [{ start: 7, end: 12 }, { start: 12, end: 21 }]);
});

test('全局总闸：窗口外不发，窗口内放行', () => {
  const limits = normalizeShareConfig({}).limits;
  const state = globalState();
  const early = globalBudgetCheck(state, at(6), limits);
  assert.equal(early.ok, false);
  assert.equal(early.reason, 'global-outside-window');
  assert.equal(early.nextAt, at(7));
  assert.equal(globalBudgetCheck(state, at(6, 50), limits).nextAt, at(7));
  const morning = globalBudgetCheck(state, at(8), limits);
  assert.equal(morning.ok, true);
  assert.equal(morning.window, 7);
  assert.equal(morning.sentToday, 0);
  const evening = globalBudgetCheck(state, at(21), limits);
  assert.equal(evening.reason, 'global-outside-window');
  assert.equal(evening.nextAt, nextDayAt(7));
});

test('全局总闸：每个窗口最多 1 条，用满后推到下一个窗口', () => {
  const limits = normalizeShareConfig({}).limits;
  const state = globalState();
  recordGlobalSend(state, at(8), limits);
  assert.equal(state.daily.sent, 1);
  assert.equal(state.daily.windows['7'], 1);
  const blocked = globalBudgetCheck(state, at(9), limits);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.reason, 'global-window-limit');
  assert.equal(blocked.sentToday, 1);
  assert.equal(blocked.nextAt, at(12));
  const afternoon = globalBudgetCheck(state, at(12), limits);
  assert.equal(afternoon.ok, true);
  assert.equal(afternoon.window, 12);
});

test('全局总闸：全天用满后不再发，nextAt 跨到次日首窗', () => {
  const limits = normalizeShareConfig({}).limits;
  const state = globalState();
  recordGlobalSend(state, at(8), limits);
  recordGlobalSend(state, at(13), limits);
  assert.equal(state.daily.sent, 2);
  const blocked = globalBudgetCheck(state, at(14), limits);
  assert.equal(blocked.reason, 'global-daily-limit');
  assert.equal(blocked.sentToday, 2);
  assert.equal(blocked.nextAt, nextDayAt(7));
  const limited = { ...limits, globalMaxPerDay: 1 };
  const one = globalState();
  recordGlobalSend(one, at(8), limited);
  assert.equal(globalBudgetCheck(one, at(13), limited).reason, 'global-daily-limit');
});

test('全局总闸：跨天归零，老状态缺字段按空处理', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'share-global-'));
  const file = path.join(dir, 'share-modules.json');
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    groups: {},
    modules: {},
    daily: { day: localDayKey(at(8)), sent: 2, windows: { 7: 1, 12: 1 } }
  }));
  const sameDay = loadShareState(file, { now: at(10), moduleIds: [] });
  assert.equal(sameDay.daily.sent, 2);
  assert.equal(sameDay.daily.windows['7'], 1);
  const nextDay = loadShareState(file, { now: nextDayAt(8), moduleIds: [] });
  assert.equal(nextDay.daily.day, localDayKey(nextDayAt(8)));
  assert.equal(nextDay.daily.sent, 0);
  assert.deepEqual(nextDay.daily.windows, {});
  fs.writeFileSync(file, JSON.stringify({ version: 1, groups: {}, modules: {} }));
  const legacy = loadShareState(file, { now: at(10), moduleIds: [] });
  assert.deepEqual(legacy.daily, { day: localDayKey(at(10)), sent: 0, windows: {} });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('nextGlobalWindowAt：跨窗口与跨天', () => {
  const limits = normalizeShareConfig({}).limits;
  assert.equal(nextGlobalWindowAt(at(6), limits), at(7));
  assert.equal(nextGlobalWindowAt(at(8), limits), at(12));
  assert.equal(nextGlobalWindowAt(at(12), limits), nextDayAt(7));
  assert.equal(nextGlobalWindowAt(at(12), limits, { afterDay: true }), nextDayAt(7));
  assert.equal(nextGlobalWindowAt(at(22), limits), nextDayAt(7));
  const single = { ...limits, windows: [{ start: 9, end: 11 }] };
  assert.equal(nextGlobalWindowAt(at(12), single), nextDayAt(9));
});

test('recordGlobalSend：成功后计数并给所在窗口 +1，旧日期自动重置', () => {
  const limits = normalizeShareConfig({}).limits;
  const state = { daily: { day: '2000-01-01', sent: 5, windows: { 7: 9 } } };
  recordGlobalSend(state, at(8), limits);
  assert.equal(state.daily.day, localDayKey(at(8)));
  assert.equal(state.daily.sent, 1);
  assert.deepEqual(state.daily.windows, { 7: 1 });
  recordGlobalSend(state, at(13), limits);
  assert.equal(state.daily.sent, 2);
  assert.deepEqual(state.daily.windows, { 7: 1, 12: 1 });
  // 窗口外强制发送只累加全天，不伪造窗口计数。
  recordGlobalSend(state, at(23), limits);
  assert.equal(state.daily.sent, 3);
  assert.deepEqual(state.daily.windows, { 7: 1, 12: 1 });
});
