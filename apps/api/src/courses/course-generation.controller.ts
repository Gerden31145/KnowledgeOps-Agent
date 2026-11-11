import {
  courseGenerationAcceptedResponseSchema,
  requestCourseGenerationInputSchema,
  type RequestCourseGenerationInput,
} from '@knowledgeops/contracts'
import {
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
  InvalidPlanLifecycleStateError,
  TaskNotFoundError,
} from '../plans/plan-lifecycle.errors.js'
import { CourseGenerationRepository } from './course-generation.repository.js'

@Controller()
export class CourseGenerationController {
  constructor(
    @Inject(CourseGenerationRepository) private readonly repository: CourseGenerationRepository,
    @Inject(CURRENT_ACTOR) private readonly currentActor: CurrentActor,
  ) {}

  @Post('tasks/:taskId/course-generation-runs')
  async request(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Body(new ZodValidationPipe(requestCourseGenerationInputSchema))
    input: RequestCourseGenerationInput,
  ) {
    try {
      return courseGenerationAcceptedResponseSchema.parse(
        await this.repository.request(taskId, this.currentActor.userId, input.retryOfRunId),
      )
    } catch (error: unknown) {
      if (error instanceof TaskNotFoundError)
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: error.message })
      if (error instanceof InvalidPlanLifecycleStateError)
        throw new ConflictException({ code: 'CONFLICT', message: error.message })
      throw error
    }
  }
}
