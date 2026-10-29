import { Controller, Get, Header, Inject, Param, ParseUUIDPipe } from '@nestjs/common'
import { CURRENT_ACTOR, type CurrentActor } from '../identity/current-actor.js'
import { NoteVerificationQueryService } from './note-verification-query.service.js'

@Controller('agent-runs')
export class NoteVerificationQueryController {
  constructor(
    @Inject(NoteVerificationQueryService) private readonly queries: NoteVerificationQueryService,
    @Inject(CURRENT_ACTOR) private readonly actor: CurrentActor,
  ) {}

  @Get(':runId')
  getRun(@Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string) {
    return this.queries.getRun(runId, this.actor.userId)
  }

  @Get(':runId/evidence')
  @Header('Cache-Control', 'private, no-store')
  getEvidence(@Param('runId', new ParseUUIDPipe({ version: '4' })) runId: string) {
    return this.queries.getEvidence(runId, this.actor.userId)
  }
}
