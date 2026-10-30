#!/usr/bin/env node
/** 语气提醒：被夸时禁止硬挡，连续干巴巴时推动一次语气词/颜文字。 */
import assert from 'node:assert/strict';
import { bridgeHarness } from './bridge-harness.mjs';

const h = await bridgeHarness();
try {
  const st = h.getSimulationState('group:456');
  const self = (text) => ({ isSelf: true, text });
  const user = (text) => ({ isSelf: false, text });

  st.recentMessages = [self('乖什么乖，我只是记性好'), self('行吧，那我受着，谢了啊')];
  let line = h.buildToneNudgeLine(st, user('夸你乖就受着'));
  assert.match(line, /先接住好意/, '被夸时应提醒先接住好意');
  assert.match(line, /乖什么乖/, '应点名禁止硬挡句');

  st.recentMessages = [self('好呀 (・ω・)')];
  assert.equal(h.buildToneNudgeLine(st, user('真乖')), '', '上一条已经软了就不再唠叨');

  st.recentMessages = [self('知道了'), self('嗯'), self('行')];
  line = h.buildToneNudgeLine(st, user('今天干嘛了'));
  assert.match(line, /有点干/, '连续干巴巴时应推动一次语气');

  st.recentMessages = [self('知道啦 (´・ω・`)'), self('好呀')];
  assert.equal(h.buildToneNudgeLine(st, user('今天干嘛了')), '', '已经带语气时不应重复提醒');

  st.recentMessages = [];
  assert.equal(h.buildToneNudgeLine(st, user('不乖')), '', '否定句不应误判成夸奖');
  assert.equal(h.buildToneNudgeLine(st, null), '', '没有来信时不应提醒');

  const tokenLine = h.buildToneNudgeLine(st, user('给你爸吃穷没 token 你就要没了'), 'private:123');
  assert.match(tokenLine, /怕怕|省着点吃/, '主人私聊逗 token 时应提醒软黏一点');
  assert.doesNotMatch(h.buildToneNudgeLine(st, user('给你爸吃穷没 token 你就要没了'), 'group:456'), /怕怕|省着点吃/, '群聊不应触发主人私聊的黏人提醒');

  console.log('tone nudge checks passed');
} finally {
  await h.close();
}
