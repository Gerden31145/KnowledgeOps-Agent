import type { PlanGenerationRunStatusResponse } from '@knowledgeops/contracts'

import { PlanGenerationRunNotFoundError } from './plan-generation.errors.js'
import { PlanGenerationRepository } from './plan-generation.repository.js'

export interface GetPlanGenerationRunRequest {
  actorUserId: string
  generationRunId: string
}

export class GetPlanGenerationRunService {
  constructor(private readonly repository: PlanGenerationRepository) {}

  async execute(request: GetPlanGenerationRunRequest): Promise<PlanGenerationRunStatusResponse> {
    const run = await this.repository.findStatusForUser(
      request.generationRunId,
      request.actorUserId,
    )

    if (!run) {
      throw new PlanGenerationRunNotFoundError()
    }

    return run
  }
}
