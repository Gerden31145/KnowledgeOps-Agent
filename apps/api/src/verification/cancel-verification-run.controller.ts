import { Body, Controller, HttpCode, Inject, Param, ParseUUIDPipe, Post } from '@nestjs/common'
import {
  cancelVerificationRunInputSchema,
  type CancelVerificationRunInput,
} from '@knowledgeops/contracts'
import { ZodValidationPipe } from '../http/zod-validation.pipe.js'
import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import { CancelVerificationRunService } from './cancel-verification-run.service.js'

@Controller('agent-runs')
export class CancelVerificationRunController {
  constructor(
    @Inject(CancelVerificationRunService) private readonly runs: CancelVerificationRunService,
    @Inject(CURRENT_ACTOR) private readonly actor: CurrentActor,
  ) {}

  @Post(':runId/cancel')
  @HttpCode(202)
  cancel(
    @Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string,
    @Body(new ZodValidationPipe(cancelVerificationRunInputSchema))
    input: CancelVerificationRunInput,
  ) {
    return this.runs.cancel(this.actor.userId, runId, input)
  }
}
