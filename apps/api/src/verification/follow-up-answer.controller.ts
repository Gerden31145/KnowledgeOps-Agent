import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
} from '@nestjs/common'
import {
  followUpAnswerAcceptedResponseSchema,
  submitFollowUpAnswerInputSchema,
  followUpAnswerQuerySchema,
  retryAnswerVerificationInputSchema,
  type RetryAnswerVerificationInput,
  type SubmitFollowUpAnswerInput,
} from '@knowledgeops/contracts'
import { ZodValidationPipe } from '../http/zod-validation.pipe.js'
import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import { FollowUpAnswerService } from './follow-up-answer.service.js'
import { RetryAnswerVerificationService } from './retry-answer-verification.service.js'

@Controller()
export class FollowUpAnswerController {
  constructor(
    @Inject(FollowUpAnswerService) private readonly answers: FollowUpAnswerService,
    @Inject(RetryAnswerVerificationService)
    private readonly retries: RetryAnswerVerificationService,
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
    @Query(new ZodValidationPipe(followUpAnswerQuerySchema)) query: { runId?: string },
  ) {
    return this.answers.get(this.actor.userId, answerSubmissionId, query.runId)
  }

  @Post('answer-submissions/:answerSubmissionId/runs/:runId/retry')
  @HttpCode(202)
  retry(
    @Param('answerSubmissionId', new ParseUUIDPipe({ version: '4' })) answerSubmissionId: string,
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Body(new ZodValidationPipe(retryAnswerVerificationInputSchema))
    input: RetryAnswerVerificationInput,
  ) {
    return this.retries.retry(this.actor.userId, answerSubmissionId, runId, input)
  }
}
