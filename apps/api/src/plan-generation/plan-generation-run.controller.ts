import {
  planGenerationRunStatusResponseSchema,
  type PlanGenerationRunStatusResponse,
} from '@knowledgeops/contracts'
import { Controller, Get, Inject, NotFoundException, Param, ParseUUIDPipe } from '@nestjs/common'

import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import {
  GetPlanGenerationRunService,
  type GetPlanGenerationRunRequest,
} from './get-plan-generation-run.service.js'
import { PlanGenerationRunNotFoundError } from './plan-generation.errors.js'

@Controller('plan-generation-runs')
export class PlanGenerationRunController {
  constructor(
    private readonly getPlanGenerationRun: GetPlanGenerationRunService,
    @Inject(CURRENT_ACTOR) private readonly currentActor: CurrentActor,
  ) {}

  @Get(':generationRunId')
  async getStatus(
    @Param('generationRunId', new ParseUUIDPipe({ version: '4' })) generationRunId: string,
  ): Promise<PlanGenerationRunStatusResponse> {
    try {
      const run = await this.getPlanGenerationRun.execute({
        actorUserId: this.currentActor.userId,
        generationRunId,
      } satisfies GetPlanGenerationRunRequest)

      return planGenerationRunStatusResponseSchema.parse(run)
    } catch (error: unknown) {
      if (error instanceof PlanGenerationRunNotFoundError) {
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: error.message })
      }

      throw error
    }
  }
}
