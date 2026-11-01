# 让 agent 帮你部署（给完全不懂编程的人）

这份文档是写给 **Codex / Claude Code / Qoder / DSH 等能执行命令的 agent** 看的。
你不需要读懂它，只需要把下面这句话发给 agent：

> 帮我在 Windows 上部署 <https://github.com/Frostyume/xiaojingyu>：先读仓库里的
> `docs/guides/AGENT_DEPLOY.md` 并严格照着做，自己检查环境、装依赖、写配置、
> 跑 `install-dsh` 和 `doctor`，直到全部通过；除了 SnowLuma 扫码登录和提供
> QQ 号 / 群号，其余都自己完成；不要打印或上传 `config.json`、`state/` 里的任何
> 令牌、Cookie 和号码。

agent 会按下面的步骤执行，并在每一步向你汇报「做了什么、怎么验证的」。

---

## 一、先划清边界

| agent 可以自己做 | 必须由你亲手做 |
| --- | --- |
| 检查 Windows / Node / Git / DSH 是否就绪 | 安装并启动 **DeepSeek Harness**（如果还没有） |
| 克隆仓库、`npm install`、生成 `config.json` | 下载 **SnowLuma**、同意它的条款、扫码登录 QQ |
| 运行 `node tools/install-dsh.mjs`，备份并修改 DSH 配置 | 告诉 agent 你的 QQ 号、要放行的群号、OneBot token |
| 启动 / 重启桥接，跑 `npm run doctor` 逐项排错 | 决定是否允许 AI 主动发言、是否开启语音等 |
| 打开控制台与 `/live` 做健康检查 | 在 QQ 里发第一条测试消息 |

**agent 绝对不要做**：替用户登录 QQ、下载或启动 SnowLuma、把控制台暴露到公网、
关闭白名单或鉴权、读取/打印/上传 `config.json` 与 `state/` 内容、在真实群里发测试消息。

> SnowLuma 的 EULA 明确限制「通过自动化脚本部署/启动其专有组件」。所以 agent 只做
> 端口探测与状态检查，安装、启动、扫码都必须由你本人完成。

---

## 二、部署步骤（agent 执行）

### 0. 收集输入（一次问清，不要反复打断）

- 主人 QQ 号（只用于 `ownerQQ`，报告里用 `***` 代替）；
- 允许私聊的 QQ 号、允许群聊的群号（至少一个，否则她不会响应）；
- SnowLuma 的 WebSocket / HTTP 端口与 accessToken（没设 token 就留空）；
- DSH 是否已安装并启动（默认 `http://127.0.0.1:3080`）；
- 是否要把控制台令牌写进 `config.json`（不会的话保持自动生成）。

### 1. 环境自检

```powershell
node -v          # 需要 >= 22.13；建议 24
git --version
```

- Node 太旧：`winget install OpenJS.NodeJS.LTS`，装完重开终端再验一次；
- 没有 Git：`winget install Git.Git`；
- 检查 DSH：确认 `http://127.0.0.1:3080` 可访问、进程存在。未安装就停下来，
  让用户去 DeepSeek Harness 官方渠道安装并启动，**不要自行下载来源不明的安装包**；
- 检查 SnowLuma：确认 3000 / 3001 端口有监听。没有就提醒用户按
  [MANUAL_DEPLOY.md](MANUAL_DEPLOY.md) 第 4 步操作，**不要代下载、代启动**。

### 2. 获取代码并安装依赖

```powershell
git clone https://github.com/Frostyume/xiaojingyu.git
cd xiaojingyu
npm install
```

`npm install` 的 `postinstall` 会修补 `@snowluma/sdk` 的 ESM 打包问题，属正常步骤。
若失败，保留完整报错再排查，不要用 `--ignore-scripts` 绕过。

### 3. 写配置

```powershell
copy config.example.json config.json
```

只改这些字段，其余保持默认：

| 字段 | 填什么 |
| --- | --- |
| `ownerQQ` | 主人 QQ 号 |
| `allow.private` | 允许私聊的 QQ 号数组 |
| `allow.groups` | 允许响应的群号数组 |
| `allow.allowAllWhenEmpty` | 保持 `false`（fail-closed） |
| `dsh.baseUrl` | DSH 地址，默认 `http://127.0.0.1:3080` |
| `dsh.model` | 用 DSH 里实际可用的模型名 |
| `snowluma.wsUrl` / `httpUrl` | 默认 `ws://127.0.0.1:3001` / `http://127.0.0.1:3000` |
| `snowluma.accessToken` | OneBot token；没配置就留空 |

写完后用 `node tools/healthcheck.mjs --json` 做一次静态检查；**报告里不要贴真实号码与 token**。

### 4. 装 DSH 端（preset + MCP）

```powershell
node tools/install-dsh.mjs
```

脚本会：

- 把 `qq-chat` preset 写进 DSH 的 agent-presets bundle；
- 在 `~/.dsh/profiles/web/cordis.patch.yml` 挂载三个 MCP server；
- 注册 `mode-console` / `agent-presets` 两个 bundle；
- 覆盖前自动生成 `*.bak-<时间戳>` 备份（最多保留 5 份）；
- 新环境写入 `state/mode.json`，默认 `simulation`。

随后**完整重启 DSH**（不是刷新页面）。若 DSH 报 `cannot resolve profile bundle`，
在仓库目录执行 `dsh plugin --profile web install` 后再次重启。

### 5. SnowLuma（交给用户）

提醒用户：

1. 从官方 Releases 下载完整版并解压；
2. 双击 `launcher.bat`，在 WebUI 同意条款、设置密码、扫码登录 QQ；
3. 开启 **WebSocket 服务端** 与 **HTTP API**；
4. 把端口与 token 告诉 agent，agent 写入 `config.json` 的 `snowluma` 段。

agent 只做端口探测，不要代启动、代扫码。

### 6. 启动与验收

```powershell
npm start            # 前台
# 或 bin\boot.cmd    # 崩溃自动重启的守护窗口
```

另开一个终端：

```powershell
npm run doctor
```

**验收标准（全部满足才算完成）**：

- [ ] `npm run doctor` 没有 `[FAIL]`，DSH / SnowLuma / preset / 端口均为 OK；
- [ ] 日志出现「SnowLuma 已连接」；
- [ ] 用白名单内的账号私聊机器人发一句话，能收到回复；
- [ ] 控制台 `http://127.0.0.1:3100` 能打开，运行总览显示双健康；
- [ ] `http://127.0.0.1:3100/live` 能看到她的状态页；
- [ ] 没有向任何群聊发送测试消息（私聊验证即可）。

可选但推荐：`npm run self-test` 会创建一个独立测试会话，验证 DSH 链路；它不会发 QQ 消息。

---

## 三、常见故障（agent 按顺序排查）

| 现象 | 先查 |
| --- | --- |
| 私聊完全没反应 | `doctor` 红灯；白名单是否包含该 QQ；模式是否 `simulation`；DSH 是否重启过；preset 是否装好 |
| 连上了但收不到群消息 | SnowLuma 上游是否「已连接 · 未接收」；看 SnowLuma 日志里的 `receive path stale` |
| 第一次 WS 连接报 1006 | 正常：HTTP 与 WS token 不同，桥接会自愈一次 |
| 控制台打不开 | 端口 3100 是否被占用；令牌在 `state/console-token`，不要贴到公开渠道 |
| DSH 报 bundle 解析失败 | `dsh plugin --profile web install` 后完整重启 DSH |
| 改了配置不生效 | 桥接是否重启；DSH preset 改动是否需要重装并重启 |

详细版见 [TROUBLESHOOTING.md](TROUBLESHOOTING.md) 与 [`docs/guides/DSH_SETUP.md`](DSH_SETUP.md)。

---

## 四、回滚

1. 关闭桥接窗口（`Ctrl+C` 或关掉 `boot.cmd` 的守护窗口）；
2. 把 `config.json.bak-<时间戳>` 还原成 `config.json`；
3. DSH 侧若需回滚：把 `cordis.patch.yml.bak-<时间戳>` 还原成 `cordis.patch.yml`，再重启 DSH；
4. 仓库目录可整体删除，`state/` 里是运行数据，确认不再需要后再手动清理。

**不要**为了「重新来一遍」删除 `state/`：里面是她的记忆、会话和审计记录。

---

## 五、部署完成之后

- 到控制台「人格与角色」确认角色是小鲸鱼；
- 在「群聊剧场」里按需调整唤醒频率、夜间静默与工具开关；
- 先只放行一个群 / 一个好友观察一天，再扩大白名单；
- 想让她主动分享见闻或发说说，先在私聊里用「内心状态」「跑一次分享」试水；
- 备份 `config.json`、`state/` 与 `personas/`，换机器时一起带走。

## 六、给 agent 的完成定义

部署不是「命令跑完」，而是「用户能在 QQ 里收到她的回复，并且 `doctor` 全绿」。
如果卡在任何一步，输出：**卡在哪一步、报错原文、你已尝试的排查、需要用户做什么**，
不要用删除数据、关闭鉴权、放宽白名单的方式绕过问题。
