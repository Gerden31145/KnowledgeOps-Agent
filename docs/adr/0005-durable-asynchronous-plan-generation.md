# ADR 0005：计划生成采用持久化异步执行

- 状态：Accepted
- 日期：2026-08-08
- 取代：[ADR 0004](./0004-server-model-catalog-and-langchain-boundary.md) 中的请求内同步生成决策

## 背景

计划生成需要一次可能持续较久的模型调用，并且只有完整输出通过 Zod、数量、日期和 DAG 校验后，才能创建 Plan、Stage、Task、Criterion 与依赖关系。模型输出的半成品不是合法业务状态，不能像普通聊天文本一样逐 Token 写入页面或数据库。

请求内等待完整结果虽然实现简单，但会长期占用 HTTP 连接和并发预算；浏览器刷新、网络断开、反向代理超时或 API 重启后也缺少可恢复的业务记录。本项目后续本来就需要 PostgreSQL Outbox、BullMQ 和独立 Worker 处理长时间验收任务，因此计划生成可以复用同一套可靠异步基础设施，而不需要保留两种长任务架构。

## 决策

计划生成使用独立的 `PlanGenerationRun`，不复用与 Task 强绑定的 `AgentRun`。一次生成尝试具有 `QUEUED`、`RUNNING`、`SUCCEEDED`、`FAILED` 或 `TIMED_OUT` 状态，并在创建时保存 `deadlineAt`；进入终态后不可恢复，用户重试必须创建通过 `retryOfRunId` 关联的新记录。

用户先持久化 LearningGoal，再调用生成接口并提交服务端模型目录中的稳定模型 ID。API 在同一 PostgreSQL 事务中创建 `QUEUED` 的 `PlanGenerationRun` 与 `OutboxEvent`，事务提交后立即返回 `202 Accepted` 和 `generationRunId`。同一 LearningGoal 同时最多存在一个非终态生成运行。

Outbox Dispatcher 使用稳定 Job ID `plan-generation-{runId}` 将事件加入 BullMQ；自定义 ID 不使用 BullMQ 保留为 Redis 键分隔符的冒号。Worker 读取运行快照，通过项目定义的模型端口调用 LangChain 适配器，并执行结构化输出、数量、日期和 DAG 校验。只有全部校验通过，Worker 才在单个数据库事务中创建完整 Plan 图并把运行标记为 `SUCCEEDED`；任何一步失败都不得留下半份 Plan，运行另行落为 `FAILED` 或 `TIMED_OUT`。

BullMQ 至少一次投递意味着相同 Job 可能重复执行。Worker 必须先检查运行终态，并依靠运行版本、唯一约束和条件更新保证幂等；若已成功创建 Plan，重复消费只返回既有结果。稳定 Job ID 是队列内的第一层去重，但 Job 被清理后同一 ID 可以再次入队，永久幂等仍以 PostgreSQL 为准。模型 SDK、LangChain 修复重试与 BullMQ Job 重试共享统一的调用次数、Token、成本和总耗时预算，不能形成乘法级重试。

定时清理任务扫描超过 `deadlineAt` 的 `QUEUED` 或 `RUNNING` 记录，并用状态与版本条件更新为 `TIMED_OUT`；迟到 Worker 看到终态后只能退出。这样 Redis 丢失已确认 Job、Worker 永久退出或失败回调未执行时，前端也不会无限停留在处理中。

阶段 2 前端先通过 TanStack Query 轮询生成运行，刷新后从 PostgreSQL 恢复状态；阶段 5 可以复用 SSE 事件基础设施增强实时体验，但 P0 不展示不可信的局部 JSON。P0 仍不启用 LangGraph Checkpointer、Memory 或 Thread，PostgreSQL 是运行与业务结果的唯一持久化真相源。

## 结果

- API 不再等待完整模型输出，长任务可以削峰、限流并独立扩缩容。
- 刷新、断网、Dispatcher 重启和 Worker 重试不会丢失已经提交的生成意图。
- 成功与失败尝试都有独立审计记录，失败重试不会覆盖历史。
- 计划生成和笔记验收复用 Outbox、BullMQ、Worker、日志关联与故障恢复原则。
- 至少一次执行只能保证业务结果幂等，不能保证外部模型恰好调用一次；在模型响应与结果持久化之间崩溃时可能产生一次额外调用，因此必须记录尝试并限制总预算。
- 阶段 2 需要提前实现一部分原计划属于阶段 3 的异步基础设施，并增加运行状态、轮询与幂等复杂度。
- Token 级流式展示不进入 P0；用户只能看到可信的运行状态和最终完整计划。

## 08-09 分发实现细节

Dispatcher 使用 `FOR UPDATE SKIP LOCKED` 每次领取一条到期事件，并把“调用 `Queue.add` 后标记成功”放在同一个有时限的 PostgreSQL 事务中。锁只覆盖单条事件，多个 Dispatcher 可以跳过彼此正在处理的行；代价是 Redis 调用期间会短暂占用一个数据库连接和行锁，因此 producer 连接必须快速失败，批次也保持有界。当前方案比额外引入 claim/lease 字段更小，若线上测量显示事务时间或吞吐成为瓶颈，再迁移为带租约的两阶段领取。

进程可能在 BullMQ 已接受 Job、但 `dispatchedAt` 尚未提交时崩溃。此时事务回滚，重启补扫会再次调用 `Queue.add`，但同一运行始终生成 `plan-generation-{runId}`。BullMQ 在同一 Queue 内忽略仍然存在的重复 Job；成功和失败 Job 在 MVP 中不会自动删除。Job 将来被清理后可以再次加入，所以这一层仍不替代 PostgreSQL 的运行终态、版本、唯一约束和 08-10 的原子结果落库。

错误按故障层分类：Redis/网络错误是可重试 transport failure，Outbox 保持未分发并使用有上限的指数退避；不支持的事件类型、Schema 版本或与 aggregate 不一致的 payload 是永久 contract failure，写入 `deadLetteredAt` 等待人工诊断。BullMQ Worker 内部则把非法 Job 契约映射为 `UnrecoverableError`，把未知运行错误继续抛为普通 `Error`，由 Job 的 `attempts/backoff` 控制技术重试。两层重试各自解决“尚未可靠入队”和“已经入队但执行失败”，不能互相替代。

producer 使用快速失败的 Redis 连接配置，避免外部调用长期占住 PostgreSQL 分发事务；Worker 使用持续重连语义，并在进程关闭时先停止轮询、等待当前 Job，再关闭 Queue 连接。BullMQ 2.0 以后不再需要独立 `QueueScheduler` 处理 stalled Job，当前 BullMQ 6 因此不增加旧式 scheduler 进程。

## 08-10 执行、超时与业务入口实现细节

Worker 消费 Job 后不直接调用模型，而是先从 PostgreSQL 领取 `PlanGenerationRun`。领取使用 `status + version + deadlineAt` 条件更新，并把递增后的 `version` 作为本轮执行的 fencing token。终态运行直接返回既有状态和 Plan，不调用模型；两个执行者读取到同一版本时只有一个能够更新成功，失败者按并发重复短路。一个因 stalled 或进程退出而重新执行的 `RUNNING` Job 可以领取新版本继续工作，但旧执行者随后提交结果时会因版本不匹配被拒绝。因此系统允许模型在极端故障窗口被重复调用，却只允许当前版本修改业务结果。

领取成功后，Worker 从运行快照与 LearningGoal 构造框架无关请求，调用 `PlanGenerationPort` 的 LangChain 实现，再依次执行 Zod 输出约束和 DAG 环检查。模型配置、供应商、结构或依赖图错误会映射为稳定错误码，并通过 `id + RUNNING + expectedVersion` 条件更新记录 `FAILED`；失败路径没有创建 Plan 图的权限。持久化 `deadlineAt` 同时用于模型调用的 `AbortSignal` 和后台扫描，扫描器通过 `FOR UPDATE SKIP LOCKED` 批量把过期 `QUEUED/RUNNING` 运行推进到 `TIMED_OUT` 并递增版本。迟到模型结果因此无法复活超时运行。

完整计划图与 `SUCCEEDED` 的原子成功落库被保留为阶段 2 核心手写。08-10 只建立 `PlanGenerationSuccessFinalizer` 接口、Worker 调用点和黑盒验收；接口必须接收 fencing version，且只能返回“完整落库”或“因终态/过期而跳过”，不能暴露半份 Plan。

计划确认与任务开始属于 API 的短事务。两个入口先锁定当前用户行，以同一个用户作为并发串行化边界：确认 `DRAFT` Plan 时先排除另一份 `ACTIVE` Plan，再把无前置依赖的根任务从 `BLOCKED` 解锁为 `READY`；开始任务时排除另一项进行中或等待验收的任务，再用 Task `version` 条件更新执行 `READY → IN_PROGRESS`。相同计划的重复确认、相同任务与路径的重复开始都返回当前结果，不重复递增版本；跨用户查询统一表现为不存在。

## 放弃的方案

- 请求内等待完整 JSON：实现最短，但连接、超时和进程故障边界不适合最终产品。
- 直接把模型 Token 流式写成 Plan：结构化输出完成前不满足业务 Schema，容易产生不可信半成品。
- 只使用模型供应商的后台模式：供应商能力不统一，也不能替代本项目的 PostgreSQL 事务、Outbox 和跨供应商审计。
- 复用 `AgentRun`：当前实体必须关联 Task 和 `taskStateBeforeRun`，强行改成多态所有者会削弱外键和领域语义。
- 使用 LangGraph Checkpointer：会与 PostgreSQL 的生成运行和 Plan 状态形成第二持久化真相源。

## 参考

- [BullMQ：Job IDs](https://docs.bullmq.io/guide/jobs/job-ids)（自定义 Job ID 的唯一性范围、冒号限制与重复任务行为）
- [BullMQ：Retrying failing jobs](https://docs.bullmq.io/guide/retrying-failing-jobs)（`attempts`、内置指数退避与 Job 失败语义）
- [BullMQ：Connections](https://docs.bullmq.io/guide/connections)（producer 快速失败与 Worker 持续重连的不同连接策略）
- [BullMQ：Stalled jobs](https://docs.bullmq.io/guide/jobs/stalled)（至少一次执行、stalled 恢复与新版本不再需要 `QueueScheduler`）
