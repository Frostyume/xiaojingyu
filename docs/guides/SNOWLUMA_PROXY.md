# SnowLuma 与代理环境变量

## 症状

群里让她收藏表情时失败，桥接日志里是：

```
[sticker] AI 收藏表情失败 group:…: add_custom_face 失败: fetch failed
```

SnowLuma 日志同一时间能看到 `add_custom_face params=file="base64://R0lGOD…"`（GIF 字节和 base64 都正常），紧接着 `add_custom_face failed: fetch failed`。同时发普通图片是成功的。

## 原因

SnowLuma 2.4 的 `add_custom_face` 先用原始包拿 token，再用 Node 的 `fetch` 上传到：

```
http://<host>:<port>/cgi-bin/httpconn?htcmd=0x6FF0087&uin=…
```

如果系统在 User 或 Machine 级设置了 `HTTP_PROXY` / `HTTPS_PROXY` / `ALL_PROXY`（常见值形如 `http://127.0.0.1:7890`），这层代理会接管发往本机或非标准端口的请求；代理不可用，或 `NODE_USE_ENV_PROXY` 被打开时，这次 fetch 就会以 `fetch failed` 收场。QQ 域名的 DNS 抖动（`ENOTFOUND`、`ECONNRESET`）也会放大同样的问题。

这与表情本身无关：不是“图不对”，也不是视觉校验失败。

## 办法

用仓库自带的无代理启动脚本拉起 SnowLuma：

```bash
node tools/start-snowluma-clean.mjs
```

它只从以下来源解析启动脚本，不内置任何本机路径：

1. 环境变量 `SNOWLUMA_LAUNCHER`；
2. `config.json` 的 `snowluma.launcherPath`；
3. `config.json` 的 `snowluma.homeDir` 下的 `launcher.bat`。

脚本会删除 `HTTP_PROXY / HTTPS_PROXY / ALL_PROXY` 及其小写形式，设置 `NO_PROXY=*`，在独立进程中启动 SnowLuma，不影响其它程序的代理设置。

也可以只对 SnowLuma 手工设置（占位用你自己的安装目录替换）：

```bat
set HTTP_PROXY=
set HTTPS_PROXY=
set ALL_PROXY=
set NO_PROXY=*
%SNOWLUMA_HOME%\launcher.bat
```

## 桥接侧

- 上传遇到瞬时错误会自动重试 3 次（默认间隔 1.5s / 5s，可用 `simulation.sticker.collect.retryDelaysMs` 覆盖）；业务错误（例如表情库满）不重试。
- 三次仍是瞬时失败时，先写入 `state/pending-stickers.json` 的补收队列（最多 5 条），向会话回一句“网络不稳，已先记下，稍后自动补收藏”，不硬失败；后台任务每 5 分钟重试，最多 6 次，成功后会同步本地库并回一句。
- 重试后没拿到回执、但本地库里已经有同一张图（按 md5 匹配）时，按成功处理。

## 仍然失败时怎么排查

1. SnowLuma 日志搜 `add_custom_face`：是否有 `ENOTFOUND` / `ECONNRESET`；
2. 用 `curl -x http://127.0.0.1:7890 http://127.0.0.1:3000/get_status` 确认代理是否会接管本机请求；
3. 确认 SnowLuma 确实是在清空代理变量之后启动的（任务管理器看不到进程环境，建议直接用上面的脚本重启）。
