import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common'
import {
  retryNoteVerificationInputSchema,
  type RetryNoteVerificationInput,
} from '@knowledgeops/contracts'
import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import { ZodValidationPipe } from '../http/zod-validation.pipe.js'
import { RetryNoteVerificationService } from './retry-note-verification.service.js'

@Controller('agent-runs')
export class RetryNoteVerificationController {
  constructor(
    @Inject(RetryNoteVerificationService) private readonly runs: RetryNoteVerificationService,
    @Inject(CURRENT_ACTOR) private readonly actor: CurrentActor,
  ) {}

  @Post(':runId/retry')
  @HttpCode(202)
  retry(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Body(new ZodValidationPipe(retryNoteVerificationInputSchema))
    input: RetryNoteVerificationInput,
  ) {
    return this.runs.retry(this.actor.userId, runId, input)
  }
}
