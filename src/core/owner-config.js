// 私聊可读写的配置白名单。只暴露常用、低风险、可校验的键；
// 其他配置仍需控制台/代码流程。

function getPath(obj, path) {
  return String(path).split('.').reduce((cur, key) => (cur && typeof cur === 'object' ? cur[key] : undefined), obj);
}

function setPath(obj, path, value) {
  const keys = String(path).split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i += 1) {
    if (!cur[keys[i]] || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
}

const specs = [
  {
    key: 'qzone.maxPerDay', label: '说说每天上限', type: 'number', min: 0, max: 10, unit: '条',
    description: 'QQ 空间每天最多自动发几条'
  },
  {
    key: 'qzone.minGapMinutes', label: '说说最小间隔', type: 'number', min: 30, max: 1440, unit: '分钟',
    description: '两条说说之间至少隔多久', storedPath: 'socialV2.innerLife.qzone.minGapMs', fromStored: (v) => Math.round(Number(v) / 60000), toStored: (v) => Math.round(Number(v) * 60000)
  },
  {
    key: 'qzone.skipProbability', label: '说说跳过概率', type: 'number', min: 0, max: 0.9, unit: '',
    description: '每次到点时有多大比例选择不发'
  },
  {
    key: 'qzone.requireApproval', label: '说说先审后发', type: 'boolean',
    description: '开启后每条说说先私聊草稿审核'
  },
  {
    key: 'qzone.commentReply.maxPerDay', label: '评论回复每天上限', type: 'number', min: 0, max: 20, unit: '条',
    description: 'QQ 空间评论每天最多自动回几条'
  },
  {
    key: 'qzone.commentReply.mentionMaxPerDay', label: '@ 回复每天上限', type: 'number', min: 0, max: 20, unit: '条',
    description: '好友动态 @ 小鲸鱼每天最多回几条'
  },
  {
    key: 'qzone.commentReply.requireApproval', label: '评论回复先审后发', type: 'boolean',
    description: '开启后评论/@ 回复先私聊确认'
  },
  {
    key: 'signature.minIntervalHours', label: '签名最短间隔', type: 'number', min: 1, max: 168, unit: '小时',
    description: '自动更换签名最短间隔'
  },
  {
    key: 'signature.maxIntervalHours', label: '签名最长间隔', type: 'number', min: 1, max: 336, unit: '小时',
    description: '自动更换签名最长间隔'
  },
  {
    key: 'signature.requireApproval', label: '签名先审后换', type: 'boolean',
    description: '开启后新签名先私聊确认'
  },
  {
    key: 'voice.maxPerMinute', label: '语音每分钟上限', type: 'number', min: 1, max: 20, unit: '条',
    description: '每个会话每分钟最多发几条语音'
  },
  {
    key: 'voice.maxPerHour', label: '语音每小时上限', type: 'number', min: 1, max: 200, unit: '条',
    description: '每个会话每小时最多发几条语音'
  },
  {
    key: 'voice.maxSeconds', label: '语音最长时长', type: 'number', min: 1, max: 120, unit: '秒',
    description: '单条语音最长多少秒'
  },
  {
    key: 'tts.breeze.cfgScale', label: '语音 cfg 强度', type: 'number', min: 1, max: 8, unit: '',
    description: '越高越贴提示音色，越低越自然；改动后需要重启 DSH',
    restart: 'dsh'
  },
  {
    key: 'tts.breeze.darkValenceThreshold', label: '黑化触发心情', type: 'number', min: -1, max: 0, unit: '',
    description: 'valence 低于该值时自动黑化；改动后需要重启 DSH',
    restart: 'dsh'
  },
  {
    key: 'tts.breeze.darkRecoverValence', label: '黑化恢复心情', type: 'number', min: -1, max: 0.2, unit: '',
    description: 'valence 高于该值时恢复软萌；改动后需要重启 DSH',
    restart: 'dsh'
  },
  {
    key: 'dailyReport.enabled', label: '群日报开关', type: 'boolean',
    description: '每天定时发群日报'
  },
  {
    key: 'dailyReport.at', label: '群日报时间', type: 'time',
    description: '北京时间 HH:MM'
  },
  {
    key: 'share.maxPerDay', label: '主动分享每天上限', type: 'number', min: 0, max: 30, unit: '条',
    description: '好奇/生活分享每天最多几条', storedPath: 'socialV2.innerLife.groupShare.maxPerDay'
  },
  {
    key: 'share.minGapMinutes', label: '主动分享最小间隔', type: 'number', min: 10, max: 1440, unit: '分钟',
    description: '两次主动分享之间至少隔多久', storedPath: 'socialV2.innerLife.groupShare.minGapMs', fromStored: (v) => Math.round(Number(v) / 60000), toStored: (v) => Math.round(Number(v) * 60000)
  }
];

function specByKey(key) {
  return specs.find((item) => item.key === String(key || '')) || null;
}

export function listOwnerConfig(cfg) {
  return specs.map((spec) => ({
    key: spec.key,
    label: spec.label,
    type: spec.type,
    unit: spec.unit || '',
    min: spec.min,
    max: spec.max,
    description: spec.description,
    restart: spec.restart || 'none',
    value: readOwnerConfig(cfg, spec.key)
  }));
}

export function readOwnerConfig(cfg, key) {
  const spec = specByKey(key);
  if (!spec) return undefined;
  const raw = getPath(cfg, spec.storedPath || defaultStoredPath(spec.key));
  return spec.fromStored ? spec.fromStored(raw) : raw;
}

function defaultStoredPath(key) {
  if (key.startsWith('qzone.')) return `socialV2.innerLife.${key}`;
  if (key.startsWith('signature.')) return `socialV2.${key}`;
  if (key.startsWith('dailyReport.')) return `socialV2.${key}`;
  if (key.startsWith('voice.')) return `socialV2.${key}`;
  return key;
}

export function validateOwnerConfig(key, value) {
  const spec = specByKey(key);
  if (!spec) return { ok: false, error: `未知配置：${key}` };
  if (spec.type === 'boolean') {
    if (typeof value !== 'boolean') return { ok: false, error: `${spec.label} 必须是 true/false` };
    return { ok: true, spec, value };
  }
  if (spec.type === 'time') {
    const m = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(String(value || '').trim());
    if (!m) return { ok: false, error: `${spec.label} 必须是 HH:MM` };
    return { ok: true, spec, value: `${m[1].padStart(2, '0')}:${m[2]}` };
  }
  const num = Number(value);
  if (!Number.isFinite(num)) return { ok: false, error: `${spec.label} 必须是数字` };
  if (spec.min != null && num < spec.min) return { ok: false, error: `${spec.label} 不能小于 ${spec.min}` };
  if (spec.max != null && num > spec.max) return { ok: false, error: `${spec.label} 不能大于 ${spec.max}` };
  return { ok: true, spec, value: num };
}

export function applyOwnerConfig(cfg, key, value) {
  const checked = validateOwnerConfig(key, value);
  if (!checked.ok) return checked;
  const spec = checked.spec;
  const stored = spec.toStored ? spec.toStored(checked.value) : checked.value;
  const path = spec.storedPath || defaultStoredPath(key);
  return { ok: true, spec, path, stored, value: checked.value, before: readOwnerConfig(cfg, key) };
}

export function ownerConfigPatch(key, value) {
  const checked = validateOwnerConfig(key, value);
  if (!checked.ok) return checked;
  const spec = checked.spec;
  return { ok: true, spec, path: spec.storedPath || defaultStoredPath(key), value: checked.value, stored: spec.toStored ? spec.toStored(checked.value) : checked.value };
}

export function setOwnerConfigValue(cfg, key, value) {
  const applied = applyOwnerConfig(cfg, key, value);
  if (!applied.ok) return applied;
  setPath(cfg, applied.path, applied.stored);
  return applied;
}
