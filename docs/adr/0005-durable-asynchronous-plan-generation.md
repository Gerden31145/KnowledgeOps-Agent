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

## 放弃的方案

- 请求内等待完整 JSON：实现最短，但连接、超时和进程故障边界不适合最终产品。
- 直接把模型 Token 流式写成 Plan：结构化输出完成前不满足业务 Schema，容易产生不可信半成品。
- 只使用模型供应商的后台模式：供应商能力不统一，也不能替代本项目的 PostgreSQL 事务、Outbox 和跨供应商审计。
- 复用 `AgentRun`：当前实体必须关联 Task 和 `taskStateBeforeRun`，强行改成多态所有者会削弱外键和领域语义。
- 使用 LangGraph Checkpointer：会与 PostgreSQL 的生成运行和 Plan 状态形成第二持久化真相源。

## 参考

- [BullMQ：Job IDs](https://docs.bullmq.io/guide/jobs/job-ids)（自定义 Job ID 的唯一性范围、冒号限制与重复任务行为）
