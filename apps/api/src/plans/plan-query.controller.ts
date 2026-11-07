import {
  planDetailResponseSchema,
  taskDetailResponseSchema,
  todayTasksResponseSchema,
  workspaceEntryResponseSchema,
  type PlanDetailResponse,
  type TaskDetailResponse,
  type TodayTasksResponse,
} from '@knowledgeops/contracts'
import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common'

import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import { PlanNotFoundError, TaskNotFoundError } from './plan-lifecycle.errors.js'
import { PlanQueryService } from './plan-query.service.js'

@Controller()
export class PlanQueryController {
  constructor(
    @Inject(PlanQueryService)
    private readonly queries: PlanQueryService,
    @Inject(CURRENT_ACTOR) private readonly currentActor: CurrentActor,
  ) {}

  @Get('workspace/entry')
  async getWorkspaceEntry() {
    return workspaceEntryResponseSchema.parse(
      await this.queries.getWorkspaceEntry(this.currentActor.userId),
    )
  }

  @Get('plans/:planId')
  async getPlan(
    @Param('planId', new ParseUUIDPipe({ version: '4' })) planId: string,
  ): Promise<PlanDetailResponse> {
    try {
      return planDetailResponseSchema.parse(
        await this.queries.getPlan(planId, this.currentActor.userId),
      )
    } catch (error: unknown) {
      this.rethrowNotFound(error)
    }
  }

  @Get('tasks/today')
  async getToday(): Promise<TodayTasksResponse> {
    return todayTasksResponseSchema.parse(await this.queries.getToday(this.currentActor.userId))
  }

  @Get('tasks/:taskId')
  async getTask(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
  ): Promise<TaskDetailResponse> {
    try {
      return taskDetailResponseSchema.parse(
        await this.queries.getTask(taskId, this.currentActor.userId),
      )
    } catch (error: unknown) {
      this.rethrowNotFound(error)
    }
  }

  private rethrowNotFound(error: unknown): never {
    if (error instanceof PlanNotFoundError || error instanceof TaskNotFoundError) {
      throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: error.message })
    }

    throw error
  }
}
