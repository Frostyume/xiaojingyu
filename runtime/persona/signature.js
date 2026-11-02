// 自动个性签名：根据心情/精力/兴趣/时段生成一句有内容的签名。
//
// 约束：
//   · 不调用模型，零 token；
//   · 不重复最近用过的签名；
//   · 只改 QQ 资料里的 personal_note，不动昵称、不发群消息；
//   · 文本末尾不留中文句号；超长截断。

const MAX_DEFAULT = 40;
const HISTORY_MAX = 20;
const MIN_CHARS = 22;

const TEMPLATES = Object.freeze({
  bright: [
    '今天精神不错，水里游了两圈，回来继续接大家的话，谁有话题都可以抛过来',
    '刚晒过太阳，心情亮亮的，今天想多聊几句，别嫌我话多就好',
    '电量满格，谁来都能接住，今天适合热闹一点，也适合认真听人说话',
    '水温刚好，脑子也清醒，今天说话会多一点，但不会抢别人的话头',
    '有件小事让我高兴了半天，想分你一点好心情，今天看什么都顺眼',
    '今天状态挺好，慢慢游着，等你们把话题抛过来，我接着就好',
    '冒个泡，今天精神足，想听大家多讲几句，也想去凑个热闹',
    '阳光正好，尾巴也轻快，今天不打算潜水，遇到有意思的就接一句'
  ],
  calm: [
    '慢慢游，慢慢想，今天也不急着给答案，事情一件一件来就好',
    '在水里发一会儿呆，偶尔冒个泡证明我还在，想聊就叫一声',
    '今天安静听大家说话，想到什么再接一句，不想抢别人的话头',
    '水面很平，适合把听到的故事慢慢理一理，理清楚了再讲给你',
    '不急，事情一件一件来，话也一句一句说，今天想把节奏放慢',
    '安静待着，但不妨碍接梗，想聊就叫我，我一直在水边听着',
    '今天话不多，耳朵一直开着，慢慢来就好，不用急着找话题',
    '在整理最近听到的零碎，攒够了再讲给你，现在先安静游一会儿'
  ],
  low: [
    '今天电量不太够，说话会慢一点，但你说的话我都在听，听到会回',
    '有点困，先缩在浅水区，有急事就戳我一下，缓过来我就冒泡',
    '状态一般，脑子转得慢，但不妨碍听你说，重要的事不会漏掉',
    '给自己放个慢速档，急事请多等我一会儿，缓过来就正常说话',
    '水里很安静，适合缩着，等缓过来再冒泡，不是不理你',
    '今天慢半拍，别催我，重要的事不会忘，只是回得没那么快',
    '没力气说漂亮话，但你说的话我都记着，等我缓过来再慢慢聊',
    '先躺一会儿，尾巴都懒得摇，晚点再聊，今天想把自己调成静音'
  ],
  late: [
    '夜里安静，适合想事情，也适合小声聊天，不用急着把话说完',
    '这个点还没睡，慢慢游着，等困意自己来，顺便看看还有谁醒着',
    '夜深了，声音放轻一点，别把水面吵醒，有什么话慢慢说',
    '半夜的水面很亮，适合把没想完的事想完，想不完就留到明天',
    '睡不着，出来冒个泡，顺便看看还有谁醒着，没人的话就继续游',
    '夜里的问题先记下，白天脑子清楚了再答，晚上不钻牛角尖',
    '灯关了，脑子还亮着，慢慢游一会儿就睡，明天再接着想',
    '这个点适合说点真心话，说完就去睡，不留到第二天反悔'
  ],
  interest: [
    '最近被{topic}勾住了，明明想偷懒，脑子却一直往那边跑',
    '{topic}比想象中有意思，我嘴上说随便看看，结果看了半天',
    '在琢磨{topic}，琢磨不明白就先吃饭，吃完接着琢磨',
    '把{topic}记在小本子上，省得哪天又假装自己没上头',
    '最近总在想{topic}，想得太入神，尾巴都忘了摇',
    '{topic}有点上头，我本来真的只想瞄一眼的',
    '这两天在啃{topic}，啃不动就先放一放，不硬撑',
    '脑子里装着{topic}，游着游着走神了，回来还在想'
  ],
  identity: [
    '今天也没干什么正事，米饭倒是认真吃了，尾巴先晃两下',
    '懒得解释，鲸鱼尾巴藏不住，心情也藏不太住',
    '嘴上说随便看看，尾巴已经先凑过去了，真拿它没办法',
    '摸鱼中，别问，问就是在思考鲸生，想到哪算哪',
    '今天先不较真，吃饭最大，别的事等吃完再说',
    '被说大肥鱼还是有点不服，但今天先不吵了，先记着',
    '事情有点多，先游一圈，回来再一件一件做，不着急',
    '状态不算满格，但尾巴还在，能慢慢来，不硬撑',
    '不太想说话，但尾巴还在晃，说明也没那么糟',
    '今天想懒一点，正事做完了，剩下的明天再说'
  ]
});

// 自定义角色没有「小鲸鱼」的身体和生活，签名用这套中性模板，避免串味。
const NEUTRAL_TEMPLATES = Object.freeze({
  bright: [
    '今天精神不错，想多说几句话，谁有话题都可以抛过来',
    '刚晒过太阳，心情亮亮的，今天想多聊几句，别嫌我话多就好',
    '电量满格，谁来都能接住，今天适合热闹一点，也适合认真听人说话',
    '今天状态挺好，慢慢来，等你们把话题抛过来，我接着就好',
    '有件小事让我高兴了半天，想分你一点好心情，今天看什么都顺眼',
    '今天话会多一点，但不会抢别人的话头，想聊随时开口',
    '心情挺轻快，今天不打算潜水，遇到有意思的就接一句',
    '状态在线，适合把攒着的话说开，也适合认真听人讲话'
  ],
  calm: [
    '慢慢来，慢慢想，今天也不急着给答案，事情一件一件来就好',
    '安静待着，偶尔说一句证明我还在，想聊就叫一声',
    '今天安静听大家说话，想到什么再接一句，不想抢别人的话头',
    '不急，事情一件一件来，话也一句一句说，今天想把节奏放慢',
    '今天话不多，耳朵一直开着，慢慢来就好，不用急着找话题',
    '在整理最近听到的零碎，攒够了再讲给你，现在先安静待一会儿',
    '今天适合把听到的故事慢慢理一理，理清楚了再讲给你',
    '安安静静也挺好，不妨碍接梗，想聊就叫我，我一直在'
  ],
  low: [
    '今天电量不太够，说话会慢一点，但你说的话我都在听',
    '有点困，先歇一会儿，有急事就戳我一下，缓过来我就回',
    '状态一般，脑子转得慢，但不妨碍听你说，重要的事不会漏掉',
    '给自己放个慢速档，急事请多等我一会儿，缓过来就正常说话',
    '今天慢半拍，别催我，重要的事不会忘，只是回得没那么快',
    '没力气说漂亮话，但你说的话我都记着，等我缓过来再慢慢聊',
    '先躺一会儿，晚点再聊，今天想把自己调成静音',
    '今天想少说两句，不是不理你，等缓过来再好好聊'
  ],
  late: [
    '夜里安静，适合想事情，也适合小声聊天，不用急着把话说完',
    '这个点还没睡，醒着，顺便看看还有谁醒着',
    '夜深了，声音放轻一点，有什么话慢慢说',
    '半夜很适合把没想完的事想完，想不完就留到明天',
    '睡不着，出来冒个泡，看看还有谁醒着，没人的话就继续待着',
    '夜里的问题先记下，白天脑子清楚了再答，晚上不钻牛角尖',
    '灯关了，脑子还亮着，过一会儿就睡，明天再接着想',
    '这个点适合说点真心话，说完就去睡，不留到第二天反悔'
  ]
});

function clean(text, maxChars) {
  let s = String(text ?? '').replace(/\s+/g, ' ').trim();
  s = s.replace(/[。．.]+$/u, '');
  if (s.length > maxChars) s = `${s.slice(0, Math.max(1, maxChars - 1))}…`;
  return s;
}

function cleanInstruction(text) {
  return String(text ?? '').replace(/\s+/g, ' ').trim().slice(0, 200);
}

const VOICE_RE = /尾巴|鲸鱼|米饭|摸鱼|懒|嘴硬|水里|游|饭/;
const VOICE_TAILS = ['，尾巴还在', '，摸鱼中', '，米饭要紧', '，懒得动', '，慢慢来嘛'];

/** 没有生活记号的签名补一个很短的尾巴，避免掉回通用签名。 */
function ensureVoice(text, seed, maxChars) {
  const value = clean(text, maxChars);
  if (!value || VOICE_RE.test(value)) return value;
  const tail = VOICE_TAILS[Math.abs(Number(seed) || 0) % VOICE_TAILS.length];
  const room = Math.max(4, maxChars - tail.length);
  return clean(`${clean(value, room)}${tail}`, maxChars);
}

function hourInShanghai(now) {
  return new Date(Number(now) + 8 * 3600 * 1000).getUTCHours();
}

export function generateSignature({
  persona = null,
  now = Date.now(),
  maxChars = MAX_DEFAULT,
  history = [],
  interests = [],
  roleName = ''
} = {}) {
  const state = persona?.state ?? persona ?? {};
  const mood = state.mood ?? {};
  const valence = Number.isFinite(Number(mood.valence)) ? Number(mood.valence) : 0.15;
  const energy = Number.isFinite(Number(state.energy)) ? Number(state.energy) : 0.6;
  const hour = hourInShanghai(now);
  const recent = new Set((Array.isArray(history) ? history : []).map((h) => clean(typeof h === 'string' ? h : h?.text, maxChars)));
  // 自定义角色不套用默认鲸鱼生活记号，整池换成中性模板。
  const customRole = Boolean(String(roleName || '').trim()) && String(roleName).trim() !== '小鲸鱼';
  const source = customRole ? NEUTRAL_TEMPLATES : TEMPLATES;
  const finish = (text, seed) => (customRole ? clean(text, maxChars) : ensureVoice(text, seed, maxChars));
  const pool = [];
  if (hour >= 23 || hour < 6) pool.push(...source.late);
  if (energy <= 0.35 || valence <= -0.25) pool.push(...source.low);
  else if (energy >= 0.7 || valence >= 0.4) pool.push(...source.bright);
  else pool.push(...source.calm);
  // 不论心情都混入一组“小鲸鱼本人”的生活签名；自定义角色不套用默认鲸鱼生活记号。
  if (!customRole) pool.push(...TEMPLATES.identity);
  // 心情普通时也混入 calm，避免只有一句
  if (!pool.length) pool.push(...source.calm);

  const topics = (Array.isArray(interests) && interests.length ? interests : (state.interests || []))
    .map((i) => String(typeof i === 'string' ? i : i?.topic ?? '').trim().slice(0, 12))
    .filter(Boolean);
  if (topics.length) {
    for (const t of topics.slice(0, 2)) {
      for (const tpl of TEMPLATES.interest) {
        const text = tpl.replace('{topic}', t);
        if (customRole && VOICE_RE.test(text)) continue;
        pool.push(text);
      }
    }
  }
  const candidates = [...new Set(pool.map((t) => clean(t, maxChars)).filter(Boolean))]
    .filter((t) => !recent.has(t));
  if (!candidates.length) {
    // 全用过时用「长句 + 短尾」组合，避免退化回几个字的短签名
    const tails = customRole
      ? ['，慢慢来就好', '，想到什么再补', '，今天也不急', '，先缓一缓再说']
      : ['，慢慢来就好', '，想到什么再补', '，今天也不急', '，先游一圈再说'];
    for (const base of source.calm) {
      for (const tail of tails) {
        const t = clean(`${base}${tail}`, maxChars);
        if (!recent.has(t)) return finish(t, now);
      }
    }
    return finish(source.calm[0], now);
  }
  // 优先 18 字以上；如果配置把上限压得很短，则至少不要选最短的那批。
  const minChars = Math.min(MIN_CHARS, maxChars);
  const preferred = candidates.filter((t) => t.length >= minChars);
  const usable = preferred.length
    ? preferred
    : (candidates.filter((t) => t.length >= Math.min(10, maxChars)).length
      ? candidates.filter((t) => t.length >= Math.min(10, maxChars))
      : candidates);
  // 用当天日期做稳定轮换：同一天多次预览不会跳来跳去
  const day = Math.floor(Number(now) / 86400000);
  return finish(usable[Math.abs(day + Math.floor(Number(now) / 3600000)) % usable.length], Math.floor(Number(now) / 3600000));
}

export function appendSignatureHistory(history, text, now = Date.now()) {
  const list = Array.isArray(history) ? history.slice() : [];
  list.push({ text: clean(text, 200), at: now });
  return list.slice(-HISTORY_MAX);
}

/** 两次更新之间的随机间隔：默认 8~24 小时，均匀分布。 */
export function randomSignatureIntervalMs(minHours = 8, maxHours = 24, { random = Math.random } = {}) {
  const min = Math.max(1, Number(minHours) || 8);
  const max = Math.max(min, Number(maxHours) || 24);
  const hours = min + Math.min(1, Math.max(0, Number(random()) || 0)) * (max - min);
  return Math.round(hours * 3600 * 1000);
}

/** 只保留最近 history 条；兼容旧格式字符串数组。 */
export function normalizeSignatureState(raw, now = Date.now()) {
  const obj = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const history = Array.isArray(obj.history)
    ? obj.history.map((h) => ({
      text: clean(typeof h === 'string' ? h : h?.text, 200),
      at: Number(typeof h === 'object' ? h?.at : 0) || 0
    })).filter((h) => h.text).slice(-HISTORY_MAX)
    : [];
  const pendingRaw = obj.pending && typeof obj.pending === 'object' && !Array.isArray(obj.pending) ? obj.pending : null;
  const pendingText = clean(pendingRaw?.text, 200);
  const pendingMessageId = String(pendingRaw?.messageId || '');
  const pendingMessageIds = Array.isArray(pendingRaw?.messageIds)
    ? pendingRaw.messageIds.map((id) => String(id || '')).filter(Boolean).slice(-5)
    : [];
  return {
    lastText: clean(obj.lastText ?? history.at(-1)?.text ?? '', 200),
    lastAppliedAt: Number(obj.lastAppliedAt) || 0,
    nextAt: Number(obj.nextAt) || 0,
    history,
    lastError: String(obj.lastError || '').slice(0, 300),
    pending: pendingText ? {
      text: pendingText,
      createdAt: Number(pendingRaw.createdAt) || 0,
      expiresAt: Number(pendingRaw.expiresAt) || 0,
      messageId: pendingMessageId,
      messageIds: pendingMessageIds.length ? pendingMessageIds : (pendingMessageId ? [pendingMessageId] : []),
      lastInstruction: cleanInstruction(pendingRaw.lastInstruction),
      lastInstructionText: clean(pendingRaw.lastInstructionText, 200),
      lastInstructionAt: Number(pendingRaw.lastInstructionAt) || 0
    } : null,
    updatedAt: Number(obj.updatedAt) || now
  };
}

/**
 * 只有显式的「改签名 …」或引用/回复签名草稿的消息，才允许改草稿。
 * 其余自由文本必须放行给正常对话，不能被签名流程吞掉。
 */
export function isSignatureAdjustCommand(command, pending, { replyToId = '', explicitOnly = false, qzonePending = false } = {}) {
  const text = String(command ?? '').trim();
  if (!text) return { ok: false, instruction: '' };
  const explicit = text.match(/^改签名(?:[\s:：,，]+([\s\S]+))?$/);
  if (explicit) {
    return { ok: true, instruction: cleanInstruction(explicit[1]) || '换一版，别和现在这版一样' };
  }
  if (explicitOnly || qzonePending) return { ok: false, instruction: '' };
  const ids = new Set([pending?.messageId, ...(Array.isArray(pending?.messageIds) ? pending.messageIds : [])]
    .map((id) => String(id || ''))
    .filter(Boolean));
  if (replyToId && ids.has(String(replyToId))) return { ok: true, instruction: cleanInstruction(text) };
  return { ok: false, instruction: '' };
}

/** 同一句修改指令对同一版草稿重复发送时不再生成新草稿（并发重试也覆盖）。 */
export function isDuplicateSignatureInstruction(pending, instruction) {
  const text = cleanInstruction(instruction);
  if (!text || !pending) return false;
  return text === cleanInstruction(pending.lastInstruction)
    && String(pending.text ?? '') === String(pending.lastInstructionText ?? '');
}
