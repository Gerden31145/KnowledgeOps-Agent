import {
  courseFollowUpVerificationRequestSchema,
  type CourseFollowUpVerificationRequest,
} from '@knowledgeops/agent-core'
import {
  courseExerciseAnswersSchema,
  courseExerciseReportSchema,
  courseSectionSchema,
  exerciseSetBodySchema,
  type CourseExerciseReport,
  type CourseExerciseSubmissionStatus,
  type ExerciseSetBody,
} from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'
import { z } from 'zod'

import { unlockDependentTasks } from '../verification/unlock-dependent-tasks.js'
import { recordFirstSubmissionKnowledge } from './course-knowledge-mastery.repository.js'

export interface ClaimedCourseExercise {
  answers: z.infer<typeof courseExerciseAnswersSchema>
  deadlineAt: Date
  exerciseSet: ExerciseSetBody
  expectedVersion: number
  request: CourseFollowUpVerificationRequest
  submissionId: string
}

export type ClaimCourseExerciseResult =
  | { status: 'CLAIMED'; submission: ClaimedCourseExercise }
  | { status: 'NOT_FOUND' }
  | { status: 'FAILED' }
  | {
      status: 'SKIPPED'
      reason: 'CONCURRENT_EXECUTION' | 'TERMINAL'
      submissionStatus: CourseExerciseSubmissionStatus
    }

export type CourseExerciseWriteResult =
  | { status: 'RECORDED'; submissionStatus: 'SUCCEEDED' | 'FAILED' }
  | { status: 'SKIPPED'; submissionStatus: CourseExerciseSubmissionStatus }

const submissionInclude = {
  exerciseSet: {
    select: {
      body: true,
      courseVersion: {
        select: {
          content: true,
          generationRun: { select: { modelReasoningEffort: true } },
          course: {
            select: {
              task: {
                select: {
                  id: true,
                  title: true,
                  description: true,
                  state: true,
                  version: true,
                  stage: {
                    select: {
                      plan: {
                        select: { id: true, status: true, goal: { select: { userId: true } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
} as const

export class CourseExerciseExecutionRepository {
  constructor(private readonly database: DatabaseClient) {}

  async claimForExecution(
    submissionId: string,
    now: Date,
    timeoutMs: number,
  ): Promise<ClaimCourseExerciseResult> {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM course_exercise_submissions WHERE id = ${submissionId}::uuid FOR UPDATE`
      const submission = await tx.courseExerciseSubmission.findUnique({
        where: { id: submissionId },
        include: submissionInclude,
      })
      if (!submission) return { status: 'NOT_FOUND' }
      if (submission.status === 'SUCCEEDED' || submission.status === 'FAILED')
        return { status: 'SKIPPED', reason: 'TERMINAL', submissionStatus: submission.status }
      if (submission.status === 'RUNNING') {
        if (submission.deadlineAt && submission.deadlineAt <= now) {
          await tx.courseExerciseSubmission.update({
            where: { id: submission.id },
            data: {
              status: 'FAILED',
              errorCode: 'RUN_DEADLINE_EXCEEDED',
              completedAt: now,
              executionVersion: { increment: 1 },
            },
          })
          return { status: 'FAILED' }
        }
        return {
          status: 'SKIPPED',
          reason: 'CONCURRENT_EXECUTION',
          submissionStatus: submission.status,
        }
      }

      let claimed: ClaimedCourseExercise
      try {
        const version = submission.exerciseSet.courseVersion
        const task = version.course.task
        const exerciseSet = exerciseSetBodySchema.parse(submission.exerciseSet.body)
        const answers = courseExerciseAnswersSchema.parse({
          multipleChoiceAnswers: submission.multipleChoiceAnswers,
          followUpAnswer: submission.followUpAnswer,
        })
        const content = z
          .object({ sections: z.array(courseSectionSchema).min(3).max(6) })
          .parse(version.content)
        const request = courseFollowUpVerificationRequestSchema.parse({
          model: {
            catalogId: submission.modelCatalogId,
            provider: submission.modelProvider,
            modelName: submission.modelName,
            reasoningEffort: version.generationRun.modelReasoningEffort,
          },
          course: {
            title: task.title,
            description: task.description,
            sections: content.sections,
          },
          question: exerciseSet.followUp,
          answer: answers.followUpAnswer,
        })
        claimed = {
          answers,
          deadlineAt: new Date(now.getTime() + timeoutMs),
          exerciseSet,
          expectedVersion: submission.executionVersion + 1,
          request,
          submissionId: submission.id,
        }
      } catch {
        await tx.courseExerciseSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'FAILED',
            errorCode: 'COURSE_EXERCISE_REQUEST_INVALID',
            completedAt: now,
            executionVersion: { increment: 1 },
          },
        })
        return { status: 'FAILED' }
      }

      await tx.courseExerciseSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'RUNNING',
          deadlineAt: claimed.deadlineAt,
          executionVersion: { increment: 1 },
          errorCode: null,
          completedAt: null,
        },
      })
      return { status: 'CLAIMED', submission: claimed }
    })
  }

  async recordSuccess(
    submissionId: string,
    expectedVersion: number,
    report: CourseExerciseReport,
    completedAt: Date,
  ): Promise<CourseExerciseWriteResult> {
    const parsedReport = courseExerciseReportSchema.parse(report)
    return this.database.$transaction(async (tx) => {
      const owner = await tx.courseExerciseSubmission.findUnique({
        where: { id: submissionId },
        include: submissionInclude,
      })
      if (!owner) return { status: 'SKIPPED', submissionStatus: 'FAILED' as const }
      const userId = owner.exerciseSet.courseVersion.course.task.stage.plan.goal.userId
      await tx.$queryRaw`SELECT id FROM users WHERE id = ${userId}::uuid FOR UPDATE`
      await tx.$queryRaw`SELECT id FROM course_exercise_submissions WHERE id = ${submissionId}::uuid FOR UPDATE`
      const taskId = owner.exerciseSet.courseVersion.course.task.id
      await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`
      const submission = await tx.courseExerciseSubmission.findUnique({
        where: { id: submissionId },
        include: submissionInclude,
      })
      if (
        !submission ||
        submission.status !== 'RUNNING' ||
        submission.executionVersion !== expectedVersion
      )
        return {
          status: 'SKIPPED',
          submissionStatus: submission?.status ?? ('FAILED' as const),
        }

      const task = submission.exerciseSet.courseVersion.course.task
      const expired = submission.deadlineAt && submission.deadlineAt <= completedAt
      const contextChanged =
        task.stage.plan.status !== 'ACTIVE' ||
        task.state !== 'IN_PROGRESS' ||
        task.version !== submission.expectedTaskVersion
      if (expired || contextChanged) {
        await tx.courseExerciseSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'FAILED',
            errorCode: expired ? 'RUN_DEADLINE_EXCEEDED' : 'EXECUTION_CONTEXT_CHANGED',
            completedAt,
            executionVersion: { increment: 1 },
          },
        })
        return { status: 'RECORDED', submissionStatus: 'FAILED' }
      }

      await recordFirstSubmissionKnowledge(tx, {
        submissionId: submission.id,
        exerciseSetId: submission.exerciseSetId,
        userId,
        planId: task.stage.plan.id,
        exerciseSet: exerciseSetBodySchema.parse(submission.exerciseSet.body),
        report: parsedReport,
        completedAt,
      })
      await tx.courseExerciseSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'SUCCEEDED',
          report: parsedReport,
          completedAt,
          errorCode: null,
          executionVersion: { increment: 1 },
        },
      })
      await tx.task.update({
        where: { id: task.id },
        data: {
          state: parsedReport.passed ? 'PASSED' : 'IN_PROGRESS',
          version: { increment: 1 },
        },
      })
      if (parsedReport.passed) await unlockDependentTasks(tx, task.id, task.stage.plan.id)
      return { status: 'RECORDED', submissionStatus: 'SUCCEEDED' }
    })
  }

  async recordFailure(
    submissionId: string,
    expectedVersion: number,
    errorCode: string,
    completedAt: Date,
  ): Promise<CourseExerciseWriteResult> {
    const updated = await this.database.courseExerciseSubmission.updateMany({
      where: { id: submissionId, status: 'RUNNING', executionVersion: expectedVersion },
      data: {
        status: 'FAILED',
        errorCode: errorCode.slice(0, 64),
        completedAt,
        executionVersion: { increment: 1 },
      },
    })
    if (updated.count === 1) return { status: 'RECORDED', submissionStatus: 'FAILED' }
    const current = await this.database.courseExerciseSubmission.findUnique({
      where: { id: submissionId },
      select: { status: true },
    })
    return { status: 'SKIPPED', submissionStatus: current?.status ?? 'FAILED' }
  }

  async timeoutExpired(limit: number, now: Date): Promise<readonly string[]> {
    const expired = await this.database.courseExerciseSubmission.findMany({
      where: { status: 'RUNNING', deadlineAt: { lte: now } },
      orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, executionVersion: true },
    })
    const completed: string[] = []
    for (const submission of expired) {
      const result = await this.recordFailure(
        submission.id,
        submission.executionVersion,
        'RUN_DEADLINE_EXCEEDED',
        now,
      )
      if (result.status === 'RECORDED') completed.push(submission.id)
    }
    return completed
  }
}
