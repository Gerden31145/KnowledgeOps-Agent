import { entityIdSchema } from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'

import {
  classifyOutboxDispatchFailure,
  type ClassifiedOutboxDispatchFailure,
} from './outbox-dispatch-error.js'
import {
  parseAnswerVerificationOutboxEvent,
  parseCourseExerciseOutboxEvent,
  parseCourseGenerationOutboxEvent,
  parseCourseQuestionOutboxEvent,
  type CourseExerciseOutboxMessage,
  type CourseGenerationOutboxMessage,
  type CourseQuestionOutboxMessage,
  type AnswerVerificationOutboxMessage,
  parseNoteVerificationOutboxEvent,
  type NoteVerificationOutboxMessage,
  parseGitHubPushOutboxEvent,
  parseGitHubEvidenceRetryOutboxEvent,
  type GitHubEvidenceRetryOutboxMessage,
  parsePlanGenerationOutboxEvent,
  type GitHubPushOutboxMessage,
  type LockedOutboxEvent,
  type PlanGenerationOutboxMessage,
} from './outbox-event.js'
import { calculateOutboxRetryDelay, type OutboxRetryPolicy } from './outbox-retry-policy.js'

const DISPATCH_TRANSACTION_TIMEOUT_MS = 5_000

export interface OutboxPublisher {
  publish(message: PlanGenerationOutboxMessage): Promise<{ jobId: string }>
  publishCourseGeneration?(message: CourseGenerationOutboxMessage): Promise<{ jobId: string }>
  publishCourseQuestion?(message: CourseQuestionOutboxMessage): Promise<{ jobId: string }>
  publishCourseExercise?(message: CourseExerciseOutboxMessage): Promise<{ jobId: string }>
  // 只有装配了取证消费者的 Runtime 才认领此类待办；旧的计划生成装配保持可用。
  publishGitHubPush?(message: GitHubPushOutboxMessage): Promise<{ jobId: string }>
  publishGitHubEvidenceRetry?(message: GitHubEvidenceRetryOutboxMessage): Promise<{ jobId: string }>
  publishNoteVerification?(message: NoteVerificationOutboxMessage): Promise<{ jobId: string }>
  publishAnswerVerification?(message: AnswerVerificationOutboxMessage): Promise<{ jobId: string }>
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
              AND (
                "type" = 'PLAN_GENERATION_REQUESTED'
                ${this.publisher.publishCourseGeneration ? Prisma.sql`OR "type" = 'COURSE_GENERATION_REQUESTED'` : Prisma.empty}
                ${this.publisher.publishCourseQuestion ? Prisma.sql`OR "type" = 'COURSE_QUESTION_REQUESTED'` : Prisma.empty}
                ${this.publisher.publishCourseExercise ? Prisma.sql`OR "type" = 'COURSE_EXERCISE_REQUESTED'` : Prisma.empty}
                ${this.publisher.publishGitHubPush ? Prisma.sql`OR "type" = 'GITHUB_PUSH_RECEIVED'` : Prisma.empty}
                ${this.publisher.publishGitHubEvidenceRetry ? Prisma.sql`OR "type" = 'GITHUB_EVIDENCE_RETRY_REQUESTED'` : Prisma.empty}
                ${this.publisher.publishNoteVerification ? Prisma.sql`OR "type" = 'NOTE_VERIFICATION_REQUESTED'` : Prisma.empty}
                ${this.publisher.publishAnswerVerification ? Prisma.sql`OR "type" = 'ANSWER_VERIFICATION_REQUESTED'` : Prisma.empty}
              )
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
          if (
            event.type === 'COURSE_GENERATION_REQUESTED' &&
            this.publisher.publishCourseGeneration
          ) {
            published = await this.publisher.publishCourseGeneration(
              parseCourseGenerationOutboxEvent(event),
            )
          } else if (
            event.type === 'COURSE_QUESTION_REQUESTED' &&
            this.publisher.publishCourseQuestion
          ) {
            published = await this.publisher.publishCourseQuestion(
              parseCourseQuestionOutboxEvent(event),
            )
          } else if (
            event.type === 'COURSE_EXERCISE_REQUESTED' &&
            this.publisher.publishCourseExercise
          ) {
            published = await this.publisher.publishCourseExercise(
              parseCourseExerciseOutboxEvent(event),
            )
          } else if (
            event.type === 'ANSWER_VERIFICATION_REQUESTED' &&
            this.publisher.publishAnswerVerification
          ) {
            published = await this.publisher.publishAnswerVerification(
              parseAnswerVerificationOutboxEvent(event),
            )
          } else if (
            event.type === 'NOTE_VERIFICATION_REQUESTED' &&
            this.publisher.publishNoteVerification
          ) {
            published = await this.publisher.publishNoteVerification(
              parseNoteVerificationOutboxEvent(event),
            )
          } else if (event.type === 'GITHUB_PUSH_RECEIVED' && this.publisher.publishGitHubPush) {
            published = await this.publisher.publishGitHubPush(parseGitHubPushOutboxEvent(event))
          } else if (
            event.type === 'GITHUB_EVIDENCE_RETRY_REQUESTED' &&
            this.publisher.publishGitHubEvidenceRetry
          ) {
            published = await this.publisher.publishGitHubEvidenceRetry(
              parseGitHubEvidenceRetryOutboxEvent(event),
            )
          } else {
            published = await this.publisher.publish(parsePlanGenerationOutboxEvent(event))
          }
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
