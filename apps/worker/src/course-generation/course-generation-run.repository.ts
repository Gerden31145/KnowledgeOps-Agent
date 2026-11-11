import {
  courseGenerationRequestSchema,
  type CourseGenerationRequest,
} from '@knowledgeops/agent-core'
import {
  isPlanGenerationRunTerminalState,
  type PlanGenerationRunState,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'

export interface ClaimedCourseGenerationRun {
  deadlineAt: Date
  expectedVersion: number
  generationRunId: string
  request: CourseGenerationRequest
}

export type ClaimCourseGenerationRunResult =
  | { status: 'CLAIMED'; run: ClaimedCourseGenerationRun }
  | { status: 'NOT_FOUND' }
  | {
      status: 'SKIPPED'
      reason: 'CONCURRENT_EXECUTION' | 'TERMINAL'
      runStatus: PlanGenerationRunState
    }
  | { status: 'FAILED' | 'TIMED_OUT' }

export interface CourseGenerationRunFailure {
  code: string
  message: string
  status: 'FAILED' | 'TIMED_OUT'
}

export class CourseGenerationRunRepository {
  constructor(private readonly database: DatabaseClient) {}

  async claimForExecution(
    generationRunId: string,
    now: Date,
  ): Promise<ClaimCourseGenerationRunResult> {
    const run = await this.database.courseGenerationRun.findUnique({
      where: { id: generationRunId },
      select: {
        id: true,
        status: true,
        version: true,
        deadlineAt: true,
        startedAt: true,
        modelCatalogId: true,
        modelProvider: true,
        modelName: true,
        modelReasoningEffort: true,
        promptVersion: true,
        outputSchemaVersion: true,
        profileSnapshot: true,
        course: {
          select: {
            status: true,
            task: {
              select: {
                id: true,
                title: true,
                description: true,
                estimatedMinutes: true,
                state: true,
                stage: {
                  select: {
                    plan: {
                      select: {
                        status: true,
                        goal: { select: { title: true, currentLevel: true } },
                      },
                    },
                  },
                },
              },
            },
            knowledge: {
              where: { role: 'TEACH' },
              select: {
                knowledgePoint: { select: { key: true, title: true, description: true } },
              },
            },
          },
        },
      },
    })
    if (!run) return { status: 'NOT_FOUND' }
    if (isPlanGenerationRunTerminalState(run.status))
      return { status: 'SKIPPED', reason: 'TERMINAL', runStatus: run.status }
    if (run.deadlineAt <= now) {
      await this.recordFailure(
        run.id,
        run.version,
        {
          code: 'RUN_DEADLINE_EXCEEDED',
          message: 'Course generation exceeded its persisted deadline',
          status: 'TIMED_OUT',
        },
        now,
        true,
      )
      return { status: 'TIMED_OUT' }
    }

    let request: CourseGenerationRequest
    try {
      request = courseGenerationRequestSchema.parse({
        generationRunId: run.id,
        model: {
          catalogId: run.modelCatalogId,
          provider: run.modelProvider,
          modelName: run.modelName,
          ...(run.modelReasoningEffort ? { reasoningEffort: run.modelReasoningEffort } : {}),
          promptVersion: run.promptVersion,
          outputSchemaVersion: run.outputSchemaVersion,
        },
        goal: run.course.task.stage.plan.goal,
        course: {
          taskId: run.course.task.id,
          title: run.course.task.title,
          description: run.course.task.description,
          estimatedMinutes: run.course.task.estimatedMinutes,
          knowledgePoints: run.course.knowledge.map(({ knowledgePoint }) => ({
            id: knowledgePoint.key,
            title: knowledgePoint.title,
            description: knowledgePoint.description,
          })),
        },
        review: run.profileSnapshot,
      })
      if (
        run.course.task.state !== 'READY' ||
        run.course.task.stage.plan.status !== 'ACTIVE' ||
        !['PENDING', 'GENERATING', 'FAILED'].includes(run.course.status)
      )
        throw new Error('Course is not eligible for generation')
    } catch {
      await this.recordFailure(
        run.id,
        run.version,
        {
          code: 'COURSE_GENERATION_REQUEST_INVALID',
          message: 'Persisted course generation input is invalid or no longer eligible',
          status: 'FAILED',
        },
        now,
        true,
      )
      return { status: 'FAILED' }
    }

    const claimed = await this.database.courseGenerationRun.updateMany({
      where: {
        id: run.id,
        status: run.status,
        version: run.version,
        deadlineAt: { gt: now },
      },
      data: {
        status: 'RUNNING',
        startedAt: run.startedAt ?? now,
        errorCode: null,
        errorMessage: null,
        version: { increment: 1 },
      },
    })
    if (claimed.count !== 1) {
      const current = await this.database.courseGenerationRun.findUnique({
        where: { id: run.id },
        select: { status: true },
      })
      if (!current) return { status: 'NOT_FOUND' }
      return {
        status: 'SKIPPED',
        reason: isPlanGenerationRunTerminalState(current.status)
          ? 'TERMINAL'
          : 'CONCURRENT_EXECUTION',
        runStatus: current.status,
      }
    }

    return {
      status: 'CLAIMED',
      run: {
        deadlineAt: run.deadlineAt,
        expectedVersion: run.version + 1,
        generationRunId: run.id,
        request,
      },
    }
  }

  async recordFailure(
    generationRunId: string,
    expectedVersion: number,
    failure: CourseGenerationRunFailure,
    finishedAt: Date,
    allowQueued = false,
  ): Promise<{ status: 'RECORDED' | 'SKIPPED'; runStatus: PlanGenerationRunState }> {
    const result = await this.database.$transaction(async (tx) => {
      const updated = await tx.courseGenerationRun.updateMany({
        where: {
          id: generationRunId,
          status: allowQueued ? { in: ['QUEUED', 'RUNNING'] } : 'RUNNING',
          version: expectedVersion,
        },
        data: {
          status: failure.status,
          errorCode: failure.code.slice(0, 64),
          errorMessage: failure.message.slice(0, 500),
          finishedAt,
          version: { increment: 1 },
        },
      })
      if (updated.count === 1) {
        await tx.courseGenerationRun.update({
          where: { id: generationRunId },
          data: { course: { update: { status: 'FAILED' } } },
        })
        return { status: 'RECORDED' as const, runStatus: failure.status }
      }
      const current = await tx.courseGenerationRun.findUnique({
        where: { id: generationRunId },
        select: { status: true },
      })
      return {
        status: 'SKIPPED' as const,
        runStatus: current?.status ?? ('FAILED' as const),
      }
    })
    return result
  }

  async timeoutExpired(limit: number, now: Date): Promise<readonly string[]> {
    const expired = await this.database.courseGenerationRun.findMany({
      where: { status: { in: ['QUEUED', 'RUNNING'] }, deadlineAt: { lte: now } },
      orderBy: [{ deadlineAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, version: true },
    })
    const completed: string[] = []
    for (const run of expired) {
      const result = await this.recordFailure(
        run.id,
        run.version,
        {
          code: 'RUN_DEADLINE_EXCEEDED',
          message: 'Course generation exceeded its persisted deadline',
          status: 'TIMED_OUT',
        },
        now,
        true,
      )
      if (result.status === 'RECORDED') completed.push(run.id)
    }
    return completed
  }
}

export function json(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue
}
