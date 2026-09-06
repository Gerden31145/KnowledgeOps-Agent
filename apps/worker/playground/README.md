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
