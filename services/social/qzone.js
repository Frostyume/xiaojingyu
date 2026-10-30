// SnowLuma 的 QQ 空间动作封装。
//
// 说明：当前桥接的 38 个 qq_* MCP 工具没有暴露空间能力，但 SnowLuma 网关本身支持
// send_qzone_msg / get_qzone_msg_list / delete_qzone_msg。桥接直接走 HTTP action，
// 不新增 MCP 工具，因此改这个文件不需要重启 DSH。

function baseUrl(cfg) {
  return String(cfg?.snowluma?.httpUrl || 'http://127.0.0.1:3000').replace(/\/+$/, '');
}

async function action(cfg, name, params = {}, { timeoutMs = 20000 } = {}) {
  const token = cfg?.snowluma?.accessToken;
  const res = await fetch(`${baseUrl(cfg)}/${name}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {})
    },
    body: JSON.stringify(params),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch {}
  if (!res.ok) throw new Error(`SnowLuma ${name} HTTP ${res.status}: ${String(text).slice(0, 200)}`);
  if (!body) throw new Error(`SnowLuma ${name} 返回非 JSON: ${String(text).slice(0, 200)}`);
  return body;
}

function findTid(value, depth = 0) {
  if (depth > 6 || value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{6,}$/.test(trimmed)) return trimmed;
    return '';
  }
  if (typeof value !== 'object') return '';
  for (const key of ['tid', 'tid_str', 'msgid', 'msgId', 'feedid', 'feedId']) {
    const v = value[key];
    if (v != null && String(v).trim()) return String(v).trim();
  }
  for (const v of Object.values(value)) {
    const found = findTid(v, depth + 1);
    if (found) return found;
  }
  return '';
}

function isOk(body) {
  if (!body || typeof body !== 'object') return false;
  if (body.status !== undefined) return body.status === 'ok' && Number(body.retcode ?? 0) === 0;
  if (body.retcode !== undefined) return Number(body.retcode) === 0;
  if (body.code !== undefined) return Number(body.code) === 0;
  return true;
}

function errorText(body) {
  return String(body?.wording || body?.message || body?.error || body?.retcode || body?.code || '未知错误').slice(0, 300);
}

/**
 * 发一条说说。默认好友可见（ugc_right=4）。
 * 返回 { ok, tid, raw }；tid 可能为空（网关没回传），此时仍视为成功，由调用方记录。
 */
export async function postQzone(cfg, content, { visibility = 4, images = [], timeoutMs = 30000 } = {}) {
  const text = String(content ?? '').trim();
  if (!text) throw new Error('说说正文为空');
  const params = { content: text, ugc_right: visibility };
  // images 支持 file:// / http(s):// / base64://；调用方负责把本地图转成 base64 或 file://。
  const list = (Array.isArray(images) ? images : []).map((s) => String(s ?? '').trim()).filter(Boolean).slice(0, 9);
  if (list.length) params.images = list;
  const body = await action(cfg, 'send_qzone_msg', params, { timeoutMs });
  if (!isOk(body)) throw new Error(`空间发布失败：${errorText(body)}`);
  const tid = findTid(body?.data) || findTid(body);
  return { ok: true, tid, raw: body };
}

/** 读自己的说说列表（只读）。 */
export async function listQzone(cfg, { pos = 0, num = 5, timeoutMs = 20000 } = {}) {
  const body = await action(cfg, 'get_qzone_msg_list', { pos, num }, { timeoutMs });
  if (isOk(body)) {
    const data = body.data ?? body;
    const items = Array.isArray(data?.msglist) ? data.msglist : [];
    return { ok: true, total: Number(data?.total) || items.length, items, raw: body };
  }
  // 部分网关会把上游原始对象直接放在顶层（msglist 可能是 null）。
  if (body && Array.isArray(body.msglist)) {
    return { ok: true, total: Number(body.total) || body.msglist.length, items: body.msglist, raw: body };
  }
  return { ok: false, error: errorText(body), total: 0, items: [], raw: body };
}

/** 删除一条说说。 */
export async function deleteQzone(cfg, tid, { timeoutMs = 20000 } = {}) {
  const value = String(tid ?? '').trim();
  if (!value) throw new Error('缺少说说 tid');
  const body = await action(cfg, 'delete_qzone_msg', { tid: value }, { timeoutMs });
  if (!isOk(body)) throw new Error(`删除说说失败：${errorText(body)}`);
  return { ok: true, tid: value, raw: body };
}

export function qzoneVisibilityLabel(value) {
  const n = Number(value);
  if (n === 1) return '所有人可见';
  if (n === 4) return '好友可见';
  if (n === 16) return '部分好友可见';
  if (n === 64) return '仅自己可见';
  if (n === 128) return '部分好友不可见';
  return `权限 ${value}`;
}

/**
 * 发布超时后核对列表：网关报 timeout 不代表一定没发出去。
 * 用正文前 20 个非空白字符做指纹；找到就说明已经落地，不能再重发一次。
 */
export function qzoneHasContent(items, text) {
  const probe = String(text ?? '').replace(/\s+/g, '').slice(0, 20);
  if (probe.length < 6) return false;
  return (Array.isArray(items) ? items : []).some((item) => {
    const content = typeof item?.content === 'string' ? item.content : '';
    return content.replace(/\s+/g, '').includes(probe);
  });
}

export function qzoneItemTid(item) {
  return String(item?.tid ?? item?.tid_str ?? item?.msgid ?? '').trim();
}

/** 读取 QQ 空间动态（含自己/好友的说说 HTML；用于评论检测的兜底解析）。 */
export async function getQzoneFeeds(cfg, { pageNum = 1, count = 20, timeoutMs = 20000 } = {}) {
  const body = await action(cfg, 'get_qzone_feeds', { page_num: pageNum, count }, { timeoutMs });
  if (isOk(body)) {
    const data = body.data ?? body;
    return { ok: true, feeds: Array.isArray(data?.feeds) ? data.feeds : [], hasMore: data?.has_more === true, raw: body };
  }
  return { ok: false, error: errorText(body), feeds: [], raw: body };
}

/** 评论一条说说（纯文字）。target_uin 是说说主人的 QQ 号。 */
export async function commentQzone(cfg, tid, content, { targetUin = '', replyTo = null, timeoutMs = 20000 } = {}) {
  const text = String(content ?? '').trim();
  if (!text) throw new Error('评论内容为空');
  // 有被回复评论的 uin/id 时走“回复”，避免变成新的一条顶层评论。
  if (replyTo?.uin && replyTo?.id) {
    return replyQzoneComment(cfg, tid, text, {
      targetUin,
      t2Uin: replyTo.uin,
      t2Tid: replyTo.id,
      t2Name: replyTo.name || '',
      timeoutMs
    });
  }
  const params = { tid: String(tid), content: text };
  if (targetUin) params.target_uin = String(targetUin);
  const body = await action(cfg, 'comment_qzone', params, { timeoutMs });
  if (!isOk(body)) throw new Error(`评论说说失败：${errorText(body)}`);
  return { ok: true, raw: body };
}

function decodeEntities(text) {
  return String(text ?? '')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

function stripHtmlText(html) {
  return decodeEntities(String(html ?? '').replace(/<script[\s\S]*?<\/script>/gi, ' ').replace(/<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

/**
 * 从 Qzone feed HTML 里尽量提取评论。
 * QQ 的 feed HTML 结构会变，因此同时兼容 f-comment / comment-item 几种 class，
 * 拿不到时返回 []，由调用方决定是否提醒主人，绝不凭猜测回复。
 */
/** 当前机器人自己的 QQ 号（从空间 cookie 解析）。 */
export async function getQzoneSelfUin(cfg) {
  const body = await action(cfg, 'get_cookies', { domain: 'qzone.qq.com' }, { timeoutMs: 10000 });
  const cookies = String(body?.data?.cookies || '');
  const m = /(?:^|[; ])uin=o?(\d+)/.exec(cookies) || /pt2gguin=o?(\d+)/.exec(cookies);
  return m ? m[1] : '';
}

async function getQzoneCookies(cfg) {
  const body = await action(cfg, 'get_cookies', { domain: 'qzone.qq.com' }, { timeoutMs: 10000 });
  return String(body?.data?.cookies || '');
}

function qzoneBkn(cookies) {
  const skey = (String(cookies || '').match(/p_skey=([^;]+)/) || String(cookies || '').match(/skey=([^;]+)/) || [])[1] || '';
  let h = 5381;
  for (let i = 0; i < skey.length; i += 1) h += (h << 5) + skey.charCodeAt(i);
  return h & 2147483647;
}

/** 直接回复某条空间评论（t2_uin/t2_tid），而不是发一条新的普通评论。 */
export async function replyQzoneComment(cfg, tid, content, { targetUin = '', t2Uin = '', t2Tid = '', t2Name = '', timeoutMs = 20000 } = {}) {
  const text = String(content ?? '').trim();
  if (!text) throw new Error('回复内容为空');
  if (!t2Uin || !t2Tid) throw new Error('缺少被回复评论的 uin/id');
  const cookies = await getQzoneCookies(cfg);
  if (!cookies) throw new Error('拿不到 Qzone cookies');
  const selfUin = (cookies.match(/(?:^|[; ])uin=o?(\d+)/) || [])[1] || '';
  if (!selfUin) throw new Error('拿不到自己的 QQ 号');
  const hostUin = String(targetUin || selfUin);
  const bodyContent = t2Name && !/^回复/.test(text) ? `回复 ${t2Name}：${text}` : text;
  const params = new URLSearchParams({
    qzreferrer: `https://user.qzone.qq.com/${selfUin}`,
    inCharset: 'utf-8',
    outCharset: 'utf-8',
    hostUin,
    format: 'json',
    ref: 'feeds',
    topicId: `${hostUin}_${String(tid)}__1`,
    feedsType: '100',
    private: '0',
    paramstr: '1',
    richtype: '',
    richval: '',
    isSignIn: '',
    uin: selfUin,
    content: bodyContent,
    plat: 'qzone',
    source: 'ic',
    platformid: '52',
    t1_source: '1',
    t1_uin: hostUin,
    t1_tid: String(tid),
    subdotype: '0',
    signin: '0',
    sceneid: '100',
    t2_uin: String(t2Uin),
    t2_tid: String(t2Tid)
  });
  const url = `https://h5.qzone.qq.com/proxy/domain/taotao.qzone.qq.com/cgi-bin/emotion_cgi_re_feeds?g_tk=${qzoneBkn(cookies)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Cookie: cookies,
      'content-type': 'application/x-www-form-urlencoded',
      referer: `https://user.qzone.qq.com/${selfUin}`,
      'user-agent': 'Mozilla/5.0'
    },
    body: params.toString(),
    signal: AbortSignal.timeout(timeoutMs)
  });
  const raw = await res.text();
  let body = null;
  try { body = raw ? JSON.parse(raw) : null; } catch {}
  if (!res.ok) throw new Error(`空间回复 HTTP ${res.status}: ${raw.slice(0, 200)}`);
  if (!body) throw new Error(`空间回复返回非 JSON: ${raw.slice(0, 200)}`);
  if (Number(body.code) !== 0 || Number(body.subcode ?? 0) !== 0) {
    throw new Error(`空间回复失败: code=${body.code ?? ''} ${body.message || body.wording || ''}`.trim());
  }
  return { ok: true, commentId: String(body.commentid ?? body.commentId ?? ''), raw: body };
}

/** 从 feed HTML 提取说说配图（排除头像/图标）。 */
export function parseQzoneFeedImages(html) {
  const out = [];
  const seen = new Set();
  for (const m of String(html || '').matchAll(/<img\b[^>]*>/gi)) {
    const tag = m[0];
    const raw = (tag.match(/(?:data-src|data-original|src)=["']([^"']+)["']/i) || [])[1] || '';
    if (!raw) continue;
    const url = raw.replace(/&amp;/g, '&');
    if (!/^https?:\/\//i.test(url)) continue;
    if (/qlogo|avatar|q_namecard|emoji|em\/e\d/i.test(url)) continue;
    if (!/(photo\.store\.qq\.com|qpic\.cn|photo\.qq\.com)/i.test(url)) continue;
    if (seen.has(url)) continue;
    seen.add(url);
    out.push(url);
  }
  return out.slice(0, 9);
}

/** 读取一条说说的完整详情（含 commentlist），用于可靠评论检测。 */
export async function getQzoneMsgDetail(cfg, tid, { hostUin = '', timeoutMs = 20000 } = {}) {
  const id = String(tid ?? '').trim();
  if (!id) throw new Error('缺少说说 tid');
  const cookies = await getQzoneCookies(cfg);
  if (!cookies) throw new Error('拿不到 Qzone cookies');
  const selfUin = (cookies.match(/(?:^|[; ])uin=o?(\d+)/) || [])[1] || '';
  if (!selfUin) throw new Error('拿不到自己的 QQ 号');
  const params = new URLSearchParams({
    tid: id,
    uin: selfUin,
    t1_source: '1',
    not_trunc_con: '1',
    need_right: '1',
    not_adapt_outpic: '1',
    g_tk: String(qzoneBkn(cookies))
  });
  if (hostUin) params.set('hostuin', String(hostUin));
  const res = await fetch(`https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msgdetail_v6?${params}`, {
    headers: {
      Cookie: cookies,
      referer: `https://user.qzone.qq.com/${selfUin}`,
      'user-agent': 'Mozilla/5.0'
    },
    signal: AbortSignal.timeout(timeoutMs)
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`空间详情 HTTP ${res.status}: ${text.slice(0, 200)}`);
  const start = text.indexOf('(');
  let data = null;
  try { data = JSON.parse(start >= 0 ? text.slice(start + 1, text.lastIndexOf(')')) : text); } catch {}
  if (!data) throw new Error(`空间详情返回非 JSON: ${text.slice(0, 200)}`);
  if (Number(data.code ?? 0) !== 0 || Number(data.subcode ?? 0) !== 0) {
    throw new Error(`空间详情失败: code=${data.code ?? ''} ${data.message || data.msg || ''}`.trim());
  }
  const comments = (Array.isArray(data.commentlist) ? data.commentlist : []).map((c) => ({
    id: String(c?.tid ?? ''),
    uin: String(c?.uin ?? c?.owner?.uin ?? ''),
    name: String(c?.name ?? c?.owner?.name ?? '空间好友').slice(0, 40),
    text: decodeEntities(String(c?.content ?? '')).slice(0, 300),
    replyNum: Number(c?.replyNum) || 0,
    at: Number(c?.create_time) || 0
  })).filter((c) => c.text);
  return {
    ok: true,
    tid: id,
    postText: decodeEntities(String(data.content ?? '')).slice(0, 800),
    cmtnum: Number(data.cmtnum) || comments.length,
    comments,
    raw: data
  };
}

/** 从 feed HTML 提取说说正文（f-info / feed-content）。 */
export function parseQzoneFeedPost(html) {
  const source = String(html ?? '');
  const m = /<div[^>]*class=["'][^"']*(?:f-info|feed-content|f-single-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i.exec(source);
  return stripHtmlText(m ? m[1] : '').slice(0, 800);
}

export function parseQzoneComments(html) {
  const source = String(html ?? '');
  const blocks = [
    ...source.matchAll(/(<li[^>]*class=["'][^"']*(?:f-comment|comment-item|comments-item)[^"']*["'][^>]*>[\s\S]*?<\/li>)/gi),
    ...source.matchAll(/(<div[^>]*class=["'][^"']*(?:f-comment|comment-item)[^"']*["'][^>]*>[\s\S]*?<\/div>\s*(?=<div[^>]*class=["'][^"']*(?:f-comment|comment-item)|<\/div>))/gi)
  ];
  const out = [];
  for (const match of blocks) {
    const block = match[1] || '';
    const uin = (block.match(/data-uin=["'](\d+)["']/i) || [])[1] || '';
    const name = stripHtmlText(
      (block.match(/data-nick=["']([^"']+)["']/i) || [])[1]
      || (block.match(/data-nickname=["']([^"']+)["']/i) || [])[1]
      || (block.match(/data-name=["']([^"']+)["']/i) || [])[1]
      || (block.match(/<a[^>]*class=["'][^"']*(?:nickname|f-name)[^"']*["'][^>]*>([\s\S]*?)<\/a>/i) || [])[1]
      || ''
    );
    // 先把评论操作区（时间/回复/删除）拿掉，否则会被当成评论正文的一部分。
    const body = block
      .replace(/<div[^>]*class=["'][^"']*comments-op[^"']*["'][^>]*>[\s\S]*?<\/div>/gi, '')
      .replace(/<div[^>]*class=["'][^"']*comments-op[^"']*["'][^>]*>[\s\S]*$/gi, '');
    let text = stripHtmlText(
      (body.match(/<div[^>]*class=["'][^"']*(?:f-info|comment-content|comments-content)[^"']*["'][^>]*>([\s\S]*?)<\/div>/i) || [])[1]
      || (body.match(/data-content=["']([^"']+)["']/i) || [])[1]
      || ''
    );
    if (text && name) {
      const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      text = text.replace(new RegExp(`^${escapedName}\\s*[：:]\\s*`), '');
    }
    text = text.replace(/\s+\d{1,2}:\d{2}(?::\d{2})?\s*(?:回复|删除)?\s*$/g, '').replace(/\s*(?:回复|删除)\s*$/g, '').trim();
    if (!text) continue;
    const id = (block.match(/data-tid=["'](\d+)["']/i) || [])[1] || (block.match(/commentid=["']?(\d+)/i) || [])[1] || '';
    out.push({ id, uin, name: name || '空间好友', text: text.slice(0, 300) });
  }
  return out;
}
