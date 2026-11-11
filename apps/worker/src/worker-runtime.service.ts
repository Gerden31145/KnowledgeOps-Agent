import { SERVICE_NAMES } from '@knowledgeops/contracts'
import { CourseGenerationJobProcessor } from './course-generation/course-generation-job-processor.js'
import { CourseGenerationRunRepository } from './course-generation/course-generation-run.repository.js'
import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common'

import { WORKER_ENVIRONMENT } from './config/config.module.js'
import type { WorkerEnvironment } from './config/environment.js'
import { DatabaseService } from './database/database.service.js'
import { GitHubEvidenceJobProcessor } from './github/github-evidence-job-processor.js'
import { GitHubEvidenceReconciler } from './github/github-evidence-reconciler.js'
import { OutboxDispatchLoop } from './outbox/outbox-dispatch-loop.js'
import { OutboxDispatcher } from './outbox/outbox-dispatcher.js'
import { PlanGenerationJobProcessor } from './plan-generation/plan-generation-job-processor.js'
import { PlanGenerationRunRepository } from './plan-generation/plan-generation-run.repository.js'
import { PlanGenerationTimeoutSweepLoop } from './plan-generation/plan-generation-timeout-sweep-loop.js'
import { BullMqPlanGenerationQueue } from './queue/bullmq-plan-generation-queue.js'
import { BullMqCourseGenerationQueue } from './queue/bullmq-course-generation-queue.js'
import { BullMqGitHubEvidenceQueue } from './queue/bullmq-github-evidence-queue.js'
import { BullMqNoteVerificationQueue } from './queue/bullmq-note-verification-queue.js'
import { NoteVerificationJobProcessor } from './verification/note-verification-job-processor.js'
import { NoteVerificationRunRepository } from './verification/note-verification-run.repository.js'
import { BullMqAnswerVerificationQueue } from './queue/bullmq-answer-verification-queue.js'
import { AnswerVerificationJobProcessor } from './verification/answer-verification-job-processor.js'
import { AnswerVerificationRunRepository } from './verification/answer-verification-run.repository.js'

@Injectable()
export class WorkerRuntimeService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(WorkerRuntimeService.name)
  private dispatchLoop: OutboxDispatchLoop | undefined
  private queue: BullMqPlanGenerationQueue | undefined
  private courseQueue: BullMqCourseGenerationQueue | undefined
  private evidenceQueue: BullMqGitHubEvidenceQueue | undefined
  private noteQueue: BullMqNoteVerificationQueue | undefined
  private answerQueue: BullMqAnswerVerificationQueue | undefined
  private timeoutSweepLoop: PlanGenerationTimeoutSweepLoop | undefined

  constructor(
    @Inject(WORKER_ENVIRONMENT) private readonly environment: WorkerEnvironment,
    @Inject(DatabaseService) private readonly database: DatabaseService,
    @Inject(PlanGenerationJobProcessor)
    private readonly planGenerationProcessor: PlanGenerationJobProcessor,
    @Inject(PlanGenerationRunRepository)
    private readonly planGenerationRunRepository: PlanGenerationRunRepository,
    @Inject(CourseGenerationJobProcessor)
    private readonly courseGenerationProcessor: CourseGenerationJobProcessor,
    @Inject(CourseGenerationRunRepository)
    private readonly courseGenerationRuns: CourseGenerationRunRepository,
    @Inject(GitHubEvidenceJobProcessor)
    private readonly gitHubEvidenceProcessor: GitHubEvidenceJobProcessor,
    @Inject(NoteVerificationJobProcessor)
    private readonly noteProcessor: NoteVerificationJobProcessor,
    @Inject(NoteVerificationRunRepository) private readonly noteRuns: NoteVerificationRunRepository,
    @Inject(AnswerVerificationJobProcessor)
    private readonly answerProcessor: AnswerVerificationJobProcessor,
    @Inject(AnswerVerificationRunRepository)
    private readonly answerRuns: AnswerVerificationRunRepository,
  ) {}

  async onApplicationBootstrap(): Promise<void> {
    try {
      this.queue = new BullMqPlanGenerationQueue({
        concurrency: this.environment.WORKER_CONCURRENCY,
        jobOptions: {
          attempts: this.environment.BULLMQ_JOB_ATTEMPTS,
          backoffDelayMs: this.environment.BULLMQ_JOB_BACKOFF_MS,
        },
        processor: this.planGenerationProcessor,
        redisUrl: this.environment.REDIS_URL,
      })
      this.courseQueue = new BullMqCourseGenerationQueue({
        concurrency: this.environment.WORKER_CONCURRENCY,
        jobOptions: {
          attempts: this.environment.BULLMQ_JOB_ATTEMPTS,
          backoffDelayMs: this.environment.BULLMQ_JOB_BACKOFF_MS,
        },
        processor: this.courseGenerationProcessor,
        redisUrl: this.environment.REDIS_URL,
      })
      this.evidenceQueue = new BullMqGitHubEvidenceQueue({
        concurrency: this.environment.WORKER_CONCURRENCY,
        jobOptions: {
          attempts: this.environment.BULLMQ_JOB_ATTEMPTS,
          backoffDelayMs: this.environment.BULLMQ_JOB_BACKOFF_MS,
        },
        processor: this.gitHubEvidenceProcessor,
        redisUrl: this.environment.REDIS_URL,
      })
      this.queue.start()
      this.courseQueue.start()
      this.evidenceQueue.start()
      if (this.environment.NOTE_VERIFICATION_MODEL_JSON) {
        this.noteQueue = new BullMqNoteVerificationQueue({
          concurrency: this.environment.WORKER_CONCURRENCY,
          jobOptions: {
            attempts: this.environment.BULLMQ_JOB_ATTEMPTS,
            backoffDelayMs: this.environment.BULLMQ_JOB_BACKOFF_MS,
          },
          processor: this.noteProcessor,
          redisUrl: this.environment.REDIS_URL,
        })
        this.noteQueue.start()
        this.answerQueue = new BullMqAnswerVerificationQueue({
          concurrency: this.environment.WORKER_CONCURRENCY,
          jobOptions: {
            attempts: this.environment.BULLMQ_JOB_ATTEMPTS,
            backoffDelayMs: this.environment.BULLMQ_JOB_BACKOFF_MS,
          },
          processor: this.answerProcessor,
          redisUrl: this.environment.REDIS_URL,
        })
        this.answerQueue.start()
      }

      this.timeoutSweepLoop = new PlanGenerationTimeoutSweepLoop(
        this.planGenerationRunRepository,
        this.environment.PLAN_GENERATION_TIMEOUT_SWEEP_BATCH_SIZE,
        this.environment.PLAN_GENERATION_TIMEOUT_SWEEP_INTERVAL_MS,
        this.courseGenerationRuns,
      )
      await this.timeoutSweepLoop.start()

      const planQueue = this.queue
      const courseQueue = this.courseQueue
      const evidenceQueue = this.evidenceQueue
      const noteQueue = this.noteQueue
      const answerQueue = this.answerQueue
      const dispatcher = new OutboxDispatcher(
        this.database.client,
        {
          publish: (message) => planQueue.publish(message),
          publishCourseGeneration: (message) => courseQueue.publish(message),
          publishGitHubPush: (message) => evidenceQueue.publish(message),
          publishGitHubEvidenceRetry: (message) => evidenceQueue.publish(message),
          ...(noteQueue
            ? {
                publishNoteVerification: (
                  message: import('./outbox/outbox-event.js').NoteVerificationOutboxMessage,
                ) => noteQueue.publish(message),
              }
            : {}),
          ...(answerQueue
            ? {
                publishAnswerVerification: (
                  message: import('./outbox/outbox-event.js').AnswerVerificationOutboxMessage,
                ) => answerQueue.publish(message),
              }
            : {}),
        },
        {
          baseDelayMs: this.environment.OUTBOX_RETRY_BASE_DELAY_MS,
          maxDelayMs: this.environment.OUTBOX_RETRY_MAX_DELAY_MS,
        },
      )

      const evidenceReconciler = new GitHubEvidenceReconciler(this.database.client, evidenceQueue)
      this.dispatchLoop = new OutboxDispatchLoop(
        dispatcher,
        this.environment.OUTBOX_BATCH_SIZE,
        this.environment.OUTBOX_POLL_INTERVAL_MS,
        async () => {
          // 一个恢复器失败不应阻断另一个；Run 收尾只依赖 PostgreSQL，不依赖 Redis。
          try {
            return await evidenceReconciler.reconcile(this.environment.OUTBOX_BATCH_SIZE)
          } finally {
            try {
              await this.noteRuns.reconcile(
                this.environment.OUTBOX_BATCH_SIZE,
                noteQueue ? (message) => noteQueue.isFailed(message) : undefined,
              )
            } catch {
              this.logger.warn({ event: 'note_verification_reconcile_unavailable' })
            }
            try {
              await this.answerRuns.reconcile(
                this.environment.OUTBOX_BATCH_SIZE,
                answerQueue ? (message) => answerQueue.isFailed(message) : undefined,
              )
            } catch {
              this.logger.warn({ event: 'answer_verification_reconcile_unavailable' })
            }
          }
        },
      )
      await this.dispatchLoop.start()

      this.logger.log({
        event: 'worker_runtime_started',
        concurrency: this.environment.WORKER_CONCURRENCY,
        service: SERVICE_NAMES[2],
      })
    } catch (error: unknown) {
      try {
        await this.dispatchLoop?.stop()
        await this.timeoutSweepLoop?.stop()
      } finally {
        try {
          await this.closeQueues()
        } finally {
          await this.database.close()
        }
      }
      this.queue = undefined
      this.courseQueue = undefined
      this.evidenceQueue = undefined
      this.noteQueue = undefined
      this.answerQueue = undefined
      this.timeoutSweepLoop = undefined
      throw error
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.dispatchLoop?.stop()
    await this.timeoutSweepLoop?.stop()
    try {
      await this.closeQueues()
    } finally {
      await this.database.close()
    }
  }

  private async closeQueues(): Promise<void> {
    try {
      try {
        try {
          await this.answerQueue?.close()
        } finally {
          await this.noteQueue?.close()
        }
      } finally {
        await this.evidenceQueue?.close()
      }
    } finally {
      try {
        await this.courseQueue?.close()
      } finally {
        await this.queue?.close()
      }
    }
  }
}
