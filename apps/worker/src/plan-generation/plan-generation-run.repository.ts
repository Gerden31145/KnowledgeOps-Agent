import { planGenerationRequestSchema, type PlanGenerationRequest } from '@knowledgeops/agent-core'
import {
  isPlanGenerationRunTerminalState,
  planGenerationRunStateSchema,
  type PlanGenerationRunState,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'

const DEADLINE_ERROR_CODE = 'RUN_DEADLINE_EXCEEDED'
const DEADLINE_ERROR_MESSAGE = 'Plan generation exceeded its persisted deadline'

export interface ClaimedPlanGenerationRun {
  deadlineAt: Date
  expectedVersion: number
  generationRunId: string
  goalId: string
  request: PlanGenerationRequest
}

export type ClaimPlanGenerationRunResult =
  | { status: 'CLAIMED'; run: ClaimedPlanGenerationRun }
  | { status: 'NOT_FOUND' }
  | {
      status: 'SKIPPED'
      planId: string | null
      reason: 'CONCURRENT_EXECUTION' | 'TERMINAL'
      runStatus: PlanGenerationRunState
    }
  | { status: 'FAILED' }
  | { status: 'TIMED_OUT' }

export interface PlanGenerationRunFailure {
  code: string
  message: string
  status: 'FAILED' | 'TIMED_OUT'
}

export type RecordPlanGenerationRunFailureResult =
  | { status: 'RECORDED'; runStatus: 'FAILED' | 'TIMED_OUT' }
  | {
      status: 'SKIPPED'
      planId: string | null
      runStatus: PlanGenerationRunState
    }

interface TimedOutRunRow {
  id: string
}

export class PlanGenerationRunRepository {
  constructor(private readonly database: DatabaseClient) {}

  async claimForExecution(
    generationRunId: string,
    now: Date,
  ): Promise<ClaimPlanGenerationRunResult> {
    const run = await this.database.planGenerationRun.findUnique({
      where: { id: generationRunId },
      select: {
        id: true,
        status: true,
        version: true,
        deadlineAt: true,
        queuedAt: true,
        startedAt: true,
        modelCatalogId: true,
        modelProvider: true,
        modelName: true,
        modelReasoningEffort: true,
        promptVersion: true,
        outputSchemaVersion: true,
        plan: { select: { id: true } },
        goal: {
          select: {
            id: true,
            title: true,
            currentLevel: true,
            deadline: true,
            weeklyMinutes: true,
            user: { select: { timezone: true } },
          },
        },
      },
    })

    if (!run) {
      return { status: 'NOT_FOUND' }
    }

    const runStatus = planGenerationRunStateSchema.parse(run.status)

    if (isPlanGenerationRunTerminalState(runStatus)) {
      return {
        status: 'SKIPPED',
        reason: 'TERMINAL',
        runStatus,
        planId: run.plan?.id ?? null,
      }
    }

    if (run.deadlineAt.getTime() <= now.getTime()) {
      const timedOut = await this.database.planGenerationRun.updateMany({
        where: {
          id: run.id,
          status: { in: ['QUEUED', 'RUNNING'] },
          version: run.version,
          deadlineAt: { lte: now },
        },
        data: {
          status: 'TIMED_OUT',
          errorCode: DEADLINE_ERROR_CODE,
          errorMessage: DEADLINE_ERROR_MESSAGE,
          finishedAt: now,
          version: { increment: 1 },
        },
      })

      if (timedOut.count === 1) {
        return { status: 'TIMED_OUT' }
      }

      return this.readSkippedAfterLostRace(run.id)
    }

    let request: PlanGenerationRequest

    try {
      request = planGenerationRequestSchema.parse({
        generationRunId: run.id,
        model: {
          catalogId: run.modelCatalogId,
          provider: run.modelProvider,
          modelName: run.modelName,
          ...(run.modelReasoningEffort ? { reasoningEffort: run.modelReasoningEffort } : {}),
          promptVersion: run.promptVersion,
          outputSchemaVersion: run.outputSchemaVersion,
        },
        goal: {
          title: run.goal.title,
          currentLevel: run.goal.currentLevel,
          today: toIsoDateInTimeZone(run.queuedAt, run.goal.user.timezone),
          deadline: run.goal.deadline.toISOString().slice(0, 10),
          weeklyMinutes: run.goal.weeklyMinutes,
        },
      })
    } catch {
      const failed = await this.database.planGenerationRun.updateMany({
        where: {
          id: run.id,
          status: { in: ['QUEUED', 'RUNNING'] },
          version: run.version,
        },
        data: {
          status: 'FAILED',
          errorCode: 'PLAN_GENERATION_REQUEST_INVALID',
          errorMessage: 'Persisted plan generation input does not satisfy the business contract',
          finishedAt: now,
          version: { increment: 1 },
        },
      })

      if (failed.count === 1) {
        return { status: 'FAILED' }
      }

      return this.readSkippedAfterLostRace(run.id)
    }

    const claimed = await this.database.planGenerationRun.updateMany({
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
      return this.readSkippedAfterLostRace(run.id)
    }

    return {
      status: 'CLAIMED',
      run: {
        deadlineAt: run.deadlineAt,
        expectedVersion: run.version + 1,
        generationRunId: run.id,
        goalId: run.goal.id,
        request,
      },
    }
  }

  async recordFailure(
    generationRunId: string,
    expectedVersion: number,
    failure: PlanGenerationRunFailure,
    finishedAt: Date,
  ): Promise<RecordPlanGenerationRunFailureResult> {
    const updated = await this.database.planGenerationRun.updateMany({
      where: {
        id: generationRunId,
        status: 'RUNNING',
        version: expectedVersion,
      },
      data: {
        status: failure.status,
        errorCode: failure.code.slice(0, 64),
        errorMessage: sanitizePlanGenerationErrorMessage(failure.message),
        finishedAt,
        version: { increment: 1 },
      },
    })

    if (updated.count === 1) {
      return { status: 'RECORDED', runStatus: failure.status }
    }

    const skipped = await this.readCurrentState(generationRunId)

    if (!skipped) {
      return { status: 'SKIPPED', runStatus: 'FAILED', planId: null }
    }

    return { status: 'SKIPPED', ...skipped }
  }

  async timeoutExpired(limit: number, now: Date): Promise<readonly string[]> {
    const rows = await this.database.$queryRaw<TimedOutRunRow[]>(Prisma.sql`
      WITH expired AS (
        SELECT "id"
        FROM "plan_generation_runs"
        WHERE "status" IN ('QUEUED'::"PlanGenerationRunState", 'RUNNING'::"PlanGenerationRunState")
          AND "deadline_at" <= ${now}
        ORDER BY "deadline_at" ASC, "id" ASC
        FOR UPDATE SKIP LOCKED
        LIMIT ${limit}
      )
      UPDATE "plan_generation_runs" AS run
      SET
        "status" = 'TIMED_OUT'::"PlanGenerationRunState",
        "error_code" = ${DEADLINE_ERROR_CODE},
        "error_message" = ${DEADLINE_ERROR_MESSAGE},
        "finished_at" = ${now},
        "updated_at" = ${now},
        "version" = run."version" + 1
      FROM expired
      WHERE run."id" = expired."id"
      RETURNING run."id"
    `)

    return rows.map((row) => row.id)
  }

  private async readSkippedAfterLostRace(
    generationRunId: string,
  ): Promise<ClaimPlanGenerationRunResult> {
    const current = await this.readCurrentState(generationRunId)

    if (!current) {
      return { status: 'NOT_FOUND' }
    }

    return {
      status: 'SKIPPED',
      reason: isPlanGenerationRunTerminalState(current.runStatus)
        ? 'TERMINAL'
        : 'CONCURRENT_EXECUTION',
      ...current,
    }
  }

  private async readCurrentState(
    generationRunId: string,
  ): Promise<{ planId: string | null; runStatus: PlanGenerationRunState } | null> {
    const current = await this.database.planGenerationRun.findUnique({
      where: { id: generationRunId },
      select: {
        status: true,
        plan: { select: { id: true } },
      },
    })

    if (!current) {
      return null
    }

    return {
      runStatus: planGenerationRunStateSchema.parse(current.status),
      planId: current.plan?.id ?? null,
    }
  }
}

export function sanitizePlanGenerationErrorMessage(message: string): string {
  return message
    .replace(/([a-z][a-z\d+.-]*:\/\/)(?:[^\s/@]+(?::[^\s/@]*)?@)/gi, '$1[REDACTED]@')
    .replace(/\b(?:sk|key)-[a-z\d_-]{12,}\b/gi, '[REDACTED]')
    .slice(0, 500)
}

function toIsoDateInTimeZone(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    day: '2-digit',
    month: '2-digit',
    timeZone,
    year: 'numeric',
  }).formatToParts(date)
  const values = new Map(parts.map((part) => [part.type, part.value]))

  return `${values.get('year')}-${values.get('month')}-${values.get('day')}`
}
