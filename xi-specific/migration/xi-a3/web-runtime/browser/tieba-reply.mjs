// Dedicated-account TOP-LEVEL Tieba thread replies. Everything happens through
// the single persistent TiebaReader page: identity is re-observed with the
// proven helper, the exact /p/<id> route is verified, and at most one scoped
// submit click is made. Only top-level thread replies are supported; nested
// (楼中楼) replies, @mentions, images and deletions are explicitly out of scope.
//
// Reply selectors come from the observed REPLY-DOM.json: a unique collapsed
// `.reply-input` entry opens the `.pc-focus-reply-box` containing
// `#tb-editor-pb-content .ql-editor[contenteditable=true]` and the scoped
// `.publish-btn.button-wrapper--primary` (initially `button-wrapper-disabled`).
// The page's global post button and the per-comment 回复 controls are never
// matched by these selectors.
//
// Confirmation requires provable evidence, never textual guesswork:
// - Authorship is bound to the trusted account only through the reply's author
//   anchor carrying BOTH the opaque expectedHomeId href AND the exact nickname
//   text. A same-nickname account with a different opaque id never matches.
//   Legacy floors (`.l_post[data-field]`) carry only a display name, so they
//   have no stable account binding and can never confirm anything.
// - Content is compared as normalized EQUALITY of the extracted content
//   element's text. There is no substring acceptance anywhere: container
//   metadata (author, time, buttons, quotes) is excluded by extracting the
//   content carrier first, and a short body can never match longer prose.
// - The comment-id carriers and the content carrier below remain candidate
//   observations. When no provable content carrier is observed for a reply,
//   that reply contributes nothing; an unconfirmed submit stays outcome_unknown.
//   Nothing is ever fabricated: no comment id, receipt, or comment URL.

import {
  blockingPage, comparableEditorText, goto, mandatoryConfirmation, normalizeEditorText,
  parseHomeLink, poll, sha256Text, throwIfAborted, uniqueVisible, verifyIdentity, visibleItems,
} from './tieba-account.mjs';

const ORIGIN = 'https://tieba.baidu.com';

export const TIEBA_REPLY_LIMITS = Object.freeze({
  threadIdDigits: { min: 1, max: 20 },
  bodyMin: 1,
  bodyMax: 2000,
});

const REPLY_ENTRY_SELECTOR = '.reply-input';
const REPLY_ENTRY_PLACEHOLDER = '参与讨论涨经验 去APP回复经验更多';
const REPLY_BOX_SELECTOR = '.pc-focus-reply-box';
const REPLY_EDITOR_SELECTOR = `${REPLY_BOX_SELECTOR} #tb-editor-pb-content .ql-editor[contenteditable="true"]`;
const REPLY_SUBMIT_SELECTOR = `${REPLY_BOX_SELECTOR} .publish-btn.button-wrapper--primary`;
const SUBMIT_DISABLED_CLASS = 'button-wrapper-disabled';
// Observed SPA reply DOM: each top-level reply is a DIV.pb-comment-item carrying
// the stable numeric platform id in data-id. `.reply-container` is a SPAN action
// button, not a comment, and must never be treated as one. Exactly one container
// selector is scanned: locator objects from two different queries cannot be
// deduplicated by identity, so a second scan would falsely mark ids conflicting.
const SPA_REPLY_CONTAINER_SELECTOR = 'div.pb-comment-item[data-id]';
// The only accepted comment-id carrier is the container's own data-id. Legacy
// `.l_post[data-field]` floors, guessed data-pid, and header/action attributes are
// not consulted: a container without a numeric data-id can never confirm.
const REPLY_ID_ATTRIBUTE = 'data-id';
// Author header scope inside one comment item. Everything is scoped through
// `:scope > .head-line.user-info`; the trusted anchor is a unique visible
// a.head-name[href] nested under .left-box/.head-info/.name-info. Other anchors
// (avatar, mask) also live under the header and are deliberately not matched.
const REPLY_HEADER_SELECTOR = ':scope > .head-line.user-info';
const REPLY_AUTHOR_LINK_SELECTOR = 'a.head-name[href]';
// Provable body carrier inside one comment item: exactly the direct
// .comment-content > .pb-rich-text. The nested .lzl-wrapper (楼中楼) subtree is
// never traversed, so nested replies cannot contribute content evidence.
const REPLY_CONTENT_SELECTOR = ':scope > .comment-content > .pb-rich-text';
// Kept defined (single union of candidate carriers) so any existing import or
// reference to this name stays bound; extraction uses REPLY_CONTENT_SELECTOR.
const REPLY_CONTENT_CANDIDATES = Object.freeze(['.pb-rich-text']);
const REPLY_CONTENT_UNION_SELECTOR = REPLY_CONTENT_CANDIDATES.join(', ');
const THREAD_NOT_FOUND_LINE = /^(?:页面不存在|帖子不存在|贴吧不存在|你浏览的页面|404 Not Found|404)$/;
const POLL_MS = 200;
const REPLY_BOX_ATTEMPTS = 75; // 15 s bounded SPA readiness
const SUBMIT_ENABLE_ATTEMPTS = 25; // 5 s for the SPA to enable the filled button
const OUTCOME_ATTEMPTS = 75; // 15 s to observe the new reply in the list
const STEP_TIMEOUT_MS = 10_000;
const MAX_ENTRIES = 200;

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

function codePoints(value) {
  return [...value].length;
}

function hasControl(value, allowLineFeeds = false) {
  const pattern = allowLineFeeds ? /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/ : /[\u0000-\u001f\u007f]/;
  return pattern.test(value);
}

export function normalizeReplyInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw fault('invalid_arguments');
  const keys = Object.keys(input);
  if (keys.some((key) => !['thread_id', 'body'].includes(key))) throw fault('invalid_arguments');
  if (!Object.hasOwn(input, 'thread_id') || !Object.hasOwn(input, 'body')) throw fault('invalid_arguments');
  if (typeof input.thread_id !== 'string' || !/^\d{1,20}$/.test(input.thread_id)) throw fault('invalid_thread_id');
  if (typeof input.body !== 'string' || !input.body.trim() || hasControl(input.body, true)) throw fault('invalid_body');
  if (codePoints(input.body) < TIEBA_REPLY_LIMITS.bodyMin || codePoints(input.body) > TIEBA_REPLY_LIMITS.bodyMax) {
    throw fault('invalid_body');
  }
  // \r is a control character that Tieba editors do not preserve; CRLF and lone
  // CR become LF so the multiline text survives unchanged otherwise.
  const body = input.body.replace(/\r\n?/g, '\n');
  return Object.freeze({
    thread_id: input.thread_id,
    body,
    thread_url: `${ORIGIN}/p/${input.thread_id}`,
  });
}

// Strict normalized equality of the extracted reply content. Trailing-newline
// normalization first, then whitespace-collapsed equality for rendering reflow.
// Both directions are full equalities: a short body can never match longer
// prose, and metadata text can never stand in for missing content.
function replyContentMatches(observed, body) {
  if (comparableEditorText(observed) === comparableEditorText(body)) return true;
  const collapse = (value) => normalizeEditorText(value).replace(/\s+/g, ' ').trim();
  return collapse(observed) === collapse(body);
}

function digitsOnly(value) {
  return typeof value === 'string' && /^\d{1,20}$/.test(value) ? value : null;
}

async function containerAuthorMatches(container, expected, signal) {
  // The author anchor is the only trusted binding: its href must be the opaque
  // 我的 profile target of the expected account AND its text the exact
  // nickname. A same-nickname account with a different opaque id never matches,
  // and an absent/ambiguous header yields no binding at all (never nickname-only).
  const headers = await visibleItems(container.locator(REPLY_HEADER_SELECTOR), signal);
  if (headers.length !== 1) return false;
  const links = await visibleItems(headers[0].locator(REPLY_AUTHOR_LINK_SELECTOR), signal);
  if (links.length !== 1) return false;
  const href = await links[0].getAttribute('href');
  throwIfAborted(signal);
  const parsed = parseHomeLink(href);
  if (!parsed || parsed.searchParams.get('id') !== expected.expectedHomeId) return false;
  let text = '';
  try {
    text = String(await links[0].innerText()).trim();
  } catch {
    throwIfAborted(signal);
    return false;
  }
  throwIfAborted(signal);
  return text === expected.expectedNickname;
}

// The provable content carrier inside one container. Zero visible carriers ->
// no provable content (null); more than one -> ambiguous evidence; exactly one
// -> its text, which must later equal the draft body exactly.
async function containerContent(container, signal) {
  // Exactly one visible direct body carrier, nested .lzl-wrapper excluded.
  // Zero -> no provable content (null); more than one -> ambiguous evidence.
  const items = await visibleItems(container.locator(REPLY_CONTENT_SELECTOR), signal);
  if (items.length === 0) return null;
  if (items.length > 1) return { ambiguous: true };
  let text;
  try {
    text = await items[0].innerText();
  } catch {
    throwIfAborted(signal);
    return null;
  }
  throwIfAborted(signal);
  return { text };
}

// One bounded scan of the current page for candidate reply containers carrying
// a stable platform comment id. Returns a Map id -> {container, conflict}.
// Two distinct containers claiming one id is conflicting evidence and makes
// that id unusable for confirmation.
async function scanReplyEntries(page, signal) {
  const entries = new Map();
  const containers = await visibleItems(page.locator(SPA_REPLY_CONTAINER_SELECTOR), signal);
  for (const container of containers) {
    if (entries.size >= MAX_ENTRIES) break;
    let value;
    try {
      value = await container.getAttribute(REPLY_ID_ATTRIBUTE);
    } catch {
      throwIfAborted(signal);
      continue;
    }
    throwIfAborted(signal);
    const id = digitsOnly(value);
    if (!id) continue;
    if (entries.has(id)) {
      entries.get(id).conflict = true;
      continue;
    }
    entries.set(id, { comment_id: id, container, conflict: false });
  }
  return entries;
}

// Own matching entries: every condition is independently proven — the trusted
// author binding, exactly one visible content carrier, and normalized equality
// between that carrier's text and the draft body. Anything less is skipped and
// the outcome stays unknown.
async function ownMatchingEntries(page, expected, descriptor, signal) {
  const entries = await scanReplyEntries(page, signal);
  const matched = [];
  for (const entry of entries.values()) {
    if (entry.conflict) continue;
    if (!(await containerAuthorMatches(entry.container, expected, signal))) continue;
    const content = await containerContent(entry.container, signal);
    if (!content || content.ambiguous) continue;
    if (!replyContentMatches(content.text, descriptor.body)) continue;
    matched.push(entry);
  }
  return matched;
}

async function collectExistingReplyIds(page, expected, descriptor, { signal }) {
  const matched = await ownMatchingEntries(page, expected, descriptor, signal);
  return new Set(matched.map((entry) => entry.comment_id));
}

async function threadPageUnavailable(page, signal) {
  let text = '';
  try {
    text = await page.locator('body').innerText();
  } catch {
    throwIfAborted(signal);
    return false;
  }
  throwIfAborted(signal);
  const lines = normalizeEditorText(text).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.some((line) => THREAD_NOT_FOUND_LINE.test(line));
}

// Route checking only: query strings and hashes (anchor jumps, reply permalinks)
// do not change the thread, but the pathname must be exactly this /p/<id>.
function threadRoute(value) {
  if (typeof value !== 'string') return null;
  let url;
  try {
    url = new URL(value, ORIGIN);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.origin !== ORIGIN || url.username || url.password) return null;
  const match = /^\/p\/(\d{1,20})$/.exec(url.pathname);
  return match ? `${ORIGIN}/p/${match[1]}` : null;
}

async function verifyThreadRoute(page, descriptor, signal) {
  if (threadRoute(page.url()) !== descriptor.thread_url) {
    return { failure: 'unsupported', reason: 'reply_route_unverified' };
  }
  const blocked = await blockingPage(page, signal);
  if (blocked) {
    // A rejection banner before any click is not a denial of our write.
    return blocked.status === 'denied'
      ? { failure: 'unsupported', reason: 'platform_rejected' }
      : { failure: blocked.status, reason: blocked.reason };
  }
  if (await threadPageUnavailable(page, signal)) return { failure: 'unsupported', reason: 'thread_unavailable' };
  return {};
}

async function openReplyEditor(page, { signal, wait }) {
  const entry = await poll(async () => {
    const found = await uniqueVisible(page.locator(REPLY_ENTRY_SELECTOR), signal,
      'reply_editor_unavailable', 'reply_editor_ambiguous');
    return found.failure === 'reply_editor_unavailable' ? null : found;
  }, { signal, wait, attempts: REPLY_BOX_ATTEMPTS }) ?? { failure: 'reply_editor_unavailable' };
  if (entry.failure) return entry;
  let entryText = '';
  try {
    entryText = normalizeEditorText(String(await entry.locator.innerText())).trim();
  } catch {
    throwIfAborted(signal);
    return { failure: 'reply_editor_unavailable' };
  }
  throwIfAborted(signal);
  // The observed collapsed entry shows the placeholder copy; anything else with
  // this class is not the known root reply entry.
  if (entryText !== REPLY_ENTRY_PLACEHOLDER) return { failure: 'reply_editor_unavailable' };
  try {
    await entry.locator.click({ timeout: STEP_TIMEOUT_MS });
  } catch {
    throwIfAborted(signal);
    return { failure: 'reply_editor_unavailable' };
  }
  throwIfAborted(signal);
  const ready = await poll(async () => {
    const editor = await uniqueVisible(page.locator(REPLY_EDITOR_SELECTOR), signal,
      'reply_editor_unavailable', 'reply_editor_ambiguous');
    const submit = await uniqueVisible(page.locator(REPLY_SUBMIT_SELECTOR), signal,
      'reply_editor_unavailable', 'reply_editor_ambiguous');
    if (editor.failure === 'reply_editor_ambiguous' || submit.failure === 'reply_editor_ambiguous') {
      return { failure: 'reply_editor_ambiguous' };
    }
    if (editor.locator && submit.locator) return { editor: editor.locator, submit: submit.locator };
    return null;
  }, { signal, wait, attempts: REPLY_BOX_ATTEMPTS });
  return ready ?? { failure: 'reply_editor_unavailable' };
}

async function submitEnabled(submit, signal) {
  let className = '';
  try {
    className = String(await submit.getAttribute('class') ?? '');
  } catch {
    throwIfAborted(signal);
    return false;
  }
  throwIfAborted(signal);
  const classes = className.split(/\s+/).filter(Boolean);
  if (classes.includes(SUBMIT_DISABLED_CLASS)) return false;
  try {
    return await submit.isEnabled();
  } catch {
    throwIfAborted(signal);
    return false;
  }
}

// Identity, the exact thread route, the root reply editor, the exact body and
// the enabled scoped submit are all re-proven here. Everything is the last
// awaits before the durable transition and the one submit click.
async function replyContext(page, expected, descriptor, { signal, wait, withExistingIds }) {
  const identity = await verifyIdentity(page, expected, { signal, wait });
  if (identity.status !== 'ready') return { failure: identity.status, reason: identity.reason };
  const nav = await goto(page, descriptor.thread_url, signal);
  if (nav.failure) return { failure: 'unsupported', reason: nav.failure };
  const route = await verifyThreadRoute(page, descriptor, signal);
  if (route.failure) return route;
  const opened = await openReplyEditor(page, { signal, wait });
  if (opened.failure) return { failure: 'unsupported', reason: opened.failure };
  throwIfAborted(signal);
  try {
    await opened.editor.fill(descriptor.body);
  } catch {
    throwIfAborted(signal);
    return { failure: 'unsupported', reason: 'reply_editor_unavailable' };
  }
  throwIfAborted(signal);
  let editorText;
  try {
    editorText = await opened.editor.innerText();
  } catch {
    throwIfAborted(signal);
    return { failure: 'unsupported', reason: 'reply_editor_unavailable' };
  }
  throwIfAborted(signal);
  if (comparableEditorText(editorText) !== comparableEditorText(descriptor.body)) {
    return { failure: 'unsupported', reason: 'reply_content_mismatch' };
  }
  const stillEditor = await uniqueVisible(page.locator(REPLY_EDITOR_SELECTOR), signal,
    'reply_editor_unavailable', 'reply_editor_ambiguous');
  if (stillEditor.failure) return { failure: 'unsupported', reason: stillEditor.failure };
  const stillSubmit = await uniqueVisible(page.locator(REPLY_SUBMIT_SELECTOR), signal,
    'reply_editor_unavailable', 'reply_editor_ambiguous');
  if (stillSubmit.failure) return { failure: 'unsupported', reason: stillSubmit.failure };
  if (threadRoute(page.url()) !== descriptor.thread_url) {
    return { failure: 'unsupported', reason: 'reply_route_unverified' };
  }
  if (await mandatoryConfirmation(page, signal)) {
    return { failure: 'unsupported', reason: 'mandatory_confirmation_not_understood' };
  }
  const enabled = await poll(async () => (
    await submitEnabled(stillSubmit.locator, signal) ? true : null
  ), { signal, wait, attempts: SUBMIT_ENABLE_ATTEMPTS });
  if (!enabled) return { failure: 'unsupported', reason: 'reply_disabled' };
  const existingIds = withExistingIds
    ? await collectExistingReplyIds(page, expected, descriptor, { signal })
    : new Set();
  return { editor: opened.editor, submit: stillSubmit.locator, existingIds };
}

async function awaitReplyOutcome(page, expected, descriptor, existingIds, { signal, wait }) {
  for (let attempt = 0; attempt < OUTCOME_ATTEMPTS; attempt += 1) {
    throwIfAborted(signal);
    // The reply can only be confirmed on the same thread route. Any navigation
    // away stops the outcome search without ever claiming success.
    if (threadRoute(page.url()) !== descriptor.thread_url) {
      return { status: 'outcome_unknown', reason: 'reply_route_unverified', may_have_written: true };
    }
    const blocked = await blockingPage(page, signal);
    if (blocked) return { ...blocked, may_have_written: true };
    if (await mandatoryConfirmation(page, signal)) {
      return { status: 'outcome_unknown', reason: 'mandatory_confirmation_not_understood', may_have_written: true };
    }
    const matched = await ownMatchingEntries(page, expected, descriptor, signal);
    const fresh = matched.filter((entry) => !existingIds.has(entry.comment_id));
    if (fresh.length === 1) {
      return {
        ok: true,
        status: 'confirmed',
        comment_id: fresh[0].comment_id,
        thread_url: descriptor.thread_url,
        body_sha256: sha256Text(descriptor.body),
        author: expected.expectedNickname,
        observed_at: new Date().toISOString(),
        may_have_written: true,
      };
    }
    if (fresh.length > 1) {
      return { status: 'outcome_unknown', reason: 'reply_readback_ambiguous', may_have_written: true };
    }
    await wait(POLL_MS, signal);
  }
  return { status: 'outcome_unknown', reason: 'readback_unavailable', may_have_written: true };
}

export async function prepareReplyOnPage(page, descriptor, expected, { signal, wait } = {}) {
  try {
    throwIfAborted(signal);
    const context = await replyContext(page, expected, descriptor, { signal, wait, withExistingIds: false });
    if (context.failure) {
      return raw({
        status: ['identity_mismatch', 'login_required', 'blocked'].includes(context.failure) ? context.failure : 'unsupported',
        reason: context.reason,
      });
    }
    return raw({
      status: 'ready',
      reason: null,
      identity_verified: true,
      may_have_written: false,
      no_submit_performed: true,
      submit_available: true,
      preview: {
        thread_id: descriptor.thread_id,
        thread_url: descriptor.thread_url,
        body: descriptor.body,
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

export async function publishReplyOnPage(page, descriptor, expected, {
  signal, wait, now = Date.now, expiresAt, receipt = { may_have_written: false }, onBeforeSubmit,
} = {}) {
  let identityVerified = false;
  try {
    throwIfAborted(signal);
    if (Number.isFinite(expiresAt) && now() >= expiresAt) {
      return raw({ status: 'expired', reason: 'draft_expired' });
    }
    const context = await replyContext(page, expected, descriptor, { signal, wait, withExistingIds: true });
    if (context.failure) {
      return raw({
        status: ['identity_mismatch', 'login_required', 'blocked'].includes(context.failure) ? context.failure : 'unsupported',
        reason: context.reason,
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
    if (typeof onBeforeSubmit === 'function') {
      await onBeforeSubmit({ thread_id: descriptor.thread_id, body: descriptor.body });
    }
    throwIfAborted(signal);
    receipt.may_have_written = true;
    try {
      await context.submit.click({ timeout: STEP_TIMEOUT_MS });
    } catch {
      throwIfAborted(signal);
      return raw({
        status: 'outcome_unknown',
        reason: 'operation_failed',
        identity_verified: true,
        may_have_written: true,
      });
    }
    const outcome = await awaitReplyOutcome(page, expected, descriptor, context.existingIds, { signal, wait });
    return raw({
      ...outcome,
      identity_verified: true,
      may_have_written: outcome.may_have_written !== false,
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

// Read-only inspection of an ALREADY open exact thread. It never navigates,
// clicks, fills, submits, opens the editor, or touches any journal: the only
// page interaction is reading the route, the block banners, and the DOM.
// Identity binding is the trusted author anchor (expectedHomeId + exact
// nickname) and content is normalized equality with the expected body; nothing
// caller-supplied is consulted beyond the validated descriptor and the opaque
// expectedHomeId/nickname pair. Output is an observation, never a delivery
// claim: no "confirmed", "fresh", "may_have_written", or timestamp fields.
//
// status meanings on a non-unique observation:
// - not_observed (zero own matching entries)
// - ambiguous    (more than one canonically distinct match)
// - unavailable  (wrong route, blocked page, unavailable thread, malformed
//                 descriptor/binding, or an internal failure)
function inspectUnavailable(reason) {
  return { status: 'unavailable', reason, comment_id: null, thread_url: null };
}

function inspectResult(status, reason, commentId, threadUrl) {
  return { status, reason, comment_id: commentId, thread_url: threadUrl };
}

// The caller may hand over an already-validated frozen descriptor or a raw
// input. Both are re-derived here from scratch, so the returned body is the
// normalized one the matcher compares against, and a thread_url that disagrees
// with the thread id fails closed instead of being trusted.
function inspectDescriptor(descriptor) {
  if (!descriptor || typeof descriptor !== 'object' || Object.keys(descriptor).some(key => !['body','thread_id','thread_url'].includes(key))) return null;
  let normalized;
  try {
    normalized = normalizeReplyInput({ thread_id: descriptor.thread_id, body: descriptor.body });
  } catch {
    return null;
  }
  if (descriptor.thread_url !== undefined && descriptor.thread_url !== normalized.thread_url) return null;
  return normalized;
}

function inspectBinding(expected) {
  if (!expected || typeof expected !== 'object' || Object.keys(expected).length !== 2) return null;
  if (!Object.hasOwn(expected, 'expectedHomeId') || !Object.hasOwn(expected, 'expectedNickname')) return null;
  const { expectedHomeId, expectedNickname } = expected;
  // Apply the dedicated account binding limits used by the browser service.
  if (typeof expectedNickname !== 'string' || !expectedNickname || expectedNickname !== expectedNickname.trim()) {
    return null;
  }
  if (expectedNickname.length > 100 || hasControl(expectedNickname)) return null;
  if (typeof expectedHomeId !== 'string' || expectedHomeId.length < 1 || expectedHomeId.length > 200) return null;
  if (hasControl(expectedHomeId)) return null;
  return Object.freeze({ expectedHomeId, expectedNickname });
}

export async function inspectReplyOnPage(page, descriptor, expected, { signal } = {}) {
  try {
    throwIfAborted(signal);
    const input = inspectDescriptor(descriptor);
    if (!input) return inspectUnavailable('invalid_descriptor');
    const binding = inspectBinding(expected);
    if (!binding) return inspectUnavailable('invalid_binding');
    // The route is read, never navigated. Anything but the exact /p/<id> thread
    // path on the canonical origin is unavailable.
    const route = threadRoute(page.url());
    if (route !== input.thread_url) return inspectUnavailable('reply_route_unverified');
    const blocked = await blockingPage(page, signal);
    if (blocked) return inspectUnavailable(blocked.reason);
    if (await threadPageUnavailable(page, signal)) return inspectUnavailable('thread_unavailable');
    // ownMatchingEntries proves, per candidate: a conflict-free numeric data-id,
    // the unique author anchor carrying BOTH the opaque expectedHomeId profile
    // href AND the exact nickname, one visible direct content carrier, and
    // normalized-equality of that carrier. Only those entries are scored.
    const matched = await ownMatchingEntries(page, binding, input, signal);
    throwIfAborted(signal);
    if (threadRoute(page.url()) !== input.thread_url) return inspectUnavailable('reply_route_unverified');
    const ids = [...new Set(matched.map((entry) => entry.comment_id))];
    if (ids.length === 0) return inspectResult('not_observed', null, null, null);
    if (ids.length > 1) return inspectResult('ambiguous', 'multiple_matches', null, null);
    return inspectResult('observed_unique', null, ids[0], input.thread_url);
  } catch (error) {
    if (signal?.aborted) return inspectUnavailable('aborted');
    if (error?.name === 'TimeoutError' || error?.code === 'operation_timeout') {
      return inspectUnavailable('operation_timeout');
    }
    return inspectUnavailable('operation_failed');
  }
}

export const tiebaReplySelectors = Object.freeze({
  entry: REPLY_ENTRY_SELECTOR,
  box: REPLY_BOX_SELECTOR,
  editor: REPLY_EDITOR_SELECTOR,
  submit: REPLY_SUBMIT_SELECTOR,
  submitDisabledClass: SUBMIT_DISABLED_CLASS,
  container: SPA_REPLY_CONTAINER_SELECTOR,
  content: REPLY_CONTENT_UNION_SELECTOR,
});
