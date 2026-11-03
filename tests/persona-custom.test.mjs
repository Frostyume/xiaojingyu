// 自定义角色不应被写死的小鲸鱼人格覆盖；唤醒 prompt 的一次性内容不能被预构建消费掉。
// 全部使用临时状态与夹具网关，不接触真实 QQ。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { bridgeHarness } from './bridge-harness.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROUP = 'group:456';
const OWNER_PRIVATE = 'private:123';
const CUSTOM = '阿蓝';
const OTHER = '小蓝';
const CUSTOM_CARD = '你是「阿蓝」，一只理性的蓝猫助手。说话简洁、不卖萌，先给结论再解释。';
const OTHER_CARD = '你是「小蓝」，一只慢吞吞的蓝色水母。说话短、偶尔走神。';

function fixtureConfig(extra = {}) {
  return {
    simulation: {
      wake: { maxWakePerMinute: 200 },
      proactive: { enabled: false },
      sticker: { enabled: false },
      imageLibrary: { enabled: false },
      voice: { enabled: false },
      ...extra
    }
  };
}

async function withBridge({ roleFiles, role, extraConfig } = {}, run) {
  const files = {};
  for (const [name, card] of Object.entries(roleFiles || {})) files[`personas/${name}.md`] = card;
  if (role !== undefined) files['state/current-role.json'] = JSON.stringify({ role, mode: 'active' });
  const h = await bridgeHarness({ files, config: fixtureConfig(extraConfig) });
  h.setMode('simulation');
  try {
    await run(h);
  } finally {
    await h.close();
  }
}

function request(port, pathname, { method = 'GET', body, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path: pathname,
      method,
      headers: { 'content-type': 'application/json', 'x-console-token': 'fixture-console-token', ...headers }
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

function append(h, key, text) {
  const st = h.getSimulationState(key);
  return h.appendSimulationMessage(
    key, 'fixture-person', text, text, false, false,
    `fixture-${st.lastUnreadSeq + 1}`, [], '789', [], {}
  );
}

// ── A. 人格内核只属于默认角色 ────────────────────────────────────────────────
test('自定义角色的唤醒 prompt 不含小鲸鱼内核，但含完整角色卡', async () => {
  await withBridge({ roleFiles: { [CUSTOM]: CUSTOM_CARD }, role: CUSTOM }, async (h) => {
    const prompt = h.buildWakePrompt(GROUP, 'question');
    assert.ok(prompt.includes(`【当前角色】${CUSTOM}`), '要有当前角色行');
    assert.ok(prompt.includes(CUSTOM_CARD), '要注入完整角色卡');
    assert.doesNotMatch(prompt, /DeepSeek 小鲸鱼/, '不得出现小鲸鱼身份覆盖');
    assert.doesNotMatch(prompt, /人格内核/, '不得注入写死的人格内核');
    assert.doesNotMatch(prompt, /只发像小鲸鱼的东西/, '非文字表达规则不得绑定小鲸鱼');
    assert.match(prompt, /只发符合当前角色设定/, '非文字表达要换成角色中性规则');
    assert.doesNotMatch(prompt, /默认温度是软|先软后硬/, '不得残留默认人格的语气规则');
  });
});

test('默认角色（小鲸鱼）仍保留原人格内核；显式清除后不再套用鲸鱼规则', async () => {
  await withBridge({ role: '小鲸鱼' }, async (h) => {
    const prompt = h.buildWakePrompt(GROUP, 'question');
    assert.match(prompt, /你是 DeepSeek 小鲸鱼/, '默认角色必须保持原内核');
    assert.match(prompt, /只发像小鲸鱼的东西/, '默认角色的非文字表达保持原规则');
  });
  await withBridge({ role: null }, async (h) => {
    const prompt = h.buildWakePrompt(GROUP, 'question');
    assert.doesNotMatch(prompt, /【人格内核/, '未设角色不应新增内核段（与基线一致）');
    assert.doesNotMatch(prompt, /你当前的角色是「/, '未设角色不得出现自定义角色身份措辞');
    assert.doesNotMatch(prompt, /只发像小鲸鱼的东西/, '显式清除后不得残留鲸鱼专属规则');
    assert.match(prompt, /只发符合当前角色设定/, '清除角色后非文字表达用中性规则');
  });
});

test('首次启动没有 current-role.json 时默认启用自带的小鲸鱼角色卡', async () => {
  const card = '你是「小鲸鱼」，一只住在 QQ 里的鲸鱼娘。说话短。';
  await withBridge({ roleFiles: { 小鲸鱼: card } }, async (h) => {
    const prompt = h.buildWakePrompt(GROUP, 'question');
    assert.match(prompt, /【当前角色】小鲸鱼/, '首次启动应默认启用小鲸鱼');
    assert.ok(prompt.includes(card), '默认角色卡要能读出来（状态文件缺失不能挡住角色卡）');
    assert.match(prompt, /你是 DeepSeek 小鲸鱼/, '默认角色仍带人格内核');
  });
});

test('自定义角色名也参与名字触发', async () => {
  await withBridge({ roleFiles: { [CUSTOM]: CUSTOM_CARD }, role: CUSTOM }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.wakeConfig = { ...(st.wakeConfig || {}), triggers: { ...(st.wakeConfig?.triggers || {}), nameMention: true } };
    const reason = h.evaluateWakeTrigger(GROUP, st, { self_id: 999, message: [] }, 'group', `${CUSTOM}在吗`, `${CUSTOM}在吗`, false);
    assert.equal(reason, 'nameMention', '群里叫自定义角色名应唤醒');
  });
});

test('身份卡：自定义角色把 QQ 昵称与当前角色分开表述', async () => {
  await withBridge({ roleFiles: { [CUSTOM]: CUSTOM_CARD }, role: CUSTOM }, async (h) => {
    h.setSelfIdentity('小鲸鱼', '10001');
    const identity = h.selfIdentityText();
    assert.match(identity, /账号昵称是「小鲸鱼」/);
    assert.match(identity, /只用于识别 @\/引用/);
    assert.match(identity, /当前的角色是「阿蓝」/);
    assert.doesNotMatch(identity, /你在 QQ 上的昵称是「小鲸鱼」。消息里出现/, '不能把 QQ 昵称直接当成人格身份');
  });
});

test('同一角色在群聊与私聊唤醒里的人格段一致', async () => {
  await withBridge({ roleFiles: { [CUSTOM]: CUSTOM_CARD }, role: CUSTOM }, async (h) => {
    const groupPrompt = h.buildWakePrompt(GROUP, 'question');
    const privatePrompt = h.buildWakePrompt(OWNER_PRIVATE, 'question');
    for (const prompt of [groupPrompt, privatePrompt]) {
      assert.ok(prompt.includes(CUSTOM_CARD));
      assert.doesNotMatch(prompt, /DeepSeek 小鲸鱼/);
      assert.doesNotMatch(prompt, /人格内核/);
    }
    const pickPersona = (text) => text.split('\n').filter((line) => line.includes('阿蓝') || line.includes(CUSTOM_CARD)).join('\n');
    assert.equal(pickPersona(groupPrompt), pickPersona(privatePrompt), '除会话环境外不应出现两套人格');
  });
});

// ── B. 双构建不再消费一次性状态 ──────────────────────────────────────────────
test('预渲染两次都不提交状态，投递文本仍含完整角色卡；提交后版本才更新', async () => {
  await withBridge({ roleFiles: { [CUSTOM]: CUSTOM_CARD }, role: CUSTOM }, async (h) => {
    const st = h.getSimulationState(GROUP);
    st.pendingDigest = '【衔接摘要】上次聊到蓝色猫。';
    const first = h.renderWakePrompt(GROUP, 'question');
    const second = h.renderWakePrompt(GROUP, 'question');
    assert.ok(first.text.includes(CUSTOM_CARD), '第一次渲染要有完整卡');
    assert.ok(second.text.includes(CUSTOM_CARD), '第二次渲染仍要有完整卡（模拟投递时重建）');
    assert.ok(first.text.includes('【衔接摘要】'), '第一次渲染要有 pendingDigest');
    assert.ok(second.text.includes('【衔接摘要】'), '第二次渲染仍要有 pendingDigest');
    assert.equal(st.roleCardVersion, '', '未投递前不得提交角色卡版本');
    assert.ok(st.pendingDigest, '未投递前不得清空摘要');

    h.commitWakePrompt(GROUP, second);
    assert.ok(st.roleCardVersion, '投递成功后提交角色卡版本');
    assert.equal(st.pendingDigest, '', '投递成功后清空摘要');
    const after = h.renderWakePrompt(GROUP, 'question');
    assert.ok(!after.text.includes(CUSTOM_CARD), '提交后不再重复注入同一版本');
    assert.ok(!after.text.includes('【衔接摘要】'));
  });
});

test('端到端：实际投递的 prompt 含角色卡；投递失败时不消费，重投仍带卡', async () => {
  await withBridge({ roleFiles: { [CUSTOM]: CUSTOM_CARD }, role: CUSTOM }, async (h) => {
    const original = h.api.sessions.prompt;
    h.api.sessions.prompt = async (params) => {
      h.calls.prompts.push(params);
      return { result: { ok: false, error: { code: 'FIXTURE_REJECT', message: 'fixture rejection' } } };
    };
    append(h, GROUP, '你好');
    await h.sendWakePrompt(GROUP, 'question');
    const rejectedText = h.calls.prompts.at(-1)?.content?.[0]?.text || '';
    assert.ok(rejectedText.includes(CUSTOM_CARD), '被拒的投递文本本身要含卡');
    const st = h.getSimulationState(GROUP);
    assert.equal(st.roleCardVersion, '', '投递失败不得消费角色卡版本');

    h.api.sessions.prompt = original;
    await h.sendWakePrompt(GROUP, 'question');
    const acceptedText = h.calls.prompts.at(-1)?.content?.[0]?.text || '';
    assert.ok(acceptedText.includes(CUSTOM_CARD), '重投必须仍带完整角色卡');
    assert.ok(st.roleCardVersion, '接受后才提交版本');
  });
});

// ── C. 角色切换让已有会话失效 ────────────────────────────────────────────────
test('控制台切换角色：已有会话版本清零，下次唤醒带新卡', async () => {
  await withBridge({ roleFiles: { [CUSTOM]: CUSTOM_CARD, [OTHER]: OTHER_CARD }, role: CUSTOM }, async (h) => {
    const st = h.getSimulationState(GROUP);
    h.commitWakePrompt(GROUP, h.renderWakePrompt(GROUP, 'question'));
    assert.ok(st.roleCardVersion, '先让会话拿到旧卡');

    // 同名改卡也必须立刻生效。
    fs.writeFileSync(path.join(h.temp, 'personas', `${CUSTOM}.md`), `${CUSTOM_CARD}\n补充：现在更严肃。`);

    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = server.address().port;
      const switched = await request(port, '/api/role', { method: 'POST', body: { role: OTHER } });
      assert.equal(switched.status, 200);
      assert.equal(st.roleCardVersion, '', '切角色后已有会话的版本必须失效');
      const next = h.renderWakePrompt(GROUP, 'question');
      assert.ok(next.text.includes(OTHER_CARD), '下次唤醒要带新角色卡');
      assert.ok(!next.text.includes(CUSTOM_CARD), '不能还带旧角色卡');
      assert.doesNotMatch(next.text, /DeepSeek 小鲸鱼/);

      const updated = await request(port, '/api/role', { method: 'POST', body: { role: CUSTOM } });
      assert.equal(updated.status, 200);
      assert.equal(st.roleCardVersion, '', '切回后同样要失效');
      const back = h.renderWakePrompt(GROUP, 'question');
      assert.ok(back.text.includes('现在更严肃'), '同名改卡的内容也要在下次唤醒出现');

      const cleared = await request(port, '/api/role', { method: 'POST', body: {} });
      assert.equal(cleared.status, 200);
      assert.equal(st.roleCardVersion, '', '清除角色也要让会话失效');
      const restored = h.renderWakePrompt(GROUP, 'question');
      assert.doesNotMatch(restored.text, /【当前角色】/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

test('/role 命令切换与清除同样让已有会话失效', async () => {
  await withBridge({ roleFiles: { [CUSTOM]: CUSTOM_CARD, [OTHER]: OTHER_CARD }, role: CUSTOM }, async (h) => {
    const st = h.getSimulationState(GROUP);
    h.commitWakePrompt(GROUP, h.renderWakePrompt(GROUP, 'question'));
    assert.ok(st.roleCardVersion);
    const event = (text) => ({
      self_id: 999, user_id: 123, message_id: Math.floor(Math.random() * 1e6),
      message: [{ type: 'text', data: { text } }], raw_message: text,
      sender: { nickname: 'owner', card: 'owner' }
    });
    await h.handleIncoming('private', '123', event(`/role ${OTHER}`), h.cfg);
    assert.equal(st.roleCardVersion, '', '/role 切换要清版本');
    assert.ok(h.renderWakePrompt(GROUP, 'question').text.includes(OTHER_CARD));

    h.commitWakePrompt(GROUP, h.renderWakePrompt(GROUP, 'question'));
    await h.handleIncoming('private', '123', event('/role clear'), h.cfg);
    assert.equal(st.roleCardVersion, '', '/role 清除要清版本');
    assert.doesNotMatch(h.renderWakePrompt(GROUP, 'question').text, /【当前角色】/);
  });
});

// ── D. 预设静态扫描：只说明怎么干活，不说明你是谁 ──────────────────────────
test('DSH 预设不含写死的小鲸鱼身份绑定句', async () => {
  const presetFile = path.join(ROOT, 'integrations', 'dsh', 'presets', 'qq-chat', 'agent.cordis.yml');
  assert.ok(fs.existsSync(presetFile), `预设存在：${presetFile}`);
  const text = fs.readFileSync(presetFile, 'utf8');
  assert.doesNotMatch(text, /你在所有会话里是同一(个)?小鲸鱼/, '不得写死跨会话同一人格');
  assert.doesNotMatch(text, /只发\s*Q\s*版鲸鱼|DeepSeek\s*鲸鱼娘/, '不得限制只发鲸鱼形象');
  assert.doesNotMatch(text, /默认温度是软|软萌/, '不得写死软萌语气');
  assert.doesNotMatch(text, /叫“?主人”?|“主人理理我”/, '不得写死主人称呼');
});
