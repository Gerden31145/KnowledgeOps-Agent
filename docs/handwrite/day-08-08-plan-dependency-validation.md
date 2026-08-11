# 08-08 每日手写：Zod 跨任务依赖校验

## 目标与时间

- 目标耗时：25～35 分钟；已经理解题面并使用分层提示后仍超过 45 分钟时先停下提问。
- 练习重点：使用 Zod `superRefine` 校验单个字段 Schema 无法表达的跨数组关系，并为失败结果提供精确 Issue 路径。
- 业务位置：模型已经返回结构正确的 Stage/Task 数组之后、候选计划进入 Worker 后续落库链路之前。

## 允许修改的文件

1. `packages/agent-core/src/plan-generation/plan-generation.ts`
   - 完成 `planGenerationOutputSchema` 中现有的 `TODO(user, day 08-08)`。
2. `packages/agent-core/test/plan-generation-dependencies.exercise.ts`
   - 把现有 `it.todo` 改成真实测试；可以增加一条用于明确本日边界的测试。

不要修改：

- `packages/agent-core/handwrite/day-08-08-plan-dependencies.acceptance.ts`；
- 其他生产 Schema、Fixture、LangChain 适配器或测试配置。

## 输入与输出

`superRefine` 回调接收已经通过单字段和数组结构校验的完整计划：

```ts
{
  stages: Array<{
    tasks: Array<{
      id: string
      dependsOnTaskIds: string[]
      // 其他字段已经由基础 Schema 校验
    }>
  }>
}
```

它不转换或重新排序计划，也不返回新的计划对象。发现问题时使用校验上下文增加自定义 Issue；没有 Issue 就表示这一层通过。

## 必须满足的不变量

1. Task ID 在整个计划内全局唯一，不能只保证同一个 Stage 内唯一。
2. 每一个 `dependsOnTaskIds` 项都必须能在本次生成计划的 Task ID 集合中找到。
3. Task 不能依赖自己的 ID。
4. 一个依赖可以指向同 Stage 或其他 Stage 中的不同任务，也允许指向数组中稍后出现的任务。
5. 本日不检查依赖环。两个已存在的任务互相依赖，应通过本层引用校验；DAG 环检测属于 08-10。
6. 校验过程不能修改输入数组、Task 或依赖数组。

## Issue 路径要求

- 重复 Task ID：Issue 指向发生重复的 Task 的 `id`。
- 未知依赖或自依赖：Issue 指向具体的 `dependsOnTaskIds` 数组项。
- 使用 `code: 'custom'`；错误文案只需简洁、能区分三种原因，不要求与隐藏验收逐字一致。

精确路径的价值是让日志、模型修复和未来前端错误展示知道“哪个 Stage、哪个 Task、哪一条依赖”失败，而不是只得到整个 Plan 非法。

## 需要完成的测试

1. 两个不同 Stage 出现相同 Task ID，解析失败。
2. 依赖了计划中不存在的 ID，解析失败。
3. Task 依赖自身，解析失败。
4. 依赖另一个真实 Task，包括跨 Stage 或向后引用，解析成功。
5. 两个真实 Task 互相依赖，本层仍解析成功，证明没有提前实现 08-10 的环检测。

测试可以复用：

```ts
import { planGenerationOutputSchema } from '../src/index.js'
import { validPlanGenerationOutput } from './fixtures/plan-generation.js'
```

建议至少对一个失败用例检查 `error.issues` 中的路径，而不只检查 `success === false`。

## 运行命令

```powershell
pnpm test:handwrite:day-08-08-plan-dependencies
```

开始前的预期基线是 3 项隐藏验收失败、2 项通过、4 个可见测试为 todo。完成生产实现和可见测试后，专用命令应全部通过。完整回归由 Review 通过后统一运行。

## 分层提示

### 提示 1：先考虑数据范围

唯一性和引用存在性都覆盖完整 Plan，因此首先需要得到跨 Stage 的全部 Task，同时保留 Stage、Task 和依赖项下标，供 Issue 路径使用。

### 提示 2：避免向后引用误判

若一边遍历一边立即验证依赖，指向后面 Task 的合法依赖可能被误判为不存在。考虑先掌握完整 ID 集合，再检查每个依赖。

### 提示 3：Zod API

`context.addIssue()` 可以一次记录多个错误。遍历数组时使用下标构造路径；不要在发现第一个错误后抛异常或提前返回，否则模型一次只能看到一个需要修复的问题。

### 提示 4：测试夹具

使用展开运算符从 `validPlanGenerationOutput` 构造新对象，避免直接修改共享 Fixture。测试的重点是改变最少字段，让失败原因保持唯一。
