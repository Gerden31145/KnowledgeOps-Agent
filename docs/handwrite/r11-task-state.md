# R11：从逐项验收事实推导 Task 状态

状态：2026-10-28 用户完成修正，Review 与本段短复述通过；专用验收 6 项、材料整理回归 7 项及 Worker 类型/lint/格式检查通过。现已接入两个 Finalizer，原子写回集成观察见 local-development.md 5.35；本题不重开。
原估编码 25 至 35 分钟；用户报告实际手写约 20 分钟、数据流理解另约 20 分钟，本段合计约 40 分钟，均计入 R11 原 5 小时预算。

## 业务位置与分工

用户 Push 后，笔记验收产出逐项结果；追问生成后，用户提交回答，独立 Run 再产出回答结果。
Finalizer 在发布这些结果时，先在事务中复核运行、绑定、Task 版本和证据来源，
再把当前标准与报告交给 collectTaskAssessment，得到完整的逐项事实数组。

你写的 deriveTaskState 接收这个数组，只回答“此时 Task 应是什么状态”。
Finalizer 消费返回值，在同一事务保存报告、Run 终态及 Task 状态/版本；回答通过后调用 unlockDependentTasks 解锁满足前置条件的后续任务，见 local-development.md 5.36。
目前笔记与回答的 Finalizer 都已调用本题函数，集成测试验证真实数据库写回；这不代表生产部署或完整浏览器闭环已验收。

本题实现位于 `apps/worker/src/verification/derive-task-state.exercise.ts`，原 TODO(user) 已由用户完成。
数据库、模型、报告解析、来源核对、旧版本拒绝和依赖解锁均由配套代码负责。
不需要实现新的状态机、异步流程或错误恢复器。

## 输入与输出

输入为 `readonly TaskCriterionAssessment[]`，每项含：

| 字段 | 本题含义 |
| --- | --- |
| id | 已保存的验收标准 ID，用于对应原标准；不按固定 ID 判断结果 |
| type | 标准类型；FOLLOW_UP_ANSWER 是回答，其余为笔记标准，包括语义要求 |
| required | 是否为通过 Task 的必要要求；可选标准仍保留在报告中供建议使用 |
| outcome | PASSED / FAILED / INSUFFICIENT_EVIDENCE / null；null 是尚无本项结论 |
| exemption | null，或已核验的 SNAPSHOT_FILE_CHANGED_NOT_APPLICABLE；后者表示全文快照下无法证明文件变化，不适用此项检查 |

可依赖 collectTaskAssessment 的前置校验：标准唯一、至少一项笔记标准、恰好一项必答追问，
以及免检仅用于 SNAPSHOT 的 FILE_CHANGED 且与结果不冲突。
非法输入、重复 ID、错误来源无需在本题重新校验；没有结果的标准仍在数组中，outcome 为 null。
真实计划及旧任务新一轮验收的必答标准入口已在 R11 后续小段补齐，见 local-development.md 5.34；
本题纯函数测试本身不证明数据库接线完成，已冻结旧 Run 的上下文仍保留。

输出只允许 `NEEDS_REVISION | NEEDS_EVIDENCE | PASSED`，无需返回完整 Task、报告或写数据库。
输入只读，不能删除失败项、排序原数组，或把 null/免检改成 PASSED。

## 已导读的业务场景

以“事件循环”任务为例，假设未提及的必要项都已通过：

| 本次验收事实 | Task 判断与原因 |
| --- | --- |
| 必要章节存在、语义正确，必答追问也通过 | PASSED：所有适用的必要要求均已满足 |
| 必要章节不存在，或必要语义标准明确 FAILED | NEEDS_REVISION：笔记有已确认问题；即使同时缺少回答或其他证据，仍需要修订笔记 |
| 必要笔记结果缺失或为 INSUFFICIENT_EVIDENCE | NEEDS_EVIDENCE：尚不足以确认通过，不等于已经证明内容错误 |
| 笔记要求满足，追问未答、FAILED 或 INSUFFICIENT_EVIDENCE | NEEDS_EVIDENCE：需要补充或改进回答；不能把回答 FAILED 当成笔记失败 |
| 仅可选语义建议 FAILED，其余必要项含回答均通过 | PASSED：建议仍保留，但不阻断任务 |
| 合法快照 FILE_CHANGED 免检，其余必要项含回答均通过 | PASSED：免检不是单项通过，也不豁免其他必要要求 |

状态依据不是“格式还是语义”，也不是“是否可量化”；同为 FAILED，所属标准与 required 会影响业务含义。
服务异常、取消、超时或旧绑定等情况由外围处理，不混进这三个业务判断。

## 验收与分层提示

根目录执行，不需要 WSL、数据库、Redis 或模型：

```powershell
pnpm test:handwrite:r11-task-state
```

验收文件：`apps/worker/handwrite/r11-task-state.acceptance.ts`。
6 项场景对应上面的业务例子，并检查输入顺序不改变决策、输入不被修改。
初始占位函数抛出 `TODO(user): deriveTaskState`，因此 6 项预期失败；写完后应全部通过。
测试直接构造已经整理好的事实，不要求重新阅读原始报告测试夹具。

交付检查：AI 已实际运行，6 项均因该占位错误失败，未发现导入或环境错误；
Worker 类型检查及目标 lint/格式检查通过。此记录不代表用户手写已完成。

遇到卡点按需看：

1. 先看当前事实的 type、required 和 outcome，辨认它描述的是哪项要求，而不是仅看 FAILED。
2. null 与免检的语义不同，合法免检原因已经由上游核验；原事实仍应保持原样。
3. 函数返回的是一次整体判断，结果不应依赖标准数组的排列顺序。用同一组事实调换位置观察即可。

这些提示只解释字段和行为，不提供核心实现。超过约 35 分钟仍卡住时，反馈具体场景；先补齐上下文，
不靠反复猜断言凑通过。写完后明确告知，再进行 Review；blocking 问题由用户修正。

## 初版 Review

已复现 1 passed / 5 failed。普通事实的 exemption 为 null，却被 `!assessment.exemption` 跳过，
使前五项场景基本直接返回初始 PASSED；快照免检项反而进入缺失结果分支，误判为 NEEDS_REVISION。
此外，初版没有读取 required，将缺失笔记结果等同于失败、将语义 FAILED 归为缺证、将回答 FAILED
归为修订，并在遇到缺证时 break，可能漏看后面的必要笔记失败。均属 blocking。

本轮先用字段值和同一任务的具体事实补清上述含义，不逐个断言修补，也不提供等价算法。
保留用户实现和验收用例；尚未通过 Review，不推进正式接线、不记录未报告耗时。

## 重写版 Review

用户询问 required、结果优先级及未回答的表示后重写。实际复跑为 2 passed / 4 failed：
必要笔记明确失败与缺证并存、交换输入顺序的场景已通过，防止修订状态被覆盖的处理方向正确。
剩余代码没有读取 required 或 exemption；部分笔记类型将 null 当作 FAILED，语义与追问 null 则遗漏，
笔记 INSUFFICIENT_EVIDENCE 仅覆盖语义类型，追问 FAILED 仍错误归为修订。
继续结合实际字段值解释这些 blocking，保留实现与原测试，由用户修正；不扩大题面或推算学习时间。

## 最终 Review

用户报告全部通过后复核：6 项专用验收与 7 项材料整理回归均通过，Worker 类型检查及目标 lint/格式检查通过。
在上游已校验标准与免检合法性的输入约定下，实现覆盖当前所有标准类型，正确处理 required、免检、
null/不足证据、笔记与回答 FAILED 的不同业务含义，并防止更高优先级结论被覆盖。无输入修改或异步副作用，无 blocking。

AI 仅用 Prettier 整理换行与空白，没有改写逻辑。重复类型分支及注释掉的旧分支属于可读性建议，
不阻塞通过，不追加重构练习。实际手写约 20 分钟，数据流理解另约 20 分钟；整个 R11 仍有正式接线与闭环工作，尚未提交。

本段短复述通过：用户说明 collectTaskAssessment 整理当前 Task 验收成果，deriveTaskState 推导最终状态，
外层 Finalizer 落库。AI 补充当前事实范围、缺失/免检保留，以及事务层复核运行/绑定/版本后再发布结果的边界；
正式调用仍待后续接线，不将本次口述当成已完成数据库集成。

用户在补充讨论笔记/回答验收触发点、需修订后的重新 Push，以及单项 outcome、Run 状态、Task 状态的区别后确认理解。
本段合计约 40 分钟，不能据此推算 R11 全部投入；后续导读用一次完整业务场景串起调用位置，替代碎片追问，不追加练习。
