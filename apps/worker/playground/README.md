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

## 历史练习：R06 固定 Commit 快照（已结束）

2026-10-20 R06 收尾：`inspect-commit.mjs` 和 `verify-reader.ts` 两个被 Git 忽略的临时源码已清理；当前没有活动练习。以下保留原场景、命令及观察证据，不表示临时入口仍存在。现在复现固定 SHA 的业务行为可运行正式测试 `pnpm exec vitest run apps/worker/test/read-commit-evidence.spec.ts`。

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
