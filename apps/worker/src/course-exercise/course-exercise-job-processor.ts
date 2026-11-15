import {
  CourseExerciseModelError,
  InvalidCourseExerciseEvaluationError,
  buildCourseExerciseReport,
  evaluateCourseFollowUpAnswer,
  type CourseExerciseVerificationPort,
} from '@knowledgeops/agent-core'
import type {
  CourseExerciseRequestedEventPayload,
  CourseExerciseSubmissionStatus,
} from '@knowledgeops/contracts'
import { Logger } from '@nestjs/common'
import { z } from 'zod'

import type { CourseExerciseExecutionRepository } from './course-exercise-execution.repository.js'

export type CourseExerciseJobResult =
  | { submissionId: string; status: 'SUCCEEDED' | 'FAILED' }
  | {
      submissionId: string
      status: 'SKIPPED'
      reason: 'CONCURRENT_EXECUTION' | 'TERMINAL'
      submissionStatus: CourseExerciseSubmissionStatus
    }

export class CourseExerciseJobProcessor {
  private readonly logger = new Logger(CourseExerciseJobProcessor.name)

  constructor(
    private readonly repository: CourseExerciseExecutionRepository,
    private readonly model: CourseExerciseVerificationPort,
    private readonly timeoutMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async process(
    payload: CourseExerciseRequestedEventPayload,
    signal?: AbortSignal,
  ): Promise<CourseExerciseJobResult> {
    const claimed = await this.repository.claimForExecution(
      payload.submissionId,
      this.clock(),
      this.timeoutMs,
    )
    if (claimed.status === 'NOT_FOUND')
      throw new Error('Course exercise submission no longer exists')
    if (claimed.status === 'FAILED') return { submissionId: payload.submissionId, status: 'FAILED' }
    if (claimed.status !== 'CLAIMED') return { submissionId: payload.submissionId, ...claimed }

    const submission = claimed.submission
    const timeout = AbortSignal.timeout(
      Math.max(1, submission.deadlineAt.getTime() - this.clock().getTime()),
    )
    try {
      const followUp = await evaluateCourseFollowUpAnswer(this.model, submission.request, {
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      })
      const report = buildCourseExerciseReport(submission.exerciseSet, submission.answers, followUp)
      const completedAt = this.clock()
      if (completedAt >= submission.deadlineAt) throw new CourseExerciseDeadlineError()
      const saved = await this.repository.recordSuccess(
        submission.submissionId,
        submission.expectedVersion,
        report,
        completedAt,
      )
      if (saved.status === 'RECORDED')
        return { submissionId: submission.submissionId, status: saved.submissionStatus }
      return {
        submissionId: submission.submissionId,
        status: 'SKIPPED',
        reason: saved.submissionStatus === 'RUNNING' ? 'CONCURRENT_EXECUTION' : 'TERMINAL',
        submissionStatus: saved.submissionStatus,
      }
    } catch (error: unknown) {
      const timedOut =
        error instanceof CourseExerciseDeadlineError || this.clock() >= submission.deadlineAt
      const errorCode = timedOut
        ? 'RUN_DEADLINE_EXCEEDED'
        : error instanceof CourseExerciseModelError &&
            ['MODEL_OUTPUT_INVALID', 'MODEL_OUTPUT_TRUNCATED'].includes(error.code)
          ? error.code
          : error instanceof InvalidCourseExerciseEvaluationError
            ? 'MODEL_OUTPUT_INVALID'
            : 'MODEL_UNAVAILABLE'
      const modelCause = error instanceof CourseExerciseModelError ? error.cause : null
      this.logger.warn({
        event: 'course_exercise_execution_failed',
        submissionId: submission.submissionId,
        errorCode,
        errorName: error instanceof Error ? error.name : 'UnknownError',
        modelErrorCode: error instanceof CourseExerciseModelError ? error.code : null,
        outputMetadata: error instanceof CourseExerciseModelError ? error.outputMetadata : null,
        validationIssues:
          modelCause instanceof z.core.$ZodError
            ? modelCause.issues.map((issue) => ({ code: issue.code, path: issue.path.join('.') }))
            : null,
      })
      const recorded = await this.repository.recordFailure(
        submission.submissionId,
        submission.expectedVersion,
        errorCode,
        this.clock(),
      )
      if (recorded.status === 'SKIPPED')
        return {
          submissionId: submission.submissionId,
          status: 'SKIPPED',
          reason: recorded.submissionStatus === 'RUNNING' ? 'CONCURRENT_EXECUTION' : 'TERMINAL',
          submissionStatus: recorded.submissionStatus,
        }
      return { submissionId: submission.submissionId, status: 'FAILED' }
    }
  }
}

class CourseExerciseDeadlineError extends Error {}
