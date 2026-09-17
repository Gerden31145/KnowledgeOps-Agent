import {
  planGenerationRunStatusResponseSchema,
  type PlanGenerationRunStatusResponse,
} from '@knowledgeops/contracts'
import {
  Controller,
  Get,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
} from '@nestjs/common'
import type { ServerResponse } from 'node:http'

import type { AuthRequest } from '../identity/auth-http.js'
import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import {
  GetPlanGenerationRunService,
  type GetPlanGenerationRunRequest,
} from './get-plan-generation-run.service.js'
import { PlanGenerationRunNotFoundError } from './plan-generation.errors.js'
import { PlanGenerationStreamService } from './plan-generation-stream.service.js'

@Controller('plan-generation-runs')
export class PlanGenerationRunController {
  constructor(
    @Inject(GetPlanGenerationRunService)
    private readonly getPlanGenerationRun: GetPlanGenerationRunService,
    @Inject(CURRENT_ACTOR) private readonly currentActor: CurrentActor,
    @Inject(PlanGenerationStreamService) private readonly stream: PlanGenerationStreamService,
  ) {}

  @Get(':generationRunId/events')
  subscribe(
    @Param('generationRunId', new ParseUUIDPipe({ version: '4' })) generationRunId: string,
    @Req() request: AuthRequest,
    @Res() response: ServerResponse,
  ): Promise<void> {
    return this.stream.open(generationRunId, this.currentActor.userId, request, response)
  }

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
