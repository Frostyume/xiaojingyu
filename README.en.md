<p align="center">
  <img src="assets/banner.png" alt="Xiaojingyu · a companion AI that lives in QQ" width="100%">
</p>

<h1 align="center">Xiaojingyu</h1>

<p align="center"><b>A companion AI that lives in your QQ.</b><br>
She is present the way a friend is: she reads the room, picks her moment, remembers what you told her,
and actually does things when you ask.</p>

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

> ⚠️ **Development build (`0.0.0`, not released), targets DSH 0.2.0-rc.2** (verified item by item on that version; run `npm run verify:adaptation`). It uses the persistent local signing key to **mint the session Cookie offline**, slash RPC endpoints and the `/api/remote.mux` event stream — a protocol generation introduced in DSH `0.1.2-alpha.1`, incompatible with the older dot-endpoint protocol. Reading the launch token out of the old guard logs has not worked since DSH 0.1.7 (the token is generated per process and never written to disk). Agent presets are `@deepseek-ai/dsh-agent-preset` Cordis rows since DSH 0.1.7 (the `~/.dsh/.agent-presets/` directory mechanism is gone). On **DSH `0.1.1-rc.2` or earlier**, use tag [`v0.1.0`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.0); for **DSH 0.1.5-rc.1** use [`v0.1.5`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.5); for **DSH 0.1.7-rc.2** use [`v0.1.7`](https://github.com/Derpyu520/qq-bridge/releases/tag/v0.1.7).
>
> The tags above are **upstream releases** ([Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)); this repository has no tags or releases yet and ships a `0.0.0` development snapshot.
>
> The default branch `main` **is** this version — a plain `git clone` gets it, no branch switching needed.

**Contents**: [Who she is](#who-she-is) · [Scenes](#scenes) · [Life of a message](#life-of-a-message) · [A life of her own](#a-life-of-her-own) · [Capabilities](#capabilities) · [Live page](#live-status-page-live) · [Local console](#local-console) · [Architecture](#architecture) · [One-sentence deploy](#one-sentence-deploy-for-people-who-do-not-code) · [Quick start](#quick-start) · [Limitations](#limitations) · [Compatibility and extending](#compatibility-and-extending) · [Security](#security-notes) · [Layout](#repository-layout) · [Upstream](#upstream-and-license)

## Who she is

Xiaojingyu is not a support bot and not a "message in, reply out" script. She is an AI companion
that stays in your QQ with her own name, voice, mood and memory. She dives, she picks up jokes, and
when you say "kind of falling apart today" she asks whether the project is still due Friday.

She lives where you already are — group chats and DMs. No new app, no new habit: your friends keep
chatting as usual, and she is simply the member who occasionally says something that sounds human.

| She has | She does not |
| --- | --- |
| **A persona**: two prompt layers, one for behaviour boundaries and one for character and tone, both editable in the console | **Take over the account**: she is an ordinary member with no admin powers |
| **Memory**: topics, pending thoughts, member impressions, cross-session personal memory — all viewable and deletable | **Flood the chat**: wake rate, night silence and clingy follow-ups all have hard caps |
| **Pacing**: she decides whether to look, wait, speak or keep diving | **Reach your machine**: no amount of prompting gives group members local tools |
| **A toolbox**: read, speak, stickers, search, reminders — each switchable | **Ship data out**: the whole link runs on `127.0.0.1` |

**What she deliberately does not do:**

- she does not inject into QQ or deploy SnowLuma — native hooks are SnowLuma's job, she only talks to
  its OneBot endpoints;
- she never messages outside the whitelist, and has no mute / kick / upload / download group actions;
- she never drops raw DSH / SnowLuma errors into a group, only one plain sentence;
- she does not send voice by default (AI voice has to be enabled by hand).

## Scenes

<p align="center">
  <img src="assets/diagrams/scenes.en.png" width="100%" alt="Three scenes: in a group, in a DM, and when something actually needs doing">
  <br>
  <sub>Three everyday scenes (illustrative dialogue): picking her moment, remembering you, getting things done</sub>
</p>

**① In a group, she does not steal the floor.**
Out of a few hundred messages a day she only looks up when she is called, asked, or when the topic
lands somewhere she knows. Seven unread, one line back is enough; if she has nothing to add she keeps
diving — silence is also a way of being present. She knows who jokes around in this group and who is
busy this week, so her reply does not read like a weather report.

**② In a DM, she remembers you.**
"Kind of falling apart today" needs no recap. She knows the project is due Friday and that you wanted
two days by the sea afterwards. That is not re-asked every time — it is memory kept across sessions,
and you can browse, edit or delete any of it in the console.

**③ When asked, she actually does it.**
Duty rosters, research, reminders, tidying up chat logs — she reads group history, checks members,
searches when needed, then sends the result as a few short messages. Anything private or out of bounds
gets a question first, not an action.

More everyday jobs:

| Everyday need | What she does |
| --- | --- |
| A wake-up call | A scheduled reminder in her own voice, not a system notification |
| The group goes quiet | After a long idle period a probability decides whether to start a topic, not a fixed push |
| Someone posts an image or sticker | Images enter the multimodal context; the sticker library has notes and tags |
| You want to hear her | Voice library + TTS emotion; she can only speak clips in `audio/` (off by default) |
| New slang appears | Candidates are extracted; she only uses an entry after you confirm meaning, usage and risk |
| You want to see what she is up to | `/live` on a second monitor: mood, energy, bonds, inner life, current activity |
| You want her to remember something | Say it once — it goes into cross-session memory, and you can delete it any time |

## Life of a message

In `simulation` mode (the default) a message **does not** trigger one automatic reply. She only stores
the QQ event reliably, then decides for herself whether to look, whether to speak, how many messages to
send, or whether to keep diving.

<p align="center">
  <img src="assets/diagrams/message-flow.en.png" width="100%" alt="The life of a message: trigger, think, act">
  <br>
  <sub>Trigger → think → act: before deciding what to say, she decides whether to speak at all</sub>
</p>

### Tools the agent holds

- **Read**: unread queue, recent messages, one message in detail, message images, merged forwards,
  active members and her own recent sends (to avoid repeating herself);
- **Speak**: unified send, burst send, quote reply, poke, collect sticker, voice clip — intervals are
  spread out to feel human;
- **Wait**: `qq_wait_for_messages` waits briefly for new messages, returns immediately when one arrives,
  and returns on timeout so she can decide again;
- **Pacing**: `qq_set_wake_config` sets the next wake trigger (indefinite / at a time / @ / name / keyword /
  question / poke / probability), `qq_mark_read` means "seen but staying silent", and `qq_social_state`
  shows unread and wake state;
- **Memory**: `qq_memory_append` / `qq_memory_query` record topics, pending thoughts, member impressions
  and cross-session personal memory;
- **Slang**: `qq_slang_query` reads confirmed entries; `qq_slang_submit` hands unfamiliar expressions to
  the operator;
- **Life skills**: weather, rock-paper-scissors / dice / daily whale fortune, scheduled reminders
  (owner DM and family group).

The console's **Simulation** page turns every tool into an independent switch. Turning one off removes
it from the DSH tool list; voice, sticker, collection and send tools can each be disabled separately.

<p align="center">
  <img src="assets/screenshots/console-simulation.png" width="860" alt="Console simulation page">
  <br>
  <sub>Simulation page: tool switches, wake suggestions and hard limits, send limits (offline demo data)</sub>
</p>

### Pacing and boundaries

- **Wake hard limits**: minimum / maximum dive time, wakes per minute / hour, merge window, no-action
  fallback count, wake wrap-up reminders, forced wait before sleeping;
- **Night silence**: a configurable window in which no proactive message is sent;
- **Clingy follow-up**: when the owner does not answer a DM, a configured number of follow-ups are sent
  at configured intervals, never an unbounded loop;
- **Proactive checks**: after a long idle period a probability decides whether to start a topic, instead
  of a fixed-frequency push;
- **Per-group configuration**: initial prompt, group profile, style notes and whether proactive speech
  is allowed;
- **Send boundary**: every send hits the whitelist; sensitive paths, tokens and cookies are blocked by
  the audit layer; QQ / SnowLuma / DSH internal errors go to logs, never to the group.

## A life of her own

<p align="center">
  <img src="assets/screenshots/live.png" width="860" alt="Inner life, mood and bonds on the live status page">
  <br>
  <sub>Her mood, interests and "what she wants to do next" all live on the status page (offline demo data)</sub>
</p>

Not every message deserves a reply, and she does not stop existing when the room goes quiet. Xiaojingyu
keeps her own schedule: she reflects, gets curious, finds something worth sharing, and settles down late
at night.

### Inner life: moods are not random numbers

- **Scheduled reflection**: every 1–8 hours she wakes at random to look back over recent chats,
  relationships and her own state, then updates mood, energy, interests, things learned and verbal tics;
- **Curious browsing**: 5–12 times a day she reads Bilibili trending, matches and RSS feeds, and turns
  what she finds into candidate stories;
- **Mood has inertia**: mood decays against real time with a half-life and energy follows Beijing time;
  hourly and daily change budgets stop one sentence from flipping her from happy to broken;
- **Reflection never speaks**: it only updates state — whether to share is a separate decision;
- **Observable**: the console shows mood curves and inner state, `/live` has an **inner life** panel,
  and a DM with `内心状态` prints it too.

### Proactive sharing: sometimes she wants to show you something

- **Group share**: pick one candidate from curious browsing and post it to a chosen group; at most 20 a
  day, 15 minutes between shares per group, the group must have been quiet for 2 minutes, and never
  during night silence;
- **Qzone posts**: friends-visible by default, at most 2 a day, optionally review-before-publish;
- **Share modules**: 9 templates (findings, daily life, questions…); a new module starts on
  **probation** — the first few go to your DM as drafts, and it only auto-posts after you reply
  `验证通过 <id>`;
- **AI tips**: off by default; when enabled, 2–5 a day between 09:00 and 22:00;
- **No spam**: every proactive message is bounded by daily caps, intervals and quiet hours; when the
  budget is gone she simply keeps diving.

### DM as console: manage her without opening a browser

Owner QQ only, private chat only. You can just say:

| You say | She does |
| --- | --- |
| `内心状态` | Report current mood, energy, interests and what she plans to do next |
| `发` / `不发` | Approve or reject the latest Qzone draft |
| `跑一次说说` / `跑一次分享` / `反思一下` | Run that task once, right now |
| `发分享 <id>` / `不发分享 <id>` / `暂停分享 <id>` / `恢复分享 <id>` | Manage candidate stories |
| `验证通过 <id>` | Promote a share module out of probation |
| `关说说` / `开说说` / `关AI分享` / `开AI分享` | Toggle the matching capability |
| `预览三个AI知识` / `用第N种` | Pick a wording for the AI tip |
| `删说说` / `改签名` / `收藏表情` | Everyday maintenance |
| Anything else | Treated as a revision note for the draft waiting for review |

Risky actions (cross-session sends, sensitive operations) ask you to reply `/确认 <6-digit code>` in the
same DM. This DM surface is **not a full admin panel**: editing config, restarting the process and
running commands still happen only in the console or on the machine itself.

## Capabilities

| Area | Concrete behaviour |
| --- | --- |
| **Presence in group chats** | She reads unread messages, decides whether to speak, waits for the next wave, or keeps diving. 35 per-tool switches; wake triggers on @ / name / keyword / question / poke / probability; per-group initial prompt and group profile. |
| **Human pacing** | Hard limits for sleep, rate, night silence and clingy follow-ups; sends are spread out at a human rhythm; after a long idle period a probability decides whether to start a topic. |
| **Two prompt layers** | The **simulation prompt** owns the tool protocol and behaviour boundaries; the **persona prompt** owns character and voice. Role cards can be created, edited, renamed, duplicated and deleted, with per-mode filtering and an injection character cap. |
| **Memory and relationships** | Active topics, pending thoughts, member impressions and cross-session personal memory; relationship axes per member, daily-report preview, mood / energy / interest and inner-life timelines. |
| **A life of her own** | Scheduled reflection, curious browsing and evolving mood / energy / interests; group shares and Qzone posts capped per day, spaced out and silenced at night; new share modules go to the owner DM as drafts and only auto-post after approval. |
| **DM as console** | The owner can check inner state, review post drafts, toggle sharing, promote candidates and change the signature from a private chat; risky actions need `/确认 <6-digit code>`. |
| **Slang learning** | Candidates are extracted from group history; a human confirms meaning, usage, examples, risk and source before an entry enters the vocabulary. Confirmed entries are injected into the prompt and exposed through query / submit tools; thresholds and injection size are configurable. |
| **Multimodal expression** | Images, emoji and animated images enter the context; sticker notes, tags and image understanding; quote replies, pokes and burst sends; voice library with TTS emotion; inbound voice ASR transcription (off by default). |
| **Group insight** | Member relationship table with editable values, daily-report preview, active members and group profile; the daily report stays off until enabled. |
| **Live status page** | `/live` is a single-page SSE view: pixel whale and mood bubble, bonds, mood / energy with a 7-day curve, interests and growth, inner life, current activity, sessions, recent events, service health, cumulative tokens, long-term memory and libraries. Read-only; suited to a second monitor. |
| **Local console** | 13 task pages for mode switching, sessions and approvals, persona editing, tool switches, slang, libraries, cost, security, operations, reliability and tool reference; light / dark themes, responsive layout, cross-page search. |
| **Reliability core** | SQLite/WAL; idempotent outbox with replay, inbox dedupe, job queue; messages queue per conversation while DSH is down and are replayed on recovery; `npm run doctor` health check. |
| **Cost dashboard** | Priced with DeepSeek's official peak / off-peak table; drill-down per group, friend and turn; cache-hit vs miss split; 24-hour / 3-day / 7-day / 30-day trend. |
| **Secure defaults** | An empty whitelist means no responses; simulation sessions have no local execution tools; sends require a whitelist hit plus sensitive-text audit; cross-session instructions require a confirmation code; internal errors never reach the group; `state/` can be ACL-hardened. |
| **DSH adaptation** | Session Cookie minted offline from the persistent `~/.dsh` signing key; slash RPC plus `/api/remote.mux` event stream; preset bundle patch; three restricted MCP servers; one-command `install-dsh.mjs` install. |

## Live status page `/live`

<p align="center">
  <img src="assets/screenshots/live.png" width="860" alt="Live status page: whale, bonds, mood and inner life">
  <br>
  <sub>Read-only live status page (offline demo data); no real account is shown</sub>
</p>

`/live` is for people who want to keep an eye on what she is doing. It refreshes over SSE, needs no
manual reload, and offers no action that changes state:

- **The whale**: the pixel sprite changes with mood (wave / idle / excited / tired / pout), next to the
  current mood bubble;
- **Bonds**: relationship warmth with the owner and individual members, plus the latest interaction;
- **Mood / energy**: a two-axis mood compass, 7-day mood curve, energy bar and the cause of the current mood;
- **Interests / growth**: long-term interest weights, recent learnings, quirks and small habits;
- **Inner life**: what she plans to do next, pending thoughts and today's counts;
- **Activity**: whether she is diving, active, waiting or woken, and why;
- **Sessions and events**: phase, unread count and recent event stream for every group / DM;
- **Service health**: live state of the bridge, DSH and the SnowLuma upstream;
- **Usage**: token and cost summary;
- **Memory and libraries**: memory counts and sticker / image / voice library sizes.

The page has its own access token, listens on `127.0.0.1` by default, and reconnects automatically when
the SSE stream drops. It works well on a second monitor, a streaming overlay, or another device on the
same LAN.

## Local console

<p align="center">
  <img src="assets/screenshots/console-overview.png" width="860" alt="Console overview (light theme)">
  <br>
  <sub>Overview · light theme (offline demo data; the dark theme is in <a href="assets/screenshots/console-dark.png">console-dark.png</a>)</sub>
</p>

The console runs at `http://127.0.0.1:3100` and needs a token (generated into `state/console-token`
when none is configured). Its 13 pages each cover one kind of task:

| Page | What you can do |
| --- | --- |
| **Overview** | DSH / SnowLuma health cards, current mode and persona, pending questions and approvals, silence switch, DSH reasoning effort, recent 100 activity lines. |
| **Features** | Current capabilities grouped by persona, media, inner life, life skills and runtime; active groups, session count and boundaries. |
| **Sessions & approvals** | QQ ↔ DSH session mapping, phase and unread per session, questions and tool approvals waiting for the owner. |
| **Persona & roles** | Create / edit / rename / delete role cards, inspect and edit both prompt layers, injection cap, simulation-prompt sync state. |
| **Simulation** | 35 tool switches, wake recommendations and hard limits, initial prompt, group profile, memory and state viewers, tool-call log, feedback, voice and sticker settings. |
| **Group insights** | Member relationship table with editable values, daily-report preview, active members and group profiles. |
| **Library** | Names, descriptions, notes and tags for QQ favourite stickers and the image library; filter and inspect. |
| **Slang** | Candidate / confirmed / rejected columns; a confirmation dialog for meaning, usage, examples, risk and source; extraction thresholds and injection size. |
| **Usage & cost** | Total cost, cumulative tokens, cache hit rate, average per turn; drill-down by conversation and turn; 24-hour / 3-day / 7-day / 30-day trend. |
| **Access & security** | Allow / deny lists, owner QQ, console token, `state/` ACL warning and one-click re-check. |
| **Debug & operations** | Test message, notify the agent, maintain the bridge process, session workspace, cleanup and diagnostics. |
| **Reliability & config** | outbox / jobs / inbox queue state, retry failed items, edit configuration directly against the schema. |
| **Tool reference** | MCP tool list exposed to DSH, with parameters and purpose, grouped by namespace. |

Interface details:

- **Light / dark themes**: follows the OS preference first, remembers a manual choice afterwards;
- **Responsive**: desktop sidebar, tablet and phone switch to a top horizontal nav; tables scroll
  horizontally without page-level overflow;
- **Draft protection**: changing pages or a 3-second polling refresh does not discard unsaved form input;
- **Cross-page search**: type a feature or parameter name and jump to the page and control;
- **Accessibility**: keyboard focus rings, skip-to-content, decorative animation disabled under
  `prefers-reduced-motion`;
- **Fully offline**: no external fonts, CDN or analytics; `npm run preview:console` browses every page
  with synthetic data without DSH or QQ.

## Architecture

<p align="center">
  <img src="assets/diagrams/architecture.en.png" width="100%" alt="Xiaojingyu architecture: QQ ↔ SnowLuma ↔ local bridge ↔ DeepSeek Harness">
  <br>
  <sub>Where she lives: every hop stays on your own machine</sub>
</p>

A conversation runs roughly like this:

```mermaid
sequenceDiagram
  autonumber
  participant U as Group member
  participant S as SnowLuma
  participant B as Xiaojingyu bridge
  participant D as DSH agent

  U->>S: speaks in the group
  S->>B: OneBot v11 event
  B->>D: delivered to that group's DSH session
  D->>B: calls qq_get_unread_messages / qq_send_message
  B->>S: whitelist check + audit, then send
  S->>U: reply appears in QQ
```

- **One QQ conversation = one DSH session**, grouped into a "QQ 聊天" workspace, with the mapping
  persisted in `state/sessions.json`;
- **All three MCP servers expose only a safe subset**: `snowluma` (QQ actions), `snowluma-host`
  (read-only probe) and `web-search-safe` (search / fetch with SSRF protection);
- **Auth never touches process memory**: the session cookie is minted offline from the persistent
  signing key in `~/.dsh`, so no DSH launch token is needed (it has lived only in memory since DSH 0.1.7);
- **Persona and memory are local files**: who she is lives in `personas/`, what she remembers lives in
  `state/` — both can be backed up, moved or deleted.

### DSH-side details (DSH 0.2.0-rc.2)

- **QQ side**: `@snowluma/sdk` provides the OneBot v11 WebSocket client.
- **DSH side**: session Cookie minted from the persistent local signing key, `/api/<namespace>/<method>`
  slash RPC, and `/api/remote.mux` + `session/follow` event stream (the pending queue is read from
  `value.projections[<id>].values.inbox`, with the unary `session/projections` RPC as the primary path).
  The per-session model is pinned by the bridge via `session.selectModel` from `config.json`'s `dsh.model`
  (default `deepseek-flash` = DeepSeek-V41-Flash, multimodal).
- **Agent tools**: three bundled MCP servers expose a restricted QQ toolset (`qq_status`, `qq_list_groups`,
  `qq_get_group_history`, `qq_send_group_message`, `qq_reply`, etc.), a read-only host probe
  (`snowluma_status` only), and a read-only `web_search` / `web_fetch` pair with SSRF protection.
  ⚠️ **`start_snowluma` / `stop_snowluma` (and `snowluma.allowProcessControl`) were removed in v0.1.5**:
  SnowLuma EULA §5.4 requires prior written permission to deploy its proprietary native components
  through automated scripts. This program only probes, never deploys — installing, starting and scanning
  SnowLuma is always up to you. See [NOTICE](NOTICE) and [RULES.md](RULES.md).
- **Console and live view**: a local web console at `http://127.0.0.1:3100` (13 task pages, a live status
  ribbon for DSH / SnowLuma / mode / sessions / pending approvals, an icon rail, cross-page search and a
  light / dark theme) plus the read-only `/live` SSE page.

## Requirements

- Node.js >= 22.13
- Windows 10 / 11 (both QQ and SnowLuma are Windows programs)
- Running DeepSeek Harness Web (default `http://127.0.0.1:3080`)
- Running SnowLuma with OneBot v11 WebSocket and HTTP API enabled

## One-sentence deploy (for people who do not code)

<p align="center">
  <img src="assets/diagrams/deploy.en.png" width="100%" alt="One-sentence deploy: six steps, two of them yours">
  <br>
  <sub>Six steps; only two need your hands — signing in to SnowLuma, and providing QQ / group numbers</sub>
</p>

You do not need to understand Node, DSH or OneBot. Open Codex, Claude Code, Qoder or DSH and send it:

> Deploy <https://github.com/Frostyume/xiaojingyu> for me on Windows. Read
> `docs/guides/AGENT_DEPLOY.md` in the repository first and follow it exactly: check the environment,
> install dependencies, write the config, run `install-dsh` and `doctor` until everything passes.
> Except for signing in to SnowLuma by QR code and providing my QQ number / group numbers, do
> everything yourself. Do not print or upload anything from `config.json` or `state/` — no tokens,
> cookies or account numbers.

The agent handles the environment check, clone, dependencies, config, DSH-side install, start-up and
health check. Only two things are yours:

1. **Download SnowLuma and sign in by QR code** — its licence does not allow scripts to install or start it;
2. **Tell the agent your QQ number, the group numbers to allow, and the OneBot token**.

Done means `npm run doctor` is all green, a whitelisted DM gets a reply, and the console opens — not
"the command finished". The full step-by-step contract, troubleshooting table and rollback live in
[docs/guides/AGENT_DEPLOY.md](docs/guides/AGENT_DEPLOY.md).

> Prefer doing it yourself? The six steps below are the same flow the agent runs.

## Quick start

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

An empty whitelist with `allowAllWhenEmpty: false` means she **answers nothing** — a deliberate
fail-closed default.

Start:

```bash
npm start
```

Or double-click `bin/boot.cmd` on Windows (guard mode with auto-restart).

### DSH setup, once per machine

The bridge and console can run without extra DSH setup, but the DSH chat preset (`qq-chat`) and the MCP servers must be installed into DSH once per machine:

```bash
node tools/install-dsh.mjs
```

This installs:

- the `agent-presets` bundle, which generates the `@deepseek-ai/dsh-agent-preset` row (`qq-chat`) plus the shared `qq-tool-restrict` safety guard
- MCP entries in `~/.dsh/profiles/web/cordis.patch.yml`
- `mode-console` and `agent-presets` in the profile `package.json` (`bundles` + `link:` dependencies)
- Default DSH mode set to `simulation`, with a local `state/mode.json` fallback

Then restart DSH. See [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) for details.

## Limitations

- Agent replies are sent once at the end of a turn, not streamed token by token; long replies are split
  at sentence / URL boundaries;
- Images, stickers and merged forwards enter the multimodal context; inbound voice is transcribed only
  when `simulation.speech.asr.enabled` is on (off by default, otherwise a placeholder is shown); video
  messages currently show a placeholder;
- **AI voice is off by default** (`simulation.voice.enabled` and `tools.sendVoice` are both `false`):
  put audio into `audio/`, then enable it in the console. Sample clips live in
  [`assets/voice/`](assets/voice/);
- Agent Markdown replies are converted to plain text before sending (links keep the `text (url)` form);
- Windows 10 / 11 only: both QQ and SnowLuma are Windows programs;
- Only `simulation` / `closed-agent` are first-class modes; earlier `chat` / `reserved` need a
  `qq-chat-legacy` preset that is not shipped.

## Compatibility and extending

### Compatibility matrix

| Component | Supported | Notes |
| --- | --- | --- |
| **OS** | Windows 10 / 11 x64 | QQ and SnowLuma are Windows programs; Linux / macOS are not supported |
| **Node.js** | ≥ 22.13, 24 recommended | Uses the built-in `node:sqlite`; Node 22 needs `--experimental-sqlite`. The Node 24 CI job is the real gate |
| **DSH** | Adapted to 0.2.0-rc.2 | Relies on slash RPC, the `/api/remote.mux` event stream and the 0.1.7+ agent-presets mechanism; run `npm run verify:adaptation` before moving to a new major version |
| **SnowLuma** | OneBot v11 (WebSocket + HTTP) | Not distributed with the repo and never started by it; defaults `ws://127.0.0.1:3001` / `http://127.0.0.1:3000` |
| **Database** | SQLite (WAL) | No extra service; data lives in `state/db/bridge.db` |
| **Deployment** | Single machine, loopback only | Console and DSH listen on `127.0.0.1` by default; no multi-tenant or public hosting |

### Extension points

| Extension point | How | Boundary |
| --- | --- | --- |
| **Persona card** | Drop `<name>.md` into `personas/`, or edit it under Persona & roles in the console | A group member asking her to change persona has no effect; the persona is injected bridge-side only |
| **Feature plugin** | Export a manifest from `features/<id>/index.js`; the directory name must equal `id` | Loaded in-process, no sandbox — only load code you trust |
| **MCP tools** | Extend a server under `mcp/`, then re-run `install-dsh` | The chat preset only exposes a safe subset; never put local-execution tools in it |
| **DSH preset** | Edit `integrations/dsh/presets/qq-chat/agent.cordis.yml`, then reinstall | A broken preset fails closed and refuses to create sessions |
| **Config** | Edit `config.example.json`, then `npm run schema:config` | CI uses `--check` to prevent schema drift |
| **Console page** | Single-page `web/deck.html` plus `console/` routes | No plugin registration point yet; a new page means changing the main program |

A minimal feature plugin looks like this:

```js
// features/hello/index.js — the directory name must be hello
export default {
  id: 'hello',
  name: 'Sample feature',
  version: 1,
  description: 'Reply once when a message contains hello',
  permissions: ['state:read', 'qq:send'],
  hooks: {
    async onMessage(payload, ctx) {
      if (!payload?.text?.includes('hello')) return;
      await ctx.send(payload.key, '你好呀');
    }
  }
};
```

The loader registers `onMessage`, `onWake`, `onTurnEnd`, `onSchedule`, `beforeSend` and
`onConsoleRequest`, plus the synchronous `formatSegment` (message to text). **The main flow currently
dispatches only `message` and `formatSegment`; the other hooks and permissions such as
`prompt:inject`, `service:memory` and `console:route` are reserved interfaces** — secondary development
has to wire them into the main flow itself or wait for upstream. The available `ctx` is `cfg` / `log` /
`now` / `getState()` (`state:read`) / `jobs` (`jobs:write`) / `send()` (`qq:send`) /
`dailyReport` (`service:daily-report`). A plugin that throws only disables itself, never the bridge;
turn it off by id in `features.disabled` in `config.json`.

### Development loop

```bash
npm run verify          # schema + console contracts + full core / stage / audit regression
npm run test:console-ui # console offline browser regression
npm run test:audit      # 47 offline scripts
npm run doctor          # real-machine health check
```

For anything touching QQ sends, DSH sessions or a real account, cover it with the fixtures under
`tests/` first — never test against a real group.

## Security notes

- `config.json` and `state/` are **never committed**; the repository only ships `config.example.json`. Both are ACL-hardened to the owner / SYSTEM / Administrators (`npm run harden-acl`).
- MCP send tools enforce whitelist checks and reject CQ-code injection.
- Local paths, credentials, tokens and other sensitive patterns are filtered by the audit layer.
- Simulation sessions get **no local execution tools at all**: the preset's `qq-tool-restrict` row hides them from the tool schema at registration time and a runtime allowlist rejects anything outside the QQ MCP namespaces (`npm run scan:tool-names` re-checks that list against the installed DSH).
- The console uses a generated token when none is configured.
- Found a security issue? Report it privately per [SECURITY.md](SECURITY.md) — please do not open a public issue.

## Documentation

| Doc | What it covers |
| --- | --- |
| [docs/README.md](docs/README.md) | Documentation index (one line per page) |
| [docs/guides/AGENT_DEPLOY.md](docs/guides/AGENT_DEPLOY.md) | One-sentence deploy: the agent's steps, boundaries, acceptance and rollback |
| [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) | DSH-side install: preset, MCP, restart |
| [docs/guides/DSH_ADAPTATION.md](docs/guides/DSH_ADAPTATION.md) | DSH 0.2.0-rc.2 adaptation notes |
| [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md) | Security baseline and Windows ACL |
| [docs/guides/RELIABILITY.md](docs/guides/RELIABILITY.md) | outbox / queue / retry mechanics |
| [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md) | Cost dashboard pricing and method |
| [docs/guides/CONSOLE-UI-TESTING.md](docs/guides/CONSOLE-UI-TESTING.md) | Console offline regression and preview |
| [docs/guides/PRIVACY.md](docs/guides/PRIVACY.md) | What leaves the machine, privacy switches |
| [RULES.md](RULES.md) | Permission boundaries for QQ sessions |
| [SECURITY.md](SECURITY.md) | Vulnerability reporting |
| [UPSTREAM.md](UPSTREAM.md) | Fork point and sync rules |
| [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md) | Folder layout and script naming conventions |
| [NOTICE](NOTICE) | Third-party components and licenses |

## Repository layout

```
xiaojingyu/
  config.example.json   # sanitized config template (real config.json is not in repo)
  app/                  # process entry points (whale.js, self-check.js)
  runtime/              # kernel / persona / sharing / control / orchestration
  services/             # persona, media and social capabilities
  channels/             # QQ (SnowLuma OneBot) and DSH adapters
  mcp/                  # the three MCP servers
  console/              # console server side (auth, /live, policy)
  features/             # pluggable features (daily report, rich cards)
  web/                  # deck.html console, live.html status page, assets/
  personas/             # persona cards
  integrations/dsh/     # preset source, agent-presets bundle, mode-console plugin
  docs/
    README.md           # documentation index (published docs only)
    FOLDER_MAP.md       # folder layout and tools/tests naming conventions
    guides/             # user/operator facing: DSH_SETUP, DSH_ADAPTATION, SECURITY_BASELINE,
                        # RELIABILITY, TOKEN_USAGE_CONSOLE, CONSOLE-UI-TESTING, PRIVACY
  tools/                # operations, build and test helper scripts
  tests/                # automated tests and baseline fixtures
  bin/                  # Windows launchers (boot.cmd / reboot.cmd)
  assets/
    banner.png          # README banner
    diagrams/           # README diagrams (HTML sources + rendered PNGs)
    screenshots/        # console screenshots (offline demo data)
    voice/              # two sample clips, copy into audio/ to use
  state/                # runtime data (not in repo)
```

Design/audit/research/legacy documents, the full project guide and the voice-tool notes are **not published** with this
repository (they were written on a real machine and contain local paths and account identifiers); see
[docs/README.md](docs/README.md) for what is included.

The standalone **voice sender tool** (`voice-cli.mjs`, `voice-gui.mjs`, `public/voice.html`) is **not part of this
repository**; it reuses this repo's `services/media/voice-core.js` / `channels/qq/gateway.js` as the shared implementation.

## Testing

`npm run test:audit` runs isolated regression tests without production credentials, DSH, or QQ messages. Security
boundaries and the current threat model are documented in [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md);
reliability mechanics (SQLite/WAL, outbox, inbox, jobs, doctor) are in [docs/guides/RELIABILITY.md](docs/guides/RELIABILITY.md).

After upgrading, legacy QQ session mappings without permission metadata are recreated once. Mode or preset changes also retire the old mapping and recreate the session on the next message; DSH history is retained.

```bash
npm run test:audit      # offline regression suite (CI main job)
npm run test:console-ui # offline browser regression for the console
npm run self-test       # DSH-side link test (creates an isolated test session)
npm run verify          # schema + console contracts + all core / stage / audit tests
npm run test-md
npm run test-wait
npm run test-vision
npm run test-forward
npm run test-slang
npm run test-stickers
```

## Upstream and license

This project started from the MIT-licensed [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)
(baseline `v0.2.0-r4`); thanks to its authors and contributors for the bridge skeleton. On top of that,
this repository has been substantially rewritten and extended with:

- a **group-chat simulation engine**: unread queue, wake triggers (@ / name / keyword / question / poke /
  probability), a short `qq_wait_for_messages` wait, burst sends, night silence, clingy follow-ups,
  per-group initial prompts and group profiles, and 35 MCP tool switches;
- a **read-only live page** (`/live`, SSE) showing mood, energy, bonds, interests, inner life, sessions,
  events, health, tokens and memory;
- a **local web console** with 13 task pages, light / dark themes, responsive layout, draft protection
  and cross-page search;
- a **reliability kernel**: SQLite/WAL, idempotent outbox with replay, inbox dedupe, job queue and
  doctor diagnostics;
- a **cost dashboard** priced with DeepSeek's peak / off-peak table, with per-group / friend / turn
  drill-down and 24-hour to 30-day trends;
- **DSH 0.2.0 adaptation**: slash RPC, the `/api/remote.mux` event stream, preset bundle patch and
  offline Cookie minting;
- **safety boundaries**: preset tool guards, send allowlists, reply auditing and voice-library limits.

The upstream name, copyright lines and MIT license are preserved in [LICENSE](LICENSE); see
[UPSTREAM.md](UPSTREAM.md) for the fork point and sync rules, and [NOTICE](NOTICE) for third-party
components. This repository has no tags or releases yet and ships a `0.0.0` development snapshot.

## Compliance

SnowLuma is an independent third-party project and is not affiliated with Tencent/QQ. This project is for learning and technical research only; please follow the relevant terms and the QQ User Agreement.
