import { githubIdSchema } from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'
import {
  createGitHubAppJwt,
  createGitHubRepositoryAccess,
  GitHubAppAuthError,
  type GitHubAppSettings,
} from '@knowledgeops/github'
import { z } from 'zod'
import { createGitHubEvidenceRequest, GitHubEvidenceError } from './github-evidence-http.js'
import {
  readCommitEvidence,
  readCommitEvidenceInputSchema,
  type ReadCommitEvidenceResult,
} from './read-commit-evidence.js'

const commandSchema = readCommitEvidenceInputSchema.extend({
  // 来自接收时持久化的绑定身份/版本与 Push；targetPath 由任务关联层提供。
  repositoryId: z.uuid(),
  userId: z.uuid(),
  repositoryVersion: z.number().int().nonnegative(),
  installationId: githubIdSchema,
  ref: z.string().startsWith('refs/heads/').min(12).max(1024),
  evidenceMode: z.enum(['DIFF', 'SNAPSHOT']).default('DIFF'),
})
export type ReadBoundCommitEvidenceCommand = z.input<typeof commandSchema>
export type ReadBoundCommitEvidenceResult =
  ReadCommitEvidenceResult | { status: 'IGNORED'; reason: 'BINDING_CHANGED' }

// 取证消费者的只读入口：读取原任务指定的文件，不在此处创建验收记录。
// 不从浏览器接参数，不持久化 Token 或 Evidence。
export class BoundCommitEvidenceReader {
  constructor(
    private readonly database: Pick<DatabaseClient, 'repository'>,
    private readonly settings: GitHubAppSettings,
    private readonly fetchGitHub: typeof fetch = fetch,
    private readonly loadKey?: (path: string) => Promise<string>,
  ) {}

  async read(command: ReadBoundCommitEvidenceCommand): Promise<ReadBoundCommitEvidenceResult> {
    const parsed = commandSchema.safeParse(command)
    if (!parsed.success) throw new GitHubEvidenceError('INVALID_INPUT')
    const input = parsed.data
    const ignored = { status: 'IGNORED', reason: 'BINDING_CHANGED' } as const

    // 网络期间不持有数据库锁；保存 Evidence 的 Finalizer 事务仍须锁 User 并复查绑定。
    // 以下前后检查不能替代最终写入检查，也不能撤回解绑前已发出的网络请求。

    // 1. 只查原绑定：不能因同仓库已被重新绑定，就将旧任务转给新的绑定/用户。
    const stillBound = async () =>
      Boolean(
        await this.database.repository.findFirst({
          where: {
            id: input.repositoryId,
            userId: input.userId,
            enabled: true,
            installationId: input.installationId,
            githubRepositoryId: input.githubRepositoryId,
            branch: input.ref.slice('refs/heads/'.length),
            user: { repositoryVersion: input.repositoryVersion },
          },
          select: { id: true },
        }),
      )
    if (!(await stillBound())) return ignored

    try {
      // 2. App 私钥证明应用身份；GitHub 再签发仅覆盖这个仓库的短期只读 Token。
      const jwt = await createGitHubAppJwt(this.settings, this.loadKey)
      const access = await createGitHubRepositoryAccess(
        input.installationId,
        input.githubRepositoryId,
        createGitHubEvidenceRequest(jwt, this.fetchGitHub),
      )
      if (!(await stillBound())) return ignored

      // 3. 复用已导读的固定 SHA 读取器，Token 不进入结果或队列。
      const result = await readCommitEvidence(input, {
        installationToken: access.token,
        fetchGitHub: this.fetchGitHub,
        evidenceMode: input.evidenceMode,
      })
      if (!(await stillBound())) return ignored
      return result
    } catch (error) {
      if (error instanceof GitHubAppAuthError) {
        throw new GitHubEvidenceError(
          error.code === 'NOT_AUTHORIZED' ? 'GITHUB_AUTH_REQUIRED' : 'GITHUB_UNAVAILABLE',
        )
      }
      throw error
    }
  }
}
