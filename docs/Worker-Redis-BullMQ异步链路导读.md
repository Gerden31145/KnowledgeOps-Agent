# Worker、Redis 与 BullMQ 异步链路导读

本文只解释 KnowledgeOps Agent 中 Worker、Redis、BullMQ、Outbox Dispatcher 和 Processor 是怎样搭建并连接起来的。阅读目标是能够回答以下问题：

- `apps/worker`、BullMQ `Worker` 和 Processor 分别是什么；
- BullMQ `Queue` 到底做什么，任务实际保存在哪里；
- Worker 进程启动时创建了哪些对象；
- 一条 `PLAN_GENERATION_REQUESTED` 事件怎样从 PostgreSQL 到达业务处理器；
- 当前 08-09 代码已经完成到哪里。

## 1. 先建立最小心智模型

| 名称 | 本质 | 当前项目中的职责 |
| --- | --- | --- |
| Redis | 独立运行的内存数据服务 | 保存 BullMQ 的等待、执行中、延迟和失败等队列数据 |
| BullMQ | 基于 Redis 的 Node.js 队列库 | 提供 Job 入队、消费、重试、退避和并发控制等 API |
| `apps/worker` | 独立的 NestJS/Node.js 后台进程 | 运行 Outbox Dispatcher、BullMQ 消费者和业务 Processor |
| BullMQ `Queue` | 生产者客户端对象 | 将 Job 写入 Redis 中指定名称的队列 |
| BullMQ `Worker` | 消费者客户端对象 | 从 Redis 中领取 Job，并调用指定 Processor |
| Processor | Job 与业务代码之间的处理入口 | 校验 Job，再调用计划生成业务处理器 |

最需要记住的是：

> `Queue` 向 Redis 生产 Job，BullMQ `Worker` 从 Redis 消费 Job；`apps/worker` 是容纳这些后台对象的 Node.js 进程。

当前的数据方向是：

```text
PostgreSQL Outbox
        ↓
Outbox Dispatcher
        ↓ publish()
BullMQ Queue（生产者客户端）
        ↓ 写入
Redis 中的命名队列
        ↓ 领取
BullMQ Worker（消费者客户端）
        ↓ 调用
Processor
        ↓
计划生成业务处理器
```

Dispatcher 和 BullMQ Worker 不会直接调用对方。即使它们现在运行在同一个 `apps/worker` 进程中，二者之间仍然隔着 Redis。

## 2. 三种容易混淆的 Worker

项目中至少有三处容易被统称为“Worker”的概念。

### 2.1 `apps/worker`

这是一个独立应用，入口是 [`apps/worker/src/main.ts`](../apps/worker/src/main.ts)。它不提供 HTTP 接口，所以使用：

```ts
NestFactory.createApplicationContext(WorkerModule)
```

而不是创建 HTTP Server 后调用 `listen()`。

NestJS 在这里主要提供：

- 依赖注入；
- 配置装配；
- 应用启动和关闭生命周期；
- 结构化日志；
- 数据库服务管理。

### 2.2 BullMQ `Worker`

这是从 `bullmq` 包导入的消费者类。它连接 Redis、等待指定队列里的 Job，并在取得 Job 后调用 Processor。

它是 `apps/worker` 进程中的一个长驻对象，不等于整个 `apps/worker` 应用。

### 2.3 `PlanGenerationJobProcessor`

这是项目自己的业务处理入口，位于 [`apps/worker/src/plan-generation/plan-generation-job-processor.ts`](../apps/worker/src/plan-generation/plan-generation-job-processor.ts)。

BullMQ `Worker` 负责“取得 Job”，Processor 负责“收到 Job 后执行什么”。二者关系是：

```text
BullMQ Worker
    ↓ 取得一个 Job 后调用
createPlanGenerationBullMqProcessor()
    ↓ 校验并适配
PlanGenerationJobProcessor.process()
```

## 3. Queue 到底是什么

`Queue` 最容易被误解成 Node.js 内存中的任务数组。它实际上更像 Prisma Client：

```text
Prisma Client ──操作──> PostgreSQL 中的数据
BullMQ Queue  ──操作──> Redis 中的 Job 数据
```

代码中的：

```ts
new Queue(queueName, { connection })
```

会创建一个连接指定 Redis 和队列名称的生产者客户端。真正的等待任务不保存在这个 JavaScript 对象里，而保存在 Redis 中。

### 3.1 Queue 负责什么

- 接收 Job 名称；
- 接收 Job payload；
- 接收 Job ID、重试和退避等选项；
- 使用 BullMQ 协议把 Job 写入 Redis；
- 提供查询或管理 Redis 中 Job 的 API。

### 3.2 Queue 不负责什么

- 不从 PostgreSQL 查找 OutboxEvent；
- 不决定某条 OutboxEvent 是否应该重试或进入死信；
- 不在自身内存中长期保存任务列表；
- 不主动调用业务 Processor；
- 不决定计划生成运行的业务终态。

因此，“Queue 负责维护队列”更准确的表达是：

> BullMQ `Queue` 是操作 Redis 队列的生产者客户端；队列数据实际保存在 Redis 中，具体存储结构由 BullMQ 维护。

## 4. Redis 在哪里运行，代码怎样连接它

本地开发时，Redis 是 WSL 中独立运行的服务。根目录执行：

```bash
pnpm infra:up
```

最终会通过 [`scripts/wsl-native-infra.sh`](../scripts/wsl-native-infra.sh) 启动 `redis-server`。

Worker 使用环境变量连接 Redis：

```env
REDIS_URL=redis://127.0.0.1:6379
```

相关位置：

- [`.env.example`](../.env.example)：示例地址；
- [`apps/worker/src/config/environment.ts`](../apps/worker/src/config/environment.ts)：使用 Zod 读取并校验 `REDIS_URL`；
- [`apps/worker/src/worker-runtime.service.ts`](../apps/worker/src/worker-runtime.service.ts)：把地址传给 BullMQ 适配器。

项目代码没有手写 `LPUSH`、`BRPOP` 等 Redis 命令，因为 BullMQ 已经封装了 Job 的 Redis 存取、状态移动和领取协议。

API 侧还有一个直接使用 `node-redis` 的 [`RedisReadinessProbe`](../apps/api/src/health/redis-readiness.probe.ts)，但它只执行 `PING` 来检查 Redis 是否可用，不参与 BullMQ 入队或消费。

## 5. Worker 启动时怎样完成装配

### 5.1 `main.ts` 启动 NestJS 应用上下文

入口 [`apps/worker/src/main.ts`](../apps/worker/src/main.ts) 执行：

```text
读取 Worker 环境变量
    ↓
创建 StructuredLogger
    ↓
NestFactory.createApplicationContext(WorkerModule)
    ↓
启用关闭钩子
```

`main.ts` 自己不直接创建 BullMQ Queue、BullMQ Worker 或 Dispatcher。

### 5.2 `WorkerModule` 注册依赖

[`apps/worker/src/worker.module.ts`](../apps/worker/src/worker.module.ts) 导入配置和数据库模块，并注册：

- `PlanGenerationJobProcessor`；
- `WorkerRuntimeService`。

NestJS 随后为 `WorkerRuntimeService` 注入：

```text
WORKER_ENVIRONMENT
DatabaseService
PlanGenerationJobProcessor
```

### 5.3 `WorkerRuntimeService` 创建运行时对象

应用完成初始化时，NestJS 自动调用 [`WorkerRuntimeService.onApplicationBootstrap()`](../apps/worker/src/worker-runtime.service.ts)。该方法依次完成：

1. 创建 `BullMqPlanGenerationQueue` 适配器；
2. 调用适配器的 `start()` 注册 BullMQ 消费者；
3. 创建 `OutboxDispatcher`，并把同一个队列适配器作为 `OutboxPublisher` 传入；
4. 创建并启动 `OutboxDispatchLoop`；
5. 记录 Worker Runtime 已启动的日志。

对象关系如下：

```text
WorkerRuntimeService
│
├── BullMqPlanGenerationQueue（项目适配器）
│   ├── queue: BullMQ Queue
│   │   └── 生产 Job
│   └── worker: BullMQ Worker
│       └── 消费 Job
│
├── OutboxDispatcher
│   └── publisher 指向上面的 BullMqPlanGenerationQueue
│
└── OutboxDispatchLoop
    └── 周期性触发上面的 Dispatcher
```

这里的命名容易混淆：`WorkerRuntimeService` 的 `this.queue` 是我们自己写的 `BullMqPlanGenerationQueue` 适配器；适配器内部的 `private queue` 才是 BullMQ `Queue`。

## 6. `BullMqPlanGenerationQueue` 为什么同时持有 Queue 和 Worker

[`apps/worker/src/queue/bullmq-plan-generation-queue.ts`](../apps/worker/src/queue/bullmq-plan-generation-queue.ts) 是项目代码与 BullMQ 之间的适配器。它集中管理：

- 生产者 Queue 的创建和关闭；
- 消费者 Worker 的创建和关闭；
- Redis 连接配置；
- Queue 和 Worker 的错误、成功及失败日志；
- Outbox `publish()` 到 BullMQ 入队 API 的转换；
- BullMQ Job 到项目 Processor 的连接。

当前为了减少本地开发和部署单元，Dispatcher 和消费者都运行在同一个 `apps/worker` 进程里。但生产和消费仍然是两个不同对象：

```text
适配器.publish()
    ↓
BullMQ Queue
    ↓
Redis
    ↓
BullMQ Worker
    ↓
Processor
```

### 6.1 生产者连接

生产者首次创建连接时保留 BullMQ 默认的 readiness 等待，避免在 TCP stream 尚未可写时执行初始化命令。连接建立后，如果 Dispatcher 持有数据库行锁期间发生 Redis 中断，`enableOfflineQueue: false` 会让命令快速失败，而不是在 Node.js 内存中暂存；错误随后回到 Dispatcher，由 PostgreSQL 中的 Outbox 重试策略记录并安排下一次投递。

### 6.2 消费者连接

消费者是长驻后台对象，需要持续等待任务，因此允许长期重连。它不应该因为一次短暂 Redis 波动就把整个消费职责永久关闭。

## 7. 一条生成任务的完整旅程

### 7.1 API 创建业务运行和 OutboxEvent

API 的 [`PlanGenerationRepository.accept()`](../apps/api/src/plan-generation/plan-generation.repository.ts) 在同一个 PostgreSQL 事务中创建：

```text
PlanGenerationRun
└── status = QUEUED

OutboxEvent
├── type = PLAN_GENERATION_REQUESTED
└── payload = { generationRunId }
```

此时只是可靠登记“需要执行一次计划生成”，还没有创建 BullMQ Job。

### 7.2 `OutboxDispatchLoop` 周期性触发 Dispatcher

[`apps/worker/src/outbox/outbox-dispatch-loop.ts`](../apps/worker/src/outbox/outbox-dispatch-loop.ts) 使用定时循环调用：

```text
dispatcher.dispatchAvailable(batchSize)
```

`inFlight` 用来避免同一个进程中的上一次扫描还没有结束，下一轮扫描又重叠执行。

### 7.3 Dispatcher 领取并解析 OutboxEvent

[`apps/worker/src/outbox/outbox-dispatcher.ts`](../apps/worker/src/outbox/outbox-dispatcher.ts) 在数据库事务中：

1. 查询已经到达 `availableAt`、尚未分发且未进入死信的事件；
2. 使用 `FOR UPDATE SKIP LOCKED` 避免多个 Dispatcher 同时处理同一行；
3. 把数据库记录解析为项目定义的 `PlanGenerationOutboxMessage`；
4. 调用 `publisher.publish(message)`。

Dispatcher 只依赖下面这个窄接口：

```ts
interface OutboxPublisher {
  publish(message: PlanGenerationOutboxMessage): Promise<{ jobId: string }>
}
```

运行时传入的实现是 `BullMqPlanGenerationQueue`。因此 Dispatcher 知道“发布消息”，但不知道 BullMQ 的具体 API 和连接选项。

### 7.4 Queue 把 Job 写入 Redis

调用关系是：

```text
OutboxDispatcher
    ↓ publisher.publish(message)
BullMqPlanGenerationQueue.publish()
    ↓ addPlanGenerationJob(...)
BullMQ Queue
    ↓
Redis
```

共享契约 [`packages/contracts/src/events/plan-generation.ts`](../packages/contracts/src/events/plan-generation.ts) 定义了：

- Queue 名：`plan-generation`；
- Job 名：`generate-plan`；
- Job payload：`{ generationRunId }`；
- 稳定 Job ID 的构造规则。

队列消息只携带 `generationRunId`。Processor 后续根据这个 ID 查询 PostgreSQL 中的最新业务事实，而不是把完整目标、模型密钥或大块业务快照复制进 Redis。

Dispatcher 得到入队确认后，才把 OutboxEvent 标记为已分发；如果发布失败，则记录可重试失败或不可重试死信。

### 7.5 BullMQ Worker 从 Redis 领取 Job

适配器的 `start()` 会使用与生产者相同的：

- Redis 地址；
- Queue 名称 `plan-generation`；

注册 BullMQ Worker。

它不需要由 Queue 对象直接调用。生产者和消费者只要连接同一个 Redis、使用同一个 Queue 名称，就能在队列中会合。

BullMQ Worker 领取到 Job 后，调用 `createPlanGenerationBullMqProcessor()` 返回的 Processor。

### 7.6 Processor 校验并进入业务处理器

[`createPlanGenerationBullMqProcessor()`](../apps/worker/src/plan-generation/plan-generation-job-processor.ts) 是 BullMQ 类型与项目业务类型之间的边界，负责：

1. 检查 Job 名是否为 `generate-plan`；
2. 使用 Zod 校验 `job.data`；
3. 把合法 payload 交给 `PlanGenerationJobHandler.process()`；
4. 将明确的永久错误转换为 BullMQ `UnrecoverableError`；
5. 让临时运行错误继续抛出，以便 BullMQ 按策略重试。

最终调用当前的 `PlanGenerationJobProcessor.process()`。

## 8. PostgreSQL 与 Redis 在这条链路中的数据边界

理解这条边界可以避免把 BullMQ Job 状态误当成产品业务状态。

```text
PostgreSQL：业务真相源
├── LearningGoal
├── PlanGenerationRun 的业务状态
├── OutboxEvent 和分发历史
├── 最终 Plan、Stage、Task 与依赖
└── 业务失败、超时和重试关系

Redis / BullMQ：执行调度层
├── 等待执行的 Job
├── 正在执行的 Job
├── 延迟和技术重试
├── 消费并发
└── BullMQ 级完成或失败信息
```

因此：

- BullMQ Job 完成不应替代 PostgreSQL 中的 `PlanGenerationRun = SUCCEEDED`；
- BullMQ Job 失败不应成为前端唯一的错误真相；
- Worker 执行业务后仍要把结果和业务终态写回 PostgreSQL；
- 前端状态查询读取业务 API/PostgreSQL，而不是直接读取 Redis。

## 9. 应用关闭时怎样清理

NestJS 关闭应用时会调用 `WorkerRuntimeService.onApplicationShutdown()`：

```text
停止 OutboxDispatchLoop
    ↓ 等待正在进行的扫描结束
关闭 BullMQ Worker
    ↓
关闭 BullMQ Queue
    ↓
断开 PostgreSQL
```

这个顺序避免继续领取或发布新任务时，底层 Redis 或 PostgreSQL 连接已经被提前关闭。

## 10. 截至 08-09 的实现边界

08-09 的 AI 主体已经搭好：

- Worker 的 NestJS 启动和生命周期装配；
- Outbox 定时扫描；
- Dispatcher 的领取、发布、退避和死信分支；
- BullMQ 适配器和生产者/消费者连接配置；
- Queue 名、Job 名、payload 和稳定 Job ID 契约；
- Processor 的 Job 名称、payload 和错误类型边界；
- PostgreSQL Dispatcher 集成测试和 Processor 单元测试。

在 08-09 主体导读阶段，下面两处被有意保留为每日手写缺口：

- `addPlanGenerationJob()`：使用 BullMQ Queue 完成实际入队；
- `registerPlanGenerationWorker()`：创建实际消费者并连接 Processor。

它们位于 [`apps/worker/src/queue/bullmq-plan-generation-queue.exercise.ts`](../apps/worker/src/queue/bullmq-plan-generation-queue.exercise.ts)。本文只说明它们在链路中的职责，不提供完整函数实现。

当前 `PlanGenerationJobProcessor` 仍然只是“合法 Job 已到达”的骨架处理器。读取运行、调用 LangChain、写入完整 Plan 和修改业务终态属于后续计划日。

## 11. 推荐阅读顺序

如果以后忘记，可以按下面顺序重新阅读：

1. [`apps/worker/src/main.ts`](../apps/worker/src/main.ts)：Worker 应用入口；
2. [`apps/worker/src/worker.module.ts`](../apps/worker/src/worker.module.ts)：NestJS 注册了哪些依赖；
3. [`apps/worker/src/worker-runtime.service.ts`](../apps/worker/src/worker-runtime.service.ts)：所有后台对象怎样组装；
4. [`apps/worker/src/outbox/outbox-dispatch-loop.ts`](../apps/worker/src/outbox/outbox-dispatch-loop.ts)：谁周期性触发分发；
5. [`apps/worker/src/outbox/outbox-dispatcher.ts`](../apps/worker/src/outbox/outbox-dispatcher.ts)：怎样从 Outbox 发布消息；
6. [`apps/worker/src/queue/bullmq-plan-generation-queue.ts`](../apps/worker/src/queue/bullmq-plan-generation-queue.ts)：生产者与消费者怎样连接 Redis；
7. [`apps/worker/src/queue/bullmq-plan-generation-queue.exercise.ts`](../apps/worker/src/queue/bullmq-plan-generation-queue.exercise.ts)：入队和注册消费者的 BullMQ API 接缝；
8. [`apps/worker/src/plan-generation/plan-generation-job-processor.ts`](../apps/worker/src/plan-generation/plan-generation-job-processor.ts)：Job 如何进入业务处理器；
9. [`packages/contracts/src/events/plan-generation.ts`](../packages/contracts/src/events/plan-generation.ts)：跨模块共享的 Queue/Job 契约。

## 12. 最终复述模板

> `main.ts` 只负责启动没有 HTTP Server 的 NestJS Worker 应用。Nest 初始化 `WorkerRuntimeService` 后，由它创建 `BullMqPlanGenerationQueue` 适配器、BullMQ 消费者和 Outbox 定时循环。Dispatcher 从 PostgreSQL 读取尚未分发的 OutboxEvent，通过适配器内部的 BullMQ Queue 将 Job 写入 Redis；Queue 是生产者客户端，不是保存任务的内存数组。连接同一 Redis 和同一 Queue 名称的 BullMQ Worker 随后领取 Job，先经过 Processor 的名称、payload 和错误分类校验，再调用项目业务处理器。PostgreSQL 保存业务事实，Redis/BullMQ 负责执行调度。
