import {
  PLAN_GENERATION_JOB_NAME,
  buildPlanGenerationJobId,
  type PlanGenerationRequestedEventPayload,
} from '@knowledgeops/contracts'
import { Queue, Worker, type ConnectionOptions, type Processor } from 'bullmq'

import type { PlanGenerationJobResult } from '../plan-generation/plan-generation-job-processor.js'

export interface PlanGenerationJobOptions {
  attempts: number
  backoffDelayMs: number
}

export type PlanGenerationQueue = Queue<
  PlanGenerationRequestedEventPayload,
  PlanGenerationJobResult,
  typeof PLAN_GENERATION_JOB_NAME
>

export type PlanGenerationWorker = Worker<
  PlanGenerationRequestedEventPayload,
  PlanGenerationJobResult,
  typeof PLAN_GENERATION_JOB_NAME
>

export async function addPlanGenerationJob(
  queue: PlanGenerationQueue,
  payload: PlanGenerationRequestedEventPayload,
  options: PlanGenerationJobOptions,
): Promise<{ jobId: string }> {
  const jobId = buildPlanGenerationJobId(payload.generationRunId)
  await queue.add(
    PLAN_GENERATION_JOB_NAME,
    {
      generationRunId: payload.generationRunId,
    },
    {
      attempts: options.attempts,
      backoff: {
        type: 'exponential',
        delay: options.backoffDelayMs,
      },
      jobId,
      removeOnComplete: false,
      removeOnFail: false,
    },
  )
  return { jobId }
}

export interface RegisterPlanGenerationWorkerOptions {
  concurrency: number
  connection: ConnectionOptions
  processor: Processor<
    PlanGenerationRequestedEventPayload,
    PlanGenerationJobResult,
    typeof PLAN_GENERATION_JOB_NAME
  >
  queueName: string
}

export function registerPlanGenerationWorker(
  options: RegisterPlanGenerationWorkerOptions,
): PlanGenerationWorker {
  return new Worker(options.queueName, options.processor, {
    concurrency: options.concurrency,
    connection: options.connection,
  })
}
