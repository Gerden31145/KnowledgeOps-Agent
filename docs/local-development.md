# 本地开发指南

## 1. 运行边界

应用代码运行在 Windows Node.js 24 LTS，PostgreSQL 与 Redis 作为 WSL2 Ubuntu 原生服务运行。Docker Desktop 与本机 Docker daemon 都不参与日常开发链路。

```text
Windows
├─ Nuxt Web       http://127.0.0.1:3000
├─ NestJS API     http://127.0.0.1:4000
└─ Agent Worker   独立后台进程

WSL2 Ubuntu
├─ PostgreSQL     127.0.0.1:5432
└─ Redis          127.0.0.1:6379
```

要求：

- Node.js `>=24.11.0 <25`，仓库基线为 `24.18.1`；
- pnpm `>=10.34.5 <11`；
- WSL2 Ubuntu；
- WSL 内可使用 `apt` 安装 PostgreSQL 与 Redis；本地服务固定监听默认端口 `5432` 与 `6379`。
- PostgreSQL 最低版本为 14；Redis 使用官方 APT 源的 7.4 主版本（BullMQ 要求至少 6.2）。

Day 2 安装时发现 Node.js 22.17.1 低于当前 Vue Router/Babel 依赖链要求，因此升级到当前 LTS 24.18.1，并使用 Nuxt 4.5.1。`.node-version` 记录经过验证的精确版本，`package.json#engines` 记录允许的兼容范围。

2026-08-01 已从 Windows 应用边界实测 PostgreSQL 14.23 与 Redis 7.4.10；`SELECT 1`、`PING`、三个应用的开发启动以及生产构建均通过。

## 2. 首次安装

在仓库根目录执行：

```powershell
corepack enable pnpm
corepack install --global pnpm@10.34.5
Copy-Item .env.example .env
pnpm install
```

仓库已提供一份被 Git 忽略的本地 `.env`。上面的复制命令用于新克隆环境；不得把真实密钥提交到 Git。

## 3. WSL 原生基础设施

```powershell
pnpm infra:up
pnpm infra:check
```

`infra:up` 通过 `wsl.exe -d Ubuntu` 安装缺失的软件包、将过旧 Redis 升级到官方 APT 源的 7.4 主版本、启动 PostgreSQL/Redis，并幂等创建 `.env` 中的本地开发用户、业务数据库和独立的 Prisma 影子数据库。它不会启动或调用 Docker，也不会删除已有业务数据。

`infra:check` 不只检查端口：它会从 Windows 应用所在的网络边界执行 PostgreSQL `SELECT 1` 和 Redis `PING`，并输出实际服务版本。

查看或停止基础设施：

```powershell
pnpm infra:status
pnpm infra:stop
```

`infra:status` 是非修改性的状态查询：它会完整报告 PostgreSQL 和 Redis 是 `running` 还是 `down`。服务停止时命令仍正常结束并提示执行 `pnpm infra:up`；需要把服务不可用视为失败时，使用协议级的 `pnpm infra:check`。

`infra:stop` 只停止 WSL 服务，不卸载软件，也不删除数据库和 Redis 数据。

若发行版名称不是 `Ubuntu`，在 `.env` 中修改：

```dotenv
KNOWLEDGEOPS_WSL_DISTRO=你的发行版名称
```

## 4. Linux VPS 上的 Compose 路径

仓库仍保留 `deploy/compose.yaml`，但本机不把 Compose 作为开发前置条件。阶段 3 在真实 BullMQ 链路完成后，会先在 Linux VPS 验证 PostgreSQL/Redis 的镜像拉取、healthcheck、数据卷和本机回环端口；阶段 6 再用于完整生产部署。

在 Linux VPS 的仓库目录中显式执行：

```bash
pnpm infra:compose:up
pnpm infra:check
pnpm infra:compose:status
```

停止时使用 `pnpm infra:compose:stop`。该命令保留容器、镜像和命名卷。Compose 默认只将数据库与 Redis 绑定到 VPS 的 `127.0.0.1`，不得为方便调试直接暴露公网端口。

应用只依赖 `DATABASE_URL` 与 `REDIS_URL`，不直接执行 WSL、service 或 Docker 命令。因此本地原生服务与 VPS Compose 可以复用业务代码。两套环境可能存在版本差异，使用以下三层手段尽早发现漂移：

- `infra:check` 做协议级连通性和版本记录；
- 数据库迁移与队列集成测试在两边执行；
- 阶段 3 提前做 VPS smoke，而不是等到最终发布日。

## 5. 数据库 Schema 与迁移

本地 `DATABASE_URL` 显式使用 `sslmode=disable`，因为 Windows 到 WSL 回环地址是本机开发链路；生产连接串必须按数据库提供商要求配置 TLS，不能复制这个本地选项。

首次启动或拉取到新迁移后执行：

```powershell
pnpm db:migrate:deploy
pnpm db:migrate:status
```

修改 `prisma/schema.prisma` 时，开发环境使用 `pnpm db:migrate:dev -- --name <migration_name>` 生成迁移。该命令需要 `SHADOW_DATABASE_URL` 指向独立、可重置的 `knowledgeops_shadow`，绝不能与 `DATABASE_URL` 指向同一个数据库。部署环境只执行已提交的 `pnpm db:migrate:deploy`，不执行 `migrate dev`，也不需要影子数据库。

常用的纯代码检查：

```powershell
pnpm db:validate
pnpm db:generate
```

当前初始迁移只建立 `User → LearningGoal → Plan → Stage → Task → AgentRun` 的核心关系；Webhook、Submission、Evidence、Report、RunEvent 与 Outbox 在对应阶段再加入，不用空表假装业务已实现。

## 6. 启动应用

```powershell
pnpm dev
```

根命令先构建共享包，再用三个子进程启动 Web、API 与 Worker。预期结果：

- 打开 `http://127.0.0.1:3000` 可看到工程骨架页；
- 请求 `http://127.0.0.1:4000` 返回 API 描述；
- 终端中出现 Worker ready 日志，并保持独立运行。

当前 Worker 的定时 handle 只是阶段 1 的进程存活占位；阶段 3 接入 BullMQ 后由真实队列连接替换。

API 的探针：

- `GET http://127.0.0.1:4000/health/live`：只证明 Node/Nest 进程可以响应，不访问外部依赖；
- `GET http://127.0.0.1:4000/health/ready`：并发执行 PostgreSQL `SELECT 1` 和 Redis `PING`；全部可用时返回 `200 ready`，任一不可用时返回 `503 not_ready`。

API 与 Worker 日志均为单行 JSON。API 会为每个请求生成或接收一个受长度和字符集限制的 `x-request-id`，回写响应头并记录状态码与耗时；日志只记录 URL pathname，不记录 OAuth 等查询参数。

## 7. 一键质量检查

```powershell
pnpm check
```

该命令依次执行格式检查、ESLint、所有 workspace 的类型检查和 Vitest。基础设施连通性独立使用 `pnpm infra:check`，避免纯代码 CI 依赖本机服务。

## 8. 常见问题

### WSL 关闭后基础设施不可用

WSL 发行版停止时，其中的 PostgreSQL 与 Redis 也会停止。重新执行 `pnpm infra:up` 即可。若连 `wsl.exe -d Ubuntu -- echo ok` 都无法返回，先确认没有未完成的 WSL 命令，再在 PowerShell 中执行 `wsl --shutdown`，确认发行版恢复后重新启动基础设施。

### 端口被占用

API 端口可在 `.env` 中修改。WSL 原生 PostgreSQL/Redis 当前固定使用 `5432/6379`；若这两个 Windows 转发端口冲突，应先定位占用进程，不要只改连接 URL 造成配置与服务监听不一致。VPS Compose 可通过 `.env` 同时修改端口和连接 URL。

### 为什么不在 Docker 中运行三个 Node 应用

阶段 1 优先缩短 Windows 上的编辑、HMR 与调试链路。生产部署仍以三个长驻进程为边界；应用进程只面向标准协议和环境变量，因此不依赖这套本地拓扑。
