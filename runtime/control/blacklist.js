// 拉黑名单：按 QQ 号记录「不再理这个人」。
// 来源两种：主人在私聊里明确下令（owner），或她按规则自行触发（auto）。
// 一旦拉黑，入站消息在入库/唤醒/记忆之前就被丢掉，直到主人解封。
import { atomicWriteJson, readJsonSafe } from '../kernel/state-file.js';

export const BLACKLIST_DEFAULTS = Object.freeze({
  enabled: true,
  auto: { enabled: true, windowMs: 24 * 3600 * 1000, insultCount: 3, affectionFloor: 5 },
  announce: '我再也不想理你了',
  naturalLanguage: { enabled: true }
});

const QQ_RE = /^\d{5,12}$/;

function clean(text, max) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
}

export function normalizeBlacklistState(raw) {
  const value = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const entries = {};
  const source = value.entries && typeof value.entries === 'object' && !Array.isArray(value.entries) ? value.entries : {};
  for (const [qq, entry] of Object.entries(source)) {
    if (!QQ_RE.test(String(qq))) continue;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    entries[String(qq)] = {
      qq: String(qq),
      name: clean(entry.name, 40),
      reason: clean(entry.reason, 120),
      origin: entry.origin === 'auto' ? 'auto' : 'owner',
      at: Number(entry.at) || 0
    };
  }
  const autoHits = {};
  const hits = value.autoHits && typeof value.autoHits === 'object' && !Array.isArray(value.autoHits) ? value.autoHits : {};
  for (const [qq, list] of Object.entries(hits)) {
    if (!QQ_RE.test(String(qq)) || !Array.isArray(list)) continue;
    autoHits[String(qq)] = list.map(Number).filter((n) => Number.isFinite(n) && n > 0).slice(-20);
  }
  return { version: 1, entries, autoHits };
}

export function createBlacklist({ file = '', now = () => Date.now(), log = () => {} } = {}) {
  let state = normalizeBlacklistState(file ? readJsonSafe(file, {}) : {});
  const save = () => {
    if (!file) return;
    try { atomicWriteJson(file, state); } catch (error) { log(`[blacklist] 写入失败：${error?.message ?? error}`); }
  };
  return {
    isBlocked(qq) {
      return Boolean(state.entries[String(qq ?? '').trim()]);
    },
    get(qq) {
      return state.entries[String(qq ?? '').trim()] || null;
    },
    list() {
      return Object.values(state.entries).sort((a, b) => b.at - a.at);
    },
    count() {
      return Object.keys(state.entries).length;
    },
    add({ qq, name = '', reason = '', origin = 'owner', at = now() } = {}) {
      const id = String(qq ?? '').trim();
      if (!QQ_RE.test(id)) return { ok: false, error: 'bad-qq' };
      const prev = state.entries[id];
      state.entries[id] = {
        qq: id,
        name: clean(name || prev?.name, 40),
        reason: clean(reason || prev?.reason, 120),
        origin: origin === 'auto' ? 'auto' : 'owner',
        at: Number(at) || now()
      };
      delete state.autoHits[id];
      save();
      return { ok: true, entry: state.entries[id], replaced: Boolean(prev) };
    },
    remove(qq) {
      const id = String(qq ?? '').trim();
      if (!state.entries[id]) return { ok: false, error: 'not-found' };
      delete state.entries[id];
      delete state.autoHits[id];
      save();
      return { ok: true };
    },
    /**
     * 记一次辱骂/攻击。返回是否达到自行拉黑的门槛。
     * 门槛：窗口内累计次数 ≥ insultCount；或好感已跌到 affectionFloor 以下且窗口内有攻击。
     * 只有 insult / hostile 两类计数，普通调侃不计。
     */
    noteStrike({ qq, type = '', affection = null, threshold = BLACKLIST_DEFAULTS.auto, at = now() } = {}) {
      const id = String(qq ?? '').trim();
      if (!QQ_RE.test(id)) return { counted: false, block: false };
      if (!['insult', 'hostile'].includes(String(type))) return { counted: false, block: false };
      const windowMs = Math.max(60 * 1000, Number(threshold.windowMs) || BLACKLIST_DEFAULTS.auto.windowMs);
      const need = Math.max(1, Math.floor(Number(threshold.insultCount) || BLACKLIST_DEFAULTS.auto.insultCount));
      const floor = Number.isFinite(Number(threshold.affectionFloor)) ? Number(threshold.affectionFloor) : BLACKLIST_DEFAULTS.auto.affectionFloor;
      const list = (state.autoHits[id] || []).filter((t) => Number(at) - t <= windowMs);
      list.push(Number(at) || now());
      state.autoHits[id] = list.slice(-20);
      const repeated = list.length >= need;
      const cold = Number.isFinite(Number(affection)) && Number(affection) <= floor;
      const block = repeated || (cold && list.length >= 1);
      save();
      return {
        counted: true,
        block,
        strikes: list.length,
        reason: block
          ? (repeated ? `窗口内 ${list.length} 次辱骂/攻击` : `好感跌到 ${Math.round(Number(affection))} 且仍有攻击`)
          : ''
      };
    },
    clearStrikes(qq) {
      const id = String(qq ?? '').trim();
      if (!state.autoHits[id]) return;
      delete state.autoHits[id];
      save();
    }
  };
}

/**
 * 自行拉黑计数闸：只有确实指向她的消息才计入 strike。
 * 背景聊天里骂别人、泛吐槽都不算；私聊天然算（addressedTo 为 self）。
 */
export function shouldCountBlacklistStrike({ addressedTo = '', isOwner = false } = {}) {
  if (isOwner) return false;
  return String(addressedTo) === 'self';
}

/**
 * 主人命令（纯解析，不碰状态）：
 *   拉黑 123456 [原因] / 以后别理 123456 / 别再理 123456
 *   解封 123456 / 可以理 123456 了 / 解除拉黑 123456
 *   黑名单 / 拉黑名单
 * 返回 { action: 'block'|'unblock'|'list', qq?, reason? } 或 null。
 */
export function parseBlacklistCommand(text) {
  const raw = String(text ?? '').trim();
  if (!raw) return null;
  if (/^(?:看看)?(?:黑名单|拉黑名单)$/.test(raw) || /^黑名单$/.test(raw)) return { action: 'list' };
  const unblock = raw.match(/^(?:解封|解除拉黑|可以理(?:他|她)?了?|恢复理(?:他|她)?)\s*(\d{5,12})?/);
  if (unblock) return { action: 'unblock', qq: unblock[1] || '' };
  const block = raw.match(/^(?:拉黑|以后(?:别|不要)理|别再理|不要理|不想理)\s*(\d{5,12})(?:\s+(.+))?$/);
  if (block) return { action: 'block', qq: block[1], reason: clean(block[2], 120) };
  return null;
}

// ── 自然语言主人指令（naturalLanguage.enabled）─────────────────────────────
// 分工：触发闸只负责「值不值得花一次 LLM」，真正的意图理解交给内心会话；
// 名字→QQ 的解析是纯函数，歧义/找不到一律反问，绝不猜拉。

// 宽松触发闸：命中只说明「像在说拉黑/解封/名单」，不代表一定是指令。
export function looksLikeBlacklistTalk(text, { hasAt = false } = {}) {
  const raw = String(text ?? '');
  if (!raw.trim()) return false;
  if (/拉黑|黑名单|小黑屋|屏蔽|名单/.test(raw)) return true;
  if (/(?:别|不要|不想|不许|别再|不再|懒得|不|以后别|以后不要|以后不想)理|(?:别|不要|不想|不许)搭理|(?:别|不要|不想)回复|(?:别|不要)回(?:他|她|它)/.test(raw)) return true;
  if (/解封|解除|取消拉黑|可以理|恢复理|放出来|原谅/.test(raw)) return true;
  if (hasAt && /别|不要|不想|不许|以后|停止|拉黑|屏蔽/.test(raw)) return true;
  return false;
}

// LLM 输出 → 结构化意图。任何不合法/不确定的输出一律归到 none（不动作）。
export function parseBlacklistIntentOutput(raw) {
  const none = { action: 'none', targetRef: '', reason: '' };
  const text = String(raw ?? '').trim();
  if (!text) return none;
  const unfenced = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '');
  const start = unfenced.indexOf('{');
  const end = unfenced.lastIndexOf('}');
  if (start < 0 || end <= start) return none;
  let obj = null;
  try { obj = JSON.parse(unfenced.slice(start, end + 1)); } catch { return none; }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return none;
  if (!['block', 'unblock', 'list'].includes(obj.action)) return none;
  return { action: obj.action, targetRef: clean(obj.targetRef, 80), reason: clean(obj.reason, 120) };
}

const PROTECTED_OWNER_REF = /^(?:我|我自己|本人|主人|老板)$/;
const PROTECTED_SELF_REF = /^(?:你|你自己|您)$/;
const PRONOUN_REF = /^(?:他|她|它|这个人|这人|那人|这位|这家伙)$/;

/**
 * 把 LLM 抽出的 targetRef 解析成唯一 QQ。优先级：@ 的人 → 纯数字 QQ → 名字匹配
 * （最近发言人/关系成员）。候选按 QQ 去重；唯一命中才返回 ok。
 * 返回 { ok:true, qq, name, via } 或 { ok:false, error, candidates }：
 *   protected-owner / protected-self —— 指向主人或她自己，永不拉黑
 *   ambiguous —— 多个候选，反问主人
 *   not-found —— 没有候选（含 LLM 编造、原文/上下文里都不存在的 QQ），反问主人
 */
export function resolveBlacklistTarget({ targetRef, rawText = '', ats = [], speakers = [], members = [], ownerQQ = '', selfQQ = '', selfNames = [] } = {}) {
  const ref = clean(targetRef, 80).replace(/^@+/, '').trim();
  const norm = (value) => String(value ?? '').replace(/\s+/g, '').toLowerCase();
  const refNorm = norm(ref);
  const owner = String(ownerQQ ?? '').trim();
  const self = String(selfQQ ?? '').trim();
  if (PROTECTED_OWNER_REF.test(ref)) return { ok: false, error: 'protected-owner', candidates: [] };
  const selfNameSet = new Set((Array.isArray(selfNames) ? selfNames : []).map(norm).filter(Boolean));
  if (PROTECTED_SELF_REF.test(ref) || (refNorm && selfNameSet.has(refNorm))) return { ok: false, error: 'protected-self', candidates: [] };

  const pool = [];
  const seen = new Set();
  const push = (qq, name, via) => {
    const id = String(qq ?? '').trim();
    if (!QQ_RE.test(id) || seen.has(id)) return;
    seen.add(id);
    pool.push({ qq: id, name: clean(name, 40), via });
  };
  for (const item of Array.isArray(ats) ? ats : []) push(item?.qq, item?.name, 'at');
  for (const item of Array.isArray(speakers) ? speakers : []) push(item?.qq, item?.name, 'name');
  for (const item of Array.isArray(members) ? members : []) push(item?.qq, item?.name, 'name');

  const finish = (hit) => {
    if (owner && hit.qq === owner) return { ok: false, error: 'protected-owner', candidates: [] };
    if (self && hit.qq === self) return { ok: false, error: 'protected-self', candidates: [] };
    return { ok: true, qq: hit.qq, name: hit.name, via: hit.via };
  };

  if (!ref || PRONOUN_REF.test(ref)) {
    const atPool = pool.filter((item) => item.via === 'at');
    if (atPool.length === 1) return finish(atPool[0]);
    if (atPool.length > 1) return { ok: false, error: 'ambiguous', candidates: atPool };
    return { ok: false, error: 'not-found', candidates: [] };
  }
  if (QQ_RE.test(ref)) {
    // 反幻觉闸：数字 QQ 必须真的出现在主人原话或会话上下文里，LLM 编的不认。
    const grounded = String(rawText ?? '').includes(ref) || pool.some((item) => item.qq === ref);
    if (!grounded) return { ok: false, error: 'not-found', candidates: [] };
    return finish(pool.find((item) => item.qq === ref) || { qq: ref, name: '', via: 'qq' });
  }
  const matches = pool.filter((item) => item.name && norm(item.name) === refNorm);
  if (matches.length === 1) return finish(matches[0]);
  if (matches.length > 1) return { ok: false, error: 'ambiguous', candidates: matches };
  return { ok: false, error: 'not-found', candidates: [] };
}