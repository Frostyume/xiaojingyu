// Safe audit suite: fixtures and mocks only, never production QQ/DSH.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('..', import.meta.url));
const tests = [
  'audit-bridge.test.mjs', 'audit-protocol.test.mjs', 'audit-protocol-helpers.test.mjs',
  'audit-security.test.mjs', 'audit-security-mcp.test.mjs',
  'audit-setup.test.mjs', 'audit-setup-guards.test.mjs',
  // DSH 会话队列（inbox 投影）解析：0.2.0 把队列从 control baseline 的
  // `value.queues[<id>]` 挪进了 `value.projections[<id>].values.inbox`。
  // 认错形状的后果不是"少清几条"，而是**每一次退役会话都抛错**、旧任务继续跑，
  // 且只留下一行日志 —— 必须有登记期断言钉住（活 DSH 侧的实测见
  // tests/dsh-session-retire.test.mjs）。
  'dsh-inbox-projection.test.mjs',
  'md-to-plain.test.mjs', 'slang-learn.test.mjs', 'mux-reconnect.test.mjs',
  // Stage 1 可靠性底座：SQLite 迁移/outbox 幂等与重放/jobs/inbox/配置 schema/结构化日志，
  // 以及 doctor 的端口解析与 DSH 识别（纯离线，不碰生产 state）。
  'core-storage.test.mjs', 'doctor.test.mjs',
  // Stage 2：prompt 预算、价值评分、模型路由、分层记忆、会话映射影子副本；
  // 桥接层集成（评分接入唤醒、上下文旋转/摘要、预算、tier 路由、FTS 记忆注入）。
  'stage2.test.mjs', 'stage2-bridge.test.mjs',
  // Stage 3：关系模型、富媒体卡片（JSON/XML/音乐）、结构化人格包、群日报、TTS 情绪映射。
  'stage3.test.mjs', 'relationship-v2.test.mjs', 'signature.test.mjs',
  // Stage 4：事件总线、feature loader、传输适配器（SnowLuma/OneBot）、预算账本。
  'stage4.test.mjs', 'web-search-chatanywhere.test.mjs',
  'token-economy.test.mjs', 'qq-model-view.test.mjs', 'qq-preset-contract.test.mjs',
  'reply-wait.test.mjs', 'preset-prompt.test.mjs', 'role-card.test.mjs',
  // 体检修复回归：无令牌智能体调用面、send-burst 失败回滚、唤醒限频重试、
  // 定时器类暂存唤醒补发、collector 生命周期、ownerQQ 覆盖语义、预设名校验、
  // wake triggers 白名单、memory-update 边界、wait 租约归一化、md/黑话/表情/账本；
  // 本轮新增：/api/send/* 失败路径的作用域错误（R15）、simulation 落库丢表情识别字段（R16）。
  'audit-regressions.test.mjs',
  // 控制面分层（群内低风险直连 / 私聊全能 / 高危二次确认）：授权判定纯函数 +
  // 假网关 + 回环控制台的端到端验收，含关闭开关后的旧行为回归。
  'control-tiers.test.mjs',
  // 图片/表情链路（动图/表情包字段、CDN 优先与 emoji_id 兜底）+ 联网搜索
  // （DSH 同一路 DeepSeek 搜索、Bing RSS 兜底、凭据优先级与端点安全；
  //  本轮新增：空结果 note 必须在写缓存之前生成，否则缓存命中丢掉提示）。
  'media-search.test.mjs',
  // GitHub issue 回归：#22 模式 user 层优先 / #11/#19 回合判忙租约 / #29 机器人身份注入。
  'issue-regressions.test.mjs',
  // 仿真「会话初始提示词」：只在首次唤醒注入、管理面隔离、损坏文件只读降级、
  // 以及控制台「立即唤醒」不得顶掉首次 bootstrap（否则初始提示词永远发不出去）。
  'simulation-initial-prompt.test.mjs',
  // 令牌账本 / 价目表 与 体检修复回归（纯函数，无外部依赖）
  'token-usage.test.mjs', 'hardening.test.mjs',
  // 语音发送（纯函数 + 端点存在性；真发语音只在 --live 或 CLI 里做）
  'voice.test.mjs',
  // 音量：参数校验 + 真的调用 ffmpeg 调音量 + 自算 RMS 验证增益
  'voice-volume.test.mjs',
  // 边界：并发/异常输入/上传限额/越权（纯函数段 + 可选的 live 段）
  'voice-edge.test.mjs',
  // 语音图形界面（参数解析/鉴权/路径穿越/文件名净化；live 段需普通终端）
  'voice-gui.test.mjs',
  // 控制台静态契约（跑不了 Playwright 的环境下的替代回归）
  'console-static.test.mjs',
  // 语音系统整体结构检查（入口/依赖/端点/开关/文档一致性）
  'voice-system.test.mjs',
  // SnowLuma 账号/token 自发现（换 QQ 账号后 token 会变，写死的工具会 401）
  'snowluma-conn.test.mjs',
  // 启动器与编码（乱码根因：.cmd 里的非 ASCII 会被 cmd 按 ANSI 解码）
  'encoding.test.mjs',
  // 控制台乱码机制（UTF-8 字节被按 GBK 解码）+ chcp 修复
  'console-encoding.test.mjs',
  // 🔴 铁律 L7（仿真会话不得拥有本地执行能力）：注册期断言——
  //    preset 挂了守卫、守卫的 restrict 名单覆盖全部已知本地工具、且执行期一律拒绝。
  //    这是唯一挡住"绕过桥接直连 OneBot HTTP"的东西（见 docs/guides/SECURITY_BASELINE.md），
  //    所以必须在每次回归里跑，而不是一次性验收。
  'preset-local-tools.test.mjs',
  // mode-console 的 settings 契约：0.2.0 删除了 ctx.settings.register()，
  // 命名空间改为由 loader entry id + 导出的 Config 推导。断言三点前提都在，
  // 并且那条已删除的 API 不会被照旧注释加回来。
  'qq-mode-plugin.test.mjs',
  // SnowLuma 上游健康（被误诊成「qq-bridge 注入失败」的那个失败形态）：
  //   · good 必须取自心跳 status.good / get_status —— 取自 get_login_info 会**静默失效**
  //     （SDK 不校验 data 载荷，good 会永远停在 null，整条权威信号变成死分支）；
  //   · 静默检测不得冒充 hook 检测（心跳是 SnowLuma 本地定时器无条件发的）；
  //   · 客户端库版本不得低于 bot_status 出现的版本。
  'snowluma-upstream-health.test.mjs',
  // 桥接不变量：内部符号导出面、会话状态按 key 隔离、白名单硬边界、
  // 未知会话退役不抛错。重构（P4 起）不能悄悄改掉这些前提。
  'bridge-invariants.test.mjs',
  // 控制台闸门：Host → 令牌 → 智能体调用隔离 → CSRF 的判定表，外加真起一个
  // 回环服务验证接线（401/403/415 与安全头）。名单外提到 console/policy.js 后，
  // 这里锁的是「权限边界不许漂移」。
  'console-gate.test.mjs',
];
let failed = 0;
for (const test of tests) {
  console.log(`\nRunning ${test}`);
  const result = spawnSync(process.execPath, [path.join(root, 'tests', test)], {
    cwd: root, stdio: 'inherit', timeout: 60000,
    env: { ...process.env, QQ_BRIDGE_TEST_LIVE: '0' },
  });
  if (result.status !== 0 || result.error) {
    failed++;
    console.error(`FAILED ${test}: ${result.error?.message || `exit ${result.status}`}`);
  }
}
console.log(`\nAudit suite: ${tests.length - failed}/${tests.length} scripts passed.`);
process.exitCode = failed ? 1 : 0;
