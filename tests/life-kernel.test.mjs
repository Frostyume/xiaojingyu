// 生活管家 P0：manifest / 适配器解析 / 去重 / TTL / 简报预算 / 脱敏 / 抓取守卫 / kill switch。
// 全部使用 fixtures，不发起任何真实网络请求。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, SCHEMA_VERSION } from '../runtime/kernel/db.js';
import { createLifeButler } from '../services/social/life/index.js';
import { normalizeLifeConfig } from '../services/social/life/config.js';
import { validateManifest, MANIFEST_KEYS, defaultAdaptersDir } from '../services/social/life/kernel/registry.js';
import { createFetchGuard, LifeAuthError, LifeHttpError, LifeOversizeError } from '../services/social/life/kernel/fetch-guard.js';
import { parseIcs } from '../services/social/life/adapters/calendar-ics/index.js';
import { parseRss } from '../services/social/life/adapters/rss/index.js';
import {
  parseRepoMeta, parseRepoIssues, parseRepoPulls, parseReleases, buildRepoDelta
} from '../services/social/life/adapters/github/index.js';
import { parseArxiv } from '../services/social/life/adapters/arxiv/index.js';
import { parseOpenAlexWork, dedupePapers, firstSentence, reconstructAbstract } from '../services/social/life/adapters/paper/index.js';
import { buildBrief, buildPromptSection, estimateTokens, BRIEF_MAX_TOKENS } from '../services/social/life/kernel/brief.js';
import { redactText, sanitizeTitle } from '../services/social/life/kernel/redact.js';
import { createRetention } from '../services/social/life/kernel/retention.js';
import { ensureLifeSchema } from '../services/social/life/kernel/schema.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ADAPTERS = path.join(HERE, '..', 'services', 'social', 'life', 'adapters');
const NOW = Date.UTC(2026, 10, 1, 2, 0, 0); // 2026-11-01 10:00 Asia/Shanghai
const DAY = 24 * 60 * 60 * 1000;

function fixture(adapter, name) {
  return fs.readFileSync(path.join(ADAPTERS, adapter, 'fixtures', name), 'utf8');
}

function textResponse(body, contentType = 'text/plain') {
  return {
    status: 200,
    headers: { 'content-type': contentType },
    text: async () => body
  };
}

function makeDb() {
  return openDatabase({ file: ':memory:' });
}

function makePort({ db, config, notify = async () => ({ ok: true }) } = {}) {
  const scheduler = {
    handlers: new Map(),
    registered: [],
    enqueued: [],
    register(type, handler) { this.handlers.set(type, handler); this.registered.push(type); return this; },
    enqueue(input) { this.enqueued.push(input); return { id: this.enqueued.length, existed: false }; },
    cancel() { return 0; }
  };
  return {
    config: () => ({ lifeButler: config }),
    log: () => {},
    clock: { now: () => NOW },
    db,
    scheduler,
    notify,
    http: { fetch: async () => { throw new Error('端口 http 不应被直接调用'); } }
  };
}

test('schema 已包含 life 表，且版本号同步', () => {
  assert.ok(SCHEMA_VERSION >= 4);
  const db = makeDb();
  ensureLifeSchema(db);
  const tables = db.all("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'life_%' ORDER BY name")
    .map((row) => row.name);
  assert.deepEqual(tables, ['life_health', 'life_items', 'life_sync_state', 'life_watch']);
});

test('五个 manifest 合法；未知字段/写能力被拒绝', () => {
  const names = fs.readdirSync(defaultAdaptersDir(), { withFileTypes: true })
    .filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  assert.deepEqual(names, ['arxiv', 'calendar-ics', 'github', 'paper', 'rss']);
  for (const dir of names) {
    const manifest = JSON.parse(fs.readFileSync(path.join(ADAPTERS, dir, 'manifest.json'), 'utf8'));
    const ok = validateManifest(manifest, { dirName: dir });
    assert.equal(ok.ok, true, `${dir}: ${ok.errors.join('; ')}`);
    assert.deepEqual([...Object.keys(manifest)].sort(), [...MANIFEST_KEYS].sort());
    assert.deepEqual(manifest.actions, []);

    const unknown = { ...manifest, extraField: true };
    assert.equal(validateManifest(unknown, { dirName: dir }).ok, false);

    const write = { ...manifest, capabilities: ['write:calendar'] };
    assert.equal(validateManifest(write, { dirName: dir }).ok, false);

    const badRisk = { ...manifest, risk: { default: 'L0', max: 'L2' } };
    assert.equal(validateManifest(badRisk, { dirName: dir }).ok, false);
  }
});

test('ICS 解析：取消事件标 dismissed，畸形内容抛错', () => {
  const items = parseIcs(fixture('calendar-ics', 'basic.ics'), { nowMs: NOW, timeZone: 'Asia/Shanghai', lookaheadDays: 14 });
  assert.equal(items.length, 3);
  assert.equal(items[0].kind, 'calendar');
  assert.match(items[0].title, /周会/);
  assert.equal(items[2].status, 'dismissed');
  assert.match(items[0].dedupeKey, /^ics:fixture-meeting-1:/);
  assert.throws(() => parseIcs(fixture('calendar-ics', 'malformed.ics'), { nowMs: NOW }), /无法解析/);
  assert.throws(() => parseIcs('<html>not ics</html>', { nowMs: NOW }), /不是有效的 ICS/);
});

test('RSS / GitHub / arXiv / 论文 解析 fixtures；畸形 RSS 抛错', () => {
  const rss = parseRss(fixture('rss', 'feed.xml'), { nowMs: NOW, feedHost: 'feed.example.com' });
  assert.equal(rss.length, 2);
  assert.equal(rss[0].kind, 'feed');
  assert.match(rss[0].title, /Read-only agents/);
  assert.match(rss[0].dedupeKey, /^rss:feed\.example\.com:/);
  assert.throws(() => parseRss(fixture('rss', 'malformed.xml'), { nowMs: NOW }), /缺少标题/);
  assert.throws(() => parseRss('<html></html>', { nowMs: NOW }), /不是有效的 RSS/);

  const meta = parseRepoMeta(JSON.parse(fixture('github', 'repo.json')));
  assert.deepEqual(meta, { stars: 128, forks: 12, openIssuesTotal: 5 });
  const issues = parseRepoIssues(JSON.parse(fixture('github', 'issues.json')));
  assert.equal(issues.length, 2); // issues 接口混入的 PR 必须过滤
  assert.equal(issues[0].number, 101);
  const pulls = parseRepoPulls(JSON.parse(fixture('github', 'pulls.json')));
  assert.equal(pulls.length, 2);
  const releases = parseReleases(JSON.parse(fixture('github', 'releases.json')));
  assert.equal(releases.length, 2);

  const baseline = buildRepoDelta({ repo: 'owner/example', meta, issues, pulls, releases, previous: null, nowMs: NOW });
  assert.equal(baseline.baseline, true);
  assert.equal(baseline.drafts.length, 0);
  assert.equal(baseline.repo.openIssues, 3); // open_issues_count 含 PR，需要减掉
  assert.equal(baseline.repo.openPulls, 2);

  const delta = buildRepoDelta({
    repo: 'owner/example',
    meta: { ...meta, stars: 130, forks: 13 },
    issues: [...issues, { number: 105, title: 'Fresh issue', author: 'eve', state: 'open', updatedAt: NOW, url: '' }],
    pulls,
    releases,
    previous: baseline.snapshot,
    nowMs: NOW + 1000
  });
  assert.equal(delta.repo.starDelta, 2);
  assert.equal(delta.repo.forkDelta, 1);
  assert.equal(delta.repo.issues.length, 1);
  assert.equal(delta.repo.issues[0].number, 105);
  assert.equal(delta.drafts.length, 1);

  const arxiv = parseArxiv(fixture('arxiv', 'feed.xml'), { nowMs: NOW });
  assert.equal(arxiv.length, 2);
  assert.equal(arxiv[0].kind, 'paper');
  assert.equal(arxiv[0].externalId, '2610.00001v1');
  assert.throws(() => parseArxiv('<feed><entry></entry></feed>', { nowMs: NOW }), /缺少标题或 id/);

  const works = JSON.parse(fixture('paper', 'openalex.json')).results;
  const papers = works.map((work) => parseOpenAlexWork(work, { nowMs: NOW }));
  assert.equal(papers.length, 3);
  assert.equal(papers[0].venue, 'Conference on Example Systems');
  assert.deepEqual(papers[0].institutions, ['Example University', 'Sample Lab']);
  assert.match(papers[0].abstract, /^Long documents make retrieval expensive\./);
  assert.equal(papers[1].institutions.length, 0);

  const deduped = dedupePapers(papers);
  assert.equal(deduped.length, 2); // 标题+年份相同视为同一篇
  const merged = deduped.find((paper) => /Retrieval-Augmented/.test(paper.title));
  assert.equal(merged.doi, '10.1234/example.2026.001'); // 优先保留正式发表版本
  assert.equal(merged.year, 2026);
  assert.match(reconstructAbstract(works[0].abstract_inverted_index), /chunked index/);
  assert.equal(firstSentence('Long documents make retrieval expensive. We test.'), 'Long documents make retrieval expensive.');
});

test('同步落库去重：GitHub 首次只建基线，之后只写变化；来源正文不落库', async () => {
  const db = makeDb();
  const config = normalizeLifeConfig({
    enabled: true,
    adapters: { 'calendar-ics': { enabled: true, url: 'https://cal.example.com/basic.ics' } },
    modules: { github: { enabled: true, repos: ['owner/example'], frequency: 'daily', time: '09:00' } }
  });
  const port = makePort({ db, config });
  const issuesFixture = JSON.parse(fixture('github', 'issues.json'));
  let issueRound = 0;
  const butler = createLifeButler(port, {
    fetchImpl: async (url) => {
      const parsed = new URL(url);
      if (parsed.hostname === 'cal.example.com') return textResponse(fixture('calendar-ics', 'basic.ics'), 'text/calendar');
      if (parsed.hostname === 'api.github.com') {
        const pathname = parsed.pathname;
        if (pathname.endsWith('/issues')) {
          issueRound += 1;
          const payload = issueRound === 1 ? issuesFixture : [...issuesFixture, {
            number: 105,
            title: 'Fresh issue',
            state: 'open',
            user: { login: 'eve' },
            updated_at: '2026-11-01T06:00:00Z',
            html_url: 'https://github.com/owner/example/issues/105'
          }];
          return textResponse(JSON.stringify(payload), 'application/json');
        }
        if (pathname.endsWith('/pulls')) return textResponse(fixture('github', 'pulls.json'), 'application/json');
        if (pathname.endsWith('/releases')) return textResponse(fixture('github', 'releases.json'), 'application/json');
        if (pathname === '/repos/owner/example') return textResponse(fixture('github', 'repo.json'), 'application/json');
      }
      return { status: 404, headers: {}, text: async () => '' };
    },
    resolve: async () => ['93.184.216.34']
  });
  await butler.init();
  const calendar = butler.adapters.find((adapter) => adapter.id === 'calendar-ics');
  const github = butler.adapters.find((adapter) => adapter.id === 'github');
  assert.ok(calendar && github);
  assert.equal(github.enabled, true);

  const first = await butler.pipeline.syncAdapter(calendar, { reason: 'test' });
  assert.equal(first.inserted, 3);
  const second = await butler.pipeline.syncAdapter(calendar, { reason: 'test' });
  assert.equal(second.inserted, 0);
  assert.equal(second.skipped, 3);

  const gh1 = await butler.pipeline.syncAdapter(github, { reason: 'test' });
  assert.equal(gh1.inserted, 0); // 首次只建基线，不把历史刷给主人
  assert.equal(gh1.meta.baseline, true);
  butler.health.recordSuccess('github', { cursor: gh1.cursor });

  const gh2 = await butler.pipeline.syncAdapter(github, { reason: 'test' });
  assert.equal(gh2.inserted, 1);
  assert.equal(gh2.meta.changes, 1);

  const rows = db.all('SELECT * FROM life_items');
  assert.equal(rows.length, 4);
  for (const row of rows) {
    assert.equal(row.summary, null);
    assert.equal(row.payload_json.includes('summary'), false);
    assert.ok(row.expires_at > NOW);
  }
  const counts = butler.status().counts;
  assert.equal(counts.open, 3);
  assert.equal(counts.dismissed, 1);
});

test('TTL：默认 90 天过期；retention 清理过期与陈旧条目', () => {
  const db = makeDb();
  const config = normalizeLifeConfig({ enabled: true, retention: { itemDays: 2 } });
  const pipeline = createLifeButler(makePort({ db, config }), { schedule: false }).pipeline;
  const summary = pipeline.store('rss', [{ kind: 'feed', title: '短 TTL 条目', dedupeKey: 'ttl:1', startsAt: NOW }], { madeAt: NOW });
  assert.equal(summary.inserted, 1);
  const row = db.get('SELECT * FROM life_items WHERE dedupe_key = ?', 'ttl:1');
  assert.equal(row.expires_at, NOW + 2 * DAY);

  const retention = createRetention({ db, config, clock: { now: () => NOW }, logger: () => {} });
  const later = NOW + 3 * DAY;
  const out = retention.run(later, { adapterIds: ['rss'] });
  assert.equal(out.items, 1);
  assert.equal(db.get('SELECT COUNT(*) AS n FROM life_items').n, 0);
});

test('query 最多 20 条，且只返回展示字段', () => {
  const db = makeDb();
  const config = normalizeLifeConfig({ enabled: true });
  const pipeline = createLifeButler(makePort({ db, config }), { schedule: false }).pipeline;
  const drafts = Array.from({ length: 30 }, (_, index) => ({
    kind: 'feed', title: `条目 ${index}`, dedupeKey: `cap:${index}`, startsAt: NOW + index * 60000
  }));
  pipeline.store('rss', drafts, { madeAt: NOW });
  const items = pipeline.query({ limit: 200 });
  assert.equal(items.length, 20);
  for (const item of items) {
    assert.deepEqual(Object.keys(item).sort(), ['adapter', 'dueAt', 'endsAt', 'id', 'kind', 'startsAt', 'status', 'title', 'updatedAt']);
  }
});

test('简报 ≤300 tokens，空数据给「今日无日程」，提示词小节同样受限', () => {
  const items = Array.from({ length: 80 }, (_, index) => ({
    id: `i${index}`,
    title: `这是一个很长很长的日程标题用于测试预算裁剪第${index}条`,
    status: 'open',
    startsAt: NOW + index * 60000,
    dueAt: null,
    endsAt: null
  }));
  const brief = buildBrief({ items, nowMs: NOW, timeZone: 'Asia/Shanghai', maxTokens: BRIEF_MAX_TOKENS });
  assert.ok(brief.tokens <= BRIEF_MAX_TOKENS, `tokens=${brief.tokens}`);
  assert.ok(brief.lines.length <= 12);

  const section = buildPromptSection({ brief, maxTokens: BRIEF_MAX_TOKENS });
  assert.ok(estimateTokens(section.text) <= BRIEF_MAX_TOKENS);
  assert.match(section.text, /不可信/);

  const empty = buildBrief({ items: [], nowMs: NOW, timeZone: 'Asia/Shanghai' });
  assert.equal(empty.text, '今日无日程');
});

test('脱敏：手机号/邮箱/URL/单号/地址不进入标题', () => {
  const raw = '联系 13800138000 或 a.b@example.com 看 https://example.com/x?token=1 单号 123456789012345678 地址 北京市朝阳区建国路88号3栋';
  const clean = redactText(raw);
  assert.equal(clean.includes('13800138000'), false);
  assert.equal(clean.includes('a.b@example.com'), false);
  assert.equal(clean.includes('https://example.com'), false);
  assert.equal(clean.includes('123456789012345678'), false);
  assert.match(clean, /\[手机\]/);
  assert.match(clean, /\[邮箱\]/);
  assert.match(clean, /\[链接\]/);
  assert.match(clean, /\[(单号|证件)\]/);
  assert.ok(sanitizeTitle('x'.repeat(200)).length <= 80);
});

test('抓取守卫：仅 HTTPS、白名单、拒绝私网、限重定向、限响应体、认证失败分类', async () => {
  const resolve = async () => ['93.184.216.34'];
  const guard = createFetchGuard({
    allowedHosts: ['example.com'],
    resolve,
    maxBytes: 2048,
    fetchImpl: async (url) => {
      if (url.includes('redirect-private')) {
        return { status: 302, headers: { location: 'https://127.0.0.1/secret' }, text: async () => '' };
      }
      if (url.includes('redirect-ok')) {
        return { status: 302, headers: { location: 'https://example.com/ok' }, text: async () => '' };
      }
      if (url.includes('auth')) return { status: 401, headers: {}, text: async () => '' };
      if (url.includes('big')) {
        return { status: 200, headers: { 'content-length': '999999' }, text: async () => 'x' };
      }
      return { status: 200, headers: { 'content-type': 'text/plain' }, text: async () => 'ok' };
    }
  });

  await assert.rejects(guard.fetch('http://example.com/x'), (error) => error instanceof LifeHttpError && error.code === 'not-https');
  await assert.rejects(guard.fetch('https://127.0.0.1/x'), (error) => error instanceof LifeHttpError && error.code === 'private-host');
  await assert.rejects(guard.fetch('https://evil.example/x'), (error) => error instanceof LifeHttpError && error.code === 'host-not-allowed');
  await assert.rejects(guard.fetch('https://example.com/redirect-private'), (error) => error instanceof LifeHttpError && error.code === 'private-host');
  assert.equal((await guard.fetch('https://example.com/redirect-ok')).body, 'ok');
  await assert.rejects(guard.fetch('https://example.com/auth'), (error) => error instanceof LifeAuthError);
  await assert.rejects(guard.fetch('https://example.com/big'), (error) => error instanceof LifeOversizeError);
});

test('kill switch：enabled=false 不触碰数据库、不注册任务，所有方法返回 disabled', async () => {
  let touched = 0;
  const trap = new Proxy({}, { get() { touched += 1; throw new Error('disabled 时不应访问数据库'); } });
  const config = normalizeLifeConfig({ enabled: false });
  const port = makePort({ db: trap, config });
  const butler = createLifeButler(port);
  assert.equal(butler.enabled, false);
  assert.deepEqual(butler.status().adapters, []);
  assert.equal(butler.brief().disabled, true);
  assert.equal(butler.query().disabled, true);
  assert.equal(butler.watch().disabled, true);
  assert.equal(butler.unwatch().disabled, true);
  assert.equal((await butler.start()).disabled, true);
  assert.equal(touched, 0);
  assert.equal(port.scheduler.registered.length, 0);
  assert.equal(port.scheduler.enqueued.length, 0);
});

test('端口 http 不被直接使用；适配器只走 guard（配置缺失时明确报错）', async () => {
  const db = makeDb();
  const config = normalizeLifeConfig({ enabled: true, adapters: { rss: { enabled: true } } });
  let portHttpCalls = 0;
  const port = makePort({ db, config });
  port.http = { fetch: async () => { portHttpCalls += 1; return textResponse(''); } };
  const butler = createLifeButler(port, { fetchImpl: async () => textResponse('') });
  await butler.init();
  const rss = butler.adapters.find((adapter) => adapter.id === 'rss');
  await assert.rejects(butler.pipeline.syncAdapter(rss, { reason: 'test' }), /未配置 RSS 地址/);
  assert.equal(portHttpCalls, 0);
});
