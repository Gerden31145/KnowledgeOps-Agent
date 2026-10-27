import {
  NOTE_VERIFICATION_JOB_NAME,
  NOTE_VERIFICATION_QUEUE_NAME,
  buildNoteVerificationJobId,
  noteVerificationRequestedEventPayloadSchema,
  type NoteVerificationRequestedPayload,
} from '@knowledgeops/contracts'
import { Logger } from '@nestjs/common'
import { Queue, Worker, UnrecoverableError, type Processor } from 'bullmq'
import type { NoteVerificationJobProcessor } from '../verification/note-verification-job-processor.js'
import type { NoteRunResult } from '../verification/note-verification-run.repository.js'
import type { NoteVerificationOutboxMessage } from '../outbox/outbox-event.js'
import { bullMqProducerConnection, bullMqWorkerConnection } from './bullmq-connections.js'

type Handler = Pick<NoteVerificationJobProcessor, 'process'>
type JobProcessor = Processor<
  NoteVerificationRequestedPayload,
  NoteRunResult,
  typeof NOTE_VERIFICATION_JOB_NAME
>
type NoteQueue = Queue<
  NoteVerificationRequestedPayload,
  NoteRunResult,
  typeof NOTE_VERIFICATION_JOB_NAME
>

export function createNoteVerificationBullMqProcessor(handler: Handler): JobProcessor {
  return async (job, _token, signal) => {
    const parsed = noteVerificationRequestedEventPayloadSchema.safeParse(job.data)
    if (
      job.name !== NOTE_VERIFICATION_JOB_NAME ||
      !parsed.success ||
      job.id !== buildNoteVerificationJobId(parsed.data.runId)
    )
      throw new UnrecoverableError('INVALID_NOTE_VERIFICATION_JOB')
    try {
      return await handler.process(parsed.data, signal)
    } catch {
      // BullMQ 会保存错误文本；不把数据库详情、正文或供应商响应复制进 Redis/日志。
      throw new Error('NOTE_VERIFICATION_RETRY_REQUIRED')
    }
  }
}

export class BullMqNoteVerificationQueue {
  private readonly logger = new Logger(BullMqNoteVerificationQueue.name)
  private readonly queue: NoteQueue
  private readonly queueName: string
  private worker:
    | Worker<NoteVerificationRequestedPayload, NoteRunResult, typeof NOTE_VERIFICATION_JOB_NAME>
    | undefined

  constructor(
    private readonly options: {
      redisUrl: string
      concurrency: number
      jobOptions: { attempts: number; backoffDelayMs: number }
      processor: Handler
      queueName?: string
    },
  ) {
    this.queueName = options.queueName ?? NOTE_VERIFICATION_QUEUE_NAME
    this.queue = new Queue(this.queueName, {
      connection: bullMqProducerConnection(options.redisUrl),
    }) as NoteQueue
    this.queue.on('error', () => this.logger.error({ event: 'note_queue_unavailable' }))
  }

  start(): void {
    if (this.worker) return
    this.worker = new Worker(
      this.queueName,
      createNoteVerificationBullMqProcessor(this.options.processor),
      {
        concurrency: this.options.concurrency,
        connection: bullMqWorkerConnection(this.options.redisUrl),
      },
    )
    this.worker.on('error', () => this.logger.error({ event: 'note_worker_unavailable' }))
    this.worker.on('completed', (job, result) =>
      this.logger.log({
        event: 'note_verification_completed',
        runId: job.data.runId,
        status: result.status,
        reportId: result.reportId,
      }),
    )
    this.worker.on('failed', (job) =>
      this.logger.warn({ event: 'note_verification_job_failed', runId: job?.data.runId }),
    )
  }

  async publish(message: NoteVerificationOutboxMessage): Promise<{ jobId: string }> {
    const payload = noteVerificationRequestedEventPayloadSchema.parse(message.payload)
    const jobId = buildNoteVerificationJobId(payload.runId)
    await this.queue.add(NOTE_VERIFICATION_JOB_NAME, payload, {
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
  async isFailed(message: NoteVerificationRequestedPayload): Promise<boolean> {
    const job = await this.queue.getJob(buildNoteVerificationJobId(message.runId))
    const parsed = noteVerificationRequestedEventPayloadSchema.safeParse(job?.data)
    return Boolean(
      job &&
      job.name === NOTE_VERIFICATION_JOB_NAME &&
      parsed.success &&
      parsed.data.runId === message.runId &&
      parsed.data.submissionId === message.submissionId &&
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
