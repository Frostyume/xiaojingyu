import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const bridge = fs.readFileSync(new URL('../app/whale.js', import.meta.url), 'utf8');
const ensure = fs.readFileSync(new URL('../tools/ensure-breeze-tunnel.mjs', import.meta.url), 'utf8');
const live = fs.readFileSync(new URL('../web/live.html', import.meta.url), 'utf8');
// config.json 不入库：干净检出上没有它，只跳过下面那条本机配置断言。
const cfgUrl = new URL('../config.json', import.meta.url);
const cfg = fs.existsSync(cfgUrl) ? JSON.parse(fs.readFileSync(cfgUrl, 'utf8')) : null;

test('Breeze 隧道脚本仍会转发 7861/7862', () => {
  assert.match(ensure, /17861/);
  assert.match(ensure, /17862/);
  assert.match(ensure, /ExitOnForwardFailure=yes/);
  assert.match(ensure, /ServerAliveInterval=15/);
});

test('桥接健康检查看 Breeze，而不是旧的 9880', () => {
  assert.match(bridge, /breezeBase}\/health/);
  assert.match(bridge, /liveTtsProvider = 'breeze'/);
  assert.match(bridge, /provider: liveTtsProvider/);
});

test('隧道掉线会定期自动重建', () => {
  assert.match(bridge, /async function ensureBreezeTunnel\(/);
  assert.match(bridge, /ensure-breeze-tunnel\.mjs/);
  assert.match(bridge, /setInterval\(\(\) => void ensureBreezeTunnel\(\), 60 \* 1000\)/);
  assert.match(bridge, /lastTunnelSpawnAt < 5 \* 60 \* 1000/);
});

test('僵死隧道先按端口清进程再重建（记录 PID + 只杀自己的 ssh）', () => {
  assert.match(ensure, /breeze-tunnel\.pid/);
  assert.match(ensure, /listenerPids/);
  assert.match(ensure, /taskkill/);
  assert.match(ensure, /BatchMode=yes/);
  assert.match(ensure, /ConnectTimeout=25/);
});

test('隧道重建用 ssh -f 后台化 + 限流锁 + 多次重试', () => {
  assert.match(ensure, /'-f', '-N'/);
  assert.match(ensure, /breeze-tunnel\.lock/);
  assert.match(ensure, /ATTEMPTS = 5/);
  assert.match(ensure, /ssh attempt failed/);
});

test('慢链路单次超时不重建，连续两次失败才算掉线', () => {
  assert.match(bridge, /tunnelFailStreak/);
  assert.match(bridge, /tunnelFailStreak < 2/);
  assert.match(bridge, /Breeze 隧道已恢复/);
  assert.match(bridge, /TUNNEL_HEALTH_TIMEOUT_MS = 20000/);
});

test('实时页显示真实 TTS 提供方', () => {
  assert.match(live, /h\.tts\?\.provider === 'breeze' \? 'Breeze' : '9880'/);
});

test('当前配置启用 Breeze 并走 Opus 代理', { skip: cfg ? false : '没有 config.json（公开仓库不含本机配置）' }, () => {
  const b = cfg.tts?.breeze;
  assert.equal(b?.enabled, true);
  assert.match(String(b?.baseUrl || ''), /17861/);
  assert.match(String(b?.opusUrl || ''), /17862/);
  assert.equal(b?.preferOpus !== false, true);
});
