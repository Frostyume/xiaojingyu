<p align="center">
  <img src="assets/banner.png" alt="小鲸鱼 · 住在 QQ 里的陪伴型 AI" width="100%">
</p>

<h1 align="center">小鲸鱼 Xiaojingyu</h1>

<p align="center"><b>一个住在 QQ 里的陪伴型 AI，更像长期在线的群友，而不是聊天窗口。</b></p>

一天几百条消息刷过去，她大多数时候安静在看，被叫到或话题接得上才抬头。她记得你上周提过的事，也记得跟每个群友处到哪一步，这些会画进一张按羁绊深浅排布的关系图谱。

没有消息时她也在过自己的日子：读小说、攒见闻、定时反思，心情跟着真实时间慢慢起落。你要是私聊吐槽一句「不好用」，她会整理成带验收标准的开发提案，交给你自己的 agent 实现，你点头才合并。

<p align="center">
  <img alt="version" src="https://img.shields.io/badge/version-1.4.1-5B8DEF?style=flat-square">
  <img alt="node" src="https://img.shields.io/badge/Node.js-%E2%89%A5%2022.13-339933?style=flat-square&logo=nodedotjs&logoColor=white">
  <img alt="platform" src="https://img.shields.io/badge/Windows-10%20%2F%2011-0078D4?style=flat-square&logo=windows&logoColor=white">
  <img alt="dsh" src="https://img.shields.io/badge/DSH-0.2.0--rc.2-1B1F3B?style=flat-square">
  <img alt="license" src="https://img.shields.io/badge/license-MIT-3DA639?style=flat-square">
</p>

<p align="center">
  <a href="https://github.com/Frostyume/xiaojingyu">GitHub</a> ·
  <a href="https://gitee.com/frostyume/xiaojingyu">Gitee 镜像</a> ·
  <a href="README.en.md">English</a> ·
  <a href="docs/README.md">文档索引</a> ·
  <a href="RULES.md">权限规则</a> ·
  <a href="SECURITY.md">安全</a> ·
  <a href="UPSTREAM.md">上游说明</a>
</p>

**目录**

- **认识她**：[她是谁](#她是谁) · [她为什么不像一个聊天窗口](#她为什么不像一个聊天窗口) · [使用场景](#使用场景) · [一条消息的一生](#一条消息的一生) · [她有自己的生活](#她有自己的生活)
- **把她装上**：[快速部署](#快速部署完全不懂编程也能用) · [手动部署](docs/guides/MANUAL_DEPLOY.md) · [运行模式](docs/guides/MANUAL_DEPLOY.md#运行模式) · [设计你自己的她](#设计你自己的她)
- **看着她**：[实时状态页 /live](#实时状态页-live) · [本地控制台](#本地控制台) · [架构](#架构)
- **能力与边界**：[代码提案](#代码提案私聊里让她改进和开发) · [能力地图](#能力地图) · [完整能力清单](docs/guides/CAPABILITIES.md) · [安全与隐私](#安全与隐私) · [已知限制](#已知限制)
- **进阶**：[排查手册](docs/guides/TROUBLESHOOTING.md) · [兼容性与二次开发](docs/guides/EXTENDING.md) · [文档](#文档) · [目录结构](docs/FOLDER_MAP.md) · [上游与许可](#上游与许可)

## 她是谁

小鲸鱼住在一个 QQ 号里，群聊和私聊都能找到她。她不会每条消息都接，大多数时候只是在看谁在说话、气氛怎么样、这个话题自己接不接得上；真开口时，她会记得你上周提过的事，也会在你说「今天有点撑不住」的时候，先问一句项目是不是周五交。

用起来不用装新 App，也不用改习惯。群友照常聊天，她只是那个偶尔冒泡、说话像人的成员。

| 能力 | 边界 |
| --- | --- |
| 人设：两层提示词，一层管行为边界，一层管性格语气，都能在控制台改 | 不会接管账号：她只是一个没有管理权限的普通成员 |
| 记忆：话题、挂念、群友印象、跨会话记忆，能看也能删 | 不会刷屏：唤醒频率、夜间静默、黏人次数都有硬上限 |
| 节奏：自己决定看、等、说，还是继续潜水 | 不会越权：群友再怎么诱导，也碰不到本机文件和命令 |
| 工具箱：读消息、发语音、发表情、查资料、定提醒，逐项可关 | 不自建云：本地组件只走 `127.0.0.1`；消息仍会经 DSH 交给你选定的模型（出机清单见 [NOTICE](NOTICE)） |

还有几条边界始终生效：

- QQ 注入和 SnowLuma 部署归 SnowLuma 自己管，她只连它的 OneBot 接口；
- 消息只发给白名单里的人，禁言、踢人、上传下载这些群管理动作一概没有；
- 出错时群里只会看到一句人话，原始报错留在日志；
- 语音默认关着，要用就去控制台打开。

## 她为什么不像一个聊天窗口

大多数 AI 聊天是一次性的，发一句回一句，关掉页面就归零。小鲸鱼长在 QQ 里，更像一个长期在线的群友：今天在群里聊到一半的话题，明天可以在私聊里接着讲，不用先交代前情。她也不会每来一条消息就弹一次，而是先用规则筛掉不值得惊动她的事，再自己判断要不要抬头，所以你看到的是「她刚好在」，看不到的是大多数时候她选择不说话。

她还有自己的作息，会反思、会好奇，深夜安静下来，也会自己安排下一次醒来。守护窗口开着时她整日在线，崩溃自动重启、掉线自动重连，没送出的消息排队补投，这些都跑在你自己的机器上。

| 你看到的 | 内部实现 |
| --- | --- |
| 一个群里的她 | 每个群、每个私聊各有一条独立上下文，互不串味 |
| 一句自然语言 | 先用确定性规则筛，再交给模型做语义判断 |
| 她记得你 | 跨会话记忆、话题与摘要按相关度取用 |
| 她一直在 | 进程守护、断线重连、队列补投 |

> [!NOTE]
> 当前版本 **v1.4.1**，逐项适配 **DSH 0.2.0-rc.2**（`npm run verify:adaptation`）。本版让控制台的设置保存与刷新更可靠（不再吞掉草稿和保存提示），并把死开关检测、真浏览器界面测试与图片压缩链路纳入自动验证。
> 首个稳定版 `v1.0.0` 于 2026-11-03 发布；上游 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)
> 的 `v0.1.x` / `v0.2.x` 标签与本仓库无关。

## 快速部署（完全不懂编程也能用）

<p align="center">
  <img src="assets/diagrams/deploy.png" width="100%" alt="快速部署：三段流程，只有两步需要你亲手">
  <br>
  <sub>三段流程：准备环境 → 交给 agent → 扫码上线并验收</sub>
</p>

你不需要读懂 Node、DSH 或 OneBot。整个部署只有三个阶段：**准备一个 agent、把一句话交给它、亲手扫码并验收**。
按下面的顺序做，每一步都有明确的成功标志。

### 阶段一：准备三样东西

| 准备什么 | 怎么准备 | 成功标志 |
| --- | --- | --- |
| **一台 Windows 电脑 + 一个 QQ 号** | Windows 10 / 11；QQ 能正常登录 | — |
| **DeepSeek Harness（DSH）** | 从 DSH 官方渠道安装并启动。小鲸鱼靠它思考，这是她真正的「大脑」 | 浏览器能打开 `http://127.0.0.1:3080` |
| **一个会执行命令的 agent** | Codex、Claude Code、Qoder、DSH 任意一个，能读写本机文件并运行命令 | 你能在里面新建项目并让它执行命令 |

> 只有 DSH 需要你自己安装；Node.js、Git、依赖、配置、preset 都交给 agent。
> 如果 DSH 还没装，先装完再往下走——后面所有步骤都依赖它。

### 阶段二：把这句话原样发给 agent

> 帮我在 Windows 上部署 <https://github.com/Frostyume/xiaojingyu>（国内访问 GitHub 慢就用
> Gitee 镜像 <https://gitee.com/frostyume/xiaojingyu>）：先读仓库里的
> `docs/guides/AGENT_DEPLOY.md` 并严格照着做，自己检查环境、装依赖、写配置、跑
> `install-dsh` 和 `doctor`，直到全部通过；除了 SnowLuma 扫码登录和提供 QQ 号 / 群号，
> 其余都自己完成；不要打印或上传 `config.json`、`state/` 里的任何令牌、Cookie 和号码。

发出去之后，它会先检查环境、克隆仓库、安装依赖，然后**按顺序问你四件事**。照着回答即可：

| 顺序 | 它会问 | 你怎么答 | 示例 |
| --- | --- | --- | --- |
| 1 | 主人 QQ 号是多少？ | 机器人唯一认的主人 | `12345678` |
| 2 | 允许哪些 QQ 私聊、哪些群？ | 至少各填一个；空白名单时她**不回复任何人** | 私聊 `12345678`，群 `87654321` |
| 3 | SnowLuma 的端口和 token？ | 默认 WS `3001`、HTTP `3000`；没设 token 就留空 | `ws://127.0.0.1:3001` |
| 4 | 用哪个模型？ | 填你 DSH 里实际可用的模型名 | 以 DSH 模型列表为准 |

它中途会要求你亲手做 SnowLuma 的部分——这就是阶段三。

### 阶段三：亲手扫码，然后验收

**只有两件事必须你本人做**，因为 SnowLuma 的许可不允许脚本代装、代登录、代启动：

1. **装 SnowLuma 并扫码登录**
   从 [SnowLuma Releases](https://github.com/SnowLuma/SnowLuma/releases/latest) 下载
   `SnowLuma-v<版本>-win-x64.zip` → 解压 → 双击 `launcher.bat` → 用启动日志里的地址打开
   WebUI → 同意条款、设置密码、扫码登录 QQ → 在 WebUI 里开启 **WebSocket 服务端** 与 **HTTP API**。
2. **把 QQ 号 / 群号 / 端口 / token 告诉 agent**，它负责写进 `config.json`。

之后 agent 会安装 DSH 端 preset 与 MCP，**完整重启 DSH**（不是刷新页面），再启动桥接并跑体检。
看到日志 `SnowLuma 已连接`，就用白名单里的 QQ 私聊机器人发一句「在吗」。

**验收清单（全部打勾才算部署成功）：**

- [ ] `npm run doctor` 没有 `[FAIL]`，DSH / SnowLuma / preset / 端口都是 OK；
- [ ] 日志出现「SnowLuma 已连接」；
- [ ] 白名单内的 QQ 私聊能收到她的回复；
- [ ] 控制台 `http://127.0.0.1:3100` 能打开，「运行总览」双健康；
- [ ] `http://127.0.0.1:3100/live` 能看到她的状态页；
- [ ] 没有向任何群聊发送测试消息（私聊验证就够了）。

### 部署完成后的第一小时

1. 打开控制台「人格与角色」，确认角色是小鲸鱼（首次启动默认启用；不是就在人格卡右下角点「启用」），读一遍两层提示词；
2. 到「群聊剧场」把唤醒频率、夜间静默、工具开关调成你想要的样子；
3. **先只放行一个群、一个好友**，观察一天再扩大白名单；
4. 在私聊里说「内心状态」「跑一次分享」试水她的生活功能；
5. 备份 `config.json`、`state/` 与 `personas/`——换电脑时一起带走。

### 卡住了怎么办

把 agent 输出的「卡在哪一步 / 报错原文 / 已尝试什么」整段贴回给它，让它按
[AGENT_DEPLOY.md](docs/guides/AGENT_DEPLOY.md) 的故障表继续。**不要**让它删 `state/`、
关闭白名单或关闭鉴权来绕过问题——那不是修复，只是把门打开。

> 更愿意手动来？[手动部署](docs/guides/MANUAL_DEPLOY.md) 的六步和 agent 执行的是同一套流程。

## 设计你自己的她

小鲸鱼只是仓库自带的默认角色。名字、性格、说话习惯和群里的分寸，都可以换成你自己的。

1. **先分清两层提示词**：「人格提示词」管她是谁——身份、性格、语气、雷点；「仿真提示词」管她怎么干活——工具、分条、潜水与唤醒。改人设只动前者；
2. **换角色**：把 `personas/小鲸鱼.md` 复制成 `personas/<新名字>.md` 再改内容，或在控制台「人格与角色」新建角色卡；然后在人格卡右下角点「启用」。直接编辑默认的 `personas/小鲸鱼.md` 不会被当成自定义角色，写死的内核仍会生效；请另存为新名字再切换。管理员也可以在私聊发 `/role <名字>` 切换、发 `/role clear` 恢复无角色状态。群里说 `进入角色扮演：<名字>` 不生效——角色切换只允许管理员在管理端操作；
3. **给每个群留不同的分寸**：在「群聊剧场」为单个群写初始提示词、群画像和风格备注，让她在不同场合的说法不一样；
4. **小步验证**：先在私聊里聊几句，再放进一个群观察一天；不满意就改文件或在控制台保存，下一条消息即生效，不用重启 DSH。

人格卡只写人设，不要写工具用法；行为边界（不越权、不刷屏、不冒充主人）建议保留。
模板、按模式注入和字符上限见 [personas/README.md](personas/README.md)，机制细节见
[完整能力清单](docs/guides/CAPABILITIES.md)。

## 使用场景

<p align="center">
  <img src="assets/diagrams/scenes.png" width="100%" alt="三个使用场景：群聊里接话、私聊里记得你、需要动手时真的去做">
  <br>
  <sub>三种最常见的场景（示意对话）：群里接话、私聊记得你、要她干活时真去做</sub>
</p>

在群里，她不抢话。一天几百条消息，她只在被叫到、被问到，或话题正好落在她熟悉的地方时抬头；看到 7 条未读，回一句就够，接不上就继续潜水。她记得这个群谁爱开玩笑、谁最近在忙什么，所以接的话不会像天气预报。

私聊里，她记得你。「今天有点撑不住」不需要前情提要，她知道你周五要交项目，也知道你交完想去海边待两天。这些不是每次现问的，而是跨会话留下来的记忆，你可以在控制台里翻看、修改、删掉任何一条。

要她干活，她真会做。排值日表、查资料、定提醒、整理聊天记录，她会先读群历史、查成员，必要时联网，再把结果分条发出来；碰到隐私或超出权限的事，她会先问一句，而不是先做了再说。

不好用，就在私聊里直说。「语音结尾总被截断，修一下」「能不能加个每周一早上的群摘要」，她会把需求写成代码提案排进开发待办，由你的开发 agent 实现、测试、回报，你确认之后才合并。原理和接入方式见 [代码提案](#代码提案私聊里让她改进和开发)。

还能交给她的日常：

| 日常 | 她会怎么做 |
| --- | --- |
| 早上想被叫醒 | 定时提醒按点私聊你，用的是她自己的人设语气，不是系统通知 |
| 群里冷场，想有人起个话题 | 长时间空闲后按概率决定要不要开口，而不是固定频率推送 |
| 有人发了张图或表情包 | 图片进入多模态上下文；贴纸库有备注和标签，她认得自己收藏过什么 |
| 想听她说话 | 语音库 + TTS 情绪音色，`audio/` 里放什么她才能说什么（默认关闭） |
| 群里冒出新黑话 | 自动抽成候选，等你确认含义、用法和风险后才会用 |
| 想知道她最近在干嘛 | `/live` 挂副屏：心情、精力、羁绊、内心生活与此刻动向 |
| 想让她记住一件事 | 一句「记一下」，写进跨会话记忆；不想要的随时删 |

## 一条消息的一生

在 `simulation` 模式（默认）里，消息进来后不会立刻变成一次模型调用，它要先过两道很不一样的判断。

第一道是规则，不花 token。白名单决定能不能进来看，唤醒条件决定值不值得叫醒她——@、叫名字、关键词、提问、拍一拍、概率，命中哪条算哪条。`/reset`、`/status` 这类明确命令和挂起审批走快路径，不进模型；群里大部分闲聊只进未读队列。

第二道是语义。只有命中条件她才会醒，醒了也不是逐条处理：8 秒内的消息合并成一次唤醒，忙的时候一次最多带 12 条未读、6000 字。她读的是一个快照，可以决定回、等、标记已读，或者继续潜水。

最后才是说。回复不直接发出去，而是回到统一出口，再过一遍白名单与审计，按 QQ 的节奏分条、限频、分段，然后才出现在群里。

<p align="center">
  <img src="assets/diagrams/message-flow.png" width="100%" alt="一条消息的一生：触发、判断、行动三个阶段">
  <br>
  <sub>触发 → 判断 → 行动：决定「说什么」之前，先决定「要不要说」</sub>
</p>

一条消息在她这里要走五步：收下、两级判断、合并、执行、统一出口。至于这次说不说、说几句，还是她说了算。

她手里的 35 个工具、唤醒与发送的硬限制，见 [完整能力清单](docs/guides/CAPABILITIES.md)。

## 她有自己的生活

没有消息的时候她也在过自己的日子：反思最近的聊天，好奇地浏览，刷到有意思的东西想分享，深夜自然安静下来。

- **定时反思**：回看最近的聊天和关系，更新心情、精力、兴趣和口癖；
- **好奇浏览**：从你配置的来源里形成候选见闻，要不要分享是另一件事；
- **情绪有惯性**：心情按真实时间衰减，精力跟着北京时间走，不会一句话从开心变成崩溃；
- **社会记忆**：认识的人会进入本地关系图谱，记录所有昵称/群名片、关系阶段、简短印象、共同经历和边界；记忆按人物关联，不复制聊天原文；
- **人物档案**：控制台「人物档案 · 人物志」可查看和修改每个人的印象与备注，群聊 prompt 只带当前说话人的一小段，不暴露 QQ、原始分数或主人私密；
- **分享有上限**：群分享、QQ 空间说说、分享模块都受每日条数、间隔和夜间静默约束。

<p align="center">
  <img src="assets/screenshots/graph.png" width="860" alt="关系图谱：羁绊越深节点越大、离中心越近">
  <br>
  <sub>关系图谱（离线演示数据）：节点大小与远近随羁绊变化，悬停可看关系阶段与互动次数</sub>
</p>

<p align="center">
  <img src="assets/screenshots/reading.png" width="860" alt="她在读：书与视频的进度条">
  <br>
  <sub>「她在读」（离线演示数据）：书按章节或字数推进，视频标记已看，并汇总今日见闻</sub>
</p>

> 社会记忆与人物档案内核当前在运行库版本提供；开源发行包的控制台与文档先同步，后端会按版本合并。

### 语音与算力

文字聊天不需要本地 GPU。语音是可选能力：本地 TTS（GPT-SoVITS / BreezeTTS2）通常建议 NVIDIA GPU，6GB 显存起步，唱歌 / SVC 建议 12GB 以上；CPU 也能跑，但首句和长句会明显变慢。没有 GPU 就把语音和唱歌保持关闭，文字功能不受影响；入站语音转写走 SnowLuma 的接口，不需要本地 GPU。

私聊里也能管这些：`内心状态`、`跑一次分享`、`反思一下`、`发` / `不发`、`验证通过 <id>`。
完整指令表、示例频率和验证期规则见 [内心生活与主动分享](docs/guides/INNER_LIFE.md)。

## 代码提案：私聊里让她改进和开发

她不会自己写代码，但能把一句「不好用」整理成一份可执行的开发任务，交给**你自己的 coding agent**，并盯完从实现、测试到你确认合并、失败回滚的整条链路。

![代码提案闭环](assets/diagrams/proposal.png)
<p align="center"><sub>四段闭环：你说需求 → 她落成提案 → agent 在隔离副本实现 → 你确认合并</sub></p>

她先把需求拆成带现状、期望、证据和验收标准的提案，按内容哈希生成稳定 id，写进 `state/dev-proposals/` 与 `state/orchestrator/`。你的 agent 在隔离副本里实现并跑 `npm run verify`。你回「合并 `<id>`」之后，桥接逐文件备份、复制，再跑一次 verify，失败自动回滚。她只负责记录、排队、转达，不创建开发会话、不写业务代码、不合并；群聊里的人触发不了。

仓库自带 Qoder 唤醒适配，也可以换成 Codex、Claude Code、Cursor、Aider 或自写脚本。
完整流程、三条私聊回执的样例、接入契约和常见坑见 [代码提案闭环](docs/guides/CODE_PROPOSAL.md)。

## 能力地图

### 说一句，她自己排开发

她不会直接写代码，而是把你的一句话整理成**带现状、期望、证据和验收标准的提案**，
排进开发待办；真正实现的是你自己的 coding agent，合并权始终在你手里。

### 她决定说不说

群聊里没有「收到就回」的自动回复。每条消息先进未读队列，她按唤醒条件、夜间静默、
频率上限和当前精力决定：这次要不要看、看完要不要说、说几条、还是继续潜水。
35 个工具逐项可关；关掉后工具直接从她的清单里消失，而不是调用时才拒绝。

### 记忆，还有她自己的日程

她记得话题、挂念和群友印象，也记得跨会话的个人记忆；你可以在控制台翻看、修改、删除。
没有消息时她也不会停摆：定时反思、好奇浏览、心情与精力按真实时间演化，
想分享时再受每日上限、间隔和夜间静默约束。

工具清单、节奏边界、分门别类的能力表和安全默认值见 [完整能力清单](docs/guides/CAPABILITIES.md)。

## 实时状态页 `/live`

<p align="center">
  <img src="assets/screenshots/live.png" width="860" alt="实时状态页：小鲸鱼、羁绊、心情与内心生活">
  <br>
  <sub>只读实时状态页（离线演示数据），不含真实账号</sub>
</p>

挂在副屏上，看她的心情、精力、羁绊、兴趣、内心生活和此刻动向，也能看到每个会话的未读与活动。页面只读，通过 SSE 自动刷新，用独立令牌，默认只听 `127.0.0.1`。面板逐项说明见 [状态页与控制台](docs/guides/CONSOLE.md)。

## 本地控制台

<p align="center">
  <img src="assets/screenshots/console-overview.png" width="860" alt="控制台运行总览（浅色主题）">
  <br>
  <sub>运行总览 · 浅色主题（离线演示数据；深色主题见 <a href="assets/screenshots/console-dark.png">console-dark.png</a>）</sub>
</p>

<p align="center">
  <img src="assets/screenshots/console-features.png" width="860" alt="控制台功能控制页：按板块管理模块开关">
  <br>
  <sub>功能控制 · 板块总闸与模块开关（离线演示数据）</sub>
</p>

默认在 `http://127.0.0.1:3100`，13 个任务页：运行总览、功能控制、会话与审批、人格与角色、群聊剧场、群聊洞察、资源库、黑话词库、令牌与花费、访问与安全、调试与运维、可靠性与配置、工具参考。支持浅色与深色主题、响应式布局和草稿保护，不引用任何外部字体或统计脚本。逐页说明见 [状态页与控制台](docs/guides/CONSOLE.md)。

## 架构

<p align="center">
  <img src="assets/diagrams/architecture.png" width="100%" alt="小鲸鱼运行架构：QQ ↔ SnowLuma ↔ 本机桥接 ↔ DeepSeek Harness">
  <br>
  <sub>她住在哪里：整条链路都在你自己的机器上</sub>
</p>

整条链路只有两种角色。**接线层**收 QQ 事件、做白名单与唤醒准入、把短时间内的消息合并成一次、
维护会话映射与记忆，并统一负责对外发送；**思考层**（DSH agent）每次被唤醒时在隔离上下文里
读消息、查记忆、决定说什么，结果回到接线层，由同一个出口发出去。

所以会话是内部实现，你面对的是「一个群里的她」。为什么这样拆、上下文怎么按预算取用，
见 [架构与设计取舍](docs/ARCHITECTURE.md)。

## 安全与隐私

- **群友没有本地权限**：`qq-chat` 不挂载 bash / 文件读写 / 子代理 / 工作流，
  群友怎么诱导都无法操作本机；
- **QQ 动作是安全子集**：只允许三个 MCP 命名空间 + `ask_user_question` / `todo_write`，
  发送类工具强制命中白名单；语音只能发语音库里的文件；
- **高风险动作要确认**：跨会话指令、敏感操作会在 owner 私聊里要求 `/确认 <6 位码>`；
- **人格由桥接注入**：角色来自 `personas/` 与控制台，群友口头要求改人设无效；
- **不把内部错误发进群**：DSH / SnowLuma / QQ 的原始报错只留在日志和 `GET /api/status`；
- **仓库不含密钥**：真实 `config.json`、`state/`、`audio/` 都不会进入仓库，只提供脱敏模板。

隐私相关的数据出机清单（例如黑话学习会把词条交给搜索后端，可关闭）见
[docs/guides/PRIVACY.md](docs/guides/PRIVACY.md)；权限边界见 [RULES.md](RULES.md)。
发现安全问题请按 [SECURITY.md](SECURITY.md) 私密报告，不要开公开 issue。

## 已知限制

- 仅支持 Windows 10 / 11；单机常驻，不做跨设备同步；
- agent 回复在回合结束时一次性发送，不做流式逐字转发；
- 没有按话题拆分执行会话，同一个群里的多条话题共享一条上下文；
- 没有任务级进展看护，只有进程 / 端口 / 租约探活和「连续无行动」计数。

完整清单（入站语音、视频消息、语音默认开关、Markdown 转纯文本等）见
[排查手册与已知限制](docs/guides/TROUBLESHOOTING.md#已知限制)。

## 文档

| 文档 | 内容 |
| --- | --- |
| [docs/README.md](docs/README.md) | 文档索引（每篇一句话） |
| [CHANGELOG.md](CHANGELOG.md) | 开发日志：每个版本改了什么、为什么改 |
| [docs/guides/AGENT_DEPLOY.md](docs/guides/AGENT_DEPLOY.md) | 交给 agent 部署：执行步骤、边界、验收与回滚 |
| [docs/guides/MANUAL_DEPLOY.md](docs/guides/MANUAL_DEPLOY.md) | 手动部署六步与运行模式 |
| [docs/guides/TROUBLESHOOTING.md](docs/guides/TROUBLESHOOTING.md) | 排查手册与已知限制 |
| [docs/guides/CAPABILITIES.md](docs/guides/CAPABILITIES.md) | 完整能力清单、工具与节奏边界 |
| [docs/guides/CODE_PROPOSAL.md](docs/guides/CODE_PROPOSAL.md) | 代码提案闭环与任意 agent 接入 |
| [docs/guides/INNER_LIFE.md](docs/guides/INNER_LIFE.md) | 内心生活、主动分享与私聊指令 |
| [docs/guides/CONSOLE.md](docs/guides/CONSOLE.md) | `/live` 与控制台逐页说明 |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | 架构、设计取舍与上下文预算 |
| [docs/guides/EXTENDING.md](docs/guides/EXTENDING.md) | 兼容矩阵、扩展点与开发闭环 |
| [docs/guides/DSH_SETUP.md](docs/guides/DSH_SETUP.md) | DSH 端安装：preset、MCP、重启 |
| [docs/guides/DSH_ADAPTATION.md](docs/guides/DSH_ADAPTATION.md) | DSH 0.2.0-rc.2 适配与版本说明 |
| [docs/guides/SECURITY_BASELINE.md](docs/guides/SECURITY_BASELINE.md) | 安全基线与 Windows ACL |
| [docs/guides/RELIABILITY.md](docs/guides/RELIABILITY.md) | outbox / 队列 / 重试机制 |
| [docs/guides/TOKEN_USAGE_CONSOLE.md](docs/guides/TOKEN_USAGE_CONSOLE.md) | 花费看板的口径与价目表 |
| [docs/guides/CONSOLE-UI-TESTING.md](docs/guides/CONSOLE-UI-TESTING.md) | 控制台离线回归与预览 |
| [docs/guides/PRIVACY.md](docs/guides/PRIVACY.md) | 数据出机清单与隐私开关 |
| [docs/FOLDER_MAP.md](docs/FOLDER_MAP.md) | 目录结构与脚本命名约定 |
| [RULES.md](RULES.md) | QQ 会话的权限边界与安全承诺 |
| [SECURITY.md](SECURITY.md) | 漏洞报告流程 |
| [UPSTREAM.md](UPSTREAM.md) | 与上游的关系、跟进规则 |
| [NOTICE](NOTICE) | 第三方组件与许可说明 |

## 上游与许可

起点是 MIT 许可的 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)（基线 `v0.2.0-r4`）。
上游的名称、版权行与 MIT 许可完整保留；具体分叉点与跟进规则见 [UPSTREAM.md](UPSTREAM.md)。

本仓库与上游均以 MIT 发布，感谢 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge)、
[SnowLuma](https://github.com/SnowLuma/SnowLuma) 和 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)；
第三方组件与许可说明见 [NOTICE](NOTICE)。

SnowLuma 是独立第三方项目，与腾讯 / QQ 无隶属关系；本项目仅供学习与技术研究，
使用前请阅读 SnowLuma 的 EULA 与《QQ 用户协议》。

`@snowluma/sdk` 的 npm 发布版存在 ESM 扩展名 bug，`postinstall` 会用
`tools/patch-snowluma-sdk.mjs` 修补**本地 node_modules 安装副本**；补丁不复制、不打包、
不再分发。若你的许可协议不允许修改该组件，请升级到已修复的上游版本并从 `package.json`
移除该 postinstall。
