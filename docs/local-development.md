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

当前迁移已经建立两条独立运行关系：`LearningGoal → PlanGenerationRun → Plan` 负责计划生成，`Task → AgentRun` 负责笔记或回答验收。`PlanGenerationRun + OutboxEvent` 是阶段 2 的持久化异步入口；R05 已加入 `WebhookDelivery + OutboxEvent` 接收意图，Submission、Evidence、Report 与完整 RunEvent 仍在对应范围按真实链路加入。

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
| Webhook / Active | 暂取消勾选；R05 仅完成可信接收，待后续消费与受控联调准备好后再开启 |
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

2026-10-09 范围补充：保留“一名用户一个活动仓库”，同时限制“一个 GitHub 仓库一个活动用户”。占用按 GitHub 仓库 ID 判断，换分支/安装仍不能重复绑定；已授权但被占用时返回安全的 409，页面沿用现有错误提示。解绑后其他有权限用户可新建绑定，旧记录与学习进度不转移。本补充已通过数据库/API 集成，不要求重开 R04，也不表示重新完成了真实页面观察。Webhook 接收主体的新边界见 5.10，后台分析尚未接入。

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

数据库 `Repository.enabled` 与用户版本构成后续处理入口约束；解绑保留历史、不中断 GitHub 侧安装、不删除旧计划。10/10 的 R05 接收主体与签名已通过验证，按绑定分支检查当前 enabled 绑定与绑定 ID；10/14 的 R06 任务关联、后台读取/落库再次核验及队列接入见 5.13 至 5.15，已通过隔离工程验证，不代表真实 Push 已验证。绑定及学习数据当前不自动清理，尚无自助数据删除入口。

验证命令：`pnpm check`、`pnpm test:integration:r04`、`pnpm test:handwrite:r04-auth-callback`、`pnpm --filter @knowledgeops/web build`。2026-09-10 分别通过 179 项常规测试、18 项真实数据库/模拟 GitHub 集成、3 项既有手写及 Web 构建。真实 App 凭据检查通过；隔离 UI 网络夹具只证明界面状态与请求编排，不代替本节真实仓库操作。完整证据和首次验证问题见主计划。

授权依据：[用户可访问的安装与交集仓库](https://docs.github.com/en/rest/apps/installations)、[按仓库及权限收窄安装访问令牌](https://docs.github.com/en/rest/apps/apps#create-an-installation-access-token-for-an-app)。

### 5.8 R13：真实 Run 的 SSE 传输入口

2026-09-17 R13 最小观察、两入口导读与短复述已由用户完成，累计实际投入约 35 分钟；4103 临时服务与两份练习源码已清理。接口读取真实 PostgreSQL 中的 PlanGenerationRun；没有模型逐字流、事件历史或 cursor 重放。R13 收尾时页面仍用原轮询；2026-09-18 已接入 C2，页面验证边界见下一节。

可观察结果：已有登录 Cookie 且拥有该 Run 时，打开 `http://127.0.0.1:4000/plan-generation-runs/<runId>/events` 可收到 `snapshot`。`runId` 取已有计划页 URL 的 `run` 参数，不用创建新目标；终态只发一次快照便结束响应。若没有现存 Run，先看集成验证即可，真实生成/断网恢复统一在 C2 完成后观察，不为本轮额外调用模型。未登录返回 401；他人的 Run 与不存在的 Run 都返回 404。不要分享 Cookie 或完整网络导出。

```powershell
pnpm test:integration:r13
```

该命令需要 PostgreSQL，不需要 Redis、Worker 或模型；创建 UUID 隔离的合成用户/会话/Run，经真实 Nest HTTP 和独立数据库连接验证更新、终态重连、权限、会话撤销/过期和连接释放，结束仅清理本次测试用户及其关联数据。这不是用户真实登录、模型生成或生产代理验收。

首轮只读两个入口（其他改动按职责查阅）：

1. `apps/api/src/plan-generation/plan-generation-stream.service.ts`：从 `open → read → publish` 看第一次完整快照，再看 `poll` 与 `stop`。Controller 只是把已鉴权用户、Run ID、request/response 转交进来；先完成归属查询，才发送 SSE 的 200 响应头。
2. `apps/web/app/lib/plan-generation-stream.ts`：`subscribePlanGenerationRun` 用实际 API base URL 和 `withCredentials` 创建 EventSource，校验消息后调用回调，返回 `close()`。不修改 Query 缓存、不决定版本大小或是否启动轮询；这些留给 C2。

| 协议 | 内容与用途 |
| --- | --- |
| HTTP `GET /plan-generation-runs/:id` | 完整快照，新增数据库 Run `version`；其余字段不变 |
| SSE `GET /plan-generation-runs/:id/events` 的 `snapshot` | 与 HTTP 相同的完整快照；包含 Run ID/version/status/plan 引用，不含模型凭据 |
| SSE `stream-error` | 安全代码 `UNAUTHENTICATED` / `RESOURCE_NOT_FOUND` / `STREAM_UNAVAILABLE`，随后结束连接；不改写 Run.status |

API 每 2 秒串行重新验证数据库会话并查询持久化状态，有变化才发快照；无变化约 16 秒发一次注释心跳（15 秒阈值按 2 秒检查粒度触发）。这允许读取独立 Worker 的写入，但服务端仍在轮询数据库，不能宣称消除了轮询成本或已测得性能提升。初次建连/每次重连都读取最新状态，不依赖 API 进程内 emitter；不发送事件 id，也不使用 Last-Event-ID 补历史。

连接限制是每 API 进程最多 100 条、每用户最多 3 条（不是分布式全局限流）；超过返回 429。断开、终态、慢客户端或应用关闭会清理连接和计时器；查询串行，断开后已发出的数据库查询可能继续完成，但结果不会再发送或启动下一轮。会话在下一轮读取前重验，退出/过期不继续沿用初始请求缓存。

故障分两层：开始前用正常 HTTP 401/404/429/503；开始后不能再改变 200，改发安全的 `stream-error` 后关闭。前端传输层收到明确服务端错误或非法消息会关闭；原生 `error` 不提供 HTTP 状态，C2 必须通过 HTTP 校准判别失效会话、处理重连与兜底，不能把所有连接失败记成生成 FAILED。终态、切换 Run、卸载和退出时由 C2 调用 `close()`；仅服务端 end 不等于浏览器主动 close。

响应设为 `text/event-stream`、`no-store, no-transform` 和 `X-Accel-Buffering: no`，沿用精确 Web Origin + credentials CORS。后续 R07/R17 仍须在部署代理上实测缓冲、空闲超时及断线，不以本机 Header 验证冒充已上线。C2 工程验收已通过，用户真实生成观察与生产链路尚未验收。

### 5.9 R14/C2：页面恢复接入

`plan.vue` 现在只调用 `usePlanRunRecovery(runId)`，不同时运行旧轮询 composable；旧手写文件保留，终态错误文案助手继续复用。数据流是：URL/身份 → composable 选择 Run → driver 发起 HTTP/SSE → 用户 reducer 归并 → 同一份状态驱动页面与 Query 缓存 → driver 按状态清理/重连/兜底。Run 成功后才用它的 planId 加载完整计划；存在 run 参数时不回退到另一个 URL plan 参数，避免访问失败后展示无关计划。

新增阅读仅两处：`apps/web/app/pages/app/plan.vue` 的 composable 调用、同步提示和错误出口；`apps/web/app/composables/use-plan-run-recovery.ts` 的 watch、cache、changed 与 onScopeDispose。无需重新逐行读已通过的 reducer 或整份 driver。连接出错时仍展示已有运行状态，并额外显示通道错误；访问不存在/无权 Run 时停止并清空，不显示一个点击后无作用的刷新按钮。状态提示使用现有 Tailwind 令牌与 polite live region，不引入新视觉体系。

本地观察步骤（9/21 用户已反馈“已观察”；未附逐项现象或具体 Run 记录，不扩写为额外真实模型证据）：

1. 在 `http://127.0.0.1:3000/app/plan` 使用自己的 GitHub 登录。先打开自己已有 Run 的 URL 并刷新，确认结果恢复且不新建任务；不要使用浏览器测试中的合成 UUID。
2. 如需观察生成中的长连接，正常提交一个真实目标。Network 筛选 `plan-generation-runs`：应有 `/events` 和初次/open 校准 GET，但连接稳定时没有持续的周期 GET；完成后 `/events` 被主动关闭。已有终态 Run 可能来不及显示“实时已连接”，直接恢复结果是正确的。
3. 在仍生成时通过 DevTools 将该标签页 Network 切为 Offline（不是断开电脑网络），让本机 Worker 的上游连接继续工作。页面保留已有进度，显示连接/HTTP 问题；恢复 No throttling 后应读到最新状态或结果，不重复创建任务。若 HTTP 也失败会直接降级；仅 SSE 不通而 HTTP 可用时，连接等待上限 10 秒后兜底。进入 polling 后本轮不自动升级 SSE，刷新页面才重建。
4. 离开计划页面或退出登录，确认订阅结束、不继续查询；退出后访问工作台应回登录页。完成后恢复浏览器网络设置。只有确实观察到的行为才记为通过，不能将测试夹具当成本人模型生成记录。

2026-09-18 工程证据：专用手写 10 项、Web 回归 19 项（含 5 项真实 Vue scope/QueryClient + 模拟网络端口测试）、`pnpm check` 207 项常规测试、`pnpm test:integration:r13` 6 项真实 PostgreSQL/HTTP 测试、Web 生产构建均通过。浏览器隔离夹具验证桌面 1440px/手机 390px、连接/加载/空表单/错误/终态、断线降级后读到成功、刷新恢复、旧 Run 通知隔离与鉴权失效跳转；确认无横向溢出，相关操作 44px 高、焦点可见。提示正文 #ccc/黑底、警告 #d4a017/黑底沿用现有高对比令牌。夹具已从浏览器移除，未写业务数据库、未调用模型，也不代表原生网络重连或真实模型观察完成。

真实 SSE 集成测试按既有清理逻辑移除了自己创建的 UUID 测试用户/会话/Run，未删除用户数据。9/21 已恢复 PostgreSQL、Redis 与 Web/API/Worker，readiness 通过；API/Worker 当前以编译后的 start 运行，后端改动需重新构建/重启，Web 保持开发模式。未修改环境文件或凭据。用户观察反馈、接入理解确认与短复述已完成，9/21 复跑手写验收 10/10、Web 回归 19/19 及完整 `pnpm check`（207 项）通过，R14 随本次独立提交记为 DONE；生产代理验证仍属于后续范围。

### 5.10 R05：Webhook 接收主体（签名 Review 通过，尚未接入真实 Webhook）

2026-10-09 入门观察及“验签不负责去重”的理解确认完成，产品接收主体已接入。10/10 主体与本题业务上下文均已由用户复述并确认；用户完成 HMAC 主线，最后的字符集正则由 AI 经明确授权补充，含新增反例的 5 组验收与 Review 已通过。用户在校准后已确认 Delivery/Outbox 回滚使重投可以重新处理，短复述完成；后续消费未完成，仍不要启用 GitHub App 的真实 Webhook、暴露本机端口或使用生产数据。

先看可复现的接收现象，在仓库根目录运行：

```powershell
pnpm test:integration:r05
```

需要 PostgreSQL 与已应用的迁移；不需要 Redis、Worker、模型或真实 GitHub 凭据。测试通过随机本地端口调用完整 AppModule，使用真实数据库与合成用户/仓库：HTTP 成功路径以合成 Secret 签名，经过真实全局守卫、Controller 和 HMAC；其他直接调用 Service 的事务场景使用明确的验签结果替身。观察用例名称：接收成功后有一份 Delivery/Outbox；并发重复和重建 Service 后重投仍各一份；Outbox 写入异常整笔回滚；活动绑定独占；解绑或换人重绑发生在接收过程中则忽略；旧 Delivery 重投不转给新绑定者。只清理测试自身 UUID 记录。共 15 项，包含既有计划 Dispatcher 回归及“新类型不误消费”；不代表真实 GitHub 已投递。

本轮首读仅两个入口：

1. `apps/api/src/webhooks/github-webhook.controller.ts`：接收的是 GitHub 服务器 POST，不依赖浏览器 Cookie；把请求原始 Buffer、签名头、Delivery ID 和事件类型传给 Service。签名不是登录 Token，正文也不能重建为另一个 JSON 字符串替代。
2. `apps/api/src/webhooks/github-webhook.service.ts` 的 `receive()`：前置校验 → 事务插入唯一 Delivery → 按 installation/repository/branch 找到至多一条绑定 `matched` → 锁 User 后复查原绑定得到 `binding` → 接收 Outbox → 提交后 202。同 ID 同正文重投不再执行；同 ID 内容冲突 409；写入异常回滚，不提前承诺 202。

辅助改动无需逐行阅读：`main.ts` 开启 Nest 原始体保留并沿用 100 KiB JSON 上限、拒绝压缩；Module 负责装配数据库与独立 `GITHUB_WEBHOOK_SECRET`；Prisma 新增接收表和 Outbox 类型；现有 Dispatcher 增加类型筛选。超限 413，不截断后继续验签；非 JSON/压缩体 415；无效输入 400；未配置 Secret 为 503。Secret 后续用 32–256 字符独立随机值配置，不使用 OAuth Client secret/私钥、不贴入聊天或源码。

收尾修正的入口边界：Webhook 接收方法使用 `SignedWebhookRoute` 标记，让全局 AuthGuard 仅跳过该入口的浏览器 Origin/会话检查；标记不等于验签通过，Service 仍须先验签再读写数据库。普通 PublicRoute（包括退出登录）的写请求仍检查 Origin，受保护页面 API 仍检查会话。带完整 AppModule 的正反回归已覆盖该区分，避免仅在不带全局守卫的 Controller 夹具中通过。

记录中的 `ACCEPTED/IGNORED` 是**通知接收状态**，不代表任务通过。Delivery 的 body hash 用于辨别同 ID 内容冲突，不替代 HMAC；绑定来自数据库而非 sender。10/9 已收窄为仓库活动绑定独占，由数据库部分唯一索引保证最多一条，而非从多名用户中任取一人。解绑与接收共享 User 行锁，锁后仅复查原绑定身份和条件；中途换人重绑不能将当前通知转交新人。R05 使用 `schemaVersion=1` 的单元素 `bindings` 数组；10/13 R06 新事件升级为 v2，增加接收时的任务快照，见 5.13。历史意图不重写、不按现在的任务补齐归属；绑定重验读取器与消费者接线见 5.12、5.15。

本切片只落库接收意图；`GITHUB_PUSH_RECEIVED` 暂不被计划 Dispatcher 领取。没有创建 Submission/AgentRun、读取 Diff 或调用模型，不能把 202 表述为“验收运行已启动”。按 10/13 已确认的 PRD 12.3，接收只保存上下文与取证待办，后续确认目标变更才原子保存证据与验收处理意图；消费与重复 Push 业务幂等仍需补齐，本中间态不作为完整上线版本。

迁移：`pnpm db:migrate:deploy` 追加 `webhook_deliveries` 表和枚举值，以及 `20261009130000_repository_exclusive_binding` 的活动仓库唯一索引，10/9 均已应用本机；新环境先执行共享包构建/生成客户端并应用迁移，再启动依赖独占约束的新版 API。迁移前本地重复活动仓库数量检查为 0；其他环境若有重复，索引创建会失败，须明确决定冲突处理，不能自动解绑/删除旧记录。索引仅约束 `enabled = true`，不清理停用历史。不使用 reset/drop 回退。若停止此切片，关闭 Webhook 接入、保留表与待处理事件，并保留 Dispatcher 类型过滤；直接退回会消费所有类型的旧 Worker 可能误标新事件为死信。没有生产迁移或回滚演练证据。

工程验证：10/9 收窄后 `pnpm check` 212 项常规测试、R05 15 项集成、R04 23 项集成通过；同日 R13 6 项证据保留。10/10 签名修正后专用验收 5/5 与完整工程检查通过；收尾发现全局守卫遗漏后，新增的 AppModule 用例先复现 2 failed / 6 passed，修正后 Webhook 常规回归 8/8、带签名 HTTP 的 R05 集成 15/15、R04 集成 23/23、R13 集成 6/6 通过。最终完整 `pnpm check` 通过（44 文件 / 215 项常规测试，含新增 3 项），状态随本地提交生效，见主计划。所有凭据/仓库为测试合成数据，不以本地验收冒充真实 GitHub 投递或上线。

依据：[Nest 原始请求体](https://docs.nestjs.com/faq/raw-body)、[GitHub 签名校验与公开测试向量](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)、[Delivery ID 与重投](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks#use-the-x-github-delivery-header)。

#### R05 HMAC 小手写

2026-10-10 已完成业务上下文导读与理解确认；目标编码 25 至 35 分钟，不新增另一份练习。唯一实现位置：[github-webhook-signature.exercise.ts](../apps/api/src/webhooks/github-webhook-signature.exercise.ts)。配套测试、Controller、Service、事务和 Outbox 不需要修改。

背景与接口：外部可提交伪造的 Push JSON，Service 在解析正文、写数据库前调用 `verifyGitHubWebhookSignature(input: GitHubSignatureInput): boolean`。`rawBody: Buffer` 是原始字节，`signature: string | undefined` 是 Controller 提取的签名头，`secret: string` 来自服务端配置；不是整个 request，也不从本次请求取 Secret。函数只判断签名是否可信，返回 false 由 Service 统一转 401，返回 true 才继续业务校验。重复的真实通知仍可验签通过，Delivery 去重由既有事务负责。

不变量与完成边界：

- 使用标准 HMAC-SHA256；只对传入的原始字节验证，不解析 JSON、不重新序列化、不修改 Buffer，也不自行拼接密钥代替 HMAC。
- 签名格式是 `sha256=` 后恰好 64 个十六进制字符；缺失、错误算法、逗号拼接的多值、空白/换行、多余字符或非十六进制内容均拒绝。不裁剪或修复畸形签名后放行。
- 空 Secret、签名不匹配返回 false；这些预期的无效输入不能使函数抛出异常。线上 Secret 长度门槛属于配置层，本纯函数不重复施加 32 字符限制，官方公开测试密钥不代表生产配置。
- 摘要比较使用 `node:crypto` 的 `timingSafeEqual`，不使用普通字符串相等或自行逐字符比较。该 API 接受字节数据且要求等长，否则会抛错；Review 会检查这个安全前提，不只看测试是否全绿。
- 不访问数据库、队列、会话、环境变量或网络，不打印 Secret、正文或签名，不添加去重缓存。

既有 [5 组黑盒验收](../apps/api/test/github-webhook-signature.acceptance.ts)：合法公开签名通过且正文不被修改；正文变化（含空白/中文）被拒绝；错误/空密钥被拒绝；缺失或畸形签名被拒绝且不抛错；格式合法但内容错误的签名被拒绝。测试使用 `Hello, World!` 是为了单独验证字节签名，不代表它是合法 Push JSON；不要把 Service 的 JSON 校验搬进本函数。

在仓库根目录运行，不需要 WSL、数据库、Redis、模型或真实凭据：

```powershell
pnpm test:handwrite:r05-signature
```

10/10 交付基线为 1 failed / 4 passed：占位函数始终返回 false，拒绝类用例因此通过，并非已经完成 80%。用户写完后再 Review 与关联回归，不修改测试绕过失败。

10/10 初版 Review：HMAC 计算与等长安全比较的方向正确，但前缀截取残留等号导致合法输入失败；还需补齐完整签名格式检查及明确拒绝空 Secret。三项均沿用本题既有要求，由用户修正；测试没有新增或放宽，当前尚未通过 Review。不要将初版的四项通过当作所有拒绝边界已验证。

10/10 第二次 Review：前缀与空 Secret 已修正，原 5/5 全绿；只读复现将公开签名中的摘要字符 `7` 换成 `\u0137`（总长度不变）后，用户函数仍返回 true。本机 hex 解码可能接受这种非 ASCII 字符，故“长度正确”不等于“所有字符属于十六进制”。需在解码前落实既有字符集要求，不新增业务或要求重写主线；原验收文件与用户代码未被 AI 修改，仍待本边界修正后复审。

10/10 最终辅助修正：用户明确授权 AI 补正则，新增解码前的 ASCII 十六进制格式检查，HMAC 与安全比较主线保留。先将上述反例加入原畸形输入组，确认能复现失败，再修正至 5/5 通过；合法组同时检查大写摘要可用。Review 无剩余 blocking，工程检查通过；进入 R05 短复述，尚未提交或记为 DONE。该正则及新增回归为 AI 辅助，不记作用户独立手写。

10/10 收尾复述：初次将 Delivery 当作可独立保留的请求记录，经说明“保留去重凭据会让重投直接返回”后，用户确认回滚后表中无该记录，因此可以重新处理。短复述通过，已报告本单元累计约 1.5 小时（含手写约 45 分钟）；不追加练习，完成状态与本地提交以主计划为准。

按需看分层提示，不要求现在全部展开：

- 提示 1（职责）：本题不需要识别事件类型或仓库；测试正文可以不是 JSON。原始体已经是 Buffer，不必重建。
- 提示 2（API）：不要求手写密码学算法；查 Node 的 [createHmac](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptocreatehmacalgorithm-key-options) 与 `Hmac.update` / `Hmac.digest` 的参数和返回类型即可。
- 提示 3（格式与安全）：十六进制文本和它表示的字节不是同一种数据；查 [timingSafeEqual](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptotimingsafeequala-b) 的输入类型及等长要求。它不代替签名头格式校验；针对具体卡点再提问，不靠逐个 failed 猜业务。

25 至 35 分钟目标内卡住可以直接报告位置；预计超过 45 分钟先停下来缩小机械工作，不继续盲试。本题不需要先启动真实 Webhook，完成后反馈“写完了”、验收结果和大致耗时即可。

### 5.11 R06：固定提交证据读取器（首段导读）

10/12 在用户理解固定 Commit SHA 后，先交付 `apps/worker/src/github/read-commit-evidence.ts`。不新增手写，仍计入 R06 原约 4 小时、分时段预算。首轮只读 `readCommitEvidence` 的输入/返回类型及函数内四段业务注释，不要求逐行阅读配套防护和测试。

用途：拿到一个已选仓库和目标路径，收集**指定提交**的 Markdown 证据，为后续验收提供可追溯输入。输入为 `githubRepositoryId`、`beforeCommitSha`、`afterCommitSha`、`targetPath`；另由服务端调用方提供限仓库的安装 Token。消费者负责从持久化 Webhook/任务取输入并复查绑定；本函数不查询用户、创建 Run、写库、改 Task 状态或调用模型。10/14 正式消费者已装配（见 5.15）；隔离测试与临时公开 smoke 是额外观察入口。

函数四段：根据绑定的仓库 ID 获取规范名称；比较固定 before/after 并检查目标路径；正常文件按 after 读取，删除文件按 before 读取并标记 removed；返回来源 SHA、完整正文、原字节 SHA-256、行数和 Diff。普通 `.md` 路径精确匹配，未改目标/没有 Markdown 返回 IGNORED，目标移走返回 TARGET_RENAMED；不会擅自修改用户选择的目标路径。

历史观察证据见 [Worker Playground](../apps/worker/playground/README.md)。两个临时源码已于 10/20 单元收尾时清理；公开样本真实 API smoke 曾返回 COLLECTED / README.md / added / 9 行 / 799 个 Diff 字符，不接数据库或队列。COLLECTED **不是**任务验收通过，也不是已保存 Evidence。该 smoke 明确移除认证头访问公开资源，不验证安装授权；正式函数没有自动匿名回退，当前可重复验证使用下方正式测试。

可重复的工程验证无需凭据或基础设施：

```powershell
pnpm exec vitest run apps/worker/test/read-commit-evidence.spec.ts --reporter=verbose
```

43 项上游替身测试覆盖分支推进后仍读固定 SHA、删除前证据、未匹配/重命名、完整性与超限、路径编码、来源不一致、404 不回退到 main，以及错误不包含 Token/上游原文。配套 `github-evidence-http.ts` 只负责固定主机请求、总 20 秒超时、拒绝重定向、逐块限制响应为 2 MiB 和安全错误；不重复实现 GitHub 登录或安装授权。

读取器默认限制改动文件 100 个、Markdown 文件 20 个、目标文件 64 KiB、返回 Diff 总量 128,000 字符，可由服务端调用选项收紧/调整；文件数硬上限小于 Compare 的 300 个返回上限，避免将截断当成“目标未改变”。缺失或增删计数不完整的目标 patch 明确失败，不以空 Diff 冒充成功。GitHub Blob SHA 用于核对上游返回的文件身份，不等同于提交 SHA 或本项目保存的 SHA-256 内容哈希。接口依据：[Compare](https://docs.github.com/en/rest/commits/commits#compare-two-commits)、[Contents ref](https://docs.github.com/en/rest/repos/contents#get-repository-content)。

后续已补：10/13 按需安装 Token 与绑定重验见 5.12，10/14 Submission/Evidence/Run/Outbox 原子落库见 5.14，队列/消费者装配见 5.15。10/15 分叉/回退历史改为两端快照直接比较，见 5.16，不再将 merge-base 不同本身作为 UNSUPPORTED_COMPARISON 拒绝理由。全零基准或必需快照不可读时要求 RESYNC_REQUIRED；完整失败展示、真实 Push 仍未验证，不将这些暂时边界视为用户已同意裁剪、R06 完成或生产能力。

### 5.12 R06：后台取证授权与绑定重验

10/13 用户已复述并确认 5.11 读取器理解。本轮只学习“谁有权读取这次证据”，不新增手写，不另加预算。首轮入口按顺序为：

1. `apps/worker/src/github/read-bound-commit-evidence.ts` 的 `BoundCommitEvidenceReader.read`：本项目的绑定是否还有效，以及取证结果是否还能继续使用。
2. `packages/github/src/app-auth.ts` 的 `createGitHubRepositoryAccess`：用 App 身份核对安装并向 GitHub 申请单仓库只读 Token。JWT 签名细节沿用 R04，不要求重读。

输入上下文：消费者从已持久化接收记录取得 `repositoryId / userId / repositoryVersion` 和 Push 的安装、GitHub 仓库、分支、before/after；v2 接收上下文已保存 taskId/任务版本/targetPath，见 5.13。repositoryId 是本项目的绑定 UUID，githubRepositoryId 是 GitHub 仓库 ID；repositoryVersion 是 User 上的绑定版本。不是浏览器随意传入这些值即可读取。10/14 Dispatcher/Job 与该读取入口的 Runtime 装配见 5.15。

一次正常调用：复核数据库绑定 → App 私钥签发短期 JWT → GitHub 核对安装并签发限仓只读 Token → 再查绑定 → 已有读取器按固定 SHA 取正文/Diff → 返回前再查绑定 → COLLECTED 或读取器原有 IGNORED。App JWT 表示应用身份，安装 Token 才用于后续仓库读取；它们都不是用户的登录 Cookie，不需要用户一直在线，也不依赖 API 内存中的用户 OAuth Token。安装 Token 按需签发、不缓存到数据库；同一个 `@knowledgeops/github` 包也供 API 的 R04 绑定流程复用，避免两套签名/授权规则。

关键失败场景：接收时绑定 A 版本 3，排队时用户解绑或重绑为 B，旧命令仍指向 A/3，返回 IGNORED/BINDING_CHANGED，不将任务转给 B；若解绑发生在申请 Token 时，不继续读取仓库；发生在取正文时，丢弃已读结果，不返回 Evidence。安装失效、Token 签发失败或响应不可信时安全报错，不扩权限、不用用户 Token/PAT 或匿名读取兜底。

边界：网络期间不持有数据库事务/锁，不能撤回已经发出的 GitHub 请求。这些前后复查只保护读取结果，**后续落库事务仍须锁 User 并再次核对绑定身份/版本**，否则返回后到写库前仍有竞态。COLLECTED 不等于数据库已保存、不等于验收通过。

先观察无需服务/真实凭据的合成场景（27 项）：

```powershell
pnpm exec vitest run apps/worker/test/read-bound-commit-evidence.spec.ts --reporter=verbose
```

关注前三类现象：有效绑定返回 COLLECTED；开始前已解绑不加载私钥、不请求 GitHub；签发/取证途中解绑不返回有效证据。测试执行真实授权、HTTP 适配及固定 SHA 读取函数，只有数据库、GitHub 响应和私钥输入是替身，不是产品页面或真实私有仓库观察。

真实集成验证（授权保护 12 项、5.13 接收 30 项、5.14 原子落库 36 项及 5.15 队列消费 14 项，共 92 项；全套需要 PostgreSQL 和 Redis，不需要真实 GitHub 凭据）：

```powershell
pnpm test:integration:r06
```

该套只创建并清理自己的随机标识用户/绑定/任务，检查实际 Prisma 查询能拦住身份、版本、安装、仓库、分支不符以及同仓库重绑；GitHub 仍为合成上游。10/13 上述验证通过，R04 23 项集成的前次证据保留，不据此宣称真实安装权限/生产投递已验证。

配置复用 `GITHUB_APP_CLIENT_ID` 与绝对路径 `GITHUB_APP_PRIVATE_KEY_PATH`；Worker 不需要 OAuth Client Secret。两字段保持可选，未配置时已有计划生成不受影响，主动取证才安全失败；根目录开发命令会给 API/Worker 加载同一 `.env`。本地消费者已装配；部署私钥挂载和真实推送仍待验证，不修改任何真实凭据。接口依据：[安装 Token 与限仓权限](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)、[App JWT](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)。

### 5.13 R06：接收时固化当前任务（两段式方案的第一段）

10/13 用户明确批准新方案：先可靠接收，后台比较后再创建验收运行。本轮仅交付接收端，不新增手写；导读计入 R06 原预算。两个入口按阅读顺序为：

1. `apps/api/src/webhooks/github-webhook.service.ts` 的第 4 段：锁定绑定用户后，从其 ACTIVE 计划查找唯一当前任务，保存任务 ID/版本/目标路径；没有任务、任务不唯一或路径无效时，只记录明确原因。先前的验签、Delivery 去重和绑定复查无需重新逐行阅读。
2. `packages/contracts/src/events/github-push.ts`：取证 Outbox 的 v2 数据格式，`binding` 来自原绑定，`task` 来自本地任务；Webhook 中伪造的 taskId/targetPath 不会覆盖它们。schemaVersion 是事件格式版本，repositoryVersion 和 taskVersion 分别是绑定、任务的业务版本，不能混用。

“当前任务”复用开始任务时占用单一学习位置的四个状态：IN_PROGRESS、VERIFYING、NEEDS_REVISION、NEEDS_EVIDENCE；抽成共享常量，未改变开始任务的规则。接收时不推任务状态、不创建 Submission/AgentRun、不发起 GitHub 请求。GitHub 原始最小 Push 信息仍在 Delivery，任务/绑定上下文在同事务的 Outbox payload；后续消费者将读取这两者，而非重新寻找当时不存在的“当前任务”。

运行 `pnpm test:integration:r06` 可观察：合成签名 HTTP 返回 202 后，Delivery 和 v2 Outbox 已在真实 PostgreSQL 中、任务快照已固定、AgentRun 数量仍为 0；重复 Delivery 在用户换任务后仍保持第一次上下文；写 Outbox 失败则回滚新 Delivery。R06 共 42 项通过，其中接收 30 项、后台授权保护 12 项。仅使用测试随机标识，测试结束清理自己的数据；不是 GitHub 真实投递或用户亲自观察的证据。

历史 v1 意图原样保留，重投不会升级它们；不得用当前任务自动补齐旧快照。10/13 交付本接收切片时 Dispatcher 只消费计划生成，未接消费者/落库，也无数据库迁移或服务启动；后续落库见 5.14，队列接入及 v1 待办的明确 dead-letter 原因见 5.15。分叉直接比较与真实 Push 闭环仍未完成，R06 未收尾提交。

工程验证：完整 `pnpm check` 通过（格式、lint、全部 workspace 类型、Prisma 校验、47 文件 / 296 项常规测试），R06 42 项、R05 35 项、原计划生成/任务生命周期 8 项数据库集成通过。R05 的 30 项接收测试也包含在 R06 中，不将重复运行相加成不同场景数。

### 5.14 R06：证据、Run 与验收待办原子落库（10/14，独立测试入口）

本轮一个学习点：取证结束不等于可以直接写库；必须复核原上下文，再把相关记录一起提交。首读仅两个入口：

1. `apps/worker/src/github/finalize-github-push-evidence.ts`：接收原取证 eventId 和读取结果，从数据库恢复接收快照，检查绑定/任务，保存结果。消费者在网络调用结束后调用它，装配见 5.15；本节保留独立数据库测试入口。
2. `prisma/schema.prisma` 的 `Submission` / `Evidence`：Submission 说明哪项任务、哪个绑定、哪次固定提交；Evidence 保存这份提交目标文件的正文、Diff、哈希和来源。AgentRun 引用 Submission，验收 Outbox 只传 Run/Submission ID，不传正文或凭据。

数据库已增量应用 `20261014100000_github_evidence_finalization`。其他环境先 `pnpm db:migrate:deploy` 和 `pnpm build:packages`；不得通过 reset 清空已有记录。观察只需要 PostgreSQL，不需要 Redis、App 私钥或模型服务：

```powershell
pnpm test:integration:r06 apps/worker/test/finalize-github-push-evidence.integration.ts --reporter=verbose
```

本文件 36 项场景，先只关注以下现象，不要求通读测试夹具：

- 正常：Task T1/version 3 的证据通过复核后，生成一份 Submission/Evidence、一个 QUEUED AgentRun、一条验收 Outbox，Task 变成 VERIFYING/version 4；Delivery 标为 PROCESSED 并关联结果。PROCESSED 只指取证交接完成，不是验收通过。
- 失败：模拟 Outbox 或最后一条 Delivery 更新失败，证据/Run/新待办与 Task 修改全部回滚；原接收 Delivery/取证待办仍保留，允许后续重试。
- 重复/过期：同 Delivery 并发或不同 Delivery 指向同一绑定/任务/after Commit/流程版本，只产生一份有效结果；原绑定、目标路径、任务版本或归属变化时保存忽略原因，不改派其他任务。
- 删除：保存 before 正文及 removed 标记，不创建语义验收 Run；Task 增加版本使旧证据失效，若原在 VERIFYING 则恢复前一运行记录的稳定状态，不直接判失败。普通新证据遇到 VERIFYING 时同样继承稳定恢复目标，而不是把 VERIFYING 作为失败后的恢复状态。

实现边界：本函数不调用 GitHub、不在事务中等待网络、不完成语义验收。新 Run 持久化 expectedTaskVersion，未来验收消费者/终态写入必须检查它；目前没有真实旧 Run 执行与终止演示。同一任务版本的两个不同提交竞争时，仅先成功落库者生效，另一个记 TASK_CHANGED，不声称做了 Commit 时间排序。历史 v1 缺少任务快照时拒绝，不查询当前任务补造历史上下文。

收到 IGNORED 的原因已存库，但受权查询和页面展示尚未实现；取证异常记录和有界重试见 5.15。Dispatcher 已可路由计划生成与 GitHub 取证，新验收 Outbox 仍保留待后续验收消费者接线，不能把测试当作真实 Push → Worker → 报告已经接通。

本原子落库切片交付时完整 `pnpm check` 通过（303 常规测试）；当时 R06 全套 78 项、R05 35 项、原计划/任务生命周期 8 项通过，共享测试不重复计数。当时只启动 WSL PostgreSQL，未启动 Redis/API/Worker/Web，未调用真实 GitHub/模型或改动凭据。用户后续已确认 Finalizer/模型关系理解，并报告本文件 36 项通过；不重复学习。最新队列验证见下节，R06 尚未完成或提交。

### 5.15 R06：让队列调用已有读取器和 Finalizer（10/14）

本段只学习后台调用编排：原取证 Outbox → Dispatcher → `github-evidence` 队列 → `GitHubEvidenceJobProcessor.process` → 已有读取器 → 已有 Finalizer。先安排约 20 分钟观察/导读，计入 R06 原预算，不增加手写，不要求重读此前的授权和事务实现。

先观察（仅需 PostgreSQL + Redis，不需启动 Web/API/正式 Worker，也不请求 GitHub 或模型）：

```powershell
pnpm test:integration:r06 apps/worker/test/github-evidence-processing.integration.ts --reporter=verbose
```

14 项场景中先看两个：消费者未启动时 Job 留在 wait，启动后才完成落库；第一次上游读取失败，自动重试后只产生一份 Submission/Evidence/Run/验收 Outbox。测试里的 `github_evidence_job_failed` 警告是刻意触发的故障，不等于测试失败，以最终测试结果为准。另有权限失败、耗尽重试、显式恢复、旧失败通知隔离、回滚和历史 v1 拒绝等检查；无需通读夹具。

首读两个入口：

1. `apps/worker/src/github/github-evidence-job-processor.ts` 的 `process`：根据 Job 中的 eventId/deliveryId 读取原接收记录；已有结果直接返回；记录本次尝试，调用读取器，再交给 Finalizer。失败只保存固定错误码，不让私钥、Token、正文或上游原文进入错误/日志。
2. `apps/worker/src/queue/bullmq-github-evidence-queue.ts` 的 `publish` 和 `createGitHubEvidenceBullMqProcessor`：前者按 `evidence-{deliveryId}` 入队，只传两个 ID；后者校验 Job，传入当前尝试信息，将不可重试错误转换为 `UnrecoverableError`。有界次数/指数退避复用原 BULLMQ 配置，未引入新队列框架。协议行为可按需查 [BullMQ 自动重试](https://docs.bullmq.io/guide/retrying-failing-jobs)与[停止重试](https://docs.bullmq.io/patterns/stop-retrying-jobs)。

其余配套只了解职责：Runtime 启停两条队列，现有 Dispatcher 循环按类型路由；Module 注入真实读取器；原子落库终态同时清理此前失败标记；共享连接选项保持原计划生成的设置。计划生成处理器不会接收到取证 Job，`NOTE_VERIFICATION_REQUESTED` 也不会被取证消费者认领，仍等待后续验收实现。

取证尚无 AgentRun 时，Delivery 新增四个字段：

| 字段 | 用途 |
| --- | --- |
| `evidenceAttemptCount` | 数据库累计取证尝试编号；防止旧尝试的失败覆盖新尝试，不是 Task.version |
| `evidenceLastAttemptAt` | 最近开始一次取证的时间 |
| `evidenceLastErrorCode` | 最近一次已记录的安全错误码；成功/忽略后清空 |
| `evidenceFailedAt` | 本次自动尝试停止的时间；下一次显式尝试或完成后清空 |

`ACCEPTED` 只表示通知已接收，不代表取证健康或正在运行。GITHUB_UNAVAILABLE 和未知处理故障做有限重试；权限、不可用来源、非法证据等停止自动重试。失败不改变 Task、不伪造 FAILED AgentRun。记录错误时同时检查 Delivery 尚未终结且尝试编号未变，旧失败不能覆盖已经成功/忽略的结果或较新尝试；该编号不能替代 Finalizer 的绑定、Task 版本和业务幂等检查。

恢复边界：队列保留 completed/failed Job，重复投递相同 Job ID 不等于重试失败 Job。排障后可显式对失败 Job 调用 `retry('failed', { resetAttemptsMade: true, resetAttemptsStarted: true })`；已在本文件的隔离测试验证，仍复查原上下文，不改派新任务。未提供面向用户的重试接口/页面。若进程被强杀、耗尽 stalled 次数，或数据库自身不可写，消费者的 catch 不能保证把最终失败写入 Delivery；需结合保留的 Redis Job 与数据库最近尝试记录排查/显式重试，尚无自动对账补写，也未作进程强杀故障注入验证。不能把普通异常重试测试宣称为所有崩溃场景自愈。

本次已增量应用 `20261014120000_github_evidence_processing`，没有 reset/清库。其他环境先迁移并构建共享包再启动 Worker；启动后会处理已有的 v2 取证待办，v1 则记为 Outbox dead letter，不补造上下文。现有数据库与 Redis 本次检查已在运行，没有另启正式应用、读取/修改真实凭据或调用真实 GitHub。测试只清理自己创建的随机数据库记录和 `r06-evidence-test-*` 隔离队列，不清理正式队列或用户数据。

10/14 工程验证：完整 `pnpm check` 通过（48 文件 / 326 项常规测试），R06 92 项、R05 35 项、原计划/生命周期 8 项通过；共享场景不相加冒充新增数量。10/15 用户确认两个入口导读，并最终明确此处 14 项测试已通过、不用重跑；此前“36项通过”仍属于 5.14 原子落库。短复述中混淆 Outbox 投递与 BullMQ 执行重试，经解释后明确确认理解，完整记录见逐日计划；无需重跑、重读或重复复述。用户报告 R06 累计约 4 小时，原预算已用满而单元尚未收尾；此后分叉比较的小段交付见 5.16，用户新增投入另记。真实签名 GitHub Push、受权失败查询/页面提示及后续验收消费者仍未完成，不将本段标为完整 R06 DONE。

### 5.16 R06：分叉历史也只比较 before → after（10/15）

本段只补原 PRD 15.5，不增加手写，学习目标约 20 至 30 分钟，属于此前累计约 4 小时之后的新增投入。用户在本段学习收尾后报告实际约 30 分钟，R06 累计约 4.5 小时。普通 Compare 路径保留；分叉时的业务问题是：共同祖先与 after 的目标文件相同，不代表 before 与 after 也相同。若旧分支 before 写了“before 的正文”，强制推送后的 after 恢复为共同祖先中的“after 的正文”，共同祖先比较可能没有目标文件，实际本次 Push 却需要记录旧正文被替换。

现在读取两个固定 Commit 的文件树（路径、类型和 Blob 身份的清单），核对完整性并找出真实变化，再仅读取目标正文，生成 before→after Diff。文件树已完整且路径不存在，才可以判断新增/删除；404 不能当空文件，缺失基准也不能改读 main。删除仍保存 before 正文并标记 removed，不作语义验收。返回的 Evidence 结构不变，继续走旧绑定复查与 Finalizer。

只观察两个新场景，不重跑 5.15 的数据库/队列测试；无需 WSL、PostgreSQL、Redis、应用服务或真实凭据：

```powershell
pnpm exec vitest run apps/worker/test/read-commit-snapshots.spec.ts -t "compares actual before|requires resynchronization when Compare" --reporter=verbose
```

预期 2 项通过、其余 44 项跳过：第一项断言 Diff 含 `-before 的正文` 与 `+after 的正文`，且应用 Diff 后恰好得到 after；第二项断言 Compare 与原基准 Commit 都不可读时返回 RESYNC_REQUIRED，不改用当前分支。全部 46 项新测试已由 AI 验证，用户无需通读夹具或为凑数量重复运行全部场景。

只看两个入口：

1. `apps/worker/src/github/read-commit-evidence.ts` 的 Compare 分流处：普通来源保持旧路径；分叉或 Compare 404 转入两端核实，其他权限/限流错误不绕过。
2. `apps/worker/src/github/read-commit-snapshots.ts` 的 `readCommitSnapshots`：核实两端树 → 比较路径与 Blob → 只读目标正文 → 生成有界 Diff 并返回原证据结构。

配套 `readCommitFile` 是从旧读取器提取的共用校验，负责路径、大小、Blob SHA、UTF-8、内容哈希和行号；不需重读。`readTree` 负责 Commit/tree 身份、truncated 与重复路径检查；树清单被截断或响应超限时拒绝整次取证，不按局部清单判目标未改变。保留单次 20 秒请求预算、每响应 2 MiB、变化路径/Markdown 数量、单文件与生成 Diff 限额；Diff 使用已有版本的 diff 8.0.4，并有计算超时/编辑距离上限，不需要学习库内部算法。分叉路径按变化路径保守计数，改名可能占两个路径；只识别唯一且内容不变的改名，其他移动严格按原目标路径的增删处理，不猜测新目标。

失败出口：必需快照或正文不可读为 RESYNC_REQUIRED，消费者沿既有规则记录安全错误码并停止自动重试；不存在“拿最新内容替代后继续验收”。这只是后台可诊断出口，面向用户的查询、提示与手动恢复入口仍待实现。没有真实 Force Push、生产 GitHub 链路或新验收执行能力的声明。

验证证据：快照新测试 46 项 + 原读取器 43 项 + 授权保护 27 项 + 队列适配单测 14 项 = 130 项通过，Worker 类型检查、构建及定向 lint 通过。这里最后 14 项为无 DB/Redis 的单测，与用户先前通过的 14 项集成不同；后者本轮未重跑。未运行完整 pnpm check，未改数据库/凭据或启动常驻服务。实现参考 [GitHub Git trees](https://docs.github.com/en/rest/git/trees#get-a-tree)、[Compare](https://docs.github.com/en/rest/commits/commits#compare-two-commits) 与 [jsdiff](https://github.com/kpdecker/jsdiff#readme)，并核对本地 8.0.4 接口。用户随后已确认业务概念，并报告上述两个定向场景“已运行过，符合预期”（2 passed、44 skipped），不要求重跑；不冒记全部 46 项由用户运行或真实 Force Push 已验证。主函数五步导读后用户明确“读完了。我明白了”，代码阅读理解已确认。短复述曾将正文 404 误判为删除，经区别完整文件清单与读取失败、补充原调用链和错误传播后，用户再次明确理解；保留真实回答与复习点于逐日计划，不记为初次独立全答对。本小段学习收尾，用户报告新增实际用时约 30 分钟，R06 累计约 4.5 小时，保持 WORKING 承接原范围剩余待办；不重读、重跑、提交或将整个 R06 标为 DONE。

### 5.17 R06：无验收 Run 时的取证反馈（只读切片）

本段只解决“后台取证失败，用户去哪里看到”：工作台的“仓库接入”新增“最近取证通知”。只显示**本次绑定已关联学习任务的最近 20 条通知**，包含目标路径、固定 Commit、尝试次数、已保存状态和安全原因。`COLLECTED` 是已取证，不是语义验收通过；`RESYNC_REQUIRED` 是基准不可读，不是笔记不合格。点击“刷新取证记录”只发 GET，不触发 GitHub 读取、队列重试或模型调用。本段学习目标约 20 至 30 分钟，不新增手写。

可观察验证（二选一，无需重跑旧队列测试）：

- 有活动绑定时，启动 Web/API 后访问 `/app/repository`，观察通知区并刷新；没有该绑定的真实通知时显示空状态，不能为看效果伪造真实 Push 记录。
- PostgreSQL 可用时运行下面两个定向集成场景，观察未登录/越权被拒，以及没有 AgentRun 的取证失败仍能返回可展示状态。它们使用随机用户和合成通知，结束仅清理自己的数据，不访问 GitHub/Redis/模型。测试 Outbox 的可投递时间设为远期，避免被开发 Worker 认领。

```powershell
pnpm run test:integration:r06 apps/api/test/repository-evidence.integration.ts -t "projects persisted|requires a session"
```

预期 2 passed、6 skipped。完整新测试 8 项已由 AI 跑过，不要求用户通读测试夹具。

首轮只读两个文件：

1. `apps/api/src/repositories/repository-evidence.service.ts` 的 `list` 和 `visibleState`：先核实活动绑定归属，再按原 Outbox 的 userId/repositoryId 找 Delivery，将保存结果映射为展示状态与白名单原因。只读事务使用同一数据库快照，不加行锁、不改变业务记录。
2. `apps/web/app/components/RepositoryEvidenceStatus.vue`：按用户 ID 和绑定 ID 建 Query key，携带 Cookie 请求；展示加载/空/正常/错误状态，支持手动刷新。换绑或卸载取消旧请求，401 清会话缓存并返回登录页，404 隐藏旧列表并提示刷新绑定。

Controller 负责路由、鉴权和返回契约；`knowledge-ops-api.ts` 复用带 Cookie、超时、AbortSignal 与 Zod 校验的客户端；`repository.vue` 仅接入组件。这些是配套，不需重新逐行阅读。入口是 `GET /repositories/:repositoryId/evidence-deliveries`，其中 repositoryId 是本项目的绑定记录 ID，不是 GitHub 仓库号；仅需本项目登录会话，不需要重新获取 GitHub 用户 Token。

关键失败路径：固定基准不可读 → Processor 已记录 `RESYNC_REQUIRED/evidenceFailedAt` → 查询返回“需要重新同步” → 页面给出原因，不将 Task 改成 FAILED。若本次 GET 自身网络失败，页面显示“未能读取记录”，与后台取证失败分开。等待结果/曾失败标签仅描述数据库记录，不证明 Worker 此刻在线或 Redis 中一定仍有重试任务。

本段交付时的边界：手动重试/重新同步、完整历史列表及验收报告不在本段。接收时就被忽略且未创建任务 Outbox 的 Delivery（例如没有当前任务）没有可靠的历史 owner，本次不按当前仓库归属猜测返回；对应用户反馈后续在 5.22 通过新接收归属补齐，旧的未知归属仍不猜测。强杀或数据库不可写后的结果对账也未因此完成。

工程证据（2026-10-15）：新接口真实 PostgreSQL/HTTP 集成 8 项、客户端 7 项（其中新增 2 项）、API 常规回归 92 项通过；API/Web 类型检查及构建、定向 lint 通过。初版测试夹具不符合 Delivery 状态/失败字段约束，已补齐合法 Submission/处理时间后通过，未修改数据库约束。隔离浏览器使用合成响应验证 1280px 桌面和 375px 手机布局、长路径换行、44px 按钮、键盘可见焦点、加载/空/网络失败/404/401、换绑中止旧请求；正文/辅助/警告文字在黑底对比度均超过 4.5:1。模拟设备时浏览器重载导致一次夹具丢失，重新注入后完成手机验证；不作为真实登录/Push 证据。Web 构建有上游依赖 DEP0155 弃用提示但退出码为 0。

未运行完整 `pnpm check`，未重跑用户已通过的 14 项队列集成，未修改凭据或数据库结构。临时 Web 预览和隔离浏览器页验证后已关闭，未启动 API/Worker 常驻进程；仅清理随机测试数据，无既有业务记录删除。随后用户完成后端主链路复述，并确认对活动绑定及只读展示状态的校准；前端导读与 AbortSignal 追问讲解后明确理解，后续准确区分“取证 FAILED 展示取证失败”与“GET 断网展示请求失败”，本段短复述通过。用户补充本段约 25 分钟、用例已运行，按上述两个定向观察场景记录运行反馈，不补造具体通过统计或真实页面/Push 证据，也不要求重跑。本小段学习收尾，R06 返回 WORKING 承接剩余待办，累计约 4 小时 55 分钟；下一小段先厘清取证失败的重试/重新同步边界，本轮不启动实现。此次进度同步不改产品代码、不重跑测试，不提交或标记整个单元完成。

### 5.18 R06：普通失败的手动取证恢复

用户已确认“原材料重试”和“缺基准重新同步”的区别，本段只接普通失败。仓库页中，原绑定/任务仍有效且允许重试的失败通知显示“重试取证”。刷新记录仍只是 GET；只有按钮提交 POST。`RESYNC_REQUIRED`、任务/路径/版本已变、正在尝试或已有结果不提供这个恢复入口。

可观察一个新增用例（需要 PostgreSQL/Redis，不访问真实 GitHub 或模型）：

```powershell
pnpm run test:integration:r06 apps/worker/test/github-evidence-processing.integration.ts -t "recovers a retained failed BullMQ"
```

预期 1 passed、20 skipped：先故意使原 Job 取证失败并保留，再提交恢复请求；模拟“已入队但投递确认丢失”后补投，仍只完成一次取证、保存一份 Submission/AgentRun。日志里的首次 failed 是设计的故障场景，不是用例失败。旧 14 项队列集成不需重跑。合成用户、记录和随机测试队列会在结束后清理，测试 Outbox 的 availableAt 设为远期避免被开发 Worker 认领。

首读两个入口，学习目标约 20 至 30 分钟，不新增手写：

1. `apps/api/src/repositories/repository-evidence-retry.service.ts` 的 `retry`：登录身份来自 Controller；先锁 User、核对原绑定/接收记录，再锁 Delivery。同一失败尝试次数生成唯一恢复键，重复点击返回旧请求；只有仍有效的原任务和允许恢复的最终取证失败才能创建新 Outbox。保存上轮失败依据及当前恢复请求指针同事务，提交后 202，不改 Task、不创建验收 Run、不访问 GitHub/Redis。
2. `apps/web/app/components/RepositoryEvidenceStatus.vue` 的 `retry` / `requestRetry`：发送所见 `attemptCount`，提交期间禁用，受理后重新读取数据库结果；不乐观显示取证成功。POST 网络失败意味着未确认受理，不意味着取证失败；409 提示资格/状态变化，401 清会话。换绑/卸载后的迟到命令响应不污染新页面。

Worker 复用已读链路，只补看 `github-evidence-job-processor.ts` 的 `retryEventId` 检查：恢复 Outbox 指向原接收 Outbox，Queue 传原 eventId/deliveryId 加 retryEventId，新 Job ID 为 `evidence-{deliveryId}-retry-{retryEventId}`；仍使用原绑定、任务、路径、before/after。Delivery 指针同时用于开始尝试、失败更新与 Finalizer 落库检查，旧请求迟到不能写结果。原绑定/任务的最终复核及成功原子落库不变。`expectedAttemptCount` 用于重复点击/失败快照校验，`retryEventId` 用于区分恢复请求，二者都不是 Task.version 或 AgentRun.version。

配套文件只需知道职责：Controller/契约校验入参及 202，Dispatcher 认领新增事件，队列适配复用原取证队列；只读查询批量核对原任务以决定按钮资格，但 POST 仍在锁内复核。保留旧失败 Job 和恢复 Outbox 的失败依据；不实现无限自动恢复、重建缺失基准、Redis 丢失后的全部对账或模型验收消费者。

工程验证（2026-10-15）：真实 PostgreSQL/HTTP 16 项（原 8 + 新 8）、新增 PostgreSQL/Redis 恢复集成 7 项、相关纯单测 60 项通过；旧 14 项队列集成本轮跳过。API/Worker/Web 类型检查与构建、定向 lint/格式及 Prisma 校验通过，未跑完整 pnpm check。类型检查发现精确可选字段及跨应用集成测试 rootDir 问题后已修正；Worker 仅移除 noEmit 检查配置的 rootDir，生产构建仍限定 src，没有放宽 strict。Web 构建保留上游 DEP0155 警告，退出码 0。

隔离浏览器用合成响应验证 1280px 桌面/375px 窄屏、长路径无横向溢出、44px 按钮、键盘可见焦点（2px）、正常正文对比度最低约 7.37:1，以及加载、空、提交中、受理、POST 网络失败/409/401、GET 网络失败和换绑后旧 POST 401 不影响新页面。首次窗口 resize 实际只能到 501px，随后用 viewport 模拟并确认 innerWidth=375 完成窄屏检查。不把模拟响应记为真实登录或 GitHub Push 验收。

增量迁移 `20261015100000_github_evidence_retry` 已应用本地数据库，仅增加恢复事件类型与 Delivery 指针，无 reset 或凭据修改。其他环境先执行 `pnpm db:migrate:deploy`、重建共享包并重启 API/Worker/Web，再使用新契约。临时 4310 Web 预览和隔离浏览器页已关闭，未启动 API/Worker 常驻服务；既有业务数据未删除。本段进入 WALKTHROUGH，用户代码观察、导读、复述及实际用时待反馈；R06/M3 不标 DONE、不提交。

2026-10-16 学习进度更新：API 事务、前端 mutation/旧响应隔离和 Worker 恢复请求身份保护的导读理解已确认，Outbox/Job 字段归属及保留原记录的取舍经追问校准。本段转 RECALL，只补一个旧轮次结果隔离场景；上方新增用例的用户运行反馈、短复述及本段实际用时仍待补充，不要求重跑已完成的旧 14 项集成。当前仅更新文档，不新增实现或验证证据，不将整个 R06/M3 标记完成。

同日收尾反馈：用户准确说明，旧任务落库、创建 AgentRun 前需匹配 Delivery 当前 evidenceRetryEventId，不一致即拒绝，短复述通过。用户报告本段约 20 分钟、上方新增用例已运行；未报告具体统计，不补造通过数或真实 Push 观察，不重跑。结合既有工程验证与导读确认，本小段学习收尾，R06 返回 WORKING，累计约 5 小时 15 分钟。下一段先厘清 RESYNC_REQUIRED 手动重新同步的基准与证据语义；本轮仅同步文档，不新增实现、运行测试或提交，整个 R06/M3 仍未完成。

后续业务确认（2026-10-16）：单点快照重新同步固定原 after Commit 与原任务路径；用户主动发起时允许免检 FILE_CHANGED，但不伪造 Diff，也不降低正文与必答追问标准。定义已同步 PRD 10.2/15.5；随后实现及观察见 5.19，上方普通重试命令不能被当作此功能的验证，已完成用例不要求用户重跑。

### 5.19 R06 显式全文快照重新同步（2026-10-16）

本段只学一个区别：两端比较能证明变化，单点快照只能证明原提交中的内容；用户显式重新同步后，后者也可以进入后续验收。不新增手写，学习目标约 20 至 30 分钟，实际投入待反馈。

先观察一个新增场景（真实 PostgreSQL/Redis，GitHub 响应是合成夹具；不需要真实 Force Push 或配置新的凭据）：

```powershell
pnpm run test:integration:r06 apps/worker/test/github-evidence-processing.integration.ts -t "recovers a missing baseline"
```

预期 1 passed、35 skipped。初次 Job 的失败日志是测试主动模拟旧基准不可读取，不是实现故障；随后恢复 Job 完成，断言确认 Evidence 为 SNAPSHOT、固定原 after、change/diff 为 null、只有一个 QUEUED 验收 Run、Task 仍为 VERIFYING 而非 PASSED。这个用例不验证 M4 的正文或追问质量；先前旧队列/普通重试观察无需重跑。

导读顺序只看三个入口的新分支，不重读整套事务：

1. `apps/worker/src/github/read-commit-snapshots.ts` 的 `readTargetFileSnapshot`：由原 Reader 根据持久化模式调用，核实原 after 的树和目标文件，再读完整正文；未读到文件是失败，不是删除或空正文。
2. `apps/api/src/repositories/repository-evidence-retry.service.ts` 的 `resync/request`：只对需要重新同步且原绑定/任务仍有效的最终失败受理；复用原恢复请求去重和指针，将 SNAPSHOT 冻结在 Outbox。此模式随后遇到可重试失败，普通 retry 也必须保留它。
3. `apps/worker/src/github/finalize-github-push-evidence.ts` 的模式检查与 Evidence 创建：持锁后读取当前恢复请求，不允许 Reader 自行切换模式；合法快照才和 Submission、QUEUED Run、验收 Outbox 原子落库。

配套变化：恢复事件 v2 显式保存 evidenceMode，v1 严格兼容为 DIFF；队列仍只传 ID，Processor 从数据库取得模式再传给授权 Reader。仓库页面新增“按本次提交全文重新同步”，复用原 mutation、Cookie/Origin 保护和迟到响应隔离；GET 返回 canResync 并展示已保存的真实证据模式，不把 202、快照保存和验收通过混为一谈。模式即固定的 FILE_CHANGED 免检依据，不提供任意标准豁免；M4 仍须按该依据执行正文与追问规则。

关键失败：原 after 或目标正文也不可读时，不创建 Submission/AgentRun；等待期间原任务/绑定改变或恢复请求已换轮时，不让旧结果写入。普通 Push 无变化仍忽略，不自动转快照；不重建历史、不改用最新分支、不重新选择任务。

工程验证：快照新增集成 24 项、API 相关旧回归 16 项，共 40 项；定向纯测试 190 项，API/Worker/Web typecheck/build、lint/格式、Prisma 校验通过。浏览器隔离合成响应覆盖 1280px/375px、44px/焦点/对比度、受理/重复点击/取证结果及网络、401/404/409、空/加载和换绑旧响应。全部不是生产、真实 GitHub 推送或模型验收证据，未跑全量 pnpm check。

迁移 `20261016100000_github_evidence_snapshot` 已应用本地数据库，无 reset；其他环境需 `pnpm db:migrate:deploy`、`pnpm build:packages` 并重启 API/Worker/Web，避免新旧契约混用。既有证据默认 DIFF，新模式由数据库约束要求 change/diff/previousPath 均为 null，不改写旧证据。2026-10-16 用户已确认三个增量入口及重新同步触发条件的理解，短复述通过；10/17 补充“用例已运行，本段用时 15 分钟”，未提供具体统计，不补造用户通过数或真实 Push 观察，不要求重跑。本小段学习收尾，R06 返回 WORKING、累计约 5 小时 30 分钟；本轮只同步进度，不修改产品、重跑测试或提交，真实 Push 等剩余范围未闭环，整个 R06/M3 不标 DONE。

### 5.20 R06 真实 Push：前置准备（2026-10-17，尚未完成真实观察）

本段复用已理解的链路，目标是让真实 GitHub Push 经验签、任务快照、队列和固定 Commit 取证后产生 Evidence 与一个 QUEUED 验收 Run；不验证模型验收或任务通过，不新增手写或 SSE。学习观察目标约 20 至 30 分钟，实际环境准备时间待反馈。

10/17 用户启动 WSL 后，`pnpm infra:check` 已通过，R06 增量迁移已应用。只读检查发现当前绑定有效且分支为 main，但绑定用户的计划仍是 DRAFT，没有已开始的任务。先在产品页面确认并激活原计划，再从 `/app/today` 进入一个 READY 任务，填写将要提交的 Markdown 相对路径并点击“开始任务”；不能仅有仓库绑定就推送，也不直接改库制造当前任务。

Web/API/Worker 现已分别启动。独立启动方式如下，每条常驻命令放在各自终端；先检查端口及 Worker 进程，已有服务时不要重复启动：

```powershell
# 仓库根目录：构建共享依赖、API 与 Worker。
pnpm build:packages
pnpm --filter @knowledgeops/api build
pnpm --filter @knowledgeops/worker build

# 仓库根目录的独立 API 终端。
node --env-file=.env apps/api/dist/main.js

# 仓库根目录的独立 Worker 终端；生成新计划及后台取证都需要它。
node --env-file=.env apps/worker/dist/main.js

# apps/web 目录的独立 Web 终端；此绝对路径仅对应当前本地工作区。
node --env-file=D:/project/agent/.env node_modules/nuxt/bin/nuxt.mjs dev --host 127.0.0.1 --port 3000
```

本次 `/health/ready` 与 `/login` 均返回 200；这是本地就绪检查，不是登录成功或 GitHub 投递的证据，也不代表 Worker 正在消费。最初仅为确认已有草稿启动 Web/API；用户新生成请求因缺少 Worker 停在 QUEUED。现已独立补启动 Worker，旧请求超过三分钟期限，按原超时扫描转为 TIMED_OUT，Processor 跳过终态而未调用模型。刷新后可由用户显式“创建关联重试”，或继续使用已有草稿；不能强行续跑过期 Run。曾误由 dotenv/pnpm 嵌套命令触发根 dev，已停止该进程组并清理，数据库审计无该时段新增投递/取证/验收处理；这里使用直接入口，避免为单独启动 Web 而启动整套应用。

真实 Push 前仍需完成：原任务已经开始且目标路径确定；本地 `GITHUB_WEBHOOK_SECRET` 与 GitHub App 的 Secret 一致；GitHub 能访问的接收/转发入口指向本机 `POST /webhooks/github`；App 的 Webhook 启用、Push 订阅及安装权限匹配。当前仅确认 App 配置存在、私钥文件存在，Secret 尚未配置，公网入口未确认；不要在聊天、文档或提交中粘贴 Secret/私钥。尚未建立公网转发、修改 GitHub 设置或发起真实推送，待上述条件满足后再观察；若更新环境配置，需重启读取该配置的对应服务。已有合成测试和快照恢复用例不要求重跑。

### 5.21 R06 Webhook：真实 Push 已取证并交接待验收（2026-10-18）

本节更新 5.20 的环境快照：用户已在产品页面开始 Markdown 任务，数据库确认计划 ACTIVE、任务 IN_PROGRESS、目标路径已保存、main 绑定启用；已完成本地 Secret、GitHub App Webhook 与 Smee 转发配置并报告已连接。只读检查确认 Smee 进程在运行；原三个应用均已停止，本次重建共享包/API/Worker 并用 5.20 的独立命令补启动 Web、API、Worker，未重复启动转发进程。API 健康检查与 Web 登录页均 200，Worker runtime_started；没有新增实现或重跑已完成用例。

安全检查仅输出配置是否存在/有效，不输出 Secret、私钥、JWT、Smee 通道地址或真实请求正文。GitHub 只读查询确认 Push 订阅、Contents read、Smee HTTPS/JSON、TLS 校验及远端 Secret 已设置；本地无签名 POST 返回 401 / WEBHOOK_SIGNATURE_INVALID。后者是拒绝探测，不会写 Delivery，也不代表正确签名已经通过。Smee 仅用于已告知风险的非敏感开发调试，正式上线使用受控公网 HTTPS 接口。

本次真实 ping 的验证步骤（已完成，保留供复现）：

1. 保持用户的 Smee 转发终端开启，目标应为 `http://127.0.0.1:4000/webhooks/github`。
2. 打开 GitHub App 的 Edit → Advanced → Recent deliveries，选择 `X-GitHub-Event: ping` 的记录，点击 Redeliver；不是重投旧 Push，也不在仓库另建 Webhook。操作路径见 [GitHub 官方说明](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/redelivering-webhooks#redelivering-github-app-webhooks)。
3. 观察 Smee 终端本机 POST 的状态码，预期 202，再核对数据库有同一 Delivery ID 的 ping / IGNORED / EVENT_UNSUPPORTED。项目只处理 push，因此合法 ping 不创建 Outbox、验收 Run 或改变 Task。
4. GitHub 的 200 只证明中转服务收到了请求；本机 202 与对应 Delivery 才是最后一段接收/验签证据。若 401，检查两端 Secret 及原始正文转发；若 503，检查 API 是否加载配置及数据库可用性，不关闭验签绕过问题。

用户重投后反馈“本机收到了”：API 日志确认 POST /webhooks/github 返回 202，数据库存在同一 GitHub ping Delivery，状态 IGNORED / EVENT_UNSUPPORTED；没有取证 Outbox、Submission 或验收 Run，原任务仍为 IN_PROGRESS / version 2。真实 ping 的本机验签与接收落库已验证，替代此前“本地 Delivery 为空”的环境快照；它未关联任务 Outbox，不显示在仓库页的取证列表中。尚不能宣称真实 Push 或 R06/M3 完成；未由 AI 修改 GitHub 配置、重投通知或发起模型调用，新增用户用时仍待反馈。

真实 Push 的操作：由用户在已绑定的学习仓库（不是 KnowledgeOps Agent 代码仓库）的现有 main 分支，对任务详情记录的目标 Markdown 路径新增或追加少量非敏感笔记，普通 commit + Push 一次；保留已有内容，不空提交、不强推、不切换绑定或目标路径。保持 Smee、API 和 Worker 运行，在 `/app/repository` 的“最近取证通知”点击“刷新取证记录”。预期出现“已取证”，再核对固定提交的 Evidence、VERIFYING 任务与 QUEUED 验收 Run；这不是任务通过，M4 的正文验收消费尚未接入。若失败，反馈页面状态及错误码，不粘贴 Secret、通道地址或完整私有请求正文。

本次首次真实 Push 的实际结果为“已忽略／目标文件未修改”。只读提交列表确认文件所在目录比任务目标少一层，完整相对路径不一致；数据库 Delivery 为 IGNORED / TARGET_NOT_CHANGED，已尝试 1 次、无取证错误码，任务仍 IN_PROGRESS / version 2，无 Submission 或验收 Run。这证明真实接收和后台比较已执行，不是转发断开或 Worker 未启动，也不代表正文取证成功。下一步由用户将笔记放到任务要求的完整路径并新增普通提交后 Push；不要重投旧通知或修改数据库绕过路径匹配。AI 仅诊断与记录，未修改学习仓库或代为推送。

随后用户修正目录、修改内容并新增提交，报告页面“已取证”。只读核对对应 Delivery 为 PROCESSED、已尝试 1 次且无错误码；Submission 与 DIFF/added Evidence 已保存，正文和 Diff 存在、来源 SHA 与该 Push 一致。任务由 IN_PROGRESS / version 2 变为 VERIFYING / version 3，关联 NOTE_VERIFICATION Run 为 QUEUED、expectedTaskVersion 为 3，验收 Outbox 一条、尚未投递。这是本轮真实取证与交接成功的观察证据，替代上段待成功观察的返回点；M4 消费尚未接入，不等待其自动通过、不为推进状态重复 Push 或重启，也不手改数据库。未重跑旧测试、调用模型或完成整个 R06；短复述反馈与实际用时统一在逐日计划记录。

### 5.22 R06 接收阶段忽略反馈（2026-10-18）

本段只学习一个区别：**通知属于哪次仓库绑定，与这次通知是否有可取证的任务，是两件事。** 目标约 20 至 30 分钟，无新手写。此前列表从任务 Outbox 反查通知，无当前任务时没有 Outbox，页面就看不到原因；现在接收事务先固定 `Delivery.receivedRepositoryId`，再决定是否创建取证待办。

可观察结果：活动绑定下没有当前任务时，一次合法 Push 仍返回 202；仓库页显示“已忽略／未关联任务 · 未进入取证”和“请先开始任务，再修改目标文件并提交新的 Push”。不会产生 Outbox、Submission 或 AgentRun，也没有重试/全文同步按钮。后来开始任务或重投同一通知不会把旧 Push 改成新任务的证据；解绑重绑也不会继承它。

在项目根目录运行这一个新增观察用例即可，PostgreSQL 需已启动：

```powershell
pnpm test:integration:r06 apps/api/test/repository-evidence.integration.ts -t "R06 observation: ignored receipt"
```

预期 1 项通过、其余场景跳过。它用随机测试用户、绑定、任务及真实签名 HTTP 走接收和查询，再断言上述结果；测试自行清理自己的记录，不访问真实 GitHub、不调用模型、不修改已取证的真实任务。用户无需再次 Push 或取消当前 VERIFYING 任务。

首轮只读两个增量入口：

1. `apps/api/src/webhooks/github-webhook.service.ts`：第 3 段锁用户、重查原绑定后，先写 `receivedRepositoryId`；非目标分支直接记原因，没有任务则在第 4 段记原因，均不制造 Outbox。
2. `apps/api/src/repositories/repository-evidence.service.ts`：`list` 先确认登录用户拥有当前绑定，再按接收绑定查询 Delivery；有 Outbox 走已有取证结果映射，无 Outbox 只返回白名单内、未开始取证的忽略记录。未知历史归属不展示，无权返回 404。

配套迁移只增加可空归属、外键及索引，并从原 v2 Outbox 已固定且核验一致的绑定材料补齐历史；不按今天的仓库 owner 回填。契约只允许无任务记录为 IGNORED/零尝试/不可恢复，页面复用现有通知组件。这里的绑定 ID 是本项目 Repository 记录 ID，不是 GitHub 仓库号。

本地已应用 `20261018100000_webhook_receipt_binding` 并重建共享包/API。其他环境须先应用迁移、重建共享包并切换到新版 API/Web，再接收与观察新通知；未改造旧 API 继续写入的滚动升级窗口，不宣称未知归属会自动补齐。本轮没有重启现有 API/Worker 或其他应用；用于 UI 检查的独立 4310 Web 和隔离浏览器页已关闭。

定向工程验证：接收及查询/恢复 PostgreSQL+HTTP 集成共 63 项、相关常规测试 38 项通过；API/Web/Worker 类型检查、API/Web 构建、定向 lint、格式与差异检查通过。Web 构建仅有上游 DEP0155 弃用提示，退出码 0。真实产品页面配合隔离合成响应检查 1280px/375px 布局、长路径、44px 按钮、键盘可见焦点、正文最低对比度约 7.37:1，以及加载、空、网络错误、401/404 清理；不是新增真实 GitHub Push 或登录证据。没有运行完整 `pnpm check` 或重跑用户已完成的队列集成。用户观察、导读理解、短复述和实际用时待反馈，R06/M3 不标 DONE、不提交。

2026-10-19 用户已确认上述两个增量入口的导读理解，本段转 RECALL；只补无任务通知归属及重绑隔离的简短复述、新增观察用例运行反馈与实际用时，不重读或重跑旧用例。此次仅同步进度，不新增实现或验证证据，R06/M3 仍未完成。

随后用户正确复述忽略通知的安全文案/无任务展示及重绑 ID 隔离，短复述通过；AI 补齐接收绑定持久化、按用户授权查询，以及 message 属于响应映射而非数据库写入。仅待上方新增观察用例运行反馈和本段实际用时，不重复复述或重跑旧用例；累计仍为已报告约 5 小时 45 分钟，R06/M3 不标 DONE、不提交。

同日用户补充“已运行，用时15分钟”，记录为本节新增观察用例已运行，未报告具体统计，不补造通过数或真实 Push 证据。本小段学习收尾，R06 累计约 6 小时、返回 WORKING；异常退出/数据库不可写恢复留下一小段，R07 部署 smoke 保留。本轮仅同步进度，不重跑测试、改产品、启动服务或提交，整个 R06/M3 尚未完成。

### 5.23 R06：证据已落库，Worker 却没来得及确认完成（2026-10-19）

本段只学“业务提交与队列确认是两步”，约 20 至 30 分钟、无新手写。场景是 Finalizer 已将证据、QUEUED 验收 Run、验收 Outbox 和 Delivery 终态原子保存，Worker 随即退出；PostgreSQL 已经成功，但 Redis 的 Job 仍可能是 active。不能因此把 Task 改成失败，也不能把同一证据再写一份。

先启动本机 PostgreSQL/Redis，在根目录运行一个新增观察用例；无需启动产品 API/Web/Worker 或再次 Push：

```powershell
pnpm test:integration:r06 apps/worker/test/github-evidence-processing.integration.ts -t "R06 observation: recovers a worker crash" --disableConsoleIntercept
```

预期 1 项通过、其余不匹配的用例跳过，并看到三个检查点：

1. `committed-before-ack`：Delivery=PROCESSED、Job=active、Run 数量 1。
2. `fixture-worker-exited`：测试子进程已被强制结束，数据库成功结果仍在，Job 尚为 active。
3. `recovered-from-saved-result`：新 Worker 检查失联后处理同一 Job，最终 completed，readerCalledAgain=false，Run 仍为 1、Task version 仍为 4。

这些数量和版本是独立测试夹具，不是用户的真实任务。本例确实终止一个由测试创建的 Node 子进程，不是把普通 throw 或 worker.close() 当作崩溃；GitHub 读取结果为合成数据，Processor/Finalizer、PostgreSQL、Redis 为真实实现。只使用带随机 UUID 的测试队列和数据，本地 URL 与队列前缀有检查，原取证待办停放在未来并仅按指定 ID 投递；不停止常驻服务、清空正式队列或改用户笔记。退出及资源清理由测试负责。

首轮只读两个既有产品入口，不要求阅读子进程测试装配：

1. `apps/worker/src/queue/bullmq-github-evidence-queue.ts` 的 `createGitHubEvidenceBullMqProcessor`：适配器等待 handler.process 返回；数据库事务提交发生在内部，BullMQ 标记 Job 完成在返回之后，因此存在本次退出窗口。
2. `apps/worker/src/github/github-evidence-job-processor.ts` 的 `terminalResult(delivery)` 调用及函数：原通知身份/恢复轮次检查后，先返回已保存终态，早于尝试数递增、Reader 和 Finalizer；因此再次领取不等于再次读取正文或写入业务结果。Finalizer 持锁后的幂等检查仍保留，防并发期间状态变化，不需重读整个函数。

BullMQ 的处理锁过期后，需要运行中的 Worker 执行 stalled 检查，在未超允许次数时重新排队处理；不是所有 Worker 都停了仍会自己继续，也不是无限重试。参考 [BullMQ 失联任务机制](https://docs.bullmq.io/guide/jobs/stalled)与[异常退出恢复](https://docs.bullmq.io/guide/workers/graceful-shutdown)。测试用 1.5 秒锁、100 毫秒扫描缩短观察，产品沿用本地安装 BullMQ 6.0.10 的默认值；不把测试耗时写成生产性能承诺。

本轮没有修改产品逻辑、迁移或配置，只新增退出测试及配套子进程，复用原有幂等保护。新增集成 1 项及适配器单测 15 项通过，Worker 类型检查、定向 lint/格式与差异检查通过；未运行完整 R06 或 pnpm check。临时进程/随机数据/队列已清理，没有重启既有服务。10/19 用户已确认理解恢复链路及两个测试文件的导读，短复述通过：发现 PROCESSED 后复用已有结果，避免重复落库；AI 补齐回调正常返回后由 BullMQ 完成队列状态更新。随后用户反馈新增观察用例已运行、本段约 20 分钟，未给具体统计，不补造用户通过数；结合既有工程验证，本小段学习收尾，不要求重跑。R06 累计约 6 小时 20 分钟，返回 WORKING；下一小段预告数据库写入失败时的回滚与重试边界，尚未启动。未提交时退出、数据库持续不可写及连续失联超过上限的结果对账尚未因此验证；R06/M3 不标 DONE、不提交。

### 5.24 R06：验收 Outbox 写入失败，回滚后再自动重试（2026-10-19）

本段约 20 至 30 分钟、无新手写，只看一个写入失败出口。与 5.23 已提交后退出不同，本次在 Finalizer 的事务提交前失败：前面即使执行过 Task 更新、Submission/Evidence 和 AgentRun 创建，也必须一起回滚；先前独立提交的接收 Delivery 与原取证 Outbox 不删除。

本机 PostgreSQL/Redis 可用时，在根目录仅运行一个新增观察用例，不需要再 Push、启动产品服务或重跑旧退出用例：

```powershell
pnpm test:integration:r06 apps/worker/test/github-evidence-processing.integration.ts -t "R06 observation: write retry" --disableConsoleIntercept
```

预期 1 项通过，其余不匹配用例跳过。两个观察日志是测试在对应时刻保存的检查点，断言后集中打印；不以它们与产品日志的输出顺序推断执行时序：

| 检查项 | handoff-rolled-back：首次失败后 | handoff-recovered：自动重试成功后 |
| --- | --- | --- |
| Delivery | ACCEPTED；安全错误 EVIDENCE_PROCESSING_FAILED，未耗尽次数 | PROCESSED；错误清空 |
| Task | IN_PROGRESS / version 3 | VERIFYING / version 4 |
| Submission / Evidence / AgentRun / 验收 Outbox | 各 0 条 | 各 1 条；AgentRun 仅 QUEUED，不是验收通过 |
| 取证尝试次数 | 1 | 2 |
| 原接收 Outbox 投递次数 | 1 | 仍为 1；整条记录不变 |

出现一次 `github_evidence_job_failed` WARN 是本次预期故障，不代表整个测试失败。产品 Processor 在事务外记录错误后继续抛出，由 BullMQ 按 attempts/backoff 自动重试；此处没有再次投递 Outbox，也没有手动重试调用。由于首次证据未提交，第二次会重新调用 Reader，仍使用原接收快照的固定 SHA。队列配置限定总尝试次数，不能无限重跑；参考 [BullMQ 重试说明](https://docs.bullmq.io/guide/retrying-failing-jobs)。

首轮只读两个既有产品入口，不要求阅读整份测试装配：

1. `apps/worker/src/github/finalize-github-push-evidence.ts` 的第 3 段：Task、Submission/Evidence、AgentRun、验收 Outbox 和 Delivery 完成状态都在同一个 `$transaction` 内；任一步失败都不能留下前面几步的业务结果。参考 [PostgreSQL 事务说明](https://www.postgresql.org/docs/14/tutorial-transactions.html)。
2. `apps/worker/src/github/github-evidence-job-processor.ts` 的 `catch`：失败记录不在刚回滚的事务内；只更新仍属于本次尝试的 Delivery，不改 Task、不伪造 FAILED AgentRun，然后 `throw failure` 交给原 BullMQ 适配器。最终成功会清空安全错误；不可重试或重试次数耗尽时保存 `evidenceFailedAt`，可继续自动重试时为 `null`，Delivery.status 不因此改为失败。

测试位置为 `apps/worker/test/github-evidence-processing.integration.ts` 的 `R06 database write recovery`。只在测试专用 Prisma 客户端的验收 Outbox 写入中使用本夹具已有的唯一键，触发真实 [P2002 唯一约束错误](https://www.prisma.io/docs/orm/reference/error-reference#p2002)；第二次解除故障注入，并非断言真实唯一键冲突总能靠重试解决。使用随机队列/用户/任务，本地地址检查和未来时间停放避免常驻 Dispatcher 领取夹具；GitHub 读取结果为合成数据，没有访问 GitHub 或模型。无全局触发器、迁移、数据库停机或正式队列清空，测试仅清理自己的记录与队列。

另有同组回归覆盖连续三次写入拒绝：总尝试 3 次后 Job failed，Task 保持原状态/版本，无任何验收结果，Delivery 留下安全错误和失败时间。它依然允许事务外错误记录写入，不能替代“整库不可用、连错误都写不回”的验证。新增集成 2 项通过（其余 37 项跳过），上方短标题单项命令另复核为 1 passed / 38 skipped，不累加为新场景；Worker 类型检查、定向 lint、格式/文档差异检查通过，没有修改产品代码或运行完整 R06/pnpm check。2026-10-19 用户已确认两个入口的导读理解，短复述通过，并报告观察用例已运行、本段约 15 分钟；未提供用户测试统计，不补造或要求重跑。本小段学习收尾，R06 返回 WORKING，累计约 6 小时 35 分钟。提交前进程退出、整库不可用及连续失联耗尽上限的对账仍待补，R06/M3 不标 DONE、不提交。

### 5.25 R06：剩余故障统一工程收尾（2026-10-20）

按用户确认，三类故障合并成一次工程验证，统一学习约 20 至 30 分钟，不逐个开导读/复述，不加手写或要求再次 Push。既有真实 Push 与学习证据保留。这里唯一新增概念是：队列已经停止处理，但数据库可能没有失败记录，需要核对并补记，而不是再执行一遍任务。

| 隔离场景 | 验证结果 |
| --- | --- |
| 事务写入后、提交前结束测试 Worker | 未提交的 Task/Submission/Evidence/Run/验收 Outbox 不可见；新 Worker 自动重领后只落一份结果 |
| 连续两次提交前退出，超过允许失联次数 | Job 最终 failed；对账补记 Delivery 的取证失败，Task 不变、无验收 Run |
| 已成功落库，但连续退出最终使队列失败 | PostgreSQL 的成功结果保持不变，不能被对账改为失败 |
| 取证后数据库连接断开，连 catch 错误记录都写不回 | 短暂故障恢复后可自动成功；耗尽尝试后，连接恢复再补记可查询失败，原手动恢复仍能成功 |
| 连接在登记开始前就失败，后续手动恢复再次失败 | 根据保留 Job 的实际领取次数补齐累计值，下一次恢复得到新请求，不卡回旧防重键 |
| 对账读取期间发生成功、新尝试或新恢复请求 | 条件更新返回 0，旧失败不能覆盖新状态 |

产品首轮只读两个入口：

1. `apps/worker/src/github/github-evidence-reconciler.ts`：查未记最终失败的 Delivery，恢复原 Outbox/当前恢复请求上下文，核对队列后条件补记。它不执行 GitHub 请求、不改 Task/Run，不用超时时长猜失败；失败码固定为 EVIDENCE_PROCESSING_FAILED，不转发 Redis 任意错误原文。
2. `apps/worker/src/queue/bullmq-github-evidence-queue.ts` 的 `getFailure`：按稳定 Job ID 找当前请求，校验名称和 payload，只返回真正 failed 的结束时间、领取时间与次数。waiting/active/delayed/completed 或缺失 Job 都不给失败结论。

装配只需知道：`WorkerRuntimeService` 将对账传给原 `OutboxDispatchLoop`，共享已有定时器、批大小、不重入和停机等待；单次数据库/Redis 错误会记录安全提示并留待下一轮，启动时也会核对，不依赖瞬时 failed 回调。已确认的 Processor/Finalizer 不重讲。实际领取次数用于补齐登记失败造成的缺口，并不证明调用过 GitHub；补记后 API 返回 FAILED/canRetry，已保存的成功业务仍优先。

工程验证已由 AI 集中运行：全 R06 集成 **159 项通过**，Worker 常规单元 **198 项通过**（其中新增 14 项）；新增集成共 9 项，已包含在 159 项中。Worker 类型检查、构建与定向 lint 通过；未运行全仓 pnpm check。若用户希望统一观察，可选以下单条命令，不作为新增逐项打卡要求：

```powershell
pnpm test:integration:r06 apps/worker/test/github-evidence-processing.integration.ts -t "R06 engineering closeout" --disableConsoleIntercept
```

上方筛选命令已复核为 **9 passed / 39 skipped**，是全 R06 回归的子集，不累加为新场景。最后收窄对账查询只读取必要元数据、不搬运 Push 原始正文后，类型检查、定向 lint/格式和该组集成再次通过。`closeout-exit` / `closeout-database` 日志只报告合成夹具结果，失败 WARN 是故障注入的一部分，不代表用例失败；不把测试中的短锁/扫描时间当作生产恢复指标。

测试使用真实本机 PostgreSQL/Redis、随机记录和随机队列，GitHub 读取为合成结果。专用 TCP 入口断开本测试客户端的所有数据库连接，覆盖查询、事务和错误写回均不可用；不是停止 PostgreSQL 服务，更不是修改用户网络。进程退出仅结束测试自己创建的隐藏子进程，无全局锁删除或正式队列清空；结束后清理临时入口、进程、记录和队列。保留 Job 丢失、Redis 全量数据损坏及部署时延不在本轮证据内；服务部署验证仍属于 R07。机制依据：[BullMQ 失联次数上限](https://docs.bullmq.io/guide/jobs/stalled)、[有限重试](https://docs.bullmq.io/guide/retrying-failing-jobs)，实际属性按本地 BullMQ 6.0.10 类型与运行结果核对。

2026-10-20 用户已确认统一导读理解，并正确复述候选 Delivery → 当前处理 Job → 确认 failed → 补记失败的链路，短复述通过。AI 补充当前恢复请求定位、条件更新为 0 时保护成功/新尝试及安全失败码的细节，不要求重述。用户随后报告本段约 15 分钟，R06 累计约 6 小时 50 分钟，较原预算超出约 2 小时 50 分钟；不把 AI 工程耗时计入学习。R06 的实现、既有验证、真实 Push 观察与学习收尾完成，DONE 随本次本地提交生效；本轮不重跑产品测试，不推送。两个临时 Playground 源码已清理，正式测试和历史观察保留。下一单元 R07 部署 smoke 未启动，M3 尚未完成；不声明已接入 M4 正文验收或 Redis 数据丢失后的自动重建。

### 5.26 R09 笔记验收消费者与报告（2026-10-27）

本地执行 `pnpm db:migrate:deploy`、`pnpm build:packages` 后可运行 `pnpm test:integration:r09`。该命令包含 11 项账本用例和 13 项消费/报告用例，使用真实 PostgreSQL/Redis、随机夹具与隔离队列，模型全部模拟，不产生模型费用；清理仅涉及本轮夹具。普通 `pnpm test` 不包含这些集成场景。

正式消费者以 `.env.example` 的 `NOTE_VERIFICATION_MODEL_JSON` 显式启用，留空时不认领 `NOTE_VERIFICATION_REQUESTED`，不丢弃待办。共享既有 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`PLAN_GENERATION_OUTPUT_METHOD`；密钥不能写进模型 JSON。示例 GLM-5.3 单价由用户于 10/27 提供：输入 ¥8、输出 ¥28、缓存命中 ¥2／百万 Token；目前不拆分缓存用量，全部输入按普通价估算，不能当作供应商账单。微货币单位为百万分之一元，价格 JSON 中分别填 8000000、28000000；默认费用阈值 1000000 表示 ¥1。

实际 `.env` 与 VPS 本轮未修改；10/27 随后的独立真实模型 smoke 见下文。启用正式消费者前先核对数据库中的待办：Worker 启动后会自动消费符合条件的历史验收 Outbox。配置更新后重启 Worker；预算、单价和截止时间在首次领取 Run 时冻结，重启不刷新已有 Run 额度。额度超出或用量未知时保留已校验的合法结果及 warnings，不再追加调用；过期或取消仍不能发布报告。

报告由 `GET /agent-runs/:runId` 查询（API 本身无 `/api` 全局前缀，部署代理规则另计），要求有效登录且归属当前用户。返回 Run 状态、报告单项结果、免检项、待追问标准及费用估算，不返回凭据/内部配置。报告和 `SUCCEEDED` 同事务落库；失败或超时只恢复版本仍匹配的 Task。报告成功不代表 Task 通过；追问见 5.28，Task 汇总写回见 5.35，产品页面留待 R12。

队列重投不重复调用模型；已有完整账本允许补报告，未完成账本不重新计费尝试，等待原截止时间收束。恢复扫描复用 Outbox 轮询器：数据库恢复后可补报告/终态，首次领取前耗尽队列重试的 Run 还会核对失败 Job。Redis 数据被删除后的自动重建不在本段范围。队列失败日志为安全代码，数据库 `errorCode` 与队列投递错误应分开理解。

手动真实模型观察入口为 `apps/worker/scripts/verify-note-live.ts`，不属于自动测试或基础入门练习。在仓库根目录运行：

```powershell
# 只读上次保存的观察，不请求模型，也不连接数据库/Redis。
pnpm verify:r09:live
```

只有显式追加 `--run` 才会创建新的付费验收：要求本地数据库/Redis、现有智谱 HTTPS Base URL/API Key，固定 GLM-5.3、用户确认的单价和单 Run 最多两次调用，三分钟截止时间、每次最多 4096 输出 Token。脚本使用独立队列、随机合成记录与定向 Outbox 投递，结束后清理自身记录和队列，保存 `apps/worker/.local/r09-live-note-result.json`（Git 忽略）。其中原文、Commit、绑定为合成材料，实际请求走正式模型适配器；不读取用户仓库内容，不启动全局消费者。

10/27 AI 已运行一次：Run/报告成功，模型调用 1 次，输入 973、输出 1248、共 2221 Token，估算 ¥0.042728，无记账警告。同 Run 再次处理新增调用 0、返回同报告 ID。语义引用为原文第 4–5、7 行；三个已有检查均通过，一个追问标准待处理，Task 仍 VERIFYING。数据库夹具已清理，后续通过本地 JSON 观察该报告，无需重复付费。此结果验证合成证据经真实队列、模型和数据库生成报告，不代表本轮验证了浏览器/GitHub Push 全流程或已发布至 VPS。

### 5.27 R10 单次追问生成与校验（消费接入见 5.28）

在根目录运行，不需要 WSL、数据库、Redis 或模型凭据：

```powershell
pnpm exec vitest run apps/worker/test/generate-follow-up-question.spec.ts
```

测试用合成固定正文和模拟模型响应，观察题目/评分要点/来源一同返回、伪造引用被拒绝且保留用量，以及取消后迟到结果不能成功。适配器协议测试为 packages/agent-core/test/langchain-follow-up-generator.spec.ts，使用真实 LangChain SDK 与模拟 fetch；没有付费请求。

首读 Worker 的 generate-follow-up-question.ts 和 agent-core 的 langchain-follow-up-generator.ts；前者调用模型后继续核验引用，后者组装受约束的单次生成请求，复用现有 SDK 连接和安全错误。运行前需有共享包构建产物；代码变更后可执行 pnpm --filter @knowledgeops/agent-core build。

此单次调用小段没有新的服务启动或环境变量配置步骤。同 Run 预算/账本与问题保存见 5.28，回答受理与消费见 5.29–5.31；Task 状态汇总见 5.35。

### 5.28 R10 同 Run 共享预算与追问原子保存

本段复用 R09 消费者和集成套件，需要本地 PostgreSQL/Redis；模型只返回合成结果，不产生费用。10/27 已在本机应用增量迁移 `20261027170000_follow_up_question`、生成客户端并构建共享包，无需本机重复迁移。其他环境升级代码后先执行 `pnpm db:migrate:deploy` 和 `pnpm build:packages`，再重启 API/Worker；本轮没有部署 VPS。

```powershell
pnpm test:integration:r09 --testNamePattern "R10 shared"
```

预期 9 项通过：一个 Run 中笔记判断与出题合计两次调用；查询返回一道题及固定提交引用，隐藏评分要点；追问写入失败时报告/终态一起回滚，重试不再调用模型；出题期间解绑、版本变化或取消不能发布；R08 必需章节失败不出题、合法全文快照免检允许继续；语义修复耗尽次数仍保留笔记报告；已冻结的 R09 配置不自动追加新步骤。完整 `pnpm test:integration:r09` 当前 34 项，包含旧账本/消费者和未装配回答发布器时的事件保留回归。

按顺序只读两个入口：

1. `apps/worker/src/verification/execute-note-verification.ts`：笔记结果决定是否出题，第二步使用剩余预算；两个步骤都经同一 journal 登记与结算。
2. `apps/worker/src/verification/note-verification-run.repository.ts` 的 `finalize`：核对固定上下文，将报告、唯一追问和 Run 终态一起提交。`prepare/material` 只需知道负责预留报告 ID、准备资格与材料。

其他改动是既有链路接线：持久化入口保存完整结果/指纹，Processor 和 Nest 工厂传入出题端口，查询接口映射所属用户可见字段，`FollowUpQuestion.reportId` 唯一约束防止一份报告保存多道题。已有完成账本可复用，未保存响应的进程崩溃仍按原未知执行/超时策略处理。

`NOTE_VERIFICATION_MODEL_JSON` 仍是正式消费开关；没有新增环境变量，也没有自动启用本机/VPS 付费消费。启用新版消费者后，新 Run 的笔记判断和出题共享原最多两次调用、Token/费用及截止时间，修复也占这两次。额度不足时在报告 `followUp` 记录 FAILED，笔记不通过时记录 SKIPPED，成功保存题目为 READY；这些是出题状态，不是回答或 Task 通过状态。回答提交/独立验收见 5.29–5.31，Task 汇总见 5.35。

### 5.29 R10 回答 API 与独立验收 Run 受理

本段使用真实 PostgreSQL、会话与本地随机端口 HTTP，原题/报告为合成夹具，不调用 GitHub、Redis 或模型，不启动全局 Worker。根目录观察命令：

```powershell
pnpm test:integration:r10
```

该命令现包括受理与消费共 35 项；只观察本节可运行 `pnpm test:integration:r10 apps/api/test/follow-up-answer.integration.ts`，预期 16 项。重点观察首次提交返回 202 并生成独立 Run、同一 requestId 并发提交仍只有一份答案/Run/Outbox，以及 Outbox 写入失败时答案/Run/Task 版本全部回滚。还覆盖登录和 Origin、双用户隔离、输入长度、原绑定/版本/计划变化、伪造来源、活动 Run、较新笔记使旧题失效，以及失败后修改答案产生新记录。

本机已应用 `20261027210000_answer_submission` 并生成客户端。其他环境先 `pnpm db:migrate:deploy`、`pnpm build:packages`，再构建并重启 API/Worker；本轮没有部署 VPS。

接口约定：

- `POST /follow-up-questions/:questionId/answers`：需要登录 Cookie 与正确 Origin；请求体 `{ requestId, expectedTaskVersion, answer }`。requestId 是同一次提交的 UUID，网络重试复用；答案去除首尾空白后限制 1–8000 字符。返回 202 的 `{ status: 'ACCEPTED', answerSubmissionId, runId, taskId, taskVersion }` 是受理凭据，重放仍返回原凭据，不保证 Run 仍在排队。
- `GET /answer-submissions/:answerSubmissionId`：仅所属用户能读取答案、初始 Run 状态和已完成的回答报告；刷新无需重交，不返回原题 rubric。不存在与越权统一 404，旧题/任务版本/同请求不同内容冲突为 409。

首读 `follow-up-answer.controller.ts` 的提交入口，再读 `follow-up-answer.service.ts` 的 `submit`：按 User → Task 锁定，先查请求幂等，再核对原题及最新笔记/运行，最后事务保存 AnswerSubmission、Task 新版本、ANSWER_VERIFICATION Run 与 Outbox。`get` 只做所属用户查询。该 API 复用全局身份守卫，不信任请求体中的用户身份或评分结论。

Task 汇总现已接入（见 5.35）：受理支持 NEEDS_EVIDENCE，也兼容笔记 Run 已完成、版本匹配且无活动 Run 时遗留的 VERIFYING；并非允许正在验收时随意提交。消费者在领取和发布前再次复核原题/笔记和版本，见 5.31。本节受理测试不装配消费者，Outbox 保持待处理、Run 为 QUEUED；不能把受理成功当成模型已经验收或浏览器表单已上线。

原消费者回归仍用 `pnpm test:integration:r09`，现共 34 项，其中一项专门确认没有回答发布器时新 Outbox 类型不会被计划/笔记 Dispatcher 误消费。测试只清理各自随机数据，无需手动建立真实任务或重复付费出题。

### 5.30 R10 单次回答验收与两类引用

本段仅用合成原题、固定笔记、回答和模拟模型响应，无需启动 PostgreSQL/Redis，不发生真实模型费用。根目录观察命令：

```powershell
pnpm exec vitest run apps/worker/test/verify-follow-up-answer.spec.ts --reporter verbose
```

预期 24 项通过。重点看三类现象：合法候选返回带原题/答案 ID 的单项判断；回答错误或不充分时返回 FAILED/INSUFFICIENT_EVIDENCE 与建议；模型引用了答案里不存在的文字时抛 INVALID_ANSWER_CITATION，并保留可得 Token 用量。这里是预设模型输出的程序行为验证，不是模型准确率评测。

首读 `apps/worker/src/verification/verify-follow-up-answer.ts`：输入沿 AnswerSubmission → FollowUpQuestion → 原笔记准备，函数复制材料、检查对应关系、单次调用端口，再逐行核对笔记/回答引用。返回 `{ result, usage }`，不写数据库。笔记 `citations` 绑定仓库/Commit/路径/正文哈希；`answerCitations` 绑定已保存的答案 ID，行号从 1 开始，引用按 LF 拼接并保留空行。通过/失败必须有两类引用；证据不足允许如实缺少引用，不能为填字段编造文字。Schema 和引用核对不能代替语义正确性评测。

再读 `packages/agent-core/src/answer-verification/langchain-answer-verifier.ts`：使用原题 Rubric 和两份分开的逐行材料生成结构化判断，复用既有 SDK 调用、输出格式、用量和安全错误。适配器观察命令为 `pnpm exec vitest run packages/agent-core/test/langchain-answer-verifier.spec.ts`，预期 12 项；SDK 请求由模拟 fetch 截获。新检出代码需先构建 contracts、再构建 agent-core；本次本地已经构建。

正式回答消费者已按 5.31 接入此入口，外层负责资格/预算/账本及最终报告；单次函数本身不自行重试、不变更 Task，也不新增环境变量。

### 5.31 R10 回答消费者、独立账本与报告保存

主要观察结果：提交回答后，Worker 能读取原题和固定笔记完成回答验收，所属用户可查询报告。需要本地 PostgreSQL/Redis；测试使用随机数据和独立队列，模型响应为合成数据，没有付费调用。根目录执行：

```powershell
pnpm test:integration:r10
```

预期 **35 项通过**：16 项回答受理与 19 项消费/恢复检查。新增部分覆盖真实 Outbox → BullMQ → Processor → 账本 → 报告查询、回答不通过仍保存有效报告、重复消费不重复调用、报告写入失败后复用账本，以及调用期间解绑/版本变化/取消/新笔记使旧结果失效。故障注入时出现 `verification_job_failed` WARN 属于预期，最终以用例结果为准。既有笔记链路回归 `pnpm test:integration:r09` 为 34 项。

首读集中在两个入口，约 20 至 30 分钟计入 R10 原预算，无新手写：

1. `apps/worker/src/verification/answer-verification-job-processor.ts`：prepare 领取并准备材料 → 持久化执行 → finalize 发布结果。已完成 Run 直接返回；正在执行的重复 Job 不能冒充完成。
2. `apps/worker/src/verification/answer-verification-run.repository.ts` 的 prepare/finalize：两端按 User → Task → Run 加锁，确认原题、最新笔记、仓库绑定和任务版本。模型在事务外调用；保存前还核对冻结配置、账本指纹及两类引用，将报告与 Run SUCCEEDED 一起提交。写入失败时事务回滚，后续重试或 reconcile 读取已完成账本，不重新付费调用模型。

其他文件复用已学机制：`execute-persisted-answer-verification.ts` 为独立回答 Run claim/reserve/settle/finish；`verification-budget.ts` 与共享执行仓库统一笔记/出题/回答的预算和持久化规则；数据库沿用历史名 `NoteVerificationExecution`，每条仍只属于一个 Run，不与原笔记合并预算。两个验收队列共用 BullMQ 接线；Dispatcher、Nest 装配和定时 reconcile 接入回答类型。没有新增迁移。

配置继续使用 `NOTE_VERIFICATION_MODEL_JSON` 与 `NOTE_VERIFICATION_*` 限制：同一模型配置启用笔记与回答两个消费者，每个 Run 独立冻结配置和预算，回答至多两次调用，队列重试不新增额度。为空时对应 Outbox 保留待处理。本段没有修改本机 `.env`、发起真实模型请求或发布 VPS；启用后待处理回答可能产生实际模型调用。

`GET /answer-submissions/:id` 现返回答案、Run 的状态/安全错误码/时间，以及 nullable report；报告包含原题来源、回答结果、两类引用与用量摘要，不返回 Rubric。合法的 FAILED/INSUFFICIENT_EVIDENCE 判断同样意味着 Run 执行成功；超时、取消或执行错误才走失败收束。R11 已在 Finalizer 接入 Task 汇总写回（见 5.35）及依赖解锁（见 5.36），R12 再接表单和页面。本段集成通过不代表真实模型效果、浏览器闭环或生产部署已验收。

### 5.32 R11 从报告整理逐项验收事实

此纯函数的独立观察不依赖 PostgreSQL/Redis，也不调用模型。它为结果推导准备输入，现已被正式 Finalizer 调用（见 5.35），函数自身不写数据库。根目录执行：

```powershell
pnpm exec vitest run apps/worker/test/collect-task-assessment.spec.ts --reporter verbose
```

预期 **7 项通过**。先观察前两项：笔记两项通过、题目已经生成，但未回答时输出结论为 `[PASSED, PASSED, null]`；加入对应回答报告后，最后一项才出现回答判断，回答 FAILED 不会改写前两项笔记结论。其他测试覆盖跨题/跨笔记回答、缺失结果、可选失败、快照免检与冲突数据。结果只是验收事实，不是 Task 状态或模型准确率。

只读两个入口：`apps/worker/src/verification/collect-task-assessment.ts` 及其测试的前两项。调用方在 Finalizer 的事务中复核运行/绑定/版本，再提供当前标准与固定来源；整理函数核对报告形状和对应关系，按标准清单返回 `{ id, type, required, outcome, exemption }`。outcome 为 null 表示没有该项结论；快照 FILE_CHANGED 另外保留免检原因，不能改写为 PASSED。真正决定 NEEDS_REVISION / NEEDS_EVIDENCE / PASSED 的纯函数由 R11 小手写完成，见 5.33。

本段启动时发现真实计划缺少服务端自动补入的唯一必答 FOLLOW_UP_ANSWER 标准；5.34 已补齐新计划与新一轮验收的入口，本整理函数仍拒绝缺少唯一必答标准的输入。旧 Run、绑定或 Task 版本失效的判断归事务层，不能把本纯函数的来源相等检查当成数据库资格已核实。Task 原子更新见 5.35，依赖解锁见 5.36；真实完整闭环与评测尚未完成。

### 5.33 R11 结果推导小手写

材料整理与手写业务导读已完成；用户实现已通过 Review，本段短复述通过，正式接线见 5.35。
`apps/worker/src/verification/derive-task-state.exercise.ts` 的输入为
collectTaskAssessment 整理好的事实，输出为 NEEDS_REVISION / NEEDS_EVIDENCE / PASSED。
题面、业务例子与按需提示见 [R11 小手写](handwrite/r11-task-state.md)；原估编码 25 至 35 分钟，实际手写约 20 分钟、数据流理解另约 20 分钟，本段合计约 40 分钟。

```powershell
pnpm test:handwrite:r11-task-state
```

6 项专用验收覆盖必要项全部通过、必要笔记失败优先于缺证、缺失/不足的笔记证据、
未答或未通过的追问、可选标准与合法快照免检，另检查输入不变与顺序不影响判断。
当前预期 6 项全部通过，材料整理回归 7 项及 Worker 类型/lint/格式检查也已通过；无须启动数据库、Redis 或模型。
专用验收与默认测试分开，不改旧 test:handwrite:task-state 练习。用户实现保留，AI 只整理格式；
真实任务必答标准补齐见 5.34；两个 Finalizer 已调用本函数并原子写回 Task，见 5.35；通过后的依赖解锁见 5.36。

### 5.34 R11 服务端保证唯一必答追问标准

2026-10-28 用户已确认本段导读理解，并正确复述运行中的 Run 不临时补齐标准，短复述通过；AI 工程验证已通过，10/29 用户补充确认下方 9 项用例已运行并观察，不要求重跑。

本段补齐真实任务缺少 FOLLOW_UP_ANSWER 的入口。模型仍只生成笔记标准，服务端在新 Plan 落库事务中
为每个 Task 追加一条 required=true 的追问标准。它只是“需要回答追问”的验收要求，具体问题仍由笔记验收后的出题步骤生成。
旧任务在新一轮有效 NOTE_VERIFICATION Run 首次领取、冻结配置前补齐；已有唯一必答标准复用，已开始或结束的 Run 保留原上下文。
不批量改写旧记录，不改变模型的标准数量上限或输出白名单，也不修改已通过的小手写。

用户观察本段 9 项兼容测试，在项目根目录执行：

```powershell
pnpm test:integration:r11 apps/worker/test/required-follow-up-criterion.integration.ts --reporter verbose
```

需要本地 PostgreSQL；仅使用随机夹具和合成模型响应，不调用供应商。重点看前两项：旧任务并发领取只补一条，
补齐后现有执行器能生成并保存绑定同一标准、同一份笔记的追问。其他测试检查重复/可选标准拒绝、失效运行不修复、
冻结的 R09/R10 Run 保留、异常 QUEUED 不重置配置以及领取失败完整回滚。

完整回归命令 `pnpm test:integration:r11`，当前 41 项通过：17 项计划落库验收、9 项标准补齐、5.35 的 7 项状态写回及 5.36 的 8 项解锁。
R09/R10 回归 34/35 项、Worker 类型与构建、目标 lint/格式检查已通过。C1 验收更新为“每个任务的原笔记标准 + 一条服务端必答标准”，
原子回滚、并发与版本保护仍保留，无需重做 C1 手写。

首读 `apps/worker/src/verification/ensure-required-follow-up-criterion.ts` 与
`apps/worker/src/verification/note-verification-run.repository.ts` 的 prepare。
新计划调用位置在 `apps/worker/src/plan-generation/finalize-plan-generation-run.ts` 的每个 Task 标准写入后。
Task 行锁保证并发补齐不会重复；必答标准写入失败会与计划或领取事务一起回滚，数据异常不会静默改成可通过。
collectTaskAssessment/deriveTaskState 的 Finalizer 接线与 Task 写回见 5.35，依赖解锁见 5.36；测试出题成功不能当成完整闭环上线。

### 5.35 R11 报告与 Task 状态原子写回

本段把已完成的结果推导接入两个 Finalizer，不新增手写。观察/导读目标 15 至 20 分钟计入 R11 原预算。
需要本地 PostgreSQL；使用随机测试资料与合成模型响应，不发起付费模型调用，不需要更新 VPS。

```powershell
pnpm test:integration:r11 apps/worker/test/task-assessment-finalization.integration.ts -t "R11 atomic report and Task publication" --reporter verbose
```

预期 **7 项通过**，同文件的解锁用例因名称过滤跳过。第一项通过真实 Processor、回答提交 Service 与数据库串起同一任务：

| 事件 | Task 状态与版本 | Run 的含义 |
| --- | --- | --- |
| 笔记验收中 | VERIFYING，v6 | 正在执行 |
| 必要笔记标准通过、题目已保存 | NEEDS_EVIDENCE，v7 | 笔记 Run SUCCEEDED，但还没有回答 |
| 提交回答 | VERIFYING，v8 | 创建独立回答 Run |
| 回答判断 FAILED | NEEDS_EVIDENCE，v9 | 回答 Run SUCCEEDED，已得到有效的不通过报告 |
| 修正后重新提交 | VERIFYING，v10 | 新回答对应新 Run |
| 回答判断 PASSED | PASSED，v11 | 必要笔记与回答标准全部通过 |

其余用例覆盖必要笔记 FAILED/INSUFFICIENT_EVIDENCE、Task 写入失败全事务回滚、
重试复用已保存账本、冻结旧 Run 不追加标准、发布前必答标准异常拒绝。
重复消费已结束 Run 直接返回已有结果，不重新写 Task，也不覆盖已通过状态。

首轮只读这两个入口的 finalize 新增部分：

- `apps/worker/src/verification/note-verification-run.repository.ts`：原资格与指纹检查后，整理待发布笔记报告、推导 Task，原子保存报告、追问、Task 状态/版本与 Run 终态。
- `apps/worker/src/verification/answer-verification-run.repository.ts`：读取原题关联的笔记报告，合入本次回答报告，推导状态并在原事务中一起保存。

两处都先锁行并核对 Task 版本，再用本轮 VERIFYING/版本条件写入；任何数据库写入失败都会回滚发布事务，执行账本仍可复用。
旧冻结 Run 若原本缺少必答标准，保留已生成的合法报告，恢复启动前的稳定状态并增加版本，不临时补标准，也不误判通过；后续新 Push 首次领取时才补齐。
发布期间材料/资格已变化则按原失败收束规则处理，不能走旧 Run 兼容路径覆盖新 Task。

本小段接线时 AI 已验证 R11 集成 33 项、受影响的 R09/R10 集成 34/35 项、Worker 类型与构建及目标 lint；新增解锁后的完整回归见 5.36。
用户已完成本段专用命令观察、两个 Finalizer 导读理解确认及事务回滚/账本复用的简短复述；重试发布仍需重新核对运行资格。依赖解锁见 5.36，真实完整闭环、评测及报告页面仍未完成。

### 5.36 R11 任务通过后解锁后续任务

本段只接入依赖解锁，观察/导读目标 15 至 20 分钟计入 R11 原预算，无新增手写。
本地 PostgreSQL 已启动时，在根目录执行：

```powershell
pnpm test:integration:r11 apps/worker/test/task-assessment-finalization.integration.ts -t "R11 dependent Task unlocking" --reporter verbose
```

预期 **8 项通过、7 项跳过**；跳过的是上一段状态写回用例，名称过滤所致。全部是合成模型响应及随机测试资料，不调用供应商。
第一项观察 A→B→C，且同一 Plan 的另一 Stage 中 D 也依赖 A：A 笔记通过时 B/D 仍 BLOCKED，
回答通过后 A 为 PASSED，B/D 为 READY、版本只加一，C 仍 BLOCKED。随后调用既有 startTask，B 才进入 IN_PROGRESS。
再次消费 A 的回答 Run 不重置已开始的 B，也不重复递增 D 的版本。

第二项观察多前置：B 同时依赖 A/X，只有 A 通过时 B 不解锁；X 也通过后才为 READY。
同时检查无关任务、已有非 BLOCKED 状态和异常跨计划依赖。其余用例检查并发发布、未通过回答、晚到的过期版本/解绑结果，
以及解锁已执行但事务未提交时出错：报告、当前 Task 与后续 Task 全部回滚，重试复用账本。

首读两个入口：

- `apps/worker/src/verification/unlock-dependent-tasks.ts`：some 找到直接依赖当前任务的后续任务，every 要求所有前置均为同计划的 PASSED；只更新 BLOCKED→READY 并递增版本。
- `apps/worker/src/verification/answer-verification-run.repository.ts`：当前 Task 写为 PASSED 后，在原事务里调用解锁；调用方已持有用户行锁，和其他 Finalizer/开始任务协调。

TaskDependency 的 taskId 是等待解锁的后续任务，prerequisiteTaskId 是它的前置任务。
解锁不按 position 顺序猜测、不递归通过任务、不自动开始或创建 Run；用户仍在可开始任务中选择。
无前置任务仍由确认 Plan 的原逻辑开放；笔记 Finalizer 因必答追问尚未完成，不会单独通过 Task 或触发解锁。

工程验证：`pnpm test:integration:r11` 共 41 项、`pnpm test:integration:r10` 共 35 项通过；Worker 类型/build、目标 lint 检查通过。
2026-10-29 用户已确认本段 8 项用例运行观察、导读理解及 some/every 业务条件复述通过，无需重复运行。真实 GitHub Push 到任务通过及解锁的完整链路、固定模型评测、报告页与 VPS 更新仍未验收。

### 5.37 R11 真实完整链路的本地准备

2026-10-29：原本地库仍有 R06 时生成的活动计划，其中 SECTION_PRESENT、CONTENT_MINIMUM 的 config 为 null，并有历史待验收 Run。旧规则不能凭描述猜测或改写为通过，因此本轮使用独立库重新登录、生成计划并走真实 Push。此准备不是完整闭环验收通过。

本轮环境：PostgreSQL `knowledgeops_r11_smoke`（同一开发用户拥有），Redis DB 11（首次启用前已确认空），Web `http://127.0.0.1:3000`，API `http://127.0.0.1:4000`。原 `.env`、原业务库和原 Redis DB 保留。不要同时启动普通 `pnpm dev`，端口相同。

本机专用库已通过 WSL PostgreSQL 管理用户创建，16 项迁移已应用；后续恢复运行：

```powershell
pnpm local:r11 check
pnpm local:r11 migrate
pnpm build:packages
pnpm --filter @knowledgeops/api build
pnpm --filter @knowledgeops/worker build
pnpm local:r11 start
```

`scripts/r11-local.mjs` 只覆盖当前进程和子进程的数据库、Redis、回调及模型配置，不写 `.env`，不造业务数据。API/Worker 运行构建产物，修改它们后需要重新构建并重启；Web 使用开发服务器。终端 Ctrl+C 停止整组服务。普通 `pnpm dev` 仍使用原库。

这组服务启用真实笔记/追问及回答模型消费，使用已确认的 GLM-5.3 普通输入 ¥8/百万、输出 ¥28/百万 Token 估算费用，缓存折扣未单独计入。每个验收 Run 的预估额度为 ¥1、总 Token 上限 16000，单次输出上限 4096，显式使用 `reasoningEffort: low` 并在首次领取时随 Run 冻结。实际超额结果沿既有规则保留并记录警告；这不是供应商侧硬扣费上限。新建计划、Push、提交回答均可能触发付费调用，不批量重试。

下一步按顺序观察：

1. 在 GitHub App 的 Callback URLs 中加入 `http://127.0.0.1:4000/auth/github/callback`，保留 VPS 的回调；从本地页面登录并绑定学习仓库。GitHub App 支持多个回调，代码已发送 redirect_uri，参见 [GitHub 官方说明](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/about-the-user-authorization-callback-url)。
2. 通过页面生成短计划，检查目标文件和验收规则，确认计划并开始首个任务；本次应至少有一项依赖首任务的后续任务，便于观察解锁。
3. 按 R06 的本地 Webhook 转发方式，将真实 GitHub 请求送到 `/webhooks/github`。如果 App 仍指向 VPS，先记录原 Webhook URL，再临时切换到本地转发入口，观察结束后恢复；本次尚未改动 GitHub App 或 VPS。
4. 用户提交目标文件，观察 Delivery/Submission/Evidence、笔记报告、追问及 Task 状态；回答表单在 R12 接入，本段通过已有认证 API 提交用户回答，保留同一 requestId 处理重发。
5. 记录真实答案报告、Task PASSED 和后续 Task READY 的关联 ID/版本、Token 与费用估算。模型未通过则按真实结果修订，不直接改库或伪造结论。

本轮准备验证：专用库/Redis 协议检查、迁移、API/Worker 构建及启动、API ready 200（两项依赖均 up）、Web 200、脚本 lint/format 通过。真实 GitHub 登录/Push/回答闭环、固定评测仍待观察，不据此宣布 R11 完成。

10/29 用户已完成本地登录及绑定；只读核对专用库中的 `Gerden31145/my-study-record`、`main` 分支绑定 enabled=true，尚无新计划或生成 Run。下一步由用户通过计划表单生成短计划，核对规则、依赖及目标路径后再开始任务；Webhook 是否已转向本地尚待确认。

随后用户已完成新计划生成。只读核对计划为 DRAFT，共 4 个任务：首任务「梳理 transition 四要素与触发条件」，目标 `notes/css-transition/01-basics-trigger.md`；第二项依赖第一项，第三项依赖第一、二项，第四项依赖第三项。首任务通过后应仅解锁第二项，第三项仍 BLOCKED。首任务有两个精确标题规则（`transition 四要素`、`触发条件与示例`）、400 字符下限、覆盖 hover/class/JS 修改样式三种方式及代码示例的语义规则，以及唯一必答追问；规则 config 完整。

AI 已在 Git 忽略目录准备 `apps/worker/.local/r11-css-transition-note.md`，明确标注为 AI 辅助的链路验证样本，不冒充用户独立手写或模型准确率评测样本。用现有 AST 工具本地预检确认两个标题匹配、正文与代码 2073 个非空白字符；这只验证确定性条件，未调用语义模型、未写验收报告。学习仓库对应目标文件检查时不存在，AI 未修改该仓库或提交/推送。

用户确认 App Webhook 仍指向 VPS。下一步：页面确认计划并开始首任务；用户保留原 Webhook URL，临时改为 Smee 通道，用 `pnpm dlx smee-client@5.0.0 --url "<自己的 Smee 通道 URL>" --target "http://127.0.0.1:4000/webhooks/github"` 保持本地转发（参见 [smee-client 参数实现](https://github.com/probot/smee-client/blob/v5.0.0/bin/smee.js)）；再将样本放到首任务的完整目标路径，普通提交并推送到 main。转发和开始任务需先就绪再 Push；只读核对本机 Delivery/Run 后继续用户回答环节，观察结束后恢复 VPS Webhook。当前尚无这些后续操作的完成证据。

10/29 转发启动排查：用户原命令的 `--path /webhooks/github` 在 Git Bash 下被转换成 `D:/Git/webhooks/github`。已本地复现参数转换；smee-client 5.0.0 将 port 与 path 直接拼接，导致目标 URL 无效，错误发生在建立网络连接之前。改用完整 `--target` 后，已验证 Git Bash 保留该参数且 URL 可解析；实际 Smee 联通及转发仍待用户观察，不把参数校验成功记为转发成功。

随后用户 Push 后报告“已忽略”。本地验证库已收到 main 的真实 Push（after SHA 前缀 `9d210af`），Delivery 为 IGNORED / TARGET_NOT_CHANGED，后台已尝试 1 次且没有取证错误；尚无 Submission/AgentRun。计划已 ACTIVE，首任务 IN_PROGRESS / version 2，目标仍为 `notes/css-transition/01-basics-trigger.md`。只读文件检查发现学习仓库实际文件为 `notes/css-transition/01-basic-trigger.md`，basic 少了一个 s；正确目标文件不存在。下一步由用户将文件改为完整正确路径并普通提交/推送新 Commit；重投原通知不会修正原提交中的路径。本次只定位并记录，未改学习仓库或绕过路径校验；该真实接收记录已证明本地转发和验签可达，完整验收仍未通过。

用户修正路径并 Push 后取证成功（SHA 前缀 `4ed4265`，Delivery PROCESSED），随后观察到今日任务短暂消失再出现。只读核对：Task IN_PROGRESS v2→VERIFYING v3；笔记 Run 执行失败后恢复为 IN_PROGRESS v4。Run 错误为 MODEL_CALL_LIMIT_EXCEEDED；账本两次均为 NOTE_SEMANTICS，第一次 INITIAL、第二次 REPAIR，均 MODEL_OUTPUT_INVALID，每次输出 4096 Token，合计 12173 Token、估算 ¥0.261224。此时尚无正式报告或追问；输出达到上限最初只是截断线索，账本没有 finish_reason，随后通过下面的独立诊断确认原因。

10/29 模型排查与修复（独立诊断，不改写业务账本/终态）：

- [GLM-5.3 官方说明](https://docs.bigmodel.cn/cn/guide/models/text/glm-5.3)列出默认 `reasoning_effort=max`。对同一份已取证正文发起一次原配置诊断，HTTP 200、`finish_reason=length`、正文长度 0、输出 4096 Token，确认思考消耗完输出额度而没有完整 JSON。原适配器将其归为普通格式错误，又按同样额度修复，最终耗尽两次调用机会。
- 新增可选模型快照字段 `reasoningEffort`；R11 启动脚本明确选 low，笔记/追问/回答首次领取时冻结，实际请求发送 `reasoning_effort`。旧 Run 不自动改配置；调用次数、总 Token 和费用额度保持原值。识别 `MODEL_OUTPUT_TRUNCATED` 并保存用量，禁止按相同配置再进行格式修复；即使 SDK 容错解析出了对象也不能接受截断结果。
- low 的前两次诊断均返回完整 JSON（分别 581/575 输出 Token），但引用校验失败。只记录引用位置与匹配结果后确认：文字存在，模型给出的行号偏移；没有放宽引用校验。笔记、追问、回答适配器升级 v2 提示词，传入 `{ lineNumber, text }`，含空行，两个来源分别编号；旧 v1 Run 继续使用原提示与原输入格式。
- 最后一次 low + v2 诊断通过：输入 2630、输出 617、共 3247 Token，`finish_reason=stop`，三处引用逐字及行号校验均通过，语义结果 PASSED。四次诊断总计 14448 Token、估算 ¥0.232964（按普通输入/输出价格，含失败调用），单独于原业务 Run 的 ¥0.261224；未保存原始思考内容、未把诊断写成正式报告，也不计作固定模型评测。
- 工程验证：SDK/执行器等 109 项、R09 集成 35 项、R10 集成 36 项、R11 集成 41 项通过，相关 build/typecheck/lint 通过；覆盖截断保留用量且不重复调用、请求参数透传、旧 v1 兼容及首次配置冻结后环境变化不影响恢复。本地服务已重启。现有失败 Run 保持失败、Task 保持 IN_PROGRESS；下一步由用户对目标笔记作真实修改后普通提交/Push，创建新一轮 Run，再继续观察正式报告、追问、回答与解锁。未更新 VPS。

本轮同时修复今日任务列表遗漏：查询与 HTTP 契约统一使用 READY + CURRENT_TASK_STATES，包含 VERIFYING，继续排除 BLOCKED/PASSED；页面复用“验收中”状态标签，并将列表标题改为“当前任务”。验收中的任务保留查看入口，不开放开始操作；未新增轮询或 SSE。PostgreSQL 回归覆盖 IN_PROGRESS→VERIFYING→NEEDS_EVIDENCE 全程可见、阻塞任务排除及归属隔离；契约/Controller 6 项、仓储集成 1 项通过，API 构建、Web 类型与目标 lint 通过。本地服务已重启加载修改。该修复不代表模型失败已解决或完整闭环完成。

10/29 用户补充 duration/delay 说明并 Push 后，真实提交 `c25ee0806f21f6a24feb1ffa9256841b0bf2323c` 的验收已完成（只读核对，未手工改写状态）：

- Delivery `ad15a07e-d343-11f1-84aa-1bba1e3f66c9` 为 PROCESSED；笔记 Run `32abdfa9-17ef-4109-a461-c0158d8ccd5c` 为 SUCCEEDED，无错误码，冻结 low / note-verification-v2。
- 正式报告 `9aa5f8bd-5a71-4261-9d10-65824bece4d5`：两个标题、400 字符下限（实测 2245 个非空白字符）及三种触发方式覆盖共 4 项 PASSED，引用校验通过；唯一 FOLLOW_UP_ANSWER 仍待回答，followUp READY。
- 追问 `cb6073f0-848e-4424-965b-72402cd54bfb` 已持久化，询问基础样式与 hover 中配置 transition 的区别，以及 300ms duration / 150ms delay 和状态变化的关系。仅向用户展示问题，不提供内部 rubric 或代答。
- 首任务 IN_PROGRESS v4→VERIFYING v5→NEEDS_EVIDENCE v6，表示笔记已通过但尚缺追问回答；第二至第四任务仍 BLOCKED v0。笔记/追问分别一次调用，输出 575/608 Token，合计 6491 Token、估算 ¥0.075588，用量完整、无预算警告。原失败 Run 保持失败。
- R12 回答表单尚未接入；用户理解当前需通过已有 API 验证后，明确要求“答案你来发吧”。据此由 AI 提供参考答案，用于工程链路观察，不作为用户独立回答、掌握程度或模型准确率评测样本。之后使用当前登录会话提交已有回答 API，继续验证回答报告、Task PASSED 和依赖解锁；当前尚未创建 AnswerSubmission、不标记真实完整闭环通过。用户提出的动态额度优化暂不纳入开发计划。

10/29 用户在已登录的本地页面 Console 执行 `apps/worker/.local/r11-submit-answer.js`（AI 参考答案，命令先存 localStorage，重发复用 requestId），并反馈真实 HTTP 202 / ACCEPTED：

- AnswerSubmission `d37ffd9b-38af-47d4-acad-11563c36955a`，回答 Run `7f55961d-2e1f-4984-9e62-d0d91ebbfc94`，受理时 Task VERIFYING v7。API 使用现有会话与 Origin 校验，没有伪造用户会话或直接写业务数据。
- 只读核对 Run 已 SUCCEEDED，回答报告 `69820602-1828-4e03-a966-4aaf24c9b77a` 为 PASSED，笔记与回答引用均通过校验；来源仍固定为原追问、原笔记报告及 Commit `c25ee080`。首次模型调用成功，输入 4328、输出 660、合计 4988 Token，估算 ¥0.053104，用量完整且无预算警告。
- 首任务最终 PASSED v8；第二项「记录 transition 与 transform 的配合」READY v1；第三项仍依赖尚未通过的第二项，第三、四项均 BLOCKED v0。没有自动开始第二项或提前通过其他任务。
- 本轮成功的笔记验收、追问、回答验收共 3 次真实调用、11479 Token、估算 ¥0.128692；不包含先前失败和独立诊断费用。记录为真实后端业务闭环观察，不作为 AI 验收准确率或用户独立学习成果。
- 用户随后明确“ok，已观察”，确认首任务通过、第二项可开始及其他仍锁定的页面状态；今日学习排除已通过的首任务属于预期筛选。本地真实业务闭环和本段页面观察完成，无需重复 Push、模型调用或已通过回归。R11 固定评测、累计耗时及单元收尾仍待完成，R12 报告/回答页面尚未接入，未更新 VPS、不提前标记整个 R11 DONE。

### 5.38 R11 固定评测：区分格式、引用与判断正确性

15 份合成 Markdown 材料、16 项预期已固定，分别使用同一 GLM-5.3 low 配置运行 v1/v2 提示词，每份一次、共 30 次真实调用。实测及统计口径见 [R11 固定评测记录](evaluation/r11-fixed-evaluation.md)：v1 结论一致性 14/16、引用可定位 20/21；v2 分别为 15/16、21/21。两版均有一项把含糊表达判为明确错误，保留失败，不将批次完成等同于全部判断正确。按普通输入/输出价格估算两轮合计 ¥0.450940，与真实业务和先前诊断分开。

本段观察/导读目标 15 至 20 分钟，计入 R11 原 5 小时预算；用户已报告累计投入约 3.5 小时，不追加手写。先查看已保存结果即可，不需要重跑付费评测：

```powershell
pnpm eval:r11 --results
```

首读两个入口：

1. `apps/worker/scripts/r11-evaluation/cases.ts`：材料、验收要求及预期结果；重点看含糊笔记、易错行号、多标准和部分正确回答。
2. `apps/worker/scripts/r11-evaluation/evaluate.ts`：`prepareCase` 不泄漏预期，`evaluateCase` 复用正式验收/引用校验，`summarize` 保留失败与费用后统计。链路为“固定样本 → 一次模型判断 → 结构/引用校验 → 与预期比较 → 汇总”，不创建业务 Run 或改变 Task。

CLI `apps/worker/scripts/evaluate-verification.ts` 只负责选版本、串行执行和逐条保存；单元测试验证统计分母、坏引用及未知用量，不需要逐行阅读。以下命令不调用付费模型，也不连接数据库：

```powershell
pnpm eval:r11
pnpm exec vitest run apps/worker/test/r11-evaluation.spec.ts --reporter verbose
```

只有明确执行 `pnpm eval:r11 --run v1` 或 `pnpm eval:r11 --run v2` 才会调用真实模型，默认命令/CI 不调用；本轮已经各完成一次。手动运行会产生新结果文件，不覆盖先前记录；存在不一致时退出码为 1 是评测发现，不代表需要重试。每版最多 15 次、不自动修复；未知用量或已知费用达到 ¥2 时不继续下一条，不能将此停止阈值说成供应商侧硬限额。

本段统计单元用例 9 项、Worker 类型及目标 lint/格式通过。10/29 用户已确认结果观察与代码导读理解，并正确区分业务规则校验和模型判断的固定评测；AI 补充标准 ID、引用核对及预期标签需复核的边界，本段短复述通过。R11 具备单元收尾条件，DONE 随本次本地提交成功生效；M4 阶段记录/W3 独立收尾，R12 页面未开始。

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
