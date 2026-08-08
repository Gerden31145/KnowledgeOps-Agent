# 08-06 每日手写：LearningGoal 输入 Zod Schema

## 目标与边界

目标耗时为 25～35 分钟。你需要完成一个真实 HTTP 输入契约，练习 Zod 的对象 Schema、字符串与数字约束、严格模式，以及依赖当前日期的对象级业务校验。

本练习只负责把不可信 JSON 校验并规范化为 LearningGoal 输入。它不写数据库、不校验模型白名单，也不生成 Plan。模型 ID 会在后续生成计划的请求契约中与 LearningGoal 数据组合；API Key 永远不属于这个 Schema。

## 手写位置与函数签名

只修改：

`packages/contracts/src/http/learning-goal.ts`

完成已有函数，不修改函数名或参数：

```ts
createLearningGoalInputSchema(today: string)
```

`today` 是调用方根据用户时区得到并注入的合法 `YYYY-MM-DD` 日期。不要在 Schema 内读取当前系统时间，否则测试、服务器时区和午夜边界可能产生不同结果。

保留并使用文件中的 `LEARNING_GOAL_INPUT_LIMITS`。日期格式校验复用 `packages/contracts/src/shared/primitives.ts` 中已有的 `isoDateSchema`，不要重新编写日期正则。

## 输入、输出与不变量

Schema 只允许以下四个必填字段：

- `title`：去除首尾空白后长度为 3～160；
- `currentLevel`：去除首尾空白后长度为 2～500；
- `deadline`：真实存在的 `YYYY-MM-DD` 日期，必须晚于 `today`，且最多是 `today` 后第 90 天；
- `weeklyMinutes`：数字类型的整数，范围为 60～2400，不把字符串自动转换为数字。

对象必须拒绝未知字段。成功解析后，两个文本字段应已经去除首尾空白。日期范围产生的自定义 Issue 必须挂在 `deadline` 路径，使前端能把错误显示到对应表单项。

## 验收用例

仓库已准备 6 类黑盒用例：

1. 合法输入通过，并输出 trim 后的文本；
2. 任一必填字段缺失或出现未知字段时失败；
3. 纯空白文本失败，字符串边界值通过，越界值失败；
4. 每周分钟数的上下界通过，小数、越界值和字符串数字失败；
5. 格式错误、不存在、当天和过去的日期失败，错误归属 `deadline`；
6. `today` 后第 90 天通过，第 91 天失败，错误归属 `deadline`。

不要修改限制常量或验收测试来让测试变绿。

## 运行命令

```bash
pnpm test:handwrite:day-08-06-goal-input
pnpm --filter @knowledgeops/contracts typecheck
```

当前第一条命令应失败。完成标准是 6 个测试全部通过，且 Contracts 类型检查通过。

## 分层提示

按需逐层使用；能独立完成就不要继续往下看。

### 提示 1：先完成字段级规则

先组合严格对象 Schema 和四个字段。文本规则的调用顺序应确保长度针对 trim 后的字符串；数字需要同时满足类型、整数和上下界。

### 提示 2：格式规则与业务规则分层

`isoDateSchema` 只负责日期格式以及日期是否真实存在。“晚于今天、不超过 90 天”属于额外的业务范围规则，应在字段格式通过后判断。

### 提示 3：对象级 refinement

对象级 `refine` 或 `superRefine` 可以读取 `deadline`。当你需要明确设置 Issue 路径时，带校验上下文的方式更直接。自定义 Issue 的路径应指向 `deadline`。

### 提示 4：日期计算保持确定性

将 `today` 和 `deadline` 都按 UTC 的日期边界转换，再计算相差的完整天数。根据“不允许今天、允许第 90 天”确定合法区间，避免混入本地时区或小时部分。

## Review 时需要解释

- 为什么 TypeScript 类型断言不能替代运行时 Schema；
- 为什么严格对象 Schema 和 TypeScript 的额外属性检查不是一回事；
- 为什么 `today` 由调用方注入，而不是在 Schema 中读取系统时间；
- 为什么共享契约不应把字符串 `"600"` 静默转换为数字。

完成后告诉我“08-06 手写完成”。我会先 Review 你的实现，不会直接覆盖核心答案。
