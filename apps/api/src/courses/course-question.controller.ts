import {
  askCourseQuestionInputSchema,
  courseQuestionHistoryResponseSchema,
  courseQuestionSchema,
  type AskCourseQuestionInput,
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
  CourseQuestionConflictError,
  CourseQuestionNotFoundError,
  CourseQuestionService,
} from './course-question.service.js'

@Controller()
export class CourseQuestionController {
  constructor(
    @Inject(CourseQuestionService) private readonly questions: CourseQuestionService,
    @Inject(CURRENT_ACTOR) private readonly currentActor: CurrentActor,
  ) {}

  @Post('tasks/:taskId/course-questions')
  @HttpCode(HttpStatus.ACCEPTED)
  async ask(
    @Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string,
    @Body(new ZodValidationPipe(askCourseQuestionInputSchema)) input: AskCourseQuestionInput,
  ) {
    try {
      return courseQuestionSchema.parse(
        await this.questions.ask(this.currentActor.userId, taskId, input),
      )
    } catch (error: unknown) {
      throw httpError(error)
    }
  }

  @Get('tasks/:taskId/course-questions/active')
  async active(@Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string) {
    try {
      return courseQuestionSchema
        .nullable()
        .parse(await this.questions.active(this.currentActor.userId, taskId))
    } catch (error: unknown) {
      throw httpError(error)
    }
  }

  @Get('tasks/:taskId/course-questions')
  async history(@Param('taskId', new ParseUUIDPipe({ version: '4' })) taskId: string) {
    try {
      return courseQuestionHistoryResponseSchema.parse(
        await this.questions.history(this.currentActor.userId, taskId),
      )
    } catch (error: unknown) {
      throw httpError(error)
    }
  }
}

function httpError(error: unknown) {
  if (error instanceof CourseQuestionNotFoundError)
    return new NotFoundException({
      code: 'RESOURCE_NOT_FOUND',
      message: '课程不存在或尚未准备好。',
    })
  if (error instanceof CourseQuestionConflictError)
    return new ConflictException({ code: 'CONFLICT', message: error.message })
  return error
}
