import {
  githubEvidenceJobPayloadSchema,
  githubPushPayloadSchema,
  type GitHubEvidenceJobPayload,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import { NonRetryableOutboxDispatchError } from '../outbox/outbox-dispatch-error.js'
import {
  parseGitHubPushOutboxEvent,
  parseGitHubEvidenceRetryOutboxEvent,
} from '../outbox/outbox-event.js'
import {
  EvidencePersistenceError,
  finalizeGitHubPushEvidence,
  type FinalizeGitHubPushEvidenceResult,
} from './finalize-github-push-evidence.js'
import { GitHubEvidenceError } from './github-evidence-http.js'
import type { BoundCommitEvidenceReader } from './read-bound-commit-evidence.js'

// 仅固定代码能离开此边界，数据库/上游错误原文不得进入 Redis 或日志。
export class GitHubEvidenceJobError extends Error {
  constructor(
    readonly code: string,
    readonly retryable: boolean,
  ) {
    super(code)
    this.name = 'GitHubEvidenceJobError'
  }
}

export function classifyGitHubEvidenceJobError(error: unknown): GitHubEvidenceJobError {
  if (error instanceof GitHubEvidenceJobError) return error
  if (error instanceof GitHubEvidenceError) {
    return new GitHubEvidenceJobError(error.code, error.code === 'GITHUB_UNAVAILABLE')
  }
  if (error instanceof EvidencePersistenceError) {
    return new GitHubEvidenceJobError(error.code, error.code === 'TASK_CHANGED')
  }
  if (error instanceof NonRetryableOutboxDispatchError) {
    return new GitHubEvidenceJobError('INVALID_INTAKE', false)
  }
  return new GitHubEvidenceJobError('EVIDENCE_PROCESSING_FAILED', true)
}

export interface EvidenceJobAttempt {
  number: number
  maxAttempts: number
}

export class GitHubEvidenceJobProcessor {
  constructor(
    private readonly database: DatabaseClient,
    private readonly reader: Pick<BoundCommitEvidenceReader, 'read'>,
  ) {}

  async process(
    payload: GitHubEvidenceJobPayload,
    attempt: EvidenceJobAttempt,
  ): Promise<FinalizeGitHubPushEvidenceResult> {
    const parsed = githubEvidenceJobPayloadSchema.safeParse(payload)
    if (!parsed.success) throw new GitHubEvidenceJobError('INVALID_INTAKE', false)
    const { eventId, deliveryId, retryEventId } = parsed.data

    // 1. Redis 只负责通知；使用原 Outbox 的快照，绝不重选现在的任务。
    const event = await this.database.outboxEvent.findUnique({ where: { id: eventId } })
    if (!event) throw new GitHubEvidenceJobError('INVALID_INTAKE', false)
    const { payload: intake } = parseGitHubPushOutboxEvent(event)
    if (intake.deliveryId !== deliveryId) throw new GitHubEvidenceJobError('INVALID_INTAKE', false)
    let evidenceMode: 'DIFF' | 'SNAPSHOT' = 'DIFF'
    if (retryEventId) {
      const retry = await this.database.outboxEvent.findUnique({ where: { id: retryEventId } })
      if (!retry) throw new GitHubEvidenceJobError('INVALID_INTAKE', false)
      const saved = parseGitHubEvidenceRetryOutboxEvent(retry).payload
      if (saved.sourceEventId !== eventId || saved.deliveryId !== deliveryId)
        throw new GitHubEvidenceJobError('INVALID_INTAKE', false)
      evidenceMode = saved.evidenceMode
    }
    const delivery = await this.database.webhookDelivery.findUnique({ where: { id: deliveryId } })
    if (!delivery) throw new GitHubEvidenceJobError('INVALID_INTAKE', false)
    if (delivery.evidenceRetryEventId !== (retryEventId ?? null))
      throw new GitHubEvidenceJobError('RETRY_SUPERSEDED', false)
    const existing = terminalResult(delivery)
    if (existing) return existing
    if (delivery.status !== 'ACCEPTED') throw new GitHubEvidenceJobError('INVALID_INTAKE', false)

    // 短 SQL 原子递增，返回本次编号后即释放锁；网络阶段不持锁。
    // 编号只防旧失败覆盖新尝试，不代替 Finalizer 的业务幂等/版本检查。
    const [started] = await this.database.$queryRaw<{ attemptCount: number }[]>(Prisma.sql`
      UPDATE webhook_deliveries
      SET evidence_attempt_count = evidence_attempt_count + 1,
          evidence_last_attempt_at = ${new Date()}, evidence_failed_at = NULL
      WHERE id = ${deliveryId}::uuid AND status = 'ACCEPTED'
        AND evidence_retry_event_id IS NOT DISTINCT FROM ${retryEventId ?? null}::uuid
      RETURNING evidence_attempt_count AS "attemptCount"
    `)
    if (!started) {
      const current = await this.database.webhookDelivery.findUniqueOrThrow({
        where: { id: deliveryId },
      })
      const result = terminalResult(current)
      if (result) return result
      throw new GitHubEvidenceJobError('RETRY_SUPERSEDED', false)
    }

    try {
      const push = githubPushPayloadSchema.safeParse(delivery.payload)
      if (
        delivery.eventType !== 'push' ||
        !push.success ||
        push.data.deleted ||
        !push.data.ref.startsWith('refs/heads/')
      ) {
        throw new GitHubEvidenceJobError('INVALID_INTAKE', false)
      }

      // 2. 读取器负责绑定与 App 权限、固定 SHA 的正文和 Diff；此时还没有验收 Run。
      const result = await this.reader.read({
        ...intake.binding,
        installationId: push.data.installation.id,
        githubRepositoryId: push.data.repository.id,
        ref: push.data.ref,
        beforeCommitSha: push.data.before,
        afterCommitSha: push.data.after,
        targetPath: intake.task.targetPath,
        ...(evidenceMode === 'SNAPSHOT' ? { evidenceMode } : {}),
      })

      // 3. 已有 Finalizer 再锁行复核；成功/忽略都由它持久化，不在这里复制写库规则。
      return await finalizeGitHubPushEvidence(this.database, {
        eventId,
        result,
        ...(retryEventId ? { retryEventId } : {}),
      })
    } catch (error) {
      const failure = classifyGitHubEvidenceJobError(error)
      // 失败不会改变 Task，也不制造 FAILED AgentRun。终态或新尝试已出现时不覆盖它们。
      await this.database.webhookDelivery.updateMany({
        where: {
          id: deliveryId,
          status: 'ACCEPTED',
          evidenceAttemptCount: started.attemptCount,
          evidenceRetryEventId: retryEventId ?? null,
        },
        data: {
          evidenceLastErrorCode: failure.code,
          evidenceFailedAt:
            !failure.retryable || attempt.number >= attempt.maxAttempts ? new Date() : null,
        },
      })
      throw failure
    }
  }
}

function terminalResult(delivery: {
  status: string
  submissionId: string | null
  agentRunId: string | null
  ignoreReason: string | null
}): FinalizeGitHubPushEvidenceResult | undefined {
  if (delivery.status === 'PROCESSED' && delivery.submissionId) {
    return { status: 'PROCESSED', submissionId: delivery.submissionId, runId: delivery.agentRunId }
  }
  if (delivery.status === 'IGNORED' && delivery.ignoreReason) {
    return { status: 'IGNORED', reason: delivery.ignoreReason }
  }
  return undefined
}
