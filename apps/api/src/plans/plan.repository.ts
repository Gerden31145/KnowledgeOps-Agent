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
}
