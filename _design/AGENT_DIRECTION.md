# 小鲸鱼架构演进方向（评审稿）

> 状态：设计提案，不含运行时代码改动。
> 基线：开源库 `46a883d`（本 worktree）。私有运行库同名逻辑另在 `src/bridge.js`，行号可能不同；
> 本文证据以本 worktree 的 `app/whale.js` 为准。
> 前提：上下文水位口径的修复由另一个会话负责，本文不重复该工作；P1 的测量在该修复合入后重取基线。

## 0. 结论先行

| 优先级 | 方向 | 判断 | 理由 |
| --- | --- | --- | --- |
| **P1** | 上下文索引化：常驻清单 + 按需取全文 | **建议做**，低风险、收益中等且可测量 | 当前唤醒 prompt 里约 1.5–2.5k token 属于「这次未必用得上」的材料；把它们降为索引，预计每次唤醒省 400–900 token（9%–19%），激进档 900–1500（20%–32%） |
| **P2** | 统一持久化调度 + 任务级进展看护 | **建议做，排在 P1 之后** | 调度器可复用已有 `jobs` 表，风险可控；看护能补上目前只有 `noActionCount` 与 15 分钟 `STALL_MS` 的空白 |
| **P3** | 话题级执行会话 | **先设计，不实施** | 能解决长话题互相污染，但会引入订阅、去重、结果合并三套协议；当前单机规模收益不足以抵消复杂度 |
| **P4** | 群内缺陷静默预演 | **可选，默认关闭** | 对「报告桥接自身缺陷」有价值，但会执行代码、消耗资源，必须先有隔离与审计 |

一句话：**先把「每次唤醒带什么」做薄（P1），再把「什么时候醒来、醒来有没有进展」做稳（P2）；  
多会话与自动预演暂时不做。**

---

## 1. P1 上下文索引化

### 1.1 现状证据

- 唤醒 prompt 由一个集中的 section 数组组装：`app/whale.js:15991`（`const sections = [...]`），
  预算与丢弃顺序在 `app/whale.js:16032`（`assembleSections`，默认 `wakeBudgetTokens` 见
  `app/whale.js:1221`；运行库默认值以实际配置为准，本文不写死）。
- 分段预算器：`runtime/kernel/prompt-budget.js:55`（`assembleSections`），超预算时按 `dropOrder`
  丢可选段、最后截断长段；token 估算 `runtime/kernel/prompt-budget.js:12`。
- 已经部分索引化的：
  - 表情只给候选列表（默认 12 条）：`app/whale.js:1026`、`app/whale.js:1148`；
  - 图片只给候选列表（默认 8 条）：`app/whale.js:1183`；
  - 未读快照有上限（12 条 / 6000 字 / 最近 4 条）：`app/whale.js:15513`；
  - 快照不完整时标 `partial`，按位点续读：`app/whale.js:15516`。
- 仍然整段内联的：
  - 跨会话动态（近 3 条分享 + 2 条说说，各 80 字）：`app/whale.js:15800`（`crossChatLifeLine`）；
  - 个人记忆 topK6 / 600 字：`app/whale.js:15850`；
  - 长期记忆 topK6 / 800 字：`app/whale.js:15871`；
  - 关系摘要 top5：`app/whale.js:15894`；
  - 赛果摘要（≤1400 字）与赛程块：`app/whale.js:15922` 起；
  - 黑话表由 `withSlangContext` 另行注入（`app/whale.js:8866`）；
  - 长手册只注入 1–2 篇，但仍为全文。
- 只读工具已存在，可直接扩展命名与鉴权口径：`qq_get_prompt`（`mcp/qq-actions.js:577`）、
  `qq_get_unread_messages`（`mcp/qq-actions.js:591`）、`qq_get_chat_context`
  （`mcp/qq-actions.js:484`）、`qq_memory_query`（`mcp/qq-actions.js:945`）。

### 1.2 目标

把 `buildWakePrompt` 的每个可变段分成两类：

1. **高频必带**：人格内核、身份、工具协议、安全边界、当前时间、当前触发、未读快照、唤醒方式。
   这些决定「她是谁、能做什么、为什么醒来」，继续内联。
2. **低频可取**：跨会话动态、完整分享正文、关系细节、长期记忆全文、黑话释义全集、历史摘要、
   赛果长文、图片/表情完整清单。只内联**稳定 ID + 一句摘要 + 长度估计**，需要时用工具取全文。

保留原则：**topK 摘要仍然内联**。索引不是把记忆变成空指针；模型不该为了知道「主人周五交项目」
而先发一次工具调用。

### 1.3 方案

#### 数据结构

新增只读视图（可以是 SQLite 表，也可以是启动时从现有 `state/` 生成的物化索引）：

```sql
CREATE TABLE IF NOT EXISTS context_items (
  id            TEXT PRIMARY KEY,   -- ctx:mem:<hash> / ctx:share:<ts> / ctx:snap:<key>:<seq0>-<seq1>
  kind          TEXT NOT NULL,      -- memory | dynamic | snapshot | relationship | slang | manual | media
  scope         TEXT NOT NULL,      -- group:<id> | private:<id> | global
  source_table  TEXT,
  source_id     TEXT,
  summary       TEXT NOT NULL,      -- ≤120 字，注入用
  token_est     INTEGER NOT NULL,
  sensitivity   TEXT NOT NULL,      -- public | personal | secret
  created_at    INTEGER NOT NULL,
  expires_at    INTEGER
);
CREATE INDEX IF NOT EXISTS idx_context_scope_kind ON context_items(scope, kind);
```

- ID 必须**稳定**：同一记忆/同一条说说在多次唤醒中复用同一 ID，避免缓存前缀每次变化。
- 快照 ID 按序号区间生成（`ctx:snap:<key>:<seqFrom>-<seqTo>`），续读时生成下一段 ID。
- `sensitivity=secret` 的条目（令牌、Cookie、内部路径）不进入索引，也不允许工具取回。

#### Prompt 改动

在需要索引化的段落位置，用统一格式替换全文：

```text
【可查上下文】以下只给摘要与 ID；需要原文时调用 qq_context_fetch(ids=[...])，一次最多 5 条。
- ctx:mem:7f3a（个人记忆，约 180 token）：主人周五交项目，交完想去海边
- ctx:share:1729...（群动态，约 90 token）：群友在聊周末露营
- ctx:snap:group:...:41-52（历史快照，约 600 token）：上周关于部署的讨论
```

规则：

- 每条摘要 ≤120 字，整个索引块 ≤600 token；
- 与当前消息明显无关的条目**不列**（沿用现有 topK 检索与 `exclude` 口径）；
- 工具结果末尾附 `nextIds`，允许逐跳展开；
- 索引块本身按低优先级段参与 `assembleSections`，超预算先丢。

#### 工具接口（新增 `qq_context_fetch`）

```json
{
  "name": "qq_context_fetch",
  "arguments": {
    "ids": ["ctx:mem:7f3a", "ctx:share:1729"],
    "maxChars": 1200,
    "purpose": "reply"
  }
}
```

返回：

```json
{
  "items": [
    { "id": "ctx:mem:7f3a", "kind": "memory", "text": "...", "truncated": false, "nextIds": ["ctx:snap:...:41-52"] }
  ],
  "totalChars": 980,
  "auditId": "cf_20261101_..."
}
```

硬约束：

- `ids` 1–5 条；单条 ≤1200 字，总计 ≤3000 字；
- `kind` 白名单：`memory | dynamic | snapshot | relationship | slang | manual | media`；
- **scope 校验**：只允许当前会话 key 与 `global`，拒绝跨群/跨私聊读取；
- `sensitivity=secret` 一律拒绝；
- 每次调用写审计（ID、长度、调用会话、时间），不写正文；
- 工具注册在现有 `qq-actions` 命名空间内，复用现有审计与权限开关。

#### 提示词约束

在工具协议段加一句（固定成本约 40 token）：

```text
【取上下文】索引里的内容只是线索。只有回答确实需要细节时才调用 qq_context_fetch；
一次取完相关条目，不要为同一话题反复取。摘要已经够用就直接回答。
```

### 1.4 影响与测量

预计每次唤醒节省（以当前 4.4–4.7k token 为基线，按 section 盘点的保守估算）：

| 档位 | 索引化范围 | 每次唤醒节省 | 占比 |
| --- | --- | --- | --- |
| 保守 | 跨会话动态、赛果长文、关系细节、黑话长释义 | 400–900 token | 9%–19% |
| 激进 | 再加完整分享正文、历史摘要、图片/表情完整清单 | 900–1500 token | 20%–32% |

额外一次工具往返的成本：

- 多一个 assistant step，输入侧增加一次工具结果（≤3000 字 ≈ 750–1000 token）与一次工具 schema
  命中；有缓存时增量 prefill 很小，无缓存时最坏再读一次完整 prompt（约 4–5k token）。
- 延迟：单次工具往返通常 1–3 秒；若模型每次唤醒都调用，p95 会明显变差。
- **因此索引化的收益门槛是：一次取回必须替代 ≥1.2k token 的内联内容。** 低于这个门槛的段
  （个人记忆摘要、当前状态）继续内联。

测量方法（离线，不打真机）：

1. 新增 `tools/prompt-bench.mjs`（仅设计）：读取脱敏 fixture（`config.example.json` + 构造的
   `state` 快照），调用导出的 prompt 组装函数或直接复用 `assembleSections`；
2. 对每种唤醒原因（bootstrap / @ / 私聊 / timeout / 主动分享）各跑 50 次，输出：
   - 每段 token、总 token、被丢弃/截断的段；
   - 索引块 token 与替代掉的全文 token；
   - 最坏情况（所有条目都取回）的总 token；
3. 用现有 token 账本做线上 A/B（`services/social/token-ledger.js:22`，按 session × turn 记录
   cacheMiss/cacheHit/output），只看聚合值，不导出正文；
4. 验收指标：唤醒 prompt 中位数下降 ≥10%；每轮工具调用数增加 ≤0.4；p95 延迟增加 ≤1.5s；
   缓存未命中率不恶化超过 3 个百分点。

### 1.5 风险与回滚

| 风险 | 缓解 | 回滚 |
| --- | --- | --- |
| 模型不知道索引里有东西，回答变浅 | topK 摘要仍内联；索引块固定标题；提示词明确「先看摘要」 | 关闭 `simulation.context.indexed`，恢复全文注入 |
| 工具往返拖慢回复 | 只对低风险段启用；限制每次 5 条；监控每轮调用数 | 同上，按段灰度 |
| 跨会话越权读取 | scope 校验 + secret 拒绝 + 审计 | 直接下线工具 |
| ID 不稳定导致缓存前缀变化 | ID 由内容哈希与时间戳生成，测试固定 fixture | 回退到旧 ID 方案 |

### 1.6 分阶段落地

- **第 1 周**：只做盘点与 harness，不改运行时；产出每段 token 基线。
- **第 2 周**：加 `context_items` 索引与 `qq_context_fetch`，先只对「跨会话动态 + 赛果 + 关系细节」
  生效，配置开关默认关闭；灰度到主人私聊与一个测试群。

---

## 2. P2 统一事件调度 + 任务级看护

### 2.1 现状证据

- 已有持久化 `jobs` 表：`runtime/kernel/db.js:64`，字段含 `run_after`、`attempts`、
  `max_attempts`、`locked_until`、`dedupe_key`；队列实现 `runtime/kernel/jobs.js:34`，
  5 秒 tick、租约回收、指数退避、dead 状态都已具备。
- 但仍有大量各自为政的定时器：
  - `app/whale.js:3270`（owner feature，30s）、`app/whale.js:3272`（开发提案结果，30s）、
    `app/whale.js:3279`（提醒，30s）；
  - `app/whale.js:14574`（社交心跳，5s）；
  - `app/whale.js:18191`（Qzone 评论，5min）；
  - 内心生活自己维护 `nextAt` 并落盘：`services/persona/inner-life.js:3748`（`scheduleNext`）、
    `services/persona/inner-life.js:3775`（`tick`）。
- 进展判定只有：
  - `noActionCount` 计数：`app/whale.js:17394`；
  - controller 的 15 分钟停滞：`runtime/control/controller-cli.js:13`（`STALL_MS`）、
    `runtime/control/controller-cli.js:266`（判定点）。
- 已有恢复设施：DSH 5 秒探活 `app/whale.js:5864`；inbox 2 分钟重放 `runtime/kernel/inbox.js:87`；
  `session_map` 影子映射 `runtime/kernel/db.js:136`。

### 2.2 目标

1. 所有「到点什么」的行为统一进 SQLite 调度器，进程重启不丢、不会双触发；
2. 看护从「进程活着」升级为「这一轮是否有实质进展」，但**只告警，不自动重试登录/额度类失败**。

### 2.3 方案

#### 调度器

扩展现有 `JobQueue`，不另起一套：

```sql
ALTER TABLE jobs ADD COLUMN last_progress_at INTEGER;
ALTER TABLE jobs ADD COLUMN progress_kind TEXT;   -- tool_result | artifact | step | output
ALTER TABLE jobs ADD COLUMN stall_after_ms INTEGER;
```

新增任务类型（`kind` 用现有 `type` 字段表达）：

| type | 触发 | 幂等键 |
| --- | --- | --- |
| `inner.reflect` | 内心反思 | `inner:reflect:<nextAt>` |
| `inner.curiosity` | 好奇浏览 | `inner:curiosity:<day>:<slot>` |
| `share.module` | 分享模块 | `share:<moduleId>:<day>` |
| `reminder.due` | 定时提醒 | `reminder:<id>` |
| `social.tick` | 社交心跳 | `social:<minute>` |
| `qzone.comment` | 空间评论 | `qzone:comment:<postId>` |
| `proposal.notify` | 开发提案结果 | `proposal:<id>` |

接口：

```js
scheduler.enqueue({
  type, key, payload, dedupeKey, runAfter, maxAttempts, stallAfterMs
});
scheduler.tick();      // 5s；只执行到期且租约可拿的任务
scheduler.progress(id, { kind, at, detail });  // 执行中上报进展
```

**避免双触发**：

1. 新调度器先与旧定时器**影子并行** 7 天：调度器只写 `events` 表「would-fire」审计，不执行；
2. 对比两边触发时间与次数，差异为 0 后，按任务类型逐个切换；
3. 切换时旧定时器保留一个总开关 `scheduler.legacyTimers=false`，出问题可一键回退；
4. 同一 `dedupeKey` 在 `jobs` 表唯一，重复登记不会产生第二条；
5. 进程启动时先回收过期租约（已有 `locked_until` 逻辑，`runtime/kernel/jobs.js:122`）。

#### 任务级看护

新增 `runtime/control/progress-watch.js`（设计）：

```js
evaluateProgress(job, events) -> {
  state: 'advancing' | 'waiting-human' | 'stalled' | 'failed',
  evidence: { lastToolResultAt, lastArtifactAt, stepDelta, outputTokenDelta },
  suggestion: '...'
}
```

判据（满足任一即 `advancing`）：

- 出现新的工具结果哈希；
- 工作目录出现新产物（worktree 中 `git status` 变化或文件 mtime）；
- 步骤计数增加；
- 输出 token 增量超过阈值；
- 计划清单勾选项增加。

停滞判定：`state=running` 且 `now - last_progress_at > stall_after_ms`，且**不是**在等人类输入、
登录、额度恢复。此时：

- 只写事件、控制台红点、主人私聊各一次（30 分钟去重）；
- **不自动重试** login / quota / sdk-env（项目硬规则）；
- 提供自然语言查询：`controller-cli status --explain <jobId>` 输出「卡在哪一步、最后一条工具结果、
  建议动作」。

### 2.4 影响与测量

- token：调度本身不增加模型调用；看护只在停滞时发一条主人私聊（可忽略）。
- 延迟：tick 5 秒，最坏晚 5 秒触发；对提醒类可接受，对内心生活无影响。
- 可靠性：进程重启后任务不丢；重复触发由 dedupe 与租约挡住。
- 测量：影子期统计「旧定时器触发 / 调度器 would-fire」差异；上线后统计漏触发、重复触发、
  任务恢复成功率；看护统计告警准确率与误报率。

### 2.5 风险与回滚

| 风险 | 缓解 | 回滚 |
| --- | --- | --- |
| 新旧定时器双触发 | 影子期 + 类型级切换 + 唯一幂等键 | `scheduler.enabled=false` |
| 租约过期导致重复执行 | 执行前再校验状态；副作用操作带幂等键 | 回到旧定时器 |
| 看护误报打扰主人 | 只在 `running` 且无人类等待时告警；30 分钟去重 | 关闭 `progressWatch.enabled` |
| 任务长期 running 占住队列 | `stall_after_ms` + dead 状态 + 控制台可见 | 手动 dead / 重排 |

---

## 3. P3 话题级执行会话（只设计）

### 3.1 现状证据

- 一个 QQ 会话固定映射一个 DSH session：`convKey` `app/whale.js:1660`、`ensureSession`
  `app/whale.js:13137`、`state/sessions.json`（`app/whale.js:191`）、
  SQLite 影子映射 `runtime/kernel/db.js:136`。
- 没有话题拆分；只有内心生活是旁路会话（创建于 `services/persona/inner-life.js:598`）。
- 代码提案已有隔离副本与结果文件：`runtime/orchestration/dev-proposals.js:21`
  （`<id>.result.json`）、`runtime/orchestration/orchestrator-queue.js:95`。

### 3.2 目标

当群里出现**明确任务**（代码提案、调研、长任务）时，为该 thread/topic 建独立执行会话；
后续相关事件直投该会话；结果回主会话统一出口。

### 3.3 方案

```sql
CREATE TABLE topics (
  id TEXT PRIMARY KEY,
  conv_key TEXT NOT NULL,
  thread_key TEXT,           -- 引用消息 ID / 关键词聚类 / 主人指定
  title TEXT,
  status TEXT,               -- open | waiting | done | cancelled
  worker_session_id TEXT,
  created_at INTEGER,
  last_event_seq INTEGER
);
CREATE TABLE subscriptions (
  event_key TEXT NOT NULL,   -- group:<id>:<thread> 或 keyword:<hash>
  topic_id TEXT NOT NULL,
  mode TEXT,                 -- direct | observe
  PRIMARY KEY (event_key, topic_id)
);
```

- **触发**：显式任务词 + 主人确认，或现有代码提案流程；不靠模型自动切话题。
- **直投**：命中订阅的事件直接进 worker 的 inbox，不再经过主会话判断；主会话只收一条「已分派」。
- **结果协议**：

```json
{
  "topicId": "tp_...",
  "replyParts": ["..."],
  "artifacts": [{ "path": "...", "summary": "..." }],
  "confidence": 0.0,
  "dedupeKey": "tp_...:<resultHash>"
}
```

- **重复回复抑制**：`(topicId, resultHash)` 唯一；同一话题同一时间只允许一个 publisher；
  主会话与 worker 同时想说话时，主会话优先，worker 结果延迟合并。
- **多订阅者**：一个 topic 可订阅多个 event_key，但结果只回创建它的 `conv_key`。
- **超时/取消**：worker 超过租约未进展 → 标记 `stalled`，结果不自动发群。

### 3.4 前置条件与不做的理由

前置：P1 索引稳定（否则每个 worker 都重复付上下文成本）、P2 调度器可用、结果协议与去重先落地、
每话题预算上限、可观测面板。

暂不做：单机群数量有限，话题拆分会让每个 worker 各带一份人格与工具协议，读缓存成本上升；
去重与合并协议写错会直接表现为群里重复回复；当前主要矛盾是 token 成本与进展看护，不是话题串味。

---

## 4. P4 静默预演（可选，默认关闭）

### 4.1 现状证据

- 代码提案已在隔离 worktree 执行并写结果文件：
  `runtime/orchestration/dev-proposals.js:21`、`runtime/orchestration/dev-proposals.js:203`；
- 结果通知走桥接轮询（`app/whale.js:3272`），主人确认后才合并。

### 4.2 方案

当白名单群出现「桥接自身缺陷」报告时：

1. 复制仓库到新的 detached worktree（复用现有 `DEV_WORKTREE_DIR/<id>` 约定）；
2. 只跑窄范围复现脚本或相关测试，不启动桥接、不连 QQ、不发消息；
3. 产出 `repro.md`（现象、最小复现、疑似文件、是否可修）；
4. 只有「复现成功 + 修复面小 + 测试通过」才私聊主人；否则静默丢弃；
5. 默认关闭；白名单群；仅内部动作；不自动发群、不自动合并。

### 4.3 风险

- 执行不可信输入带来的资源与安全风险：限制 CPU/时长/磁盘，禁止读取 `config.json` 与 `state/`；
- 成本：每次预演都是一次模型回合，需要每日次数上限；
- 误报：只在复现脚本稳定通过时才通知；
- 隐私：worktree 中不得出现真实号码、令牌与聊天正文。

---

## 5. 现在不建议做

| 项 | 不建议的理由 |
| --- | --- |
| 云端化 / 跨设备 | 项目是本地优先：QQ 与 SnowLuma 都是 Windows 程序，状态与仓库同机；上云会把隐私边界和故障面一起放大 |
| 全量多 worker | 每个 worker 都要带人格、工具协议与缓存前缀，成本敏感场景下不划算；合并与去重协议尚未验证 |
| 把常驻层换成 LLM 路由 | 现有准入是确定性代码，快且免费；换成模型会给每条消息增加一次调用与一个故障点 |
| 异步工具全双工 | DSH 以回合为单位，QQ 有发送限频；start/stop 式工具会把状态机复杂度推高，现有 `qq_wait_for_messages` 已覆盖短等待 |

---

## 6. 四周分阶段表

| 周 | 工作 | 验收指标 |
| --- | --- | --- |
| 第 1 周 | P1：section 盘点、离线 harness、稳定 ID 设计；不改运行时 | 基线：唤醒 prompt 中位 token、每轮步数、缓存未命中率、p95 延迟；harness 可复现 ±5% |
| 第 2 周 | P1：索引表 + `qq_context_fetch`，只对 3 个低风险段生效；开关默认关闭 | 唤醒 prompt 中位 token −10%；每轮工具调用 +≤0.4；p95 +≤1.5s；缓存未命中率 +≤3pp；重复回复 0 |
| 第 3 周 | P2：调度器影子运行，迁移 2 类定时器 | 7 天内漏触发 0、重复触发 0；重启恢复 100%；tick p95 <100ms |
| 第 4 周 | P2：进展看护上线；P3 设计评审 | 停滞告警准确率 ≥80%；误报 ≤1 次/天；平均恢复时间 −30%；P3 go/no-go 结论 |

回滚总原则：每个阶段一个配置开关；出问题先关开关，不删数据、不改历史任务。
