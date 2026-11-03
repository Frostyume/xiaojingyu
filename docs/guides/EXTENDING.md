# 兼容性与二次开发（EXTENDING）

> 支持什么环境、能从哪里扩展、改完怎么验证。[← 返回 README](../../README.md)

## 兼容矩阵

| 组件 | 支持范围 | 说明 |
| --- | --- | --- |
| **系统** | Windows 10 / 11 x64 | QQ 与 SnowLuma 都是 Windows 程序；Linux / macOS 没有官方支持 |
| **Node.js** | ≥ 22.13，推荐 24 | 使用内置 `node:sqlite`；Node 22.13 起该模块已不再需要 `--experimental-sqlite`（更早的 22.x 才需要），CI 的 Node 24 主任务才是准入门槛 |
| **DSH** | 按 0.2.0-rc.2 适配 | 依赖 slash RPC、`/api/remote.mux` 事件流与 0.1.7+ 的 agent-presets 机制；换大版本先跑 `npm run verify:adaptation` |
| **SnowLuma** | OneBot v11（WebSocket + HTTP） | 不随仓库分发、不代启动；默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000` |
| **数据库** | SQLite（WAL） | 无需额外服务，数据在 `state/db/bridge.db` |
| **部署形态** | 单机、本机回环 | 控制台与 DSH 默认只听 `127.0.0.1`，不提供多租户或公网托管 |

## 二次开发的扩展点

| 扩展点 | 怎么做 | 边界 |
| --- | --- | --- |
| **人格卡** | 在 `personas/` 放一个 `<名字>.md`，或在控制台「人格与角色」编辑 | 群友口头要求改人设无效；人格只在桥接侧注入 |
| **功能插件** | `features/<id>/index.js` 导出一个 manifest，目录名必须等于 `id` | 同进程加载、无沙箱；只加载你信任的代码 |
| **MCP 工具** | 在 `mcp/` 里扩展服务，再跑 `install-dsh` 重装 | 群聊 preset 只暴露安全子集，不要把本地执行工具放进去 |
| **DSH preset** | 改 `integrations/dsh/presets/qq-chat/agent.cordis.yml` 后重装 | 改坏会导致 fail-closed 拒绝建会话 |
| **配置项** | 改 `config.example.json` 后 `npm run schema:config` | CI 用 `--check` 防止 schema 漂移 |
| **控制台页面** | 单页 `web/deck.html` + `console/` 路由 | 目前没有插件注册点，加页面需要改主程序 |

一个最小功能插件长这样：

```js
// features/hello/index.js —— 目录名必须是 hello
export default {
  id: 'hello',
  name: '示例功能',
  version: 1,
  description: '消息里出现 hello 时回一句',
  permissions: ['state:read', 'qq:send'],
  hooks: {
    async onMessage(payload, ctx) {
      if (!payload?.text?.includes('hello')) return;
      await ctx.send(payload.key, '你好呀');
    }
  }
};
```

加载器会注册 `onMessage`、`onWake`、`onTurnEnd`、`onSchedule`、`beforeSend`、`onConsoleRequest`
这些 hook，以及同步的 `formatSegment`（消息转文本）。**当前主流程真正派发的是 `message`
与 `formatSegment`，其余 hook 与 `prompt:inject`、`service:memory`、`console:route` 等权限
是预留接口**，二次开发时需要自己接主流程或等上游补齐。可用的 `ctx` 是
`cfg` / `log` / `now` / `getState()`（state:read）/ `jobs`（jobs:write）/ `send()`（qq:send）/
`dailyReport`（service:daily-report）。单个插件抛错只会禁用它自己，不会拖垮桥接；
在 `config.json` 的 `features.disabled` 里可以按 id 关闭。

## 开发闭环与测试

离线回归使用临时目录和模拟服务，不读真实配置、不发 QQ 消息：

```bash
npm run verify          # schema + 控制台契约 + core / stage / audit 全量回归
npm run test:audit      # 47 个脚本的离线回归（CI 主任务）
npm run test:console-ui # 控制台离线浏览器回归
npm run self-test       # DSH 侧链路验证（会创建一个独立测试会话）
npm run doctor          # 真机体检
```

`npm run self-test` 会连真实的 DSH，所以它不属于离线回归；跑之前确认 DSH 正在运行。
涉及 QQ 发送、DSH 会话或真实账号的改动，先用 `tests/` 里的 fixture 覆盖，不要拿真实群做测试。

## 目录结构

完整目录职责与 `tools/`、`tests/` 命名约定见 [FOLDER_MAP.md](../FOLDER_MAP.md)。
