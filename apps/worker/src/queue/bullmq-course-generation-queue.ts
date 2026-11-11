import {
  COURSE_GENERATION_JOB_NAME,
  COURSE_GENERATION_QUEUE_NAME,
  buildCourseGenerationJobId,
  courseGenerationRequestedEventPayloadSchema,
  type CourseGenerationRequestedEventPayload,
} from '@knowledgeops/contracts'
import { Logger } from '@nestjs/common'
import { Queue, Worker, UnrecoverableError } from 'bullmq'

import type { CourseGenerationJobProcessor } from '../course-generation/course-generation-job-processor.js'
import type { CourseGenerationOutboxMessage } from '../outbox/outbox-event.js'
import { bullMqProducerConnection, bullMqWorkerConnection } from './bullmq-connections.js'

export class BullMqCourseGenerationQueue {
  private readonly logger = new Logger(BullMqCourseGenerationQueue.name)
  private readonly queue: Queue<CourseGenerationRequestedEventPayload>
  private readonly queueName: string
  private worker: Worker<CourseGenerationRequestedEventPayload> | undefined

  constructor(
    private readonly options: {
      concurrency: number
      jobOptions: { attempts: number; backoffDelayMs: number }
      processor: CourseGenerationJobProcessor
      queueName?: string
      redisUrl: string
    },
  ) {
    this.queueName = options.queueName ?? COURSE_GENERATION_QUEUE_NAME
    this.queue = new Queue(this.queueName, {
      connection: bullMqProducerConnection(options.redisUrl),
    })
    this.queue.on('error', () =>
      this.logger.error({ event: 'course_generation_queue_unavailable' }),
    )
  }

  start(): void {
    if (this.worker) return
    this.worker = new Worker<CourseGenerationRequestedEventPayload>(
      this.queueName,
      async (job, _token, signal) => {
        const parsed = courseGenerationRequestedEventPayloadSchema.safeParse(job.data)
        if (
          job.name !== COURSE_GENERATION_JOB_NAME ||
          !parsed.success ||
          job.id !== buildCourseGenerationJobId(parsed.data.generationRunId)
        )
          throw new UnrecoverableError('INVALID_COURSE_GENERATION_JOB')
        return this.options.processor.process(parsed.data, signal)
      },
      {
        concurrency: this.options.concurrency,
        connection: bullMqWorkerConnection(this.options.redisUrl),
      },
    )
    this.worker.on('error', () =>
      this.logger.error({ event: 'course_generation_worker_unavailable' }),
    )
  }

  async publish(message: CourseGenerationOutboxMessage): Promise<{ jobId: string }> {
    const payload = courseGenerationRequestedEventPayloadSchema.parse(message.payload)
    const jobId = buildCourseGenerationJobId(payload.generationRunId)
    await this.queue.add(COURSE_GENERATION_JOB_NAME, payload, {
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

  async close(): Promise<void> {
    try {
      await this.worker?.close()
    } finally {
      await this.queue.close()
    }
  }
}
