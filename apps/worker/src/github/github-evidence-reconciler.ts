import type { GitHubEvidenceJobPayload } from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'
import { NonRetryableOutboxDispatchError } from '../outbox/outbox-dispatch-error.js'
import {
  parseGitHubPushOutboxEvent,
  parseGitHubEvidenceRetryOutboxEvent,
} from '../outbox/outbox-event.js'

export interface EvidenceQueueFailure {
  finishedAt: Date
  lastAttemptAt: Date
  attemptsStarted: number
}

// 补记“队列已经失败，但数据库没记下”的结果，不执行取证、不重发任务。
export class GitHubEvidenceReconciler {
  private cursor: string | undefined

  constructor(
    private readonly database: DatabaseClient,
    private readonly queue: {
      getFailure(payload: GitHubEvidenceJobPayload): Promise<EvidenceQueueFailure | undefined>
    },
  ) {}

  async reconcile(batchSize: number): Promise<number> {
    const deliveries = await this.database.webhookDelivery.findMany({
      where: {
        status: 'ACCEPTED',
        eventType: 'push',
        evidenceFailedAt: null,
        ...(this.cursor ? { id: { gt: this.cursor } } : {}),
      },
      orderBy: { id: 'asc' },
      take: batchSize,
      select: {
        id: true,
        evidenceRetryEventId: true,
        evidenceAttemptCount: true,
        evidenceLastAttemptAt: true,
      },
    })
    let updated = 0
    for (const delivery of deliveries) {
      const source = await this.database.outboxEvent.findUnique({
        where: { deduplicationKey: `github-push-received-${delivery.id}` },
      })
      let previousAttempts = 0
      if (!source) continue
      try {
        parseGitHubPushOutboxEvent(source)
        if (delivery.evidenceRetryEventId) {
          const retry = await this.database.outboxEvent.findUnique({
            where: { id: delivery.evidenceRetryEventId },
          })
          if (!retry) continue
          const { payload } = parseGitHubEvidenceRetryOutboxEvent(retry)
          if (payload.sourceEventId !== source.id || payload.deliveryId !== delivery.id) continue
          previousAttempts = payload.previousAttemptCount
        }
      } catch (error) {
        // 坏上下文不靠当前任务补齐；数据库不可用则留给下一轮重查。
        if (error instanceof NonRetryableOutboxDispatchError) continue
        throw error
      }
      const failure = await this.queue.getFailure({
        eventId: source.id,
        deliveryId: delivery.id,
        ...(delivery.evidenceRetryEventId ? { retryEventId: delivery.evidenceRetryEventId } : {}),
      })
      if (!failure) continue
      const result = await this.database.webhookDelivery.updateMany({
        where: {
          id: delivery.id,
          status: 'ACCEPTED',
          evidenceFailedAt: null,
          evidenceRetryEventId: delivery.evidenceRetryEventId,
          evidenceAttemptCount: delivery.evidenceAttemptCount,
          evidenceLastAttemptAt: delivery.evidenceLastAttemptAt,
        },
        data: {
          // 不信任/转存 Redis 的原始错误文本，也不猜具体根因。
          evidenceLastErrorCode: 'EVIDENCE_PROCESSING_FAILED',
          evidenceFailedAt: failure.finishedAt,
          evidenceLastAttemptAt: failure.lastAttemptAt,
          // 断连可能发生在数据库递增前；用队列实际领取次数补足，不能编造一次尝试。
          // 前一恢复轮的累计值 + 本轮领取数，让连续恢复仍有不同的防重版本。
          evidenceAttemptCount: Math.max(
            delivery.evidenceAttemptCount,
            previousAttempts + failure.attemptsStarted,
          ),
        },
      })
      updated += result.count
    }
    // 循环扫描，不能让最老一批长时间运行/缺失 Job 的记录饿死后续记录。
    this.cursor = deliveries.length === batchSize ? deliveries.at(-1)?.id : undefined
    return updated
  }
}
