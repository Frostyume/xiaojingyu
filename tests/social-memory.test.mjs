#!/usr/bin/env node
// Phase A 纯模块：身份合并、经历可见性、注意力、收件人、语域。
import assert from 'node:assert/strict';
import { openDatabase } from '../runtime/kernel/db.js';
import { IdentityStore } from '../services/social/identity-store.js';
import { SocialGraph } from '../services/social/social-graph.js';
import { EpisodeStore } from '../services/social/episodes.js';
import { decideAttention } from '../runtime/persona/attention.js';
import { classifyAddressedness, matchSelfCallName } from '../runtime/persona/addressedness.js';
import { normalizeThread, attributeMessage } from '../runtime/persona/addressing.js';
import { selectRegister, familiarityTier } from '../runtime/persona/register.js';

const NOW = Date.UTC(2026, 10, 20, 4, 0, 0);
const db = () => openDatabase({ file: ':memory:', logger: () => {} });

console.log('## 身份：同账号同一人，跨账号必须显式确认');
{
  const d = db();
  const store = new IdentityStore({ db: d, now: () => NOW });
  const a = store.ensurePerson({ platform: 'qq', accountId: '10001', displayName: '甲' });
  const again = store.ensurePerson({ platform: 'qq', accountId: '10001', displayName: '甲改' });
  assert.equal(again.person.id, a.person.id, '同账号不得因昵称变化换人');
  assert.equal(again.created, false);
  const b = store.ensurePerson({ platform: 'qq', accountId: '10002', displayName: '乙' });
  assert.notEqual(a.person.id, b.person.id);
  assert.throws(() => store.link({ from: { platform: 'qq', accountId: '10001' }, to: { platform: 'qq', accountId: '10002' } }), /显式确认/);
  const linked = store.link({ from: { platform: 'qq', accountId: '10001' }, to: { platform: 'qq', accountId: '10002' }, confirmed: true });
  assert.equal(linked.personId, b.person.id);
  assert.equal(store.listIdentities(b.person.id).length, 2, '确认后两个账号合并到同一人');
  console.log('OK 身份');
}

console.log('## 经历：按可见性隔离，跨群不泄漏');
{
  const d = db();
  const graph = new SocialGraph({ db: d, now: () => NOW });
  const person = graph.ensurePerson({ accountId: '10001', displayName: '甲' }).person;
  const episodes = new EpisodeStore({ db: d, now: () => NOW, socialGraph: graph });
  const rec = episodes.record({
    occurredAt: NOW - 1000,
    groupKey: 'group:1',
    topic: '闲聊',
    summary: '在群里一起看比赛',
    participants: [{ personId: person.id, name: '甲' }],
    visibility: 'group'
  });
  assert.equal(rec.created, true);
  const same = episodes.list({ groupKey: 'group:1', viewer: { sessionKey: 'group:1' }, now: NOW });
  assert.equal(same.length, 1);
  const other = episodes.list({ groupKey: 'group:1', viewer: { sessionKey: 'group:2' }, now: NOW });
  assert.equal(other.length, 0, '别的群看不到本群经历');
  const owner = episodes.list({ groupKey: 'group:1', viewer: { sessionKey: 'private:9', isOwnerSession: true }, now: NOW });
  assert.equal(owner.length, 1, '主人私聊可见');
  console.log('OK 经历可见性');
}

console.log('## 注意力：私聊必回、旁支不抢话');
{
  const at = NOW;
  const priv = decideAttention({
    messages: [{ time: at, userId: '2', sender: '乙', plain: '在吗', messageId: 'm1' }],
    session: { key: 'private:2', isPrivate: true },
    now: at
  });
  assert.equal(priv.shouldReply, true);
  assert.equal(priv.mustReply, true);
  const side = decideAttention({
    messages: [
      { time: at - 3000, userId: '2', sender: '甲', plain: '你昨天那个事怎么弄的', atOthers: ['3'], messageId: 'a' },
      { time: at - 2000, userId: '3', sender: '乙', plain: '就那样弄的', quoteOther: true, quoted: { userId: '2' }, messageId: 'b' }
    ],
    session: { key: 'group:1', mode: 'active' },
    now: at
  });
  assert.equal(side.shouldReply, false, '别人之间的旁支不插话');
  const direct = decideAttention({
    messages: [{ time: at, userId: '2', sender: '甲', plain: '你来一下', atSelf: true, messageId: 'c' }],
    session: { key: 'group:1', mode: 'diving' },
    now: at
  });
  assert.equal(direct.shouldReply, true, '被点名必回');
  console.log('OK 注意力');
}

console.log('## 收件人：@、引用、称呼与 shadow 归因');
{
  const addr = classifyAddressedness({
    message: [{ type: 'at', data: { qq: '999' } }],
    selfId: '999',
    selfNames: ['角色'],
    plainText: '来一下'
  });
  assert.equal(addr.addressedTo, 'self');
  assert.equal(matchSelfCallName('叫一下小白，可以吗', ['小白']), '小白');
  const other = classifyAddressedness({
    message: [{ type: 'at', data: { qq: '2' } }],
    selfId: '999',
    selfNames: ['角色'],
    plainText: '你看这个'
  });
  assert.equal(other.addressedTo, 'other');
  const thread = normalizeThread(null, 'group:1');
  const first = attributeMessage(thread, { seq: 1, userId: '2', sender: '甲', plain: '你来一下', atSelf: true }, { now: NOW });
  assert.equal(first.result.addressee, 'self');
  const second = attributeMessage(first.thread, { seq: 2, userId: '2', sender: '甲', plain: '你看他', atOthers: ['3'] }, { now: NOW });
  assert.equal(second.result.addressee, 'user:3');
  console.log('OK 收件人');
}

console.log('## 语域：场景与熟悉度');
{
  assert.equal(familiarityTier(10).id, 'stranger');
  assert.equal(familiarityTier(0.6).id, 'familiar');
  const owner = selectRegister({ key: 'private:9', ownerQQ: '9', mode: 'steady' });
  assert.equal(owner.context, 'owner');
  assert.match(owner.text, /主人私聊/);
  const family = selectRegister({ key: 'group:1', ownerQQ: '9', family: true, mode: 'steady' });
  assert.equal(family.context, 'family');
  assert.match(family.text, /家人群/);
  const group = selectRegister({ key: 'group:1', ownerQQ: '9', family: false, familiarity: 60, mode: 'steady' });
  assert.equal(group.context, 'group');
  assert.equal(group.familiarity, 'familiar');
  console.log('OK 语域');
}

console.log('OK Phase A 纯模块');