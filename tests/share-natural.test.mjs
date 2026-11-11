// 分享自然化红自测：
//   1) 去缩进——任何模板的正文段首都不再有全角空格 U+3000，段间仍留空行；
//   2) 去固定开场腔——SHARE_VOICE_BLOCK 不再强制「第一句先写反应（诶/唔…）」；
//   3) 非科普分享——图/链接在前，随后 1–3 条独立短点评（多条 send），不再合成一大段；
//   4) 科普/金融——仍单条大段（去缩进、留空行）。
// 对照锚点：关闭自然分条后非科普回到旧的一大段；科普无论开关都单条。
// 全部用 mock sender / mock DSH 会话，绝不发真实 QQ；media.mode=none + 无候选池 => 不触网。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createInnerLife } from '../services/persona/inner-life.js';
import { formatShareCaption, formatTipCaption } from '../runtime/share/share-format.js';
import { SHARE_VOICE_BLOCK } from '../runtime/persona/persona-voice.js';

const INDENT = '　　';
const GROUP = 'group:87654321';
const NEWS_TEXT = '昨晚那场球打得真好看，我全程盯着屏幕没敢走神。第一局输的时候我还以为要凉了。结果后面越打越稳，节奏完全回来了。最后那波团战太关键，直接让二追三。这种翻盘我看一次激动一次。';
const NEWS_URL = 'https://example.com/match-1';

function makeHarness({ template = 'news', naturalEnabled = true, mediaMode = 'none', output = null } = {}) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-share-natural-'));
  const sent = [];
  const images = [];
  let currentOutput = output;
  let innerRef = null;
  const cfg = {
    ownerQQ: '12345678',
    features: { shareModule: true, customShare: true },
    simulation: {
      innerLife: { enabled: true },
      nightQuiet: { enabled: false },
      shareModules: {
        enabled: true,
        natural: { enabled: naturalEnabled },
        limits: { globalMaxPerDay: 10, perGroupPerDay: 10, perGroupPerHour: 10, crossModuleGapMs: 0, windows: [{ start: 0, end: 24 }] },
        modules: {
          demo: {
            id: 'demo', label: '演示分享', template, enabled: true,
            targets: [GROUP],
            media: { mode: mediaMode },
            links: { enabled: true },
            delivery: { mode: 'direct' },
            verification: { status: 'approved', approvedAt: 1, approvedBy: 'owner' },
            limits: { minPerDay: 1, maxPerDay: 5 },
            facets: [{ id: 'default', label: '默认', template, weight: 1 }]
          }
        }
      }
    }
  };
  const api = {
    events: { follow: () => {} },
    workspace: {
      create: async () => ({ result: { ok: true, value: { created: true, workspaceId: 'ws1' } } }),
      rename: async () => ({ result: { ok: true, value: {} } })
    },
    sessions: {
      create: async () => ({ result: { ok: true, value: { sessionId: 'sess1' } } }),
      prompt: async ({ sessionId }) => {
        const text = JSON.stringify(currentOutput ?? {});
        innerRef.handleEvent(sessionId, { type: 'turn/start', data: { turn: 't1' } });
        innerRef.handleEvent(sessionId, { type: 'assistant/message', data: { turn: 't1', message: { content: [{ type: 'text', text }] } } });
        innerRef.handleEvent(sessionId, { type: 'turn/end', data: { turn: 't1', reason: { kind: 'completed' } } });
        return { result: { ok: true } };
      }
    }
  };
  const inner = createInnerLife({
    cfg, api, stateDir,
    log: () => {},
    sendToQQ: async (key, msg) => { sent.push({ key, msg: String(msg) }); return true; },
    lastSendSucceeded: () => true,
    onebotSend: async () => ({ message_id: 'm1' }),
    mdToPlain: (t) => String(t ?? ''),
    getSimulationState: () => ({ recentMessages: [], unread: [], lastIncomingAt: 0 }),
    isSessionAllowedInCurrentMode: () => true,
    ensureChatModel: async () => 'applied',
    resolvePresetName: () => 'safe-preset',
    unwrap: (r) => r.result.value,
    getRoleText: () => '',
    getRoleName: () => '小鲸鱼',
    isDshReady: () => true,
    getMode: () => 'simulation',
    isPaused: () => false,
    appendActivity: () => {},
    imageLibrary: {
      sendToKey: async (key, id, opts = {}) => { images.push({ key, id, caption: opts.caption ?? '' }); return true; },
      sendManyToKey: async (key, ids, opts = {}) => { for (const id of ids) images.push({ key, id, caption: opts.caption ?? '' }); return true; },
      add: () => ({ id: 'img1' }),
      remove: () => {}
    }
  });
  innerRef = inner;
  return { inner, sent, images, stateDir, cfg, setOutput: (o) => { currentOutput = o; } };
}

function writePending(stateDir, { title, text, sourceUrl = '', links = [], facetId = 'default' }) {
  const moduleState = {
    day: '2000-01-01', sentToday: 0, dailyTarget: 5, lastSentAt: 0, nextAt: 0, paused: false,
    verification: { status: 'approved', approvedAt: 1, approvedBy: 'owner' }, _verificationSet: true,
    facets: {}, history: [], lastPreview: null, stats: { sent: 0, failed: 0, duplicates: 0 },
    pending: {
      moduleId: 'demo', facetId, target: GROUP, category: '', title, text,
      terms: [], techName: '', sourceUrl, links,
      createdAt: Date.now(), expiresAt: Date.now() + 3600 * 1000
    }
  };
  fs.writeFileSync(path.join(stateDir, 'share-modules.json'), JSON.stringify({ version: 1, groups: {}, modules: { demo: moduleState } }));
}

// ── 1) 去缩进 ────────────────────────────────────────────────────────────────
test('科普正文去缩进：段首不再有全角空格，段间仍留空行', () => {
  const text = '装个新软件，一打开就跳出好几个框。很多授权其实用不上。比如读通讯录、看短信。能不给的就不给。位置权限改成仅使用期间。';
  const caption = formatShareCaption({ title: '隐私授权', text }, 'knowledge');
  assert.ok(caption.startsWith('隐私授权\n\n'), caption); // 锚点：标题后空行
  assert.ok(!caption.includes(INDENT), caption); // 旧行为含 U+3000 => 红
  assert.ok(!/^　/m.test(caption), caption);
  assert.ok(caption.split('\n\n').length >= 3, '标题 + 至少两段正文');
  assert.doesNotMatch(caption, /\n{3,}/);
});

test('小知识预览正文同样去缩进', () => {
  const caption = formatTipCaption({ title: '隐私授权', text: '第一句。第二句。第三句。第四句。第五句。' });
  assert.ok(caption.startsWith('隐私授权\n\n'), caption);
  assert.ok(!caption.includes(INDENT), caption);
});

// ── 2) 去固定开场腔 ──────────────────────────────────────────────────────────
test('群分享口吻不再强制「诶/唔」语气词开头', () => {
  assert.match(SHARE_VOICE_BLOCK, /我\/咱/); // 锚点：第一人称要求仍在
  assert.doesNotMatch(SHARE_VOICE_BLOCK, /第一句先写你自己的反应/); // 旧行为强制开场 => 红
  assert.doesNotMatch(SHARE_VOICE_BLOCK, /（诶、唔、呀、啦、呜、我……）/);
});

// ── 3) 非科普：链接在前 + 多条独立短点评 ─────────────────────────────────────
test('草稿发布：非科普链接在前，随后多条独立短点评（自然分条开启）', async () => {
  const h = makeHarness({ template: 'news', naturalEnabled: true });
  try {
    writePending(h.stateDir, { title: '让二追三', text: NEWS_TEXT, sourceUrl: NEWS_URL, links: [{ title: '战报', url: NEWS_URL }] });
    const res = await h.inner.publishShareDraft('demo', { force: true });
    assert.equal(res.status, 'sent', JSON.stringify(res)); // 锚点：harness 真的走到了发送
    assert.ok(h.sent.length >= 1);
    const msgs = h.sent.map((s) => s.msg);
    assert.ok(msgs[0].includes(NEWS_URL), `第一条应是链接：${msgs[0]}`); // 旧行为第一条是大段 => 红
    assert.ok(!msgs[0].includes('昨晚那场球'), '链接消息不应夹带正文大段');
    const comments = msgs.slice(1);
    assert.ok(comments.length >= 2, `应有多条短点评，实际 ${comments.length}`);
    for (const c of comments) {
      assert.ok(!c.includes('https://'), c);
      assert.ok(c.length <= 80, `点评应短：${c.length}`);
      assert.ok(!c.includes(INDENT), c);
    }
    assert.equal(comments.join('').replace(/\s/g, ''), NEWS_TEXT.replace(/\s/g, ''), '点评合起来必须等于原正文，不能丢字');
  } finally { fs.rmSync(h.stateDir, { recursive: true, force: true }); }
});

test('引擎调度：非科普同样链接在前 + 多条短点评', async () => {
  const h = makeHarness({ template: 'news', naturalEnabled: true });
  try {
    h.setOutput({ title: '让二追三', text: NEWS_TEXT, time: '11 月 10 日 22:00', sourceUrl: 'https://example.com/match-2' });
    const res = await h.inner.runShareModule('demo', { force: true, ignoreGuards: true });
    assert.equal(res.status, 'sent', JSON.stringify(res)); // 锚点
    const msgs = h.sent.map((s) => s.msg);
    assert.ok(msgs[0].includes('https://example.com/match-2'), `第一条应是链接：${msgs[0]}`);
    assert.ok(!msgs[0].includes('昨晚那场球'));
    const comments = msgs.slice(1);
    assert.ok(comments.length >= 2, `实际 ${comments.length}`);
    for (const c of comments) assert.ok(!c.includes('https://') && c.length <= 80, c);
    assert.equal(comments.join('').replace(/\s/g, ''), NEWS_TEXT.replace(/\s/g, ''));
  } finally { fs.rmSync(h.stateDir, { recursive: true, force: true }); }
});

// ── 对照锚点：关闭自然分条 => 非科普回到旧的一大段（回滚证明）─────────────────
test('关闭自然分条：非科普仍合成一段（回滚对照）', async () => {
  const h = makeHarness({ template: 'news', naturalEnabled: false });
  try {
    writePending(h.stateDir, { title: '让二追三', text: NEWS_TEXT, sourceUrl: NEWS_URL, links: [{ title: '战报', url: NEWS_URL }] });
    const res = await h.inner.publishShareDraft('demo', { force: true });
    assert.equal(res.status, 'sent', JSON.stringify(res));
    const msgs = h.sent.map((s) => s.msg);
    assert.ok(msgs[0].includes('让二追三') && msgs[0].includes('昨晚那场球'), msgs[0]);
    assert.equal(msgs.filter((m) => m.includes('昨晚那场球')).length, 1, '关闭后正文应合成一段');
  } finally { fs.rmSync(h.stateDir, { recursive: true, force: true }); }
});

// ── 4) 科普/金融：仍单条大段（去缩进、留空行）────────────────────────────────
test('科普仍单条大段：去缩进、段间空行、不分条（自然分条开启）', async () => {
  const h = makeHarness({ template: 'knowledge', naturalEnabled: true });
  try {
    const text = '协同过滤会记录你的点击和停留。它再找相似的人爱看什么。所以推荐越刷越像你。新用户最不准，因为行为太少。这东西好用，但也会把你困在信息茧房里。';
    writePending(h.stateDir, { title: '协同过滤', text });
    const res = await h.inner.publishShareDraft('demo', { force: true });
    assert.equal(res.status, 'sent', JSON.stringify(res));
    const msgs = h.sent.map((s) => s.msg);
    assert.equal(msgs.length, 1, `科普应只发一条，实际 ${msgs.length}`);
    assert.ok(msgs[0].includes('协同过滤') && msgs[0].includes('信息茧房'));
    assert.ok(!msgs[0].includes(INDENT), '科普也去缩进'); // 旧行为含缩进 => 红
    assert.ok(msgs[0].includes('\n\n'), '段间保留空行');
  } finally { fs.rmSync(h.stateDir, { recursive: true, force: true }); }
});

// ── 纯函数：分条与去链接（新导出，旧代码下为 undefined => 红）─────────────────
test('splitShareComments：拆成 1–3 条短点评且不丢字', async () => {
  const { splitShareComments } = await import('../runtime/share/share-format.js');
  assert.equal(typeof splitShareComments, 'function');
  const text = '今天早上排队买咖啡前面那个人点单点了足足五分钟。我站在后面一边等一边刷手机。结果轮到我的时候店员说机器刚好坏了。你说巧不巧这种事偏偏让我赶上。最后我只好换了隔壁那家。味道居然还不错。';
  const parts = splitShareComments(text);
  assert.ok(parts.length >= 2 && parts.length <= 3, JSON.stringify(parts));
  assert.equal(parts.join('').replace(/\s/g, ''), text.replace(/\s/g, ''), '不能丢字');
  const long = '句子。'.repeat(40);
  const capped = splitShareComments(long, { maxComments: 3 });
  assert.ok(capped.length <= 3, JSON.stringify(capped));
  assert.equal(capped.join('').replace(/\s/g, ''), long.replace(/\s/g, ''));
  assert.deepEqual(splitShareComments(''), []);
  assert.deepEqual(splitShareComments('就一句话。'), ['就一句话。']);
});

test('stripShareUrls：去掉正文里的链接，保留点评', async () => {
  const { stripShareUrls } = await import('../runtime/share/share-format.js');
  assert.equal(typeof stripShareUrls, 'function');
  assert.equal(stripShareUrls('看这个\nhttps://example.com/a\n不错'), '看这个\n不错');
  assert.equal(stripShareUrls('纯点评没有链接'), '纯点评没有链接');
});