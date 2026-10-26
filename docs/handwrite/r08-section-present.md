# R08：定位指定章节的小手写

状态：2026-10-25 用户完成并报告自测通过，Review 通过。专用验收 6 项、相关回归 31 项及 Worker 类型/lint 检查通过；2026-10-26 用户补报手写实际约 10 分钟，随 R08 单元提交。
预计编码 25 至 35 分钟，导读和 Review 计入 R08 原 4 小时预算。

## 业务位置

用户 Push 后，R06 保存固定 Commit 的 Submission/Evidence；其中 content 是本次笔记正文。
R08 的 parseNoteEvidence 校验正文并生成 AST。新计划的 SECTION_PRESENT 标准通过 config.heading
保存要求的章节名称，例如“事件循环”。旧标准缺参数时，配套检查器直接返回 INSUFFICIENT_EVIDENCE，
不会调用本题函数，也不会根据 description 猜标题。

checkNoteCriteria 在确认章节参数合法后，调用 findRequiredSection(tree, expectedHeading)。
本题只负责定位真实章节的标题，不判断语义、字数、Task 状态，不读数据库、调用模型或联网。
当前生产验收消费者尚未接入；实际调用入口为测试和合成观察，后续 R09 再接入验收工作流。

找到时返回标题自己的原文行范围，调用方据此输出 PASSED，并用 readNoteCitation 生成引用；
没找到时返回 null，调用方输出 FAILED 和修改建议。单项 PASSED 不代表 Task 通过。

## 用一份笔记走通

假设原文第 1 行为 `# JavaScript`，第 2 行为空，第 3 行为 `## 事件循环`，第 4 行为正文。
参数为“事件循环”时，本函数接收整份笔记的 AST 与这个标题字符串，返回第 3 行至第 3 行。
调用方把它关联回该标准 ID，并从固定正文提取第 3 行，附上仓库、Commit、路径和内容哈希。
不用把第 4 行正文算作标题范围，不在本函数中创建 CriterionResult。

若同样的文字只出现在段落或代码块中，不能证明存在章节，返回 null。
若参数根本没有 heading，则是配套代码发现规则不明确，不是本函数返回“章节不存在”。

## 本题边界

- 接收 `parseNoteEvidence` 产出的 AST；仅文档第一层的真实 heading 是章节，标题级别 1 至 6 均可。
  引用块、列表里的标题作为引用/嵌套内容，不计作本题的文档章节；HTML 标签不算 Markdown 标题。
- 匹配的是标题显示文字，去掉首尾空白后完全一致，区分大小写；“浏览器事件循环”不等于“事件循环”。
- 加粗、链接标签、行内代码可组成标题文字；已提供 headingText 帮助提取这些文字，图片 alt 和 HTML 标记不计入。
- 重复标题取原文中第一个匹配项；没有匹配返回 null。
- 返回标题自己的位置，不能推算固定行号；Setext 写法 `事件循环` 加下一行 `-----` 是两行标题。
- 原文空行会影响行号，不能重新格式化 Markdown 后再计算。

配套代码负责参数校验、AST 解析、结果文案和引用生成；只填写
`apps/worker/src/verification/find-required-section.exercise.ts` 的占位函数。
helper、检查器和测试不需要修改。无需实现递归 Markdown 解析器。

## 开始手写

业务导读与理解确认已完成：用户正确说明代码块中的伪标题返回 null，由 checkNoteCriteria 生成单项结果。
此前 6 项专用验收均因同一个占位错误失败，这是准备状态，不是已完成后出现回归。

```powershell
pnpm test:handwrite:r08-section
```

6 项覆盖原始行号、格式化标题、精确匹配、伪标题/空文档、重复与两行标题，以及真实检查器/引用接入。
不用数据库、Redis 或模型。写完并明确告知后进行 Review；blocking 问题由用户修正。

分层提示入口（按需看）：先看 AST 节点的 type 和 position；再看文档第一层 children；
标题文字提取可使用已有 headingText，不必自己拼接格式化节点。
这些只说明数据与已有工具，不提供匹配函数实现。

库接口参考：[mdast-util-to-string](https://github.com/syntax-tree/mdast-util-to-string)。

## Review 记录

用户实现符合第一层真实标题、显示文字精确匹配、重复取第一个、返回原始标题行范围及缺失返回 null 的约定，无 blocking。AI 只修整尾逗号，不改用户匹配逻辑。验收及回归已通过，不要求重复练习；整个 R08 尚需完成剩余展示与收尾工作。
