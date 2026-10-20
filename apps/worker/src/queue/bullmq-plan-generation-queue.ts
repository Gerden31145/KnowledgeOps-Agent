import {
  PLAN_GENERATION_QUEUE_NAME,
  type PlanGenerationRequestedEventPayload,
} from '@knowledgeops/contracts'
import { Logger } from '@nestjs/common'
import { Queue } from 'bullmq'
import { bullMqProducerConnection, bullMqWorkerConnection } from './bullmq-connections.js'

import type { OutboxPublisher } from '../outbox/outbox-dispatcher.js'
import { sanitizeDispatchErrorMessage } from '../outbox/outbox-dispatch-error.js'
import type { PlanGenerationOutboxMessage } from '../outbox/outbox-event.js'
import {
  createPlanGenerationBullMqProcessor,
  type PlanGenerationJobHandler,
} from '../plan-generation/plan-generation-job-processor.js'
import {
  addPlanGenerationJob,
  registerPlanGenerationWorker,
  type PlanGenerationJobOptions,
  type PlanGenerationQueue,
  type PlanGenerationWorker,
} from './bullmq-plan-generation-queue.exercise.js'

export interface BullMqPlanGenerationQueueOptions {
  concurrency: number
  jobOptions: PlanGenerationJobOptions
  processor: PlanGenerationJobHandler
  queueName?: string
  redisUrl: string
}

export class BullMqPlanGenerationQueue implements OutboxPublisher {
  private readonly logger = new Logger(BullMqPlanGenerationQueue.name)
  private readonly queue: PlanGenerationQueue
  private readonly queueName: string
  private worker: PlanGenerationWorker | undefined

  constructor(private readonly options: BullMqPlanGenerationQueueOptions) {
    this.queueName = options.queueName ?? PLAN_GENERATION_QUEUE_NAME
    this.queue = new Queue<PlanGenerationRequestedEventPayload>(this.queueName, {
      connection: bullMqProducerConnection(this.options.redisUrl),
    }) as PlanGenerationQueue

    this.queue.on('error', (error) => {
      this.logger.error({
        event: 'plan_generation_queue_error',
        errorMessage: sanitizeDispatchErrorMessage(error.message),
        errorName: error.name,
      })
    })
  }

  start(): void {
    if (this.worker) {
      return
    }

    this.worker = registerPlanGenerationWorker({
      concurrency: this.options.concurrency,
      connection: bullMqWorkerConnection(this.options.redisUrl),
      processor: createPlanGenerationBullMqProcessor(this.options.processor),
      queueName: this.queueName,
    })

    this.worker.on('completed', (job, result) => {
      this.logger.log({
        event: 'plan_generation_job_completed',
        generationRunId: result.generationRunId,
        jobId: job.id,
        outcome: result.status,
        ...('planId' in result ? { planId: result.planId } : {}),
        ...('reason' in result ? { reason: result.reason } : {}),
      })
    })
    this.worker.on('failed', (job, error) => {
      this.logger.warn({
        event: 'plan_generation_job_failed',
        errorMessage: sanitizeDispatchErrorMessage(error.message),
        errorName: error.name,
        generationRunId: job?.data.generationRunId,
        jobId: job?.id,
      })
    })
    this.worker.on('error', (error) => {
      this.logger.error({
        event: 'plan_generation_worker_error',
        errorMessage: sanitizeDispatchErrorMessage(error.message),
        errorName: error.name,
      })
    })
  }

  async publish(message: PlanGenerationOutboxMessage): Promise<{ jobId: string }> {
    return addPlanGenerationJob(this.queue, message.payload, this.options.jobOptions)
  }

  async waitUntilReady(): Promise<void> {
    await Promise.all([this.queue.waitUntilReady(), this.worker?.waitUntilReady()])
  }

  async close(): Promise<void> {
    await this.worker?.close()
    await this.queue.close()
  }
}
