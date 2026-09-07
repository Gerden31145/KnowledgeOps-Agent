# R02 / C1：计划生成的原子成功落库

本文件保留原始题面与 Review 证据。原核心编码预算 1 至 2 小时，整个 R02 含准备、Review 与验证共 3 小时；2026-09-07 已完成验收、Review、短复述与 C1 独立本地提交，当前状态见[逐日计划](../KnowledgeOps-Agent-逐日开发计划.md)。已报告投入 3.5 小时，后续新增时间未报告，不把原预算当作实际耗时。

## 1. 只修改这个入口

[finalize-plan-generation-run.ts](../../apps/worker/src/plan-generation/finalize-plan-generation-run.ts) 中的 `FinalizePlanGenerationRun.execute()`：

```ts
execute(command: FinalizePlanGenerationRunCommand): Promise<FinalizePlanGenerationRunResult>
```

使用构造函数传入的数据库客户端，可以将 `_database` / `_command` 改成正常变量名、补充 import 和同文件内的必要辅助函数。保留公开接口与导出；移除方法体内的占位抛错，但保留调用者仍在引用的异常类。

首轮代码入口仍是该文件、[Processor 调用处](../../apps/worker/src/plan-generation/plan-generation-job-processor.ts)和 [Prisma 模型](../../prisma/schema.prisma)。本文件供查阅字段和验收，不要求额外通读所有测试。正式手写放在产品源码，沿用已完成的队列与模型调用。

## 2. 输入与返回

调用者已经领取 Run、调用模型、校验候选结构及 DAG，然后才调用 `execute()`。模型调用发生在落库事务之外。

| 输入 | 含义与使用边界 |
| --- | --- |
| `candidate` | 内存中的完整候选计划；包含阶段、任务、标准与任务间引用 |
| `generationRunId` | 本次生成运行的数据库 UUID |
| `goalId` | 该 Run 应属的目标；必须与数据库中的 `run.goalId` 一致 |
| `expectedRunVersion` | 本轮执行领取到的版本；写入时数据库仍须匹配 |
| `finishedAt` | 调用者传入的本次完成检查时间，也是成功时保存的时间；与持久化 `deadlineAt` 比较，等于截止时间也算过期 |

返回行为：

- 本次成功保存：`{ status: 'FINALIZED', planId }`。
- Run 已成功、其他终态、版本不匹配或完成检查时间已过期：`{ status: 'SKIPPED', runStatus, planId }`，字段来自数据库当前状态，有既有 Plan 就返回其 ID，否则为 `null`。不得把这些正常跳过当作新的业务失败。
- Run 不存在或目标不匹配：抛出可解释的错误，不创建数据；接口没有 `NOT_FOUND` 分支，不虚构一个持久化状态。
- 依赖无法解析或数据库写入失败：抛错，撤销本次事务写入。外层 Processor 已负责记录失败，Finalizer 不另做失败终态写入。

例如你刚才回答的场景返回 `SKIPPED / TIMED_OUT / planId: null`，Run 仍保持版本 2。若 Run 仍是 `RUNNING`，但 `finishedAt >= deadlineAt`，也跳过并保留当前状态；现有超时扫描负责后续终态处理。

## 3. 保存内容对照

| 数据库记录 | 需要保存的内容 |
| --- | --- |
| `Plan` | 对应 `goalId` 与 `generationRunId`；`DRAFT`、`confirmedAt = null`；该目标首份版本为 1，已有版本时使用最大版本加 1，不修改旧 Plan |
| `Stage` | 标题、所属 Plan、在 `candidate.stages` 中从 0 开始的 `position` |
| `Task` | 标题、描述、类型、预计分钟数、建议步骤、目标路径、所属 Stage；`position` 是该阶段内的数组下标；初始 `BLOCKED / version = 0` |
| `AcceptanceCriterion` | 所属 Task、`type / description / required`，以及该任务标准数组内从 0 开始的 `position`；当前候选不提供 `config` |
| `TaskDependency` | `taskId` 指依赖别人的任务，`prerequisiteTaskId` 指它的前置任务；两者必须是真实数据库 Task UUID |
| `PlanGenerationRun` | 成功时 `SUCCEEDED`、`version` 增加 1、写入 `finishedAt`、清空 `errorCode / errorMessage`；保留开始时间和模型等运行快照 |

`candidate` 中的 `event-loop` 等 Task ID 是这份候选内的引用名，不是数据库 UUID。Task 的真实 ID 可以由数据库生成或使用 UUID；依赖关系必须引用保存后的真实 ID，并支持跨阶段依赖。Plan 的版本与 Run 的执行版本是两个不同字段，不能相互替代。

生成成功后的 Plan 仍需用户确认，Task 在这里全部保持 `BLOCKED`。确认计划与解锁任务由已有 API 处理。

## 4. 核心不变量

完整 Plan 图和成功终态属于同一个事务。任一步失败，不能残留本次 Plan、阶段、任务、标准或依赖，也不能留下本次成功状态或版本递增。

保存成功必须以同一个 Run、匹配的目标、`RUNNING`、期望版本和未到截止时间为前提；这些条件必须约束实际写入。事务外先查一次然后无条件写入，不能防止期间发生的超时或版本变化。

同一个 Run 同时被两个调用者提交，也只能有一个 `FINALIZED`；另一方读取已提交的结果后返回 `SKIPPED`。若已经写入部分图后才发现失去写入资格，这些新记录也必须撤销。真正的存储错误要保留为错误，不能全部吞成 `SKIPPED`。

## 5. 黑盒验收

[专用测试](../../apps/worker/test/finalize-plan-generation-run.acceptance.ts)由 AI 维护，用户无需修改它或配置以让测试通过。

| 场景 | 应观察到的结果 |
| --- | --- |
| 正常成功 | 1 个草稿 Plan、2 个阶段、3 个任务、3 条标准、3 条方向正确的依赖；顺序与字段完整；Run 版本 1 → 2，状态成功；原阶段顺序与反转顺序各一例，后者仍须通过 Schema 和 DAG 校验 |
| 成功后重放 | 携带原执行版本或当前版本，均返回既有 Plan，只保留一份图，不再次增加 Run 版本 |
| 旧版本结果 | `SKIPPED / RUNNING / null`，不创建 Plan |
| 已超时终态 | `SKIPPED / TIMED_OUT / null`，不复活、不创建 Plan |
| 依赖引用缺失 | 抛错、无新图，Run 保持原状态和版本 |
| 恰好到期及超过到期 | 两个测试：即使仍是 `RUNNING`，也不能保存成功 |
| 错误目标 | Run 为 `RUNNING / TIMED_OUT / SUCCEEDED` 时，使用另一真实 Goal 的 ID 都必须报错，两边已有数据保持不变 |
| Run 不存在 | 抛错且无新图，不能虚构 `FAILED` 持久化状态作为正常返回 |
| 同 Run 并发提交 | 两个调用都结束，一个成功、一个跳过，返回同一 Plan ID，Run 只增加一次版本 |
| 目标已有 Plan 版本 | 已有版本 2 时新增版本 3，旧 Plan 不变 |

以上为 10 类验收场景、15 个测试用例。2026-09-07 Review 在初始 10 个用例基础上补齐了已有契约的组合边界，不新增业务或手写任务。初始验收中，“未实现”状态也能通过两个仅断言抛错且无写入的负例，它们单独通过不证明已实现回滚。Review 还会检查事务客户端的使用、失败传播和真实写入条件，测试全绿不是全部证明。

## 6. 运行与时间分配

先用约 10 分钟看输入和字段对照，再用 45 至 70 分钟编码，最后留 20 至 30 分钟运行验收和修正。卡住约 15 分钟就带上问题和已尝试的方法提问；如果 Prisma 事务 API 本身陌生，先补一个独立最小用法，时间计入 R02。

在项目根目录运行（需要现有本地 PostgreSQL；测试使用固定候选，不调用模型）：

```powershell
pnpm test:handwrite:stage-2-finalization
pnpm --filter @knowledgeops/worker typecheck
```

基础设施未运行时，使用已建立的 `pnpm infra:up` / `pnpm infra:check`。测试时间是固定夹具时间，截止判断按输入 `finishedAt` 执行，不用电脑当前日期替换它。

完成后回复“C1 写完了”并给出大约耗时。我再 Review、运行专用验收及相关回归；通过后短复述并创建 C1 独立提交。R03 再完成浏览器与真实模型的纵向验证。

## 7. 按需展开的提示

<details>
<summary>提示 1：事务范围与正常跳过</summary>

先列出哪些操作会改数据库，确认它们都由同一个事务客户端执行。Prisma 交互式事务在回调正常返回时提交，抛出异常时回滚，因此“写了一部分之后返回 SKIPPED”需要特别审视。只需按需查阅 [Prisma 事务文档（v7）](https://docs.prisma.io/docs/orm/v7/prisma-client/queries/transactions) 的交互式事务和并发控制部分。

</details>

<details>
<summary>提示 2：候选引用与数据库 ID</summary>

思考如何记录候选 Task 引用名与真实 UUID 的对应关系，以及怎样保证写入依赖时能找到跨阶段的前置任务。`dependsOnTaskIds` 的数组次序不是数据库主键，也不能假定所有依赖只指向刚刚遍历过的任务。

</details>

<details>
<summary>提示 3：并发与版本</summary>

在纸上交错排列两个调用者的“读取 Run、获得写入资格、保存图、提交”，找出双方都可能读到版本 1 的位置。数据库里的条件更新或锁可以参与协调；选一种你能解释的方式，不需要叠加全部机制。检查重复调用和过期版本时，回答的是数据库当前状态。

</details>

## 8. 首轮 Review 记录（2026-09-07）

用户明确交付并报告耗时 3.5 小时，主要耗时为初版之后的多轮修正。原 10 项验收通过；补充边界后为 10 通过、5 失败，类型检查与 lint 通过。结论：尚未通过 Review，不提交、不进入完成状态。

| Blocking 类别 | 复现证据 | 修正提示（不含实现） |
| --- | --- | --- |
| 身份检查被正常跳过分支绕过 | 不存在的 Run 返回 `SKIPPED / FAILED`；已超时或已成功的 Run 配错误 Goal 仍正常返回，成功时还返回既有 Plan ID | 先区分身份契约错误与合法身份下的状态跳过；身份错误不能被后续状态分支吞掉 |
| 成功终态仍可能进入新建 | Run 已 `SUCCEEDED / version=2`，命令也携带版本 2 时，再次创建 Plan 并撞唯一约束 | 版本相等只是必要条件，不代表 `RUNNING`；以锁后记录判断完整写入资格，已成功时读取本 Run 的既有结果 |
| 保存依赖过早 | 同一合法 DAG 仅反转 Stage 数组，即触发“任务id映射错误” | Map 虽覆盖整份计划，但使用它时也必须已具备所需映射；展示顺序不是依赖已创建的保证 |

非 blocking 整理：复用现有 `PlanGenerationRunState` 类型，避免重复字面量联合；事务返回值与外部可变 `isFinalized` 无需同时维护同一信息；源码格式待行为修正后机械整理。本轮不要求额外重构或新增练习。

## 9. 修正后 Review（2026-09-07）

用户明确“修正完毕，测试均已通过”后复查：Review 通过，无剩余 blocking。当时进入 `RECALL`，尚未短复述或提交；随后同日已完成短复述和独立提交，复述评价与耗时边界仅记在逐日计划中，不算作 W1 周问答。此前已报告 3.5 小时，后续新增时间未报告。

- 身份错误先于正常跳过处理；不存在的 Run、错误 Goal 不再返回伪造状态或既有 Plan。
- 非 `RUNNING` 状态退出，成功后携带原版本或当前版本重放均返回既有结果；同 Run 并发只提交一份图。
- 所有阶段的 Task 与 ID 映射建立完毕后才保存依赖；反转阶段展示顺序不再破坏合法 DAG。
- 所有图写入与成功终态更新均使用事务客户端；依赖解析失败向外抛错，事务回滚，交给 Processor 的既有失败路径处理。

并发判断的实现前提：当前源码在事务外检查身份、状态和固定输入 `finishedAt` 对应的 deadline，再在行锁内复核 Run 版本。已核对现有领取、失败、超时与成功写入路径均递增 Run 版本，且没有修改既有 Run 的 `goalId / deadlineAt` 的产品入口，因此当前写入路径下版本复核可以识别预检查后的状态变化。后续若新增修改入口，必须维持这些条件，或将完整资格统一放到锁内复核；这不是“事务内查询会自动锁定”的保证。本轮不追加锁机制重构。

验证证据：

- `pnpm test:handwrite:stage-2-finalization`：15/15 通过。
- `pnpm exec vitest run`：36 个文件、140/140 通过。
- `pnpm test:integration:day-08-10`：8/8 通过，覆盖状态、计划确认/任务开始与 Worker 失败/超时路径。
- `pnpm test:integration:day-08-11`：工作台读取 1/1 通过。
- Worker `typecheck`、Finalizer 与专用测试的 ESLint、Prettier 检查通过；AI 仅对 Finalizer 执行机械格式化，没有代写业务修正。

该手写补齐的是“Processor 将校验后的候选交给 Finalizer → 保存草稿 Plan 图并决定本次提交结果”这一步；真实模型生成、浏览器刷新、确认与开始任务的纵向证据留在 R03。本轮不因此宣称完整产品链路已验证，也不新增手写。类型复用、外部可变返回标志等可读性建议仍为 non-blocking。
