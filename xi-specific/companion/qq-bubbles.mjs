const BUBBLES = Symbol('guardian-bubbles');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Split only short conversational paragraphs; preserve structured/long content.
export function conversationalBeats(text) {
  if (typeof text !== 'string' || /```|^\s*(?:[-*#>]|\d+[.)、])\s/m.test(text)) return null;
  const parts = text.split(/\r?\n+/).map(s => s.trim()).filter(Boolean);
  return parts.length >= 2 && parts.length <= 3 && parts.every(s => s.length <= 160) && text.length <= 360 ? parts : null;
}
export function installBubbles(world, {wait = sleep} = {}) {
  const tools = world.tools;
  const send = world.sendToTarget; // Must be the already guarded per-message sender.
  if (typeof tools !== 'function' || typeof send !== 'function') throw new Error('QQ bubble adapter incompatible');
  world.tools = function(...params) {
    return tools.apply(this, params).map(tool => tool.name !== 'qq_draft' ? tool : {
      ...tool,
      description: tool.description + ' For a few natural chat beats, supply bubbles instead of text; one confirmation sends the batch. Do not turn a long essay into several bubbles.',
      parameters: {...tool.parameters, properties: {...tool.parameters.properties,
        quote: {type:'boolean', description:'Default false. Set true with reply_to only when referring back to an older message or resolving ambiguity; ordinary ongoing chat has no quote.'},
        keep_together: {type:'boolean', description:'Keep text paragraphs in one message for stories, explanations or intentionally formatted text. Default false; short chat paragraphs become separate messages.'},
        bubbles: {type:'array', minItems:2, maxItems:3, items:{type:'string', minLength:1,maxLength:240},
          description:'Optional 2–3 short messages in reading order. Mutually exclusive with text, image and voice. Use text for one message or a requested detailed answer. A new incoming message interrupts the remaining bubbles.'}}},
      handler: async (args, ctx) => {
        this.pendingDraft = null;
        const values = args.bubbles ?? (!args.keep_together && !args.image && !args.voice ? conversationalBeats(args.text) : null);
        if (!values) {
          const result = await tool.handler(args, ctx);
          if (this.pendingDraft && args.quote !== true) this.pendingDraft.replyMessageId = undefined;
          return result;
        }
        if (!Array.isArray(values) || values.length < 2 || values.length > 3 ||
            values.some(s => typeof s !== 'string' || !s.trim() || s.length > 240) ||
            (args.bubbles !== undefined && args.text) || args.image || args.voice) return '[bad input] bubbles must contain 2–3 short texts, without text/image/voice';
        const {bubbles, ...rest} = args;
        const result = await tool.handler({...rest,text:values.join('\n\n')},ctx);
        if (this.pendingDraft) {
          if (args.quote !== true) this.pendingDraft.replyMessageId = undefined;
          this.pendingDraft[BUBBLES] = Object.freeze(values.map(s => s.trim()));
          return result + `\n[Will send ${values.length} separate bubbles after one confirmation; no quote unless explicitly requested; then only the first quotes the source.]`;
        }
        return result;
      },
    });
  };
  world.sendToTarget = async function(target, opts) {
    const draft = this.pendingDraft;
    const bubbles = draft?.[BUBBLES];
    if (!bubbles) return send.call(this,target,opts);
    // Consume before I/O. Even a caught timeout must not replay the entire batch.
    delete draft[BUBBLES];
    const revision = this.guardianInboundVersion ?? 0;
    const receipts = [];
    for (let i=0; i<bubbles.length; i++) {
      if (i) await wait(Math.min(1200, 450 + bubbles[i-1].length * 15));
      if ((this.guardianInboundVersion ?? 0) !== revision) {
        return `[bubble batch interrupted: ${receipts.length}/${bubbles.length} acknowledged; remaining discarded because a new message arrived]\n${receipts.join('\n')}`;
      }
      try {
        receipts.push(await send.call(this,target,{...opts,text:bubbles[i],replyMessageId:i===0?opts.replyMessageId:undefined}));
      } catch {
        return `[bubble batch stopped: ${receipts.length}/${bubbles.length} acknowledged; current delivery uncertain or refused, remaining discarded. Do not automatically resend.]\n${receipts.join('\n')}`;
      }
    }
    return receipts.join('\n');
  };
  return world;
}
