# 上游基线与分叉说明（UPSTREAM）

> 本文件记录本仓库与上游 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的关系。
> 最后核对：2026-10-25。
> 本文件只写代码/版本事实，不包含任何真实 QQ 号、群号、令牌、本机绝对路径。

## 1. 上游是谁

| 项 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/Derpyu520/qq-bridge` |
| 上游许可证 | `LICENSE` 正文为 MIT，并带有附加声明；GitHub API 因附加文本识别为 `NOASSERTION` |
| 本仓库许可证 | 沿用上游 `LICENSE`，不得删除或替换上游版权声明 |
| 本仓库定位 | 上游的**二次开发定制分支**（小鲸鱼人格 + SnowLuma + DSH），不是独立重写 |

## 2. 版本锚点

| 项 | 提交 | 说明 |
| --- | --- | --- |
| 本仓库 `HEAD` | `a56164e` | 上游 tag `v0.2.0-r4`；本地 `.git` 为 grafted 浅历史 |
| 上游 `main`（2026-10-25 抓取） | `a49877f` | 上游 tag `v0.2.1-r1` |
| 分叉步长 | 2 个提交 | `374cb4f`（v0.2.1-r1 发布）+ `a49877f`（probe 清理） |

本地工作区在上游 `v0.2.0-r4` 之上有大量未提交定制（26 个已跟踪文件修改 + 若干未跟踪模块），
见第 4 节。**在任何重构前必须先看第 6 节的恢复步骤。**

## 3. 上游领先的改动（`a56164e..origin/main`）

上游 2 个提交合计 42 个文件、约 +2,698 / -192 行，主题是 **DSH 0.2.1-rc.2 适配**：

1. **P0：`{{cwd}}` 提示词变量在 DSH 0.2.1 被删除**
   - 现象：`turn/start` 后立刻 `turn/end reason={kind:error}`，模型一次都不跑，QQ 侧表现为完全不回话。
   - 修法：preset 的 persona `suffix` 去掉 `{{cwd}}`，工作目录交给 DSH 自带 `working-directory:current`。
   - 本仓库当前 preset 已自行删掉 `{{cwd}}`（见 `dsh/agent-presets/qq-chat-v2/agent.cordis.yml` 注释），
     但**上游的 bidirectional 变量对账与活体回合断言尚未合入**。
2. **P1：`working_directory` 进入全局层**，仿真会话会继承 → 守卫名单（`qq-tool-restrict`）补 13 个名字：
   `working_directory`、`terminal_{open,send,read,signal,close,list}`、
   `session_{search,trace}` / `session_event_{read,search,trace}`、`plugin_market`、
   `create_worktree`、`wait_agent`；`subagent_codex` / `subagent_claude_code` 改为「可选组」。
3. **新模块** `src/media-normalize.js`（约 450 行）与 6 个新回归脚本：
   `test-media-normalize` / `test-sticker-http-fallback` / `test-time-awareness` /
   `test-tool-restrict-guard` / `test-tool-surface` / `test-wait-backlog`。
4. `verify-dsh-020-adaptation.mjs` 重命名为 `verify-dsh-021-adaptation.mjs`，增加「真跑一回合」活体断言。
5. 文档：新增 `docs/guides/DSH_021_ADAPTATION.md`。
6. `probe-tools` 跑完自清理工作区/临时目录。

## 4. 本地分叉清单（相对 `v0.2.0-r4`）

### 4.1 已跟踪但已修改

| 模块 | 变化摘要 |
| --- | --- |
| `src/bridge.js` | +2,104 行：实时状态页 `/live` + `/api/live/*`、内心生活、提醒、订阅、电竞资讯、天气、图片库、群档案、唤醒预览、tone nudge、夜间静默、clingy follow-up、trailing-period 清理、TTS 面板、`/api/features` 等 |
| `src/mcp-snowluma-safe.js` | +370 行：图片/表情/语音/空间等工具面扩展与安全收紧 |
| `src/slang-learner.js` | 黑话候选/注入逻辑调整 |
| `src/sticker-lib.js` | 表情包链路调整 |
| `public/console.html` | 控制台大改（实时页、内心生活、图片库、群档案、提醒等面板） |
| `dsh/agent-presets/qq-chat{,-v2}/agent.cordis.yml` | 人格行为、语音状态、细节协议本地定制 |
| `plugins/qq-agent-presets/presets/*.patch.yml` | 由上述源文件生成，**不要手改** |
| `roles/小鲸鱼.md` | 人格卡本地定制 |
| `scripts/*` | 控制台 UI 基线、契约、以及若干测试随本地实现同步 |
| `RULES.md` / `docs/FOLDER_MAP.md` / `start.bat` | 文档与启动脚本本地化（`start.bat` 注入 GPT-SoVITS 的 ffprobe 路径） |

### 4.2 未跟踪的新模块（本地新增）

2026-10-25 的 Stage 1–4 又新增了一批基础模块（均未提交）：

| 目录/文件 | 作用 |
| --- | --- |
| `src/core/` | SQLite/outbox/jobs/inbox、配置 schema、结构化日志、prompt 预算、价值评分、模型路由、FTS 记忆、会话映射、关系、人格包、卡片解析、日报、ASR/TTS 情绪、事件总线、feature loader、传输适配器、预算 |
| `src/features/` | 可插拔 feature：`daily-report`、`rich-cards` |
| `scripts/` | `doctor`、`dsh-ensure`、`build-config-schema`、`test-core-storage`、`test-doctor`、`test-stage2/3/4` 等 |
| `config.schema.json` | 由 `config.example.json` 生成的结构清单 |
| `.github/workflows/ci.yml` | 离线 CI（Node 24 主任务 + Node 22 观察任务） |
| `docs/guides/RELIABILITY.md`、`docs/PROGRESS-2026-10-25.md` | 机制说明与执行进度 |

原有的本地功能模块（内心生活、提醒、天气等）如下：

| 文件 | 作用 |
| --- | --- |
| `src/inner-life.js` | 内心生活：独立 DSH 会话、好奇/反思/说说调度、安静时段、每日上限 |
| `src/persona-state.js` | 可变人格状态（心情/精力/兴趣/学到的东西/口癖），带单次变化上限与衰减 |
| `src/curiosity.js` | 好奇候选池（B 站热门 + RSS，公开源） |
| `src/reminders.js` | 轻量提醒存储（元数据，到点由桥接发送） |
| `src/quiet-hours.js` | 群主动冒泡与内心生活共用的夜间静默窗口 |
| `src/weather.js` | Open-Meteo 天气（固定公网域名、10 分钟缓存） |
| `src/esports-feed.js` | 直播吧电竞资讯（固定域名、只读） |
| `src/qzone.js` | QQ 空间动作（SnowLuma HTTP action，不新增 MCP 工具） |
| `src/image-lib.js` | 通用图片库（区别于 QQ 收藏表情库；文件默认在 D 盘） |
| `public/live.html`、`public/assets/` | 实时状态页与其静态资源 |
| `scripts/test-clingy-followup.mjs` 等 4 个测试 | 黏人追发 / 语气 nudge / 内心生活调度 / 夜间静默回归 |
| `scripts/auto-caption-stickers.mjs`、`import-image-library.mjs`、`install-caption-task.ps1` | 表情/图片库的一次性导入与打标工具 |
| `docs/HANDOFF-*.md`、`docs/IMPROVEMENT-PLAN-2026-10-25.md` | 交接与本轮改进计划 |

### 4.3 上游改动与本地改动的重叠文件（cherry-pick 高风险区）

```
roles/小鲸鱼.md
docs/FOLDER_MAP.md
dsh/agent-presets/qq-chat-v2/agent.cordis.yml
dsh/agent-presets/qq-chat/agent.cordis.yml
plugins/qq-agent-presets/presets/qq-chat-v2.patch.yml
plugins/qq-agent-presets/presets/qq-chat.patch.yml
scripts/audit-bridge-harness.mjs
scripts/console-ui-fixture.mjs
scripts/test-console-ui.mjs
scripts/test-qq-preset-contract.mjs
src/bridge.js
src/mcp-snowluma-safe.js
src/sticker-lib.js
```

这些文件**不能整文件 checkout 上游版本**，否则会丢掉本地功能与人格行为。正确做法见第 5 节。

## 5. 跟进上游的规则

1. 只按**提交**逐个评估，不整分支 merge。先看 `git show <sha> --stat`，再按 hunk 挑选。
2. 优先吸收「上游 bug fix / 协议适配 / 安全守卫」；上游新增的通用功能若与本地实现冲突，先保留本地，记录差异。
3. preset 相关：只把上游的**语义变更**（如删除 `{{cwd}}`、补守卫名单）手工合并进
   `dsh/agent-presets/**/agent.cordis.yml` 源文件，然后运行：
   ```bash
   node scripts/build-agent-preset-patches.mjs
   ```
   **绝不手改** `plugins/qq-agent-presets/presets/*.patch.yml`。
4. 合入后必须跑：`npm run test:audit`、`npm run verify:adaptation`、`npm run test:qq-preset-contract`
   （或当前等价的 preset 契约测试），并按 RULES.md 的说明重启 DSH（preset/工具 schema 变更需要）。
5. 若上游改了 `LICENSE`，同步保留上游版权与新条款，不覆盖为自有许可。

## 6. 备份与恢复（Stage 0 快照）

2026-10-25 的本地快照（**只在 D 盘，不进仓库**；下文的 `<SNAPSHOT_ROOT>` 指本机 D 盘上的备份根目录）：

```
<SNAPSHOT_ROOT>\stage0-20261025-222529\
├── worktree.tar.gz            # 完整工作区（含 state/、config.json、audio/；排除 node_modules/.git）
├── qq-bridge-head.bundle      # git 历史（当前 HEAD）
├── tracked-changes.patch      # 相对 a56164e 的全部已跟踪改动
├── tracked-changes.stat.txt
├── git-status.txt / git-branch.txt / git-log.txt
└── untracked-files.txt        # 未跟踪文件清单
```

恢复步骤（会覆盖工作区，**执行前先确认当前工作区已另行备份**）：

```bash
# 方式 A：只回滚已跟踪文件
git checkout -- .            # 丢弃未提交改动（危险，先确认）
git apply <SNAPSHOT_ROOT>/stage0-20261025-222529/tracked-changes.patch

# 方式 B：整目录恢复（在空目录解包，不要直接覆盖正在运行的仓库）
mkdir <RESTORE_DIR> && tar -xzf <SNAPSHOT_ROOT>/stage0-20261025-222529/worktree.tar.gz -C <RESTORE_DIR>
```

## 7. 绝不进入公开仓库的内容

- `config.json` 及其 `.bak-*`、`state/` 全目录（令牌、会话映射、日志、账本、人格状态、备份）
- `audio/`（用户真实音频）、图片库目录
- 任何真实 QQ 号 / 群号 / 控制台 token / DSH Cookie / API Key
- `docs/audits/`、`docs/design/`、`docs/legacy/`、`docs/research/`、`docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md`
  （`.gitignore` 已排除，原因：含本机路径与内部细节）
- `start.bat` 中的本机 GPT-SoVITS 绝对路径（发行前必须改为可配置/自动发现）
