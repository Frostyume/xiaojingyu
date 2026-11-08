// 出门见闻：视频字幕轨适配器（yt-dlp）。
// 找不到可执行文件时返回 {ok:false, reason:'dependency-missing'}，不崩、不自动安装。
// 解析顺序：显式配置 → YT_DLP_PATH → PATH；不猜测任何本机安装路径。

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

const PROBE_TTL_MS = 10 * 60 * 1000;
let probeCache = { key: '', at: 0, value: null };

function candidates({ ytDlpPath, envPath, pathBin } = {}) {
  const env = envPath !== undefined ? envPath : process.env.YT_DLP_PATH;
  return [
    { source: 'config', bin: String(ytDlpPath ?? '').trim() },
    { source: 'env', bin: String(env ?? '').trim() },
    { source: 'path', bin: pathBin === undefined ? 'yt-dlp' : String(pathBin ?? '').trim() }
  ].filter((item) => item.bin);
}

/** 探测可执行文件；结果按候选集合缓存，避免状态页反复 spawn。 */
export function probeSubtitleTool(options = {}) {
  const list = candidates(options);
  const key = list.map((item) => `${item.source}:${item.bin}`).join('|');
  const now = Date.now();
  if (probeCache.key === key && now - probeCache.at < PROBE_TTL_MS) return probeCache.value;
  let value = { ok: false, reason: 'dependency-missing' };
  for (const item of list) {
    try {
      const run = spawnSync(item.bin, ['--version'], { timeout: 5000, windowsHide: true, encoding: 'utf8' });
      const version = String(run.stdout ?? '').trim().split(/\r?\n/)[0];
      if (run.status === 0 && version) {
        value = { ok: true, bin: item.bin, source: item.source, version };
        break;
      }
    } catch {}
  }
  probeCache = { key, at: now, value };
  return value;
}

/** 去掉 VTT 时间轴、序号与样式标签，只留字幕文本。 */
export function cleanVtt(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n');
  const out = [];
  for (const line of lines) {
    const value = line.trim();
    if (!value || value === 'WEBVTT' || /^NOTE\b/.test(value)) continue;
    if (/^\d+$/.test(value) || value.includes('-->')) continue;
    out.push(value.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim());
  }
  const deduped = out.filter((line, index) => line && (index === 0 || line !== out[index - 1]));
  return deduped.join('\n').trim();
}

function runYtDlp(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { windowsHide: true });
    } catch (error) {
      resolve({ ok: false, reason: 'spawn-failed', error: String(error?.message ?? error) });
      return;
    }
    let stderr = '';
    let timer = null;
    const done = (value) => {
      if (timer) clearTimeout(timer);
      timer = null;
      resolve(value);
    };
    child.stderr?.on('data', (chunk) => { if (stderr.length < 2000) stderr += String(chunk); });
    child.on('error', (error) => done({ ok: false, reason: 'spawn-failed', error: String(error?.message ?? error) }));
    child.on('close', (code) => done(code === 0
      ? { ok: true }
      : { ok: false, reason: `exit-${code}`, error: stderr.trim().slice(0, 300) }));
    timer = setTimeout(() => {
      try { child.kill(); } catch {}
      done({ ok: false, reason: 'timeout' });
    }, Math.max(1000, Number(timeoutMs) || 60000));
    timer.unref?.();
  });
}

/** 取一条字幕轨：只下载字幕，不下载视频；缺依赖/无字幕都返回 ok:false。 */
export async function fetchSubtitleTrack({ url, workDir, lang = 'zh-Hans', timeoutMs = 60000, ...probeOptions } = {}) {
  const target = String(url ?? '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, reason: 'invalid-url' };
  const dir = String(workDir ?? '').trim();
  if (!dir) return { ok: false, reason: 'invalid-workdir' };
  const tool = probeSubtitleTool(probeOptions);
  if (!tool.ok) return tool;
  try { fs.mkdirSync(dir, { recursive: true }); } catch { return { ok: false, reason: 'workdir-failed' }; }
  const output = path.join(dir, 'sub-%(id)s.%(ext)s');
  const run = await runYtDlp(tool.bin, [
    '--no-warnings', '--skip-download', '--write-subs', '--write-auto-subs',
    '--sub-langs', String(lang || 'zh-Hans'), '--sub-format', 'vtt', '--no-playlist',
    '-o', output, target
  ], timeoutMs);
  if (!run.ok) return run;
  let files = [];
  try { files = fs.readdirSync(dir).filter((name) => /^sub-.*\.vtt$/i.test(name)).sort(); } catch {}
  for (const file of files) {
    try {
      const text = cleanVtt(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (text) return { ok: true, text, lang: String(lang), file, tool: tool.source };
    } catch {}
  }
  return { ok: false, reason: 'no-subtitle' };
}
