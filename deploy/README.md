# R07 VPS 部署与验证

当前目标为 Ubuntu VPS 的 `/opt/knowledgeops-agent`。PostgreSQL/Redis 由
`compose.yaml` 管理，API、Worker、Web 的生产构建由宿主机 PM2 管理。
2026-10-25 收尾：用户已在 VPS 验证 HTTPS、登录绑定、计划生成、SSE snapshot、
刷新恢复、真实 Push 取证，以及容器重建后的业务数据保留和服务恢复。
PM2 启动配置加载、证书续期 dry-run 与 reload 钩子检查通过；AI 未直接访问 VPS。
尚未实测整机重启与 Redis 全部排队数据恢复，后续模型验收尚未接入。

| 组件 | 运行方式 | 本项目宿主机入口 |
| --- | --- | --- |
| Web | PM2 / Nuxt 生产构建 | 127.0.0.1:3200 |
| API | PM2 / NestJS | 127.0.0.1:4000 |
| Worker | PM2 / BullMQ 消费 | 不监听 HTTP |
| PostgreSQL | Docker / 命名卷 | 127.0.0.1:15432 → 容器 5432 |
| Redis | Docker / 命名卷 | 127.0.0.1:16379 → 容器 6379 |

Nginx 转发 Web/API，systemd 管理开机启动；以下保留实际配置与操作方法。
这是当前已验证的混合部署。应用镜像化留待 R17 评估，尚未纳入本轮实现。

## 前置条件

- 使用项目要求的 Node 24、pnpm；在同一 NVM 环境中运行 PM2。
- 根目录 `.env` 已填写生产域名、数据库连接、模型与 GitHub 配置，权限为 600；
  GitHub App 私钥已单独传输，路径与 `.env` 一致，权限为 600。
- 已执行 `pnpm infra:check` 和数据库迁移。
- 已执行 `pnpm exec dotenv -e .env -- pnpm build`。
- `127.0.0.1:4000` 与 `127.0.0.1:3200` 空闲。

## 启动与观察

```bash
cd /opt/knowledgeops-agent
pm2 start deploy/ecosystem.config.json
pm2 list
curl --noproxy '*' --max-time 10 -fsS http://127.0.0.1:4000/health/ready
curl --noproxy '*' --max-time 10 -sS -o /dev/null -w 'Web HTTP %{http_code}\n' http://127.0.0.1:3200/
pm2 logs knowledgeops-worker --lines 30 --nostream
```

预期三个 `knowledgeops-*` 进程持续 online；API 返回 `ready`，PostgreSQL/Redis
检查为 `up`；Web 返回 HTTP 200；Worker 出现 `worker_runtime_started`，且没有
持续出现队列或数据库错误。online 只代表进程存活，Worker 的实际消费仍需后续真实任务验证。

配置采用单实例 fork，无文件监听。Node 在启动时通过 `--env-file` 加载根目录
`.env`，配置文件本身不包含密钥。已有进程环境变量优先于 `.env`，不要从曾经
export 了另一套业务配置的终端启动；配置内固定生产模式与本项目的回环监听端口。

Worker 停止时最多等待 210 秒，以覆盖默认三分钟生成时限并留出收尾时间；
超时被强制结束后的任务仍依赖现有 BullMQ 重试和数据库幂等恢复，不保证永不重投。

修改 `.env` 后仅重启本项目；修改代码需先重新构建：

```bash
pm2 restart deploy/ecosystem.config.json
```

排查时按具体进程读取日志，如 `pm2 logs knowledgeops-api --lines 40 --nostream`。
不要分享 `.env`、私钥、会话 Cookie 或完整环境转储。

只操作本项目进程；开机启动采用下文明确指定 ecosystem 的 systemd 配置，
无需 `pm2 save`，不使用 `pm2 restart all`。

## 当前域名的 Nginx 切换

`nginx.game.gerden-shop.cn.conf` 是此 VPS 的站点配置，放在 Nginx 的 `http`
上下文（Ubuntu 的 `sites-enabled`）。它保留现有证书路径和 HTTP ACME webroot，
使用独立日志格式省略 OAuth 查询参数，且不更改其他站点使用的旧 upstream。
`/api/` 转发到 4000 并移除 `/api` 前缀，其余路径转发到 3200。
API 代理关闭响应缓冲和 gzip，允许现有 SSE 心跳及时传递；此配置检查不能替代真实浏览器 SSE 验收。

10/24 用户提供的本机结果：API readiness 为 ready、PostgreSQL/Redis 均 up，
Web HTTP 200，Worker 出现 `worker_runtime_started` 且该次展示的错误日志为空。
后续登录、模型生成和真实 Push 消费也已由用户确认，见下文。

实际站点文件为 `/etc/nginx/sites-available/game.gerden-shop.cn`，
`sites-enabled/game.gerden-shop.cn` 为其链接。用户已备份到
`/root/game-nginx.before-knowledgeops.c3odBU`；替换仅针对该站点。
先把候选文件经 SCP 上传到 `/root/knowledgeops-nginx.candidate.conf`，再在 VPS 执行：

```bash
if sudo test -f /root/game-nginx.before-knowledgeops.c3odBU; then
  if sudo cp /root/knowledgeops-nginx.candidate.conf /etc/nginx/sites-available/game.gerden-shop.cn \
    && sudo nginx -t \
    && sudo systemctl reload nginx; then
    echo 'Nginx 配置已检查并 reload；继续验证 HTTPS。'
  else
    sudo cp /root/game-nginx.before-knowledgeops.c3odBU /etc/nginx/sites-available/game.gerden-shop.cn \
      && sudo nginx -t \
      && sudo systemctl reload nginx
    echo '切换失败，已尝试恢复原配置；请检查上述输出。'
  fi
else
  echo '未找到原配置备份，未执行切换。'
fi
```

从 VPS 检查本机 Nginx 的 TLS、域名和转发，保留证书校验，不使用 `-k`：

```bash
curl --noproxy '*' --resolve game.gerden-shop.cn:443:127.0.0.1 --max-time 10 \
  -sS -o /dev/null -w 'HTTPS Web %{http_code}\n' https://game.gerden-shop.cn/
curl --noproxy '*' --resolve game.gerden-shop.cn:443:127.0.0.1 --max-time 10 \
  -fsS https://game.gerden-shop.cn/api/health/ready
```

预期分别为 200 与 ready；再从浏览器打开域名确认外网可达。GitHub App 的生产回调
和 Webhook 地址随后配置，不能把首页可达记为登录/Push 验收通过。
证书至 2026-11-24 有效的证据来自用户输出；续期演练和钩子检查结果见下文。

10/24 用户确认上述 HTTPS 检查通过，且浏览器可以访问项目页面；记录为用户实测，
不是 AI 远端执行；后续业务观察结果如下。

## GitHub App 生产地址

在已有 GitHub App 的设置中增加 Callback URL：
`https://game.gerden-shop.cn/api/auth/github/callback`，与 VPS 的
`GITHUB_APP_CALLBACK_URL` 一致。可保留原本地回调；本项目授权请求显式传入 redirect_uri。
Homepage URL 可改为 `https://game.gerden-shop.cn`。

启用 Webhook，URL 改为 `https://game.gerden-shop.cn/api/webhooks/github`，
Secret 与 VPS 的 `GITHUB_WEBHOOK_SECRET` 保持一致，启用 SSL verification。
沿用此前 Contents 只读权限、Push 订阅与指定学习仓库的安装授权，不增加权限。
替换 Webhook URL 后，该 App 的新通知投递到 VPS，原本地转发入口不再收到这些通知。

只改 GitHub 设置无需重启进程；如果同时修改 VPS `.env`，需重启受影响的本项目进程。
从生产页面完成登录、刷新保留会话、退出后工作台要求登录，再重新登录并绑定学习仓库。
VPS 是独立数据库，本地旧计划/绑定不会自动出现；GitHub 侧已有安装不等于产品数据库已有绑定。
若 Recent deliveries 出现 ping，接口预期返回 202；它会作为非 Push 事件被忽略，
不产生 Evidence，不能替代后续真实目标文件 Push 验收。

10/24 用户确认生产登录并绑定成功、计划生成成功且刷新恢复正常，随后补充
生成期间看到了 SSE snapshot。生产刷新会话/退出登录未单独报告，不补记为已验证。

10/24 真实 Push 初次未显示记录，用户在 GitHub delivery 中看到 HTTP 200。
核对后发现 Webhook URL 仍指向旧 Smee；用户更正后确认 VPS 取证成功。
因此生产 Push→Webhook→队列→读取固定提交→证据落库的 smoke 已有用户观察证据；
不能将其表述为后续模型验收通过，也未将 GitHub 实际响应码补记为用户未报告的 202。

## 重建容器后的恢复观察

在计划生成及取证均已结束、没有新 Push 时执行。本项目会短暂停机。
先记下当前计划和取证记录中的 Commit，然后在 VPS 运行：

```bash
cd /opt/knowledgeops-agent &&
pm2 stop deploy/ecosystem.config.json &&
docker compose --env-file .env -f deploy/compose.yaml up -d --force-recreate --pull never --wait --wait-timeout 60 &&
pm2 restart deploy/ecosystem.config.json
```

PM2 操作仅针对配置内三个进程；Compose 只重建本项目 PostgreSQL/Redis 容器，
沿用现有命名数据卷和本地镜像。`--wait` 等待健康检查通过；中途失败则后续步骤
不执行，先排查再恢复业务进程，不删除数据卷或重置数据库。

```bash
curl --noproxy '*' --max-time 10 -fsS http://127.0.0.1:4000/health/ready
pm2 logs knowledgeops-worker --lines 20 --nostream
```

确认 API ready、Worker 重新启动无持续错误，再刷新网页检查原计划、绑定、
相同 Commit 的取证记录仍在。该观察验证 PostgreSQL 业务数据跨容器重建保留及
Redis/Worker 重新连通；不据此宣称已验证 Redis 所有排队数据恢复、灾难恢复或备份。
它也不等于 VPS 整机开机恢复，PM2 启动项和证书自动续期仍需单独检查。

10/24 用户确认上述恢复观察已完成，并补充生成期间看到了 snapshot。
因此容器重建后的业务数据保留、API/Worker 恢复及经 Nginx 的 SSE 快照接收均记录为
用户实测通过；不要求重新生成计划补观察。启动和续期配置检查记录如下。

## 开机启动与续期核对

10/24 初次检查时，用户输出显示 Docker、Nginx、pm2-root、pm2-deploy 均 enabled；
pm2-root 当前 inactive，ExecStart 仍位于 `/root/.nvm/versions/node/v24.7.0/`，
与当前项目使用的 Node 24.19.0 不一致。三个 knowledgeops 进程 online 证明当前
运行正常，不代表 systemd 已接管或新进程列表已保存。pm2-deploy 用途未确认，
不停止、重启或重配该服务，不用全局 PM2 操作恢复旧应用。

snap.certbot.renew.timer 已 enabled，并有最近/下次触发记录；这只证明定时调度
存在，尚不证明 game.gerden-shop.cn 在新 Nginx 配置下能成功续期。
用户报告 R07 截至此时累计约 3.5 小时，包含环境排错，后续收尾耗时未报告，不推算。

随后用户确认当前 node/pm2 都位于 `/root/.nvm/versions/node/v24.19.0/bin/`；
pm2-deploy 为 deploy 用户、使用 `/home/deploy/.pm2` 且 active，与 root 实例独立。
证书续期 authenticator 为 webroot，目录 `/var/www/letsencrypt` 与站点配置一致。

### 修正 root 启动项

`pm2-root.knowledgeops.conf` 是现有 pm2-root.service 的 drop-in。它固定使用已确认的
Node/PM2 路径，先等待本项目 Compose 健康，再启动 ecosystem 文件内的三个进程。
ExecStart 明确替换原来的 resurrect，因此无需 `pm2 save`，不会从旧 dump 恢复
此前 stopped 的 Clash/Nuxt/OpenClaw。旧 dump、旧 PM2 定义和 deploy 用户服务均保留。
日后升级 Node 时应同步修改此文件内的版本路径。

把该文件上传至 `/root/pm2-root.knowledgeops.conf` 后执行：

```bash
if sudo test -e /etc/systemd/system/pm2-root.service.d/knowledgeops.conf; then
  echo '同名覆盖配置已存在，请先核对内容。'
else
  sudo install -D -m 644 /root/pm2-root.knowledgeops.conf /etc/systemd/system/pm2-root.service.d/knowledgeops.conf \
    && sudo systemctl daemon-reload \
    && sudo systemctl start pm2-root.service
fi
```

首次 start 可能使本项目进程短暂重启。ExecStop 仅请求停止 ecosystem 中的进程，
systemd 管理的主 PID 是 root PM2 daemon；因此不能把未来其他独立业务随意加入这套
root PM2。已确认 active 的 pm2-deploy 使用独立 daemon，不受本覆盖文件管理。
该服务已有 enabled 状态，无需再次生成启动项，不执行 pm2 kill/restart all。

```bash
systemctl show pm2-root.service --no-pager --full -p ActiveState -p SubState -p ExecStart
pm2 list
curl --noproxy '*' --max-time 10 -fsS http://127.0.0.1:4000/health/ready
```

预期服务 active/running，ExecStart 为 Node 24.19.0 + 本项目配置，三进程 online，
API ready。若启动失败，查看 `journalctl -u pm2-root.service -n 40 --no-pager`，
不通过操作 pm2-deploy 或重启整机排错。本地环境没有 systemd，配置的实际加载以
VPS 结果为准；服务启动成功也不冒充已经做过整机重启演练。

### 当前证书续期演练

```bash
sudo certbot renew --cert-name game.gerden-shop.cn --dry-run
```

该命令使用测试签发流程，不替换当前生产证书；预期输出 simulated renewals succeeded。
现有定时器已启用，演练用于验证新 Nginx 下的 ACME webroot 可达。
10/24 用户确认 PM2 服务状态与续期演练结果均正常，启动配置加载与 dry-run 已通过。
没有执行整机重启，也没有提前替换生产证书。

webroot 没有 installer，实际续期后需要 deploy hook 让 Nginx 加载新证书。
补充 `certbot-knowledgeops-reload.sh`：只匹配当前域名的 RENEWED_LINEAGE，先 nginx -t，
再 reload。它不更改其他证书和已有续期钩子；若已有钩子同样 reload，可能额外 reload
一次，后续维护可合并。它不放在每次运行必执行的 post 目录，避免无续期也 reload。

把文件上传至 `/root/certbot-knowledgeops-reload.sh` 后执行：

```bash
if sudo test -e /etc/letsencrypt/renewal-hooks/deploy/knowledgeops-reload-nginx; then
  echo '同名钩子已存在，请先核对内容。'
else
  sudo install -D -m 755 /root/certbot-knowledgeops-reload.sh /etc/letsencrypt/renewal-hooks/deploy/knowledgeops-reload-nginx \
    && sudo env RENEWED_LINEAGE=/etc/letsencrypt/live/game.gerden-shop.cn \
      /etc/letsencrypt/renewal-hooks/deploy/knowledgeops-reload-nginx
fi
```

这是手动检查新增钩子的 nginx 校验和 reload 行为，不再次签发证书；与已通过的
dry-run 分开记录。本机验证 shell 语法与无目标变量跳过行为；10/24 用户确认 VPS
钩子正常，安装及手动执行检查通过。10/25 部署复述经纠正后用户确认理解，
W2 独立提交 600f35b；本轮不增加部署工程或重跑已完成观察。
