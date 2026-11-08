# VPS 部署与验证

**当前配置（2026-11-08）：** Web/API/Worker 已由 Docker Compose 管理，网页为 `https://knowops.site`，API 为 `https://api.knowops.site`。域名、HTTPS、运行配置与本次 API 修复镜像记录见 [生产域名与切换记录](domains.md)，正式发布见 [CD03 发布流程](cd03-release.md)。旧域名已退役，下文 R07/R17 的 PM2 与旧域名命令仅供历史追溯，不能直接用于当前生产环境。

R17 发布、恢复与第二账号闭环证据见本文后半部分，最新状态见末尾“R17 单元收尾”。
以下 R07 记录保留为历史证据，不能据此认为新拉取的源码已完成构建、数据库迁移或生产切换。

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
这是当前已验证的混合部署。R17 继续复用这一结构：PM2 管应用，Docker 管有状态依赖，
减少本轮发布同时变化的组件。应用镜像化不纳入当前发布范围。

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

## R17：发布与恢复

本批将部署核对、备份/迁移验证、发布配置和健康检查合并推进；原 R17 总预算仍为
4 小时，可跨时段。第二真实账号的完整业务闭环与测量接在发布后，不以健康检查代替。
首读本节、`ecosystem.config.json` 和下表列出的四个迁移 SQL；后续推理参数迁移见修复记录。

### 架构与设计原因

- Nginx 统一承接 HTTPS，将网页交给 Web、业务请求交给 API；应用仅监听回环地址，
  让公网入口和证书配置集中管理。代价是发布时还要验证代理后的访问，进程 online 不够。
- API 受理请求并保存状态/Outbox，Worker 领取后台任务；耗时的取证与模型调用不占住
  HTTP 请求。分开进程后必须处理重复投递、重试和持久化状态，不能依赖进程内变量恢复。
- PostgreSQL 保存业务事实，Redis 承载队列。发布保留两个数据卷，仅切换应用；
  数据库备份与代码备份分别负责恢复数据和运行产物，数据库恢复还须核对 Redis 中的旧 Job。
- 当前采用单实例维护窗口发布，沿用 PM2 和现有路径，控制运维复杂度；代价是短暂不可用，
  这不是滚动发布或零停机方案。暂不引入应用镜像、额外调度系统或第二套监控。

业务链路仍为：浏览器/GitHub → Nginx → API → PostgreSQL/Outbox → Redis → Worker
→ 报告与任务状态落库 → API 查询 → 页面。原主链路图在逐日计划中维护。

### 发布前只读核对

```bash
docker exec -i knowledgeops-postgres-1 sh -c \
  'exec psql -X -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "$POSTGRES_DB"' \
  < deploy/r17-preflight.sql
curl --noproxy '*' --max-time 10 -fsS http://127.0.0.1:4000/health/ready
curl --noproxy '*' --max-time 10 -sS -o /dev/null -w 'Web HTTP %{http_code}\n' \
  http://127.0.0.1:3200/
```

SQL 只输出迁移元数据、状态计数和数据库大小。发布前再次确认没有运行中的模型调用，
并区分尚未开始的待处理任务与正在执行的任务；不能为通过检查删除积压记录。

从 R07 升级需依次应用：

| 迁移 | 作用 |
| --- | --- |
| `20261026140000_note_verification_execution` | 新增验收执行账本 |
| `20261027100000_note_verification_report` | 增加 Run 时限/配置列和报告表 |
| `20261027170000_follow_up_question` | 新增追问表 |
| `20261027210000_answer_submission` | 增加回答事件枚举、回答表和 Run 关联/约束 |

这四项为新增表、列、枚举与约束，仍需在副本验证实际旧数据。
生产使用项目锁定的 Prisma 7.9.1 与 `pnpm db:migrate:deploy`；它应用已提交迁移，
不负责生成构建产物，也不能替代备份或数据恢复。参见
[Prisma v7 migrate deploy](https://docs.prisma.io/docs/cli/v7/migrate/deploy)。

### 模型配置与积压任务

2026-11-04 用户确认沿用 GLM-5.3、low，每个新验收 Run 的估算成本上限为 CNY 1。
配置复用已有供应商凭据、Base URL 与 `jsonMode`，不在文档或日志中复制密钥。
2026-11-04 发布时已在生产 `.env` 补齐：

```dotenv
NOTE_VERIFICATION_MODEL_JSON={"catalogId":"glm-5-3","modelName":"glm-5.3","reasoningEffort":"low","currency":"CNY","inputMicrounitsPerMillionTokens":8000000,"outputMicrounitsPerMillionTokens":28000000}
NOTE_VERIFICATION_MAX_COST_MICROUNITS=1000000
```

这里沿用 10/27 用户提供的价格快照，用于本项目预算估算，不声称是供应商当前报价或账单。
笔记 Run 与回答 Run 各有自己的额度，1 元不是整项任务或全站总额。
首次只读检查有 1 个旧笔记 QUEUED Run 和 1 条待分发 Outbox；启用后 Worker 会按既有
资格检查处理它，可能产生费用。模型开关保持空值时不消费两类验收 Outbox，不能宣称
验收已上线；不要为避免旧任务执行而直接改业务表。

### 发布顺序与失败出口

1. 在隔离目录按锁文件安装和构建目标提交，Web 使用生产 API 地址。候选构建不覆盖
   线上 `dist`/`.output`；保留目标 SHA、构建结果及备份恢复演练结果。
2. 确认实际切换窗口后，停止本项目 Web/API 的入口，再优雅停止 Worker。等待进程退出，
   不操作其他 PM2 服务或 PostgreSQL/Redis。窗口内暂停 Push；窗口期间失败的 GitHub
   Delivery 要核对并手动 redeliver，不能假设 GitHub 会自动补投。
3. 在仓库外权限为 700 的持久目录保存本次恢复集，文件仅操作者可读：停写后的 PostgreSQL
   custom-format 备份、`.env`、当前实际构建产物、依赖与所需配置。回退必须能恢复原先
   正在运行的产物，不能把新拉取的源码 SHA 当作旧产物版本。GitHub 私钥继续保留原路径。
   核对归档可读取及校验和后才进行后续变更；在线演练的旧备份不能替代此停写备份。
4. 补齐已确认的模型配置，按锁文件安装依赖并构建，再执行 `pnpm db:migrate:deploy`。
   每步成功才继续；迁移失败时保持应用停止，查清已执行到哪一步和部分 DDL 状态，
   不靠 `migrate reset`、删除迁移记录或盲目标记 resolved 继续发布。
5. 先启动本项目 API/Web，确认本机及经 HTTPS 的 readiness/首页，再启动 Worker。
   观察进程稳定、Worker 启动事件和该次时间窗口内的错误；记录迁移全部完成、启动时间
   和版本证据。Worker 启动后可能立即处理旧任务，不再把这一步当作纯健康检查。
6. 若未开放入口/未恢复写入前失败，优先修复；必要时用恢复集恢复旧运行产物与配置。
   数据库已迁移时不能仅以旧程序能启动就判定兼容。新增枚举等变更不会随代码回退撤销，
   不提供未经验证的自动降级脚本。恢复后再次检查健康、已有数据和原任务状态。

恢复数据库时先恢复到新的隔离库并检查，再决定是否切换连接；禁止将演练直接指向生产库
或自动覆盖生产数据。若已恢复写入，先保存故障现场并明确备份之后的新数据如何处理，
优先向前修复；使用旧快照会回到备份时点，不能承诺零数据损失。还要核对 Redis 中待执行
Job 与恢复后的 Run/Outbox 是否匹配，依赖既有幂等机制的同时逐项确认，不自动清空 Redis。

备份采用 `pg_dump --format=custom --no-owner --no-acl`，隔离恢复使用
`pg_restore --exit-on-error --single-transaction --no-owner --no-acl`。`--list` 只检查
归档目录，必须实际恢复才能得到本次恢复证据。参见 PostgreSQL 17 的
[pg_dump](https://www.postgresql.org/docs/17/app-pgdump.html) 与
[pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html) 文档。

### 本批证据（2026-11-04）

- AI 只读检查宿主机：本项目 PostgreSQL 17、Redis 7.4 healthy，PM2 服务 active，三个应用
  online；本机 API ready、Web 200。只查询本项目状态，未重启其他应用。
- 生产已完成 12 个迁移，最后一项为 `20261018100000_webhook_receipt_binding`；后四项待执行。
  计划生成有 1 个 SUCCEEDED，笔记有 1 个 QUEUED；没有查到 RUNNING。笔记 Outbox 待处理 1 条。
- `.env` 权限为 600，现有必要凭据存在；验收模型配置缺失，已获上述模型方案确认，尚未写入配置。
- 候选源码为 `b152baa`（产品代码与 `5f17eb4` 一致），在
  `/tmp/knowledgeops-r17-candidate.Ux9XQQ` 按锁文件独立安装并完整构建成功；构建使用虚拟
  数据库地址和生产公开 API 地址，没有读取生产密钥或修改线上产物。另以真实环境校验器
  检查拟发布的 API/Worker 配置通过，仅在内存补入已确认的模型配置，未写 `.env` 或调用模型。
- 在线备份存于权限受限的 `/tmp/knowledgeops-r17-rehearsal.3WA1PJ/database.dump`，已在无网络、
  无公开端口的独立 PostgreSQL 17 临时容器中实际恢复。四个迁移 SQL 按顺序重放成功，
  新表、列、枚举可查询；用户、计划、任务、Run、Outbox 的记录数量前后一致。
  这是备份恢复与 SQL 演练，不是生产迁移，也未执行 Prisma 迁移账本更新或验证业务通过。
- 新增只读预检 SQL 在现有生产库执行通过；演练容器已删除，临时备份仍受权限保护。
  最后再次检查生产 API ready、Web 200，原服务持续运行。
- 上述为发布前准备证据，临时目录不是持久或异地备份；正式发布结果及停写恢复集见下文。

### 正式发布结果（2026-11-04）

用户明确“接下来执行发布”，授权本次维护窗口、生产迁移与应用切换；沿用此前确认的
GLM-5.3 low 和每 Run 1 元估算额度。产品版本为 `5f17eb4`，发布源码 HEAD 为
`b152baa`（后者仅增加协作规则/计划文档）。只操作 KnowledgeOps 的三个应用；用户已停止
的 `gerden-api`、`gerden-web` 与宿主机 PostgreSQL 16 在发布后仍为 inactive。

停写恢复集位于 `/var/backups/knowledgeops/r17-20261104-lvXvym/`，目录权限 700，包含：
`database.dump`、原 `production.env`、原 `runtime.tar.gz`、校验和、构建/迁移日志和脱敏
`release-result.json`。备份在应用全部停止后生成，生产数据库/Redis 容器始终保留。
该备份位于同一台服务器，不作为异地灾难恢复能力。

实际执行中的两项排错均在继续前解决：PM2 对停止命令的逗号组合筛选未生效，改用精确
进程名逐个停止，并断言三进程均 stopped；tar 仅报告根目录元数据变化，随后 gzip 完整性
检查及运行文件逐项比对均通过。正式目录离线安装缺少缓存，按原锁文件联网补齐后构建
成功，未改依赖版本；本次不把工程等待记为用户学习投入。

生产 `prisma migrate deploy` 成功应用四项迁移，最终账本为 16 项完成、0 项未完成。
先恢复 API/Web，验证本机与经 Nginx 的 HTTPS，再启动 Worker；三个进程持续 online，
观察窗口内重启计数未增长，结构化日志无新增 warn/error。生产 `.env` 仍为 600。

网页经正常域名 HTTPS 返回 200；无 Cookie 的 `/api/auth/session` 返回 401。
依赖健康接口按既有 Nginx 规则只允许本机访问：本机 HTTPS 返回 ready，PostgreSQL/Redis
均 up；公网请求返回 403 是预期限制，不修改访问控制来凑健康检查。

旧笔记的待分发 Outbox 已消费，Run `SUCCEEDED`、报告已保存，三个验收结果均为
`INSUFFICIENT_EVIDENCE`，Task 为 `NEEDS_EVIDENCE`，追问按规则 SKIPPED。执行成功说明
获得了合法报告，不等于笔记/任务通过。Worker 的 `verification_completed` 日志可按
runId 对应到数据库运行；这不代替第二账号从新请求开始的完整关联日志验收。

| 本次既有笔记样本 | 实测/账本结果 | 边界 |
| --- | --- | --- |
| Run 执行耗时 | 11.917 秒 | 从 started_at 到 finished_at，不含此前积压等待时间 |
| Token | 2,310，usageComplete=true | 单次既有笔记运行，不能推出平均值或 P95 |
| 估算费用 | CNY 0.0254，预算告警为空 | 按 10/27 价格快照计算，不是供应商账单 |

此次发布工程验证、集中导读与本批短复述通过，用户已确认不能直接启动不识别新事件的旧 Worker；
用户确认已观察旧任务报告，本批学习用时约 15 分钟，并已自行修正 GitHub App 注册中的测试回调地址。
服务器配置已为生产回调 `https://game.gerden-shop.cn/api/auth/github/callback`；本次 AI 线上登录跳转探测未完成，
修正结果以用户反馈记录。第二真实账号的安装/绑定至任务通过与解锁、后续测量仍未完成，
R17 不标 DONE，也不推送远端。

### R17 第二批：第二真实账号闭环与测量

2026-11-04 用户授权进入本批。范围为现有生产功能的真实接入与完整闭环，不增加产品功能、
新手写或第二套监控；复用 R16 已通过的隔离回归。本批仍计入 R17 原 4 小时预算，
实际学习耗时结束后由用户报告。第二账号、安装和运行证据未取得前保持待验收。

本批主要概念是登录身份与仓库授权的边界：Session 确认操作者，GitHub installation
限定 App 可读取的仓库，产品 Repository 绑定决定接收哪个仓库/分支的任务提交。
`GitHubRepositories.verify` 先核验用户可访问的安装和仓库，再验证 App 读取能力；
`RepositoryBindingService.bind` 在事务内保存绑定并检查占用。这样可复用同一个 App
服务多个用户，同时避免仅凭前端传入的仓库 ID 或 App 自身权限授予访问权。
后续 API 保存待办、Worker 执行、数据库保存结果的职责沿用上一批。

首读入口：`apps/web/app/pages/app/repository.vue`、
`apps/api/src/repositories/github-repositories.ts`、
`apps/api/src/repositories/repository-binding.service.ts`。执行观察时按页面操作即可，
本批结束再集中导读和短复述，不按每个操作设学习关卡。

连贯观察步骤：

1. App 所有者确认注册为 Public，允许第二账号安装；沿用生产 Callback/Webhook、
   Contents 只读权限和 Push 订阅。已有 App 可在设置的 Advanced 中 Make public，
   参见 [GitHub 设置说明](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)。
2. 第二账号准备自己的学习仓库，初始化 README 以形成默认分支。在独立浏览器配置或
   无痕窗口登录生产站点，确认身份、刷新会话，并确认没有显示第一账号的私有计划。
3. 从“仓库接入”加载授权仓库，点击“安装 App / 管理仓库授权”，仅选择本次仓库。
   回到页面刷新，绑定实际默认分支，刷新后确认绑定仍在。安装成功不等于产品已绑定。
4. 创建小范围学习目标、生成并确认计划，开始首个可执行任务。以页面给出的实际文件路径
   和验收标准准备 Markdown，再向绑定分支提交；先开始任务再提交，以便形成正确取证上下文。
5. 观察本次提交的笔记报告与引用；若证据不足，按真实标准完善后再次提交，不修改数据库
   强制通过。笔记通过后回答真实追问，观察回答报告、Task PASSED 及依赖任务解锁。
   若计划没有后继依赖，不将“无后继任务”记成解锁验收通过。
6. 退出后再次访问私有页面，确认要求登录。按本次仓库、commit SHA 和 Run ID 核对
   Delivery → Submission → 笔记 Run/报告 → 追问 → 回答 Run/报告 → Task 的关联。

运行后保存脱敏的观察日期、环境、各步骤结果、失败及修复、关联标识、运行起止时间、
Token 与估算费用。区分用户页面观察和服务端查询证据；仅有一次运行时只报告单样本，
不推算平均值、P95 或模型准确率。笔记和回答各沿用每 Run CNY 1 的估算预算，
不是整条业务链总预算。无第二账号或缺少任一结果时保留待验收，不用模拟账号代替。

2026-11-04 第二账号接入进展：用户确认前述登录、刷新会话、私有计划隔离和安装/绑定
步骤已观察，仓库为 `NaNFuSpring/learning-staff`，分支为 `main`。生产只读查询确认
用户及安装账号均为 `NaNFuSpring`，绑定处于 enabled 状态，绑定 ID 为
`f136b11f-ed77-43ce-ad07-1959692b3ad4`，bound_at 为 `2026-11-04T03:13:24.463Z`。
查询时该用户尚无计划、任务及计划生成 Run；真实提交、报告、回答、通过/解锁与退出保护
仍待验收，不将绑定成功记为完整闭环通过。

第二账号首次计划生成 Run `af47435a-a734-4163-8a94-d7f97b244575` 达到默认 180 秒
截止时间后 TIMED_OUT，错误码 RUN_DEADLINE_EXCEEDED；从入队到领取约 0.491 秒，
未保存 Plan，Worker 开始/终止日志与数据库一致。计划生成未显式配置 reasoning_effort，
与笔记/回答验收的 low 配置独立；现有日志不足以定位上游具体耗时原因。
后续通过页面创建关联重试，保留失败 Run，不修改旧终态或手工补写 Plan；恢复结果待验证。

关联重试 Run `7aa2814d-3d81-40ad-8ca8-58eea130575d` 随后也达到 180 秒截止时间，
03:43:34.757 UTC 入队、03:43:35.439 开始、03:46:34.759 结束，仍无 Plan。
用户离开页面后通过 `/app/plan?goal=ecad5dc8-6688-4fa4-8ffd-bbf09b630d63&run=7aa2814d-3d81-40ad-8ca8-58eea130575d`
可读取原运行状态，需登录所属账号；未触发新的模型调用。重复超时原因待定位。

### 11/4 计划生成推理参数修复

排查发现计划生成未接入推理强度配置，默认使用供应商行为；两次 low 诊断分别在
11.525 秒和 12.990 秒返回，第一次格式校验失败，第二次结构/DAG 校验通过（3 项任务）。
两次均设置 8192 输出 Token 上限和 180 秒截止，未写入 Plan；合计 3414 Token，
按现有价格快照估算 CNY 0.057152。它们不是正式闭环结果，也不能证明原超时的唯一原因。

配置现支持 `PLAN_GENERATION_MODELS_JSON` 中的可选 `reasoningEffort`，值为 low/high/max。
API 新建 Run 时将其冻结到 `model_reasoning_effort`，Worker 从数据库读取后传给 SDK。
这样部署者调整目录不会改变已排队运行的参数；旧 Run 的 null 仍表示不发送参数。
新迁移只新增可空字段和取值约束，不回填旧记录；3 分钟 deadline 保持原值。

验证：29 项相关单元、34 项隔离数据库集成/原子落库验收通过，类型检查、目标 lint、
格式及 API/Worker 构建通过。发布备份在 `/var/backups/knowledgeops/r17-reasoning-cREmSW`，
包含数据库、旧环境配置和本次涉及的运行产物；依赖版本未变，未重建 Web。
迁移 `20261104040000_plan_generation_reasoning_effort` 已完成，API/Worker 已切换，
运行时目录 glm-primary 为 glm-5.3 / low；原两次 Run 保持 TIMED_OUT，参数列为 null。
API readiness 为 ready，PostgreSQL/Redis 均 up。正式生成结果等待页面关联重试验证。

后续用户确认正式生成成功；数据库 Run `b3979893-0c13-4f94-976e-b591dcd2fe12`
为 SUCCEEDED / low，04:06:29.551 至 04:06:43.745 UTC，执行耗时 14.194 秒。
Plan `895a8c88-1332-4af0-aa89-7024f4fc8ba0` 为 DRAFT，保存了 3 项有依赖的任务。
该 Run 的 retryOfRunId 为 null，属于独立新运行；原两次失败仍保留。
尚待确认计划、开始任务、真实 Push 与验收闭环；此处只记录单次正式生成耗时，不推算费用或 P95。

### 第二账号真实提交与通过/解锁证据

2026-11-04 用户报告补充回答验收通过，数据库及 Worker 关联日志核对如下：

- Commit：`bed7d6acd262b7cc4a63d79b7adf24950ac0ded0`，目标 `notes/promise-basics.md`，固定证据 70 行，sourceCommitSha 一致。
- Delivery：`0bf4ea7a-d806-11f1-81e5-1e3e5d29d99e`，PROCESSED；Submission：`40db1318-0f44-4227-bdb6-b3878664a3fa`。
- 笔记 Run：`668ca9db-f299-492e-b60a-b78a755e248f`，报告 `5e457c27-01b2-4902-b797-619e4ba4ab07` 中 4 项结果 PASSED，追问 READY。
- 两次回答均关联追问 `90e30b4d-3b77-4028-b5ca-11f4cee66dbf` 和上述笔记报告；首次 Run `a69567ab-9513-4309-b379-8f2f3aaf9014` 报告为 INSUFFICIENT_EVIDENCE，补充后 Run `ad546eaf-9293-4cc0-9b95-d19cf2cbd981` 报告为 PASSED。
- 首项 Task PASSED，第二项 READY，第三项仍 BLOCKED；后两项不要求在本次 smoke 全部完成。取证日志的 deliveryId/submissionId/runId 与验收日志的 runId/reportId 可对应到同一链路。

| 本条链路的运行 | 执行耗时 | Token | 估算费用 CNY |
| --- | --- | --- | --- |
| 笔记（本次模型调用为生成追问） | 12.910 秒 | 2392 | 0.027996 |
| 首次回答（含一次引用修复） | 30.873 秒 | 8454 | 0.095792 |
| 补充后的回答 | 15.225 秒 | 4269 | 0.047692 |
| 三 Run 合计 | 不作为端到端等待时间 | 15115 | 0.171480 |

三份账本 usageComplete=true、warnings=[]。首次回答调用记录含 INVALID_ANSWER_CITATION
及一次受控 REPAIR，修复调用已计入费用；不隐去失败尝试。上述费用不含计划生成和独立诊断，
按既有价格快照估算，不是供应商账单；单条人工辅助样本不能推出 P95、准确率或学习效果。
题干与内部 rubric 不一致已核对并登记，补充答案通过不代表该问题关闭。
刷新及退出保护的用户观察、第二批导读/复述与实际耗时仍待补齐，R17 尚未 DONE。

用户随后确认刷新后首项通过、第二项可开始，退出后访问原私有链接要求重新登录，观察符合预期。
本批进入集中导读；理解确认、短复述、学习耗时和单元提交尚未完成，评分一致性问题仍 OPEN。

第二批集中导读后用户确认理解，并复述任务必须汇总全部标准通过后才可通过，短复述已通过。
学习记录仅待第二批实际耗时；单元状态为 DOCUMENTING，待提交前复核与本地提交，评分一致性问题仍 OPEN。

### R17 单元收尾

2026-11-04 用户完成两批观察、导读理解和短复述，实际学习投入分别约 15 分钟与 10 分钟，
累计约 25 分钟；工程执行及等待不计入该学习时长。生产发布、第二账号真实闭环、刷新/退出保护、
关联日志与单样本测量证据齐全，随本次本地提交成功将 R17 置为 DONE；M6 其余单元未完成。
评分一致性问题继续 OPEN，既有失败记录保留；不声称模型效果已稳定、具有异地容灾或零停机发布能力。
本轮不推送，后续 R18/R19 复用本记录准备演示和材料。
