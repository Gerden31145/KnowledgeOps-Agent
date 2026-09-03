# 08-09 每日手写：BullMQ 入队与 Worker 注册

## 在完整链路中的位置

AI 已实现 PostgreSQL Outbox 的锁定、投递成功标记、失败退避、dead-letter 与重启补扫，也实现了队列消息 Schema、错误分类和 Worker 业务处理骨架。你要补的是 BullMQ 适配器中最贴近框架 API 的两小段：怎样把一个生成意图加入队列，以及怎样注册消费它的 Worker。

这两个函数故意集中在：

- `apps/worker/src/queue/bullmq-plan-generation-queue.exercise.ts`
- `packages/contracts/test/plan-generation-job-id.exercise.ts`

不要修改 Dispatcher、运行时编排或验收文件来绕过缺口。

## 已有契约

- Queue 名与 Job 名由 contracts 提供；
- Job 数据只有 `generationRunId`，进入业务处理器前仍会再次运行时校验；
- 稳定 ID 必须来自 `buildPlanGenerationJobId()`；
- `attempts` 表示总尝试次数，不是“第一次以后再重试几次”；
- backoff 使用 BullMQ 内置的指数策略；
- 成功和失败 Job 在本阶段都保留，以维持队列内去重与故障证据；永久业务错误由现有 processor 包装成 `UnrecoverableError`。

## 验收边界

完成后应满足：

1. 相同 `generationRunId` 两次入队得到相同 Job ID，队列中只有一个 Job；
2. Job 保存给定的总尝试次数与指数退避基准；
3. Worker 使用给定 Queue 名、连接、并发数和 processor；
4. 已提交 Outbox 能被消费；重复补发不触发第二次处理；
5. Queue/Worker 关闭后重新创建，未完成的新事件仍可继续处理；
6. 稳定 Job ID 的确定性、输入边界和禁止冒号由你补充可读单测。

## 你的手写范围（目标 25～35 分钟）

### A. 完成 BullMQ 入队与消费者注册

文件：`apps/worker/src/queue/bullmq-plan-generation-queue.exercise.ts`

完成以下两个函数，不修改现有签名：

```ts
addPlanGenerationJob(
  queue,
  payload,
  options,
): Promise<{ jobId: string }>

registerPlanGenerationWorker(options): PlanGenerationWorker
```

`addPlanGenerationJob()` 的输入与输出要求：

- 输入 `payload` 是已经通过上游契约解析的 `{ generationRunId }`；
- 使用共享契约中的 Job 名称，不在本文件重复硬编码字符串；
- 使用 `buildPlanGenerationJobId()` 生成稳定 Job ID；
- 将 `attempts` 原样解释为总尝试次数；
- 使用 BullMQ 内置指数退避，延迟基准来自 `backoffDelayMs`；
- 成功和失败 Job 都保留，不在完成或失败后自动删除；
- 返回值中的 `jobId` 必须是本次使用的稳定 ID，类型必须始终为 `string`。

`registerPlanGenerationWorker()` 的要求：

- 使用传入的 `queueName` 注册消费者；
- 使用传入的 `processor` 处理 Job；
- 将 `connection` 和 `concurrency` 传给 BullMQ Worker；
- 不在函数内重新创建 Queue、Processor 或 Redis URL；
- 直接返回创建出的 BullMQ Worker，生命周期仍由外层适配器管理。

### B. 补充稳定 Job ID 边界测试

文件：`packages/contracts/test/plan-generation-job-id.exercise.ts`

移除 `describe.skip` 和占位测试，至少覆盖以下四类行为：

1. 同一个合法 `generationRunId` 多次调用得到完全相同的 Job ID；
2. 不同运行 ID 得到不同 Job ID；
3. 结果使用约定前缀和连字符，且不包含冒号；
4. 非法实体 ID 会在生成 Job ID 时被拒绝，而不是生成一个看似合法的队列键。

测试数据使用代码内生成的 UUID 或明确的固定合法 UUID，不依赖数据库和 Redis。

## 不要修改的文件

为保证黑盒验收有效，不要通过修改以下文件绕过缺口：

- `apps/worker/handwrite/day-08-09-bullmq.acceptance.ts`；
- `apps/worker/src/outbox/**`；
- `apps/worker/src/worker-runtime.service.ts`；
- `apps/worker/src/plan-generation/plan-generation-job-processor.ts`；
- `vitest.handwrite.day-08-09.config.ts`。

## 建议时间分配

- 10～12 分钟：阅读 BullMQ `Queue.add()` 参数并完成入队；
- 5～8 分钟：完成 BullMQ Worker 注册；
- 8～10 分钟：补 Job ID 边界测试；
- 5 分钟：运行测试、类型检查并修正。

## 运行命令

先确认 PostgreSQL 与 Redis 可用：

```bash
pnpm infra:check
```

先运行不依赖基础设施的 Job ID 测试：

```bash
pnpm exec vitest run packages/contracts/test/plan-generation-job-id.exercise.ts
```

再运行真实 PostgreSQL + Redis + BullMQ 黑盒验收：

```bash
pnpm test:handwrite:day-08-09-bullmq
```

最后运行类型检查：

```bash
pnpm typecheck
```

完成后告诉我“08-09 手写完成”，由我进入 Review。完整回归和 08-09 集成测试由 Review 通过后统一执行。

## 分层提示

### 提示 1：先回忆两个 BullMQ API 的形状

- 入队使用 `queue.add(jobName, payload, jobOptions)`；
- 注册消费者使用 `new Worker(queueName, processor, workerOptions)`。

先根据现有函数参数判断每个值应该放在哪个位置，不要增加新的配置来源。

### 提示 2：区分业务选项与 BullMQ 选项

`PlanGenerationJobOptions` 是项目自己的窄类型。你需要把它映射为 BullMQ 能理解的 Job 选项，而不是直接把整个 `options` 原样传入。

指数退避是一个带“策略类型”和“基准延迟”的嵌套配置；Job ID、总尝试次数和完成/失败保留策略与它处于同一层。

### 提示 3：处理返回类型时不要依赖可选 ID

稳定 Job ID 在调用 `queue.add()` 以前就可以由业务输入确定。思考为什么直接返回这个已经过契约函数生成的字符串，比在入队后对一个可能被类型声明为可选的字段使用 `as string` 更可靠。

### 提示 4：测试只验证公开行为

Job ID 测试只调用 `buildPlanGenerationJobId()` 并断言返回值或抛错，不读取内部 Schema，也不要复制实现逻辑后再比较两个副本。
