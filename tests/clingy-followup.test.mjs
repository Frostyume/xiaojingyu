#!/usr/bin/env node
/** 主人私聊黏人追问：只对该会话生效、有上限、不误伤群聊。 */
import assert from 'node:assert/strict';
import { bridgeHarness } from './bridge-harness.mjs';

const h = await bridgeHarness({
  config: { simulation: { clingy: { enabled: true, maxFollowUps: 1, minDelayMs: 1000, maxDelayMs: 1000, probability: 1 } } }
});
try {
  h.setMode('simulation');
  const st = h.getSimulationState('private:123');
  const now = Date.now();
  st.unread = [];
  st.clingyFollowUps = 0;
  st.recentMessages = [
    { isSelf: false, text: '在吗', time: now - 5000 },
    { isSelf: true, text: '在的', time: now - 1000 }
  ];

  h.scheduleClingyFollowUp('private:123');
  await new Promise((r) => setTimeout(r, 1800));
  assert.equal(h.calls.prompts.length, 1, '主人私聊应触发一次黏人追问');
  const prompt = h.calls.prompts[0].content.map((c) => String(c?.text ?? '')).join('\n');
  assert.match(prompt, /【黏人追问】/);
  assert.match(prompt, /主人～理我一下嘛/);
  assert.equal(st.clingyFollowUps, 1, '追问计数应增加');

  h.scheduleClingyFollowUp('private:123');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.calls.prompts.length, 1, '达到上限后不应再追');

  const groupSt = h.getSimulationState('group:456');
  groupSt.unread = [];
  groupSt.recentMessages = [
    { isSelf: false, text: '聊什么呢', time: now - 5000 },
    { isSelf: true, text: '聊点别的', time: now - 1000 }
  ];
  h.scheduleClingyFollowUp('group:456');
  await new Promise((r) => setTimeout(r, 300));
  assert.equal(h.calls.prompts.length, 1, '群聊不应触发黏人追问');

  console.log('clingy follow-up checks passed');
} finally {
  await h.close();
}
