# CD01：在 WSL 运行应用容器

本段使用 WSL Ubuntu 的 Docker。用户执行构建、启动、日志、停止与重建，AI 负责配置和静态检查；命令按当前学习进度执行。生产切换和 GHCR 发布属于后续 CD02/CD03。

当前工程状态：镜像构建、容器启动、网络修正后的本机 HTTP 和真实 Worker 消费合成任务均已观察。用户提供 `cd01-verified`：Run `0f924b25-adbb-4a26-9c02-bd605c4573cf` 为 SUCCEEDED，对应 Plan `a9b540d8-b9b2-4e7b-bc2b-633e066ebff5`、3 个 Task；随后确认停止正常、重新创建容器后的原结果查询正常。按用户反馈记录 PostgreSQL 业务数据保留，不虚构退出码、停止耗时或 Redis 队列持久化结论。用户实报累计约 20 分钟，集中导读与短复述完成，随本单元本地提交收尾；GHCR 发布及生产切换尚未实施。

## 1. 两个主要入口

- `deploy/Dockerfile`：共享构建过程，输出 api、worker、web 和一次性 migrate 目标。最终镜像携带运行产物；没有源代码目录或宿主机依赖的挂载。
- `deploy/compose.apps.yaml`：叠加到既有数据库/Redis 配置上，指定应用镜像、运行变量、网络、只读凭据目录和停机时间。生产依然使用原 knowledgeops 项目和数据卷，本段不切换生产。

补充文件：`.dockerignore` 限制构建上下文；`deploy/migrate/package.json` 让迁移工具携带锁定版本的 Prisma CLI/dotenv；API/Worker 的 package.json `files` 字段确保部署包包含 dist；`compose.cd01.yaml` 和 `tests/deploy/` 只为隔离观察服务。

容器中的 API/Worker 连接 `postgres:5432`、`redis:6379`；宿主机通过映射端口访问 API/Web。浏览器使用公开地址，不使用容器服务名。Web/API 在容器中监听 `0.0.0.0`，宿主机映射只监听 `127.0.0.1`。CD01 为它们额外连接 `host_access` 普通桥接网络；Worker、model、数据库和 Redis 只连接内部网络。数据库/Redis 的宿主机映射由 CD01 覆盖文件清除，Worker 没有公网端口。上述网络覆盖只用于本地练习。

## 2. 准备与配置检查

在 WSL Ubuntu 中进入仓库；以下相对路径都以此为起点：

```bash
cd /mnt/d/project/agent
cp -n deploy/cd01.env.example deploy/.env.cd01
docker compose --env-file deploy/.env.cd01 config --quiet
```

`cp -n` 保留已有文件。示例只含合成凭据，不能用真实生产 `.env` 替换。`config --quiet` 检查三个 Compose 文件合并后的语法、变量与路径，不启动容器，也不证明镜像可运行。配置定义了 `knowledgeops-cd01` 项目，使用独立卷；宿主机端口为 API 14000、Web 13200。若端口占用，只调整本练习的变量。模板中的 PostgreSQL 25432、Redis 26379 是基础文件插值用的保留值；CD01 覆盖文件通过 `ports: !reset []` 清除映射，本练习不从宿主机直连存储。

`.env.cd01` 中的 `COMPOSE_FILE` 告诉 Compose 合并基础、应用与练习配置，因此后续不必每次输入三组 `-f`。该写法使用 Linux 的冒号分隔符，命令在 WSL 执行。服务内文件路径相对于首份配置所在的 deploy/，例如 `APP_ENV_FILE=.env.cd01`。

确认镜像仓库连通后再构建。终端的代理变量、Docker 后台服务的代理和构建步骤中的代理是不同的作用范围，按实际失败位置排查，不把本机 `127.0.0.1` 代理地址直接复制成容器内地址。

## 3. 构建镜像

```bash
docker compose --env-file deploy/.env.cd01 --profile tools build api worker web migrate
```

`build` 按 Dockerfile 制作镜像，不启动应用；`tools` 启用一次性迁移服务。四个目标共享依赖下载与构建层，首次需要下载依赖，之后可使用缓存。不要把构建成功记作应用启动、业务消费或生产发布成功。

## 4. 先准备存储，再运行应用

```bash
docker compose --env-file deploy/.env.cd01 up -d --wait postgres redis
docker compose --env-file deploy/.env.cd01 run --rm migrate
docker compose --env-file deploy/.env.cd01 up -d --no-build --pull never --wait api web worker
```

第一条等待数据库/Redis 健康；第二条启动一次迁移容器，把表结构更新到源码中的迁移版本，退出后删除该次容器；第三条运行已经构建的应用，并带起本地模型夹具。顺序执行，任何一步失败先处理，不继续启动应用。迁移失败不会被自动忽略，应用重启也不会偷偷执行迁移。

本段数据库名固定为 `knowledgeops_cd01`，不能指向现有学习库或生产库。Worker 与模拟模型仅连接内部网络，Worker 的模型 URL 指向 `model:4100`；没有真实模型调用。API/Web 额外连接普通桥接网络以发布本机端口，因此不能宣称所有容器都禁止外部访问。密钥目录为空，GitHub 登录与真实 Push 不属于本次观察。

若已按初版启动、`ps` 仅显示 `4000/tcp` 与 `3200/tcp` 而没有 `127.0.0.1:14000->4000/tcp` 等映射，更新配置后执行：

```bash
docker compose --env-file deploy/.env.cd01 config --quiet
docker compose --env-file deploy/.env.cd01 up -d --no-deps --force-recreate --no-build --pull never --wait api web
```

这里只替换 API/Web 容器，使网络配置生效；不需要重新构建镜像或执行迁移，不操作数据库/Redis 数据卷。随后按下节验证实际 HTTP 访问。

## 5. 观察进程与 HTTP

```bash
docker compose --env-file deploy/.env.cd01 ps
curl -fsS http://127.0.0.1:14000/health/ready
curl -sS -o /dev/null -w 'Web HTTP %{http_code}\n' http://127.0.0.1:13200/
docker compose --env-file deploy/.env.cd01 logs --tail 30 worker
```

预期 API readiness 的 PostgreSQL/Redis 均 up，Web HTTP 200，Worker 有 `worker_runtime_started`。Worker 没有 HTTP readiness；仅有 running 或启动日志不足以证明它能消费。主页可在浏览器打开 `http://127.0.0.1:13200/`，本练习不接入真实 OAuth，也不作为完整页面业务验收。

## 6. 验证真实 Worker 消费模拟任务

先通过 Worker 镜像中的实际数据库依赖，在测试库创建合成 Goal、Run、Outbox：

```bash
docker compose --env-file deploy/.env.cd01 run --rm --no-deps -T worker \
  node --input-type=module - seed < tests/deploy/cd01-fixture.mjs
```

这是一个临时检查进程，覆盖了默认启动命令，不会启动第二个队列消费者。`-T` 关闭伪终端，使 `<` 可以把检查脚本交给容器中的 Node；没有把宿主机应用源码挂载到运行容器。

复制输出中的确切 `runId`，在同一 WSL 终端保存并检查：

```bash
RUN_ID='替换为刚才输出的 runId'
docker compose --env-file deploy/.env.cd01 run --rm --no-deps -T worker \
  node --input-type=module - check "$RUN_ID" < tests/deploy/cd01-fixture.mjs
docker compose --env-file deploy/.env.cd01 logs --tail 30 worker model
```

预期 `cd01-verified`、SUCCEEDED、唯一 Plan 与 3 个 Task。链路经过真实 Dispatcher、BullMQ、生产 Worker 入口、LangChain 适配器和 Finalizer；仅 HTTP 模型端返回固定合成内容。检查脚本拒绝其他数据库/模型地址，默认等待结果最多 30 秒。不要使用另一次成功 Run 的 ID 来证明本次成功。

## 7. 停止、重建与持久化

在前一条 Run 已成功后执行：

```bash
docker compose --env-file deploy/.env.cd01 stop api web worker
docker compose --env-file deploy/.env.cd01 ps -a
```

检查停止结果和 Worker 退出码。停止先发送退出信号；Worker 最多等待 210 秒，复用现有关闭分发循环、队列和数据库的逻辑。该值对齐当前 180 秒模型超时配置；如果调整业务超时，需要重新评估。一次空闲停止不等于证明所有运行中任务都能正常结束。

随后重建测试存储和应用容器，保留命名卷：

```bash
docker compose --env-file deploy/.env.cd01 up -d --force-recreate --no-build --pull never --wait postgres redis
docker compose --env-file deploy/.env.cd01 up -d --force-recreate --no-build --pull never --wait api web worker
docker compose --env-file deploy/.env.cd01 run --rm --no-deps -T worker \
  node --input-type=module - check "$RUN_ID" < tests/deploy/cd01-fixture.mjs
```

使用同一个 Run ID 再次看到相同 Plan，证明容器被替换后业务记录仍保存在命名卷中；保留首次 `check` 输出用于比对 planId，不重新执行 seed。本次只替换列出的存储和应用容器，保留 model 容器，使调用次数检查继续可用。这一结果验证 PostgreSQL 中的业务记录保留，不单凭它宣称 Redis 队列内容也已验证持久化。这个练习不测试强制终止活跃 Job，也不替代既有 Worker 崩溃恢复回归。

收尾可执行 `docker compose --env-file deploy/.env.cd01 stop`，保留练习数据供后续观察；是否停止由用户按实际使用决定。已有观察与投入记录见本文开头和开发计划，不要求为收尾重新执行本指南。
