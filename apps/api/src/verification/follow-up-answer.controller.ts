import { Body, Controller, Get, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common'
import {
  followUpAnswerAcceptedResponseSchema,
  submitFollowUpAnswerInputSchema,
  type SubmitFollowUpAnswerInput,
} from '@knowledgeops/contracts'
import { ZodValidationPipe } from '../http/zod-validation.pipe.js'
import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import { FollowUpAnswerService } from './follow-up-answer.service.js'

@Controller()
export class FollowUpAnswerController {
  constructor(
    @Inject(FollowUpAnswerService) private readonly answers: FollowUpAnswerService,
    @Inject(CURRENT_ACTOR) private readonly actor: CurrentActor,
  ) {}

  @Post('follow-up-questions/:questionId/answers')
  @HttpCode(202)
  async submit(
    @Param('questionId', new ParseUUIDPipe({ version: '4' })) questionId: string,
    @Body(new ZodValidationPipe(submitFollowUpAnswerInputSchema)) input: SubmitFollowUpAnswerInput,
  ) {
    return followUpAnswerAcceptedResponseSchema.parse(
      await this.answers.submit(this.actor.userId, questionId, input),
    )
  }

  @Get('answer-submissions/:answerSubmissionId')
  get(
    @Param('answerSubmissionId', new ParseUUIDPipe({ version: '4' })) answerSubmissionId: string,
  ) {
    return this.answers.get(this.actor.userId, answerSubmissionId)
  }
}
