# 安全策略

## 支持范围

本仓库当前稳定版为 **v1.4.1**，`main` 分支跟随最新提交。安全修复只在最新版本上提供，历史版本与个人分支不提供安全支持。

## 报告漏洞

**请使用 GitHub 的私密漏洞报告**：仓库页 `Security` → `Report a vulnerability`（GitHub Security Advisories）。
它会创建一个只有维护者可见的私密会话，你可以在其中提供复现步骤、日志和 PoC。

不要用公开 issue 报告安全问题，也不要把下面这些内容贴进 issue、讨论区或任何截图：

- `config.json` 的真实内容（含 `ownerQQ`、各类 token、本机绝对路径）
- `state/` 目录下的任何文件（会话令牌、消息记录、日志）
- 真实的 QQ 号、群号、DSH 端口与 Cookie

## 我们希望报告里包含

1. 受影响的文件与行为（能定位到函数更好）；
2. 复现条件（模式 `simulation`、是否主人私聊、是否有 agent token）；
3. 实际影响（能读到什么、能发出什么、能改什么）；
4. 你验证过的版本（`package.json` 的 `version` 与提交哈希）。

## 处理方式

个人维护的项目，不承诺 SLA；但会：确认收到 → 评估影响面 → 修复并在提交信息里说明 → 修复后再公开细节（如你同意）。
如果漏洞涉及第三方组件（DSH、SnowLuma、MCP SDK），我会先判断是否属于上游问题并回复你。

## 已有的安全边界

接入方（准入、工具面、出站、控制台、落盘、网络）的威胁模型与已实现边界见
[docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md)，
权限承诺见 [RULES.md](RULES.md)。

**请不要在未阅读这两份文档的情况下把本程序接到你不了解的群里**：默认配置面向单人自用，不是多租户服务。
