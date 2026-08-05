# ADR 0002：本地使用 WSL 原生服务，Compose 在 Linux VPS 提前验证

- 状态：Accepted
- 日期：2026-08-01

## 背景

开发机不支持 Docker Desktop。虽然 WSL2 Ubuntu 内安装了 Docker Engine 与 Compose，但启动 daemon 曾导致 WSL 服务长时间无响应，Docker Hub 也出现连接超时。项目需要稳定的 PostgreSQL/Redis 开发环境，同时必须在最终发布前验证容器化部署。

## 决策

Windows Node.js 24 LTS 运行 Web、API 与 Worker；WSL2 Ubuntu 原生 PostgreSQL/Redis 是唯一的本地开发主路径。`pnpm infra:up` 只负责安装、配置和启动原生服务，不自动启动 Docker daemon。

`deploy/compose.yaml` 继续作为 Linux 部署资产。阶段 3 完成 BullMQ 真实链路后，立即在 Linux VPS 做基础设施 smoke；阶段 6 再完成全量部署。应用始终只读取 `DATABASE_URL` 和 `REDIS_URL`，不感知基础设施由原生服务还是 Compose 提供。

Ubuntu 22.04 自带 Redis 6.0，低于 BullMQ 官方完整兼容基线 6.2。本地脚本因此使用 Redis 官方 APT 源并锁定 7.4 主版本，与 Compose 清单保持同一主版本；`infra:check` 同时拒绝 PostgreSQL 14 以下或 Redis 6.2 以下的服务。

## 结果

- 保留 Windows 上熟悉的前端 HMR 与调试体验。
- 日常开发不再被 Docker daemon 或镜像仓库状态阻塞。
- 本地 apt 版本与 VPS 容器版本可能不同；必须通过版本输出、迁移/队列集成测试和阶段 3 VPS smoke 控制环境漂移。
- Compose 的 healthcheck、命名卷和端口暴露仍会在真实 Linux 环境验证，而不是只保留一份未经执行的 YAML。
- WSL 发行版停止会同时停止两个原生服务，需要重新执行 `pnpm infra:up`。

## 放弃的方案

- Docker Desktop：当前设备环境不支持且并非项目运行的必要条件。
- WSL Docker 作为本地主路径：daemon 启动可靠性和镜像网络已经实际阻塞开发。
- 把 Node 应用也全部放进容器：阶段 1 会增加文件监听与调试摩擦，尚无收益。
- Redis 保存业务真相：Redis 只承担队列和短期实时能力，PostgreSQL 才是可恢复状态的真相源。
