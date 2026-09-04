import {
  InvalidPlanGenerationOutputError,
  InvalidPlanGenerationRequestError,
  PlanGenerationDependencyCycleError,
  PlanGenerationModelError,
  assertPlanGenerationDependenciesAreAcyclic,
  generatePlanCandidate,
  type PlanGenerationOutput,
  type PlanGenerationPort,
} from '@knowledgeops/agent-core'
import {
  PLAN_GENERATION_JOB_NAME,
  planGenerationRequestedEventPayloadSchema,
  type PlanGenerationRunState,
  type PlanGenerationRequestedEventPayload,
} from '@knowledgeops/contracts'
import { Logger } from '@nestjs/common'
import { UnrecoverableError, type Job, type Processor } from 'bullmq'

import { toError } from '../outbox/outbox-dispatch-error.js'
import {
  PlanGenerationSuccessFinalizerNotImplementedError,
  type PlanGenerationSuccessFinalizer,
} from './finalize-plan-generation-run.js'
import {
  PlanGenerationRunRepository,
  type PlanGenerationRunFailure,
} from './plan-generation-run.repository.js'

export type PlanGenerationJobResult =
  | {
      generationRunId: string
      planId: string
      status: 'SUCCEEDED'
    }
  | {
      generationRunId: string
      status: 'FAILED' | 'TIMED_OUT'
    }
  | {
      generationRunId: string
      planId: string | null
      reason: 'CONCURRENT_EXECUTION' | 'STALE_RESULT' | 'TERMINAL'
      runStatus: PlanGenerationRunState
      status: 'SKIPPED'
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

export type PlanGenerationDependencyGuard = (candidate: PlanGenerationOutput) => void

export class PlanGenerationJobProcessor implements PlanGenerationJobHandler {
  private readonly logger = new Logger(PlanGenerationJobProcessor.name)

  constructor(
    private readonly repository: PlanGenerationRunRepository,
    private readonly generator: PlanGenerationPort,
    private readonly finalizer: PlanGenerationSuccessFinalizer,
    private readonly dependencyGuard: PlanGenerationDependencyGuard = assertPlanGenerationDependenciesAreAcyclic,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async process(
    payload: PlanGenerationRequestedEventPayload,
    options: PlanGenerationJobProcessingOptions = {},
  ): Promise<PlanGenerationJobResult> {
    const claimed = await this.repository.claimForExecution(payload.generationRunId, this.clock())

    if (claimed.status === 'NOT_FOUND') {
      throw new NonRetryablePlanGenerationJobError('Plan generation run no longer exists')
    }

    if (claimed.status === 'FAILED' || claimed.status === 'TIMED_OUT') {
      return {
        generationRunId: payload.generationRunId,
        status: claimed.status,
      }
    }

    if (claimed.status === 'SKIPPED') {
      this.logger.log({
        event: 'plan_generation_job_skipped',
        generationRunId: payload.generationRunId,
        reason: claimed.reason,
        runStatus: claimed.runStatus,
      })

      return {
        generationRunId: payload.generationRunId,
        planId: claimed.planId,
        reason: claimed.reason,
        runStatus: claimed.runStatus,
        status: 'SKIPPED',
      }
    }

    const deadlineSignal = createDeadlineSignal(claimed.run.deadlineAt, options.signal)

    this.logger.log({
      event: 'plan_generation_run_started',
      generationRunId: claimed.run.generationRunId,
      model: claimed.run.request.model.modelName,
      modelCatalogId: claimed.run.request.model.catalogId,
      runVersion: claimed.run.expectedVersion,
    })

    try {
      const candidate = await generatePlanCandidate(this.generator, claimed.run.request, {
        signal: deadlineSignal.signal,
      })
      this.dependencyGuard(candidate)

      if (
        deadlineSignal.didDeadlineExpire() ||
        this.clock().getTime() >= claimed.run.deadlineAt.getTime()
      ) {
        throw new PlanGenerationDeadlineExceededError()
      }

      const finalized = await this.finalizer.execute({
        candidate,
        expectedRunVersion: claimed.run.expectedVersion,
        finishedAt: this.clock(),
        generationRunId: claimed.run.generationRunId,
        goalId: claimed.run.goalId,
      })

      if (finalized.status === 'FINALIZED') {
        this.logger.log({
          event: 'plan_generation_run_succeeded',
          generationRunId: claimed.run.generationRunId,
          planId: finalized.planId,
        })

        return {
          generationRunId: claimed.run.generationRunId,
          planId: finalized.planId,
          status: 'SUCCEEDED',
        }
      }

      return {
        generationRunId: claimed.run.generationRunId,
        planId: finalized.planId,
        reason: 'STALE_RESULT',
        runStatus: finalized.runStatus,
        status: 'SKIPPED',
      }
    } catch (error: unknown) {
      const failure = classifyPlanGenerationFailure(
        error,
        deadlineSignal.didDeadlineExpire() ||
          this.clock().getTime() >= claimed.run.deadlineAt.getTime(),
      )
      const recorded = await this.repository.recordFailure(
        claimed.run.generationRunId,
        claimed.run.expectedVersion,
        failure,
        this.clock(),
      )

      if (recorded.status === 'SKIPPED') {
        return {
          generationRunId: claimed.run.generationRunId,
          planId: recorded.planId,
          reason: 'STALE_RESULT',
          runStatus: recorded.runStatus,
          status: 'SKIPPED',
        }
      }

      this.logger.warn({
        event: 'plan_generation_run_terminated',
        errorCode: failure.code,
        generationRunId: claimed.run.generationRunId,
        runStatus: recorded.runStatus,
      })

      return {
        generationRunId: claimed.run.generationRunId,
        status: recorded.runStatus,
      }
    } finally {
      deadlineSignal.dispose()
    }
  }
}

class PlanGenerationDeadlineExceededError extends Error {
  override readonly name = 'PlanGenerationDeadlineExceededError'
}

function classifyPlanGenerationFailure(
  error: unknown,
  deadlineExpired: boolean,
): PlanGenerationRunFailure {
  if (deadlineExpired) {
    return {
      code: 'RUN_DEADLINE_EXCEEDED',
      message: 'Plan generation exceeded its persisted deadline',
      status: 'TIMED_OUT',
    }
  }

  if (error instanceof PlanGenerationModelError) {
    return {
      code: error.code,
      message: error.message,
      status: 'FAILED',
    }
  }

  if (
    error instanceof InvalidPlanGenerationOutputError ||
    error instanceof PlanGenerationDependencyCycleError
  ) {
    return {
      code: 'MODEL_OUTPUT_INVALID',
      message: error.message,
      status: 'FAILED',
    }
  }

  if (error instanceof InvalidPlanGenerationRequestError) {
    return {
      code: 'PLAN_GENERATION_REQUEST_INVALID',
      message: error.message,
      status: 'FAILED',
    }
  }

  if (error instanceof PlanGenerationSuccessFinalizerNotImplementedError) {
    return {
      code: 'FINALIZER_NOT_IMPLEMENTED',
      message: error.message,
      status: 'FAILED',
    }
  }

  const normalized = toError(error)

  return {
    code: 'INTERNAL_ERROR',
    message: normalized.message,
    status: 'FAILED',
  }
}

function createDeadlineSignal(
  deadlineAt: Date,
  externalSignal?: AbortSignal,
): {
  didDeadlineExpire: () => boolean
  dispose: () => void
  signal: AbortSignal
} {
  const controller = new AbortController()
  let deadlineExpired = false

  const abortForDeadline = () => {
    deadlineExpired = true
    controller.abort(new Error('Plan generation deadline exceeded'))
  }
  const abortFromExternalSignal = () => {
    controller.abort(externalSignal?.reason)
  }
  const delayMs = Math.max(0, deadlineAt.getTime() - Date.now())
  const timer = setTimeout(abortForDeadline, delayMs)
  timer.unref()

  if (externalSignal?.aborted) {
    abortFromExternalSignal()
  } else {
    externalSignal?.addEventListener('abort', abortFromExternalSignal, { once: true })
  }

  return {
    didDeadlineExpire: () => deadlineExpired,
    dispose: () => {
      clearTimeout(timer)
      externalSignal?.removeEventListener('abort', abortFromExternalSignal)
    },
    signal: controller.signal,
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
