// 按需手册的首次调用闸门。
//
// 手册是按关键词/唤醒原因**预选**的，模型不一定会加载它就直接调工具；
// 一旦参数记错，轻则白调一次，重则把语音/表情/记忆写坏。这里在 MCP 工具入口做一次
// 一次性拦截：某个手册在本会话里还没注入过，第一次调用相关工具时先返回手册正文，
// 让模型读完重试；同一会话同一手册只拦一次，不会把正常聊天卡死。
//
// 分工：
//   · bridge 在每轮 wake prompt 里注入 1~2 篇，并通过 /api/simulation/prompt-injected
//     记录到桥接；闸门先查这份记录，已经注入过就不再拦。
//   · 闸门自己的「已加载」按 MCP 进程 + 会话 key 记忆，桥接重启/记录丢失时仍只多拦一次。
//
// 策略：
//   · block    —— 有副作用的工具（发图/发语音/写记忆/主人操作），必须先看手册，直接拦。
//   · annotate —— 高频只读或发送类工具，不拦住调用，但把手册挂在这次返回结果前面。

export const TOOL_PLAYBOOKS = Object.freeze({
  // 媒体：看图、表情、图片库
  qq_get_message_images: 'media',
  qq_get_forward_msg: 'media',
  qq_list_stickers: 'media',
  qq_get_sticker_image: 'media',
  qq_send_sticker: 'media',
  qq_collect_sticker: 'media',
  qq_sticker_note: 'media',
  qq_set_sticker_remark: 'media',
  qq_delete_sticker: 'media',
  qq_list_images: 'media',
  qq_send_image: 'media',
  qq_save_image: 'media',
  qq_delete_image: 'media',
  qq_get_self_image: 'media',
  // 语音
  qq_send_voice: 'voice',
  qq_list_voices: 'voice',
  qq_speak: 'voice',
  // 提醒/天气/小游戏
  qq_add_reminder: 'life',
  qq_list_reminders: 'life',
  qq_cancel_reminder: 'life',
  qq_weather: 'life',
  qq_play_game: 'life',
  // 记忆
  qq_memory_append: 'memory',
  qq_memory_query: 'memory',
  qq_memory_remove: 'memory',
  qq_memory_clear: 'memory',
  // 黑话
  qq_slang_query: 'slang',
  qq_slang_submit: 'slang',
  // 主人控制台
  qq_owner_admin: 'owner',
  qq_post_qzone: 'owner',
  qq_mood_nudge: 'owner',
  qq_share_module_list: 'owner',
  qq_share_module_create: 'owner',
  qq_share_module_update: 'owner',
  qq_share_module_pause: 'owner',
  qq_share_module_verify: 'owner',
  qq_share_module_preview: 'owner',
  qq_share_module_draft: 'owner',
  qq_share_module_delete: 'owner',
  qq_share_module_publish: 'owner',
  qq_capabilities_list: 'owner',
  qq_feature_list: 'owner',
  qq_feature_preview: 'owner',
  qq_feature_apply: 'owner',
  qq_config_list: 'owner',
  qq_config_get: 'owner',
  qq_config_set: 'owner',
  qq_code_propose: 'owner',
  qq_feature_code_status: 'owner',
  qq_feature_code_merge: 'owner',
  qq_feature_code_reject: 'owner',
  qq_feature_control: 'owner',
  // 等待与发送：手册挂在结果前，不拦住动作
  qq_wait_for_messages: 'wait',
  qq_reply: 'messaging',
  qq_send_burst: 'messaging',
  qq_send_message: 'messaging',
  qq_send_group_message: 'messaging',
  qq_send_private_message: 'messaging',
  qq_send_poke: 'messaging'
});

// 这些手册只做附注，不拦截；其余一律「先读手册再调用」。
export const ANNOTATE_ONLY = Object.freeze(new Set(['wait', 'messaging']));

export function resolveToolPlaybook(tool) {
  const id = TOOL_PLAYBOOKS[String(tool ?? '')];
  if (!id) return null;
  return { id, mode: ANNOTATE_ONLY.has(id) ? 'annotate' : 'block' };
}

/**
 * @param {object} opts
 * @param {(id: string) => Promise<{title?: string, text?: string}|null>|{title?: string, text?: string}|null} opts.load
 * @param {(args: {key: string, token?: string}) => Promise<string[]>} [opts.injected] 桥接本轮已注入的手册
 * @param {boolean} [opts.enabled=true]
 * @param {() => number} [opts.now]
 * @param {number} [opts.ttlMs]
 */
export function createPlaybookGate({
  load,
  injected = null,
  enabled = true,
  now = () => Date.now(),
  ttlMs = 6 * 3600 * 1000
} = {}) {
  if (typeof load !== 'function') throw new Error('playbook gate 需要 load 函数');
  const sessions = new Map();

  function stateOf(key) {
    const at = now();
    let record = sessions.get(key);
    if (!record || at - record.at > ttlMs) {
      record = { at, ids: new Set() };
      sessions.set(key, record);
    } else {
      record.at = at;
    }
    return record;
  }

  return {
    async check({ tool = '', key = '', token = '' } = {}) {
      if (!enabled) return null;
      const entry = resolveToolPlaybook(tool);
      if (!entry) return null;
      const sessionKey = String(key ?? '').trim();
      // 没带会话 key 的旧工具无法判断范围，宁可不拦。
      if (!sessionKey) return null;
      const record = stateOf(sessionKey);
      if (record.ids.has(entry.id)) return null;

      if (typeof injected === 'function') {
        try {
          const ids = await injected({ key: sessionKey, token });
          if (Array.isArray(ids) && ids.includes(entry.id)) {
            record.ids.add(entry.id);
            return null;
          }
        } catch { /* 桥接不可达时退回本地注入 */ }
      }

      let playbook = null;
      try { playbook = await load(entry.id); } catch { playbook = null; }
      // 先记为已处理：即使手册读取失败，也不让同一会话反复被同一条拦住。
      record.ids.add(entry.id);
      if (!playbook?.text) return null;
      return {
        tool: String(tool),
        id: entry.id,
        mode: entry.mode,
        title: playbook.title || entry.id,
        text: String(playbook.text)
      };
    },
    reset() { sessions.clear(); }
  };
}

export function formatGateResult(gate) {
  return {
    isError: true,
    content: [{
      type: 'text',
      text: `【按需手册｜${gate.title}】这是本会话第一次使用 ${gate.tool}，按约定先读流程再调用（已在本地自动加载，读完原样重试这次调用即可，不会重复出现）。\n\n${gate.text}`
    }]
  };
}

export function annotateWithGate(result, gate) {
  const prefix = {
    type: 'text',
    text: `【按需手册｜${gate.title}】首次使用 ${gate.tool} 的相关流程，附在本次结果前；后续调用不再重复。\n\n${gate.text}`
  };
  const content = Array.isArray(result?.content) ? result.content : [];
  return { ...result, content: [prefix, ...content] };
}