import {
  CourseQuestionModelError,
  InvalidCourseQuestionAnswerError,
  InvalidCourseQuestionRequestError,
  generateCourseQuestionAnswer,
  type CourseQuestionPort,
} from '@knowledgeops/agent-core'
import type {
  CourseQuestionRequestedEventPayload,
  CourseQuestionStatus,
} from '@knowledgeops/contracts'
import { Logger } from '@nestjs/common'

import type { CourseQuestionExecutionRepository } from './course-question-execution.repository.js'

export type CourseQuestionJobResult =
  | { questionId: string; status: 'SUCCEEDED' | 'FAILED' }
  | {
      questionId: string
      status: 'SKIPPED'
      reason: 'CONCURRENT_EXECUTION' | 'TERMINAL'
      questionStatus: CourseQuestionStatus
    }

export class CourseQuestionJobProcessor {
  private readonly logger = new Logger(CourseQuestionJobProcessor.name)

  constructor(
    private readonly repository: CourseQuestionExecutionRepository,
    private readonly model: CourseQuestionPort,
    private readonly timeoutMs: number,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async process(
    payload: CourseQuestionRequestedEventPayload,
    signal?: AbortSignal,
  ): Promise<CourseQuestionJobResult> {
    const claimed = await this.repository.claimForExecution(
      payload.questionId,
      this.clock(),
      this.timeoutMs,
    )
    if (claimed.status === 'NOT_FOUND') throw new Error('Course question no longer exists')
    if (claimed.status === 'FAILED') return { questionId: payload.questionId, status: 'FAILED' }
    if (claimed.status !== 'CLAIMED') return { questionId: payload.questionId, ...claimed }

    const question = claimed.question
    const timeout = AbortSignal.timeout(
      Math.max(1, question.deadlineAt.getTime() - this.clock().getTime()),
    )
    try {
      const candidate = await generateCourseQuestionAnswer(this.model, question.request, {
        signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
      })
      const completedAt = this.clock()
      if (completedAt >= question.deadlineAt) throw new CourseQuestionDeadlineError()
      const saved = await this.repository.recordSuccess(
        question.questionId,
        question.expectedVersion,
        candidate.answer,
        completedAt,
      )
      if (saved.status === 'RECORDED')
        return { questionId: question.questionId, status: 'SUCCEEDED' }
      return {
        questionId: question.questionId,
        status: 'SKIPPED',
        reason: saved.questionStatus === 'RUNNING' ? 'CONCURRENT_EXECUTION' : 'TERMINAL',
        questionStatus: saved.questionStatus,
      }
    } catch (error: unknown) {
      const timedOut =
        error instanceof CourseQuestionDeadlineError || this.clock() >= question.deadlineAt
      const errorCode = timedOut
        ? 'RUN_DEADLINE_EXCEEDED'
        : error instanceof InvalidCourseQuestionAnswerError
          ? 'MODEL_OUTPUT_INVALID'
          : error instanceof InvalidCourseQuestionRequestError
            ? 'COURSE_QUESTION_REQUEST_INVALID'
            : error instanceof CourseQuestionModelError
              ? error.code
              : 'MODEL_UNAVAILABLE'
      this.logger.warn({
        event: 'course_question_execution_failed',
        questionId: question.questionId,
        errorCode,
        ...(error instanceof CourseQuestionModelError && error.diagnostic
          ? { diagnostic: error.diagnostic }
          : {}),
      })
      const recorded = await this.repository.recordFailure(
        question.questionId,
        question.expectedVersion,
        errorCode,
        this.clock(),
      )
      if (recorded.status === 'SKIPPED')
        return {
          questionId: question.questionId,
          status: 'SKIPPED',
          reason: recorded.questionStatus === 'RUNNING' ? 'CONCURRENT_EXECUTION' : 'TERMINAL',
          questionStatus: recorded.questionStatus,
        }
      return { questionId: question.questionId, status: 'FAILED' }
    }
  }
}

class CourseQuestionDeadlineError extends Error {}
