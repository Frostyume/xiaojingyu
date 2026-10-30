# 文档索引（docs/README.md）

> 根目录只留 `README.md` / `README.en.md` / `RULES.md` / `SECURITY.md` / `UPSTREAM.md` 五个文档，其余都在本目录下。
> 仓库目录结构与 `tools/`、`tests/` 命名约定见 **[FOLDER_MAP.md](FOLDER_MAP.md)**。

## 随仓库发布的文档

| 文档 | 一句话说明 |
| --- | --- |
| [guides/DSH_SETUP.md](guides/DSH_SETUP.md) | 在目标设备上把 qq-bridge 接进 DSH：`qq-chat` preset 与三个 MCP server 怎么挂 |
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
| 在新设备上把 qq-bridge 接进 DSH | [guides/DSH_SETUP.md](guides/DSH_SETUP.md) |
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