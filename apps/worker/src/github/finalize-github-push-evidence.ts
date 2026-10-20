import { createHash } from 'node:crypto'
import {
  CURRENT_TASK_STATES,
  GITHUB_PUSH_RECEIVED_SCHEMA_VERSION,
  NOTE_VERIFICATION_OUTBOX_SCHEMA_VERSION,
  NOTE_VERIFICATION_WORKFLOW_VERSION,
  entityIdSchema,
  buildGitHubEvidenceRetryKey,
  githubEvidenceRetryEventSchema,
  githubPushPayloadSchema,
  githubPushReceivedEventPayloadSchema,
  isRestorableTaskState,
  noteVerificationRequestedEventPayloadSchema,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import type { ReadBoundCommitEvidenceResult } from './read-bound-commit-evidence.js'
import {
  readCommitEvidenceInputSchema,
  type CommitFileEvidence,
  type CommitSnapshotEvidence,
} from './read-commit-evidence.js'

export class EvidencePersistenceError extends Error {
  constructor(
    readonly code:
      | 'INVALID_INTAKE'
      | 'INVALID_EVIDENCE'
      | 'TASK_STATE_INCONSISTENT'
      | 'TASK_CHANGED'
      | 'RETRY_SUPERSEDED',
  ) {
    super(code)
    this.name = 'EvidencePersistenceError'
  }
}

export type FinalizeGitHubPushEvidenceResult =
  | { status: 'IGNORED'; reason: string }
  | { status: 'PROCESSED'; submissionId: string; runId: string | null }

// 取证消费者在读取完成后调用；也由独立数据库测试验证事务边界。
// GitHub 网络请求必须在进入此事务前完成，不在持锁期间访问上游。
export async function finalizeGitHubPushEvidence(
  database: DatabaseClient,
  command: { eventId: string; result: ReadBoundCommitEvidenceResult; retryEventId?: string },
): Promise<FinalizeGitHubPushEvidenceResult> {
  const eventId = entityIdSchema.parse(command.eventId)
  return database.$transaction(async (tx) => {
    // 1. 从持久化 Outbox 还原原上下文，调用者不能另传一个当前 taskId 来替换它。
    const event = await tx.outboxEvent.findUnique({ where: { id: eventId } })
    const parsed = githubPushReceivedEventPayloadSchema.safeParse(event?.payload)
    if (
      !event ||
      event.type !== 'GITHUB_PUSH_RECEIVED' ||
      event.schemaVersion !== GITHUB_PUSH_RECEIVED_SCHEMA_VERSION ||
      !parsed.success ||
      event.aggregateId !== parsed.data.deliveryId ||
      event.deduplicationKey !== `github-push-received-${parsed.data.deliveryId}`
    )
      throw new EvidencePersistenceError('INVALID_INTAKE')
    const { deliveryId, binding, task: snapshot } = parsed.data

    // 与绑定、开始任务使用同一顺序的 User 锁；Delivery 锁让重复完成串行化。
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM users WHERE id = ${binding.userId}::uuid FOR UPDATE`,
    )
    await tx.$queryRaw(
      Prisma.sql`SELECT id FROM webhook_deliveries WHERE id = ${deliveryId}::uuid FOR UPDATE`,
    )
    const delivery = await tx.webhookDelivery.findUnique({ where: { id: deliveryId } })
    if (!delivery) throw new EvidencePersistenceError('INVALID_INTAKE')
    if (delivery.evidenceRetryEventId !== (command.retryEventId ?? null))
      throw new EvidencePersistenceError('RETRY_SUPERSEDED')
    // 快照资格来自当前持久化恢复请求，不能由读取器返回一个 mode 就自行取得。
    let evidenceMode: 'DIFF' | 'SNAPSHOT' = 'DIFF'
    if (command.retryEventId) {
      const retry = await tx.outboxEvent.findUnique({ where: { id: command.retryEventId } })
      const saved = githubEvidenceRetryEventSchema.safeParse(retry)
      if (
        !retry ||
        retry.type !== 'GITHUB_EVIDENCE_RETRY_REQUESTED' ||
        !saved.success ||
        retry.aggregateId !== deliveryId ||
        saved.data.payload.deliveryId !== deliveryId ||
        saved.data.payload.sourceEventId !== eventId ||
        retry.deduplicationKey !==
          buildGitHubEvidenceRetryKey(deliveryId, saved.data.payload.previousAttemptCount)
      )
        throw new EvidencePersistenceError('INVALID_INTAKE')
      evidenceMode = saved.data.payload.evidenceMode
    }
    if (delivery.status === 'PROCESSED' && delivery.submissionId) {
      return {
        status: 'PROCESSED',
        submissionId: delivery.submissionId,
        runId: delivery.agentRunId,
      }
    }
    if (delivery.status === 'IGNORED' && delivery.ignoreReason) {
      return { status: 'IGNORED', reason: delivery.ignoreReason }
    }
    const payload = githubPushPayloadSchema.safeParse(delivery.payload)
    if (
      delivery.status !== 'ACCEPTED' ||
      delivery.eventType !== 'push' ||
      !payload.success ||
      !payload.data.ref.startsWith('refs/heads/') ||
      payload.data.deleted
    ) {
      throw new EvidencePersistenceError('INVALID_INTAKE')
    }
    const push = payload.data
    const processedAt = new Date()
    const ignore = async (reason: string): Promise<FinalizeGitHubPushEvidenceResult> => {
      await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'IGNORED',
          ignoreReason: reason,
          processedAt,
          evidenceLastErrorCode: null,
          evidenceFailedAt: null,
        },
      })
      return { status: 'IGNORED', reason }
    }
    const finish = async (
      submissionId: string,
      runId: string | null,
    ): Promise<FinalizeGitHubPushEvidenceResult> => {
      await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: {
          status: 'PROCESSED',
          submissionId,
          agentRunId: runId,
          processedAt,
          evidenceLastErrorCode: null,
          evidenceFailedAt: null,
        },
      })
      return { status: 'PROCESSED', submissionId, runId }
    }

    // 2. 读完网络再复核原绑定；即使同一个 GitHub 仓库被重绑，也不接管旧工作。
    const repository = await tx.repository.findFirst({
      where: {
        id: binding.repositoryId,
        userId: binding.userId,
        enabled: true,
        installationId: push.installation.id,
        githubRepositoryId: push.repository.id,
        branch: push.ref.slice('refs/heads/'.length),
        user: { repositoryVersion: binding.repositoryVersion },
      },
      select: { id: true },
    })
    if (!repository) return ignore('BINDING_CHANGED')

    // 同一 Commit 的另一次 Delivery 也只能关联已有结果；必须早于 Task 版本检查。
    const existing = await tx.submission.findUnique({
      where: {
        repositoryId_taskId_afterCommitSha_workflowVersion: {
          repositoryId: binding.repositoryId,
          taskId: snapshot.taskId,
          afterCommitSha: push.after,
          workflowVersion: NOTE_VERIFICATION_WORKFLOW_VERSION,
        },
      },
      include: { runs: { where: { retryOfRunId: null }, select: { id: true } } },
    })
    if (existing) return finish(existing.id, existing.runs[0]?.id ?? null)

    // 不查“现在的另一个任务”，只复核接收时选定的任务、路径、版本和计划归属。
    const task = await tx.task.findFirst({
      where: {
        id: snapshot.taskId,
        type: 'MARKDOWN_NOTE',
        version: snapshot.taskVersion,
        targetPath: snapshot.targetPath,
        state: { in: [...CURRENT_TASK_STATES] },
        stage: { plan: { status: 'ACTIVE', goal: { userId: binding.userId } } },
      },
      select: { id: true, state: true, version: true },
    })
    if (!task) return ignore('TASK_CHANGED')
    if (command.result.status === 'IGNORED') {
      return ignore(command.result.reason)
    }

    // 防止把别的提交/文件的取证结果拼到本次接收记录上。
    const evidence = command.result.evidence
    const input = readCommitEvidenceInputSchema.safeParse({
      githubRepositoryId: push.repository.id,
      beforeCommitSha: push.before,
      afterCommitSha: push.after,
      targetPath: snapshot.targetPath,
    })
    if (
      !input.success ||
      input.data.targetPath !== snapshot.targetPath ||
      (evidenceMode === 'DIFF' && /^0+$/.test(push.before)) ||
      /^0+$/.test(push.after) ||
      (evidence.mode ?? 'DIFF') !== evidenceMode ||
      evidence.githubRepositoryId !== push.repository.id ||
      evidence.beforeCommitSha !== push.before ||
      evidence.afterCommitSha !== push.after ||
      evidence.targetPath !== snapshot.targetPath
    ) {
      throw new EvidencePersistenceError('INVALID_EVIDENCE')
    }
    validateEvidence(evidence)

    // 已在验收中的任务收到新证据时，沿用上次运行前的稳定状态，不把 VERIFYING 当恢复目标。
    let previousState = task.state
    if (previousState === 'VERIFYING') {
      const previousRun = await tx.agentRun.findFirst({
        where: { taskId: task.id, expectedTaskVersion: task.version },
        orderBy: { queuedAt: 'desc' },
        select: { taskStateBeforeRun: true },
      })
      if (!previousRun) throw new EvidencePersistenceError('TASK_STATE_INCONSISTENT')
      previousState = previousRun.taskStateBeforeRun
    }
    if (!isRestorableTaskState(previousState))
      throw new EvidencePersistenceError('TASK_STATE_INCONSISTENT')

    // 3. 同一事务中保存证据、推进 Task 版本、创建 Run 和验收 Outbox；任一步抛错全回滚。
    const removed = evidence.change === 'removed'
    const updated = await tx.task.updateMany({
      where: {
        id: task.id,
        state: task.state,
        version: task.version,
        targetPath: snapshot.targetPath,
      },
      data: { state: removed ? previousState : 'VERIFYING', version: { increment: 1 } },
    })
    if (updated.count !== 1) throw new EvidencePersistenceError('TASK_CHANGED')
    const submission = await tx.submission.create({
      data: {
        repositoryId: binding.repositoryId,
        taskId: task.id,
        taskVersion: snapshot.taskVersion,
        beforeCommitSha: push.before,
        afterCommitSha: push.after,
        targetPath: snapshot.targetPath,
        workflowVersion: NOTE_VERIFICATION_WORKFLOW_VERSION,
        evidence: {
          create: {
            mode: evidenceMode,
            change: evidence.change,
            previousPath: evidence.previousPath,
            sourceCommitSha: evidence.sourceCommitSha,
            content: evidence.content,
            contentHash: evidence.contentHash,
            lineCount: evidence.lineCount,
            diff: evidence.diff,
          },
        },
      },
    })
    // 删除也使旧版本失效，但不启动语义验收，也不把任务判成失败。
    if (removed) return finish(submission.id, null)
    const run = await tx.agentRun.create({
      data: {
        taskId: task.id,
        submissionId: submission.id,
        kind: 'NOTE_VERIFICATION',
        status: 'QUEUED',
        taskStateBeforeRun: previousState,
        expectedTaskVersion: task.version + 1,
        workflowVersion: NOTE_VERIFICATION_WORKFLOW_VERSION,
      },
    })
    await tx.outboxEvent.create({
      data: {
        type: 'NOTE_VERIFICATION_REQUESTED',
        aggregateId: run.id,
        deduplicationKey: `note-verification-requested-${run.id}`,
        schemaVersion: NOTE_VERIFICATION_OUTBOX_SCHEMA_VERSION,
        payload: noteVerificationRequestedEventPayloadSchema.parse({
          runId: run.id,
          submissionId: submission.id,
        }),
      },
    })
    return finish(submission.id, run.id)
  })
}

function validateEvidence(evidence: CommitFileEvidence | CommitSnapshotEvidence) {
  const bytes = Buffer.from(evidence.content, 'utf8')
  const source = evidence.change === 'removed' ? evidence.beforeCommitSha : evidence.afterCommitSha
  const lineCount =
    evidence.content === ''
      ? 0
      : evidence.content.replace(/(?:\r\n|\n|\r)$/, '').split(/\r\n|\n|\r/).length
  const validShape =
    evidence.mode === 'SNAPSHOT'
      ? evidence.change === null && evidence.diff === null && evidence.previousPath === null
      : ['added', 'modified', 'removed', 'renamed'].includes(evidence.change ?? '') &&
        typeof evidence.diff === 'string'
  if (
    !validShape ||
    evidence.sourceCommitSha !== source ||
    bytes.length > 64 * 1024 ||
    (evidence.diff !== null && evidence.diff.length > 128_000) ||
    evidence.content.includes('\0') ||
    (evidence.diff !== null && evidence.diff.includes('\0')) ||
    evidence.contentHash !== createHash('sha256').update(bytes).digest('hex') ||
    evidence.lineCount !== lineCount ||
    (evidence.change === 'renamed' && !evidence.previousPath)
  ) {
    throw new EvidencePersistenceError('INVALID_EVIDENCE')
  }
}
