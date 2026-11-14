import {
  COURSE_QUESTION_POLICIES,
  courseQuestionRequestSchema,
  type CourseQuestionRequest,
} from '@knowledgeops/agent-core'
import { courseSectionSchema, type CourseQuestionStatus } from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'
import { z } from 'zod'

const courseContentSchema = z.object({ sections: z.array(courseSectionSchema) }).strict()

export interface ClaimedCourseQuestion {
  deadlineAt: Date
  expectedVersion: number
  questionId: string
  request: CourseQuestionRequest
}

export type ClaimCourseQuestionResult =
  | { status: 'CLAIMED'; question: ClaimedCourseQuestion }
  | { status: 'NOT_FOUND' }
  | { status: 'FAILED' }
  | {
      status: 'SKIPPED'
      reason: 'CONCURRENT_EXECUTION' | 'TERMINAL'
      questionStatus: CourseQuestionStatus
    }

export type CourseQuestionWriteResult =
  | { status: 'RECORDED'; questionStatus: 'SUCCEEDED' | 'FAILED' }
  | { status: 'SKIPPED'; questionStatus: CourseQuestionStatus }

export class CourseQuestionExecutionRepository {
  constructor(private readonly database: DatabaseClient) {}

  async claimForExecution(
    questionId: string,
    now: Date,
    timeoutMs: number,
  ): Promise<ClaimCourseQuestionResult> {
    return this.database.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM course_questions WHERE id = ${questionId}::uuid FOR UPDATE`
      const question = await tx.courseQuestion.findUnique({
        where: { id: questionId },
        select: {
          id: true,
          status: true,
          executionVersion: true,
          deadlineAt: true,
          courseVersionId: true,
          userId: true,
          sectionId: true,
          selectedText: true,
          question: true,
          depth: true,
          modelCatalogId: true,
          modelProvider: true,
          modelName: true,
          courseVersion: {
            select: {
              content: true,
              generationRun: { select: { modelReasoningEffort: true } },
              course: {
                select: {
                  task: {
                    select: {
                      title: true,
                      description: true,
                      stage: {
                        select: { plan: { select: { goal: { select: { title: true } } } } },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      })
      if (!question) return { status: 'NOT_FOUND' }
      if (question.status === 'SUCCEEDED' || question.status === 'FAILED')
        return { status: 'SKIPPED', reason: 'TERMINAL', questionStatus: question.status }
      if (question.status === 'RUNNING') {
        if (question.deadlineAt && question.deadlineAt <= now) {
          await tx.courseQuestion.update({
            where: { id: question.id },
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
          questionStatus: question.status,
        }
      }

      let request: CourseQuestionRequest
      try {
        const content = courseContentSchema.parse(question.courseVersion.content)
        const section = content.sections.find((item) => item.id === question.sectionId)
        if (!section) throw new Error('Course question section no longer exists')
        const history = await tx.courseQuestion.findMany({
          where: {
            courseVersionId: question.courseVersionId,
            userId: question.userId,
            status: 'SUCCEEDED',
          },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: COURSE_QUESTION_POLICIES[question.depth].historyLimit,
          select: { question: true, answer: true },
        })
        request = courseQuestionRequestSchema.parse({
          model: {
            catalogId: question.modelCatalogId,
            provider: question.modelProvider,
            modelName: question.modelName,
            reasoningEffort: question.courseVersion.generationRun.modelReasoningEffort,
          },
          goal: question.courseVersion.course.task.stage.plan.goal.title,
          course: {
            title: question.courseVersion.course.task.title,
            description: question.courseVersion.course.task.description,
          },
          section,
          selectedText: question.selectedText,
          question: question.question,
          depth: question.depth,
          history: history
            .reverse()
            .map((item) => ({ question: item.question, answer: item.answer! })),
        })
      } catch {
        await tx.courseQuestion.update({
          where: { id: question.id },
          data: {
            status: 'FAILED',
            errorCode: 'COURSE_QUESTION_REQUEST_INVALID',
            completedAt: now,
            executionVersion: { increment: 1 },
          },
        })
        return { status: 'FAILED' }
      }

      const deadlineAt = new Date(now.getTime() + timeoutMs)
      await tx.courseQuestion.update({
        where: { id: question.id },
        data: {
          status: 'RUNNING',
          deadlineAt,
          executionVersion: { increment: 1 },
          errorCode: null,
          completedAt: null,
        },
      })
      return {
        status: 'CLAIMED',
        question: {
          deadlineAt,
          expectedVersion: question.executionVersion + 1,
          questionId: question.id,
          request,
        },
      }
    })
  }

  async recordSuccess(
    questionId: string,
    expectedVersion: number,
    answer: string,
    completedAt: Date,
  ): Promise<CourseQuestionWriteResult> {
    const updated = await this.database.courseQuestion.updateMany({
      where: {
        id: questionId,
        status: 'RUNNING',
        executionVersion: expectedVersion,
        deadlineAt: { gt: completedAt },
      },
      data: {
        status: 'SUCCEEDED',
        answer,
        completedAt,
        errorCode: null,
        executionVersion: { increment: 1 },
      },
    })
    if (updated.count === 1) return { status: 'RECORDED', questionStatus: 'SUCCEEDED' }
    return this.currentWriteResult(questionId)
  }

  async recordFailure(
    questionId: string,
    expectedVersion: number,
    errorCode: string,
    completedAt: Date,
  ): Promise<CourseQuestionWriteResult> {
    const updated = await this.database.courseQuestion.updateMany({
      where: { id: questionId, status: 'RUNNING', executionVersion: expectedVersion },
      data: {
        status: 'FAILED',
        errorCode: errorCode.slice(0, 64),
        completedAt,
        executionVersion: { increment: 1 },
      },
    })
    if (updated.count === 1) return { status: 'RECORDED', questionStatus: 'FAILED' }
    return this.currentWriteResult(questionId)
  }

  async timeoutExpired(limit: number, now: Date): Promise<readonly string[]> {
    const expired = await this.database.courseQuestion.findMany({
      where: { status: 'RUNNING', deadlineAt: { lte: now } },
      orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, executionVersion: true },
    })
    const completed: string[] = []
    for (const question of expired) {
      const result = await this.recordFailure(
        question.id,
        question.executionVersion,
        'RUN_DEADLINE_EXCEEDED',
        now,
      )
      if (result.status === 'RECORDED') completed.push(question.id)
    }
    return completed
  }

  private async currentWriteResult(questionId: string): Promise<CourseQuestionWriteResult> {
    const current = await this.database.courseQuestion.findUnique({
      where: { id: questionId },
      select: { status: true },
    })
    return {
      status: 'SKIPPED',
      questionStatus: current?.status ?? 'FAILED',
    }
  }
}
