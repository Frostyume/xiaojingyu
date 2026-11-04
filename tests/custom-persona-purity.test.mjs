// 自定义角色纯净度：所有对外表达路径不能残留默认角色「小鲸鱼」的人格/口吻。
// 同时做默认角色回归，防止为了去味把默认角色的原有提示词改坏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { bridgeHarness } from './bridge-harness.mjs';
import { createInnerLife } from '../services/persona/inner-life.js';
import { featureVoiceInstruction } from '../runtime/orchestration/feature-voice.js';
import { neutralVoiceInstruction } from '../runtime/persona/voice-delivery.js';
import { PERSONA_MODES, renderPersonaMode } from '../runtime/persona/persona-mode.js';
import { FEATURE_CARDS } from '../runtime/control/feature-control.js';
import { listOwnerCapabilities } from '../runtime/control/owner-capabilities.js';
import { listOwnerConfig } from '../runtime/control/owner-config.js';
import { contentVoiceBlock, shareVoiceBlock } from '../runtime/persona/persona-voice.js';
import { personaStyleContext } from '../runtime/persona/style-context.js';

const GROUP = 'group:456';
const OWNER_PRIVATE = 'private:123';
const ROXY = 'Roxy';
const ROXY_CARD = '你是「Roxy」，一个冷静、直话直说的电台 DJ。说话简短，不撒娇，不卖萌。';
const WHALE_CARD = '你是「小鲸鱼」，一只住在 QQ 里的鲸鱼娘。说话短，心软但嘴硬。';
const FORBIDDEN = /小鲸鱼|鲸鱼|软萌|傲娇|嘴硬|本鱼|大肥鱼|D指导/;
const MCP_SOURCE = fs.readFileSync(new URL('../mcp/qq-actions.js', import.meta.url), 'utf8');
const RESTRICT_SOURCE = fs.readFileSync(new URL('../integrations/dsh/agent-presets/qq-tool-restrict.mjs', import.meta.url), 'utf8');
const WHALE_SOURCE = fs.readFileSync(new URL('../app/whale.js', import.meta.url), 'utf8');
const EXAMPLE_CONFIG = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));

function literalArray(name) {
  const match = WHALE_SOURCE.match(new RegExp(`const ${name} = (\\[[^\\]]*\\]);`));
  assert.ok(match, `找不到常量 ${name}`);
  return Function(`return ${match[1]}`)();
}

function literalSet(name) {
  const match = WHALE_SOURCE.match(new RegExp(`const ${name} = new Set\\((\\[[^\\]]*\\])\\);`));
  assert.ok(match, `找不到常量 ${name}`);
  return new Set(Function(`return ${match[1]}`)());
}

function exampleKeywordConfig() {
  return {
    social: { mustReplyKeywords: [...EXAMPLE_CONFIG.social.mustReplyKeywords] },
    simulation: { wake: { recommendedKeywords: [...EXAMPLE_CONFIG.simulation.wake.recommendedKeywords] } }
  };
}

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

async function withBridge({ roleFiles = {}, role, extraConfig = {}, keepDefaultWake = false, selfName = null } = {}, run) {
  const files = {};
  for (const [name, card] of Object.entries(roleFiles)) files[`personas/${name}.md`] = card;
  if (role !== undefined) files['state/current-role.json'] = JSON.stringify({ role, mode: 'active' });
  const base = fixtureConfig();
  if (keepDefaultWake) delete base.simulation.wake;
  const config = {
    ...base,
    ...extraConfig,
    simulation: { ...base.simulation, ...(extraConfig.simulation ?? {}) }
  };
  const h = await bridgeHarness({ files, config });
  h.setMode('simulation');
  h.setSelfIdentity(selfName ?? (role === ROXY ? ROXY : '小鲸鱼'), '10001');
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
    }),
    reflection: inner.promptPreview('reflection', {}),
    refine: inner.promptPreview('refine', {
      kind: 'qzone',
      text: '今晚的节目聊了输赢。',
      ask: '短一点',
      maxChars: 120
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
    assert.match(prompt, /【称呼边界】/, '自定义角色要说明预设里的称呼不代表角色关系');

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
    assert.doesNotMatch(persona, /猫|独立游戏|音乐/, '自定义角色不注入默认角色的兴趣');
    assert.match(persona, /以当前角色卡为准/, '没有自定义状态时用中性状态');

    const prompts = previewPrompts(inner);
    for (const [kind, text] of Object.entries(prompts)) {
      assert.ok(text.includes(ROXY_CARD), `${kind} 提示词应带 Roxy 角色卡`);
      assert.doesNotMatch(text, FORBIDDEN, `${kind} 提示词不得出现默认角色词`);
      assert.match(text, /角色卡/, `${kind} 提示词应要求按角色卡发挥`);
    }
    assert.deepEqual(inner.promptPreview('mentions', { mentionNames: ['小鲸鱼', 'DeepSeek'] }), [ROXY], '@ 名单应使用当前角色名');
    assert.doesNotMatch(prompts.reflection, /主人/, '自定义角色的反思输入不写死主人');
    assert.match(prompts.reflection, /对方私聊/, '自定义角色反思输入用中性称呼');
    assert.doesNotMatch(prompts.refine, /主人/, '自定义角色的草稿微调不写死主人');
    assert.match(prompts.refine, /对方想这样调整/, '自定义角色草稿微调用中性称呼');

    const wording = ['qq_play_game', 'qq_send_sticker', 'qq_send_image', 'qq_collect_sticker', 'qq_speak', 'qq_get_self_image']
      .map(mcpDescription)
      .join('\n');
    assert.doesNotMatch(wording, FORBIDDEN, 'MCP 工具描述不得写死默认角色');
    assert.match(wording, /角色卡/, 'MCP 工具描述应指向当前角色卡');
    assert.doesNotMatch(RESTRICT_SOURCE, /小鲸鱼/, '工具白名单拒绝理由不得绑定默认角色名');
    const controlText = JSON.stringify(FEATURE_CARDS) + JSON.stringify(listOwnerCapabilities()) + JSON.stringify(listOwnerConfig(h.cfg));
    assert.doesNotMatch(controlText, FORBIDDEN, '功能/能力/配置描述不得绑定默认角色');

    const tts = { breeze: { baseInstruction: '固定音色', softInstruction: '整体偏软萌、带一点傲娇', softDelivery: '偏软萌、带一点傲娇', moodInstructions: { happy: '带一点小傲娇' } } };
    assert.doesNotMatch(featureVoiceInstruction(tts, 'happy', { customRole: true }), FORBIDDEN);
    assert.match(featureVoiceInstruction(tts, 'happy', { customRole: true }), /不要预设固定人设/);
    assert.doesNotMatch(neutralVoiceInstruction(tts.breeze, 'happy'), FORBIDDEN);
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
    assert.doesNotMatch(prompt, /【称呼边界】/, '默认角色不额外注入称呼边界');

    st.recentMessages = [self('乖什么乖，我只是记性好')];
    assert.match(h.buildToneNudgeLine(st, user('真乖')), /害羞|嘴硬/, '默认角色被夸时保留先软后硬提醒');
    const tokenLine = h.buildToneNudgeLine(st, user('给你爸吃穷没 token 你就要没了'), OWNER_PRIVATE);
    assert.match(tokenLine, /怕怕|省着点吃/, '默认角色主人私聊保留软黏提醒');

    assert.match(renderPersonaMode(PERSONA_MODES.steady, personaStyleContext({ name: '小鲸鱼' })), /按平时的软黏语气说话/);

    const inner = makeInner(h);
    const persona = inner.personaBlock();
    assert.match(persona, /猫|独立游戏|音乐/, '默认角色仍注入默认兴趣');
    const prompts = previewPrompts(inner);
    assert.match(prompts.share, /软和嘴硬都可以|第一句先写你自己的反应/, '默认分享口吻块保持原样');
    assert.match(prompts.qzone, /🐟/, '默认说说提示保留默认 emoji 示例');
    assert.match(prompts.comment, /软萌、先软后硬/, '默认评论回复保持原口吻');
    assert.match(prompts.mention, /软萌、先软后硬/, '默认 @ 回复保持原口吻');
    assert.match(prompts.reflection, /主人私聊/, '默认角色反思输入保持原称呼');
    assert.match(prompts.refine, /主人想这样调整/, '默认角色草稿微调保持原称呼');
    const tts = { breeze: { baseInstruction: '固定音色', softDelivery: '偏软萌、带一点傲娇', moodInstructions: { happy: '带一点小傲娇' } } };
    assert.match(featureVoiceInstruction(tts, 'happy'), /软萌/);

    const mentions = inner.promptPreview('mentions', { mentionNames: [] });
    assert.ok(mentions.includes('小鲸鱼') && mentions.includes('DeepSeek'), '默认角色 @ 名单保持原值');
    assert.doesNotMatch(contentVoiceBlock(personaStyleContext({ name: '小鲸鱼' })), /自定义角色已启用/);
    assert.match(shareVoiceBlock(personaStyleContext({ name: '小鲸鱼' })), /第一句先写你自己的反应/);
  });
});

test('角色切换：默认 → Roxy 清除默认内核、名单和旧摘要；切回后恢复默认行为', async () => {
  await withBridge({ roleFiles: { 小鲸鱼: WHALE_CARD, [ROXY]: ROXY_CARD }, role: '小鲸鱼', keepDefaultWake: true }, async (h) => {
    const st = h.getSimulationState(GROUP);
    h.commitWakePrompt(GROUP, h.renderWakePrompt(GROUP, 'question'));
    assert.ok(st.roleCardVersion, '默认角色先拿到一次角色卡版本');
    st.pendingDigest = '【衔接摘要】上一角色留下的旧语境。';
    st.wakeConfig.mode = 'active';
    st.wakeConfig.infinite = false;
    st.wakeConfig.sleepUntil = '2099-01-01T00:00:00.000Z';

    await withConsole(h, async (port) => {
      const switched = await request(port, '/api/role', { method: 'POST', body: { role: ROXY } });
      assert.equal(switched.status, 200);
      assert.equal(switched.json.custom, true);
      assert.match(switched.json.notice, /自定义角色/);
      assert.equal(st.roleCardVersion, '', '切角色后角色卡版本失效');
      assert.equal(st.pendingDigest, '', '切角色后旧衔接摘要要清掉');
      assert.ok(st.wakeConfig.triggers.keywords.includes(ROXY), '切角色后默认唤醒关键词跟随新角色');
      assert.doesNotMatch(st.wakeConfig.triggers.keywords.join(','), FORBIDDEN, '切角色后不保留鲸鱼默认关键词');
      assert.equal(st.wakeConfig.mode, 'active', '切角色不得重置 mode');
      assert.equal(st.wakeConfig.sleepUntil, '2099-01-01T00:00:00.000Z', '切角色不得重置 sleepUntil');

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
      assert.ok(st.wakeConfig.triggers.keywords.includes('小鲸鱼'), '切回默认后唤醒关键词恢复鲸鱼默认词');
      assert.equal(st.wakeConfig.mode, 'active', '切回默认也不重置 mode');
      assert.equal(st.wakeConfig.sleepUntil, '2099-01-01T00:00:00.000Z', '切回默认也不重置 sleepUntil');
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

function groupEvent(text) {
  return {
    self_id: 999,
    user_id: 777,
    message: [{ type: 'text', data: { text } }],
    raw_message: text,
    sender: { nickname: '测试群友', card: '测试群友' }
  };
}

test('Roxy：默认唤醒/必回关键词用角色名+别名+中性词，不继承鲸鱼词，也不因鲸鱼关键词唤醒', async () => {
  await withBridge({ roleFiles: { [ROXY]: ROXY_CARD }, role: ROXY, keepDefaultWake: true }, async (h) => {
    h.addSelfAlias('Roxy酱');
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    const keywords = st.wakeConfig.triggers.keywords;
    assert.ok(keywords.includes(ROXY), '唤醒关键词包含当前角色名');
    assert.ok(keywords.some((word) => word.toLowerCase() === 'roxy酱'), '唤醒关键词包含别名');
    assert.ok(keywords.includes('在吗'), '唤醒关键词包含中性词');
    assert.doesNotMatch(keywords.join(','), FORBIDDEN, '默认唤醒关键词不得继承鲸鱼词');
    assert.doesNotMatch(h.effectiveMustReplyKeywords().join(','), FORBIDDEN, '默认必回关键词不得继承鲸鱼词');

    const event = groupEvent('小鲸鱼在吗');
    assert.equal(h.evaluateWakeTrigger(GROUP, st, event, 'group', '小鲸鱼在吗', '小鲸鱼在吗', false), null,
      '自定义角色不应因默认角色关键词唤醒');
    assert.equal(h.isMustReplyText('小鲸鱼在吗'), false, '自定义角色不应因默认角色关键词必回');

    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent(`${ROXY}在吗`), 'group', `${ROXY}在吗`, `${ROXY}在吗`, false), 'nameMention');
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('Roxy酱在吗'), 'group', 'Roxy酱在吗', 'Roxy酱在吗', false), 'nameMention');

    await withConsole(h, async (port) => {
      const sim = await request(port, '/api/simulation/config');
      assert.doesNotMatch(sim.json.config.wake.recommendedKeywords.join(','), FORBIDDEN, '控制台默认唤醒关键词不应显示鲸鱼词');
      const social = await request(port, '/api/social');
      assert.doesNotMatch(social.json.config.mustReplyKeywords.join(','), FORBIDDEN, '控制台默认必回关键词不应显示鲸鱼词');
    });
  });
});

test('默认小鲸鱼仍命中原有鲸鱼关键词', async () => {
  await withBridge({ roleFiles: { 小鲸鱼: WHALE_CARD }, role: '小鲸鱼', keepDefaultWake: true }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    const keywords = st.wakeConfig.triggers.keywords;
    assert.ok(keywords.includes('小鲸鱼') && keywords.includes('大肥鱼') && keywords.includes('DeepSeek'), '默认关键词保持原值');
    assert.match(
      String(h.evaluateWakeTrigger(GROUP, st, groupEvent('大肥鱼在吗'), 'group', '大肥鱼在吗', '大肥鱼在吗', false)),
      /keyword:大肥鱼/,
      '默认角色仍命中鲸鱼关键词'
    );
    assert.equal(h.isMustReplyText('大肥鱼在吗'), true);
  });
});

test('显式配置自定义关键词：唤醒与必回都按显式配置，不被角色默认值覆盖', async () => {
  await withBridge({
    roleFiles: { [ROXY]: ROXY_CARD },
    role: ROXY,
    extraConfig: {
      social: { mustReplyKeywords: ['暗号'] },
      simulation: { wake: { recommendedKeywords: [ROXY, '暗号'] } }
    }
  }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    assert.deepEqual(st.wakeConfig.triggers.keywords, [ROXY, '暗号'], '显式唤醒关键词原样保留');
    assert.deepEqual(h.effectiveMustReplyKeywords(), ['暗号'], '显式必回关键词原样保留');
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('暗号在吗'), 'group', '暗号在吗', '暗号在吗', false), 'keyword:暗号');
    assert.equal(h.isMustReplyText('暗号'), true);
    assert.equal(h.isMustReplyText('小鲸鱼'), false, '显式配置不会额外继承鲸鱼词');
  });
});

test('Roxy + 示例配置：示例默认词不算显式配置，鲸鱼词不唤醒也不必回', async () => {
  await withBridge({ roleFiles: { [ROXY]: ROXY_CARD }, role: ROXY, extraConfig: exampleKeywordConfig() }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    const keywords = st.wakeConfig.triggers.keywords;
    assert.ok(keywords.includes(ROXY) && keywords.includes('在吗'));
    assert.doesNotMatch(keywords.join(','), FORBIDDEN, '示例配置不能被当成用户显式配置');
    assert.doesNotMatch(h.effectiveMustReplyKeywords().join(','), FORBIDDEN);
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('小鲸鱼在吗'), 'group', '小鲸鱼在吗', '小鲸鱼在吗', false), null);
    assert.equal(h.isMustReplyText('小鲸鱼在吗'), false);
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('DeepSeek在吗'), 'group', 'DeepSeek在吗', 'DeepSeek在吗', false), null, '默认人格词不应触发自定义角色');
    assert.equal(h.isMustReplyText('DeepSeek在吗'), false);
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent(`${ROXY}在吗`), 'group', `${ROXY}在吗`, `${ROXY}在吗`, false), 'nameMention');
    await withConsole(h, async (port) => {
      const sim = await request(port, '/api/simulation/config');
      assert.doesNotMatch(sim.json.config.wake.recommendedKeywords.join(','), FORBIDDEN, '控制台视图也不能显示鲸鱼词');
      const social = await request(port, '/api/social');
      assert.doesNotMatch(social.json.config.mustReplyKeywords.join(','), FORBIDDEN, '控制台视图也不能显示鲸鱼必回词');
    });
  });
});

test('Roxy + QQ 昵称仍是小鲸鱼：昵称不触发名字唤醒/必回，@ 仍正常', async () => {
  await withBridge({
    roleFiles: { [ROXY]: ROXY_CARD },
    role: ROXY,
    keepDefaultWake: true,
    selfName: '小鲸鱼'
  }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    assert.doesNotMatch(st.wakeConfig.triggers.keywords.join(','), FORBIDDEN);
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('小鲸鱼在吗'), 'group', '小鲸鱼在吗', '小鲸鱼在吗', false), null);
    assert.equal(h.isMustReplyText('小鲸鱼在吗'), false);
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent(`${ROXY}在吗`), 'group', `${ROXY}在吗`, `${ROXY}在吗`, false), 'nameMention');
    const atEvent = {
      ...groupEvent('在吗'),
      message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '在吗' } }]
    };
    assert.equal(h.evaluateWakeTrigger(GROUP, st, atEvent, 'group', '[@小鲸鱼] 在吗', '在吗', false), 'atMention', '@ 段仍要正常唤醒');
  });
});

test('默认词常量与 config.example.json 一致，过滤表覆盖两者的默认人格词', () => {
  assert.deepEqual(literalArray('EXAMPLE_MUST_REPLY_KEYWORDS'), EXAMPLE_CONFIG.social.mustReplyKeywords);
  assert.deepEqual(literalArray('EXAMPLE_WAKE_KEYWORDS'), EXAMPLE_CONFIG.simulation.wake.recommendedKeywords);
  const normalized = literalSet('DEFAULT_PERSONA_WAKE_KEYWORDS');
  const covered = new Set([...normalized].map((word) => String(word).toLowerCase()));
  for (const word of [...EXAMPLE_CONFIG.social.mustReplyKeywords, ...EXAMPLE_CONFIG.simulation.wake.recommendedKeywords]) {
    const key = String(word).trim().toLowerCase();
    if (key === '在吗') continue;
    assert.ok(covered.has(key), `默认词过滤表缺少 ${word}`);
  }
  assert.ok(covered.has('ds') && covered.has('r1'), '过滤表覆盖 ds/r1 及大小写变体');
});

test('Roxy + 旧昵称别名小鲸鱼：鲸鱼词不进入默认关键词，也不唤醒', async () => {
  await withBridge({ roleFiles: { [ROXY]: ROXY_CARD }, role: ROXY, keepDefaultWake: true }, async (h) => {
    h.addSelfAlias('小鲸鱼');
    h.addSelfAlias('DS');
    h.addSelfAlias('R1');
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    assert.doesNotMatch(st.wakeConfig.triggers.keywords.join(','), FORBIDDEN);
    assert.ok(!st.wakeConfig.triggers.keywords.some((word) => ['ds', 'r1'].includes(word.toLowerCase())), 'DS/R1 不进入角色默认关键词');
    assert.doesNotMatch(h.effectiveMustReplyKeywords().join(','), FORBIDDEN);
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('小鲸鱼在吗'), 'group', '小鲸鱼在吗', '小鲸鱼在吗', false), null);
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('DS在吗'), 'group', 'DS在吗', 'DS在吗', false), null);
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('R1在吗'), 'group', 'R1在吗', 'R1在吗', false), null);
  });
});

test('ASCII 名字按词边界匹配：friends/gods/proxy 不误唤醒，DS/R1/Roxy 正常', async () => {
  await withBridge({ roleFiles: { DS: '你是「DS」。' }, role: 'DS', keepDefaultWake: true }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    for (const text of ['DS在吗', 'DS 在吗', 'ds，在吗']) {
      assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent(text), 'group', text, text, false), 'nameMention', `${text} 应唤醒 DS`);
    }
    assert.equal(h.isMustReplyText('DS在吗'), true);
    for (const text of ['friends在吗', 'gods']) {
      assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent(text), 'group', text, text, false), null, `${text} 不应唤醒 DS`);
      assert.equal(h.isMustReplyText(text), false, `${text} 不应触发 DS 必回`);
    }
  });

  await withBridge({ roleFiles: { R1: '你是「R1」。' }, role: 'R1', keepDefaultWake: true }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('R1在吗'), 'group', 'R1在吗', 'R1在吗', false), 'nameMention');
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('r1，在吗'), 'group', 'r1，在吗', 'r1，在吗', false), 'nameMention');
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('car1在吗'), 'group', 'car1在吗', 'car1在吗', false), null, '包含 r1 的英文单词不误唤醒');
  });

  await withBridge({ roleFiles: { [ROXY]: ROXY_CARD }, role: ROXY, keepDefaultWake: true }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('Roxy酱在吗'), 'group', 'Roxy酱在吗', 'Roxy酱在吗', false), 'nameMention');
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('proxy在吗'), 'group', 'proxy在吗', 'proxy在吗', false), null, 'proxy 不应叫到 Roxy');
  });

  await withBridge({ roleFiles: { 小鲸鱼: WHALE_CARD }, role: '小鲸鱼' }, async (h) => {
    assert.equal(h.isMustReplyText('小鲸鱼厉害吗'), true, '默认角色逐字回归');
  });
});

test('角色本身叫默认词：鲸鱼/DeepSeek/DS/R1 仍按当前角色名正常唤醒', async () => {
  for (const roleName of ['鲸鱼', 'DeepSeek', 'DS', 'R1']) {
    await withBridge({ roleFiles: { [roleName]: `你是「${roleName}」，一个同名测试角色。` }, role: roleName, keepDefaultWake: true, selfName: '小鲸鱼' }, async (h) => {
      const st = h.getSimulationState(GROUP);
      st.wakeConfig.triggers.probability = 0;
      assert.ok(st.wakeConfig.triggers.keywords.includes(roleName), `${roleName} 应进入角色默认关键词`);
      assert.equal(
        h.evaluateWakeTrigger(GROUP, st, groupEvent(`${roleName}在吗`), 'group', `${roleName}在吗`, `${roleName}在吗`, false),
        'nameMention',
        `${roleName}在吗 应按角色名唤醒`
      );
      assert.equal(h.isMustReplyText(`${roleName}在吗`), true, `${roleName}在吗 应触发必回`);
    });
  }
});

test('显式空关键词数组：自定义角色保持为空，不被默认值填回', async () => {
  await withBridge({
    roleFiles: { [ROXY]: ROXY_CARD },
    role: ROXY,
    extraConfig: {
      social: { mustReplyKeywords: [] },
      simulation: { wake: { recommendedKeywords: [] } }
    }
  }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    assert.deepEqual(st.wakeConfig.triggers.keywords, [], '显式空数组保持为空');
    assert.deepEqual(h.effectiveMustReplyKeywords(), [], '显式空必回数组保持为空');
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('暗号在吗'), 'group', '暗号在吗', '暗号在吗', false), null);
    assert.equal(h.isMustReplyText('暗号'), false);
  });
});

test('默认小鲸鱼 + 示例配置 + 昵称小鲸鱼：原有关键词和必回行为不变', async () => {
  await withBridge({
    roleFiles: { 小鲸鱼: WHALE_CARD },
    role: '小鲸鱼',
    extraConfig: exampleKeywordConfig()
  }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.wakeConfig.triggers.probability = 0;
    const keywords = st.wakeConfig.triggers.keywords;
    assert.ok(keywords.includes('小鲸鱼') && keywords.includes('大肥鱼') && keywords.includes('DeepSeek'));
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('大肥鱼在吗'), 'group', '大肥鱼在吗', '大肥鱼在吗', false), 'keyword:大肥鱼');
    assert.equal(h.isMustReplyText('大肥鱼在吗'), true);
    assert.equal(h.evaluateWakeTrigger(GROUP, st, groupEvent('小鲸鱼在吗'), 'group', '小鲸鱼在吗', '小鲸鱼在吗', false), 'nameMention');
  });
});
