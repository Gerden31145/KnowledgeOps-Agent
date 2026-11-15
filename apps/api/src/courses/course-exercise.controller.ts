import {
  courseExerciseSubmissionHistoryResponseSchema,
  courseExerciseSubmissionSchema,
  submitCourseExerciseInputSchema,
  type SubmitCourseExerciseInput,
} from '@knowledgeops/contracts'
import {
  Body,
  ConflictException,
  Controller,
  Get,
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
import {
  CourseExerciseConflictError,
  CourseExerciseNotFoundError,
  CourseExerciseService,
} from './course-exercise.service.js'

@Controller()
export class CourseExerciseController {
  constructor(
    @Inject(CourseExerciseService) private readonly exercises: CourseExerciseService,
    @Inject(CURRENT_ACTOR) private readonly currentActor: CurrentActor,
  ) {}

  @Post('tasks/:taskId/exercise-submissions')
  @HttpCode(HttpStatus.ACCEPTED)
  async submit(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Body(new ZodValidationPipe(submitCourseExerciseInputSchema))
    input: SubmitCourseExerciseInput,
  ) {
    try {
      return courseExerciseSubmissionSchema.parse(
        await this.exercises.submit(this.currentActor.userId, taskId, input),
      )
    } catch (error: unknown) {
      if (error instanceof CourseExerciseNotFoundError)
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: '课程练习不存在。' })
      if (error instanceof CourseExerciseConflictError)
        throw new ConflictException({ code: 'CONFLICT', message: error.message })
      throw error
    }
  }

  @Get('tasks/:taskId/exercise-submissions')
  async history(@Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string) {
    try {
      return courseExerciseSubmissionHistoryResponseSchema.parse(
        await this.exercises.history(this.currentActor.userId, taskId),
      )
    } catch (error: unknown) {
      if (error instanceof CourseExerciseNotFoundError)
        throw new NotFoundException({ code: 'RESOURCE_NOT_FOUND', message: '课程练习不存在。' })
      throw error
    }
  }
}
