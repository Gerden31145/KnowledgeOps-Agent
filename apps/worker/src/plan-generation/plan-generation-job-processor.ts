import {
  PLAN_GENERATION_JOB_NAME,
  planGenerationRequestedEventPayloadSchema,
  type PlanGenerationRequestedEventPayload,
} from '@knowledgeops/contracts'
import { Injectable, Logger } from '@nestjs/common'
import { UnrecoverableError, type Job, type Processor } from 'bullmq'

import { toError } from '../outbox/outbox-dispatch-error.js'

export interface PlanGenerationJobResult {
  generationRunId: string
  status: 'SKELETON_ACCEPTED'
}

export interface PlanGenerationJobProcessingOptions {
  signal?: AbortSignal
}

export interface PlanGenerationJobHandler {
  process(
    payload: PlanGenerationRequestedEventPayload,
    options: PlanGenerationJobProcessingOptions,
  ): Promise<PlanGenerationJobResult>
}

export type PlanGenerationBullMqJob = Job<
  PlanGenerationRequestedEventPayload,
  PlanGenerationJobResult,
  typeof PLAN_GENERATION_JOB_NAME
>

export type PlanGenerationBullMqProcessor = Processor<
  PlanGenerationRequestedEventPayload,
  PlanGenerationJobResult,
  typeof PLAN_GENERATION_JOB_NAME
>

export class NonRetryablePlanGenerationJobError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options)
    this.name = 'NonRetryablePlanGenerationJobError'
  }
}

@Injectable()
export class PlanGenerationJobProcessor implements PlanGenerationJobHandler {
  private readonly logger = new Logger(PlanGenerationJobProcessor.name)

  async process(payload: PlanGenerationRequestedEventPayload): Promise<PlanGenerationJobResult> {
    this.logger.log({
      event: 'plan_generation_job_skeleton_received',
      generationRunId: payload.generationRunId,
    })

    return {
      generationRunId: payload.generationRunId,
      status: 'SKELETON_ACCEPTED',
    }
  }
}

export function createPlanGenerationBullMqProcessor(
  handler: PlanGenerationJobHandler,
): PlanGenerationBullMqProcessor {
  return async (job, _token, signal) => {
    if (job.name !== PLAN_GENERATION_JOB_NAME) {
      throw new UnrecoverableError(`Unsupported plan generation job name: ${job.name}`)
    }

    const payloadResult = planGenerationRequestedEventPayloadSchema.safeParse(job.data)

    if (!payloadResult.success) {
      throw new UnrecoverableError('Invalid plan generation job payload')
    }

    try {
      return await handler.process(payloadResult.data, {
        ...(signal ? { signal } : {}),
      })
    } catch (error: unknown) {
      if (error instanceof NonRetryablePlanGenerationJobError) {
        throw new UnrecoverableError(error.message)
      }

      throw toError(error)
    }
  }
}
