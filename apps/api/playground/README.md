# API Playground

这里只放当前单元的临时基础练习，不属于产品源码、正式测试或手写答案。

- 每次只保留一个活动练习；除本说明外，内容已由根目录 `.gitignore` 忽略。
- 需要配置时从根目录已有 `.env` 读取，不复制密钥到本目录，不保存 Token、用户资料或日志文件；已结束的 R05 练习不读取 `.env`。
- 完成观察并记录证据后删除练习源码；产品实现、正式测试和手写回到各自指定位置。

## 当前没有活动练习

R05 的收发入门、产品导读、HMAC 手写 Review 与短复述均已完成，见[本地指南](../../../docs/local-development.md)。最后的格式正则由 AI 经用户授权补充；正式实现与验收不放在本目录。后续 R06 尚未启动，不创建新的练习。

## 已结束的练习

### R05 本地 Webhook 收发（2026-10-09）

用户已提供两次接收日志：同一合成 deliveryId、218 字节，receivedCount 为 1/2；随后确认“验签负责来源验证，不负责重复请求”。入门观察与理解确认完成，约 10 至 15 分钟是预算而非已报告实际耗时，不冒充产品 Webhook 验收。

`webhook-receiver.mjs` / `webhook-sender.mjs` 已清理，未纳入 Git，没有历史版本可还原；需要时可按下面的边界重建。用户自己启动的 4105 接收进程未被 AI 操作，停止情况未知，请在原终端 Ctrl+C；删除源码不会自动停止已加载的 Node 进程。

重建边界：只用 Node 内置 HTTP 与 fetch，接收端监听 `127.0.0.1:4105/webhook`、最多 8 KiB，打印事件类型、Delivery ID、ref 和进程内计数；发送端两次 POST 同一合成通知（Delivery ID `11111111-1111-4111-8111-111111111111`，`push` / `refs/heads/main`）。不读 `.env`，不访问 GitHub、数据库或 Redis；不存凭据/真实数据，不暴露公网。

这个练习故意不验签、不去重、不落库。202 只表示收到了通知，内存计数重启归零；不代表幂等或任务验收通过。HMAC 实现及其等价答案不放在这里。

依据：[GitHub Webhooks 概述](https://docs.github.com/en/webhooks/about-webhooks)、[Delivery ID 与重投](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks#use-the-x-github-delivery-header)。

### R13 SSE 与 R04 登录

2026-09-17 用户确认 R13 最小观察完成：连续接收、服务端断开后的浏览器自动重连与主动 close；已解释相对 URL 和原生重连。R13 含本练习、产品观察、导读与提问累计实际投入约 35 分钟，不另重复计入入门时间。

4103 练习服务已停止，忽略的 `sse-basics.mjs` / `sse-basics.html` 已清理（未纳入 Git，无历史版本可还原；需要时可按此说明重建）。练习只发送合成计数，不含 Run、Query、版本归并、历史补发、轮询兜底或 C2 等价答案。产品实现与验收见[本地指南](../../../docs/local-development.md)，不再运行旧练习命令。

依据：[WHATWG SSE 协议与 EventSource](https://html.spec.whatwg.org/dev/server-sent-events.html)。

R04 的真实 GitHub 身份获取、无有效 state 时拒绝及入门复述已记录在[主计划](../../../docs/KnowledgeOps-Agent-逐日开发计划.md#r04-真实身份观察成功2026-09-09)。2026-09-09 转入产品用户/会话接入，临时 `github-login.mjs` 已清理，不再运行旧命令。

产品启动、登录与验证见[本地指南 5.4](../../../docs/local-development.md#54-r04github-产品登录与会话)。本目录不提供回调 Controller 小手写答案。
