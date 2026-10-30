#!/usr/bin/env node
/** 夜间静默：只允许明确“被喊”的唤醒，泛监听和概率唤醒在窗口内必须失效。 */
import assert from 'node:assert/strict';
import { bridgeHarness } from './audit-bridge-harness.mjs';

function stateWithTriggers(h, key) {
  const st = h.getSimulationState(key);
  st.wakeConfig = {
    mode: 'diving',
    infinite: true,
    triggers: {
      atMention: true,
      nameMention: true,
      speakerIds: ['123'],
      keywords: ['小鲸鱼'],
      question: true,
      poke: true,
      anyMessage: true,
      probability: 1
    }
  };
  return st;
}

function event(extra = {}) {
  return {
    self_id: 999,
    user_id: 123,
    message_id: 4242,
    message: [{ type: 'text', data: { text: '随便聊聊' } }],
    raw_message: '随便聊聊',
    sender: { nickname: '测试群友', card: '测试群友' },
    ...extra
  };
}

const quietAllDay = { enabled: true, start: '00:00', end: '00:00' };

const night = await bridgeHarness({ config: { simulation: { nightQuiet: quietAllDay } } });
try {
  assert.equal(night.isNightQuietNow(), true, '窗口应覆盖当前时间，测试才有效');
  const st = stateWithTriggers(night, 'group:456');
  assert.equal(night.evaluateWakeTrigger('group:456', st, event(), 'group', '随便聊聊', '随便聊聊', false), null,
    'anyMessage / 指定成员 / 概率 在夜间都不得唤醒');
  assert.equal(night.evaluateWakeTrigger('private:123', st, event(), 'private', '随便聊聊', '随便聊聊', false), 'private',
    '私聊是明确找她，夜间仍应响应');
  assert.match(String(night.evaluateWakeTrigger('group:456', st, event(), 'group', '小鲸鱼在吗', '小鲸鱼在吗', false)), /keyword|nameMention/,
    '名字/关键词在夜间仍应响应');
  const atEvent = event({ message: [{ type: 'at', data: { qq: '999' } }, { type: 'text', data: { text: '在吗' } }] });
  assert.equal(night.evaluateWakeTrigger('group:456', st, atEvent, 'group', '在吗', '在吗', false), 'atMention',
    '@ 她在夜间仍应响应');
  assert.equal(night.nightQuietConfig().start, '00:00');
} finally {
  await night.close();
}

// 白天这段只验证「夜间静默关闭后泛监听重新生效」，所以关掉价值评分：
// 评分自己会把「随便聊聊」判成 defer/ignore，混进来就测不到静默门控了。
const day = await bridgeHarness({
  config: { simulation: { nightQuiet: { ...quietAllDay, enabled: false }, valueScore: { enabled: false } } }
});
try {
  assert.equal(day.isNightQuietNow(), false, '关闭后不应生效');
  const st = stateWithTriggers(day, 'group:456');
  // 泛监听命中后带价值评分后缀（anyMessage:score0.42），断言只看前缀：
  // 要看的是"能不能被叫醒"，不是分数具体多少。
  assert.match(String(day.evaluateWakeTrigger('group:456', st, event(), 'group', '随便聊聊', '随便聊聊', false)), /^anyMessage/,
    '关闭夜间静默后恢复 anyMessage 行为');
} finally {
  await day.close();
}

console.log('night quiet checks passed');
