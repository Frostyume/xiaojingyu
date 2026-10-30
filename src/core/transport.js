// 传输适配层：核心只认 sendText/getMember/getForward，不直接绑 SnowLuma SDK 或 OneBot action。
//
// 当前实现：
//   · snowluma：纯文本走 WS（沿用现网行为），带引用/@ 或媒体走 OneBot HTTP action；
//   · onebot：通用 OneBot v11 HTTP（NapCat 等），所有发送走 HTTP。
//
// 能力矩阵用于提前拒绝不支持的动作（例如 NapCat 的语音条格式差异），
// 而不是让调用方在发送到一半时收到一个难懂的网关错误。

export const TRANSPORT_CAPABILITIES = Object.freeze({
  snowluma: Object.freeze({
    text: true, reply: true, at: true, media: true, voice: true, forward: true, member: true, poke: true
  }),
  onebot: Object.freeze({
    text: true, reply: true, at: true, media: true, voice: false, forward: true, member: true, poke: true
  })
});

export function parseTargetKey(key) {
  const m = /^(group|private):(\d+)$/.exec(String(key ?? '').trim());
  if (!m) throw new Error('会话 key 必须是 group:群号 或 private:QQ号');
  return { kind: m[1], id: Number(m[2]) };
}

export class TransportAdapter {
  constructor({ kind = 'snowluma', capabilities, sendWs, sendHttp, getMember, getForward } = {}) {
    if (!sendHttp) throw new Error('TransportAdapter 需要 sendHttp');
    this.kind = kind;
    this.capabilities = capabilities ?? TRANSPORT_CAPABILITIES[kind] ?? TRANSPORT_CAPABILITIES.onebot;
    this.sendWs = sendWs ?? null;
    this.sendHttp = sendHttp;
    this.getMemberFn = getMember ?? null;
    this.getForwardFn = getForward ?? null;
  }

  supports(capability) {
    return this.capabilities[capability] === true;
  }

  require(capability) {
    if (!this.supports(capability)) throw new Error(`当前传输（${this.kind}）不支持 ${capability}`);
  }

  /**
   * @param {{key:string,text:string,replyToMessageId?:string|number|null,atUserId?:string|number|null,via?:'ws'|'http'}} input
   */
  async sendText({ key, text, replyToMessageId = null, atUserId = null, via = '' } = {}) {
    const { kind, id } = parseTargetKey(key);
    const body = String(text ?? '');
    if (!body) throw new Error('发送内容不能为空');
    const needsRich = (replyToMessageId !== null && replyToMessageId !== undefined && String(replyToMessageId) !== '')
      || (atUserId !== null && atUserId !== undefined && String(atUserId) !== '');
    if (needsRich && !this.supports('reply')) throw new Error(`当前传输（${this.kind}）不支持引用/at`);
    const useWs = via === 'ws' || (via !== 'http' && this.kind === 'snowluma' && !needsRich);
    if (useWs) {
      if (!this.sendWs) throw new Error(`当前传输（${this.kind}）没有 WS 发送通道`);
      return this.sendWs({ kind, id, text: body });
    }
    return this.sendHttp({ kind, id, text: body, replyToMessageId, atUserId });
  }

  async sendMedia({ key, media, replyToMessageId = null } = {}) {
    this.require('media');
    const { kind, id } = parseTargetKey(key);
    if (!this.sendHttp) throw new Error('当前传输没有媒体发送通道');
    return this.sendHttp({ kind, id, media, replyToMessageId, mediaOnly: true });
  }

  async getMember(groupId, userId, options = {}) {
    this.require('member');
    if (!this.getMemberFn) throw new Error('当前传输没有成员查询通道');
    return this.getMemberFn(groupId, userId, options);
  }

  async getForward(forwardId) {
    this.require('forward');
    if (!this.getForwardFn) throw new Error('当前传输没有转发查询通道');
    return this.getForwardFn(forwardId);
  }

  describe() {
    return { kind: this.kind, capabilities: { ...this.capabilities } };
  }
}

export function createTransport({ kind = 'snowluma', sendWs, sendHttp, getMember, getForward } = {}) {
  const normalized = kind === 'onebot' || kind === 'napcat' ? 'onebot' : 'snowluma';
  return new TransportAdapter({
    kind: normalized,
    capabilities: TRANSPORT_CAPABILITIES[normalized],
    sendWs,
    sendHttp,
    getMember,
    getForward
  });
}
