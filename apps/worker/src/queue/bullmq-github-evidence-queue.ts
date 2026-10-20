import {
  GITHUB_EVIDENCE_JOB_NAME,
  GITHUB_EVIDENCE_QUEUE_NAME,
  buildGitHubEvidenceJobId,
  githubEvidenceJobPayloadSchema,
  type GitHubEvidenceJobPayload,
} from '@knowledgeops/contracts'
import { Logger } from '@nestjs/common'
import { Queue, Worker, UnrecoverableError, type Processor } from 'bullmq'
import {
  classifyGitHubEvidenceJobError,
  type GitHubEvidenceJobProcessor,
} from '../github/github-evidence-job-processor.js'
import type { FinalizeGitHubPushEvidenceResult } from '../github/finalize-github-push-evidence.js'
import type { EvidenceQueueFailure } from '../github/github-evidence-reconciler.js'
import type {
  GitHubPushOutboxMessage,
  GitHubEvidenceRetryOutboxMessage,
} from '../outbox/outbox-event.js'
import { bullMqProducerConnection, bullMqWorkerConnection } from './bullmq-connections.js'

type EvidenceProcessor = Processor<
  GitHubEvidenceJobPayload,
  FinalizeGitHubPushEvidenceResult,
  typeof GITHUB_EVIDENCE_JOB_NAME
>
type EvidenceQueue = Queue<
  GitHubEvidenceJobPayload,
  FinalizeGitHubPushEvidenceResult,
  typeof GITHUB_EVIDENCE_JOB_NAME
>

export function createGitHubEvidenceBullMqProcessor(
  handler: Pick<GitHubEvidenceJobProcessor, 'process'>,
): EvidenceProcessor {
  return async (job) => {
    const parsed = githubEvidenceJobPayloadSchema.safeParse(job.data)
    if (
      job.name !== GITHUB_EVIDENCE_JOB_NAME ||
      !parsed.success ||
      job.id !== buildGitHubEvidenceJobId(parsed.data.deliveryId, parsed.data.retryEventId)
    ) {
      throw new UnrecoverableError('INVALID_EVIDENCE_JOB')
    }
    try {
      return await handler.process(parsed.data, {
        number: job.attemptsMade + 1,
        maxAttempts: Math.max(1, job.opts.attempts ?? 1),
      })
    } catch (error) {
      const failure = classifyGitHubEvidenceJobError(error)
      throw failure.retryable ? failure : new UnrecoverableError(failure.code)
    }
  }
}

export class BullMqGitHubEvidenceQueue {
  private readonly logger = new Logger(BullMqGitHubEvidenceQueue.name)
  private readonly queue: EvidenceQueue
  private readonly queueName: string
  private worker:
    | Worker<
        GitHubEvidenceJobPayload,
        FinalizeGitHubPushEvidenceResult,
        typeof GITHUB_EVIDENCE_JOB_NAME
      >
    | undefined

  constructor(
    private readonly options: {
      redisUrl: string
      concurrency: number
      jobOptions: { attempts: number; backoffDelayMs: number }
      processor: Pick<GitHubEvidenceJobProcessor, 'process'>
      queueName?: string
    },
  ) {
    this.queueName = options.queueName ?? GITHUB_EVIDENCE_QUEUE_NAME
    this.queue = new Queue(this.queueName, {
      connection: bullMqProducerConnection(options.redisUrl),
    }) as EvidenceQueue
    this.queue.on('error', () =>
      this.logger.error({ event: 'github_evidence_queue_error', code: 'QUEUE_UNAVAILABLE' }),
    )
  }

  start(): void {
    if (this.worker) return
    this.worker = new Worker(
      this.queueName,
      createGitHubEvidenceBullMqProcessor(this.options.processor),
      {
        concurrency: this.options.concurrency,
        connection: bullMqWorkerConnection(this.options.redisUrl),
      },
    )
    this.worker.on('completed', (job, result) =>
      this.logger.log({
        event: 'github_evidence_job_completed',
        jobId: job.id,
        deliveryId: job.data.deliveryId,
        outcome: result.status,
        ...('reason' in result
          ? { reason: result.reason }
          : { submissionId: result.submissionId, runId: result.runId }),
      }),
    )
    this.worker.on('failed', (job) =>
      this.logger.warn({
        event: 'github_evidence_job_failed',
        jobId: job?.id,
        note: 'Inspect the Delivery error code and retained queue job; no acceptance verdict was made.',
      }),
    )
    this.worker.on('error', () =>
      this.logger.error({ event: 'github_evidence_worker_error', code: 'WORKER_UNAVAILABLE' }),
    )
  }

  async publish(
    message: GitHubPushOutboxMessage | GitHubEvidenceRetryOutboxMessage,
  ): Promise<{ jobId: string }> {
    const retry = 'sourceEventId' in message.payload ? message.payload : undefined
    const payload = githubEvidenceJobPayloadSchema.parse({
      eventId: retry?.sourceEventId ?? message.eventId,
      deliveryId: message.payload.deliveryId,
      ...(retry ? { retryEventId: message.eventId } : {}),
    })
    const jobId = buildGitHubEvidenceJobId(payload.deliveryId, payload.retryEventId)
    await this.queue.add(GITHUB_EVIDENCE_JOB_NAME, payload, {
      jobId,
      attempts: this.options.jobOptions.attempts,
      backoff: { type: 'exponential', delay: this.options.jobOptions.backoffDelayMs },
      removeOnComplete: false,
      removeOnFail: false,
    })
    return { jobId }
  }

  async waitUntilReady(): Promise<void> {
    await Promise.all([this.queue.waitUntilReady(), this.worker?.waitUntilReady()])
  }

  async getFailure(payload: GitHubEvidenceJobPayload): Promise<EvidenceQueueFailure | undefined> {
    const jobId = buildGitHubEvidenceJobId(payload.deliveryId, payload.retryEventId)
    const job = await this.queue.getJob(jobId)
    const saved = githubEvidenceJobPayloadSchema.safeParse(job?.data)
    if (
      !job ||
      job.name !== GITHUB_EVIDENCE_JOB_NAME ||
      !saved.success ||
      saved.data.eventId !== payload.eventId ||
      saved.data.deliveryId !== payload.deliveryId ||
      saved.data.retryEventId !== payload.retryEventId ||
      !Number.isSafeInteger(job.attemptsStarted) ||
      job.attemptsStarted < 1 ||
      !job.finishedOn ||
      !job.processedOn ||
      (await job.getState()) !== 'failed'
    )
      return undefined
    return {
      finishedAt: new Date(job.finishedOn),
      lastAttemptAt: new Date(job.processedOn),
      attemptsStarted: job.attemptsStarted,
    }
  }

  async close(): Promise<void> {
    try {
      await this.worker?.close()
    } finally {
      await this.queue.close()
    }
  }
}
