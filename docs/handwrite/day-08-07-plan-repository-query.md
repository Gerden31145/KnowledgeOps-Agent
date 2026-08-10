# 08-07 每日手写：Prisma 关系查询与 Repository 边界

## 目标与边界

目标耗时为 25～35 分钟。你需要完成一个真实的 Prisma Repository 查询，练习关系过滤、嵌套 `select/include`、集合排序和明确返回类型。

本练习只读取一份已经完整落库的计划图，不创建或修改 Plan，不处理生成状态，也不实现 BullMQ Worker。它位于后续“生成成功后读取计划草稿”的服务端查询链路中。

## 手写位置与签名

只修改：

`apps/api/src/plans/plan.repository.ts`

完成已有方法，不修改类名、返回结构或构造函数：

```ts
findGraphByIdForUser(planId: string, userId: string): Promise<PlanGraph | null>
```

可以移除当前用于保持 lint 通过的 `void` 语句和 `TODO(user)` 异常，也可以把参数名从 `_planId/_userId` 改为 `planId/userId`。不要修改验收测试中的数据或断言。

## 输入、输出与不变量

输入：

- `planId`：准备读取的 Plan UUID；
- `userId`：当前用户 UUID。

成功时只返回 `PlanGraph` 声明的字段：

- Plan：`id`、`version`、`status`；
- Stage：`id`、`title`、`position`；
- Task：`id`、`title`、`position`、`type`、`state`。

必须满足：

1. Plan 必须同时匹配 `planId`，并通过 `Plan → LearningGoal → User` 关系属于 `userId`；
2. 不存在和无权访问都返回 `null`，不能先泄露“这份计划存在”；
3. Stage 按 `position` 升序，且每个 Stage 内的 Task 也按 `position` 升序；
4. 只执行一次 Prisma 查询，不先查归属再查计划；
5. 不在 JavaScript 中重新 `sort` 或拼装对象；让数据库查询直接返回目标结构；
6. 不使用 `as PlanGraph` 等类型断言掩盖字段或类型问题，也不返回 Goal、描述、时间戳等多余字段。

## 验收用例

专用测试覆盖以下行为：

1. 当前用户可以读取自己的计划；
2. 返回对象只包含 `PlanGraph` 约定字段；
3. 两个 Stage 即使按反序插入，也必须按 `position` 升序返回；
4. 同一 Stage 的两个 Task 即使按反序插入，也必须按 `position` 升序返回；
5. 其他用户读取同一 `planId` 时返回 `null`；
6. 当前用户读取不存在的 `planId` 时返回 `null`。

## 运行命令

先确保 PostgreSQL 与迁移正常：

```powershell
pnpm infra:check
pnpm db:migrate:status
```

如果 `infra:check` 明确报告本地服务未启动，并且 WSL 本身能够正常响应，再执行：

```powershell
pnpm infra:up
```

只运行本次手写验收：

```powershell
pnpm test:handwrite:day-08-07-plan-query
```

通过后再做静态检查：

```powershell
pnpm --filter @knowledgeops/api typecheck
pnpm lint
```

当前专用测试因保留的 `TODO(user)` 失败是预期状态。

## 分层提示

### 提示 1：选择查询入口

从 `this.database.plan` 上选择一个能同时表达“计划 ID + 关系归属”的单记录查询 API。思考为什么只按 ID 的查询不足以解决越权问题。

### 提示 2：把鉴权写进同一条 where

Prisma 的关系过滤可以沿着 Plan 的 `goal` 关系约束其 `userId`。把资源定位与所有权过滤放在同一次数据库查询中。

### 提示 3：精确选择字段

观察 `PlanGraph`、`PlanGraphStage` 和 `PlanGraphTask` 三个接口。使用嵌套选择，使查询结果天然符合这些接口，而不是先取得整行再删除字段。

### 提示 4：排序属于每一层集合

Stage 和 Task 是两个独立的一对多集合；外层集合的排序不会自动影响内层集合。分别在对应关系层声明升序。

### 提示 5：让 TypeScript 帮你验收

保留方法的 `Promise<PlanGraph | null>` 返回类型，不添加类型断言。若 Prisma 返回结果无法赋给它，优先检查遗漏字段、字段层级或选择结构。
