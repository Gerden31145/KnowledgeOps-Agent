import {
  planGenerationAcceptedResponseSchema,
  startPlanGenerationInputSchema,
  type PlanGenerationAcceptedResponse,
  type StartPlanGenerationInput,
} from '@knowledgeops/contracts'
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  HttpCode,
  HttpStatus,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common'

import { ZodValidationPipe } from '../http/zod-validation.pipe.js'
import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import { AcceptPlanGenerationService } from './accept-plan-generation.service.js'
import {
  ActivePlanGenerationRunError,
  InvalidPlanGenerationRetryError,
  LearningGoalNotFoundError,
  UnknownPlanGenerationModelError,
} from './plan-generation.errors.js'

@Controller('learning-goals')
export class PlanGenerationController {
  constructor(
    private readonly acceptPlanGeneration: AcceptPlanGenerationService,
    @Inject(CURRENT_ACTOR) private readonly currentActor: CurrentActor,
  ) {}

  @Post(':goalId/plan-generation-runs')
  @HttpCode(HttpStatus.ACCEPTED)
  async startPlanGeneration(
    @Param('goalId', new ParseUUIDPipe({ version: '4' })) goalId: string,
    @Body(new ZodValidationPipe(startPlanGenerationInputSchema)) input: StartPlanGenerationInput,
  ): Promise<PlanGenerationAcceptedResponse> {
    try {
      const accepted = await this.acceptPlanGeneration.execute({
        actorUserId: this.currentActor.userId,
        goalId,
        input,
      })

      return planGenerationAcceptedResponseSchema.parse(accepted)
    } catch (error: unknown) {
      if (error instanceof LearningGoalNotFoundError) {
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: error.message })
      }

      if (error instanceof UnknownPlanGenerationModelError) {
        throw new BadRequestException({ code: 'VALIDATION_ERROR', message: error.message })
      }

      if (error instanceof InvalidPlanGenerationRetryError) {
        throw new ConflictException({ code: 'CONFLICT', message: error.message })
      }

      if (error instanceof ActivePlanGenerationRunError) {
        throw new ConflictException({
          code: 'CONFLICT',
          message: error.message,
          generationRunId: error.generationRunId,
        })
      }

      throw error
    }
  }
}
