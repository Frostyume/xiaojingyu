# 可靠性与诊断（SQLite / Outbox / Jobs / Doctor）

> 适用版本：2026-10-25 Stage 1 起。本文只描述机制与操作，不含任何真实 QQ 号/群号/令牌。
> 相关代码：`runtime/kernel/db.js`、`runtime/kernel/outbox.js`、`runtime/kernel/jobs.js`、`runtime/kernel/inbox.js`、
> `runtime/kernel/config-schema.js`、`runtime/kernel/logger.js`、`tools/healthcheck.mjs`。

## 1. 一句话

消息**先落盘再处理**、发送**先落盘再发**、定时任务**先落盘再执行**；
发不出去就排队重试，发不确定就停下来等人确认，而不是静默丢或重复发。

## 2. 开关与配置

全部在 `config.json` 的 `storage` 段（`config.example.json` 已给出默认值）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 总开关。关掉后完全回到旧的 JSON/内存路径 |
| `dbPath` | `state/db/bridge.db` | 数据库位置（相对仓库根或绝对路径） |
| `backupDir` | `D:/xiaojingyu-backups`（Windows） | 迁移前在线备份；盘符不存在会自动回退 `state/backups` |
| `backupKeepDays` | `7` | 备份保留天数 |
| `retentionDays` | `30` | 已结束记录（sent/dead/done）保留天数 |
| `outboxEnabled` | `true` | 出站消息先落盘 |
| `inboxEnabled` | `true` | 入站去重 + 启动重放 |
| `jobsEnabled` | `true` | 提醒/内心生活使用统一任务队列 |
| `inboxReplayMaxAgeMs` | `120000` | 只重放 2 分钟内的未处理消息 |
| `outboxMaxAttempts` | `5` | 出站最多尝试次数 |
| `outboxRetryBaseMs` / `outboxRetryMaxMs` | `5000` / `600000` | 指数退避区间 |
| `configStrict` | `false` | `true` 时配置校验失败拒绝启动 |
| `logJsonl` | `true` | 额外写 `state/logs/bridge-YYYY-MM-DD.jsonl` |

控制台「可靠性与配置」页可以查看队列状态、重试/丢弃，并按 schema 直接改配置；
密钥字段只显示「已配置/未配置」，不会回传明文。

## 3. SQLite

- 驱动：Node 内置 `node:sqlite`（实验 API），封装在 `runtime/kernel/db.js`；业务不直接依赖驱动。
  将来若要换 `better-sqlite3`，只改适配层。
- `journal_mode=WAL`、`synchronous=NORMAL`、`busy_timeout=5000`。
- 迁移：`schema_migrations` 表，单向递增；迁移前若有旧库会 `VACUUM INTO` 在线备份。
- 表：`events`（入站）、`outbox`、`jobs`、`memory_facts`、`member_relationships`、`usage_ledger`、`meta`。
  后两张业务表在 Stage 2/3 接入；现在只建表。
- 膨胀控制：启动时清理超过 `retentionDays` 的已结束记录；备份超过 `backupKeepDays` 自动删除。

> Node 24 会打印 `ExperimentalWarning: SQLite is an experimental feature`。这是预期行为，
> 不应静默屏蔽；升级 Node 前先在测试库上跑 `npm run test:core`。

## 4. 出站 outbox

每条要发的文本先写一层 `outbox`，再交给传输层（WS 或 OneBot HTTP）。

状态：

| 状态 | 含义 | 会不会自动重发 |
| --- | --- | --- |
| `pending` | 已落盘，等待发送/重试 | 会（按退避） |
| `sending` | 正在发送 | 进程若在此状态退出，重启后转 `uncertain` |
| `sent` | 传输层已确认 | 不会 |
| `dead` | 永久错误或重试耗尽 | 不会，需人工处理 |
| `uncertain` | 无法确认是否已送达 | **不会**，必须人工确认后点“重试” |

关键语义：

- **0 重复**：同一逻辑消息有唯一 `dedupe_key`；启动重放走同一行。
- **0 静默丢失**：失败留 `pending` 并重试；永久错误进 `dead` 并在控制台可见。
- **发送中崩溃不做有罪推定**：`uncertain` 不会自动重发（QQ 没有幂等键，
  自动重发可能让群里出现两条）。
- SnowLuma 未连接时 `isReady=false`，不消耗重试次数，等连接恢复后自动补发。
- 静默模式/会话权限变化在**实际发送前**再次校验；被挡住的消息不会越权发出。

## 5. 入站 inbox

- 每条 QQ 事件先写 `events`，`dedupe_key = kind:会话:message_id`。
- 重复投递（重连/补发）若已处理则直接忽略；未处理则继续处理。
- 启动时重放「未处理且在 `inboxReplayMaxAgeMs` 内」的消息；更旧的消息只留审计，
  不自动回复（隔很久突然回旧消息比丢一条更糟）。
- 重放前会检查会话状态里是否已有该 message_id，避免重复写入。

## 6. 统一任务队列 jobs

替代各自 `setTimeout/setInterval` 的调度：

- 单线程串行执行（有副作用的任务不并发）；
- `dedupe_key` 唯一，重复登记不会产生两条；
- 失败指数退避，超过 `max_attempts` 进 `dead`；
- 支持 `retryAfterMs`（不消耗次数地延后，例如静默模式/模式不允许）；
- 进程在执行中退出 → 重启后 `running` 转回 `pending` 重新排队。

当前接入：

| 任务 | 说明 |
| --- | --- |
| `reminder.due` | 提醒到点发送；与 outbox 共用 `reminder:<id>` 去重键 |
| `inner-life.tick` | 内心生活的下一次 tick（反思/好奇/说说） |

未接入的定时器（订阅刷新等）仍按旧路径运行，后续 Stage 3 再迁。

## 7. Doctor

```bash
npm run doctor                  # 人类可读
npm run doctor -- --json        # CI/机器可读
npm run doctor -- --fix-dsh-port  # DSH 重启换了端口后，写回 dsh.baseUrl（自动备份）
npm run doctor -- --fix-config    # 把配置版本迁移写回 config.json（自动备份）
```

检查项包括：Node/`node:sqlite`、config 解析与类型校验、state 可写、SQLite 版本与队列积压、
DSH 进程/端口/HTTP、SnowLuma 进程与 OneBot 端口、桥接进程与控制台 API、
角色卡、preset 源与 patch 新鲜度、最近日志错误（已脱敏）、磁盘、`.gitignore` 隐私。

退出码：有 `fail` 为 1；只有 `warn` 为 0。

> 不会自动启动 SnowLuma（EULA）；只探测进程与端口。

## 8. 结构化日志

- 原文本日志（`state/bridge.log`，控制台友好）保留不变。
- 额外写 `state/logs/bridge-YYYY-MM-DD.jsonl`：`{ ts, level, msg, ...meta }`。
- 写入前脱敏：Bearer、token/api_key/secret 赋值、URL 里的 token。
- 单文件超过 8 MB 自动轮转为 `.1`…`.4`。
- `state/` 已被 `.gitignore` 排除；日志里仍可能含会话 key，**不要外发**。

## 9. 故障处置速查

| 现象 | 先看 | 处理 |
| --- | --- | --- |
| 群里没收到回复 | `npm run doctor`；控制台「可靠性」出站队列 | `pending` 等重试；`dead` 看 lastError；`uncertain` 人工确认 |
| DSH 重启后不回话 | doctor 的「DSH 端口」 | `npm run doctor -- --fix-dsh-port`，再重启桥接 |
| 提醒没响 | 任务队列里 `reminder.due` | 看是否 `cancelled/dead`，确认提醒仍在 `state/reminders.json` 且未过期 |
| 消息重复回复 | 入站队列/日志 `重复消息已忽略` | 若没有该行，检查 SnowLuma 是否重复投递且 message_id 为空 |
| SQLite 打不开 | doctor `db.open` | 检查磁盘/ACL；临时设 `storage.enabled=false` 可回到旧路径启动 |

## 10. 回归

```bash
npm run test:core     # 数据库/队列/schema/日志/doctor 纯离线
npm run test:audit    # 全量离线回归（不含真 QQ/DSH）
```

故障注入已覆盖：发送失败重试、发送中崩溃（uncertain）、待发送重放、任务执行中崩溃、
重复入站、过旧消息不重放、配置非法值拒绝。

## 11. 上下文预算与长会话成本（Stage 2）

| 配置 | 默认 | 作用 |
| --- | --- | --- |
| `simulation.context.wakeBudgetTokens` | 5000 | 唤醒 prompt 的 token 预算；超了按优先级丢可选段（赛果/节奏提示/搜索说明…），人格内核、令牌、工具协议、睡前观察永不丢 |
| `simulation.context.rotateAtTokens` | 120000 | 单会话 input tokens 超阈值时，**下一次唤醒前**归档旧会话并注入本地衔接摘要；0=关闭 |
| `simulation.context.digestMaxChars` | 1500 | 摘要上限（最近话题/想说没说/群友印象/最近几轮/操作者初始提示词） |

要点：

- 摘要**不调用模型**：由桥接从已有状态生成，零 token 成本。
- 旋转发生在真正投递唤醒前，且要求会话不忙、距上次旋转 ≥10 分钟；不会在对话进行中腰斩。
- 新会话第一轮带着摘要+轻量记忆开始，旧 DSH 会话归档而不是删除。
- 预算组合器在未超预算时**逐字不变**，避免无意义的行为漂移。

## 12. 价值评分（Stage 2）

- 只作用于泛监听：`anyMessage`、概率唤醒。
- **@ / 引用机器人 / 私聊 / 明确提问 / 关键词** 永不降级（被叫必回）。
- 输入全部便宜：话题重合、熟悉度、最近自己发言数、复读、夜间、消息过短。
- 阈值：`valueScore.wakeThreshold`（默认 0.55）/ `deferThreshold`（0.32）。
- 统计写在会话状态 `scoreStats`，控制台/诊断可看趋势；关闭：`valueScore.enabled=false`。

## 13. 模型路由与分层记忆（Stage 2）

- 路由解析顺序：群级覆盖 → 任务档位（chat/reflection/research）→ fallback → 基础配置。
- `routing.tiers` 可给不同任务设不同 provider/model/effort；`routing.fallback` 是备用链路，
  主链路失败会自动尝试下一条（`session/selectModel` 不支持 effort 时自动去掉该参数）。
- 记忆：
  - 轻量数组（进行中话题/印象）仍在 `simulation.json`；
  - 长期事实另存 SQLite `memory_facts` + FTS5(trigram)，`topK` 条按相关度注入；
  - 重复事实只累加权重；过期/低置信度会在启动时清理；
  - 2 字中文查询走 LIKE（trigram 需要 ≥3 字符），3 字以上走 FTS。
- 会话映射影子副本：`session_map` 表随 `saveState()` 同步；`sessions.json` 丢失/回滚时
  启动会自动补回缺失的 key。

## 14. 群友关系（Stage 3 起，2026-10-26 升级为 galgame v2）

- 四轴 0~100：好感 `affection`、信任 `trust`、熟悉 `familiarity`、默契 `rapport`；
  派生 `bond` 用于阶段判定：
  `bond = 0.45×好感 + 0.25×信任 + 0.2×熟悉 + 0.1×默契`。
- 阶段（galgame）：陌生 → 眼熟 → 熟人 → 朋友 → 亲近 → 特别；
  升级按阈值，降级要低于阈值 3 点且过了 24h 冷静期，避免横跳。
- 事件：@/引用、提问、私聊、回复、拍一拍、夸奖、道谢、道歉、共同兴趣、语音、第一次、冲突/辱骂/刷屏等；
  每条事件写入 `relationship_events`，按天聚合到 `relationship_daily`。
- 防刷与边界：同类事件当日边际递减；好感每日最多 +4 / −6，信任 +1 / −2；
  负向有底，不会出现“永久讨厌”；道歉+稳定互动可恢复。
- 主人：信任/熟悉固定 100；好感 95→100、默契 80→100 可因正向互动缓慢上涨（每日上限 1 / 2），
  负面事件不会把好感打到 95 以下；阶段始终显示“主人”。只有主人可以触发撒娇/黏人语气。
- 群友最高“特别的朋友”：可以更放松、更深玩笑，但**不撒娇、不占有、不恋爱化**。
- 启用范围：默认开启；`excludeFamily=true` 时按群标签（家人/家庭/family）自动排除；
  `groupProfiles[group].relationships=false/true` 可按群覆盖；控制台可手动开关。
- prompt 只注入阶段、四轴描述、最近事件原因和“对当前说话人的语气”，**不注入数值和 QQ 号**。
- 影响：泛监听唤醒评分（羁绊作为熟悉度）、主动机会优先找高默契成员、称呼/玩笑尺度/主动性；
  不会覆盖 @/引用/私聊/提问/关键词的“被叫必回”。
- 控制台「群聊洞察」：阶段/羁绊/四轴/备注可编辑，支持时间线、重置、按群开关；
  实时页 `/live` 用昵称 + 脱敏 id 展示羁绊卡、四轴、7 日曲线和最近变化。
- 迁移修正（v4）：v3 曾把旧模型的“中性 0.5”换算成 50 分，导致老成员一上来就是熟人/眼熟；
  v4 只重算「从未被新模型观察过、没有事件、且数值像旧迁移值」的行，主人/手动高值保持不动。
  新成员从好感 8 / 信任 5 / 熟悉 0 开始，阶段为陌生。

## 15. 结构化人格包（Stage 3）

- 位置：`personas/<角色名>.persona.json`，与角色卡同名；**角色卡仍是权威**，冲突时以卡为准。
- 字段：identity / tone（warmth, verbosity, humor, clinginess）/ examples / boundaries /
  emotions / voice（emotionRefs, emotionSpeed）。
- 缺失或损坏时静默回退 Markdown（只告警一次）；保存前校验、限长、拒绝危险键。
- 控制台接口：`GET/POST /api/roles/persona`、`POST /api/roles/persona/delete`、
  `GET /api/roles/export`、`POST /api/roles/import`（导入会备份原卡）。

## 16. 链接 / 卡片解析（Stage 3）

- `json` / `xml` / `card` / `music` / `share` 段统一解析成
  `[卡片消息] 标题 · 摘要 · 来源 · URL`，**绝不把原始 JSON/XML 给模型**。
- URL 只接受 http/https、去掉凭据；标题/摘要压平换行、剥标签、限长（防提示注入伪造段落）。
- 只解析不抓取，不触发 SSRF。

## 17. 语音（Stage 3）

- TTS 情绪音色：`runtime/persona/tts-emotion.js` 从要说的文本推断情绪（shy/happy/sad/excited/soft/neutral），
  按「人格包 voice 映射 → config.tts.emotionRefs/emotionSpeed → 默认」选择参考音频与语速；
  **显式传入的 speed 永远优先**。
- ASR（语音转写）：默认关闭。开启后，带 `record` 段的入站消息调用 SnowLuma `fetch_ptt_text`，
  在文本后附加 `[语音转写] …`；失败静默保留 `[语音]`，不阻塞消息。
- TTS 映射改动在 MCP 进程里生效，需要重启 DSH；ASR 在桥接进程里，重启桥接即可。

## 18. 群日报（Stage 3）

- 默认**关闭**，按群开启：`simulation.dailyReport.groups` 或
  `groupProfiles[group].dailyReport=true`。
- 每天固定时间（上海时区，默认 21:30）由任务队列发送；内容为本地统计：
  消息量/参与/活跃成员/在聊话题/链接/摘录，**不调用模型**。
- 控制台「群聊洞察」可预览（不发 QQ）：`GET /api/daily-report/preview?key=group:…`。

## 19. Feature API 与事件总线（Stage 4）

新功能放 `features/<id>/index.js`，默认无权限，加载时按白名单授予：

```js
export default {
  id: 'daily-report',            // 必须与目录名一致
  name: '群日报',
  permissions: ['state:read', 'jobs:write', 'qq:send', 'service:daily-report'],
  hooks: {
    // onMessage / onWake / onTurnEnd / onSchedule / beforeSend / onConsoleRequest
    // formatSegment 是同步直调（消息转文本立即需要结果）
  },
  setup(ctx) {},                 // 注册任务/路由；抛错只禁用自己
  start(ctx) {}, stop(ctx) {}
};
```

- 事件派发：`onMessage→message`、`onWake→wake`、`onTurnEnd→turn/end`、`onSchedule→schedule`、
  `beforeSend→beforeSend`、`onConsoleRequest→console/request`。
- 监听器按 priority 执行；抛错/超时**只记录，不影响其它监听器与主流程**。
- 已迁移：`rich-cards`（卡片格式化）、`daily-report`（任务注册与排程）。
- 关闭某个 feature：`features.disabled: ["id"]`（重启桥接生效）。
- 查看：`GET /api/reliability` 的 `features`；运行中不会因为某个 feature 失败而整体退出。

## 20. 传输适配层（Stage 4）

- `runtime/kernel/transport.js`：核心只调用 `sendText/getMember/getForward`。
- `transport.kind = "snowluma"`（默认）：纯文本走 WS（沿用现网），引用/@/媒体走 OneBot HTTP；
- `transport.kind = "onebot"`：通用 OneBot v11 HTTP（NapCat 等），所有发送走 HTTP。
- 能力矩阵：OneBot 的 `voice=false`，调用前明确报「不支持」，而不是发到一半才失败。
- 入站目前仍由 SnowLuma WS 提供；NapCat 入站适配留待后续（不伪装已支持）。
- 查看：`GET /api/transport`。

## 21. 预算（Stage 4）

- 账本：`usage_ledger`，按 `(session, turn, step, retry)` 幂等；token 来自 provider usage，
  费用按价目表估算（仅展示）。
- 配置：`simulation.budget.{enabled,dailyTokensPerKey,dailyTokensGlobal,blockNonExplicitOnly}`；
  0 = 不限。
- 策略：默认只压制**非显式**唤醒（概率/任意消息/主动机会/定时检查）；
  @/名字/关键词/提问/私聊/拍一拍/管理员/引导永远放行。
- 查看：`GET /api/budget`（可按 `key` 查单会话）；`GET /api/reliability` 含今日汇总。

## 22. DSH 生命周期外壳（Stage 4）

- `npm run dsh:ensure`：检测 DSH 进程与监听端口，对比 `config.dsh.baseUrl`；
  `--fix` 时写回（自动备份 config.json），`--json` 供自动化读取。
- 不启动/停止 DSH，也不自动重启桥接；写回后按提示重启桥接。
- 深度的 DSH 插件化（把桥接改成 DSH plugin）本轮**不做**：当前 MCP + preset + 独立桥接
  的边界已经稳定，直接插件化会同时改动安全边界与热加载路径，收益不足；等 Stage 5 前再评估。

## 23. 控制台鉴权（2026-10-26 调整）

- 默认 `consoleAuth.enabled = false`：浏览器打开控制台/实时页不再要求输入访问令牌。
- 仍然保留的边界：
  - 只监听 `127.0.0.1`，Host 头必须是 `127.0.0.1` / `localhost` / `[::1]`；
  - 所有写操作必须是 `application/json`，带 Origin 时必须同源；
  - 智能体调用（`x-agent-call` / `x-agent-token`）仍走独立的会话令牌与权限闸门；
  - 控制台令牌仍会生成到 `state/console-token`，MCP 工具进程需要时继续携带。
- 风险：关闭后，**本机任意进程/页面**（绕过浏览器同源限制的程序）都能调用管理接口，
  读取聊天记录、发送消息、改角色/配置。请只在单人可信的本机环境关闭。
- 恢复：`consoleAuth.enabled = true` → 重启桥接；控制台「访问与安全」里的令牌卡会重新出现。

## 24. 自动个性签名（2026-10-26）

- 配置：`simulation.signature.{enabled,minIntervalHours,maxIntervalHours,firstDelayMs,maxChars,dryRun}`；
  默认开启，首次约 10 分钟后，之后每次在 **12–48 小时之间随机**（均匀分布，不再固定 24h）。
- 内容：本地根据心情/精力/兴趣/时段生成，**不调用模型**；避开最近 20 条；末尾不留句号。
- 动作：SnowLuma `set_qq_profile` 的 `personal_note`；同时带当前昵称，避免网关清空昵称。
- 不发送群消息、不发说说；手动更新后 6 小时内不会自动再改。
- 控制台「群聊洞察 → 个性签名」：自动开关、换一句、编辑后立即更新、历史记录。
- 接口：`GET /api/signature`、`POST /api/signature/preview`、`POST /api/signature/apply`、
  `POST /api/signature/toggle`；状态存 `state/signature.json`。
- 失败：任务按退避重试；`lastError` 在控制台可见，不会影响聊天主链路。

## 25. 联网搜索 provider（2026-10-26）

| provider | 说明 |
| --- | --- |
| `auto`（默认） | 先 DeepSeek 原生搜索，无凭据/失败时回退 Bing |
| `deepseek` | 只用 DeepSeek Anthropic `/messages` + 服务端 `web_search` 工具 |
| `bing` | 只用 Bing RSS（再退 HTML） |
| `chatanywhere` | OpenAI 兼容中转：`/chat/completions` + `web_search_options`；默认模型 `gemini-2.5-flash-lite`（实测可用且便宜） |

- ChatAnywhere 的 key **不能**用于 DeepSeek provider：协议/端点/工具都不同。
- ChatAnywhere provider 需要模型支持 `web_search_options`；失败会自动回退 Bing 并注明原因。
- key 来源：`webSearch.apiKey` → `webSearch.apiKeyEnv`（默认 `CHATANYWHERE_API_KEY`）→ DSH 凭据。
- 代码/模型变化后需要重启 DSH（`web_search` 是 DSH 拉起的 MCP 子进程）；配置本身每次调用会重新读取。
- 结果优先取回答里的真实链接，避免把 Gemini 的 `vertexaisearch` 跳转链接直接给模型。
