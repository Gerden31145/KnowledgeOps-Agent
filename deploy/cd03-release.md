# CD03：手动生产发布与恢复

当前状态（2026-11-06）：DONE（随本次本地收尾提交生效；提交失败恢复 DOCUMENTING）。首次正式发布、A→B→A 兼容回退及业务观察完成，完整 CI/CD 导读理解确认和短复述通过。预算 1.5 至 2.5 小时，用户实报约 30 分钟，无手写。B/回退的完整日志未单独提供，不补造运行标识。下一步讨论主页重构范围，尚未授权具体 UI 实现。

接入进展：工程检查点 b85d0f4 已由用户推送。用户使用 id_ed25519_vps，在禁用 SSH agent 和交互提示的条件下成功登录 root@175.178.45.54，并确认三个 Actions Secrets 配置完成；AI 未读取私钥或 Secrets 内容。Nginx 候选差异仅含两个维护条件和注释；远端 check 已通过 Nginx 检查并推进到镜像检查，未记录独立的 reload/域名健康输出，不补造验收。

## 本段目标与分工

一个主要概念：发布是一组有先后关系、需要记录结果的操作。手动选择已经验证的镜像版本，通过 GitHub Actions 调用 VPS 发布入口，依次准备、停写、备份、迁移、启动和检查，成功后记录当前版本。

- Actions 负责核对 CI 运行最终成功、源码 SHA、运行编号/尝试次数和完整四镜像摘要，串行触发发布。生产工作流使用独立并发组，不取消正在执行的发布；服务器还需要发布锁，避免手工操作与工作流并发。
- VPS 负责按摘要拉取、执行迁移和运行容器，不重新构建源码。发布脚本及 Compose 也要固定版本，不能用正在变化的 main 配置搭配旧镜像。
- Compose 管理 Web/API/Worker。Nginx 保留域名、HTTPS、SSE 和 3200/4000 的本机转发；Worker 仅消费队列。
- PostgreSQL/Redis 沿用现有生产容器和数据卷；应用连接改为 Compose 网络内的 postgres:5432、redis:6379。生产环境变量在 VPS 注入，GitHub 私钥只读挂载，须验证镜像内非 root 用户的读取权限。

首轮核心入口为 `.github/workflows/release.yml` 与 `scripts/production-release.mjs`；`release-record.mjs` 校验 GitHub 成功状态和产物，`package-release.mjs` 打包所选版本的配置，按职责补充。compose.apps.yaml 复用 CD01 的理解，不要求逐行阅读发布脚本的工程细节。

## 首次接入与日常发布的区别

首次接入必须处理 PM2/systemd：仓库中 pm2-root.knowledgeops.conf 的 ExecStart 显式启动本项目 ecosystem，不能只执行 pm2 save 就认为旧应用不会复活。根据服务器实际配置，仅调整本项目的启动责任，并保留已核对的旧应用恢复入口；其他项目的 PM2 服务不纳入切换。

后续发布在容器版本之间切换，记录当前/上一版镜像与配置。数据库迁移不可当作镜像的附属开关，回退之前须检查数据库结构、已写入状态及队列事件兼容性。

## 发布顺序与失败出口（实施约束）

1. 核对成功 CI 交付记录、配置及可用空间，先拉齐四镜像；失败时不进入停写。
2. 取得服务器发布锁，进入维护窗口，停止本项目写入入口，再优雅停止消费者；确认进程退出和停止期间无其他写入者。
3. 按 R17 约定保存并检查停写后的数据库备份、原应用/配置和版本记录，保留原存储卷。
4. 执行所选版本的一次性迁移。失败时保持维护状态，记录失败步骤，核对迁移状态；不继续启动新版。
5. 启动指定摘要的应用容器，检查 API readiness、Web、Worker 实际运行和域名入口。仅容器 running 不足以证明 Worker 业务消费正常。
6. 检查通过后恢复入口、保存成功版本记录，观察实际业务链路。
7. 如需回退，先确认旧代码与当前数据库/队列兼容，再切换已记录的旧应用版本；不自动用旧备份覆盖新业务数据。首次由 PM2 迁移的恢复路径与后续镜像回退分别记录。

第一版采用单实例维护窗口，允许短暂不可用。验收包括一次手动发布、失败停止证据和兼容版本回退演练；没有运行的步骤不记作完成。

## 当前由用户执行的只读核对

在 VPS 的 Bash 中执行：

```bash
cd /opt/knowledgeops-agent
git rev-parse HEAD
git status --short
docker compose version
docker ps --filter label=com.docker.compose.project=knowledgeops --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}\t{{.Ports}}'
docker inspect --format '{{.Name}} {{range .Mounts}}{{.Type}}:{{.Name}} -> {{.Destination}} {{end}}' knowledgeops-postgres-1 knowledgeops-redis-1
pm2 list
systemctl show pm2-root.service --no-pager --full -p ActiveState -p FragmentPath -p DropInPaths -p ExecStart -p ExecStop
sudo nginx -t
df -h / /var/lib/docker
```

以上只读取源码版本、工作树、服务、卷名称、启动配置和磁盘容量，不启动/停止服务或执行迁移。若容器实际名字不同，提供 docker ps 的结果后再调整 inspect 参数。

另需 CD02 那次成功运行生成的完整 release.json（包含 commit、workflow、四镜像摘要），不要提供项目根目录 .env、令牌或私钥内容。该记录与 Actions 成功状态一起用于准备版本选择校验；仅用户提供的 JSON 不替代后续工作流对 GitHub 的成功状态核对。

## 已收到的基线与版本

用户提供的线上 HEAD 为 `bf0a38c7dd5dc436e42cbb69b779a68076a00173`，工作树无改动输出；Compose 5.6.1。PostgreSQL/Redis healthy，分别映射 15432/16379，卷名为 knowledgeops_postgres-data、knowledgeops_redis-data。三个 KnowledgeOps PM2 应用 online，列表中的其他 root PM2 应用 stopped；pm2-root active，仍加载 knowledgeops.conf，并通过 Node 24.19.0 启停旧 ecosystem。Nginx 检查成功，根分区剩余约 41G。此记录来自用户输出，不宣称 AI 登录检查过 VPS。

候选应用提交：`2e47697fbc1dac0754e7320f0467ec370bcdd806`，CI run `41968799065`、attempt `1`，用户提供记录中的三项检查均 success。重建前后 Run `5d3b9005-bff7-4c21-ae03-80e11d06f6cf`、Plan `c1a48622-0479-473e-91f9-6b4a3ebdc150` 一致，均为 SUCCEEDED、3 项任务。仓库对比确认线上到候选版本的应用源码和迁移没有变化，API/Worker package.json 增加 files 打包范围；仍须运行首次容器配置与业务观察。

| 镜像（前缀 ghcr.io/gerden31145/knowledgeops-agent/） | registry digest |
| --- | --- |
| api | sha256:1e7139ae05eda5ef779f63f3420f014ff65a114bf868be6e0f680340b0f866e6 |
| worker | sha256:8eb0ccf960198cff6d5cfc7f83218ac8d9968f2113e029e46373baa4b1bbee7f |
| web | sha256:964e41d2836cb3371ed2c1018fe87c2f37e6c220ba32a6d9a0bb0ef6581cf8c3 |
| migrate | sha256:b63043e77fc6f17e7a853293a58a5b78a59b57c09ed44c6248ec1519b5311016 |

实际发布会重新从 GitHub API 核对当前成功 attempt、三个 job、artifact 名称及 ZIP 摘要，读取完整四镜像记录；不把上表或用户提供的 JSON 当作唯一授权依据。若该 run 已被重跑，必须选择新的成功 attempt；过期 artifact 须重新完成 CI，不能绕过记录检查。

## 首次接入：由用户操作

在本地推送工程检查点后，在仓库 Settings → Secrets and variables → Actions → New repository secret 配置：

| Secret | 内容 |
| --- | --- |
| VPS_HOST | 直接连接 VPS 的 IPv4 或 DNS 主机名，不带协议和端口 |
| VPS_SSH_KEY | 已授权登录该 VPS root 的 CI 专用 SSH 私钥全文，须支持无交互登录；不发到聊天 |
| VPS_KNOWN_HOSTS | 与 VPS_HOST 完全相同的主机名/IP，加服务器 SSH 公钥类型和公钥内容 |

当前流程匹配已确认的 root 托管与 `/root/.nvm/versions/node/v24.19.0`；若现有专用密钥只授权了其他用户，先调整方案，不用无法登录 root 的密钥直接试生产。GHCR 拉取仍使用 VPS 上 CD02 已配置的只读凭据，不把 GitHub App 私钥或生产 .env 放进 Actions。

在已经可信登录的 VPS 终端获取服务器公钥（不是登录私钥）：

```bash
awk '{print $1, $2}' /etc/ssh/ssh_host_ed25519_key.pub
```

将输出前面加上 VPS_HOST 和一个空格，形成 `主机名或IP ssh-ed25519 AAAA...`，存为 VPS_KNOWN_HOSTS。这里验证服务器身份，防止连接到错误主机；VPS_SSH_KEY 验证 Actions 的登录身份，两者职责不同。

2026-11-08 起使用新域名，站点安装及镜像兼容性以 [生产域名与切换记录](domains.md) 为准。`nginx.knowops.site.conf` 的 Web/API 两个业务入口已保留维护开关；`nginx.game.gerden-shop.cn.conf` 仅负责旧域名退役。以下首次 CD03 配置与候选版本号是历史操作记录，不再照搬到当前环境。

首次 CD03 维护开关需要在 Nginx 的两个业务 location 中增加条件判断。当时先把 `deploy/nginx.game.gerden-shop.cn.conf` 上传到 `/root/knowledgeops-nginx.cd03.conf`，再在 VPS 比较：

```bash
diff -u /etc/nginx/sites-available/game.gerden-shop.cn /root/knowledgeops-nginx.cd03.conf
```

预期差异仅为 `/api/` 和 `/` 中的维护文件判断及注释；若线上还有其他改动，保留那些设置后再安装。安装时先创建原配置备份，`nginx -t` 成功才 reload；失败则恢复原配置。不改域名、证书、健康接口限制或 SSE 设置。维护文件不存在时行为不变。用户已提供符合预期的 diff，远端预检已确认配置中存在维护条件；不重复安装。

完成 SSH 与维护开关配置后，打开 Actions → Manual production release → Run workflow，分支选 main：

- commit：`2e47697fbc1dac0754e7320f0467ec370bcdd806`
- ci_run_id：`41968799065`
- ci_attempt：`1`
- operation：先用默认 `check`。
- compatibility_reviewed：首次 check/deploy 保持未选。

`check` 只准备该次独立目录、缺失时拉取镜像，并用 API/Worker 一次性容器执行环境解析和私钥读取；不启动业务入口/消费者、不迁移、不停线上应用、不调用付费模型。通过后才由用户在约定维护窗口手动选择 deploy。窗口期间暂停 Push；收到失败响应的 GitHub Delivery 后续核对并手动 redeliver，不假设自动补投。

## 版本、配置与失败记录

发布包含两个明确版本：应用源码/镜像由所选成功 CI 固定；执行发布的工具版本为本次 release workflow 的 Git SHA，两者都记录。VPS 不 git pull 线上目录，不重建镜像；旧 PM2 源码/构建保留用于首次迁移恢复。

VPS 的 `/var/lib/knowledgeops-delivery` 保存 bundle、每次 attempts、成功 history 和 current.json；部署锁位于该目录。每次先从原 `/opt/knowledgeops-agent/.env` 读取配置，保留受限副本，再生成 raw env 文件，避免 JSON 或 `$` 被再次插值。仅替换容器内部数据库/Redis 地址和私钥挂载路径；主配置仍由用户维护原 .env。私钥复制到该次受限目录，以容器 node 用户可读的权限只读挂载。

check、deploy、rollback 均记录 operation 和每一步的状态；Actions 只取回脱敏 result.json，详细异常/命令日志保存在该次 VPS private.log，不自动上传凭据或数据库备份。第一次发布停写后另保存 legacy-runtime.tar.gz；数据库备份位于 `/var/backups/knowledgeops/deploy-…/database.dump`，校验归档目录和校验和。这不是本轮实际恢复演练，也不是异地备份。

一旦进入维护阶段后发生失败，会保留 `/var/lib/knowledgeops-maintenance`，并尽力停止已启动的本项目应用/消费者；必须检查停止结果，不能仅凭 FAILED 宣称所有进程已停。SSH 中断、手动取消或主机重启时，先核对 VPS attempt、维护文件和迁移/应用容器，不能假定远端已停止。正在运行的旧迁移容器会阻止新预检；有维护标记时普通 check/deploy 拒绝盲目重试。

`rollback` 仅接受曾成功发布到本 VPS 的完整镜像记录，并要求显式确认数据库、业务状态和队列兼容，迁移文件摘要必须一致。回退跳过 migrate，复用目标成功版本保存的配置与私钥副本；旧应用停止时间取当前/目标版本所需等待的较大值。不同迁移版本保持失败，交由单独恢复方案处理。current.json 中的成功和健康检查不能代替用户业务观察。

首次 PM2 → 容器迁移失败、尚无成功容器历史时，不使用镜像 rollback：先确认迁移状态与旧代码兼容，停掉本项目新容器，核对保留的旧运行目录和 .env，再恢复 pm2-root 的启用/启动；健康检查通过后才解除维护。若迁移已改变数据库、源码或配置被更改，不直接恢复旧 PM2。具体恢复命令根据实际失败步骤给出，不提供一键覆盖数据库的路径。

## 当前验证边界

首次远端 check：`deploy-42023905114-1`，controlCommit `b85d0f42676ada028c7b00aabf89aae3f64dd2ee`，应用/CI 选择仍为上表版本。预检在 `actual.Id === image.imageId` 失败；这是脚本把 CI 本地标识误作跨主机标识，不能据此断言拉错镜像。Docker containerd 后端可将 manifest/index 摘要作为 Id，与 classic 后端的 config 摘要不同。修复要求 inspect 的 RepoDigests 包含发布记录中完整的 repository@digest，并核对 linux/amd64；摘要固定 manifest 及其引用的配置/镜像层。CD02 同一 Docker 环境中的 image ID 检查保留。依据：[Moby containerd inspect 实现](https://github.com/moby/moby/blob/master/daemon/containerd/image_inspect.go)。

修复后本地相关测试共 25 项通过（新增 7 项覆盖两类本地 ID、错误摘要/仓库、缺失摘要和错误平台），相关 ESLint、Node 语法、Prettier 检查通过。operation=check 未进入维护、停止服务或迁移阶段。推送修复后在 main 新建 Run workflow，保持原应用 commit、CI run/attempt、operation=check；不要 Re-run 旧部署运行，否则仍使用旧 controlCommit。无需重建应用镜像。远端修复结果仍待观察。

第二次远端 check：`deploy-42026315405-1`，工具提交 `479e57dcdbf0a1221705a315d558162b5824d073`，已越过四镜像检查，API 一次性容器读取 `/run/secrets/knowledgeops/github-app.pem` 返回 EACCES。工作流远端命令继承 umask 077，mkdir 的 0750 被屏蔽为 0700；原脚本仅 chown 目录，未显式恢复组的进入权限。已在 chown 后增加 chmod 0750，文件保持 root:1000/0640、只读挂载，上级 attempt 目录保持 0700，不扩大为全局可读或改用 root 容器。

WSL Linux 临时合成文件验证已复现 0700 下 UID/GID 1000 读取失败，chmod 0750 后读取成功、写入被拒绝，其他 UID/GID 读取也被拒绝；未读取真实私钥或操作 Docker/VPS。此验证属于 Linux 权限行为验证，不等同于生产容器读取已成功。现有 25 项回归及相关 ESLint、Node 语法、Prettier 再次通过。下一步仍由用户推送后新建 main 的 check，沿用原应用 CI 选择；不手工修改旧 attempt，也无需重建镜像。

初版本地版本/环境/顺序与失败停止测试覆盖 12 项，连同受影响的 CD02 6 项共 18 项通过；ESLint、Node 语法、Prettier、actionlint 1.7.12、六个工作流 Shell 步骤的 Bash 语法及 Compose 静态合并检查通过。Compose 配置检查使用合成变量，不连接 Docker daemon、VPS 或生产库；首次对 `$` 的断言误把序列化输出当成运行时原值，核对输出后按其转义形式修正检查，配置未因此改写。输出中的 `$` 会为可再次解析而序列化成 `$$`，不能把该输出直接当容器进程的原始环境。实际 raw env 解析和非 root 私钥读取仍由 check 模式验证。

用户随后确认修复后的工作流成功，并核对 operation 为 check。据此记录远端预检通过，覆盖镜像身份、API/Worker 配置解析和私钥读取等预检步骤；未提供该次完整 result.json，不补造 deploymentId/controlCommit。check 不进入维护、备份、迁移、启动和激活阶段，不能记为生产已切换。下一步在 main 新建 Run workflow，保持应用 2e47697fbc1dac0754e7320f0467ec370bcdd806、CI 41968799065/1，operation 改为 deploy，compatibility_reviewed 保持未选。用户安排短暂维护窗口并暂停业务提交/Push，发布成功后再检查应用和业务结果；失败时保留日志与维护状态，根据失败步骤恢复。

首次正式发布证据：用户提供 result 日志，deploymentId=`deploy-42030257913-1`，operation=`deploy`，commit=`2e47697fbc1dac0754e7320f0467ec370bcdd806`，CI=`41968799065/1`，controlCommit=`15a49a5a886d022b91947363a246535eafd84c7b`，status=`SUCCEEDED`，stage=`complete`，timestamp=`2026-11-05T12:51:00.888Z`。根据脚本完成路径，预检、维护及停止旧应用、备份、迁移、应用启动与健康检查、激活均完成；已禁用本项目旧 pm2-root 启动责任，沿用生产存储容器/卷并解除维护。该日志不等于浏览器或真实模型业务已验收，也不证明备份可实际恢复、回退已演练。用户下一步查看容器与服务状态、登录及旧数据、一次测试任务 Push 到报告的链路，不要求重跑已经通过的 check。

用户回复“观察完毕，没问题”，据前序观察清单记录容器及旧 PM2/systemd 状态、登录刷新、旧计划/任务/报告读取、测试任务 Push 到报告均通过；没有单独输出、业务标识或测量值，不虚构它们。首次生产切换与用户业务观察已完成，不重复要求同一轮操作。

兼容回退准备：A 为已验证的 2e47697 / CI 41968799065/1；候选 B 为 15a49a5a886d022b91947363a246535eafd84c7b，待用户提供对应 CI 成功运行链接及 attempt，不复用 Manual production release 的运行号。git diff 确认 A→B 仅改变发布工具/生产 override/Nginx 模板/测试/文档，业务源码、依赖锁文件和 Prisma 迁移没有变化，可作为低变更量的兼容发布演练。待 B 的成功 CI 记录核对后先 deploy B，再以 A 的原 CI 记录运行 rollback 并显式确认兼容；不得把当前 A 原地再次启动称为跨版本回退。发布工具仍来自选定的 main，回退对象为应用镜像与历史配置，数据库不恢复为旧备份。每次运行期间暂停业务提交/Push，记录一份现有报告 URL/任务状态，回退后确认仍可读取。具体两次运行尚未执行，不提前记为通过。

用户已提供候选 B 对应 CI 成功运行链接：https://github.com/Gerden31145/KnowledgeOps-Agent/actions/runs/42027607903 。私有运行页面未能直接读取，记录为用户提供的运行号，不伪称已查看 jobs/artifact；attempt 尚无单独记录。由用户在 Run workflow 中选择 B 完整提交、ci_run_id=42027607903、未重跑时 ci_attempt=1（若重跑以 release.json 的 workflow.attempt 为准）、operation=deploy；工作流仍须在服务器变更前核验实际提交、当前成功 attempt 和完整交付记录。B 发布成功后才给出回退 A 的实际操作，暂不连续触发两次。

用户确认“B发布成功”，据此记录第二次正式发布通过；未提供 B 的 deploymentId、精确 attempt 或完成时间，不补造这些字段。回退前先确认保存的报告在 B 下仍可读取；随后在 main 新建运行，commit=2e47697fbc1dac0754e7320f0467ec370bcdd806、ci_run_id=41968799065、ci_attempt=1、operation=rollback，并勾选 compatibility_reviewed。已核对 A/B 业务源码、依赖锁文件及迁移无变化，脚本还会核对历史成功镜像和迁移摘要；回退读取 A 历史配置，跳过迁移、不恢复旧数据库备份。回退成功后记录 operation=rollback 的完成日志和同一报告/任务读取结果，尚未收到这些结果。

用户确认“回滚成功，一切正常”，按前序操作清单记录 B→A rollback 成功、回退后的原报告及任务状态正常，当前应用恢复到 A。未收到完整 rollback 日志，不虚构 deploymentId/controlCommit/完成时间或镜像摘要差异。该演练验证了不同发布记录之间的兼容回退流程；A/B 业务源码相同，不宣称已验证不兼容代码或不同数据库结构的回退。数据库保留当前内容，不把此演练记为备份恢复演练。

当前首读入口：release.yml 的输入/CI 交付核验/SSH 与发布锁，production-release.mjs 的顺序步骤、check/deploy/rollback 分支及失败出口。release-record.mjs 与 package-release.mjs 作为配套职责补充；集中解释应用 commit 与工具 controlCommit 的区别、历史配置来源、失败时维护状态与日志、回退不还原数据库。进入 WALKTHROUGH，不将导读已提供记为用户理解已确认。

2026-11-06：用户在完整 CI/CD 架构、commit 与 CI run/attempt 区别、release.yml→release-record.mjs→GitHub API→artifact 的导读后明确“ok,我明白了”，随后要求继续。理解确认完成，进入 RECALL，仅做本单元一次短复述与实际耗时补记；不重复发布/回退、不开下一功能或新增手写。用户尚未给出收尾复述，不预记通过。

2026-11-06 收尾复述，用户原话：“选择CI版本之后，actions调用脚本去请求Github API，查看CI状态，拉取交付内容，然后ssh登录VPS调用脚本检查、停止服务、部署和重启服务。回退版本不影响已经持久化的数据”。评价：已理解版本核验、交付材料、远程执行和持久化数据边界，短复述通过。AI 补充维护、停止写入、备份、迁移与启动的先后顺序，以及回退保留当前数据库、仍需旧代码兼容当前结构；这些补充不记为用户独立答出。

用户实报 CD03 累计约 30 分钟；不根据聊天日期、工作流时长或 AI 排错时间推算额外投入。CD01 约 20 分钟、CD02 约 25 分钟分开保留。工程提交 b85d0f4、479e57d、15a49a5 已包含实现与两次修复；本次仅收尾发布证据、学习记录和计划，不改产品代码、不重跑已通过的 25 项测试或生产操作。前两次失败提供真实预检停止证据，后续失败停止有本地测试；兼容回退不代表不兼容迁移恢复或零停机发布。按已确认范围完成 CD03，状态随本地收尾提交生效；未跟踪个人资料、R17 文档等不纳入提交，不自动推送或启动主页重构。

设计依据：[GitHub Actions 并发控制](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency)、[Docker Compose 应用创建与重建](https://docs.docker.com/reference/cli/docker/compose/up/)。生产恢复能力以本段实际演练为准。
