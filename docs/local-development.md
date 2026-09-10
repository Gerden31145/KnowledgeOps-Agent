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

Prisma Client 生成到 `packages/database/src/generated/prisma`，由 `@knowledgeops/database` 统一创建连接并供 API、Worker 复用；生成目录不提交 Git，`build:packages`、`typecheck`、`test` 和 `build` 都会先重新生成。

当前迁移已经建立两条独立运行关系：`LearningGoal → PlanGenerationRun → Plan` 负责计划生成，`Task → AgentRun` 负责笔记或回答验收。`PlanGenerationRun + OutboxEvent` 是阶段 2 的持久化异步入口；Webhook、Submission、Evidence、Report 与 RunEvent 仍在对应阶段按真实链路加入。

08-07 的 PostgreSQL 事务专用测试需要本地基础设施和迁移已经就绪：

```powershell
pnpm infra:check
pnpm db:migrate:deploy
pnpm test:integration:day-08-07
```

### 5.1 模型目录与计划生成适配层

`.env` 使用 `PLAN_GENERATION_PROVIDER=openai` 声明部署方唯一供应商，`PLAN_GENERATION_MODELS_JSON` 只允许配置该供应商下的 1～2 个白名单模型。每项包含稳定 `id`、可选 `label` 和真实模型名；密钥必须单独放在 `OPENAI_API_KEY`，不能写进目录 JSON。已有本地 `.env` 需要参照 `.env.example` 补上独立的 `PLAN_GENERATION_PROVIDER`，并删除模型 JSON 中早期的 `provider: "configured"` 占位字段。

浏览器读取：

```http
GET /plan-generation-models
```

响应只包含 `id + label`，不会暴露 provider、真实模型名、Prompt/Schema 版本或密钥。API 接受生成请求时再把稳定 ID 解析为持久化快照。

`@knowledgeops/agent-core` 定义框架无关的 `PlanGenerationPort`、请求/输出 Schema 和 `generatePlanCandidate()` 边界；`LangChainPlanGenerator` 是当前 OpenAI 兼容协议适配器，使用 `withStructuredOutput()`，并显式关闭 SDK 内部重试，避免与 BullMQ 重试形成调用放大。它没有 Repository 或 Prisma 依赖，因此只能产生候选计划，不能直接创建 Plan 或改变运行状态。

当前 Worker 已接入模型端口、Schema/依赖引用与 DAG 校验，C1 原子落库已完成；真实模型端到端证据由 R03 记录，不再把这些已完成手写视为缺口。

对于 GLM-5.3，使用 Chat Completions 端点与显式 JSON 模式：

```dotenv
PLAN_GENERATION_PROVIDER=openai
PLAN_GENERATION_MODELS_JSON=[{"id":"glm-primary","label":"GLM-5.3","model":"glm-5.3"}]
OPENAI_BASE_URL=https://open.bigmodel.cn/api/paas/v4
PLAN_GENERATION_OUTPUT_METHOD=jsonMode
```

密钥仍单独配置在 `OPENAI_API_KEY`，不要粘贴到日志、截图或提交中。`openai` 在此表示现有兼容协议适配器，不代表模型来自 OpenAI。Responses 端点不能仅替换 Base URL 后混用。

`PLAN_GENERATION_OUTPUT_METHOD` 默认 `jsonSchema`，保留原有严格 Schema 请求；`jsonMode` 发送 `response_format: { type: "json_object" }`，并在系统提示中附上输出 Schema。这符合[智谱 JSON 模式文档](https://docs.bigmodel.cn/cn/guide/capabilities/struct-output)。JSON 语法合法不代表业务结构合法：两种方式都必须通过本地 Schema、数量/日期与 DAG 校验，再进入 Finalizer；没有规则或 Mock 降级。SDK 内部提前抛出的 Zod/JSON 解析错误也归类为 `MODEL_OUTPUT_INVALID`，而不是网络或供应商失败。

目前没有覆盖 `reasoning_effort`；[GLM-5.3 官方文档](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)声明默认 `max` 且始终启用思考。原有 Run deadline 不因此自动延长。变更配置后重启 Worker；具体真实耗时与结果查阅逐日计划，不把单次调用当作性能指标。

### 5.2 Outbox 与 BullMQ 本地链路

08-09 的 Worker 同时承载两个独立角色：Outbox Dispatcher 周期性扫描 PostgreSQL，BullMQ Worker 从 Redis 消费计划生成 Job。它们当前部署在同一个 Node 进程以减少本地运维单元，但职责、类型和测试边界保持分离；后续可以独立部署 Dispatcher，而不改变 Outbox 或 Job 契约。

Dispatcher 每次在短事务中用 `FOR UPDATE SKIP LOCKED` 领取一条到期且未分发的事件。只有 `Queue.add()` 返回后才写入 `dispatchedAt`。若 Redis 暂时不可用，事件保持未分发并按指数退避更新 `availableAt`；若事件类型、Schema 版本或 payload 已损坏，则写入 `deadLetteredAt`，避免无限重试阻塞后续事件。

```text
PlanGenerationRun + OutboxEvent（已提交）
  → Dispatcher 锁定一条事件
  → Queue.add(jobId = plan-generation-{runId})
  → 成功：dispatchedAt
  → 暂时失败：availableAt 延后，重启后补扫
  → 永久契约错误：deadLetteredAt
  → BullMQ Worker 校验 Job，领取 Run，调用模型并校验候选
  → Finalizer 原子保存完整 Plan 图与成功终态；迟到结果跳过
```

本地参数均有安全边界，默认值见 `.env.example`。`BULLMQ_JOB_ATTEMPTS` 表示包括首次执行在内的总尝试数；`BULLMQ_JOB_BACKOFF_MS` 是指数退避的基准。Outbox 投递退避与 BullMQ Job 执行退避是两个不同故障层，不能混为一次重试。

数据库锁与补扫集成测试需要先部署迁移：

```powershell
pnpm infra:check
pnpm db:migrate:deploy
pnpm test:integration:day-08-09
```

08-09 的 BullMQ 适配手写完成后，再运行 PostgreSQL → Outbox → BullMQ → Worker 的专用验收：

```powershell
pnpm test:handwrite:day-08-09-bullmq
```

### 5.3 阶段 2 已验收的本地闭环

2026-09-08 已用真实 GLM-5.3 验证以下行为，2026-09-09 完成阶段收尾；具体 Run/Plan ID 与当时观察结果保留在[主计划](KnowledgeOps-Agent-逐日开发计划.md)，不要求反复付费调用模型来查阅证据。

1. 在 `/app/plan` 创建目标，生成请求持久化 Run + Outbox 后返回 202，URL 保存目标与 Run ID。
2. Worker 异步生成；页面轮询，刷新后查询同一个 Run 的当前快照，不重新提交生成请求。
3. 失败时保留目标与失败 Run，不创建半份 Plan；用户点击重试后创建关联的新 Run，不修改旧终态。
4. 成功后展示完整草稿；确认后 Plan 变为 ACTIVE，根任务变为 READY。
5. 开始任务并确认目标 Markdown 路径后，Task 变为 IN_PROGRESS，刷新后状态与路径仍在。此操作不会在 GitHub 或本地创建笔记文件。

需要复跑数据库验收时，在 PostgreSQL 与迁移就绪后运行：

```powershell
pnpm test:handwrite:stage-2-finalization
pnpm test:integration:day-08-10
pnpm test:integration:day-08-11
```

复跑前先停止正在运行的产品 Worker，结束后恢复；这些测试使用固定时间夹具，产品超时扫描器可能将夹具按真实时间推进为超时而干扰断言。测试使用固定候选，不调用真实模型。根命令 `pnpm check` 不包含这些独立数据库集成/核心手写验收。

R04 已将 `IdentityModule` 改为按请求读取真实会话；不再提供固定开发身份回退。旧开发用户数据保留，但不会自动迁移到 GitHub 用户。仓库绑定、Push/Diff Evidence、验收报告与 SSE 尚未交付，不能将任务详情中的未来功能提示当作已实现能力。

### 5.4 R04：GitHub 产品登录与会话

2026-09-09 入门观察与复述后进入产品登录切片；以下配置现由产品 API 读取。已接入本项目 User、PostgreSQL Session、登录页、退出与私有 API 鉴权；安装、仓库绑定、Webhook 仍未实现。真实产品登录观察与回调测试手写尚待完成，不能把入门成功算作 R04 完成。

先区分两件事：登录回答“当前用户是谁”；安装授权回答“应用可以访问哪些仓库”。同一个 GitHub App 可以承载两者，不需要另建 OAuth App，也不要求粘贴 PAT。第一步只验证用户身份，不申请仓库读取或写入权限。参见 [GitHub 官方登录示例](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app)。

#### 用户在 GitHub 上完成的准备

如已有本项目专用 GitHub App，核对其设置即可，不重复创建；若它还服务其他应用，不直接改动其回调与权限。

在 GitHub 的 Settings → Developer settings → GitHub Apps → New GitHub App 中注册，注意不是旁边的 OAuth Apps。本地登录阶段使用以下设置，其他权限保持默认不申请：

| 设置 | 本轮填写或选择 |
| --- | --- |
| GitHub App name | 自选唯一名称，例如 `knowledgeops-你的用户名-dev`；最长 34 字符 |
| Homepage URL | 你的 GitHub 个人主页 URL；产品公开后再改为产品地址 |
| Callback URL | `http://127.0.0.1:4000/auth/github/callback` |
| Expire user authorization tokens | 保持勾选，不关闭令牌过期 |
| Request user authorization (OAuth) during installation | 暂不勾选，登录与安装分开接入 |
| Enable Device Flow | 不勾选，本项目使用浏览器跳转 |
| Setup URL | 暂留空，后续安装时段再配置 |
| Webhook / Active | 暂取消勾选，R05 接入签名后再开启 |
| Permissions | 暂不新增权限；仓库 Contents 只读在后续绑定时段再设置 |
| Where can this GitHub App be installed? | 本地测试先选 Only on this account；开放给其他用户安装前必须调整并实测，不能宣称当前已支持 |

设置依据为 [GitHub App 注册文档](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)。这里的 Callback URL 是浏览器授权后返回本机 API 的目标地址，不是 GitHub 服务器投递事件的 Webhook URL，本轮不需要先配置公网隧道。不要混用 `localhost` 与 `127.0.0.1`；[官方示例支持本地回调](https://docs.github.com/en/apps/creating-github-apps/writing-code-for-a-github-app/building-a-login-with-github-button-with-a-github-app)。

创建后，在 App 设置页找到 **Client ID**（不是数字 App ID），生成一个 **Client secret**，将以下三项追加到仓库根目录已有的 `.env`，不要覆盖原模型/数据库配置：

```dotenv
GITHUB_APP_CLIENT_ID=填写你的Client_ID
GITHUB_APP_CLIENT_SECRET=填写你刚生成的Client_secret
GITHUB_APP_CALLBACK_URL=http://127.0.0.1:4000/auth/github/callback
```

Client secret 只保存在本机 `.env`，不发到聊天、不截图、不填进 `.env.example`，也不使用 `NUXT_PUBLIC_` 前缀。此时不用生成 App 私钥、不安装到仓库、不创建 PAT；后续仓库接入按实际需要再配置。`.env` 已由 Git 忽略。

#### 运行与观察（本轮只验证登录）

入门的真实 `github-user`、无参数回调拒绝与用户复述已记录在[主计划](KnowledgeOps-Agent-逐日开发计划.md#r04-真实身份观察成功2026-09-09)。临时源码已清理，产品接入不再运行 Playground 命令。

基础设施恢复后执行 `pnpm db:migrate:deploy`（本次会话表迁移已在本机执行），再按第 6 节启动；若 AI 已启动 Web/API，则直接观察，不重复占用端口：

1. 打开 `http://127.0.0.1:3000/login`，选择 GitHub 登录，由你自行核对并授权。
2. 回到 `/app/plan` 后应显示自己的 GitHub 用户名，地址不再含 code/state。新用户看不到旧开发用户的计划，这是身份隔离，不是数据丢失。
3. 刷新工作台，再打开 `http://127.0.0.1:4000/auth/session`，应返回本项目用户摘要，不包含凭据。API 重启后已完成会话仍可从数据库恢复。
4. 在工作台退出，再访问会话接口应为 401；重新进入工作台转到登录页。直接访问无参数回调会转到带安全错误提示的登录页。

本轮暂不提交模型生成请求，不读取仓库。只报告是否进入工作台、刷新是否保持身份、退出后是否拒绝；不要分享 Cookie、Token、完整回调 URL 或 Network 导出。修改 API 的环境变量后需重启进程。

首轮按顺序看三个入口，不通读新增文件：

- `apps/api/src/identity/auth.controller.ts`：四个 HTTP 入口，以及回调后的 Set-Cookie / 302。
- `apps/api/src/identity/auth.service.ts`：本轮重点看编号 2 的 User/Session 事务和编号 3 的 `requireUser / lookupUser`；编号 1 和换令牌复用已学 OAuth。
- `apps/api/src/identity/identity.module.ts`：`CURRENT_ACTOR` 如何按本次请求得到用户，再交给既有业务 Controller。

`auth-http.ts` 只提供随机值、哈希与 Cookie 处理；`AuthGuard` 默认保护接口并检查写请求 Origin；健康检查和显式登录路由公开。Web API 封装带 `credentials: 'include'`，路由中间件在刷新/进入工作台时查会话，身份变化或退出会清理查询缓存。`apps/api/test/github-auth.controller.exercise.ts` 的三个用户手写测试已通过 Review 和专用验收，不纳入常规通过数、不重复布置。

#### 会话与部署边界

- 会话是 32 字节随机凭据；PostgreSQL 仅存 SHA-256 哈希、用户、7 天有效期与创建时间。退出删除服务端会话，重新登录轮换当前浏览器旧凭据；仓库接入后 GitHub 用户 Token 除查身份外，在单 API 进程内存保留最多 10 分钟用于绑定时重新核验权限，不进数据库或浏览器，详见 5.7。
- Cookie 使用 HttpOnly / SameSite=Lax / Path=/；HTTPS 使用 Secure 和 `__Host-` 名称，仅本地回环 HTTP 允许无 Secure。Web 与 API 必须同主机名、同协议（本地端口可不同）；生产要求 HTTPS 和完整 GitHub 配置，可用同域反向代理 `/api`。生产 Cookie 配置已受测试约束，不代表已部署或完成 HTTPS 浏览器验收。
- 每个请求单独解析会话，不能把当前用户放入全局单例。User/Session 事务失败不颁发 Cookie；过期会话不允许使用，即使过期行尚未物理清理。同一用户下次登录会清理其已过期会话；当前没有全库清理定时器。
- OAuth 尝试与登录限流暂为单 API 进程内存：尝试 10 分钟有效、一次消费、最多 200 个；每个直连地址 10 分钟最多发起 10 次。API 重启会让尚未完成的授权失效，重新登录即可；已完成的数据库会话不受影响。尚未支持多实例共享尝试/限流；反向代理下不信任任意 X-Forwarded-For，R07 部署检查时必须核对代理地址与入口限流，不能宣称已通过生产防滥用验收。
- 写请求必须携带等于 `WEB_ORIGIN` 的 Origin；这与服务端用户级所有权校验一起工作，不能只靠前端路由或 CORS 判断权限。命令行发写请求也须显式提供正确 Origin 和有效会话，不能再沿用匿名 curl 生成计划。
- 登录失败只重定向到固定 Web 地址和白名单错误类别，不回显上游正文、凭据或完整回调参数。登录页说明身份数据、保留策略及尚未提供的自助删除能力。

验证命令：

```powershell
pnpm check
pnpm test:integration:r04
```

R04 集成使用真实 PostgreSQL、临时 Nest HTTP 端口和合成测试用户；GitHub 上游为夹具，不触发真实授权或模型调用。测试清理只作用于本次创建的精确 UUID，不能冒充用户真实浏览器登录。

### 5.5 R04 安装授权最小观察（登录已验收，绑定尚未实现）

本节标题与步骤保留前期入门边界；用户现已报告单仓库安装，当前产品接入与验收状态见 5.7，不要求重复安装。

本时段预算约 20 至 30 分钟，计入 R04 原预算，不新增手写。先在 GitHub 页面观察安装与仓库选择，再接入产品绑定；不要求重新验证已通过的登录。

| 操作 | 决定什么 | 当前边界 |
| --- | --- | --- |
| GitHub 登录 | 当前项目用户是谁 | 产品闭环已由用户确认 |
| 安装 GitHub App | 应用在某个账号下获得哪些仓库权限 | 本时段由用户选择并授权，结果待确认 |
| 项目内绑定 | KnowledgeOps 实际处理哪一个仓库 | 尚未实现，不能把安装成功当作绑定完成 |

操作入口：GitHub 个人 Settings → Developer settings → GitHub Apps → 现有 App 的 Edit。

1. 在 Permissions & events 中，将 Repository permissions 的 **Contents** 设为 **Read-only**；保留 GitHub 自动要求的 Metadata 只读，不新增其他权限。保存。如果此前已经安装过，还需要在安装设置中批准新增权限；仅修改 App 注册配置不等于现有安装已获得权限。
2. 保持既有登录 Callback URL 和 Client 配置；Request user authorization (OAuth) during installation 仍不勾选，Setup URL 仍留空，Webhook / Active 仍关闭。此时不需要启动本机 API、配置公网隧道、生成 App 私钥或创建 PAT。
3. 进入 Install App，在自己的账号旁选择 Install；仓库范围选择 **Only select repositories**，只选一个由自己管理、用于存放学习 Markdown 且不含敏感资料的仓库。不要选 All repositories；没有合适仓库时可自行新建专用学习仓库，不需要迁移当前应用源码。
4. 核对授权页仅有预期只读权限，再确认安装。完成后在该安装的 Configure 页面核对 Repository access：仍是选定仓库，列表只有预期的一项。已有安装就检查并更新这项配置，不必卸载重装。

本轮成功现象是 GitHub 显示安装及选定仓库，不是 KnowledgeOps 页面已有绑定，也不证明后台已经能读取文件或接收 Push。若显示权限待批准或安装请求待批准，先记为未完成，不扩大授权范围绕过。向 AI 只报告“已安装，仅授权 owner/repo”或不含凭据的错误提示；不发送 Cookie、Token、私钥、完整回调 URL 或网络导出。

安全边界：选定安装仓库不等于 GitHub 的所有 API 都无法读取其他公开资源；后续产品仍须在服务端验证当前用户、安装关联和绑定仓库。Setup URL 与登录 Callback URL 不同，将来接入时不能直接信任浏览器传来的 installation_id。产品内解绑也不等于在 GitHub 卸载 App；本期必须实现的是停止对已解绑仓库发起后续分析。

依据：[安装自己的 GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)、[最小权限及变更批准](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/choosing-permissions-for-a-github-app)、[Setup URL 的用途与安全边界](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-setup-url)。Webhook 订阅与签名接收在 R05 接入，本轮不提前开启。

### 5.6 R04 仓库接入凭据准备（产品绑定仍待实现）

本节保留接入前的配置步骤；2026-09-10 用户更正文件后，私钥解析及真实 App 匹配已通过，产品状态见 5.7，不需要重新生成私钥。

完成 5.5 的安装观察后，后端还需要证明自己是这个 GitHub App，才能申请短期安装访问令牌。已有 Client secret 用于用户登录的 code 交换，不能替代 App 私钥。本步骤约 5 至 10 分钟，计入 R04 预算；不新增手写或 JWT 专题。

1. 打开现有 App 的设置页，在 General 页底部的 Private keys 区域点击 Generate a private key，下载 `.pem`。若已有该 App 的可用私钥，可复用，不必重复生成或删除旧密钥。
2. 将下载的文件保存在本机受保护的位置；本地开发可放在根目录 `.secrets/` 并命名为 `github-app.pem`。不要放到 Web 的 `public/`、Playground、源码或共享网盘目录。`.secrets/` 和 `*.pem` 已加入 Git 忽略；忽略规则只防误提交，不代替文件访问权限控制，生产应使用受保护的密钥挂载。
   此处放的是 GitHub 下载的原始文件，不是新建一个同名文本文件后填入路径或 Client secret。仅改扩展名不会将普通文本变成私钥；若解析失败，优先核对下载文件与配置目标是否一致，不把文件正文发到聊天。
3. 在根目录实际 `.env` 追加下行，值为真实文件的绝对路径（这里是当前 Windows 开发路径）；只存路径，不粘贴 PEM 内容，不覆盖现有配置：

   ```dotenv
   GITHUB_APP_PRIVATE_KEY_PATH=D:/project/agent/.secrets/github-app.pem
   ```

4. 保留原 `GITHUB_APP_CLIENT_ID`、Client secret 和 Callback URL。GitHub 支持使用 Client ID 作为应用认证的 issuer，不需要再配置另一个 App ID。Setup URL 与 Webhook 仍按 5.5 保持未接入状态。

完成后只反馈“私钥路径已配置”，不要发送私钥内容或 Token。AI 下一步检查时只能输出文件可读/格式有效等结果，不打印原文或签名令牌；配置解析通过不代表文件存在、密钥与 App 匹配或仓库访问成功。本次只补了路径配置和安全忽略规则，尚未添加密钥加载、GitHub 仓库 API 或绑定业务；先不重启现有登录服务，产品接入后统一重启验证。

依据：[GitHub App 私钥管理](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)、[应用认证及 Client ID 支持](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)。

### 5.7 R04 产品仓库绑定（真实仓库观察已确认）

2026-09-10 用户已完成真实仓库列表、绑定、刷新恢复、解绑及再次刷新观察；以下步骤保留用于复现，不要求重复学习验收。Webhook 与后台分析尚未接入。

本轮只观察“选择授权仓库 → 绑定 → 刷新恢复 → 解绑”，预计用户观察/导读 45 至 60 分钟计入 R04 原预算，不新增手写。Web/API 已单独启动时直接使用，不重复启动根 dev；不需要 Worker。

1. 打开 `http://127.0.0.1:3000/app/repository`。未登录会回到登录页；完成既有 GitHub 登录后，从工作台导航进入“仓库接入”。
2. 点击“加载 GitHub 已授权仓库”。若显示“通过 GitHub 重新核验”，点击并完成授权，再从导航返回本页重新加载；这用于取得当前用户的短期仓库权限证明，不是重新验收登录。现有 Session 与已保存的绑定不会因这份权限证明过期而自动失效。
3. 核对安装账号与实际学习仓库，分支留空使用默认分支；自定义分支须已存在。安装必须未暂停、选定仓库模式且 Contents 只读；没有选项时通过页面链接管理授权、批准新权限后刷新，不改成所有仓库或增加写权限绕过。
4. 阅读并确认隐私说明，点击“绑定这个仓库”。后端重新验证用户与 App 共同可访问的安装/仓库，仅申请所选仓库的只读安装 Token，再事务保存绑定。上游失败或当前绑定版本变化不会悄悄覆盖已有绑定。
5. 刷新页面，仓库名与分支仍应显示。点击“解除绑定”并确认，页面回到未绑定；需要继续后续 Push 单元时可以再次绑定同一仓库。重绑产生新的绑定 ID，旧解绑请求不会关掉新绑定。

只报告上述真实观察与不含凭据的错误提示，不发送完整回调 URL、Cookie、Token、私钥或网络导出。`owner/repo` 不是需要原样填写的配置；仓库名由 GitHub 的真实列表返回，不由 AI 写死。

首轮只读两个入口：

- `apps/api/src/repositories/repository-binding.service.ts`：current 从数据库恢复；bind 外部权限核验后锁用户、校验版本、保存唯一活动绑定；unbind 停用指定绑定并增加版本，旧命令不复活旧状态。
- `apps/web/app/pages/app/repository.vue`：绑定快照查询、安装/仓库选项查询、两个 mutation；成功后取消旧快照请求并更新缓存。模板样式按需查，不要求逐行阅读。

辅助文件职责与边界：Controller 复用会话 Guard/Origin 和 Zod 输入输出；`github-repositories.ts` 固定 GitHub 主机、只读权限与所选仓库，操作限时 20 秒，每个列表最多 10 页，达到上限明确失败而不返回不完整列表。App 私钥只加载到服务端并用于 RS256 签名，安装 Token 为本次调用临时值；GitHubInstallation 行只是上次核验快照，不能作为后续永久授权证明。

GitHub 用户 Token 以项目会话哈希为键仅保存在 API 内存，最多 200 条、访问有效期不超过 10 分钟，按访问/新增清理过期项；退出或当前会话轮换清除对应旧项。重启/到期/容量淘汰需要重新核验才能新绑定；读取和解除已有绑定只依赖 PostgreSQL Session，不依赖此 Token。当前仍是单 API 进程部署边界，不宣称支持多实例共享授权。

数据库 `Repository.enabled` 与用户版本构成后续处理入口约束；解绑保留历史、不中断 GitHub 侧安装、不删除旧计划。R05/R06 尚未实现，必须在接收/执行时检查当前 enabled 绑定与绑定 ID，不能提前宣称已跑通 Push 或停止后台分析。默认分支当前存于绑定，计划/Push 匹配在后续单元接入。绑定及学习数据当前不自动清理，尚无自助数据删除入口。

验证命令：`pnpm check`、`pnpm test:integration:r04`、`pnpm test:handwrite:r04-auth-callback`、`pnpm --filter @knowledgeops/web build`。2026-09-10 分别通过 179 项常规测试、18 项真实数据库/模拟 GitHub 集成、3 项既有手写及 Web 构建。真实 App 凭据检查通过；隔离 UI 网络夹具只证明界面状态与请求编排，不代替本节真实仓库操作。完整证据和首次验证问题见主计划。

授权依据：[用户可访问的安装与交集仓库](https://docs.github.com/en/rest/apps/installations)、[按仓库及权限收窄安装访问令牌](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)。

## 6. 启动应用

```powershell
pnpm dev
```

根命令先构建共享包，再用三个子进程启动 Web、API 与 Worker。预期结果：

- 打开 `http://127.0.0.1:3000` 可看到工程骨架页；
- 进入 `http://127.0.0.1:3000/app/plan` 使用计划工作台；
- 请求 `http://127.0.0.1:4000` 返回 API 描述；
- 终端中出现 Worker ready 日志，并保持独立运行。

Worker 的进程存活现在由真实 BullMQ 连接和 Outbox 轮询器维持，不再使用阶段 1 的空心跳占位。启动日志会记录 Dispatcher 批次结果、Job ID 和 `generationRunId`，不会记录模型密钥或完整 Prompt。

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
