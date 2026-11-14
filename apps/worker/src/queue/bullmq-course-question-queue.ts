import {
  COURSE_QUESTION_JOB_NAME,
  COURSE_QUESTION_QUEUE_NAME,
  buildCourseQuestionJobId,
  courseQuestionRequestedEventPayloadSchema,
  type CourseQuestionRequestedEventPayload,
} from '@knowledgeops/contracts'
import { Logger } from '@nestjs/common'
import { Queue, Worker, UnrecoverableError } from 'bullmq'

import type { CourseQuestionJobProcessor } from '../course-question/course-question-job-processor.js'
import type { CourseQuestionOutboxMessage } from '../outbox/outbox-event.js'
import { bullMqProducerConnection, bullMqWorkerConnection } from './bullmq-connections.js'

export class BullMqCourseQuestionQueue {
  private readonly logger = new Logger(BullMqCourseQuestionQueue.name)
  private readonly queue: Queue<CourseQuestionRequestedEventPayload>
  private readonly queueName: string
  private worker: Worker<CourseQuestionRequestedEventPayload> | undefined

  constructor(
    private readonly options: {
      concurrency: number
      jobOptions: { attempts: number; backoffDelayMs: number }
      processor: CourseQuestionJobProcessor
      queueName?: string
      redisUrl: string
    },
  ) {
    this.queueName = options.queueName ?? COURSE_QUESTION_QUEUE_NAME
    this.queue = new Queue(this.queueName, {
      connection: bullMqProducerConnection(options.redisUrl),
    })
    this.queue.on('error', () => this.logger.error({ event: 'course_question_queue_unavailable' }))
  }

  start(): void {
    if (this.worker) return
    this.worker = new Worker<CourseQuestionRequestedEventPayload>(
      this.queueName,
      async (job, _token, signal) => {
        const parsed = courseQuestionRequestedEventPayloadSchema.safeParse(job.data)
        if (
          job.name !== COURSE_QUESTION_JOB_NAME ||
          !parsed.success ||
          job.id !== buildCourseQuestionJobId(parsed.data.questionId)
        )
          throw new UnrecoverableError('INVALID_COURSE_QUESTION_JOB')
        return this.options.processor.process(parsed.data, signal)
      },
      {
        concurrency: this.options.concurrency,
        connection: bullMqWorkerConnection(this.options.redisUrl),
      },
    )
    this.worker.on('error', () =>
      this.logger.error({ event: 'course_question_worker_unavailable' }),
    )
  }

  async publish(message: CourseQuestionOutboxMessage): Promise<{ jobId: string }> {
    const payload = courseQuestionRequestedEventPayloadSchema.parse(message.payload)
    const jobId = buildCourseQuestionJobId(payload.questionId)
    await this.queue.add(COURSE_QUESTION_JOB_NAME, payload, {
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
