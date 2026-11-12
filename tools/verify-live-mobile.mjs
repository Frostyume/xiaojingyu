#!/usr/bin/env node
/**
 * 实时页手机/桌面真浏览器验证（离线 fixture，不连生产桥接、不发任何真实消息）。
 * 手机 390×844：单列 / 字号≥12 / 触控≥44 / 折叠保留数据 / 无溢出 / 连接状态置顶 / 登录可用。
 * 桌面 1440×900：心情∥图谱两列不变 / 图谱小正方形 / 次要卡自动展开 / 字号不被手机规则污染。
 * 截图存 .preview-shots/（已 gitignored）。用法：node tools/verify-live-mobile.mjs
 *
 * fixture 数据全部是演示占位：6 位演示号、公版书摘句，与真实 QQ/群/状态无关。
 */
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import { existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { LIVE_ASSET_NAMES } from '../console/policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..');
const SHOTS = join(ROOT, '.preview-shots');

// ── 离线 fixture：只服务 /live、/live-assets/*、快照与 SSE ─────────────────
function makeLiveFixture(now = Date.now()) {
  const at = (minAgo) => now - minAgo * 60000;
  return {
    ok: true,
    ts: now,
    self: { name: '小鲸鱼', userId: null },
    mode: 'demo',
    paused: false,
    nightQuiet: { enabled: true, start: '23:30', end: '08:00', active: false },
    console: { lanAccess: false, authRequired: false },
    persona: {
      mood: { label: '开心', valence: 0.42, arousal: 0.62, cause: '和大家聊起了海底探险', setPoint: 0.15 },
      mode: { id: 'soft', label: '软萌' },
      energy: 0.72,
      interests: [
        { topic: '海洋生物', weight: 0.9 },
        { topic: '古典小说', weight: 0.7 },
        { topic: '电子音乐', weight: 0.5 }
      ],
      learnings: [{ text: '鹦鹉螺号是用电力驱动的' }, { text: '群友更喜欢短一点的语音' }],
      quirks: ['诶嘿', '戳戳'],
      history: Array.from({ length: 24 }, (_, i) => ({
        at: at((24 - i) * 180),
        v: Math.round((Math.sin(i / 3) * 0.4 + 0.1) * 100) / 100,
        a: Math.round((0.4 + ((i * 7) % 10) / 25) * 100) / 100
      })),
      updatedAt: at(12),
      changelog: [
        { at: at(95), changes: ['arousal +0.10'] },
        { at: at(12), changes: ['valence +0.08', '精力 -0.02'] }
      ]
    },
    innerLife: {
      counts: { curiosity: 3, groupShare: 2, qzone: 1 },
      next: { reflection: now + 40 * 60000, curiosity: now + 25 * 60000, qzone: now + 3 * 3600000 },
      qzone: { paused: false, auto: false, approvedCount: 4 },
      pendingDraft: null,
      pendingShare: null,
      lastQzone: { text: '今天读到了鹦鹉螺号的大秘密，海底原来这么热闹', at: at(200) },
      lastShare: { text: '给大家讲一个海底两万里的冷知识', at: at(300) }
    },
    sessions: [
      { key: 'group:100001', kind: 'group', id: '100001', name: '演示群 · 深海研究所', unread: 2, pendingWakes: 1, lastIncomingAt: at(2), lastAiReplyAt: at(3), wakeMode: 'active', probability: 0.3, lastWakeReason: 'atMention', sendPerMinute: 1, sendPerHour: 6, wakePerHour: 4, busy: false },
      { key: 'private:100002', kind: 'private', id: '100002', name: '主人私聊', unread: 0, pendingWakes: 0, lastIncomingAt: at(30), lastAiReplyAt: at(29), wakeMode: 'active', probability: 1, lastWakeReason: 'question', sendPerMinute: 0, sendPerHour: 2, wakePerHour: 2, busy: false }
    ],
    reading: [
      {
        id: 'book-nautilus', title: '海底两万里', kind: 'book', chapterIndex: 0, chaptersTotal: 0,
        charOffset: 18400, totalChars: 96000, percent: 19, lastReadAt: at(35), done: false,
        excerpt: {
          quote: '大海就是一切！它覆盖了地球的十分之七。',
          summary: '阿龙纳斯教授登上鹦鹉螺号，发现尼摩船长用电力驱动潜艇，一场海底漫步即将开始。',
          title: '海底两万里', chapterIndex: 0, sourceHost: 'www.gutenberg.org', at: at(35)
        }
      },
      { id: 'video-demo', title: '深海纪录片（演示）', kind: 'video', chapterIndex: 1, chaptersTotal: 0, charOffset: 0, totalChars: null, percent: 100, lastReadAt: at(4000), done: true }
    ],
    readingToday: { items: 2, chars: 12000 },
    outerNotes: [
      { id: 'note0001', title: '海底两万里', sourceId: 'book-nautilus', sourceType: 'book', chapterIndex: 0, summary: '阿龙纳斯教授登上鹦鹉螺号，发现尼摩船长用电力驱动潜艇。', quote: '大海就是一切！它覆盖了地球的十分之七。', sourceHost: 'www.gutenberg.org', at: at(35) },
      { id: 'note0002', title: '海底两万里', sourceId: 'book-nautilus', sourceType: 'book', chapterIndex: 0, summary: '潜艇在海底森林边缘停泊，教授第一次穿上潜水服。', quote: '在这海底，我可以自由地呼吸。', sourceHost: 'www.gutenberg.org', at: at(1500) }
    ],
    relationships: {
      enabled: true,
      owner: { bond: 92.5, affection: 95, trust: 90, familiarity: 88, rapport: 85, lastDelta: { label: '接住了她的话', affection: 0.4, at: at(60) } },
      spotlight: { name: '主人', stageLabel: '亲近', tone: '温柔' },
      groups: [
        {
          id: 'group:100001', name: '演示群 · 深海研究所',
          members: [
            { id: '100002', name: '主人', bond: 92, stage: 5, stageLabel: '亲近', interactions: 120, affection: 95, trust: 90, familiarity: 88, rapport: 85, tone: '温柔', sparkline: [{ day: 'd1', bond: 80, interactions: 5 }, { day: 'd2', bond: 86, interactions: 8 }, { day: 'd3', bond: 92, interactions: 9 }], lastDelta: { label: '接住了她的话', affection: 0.4, at: at(60) } },
            { id: '100004', name: '阿澜', bond: 64, stage: 3, stageLabel: '朋友', interactions: 40, affection: 60, trust: 55, familiarity: 66, rapport: 50, tone: '轻松', sparkline: [], lastDelta: null },
            { id: '100005', name: '小满', bond: 30, stage: 1, stageLabel: '眼熟', interactions: 8, affection: 30, trust: 25, familiarity: 35, rapport: 20, tone: '客气', sparkline: [], lastDelta: null }
          ]
        }
      ]
    },
    flow: { unreadTotal: 2, pendingWakes: 1, guardHits: 0, autoAcks: 3, errors: 0, replyLatency: { last: 1800, p50: 1600, p95: 4200, count: 40 } },
    health: {
      bridge: { ok: true, pid: 4242, uptimeMs: 5 * 3600000 },
      dsh: { ok: true, baseUrl: 'http://127.0.0.1:9000' },
      snowluma: { connected: true, good: true, accountOnline: true, lastPacketAgoMs: 1200 },
      tts: { ok: true, checkedAt: at(3), provider: 'breeze' }
    },
    usage: { tokens: 1234567, cost: 12.34, input: 900000, output: 334567, turns: 210, estimated: false },
    libraries: { stickers: 8, images: 3, slangTotal: 12, slangConfirmed: 5, voices: 2, qzonePosts: 4 },
    content: {
      signature: { enabled: true, lastText: '海底的风暴也会过去', minIntervalHours: 12, maxIntervalHours: 48, nextAt: now + 3600000 },
      voiceStyle: { effective: 'soft', mode: 'auto', valence: 0.42, transport: { mode: 'opus', bitrate: '32k', normalize: true, loudness: 'normal' } },
      expression: { caps: { sendPerMinute: 12, voicePerMinute: 6, sharePerDay: 20, qzonePerDay: 10 }, lastStickerAt: at(40), lastImageAt: at(300), lastVoiceAt: at(90) },
      esports: { enabled: false },
      share: { today: 1, maxPerDay: 4, targets: ['group:100001'], last: { text: '给大家讲一个海底两万里的冷知识', at: at(300) } },
      qzone: { commentWatch: { repliedToday: 1, maxPerDay: 5, mentionRepliedToday: 0, mentionMaxPerDay: 5, lastCheckAt: at(10), lastResult: '无新评论' } },
      aiTips: { enabled: true, target: 'group:100001', targetLabel: '演示群', today: 1, minPerDay: 2, maxPerDay: 5, nextAt: now + 1800000, last: { category: 'llm', categoryLabel: '大模型', title: '注意力机制是什么', topic: '注意力机制' } },
      shareModules: { modules: [] },
      ownerFeatures: { features: [], capabilities: [], orchestrator: { pending: 0 } },
      library: { enabled: true, stickers: 8, images: 3 },
      stickerCollect: { enabled: true, pending: 0 },
      crossChat: { groups: ['group:100001'], privates: [] },
      search: { provider: 'auto', model: '默认', configured: false, maxResults: 8 },
      memory: { total: 3, personalCount: 2, byScope: { personal: 2, group: 1 }, recentFacts: [{ scope: 'personal', topic: '阅读', fact: '她在读《海底两万里》', lastSeenAt: at(35) }], ftsReady: true },
      dailyReport: { enabled: false, at: '21:30' }
    },
    activity: [
      { type: 'send', ts: at(3), text: '回复了演示群的消息' },
      { type: 'wake', ts: at(4), text: '被 @ 唤醒' },
      { type: 'health', ts: at(10), text: 'TTS 在线' }
    ]
  };
}

async function startLiveFixture() {
  const snapshot = makeLiveFixture();
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const security = { 'x-frame-options': 'DENY', 'cache-control': 'no-store' };
    if (url.pathname === '/live') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...security });
      res.end(fs.readFileSync(join(ROOT, 'web', 'live.html'), 'utf8'));
      return;
    }
    if (url.pathname.startsWith('/live-assets/')) {
      const name = url.pathname.split('/').pop();
      if (!LIVE_ASSET_NAMES.has(name)) { res.writeHead(404, security); res.end(); return; }
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' });
      res.end(fs.readFileSync(join(ROOT, 'web', 'assets', name)));
      return;
    }
    if (url.pathname === '/api/live/snapshot') {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', ...security });
      res.end(JSON.stringify({ ...snapshot, ts: Date.now() }));
      return;
    }
    if (url.pathname === '/api/live/stream') {
      res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 3000\n\n');
      const send = () => { try { res.write(`data: ${JSON.stringify({ ...snapshot, ts: Date.now() })}\n\n`); } catch {} };
      send();
      const timer = setInterval(send, 1000);
      const cleanup = () => clearInterval(timer);
      req.on('close', cleanup);
      res.on('close', cleanup);
      return;
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204, security); res.end(); return; }
    res.writeHead(404, security);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.closeAllConnections?.(); server.close(resolve); })
  };
}

async function loadPlaywright() {
  const require = createRequire(import.meta.url);
  for (const candidate of [process.env.PLAYWRIGHT_MODULE, 'playwright'].filter(Boolean)) {
    try { return require(candidate); } catch {}
  }
  throw new Error('Playwright not found. Install with npm install --no-save playwright, or set PLAYWRIGHT_MODULE.');
}
const { chromium } = await loadPlaywright();
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || [
  join(process.env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'),
  join(process.env['PROGRAMFILES(X86)'] || '', 'Microsoft/Edge/Application/msedge.exe'),
].find((x) => existsSync(x));

const fixture = await startLiveFixture();
await mkdir(SHOTS, { recursive: true });
let browser;
const errors = [];
const blocked = [];
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed += 1; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}: ${e.message}`); process.exitCode = 1; }
}

try {
  browser = await chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });

  // ── 手机 390×844 ──────────────────────────────────────────────────────────
  const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  await mobile.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === fixture.url) return route.continue();
    blocked.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const mp = await mobile.newPage();
  mp.on('pageerror', (e) => errors.push('mobile pageerror: ' + e.message));
  mp.on('console', (m) => { if (m.type() === 'error') errors.push('mobile console: ' + m.text()); });
  await mp.goto(fixture.url + '/live');
  await mp.waitForFunction(() => document.getElementById('moodLabel')?.textContent !== '--' && document.getElementById('connState')?.textContent === '● LIVE', null, { timeout: 10000 });

  await check('手机：所有卡片单列（span 12）', async () => {
    const spans = await mp.evaluate(() => [...document.querySelectorAll('.grid > *')].map((el) => getComputedStyle(el).gridColumnStart));
    assert.ok(spans.length >= 18, `网格项足够多（${spans.length}）`);
    assert.ok(spans.every((s) => s === 'span 12'), `存在非整宽项：${spans.filter((s) => s !== 'span 12').join(',')}`);
  });

  await check('手机：无横向溢出', async () => {
    const overflow = await mp.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 1, `横向溢出 ${overflow}px`);
  });

  await check('手机：可见文本字号 ≥12px，正文 14px', async () => {
    const r = await mp.evaluate(() => {
      let min = 99; let minEl = '';
      const walk = (el) => {
        for (const node of el.children) {
          if (['SCRIPT', 'STYLE'].includes(node.tagName) || node.tagName === 'svg') continue;
          // 收起的 details 内容不参与可见字号统计；summary 仍可见。
          if (node.closest('details:not([open])') && node.tagName !== 'SUMMARY' && !node.closest('summary')) continue;
          const cs = getComputedStyle(node);
          if (cs.display === 'none' || cs.visibility === 'hidden' || Number(cs.opacity) === 0) continue;
          if (!node.getClientRects().length) continue;
          const hasText = [...node.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
          if (hasText) {
            const fs = parseFloat(cs.fontSize);
            if (fs < min) { min = fs; minEl = node.tagName + '.' + node.className; }
          }
          walk(node);
        }
      };
      walk(document.body);
      return { min, minEl, body: parseFloat(getComputedStyle(document.body).fontSize), speech: parseFloat(getComputedStyle(document.getElementById('moodSpeech')).fontSize) };
    });
    assert.ok(r.min >= 12, `最小字号 ${r.min}px @ ${r.minEl}`);
    assert.equal(r.body, 14, '基础字号 14px');
    assert.ok(r.speech >= 14, '气泡正文 ≥14px');
  });

  await check('手机：优先面板展开、次要面板默认折叠且数据仍在 DOM', async () => {
    const r = await mp.evaluate(() => {
      const auto = [...document.querySelectorAll('details.fold[data-desktop-open]')];
      const anchors = ['relGraph', 'interests', 'timeline', 'owNotes', 'bonds', 'sessions', 'health', 'usage'];
      return {
        autoCount: auto.length,
        autoOpen: auto.filter((d) => d.open).map((d) => d.id),
        legacyOpen: [...document.querySelectorAll('#signalsCard,#memoryCard,#libraryCard')].filter((d) => d.open).map((d) => d.id),
        anchorsMissing: anchors.filter((id) => !document.getElementById(id)),
        moodVisible: Boolean(document.getElementById('compass')?.getClientRects().length),
        feedVisible: Boolean(document.getElementById('feed')?.getClientRects().length),
        readingVisible: Boolean(document.getElementById('readingList')?.getClientRects().length),
        spriteVisible: Boolean(document.getElementById('sprite')?.getClientRects().length)
      };
    });
    assert.equal(r.autoCount, 8, '8 张次要卡是自动折叠卡');
    assert.deepEqual(r.autoOpen, [], '手机上默认全部收起');
    assert.deepEqual(r.legacyOpen, [], '原有三张折叠卡也收起');
    assert.deepEqual(r.anchorsMissing, [], '折叠不删数据锚点');
    assert.ok(r.moodVisible && r.feedVisible && r.readingVisible && r.spriteVisible, '心情/最近活动/她在读/像素形象优先可见');
  });

  await check('手机：折叠卡可展开，图谱展开后有非零尺寸 SVG', async () => {
    await mp.click('#graphCard > summary');
    await mp.waitForFunction(() => document.getElementById('graphCard').open, null, { timeout: 3000 });
    const size = await mp.evaluate(() => {
      const svg = document.querySelector('#relGraph svg');
      return svg ? { w: svg.clientWidth, h: svg.clientHeight } : null;
    });
    assert.ok(size && size.w > 100 && size.h > 100, `图谱 SVG 尺寸 ${JSON.stringify(size)}`);
    await mp.screenshot({ path: join(SHOTS, 'live-mobile-graph-open.png') });
    await mp.click('#graphCard > summary');
    await mp.waitForFunction(() => !document.getElementById('graphCard').open, null, { timeout: 3000 });
  });

  await check('手机：触控目标 ≥44px（summary/群筛选/摘录展开）', async () => {
    await mp.click('#bondsCard > summary');
    await mp.waitForFunction(() => document.getElementById('bondsCard').open, null, { timeout: 3000 });
    const r = await mp.evaluate(() => {
      const targets = [...document.querySelectorAll('details.fold > summary, .bonds-tabs button, .reading-summary > summary')]
        .filter((el) => el.getClientRects().length);
      const small = targets.filter((el) => el.getBoundingClientRect().height < 44).map((el) => `${el.tagName}.${el.className}=${el.getBoundingClientRect().height}`);
      return { count: targets.length, small };
    });
    assert.ok(r.count >= 12, `触控目标足够多（${r.count}）`);
    assert.deepEqual(r.small, [], `小于 44px 的触控目标：${r.small.join('; ')}`);
    await mp.click('#bondsCard > summary');
    await mp.waitForFunction(() => !document.getElementById('bondsCard').open, null, { timeout: 3000 });
  });

  await check('手机：连接状态置顶且为 LIVE 绿色', async () => {
    await mp.evaluate(() => window.scrollTo(0, 0));
    const r = await mp.evaluate(() => {
      const conn = document.getElementById('connState');
      const sprite = document.getElementById('sprite');
      const cs = getComputedStyle(conn);
      const rect = conn.getBoundingClientRect();
      const topEl = document.elementFromPoint(rect.left + rect.width / 2, rect.top + rect.height / 2);
      return {
        text: conn.textContent, cls: conn.className, color: cs.color,
        aboveSprite: rect.top < sprite.getBoundingClientRect().top,
        notCovered: conn.contains(topEl) || topEl === conn,
        topEl: topEl ? topEl.tagName + '.' + topEl.className : 'null',
        rectTop: rect.top
      };
    });
    assert.equal(r.text, '● LIVE');
    assert.equal(r.cls, 'live');
    assert.ok(r.color.includes('52, 211, 153') || r.color.includes('34d399'), `LIVE 应为绿色：${r.color}`);
    assert.ok(r.aboveSprite, '连接状态在像素形象上方');
    assert.ok(r.notCovered, `连接状态无遮挡（topEl=${r.topEl}, rectTop=${r.rectTop}）`);
  });

  await check('手机：令牌登录框触控友好（输入 16px/48px，按钮 48px）', async () => {
    const r = await mp.evaluate(() => {
      document.getElementById('app').hidden = true;
      document.getElementById('login').classList.remove('hidden');
      const input = document.getElementById('tokenInput');
      const btn = document.getElementById('loginBtn');
      const card = document.querySelector('.login-card');
      return {
        inputFont: parseFloat(getComputedStyle(input).fontSize),
        inputH: input.getBoundingClientRect().height,
        btnH: btn.getBoundingClientRect().height,
        cardW: card.getBoundingClientRect().width,
        viewport: window.innerWidth
      };
    });
    assert.equal(r.inputFont, 16, '输入 16px 防 iOS 聚焦缩放');
    assert.ok(r.inputH >= 48, `输入高度 ${r.inputH}`);
    assert.ok(r.btnH >= 48, `按钮高度 ${r.btnH}`);
    assert.ok(r.cardW <= r.viewport, '登录卡不超出视口');
    await mp.screenshot({ path: join(SHOTS, 'live-mobile-login.png') });
    await mp.evaluate(() => {
      document.getElementById('login').classList.add('hidden');
      document.getElementById('app').hidden = false;
    });
  });

  await check('手机：安全区留白生效（headless env=0 时回退 14px）', async () => {
    const pad = await mp.evaluate(() => parseFloat(getComputedStyle(document.getElementById('app')).paddingLeft));
    assert.ok(pad >= 14, `左留白 ${pad}px`);
  });

  await mp.screenshot({ path: join(SHOTS, 'live-mobile-390-top.png') });
  await mp.screenshot({ path: join(SHOTS, 'live-mobile-390-full.png'), fullPage: true });

  await check('手机→桌面→手机：折叠模式随断点切换，用户展开保留', async () => {
    await mp.click('#growthCard > summary'); // 用户在手机上展开兴趣卡
    await mp.waitForFunction(() => document.getElementById('growthCard').open, null, { timeout: 3000 });
    await mp.setViewportSize({ width: 1440, height: 900 });
    await mp.waitForFunction(() => [...document.querySelectorAll('details.fold[data-desktop-open]')].every((d) => d.open), null, { timeout: 3000 });
    await mp.setViewportSize({ width: 390, height: 844 });
    await mp.waitForFunction(() => {
      const auto = [...document.querySelectorAll('details.fold[data-desktop-open]')];
      return auto.every((d) => (d.id === 'growthCard' ? d.open : !d.open));
    }, null, { timeout: 3000 });
  });
  await mobile.close();

  // ── 桌面 1440×900 ─────────────────────────────────────────────────────────
  const desktop = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await desktop.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === fixture.url) return route.continue();
    blocked.push(route.request().url());
    return route.abort('blockedbyclient');
  });
  const dp = await desktop.newPage();
  dp.on('pageerror', (e) => errors.push('desktop pageerror: ' + e.message));
  dp.on('console', (m) => { if (m.type() === 'error') errors.push('desktop console: ' + m.text()); });
  await dp.goto(fixture.url + '/live');
  await dp.waitForFunction(() => document.getElementById('moodLabel')?.textContent !== '--' && document.getElementById('connState')?.textContent === '● LIVE', null, { timeout: 10000 });

  await check('桌面：心情∥图谱两列不变，图谱小正方形', async () => {
    const r = await dp.evaluate(() => {
      const mood = document.getElementById('compass').closest('.card');
      const graph = document.getElementById('graphCard');
      const mr = mood.getBoundingClientRect();
      const gr = graph.getBoundingClientRect();
      const rel = document.getElementById('relGraph').getBoundingClientRect();
      return {
        sideBySide: mr.right <= gr.left + 2 && Math.abs(mr.top - gr.top) < 4,
        moodSpan: getComputedStyle(mood).gridColumnStart,
        graphSpan: getComputedStyle(graph).gridColumnStart,
        square: Math.abs(rel.width - rel.height) <= 2,
        graphSize: rel.width
      };
    });
    assert.ok(r.sideBySide, '心情在左、图谱在右、同一行');
    assert.equal(r.moodSpan, 'span 6');
    assert.equal(r.graphSpan, 'span 6');
    assert.ok(r.square, '图谱容器正方形');
    assert.ok(r.graphSize <= 380 && r.graphSize >= 280, `图谱边长 ${r.graphSize}px`);
  });

  await check('桌面：次要卡自动展开，原三张折叠卡仍收起', async () => {
    const r = await dp.evaluate(() => ({
      autoClosed: [...document.querySelectorAll('details.fold[data-desktop-open]')].filter((d) => !d.open).map((d) => d.id),
      legacyOpen: [...document.querySelectorAll('#signalsCard,#memoryCard,#libraryCard')].filter((d) => d.open).map((d) => d.id),
      arrowHidden: getComputedStyle(document.querySelector('#graphCard > summary'), '::after').display === 'none'
    }));
    assert.deepEqual(r.autoClosed, [], '桌面端次要卡全部展开');
    assert.deepEqual(r.legacyOpen, [], '动向/记忆/资源库仍默认收起');
    assert.ok(r.arrowHidden, '桌面端不显示折叠箭头');
  });

  await check('桌面：字号未被手机规则污染（body 13px / h2 10px）', async () => {
    const r = await dp.evaluate(() => ({
      body: parseFloat(getComputedStyle(document.body).fontSize),
      h2: parseFloat(getComputedStyle(document.querySelector('.card h2')).fontSize),
      overflow: document.documentElement.scrollWidth - window.innerWidth
    }));
    assert.equal(r.body, 13);
    assert.equal(r.h2, 10);
    assert.ok(r.overflow <= 1, `横向溢出 ${r.overflow}px`);
  });

  await dp.screenshot({ path: join(SHOTS, 'live-desktop-1440-top.png') });
  await dp.screenshot({ path: join(SHOTS, 'live-desktop-1440-full.png'), fullPage: true });
  await desktop.close();

  await check('无页面错误 / 无外部请求', async () => {
    assert.deepEqual(errors, []);
    assert.deepEqual(blocked, []);
  });

  console.log(`\n${passed} 项浏览器断言通过；截图在 .preview-shots/`);
} finally {
  if (browser) await browser.close();
  await fixture.close();
}