// 只读 GitHub 仓库监控：按配置仓库拉取 stars/forks/open issues/open PR/releases，
// 与本地快照比较后只输出变化。首次运行只建基线，不把历史条目刷给主人。
// token 只放在请求头里；不写日志、不拼 URL、不进入推送文本。

import { sanitizeTitle } from '../../kernel/redact.js';

const API = 'https://api.github.com';
const MAX_REPOS = 20;
const MAX_EVENTS = 30;
const MAX_KNOWN = 300;
const MAX_RELEASES = 30;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export function allowedHosts() {
  return ['api.github.com'];
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
}

function isoMs(value) {
  const ms = Date.parse(String(value ?? ''));
  return Number.isFinite(ms) ? ms : null;
}

function repoUrl(repo, suffix = '') {
  return `${API}/repos/${repo}${suffix}`;
}

export function normalizeRepoList(list) {
  const out = [];
  const seen = new Set();
  for (const item of Array.isArray(list) ? list : []) {
    const repo = String(item ?? '').trim().slice(0, 140);
    const key = repo.toLowerCase();
    if (!REPO_RE.test(repo) || seen.has(key)) continue;
    seen.add(key);
    out.push(repo);
    if (out.length >= MAX_REPOS) break;
  }
  return out;
}

export function parseCursor(raw) {
  if (!raw || typeof raw !== 'string') return null;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && parsed.v === 1 && parsed.repos && typeof parsed.repos === 'object' && !Array.isArray(parsed.repos)) return parsed;
  } catch { /* 损坏的快照按首次运行处理 */ }
  return null;
}

export function parseRepoMeta(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  return {
    stars: num(payload.stargazers_count),
    forks: num(payload.forks_count),
    openIssuesTotal: num(payload.open_issues_count)
  };
}

export function parseRepoIssues(payload) {
  const list = Array.isArray(payload) ? payload : [];
  return list
    .filter((item) => item && typeof item === 'object' && !item.pull_request)
    .slice(0, 100)
    .map((item) => ({
      number: num(item.number),
      title: sanitizeTitle(item.title ?? '', 120),
      author: String(item.user?.login ?? '').slice(0, 60),
      state: String(item.state ?? 'open').slice(0, 20),
      updatedAt: isoMs(item.updated_at),
      url: String(item.html_url ?? '').slice(0, 300)
    }))
    .filter((item) => item.number > 0 && item.title);
}

export function parseRepoPulls(payload) {
  const list = Array.isArray(payload) ? payload : [];
  return list
    .slice(0, 100)
    .map((item) => ({
      number: num(item?.number),
      title: sanitizeTitle(item?.title ?? '', 120),
      author: String(item?.user?.login ?? '').slice(0, 60),
      state: String(item?.state ?? 'open').slice(0, 20),
      updatedAt: isoMs(item?.updated_at),
      url: String(item?.html_url ?? '').slice(0, 300)
    }))
    .filter((item) => item.number > 0 && item.title);
}

export function parseReleases(payload) {
  const list = Array.isArray(payload) ? payload : [];
  return list
    .slice(0, MAX_RELEASES)
    .map((item) => ({
      id: String(item?.id ?? '').slice(0, 60),
      tag: String(item?.tag_name ?? '').slice(0, 80),
      name: sanitizeTitle(item?.name ?? '', 120),
      publishedAt: isoMs(item?.published_at ?? item?.created_at),
      url: String(item?.html_url ?? '').slice(0, 300)
    }))
    .filter((item) => item.id && (item.tag || item.name));
}

function knownNumbers(previous, key) {
  const list = Array.isArray(previous?.[key]) ? previous[key] : [];
  return new Set(list.map((value) => Number(value)).filter((value) => Number.isFinite(value) && value > 0));
}

function draftFor(repo, type, item, nowMs) {
  const number = num(item.number);
  const label = number ? `#${number} ` : '';
  if (type === 'release') {
    return {
      kind: 'feed',
      externalId: `release:${item.id}`,
      title: sanitizeTitle(`${repo} · ${item.tag || item.name || '新版本'}`, 140),
      startsAt: item.publishedAt ?? nowMs,
      status: 'open',
      dedupeKey: `github:${repo}:release:${item.id}`,
      sourceRef: 'release',
      source: 'github',
      meta: {
        repo, tag: item.tag || null, releaseName: item.name || null,
        publishedAt: item.publishedAt, htmlUrl: item.url || null, url: item.url || null
      }
    };
  }
  return {
    kind: 'feed',
    externalId: `${type}:${number}`,
    title: sanitizeTitle(`${repo} · ${label}${item.title}`, 140),
    startsAt: item.updatedAt ?? nowMs,
    status: 'open',
    dedupeKey: `github:${repo}:${type}:${number}:${item.updatedAt ?? ''}`,
    sourceRef: type,
    source: 'github',
    meta: {
      repo, number, author: item.author || null, state: item.state || 'open',
      updatedAt: item.updatedAt, htmlUrl: item.url || null, url: item.url || null
    }
  };
}

export function buildRepoDelta({ repo, meta, issues = [], pulls = [], releases = [], previous = null, nowMs = Date.now(), trackIssues = true, trackPulls = true, trackReleases = true }) {
  const baseline = !previous;
  const stars = num(meta?.stars);
  const forks = num(meta?.forks);
  const openPulls = pulls.length || num(previous?.openPulls);
  const openIssues = Math.max(0, num(meta?.openIssuesTotal) - openPulls);
  const knownIssues = knownNumbers(previous, 'issueNumbers');
  const knownPulls = knownNumbers(previous, 'pullNumbers');
  const knownReleases = new Set((Array.isArray(previous?.releaseIds) ? previous.releaseIds : []).map(String));
  const newIssues = baseline || !trackIssues ? [] : issues.filter((item) => !knownIssues.has(item.number));
  const newPulls = baseline || !trackPulls ? [] : pulls.filter((item) => !knownPulls.has(item.number));
  const newReleases = baseline || !trackReleases ? [] : releases.filter((item) => !knownReleases.has(item.id));
  const starDelta = baseline ? 0 : stars - num(previous?.stars);
  const forkDelta = baseline ? 0 : forks - num(previous?.forks);
  const drafts = [];
  for (const item of newIssues.slice(0, MAX_EVENTS)) drafts.push(draftFor(repo, 'issue', item, nowMs));
  for (const item of newPulls.slice(0, MAX_EVENTS)) drafts.push(draftFor(repo, 'pull', item, nowMs));
  for (const item of newReleases.slice(0, MAX_EVENTS)) drafts.push(draftFor(repo, 'release', item, nowMs));
  return {
    baseline,
    snapshot: {
      stars,
      forks,
      openIssues,
      openPulls,
      issueNumbers: trackIssues ? issues.map((item) => item.number).slice(-MAX_KNOWN) : (previous?.issueNumbers ?? []),
      pullNumbers: pulls.length ? pulls.map((item) => item.number).slice(-MAX_KNOWN) : (previous?.pullNumbers ?? []),
      releaseIds: trackReleases ? releases.map((item) => item.id).slice(-MAX_KNOWN) : (previous?.releaseIds ?? []),
      checkedAt: nowMs
    },
    repo: {
      repo,
      stars,
      forks,
      openIssues,
      openPulls,
      starDelta,
      forkDelta,
      issues: newIssues.slice(0, MAX_EVENTS),
      pulls: newPulls.slice(0, MAX_EVENTS),
      releases: newReleases.slice(0, MAX_EVENTS),
      baseline
    },
    drafts
  };
}

async function fetchJson(http, url, headers, label) {
  const response = await http.fetch(url, { headers });
  try {
    return JSON.parse(response.body);
  } catch (error) {
    throw new Error(`${label} 响应不是合法 JSON：${error?.message ?? error}`);
  }
}

function isStopError(error) {
  const name = String(error?.name ?? '');
  return name === 'LifeAuthError' || name === 'LifeQuotaError' || Number(error?.status) === 401;
}

export default {
  id: 'github',
  maxBytes: 1024 * 1024,
  allowedHosts,
  async sync({ config, http, now, cursor }) {
    const nowMs = now();
    const repos = normalizeRepoList(config?.repos);
    const previous = parseCursor(cursor);
    const prevRepos = previous?.repos && typeof previous.repos === 'object' ? { ...previous.repos } : {};
    const headers = {
      accept: 'application/vnd.github+json',
      'x-github-api-version': '2022-11-28'
    };
    if (config?.token) headers.authorization = `Bearer ${String(config.token)}`;
    const metrics = config?.metrics && typeof config.metrics === 'object' ? config.metrics : {};
    const trackIssues = metrics.issues !== false;
    const trackPulls = metrics.pulls !== false;
    const trackReleases = metrics.releases !== false;

    const results = [];
    const drafts = [];
    const errors = [];
    for (const repo of repos) {
      try {
        const meta = parseRepoMeta(await fetchJson(http, repoUrl(repo), headers, `${repo} 元数据`));
        if (!meta) throw new Error('仓库元数据为空');
        let issues = [];
        let pulls = [];
        let releases = [];
        if (trackIssues) {
          issues = parseRepoIssues(await fetchJson(http, repoUrl(repo, '/issues?state=open&per_page=100&sort=created&direction=desc'), headers, `${repo} issues`));
        }
        if (trackIssues || trackPulls) {
          pulls = parseRepoPulls(await fetchJson(http, repoUrl(repo, '/pulls?state=open&per_page=100&sort=created&direction=desc'), headers, `${repo} pulls`));
        }
        if (trackReleases) {
          releases = parseReleases(await fetchJson(http, repoUrl(repo, '/releases?per_page=30'), headers, `${repo} releases`));
        }
        const delta = buildRepoDelta({
          repo,
          meta,
          issues,
          pulls,
          releases,
          previous: prevRepos[repo] ?? null,
          nowMs,
          trackIssues,
          trackPulls,
          trackReleases
        });
        prevRepos[repo] = delta.snapshot;
        results.push(delta.repo);
        drafts.push(...delta.drafts);
        if (releases.length) prevRepos[repo].releaseIds = releases.map((item) => item.id).slice(-MAX_KNOWN);
      } catch (error) {
        if (isStopError(error)) throw error;
        const message = String(error?.message ?? error).slice(0, 200);
        errors.push({ repo, error: message });
        results.push({ repo, error: message });
      }
    }

    if (repos.length && results.length && results.every((item) => item.error)) {
      throw new Error(`GitHub 全部仓库抓取失败：${errors[0]?.error ?? '未知错误'}`);
    }
    const baseline = repos.length > 0 && results.length > 0 && results.every((item) => item.baseline === true);
    return {
      items: drafts.slice(0, 200),
      cursor: JSON.stringify({ v: 1, repos: prevRepos, at: nowMs }),
      meta: {
        baseline,
        repos: results,
        errors,
        anonymous: !config?.token,
        changes: results.reduce((sum, item) => sum + (item.issues?.length ?? 0) + (item.pulls?.length ?? 0) + (item.releases?.length ?? 0), 0)
      }
    };
  }
};
