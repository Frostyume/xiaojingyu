// 表情包体系自检：
// 1) sticker-lib 纯函数（合并/查找/格式化/笔记/使用统计）
// 2) 配置项与 MCP 工具描述存在性
// 3) 可选 live 模式：QQ_BRIDGE_TEST_LIVE=1 时调用 SnowLuma 拉取收藏表情并验证 safeFetchBuffer 可抓图
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  normalizeStickerEntry,
  mergeStickerLibrary,
  findSticker,
  formatStickerList,
  buildStickerContext,
  buildStickerStrategyHint,
  applyStickerNote,
  markStickerUsed
} from '../services/media/sticker-lib.js';
import { bridgeHarness } from './bridge-harness.mjs';
import { isQVersionWhaleSticker } from '../services/media/vision.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
let fail = 0;
function ok(cond, name) {
  if (cond) { pass += 1; console.log(`  ✅ ${name}`); }
  else { fail += 1; console.error(`  ❌ ${name}`); }
}

console.log('## sticker-lib 纯函数');
{
  const raw = normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'abc', desc: '笑死', localNote: '嘲讽', tags: ['怼人'] });
  ok(raw && raw.id === 'a' && raw.desc === '笑死' && raw.localNote === '嘲讽', 'normalizeStickerEntry 基本字段');
  ok(normalizeStickerEntry({}) === null, '空记录返回 null');
}

{
  const base = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '' }
  ]);
  ok(base.length === 2, 'merge 新增两条');
  const merged = mergeStickerLibrary(base, [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a2', md5: 'ABC', desc: '笑哭' }
  ]);
  ok(merged.length === 1, 'merge 会移除 QQ 端已删除的表情');
  ok(merged[0].id === 'a' && merged[0].url === 'https://x/a2' && merged[0].desc === '笑哭', 'merge 更新 QQ 字段');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' },
    { emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }
  ]);
  ok(findSticker(list, 'a')?.id === 'a', '按 emoji_id 查找');
  ok(findSticker(list, 'abc')?.id === 'a', '按 md5 大小写不敏感查找');
  ok(findSticker(list, 'https://x/b')?.id === 'b', '按 URL 查找');
  ok(findSticker(list, '不存在') === null, '找不到返回 null');
}

{
  const list = [
    normalizeStickerEntry({ emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }),
    normalizeStickerEntry({ emoji_id: 'b', resId: 'b', url: 'https://x/b', md5: 'DEF', desc: '生气' }),
    normalizeStickerEntry({ emoji_id: 'c', resId: 'c', url: 'https://x/c', md5: 'GHI', desc: '', localNote: '无语' })
  ];
  const all = formatStickerList(list, '', 10);
  ok(all.total === 3 && all.stickers.length === 3, 'formatStickerList 总数');
  const q = formatStickerList(list, '生气', 10);
  ok(q.matched === 1 && q.stickers[0].id === 'b', 'formatStickerList 按备注搜索');
  const q2 = formatStickerList(list, '无语', 10);
  ok(q2.matched === 1 && q2.stickers[0].id === 'c', 'formatStickerList 按本地笔记搜索');
  const ctx = buildStickerContext(list, 8);
  ok(ctx.includes('笑死') && ctx.includes('生气'), 'buildStickerContext 包含备注');
  const hot = normalizeStickerEntry({ emoji_id: 'hot', resId: 'hot', url: 'https://x/hot', md5: 'HOT', desc: '热门反复发', useCount: 99, lastUsedAt: Date.now() });
  const cold = normalizeStickerEntry({ emoji_id: 'cold', resId: 'cold', url: 'https://x/cold', md5: 'COLD', desc: '冷门没发过', useCount: 0 });
  const diverse = buildStickerContext([hot, cold], 8);
  ok(!diverse.includes('热门反复发'), '最近 30 分钟发过的表情不进候选');
  ok(diverse.includes('冷门没发过'), '冷门表情进入候选');
  ok(buildStickerStrategyHint().includes('30 分钟内发过'), '策略提示说明近期表情冷却');
  ok(buildStickerStrategyHint().includes('qq_send_sticker'), '策略提示包含发送工具');
}

{
  const list = mergeStickerLibrary([], [
    { emoji_id: 'a', resId: 'a', url: 'https://x/a', md5: 'ABC', desc: '笑死' }
  ]);
  const noted = applyStickerNote(list, 'a', { note: '嘲讽用', tags: ['怼人'], usage: '别人犯蠢时' });
  ok(noted.entry.localNote === '嘲讽用' && noted.entry.tags.includes('怼人'), 'applyStickerNote 写入本地认知');
  const used = markStickerUsed(noted.entries, 'a', '接梗');
  ok(used.entry.useCount === 1 && used.entry.lastContext === '接梗', 'markStickerUsed 记录使用');
}

console.log('## 配置文件');
{
  // 公开仓默认不带 config.json（本机配置被 gitignore）；没有就退回到随库发布的示例配置。
  const cfgPath = fs.existsSync(path.join(ROOT, 'config.json'))
    ? path.join(ROOT, 'config.json')
    : path.join(ROOT, 'config.example.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  const tools = cfg.simulation?.tools ?? {};
  ok(tools.listStickers === true, 'config listStickers=true');
  ok(tools.getStickerImage === true, 'config getStickerImage=true');
  ok(tools.sendSticker === true, 'config sendSticker=true');
  ok(tools.stickerNote === true, 'config stickerNote=true');
  ok(tools.setStickerRemark === false, 'config setStickerRemark=false（默认禁用）');
  ok(cfg.simulation?.sticker?.enabled === true, 'config sticker.enabled=true');
  ok(!('sendCaptionMaxChars' in (cfg.simulation?.sticker ?? {})), 'config sticker 不再包含 sendCaptionMaxChars');
}

console.log('## 表情单气泡约束');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'mcp', 'qq-actions.js'), 'utf8');
  const sendStickerBlock = mcp.slice(mcp.indexOf("'qq_send_sticker'"), mcp.indexOf("'qq_sticker_note'"));
  ok(!sendStickerBlock.includes('message: z.string()'), 'qq_send_sticker MCP 不再接受 message 参数');
  ok(sendStickerBlock.includes('不能在同一气泡里附带文字'), 'qq_send_sticker 描述强调单气泡');
  const hint = buildStickerStrategyHint();
  ok(hint.includes('不能在同一气泡里附带文字'), '策略提示禁止同气泡混文字');
  ok(!hint.includes('先发一句话再发一张'), '策略提示不再引导“先发一句话再发一张”');
}

console.log('## MCP 工具描述存在性');
{
  const mcp = fs.readFileSync(path.join(ROOT, 'mcp', 'qq-actions.js'), 'utf8');
  for (const name of ['qq_list_stickers', 'qq_get_sticker_image', 'qq_send_sticker', 'qq_sticker_note', 'qq_set_sticker_remark', 'qq_delete_sticker', 'qq_delete_image']) {
    ok(mcp.includes(`'${name}'`) || mcp.includes(`"${name}"`), `MCP 工具 ${name} 已注册`);
  }
  const deleteStickerBlock = mcp.slice(mcp.indexOf("'qq_delete_sticker'"), mcp.indexOf("'qq_delete_image'"));
  ok(deleteStickerBlock.includes('只允许主人'), '删除表情强调主人权限');
  ok(deleteStickerBlock.includes('messageId'), '删除表情支持引用 messageId');
  const deleteImageBlock = mcp.slice(mcp.indexOf("'qq_delete_image'"), mcp.indexOf("'qq_collect_sticker'"));
  ok(deleteImageBlock.includes('只允许主人'), '删除图片强调主人权限');
  ok(deleteImageBlock.includes('messageId'), '删除图片支持引用 messageId');
}

console.log('## bridge 路由/函数存在性');
{
  const bridge = fs.readFileSync(path.join(ROOT, 'app', 'whale.js'), 'utf8');
  for (const s of ['/api/simulation/sticker-list', '/api/simulation/sticker-image', '/api/simulation/sticker-note', '/api/simulation/send-sticker', '/api/simulation/sticker-remark', '/api/stickers', 'syncStickerLibrary', 'sendSticker', '/api/simulation/delete-sticker', '/api/simulation/delete-image', 'deleteSticker', 'deleteImage', 'mediaRefFromQuoted', 'quotedMessageId']) {
    ok(bridge.includes(s), `bridge 包含 ${s}`);
  }
}

console.log('## Q 版表情视觉校验');
{
  const originalFetch = globalThis.fetch;
  const cfg = { webSearch: { apiKey: 'fixture-key', baseURL: 'https://example.invalid/v1', model: 'fixture-vision' } };
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":true,"reason":"蓝发鲸鱼娘Q版"}' } }] }) });
  const yes = await isQVersionWhaleSticker(cfg, Buffer.alloc(200, 1));
  ok(yes.ok === true, 'Q 版小鲸鱼通过');
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"ok":false,"reason":"真人照片"}' } }] }) });
  const no = await isQVersionWhaleSticker(cfg, Buffer.alloc(200, 1));
  ok(no.ok === false && /真人/.test(no.reason), '非 Q 版被拒绝');
  globalThis.fetch = originalFetch;
}

console.log('## 收藏上传重试与补收队列');
{
  const makeHarness = async (addFaceImpl) => {
    const h = await bridgeHarness({
      config: {
        allow: { private: ['123'], groups: ['456'] },
        consoleAuth: { enabled: false },
        simulation: { sticker: { collect: { retryDelaysMs: [0, 0] } } }
      },
      globals: { isQVersionWhaleSticker: async () => ({ ok: true, reason: '' }) }
    });
    h.setMode('simulation');
    h.setSnowlumaConnected(true);
    const st = h.getSimulationState('private:123');
    st.recentMessages.push({
      messageId: '900', sender: '群友', text: '[图片]', isSelf: false,
      media: [{ kind: 'image', file: 'fixture.image' }], time: Date.now()
    });
    const realRequest = h.bot.request.bind(h.bot);
    const calls = { add: 0 };
    h.bot.request = async (action, params) => {
      if (action === 'add_custom_face') {
        calls.add += 1;
        return addFaceImpl(calls.add, params);
      }
      if (action === 'fetch_custom_face_detail') return { status: 'ok', retcode: 0, data: [] };
      if (action === 'modify_custom_face') return { status: 'ok', retcode: 0 };
      return realRequest(action, params);
    };
    return { h, calls };
  };

  const first = await makeHarness((n) => (n === 1
    ? { status: 'failed', retcode: 1200, wording: 'fetch failed: ECONNRESET' }
    : { status: 'ok', retcode: 0, data: { emoji_id: 'fixture-emoji' } }));
  try {
    const res = await first.h.collectSticker('private:123', '900', '笑死');
    ok(first.calls.add === 2, '首次瞬时失败、第二次成功，共 2 次上传调用');
    ok(res.emojiId === 'fixture-emoji' && !res.pending, '返回正常收藏结果');
  } finally { await first.h.close(); }

  const second = await makeHarness(() => ({ status: 'failed', retcode: 1200, wording: '收藏表情已达上限' }));
  try {
    let threw = '';
    try { await second.h.collectSticker('private:123', '900', '笑死'); } catch (error) { threw = error.message; }
    ok(second.calls.add === 1, '业务错误只调用 1 次、不重试');
    ok(/add_custom_face 失败/.test(threw) && !/网络不稳/.test(threw), '业务错误原样抛出');
  } finally { await second.h.close(); }
}

{
  const h = await bridgeHarness({
    config: {
      allow: { private: ['123'], groups: ['456'] },
      consoleAuth: { enabled: false },
      simulation: { sticker: { collect: { retryDelaysMs: [0, 0] } } }
    },
    globals: { isQVersionWhaleSticker: async () => ({ ok: true, reason: '' }) }
  });
  try {
    h.setMode('simulation');
    h.setSnowlumaConnected(true);
    const st = h.getSimulationState('private:123');
    st.recentMessages.push({
      messageId: '901', sender: '群友', text: '[图片]', isSelf: false,
      media: [{ kind: 'image', file: 'fixture.image' }], time: Date.now()
    });
    let addCalls = 0;
    h.bot.request = async (action) => {
      if (action === 'add_custom_face') { addCalls += 1; return { status: 'failed', retcode: 1200, wording: 'timed out' }; }
      return { status: 'ok', retcode: 0, data: [] };
    };
    const res = await h.collectSticker('private:123', '901', '笑死');
    const saved = JSON.parse(fs.readFileSync(path.join(h.temp, 'state/pending-stickers.json'), 'utf8'));
    ok(addCalls === 3 && res.pending === true, '三次瞬时失败后转补收队列');
    ok(/网络不稳/.test(res.message), '返回补收提示而不是硬失败');
    ok(saved.length === 1 && saved[0].key === 'private:123' && String(saved[0].file).startsWith('base64://')
      && saved[0].attempts === 1, 'pending-stickers.json 落盘 1 条');
  } finally { await h.close(); }
}

console.log('## 模型工具：按引用 messageId 删除');
{
  const h = await bridgeHarness({
    config: { allow: { private: ['123'], groups: ['456'] }, consoleAuth: { enabled: false } },
    files: { 'state/stickers.json': [{ id: 'emoji-tool-test', desc: '工具删除测试', source: 'qq' }] }
  });
  try {
    h.setMode('simulation');
    h.setSnowlumaConnected(false);
    const st = h.getSimulationState('private:123');
    st.lastIncomingUserId = '123';
    st.recentMessages.push({
      messageId: '777', sender: '我', text: '[表情包:工具删除测试]', plain: '[表情包:工具删除测试]',
      isSelf: true, isOwner: true, sticker: { id: 'emoji-tool-test', desc: '工具删除测试' }, time: Date.now()
    });
    const server = h.startConsoleServer();
    if (!server.listening) await new Promise((resolve) => server.once('listening', resolve));
    const port = server.address().port;
    const res = await fetch(`http://127.0.0.1:${port}/api/simulation/delete-sticker`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-agent-token': st.agentToken },
      body: JSON.stringify({ key: 'private:123', messageId: '777' })
    });
    const body = await res.json();
    ok(res.ok && body.ok === true, '删除接口接受 messageId 并解析引用');
    ok(!h.getStickerEntries().some((e) => e.id === 'emoji-tool-test'), '被引用表情已删除');
    await new Promise((resolve) => server.close(resolve));
  } finally { await h.close(); }
}

if (process.env.QQ_BRIDGE_TEST_LIVE === '1') {
  console.log('## live：SnowLuma 收藏表情链路');
  try {
    const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));
    const base = String(cfg.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
    const headers = { 'content-type': 'application/json', ...(cfg.snowluma?.accessToken ? { authorization: `Bearer ${cfg.snowluma.accessToken}` } : {}) };
    const res = await fetch(`${base}/fetch_custom_face_detail`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ count: 5 }),
      signal: AbortSignal.timeout(15000)
    });
    const body = await res.json();
    ok(res.ok && body.status === 'ok' && body.retcode === 0, 'fetch_custom_face_detail 调用成功');
    const items = Array.isArray(body.data) ? body.data : [];
    ok(items.length > 0, `返回 ${items.length} 个收藏表情`);
    if (items.length > 0) {
      const { safeFetchBuffer } = await import('../services/social/safe-fetch.js');
      try {
        const img = await safeFetchBuffer(items[0].url, 4 * 1024 * 1024);
        ok(img.buffer.length > 0, `可抓取表情图片字节（${img.buffer.length} bytes）`);
      } catch (e) {
        ok(false, `safeFetchBuffer 抓取表情失败: ${e.message}`);
      }
    }
  } catch (e) {
    ok(false, `live 链路异常: ${e.message}`);
  }
}

console.log(`\n结果：${pass} 通过，${fail} 失败`);
if (fail > 0) process.exit(1);
