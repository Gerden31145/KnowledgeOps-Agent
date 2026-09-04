import {
  confirmPlanResponseSchema,
  startTaskInputSchema,
  startTaskResponseSchema,
  type ConfirmPlanResponse,
  type StartTaskInput,
  type StartTaskResponse,
} from '@knowledgeops/contracts'
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Inject,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Post,
} from '@nestjs/common'

import { ZodValidationPipe } from '../http/zod-validation.pipe.js'
import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import {
  AnotherActivePlanError,
  AnotherTaskInProgressError,
  InvalidPlanLifecycleStateError,
  PlanNotFoundError,
  TaskNotFoundError,
  TaskTargetPathConflictError,
  TaskTargetPathRequiredError,
} from './plan-lifecycle.errors.js'
import { PlanLifecycleService } from './plan-lifecycle.service.js'

@Controller()
export class PlanLifecycleController {
  constructor(
    private readonly lifecycle: PlanLifecycleService,
    @Inject(CURRENT_ACTOR) private readonly currentActor: CurrentActor,
  ) {}

  @Post('plans/:planId/confirm')
  async confirmPlan(
    @Param('planId', new ParseUUIDPipe({ version: '4' })) planId: string,
  ): Promise<ConfirmPlanResponse> {
    try {
      const result = await this.lifecycle.confirmPlan(planId, this.currentActor.userId)
      return confirmPlanResponseSchema.parse(result)
    } catch (error: unknown) {
      this.rethrowHttpError(error)
    }
  }

  @Post('tasks/:taskId/start')
  async startTask(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Body(new ZodValidationPipe(startTaskInputSchema)) input: StartTaskInput,
  ): Promise<StartTaskResponse> {
    try {
      const result = await this.lifecycle.startTask(taskId, this.currentActor.userId, input)
      return startTaskResponseSchema.parse(result)
    } catch (error: unknown) {
      this.rethrowHttpError(error)
    }
  }

  private rethrowHttpError(error: unknown): never {
    if (error instanceof PlanNotFoundError || error instanceof TaskNotFoundError) {
      throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: error.message })
    }

    if (error instanceof TaskTargetPathRequiredError) {
      throw new BadRequestException({ code: 'VALIDATION_ERROR', message: error.message })
    }

    if (
      error instanceof AnotherActivePlanError ||
      error instanceof AnotherTaskInProgressError ||
      error instanceof InvalidPlanLifecycleStateError ||
      error instanceof TaskTargetPathConflictError
    ) {
      throw new ConflictException({ code: 'CONFLICT', message: error.message })
    }

    throw error
  }
}
