# 排查手册（TROUBLESHOOTING）

> 部署完之后 QQ 上没反应、消息不来、连接报错，先看这里。[← 返回 README](../../README.md)

## 先跑体检

```bash
npm run doctor     # 配置、SQLite、DSH、SnowLuma、preset、端口
```

`[FAIL]` 会直接指出哪一层没通；`[WARN]` 多数情况下不影响收发，但值得看。

## 发消息完全没反应

<details>
<summary><b>按顺序检查</b></summary>

1. `npm run doctor` 有没有红灯；
2. [MANUAL_DEPLOY.md](MANUAL_DEPLOY.md) 第 3 步是否执行过，以及**DSH 是否重启过**
   （preset 未加载时桥接会拒绝建会话）；
3. `config.json` 的白名单是否填了你的号，`allowAllWhenEmpty` 是否为 `false`；
4. 当前模式是否是 `simulation` / `closed-agent`；
5. 桥接日志里有没有「缺 preset」「白名单拒绝」「SnowLuma 未连接」。
</details>

## 连上了，但群里一条消息都不来

大概率是 SnowLuma 的 `[Hook]` 退化了：它的进程和 OneBot WebSocket 都活着，但收不到 QQ 侧的数据。
桥接会把这事讲清楚：控制台「运行总览」的 **SnowLuma 上游** 卡片会变成「已连接 · 未接收」，
`GET /api/status` 的 `snowluma` 字段给出 `degraded` / `good` / `hint`。

排查顺序：控制台看卡片 → 看 SnowLuma 的 `logs/snowluma-*.log` 里有没有
`receive path stale` / `process enumeration timed out` → 再考虑升级 SnowLuma。
注意**升级不会更换注入用的原生组件**，它修不了「原生 hook 挂不上 QQ」这类问题。

## 每次启动第一次连接都报 1006

正常现象。SnowLuma 同一账号的 **HTTP token（3000）与 WebSocket token（3001）是两个不同的值**，
而 `snowluma.accessToken` 通常只能存一个（HTTP 那个）。桥接首次 WS 连接会失败一次，
随后自愈发现 WS token、重连成功。

如果日志里出现 `token 自愈失败`，检查 `snowluma.homeDir` 是否指向真正的 SnowLuma 安装目录。

## 端点自愈把我的 wsUrl 改掉了

换 QQ 账号后端口和 token 都会变，所以桥接默认会跟随发现的新端点并写回配置。
想跑第二个实例 / 指向另一份 SnowLuma 安装时：

```json
"snowluma": { "followDiscoveredEndpoint": false }
```

关掉后**只自愈 token**（换账号仍能恢复），绝不动 URL、也不写回 URL。

## 重启 DSH 后要重启桥接吗

通常不需要。桥接每 5 秒探活，DSH 不可用期间收到的 QQ 消息会在进程内排队
（每会话最多 50 条，满后丢最旧项），恢复后补投。但桥接进程退出会丢失内存队列，
断线期间已经结束的回复不保证补发。

## SnowLuma 版本与上游健康

- 本仓库**不下载、不启动、不替换** SnowLuma，只通过 OneBot 接口连它；
- 升级 SnowLuma 请走它自己的 Releases 与 EULA，升级前先备份账号配置；
- 判断「是不是 SnowLuma 的问题」用上面那张上游卡片，不要只看端口是否监听；
- 实测注入用的原生组件在部分相邻版本之间逐字节相同，升级只换 JS 层，
  所以升级不一定能修「原生 hook 挂不上 QQ」。

<a id="limitations"></a>
## 已知限制

- agent 回复在回合结束时一次性发送，不做流式逐字转发；超长回复按句读 / URL 边界自动分段；
- 图片、表情和合并转发可以进入多模态上下文；入站语音需在 `simulation.speech.asr.enabled`
  打开后才会转写成文字（默认关闭，未开启时显示占位），视频消息目前只显示占位文本；
- **AI 发语音默认关闭**（`simulation.voice.enabled` 与 `simulation.tools.sendVoice` 均为 `false`），
  先把音频放进 `audio/`，再到控制台打开开关。示例语音在 [`assets/voice/`](../../assets/voice/)；
- agent 的 Markdown 回复会转成纯文本再发出（链接保留 `文字 (url)` 形式）；
- 仅支持 Windows 10 / 11：QQ 与 SnowLuma 都是 Windows 程序；
- 只提供 `simulation` / `closed-agent` 两种模式；更早的 `chat` / `reserved` 需自备 `qq-chat-legacy` preset；
- **没有按话题拆分执行会话**：同一个群里的多条话题共享一条上下文，长对话要靠摘要与检索维持，
  话题之间仍可能互相影响；
- **没有任务级进展看护**：目前只有进程 / 端口 / 租约探活和「连续无行动」计数，
  判断不了一次长任务是否真的在推进；
- **只支持单机常驻**：不做跨设备同步；换机器要连同 `state/`、`personas/` 与 `config.json` 一起迁移。
