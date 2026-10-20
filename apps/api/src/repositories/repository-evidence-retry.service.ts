import { randomUUID } from 'node:crypto'
import { ConflictException, NotFoundException } from '@nestjs/common'
import {
  CURRENT_TASK_STATES,
  GITHUB_PUSH_RECEIVED_SCHEMA_VERSION,
  GITHUB_EVIDENCE_RETRY_SCHEMA_VERSION,
  buildGitHubEvidenceRetryKey,
  githubEvidenceRetryEventSchema,
  githubPushPayloadSchema,
  githubPushReceivedEventPayloadSchema,
  retryableEvidenceFailureSchema,
  type RetryRepositoryEvidenceInput,
  type RetryRepositoryEvidenceResponse,
} from '@knowledgeops/contracts'
import type { DatabaseService } from '../database/database.service.js'

const missing = () =>
  new NotFoundException({
    code: 'RESOURCE_NOT_FOUND',
    message: '找不到当前绑定的取证记录，请刷新绑定状态。',
  })
const conflict = () =>
  new ConflictException({
    code: 'CONFLICT',
    message: '取证状态、原绑定或任务已变化，或此失败不能直接重试。请刷新记录后确认。',
  })

export class RepositoryEvidenceRetryService {
  constructor(
    private readonly database: Pick<DatabaseService, 'client'>,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async retry(
    userId: string,
    repositoryId: string,
    deliveryId: string,
    input: RetryRepositoryEvidenceInput,
  ): Promise<RetryRepositoryEvidenceResponse> {
    return this.request(userId, repositoryId, deliveryId, input, false)
  }

  async resync(
    userId: string,
    repositoryId: string,
    deliveryId: string,
    input: RetryRepositoryEvidenceInput,
  ): Promise<RetryRepositoryEvidenceResponse> {
    return this.request(userId, repositoryId, deliveryId, input, true)
  }

  private async request(
    userId: string,
    repositoryId: string,
    deliveryId: string,
    input: RetryRepositoryEvidenceInput,
    resync: boolean,
  ): Promise<RetryRepositoryEvidenceResponse> {
    return this.database.client.$transaction(async (tx) => {
      // 与绑定、任务启动和 Finalizer 一致：先锁 User，再锁 Delivery；没有 GitHub/Redis I/O。
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`
      const repository = await tx.repository.findFirst({
        where: { id: repositoryId, userId, enabled: true },
        include: { user: { select: { repositoryVersion: true } } },
      })
      if (!repository) throw missing()
      const source = await tx.outboxEvent.findUnique({
        where: { deduplicationKey: `github-push-received-${deliveryId}` },
      })
      const context = githubPushReceivedEventPayloadSchema.safeParse(source?.payload)
      if (
        !source ||
        source.type !== 'GITHUB_PUSH_RECEIVED' ||
        source.schemaVersion !== GITHUB_PUSH_RECEIVED_SCHEMA_VERSION ||
        source.aggregateId !== deliveryId ||
        !context.success ||
        context.data.deliveryId !== deliveryId ||
        context.data.binding.userId !== userId ||
        context.data.binding.repositoryId !== repositoryId
      )
        throw missing()
      if (context.data.binding.repositoryVersion !== repository.user.repositoryVersion)
        throw conflict()

      await tx.$queryRaw`SELECT id FROM webhook_deliveries WHERE id = ${deliveryId}::uuid FOR UPDATE`
      const delivery = await tx.webhookDelivery.findUnique({ where: { id: deliveryId } })
      const push = githubPushPayloadSchema.safeParse(delivery?.payload)
      if (
        !delivery ||
        delivery.eventType !== 'push' ||
        !push.success ||
        push.data.deleted ||
        push.data.installation.id !== repository.installationId ||
        push.data.repository.id !== repository.githubRepositoryId ||
        push.data.ref !== `refs/heads/${repository.branch}`
      )
        throw missing()

      // 同一失败快照对应唯一请求。即使响应丢失、后台已经跑完，重放也只返回原请求。
      const deduplicationKey = buildGitHubEvidenceRetryKey(deliveryId, input.expectedAttemptCount)
      const existing = await tx.outboxEvent.findUnique({ where: { deduplicationKey } })
      if (existing) {
        const saved = githubEvidenceRetryEventSchema.safeParse(existing)
        if (
          existing.type !== 'GITHUB_EVIDENCE_RETRY_REQUESTED' ||
          existing.aggregateId !== deliveryId ||
          !saved.success ||
          saved.data.payload.deliveryId !== deliveryId ||
          saved.data.payload.sourceEventId !== source.id ||
          saved.data.payload.previousAttemptCount !== input.expectedAttemptCount ||
          (resync && saved.data.payload.evidenceMode !== 'SNAPSHOT')
        )
          throw conflict()
        return { status: 'ACCEPTED', deliveryId, retryEventId: existing.id }
      }
      const failure = retryableEvidenceFailureSchema.safeParse(delivery.evidenceLastErrorCode)
      if (
        delivery.status !== 'ACCEPTED' ||
        !delivery.evidenceFailedAt ||
        (resync
          ? delivery.evidenceLastErrorCode !== 'RESYNC_REQUIRED' || /^0+$/.test(push.data.after)
          : !failure.success) ||
        delivery.evidenceAttemptCount !== input.expectedAttemptCount
      )
        throw conflict()
      const task = await tx.task.findFirst({
        where: {
          id: context.data.task.taskId,
          version: context.data.task.taskVersion,
          type: 'MARKDOWN_NOTE',
          targetPath: context.data.task.targetPath,
          state: { in: [...CURRENT_TASK_STATES] },
          stage: { plan: { status: 'ACTIVE', goal: { userId } } },
        },
        select: { id: true },
      })
      if (!task) throw conflict()

      // 普通重试保留上轮模式；不能把快照读取失败重新解释为两端比较。
      let evidenceMode: 'DIFF' | 'SNAPSHOT' = resync ? 'SNAPSHOT' : 'DIFF'
      if (!resync && delivery.evidenceRetryEventId) {
        const previous = await tx.outboxEvent.findUnique({
          where: { id: delivery.evidenceRetryEventId },
        })
        const saved = githubEvidenceRetryEventSchema.safeParse(previous)
        if (
          !previous ||
          previous.type !== 'GITHUB_EVIDENCE_RETRY_REQUESTED' ||
          previous.aggregateId !== deliveryId ||
          !saved.success ||
          saved.data.payload.deliveryId !== deliveryId ||
          saved.data.payload.sourceEventId !== source.id ||
          previous.deduplicationKey !==
            buildGitHubEvidenceRetryKey(deliveryId, saved.data.payload.previousAttemptCount)
        )
          throw conflict()
        evidenceMode = saved.data.payload.evidenceMode
      }

      const retryEventId = randomUUID()
      await tx.outboxEvent.create({
        data: {
          id: retryEventId,
          type: 'GITHUB_EVIDENCE_RETRY_REQUESTED',
          aggregateId: deliveryId,
          schemaVersion: GITHUB_EVIDENCE_RETRY_SCHEMA_VERSION,
          deduplicationKey,
          availableAt: this.clock(),
          // 不复制/修改原任务快照和 SHA；留下上轮失败依据，当前指针仅选择新的尝试。
          payload: {
            deliveryId,
            sourceEventId: source.id,
            previousAttemptCount: delivery.evidenceAttemptCount,
            previousErrorCode: delivery.evidenceLastErrorCode!,
            previousFailedAt: delivery.evidenceFailedAt.toISOString(),
            evidenceMode,
          },
        },
      })
      await tx.webhookDelivery.update({
        where: { id: deliveryId },
        data: { evidenceRetryEventId: retryEventId, evidenceFailedAt: null },
      })
      // 没有新 Submission/AgentRun，也不改 Task；后续仍由原取证链路复核资格。
      return { status: 'ACCEPTED', deliveryId, retryEventId }
    })
  }
}
