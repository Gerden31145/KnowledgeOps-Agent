import { Module } from '@nestjs/common'
import { DatabaseService } from '../database/database.service.js'
import { NoteVerificationQueryController } from './note-verification-query.controller.js'
import { NoteVerificationQueryService } from './note-verification-query.service.js'
import { FollowUpAnswerController } from './follow-up-answer.controller.js'
import { FollowUpAnswerService } from './follow-up-answer.service.js'

@Module({
  controllers: [NoteVerificationQueryController, FollowUpAnswerController],
  providers: [
    {
      provide: FollowUpAnswerService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new FollowUpAnswerService(database.client),
    },
    {
      provide: NoteVerificationQueryService,
      inject: [DatabaseService],
      useFactory: (database: DatabaseService) => new NoteVerificationQueryService(database.client),
    },
  ],
})
export class NoteVerificationModule {}
