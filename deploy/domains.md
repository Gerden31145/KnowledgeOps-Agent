# 生产域名与切换记录（2026-11-08）

当前网页为 `https://knowops.site`，API 为 `https://api.knowops.site`，API 路径不带 `/api` 前缀。
`game.gerden-shop.cn` 的 HTTP/HTTPS 入口返回 410，保留证书验证路径，不再代理应用。

## 流量、配置与设计原因

```text
浏览器 → knowops.site → 宿主机 Nginx → Web 容器（127.0.0.1:3200）
浏览器 / GitHub → api.knowops.site → Nginx → API 容器（127.0.0.1:4000）
API → PostgreSQL / Redis → Worker
```

Nginx 负责 TLS、主机名路由、维护开关及 SSE 转发；应用容器负责业务和鉴权，业务数据仍由 PostgreSQL/Redis 命名卷保存。Web 和 API 使用不同主机名，API 路径无需在代理层剥离前缀；代价是必须同时配置 CORS、网页 CSP 和登录回调。

Web 的 `connect-src` 允许 API 域名，API 的 CORS 精确允许 `https://knowops.site` 并允许携带凭据。前端 fetch 保留 `credentials: include`，SSE 保留 `withCredentials: true`。两者是同一站点的 HTTPS 子域名，API Cookie 保持 host-only、Secure、HttpOnly、SameSite=Lax，不扩大 Cookie 的 Domain。

API 原先强制 Web/回调同主机名，本次允许 HTTPS 的 `api.<Web 主机名>`；仍拒绝无关域名、其他子域名和协议变化。这样支持实际部署，同时保留启动时发现地址误配的校验。localhost 的原有开发方式保持有效。

宿主机 `.env` 中的三个公开地址为：

```dotenv
WEB_ORIGIN=https://knowops.site
NUXT_PUBLIC_API_BASE_URL=https://api.knowops.site
GITHUB_APP_CALLBACK_URL=https://api.knowops.site/auth/github/callback
```

GitHub App 设置由用户确认保存：Callback 同上；Webhook 为 `https://api.knowops.site/webhooks/github`；Homepage 为 `https://knowops.site`；如配置 Setup URL，则为 `https://knowops.site/app/repository`。

## 宿主机配置

- `nginx.knowops.site.conf` → `/etc/nginx/sites-available/knowops.site`，并由同名 sites-enabled 链接启用。
- `nginx.game.gerden-shop.cn.conf` → 旧域名同名站点文件，只保留退役响应。
- `certbot-knowledgeops-reload.sh` → `/etc/letsencrypt/renewal-hooks/deploy/knowledgeops-reload-nginx`，权限 0755。
- 新证书为 `/etc/letsencrypt/live/knowops.site/`，同时覆盖 Web/API，签发时有效期至 2027-02-06。
- ACME webroot 为 `/var/www/letsencrypt`。两个新主机名的 HTTP 普通请求 308 到 HTTPS。
- 两个 HTTPS 业务入口均识别 `/var/lib/knowledgeops-maintenance`；API `/health`、`/health/` 仅本机可读，供维护期间探测。SSE 禁用代理缓冲，超时 75 秒；访问日志不记录 query。

安装这组站点文件时应一并替换新旧配置，再 `nginx -t` 和 reload，防止重复定义日志格式。reload 返回时新 worker 可能尚未接管连接，探测须有限重试，不能据瞬间旧证书判断最终失败。

```bash
curl --noproxy '*' --resolve api.knowops.site:443:127.0.0.1 \
  --max-time 10 -fsS https://api.knowops.site/health/ready
curl --noproxy '*' --max-time 10 -fsS -o /dev/null https://knowops.site/app/plan
sudo certbot renew --cert-name knowops.site --dry-run --run-deploy-hooks
```

## 本次应用变更与后续发布

切换基于线上版本 `6fbde6080851b45fd198209289cfa16af4864117`，原发布号 `deploy-42455087546-1`。Web/Worker 沿用原 GHCR digest，重新加载公开地址。API 因启动校验限制需要更新：在原 API digest 上替换通过本地构建和测试的 `dist/config/environment.js` 及 source map，生成本地镜像 `knowledgeops-api:domain-20261108`，镜像 ID 为 `sha256:0fdd50b15ad65bc7a82bf1d8c17c90cd6c8b42b735c8bdda3da265412e36adc8`。该修复镜像不是 GitHub Actions 已验证的 GHCR 发布，不伪造原发布记录。

受限记录目录：`/var/lib/knowledgeops-delivery/domain-changes/2026-11-08T13-49-42-929Z`，包含旧配置备份、独立 runtime.env、构建材料、日志及结果。`current.json.domainConfiguration` 记录此目录和 API 镜像覆盖，原镜像记录保留。目录含敏感配置，不提交 Git。切换持有原 `release.lock`；开始时无 QUEUED/RUNNING 学习任务；PostgreSQL/Redis 容器 ID 未变，无数据库迁移、备份恢复或付费模型调用。

首次切换因 Nginx 重载交接恢复原配置；后续 API 原校验导致启动失败，保持维护并修正。最终 API 健康后移除维护文件。网页 `/` 按现有 UI 返回 302 到 `/app/plan`，实际页面返回 200，不能将合法首页跳转误判为故障。

后续需将本次源码与发布脚本提交推送，经 CI 生成正式镜像，再使用最新 main 的手动发布流程。发布脚本已改为检查两个新域名的维护响应、API HTTPS 健康及三个配置值；运行配置预检会在停服务前拒绝不支持新域名的旧 API 镜像。历史 rollback 的 source.env 仍包含旧域名，会被新规则拒绝；不能直接把旧配置恢复到现有入口，需另行核对域名、GitHub 设置、镜像及业务状态的兼容性。此域名变更不构成恢复数据库的理由。

## 验证证据

- API 配置、鉴权及发布脚本相关 48 项测试通过；API 构建、相关 ESLint 通过。
- 使用真实 DNS/HTTPS 验证：Web 页面与 Nuxt API runtime/CSP 正确；session 未登录 401 且允许精确 Origin/凭据；CORS preflight 204。
- GitHub 登录入口 302，redirect_uri 为新回调地址；state Cookie 的 host-only / Secure / HttpOnly / SameSite=Lax 正确；无效 callback 返回新 Web 的登录错误页。
- 公网 health 403，本机 HTTPS ready 200；无签名 Webhook 401；旧域名 HTTP/HTTPS 均 410。
- 用户随后确认“登录成功，原有数据正常”，完成新域名真实 GitHub 登录及原有计划/任务观察。未新增真实 Push 或带会话 SSE 验收；原站点 Cookie 不迁移，新域名需重新登录。
- 证书续期演练 **未通过**：`certbot renew --cert-name knowops.site --dry-run --run-deploy-hooks` 的 HTTP-01 验证记录先解析到正确 VPS `175.178.45.54`，随后跳转到 `https://dnspod.qcloud.com/static/webblock.html?d=<域名>`，在该拦截页失败。`43.174.224.202` 是重定向目标的地址，不能误记为本域名 DNS 配错；本机、公共解析器及权威 A 记录均指向 VPS。需由用户核对腾讯云备案/接入或拦截原因，处理后重跑演练。现有证书有效至 2027-02-06，但自动续期不能视为已验收。演练前约 366 秒等待是 Certbot 随机延迟，后续手动验证可添加 `--no-random-sleep-on-renew`。

本次为用户授权的域名运维补充，UI01/UI02 学习确认及 R18/R19 状态不变。

用户已确认新域名备案/接入“尚未完成”。后续由用户在腾讯云控制台处理该账户事项，完成后重新验证 HTTP-01 与续期钩子；当前登录成功不代表其他网络路径或后续续期一定可用。
