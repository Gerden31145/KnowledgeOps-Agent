import {
  planDetailResponseSchema,
  taskDetailResponseSchema,
  todayTasksResponseSchema,
  type PlanDetailResponse,
  type TaskDetailResponse,
  type TodayTasksResponse,
} from '@knowledgeops/contracts'
import type { DatabaseClient, PlanStatus, TaskState, TaskType } from '@knowledgeops/database'

export interface PlanGraphTask {
  id: string
  title: string
  position: number
  type: TaskType
  state: TaskState
}

export interface PlanGraphStage {
  id: string
  title: string
  position: number
  tasks: PlanGraphTask[]
}

export interface PlanGraph {
  id: string
  version: number
  status: PlanStatus
  stages: PlanGraphStage[]
}

export class PlanRepository {
  constructor(private readonly database: DatabaseClient) {}

  async findGraphByIdForUser(_planId: string, _userId: string): Promise<PlanGraph | null> {
    const plan = await this.database.plan.findFirst({
      where: {
        id: _planId,
        goal: {
          userId: _userId,
        },
      },
      select: {
        id: true,
        version: true,
        stages: {
          orderBy: {
            position: 'asc',
          },
          select: {
            id: true,
            title: true,
            position: true,
            tasks: {
              orderBy: {
                position: 'asc',
              },
              select: {
                id: true,
                title: true,
                position: true,
                type: true,
                state: true,
              },
            },
          },
        },
        status: true,
      },
    })

    return plan
  }

  async findDetailByIdForUser(planId: string, userId: string): Promise<PlanDetailResponse | null> {
    const plan = await this.database.plan.findFirst({
      where: {
        id: planId,
        goal: { userId },
      },
      select: {
        id: true,
        version: true,
        status: true,
        confirmedAt: true,
        goal: {
          select: {
            id: true,
            title: true,
            deadline: true,
            weeklyMinutes: true,
          },
        },
        stages: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            title: true,
            position: true,
            tasks: {
              orderBy: { position: 'asc' },
              select: {
                id: true,
                title: true,
                description: true,
                position: true,
                type: true,
                estimatedMinutes: true,
                suggestedSteps: true,
                targetPath: true,
                state: true,
                version: true,
                prerequisites: { select: { prerequisiteTaskId: true } },
                criteria: {
                  orderBy: { position: 'asc' },
                  select: {
                    id: true,
                    type: true,
                    description: true,
                    required: true,
                    position: true,
                  },
                },
              },
            },
          },
        },
      },
    })

    if (!plan) {
      return null
    }

    return planDetailResponseSchema.parse({
      ...plan,
      confirmedAt: plan.confirmedAt?.toISOString() ?? null,
      goal: {
        ...plan.goal,
        deadline: plan.goal.deadline.toISOString().slice(0, 10),
      },
      stages: plan.stages.map((stage) => ({
        ...stage,
        tasks: stage.tasks.map(({ prerequisites, ...task }) => ({
          ...task,
          prerequisiteTaskIds: prerequisites.map((dependency) => dependency.prerequisiteTaskId),
        })),
      })),
    })
  }

  async findTodayTasksForUser(userId: string): Promise<TodayTasksResponse> {
    const plan = await this.database.plan.findFirst({
      where: {
        status: 'ACTIVE',
        goal: { userId },
      },
      orderBy: { confirmedAt: 'desc' },
      select: {
        id: true,
        status: true,
        stages: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            title: true,
            position: true,
            tasks: {
              where: {
                state: {
                  in: ['READY', 'IN_PROGRESS', 'NEEDS_REVISION', 'NEEDS_EVIDENCE'],
                },
              },
              orderBy: { position: 'asc' },
              select: {
                id: true,
                title: true,
                description: true,
                estimatedMinutes: true,
                targetPath: true,
                state: true,
                updatedAt: true,
              },
            },
          },
        },
      },
    })

    if (!plan) {
      return { plan: null, tasks: [] }
    }

    return todayTasksResponseSchema.parse({
      plan: { id: plan.id, status: plan.status },
      tasks: plan.stages.flatMap((stage) =>
        stage.tasks.map((task) => ({
          ...task,
          planId: plan.id,
          stage: {
            id: stage.id,
            title: stage.title,
            position: stage.position,
          },
          updatedAt: task.updatedAt.toISOString(),
        })),
      ),
    })
  }

  async findTaskDetailForUser(taskId: string, userId: string): Promise<TaskDetailResponse | null> {
    const task = await this.database.task.findFirst({
      where: {
        id: taskId,
        stage: { plan: { goal: { userId } } },
      },
      select: {
        id: true,
        title: true,
        description: true,
        position: true,
        type: true,
        estimatedMinutes: true,
        suggestedSteps: true,
        targetPath: true,
        state: true,
        version: true,
        prerequisites: { select: { prerequisiteTaskId: true } },
        criteria: {
          orderBy: { position: 'asc' },
          select: {
            id: true,
            type: true,
            description: true,
            required: true,
            position: true,
          },
        },
        stage: {
          select: {
            id: true,
            title: true,
            position: true,
            plan: { select: { id: true, status: true } },
          },
        },
        runs: {
          orderBy: { queuedAt: 'desc' },
          select: {
            id: true,
            kind: true,
            status: true,
            errorCode: true,
            queuedAt: true,
            startedAt: true,
            finishedAt: true,
          },
        },
      },
    })

    if (!task) {
      return null
    }

    const { prerequisites, ...taskWithoutPrerequisites } = task

    return taskDetailResponseSchema.parse({
      ...taskWithoutPrerequisites,
      prerequisiteTaskIds: prerequisites.map((dependency) => dependency.prerequisiteTaskId),
      runs: task.runs.map((run) => ({
        ...run,
        queuedAt: run.queuedAt.toISOString(),
        startedAt: run.startedAt?.toISOString() ?? null,
        finishedAt: run.finishedAt?.toISOString() ?? null,
      })),
    })
  }
}
