# KnowledgeOps Agent

KnowledgeOps Agent 是一个站内课程学习与个人掌握画像工具。用户输入学习目标后，系统生成课程路线、正文与练习；学习过程中可以选文提问，完成练习后由程序与 Agent 混合验收，并将首次有效报告形成的计划内画像用于后续课程复习。GitHub 当前只承担登录，新计划不再需要仓库绑定、Markdown 笔记或 Push。

截至 2026-11-22，M7 的课程路线、课程阅读、队列化答疑、混合验收和计划内画像已完成本地实现、固定真实模型闭环与自动化回归，尚未生产发布。旧版 GitHub 笔记链路的生产观察、容器发布和兼容回退记录保留为历史证据，不代表站内课程版本已经上线，详见[开发计划](docs/KnowledgeOps-Agent-逐日开发计划.md)。

历史线上入口：[KnowledgeOps Agent](https://knowops.site)，API 为 `https://api.knowops.site`，路径不带 `/api` 前缀；该入口仍对应历史笔记版本。域名迁移过程见[生产域名记录](deploy/domains.md)，旧版交付证据见 [R18 事实清单](docs/demo/r18-demo.md)与 [R19 材料定稿](docs/demo/r19-delivery.md)。当前没有免登录公开示例或演示视频。

## 核心流程与职责

```mermaid
flowchart TD
  Web[Nuxt 课程工作台] --> API[NestJS API：登录、查询与命令受理]
  API --> DB[(PostgreSQL：课程、练习、画像与 Outbox)]
  DB --> Dispatcher[Dispatcher 扫描待投递事件]
  Dispatcher --> Queue[BullMQ / Redis]
  Queue --> Worker[Worker：计划、课程、答疑与练习验收]
  Worker --> Model[结构化模型适配器]
  Worker --> Finalizer[Finalizer：归属、版本、截止时间与状态复核]
  Finalizer --> DB
  DB --> Read[API 查询 / 计划生成 SSE 快照]
  Read --> Web
```

用户确认课程路线后，系统异步生成首课的正文和练习；后续课程在满足依赖后生成。阅读时可以基于当前区块的选文提问。练习提交后，程序判定选择题，Agent 按固定 Rubric 验收开放追问；首次成功生成的报告保存逐题证据并重算知识点掌握度，下一课创建生成 Run 时冻结最多两个直接相关的薄弱点作为复习上下文。

`Run SUCCEEDED` 表示本次执行成功产出合法结果，不代表课程验收一定通过；Task 是否通过由选择题正确数和开放追问结论共同决定。浏览器断网属于同步问题，不直接改变 Run 或 Task。

- **异步持久化**：业务意图与 Outbox 同事务保存，Dispatcher 将事件交给 BullMQ；重复消费仍由数据库状态、版本和唯一约束保护。代价是需要处理投递与消费两层恢复，不能宣称外部模型恰好调用一次。
- **前端恢复**：计划生成使用 SSE 完整快照、版本/批次隔离与 HTTP 校准、轮询兜底；课程、答疑和练习结果使用查询与轮询恢复。没有模型逐字流或完整历史事件重放。
- **课程与画像一致性**：正文和练习原子落库，失败不产生半份 READY 课程；画像证据与原验收成功事务共同保存。旧练习缺少知识点映射时保留报告读取，不伪造画像回填。
- **历史交付**：旧版 CI、GHCR 镜像和手动 SSH 发布证据保留。M7 的生产发布、真实用户学习效果和模型判断稳定性尚未验收。

设计依据见 [Task 与 Run 分离](docs/adr/0003-separate-task-and-agent-run-state.md)、[异步计划生成](docs/adr/0005-durable-asynchronous-plan-generation.md)及[当前架构取舍](docs/adr/0006-verified-workflow-and-delivery-boundaries.md)。

## 仓库结构

- `apps/web`：Nuxt 公共页面与用户工作台；
- `apps/api`：NestJS 短请求、鉴权、校验与持久化入口；
- `apps/worker`：NestJS standalone 后台任务进程；
- `packages/contracts`：不依赖具体框架的 DTO、Zod Schema、状态与错误契约；
- `packages/agent-core`：模型端口、LangChain 适配器与结构化输出校验；
- `packages/database`：Prisma 数据库接入；
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

以上命令前，首次克隆须按[本地开发指南](docs/local-development.md)创建 `.env`，配置数据库、Redis、开发 GitHub App 和模型。Windows 日常开发使用 WSL2 原生 PostgreSQL/Redis；另有 [CD01 隔离容器验证](deploy/cd01-containers.md)，不与日常开发库混用。

新克隆环境先按本地指南创建 `.env`，配置服务端模型目录、密钥与 Base URL；GLM 的配置见[模型适配说明](docs/local-development.md#51-模型目录与计划生成适配层)。进入 `http://127.0.0.1:3000/app/plan` 使用计划工作台；模型未配置或调用失败不会用 Mock 冒充成功。

API 启动后，`GET /health/live` 只判断进程是否存活，`GET /health/ready` 会真实执行 PostgreSQL `SELECT 1` 与 Redis `PING`。HTTP 响应通过 `x-request-id` 与 JSON 日志关联。

## 质量检查

```powershell
pnpm check
pnpm test:integration:m7
pnpm test:integration:r16
pnpm test:e2e:r16
```

后三项依赖本地 PostgreSQL 和 Redis，按[本地指南](docs/local-development.md)准备后运行，不能指向生产库。浏览器闭环使用真实 API、隔离数据库、队列和 Worker，但预设登录/绑定，GitHub 上游与模型为合成实现；它验证业务与恢复逻辑，不验证真实 OAuth 或模型准确率。

历史生产环境使用 Nginx、Docker Compose 与持久化数据卷，发布入口见 [CD03 手动发布与恢复](deploy/cd03-release.md)。推送代码只触发 CI，不自动发布生产；应用回退不回滚数据库中的新业务数据。M7 尚未执行这套生产发布流程。

## 历史笔记验收证据与当前限制

- [R11 固定评测](docs/evaluation/r11-fixed-evaluation.md)：历史笔记功能的 15 份合成材料、16 项结论，v2 本轮结论一致性为 15/16；仍有含糊内容被判为错误。该数字不是总体准确率，也不代表当前课程练习质量。
- R17 的一条历史真实闭环记录了笔记和两次回答共 15,115 Token、估算 CNY 0.171480；不含计划生成，费用不是供应商账单，也不是平均每用户成本。来源与口径见 [R18 事实清单](docs/demo/r18-demo.md)。
- 历史[题干与必要评分点不一致](docs/issues/2026-11-04-follow-up-rubric-alignment.md)仍为 OPEN；固定评测、引用校验和成功演示都不能代替该问题的修复。
- 未承诺高并发、零停机、模型判断稳定性或学习效果提升；历史生产备份记录为同机备份，不能代表异地灾备。

产品范围以 [9 月求职版 PRD](docs/KnowledgeOps-Agent-9月求职版PRD.md) 为准，执行状态以 [逐日开发计划](docs/KnowledgeOps-Agent-逐日开发计划.md) 为准。
