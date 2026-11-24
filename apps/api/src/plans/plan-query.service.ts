import type {
  PlanDetailResponse,
  TaskDetailResponse,
  TaskSummaryResponse,
  TodayTasksResponse,
} from '@knowledgeops/contracts'

import { PlanNotFoundError, TaskNotFoundError } from './plan-lifecycle.errors.js'
import { PlanRepository } from './plan.repository.js'

export class PlanQueryService {
  constructor(private readonly repository: PlanRepository) {}

  getWorkspaceEntry(actorUserId: string) {
    return this.repository.findWorkspaceEntryForUser(actorUserId)
  }

  async getPlan(planId: string, actorUserId: string): Promise<PlanDetailResponse> {
    const plan = await this.repository.findDetailByIdForUser(planId, actorUserId)

    if (!plan) {
      throw new PlanNotFoundError()
    }

    return plan
  }

  async getToday(actorUserId: string): Promise<TodayTasksResponse> {
    return this.repository.findTodayTasksForUser(actorUserId)
  }

  async getTask(taskId: string, actorUserId: string): Promise<TaskDetailResponse> {
    const task = await this.repository.findTaskDetailForUser(taskId, actorUserId)

    if (!task) {
      throw new TaskNotFoundError()
    }

    return task
  }

  async getTaskSummary(taskId: string, actorUserId: string): Promise<TaskSummaryResponse> {
    const task = await this.repository.findTaskSummaryForUser(taskId, actorUserId)

    if (!task) {
      throw new TaskNotFoundError()
    }

    return task
  }
}
