# Worker Playground

这里存放当前学习单元使用的临时代码，不属于产品实现或正式手写答案。

- 每次只保留一个活动练习目录，避免积累另一套项目代码。
- 除本说明外，目录内容默认被 Git 忽略，不进入产品提交。
- 不写入密钥、真实用户数据或无法安全删除的状态。
- 练习完成并记录可观察结果后，删除对应临时目录。
- 正式实现、测试和手写仍放回计划指定的源码位置。

从仓库根目录运行某个 Worker 练习：

```powershell
pnpm --filter @knowledgeops/worker exec tsx playground/<exercise>/<file>.ts
```

## 已完成观察：R09 执行预算与失败处理（2026-10-26）

用户已确认运行、理解并完成本段复述，随后明确要求保留合法结果、另记预算异常。AI 已验证调整后的行为，临时 `r09-budget/inspect-budget.ts` 已清理，当前没有活动练习；以下命令仅作历史记录，不要求重跑。练习使用模拟模型、用量和单价，不联网、不读取 .env、不产生费用。原观察/导读目标 20 至 30 分钟，计入 R09 原预算，无新手写，新增实际耗时未报告。

```powershell
pnpm --filter @knowledgeops/worker exec tsx playground/r09-budget/inspect-budget.ts
```

观察三条路径：

- `repair-succeeds`：第一次伪造引用、第二次合法，返回 SUCCEEDED；calls=2，knownTotalTokens=400，失败的用量没有被漏掉。
- `tokens-exhausted`：第一次引用错误且已花满 200 Token，返回 MODEL_BUDGET_EXCEEDED；calls=1，不发起第二次。
- `usage-unknown`：回答合法但供应商未返回有效用量，调整后保留结果返回 SUCCEEDED，accounting.warnings 包含 MODEL_USAGE_UNKNOWN；usageComplete=false，calls=1。已知合计为 0 不代表免费，attempt.usage/cost 仍是 null。旧版将此情况直接判失败，已按用户决定修正。

入口顺序：execute-note-verification.ts（共享预算 → 调用 → 结算 → 停止或有限补调用），再看 verify-note-semantics.ts 的 catch 如何把已花用量交还执行层。适配器补充了安全修复提示与失败 usage，不要求重读全部文件。

本段只有单次执行内存记账；消费者、跨 Worker 重启/队列重试的持久化预算及报告落库尚未接入。费用是配置单价估算，Token/费用在响应后结算，不能声称供应商事前硬额度。用户观察/理解/复述已完成；调整后相关 62 项通过，合法结果超额或用量未知时保留并单列警告，无效结果及超时/取消仍不可发布。

## 已完成观察：R09 单次模型调用（2026-10-26）

用户已确认观察、理解并完成简短复述，`r09-model/inspect-model-call.ts` 已清理，后续预算观察也已完成。以下命令仅作历史记录，不要求重跑。本小段阅读/观察目标 25 至 35 分钟，计入 R09 原 5 小时预算，无手写；用户报告 R09 累计约 3 小时，未单独报告本段耗时。
正式 LangChainNoteVerifier 注入模拟模型，Worker 调用与候选核对都走正式实现；不联网、不读取 .env，不产生真实模型费用，输出中的 Token 用量是模拟值。

```powershell
pnpm --filter @knowledgeops/worker exec tsx playground/r09-model/inspect-model-call.ts
```

观察三条路径：

- `valid`：request-prepared 保留第 3 行正文，validated-result 包含原文引用和模拟用量。
- `forged-quote`：模型响应格式合法，但 Worker 核对原文时拒绝 INVALID_MODEL_CITATION。
- `upstream-error`：模型调用失败，适配器返回 MODEL_UPSTREAM_ERROR；本段不会重试或编造通过结果。

首轮只读 `apps/worker/src/verification/verify-note-semantics.ts` 与
`packages/agent-core/src/note-verification/langchain-note-verifier.ts`。
前者只发送笔记语义标准并串起模型与校验；后者组装系统约束/数据、调用结构化输出并分类错误。
连接工厂从计划生成适配器抽出共用，沿用 Base URL/JSON 模式、maxRetries=0；计划生成行为不变。
请求契约和测试按配套职责查看，不要求逐行通读。

模型上下文以 lines 数组保留空行，来源由固定正文绑定；输入 JSON 最多 80000 个 JS 字符单位，超限拒绝、不截断，输出 Token 上限每次显式传入。
供应商未提供完整有效用量时 usage 为 null，不能当作 0；这不等于已有完整预算管理。
单次错误会向上传播，尚未写 AgentRun FAILED；队列消费、统一调用/Token/成本/耗时预算、有限修复和报告落库仍待实现。
AI 观察与定向测试已通过，用户已确认本段调用链及语义标准筛选的理解、脚本运行，并说明模型格式正确仍可能引用错误或虚构证据，需要业务校验。本段观察与简短复述已完成；不将其记为真实模型或队列调用验证，不重开此前候选校验。

## 已完成观察：R09 模型候选与真实引用（2026-10-26）

用户已确认运行及职责理解，临时 `r09-candidate/inspect-candidate.ts` 已清理；后续单次模型调用观察也已完成。以下命令及输出说明仅作历史记录。
本小段约 20 至 30 分钟计入 R09 原 5 小时预算，无新手写，不需要数据库、Redis 或模型密钥。

```powershell
pnpm --filter @knowledgeops/worker exec tsx playground/r09-candidate/inspect-candidate.ts
```

脚本直接调用正式的 `validateNoteVerification`，依次观察：

- `accepted`：第 3 行引文与固定正文一致，程序补齐仓库、Commit、路径和哈希。
- `forged-quote-rejected`：只改引文就返回 `INVALID_MODEL_CITATION`，不能拿模型编造的话做证据。
- `authentic-quote-does-not-prove-correct-reasoning`：引用真实，但示例理由故意写反；当前校验不能证明语义判断正确。

首轮只读 `packages/agent-core/src/note-verification/note-verification.ts` 与
`apps/worker/src/verification/validate-note-verification.ts`；前者定义模型返回的形状，后者核对标准范围和原文。
原文通过 `parseNoteEvidence` 校验后传入，复用 R08 的 `readNoteCitation`；不重新读取 GitHub。
通过/失败的语义结论必须有非空真实引文；证据不足允许空引用，但已提供的引用仍必须真实。
任一结构/标准身份/引用检查失败时整份候选拒绝，不返回半份结果，不修改 Task。

AI 已观察上述三种输出，27 项新增测试与 12 项引用回归通过；用户已确认两个检查器的职责区别，并明确“已运行过”。不要求重跑，不推断用户逐项输出或额外变体操作。
真实模型适配、调用预算、修复/失败输出、消费者和报告持久化仍未接入；大小上限不等于运行预算。

## 已完成观察与手写：R08 确定性检查（2026-10-25）

手写已通过 Review 和正式验收；临时 inspect-checks.ts 已清理，R08 没有活动练习源码。以下命令及输出说明作为历史记录保留。

```powershell
pnpm --filter @knowledgeops/worker exec tsx playground/r08-markdown-ast/inspect-checks.ts
```

该脚本只处理合成笔记“甲 乙 😀”，正文计量为 3 个非空白 Unicode 码点。
两个阈值 3/4 分别输出 PASSED/FAILED，缺少参数的章节标准输出 INSUFFICIENT_EVIDENCE；
语义标准保留待处理。显式 SNAPSHOT 的 FILE_CHANGED 输出单独 exemption，没有伪造通过结果。
准备期间的 section-handwrite-pending 表示有效章节参数进入了手写占位；该缺口现已由用户完成。

AI 已运行上述观察；现检查器 19 项、解析/引用 12 项及专用手写 6 项均通过。
本轮不需要数据库、Redis 或模型，不改变 Task 状态。10/25 用户已完成章节定位函数并通过 Review。
首轮入口是 check-note-criteria.ts 的 SECTION_PRESENT 分支和 find-required-section.exercise.ts 的签名。
正文量、参数校验、结果及引用由配套代码处理，用户只需定位标题。

说明见 [R08 章节定位手写](../../../docs/handwrite/r08-section-present.md)。

## 已完成导读：R08 标准参数（2026-10-25）

用户已确认 config 与验收标准的关系；参数脚本只有 AI 运行证据，用户未单独报告运行。
切换到当前观察后已清理 inspect-criteria.ts，以下命令仅作历史记录。

本段只看“标准描述”如何配上程序可读取的参数，约 10 分钟计入 R08。

```powershell
pnpm --filter @knowledgeops/worker exec tsx playground/r08-markdown-ast/inspect-criteria.ts
```

脚本调用正式的 generatedAcceptanceCriterionSchema，合成两条标准：
SECTION_PRESENT 的 config.heading 为“事件循环”，CONTENT_MINIMUM 的 config.minCharacters 为 200。
valid-criteria 展示解析结果；invalid-criteria 中 missingConfigAccepted 和 wrongTypeConfigAccepted 均应为 false。
这表示缺参/错配的新计划不能通过生成校验，不表示笔记未通过验收；脚本没有读取笔记、调用模型或连接数据库。
AI 已运行；用户已确认参数链路理解，未单独报告运行本脚本。

首轮只读 packages/contracts/src/domain/criterion-config.ts 与 Finalizer 的新增 config 保存字段。
模型生成 Schema 复用该契约，提示词要求模型在 description 中明确同一标题/阈值；其余类型 config 为 null。
旧计划不回填、不从文字推断规则；后续检查器需明确处理缺参。

新生成契约为 v2。实际启用新版生成前，真实 .env 的两项配置需为：

```dotenv
PLAN_GENERATION_PROMPT_VERSION=plan-generation-v2
PLAN_GENERATION_OUTPUT_SCHEMA_VERSION=plan-generation-output-v2
```

同步后按原流程重建并重启 API/Worker；已有 v1 Run 冻结快照不会被改写，当前适配器会拒绝它，
应由用户显式发起新版本生成。本轮未修改真实环境、启动服务或调用模型。
常规 445 项、Finalizer 16 项（15 项原回归 + 新增阈值 1 项）已通过，用户无需重复运行。

## 已完成观察：R08 固定正文与引用（2026-10-25）

用户已确认运行及职责理解，临时 inspect-evidence.ts 与 note.md 已清理，以下命令仅作历史记录。

入口仍在同一个 `r08-markdown-ast/` 目录，复用合成笔记；约 10 至 15 分钟计入 R08。
在仓库根目录运行：

```powershell
pnpm --filter @knowledgeops/worker exec tsx playground/r08-markdown-ast/inspect-evidence.ts
```

入口组装模拟数据库记录，调用正式的 `src/verification/parse-note-evidence.ts`。
关注三条输出：`parsed` 展示来源与节点类型，`citation` 展示第一节点对应的原文与固定 SHA/路径，
`tampered-content-rejected` 表示只替换正文但沿用旧哈希会被拒绝。
只读这一个正式模块的两个函数：`parseNoteEvidence` 负责校验与解析，`readNoteCitation` 负责合法行范围和引文提取。
示例不做章节匹配、不调用模型、不连接数据库/Redis；真实消费者尚未接入，不能把输出当作任务已通过。
10/25 用户已确认正式模块职责理解，随后明确已运行观察，不要求重跑。

## 已完成入门：R08 Markdown AST（2026-10-25）

用户已观察并能区分章节存在与任务通过。旧 `inspect-markdown.mjs` 入门入口已清理，以下命令仅作历史记录；合成 `note.md` 曾用于引用观察，现已清理。

约 15 至 20 分钟，计入 R08 原 4 小时预算。只认识 Markdown 解析后的结构与原文行号，
不实现章节匹配或任何验收判定，不包含后续小手写答案。
依赖放在 Worker workspace；临时源码与合成笔记在 `r08-markdown-ast/`，由 Git 忽略。
不需要 WSL、数据库、Redis、GitHub 或模型服务，不读取 `.env`。

在仓库根目录执行：

```powershell
node apps/worker/playground/r08-markdown-ast/inspect-markdown.mjs
node apps/worker/playground/r08-markdown-ast/inspect-markdown.mjs --tree
```

先看 `note.md`，再看脚本中的读取、`fromMarkdown(markdown)` 与打印三步。
AST 是表示文档结构的树：`root` 是整个文档，`children` 是子节点，`type` 是节点类型，
`position` 对应原文位置。初始样本的第一层依次为 heading（第 1 行）、heading（第 3 行）、
paragraph（第 5 行）、code（第 7 至 9 行）；代码块内的 `##` 不会变成独立标题节点。
`--tree` 可观察标题的 `depth` 与文本子节点，以及代码块的 `value`。

在笔记第一行前插入一个空行，再运行第一条命令：节点类型应保持不变，行号整体加一。
这里的行号来自原始正文，后续引用需继续携带对应 Commit 和文件路径，不能拿最新分支内容替代。
这次练习不计算“章节是否满足要求”，也不修改 Task 或 AgentRun 状态。

官方说明：[mdast-util-from-markdown](https://github.com/syntax-tree/mdast-util-from-markdown)。
10/25 用户已确认观察完成，并独立说明章节存在不能证明 Task 通过；转入上方正式模块观察。

## 历史练习：R06 固定 Commit 快照（已结束）

2026-10-20 R06 收尾：`inspect-commit.mjs` 和 `verify-reader.ts` 两个被 Git 忽略的临时源码已清理；当时没有活动练习。以下保留原场景、命令及观察证据，不表示临时入口仍存在。现在复现固定 SHA 的业务行为可运行正式测试 `pnpm exec vitest run apps/worker/test/read-commit-evidence.spec.ts`。

约 10 至 15 分钟，计入 R06 原约 4 小时预算，不新增手写。入口为 `r06-commit-snapshot/inspect-commit.mjs`，只依赖 Node 内置 API；不需要 WSL、数据库、Redis 或 Token，不读取 `.env`。只读 GitHub 公开示例仓库 `octocat/Spoon-Knife`，不修改远端、本项目数据或 Git 历史。

场景：把历史提交 `a30c19e → bb4cc8d` 当作本次 Push。Worker 等待处理时，`main` 已指向后面的提交。如果拿 `main` 读正文，可能读到后一次 Push 的内容；本次任务应按自己的 `after` Commit SHA 取证。Commit SHA 是某次提交的固定标识，分支名则可以指向新的提交。

在项目根目录依次运行：

```powershell
node apps/worker/playground/r06-commit-snapshot/inspect-commit.mjs
node apps/worker/playground/r06-commit-snapshot/inspect-commit.mjs main
```

第一条按本次 `after` 读文件；第二条只把读取文件的 `ref` 改为 `main`，故意演示错误版本来源。无需改代码或写入任何数据。

- `push-example`：用真实历史提交组成的示例输入，不是刚收到的 Webhook。
- `changed-files`：Compare API 返回的改动文件摘要；两次比较的 before/after 相同，因此应相同。
- `file-snapshot`：Contents API 返回的正文；只打印末行和行号方便观察。关注两次的 `requestedRef` 与 `line`，不要把文件内容当成可执行代码。

GitHub 官方接口说明：[比较两个提交](https://docs.github.com/en/rest/commits/commits#compare-two-commits)、[按 ref 读取文件](https://docs.github.com/en/rest/repos/contents#get-repository-content)。后者的 `ref` 可以是提交、分支或标签；省略时使用默认分支。本练习读取公开资源无需认证；真实私有仓库仍须使用 GitHub App 安装授权，不能将此练习当作产品授权验证。

公开分支未来可能继续变化，不把当前末行写成永久断言。若报网络超时、404 或 403/429，保留错误并反馈，不修改凭据、不关闭 TLS 校验、不反复刷请求。用户完成观察后记录证据并删除临时源码；本目录代码不属于产品实现，R06 的任务关联、队列消费、绑定重验和 Evidence 落库仍待接入。

### 10/12：观察正式读取函数的输出

用户已确认“Webhook 保存本次 Commit SHA，Worker 按它读取”的业务含义；未提供两次原始练习输出，不将 AI 自测记为用户亲自操作。接下来复用同一公开样本，临时入口 `verify-reader.ts` 调用正式的 `src/github/read-commit-evidence.ts`，不再复制读取实现：

```powershell
pnpm --filter @knowledgeops/worker exec tsx playground/r06-commit-snapshot/verify-reader.ts
```

它只读公开样本，打印 `COLLECTED`、固定提交、README 路径、行数、内容哈希与 Diff 字符数。10/12 AI 实际观察：`bb4cc8d...`、`added`、9 行、799 个 Diff 字符。`COLLECTED` 只表示函数返回了证据，不表示已落库或笔记通过。

为了不需要凭据，此临时脚本明确使用去掉认证头的公开请求适配器；代码里的 placeholder 不是 Token，且不会发送给 GitHub。正式读取器仍要求调用方提供安装 Token，没有匿名降级。此观察不证明真实 App 私有仓库权限或后台装配已完成。与原脚本同属唯一活动 R06 练习，用户观察后一起清理，不提交临时源码。

10/13 用户已复述并确认固定 SHA 读取器理解，后续授权/绑定重验使用正式测试观察，不新建另一份 Playground。原公开样本输出仍只有 AI 自测证据，未冒记用户执行；保留这两个临时入口供按需观察，观察后清理。后台取证保护入口与真实数据库检查见[本地开发文档 5.12](../../../docs/local-development.md#512-r06后台取证授权与绑定重验独立调用未接队列)，不代表已接入队列或 Evidence 落库。
