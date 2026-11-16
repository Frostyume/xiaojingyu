// 论文推送 / GitHub 监控 / 日历晨报 / RSS 摘要 / 每周回顾 / 生活日报：排期、去重、退化、基线、变化、退避。
// 全部使用内存 SQLite、假时钟和本地夹具，不访问网络、不发送任何真实 QQ 消息。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDatabase } from '../runtime/kernel/db.js';
import { normalizeLifeConfig, adapterEnabled } from '../services/social/life/config.js';
import { createHealth } from '../services/social/life/kernel/health.js';
import { createScheduler } from '../services/social/life/kernel/scheduler.js';
import { LifeQuotaError } from '../services/social/life/kernel/fetch-guard.js';
import { nextModuleRun } from '../services/social/life/kernel/time.js';
import { buildBrief } from '../services/social/life/kernel/brief.js';
import { buildCalendarMorning, buildRssDigest, buildWeeklyReview } from '../services/social/life/kernel/modules.js';
import paperAdapter, { parseOpenAlexWork, dedupePapers } from '../services/social/life/adapters/paper/index.js';
import githubAdapter, { parseCursor } from '../services/social/life/adapters/github/index.js';
import rssAdapter, { parseRss } from '../services/social/life/adapters/rss/index.js';

const TZ = 'Asia/Shanghai';
const NOW = Date.UTC(2026, 10, 1, 2, 0, 0); // 2026-11-01 10:00 Asia/Shanghai（周日）
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

function moduleAdapter(id, { timeoutMs = 2000 } = {}) {
  return {
    id,
    enabled: true,
    config: {},
    guard: {},
    impl: { sync: async () => ({ items: [], cursor: null }) },
    manifest: {
      name: id,
      schedule: { sync: '*/5 * * * *', jitterSec: 0, timeoutMs, catchUp: 'once' },
      rateLimit: { perMinute: 30, perDay: 1000 },
      health: { failuresToOpen: 3, openMs: 30 * MINUTE, authErrorStops: true }
    }
  };
}

function makeEnv({
  modules = {},
  syncAdapter,
  briefCandidates = () => [],
  moduleFeed = () => [],
  counts = {},
  adapterIds = ['paper', 'github'],
  reminders = null,
  timeoutMs = 2000
} = {}) {
  const db = openDatabase({ file: ':memory:' });
  const config = normalizeLifeConfig({
    enabled: true,
    digest: { enabled: false },
    quietHours: { enabled: false },
    modules
  });
  let nowMs = NOW;
  const clock = { now: () => nowMs };
  const health = createHealth({ db, clock, logger: () => {} });
  const pipeline = {
    syncAdapter: syncAdapter || (async () => ({
      items: [], cursor: null, inserted: 0, updated: 0, skipped: 0, invalid: 0, latencyMs: 1, meta: {}
    })),
    briefCandidates,
    moduleFeed,
    countSince: (adapter) => Number(counts[adapter]) || 0
  };
  const enqueued = [];
  const seen = new Set();
  const notified = [];
  const port = {
    config: () => ({ lifeButler: config }),
    log: () => {},
    clock,
    db,
    scheduler: {
      register() {},
      enqueue(input) {
        const existed = seen.has(input.dedupeKey);
        if (!existed) { seen.add(input.dedupeKey); enqueued.push(input); }
        return { id: enqueued.length, existed };
      },
      cancel() { return 0; }
    },
    notify: async (text, meta) => { notified.push({ text, meta }); return { ok: true }; },
    http: { fetch: async () => { throw new Error('端口 http 不应被直接调用'); } }
  };
  const scheduler = createScheduler({
    port,
    config,
    clock,
    health,
    pipeline,
    adapters: adapterIds.map((id) => moduleAdapter(id, { timeoutMs })),
    random: () => 0.5,
    reminders
  });
  return {
    db, config, health, pipeline, enqueued, notified, scheduler,
    advance(ms) { nowMs += ms; },
    setNow(ms) { nowMs = ms; },
    now: () => nowMs
  };
}

function paperSummary(items, meta = {}) {
  return { items, cursor: null, inserted: items.length, updated: 0, skipped: 0, invalid: 0, latencyMs: 5, meta };
}

test('排期：daily/weekly/interval 按 Asia/Shanghai 的用户时间计算', () => {
  assert.equal(nextModuleRun({ frequency: 'daily', time: '09:00' }, NOW, TZ), Date.UTC(2026, 10, 2, 1, 0, 0));
  assert.equal(nextModuleRun({ frequency: 'weekly', weekday: 1, time: '08:30' }, NOW, TZ), Date.UTC(2026, 10, 2, 0, 30, 0));
  assert.equal(nextModuleRun({ frequency: 'interval', intervalDays: 3, time: '09:00' }, NOW, TZ, NOW), Date.UTC(2026, 10, 4, 1, 0, 0));
  assert.equal(nextModuleRun({ frequency: 'weekly', weekday: 7, time: '20:00' }, NOW, TZ), Date.UTC(2026, 10, 1, 12, 0, 0));
  assert.equal(
    nextModuleRun({ frequency: 'daily', time: '07:30', weekdaysOnly: true }, Date.UTC(2026, 10, 6, 12, 0, 0), TZ),
    Date.UTC(2026, 10, 8, 23, 30, 0),
    '周五晚上开启仅工作日晨报，应排到下周一 07:30'
  );
});

test('排期：模块按用户时间入队，同一时间点重复排程只保留一个 dedupeKey', () => {
  const env = makeEnv({ modules: { paper: { enabled: true, frequency: 'daily', time: '12:00' } } });
  const started = env.scheduler.start();
  assert.deepEqual(started, { adapters: 2, briefs: 0 });
  const scheduled = env.enqueued.find((job) => job.payload?.reason === 'schedule' && job.payload?.module === 'paper');
  assert.ok(scheduled, '应排入论文推送');
  assert.equal(scheduled.type, 'life.push');
  assert.equal(scheduled.dedupeKey, `life:push:paper:${Date.UTC(2026, 10, 1, 4, 0, 0)}`);
  assert.equal(scheduled.runAfter, Date.UTC(2026, 10, 1, 4, 0, 0));
  assert.ok(env.enqueued.some((job) => job.payload?.reason === 'initial' && job.payload?.module === 'paper'));

  env.scheduler.scheduleNext('paper');
  assert.equal(env.enqueued.filter((job) => job.dedupeKey === scheduled.dedupeKey).length, 1);
});

test('论文推送：编号、机构/会议/日期、TLDR 退化与参考链接齐全', async () => {
  const items = [
    {
      title: 'Sparse Retrieval for Tool Agents',
      summary: '用稀疏检索把候选压到三分之一，端到端延迟下降 40%。',
      payload: {
        url: 'https://example.org/sparse', venue: 'NeurIPS', year: 2026, publicationDate: '2026-10-30',
        institutions: ['MIT', 'Tsinghua', 'Stanford'], tldrSource: 'model'
      }
    },
    {
      title: 'Abstract Only Paper',
      summary: 'This paper studies retrieval. It is a fixture.',
      payload: { url: 'https://example.org/abstract', tldrSource: 'abstract-compress' }
    },
    {
      title: 'Title Only Paper',
      summary: null,
      payload: { tldrSource: 'title-only' }
    }
  ];
  const env = makeEnv({
    modules: { paper: { enabled: true, topics: ['cs.AI'], count: 3, windowDays: 7 } },
    syncAdapter: async () => paperSummary(items)
  });
  const result = await env.scheduler.runPush('paper');
  assert.equal(result.delivered, true);
  assert.equal(env.notified.length, 1);
  const text = env.notified[0].text;
  assert.match(text, /^论文推送 · 近 7 天 · cs\.AI/);
  assert.match(text, /1\. \[Sparse Retrieval for Tool Agents\]\(https:\/\/example\.org\/sparse\)/);
  assert.match(text, /MIT、Tsinghua｜NeurIPS · 2026｜2026-10-30/);
  assert.match(text, /TLDR：用稀疏检索把候选压到三分之一，端到端延迟下降 40%。/);
  assert.match(text, /摘要压缩：This paper studies retrieval\. It is a fixture\./);
  assert.match(text, /TLDR：仅标题/);
  assert.match(text, /\n   —｜—｜—/);
  assert.match(text, /参考：/);
  assert.match(text, /\[2\] https:\/\/example\.org\/abstract/);
  assert.doesNotMatch(text, /其余 \d+ 篇/);
});

test('论文推送：没有新论文时不发消息，但仍排下一次', async () => {
  const env = makeEnv({
    modules: { paper: { enabled: true, frequency: 'daily', time: '12:00' } },
    syncAdapter: async () => paperSummary([])
  });
  const result = await env.scheduler.runPush('paper');
  assert.equal(result.noChange, true);
  assert.equal(result.sent, false);
  assert.equal(env.notified.length, 0);
  assert.ok(env.enqueued.some((job) => job.type === 'life.push' && job.payload?.reason === 'schedule'));
});

test('OpenAlex：DOI 去重、摘要压缩与模型速读，无摘要只标标题', async () => {
  const abstract = 'Sparse retrieval cuts the candidate set to one third. It improves latency by forty percent.';
  const inverted = {};
  abstract.split(/\s+/).forEach((word, index) => {
    if (!inverted[word]) inverted[word] = [];
    inverted[word].push(index);
  });
  const works = [
    {
      title: 'Sparse Retrieval for Tool Agents', doi: 'https://doi.org/10.1234/abc',
      publication_date: '2026-10-30', publication_year: 2026,
      primary_location: { source: { display_name: 'NeurIPS' }, landing_page_url: 'https://example.org/a' },
      authorships: [
        { author: { display_name: 'Ada' }, institutions: [{ display_name: 'MIT' }, { display_name: 'Stanford' }] }
      ],
      abstract_inverted_index: inverted
    },
    {
      title: 'Sparse Retrieval for Tool Agents (preprint)', doi: '10.1234/abc',
      publication_date: '2026-10-29', publication_year: 2026,
      primary_location: { source: { display_name: 'arXiv' }, landing_page_url: 'https://arxiv.org/abs/2610.0001' },
      authorships: [], abstract_inverted_index: inverted
    },
    {
      title: 'No Abstract Fixture', doi: '10.1234/noabs',
      publication_date: '2026-10-31', publication_year: 2026,
      primary_location: { source: { display_name: 'ICML' }, landing_page_url: 'https://example.org/b' },
      authorships: [{ author: { display_name: 'Bob' }, institutions: [{ display_name: 'Tsinghua' }] }]
    }
  ];
  const deduped = dedupePapers(works.map((work) => parseOpenAlexWork(work, { nowMs: NOW })));
  assert.equal(deduped.length, 2);

  const calls = [];
  const http = { fetch: async (url) => { calls.push(url); return { body: JSON.stringify({ results: works }) }; } };
  const withModel = await paperAdapter.sync({
    config: { topics: ['cs.AI'], count: 5, source: 'openalex', windowDays: 7 },
    http,
    now: () => NOW,
    summarizer: async ({ title }) => (title.includes('No Abstract') ? '不应被调用' : '用稀疏检索把候选压到三分之一，延迟下降 40%。')
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0], /api\.openalex\.org\/works/);
  assert.equal(withModel.items.length, 2);
  const sparse = withModel.items.find((item) => item.title === 'Sparse Retrieval for Tool Agents');
  const noAbs = withModel.items.find((item) => item.title === 'No Abstract Fixture');
  assert.equal(sparse.meta.tldrSource, 'model');
  assert.equal(sparse.summary, '用稀疏检索把候选压到三分之一，延迟下降 40%。');
  assert.deepEqual(sparse.meta.institutions, ['MIT', 'Stanford']);
  assert.equal(sparse.meta.venue, 'NeurIPS');
  assert.equal(noAbs.meta.tldrSource, 'title-only');
  assert.equal(noAbs.summary, null);

  const withoutModel = await paperAdapter.sync({
    config: { topics: ['cs.AI'], count: 5, source: 'openalex', windowDays: 7 },
    http,
    now: () => NOW
  });
  const compressed = withoutModel.items.find((item) => item.title === 'Sparse Retrieval for Tool Agents');
  assert.equal(compressed.meta.tldrSource, 'abstract-compress');
  assert.equal(compressed.summary, 'Sparse retrieval cuts the candidate set to one third.');
});

test('GitHub：首次只建基线不刷历史，之后只输出变化；token 只放请求头', async () => {
  let stars = 128;
  let issues = [{ number: 101, title: 'Old issue', user: { login: 'alice' }, state: 'open', updated_at: '2026-10-30T00:00:00Z', html_url: 'https://github.com/acme/demo/issues/101' }];
  let releases = [{ id: 900, tag_name: 'v1.0.0', name: 'First', published_at: '2026-10-01T00:00:00Z', html_url: 'https://github.com/acme/demo/releases/tag/v1.0.0' }];
  const headersSeen = [];
  const urlsSeen = [];
  const http = {
    fetch: async (url, options = {}) => {
      urlsSeen.push(url);
      headersSeen.push(options.headers || {});
      if (/\/issues/.test(url)) {
        return {
          body: JSON.stringify([
            ...issues,
            { number: 102, title: 'A PR mixed into issues', user: { login: 'bob' }, state: 'open', pull_request: {} }
          ])
        };
      }
      if (/\/pulls/.test(url)) {
        return { body: JSON.stringify([{ number: 102, title: 'A PR mixed into issues', user: { login: 'bob' }, state: 'open', updated_at: '2026-10-31T00:00:00Z', html_url: 'https://github.com/acme/demo/pull/102' }]) };
      }
      if (/\/releases/.test(url)) return { body: JSON.stringify(releases) };
      return { body: JSON.stringify({ stargazers_count: stars, forks_count: 12, open_issues_count: issues.length + 1 }) };
    }
  };
  const config = {
    repos: ['acme/demo'], token: 'secret-token-value',
    metrics: { stars: true, forks: true, issues: true, pulls: true, releases: true }
  };

  const first = await githubAdapter.sync({ config, http, now: () => NOW, cursor: null });
  assert.equal(first.meta.baseline, true);
  assert.equal(first.items.length, 0);
  assert.ok(parseCursor(first.cursor).repos['acme/demo']);

  stars = 130;
  issues = [...issues, { number: 103, title: 'New bug', user: { login: 'carol' }, state: 'open', updated_at: '2026-11-01T00:00:00Z', html_url: 'https://github.com/acme/demo/issues/103' }];
  releases = [...releases, { id: 901, tag_name: 'v1.1.0', name: 'Second', published_at: '2026-11-01T01:00:00Z', html_url: 'https://github.com/acme/demo/releases/tag/v1.1.0' }];
  const second = await githubAdapter.sync({ config, http, now: () => NOW, cursor: first.cursor });
  assert.equal(second.meta.baseline, false);
  assert.deepEqual(second.items.map((item) => item.sourceRef).sort(), ['issue', 'release']);
  assert.ok(second.items.some((item) => item.title.includes('#103') && item.meta.author === 'carol'));
  assert.ok(second.items.some((item) => item.meta.tag === 'v1.1.0'));
  assert.equal(second.meta.repos[0].starDelta, 2);
  assert.ok(urlsSeen.every((url) => !url.includes('secret-token-value')));
  assert.ok(headersSeen.every((headers) => headers.authorization === 'Bearer secret-token-value'));
});

test('GitHub 推送：基线不发；有变化发摘要；配置无变化时才发“无变化”', async () => {
  const baselineEnv = makeEnv({
    modules: { github: { enabled: true, repos: ['acme/demo'] } },
    syncAdapter: async () => ({
      items: [], cursor: '{"v":1,"repos":{}}', inserted: 0, updated: 0, skipped: 0, invalid: 0, latencyMs: 5,
      meta: { baseline: true, repos: [{ repo: 'acme/demo', baseline: true, stars: 128, forks: 12 }] }
    })
  });
  const baseline = await baselineEnv.scheduler.runPush('github');
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.sent, false);
  assert.equal(baselineEnv.notified.length, 0);

  const deltaEnv = makeEnv({
    modules: { github: { enabled: true, repos: ['acme/demo'] } },
    syncAdapter: async () => ({
      items: [], cursor: '{"v":1,"repos":{}}', inserted: 2, updated: 0, skipped: 0, invalid: 0, latencyMs: 5,
      meta: {
        baseline: false,
        repos: [{
          repo: 'acme/demo', stars: 130, forks: 12, openIssues: 2, openPulls: 1,
          starDelta: 2, forkDelta: 0,
          issues: [{ number: 103, title: 'New bug', author: 'carol', state: 'open', url: 'https://github.com/acme/demo/issues/103' }],
          pulls: [], releases: []
        }]
      }
    })
  });
  const delta = await deltaEnv.scheduler.runPush('github');
  assert.equal(delta.delivered, true);
  const text = deltaEnv.notified[0].text;
  assert.match(text, /^GitHub 监控/);
  assert.match(text, /acme\/demo · ★ 130（\+2） · Fork 12 · Issue 2 · PR 1/);
  assert.match(text, /Issue #103 New bug（@carol，open）/);

  const noChangeEnv = makeEnv({
    modules: { github: { enabled: true, repos: ['acme/demo'], notifyNoChanges: true } },
    syncAdapter: async () => ({
      items: [], cursor: '{"v":1,"repos":{}}', inserted: 0, updated: 0, skipped: 0, invalid: 0, latencyMs: 5,
      meta: {
        baseline: false,
        repos: [{ repo: 'acme/demo', stars: 130, forks: 12, openIssues: 2, openPulls: 1, starDelta: 0, forkDelta: 0, issues: [], pulls: [], releases: [] }]
      }
    })
  });
  const quiet = await noChangeEnv.scheduler.runPush('github');
  assert.equal(quiet.delivered, true);
  assert.match(noChangeEnv.notified[0].text, /acme\/demo · ★ 130/);
});

test('失败退避：普通错误 1 分钟后再试，限流错误顺延到更晚，超时算失败', async () => {
  const regular = makeEnv({
    modules: { github: { enabled: true, repos: ['acme/demo'] } },
    syncAdapter: async () => { throw new Error('boom'); }
  });
  const failed = await regular.scheduler.runPush('github');
  assert.match(failed.error, /boom/);
  assert.equal(failed.state, 'degraded');
  assert.equal(failed.failures, 1);
  assert.equal(failed.nextAllowed, NOW + MINUTE);

  const blocked = await regular.scheduler.runPush('github');
  assert.equal(blocked.skipped, 'backoff');
  assert.ok(regular.enqueued.some((job) => job.payload?.reason === 'health:backoff' && job.runAfter >= NOW + MINUTE));

  const quota = makeEnv({
    modules: { github: { enabled: true, repos: ['acme/demo'] } },
    syncAdapter: async () => { throw new LifeQuotaError('rate limited'); }
  });
  const limited = await quota.scheduler.runPush('github');
  assert.equal(limited.state, 'degraded');
  assert.ok(quota.enqueued.some((job) => job.type === 'life.push' && job.payload?.reason === 'schedule' && job.runAfter >= NOW + 6 * HOUR));

  const slow = makeEnv({
    modules: { paper: { enabled: true } },
    syncAdapter: () => new Promise(() => {}),
    timeoutMs: 20
  });
  const timedOut = await slow.scheduler.runPush('paper');
  assert.match(timedOut.error, /超时/);
});

test('生活日报：默认只含日程+提醒，论文/GitHub 需显式打开，并标注数据范围', () => {
  const items = [{ id: 'cal-1', kind: 'calendar', title: '周会', status: 'open', startsAt: NOW + HOUR, adapter: 'calendar-ics' }];
  const reminders = [{ id: 'r1', text: '喝水', dueAt: NOW + 2 * HOUR, status: 'pending' }];
  const paperItems = [{ title: 'Sparse Retrieval', summary: '稀疏检索降低延迟。', payload: { venue: 'NeurIPS', year: 2026 } }];
  const githubItems = [{ title: 'New bug', payload: { repo: 'acme/demo', number: 103, tag: null } }];

  const base = buildBrief({ items, reminders, paperItems, githubItems, nowMs: NOW, timeZone: TZ });
  assert.match(base.text, /^生活日报 · 11-01（00:00~24:00）/);
  assert.match(base.text, /日程 11-01 00:00~24:00/);
  assert.match(base.text, /提醒 11-01/);
  assert.doesNotMatch(base.text, /论文/);
  assert.doesNotMatch(base.text, /GitHub/);

  const full = buildBrief({
    items, reminders, paperItems, githubItems,
    sections: { calendar: true, reminders: true, paper: true, github: true },
    paperWindowDays: 7,
    nowMs: NOW,
    timeZone: TZ
  });
  assert.match(full.text, /论文 · 近 7 天 · 1 篇/);
  assert.match(full.text, /· Sparse Retrieval（NeurIPS 2026）：稀疏检索降低延迟。/);
  assert.match(full.text, /GitHub · 11-01 以来/);
  assert.match(full.text, /· acme\/demo #103 New bug/);
  assert.ok(full.tokens <= 300);

  const empty = buildBrief({ items: [], reminders: [], nowMs: NOW, timeZone: TZ });
  assert.equal(empty.text, '今日无日程');
  assert.equal(empty.count, 0);
});

// 2026-11-01 是周日；以下时间都按 Asia/Shanghai 给出。
const at = (month, day, hour, minute = 0) => Date.UTC(2026, month - 1, day, hour - 8, minute, 0);

test('日历晨报：按时间排序、全天/跨天单列、冲突成对指出、明日预告与空日程', () => {
  const items = [
    { title: '周会', startsAt: at(11, 1, 11), endsAt: at(11, 1, 12), payload: { location: '会议室 A' } },
    { title: '面试', startsAt: at(11, 1, 11, 30), endsAt: at(11, 1, 12, 30) },
    { title: '团建', startsAt: at(11, 1, 0), endsAt: at(11, 2, 0), payload: { allDay: true } },
    { title: '夜间值班', startsAt: at(10, 31, 23), endsAt: at(11, 1, 1) },
    { title: '晨跑', startsAt: at(11, 2, 9), endsAt: at(11, 2, 10) }
  ];
  const built = buildCalendarMorning({ items, module: {}, nowMs: NOW, timeZone: TZ });
  assert.match(built.text, /^日历晨报 · 11月1日 周日/);
  assert.match(built.text, /今天 4 项日程/);
  assert.match(built.text, /• 11:00–12:00 周会（会议室 A）/);
  assert.match(built.text, /• 全天：团建/);
  assert.match(built.text, /• 跨天：夜间值班（10-31 – 11-01）/);
  assert.match(built.text, /冲突：11:00 周会 与 11:30 面试/);
  assert.match(built.text, /明日预告（11月2日 周一）：09:00 晨跑/);
  assert.equal(built.count, 4);

  const quiet = buildCalendarMorning({ items, module: { showConflicts: false, tomorrowPreview: false }, nowMs: NOW, timeZone: TZ });
  assert.doesNotMatch(quiet.text, /冲突/);
  assert.doesNotMatch(quiet.text, /明日预告/);

  const empty = buildCalendarMorning({ items: [], module: {}, nowMs: NOW, timeZone: TZ });
  assert.match(empty.text, /今天没有日程。/);
  assert.equal(empty.count, 0);
});

test('RSS 解析：摘要去标签只留 1–2 句，播客时长换算，标识稳定', () => {
  const entry = (id, title, published, desc, duration) => `<entry><id>${id}</id><title>${title}</title>
    <link href="https://example.org/${id}"/><published>${published}</published>
    <summary type="html"><![CDATA[${desc}]]></summary>${duration ? `<duration>${duration}</duration>` : ''}</entry>`;
  const xml = `<?xml version="1.0"?><feed><title>Fixture</title>
    ${entry('g1', '第一篇', '2026-11-01T02:00:00Z', '<p>第一句。<b>第二句。</b>第三句。</p>', '00:03:20')}
    ${entry('g2', '第二篇', '2026-11-01T01:00:00Z', '只有一句话', null)}
  </feed>`;
  const items = parseRss(xml, { nowMs: NOW, feedHost: 'example.org', feedName: '源A' });
  assert.equal(items.length, 2);
  assert.equal(items[0].summary, '第一句。 第二句。');
  assert.equal(items[0].meta.duration, 200);
  assert.equal(items[0].meta.feed, '源A');
  assert.equal(items[0].dedupeKey, 'rss:example.org:g1');
  assert.equal(items[0].startsAt, Date.UTC(2026, 10, 1, 2, 0, 0));
  assert.equal(items[1].meta.duration, undefined);

  const emptyFeed = parseRss('<?xml version="1.0"?><feed><title>空</title></feed>', { nowMs: NOW });
  assert.deepEqual(emptyFeed, [], '合法但暂时没有条目不应算故障');
});

test('RSS 多源：首次只建基线，预览不落基线，之后只推送新条目', async () => {
  const entry = (id, title, published, desc) => `<entry><id>${id}</id><title>${title}</title>
    <link href="https://example.org/${id}"/><published>${published}</published>
    <summary><![CDATA[${desc}]]></summary></entry>`;
  const atom = (entries) => `<?xml version="1.0"?><feed><title>Fixture</title>${entries}</feed>`;
  const feeds = [{ name: '源A', url: 'https://a.example/feed' }, { name: '源B', url: 'https://b.example/feed' }];
  let feedB = entry('b1', 'B 第一篇', '2026-11-01T01:00:00Z', '旧条目');
  const http = {
    fetch: async (url) => ({
      body: url.includes('a.example')
        ? atom(entry('a1', 'A 第一篇', '2026-11-01T03:00:00Z', 'A 摘要'))
        : atom(feedB)
    })
  };

  const first = await rssAdapter.sync({ config: { feeds }, http, now: () => NOW, cursor: null });
  assert.equal(first.items.length, 0, '首次订阅只建立基线');
  assert.equal(first.meta.baseline, true);
  assert.deepEqual(first.meta.feeds.map((feed) => feed.name ?? feed.feed), ['源A', '源B']);
  assert.deepEqual(first.meta.baseline === true, true);

  const preview = await rssAdapter.sync({ config: { feeds }, http, now: () => NOW, cursor: null, preview: true });
  assert.equal(preview.items.length, 2, '预览应展示当前全部条目');
  assert.equal(preview.cursor, null);
  assert.equal(preview.meta.baseline, false);

  feedB += entry('b2', 'B 新条目', '2026-11-01T04:00:00Z', '新摘要');
  const second = await rssAdapter.sync({ config: { feeds }, http, now: () => NOW, cursor: first.cursor });
  assert.equal(second.items.length, 1);
  assert.equal(second.items[0].externalId, 'b2');
  assert.equal(second.items[0].meta.feed, '源B');
});

test('RSS 摘要文本：按源分组、每源与总数上限、摘要开关、基线提示', () => {
  const items = [
    { title: 'A 新', summary: '摘要一。', startsAt: at(11, 1, 9), payload: { feed: '源A', url: 'https://a/1', duration: 200 } },
    { title: 'A 旧', summary: '旧摘要。', startsAt: at(11, 1, 8), payload: { feed: '源A' } },
    { title: 'B 新', startsAt: at(11, 1, 7), payload: { feed: '源B' } }
  ];
  const built = buildRssDigest({ items, module: { count: 3, perFeedLimit: 1, showSummary: true }, nowMs: NOW, timeZone: TZ });
  assert.match(built.text, /【源A】/);
  assert.match(built.text, /A 新/);
  assert.doesNotMatch(built.text, /A 旧/);
  assert.match(built.text, /【源B】/);
  assert.match(built.text, /时长 3:20/);
  assert.match(built.text, /摘要：摘要一。/);
  assert.equal(built.count, 2);

  const plain = buildRssDigest({ items, module: { showSummary: false, perFeedLimit: 5, count: 10 }, nowMs: NOW, timeZone: TZ });
  assert.doesNotMatch(plain.text, /摘要：/);

  const baseline = buildRssDigest({ items: [], module: {}, meta: { baseline: true, feeds: [{ feed: '源A' }] }, nowMs: NOW, timeZone: TZ });
  assert.match(baseline.text, /首次基线已建立（源A）/);
  const empty = buildRssDigest({ items: [], module: {}, nowMs: NOW, timeZone: TZ });
  assert.match(empty.text, /本轮没有新条目/);
});

test('每周回顾：四节可分别关闭，真实总数与提醒送达/错过统计，空数据不编造', () => {
  const reminders = [
    { text: '买牛奶', status: 'sent', lastAttemptAt: NOW - HOUR },
    { text: '交电费', status: 'failed', dueAt: NOW - 2 * HOUR, lastAttemptAt: NOW - 2 * HOUR },
    { text: '打电话', status: 'pending', createdAt: NOW - HOUR }
  ];
  const built = buildWeeklyReview({
    paperItems: [{ title: 'Sparse Retrieval', payload: { venue: 'NeurIPS', year: 2026 } }, { title: 'Second Paper' }],
    paperTotal: 12,
    githubItems: [],
    githubTotal: 0,
    reminderItems: reminders,
    digestItems: [{ title: '周会', startsAt: NOW - HOUR }],
    digestTotal: 5,
    module: { sections: { paper: true, github: true, reminders: true, digest: true } },
    nowMs: NOW,
    timeZone: TZ
  });
  assert.match(built.text, /^每周回顾 · 10月26日–11月1日/);
  assert.match(built.text, /论文：本周 12 篇/);
  assert.match(built.text, /· Sparse Retrieval（NeurIPS · 2026）/);
  assert.match(built.text, /GitHub：本周无新增/);
  assert.match(built.text, /提醒：送达 1 条，错过 1 条，待触发 1 条/);
  assert.match(built.text, /· 错过：交电费/);
  assert.match(built.text, /生活动态：本周 5 条/);
  assert.ok(built.count > 0);

  const withoutDigest = buildWeeklyReview({
    paperItems: [{ title: 'Only Paper' }],
    module: { sections: { digest: false } },
    nowMs: NOW,
    timeZone: TZ
  });
  assert.doesNotMatch(withoutDigest.text, /生活动态/);
  assert.match(withoutDigest.text, /论文：本周 1 篇/);

  const empty = buildWeeklyReview({ module: { sections: {} }, nowMs: NOW, timeZone: TZ });
  assert.match(empty.text, /论文：本周无新增/);
  assert.match(empty.text, /过去 7 天没有新增内容/);
});

test('日历晨报推送：空日程也发明确状态，模块关闭时不排期不发送', async () => {
  const items = [{ title: '周会', startsAt: at(11, 1, 11), endsAt: at(11, 1, 12) }];
  const env = makeEnv({
    modules: { calendarMorning: { enabled: true, time: '07:30' } },
    adapterIds: ['calendar-ics'],
    syncAdapter: async () => ({ items, cursor: null, inserted: 1, updated: 0, skipped: 0, invalid: 0, latencyMs: 1, meta: {} })
  });
  const result = await env.scheduler.runPush('calendarMorning');
  assert.equal(result.delivered, true);
  assert.equal(env.notified.length, 1);
  assert.match(env.notified[0].text, /^日历晨报 · 11月1日 周日/);
  assert.match(env.notified[0].text, /11:00–12:00 周会/);

  const emptyEnv = makeEnv({
    modules: { calendarMorning: { enabled: true } },
    adapterIds: ['calendar-ics'],
    syncAdapter: async () => ({ items: [], cursor: null, inserted: 0, updated: 0, skipped: 0, invalid: 0, latencyMs: 1, meta: {} })
  });
  const empty = await emptyEnv.scheduler.runPush('calendarMorning');
  assert.equal(empty.delivered, true);
  assert.match(emptyEnv.notified[0].text, /今天没有日程/);

  const offEnv = makeEnv({
    adapterIds: ['calendar-ics'],
    syncAdapter: async () => ({ items, cursor: null, inserted: 1, updated: 0, skipped: 0, invalid: 0, latencyMs: 1, meta: {} })
  });
  const skipped = await offEnv.scheduler.runPush('calendarMorning');
  assert.equal(skipped.skipped, 'disabled');
  assert.equal(offEnv.notified.length, 0);
});

test('RSS 推送：首次基线不发送，之后按源分组并尊重摘要开关', async () => {
  const baselineEnv = makeEnv({
    modules: { rssDigest: { enabled: true } },
    adapterIds: ['rss'],
    syncAdapter: async () => ({
      items: [], cursor: '{"v":2,"feeds":{}}', inserted: 0, updated: 0, skipped: 0, invalid: 0, latencyMs: 1,
      meta: { baseline: true, feeds: [{ feed: '源A' }] }
    })
  });
  const baseline = await baselineEnv.scheduler.runPush('rssDigest');
  assert.equal(baseline.baseline, true);
  assert.equal(baselineEnv.notified.length, 0);

  const items = [
    { title: 'A 新', summary: '摘要一。', startsAt: NOW - HOUR, payload: { feed: '源A', url: 'https://a/1', duration: 200 } },
    { title: 'A 旧', summary: '旧摘要。', startsAt: NOW - 2 * HOUR, payload: { feed: '源A' } },
    { title: 'B 新', startsAt: NOW - 3 * HOUR, payload: { feed: '源B' } }
  ];
  const env = makeEnv({
    modules: { rssDigest: { enabled: true, count: 3, perFeedLimit: 1, showSummary: true } },
    adapterIds: ['rss'],
    syncAdapter: async () => ({ items, cursor: '{"v":2,"feeds":{}}', inserted: 3, updated: 0, skipped: 0, invalid: 0, latencyMs: 1, meta: { baseline: false } })
  });
  const result = await env.scheduler.runPush('rssDigest');
  assert.equal(result.delivered, true);
  const text = env.notified[0].text;
  assert.match(text, /【源A】/);
  assert.match(text, /A 新/);
  assert.doesNotMatch(text, /A 旧/);
  assert.match(text, /【源B】/);
  assert.match(text, /时长 3:20/);
  assert.match(text, /摘要：摘要一。/);

  const plainEnv = makeEnv({
    modules: { rssDigest: { enabled: true, showSummary: false, perFeedLimit: 5 } },
    adapterIds: ['rss'],
    syncAdapter: async () => ({ items, cursor: '{"v":2,"feeds":{}}', inserted: 3, updated: 0, skipped: 0, invalid: 0, latencyMs: 1, meta: { baseline: false } })
  });
  await plainEnv.scheduler.runPush('rssDigest');
  assert.doesNotMatch(plainEnv.notified[0].text, /摘要：/);
});

test('每周回顾推送：只读本地库，提醒统计来自提醒存储并受分节开关控制', async () => {
  const env = makeEnv({
    modules: { weeklyReview: { enabled: true, weekday: 7, time: '20:00' } },
    moduleFeed: ({ adapter }) => {
      if (adapter === 'paper') return [{ title: 'Sparse Retrieval', payload: { venue: 'NeurIPS' }, startsAt: NOW - HOUR }];
      if (adapter === 'github') return [];
      return [{ title: '周会', startsAt: NOW - HOUR }];
    },
    counts: { paper: 12, github: 0 },
    reminders: [
      { text: '买牛奶', status: 'sent', lastAttemptAt: NOW - HOUR },
      { text: '交电费', status: 'failed', lastAttemptAt: NOW - 2 * HOUR }
    ]
  });
  const result = await env.scheduler.runPush('weeklyReview');
  assert.equal(result.delivered, true);
  const text = env.notified[0].text;
  assert.match(text, /论文：本周 12 篇/);
  assert.match(text, /提醒：送达 1 条，错过 1 条，待触发 0 条/);
  assert.match(text, /· 错过：交电费/);
  assert.ok(env.enqueued.some((job) => job.type === 'life.push' && job.payload?.module === 'weeklyReview'));
});

test('配置归一化：五个模块的默认值、边界与适配器开关', () => {
  const config = normalizeLifeConfig({});
  const modules = config.modules;
  assert.equal(modules.calendarMorning.time, '07:30');
  assert.equal(modules.calendarMorning.lookaheadDays, 1);
  assert.equal(modules.calendarMorning.showConflicts, true);
  assert.deepEqual(modules.rssDigest.feeds, []);
  assert.equal(modules.rssDigest.count, 8);
  assert.equal(modules.rssDigest.perFeedLimit, 3);
  assert.equal(modules.weeklyReview.weekday, 7);
  assert.equal(modules.weeklyReview.time, '20:00');
  assert.deepEqual(modules.weeklyReview.sections, { paper: true, github: true, reminders: true, digest: true });
  assert.equal(adapterEnabled(config, 'calendar-ics'), false);
  assert.equal(adapterEnabled(config, 'rss'), false);

  const tuned = normalizeLifeConfig({
    enabled: true,
    modules: {
      calendarMorning: { enabled: true, time: '25:00', lookaheadDays: 99, weekdaysOnly: true },
      rssDigest: {
        feeds: ['少数派|https://sspai.com/feed', 'https://example.com/feed', 'not-a-url', 'https://sspai.com/feed'],
        count: 99,
        perFeedLimit: 0
      },
      weeklyReview: { weekday: 0, time: '7:5', sections: { paper: false } }
    }
  });
  assert.equal(tuned.modules.calendarMorning.time, '07:30', '非法时间回退默认');
  assert.equal(tuned.modules.calendarMorning.lookaheadDays, 7);
  assert.equal(tuned.modules.rssDigest.feeds.length, 2, '去重并丢弃非法地址');
  assert.equal(tuned.modules.rssDigest.feeds[0].name, '少数派');
  assert.equal(tuned.modules.rssDigest.count, 30);
  assert.equal(tuned.modules.rssDigest.perFeedLimit, 1);
  assert.equal(tuned.modules.weeklyReview.weekday, 1);
  assert.equal(tuned.modules.weeklyReview.time, '20:00');
  assert.equal(tuned.modules.weeklyReview.sections.paper, false);
  assert.equal(adapterEnabled(tuned, 'calendar-ics'), true, '模块开启后复用日历适配器');
  assert.equal(adapterEnabled(tuned, 'rss'), false);
  const rssOn = normalizeLifeConfig({ enabled: true, modules: { rssDigest: { enabled: true } } });
  assert.equal(adapterEnabled(rssOn, 'rss'), true);
  assert.equal(adapterEnabled(normalizeLifeConfig({ enabled: false, modules: { rssDigest: { enabled: true } } }), 'rss'), false, '总开关优先于模块开关');
});
