# KnowledgeOps Agent

KnowledgeOps Agent 是一个 GitHub 驱动的开发者学习验收工具。用户通过提交 Markdown 笔记提供真实学习证据，系统按确定性规则与受控 Agent 工作流生成可追溯报告和理解追问。

当前线上入口：[knowops.site](https://knowops.site)。生产域名与运行配置见 [部署记录](deploy/domains.md)；最新功能与学习状态以逐日计划为准，以下阶段 2 概述为历史记录。

截至 2026-09-09，阶段 2 已完成：在本地通过真实 GLM 模型跑通“创建目标 → 异步生成计划 → 刷新恢复 → 确认计划 → 开始任务”，并验证生成失败、关联新 Run 重试和原子落库。C1 核心手写与 W1 问答均已独立提交；完整证据与后续安排见[九月底投递开发与学习计划](docs/KnowledgeOps-Agent-逐日开发计划.md)。

当前使用仅限开发环境的固定身份，尚未交付 GitHub 登录/仓库接入、Push 证据采集、笔记与回答验收、SSE 或完整生产部署；阶段 2 完成不代表整个产品已经上线。仓库已建立三个独立运行进程及共享包：

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

新克隆环境先按本地指南创建 `.env`，配置服务端模型目录、密钥与 Base URL；GLM 的配置见[模型适配说明](docs/local-development.md#51-模型目录与计划生成适配层)。进入 `http://127.0.0.1:3000/app/plan` 使用计划工作台；模型未配置或调用失败不会用 Mock 冒充成功。

API 启动后，`GET /health/live` 只判断进程是否存活，`GET /health/ready` 会真实执行 PostgreSQL `SELECT 1` 与 Redis `PING`。HTTP 响应通过 `x-request-id` 与 JSON 日志关联。

## 质量检查

```powershell
pnpm check
```

产品范围以 [9 月求职版 PRD](docs/KnowledgeOps-Agent-9月求职版PRD.md) 为准，执行状态以 [逐日开发计划](docs/KnowledgeOps-Agent-逐日开发计划.md) 为准。
