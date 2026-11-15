import {
  COURSE_EXERCISE_JOB_NAME,
  COURSE_EXERCISE_QUEUE_NAME,
  buildCourseExerciseJobId,
  courseExerciseRequestedEventPayloadSchema,
  type CourseExerciseRequestedEventPayload,
} from '@knowledgeops/contracts'
import { Logger } from '@nestjs/common'
import { Queue, Worker, UnrecoverableError } from 'bullmq'

import type { CourseExerciseJobProcessor } from '../course-exercise/course-exercise-job-processor.js'
import type { CourseExerciseOutboxMessage } from '../outbox/outbox-event.js'
import { bullMqProducerConnection, bullMqWorkerConnection } from './bullmq-connections.js'

export class BullMqCourseExerciseQueue {
  private readonly logger = new Logger(BullMqCourseExerciseQueue.name)
  private readonly queue: Queue<CourseExerciseRequestedEventPayload>
  private readonly queueName: string
  private worker: Worker<CourseExerciseRequestedEventPayload> | undefined

  constructor(
    private readonly options: {
      concurrency: number
      jobOptions: { attempts: number; backoffDelayMs: number }
      processor: CourseExerciseJobProcessor
      queueName?: string
      redisUrl: string
    },
  ) {
    this.queueName = options.queueName ?? COURSE_EXERCISE_QUEUE_NAME
    this.queue = new Queue(this.queueName, {
      connection: bullMqProducerConnection(options.redisUrl),
    })
    this.queue.on('error', () => this.logger.error({ event: 'course_exercise_queue_unavailable' }))
  }

  start(): void {
    if (this.worker) return
    this.worker = new Worker<CourseExerciseRequestedEventPayload>(
      this.queueName,
      async (job, _token, signal) => {
        const parsed = courseExerciseRequestedEventPayloadSchema.safeParse(job.data)
        if (
          job.name !== COURSE_EXERCISE_JOB_NAME ||
          !parsed.success ||
          job.id !== buildCourseExerciseJobId(parsed.data.submissionId)
        )
          throw new UnrecoverableError('INVALID_COURSE_EXERCISE_JOB')
        return this.options.processor.process(parsed.data, signal)
      },
      {
        concurrency: this.options.concurrency,
        connection: bullMqWorkerConnection(this.options.redisUrl),
      },
    )
    this.worker.on('error', () =>
      this.logger.error({ event: 'course_exercise_worker_unavailable' }),
    )
  }

  async publish(message: CourseExerciseOutboxMessage): Promise<{ jobId: string }> {
    const payload = courseExerciseRequestedEventPayloadSchema.parse(message.payload)
    const jobId = buildCourseExerciseJobId(payload.submissionId)
    await this.queue.add(COURSE_EXERCISE_JOB_NAME, payload, {
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
