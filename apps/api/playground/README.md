# API Playground

这里只放当前单元的临时基础练习，不属于产品源码、正式测试或手写答案。

- 每次只保留一个活动练习；除本说明外，内容已由根目录 `.gitignore` 忽略。
- 配置从根目录已有 `.env` 读取，不复制密钥到本目录，不保存 Token、用户资料或日志文件。
- 完成观察并记录证据后删除练习源码；产品实现、正式测试和手写回到各自指定位置。

当前没有活动练习。2026-09-17 用户确认 R13 最小观察完成：连续接收、服务端断开后的浏览器自动重连与主动 close；已解释相对 URL 和原生重连。R13 含本练习、产品观察、导读与提问累计实际投入约 35 分钟，不另重复计入入门时间。

4103 练习服务已停止，忽略的 `sse-basics.mjs` / `sse-basics.html` 已清理（未纳入 Git，无历史版本可还原；需要时可按此说明重建）。练习只发送合成计数，不含 Run、Query、版本归并、历史补发、轮询兜底或 C2 等价答案。产品实现与验收见[本地指南](../../../docs/local-development.md)，不再运行旧练习命令。

依据：[WHATWG SSE 协议与 EventSource](https://html.spec.whatwg.org/dev/server-sent-events.html)。

R04 的真实 GitHub 身份获取、无有效 state 时拒绝及入门复述已记录在[主计划](../../../docs/KnowledgeOps-Agent-逐日开发计划.md#r04-真实身份观察成功2026-09-09)。2026-09-09 转入产品用户/会话接入，临时 `github-login.mjs` 已清理，不再运行旧命令。

产品启动、登录与验证见[本地指南 5.4](../../../docs/local-development.md#54-r04github-产品登录与会话)。本目录不提供回调 Controller 小手写答案。
