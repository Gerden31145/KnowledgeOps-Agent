import { entityIdSchema } from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'

import {
  classifyOutboxDispatchFailure,
  type ClassifiedOutboxDispatchFailure,
} from './outbox-dispatch-error.js'
import {
  parsePlanGenerationOutboxEvent,
  type LockedOutboxEvent,
  type PlanGenerationOutboxMessage,
} from './outbox-event.js'
import { calculateOutboxRetryDelay, type OutboxRetryPolicy } from './outbox-retry-policy.js'

const DISPATCH_TRANSACTION_TIMEOUT_MS = 5_000

export interface OutboxPublisher {
  publish(message: PlanGenerationOutboxMessage): Promise<{ jobId: string }>
}

export type OutboxDispatchResult =
  | { status: 'DEAD_LETTERED'; eventId: string; failure: ClassifiedOutboxDispatchFailure }
  | { status: 'DISPATCHED'; eventId: string; jobId: string }
  | { status: 'EMPTY' }
  | {
      status: 'RETRY_SCHEDULED'
      eventId: string
      failure: ClassifiedOutboxDispatchFailure
      nextAttemptAt: Date
    }

export interface OutboxDispatchSummary {
  deadLettered: number
  dispatched: number
  inspected: number
  retryScheduled: number
}

type Clock = () => Date

export class OutboxDispatcher {
  constructor(
    private readonly database: DatabaseClient,
    private readonly publisher: OutboxPublisher,
    private readonly retryPolicy: OutboxRetryPolicy,
    private readonly clock: Clock = () => new Date(),
  ) {}

  async dispatchAvailable(limit: number): Promise<OutboxDispatchSummary> {
    const summary: OutboxDispatchSummary = {
      deadLettered: 0,
      dispatched: 0,
      inspected: 0,
      retryScheduled: 0,
    }

    for (let index = 0; index < limit; index += 1) {
      const result = await this.dispatchOne()

      if (result.status === 'EMPTY') {
        break
      }

      summary.inspected += 1

      if (result.status === 'DISPATCHED') {
        summary.dispatched += 1
      } else if (result.status === 'RETRY_SCHEDULED') {
        summary.retryScheduled += 1
      } else {
        summary.deadLettered += 1
      }
    }

    return summary
  }

  async dispatchEvent(eventId: string): Promise<OutboxDispatchResult> {
    return this.dispatchOne(entityIdSchema.parse(eventId))
  }

  private async dispatchOne(eventId?: string): Promise<OutboxDispatchResult> {
    const now = this.clock()

    return this.database.$transaction(
      async (transaction) => {
        const [event] = await transaction.$queryRaw<LockedOutboxEvent[]>(
          Prisma.sql`
            SELECT
              "id",
              "type"::text AS "type",
              "aggregate_id" AS "aggregateId",
              "deduplication_key" AS "deduplicationKey",
              "payload",
              "schema_version" AS "schemaVersion",
              "dispatch_attempt_count" AS "dispatchAttemptCount"
            FROM "outbox_events"
            WHERE "dispatched_at" IS NULL
              AND "dead_lettered_at" IS NULL
              AND "available_at" <= ${now}
              ${eventId ? Prisma.sql`AND "id" = ${eventId}::uuid` : Prisma.empty}
            ORDER BY "available_at" ASC, "occurred_at" ASC, "id" ASC
            FOR UPDATE SKIP LOCKED
            LIMIT 1
          `,
        )

        if (!event) {
          return { status: 'EMPTY' }
        }

        let published: { jobId: string }

        try {
          const message = parsePlanGenerationOutboxEvent(event)
          published = await this.publisher.publish(message)
        } catch (error: unknown) {
          const failure = classifyOutboxDispatchFailure(error)
          const lastError = `${failure.code}: ${failure.message}`

          if (failure.kind === 'NON_RETRYABLE') {
            await transaction.outboxEvent.update({
              where: { id: event.id },
              data: {
                deadLetteredAt: now,
                dispatchAttemptCount: { increment: 1 },
                lastError,
              },
            })

            return {
              status: 'DEAD_LETTERED',
              eventId: event.id,
              failure,
            }
          }

          const retryDelay = calculateOutboxRetryDelay(event.dispatchAttemptCount, this.retryPolicy)
          const nextAttemptAt = new Date(now.getTime() + retryDelay)

          await transaction.outboxEvent.update({
            where: { id: event.id },
            data: {
              availableAt: nextAttemptAt,
              dispatchAttemptCount: { increment: 1 },
              lastError,
            },
          })

          return {
            status: 'RETRY_SCHEDULED',
            eventId: event.id,
            failure,
            nextAttemptAt,
          }
        }

        await transaction.outboxEvent.update({
          where: { id: event.id },
          data: {
            dispatchAttemptCount: { increment: 1 },
            dispatchedAt: now,
            lastError: null,
          },
        })

        return {
          status: 'DISPATCHED',
          eventId: event.id,
          jobId: published.jobId,
        }
      },
      {
        timeout: DISPATCH_TRANSACTION_TIMEOUT_MS,
      },
    )
  }
}
