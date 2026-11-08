// Dedicated-account Tieba text posts. Everything happens through the single
// persistent TiebaReader page: identity is re-observed in the DOM, the composer
// is opened from the visible 发贴 entry, and at most one submit click is made.
// Selectors below are the observed REAL-DOM candidates; an ambiguous target is
// unsupported rather than resolved by picking the first matching element.

import { createHash } from 'node:crypto';

const ORIGIN = 'https://tieba.baidu.com';
const HOME_URL = `${ORIGIN}/`;
const PROFILE_PATH = '/home/main';
const PROFILE_FR = 'personalize_page';

export const TIEBA_POST_LIMITS = Object.freeze({
  forumMax: 100,
  titleMin: 5,
  titleMax: 31,
  bodyMin: 1,
  bodyMax: 2000,
});

const TITLE_SELECTOR = '.post-title .ql-editor[contenteditable="true"]';
// REAL-DOM shows the contenteditable ql-editor as a child of
// `.post-editor-content ql-container`. The descendant combinator is required;
// `.post-editor-content.ql-editor` would target the container, not the editor.
const BODY_SELECTOR = '.post-editor-content .ql-editor[contenteditable="true"]';
const FORUM_INPUT_SELECTOR = 'input[placeholder="选择吧"]';
// Observed typed-search dropdown. Selecting a result closes this container
// (display:none), which is the positive proof that the typed value became a
// real selection. Background forum cards are never used as options.
const FORUM_DROPDOWN_SELECTOR = '.search-warp .search-bottom';
const FORUM_RESULT_SELECTOR = '.search-warp .search-bottom .forum-item .forum-card-title .name';
const AI_DECLARATION_TEXT_SELECTOR = '.t-radio-group-item span.label';
const SUBMIT_STRATEGIES = Object.freeze([
  '.footer-safe-issue .issue-btn',
  '.footer-safe-issue .button-wrapper--primary',
  '.issue-btn',
]);
const AI_DECLARATION_LABEL = '贴子含AI内容';
const PROFILE_EDIT_LABEL = '编辑资料';
const SITE_TITLE = '百度贴吧';
const COMPOSE_ENTRY_TEXTS = Object.freeze(['发贴', '发帖']);
const POLL_MS = 200;
const COMPOSER_ATTEMPTS = 75; // 15 s bounded SPA readiness
const IDENTITY_READY_ATTEMPTS = 75; // 15 s bounded SPA readiness
const FORUM_ATTEMPTS = 25; // 5 s
const OUTCOME_ATTEMPTS = 75; // 15 s
const READBACK_ATTEMPTS = 25; // 5 s
const STEP_TIMEOUT_MS = 10_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

const CHALLENGE_LINES = /^(?:百度安全验证|请完成下方验证后继续操作|请向右滑动完成拼图|扫码验证|请输入验证码|操作太频繁|访问异常|系统繁忙，请稍后再试)$/;
const REJECTION_LINES = /^(?:发布失败|帖子发布失败|内容含有违规信息|该内容被禁止发布|你发布的内容包含违规信息|无法发布|暂不能发布)$/;
const CONFIRMATION_TEXT = /(?:确认|确定)\s*(?:发布|提交)|(?:发布|提交)\s*(?:确认|确定)/;

function fault(code) {
  return Object.assign(new Error(code), { code });
}

function raw(fields = {}) {
  return {
    status: 'error',
    reason: null,
    identity_verified: false,
    may_have_written: false,
    automatic_retry: false,
    ...fields,
  };
}

// Narrow proven utilities are shared with the reply flow below; the post
// behavior itself is unchanged.
export function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : Object.assign(new Error('aborted'), { name: 'AbortError' });
  }
}

export function sha256Text(value) {
  return createHash('sha256').update(String(value), 'utf8').digest('hex');
}

function codePoints(value) {
  return [...value].length;
}

function hasControl(value, allowLineFeeds = false) {
  const pattern = allowLineFeeds ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  return pattern.test(value);
}

export function normalizePostInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('invalid_arguments');
  const keys = Object.keys(input);
  if (keys.some((key) => !['forum', 'title', 'body'].includes(key))) throw fault('invalid_arguments');
  if (!Object.hasOwn(input, 'forum') || !Object.hasOwn(input, 'title') || !Object.hasOwn(input, 'body')) {
    throw fault('invalid_arguments');
  }
  if (typeof input.forum !== 'string') throw fault('invalid_forum');
  const forum = input.forum.trim();
  if (!forum || codePoints(forum) > TIEBA_POST_LIMITS.forumMax || /[\/?#]/.test(forum) || hasControl(forum)) {
    throw fault('invalid_forum');
  }
  if (typeof input.title !== 'string' || !input.title.trim() || hasControl(input.title)) throw fault('invalid_title');
  if (codePoints(input.title) < TIEBA_POST_LIMITS.titleMin || codePoints(input.title) > TIEBA_POST_LIMITS.titleMax) {
    throw fault('invalid_title');
  }
  if (typeof input.body !== 'string') throw fault('invalid_body');
  const body = input.body.replace(/\r\n/g, '\n').replace(/\n+$/g, '');
  if (!body.trim() || hasControl(body, true)) throw fault('invalid_body');
  if (codePoints(body) < TIEBA_POST_LIMITS.bodyMin || codePoints(body) > TIEBA_POST_LIMITS.bodyMax) {
    throw fault('invalid_body');
  }
  return Object.freeze({ forum, title: input.title, body });
}

export function normalizeDraftId(value) {
  if (typeof value !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw fault('invalid_draft_id');
  }
  return value.toLowerCase();
}

export function normalizeEditorText(value) {
  return String(value ?? '').replace(/\r\n/g, '\n').replace(/\u00a0/g, ' ');
}

export function comparableEditorText(value) {
  return normalizeEditorText(value).replace(/\n+$/g, '');
}

export function parseHomeLink(href) {
  if (typeof href !== 'string') return null;
  let url;
  try {
    url = new URL(href, ORIGIN);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== ORIGIN || url.username || url.password || url.hash) return null;
  if (url.pathname !== PROFILE_PATH) return null;
  return url;
}

function profileLinkFor(homeId) {
  return `${ORIGIN}${PROFILE_PATH}?id=${encodeURIComponent(homeId)}&fr=${PROFILE_FR}`;
}

export function threadUrl(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value, ORIGIN);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== ORIGIN || url.username || url.password || url.hash) return null;
  const match = /^\/p\/(\d{1,20})$/.exec(url.pathname);
  return match ? `${ORIGIN}/p/${match[1]}` : null;
}

export async function visibleItems(locator, signal) {
  throwIfAborted(signal);
  let count;
  try {
    count = await locator.count();
  } catch {
    throwIfAborted(signal);
    return [];
  }
  const items = [];
  for (let index = 0; index < count; index += 1) {
    throwIfAborted(signal);
    const item = locator.nth(index);
    try {
      if (await item.isVisible()) items.push(item);
    } catch {
      throwIfAborted(signal);
    }
  }
  return items;
}

export async function uniqueVisible(locator, signal, unavailable, ambiguous) {
  const items = await visibleItems(locator, signal);
  if (items.length === 0) return { failure: unavailable };
  if (items.length > 1) return { failure: ambiguous };
  return { locator: items[0] };
}

// A typed value alone is not a selection: the observed results dropdown stays
// visible until a result is really chosen. Selection is proven only by the
// exact value, the observed input classes, and a closed (display:none)
// `.search-warp .search-bottom` container.
async function forumSelectionConfirmed(page, input, forum, signal) {
  let value;
  try {
    value = String(await input.inputValue());
  } catch {
    throwIfAborted(signal);
    return false;
  }
  throwIfAborted(signal);
  if (value !== forum) return false;
  let className = '';
  try {
    className = String(await input.getAttribute('class') ?? '');
  } catch {
    throwIfAborted(signal);
    return false;
  }
  throwIfAborted(signal);
  const classes = className.split(/\s+/).filter(Boolean);
  if (!classes.includes('search-box') || !classes.includes('cursor-pointer')) return false;
  const open = await visibleItems(page.locator(FORUM_DROPDOWN_SELECTOR), signal);
  return open.length === 0;
}

export async function poll(work, { signal, wait, attempts }) {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    throwIfAborted(signal);
    const value = await work();
    if (value !== null && value !== undefined) return value;
    await wait(POLL_MS, signal);
    throwIfAborted(signal);
  }
  return null;
}

export async function goto(page, url, signal) {
  throwIfAborted(signal);
  let response;
  try {
    response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAVIGATION_TIMEOUT_MS });
  } catch {
    throwIfAborted(signal);
    return { failure: 'navigation_failed' };
  }
  throwIfAborted(signal);
  const status = typeof response?.status === 'function' ? response.status() : 200;
  if (status === 401) return { status: 'login_required', failure: 'login_required' };
  if ([403, 412, 429].includes(status)) return { status: 'blocked', failure: 'risk_control_or_captcha' };
  let final;
  try {
    final = new URL(page.url());
  } catch {
    return { failure: 'navigation_failed' };
  }
  if (final.protocol !== 'https:' || final.origin !== ORIGIN) return { failure: 'cross_origin' };
  return { status, url: final };
}

async function identityLink(page, expected, signal) {
  const found = await uniqueVisible(page.getByText('我的', { exact: true }), signal,
    'identity_link_unavailable', 'identity_link_ambiguous');
  if (found.failure) return found;
  const href = await found.locator.getAttribute('href');
  throwIfAborted(signal);
  const url = parseHomeLink(href);
  if (!url) return { failure: 'identity_link_unavailable' };
  const keys = [...url.searchParams.keys()];
  if (keys.some((key) => key !== 'id' && key !== 'fr')) return { failure: 'identity_link_unavailable' };
  const ids = url.searchParams.getAll('id');
  const frs = url.searchParams.getAll('fr');
  if (ids.length !== 1 || frs.length > 1) return { failure: 'identity_link_unavailable' };
  if (ids[0] !== expected.expectedHomeId) return { failure: 'identity_mismatch' };
  // fr is optional tracking; when present only the known value is accepted.
  if (frs.length === 1 && frs[0] !== PROFILE_FR) return { failure: 'identity_mismatch' };
  return { url: url.href };
}

// The SPA paints the home shell after domcontentloaded and hydrates the
// account header later. Wait for the exact 我的 profile link instead of
// treating an absent header as an unavailable identity.
async function identityLinkReady(page, expected, { signal, wait }) {
  const link = await poll(async () => {
    const observed = await identityLink(page, expected, signal);
    if (observed.failure === 'identity_link_unavailable') return null;
    return observed;
  }, { signal, wait, attempts: IDENTITY_READY_ATTEMPTS });
  return link ?? { failure: 'identity_link_unavailable' };
}

// The profile route also paints a generic shell first (title 百度贴吧, no
// 编辑资料). Readiness requires both the exact nickname title and the visible
// account-owned edit control. A different settled title is a real mismatch; an
// exhausted deadline stays unavailable rather than assuming the account.
async function profileIdentityReady(page, expected, { signal, wait }) {
  const expectedTitle = `${expected.expectedNickname}-${SITE_TITLE}`;
  const observed = await poll(async () => {
    let title;
    try {
      title = String(await page.title()).trim();
    } catch {
      throwIfAborted(signal);
      return null;
    }
    throwIfAborted(signal);
    if (title === expectedTitle) {
      const edit = await uniqueVisible(page.getByText(PROFILE_EDIT_LABEL, { exact: true }), signal,
        'identity_profile_unavailable', 'identity_profile_ambiguous');
      if (edit.failure === 'identity_profile_ambiguous') return { failure: edit.failure };
      return edit.locator ? { ready: true } : null;
    }
    if (title === '' || title === SITE_TITLE) return null;
    return { failure: 'identity_mismatch' };
  }, { signal, wait, attempts: IDENTITY_READY_ATTEMPTS });
  return observed ?? { failure: 'identity_profile_unavailable' };
}

export async function blockingPage(page, signal) {
  for (const selector of ['.geetest_box', '.geetest_panel', '.geetest_wrap']) {
    const items = await visibleItems(page.locator(selector), signal);
    if (items.length > 0) return { status: 'blocked', reason: 'risk_control_or_captcha' };
  }
  let text = '';
  try {
    text = await page.locator('body').innerText();
  } catch {
    throwIfAborted(signal);
    return null;
  }
  throwIfAborted(signal);
  const lines = normalizeEditorText(text).split('\n').map((line) => line.trim()).filter(Boolean);
  if (lines.some((line) => CHALLENGE_LINES.test(line))) return { status: 'blocked', reason: 'risk_control_or_captcha' };
  if (lines.some((line) => REJECTION_LINES.test(line))) return { status: 'denied', reason: 'platform_rejected' };
  return null;
}

export async function mandatoryConfirmation(page, signal) {
  for (const selector of ['[role="dialog"]', '.dialog', '.modal']) {
    const dialogs = await visibleItems(page.locator(selector), signal);
    for (const dialog of dialogs) {
      let text = '';
      try {
        text = await dialog.innerText();
      } catch {
        throwIfAborted(signal);
        continue;
      }
      throwIfAborted(signal);
      if (text.includes(AI_DECLARATION_LABEL)) continue;
      if (CONFIRMATION_TEXT.test(text)) return true;
    }
  }
  return false;
}

export async function verifyIdentity(page, expected, { signal, wait } = {}) {
  const home = await goto(page, HOME_URL, signal);
  if (home.failure) return raw({ status: home.status ?? 'error', reason: home.failure });
  const blocked = await blockingPage(page, signal);
  if (blocked) return raw({ status: blocked.status, reason: blocked.reason });
  const link = await identityLinkReady(page, expected, { signal, wait });
  if (link.failure) {
    return raw({ status: link.failure === 'identity_mismatch' ? 'identity_mismatch' : 'unsupported', reason: link.failure });
  }
  const profile = await goto(page, link.url, signal);
  if (profile.failure) return raw({ status: profile.status ?? 'error', reason: profile.failure });
  let profileUrl;
  try {
    profileUrl = new URL(page.url());
  } catch {
    return raw({ status: 'error', reason: 'navigation_failed' });
  }
  if (profileUrl.pathname !== PROFILE_PATH || profileUrl.searchParams.get('id') !== expected.expectedHomeId) {
    return raw({ status: 'identity_mismatch', reason: 'identity_mismatch' });
  }
  const identity = await profileIdentityReady(page, expected, { signal, wait });
  if (identity.failure) {
    return raw({
      status: identity.failure === 'identity_mismatch' ? 'identity_mismatch' : 'unsupported',
      reason: identity.failure,
    });
  }
  const back = await goto(page, HOME_URL, signal);
  if (back.failure) return raw({ status: back.status ?? 'error', reason: back.failure });
  const final = await identityLinkReady(page, expected, { signal, wait });
  if (final.failure) {
    return raw({ status: final.failure === 'identity_mismatch' ? 'identity_mismatch' : 'unsupported', reason: final.failure });
  }
  return raw({ status: 'ready', reason: null, identity_verified: true, observed_at: new Date().toISOString() });
}

export async function accountStatusOnPage(page, expected, { signal, wait } = {}) {
  try {
    const identity = await verifyIdentity(page, expected, { signal, wait });
    if (identity.status === 'ready') return identity;
    return raw({ status: identity.status, reason: identity.reason });
  } catch (error) {
    if (signal?.aborted) return raw({ status: 'aborted', reason: 'aborted' });
    return raw({ status: 'error', reason: 'operation_failed' });
  }
}

async function openComposer(page, { signal, wait }) {
  let entry = null;
  for (const text of COMPOSE_ENTRY_TEXTS) {
    const items = await visibleItems(page.getByText(text, { exact: true }), signal);
    if (items.length > 1) return { failure: 'composer_ambiguous' };
    if (items.length === 1) {
      entry = items[0];
      break;
    }
  }
  if (!entry) return { failure: 'composer_unavailable' };
  throwIfAborted(signal);
  try {
    await entry.click({ timeout: STEP_TIMEOUT_MS });
  } catch {
    throwIfAborted(signal);
    return { failure: 'composer_unavailable' };
  }
  throwIfAborted(signal);
  const ready = await poll(async () => {
    const input = await visibleItems(page.locator(FORUM_INPUT_SELECTOR), signal);
    const title = await visibleItems(page.locator(TITLE_SELECTOR), signal);
    const body = await visibleItems(page.locator(BODY_SELECTOR), signal);
    if (input.length !== 1 || title.length !== 1 || body.length !== 1) return null;
    return { input: input[0], title: title[0], body: body[0] };
  }, { signal, wait, attempts: COMPOSER_ATTEMPTS });
  if (!ready) return { failure: 'composer_unavailable' };
  let url;
  try {
    url = new URL(page.url());
  } catch {
    return { failure: 'navigation_failed' };
  }
  if (url.protocol !== 'https:' || url.origin !== ORIGIN) return { failure: 'cross_origin' };
  return { input: ready.input, title: ready.title, body: ready.body };
}

async function selectForum(page, forum, { signal, wait }) {
  const input = await uniqueVisible(page.locator(FORUM_INPUT_SELECTOR), signal,
    'forum_input_unavailable', 'forum_input_ambiguous');
  if (input.failure) return input;
  try {
    await input.locator.click({ timeout: STEP_TIMEOUT_MS });
    await input.locator.fill(forum);
  } catch {
    throwIfAborted(signal);
    return { failure: 'forum_input_unavailable' };
  }
  throwIfAborted(signal);
  // Match the whole visible name, never a substring: the observed dropdown can
  // contain both "deepseek" and "反deepseek" cards. Background forum cards are
  // not part of this selector and can never be clicked.
  const option = await poll(async () => {
    const items = await visibleItems(page.locator(FORUM_RESULT_SELECTOR), signal);
    const matches = [];
    for (const item of items) {
      let text = '';
      try {
        text = String(await item.innerText()).trim();
      } catch {
        throwIfAborted(signal);
        continue;
      }
      throwIfAborted(signal);
      if (text === forum) matches.push(item);
    }
    if (matches.length > 1) return { failure: 'forum_ambiguous' };
    if (matches.length === 1) return { locator: matches[0] };
    return null;
  }, { signal, wait, attempts: FORUM_ATTEMPTS });
  if (!option) return { failure: 'forum_not_found' };
  if (option.failure) return option;
  throwIfAborted(signal);
  try {
    await option.locator.click({ timeout: STEP_TIMEOUT_MS });
  } catch {
    throwIfAborted(signal);
    return { failure: 'forum_target_unverified' };
  }
  const selected = await poll(async () => (
    await forumSelectionConfirmed(page, input.locator, forum, signal) ? true : null
  ), { signal, wait, attempts: FORUM_ATTEMPTS });
  if (!selected) return { failure: 'forum_target_unverified' };
  return { input: input.locator };
}

async function fillEditors(page, descriptor, { signal }) {
  const titleEditor = await uniqueVisible(page.locator(TITLE_SELECTOR), signal,
    'editor_unavailable', 'editor_ambiguous');
  const bodyEditor = await uniqueVisible(page.locator(BODY_SELECTOR), signal,
    'editor_unavailable', 'editor_ambiguous');
  if (titleEditor.failure) return titleEditor;
  if (bodyEditor.failure) return bodyEditor;
  throwIfAborted(signal);
  try {
    await titleEditor.locator.fill(descriptor.title);
    await bodyEditor.locator.fill(descriptor.body);
  } catch {
    throwIfAborted(signal);
    return { failure: 'editor_unavailable' };
  }
  throwIfAborted(signal);
  let titleText;
  let bodyText;
  try {
    titleText = await titleEditor.locator.innerText();
    bodyText = await bodyEditor.locator.innerText();
  } catch {
    throwIfAborted(signal);
    return { failure: 'editor_unavailable' };
  }
  throwIfAborted(signal);
  if (comparableEditorText(titleText) !== comparableEditorText(descriptor.title) ||
      comparableEditorText(bodyText) !== comparableEditorText(descriptor.body)) {
    return { failure: 'editor_content_mismatch' };
  }
  return { title: titleEditor.locator, body: bodyEditor.locator };
}

function safeRadioId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{1,100}$/.test(value);
}

// Observed declaration: `.t-radio-group-item` > visible `span.label`
// (贴子含AI内容) plus a hidden native input[type=radio]. The native checked
// state is the only success proof. A visible associated label[for=<id>] is
// clicked when present; the real DOM's empty zero-size label is not visible, so
// the already exact matched visible span in the same verified container is
// clicked instead once the label association and the unique native radio are
// proven. The hidden input is never clicked.
async function selectAiDeclaration(page, { signal }) {
  const spans = await visibleItems(page.locator(AI_DECLARATION_TEXT_SELECTOR), signal);
  const matches = [];
  for (const span of spans) {
    let text = '';
    try {
      text = String(await span.innerText()).trim();
    } catch {
      throwIfAborted(signal);
      continue;
    }
    throwIfAborted(signal);
    if (text === AI_DECLARATION_LABEL) matches.push(span);
  }
  if (matches.length === 0) {
    const labels = await visibleItems(page.getByText(AI_DECLARATION_LABEL, { exact: true }), signal);
    if (labels.length > 0) return { failure: 'ai_declaration_unsupported' };
    return { supported: false, selected: false };
  }
  if (matches.length > 1) return { failure: 'ai_declaration_ambiguous' };
  let container;
  let containerClass;
  try {
    container = matches[0].locator('..');
    containerClass = String(await container.getAttribute('class') ?? '');
  } catch {
    throwIfAborted(signal);
    return { failure: 'ai_declaration_unsupported' };
  }
  throwIfAborted(signal);
  if (!containerClass.split(/\s+/).filter(Boolean).includes('t-radio-group-item')) {
    return { failure: 'ai_declaration_unsupported' };
  }
  const radios = container.locator('input[type="radio"]');
  let radioCount;
  let id;
  try {
    radioCount = await radios.count();
    if (radioCount === 1) id = await radios.nth(0).getAttribute('id');
  } catch {
    throwIfAborted(signal);
    return { failure: 'ai_declaration_unsupported' };
  }
  throwIfAborted(signal);
  if (radioCount !== 1 || !safeRadioId(id)) return { failure: 'ai_declaration_unsupported' };
  const radio = radios.nth(0);
  const associatedLabels = container.locator(`label[for="${id}"]`);
  let labelCount;
  try {
    labelCount = await associatedLabels.count();
  } catch {
    throwIfAborted(signal);
    return { failure: 'ai_declaration_unsupported' };
  }
  throwIfAborted(signal);
  if (labelCount !== 1) return { failure: 'ai_declaration_unsupported' };
  const associatedLabel = associatedLabels.nth(0);
  let labelVisible;
  try {
    labelVisible = await associatedLabel.isVisible();
  } catch {
    throwIfAborted(signal);
    return { failure: 'ai_declaration_unsupported' };
  }
  throwIfAborted(signal);
  let checked;
  try {
    checked = await radio.isChecked();
  } catch {
    throwIfAborted(signal);
    return { failure: 'ai_declaration_unsupported' };
  }
  throwIfAborted(signal);
  if (!checked) {
    // The real radio's label is display:block but empty and zero-size, while
    // the exact visible span text is the clickable surface.
    const target = labelVisible ? associatedLabel : matches[0];
    try {
      await target.click({ timeout: STEP_TIMEOUT_MS });
      checked = await radio.isChecked();
    } catch {
      throwIfAborted(signal);
      return { failure: 'ai_declaration_unsupported' };
    }
    throwIfAborted(signal);
  }
  if (checked !== true) return { failure: 'ai_declaration_unsupported' };
  return { supported: true, selected: true };
}

async function findSubmit(page, signal) {
  for (const selector of SUBMIT_STRATEGIES) {
    const items = await visibleItems(page.locator(selector), signal);
    if (items.length > 1) return { failure: 'submit_ambiguous' };
    if (items.length === 1) {
      let enabled = true;
      try {
        enabled = await items[0].isEnabled();
      } catch {
        throwIfAborted(signal);
      }
      throwIfAborted(signal);
      if (!enabled) return { failure: 'submit_unavailable' };
      return { locator: items[0] };
    }
  }
  return { failure: 'submit_unavailable' };
}

async function checkComposerTarget(page, expected, descriptor, { signal }) {
  const link = await identityLink(page, expected, signal);
  if (link.failure) {
    return { failure: link.failure === 'identity_mismatch' ? 'identity_mismatch' : 'target_unverified' };
  }
  const input = await uniqueVisible(page.locator(FORUM_INPUT_SELECTOR), signal,
    'forum_input_unavailable', 'forum_input_ambiguous');
  if (input.failure) return { failure: 'target_unverified' };
  if (!(await forumSelectionConfirmed(page, input.locator, descriptor.forum, signal))) {
    return { failure: 'target_unverified' };
  }
  const title = await uniqueVisible(page.locator(TITLE_SELECTOR), signal, 'editor_unavailable', 'editor_ambiguous');
  const body = await uniqueVisible(page.locator(BODY_SELECTOR), signal, 'editor_unavailable', 'editor_ambiguous');
  if (title.failure || body.failure) return { failure: 'target_unverified' };
  let titleText;
  let bodyText;
  try {
    titleText = await title.locator.innerText();
    bodyText = await body.locator.innerText();
  } catch {
    throwIfAborted(signal);
    return { failure: 'target_unverified' };
  }
  if (comparableEditorText(titleText) !== comparableEditorText(descriptor.title) ||
      comparableEditorText(bodyText) !== comparableEditorText(descriptor.body)) {
    return { failure: 'target_unverified' };
  }
  return { ready: true, title: title.locator, body: body.locator };
}

async function verifyThreadPage(page, expected, descriptor, url, signal) {
  if (threadUrl(page.url()) !== url) return { ok: false };
  let title = '';
  let bodyText = '';
  try {
    title = String(await page.title());
    bodyText = await page.locator('body').innerText();
  } catch {
    throwIfAborted(signal);
    return { ok: false };
  }
  throwIfAborted(signal);
  if (!title.includes(descriptor.title)) return { ok: false };
  if (!normalizeEditorText(bodyText).includes(normalizeEditorText(descriptor.body))) return { ok: false };
  // The author link is the positive identity evidence: its text is the trusted
  // nickname and its opaquely identified href is the same 我的 profile target.
  // The navigation 我的 link has different text, so it does not match here.
  const anchors = await visibleItems(page.locator('a[href]'), signal);
  let authors = 0;
  for (const anchor of anchors) {
    const href = await anchor.getAttribute('href');
    throwIfAborted(signal);
    const parsed = parseHomeLink(href);
    if (!parsed || parsed.searchParams.get('id') !== expected.expectedHomeId) continue;
    let text = '';
    try {
      text = String(await anchor.innerText()).trim();
    } catch {
      throwIfAborted(signal);
      continue;
    }
    throwIfAborted(signal);
    if (text === expected.expectedNickname) authors += 1;
  }
  if (authors !== 1) return { ok: false };
  return Object.freeze({
    ok: true,
    thread_url: url,
    title: descriptor.title,
    body_sha256: sha256Text(descriptor.body),
    author: expected.expectedNickname,
    observed_at: new Date().toISOString(),
  });
}

async function profileReadback(page, expected, descriptor, beforeUrl, { signal, wait }) {
  const profile = await goto(page, profileLinkFor(expected.expectedHomeId), signal);
  if (profile.failure) return { ok: false };
  for (let attempt = 0; attempt < READBACK_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const anchors = await visibleItems(page.locator('a[href]'), signal);
    const urls = new Set();
    for (const anchor of anchors) {
      const href = await anchor.getAttribute('href');
      throwIfAborted(signal);
      const target = threadUrl(href);
      if (!target || target === beforeUrl) continue;
      let text = '';
      try {
        text = String(await anchor.innerText()).trim();
      } catch {
        throwIfAborted(signal);
        continue;
      }
      throwIfAborted(signal);
      if (text && text.includes(descriptor.title)) urls.add(target);
    }
    if (urls.size === 1) {
      const target = [...urls][0];
      const opened = await goto(page, target, signal);
      if (!opened.failure) {
        const proof = await verifyThreadPage(page, expected, descriptor, target, signal);
        if (proof.ok) return proof;
      }
    }
    await wait(POLL_MS, signal);
  }
  return { ok: false };
}

async function awaitOutcome(page, expected, descriptor, beforeUrl, { signal, wait }) {
  for (let attempt = 0; attempt < OUTCOME_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    const current = threadUrl(page.url());
    if (current && current !== beforeUrl) {
      const proof = await verifyThreadPage(page, expected, descriptor, current, signal);
      if (proof.ok) return { ...proof, status: 'confirmed', may_have_written: true };
    }
    const blocked = await blockingPage(page, signal);
    if (blocked) return { ...blocked, may_have_written: true };
    if (await mandatoryConfirmation(page, signal)) {
      return { status: 'outcome_unknown', reason: 'mandatory_confirmation_not_understood', may_have_written: true };
    }
    await wait(POLL_MS, signal);
  }
  const readback = await profileReadback(page, expected, descriptor, beforeUrl, { signal, wait });
  if (readback.ok) return { ...readback, status: 'confirmed', may_have_written: true };
  return { status: 'outcome_unknown', reason: 'readback_unavailable', may_have_written: true };
}

async function composeContext(page, expected, descriptor, { signal, wait }) {
  const identity = await verifyIdentity(page, expected, { signal, wait });
  if (identity.status !== 'ready') return { failure: identity.status, reason: identity.reason };
  const composer = await openComposer(page, { signal, wait });
  if (composer.failure) return { failure: 'unsupported', reason: composer.failure };
  const forum = await selectForum(page, descriptor.forum, { signal, wait });
  if (forum.failure) return { failure: 'unsupported', reason: forum.failure };
  const editors = await fillEditors(page, descriptor, { signal });
  if (editors.failure) return { failure: 'unsupported', reason: editors.failure };
  const declaration = await selectAiDeclaration(page, { signal });
  if (declaration.failure) return { failure: 'unsupported', reason: declaration.failure };
  if (await mandatoryConfirmation(page, signal)) {
    return { failure: 'unsupported', reason: 'mandatory_confirmation_not_understood' };
  }
  const submit = await findSubmit(page, signal);
  if (submit.failure) return { failure: 'unsupported', reason: submit.failure };
  const target = await checkComposerTarget(page, expected, descriptor, { signal });
  if (target.failure) {
    return {
      failure: target.failure === 'identity_mismatch' ? 'identity_mismatch' : 'unsupported',
      reason: target.failure,
    };
  }
  return {
    ready: true,
    input: forum.input,
    title: target.title,
    body: target.body,
    submit: submit.locator,
    ai_supported: declaration.supported === true,
    ai_selected: declaration.selected === true,
  };
}

export async function preparePostOnPage(page, descriptor, expected, { signal, wait } = {}) {
  try {
    throwIfAborted(signal);
    const composer = await composeContext(page, expected, descriptor, { signal, wait });
    if (composer.failure) {
      return raw({
        status: ['identity_mismatch', 'login_required', 'blocked'].includes(composer.failure) ? composer.failure : 'unsupported',
        reason: composer.reason,
      });
    }
    return raw({
      status: 'ready',
      reason: null,
      identity_verified: true,
      may_have_written: false,
      no_submit_performed: true,
      submit_available: true,
      ai_declaration_supported: composer.ai_supported,
      ai_declaration_selected: composer.ai_selected,
      preview: {
        forum: descriptor.forum,
        title: descriptor.title,
        body: descriptor.body,
        title_sha256: sha256Text(descriptor.title),
        body_sha256: sha256Text(descriptor.body),
      },
      observed_at: new Date().toISOString(),
    });
  } catch (error) {
    if (signal?.aborted) return raw({ status: 'aborted', reason: 'aborted' });
    if (error?.name === 'TimeoutError' || error?.code === 'operation_timeout') {
      return raw({ status: 'aborted', reason: 'operation_timeout' });
    }
    return raw({ status: 'error', reason: 'operation_failed' });
  }
}

export async function publishPostOnPage(page, descriptor, expected, {
  signal, wait, now = Date.now, expiresAt, receipt = { may_have_written: false }, onBeforeSubmit,
} = {}) {
  let identityVerified = false;
  try {
    throwIfAborted(signal);
    if (Number.isFinite(expiresAt) && now() >= expiresAt) {
      return raw({ status: 'expired', reason: 'draft_expired' });
    }
    const composer = await composeContext(page, expected, descriptor, { signal, wait });
    if (composer.failure) {
      return raw({
        status: ['identity_mismatch', 'login_required', 'blocked'].includes(composer.failure) ? composer.failure : 'unsupported',
        reason: composer.reason,
      });
    }
    identityVerified = true;
    if (Number.isFinite(expiresAt) && now() >= expiresAt) {
      return raw({ status: 'expired', reason: 'draft_expired', identity_verified: true });
    }
    // All target checks are the last awaits before the durable transition and
    // the one submit click. An abort arriving after the transition but before
    // the click leaves may_have_written false and causes no submission.
    throwIfAborted(signal);
    const beforeUrl = threadUrl(page.url()) ?? page.url();
    if (typeof onBeforeSubmit === 'function') await onBeforeSubmit({ forum: descriptor.forum, title: descriptor.title, body: descriptor.body });
    throwIfAborted(signal);
    receipt.may_have_written = true;
    try {
      await composer.submit.click({ timeout: STEP_TIMEOUT_MS });
    } catch {
      throwIfAborted(signal);
      return raw({
        status: 'outcome_unknown',
        reason: 'operation_failed',
        identity_verified: true,
        may_have_written: true,
      });
    }
    const outcome = await awaitOutcome(page, expected, descriptor, beforeUrl, { signal, wait });
    return raw({
      ...outcome,
      identity_verified: true,
      may_have_written: outcome.may_have_written !== false,
      ai_declaration_supported: composer.ai_supported,
      ai_declaration_selected: composer.ai_selected,
    });
  } catch (error) {
    if (receipt.may_have_written) {
      return raw({
        status: 'outcome_unknown',
        reason: signal?.aborted ? 'aborted' : 'operation_failed',
        identity_verified: identityVerified,
        may_have_written: true,
      });
    }
    if (signal?.aborted) return raw({ status: 'aborted', reason: 'aborted', identity_verified: identityVerified });
    if (error?.name === 'TimeoutError' || error?.code === 'operation_timeout') {
      return raw({ status: 'aborted', reason: 'operation_timeout', identity_verified: identityVerified });
    }
    return raw({ status: 'error', reason: 'operation_failed', identity_verified: identityVerified });
  }
}

export const tiebaAccountSelectors = Object.freeze({
  title: TITLE_SELECTOR,
  body: BODY_SELECTOR,
  forumInput: FORUM_INPUT_SELECTOR,
  submit: SUBMIT_STRATEGIES[0],
  aiDeclarationLabel: AI_DECLARATION_LABEL,
});
