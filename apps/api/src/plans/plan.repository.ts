import {
  CURRENT_TASK_STATES,
  contentMinimumConfigSchema,
  planDetailResponseSchema,
  sectionPresentConfigSchema,
  taskDetailResponseSchema,
  todayTasksResponseSchema,
  type AcceptanceCriterionSummary,
  type PlanDetailResponse,
  type TaskDetailResponse,
  type TodayTasksResponse,
  type WorkspaceEntryResponse,
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

  async findWorkspaceEntryForUser(userId: string): Promise<WorkspaceEntryResponse> {
    const active = await this.database.plan.findFirst({
      where: { status: 'ACTIVE', goal: { userId } },
      orderBy: [{ confirmedAt: 'desc' }, { id: 'desc' }],
      select: { id: true },
    })
    if (active) return { planId: active.id, runId: null, modelId: null, goal: null }
    const goal = await this.database.learningGoal.findFirst({
      where: { userId },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        title: true,
        currentLevel: true,
        deadline: true,
        weeklyMinutes: true,
        planGenerationRuns: {
          orderBy: [{ queuedAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { id: true, modelCatalogId: true },
        },
        plans: { orderBy: [{ version: 'desc' }], take: 1, select: { id: true } },
      },
    })
    if (!goal) return { planId: null, runId: null, modelId: null, goal: null }
    const { planGenerationRuns, plans, ...input } = goal
    const run = planGenerationRuns[0]
    return {
      planId: run ? null : (plans[0]?.id ?? null),
      runId: run?.id ?? null,
      modelId: run?.modelCatalogId ?? null,
      goal: { ...input, deadline: input.deadline.toISOString().slice(0, 10) },
    }
  }

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
                    config: true,
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
          criteria: task.criteria.map(summarizeCriterion),
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
                  in: ['READY', ...CURRENT_TASK_STATES],
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
            config: true,
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
      criteria: task.criteria.map(summarizeCriterion),
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

// 与检查器使用同一参数校验；历史缺参标准只展示限制，不从 description 猜条件。
function summarizeCriterion({
  config,
  ...criterion
}: Omit<AcceptanceCriterionSummary, 'parameterDescription'> & {
  config: unknown
}): AcceptanceCriterionSummary {
  let parameterDescription: string | null = null
  const unavailable = '当前标准缺少有效的检查条件，暂时无法自动判定此项。'

  if (criterion.type === 'SECTION_PRESENT') {
    const parsed = sectionPresentConfigSchema.safeParse(config)
    parameterDescription = parsed.success
      ? `实际检查：文档中须有标题“${parsed.data.heading}”，标题文字精确匹配、区分大小写；代码块、引用块和列表内的标题不计入。`
      : unavailable
  } else if (criterion.type === 'CONTENT_MINIMUM') {
    const parsed = contentMinimumConfigSchema.safeParse(config)
    parameterDescription = parsed.success
      ? `实际检查：正文与代码合计至少 ${parsed.data.minCharacters} 个非空白字符；按 Unicode 码点计数，不计标题、HTML、图片替代文字和链接目标地址。`
      : unavailable
  }

  return { ...criterion, parameterDescription }
}
