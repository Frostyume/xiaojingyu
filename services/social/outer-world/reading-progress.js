// 她在读：从读书/字幕进度生成实时页数据（纯函数，不读写状态文件）。
//
// chapterIndex 语义：下一次要读的章节下标（0 基）。读完第 1 章后值为 1，
// 所以章节来源的完成度口径是 completed = min(chapterIndex, chaptersTotal)。

const toInt = (value, fallback = 0) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : fallback;
};

const clampPercent = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
};

export function readingPercent({ totalChars, charOffset, chapterIndex, chaptersTotal, done } = {}) {
  if (done === true) return 100;
  const total = toInt(totalChars);
  if (total > 0) return clampPercent((toInt(charOffset) / total) * 100);
  const chapters = toInt(chaptersTotal);
  if (chapters > 0) return clampPercent((Math.min(chapters, toInt(chapterIndex)) / chapters) * 100);
  return null;
}

export function buildReadingSnapshot({ sources = [], progress = {}, now = Date.now() } = {}) {
  const at = Number(now) || 0;
  const items = [];
  for (const source of Array.isArray(sources) ? sources : []) {
    const id = String(source?.id || '').trim();
    if (!id) continue;
    const row = progress && typeof progress === 'object' ? progress[id] : null;
    if (!row || typeof row !== 'object') continue;
    const chaptersTotal = Math.max(toInt(source.chapters?.length), toInt(row.chaptersTotal));
    const totalChars = toInt(row.totalChars);
    const charOffset = toInt(row.charOffset);
    const chapterIndex = toInt(row.chapterIndex);
    const done = row.done === true;
    const percent = readingPercent({ totalChars, charOffset, chapterIndex, chaptersTotal, done });
    const title = String(row.title || source.title || '未命名').trim().slice(0, 80);
    items.push({
      id,
      title,
      kind: source.type === 'video' ? 'video' : 'book',
      chapterIndex,
      chaptersTotal,
      charOffset,
      totalChars: totalChars > 0 ? totalChars : null,
      percent,
      lastReadAt: toInt(row.lastReadAt),
      done,
      ...(percent === null ? { note: '进度待下次阅读后补齐' } : {})
    });
  }
  // 最近读的排前面；时间相同按标题稳定排序，方便前端和单测复现。
  items.sort((a, b) => (b.lastReadAt - a.lastReadAt) || a.title.localeCompare(b.title));
  return items;
}

// 见闻笔记 → 实时页只读摘要。quote 在消化层已逐字校验出自原文，这里只做截断，不改写。
export function outerNotesSnapshot(notes, { limit = 6 } = {}) {
  const cap = Math.max(1, Math.min(20, toInt(limit, 6) || 6));
  const rows = [];
  for (const note of Array.isArray(notes) ? notes : []) {
    if (!note || typeof note !== 'object') continue;
    const title = String(note.title || '').trim().slice(0, 80);
    const summary = String(note.summary || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    const quote = String(note.quote || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    if (!title && !summary && !quote) continue;
    rows.push({
      id: String(note.id || '').slice(0, 12),
      title,
      sourceId: String(note.sourceId || ''),
      sourceType: note.sourceType === 'video' ? 'video' : 'book',
      chapterIndex: toInt(note.chapterIndex),
      summary,
      quote,
      sourceHost: String(note.sourceHost || '').slice(0, 60),
      at: toInt(note.at)
    });
    if (rows.length >= cap) break;
  }
  return rows;
}

// 给「她在读」条目挂上她最新读到的那段：取该来源最近一条笔记的原文摘句/摘要。
// 没有笔记就不挂 excerpt，前端显示「还没有摘录」，绝不编造内容。
export function attachReadingExcerpts(items, notes) {
  const latest = new Map();
  for (const note of Array.isArray(notes) ? notes : []) {
    const sourceId = String(note?.sourceId || '');
    if (!sourceId) continue;
    const prev = latest.get(sourceId);
    if (!prev || toInt(note.at) >= toInt(prev.at)) latest.set(sourceId, note);
  }
  return (Array.isArray(items) ? items : []).map((item) => {
    const note = latest.get(String(item?.id || ''));
    if (!note) return item;
    const quote = String(note.quote || '').replace(/\s+/g, ' ').trim().slice(0, 160);
    const summary = String(note.summary || '').replace(/\s+/g, ' ').trim().slice(0, 200);
    if (!quote && !summary) return item;
    return {
      ...item,
      excerpt: {
        quote,
        summary,
        title: String(note.title || '').trim().slice(0, 80),
        chapterIndex: toInt(note.chapterIndex),
        sourceHost: String(note.sourceHost || '').slice(0, 60),
        at: toInt(note.at)
      }
    };
  });
}

export function readingToday(quota = {}) {
  const q = quota && typeof quota === 'object' && !Array.isArray(quota) ? quota : {};
  const items = toInt(q.items);
  const chars = toInt(q.chars);
  return {
    day: String(q.day || ''),
    items,
    chars,
    tokens: toInt(q.tokens),
    charsKnown: chars > 0
  };
}
