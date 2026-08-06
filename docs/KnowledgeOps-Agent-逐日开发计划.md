# KnowledgeOps Agent：9 月求职版逐日开发计划

## 1. 计划信息

| 项目 | 内容 |
| --- | --- |
| 制定日期 | 2026-07-31 |
| 开发窗口 | 2026-08-01 至 2026-09-02 |
| 发布缓冲 | 2026-09-03 至 2026-09-06 |
| 硬目标 | 9 月上旬得到可访问、可演示、可解释、可写入简历的生产版本 |
| 范围真相源 | `docs/KnowledgeOps-Agent-9月求职版PRD.md` 的 P0 |
| 执行范式 | 根目录 `AGENTS.md` 与 `$run-interview-project-stage` |

这是一份以阶段和每日双层关卡为约束的逐日倒排，不是无条件的日历承诺。每个计划日达到检查点后必须完成改动导读、用户理解确认、每日微观问答、写档和每日 Git 提交，才能开始下一计划日；每个阶段还必须经过需求确认、设计讲解、用户授权、用户手写 Review、阶段宏观问答、文档沉淀和阶段收尾提交。若用户响应或技术风险导致延期，后续日期顺延并按本文件的裁剪规则恢复排期，不能跳过学习关卡。

## 2. 基线假设

- 用户工作日平均可投入 1.5 至 2.5 小时，周末可投入 3 至 4 小时；AI 承担绝大部分编码。
- 阶段启动日需要用户完成两次短确认：需求确认一次，架构讲解后授权一次。
- 每个计划日默认 1 道微观题，知识密度高时最多 2 道；每个阶段另有 2 至 4 道宏观题，均一次只问一道。
- 每日改动导读和首轮代码阅读预计增加 15 至 40 分钟，用户追问时间另计；每日微观问答预计增加 10 至 20 分钟；阶段宏观问答预计增加 30 至 60 分钟，阶段收尾日应预留相应时间。
- 用户手写点每阶段 1 个，目标 20 至 30 分钟；Review、每日微观问答和阶段宏观问答另计。
- 一次只做一个活动计划、一个仓库、一个配置分支和 `MARKDOWN_NOTE` 一种任务类型。
- P0 不加入 pgvector、用户代码执行、多 Agent、MCP、多仓库或复杂自动重规划。
- 生产版本最迟在 9 月 2 日形成；9 月 3 日后的代码改动只修 P0 blocker。
- 每日改动导读与问答关卡从阶段 1 的 2026-08-01 开始；07-31 的阶段 0 仅用于配置协作范式，不做无代码价值的补问。

## 3. 求职交付物

截至 2026-09-02，必须具备：

1. 可访问的线上产品和不依赖私人仓库的固定 Demo；
2. GitHub Push → 证据 → 笔记验收 → 追问 → 回答验收 → 任务解锁的真实闭环；
3. 可重放的 SSE 时间线、幂等 Webhook、Outbox、失败重试和核心自动化测试；
4. README、架构图、至少 3 篇关键 ADR、2 至 4 分钟演示脚本或视频；
5. 至少 3 项真实测量数据，以及不夸大的简历表述；
6. 六个阶段的手写代码、每天的微观问答和阶段宏观问答记录。

## 4. 阶段看板

阶段状态只允许使用：

`NOT_STARTED` → `REQUIREMENTS_CONFIRMING` → `EXPLAINING` → `AI_IMPLEMENTING` → `WAITING_USER_CODE` → `REVIEWING` → `STAGE_INTERVIEW_QA` → `STAGE_DOCUMENTING` → `DONE`

每日状态只允许使用：

`NOT_STARTED` → `WORKING` → `DAILY_WALKTHROUGH` → `DAILY_INTERVIEW_QA` → `DAILY_DOCUMENTING` → `DONE`

遇到外部阻塞时可临时使用 `BLOCKED`，解除后回到阻塞前状态。一个计划日只有在检查点、验证、改动导读、用户理解确认、每日问答、写档和范围受控的每日 Git 提交全部完成后才能标记为 `DONE`；提交失败时保持或恢复为 `DAILY_DOCUMENTING`。

| 阶段 | 计划日期 | 当前状态 | 下一关卡 | 实际完成 | 偏差或裁剪 |
| --- | --- | --- | --- | --- | --- |
| 0. 协作范式与倒排 | 07-31 | `DONE` | 阶段 1 需求确认 | 2026-07-31 | 无 |
| 1. 工程骨架与领域模型 | 08-01 ～ 08-05 | `AI_IMPLEMENTING` | 开始 08-05 计划日 | — | 08-01 计划日于 07-31 提前完成；08-02 计划日于 08-03 完成，将 Node 升级到 24.18.1 LTS，实测 PostgreSQL 14.23/Redis 7.4.10、三个应用、`check` 与 `build`，并修复 WSL 服务停止时的状态查询错误；08-03 计划日于 08-05 完成共享契约、独立状态、Prisma 初始迁移、健康探针、结构化日志、改动导读和 2 道微观题，业务库迁移与协议检查通过；WSL 管理面再次出现 `0xffffffff`，专用影子库的自动创建脚本已通过 Bash 语法检查，待 WSL 恢复后由 `infra:up` 幂等验证；08-04 计划日于 08-06 完成最小应用壳、CI、测试夹具、Tailwind 设计令牌、改动导读和 2 道微观题，用户提前完成状态迁移手写点且 Review 已通过；Compose 改在阶段 3 BullMQ 接入日于 Linux VPS 验证 |
| 2. 目标、计划与基础工作台 | 08-06 ～ 08-10 | `NOT_STARTED` | 等待阶段 1 | — | — |
| 3. GitHub 与可靠异步链路 | 08-11 ～ 08-16 | `NOT_STARTED` | 等待阶段 2 | — | — |
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
- WSL Docker Engine 虽曾短暂通过 daemon 验证，但后续启动服务导致 WSL 长时间无响应，因此不再作为开发关键路径。Compose 保留为部署资产，并在阶段 3 BullMQ 链路完成后于 Linux VPS 提前 smoke，避免把环境漂移风险留到最终发布。
- 阶段 1 只定义鉴权上下文并使用仅开发环境可启用的固定测试用户；真实 GitHub 登录与 GitHub App 后续接入。
- 生产部署保持平台无关，前提是支持长驻 API/Worker、SSE、PostgreSQL、Redis、HTTPS 与安全环境变量。

### 逐日安排

| 日期 | 负责人 | 当日工作 | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 08-01 周六 | 共同 | 确认 Monorepo、运行环境、鉴权开发策略和部署前提；确认后讲解 Web/API/Worker 边界、服务端状态、领域状态机和测试金字塔 | 用户完成需求确认并在理解讲解后明确授权 | Web、API 与 Worker 为什么分进程 | `DONE` |
| 08-02 周日 | AI | 初始化 pnpm workspace、Nuxt、NestJS API、Worker、共享包；使用 WSL 原生 PostgreSQL/Redis；保留显式 VPS Compose 命令；建立 lint、format、typecheck、Vitest 和环境变量校验 | 三个应用可启动，基础检查可一键执行，本机不依赖 Docker Desktop 或 Docker daemon | Monorepo 依赖边界与本地基础设施 | `DONE` |
| 08-03 周一 | AI | 定义共享 DTO/Zod Schema、Task 与 AgentRun 状态、错误码和基础 Prisma Schema；建立 health/readiness 与结构化日志 | 契约不依赖具体 UI，状态迁移有单元测试 | 共享契约及 Task/AgentRun 状态分离 | `DONE` |
| 08-04 周二 | AI | 建立最小应用壳、CI 和测试夹具；AI 完成范围后交付 `isValidTaskTransition` 手写缺口、契约和测试 | AI 范围验证完成，手写任务已交付 | CI、测试夹具与纯函数可测试性 | `DONE` |
| 08-05 周三 | 用户 → 共同 | 用户在 30 分钟内完成状态迁移函数；AI Review 并修复 blocking 问题；每日问答后再完成 2 至 4 道阶段宏观题 | 手写 Review、每日问答和宏观问答均完成，阶段状态为 `DONE` | 状态迁移的边界、复杂度与解释方式 | `NOT_STARTED` |

### 用户手写点

- 计划位置：`packages/contracts/src/domain/task-state.ts`
- 内容：根据允许迁移表实现纯函数 `isValidTaskTransition(from, to)`。
- 面试价值：训练 TypeScript 联合类型、显式状态机、业务不变量和可测试设计。
- 时间上限：20 至 30 分钟。

### 阶段宏观题方向

前后端共享契约的边界、Task 与 AgentRun 为什么分离、状态机如何防止非法并发、Monorepo 的收益与代价。

### 阶段验收

- `pnpm infra:check` 可从 Windows 应用边界验证 WSL 原生 PostgreSQL/Redis，`pnpm dev` 可启动三个应用；Compose 在阶段 3 BullMQ 接入日于 Linux VPS 完成提前 smoke；
- lint、typecheck、基础单测在 CI 通过；
- Task 和 AgentRun 有独立状态与非法迁移保护；
- 用户能画出浏览器、API、队列 Worker、PostgreSQL 和 Redis 的职责图。

## 6. 阶段 2：目标、计划与基础工作台

### 阶段目标

完成“输入目标 → 生成计划草稿 → 校验 → 用户确认 → 首任务解锁”的纵向闭环，并建立正确的前端服务端状态管理方式。

### 逐日安排

| 日期 | 负责人 | 当日工作 | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 08-06 周四 | 共同 | 确认目标表单、计划规模、生成失败降级和页面范围；讲解 Prisma 数据模型、事务、计划 DAG、TanStack Query 与 Pinia 职责 | 用户确认并授权 | 事务、DAG 与服务端状态的职责 | `NOT_STARTED` |
| 08-07 周五 | AI | 完成 User、LearningGoal、Plan、Stage、Task、Criterion 和依赖关系的迁移、Repository 层与 API 契约 | 可创建并读取目标和计划 | 关系建模、外键与 Repository 边界 | `NOT_STARTED` |
| 08-08 周六 | AI | 完成受 Schema 约束的计划生成适配器、草稿版本、数量/日期/依赖校验、确认事务和首任务解锁 | 非法计划不能激活，重复确认幂等 | LLM Schema 校验与幂等确认 | `NOT_STARTED` |
| 08-09 周日 | AI | 完成目标表单、计划预览、今日任务、任务详情基础页，以及 loading/error/empty 状态；交付 DAG 环检测手写缺口 | 浏览器可完成 Mock/真实适配器下的计划闭环，手写任务已交付 | TanStack Query、Pinia 与页面状态 | `NOT_STARTED` |
| 08-10 周一 | 用户 → 共同 | 用户实现 DAG 环检测；AI Review、回归测试；每日问答后再完成 2 至 4 道阶段宏观题并写档 | 手写 Review、每日问答和宏观问答均完成，阶段状态为 `DONE` | DAG 环检测的正确性与复杂度 | `NOT_STARTED` |

### 用户手写点

- 计划位置：`packages/contracts/src/plan/assert-acyclic-task-graph.ts`
- 内容：实现基于 DFS 三色标记或拓扑排序的任务依赖环检测。
- 面试价值：把常见图算法落实到真实业务校验，同时理解为何数据库外键不能替代 DAG 校验。
- 时间上限：30 分钟。

### 阶段宏观题方向

服务端状态与 Pinia 的边界、计划确认为何使用事务、DAG 校验、Schema 校验和 LLM 非确定性。

### 阶段验收

- 用户无需改数据库即可创建目标并确认计划；
- 计划始终为 1 至 3 个阶段、3 至 8 个任务且无环；
- 确认后只有满足依赖的任务进入 `READY`；
- 页面刷新后状态来自服务端，不依赖 Pinia 复制实体。

## 7. 阶段 3：GitHub 与可靠异步链路

### 阶段目标

完成真实 GitHub 登录、App 安装、仓库绑定和 Push 处理，使一次目标分支 Markdown 提交能够可靠生成 AgentRun 并保存 Diff 证据。

### 逐日安排

| 日期 | 负责人 | 当日工作 | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 08-11 周二 | 共同 | 确认 GitHub App 权限、单仓库/单分支限制和异常 Push 行为；讲解 HMAC、Delivery 幂等、数据库事务、Outbox、BullMQ 和至少一次投递 | 用户确认并授权 | 至少一次投递下的端到端可靠性 | `NOT_STARTED` |
| 08-12 周三 | AI | 完成 GitHub 登录、App Installation 回调、选定仓库绑定/解绑、权限披露和设置页 | 可用测试账号绑定一个仓库 | GitHub App 权限与 Installation 生命周期 | `NOT_STARTED` |
| 08-13 周四 | AI | 完成 raw body 接收、事件过滤、Delivery 唯一键、WebhookDelivery/Submission/AgentRun/Outbox 同事务写入与快速 `202` | 重放 Delivery 不重复创建有效运行 | HMAC 可信性与 Delivery 幂等的区别 | `NOT_STARTED` |
| 08-14 周五 | AI | 完成 Outbox Dispatcher、稳定 Job ID、BullMQ 队列、Worker 骨架、重试分类和未分发事件补扫；在 Linux VPS 用 Compose 提前验证 PostgreSQL/Redis | 数据库提交后最终可以稳定入队；VPS 上镜像、healthcheck、命名卷和仅回环端口通过 smoke | Outbox、稳定 Job ID、重试语义与环境一致性 | `NOT_STARTED` |
| 08-15 周六 | AI | 完成 Commit compare、Markdown 路径匹配、Diff/快照/哈希/行号 Evidence 持久化和链路集成测试；交付手写缺口 | 真实 Push 能产生可查看的证据，手写任务已交付 | Diff Evidence 的完整性与任务匹配 | `NOT_STARTED` |
| 08-16 周日 | 用户 → 共同 | 用户实现 Webhook 签名校验；AI 做安全 Review 和回归；每日问答后再完成 2 至 4 道阶段宏观题并写档 | 手写 Review、每日问答和宏观问答均完成，阶段状态为 `DONE` | 常量时间比较、raw body 与安全边界 | `NOT_STARTED` |

### 用户手写点

- 计划位置：`apps/api/src/modules/github/verify-github-signature.ts`
- 内容：实现 `sha256=` 签名前缀校验、HMAC SHA-256 计算和常量时间比较。
- 面试价值：理解 Webhook 可信边界、raw body 必要性以及签名校验与幂等是两个不同问题。
- 时间上限：20 至 30 分钟。

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

| 日期 | 负责人 | 当日工作 | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 08-17 周一 | 共同 | 确认 Rubric、三态结论、引用要求、模型预算和 Prompt Injection 边界；讲解 Markdown AST、确定性/语义分层、结构化输出、两类独立 Run 和评测集 | 用户确认并授权 | 确定性/语义分层与 Prompt Injection | `NOT_STARTED` |
| 08-18 周二 | AI | 完成 Markdown AST 分块、章节/字数/文件变更规则、Commit 行号映射和引用再定位 | 确定性标准不调用模型且结果可复现 | Markdown AST 与引用行号可定位性 | `NOT_STARTED` |
| 08-19 周三 | AI | 完成 agent-core 模型适配、只读工具、步骤编排、Zod 输出校验、有限修复重试、超时/取消检查和 Prompt 版本 | 非法模型输出不能改变任务状态 | 结构化输出、工具边界与失败恢复 | `NOT_STARTED` |
| 08-20 周四 | AI | 完成笔记语义验收、CriterionResult、报告、引用联动、1 至 3 个追问和 `NEEDS_REVISION/NEEDS_EVIDENCE` 推进 | 笔记运行生成可解释报告 | 三态验收、引用与追问生成 | `NOT_STARTED` |
| 08-21 周五 | AI | 完成回答提交与独立验收、旧追问失效、任务通过/后续解锁、至少 15 个固定样本和核心集成测试；交付手写缺口 | 单任务完整闭环自动化通过，手写任务已交付 | Note/Answer Run 分离与固定评测集 | `NOT_STARTED` |
| 08-22 周六 | 用户 → 共同 | 用户实现验收结果汇总；AI Review 与回归；每日问答后再完成 2 至 4 道阶段宏观题并写档 | 手写 Review、每日问答和宏观问答均完成，阶段状态为 `DONE` | 验收规则优先级与任务状态推导 | `NOT_STARTED` |

### 用户手写点

- 计划位置：`packages/agent-core/src/verification/derive-task-outcome.ts`
- 内容：根据必要/可选标准及三态结果推导任务下一稳定状态。
- 面试价值：理解领域规则优先级、纯函数设计，以及 `FAILED` 与 `INSUFFICIENT_EVIDENCE` 为何不能混淆。
- 时间上限：20 至 30 分钟。

### 阶段宏观题方向

为何不用开放式多 Agent、确定性与语义验收如何组合、结构化输出失败怎么办、Prompt Injection 防护、Agent 评测指标。

### 阶段验收

- 一次笔记 Push 可以产生逐项报告、真实引用和追问；
- 回答验收使用新的 AgentRun，不让 Worker 等待用户；
- 新笔记会使绑定旧 Submission 的追问失效；
- 只有全部必要标准和必答追问通过才能进入 `PASSED`；
- 固定评测集能够比较 Schema 成功率、错误通过率与引用可定位率。

## 9. 阶段 5：SSE 与 Agent 运行工作台

### 阶段目标

建立可重放的实时运行体验，完成 Agent 时间线、Diff/引用联动、断线恢复、取消和重试，并体现前端架构与性能能力。

### 逐日安排

| 日期 | 负责人 | 当日工作 | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 08-23 周日 | 共同 | 确认时间线事件、重连语义、取消/重试交互和 Monaco 范围；讲解持久化事件、Redis 通知、SSE replay/live 竞态、Reducer 与 Query 缓存边界 | 用户确认并授权 | SSE replay/live 与前端状态边界 | `NOT_STARTED` |
| 08-24 周一 | AI | 完成 RunEvent 序列分配、先落库后通知、SSE 鉴权、历史重放、实时订阅、心跳和订阅清理 | API 可按最后事件 ID 补发 | 事件持久化、序列号、鉴权与心跳 | `NOT_STARTED` |
| 08-25 周二 | AI | 完成运行详情、步骤时间线、状态与耗时、Markdown Diff、引用定位、报告和 Monaco 客户端懒加载 | 主流程可以完整演示 | 时间线渲染、引用联动与懒加载 | `NOT_STARTED` |
| 08-26 周三 | AI | 完成断线/刷新、重复/乱序事件、replay/live 衔接、取消、关联重试、错误/加载/空状态和相关测试；交付手写缺口 | 重连后时间线无缺失无重复，手写任务已交付 | 重连竞态、重复乱序与取消重试 | `NOT_STARTED` |
| 08-27 周四 | 用户 → 共同 | 用户实现 RunEvent Reducer；AI Review、性能检查与回归；每日问答后再完成 2 至 4 道阶段宏观题并写档 | 手写 Review、每日问答和宏观问答均完成，阶段状态为 `DONE` | Reducer 幂等、排序与渲染性能 | `NOT_STARTED` |

### 用户手写点

- 计划位置：`apps/web/app/utils/run-event-reducer.ts`
- 内容：按 `(runId, sequence)` 对事件去重、排序，并保持 reducer 幂等。
- 面试价值：高度贴近前端手写题，可延伸到流式 UI、乱序网络消息、不可变数据和渲染性能。
- 时间上限：30 分钟。

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

| 日期 | 负责人 | 当日工作 | 当日检查点 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- | --- |
| 08-28 周五 | 共同 | 冻结 P0；确认部署平台、域名/密钥、固定 Demo 和公开材料边界；讲解测试金字塔、故障注入、可观测、Web 性能和简历指标真实性 | 用户确认并授权 | 测试分层、部署边界与指标真实性 | `NOT_STARTED` |
| 08-29 周六 | AI | 补齐核心单元、Webhook→Worker 集成、完整 E2E、越权检查和三处 Worker 故障注入 | CI 稳定覆盖产品与工程闭环 | 测试层级、Mock 边界与故障注入 | `NOT_STARTED` |
| 08-30 周日 | AI | 部署 Web/API/Worker/PostgreSQL/Redis，配置迁移、密钥、健康检查、结构化日志、Trace ID 和回滚说明 | 生产环境可完成 smoke test | 密钥、迁移、健康检查与可观测链路 | `NOT_STARTED` |
| 08-31 周一 | AI | 优化公共页首屏、Monaco 懒加载、基础可访问性和移动端；测量性能、重放可靠性、Agent 效果/成本 | 得到至少 3 项可复现实测数据 | Web 性能、可访问性与指标测量 | `NOT_STARTED` |
| 09-01 周二 | AI → 用户 | 完成固定 Demo、README、架构图、至少 3 篇 ADR、演示脚本和简历 bullet 初稿；交付 Playwright 手写段，用户完成后由 AI Review | 求职材料与代码一致，用户测试通过 | E2E 断言、flaky 控制与简历事实边界 | `NOT_STARTED` |
| 09-02 周三 | 共同 | 生产 smoke、发布 v1.0、冻结简历表述；每日问答后再完成 2 至 4 道阶段宏观题并写档 | 每日问答和宏观问答均完成，阶段状态为 `DONE`，版本可投递 | 发布验证、回滚与三分钟项目叙述 | `NOT_STARTED` |

### 用户手写点

- 计划位置：`tests/e2e/run-reconnect.spec.ts`
- 内容：在已有 fixture/page object 上补全“刷新或重连后时间线事件无缺失、无重复”的断言段。
- 面试价值：补齐测试薄弱项，能够解释 E2E 测什么、为何不能只靠单元测试以及怎样降低 flaky。
- 时间上限：20 至 30 分钟。

### 阶段宏观题方向

测试分层与 mock 边界、故障注入、线上观测、Core Web Vitals、部署取舍、真实指标如何转化为简历表述。

### 阶段验收

- PRD 第 19 节产品、工程和求职展示闭环全部满足；
- CI 稳定，生产日志能串联 Webhook、AgentRun 和 Worker；
- 有固定 Demo、README、ADR、演示脚本/视频和真实指标；
- 用户能够在 3 分钟内讲清产品价值、架构、最大难点、技术取舍和量化结果。

## 11. 发布缓冲：2026-09-03 至 2026-09-06

| 日期 | 工作 | 禁止事项 | 每日微观问答主题 | 状态 |
| --- | --- | --- | --- | --- |
| 09-03 周四 | 观察生产运行、复跑幂等/断线/失败用例，只修 P0 blocker | 不加新功能 | 生产故障定位与回归边界 | `NOT_STARTED` |
| 09-04 周五 | 用户录制 2 至 4 分钟演示；校对 README、隐私说明、截图和线上链接 | 不改核心架构 | Demo 叙事、隐私与公开信息边界 | `NOT_STARTED` |
| 09-05 周六 | 完成一次全项目模拟面试，依据 `问答.md` 复习薄弱点；定稿简历项目经历 | 不使用未经测量的数字 | 重复薄弱点与简历追问 | `NOT_STARTED` |
| 09-06 周日 | 最终 smoke、备份 Demo 数据、整理投递链接和面试讲解提纲 | 不因包装需求扩大 P0 | 发布兜底、数据备份与故障恢复 | `NOT_STARTED` |

若 9 月 2 日前已稳定完成，缓冲日用于真实使用和投递；若仍有 blocker，只修复 blocker，并在阶段看板记录实际完成日期。

## 12. 里程碑与强制复盘

| 截止日期 | 里程碑 | 未达到时的动作 |
| --- | --- | --- |
| 08-05 | 工程骨架与状态机可运行 | 取消非必要 UI 基建，不增加共享包 |
| 08-10 | 目标到首任务解锁闭环 | 计划生成暂用受 Schema 约束的固定适配器 |
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

进度落后 1 天：使用下一阶段的首个 AI 编码日吸收，但保留需求/授权关卡、每日改动导读与理解确认、每日问答和阶段宏观问答。

进度落后 2 天：立即做 15 分钟范围复盘，删除 P1、视觉装饰、非关键筛选和额外抽象。

进度落后 3 天及以上：按 PRD 第 22 节裁剪；页面可退化，以下能力不得用 Mock 冒充：

- GitHub App 与真实 Push；
- Webhook 签名、幂等和队列处理；
- Markdown Diff、引用与确定性/语义验收；
- 追问回答和任务状态推进；
- SSE 重连重放；
- 失败重试、线上部署和核心自动化测试。

无论落后多少天，都不得通过增加用户手写量、跳过 Review、每日改动导读与理解确认、每日微观问答、每日 Git 提交、阶段宏观问答或伪造指标追赶。
