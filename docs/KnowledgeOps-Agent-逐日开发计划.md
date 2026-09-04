# KnowledgeOps Agent：9 月求职版逐日开发计划

## 1. 计划信息

| 项目 | 内容 |
| --- | --- |
| 制定日期 | 2026-07-31 |
| 最近更新 | 2026-09-04（08-10 全部日关卡完成，下一检查点为 08-11） |
| 开发窗口 | 2026-08-01 至 2026-09-02 |
| 发布缓冲 | 2026-09-03 至 2026-09-06 |
| 硬目标 | 9 月上旬得到可访问、可演示、可解释、可写入简历的生产版本 |
| 范围真相源 | `docs/KnowledgeOps-Agent-9月求职版PRD.md` 的 P0 |
| 执行范式 | 根目录 `AGENTS.md` 与 `$run-interview-project-stage` |

这是一份以阶段和每日双层关卡为约束的逐日倒排，不是无条件的日历承诺。每个计划日达到 AI 主体检查点后，必须先完成改动导读、用户代码阅读与理解确认，再完成约 30 分钟用户手写与 Review、每日微观问答、写档和每日 Git 提交，才能开始下一计划日；每个阶段还必须经过需求确认、设计讲解、用户授权、独立的 1 至 2 小时阶段核心手写与 Review、阶段宏观问答、文档沉淀和阶段收尾提交。若用户响应或技术风险导致延期，后续日期顺延并按本文件的裁剪规则恢复排期，不能跳过学习关卡。

## 2. 基线假设

- 用户工作日平均可投入 1.5 至 2.5 小时，周末可投入 3 至 4 小时；AI 承担绝大部分编码。
- 阶段启动日需要用户完成两次短确认：需求确认一次，架构讲解后授权一次。
- 每个计划日默认 1 道微观题，知识密度高时最多 2 道；每个阶段另有 2 至 4 道宏观题，均一次只问一道。
- 每个尚未完成的计划日先安排每日改动导读和首轮代码阅读，预计增加 15 至 40 分钟，用户追问时间另计；用户确认理解 AI 主体改动后，再进行一项 25 至 35 分钟基础手写，Review 预计 10 至 20 分钟；每日微观问答预计增加 10 至 20 分钟。
- 每个阶段在所有计划日 `DONE` 后另有一项 1 至 2 小时核心手写，Review 与代码复盘预计 20 至 40 分钟；阶段宏观问答预计增加 30 至 60 分钟。阶段核心手写、宏观问答和两个独立 commit 可以与最后计划日同一自然日完成，也可以顺延，但不能挤占或抵扣每日关卡。
- 从 08-05 到 09-06 尚有 33 个计划日；按每天 30 分钟计算，每日手写约 16.5 小时，六个阶段核心手写再增加 6 至 12 小时，合计约 22.5 至 28.5 小时，Review 与提问时间另计。这是用户主动选择的学习投入；若影响 9 月上线，优先裁剪 P1、装饰和额外抽象，不削减这两层手写。
- 一次只做一个活动计划、一个仓库、一个配置分支和 `MARKDOWN_NOTE` 一种任务类型。
- P0 不加入 pgvector、用户代码执行、多 Agent、MCP、多仓库或复杂自动重规划。
- P0 选择性引入 LangChain 的标准模型接口、供应商集成、Zod 结构化输出、只读工具包装和必要中间件；显式业务工作流、状态机、事务、引用校验与最终决策仍由项目代码掌握，LangChain 类型不进入共享 Contracts 或持久化模型。
- P0 由部署方通过服务端环境变量配置一个供应商、凭据和 1 至 2 个允许模型；用户只选择服务端模型目录中的稳定 ID，API Key、任意模型名和 Base URL 不进入客户端或数据库。
- LearningGoal 先持久化；计划生成接口事务写入 `PlanGenerationRun + OutboxEvent` 后返回 `202`，Dispatcher 与 BullMQ Worker 在后台调用 LangChain，前端先轮询状态，阶段 5 再按需接入 SSE。失败保留目标、不创建半份 Plan，用户重试创建关联新运行。
- P0 不启用 LangGraph Checkpointer、长期 Memory 或 Thread 作为恢复机制，也不让开放式 ReAct 循环控制整条验收链路；若固定评测证明动态取证有价值，只允许在单个语义步骤内使用受预算约束的只读子循环。
- `PlanGenerationRun` 是一次计划生成尝试；`AgentRun` 是一次笔记或回答验收尝试，`AgentStep` 是项目定义的显式验收步骤。LangChain 内部模型/工具调用与修复重试作为运行内技术记录，并与 BullMQ 共用统一调用次数、Token、成本和总耗时预算。
- 生产版本最迟在 9 月 2 日形成；9 月 3 日后的代码改动只修 P0 blocker。
- 每日改动导读与问答关卡从阶段 1 的 2026-08-01 开始；07-31 的阶段 0 仅用于配置协作范式，不做无代码价值的补问。
- 每日手写与阶段核心手写双层规则自 2026-08-06 起生效：08-05 及以后尚未完成的计划日执行；08-01 至 08-04 已完成且已提交，不追溯返工。08-04 已完成的 `isValidTaskTransition` 保留为历史手写记录，但不能抵扣阶段 1 新增的核心手写。

## 3. 求职交付物

截至 2026-09-02，必须具备：

1. 可访问的线上产品和不依赖私人仓库的固定 Demo；
2. GitHub Push → 证据 → 笔记验收 → 追问 → 回答验收 → 任务解锁的真实闭环；
3. 可重放的 SSE 时间线、幂等 Webhook、Outbox、失败重试和核心自动化测试；
4. README、架构图、至少 3 篇关键 ADR、2 至 4 分钟演示脚本或视频；
5. 至少 3 项真实测量数据，以及不夸大的简历表述；
6. 每个未完成计划日的基础手写代码、六个阶段各一份核心手写代码，以及每天的微观问答和阶段宏观问答记录。

## 4. 阶段看板

阶段状态只允许使用：

`NOT_STARTED` → `REQUIREMENTS_CONFIRMING` → `EXPLAINING` → `AI_IMPLEMENTING` → `WAITING_STAGE_CODE` → `REVIEWING_STAGE_CODE` → `STAGE_INTERVIEW_QA` → `STAGE_DOCUMENTING` → `DONE`

每日状态只允许使用：

`NOT_STARTED` → `WORKING` → `DAILY_WALKTHROUGH` → `DAILY_WAITING_USER_CODE` → `DAILY_REVIEWING` → `DAILY_INTERVIEW_QA` → `DAILY_DOCUMENTING` → `DONE`

遇到外部阻塞时可临时使用 `BLOCKED`，解除后回到阻塞前状态。一个计划日只有在 AI 主体检查点与验证、改动导读、用户理解确认、每日手写 Review、完整回归、每日问答、写档和范围受控的每日 Git 提交全部完成后才能标记为 `DONE`；提交失败时保持或恢复为 `DAILY_DOCUMENTING`。所有计划日 `DONE` 后才交付阶段核心手写；其 Review 和独立 commit 完成前不能进入阶段宏观问答。

| 阶段 | 计划日期 | 当前状态 | 下一关卡 | 实际完成 | 偏差或裁剪 |
| --- | --- | --- | --- | --- | --- |
| 0. 协作范式与倒排 | 07-31 | `DONE` | 阶段 1 需求确认 | 2026-07-31 | 无 |
| 1. 工程骨架与领域模型 | 08-01 ～ 08-05 | `DONE` | 阶段 2 需求确认 | 2026-08-07 | 08-01 计划日于 07-31 提前完成；08-02 计划日于 08-03 完成，将 Node 升级到 24.18.1 LTS，实测 PostgreSQL 14.23/Redis 7.4.10、三个应用、`check` 与 `build`，并修复 WSL 服务停止时的状态查询错误；08-03 计划日于 08-05 完成共享契约、独立状态、Prisma 初始迁移、健康探针、结构化日志、改动导读和 2 道微观题，业务库迁移与协议检查通过；WSL 管理面再次出现 `0xffffffff`，专用影子库的自动创建脚本已通过 Bash 语法检查；08-04 计划日于 08-06 完成最小应用壳、CI、测试夹具、Tailwind 设计令牌、改动导读和 2 道微观题，用户提前完成旧版状态迁移手写点且 Review 已通过；2026-08-06 起新增每日 30 分钟与阶段 1 至 2 小时双层手写关卡，已完成日期不返工；08-05 计划日于 08-06 完成 TestingModule 手写、Review、改动导读和 1 道微观题，完整 CI 回归为 12 个测试文件、44 个测试通过；阶段 1 核心恢复决策手写于 2026-08-07 完成 Review 和独立提交，专用验收 11 个测试及完整 CI 55 个测试通过；阶段宏观问答共 3 道并已写档；阶段收尾首次复验遇到 `LxssManager STOP_PENDING`，重启 Windows 后确认 Ubuntu 实际为 WSL 2，随后 `infra:up` 幂等启动服务，PostgreSQL 14.23 `SELECT 1`、Redis 7.4.10 `PING` 与 Prisma 迁移状态全部通过；阶段较原计划晚 2 天，原因是新增双层手写关卡和 WSL 环境故障，无 P0 功能裁剪；Compose 改在阶段 3 收尾日于 Linux VPS 验证 |
| 2. 目标、计划与基础工作台 | 08-06 ～ 08-11 | `AI_IMPLEMENTING` | 等待用户开始 08-11 计划日 | — | 阶段 1 实际于 2026-08-07 完成，阶段 2 排期从需求确认起顺延；已确认部署方管理模型凭据、用户选择白名单模型、无生成降级并在本阶段支持开始任务；用户于 2026-08-08 完成 08-06 全部日关卡并提交，随后明确用持久化异步计划生成替换请求内同步方案；由于 08-07 数据模型尚未开始，无产品代码返工，阶段 2 增加 1 个计划日并从阶段 3 前移 Outbox/BullMQ 基础链路；08-07 计划日于 2026-08-10 完成数据模型、事务化生成入口、Repository 手写与 Review、2 道微观题和真实 PostgreSQL 回归；08-08 计划日于 2026-08-11 完成服务端模型目录、框架无关生成端口、LangChain 适配器、结构化输出校验、Zod 跨任务手写、Review、2 道微观题和完整 CI 回归；08-09 主体改动于 2026-08-13 完成导读并获得用户理解确认，BullMQ API 手写 Review、专用验收和完整回归通过，2 道每日微观问答于 2026-09-03 完成并写档；提交前全仓检查再次通过，专用集成复跑因 WSL 管理面 `0xffffffff` 在连接 PostgreSQL 前被环境阻断，未出现业务断言失败；08-10 已完成 Worker 编排、终态/超时保护、生成状态查询、计划确认与任务启动主体实现；用户于 2026-09-04 确认理解主体改动并完成拓扑排序手写，最终 Review 确认无 blocking 问题，专用验收 6/6、PostgreSQL 集成 8/8、普通回归 128/128、`lint`、`typecheck`、格式和生产构建通过；集成测试夹具改为注入固定时钟，消除了不现实的超长定时器警告；两道每日微观问答已逐题完成并写入学习档案；原子成功落库器仍为阶段核心手写缺口 |
| 3. GitHub 与可靠异步链路 | 08-12 ～ 08-16 | `NOT_STARTED` | 等待阶段 2 | — | Outbox、BullMQ、Worker 基础设施已前移到阶段 2，阶段 3 聚焦 GitHub 授权、Webhook 幂等和 Diff Evidence |
| 4. Markdown 与 Agent 验收闭环 | 08-17 ～ 08-22 | `NOT_STARTED` | 等待阶段 3 | — | — |
| 5. SSE 与 Agent 运行工作台 | 08-23 ～ 08-27 | `NOT_STARTED` | 等待阶段 4 | — | — |
| 6. 测试、上线与求职包装 | 08-28 ～ 09-02 | `NOT_STARTED` | 等待阶段 5 | — | — |

任何时候只允许一个阶段和其中一个计划日处于活动状态。每次跨过阶段关卡、每日关卡、阶段结束或排期发生偏差时更新相应状态。

## 5. 阶段 1：工程骨架与领域模型

### 阶段目标

建立可持续开发的 Monorepo、进程边界、共享契约、数据库基础和状态机，让 Web、API、Worker 能在本地启动并共享可靠类型。

### 已确认的开发前提

- Windows 使用 Node.js 24.18.1 LTS 运行 Nuxt、NestJS API 与 Worker，并使用原生 pnpm workspace，不引入 Turborepo/Nx。
- 本机开发以 WSL2 Ubuntu 原生服务运行 PostgreSQL、Redis，不依赖 Docker Desktop、本地 Docker daemon 或镜像仓库；应用通过 `DATABASE_URL`/`REDIS_URL` 与具体启动方式解耦。
- WSL Docker Engine 虽曾短暂通过 daemon 验证，但后续启动服务导致 WSL 长时间无响应，因此不再作为开发关键路径。Compose 保留为部署资产，并在阶段 3 收尾日于 Linux VPS 提前 smoke，避免把环境漂移风险留到最终发布。
- 阶段 1 只定义鉴权上下文并使用仅开发环境可启用的固定测试用户；真实 GitHub 登录与 GitHub App 后续接入。
- 生产部署保持平台无关，前提是支持长驻 API/Worker、SSE、PostgreSQL、Redis、HTTPS 与安全环境变量。

### 逐日安排

| 日期 | 负责人 | 当日工作 | 每日手写（约 30 分钟） | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 08-01 周六 | 共同 | 确认 Monorepo、运行环境、鉴权开发策略和部署前提；确认后讲解 Web/API/Worker 边界、服务端状态、领域状态机和测试金字塔 | —（新规则生效前已完成） | 用户完成需求确认并在理解讲解后明确授权 | Web、API 与 Worker 为什么分进程 | `DONE` |
| 08-02 周日 | AI | 初始化 pnpm workspace、Nuxt、NestJS API、Worker、共享包；使用 WSL 原生 PostgreSQL/Redis；保留显式 VPS Compose 命令；建立 lint、format、typecheck、Vitest 和环境变量校验 | —（新规则生效前已完成） | 三个应用可启动，基础检查可一键执行，本机不依赖 Docker Desktop 或 Docker daemon | Monorepo 依赖边界与本地基础设施 | `DONE` |
| 08-03 周一 | AI | 定义共享 DTO/Zod Schema、Task 与 AgentRun 状态、错误码和基础 Prisma Schema；建立 health/readiness 与结构化日志 | —（新规则生效前已完成） | 契约不依赖具体 UI，状态迁移有单元测试 | 共享契约及 Task/AgentRun 状态分离 | `DONE` |
| 08-04 周二 | AI | 建立最小应用壳、CI 和测试夹具；完成旧版 `isValidTaskTransition` 手写与 Review | `isValidTaskTransition`（历史手写，已完成；不抵扣阶段核心手写） | 最小应用壳、CI、测试、Tailwind UI 和旧版手写均已完成 | CI、测试夹具与纯函数可测试性 | `DONE` |
| 08-05 周三 | 共同 | 补齐阶段 1 当日收尾验证；用户完成每日手写，AI Review、导读、每日问答、写档并创建每日 commit | 使用 Nest `TestingModule` 为 `HealthController` 手写一组 `live/ready` 控制器测试，理解 Controller、Provider 注入和 `503` 异常边界 | 每日手写 Review、相关回归、改动导读、每日问答和每日 commit 均完成；随后才交付阶段核心手写 | NestJS 测试模块、依赖注入与健康接口边界 | `DONE` |

### 阶段核心手写（每日计划全部 `DONE` 后，1 至 2 小时）

- 目标关卡日：08-05 每日 commit 之后；若同一自然日时间不足，阶段保持 `WAITING_STAGE_CODE` 并顺延，不启动阶段 2。
- 计划位置：`packages/contracts/src/domain/run-termination-recovery.ts` 及对应测试。
- 内容：实现并测试 Task/AgentRun 终止恢复决策器。输入包含当前 Task 状态与版本、Run 保存的预期版本和 `taskStateBeforeRun`、Run 终态；输出使用可辨识联合表达“允许恢复”或因版本过期、Task 已推进、Run 不可恢复而跳过。
- 必须解释：纯函数只决定是否应恢复，真正写库仍需使用 `id + expectedVersion + VERIFYING` 的原子条件更新；受影响行数为零时旧 Run 不能覆盖新状态。
- 面试价值：把双状态机、乐观并发、失败恢复、终态不可逆和可测试设计串成一个完整架构题。
- 历史说明：08-04 已完成的 `isValidTaskTransition` 仅作为每日级练习保留，不抵扣本任务。

### 阶段宏观题方向

前后端共享契约的边界、Task 与 AgentRun 为什么分离、状态机如何防止非法并发、Monorepo 的收益与代价。

### 阶段验收

- `pnpm infra:check` 可从 Windows 应用边界验证 WSL 原生 PostgreSQL/Redis，`pnpm dev` 可启动三个应用；Compose 在阶段 3 收尾日于 Linux VPS 完成提前 smoke；
- lint、typecheck、基础单测在 CI 通过；
- Task 和 AgentRun 有独立状态与非法迁移保护；
- 用户能画出浏览器、API、队列 Worker、PostgreSQL 和 Redis 的职责图。

## 6. 阶段 2：目标、计划与基础工作台

### 阶段目标

完成“选择允许模型 → 持久化目标 → 创建生成运行与 Outbox → BullMQ Worker 调用模型 → 原子创建计划草稿 → 用户确认 → 首任务解锁并开始任务”的纵向闭环，并建立正确的前端服务端状态管理方式。

### 逐日安排

| 日期 | 负责人 | 当日工作 | 每日手写（约 30 分钟） | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 08-06 周四 | 共同 | 确认目标表单、计划规模、部署方模型目录、无降级失败语义、选择性 LangChain 边界和页面范围；讲解 Prisma 数据模型、事务、计划 DAG、TanStack Query 与 Pinia 职责；建立目标输入契约骨架、黑盒验收和模型边界 ADR | 用 Zod 手写目标创建输入 Schema，完成日期、每周时长和字符串边界校验 | 用户确认并授权；明确服务端持有 Key、用户只选白名单模型，LangChain 只负责模型与结构化输出适配；每日改动导读与理解确认、手写 Review、问答与 commit 完成 | 运行时输入契约与模型适配边界 | `DONE` |
| 08-07 周五 | AI | 完成 User 模型偏好、LearningGoal、PlanGenerationRun、Plan 生成快照、Stage、Task、Criterion、依赖关系和 OutboxEvent 的迁移、Repository 层与 API 契约；明确计划生成运行与任务验收 AgentRun 的边界 | 手写一个 Prisma Repository 查询，使用 `include/select` 读取计划、阶段和任务并保持返回类型明确 | 对已持久化目标发起生成时，事务写入 `QUEUED` 运行和 Outbox，返回 `202 + generationRunId`；数据库不保存模型密钥；每日手写关卡完成 | 关系建模、生成运行状态与 Repository 边界 | `DONE` |
| 08-08 周六 | AI | 完成服务端模型目录、框架无关的计划生成端口、LangChain 适配器和受 Zod Schema 约束的计划输出；完成数量、日期基础校验，为依赖引用与后续 DAG 环检测建立契约和测试夹具，不启用 Agent 循环、图持久化或规则降级 | 用 Zod `superRefine` 手写任务 ID 唯一、依赖存在且不能依赖自身的跨字段校验及失败用例 | Fake/真实模型共享同一业务端口；结构或引用非法的输出在进入 Repository 前被拒绝，真实调用失败不创建 Plan；每日手写关卡完成 | LangChain 适配边界、结构化输出与 Schema 校验 | `DONE` |
| 08-09 周日 | AI | 完成 Outbox Dispatcher、稳定 `plan-generation-{runId}` Job ID、BullMQ 队列、Worker 骨架、未分发事件补扫和重试分类，并建立本地异步链路集成测试 | 手写一次 `Queue.add`/Worker 注册与 `attempts/backoff/jobId` 配置，并为稳定 Job ID 补边界测试 | 数据库提交后最终可入队；重复分发不产生第二个 Job，Dispatcher/Worker 重启可恢复；每日手写关卡完成 | Outbox、至少一次投递与稳定 Job ID | `DONE` |
| 08-10 周一 | AI | 完成 Worker 调用 LangChain、失败终态、`deadlineAt` 超时扫描、生成状态查询、重复 Job 短路、计划确认事务、首任务解锁和 `READY → IN_PROGRESS`；为阶段核心的原子成功落库器准备接口与黑盒测试 | 实现基于 DFS 三色标记或拓扑排序的 DAG 环检测纯函数 | 失败不创建半份 Plan，超时或其他终态运行不可复活；重复确认和开始任务幂等；除阶段核心成功落库器外链路就绪；每日手写关卡完成 | Worker 状态机、失败原子性与 DAG 校验 | `DONE` |
| 08-11 周二 | 共同 | 完成模型选择、目标表单、生成状态轮询、计划预览、今日任务、任务详情基础页、刷新恢复和 loading/error/empty 状态，并完成阶段回归及核心手写夹具 | 在 Nuxt 中手写 TanStack Query 轮询：非终态退避、终态停止、失败展示和相关 Query 失效 | 刷新后可恢复生成状态，不展示半份计划且不把服务端实体复制进 Pinia；问答和每日 commit 完成后交付阶段核心手写 | TanStack Query 轮询、缓存边界与页面一致性 | `NOT_STARTED` |

### 阶段核心手写（每日计划全部 `DONE` 后，1 至 2 小时）

- 目标关卡日：08-11 每日 commit 之后；未通过 Review 和独立 commit 前不启动阶段 3。
- 计划位置：`apps/worker/src/plan-generation/finalize-plan-generation-run.ts` 及对应集成测试（以阶段实现后的实际模块路径为准）。
- 内容：在已有 Repository 与事务边界上实现一次生成成功的原子落库：只有 `RUNNING` 且版本匹配的 PlanGenerationRun 可以写入完整 Plan/Stage/Task/Criterion/依赖图并进入 `SUCCEEDED`；重复 BullMQ Job 返回既有结果，过期或终态运行不得覆盖新状态，任一步失败不得留下半份计划。
- 面试价值：同时训练 Worker、Prisma 事务、至少一次投递下的业务幂等、状态机、乐观并发、DAG 不变量和不可变运行记录。

### 阶段宏观题方向

请求内流式响应与可恢复后台任务的区别、Outbox/BullMQ 至少一次投递、PlanGenerationRun 与 AgentRun 的边界、服务端状态与 Pinia、完整计划图原子落库、DAG/Schema 校验、LangChain 与业务用例接口的边界，以及 LLM 非确定性。

### 阶段验收

- 用户无需改数据库即可创建目标，生成接口在持久化运行与 Outbox 后快速返回 `202`；
- 部署方持有模型凭据，用户只能选择服务端白名单模型；数据库与客户端不保存 API Key，模型失败时不降级；
- 页面刷新后能够通过 generationRunId 恢复状态；同一 Job 重放三次也只产生一份完整计划，失败运行保留原因且重试创建关联新运行；
- 模型失败、输出非法或 Worker 在落库中途异常时不得留下半份 Plan；终态 PlanGenerationRun 不可被旧 Job 覆盖；
- 计划始终为 1 至 3 个阶段、3 至 8 个任务且无环；
- 确认后只有满足依赖的任务进入 `READY`；
- 计划生成可在测试 Fake 与真实 LangChain 模型实现间切换，框架类型不泄漏到 REST DTO、共享 Contracts 或 Prisma 模型；
- 用户可以把一个 `READY` 任务连同目标 Markdown 路径原子推进到 `IN_PROGRESS`，且同一时间只有一个执行中或等待验收的任务；
- 页面刷新后状态来自服务端，不依赖 Pinia 复制实体。

## 7. 阶段 3：GitHub 与可靠异步链路

### 阶段目标

复用阶段 2 已建立的 Outbox、BullMQ 与 Worker 基础设施，完成真实 GitHub 登录、App 安装、仓库绑定和 Push 处理，使一次目标分支 Markdown 提交能够可靠生成 AgentRun 并保存 Diff 证据。

### 逐日安排

| 日期 | 负责人 | 当日工作 | 每日手写（约 30 分钟） | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 08-12 周三 | 共同 | 确认 GitHub App 权限、单仓库/单分支限制、异常 Push 行为和阶段 2 队列基础设施的复用边界；讲解 HMAC、Delivery 幂等和至少一次投递 | 实现 `sha256=` 前缀、HMAC SHA-256 和常量时间比较的 Webhook 签名校验 | 用户确认并授权；明确 HTTP 重放、Outbox 重发与 BullMQ 重试的不同幂等边界；每日手写关卡完成 | HMAC 可信性与幂等边界 | `NOT_STARTED` |
| 08-13 周四 | AI | 完成 GitHub 登录、App Installation 回调、选定仓库绑定/解绑、权限披露和设置页 | 使用 Nest `TestingModule` 手写 Installation 回调 Controller 的成功与拒绝用例 | 可用测试账号绑定一个仓库；每日手写关卡完成 | GitHub App 权限与 Installation 生命周期 | `NOT_STARTED` |
| 08-14 周五 | AI | 完成 raw body 接收、事件过滤、Delivery 唯一键，以及 WebhookDelivery/Submission/AgentRun/Outbox 同事务写入与快速 `202`；复用稳定 Job ID 与 Dispatcher | 手写 Delivery ID 规范化和唯一冲突处理测试，区分 HTTP 重放、Outbox 重发与 BullMQ 重试 | 重放 Delivery 不重复创建有效运行；数据库提交后最终可进入既有队列；每日手写关卡完成 | Delivery 唯一约束与三层重复投递 | `NOT_STARTED` |
| 08-15 周六 | AI | 完成 Commit compare、Markdown 路径匹配、Diff/快照/哈希/行号 Evidence 持久化，以及 Webhook → Dispatcher → Worker 链路集成测试 | 手写 GitHub compare 响应到 Markdown Evidence 的窄化/过滤函数及多文件边界用例 | 真实 Push 能产生可查看的证据，Worker 重试不重复保存业务结果；每日手写关卡完成 | Diff Evidence 的完整性与任务匹配 | `NOT_STARTED` |
| 08-16 周日 | 共同 | 完成异常 Push、重放和 Worker 恢复回归；在 Linux VPS 用 Compose 验证 PostgreSQL/Redis 与队列基础设施并收尾 | 手写“相同 Delivery 三次重放只产生一份有效运行”的集成测试断言 | 三次重放、Dispatcher/Worker 重启和 VPS smoke 通过；问答和每日 commit 完成后交付阶段核心手写 | 重复投递、唯一约束与集成测试证据 | `NOT_STARTED` |

### 阶段核心手写（每日计划全部 `DONE` 后，1 至 2 小时）

- 目标关卡日：08-16 每日 commit 之后；未通过 Review 和独立 commit 前不启动阶段 4。
- 计划位置：`apps/api/src/modules/github/accept-push-delivery.service.ts` 及对应集成测试（以阶段实现后的实际模块路径为准）。
- 内容：实现 Webhook 接收应用服务的核心事务：签名和事件过滤完成后，以 Delivery 唯一键保证幂等，在同一 PostgreSQL 事务内创建 Delivery、Submission、AgentRun 与 OutboxEvent；重复请求返回既有结果，事务失败不得留下半套数据，HTTP 层只在提交后返回 `202`。
- 面试价值：把 NestJS 边界、PostgreSQL 事务与唯一约束、Outbox、BullMQ 至少一次投递、稳定 Job ID 和故障恢复串成真实可靠性闭环。

### 阶段宏观题方向

GitHub App 与 OAuth/PAT 的区别、签名校验、幂等键、Outbox 解决的问题、PostgreSQL 与 Redis 的职责边界。

### 阶段验收

- GitHub App 仅请求 P0 所需最小权限；
- 相同 Delivery 重放三次只产生一份有效业务结果；
- Webhook 在持久化后快速返回 `202`；
- Worker 崩溃或 Dispatcher 重启不会让已提交 Outbox 永久丢失；
- Linux VPS 已实际执行 Compose 基础设施 smoke，PostgreSQL/Redis 未暴露公网端口；
- 真实 Markdown Push 能保存可定位 Evidence。

## 8. 阶段 4：Markdown 与 Agent 验收闭环

### 阶段目标

完成确定性检查、受控 Agent 语义验收、引用、追问和回答验收，让一个真实 Markdown 任务最终进入 `PASSED` 并解锁后续任务。

### 逐日安排

| 日期 | 负责人 | 当日工作 | 每日手写（约 30 分钟） | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 08-17 周一 | 共同 | 确认 Rubric、三态结论、引用要求、统一模型/工具预算、LangChain 与 AgentRun/AgentStep 边界和 Prompt Injection 防护；讲解 Markdown AST、确定性/语义分层、结构化输出、两类独立 Run 和评测集 | 使用 Markdown AST API 手写标题收集 Visitor，并处理嵌套节点和空标题 | 用户确认并授权；确认是否有评测证据需要受限 ReAct 子循环；每日手写关卡完成 | 确定性/语义分层、框架边界与 Prompt Injection | `NOT_STARTED` |
| 08-18 周二 | AI | 完成 Markdown AST 分块、章节/字数/文件变更规则、Commit 行号映射和引用再定位 | 手写一项确定性 `SECTION_PRESENT` 检查或引用行号定位函数及表驱动测试 | 确定性标准不调用模型且结果可复现；每日手写关卡完成 | Markdown AST 与引用行号可定位性 | `NOT_STARTED` |
| 08-19 周三 | AI | 在 agent-core 中复用 LangChain 模型/供应商接口、Zod 结构化输出和只读 Tool 包装，保留项目自有显式步骤编排；完成有限修复重试、统一预算、超时/取消检查和 Prompt 版本，不启用 LangGraph Checkpoint/Memory | 手写 LLM 结构化输出的 Zod 解析函数，限制一次修复重试并区分 Schema 错误与上游错误 | 非法模型输出不能改变任务状态；LangChain 内部调用可映射到 runId/stepId 且不会与 BullMQ 形成重试放大；每日手写关卡完成 | 结构化输出、工具边界、重试分层与失败恢复 | `NOT_STARTED` |
| 08-20 周四 | AI | 完成笔记语义验收、CriterionResult、报告、引用联动、1 至 3 个追问和 `NEEDS_REVISION/NEEDS_EVIDENCE` 推进 | 根据必要/可选标准及三态结果实现 `deriveTaskOutcome` 纯函数 | 笔记运行生成可解释报告；每日手写关卡完成 | 三态验收、引用与追问生成 | `NOT_STARTED` |
| 08-21 周五 | AI | 完成回答提交与独立验收、旧追问失效、任务通过/后续解锁、至少 15 个固定样本和核心集成测试 | 为固定评测样本手写一组结果断言，覆盖错误通过、证据不足和引用不可定位 | 单任务完整闭环自动化通过；每日手写关卡完成 | Note/Answer Run 分离与固定评测集 | `NOT_STARTED` |
| 08-22 周六 | 共同 | 完成阶段 4 当日回归、安全边界修正与收尾 | 手写“新笔记生效后旧追问不得完成任务”的领域或集成测试 | 每日改动导读与理解确认、手写 Review、相关回归、问答和每日 commit 完成；随后交付阶段核心手写 | 旧证据失效、运行边界与业务状态推导 | `NOT_STARTED` |

### 阶段核心手写（每日计划全部 `DONE` 后，1 至 2 小时）

- 目标关卡日：08-22 每日 commit 之后；未通过 Review 和独立 commit 前不启动阶段 5。
- 计划位置：`packages/agent-core/src/verification/finalize-verification-run.ts` 及对应测试（以阶段实现后的实际路径为准）。
- 内容：实现一次验收运行的最终决策与持久化编排：校验结构化结果和引用、按必要标准优先级推导稳定 Task 状态、区分笔记/回答 Run、拒绝过期 Submission 或旧追问、成功时生成不可覆盖报告并解锁后续任务，失败时不得写入部分业务结果；LangChain 只提供候选结构化结果，不能直接写 Task、Report 或控制事务。
- 面试价值：覆盖 Agent 受控工作流、确定性与语义分层、三态业务规则、证据引用、不可变记录、并发失效与事务边界，是本产品最核心的业务逻辑之一。

### 阶段宏观题方向

为何选择性使用 LangChain 而不交出业务状态、为何不用开放式多 Agent、确定性与语义验收如何组合、结构化输出失败怎么办、LangChain/BullMQ 重试如何分层、Prompt Injection 防护和 Agent 评测指标。

### 阶段验收

- 一次笔记 Push 可以产生逐项报告、真实引用和追问；
- 回答验收使用新的 AgentRun，不让 Worker 等待用户；
- 新笔记会使绑定旧 Submission 的追问失效；
- 只有全部必要标准和必答追问通过才能进入 `PASSED`；
- AgentRun/AgentStep/RunEvent 与业务实体仍以 PostgreSQL 为唯一真相源，LangChain 内部状态不可单独驱动恢复或前端最终状态；
- 模型、工具、结构化输出修复与 BullMQ 共享统一预算，固定评测未证明收益时不启用 ReAct 子循环；
- 固定评测集能够比较 Schema 成功率、错误通过率与引用可定位率。

## 9. 阶段 5：SSE 与 Agent 运行工作台

### 阶段目标

建立可重放的实时运行体验，完成 Agent 时间线、Diff/引用联动、断线恢复、取消和重试，并体现前端架构与性能能力。

### 逐日安排

| 日期 | 负责人 | 当日工作 | 每日手写（约 30 分钟） | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 08-23 周日 | 共同 | 确认时间线事件、重连语义、取消/重试交互和 Monaco 范围；讲解持久化事件、Redis 通知、SSE replay/live 竞态、Reducer 与 Query 缓存边界 | 手写 `Last-Event-ID`/cursor 的 Zod 校验和下一序列号计算函数 | 用户确认并授权；每日手写关卡完成 | SSE replay/live 与前端状态边界 | `NOT_STARTED` |
| 08-24 周一 | AI | 完成 RunEvent 序列分配、先落库后通知、SSE 鉴权、历史重放、实时订阅、心跳和订阅清理 | 使用 NestJS Observable/async stream API 手写 SSE 心跳与取消清理片段及测试 | API 可按最后事件 ID 补发；每日手写关卡完成 | 事件持久化、序列号、鉴权与心跳 | `NOT_STARTED` |
| 08-25 周二 | AI | 完成运行详情、步骤时间线、状态与耗时、Markdown Diff、引用定位、报告和 Monaco 客户端懒加载 | 在 Nuxt 客户端组件中手写 Monaco 动态导入和引用行定位函数，验证不进入公共页首屏 | 主流程可以完整演示；每日手写关卡完成 | 时间线渲染、引用联动与懒加载 | `NOT_STARTED` |
| 08-26 周三 | AI | 完成断线/刷新、重复/乱序事件、replay/live 衔接、取消、关联重试、错误/加载/空状态和相关测试 | 按 `(runId, sequence)` 实现 RunEvent Reducer 的去重、排序和幂等更新 | 重连后时间线无缺失无重复；每日手写关卡完成 | 重连竞态、重复乱序与取消重试 | `NOT_STARTED` |
| 08-27 周四 | 共同 | 完成阶段 5 当日性能检查、回归与收尾 | 手写 Reducer/Composable 的乱序、重复和 replay/live 交界测试 | 每日改动导读与理解确认、手写 Review、相关回归、问答和每日 commit 完成；随后交付阶段核心手写 | Reducer 幂等、排序与渲染性能 | `NOT_STARTED` |

### 阶段核心手写（每日计划全部 `DONE` 后，1 至 2 小时）

- 目标关卡日：08-27 每日 commit 之后；未通过 Review 和独立 commit 前不启动阶段 6。
- 计划位置：`apps/web/app/composables/use-run-event-stream.ts` 及对应 Vitest（以阶段实现后的实际路径为准）。
- 内容：实现运行事件流协调器：先按 cursor 拉取 replay，再接 live SSE；对重复/乱序事件幂等归并，检测间隙并补拉，断线指数退避且刷新后恢复；终态后正确停止订阅，并明确与 TanStack Query 服务端实体缓存、局部流式状态的边界。
- 面试价值：集中展示 Vue/Nuxt 主场能力、流式 UI、前端状态架构、竞态处理、网络恢复、不可变 Reducer 和渲染性能。

### 阶段宏观题方向

SSE 与 WebSocket 取舍、断线重放竞态、事件去重、TanStack Query 与 Pinia、Monaco 懒加载和长列表性能。

### 阶段验收

- 刷新或断网重连后事件无缺失、无重复；
- 用户只能订阅自己有权限的运行；
- 取消在 Worker 步骤边界生效，重试创建新 Run；
- 点击报告引用能够定位到指定 Commit 文件行；
- Monaco 不进入公共首页首屏包。

## 10. 阶段 6：测试、上线与求职包装

### 阶段目标

把功能闭环变成可公开访问、可稳定演示、可量化、可讲解的求职作品，并补齐测试、性能、安全和文档证据。

### 逐日安排

| 日期 | 负责人 | 当日工作 | 每日手写（约 30 分钟） | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- | --- |
| 08-28 周五 | 共同 | 冻结 P0；确认部署平台、域名/密钥、固定 Demo 和公开材料边界；讲解测试金字塔、故障注入、可观测、Web 性能和简历指标真实性 | 为同一业务不变量各手写一个单元/集成/E2E 测试草案，并明确每层 Mock 边界 | 用户确认并授权；每日手写关卡完成 | 测试分层、部署边界与指标真实性 | `NOT_STARTED` |
| 08-29 周六 | AI | 补齐核心单元、Webhook→Worker 集成、完整 E2E、越权检查和三处 Worker 故障注入 | 手写一项 Worker 在结果持久化前崩溃的故障注入集成测试 | CI 稳定覆盖产品与工程闭环；每日手写关卡完成 | 测试层级、Mock 边界与故障注入 | `NOT_STARTED` |
| 08-30 周日 | AI | 部署 Web/API/Worker/PostgreSQL/Redis，配置迁移、密钥、健康检查、结构化日志、Trace ID 和回滚说明 | 手写 GitHub Actions 部署 Job 中的迁移、readiness smoke、失败终止和并发保护步骤 | 生产环境可完成 smoke test；每日手写关卡完成 | 密钥、迁移、健康检查与可观测链路 | `NOT_STARTED` |
| 08-31 周一 | AI | 优化公共页首屏、Monaco 懒加载、基础可访问性和移动端；测量性能、重放可靠性、Agent 效果/成本 | 手写 Playwright 的移动端、键盘焦点与 Monaco 首屏未加载断言 | 得到至少 3 项可复现实测数据；每日手写关卡完成 | Web 性能、可访问性与指标测量 | `NOT_STARTED` |
| 09-01 周二 | AI | 完成固定 Demo、README、架构图、至少 3 篇 ADR、演示脚本和简历 bullet 初稿 | 在已有 fixture/page object 上补全“刷新或重连后时间线事件无缺失、无重复”的 Playwright 断言 | 求职材料与代码一致；每日手写关卡完成 | E2E 断言、flaky 控制与简历事实边界 | `NOT_STARTED` |
| 09-02 周三 | 共同 | 生产 smoke、形成 v1.0 候选版本、冻结简历表述并完成当日收尾 | 手写可重复执行的发布后 smoke 脚本，校验公共页、API readiness、固定 Demo 和核心授权边界 | 每日改动导读与理解确认、手写 Review、相关回归、问答和每日 commit 完成，候选版本通过 smoke；随后交付阶段核心手写 | 发布验证、回滚与三分钟项目叙述 | `NOT_STARTED` |

### 阶段核心手写（每日计划全部 `DONE` 后，1 至 2 小时）

- 目标关卡日：09-02 每日 commit 之后；未通过 Review、独立 commit 和宏观问答前不宣布 v1.0 求职版阶段完成。
- 计划位置：`tests/e2e/knowledge-verification-loop.spec.ts` 及必要的已有 fixture/page object 调用。
- 内容：独立补全一条关键闭环 E2E：创建并确认计划、模拟合法 GitHub Push、观察运行与报告、提交追问答案、任务通过并解锁下一项；至少加入一次刷新/重连或 Worker 故障恢复断言，并使用稳定等待条件避免 sleep 型 flaky。
- 面试价值：要求用户从浏览器行为反推 API、数据库、队列、Worker 和 SSE 的完整数据流，同时训练 Playwright、测试分层、故障设计和简历事实边界。

### 阶段宏观题方向

测试分层与 mock 边界、故障注入、线上观测、Core Web Vitals、部署取舍、真实指标如何转化为简历表述。

### 阶段验收

- PRD 第 19 节产品、工程和求职展示闭环全部满足；
- CI 稳定，生产日志能串联 Webhook、AgentRun 和 Worker；
- 有固定 Demo、README、ADR、演示脚本/视频和真实指标；
- 用户能够在 3 分钟内讲清产品价值、架构、最大难点、技术取舍和量化结果。

## 11. 发布缓冲：2026-09-03 至 2026-09-06

| 日期 | 工作 | 每日手写（约 30 分钟） | 禁止事项 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 09-03 周四 | 观察生产运行、复跑幂等/断线/失败用例，只修 P0 blocker | 针对当天最高优先级真实故障或风险补一条最小回归测试；若无故障，则补重复 Delivery 生产配置回归 | 不加新功能 | 生产故障定位与回归边界 | `NOT_STARTED` |
| 09-04 周五 | 用户录制 2 至 4 分钟演示；校对 README、隐私说明、截图和线上链接 | 手写公共 Demo/隐私页的 Playwright 检查，确保无私人数据、工作台 `noindex` 且关键链接有效 | 不改核心架构 | Demo 叙事、隐私与公开信息边界 | `NOT_STARTED` |
| 09-05 周六 | 完成一次全项目模拟面试，依据 `问答.md` 复习薄弱点；定稿简历项目经历 | 从 `问答.md` 重复薄弱点中选择一个真实核心函数，在 30 分钟内脱离 AI 重写简化版及测试 | 不使用未经测量的数字 | 重复薄弱点与简历追问 | `NOT_STARTED` |
| 09-06 周日 | 最终 smoke、备份 Demo 数据、整理投递链接和面试讲解提纲 | 手写 Demo 数据备份后的恢复校验脚本，至少验证记录数量、关键外键和固定 Demo 可读取 | 不因包装需求扩大 P0 | 发布兜底、数据备份与故障恢复 | `NOT_STARTED` |

若 9 月 2 日前已稳定完成，缓冲日用于真实使用和投递；若仍有 blocker，只修复 blocker，并在阶段看板记录实际完成日期。

## 12. 里程碑与强制复盘

| 截止日期 | 里程碑 | 未达到时的动作 |
| --- | --- | --- |
| 08-05 | 工程骨架与状态机可运行 | 取消非必要 UI 基建，不增加共享包 |
| 08-11 | 异步目标到首任务解锁闭环 | 冻结装饰页面；生成状态保留轮询，不提前实现 PlanGeneration SSE |
| 08-16 | 真实 Push 能保存 Diff Evidence | 暂不做人工多任务匹配 UI，只明确报错 |
| 08-22 | 单任务能走到 `PASSED` | 冻结报告美化，优先修验收正确性 |
| 08-27 | SSE 工作台可断线恢复 | 取消虚拟列表等 P1，只保留核心时间线 |
| 09-02 | 生产 v1.0 可投递 | 停止所有功能开发，只修阻塞问题 |

每个阶段结束时，在每日问答与阶段宏观问答之外，再回答四个排期复盘问题并记录到阶段看板：

1. 实际交付是否覆盖验收标准？
2. 哪项工作比预期更慢，根因是什么？
3. 用户对哪个知识点仍解释不清？
4. 下一阶段是否需要裁剪，而不是简单顺延？

## 13. 排期恢复与裁剪规则

进度落后 1 天：使用下一阶段的首个 AI 编码日吸收，但保留需求/授权关卡、每日手写与 Review、每日改动导读与理解确认、每日问答、阶段核心手写和阶段宏观问答。

进度落后 2 天：立即做 15 分钟范围复盘，删除 P1、视觉装饰、非关键筛选和额外抽象。

进度落后 3 天及以上：按 PRD 第 22 节裁剪；页面可退化，以下能力不得用 Mock 冒充：

- GitHub App 与真实 Push；
- Webhook 签名、幂等和队列处理；
- Markdown Diff、引用与确定性/语义验收；
- 追问回答和任务状态推进；
- SSE 重连重放；
- 失败重试、线上部署和核心自动化测试。

无论落后多少天，都不得跳过每日手写与 Review、阶段核心手写、每日改动导读与理解确认、每日微观问答、每日 Git 提交、阶段宏观问答或伪造指标追赶；也不得把多天手写堆到同一天，或临时增加超出每日 30 分钟与阶段 1 至 2 小时目标的手写量来追赶。
