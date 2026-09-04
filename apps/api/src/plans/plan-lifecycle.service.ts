import type {
  ConfirmPlanResponse,
  StartTaskInput,
  StartTaskResponse,
} from '@knowledgeops/contracts'

import { PlanLifecycleRepository } from './plan-lifecycle.repository.js'

export class PlanLifecycleService {
  constructor(private readonly repository: PlanLifecycleRepository) {}

  async confirmPlan(planId: string, actorUserId: string): Promise<ConfirmPlanResponse> {
    return this.repository.confirmPlan(planId, actorUserId)
  }

  async startTask(
    taskId: string,
    actorUserId: string,
    input: StartTaskInput,
  ): Promise<StartTaskResponse> {
    return this.repository.startTask(taskId, actorUserId, input)
  }
}
