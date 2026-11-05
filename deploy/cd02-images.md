# CD02：CI 验证与 GHCR 镜像交付

本单元沿用 CD01 镜像和模拟模型。目标是让一组镜像能追溯到同一次通过检查的 Git 提交；生产切换属于 CD03。用户负责推送、观察 Actions/Packages，以及 VPS 登录和拉取；AI 准备工作流、脚本和本地验证。建议学习投入 1 至 1.5 小时，本单元无手写。

当前状态（2026-11-05）：工程检查点 2e47697 已由用户推送，三个 Actions job 均成功，总耗时 8 分 22 秒、2 份 artifacts；工作流职责导读已确认。用户随后确认四个包均为 Private，并在 VPS 全部拉取完毕。截图展示部分镜像摘要，未归档完整四份引用，不虚构具体值；CD03 选版时仍须核对成功工作流及完整交付记录。本地检查与实际操作均不重复运行。CD02 短复述通过，用户实报累计约 25 分钟，状态 DONE 随本次本地收尾提交生效；生产尚未切换。

## 1. 从什么开始，到哪里结束

| 触发方式 | 行为 |
| --- | --- |
| Pull request | 保留现有 Quality/build、数据库与浏览器回归，不上传镜像 |
| main push | 两个现有 job 成功后，构建、验证并上传镜像，保存交付记录 |
| 手动运行 CI，选择 main | 同样先检查，再交付所选分支当次确定的提交 |
| 手动运行 CI，选择其他分支 | 不执行镜像上传 job |

主要入口是 `.github/workflows/ci.yml` 的 `images` job，以及 `scripts/ci-container-smoke.sh`。`scripts/ci-images.mjs` 是配套记录工具：生成镜像名、检查上传前镜像没被替换、保存摘要；本轮不要求逐行阅读。已有 verify/regression job 保留，没有另起一套产品测试。

流程是：同一提交检查成功 → 构建 api/worker/web/migrate → 记录本地镜像 ID → 启动隔离存储并迁移 → HTTP 与真实队列消费 → 停止/重建后查询原结果 → 核对同一组镜像 → GHCR 上传 → 保存 release.json / images.env。

## 2. 三种版本标识

| 标识 | 表示什么 | 用在哪里 |
| --- | --- | --- |
| Git commit SHA | 源码提交 | 检查、构建和发布记录关联同一份源码 |
| 本地 image ID | 本地镜像配置的内容标识 | 上传前确认标签仍指向刚构建并测试的镜像 |
| Registry digest | 镜像仓库中 manifest 的内容标识 | VPS 按 `镜像名@sha256:…` 拉取确定内容 |

本地 image ID 和 registry digest 不是同一个概念，不要求两者相等。标签便于人识别，但部署记录使用摘要固定内容；本次不用 latest。

镜像名称示例：`ghcr.io/gerden31145/knowledgeops-agent/api:sha-<完整提交>-run-<工作流编号>-<尝试次数>`。另外三个服务同样命名。每次工作流尝试都有独立标签，即使重新运行同一提交，也不会把记录混在一起。构建使用 linux/amd64，匹配当前 VPS；没有新增多架构发布。

## 3. 首次远端观察

完成本地工程复核和检查点提交后，在本机仓库执行：

```bash
git status --short
git push origin main
```

这里推送的是本地提交，不会把未跟踪的个人文件或被忽略的 `.env` 上传；不要额外 `git add .`。推送触发 main 的 CI，成功后会上传私有镜像，生产服务不会因此切换。

打开 [仓库 Actions](https://github.com/Gerden31145/KnowledgeOps-Agent/actions)，选择对应提交的 CI：

1. `Quality and build`、`Core reliability and browser flows` 成功后，才开始 `Verify and publish container images`。
2. 容器验证日志中能看到 `cd02-smoke-verified`，前后的 Run/Plan 一致。
3. 上传成功后，Summary 列出四个镜像的固定摘要引用。
4. 下载 `container-release-<SHA>-<runId>-<attempt>` artifact，里面是 `release.json` 与 `images.env`。记录保留 90 天；没有可核对的成功记录时，后续不得仅凭一个镜像标签选择发布。
5. 在 GitHub 个人 Packages 页面确认首次创建的四个包为 Private，并关联本仓库。先前同名包若已存在，应核对其实际可见性与仓库 Actions 权限。

工作流使用 GitHub 自动生成的 `GITHUB_TOKEN`，只在镜像 job 请求 `packages: write`；无需手工创建上传 PAT 或把生产密钥放进 CI。首次创建包默认 Private，已存在的包不会被本流程自动修改可见性。[GitHub Container registry 文档](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry)

失败时保存对应失败步骤及 `container-failure-*` 日志。没有通过前置检查，不会构建/上传；构建或容器检查失败，不会进入上传。四个镜像不是仓库层面的原子提交：上传中途失败或工作流被取消，GHCR 可能已有部分镜像，但不构成完整成功的交付。CD03 必须核对 CI 最终成功、提交 SHA、运行编号/尝试次数和四份摘要，不能只看 Summary、标签或任意 JSON。

## 4. VPS 私有拉取（镜像发布成功后再做）

先测试 VPS 到 registry 的网络：

```bash
curl --noproxy '*' --connect-timeout 10 --max-time 20 \
  -sS -o /dev/null -w 'GHCR HTTP %{http_code}\n' https://ghcr.io/v2/
```

匿名 HTTP 401 表示已连通并收到认证要求，不代表拉取权限已验证。如果直连失败，沿用 R07 已配置的代理排查；命令行 curl 的代理与 Docker daemon 代理仍是两件事。

在 GitHub 创建用于 VPS 的 Personal access token **classic**，只选择 `read:packages` 并设置有效期。令牌持有者需能读取这四个私有包；已有合适凭据可复用。令牌只在 VPS 输入，不发给 AI，不写进仓库。[GitHub Packages 身份验证说明](https://docs.github.com/en/packages/working-with-a-github-packages-registry/working-with-the-container-registry#authenticating-with-a-personal-access-token-classic)

在 VPS 的 Bash 中输入（提示时粘贴令牌，不会回显）：

```bash
read -r -s -p 'GHCR read token: ' GHCR_READ_TOKEN
printf '\n'
printf '%s' "$GHCR_READ_TOKEN" | docker login ghcr.io -u Gerden31145 --password-stdin
unset GHCR_READ_TOKEN
```

从这次成功记录的 `images.env` 复制等号右侧的完整引用，逐个拉取四个镜像，例如：

```bash
docker pull '替换为 API_IMAGE 等号后的完整 ghcr.io/...@sha256:... 引用'
```

镜像到 VPS 之后，核对引用与记录一致；本单元仅拉取，不运行新版应用或切换 PM2。后续发布仍由用户手动触发。

## 5. 验证边界与收尾

CI 只使用独立 `knowledgeops-ci-<runId>-<attempt>` 项目和合成凭据，最后清理该次临时容器/卷。不要把 CI 清理命令直接复制到 VPS；生产数据卷沿 CD03 迁移方案处理。

模拟 HTTP 接口不验证真实模型质量；重建后查询 PostgreSQL 记录也不等于验证所有 Redis 队列故障恢复。CD01 的人工操作已观察，本单元新增的是它在 GitHub Runner 上自动执行、固定镜像交付和 VPS 私有拉取的证据。

完成条件：本地检查、一次实际 GitHub 交付成功、四个私有镜像和 SHA/摘要记录可核对、VPS 拉取、导读确认、短复述与实际耗时记录，最后再提交学习收尾。工程检查点不会替代这些完成条件。
