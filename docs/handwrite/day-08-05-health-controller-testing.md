# 08-05 每日手写：用 Nest TestingModule 测试 HealthController

## 目标与边界

目标耗时为 25～35 分钟。你需要用 NestJS 官方测试容器实例化 `HealthController`，练习 Controller、Provider Token、`useValue` 注入、异步断言和 Nest HTTP 异常。

本练习只测试 Controller 边界，不启动 HTTP Server，也不连接 PostgreSQL 或 Redis。不要修改 `HealthController`、`HealthService` 或真实 Probe；测试中的 `HealthService` 必须是可观察调用次数的 Stub/Mock。

## 手写位置

将 `apps/api/test/health.controller.spec.ts` 中的 `describe.todo` 替换为真实测试。

建议在测试局部保存以下两个对象，具体命名可自行调整：

```ts
controller: HealthController
healthService: Pick<HealthService, 'getLiveness' | 'getReadiness'>
```

每个测试都应通过 `Test.createTestingModule(...).compile()` 得到模块，再从测试模块中解析 `HealthController`；不要直接 `new HealthController(...)`。

## 输入、输出与不变量

- `getLiveness()`：同步委托给 `HealthService.getLiveness()`，原样返回契约合法的 `alive` 响应。
- `getReadiness()`：异步委托给 `HealthService.getReadiness()`。
- 当 readiness 为 `ready` 时，Controller 原样返回响应。
- 当 readiness 为 `not_ready` 时，Controller 必须抛出 `ServiceUnavailableException`；异常状态码为 `503`，异常响应体保留完整 readiness 对象。
- Controller 测试不重复验证 Probe 的数据库/Redis 检查细节；那属于 `HealthService` 测试范围。

## 验收用例

最终应有 4 个通过的测试且没有 `todo`/`skip`：

1. 测试模块能够使用 `HealthService` Token 注入 `useValue` Stub，并解析出 `HealthController`。
2. `getLiveness()` 返回 Stub 给出的完整对象，且对应 Service 方法恰好调用一次。
3. readiness 为 `ready` 时，`getReadiness()` 返回完整对象，且对应 Service 方法恰好调用一次。
4. readiness 为 `not_ready` 时，调用被拒绝为 `ServiceUnavailableException`；同时断言 `503` 和完整响应体，不能只断言“抛了一个错误”。

时间戳使用固定 ISO 字符串，延迟和 uptime 使用固定非负数，避免测试依赖当前时间或真实进程状态。

## 运行命令

```bash
pnpm test:handwrite:health-controller
pnpm --filter @knowledgeops/api typecheck
```

开始时第一条命令会显示 1 个 `todo`；完成标准是 4 个测试全部通过、0 个 `todo`。你写完后告诉我“08-05 手写完成”，我会 Review，再运行当天完整回归。

## 分层提示

按需逐层使用，能独立完成就不要继续往下看。

### 提示 1：容器结构

测试元数据与生产 `@Module()` 的形状相似：Controller 放在 `controllers`，其依赖使用同一个类 Token 放在 `providers`。编译后通过测试模块的 `get` 方法取实例。

### 提示 2：替换 Provider

`HealthController` 构造函数按 `HealthService` 这个 Token 查找依赖。测试里可以使用对象形式 Provider，将 `provide` 指向该 Token，将 `useValue` 指向包含两个 `vi.fn` 方法的对象。

### 提示 3：同步与异步 Mock

`getLiveness` 是同步方法；`getReadiness` 返回 Promise。分别选择 Vitest 的同步返回值和异步 resolve Mock API，不需要自行包 `new Promise`。

### 提示 4：检查 503 细节

仅使用 `rejects.toThrow()` 无法证明状态码和响应体正确。捕获异常后先缩窄为 `ServiceUnavailableException`，再检查它公开的状态码与响应读取方法。

## Review 时需要你解释

- 为什么 `TestingModule` 能把一个普通 Mock 对象注入声明为 `HealthService` 的构造参数；
- 为什么 Controller 测试不应连接真实 PostgreSQL/Redis；
- 为什么这个测试能证明 Controller 的异常边界，却不能证明 `/health/ready` 的真实路由和 HTTP 序列化一定正确。
