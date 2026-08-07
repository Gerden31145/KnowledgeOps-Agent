# 阶段 1 核心手写：AgentRun 终止后的 Task 恢复决策

## 目标与时间

目标耗时为 1～2 小时。你需要实现并测试一个框架无关的纯函数，把阶段 1 已完成的 Task 状态机、AgentRun 状态机、乐观并发和失败恢复连成一个可以在面试中解释的决策边界。

这不是每日 NestJS 语法练习的放大版。它处理的是真实核心风险：迟到的失败 Worker 不能把已经由更新运行推进的 Task 覆盖回旧状态。

## 业务场景

假设 Task 原本是 `IN_PROGRESS`、版本为 7。一次 Run 启动时将 Task 原子推进到 `VERIFYING`、版本变为 8，并在 Run 中保存：

- `taskStateBeforeRun = IN_PROGRESS`
- `expectedTaskVersion = 8`

Run 最终超时：

- 如果 Task 仍是 `VERIFYING v8`，它仍由该 Run 对应的验收过程控制，可以尝试恢复到 `IN_PROGRESS`。
- 如果 Task 已是 `NEEDS_EVIDENCE v9`，旧 Run 只能记录自己的 `TIMED_OUT`，不得覆盖新的业务进展。
- 如果 Task 仍叫 `VERIFYING` 但版本已变成 9，也可能已有新 Run 接管，旧 Run 同样不得恢复。

## 手写位置与已有契约

实现文件：`packages/contracts/src/domain/run-termination-recovery.ts`

测试文件：`packages/contracts/test/run-termination-recovery.exercise.ts`

需要实现的签名已经给出：

```ts
function decideRunTerminationRecovery(
  input: RunTerminationRecoveryInput,
): RunTerminationRecoveryDecision
```

输出是可辨识联合：

- `{ kind: 'RESTORE', targetTaskState, expectedTaskVersion }`
- `{ kind: 'SKIP', reason }`

可以复用已有的 `isRestorableTaskState`、`RESTORABLE_TASK_STATES` 和本文件中的可恢复 Run 终态常量。测试必须从 `../src/index.js` 公共出口导入，顺便验证 Monorepo 包的真实公开边界。

## 范围

### IN

- 实现纯恢复决策，不修改输入、不执行 I/O。
- 为所有恢复和跳过分支补测试。
- 明确定义多项条件同时不满足时的原因优先级。
- 能解释纯函数之后为什么仍需要数据库原子条件更新。

### OUT

- 不接入 Prisma、PostgreSQL、NestJS 或 Worker。
- 不创建 Repository，也不实现实际 Task 更新。
- 不修改既有 Task/AgentRun 迁移表来迁就测试。
- 不把 `SUCCEEDED` 当成需要恢复的失败终态。

## 决策不变量

只有以下条件全部成立，结果才能是 `RESTORE`：

1. Run 已处于 `FAILED`、`CANCELLED` 或 `TIMED_OUT`；
2. 当前 Task 仍处于 `VERIFYING`；
3. 当前 Task 版本等于 Run 保存的预期版本；
4. `taskStateBeforeRun` 属于 `IN_PROGRESS`、`NEEDS_REVISION`、`NEEDS_EVIDENCE`。

否则返回 `SKIP`，不要把合法并发冲突当异常抛出。原因优先级固定为：

1. `RUN_NOT_RECOVERABLE`
2. `TASK_NOT_VERIFYING`
3. `TASK_VERSION_MISMATCH`
4. `PREVIOUS_TASK_STATE_NOT_RESTORABLE`

`RESTORE.expectedTaskVersion` 必须保留输入中的预期版本，供调用方构造条件更新；函数本身不得自行递增版本。

## 验收用例

至少覆盖以下 8 类场景，可以使用 `it.each` 降低重复代码：

1. `FAILED + VERIFYING + 版本一致 + IN_PROGRESS`：允许恢复到 `IN_PROGRESS`。
2. `CANCELLED + VERIFYING + 版本一致 + NEEDS_REVISION`：允许恢复到 `NEEDS_REVISION`。
3. `TIMED_OUT + VERIFYING + 版本一致 + NEEDS_EVIDENCE`：允许恢复到 `NEEDS_EVIDENCE`。
4. `SUCCEEDED`：以 `RUN_NOT_RECOVERABLE` 跳过，不把成功运行回滚。
5. 至少一个非终态 Run（如 `RUNNING` 或 `CANCEL_REQUESTED`）：以 `RUN_NOT_RECOVERABLE` 跳过。
6. Task 已经不在 `VERIFYING`：以 `TASK_NOT_VERIFYING` 跳过，即使版本碰巧一致。
7. Task 仍为 `VERIFYING`，但版本不一致：以 `TASK_VERSION_MISMATCH` 跳过。
8. 运行、当前状态和版本均满足，但 `taskStateBeforeRun` 不可恢复：以 `PREVIOUS_TASK_STATE_NOT_RESTORABLE` 跳过。

额外检查：`RESTORE` 结果保留正确的 `expectedTaskVersion`；所有输入对象在调用后保持不变。

## 真实数据库写入边界

本练习不实现数据库，但你必须能解释调用方为什么仍应执行类似下面的单条原子条件更新：

```text
WHERE task.id = :taskId
  AND task.state = 'VERIFYING'
  AND task.version = :expectedTaskVersion

SET state = :targetTaskState,
    version = version + 1
```

受影响行数为 1 才算恢复成功；为 0 说明读取决策之后发生了并发更新，旧 Run 仍然不能覆盖新状态。纯函数负责可测试的业务判断，数据库条件更新负责消除“判断与写入之间”的竞态窗口。

## 运行命令

```bash
pnpm test:handwrite:stage-1-recovery
pnpm --filter @knowledgeops/contracts typecheck
```

开始时专用测试会显示 1 个 `todo`。完成标准：

- `TODO(user)` 和占位抛错均已移除；
- 至少 8 类验收场景全部通过，0 个 `todo/skip`；
- Contracts 类型检查通过；
- 没有修改生产迁移表或引入数据库依赖。

## 分层提示

### 提示 1：先分类，再决定

先将 Run 是否可恢复、Task 是否仍归当前 Run 控制、旧稳定状态是否合法分成三个概念，不要写成一个难以解释的超长布尔表达式。

### 提示 2：使用 Guard Clauses

按照文档给出的原因优先级逐项提前返回 `SKIP`，最后剩余路径自然就是 `RESTORE`。这样测试名称和失败原因能够一一对应。

### 提示 3：缩窄 targetTaskState

`taskStateBeforeRun` 的输入类型是较宽的 `TaskState`。在构造 `RESTORE` 结果前，先用已有类型守卫把它缩窄为 `RestorableTaskState`，不要使用 `as` 强行断言。

### 提示 4：不要把纯函数误当成锁

即使函数判断允许恢复，在函数返回到 Prisma 写入之间仍可能发生并发更新。面试时必须补充 `state + version` 原子条件和受影响行数检查。

## Review 时需要你解释

- 为什么只检查版本还不够，为什么还要检查 `VERIFYING`；
- 为什么 `SUCCEEDED` 不恢复，而 `FAILED/CANCELLED/TIMED_OUT` 可以恢复；
- 为什么 `taskStateBeforeRun` 不能是任意 TaskState；
- 为什么纯函数通过测试仍不能单独防止数据库丢失更新；
- 为什么并发冲突返回 `SKIP`，而不是把旧 Run 重新排队或抛成系统故障。
