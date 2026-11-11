import {
  CURRENT_TASK_STATES,
  type ConfirmPlanResponse,
  type StartTaskInput,
  type StartTaskResponse,
} from '@knowledgeops/contracts'
import { Prisma, type DatabaseClient } from '@knowledgeops/database'
import { requestCourseGenerationForTask } from '../courses/course-generation.repository.js'

import {
  AnotherActivePlanError,
  AnotherTaskInProgressError,
  InvalidPlanLifecycleStateError,
  PlanNotFoundError,
  TaskNotFoundError,
  TaskTargetPathConflictError,
  TaskTargetPathRequiredError,
} from './plan-lifecycle.errors.js'

type Clock = () => Date

export class PlanLifecycleRepository {
  constructor(
    private readonly database: DatabaseClient,
    private readonly clock: Clock = () => new Date(),
    private readonly courseGenerationTimeoutMs = 180_000,
  ) {}

  async confirmPlan(planId: string, actorUserId: string): Promise<ConfirmPlanResponse> {
    return this.database.$transaction(async (transaction) => {
      await lockActor(transaction, actorUserId)

      const plan = await transaction.plan.findFirst({
        where: {
          id: planId,
          goal: { userId: actorUserId },
        },
        select: {
          id: true,
          status: true,
          confirmedAt: true,
        },
      })

      if (!plan) {
        throw new PlanNotFoundError()
      }

      if (plan.status === 'ACTIVE') {
        if (!plan.confirmedAt) {
          throw new InvalidPlanLifecycleStateError('Active plan is missing confirmedAt')
        }

        return this.readConfirmedPlan(transaction, plan.id, plan.confirmedAt)
      }

      if (plan.status !== 'DRAFT') {
        throw new InvalidPlanLifecycleStateError(
          `Only a draft plan can be confirmed; current status is ${plan.status}`,
        )
      }

      const anotherActivePlan = await transaction.plan.findFirst({
        where: {
          id: { not: plan.id },
          status: 'ACTIVE',
          goal: { userId: actorUserId },
        },
        select: { id: true },
      })

      if (anotherActivePlan) {
        throw new AnotherActivePlanError(anotherActivePlan.id)
      }

      const confirmedAt = this.clock()
      const updated = await transaction.plan.updateMany({
        where: { id: plan.id, status: 'DRAFT' },
        data: {
          status: 'ACTIVE',
          confirmedAt,
        },
      })

      if (updated.count !== 1) {
        throw new InvalidPlanLifecycleStateError('Plan state changed while it was being confirmed')
      }

      await transaction.task.updateMany({
        where: {
          stage: { planId: plan.id },
          state: 'BLOCKED',
          prerequisites: { none: {} },
        },
        data: {
          state: 'READY',
          version: { increment: 1 },
        },
      })
      const initialCourses = await transaction.task.findMany({
        where: { stage: { planId: plan.id }, state: 'READY', type: 'COURSE' },
        select: { id: true },
      })
      for (const task of initialCourses)
        await requestCourseGenerationForTask(
          transaction,
          task.id,
          confirmedAt,
          this.courseGenerationTimeoutMs,
        )

      return this.readConfirmedPlan(transaction, plan.id, confirmedAt)
    })
  }

  async startTask(
    taskId: string,
    actorUserId: string,
    input: StartTaskInput,
  ): Promise<StartTaskResponse> {
    return this.database.$transaction(async (transaction) => {
      await lockActor(transaction, actorUserId)

      const task = await transaction.task.findFirst({
        where: {
          id: taskId,
          stage: { plan: { goal: { userId: actorUserId } } },
        },
        select: {
          id: true,
          state: true,
          version: true,
          targetPath: true,
          type: true,
          course: { select: { status: true } },
          stage: {
            select: {
              plan: { select: { status: true } },
            },
          },
        },
      })

      if (!task) {
        throw new TaskNotFoundError()
      }

      if (task.stage.plan.status !== 'ACTIVE') {
        throw new InvalidPlanLifecycleStateError('Only a task in the active plan can be started')
      }

      if (task.state === 'IN_PROGRESS') {
        if (task.type === 'COURSE') {
          if (input.targetPath) throw new TaskTargetPathConflictError()
        } else {
          if (input.targetPath && input.targetPath !== task.targetPath)
            throw new TaskTargetPathConflictError()
          if (!task.targetPath) throw new TaskTargetPathRequiredError()
        }

        return {
          taskId: task.id,
          state: 'IN_PROGRESS',
          version: task.version,
          targetPath: task.targetPath,
        }
      }

      if (task.state !== 'READY') {
        throw new InvalidPlanLifecycleStateError(
          `Only a ready task can be started; current state is ${task.state}`,
        )
      }

      if (task.type === 'COURSE' && task.course?.status !== 'READY')
        throw new InvalidPlanLifecycleStateError('The course learning package is not ready')

      const targetPath = task.type === 'COURSE' ? null : (input.targetPath ?? task.targetPath)

      if (task.type !== 'COURSE' && !targetPath) {
        throw new TaskTargetPathRequiredError()
      }

      const occupiedSlot = await transaction.task.findFirst({
        where: {
          id: { not: task.id },
          state: { in: [...CURRENT_TASK_STATES] },
          stage: { plan: { status: 'ACTIVE', goal: { userId: actorUserId } } },
        },
        select: { id: true },
      })

      if (occupiedSlot) {
        throw new AnotherTaskInProgressError(occupiedSlot.id)
      }

      const updated = await transaction.task.updateMany({
        where: {
          id: task.id,
          state: 'READY',
          version: task.version,
        },
        data: {
          state: 'IN_PROGRESS',
          targetPath,
          version: { increment: 1 },
        },
      })

      if (updated.count !== 1) {
        throw new InvalidPlanLifecycleStateError('Task state changed while it was being started')
      }

      return {
        taskId: task.id,
        state: 'IN_PROGRESS',
        version: task.version + 1,
        targetPath,
      }
    })
  }

  private async readConfirmedPlan(
    transaction: Prisma.TransactionClient,
    planId: string,
    confirmedAt: Date,
  ): Promise<ConfirmPlanResponse> {
    const stages = await transaction.stage.findMany({
      where: { planId },
      orderBy: { position: 'asc' },
      select: {
        tasks: {
          where: { state: 'READY' },
          orderBy: { position: 'asc' },
          select: { id: true },
        },
      },
    })

    return {
      planId,
      status: 'ACTIVE',
      confirmedAt: confirmedAt.toISOString(),
      readyTaskIds: stages.flatMap((stage) => stage.tasks.map((task) => task.id)),
    }
  }
}

async function lockActor(
  transaction: Prisma.TransactionClient,
  actorUserId: string,
): Promise<void> {
  await transaction.$queryRaw(Prisma.sql`
    SELECT "id"
    FROM "users"
    WHERE "id" = ${actorUserId}::uuid
    FOR UPDATE
  `)
}
