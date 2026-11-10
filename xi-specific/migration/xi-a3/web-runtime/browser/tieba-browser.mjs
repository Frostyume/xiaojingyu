import fs from 'node:fs/promises';
import path from 'node:path';
import {
  goto, accountStatusOnPage, normalizePostInput, preparePostOnPage, publishPostOnPage,
} from './tieba-account.mjs';
import {
  inspectReplyOnPage, normalizeReplyInput, prepareReplyOnPage, publishReplyOnPage,
} from './tieba-reply.mjs';

const ORIGIN = 'https://tieba.baidu.com';
const NAVIGATION_TIMEOUT_MS = 30_000;
const OVERALL_TIMEOUT_MS = 60_000;
const BODY_READY_TIMEOUT_MS = 12_000;
const BODY_POLL_MS = 100;
const MAX_TEXT = 24_000;
const MAX_LINKS = 100;
const MAX_PENDING = 4;
const ACCOUNT_OPERATION_TIMEOUT_MS = 120_000;
const ACCOUNT_OPERATION_NAMES = new Set(['account_status', 'prepare_post', 'publish_post', 'prepare_reply', 'publish_reply', 'inspect_reply']);

export class TiebaReaderError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'TiebaReaderError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TiebaReaderError(code, message);
}

function isPathInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function assertNoLinkComponents(root, candidate) {
  const relative = path.relative(root, candidate);
  const parts = relative.split(path.sep).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fs.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') continue;
      throw error;
    }
    if (stat.isSymbolicLink()) fail('invalid_profile', 'Profile path must not contain symlinks or junctions');
  }
}

export async function validateProfile(profileDir, approvedRoot) {
  if (typeof profileDir !== 'string' || typeof approvedRoot !== 'string' ||
      !path.isAbsolute(profileDir) || !path.isAbsolute(approvedRoot)) {
    fail('invalid_profile', 'profileDir and approvedRoot must be absolute paths');
  }
  const profile = path.resolve(profileDir);
  const root = path.resolve(approvedRoot);
  if (!isPathInside(root, profile)) {
    fail('invalid_profile', 'profileDir must be a dedicated child of approvedRoot');
  }

  let rootStat;
  try {
    rootStat = await fs.lstat(root);
  } catch (error) {
    if (error.code === 'ENOENT') fail('invalid_profile', 'approvedRoot must already exist');
    throw error;
  }
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    fail('invalid_profile', 'approvedRoot must be a real directory, not a link');
  }
  const realRoot = await fs.realpath(root);
  if (!isPathInside(realRoot, profile)) {
    fail('invalid_profile', 'profileDir must remain inside the real approvedRoot');
  }
  await assertNoLinkComponents(realRoot, profile);

  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData) {
    const defaults = [
      path.join(localAppData, 'Microsoft', 'Edge', 'User Data'),
      path.join(localAppData, 'Google', 'Chrome', 'User Data'),
    ];
    for (const defaultProfile of defaults) {
      const resolvedDefault = path.resolve(defaultProfile);
      if (profile === resolvedDefault || isPathInside(resolvedDefault, profile) || isPathInside(profile, resolvedDefault)) {
        fail('invalid_profile', 'Microsoft Edge and Google Chrome default profiles are forbidden');
      }
    }
  }
  return profile;
}

function validateRead(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    fail('invalid_arguments', 'A read descriptor is required');
  }
  if (input.kind === 'forum') {
    if (typeof input.forum !== 'string' || input.forum.length === 0 || input.forum.length > 100 || /[\u0000-\u001f/?#]/.test(input.forum)) {
      fail('invalid_arguments', 'forum must be a non-empty Tieba forum name without URL delimiters');
    }
    const pn = input.pn ?? 0;
    if (!Number.isSafeInteger(pn) || pn < 0 || pn > 1_000_000) {
      fail('invalid_arguments', 'forum pn must be a non-negative safe integer up to 1000000');
    }
    return {
      kind: 'forum',
      url: `${ORIGIN}/f?kw=${encodeURIComponent(input.forum)}&pn=${pn}`,
    };
  }
  if (input.kind === 'thread') {
    if (typeof input.thread_id !== 'string' || !/^\d{1,20}$/.test(input.thread_id)) {
      fail('invalid_arguments', 'thread_id must contain 1 to 20 digits');
    }
    const pn = input.pn ?? 1;
    if (!Number.isSafeInteger(pn) || pn < 1 || pn > 100_000) {
      fail('invalid_arguments', 'thread pn must be a positive safe integer up to 100000');
    }
    return {
      kind: 'thread',
      page: pn,
      url: `${ORIGIN}/p/${input.thread_id}?pn=${pn}`,
    };
  }
  fail('invalid_arguments', 'kind must be forum or thread');
}

function validateAccountOperation(name, input) {
  if (!ACCOUNT_OPERATION_NAMES.has(name)) fail('invalid_arguments', 'Unknown Tieba account operation');
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('invalid_arguments', 'An account operation descriptor is required');
  const { expectedHomeId, expectedNickname } = input;
  if (typeof expectedHomeId !== 'string' || expectedHomeId.length === 0 || expectedHomeId.length > 200 ||
      /[\u0000-\u001f\u007f]/.test(expectedHomeId)) {
    fail('invalid_arguments', 'A trusted expectedHomeId is required');
  }
  if (typeof expectedNickname !== 'string' || expectedNickname.length === 0 || expectedNickname.length > 100 ||
      expectedNickname.trim() !== expectedNickname || /[\u0000-\u001f\u007f]/.test(expectedNickname)) {
    fail('invalid_arguments', 'A trusted expectedNickname is required');
  }
  if (input.signal !== undefined && !(input.signal instanceof AbortSignal)) {
    fail('invalid_arguments', 'signal must be an AbortSignal');
  }
  if (name === 'account_status') return;
  if (['prepare_reply','publish_reply','inspect_reply'].includes(name)) {
    let reply;
    try {
      reply = normalizeReplyInput({ thread_id: input.thread_id, body: input.body });
    } catch (error) {
      fail(error?.code ?? 'invalid_arguments', 'Invalid Tieba reply input');
    }
    if (name === 'publish_reply') {
      if (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0) fail('invalid_arguments', 'A finite draft expiry is required');
      if (typeof input.onBeforeSubmit !== 'function') fail('invalid_arguments', 'A durable pre-submit callback is required');
    }
    Object.assign(input, reply);
    return;
  }
  let normalized;
  try {
    normalized = normalizePostInput({ forum: input.forum, title: input.title, body: input.body });
  } catch (error) {
    fail(error?.code ?? 'invalid_arguments', 'Invalid Tieba text post input');
  }
  if (name === 'publish_post') {
    if (!Number.isFinite(input.expiresAt) || input.expiresAt <= 0) fail('invalid_arguments', 'A finite draft expiry is required');
    if (typeof input.onBeforeSubmit !== 'function') fail('invalid_arguments', 'A durable pre-submit callback is required');
  }
  Object.assign(input, normalized);
}

function accountRaw(fields = {}) {
  return {
    status: 'error',
    reason: null,
    identity_verified: false,
    may_have_written: false,
    automatic_retry: false,
    ...fields,
  };
}

function withTimeout(promise, milliseconds, code, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new TiebaReaderError(code, message)), milliseconds);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

function sameOrigin(url) {
  try {
    return new URL(url).origin === ORIGIN;
  } catch {
    return false;
  }
}

function normalizedLines(text) {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

// Observed unhydrated thread shell: lines begin with each digit 1..9 twice in
// order, then only known navigation labels. Checked against the start of the
// body text (not a length threshold), so a genuine post that merely mentions
// "登录" later in its prose is not reclassified.
// A hydrated thread page carries its own title ("...-百度贴吧") plus either the
// reply counter or at least one floor label. Before hydration the SPA only has
// navigation chrome and the generic document title; treating that as a page read
// would report an empty thread as success.
function hasThreadContentEvidence(title, text) {
  const normalizedTitle = String(title || '').trim();
  if (!normalizedTitle || normalizedTitle === '百度贴吧') return false;
  return /全部回复|第\d+楼/.test(String(text || ''));
}

function isNavigationSkeleton(text) {
  const lines = normalizedLines(text);
  const expected = [];
  for (let digit = 1; digit <= 9; digit += 1) expected.push(String(digit), String(digit));
  if (lines.length <= expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (lines[i] !== expected[i]) return false;
  }
  const navigation = new Set(['发贴', '发帖', '登录', '首页', '我的', '探索更多内容', '登录探索更多内容']);
  const trailing = lines.slice(expected.length);
  const recommendations = trailing.indexOf('大家都在逛的吧');
  if (recommendations > 0) {
    const prefix = trailing.slice(0, recommendations);
    return prefix.every((line) => navigation.has(line)) &&
      prefix.includes('首页') && prefix.includes('我的') &&
      prefix.some((line) => line === '登录' || line === '登录探索更多内容');
  }
  return trailing.some((line) => navigation.has(line)) &&
    trailing.every((line) => navigation.has(line));
}

function hasThreadEntry(links) {
  return links.some((link) => {
    try {
      const url = new URL(link.url);
      return url.origin === ORIGIN && /^\/p\/\d+$/.test(url.pathname);
    } catch {
      return false;
    }
  });
}

const EMPTY_FORUM_LINES = new Set(['本吧暂无帖子', '暂无帖子', '还没有帖子']);

// A bar can be truly empty only when one whole trimmed line states exactly that;
// "暂无帖子" mentioned inside prose is not an empty-list marker.
function hasExplicitEmptyForumLine(text) {
  return normalizedLines(text).some((line) => EMPTY_FORUM_LINES.has(line));
}

// Visible, same-origin /p/<digits> links prove the thread list hydrated. An
// explicitly stated empty bar proves the list also finished loading. Bar
// metadata alone (name, date, intro, footer) arrives before the list, so it is
// not evidence of a browsable forum.
function hasForumContentEvidence(text, links) {
  return hasThreadEntry(links) || hasExplicitEmptyForumLine(text);
}

// Observed unhydrated forum shell: lines begin with each digit 1..9 twice,
// then only the default empty-bar chrome — empty bar name, "建吧日期：-" (dash
// means the date never loaded), default empty intro/owner copy, the follow
// button (logged-out "关注" or logged-in "关注本吧"), and the site footer — with
// zero thread entries. Only a fully default shell matches; checkForumReadiness
// separately covers loaded metadata that still has no list. Content merely
// mentioning 登录 or 验证码 never starts with the digit prefix, so it is not
// reclassified either.
function isForumShell(text, links) {
  const lines = normalizedLines(text);
  const expected = [];
  for (let digit = 1; digit <= 9; digit += 1) expected.push(String(digit), String(digit));
  if (lines.length <= expected.length) return false;
  for (let i = 0; i < expected.length; i += 1) {
    if (lines[i] !== expected[i]) return false;
  }
  if (hasThreadEntry(links)) return false;
  const rest = lines.slice(expected.length);
  if (!rest.includes('建吧日期：-')) return false;
  if (!(rest.includes('发贴') || rest.includes('发帖'))) return false;
  if (!rest.includes('首页') || !rest.includes('我的')) return false;
  const chrome = new Set([
    '发贴', '发帖', '登录', '首页', '我的', '吧', '关注', '关注本吧',
    '探索更多内容', '登录探索更多内容', '建吧日期：-',
    '吧主很懒，没有留下任何简介', '吧务团队', '本吧还没有吧主～', '申请成为吧主',
  ]);
  const isChrome = (line) => chrome.has(line) || line.startsWith('百度版权声明：') ||
    line.startsWith('使用百度前必读') || line.startsWith('信息网络传播视听节目许可证') ||
    line.startsWith('举报电话：');
  return rest.every(isChrome);
}

// Forum readiness follows positive content evidence and never character counts.
// Thread pages keep the original rule: no extra in-thread link is required.
function checkForumReadiness(text, links) {
  if (isForumShell(text, links)) return 'render_incomplete';
  if (!hasForumContentEvidence(text, links)) return 'render_incomplete';
  if (text.trim().length === 0) return 'empty';
  return 'page-read';
}

function isStandaloneChallenge(title, text) {
  if (title.trim() === '百度安全验证') return true;
  const lines = normalizedLines(text);
  const challenge = /^(?:请完成下方验证后继续操作|加载中\.\.\.|请向右滑动完成拼图|扫码验证|意见反馈|刷新|扫码验证\|意见反馈\|刷新|请输入验证码|拖动下方滑块)$/;
  return lines.length > 0 && lines.every((line) => challenge.test(line)) &&
    lines.some((line) => /验证|验证码|滑块/.test(line));
}

function classifyPage(status, finalUrl, title, text, context = {}) {
  if (status === 403) return 'access_blocked';
  if (status === 429) return 'rate_limit';
  const normalizedUrl = finalUrl.toLowerCase();
  if (/^https?:\/\/(passport|wappass)\.baidu\.com\//.test(normalizedUrl) ||
      /[?&](?:login|tpl|u)=/.test(normalizedUrl) && /passport|login/.test(normalizedUrl)) {
    return 'login_required';
  }
  if (isStandaloneChallenge(title, text)) return 'login_required';
  const sample = `${title}\n${text.slice(0, 4000)}`;
  if (/页面不存在|帖子不存在|贴吧不存在|你浏览的页面|404 Not Found|^404$/i.test(sample)) {
    return 'page_unavailable';
  }
  if (isNavigationSkeleton(text)) return 'render_incomplete';
  if (context.kind === 'forum') return checkForumReadiness(text, context.links ?? []);
  if (text.trim().length === 0) return 'empty';
  if (!hasThreadContentEvidence(title, text)) return 'render_incomplete';
  return 'page-read';
}

async function extractPage(page, kind) {
  return page.evaluate(async ({ maxText, maxLinks, origin, kind }) => {
    const body = document.body;
    const rawText = body ? body.innerText : '';
    const text = rawText.slice(0, maxText);
    const links = [];
    let linksTruncated = false;
    if (body) {
      for (const anchor of body.querySelectorAll('a[href]')) {
        const style = getComputedStyle(anchor);
        const rect = anchor.getBoundingClientRect();
        if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
            Number(style.opacity) === 0 || rect.width === 0 || rect.height === 0 || !anchor.innerText.trim()) {
          continue;
        }
        let url;
        try {
          url = new URL(anchor.href);
        } catch {
          continue;
        }
        if (url.origin !== origin || url.protocol !== 'https:') continue;
        const forum = url.pathname === '/f' && url.searchParams.has('kw');
        const thread = /^\/p\/\d+$/.test(url.pathname);
        const page = /^\/f\/\d+$/.test(url.pathname);
        if (!forum && !thread && !page) continue;
        if (links.length >= maxLinks) {
          linksTruncated = true;
          break;
        }
        links.push({ text: anchor.innerText, url: url.href });
      }
    }
    function tiebaIsHiddenStyle(el) {
      const style = getComputedStyle(el);
      return style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' || Number(style.opacity) === 0;
    }

    function tiebaIsRendered(el) {
      // Computed opacity does not include transparency inherited through the compositor.
      if (!el.checkVisibility({opacityProperty:true, visibilityProperty:true})) return false;
      const style = getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return !(style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse' ||
        Number(style.opacity) === 0 || rect.width === 0 || rect.height === 0);
    }

    function tiebaHasLzlAncestor(el) {
      for (let node = el; node; node = node.parentElement) {
        if (node.classList && node.classList.contains('lzl-wrapper')) return true;
      }
      return false;
    }

    function tiebaDirectChild(root, classNames) {
      for (const child of root.children) {
        let ok = true;
        for (const cn of classNames) {
          if (!child.classList || !child.classList.contains(cn)) { ok = false; break; }
        }
        if (ok) return child;
      }
      return null;
    }

    const TIEBA_TEXT_BLOCK_TAGS = {
      DIV: 1, P: 1, BLOCKQUOTE: 1, PRE: 1, LI: 1, UL: 1, OL: 1, SECTION: 1, ARTICLE: 1,
      HEADER: 1, FOOTER: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1, TABLE: 1, TR: 1, DD: 1, DT: 1,
    };
    function tiebaVisibleText(el) {
      let out = '';
      const ensureNewline = () => {
        if (out !== '' && out[out.length - 1] !== '\n') out += '\n';
      };
      const visit = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType === 3) { out += child.data; continue; }
          if (child.nodeType !== 1) continue;
          if (tiebaIsHiddenStyle(child)) continue;
          if (child.classList.contains('lzl-wrapper')) continue;
          if (child.tagName === 'BR') { out += '\n'; continue; }
          const isBlock = !!TIEBA_TEXT_BLOCK_TAGS[child.tagName];
          if (isBlock) ensureNewline();
          visit(child);
          if (isBlock) ensureNewline();
        }
      };
      visit(el);
      return out;
    }

    function tiebaFloorAuthor(item) {
      const headLine = tiebaDirectChild(item, ['head-line', 'user-info']);
      if (!headLine) return '';
      const anchors = [];
      const collect = (node) => {
        for (const child of node.childNodes) {
          if (child.nodeType !== 1) continue;
          if (tiebaIsHiddenStyle(child)) continue;
          if (child.classList.contains('lzl-wrapper')) continue;
          if (child.tagName === 'A' && child.classList.contains('head-name') && child.getAttribute('href') !== null) {
            anchors.push(child);
          }
          collect(child);
        }
      };
      collect(headLine);
      const visibleAnchors = anchors.filter((a) => tiebaIsRendered(a));
      if (visibleAnchors.length !== 1) return '';
      return tiebaVisibleText(visibleAnchors[0]).trim();
    }

    function tiebaFloorContent(item) {
      const contentWrap = tiebaDirectChild(item, ['comment-content']);
      if (!contentWrap) return null;
      for (const rich of contentWrap.children) {
        if (!rich.classList || !rich.classList.contains('pb-rich-text')) continue;
        if (!tiebaIsRendered(rich)) continue;
        return rich;
      }
      return null;
    }

    function tiebaFloorNumber(item) {
      const desc = item.querySelector('.pc-pb-comments-desc .comment-desc-left');
      const text = desc ? (desc.textContent || '').trim() : '';
      const match = /第?(\d+)\s*楼/.exec(text);
      if (match) return Number(match[1]);
      if (text === '楼主') return 1;
      return null;
    }

    // 1楼（主楼）不在虚拟列表里，位于 .image-text .pb-content-wrap，只渲染一次。
    function tiebaFirstFloor(doc) {
      const wrap = doc.querySelector('.image-text .pb-content-wrap');
      if (!wrap || !tiebaIsRendered(wrap)) return null;
      const content = tiebaVisibleText(wrap).trim();
      if (!content) return null;
      const head = doc.querySelector('.image-text a.head-name');
      const author = head && tiebaIsRendered(head) ? tiebaVisibleText(head).trim() : '';
      return { author, content, floor: 1 };
    }

    // 帖子头部「全部回复 (N)」是该帖可见回复总数（含楼中楼，不等于楼层数），
    // 平台不暴露页码总数；仅作体量参考，不能代替跨页去重。
    function tiebaReportedReplyTotal(doc) {
      const body = doc.body;
      if (!body) return null;
      const text = String(body.innerText || '').replace(/\s+/g, ' ');
      const match = /全部回复\s*[（(]\s*(\d+)\s*[)）]/.exec(text);
      return match ? Number(match[1]) : null;
    }

    // The PC thread is a virtual list: only a few floors are mounted at a time.
    // Harvest mounted floors while scrolling, dedupe by platform data-id, then
    // return them in first-mounted (floor) order. This reads one page only; it
    // never navigates to another pn.
    async function tiebaCollectThreadComments(doc, opts) {
      const maxCount = Number(opts.maxComments) > 0 ? Math.floor(Number(opts.maxComments)) : 0;
      const seen = new Map();
      const harvest = () => {
        for (const item of doc.querySelectorAll('div.pb-comment-item[data-id]')) {
          const id = item.getAttribute('data-id');
          if (!id || !/^\d+$/.test(id) || seen.has(id)) continue;
          if (tiebaHasLzlAncestor(item)) continue; // 楼中楼不混入顶层
          if (!tiebaIsRendered(item)) continue;
          const contentEl = tiebaFloorContent(item);
          if (!contentEl) continue;
          const content = tiebaVisibleText(contentEl).trim();
          if (!content) continue;
          seen.set(id, { author: tiebaFloorAuthor(item), content, floor: tiebaFloorNumber(item) });
          if (maxCount > 0 && seen.size >= maxCount) return true;
        }
        return false;
      };
      let capped = harvest();
      const scroller = doc.querySelector('div.thread-container');
      if (seen.size === 0 && !scroller) return { comments: [], truncated: false, totalReplies: tiebaReportedReplyTotal(doc) }; // 未 hydrate：不滚动
      if (scroller) {
        // 先回顶，避免一进页就停在中间楼层而漏掉最前几楼
        scroller.scrollTop = 0;
        await new Promise((resolve) => setTimeout(resolve, 200));
        capped = harvest() || capped;
      }
      const firstFloor = tiebaFirstFloor(doc);
      let stagnant = 0;
      for (let step = 0; !capped && step < 30 && stagnant < 4; step += 1) {
        const before = seen.size;
        if (scroller && scroller.scrollHeight > scroller.clientHeight + 20) {
          // 半个视口滚动，保证虚拟列表上下窗口有重叠，不漏楼
          scroller.scrollTop = scroller.scrollTop + Math.max(320, Math.floor(scroller.clientHeight * 0.5));
        } else {
          window.scrollBy(0, 600);
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
        if (harvest()) break;
        stagnant = seen.size === before ? stagnant + 1 : 0;
      }

      const rows = [...seen.values()];
      if (firstFloor && !rows.some((row) => row.content === firstFloor.content)) rows.unshift(firstFloor);
      rows.sort((a, b) => (a.floor ?? Number.MAX_SAFE_INTEGER) - (b.floor ?? Number.MAX_SAFE_INTEGER));

      const comments = [];
      let truncated = false;
      let charsLeft = Number(opts.maxCommentChars) > 0 ? Math.floor(Number(opts.maxCommentChars)) : 0;
      const maxAuthorChars = Number(opts.maxAuthorChars) > 0 ? Math.floor(Number(opts.maxAuthorChars)) : 0;
      for (const row of rows) {
        let author = row.author;
        if (maxAuthorChars > 0 && author.length > maxAuthorChars) {
          author = author.slice(0, maxAuthorChars);
          truncated = true;
        }
        if (charsLeft <= 0) { truncated = true; break; }
        if (row.content.length > charsLeft) {
          comments.push({ author, content: row.content.slice(0, charsLeft), floor: row.floor });
          truncated = true;
          break;
        }
        comments.push({ author, content: row.content, floor: row.floor });
        charsLeft -= row.content.length;
      }
      if (maxCount > 0 && seen.size >= maxCount) truncated = true;
      return { comments, truncated, totalReplies: tiebaReportedReplyTotal(doc) };
    }

    const tiebaResult = kind==='thread' ? await tiebaCollectThreadComments(document, { maxComments:40,maxCommentChars:6000,maxAuthorChars:50 }) : null;
    return {
      title: document.title,
      text,
      text_truncated: rawText.length > maxText,
      links,
      links_truncated: linksTruncated,
      ...(tiebaResult ? {comments:tiebaResult.comments,comments_truncated:tiebaResult.truncated,thread_reply_total:tiebaResult.totalReplies} : {}),
    };
  }, { maxText: MAX_TEXT, maxLinks: MAX_LINKS, origin: ORIGIN, kind });
}

function delay(milliseconds) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, milliseconds);
    timer.unref?.();
  });
}

function evidenceLevel(request, status) {
  if (status === 'render_incomplete') return request.kind === 'forum' ? 'loaded-shell' : 'unknown';
  return request.kind === 'forum' ? 'forum-leads' : 'thread-visible-page';
}

// Tieba clamps an out-of-range pn to a real page instead of failing. When a later-page
// request comes back with floor 1 among its comments, the site served page 1, so a
// sequential reader must treat it as the end of reachable content.
function threadPageMeta(request, status, extracted) {
  if (request.kind !== 'thread' || status !== 'page-read') return {};
  const floors = Array.isArray(extracted.comments) ?
    extracted.comments.map((row) => row.floor).filter(Number.isInteger) : [];
  const firstFloor = floors.length > 0 ? Math.min(...floors) : null;
  const lastFloor = floors.length > 0 ? Math.max(...floors) : null;
  return {
    page: request.page,
    page_first_floor: firstFloor,
    page_last_floor: lastFloor,
    // A real page N must have at least one floor numbered N or higher.
    // A clamped final page can contain only late floors, with no floor 1.
    page_clamped: Number.isInteger(request.page) && request.page > 1 &&
      (firstFloor === 1 || (lastFloor !== null && lastFloor < request.page)),
  };
}

function pageResult(request, observedAt, finalUrl, statusCode, extracted, status, extra = {}) {
  return {
    status,
    level: evidenceLevel(request, status),
    scope: 'current-page-only',
    observed_at: observedAt,
    requested_url: request.url,
    final_url: finalUrl,
    http_status: statusCode,
    title: extracted.title,
    text: extracted.text,
    text_length: extracted.text.length,
    text_truncated: extracted.text_truncated,
    links: extracted.links,
    links_truncated: extracted.links_truncated,
    ...(request.kind === 'thread' && status === 'page-read' && Array.isArray(extracted.comments) ?
      {comments:extracted.comments,comments_truncated:extracted.comments_truncated === true,
        ...(Number.isInteger(extracted.thread_reply_total) ? {thread_reply_total:extracted.thread_reply_total} : {})} : {}),
    ...threadPageMeta(request, status, extracted),
    untrusted_evidence: true,
    ...extra,
  };
}

export class TiebaReader {
  constructor({ profileDir, approvedRoot, chromium, headless = true, now = Date.now, wait = delay,
    setTimer = setTimeout, clearTimer = clearTimeout, extract = extractPage } = {}) {
    this.profileDir = profileDir;
    this.approvedRoot = approvedRoot;
    this.injectedChromium = chromium;
    if (typeof headless !== 'boolean') fail('invalid_arguments', 'headless must be boolean');
    if (typeof extract !== 'function') fail('invalid_arguments', 'extract must be a function');
    this.headless = headless;
    this.now = now;
    this.wait = wait;
    this.setTimer = setTimer;
    this.clearTimer = clearTimer;
    this.extract = extract;
    this.context = null;
    this.startPromise = null;
    this.tail = Promise.resolve();
    this.pending = 0;
    this.active = 0;
    this.closed = false;
    this.closePromise = null;
    this.generation = 0;
    this.currentPage = null;
    this.queueRejecters = [];
    this.activePromise = null;
    this.abortRead = null;
    this.cleanupUncertain = false;
    this.fatalCleanup = false;
  }

  _assertActive(generation) {
    if (this.closed || this.generation !== generation) fail('closed', 'Reader is closed');
  }

  _invalidate(generation) {
    if (this.closed || this.generation !== generation) return;
    this.generation += 1;
    this.fatalCleanup = true;
    for (const entry of this.queueRejecters) {
      entry.reject(new TiebaReaderError('page-read', 'Reader was invalidated by a failed read'));
    }
    this.queueRejecters.length = 0;
  }

  async _closeResource(resource, milliseconds) {
    if (!resource) return;
    try {
      await withTimeout(resource.close(), milliseconds, 'cleanup_uncertain', 'Browser resource close timed out');
    } catch (error) {
      this.cleanupUncertain = true;
      if (this.closed) throw new TiebaReaderError('cleanup_uncertain', `Browser cleanup may be incomplete: ${error?.message ?? String(error)}`);
    }
  }

  async _start(generation) {
    if (this.closed || this.generation !== generation) fail('closed', 'Reader is closed');
    if (this.context) return this.context;
    if (this.startPromise) return this.startPromise;
    this.startPromise = (async () => {
      const profile = await validateProfile(this.profileDir, this.approvedRoot);
      if (this.closed || this.generation !== generation) fail('closed', 'Reader is closed');
      await fs.mkdir(profile, { recursive: true });
      await assertNoLinkComponents(path.resolve(this.approvedRoot), profile);
      const chromium = this.injectedChromium ?? (await import('playwright-core')).chromium;
      if (!chromium || typeof chromium.launchPersistentContext !== 'function') {
        fail('invalid_arguments', 'A Playwright chromium implementation is required');
      }
      const context = await chromium.launchPersistentContext(profile, {
        channel: 'msedge',
        headless: this.headless,
        timeout: NAVIGATION_TIMEOUT_MS,
      });
      if (this.closed || this.generation !== generation) {
        await this._closeResource(context, 10_000);
        fail('closed', 'Reader is closed');
      }
      this.context = context;
      return context;
    })();
    try {
      return await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  _enqueue(work) {
    if (this.closed || this.fatalCleanup) {
      return Promise.reject(new TiebaReaderError('closed', 'Reader is closed after fatal cleanup'));
    }
    if (this.pending >= MAX_PENDING) {
      return Promise.reject(new TiebaReaderError('queue_full', 'At most four operations may be pending'));
    }
    this.pending += 1;
    const generation = this.generation;
    let rejectQueued;
    const cancelled = new Promise((_, reject) => { rejectQueued = reject; });
    const entry = { reject: rejectQueued };
    this.queueRejecters.push(entry);
    const result = Promise.race([
      this.tail.then(async () => {
        this.pending -= 1;
        const idx = this.queueRejecters.indexOf(entry);
        if (idx !== -1) this.queueRejecters.splice(idx, 1);
        if (this.closed || this.fatalCleanup || this.generation !== generation) fail('closed', 'Reader is closed');
        this.active += 1;
        const activeWork = work(generation);
        this.activePromise = activeWork.catch(() => {});
        try {
          return await activeWork;
        } finally {
          this.active -= 1;
          this.activePromise = null;
        }
      }),
      cancelled,
    ]);
    this.tail = result.catch(() => {});
    return result;
  }

  read(input) {
    if (this.closed || this.fatalCleanup) {
      return Promise.reject(new TiebaReaderError('closed', 'Reader is closed after fatal cleanup'));
    }
    let request;
    try {
      request = validateRead(input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this._enqueue((generation) => this._read(request, generation));
  }

  accountOperation(name, input) {
    if (this.closed || this.fatalCleanup) {
      return Promise.reject(new TiebaReaderError('closed', 'Reader is closed after fatal cleanup'));
    }
    try {
      validateAccountOperation(name, input);
    } catch (error) {
      return Promise.reject(error);
    }
    return this._enqueue((generation) => this._account(name, input, generation));
  }

  accountStatus(input) {
    return this.accountOperation('account_status', input);
  }

  preparePost(input) {
    return this.accountOperation('prepare_post', input);
  }

  publishPost(input) {
    return this.accountOperation('publish_post', input);
  }

  prepareReply(input) {
    return this.accountOperation('prepare_reply', input);
  }

  inspectReply(input) {
    return this.accountOperation('inspect_reply', input);
  }

  publishReply(input) {
    return this.accountOperation('publish_reply', input);
  }

  async _read(request, generation) {
    const observedAt = new Date().toISOString();
    let page;
    let context;
    let overallTimer;
    let rejectOverall;
    let timedOut = false;
    let failed = false;
    let result;
    const overall = new Promise((_, reject) => { rejectOverall = reject; });
    this.abortRead = () => {
      this._invalidate(generation);
      rejectOverall(new TiebaReaderError('closed', 'Reader closed during read'));
    };
    overallTimer = this.setTimer(() => {
      timedOut = true;
      this._invalidate(generation);
      rejectOverall(new TiebaReaderError('navigation_timeout', 'Read exceeded the 60 second overall limit'));
    }, OVERALL_TIMEOUT_MS);
    overallTimer?.unref?.();

    const operation = (async () => {
      try {
      context = await this._start(generation);
      this._assertActive(generation);
      page = await context.newPage();
      this.currentPage = page;
      this._assertActive(generation);
      page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
      page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
      let response;
      try {
        response = await page.goto(request.url, {
          waitUntil: 'domcontentloaded',
          timeout: NAVIGATION_TIMEOUT_MS,
        });
      } catch (error) {
        if (error?.name === 'TimeoutError' || /timeout/i.test(error?.message ?? '')) {
          fail('navigation_timeout', 'Navigation exceeded 30 seconds');
        }
        throw error;
      }
      this._assertActive(generation);
      const finalUrl = page.url();
      const statusCode = response?.status?.() ?? null;
      if (!sameOrigin(finalUrl)) {
        let loginRedirect = false;
        try {
          loginRedirect = ['passport.baidu.com', 'wappass.baidu.com'].includes(new URL(finalUrl).hostname);
        } catch {
          // Invalid final URLs remain cross-origin failures.
        }
        if (!loginRedirect) fail('cross_origin', 'Final page left tieba.baidu.com');
        return pageResult(request, observedAt, finalUrl, statusCode, {
          title: '', text: '', text_truncated: false, links: [], links_truncated: false,
        }, 'login_required');
      }

      const deadline = this.now() + BODY_READY_TIMEOUT_MS;
      let extracted;
      let status;
      do {
        extracted = await this.extract(page,request.kind);
        this._assertActive(generation);
        status = classifyPage(statusCode, finalUrl, extracted.title, extracted.text, {
          kind: request.kind,
          links: extracted.links,
        });
        if (status !== 'empty' && status !== 'render_incomplete') break;
        if (this.now() >= deadline) break;
        await this.wait(Math.min(BODY_POLL_MS, Math.max(0, deadline - this.now())));
        this._assertActive(generation);
      } while (true);
      const extra = status === 'access_blocked' && statusCode === 403
        ? { needs_manual_verification: true, reason: 'HTTP 403 from Tieba; manual verification is required' }
        : {};
      return pageResult(request, observedAt, finalUrl, statusCode, extracted, status, extra);
      } finally {
        if (this.currentPage === page) this.currentPage = null;
        await this._closeResource(page, 5_000);
        if (failed || timedOut || this.closed || this.generation !== generation) {
          if (this.context === context) this.context = null;
          await this._closeResource(context, 15_000);
        }
      }
    })();

    try {
      result = await Promise.race([operation, overall]);
      return result;
    } catch (error) {
      failed = true;
      if (!this.closed && !timedOut) this._invalidate(generation);
      if (error instanceof TiebaReaderError) throw error;
      if (this.closed) fail('closed', 'Reader closed during read');
      fail('page-read', `Could not read Tieba page: ${error?.message ?? String(error)}`);
    } finally {
      this.clearTimer(overallTimer);
      if (this.abortRead) this.abortRead = null;
      await operation.catch(() => {});
      if (this.cleanupUncertain && !this.closed) {
        throw new TiebaReaderError('cleanup_uncertain', 'Browser cleanup may be incomplete; close the reader before retrying');
      }
    }
  }

  async _account(name, input, generation) {
    let page;
    let context;
    let overallTimer;
    let rejectOverall;
    let timedOut = false;
    let failed = false;
    let cleanupFailure = false;
    let outcome;
    const receipt = { may_have_written: false };
    const controller = new AbortController();
    const external = input.signal;
    const abortExternal = () => controller.abort(external?.reason instanceof Error ? external.reason : new TiebaReaderError('aborted', 'Account operation aborted'));
    if (external) {
      if (external.aborted) abortExternal();
      else external.addEventListener('abort', abortExternal, { once: true });
    }
    const overall = new Promise((_, reject) => { rejectOverall = reject; });
    this.abortRead = () => {
      this._invalidate(generation);
      controller.abort(new TiebaReaderError('closed', 'Reader closed during account operation'));
      rejectOverall(new TiebaReaderError('closed', 'Reader closed during account operation'));
    };
    overallTimer = this.setTimer(() => {
      timedOut = true;
      this._invalidate(generation);
      controller.abort(new TiebaReaderError('operation_timeout', 'Account operation exceeded its deadline'));
      rejectOverall(new TiebaReaderError('operation_timeout', 'Account operation exceeded its deadline'));
    }, ACCOUNT_OPERATION_TIMEOUT_MS);
    overallTimer?.unref?.();

    const operation = (async () => {
      try {
        context = await this._start(generation);
        this._assertActive(generation);
        page = await context.newPage();
        this.currentPage = page;
        this._assertActive(generation);
        page.setDefaultTimeout(NAVIGATION_TIMEOUT_MS);
        page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
        const expected = Object.freeze({
          expectedHomeId: input.expectedHomeId,
          expectedNickname: input.expectedNickname,
        });
        const access = { signal: controller.signal, wait: this.wait, now: this.now };
        if (name === 'account_status') return await accountStatusOnPage(page, expected, access);
        if (['prepare_reply','publish_reply','inspect_reply'].includes(name)) {
          const replyDescriptor = Object.freeze({ thread_id: input.thread_id, body: input.body, thread_url: input.thread_url });
          if (name === 'inspect_reply') {
            const nav = await goto(page, replyDescriptor.thread_url, access.signal);
            if (nav.failure) return {status:'unavailable',reason:nav.failure};
            return await inspectReplyOnPage(page, replyDescriptor, expected, access);
          }
          if (name === 'prepare_reply') return await prepareReplyOnPage(page, replyDescriptor, expected, access);
          return await publishReplyOnPage(page, replyDescriptor, expected, {
            ...access,
            expiresAt: input.expiresAt,
            receipt,
            onBeforeSubmit: input.onBeforeSubmit,
          });
        }
        const descriptor = Object.freeze({ forum: input.forum, title: input.title, body: input.body });
        if (name === 'prepare_post') return await preparePostOnPage(page, descriptor, expected, access);
        return await publishPostOnPage(page, descriptor, expected, {
          ...access,
          expiresAt: input.expiresAt,
          receipt,
          onBeforeSubmit: input.onBeforeSubmit,
        });
      } finally {
        if (this.currentPage === page) this.currentPage = null;
        await this._closeResource(page, 5_000);
        if (failed || timedOut || this.closed || this.generation !== generation) {
          if (this.context === context) this.context = null;
          await this._closeResource(context, 15_000);
        }
      }
    })();

    try {
      try {
        outcome = await Promise.race([operation, overall]);
      } catch (error) {
        failed = true;
        if (!this.closed && !timedOut) this._invalidate(generation);
        const aborted = external?.aborted || (controller.signal.aborted && !timedOut);
        if ((name === 'publish_post' || name === 'publish_reply') && receipt.may_have_written) {
          outcome = accountRaw({
            status: 'outcome_unknown',
            reason: timedOut ? 'operation_timeout' : aborted ? 'aborted' : 'operation_failed',
            may_have_written: true,
          });
        } else if (timedOut || error?.code === 'operation_timeout') {
          outcome = accountRaw({ status: 'aborted', reason: 'operation_timeout' });
        } else if (aborted || error?.name === 'AbortError') {
          outcome = accountRaw({ status: 'aborted', reason: 'aborted' });
        } else if (error instanceof TiebaReaderError) {
          throw error;
        } else {
          outcome = accountRaw({ status: 'error', reason: 'operation_failed' });
        }
      }
    } finally {
      this.clearTimer(overallTimer);
      if (external) external.removeEventListener('abort', abortExternal);
      if (this.abortRead) this.abortRead = null;
      await operation.catch(() => {});
      cleanupFailure = this.cleanupUncertain && !this.closed;
    }
    if (cleanupFailure) {
      if ((name === 'publish_post' || name === 'publish_reply') && receipt.may_have_written) {
        return accountRaw({ status: 'outcome_unknown', reason: 'browser_cleanup_uncertain', may_have_written: true });
      }
      return accountRaw({ status: 'error', reason: 'browser_cleanup_uncertain' });
    }
    return outcome;
  }

  close() {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.generation += 1;
    for (const entry of this.queueRejecters) {
      entry.reject(new TiebaReaderError('closed', 'Reader is closed'));
    }
    this.queueRejecters.length = 0;
    this.abortRead?.();
    this.closePromise = (async () => {
      const page = this.currentPage;
      if (page) await this._closeResource(page, 5_000);
      if (this.startPromise) {
        try { await this.startPromise; } catch {}
      }
      if (this.activePromise) await this.activePromise;
      await this.tail;
      const context = this.context;
      this.context = null;
      if (context) await this._closeResource(context, 15_000);
      if (this.cleanupUncertain) {
        throw new TiebaReaderError('cleanup_uncertain', 'Browser cleanup may be incomplete; inspect the dedicated profile before reuse');
      }
    })();
    return this.closePromise;
  }
}

export async function createTiebaReader(options) {
  return new TiebaReader(options);
}

export const limits = Object.freeze({
  maxPending: MAX_PENDING,
  maxTextCharacters: MAX_TEXT,
  maxLinks: MAX_LINKS,
  navigationTimeoutMs: NAVIGATION_TIMEOUT_MS,
  overallTimeoutMs: OVERALL_TIMEOUT_MS,
});

