import {
  CourseGenerationModelError,
  InvalidCourseGenerationOutputError,
  InvalidCourseGenerationRequestError,
  generateCourseCandidate,
  type CourseGenerationPort,
} from '@knowledgeops/agent-core'
import {
  isPlanGenerationRunTerminalState,
  type CourseGenerationRequestedEventPayload,
  type PlanGenerationRunState,
} from '@knowledgeops/contracts'

import { CourseGenerationRunRepository } from './course-generation-run.repository.js'
import { FinalizeCourseGenerationRun } from './finalize-course-generation-run.js'

export type CourseGenerationJobResult =
  | { generationRunId: string; courseVersionId: string; status: 'SUCCEEDED' }
  | { generationRunId: string; status: 'FAILED' | 'TIMED_OUT' }
  | {
      generationRunId: string
      status: 'SKIPPED'
      reason: 'CONCURRENT_EXECUTION' | 'TERMINAL'
      runStatus: PlanGenerationRunState
    }

export class CourseGenerationJobProcessor {
  constructor(
    private readonly repository: CourseGenerationRunRepository,
    private readonly generator: CourseGenerationPort,
    private readonly finalizer: FinalizeCourseGenerationRun,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async process(
    payload: CourseGenerationRequestedEventPayload,
    signal?: AbortSignal,
  ): Promise<CourseGenerationJobResult> {
    const claimed = await this.repository.claimForExecution(payload.generationRunId, this.clock())
    if (claimed.status === 'NOT_FOUND') throw new Error('Course generation run no longer exists')
    if (claimed.status === 'FAILED' || claimed.status === 'TIMED_OUT')
      return { generationRunId: payload.generationRunId, status: claimed.status }
    if (claimed.status !== 'CLAIMED')
      return { generationRunId: payload.generationRunId, ...claimed }

    const timeout = AbortSignal.timeout(
      Math.max(1, claimed.run.deadlineAt.getTime() - this.clock().getTime()),
    )
    const combined = signal ? AbortSignal.any([timeout, signal]) : timeout
    try {
      const candidate = await generateCourseCandidate(this.generator, claimed.run.request, {
        signal: combined,
      })
      const finishedAt = this.clock()
      if (finishedAt >= claimed.run.deadlineAt) throw new CourseGenerationDeadlineError()
      const finalized = await this.finalizer.execute({
        candidate,
        expectedRunVersion: claimed.run.expectedVersion,
        finishedAt,
        generationRunId: claimed.run.generationRunId,
      })
      if (finalized.status === 'FINALIZED')
        return {
          generationRunId: claimed.run.generationRunId,
          courseVersionId: finalized.courseVersionId,
          status: 'SUCCEEDED',
        }
      return {
        generationRunId: claimed.run.generationRunId,
        status: 'SKIPPED',
        reason: isPlanGenerationRunTerminalState(finalized.runStatus)
          ? 'TERMINAL'
          : 'CONCURRENT_EXECUTION',
        runStatus: finalized.runStatus,
      }
    } catch (error: unknown) {
      const timedOut =
        error instanceof CourseGenerationDeadlineError || this.clock() >= claimed.run.deadlineAt
      const failure = timedOut
        ? { code: 'RUN_DEADLINE_EXCEEDED', message: 'Course generation exceeded its deadline' }
        : error instanceof CourseGenerationModelError
          ? { code: error.code, message: error.message }
          : error instanceof InvalidCourseGenerationOutputError
            ? { code: 'MODEL_OUTPUT_INVALID', message: 'Invalid course learning package' }
            : error instanceof InvalidCourseGenerationRequestError
              ? {
                  code: 'COURSE_GENERATION_REQUEST_INVALID',
                  message: 'Invalid course generation input',
                }
              : { code: 'INTERNAL_ERROR', message: 'Course generation failed unexpectedly' }
      const recorded = await this.repository.recordFailure(
        claimed.run.generationRunId,
        claimed.run.expectedVersion,
        { ...failure, status: timedOut ? 'TIMED_OUT' : 'FAILED' },
        this.clock(),
      )
      if (recorded.status === 'SKIPPED')
        return {
          generationRunId: claimed.run.generationRunId,
          status: 'SKIPPED',
          reason: isPlanGenerationRunTerminalState(recorded.runStatus)
            ? 'TERMINAL'
            : 'CONCURRENT_EXECUTION',
          runStatus: recorded.runStatus,
        }
      return {
        generationRunId: claimed.run.generationRunId,
        status: timedOut ? 'TIMED_OUT' : 'FAILED',
      }
    }
  }
}

class CourseGenerationDeadlineError extends Error {}
