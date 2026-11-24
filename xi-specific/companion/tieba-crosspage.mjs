// XI-NIGHT-ZCODE-20261119-01 项4:跨页续读聚合(纯函数)。把多次正式工具入口(tieba_thread/tieba_floor/
// tieba_replyme)返回的读取结果合并为去重视图,并如实产出可读范围。绝不发明未观测的楼层/页:
//   - 去重只按工具返回的 post_id/id:同 id 同文→合并来源页;同 id 异文→两变体均保留+冲突 gap(来源在两次读取间变化)。
//   - 未读页只报告"调用方未请求"的页号(从 requested/total_page 元数据推得);不推断服务器端缺页或折叠段
//     (参考样例无折叠字段——r6 ⑯ 纪律,缺证据声明为 gap)。
//   - 引用归属:replyme 的 quote_content 原样保留;作者若参考未暴露则保持 author:null+gap,不臆造。

const POST_ID = x => (x !== null && typeof x === 'object' && typeof x.id === 'string' ? x.id : null);

function variantOf(p) {
  return JSON.stringify({ t: p.text ?? p.content ?? null, a: p.author?.name ?? null, at: p.published_at ?? null, quote: p.quote_content ?? null, title: p.title ?? null });
}

function mergePostList(list, idKey = 'id') {
  const merged = []; const index = new Map(); let repeatedIds = 0, conflicts = 0;
  for (const p of list) {
    const pid = p && typeof p === 'object' && typeof p[idKey] === 'string' ? p[idKey] : null;
    if (pid === null) { merged.push({ ...p, merge_note: 'unidentifiable-id-kept-as-returned' }); continue; }
    const key = idKey === 'post_id' ? JSON.stringify([p.thread_id, pid]) : pid;
    const variants = index.get(key) ?? new Map();
    const signature = variantOf(p);
    const prev = variants.get(signature);
    const first = variants.values().next().value;
    if (!first) {
      const entry = { ...p, provenance: [...(p.provenance ?? [])] };
      merged.push(entry); variants.set(signature, entry); index.set(key, variants);
      continue;
    }
    repeatedIds += 1;
    if (prev) {
      for (const pv of (p.provenance ?? [])) if (!prev.provenance.includes(pv)) prev.provenance.push(pv);
    } else {
      conflicts += 1;
      const entry = { ...p, provenance: [...(p.provenance ?? [])], conflict_with_earlier_read: true };
      merged.push(entry); variants.set(signature, entry);
      if (!first.gaps?.includes('post-content-varied-between-reads')) first.gaps = [...(first.gaps ?? []), 'post-content-varied-between-reads'];
    }
  }
  return { merged, repeatedIds, conflicts };
}

// reads: [{operation, requested_page?, requested_parent_post_id?, page?: {current_page,total_page,has_more},
//          posts?: [...], sub_posts?: [...], entries?: [...], read_scope}]
export function mergeThreadReads(reads) {
  if (!Array.isArray(reads)) return { ok: false, reason: 'INVALID_INPUT' };
  const requestedPages = [];
  const flat = []; const replyEntries = []; const floorReads = [];
  for (const r of reads) {
    if (!r || typeof r !== 'object') return { ok: false, reason: 'INVALID_INPUT' };
    const reqPage = Number.isSafeInteger(r.requested_page) ? r.requested_page
      : (Number.isSafeInteger(r.read_scope?.requested_page) ? r.read_scope.requested_page : null);
    if (reqPage !== null) requestedPages.push(reqPage);
    if (r.operation === 'replyme') {
      for (const e of (r.entries ?? [])) replyEntries.push({ ...e, provenance: [`replyme:p${r.read_scope?.requested_page ?? '?'}`] });
      continue;
    }
    const pageTag = `page:${reqPage ?? '?'}`;
    if (r.first_floor && typeof r.first_floor === 'object' && r.first_floor.id !== undefined) flat.push({ ...r.first_floor, provenance: [pageTag] });
    for (const p of (r.posts ?? [])) flat.push({ ...p, provenance: [pageTag] });
    for (const p of (r.posts ?? [])) for (const s of (p.sub_posts ?? [])) flat.push({ ...s, provenance: [`sub-of:${p.id}@${pageTag}`] });
    if (r.operation === 'floor') {
      floorReads.push({ parent: r.requested_parent_post_id ?? r.read_scope?.requested_parent_post_id ?? null, returned: (r.posts ?? []).length });
    }
  }
  const { merged, repeatedIds, conflicts } = mergePostList(flat);
  // 未读页 = total_page 元数据覆盖、但调用方从未请求过的页号(仅凭已收到的页元数据,不猜服务器状态)
  let totalPages = null;
  for (const r of reads) if (Number.isSafeInteger(r.page?.total_page)) totalPages = Math.max(totalPages ?? 0, r.page.total_page);
  const unreadPages = totalPages
    ? Array.from({ length: totalPages }, (_, i) => i + 1).filter(p => !requestedPages.includes(p))
    : [];
  const reply = mergePostList(replyEntries, 'post_id');
  return {
    ok: true,
    posts: merged,
    replyme_entries: reply.merged,
    readable_range: {
      requested_pages: [...requestedPages].sort((a, b) => a - b),
      total_pages_observed: totalPages,
      unread_pages_by_metadata: unreadPages,
      returned_posts: merged.length,
      sub_post_reads: floorReads,
      next_page_pointers: reads.map(r => r.read_scope?.next_page ?? null),
    },
    dedup: { repeated_ids: repeatedIds, content_conflicts: conflicts, replyme_repeated_ids: reply.repeatedIds, replyme_conflicts: reply.conflicts },
    gaps: [
      ...(conflicts || reply.conflicts ? ['post-content-varied-between-reads'] : []),
      ...(unreadPages.length ? ['pages-not-requested-by-caller'] : []),
      'fold-or-server-side-gaps-not-detectable-from-reference-fields',
    ],
  };
}
