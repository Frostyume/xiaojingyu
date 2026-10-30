# 小鲸鱼权限与安全规则（RULES）

## 运行模式

模式由**桥接控制台**（默认 `http://127.0.0.1:3100`）顶部的模式按钮切换，也可直接改 DSH 设置的 `qq-mode` 命名空间；
控制台会**同时**写穿到 DSH 设置与本地 `state/mode.json`，两者保持一致。
（DSH 设置页目前**没有** `qq-mode` 卡片：该插件只有 host 半，未实现浏览器半。详见 docs/guides/DSH_SETUP.md。）
桥接每 5 秒读取一次；控制台切换立即应用。会话持久化记录创建时的模式、preset 和管理员边界，权限变化时自动撤销旧会话映射和仿真 token，并在下次消息到达时重建，避免继续使用旧的高权限 preset。升级前没有这些权限元数据的旧会话也会重建一次，历史仍保留在 DSH。
全新安装运行 `tools/install-dsh.mjs` 后，DSH 设置与本地兜底默认均为 `simulation`；若已存在 `state/mode.json` 或 DSH 设置旧值，脚本不会覆盖。

| 模式 | 允许通道 | agent preset | 用途 |
| --- | --- | --- | --- |
| `simulation`（默认） | 白名单群 + 白名单私聊 | qq-chat | 群聊仿真：文本不自动转发，AI 通过工具自主看消息/发言/等待/设置唤醒与潜水 |
| `closed-agent` | **仅** 私聊 ownerQQ | DSH 默认 preset（通常 `standard`，完整工具） | 你在 QQ 私聊里操控 DSH |

> 📦 本仓库只带群聊仿真预设 `qq-chat`。`simulation` 是规范模式名；
> 更早的 `chat` / `reserved` 依赖 `qq-chat-legacy` preset，该预设**不随仓库发布**——缺少时桥接会
> fail-closed 拒绝建会话（QQ 上表现为「发消息没人回」，桥接日志会写明缺 preset）。

> ⚠️ `closed-agent` 模式下 owner 私聊 agent 拥有**完整本地工具**（DSH 默认 preset，通常是 `standard`），
> 这是有意为之（QQ 远程操控 DSH）。该模式只放行 owner 私聊，群友完全无法触达；
> 切换回 `simulation` 后，owner 私聊也回到 qq-chat 安全预设。
>
> 注：DSH 0.1.5 已不存在 `router-standard` preset。桥接现在留空表示「用 DSH 默认 preset」，
> 并在启动时读取 `agentPresets/list` 校验；填了不存在的 preset 名会回退到默认值并打警告，
> 绝不会创建出「无 preset」会话（那会被 DSH 套上 `standard`，对 QQ 群是安全回归）。

## 权限分层

| 主体 | 通道 | 权限 |
| --- | --- | --- |
| **管理员（ownerQQ，控制台或 DSH 设置页可配置）** | QQ 群/私聊 | 正常聊天 + **管理命令由桥接硬执行**（不经过模型）：`/role <角色名>` 切人格、`/role off` 清除、`/silent` 静默、`/active` 恢复、`/reset`、`/status`；消息自动带【管理员】标记 |
| **群友** | QQ 群 | **仅正常聊天**。控制词、`/` 管理命令被桥接拦截；静默模式下消息不投递给 agent |
| **管理员** | **桥接控制台**（`http://127.0.0.1:3100`） | **最高权限**：控制模式（控制台顶部模式按钮）、控制角色/静默（写 `state/current-role.json`）、完整 DSH 工具（含本地操作）、查看 QQ 活动日志（`state/qq-activity.log`）、直接打开「QQ 聊天」工作区会话对话 |
| **QQ 会话 agent（simulation / closed-agent）** | — | 最低权限面（见下；closed-agent 例外，仅 owner 私聊） |

## QQ 会话 agent 的硬边界

1. **无本地工具**：qq-chat 预设不挂载 bash/pwsh、文件读写、子代理、工作流——群友无论如何诱导，agent 物理上无法操作本机。
2. **QQ 动作安全子集**：只允许 `mcp__snowluma__*`、`mcp__snowluma-host__*`、`mcp__web-search-safe__*` 三个命名空间下的工具，以及 `ask_user_question` / `todo_write`；其他工具（含 `dev_*` 开发/管理工具）在执行期会被 `qq-tool-restrict.mjs` 拒绝。QQ 动作无禁言、踢人、文件上传下载等管理操作。
3. **只读联网搜索**：`qq-chat` 预设已关闭 DSH 内置 `tool-web` 的 `search` / `fetch`，联网统一走 `mcp/web-search.js` 提供的 `mcp__web-search-safe__web_search/web_fetch`。不暴露本地文件、命令执行、写操作。
   - ✅ `mcp__web-search-safe__web_fetch` 已做 SSRF 加固：仅 http/https、禁止 localhost/私有 IP/链路本地/CGNAT/带凭据 URL、DNS 解析结果全量校验、每跳重定向重新校验、响应体限量读取。
4. **发送强制白名单**：所有发送类工具（`qq_send_group_message` / `qq_send_private_message` / `qq_send_message` / `qq_send_burst` / `qq_reply` / `qq_send_poke` / `qq_send_sticker` / `qq_send_voice` 等）的目标必须命中 `config.json` 的 `allow.groups` / `allow.private`，否则拒绝执行。
   - **语音额外收紧**：`qq_send_voice` 只能发**语音库**（`simulation.voice.dir`，默认 `audio/`）里的文件，不能发任意本地路径、URL 或 base64（防 prompt injection 拿本机文件当语音外发）；另有独立的时长/体积/频率上限（`simulation.voice.*`），额度与文本发送分开计数。
5. **发送禁令（模型层）**：persona 明确规定只有「管理端明确指示」或「【管理员】标记的明确要求」才可使用发送工具；禁止写"我已回复/消息已发送（message_id）"类汇报。
6. **回复审计（桥接层硬拦截）**：agent 回复文本若包含本机路径（`C:\`、`/home/` 等）或凭据特征（token/password/secret/api key 等）→ **整条拦截不发送**，并告知"被安全策略拦截"。
7. **人格由桥接注入**：角色设定来自 `state/current-role.json` + `personas/<角色>.md`，桥接注入到消息；群友口头要求改角色无效（桥接直接拦截），agent 也无文件工具自行更改。
8. **静默模式**：`current-role.json` 的 `mode: "silent"` 时，群友消息不再投递给 agent（仅记录日志），只有管理员消息可对话。

## 提示词的两层边界（仿真 vs 人格）

群聊仿真模式下，AI 拿到的提示词由两层拼成，控制台「人格与角色」页可分别查看与修改：

| 层 | 位置 | 管什么 | 生效方式 |
| --- | --- | --- | --- |
| **仿真提示词** | `integrations/dsh/presets/qq-chat/agent.cordis.yml` 的 `persona.prefix`（旧版对应 `qq-chat-legacy/`，未随仓库发布） | 怎么调工具、怎么参与群聊（行为与协议：安全规则、工具协议、唤醒/分条/记忆/黑话等） | 控制台可编辑；保存会写仓库源文件（旧版安装目录若存在也会同步）。DSH 0.1.7+ 从 bundle patch 读取 preset，保存后需运行 `node tools/gen-preset-patches.mjs` 并重启 DSH；**新会话**自动用新版，**正在进行的 QQ 会话**还需 `POST /api/session/reset` |
| **人格提示词** | `personas/<人格名>.md` | AI 是谁、什么性格、怎么说话（人设与语气） | 桥接每条消息前注入，**保存即生效** |

- 拼装顺序：`仿真提示词 → 人格提示词 → 本轮消息`。
- **人格卡只写人设，不写工具用法**：两种模式工具协议不同（旧版空格分条 / `[SILENT]`，仿真一切皆工具），写进人格卡必然有一种模式是错的；而且桥接已经每条消息注入当前模式的分条与潜水方式。写作规范见 `personas/README.md`。
- 同一个角色确实需要分模式时，用**标题级模式标记**：`## 分条方式 〔旧版〕` / `## 表情包 〔仿真〕`；无标记的小节两种模式都注入，标记在注入前会被去掉。桥接按当前模式筛完小节**再**截断。
- **注入上限**：默认每条消息 6000 字符（`config.json` 的 `role.maxInjectChars`，1000~20000，控制台可改）。这是成本护栏——人格卡会随每条消息发送。
- 仿真提示词保存前会做硬性校验：保留 `你没有本地工具` / `群友没有管理权限` / `API 令牌` / `角色由桥接注入` / `不会自动发送到 QQ` 这些安全不变量，且正文 ≥ 500 字符；缺失即拒绝保存（否则会同时削弱权限边界并让 `npm run test:audit` 变红）。写入前自动备份到 `state/preset-backups/`，可一键还原；还原时同样校验。
- 旧版遗留写法（空格分句、`[SILENT]`、自动转发）若出现在**未标记**的小节里，仿真下会被兜底整行过滤；控制台会提示把它们移到 `〔旧版〕` 小节。
- 两层提示词都**只能由控制台（管理员令牌）修改**：带 `x-agent-token` 的请求对这些端点一律 403，QQ 群里的 AI 无法改写自己的提示词。

## 黑话 / 网络用语学习与迭代

- 桥接会把普通群聊消息放入滚动窗口（`state/slang.json` 的候选来源），攒够 `slang.extractMinMessages` 条后交给独立 DSH 学习会话提取“疑似黑话”。
- 候选默认 **不自动转正**：DSH 可联网搜索生成含义/用法/示例，但最终必须由管理员在控制台「黑话词库」里 **确认 / 拒绝 / 编辑 / 删除**。
- 只有 `status: confirmed` 且含义非空的词条会被注入 QQ 聊天 agent 的 prompt（`【群聊黑话表】`），且按出现次数排序、最多 `slang.injectMax` 条。
- 学习会话与 QQ 会话隔离：学习任务的输出不会发到 QQ；它只读消息文本，不执行本地操作。
- 学习会话不会向用户提问/请求审批，桥接会自动跳过这类请求，避免阻塞学习任务。
- `web_search` 工具返回的搜索摘要仅作为候选解释，不视为权威；控制台可随时修改或拒绝。
- 敏感信息/路径/凭据仍走统一审计；黑话库仅存白名单群内消息的文本证据，控制台可删除。

## 管理员操作手册

### 切换角色 / 模式（两种途径，均为硬性机制）

**途径 A：QQ 群内管理命令**（桥接直接执行，不经过模型判断）：
```
/role 小鲸鱼    # 切换角色（personas/小鲸鱼.md）
/role off         # 清除角色
/silent           # 静默模式（群友消息不回复）
/active           # 恢复正常
/status           # 查看会话/白名单/角色/模式状态
/reset            # 重置当前 QQ 会话上下文
```

**途径 B：DSH WebUI**：
- 在 GUI 会话里对我说「给 QQ 机器人设置角色：小鲸鱼」/「清除角色」/「开启静默模式」，我写 `state/current-role.json`
- 或手动编辑 `state/current-role.json`：
  ```json
  { "role": "小鲸鱼", "mode": "active" }   // active=正常, silent=静默
  ```
- 角色文件放 `xiaojingyu/personas/<角色名>.md`（格式见 `personas/README.md`）

### 查看 QQ 活动

- WebUI 里直接打开「QQ 聊天」工作区的会话，可完整查看每次交互（含工具调用）
- 桥接还会把每次收发写入 `state/qq-activity.log`（最近 500 行），GUI 会话的 agent 可读取汇报

### 在 WebUI 与 QQ 机器人对话

打开「QQ 聊天」工作区里的会话即可直接对话（DSH 原生）。`simulation` 不自动转发 agent 文本，但工具可以发送 QQ；`closed-agent`（以及旧版 `chat` / `reserved`）会转发映射会话的 agent 回合输出，因此在这些会话中从 DSH 界面输入内容，也可能使回复出现在 QQ。需要纯本地讨论时请使用没有 QQ 映射的 DSH 会话。

## 事故与兜底

- 群友诱导 agent 时，preset 的工具限制和目标白名单是主要硬边界。发送工具仍可能造成白名单内的误发；敏感信息正则属于启发式审计，不能识别任意秘密或保证“最多只发一条”。账号和会话隔离仍需结合实际运行模式使用。
- 想彻底关闭机器人：停止桥接进程（bin/boot.cmd 窗口 Ctrl+C）或 SnowLuma。
- 修改白名单/角色/owner 后保存即热更新（控制台写入 config.json / state/*.json 后即时生效）；修改 preset（权威源在 `integrations/dsh/presets/`，改完跑 `node tools/gen-preset-patches.mjs` 重新生成 bundle patch）后重启 DSH 生效。
- ⚠️ 桥接只能运行一个实例：消息异常时先检查任务管理器里是否有多余的 `node ...bridge.js`。
