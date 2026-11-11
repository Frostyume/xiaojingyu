// 分享模块的任务提示词。每个模板只负责“说什么、按什么结构说”，
// 角色卡、群风格、时间/状态由 inner-life 的 buildBasePrompt 注入。

function historyLines(history, limit = 30) {
  return (Array.isArray(history) ? history : []).slice(0, limit).map((item, index) => {
    const title = String(item?.title || item?.topic || '').replace(/\s+/g, ' ').slice(0, 40);
    const cat = item?.facetLabel || item?.categoryLabel || '';
    return `${index + 1}. ${cat ? `[${cat}] ` : ''}${title}`;
  });
}

function recentTexts(history, limit = 6) {
  return (Array.isArray(history) ? history : []).slice(0, limit)
    .map((item) => `- ${String(item?.text || '').replace(/\s+/g, ' ').slice(0, 80)}`);
}

export function buildShareContextBlock({ history = [], recentChat = '', duplicateHint = '' } = {}) {
  const lines = historyLines(history);
  const texts = recentTexts(history);
  return [
    lines.length ? `【已经发过，不能重复】\n${lines.join('\n')}` : '',
    texts.length ? `【最近几期的原话（换个说法讲同一个点也算重复）】\n${texts.join('\n')}` : '',
    recentChat ? `【最近群里在聊】\n${recentChat}` : '',
    duplicateHint ? `【上一次内容重复】${duplicateHint}。这次必须换一个更具体的点。` : ''
  ].filter(Boolean).join('\n\n');
}

function commonRules({ audience, tone, minChars, maxChars, disclaimer, customInstruction }) {
  return [
    `- 正文 ${minChars}–${maxChars} 字，句子之间用“因为/所以/简单说/具体做法是/不过”这类连接，避免碎句，也不要一逗到底。`,
    `- 读者：${audience}`,
    `- 语气：${tone}`,
    '- 不写产品说明书、不列操作步骤；不喊口号、不吓唬人、不绝对化。',
    '- 不聊政治、宗教、医疗诊断、投资建议；举例不要提具体品牌。',
    '- 不用“我发现/我琢磨/我试过”，这是分享，不是个人体验。',
    disclaimer ? `- 结尾必须带免责声明：${disclaimer}` : '',
    customInstruction ? `- 额外要求：${customInstruction}` : ''
  ].filter(Boolean).join('\n');
}

function jsonHint(fields) {
  return `只输出一个 JSON 对象：${JSON.stringify(fields)}`;
}

function fmtDay(at) {
  const n = Number(at) || 0;
  if (!n) return '';
  const d = new Date(n);
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

/** 候选池（B站/RSS/S16/搜索）只在 source.mode 包含 pool 时注入。 */
function candidateBlock(candidates) {
  const list = (Array.isArray(candidates) ? candidates : []).slice(0, 6);
  if (!list.length) return '';
  const lines = list.map((item, index) => {
    const meta = [item.sourceLabel || item.source || '', fmtDay(item.publishedAt)].filter(Boolean).join(' · ');
    const summary = String(item.summary || '').replace(/\s+/g, ' ').slice(0, 80);
    return `${index + 1}. ${meta ? `[${meta}] ` : ''}${String(item.title || '').slice(0, 60)}${summary ? ` — ${summary}` : ''}\n   ${item.url || ''}`;
  });
  return `【可以当素材的候选】（真实抓取，只在其中选，不要编造候选之外的事实）\n${lines.join('\n')}\n如果采用某条候选，正文最后必须单独一行原样写上它的链接（不要改写成短链或省略），否则这条分享会被判为无效。`;
}

// 非科普/金融模板共用的口吻约束：像本人随手分享，不强制固定开场词、不套模板腔。
const CASUAL_SHARE_RULE = '- 语气像本人随手分享：自然开头，不要刻意用「诶/唔/呀/啦/呜」这类语气词起手，也不要套固定模板腔或「这说明/意味着/整体来看」的评论员句式。';

export function buildShareTask({ module, facet, history = [], recentChat = '', duplicateHint = '', category = null, candidates = [], fixHint = '' } = {}) {
  const template = String(facet?.template || module?.template || 'custom');
  const content = { ...(module?.content || {}), ...(facet?.content || {}) };
  const audience = String(content.audience || '完全不懂这个领域的长辈');
  const tone = String(content.tone || '通俗、自然、不夸大');
  const categoryLabel = category?.label ? `【这一期方向】${category.label}：${category.hint || ''}` : '';
  const context = buildShareContextBlock({ history, recentChat, duplicateHint });
  const fixBlock = fixHint ? `【上一版的问题】${fixHint}。这一版必须改掉，其他要求不变。` : '';
  const titleRule = String(content.titleRule || '');

  if (template === 'knowledge' || template === 'finance') {
    const isFinance = template === 'finance';
    const min = Math.max(80, Number(content.minChars) || (isFinance ? 180 : 180));
    const max = Math.max(min, Number(content.maxChars) || (isFinance ? 360 : 320));
    return [
      isFinance
        ? '你在群里做一期金融常识分享，讲给完全不懂金融的人听。只讲机制和常识，不做任何投资建议。'
        : '你在群里做一期知识分享，把一个概念/技术讲明白、讲透一点，不是讲你自己的发现。',
      categoryLabel,
      `正文必须包含：一个具体的生活现象或例子 → 点名主题/技术并用一句话说明它是什么 → 至少解释 2 个关键术语 → 说清大概怎么做/怎么发生 → 最后讲边界、代价或为什么有时不准。`,
      '写作要求：',
      commonRules({ audience, tone, minChars: min, maxChars: max, disclaimer: content.disclaimer, customInstruction: content.customInstruction }),
      titleRule ? `- 标题：${titleRule}` : '- 标题要具体、准确，避免“它/这”指代不明。',
      `- 给出 techName（主题/技术名，20 字内）、terms（2 个术语 + 一句大白话解释）。`,
      isFinance ? '- riskNote：一句风险提示，例如“以上只是常识科普，不构成投资建议”。' : '',
      `- keyTerm/searchQuery：检索关键词，优先英文术语/缩写；searchQuery 以英文词开头再接中文。`,
      fixBlock,
      context,
      jsonHint({
        title: '标题',
        techName: '主题/技术名',
        phenomenon: '现象',
        tech: '主题一句话',
        how: '核心做法',
        terms: [{ name: '术语', plain: '大白话解释' }],
        text: '正文',
        riskNote: isFinance ? '风险提示' : undefined,
        keyTerm: '检索词',
        searchQuery: '检索 query'
      })
    ].filter(Boolean).join('\n\n');
  }

  if (template === 'news') {
    return [
      '你在群里分享一条已经确认的资讯/赛果，不是评论，不要编造细节。',
      categoryLabel,
      `- 标题要具体；正文说清“发生了什么、为什么重要/影响什么”。`,
      `- 必须给出时间（精确到日期/北京时间）和来源链接 sourceUrl（只写真实链接）。`,
      `- 读者：${audience}；语气：${tone}。`,
      CASUAL_SHARE_RULE,
      '- 如果信息不足或无法确认，输出 {"skip":true}，不要硬写。',
      candidateBlock(candidates),
      fixBlock,
      context,
      jsonHint({ title: '标题', text: '正文', time: '日期/北京时间', sourceUrl: '真实链接', keyTerm: '检索词' })
    ].filter(Boolean).join('\n\n');
  }

  if (template === 'fun') {
    const min = Math.max(10, Number(content.minChars) || 15);
    const max = Math.max(min, Number(content.maxChars) || 160);
    return [
      '你在群里分享一件有趣的小事/轶事/冷知识，像聊天时顺手说出来，不要写科普长文。',
      categoryLabel,
      `- 正文 ${min}–${max} 字，1–4 句；先给具体的点，再补一句你自己的反应或感受。`,
      `- 读者：${audience}；语气：${tone}。`,
      CASUAL_SHARE_RULE,
      '- 不编造亲历，不要标题党，不堆网络黑话。',
      candidateBlock(candidates),
      fixBlock,
      context,
      jsonHint({ text: '正文', keyTerm: '检索词', sourceUrl: candidates.length ? '采用的候选链接' : undefined })
    ].filter(Boolean).join('\n\n');
  }

  if (template === 'curated') {
    return [
      '你在群里推荐一篇值得读的文章，先说你为什么觉得它值得看，再给真实链接。',
      categoryLabel,
      `- 正文 30–${Number(content.maxChars) || 240} 字；不要复述全文，给一个具体理由。`,
      CASUAL_SHARE_RULE,
      '- 只使用真实存在的链接；不确定就不要推。',
      fixBlock,
      context,
      jsonHint({ title: '文章标题', text: '推荐理由', url: '真实链接', keyTerm: '检索词' })
    ].filter(Boolean).join('\n\n');
  }

  if (template === 'story') {
    return [
      '你在群里讲一个真实的历史/人物/里程碑故事，事实必须准确。',
      categoryLabel,
      `- 正文 80–${Number(content.maxChars) || 600} 字，讲清时间、人物、发生了什么、为什么重要。`,
      CASUAL_SHARE_RULE,
      '- 必须给出来源链接 sourceUrl；拿不准的年份/细节不要写。',
      fixBlock,
      context,
      jsonHint({ title: '标题', text: '正文', sourceUrl: '真实链接', keyTerm: '检索词' })
    ].filter(Boolean).join('\n\n');
  }

  if (template === 'practical') {
    return [
      '你在群里分享一个实用小技巧/避坑经验，步骤要能照着做。',
      categoryLabel,
      `- 正文 60–${Number(content.maxChars) || 500} 字；可以分 2–4 步，但不要写成产品说明书。`,
      CASUAL_SHARE_RULE,
      '- 说明适用条件和注意事项 caveat；不夸大效果。',
      fixBlock,
      context,
      jsonHint({ title: '标题', text: '正文', caveat: '注意事项', keyTerm: '检索词' })
    ].filter(Boolean).join('\n\n');
  }

  if (template === 'data') {
    return [
      '你在群里解读一组数据/趋势，数字必须带时间和来源。',
      categoryLabel,
      `- 正文 60–${Number(content.maxChars) || 500} 字：数字是什么、从哪来、说明什么、不要过度外推。`,
      CASUAL_SHARE_RULE,
      '- 必须给出来源链接 sourceUrl；没有可靠数据就输出 {"skip":true}。',
      fixBlock,
      context,
      jsonHint({ title: '标题', text: '正文', sourceUrl: '真实链接', keyTerm: '检索词' })
    ].filter(Boolean).join('\n\n');
  }

  const min = Math.max(20, Number(content.minChars) || 40);
  const max = Math.max(min, Number(content.maxChars) || 500);
  return [
    '你在群里分享一期内容，按下面的要求写。',
    categoryLabel,
    commonRules({ audience, tone, minChars: min, maxChars: max, disclaimer: content.disclaimer, customInstruction: content.customInstruction }),
    CASUAL_SHARE_RULE,
    candidateBlock(candidates),
    fixBlock,
    context,
    jsonHint({ title: '标题', text: '正文', keyTerm: '检索词' })
  ].filter(Boolean).join('\n\n');
}
