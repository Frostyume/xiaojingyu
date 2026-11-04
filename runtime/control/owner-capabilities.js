// 主人私聊可调用的能力清单。只描述能力，不执行任何动作。
// 新功能开发以这里为单一事实源：Agent 先查表，再决定“现成可配 / 需要配置 / 需要写代码”。

export const OWNER_CAPABILITIES = [
  {
    id: 'share_module',
    label: '分享模块',
    kind: 'config',
    status: 'ready',
    description: '按模板/facet 定时分享到群，一条一个主题，自带去重、图、链接、验证期。',
    tools: ['qq_share_module_create', 'qq_share_module_update', 'qq_share_module_preview', 'qq_share_module_verify'],
    targets: ['group'],
    preview: 'module'
  },
  {
    id: 'scheduled_message',
    label: '定时消息/提醒',
    kind: 'config',
    status: 'ready',
    description: '在指定时间、指定群/私聊发送固定文本；可每天重复或只发一次。',
    tools: ['qq_feature_create', 'qq_feature_preview'],
    targets: ['group', 'private'],
    preview: 'message'
  },
  {
    id: 'auto_reply',
    label: '自动回复',
    kind: 'config',
    status: 'ready',
    description: '命中关键词/正则时用固定文本回复；不命中就走原来的聊天流程。',
    tools: ['qq_feature_create', 'qq_feature_preview'],
    targets: ['group', 'private'],
    preview: 'message'
  },
  {
    id: 'voice_message',
    label: '语音消息',
    kind: 'config',
    status: 'ready',
    description: '定时或命中时发一条中文语音，沿用现有 Breeze 声线与 mood 表演。',
    tools: ['qq_feature_create', 'qq_feature_preview'],
    targets: ['group', 'private'],
    preview: 'voice'
  },
  {
    id: 'qzone_post',
    label: '空间说说',
    kind: 'config',
    status: 'ready',
    description: '定时发一条 QQ 空间说说，可带图；发布前可要求确认。',
    tools: ['qq_feature_create', 'qq_feature_preview'],
    targets: ['qzone'],
    preview: 'qzone'
  },
  {
    id: 'reminder',
    label: '一次性提醒',
    kind: 'config',
    status: 'ready',
    description: '指定日期时间提醒一次；复用现有提醒系统。',
    tools: ['qq_add_reminder', 'qq_list_reminders', 'qq_cancel_reminder'],
    targets: ['group', 'private'],
    preview: 'message'
  },
  {
    id: 'signature',
    label: '个性签名',
    kind: 'config',
    status: 'ready',
    description: '改签名或恢复自动更新。',
    tools: ['qq_owner_admin'],
    targets: ['self'],
    preview: 'text'
  },
  {
    id: 'voice_style',
    label: '声线/语气',
    kind: 'config',
    status: 'ready',
    description: '柔和/冷傲/自动声线；单句 mood 表演。',
    tools: ['qq_owner_admin', 'qq_speak'],
    targets: ['self'],
    preview: 'voice'
  },
  {
    id: 'mood_state',
    label: '心情状态',
    kind: 'config',
    status: 'ready',
    description: '查看/记录心情事件。',
    tools: ['qq_mood_nudge', 'qq_owner_admin'],
    targets: ['self'],
    preview: 'text'
  },
  {
    id: 'code_feature',
    label: '需要新代码的功能',
    kind: 'code',
    status: 'planned',
    description: '现有能力组合不出来时，生成规格/diff 提案，在隔离分支实现、测试、二次确认后合并。',
    tools: ['qq_feature_propose_code'],
    targets: ['self'],
    preview: 'proposal'
  },
  {
    id: 'code_propose',
    label: '缺陷/改进提案',
    kind: 'code',
    status: 'ready',
    description: '功能有缺陷/行为不对（如语音结尾截断）、要改进，或要新增功能时，用自然语言描述现状与期望，生成提案与计划并排入主控待办；不会自行开发或合并。',
    tools: ['qq_code_propose'],
    targets: ['self'],
    preview: 'proposal',
    example: {
      tool: 'qq_code_propose',
      args: {
        title: '语音结尾截断',
        symptom: '语音最后半句被吞掉，结尾总是少一两个字',
        expected: '整句完整播放，结尾不被截断'
      }
    }
  }
];

export function listOwnerCapabilities() {
  return OWNER_CAPABILITIES.map((item) => ({
    id: item.id,
    label: item.label,
    kind: item.kind,
    status: item.status,
    description: item.description,
    tools: item.tools,
    targets: item.targets,
    ...(item.example ? { example: item.example } : {})
  }));
}

export function capabilityById(id) {
  return OWNER_CAPABILITIES.find((item) => item.id === String(id || '')) || null;
}
