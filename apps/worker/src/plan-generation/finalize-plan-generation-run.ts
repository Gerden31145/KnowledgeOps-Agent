import type { PlanGenerationOutput } from '@knowledgeops/agent-core'
import type { PlanGenerationRunState } from '@knowledgeops/contracts'
import type { DatabaseClient } from '@knowledgeops/database'

export interface FinalizePlanGenerationRunCommand {
  candidate: PlanGenerationOutput
  expectedRunVersion: number
  finishedAt: Date
  generationRunId: string
  goalId: string
}

type generationRunQuery = {
  status: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT'
  version: number
}

export type FinalizePlanGenerationRunResult =
  | {
      status: 'FINALIZED'
      planId: string
    }
  | {
      status: 'SKIPPED'
      planId: string | null
      runStatus: PlanGenerationRunState
    }

export interface PlanGenerationSuccessFinalizer {
  execute(command: FinalizePlanGenerationRunCommand): Promise<FinalizePlanGenerationRunResult>
}

export const PLAN_GENERATION_SUCCESS_FINALIZER = Symbol('PLAN_GENERATION_SUCCESS_FINALIZER')

export class PlanGenerationSuccessFinalizerNotImplementedError extends Error {
  override readonly name = 'PlanGenerationSuccessFinalizerNotImplementedError'

  constructor() {
    super('Stage 2 core handwrite: atomic plan generation finalizer is not implemented yet')
  }
}

/**
 * The interface and black-box acceptance are prepared on day 08-10. The
 * transaction body remains the independent Stage 2 core handwrite task.
 */
export class FinalizePlanGenerationRun implements PlanGenerationSuccessFinalizer {
  constructor(private readonly database: DatabaseClient) {}

  async execute(
    command: FinalizePlanGenerationRunCommand,
  ): Promise<FinalizePlanGenerationRunResult> {
    // 首先判断合法性
    const run = await this.database.planGenerationRun.findUnique({
      where: {
        id: command.generationRunId,
      },
    })

    if (!run) throw new Error('Run不存在')

    if (run.goalId !== command.goalId) throw new Error('goalID与run绑定不一致')

    if (
      run.deadlineAt <= command.finishedAt ||
      run.version !== command.expectedRunVersion ||
      run.status !== 'RUNNING'
    ) {
      const existedPlan = await this.database.plan.findUnique({
        where: {
          generationRunId: command.generationRunId,
        },
      })
      return {
        status: 'SKIPPED',
        planId: existedPlan ? existedPlan.id : null,
        runStatus: run ? run.status : 'FAILED',
      }
    }

    let isFinalized = false
    const finalizer = await this.database.$transaction(
      async (
        tx,
      ): Promise<{
        runStatus: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT'
        isFinalized: boolean
        planId: string | null
      }> => {
        const [CocurrentRun] = await tx.$queryRaw<generationRunQuery[]>`
        SELECT *
        FROM "plan_generation_runs"
        WHERE "id" = ${command.generationRunId}
        FOR UPDATE
        `

        if (!CocurrentRun) throw new Error('run状态不存在')

        const oldPlan = await tx.plan.findFirst({
          where: {
            goalId: command.goalId,
          },
          orderBy: {
            version: 'desc',
          },
        })

        // Run已过期
        if (CocurrentRun.version !== command.expectedRunVersion) {
          const currentPlan = await tx.plan.findUnique({
            where: {
              generationRunId: command.generationRunId,
            },
          })
          return {
            isFinalized,
            runStatus: CocurrentRun.status,
            planId: currentPlan ? currentPlan.id : null,
          }
        }

        const plan = await tx.plan.create({
          data: {
            goalId: command.goalId,
            generationRunId: command.generationRunId,
            version: oldPlan ? oldPlan.version + 1 : 1,
            status: 'DRAFT',
            confirmedAt: null,
          },
        })

        const taskMap = new Map<string, string>()
        for (const [index, stage] of command.candidate.stages.entries()) {
          const stageResult = await tx.stage.create({
            data: {
              planId: plan.id,
              title: stage.title,
              position: index,
            },
          })

          for (const [index, task] of stage.tasks.entries()) {
            const taskResult = await tx.task.create({
              data: {
                stageId: stageResult.id,
                title: task.title,
                position: index,
                type: 'MARKDOWN_NOTE',
                estimatedMinutes: task.estimatedMinutes,
                suggestedSteps: task.suggestedSteps,
                targetPath: task.targetPath,
                state: 'BLOCKED',
                version: 0,
                description: task.description,
              },
            })
            taskMap.set(task.id, taskResult.id)

            for (const [index, criteria] of task.acceptanceCriteria.entries()) {
              await tx.acceptanceCriterion.create({
                data: {
                  taskId: taskResult.id,
                  type: criteria.type,
                  description: criteria.description,
                  required: criteria.required,
                  ...(criteria.config === null ? {} : { config: criteria.config }),
                  position: index,
                },
              })
            }
          }
        }

        for (const [, stage] of command.candidate.stages.entries()) {
          for (const [, task] of stage.tasks.entries()) {
            for (const [, dep] of task.dependsOnTaskIds.entries()) {
              const preId = taskMap.get(dep)
              const taskId = taskMap.get(task.id)
              if (!preId || !taskId) throw new Error('任务id映射错误')
              await tx.taskDependency.create({
                data: {
                  taskId,
                  prerequisiteTaskId: preId,
                },
              })
            }
          }
        }

        await tx.planGenerationRun.update({
          data: {
            status: 'SUCCEEDED',
            version: { increment: 1 },
            errorCode: null,
            errorMessage: null,
            finishedAt: command.finishedAt,
          },
          where: {
            id: command.generationRunId,
          },
        })

        isFinalized = Boolean(plan)
        return {
          runStatus: CocurrentRun.status,
          isFinalized,
          planId: plan.id,
        }
      },
    )
    if (!isFinalized) {
      return {
        status: 'SKIPPED',
        planId: finalizer.planId,
        runStatus: finalizer.runStatus,
      }
    } else {
      return {
        status: 'FINALIZED',
        planId: finalizer.planId!,
      }
    }
  }
}
