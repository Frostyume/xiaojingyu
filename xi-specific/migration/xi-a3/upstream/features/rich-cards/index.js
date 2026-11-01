// 富媒体卡片 feature：把 JSON/XML/音乐/分享段转成一行可读文本。
// 纯函数、无副作用；桥接主流程只调用 featureHost.formatSegment()。

import { formatRichSegment } from '../../runtime/persona/rich-card.js';

const RICH_TYPES = new Set(['json', 'xml', 'card', 'music', 'share']);

export default {
  id: 'rich-cards',
  name: '卡片解析',
  version: 1,
  description: '把 QQ 卡片/链接/音乐消息压成标题+摘要+链接，不透传原始 JSON/XML',
  permissions: [],
  hooks: {
    formatSegment(segment) {
      if (!segment || !RICH_TYPES.has(segment.type)) return null;
      return formatRichSegment(segment);
    }
  }
};
