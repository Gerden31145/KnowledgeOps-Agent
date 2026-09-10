# R04 小手写：GitHub 回调 Controller 测试

当前结果（2026-09-10）：三个测试已通过 Review，短复述通过，用户已确认真实产品登录/刷新/退出观察。以下题面与分轮记录保留供追溯，不重复布置；仓库绑定主体已交付，仍待该部分真实观察/理解确认，整个 R04 尚未提交或标记 DONE。

## 目标与预算

用 25 至 35 分钟验证一件事：AuthService 给出成功或失败后，Controller 是否向浏览器发送正确响应。复用之前 HealthController 的 Nest 测试基础，不重写 OAuth、Session、Guard 或仓库绑定。

只改 `apps/api/test/github-auth.controller.exercise.ts` 中的三个测试，并从 `vitest` 补充导入 `expect`。用自己的模拟、调用与断言替换三个 `TODO(user)` 抛错；不修改产品实现或把测试改成 skip/todo。

参考入口只需 `apps/api/src/identity/auth.controller.ts` 的 `callback()` 和 `redirect()`。测试模块、假请求和响应记录器已准备好，无需阅读其他新文件。

## 接口与夹具

被测签名：`callback(query: unknown, request: AuthRequest, response: ServerResponse): Promise<void>`。

- 每题都有全新的 `f`，真实 Controller 已由 Nest 创建，注入的是假的 AuthService；测试结束自动关闭模块。
- `f.auth.completeLogin`：你控制它的 Promise 成功值或拒绝原因；不能 mock 被测的 `callback`。
- `f.auth.clearCookie`：已固定返回 `f.clearedStateCookie`，记录是否用 `'state'` 调用。
- 输入使用 `f.query`、`f.request`、`f.response`。其中 response 和 `f.reply` 是同一个对象；前者方便传参，后者方便检查 `writeHead`、`end` 的调用。
- 预置数据：`f.webOrigin`、`f.sessionCookie`、`f.clearedStateCookie`、`f.invalidStateError`、`f.unexpectedError`。全部是假数据，不能换成真实 code、Cookie 或密钥。
- `callback` 返回的是 `Promise<void>`，可观察结果在响应对象上，不是函数返回的 JSON。

## 三个验收场景

| 场景 | 模拟 Service 结果 | 必须观察到的 HTTP 响应 |
| --- | --- | --- |
| 成功 | 返回 `f.sessionCookie` | 302；Location 为 `${f.webOrigin}/app/plan`；Set-Cookie 包含清除 state 和新会话两项 |
| state 无效 | 拒绝 `f.invalidStateError` | 302；Location 为 `${f.webOrigin}/login?error=invalid-state`；Set-Cookie 只有清除 state，不能签发会话 |
| 未知异常 | 拒绝 `f.unexpectedError` | 302；Location 为 `${f.webOrigin}/login?error=session-unavailable`；Set-Cookie 只有清除 state；输出不能包含原始错误消息 |

每题共同检查：

- `completeLogin` 恰好调用一次，并收到本题原来的 query/request。
- `clearCookie` 恰好调用一次，参数是 `'state'`。
- `writeHead` 恰好调用一次，响应不可缓存（`Cache-Control: no-store`）；`end` 恰好调用一次。
- 必须等待 callback 完成再断言。失败已由 Controller 转换为跳转，不应断言 callback 向外抛出登录错误。

不用逐条背诵其余静态安全响应头，但不能为了简化题目修改产品安全行为。失败场景应检查 Cookie 列表确实只有清除 state，不能只断言“包含清除 state”。

## 运行

仓库根目录执行：

```powershell
pnpm test:handwrite:r04-auth-callback
```

可以先只跑成功场景：

```powershell
pnpm test:handwrite:r04-auth-callback -t "successful callback"
```

不需要启动 WSL、PostgreSQL、Redis、API、Web 或配置 GitHub。初始三个测试会因显式 TODO 抛错而失败，表示练习尚未写，不是数据库未启动。完成后预期为 3 passed、无跳过；测试全绿后仍需 Review 断言覆盖，避免空测试假通过。

## 卡住时按层看提示

1. 先把每题拆成“安排 Service 结果 → 等待 callback → 检查响应”。想清楚成功值是 Cookie 字符串，不是用户对象。
2. 异步 mock 可查 `mockResolvedValue` / `mockRejectedValue`；检查调用使用 `toHaveBeenCalledWith` / `toHaveBeenCalledTimes`。这与之前 HealthController 练习的用法相同。
3. `writeHead` 接收状态码和响应头对象；`expect.objectContaining` 可检查关注的头。Cookie 列表需要严格检查成员数量/内容；未知异常可从 `f.reply.writeHead.mock.calls` 和 `f.reply.end.mock.calls` 检查原始错误消息没有进入输出。

普通卡点超过 15 分钟就提问；如果获得提示后仍预计总计超过 45 分钟，缩小机械工作，不补一整套测试课程。

## 完成与证据边界

写完后回复“R04 小手写完成”并报告本次大致耗时，再进入 Review。此练习只验证 Controller 的响应编排，不证明真实 GitHub 授权、浏览器存 Cookie、数据库事务或全局 Guard 已通过。

真实产品的“登录 → 刷新仍登录 → 退出后工作台受保护”观察仍待用户确认，不能用本题夹具替代。仓库安装/绑定也尚未实现；本题通过不等于整个 R04 完成。

## 2026-09-10 首轮 Review：待修正一项

用户明确交付，报告本次小手写约 1 小时；超出原 25 至 35 分钟预算，不再追加练习或为相似断言要求抽象封装。三个测试已实现真实 Controller 调用，模拟结果和 Cookie 数量/内容、参数传递及调用次数均已覆盖。

- 验证：专用测试 3 项通过，无跳过；相关 HealthController/AuthService 回归 20 项通过；API 类型检查、定向 ESLint 通过。AI 仅机械格式化，未补写业务断言。
- **B1 / blocking：未知异常响应缺少“不泄露原始错误”的完整检查。** 第三个测试的 `objectContaining` 只限定已列出的响应头，允许其他头出现内部错误；`end` 只断言调用次数，即使传入错误消息作为响应体也可能仍然通过。当前产品源码未发现这种泄露，但测试尚未防住该回归；这是原验收表已有要求。
- 修正提示：在第三题检查 `f.reply.writeHead.mock.calls` 与 `f.reply.end.mock.calls` 记录的输出，确保不包含 `f.unexpectedError.message`。可以把调用参数记录转成字符串，再使用否定包含断言；保留已有固定地址、Cookie 和次数检查。无需新增测试文件或修改产品源码。
- 状态：`WAITING_USER_CODE`，只待用户补 B1 并明确完成后复查；短复述、真实产品观察与 R04 提交仍未完成。

### 同日补充后复查：B1 尚未修复

用户已对 writeHead/end 的调用记录逐项增加断言，但 `call` 是参数数组，`f.unexpectedError.message` 是字符串；`expect(call).not.toBe(message)` 只检查两者不是同一个值，即使数组内部含错误字符串也会通过。需要检查内容“不包含”，而非整个数组“不等于字符串”；仅替换这处比较方式，不增加用例。可先用独立假数据 `["secret"]` 理解它与 `"secret"` 不相等、但内部确实含有该字符串的区别。

本轮重跑专用测试 3 项、相关回归 20 项、API 类型与定向 ESLint 均通过，证明现有测试可运行，不证明 B1 已覆盖；未代写或修改手写源码，未运行数据库/真实 GitHub 测试。保持 `WAITING_USER_CODE`，新增用户耗时未报告，不追加练习、复述或提交。

### 同日最终复查：Review 通过

用户改为将每次 writeHead/end 调用参数序列化，再使用 `not.toContain(f.unexpectedError.message)`，并保留一次调用断言，避免空记录无条件通过。原有三条路径、Cookie 精确列表与固定错误原因检查仍在，B1 关闭，没有其他 blocking。

AI 仅机械格式化，未代改断言；格式化后专用验收 3 项、相关回归 20 项、API 类型与定向 ESLint 均通过。进入登录切片 `RECALL`，待短复述与真实产品观察；本项手写 Review 通过不等于 R04 单元 DONE。累计时间沿用已报告约 1 小时，新增修正时间未报告，未创建提交。
