import {
  isPlanGenerationRunRetryableState,
  planGenerationRunStatusResponseSchema,
  planGenerationRunStateSchema,
  planGenerationRequestedEventPayloadSchema,
  type PlanGenerationModelSnapshot,
  type PlanGenerationRunStatusResponse,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import { randomUUID } from 'node:crypto'

import {
  ActivePlanGenerationRunError,
  InvalidPlanGenerationRetryError,
  LearningGoalNotFoundError,
} from './plan-generation.errors.js'
export interface AcceptPlanGenerationCommand {
  actorUserId: string
  goalId: string
  model: PlanGenerationModelSnapshot
  queuedAt: Date
  deadlineAt: Date
  retryOfRunId?: string
}

export interface AcceptedPlanGeneration {
  generationRunId: string
  status: 'QUEUED'
}

type RunIdFactory = () => string

export class PlanGenerationRepository {
  constructor(
    private readonly database: DatabaseClient,
    private readonly createRunId: RunIdFactory = randomUUID,
  ) {}

  async accept(command: AcceptPlanGenerationCommand): Promise<AcceptedPlanGeneration> {
    const generationRunId = this.createRunId()

    try {
      return await this.database.$transaction(async (transaction) => {
        const goal = await transaction.learningGoal.findFirst({
          where: {
            id: command.goalId,
            userId: command.actorUserId,
          },
          select: {
            id: true,
            userId: true,
          },
        })

        if (!goal) {
          throw new LearningGoalNotFoundError()
        }

        const activeRun = await transaction.planGenerationRun.findFirst({
          where: {
            goalId: goal.id,
            status: {
              in: ['QUEUED', 'RUNNING'],
            },
          },
          select: {
            id: true,
          },
        })

        if (activeRun) {
          throw new ActivePlanGenerationRunError(activeRun.id)
        }

        if (command.retryOfRunId) {
          const retrySource = await transaction.planGenerationRun.findFirst({
            where: {
              id: command.retryOfRunId,
              goalId: goal.id,
            },
            select: {
              status: true,
            },
          })

          if (
            !retrySource ||
            !isPlanGenerationRunRetryableState(
              planGenerationRunStateSchema.parse(retrySource.status),
            )
          ) {
            throw new InvalidPlanGenerationRetryError()
          }
        }

        await transaction.user.update({
          where: {
            id: goal.userId,
          },
          data: {
            preferredModelId: command.model.catalogId,
          },
        })

        await transaction.planGenerationRun.create({
          data: {
            id: generationRunId,
            goalId: goal.id,
            modelCatalogId: command.model.catalogId,
            modelProvider: command.model.provider,
            modelName: command.model.modelName,
            modelReasoningEffort: command.model.reasoningEffort ?? null,
            promptVersion: command.model.promptVersion,
            outputSchemaVersion: command.model.outputSchemaVersion,
            queuedAt: command.queuedAt,
            deadlineAt: command.deadlineAt,
            ...(command.retryOfRunId ? { retryOfRunId: command.retryOfRunId } : {}),
          },
        })

        const payload = planGenerationRequestedEventPayloadSchema.parse({ generationRunId })

        await transaction.outboxEvent.create({
          data: {
            type: 'PLAN_GENERATION_REQUESTED',
            aggregateId: generationRunId,
            deduplicationKey: `plan-generation-requested-${generationRunId}`,
            payload,
            occurredAt: command.queuedAt,
            availableAt: command.queuedAt,
          },
        })

        return {
          generationRunId,
          status: 'QUEUED',
        }
      })
    } catch (error: unknown) {
      if (this.isUniqueConstraintError(error)) {
        const activeRun = await this.database.planGenerationRun.findFirst({
          where: {
            goalId: command.goalId,
            status: {
              in: ['QUEUED', 'RUNNING'],
            },
          },
          select: {
            id: true,
          },
        })

        if (activeRun) {
          throw new ActivePlanGenerationRunError(activeRun.id)
        }
      }

      throw error
    }
  }

  async findStatusForUser(
    generationRunId: string,
    actorUserId: string,
  ): Promise<PlanGenerationRunStatusResponse | null> {
    const run = await this.database.planGenerationRun.findFirst({
      where: {
        id: generationRunId,
        goal: { userId: actorUserId },
      },
      select: {
        id: true,
        goalId: true,
        version: true,
        status: true,
        queuedAt: true,
        startedAt: true,
        finishedAt: true,
        errorCode: true,
        errorMessage: true,
        plan: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    })

    if (!run) {
      return null
    }

    return planGenerationRunStatusResponseSchema.parse({
      generationRunId: run.id,
      goalId: run.goalId,
      version: run.version,
      status: run.status,
      queuedAt: run.queuedAt.toISOString(),
      startedAt: run.startedAt?.toISOString() ?? null,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      error: run.errorCode
        ? {
            code: run.errorCode,
            message: run.errorMessage ?? 'No additional error details were recorded',
          }
        : null,
      plan: run.plan,
    })
  }

  private isUniqueConstraintError(error: unknown): boolean {
    return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002'
  }
}
