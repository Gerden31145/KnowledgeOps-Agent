import { Logger } from '@nestjs/common'
import { Queue, Worker, UnrecoverableError, type Processor } from 'bullmq'
import type { z } from 'zod'
import type { VerificationRunResult } from '../verification/verification-run-lifecycle.js'
import { bullMqProducerConnection, bullMqWorkerConnection } from './bullmq-connections.js'

export type VerificationQueueOptions<P> = {
  redisUrl: string
  concurrency: number
  jobOptions: { attempts: number; backoffDelayMs: number }
  processor: { process(message: P, signal?: AbortSignal): Promise<VerificationRunResult> }
  queueName?: string
}
export type VerificationQueueDefinition<P> = {
  queueName: string
  jobName: string
  errorPrefix: 'NOTE_VERIFICATION' | 'ANSWER_VERIFICATION'
  schema: z.ZodType<P>
  jobId(runId: string): string
  sourceId(message: P): string
}
export function createVerificationBullMqProcessor<P extends { runId: string }>(
  handler: VerificationQueueOptions<P>['processor'],
  definition: VerificationQueueDefinition<P>,
): Processor<P, VerificationRunResult, string> {
  return async (job, _token, signal) => {
    const parsed = definition.schema.safeParse(job.data)
    if (
      job.name !== definition.jobName ||
      !parsed.success ||
      job.id !== definition.jobId(parsed.data.runId)
    )
      throw new UnrecoverableError(`INVALID_${definition.errorPrefix}_JOB`)
    try {
      return await handler.process(parsed.data, signal)
    } catch {
      throw new Error(`${definition.errorPrefix}_RETRY_REQUIRED`)
    }
  }
}

// 两种验收使用独立队列，但共用连接、有限退避、Job 校验与生命周期。
export class BullMqVerificationQueue<P extends { runId: string }> {
  private readonly logger = new Logger(BullMqVerificationQueue.name)
  private readonly queue: Queue<P, VerificationRunResult, string, P, VerificationRunResult, string>
  private readonly queueName: string
  private worker: Worker<P, VerificationRunResult, string> | undefined
  constructor(
    private readonly options: VerificationQueueOptions<P>,
    private readonly definition: VerificationQueueDefinition<P>,
  ) {
    this.queueName = options.queueName ?? definition.queueName
    this.queue = new Queue(this.queueName, {
      connection: bullMqProducerConnection(options.redisUrl),
    }) as Queue<P, VerificationRunResult, string, P, VerificationRunResult, string>
    this.queue.on('error', () =>
      this.logger.error({ event: 'verification_queue_unavailable', queue: definition.queueName }),
    )
  }
  start(): void {
    if (this.worker) return
    this.worker = new Worker(
      this.queueName,
      createVerificationBullMqProcessor(this.options.processor, this.definition),
      {
        concurrency: this.options.concurrency,
        connection: bullMqWorkerConnection(this.options.redisUrl),
      },
    )
    this.worker.on('error', () =>
      this.logger.error({
        event: 'verification_worker_unavailable',
        queue: this.definition.queueName,
      }),
    )
    this.worker.on('completed', (job, result) =>
      this.logger.log({
        event: 'verification_completed',
        runId: job.data.runId,
        status: result.status,
        reportId: result.reportId,
      }),
    )
    this.worker.on('failed', (job) =>
      this.logger.warn({ event: 'verification_job_failed', runId: job?.data.runId }),
    )
  }
  async publish(message: { eventId: string; payload: P }): Promise<{ jobId: string }> {
    const payload = this.definition.schema.parse(message.payload)
    const jobId = this.definition.jobId(payload.runId)
    await this.queue.add(this.definition.jobName, payload, {
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
  async isFailed(message: P): Promise<boolean> {
    const job = await this.queue.getJob(this.definition.jobId(message.runId))
    const parsed = this.definition.schema.safeParse(job?.data)
    return Boolean(
      job &&
      job.name === this.definition.jobName &&
      parsed.success &&
      parsed.data.runId === message.runId &&
      this.definition.sourceId(parsed.data) === this.definition.sourceId(message) &&
      (await job.getState()) === 'failed',
    )
  }
  async close(): Promise<void> {
    try {
      await this.worker?.close()
    } finally {
      await this.queue.close()
    }
  }
}
