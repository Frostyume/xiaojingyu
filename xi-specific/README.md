# 汐的独立工程副本

这里保存汐在上游框架基础上的运行、记忆兼容、工具和恢复源码。只增加 `xi-specific/`，不改上游根目录的应用，也不会自动更新本机正在运行的汐。

这是**经过脱敏和独立无账号启动核验的工程副本**，不是内含汐本人资料的一键安装包。真实人格卡、关系、经历、聊天、账号、凭证、数据库和运行证明都留在私有数据与加密备份中。换框架或更新代码不应通过删除这些数据完成。

## 包含什么

- 独立运行生命周期、单个 QQ 接入者约束、正常排空和退出。
- 保留原始经历与发送回执的兼容层、统一记忆读取、生活状态工具。
- QQ 上下文、图片、表情、网页探索、公开 B 站视频取帧与空间回读逻辑。
- 工作间、受限本机执行后端、独立恢复与加密快照工具。
- 汐与统筹中枢的持久信箱；“已投递”不等于中枢已被唤醒。

## 安装依赖与核验

已使用 Windows、Node 24.14.0、Python 3.13 验证。安装依赖在当前目录执行：

```powershell
./install-dependencies.ps1
node tools/verify-source.mjs
node tools/no-account-check.mjs
```

安装严格使用 `migration/xi-a2/package-lock.json`，禁用依赖安装脚本，之后显式执行同目录的 SnowLuma ESM 扩展名补丁。根目录的 `node_modules` 是指向本副本依赖目录的安装期联接，不上传、不指向旧运行目录。需要图片预处理或加密备份时，可在独立 Python 环境安装 `requirements.txt`。

无账号核验只启动临时本机控制台与空数据库，读取一次状态后退出；它禁止外部网络、真实 QQ、模型和子进程，不代表新机器上的真实平台能力已经验收。

## 接入自己的私有安装

真实启动仍使用 `migration/xi-a3/deployment/launch-owned.mjs --manifest <私有绝对路径>`。不要将既有私有 manifest 原样公开或直接套用到另一台机器。manifest 必须提供独立数据目录、真实身份、凭证引用、单实例接管方案、经核验的恢复与版本资料。人格通过 `persona/build-profile.mjs` 的私有卡片、身份和关系输入构建；这里没有替别人填写人格或账号。

外部 DSH 0.2.1-rc.2 与 QQ 桥接应用由使用者单独安装、登录；不附带其二进制或登录态。`start-owned.ps1` 需要明确的运行目录和 Node 路径，仅检查已启动的桥接入口，不代为启动另一个 QQ 实例。

重要配置：

| 项目 | 私有设置入口 |
| --- | --- |
| DSH 安装与旧目录排除 | `manifest.dsh.installation.root`、`forbiddenRoots`，以及 `dsh.personaPrefix` |
| QQ 自身身份 | manifest 中的 `identities.botId`；工具不能指定或更换自己的身份 |
| 七牛凭证 | 私有 provider 引用的 `key_path`、`python_path`；直接使用 Python 客户端时可设置 `CONATUS_API_KEY` 或 `XI_CONATUS_KEY_FILE` |
| Python / Node | `XI_PYTHON`、`XI_NODE_EXE`；部分调用也支持受信构造参数 |
| 本机工作间执行 | `XI_APPCONTAINER_RUNNER`、`XI_APPCONTAINER_PROOF` |
| 视频 / 音频 | `XI_VIDEO_DECODER_CONFIG`、`XI_AUDIO_DECODER_CONFIG` |
| 可选 DSH 工作间规划 | `XI_DSH_SCOPE_DIR`、`XI_DSH_PROXY_TOKEN_FILE`、`XI_DSH_PLANNER_PROOF` |
| 贴吧专用范围 | `XI_TIEBA_CLAW_FORUM_IDS` 或受信 `forums` 配置；专用令牌需另行提供 |

`companion/video-decoder.json` 是空模板，不能直接当作配置。原生后端与规划器证明必须由目标机器上的实际验证生成；仓库中的源码散列核验不会将它们标成已通过。规划器采用 `xi-portable-dsh-planner-v1`，旧私有布局的证明不兼容。

当前 owned 工作间使用原生后端；可选 DSH 规划器保留源码，但尚未接入该控制器，填写配置不会自动启用。汐这一名称是公开的工程标识，不包含本人关系资料或角色卡。

## 验证边界与恢复

本次验证覆盖：依赖完整安装、配置生成一致性、目标模块回归，以及全新空目录主程序启动 → 本机状态返回 200 → 数据库、端口和锁退出。没有用发布副本执行真实 QQ、付费模型、平台发帖或原生解码器测试。

只读源码同步与在线部署分开。生产切换前保留上一版源码、完整私有加密快照及独立恢复证明，停止旧写入者后才激活新实例。真实数据不进入 Git；备份恢复也不自动激活账号。本工程的迁移工具保留既有数据库契约，不能冒充通用的空账号首次部署向导。

上游许可证与作者署名在 `migration/xi-a3/upstream/LICENSE` 和 `NOTICE` 原样保留并补充修改说明。外部服务、模型、QQ 桥接及编解码器不因本源码的许可而获得重新分发授权。
