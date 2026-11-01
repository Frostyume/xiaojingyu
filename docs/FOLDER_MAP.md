# 仓库目录地图（FOLDER_MAP）

> 一句话说明每个顶层目录干什么、`tools/` 与 `tests/` 的命名约定是什么。
> 本文**只描述现状**，不构成改动指令。文档索引见 [README.md](README.md)。
>
> 最后核对：2026-10-30（结构与命名统一后的版本）。

---

## 一、顶层布局

```
DSH/                         ← 工作区根（不是仓库根）
├── xiaojingyu/              ← 本仓库（QQ ↔ DSH 桥接）
└── voice-tool/              ← 独立「发语音」工具（**不在本仓库内**，需要时自行放置）
```

`xiaojingyu/` 内部：

| 目录 | 作用 |
| --- | --- |
| `app/` | **进程入口**：`whale.js` 是桥接主程序（HTTP/WS 服务、控制台 API、会话编排）；`self-check.js` 是 DSH 侧链路自检 |
| `runtime/` | **不依赖 QQ 的运行时内核**，按职责分五个子目录（见第二节） |
| `services/` | **业务能力**：人格、媒体、社交；内部只依赖 `runtime/` 与 `channels/` |
| `channels/` | **外部协议适配**：`qq/gateway.js`（SnowLuma OneBot v11）、`dsh/client.js`（DSH RPC 与事件流） |
| `mcp/` | 三个 MCP server：`host.js`（宿主代理）、`qq-actions.js`（QQ 动作）、`web-search.js`（受限搜索） |
| `console/` | 控制台的**服务端半**：鉴权、只读状态页、策略 |
| `features/` | **可插拔功能**：每个子目录一个 `index.js` manifest（`daily-report`、`rich-cards`） |
| `web/` | 浏览器静态资源：`deck.html`（控制台）、`live.html`（实时状态页）、`assets/`（鲸鱼像素图） |
| `personas/` | 人格卡（`小鲸鱼.md`）与格式说明；控制台「人格」页保存即生效 |
| `integrations/dsh/` | 装进 DSH 的东西：preset 权威源、bundle、`mode-console` 插件（见第三节） |
| `tools/` | 运维 / 构建 / 测试辅助脚本（见第四节） |
| `tests/` | 自动化测试与基线夹具（见第五节） |
| `bin/` | Windows 启动器：`boot.cmd`、`reboot.cmd` |
| `assets/` | 仓库级素材：README 横幅、截图、示例语音 |
| `audio/` | **语音库**（用户的真实音频，`.gitignore` 排除）；AI 语音工具只发这里的文件 |
| `state/` | **运行时数据**（会话映射、模式、角色、黑话库、日志、锁、令牌），不入库 |
| `docs/` | 全部文档（见第六节） |
| `node_modules/` `.npm-cache/` | 依赖与 npm 缓存，忽略 |
| `config.json` | 运行配置（真实配置不入库）；模板是 `config.example.json` |

---

## 二、`runtime/` 分层

| 目录 | 内容 |
| --- | --- |
| `runtime/kernel/` | 可靠性与共享内核：`db.js`（SQLite 适配+迁移）、`outbox.js`、`inbox.js`、`jobs.js`、`config-store.js`、`config-schema.js`、`config-backup.js`、`event-bus.js`、`feature-loader.js`、`transport.js`、`budget.js`、`health.js`、`logger.js`、`memory.js`、`model-routing.js`、`prompt-budget.js`、`sensitive.js`、`session-map.js`、`session-router.mjs`、`state-file.js`、`state-acl.mjs`、`time-awareness.js`、`wake-score.js` |
| `runtime/persona/` | 人格运行时：`persona-mode.js`、`persona-pack.js`、`persona-voice.js`、`relationships.js` + `relationship-model.js`、`signature.js`、`speech.js`、`rich-card.js`、`mood-history.js`、`ai-tips.js`、`tts-emotion.js`、`tts-busy-retry.js` |
| `runtime/share/` | 分享排版：`share-format.js`、`share-modules.js`、`share-prompts.js`、`share-state.js` |
| `runtime/control/` | owner 权限与控制面：`control-tiers.js`、`controller-cli.js`、`owner-capabilities.js`、`owner-config.js`、`owner-features.js` |
| `runtime/orchestration/` | 任务编排：`orchestrator-queue.js`、`orchestrator-wake.js`、`assignment.js`、`code-proposal.js`、`dev-proposals.js`、`daily-report.js`、`feature-voice.js`、`qoder-sessions.js` |

业务模块不要直接 import `node:sqlite`；换驱动只改 `runtime/kernel/db.js`。
新功能优先放 `features/<id>/index.js`（manifest 声明 id/name/permissions/hooks），不要直接改主流程。

---

## 三、`integrations/dsh/`

| 路径 | 作用 |
| --- | --- |
| `presets/qq-chat/` | **preset 权威源**：`agent.cordis.yml`（人格正文与工具面）、`preset.yml`；`qq-tool-restrict.mjs` 只是 re-export 壳 |
| `agent-presets/` | **DSH bundle**：`package.json` 的 `dsh.bundle.patch` 指向 `presets/qq-chat.patch.yml`；`qq-tool-restrict.mjs` 是**唯一权威实现** |
| `mode-console/` | DSH 插件：暴露 `qq-mode` 设置命名空间（只有 host 半，浏览器卡片未实现） |

> `integrations/dsh/agent-presets/presets/*.patch.yml` 是**生成物**，由
> `tools/gen-preset-patches.mjs` 从 `integrations/dsh/presets/` 渲染；改 preset 后必须重跑，不要手改。
> 旧版 `qq-chat-legacy/` 不随仓库发布，桥接仍接受该名字（fail-closed）。

---

## 四、`tools/` 命名约定

| 前缀 / 文件 | 含义 | 入口 |
| --- | --- | --- |
| `healthcheck.mjs` | 一条命令定位常见故障：配置、SQLite/队列、DSH 端口、SnowLuma 端口、控制台 API、preset、日志、磁盘 | `npm run doctor` |
| `install-dsh.mjs` | 把 preset、MCP 挂载幂等写进目标设备的 DSH profile | `node tools/install-dsh.mjs` |
| `gen-preset-patches.mjs` | 从 preset 权威源生成 bundle patch | `node tools/gen-preset-patches.mjs` |
| `gen-config-schema.mjs` | 从 `config.example.json` 生成 `config.schema.json` | `npm run schema:config` |
| `gen-console-api.mjs` | 从 `app/whale.js` 抽取控制台路由，生成 golden 清单 | `--check` 已进 `verify` |
| `demo-console.mjs` | 离线控制台预览（mock 数据，不发请求） | `npm run preview:console` |
| `harden-acl.mjs` | 收紧 `state/`、`config.json` 的 ACL；任何路径都以 0 退出，绝不阻断启动 | `npm run harden-acl` / `bin/boot.cmd` |
| `diagnose-acl.mjs` | 只读盘点被切断 ACL 继承的路径 | `npm run diagnose:acl` |
| `privacy-scan.mjs` | 按 `privacy-rules.json` + 内置规则扫描真实标识 | `npm run privacy-scan` |
| `release-check.mjs` | 发布前清单检查 | `npm run release:check` |
| `scan-tool-names.mjs` + `dsh-tool-names.mjs` | 把 DSH 真实工具名与守卫 restrict 名单双向求差 | `npm run scan:tool-names` |
| `dsh-ensure.mjs` | 发现 DSH 端口并写回 `dsh.baseUrl`（`--fix`） | `npm run dsh:ensure` |
| `patch-snowluma-sdk.mjs` | 修 `@snowluma/sdk` 的 ESM 打包 bug | `postinstall`（**必须保留**） |
| `send-voice.mjs` / `send-test-group.mjs` | 面向 SnowLuma/QQ 的**真发送**小工具 | `npm run send-voice` 等；注意会真的发消息 |
| `voice-locator.mjs` | 解析仓库外 `../voice-tool/` 的位置；不在时统一跳过 | 被多个测试引用 |
| `probes/*.mjs` | 只读探针：RPC 形状、工具清单、事件流、工作区、模型、协议帧、settings 命名空间 | `npm run probe:*` |
| `demo-console.mjs` | 离线控制台 fixture（`tests/console-ui.test.mjs` 的宿主） | `npm run test:console-ui` |
| `handoff.mjs` | 会话交接快照（内部使用） | `npm run handoff` |
| `migration-preflight.mjs` | 迁移前预检 | 按需 |
| `check-onebot.mjs` | 手工排查 OneBot 连通性 | 按需 |

---

## 五、`tests/` 命名约定

| 形态 | 含义 |
| --- | --- |
| `*.test.mjs` | 自动化测试；被 `tests/run-audit.mjs` 列入 `tests[]` 的会在 `npm run test:audit` 里跑（离线、不发真 QQ 消息、不用生产凭据） |
| `run-audit.mjs` | audit 调度器（`npm run test:audit`） |
| `bridge-harness.mjs` | 虚拟网关 + 沙箱化桥接审计脚手架 |
| `fixtures/` | 基线：`console-endpoints.golden.json`、`console-legacy-ids.json`、`console-ui-contracts.json`、`console.before.html` |
| `console-ui.test.mjs` | 控制台**离线浏览器回归**（Playwright），说明见 [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) |
| `dsh-*.test.mjs` | 需要活的 DSH（不在 `test:audit` 里）：鉴权、会话队列投影、退役会话、仿真等待 |

---

## 六、`docs/` 结构

```
docs/
├── README.md     # 文档索引（只登记随仓库发布的文档）  ← 先看这个
├── FOLDER_MAP.md # 本文件
├── ARCHITECTURE.md # 两种角色、设计取舍与上下文预算
└── guides/       # 面向使用者/运维：AGENT_DEPLOY / MANUAL_DEPLOY / TROUBLESHOOTING / CAPABILITIES /
                  # CODE_PROPOSAL / INNER_LIFE / CONSOLE / EXTENDING / DSH_SETUP / DSH_ADAPTATION /
                  # SECURITY_BASELINE / RELIABILITY / TOKEN_USAGE_CONSOLE / CONSOLE-UI-TESTING / PRIVACY
```

> ⚠️ **哪些文档会进公开仓库**：只发布 `docs/README.md`、`docs/FOLDER_MAP.md`、`docs/ARCHITECTURE.md` 与 `docs/guides/`。
> 设计规划、审计/优化报告、调研记录、历史归档、项目总说明书、内部编排/交接文档都**不随仓库发布**
> （它们含本机路径与真实账号，只在私有开发副本保留）。**要公开的新文档请放 `docs/guides/`。**

规则：**根目录只留 `README.md` / `README.en.md` / `RULES.md` / `SECURITY.md` / `UPSTREAM.md` 五个文档**，
其余一律进 `docs/` 对应子目录，并在 [README.md](README.md) 索引里登记一行。

---

## 七、独立工具 `voice-tool/`（不在本仓库内）

| 路径 | 作用 |
| --- | --- |
| `voice-tool/voice-cli.mjs` | 命令行：交互菜单 / `send` / `list` / `check` / `remove` / `status` |
| `voice-tool/voice-gui.mjs` | 图形界面：只监听 127.0.0.1 的本地小服务 + 一次性令牌 + 浏览器 UI |
| `voice-tool/public/voice.html` | 图形界面前端（拖拽上传、试听、音量、发送、历史） |
| `voice-tool/发语音.cmd` | 命令行启动器（纯 ASCII，双击即用） |
| `voice-tool/config.json` | 工具自己的配置（可选）。本机显式把 `voice.voiceDir` 指向 `../xiaojingyu/audio` |
| `voice-tool/config.example.json` | 配置模板 |
| `voice-tool/state/` | 运行时：`voice-gui-url.txt`（当前界面地址 + 一次性令牌） |

共享内核**不复制**：工具经 `../xiaojingyu/services/media/voice-core.js` 与 `../xiaojingyu/channels/qq/gateway.js`
引同一份实现（`services/media/send-voice-lib.js` 也是转发这同一份）。
