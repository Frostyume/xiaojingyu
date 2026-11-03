# 文档索引（docs/README.md）

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` / `SECURITY.md` / `UPSTREAM.md` 五个文档，其余都在本目录下。
> 仓库目录结构与 `tools/`、`tests/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。

## 随仓库发布的文档

| 文档 | 一句话说明 |
| --- | --- |
| [../CHANGELOG.md](../CHANGELOG.md) | 开发日志：每个版本改了什么、为什么改 |
| [guides/AGENT_DEPLOY.md](guides/AGENT_DEPLOY.md) | 把部署整件事交给 Codex / Claude Code / Qoder / DSH：agent 的执行步骤、边界、验收与回滚 |
| [guides/MANUAL_DEPLOY.md](guides/MANUAL_DEPLOY.md) | 手动部署六步（装依赖、写配置、装 DSH 端、准备 SnowLuma、启动）与运行模式 |
| [guides/TROUBLESHOOTING.md](guides/TROUBLESHOOTING.md) | 体检与排查手册：没反应、收不到消息、1006、端点自愈、已知限制 |
| [guides/CAPABILITIES.md](guides/CAPABILITIES.md) | 完整能力清单：35 个工具、唤醒与发送边界、分门别类的能力表、安全默认值 |
| [guides/CODE_PROPOSAL.md](guides/CODE_PROPOSAL.md) | 代码提案闭环：七步流程、三条私聊回执、与任意 coding agent 的接入契约 |
| [guides/INNER_LIFE.md](guides/INNER_LIFE.md) | 内心生活与主动分享的机制、示例频率，以及 owner 私聊里的完整指令表 |
| [guides/CONSOLE.md](guides/CONSOLE.md) | `/live` 状态页面板与本地控制台 13 个任务页的逐页说明 |
| [ARCHITECTURE.md](ARCHITECTURE.md) | 两种角色的拆分、设计取舍、上下文预算与 DSH 侧细节 |
| [guides/EXTENDING.md](guides/EXTENDING.md) | 兼容矩阵、扩展点（人格卡 / 插件 / MCP / preset）、开发闭环与测试命令 |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | 在目标设备上把桥接接进 DSH：`qq-chat` preset 与三个 MCP server 怎么挂 |
| [guides/DSH_ADAPTATION.md](guides/DSH_ADAPTATION.md) | 适配 DSH 0.2.0 的逐条改动记录（现象/原因/证据/验证）；升级 DSH 前先读最后一节的操作清单 |
| [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md) | 安全基线与威胁模型：准入、工具面、出站、控制台、落盘、网络，以及已知残余风险 —— **改动安全相关代码前必读** |
| [guides/RELIABILITY.md](guides/RELIABILITY.md) | 可靠性与诊断：SQLite/WAL、outbox 幂等与重放、inbox 去重、任务队列、doctor、JSONL 日志与故障处置 |
| [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) | 控制台离线预览（`npm run preview:console`）与离线浏览器回归（`npm run test:console-ui`） |
| [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) | 控制台「令牌与花费」看板：数据来源、计价口径（峰谷分时）、API |
| [guides/PRIVACY.md](guides/PRIVACY.md) | 发布前隐私检查：哪些东西绝不能进 git、扫描器怎么用、豁免怎么收紧 |
| [FOLDER_MAP.md](FOLDER_MAP.md) | 目录结构与 `tools/`、`tests/` 命名约定 |

## 想找什么 → 去哪看

| 我想…… | 看这个 |
| --- | --- |
| 看每个版本改了什么 | [../CHANGELOG.md](../CHANGELOG.md) |
| 让 agent 一句话把整套东西部署好 | [guides/AGENT_DEPLOY.md](guides/AGENT_DEPLOY.md) |
| 自己一步步手动部署 | [guides/MANUAL_DEPLOY.md](guides/MANUAL_DEPLOY.md) |
| 出问题了，先排查 | [guides/TROUBLESHOOTING.md](guides/TROUBLESHOOTING.md) |
| 知道她到底能做什么 | [guides/CAPABILITIES.md](guides/CAPABILITIES.md) |
| 让她把一句抱怨变成代码改动 | [guides/CODE_PROPOSAL.md](guides/CODE_PROPOSAL.md) |
| 调心情、分享、私聊指令 | [guides/INNER_LIFE.md](guides/INNER_LIFE.md) |
| 看懂 `/live` 和控制台 | [guides/CONSOLE.md](guides/CONSOLE.md) |
| 理解整体架构与取舍 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 加插件 / 改 preset / 二次开发 | [guides/EXTENDING.md](guides/EXTENDING.md) |
| 在新设备上把桥接接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
| 升级 DSH 前评估改动面 | [guides/DSH_ADAPTATION.md](guides/DSH_ADAPTATION.md) |
| 动安全相关代码 / 做发布前检查 | [guides/SECURITY_BASELINE.md](guides/SECURITY_BASELINE.md)、[guides/PRIVACY.md](guides/PRIVACY.md) |
| 排查消息丢失、重复、卡住 | [guides/RELIABILITY.md](guides/RELIABILITY.md) |
| 改控制台界面并做离线回归 | [guides/CONSOLE-UI-TESTING.md](guides/CONSOLE-UI-TESTING.md) |
| 看 AI 烧了多少钱、计价口径 | [guides/TOKEN_USAGE_CONSOLE.md](guides/TOKEN_USAGE_CONSOLE.md) |
| 知道某个目录/脚本是干什么的 | [FOLDER_MAP.md](FOLDER_MAP.md) |
| 权限边界与安全承诺 | [../RULES.md](../RULES.md) |
| 报告安全漏洞 | [../SECURITY.md](../SECURITY.md) |

## 不在本仓库里的文档

设计规划、审计/优化报告、调研记录、历史归档、项目总说明书（PROJECT_GUIDE）、语音工具说明（VOICE）、
以及内部编排/交接文档**不随仓库发布**——它们是在一台真实机器上写成的，含有本机绝对路径、真实账号与群号。
仓库根的 `.gitignore` 也会直接挡下这些路径。

因此 `tools/handoff.mjs` 只适用于维护者的私有开发副本（它依赖 `docs/orchestration/`），
在这里运行不会报错，但生成的交接快照只对本机有意义。