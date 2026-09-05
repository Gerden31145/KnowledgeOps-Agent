# KnowledgeOps Agent

KnowledgeOps Agent 是一个 GitHub 驱动的开发者学习验收工具。用户通过提交 Markdown 笔记提供真实学习证据，系统按确定性规则与受控 Agent 工作流生成可追溯报告和理解追问。

截至 2026-09-05，08-11 计划日已完成，阶段 2 仍待原子成功落库核心手写与真实生成闭环验收；GitHub 接入和笔记验收尚未交付。后续按[九月底投递开发与学习计划](docs/KnowledgeOps-Agent-逐日开发计划.md)推进，先做最小队列实践，再补齐成功落库。仓库已建立三个独立运行进程：

- `apps/web`：Nuxt 公共页面与用户工作台；
- `apps/api`：NestJS 短请求、鉴权、校验与持久化入口；
- `apps/worker`：NestJS standalone 后台任务进程；
- `packages/contracts`：不依赖具体框架的 DTO、Zod Schema、状态与错误契约；
- `packages/observability`：API 与 Worker 共用的 JSON 结构化日志；
- `prisma`：核心领域模型与可审阅的 PostgreSQL 迁移。

## 本地启动

```powershell
corepack enable pnpm
corepack install --global pnpm@10.34.5
pnpm install
pnpm infra:up
pnpm infra:check
pnpm db:migrate:deploy
pnpm dev
```

Windows 开发路径使用 WSL2 内的原生 PostgreSQL 与 Redis，不依赖 Docker Desktop 或本机 Docker daemon。Compose 清单保留给 Linux VPS 的提前 smoke 与正式部署；完整前提和故障排查见 [本地开发指南](docs/local-development.md)。

API 启动后，`GET /health/live` 只判断进程是否存活，`GET /health/ready` 会真实执行 PostgreSQL `SELECT 1` 与 Redis `PING`。HTTP 响应通过 `x-request-id` 与 JSON 日志关联。

## 质量检查

```powershell
pnpm check
```

产品范围以 [9 月求职版 PRD](docs/KnowledgeOps-Agent-9月求职版PRD.md) 为准，执行状态以 [逐日开发计划](docs/KnowledgeOps-Agent-逐日开发计划.md) 为准。
