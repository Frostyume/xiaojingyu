<p align="center">
  <img src="assets/banner.png" alt="xiaojingyu · qq-bridge" width="100%">
</p>

<h1 align="center">xiaojingyu · qq-bridge</h1>

<p align="center"><b>Turn QQ into a chat entrance for DeepSeek Harness.</b><br>
Your group chats stay exactly as they are — behind them is an agent that reads,
waits, and decides for itself whether it is worth speaking up.</p>

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-0.0.0%20dev-5B8DEF?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2022.13-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="platform" src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?style=flat-square&logo=windows&logoColor=white">
  <img alt="dsh" src="https://img.shields.io/badge/DSH-0.2.0--rc.2-1B1F3B?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square">
</p>

<p align="center">
  <a href="README.md">中文</a> ·
  <a href="docs/README.md">Docs</a> ·
  <a href="RULES.md">Rules</a> ·
  <a href="SECURITY.md">Security</a> ·
  <a href="UPSTREAM.md">Upstream</a>
</p>

> Connect QQ messages to DeepSeek Harness (DSH) agents: QQ friends/groups become DSH conversations, and agent replies (including questions and tool approvals) are sent back to QQ.

> ⚠️ **Development build (`0.0.0`, not released), targets DSH 0.2.0-rc.2** (verified item by item on that version; run `npm run verify:adaptation`). It uses the persistent local signing key to **mint the session Cookie offline**, slash RPC endpoints and the `/api/remote.mux` event stream — a protocol generation introduced in DSH `0.1.2-alpha.1`, incompatible with the older dot-endpoint protocol. Reading the launch token out of the old guard logs has not worked since DSH 0.1.7 (the token is generated per process and never written to disk). Agent presets are `@deepseek-ai/dsh-agent-preset` Cordis rows since DSH 0.1.7 (the `~/.dsh/.agent-presets/` directory mechanism is gone). On **DSH `0.1.1-rc.2` or earlier**, use tag [`v0.1.0`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.0); for **DSH 0.1.5-rc.1** use [`v0.1.5`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.5); for **DSH 0.1.7-rc.2** use [`v0.1.7`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.7).
>
> The tags above are **upstream releases** ([Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)); this repository has no tags or releases yet and ships a `0.0.0` development snapshot.
>
> The default branch `main` **is** this version — a plain `git clone` gets it, no branch switching needed.

For the detailed documentation (all Chinese), start from **[docs/README.md](docs/README.md)**;
the repository/folder and script-naming conventions are in **[docs/FOLDER_MAP.md](docs/FOLDER_MAP.md)**.

## Architecture

```
QQ messages ──► SnowLuma (OneBot v11 WS) ──► qq-bridge ──► DSH Web API (127.0.0.1:3080/api)
                                                    ▲                      │
                                                    └── agent replies / questions / approvals ┘
```

- **QQ side**: `@snowluma/sdk` provides the OneBot v11 WebSocket client.
- **DSH side**: adapted for DSH 0.1.2+ and **re-verified on 0.2.0-rc.2** — session Cookie minted from the persistent local signing key, `/api/<namespace>/<method>` slash RPC, and `/api/remote.mux` + `session/follow` event stream (the pending queue is read from `value.projections[<id>].values.inbox`, with the unary `session/projections` RPC as the primary path). The per-session model is pinned by the bridge via `session.selectModel` from `config.json`'s `dsh.model` (default `deepseek-flash` = DeepSeek-V41-Flash, multimodal).
- **Agent tools**: three bundled MCP servers expose a restricted QQ toolset (`qq_status`, `qq_list_groups`, `qq_get_group_history`, `qq_send_group_message`, `qq_reply`, etc.), a read-only host probe (`snowluma_status` only), and a read-only `web_search` / `web_fetch` pair with SSRF protection.
  ⚠️ **`start_snowluma` / `stop_snowluma` (and `snowluma.allowProcessControl`) were removed in v0.1.5**: SnowLuma EULA §5.4 requires prior written permission to deploy its proprietary native components through automated scripts. This program only probes, never deploys — installing, starting and scanning SnowLuma is always up to you. See [NOTICE](NOTICE) and [RULES.md](RULES.md).
- **Console**: a local web console at `http://127.0.0.1:3100`, organised into 13 task-based pages (Overview, Features, Sessions & Approvals, Persona, Social Simulation, Group Insights, Library, Slang, Usage & Cost, Access & Security, Debug & Operations, Reliability & Config, Tool Reference) with cross-page feature search and a **light / dark theme** (one-click toggle in the header; follows the OS preference until you choose), for mode switching, role management, whitelist/admin settings, slang management, memory, stickers and more. The Persona page manages roles (view/edit/rename/duplicate/delete the prompt of each persona), shows and edits both prompt layers separately — the **simulation prompt** built into the preset (tool/behaviour protocol; synced to DSH, restart required) and the **persona prompt** (`roles/*.md`; applied immediately) — and sets the **DSH reasoning effort** (`max` by default, `high`/`low` selectable). The **Usage & Cost** page shows real-time token consumption and its price in CNY, broken down per group/friend and per conversation turn (see [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md)).

## Features

- Bridges QQ group/private messages to DSH agent sessions.
- Social simulation mode ("simulated group friend") with idle/active/probing/exiting states.
- Space-based message splitting for more natural multi-message replies.
- Whitelist/blacklist access control, fail-closed by default.
- Sensitive text audit prevents paths/credentials from being sent to QQ.
- MCP tools for reading group history/members, sending messages, replying with quotes, and (in `reserved2`) full simulated-group-friend tooling.
- Slang/network-expression learning with human confirmation.
- Lightweight memory system for active topics, pending thoughts and member impressions.
- Sticker library integration with AI-friendly sticker usage.

## Requirements

- Node.js >= 22.13
- Running DeepSeek Harness Web (default `http://127.0.0.1:3080`)
- Running SnowLuma with OneBot v11 WebSocket and HTTP API enabled

## Quick Start

```bash
npm install        # postinstall automatically patches the @snowluma/sdk ESM packaging bug
```

Copy `config.example.json` to `config.json`, then edit:

```bash
cp config.example.json config.json
```

Key settings:

| Field | Description |
| --- | --- |
| `dsh.baseUrl` | DSH Web API URL, default `http://127.0.0.1:3080` |
| `dsh.authToken` | DSH launch token (a process-launch credential). **Normally leave this empty**: with no token the bridge mints the session cookie offline from the persistent signing key in `~/.dsh/.credentials.yaml`, which depends on no per-process state (since DSH 0.1.7 the launch token lives only in memory — the one in the old logs belongs to a previous process and only yields a 401). A value here is honoured first if you set one |
| `dsh.authHeader` / `dsh.authPrefix` | Legacy fields kept for compatibility; the current path uses Cookie auth and does not send this header |
| `snowluma.wsUrl` | SnowLuma OneBot **WebSocket** URL (e.g. `ws://127.0.0.1:3001`) |
| `snowluma.accessToken` | OneBot access token, leave empty if not configured |
| `snowluma.httpUrl` | OneBot **HTTP API** URL (e.g. `http://127.0.0.1:3000`); do not point this at the WebSocket port or you will get HTTP 426 |
| `ownerQQ` | Administrator QQ (highest privilege) |
| `allow.private` / `allow.groups` | Whitelist of QQ/group IDs |
| `consolePort` | Local console port, default `3100` |

Start:

```bash
npm start
```

Or double-click `start.bat` on Windows (guard mode with auto-restart).

## DSH Setup on Another Device

The bridge and console can run without extra DSH setup, but the two DSH chat presets (`qq-chat` and `qq-chat-v2`) and the MCP servers must be installed into DSH once per machine:

```bash
node scripts/setup-dsh.mjs
```

This installs:

- the `qq-agent-presets` bundle, which generates the two `@deepseek-ai/dsh-agent-preset` rows (`qq-chat`, `qq-chat-v2`) plus the shared `qq-tool-restrict` safety guard
- MCP entries in `~/.dsh/profiles/web/cordis.patch.yml`
- `qq-mode-console` and `qq-agent-presets` in the profile `package.json` (`bundles` + `link:` dependencies)
- Default DSH mode set to `reserved2` (second-generation simulation), with a local `state/mode.json` fallback

Then restart DSH. See [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) for details.

## Security Notes

- `config.json` and `state/` are **never committed**; the repository only ships `config.example.json`. Both are ACL-hardened to the owner / SYSTEM / Administrators (`npm run harden-acl`).
- MCP send tools enforce whitelist checks and reject CQ-code injection.
- Local paths, credentials, tokens and other sensitive patterns are filtered by the audit layer.
- Simulation sessions get **no local execution tools at all**: the preset's `qq-tool-restrict` row hides them from the tool schema at registration time and a runtime allowlist rejects anything outside the QQ MCP namespaces (`npm run scan:tool-names` re-checks that list against the installed DSH).
- The console uses a generated token when none is configured.
- Found a security issue? Report it privately per [SECURITY.md](SECURITY.md) — please do not open a public issue.

## Repository Layout

```
qq-bridge/
  config.example.json   # sanitized config template (real config.json is not in repo)
  docs/
    README.md           # documentation index (published docs only)
    FOLDER_MAP.md       # folder layout and scripts/ naming conventions
    guides/             # user/operator facing: DSH_SETUP, DSH_020_ADAPTATION, SECURITY_BASELINE,
                        # RELIABILITY, TOKEN_USAGE_CONSOLE, CONSOLE-UI-TESTING, PRIVACY
  dsh/agent-presets/    # qq-chat-v2 DSH agent preset source (the legacy qq-chat preset is not shipped)
  plugins/qq-agent-presets  # DSH bundle: generates the qq-chat-v2 preset patch row + the shared tool guard
  plugins/qq-mode-console  # DSH plugin: exposes the qq-mode settings namespace (host half only; no UI card yet)
  src/                  # bridge core and MCP servers
  public/
    console.html        # local web console
  roles/                # persona cards
  assets/               # README banner, console screenshot (offline demo data) and voice/ (two sample clips)
  scripts/              # tests and helper scripts
  state/                # runtime data (not in repo)
```

Design/audit/research/legacy documents, the full project guide and the voice-tool notes are **not published** with this
repository (they were written on a real machine and contain local paths and account identifiers); see
[docs/README.md](docs/README.md) for what is included.

The standalone **voice sender tool** (`voice-cli.mjs`, `voice-gui.mjs`, `public/voice.html`) is **not part of this
repository**; it reuses this repo's `src/voice-core.js` / `src/snowluma-conn.js` as the shared implementation.

## Testing

`npm run test:audit` runs isolated regression tests without production credentials, DSH, or QQ messages. Security
boundaries and the current threat model are documented in [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md);
reliability mechanics (SQLite/WAL, outbox, inbox, jobs, doctor) are in [docs/guides/RELIABILITY.md](docs/guides/RELIABILITY.md).

After upgrading, legacy QQ session mappings without permission metadata are recreated once. Mode or preset changes also retire the old mapping and recreate the session on the next message; DSH history is retained.

```bash
npm run self-test       # DSH-side link test, no QQ/SnowLuma required
npm run test-md
npm run test-wait
npm run test-vision
npm run test-forward
npm run test-slang
npm run test-stickers
```

## Compliance

SnowLuma is an independent third-party project and is not affiliated with Tencent/QQ. This project is for learning and technical research only; please follow the relevant terms and the QQ User Agreement.
