// 自定义角色纯净度：所有对外表达路径不能残留默认角色「小鲸鱼」的人格/口吻。
// 同时做默认角色回归，防止为了去味把默认角色的原有提示词改坏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './bridge-harness.mjs';
import { createInnerLife } from '../services/persona/inner-life.js';
import { PERSONA_MODES, renderPersonaMode } from '../runtime/persona/persona-mode.js';
import { contentVoiceBlock, shareVoiceBlock } from '../runtime/persona/persona-voice.js';
import { personaStyleContext } from '../runtime/persona/style-context.js';

const GROUP = 'group:456';
const OWNER_PRIVATE = 'private:123';
const ROXY = 'Roxy';
const ROXY_CARD = '你是「Roxy」，一个冷静、直话直说的电台 DJ。说话简短，不撒娇，不卖萌。';
const WHALE_CARD = '你是「小鲸鱼」，一只住在 QQ 里的鲸鱼娘。说话短，心软但嘴硬。';
const FORBIDDEN = /小鲸鱼|鲸鱼|软萌|傲娇|嘴硬|本鱼|大肥鱼|D指导/;
const MCP_SOURCE = fs.readFileSync(new URL('../mcp/qq-actions.js', import.meta.url), 'utf8');

function mcpDescription(name) {
  const marker = `'${name}'`;
  const start = MCP_SOURCE.indexOf(marker);
  assert.ok(start >= 0, `找不到工具 ${name}`);
  const match = MCP_SOURCE.slice(start + marker.length).match(/^\s*,\s*'((?:[^'\\]|\\.)*)'/);
  assert.ok(match, `找不到 ${name} 的工具描述`);
  return match[1].replace(/\\'/g, "'");
}

function fixtureConfig() {
  return {
    simulation: {
      wake: { maxWakePerMinute: 200 },
      proactive: { enabled: false },
      sticker: { enabled: false },
      imageLibrary: { enabled: false },
      voice: { enabled: false }
    }
  };
}

async function withBridge({ roleFiles = {}, role } = {}, run) {
  const files = {};
  for (const [name, card] of Object.entries(roleFiles)) files[`personas/${name}.md`] = card;
  if (role !== undefined) files['state/current-role.json'] = JSON.stringify({ role, mode: 'active' });
  const h = await bridgeHarness({ files, config: fixtureConfig() });
  h.setMode('simulation');
  h.setSelfIdentity(role === ROXY ? ROXY : '小鲸鱼', '10001');
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

function request(port, pathname, { method = 'GET', body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token' }
    }, (res) => {
      let raw = '';
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

async function withConsole(h, run) {
  const server = h.startConsoleServer();
  if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
  try {
    await run(server.address().port);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

function makeInner(h) {
  const stateDir = path.join(h.temp, 'inner-state');
  fs.mkdirSync(stateDir, { recursive: true });
  return createInnerLife({
    cfg: h.cfg,
    stateDir,
    log: () => {},
    getSimulationState: h.getSimulationState,
    getRoleName: () => h.currentRoleName(),
    getRoleText: () => {
      const name = h.currentRoleName();
      if (!name) return '';
      try { return fs.readFileSync(path.join(h.temp, 'personas', `${name}.md`), 'utf8'); } catch { return ''; }
    },
    isDshReady: () => false,
    getMode: () => 'simulation',
    isPaused: () => false,
    isSessionAllowedInCurrentMode: () => true
  });
}

function previewPrompts(inner) {
  const candidate = { title: '深夜电台的一段采访', summary: '主持人聊到输赢和心态', url: 'https://example.com/interview', source: 'rss' };
  return {
    share: inner.promptPreview('share', { candidates: [candidate] }),
    qzone: inner.promptPreview('qzone', { candidates: [candidate], recentPosts: [], toneFix: '上一版太像新闻总结' }),
    comment: inner.promptPreview('comment', {
      item: { content: '今晚的电台节目聊了输赢。' },
      comment: { name: '阿明', text: '这期挺稳的，@Roxy 怎么看' },
      images: [],
      comments: []
    }),
    mention: inner.promptPreview('mention', {
      postText: '今晚的电台节目聊了输赢。',
      comment: { name: '阿明', text: '这期挺稳的，@Roxy 怎么看' },
      images: [],
      comments: []
    })
  };
}

test('Roxy：唤醒提示词、语气提醒、状态指令、内心生活、工具描述都不含默认角色残留', async () => {
  await withBridge({ roleFiles: { [ROXY]: ROXY_CARD }, role: ROXY }, async (h) => {
    const st = h.getSimulationState(GROUP);
    const self = (text) => ({ isSelf: true, text });
    const user = (text) => ({ isSelf: false, text });
    st.recentMessages = [self('知道了'), self('行')];

    const prompt = h.buildWakePrompt(GROUP, 'question');
    assert.ok(prompt.includes(ROXY_CARD), '要注入 Roxy 完整角色卡');
    assert.doesNotMatch(prompt, FORBIDDEN, 'Roxy 唤醒提示词不得出现默认角色词');
    assert.doesNotMatch(prompt, /【人格内核/, '自定义角色不得注入默认人格内核');
    assert.match(prompt, /符合当前角色|角色卡/, '应给出按角色卡发挥的中性提示');

    const praise = h.buildToneNudgeLine(st, user('夸你乖就受着'), GROUP);
    assert.match(praise, /按当前角色卡/, '被夸时用中性提醒');
    assert.doesNotMatch(praise, FORBIDDEN);
    const dry = h.buildToneNudgeLine(st, user('今天干嘛了'), GROUP);
    assert.match(dry, /按当前角色卡/, '语气干时用中性提醒');
    assert.doesNotMatch(dry, FORBIDDEN);

    assert.doesNotMatch(renderPersonaMode(PERSONA_MODES.steady, personaStyleContext({ name: ROXY })), /软黏|软萌/);
    const inner = makeInner(h);
    const persona = inner.personaBlock();
    assert.doesNotMatch(persona, FORBIDDEN, '内心生活状态段不得出现默认角色词');

    const prompts = previewPrompts(inner);
    for (const [kind, text] of Object.entries(prompts)) {
      assert.ok(text.includes(ROXY_CARD), `${kind} 提示词应带 Roxy 角色卡`);
      assert.doesNotMatch(text, FORBIDDEN, `${kind} 提示词不得出现默认角色词`);
      assert.match(text, /按当前角色卡|按角色卡/, `${kind} 提示词应要求按角色卡发挥`);
    }
    assert.deepEqual(inner.promptPreview('mentions', { mentionNames: ['小鲸鱼', 'DeepSeek'] }), [ROXY], '@ 名单应使用当前角色名');

    const wording = ['qq_play_game', 'qq_send_sticker', 'qq_send_image', 'qq_collect_sticker', 'qq_speak', 'qq_get_self_image']
      .map(mcpDescription)
      .join('\n');
    assert.doesNotMatch(wording, FORBIDDEN, 'MCP 工具描述不得写死默认角色');
    assert.match(wording, /角色卡/, 'MCP 工具描述应指向当前角色卡');
  });
});

test('默认角色回归：小鲸鱼的原有提示词和口吻保持不变', async () => {
  await withBridge({ roleFiles: { 小鲸鱼: WHALE_CARD }, role: '小鲸鱼' }, async (h) => {
    const st = h.getSimulationState(GROUP);
    const self = (text) => ({ isSelf: true, text });
    const user = (text) => ({ isSelf: false, text });
    st.recentMessages = [self('知道了'), self('行')];

    const prompt = h.buildWakePrompt(GROUP, 'question');
    assert.match(prompt, /你是 DeepSeek 小鲸鱼/, '默认角色仍保留人格内核');
    assert.match(prompt, /只发像小鲸鱼的东西/, '默认角色仍保留鲸鱼非文字规则');

    st.recentMessages = [self('乖什么乖，我只是记性好')];
    assert.match(h.buildToneNudgeLine(st, user('真乖')), /害羞|嘴硬/, '默认角色被夸时保留先软后硬提醒');
    const tokenLine = h.buildToneNudgeLine(st, user('给你爸吃穷没 token 你就要没了'), OWNER_PRIVATE);
    assert.match(tokenLine, /怕怕|省着点吃/, '默认角色主人私聊保留软黏提醒');

    assert.match(renderPersonaMode(PERSONA_MODES.steady, personaStyleContext({ name: '小鲸鱼' })), /按平时的软黏语气说话/);

    const inner = makeInner(h);
    const prompts = previewPrompts(inner);
    assert.match(prompts.share, /软和嘴硬都可以|第一句先写你自己的反应/, '默认分享口吻块保持原样');
    assert.match(prompts.qzone, /🐟/, '默认说说提示保留默认 emoji 示例');
    assert.match(prompts.comment, /软萌、先软后硬/, '默认评论回复保持原口吻');
    assert.match(prompts.mention, /软萌、先软后硬/, '默认 @ 回复保持原口吻');

    const mentions = inner.promptPreview('mentions', { mentionNames: [] });
    assert.ok(mentions.includes('小鲸鱼') && mentions.includes('DeepSeek'), '默认角色 @ 名单保持原值');
    assert.doesNotMatch(contentVoiceBlock(personaStyleContext({ name: '小鲸鱼' })), /自定义角色已启用/);
    assert.match(shareVoiceBlock(personaStyleContext({ name: '小鲸鱼' })), /第一句先写你自己的反应/);
  });
});

test('角色切换：默认 → Roxy 清除默认内核、名单和旧摘要；切回后恢复默认行为', async () => {
  await withBridge({ roleFiles: { 小鲸鱼: WHALE_CARD, [ROXY]: ROXY_CARD }, role: '小鲸鱼' }, async (h) => {
    const st = h.getSimulationState(GROUP);
    h.commitWakePrompt(GROUP, h.renderWakePrompt(GROUP, 'question'));
    assert.ok(st.roleCardVersion, '默认角色先拿到一次角色卡版本');
    st.pendingDigest = '【衔接摘要】上一角色留下的旧语境。';

    await withConsole(h, async (port) => {
      const switched = await request(port, '/api/role', { method: 'POST', body: { role: ROXY } });
      assert.equal(switched.status, 200);
      assert.equal(switched.json.custom, true);
      assert.match(switched.json.notice, /自定义角色/);
      assert.equal(st.roleCardVersion, '', '切角色后角色卡版本失效');
      assert.equal(st.pendingDigest, '', '切角色后旧衔接摘要要清掉');

      // QQ 昵称可能仍叫小鲸鱼；自定义角色下它只用于识别 @/引用，不代表人格。
      h.setSelfIdentity(ROXY, '10001');
      const roxyPrompt = h.buildWakePrompt(GROUP, 'question');
      assert.ok(roxyPrompt.includes(ROXY_CARD));
      assert.doesNotMatch(roxyPrompt, FORBIDDEN);
      assert.doesNotMatch(roxyPrompt, /【人格内核/);
      const inner = makeInner(h);
      assert.deepEqual(inner.promptPreview('mentions', { mentionNames: ['小鲸鱼', 'DeepSeek'] }), [ROXY]);

      const back = await request(port, '/api/role', { method: 'POST', body: { role: '小鲸鱼' } });
      assert.equal(back.status, 200);
      assert.equal(back.json.custom, false);
      assert.match(back.json.notice, /不算自定义角色/);
      const whalePrompt = h.buildWakePrompt(GROUP, 'question');
      assert.match(whalePrompt, /你是 DeepSeek 小鲸鱼/);
      assert.match(whalePrompt, /只发像小鲸鱼的东西/);
      const mentions = inner.promptPreview('mentions', { mentionNames: [] });
      assert.ok(mentions.includes('小鲸鱼') && mentions.includes('DeepSeek'));
    });
  });
});

test('角色卡缺失/为空：给出明确状态，不静默套用默认人格', async () => {
  await withBridge({ role: ROXY }, async (h) => {
    const prompt = h.buildWakePrompt(GROUP, 'question');
    assert.match(prompt, /【角色卡缺失】/, '缺卡要明说');
    assert.match(prompt, /按中性表达/, '缺卡的自定义角色不能用默认人格');
    assert.doesNotMatch(prompt, /【人格内核/, '缺卡时也不能注入默认内核');
  });
  await withBridge({ roleFiles: { [ROXY]: '' }, role: ROXY }, async (h) => {
    const prompt = h.buildWakePrompt(GROUP, 'question');
    assert.match(prompt, /【角色卡缺失】/, '空卡也要明说');
  });
  await withBridge({ role: '小鲸鱼' }, async (h) => {
    const prompt = h.buildWakePrompt(GROUP, 'question');
    assert.match(prompt, /【角色卡缺失】/, '默认角色缺卡也要明说');
    assert.match(prompt, /只使用内置默认人格/, '默认角色缺卡时说明仅用内置人格');
  });
});

test('只改默认角色文件：API 明确提示仍是默认角色，不算自定义', async () => {
  await withBridge({ roleFiles: { 小鲸鱼: WHALE_CARD }, role: '小鲸鱼' }, async (h) => {
    await withConsole(h, async (port) => {
      const saved = await request(port, '/api/roles/update', {
        method: 'POST',
        body: { name: '小鲸鱼', content: `${WHALE_CARD}\n补充：今天有点困。` }
      });
      assert.equal(saved.status, 200);
      assert.equal(saved.json.custom, false);
      assert.match(saved.json.notice, /不算自定义角色/);
      const prompt = h.buildWakePrompt(GROUP, 'question');
      assert.match(prompt, /你是 DeepSeek 小鲸鱼/, '同名改卡后默认内核仍生效');
    });
  });
});
