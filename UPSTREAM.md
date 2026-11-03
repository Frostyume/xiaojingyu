# 上游基线与分叉说明（UPSTREAM）

> 本文件说明本仓库与上游 [Derpyu520/qq-bridge](https://github.com/Derpyu520/qq-bridge) 的关系、
> 许可证边界，以及跟进上游的规则。
> 最后核对：2026-10-30。本文件只写代码/版本事实，不含任何真实 QQ 号、群号、令牌或本机绝对路径。

## 1. 上游是谁

| 项 | 值 |
| --- | --- |
| 上游仓库 | `https://github.com/Derpyu520/qq-bridge` |
| 上游许可证 | MIT，版权行归 Derpyu520 及上游贡献者 |
| 本仓库许可证 | `LICENSE` 为纯 MIT 正文（保留上游版权行，未删除、未替换）；第三方组件与 SnowLuma 合规说明已移入 `NOTICE`，两者互不隶属 |
| 本仓库定位 | 上游的**二次开发定制分支**（小鲸鱼人格 + SnowLuma + DSH），不是独立重写 |

## 2. 版本关系

| 项 | 说明 |
| --- | --- |
| 当前版本 | `v1.0.0`（本仓库首个稳定版，2026-11-03 发布；不跟随上游标签） |
| 代码基线 | 上游 `v0.2.0-r4` 之上的定制分支；本地大量功能（实时状态页、内心生活、提醒、图片库、可靠性内核等）为后续新增 |
| DSH 适配 | 面向 DSH 0.2.0-rc.2 逐项实测（`npm run verify:adaptation`） |
| 未合入的上游工作 | 上游后续的 DSH 0.2.1 适配（`{{cwd}}` 变量移除、`working_directory` 守卫名单扩充、`src/media-normalize.js` 等）尚未系统合入本仓库 |

上游历史版本（`v0.1.0` / `v0.1.5` / `v0.1.7` / `v0.2.0-r4` 等）只存在于上游仓库，
用于适配更旧的 DSH；本仓库不发布这些标签。

## 3. 跟进上游的规则

1. 只按**提交**逐个评估，不整分支 merge：先看 `git show <sha> --stat`，再按 hunk 挑选。
2. 优先吸收「上游 bug fix / 协议适配 / 安全守卫」；上游新增的通用功能若与本地实现冲突，先保留本地并记录差异。
3. preset 相关：只把上游的**语义变更**（如删除 `{{cwd}}`、补守卫名单）手工合并进
   `integrations/dsh/presets/qq-chat/agent.cordis.yml` 源文件，然后运行：
   ```bash
   node tools/gen-preset-patches.mjs
   ```
   **绝不手改** `integrations/dsh/agent-presets/presets/*.patch.yml`。
4. 合入后必须跑：`npm run test:audit`、`npm run verify:adaptation` 与 preset 契约测试，
   并按 [RULES.md](RULES.md) 的说明重启 DSH（preset / 工具 schema 变更需要）。
5. 若上游改了 `LICENSE`，同步保留上游版权与新条款，不覆盖为自有许可。

## 4. 绝不进入公开仓库的内容

- `config.json` 及其 `.bak-*`、`state/` 全目录（令牌、会话映射、日志、账本、人格状态、备份）
- `audio/`（用户真实音频）、图片库目录
- 任何真实 QQ 号 / 群号 / 控制台 token / DSH Cookie / API Key
- `docs/audits/`、`docs/design/`、`docs/legacy/`、`docs/research/`、`docs/guides/PROJECT_GUIDE.md`、`docs/guides/VOICE.md`
  （`.gitignore` 已排除，原因：含本机路径与内部细节）
- `bin/boot.cmd` 中的本机 TTS / ffmpeg 绝对路径（发布前必须改为可配置或自动发现）

许可证与第三方合规的完整说明见 [NOTICE](NOTICE)。