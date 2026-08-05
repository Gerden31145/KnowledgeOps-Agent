# ADR 0001：使用 pnpm Monorepo，但保持 Web、API、Worker 独立进程

- 状态：Accepted
- 日期：2026-08-01

## 背景

项目需要共享 TypeScript 契约和统一质量工具，同时 Agent 验收是长耗时、可重试任务，不能与 HTTP 请求共享同一生命周期。

## 决策

使用原生 pnpm workspace 管理 `apps/web`、`apps/api`、`apps/worker` 与 `packages/*`。三个应用位于同一仓库，但分别拥有入口、环境变量校验、构建产物和运行进程。共享包只能被应用依赖，不能反向导入 Nuxt、NestJS 或具体数据库实现。

阶段 1 不引入 Turborepo 或 Nx。当前 workspace 数量和 CI 规模还不需要远程缓存、任务图编排或生成器体系。

## 结果

- 一次提交可以原子修改前后端契约，并由统一 lint、typecheck 和 test 验证。
- API 与 Worker 可以独立限制并发、重启和扩容；同仓库不等于同进程。
- 根级脚本需要明确构建共享包后再启动应用。
- 随着项目增长，根命令可能变慢；只有出现可测量瓶颈后才评估任务缓存工具。

## 放弃的方案

- 多仓库：会增加契约版本发布与跨仓库联调成本，不符合五周 MVP。
- 单一 NestJS 进程：长任务会占用 HTTP 资源并削弱故障隔离和恢复能力。
- 现在引入 Turborepo/Nx：收益尚未覆盖配置与解释成本。
