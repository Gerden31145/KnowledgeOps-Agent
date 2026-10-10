import { ConflictException, NotFoundException } from '@nestjs/common'
import type {
  BindRepositoryInput,
  RepositoryBindingResponse,
  UnbindRepositoryInput,
} from '@knowledgeops/contracts'
import { Prisma } from '@knowledgeops/database'
import type { DatabaseService } from '../database/database.service.js'
import { GitHubRepositories } from './github-repositories.js'

const conflict = () =>
  new ConflictException({
    code: 'CONFLICT',
    message: '仓库绑定已变化或已有活动绑定，请刷新后重试。',
  })
const missing = () =>
  new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: '找不到当前用户的仓库绑定。' })
const repositoryConflict = () =>
  new ConflictException({
    code: 'CONFLICT',
    message: '该仓库当前无法绑定，请刷新状态或选择其他仓库；已有活动绑定需先解除。',
  })

export class RepositoryBindingService {
  constructor(
    private readonly database: DatabaseService,
    private readonly github: GitHubRepositories,
  ) {}

  // 1. 刷新读 PostgreSQL；短期 GitHub 授权失效不影响读取/解除已有绑定。
  async current(userId: string): Promise<RepositoryBindingResponse> {
    return this.database.client.$transaction(async (tx) => {
      await this.lockUser(tx, userId)
      return this.snapshot(tx, userId)
    })
  }

  async bind(
    userId: string,
    userToken: string,
    input: BindRepositoryInput,
  ): Promise<RepositoryBindingResponse> {
    // 2. 外部调用放在事务前：重新验证用户/安装/仓库权限，不信任前端选项或自报 ID。
    const verified = await this.github.verify(userToken, input)
    return this.database.client.$transaction(async (tx) => {
      await this.lockUser(tx, userId)
      const current = await this.snapshot(tx, userId)
      const existing = current.repository
      // 仅接受紧邻本次成功写入的相同命令重放；解绑后的旧绑定请求不能复活。
      // 判断是否为刚刚成功请求的重复提交
      if (
        current.version === input.expectedVersion + 1 &&
        existing?.installationId === input.installationId &&
        existing.githubRepositoryId === input.githubRepositoryId &&
        existing.branch === verified.branch
      )
        return current
      if (current.version !== input.expectedVersion || existing) throw conflict()

      // 3. GitHub 权限已核验后再检查占用；不向调用方泄露绑定者身份。
      const occupied = await tx.repository.findFirst({
        where: { githubRepositoryId: verified.githubRepositoryId, enabled: true },
        select: { id: true },
      })
      if (occupied) throw repositoryConflict()

      // User 锁约束同一用户；跨用户抢占同一仓库由数据库部分唯一索引兜底。
      await tx.gitHubInstallation.upsert({
        where: { id: verified.installation.id },
        create: { ...verified.installation, verifiedAt: new Date() },
        update: { ...verified.installation, verifiedAt: new Date() },
      })
      try {
        await tx.repository.create({
          data: {
            userId,
            installationId: verified.installation.id,
            githubRepositoryId: verified.githubRepositoryId,
            fullName: verified.fullName,
            defaultBranch: verified.defaultBranch,
            branch: verified.branch,
            isPrivate: verified.isPrivate,
          },
        })
      } catch (error: unknown) {
        // 查占用后仍可能被另一用户抢先绑定；抛出安全 409，让整个事务回滚。
        if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002')
          throw repositoryConflict()
        throw error
      }
      await tx.user.update({ where: { id: userId }, data: { repositoryVersion: { increment: 1 } } })
      return this.snapshot(tx, userId)
    })
  }

  async unbind(userId: string, input: UnbindRepositoryInput): Promise<RepositoryBindingResponse> {
    return this.database.client.$transaction(async (tx) => {
      await this.lockUser(tx, userId)
      const repository = await tx.repository.findFirst({
        where: { id: input.repositoryId, userId },
      })
      if (!repository) throw missing()
      // 解绑的幂等处理
      if (!repository.enabled) return this.snapshot(tx, userId)
      const current = await this.snapshot(tx, userId)
      if (current.version !== input.expectedVersion) throw conflict()
      await tx.repository.update({
        where: { id: repository.id },
        data: { enabled: false, unboundAt: new Date() },
      })
      await tx.user.update({ where: { id: userId }, data: { repositoryVersion: { increment: 1 } } })
      // 保留历史关系，不卸载 GitHub App；R05/R06 必须按 enabled 与绑定 ID 拒绝新/迟到工作。
      return this.snapshot(tx, userId)
    })
  }

  private async lockUser(tx: Prisma.TransactionClient, userId: string) {
    const rows = await tx.$queryRaw<
      Array<{ id: string }>
    >`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`
    if (rows.length !== 1) throw missing()
  }

  private async snapshot(
    tx: Prisma.TransactionClient,
    userId: string,
  ): Promise<RepositoryBindingResponse> {
    const user = await tx.user.findUniqueOrThrow({
      where: { id: userId },
      select: { repositoryVersion: true },
    })
    const repository = await tx.repository.findFirst({
      where: { userId, enabled: true },
      select: {
        id: true,
        installationId: true,
        githubRepositoryId: true,
        fullName: true,
        defaultBranch: true,
        branch: true,
        isPrivate: true,
      },
    })
    return { version: user.repositoryVersion, repository }
  }
}
